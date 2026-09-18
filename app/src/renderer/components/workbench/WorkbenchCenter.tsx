/* ============================================================
 * ArkWork — 工作台中心（v0.34.0 · 配置能力宿主）
 * 设计文档：docs/versions/v0.34.0/04-system-design.md §4.3
 *          （上游 v0.33.0/02-prd.md §3 / 03-interaction.md §「工作台中心」）
 *
 * 两子页（子页签状态**本地持有** —— 它不是用户偏好，不该进 store 被持久化）：
 *   工作台（Profiles） · 诊断（Diagnostics）
 *
 * 为什么合成一页而不是两个模块页：两者是同一件事的两个视角 ——
 * 「我声明了什么（工作台）/ 实际生效了什么（诊断）」。
 * 分散在两处会让「配置与事实不符」这类问题无法被一眼发现。
 *
 * v0.34.0 收敛：原第三个子页「插件」**已迁出** ——
 * 插件是「能力」，属于「能力」页（`panels/AbilitiesPanel` 的「插件」Tab），
 * 与技能、MCP 并列。此处再留一份就是用户实测的
 * 「工作区的插件和能力里的插件有重叠」。
 * ============================================================ */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon, type IconName } from '../../icons'
import { useStore } from '../../store'
import { ProfilesView } from './ProfilesView'
import { DiagnosticsView } from './DiagnosticsView'

type Tab = 'profiles' | 'diagnostics'

const TABS: Array<{ id: Tab; icon: IconName }> = [
  { id: 'profiles', icon: 'Workspace' },
  { id: 'diagnostics', icon: 'Graph' },
]

export function WorkbenchCenter({ initialTab }: { initialTab?: Tab }) {
  const { t } = useTranslation()
  const loadProfiles = useStore((s) => s.loadProfiles)
  const loadPlugins = useStore((s) => s.loadPlugins)
  const profileLoaded = useStore((s) => s.profileLoaded)
  const pluginsLoaded = useStore((s) => s.pluginsLoaded)
  const plugins = useStore((s) => s.plugins)
  const profiles = useStore((s) => s.profiles)
  const [tab, setTab] = useState<Tab>(initialTab ?? 'profiles')

  // 进页即确保数据在手（init 已拉过一次，这里是幂等兜底）
  // 注：plugins 不再有本页子页，但「诊断」视图会展示生效插件，故仍需拉取
  useEffect(() => {
    if (!profileLoaded) void loadProfiles()
    if (!pluginsLoaded) void loadPlugins()
  }, [profileLoaded, pluginsLoaded, loadProfiles, loadPlugins])

  return (
    <div className="max-w-[1040px] mx-auto p-6">
      {/* 子页签：pill 风格，与 ModulePage 头部视觉一致 */}
      <div role="tablist" aria-label={t('workbench.title')} className="flex items-center gap-1 mb-5 border-b border-border-subtle">
        {TABS.map((x) => {
          const active = x.id === tab
          const IconCmp = Icon[x.icon]
          return (
            <button
              key={x.id}
              role="tab"
              aria-selected={active}
              onClick={() => setTab(x.id)}
              className={`relative flex items-center gap-1.5 h-9 px-3 text-xs transition-colors focus-ring ${active ? 'text-text-primary' : 'text-text-tertiary hover:text-text-secondary'}`}
            >
              <IconCmp width={14} height={14} aria-hidden />
              {t(`workbench.tab.${x.id}`)}
              {active && <span className="absolute left-2 right-2 -bottom-px h-0.5 bg-accent rounded-full" aria-hidden />}
            </button>
          )
        })}
        <div className="flex-1" />
        <span className="text-2xs text-text-faint pb-1">
          {t('workbench.summary', { profiles: profiles.length, plugins: plugins.length })}
        </span>
      </div>

      {tab === 'profiles' && <ProfilesView />}
      {tab === 'diagnostics' && <DiagnosticsView />}
    </div>
  )
}
