/* ============================================================
 * ArkWork — Renderer Global Store
 * 设计文档 §8.2
 * 状态管理：布局 / 导航 / 任务 / Agent / Memory / ReAct Trace / Logs
 * 数据加载通过 IPC 获取
 * ============================================================ */
import { create } from 'zustand'
import { ark } from './ipc/client'
import type { Task, TaskStatus } from '@shared/types/task'
import type { ReActStep } from '@shared/types/react'
import type {
  TaskProgress,
  TaskProgressMilestone,
  TaskProgressStepStatus,
} from '@shared/types/progress'
import type { MemoryItem } from '@shared/types/memory'
import type { Agent, Skill, McpServer, LlmModel, DockTabId, DockPreset } from '@shared/types/agent'
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
} from '@shared/types/ipc'
import type { PermissionMode, ResolvedRules } from '@shared/types/permission'
import type {
  ConversationItem,
  Automation,
  KnowledgeBase,
  PlanItemState,
  Suggestion,
} from '@shared/types/conversation'
import type { ToolConfirmRequest, ToolProgressEvent, ToolProgressClearEvent, ConfirmRespondReason, PlanItemStatusChanged } from '@shared/types/ipc'
import { shortTaskId, formatUpdatedAt } from './types'
import { simplifyFirstLine } from './utils/title'

/* ============================================================
 * friendlyError — 把后端/网络原始错误转译为用户可读文案（X4）
 * 规则：先匹配已知模式，未命中则返回原文（保留可调试性）
 *
 * v0.9.1 §Task 6：主进程 RunnerError.code 与 store 错误信息带 "noAgent:" / "noModel:"
 * 前缀，UI 层据此分流为「Agent/模型」明确提示而不是「任务失败」笼统文案。
 * ============================================================ */
export function friendlyError(err: unknown, fallback?: string): string {
  const raw = err instanceof Error ? err.message : String(err)
  const lower = raw.toLowerCase()
  // RunnerError.code 透传（若后端 IPC serialize 后保留 code 字段，优先用）
  if (err instanceof Error && 'code' in err) {
    const code = (err as Error & { code?: string }).code
    if (code === 'noAgent') return 'Agent 不存在或已被删除，请到智能体页面恢复后重试'
    if (code === 'noModel') return '模型未配置或不可用，请在设置中选择可用模型后再运行'
    if (code === 'invalidModel') return '所选模型已被删除或禁用，请在设置中重新选择模型'
    if (code === 'missingTask') return '找不到该任务，可能已被删除，请刷新任务列表'
  }
  // 任务/工具/模型未找到
  if (/^task not found|任务不存在/i.test(raw)) return '找不到该任务，可能已被删除，请刷新任务列表'
  if (/tool not found/i.test(raw)) return '工具未注册，请检查 Agent 的技能配置'
  // v0.9.1 §Task 6：识别 runner / store 加的 "noModel:" / "noAgent:" 前缀
  if (/^noagent:\s*agent 不存在/i.test(raw)) return 'Agent 不存在或已被删除，请到智能体页面恢复后重试'
  if (/^nomodel:\s*/i.test(raw)) return '模型未配置或不可用，请在设置中选择可用模型后再运行'
  if (/model not found|model 不可用|模型已禁用|invalidmodel/i.test(lower) || /model not found|no model|模型不可用/i.test(raw)) {
    return '模型未配置或已禁用，请在设置中检查'
  }
  if (/agent not found/i.test(lower)) return 'Agent 不存在或已被删除，请到智能体页面恢复后重试'
  // 网络类
  if (/econnrefused|connect econnrefused/i.test(lower)) return '无法连接到模型服务，请确认服务已启动且地址正确'
  if (/fetch failed|network|enotfound|etimedout|timeout|abort/i.test(lower)) return '网络请求失败，请检查网络或服务是否可达'
  if (/401|unauthorized|invalid api key/i.test(lower)) return '认证失败，请检查 API Key 是否正确'
  if (/429|rate limit/i.test(lower)) return '请求过于频繁，请稍后重试'
  // 文件类
  if (/file not found|enoent/i.test(lower)) return '文件不存在或路径无效'
  // 权限/沙盒类：工作区目录不可写（EPERM/EACCES——常见于从终端受限启动时）
  if (/eperm|eacces|operation not permitted|permission denied|工作区目录不可写|无法写入工作区/i.test(lower)) {
    return '工作区目录不可写（系统权限限制）。若应用是从终端启动，请改用 "open" 命令或双击应用图标启动'
  }
  // 模型服务端错误：402 余额不足等
  if (/402|insufficient\s*balance|余额不足/i.test(raw)) {
    return '模型账户余额不足，请到对应平台充值后重试'
  }
  return fallback ?? raw
}

/* ============================================================
 * 视图类型
 * v0.7.0：右栏下线，Activity Bar + SidePanel 上位
 * ============================================================ */
/** v0.7.0：Activity Bar 五面板 */
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
 */
export type InspectorTabId = 'todos' | 'context' | 'files' | 'logs' | 'browser'

/** Inspector Tab 元信息（标签 + 图标 + ⌥ 快捷键）
 * icon 字段为 IconName 字符串（来自 icons.tsx 的 SVG 图标名），不使用 emoji。
 * Task 5：⌥1~5 映射到五个固定 Tab（已无 ⌥6）。
 */
export const INSPECTOR_TAB_META: Record<InspectorTabId, { label: string; icon: string; shortcut: string }> = {
  todos:   { label: '清单',   icon: 'Check',   shortcut: '⌥1' },
  context: { label: '上下文', icon: 'Box',     shortcut: '⌥2' },
  files:   { label: '文件',   icon: 'Folder',  shortcut: '⌥3' },
  logs:    { label: '日志',   icon: 'List',    shortcut: '⌥4' },
  browser: { label: '浏览器', icon: 'Eye',     shortcut: '⌥5' },
}

/** Inspector 固定 Tab 顺序 — Task 5：清单 / 上下文 / 文件 / 日志 / 浏览器 */
export const INSPECTOR_TAB_ORDER: InspectorTabId[] = ['todos', 'context', 'files', 'logs', 'browser']

/** Inspector 默认 Tab — 选 todos（最普适，Plan ↔ Todos 同步链路核心） */
export const DEFAULT_INSPECTOR_TAB: InspectorTabId = 'todos'

/** v0.17.0 F13：清洗持久化的 Tab 顺序（去重、补缺、剔除非法项，保证 5 个 Tab 齐全） */
function sanitizeInspectorOrder(raw: unknown): InspectorTabId[] {
  const valid = INSPECTOR_TAB_ORDER
  if (!Array.isArray(raw)) return [...valid]
  const seen = new Set<InspectorTabId>()
  const out: InspectorTabId[] = []
  for (const t of raw) {
    if ((valid as string[]).includes(t as string) && !seen.has(t as InspectorTabId)) {
      seen.add(t as InspectorTabId)
      out.push(t as InspectorTabId)
    }
  }
  for (const t of valid) if (!seen.has(t)) out.push(t)
  return out
}

/** v0.17.0 F13：清洗持久化的隐藏 Tab（Browser 永远不可隐藏） */
function sanitizeHiddenTabs(raw: unknown): InspectorTabId[] {
  if (!Array.isArray(raw)) return []
  const valid = INSPECTOR_TAB_ORDER
  return raw.filter(
    (t) => (valid as string[]).includes(t as string) && t !== 'browser',
  ) as InspectorTabId[]
}

/** v0.9.0 F901：RightDock 用户偏好（按 工作区 × 智能体 记忆） */
export interface DockPrefs {
  tabs: DockTabId[]
  defaultTab: DockTabId
  /** 用户手动增删/排序/隐藏过 Tab 后置位——该智能体预设不再覆盖用户偏好 */
  customized: boolean
}

/** v0.9.0 F905：通用默认预设（用户自建智能体 / 无预设旧数据回落） */
export const DEFAULT_PRESET: DockPreset = {
  tabs: ['files', 'context', 'todos', 'terminal', 'browser'],
  defaultTab: 'files',
}

/** v0.9.0 F905：内置智能体 Dock 预设（doc 03 §3） */
export const AGENT_DOCK_PRESETS: Record<string, DockPreset> = {
  '@default': DEFAULT_PRESET,
  '@coder': { tabs: ['files', 'terminal', 'browser', 'todos', 'context'], defaultTab: 'terminal' },
  '@code-reviewer': { tabs: ['files', 'browser', 'todos', 'context', 'terminal'], defaultTab: 'files' },
  '@researcher': { tabs: ['browser', 'context', 'files', 'todos'], defaultTab: 'browser' },
  '@writer': { tabs: ['context', 'browser', 'files', 'todos'], defaultTab: 'context' },
}

/** v0.9.0 F901：Dock Tab 展示元信息 */
export const DOCK_TAB_META: Record<DockTabId, { label: string; icon: string; shortcut: string }> = {
  files: { label: '文件', icon: 'Folder', shortcut: '⌥1' },
  context: { label: '上下文', icon: 'Box', shortcut: '⌥2' },
  terminal: { label: '终端', icon: 'Terminal', shortcut: '⌥3' },
  browser: { label: '浏览器', icon: 'ExternalLink', shortcut: '⌥4' },
  todos: { label: '任务清单', icon: 'List', shortcut: '⌥5' },
  // Task 9：任务侧边栏进度摘要
  progress: { label: '进度', icon: 'ListChecks', shortcut: '⌥6' },
}

/** v0.9.0 F905：Dock 预设的 Tab 顺序（用于 ⌥1~5 视觉顺序映射与约束检查） */
export const DOCK_TAB_ORDER: DockTabId[] = ['files', 'context', 'terminal', 'browser', 'todos', 'progress']

/** v0.9.0 F904：模型健康态（三处同源消费：Composer chip / TaskTitleBar chip / StatusBar） */
export type ModelHealth = 'unconfigured' | 'ok' | 'missing' | 'disabled'

/**
 * v0.9.0 F904：modelHealth selector — 从 models + selectedModelId 派生统一警示态。
 * - unconfigured：没有任何模型
 * - ok：当前模型存在且启用
 * - missing：当前模型已被删除（灰化 + 引导重选）
 * - disabled：当前模型存在但被禁用
 */
export function computeModelHealth(
  models: LlmModel[],
  selectedModelId: string,
): ModelHealth {
  if (models.length === 0) return 'unconfigured'
  if (!selectedModelId) return 'missing'
  const m = models.find((x) => x.id === selectedModelId)
  if (!m) return 'missing'
  if (!m.enabled) return 'disabled'
  return 'ok'
}

/* ============================================================
 * v0.7.0 F710 — PreviewWindow 浮窗状态
 * ============================================================ */
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

/* ============================================================
 * v0.5.0 — 反馈系统类型（Toast / CtxChip / ConfirmDialog）
 * 对齐系统设计文档 §4.1–§4.3
 * ============================================================ */

/** 全局 Toast 通知（B2）
 * Phase A Task 4：新增 level 字段以分级路由（critical / info / silent）。
 *   - silent：仅记录日志，不展示 UI（用于工具预算软警告等系统噪音）
 *   - info：常规通知（默认）
 *   - critical：真正需要用户介入的错误（模型错误 / 权限被拒绝等）
 */
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
}

/** ConfirmDialog 内部状态（含回调） */
export interface ConfirmDialogState extends Required<ConfirmDialogOpts> {
  open: boolean
  onConfirm: () => void
}

const WORKSPACES_KEY = 'arkwork:workspaces'
const ACTIVE_WS_KEY = 'arkwork:active-workspace'

function loadWorkspaces(): Workspace[] {
  try {
    const raw = localStorage.getItem(WORKSPACES_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Workspace[]
      if (Array.isArray(parsed) && parsed.length > 0) {
        // 兼容旧数据：无 path 字段补空字符串
        return parsed.map((w) => ({ ...w, path: w.path ?? '' }))
      }
    }
  } catch { /* fall through */ }
  return [{ id: 'default', name: '默认工作区', path: '', createdAt: Date.now() }]
}

function saveWorkspaces(list: Workspace[]): void {
  try { localStorage.setItem(WORKSPACES_KEY, JSON.stringify(list)) } catch { /* ignore */ }
}

function loadActiveWorkspace(): string {
  try {
    return localStorage.getItem(ACTIVE_WS_KEY) || 'default'
  } catch { return 'default' }
}

function saveActiveWorkspace(id: string): void {
  try { localStorage.setItem(ACTIVE_WS_KEY, id) } catch { /* ignore */ }
}

/* ============================================================
 * v0.9.0 — ui-state 持久化（按工作区隔离，对齐 ui-state.json 语义）
 * ============================================================ */
