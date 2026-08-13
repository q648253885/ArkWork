/* ============================================================
 * ArkWork — ModulePage (redesign-workspace-navigation Task 4)
 * 统一功能页面容器：智能体 / 技能 / 知识 / 记忆 / 自动化 / 设置
 *
 * 设计要点（spec §统一功能页面容器）：
 *  - 统一头部：SVG 图标 + 标题 + 可选说明 + 最右侧 ≥44×44 关闭按钮
 *  - 关闭按钮带 Tooltip、aria-label、focus-ring（2px accent 焦点环），键盘可达
 *  - 关闭调用 closeModulePage → 恢复此前任务/对话（store 已处理）
 *  - 设置不再是 Modal：直接渲染 SettingsContent（已无 role=dialog）
 *  - 不复制现有 panel 内容：自动化/技能/智能体/知识/记忆复用既有面板
 *  - 不引入额外浮层/快捷键路径：Esc 在 App.tsx 已处理 modulePage 关闭
 * ============================================================ */
import { useStore, type ModulePage as ModulePageId } from '../store'
import { Icon } from '../icons'
import { Tooltip } from './ui'
import { AutomationsPanel } from './panels/AutomationsPanel'
import { KbPanel } from './panels/KbPanel'
import { MemoryPanel } from './panels/MemoryPanel'
import { AgentsPanel } from './panels/AgentsPanel'
import { SkillsPanel } from './panels/SkillsPanel'
import { SettingsContent } from './SettingsContent'

/** 统一页面头部元信息：图标 + 标题 + 说明（spec §Requirement: 统一功能页面容器） */
const MODULE_META: Record<ModulePageId, { title: string; subtitle: string; icon: keyof typeof Icon; shortcut?: string }> = {
  automations: { title: '自动化', subtitle: '定时或手动触发的 Agent 任务', icon: 'Clock', shortcut: '⌘5' },
  skills:      { title: '技能',   subtitle: 'Skill 列表 · 启用/禁用 · 导入/导出', icon: 'Bolt',  shortcut: '⌘2' },
  agents:      { title: '智能体', subtitle: 'Agent 角色 · 人格 · 默认模型',    icon: 'Bot',   shortcut: '⌘1' },
  kb:          { title: '知识库', subtitle: '文档解析 · 检索注入',              icon: 'Book',  shortcut: '⌘3' },
  memory:      { title: '记忆',   subtitle: 'L1–L4 四层记忆视图',               icon: 'Brain', shortcut: '⌘4' },
  settings:    { title: '设置',   subtitle: '模型 / 工作区 / 外观 / 快捷键 / 高级', icon: 'Settings', shortcut: '⌘,' },
}

/**
 * redesign-workspace-navigation Task 4：统一功能页面容器。
 * - 头部：图标 / 标题 / 说明 + 右上角统一关闭按钮（≥32×32 + Tooltip + 焦点环）
 * - 内容：按 page 路由到既有面板或 SettingsContent
 * - 关闭由 closeModulePage 负责；store 同时恢复 prevRightDockOpen
 */
export function ModulePage({ page }: { page: ModulePageId }) {
  const closeModulePage = useStore((s) => s.closeModulePage)
  const meta = MODULE_META[page]
  const ModuleIcon = Icon[meta.icon]

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0 bg-bg-base overflow-hidden">
      {/* 统一功能页面头部（spec：图标 / 标题 / 说明 / 关闭按钮） */}
      <ModuleHeader
        title={meta.title}
        subtitle={meta.subtitle}
        Icon={ModuleIcon}
        shortcut={meta.shortcut}
        onClose={() => closeModulePage()}
      />

      {/* 内容：自动化/技能/智能体/知识/记忆复用既有 panel；设置直接渲染 SettingsContent */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <ModuleBody page={page} />
      </div>
    </div>
  )
}

/* ============================================================
 * ModuleHeader — 统一功能页面头部
 * - 左侧：图标徽章 + 标题 + 说明
 * - 右侧：≥44×44 关闭按钮（Task 11：命中区最大可点击，focus-ring + Tooltip + aria-label）
 * ============================================================ */
function ModuleHeader({
  title,
  subtitle,
  Icon: HeaderIcon,
  shortcut,
  onClose,
}: {
  title: string
  subtitle: string
  Icon: (p: React.SVGProps<SVGSVGElement>) => JSX.Element
  shortcut?: string
  onClose: () => void
}) {
  return (
    <div className="relative flex items-center gap-3 h-14 pl-5 pr-3 border-b border-border-subtle flex-shrink-0 bg-bg-base">
      <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-bg-surface border border-border-subtle text-accent flex-shrink-0">
        <HeaderIcon width={17} height={17} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <h1 className="text-sm font-semibold text-text-primary truncate">{title}</h1>
        <p className="text-2xs text-text-tertiary truncate">{subtitle}</p>
      </div>
      {/* polish-workspace-task-title-skills-context-help §Task 6.1：
          关闭按钮靠在最右侧、紧贴右内边距(pr-3)，不再"挨着标题" */}
      <Tooltip label="关闭并返回任务" kbd={shortcut ?? 'Esc'}>
        <button
          onClick={onClose}
          aria-label={`关闭${title}页面，返回任务（Esc）`}
          className="module-close-button inline-flex items-center justify-center w-11 h-11 flex-shrink-0 rounded-xl border border-accent/40 text-accent bg-accent-soft hover:bg-accent hover:border-accent hover:text-text-inverse hover:shadow-md transition-colors focus-ring"
        >
          <Icon.X width={18} height={18} aria-hidden="true" />
        </button>
      </Tooltip>
    </div>
  )
}

/* ============================================================
 * ModuleBody — 按 page 路由到对应 panel / SettingsContent
 * 智能体与技能拆分为独立面板（fix-workspace-task-automation-memory Task 3）：
 *   - 'agents'  → AgentsPanel（智能体列表 + 创建/编辑 + AgentEditor 弹窗挂载）
 *   - 'skills'  → SkillsPanel（技能列表 + 启用/禁用 + 编辑/导出/删除）
 * 市场 tab 不再作为两者内部默认 Tab（市场入口暂不在本轮范围）。
 * 设置走 SettingsContent（不再是 SettingsDialog Modal）。
 * ============================================================ */
function ModuleBody({ page }: { page: ModulePageId }) {
  switch (page) {
    case 'automations':
      return <div className="max-w-[960px] mx-auto p-6"><AutomationsPanel /></div>
    case 'skills':
      return <div className="max-w-[960px] mx-auto p-6"><SkillsPanel /></div>
    case 'agents':
      // AgentsPanel 内置 AgentEditor 弹窗生命周期（agent + open 状态）
      return <div className="max-w-[960px] mx-auto p-6"><AgentsPanel /></div>
    case 'kb':
      return <div className="max-w-[960px] mx-auto p-6"><KbPanel /></div>
    case 'memory':
      return <div className="max-w-[960px] mx-auto p-6"><MemoryPanel /></div>
    case 'settings':
      // redesign-workspace-navigation Task 4：设置页面化 — 直接渲染正文，
      // 不再依赖 SettingsDialog 的 role=dialog / backdrop / modal。
      return <SettingsContent />
    default:
      return null
  }
}