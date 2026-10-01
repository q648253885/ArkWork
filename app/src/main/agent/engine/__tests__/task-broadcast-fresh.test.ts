/* ============================================================
 * ArkWork — 终态广播新鲜度守卫（v0.43.1 · TC-BCAST，对应 D215）
 *
 * 实机根因（DeepSeek Flash v4.1，任务 T-20261001-2r3063）：标题旁路已把
 * LLM 标题「查找网上类似项目」落库并广播（磁盘 tasks.json 的 titleSource=llm
 * 可证），但引擎 15 处 `broadcastTaskStatus({ ...task, status })` 推送的是
 * 开局长存的内存副本（每轮只回同步 planItems、不同步 title）→ 完成瞬间
 * 顶栏 / 侧栏 / TaskAnchor 全部回退「未命名任务」。
 *
 * 不变量：**渲染层收到的任务对象唯一来源 = store**。引擎状态广播必须经
 * `broadcastTaskStatusStored(updateTask 的返回值, 内存副本兜底)`（events.ts
 * 唯一出口；写失败降级并 warn）。源码守卫用剥注释后的形态断言钉死，
 * 注释剥离走唯一真源 stripComments（纪律㉒）。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs task-broadcast-fresh
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 注释剥离器唯一真源（纪律㉒） */
import { stripComments } from '@shared/utils/source-guard'

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')

/** D215 波及的三份引擎文件（15 处站点全部在这三份内；pause/manager 与 runner 本就合规） */
const ENGINE_FILES = ['../loop.ts', '../turn-end.ts', '../abort.ts'] as const
const stripped = ENGINE_FILES.map((rel) => ({ rel, code: stripComments(read(rel)) }))

test('TC-BCAST-001 ★ 负腿：引擎状态广播禁止直传内存副本 `{ ...task, status }`（D215）', () => {
  for (const { rel, code } of stripped) {
    // 自证：看的确实是有广播调用的那份文件，防路径写错得到永绿用例（纪律㉟②）
    assert.ok(code.includes('broadcastTaskStatus'), `自证失败：${rel} 应含 broadcastTaskStatus 调用`)
    const hits = code.split('broadcastTaskStatus({ ...task').length - 1
    assert.equal(hits, 0, `${rel} 仍有 ${hits} 处 broadcastTaskStatus({ ...task … }) 直传内存副本 —— D215 回潮：会把运行期落库的 LLM 标题冲回旧值`)
  }
})

test('TC-BCAST-002 ★ 正腿：状态广播统一走 store 权威对象出口 broadcastTaskStatusStored（D215）', () => {
  let total = 0
  for (const { rel, code } of stripped) {
    const n = code.split('broadcastTaskStatusStored(updatedTask').length - 1
    assert.ok(n > 0, `${rel} 应至少有 1 处经 broadcastTaskStatusStored 统一出口`)
    total += n
  }
  // 15 处站点里 13 处在本守卫的三份文件（loop 12 + turn-end 2 + abort 1 = 15；
  // pause/manager 与 runner 的既有广播本就用 store 返回对象，不在本守卫范围）。
  assert.ok(
    total >= 13,
    `三文件合计应有 ≥13 处统一出口（实测 ${total}）；若为语义等价的「store 新鲜对象」重构而调整形态，请有意改写本契约（纪律㉔）`,
  )
})
