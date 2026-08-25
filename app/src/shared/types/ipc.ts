/* ============================================================
 * ArkWork — Shared Types: IPC Channels
 * 设计文档 §8.4
 * ============================================================ */
import type { Task, TaskInput, TaskConfig, TaskStatus, PlanItem, PlanItemStatus, PlanItemSource } from './task'
import type { ReActEvent, ReActStep } from './react'
import type { TaskProgress } from './progress'
import type {
  MemoryItem,
  MemoryTogglePatch,
  MemoryEditPatch,
  CompressOpts,
  CompressResult,
  PendingEntry,
  UserProfile,
  ArchiveHit,
  CuratedSnapshot,
  ConvertSource,
  ConvertToSkillResult,
  ConvertToKbResult,
  L2Memory,
} from './memory'
import type { Agent, Skill, McpServer, LlmModel, LlmProviderKind, SkillSource } from './agent'
import type { Automation, KnowledgeBase } from './conversation'
import type { PermissionMode, ResolvedRules, PermissionDecision } from './permission'

/** IPC 通道命名约定：{domain}:{action} */

/** v0.8.1：工具执行确认请求（Main → Renderer 推送，美观浮层展示） */
export interface ToolConfirmRequest {
  requestId: string
  /** 工具显示名（如「运行命令」） */
  skillName: string
  /** 要执行的命令原文（shell 场景） */
  command?: string
  /** 命令执行目录（shell 场景，一般为工作区根目录） */
  cwd?: string
  /** 人类可读的影响说明列表 */
  impacts: string[]
  /** 风险评估：low / medium / high */
  risk: 'low' | 'medium' | 'high'
  /** 其他工具的参数摘要（非 shell 场景） */
  argsSummary?: string
  taskId?: string
}

/**
 * v0.14.0 Task 6：确认回传原因。
 *  - 'allowed' → 用户点击「允许执行」
 *  - 'denied' → 用户显式点击「拒绝」（唯一的「用户拒绝」来源）
 *  - 'dismissed' → Esc / 点击背景关闭对话框（不是拒绝）
 */
export type ConfirmRespondReason = 'allowed' | 'denied' | 'dismissed'

/* ---- task ---- */
export const TaskChannel = {
  List: 'task:list',
  Get: 'task:get',
  Create: 'task:create',
  Update: 'task:update',
  Delete: 'task:delete',
  Run: 'task:run',
  Pause: 'task:pause',
  Resume: 'task:resume',
  Cancel: 'task:cancel',
  Step: 'task:step',           // Main → Renderer 推送 ReAct 步骤
  // v0.27.0 R1：流式文本增量（Main → Renderer 推送；渲染加速通道，非数据源）
  TextDelta: 'task:text-delta',
  // v0.14.0 Task 4：按工具维度的进度聚合（per-requestId）
  Progress: 'task:progress',
  ProgressClear: 'task:progress:clear',
} as const

/** v0.27.0 R1：流式文本增量负载（task:text-delta 通道；seq 单调递增，乱序由 Renderer 丢弃） */
export interface TaskTextDeltaPayload {
  taskId: string
  /** turn = ReAct 主循环 Reason 阶段；chat = runChatOnce 快速回复 */
  scope: 'turn' | 'chat'
  seq: number
  /** 相对上一批次的增量文本（非全量） */
  text: string
}

/** v0.14.0 Task 4：单条工具调用进度（Main → Renderer 推送） */
export interface ToolProgressEvent {
  taskId: string
  /** 同一轮 Reason 共享一个 groupId，便于一次性清理 */
  groupId: string
  requestId: string
  tool: string
  status: 'running' | 'success' | 'failed' | 'cancelled'
  startedAt: number
  finishedAt?: number
  durationMs?: number
  errorMessage?: string
  resultSummary?: string
}

/** 进度清理事件：UI 据此把对应 requestId/groupId 移出渲染队列 */
export interface ToolProgressClearEvent {
  taskId: string
  groupId?: string
}

export interface TaskCreateInput {
  title: string
  text: string
  agentId: string
  skillIds?: string[]
  mcpIds?: string[]
  modelId?: string
  config?: TaskConfig
}

export interface TaskUpdatePatch {
  id: string
  title?: string
  status?: TaskStatus
  agentId?: string
  skillIds?: string[]
  mcpIds?: string[]
  modelId?: string
  config?: TaskConfig
  starred?: boolean
  /** v0.8.0：任务级知识库启用列表 */
  kbIds?: string[]
  /** Task 8：会话级知识库开关 */
  kbEnabled?: boolean
}

/* ---- permission ---- */
/**
 * v0.15.0：权限模型 IPC
 * - getMode / setMode：会话级 PermissionMode 切换
 * - resolveRules：返回四级配置合并后的最终规则（供 UI 调试展示）
 */
export const PermissionChannel = {
  GetMode: 'permission:getMode',
  SetMode: 'permission:setMode',
  ResolveRules: 'permission:resolveRules',
  AddRule: 'permission:addRule',
} as const

export interface PermissionModeEvent {
  taskId?: string
  mode: PermissionMode
}

/* ---- agent / skill / mcp / model ---- */
/**
 * v0.6.0：Agent CRUD（F3）— 新增 add/update/remove 通道
 * 约束：isBuiltin=true 的 agent，update 仅允许改非人格字段，remove 直接抛错。
 */
export const AgentChannel = {
  List: 'agent:list',
  Get: 'agent:get',
  Add: 'agent:add',
  Update: 'agent:update',
  Remove: 'agent:remove',
  ManualOverride: 'agent:manual-override',
} as const

/** Agent 新建输入 — id 与 isBuiltin/version 由后端生成 */
export type AgentAddInput = Omit<Agent, 'id' | 'isBuiltin' | 'version'> & { id?: string }

/**
 * v0.6.0：Skill CRUD（F4/F7）— 新增 add/update/remove/toggle/import/export 通道
 * Skill 持久化为文件夹结构，CRUD 操作后失效 registry 内存缓存。
 */
