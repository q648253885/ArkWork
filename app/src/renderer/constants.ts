/* ============================================================
 * ArkWork — 共享常量
 * v0.7.0：废除 REACT_TYPE_LABEL/REACT_TYPE_COLOR（工程感三件套下线）；
 *         新增 TOOL_DISPLAY 工具人性化映射
 * ============================================================ */
import type { TaskStatus } from './types'
import type { IconName } from './icons'

/**
 * v0.8.1：上下文「对话噪音」记忆 kind — 在上下文资源清单（L1 面板 / @ 记忆
 * 选择器）中隐藏。用户与模型的对话已由交互区展示，上下文只保留资源条目：
 * 系统提示 / 文件引用 / 产物引用 / 技能引用 / 知识库命中。
 * （对齐 Hermes 等 agent 的上下文设计：上下文 = 资源清单，而非对话记录）
 */
export const CONTEXT_NOISE_KINDS: ReadonlySet<string> = new Set([
  'reasoning',
  'action',
  'observation',
  'summary',
  'compressed_summary',
  'user_message',
])

/** 状态色 — 全局唯一来源（done 用成功绿，cancelled/pending 归灰；v0.17.0 状态语义化）
 * v0.4.0：改用 CSS 变量，浅深皮肤自动适配 */
export const STATUS_COLOR: Record<TaskStatus, string> = {
  pending: 'var(--text-tertiary)',
  running: 'var(--accent)',
  paused: 'var(--warning)',
  done: 'var(--success)',
  failed: 'var(--danger)',
  cancelled: 'var(--text-tertiary)',
}

/** running 状态需要脉冲动画 */
export const PULSE_STATUS: ReadonlySet<TaskStatus> = new Set(['running'])

/** 状态符号 — 用于紧凑展示 */
export const STATUS_CHAR: Record<TaskStatus, string> = {
  pending: '○',
  running: '▶',
  paused: '⏸',
  done: '✓',
  failed: '✕',
  cancelled: '⊘',
}

/** 状态中文标签 — v3.0：面向用户的状态文案统一中文（诊断 S3） */
export const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: '等待中',
  running: '运行中',
  paused: '已暂停',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

/* v0.7.0：REACT_TYPE_COLOR / REACT_TYPE_LABEL 废除（ThoughtStream 不再使用大写标签+时间戳+等宽正文） */

/* ============================================================
 * v0.7.0 F741 — TOOL_DISPLAY 工具人性化映射
 * 所有工具卡文案唯一出处：toolName → { icon, verb, argSummary(args) }
 * 废除工程视角直出（大写标签 + 时间戳 + 原始参数串）
 * ============================================================ */
export interface ToolDisplay {
  /** v0.17.0：图标改为 Icon 组件名（零 emoji），组件层用 <Icon[name] /> 渲染 */
  icon: IconName
  verb: string
  argSummary: (args: Record<string, unknown>) => string
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s
}

function basename(p: string): string {
  const parts = String(p).split(/[/\\]/)
  return parts[parts.length - 1] || p
}

function hostOf(url: string): string {
  try {
    return new URL(String(url)).host
  } catch {
    return String(url)
  }
}

