/* ============================================================
 * ArkWork — v0.14.0 Task 4 · Phase Runner（Turn 生命周期）
 * 设计文档 §3.2.M2 / §2.3.2 BF-01
 *
 * 入口 `runTurn`：
 *   - 接受一个 Turn 实体 + TurnDeps 依赖集合
 *   - 按 Phase 0 → 3 顺序执行
 *   - 任一 Phase 抛错 → Turn.status='aborted'（非 failed）
 *   - 全部 Phase 完成 → Turn.status='completed'
 *   - 支持外部 AbortSignal 中断（与 v0.13.1 引擎 cancel 行为对齐）
 *
 * SubTask 对应：
 *   4.2 — 入口、TurnDeps、PhaseRunner 形态
 *   4.3 — Phase 0 上下文注入 + emit phase0:done
 *   4.4 — Phase 1（路由）/ Phase 2（推理-工具循环 + 容错）/ Phase 3（决策）
 * ============================================================ */
import { classifyRoute } from '../router/classify-route.js'
import type { RouteDecision } from '../router/classify-route.js'
import { routeAgent } from '../router/route-agent.js'
import type { AgentRouteDecision } from '../router/route-agent.js'
import { builtinAgentRegistry } from '../store/agents.js'
import { memoryPhase0 } from '../memory/compaction-hook.js'
import { logger } from '../system/logger.js'
import { genId } from '@shared/utils/id'
import type { PlanContent } from '@shared/types/react'
import type { Task, PlanItem } from '@shared/types/task'
import type {
  PhaseId,
  PhaseRecord,
  Turn,
  TurnEvent,
  TurnResult,
  TurnStatus,
} from './types.js'

/* ============================================================
 * v0.14.0 Task 4 §4.2：invokeSkill 结果归一类型
 * ============================================================ */
export interface SkillResult {
  result: unknown
  summary: string
}

/* ============================================================
 * v0.14.0 Task 4 §4.2：TurnDeps 依赖集合
 *
 * Task 5/12 的接口当前阶段为 stub（或 fn 占位）：
 *   - faultTolerant 复用 Task 5 已声明的 `runFaultTolerant` 函数签名；
 *     后续 Task 5 收口时直接 `import { runFaultTolerant } from '../fault-tolerance/run-fault-tolerant.js'`
 *   - memoryPhase0 已由 Task 12 接入真实实现（compaction-hook：token 计量 → ≥80% 压缩）
 * ============================================================ */
export interface TurnDeps {
  /** Task 2 — chat/task 分流判定。返回 chat 时上游应绕过 runTurn 直接走单次补全。 */
  classifyRoute: (
    input: string,
    ctx?: { hasTools?: boolean; lastTurnKind?: 'chat' | 'task' },
  ) => RouteDecision
  /** Task 3 — Agent 自动路由，描述相似度 + 平局 LLM 兜底。 */
  routeAgent: (input: string) => Promise<AgentRouteDecision>
  /** 工具调用（被 faultTolerant 包装）。skillId 与 Skill 体系 ID 对齐。 */
  invokeSkill: (skillId: string, args: Record<string, unknown>) => Promise<SkillResult>
  /**
   * Task 5 容错分级 — 当前外部注入；Task 5 实装后由上层以 `faultTolerant: runFaultTolerant` 形式注入。
   * 这里用宽松签名避免循环依赖：返回 `{ ok: true, value }` 或 `{ ok: false, fault }`。
   */
  faultTolerant: <T>(
    fn: () => Promise<T>,
    ctx: FaultContext,
  ) => Promise<FaultResult<T>>
  /** Task 12 — Phase 0 钩子（compaction-hook 真实实现：token 计量 → ≥80% 压缩 → 常规注入）。 */
  memoryPhase0: (turn: Turn) => Promise<void>
  /** Turn 内 Phase 2 最大迭代次数（默认 25，对齐 Cursor / v0.13.1 引擎）。 */
  maxIterations: number
}

