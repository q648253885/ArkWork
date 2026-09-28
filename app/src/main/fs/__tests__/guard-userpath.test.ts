/* ============================================================
 * v0.36.3 · D115 — 交互区路径边界（TC-PATH-001..006）
 *
 * 口径（用户裁决）：
 *   「只要文件真实存在就能打开，路径越界只约束 LLM 运行时。」
 *  ⇒ 双通道：
 *     · 用户面读取（stat / probe / read-text / read-file / list-dir / reveal）
 *       —— 相对路径以**工作区根**归一化；工作区外**可读**，只标只读原因；
 *     · LLM 工具面（file-editor / file-writer / grep / glob / permissions）
 *       —— 边界**一行未改**（TC-PATH-005 反向把守）；
 *     · 写通道 —— 仍限工作区内（工作区外可看不可存）。
 *
 * 载体纪律：真实临时目录 + 真实 symlink，不做 fs mock。
 * 运行（cwd=app）：node scripts/run-tests.mjs main/fs/__tests__
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertInWorkspace,
  assertWritableTarget,
  probeReadablePath,
  resolveUserPath,
} from '../guard.js'
import { probeText, readText } from '../text.js'
import { stripComments } from '@shared/utils/source-guard'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC_ROOT = resolve(HERE, '../../..') // src/

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'arkwork-userpath-'))
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

/* ---------- TC-PATH-001 ---------- */

test('TC-PATH-001 resolveUserPath：相对路径以工作区根为基准、绝对路径原样（不再走 cwd）', async () => {
  await withTmpDir(async (dir) => {
    const ws = join(dir, 'ws')
    await mkdir(ws, { recursive: true })

    // 相对 → 工作区根（**核心**：旧实现 resolve(p) 会落到 process.cwd()）
    assert.equal(resolveUserPath('src/main/java/com/travelsky/codeagent/agent', ws), join(ws, 'src/main/java/com/travelsky/codeagent/agent'))
    assert.equal(resolveUserPath('a.txt', ws), join(ws, 'a.txt'))
    assert.equal(resolveUserPath('.', ws), ws)
    // `..` 仍被 resolve 消化（不只是拼接）
    assert.equal(resolveUserPath('../x', ws), join(dir, 'x'))

    // 绝对 → 原样归一
    assert.equal(resolveUserPath('/etc/passwd', ws), '/etc/passwd')
    assert.equal(resolveUserPath(join(ws, 'a', 'b'), ws), join(ws, 'a', 'b'))

    // 与 cwd 无关：同一相对路径在不同 root 下给出不同绝对路径
    assert.notEqual(resolveUserPath('a.txt', ws), resolveUserPath('a.txt', dir))
  })
})

/* ---------- TC-PATH-002 ---------- */

test('TC-PATH-002 probeReadablePath：给出「是否在工作区内」且不抛越界错', async () => {
  await withTmpDir(async (dir) => {
    const ws = join(dir, 'ws')
    const outside = join(dir, 'outside')
    await mkdir(join(ws, 'src'), { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'secret.txt'), 'secret\n')

    // 工作区相对路径 → 判定为「在内」（D115 的正面）
    const relIn = await probeReadablePath('src/a.ts', ws)
    assert.equal(relIn.absPath, join(ws, 'src', 'a.ts'))
    assert.equal(relIn.insideWorkspace, true)

    // 绝对且在内
    assert.equal((await probeReadablePath(join(ws, 'src', 'a.ts'), ws)).insideWorkspace, true)

    // 绝对且在外 —— **不抛错**，只如实回答 false（这是与 assertInWorkspace 的本质区别）
    const out = await probeReadablePath(join(outside, 'secret.txt'), ws)
    assert.equal(out.insideWorkspace, false)
    assert.equal(out.absPath, join(outside, 'secret.txt'))

    // symlink 逃逸同样被判在外（realpath 后比对）
    const link = join(ws, 'escape')
    await symlink(outside, link, 'dir')
    assert.equal((await probeReadablePath(join(link, 'secret.txt'), ws)).insideWorkspace, false)
  })
})

/* ---------- TC-PATH-003 ---------- */

test('TC-PATH-003 工作区外文件：只读原因 = outside-workspace，但**照常可读**（内容非 null）', async () => {
  await withTmpDir(async (dir) => {
    const ws = join(dir, 'ws')
    const outside = join(dir, 'outside')
    await mkdir(ws, { recursive: true })
    await mkdir(outside, { recursive: true })
    const target = join(outside, 'readable.txt')
    await writeFile(target, 'hello outside\n')

    const probe = await probeText(target, { insideWorkspace: false })
    assert.equal(probe.exists, true, '工作区外不是 deleted')
    assert.equal(probe.readonlyReason, 'outside-workspace')
    // countLines 走 normalizeToLf().split('\n').length：末尾换行计入一个空尾行（上游既有契约）
    assert.equal(probe.lineCount, 2)

    const read = await readText(target, { insideWorkspace: false })
    assert.equal(read.content, 'hello outside\n', '工作区外必须能读到内容（可预览）')

    // 缺省（undefined）不参与判定 —— 既有调用方零影响
    const legacy = await probeText(target)
    assert.equal(legacy.readonlyReason, null, '不传 insideWorkspace 时行为与旧版一致')
  })
})

