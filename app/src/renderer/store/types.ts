/* ============================================================
 * ArkWork — Renderer Store 类型层（v0.27.0 R3：自 store.ts 纯移动）
 * 视图类型 + AppState 单一接口；各 slice 以 Pick<AppState, …> 认领字段，
 * 组合处（index.ts）由 TS 结构化校验字段覆盖完整性。
 * ============================================================ */
import type {
  Agent,
  Skill,
  McpServer,
  LlmModel,
  DockTabId,
  DockPreset,
} from '@shared/types/agent'
import type { Task } from '@shared/types/task'
import type { ReActStep } from '@shared/types/react'
import type {
  TaskProgress,
  TaskProgressMilestone,
  TaskProgressStepStatus,
} from '@shared/types/progress'
import type { MemoryItem } from '@shared/types/memory'
import type {
  FsNode,
  LogEntry,
  TestModelRequest,
  TestModelResult,
  ThemeMode,
  ResolvedTheme,
  AgentAddInput,
  SkillAddInput,
  SkillUpdatePatch,
  McpAddInput,
  MarketSearchResult,
  SkillMetadata,
  MarketplaceSource,
  ToolConfirmRequest,
  ToolProgressEvent,
  TaskTextDeltaPayload,
  ConfirmRespondReason,
  Locale,
} from '@shared/types/ipc'
import type { PermissionMode, ResolvedRules } from '@shared/types/permission'
import type {
  ConversationItem,
  Automation,
  KnowledgeBase,
  PlanItemState,
  Suggestion,
} from '@shared/types/conversation'

export type Activity = 'tasks' | 'files' | 'memory' | 'skills' | 'automations' | 'kb'
/** v0.3.0 旧：右栏 Tab（保留兼容，实际不再使用） */
export type LeftView = 'tasks' | 'automations' | 'market' | 'agents' | 'kb' | 'settings'
export type RightTab = 'preview' | 'files' | 'memory'
export type PickerKind = 'agent' | 'skill' | 'mcp' | 'model'

/* ============================================================
 * v0.9.0 — 工作台重排：LeftNav（全局） × RightDock（任务上下文）
 * ============================================================ */

/** v0.9.0 F900：全局模块页（CenterStage 整页切换的模块管理页） */
/** redesign-workspace-navigation Task 3 + Task 4 接入：
 *  - 'settings'：作为 Center Stage 页面化的设置入口（替代旧 Modal），
 *    当前 Task 3 由 Sidebar 单击直达触发；Task 4 将在 ModulePage.tsx 中
 *    接入 Settings 五分区内容渲染。当前 ModuleBody 对 'settings' 返回
 *    占位引导，与 Task 4 工作面不冲突。 */
export type ModulePage = 'automations' | 'skills' | 'agents' | 'kb' | 'memory' | 'settings'

/** v0.11.0 F1102：设置弹窗 Tab（模型 / 工作区 / 知识库 / 外观 / 快捷键 / 高级）
 * Task 8：新增 'knowledge' Tab — 全局知识库开关（SettingsContent KnowledgeSection）。 */
// polish3 §Task 2.4：删除 shortcuts 成员（HelpCenter 内 ⌘? 唯一总表入口）
export type SettingsTab = 'models' | 'workspace' | 'knowledge' | 'appearance' | 'advanced'

/** fix-workspace-task-automation-memory Task 5 — Inspector 五固定 Tab。
 * 顺序固定为：清单 / 上下文 / 文件 / 日志 / 浏览器。独立的「工具」Tab 已并入上下文面板。
 * 默认 Tab 为「清单」(todos) —— 最普适且与对话内 Plan 卡同源。
 * v0.27.0 r10-F14a：补「终端」——TerminalPanel 原宿主 RightDock 自 v0.17 起无挂载点，
 * 组件成孤儿；纳入 Inspector 第 6 Tab 使 F14 输出查看器定位对用户可达。
 */
export type InspectorTabId = 'todos' | 'context' | 'files' | 'logs' | 'browser' | 'terminal'