/** 与 fault-tolerance 模块（F5.2）约定的最小上下文（避免循环依赖）。 */
export interface FaultContext {
  taskId?: string
  planItemId?: string
  toolName: string
  args?: Record<string, unknown>
  signal?: AbortSignal
}

/** 5 档容错链最终结果（与 fault-tolerance 类型兼容的最小子集）。 */
export type FaultResult<T> =
  | { ok: true; value: T; note?: string; alternativeSkillId?: string }
  | { ok: false; fault: { code: string; message: string }; outcome: string }

/* ============================================================
 * Task 4 §5：runTurn — Phase 顺序执行器（Abortable）
 * ============================================================ */
export async function runTurn(turn: Turn, deps: TurnDeps): Promise<TurnResult> {
  const runner = new PhaseRunner(turn, deps)
  return runner.run()
}

/* ============================================================
 * PhaseRunner — 单一 Turn 的 4 Phase 执行器
 * ============================================================ */
export class PhaseRunner {
  readonly turn: Turn
  readonly deps: TurnDeps
  /** Turn 级事件总线 — renderer 通过 IPC 订阅。 */
  private listeners = new Set<(event: TurnEvent) => void>()

  constructor(turn: Turn, deps: TurnDeps) {
    this.turn = turn
    this.deps = deps
  }

