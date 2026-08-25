/* ============================================================
 * v0.14.0 Task 5 — 容错分级模块入口
 *
 * 5 档防御链：
 *   ① retry ≤3 次（1s/2s/4s 指数退避）
 *   ② Skill 注册表检索替代方案 → 替代 skill 自动执行
 *   ③ LLM 因果分析判断后续 PlanItem 影响
 *   ④ 影响后续 → pushFaultCard 等用户决策（重试/忽略/取消后续）
 *   ⑤ 不影响后续 → markFailed(planItem) + continue
 *   - LLM 致命异常（llm-fatal）→ task:interrupt + 任务置 failed
 *
 * 兜底约束：除 LLM 致命异常外，**绝不**主动暂停/停止用户任务。
 *
 * 各 SubTask 拆分见同目录各文件：
 *   - retry-with-backoff.ts         5.2
 *   - alternative-skill-matcher.ts   5.3
 *   - impact-analyzer.ts            5.4
 *   - notify.ts                     5.5
 *   - run-fault-tolerant.ts         5.6 编排器
 * （polish7：删除 engine-bridge.ts，假功能）
 * ============================================================ */

export type {
  FaultKind,
  FaultError,
  FaultToolCall,
  FaultTolerantCtx,
  RetryOptions,
  RetryResult,
  RetryAttemptRecord,
  SkillMatch,
  ImpactAnalysis,
  FaultNotificationPayload,
  FaultDecisionOutcome,
  SkillRegistry,
} from './types.js'

export { classifyError, isFaultError, RETRIES_EXHAUSTED_CODE } from './classify.js'
export { retryWithBackoff, DEFAULT_BACKOFF_MS, DEFAULT_MAX_ATTEMPTS } from './retry-with-backoff.js'
export { findAlternative, staticDependencyBlocks } from './alternative-skill-matcher.js'
export { analyzeImpact } from './impact-analyzer.js'
export { pushFaultCard, logFaultDecision } from './notify.js'
export { runFaultTolerant } from './run-fault-tolerant.js'