export interface DockPrefs {
  tabs: DockTabId[]
  defaultTab: DockTabId
  /** 用户手动增删/排序/隐藏过 Tab 后置位——该智能体预设不再覆盖用户偏好 */
  customized: boolean
}
export type ModelHealth = 'unconfigured' | 'ok' | 'missing' | 'disabled'
export type RendererKind = 'markdown' | 'browser' | 'code' | 'image' | 'svg' | 'table' | 'fallback'

export interface PreviewTab {
  id: string
  target: { kind: 'file'; path: string } | { kind: 'url'; url: string }
  renderer: RendererKind
  mode: 'preview' | 'pinned'
  viewMode?: string
  scrollTop?: number
}

export interface PreviewWindowState {
  id: string
  bounds: { x: number; y: number; w: number; h: number }
  pinned: boolean
  tabs: PreviewTab[]
  activeTabId: string
}

export interface MinimizedCapsule {
  id: string
  title: string
  icon: string
  tabCount: number
}

/** 工作区类型 — 关联一个真实文件夹目录 */
export interface Workspace {
  id: string
  name: string
  /** 关联的文件夹绝对路径；default 工作区为空（使用内置目录） */
  path: string
  createdAt: number
}
export type ToastLevel = 'critical' | 'info' | 'silent'

export interface Toast {
  id: string
  type: 'success' | 'warning' | 'danger'
  /** Phase A Task 4：分级 — silent 不渲染 UI；critical 强制展示；info 默认行为 */
  level: ToastLevel
  message: string
  action?: { label: string; onClick: () => void }
  /** 自动消失时长（ms）；0 = 不自动消失（danger 默认） */
  duration: number
}

/** 上下文变更 chip（B4）— 对话流内可见的上下文操作痕迹 */
export interface CtxChip {
  id: string
  text: string
  ts: number
  variant: 'update' | 'compress'
}

/** ConfirmDialog 选项（B6） */
export interface ConfirmDialogOpts {
  title: string
  body: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  /** v0.28.0：默认焦点落在取消键上（高危二次确认防回车误启，如 bypassPermissions） */
  focusCancel?: boolean
}

/** ConfirmDialog 内部状态（含回调） */
export interface ConfirmDialogState extends Required<ConfirmDialogOpts> {
  open: boolean
  onConfirm: () => void
}
export interface AppState {
  // v0.7.0 布局：Activity Bar + SidePanel
  sidePanelWidth: number
  sidePanelCollapsed: boolean
  activeActivity: Activity
  setSidePanelWidth: (w: number) => void
  toggleSidePanel: () => void
  setActiveActivity: (a: Activity) => void
  /** 兼容旧代码：toggleLeft → toggleSidePanel */
  toggleLeft: () => void
  leftCollapsed: boolean
  leftWidth: number
  setLeftWidth: (w: number) => void
  /** v0.7.0：兼容旧代码的 rightCollapsed（始终 true，右栏已下线） */
  rightCollapsed: boolean
  rightWidth: number
  setRightWidth: (w: number) => void
  toggleRight: () => void
  openRight: (tab?: RightTab) => void
  closeRight: () => void

  // ============================================================
  // v0.9.0 F900 — LeftNav（全局导航）
  // ============================================================
  /** LeftNav 展开（240px） / 折叠（64px 图标栏） */
  leftNavCollapsed: boolean
  toggleLeftNav: () => void
  setLeftNavCollapsed: (b: boolean) => void

