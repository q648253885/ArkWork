/* ============================================================
 * ArkWork — 诊断子页（v0.33.0 · 配置中心）
 * 设计文档：docs/versions/v0.33.0/02-prd.md §3.1 子页 3
 *
 * 四个区块（对齐 PRD 表）：
 *  ① **插槽实况表** —— 九类插槽逐行：kind + 注册量 + 来源分布；可展开看条目明细
 *  ② **面板来源归属表** —— panelRef + 标题 + 组件 + 数据源 + 来源
 *  ③ **装配快照** —— 五层条目数 + 降级列表（复用 ActivationReportView 的快照区）
 *  ④ **渲染器覆盖表** —— 扩展名 → RendererKind + 来源（内置 / 覆盖）
 *
 * 为什么这张页必须有：正本 02 §5「说不清 current configuration」是插件体系最常见的
 * 失败模式 —— 用户看得到「插件已启用」却看不到「它到底注册了什么」。这里把
 * 注册结果原样摊开（而不是再讲一遍配置），配置与事实的差异会自己浮出来。
 * ============================================================ */
import { Fragment, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../../icons'
import { useStore } from '../../store'
import { ark } from '../../ipc/client'
import type { SlotEntry, SlotKind } from '@shared/types/profile'
import { BUILTIN_EXT_RENDERER } from '@shared/utils/renderer-ext'
import { SnapshotView } from './ActivationReportView'

/** 九类插槽的展示顺序（与 shared/types/profile.ts 的 `SLOT_KINDS` 同源） */
const SLOT_ORDER: SlotKind[] = [
  'agent',
  'tool',
  'ui.panel',
  'ui.renderer',
  'ui.action',
  'ui.homeModule',
  'ui.theme',
  'data',
  'auto',
]

/** 来源色标（builtin 中性 / profile 主色 / plugin 提示色） */
function sourceClass(s: string): string {
  if (s === 'profile') return 'text-accent border-accent/40'
  if (s === 'plugin') return 'text-warning border-warning'
  return 'text-text-tertiary border-border-default'
}

export function DiagnosticsView() {
  const { t } = useTranslation()
  const snapshot = useStore((s) => s.profileSnapshot)
  const degraded = useStore((s) => s.profileDegraded)
  const profilePanels = useStore((s) => s.profilePanels)
  const rendererOverrides = useStore((s) => s.rendererOverrides)
  const themeOverrides = useStore((s) => s.themeOverrides)
  const plugins = useStore((s) => s.plugins)

  const [slots, setSlots] = useState<Partial<Record<SlotKind, SlotEntry[]>>>({})
  const [expanded, setExpanded] = useState<SlotKind | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const res = await ark.profile.slots()
        if (alive) setSlots(res ?? {})
      } catch {
        if (alive) setSlots({})
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [snapshot, plugins])

  /** 每类插槽的来源分布（`{builtin: 3, profile: 4, plugin: 1}`） */
  const rows = useMemo(() => {
    return SLOT_ORDER.map((kind) => {
      const entries = slots[kind] ?? []
      const bySource: Record<string, number> = {}
      for (const e of entries) {
        const s = e.source ?? 'builtin'
        bySource[s] = (bySource[s] ?? 0) + 1
      }
      return { kind, entries, bySource }
    })
  }, [slots])

  /** 渲染器覆盖表：内置全集 ∪ 覆盖表 */
  const rendererRows = useMemo(() => {
    const exts = Array.from(new Set([...Object.keys(BUILTIN_EXT_RENDERER), ...Object.keys(rendererOverrides)])).sort()
    return exts.map((ext) => {
      const builtin = BUILTIN_EXT_RENDERER[ext]
      const override = rendererOverrides[ext]
      return { ext, builtin, override, overridden: Boolean(override && override !== builtin) }
    })
  }, [rendererOverrides])

  const themeKeys = useMemo(
    () => ({
      light: Object.keys(themeOverrides.light).length,
      dark: Object.keys(themeOverrides.dark).length,
    }),
    [themeOverrides],
  )

  const th = 'text-left text-2xs font-medium text-text-tertiary uppercase tracking-wider px-2 py-1'
  const td = 'px-2 py-1 text-2xs text-text-secondary align-top'

  return (
    <div className="space-y-6">
      {/* ---------- ① 插槽实况 ---------- */}
      <section>
        <div className="text-2xs font-medium text-text-secondary uppercase tracking-wider mb-2 flex items-center gap-1.5">
          <Icon.List width={12} height={12} aria-hidden />
          {t('workbench.diag.slotsTitle')}
        </div>
        {loading ? (
          <div className="text-xs text-text-faint">{t('workbench.diag.loading')}</div>
        ) : (
          <div className="rounded-lg border border-border-subtle overflow-hidden">
            <table className="w-full">
              <thead className="bg-bg-surface">
                <tr>
                  <th className={th}>{t('workbench.diag.colKind')}</th>
                  <th className={th}>{t('workbench.diag.colCount')}</th>
                  <th className={th}>{t('workbench.diag.colSources')}</th>
                  <th className={th}>{''}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <Fragment key={r.kind}>
                    <tr className="border-t border-border-subtle">
                      <td className={`${td} font-mono text-text-primary`}>{r.kind}</td>
                      <td className={`${td} tabular-nums`}>{r.entries.length}</td>
                      <td className={td}>
                        {Object.keys(r.bySource).length === 0 ? (
                          <span className="text-text-faint">—</span>
                        ) : (
                          <span className="flex flex-wrap gap-1">
                            {Object.entries(r.bySource).map(([s, n]) => (
                              <span key={s} className={`rounded border px-1 leading-4 ${sourceClass(s)}`}>
                                {s} ×{n}
                              </span>
                            ))}
                          </span>
                        )}
                      </td>
                      <td className={`${td} text-right`}>
                        {r.entries.length > 0 && (
                          <button
                            type="button"
                            onClick={() => setExpanded(expanded === r.kind ? null : r.kind)}
                            aria-expanded={expanded === r.kind}
                            className="text-2xs text-accent hover:underline focus-ring"
                          >
                            {expanded === r.kind ? t('workbench.diag.collapse') : t('workbench.diag.expand')}
                          </button>
                        )}
                      </td>
                    </tr>
                    {expanded === r.kind && (
                      <tr className="border-t border-border-subtle bg-bg-surface">
                        <td className={td} colSpan={4}>
                          <ul className="space-y-0.5">
                            {r.entries.map((e, i) => (
                              <li key={`${e.id}-${i}`} className="flex items-center gap-2">
                                <span className={`rounded border px-1 leading-4 flex-shrink-0 ${sourceClass(e.source ?? 'builtin')}`}>
                                  {e.source ?? 'builtin'}
                                </span>
                                <span className="font-mono text-text-primary truncate" title={e.id}>{e.id}</span>
                                <span className="text-text-tertiary truncate">{e.label}</span>
                                {e.position !== undefined && (
                                  <span className="text-text-faint ml-auto flex-shrink-0">#{e.position}</span>
                                )}
                              </li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ---------- ② 面板来源归属 ---------- */}
      <section>
        <div className="text-2xs font-medium text-text-secondary uppercase tracking-wider mb-2 flex items-center gap-1.5">
          <Icon.Workspace width={12} height={12} aria-hidden />
          {t('workbench.diag.panelsTitle', { count: profilePanels.length })}
        </div>
        {profilePanels.length === 0 ? (
          <div className="text-xs text-text-faint">{t('workbench.diag.noPanels')}</div>
        ) : (
          <div className="rounded-lg border border-border-subtle overflow-hidden">
            <table className="w-full">
              <thead className="bg-bg-surface">
                <tr>
                  <th className={th}>{t('workbench.diag.colPanelRef')}</th>
                  <th className={th}>{t('workbench.diag.colTitle')}</th>
                  <th className={th}>{t('workbench.diag.colComponent')}</th>
                  <th className={th}>{t('workbench.diag.colDataSource')}</th>
                  <th className={th}>{t('workbench.diag.colOrigin')}</th>
                  <th className={th}>{t('workbench.diag.colPosition')}</th>
                </tr>
              </thead>
              <tbody>
                {profilePanels.map((p) => {
                  const plugin = plugins.find((x) => x.panelRefs.includes(p.ref))
                  return (
                    <tr key={p.ref} className="border-t border-border-subtle">
                      <td className={`${td} font-mono text-text-primary`}>{p.ref}</td>
                      <td className={td}>{p.title}</td>
                      <td className={`${td} font-mono`}>{p.component ?? '—'}</td>
                      <td className={td}>{p.data ? `${p.data.kind}${p.data.format ? `/${p.data.format}` : ''}` : '—'}</td>
                      <td className={td}>
                        {p.pluginId ? (
                          <span className={`rounded border px-1 leading-4 ${sourceClass('plugin')}`}>{p.pluginId}</span>
                        ) : (
                          <span className={`rounded border px-1 leading-4 ${sourceClass('profile')}`}>
                            {plugin ? t('workbench.diag.originProfile') : t('workbench.diag.originBuiltin')}
                          </span>
                        )}
                      </td>
                      <td className={`${td} tabular-nums`}>{p.position ?? '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ---------- ④ 渲染器覆盖表 ---------- */}
      <section>
        <div className="text-2xs font-medium text-text-secondary uppercase tracking-wider mb-2 flex items-center gap-1.5">
          <Icon.Eye width={12} height={12} aria-hidden />
          {t('workbench.diag.renderersTitle', { count: Object.keys(rendererOverrides).length })}
        </div>
        <div className="rounded-lg border border-border-subtle overflow-hidden">
          <table className="w-full">
            <thead className="bg-bg-surface">
              <tr>
                <th className={th}>{t('workbench.diag.colExt')}</th>
                <th className={th}>{t('workbench.diag.colBuiltin')}</th>
                <th className={th}>{t('workbench.diag.colEffective')}</th>
                <th className={th}>{t('workbench.diag.colOrigin')}</th>
              </tr>
            </thead>
            <tbody>
              {rendererRows.map((r) => (
                <tr key={r.ext} className="border-t border-border-subtle">
                  <td className={`${td} font-mono text-text-primary`}>.{r.ext}</td>
                  <td className={`${td} font-mono`}>{r.builtin ?? '—'}</td>
                  <td className={`${td} font-mono ${r.overridden ? 'text-warning' : 'text-text-secondary'}`}>
                    {r.override ?? r.builtin ?? '—'}
                  </td>
                  <td className={td}>
                    {r.overridden ? (
                      <span className={`rounded border px-1 leading-4 ${sourceClass('plugin')}`}>{t('workbench.diag.originOverride')}</span>
                    ) : (
                      <span className={`rounded border px-1 leading-4 ${sourceClass('builtin')}`}>{t('workbench.diag.originBuiltin')}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ---------- 主题覆盖实况 ---------- */}
      <section>
        <div className="text-2xs font-medium text-text-secondary uppercase tracking-wider mb-2 flex items-center gap-1.5">
          <Icon.Sun width={12} height={12} aria-hidden />
          {t('workbench.diag.themeTitle')}
        </div>
        {themeKeys.light + themeKeys.dark === 0 ? (
          <div className="text-xs text-text-faint">{t('workbench.diag.noTheme')}</div>
        ) : (
          <div className="rounded-lg border border-border-subtle bg-bg-surface p-3 space-y-1.5">
            <div className="text-2xs text-text-tertiary">
              {t('workbench.diag.themeCount', { light: themeKeys.light, dark: themeKeys.dark })}
            </div>
            <p className="text-2xs text-text-faint">{t('workbench.diag.themeHint')}</p>
          </div>
        )}
      </section>

      {/* ---------- ③ 装配快照 ---------- */}
      <section>
        <div className="text-2xs font-medium text-text-secondary uppercase tracking-wider mb-2 flex items-center gap-1.5">
          <Icon.Graph width={12} height={12} aria-hidden />
          {t('workbench.report.section.snapshot')}
        </div>
        <div className="rounded-lg border border-border-subtle bg-bg-surface p-3">
          <SnapshotView snapshot={snapshot} />
          {degraded.length > 0 && (
            <div className="mt-2 pt-2 border-t border-border-subtle text-2xs text-warning">
              {t('profile.report.degraded')} · {degraded.length}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
