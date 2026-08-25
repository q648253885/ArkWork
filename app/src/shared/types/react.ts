/* ============================================================
 * ArkWork — Shared Types: ReAct Step
 * 设计文档 §6.2 / §10.2
 * ============================================================ */

/** v0.7.0：新增 'plan' 类型（iteration 0 决策前置） */
export type ReActStepType = 'plan' | 'reason' | 'act' | 'observation'
export type ReActStepStatus = 'success' | 'failed' | 'cancelled' | 'running'

/** v0.7.0 F742：PlanStep 决策前置 — 计划步负载 */
export interface PlanContent {
  goal: string
  items: string[]
  useResources: Array<{ kind: 'skill' | 'kb' | 'expert'; id: string }>
  skipResources: Array<{ kind: 'skill' | 'kb'; id: string; reason: string }>
}

/** LLM 输出的 action 解析结果 */
export interface ReActAction {
  tool: string
  args: Record<string, unknown>
}

export interface ReActStep {
  id: string
  taskId: string
  iteration: number
  type: ReActStepType

  // for reason
  thought?: string
  /** v0.25.0 F4：给用户看的阶段叙述（结论 + 下一步），由模型在 reason 阶段产出；
   * 与 thought（内部思考，默认折叠）分离；缺省时 UI 回落旧版「要做什么」hint */
  say?: string
  action?: ReActAction

  // for act
  toolName?: string
  toolArgs?: string                // 序列化后的 args 字符串
  /** v0.21.0：人类可读的动作意图描述（如「执行命令：npm test」），交互区简介展示 */
  intent?: string
  /** v0.29.0 F5：动作意图 i18n 键与插值参数（展示层翻译；缺省回落 intent 原文兼容历史记录） */
  intentKey?: string
  intentParams?: Record<string, string>
  result?: unknown
  resultSummary?: string

  // for observation
  summary?: string
  rawL2Path?: string               // 大结果落 L2 的路径

  // v0.7.0：plan 步骤负载
  plan?: PlanContent

  // common
  startedAt: number
  durationMs: number
  tokensIn?: number
  tokensOut?: number
  /** v0.20.0：本轮输入命中缓存的 token 数（厂商未返回时为 undefined） */
  cacheHitTokens?: number
  /** v0.20.0：本轮输入未命中缓存的 token 数 */
  cacheMissTokens?: number
  status: ReActStepStatus
  errorMessage?: string

  /** v0.18.x：软失败标记 —— 内部机制/门禁拦截（阶段守卫、参数校验、预算上限等），
   * 属于大模型与 Agent 的正常交互，交互区应中性显示而非红色报错。 */
  softFail?: boolean

  /** UI 折叠状态 */
  expanded?: boolean
}

/** ReAct 引擎通过 AsyncGenerator 产出的事件流 */
export type ReActEvent =
  | { type: 'task_started'; taskId: string; iteration: 0 }
  | { type: 'reason_start'; iteration: number }
  | {
      type: 'reason_end'
      iteration: number
      thought: string
      action: ReActAction | null
      tokensIn?: number
      tokensOut?: number
      /** v0.20.0：本轮输入命中缓存的 token 数 */
      cacheHitTokens?: number
      /** v0.20.0：本轮输入未命中缓存的 token 数 */
      cacheMissTokens?: number
      durationMs: number
      /** v0.25.0 F4：阶段叙述（结论 + 下一步），与 thought 分离；模型未输出时为 undefined */
      say?: string
    }
  | { type: 'act_start'; iteration: number; tool: string; args: Record<string, unknown> }
  | {
      type: 'act_end'
      iteration: number
      result: unknown
      resultSummary: string
      durationMs: number
      ok: boolean
      errorMessage?: string
      /** v0.19.x：软失败（门禁/预算拦截）—— 日志按 WARN 橙色而非 ERROR 红色 */
      softFail?: boolean
    }
  | { type: 'observation'; iteration: number; summary: string; rawL2Path?: string }
  | {
      type: 'task_complete'
      iteration: number
      summary: string
      // v0.15.0 Task 7：Agent 完成任务时可附带建议下一步，由 LLM 自行生成（不再硬编码映射）。
      // 缺省 / undefined / 空数组 → 前端不渲染 SuggestionCards
      suggestions?: Array<{ label: string; description?: string; recommended?: boolean }>
    }
  | {
      type: 'ask_user'
      iteration: number
      question: string
      /** Task 4：Agent 附带的建议选项（可选）；前端收到后渲染 SuggestionCards */
      suggestions?: Array<{ label: string; description?: string; recommended?: boolean }>
    }
  | { type: 'task_failed'; iteration: number; error: string }
  | { type: 'task_paused'; iteration: number }
  | { type: 'max_iterations_reached'; iteration: number }
  | { type: 'log'; level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'; source: string; message: string }
  // v0.7.0 F742/F743：计划步事件
  | { type: 'plan_start'; taskId: string }
  | { type: 'plan_end'; taskId: string; plan: PlanContent; durationMs: number }
  | { type: 'plan_adjusted'; taskId: string; note: string }
  // v0.8.0 记忆系统事件（对话流内联卡片，诚实 UI）
  | {
      type: 'memory_compressed'
      iteration: number
      beforeTokens: number
      afterTokens: number
      archivedCount: number
      summaryId: string
      auto: boolean
    }
  // agent-context-compaction-robustness：每轮调用前的上下文预算压缩事件（Layer 2）
  | {
      type: 'context_compacted'
      iteration: number
      layer: 1 | 2 | 3
      beforeTokens: number
      afterTokens: number
      archivedCount: number
    }
  | {
      type: 'profile_updated'
      iteration: number
      version: number
      newObservations: number
    }
  | {
      type: 'distill_completed'
      iteration: number
      /** v0.9.1：携带任务 id，渲染层据此把完成提示挂到正确任务 */
      taskId: string
      category: 'facts' | 'skill' | 'observations'
      /** 蒸馏完成后的轻量提示文案（如"已自动合并到知识库"） */
      message: string
    }
  // v0.15.x：每轮 LLM 调用前报告真实 payload token 用量（system + messages + tools + memory injection）
  | {
      type: 'context_size_report'
      taskId: string
      iteration: number
      payloadTokens: number
      budget: number
      systemTokens: number
      messagesTokens: number
      toolsTokens: number
      memoryInjectionTokens?: number
      modelContextWindow: number
    }
  // Task 9：进度摘要事件（侧边栏 ProgressPanel 专用）
  // - task_progress：阶段级进度（currentStage / overallPercentage / nextStep）
  // - task_step_complete：SubTask（ReAct 步 / 必产文档子步骤）完成
  // - task_milestone：里程碑节点到达（如 PRD 已确认冻结 / HTML 原型已确认 / 编码完成）
  | { type: 'task_progress'; taskId: string; currentStage: string; stageIndex: number; overallPercentage: number; nextStepId?: string; nextStepLabel?: string }
  | {
      type: 'task_step_complete'
      taskId: string
      stepId: string
      label: string
      stage: string
      ok: boolean
      durationMs: number
    }
  | {
      type: 'task_milestone'
      taskId: string
      milestoneId: string
      label: string
      reachedAt: number
      artifactPath?: string
    }