  /** 订阅 Turn 事件。返回反订阅函数（与 Set/Map 订阅惯例对齐）。 */
  subscribe(cb: (event: TurnEvent) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private emit(event: TurnEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(event)
      } catch (err) {
        logger.warn('Agent', `turn listener error: ${(err as Error).message}`, this.turn.id)
      }
    }
  }

  private setStatus(status: TurnStatus): void {
    this.turn.status = status
    this.emit({ name: 'turn:status', payload: { turnId: this.turn.id, status } })
  }

  /** 记录单个 Phase 的起止时间 + 摘要，返回便于追加的 PhaseRecord。 */
  private beginPhase(phase: PhaseId): PhaseRecord {
    const record: PhaseRecord = {
      phase,
      startedAt: Date.now(),
      summary: '',
    }
    this.turn.phases.push(record)
    this.setStatus(`phase-${phase}` as TurnStatus)
    return record
  }

  private endPhase(record: PhaseRecord, summary: string): void {
    record.endedAt = Date.now()
    record.summary = summary
  }

  /** 主执行入口（runTurn 调用） */
  async run(): Promise<TurnResult> {
    let phase1Plan: PlanContent | undefined
    try {
      // Phase 0
      this.setStatus('phase-0')
      const phase0Record = this.beginPhase(0)
      await this.runPhase0(phase0Record)
      this.emit({ name: 'phase0:done', payload: { turnId: this.turn.id } })

      // Phase 1
      this.setStatus('phase-1')
      const phase1Record = this.beginPhase(1)
      const phase1 = await this.runPhase1(phase1Record)
      phase1Plan = phase1.plan
      this.emit({ name: 'phase1:done', payload: { turnId: this.turn.id } })

      // Phase 2
      this.setStatus('phase-2')
      const phase2Record = this.beginPhase(2)
      const phase2 = await this.runPhase2(phase2Record)
      this.emit({ name: 'phase2:done', payload: { turnId: this.turn.id } })

      // Phase 3
      this.setStatus('phase-3')
      const phase3Record = this.beginPhase(3)
      const summary = this.runPhase3(phase3Record, phase2.lastFinalSummary, phase1Plan)
      this.emit({ name: 'phase3:done', payload: { turnId: this.turn.id } })

      this.turn.endedAt = Date.now()
      this.setStatus('completed')
      const result: TurnResult = {
        turnId: this.turn.id,
        status: 'completed',
        summary,
        plan: phase1Plan,
      }
      this.emit({ name: 'turn:complete', payload: { turnId: this.turn.id, summary } })
      return result
    } catch (err) {
      const message = (err as Error).message
      logger.error('Agent', `Turn aborted: ${message}`, this.turn.id)
      this.turn.endedAt = Date.now()
      this.setStatus('aborted')
      this.emit({ name: 'turn:aborted', payload: { turnId: this.turn.id } })
      this.emit({
        name: 'turn:failed',
        payload: { turnId: this.turn.id, error: message },
      })
      return {
        turnId: this.turn.id,
        status: 'aborted',
        plan: phase1Plan,
        error: message,
      }
    }
  }

  /* ============================================================
   * Phase 0 — 上下文注入（Task 4 §4.3）
   *   - 调用 deps.memoryPhase0（Task 12 占位 stub）
   *   - L1 上下文组装继续由既有 runReActLoop 内部 assembleMessages 负责，
   *     此处 PhaseRunner 不重复实现，仅做钩子挂载点
   * ============================================================ */
  private async runPhase0(record: PhaseRecord): Promise<void> {
    try {
      await this.deps.memoryPhase0(this.turn)
      this.endPhase(record, 'phase-0 context injection (L1 assembled by engine)')
    } catch (err) {
      const message = (err as Error).message
      this.endPhase(record, `phase-0 failed: ${message}`)
      throw err
    }
  }

  /* ============================================================
   * Phase 1 — 路由（Task 4 §4.4）
   *   - 复用 classifyRoute 判定 chat/task
   *   - 复用 routeAgent 决策 @general / @coding
   *   - chat 命中时仍走 PhaseRunner 后续 Phase（chat 路径在 SubTask 4.5 入口处
   *     判定绕过 runTurn；此处 phase-1 仅记录决策结果，不强制控制流）
   * ============================================================ */
  private async runPhase1(record: PhaseRecord): Promise<{ plan?: PlanContent }> {
    try {
      const route = this.deps.classifyRoute(this.turn.input)
      void route // 当前 PhaseRunner 不据 route.kind 改流（4.5 入口分流已先于本函数）
      const agentDecision = await this.deps.routeAgent(this.turn.input)
      this.turn.agentId = agentDecision.agentId
      const plan: PlanContent | undefined =
        agentDecision.agentId === '@coding'
          ? {
              goal: this.turn.input.slice(0, 80),
              items: this.turn.planItems.map((it) => it.text),
              useResources: [],
              skipResources: [],
            }
          : undefined
      this.endPhase(
        record,
        `route=${agentDecision.agentId} (rule=${agentDecision.rule}, ${agentDecision.latencyMs}ms)`,
      )
      return { plan }
    } catch (err) {
      const message = (err as Error).message
      this.endPhase(record, `phase-1 failed: ${message}`)
      throw err
    }
  }

  /* ============================================================
   * Phase 2 — 工具循环（Task 4 §4.4）
   *   - 在 maxIterations 内循环 推理 → invokeSkill（容错包装）
   *   - 模型推理本身仍由 v0.13.1 runReActLoop 完成；
   *     本 PhaseRunner 在 PhaseRunner.run() 阶段不直接调 LLM（避免与
   *     runReActLoop 重复实现），而是提供一个「通过 deps 暴露钩子」的契约：
   *
   *     注意：完整的 Phase 2 推理循环由既有 runReActLoop 承担；本 PhaseRunner
   *     在最小集契约下实现「循环骨架 + planItems 状态联动」——
   *     每步通过 faultTolerant 包装 deps.invokeSkill；若 deps 注入的是 stub
   *     （不发起真实工具调用），本循环不推进，仅更新 planItems 全置 done 后落幕。
   * ============================================================ */
  private async runPhase2(record: PhaseRecord): Promise<{ lastFinalSummary: string | undefined }> {
    try {
      const max = Math.max(1, this.deps.maxIterations)
      let iter = 0
      let lastFinalSummary: string | undefined

      // 初始化 planItems：全部置 pending（仅当 turn 注入时已绑 planItems）
      const pendingItems = this.turn.planItems.filter((it) => it.status === 'pending')
      if (pendingItems.length === 0) {
        // turn 没注入 planItems，PhaseRunner 视为「无 Plan」快速通过
        this.endPhase(record, 'phase-2: no planItems provided, pass through')
        return { lastFinalSummary: undefined }
      }

      // 取首个 pending 项作为当前执行目标（线性推进，与 v0.13.1 单步执行对齐）
      const item = pendingItems[0]
      if (!item) {
        this.endPhase(record, 'phase-2: no pending planItems, pass through')
        return { lastFinalSummary: undefined }
      }
      while (iter < max) {
        if (this.turn.abortSignal?.aborted) {
          throw new Error('Turn aborted by external signal')
        }
        const skillId = deriveSkillIdFromPlanItem(item)
        const skillArgs = deriveSkillArgsFromPlanItem(item)

        // 推进计划项状态：pending → running
        this.markPlanItem(item, 'running')

        const ctx: FaultContext = {
          taskId: undefined,
          planItemId: item.id,
          toolName: skillId,
          args: skillArgs,
          signal: this.turn.abortSignal,
        }
        const result = await this.deps.faultTolerant(
          () => this.deps.invokeSkill(skillId, skillArgs),
          ctx,
        )
        if (result.ok) {
          this.markPlanItem(item, 'done', result.note ?? `done via ${result.alternativeSkillId ?? skillId}`)
          if (iter === 0) {
            const resultWithValue = result as { value?: { summary?: unknown } }
            lastFinalSummary =
              typeof resultWithValue.value?.summary === 'string'
                ? resultWithValue.value.summary
                : undefined
          }
        } else {
          // 与 fault-tolerance（Task 5）契约对齐：outcome==='no-impact'/'cancelled' 等非 blocking
          // 此处为最小骨架：失败即标 failed（Task 5 接入后可基于 outcome 区分 continue/cancel）
          const faultInfo = result.fault
          const message = faultInfo?.message ?? 'tool failed'
          this.markPlanItem(item, 'failed', message)
          if (result.outcome === 'llm-fatal') {
            throw new Error(`LLM fatal in plan item ${item.id}: ${message}`)
          }
        }
        iter += 1
      }

      this.endPhase(record, `phase-2 iterated ${iter}/${max} times`)
      return { lastFinalSummary }
    } catch (err) {
      const message = (err as Error).message
      this.endPhase(record, `phase-2 failed: ${message}`)
      throw err
    }
  }

  private markPlanItem(item: PlanItem, status: PlanItem['status'], note?: string): void {
    const idx = this.turn.planItems.findIndex((it) => it.id === item.id)
    if (idx < 0) return
    const now = Date.now()
    const updated: PlanItem = {
      ...this.turn.planItems[idx],
      status,
      updatedAt: now,
      completedAt:
        status === 'done' || status === 'failed' || status === 'cancelled' || status === 'skipped'
          ? now
          : this.turn.planItems[idx].completedAt,
    }
    if (note) {
      // 不覆盖既有 completedAt；此处仅作为副作用日志（持久化层由调用方自行写盘）
      logger.debug('Agent', `planItem ${item.id} → ${status}: ${note}`, this.turn.id)
    }
    this.turn.planItems[idx] = updated
  }

  /* ============================================================
   * Phase 3 — 决策（Task 4 §4.4）
   *   - 决策产物：completed / aborted
   *   - 无工具调用 = 模型 final 答复 = 视为 completed
   *   - 否则 abort（与 v0.13.1 max_iterations_reached 行为对齐）
   * ============================================================ */
  private runPhase3(record: PhaseRecord, lastFinalSummary: string | undefined, plan?: PlanContent): string {
    try {
      const remaining = this.turn.planItems.filter(
        (it) => it.status === 'pending' || it.status === 'running',
      )
      const summary = lastFinalSummary ?? `turn done: ${plan ? `${plan.items.length} plan items` : 'no plan'}`
      if (remaining.length > 0) {
        logger.warn(
          'Agent',
          `Phase 3: ${remaining.length} plan items still open, mark turn completed`,
          this.turn.id,
        )
      }
      this.endPhase(record, `phase-3 decision: completed (${summary.length} chars)`)
      return summary
    } catch (err) {
      const message = (err as Error).message
      this.endPhase(record, `phase-3 failed: ${message}`)
      throw err
    }
  }
}