export const TOOL_DISPLAY: Record<string, ToolDisplay> = {
  'file-reader': {
    icon: 'File',
    verb: '读取文件',
    argSummary: (a) => basename(String(a.path ?? '')),
  },
  'file-writer': {
    icon: 'File',
    verb: '写入文件',
    argSummary: (a) => basename(String(a.path ?? '')),
  },
  'file-editor': {
    icon: 'File',
    verb: '编辑文件',
    argSummary: (a) => basename(String(a.path ?? '')),
  },
  'glob-search': {
    icon: 'Search',
    verb: '查找文件',
    argSummary: (a) => truncate(String(a.pattern ?? ''), 28),
  },
  'grep-search': {
    icon: 'Search',
    verb: '搜索内容',
    argSummary: (a) => truncate(String(a.pattern ?? ''), 28),
  },
  'web-search': {
    icon: 'Search',
    verb: '搜索网页',
    argSummary: (a) => `“${truncate(String(a.query ?? ''), 24)}”`,
  },
  'fetch-url': {
    icon: 'ExternalLink',
    verb: '访问页面',
    argSummary: (a) => hostOf(String(a.url ?? '')),
  },
  shell: {
    icon: 'Terminal',
    verb: '运行命令',
    argSummary: (a) => truncate(String(a.command ?? ''), 32),
  },
  'delegate-agent': {
    icon: 'Bot',
    verb: '委派给',
    argSummary: (a) => String(a.agentId ?? ''),
  },
  'session-search': {
    icon: 'Clock',
    verb: '检索历史',
    argSummary: (a) => `“${truncate(String(a.query ?? ''), 24)}”`,
  },
  task_complete: {
    icon: 'Check',
    verb: '完成任务',
    argSummary: () => '',
  },
  ask_user: {
    icon: 'Info',
    verb: '询问用户',
    argSummary: (a) => truncate(String(a.question ?? ''), 32),
  },
  // v0.21.0：清单更新工具人性化（此前走 fallback 显示机械名 todo_update）
  'todo-update': {
    icon: 'Check',
    verb: '更新清单',
    argSummary: (a) => {
      const idx = Number(a.item_index)
      const statusZh = { done: '完成', running: '进行中', pending: '待办', skipped: '跳过', failed: '失败', cancelled: '取消' }[String(a.status ?? '')] ?? String(a.status ?? '')
      return Number.isInteger(idx) && idx >= 0 ? `第 ${idx + 1} 项 → ${statusZh}` : statusZh
    },
  },
  todo_update: {
    icon: 'Check',
    verb: '更新清单',
    argSummary: (a) => {
      const idx = Number(a.item_index)
      const statusZh = { done: '完成', running: '进行中', pending: '待办', skipped: '跳过', failed: '失败', cancelled: '取消' }[String(a.status ?? '')] ?? String(a.status ?? '')
      return Number.isInteger(idx) && idx >= 0 ? `第 ${idx + 1} 项 → ${statusZh}` : statusZh
    },
  },
}

/**
 * v0.15.x — 工具参数 key 中文友好映射。
 * 解析 step.toolArgs 时，使用此表把常见英文 key 翻译成中文，
 * 让"详情"面板对用户更可读。
 * 未知 key 保持原名。
 */
export const ARG_KEY_LABEL: Record<string, string> = {
  path: '路径',
  query: '查询',
  url: '网址',
  command: '命令',
  question: '问题',
  agentId: '智能体',
  text: '内容',
  prompt: '提示词',
  context: '上下文',
  cwd: '目录',
  regex: '正则',
  replace: '替换',
  glob: '匹配模式',
}

export function argKeyLabel(key: string): string {
  return ARG_KEY_LABEL[key] ?? key
}

/**
 * 获取工具的人性化展示信息。
 * 缺省规则：MCP / 市场技能 / 蒸馏技能 → verb 取 toolName，argSummary 取第一个字符串参数。
 */
export function getToolDisplay(toolName: string, args: Record<string, unknown> = {}): ToolDisplay {
  if (TOOL_DISPLAY[toolName]) return TOOL_DISPLAY[toolName]
  // 缺省：用工具名自身 + 第一个字符串参数
  const firstStr = Object.values(args).find((v) => typeof v === 'string') as string | undefined
  return {
    icon: 'Bolt',
    verb: toolName,
    argSummary: (a) => {
      const v = Object.values(a).find((val) => typeof val === 'string') as string | undefined
      return v ? truncate(v, 32) : ''
    },
    // 传入 firstStr 仅避免 lint 警告
  } as ToolDisplay & { argSummary: (a: Record<string, unknown>) => string }
}