export const SkillChannel = {
  List: 'skill:list',
  Add: 'skill:add',
  Update: 'skill:update',
  Remove: 'skill:remove',
  Toggle: 'skill:toggle',
  Import: 'skill:import',
  Export: 'skill:export',
  ReadInstruction: 'skill:read-instruction',
} as const

/** Skill 新建输入 — id 由后端生成 */
export type SkillAddInput = Omit<Skill, 'id'> & { id?: string; instructionMdContent?: string }

export interface SkillUpdatePatch {
  id: string
  patch: Partial<Skill>
  instructionMdContent?: string  // 若提供则覆写 SKILL.md
}

/**
 * v0.16.5：Skill 导出结果。
 * - 单内容技能 → { isZip: false, path: <目录>, fileCount }
 * - 多内容技能 → { isZip: true, path: <zip 文件>, fileCount }
 */
export interface SkillExportResult {
  path: string
  isZip: boolean
  fileCount: number
}

/**
 * v0.6.0：MCP Server 管理（F8）— 新增 add/update/remove/connect/disconnect/callTool 通道
 * transport 仅支持 stdio（本期范围）
 */
export const McpChannel = {
  List: 'mcp:list',
  Add: 'mcp:add',
  Update: 'mcp:update',
  Remove: 'mcp:remove',
  Connect: 'mcp:connect',
  Disconnect: 'mcp:disconnect',
  CallTool: 'mcp:call-tool',
  Toggle: 'mcp:toggle',  // 兼容旧版（等价于 update enabled）
} as const

/** MCP Server 新建输入 — id/status/toolCount/tools 由后端生成 */
export type McpAddInput = Omit<McpServer, 'id' | 'status' | 'toolCount' | 'tools'> & { id?: string }

/**
 * v0.6.0：Skill 市场（F10）— search/install 通道
 * v0.15.0：扩展为四标签页市场，支持服务端搜索、分类、分页、排序、详情、评价、收藏。
 */
export const MarketChannel = {
  Search: 'market:search',
  Install: 'market:install',
  Uninstall: 'market:uninstall',
  Detail: 'market:detail',
  Review: 'market:review',
  ToggleFavorite: 'market:toggle-favorite',
  ListSources: 'market:list-sources',
  // 兼容旧入口
  ListInstalled: 'market:list-installed',
} as const

/** v0.15.0：技能市场 6 大分类 */
export type SkillCategory = 'coding' | 'document' | 'data' | 'automation' | 'integration' | 'other'

/** v0.15.0：SkillHub 服务端技能元数据 */
export interface SkillMetadata {
  id: string
  /** 技能名（小写连字符） */
  name: string
  /** 显示名 */
  displayName: string
  /** 简短描述（≤ 200 字） */
  description: string
  /** HTML 描述（搜索高亮用 <mark>） */
  descriptionHtml?: string
  category: SkillCategory
  tags: string[]
  version: string
  author: { name: string; email?: string; url?: string }
  homepage?: string
  repository?: string
  license?: string
  /** 搜索关键词 */
  keywords: string[]
  /** 累计下载 */
  downloads: number
  /** 平均评分 0-5 */
  rating: number
  /** 评分数 */
  ratingCount: number
  createdAt: string
  updatedAt: string
  /** 上下文成本估算 */
  contextCostEstimate: {
    baseline: number
    active: number
    perTurn: number
  }
  /** 兼容性矩阵 */
  compatibility: {
    minArkWorkVersion: string
    os: ('macos' | 'linux' | 'windows')[]
    dependencies: string[]
  }
  /** 来源 */
  source: SkillSource
  /** 是否精选 */
  featured: boolean
  /** 是否已废弃 */
  deprecated: boolean
  /** 本地是否已安装 */
  installed?: boolean
  /** 本地是否已收藏 */
  favorited?: boolean
}

/** v0.15.0：技能评价 */
export interface SkillReview {
  id: string
  skillId: string
  userId: string
  userName: string
  /** 1-5 星 */
  rating: number
  /** ≤ 500 字 */
  comment?: string
  createdAt: string
  updatedAt: string
}

/** v0.15.0：市场源 */
export interface MarketplaceSource {
  id: string
  /** 源名称 */
  name: string
  /** 源类型 */
  type: 'skillhub' | 'github' | 'local' | 'url'
  /** 端点或路径 */
  url: string
  /** 是否启用 */
  enabled: boolean
  /** 是否自动更新 */
  autoUpdate: boolean
}

/** v0.15.0：市场本地持久化状态 */
export interface MarketLocalState {
  installed: Record<string, {
    version: string
    installedAt: string
    source: string
    enabled: boolean
    lastUsedAt?: string | null
    useCount: number
  }>
  favorites: string[]
  recentSearches: string[]
  marketplaces: MarketplaceSource[]
}

/** v0.15.0：市场搜索参数 */
export interface MarketSearchParams {
  query?: string
  categories?: SkillCategory[]
  tags?: string[]
  /** 默认 relevance（搜索时）/ downloads（浏览时） */
  sort?: 'relevance' | 'downloads' | 'rating' | 'updatedAt' | 'createdAt' | 'name'
  cursor?: string | null
  pageSize?: number
  featured?: boolean
}

/** v0.15.0：市场搜索结果（兼容 v0.6.x 旧字段） */
export interface MarketSearchResult {
  id: string
  name: string
  description: string
  tags: string[]
  source: 'builtin' | 'community'
  installed: boolean
  /** v0.6.4：下载量（SkillHub），用于详情展示 */
  downloads?: number
  /** v0.6.4：slug（SkillHub），用于详情查询 */
  slug?: string
  /** v0.15.0：完整元数据（发现/详情页使用） */
  metadata?: SkillMetadata
  /** v0.15.0：服务端返回的命中总数 */
  total?: number
  /** v0.15.0：下一页游标 */
  nextCursor?: string | null
  /** v0.15.0：是否还有更多 */
  hasMore?: boolean
}