const uiKey = (k: string) => `arkwork:ui:${k}:${loadActiveWorkspace() || 'default'}`

function loadUiState<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(uiKey(key))
    if (raw != null) return JSON.parse(raw) as T
  } catch { /* ignore */ }
  return fallback
}

function saveUiState<T>(key: string, val: T): void {
  try { localStorage.setItem(uiKey(key), JSON.stringify(val)) } catch { /* ignore */ }
}

/** v0.13.0：宽度持久化值在读取时钳制到合法范围，避免脏数据把布局挤爆 */
function clampWidth(value: unknown, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : min
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** v0.9.0 F905：解析某智能体的有效 Dock 布局（预设 × 用户偏好） */
function resolveDockLayout(agentId: string, prefs: DockPrefs | undefined): { tabs: DockTabId[]; defaultTab: DockTabId } {
  // 用户偏好覆盖优先（customized 置位后预设不再生效）
  if (prefs?.customized && prefs.tabs.length >= 2) {
    const tabs: DockTabId[] = prefs.tabs.includes('browser') ? prefs.tabs : [...prefs.tabs, 'browser']
    const defaultTab: DockTabId = tabs.includes(prefs.defaultTab) ? prefs.defaultTab : tabs[0]
    return { tabs, defaultTab }
  }
  // 智能体声明的 dockPreset → 内置预设表 → DEFAULT_PRESET
  const preset = AGENT_DOCK_PRESETS[agentId] ?? DEFAULT_PRESET
  const tabs = (preset.tabs ?? DEFAULT_PRESET.tabs).filter((t) => t !== undefined)
  const effective = tabs.length >= 2 ? tabs : DEFAULT_PRESET.tabs
  const defaultTab = effective.includes(preset.defaultTab) ? preset.defaultTab : effective[0]
  return { tabs: effective, defaultTab }
}

/* v0.5.0（B5）：删除 DEFAULT_AUTOMATIONS / DEFAULT_KB mock 数据。
 * automations / knowledgeBases 初始为空数组，由 AutomationsPanel 渲染「即将上线」空态。 */

/* ============================================================
 * 工具函数：从 steps 派生 ConversationItem[]
 *
 * v0.4.0 修正（F108）：空任务（input.text==='' && steps.length===0）
 * 直接返回 []，不推 user 条目——杜绝初始页"时间 + YOU + 空气泡"。
 * 该空态由 CenterStage 的 ConversationGreeting 接管渲染。
 *
 * v0.15.0 Task 7：删除此前的 generateNextStepSuggestions 硬编码映射函数（按工具名猜建议）。
 * 下一步建议完全由 LLM 在调用 task_complete 时通过 args.suggestions 自主生成。
 * ============================================================ */
function deriveConversation(
  task: Task | null,
  steps: ReActStep[],
  memory: MemoryItem[] = [],
): ConversationItem[] {
  if (!task) return []

  // v0.4.0-rev6：按时间戳合并 user_message 和 react 步骤组，避免多轮对话顺序错乱。
  // rev5 把所有 user_message 堆在开头、react 堆在后面，导致 [u1,u2,r1,r2] 而非 [u1,r1,u2,r2]。

  // 1. 从 memory 读取 user_message（过滤空 content 和 archived），按 createdAt 排序
  const userMessages = memory
    .filter((m) => m.kind === 'user_message' && m.content !== '' && !m.archivedAt)
    .sort((a, b) => a.createdAt - b.createdAt)

  // 旧任务兼容：memory 为空时回退到 task.input.text 作为单条用户消息
  const userEvents: ConversationItem[] = []
  if (userMessages.length > 0) {
    for (const m of userMessages) {
      userEvents.push({
        id: `${task.id}-user-${m.id}`,
        type: 'user',
        text: m.content,
        ts: m.createdAt,
        tsLabel: formatTimeLabel(m.createdAt),
      })
    }
  } else if (task.input.text !== '') {
    userEvents.push({
      id: `${task.id}-user`,
      type: 'user',
      text: task.input.text,
      ts: task.createdAt,
      tsLabel: formatTimeLabel(task.createdAt),
    })
  }

  // 2. v0.8.0：计划清单条目（TraeWork 式）——从全部步骤提取 plan 步骤并派生逐项状态
  const planStep = steps.find((s) => s.type === 'plan' && s.plan)
  let planItem: ConversationItem | null = null
  if (planStep?.plan) {
    const items = planStep.plan.items
    planItem = {
      id: `${task.id}-plan`,
      type: 'plan',
      plan: planStep.plan,
      // v0.14.x Task 1：传任务状态 —— 只有任务真正 done（或 task_complete 事件）
      // 才允许全部勾完；避免"AI 还在执行清单却已勾完"（重跑时旧 reason 残留会误判）
      planStates: derivePlanStates(items, steps, task.status),
      ts: planStep.startedAt,
      tsLabel: formatTimeLabel(planStep.startedAt),
    }
  }

  // 3. 按 iteration 分组 reason/act/observation，每组作为带 ts 的事件
  // v0.8.0：plan 步骤单独作为清单条目（见上），不进入 react 分组，避免空步骤流
  const byIter = new Map<number, ReActStep[]>()
  for (const s of steps) {
    if (s.type === 'plan') continue
    const arr = byIter.get(s.iteration) ?? []
    arr.push(s)
    byIter.set(s.iteration, arr)
  }
  const iters = Array.from(byIter.keys()).sort((a, b) => a - b)

  type ReactEvent = { ts: number; items: ConversationItem[] }
  const reactEvents: ReactEvent[] = []
  for (const iter of iters) {
    const group = byIter.get(iter)!.sort((a, b) => a.startedAt - b.startedAt)
    const reasonStep = group.find((s) => s.type === 'reason')
    const isComplete = reasonStep?.action?.tool === 'task_complete'
    // 最终回复：task_complete 或无 action（模型直接回复未调用工具）
    const isFinalAnswer = isComplete || !reasonStep?.action
    const ts = reasonStep?.startedAt ?? group[0]?.startedAt ?? 0

    const items: ConversationItem[] = [{
      id: `${task.id}-react-${iter}`,
      type: 'react',
      steps: group,
      ts,
      tsLabel: formatTimeLabel(ts),
    }]

    if (isFinalAnswer && reasonStep) {
      items.push({
        id: `${task.id}-final-${iter}`,
        type: 'assistant',
        text: isComplete
          ? (reasonStep.action?.args?.summary as string) ?? reasonStep.thought ?? ''
          : reasonStep.thought ?? '',
        ts: reasonStep.startedAt,
        tsLabel: formatTimeLabel(reasonStep.startedAt),
      })
    }
    reactEvents.push({ ts, items })
  }

  // 4. 空任务（无用户消息 + 无 react）返回空，由 ConversationGreeting 接管
  if (userEvents.length === 0 && reactEvents.length === 0 && !planItem) {
    return []
  }

  // 5. 按时间戳合并所有事件（计划清单插在用户消息之后、首个 react 之前）
  const allEvents: { ts: number; item: ConversationItem | ConversationItem[] }[] = [
    ...userEvents.map((e) => ({ ts: e.ts ?? 0, item: e as ConversationItem })),
    ...(planItem ? [{ ts: planItem.ts ?? 0, item: planItem }] : []),
    ...reactEvents.map((e) => ({ ts: e.ts, item: e.items })),
  ]
  allEvents.sort((a, b) => a.ts - b.ts)

  const result: ConversationItem[] = []
  for (const ev of allEvents) {
    if (Array.isArray(ev.item)) {
      result.push(...ev.item)
    } else {
      result.push(ev.item)
    }
  }
  return result
}

function formatTimeLabel(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

/* ============================================================
 * v0.14.0 Task 4 — 统一 plan 派生 util
 *   - derivePlanItems(steps)  → 计划项（仅真实 plan.items；无 plan 时返回空）
 *   - derivePlanStates(items, steps) → 逐项状态
 *
 * 之前 CenterStage 的 PlanBar 与 store.derivePlanProgress 各自派生，
 * 数据源重复且 fallback 不一致；现统一收敛到 store 层导出，
 * 对话内 PlanMessage 与 TodoPanel 共用同一结果。无真实 plan 时不再展示
 * 兜底 5 步，保持清单与真实计划严格一致。
 * ============================================================ */

/** v0.14.0 Task 4：派生计划项 — 仅取真实 plan.items；无真实计划时返回空数组 */
export function derivePlanItems(steps: ReActStep[]): string[] {
  const planStep = steps.find((s) => s.type === 'plan' && s.plan)
  if (planStep?.plan && planStep.plan.items.length > 0) return planStep.plan.items
  return []
}

/**
 * v0.14.0 Task 4：派生逐项状态（被 deriveConversation / TodoPanel 共用）。
 * 规则（Task 1 — 统一 plan 状态源 + 禁止提前勾完）：
 *  - 终态判定：仅当任务状态为 done（或 steps 中出现 task_complete 事件）→ 全部 done。
 *    不再以"某轮 reason 未带 action"作为最终答复判定——模型可能在中间轮次只思考不调
 *    工具、随后继续执行（典型：重跑任务时旧步骤仍残留无 action 的 reason），此时绝不能
 *    提前把清单勾完。
 *  - 任务已失败：优先按 failed act 回写 failed 项、后续保持 pending；无具体 failed act
 *    时（达到迭代上限 / 异常中止）把当前推进到的分段呈现为 failed 而非 running。
 *  - 否则按 act 步骤实际状态推进：
 *      · 当前还在跑（status='running'）→ 对应项 running
 *      · 最近一次 act 失败（status='failed' 且无后续成功 act）→ 对应项 failed
 *      · 已完成 act 按"工具切换分段"累计 phase，phase-1 之前的项 done
 *  - 永远不允许"phase 已 ≥ items.length 时全部标记 done"——超出部分保持 pending，
 *    AI 仍在执行时绝不预先勾完
 *  - 无任何 act → 全部 pending
 */
export function derivePlanStates(
  items: string[],
  steps: ReActStep[],
  taskStatus?: TaskStatus,
): PlanItemState[] {
  const pending: PlanItemState[] = items.map(() => 'pending')
  if (items.length === 0 || steps.length === 0) return pending

  // 终态判定：任务真正完成或出现 task_complete 事件才允许全部勾完
  const hasTaskComplete = steps.some(
    (s) =>
      (s.type === 'reason' && s.action?.tool === 'task_complete') ||
      (s.type === 'act' && s.toolName === 'task_complete'),
  )
  if (taskStatus === 'done' || hasTaskComplete) return items.map(() => 'done')

  const allActs = steps
    .filter((s) => s.type === 'act')
    .sort((a, b) => a.startedAt - b.startedAt)

  if (allActs.length === 0) return pending

  // 任务已终态失败时不再呈现 running（语义终态化）
  const isTerminalFailed = taskStatus === 'failed'

  // 仍在执行中的 act：标记对应项为 running
  const runningAct = !isTerminalFailed && allActs.find((a) => a.status === 'running')
  if (runningAct) {
    // 当前 running 之前已完成多少个工具分段
    const completed = allActs.filter((a) => a.status === 'success' && a.startedAt < runningAct.startedAt)
    const phase = countToolSegments(completed)
    // phase = 已完成的工具分段数；下一个分段 = phase（即将进入的 running 项）
    const currentIdx = clamp(phase, 0, items.length - 1)
    return items.map((_, i) => {
      if (i < currentIdx) return 'done'
      if (i === currentIdx) return 'running'
      return 'pending'
    })
  }

  // 无 running：找到最近一次失败 act（其后无成功 act）
  const lastSuccessIdx = lastIndexWhere(allActs, (a) => a.status === 'success')
  const failedAct = allActs.find(
    (a) => a.status === 'failed' && (lastSuccessIdx < 0 || allActs.indexOf(a) > lastSuccessIdx),
  )
  if (failedAct) {
    const completed = allActs.filter((a) => a.status === 'success')
    const phase = countToolSegments(completed)
    const currentIdx = clamp(phase, 0, items.length - 1)
    return items.map((_, i) => {
      if (i < currentIdx) return 'done'
      if (i === currentIdx) return 'failed'
      return 'pending'
    })
  }

  // 仅成功 acts：按"已完成 act 数"对齐 plan items。
  // v0.16.5 修复：原实现按"工具切换分段数"作为进度。当 plan 有 12 项但
  // agent 实际只跑了 5 个文件写入时，工具分段数也会到达 12-1=11 导致 UI
  // 全部勾 done（"提前勾完"）。现在改为直接按成功 act 数对齐：
  //  - 已完成的成功 act 数 = currentIdx（第 currentIdx 项当前正在执行）
  //  - currentIdx 不能超过 items.length，超出部分保持 running
  //  - 失败时当前项标 failed
  const successActs = allActs.filter((a) => a.status === 'success')
  // v0.16.6：用工具切换分段而不是直接 act 数，避免一个 plan 项被多个
  // 连续同工具 act（如 file-writer × 3 次）误推进多项。取工具分段数与
  // plan 项数二者的最小值作为 currentIdx。
  const toolSegments = countToolSegments(successActs)
  // currentIdx = 已经"完成"的工具分段数；下一分段对应项 = running
  // 当 toolSegments 超过 items.length 时，把最后一项保持 running，避免提前勾完
  const currentIdx = toolSegments >= items.length ? items.length - 1 : toolSegments
  // 任务失败但无具体 failed act（达到迭代上限 / 异常中止）：终态呈现为 failed 而非 running
  const currentState: PlanItemState = isTerminalFailed ? 'failed' : 'running'
  return items.map((_, i) => {
    if (i < currentIdx) return 'done'
    if (i === currentIdx) return currentState
    return 'pending'
  })
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min
  if (value > max) return max
  return value
}

/** 统计 act 序列中"切换工具"的次数 = 已完成的工具分段数 */
function countToolSegments(acts: ReActStep[]): number {
  let phase = 0
  let prevTool = ''
  for (const a of acts) {
    const t = a.toolName ?? ''
    if (t !== prevTool) {
      phase += 1
      prevTool = t
    }
  }
  return phase
}

function lastIndexWhere<T>(arr: T[], pred: (item: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    if (pred(arr[i])) return i
  }
  return -1
}

/* ============================================================
 * Store
 * ============================================================ */
interface AppState {
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

  // ---- ReAct Trace ----
  steps: ReActStep[]
  refreshSteps: (taskId: string) => Promise<void>
  toggleStep: (id: string) => void
  appendStep: (step: ReActStep) => void
  updateStep: (step: ReActStep) => void

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

  // ---- 初始化 ----
  init: () => Promise<void>

  // ---- 事件订阅 ----
  subscribeAll: () => () => void
}

/* ============================================================
 * 主题辅助函数（v0.4.0）
 *
 * applyThemeClass：根据 (theme, systemTheme) 计算 resolved 并切换 <html class="dark">
 *   - theme==='dark'                     → resolved='dark'
 *   - theme==='light'                    → resolved='light'
 *   - theme==='system' && system==='dark'→ resolved='dark'
 *   - theme==='system' && system==='light'→ resolved='light'
 * ============================================================ */

/** v0.7.0 F711：根据文件扩展名检测渲染器类型 */
export function detectRenderer(path: string): RendererKind {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (ext === 'html' || ext === 'htm') return 'browser'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp'].includes(ext)) return 'image'
  if (ext === 'svg') return 'svg'
  if (ext === 'csv' || ext === 'tsv') return 'table'
  // v0.9.1：补 txt/log/xml 等纯文本扩展（此前 .txt 落入 fallback「不支持的预览类型」）
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'json', 'css', 'scss', 'less', 'go', 'rs', 'java', 'kt', 'swift', 'rb', 'php', 'c', 'cpp', 'h', 'hpp', 'cs', 'vue', 'svelte', 'yaml', 'yml', 'toml', 'ini', 'sh', 'bash', 'zsh', 'sql', 'dockerfile', 'makefile', 'lua', 'r', 'dart', 'txt', 'log', 'xml', 'text', 'cfg', 'conf', 'env', 'properties', 'gitignore', 'editorconfig'].includes(ext)) return 'code'
  return 'fallback'
}
function applyThemeClass(theme: ThemeMode, systemTheme: ResolvedTheme): ResolvedTheme {
  const resolved: ResolvedTheme =
    theme === 'system' ? systemTheme : theme
  const root = document.documentElement
  if (resolved === 'dark') root.classList.add('dark')
  else root.classList.remove('dark')
  return resolved
}