  // ============================================================
  // v0.9.0 F901 — RightDock（任务上下文 Dock）
  // ============================================================
  rightDockCollapsed: boolean
  rightDockWidth: number
  activeDockTab: DockTabId
  toggleRightDock: () => void
  setRightDockWidth: (w: number) => void
  setActiveDockTab: (t: DockTabId) => void
  /** 打开 Dock 并切到指定 Tab（Tab 不存在时忽略） */
  openDockTab: (t: DockTabId) => void
  /** 当前智能体的有效 Dock 布局（预设 × 用户偏好合并结果） */
  dockTabs: DockTabId[]
  dockDefaultTab: DockTabId
  /** 用户偏好（按 工作区 × 智能体 记忆，ui-state 持久化） */
  dockPrefs: Record<string, DockPrefs>
  setDockPrefs: (agentId: string, prefs: DockPrefs) => void
  resetDockPrefs: (agentId: string) => void
  /** 工作台布局提示条内容（智能体切换后一次性轻提示） */
  dockNotice: string | null
  setDockNotice: (msg: string | null) => void

  // ============================================================
  // fix-workspace-task-automation-memory Task 5 — Inspector（五固定 Tab，默认 Todos）
  // ============================================================
  /** Inspector 当前选中 Tab（固定 5 个之一：todos / context / files / logs / browser） */
  inspectorTab: InspectorTabId
  setInspectorTab: (t: InspectorTabId) => void
  /** v0.17.0 F13：可见 Tab 顺序（用户可拖动重排，持久化） */
  inspectorTabOrder: InspectorTabId[]
  /** v0.17.0 F13：被拖出隐藏的 Tab（收纳于工具栏底部「已隐藏」区） */
  hiddenInspectorTabs: InspectorTabId[]
  setInspectorTabOrder: (order: InspectorTabId[]) => void
  hideInspectorTab: (tab: InspectorTabId) => void
  restoreInspectorTab: (tab: InspectorTabId) => void

  // ============================================================
  // v0.9.0 F900 — 全局模块页（CenterStage 整页切换）
  // ============================================================
  modulePage: ModulePage | null
  openModulePage: (page: ModulePage) => void
  closeModulePage: () => void
  /** 模块页关闭后 RightDock 恢复到展开态（doc 01 §3.2：回任务时恢复） */
  prevRightDockOpen: boolean

  // v0.7.0 F710：PreviewWindow 浮窗
  previewWindow: PreviewWindowState | null
  minimizedPreviews: MinimizedCapsule[]
  openPreview: (path: string, opts?: { pinned?: boolean }) => Promise<void>
  openPreviewUrl: (url: string) => void
  closePreview: () => void
  togglePreviewPin: () => void
  minimizePreview: () => void
  restoreMinimized: (id: string) => void
  closePreviewTab: (tabId: string) => void
  setActivePreviewTab: (tabId: string) => void
  updatePreviewBounds: (bounds: PreviewWindowState['bounds']) => void

  // v0.7.0 F714：⌘P 快速打开
  quickOpenOpen: boolean
  setQuickOpenOpen: (b: boolean) => void

  // Task 14：HelpCenter 全局浮层（⌘? / ⌘/ 触发）
  helpOpen: boolean
  setHelpOpen: (b: boolean) => void
  toggleHelp: () => void

  // ---- 导航 ----
  leftView: LeftView
  setLeftView: (v: LeftView) => void
  rightTab: RightTab
  setRightTab: (t: RightTab) => void

  // ---- 数据加载状态 ----
  loading: boolean
  error: string | null

  // ---- v0.5.0 反馈系统（Toast / ConfirmDialog / CtxChip）----
  toasts: Toast[]
  pushToast: (t: Omit<Toast, 'id' | 'level'> & { level?: ToastLevel }) => string
  dismissToast: (id: string) => void
  confirmDialog: ConfirmDialogState
  confirm: (opts: ConfirmDialogOpts) => Promise<boolean>
  // v0.8.1：工具执行确认请求（Main → Renderer 浮层）
  pendingConfirm: ToolConfirmRequest | null
  respondConfirm: (requestId: string, allowed: boolean, session?: boolean, reason?: ConfirmRespondReason) => void
  ctxChips: CtxChip[]
  pushCtxChip: (chip: Omit<CtxChip, 'id' | 'ts'>) => void