export const ModelChannel = {
  List: 'model:list',
  Add: 'model:add',
  Update: 'model:update',
  Remove: 'model:remove',
  Test: 'model:test',
} as const

/* ---- automation / knowledge base ---- */
/**
 * 自动化（Automations）— 触发器驱动的 Agent 自动执行
 * trigger='manual' 由用户手动触发 run；trigger='cron' 由 cronExpr 定时触发（v1 仅持久化表达式，调度留待后续）
 */
export const AutomationChannel = {
  List: 'automation:list',
  Create: 'automation:create',
  Update: 'automation:update',
  Remove: 'automation:remove',
  Run: 'automation:run',
} as const

/** Automation 新建输入 — id / createdAt / lastRun 由后端生成；status 默认 'active' */
export type AutomationCreateInput = Omit<Automation, 'id' | 'createdAt' | 'lastRun' | 'status'> & {
  id?: string
  status?: 'active' | 'paused'
}

export interface AutomationUpdatePatch {
  id: string
  patch: Partial<Automation>
}

/**
 * 知识库（Knowledge Base）— 文件/文件夹索引
 * v1 仅记录路径元数据，向量化检索留待后续版本。
 */
export const KbChannel = {
  List: 'kb:list',
  Add: 'kb:add',
  Remove: 'kb:remove',
  // v0.8.0 F810/F811：导入（带解析进度）/ 重命名 / 重导入 / 检索 / 开关
  Import: 'kb:import',
  Rename: 'kb:rename',
  Reimport: 'kb:reimport',
  Search: 'kb:search',
  SetEnabled: 'kb:set-enabled',
  ImportProgress: 'kb:import-progress',  // Main → Renderer 推送进度
  Changed: 'kb:changed',  // Main → Renderer 推送清单变更
} as const

/** KnowledgeBase 新建输入 — id / addedAt 由后端生成；type/size 可选（后端用 fs.stat 推断） */
export type KbAddInput = Omit<KnowledgeBase, 'id' | 'addedAt' | 'type' | 'size'> & {
  id?: string
  type?: 'file' | 'folder'
  size?: number
}

/** v0.8.0 导入进度（Main → Renderer 推送） */
export interface KbImportProgress {
  name: string
  status: 'parsing' | 'indexing' | 'done' | 'failed'
  chunks?: number
  error?: string
}

/** v0.8.0 检索命中（IPC 返回） */
export interface KbSearchResult {
  hits: Array<{
    chunkId: string
    kbId: string
    kbName: string
    seq: number
    text: string
    score: number
  }>
  total: number
}

/* ---- memory ---- */
export const MemoryChannel = {
  List: 'memory:list',
  Toggle: 'memory:toggle',
  Edit: 'memory:edit',
  Archive: 'memory:archive',
  Compress: 'memory:compress',
  Clear: 'memory:clear',
  Changed: 'memory:changed',  // Main → Renderer 推送变更
  // v0.8.0 L3a 策展记忆
  L3Get: 'memory:l3-get',
  L3Update: 'memory:l3-update',
  L3PendingList: 'memory:l3-pending-list',
  L3PendingApply: 'memory:l3-pending-apply',
  L3PendingDiscard: 'memory:l3-pending-discard',
  // v0.8.0 L4a 用户画像
  L4Get: 'memory:l4-get',
  L4UpdateSynthesis: 'memory:l4-update-synthesis',
  L4DeleteObservation: 'memory:l4-delete-observation',
  L4Rollback: 'memory:l4-rollback',
  // v0.8.0 蒸馏与转化
  DistillAccept: 'memory:distill-accept',
  DistillDismiss: 'memory:distill-dismiss',
  ConvertToSkill: 'memory:convert-to-skill',
  ConvertToKb: 'memory:convert-to-kb',
  // v0.8.0 L3b 档案检索
  ArchiveSearch: 'memory:archive-search',
  // v0.16 Task 7：L2 压缩记忆管理
  L2List: 'memory:l2-list',
  L2Detail: 'memory:l2-detail',
  L2Delete: 'memory:l2-delete',
  L2Merge: 'memory:l2-merge',
  L2Export: 'memory:l2-export',
} as const

/** v0.15.x：按需上下文估算结果（与 context_size_report 事件同口径） */
export interface ContextEstimateResult {
  taskId: string
  payloadTokens: number
  budget: number
  breakdown: {
    systemTokens: number
    messagesTokens: number
    toolsTokens: number
    memoryInjectionTokens?: number
  }
  modelContextWindow: number
}

/* ---- context breakdown（Task 6：上下文占比可视化与下钻）---- */
export const ContextChannel = {
  Estimate: 'context:estimate',
  GetBreakdown: 'context:get-breakdown',
  RemoveItem: 'context:remove-item',
  ClearCategory: 'context:clear-category',
} as const

/** 上下文分类 */
export type ContextCategory = 'system' | 'files' | 'tools' | 'messages' | 'mcp' | 'skills' | 'other'

/** 单条明细项 */
export interface ContextDetail {
  id: string
  label: string
  /** 展示类型：file / tool / sub-agent / skill-instruction / message / system-prompt / memory-injection / mcp */
  type: string
  tokenCount: number
  removable: boolean
  data?: unknown
}

/** 分类汇总行 */
export interface ContextBreakdownItem {
  category: ContextCategory
  label: string
  tokenCount: number
  /** 相对 maxTokens（上下文预算）的占比百分比，保留一位小数 */
  percentage: number
  details: ContextDetail[]
}

/** 上下文占比结果 */
export interface ContextBreakdownResult {
  totalTokens: number
  maxTokens: number
  overallPercentage: number
  items: ContextBreakdownItem[]
  remainingTokens: number
}

/* ---- fs ---- */
export const FsChannel = {
  ListFiles: 'fs:list-files',
  ReadFile: 'fs:read-file',
  WriteFile: 'fs:write-file',
  StatFile: 'fs:stat-file',
  RevealInFolder: 'fs:reveal-in-folder',
  // v0.15.x Task 3：用户产物目录与 .arkwork 临时目录治理
  GetArtifactsDir: 'fs:get-artifacts-dir',
  SetArtifactsDir: 'fs:set-artifacts-dir',
  CleanArkworkTemp: 'fs:clean-arkwork-temp',
  GetArkworkSize: 'fs:get-arkwork-size',
} as const

