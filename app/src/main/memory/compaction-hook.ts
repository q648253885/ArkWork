/* ============================================================
 * ArkWork — Context Compaction 与 Turn 整合钩子（v0.14.0 Task 12）
 * 设计文档 §3.2  Scenario: 与 Turn 模型整合
 *
 * 导出 `memoryPhase0(turn)` — 替换 phase-runner 预留的 stub：
 *   Phase 0 逻辑：token 计量 → 达到模型窗口 autoCompact 阈值触发压缩前预警
 *   （notify:warn，可取消）→ 用户确认或默认行为触发 compact() → 完成后推送
 *   notify:info（压缩比+摘要预览）→ 未达阈值走常规上下文注入（复用 l1-working，
 *   engine 自行组装上下文）。v0.36.0 F1.3：阈值单一真源 = compaction.ts 模型窗口公式。
 *
 * 用户取消语义：通过 `respondCompactionDecision(cardId, 'cancel')`（IPC 层可接入）
 * 取消后延后到当前任务（turn）结束——同 turn 不再重复触发，下一 turn 重新计量。
 * 取消决策等待窗口默认 1.5s（超时按默认行为 proceed），不阻塞 Turn。
 * ============================================================ */
import { broadcast } from '../window.js'
import { logger } from '../system/logger.js'
import { getUiLocale, tFor } from '../i18n/messages.js'
import { genId } from '@shared/utils/id'
import { listEnabledL1 } from './l1-working.js'
import { countTokens } from './token-counter.js'
// v0.36.0 F1.3：预算单一真源 —— 16000/0.8 独立分支删除，改走 compaction.ts 模型窗口公式
import {
  compact,
  DEFAULT_COMPACTION_POLICY,
  resolveAutoCompactThreshold,
  resolveModelMaxTokens,
} from './compaction.js'
import type { CompactionPolicy } from './compaction.js'
import type { Turn } from '../engine/types.js'
import type { MemoryItem } from '@shared/types/memory'

/** Phase 0 钩子可配置项（上层装配真实 taskId 解析等） */
export interface MemoryPhase0Options {
  /** 从 Turn 解析 taskId（Turn 实体本身无 taskId 字段，由装配方提供）。缺省无法解析 → 跳过 compaction。 */
  resolveTaskId?: (turn: Turn) => string | undefined
  /** token 预算覆盖（缺省走模型窗口公式：resolveAutoCompactThreshold(modelWindow)） */
  budgetTokens?: number
  /** compaction 策略覆盖 */
  policy?: Partial<CompactionPolicy>
  /** 摘要用模型 ID（缺省走本地 fallback 摘要）；同时用于解析模型窗口预算 */
  modelId?: string
  /** 用户取消决策的等待窗口（ms，缺省 1500；超时按默认行为 proceed） */
  decisionTimeoutMs?: number
}

export const DEFAULT_DECISION_TIMEOUT_MS = 1_500

type CompactionDecision = 'proceed' | 'cancel'

interface PendingDecision {
  turnId: string
  resolve: (d: CompactionDecision) => void
}

/** 用户决策注册表（IPC 层通过 respondCompactionDecision 回传） */
const pendingDecisions = new Map<string, PendingDecision>()
/** 用户取消后延后到当前任务结束（同 turn 不再重复触发） */
const cancelledTurns = new Set<string>()
/** 互斥：已有压缩进行中则跳过本次触发 */
let compactionInFlight = false

/**
 * 渲染层（IPC）回传压缩决策。
 * 返回 false 表示 cardId 不存在（已超时或已被消费）。
 */
export function respondCompactionDecision(
  cardId: string,
  decision: CompactionDecision,
): boolean {
  const entry = pendingDecisions.get(cardId)
  if (!entry) return false
  pendingDecisions.delete(cardId)
  if (decision === 'cancel') cancelledTurns.add(entry.turnId)
  entry.resolve(decision)
  return true
}

function waitForDecision(cardId: string, turnId: string, timeoutMs: number): Promise<CompactionDecision> {
  return new Promise((resolve) => {
    const entry: PendingDecision = {
      turnId,
      resolve: (d) => {
        clearTimeout(timer)
        resolve(d)
      },
    }
    pendingDecisions.set(cardId, entry)
    const timer = setTimeout(() => {
      if (pendingDecisions.delete(cardId)) resolve('proceed')
    }, timeoutMs)
    timer.unref?.()
  })
}

/** 预留：供测试重置内部状态（不影响生产路径） */
export function __resetCompactionStateForTest(): void {
  pendingDecisions.clear()
  cancelledTurns.clear()
  compactionInFlight = false
}

