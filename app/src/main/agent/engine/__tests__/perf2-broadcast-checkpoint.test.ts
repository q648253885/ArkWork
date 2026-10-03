/**
 * v0.46.0 — PERF-2 W10/W11：act_end 广播瘦身 + checkpoint 迭代快照节流
 *
 * 依据：docs/versions/v0.46.0/04-system-design.md §二 B（W10/W11）
 *
 * 手法：纯函数真执行（event-payload / checkpoint 节流谓词）+
 * loop.ts / broadcast.ts 源码契约（接线断言，纪律⑭：函数对但没人调 = 死代码）。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs perf2-broadcast
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripComments } from '@shared/utils/source-guard'
import { stripEventResultForBroadcast } from '../event-payload.js'
import {
  shouldSaveIterationCheckpoint,
  CHECKPOINT_EVERY_N_ITERATIONS,
  CHECKPOINT_MIN_INTERVAL_MS,
} from '../../../checkpoint/store.js'

const LOOP_TS = stripComments(
  readFileSync(new URL('../loop.ts', import.meta.url), 'utf-8'),
)

/* ---------------- TC-BCAST46：act_end 广播瘦身 ---------------- */

test('TC-BCAST46-001 act_end 携带 result → 剥除后不含 result、保留 resultSummary', () => {
  const event = {
    type: 'act_end',
    iteration: 3,
    result: { stdout: 'x'.repeat(100_000) },
    resultSummary: '命令成功',
    durationMs: 12,
    ok: true,
  } as unknown as Parameters<typeof stripEventResultForBroadcast>[0]
  const stripped = stripEventResultForBroadcast(event)
  assert.equal('result' in stripped, false, '广播载荷不得携带完整 result')
  assert.equal((stripped as { resultSummary?: string }).resultSummary, '命令成功')
  assert.equal((event as { result?: unknown }).result !== undefined, true, '入参原对象不被修改（纯函数）')
})

test('TC-BCAST46-002 非 act_end / 无 result 事件原样返回（同一引用）', () => {
  const reasonEnd = { type: 'reason_end', iteration: 1 } as unknown as Parameters<typeof stripEventResultForBroadcast>[0]
  assert.equal(stripEventResultForBroadcast(reasonEnd), reasonEnd)
  const actEnd = { type: 'act_end', iteration: 1, resultSummary: 's' } as unknown as Parameters<typeof stripEventResultForBroadcast>[0]
  assert.equal(stripEventResultForBroadcast(actEnd), actEnd, '无 result 字段时不做无谓复制')
})

test('TC-BCAST46-003 接线契约：loop.ts act_end 必须 broadcastWithoutResult；broadcast.ts 落盘用原始 event', () => {
  // 纪律⑭：接线类改动必须断言调用点存在（函数全对但没人调 = 死代码）
  assert.match(LOOP_TS, /type: 'act_end'/)
  assert.match(LOOP_TS, /broadcastWithoutResult: true/, 'act_end 发射点必须挂 broadcastWithoutResult')
  const BROADCAST_TS = stripComments(
    readFileSync(new URL('../broadcast.ts', import.meta.url), 'utf-8'),
  )
  assert.match(BROADCAST_TS, /appendSessionEvent\(taskId, event\)/, 'session.jsonl 落盘必须用原始 event（日志真源不变）')
  assert.match(BROADCAST_TS, /stripEventResultForBroadcast/, '广播载荷必须经纯函数剥离')
})

/* ---------------- TC-CP46：checkpoint 迭代快照节流 ---------------- */

test('TC-CP46-001 节流谓词真值表（每 3 轮或 ≥30s；首轮必落）', () => {
  assert.equal(CHECKPOINT_EVERY_N_ITERATIONS, 3)
  assert.equal(CHECKPOINT_MIN_INTERVAL_MS, 30_000)
  const now = 1_000_000
  assert.equal(shouldSaveIterationCheckpoint(1, 0, now), true, 'lastSavedAt=0 → 首轮必落')
  assert.equal(shouldSaveIterationCheckpoint(2, now, now + 1), false, '第 2 轮且间隔 <30s → 跳过')
  assert.equal(shouldSaveIterationCheckpoint(3, now, now + 1), true, 'iteration % 3 === 0 → 落')
  assert.equal(shouldSaveIterationCheckpoint(5, now, now + 29_999), false, '第 5 轮且差 1ms 满 30s → 跳过')
  assert.equal(shouldSaveIterationCheckpoint(5, now, now + 30_000), true, '间隔 ≥30s → 落')
  assert.equal(shouldSaveIterationCheckpoint(6, now, now + 1), true, '第 6 轮 → 落')
})

test('TC-CP46-002 接线契约：loop.ts 迭代快照必须走节流谓词；pause 快照路径不受影响', () => {
  assert.match(LOOP_TS, /shouldSaveIterationCheckpoint\(iteration, lastCheckpointSaveAt/, '迭代快照必须过节流谓词')
  assert.match(LOOP_TS, /lastCheckpointSaveAt = Date\.now\(\)/, '落盘后必须刷新节流基准')
})
