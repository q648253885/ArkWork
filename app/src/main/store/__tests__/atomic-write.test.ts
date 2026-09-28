/**
 * v0.36.4 — D119 原子写加固（重试 + 直写兜底）
 *
 * 依据：docs/versions/v0.36.0/16-v0364-windows-compat-design.md §二 D119
 * 用例：TC-ATOMIC-001…005
 *
 * 背景（Windows 10 用户实测）：writeJson 原子写 = writeFile(tmp) → rename(tmp, dest)，
 * Windows 上 rename 目标被杀毒/索引器/同步盘短暂持有时抛 EPERM，零重试零降级 →
 * 「一直报图落盘失败（内存状态保留）」。修复后：退避重试 → unlink+rename → 直写兜底。
 *
 * 手法：**依赖注入**（atomicWriteFile 的 deps 参数）模拟 rename 撞锁序列，
 * 落盘行为用真实临时文件验证；不做 fs mock。
 *
 * 运行（cwd=app）：
 *   npx tsx --experimental-loader ./src/test/electron-mock-loader.mjs \
 *     --test src/main/store/__tests__/atomic-write.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as fs from 'node:fs/promises'
import { atomicWriteFile, type AtomicWriteDeps } from '../db.js'

/** 每用例独立临时目录 */
async function makeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'arkwork-atomic-'))
}

function lockError(): NodeJS.ErrnoException {
  const e = new Error('EPERM: operation not permitted, rename') as NodeJS.ErrnoException
  e.code = 'EPERM'
  return e
}

/** 前 failCount 次 rename 抛 EPERM，之后放行真实 rename */
function flakyRename(failCount: number): AtomicWriteDeps['rename'] {
  let calls = 0
  return async (from, to) => {
    calls += 1
    if (calls <= failCount) throw lockError()
    return fs.rename(from, to)
  }
}

const realDeps = (): AtomicWriteDeps => ({ rename: fs.rename, writeFile: fs.writeFile, unlink: fs.unlink })

/* ============================================================
 * TC-ATOMIC-001 rename 前两次 EPERM → 重试后成功（瞬时锁消化）
 * ============================================================ */
test('TC-ATOMIC-001 rename 瞬时 EPERM → 退避重试后成功，内容完整且无 .tmp 残留', async () => {
  const dir = await makeDir()
  try {
    const path = join(dir, 'data.json')
    // ATOMIC_RETRIES 共 4 次，前 2 次失败应被消化
    await atomicWriteFile(path, '{"v":1}', { ...realDeps(), rename: flakyRename(2) })
    assert.equal(await readFile(path, 'utf-8'), '{"v":1}')
    const files = await readdir(dir)
    assert.ok(!files.some((f) => f.endsWith('.tmp')), '成功后不得残留 .tmp 文件')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* ============================================================
 * TC-ATOMIC-002 rename 永久 EPERM → 直写兜底落盘（数据到手 > 教条原子性）
 * ============================================================ */
test('TC-ATOMIC-002 rename 永久 EPERM → 直写兜底写入目标，数据不丢', async () => {
  const dir = await makeDir()
  try {
    const path = join(dir, 'data.json')
    await atomicWriteFile(path, '{"v":2}', { ...realDeps(), rename: flakyRename(999) })
    // 直写兜底：目标文件必须有内容（旧实现这里直接抛错 → 数据只在内存）
    assert.equal(await readFile(path, 'utf-8'), '{"v":2}')
    const files = await readdir(dir)
    assert.ok(!files.some((f) => f.endsWith('.tmp')), '兜底后 .tmp 应被清理')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* ============================================================
 * TC-ATOMIC-003 覆盖写场景：旧文件存在 + rename 永久 EPERM → 直写覆盖为新内容
 * ============================================================ */
test('TC-ATOMIC-003 已有旧文件 + 永久 EPERM → 直写兜底覆盖为新内容', async () => {
  const dir = await makeDir()
  try {
    const path = join(dir, 'data.json')
    await fs.writeFile(path, '{"old":true}', 'utf-8')
    await atomicWriteFile(path, '{"new":true}', { ...realDeps(), rename: flakyRename(999) })
    assert.equal(await readFile(path, 'utf-8'), '{"new":true}')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* ============================================================
 * TC-ATOMIC-004 非锁类错误 → 立即抛出（不做重试表演，原语义不变）
 * ============================================================ */
test('TC-ATOMIC-004 非锁类 rename 错误（如 ENOSPC）→ 立即抛出，不重试不直写', async () => {
  const dir = await makeDir()
  try {
    const path = join(dir, 'data.json')
    const enospc = new Error('ENOSPC: no space left on device') as NodeJS.ErrnoException
    enospc.code = 'ENOSPC'
    let renameCalls = 0
    const deps: AtomicWriteDeps = {
      ...realDeps(),
      rename: async () => {
        renameCalls += 1
        throw enospc
      },
    }
    await assert.rejects(atomicWriteFile(path, 'x', deps), /ENOSPC/)
    assert.equal(renameCalls, 1, '非锁类错误必须只调一次 rename')
    assert.equal(await readFile(path, 'utf-8').then(() => true).catch(() => false), false, '目标文件不得被直写兜底污染')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* ============================================================
 * TC-ATOMIC-005 真实 fs 冒烟：无注入时正常写读 + 目录自动创建
 * ============================================================ */
test('TC-ATOMIC-005 真实 fs：嵌套目录自动创建，写入可读回', async () => {
  const dir = await makeDir()
  try {
    const path = join(dir, 'a', 'b', 'c.json')
    await atomicWriteFile(path, 'ok')
    assert.equal(await readFile(path, 'utf-8'), 'ok')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* ============================================================
 * TC-ATOMIC-006 收敛守卫：store 目录下 db.ts 之外不得再有 tmp+rename 拷贝
 * （纪律 15：收敛若不带守卫等于没收敛）
 * ============================================================ */
test('TC-ATOMIC-006 store 目录内 tmp+rename 收敛到 db.atomicWriteFile 单点', async () => {
  const { readFile: rf, readdir: rd } = await import('node:fs/promises')
  const { dirname: dn } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const storeDir = dn(fileURLToPath(new URL('../db.js', import.meta.url)))
  const names = (await rd(storeDir)).filter((f) => f.endsWith('.ts') && f !== 'db.ts')
  for (const name of names) {
    const src = await rf(join(storeDir, name), 'utf-8')
    assert.ok(!/rename\(/.test(src), `${name} 出现 rename( —— 原子写必须走 db.atomicWriteFile 单点（D119 守卫）`)
    assert.ok(!/\.tmp`/.test(src), `${name} 出现 .tmp 模板 —— 禁止新增 tmp+rename 拷贝（D119 守卫）`)
  }
})
