/* ============================================================
 * ArkWork — v0.14.0 Task 4 · ReAct Engine Types
 * 设计文档：引擎 §3.2.M2
 *
 * Turn 模型：
 *   - 一次用户输入 → 一个 Turn
 *   - Turn 内部分 4 个 Phase（0~3）
 *   - PhaseRecord 记录每个 Phase 的起止时间 + 摘要
 *   - planItems 复用 Task 1 的 PlanItem 六态
 * ============================================================ */
import type { PlanItem } from '@shared/types/task'
import type { PlanContent } from '@shared/types/react'

/** Turn 内 Phase 编号 — 0 = 上下文注入；1 = 路由/思考；2 = 动作/工具循环；3 = 决策/收尾。 */
export type PhaseId = 0 | 1 | 2 | 3

/** PhaseRecord 字段名约定与 PhaseId 对齐（便于 UI 直接渲染）。 */
export type TurnStatus =
  | 'idle'
  | 'phase-0'
  | 'phase-1'
  | 'phase-2'
  | 'phase-3'
  | 'completed'
  | 'aborted'
  | 'failed'

/** 引擎事件：与 render UI 桥接（custom event name + payload）。 */
export type TurnEvent =
  | { name: 'phase0:done'; payload: { turnId: string } }
  | { name: 'phase1:done'; payload: { turnId: string } }
  | { name: 'phase2:done'; payload: { turnId: string } }
  | { name: 'phase3:done'; payload: { turnId: string } }
  | { name: 'turn:status'; payload: { turnId: string; status: TurnStatus } }
  | { name: 'turn:complete'; payload: { turnId: string; summary?: string } }
  | { name: 'turn:failed'; payload: { turnId: string; error: string } }
  | { name: 'turn:aborted'; payload: { turnId: string } }

/**
 * v0.14.0 Task 4 §4.1：Turn 数据结构。
 * - id：Turn 唯一标识（genId('turn')）
 * - input：用户原始输入文本
 * - agentId：当前 Turn 路由到的内置 Agent（@general | @coding）
 * - phases：按顺序追加的 PhaseRecord（0~3 均会被追加）
 * - planItems：Turn 期间的 PlanItem 六态列表（与 Task 1 类型对齐）
 * - status：Turn 生命周期状态（与 §3.2.M2 对齐）
 * - startedAt / endedAt / abortSignal：生命周期时间戳与外部中止信号
 */
export interface Turn {
  id: string
  input: string
  agentId: '@general' | '@coding'
  phases: PhaseRecord[]
  planItems: PlanItem[]
  status: TurnStatus
  startedAt: number
  endedAt?: number
  abortSignal?: AbortSignal
}

/** 单个 Phase 的执行记录（Task 4 §4.1）。 */
export interface PhaseRecord {
  phase: PhaseId
  startedAt: number
  endedAt?: number
  summary: string
}

/** runTurn 的最终返回值（供上层判定结果与渲染）。 */
export interface TurnResult {
  turnId: string
  status: TurnStatus
  /** Phase 3 决策产物 — 仅 status='completed' 时存在。 */
  summary?: string
  /** Phase 1 路由产物 — Phase 1 完成后必填。 */
  plan?: PlanContent
  /** 任一 Phase 抛错时携带错误消息。 */
  error?: string
}