export interface FsNode {
  name: string
  path: string
  type: 'file' | 'folder'
  size?: number
  lines?: number
  language?: string
  status?: 'M' | 'A' | 'D' | ' '
  children?: FsNode[]
}

export interface FileContent {
  content: string
  language: string
  size: number
  lines: number
}

/** v0.15.x Task 3：.arkwork 临时文件清理结果 */
export interface FsCleanResult {
  /** 已删除的文件绝对路径列表 */
  cleaned: string[]
  /** 因未过期而跳过的文件列表 */
  skipped: string[]
}

/* ---- settings / secrets ---- */
export const SettingsChannel = {
  Get: 'settings:get',
  Set: 'settings:set',
  GetSecret: 'settings:get-secret',
  SetSecret: 'settings:set-secret',
  PickWorkspace: 'settings:pick-workspace',
} as const

/** v0.4.0：主题三态（浅色 / 深色 / 跟随系统） */
export type ThemeMode = 'light' | 'dark' | 'system'

/** v0.8.0 / v0.15.0：记忆系统配置（L1 自动压缩阈值与开关 + 上下文压缩参数 + 记忆文件层级） */
export interface MemoryConfig {
  /** 自动压缩总开关（默认 true） */
  autoCompress: boolean
  /** 触发自动压缩的 token 阈值（默认 24000，v0.15.0 后由 compaction 阈值体系替代） */
  compressThreshold?: number
  /** v0.15.0：项目记忆文件总大小上限（字节，默认 32768） */
  projectDocMaxBytes?: number
  /** v0.15.0：是否启用模块级 MEMORY.md 按需加载 */
  moduleMemory?: boolean
  /** v0.15.0：是否启用 MEMORY.override.md 临时覆盖 */
  overrideEnabled?: boolean
}

/** v0.15.0：权限配置段 */
export interface PermissionSettings {
  /** 默认权限模式 */
  defaultMode: PermissionMode
  /** 静默放行规则 */
  allow: string[]
  /** 触发确认规则 */
  ask: string[]
  /** 永远优先的拒绝规则 */
  deny: string[]
  /** 额外允许访问的目录 */
  additionalDirectories: string[]
  /** 追加到默认 PROTECTED_PATHS 的额外受保护路径 */
  protectedPaths: string[]
}

/** v0.15.0：shell 执行约束配置段 */
export interface ShellSettings {
  /** 默认超时（默认 30000） */
  defaultTimeoutMs: number
  /** 最大超时（默认 300000） */
  maxTimeoutMs: number
  /** 标准输出最大字节（默认 1048576） */
  maxStdoutBytes: number
  /** 标准错误最大字节（默认 262144） */
  maxStderrBytes: number
  /** doom_loop 触发阈值（默认 3） */
  doomLoopThreshold: number
  /** doom_loop 滑动窗口毫秒（默认 60000） */
  doomLoopWindowMs: number
}

/** v0.15.0：Agent 工具调用预算配置段 */
export interface AgentSettings {
  /** 单次 Turn 总工具预算（默认 25） */
  maxIterations: number
}

/** v0.15.0：上下文压缩配置段 */
export interface CompactionSettings {
  /** 自动压缩总开关 */
  auto: boolean
  /**
   * 自动压缩窗口配置
   * - 'auto'：按模型上下文窗口自动计算
   * - 数字：自定义模型最大 tokens
   * - 字符串：如 "500k" / "1M"
   */
  autoCompactWindow: 'auto' | number | string
  /** AutoCompact 缓冲 tokens（默认 13000） */
  buffer: number
  /** 压缩后保留近期原始上下文的 tokens（默认 15000） */
  keepTokens: number
  /** 摘要输出上限 tokens（默认 4000） */
  maxSummaryTokens: number
  /** prune 阶段保护最近 N tokens 的工具输出（默认 40000） */
  pruneProtect: number
  /** prune 阶段最低裁剪量，低于此值不执行（默认 20000） */
  pruneMinimum: number
  /** 连续失败熔断阈值（默认 3） */
  maxConsecutiveFailures: number
  /** 摘要模板（默认 five-segment） */
  summaryTemplate: 'five-segment' | string
}

/** v0.29.0：界面语言（zh/en/ja/ko 四语言） */
export type Locale = 'zh' | 'en' | 'ja' | 'ko'

export const SUPPORTED_LOCALES: Locale[] = ['zh', 'en', 'ja', 'ko']

export interface AppSettings {
  workspaceDir: string
  defaultModelId: string
  defaultAgentId: string
  /** v0.4.0：扩展为三态，默认 'dark' */
  theme: ThemeMode
  /** v0.29.0：界面语言（缺省时由启动决策流决定：全新安装跟随系统，存量用户保持 zh） */
  language?: Locale
  /** v0.8.0：记忆系统配置（缺省走默认值） */
  memory?: MemoryConfig
  /** Task 8：全局知识库总开关（缺省 true）。关闭后 kb_query 不再注入上下文。 */
  kbEnabled?: boolean
  /** v0.15.0：权限模型配置 */
  permissions?: PermissionSettings
  /** v0.15.0：shell 执行约束 */
  shell?: ShellSettings
  /** v0.15.0：Agent 工具调用预算 */
  agent?: AgentSettings
  /** v0.15.0：上下文压缩配置 */
  compaction?: CompactionSettings
  /**
   * 用户产物默认输出目录（文档、代码、测试、手册等）。
   * 空字符串表示使用默认 {workspaceDir}/docs。
   * 设置后不得指向 .arkwork 目录（Agent 自身内容区域）。
   */
  artifactsDir?: string
}

/** 本地 keychain 风格的密钥表（按 key 存字符串） */
export type SecretKeys = Record<string, string>

