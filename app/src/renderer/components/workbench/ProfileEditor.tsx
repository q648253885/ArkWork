/* ============================================================
 * ArkWork — 工作台编辑抽屉（v0.33.0 · 配置中心）
 * 设计文档：docs/versions/v0.33.0/02-prd.md §3.2
 *           docs/versions/v0.33.0/03-interaction.md §「编辑抽屉」
 *
 * 契约：
 *  ① **读写同一条管道** —— 打开时用 `profile:export` 取回 manifest 字面量，
 *     保存时用 `profile:update`（主进程复用与导入完全相同的校验管道），
 *     因此「编辑器里能存」与「激活能过」永远同一个标准；
 *  ② **内置台只读** —— 编辑内置台必须先克隆（`profile:update` 侧也会拒），
 *     这里在 UI 上就把它变成一等路径：按钮叫「克隆并编辑」；
 *  ③ **校验前置可见** —— 保存失败时把 `issues` 逐条回填在抽屉底部，
 *     不做「静默不保存」。
 * ============================================================ */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon, type IconName } from '../../icons'
import { Tooltip } from '../ui'
import { ark } from '../../ipc/client'
import type { PluginSummary } from '@shared/types/plugin'
import type { ValidationIssue } from '@shared/types/profile'
import { PROFILE_HOME_MODULES, PROFILE_DOCK_TABS } from '@shared/types/profile'
import { ValidationIssuesView } from './ActivationReportView'

/** 可作为 profile icon 的宿主图标白名单（与 module 页保持同一批，禁 emoji） */
const ICON_CHOICES: IconName[] = [
  'Workspace', 'Bot', 'Bolt', 'Book', 'Brain', 'Graph', 'List', 'Star',
  'Sparkle', 'FolderOpen', 'File', 'Eye', 'Command', 'Box', 'Plug', 'Sparkle',
]

interface Draft {
  name: string
  icon: string
  version: string
  description: string
  /** 顺序即 `ui.dockTabs` */
  dockTabs: string[]
  /** 插件面板：ref → position（缺省 = 追加末尾） */
  dockPanels: Array<{ panelRef: string; position?: number }>
  homeModule: string
  composerChips: string
  memoryNamespace: string
  shareCoreProfile: boolean
  /** 主题 token 覆盖（键值对行） */
  themeRows: Array<{ group: 'light' | 'dark'; key: string; value: string }>
}

function emptyDraft(): Draft {
  return {
    name: '',
    icon: '',
    version: '1.0.0',
    description: '',
    dockTabs: [],
    dockPanels: [],
    homeModule: '',
    composerChips: '',
    memoryNamespace: '',
    shareCoreProfile: true,
    themeRows: [],
  }
}

/** manifest 字面量 → 表单草稿（字段缺失一律回落空值，绝不抛错） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function draftOf(raw: any): Draft {
  const ui = (raw?.ui ?? {}) as Record<string, unknown>
  const theme = (ui.theme ?? {}) as { light?: Record<string, string>; dark?: Record<string, string> }
  const rows: Draft['themeRows'] = []
  for (const g of ['light', 'dark'] as const) {
    for (const [k, v] of Object.entries(theme[g] ?? {})) rows.push({ group: g, key: k, value: String(v) })
  }
  const dockPanels = Array.isArray(ui.dockPanels)
    ? (ui.dockPanels as Array<Record<string, unknown>>).map((d) => ({
        panelRef: String(d?.panelRef ?? ''),
        position: typeof d?.position === 'number' ? d.position : undefined,
      })).filter((d) => d.panelRef.length > 0)
    : []
  return {
    name: String(raw?.name ?? ''),
    icon: String(raw?.icon ?? ''),
    version: String(raw?.version ?? '1.0.0'),
    description: String(raw?.description ?? ''),
    dockTabs: Array.isArray(ui.dockTabs) ? (ui.dockTabs as unknown[]).map(String) : [],
    dockPanels,
    homeModule: String(ui.homeModule ?? ''),
    composerChips: Array.isArray(ui.composerChips) ? (ui.composerChips as unknown[]).map(String).join(', ') : '',
    memoryNamespace: String((raw?.data as Record<string, unknown>)?.memoryNamespace ?? ''),
    shareCoreProfile: (raw?.data as Record<string, unknown>)?.shareCoreProfile !== false,
    themeRows: rows,
  }
}

/** 草稿 → `profile:update` 的 patch（只回传编辑器管辖的字段） */
export function patchOf(draft: Draft): Record<string, unknown> {
  const light: Record<string, string> = {}
  const dark: Record<string, string> = {}
  for (const r of draft.themeRows) {
    if (r.key.trim().length === 0) continue
    if (r.group === 'light') light[r.key.trim()] = r.value.trim()
    else dark[r.key.trim()] = r.value.trim()
  }
  const chips = draft.composerChips.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 5)
  return {
    name: draft.name.trim(),
    icon: draft.icon.trim() || undefined,
    version: draft.version.trim(),
    description: draft.description.trim() || undefined,
    ui: {
      dockTabs: draft.dockTabs,
      dockPanels: draft.dockPanels.map((d) => (d.position === undefined ? { panelRef: d.panelRef } : d)),
      homeModule: draft.homeModule || undefined,
      composerChips: chips,
      theme: Object.keys(light).length + Object.keys(dark).length > 0 ? { light, dark } : undefined,
    },
    data: {
      memoryNamespace: draft.memoryNamespace.trim(),
      shareCoreProfile: draft.shareCoreProfile,
    },
  }
}