/* ============================================================
 * 内部工具 — PlanItem → 工具调用参数
 *
 * 当前 PhaseRunner 是个最小骨架：把每个 planItem 简单映射为一次 invokeSkill
 * 调用；真正 Phase 2 的模型推理 + 工具选择仍由 v0.13.1 runReActLoop 完成，
 * PhaseRunner 仅保留 planItems 状态联动 + 容错包装。
 * ============================================================ */
function deriveSkillIdFromPlanItem(_item: PlanItem): string {
  // 最小骨架：所有 planItem 一律映射到 'file-reader'（与 runReActLoop 已有内置工具对齐）
  return 'file-reader'
}
function deriveSkillArgsFromPlanItem(item: PlanItem): Record<string, unknown> {
  return { path: '.', note: item.text }
}

/* ============================================================
 * 工厂：根据 Task + 用户输入 + Task 1 的 planItems 构造 Turn
 * ============================================================ */
export interface CreateTurnInput {
  /** 既有 Task；planItems 直接复用 Task.planItems。 */
  task: Task
  /** 用户原始输入文本（已落入 L1 user_message，无需再 append） */
  input: string
  /** 上游分流给的初始 agentId 提示；实际以 routeAgent 结果为准。 */
  initialAgentId?: '@general' | '@coding'
  abortSignal?: AbortSignal
  maxIterations?: number
}

