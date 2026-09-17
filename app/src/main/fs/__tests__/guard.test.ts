/* ============================================================
 * v0.31.0 B2 — main/fs/guard.ts 单测（TC-GUARD-001..007）
 *
 * 载体纪律（见 testcases/00-cumulative-matrix.md §3.7）：
 *  - **真实临时目录 + 真实 symlink**，不做 fs mock（防 symlink 逃逸必须真的走 realpath）
 *  - TC-GUARD-001 是**源码契约**用例：全仓库只允许一份 assertInWorkspace 定义
 *
 * 运行（cwd=app）：
 *   node scripts/run-tests.mjs main/fs/__tests__
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ARKWORK_DIRNAME,
  READONLY_PRECEDENCE,
  assertInWorkspace,
  assertNotInArkwork,
  assertWritableTarget,
  isInArkworkArea,
  isInsideRoot,
  pickReadonlyReason,
  reasonFromErrorCode,
  relativeToRoot,
} from '../guard.js'
import { READONLY_ORDER, describeModeBits, probeText } from '../text.js'
import { FsError } from '@shared/utils/fs-error'
import type { ReadonlyReason } from '@shared/types/fs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC_ROOT = resolve(HERE, '../../..') // src/

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'arkwork-guard-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function codeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn()
    return undefined
  } catch (err) {
    return (err as { code?: string }).code
  }
}

/* ---------- TC-GUARD-001 ---------- */

test('TC-GUARD-001 assertInWorkspace 单一实现（源码契约：全仓库无第二处定义）', async () => {
  const files = ['main/ipc/fs.ts', 'main/fs/guard.ts', 'main/fs/write.ts', 'main/fs/text.ts']
  const sources = await Promise.all(files.map((f) => readFile(join(SRC_ROOT, f), 'utf-8')))

  const declPattern = /(?:export\s+)?(?:async\s+)?function\s+assertInWorkspace\b/
  const hits = files.filter((_, i) => declPattern.test(sources[i]))
  assert.deepEqual(hits, ['main/fs/guard.ts'], 'assertInWorkspace 只允许在 fs/guard.ts 定义一次')

  // ipc/fs.ts 必须是「导入 + 调用」，不得再自带局部实现
  const ipcSrc = sources[0]
  assert.match(ipcSrc, /import\s*\{[^}]*assertInWorkspace[^}]*\}\s*from\s*'\.\.\/fs\/guard\.js'/)
  assert.ok(!/startsWith\(ws \+ sep\)/.test(ipcSrc), 'ipc/fs.ts 不得再手写 startsWith 边界判定')

  // 且必须是 await 调用（提升后为 async：含 realpath 的 symlink 检查）
  assert.match(ipcSrc, /await assertInWorkspace\(/)
})

/* ---------- TC-GUARD-002 ---------- */

test('TC-GUARD-002 工作区外路径 → E_PATH_OUTSIDE_WORKSPACE', async () => {
  await withTmpDir(async (dir) => {
    await mkdir(join(dir, 'ws'), { recursive: true })

    assert.equal(await codeOf(() => assertInWorkspace('/etc/passwd', dir)), 'E_PATH_OUTSIDE_WORKSPACE')
    // `../` 逃逸（resolve 已消化）
    assert.equal(
      await codeOf(() => assertInWorkspace(join(dir, '..', '..', 'etc', 'hosts'), dir)),
      'E_PATH_OUTSIDE_WORKSPACE',
    )
    // 前缀相同的兄弟目录不得被误判为「在内」（startsWith 的经典坑）
    assert.equal(
      await codeOf(() => assertInWorkspace(`${dir}-sibling/x`, dir)),
      'E_PATH_OUTSIDE_WORKSPACE',
    )
    // 界内（含 root 自身）应放行
    assert.equal(await assertInWorkspace(join(dir, 'a.txt'), dir), join(dir, 'a.txt'))
    assert.equal(await assertInWorkspace(dir, dir), dir)

    // 写类入口同样拦到
    assert.equal(await codeOf(() => assertWritableTarget('/tmp/outside.txt', dir)), 'E_PATH_OUTSIDE_WORKSPACE')

    // 纯函数层同步可断言
    assert.equal(isInsideRoot(dir, join(dir, 'x')), true)
    assert.equal(isInsideRoot(dir, dir), true)
    assert.equal(isInsideRoot(dir, `${dir}-x`), false)
    assert.equal(relativeToRoot(dir, join(dir, 'a', 'b')), join('a', 'b'))
    assert.equal(relativeToRoot(dir, '/etc'), null)
  })
})

/* ---------- TC-GUARD-003 ---------- */

test('TC-GUARD-003 symlink 逃逸被拒（realpath 后再比对）', async () => {
  await withTmpDir(async (dir) => {
    const ws = join(dir, 'ws')
    const outside = join(dir, 'outside')
    await mkdir(ws, { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'secret.txt'), 'secret\n')

    // ws/escape → outside（目录 symlink）
    const link = join(ws, 'escape')
    await symlink(outside, link, 'dir')

    // 字面路径在 ws 内 → 必须靠 realpath 拦截
    assert.equal(await codeOf(() => assertInWorkspace(join(link, 'secret.txt'), ws)), 'E_PATH_OUTSIDE_WORKSPACE')
    assert.equal(await codeOf(() => assertWritableTarget(join(link, 'new.txt'), ws)), 'E_PATH_OUTSIDE_WORKSPACE')

    // 目标文件尚不存在（写新文件场景）：上溯到最近存在的祖先（link）仍能拦截
    assert.equal(
      await codeOf(() => assertInWorkspace(join(link, 'nested', 'deep', 'new.txt'), ws)),
      'E_PATH_OUTSIDE_WORKSPACE',
    )

    // 正向对照：界内 symlink（指向界内目录）不得误伤
    const insideDir = join(ws, 'real')
    await mkdir(insideDir, { recursive: true })
    const insideLink = join(ws, 'alias')
    await symlink(insideDir, insideLink, 'dir')
    assert.equal(
      await assertInWorkspace(join(insideLink, 'ok.txt'), ws),
      join(insideLink, 'ok.txt'),
    )

    // 界外文件本身（不经 link）也拦
    assert.equal(await codeOf(() => assertInWorkspace(join(outside, 'secret.txt'), ws)), 'E_PATH_OUTSIDE_WORKSPACE')
  })
})

