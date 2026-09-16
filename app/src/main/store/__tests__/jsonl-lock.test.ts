/**
 * v0.30.2 详测 — L1 JSONL 写互斥 + 原子重写（问题①）
 *
 * 依据：docs/versions/v0.30.2/04-system-design.md §一 + testcases/00-cumulative-matrix.md §3.1
 * 用例：TC-L1LOCK-001…007
 *
 * 背景（用户实测）：已有任务中输入新任务时，输入内容被改成上一次输入的内容。
 * 根因：`JsonlCollection` 的 append（flag:'a'）与 rewrite/mutate（整文件重写，压缩归档
 * 走它）并发交错时，rewrite 的「list → 写」窗口吞掉已完成的 append —— 新 user_message
 * 从 l1.jsonl 消失，渲染端读到的还是旧消息。
 *
 * 修复：写互斥链（runExclusive）+ 原子重写（tmp + rename）+ `mutate` 锁内读-改-写原语
 * （l1-working 8 处「锁外 list → rewrite」全部迁移到 mutate）。
 *
 * 手法：**真实临时文件**（fs.mkdtemp 隔离），非 mock —— 并发时序用真实 fs 事件循环驱动。
 *
 * 运行（cwd=app）：
 *   npx tsx --experimental-loader ./src/test/electron-mock-loader.mjs \
 *     --test src/main/store/__tests__/jsonl-lock.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { JsonlCollection } from '../db.js'

interface Item {
  id: string
  v: string
}

/** 每个用例独立的临时目录 + collection（真实文件，不 mock） */
async function makeCol(): Promise<{
  col: JsonlCollection<Item>
  dir: string
  path: string
}> {
  const dir = await mkdtemp(join(tmpdir(), 'arkwork-jsonl-lock-'))
  const path = join(dir, 'l1.jsonl')
  return { col: new JsonlCollection<Item>(path), dir, path }
}

const items = (prefix: string, n: number): Item[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, v: prefix }))

/* ============================================================
 * TC-L1LOCK-001 rewrite/mutate 长事务期间并发 append ×20 → 全部存活
 * （丢写根因回归 · 用户实测症状）
 * ============================================================ */

