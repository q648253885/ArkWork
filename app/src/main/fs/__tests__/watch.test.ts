/* ============================================================
 * v0.31.0 B5 — main/fs/watch.ts 单测（TC-WATCH-001..012）
 *
 * 载体纪律（见 testcases/00-cumulative-matrix.md §3.11）：
 *  - **真实 chokidar + 真实临时目录**，不做 fs mock（监听链路必须端到端）；
 *  - 测试用小窗口 / 小 awaitWriteFinish 提速，**常量本身另由契约用例固化**
 *    （生产配置 = BATCH_WINDOW_MS / WATCH_AWAIT_CONFIG，见 TC-WATCH-007）；
 *  - watch.ts 不 import electron：广播函数由测试注入收集器。
 *
 * 运行（cwd=app）：
 *   node scripts/run-tests.mjs main/fs/__tests__
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BATCH_WINDOW_MS,
  RECENT_BATCHES_LIMIT,
  WATCH_AWAIT_CONFIG,
  getRecentBatches,
  startWatching,
  stopWatching,
  watchStatus,
} from '../watch.js'
import { ignoredByWatch, isIgnoredRelPath } from '../paths.js'
import {
  AGENT_WRITE_TTL_MS,
  clearAgentWrites,
  isAgentWrite,
  markAgentWrite,
} from '../agent-writes.js'
import { SELF_WRITE_TTL_MS, markSelfWrite, writeText } from '../write.js'
import type { FsBatchEvent } from '@shared/types/fs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC_ROOT = resolve(HERE, '../../..') // src/

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/* ------------------------------------------------------------
 * 测试设施
 * ---------------------------------------------------------- */

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'arkwork-watch-'))
  try {
    await fn(dir)
  } finally {
    await stopWatching()
    clearAgentWrites()
    await rm(dir, { recursive: true, force: true })
  }
}

interface Harness {
  dir: string
  batches: FsBatchEvent[]
  initial: FsBatchEvent
  waitForBatch: (
    pred: (e: FsBatchEvent) => boolean,
    timeoutMs?: number,
  ) => Promise<FsBatchEvent>
}

/**
 * 启动被测监听。测试默认小窗口（60ms）+ 快 awaitWriteFinish（50/20），
 * 保证事件在数百毫秒内落批；生产常量另由契约用例固化。
 */
async function makeHarness(
  dir: string,
  opts: {
    windowMs?: number
    awaitWriteFinish?: false | { stabilityThreshold: number; pollInterval: number }
  } = {},
): Promise<Harness> {
  const batches: FsBatchEvent[] = []
  const started = await startWatching({
    root: dir,
    broadcast: (e) => batches.push(e),
    windowMs: opts.windowMs ?? 60,
    awaitWriteFinish: 'awaitWriteFinish' in opts
      ? opts.awaitWriteFinish
      : { stabilityThreshold: 50, pollInterval: 20 },
  })
  const waitForBatch = async (
    pred: (e: FsBatchEvent) => boolean,
    timeoutMs = 4000,
  ): Promise<FsBatchEvent> => {
    const start = Date.now()
    for (;;) {
      const hit = batches.find(pred)
      if (hit) return hit
      if (Date.now() - start > timeoutMs) {
        throw new Error(`waitForBatch timeout; batches=${JSON.stringify(batches)}`)
      }
      await sleep(20)
    }
  }
  return { dir, batches, initial: started.initial, waitForBatch }
}

const entryPaths = (e: FsBatchEvent): string[] =>
  [...e.added, ...e.changed, ...e.removed].map((x) => x.path)

/* ---------- TC-WATCH-007 / TC-WATCH-011（常量契约） ---------- */

test('TC-WATCH-007/011 常量契约：聚合窗口 / awaitWriteFinish / 双登记表 TTL / 历史上限', () => {
  assert.equal(BATCH_WINDOW_MS, 200)
  assert.deepEqual(WATCH_AWAIT_CONFIG, { stabilityThreshold: 250, pollInterval: 100 })
  assert.equal(RECENT_BATCHES_LIMIT, 20)
  assert.equal(AGENT_WRITE_TTL_MS, 5000)
  assert.equal(SELF_WRITE_TTL_MS, 500)
})

/* ---------- TC-WATCH-010（ignore 一处配置两处消费） ---------- */

test('TC-WATCH-010 WATCH_IGNORE 与 chokidar / fs:list-paths 共用同一份配置', async () => {
  for (const rel of [
    'node_modules/x.js',
    '.git/config',
    '.arkwork/tasks.json',
    'dist/bundle.js',
    'build/out.js',
    '.next/cache',
    '.hidden',
    'foo/.DS_Store',
  ]) {
    assert.equal(isIgnoredRelPath(rel), true, `应忽略：${rel}`)
  }
  for (const rel of ['src/a.ts', 'README.md', 'docs/sub/b.md']) {
    assert.equal(isIgnoredRelPath(rel), false, `不应忽略：${rel}`)
  }
  // 源码契约：watch.ts 的 chokidar ignored 谓词 import 自 paths.js（同一实现）
  const src = await readFile(join(SRC_ROOT, 'main/fs/watch.ts'), 'utf-8')
  assert.match(src, /ignoredByWatch/)
  assert.match(src, /from '\.\/paths\.js'/)
  // 行为：根自身不忽略（否则 chokidar 3 整棵监听失效）；根内按规则、根外忽略
  const root = resolve('/tmp/arkwork-watch-ignore-root')
  assert.equal(ignoredByWatch(root, root), false)
  assert.equal(ignoredByWatch(join(root, 'src', 'a.ts'), root), false)
  assert.equal(ignoredByWatch(join(root, 'node_modules', 'x'), root), true)
  assert.equal(ignoredByWatch('/etc/hosts', root), true)
})