/* ---- theme ---- */
/** v0.4.0：系统主题变化广播（Main → Renderer） */
export const ThemeChannel = {
  Apply: 'theme:apply',                  // Renderer → Main：同步原生界面
  SystemChanged: 'theme:system-changed', // Main → Renderer：系统主题变化
} as const

/** 系统实际主题（'system' 解析后的结果） */
export type ResolvedTheme = 'light' | 'dark'

/** 测试模型连通性的请求 */
export interface TestModelRequest {
  kind: LlmProviderKind
  baseURL?: string
  apiKey?: string
  modelId: string
}

/** 测试模型连通性的结果 */
export interface TestModelResult {
  ok: boolean
  message: string
  models?: string[]
}

/* ---- log ---- */
export const LogChannel = {
  Append: 'log:append',         // Main → Renderer 推送日志
  List: 'log:list',
} as const

/* ---- router（v0.14.0 Task 2）---- */
/** chat/task 分流判定 — Composer 在发送前调用 */
export const RouterChannel = {
  Classify: 'route:classify',
} as const

/** 'route:classify' 入参 */
export interface RouteClassifyRequest {
  input: string
  ctx?: { hasTools?: boolean; lastTurnKind?: 'chat' | 'task' }
}

/** 'route:classify' 返回 */
export interface RouteClassifyDecision {
  kind: 'chat' | 'task'
  reason: string
  latencyMs: number
}

export interface LogEntry {
  ts: number
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'
  /** v0.14.0 Task 2：新增 Router（chat/task 分流判定） */
  source: 'LLM' | 'Tool' | 'Memory' | 'Agent' | 'KB' | 'System' | 'Router'
  message: string
  taskId?: string
}

/* ---- v0.14.0 Task 11：bugfix 技能（目标驱动多轮续跑） ---- */

/** v0.18.0：PlanItem 六态变更推送（Main → Renderer，经 `task:plan-item-status-changed` 通道）。
 *  字段在 v0.14.0 基础上固化并扩展：
 *  - index / fromStatus / source / reason / ts_iteration / version 为新增；
 *  - 老字段 taskId / planItemId / status / ts 保留；note 字段废弃，迁到 reason。
 *  - 完整对照表见 docs/versions/v0.18.0/03-system-design.md §4.3.1。
 */
export interface PlanItemStatusChanged {
  /** 任务 ID（T-YYYYMMDD-XXXXXX） */
  taskId: string
  /** PlanItem 稳定 ID（旧数据由迁移层补齐） */
  planItemId: string
  /** 冗余字段：planItem 在 planItems 数组中的位置，避免客户端再 O(n) 查找 */
  index: number
  /** 变更前状态（用于 reconcile 比对） */
  fromStatus: PlanItemStatus
  /** 变更后状态 */
  status: PlanItemStatus
  /** 该项状态变更的来源（Main 端唯一写入） */
  source: PlanItemSource
  /** 失败原因 / LLM comment 等可选说明 */
  reason?: string
  /** Main 端单调递增版本号（同一 task 内每次 plan-item-status-changed 自增） */
  version: number
  /** 引擎迭代编号（便于调试 act-failure-iterN 等触发链路） */
  ts_iteration?: number
  /** ms 时间戳（Main 端 Date.now()） */
  ts: number
}

/** v0.18.0：planItems 整对象快照（兜底专用，与 patch 通道分开，避免队列交叉）。
 *  触发场景：
 *  - Renderer 主动 invoke('task:plan-list-snapshot', taskId)；
 *  - Main 端在 plan-regen 后主动广播；
 *  - Renderer 检测到 patch.version 落后差距 ≥ 5 时自动 fallback（见 store.ts reconcile 规则）。
 */
export interface PlanItemListSnapshotPayload {
  taskId: string
  planItems: PlanItem[]
  /** Main 端单调递增版本号，与 patch 共用同一计数 */
  version: number
  ts: number
}

/** v0.18.0：用户手动切状态的回执 */
export type PlanItemActionResult =
  | { ok: true; version: number; effectiveStatus: PlanItemStatus }
  | { ok: false; error: { code: 'E_NOT_FOUND' | 'E_INVALID_STATE' | 'E_PERMISSION_DENIED'; message: string } }

/** bugfix 续跑模式（⌘K 可切换） */
export type BugfixMode = 'multi-attempt' | 'single-attempt'

/** bugfix 终态结果摘要（随 achieved / not-achieved 事件附带） */
export interface BugfixResultSummary {
  /** 最终状态：achieved 达成 / exhausted 路径耗尽 / failed 单轮未达成 */
  status: 'achieved' | 'exhausted' | 'failed'
  /** diff 摘要（git diff --stat 等） */
  diffSummary: string
  /** 最后一次验证的测试输出（截断） */
  testOutput: string
  /** 尝试轮数 */
  attemptCount: number
  /** Given/When/Then 目标 */
  goal: string
}

/** bugfix 进度事件（Main → Renderer，操作岛台实时刷新） */
export interface BugfixProgressEvent {
  taskId: string
  /** 4 阶段：goal-defined → fixing → verifying → achieved / not-achieved */
  phase: 'goal-defined' | 'fixing' | 'verifying' | 'achieved' | 'not-achieved'
  /** 当前尝试序号（1-based；goal-defined 为 0） */
  attempt: number
  /** 当前轮次（1-based；goal-defined 为 0） */
  round: number
  /** 终态阶段携带结果摘要 */
  result?: BugfixResultSummary
  ts: number
}

/* ---- v0.24.1：agent 自主浏览器加载请求 ---- */
export interface BrowserLoadRequest {
  requestId: string
  /** 要加载的完整 URL（本地文件已转为 file://） */
  url: string
}

/* ---- v0.25.0 F2：WebContentsView Tab 元数据（IPC 镜像，不含 view） ---- */
export interface BrowserTabMeta {
  tabId: string
  url: string
  title: string
  favicon?: string
  host: 'dock' | 'window'
  agentDriven: boolean
}