test('TC-L1LOCK-001 mutate 长事务期间并发 append×20 → 全部 append 在最终文件中存活', async () => {
  const { col, dir } = await makeCol()
  try {
    const seed = items('seed-', 5)
    await col.appendMany(seed)

    // 长事务：mutate 内部 sleep 模拟压缩归档的读-算-写耗时窗口
    const txn = col.mutate(async (cur) => cur.map((m) => ({ ...m, v: `${m.v}!` })))
    // 长事务期间并发 append ×20（修复前：可能被锁外的旧快照 rewrite 覆盖丢失）
    const appends = items('app-', 20).map((it) => col.append(it))
    await Promise.all([txn, ...appends])

    const final = await col.list()
    const ids = new Set(final.map((m) => m.id))
    for (const it of items('app-', 20)) {
      assert.ok(ids.has(it.id), `append 条目 ${it.id} 被吞（丢写根因未修复）`)
    }
    assert.equal(final.length, 25, '最终条目数 = seed 5 + append 20')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* ============================================================
 * TC-L1LOCK-002 append 先落地再 mutate（保序映射）→ append 仍在
 * （锁外 list 窗口关闭的双向证明）
 * ============================================================ */

test('TC-L1LOCK-002 append 完成后再 mutate（保序映射）→ 快照含该 append，不被覆盖', async () => {
  const { col, dir } = await makeCol()
  try {
    await col.appendMany(items('base-', 3))
    await col.append({ id: 'late-msg', v: 'user' }) // 用户新消息先落盘
    // 压缩归档（archiveMany 语义：保序映射，仅改命中的项）后，晚到的消息必须保留
    await col.mutate((cur) => cur.map((m) => (m.id === 'base-0' ? { ...m, v: 'archived' } : m)))
    const final = await col.list()
    assert.ok(final.some((m) => m.id === 'late-msg'), '先落地的 append 被 mutate 吞掉（锁外 list 窗口未关闭）')
    assert.equal(final.length, 4)
    assert.equal(final.find((m) => m.id === 'base-0')?.v, 'archived', 'mutate 的计算效果丢失')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* ============================================================
 * TC-L1LOCK-003 rewrite 完成后 list() 与写入数组逐条一致
 * ============================================================ */

test('TC-L1LOCK-003 rewrite 后 list() 与写入内容逐条一致（完整性）', async () => {
  const { col, dir } = await makeCol()
  try {
    await col.appendMany(items('old-', 8))
    const block = items('new-', 3)
    await col.rewrite(block)
    const final = await col.list()
    assert.deepEqual(
      final.map((m) => m.id),
      block.map((m) => m.id),
      'rewrite 后文件内容应与写入数组逐条一致',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* ============================================================
 * TC-L1LOCK-004 rewrite 后目录无 .tmp 残留（原子 rename 生效）
 * ============================================================ */

test('TC-L1LOCK-004 rewrite/delete/mutate 后目录无 .tmp 残留（原子 rename）', async () => {
  const { col, dir } = await makeCol()
  try {
    await col.appendMany(items('a-', 4))
    await col.rewrite(items('b-', 2))
    await col.mutate((cur) => cur.map((m) => m))
    await col.delete('b-0')
    const files = await readdir(dir)
    assert.equal(
      files.filter((f) => f.endsWith('.tmp')).length,
      0,
      `不应有 .tmp 残留（并发读者可能读到半成品）：${files.join(', ')}`,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* ============================================================
 * TC-L1LOCK-005 delete 移除目标项且其余项保序完整
 * ============================================================ */

test('TC-L1LOCK-005 delete 移除目标项且其余项保序完整', async () => {
  const { col, dir } = await makeCol()
  try {
    const seed = items('x-', 6)
    await col.appendMany(seed)
    await col.delete('x-2')
    await col.delete('x-4')
    const final = await col.list()
    assert.deepEqual(
      final.map((m) => m.id),
      ['x-0', 'x-1', 'x-3', 'x-5'],
      'delete 后其余项应保序完整',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* ============================================================
 * TC-L1LOCK-006 appendMany 块写入在互斥链上与 mutate 交错不丢（P1 边界）
 * ============================================================ */

test('TC-L1LOCK-006 appendMany 与 mutate 随机交错 → 块内条目全部存活', async () => {
  const { col, dir } = await makeCol()
  try {
    await col.appendMany(items('init-', 2))
    // 交错发射：mutate 与 appendMany 各 3 轮
    const ops: Promise<void>[] = []
    for (let i = 0; i < 3; i++) {
      ops.push(col.mutate(async (cur) => [...cur, { id: `m-${i}`, v: 'm' }]))
      ops.push(sleep(i * 3).then(() => col.appendMany(items(`blk${i}-`, 2))))
    }
    await Promise.all(ops)
    const final = await col.list()
    const ids = new Set(final.map((m) => m.id))
    for (let i = 0; i < 3; i++) {
      assert.ok(ids.has(`m-${i}`), `mutate 追加项 m-${i} 丢失`)
      for (const it of items(`blk${i}-`, 2)) {
        assert.ok(ids.has(it.id), `appendMany 块内条目 ${it.id} 丢失`)
      }
    }
    assert.equal(final.length, 2 + 3 + 6, '最终条目数守恒（init 2 + mutate 3 + blk 6）')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* ============================================================
 * TC-L1LOCK-007 并发压力：append×50 与 mutate×10 随机交错 → 条目数守恒
 * （压力回归）
 * ============================================================ */

test('TC-L1LOCK-007 append×50 与 mutate×10 随机交错 → 最终 60 条无丢失无重复', async () => {
  const { col, dir } = await makeCol()
  try {
    const ops: Promise<void>[] = []
    // 50 个 append（带随机微延迟制造真实交错）
    for (let i = 0; i < 50; i++) {
      const it = { id: `p-${i}`, v: 'p' }
      ops.push(sleep((i % 7) * 2).then(() => col.append(it)))
    }
    // 10 个 mutate（每个追加 1 条标记项，模拟压缩/归档期间的登记写）
    for (let j = 0; j < 10; j++) {
      ops.push(
        sleep((j % 5) * 3).then(() =>
          col.mutate(async (cur) => {
            await sleep(1) // 事务内有 await，扩大交错窗口
            return [...cur, { id: `t-${j}`, v: 't' }]
          }),
        ),
      )
    }
    await Promise.all(ops)
    const final = await col.list()
    assert.equal(final.length, 60, `最终条目数应为 60（append 50 + mutate 10），实际 ${final.length}`)
    const ids = final.map((m) => m.id)
    assert.equal(new Set(ids).size, ids.length, '不应有重复条目（交错写入被撕裂）')
    for (let i = 0; i < 50; i++) assert.ok(ids.includes(`p-${i}`), `p-${i} 丢失`)
    for (let j = 0; j < 10; j++) assert.ok(ids.includes(`t-${j}`), `t-${j} 丢失`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