/* ---------- TC-GUARD-004 ---------- */

test('TC-GUARD-004 写入 .arkwork 内容区被拒（E_ARKWORK_RESERVED）', async () => {
  await withTmpDir(async (dir) => {
    await mkdir(join(dir, ARKWORK_DIRNAME, 'tasks'), { recursive: true })
    const target = join(dir, ARKWORK_DIRNAME, 'tasks', 'x.json')

    assert.equal(await codeOf(() => assertWritableTarget(target, dir)), 'E_ARKWORK_RESERVED')
    assert.equal(await codeOf(async () => assertNotInArkwork(target, dir)), 'E_ARKWORK_RESERVED')

    // 纯函数层
    assert.equal(isInArkworkArea(dir, target), true)
    assert.equal(isInArkworkArea(dir, join(dir, 'src', 'a.ts')), false)
    // 形似但不同名（.arkwork2）不得误伤
    assert.equal(isInArkworkArea(dir, join(dir, '.arkwork2', 'a')), false)
    // 越界路径不参与保留区判定（越界由 assertInWorkspace 管）
    assert.equal(isInArkworkArea(dir, '/etc/.arkwork/x'), false)

    // 正向对照：界内普通文件放行
    assert.equal(await assertWritableTarget(join(dir, 'src', 'a.ts'), dir), join(dir, 'src', 'a.ts'))
  })
})

/* ---------- TC-GUARD-005 ---------- */

test('TC-GUARD-005 只读原因判定顺序：先硬后软、先永久后临时', () => {
  const expected: ReadonlyReason[] = [
    'deleted',
    'outside-workspace',
    'binary',
    'too-large',
    'permission',
    'agent-writing',
    'non-utf8',
  ]
  assert.deepEqual([...READONLY_PRECEDENCE], expected)
  // 两处定义（guard 的常量 + text 的内联副本）必须同源
  assert.deepEqual([...READONLY_ORDER], expected, 'text.ts 的 READONLY_ORDER 必须与 guard 保持一致')

  assert.equal(pickReadonlyReason(['non-utf8', 'binary', 'deleted']), 'deleted')
  assert.equal(pickReadonlyReason(['non-utf8', 'too-large']), 'too-large')
  assert.equal(pickReadonlyReason(['agent-writing', 'permission', 'non-utf8']), 'permission')
  assert.equal(pickReadonlyReason(['non-utf8', 'agent-writing']), 'agent-writing')
  assert.equal(pickReadonlyReason(['binary', 'outside-workspace']), 'outside-workspace')
  assert.equal(pickReadonlyReason(['non-utf8', null, undefined]), 'non-utf8')
  assert.equal(pickReadonlyReason([]), null, '无候选 = 可编辑')
  assert.equal(pickReadonlyReason([null, undefined]), null)

  // 错误码 → 只读原因映射（§5.2 前端表现）
  assert.equal(reasonFromErrorCode('E_PATH_OUTSIDE_WORKSPACE'), 'outside-workspace')
  assert.equal(reasonFromErrorCode('E_NOT_FOUND'), 'deleted')
  assert.equal(reasonFromErrorCode('E_CONFLICT'), null)
})

/* ---------- TC-GUARD-006 ---------- */

test('TC-GUARD-006 缺权限位 → permission 且 detail 含缺失的具体权限位', async () => {
  assert.match(describeModeBits(0o444), /mode 0444/)
  assert.match(describeModeBits(0o444), /owner\/group\/other 均无写位/)
  assert.match(describeModeBits(0o644), /无写位: group\/other/)
  assert.match(describeModeBits(0o644).slice(0, 10), /mode 0644/)

  await withTmpDir(async (dir) => {
    const path = join(dir, 'ro.txt')
    await writeFile(path, 'x\n')
    const { chmod } = await import('node:fs/promises')
    await chmod(path, 0o444)
    const probe = await probeText(path)
    await chmod(path, 0o644)
    // permission 优先于 non-utf8：权限问题用户可解决，编码问题需要转码流程
    assert.equal(probe.readonlyReason, 'permission')
    assert.match(String(probe.readonlyDetail), /mode 0444/)
  })
})

/* ---------- TC-GUARD-007 ---------- */

test('TC-GUARD-007 文件不存在 → deleted + 「另存恢复」出口', async () => {
  await withTmpDir(async (dir) => {
    const probe = await probeText(join(dir, 'gone.txt'))
    assert.equal(probe.exists, false)
    assert.equal(probe.readonlyReason, 'deleted')
    // 「另存恢复」出口 = 可拿到 path 与空白哈希基线（渲染层据此走 force 覆盖分支）
    assert.equal(probe.path, join(dir, 'gone.txt'))
    assert.equal(probe.fastHash, 'crc32:00000000:0')

    // 错误类型契约：guard 抛 FsError（带 code），不是裸 Error
    try {
      await assertInWorkspace('/etc/passwd', dir)
      assert.fail('应抛出 FsError')
    } catch (err) {
      assert.ok(err instanceof FsError)
      assert.equal((err as FsError).code, 'E_PATH_OUTSIDE_WORKSPACE')
    }
  })
})