async function runMemoryPhase0(turn: Turn, opts: MemoryPhase0Options): Promise<void> {
  const resolveTaskId = opts.resolveTaskId ?? (() => undefined)
  const taskId = resolveTaskId(turn)
  if (!taskId) {
    logger.debug('Memory', 'compaction: no taskId resolved, skip phase-0 compaction', turn.id)
    return
  }
  if (cancelledTurns.has(turn.id)) {
    // 用户此前取消了本 turn 的压缩——延后到任务结束
    cancelledTurns.delete(turn.id)
    logger.debug('Memory', 'compaction: deferred by user decision, skip this turn', taskId)
    return
  }
  if (compactionInFlight) {
    logger.debug('Memory', 'compaction: another compaction in flight, skip', taskId)
    return
  }

  // 1. token 计量
  let items: MemoryItem[]
  try {
    items = await listEnabledL1(taskId)
  } catch (err) {
    logger.warn('Memory', `compaction: listL1 failed: ${(err as Error).message}`, taskId)
    return
  }
  const currentTokens = countTokens(items)
  // v0.36.0 F1.3：预算单一真源 —— 模型窗口公式（无 modelId / 解析失败回落 180_000）；
  // 旧「budget*0.8 预警占比」分支删除，达到阈值即触发（阈值本身已含 13k 缓冲）。
  const modelMaxTokens = await resolveModelMaxTokens(opts.modelId)
  const budget = opts.budgetTokens ?? resolveAutoCompactThreshold(modelMaxTokens)
  if (currentTokens < budget) {
    // 2. 常规上下文注入（< 阈值，engine 的上下文组装继续走 l1-working）
    logger.debug('Memory', `phase-0: regular context injection (${currentTokens}/${budget} tokens, window ${modelMaxTokens})`, taskId)
    return
  }

  // 3. 压缩前预警（notify:warn，可取消）
  const cardId = genId('comp')
  const estimatedDuration = Math.max(1, Math.round(currentTokens / 8000))
  const pct = Math.round((currentTokens / budget) * 100)
  broadcast('notify:warn', {
    type: 'compaction',
    message: tFor(getUiLocale(), 'compaction.warnMessage', {
      current: currentTokens,
      budget,
      pct,
      seconds: estimatedDuration,
    }),
    currentTokens,
    budget,
    estimatedDuration,
    cancelable: true,
    cardId,
  })
  // 4. 显式 Compaction 阶段开始（暂停新工具调用 / UI 侧进度）
  broadcast('compaction:start', { taskId, turnId: turn.id, currentTokens, budget })

  const decision = await waitForDecision(cardId, turn.id, opts.decisionTimeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS)
  if (decision === 'cancel') {
    cancelledTurns.add(turn.id)
    broadcast('compaction:cancelled', { taskId, turnId: turn.id })
    logger.info('Memory', 'compaction cancelled by user; deferred to end of current task', taskId)
    return
  }

  compactionInFlight = true
  try {
    const snapshot = { taskId, items, budgetTokens: budget, createdAt: Date.now() }
    const result = await compact(snapshot, { ...opts.policy, modelId: opts.modelId })

    // 5. 压缩后行为：token 降至 targetTokenRatio 以下 + notify:info（压缩比 + 摘要预览）
    const ratio = result.tokenBefore > 0 ? result.tokenAfter / result.tokenBefore : 0
    const reduced = Math.round((1 - ratio) * 100)
    broadcast('compaction:done', { taskId, turnId: turn.id, result })
    broadcast('notify:info', {
      type: 'compaction',
      message: tFor(getUiLocale(), 'compaction.doneMessage', {
        before: result.tokenBefore,
        after: result.tokenAfter,
        reduced,
        target: Math.round((opts.policy?.targetTokenRatio ?? DEFAULT_COMPACTION_POLICY.targetTokenRatio) * 100),
        rounds: result.keptRounds,
      }),
      ratio,
      summaryPreview: result.summary.slice(0, 120),
      currentTokens: result.tokenAfter,
      budget,
      taskId,
    })
    logger.info(
      'Memory',
      `phase-0 compaction done: ${result.tokenBefore}→${result.tokenAfter} tokens, kept ${result.keptRounds} rounds, ${result.entities.length} entities`,
      taskId,
    )
  } finally {
    compactionInFlight = false
  }
}

/** 工厂：装配 taskId 解析等依赖（上层引擎接入真实 taskId） */
export function createMemoryPhase0(opts: MemoryPhase0Options = {}): (turn: Turn) => Promise<void> {
  return (turn: Turn) => runMemoryPhase0(turn, opts)
}

/** 默认 Phase 0 钩子 — 替换 phase-runner 中的 stub（无 taskId 解析时自动降级为 no-op） */
export const memoryPhase0: (turn: Turn) => Promise<void> = createMemoryPhase0()
