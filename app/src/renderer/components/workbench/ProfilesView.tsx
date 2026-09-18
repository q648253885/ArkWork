/* ============================================================
 * ArkWork — 工作台子页（v0.33.0 · 配置中心）
 * 设计文档：docs/versions/v0.33.0/02-prd.md §3.1 / 03-interaction.md §「工作台」
 *
 * 区块：生效卡 → 操作条（导入 / 克隆 / 导出 / 编辑 / 删除 / 激活）
 *       → 列表 → 激活报告抽屉入口
 *
 * 三条纪律：
 *  ① **危险动作必须说清后果**：删除内置台 / 生效中的台会被拒（主进程侧也拒），
 *     UI 上就把按钮禁用并给出原因 Tooltip，而不是点完再报错；
 *  ② **一切写入后重新拉取**（不做乐观更新）—— 主进程是唯一真源；
 *  ③ **报告随取随看**：激活报告始终在 store 里，抽屉打开即展示最近一次结果。
 * ============================================================ */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon, type IconName } from '../../icons'
import { Tooltip } from '../ui'
import { useStore } from '../../store'
import { ark } from '../../ipc/client'
import { ActivationReportView } from './ActivationReportView'
import { ProfileEditor } from './ProfileEditor'
import { ImportDialog } from './ImportDialog'

function iconOf(name?: string) {
  const table = Icon as unknown as Record<string, (p: { width?: number; height?: number; className?: string; 'aria-hidden'?: boolean }) => JSX.Element>
  return table[(name ?? '') as IconName] ?? Icon.Box
}

