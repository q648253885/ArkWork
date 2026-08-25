/* ============================================================
 * ArkWork — Renderer Store 纯函数与常量（v0.27.0 R3：自 store.ts 纯移动）
 * friendlyError / Inspector·Dock 常量与清洗 / computeModelHealth /
 * clampWidth·resolveDockLayout / deriveConversation（F10：不再派生 planStates）/
 * formatTimeLabel / classifyLlmError / detectRenderer / applyThemeClass
 * ============================================================ */
import type { DockTabId, DockPreset, LlmModel } from '@shared/types/agent'
import type { ThemeMode, ResolvedTheme } from '@shared/types/ipc'
import type { Task } from '@shared/types/task'
import type { ReActStep } from '@shared/types/react'
import type { MemoryItem } from '@shared/types/memory'
import type { ConversationItem } from '@shared/types/conversation'
import type { DockPrefs, InspectorTabId, ModelHealth, RendererKind } from './types'
import i18n from '../i18n'

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
    if (code === 'noAgent') return i18n.t('meta.error.errAgentNotFound')
    if (code === 'noModel') return i18n.t('meta.error.errModelUnconfigured')
    if (code === 'invalidModel') return i18n.t('meta.error.errModelInvalid')
    if (code === 'missingTask') return i18n.t('meta.error.errTaskNotFound')
  }
  // 任务/工具/模型未找到
  if (/^task not found|任务不存在/i.test(raw)) return i18n.t('meta.error.errTaskNotFound')
  if (/tool not found/i.test(raw)) return i18n.t('meta.error.errToolNotRegistered')
  // v0.9.1 §Task 6：识别 runner / store 加的 "noModel:" / "noAgent:" 前缀
  if (/^noagent:\s*agent 不存在/i.test(raw)) return i18n.t('meta.error.errAgentNotFound')
  if (/^nomodel:\s*/i.test(raw)) return i18n.t('meta.error.errModelUnconfigured')
  if (/model not found|model 不可用|模型已禁用|invalidmodel/i.test(lower) || /model not found|no model|模型不可用/i.test(raw)) {
    return i18n.t('meta.error.errModelDisabled')
  }
  if (/agent not found/i.test(lower)) return i18n.t('meta.error.errAgentNotFound')
  // 网络类
  if (/econnrefused|connect econnrefused/i.test(lower)) return i18n.t('meta.error.errConnRefused')
  if (/fetch failed|network|enotfound|etimedout|timeout|abort/i.test(lower)) return i18n.t('meta.error.errNetwork')
  if (/401|unauthorized|invalid api key/i.test(lower)) return i18n.t('meta.error.errUnauthorized')
  if (/429|rate limit/i.test(lower)) return i18n.t('meta.error.errRateLimit')
  // 文件类
  if (/file not found|enoent/i.test(lower)) return i18n.t('meta.error.errFileNotFound')
  // 权限/沙盒类：工作区目录不可写（EPERM/EACCES——常见于从终端受限启动时）
  if (/eperm|eacces|operation not permitted|permission denied|工作区目录不可写|无法写入工作区/i.test(lower)) {
    return i18n.t('meta.error.errPermission')
  }
  // 模型服务端错误：402 余额不足等
  if (/402|insufficient\s*balance|余额不足/i.test(raw)) {
    return i18n.t('meta.error.errInsufficientBalance')
  }
  return fallback ?? raw
}
/** label 存 i18n key，渲染处 t(label) 取值（模块级急切翻译会导致语言切换后不更新） */
export const INSPECTOR_TAB_META: Record<InspectorTabId, { label: string; icon: string; shortcut: string }> = {
  todos:   { label: 'meta.inspector.todos',   icon: 'Check',   shortcut: '⌥1' },
  context: { label: 'meta.inspector.context', icon: 'Box',     shortcut: '⌥2' },
  files:   { label: 'meta.inspector.files',   icon: 'Folder',  shortcut: '⌥3' },
  logs:    { label: 'meta.inspector.logs',    icon: 'List',    shortcut: '⌥4' },
  browser: { label: 'meta.inspector.browser', icon: 'Eye',     shortcut: '⌥5' },
  // v0.27.0 r10-F14a：终端（输出查看器）纳入 Inspector，原 RightDock 宿主已无挂载点
  terminal:{ label: 'meta.inspector.terminal', icon: 'Terminal', shortcut: '⌥6' },
}

/** Inspector 固定 Tab 顺序 — Task 5：清单 / 上下文 / 文件 / 日志 / 浏览器；r10-F14a 追加终端 */
export const INSPECTOR_TAB_ORDER: InspectorTabId[] = ['todos', 'context', 'files', 'logs', 'browser', 'terminal']

/** Inspector 默认 Tab — 选 todos（最普适，Plan ↔ Todos 同步链路核心） */
export const DEFAULT_INSPECTOR_TAB: InspectorTabId = 'todos'