/* ---------- TC-WATCH-008（全量首快照） ---------- */

test('TC-WATCH-008 watch-start 返回全量首快照（ignoreInitial 语义显式承载）', async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, 'sub'), { recursive: true })
    await writeFile(join(dir, 'a.txt'), 'a')
    await writeFile(join(dir, 'sub', 'b.ts'), 'b')
    await writeFile(join(dir, '.hidden'), 'h') // 隐藏文件不入快照
    const h = await makeHarness(dir)
    assert.equal(watchStatus(), 'active')
    const paths = h.initial.added.map((e) => e.path).sort()
    assert.deepEqual(paths, [join(dir, 'a.txt'), join(dir, 'sub', 'b.ts')].sort())
    assert.deepEqual(h.initial.changed, [])
    assert.deepEqual(h.initial.removed, [])
    assert.equal(h.initial.root, dir)
    // initial 不进广播。注意：fsevents 在启动后会偶发对既有文件补发一轮
    // add（sweep，内容与首快照重复；渲染层插入幂等，无害）——
    // 因此断言「无幻影变更」而非「零批次」。
    await sleep(250)
    const initialPaths = new Set(h.initial.added.map((e) => e.path))
    for (const b of h.batches) {
      assert.deepEqual(b.changed, [], `启动期不应有 changed：${JSON.stringify(b)}`)
      assert.deepEqual(b.removed, [], `启动期不应有 removed：${JSON.stringify(b)}`)
      for (const entry of b.added) {
        assert.ok(initialPaths.has(entry.path), `启动期幻影新增：${entry.path}`)
      }
    }
  })
})

/* ---------- TC-WATCH-001 / 002 / 006（窗口聚合 + 通道覆盖性） ---------- */

test('TC-WATCH-001/002/006 窗口内多事件合并一批；agent 未登记降级 external 但事件不丢', async () => {
  await withTempDir(async (dir) => {
    const h = await makeHarness(dir)
    const p1 = join(dir, 'one.md')
    const p2 = join(dir, 'two.md')
    const p3 = join(dir, 'three.md')
    await writeFile(p1, '1')
    await writeFile(p2, '2')
    await writeFile(p3, '3')
    const batch = await h.waitForBatch((e) => e.added.length >= 3)
    assert.deepEqual(
      batch.added.map((x) => x.path).sort(),
      [p1, p2, p3].sort(),
    )
    // TC-WATCH-006：未登记 → origin='external'，事件不丢
    for (const entry of batch.added) assert.equal(entry.origin, 'external')
    // 窗口不跨批：下一次变更产生 batchId 严格递增的新批
    await sleep(250)
    await writeFile(join(dir, 'four.md'), '4')
    const b2 = await h.waitForBatch((e) => e.batchId > batch.batchId)
    assert.ok(entryPaths(b2).includes(join(dir, 'four.md')))
  })
})

/* ---------- TC-WATCH-003（来源归因 agent） ---------- */

test('TC-WATCH-003 命中 agent 登记表 → origin = agent（C-5 徽标依据）', async () => {
  await withTempDir(async (dir) => {
    const h = await makeHarness(dir)
    const p = join(dir, 'agent-written.md')
    markAgentWrite(p) // file-writer / file-editor 成功写盘点的等价模拟
    assert.ok(isAgentWrite(p))
    await writeFile(p, 'agent content')
    const batch = await h.waitForBatch((e) => e.added.some((x) => x.path === p))
    assert.equal(batch.added.find((x) => x.path === p)?.origin, 'agent')
  })
})

/* ---------- TC-WATCH-004（自写回环抑制） ---------- */

test('TC-WATCH-004 编辑器保存（writeText 自写登记）→ 批次中不出现该路径', async () => {
  await withTempDir(async (dir) => {
    const h = await makeHarness(dir, { awaitWriteFinish: false })
    const p = join(dir, 'editor-save.md')
    const res = await writeText(
      {
        path: p,
        content: 'v1\n',
        encoding: 'utf-8',
        eol: 'lf',
        finalNewline: true,
        origin: 'user-save',
      },
      { root: dir },
    )
    assert.ok(res.revision)
    // 越过抑制 TTL（500ms）后仍无该路径的任何批次 → 抑制生效
    await sleep(700)
    const hit = h.batches.some((e) =>
      [...e.added, ...e.changed].some((x) => x.path === p),
    )
    assert.equal(hit, false, `不应广播自写事件：${JSON.stringify(h.batches)}`)
  })
})