export function ProfilesView() {
  const { t } = useTranslation()
  const profiles = useStore((s) => s.profiles)
  const activeId = useStore((s) => s.activeProfileId)
  const snapshot = useStore((s) => s.profileSnapshot)
  const degraded = useStore((s) => s.profileDegraded)
  const lastReport = useStore((s) => s.profileLastReport)
  const busy = useStore((s) => s.profileBusy)
  const plugins = useStore((s) => s.plugins)
  const switchProfile = useStore((s) => s.switchProfile)
  const loadProfiles = useStore((s) => s.loadProfiles)
  const pushToast = useStore((s) => s.pushToast)

  const [editing, setEditing] = useState<{ id: string; source: 'builtin' | 'user' } | null>(null)
  const [importing, setImporting] = useState(false)
  const [showReport, setShowReport] = useState(false)

  const active = profiles.find((p) => p.id === activeId)
  const ActiveIcon = iconOf(active?.icon)

  const doExport = async (id: string) => {
    const res = await ark.profile.export({ id })
    if (!res.ok) {
      pushToast({ type: 'warning', message: t('workbench.profiles.exportFailed'), duration: 5000 })
      return
    }
    // 本版不给「另存为」对话框（需 main 侧 save dialog，属遗留）——
    // 导出走剪贴板 + toast 提示，用户可直接粘进文件
    try {
      await navigator.clipboard.writeText(res.json)
      pushToast({ type: 'success', message: t('workbench.profiles.exportCopied'), duration: 5000 })
    } catch {
      pushToast({ type: 'warning', message: t('workbench.profiles.exportClipboardFailed'), duration: 6000 })
    }
  }

  const doDelete = async (id: string) => {
    const res = await ark.profile.delete({ id })
    if (!res.ok) {
      const key = res.reason === 'builtin' ? 'deleteBuiltin' : res.reason === 'active' ? 'deleteActive' : 'deleteNotFound'
      pushToast({ type: 'warning', message: t(`workbench.profiles.${key}`), duration: 5000 })
      return
    }
    await loadProfiles()
    pushToast({ type: 'success', message: t('workbench.profiles.deleted', { id }), duration: 4000 })
  }

  const reload = async () => {
    await loadProfiles()
  }

  return (
    <div className="space-y-5">
      {/* ---------- 生效卡 ---------- */}
      <section className="rounded-xl border border-border-default bg-bg-surface p-4">
        <div className="flex items-start gap-3">
          <span className="inline-flex items-center justify-center w-9 h-9 rounded-lg bg-accent-soft text-accent flex-shrink-0">
            <ActiveIcon width={18} height={18} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-text-primary truncate">
                {active?.name ?? t('profile.switcher.unknown')}
              </h2>
              {active?.source === 'builtin' && (
                <span className="text-2xs text-text-faint border border-border-subtle rounded px-1 leading-4">
                  {t('profile.source.builtin')}
                </span>
              )}
            </div>
            <div className="text-2xs text-text-tertiary mt-0.5">
              <span className="font-mono">{activeId}</span>
              {active && (
                <>
                  {' · '}
                  {t('profile.meta.line', { namespace: active.namespace, agents: active.agents, caps: active.capabilities })}
                </>
              )}
            </div>
            {active?.description && (
              <p className="text-xs text-text-secondary mt-1.5">{active.description}</p>
            )}
          </div>
          <button
            type="button"
            onClick={() => setShowReport((v) => !v)}
            aria-expanded={showReport}
            className="flex items-center gap-1.5 h-8 px-2.5 rounded-md border border-border-subtle text-xs text-text-secondary hover:bg-bg-hover focus-ring flex-shrink-0"
          >
            <Icon.Info width={13} height={13} aria-hidden />
            {t('workbench.profiles.report')}
            {degraded.length > 0 && (
              <span className="w-1.5 h-1.5 rounded-full bg-warning" aria-label={t('profile.degraded.count', { count: degraded.length })} />
            )}
          </button>
        </div>

        {showReport && (
          <div className="mt-3 pt-3 border-t border-border-subtle">
            <ActivationReportView report={lastReport} snapshot={snapshot} degraded={degraded} />
          </div>
        )}
      </section>

      {/* ---------- 操作条 ---------- */}
      <section className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => setImporting(true)}
          className="flex items-center gap-1.5 h-8 px-3 rounded-md bg-business-primary text-text-inverse text-xs hover:bg-business-primary-hover focus-ring"
        >
          <Icon.Upload width={13} height={13} aria-hidden />
          {t('workbench.profiles.import')}
        </button>
        <button
          type="button"
          disabled={!active}
          onClick={() => active && setEditing({ id: active.id, source: active.source })}
          className="flex items-center gap-1.5 h-8 px-3 rounded-md border border-border-subtle text-xs text-text-secondary hover:bg-bg-hover disabled:opacity-50 focus-ring"
        >
          <Icon.Edit width={13} height={13} aria-hidden />
          {active?.source === 'builtin' ? t('workbench.profiles.clone') : t('workbench.profiles.edit')}
        </button>
        <button
          type="button"
          disabled={!active}
          onClick={() => active && void doExport(active.id)}
          className="flex items-center gap-1.5 h-8 px-3 rounded-md border border-border-subtle text-xs text-text-secondary hover:bg-bg-hover disabled:opacity-50 focus-ring"
        >
          <Icon.Download width={13} height={13} aria-hidden />
          {t('workbench.profiles.export')}
        </button>
      </section>

      {/* ---------- 列表 ---------- */}
      <section>
        <div className="text-2xs font-medium text-text-secondary uppercase tracking-wider mb-2">
          {t('workbench.profiles.listTitle', { count: profiles.length })}
        </div>
        {profiles.length === 0 && <div className="text-xs text-text-faint">{t('profile.list.empty')}</div>}
        <ul className="space-y-1.5">
          {profiles.map((p) => {
            const RowIcon = iconOf(p.icon)
            return (
              <li
                key={p.id}
                className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 ${p.active ? 'border-accent bg-accent-soft' : 'border-border-subtle bg-bg-surface'}`}
              >
                <RowIcon width={15} height={15} className={p.active ? 'text-accent flex-shrink-0' : 'text-text-tertiary flex-shrink-0'} aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-text-primary truncate">{p.name}</span>
                    <span className="text-2xs text-text-faint font-mono truncate">{p.id}</span>
                    <span className="text-2xs text-text-faint border border-border-subtle rounded px-1 leading-4 flex-shrink-0">
                      {p.source === 'builtin' ? t('profile.source.builtin') : t('workbench.profiles.sourceUser')}
                    </span>
                    {p.active && <Icon.Check width={12} height={12} className="text-accent flex-shrink-0" aria-hidden />}
                  </div>
                  <div className="text-2xs text-text-tertiary mt-0.5">
                    {t('profile.meta.line', { namespace: p.namespace, agents: p.agents, caps: p.capabilities })}
                  </div>
                </div>

                {!p.active && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void switchProfile(p.id)}
                    className="h-7 px-2.5 rounded-md border border-border-subtle text-2xs text-text-secondary hover:bg-bg-hover disabled:opacity-50 focus-ring flex-shrink-0"
                  >
                    {t('workbench.profiles.activate')}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setEditing({ id: p.id, source: p.source })}
                  aria-label={t('workbench.profiles.editAria', { name: p.name })}
                  className="w-7 h-7 flex items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary focus-ring flex-shrink-0"
                >
                  <Icon.Edit width={12} height={12} />
                </button>
                <Tooltip
                  label={
                    !p.deletable
                      ? p.source === 'builtin'
                        ? t('workbench.profiles.deleteBuiltinHint')
                        : t('workbench.profiles.deleteActiveHint')
                      : t('workbench.profiles.delete')
                  }
                >
                  <button
                    type="button"
                    disabled={!p.deletable}
                    onClick={() => void doDelete(p.id)}
                    aria-label={t('workbench.profiles.deleteAria', { name: p.name })}
                    className="w-7 h-7 flex items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover hover:text-danger disabled:opacity-30 disabled:hover:bg-transparent focus-ring flex-shrink-0"
                  >
                    <Icon.Trash width={12} height={12} />
                  </button>
                </Tooltip>
              </li>
            )
          })}
        </ul>
      </section>

      {editing && (
        <ProfileEditor
          profileId={editing.id}
          source={editing.source}
          plugins={plugins}
          onClose={() => setEditing(null)}
          onSaved={reload}
        />
      )}
      {importing && <ImportDialog onClose={() => setImporting(false)} onImported={reload} />}
    </div>
  )
}
