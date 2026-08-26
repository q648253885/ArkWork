/* ============================================================
 * v0.28.1 — Loop 流程「提前停止」全面排查（audit 契约测试）
 *
 * 排查背景：用户反馈任务执行中突然结束。除已修复的 V1（无工具调用回合
 * 被误判为最终答复，见 premature-complete-guard.test.ts）外，本文件锁定
 * 另外两类同族问题：
 *
 * V2（清单过期误判）：
 *   planItems 存在循环外写入方 —— 用户在 UI 中途编辑清单（ipc/plan-items.ts
 *   updateTask 整组替换）、暂停恢复 restorePlanItems（pause/manager.ts）。
 *   ReAct 循环若一直持有启动时的本地引用，「无工具调用守卫」会用过期清单
 *   计算未完成数：漏判真实 pending 项 → 提前 done；多判 → 提示空转。
 *   修复：每轮迭代开始前从 store（getTask）同步最新 planItems 到本地引用。
 *
 * V3（瞬时错误升级为失败）：
 *   reason-phase.ts 的两处后续调用 —— 思考预算重试（maxTokens=8192）与
 *   Reactive 压缩后重试 —— 此前是裸单发 callTurnLlm()。一次 429 / 超时 /
 *   fetch failed 会被直接抛到 loop 外层 catch → task_failed，把健康任务打死，
 *   尽管 llm-call.ts 的 callLlmWithRetry 正是为此设计（retryableError 已覆盖
 *   rate limit / timeout / network / empty）。修复：统一包上 callLlmWithRetry(signal)，
 *   用户中止仍可短路（signal 透传）。
 *
 * 覆盖方式：与仓库惯例一致 —— 源码契约断言（结构在位 + 顺序正确 + 无裸调用残留）。
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const readSrc = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')

const loopSrc = readSrc('../engine/loop.ts')
const reasonSrc = readSrc('../engine/reason-phase.ts')

/* ---------- V2：每轮迭代同步最新清单 ---------- */

test('V2: loop.ts 从 store 导入 getTask 用于每轮同步', () => {
  assert.match(loopSrc, /import\s*\{[^}]*\bgetTask\b[^}]*\}\s*from\s*['"][^'']*store\/tasks/, '应已导入 getTask')
})

test('V2: 每轮迭代开始前同步 fresh planItems 到本地 task 引用', () => {
  assert.match(
    loopSrc,
    /const\s+freshTask\s*=\s*await\s+getTask\(task\.id\)\s*\n\s*if\s*\(\s*freshTask\?\.planItems\s*\)\s*task\.planItems\s*=\s*freshTask\.planItems/,
    '应有 try 包裹的 getTask 同步并把 fresh.planItems 写回本地引用',
  )
})

test('V2: 同步点必须位于 Reason 之前、守卫判定之前（否则读到过期数据）', () => {
  const syncIdx = loopSrc.indexOf('const freshTask = await getTask(task.id)')
  const reasonIdx = loopSrc.indexOf('// -------- Reason --------')
  const guardIdx = loopSrc.indexOf('const unfinishedCount')
  assert.ok(syncIdx >= 0 && reasonIdx > syncIdx, `同步点应在 Reason 前 (sync=${syncIdx}, reason=${reasonIdx})`)
  assert.ok(guardIdx > syncIdx, `守卫应在同步点之后 (guard=${guardIdx}, sync=${syncIdx})`)
})

test('V2: 同步失败不致命（store 读失败时仅警告，循环继续）', () => {
  assert.match(loopSrc, /planItems sync skipped/, '同步失败应静默降级而非中断运行')
})

/* ---------- V3：后续 LLM 调用必须走重试包装 ---------- */

test('V3: 思考预算重试（8192）走 callLlmWithRetry', () => {
  assert.match(
    reasonSrc,
    /await\s+callLlmWithRetry\(\(\)\s*=>\s*callTurnLlm\(8192\),\s*signal\)/,
    '思考预算重试应包 callLlmWithRetry 并透传 signal',
  )
})

test('V3: Reactive 压缩后重试走 callLlmWithRetry', () => {
  assert.match(
    reasonSrc,
    /response\s*=\s*await\s+callLlmWithRetry\(\(\)\s*=>\s*callTurnLlm\(\),\s*signal\)/,
    '压缩后重试应包 callLlmWithRetry 并透传 signal',
  )
})

test('V3: reason-phase 不再存在裸发 callTurnLlm（全部经重试包装或 abort 处理）', () => {
  // 所有 callTurnLlm 引用都必须出现在 callLlmWithRetry(() => ...) 包装内
  const bare = [...reasonSrc.matchAll(/(?<!callLlmWithRetry\(\) => )callTurnLlm\(/g)]
    .map((m) => m.index ?? -1)
    .filter((idx) => {
      const wrapStart = reasonSrc.lastIndexOf('callLlmWithRetry(', idx)
      const arrow = reasonSrc.lastIndexOf('() => ', idx)
      return !(wrapStart >= 0 && arrow > wrapStart && arrow < idx)
    })
  assert.equal(bare.length, 0, `发现裸调用位置: ${bare.join(', ')}`)
})

/* ---------- 回归锚：既有守卫仍在位 ---------- */

test('回归: 无工具调用守卫与自愈提示未被本轮改动破坏', () => {
  assert.match(loopSrc, /MAX_CONSECUTIVE_NO_TOOL\s*=\s*2/)
  assert.match(loopSrc, /【重要】[\s\S]*?task_complete/)
  assert.match(loopSrc, /consecutiveNoToolFinal\s*=\s*0/, '有工具调用时应归零计数')
})