/* ---------- TC-PATH-004 ---------- */

test('TC-PATH-004 写通道：相对路径可写（以工作区根解析），工作区外一律 E_PATH_OUTSIDE_WORKSPACE', async () => {
  await withTmpDir(async (dir) => {
    const ws = join(dir, 'ws')
    await mkdir(join(ws, 'src'), { recursive: true })
    await mkdir(join(ws, '.arkwork'), { recursive: true })

    // 相对路径（交互区最常见的形态）—— 保存必须成功
    assert.equal(await assertWritableTarget('src/a.ts', ws), join(ws, 'src', 'a.ts'))
    assert.equal(await assertWritableTarget(join(ws, 'src', 'a.ts'), ws), join(ws, 'src', 'a.ts'))

    // 工作区外（绝对）—— 仍然拒绝
    assert.equal(await codeOf(() => assertWritableTarget('/tmp/outside-arkwork.txt', ws)), 'E_PATH_OUTSIDE_WORKSPACE')
    // 相对逃逸 —— 同样拒绝
    assert.equal(await codeOf(() => assertWritableTarget('../../etc/hosts', ws)), 'E_PATH_OUTSIDE_WORKSPACE')
    // `.arkwork` 保留区不变
    assert.equal(await codeOf(() => assertWritableTarget('src/../../.arkwork/x', ws)), 'E_PATH_OUTSIDE_WORKSPACE')
    assert.equal(await codeOf(() => assertWritableTarget(join(ws, '.arkwork', 'x.json'), ws)), 'E_ARKWORK_RESERVED')
  })
})

/* ---------- TC-PATH-005 ---------- */

test('TC-PATH-005 LLM 工具面边界**未放宽**（源码契约：四个技能仍走 isInsideWorkspace）', async () => {
  const skills = [
    'main/agent/skills/file-editor.ts',
    'main/agent/skills/file-writer.ts',
    'main/agent/skills/grep-search.ts',
    'main/agent/skills/glob-search.ts',
  ]
  const sources = await Promise.all(skills.map((f) => readFile(join(SRC_ROOT, f), 'utf-8')))

  skills.forEach((f, i) => {
    const code = stripComments(sources[i])
    assert.match(code, /isInsideWorkspace/, `${f} 必须仍走 isInsideWorkspace（LLM 工具面边界不可放宽）`)
    assert.match(code, /if\s*\(\s*!\s*isInsideWorkspace\(/, `${f} 必须以 !isInsideWorkspace 作为越界拦截条件`)
  })

  // 用户面归一化点唯一（纪律⑧）：只有 guard.ts 定义 resolveUserPath
  const guardSrc = await readFile(join(SRC_ROOT, 'main/fs/guard.ts'), 'utf-8')
  assert.match(guardSrc, /export\s+function\s+resolveUserPath\b/)
  const ipcSrc = stripComments(await readFile(join(SRC_ROOT, 'main/ipc/fs.ts'), 'utf-8'))
  assert.ok(!/function\s+resolveUserPath\b/.test(ipcSrc), 'ipc/fs.ts 不得自带第二份归一化实现')
  assert.match(ipcSrc, /probeReadablePath/, '用户面读取频道必须经 probeReadablePath')
})

/* ---------- TC-PATH-006 ---------- */

test('TC-PATH-006 assertInWorkspace：相对路径按工作区根解析（D115 回归守卫）', async () => {
  await withTmpDir(async (dir) => {
    const ws = join(dir, 'ws')
    await mkdir(join(ws, 'src'), { recursive: true })

    // 修复前：resolve('src/a.ts') 落到 process.cwd() ⇒ 必判越界（本用例即回归守卫）
    assert.equal(await assertInWorkspace('src/a.ts', ws), join(ws, 'src', 'a.ts'))

    // 绝对越界与相对逃逸仍被拒（边界没有变松）
    assert.equal(await codeOf(() => assertInWorkspace('/etc/passwd', ws)), 'E_PATH_OUTSIDE_WORKSPACE')
    assert.equal(await codeOf(() => assertInWorkspace('../../etc/hosts', ws)), 'E_PATH_OUTSIDE_WORKSPACE')
  })
})