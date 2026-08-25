/* ============================================================
 * ArkWork — Shared Types: Agent / Skill / MCP / Model
 * 设计文档 §10.2 / §10.5
 * ============================================================ */

/**
 * v0.19.0 M1：系统提示词 section（提示词组装化）。
 * 借鉴 dsh prompt-system 的 section/scope 设计：把写死的长字符串拆为有序段，
 * 由组装器按 order 升序渲染；scope 预留（本版不启用，供后续作用域遮蔽）。
 */
export interface PromptSection {
  /** 段标识，用于去重 / 遮蔽 / 测试断言 */
  id: string
  /** 排序权重，升序渲染，负数前移 */
  order: number
  /** 段正文（含 `## 标题` 与内容） */
  text: string
  /** 预留：作用域遮蔽（本版不启用） */
  scope?: string
}

export interface Agent {
  id: string                    // @researcher
  name: string
  description: string
  avatarColor: string           // 首字母方块的颜色
  systemPrompt: string
  /**
   * v0.19.0 M1：有序 section（替代 systemPrompt 作为核心规则的组装单元）。
   * 缺省时组装器回退用 systemPrompt 作单段；systemPrompt 保留为向后兼容的扁平化产物。
   */
  systemSections?: PromptSection[]
  // v0.6.0：CrewAI 式角色三字段（运行时注入，见 engine 装配管道）
  role?: string                 // 代码审查员
  goal?: string                 // 审查代码质量与安全
  backstory?: string            // 资深全栈工程师，精通安全审计
  // v0.8.0 F822：自 Expert 并入 — 表达风格
  styleGuide?: string           // "要点式，先结论，代码注释英文"
  defaultSkillIds: string[]     // 固有能力（运行时强制启用，不可在任务内移除）
  defaultMcpIds: string[]
  /**
   * v0.25.0 F1：常驻能力清单。run 启动时把对应技能的 SKILL.md 指令体
   * 注入 system 的 agent-static 段（契约段 id = skill:{skillId}），
   * 任务全程生效（如 @coder 内化文档驱动开发）。缺省 [] 行为不变。
   */
  alwaysOnSkillIds?: string[]
  defaultModelId: string
  defaultKbIds: string[]
  defaultConfig: TaskConfig
  isBuiltin: boolean
  version: string
  source: 'core' | 'market' | 'custom'
  // v0.9.0 F905：RightDock 智能体自适应 — 工作台布局预设（缺省 = DEFAULT_PRESET）
  dockPreset?: DockPreset
  // Task 2：可组合侧边栏 — 启用的右侧侧边栏 widget id 列表
  // 缺省（undefined）= SIDEBAR_WIDGETS 中 defaultEnabled 的集合（见 sidebarRegistry）
  // 组合维度之一：决定该智能体在 RightDock 中暴露哪些功能面板；不影响 ReAct 工具集
  enabledSidebarWidgetIds?: string[]
  // v0.8.0 F822：自 Expert 并入 — 记忆域（缺省全开）
  memoryScope?: {
    useProfile: boolean           // L4a 用户画像（默认 true）
    curatedKeys?: string[]        // L3a 策展事实白名单（空 = 全量）
    skillMemory: boolean          // 是否可读自己蒸馏出的技能（默认 true）
  }
  // v0.8.0 F822：自 Expert 并入 — 使用指标
  metrics?: {
    uses: number
    success: number
    avgIterations: number
    lastUsedAt: number
  }
  /** v0.8.0 F822：出身（手建 / 蒸馏沉淀） */
  bornFrom?: { kind: 'manual' } | { kind: 'distilled'; taskIds: string[] }
  /** v0.15.0 Task 6：智能体默认权限模式（仅在用户未显式切换且 settings 未设 defaultMode 时生效）
   *  - acceptEdits：工作区内的轻写（mkdir/cp/mv/sed -i/tee/git commit/...）默认放行，不再每次弹确认
   *  - default/plan：不改变行为
   */
  defaultPermissionMode?: 'default' | 'acceptEdits' | 'plan'
}

/* ============================================================
 * v0.9.0 F905 — RightDock 智能体自适应（工作台布局预设）
 * 右侧任务上下文 Dock 的 Tab 集合 / 排序 / 默认选中随智能体变化。
 * ============================================================ */
export type DockTabId = 'files' | 'context' | 'terminal' | 'browser' | 'todos' | 'progress'

export interface DockPreset {
  /** 有序 Tab 列表（tabs 最少 2 个；context 不可移除） */
  tabs: DockTabId[]
  /** 默认选中 Tab（必须 ∈ tabs） */
  defaultTab: DockTabId
}

// v0.6.1：+ 'market'（SkillHub 等第三方 SKILL.md 技能）
export type SkillSource = 'builtin' | 'mcp' | 'custom' | 'market'

/**
 * v0.6.0：builtinHandler 联合类型
 * - file-reader / web-search / shell / fetch-url / task-complete / ask-user：原有内置工具
 * - delegate-agent：多 agent 委派，子 agent 继承父 agent 的 skill 白名单
 */
export type BuiltinHandler =
  | 'file-reader'
  | 'file-writer'
  | 'file-editor'
  | 'glob-search'
  | 'grep-search'
  | 'web-search'
  | 'shell'
  | 'fetch-url'
  | 'browser'
  | 'task_complete'
  | 'ask_user'
  | 'delegate-agent'
  | 'session-search'
  | 'kb-search'
  | 'kb-enable'
  | 'spec'
  | 'plan'
  | 'bugfix'
  | 'react-core-skills'
  | 'todo_update'