export function ProfileEditor({
  profileId,
  source,
  plugins,
  onClose,
  onSaved,
}: {
  profileId: string
  source: 'builtin' | 'user'
  plugins: PluginSummary[]
  onClose: () => void
  onSaved: () => Promise<void> | void
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [issues, setIssues] = useState<ValidationIssue[]>([])
  const [saving, setSaving] = useState(false)
  /** 免编辑模式（内置台未克隆时）：全表单只读 */
  const [readonly, setReadonly] = useState(source === 'builtin')

  useEffect(() => {
    let alive = true
    setLoading(true)
    void (async () => {
      try {
        const res = await ark.profile.export({ id: profileId })
        if (!alive) return
        if (!res.ok) {
          setLoadError(t('workbench.editor.loadFailed'))
          return
        }
        setDraft(draftOf(JSON.parse(res.json)))
        setLoadError(null)
      } catch (err) {
        if (alive) setLoadError(err instanceof Error ? err.message : String(err))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [profileId, t])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const save = async (activate: boolean) => {
    setSaving(true)
    setIssues([])
    try {
      let id = profileId
      if (readonly) {
        // 内置台 → 克隆成用户台（id 由用户在原 id 上加后缀，冲突即报错）
        const newId = `${profileId}.edited`
        const cloned = await ark.profile.clone({ fromId: profileId, newId, newName: draft.name || `${profileId} 副本` })
        if (!cloned.ok) {
          setIssues(cloned.issues)
          if (!cloned.issues.length) {
            setIssues([])
            setLoadError(t(`workbench.editor.cloneFail.${cloned.reason ?? 'invalid'}`))
          }
          return
        }
        id = newId
      }
      const res = await ark.profile.update({ id, patch: patchOf(draft) })
      if (!res.ok) {
        if (res.reason === 'builtin') {
          setReadonly(true)
          setLoadError(t('workbench.editor.builtinReadonly'))
          return
        }
        if (res.reason === 'not-found') {
          setLoadError(t('workbench.editor.notFound'))
          return
        }
        setIssues(res.issues)
        return
      }
      setIssues(res.issues)
      await onSaved()
      if (activate) {
        await ark.profile.activate({ id })
        await onSaved()
      }
      onClose()
    } finally {
      setSaving(false)
    }
  }

  const pluginPanels = plugins.filter((p) => p.panelRefs.length > 0)
  const pluginModules = plugins.flatMap((p) => p.homeModules)

  const field = 'w-full h-8 px-2.5 rounded-md bg-bg-input border border-border-subtle text-xs text-text-primary focus-ring outline-none'
  const label = 'block text-2xs text-text-tertiary mb-1'

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={t('workbench.editor.title')}>
      <div className="flex-1 bg-bg-overlay" onClick={onClose} />
      <div className="w-[480px] h-full bg-bg-base border-l border-border-default shadow-lg flex flex-col">
        <header className="flex items-center gap-2 h-12 px-4 border-b border-border-subtle flex-shrink-0">
          <Icon.Edit width={15} height={15} className="text-accent flex-shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium text-text-primary truncate">{t('workbench.editor.title')}</div>
            <div className="text-2xs text-text-faint font-mono truncate">{profileId}</div>
          </div>
          <Tooltip label={t('workbench.editor.close')}>
            <button onClick={onClose} aria-label={t('workbench.editor.close')} className="w-8 h-8 flex items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary focus-ring">
              <Icon.X width={15} height={15} />
            </button>
          </Tooltip>
        </header>

        {readonly && (
          <div className="flex items-start gap-1.5 px-4 py-2 bg-info-soft border-b border-border-subtle text-2xs text-text-secondary flex-shrink-0">
            <Icon.Info width={12} height={12} className="mt-px flex-shrink-0" aria-hidden />
            <span>{t('workbench.editor.builtinReadonly')}</span>
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
          {loading && <div className="text-xs text-text-faint">{t('workbench.editor.loading')}</div>}
          {loadError && (
            <div className="rounded-md border border-danger bg-danger-soft px-2.5 py-1.5 text-xs text-danger">{loadError}</div>
          )}

          {!loading && (
            <>
              {/* 基础 */}
              <section className="space-y-2">
                <div className="text-2xs font-medium text-text-secondary uppercase tracking-wider">{t('workbench.editor.group.base')}</div>
                <div>
                  <label className={label} htmlFor="wb-name">{t('workbench.editor.name')}</label>
                  <input id="wb-name" className={field} value={draft.name} disabled={readonly} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className={label} htmlFor="wb-version">{t('workbench.editor.version')}</label>
                    <input id="wb-version" className={field} value={draft.version} disabled={readonly} onChange={(e) => setDraft({ ...draft, version: e.target.value })} />
                  </div>
                  <div>
                    <label className={label} htmlFor="wb-icon">{t('workbench.editor.icon')}</label>
                    <select id="wb-icon" className={field} value={draft.icon} disabled={readonly} onChange={(e) => setDraft({ ...draft, icon: e.target.value })}>
                      <option value="">{t('workbench.editor.iconNone')}</option>
                      {ICON_CHOICES.map((n) => (
                        <option key={n} value={n}>{n}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div>
                  <label className={label} htmlFor="wb-desc">{t('workbench.editor.description')}</label>
                  <textarea id="wb-desc" rows={2} className={`${field} h-auto py-1.5 resize-y`} value={draft.description} disabled={readonly} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
                </div>
              </section>

              {/* Dock 内置面板 */}
              <section className="space-y-1.5">
                <div className="text-2xs font-medium text-text-secondary uppercase tracking-wider">{t('workbench.editor.group.dockBuiltin')}</div>
                <p className="text-2xs text-text-faint">{t('workbench.editor.dockBuiltinHint')}</p>
                <ul className="space-y-1">
                  {draft.dockTabs.map((tab, i) => (
                    <li key={tab} className="flex items-center gap-2 rounded-md border border-border-subtle bg-bg-surface px-2 py-1">
                      <span className="text-xs text-text-primary flex-1 font-mono">{tab}</span>
                      <button type="button" disabled={readonly || i === 0} aria-label={t('workbench.editor.moveUp')} onClick={() => {
                        const next = [...draft.dockTabs]
                        ;[next[i - 1], next[i]] = [next[i], next[i - 1]]
                        setDraft({ ...draft, dockTabs: next })
                      }} className="w-6 h-6 flex items-center justify-center rounded text-text-tertiary hover:bg-bg-hover disabled:opacity-30 focus-ring">
                        <Icon.ArrowUp width={12} height={12} />
                      </button>
                      <button type="button" disabled={readonly} aria-label={t('workbench.editor.remove')} onClick={() => setDraft({ ...draft, dockTabs: draft.dockTabs.filter((x) => x !== tab) })} className="w-6 h-6 flex items-center justify-center rounded text-text-tertiary hover:bg-bg-hover disabled:opacity-30 focus-ring">
                        <Icon.X width={12} height={12} />
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="flex flex-wrap gap-1.5">
                  {PROFILE_DOCK_TABS.filter((d) => !draft.dockTabs.includes(d)).map((d) => (
                    <button key={d} type="button" disabled={readonly} onClick={() => setDraft({ ...draft, dockTabs: [...draft.dockTabs, d] })} className="rounded border border-border-subtle px-1.5 py-0.5 text-2xs text-text-secondary hover:bg-bg-hover disabled:opacity-40 focus-ring">
                      + {d}
                    </button>
                  ))}
                </div>
              </section>

              {/* Dock 插件面板 */}
              <section className="space-y-1.5">
                <div className="text-2xs font-medium text-text-secondary uppercase tracking-wider">{t('workbench.editor.group.dockPanels')}</div>
                {pluginPanels.length === 0 ? (
                  <p className="text-2xs text-text-faint">{t('workbench.editor.noPluginPanels')}</p>
                ) : (
                  <ul className="space-y-1">
                    {pluginPanels.flatMap((p) => p.panelRefs).map((ref) => {
                      const picked = draft.dockPanels.find((d) => d.panelRef === ref)
                      return (
                        <li key={ref} className="flex items-center gap-2 rounded-md border border-border-subtle bg-bg-surface px-2 py-1">
                          <input
                            type="checkbox"
                            id={`panel-${ref}`}
                            checked={Boolean(picked)}
                            disabled={readonly}
                            onChange={(e) =>
                              setDraft({
                                ...draft,
                                dockPanels: e.target.checked
                                  ? [...draft.dockPanels, { panelRef: ref }]
                                  : draft.dockPanels.filter((d) => d.panelRef !== ref),
                              })
                            }
                          />
                          <label htmlFor={`panel-${ref}`} className="text-xs text-text-primary flex-1 font-mono truncate cursor-pointer">{ref}</label>
                          {picked && (
                            <input
                              type="number"
                              min={0}
                              aria-label={t('workbench.editor.position')}
                              placeholder={t('workbench.editor.position')}
                              className="w-16 h-6 px-1.5 rounded bg-bg-input border border-border-subtle text-2xs text-text-primary outline-none focus-ring"
                              value={picked.position ?? ''}
                              disabled={readonly}
                              onChange={(e) => {
                                const v = e.target.value === '' ? undefined : Number(e.target.value)
                                setDraft({
                                  ...draft,
                                  dockPanels: draft.dockPanels.map((d) => (d.panelRef === ref ? { panelRef: ref, position: v } : d)),
                                })
                              }}
                            />
                          )}
                        </li>
                      )
                    })}
                  </ul>
                )}
              </section>

              {/* 首页模块 + composer chips */}
              <section className="space-y-2">
                <div className="text-2xs font-medium text-text-secondary uppercase tracking-wider">{t('workbench.editor.group.ui')}</div>
                <div>
                  <label className={label} htmlFor="wb-home">{t('workbench.editor.homeModule')}</label>
                  <select id="wb-home" className={field} value={draft.homeModule} disabled={readonly} onChange={(e) => setDraft({ ...draft, homeModule: e.target.value })}>
                    <option value="">{t('workbench.editor.homeModuleNone')}</option>
                    <optgroup label={t('workbench.editor.homeModuleBuiltin')}>
                      {PROFILE_HOME_MODULES.map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </optgroup>
                    {pluginModules.length > 0 && (
                      <optgroup label={t('workbench.editor.homeModulePlugin')}>
                        {pluginModules.map((m) => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                </div>
                <div>
                  <label className={label} htmlFor="wb-chips">{t('workbench.editor.composerChips')}</label>
                  <input id="wb-chips" className={field} placeholder={t('workbench.editor.composerChipsHint')} value={draft.composerChips} disabled={readonly} onChange={(e) => setDraft({ ...draft, composerChips: e.target.value })} />
                </div>
              </section>

              {/* 记忆域 */}
              <section className="space-y-2">
                <div className="text-2xs font-medium text-text-secondary uppercase tracking-wider">{t('workbench.editor.group.data')}</div>
                <div>
                  <label className={label} htmlFor="wb-ns">{t('workbench.editor.memoryNamespace')}</label>
                  <input id="wb-ns" className={`${field} font-mono`} placeholder="my-namespace" value={draft.memoryNamespace} disabled={readonly} onChange={(e) => setDraft({ ...draft, memoryNamespace: e.target.value })} />
                </div>
                <label className="flex items-center gap-2 text-xs text-text-secondary">
                  <input type="checkbox" checked={draft.shareCoreProfile} disabled={readonly} onChange={(e) => setDraft({ ...draft, shareCoreProfile: e.target.checked })} />
                  {t('workbench.editor.shareCoreProfile')}
                </label>
              </section>

              {/* 主题覆盖 */}
              <section className="space-y-1.5">
                <div className="text-2xs font-medium text-text-secondary uppercase tracking-wider">{t('workbench.editor.group.theme')}</div>
                <p className="text-2xs text-text-faint">{t('workbench.editor.themeHint')}</p>
                {draft.themeRows.map((r, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <select
                      className="w-16 h-7 px-1 rounded bg-bg-input border border-border-subtle text-2xs text-text-primary outline-none"
                      value={r.group}
                      disabled={readonly}
                      onChange={(e) => {
                        const rows = [...draft.themeRows]
                        rows[i] = { ...r, group: e.target.value as 'light' | 'dark' }
                        setDraft({ ...draft, themeRows: rows })
                      }}
                    >
                      <option value="light">light</option>
                      <option value="dark">dark</option>
                    </select>
                    <input className="flex-1 h-7 px-2 rounded bg-bg-input border border-border-subtle text-2xs font-mono text-text-primary outline-none" placeholder="--radius-sm" value={r.key} disabled={readonly} onChange={(e) => {
                      const rows = [...draft.themeRows]
                      rows[i] = { ...r, key: e.target.value }
                      setDraft({ ...draft, themeRows: rows })
                    }} />
                    <input className="w-24 h-7 px-2 rounded bg-bg-input border border-border-subtle text-2xs text-text-primary outline-none" placeholder="#4F46E5" value={r.value} disabled={readonly} onChange={(e) => {
                      const rows = [...draft.themeRows]
                      rows[i] = { ...r, value: e.target.value }
                      setDraft({ ...draft, themeRows: rows })
                    }} />
                    <button type="button" disabled={readonly} aria-label={t('workbench.editor.remove')} onClick={() => setDraft({ ...draft, themeRows: draft.themeRows.filter((_, j) => j !== i) })} className="w-6 h-6 flex items-center justify-center rounded text-text-tertiary hover:bg-bg-hover disabled:opacity-30 focus-ring">
                      <Icon.X width={12} height={12} />
                    </button>
                  </div>
                ))}
                <button type="button" disabled={readonly} onClick={() => setDraft({ ...draft, themeRows: [...draft.themeRows, { group: 'light', key: '', value: '' }] })} className="text-2xs text-accent hover:underline disabled:opacity-40">
                  + {t('workbench.editor.addToken')}
                </button>
              </section>

              {issues.length > 0 && (
                <section>
                  <div className="text-2xs font-medium text-danger mb-1.5">{t('workbench.editor.saveIssues')}</div>
                  <ValidationIssuesView issues={issues} />
                </section>
              )}
            </>
          )}
        </div>

        <footer className="flex items-center gap-2 h-14 px-4 border-t border-border-subtle flex-shrink-0">
          <button type="button" onClick={onClose} className="h-8 px-3 rounded-md border border-border-subtle text-xs text-text-secondary hover:bg-bg-hover focus-ring">
            {t('workbench.editor.cancel')}
          </button>
          <div className="flex-1" />
          <button type="button" disabled={saving || loading} onClick={() => void save(false)} className="h-8 px-3 rounded-md border border-border-subtle text-xs text-text-secondary hover:bg-bg-hover disabled:opacity-50 focus-ring">
            {saving ? t('workbench.editor.saving') : t('workbench.editor.saveOnly')}
          </button>
          <button type="button" disabled={saving || loading} onClick={() => void save(true)} className="h-8 px-3 rounded-md bg-business-primary text-text-inverse text-xs hover:bg-business-primary-hover disabled:opacity-50 focus-ring">
            {readonly ? t('workbench.editor.cloneAndSave') : t('workbench.editor.saveAndActivate')}
          </button>
        </footer>
      </div>
    </div>
  )
}
