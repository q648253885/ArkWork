/**
 * ArkWork — 待决事项的进程内注册表（pending registry）
 *
 * 依据：docs/versions/v0.30.0/04-system-design.md §5.1 / §6.4
 *
 * 为什么单独一个模块：需要被 **两方**读取，而这两方之间不能互相 import。
 *  - 写入方：`sync.ts` / `ipc/graph.ts`（Replan 补丁生成与决定）
 *  - 读取方：`store.ts` 的 `buildSnapshot`（面板要显示"计划需调整"通知条）
 *
 * 如果把注册表放进 `sync.ts`，`store.ts` 读它就会形成
 * `store → sync → store` 的循环依赖（本项目已因 ESM 循环吃过一次 TDZ 崩溃的亏，
 * 见缺陷 D1）。所以抽成这个**零依赖**的小模块。
 *
 * 生命周期：纯内存，重启即清空。
 * **为什么待决补丁不落盘**：它是"等待用户点按钮"的瞬时状态，不是任务规格。
 * 落盘会让每次 Replan 都产生一次 graph.json diff，污染审计流。
 * 代价是重启后待批准的补丁丢失 —— 可接受（重启本身就是一次人工干预，
 * Agent 下一轮会因 `buildPatch` 的 `CONFLICT` 检查重新生成）。
 */
import type { PlanApproval, ReplanPatch } from '@shared/types/graph'

/** graphId → 待决补丁列表（先进先出） */
const pendingPatches = new Map<string, ReplanPatch[]>()

/** 登记一个待用户决定的补丁 */
export function registerPendingPatch(graphId: string, patch: ReplanPatch): void {
  const list = pendingPatches.get(graphId) ?? []
  // 去重：同一 patchId 不重复登记
  if (!list.some((p) => p.id === patch.id)) list.push(patch)
  pendingPatches.set(graphId, list)
}

/** 读取某个图的全部待决补丁（面板按 createdAt 升序展示） */
export function listPendingPatches(graphId: string): ReplanPatch[] {
  return [...(pendingPatches.get(graphId) ?? [])].sort((a, b) => a.createdAt - b.createdAt)
}

/** 取单个待决补丁 */
export function getPendingPatch(graphId: string, patchId: string): ReplanPatch | undefined {
  return (pendingPatches.get(graphId) ?? []).find((p) => p.id === patchId)
}

/**
 * 结掉一个待决补丁（应用成功 / 被拒绝 / 回滚）。
 *
 * 注意：**不从列表里删除，只改 state** —— 面板需要短暂显示"已应用 3 项变更"
 * 的成功态；由前端在收到通知后自行忽略 `state !== 'pending'` 的项。
 * 真正的清理发生在 `dropGraphPending`（任务结束时）。
 */
export function markPatchDecided(
  graphId: string,
  patchId: string,
  state: ReplanPatch['state'],
  userNote?: string,
): void {
  const list = pendingPatches.get(graphId)
  if (!list) return
  const patch = list.find((p) => p.id === patchId)
  if (!patch) return
  patch.state = state
  patch.decidedAt = Date.now()
  if (userNote) patch.userNote = userNote
}

/** 清理某个图的全部待决状态（任务结束 / 删除时调用，防内存泄漏） */
export function dropGraphPending(graphId: string): void {
  pendingPatches.delete(graphId)
  for (const [taskId, plan] of pendingPlans) {
    if (plan.graphId === graphId) pendingPlans.delete(taskId)
  }
}

/** 仅测试用：清空 */
export function resetPendingPatches(): void {
  pendingPatches.clear()
  pendingPlans.clear()
}

/* ============================================================
 * 二、P8 · 计划闸门瞬时态（Plan Approval）
 *
 * 与 Replan 补丁同理：这是"等待用户点按钮"的瞬时状态，不落盘。
 * 与 Replan 注册表不同的一点：**以 taskId 为键**，因为 `request_plan` 阶段
 * 可能还没有图（Planner 正在建图），此时 graphId 缺省。
 * ============================================================ */

/** taskId → 计划闸门状态（一任务同时只有一个闸门） */
const pendingPlans = new Map<string, PlanApproval>()

/** 登记/覆盖一个任务的计划闸门状态（幂等：同任务只保留最新一条） */
export function registerPlanApproval(plan: PlanApproval): void {
  pendingPlans.set(plan.taskId, plan)
}

/** 读取某个任务的计划闸门状态（无则 undefined） */
export function getPlanApproval(taskId: string): PlanApproval | undefined {
  return pendingPlans.get(taskId)
}

/** 局部更新（如 generating → pending 时补齐 graphId / uncovered） */
export function updatePlanApproval(taskId: string, patch: Partial<PlanApproval>): PlanApproval | undefined {
  const cur = pendingPlans.get(taskId)
  if (!cur) return undefined
  const next = { ...cur, ...patch }
  pendingPlans.set(taskId, next)
  return next
}

/**
 * 结掉计划闸门（批准 / 打回）。
 *
 * 同 `markPatchDecided`：**不从表里删除**，只改 state —— 前端需要把卡片折叠成
 * 一行"✓ 计划已批准（4 项任务 · 4 条验收）"并保留在对话流。真正的清理发生在
 * `dropTaskPlanApproval`（任务结束）或重启。
 */
export function decidePlanApproval(
  taskId: string,
  state: PlanApproval['state'],
  userNote?: string,
): PlanApproval | undefined {
  const cur = pendingPlans.get(taskId)
  if (!cur) return undefined
  const next: PlanApproval = { ...cur, state, decidedAt: Date.now() }
  if (userNote) next.userNote = userNote
  pendingPlans.set(taskId, next)
  return next
}

/** 清理某个任务的计划闸门（任务结束 / 删除时调用） */
export function dropTaskPlanApproval(taskId: string): void {
  pendingPlans.delete(taskId)
}