export interface Skill {
  id: string                    // S-core.web-search
  name: string
  description: string           // 精简描述，注入 LLM tools 列表（< 80 tokens）
  namespace: string             // 'core' 或 mcp namespace
  source: SkillSource
  /** builtin skill 通过此字段标识内置处理器 */
  builtinHandler?: BuiltinHandler
  /** mcp skill 通过 serverId + toolName 路由 */
  mcpRef?: { serverId: string; toolName: string }
  inputSchema?: Record<string, unknown>
  timeout?: number              // 默认 30s
  needsConfirmation?: boolean
  // v0.6.0 新增
  enabled: boolean              // 启用/禁用开关；旧数据迁移时默认 true
  /** SKILL.md 指令体文件路径（渐进式披露：list 阶段不读，invoke 时按需加载注入 ctx） */
  instructionMd?: string
  /** 市场分类标签（如 ['web', 'search']） */
  tags?: string[]
  /** 市场安装来源 URL 或包名 */
  installedFrom?: string
  /**
   * v0.6.1：LLM 工具名（ASCII 安全）。
   * SkillHub 等第三方技能的展示名可能含中文/特殊字符，
   * OpenAI/DeepSeek 的 function name 仅允许 [a-zA-Z0-9_-]。
   * 缺省时由 registry.skillToolName() 按 name 生成。
   */
  toolName?: string
  /**
   * v0.19.0 M5：分层来源。同名 id 最近层遮蔽（project > user > bundled）。
   * 旧数据迁移默认 'user'。
   */
  layer?: 'project' | 'user' | 'bundled' | 'runtime'
  /**
   * v0.19.0 M5：作用域（空/缺省 = 全局可用）。
   * 用于按 agent / workspace 过滤注入到 LLM 的工具集。
   */
  scopes?: string[]
  /**
   * v0.25.0 F1：指令体生命周期（从 SKILL.md frontmatter 解析，缺省 on-demand）。
   * - always-on：配合 agent.alwaysOnSkillIds，指令体进 system agent-static 段（任务全程生效）
   * - on-demand：invoke 时以 L1 standalone-message（kind='skill_instruction'）注入，
   *   持续生效至任务结束（不再是单轮 hint）
   * - hint-only：仅 description 进 tools 列表，不注入指令体
   */
  instructionMode?: 'always-on' | 'on-demand' | 'hint-only'
  /**
   * v0.25.0 F1：门禁声明（从 SKILL.md frontmatter 解析）。引擎据此持久化
   * task.gateStates 状态机；未确认的门禁阻塞下游阶段（todo_update 标 done 时拦截）。
   */
  gates?: GateSpec[]
  /**
   * v0.25.0 F1：计划生成覆写声明（skill manifest 级通用机制）。
   * 如 'doc-driven' → generatePlan 使用文档驱动计划 prompt（替代旧 docDriven 正则特判）。
   */
  planPrompt?: string
}

/**
 * v0.25.0 F1：门禁契约（SKILL.md frontmatter 声明）。
 * after：触发点描述（如「产出 01-prd.md」，与 todo 条目文本做包含匹配）；
 * ask：门禁确认时要向用户提出的问题。
 */
export interface GateSpec {
  id: string
  after: string
  ask: string
}

/**
 * v0.25.0 F1：门禁运行时状态（持久化在 task.gateStates，中断续聊可恢复）。
 * after/ask 为 GateSpec 快照——续聊 run 重新收集技能时 specs 可能不重复加载，
 * 状态机自带声明即可独立完成「todo_update 拦截 → ask_user 确认」闭环。
 */
export interface GateState {
  gateId: string
  status: 'pending' | 'passed' | 'skipped'
  confirmedAt?: number
  note?: string
  /** 触发点描述快照（来自 GateSpec.after，如「产出 01-prd.md」） */
  after?: string
  /** 门禁问题快照（来自 GateSpec.ask） */
  ask?: string
}

export interface McpServer {
  id: string                    // M-github
  name: string
  namespace: string
  transport: 'stdio' | 'sse'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  enabled: boolean
  // v0.6.0：运行时状态字段（不持久化的部分由 client.ts 维护，但持久化字段会序列化）
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  toolCount: number
  tools: McpTool[]
  lastError?: string
}

export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  timeout?: number
  needsConfirmation?: boolean
}

export type LlmProviderKind = 'openai' | 'anthropic' | 'ollama' | 'vllm'

/**
 * 一个完整的 LLM 模型配置 — 每个 model 自带 url/key，无需分层 Provider。
 * - openai：OpenAI 官方或兼容端点；baseURL 留空用官方默认
 * - anthropic：Claude 系列模型
 * - ollama：本地 Ollama 服务，默认 http://127.0.0.1:11434/v1
 * - vllm：本地 vLLM 推理服务，OpenAI 兼容接口
 */
export interface LlmModel {
  id: string                   // 模型 ID（发送给 API 的值，如 'gpt-4o-mini'）
  name: string                 // 显示名
  kind: LlmProviderKind        // 协议类型（4 选 1）
  baseURL?: string             // API 端点 URL（openai 留空用官方默认）
  apiKey?: string              // API Key（ollama/vllm 可留空）
  contextWindow?: number       // 上下文窗口大小（可选）
  enabled: boolean             // 是否启用
  // v0.9.0 F904：能力静态声明（模型编辑器可勾选；缺省用命名启发式兜底，不做运行时探测）
  supportsThinking?: boolean   // 支持思考模式
  supportsTools?: boolean      // 支持工具调用
}

import type { TaskConfig } from './task'
