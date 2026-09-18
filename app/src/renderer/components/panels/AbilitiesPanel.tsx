/* ============================================================
 * ArkWork — AbilitiesPanel
 * v0.34.0 — 能力中心容器（三 Tab）
 * 设计文档：docs/versions/v0.34.0/04-system-design.md §4.1
 *
 * 「能力」页面下设三个子 Tab（Q5 裁决的顺序：技能 → 插件 → MCP）：
 *   - 技能  → SkillsPanel（已有技能 + 市场；SKILL.md 形态）
 *   - 插件  → CapabilityPluginsPanel（能力插件：面板/渲染器/动作/首页/主题）
 *   - MCP   → PluginsPanel（MCP Server 接入的外部工具能力，stdio / sse）
 *
 * P3 修正的命名错位：v0.24.2 起 `PluginsPanel` 其实一直是 **MCP 管理**，
 * 却挂在「插件」Tab 下，与工作台中心的「插件」（能力插件）同名不同物 ——
 * 这正是用户实测「工作区的插件和能力里的插件有重叠」的根因。
 * 本版把两者分开：能力页的「插件」＝能力插件，「MCP」＝MCP Server。
 *
 * 整体设计沿用 v4.2 暖夜色 + 紫罗兰，紧凑排版。
 */
import { useState } from 'react'
import { Icon } from '../../icons'
import { useStore } from '../../store'
import { useTranslation } from 'react-i18next'
import { SkillsPanel } from './SkillsPanel'
import { PluginsPanel } from './PluginsPanel'
import { CapabilityPluginsPanel } from './CapabilityPluginsPanel'

type AbilityTab = 'skills' | 'plugins' | 'mcp'

function getTabMeta(t: (k: string) => string): Record<AbilityTab, { label: string; icon: React.ReactNode; hint: string }> {
  return {
    skills: {
      label: t('panel.abilities.tab.skills'),
      icon: <Icon.Bolt width={12} height={12} />,
      hint: t('panel.abilities.hint.skills'),
    },
    plugins: {
      label: t('panel.abilities.tab.plugins'),
      icon: <Icon.Plug width={12} height={12} />,
      hint: t('panel.abilities.hint.plugins'),
    },
    mcp: {
      label: t('panel.abilities.tab.mcp'),
      icon: <Icon.Command width={12} height={12} />,
      hint: t('panel.abilities.hint.mcp'),
    },
  }
}

/** Tab 渲染顺序（显式声明，不依赖对象键序） */
const TAB_ORDER: AbilityTab[] = ['skills', 'plugins', 'mcp']

export function AbilitiesPanel() {
  const { t } = useTranslation()
  const TAB_META = getTabMeta(t)
  const [activeTab, setActiveTab] = useState<AbilityTab>('skills')
  const skills = useStore((s) => s.skills)
  const mcps = useStore((s) => s.mcps)
  const plugins = useStore((s) => s.plugins)

  const counts: Record<AbilityTab, number> = {
    skills: skills.length,
    plugins: plugins.length,
    mcp: mcps.length,
  }

  return (
    <div className="flex flex-col h-full" data-testid="abilities-panel">
      {/* Tab 切换条 */}
      <div
        className="px-3 pt-3 pb-2 flex items-center gap-1 border-b border-border-subtle flex-shrink-0"
        data-testid="abilities-tabs"
      >
        {TAB_ORDER.map((t) => {
          const meta = TAB_META[t]
          const active = t === activeTab
          return (
            <button
              key={t}
              onClick={() => setActiveTab(t)}
              data-tab={t}
              data-tab-label={meta.label}
              className={`flex items-center gap-1.5 px-2.5 h-7 text-xs transition-colors border-b-2 -mb-px rounded-t-md ${
                active
                  ? 'border-accent text-text-primary bg-bg-surface'
                  : 'border-transparent text-text-tertiary hover:text-text-secondary hover:bg-bg-hover'
              }`}
            >
              {meta.icon}
              <span>{meta.label}</span>
              <span className="tabular text-2xs text-text-tertiary">{counts[t]}</span>
            </button>
          )
        })}
        {/* 顶部 hint 区 */}
        <span className="ml-2 text-2xs text-text-tertiary truncate flex-1 min-w-0">
          {TAB_META[activeTab].hint}
        </span>
      </div>

      {/* Tab 内容 */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {activeTab === 'skills' && <SkillsPanel />}
        {activeTab === 'plugins' && <CapabilityPluginsPanel />}
        {activeTab === 'mcp' && <PluginsPanel />}
      </div>
    </div>
  )
}