/* ============================================================
 * v0.14.x Task 2 — executionDescription
 * 把工具调用映射为面向用户的自然语言动作描述（带省略号，避免抖动）。
 * 不使用 transition/transform 控制，避免布局抖动；纯文案切换。
 * 用法：执行区（RunConsole / ConversationFlow 思考态）调用。
 * ============================================================ */
const EXEC_PHRASE_BY_TOOL: Record<string, string> = {
  // 引擎内置工具（工具名与 agent/registry.ts handlers 保持一致）
  shell: '正在运行命令…',
  'file-reader': '正在读取文件…',
  'file-writer': '正在写入文件…',
  'file-editor': '正在编辑文件…',
  'read_file': '正在读取文件…',
  'web-search': '正在检索网页…',
  'fetch-url': '正在获取网页内容…',
  'session-search': '正在检索历史…',
  'delegate-agent': '正在委派子任务…',
  // 知识库工具（kb-search / kb-enable 为真实工具名；kb_query/kb_index 为兼容别名）
  'kb-search': '正在查询知识库…',
  'kb-enable': '正在查询知识库…',
  kb_query: '正在查询知识库…',
  kb_index: '正在索引知识库…',
  // MCP / 市场技能等任意工具名无法逐一映射 → 走 fallback「外部工具」
  ask_user: '正在询问你…',
  task_complete: '正在整理回答…',
}

/** 未知工具（含 MCP 工具 / 市场技能）的兜底描述 */
const EXEC_PHRASE_FALLBACK = '正在调用外部工具…'

/**
 * 把工具名映射为"正在…"形式的自然语言描述。
 * 用于 RunConsole / ConversationFlow 等"执行中"区域，替代机械编号。
 */
export function executionDescription(toolName?: string | null): string {
  if (!toolName) return '正在分析你的请求…'
  return EXEC_PHRASE_BY_TOOL[toolName] ?? EXEC_PHRASE_FALLBACK
}

/** 思考 / 整理阶段文案（无工具调用时） */
export function reasoningDescription(stage: 'thinking' | 'finalizing' = 'thinking'): string {
  return stage === 'finalizing' ? '正在整理回答…' : '正在分析你的请求…'
}

/** Memory 层级描述 — v0.7.0 四层 */
export const MEMORY_LAYER_DESC: Record<string, string> = {
  L1: '工作记忆',
  L2: '产物记忆',
  L3: '知识记忆',
  L4: '经验记忆',
}

/** Memory 角色色 — v0.4.0 改用 CSS 变量 */
export const MEMORY_ROLE_COLOR: Record<string, string> = {
  system: 'var(--text-tertiary)',
  user: 'var(--accent)',
  assistant: 'var(--success)',
  tool: 'var(--warning)',
}

/** 文件状态色 — v0.4.0 改用 CSS 变量 */
export const FILE_STATUS_COLOR: Record<string, string> = {
  M: 'var(--warning)',
  A: 'var(--success)',
  D: 'var(--danger)',
  ' ': 'transparent',
}

/** 上下文占用色阶 — v0.4.0 改用 CSS 变量 */
export function contextColor(pct: number): string {
  if (pct > 95) return 'var(--danger)'
  if (pct > 80) return 'var(--warning)'
  return 'var(--text-secondary)'
}

/** Workspace 标签
 * v0.5.0（B9）：删除 WORKSPACE mock（ArkWork HQ / 42gb 等假数据）。
 * TopBar/StatusBar 一律读 store.activeWorkspace.name，不再使用此常量。 */

/** 通用快捷键（单一来源；CommandPalette 等展示用）
 * v0.5.0（B9）：toggleRight 由 ⌘J 修正为 ⌘E，与 App.tsx 实际监听一致 */
export const KBD = {
  newTask: '⌘N',
  search: '⌘K',
  toggleLeft: '⌘B',
  toggleRight: '⌘E',
  cmdPalette: '⌘K',
  attach: '⇧⌘F',
  memory: '⇧⌘M',
  kb: '⇧⌘K',
  advanced: '⇧⌘A',
}