  // ---- 任务 ----
  tasks: Task[]
  selectedTaskId: string | null
  selectedTask: Task | null
  // ---- v0.18.0：planItem Optimistic overlay ----
  /**
   * 用户手动切状态后尚未 ack 的状态覆盖。
   *  - key 1：taskId；key 2：planItemId
   *  - value：{ targetStatus, submittedTs, clientVersion? }
   * 渲染优先级：optimisticOverlay > task.planItems[i].status > 'pending'
   */
  optimisticOverlay: Record<string, Record<string, { targetStatus: import('@shared/types/task').PlanItemStatus; submittedTs: number; clientVersion?: number }>>
  /** v0.18.0：每 task 的 planListVersion（Main 端 patch/snapshot 同步推进） */
  planListVersion: Record<string, number>
  /** v0.18.0：用户在 TodoPanel 触发的动作（行级 inFlight 角标显示） */
  planItemInFlight: Record<string, Record<string, 'submitted' | 'rejected'>>
  /** v0.18.0：写入 Optimistic + 立即本地生效；返回 clientVersion 预测值（后续 reconcile 用） */
  markPlanItemOptimistic: (taskId: string, planItemId: string, targetStatus: import('@shared/types/task').PlanItemStatus) => number
  /** v0.18.0：Main 端 patch 回执 ack（删除 optimistic，角标消失） */
  commitPlanItemOptimistic: (taskId: string, planItemId: string) => void
  /** v0.18.0：Main 端拒绝回执（回滚 + 弹 Toast） */
  rejectPlanItemOptimistic: (taskId: string, planItemId: string, reason: string) => void
  /** v0.15.x：ask_user 暂停态展示的 Agent 问题全文（非 ask_user 暂停时为 null） */
  askUserQuestion: string | null
  /**
   * Task 4：建议优先的任务交互 — 当前对话末尾的建议卡片数据。
   * 来源：ask_user 事件附带的 suggestions / task_complete 后自动生成的下一步建议。
   * 用户点击建议 → 填入 Composer 输入框（通过 composer:fill 事件）；也可继续自由输入。
   */
  suggestions: Suggestion[]
  /** 设置建议列表（覆盖式） */
  setSuggestions: (suggestions: Suggestion[]) => void
  /** 清空建议列表 */
  clearSuggestions: () => void
  /** v0.27.1：ask_user 门禁双清（问题全文 + 建议卡片一次性清空） */
  clearAskUser: () => void
  selectTask: (id: string) => Promise<void>
  refreshTasks: () => Promise<void>
  createTask: (input: { title: string; text: string }) => Promise<Task | null>
  /** 在当前任务中追加用户消息并运行（续聊） */
  sendMessage: (text: string) => Promise<void>
  runTask: (id: string) => Promise<void>
  pauseTask: (id: string) => Promise<void>
  cancelTask: (id: string) => Promise<void>
  /** v0.5.0（B1）：恢复已暂停的任务 */
  resumeTask: (id: string) => Promise<void>
  /** v0.5.0（B3）：从指定 iteration 重新生成（v0.5.0 退化为整轮重跑） */
  regenerateMessage: (taskId: string, iteration: number) => Promise<void>
  /** v0.5.0（B3）：导出当前任务对话为 Markdown 文件（提取自 Composer） */
  exportConversation: () => void
  /** v0.3.1：删除任务（后端 deleteTask 已存在，补前端接入） */
  deleteTask: (id: string) => Promise<void>
  /** v0.3.1：切换收藏（后端 setTaskStarred 已存在） */
  toggleStar: (id: string) => Promise<void>
  /** v0.3.1：重命名任务（复用 updateTask） */
  renameTask: (id: string, title: string) => Promise<void>
  /** v0.8.0 F813：设置任务级知识库启用集合 */
  setTaskKbIds: (taskId: string, kbIds: string[]) => Promise<void>
  // Task 8：会话级 KB 开关（per-task persist）
  setTaskKbEnabled: (taskId: string, enabled: boolean) => Promise<void>

  // Task 8：全局 KB 开关（settings 持久化 + 内存同步）
  globalKbEnabled: boolean
  setGlobalKbEnabled: (enabled: boolean) => Promise<void>