/* ---------- TC-WATCH-005（双保险：TTL / hash） ---------- */

test('TC-WATCH-005 双保险：TTL 过期后同 hash 不再抑制', async () => {
  await withTempDir(async (dir) => {
    const h = await makeHarness(dir, { awaitWriteFinish: false })
    const p = join(dir, 'ttl.md')
    await writeFile(p, 'v1')
    await h.waitForBatch((e) => e.added.some((x) => x.path === p))
    // 用过去的时间点登记 → flush 时已过期
    markSelfWrite(p, 'crc32:aaaaaaaa:2', Date.now() - 1000)
    await writeFile(p, 'v2')
    const batch = await h.waitForBatch((e) => e.changed.some((x) => x.path === p))
    assert.equal(batch.changed.find((x) => x.path === p)?.origin, 'external')
  })
})

test('TC-WATCH-005 双保险：登记 hash 与磁盘不等则不抑制', async () => {
  await withTempDir(async (dir) => {
    const h = await makeHarness(dir, { awaitWriteFinish: false })
    const p = join(dir, 'mismatch.md')
    await writeFile(p, 'v1')
    await h.waitForBatch((e) => e.added.some((x) => x.path === p))
    markSelfWrite(p, 'crc32:deadbeef:ff') // 故意失配的指纹
    await writeFile(p, 'v2')
    const batch = await h.waitForBatch((e) => e.changed.some((x) => x.path === p))
    assert.ok(batch.changed.some((x) => x.path === p))
  })
})

/* ---------- TC-WATCH-009（E_WATCH_INIT 禁止静默降级） ---------- */

test('TC-WATCH-009 watcher 工厂抛错 → E_WATCH_INIT + watchState=failed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arkwork-watch-fail-'))
  try {
    await assert.rejects(
      startWatching({
        root: dir,
        broadcast: () => {},
        spawnWatcher: () => {
          throw new Error('boom')
        },
      }),
      (err: unknown) => (err as { code?: string }).code === 'E_WATCH_INIT',
    )
    assert.equal(watchStatus(), 'failed')
  } finally {
    await stopWatching()
    await rm(dir, { recursive: true, force: true })
  }
})

/* ---------- removed 条目 + 窗口内「新建即删」净效果 ---------- */

test('removed 条目进入广播；窗口内新建即删净效果为无', async () => {
  await withTempDir(async (dir) => {
    const h = await makeHarness(dir, { awaitWriteFinish: false })
    const p = join(dir, 'gone.md')
    await writeFile(p, 'x')
    await h.waitForBatch((e) => e.added.some((x) => x.path === p))
    await unlink(p)
    const batch = await h.waitForBatch((e) => e.removed.some((x) => x.path === p))
    assert.equal(batch.removed.find((x) => x.path === p)?.origin, 'external')

    // 同窗口内 add → unlink：不出现在任何批次（净效果为无）
    const p2 = join(dir, 'ephemeral.md')
    await writeFile(p2, 'y')
    await unlink(p2)
    await sleep(400)
    const hit = h.batches.some((e) => entryPaths(e).includes(p2))
    assert.equal(hit, false, `窗口内新建即删不应入批：${JSON.stringify(h.batches)}`)
  })
})

/* ---------- TC-WATCH-012（批次历史上限） ---------- */

test('TC-WATCH-012 批次历史保留最近 20 批（不无界增长）', async () => {
  await withTempDir(async (dir) => {
    const h = await makeHarness(dir, { windowMs: 30, awaitWriteFinish: false })
    // 间隔（60ms）> 窗口（30ms）→ 各落不同批；40 次写入留足余量
    // （fsevents 偶发把相邻事件合并进同一批，故断言「> 20 批」而非「= 40 批」）
    for (let i = 0; i < 40; i++) {
      await writeFile(join(dir, `f${i}.txt`), String(i))
      await sleep(60)
    }
    await sleep(250)
    assert.ok(h.batches.length > 20, `应产生超过 20 批：${h.batches.length}`)
    const recent = getRecentBatches()
    assert.equal(recent.length, 20)
    // 保留的是最近的批次（batchId 单调递增）
    assert.ok(recent[recent.length - 1].batchId > recent[0].batchId)
    assert.ok(recent[recent.length - 1].batchId >= h.batches[h.batches.length - 1].batchId)
  })
})

/* ---------- agent-writes 登记表（纯模块密闭断言） ---------- */

test('agent-writes 登记表：命中 / TTL 过期 / 清空', () => {
  clearAgentWrites()
  const p = '/tmp/arkwork-agent-writes-unit/x.md'
  markAgentWrite(p, 1000)
  assert.equal(isAgentWrite(p, 1500), true)
  assert.equal(isAgentWrite(p, 1000 + AGENT_WRITE_TTL_MS + 1), false, 'TTL 过期后不再命中')
  markAgentWrite(p, 1000)
  clearAgentWrites()
  assert.equal(isAgentWrite(p, 1500), false, '清空后不命中')
})