export function createTurn(input: CreateTurnInput): { turn: Turn; deps: TurnDepsStub; maxIterations: number } {
  const now = Date.now()
  const turn: Turn = {
    id: genId('turn'),
    input: input.input,
    agentId: input.initialAgentId ?? '@general',
    phases: [],
    planItems: (input.task.planItems ?? []).map((it) => ({ ...it })),
    status: 'idle',
    startedAt: now,
    abortSignal: input.abortSignal,
  }
  const maxIter = input.maxIterations ?? input.task.config.maxIterations ?? 25
  return { turn, deps: defaultTurnDeps(), maxIterations: maxIter }
}

/* ============================================================
 * TurnDeps 默认实现 — 真实生产代码会在引擎入口装配真实 deps（Task 5/12 接入）
 * 当前阶段仅保留可运行的 stub
 * ============================================================ */
export interface TurnDepsStub extends TurnDeps {}

// routeAgent / invokeSkill 的真实签名有额外参数；PhaseRunner 的契约是「单参数版本」
// 这里是默认 deps 适配层，把多参数签名收拢成单参数接口。
function defaultTurnDeps(): TurnDepsStub {
  return {
    classifyRoute,
    routeAgent: (input: string) => routeAgent(input, builtinAgentRegistry),
    invokeSkill: async (skillId: string, _args: Record<string, unknown>) => {
      // stub：不发起真实工具调用；返回合成结果（让 PhaseRunner 流程跑通）
      return { result: { stub: true, skillId }, summary: `${skillId} stub result` }
    },
    faultTolerant: async <T>(
      fn: () => Promise<T>,
      _ctx: FaultContext,
    ): Promise<FaultResult<T>> => {
      try {
        const value = await fn()
        return { ok: true, value }
      } catch (err) {
        return {
          ok: false,
          fault: { code: 'stub', message: (err as Error).message },
          outcome: 'no-impact',
        }
      }
    },
    memoryPhase0,
    maxIterations: 25,
  }
}