  // ---- 自动化 / 知识库（模块视图）----
  automations: Automation[]
  knowledgeBases: KnowledgeBase[]
  // v0.6.4：自动化 CRUD
  refreshAutomations: () => Promise<void>
  createAutomation: (input: { name: string; agentId: string; prompt: string; trigger: 'manual' | 'cron'; cronExpr?: string; modelId?: string }) => Promise<boolean>
  updateAutomation: (id: string, patch: Partial<Automation>) => Promise<boolean>
  removeAutomation: (id: string) => Promise<void>
  toggleAutomation: (id: string, status: 'active' | 'paused') => Promise<void>
  runAutomation: (id: string) => Promise<boolean>
  // v0.6.4：知识库 CRUD
  refreshKnowledge: () => Promise<void>
  addKnowledge: (input: { name: string; path: string; type?: 'file' | 'folder'; size?: number }) => Promise<boolean>
  removeKnowledge: (id: string) => Promise<void>

  // ---- 工作区管理（前端管理 + localStorage 持久化）----
  workspaces: Workspace[]
  activeWorkspaceId: string
  createWorkspace: () => Promise<void>
  removeWorkspace: (id: string) => void
  switchWorkspace: (id: string) => Promise<void>

  // ---- Phase A Task 2：工作区确认会话级持久 ----
  /** taskId → 用户已确认过工作区；已确认则后续触发跳过弹窗 */
  workspaceConfirmedForTask: Record<string, boolean>
  /** 标记某任务已确认当前工作区 */
  confirmWorkspace: (taskId: string) => void
  /** 重置确认状态；'*' 表示全部清空（切换工作区 / 重置 artifacts 目录时调用） */
  resetWorkspaceConfirm: (taskId: string) => void

  // ---- Agents / Skills / Mcps / Models ----
  agents: Agent[]
  skills: Skill[]
  mcps: McpServer[]
  models: LlmModel[]
  refreshCatalog: () => Promise<void>
  addModel: (model: LlmModel) => Promise<void>
  updateModel: (model: LlmModel) => Promise<void>
  removeModel: (id: string) => Promise<void>
  testModel: (req: TestModelRequest) => Promise<TestModelResult>

  // ---- v0.6.0 Agent / Skill / Mcp CRUD ----
  // Agent 编辑器
  agentEditorOpen: boolean
  editingAgent: Agent | null  // null=新建，非 null=编辑
  openAgentEditor: (agent?: Agent | null) => void
  closeAgentEditor: () => void
  addAgent: (input: AgentAddInput) => Promise<Agent | null>
  updateAgent: (id: string, patch: Partial<AgentAddInput>) => Promise<Agent | null>
  removeAgent: (id: string) => Promise<boolean>

  // Skill 编辑器
  skillEditorOpen: boolean
  editingSkill: Skill | null  // null=新建，非 null=编辑
  openSkillEditor: (skill?: Skill | null) => void
  closeSkillEditor: () => void
  addSkill: (input: SkillAddInput) => Promise<Skill | null>
  updateSkill: (patch: SkillUpdatePatch) => Promise<Skill | null>
  removeSkill: (id: string) => Promise<boolean>
  toggleSkillEnabled: (id: string, enabled: boolean) => Promise<void>
  importSkill: (dirPath?: string) => Promise<Skill | null>
  exportSkill: (id: string, targetDir?: string) => Promise<{ path: string; isZip: boolean; fileCount: number } | null>
  readSkillInstruction: (id: string) => Promise<string | null>

  // Mcp 编辑器
  mcpEditorOpen: boolean
  editingMcp: McpServer | null
  openMcpEditor: (mcp?: McpServer | null) => void
  closeMcpEditor: () => void
  addMcp: (input: McpAddInput) => Promise<McpServer | null>
  updateMcp: (id: string, patch: Partial<McpAddInput>) => Promise<McpServer | null>
  removeMcp: (id: string) => Promise<boolean>
  connectMcp: (id: string) => Promise<boolean>
  disconnectMcp: (id: string) => Promise<void>

