/* ============================================================
 * ArkWork — ProfileSwitcher（插件模式 · v0.32.0）
 * 设计文档：docs/versions/v0.32.0/03-interaction.md §4
 *           正本 `workbench-profile-v1.0/04-宿主插槽与UI扩展体系.md` §5
 *
 * 交互契约（三条）：
 *  ① **一眼看得出当前是哪个台**：chip 常驻显示图标 + 台名，不折叠成纯图标；
 *  ② **降级必须可见**：右上角橙点 + 下拉底部逐条列出未生效能力
 *     （「永不静默半死」G5 —— 折叠起来就等于没有）；
 *  ③ **切换结果可追溯**：失败给出首个 error 原因 toast，报告留在 store 里，
 *     下拉顶部的「为什么没切过去」可以再追问一次。
 *
 * ⚠️ 无 emoji 图标（项目硬规范）：manifest 声明的是宿主 `Icon` 键名，
 * 这里做的是**白名单查表**，未知键回落 `Layers`，绝不动态渲染字符串。
 * ============================================================ */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon, type IconName } from '../icons'
import { useStore } from '../store'
import { Tooltip } from './ui'

/** 图标查表：manifest 里是字符串，宿主只认自己的键 */
function profileIcon(name?: string) {
  const key = (name ?? '') as IconName
  const table = Icon as unknown as Record<string, (p: { width?: number; height?: number; className?: string; 'aria-hidden'?: boolean }) => JSX.Element>
  return table[key] ?? Icon.Box
}

/** 快照五层（顺序即 presentation 顺序；缺一层就是装配链路断了） */
const SNAPSHOT_LAYERS = ['agents', 'tools', 'ui', 'data', 'auto'] as const

/** 降级层名 → i18n key 后缀（`profile.degraded.layer.*`） */
function layerKey(layer: string): string {
  switch (layer) {
    case 'agents':
      return 'agents'
    case 'tools':
      return 'tools'
    case 'ui':
      return 'ui'
    case 'data':
      return 'data'
    case 'auto':
      return 'auto'
    default:
      return 'unknown'
  }
}

