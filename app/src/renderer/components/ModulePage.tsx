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
import { useTranslation } from 'react-i18next'
import { Icon } from '../icons'
import { Tooltip } from './ui'
import { AutomationsPanel } from './panels/AutomationsPanel'
import { KbPanel } from './panels/KbPanel'
import { MemoryPanel } from './panels/MemoryPanel'
import { AgentsPanel } from './panels/AgentsPanel'
import { AbilitiesPanel } from './panels/AbilitiesPanel'
import { SettingsContent } from './SettingsContent'

import type { TFunction } from 'i18next'

/** 统一页面头部元信息：图标 + 标题 + 说明（spec §Requirement: 统一功能页面容器） */
function getModuleMeta(t: TFunction): Record<
  ModulePageId,
  { title: string; subtitle: string; icon: keyof typeof Icon; shortcut?: string }
> {
  return {
    automations: { title: t('modulepage.automations.title'), subtitle: t('modulepage.automations.subtitle'), icon: 'Clock', shortcut: '⌘5' },
    // v0.24.2：能力中心统一收纳技能 + 插件（MCP），page id 沿用 'skills' 仅 title 变更
    skills:      { title: t('modulepage.skills.title'),   subtitle: t('modulepage.skills.subtitle'), icon: 'Bolt',  shortcut: '⌘2' },
    agents:      { title: t('modulepage.agents.title'), subtitle: t('modulepage.agents.subtitle'),    icon: 'Bot',   shortcut: '⌘1' },
    kb:          { title: t('modulepage.kb.title'), subtitle: t('modulepage.kb.subtitle'),              icon: 'Book',  shortcut: '⌘3' },
    memory:      { title: t('modulepage.memory.title'),   subtitle: t('modulepage.memory.subtitle'),               icon: 'Brain', shortcut: '⌘4' },
    settings:    { title: t('modulepage.settings.title'),   subtitle: t('modulepage.settings.subtitle'), icon: 'Settings', shortcut: '⌘,' },
  }
}

/**
 * redesign-workspace-navigation Task 4：统一功能页面容器。
 * - 头部：图标 / 标题 / 说明 + 右上角统一关闭按钮（≥32×32 + Tooltip + 焦点环）
 * - 内容：按 page 路由到既有面板或 SettingsContent
 * - 关闭由 closeModulePage 负责；store 同时恢复 prevRightDockOpen
 */
export function ModulePage({ page }: { page: ModulePageId }) {
  const { t } = useTranslation()
  const closeModulePage = useStore((s) => s.closeModulePage)
  const meta = getModuleMeta(t)[page] as {
    title: string
    subtitle: string
    icon: keyof typeof Icon
    shortcut?: string
  }
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
  const { t } = useTranslation()
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
      <Tooltip label={t('modulepage.close.tooltip')} kbd={shortcut ?? 'Esc'}>
        <button
          onClick={onClose}
          aria-label={t('modulepage.close.aria', { title })}
          className="module-close-button inline-flex items-center justify-center w-11 h-11 flex-shrink-0 rounded-xl border border-accent text-accent bg-accent-soft hover:bg-accent hover:border-accent hover:text-text-inverse hover:shadow-md transition-colors focus-ring"
        >
          <Icon.X width={18} height={18} aria-hidden="true" />
        </button>
      </Tooltip>
    </div>
  )
}

/* ============================================================
 * ModuleBody — 按 page 路由到对应 panel / SettingsContent
 * v0.24.2：
 *   - 'agents'  → AgentsPanel（智能体列表 + 创建/编辑 + AgentEditor 弹窗挂载）
 *   - 'skills'  → AbilitiesPanel（能力中心：技能 + 插件 两子 Tab）
 * 设置走 SettingsContent（不再是 SettingsDialog Modal）。
 * ============================================================ */
function ModuleBody({ page }: { page: ModulePageId }) {
  switch (page) {
    case 'automations':
      return <div className="max-w-[960px] mx-auto p-6"><AutomationsPanel /></div>
    case 'skills':
      // v0.24.2：能力中心 — 容器自带「技能」「插件」两个子 Tab，
      // 外层 p-6 让 Tab 切换条与原有 SkillPanel 顶部对齐。
      return <div className="max-w-[960px] mx-auto p-6"><AbilitiesPanel /></div>
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