/**
 * v0.46.0 — PERF-2 渲染层优化守卫（W1/W4/W5/W6/W7/W12/W13）
 *
 * 依据：docs/versions/v0.46.0/04-system-design.md §二 A/B
 * 形态：源码契约（stripComments 唯一真源剥注释，纪律㉒）——
 * memo / 动态导入 / 节流 / 签名便宜化都是「结构性」改动，
 * 语义面已由 project-turn-cache / db-cache 真执行覆盖，此处钉「不被回退」。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs perf2-renderer-guards
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripComments } from '@shared/utils/source-guard'

const read = (rel: string, base: string) =>
  stripComments(readFileSync(new URL(rel, base), 'utf-8'))

const BASE = import.meta.url
const MARKDOWN = read('../../renderer/components/Markdown.tsx', BASE)
const TURNLIST = read('../../renderer/components/flow/TurnList.tsx', BASE)
const TURNVIEW = read('../../renderer/components/flow/TurnView.tsx', BASE)
const BLOCKRENDERER = read('../../renderer/components/flow/BlockRenderer.tsx', BASE)
const LOGSVIEW = read('../../renderer/components/right/LogsView.tsx', BASE)
const USEGRAPH = read('../../renderer/components/graph/useGraph.ts', BASE)
const L1 = read('../memory/l1-working.ts', BASE)
const PROJECT = read('../../renderer/flow/project.ts', BASE)
const DERIVE = read('../../renderer/store/derive-conversation.ts', BASE)
const TASKS = read('../store/tasks.ts', BASE)
const EVENTS = read('../agent/events.ts', BASE)
const SESSION_LOG = read('../agent/session-log.ts', BASE)
const ABORT = read('../agent/engine/abort.ts', BASE)

test('TC-MEMO46-001 Markdown / TurnView / BlockRenderer / LogEntryRow 必须 memo', () => {
  assert.match(MARKDOWN, /export const Markdown = memo\(function Markdown/, '流式期间已落定正文块不再每 token re-parse 的前提')
  assert.match(TURNVIEW, /export const TurnView = memo\(function TurnView/)
  assert.match(BLOCKRENDERER, /export const BlockRenderer = memo\(function BlockRenderer/)
  assert.match(LOGSVIEW, /const LogEntryRow = memo\(function LogEntryRow/)
})

test('TC-EC46-001 echarts 不得静态导入（动态导入按需加载，主 chunk 瘦身）', () => {
  assert.match(MARKDOWN, /import\('echarts'\)/, '必须走 dynamic import')
  assert.doesNotMatch(MARKDOWN, /import \* as echarts from 'echarts'/, '静态全量导入已退役')
  assert.match(MARKDOWN, /loadEcharts/, '须经 loadEcharts 单例化（重复挂块不重复加载）')
})

test('TC-GRAPH46-001 useGraph 重载必须 500ms trailing 合并', () => {
  assert.match(USEGRAPH, /setTimeout\(\(\) => \{\s*timer = null\s*void load\(true\)\s*\}, 500\)/)
  assert.match(USEGRAPH, /clearTimeout\(timer\)/, '订阅清理必须同时清掉挂起的 timer（防卸载后重拉）')
})

test('TC-SIG46-001 contentSignature 必须是 O(1) 签名（不得再全量拼接正文）', () => {
  assert.match(TURNLIST, /items\.length\}:\$\{last\?\.id \?\? ''\}/)
  assert.doesNotMatch(TURNLIST, /resultSummary \?\? ''\}:\$\{s\.summary/, '巨型字符串拼接已退役')
})

test('TC-MEMCHG46-001 appendL1 走 leading 节流；用户操作路径保持即时', () => {
  assert.match(L1, /broadcastMemoryChangedThrottled\(input\.taskId\)/, 'append 高频路径节流')
  assert.match(L1, /MEMORY_CHANGED_THROTTLE_MS = 300/)
  const nowCalls = (L1.match(/broadcastMemoryChangedNow\(taskId\)/g) ?? []).length
  assert.ok(nowCalls >= 5, `用户操作路径（toggle/edit/archive/remove/clear 等）保持即时（实测 ${nowCalls} 处）`)
})

test('TC-PROJ46-G 项目级缓存的防串值契约（源码形状）', () => {
  assert.match(PROJECT, /turnCache\.set\(t\.id, \{ deps, turn \}\)/)
  assert.match(PROJECT, /cachedTurn\.deps\.every/, 'deps 逐引用比较（===）')
  assert.match(DERIVE, /cached\.steps\.every\(\(s, i\) => s === steps\[i\]\)/, 'derive 短路逐元素引用比较（中间替换必失配）')
})

test('TC-EVICT46-001 deleteTask 必须驱逐 per-task 运行期缓存', () => {
  assert.match(TASKS, /evictTaskEventCaches\(id\)/)
  assert.match(TASKS, /evictSessionLogCaches\(id\)/)
  assert.match(TASKS, /clearCheckpoints\(id\)/)
  assert.match(EVENTS, /export function evictTaskEventCaches/)
  assert.match(SESSION_LOG, /export function evictSessionLogCaches/)
})

test('TC-ABORT46-001 中断路径必须清理工具进度聚合（pause/异常早退不再驻留）', () => {
  assert.match(ABORT, /clearToolProgress\(task\.id\)/, 'handleAbort 入口清理（无 groupId = 全量）')
})
