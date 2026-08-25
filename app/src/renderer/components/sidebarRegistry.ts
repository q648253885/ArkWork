/* ============================================================
 * ArkWork — Sidebar Widget Registry
 * Task 2：可组合的智能体 + 技能 + 右侧功能侧边栏架构
 *
 * 将右侧功能面板注册为独立 widget，按智能体的 enabledSidebarWidgetIds
 * 组合显示。组合维度：
 *   - 可用工具集 → defaultSkillIds（影响 ReAct 工具集）
 *   - 右侧面板   → enabledSidebarWidgetIds（影响 RightDock 暴露的面板）
 * 本注册表不参与 ReAct 循环（engine/runner 不变）。
 *
 * dockTabId：映射到现有 DockTabId 的 widget 才会作为 RightDock Tab 渲染；
 * 无 dockTabId 的 widget 为「已注册扩展点」（记忆中心 / 功能日志 / 浮窗预览），
 * 当前在模块页 / Inspector / 浮窗中消费，未来可提升为 Dock Tab。
 * ============================================================ */
import type { ComponentType } from 'react'
import type { Agent, DockTabId } from '@shared/types/agent'
import type { IconName } from '../icons'
import { TodoPanel } from './dock/TodoPanel'
import { ContextPanel } from './dock/ContextPanel'
import { TerminalPanel } from './dock/TerminalPanel'
import { BrowserPanel } from './dock/BrowserPanel'
import { ProgressPanel } from './dock/ProgressPanel'
import { FilesPanel } from './panels/FilesPanel'
import { MemoryPanel } from './panels/MemoryPanel'
import { LogsView } from './right/LogsView'
import { PreviewWindow } from './preview/PreviewWindow'

/** 右侧侧边栏 widget 场景标签 — 预留按场景过滤（如小说写作场景） */
export type SidebarScene = 'general' | 'coding' | 'writing' | 'research'

export interface SidebarWidget {
  /** 唯一 widget id（持久化到 agent.enabledSidebarWidgetIds） */
  widgetId: string
  /** 展示名 */
  name: string
  /** 图标名（keyof typeof Icon） */
  icon: IconName
  /** 面板组件（无 props） */
  component: ComponentType
  /** 支持的场景标签（预留按场景过滤；当前不强制） */
  supportedScenes: SidebarScene[]
  /** 缺省是否启用（agent 未声明 enabledSidebarWidgetIds 时生效） */
  defaultEnabled: boolean
  /** 映射到 RightDock 的 DockTabId；无则不作为 Dock Tab 渲染（扩展点） */
  dockTabId?: DockTabId
}

/**
 * SIDEBAR_WIDGETS — 右侧功能侧边栏 widget 注册表（单一事实源）
 * 顺序即 AgentEditor 勾选区与默认 Dock Tab 顺序的展示顺序。
 */