  // Skill 市场
  marketSkills: MarketSearchResult[]
  marketLoading: boolean
  marketHasMore: boolean
  marketTotal: number
  marketPage: number
  marketPageSize: number
  marketQuery: string
  marketTags: string[]
  searchMarket: (query?: string, tags?: string[], page?: number) => Promise<void>
  installMarketSkill: (skillId: string) => Promise<boolean>
  // v0.6.1：SkillHub CLI
  marketCli: { installed: boolean; path?: string; version?: string } | null
  checkMarketCli: () => Promise<void>
  installMarketCli: () => Promise<void>
  // v0.15.0：市场增强（四标签页 + 详情）
  marketInstalled: MarketSearchResult[]
  marketFavorites: MarketSearchResult[]
  marketSources: MarketplaceSource[]
  marketDetail: SkillMetadata | null
  marketDetailOpen: boolean
  listInstalledMarket: () => Promise<void>
  listMarketFavorites: () => Promise<void>
  uninstallMarketSkill: (skillId: string) => Promise<void>
  toggleMarketFavorite: (skillId: string, favorited: boolean) => Promise<void>
  refreshMarketSources: () => Promise<void>
  openMarketDetail: (skill: MarketSearchResult | SkillMetadata) => Promise<void>
  closeMarketDetail: () => void

  // ---- v0.15.0 权限模型 ----
  permissionMode: PermissionMode
  permissionRules: ResolvedRules | null
  getPermissionMode: () => Promise<void>
  setPermissionMode: (mode: PermissionMode) => Promise<void>
  refreshPermissionRules: () => Promise<void>
  addPermissionRule: (rule: string) => Promise<void>

  // ---- Pickers（Composer 中选择） ----
  selectedAgentId: string
  setSelectedAgent: (id: string) => void
  selectedSkillIds: string[]
  toggleSkill: (id: string) => void
  selectedMcpIds: string[]
  toggleMcp: (id: string) => void
  selectedModelId: string
  setSelectedModel: (id: string) => void
  openPicker: PickerKind | null
  setOpenPicker: (p: PickerKind | null) => void

  // ---- Command Palette ----
  cmdPaletteOpen: boolean
  setCmdPaletteOpen: (b: boolean) => void

  // ---- Memory ----
  memory: MemoryItem[]
  refreshMemory: (taskId: string) => Promise<void>
  toggleMemory: (taskId: string, id: string, enabled: boolean) => Promise<void>

  // ---- v0.15.x：真实 payload token 用量（system + messages + tools + memory injection） ----
  contextSize: {
    payloadTokens: number
    budget: number
    breakdown: {
      systemTokens: number
      messagesTokens: number
      toolsTokens: number
      memoryInjectionTokens?: number
    }
    modelContextWindow: number
    reportedAt: number
  } | null
  setContextSize: (size: AppState['contextSize']) => void
  /** v0.15.x：按需拉取任务真实 payload 估算（空闲/完成态也如实展示） */
  refreshContextSize: (taskId: string) => Promise<void>

  // ---- v0.23.1：当前任务的 LLM 前缀缓存命中统计（reason_end 事件累计） ----
  cacheUsage: {
    /** 命中缓存的输入 token 累计 */
    hitTokens: number
    /** 未命中缓存的输入 token 累计 */
    missTokens: number
    /** 是否收到过端点上报的缓存数据（false = 端点未报告，UI 不显示命中率） */
    reported: boolean
  } | null

  // ---- ReAct Trace ----
  steps: ReActStep[]
  refreshSteps: (taskId: string) => Promise<void>
  toggleStep: (id: string) => void
  appendStep: (step: ReActStep) => void
  updateStep: (step: ReActStep) => void