/* ---- v0.26.0 P1：agent 浏览器交互原语（BrowserArgs action 全集，重设计文档 §3.1） ---- */
export type BrowserAction =
  | 'open'
  | 'navigate'
  | 'back'
  | 'forward'
  | 'reload'
  | 'stop'
  | 'snapshot'
  | 'screenshot'
  | 'console'
  | 'click'
  | 'type'
  | 'press'
  | 'scroll'
  | 'select'
  | 'wait'
  | 'tabs'
  | 'eval'
  | 'close'

/** browser 工具入参：定位优先级 ref > selector > text */
export interface BrowserArgs {
  action: BrowserAction
  /** snapshot 产出的元素引用（如 e12），导航/reload 后失效 */
  ref?: string
  /** CSS 选择器定位 */
  selector?: string
  /** 可见文本定位（精确匹配优先，退化为包含匹配） */
  text?: string
  /** open/navigate/tabs new：URL 或本地路径（相对工作区） */
  url?: string
  path?: string
  /** type/select：输入值或选项值/选项文本 */
  value?: string
  /** press：按键名（Enter/Tab/Escape/ArrowDown…，支持 ctrl+a 组合） */
  key?: string
  /** scroll：滚动方向 */
  direction?: 'up' | 'down' | 'top' | 'bottom'
  /** scroll：滚动量 px（默认 400） */
  amount?: number
  /** wait/navigate 等超时毫秒 */
  timeoutMs?: number
  /** screenshot：保存路径（省略存 .arkwork/browser-shots/） */
  file?: string
  /** screenshot：同时返回 base64 给多模态模型 */
  returnImage?: boolean
  /** tabs 子命令 */
  subcommand?: 'list' | 'new' | 'select' | 'close'
  /** tabs select/close：目标 Tab id */
  tabId?: string
  /** eval：要执行的 JS 表达式 / 语句 */
  js?: string
  /** console：最多返回条数 */
  limit?: number
}