export function ProfileSwitcher() {
  const { t } = useTranslation()
  const profiles = useStore((s) => s.profiles)
  const activeId = useStore((s) => s.activeProfileId)
  const degraded = useStore((s) => s.profileDegraded)
  const lastReport = useStore((s) => s.profileLastReport)
  const snapshot = useStore((s) => s.profileSnapshot)
  const busy = useStore((s) => s.profileBusy)
  const switchProfile = useStore((s) => s.switchProfile)
  const loadProfiles = useStore((s) => s.loadProfiles)
  const openModulePage = useStore((s) => s.openModulePage)
  const profileHomeModule = useStore((s) => s.profileHomeModule)

  const [open, setOpen] = useState(false)
  const [showDegraded, setShowDegraded] = useState(false)
  const [showSnapshot, setShowSnapshot] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // 首次挂载补齐列表（App.init 也会拉一次，这里幂等兜底）
  useEffect(() => {
    if (useStore.getState().profileLoaded) return
    void loadProfiles()
  }, [loadProfiles])

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onClick)
    return () => window.removeEventListener('mousedown', onClick)
  }, [open])

  const active = profiles.find((p) => p.id === activeId)
  const ActiveIcon = profileIcon(active?.icon)
  const degradedCount = degraded.length
  const blocking = degraded.filter((d) => d.blocking).length
  const wasRejected = lastReport && !lastReport.ok

  const handleSwitch = async (id: string) => {
    setOpen(false)
    await switchProfile(id)
  }

  const handleRetryShowReason = () => {
    const first = lastReport?.validation.issues.find((i) => i.level === 'error')
    if (first) window.alert(`${first.path}\n${first.message}${first.fix ? `\n\n${first.fix}` : ''}`)
  }

  return (
    <div className="profile-switcher relative" ref={ref}>
      <Tooltip
        label={t('profile.switcher.label')}
        desc={active?.description || t('profile.switcher.desc')}
        cap={active ? t('profile.switcher.cap', { name: active.name }) : undefined}
      >
        <button
          onClick={() => setOpen((v) => !v)}
          aria-label={t('profile.switcher.aria')}
          aria-expanded={open}
          aria-haspopup="menu"
          data-busy={busy ? 'true' : 'false'}
          data-degraded={blocking > 0 ? 'blocking' : degradedCount > 0 ? 'warn' : 'none'}
          className="profile-switcher__button flex items-center gap-1.5 h-9 pl-2.5 pr-2.5 rounded-lg bg-bg-surface border border-border-subtle hover:bg-bg-hover hover:border-border-default transition-colors focus-ring max-w-[200px]"
        >
          <ActiveIcon width={16} height={16} className="text-accent flex-shrink-0" aria-hidden />
          <span className="profile-switcher__name text-xs text-text-primary truncate">{active?.name ?? t('profile.switcher.unknown')}</span>
          {/* 降级徽标：阻断（红）> 非阻断（橙）；有才有 DOM，不渲染占位 */}
          {blocking > 0 ? (
            <span
              className="profile-switcher__badge flex-shrink-0 w-1.5 h-1.5 rounded-full bg-danger"
              data-level="blocking"
              aria-label={t('profile.degraded.blockingCount', { count: blocking })}
            />
          ) : degradedCount > 0 ? (
            <span
              className="profile-switcher__badge flex-shrink-0 w-1.5 h-1.5 rounded-full bg-warning"
              data-level="warn"
              aria-label={t('profile.degraded.count', { count: degradedCount })}
            />
          ) : null}
          <Icon.ChevronDown width={12} height={12} className="text-text-faint flex-shrink-0" aria-hidden />
        </button>
      </Tooltip>

      {open && (
        <div
          className="profile-switcher__menu absolute right-0 top-[42px] w-[320px] rounded-xl border border-border-default bg-bg-surface shadow-lg overflow-hidden z-50"
          role="menu"
        >
          {/* 上次切换失败 → 顶部追问入口（失败不留白：用户必须能知道为什么） */}
          {wasRejected && (
            <button
              type="button"
              onClick={handleRetryShowReason}
              className="profile-switcher__reason w-full text-left px-3 py-2 text-xs text-danger bg-danger-soft hover:bg-bg-hover border-b border-border-subtle"
            >
              {t('profile.reject.hint', { id: lastReport.profileId })}
            </button>
          )}

          <div className="profile-switcher__list max-h-[320px] overflow-y-auto py-1">
            {profiles.length === 0 && (
              <div className="px-3 py-4 text-xs text-text-faint text-center">{t('profile.list.empty')}</div>
            )}
            {profiles.map((p) => {
              const RowIcon = profileIcon(p.icon)
              return (
                <button
                  key={p.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={p.active}
                  disabled={busy}
                  onClick={() => void handleSwitch(p.id)}
                  className={`profile-switcher__item w-full text-left px-3 py-2 flex items-start gap-2.5 hover:bg-bg-hover disabled:opacity-50 transition-colors ${p.active ? 'bg-accent-soft' : ''}`}
                >
                  <RowIcon width={16} height={16} className={`mt-0.5 flex-shrink-0 ${p.active ? 'text-accent' : 'text-text-tertiary'}`} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="text-xs text-text-primary truncate">{p.name}</span>
                      {p.source === 'builtin' && (
                        <span className="text-2xs text-text-faint border border-border-subtle rounded px-1 leading-4">{t('profile.source.builtin')}</span>
                      )}
                      {p.active && <Icon.Check width={12} height={12} className="text-accent flex-shrink-0" aria-hidden />}
                    </span>
                    {p.description && (
                      <span className="block text-2xs text-text-tertiary mt-0.5 line-clamp-2">{p.description}</span>
                    )}
                    <span className="block text-2xs text-text-faint mt-0.5">
                      {t('profile.meta.line', { namespace: p.namespace, agents: p.agents, caps: p.capabilities })}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>

          {/* 降级明细：默认折叠成一行，展开后逐条（层 / 引用 / 原因） */}
          {degradedCount > 0 && (
            <div className="border-t border-border-subtle">
              <button
                type="button"
                onClick={() => setShowDegraded((v) => !v)}
                aria-expanded={showDegraded}
                className="profile-switcher__degraded-toggle w-full flex items-center gap-1.5 px-3 py-2 text-2xs text-warning hover:bg-bg-hover"
              >
                <Icon.Warning width={12} height={12} aria-hidden />
                <span>{t('profile.degraded.count', { count: degradedCount })}</span>
                <Icon.ChevronDown
                  width={11}
                  height={11}
                  className={`ml-auto transition-transform ${showDegraded ? 'rotate-180' : ''}`}
                  aria-hidden
                />
              </button>
              {showDegraded && (
                <ul className="profile-switcher__degraded-list px-3 pb-2 space-y-1">
                  {degraded.map((d, i) => (
                    <li key={`${d.layer}:${d.ref}:${i}`} className="text-2xs text-text-tertiary">
                      <span className={d.blocking ? 'text-danger' : 'text-text-secondary'}>
                        [{t(`profile.degraded.layer.${layerKey(d.layer)}`)}] {d.ref}
                      </span>
                      <span className="text-text-faint"> — {d.reason}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* 该台声明的首页模块入口（无任务时的稳定落点） */}
          {profileHomeModule && (
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                openModulePage(profileHomeModule)
              }}
              className="profile-switcher__home w-full text-left px-3 py-2 text-2xs text-text-secondary hover:bg-bg-hover border-t border-border-subtle"
            >
              {t('profile.homeModule.open')}
            </button>
          )}

          {/* 装配快照：逐层列出「实际装了什么」，让「说不清 current configuration」无处藏身 */}
          <button
            type="button"
            onClick={() => setShowSnapshot((v) => !v)}
            aria-expanded={showSnapshot}
            className="profile-switcher__snapshot-toggle w-full flex items-center gap-1.5 px-3 py-2 text-2xs text-text-secondary hover:bg-bg-hover border-t border-border-subtle"
          >
            <Icon.Info width={12} height={12} aria-hidden />
            <span>{t('profile.report.snapshot')}</span>
            <Icon.ChevronDown
              width={11}
              height={11}
              className={`ml-auto transition-transform ${showSnapshot ? 'rotate-180' : ''}`}
              aria-hidden
            />
          </button>
          {showSnapshot && (
            <div className="profile-switcher__snapshot px-3 pb-2 space-y-1.5 border-t border-border-subtle">
              {!snapshot && <div className="text-2xs text-text-faint">{t('profile.report.none')}</div>}
              {snapshot && (
                <>
                  <div className="text-2xs text-text-secondary">{t('profile.report.layers')}</div>
                  {SNAPSHOT_LAYERS.map((layer) => (
                    <div key={layer} className="flex items-center justify-between text-2xs">
                      <span className="text-text-tertiary">{t(`profile.report.layer.${layer}`)}</span>
                      <span className="text-text-primary font-mono">{snapshot.layers[layer].length}</span>
                    </div>
                  ))}
                  <div className="text-2xs text-text-faint">
                    {t('profile.report.resolvedAt', { time: new Date(snapshot.resolvedAt).toLocaleTimeString() })}
                  </div>
                  {snapshot.degraded.length > 0 && (
                    <div className="text-2xs text-warning">{t('profile.report.degraded')}</div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