export const SIDEBAR_WIDGETS: SidebarWidget[] = [
  {
    widgetId: 'checklist',
    name: 'sidelist.checklist',
    icon: 'List',
    component: TodoPanel,
    supportedScenes: ['general', 'coding', 'writing', 'research'],
    defaultEnabled: true,
    dockTabId: 'todos',
  },
  {
    widgetId: 'context',
    name: 'sidelist.context',
    icon: 'Box',
    component: ContextPanel,
    supportedScenes: ['general', 'coding', 'writing', 'research'],
    defaultEnabled: true,
    dockTabId: 'context',
  },
  {
    widgetId: 'files',
    name: 'sidelist.files',
    icon: 'Folder',
    component: FilesPanel,
    supportedScenes: ['general', 'coding', 'writing', 'research'],
    defaultEnabled: true,
    dockTabId: 'files',
  },
  {
    widgetId: 'browser',
    name: 'sidelist.browser',
    icon: 'ExternalLink',
    component: BrowserPanel,
    supportedScenes: ['general', 'coding', 'writing', 'research'],
    defaultEnabled: true,
    dockTabId: 'browser',
  },
  {
    widgetId: 'terminal',
    name: 'sidelist.terminal',
    icon: 'Terminal',
    component: TerminalPanel,
    supportedScenes: ['coding'],
    defaultEnabled: true,
    dockTabId: 'terminal',
  },
  // Task 9：任务侧边栏进度摘要（默认不开启，避免打扰；用户可手动启用）
  {
    widgetId: 'progress',
    name: 'sidelist.progress',
    icon: 'ListChecks',
    component: ProgressPanel,
    supportedScenes: ['coding', 'general'],
    defaultEnabled: false,
    dockTabId: 'progress',
  },
  // —— 以下为已注册扩展点：组件已就绪，暂不作为 Dock Tab 渲染 ——
  // 记忆中心：当前在模块页（ModulePage）全页消费；可按需提升为 Dock Tab
  {
    widgetId: 'memory',
    name: 'sidelist.memory',
    icon: 'Brain',
    component: MemoryPanel,
    supportedScenes: ['general', 'writing', 'research'],
    defaultEnabled: false,
  },
  // 功能日志：当前在 Inspector / 设置页消费；可按需提升为 Dock Tab
  {
    widgetId: 'logs',
    name: 'sidelist.logs',
    icon: 'File',
    component: LogsView,
    supportedScenes: ['general', 'coding'],
    defaultEnabled: false,
  },
  // 预览浮窗：当前在 App.tsx 顶层渲染（⌘E 开关）；属浮窗能力，非 Dock Tab
  {
    widgetId: 'preview',
    name: 'sidelist.preview',
    icon: 'Eye',
    component: PreviewWindow,
    supportedScenes: ['general', 'coding', 'writing', 'research'],
    defaultEnabled: false,
  },
]

/** 缺省启用的 widget id 列表（agent.enabledSidebarWidgetIds 未设置时回落） */
export const DEFAULT_SIDEBAR_WIDGET_IDS: string[] = SIDEBAR_WIDGETS
  .filter((w) => w.defaultEnabled)
  .map((w) => w.widgetId)

/**
 * 返回某智能体启用的 widget 列表（保持注册表顺序）。
 * - agent.enabledSidebarWidgetIds 已设置 → 按其过滤（未知 id 忽略）
 * - 未设置（undefined / 空）→ 返回 defaultEnabled 的集合
 */
export function getEnabledWidgets(agent: Agent | undefined | null): SidebarWidget[] {
  const ids = agent?.enabledSidebarWidgetIds
  if (!ids || ids.length === 0) {
    return SIDEBAR_WIDGETS.filter((w) => w.defaultEnabled)
  }
  const set = new Set(ids)
  return SIDEBAR_WIDGETS.filter((w) => set.has(w.widgetId))
}

/** 返回某智能体启用且映射到 Dock Tab 的 DockTabId 集合（RightDock 过滤用） */
export function getEnabledDockTabIds(agent: Agent | undefined | null): Set<DockTabId> {
  const out = new Set<DockTabId>()
  for (const w of getEnabledWidgets(agent)) {
    if (w.dockTabId) out.add(w.dockTabId)
  }
  return out
}

/** DockTabId → widget 查询表（RightDock 渲染面板用，替代硬编码 switch） */
export const DOCK_TAB_WIDGET: Partial<Record<DockTabId, SidebarWidget>> = SIDEBAR_WIDGETS
  .filter((w): w is SidebarWidget & { dockTabId: DockTabId } => w.dockTabId !== undefined)
  .reduce((acc, w) => {
    acc[w.dockTabId] = w
    return acc
  }, {} as Partial<Record<DockTabId, SidebarWidget>>)

/* ============================================================
 * 扩展点：小说写作场景（novel-writing）
 * 计划新增专属 widget（如「章节大纲」「人物卡」「设定集」「时间线」），
 * 在此注册表追加即可被 AgentEditor 勾选；若需作为 Dock Tab 渲染，
 * 同步扩展 DockTabId 与 DOCK_TAB_META 即可，无需改动 ReAct 循环：
 *   {
 *     widgetId: 'outline', name: '章节大纲', icon: 'List',
 *     component: OutlinePanel, supportedScenes: ['writing'],
 *     defaultEnabled: false, dockTabId: <新增 DockTabId>,
 *   }
 * 当前仅预留注释，不实现。
 * ============================================================ */