/* ---- 暴露给 Renderer 的 ark API 完整签名 ---- */
export interface ArkApi {
  task: {
    list: () => Promise<Task[]>
    get: (id: string) => Promise<Task | null>
    create: (input: TaskCreateInput) => Promise<Task>
    update: (patch: TaskUpdatePatch) => Promise<Task>
    delete: (id: string) => Promise<void>
    run: (id: string) => Promise<void>
    pause: (id: string) => Promise<void>
    resume: (id: string) => Promise<void>
    cancel: (id: string) => Promise<void>
    appendMessage: (taskId: string, text: string) => Promise<Task | null>
    listSteps: (taskId: string) => Promise<ReActStep[]>
    onStep: (cb: (step: ReActStep) => void) => () => void
    /** v0.27.0 R1：流式文本增量订阅（渲染加速通道；完整响应仍以 task:step 为准） */
    onTextDelta: (cb: (payload: TaskTextDeltaPayload) => void) => () => void
    /** v0.14.0 Task 4：按工具维度的并行 Act 进度（per-requestId） */
    onProgress: (cb: (progress: ToolProgressEvent) => void) => () => void
    onProgressClear: (cb: (payload: ToolProgressClearEvent) => void) => () => void
    onEvent: (cb: (event: ReActEvent) => void) => () => void
    onStatusChange: (cb: (task: Task) => void) => () => void
    /** v0.18.0：PlanItem 六态变更推送（Main → Renderer） */
    onPlanItemStatusChanged: (cb: (payload: PlanItemStatusChanged) => void) => () => void
    /** v0.18.0：planItems 整对象快照（Main → Renderer，落后兜底） */
    onPlanItemListSnapshot: (cb: (payload: PlanItemListSnapshotPayload) => void) => () => void
    /** v0.18.0：用户手动切状态入口（Renderer → Main） */
    cancelPlanItem: (payload: { taskId: string; planItemId: string }) => Promise<PlanItemActionResult>
    retryPlanItem: (payload: { taskId: string; planItemId: string }) => Promise<PlanItemActionResult>
    markDonePlanItem: (payload: { taskId: string; planItemId: string }) => Promise<PlanItemActionResult>
    /** v0.18.0：Renderer 主动拉取 planItems 整对象（patch 落后兜底） */
    fetchPlanItemList: (taskId: string) => Promise<PlanItem[]>
    /** Task 9：任务侧边栏进度摘要持久化（独立 IPC 通道，避免污染 task:status 主链路） */
    progressSave: (payload: { taskId: string; progress: TaskProgress }) => Promise<void>
    progressLoad: () => Promise<Record<string, TaskProgress> | null>
  }
  /** v0.14.0 Task 11：bugfix 技能 — 进度订阅（操作岛台）与模式切换（⌘K） */
  bugfix: {
    onProgress: (cb: (event: BugfixProgressEvent) => void) => () => void
    getMode: () => Promise<BugfixMode>
    setMode: (mode: BugfixMode) => Promise<BugfixMode>
  }
  agent: {
    list: () => Promise<Agent[]>
    get: (id: string) => Promise<Agent | null>
    add: (input: AgentAddInput) => Promise<Agent>
    update: (id: string, patch: Partial<Agent>) => Promise<Agent>
    remove: (id: string) => Promise<void>
    manualOverride: (value?: '@general' | '@coding' | 'auto') => Promise<'@general' | '@coding' | 'auto'>
  }
  skill: {
    list: () => Promise<Skill[]>
    add: (input: SkillAddInput) => Promise<Skill>
    update: (patch: SkillUpdatePatch) => Promise<Skill>
    remove: (id: string) => Promise<void>
    toggle: (id: string, enabled: boolean) => Promise<void>
    importFromDir: (dirPath: string) => Promise<Skill>
    /** v0.16.5：单内容 → 目录；多内容 → zip。返回最终路径与文件数。 */
    exportToDir: (id: string, targetDir: string) => Promise<SkillExportResult>
    readInstruction: (id: string) => Promise<string | null>
  }
  mcp: {
    list: () => Promise<McpServer[]>
    add: (input: McpAddInput) => Promise<McpServer>
    update: (id: string, patch: Partial<McpServer>) => Promise<McpServer>
    remove: (id: string) => Promise<void>
    connect: (id: string) => Promise<McpServer['tools']>
    disconnect: (id: string) => Promise<void>
    callTool: (serverId: string, toolName: string, args: Record<string, unknown>) => Promise<unknown>
    toggle: (id: string, enabled: boolean) => Promise<void>
  }
  market: {
    /** v0.15.0：服务端全文搜索（兼容旧签名：query+tags+page） */
    search: (queryOrParams: string | MarketSearchParams, tags?: string[], page?: number) => Promise<{ results: MarketSearchResult[]; total: number; hasMore: boolean; nextCursor?: string | null }>
    install: (skillId: string) => Promise<Skill | null>
    uninstall: (skillId: string) => Promise<void>
    detail: (skillId: string) => Promise<SkillMetadata | null>
    review: (skillId: string, rating: number, comment?: string) => Promise<SkillReview>
    toggleFavorite: (skillId: string, favorited: boolean) => Promise<void>
    listSources: () => Promise<MarketplaceSource[]>
    listInstalled: () => Promise<MarketSearchResult[]>
    /** v0.15.0：读取本地持久化市场状态（收藏 / 已装 / 源） */
    getLocalState: () => Promise<MarketLocalState>
    addSource: (source: MarketplaceSource) => Promise<MarketplaceSource>
    removeSource: (sourceId: string) => Promise<void>
    // v0.6.1：SkillHub CLI 管理（v0.15.0 后保留兼容）
    checkCli: () => Promise<{ installed: boolean; path?: string; version?: string }>
    installCli: () => Promise<{ installed: boolean; path?: string; version?: string }>
  }
  /** v0.15.0：权限模型 */
  permission: {
    getMode: () => Promise<PermissionMode>
    setMode: (mode: PermissionMode) => Promise<PermissionMode>
    resolveRules: () => Promise<ResolvedRules>
    /** 把一条规则追加写入 .arkwork/settings.local.json（仅 allow 规则） */
    addRule: (rule: string, scope?: 'allow') => Promise<void>
    /** 会话模式变更推送（Shift+Tab / UI 切换时主进程广播） */
    onModeChanged: (cb: (payload: PermissionModeEvent) => void) => () => void
  }
  model: {
    list: () => Promise<LlmModel[]>
    add: (model: LlmModel) => Promise<void>
    update: (model: LlmModel) => Promise<void>
    remove: (id: string) => Promise<void>
    test: (req: TestModelRequest) => Promise<TestModelResult>
  }
  /** 自动化 — Agent 自动执行规则 */
  automation: {
    list: () => Promise<Automation[]>
    create: (input: AutomationCreateInput) => Promise<Automation>
    update: (id: string, patch: Partial<Automation>) => Promise<Automation>
    remove: (id: string) => Promise<void>
    /** 触发运行：基于 automation 的 agentId / prompt 创建一个新任务 */
    run: (id: string) => Promise<{ taskId: string }>
  }
  /** 知识库 — 文件/文件夹索引 */
  kb: {
    list: () => Promise<KnowledgeBase[]>
    add: (input: KbAddInput) => Promise<KnowledgeBase>
    remove: (id: string) => Promise<void>
    // v0.8.0 F810/F811
    pickFiles: () => Promise<string[]>
    import: (filePaths: string[]) => Promise<{ imported: number; failed: number }>
    rename: (id: string, newName: string) => Promise<void>
    reimport: (id: string) => Promise<{ chunks: number }>
    search: (query: string, kbIds?: string[] | null, limit?: number) => Promise<KbSearchResult>
    setEnabled: (id: string, enabled: boolean) => Promise<void>
    onImportProgress: (cb: (progress: KbImportProgress) => void) => () => void
    onChanged: (cb: () => void) => () => void
  }
  memory: {
    list: (taskId: string) => Promise<MemoryItem[]>
    toggle: (taskId: string, id: string, enabled: boolean) => Promise<void>
    edit: (taskId: string, id: string, content: string) => Promise<void>
    archive: (taskId: string, id: string) => Promise<void>
    compress: (opts: CompressOpts) => Promise<CompressResult>
    clear: (taskId: string) => Promise<boolean>
    onChanged: (cb: (taskId: string) => void) => () => void
    // v0.8.0 L3a 策展记忆
    l3Get: () => Promise<CuratedSnapshot>
    l3Update: (file: 'memory.md' | 'user.md', content: string) => Promise<void>
    l3PendingList: () => Promise<PendingEntry[]>
    l3PendingApply: (modelId?: string) => Promise<{ applied: number; merged: boolean }>
    l3PendingDiscard: (ids?: string[]) => Promise<void>
    // v0.8.0 L4a 用户画像
    l4Get: () => Promise<UserProfile>
    l4UpdateSynthesis: (text: string) => Promise<UserProfile>
    l4DeleteObservation: (id: string) => Promise<UserProfile>
    l4Rollback: (version: number) => Promise<UserProfile>
    // v0.8.0 蒸馏与转化（Task 10：distill-accept / distill-dismiss 已移除——蒸馏全自动）
    convertToSkill: (source: ConvertSource, skillMd: string) => Promise<ConvertToSkillResult>
    convertToKb: (source: ConvertSource) => Promise<ConvertToKbResult>
    // v0.8.0 L3b 档案检索
    archiveSearch: (query: string, limit?: number) => Promise<ArchiveHit[]>
    // v0.16 Task 7：L2 压缩记忆管理
    l2List: (taskId: string) => Promise<L2Memory[]>
    l2Detail: (taskId: string, id: string) => Promise<L2Memory | null>
    l2Delete: (taskId: string, id: string) => Promise<L2Memory[]>
    l2Merge: (taskId: string, ids: string[]) => Promise<L2Memory | null>
    l2Export: (taskId: string, ids?: string[]) => Promise<{ json: string; count: number }>
  }
  fs: {
    listFiles: (taskId?: string) => Promise<FsNode[]>
    readFile: (path: string) => Promise<FileContent>
    writeFile: (path: string, content: string) => Promise<void>
    revealInFolder: (path: string) => Promise<void>
    /** v0.9.1：重命名（仅工作区内），返回新路径 */
    rename: (path: string, newName: string) => Promise<{ path: string }>
    /** v0.9.1：删除到系统回收站（可恢复） */
    delete: (path: string) => Promise<void>
    /** v0.15.x Task 3：获取当前用户产物目录 */
    getArtifactsDir: () => Promise<string>
    /** v0.15.x Task 3：设置产物目录（写入 settings.artifactsDir），返回实际产物目录 */
    setArtifactsDir: (dir: string) => Promise<string>
    /** v0.15.x Task 3：手动触发 .arkwork 临时文件清理 */
    cleanArkworkTemp: (maxAgeDays?: number) => Promise<FsCleanResult>
    /** v0.15.x Task 3：获取 .arkwork 目录总大小（字节） */
    getArkworkSize: () => Promise<number>
  }
  log: {
    list: (taskId?: string) => Promise<LogEntry[]>
    onAppend: (cb: (entry: LogEntry) => void) => () => void
  }
  /**
   * v0.24.1：agent 自主驱动的内置浏览器。
   * v0.27.0 F12：loadDone / onDidFinishLoad / onDidFailLoad 随 webview 旧轨删除；
   * 加载结算由主进程 waitForLoad 负责，renderer 仅接收通知与地址解析。
   */
  browser: {
    /** 订阅 agent 的 browser.open 请求（用于 dock chrome 同步地址栏 / 激活 Tab） */
    onLoadRequest: (cb: (req: BrowserLoadRequest) => void) => () => void
    /** 地址栏输入 → 完整 URL（本地路径转 file://，基于工作区） */
    resolve: (input: string) => Promise<string>
  }
  /** v0.25.0 F2：WebContentsView 多 Tab 路由（设计文档 §4.4） */
  browserTabs: {
    create: (args?: { url?: string; newTab?: boolean }) => Promise<{ tabId: string }>
    close: (args: { tabId: string }) => Promise<true>
    activate: (args: { tabId: string }) => Promise<true>
    navigate: (args: { tabId: string; url: string }) => Promise<{ ok: boolean; error?: string }>
    setBounds: (args: { tabId: string; rect: { x: number; y: number; width: number; height: number } }) => Promise<true>
    list: () => Promise<BrowserTabMeta[]>
    setAgentDriven: (args: { tabId: string; agentDriven: boolean }) => Promise<true>
    /** v0.25.0 F2 P1：dock → 独立窗口（解决「切标签丢 webContents / 浮窗浏览器不可用」bug） */
    detach: (args: { tabId: string; bounds?: { x: number; y: number; width: number; height: number } }) => Promise<{ windowId: number }>
    /** v0.25.0 F2 P1：独立窗口 → dock */
    attach: (args: { tabId: string }) => Promise<true>
    /** v0.25.0 F2 P1：宿主变化通知（attach/detach 完成后 push；BrowserPanel 收到后立即 setBounds） */
    onHostChanged: (cb: (payload: { tabId: string; host: 'dock' | 'window' }) => void) => () => void
  }
  settings: {
    get: () => Promise<AppSettings>
    set: (patch: Partial<AppSettings>) => Promise<void>
    getSecret: (key: string) => Promise<string | undefined>
    setSecret: (key: string, value: string) => Promise<void>
    pickWorkspace: () => Promise<string | undefined>
    activateWorkspace: (path: string) => Promise<boolean>
  }
  /** v0.4.0：主题（同步原生界面 + 监听系统主题变化） */
  theme: {
    /** 应用主题到原生界面（文件选择器/对话框/上下文菜单） */
    apply: (theme: ThemeMode) => Promise<void>
    /** 获取系统当前主题（'system' 模式下用于解析实际效果） */
    getSystemTheme: () => Promise<ResolvedTheme>
    /** 订阅系统主题变化（用户在 OS 设置中切换浅深时触发） */
    onSystemChange: (cb: (systemTheme: ResolvedTheme) => void) => () => void
  }
  /** v0.3.0：跨平台窗口控制 + 平台标识 */
  platform: NodeJS.Platform
  window: {
    minimize: () => Promise<void>
    toggleMaximize: () => Promise<boolean>
    close: () => Promise<void>
    isMaximized: () => Promise<boolean>
  }
  /** v0.8.1：工具执行确认（Main → Renderer 请求，Renderer 回传结果） */
  confirm: {
    /** 订阅工具确认请求（shell 等需要用户确认的操作） */
    onRequest: (cb: (req: ToolConfirmRequest) => void) => () => void
    /**
     * 回传确认结果（session=true 表示本次会话内不再询问同一条命令）
     * v0.14.0 Task 6：reason 区分「显式拒绝 / 关闭对话框」，避免误报「用户拒绝」。
     */
    respond: (requestId: string, allowed: boolean, session?: boolean, reason?: ConfirmRespondReason) => Promise<void>
  }
  /** v0.14.0 Task 2：chat/task 分流判定（Composer 发送前调用） */
  route: {
    classify: (input: string, ctx?: RouteClassifyRequest['ctx']) => Promise<RouteClassifyDecision>
  }
  /** v0.15.x：上下文真实用量按需估算（非运行态也能展示 system + messages + tools + memoryInjection） */
  context: {
    estimate: (taskId: string) => Promise<ContextEstimateResult | null>
    /** Task 6：获取上下文占比明细（7 分类 + 可下钻 detail） */
    getBreakdown: (taskId: string) => Promise<ContextBreakdownResult | null>
    /** Task 6：移除指定分类的指定项（如移除某个文件 / 关闭某技能） */
    removeItem: (taskId: string, category: ContextCategory, detailId: string) => Promise<boolean>
    /** Task 6：清空某类上下文（如清空所有文件引用） */
    clearCategory: (taskId: string, category: ContextCategory) => Promise<boolean>
  }
}

declare global {
  interface Window {
    ark: ArkApi
  }
}