export const useStore = create<AppState>((set, get) => ({
  // v0.7.0 布局：Activity Bar + SidePanel
  // v0.13.0：Sidebar 默认 240（对齐 01-information-architecture.md §2），范围 64–320
  sidePanelWidth: clampWidth(loadUiState('sidepanel-w', 240), 64, 320),
  sidePanelCollapsed: false,
  activeActivity: 'tasks',
  setSidePanelWidth: (w) => {
    const clamped = Math.min(320, Math.max(64, Math.round(w))) // v0.13.0：64–320
    saveUiState('sidepanel-w', clamped)
    set({ sidePanelWidth: clamped })
  },
  toggleSidePanel: () => set((s) => ({ sidePanelCollapsed: !s.sidePanelCollapsed })),
  setActiveActivity: (a) =>
    set((s) => ({
      // 点击当前已激活的 activity 时 toggle 折叠
      activeActivity: s.activeActivity === a && !s.sidePanelCollapsed ? s.activeActivity : a,
      sidePanelCollapsed: s.activeActivity === a ? !s.sidePanelCollapsed : false,
    })),
  // 兼容旧代码（leftWidth 也钳制到 Sidebar 范围 64–320，绝不可反向扩张到 480）
  leftWidth: 240,
  leftCollapsed: false,
  setLeftWidth: (w) => {
    const clamped = Math.min(320, Math.max(64, Math.round(w))) // v0.13.0：必须与 Sidebar 一致 64–320
    saveUiState('sidepanel-w', clamped)
    set({ sidePanelWidth: clamped })
  },
  toggleLeft: () => set((s) => ({ sidePanelCollapsed: !s.sidePanelCollapsed, leftCollapsed: !s.leftCollapsed })),
  rightCollapsed: true,  // v0.7.0：右栏已下线
  rightWidth: 360,
  setRightWidth: (w) => set({ rightWidth: Math.min(560, Math.max(320, w)) }),
  toggleRight: () => set((s) => ({ rightCollapsed: !s.rightCollapsed })),
  openRight: (tab) => set((s) => ({ rightCollapsed: false, rightTab: tab ?? s.rightTab })),
  closeRight: () => set({ rightCollapsed: true }),

  // ============================================================
  // v0.9.0 F900 — LeftNav
  // ============================================================
  leftNavCollapsed: loadUiState('leftnav', false),
  toggleLeftNav: () =>
    set((s) => {
      const next = !s.leftNavCollapsed
      saveUiState('leftnav', next)
      return { leftNavCollapsed: next }
    }),
  setLeftNavCollapsed: (b) => {
    saveUiState('leftnav', b)
    set({ leftNavCollapsed: b })
  },

  // ============================================================
  // v0.9.0 F901 — RightDock
  // ============================================================
  rightDockCollapsed: loadUiState('rightdock', false),
  // v0.13.0：Inspector 默认 360（对齐 01-information-architecture.md §2），范围 280–480
  rightDockWidth: clampWidth(loadUiState('rightdock-w', 360), 280, 480),
  activeDockTab: 'files',
  // fix-workspace-task-automation-memory Task 5：Inspector 默认 Todos
  inspectorTab: DEFAULT_INSPECTOR_TAB,
  setInspectorTab: (t) => set({ inspectorTab: t }),
  inspectorTabOrder: sanitizeInspectorOrder(loadUiState('inspector-tab-order', INSPECTOR_TAB_ORDER)),
  hiddenInspectorTabs: sanitizeHiddenTabs(loadUiState('inspector-tab-hidden', [])),
  setInspectorTabOrder: (order) => {
    const clean = sanitizeInspectorOrder(order)
    saveUiState('inspector-tab-order', clean)
    set({ inspectorTabOrder: clean })
  },
  hideInspectorTab: (tab) =>
    set((s) => {
      if (tab === 'browser' || s.hiddenInspectorTabs.includes(tab)) return {}
      const hidden = [...s.hiddenInspectorTabs, tab]
      saveUiState('inspector-tab-hidden', hidden)
      // 隐藏当前激活 Tab 时，切到首个仍可见的 Tab
      const nextInspectorTab =
        s.inspectorTab === tab
          ? (s.inspectorTabOrder.find((t) => t !== tab && !hidden.includes(t)) ?? 'todos')
          : s.inspectorTab
      return { hiddenInspectorTabs: hidden, inspectorTab: nextInspectorTab }
    }),
  restoreInspectorTab: (tab) =>
    set((s) => {
      const hidden = s.hiddenInspectorTabs.filter((t) => t !== tab)
      saveUiState('inspector-tab-hidden', hidden)
      return { hiddenInspectorTabs: hidden }
    }),
  toggleRightDock: () =>
    set((s) => {
      const next = !s.rightDockCollapsed
      saveUiState('rightdock', next)
      return { rightDockCollapsed: next }
    }),
  setRightDockWidth: (w) => {
    const clamped = Math.min(480, Math.max(280, Math.round(w))) // v0.13.0：280–480px
    saveUiState('rightdock-w', clamped)
    set({ rightDockWidth: clamped })
  },
  setActiveDockTab: (t) => set({ activeDockTab: t }),
  openDockTab: (t) =>
    set((s) => {
      // Tab 不在当前智能体的有效集合中则忽略
      if (!s.dockTabs.includes(t)) return {}
      return { rightDockCollapsed: false, activeDockTab: t }
    }),
  dockTabs: resolveDockLayout(loadActiveWorkspace() === '' ? '' : '', undefined).tabs,
  dockDefaultTab: resolveDockLayout(loadActiveWorkspace() === '' ? '' : '', undefined).defaultTab,
  dockPrefs: loadUiState<Record<string, DockPrefs>>('dockprefs', {}),
  setDockPrefs: (agentId, prefs) =>
    set((s) => {
      const next = { ...s.dockPrefs, [agentId]: prefs }
      saveUiState('dockprefs', next)
      // 更新生效布局
      const layout = resolveDockLayout(agentId, prefs)
      return {
        dockPrefs: next,
        dockTabs: layout.tabs,
        dockDefaultTab: layout.defaultTab,
      }
    }),
  resetDockPrefs: (agentId) =>
    set((s) => {
      const next = { ...s.dockPrefs }
      delete next[agentId]
      saveUiState('dockprefs', next)
      const layout = resolveDockLayout(agentId, undefined)
      return {
        dockPrefs: next,
        dockTabs: layout.tabs,
        dockDefaultTab: layout.defaultTab,
      }
    }),
  dockNotice: null,
  setDockNotice: (msg) => set({ dockNotice: msg }),

  // ============================================================
  // v0.9.0 F900 — 全局模块页
  // ============================================================
  modulePage: null,
  prevRightDockOpen: true,
  // redesign-workspace-navigation Task 3：
  //  - 切换到不同 page → 打开新页面
  //  - 单击当前 page → 保持打开（spec：再次单击当前入口 → 页面保持打开，
  //    不出现无意义折叠层或空白状态）。如需关闭请用 closeModulePage 或右上角关闭按钮。
  openModulePage: (page) =>
    set((s) => {
      if (s.modulePage === page) return {} // 重复点击：保持打开
      return {
        modulePage: page,
        // 从无 page 打开 → 记录"用户原本的 rightDock 状态"（模块页内强制折叠）
        // 从已有 page 切换 → 保留之前的 prevRightDockOpen，避免被中间折叠态覆盖
        prevRightDockOpen: s.modulePage === null ? !s.rightDockCollapsed : s.prevRightDockOpen,
        rightDockCollapsed: true,
      }
    }),
  closeModulePage: () =>
    set((s) => ({
      modulePage: null,
      // 回任务时恢复 RightDock
      rightDockCollapsed: s.prevRightDockOpen ? false : s.rightDockCollapsed,
    })),

  // v0.7.0 F710：PreviewWindow 浮窗
  previewWindow: null,
  minimizedPreviews: [],
  openPreview: async (path, opts) => {
    const renderer = detectRenderer(path)
    const tabId = `tab-${Date.now()}`
    const existing = get().previewWindow
    if (existing) {
      // 已有浮窗：添加 Tab
      const newTab: PreviewTab = {
        id: tabId,
        target: { kind: 'file', path },
        renderer,
        mode: opts?.pinned ? 'pinned' : 'preview',
      }
      set({
        previewWindow: {
          ...existing,
          tabs: [...existing.tabs, newTab],
          activeTabId: tabId,
        },
      })
    } else {
      // 新建浮窗
      set({
        previewWindow: {
          id: `pw-${Date.now()}`,
          bounds: { x: 120, y: 80, w: 720, h: 520 },
          pinned: false,
          tabs: [{
            id: tabId,
            target: { kind: 'file', path },
            renderer,
            mode: opts?.pinned ? 'pinned' : 'preview',
          }],
          activeTabId: tabId,
        },
      })
    }
  },
  closePreview: () => set({ previewWindow: null }),
  /** v0.9.0 F903：以 URL 打开 PreviewWindow 浮窗（浏览器面板「在浮窗打开」） */
  openPreviewUrl: (url: string) =>
    set((s) => {
      const tabId = `tab-${Date.now()}`
      const tab: PreviewTab = { id: tabId, target: { kind: 'url', url }, renderer: 'browser', mode: 'preview' }
      if (s.previewWindow) {
        return {
          previewWindow: {
            ...s.previewWindow,
            tabs: [...s.previewWindow.tabs, tab],
            activeTabId: tabId,
          },
        }
      }
      return {
        previewWindow: {
          id: `pw-${Date.now()}`,
          bounds: { x: 120, y: 80, w: 720, h: 520 },
          pinned: false,
          tabs: [tab],
          activeTabId: tabId,
        },
      }
    }),
  togglePreviewPin: () =>
    set((s) => ({
      previewWindow: s.previewWindow ? { ...s.previewWindow, pinned: !s.previewWindow.pinned } : null,
    })),
  minimizePreview: () =>
    set((s) => {
      if (!s.previewWindow) return {}
      const pw = s.previewWindow
      const activeTab = pw.tabs.find((t) => t.id === pw.activeTabId)
      const capsule: MinimizedCapsule = {
        id: pw.id,
        title: activeTab?.target.kind === 'file' ? activeTab.target.path.split('/').pop() || '预览' : '预览',
        icon: 'File',
        tabCount: pw.tabs.length,
      }
      return {
        previewWindow: null,
        minimizedPreviews: [...s.minimizedPreviews, capsule],
      }
    }),
  restoreMinimized: (id) =>
    set((s) => {
      const capsule = s.minimizedPreviews.find((c) => c.id === id)
      if (!capsule) return {}
      return {
        minimizedPreviews: s.minimizedPreviews.filter((c) => c.id !== id),
        previewWindow: {
          id: capsule.id,
          bounds: { x: 120, y: 80, w: 720, h: 520 },
          pinned: false,
          tabs: [],
          activeTabId: '',
        },
      }
    }),
  closePreviewTab: (tabId) =>
    set((s) => {
      if (!s.previewWindow) return {}
      const tabs = s.previewWindow.tabs.filter((t) => t.id !== tabId)
      if (tabs.length === 0) return { previewWindow: null }
      const activeTabId = s.previewWindow.activeTabId === tabId ? tabs[0].id : s.previewWindow.activeTabId
      return { previewWindow: { ...s.previewWindow, tabs, activeTabId } }
    }),
  setActivePreviewTab: (tabId) =>
    set((s) => ({
      previewWindow: s.previewWindow ? { ...s.previewWindow, activeTabId: tabId } : null,
    })),
  updatePreviewBounds: (bounds) =>
    set((s) => ({
      previewWindow: s.previewWindow ? { ...s.previewWindow, bounds } : null,
    })),

  // v0.7.0 F714：⌘P 快速打开
  quickOpenOpen: false,
  setQuickOpenOpen: (b) => set({ quickOpenOpen: b }),

  // Task 14：HelpCenter 全局浮层（⌘? / ⌘/ 触发）
  helpOpen: false,
  setHelpOpen: (b) => set({ helpOpen: b }),
  toggleHelp: () => set((s) => ({ helpOpen: !s.helpOpen })),

  // 导航 — 点击当前已激活的视图时 toggle 回 tasks（对标 Trae Work）
  leftView: 'tasks',
  setLeftView: (v) =>
    set((s) => ({
      leftView: s.leftView === v ? 'tasks' : v,
    })),
  rightTab: 'files',
  setRightTab: (t) =>
    set((s) => ({
      rightTab: s.rightTab === t ? 'files' : t,
    })),

  // 加载状态
  loading: false,
  error: null,

  // ---- v0.5.0 反馈系统初始状态 ----
  toasts: [],
  confirmDialog: {
    open: false,
    title: '',
    body: '',
    confirmLabel: '确认',
    cancelLabel: '取消',
    danger: false,
    onConfirm: () => {},
  },
  // v0.8.1：工具执行确认请求（Main 推送，ToolConfirmLayer 展示）
  pendingConfirm: null as ToolConfirmRequest | null,
  ctxChips: [],

  /**
   * 推送 Toast 通知（B2）。
   * @param t - Toast 内容（不含 id，由本方法生成）
   * @returns 生成的 toast id
   * 行为：
   *   - level='silent'：不渲染 UI，仅同步写一行 INFO 日志（用于工具预算等系统噪音）
   *   - level='info'（默认）：推入队列（上限 5 条），duration>0 时 setTimeout 自动移除
   *   - level='critical'：同 info，但 ToastLayer 用作「真正需用户处理」的提示
   */
  pushToast: (t) => {
    const level: ToastLevel = t.level ?? 'info'
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    if (level === 'silent') {
      // Phase A Task 4：silent 路由——不弹 UI，仅记日志
      console.info(`[toast/silent] ${t.message}`)
      return id
    }
    set((s) => ({
      toasts: [...s.toasts.slice(-4), { ...t, level, id }],  // 上限 5 条
    }))
    if (t.duration > 0) {
      setTimeout(() => get().dismissToast(id), t.duration)
    }
    return id
  },

  /**
   * 移除指定 Toast（B2）。
   * @param id - Toast id
   */
  dismissToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  /**
   * 异步确认对话框（B6），替代 window.confirm。
   * @param opts - 对话框选项（标题/正文/按钮文案/danger）
   * @returns Promise<boolean> — true=确认, false=取消
   * 实现：设置 confirmDialog 状态，返回 Promise，resolve 在 onConfirm 回调内。
   */
  confirm: (opts) => {
    return new Promise<boolean>((resolve) => {
      set({
        confirmDialog: {
          open: true,
          title: opts.title,
          body: opts.body,
          confirmLabel: opts.confirmLabel ?? '确认',
          cancelLabel: opts.cancelLabel ?? '取消',
          danger: opts.danger ?? false,
          onConfirm: () => {
            set((s) => ({ confirmDialog: { ...s.confirmDialog, open: false } }))
            resolve(true)
          },
        },
      })
    })
  },

  /**
   * v0.8.1：回传工具执行确认结果（ToolConfirmLayer 调用）。
   * @param requestId - 来自 ToolConfirmRequest
   * @param allowed - true=允许执行
   * @param session - true=本次会话内不再询问同一条命令
   * @param reason - v0.14.0 Task 6：'denied'=显式拒绝；'dismissed'=Esc/点背景关闭（不算用户拒绝）
   */
  respondConfirm: (requestId, allowed, session, reason) => {
    void ark.confirm.respond(requestId, allowed, session, reason)
    set({ pendingConfirm: null })
  },

  /**
   * 推入上下文变更 chip（B4）— 对话流内可见的上下文操作痕迹。
   * @param chip - chip 内容（不含 id/ts）
   * 行为：推入队列（上限 3 条），3s 后自动移除（compress 变体 5s）。
   */
  pushCtxChip: (chip) => {
    const id = `chip-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const ts = Date.now()
    set((s) => ({
      ctxChips: [...s.ctxChips.slice(-2), { ...chip, id, ts }],  // 上限 3 条
    }))
    const ttl = chip.variant === 'compress' ? 5000 : 3000
    setTimeout(() => {
      set((s) => ({ ctxChips: s.ctxChips.filter((c) => c.id !== id) }))
    }, ttl)
  },

  /**
   * v0.9.1：接受蒸馏建议（写入 L3 策展/技能/画像观察）。
   * 落库成功后清卡 + 刷新 L3 pending 与记忆面板。
   * v0.14.0 Task 10：蒸馏改为全自动（distill-completed 事件），本建议卡链路已移除。
   */

  // 任务
  tasks: [],
  selectedTaskId: null,
  selectedTask: null,
  askUserQuestion: null,
  // Task 4：建议优先的任务交互 — 建议卡片状态
  suggestions: [],
  setSuggestions: (suggestions) => set({ suggestions }),
  clearSuggestions: () => set({ suggestions: [] }),
  selectTask: async (id) => {
    // Task 4：任务切换时清空建议卡片 + ask_user 暂停态
    set({ selectedTaskId: id, askUserQuestion: null, contextSize: null, suggestions: [] })
    const task = get().tasks.find((t) => t.id === id) ?? null
    set({ selectedTask: task })
    // 加载相关数据（文件列表恒为工作区根目录，v0.6.3）
    await Promise.all([
      get().refreshMemory(id),
      get().refreshContextSize(id),
      get().refreshSteps(id),
      get().refreshFiles(),
      get().refreshLogs(id),
    ])
    // 重新计算 conversation（v0.4.0-rev5：传入 memory 以显示 L1 中的 user_message）
    set((s) => ({ conversation: deriveConversation(task, s.steps, s.memory) }))
  },
  refreshTasks: async () => {
    try {
      const tasks = await ark.task.list()
      set({ tasks })
      // 如果当前选中任务不在列表中，清空选中
      const sel = get().selectedTaskId
      if (sel && !tasks.find((t) => t.id === sel)) {
        set({ selectedTaskId: null, selectedTask: null, conversation: [] })
      }
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  createTask: async (input) => {
    try {
      // 新建任务时清空 ask_user 暂停态与建议卡片
      set({ askUserQuestion: null, suggestions: [] })
      // v0.4.0-rev3：复用空任务——本次创建为空任务（text===''）且当前选中任务是空任务
      // （pending + input.text==='' + 无对话）时，直接返回当前任务，不创建新的。
      // 避免用户连续点"新建任务"堆积一堆空任务。
      // 安全性：rev2 已用随机 ID 解决覆盖问题，复用时直接返回不调用后端 createTask，无 ID 冲突。
      // sendMessage 路径带 text 非空，天然不触发复用。
      const currentTaskId = get().selectedTaskId
      const currentTask = currentTaskId
        ? get().tasks.find((t) => t.id === currentTaskId)
        : null
      const isCurrentEmpty =
        !!currentTask &&
        currentTask.status === 'pending' &&
        currentTask.input.text === '' &&
        get().conversation.length === 0
      if (input.text === '' && isCurrentEmpty && currentTask) {
        // 复用当前空任务——不调用后端，不增加任务数
        return currentTask
      }

      const agentId = get().selectedAgentId || '@default'
      const modelId = get().selectedModelId
      if (!modelId) {
        get().pushToast({ type: 'warning', message: '请先在设置中配置并选择一个模型', duration: 4000 })
        return null
      }
      const skillIds = get().selectedSkillIds
      const task = await ark.task.create({
        title: input.title,
        text: input.text,
        agentId,
        skillIds,
        modelId,
      })
      await get().refreshTasks()
      await get().selectTask(task.id)
      // 自动展开左侧导航栏，便于用户定位到新建的任务
      if (get().leftNavCollapsed) {
        get().setLeftNavCollapsed(false)
      }
      return task
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
      return null
    }
  },
  sendMessage: async (text) => {
    try {
      // Task 4：发送新消息时清空建议卡片（用户已做出决策/输入）
      set({ suggestions: [] })
      const taskId = get().selectedTaskId
      const modelId = get().selectedModelId
      if (!modelId) {
        get().pushToast({ type: 'warning', message: '请先在设置中配置并选择一个模型', duration: 4000 })
        return
      }
      // 有选中任务 → 追加消息并续聊；否则新建任务
      if (taskId) {
        // v0.6.5：先检查任务是否仍存在于 tasks.json（防止数据丢失后前端残留 selectedTaskId）
        const existing = get().tasks.find((t) => t.id === taskId)
        if (!existing) {
          // 任务记录已丢失——自动降级为新建任务，避免 "Task not found" 阻塞用户
          set({ selectedTaskId: null, selectedTask: null, conversation: [], steps: [], memory: [] })
          const task = await get().createTask({ title: text.slice(0, 40), text })
          if (task) await get().runTask(task.id)
          return
        }
        // v0.4.0：续聊时用当前选中的 modelId 更新任务，修复旧任务 modelId 失效问题
        if (existing.modelId !== modelId) {
          await ark.task.update({ id: taskId, modelId })
        }
        // v0.8.0：@ 引用的技能合并进任务（续聊路径此前会静默丢失 skillIds）
        const pickedSkills = get().selectedSkillIds
        if (pickedSkills.length > 0) {
          const merged = [...new Set([...(existing.skillIds ?? []), ...pickedSkills])]
          if (merged.length !== (existing.skillIds ?? []).length) {
            await ark.task.update({ id: taskId, skillIds: merged })
          }
        }
        await ark.task.appendMessage(taskId, text)
        // v0.16.7+：appendMessage 内部已自动 cancel + run，renderer 不再重复调 runTask，
        // 避免与 main 进程内 fire-and-forget 的 runTask 产生竞态。
        // polish2-workspace-name-task-title-skills-warning §Task 2：续聊路径首条消息触发自动重命名。
        // 仅在 title 仍是占位"未命名任务"或"未命名任务 N"时覆盖，已手动重命名则保留。
        const placeholder = /^未命名任务(\s\d+)?$/
        if (placeholder.test(existing.title)) {
          const simplified = simplifyFirstLine(text)
          if (simplified) {
            await get().renameTask(taskId, simplified)
          }
        }
        await get().refreshTasks()
        await get().refreshMemory(taskId)
        // v0.16.7+：不再调 ark.task.run —— appendMessage 内部已自动触发。
      } else {
        const task = await get().createTask({ title: simplifyFirstLine(text), text })
        if (task) {
          await get().runTask(task.id)
        } else {
          // createTask 返回 null（无模型）——error 已 set，此处补一句明确提示
          get().pushToast({ type: 'warning', message: get().error || '任务创建失败，请检查模型配置', duration: 4000 })
        }
      }
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  runTask: async (id) => {
    try {
      await ark.task.run(id)
    } catch (err) {
      // Phase A Task 4：模型相关错误视为 critical（用户必须介入处理）
      const msg = friendlyError(err)
      const level = /模型|model|api key|api_key|余额|认证/i.test(msg) ? 'critical' : 'info'
      get().pushToast({ type: 'danger', level, message: msg, duration: 0 })
    }
  },
  pauseTask: async (id) => {
    try {
      await ark.task.pause(id)
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  cancelTask: async (id) => {
    try {
      await ark.task.cancel(id)
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  /**
   * 恢复已暂停的任务（B1）。
   * @param id - 任务 id
   * 错误场景：任务非 paused 态、后端 resume 失败 → Toast 提示。
   */
  resumeTask: async (id) => {
    try {
      await ark.task.resume(id)
      // 恢复成功后清空 ask_user 暂停态的问题卡片
      set({ askUserQuestion: null })
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  /**
   * 从指定 iteration 重新生成（B3）。
   * @param taskId - 任务 id
   * @param iteration - 重新生成的起始 iteration
   * v0.5.0 限制：后端 runner.ts 暂无「回滚到指定 iteration」能力，
   * 退化为「整轮重跑」——重置状态为 pending 后重新 run。后端能力就绪后升级为精确回滚。
   */
  regenerateMessage: async (taskId, _iteration) => {
    try {
      await ark.task.update({ id: taskId, status: 'pending' })
      await ark.task.run(taskId)
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  /**
   * 导出当前任务对话为 Markdown 文件（B3，提取自 Composer）。
   * 读 selectedTask + conversation，生成 Blob → 下载。
   * 无选中任务时静默返回。
   */
  exportConversation: () => {
    const task = get().selectedTask
    if (!task) return
    const items = get().conversation
    const lines: string[] = [`# ${task.title}`, '']
    for (const it of items) {
      if (it.type === 'user') {
        lines.push('## You', '')
        lines.push(it.text ?? '', '')
      } else if (it.type === 'assistant') {
        lines.push(`## @${task.agentId}`, '')
        lines.push(it.text ?? '', '')
      } else if (it.type === 'react' && it.steps) {
        lines.push('### 步骤流', '')
        for (const s of it.steps) {
          lines.push(`- [${s.type}] ${s.summary || s.thought || ''}`)
        }
        lines.push('')
      }
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${shortTaskId(task.id)}.md`
    a.click()
    URL.revokeObjectURL(url)
  },
  deleteTask: async (id) => {
    try {
      await ark.task.delete(id)
      // 如果删除的是当前选中任务，清空选中
      if (get().selectedTaskId === id) {
        set({ selectedTaskId: null, selectedTask: null, conversation: [], steps: [], memory: [], contextSize: null })
      }
      // Task 9：删除任务时同步清理内存中的进度摘要（持久化缓存由 IPC 层清理，
      // 这里只清理前端状态，避免下次同名任务误读旧进度）
      set((s) => {
        if (!(id in s.taskProgress)) return {}
        const next = { ...s.taskProgress }
        delete next[id]
        return { taskProgress: next }
      })
      await get().refreshTasks()
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  toggleStar: async (id) => {
    try {
      const task = get().tasks.find((t) => t.id === id)
      if (!task) return
      const next = !task.starred
      await ark.task.update({ id, starred: next })
      set((s) => ({
        tasks: s.tasks.map((t) => (t.id === id ? { ...t, starred: next } : t)),
      }))
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  renameTask: async (id, title) => {
    try {
      await ark.task.update({ id, title })
      set((s) => ({
        tasks: s.tasks.map((t) => (t.id === id ? { ...t, title } : t)),
        selectedTask: s.selectedTaskId === id ? { ...s.selectedTask!, title } : s.selectedTask,
      }))
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  setTaskKbIds: async (taskId, kbIds) => {
    try {
      await ark.task.update({ id: taskId, kbIds })
      set((s) => ({
        tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, kbIds } : t)),
      }))
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  // Task 8：会话级 KB 开关
  setTaskKbEnabled: async (taskId, enabled) => {
    try {
      await ark.task.update({ id: taskId, kbEnabled: enabled })
      set((s) => ({
        tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, kbEnabled: enabled } : t)),
        selectedTask: s.selectedTaskId === taskId ? { ...s.selectedTask!, kbEnabled: enabled } : s.selectedTask,
      }))
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  // Task 8：全局 KB 开关（持久化到 settings.json；下次启动 init 重新读取）
  globalKbEnabled: true,
  setGlobalKbEnabled: async (enabled) => {
    set({ globalKbEnabled: enabled })
    try {
      await window.ark.settings.set({ kbEnabled: enabled })
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err, '保存全局 KB 开关失败'), duration: 0 })
    }
  },
  // 模块视图数据（v0.5.0 B5→v0.6.4：改为真实后端数据）
  automations: [],
  knowledgeBases: [],
  refreshAutomations: async () => {
    try {
      const list = await ark.automation.list()
      set({ automations: list })
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  createAutomation: async (input) => {
    try {
      await ark.automation.create(input)
      await get().refreshAutomations()
      get().pushToast({ type: 'success', message: `已创建自动化：${input.name}`, duration: 3000 })
      return true
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
      return false
    }
  },
  updateAutomation: async (id, patch) => {
    try {
      await ark.automation.update(id, patch)
      await get().refreshAutomations()
      get().pushToast({ type: 'success', message: '已更新自动化', duration: 3000 })
      return true
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
      return false
    }
  },
  removeAutomation: async (id) => {
    try {
      await ark.automation.remove(id)
      await get().refreshAutomations()
      get().pushToast({ type: 'success', message: '已删除自动化', duration: 2000 })
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  toggleAutomation: async (id, status) => {
    try {
      await ark.automation.update(id, { status })
      await get().refreshAutomations()
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  runAutomation: async (id) => {
    try {
      // v0.9.1：主进程创建任务后立即启动运行；返回 taskId 后跳转过去看执行
      const { taskId } = await ark.automation.run(id)
      await get().refreshAutomations()
      await get().refreshTasks()
      // 从模块页跳回任务视图，直接看到运行过程
      if (get().modulePage) get().closeModulePage()
      await get().selectTask(taskId)
      get().pushToast({ type: 'success', message: '自动化已启动，正在执行', duration: 3000 })
      return true
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
      return false
    }
  },
  refreshKnowledge: async () => {
    try {
      const list = await ark.kb.list()
      set({ knowledgeBases: list })
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  addKnowledge: async (input) => {
    try {
      await ark.kb.add(input)
      await get().refreshKnowledge()
      get().pushToast({ type: 'success', message: `已添加到知识库：${input.name}`, duration: 3000 })
      return true
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
      return false
    }
  },
  removeKnowledge: async (id) => {
    try {
      await ark.kb.remove(id)
      await get().refreshKnowledge()
      get().pushToast({ type: 'success', message: '已从知识库移除', duration: 2000 })
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },

  // ---- 工作区管理 ----
  workspaces: loadWorkspaces(),
  activeWorkspaceId: loadActiveWorkspace(),
  // Phase A Task 2：工作区确认状态（会话级内存，不持久化）
  workspaceConfirmedForTask: {},
  confirmWorkspace: (taskId) =>
    set((s) => ({
      workspaceConfirmedForTask: { ...s.workspaceConfirmedForTask, [taskId]: true },
    })),
  resetWorkspaceConfirm: (taskId) =>
    set((s) => {
      if (taskId === '*') return { workspaceConfirmedForTask: {} }
      if (!(taskId in s.workspaceConfirmedForTask)) return {}
      const next = { ...s.workspaceConfirmedForTask }
      delete next[taskId]
      return { workspaceConfirmedForTask: next }
    }),
  createWorkspace: async () => {
    try {
      const path = await window.ark.settings.pickWorkspace()
      if (!path) return // 用户取消
      // 从路径提取文件夹名作为工作区名
      const folderName = path.split('/').pop() || '未命名工作区'
      const ws: Workspace = {
        id: `ws-${Date.now()}`,
        name: folderName,
        path,
        createdAt: Date.now(),
      }
      const next = [...get().workspaces, ws]
      saveWorkspaces(next)
      set({ workspaces: next })
      // 切换到新工作区
      await get().switchWorkspace(ws.id)
    } catch (err) {
      get().pushToast({ type: 'danger', message: `创建工作区失败：${(err as Error).message}`, duration: 0 })
    }
  },
  removeWorkspace: (id) => {
    if (id === 'default') return // 默认工作区不可移除
    const remaining = get().workspaces.filter((w) => w.id !== id)
    if (remaining.length === 0) return
    saveWorkspaces(remaining)
    // 先更新 workspaces 列表（无论是否当前激活，都要从列表移除）
    set({ workspaces: remaining })
    // 如果移除的是当前工作区，切回 default
    if (get().activeWorkspaceId === id) {
      void get().switchWorkspace('default')
    }
  },
  switchWorkspace: async (id) => {
    const ws = get().workspaces.find((w) => w.id === id)
    if (!ws) return
    try {
      // 后端切换 workspaceDir（空路径=内置 default 目录，其他用关联路径）
      await window.ark.settings.activateWorkspace(ws.path)
      saveActiveWorkspace(id)
      set({
        activeWorkspaceId: id,
        selectedTaskId: null,
        selectedTask: null,
        conversation: [],
        steps: [],
        memory: [],
        files: [],
        logs: [],
        selectedFile: null,
        selectedFileContent: null,
        contextSize: null,
        modulePage: null,
        // Phase A Task 2：切换工作区 → 清空所有任务的确认缓存（路径变了旧确认失效）
        workspaceConfirmedForTask: {},
        // v0.9.0：ui-state 按工作区隔离 — 切换后重载该工作区布局
        // v0.13.0：宽度值加载时也必须 clamp 到合法范围（64–320 / 280–480）
        leftNavCollapsed: loadUiState('leftnav', false),
        rightDockCollapsed: loadUiState('rightdock', false),
        rightDockWidth: clampWidth(loadUiState('rightdock-w', 360), 280, 480),
        sidePanelWidth: clampWidth(loadUiState('sidepanel-w', 240), 64, 320),
        dockPrefs: loadUiState<Record<string, DockPrefs>>('dockprefs', {}),
        inspectorTabOrder: sanitizeInspectorOrder(loadUiState('inspector-tab-order', INSPECTOR_TAB_ORDER)),
        hiddenInspectorTabs: sanitizeHiddenTabs(loadUiState('inspector-tab-hidden', [])),
      })
      // 同步当前智能体的 Dock 布局
      const agentId = get().selectedAgentId
      if (agentId) {
        const layout = resolveDockLayout(agentId, get().dockPrefs[agentId])
        set({ dockTabs: layout.tabs, dockDefaultTab: layout.defaultTab, activeDockTab: layout.defaultTab })
      }
      // 刷新任务列表（新工作区目录下的任务）
      await get().refreshTasks()
      // v0.11.0 F1103：切换工作区留痕 — 对话流插入 chip（可追溯「记忆怎么变了」）
      get().pushCtxChip({
        text: `已切换工作区 · 记忆已随任务隔离（${ws.name}）`,
        variant: 'update',
      })
    } catch (err) {
      get().pushToast({ type: 'danger', message: `切换工作区失败：${(err as Error).message}`, duration: 0 })
    }
  },

  // Catalog
  agents: [],
  skills: [],
  mcps: [],
  models: [],
  refreshCatalog: async () => {
    try {
      const [agents, skills, mcps, models] = await Promise.all([
        ark.agent.list(),
        ark.skill.list(),
        ark.mcp.list(),
        ark.model.list(),
      ])
      set({
        agents,
        skills,
        mcps,
        models,
        // v0.6.4：默认选中 @default agent（通用助手始终存在）
        selectedAgentId: get().selectedAgentId || agents.find((a) => a.id === '@default')?.id || agents[0]?.id || '',
        // v0.3.0：默认选中第一个启用的模型，避免用户每次手动选择
        selectedModelId:
          get().selectedModelId ||
          models.find((m) => m.enabled)?.id ||
          models[0]?.id ||
          '',
      })
      // v0.9.0 F905：目录加载后同步 RightDock 布局
      const agentId = get().selectedAgentId
      if (agentId) {
        const layout = resolveDockLayout(agentId, get().dockPrefs[agentId])
        set({
          dockTabs: layout.tabs,
          dockDefaultTab: layout.defaultTab,
          activeDockTab: layout.tabs.includes(get().activeDockTab) ? get().activeDockTab : layout.defaultTab,
        })
      }
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },

  addModel: async (model) => {
    try {
      await ark.model.add(model)
      await get().refreshCatalog()
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  updateModel: async (model) => {
    try {
      await ark.model.update(model)
      await get().refreshCatalog()
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  removeModel: async (id) => {
    try {
      await ark.model.remove(id)
      await get().refreshCatalog()
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  testModel: async (req) => {
    try {
      return await ark.model.test(req)
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    }
  },

  // ---- v0.6.0 Agent CRUD ----
  agentEditorOpen: false,
  editingAgent: null,
  openAgentEditor: (agent) =>
    set({ agentEditorOpen: true, editingAgent: agent ?? null }),
  closeAgentEditor: () => set({ agentEditorOpen: false, editingAgent: null }),
  addAgent: async (input) => {
    try {
      const agent = await ark.agent.add(input)
      await get().refreshCatalog()
      set({ agentEditorOpen: false, editingAgent: null })
      get().pushToast({ type: 'success', message: `已创建 Agent：@${agent.name}`, duration: 3000 })
      return agent
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
      return null
    }
  },
  updateAgent: async (id, patch) => {
    try {
      const agent = await ark.agent.update(id, patch)
      await get().refreshCatalog()
      set({ agentEditorOpen: false, editingAgent: null })
      get().pushToast({ type: 'success', message: 'Agent 已更新', duration: 3000 })
      return agent
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
      return null
    }
  },
  removeAgent: async (id) => {
    const agent = get().agents.find((a) => a.id === id)
    const ok = await get().confirm({
      title: '删除 Agent',
      body: `确定要删除 Agent「${agent?.name ?? id}」吗？此操作不可撤销。`,
      confirmLabel: '删除',
      danger: true,
    })
    if (!ok) return false
    try {
      await ark.agent.remove(id)
      await get().refreshCatalog()
      // 若删除的是当前选中 agent，回退到第一个
      if (get().selectedAgentId === id) {
        const next = get().agents[0]?.id ?? ''
        set({ selectedAgentId: next })
      }
      get().pushToast({ type: 'success', message: 'Agent 已删除', duration: 3000 })
      return true
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
      return false
    }
  },

  // ---- v0.6.0 Skill CRUD ----
  skillEditorOpen: false,
  editingSkill: null,
  openSkillEditor: (skill) =>
    set({ skillEditorOpen: true, editingSkill: skill ?? null }),
  closeSkillEditor: () => set({ skillEditorOpen: false, editingSkill: null }),
  addSkill: async (input) => {
    try {
      const skill = await ark.skill.add(input)
      await get().refreshCatalog()
      set({ skillEditorOpen: false, editingSkill: null })
      get().pushToast({ type: 'success', message: `已创建 Skill：${skill.name}`, duration: 3000 })
      return skill
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
      return null
    }
  },
  updateSkill: async (patch) => {
    try {
      const skill = await ark.skill.update(patch)
      await get().refreshCatalog()
      set({ skillEditorOpen: false, editingSkill: null })
      get().pushToast({ type: 'success', message: 'Skill 已更新', duration: 3000 })
      return skill
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
      return null
    }
  },
  removeSkill: async (id) => {
    const skill = get().skills.find((s) => s.id === id)
    const ok = await get().confirm({
      title: '删除 Skill',
      body: `确定要删除 Skill「${skill?.name ?? id}」吗？此操作不可撤销。`,
      confirmLabel: '删除',
      danger: true,
    })
    if (!ok) return false
    try {
      await ark.skill.remove(id)
      await get().refreshCatalog()
      // 从会话级选中中移除
      set((s) => ({
        selectedSkillIds: s.selectedSkillIds.filter((x) => x !== id),
      }))
      get().pushToast({ type: 'success', message: 'Skill 已删除', duration: 3000 })
      return true
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
      return false
    }
  },
  toggleSkillEnabled: async (id, enabled) => {
    try {
      await ark.skill.toggle(id, enabled)
      await get().refreshCatalog()
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  importSkill: async (dirPath) => {
    try {
      const skill = await ark.skill.importFromDir(dirPath ?? '')
      await get().refreshCatalog()
      get().pushToast({ type: 'success', message: `已导入 Skill：${skill.name}`, duration: 3000 })
      return skill
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
      return null
    }
  },
  exportSkill: async (id, targetDir) => {
    try {
      const result = await ark.skill.exportToDir(id, targetDir ?? '')
      const msg = result.isZip
        ? `已导出为 ZIP（${result.fileCount} 个文件）：${result.path}`
        : `已导出到目录（${result.fileCount} 个文件）：${result.path}`
      get().pushToast({ type: 'success', message: msg, duration: 5000 })
      return result
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
      return null
    }
  },
  readSkillInstruction: async (id) => {
    try {
      return await ark.skill.readInstruction(id)
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
      return null
    }
  },

  // ---- v0.6.0 Mcp CRUD ----
  mcpEditorOpen: false,
  editingMcp: null,
  openMcpEditor: (mcp) =>
    set({ mcpEditorOpen: true, editingMcp: mcp ?? null }),
  closeMcpEditor: () => set({ mcpEditorOpen: false, editingMcp: null }),
  addMcp: async (input) => {
    try {
      const mcp = await ark.mcp.add(input)
      await get().refreshCatalog()
      set({ mcpEditorOpen: false, editingMcp: null })
      get().pushToast({ type: 'success', message: `已添加 MCP：${mcp.name}`, duration: 3000 })
      return mcp
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
      return null
    }
  },
  updateMcp: async (id, patch) => {
    try {
      const mcp = await ark.mcp.update(id, patch)
      await get().refreshCatalog()
      set({ mcpEditorOpen: false, editingMcp: null })
      get().pushToast({ type: 'success', message: 'MCP 已更新', duration: 3000 })
      return mcp
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
      return null
    }
  },
  removeMcp: async (id) => {
    const mcp = get().mcps.find((m) => m.id === id)
    const ok = await get().confirm({
      title: '删除 MCP Server',
      body: `确定要删除 MCP「${mcp?.name ?? id}」吗？若已连接将先断开。`,
      confirmLabel: '删除',
      danger: true,
    })
    if (!ok) return false
    try {
      await ark.mcp.remove(id)
      await get().refreshCatalog()
      set((s) => ({
        selectedMcpIds: s.selectedMcpIds.filter((x) => x !== id),
      }))
      get().pushToast({ type: 'success', message: 'MCP 已删除', duration: 3000 })
      return true
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
      return false
    }
  },
  connectMcp: async (id) => {
    try {
      await ark.mcp.connect(id)
      await get().refreshCatalog()
      get().pushToast({ type: 'success', message: 'MCP 已连接', duration: 3000 })
      return true
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err, 'MCP 连接失败'), duration: 0 })
      return false
    }
  },
  disconnectMcp: async (id) => {
    try {
      await ark.mcp.disconnect(id)
      await get().refreshCatalog()
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },

  // ---- v0.6.0 Skill 市场 ----
  marketSkills: [],
  marketLoading: false,
  marketHasMore: false,
  marketTotal: 0,
  marketPage: 1,
  marketPageSize: 30,
  marketQuery: '',
  marketTags: [],
  // v0.6.1：SkillHub CLI 状态
  marketCli: null,
  checkMarketCli: async () => {
    try {
      const info = await ark.market.checkCli()
      set({ marketCli: info })
    } catch {
      set({ marketCli: null })
    }
  },
  installMarketCli: async () => {
    try {
      const info = await ark.market.installCli()
      set({ marketCli: info })
      get().pushToast({ type: 'success', message: `skillhub CLI 已安装${info.version ? `（${info.version}）` : ''}`, duration: 3000 })
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  searchMarket: async (query, tags, page) => {
    const q = query ?? ''
    const t = tags ?? []
    const p = page ?? 1
    set({ marketLoading: true })
    try {
      const resp = await ark.market.search(q, t, p)
      set({
        // v0.8.0：改为真分页（翻页替换，不再追加）
        marketSkills: resp.results,
        marketHasMore: resp.hasMore,
        marketTotal: resp.total,
        marketPage: p,
        marketQuery: q,
        marketTags: t,
      })
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    } finally {
      set({ marketLoading: false })
    }
  },
  installMarketSkill: async (skillId) => {
    try {
      const skill = await ark.market.install(skillId)
      if (skill) {
        await get().refreshCatalog()
        get().pushToast({ type: 'success', message: `已安装 Skill：${skill.name}`, duration: 3000 })
        // 刷新市场列表以更新 installed 状态（使用上次搜索条件与当前页）
        const { marketQuery, marketTags, marketPage } = get()
        await get().searchMarket(marketQuery, marketTags, marketPage)
        return true
      }
      // 已安装
      get().pushToast({ type: 'warning', message: '该 Skill 已安装', duration: 3000 })
      return false
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
      return false
    }
  },

  // ---- v0.15.0 市场增强 ----
  marketInstalled: [],
  marketFavorites: [],
  marketSources: [],
  marketDetail: null,
  marketDetailOpen: false,
  listInstalledMarket: async () => {
    try {
      const list = await ark.market.listInstalled()
      set({ marketInstalled: list })
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  listMarketFavorites: async () => {
    try {
      const state = await ark.market.getLocalState()
      const fav = (state.favorites ?? []).map((id) => ({
        id,
        name: id,
        description: '已收藏技能',
        tags: [],
        source: 'community' as const,
        installed: true,
      }))
      set({ marketFavorites: fav })
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  uninstallMarketSkill: async (skillId) => {
    try {
      await ark.market.uninstall(skillId)
      get().pushToast({ type: 'success', message: '已卸载该 Skill', duration: 3000 })
      await get().refreshCatalog()
      await get().listInstalledMarket()
      const { marketQuery, marketTags, marketPage } = get()
      await get().searchMarket(marketQuery, marketTags, marketPage)
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  toggleMarketFavorite: async (skillId, favorited) => {
    try {
      await ark.market.toggleFavorite(skillId, favorited)
      await get().listMarketFavorites()
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  refreshMarketSources: async () => {
    try {
      const sources = await ark.market.listSources()
      set({ marketSources: sources })
    } catch {
      set({ marketSources: [] })
    }
  },
  openMarketDetail: async (skill) => {
    set({ marketDetailOpen: true })
    try {
      const meta = await ark.market.detail(skill.id)
      if (meta) {
        set({ marketDetail: meta })
      } else if ('metadata' in skill && skill.metadata) {
        set({ marketDetail: skill.metadata })
      } else {
        set({
          marketDetail: {
            id: skill.id,
            name: skill.name,
            displayName: skill.name,
            description: skill.description,
            category: 'other',
            tags: skill.tags,
            version: '1.0.0',
            author: { name: 'SkillHub' },
            keywords: skill.tags,
            downloads: skill.downloads ?? 0,
            rating: 0,
            ratingCount: 0,
            createdAt: '',
            updatedAt: '',
            contextCostEstimate: { baseline: 50, active: 1200, perTurn: 320 },
            compatibility: { minArkWorkVersion: '0.15.0', os: ['macos', 'linux', 'windows'], dependencies: [] },
            source: skill.source === 'builtin' ? 'builtin' : 'market',
            featured: false,
            deprecated: false,
            installed: skill.installed,
            favorited: false,
          },
        })
      }
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  closeMarketDetail: () => set({ marketDetailOpen: false, marketDetail: null }),

  // ---- v0.15.0 权限模型 ----
  permissionMode: 'default',
  permissionRules: null,
  getPermissionMode: async () => {
    try {
      const mode = await ark.permission.getMode()
      set({ permissionMode: mode })
    } catch {
      // 忽略：主进程未就绪时保持默认
    }
  },
  setPermissionMode: async (mode) => {
    try {
      const applied = await ark.permission.setMode(mode)
      set({ permissionMode: applied })
      await get().refreshPermissionRules()
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  refreshPermissionRules: async () => {
    try {
      const rules = await ark.permission.resolveRules()
      set({ permissionRules: rules })
    } catch {
      set({ permissionRules: null })
    }
  },
  addPermissionRule: async (rule) => {
    try {
      await ark.permission.addRule(rule, 'allow')
      await get().refreshPermissionRules()
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },

  // Pickers
  selectedAgentId: '',
  setSelectedAgent: (id) =>
    set((s) => {
      // v0.9.0 F905：RightDock 随智能体自适应（预设 × 用户偏好）
      const layout = resolveDockLayout(id, s.dockPrefs[id])
      return {
        selectedAgentId: id,
        dockTabs: layout.tabs,
        dockDefaultTab: layout.defaultTab,
        // 兜底规则：当前选中 Tab 在新预设中不存在 → 选中 defaultTab
        activeDockTab: layout.tabs.includes(s.activeDockTab) ? s.activeDockTab : layout.defaultTab,
      }
    }),
  selectedSkillIds: [],
  toggleSkill: (id) =>
    set((s) => ({
      selectedSkillIds: s.selectedSkillIds.includes(id)
        ? s.selectedSkillIds.filter((x) => x !== id)
        : [...s.selectedSkillIds, id],
    })),
  selectedMcpIds: [],
  toggleMcp: (id) =>
    set((s) => ({
      selectedMcpIds: s.selectedMcpIds.includes(id)
        ? s.selectedMcpIds.filter((x) => x !== id)
        : [...s.selectedMcpIds, id],
    })),
  selectedModelId: '',
  setSelectedModel: (id) => {
    // v0.9.0 F904 §4.3：切换模型留痕 — 对话流插入非模态 chip
    const s = useStore.getState()
    if (s.selectedModelId && s.selectedModelId !== id) {
      const model = s.models.find((m) => m.id === id)
      if (model) {
        s.pushCtxChip({
          text: `已切换至 ${model.name || model.id} · 上下文保留`,
          variant: 'update',
        })
      }
    }
    set({ selectedModelId: id })
  },
  openPicker: null,
  setOpenPicker: (p) => set({ openPicker: p }),

  // Command Palette
  cmdPaletteOpen: false,
  setCmdPaletteOpen: (b) => set({ cmdPaletteOpen: b }),

  // Memory
  memory: [],
  contextSize: null,
  setContextSize: (size) => set({ contextSize: size }),
  // v0.15.x：按需拉取任务真实 payload 估算（空闲/完成态也如实展示，不再只显示 L1 累加）
  refreshContextSize: async (taskId) => {
    try {
      const est = await ark.context.estimate(taskId)
      if (!est) return
      set({
        contextSize: {
          payloadTokens: est.payloadTokens,
          budget: est.budget,
          breakdown: est.breakdown,
          modelContextWindow: est.modelContextWindow,
          reportedAt: Date.now(),
        },
      })
    } catch (err) {
      // 估算失败静默：UI 回落 L1 累加口径
      console.warn('[store] refreshContextSize failed:', err)
    }
  },
  refreshMemory: async (taskId) => {
    try {
      const memory = await ark.memory.list(taskId)
      // v0.4.0-rev5：memory 更新后重新计算 conversation，
      // 因为 deriveConversation 现在从 memory 读取 user_message
      set((s) => ({
        memory,
        conversation: deriveConversation(s.selectedTask, s.steps, memory),
      }))
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  toggleMemory: async (taskId, id, enabled) => {
    try {
      await ark.memory.toggle(taskId, id, enabled)
      set((s) => ({
        memory: s.memory.map((m) => (m.id === id ? { ...m, enabled } : m)),
      }))
      // v0.5.0（B4）：勾选/取消后推送 ctx-chip，对话流可见上下文变更痕迹
      const activeCount = get().memory.filter((m) => m.enabled).length
      get().pushCtxChip({
        text: enabled
          ? `上下文已更新 · +1 条记忆生效 · 下一轮起用`
          : `上下文已更新 · -1 条记忆停用 · 下一轮起用`,
        variant: 'update',
      })
      void activeCount // 保留供未来精确文案（当前用 +/-1 占位）
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },

  // ReAct Trace
  steps: [],
  // v0.14.0 Task 4：并行 Act 进度（per-requestId）
  toolProgress: {},
  activeProgressByTask: {},
  // Task 9：进度摘要（按 taskId 索引，独立持久化到 .arkwork/cache/task-progress.json）
  taskProgress: {},
  /**
   * Task 9：覆盖式写入任务进度摘要。
   * 通常由 `task:progress` 事件直接调用（Main → Renderer），无需派生计算。
   * 同时异步触发 IPC 持久化，避免页面切换或重启丢失。
   */
  setTaskProgress: (taskId, progress) => {
    const next: TaskProgress = { ...progress, updatedAt: Date.now() }
    set((s) => ({ taskProgress: { ...s.taskProgress, [taskId]: next } }))
    // 异步持久化（不阻塞渲染；失败仅记 warn，不抛错）
    void ark.task.progressSave({ taskId, progress: next }).catch((err) => {
      console.warn('[store] task.progressSave failed:', err)
    })
  },
  /**
   * Task 9：标记某 SubTask 完成（completed / failed）。
   * 内部维护 completedSteps 紧凑列表（最多保留最近 16 条，超出截断）；
   * 同时刷新 nextStep 与 overallPercentage。
   */
  updateTaskProgressStep: (taskId, stepId, status, label) => {
    const now = Date.now()
    const cur = get().taskProgress[taskId]
    if (!cur) return
    const completed = cur.completedSteps.filter((s) => s.id !== stepId)
    if (status === 'completed' || status === 'failed') {
      completed.unshift({
        id: stepId,
        label: label ?? stepId,
        status: status === 'completed' ? 'completed' : 'failed',
        completedAt: now,
      })
      // 紧凑列表：保留最近 16 条
      if (completed.length > 16) completed.length = 16
    }
    const updated: TaskProgress = {
      ...cur,
      completedSteps: completed,
      updatedAt: now,
    }
    set((s) => ({ taskProgress: { ...s.taskProgress, [taskId]: updated } }))
    void ark.task.progressSave({ taskId, progress: updated }).catch((err) => {
      console.warn('[store] task.progressSave failed:', err)
    })
  },
  /**
   * Task 9：标记里程碑到达（含可选产物路径）。
   * 已到达的 milestone 不重复置位；记录 reachedAt 与 artifactPath。
   */
  markTaskProgressMilestone: (taskId, milestoneId, artifactPath) => {
    const cur = get().taskProgress[taskId]
    if (!cur) return
    const now = Date.now()
    const milestones = cur.milestones.map((m) =>
      m.id === milestoneId
        ? { ...m, reachedAt: m.reachedAt ?? now, artifactPath: artifactPath ?? m.artifactPath }
        : m,
    )
    const updated: TaskProgress = { ...cur, milestones, updatedAt: now }
    set((s) => ({ taskProgress: { ...s.taskProgress, [taskId]: updated } }))
    void ark.task.progressSave({ taskId, progress: updated }).catch((err) => {
      console.warn('[store] task.progressSave failed:', err)
    })
  },
  /**
   * Task 9：阶段切换（currentStage / overallPercentage）。
   * 若 nextStepLabel 提供，则同步设置 nextStep（保持一字段存当前阶段下一步预览）。
   */
  setTaskProgressStage: (taskId, stage, overallPercentage, nextStepLabel) => {
    const cur = get().taskProgress[taskId]
    if (!cur) return
    const stageMeta = cur.stages.find((s) => s.id === stage)
    const updated: TaskProgress = {
      ...cur,
      currentStage: stage,
      currentStageLabel: stageMeta?.label ?? stage,
      currentStageIndex: stageMeta?.index ?? cur.currentStageIndex,
      overallPercentage: Math.max(0, Math.min(100, Math.round(overallPercentage))),
      nextStep: nextStepLabel ? { id: `next-${stage}`, label: nextStepLabel, status: 'running' } : cur.nextStep,
      updatedAt: Date.now(),
    }
    set((s) => ({ taskProgress: { ...s.taskProgress, [taskId]: updated } }))
    void ark.task.progressSave({ taskId, progress: updated }).catch((err) => {
      console.warn('[store] task.progressSave failed:', err)
    })
  },
  /**
   * Task 9：读取某任务的进度摘要（无则返回 undefined）。
   * 用于 ProgressPanel 派生渲染。
   */
  getTaskProgress: (taskId) => get().taskProgress[taskId],
  /**
   * Task 9：从主进程缓存恢复全部进度（应用启动时调用一次）。
   * 失败静默（缓存不存在视为首次启动，UI 自然走空态）。
   */
  refreshTaskProgress: async () => {
    try {
      const map = await ark.task.progressLoad()
      if (!map) return
      set({ taskProgress: map })
    } catch (err) {
      console.warn('[store] task.progressLoad failed:', err)
    }
  },
  refreshSteps: async (taskId) => {
    try {
      const steps = await ark.task.listSteps(taskId)
      set({ steps })
      const task = get().selectedTask
      set((s) => ({ conversation: deriveConversation(task, steps, s.memory) }))
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  toggleStep: (id) =>
    set((s) => ({
      steps: s.steps.map((p) => (p.id === id ? { ...p, expanded: !p.expanded } : p)),
    })),
  appendStep: (step) =>
    set((s) => {
      const exists = s.steps.find((p) => p.id === step.id)
      const nextSteps = exists
        ? s.steps.map((p) => (p.id === step.id ? step : p))
        : [...s.steps, step]
      return {
        steps: nextSteps,
        conversation: deriveConversation(s.selectedTask, nextSteps, s.memory),
      }
    }),
  updateStep: (step) =>
    set((s) => {
      const nextSteps = s.steps.map((p) => (p.id === step.id ? step : p))
      return {
        steps: nextSteps,
        conversation: deriveConversation(s.selectedTask, nextSteps, s.memory),
      }
    }),

  // 派生对话流
  conversation: [],

  // 文件树
  files: [],
  selectedFile: null,
  selectedFileContent: null,
  selectedFileLanguage: 'text',
  setSelectedFile: async (path) => {
    if (!path) {
      set({ selectedFile: null, selectedFileContent: null })
      return
    }
    set({ selectedFile: path, selectedFileContent: null })
    try {
      const content = await ark.fs.readFile(path)
      set({
        selectedFileContent: content.content,
        selectedFileLanguage: content.language,
      })
      // v0.7.0：文件选择后弹浮窗预览（取代右栏 Tab）
      void get().openPreview(path)
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  refreshFiles: async (taskId) => {
    try {
      const files = await ark.fs.listFiles(taskId)
      set({ files })
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },

  // Logs
  logs: [],
  appendLog: (entry) =>
    set((s) => ({ logs: [...s.logs.slice(-499), entry] })),
  refreshLogs: async (taskId) => {
    try {
      const logs = await ark.log.list(taskId)
      set({ logs })
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },

  // Settings
  settingsOpen: false,
  setSettingsOpen: (b) => set({ settingsOpen: b }),
  settingsTab: 'models',
  setSettingsTab: (t) => set({ settingsTab: t }),

  // ---- 主题（v0.4.0） ----
  // 初始值：优先 localStorage（无闪烁脚本已设），否则 'dark'
  theme: ((): ThemeMode => {
    try {
      const t = localStorage.getItem('arkwork:theme') as ThemeMode | null
      if (t === 'light' || t === 'dark' || t === 'system') return t
    } catch { /* ignore */ }
    return 'dark'
  })(),
  systemTheme: 'dark',
  resolvedTheme: 'dark',
  setTheme: async (t) => {
    // 1. 更新状态
    const systemTheme = get().systemTheme
    const resolved = applyThemeClass(t, systemTheme)
    set({ theme: t, resolvedTheme: resolved })
    // 2. 持久化到 localStorage（供下次启动无闪烁脚本读取）
    try { localStorage.setItem('arkwork:theme', t) } catch { /* ignore */ }
    // 3. 保存到 settings.json
    try {
      await window.ark.settings.set({ theme: t })
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err, '主题持久化失败'), duration: 0 })
    }
    // 4. 同步原生界面（文件选择器/对话框/上下文菜单）
    try {
      await window.ark.theme.apply(t)
    } catch (err) {
      // 原生同步失败不影响 DOM 已生效，仅记录
      get().pushToast({ type: 'warning', message: friendlyError(err, '原生主题同步失败'), duration: 4000 })
    }
  },
  cycleTheme: async () => {
    const order: ThemeMode[] = ['light', 'dark', 'system']
    const cur = get().theme
    const next = order[(order.indexOf(cur) + 1) % order.length]
    await get().setTheme(next)
  },

  // 初始化 — 启动时调用
  init: async () => {
    set({ loading: true })
    try {
      // v0.4.0：初始化主题（读 settings.json 校正 localStorage，并订阅系统主题变化）
      try {
        const settings = await window.ark.settings.get()
        const persistedTheme = settings.theme
        // settings.json 与 localStorage 不一致时以 settings.json 为准（跨设备同步）
        const localTheme = get().theme
        if (persistedTheme && persistedTheme !== localTheme) {
          try { localStorage.setItem('arkwork:theme', persistedTheme) } catch { /* ignore */ }
        }
        const theme = persistedTheme || localTheme
        const systemTheme = await window.ark.theme.getSystemTheme()
        const resolved = applyThemeClass(theme, systemTheme)
        set({ theme, systemTheme, resolvedTheme: resolved })
        // 同步原生界面
        await window.ark.theme.apply(theme)
        // Task 8：同步全局 KB 开关（缺省 true）
        set({ globalKbEnabled: settings.kbEnabled !== false })
      } catch (err) {
        get().pushToast({ type: 'warning', message: friendlyError(err, '主题初始化失败'), duration: 4000 })
      }

      // 同步后端 workspaceDir（确保 persisted active workspace 的路径生效）
      const activeWs = get().workspaces.find((w) => w.id === get().activeWorkspaceId)
      if (activeWs) {
        try {
          await window.ark.settings.activateWorkspace(activeWs.path)
        } catch {
          // 激活失败（路径不存在等），回退到 default
          saveActiveWorkspace('default')
          set({ activeWorkspaceId: 'default' })
        }
      }
      await get().refreshCatalog()
      await get().refreshTasks()
      // Task 9：从主进程缓存恢复任务进度（页面切换 / 重启后保持进度不丢）
      await get().refreshTaskProgress()
      // v0.6.4：加载自动化和知识库数据
      void get().refreshAutomations()
      void get().refreshKnowledge()
      // v0.6.1：初始化 SkillHub CLI 状态
      void get().checkMarketCli()
      // v0.15.0：初始化会话权限模式与规则
      void get().getPermissionMode()
      void get().refreshPermissionRules()
      // 自动选中第一个任务
      const first = get().tasks[0]
      if (first) {
        await get().selectTask(first.id)
      } else {
        await get().refreshFiles()
      }
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    } finally {
      set({ loading: false })
    }
  },

  // 事件订阅
  subscribeAll: () => {
    const unsubs: Array<() => void> = []

    // v0.15.0：会话权限模式变更（Shift+Tab / UI 切换）
    unsubs.push(
      ark.permission.onModeChanged((payload) => {
        if (payload && payload.mode) set({ permissionMode: payload.mode })
        void get().refreshPermissionRules()
      }),
    )

    // ReAct 步骤推送
    unsubs.push(
      ark.task.onStep((step) => {
        // 仅当 step 属于当前选中任务时才追加
        if (get().selectedTaskId === step.taskId) {
          get().appendStep(step)
        }
      }),
    )

    // 任务状态变化
    unsubs.push(
      ark.task.onStatusChange((task) => {
        set((s) => ({
          tasks: s.tasks.map((t) => (t.id === task.id ? task : t)),
          selectedTask:
            s.selectedTaskId === task.id ? task : s.selectedTask,
          // v0.14.0 Task 4：任务失败/取消时清空飞行中的进度，避免 UI 残留
          activeProgressByTask:
            task.status === 'failed' || task.status === 'cancelled' || task.status === 'done'
              ? Object.fromEntries(
                  Object.entries(s.activeProgressByTask).filter(([k]) => k !== task.id),
                )
              : s.activeProgressByTask,
        }))
      }),
    )

    // v0.14.0 Task 8：PlanItem 六态变更（Main → Renderer 推送）。
    // 命中任务时原地更新 planItems 对应项 status/updatedAt，
    // Sidebar 任务行 / Inspector 清单 Tab / 对话流 PlanMessage 三视图同源刷新。
    unsubs.push(
      ark.task.onPlanItemStatusChanged((payload: PlanItemStatusChanged) => {
        set((s) => ({
          tasks: s.tasks.map((t) =>
            t.id === payload.taskId && t.planItems
              ? {
                  ...t,
                  planItems: t.planItems.map((p) =>
                    p.id === payload.planItemId
                      ? { ...p, status: payload.status, updatedAt: payload.ts }
                      : p,
                  ),
                }
              : t,
          ),
        }))
      }),
    )

    // v0.14.0 Task 4：按工具维度的并行 Act 进度（Main → Renderer）
    // 维护一个 per-requestId 字典 + 每 task 列表；UI 不会因多 act 并发互相覆盖
    unsubs.push(
      ark.task.onProgress((progress) => {
        set((s) => {
          const nextById = { ...s.toolProgress, [progress.requestId]: progress }
          const taskList = s.activeProgressByTask[progress.taskId] ?? []
          const nextTaskList = taskList.some((p) => p.requestId === progress.requestId)
            ? taskList.map((p) => (p.requestId === progress.requestId ? progress : p))
            : [...taskList, progress]
          // finished 后保留 6s 便于 UI 闪一下成功态，然后由 clear 事件移除
          return {
            toolProgress: nextById,
            activeProgressByTask: {
              ...s.activeProgressByTask,
              [progress.taskId]: nextTaskList,
            },
          }
        })
      }),
    )
    unsubs.push(
      ark.task.onProgressClear((payload: ToolProgressClearEvent) => {
        set((s) => {
          const taskList = s.activeProgressByTask[payload.taskId]
          if (!taskList) return s
          const nextList = payload.groupId
            ? taskList.filter((p) => p.groupId !== payload.groupId)
            : []
          const nextById = { ...s.toolProgress }
          for (const p of taskList) {
            if (!payload.groupId || p.groupId === payload.groupId) {
              delete nextById[p.requestId]
            }
          }
          return {
            toolProgress: nextById,
            activeProgressByTask: {
              ...s.activeProgressByTask,
              [payload.taskId]: nextList,
            },
          }
        })
      }),
    )

    // ReAct 事件（用于 Logs / 状态提示）
    unsubs.push(
      ark.task.onEvent((event) => {
        // 把关键事件写入 logs
        if (event.type === 'log') {
          get().appendLog({
            ts: Date.now(),
            level: event.level,
            source: event.source as LogEntry['source'],
            message: event.message,
          })
        } else if (event.type === 'ask_user') {
          // ask_user 暂停态：记录 Agent 问题全文，供 RunConsole 展示
          // 事件通常直接携带 question；若运行时缺失，回退到最近 ask_user 步骤提取
          const lastAskStep = [...get().steps]
            .reverse()
            .find((s) => (s as { type?: string }).type === 'ask_user') as
            | { question?: string }
            | undefined
          set({ askUserQuestion: event.question ?? lastAskStep?.question ?? null })
          // Task 4：若 Agent 附带了建议选项，渲染为建议卡片（带稳定 id）
          if (event.suggestions && event.suggestions.length > 0) {
            const suggestions: Suggestion[] = event.suggestions.map((s, i) => ({
              id: `ask-${Date.now()}-${i}`,
              label: s.label,
              description: s.description,
              recommended: s.recommended,
            }))
            set({ suggestions })
          }
        } else if (event.type === 'reason_end') {
          get().appendLog({
            ts: Date.now(),
            level: 'INFO',
            source: 'LLM',
            message: `iter ${event.iteration} reason_end tokens=${event.tokensIn ?? 0}+${event.tokensOut ?? 0} ⏱${event.durationMs}ms`,
          })
        } else if (event.type === 'act_end') {
          get().appendLog({
            ts: Date.now(),
            level: event.ok ? 'INFO' : 'ERROR',
            source: 'Tool',
            message: `act_end ${event.resultSummary} ⏱${event.durationMs}ms`,
          })
        } else if (event.type === 'task_complete') {
          get().appendLog({
            ts: Date.now(),
            level: 'INFO',
            source: 'Agent',
            message: `task_complete: ${event.summary.slice(0, 100)}`,
          })
          // v0.15.0 Task 7：建议由 LLM 在 task_complete args.suggestions 真实生成；
          // 仅当 event.suggestions 非空数组时才写入 suggestions 状态（空 / 缺失 → 不渲染建议卡）
          if (Array.isArray(event.suggestions) && event.suggestions.length > 0) {
            const nextSteps: Suggestion[] = event.suggestions.map((s, i) => ({
              id: `task-complete-${Date.now()}-${i}`,
              label: s.label,
              description: s.description,
              recommended: s.recommended,
            }))
            set({ suggestions: nextSteps })
          }
        } else if (event.type === 'task_failed') {
          get().appendLog({
            ts: Date.now(),
            level: 'ERROR',
            source: 'Agent',
            message: `task_failed: ${event.error}`,
          })
        } else if (event.type === 'memory_compressed') {
          // v0.9.1：L1 自动压缩事件此前被静默丢弃，现接入 ctx-chip（诚实 UI）
          get().pushCtxChip({
            text: `上下文已压缩 · ${event.beforeTokens} → ${event.afterTokens} tokens`,
            variant: 'compress',
          })
        } else if (event.type === 'context_compacted') {
          get().pushCtxChip({
            text: `上下文已压缩（L${event.layer} · ${event.beforeTokens} → ${event.afterTokens} tokens）`,
            variant: 'compress',
          })
        } else if (event.type === 'profile_updated') {
          // v0.9.1：L4 用户画像更新提示（此前被静默丢弃）
          get().pushCtxChip({
            text: `用户画像已更新 · v${event.version}（+${event.newObservations} 条观察）`,
            variant: 'update',
          })
        } else if (event.type === 'context_size_report') {
          // v0.15.x：仅当事件属于当前选中任务时更新真实 payload 用量
          if (get().selectedTaskId === event.taskId) {
            set({
              contextSize: {
                payloadTokens: event.payloadTokens,
                budget: event.budget,
                breakdown: {
                  systemTokens: event.systemTokens,
                  messagesTokens: event.messagesTokens,
                  toolsTokens: event.toolsTokens,
                  memoryInjectionTokens: event.memoryInjectionTokens,
                },
                modelContextWindow: event.modelContextWindow,
                reportedAt: Date.now(),
              },
            })
          }
        } else if (event.type === 'distill_completed') {
          // Task 10：蒸馏已后台自动完成（仅规模门槛命中才发生）——轻量 toast，不再弹"是否需要蒸馏"
          get().pushToast({
            type: 'success',
            message: event.message || '已将记忆合并到知识库',
            duration: 4000,
          })
          get().appendLog({
            ts: Date.now(),
            level: 'INFO',
            source: 'Memory',
            message: `distill_completed: ${event.category} — ${event.message}`,
          })
        } else if (event.type === 'task_progress') {
          // Task 9：阶段级进度回流（currentStage / overallPercentage / nextStepLabel）
          get().setTaskProgressStage(
            event.taskId,
            event.currentStage,
            event.overallPercentage,
            event.nextStepLabel,
          )
        } else if (event.type === 'task_step_complete') {
          // Task 9：SubTask（ReAct 步 / 必产文档子步骤）完成
          get().updateTaskProgressStep(
            event.taskId,
            event.stepId,
            event.ok ? 'completed' : 'failed',
            event.label,
          )
        } else if (event.type === 'task_milestone') {
          // Task 9：里程碑节点到达（含可选产物路径，可点击跳转）
          get().markTaskProgressMilestone(event.taskId, event.milestoneId, event.artifactPath)
        }
      }),
    )

    // v0.8.1：工具执行确认请求（Main → Renderer，ToolConfirmLayer 展示）
    unsubs.push(
      ark.confirm.onRequest((req) => {
        set({ pendingConfirm: req })
      }),
    )

    // Memory 变化
    unsubs.push(
      ark.memory.onChanged((taskId) => {
        if (get().selectedTaskId === taskId) {
          get().refreshMemory(taskId)
        }
      }),
    )

    // 日志推送
    unsubs.push(
      ark.log.onAppend((entry) => {
        get().appendLog(entry)
      }),
    )

    // v0.4.0：系统主题变化（仅当 theme==='system' 时联动 <html class>）
    unsubs.push(
      ark.theme.onSystemChange((systemTheme) => {
        const theme = get().theme
        const resolved = applyThemeClass(theme, systemTheme)
        set({ systemTheme, resolvedTheme: resolved })
      }),
    )

    return () => unsubs.forEach((u) => u())
  },
}))

export { shortTaskId, formatUpdatedAt }
export type { Task, TaskStatus }
