/* ============================================================
 * ArkWork — AbilitiesPanel
 * v0.24.2 — 能力中心容器
 *
 * 「能力」页面下设两个子 Tab：
 *   - 技能  → SkillsPanel（已有技能 + 市场）
 *   - 插件  → PluginsPanel（MCP Server 列表管理）
 *
 * SkillsPanel 不做改动，作为第一个 Tab 内容复用。
 * 整体设计沿用 v4.2 暖夜色 + 紫罗兰，紧凑排版。
 */
import { useState } from 'react'
import { Icon } from '../../icons'
import { useStore } from '../../store'
import { useTranslation } from 'react-i18next'
import { SkillsPanel } from './SkillsPanel'
import { PluginsPanel } from './PluginsPanel'

type AbilityTab = 'skills' | 'plugins'

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
  }
}

export function AbilitiesPanel() {
  const { t } = useTranslation()
  const TAB_META = getTabMeta(t)
  const [activeTab, setActiveTab] = useState<AbilityTab>('skills')
  const skills = useStore((s) => s.skills)
  const mcps = useStore((s) => s.mcps)

  const counts: Record<AbilityTab, number> = {
    skills: skills.length,
    plugins: mcps.length,
  }

  return (
    <div className="flex flex-col h-full" data-testid="abilities-panel">
      {/* Tab 切换条 */}
      <div
        className="px-3 pt-3 pb-2 flex items-center gap-1 border-b border-border-subtle flex-shrink-0"
        data-testid="abilities-tabs"
      >
        {(Object.keys(TAB_META) as AbilityTab[]).map((t) => {
          const meta = TAB_META[t]
          const active = t === activeTab
          return (
            <button
              key={t}
              onClick={() => setActiveTab(t)}
              data-tab={meta.label}
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
        {activeTab === 'skills' ? <SkillsPanel /> : <PluginsPanel />}
      </div>
    </div>
  )
}