/** v0.17.0 F13：清洗持久化的 Tab 顺序（去重、补缺、剔除非法项，保证 5 个 Tab 齐全） */
export function sanitizeInspectorOrder(raw: unknown): InspectorTabId[] {
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
export function sanitizeHiddenTabs(raw: unknown): InspectorTabId[] {
  if (!Array.isArray(raw)) return []
  const valid = INSPECTOR_TAB_ORDER
  return raw.filter(
    (t) => (valid as string[]).includes(t as string) && t !== 'browser',
  ) as InspectorTabId[]
}
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

/** v0.9.0 F901：Dock Tab 展示元信息（label 存 i18n key，渲染处 t(label)） */
export const DOCK_TAB_META: Record<DockTabId, { label: string; icon: string; shortcut: string }> = {
  files: { label: 'meta.dock.files', icon: 'Folder', shortcut: '⌥1' },
  context: { label: 'meta.dock.context', icon: 'Box', shortcut: '⌥2' },
  terminal: { label: 'meta.dock.terminal', icon: 'Terminal', shortcut: '⌥3' },
  browser: { label: 'meta.dock.browser', icon: 'ExternalLink', shortcut: '⌥4' },
  todos: { label: 'meta.dock.todos', icon: 'List', shortcut: '⌥5' },
  // Task 9：任务侧边栏进度摘要
  progress: { label: 'meta.dock.progress', icon: 'ListChecks', shortcut: '⌥6' },
}

/** v0.9.0 F905：Dock 预设的 Tab 顺序（用于 ⌥1~5 视觉顺序映射与约束检查） */
export const DOCK_TAB_ORDER: DockTabId[] = ['files', 'context', 'terminal', 'browser', 'todos', 'progress']
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
export function clampWidth(value: unknown, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : min
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** v0.9.0 F905：解析某智能体的有效 Dock 布局（预设 × 用户偏好） */
export function resolveDockLayout(agentId: string, prefs: DockPrefs | undefined): { tabs: DockTabId[]; defaultTab: DockTabId } {
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
export function deriveConversation(
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

  // 2. v0.8.0：计划清单条目（TraeWork 式）——plan 步骤单独成卡。
  // v0.27.0 F10：渲染层不再派生逐项状态，
  // 单一真源为 task.planItems（Main patch/snapshot 推送）；
  // 卡片状态链：task.planItems > item.planStates > []，见 ConversationFlow.PlanMessage。
  const planStep = steps.find((s) => s.type === 'plan' && s.plan)
  let planItem: ConversationItem | null = null
  if (planStep?.plan) {
    planItem = {
      id: `${task.id}-plan`,
      type: 'plan',
      plan: planStep.plan,
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
    // v0.23.1：ask_user 的问题也是面向用户的最终输出 — 生成 assistant 消息
    // 永久保留在交互区（此前问题只存在于暂停态卡片，作答后即消失）。
    const isAskUser = reasonStep?.action?.tool === 'ask_user'
    // 最终回复：task_complete / ask_user / 无 action（模型直接回复未调用工具）
    const isFinalAnswer = isComplete || isAskUser || !reasonStep?.action
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
          : isAskUser
            ? (reasonStep.action?.args?.question as string) ?? reasonStep.thought ?? ''
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
export function classifyLlmError(rawErr: string): string | null {
  if (!rawErr) return null
  const err = rawErr.toLowerCase()
  // 余额不足
  if (err.includes('insufficient') || err.includes('balance') || /\b402\b/.test(rawErr)) {
    return i18n.t('meta.llm.balance')
  }
  // 鉴权失败
  if (
    err.includes('unauthorized') ||
    err.includes('invalid api key') ||
    err.includes('authentication') ||
    /\b401\b/.test(rawErr) ||
    /\b403\b/.test(rawErr) ||
    err.includes('forbidden') ||
    err.includes('access denied')
  ) {
    return i18n.t('meta.llm.auth')
  }
  // 限流
  if (err.includes('rate limit') || err.includes('too many requests') || /\b429\b/.test(rawErr)) {
    return i18n.t('meta.llm.rateLimit')
  }
  // 服务异常
  if (/\b5\d\d\b/.test(rawErr) || err.includes('internal server') || err.includes('bad gateway')) {
    return i18n.t('meta.llm.serverError')
  }
  // 上下文超限
  if (
    err.includes('context_length_exceeded') ||
    err.includes('max_tokens') ||
    err.includes('maximum context length') ||
    err.includes('prompt is too long')
  ) {
    return i18n.t('meta.llm.contextOverflow')
  }
  // 网络
  if (
    err.includes('network') ||
    err.includes('fetch failed') ||
    err.includes('econnrefused') ||
    err.includes('etimedout') ||
    err.includes('socket hang up') ||
    err.includes('aborted')
  ) {
    return i18n.t('meta.llm.network')
  }
  return null
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
export function applyThemeClass(theme: ThemeMode, systemTheme: ResolvedTheme): ResolvedTheme {
  const resolved: ResolvedTheme =
    theme === 'system' ? systemTheme : theme
  const root = document.documentElement
  if (resolved === 'dark') root.classList.add('dark')
  else root.classList.remove('dark')
  return resolved
}
