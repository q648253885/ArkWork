/**
 * ArkWork — TaskGraph 指标埋点
 *
 * 依据：docs/versions/v0.30.0/04-system-design.md §7.4
 *       agent-design-v1.0/07-多Agent权限与评估.md §3
 *
 * **本版只埋两条红线指标 + 四项辅助观测**（Scope Out S6：不做完整指标体系）。
 * 理由：完整指标体系需要长期数据积累才有意义；本版先埋"能最快证伪整个设计"
 * 的那几个数（设计稿 §08-六.3 的"指标先行"原则）。
 *
 * 红线指标：
 *  | 指标 | 定义 | 红线 |
 *  |---|---|---|
 *  | **幻影完成率** | 模型宣称完成但被 Gate 降级为 verifying 的次数 ÷ 宣称完成总次数 | 基线对照（无绝对红线，看趋势） |
 *  | **同步开销率** | 图维护动作数 ÷ 总工具调用数 | **< 5%** |
 *
 * 辅助观测（验证设计稿的 H1/H4/H6 假设）：
 *  | 指标 | 验证的假设 |
 *  |---|---|
 *  | 投影 token 用量与裁剪次数 | H1 活跃窗口是否够用 |
 *  | 事件命中分布 | H5 事件驱动 Replan 的触发条件是否完备 |
 *  | tier 分布与用户覆盖次数 | H6 tier 划分是否符合真实任务分布 |
 *  | converges 的 unmodeled/zombie 数量 | 收敛环是否真有发现（否则它是仪式） |
 *
 * **实现取向**：内存计数器 + 定期日志，不落盘（重启清零）。
 * 为什么不落盘：这是**开发期观测数据**，不是用户数据；写进 .arkwork 会让
 * 用户的工作区里出现无用的运行时文件（违反"交付即用"的整洁性）。
 * 需要长期观测时，由 IPC `graph:metrics` 拉取当前快照。
 */
import type { MetricsCounters, MetricsSnapshot } from '@shared/types/graph'
export type { MetricsSnapshot }
import { logger } from '../../system/logger.js'

/** 指标名 */
export type MetricName =
  /** 模型宣称完成但被降级为 verifying（幻影完成率分子） */
  | 'phantom_completion'
  /** 模型宣称完成的次数（幻影完成率分母） */
  | 'model_claim'
  /** 图维护动作（同步开销率分子） */
  | 'sync_action'
  /** 全部工具调用（同步开销率分母） */
  | 'tool_call'
  /** S1 投影 */
  | 'sync_projection'
  /** 事件命中 */
  | 'event'
  /** 收敛 */
  | 'converge'
  /** 门禁拒绝 */
  | 'gate_reject'
  /** tier 判定 */
  | 'tier_decided'

/** 计数器类型复用 shared（IPC 契约需要跨端可见），此处只做本地别名 */
type Counters = MetricsCounters

const counters: Counters = {
  phantom_completion: 0,
  model_claim: 0,
  sync_action: 0,
  tool_call: 0,
  gate_reject: 0,
  projection_tokens: 0,
  projection_over_budget: 0,
  projection_trimmed: {},
  events: {},
  converge_findings: { unmodeled: 0, zombies: 0, degraded: 0, runs: 0 },
  tier_distribution: {},
}

/** 日志节流：每 N 次记录一次，避免刷屏 */
const LOG_EVERY = 50
let opSinceLog = 0

/**
 * 记录一次指标。
 *
 * @param name    指标名
 * @param payload 附加上下文（前几个字段足够定位；不做全量存储，避免内存膨胀）
 */
export function recordMetric(name: MetricName, payload: Record<string, unknown> = {}): void {
  switch (name) {
    case 'phantom_completion':
      counters.phantom_completion += 1
      counters.model_claim += 1
      counters.sync_action += 1
      break
    case 'model_claim':
      counters.model_claim += 1
      break
    case 'sync_action':
      counters.sync_action += 1
      break
    case 'tool_call':
      counters.tool_call += 1
      break
    case 'gate_reject':
      counters.gate_reject += 1
      break
    case 'sync_projection': {
      const tokens = Number(payload.tokens ?? 0)
      counters.projection_tokens += tokens
      if (payload.overBudget) counters.projection_over_budget += 1
      const trimmed = payload.trimmed
      if (typeof trimmed === 'number' && trimmed > 0) {
        counters.projection_trimmed.count = (counters.projection_trimmed.count ?? 0) + trimmed
      }
      break
    }
    case 'event': {
      const ev = String(payload.event ?? 'unknown')
      counters.events[ev] = (counters.events[ev] ?? 0) + 1
      if (payload.action === 'replan') counters.sync_action += 1
      break
    }
    case 'converge':
      counters.converge_findings.runs += 1
      counters.converge_findings.unmodeled += Number(payload.unmodeled ?? 0)
      counters.converge_findings.zombies += Number(payload.zombies ?? 0)
      counters.converge_findings.degraded += Array.isArray(payload.degraded) ? payload.degraded.length : 0
      break
    case 'tier_decided': {
      const tier = String(payload.tier ?? '?')
      counters.tier_distribution[tier] = (counters.tier_distribution[tier] ?? 0) + 1
      break
    }
  }

  opSinceLog += 1
  if (opSinceLog >= LOG_EVERY) {
    opSinceLog = 0
    logger.debug('Agent', `metrics: ${JSON.stringify(getMetricsSnapshot())}`)
  }
}

export function getMetricsSnapshot(): MetricsSnapshot {
  const claim = counters.model_claim
  const tools = counters.tool_call
  const phantom = claim > 0 ? counters.phantom_completion / claim : null
  // 同步开销率的分母用"全部工具调用 + 图维护动作"，否则会把图维护动作排除在外
  const denom = tools + counters.sync_action
  const overhead = denom > 0 ? counters.sync_action / denom : null
  return {
    phantomCompletionRate: phantom,
    syncOverheadRate: overhead,
    syncOverheadRedline: overhead !== null && overhead >= 0.05,
    raw: counters,
  }
}

/** 清零（测试用） */
export function resetMetrics(): void {
  counters.phantom_completion = 0
  counters.model_claim = 0
  counters.sync_action = 0
  counters.tool_call = 0
  counters.gate_reject = 0
  counters.projection_tokens = 0
  counters.projection_over_budget = 0
  counters.projection_trimmed = {}
  counters.events = {}
  counters.converge_findings = { unmodeled: 0, zombies: 0, degraded: 0, runs: 0 }
  counters.tier_distribution = {}
  opSinceLog = 0
}

/** 把指标渲染成一行人类可读文本（交付说明与调试用） */
export function renderMetricsLine(): string {
  const s = getMetricsSnapshot()
  const pct = (v: number | null): string => (v === null ? '—' : `${(v * 100).toFixed(1)}%`)
  return (
    `幻影完成率 ${pct(s.phantomCompletionRate)}（${counters.phantom_completion}/${counters.model_claim}）· ` +
    `同步开销率 ${pct(s.syncOverheadRate)}（红线 5%${s.syncOverheadRedline ? ' ⚠ 超标' : ''}）· ` +
    `投影累计 ${counters.projection_tokens} tok（超预算 ${counters.projection_over_budget} 次）· ` +
    `收敛 ${counters.converge_findings.runs} 次（未建模 ${counters.converge_findings.unmodeled} / 僵尸 ${counters.converge_findings.zombies}）`
  )
}
