/**
 * v0.46.0 — PERF-2 W8/W9 存储读缓存（mtime 指纹）
 *
 * 依据：docs/versions/v0.46.0/04-system-design.md §二 B（W8/W9）
 * 背景：agent 引擎每轮迭代对 l1.jsonl 有 ≥3 次 list()，此前每次全量读盘 +
 * 逐行 JSON.parse（O(会话长度)×每轮）。修复后：stat 指纹命中返回缓存浅拷贝；
 * 写路径增量/全量刷新缓存；外部改写经指纹失配自动穿透。
 *
 * 手法：真执行（真实临时文件 + 真实 fs）；读盘次数用 fs 监听不可靠，改为
 * 断言「内容语义 + 缓存失效时机」——外部改写后必须读到新值（穿透），
 * 写路径后无需重读即见新值（增量维护）。
 *
 * 运行（cwd=app）：
 *   node scripts/run-tests.mjs db-cache
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonCollection, JsonlCollection } from '../db.js'

interface Row { id: string; v: number }

async function makeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'arkwork-dbcache-'))
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/* ---------------- JsonlCollection ---------------- */

test('TC-STORE46-001 JSONL：连续 list 命中缓存（同引用语义）且浅拷贝防 sort 污染', async () => {
  const dir = await makeDir()
  try {
    const path = join(dir, 'l1.jsonl')
    const col = new JsonlCollection<Row>(path)
    await col.append({ id: 'a', v: 1 })
    const first = await col.list()
    assert.equal(first.length, 1)
    // 浅拷贝：对返回数组原地 sort/push 不得污染缓存
    first.push({ id: 'ghost', v: 99 })
    first.sort(() => -1)
    const second = await col.list()
    assert.equal(second.length, 1, '浅拷贝：外部 push 不进缓存')
    assert.equal(second[0]?.id, 'a')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('TC-STORE46-002 JSONL：append 后无需重读即可见（增量维护）', async () => {
  const dir = await makeDir()
  try {
    const path = join(dir, 'l1.jsonl')
    const col = new JsonlCollection<Row>(path)
    await col.append({ id: 'a', v: 1 })
    assert.deepEqual((await col.list()).map((r) => r.id), ['a'])
    await col.append({ id: 'b', v: 2 })
    const items = await col.list()
    assert.deepEqual(items.map((r) => r.id), ['a', 'b'], '写路径增量刷新缓存')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('TC-STORE46-003 JSONL：外部改写经 mtime 穿透（缓存不得静默旧值）', async () => {
  const dir = await makeDir()
  try {
    const path = join(dir, 'l1.jsonl')
    const col = new JsonlCollection<Row>(path)
    await col.append({ id: 'a', v: 1 })
    assert.equal((await col.list()).length, 1)
    // 外部进程直写（绕过实例）
    await writeFile(path, `${JSON.stringify({ id: 'ext', v: 42 })}\n`, 'utf-8')
    await sleep(5) // 保证 mtime 变化
    const items = await col.list()
    assert.deepEqual(items.map((r) => r.id), ['ext'], '指纹失配 → 穿透重读')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('TC-STORE46-004 JSONL：rewrite/mutate/delete 后缓存与磁盘一致', async () => {
  const dir = await makeDir()
  try {
    const path = join(dir, 'l1.jsonl')
    const col = new JsonlCollection<Row>(path)
    await col.appendMany([{ id: 'a', v: 1 }, { id: 'b', v: 2 }, { id: 'c', v: 3 }])
    assert.equal((await col.list()).length, 3)
    await col.delete('b')
    let items = await col.list()
    assert.deepEqual(items.map((r) => r.id), ['a', 'c'])
    // 磁盘真实内容也要一致（缓存只是加速，真源是文件）
    const raw = await readFile(path, 'utf-8')
    assert.deepEqual(raw.trim().split('\n').map((l) => (JSON.parse(l) as Row).id), ['a', 'c'])
    await col.mutate((rows) => rows.map((r) => (r.id === 'a' ? { ...r, v: 10 } : r)))
    items = await col.list()
    assert.equal(items.find((r) => r.id === 'a')?.v, 10, 'mutate 后缓存可见新值')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('TC-STORE46-005 JSONL：文件不存在返回空（原语义不变）', async () => {
  const dir = await makeDir()
  try {
    const col = new JsonlCollection<Row>(join(dir, 'missing.jsonl'))
    assert.deepEqual(await col.list(), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* ---------------- JsonCollection ---------------- */

test('TC-STORE46-006 JSON 集合：list 缓存 + upsert/delete/clear 刷新 + 外部改写穿透', async () => {
  const dir = await makeDir()
  try {
    const path = join(dir, 'tasks.json')
    const col = new JsonCollection<Row>(path, [])
    await col.upsert({ id: 'a', v: 1 })
    const first = await col.list()
    assert.equal(first.length, 1)
    first.push({ id: 'ghost', v: 0 })
    assert.equal((await col.list()).length, 1, '浅拷贝防污染')
    await col.upsert({ id: 'a', v: 2 })
    assert.equal((await col.list())[0]?.v, 2, 'upsert 后缓存可见新值')
    await col.upsertMany([{ id: 'b', v: 3 }])
    assert.equal((await col.list()).length, 2)
    await col.delete('a')
    assert.deepEqual((await col.list()).map((r) => r.id), ['b'])
    // 外部改写穿透
    await sleep(5)
    await writeFile(path, JSON.stringify([{ id: 'ext', v: 9 }]), 'utf-8')
    assert.deepEqual((await col.list()).map((r) => r.id), ['ext'])
    await col.clear()
    assert.deepEqual(await col.list(), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