  // ---- v0.27.0 R1：流式文本增量缓冲（渲染加速通道，非数据源） ----
  /** key = `${taskId}:${scope}`；seq 为该流最新已收序号，text 为累计文本 */
  streamBuffers: Record<string, { seq: number; text: string }>
  /** 收到 task:text-delta 时调用；接受顺序续写（seq===cur+1）或重启（seq===1 截断），乱序丢弃 */
  applyTextDelta: (payload: TaskTextDeltaPayload) => void
  /** 权威内容落地后清除缓冲（scope 省略 = 清该 task 全部作用域） */
  clearStreamBuffer: (taskId: string, scope?: 'turn' | 'chat') => void

  // ---- v0.14.0 Task 4：按工具维度的并行 Act 进度（per-requestId 聚合） ----
  /** 当前任务在飞行的工具进度（按 requestId 索引） */
  toolProgress: Record<string, ToolProgressEvent>
  /** UI 上某 task 当前的活跃进度（用于面板/列表展示） */
  activeProgressByTask: Record<string, ToolProgressEvent[]>

  // ---- Task 9：任务侧边栏进度摘要（按 taskId 索引，独立持久化） ----
  taskProgress: Record<string, TaskProgress>
  /** 整体覆盖式写入（不触发派生计算；由 Main 推事件回流时直接调用） */
  setTaskProgress: (taskId: string, progress: TaskProgress) => void
  /** 局部更新：标记某 SubTask 完成（completed / failed） */
  updateTaskProgressStep: (taskId: string, stepId: string, status: TaskProgressStepStatus, label?: string) => void
  /** 局部更新：标记里程碑到达（含可选产物路径） */
  markTaskProgressMilestone: (taskId: string, milestoneId: string, artifactPath?: string) => void
  /** 局部更新：阶段切换（currentStage / overallPercentage） */
  setTaskProgressStage: (taskId: string, stage: string, overallPercentage: number, nextStepLabel?: string) => void
  /** getter：当前任务进度摘要（无则返回 undefined） */
  getTaskProgress: (taskId: string) => TaskProgress | undefined
  /** 应用启动时从主进程缓存恢复全部进度（避免页面切换 / 重启后丢失） */
  refreshTaskProgress: () => Promise<void>

  /** 派生：当前任务的对话流 */
  conversation: ConversationItem[]

  // ---- 文件树 ----
  files: FsNode[]
  selectedFile: string | null
  selectedFileContent: string | null
  selectedFileLanguage: string
  setSelectedFile: (path: string | null) => Promise<void>
  refreshFiles: (taskId?: string) => Promise<void>

  // ---- Logs ----
  logs: LogEntry[]
  appendLog: (entry: LogEntry) => void
  refreshLogs: (taskId?: string) => Promise<void>

  // ---- Settings ----
  settingsOpen: boolean
  setSettingsOpen: (b: boolean) => void
  /** v0.11.0 F1102：设置弹窗 Tab（模型 / 工作区 / 外观 / 快捷键 / 高级） */
  settingsTab: SettingsTab
  setSettingsTab: (t: SettingsTab) => void

  // ---- 主题（v0.4.0） ----
  /** 用户选择的主题模式（'light' | 'dark' | 'system'） */
  theme: ThemeMode
  /** 系统当前实际主题（'system' 模式下用于解析 <html class="dark">） */
  systemTheme: ResolvedTheme
  /** 'system' 解析后的实际主题（dark 或 light），渲染层用它决定 <html class> */
  resolvedTheme: ResolvedTheme
  /** 切换主题并持久化（settings.json + localStorage + 原生界面） */
  setTheme: (t: ThemeMode) => Promise<void>
  /** 状态栏快捷循环：light → dark → system → light */
  cycleTheme: () => Promise<void>

  // ---- 界面语言（v0.29.0） ----
  /** 当前界面语言（首帧取 localStorage 预读，settings.json 由 init() 决策流校正） */
  language: Locale
  /** 切换界面语言并持久化（i18next + 文档属性 + localStorage + settings.json） */
  setLanguage: (l: Locale) => Promise<void>

  // ---- 初始化 ----
  init: () => Promise<void>

  // ---- 事件订阅 ----
  subscribeAll: () => () => void
}
