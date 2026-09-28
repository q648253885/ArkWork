/* ============================================================
 * ArkWork — 工作台中心（v0.34.0 建 · v0.36.0 收敛为单页）
 * 设计文档：docs/versions/v0.36.0/03-interaction.md §4 P1（重构）
 *          docs/versions/v0.36.0/04-system-design.md §3.7（F5.2）
 *          （上游 v0.34.0/04-system-design.md §4.3）
 *
 * ★ v0.36.0（F5.1/F5.2）两处收敛：
 *  ① **子页签被删除** —— 原 `profiles | diagnostics` 双 Tab 的第二个是「诊断」，
 *     它把「我声明了什么 / 实际生效了什么」并列成两屏，反而让用户必须来回对照。
 *     现在合成一页：列表 + 详情（三步分区），降级与校验问题就地以横幅呈现。
 *  ② `DiagnosticsView.tsx` **物理删除**（不是取消引用）—— 留着不引用就是
 *     v0.32.2 审计里的「死组件」：下一个人会以为它还活着。
 *
 * v0.34.0 收敛（保留）：第三个子页「插件」已迁出 —— 插件是「能力」，
 * 属于「能力」页（`panels/AbilitiesPanel` 的「插件」Tab），与技能、MCP 并列。
 * ============================================================ */
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '../../store'
import { ProfilesView } from './ProfilesView'

export function WorkbenchCenter() {
  const { t } = useTranslation()
  const loadProfiles = useStore((s) => s.loadProfiles)
  const loadPlugins = useStore((s) => s.loadPlugins)
  const profileLoaded = useStore((s) => s.profileLoaded)
  const pluginsLoaded = useStore((s) => s.pluginsLoaded)
  const plugins = useStore((s) => s.plugins)
  const profiles = useStore((s) => s.profiles)

  // 进页即确保数据在手（init 已拉过一次，这里是幂等兜底）
  // 注：plugins 不在此页独立成子页，但详情里的「插件与技能」复选要它的清单
  useEffect(() => {
    if (!profileLoaded) void loadProfiles()
    if (!pluginsLoaded) void loadPlugins()
  }, [profileLoaded, pluginsLoaded, loadProfiles, loadPlugins])

  return (
    <div className="max-w-[1040px] mx-auto p-6">
      <header className="flex items-baseline gap-3 mb-5 border-b border-border-subtle pb-3">
        <h1 className="text-sm font-medium text-text-primary">{t('workbench.title')}</h1>
        <span className="text-2xs text-text-faint">
          {t('workbench.summary', { profiles: profiles.length, plugins: plugins.length })}
        </span>
      </header>

      <ProfilesView />
    </div>
  )
}
