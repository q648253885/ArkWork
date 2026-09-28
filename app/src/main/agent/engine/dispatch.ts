/**
 * v0.27.0 R2（§3.1 引擎拆分）：入口分发：chat / task 双通道路由与回合驱动
 * 由 engine.ts 纯移动而来（行区间 3571-3743）。
 */

import {
  type Agent,
  getAdapter,
  completeWithStream,
  createTextDeltaPump,
  type TextDeltaPump,
  broadcastTextDelta,
  logger,
} from './engine-context.js'
import { classifyRoute } from '../../router/classify-route.js'
import type { TurnResult } from '../../engine/types.js'

/* ============================================================
 * v0.14.0 Task 4 §4.5 — chat/task 入口分流 wrapper
 *
 * ★ v0.36.0（B9）保留声明：本文件**保留**，但已收缩为真正的「薄层」。
 *
 * 设计意图（本版修订后）：
 *   - 保持既有 `runReActLoop` 主体一字不动；`runner.runTask` 链路（task:run IPC
 *     → runTask → runReActLoop）是**唯一**生产路径，零调用方改动
 *   - `dispatchChatOrTask` 是可选的 chat/task 分流薄层；chat 命中时走单次
 *     LLM 补全（`runChatOnce`），task 命中时**转发**给既有 task 路径
 *
 * 本版删掉的东西与理由（缺陷 D102 形态：函数全对、调用点缺失）：
 *   - `runTurnForTask` —— 它把 Task 包成 Turn 交给 `engine/phase-runner.ts` 执行，
 *     而那个执行器是**最小骨架**（`invokeSkill`/`faultTolerant` 是 stub、
 *     `deriveSkillIdFromPlanItem` 硬编码返回 `'file-reader'`），且**无生产调用点**。
 *     骨架执行器已删（B9 死代码清理），本函数随之删除。
 *   - **保留** `main/engine/types.ts` 的 Turn 类型骨架（`Turn`/`TurnResult`/
 *     `PhaseRecord`/`PhaseId`/`TurnStatus`/`TurnEvent`）—— ① `main/memory/
 *     compaction-hook.ts` 仍在消费 `Turn`；② 后续子 agent / Turn 化重构要复用它。
 *     删的是**执行器**，不是**模型**。
 *
 * 约束：
 *   - 不删除/重写 runReActLoop 主体
 *   - chat 路径不创建 Task
 * ============================================================ */
// Agent 类型已在文件顶部 import 复用（避免重复导入触发 TS2300）

/** v0.14.0 Task 4 §4.5 — chat/task 分流判定结果。 */
export type ChatOrTask = 'chat' | 'task'

/**
 * chat 路径单次补全：直接调 LLM 处理用户输入，不进入 runTurn / ReAct 循环。
 * 内部仍复用 `getAdapter` + `assembleMessages`（仅 system + L1），不做工具调用。
 *
 * Returns the assistant reply text. 调用方负责把 user/reply 写入 L1（与既有 chat 流一致）。
 */
export async function runChatOnce(
  input: string,
  opts: { modelId: string; agent?: Agent; signal?: AbortSignal; taskId?: string },
): Promise<string> {
  const adapter = await getAdapter(opts.modelId)
  const systemPrompt = opts.agent?.systemPrompt ?? ''
  const t0 = Date.now()
  // v0.27.0 R1：携带 taskId 时开启流式增量推送（scope='chat'，渲染加速通道）；
  // 完整回复仍以本函数返回值为唯一数据源。
  // holder 对象绕过 TS 闭包赋值窄化（let 变量会被收窄为 never）。
  const pumpRef: { current: TextDeltaPump | null } = { current: null }
  const response = await completeWithStream(
    adapter,
    {
      system: systemPrompt,
      messages: [{ role: 'user', content: input }],
      // chat 路径固定不挂工具；forceChat 流与现有 sendMessage 旧路径行为一致
      tools: undefined,
      signal: opts.signal,
    },
    {
      onText: (delta) => {
        if (!opts.taskId) return
        if (!pumpRef.current) {
          pumpRef.current = createTextDeltaPump(opts.taskId, 'chat', 'text', broadcastTextDelta)
        }
        pumpRef.current.push(delta)
      },
    },
  )
  pumpRef.current?.flush()
  logger.info(
    'LLM',
    `chat once (${opts.modelId}) ← ${response.tokensIn}+${response.tokensOut} tokens ⏱ ${Date.now() - t0}ms`,
  )
  return response.thought ?? response.content ?? ''
}

/* ★ v0.36.0（B9）：此处原为 `runTurnForTask(task, opts)` —— 已删除。
 * 它把 Task 包成 Turn 交给 `engine/phase-runner.ts` 的骨架执行器，而该执行器
 * 无生产调用点（缺陷 D102 形态：函数全对、接线缺失），已随死代码清理一并删除。
 * 保留记录以免后来者「补回来」：若要重启 Turn 化执行，请先补齐真实
 * Phase 0~3 执行器与调用点，而不是恢复这个 stub 包装。 */

/**
 * v0.14.0 Task 4 §4.5 — chat/task 分流 dispatcher。
 *
 * 行为：
 *   - chat kind  → runChatOnce（不创建 Task，仅一次 LLM 补全；renderer 把回复渲染为气泡）
 *   - task kind  → 复用既有 task:run IPC 路径（runReActLoop），保持 runTask 主体不变
 *
 * 不删除/重写既有 runTask 主体；本函数仅作为上层 Composer / 入口处的可选分流薄层。
 */
export async function dispatchChatOrTask(
  text: string,
  ctx: {
    /** 既有 task id（task 路径必填；chat 路径可空） */
    taskId?: string
    modelId: string
    agent?: Agent
    signal?: AbortSignal
    /** 手动覆盖 kind — 提供则直接采用，跳过 classifyRoute */
    forcedKind?: ChatOrTask
  },
): Promise<{ kind: ChatOrTask; reply?: string; turnResult?: TurnResult }> {
  const kind: ChatOrTask =
    ctx.forcedKind ??
    classifyRoute(text, { hasTools: false, lastTurnKind: undefined }).kind

  if (kind === 'chat') {
    const reply = await runChatOnce(text, {
      modelId: ctx.modelId,
      agent: ctx.agent,
      signal: ctx.signal,
      // v0.27.0 R1：透传 taskId → chat 回复同样走流式增量渲染
      taskId: ctx.taskId,
    })
    return { kind: 'chat', reply }
  }

  // task kind：转发给既有 task 路径（保持 runReActLoop 不变）
  if (!ctx.taskId) {
    throw new Error('dispatchChatOrTask: ctx.taskId required for task kind')
  }
  // 用动态 import 避免循环依赖（engine ↔ runner）
  const { runTask } = await import('../runner.js')
  await runTask(ctx.taskId)
  return { kind: 'task' }
}
