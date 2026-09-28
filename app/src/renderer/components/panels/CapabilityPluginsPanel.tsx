/* ============================================================
 * ArkWork — CapabilityPluginsPanel（v0.34.0 · P3；★ v0.35.0 扩代码插件；★ v0.36.0 安装/命令/教程）
 * 设计文档：docs/versions/v0.34.0/04-system-design.md §4.2
 *           ★ v0.35.0：docs/versions/v0.35.0/04-system-design.md §5.3 · §7
 *           ★ v0.36.0：docs/versions/v0.36.0/04-system-design.md §3.4
 *
 * 能力插件管理（**能力页「插件」Tab 的唯一内容**）。
 * v0.33.0 里它叫 `workbench/PluginsView`，埋在「设置 → 工作台中心 → 插件」；
 * 用户实测反馈「能力里的插件与工作区的插件重叠」→ v0.34.0 迁到能力页并简化。
 *
 * ★ v0.35.0 新增三块（都来自「插件能跑代码了」这一件事）：
 *  ① **作用域切换**（§7）：`本工作区 (n)` / `全局 (n)`。列表按作用域过滤，
 *     开关写哪一级偏好由当前作用域决定 —— 不切作用域就写盘 = 用户以为改的是
 *     本工作区、实际污染了全局（v0.35.0 引入 workspace 级才有的新误伤面）。
 *  ② **运行期诊断**（§7）：来源 / 入口 / 权限 / 激活态 / 装载耗时 / 最近错误。
 *     这是纪律⑦的落点 —— 「静默退化必须留人话诊断」，插件装载失败如果只留一句
 *     「不生效」，作者无从下手。
 *  ③ **脚手架入口**（P1）：生成最小可运行目录（Host 半 + Client 半 + 清单），
 *     而不是只给一段 JSON 让用户自己拼（v0.34.0 的做法在「代码插件」时代不够用）。
 *
 * ★ v0.36.0 新增（F3.2 / F3.3 / F3.6）：
 *  ① **安装插件包**（对齐 VS Code 的 VSIX 安装）：选 zip → 预览（权限/能力）
 *     → 确认落盘（默认禁用）→ 列表里手动启用；同 id 已存在需勾「覆盖已有」。
 *  ② **卸载确认**：弹确认框 + 「删除插件数据」勾选（purgeData 连私有 KV 一起清）。
 *  ③ **命令展示**：插件贡献的命令列在详情里，可在 QuickAction（Mod+K）触发。
 *  ④ **插件指南**：使用指南 / 开发指南 内嵌呈现（F3.6 教程落点）。
 *
 * 简化取舍（延续 v0.34.0）：一行一插件；详情就地展开（不跳页）；顶部只放必要动作。
 * ============================================================ */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon, type IconName } from '../../icons'
import { Tooltip } from '../ui'
import { chordText } from '../../keymap'
import { useStore } from '../../store'
import type { PluginKind, PluginRuntimePhase, PluginRuntimeStatus, PluginSummary } from '@shared/types/plugin'
import type { PluginInstallZipResult } from '@shared/types/ipc'

/** kind → 图标（禁 emoji） */
const KIND_ICON: Record<PluginKind, IconName> = {
  panel: 'Workspace',
  renderer: 'Eye',
  action: 'Command',
  homeModule: 'Workspace',
  theme: 'Sparkle',
  tool: 'Bolt',
}

/** 脚手架支持的类型（与 `PLUGIN_KINDS` 同源；`tool` 是 v0.35.0 新档） */
const SCAFFOLD_KINDS: PluginKind[] = ['panel', 'tool', 'action', 'renderer', 'homeModule', 'theme']

/** phase → i18n 键（诊断页的状态列） */
const PHASE_LABEL: Record<PluginRuntimePhase, string> = {
  registered: 'workbench.plugins.phaseRegistered',
  activating: 'workbench.plugins.phaseActivating',
  active: 'workbench.plugins.phaseActive',
  'activation-failed': 'workbench.plugins.phaseActivationFailed',
  error: 'workbench.plugins.phaseError',
  stopped: 'workbench.plugins.phaseStopped',
}

/** phase → 颜色（「颜色只留给异常」：正常态一律中性色） */
const PHASE_TONE: Record<PluginRuntimePhase, string> = {
  registered: 'text-text-faint',
  activating: 'text-text-tertiary',
  active: 'text-text-secondary',
  'activation-failed': 'text-danger',
  error: 'text-danger',
  stopped: 'text-text-faint',
}

/** 开关（无障碍 role=switch；禁用/校验失败时不可点） */
function PluginSwitch({
  checked,
  disabled,
  ariaLabel,
  onChange,
}: {
  checked: boolean
  disabled?: boolean
  ariaLabel: string
  onChange: (next: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative w-8 h-[18px] rounded-full transition-colors flex-shrink-0 disabled:opacity-40 focus-ring ${
        checked ? 'bg-business-primary' : 'bg-bg-input border border-border-subtle'
      }`}
    >
      <span
        className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-bg-base transition-all ${
          checked ? 'left-[16px]' : 'left-[2px]'
        }`}
      />
    </button>
  )
}

export function CapabilityPluginsPanel() {
  const { t } = useTranslation()
  const plugins = useStore((s) => s.plugins)
  const loaded = useStore((s) => s.pluginsLoaded)
  const busy = useStore((s) => s.pluginsBusy)
  const scope = useStore((s) => s.pluginScope)
  const setScope = useStore((s) => s.setPluginScope)
  const runtime = useStore((s) => s.pluginRuntime)
  const shadowed = useStore((s) => s.pluginShadowed)
  const setEnabled = useStore((s) => s.setPluginEnabled)
  const uninstall = useStore((s) => s.uninstallPlugin)
  const installPlugin = useStore((s) => s.installPlugin)
  const rescan = useStore((s) => s.rescanPlugins)
  const openDir = useStore((s) => s.openPluginsDir)
  const exportSample = useStore((s) => s.exportPluginSample)
  const scaffold = useStore((s) => s.scaffoldPlugin)
  const pushToast = useStore((s) => s.pushToast)

  const [showScaffold, setShowScaffold] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [draftId, setDraftId] = useState('')
  const [draftName, setDraftName] = useState('')
  const [draftKind, setDraftKind] = useState<PluginKind>('panel')
  /* ★ v0.36.0（F3.2/F3.6）：安装确认 / 卸载确认 / 指南视图 */
  const [view, setView] = useState<'list' | 'guide'>('list')
  const [guideTab, setGuideTab] = useState<'usage' | 'dev'>('usage')
  const [pendingInstall, setPendingInstall] = useState<PluginInstallZipResult | null>(null)
  const [overwrite, setOverwrite] = useState(false)
  const [confirmUninstallId, setConfirmUninstallId] = useState<string | null>(null)
  const [purgeData, setPurgeData] = useState(false)

  /* ---------- 作用域过滤 ---------- */
  // 「全局」档把 `bundled` 一并显示：随包示例落在全局插件目录，
  // 把它藏起来会让用户看到「全局 (3)」却只列出 1 个（计数与列表对不上）
  const inScope = (p: PluginSummary): boolean =>
    scope === 'workspace' ? p.source === 'workspace' : p.source !== 'workspace'
  const visible = plugins.filter(inScope)
  const workspaceCount = plugins.filter((p) => p.source === 'workspace').length
  const globalCount = plugins.length - workspaceCount

  const runtimeOf = (id: string) => runtime.find((r) => r.id === id)
  const enabledCount = visible.filter((p) => p.enabled).length
  const brokenCount = visible.filter((p) => Boolean(p.invalidReason)).length

  const onCreate = async () => {
    const id = draftId.trim()
    const name = draftName.trim()
    if (!id || !name) {
      pushToast({ type: 'warning', message: t('workbench.plugins.scaffoldIdRequired'), duration: 4000 })
      return
    }
    const ok = await scaffold({ id, name, kind: draftKind, scope })
    if (ok) {
      setDraftId('')
      setDraftName('')
      setShowScaffold(false)
      setScope(scope) // 让新插件所在的作用域立刻被选中（否则用户看不见刚生成的东西）
    }
  }

  /* ---------- ★ v0.36.0：安装（两段式）与卸载确认 ---------- */
  const onInstallClick = async () => {
    // 第一段：无 zipPath → main 弹文件选择框；校验通过会回 needsConfirm 预览
    const res = await installPlugin({})
    if (res.needsConfirm && res.manifest) {
      setOverwrite(Boolean(res.alreadyExists))
      setPendingInstall(res)
      return
    }
    if (!res.ok && res.error !== 'CANCELLED' && res.message) {
      pushToast({ type: 'danger', message: `${installErrorText(t, res.error)}：${res.message}`, duration: 6000 })
    }
  }

  const onConfirmInstall = async () => {
    const res = await installPlugin({ confirmed: true, overwrite })
    setPendingInstall(null)
    if (!res.ok && res.error !== 'CANCELLED' && res.message) {
      pushToast({ type: 'danger', message: `${installErrorText(t, res.error)}：${res.message}`, duration: 6000 })
    }
  }

  const onUninstallConfirm = async () => {
    if (!confirmUninstallId) return
    const ok = await uninstall(confirmUninstallId, { purgeData })
    setConfirmUninstallId(null)
    setPurgeData(false)
    if (ok) setExpandedId(null)
  }

  return (
    <div className="flex flex-col h-full min-h-0" data-testid="capability-plugins-panel">
      {/* ---------- 操作条 ---------- */}
      <div className="px-3 py-2 flex items-center gap-1.5 border-b border-border-subtle flex-shrink-0 flex-wrap">
        {view === 'guide' ? (
          <>
            <button
              type="button"
              onClick={() => setView('list')}
              className="h-6 px-2 rounded-md border border-border-subtle text-2xs text-text-secondary hover:bg-bg-hover focus-ring flex items-center gap-1"
            >
              <Icon.ChevronLeft width={11} height={11} aria-hidden />
              {t('workbench.plugins.backToList')}
            </button>
            <div role="tablist" className="flex items-center gap-0.5 rounded-md bg-bg-input p-0.5">
              {(['usage', 'dev'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={guideTab === k}
                  onClick={() => setGuideTab(k)}
                  className={`h-6 px-2 rounded-md text-2xs focus-ring ${
                    guideTab === k
                      ? 'bg-bg-overlay text-text-primary border border-border-default'
                      : 'text-text-tertiary hover:bg-bg-hover hover:text-text-primary border border-transparent'
                  }`}
                >
                  {k === 'usage' ? t('workbench.plugins.guideUsage') : t('workbench.plugins.guideDev')}
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <ScopeSwitch
              scope={scope}
              workspaceCount={workspaceCount}
              globalCount={globalCount}
              onPick={(s) => void setScope(s)}
            />
            <span className="text-2xs text-text-tertiary mr-auto">
              {t('workbench.plugins.count', { total: visible.length, on: enabledCount })}
            </span>
            <Tooltip label={t('workbench.plugins.installZip')}>
              <button
                type="button"
                disabled={busy}
                onClick={() => void onInstallClick()}
                aria-label={t('workbench.plugins.installZip')}
                className="h-7 px-2 flex items-center gap-1 rounded-md text-2xs text-text-secondary border border-border-subtle hover:bg-bg-hover disabled:opacity-40 focus-ring"
                data-testid="plugin-install"
              >
                <Icon.Download width={12} height={12} aria-hidden className="rotate-180" />
                {t('workbench.plugins.install')}
              </button>
            </Tooltip>
            <Tooltip label={t('workbench.plugins.openDir')}>
              <button
                type="button"
                onClick={() => void openDir(scope)}
                aria-label={t('workbench.plugins.openDir')}
                className="w-7 h-7 flex items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary focus-ring"
              >
                <Icon.FolderOpen width={13} height={13} aria-hidden />
              </button>
            </Tooltip>
            <Tooltip label={t('workbench.plugins.rescan')}>
              <button
                type="button"
                disabled={busy}
                onClick={() => void rescan()}
                aria-label={t('workbench.plugins.rescan')}
                className="w-7 h-7 flex items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary disabled:opacity-40 focus-ring"
              >
                <Icon.Refresh width={13} height={13} aria-hidden className={busy ? 'breathe' : ''} />
              </button>
            </Tooltip>
            <button
              type="button"
              onClick={() => setView('guide')}
              className="h-7 px-2 rounded-md border border-border-subtle text-2xs text-text-secondary hover:bg-bg-hover focus-ring"
              data-testid="plugin-guide-toggle"
            >
              {t('workbench.plugins.guideBtn')}
            </button>
            <button
              type="button"
              onClick={() => setShowScaffold((v) => !v)}
              aria-expanded={showScaffold}
              className="h-7 px-2 rounded-md border border-border-subtle text-2xs text-text-secondary hover:bg-bg-hover focus-ring"
              data-testid="new-plugin-toggle"
            >
              {t('workbench.plugins.newPlugin')}
            </button>
          </>
        )}
      </div>

      {view === 'guide' ? (
        <PluginGuide tab={guideTab} />
      ) : (
        <>
        <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-2">
        {/* ---------- 新建插件（脚手架；代码插件时代只给 JSON 不够用） ---------- */}
        {showScaffold && (
          <section className="rounded-lg border border-border-subtle bg-bg-surface p-3" data-testid="new-plugin-guide">
            <div className="text-2xs text-text-secondary mb-2">{t('workbench.plugins.scaffoldHint')}</div>
            <div className="space-y-1.5">
              <label className="block">
                <span className="text-2xs text-text-tertiary">{t('workbench.plugins.scaffoldId')}</span>
                <input
                  value={draftId}
                  onChange={(e) => setDraftId(e.target.value)}
                  placeholder={t('workbench.plugins.scaffoldIdPlaceholder')}
                  data-testid="scaffold-id"
                  className="mt-0.5 w-full h-7 px-2 rounded-md bg-bg-input border border-border-subtle text-xs text-text-primary font-mono focus-ring"
                />
              </label>
              <label className="block">
                <span className="text-2xs text-text-tertiary">{t('workbench.plugins.scaffoldName')}</span>
                <input
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  placeholder={t('workbench.plugins.scaffoldNamePlaceholder')}
                  data-testid="scaffold-name"
                  className="mt-0.5 w-full h-7 px-2 rounded-md bg-bg-input border border-border-subtle text-xs text-text-primary focus-ring"
                />
              </label>
              <label className="block">
                <span className="text-2xs text-text-tertiary">{t('workbench.plugins.scaffoldKind')}</span>
                <select
                  value={draftKind}
                  onChange={(e) => setDraftKind(e.target.value as PluginKind)}
                  data-testid="scaffold-kind"
                  className="mt-0.5 w-full h-7 px-2 rounded-md bg-bg-input border border-border-subtle text-xs text-text-primary focus-ring"
                >
                  {SCAFFOLD_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="flex items-center gap-1.5 mt-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void onCreate()}
                data-testid="scaffold-create"
                className="h-6 px-2 rounded-md bg-business-primary text-text-inverse text-2xs disabled:opacity-40 focus-ring"
              >
                {t('workbench.plugins.scaffoldCreate')}
              </button>
              <button
                type="button"
                onClick={() => setShowScaffold(false)}
                className="h-6 px-2 rounded-md border border-border-subtle text-2xs text-text-secondary hover:bg-bg-hover focus-ring"
              >
                {t('workbench.plugins.scaffoldCancel')}
              </button>
            </div>
          </section>
        )}

        {/* ---------- 空态 ---------- */}
        {loaded && visible.length === 0 && (
          <div className="py-8 text-center">
            <Icon.Plug width={22} height={22} className="text-text-faint mx-auto mb-2" aria-hidden />
            <div className="text-xs text-text-secondary mb-1">{t('workbench.plugins.empty')}</div>
            <div className="text-2xs text-text-faint">{t('workbench.plugins.emptyHint')}</div>
          </div>
        )}

        {/* ---------- 列表：一行一插件 ---------- */}
        <ul className="space-y-1">
          {visible.map((p) => {
            const KindIcon = Icon[KIND_ICON[p.kind]] ?? Icon.Plug
            const expanded = expandedId === p.id
            const bundled = p.source === 'bundled'
            const rt = runtimeOf(p.id)
            return (
              <li
                key={p.id}
                data-plugin-row={p.id}
                className={`rounded-lg border ${p.invalidReason ? 'border-danger bg-danger-soft' : 'border-border-subtle bg-bg-surface'}`}
              >
                <div className="flex items-center gap-2 px-2.5 py-1.5">
                  <button
                    type="button"
                    onClick={() => setExpandedId(expanded ? null : p.id)}
                    aria-expanded={expanded}
                    aria-label={t('workbench.plugins.detailAria', { name: p.name })}
                    className="flex items-center gap-2 min-w-0 flex-1 text-left focus-ring rounded-md"
                  >
                    <KindIcon
                      width={14}
                      height={14}
                      className={p.enabled ? 'text-accent flex-shrink-0' : 'text-text-faint flex-shrink-0'}
                      aria-hidden
                    />
                    <span className="text-xs text-text-primary truncate">{p.name}</span>
                    <span className="text-2xs text-text-faint font-mono flex-shrink-0">v{p.version}</span>
                    <span className="text-2xs text-text-tertiary border border-border-subtle rounded px-1 leading-4 flex-shrink-0">
                      {sourceText(p.source, t)}
                    </span>
                    {/* ★ v0.36.0（F5.1）：运行期诊断区块 → **状态徽标**。
                        代码插件才需要看运行态；声明式插件不显示（不制造噪音）。 */}
                    <RuntimeBadge plugin={p} rt={rt} />
                    {p.invalidReason && (
                      <Icon.Warning width={12} height={12} className="text-danger flex-shrink-0" aria-hidden />
                    )}
                  </button>
                  <PluginSwitch
                    checked={p.enabled}
                    disabled={busy || Boolean(p.invalidReason)}
                    ariaLabel={t('workbench.plugins.toggleAria', { name: p.name })}
                    onChange={(next) => void setEnabled(p.id, next, scope)}
                  />
                  <Icon.ChevronDown
                    width={12}
                    height={12}
                    aria-hidden
                    className={`text-text-faint flex-shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
                  />
                </div>

                {/* ---------- 详情（就地展开：贡献点 + 运行期诊断） ---------- */}
                {expanded && (
                  <div className="px-2.5 pb-2 pt-0.5 border-t border-border-subtle space-y-1.5" data-testid="plugin-detail">
                    <div className="text-2xs text-text-tertiary">
                      <span className="font-mono">{p.id}</span>
                      {' · '}
                      {p.contributionLabel}
                    </div>
                    {p.description && <div className="text-2xs text-text-faint">{p.description}</div>}

                    {/* ★ v0.36.0（F5.1）：原先的「运行期诊断」方框已删 —— 状态进了
                        行内徽标，这里只留**必须留人话的两类**：失败原因与能力面。
                        权限 / 进程号 / 装载耗时 / 目录属于作者态信息，不进用户界面。 */}
                    <PluginFacts plugin={p} rt={rt} shadowedBy={shadowed.find((s) => s.id === p.id)?.by} />

                    {p.invalidReason && (
                      <div className="text-2xs text-danger break-words">
                        <span className="font-mono">VP</span> · {p.invalidReason}
                      </div>
                    )}

                    <div className="flex items-center gap-1 pt-0.5">
                      <Tooltip label={t('workbench.plugins.exportSample')}>
                        <button
                          type="button"
                          onClick={() => void exportSample(p.id)}
                          aria-label={t('workbench.plugins.exportSampleAria', { name: p.name })}
                          className="h-6 px-1.5 flex items-center gap-1 rounded-md text-2xs text-text-tertiary hover:bg-bg-hover hover:text-text-primary focus-ring"
                        >
                          <Icon.Download width={11} height={11} aria-hidden />
                          {t('workbench.plugins.export')}
                        </button>
                      </Tooltip>
                      <Tooltip
                        label={p.uninstallable ? t('workbench.plugins.uninstall') : t('workbench.plugins.uninstallBuiltinHint')}
                      >
                        <button
                          type="button"
                          disabled={!p.uninstallable || busy}
                          onClick={() => setConfirmUninstallId(p.id)}
                          aria-label={t('workbench.plugins.uninstallAria', { name: p.name })}
                          className="h-6 px-1.5 flex items-center gap-1 rounded-md text-2xs text-text-tertiary hover:bg-bg-hover hover:text-danger disabled:opacity-30 disabled:hover:bg-transparent focus-ring"
                        >
                          <Icon.Trash width={11} height={11} aria-hidden />
                          {t('workbench.plugins.uninstallShort')}
                        </button>
                      </Tooltip>
                    </div>
                  </div>
                )}
              </li>
            )
          })}
        </ul>

        {/* ---------- 覆盖关系（这是一个**冲突**提示，不是诊断信息 → 保留） ---------- */}
        {shadowed.length > 0 && (
          <section className="rounded-lg border border-border-subtle bg-bg-surface p-2.5 space-y-1">
            <div className="flex items-center gap-1.5 text-2xs text-text-tertiary">
              <Icon.Warning width={12} height={12} aria-hidden />
              {t('workbench.plugins.diagShadowed', { count: shadowed.length })}
            </div>
          </section>
        )}

        {/* ---------- 校验问题汇总（逐插件隔离，坏插件不影响其他插件） ---------- */}
        {brokenCount > 0 && (
          <section className="rounded-lg border border-warning bg-warning-soft p-2.5">
            <div className="flex items-center gap-1.5 text-2xs text-warning">
              <Icon.Warning width={12} height={12} aria-hidden />
              {t('workbench.plugins.issuesIsolated')}
            </div>
          </section>
        )}
        </div>
        </>
      )}

      {/* ---------- ★ v0.36.0 安装确认弹窗（权限/能力预览，两段式第二段） ---------- */}
      {pendingInstall?.manifest && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setPendingInstall(null)
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t('workbench.plugins.installConfirmTitle')}
            className="w-[min(440px,calc(100vw-32px))] max-h-[70vh] overflow-y-auto bg-bg-overlay border border-border-default rounded-lg shadow-panel p-4 space-y-3 scale-in"
          >
            <div className="text-sm text-text-primary font-medium">{t('workbench.plugins.installConfirmTitle')}</div>
            <div className="rounded-md bg-bg-input border border-border-subtle p-2.5 space-y-1">
              <div className="text-xs text-text-primary">
                {pendingInstall.manifest.name} <span className="text-text-faint font-mono">v{pendingInstall.manifest.version}</span>
              </div>
              <div className="text-2xs text-text-faint font-mono">{pendingInstall.manifest.id}</div>
              {pendingInstall.manifest.author && (
                <div className="text-2xs text-text-faint">{pendingInstall.manifest.author}</div>
              )}
              {pendingInstall.manifest.description && (
                <div className="text-2xs text-text-secondary break-words">{pendingInstall.manifest.description}</div>
              )}
            </div>
            {(pendingInstall.capabilities?.length ?? 0) > 0 && (
              <div className="text-2xs text-text-secondary">
                <div className="text-text-tertiary mb-0.5">{t('workbench.plugins.installCapabilities')}</div>
                <div className="font-mono break-words">{pendingInstall.capabilities!.join(' · ')}</div>
              </div>
            )}
            {(pendingInstall.permissions?.length ?? 0) > 0 ? (
              <div className="text-2xs text-text-secondary">
                <div className="text-text-tertiary mb-0.5">{t('workbench.plugins.installPermissions')}</div>
                <div className="font-mono text-warning break-words">{pendingInstall.permissions!.join(' · ')}</div>
                <div className="text-text-faint mt-1">{t('workbench.plugins.installPermissionHint')}</div>
              </div>
            ) : (
              <div className="text-2xs text-text-faint">{t('workbench.plugins.installNoPermissions')}</div>
            )}
            {pendingInstall.alreadyExists && (
              <label className="flex items-center gap-1.5 text-2xs text-text-secondary cursor-pointer">
                <input
                  type="checkbox"
                  checked={overwrite}
                  onChange={(e) => setOverwrite(e.target.checked)}
                  className="accent-[var(--accent)]"
                />
                {t('workbench.plugins.installOverwrite')}
              </label>
            )}
            <div className="text-2xs text-text-faint">{t('workbench.plugins.installDisabledHint')}</div>
            <div className="flex items-center justify-end gap-1.5 pt-1">
              <button
                type="button"
                onClick={() => setPendingInstall(null)}
                className="h-7 px-3 rounded-md border border-border-subtle text-xs text-text-secondary hover:bg-bg-hover focus-ring"
              >
                {t('workbench.plugins.installCancel')}
              </button>
              <button
                type="button"
                disabled={pendingInstall.alreadyExists === true && !overwrite}
                onClick={() => void onConfirmInstall()}
                data-testid="plugin-install-confirm"
                className="h-7 px-3 rounded-md bg-business-primary text-text-inverse text-xs disabled:opacity-40 focus-ring"
              >
                {t('workbench.plugins.installConfirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- ★ v0.36.0 卸载确认弹窗（含「删除数据」勾选） ---------- */}
      {confirmUninstallId && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setConfirmUninstallId(null)
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t('workbench.plugins.uninstallConfirmTitle')}
            className="w-[min(380px,calc(100vw-32px))] bg-bg-overlay border border-border-default rounded-lg shadow-panel p-4 space-y-3 scale-in"
          >
            <div className="text-sm text-text-primary font-medium">{t('workbench.plugins.uninstallConfirmTitle')}</div>
            <div className="text-2xs text-text-secondary break-words">
              {t('workbench.plugins.uninstallConfirmBody', { id: confirmUninstallId })}
            </div>
            <label className="flex items-center gap-1.5 text-2xs text-text-secondary cursor-pointer">
              <input
                type="checkbox"
                checked={purgeData}
                onChange={(e) => setPurgeData(e.target.checked)}
                data-testid="plugin-uninstall-purge"
                className="accent-[var(--accent)]"
              />
              {t('workbench.plugins.uninstallPurge')}
            </label>
            <div className="flex items-center justify-end gap-1.5 pt-1">
              <button
                type="button"
                onClick={() => setConfirmUninstallId(null)}
                className="h-7 px-3 rounded-md border border-border-subtle text-xs text-text-secondary hover:bg-bg-hover focus-ring"
              >
                {t('workbench.plugins.installCancel')}
              </button>
              <button
                type="button"
                onClick={() => void onUninstallConfirm()}
                data-testid="plugin-uninstall-confirm"
                className="h-7 px-3 rounded-md bg-danger text-text-inverse text-xs focus-ring"
              >
                {t('workbench.plugins.uninstallConfirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * 来源徽标文案。
 *
 * 三档来源给的是**不同维度**的词（随包示例 / 本工作区 / 全局）而不是
 * 「用户 / 内置」两类 —— v0.35.0 引入 workspace 级之后，User 这一档
 * 已经分不出「只在本工作区生效」与「全局生效」，而这两者的后果完全不同。
 */
function sourceText(source: PluginSummary['source'], t: (k: string) => string): string {
  if (source === 'bundled') return t('workbench.plugins.sourceBundled')
  if (source === 'workspace') return t('workbench.plugins.scopeWorkspace')
  return t('workbench.plugins.scopeGlobal')
}

/** 作用域两态切换（对齐 VS Code 的 User / Workspace 双档） */
function ScopeSwitch({
  scope,
  workspaceCount,
  globalCount,
  onPick,
}: {
  scope: 'workspace' | 'global'
  workspaceCount: number
  globalCount: number
  onPick: (s: 'workspace' | 'global') => void
}) {
  const { t } = useTranslation()
  const item = (key: 'workspace' | 'global', label: string, count: number) => {
    const active = scope === key
    return (
      <button
        type="button"
        role="tab"
        aria-selected={active}
        data-scope={key}
        onClick={() => onPick(key)}
        className={`h-6 px-2 rounded-md text-2xs focus-ring ${
          active
            ? 'bg-bg-overlay text-text-primary border border-border-default'
            : 'text-text-tertiary hover:bg-bg-hover hover:text-text-primary border border-transparent'
        }`}
      >
        {label} ({count})
      </button>
    )
  }
  return (
    <Tooltip label={t('workbench.plugins.scopeHint')}>
      <div role="tablist" className="flex items-center gap-0.5 rounded-md bg-bg-input p-0.5">
        {item('workspace', t('workbench.plugins.scopeWorkspace'), workspaceCount)}
        {item('global', t('workbench.plugins.scopeGlobal'), globalCount)}
      </div>
    </Tooltip>
  )
}

/**
 * ★ v0.36.0（F5.1）：运行期**状态徽标** —— 取代原「运行期诊断」方框。
 *
 * 为什么只留一枚徽标（设计动机原文：诊断黑话）：用户在这一屏要回答的唯一问题是
 * 「这个插件现在活着吗」。权限 / 进程号 / 装载耗时 / 目录路径属于**作者排查**信息，
 * 摆进用户界面只会把「插件没生效」这类真问题淹没在噪音里。
 *
 * 声明式插件（无宿主/渲染代码，也无运行态）没有运行期概念 → 不渲染徽标（零噪音）。
 */
function RuntimeBadge({ plugin, rt }: { plugin: PluginSummary; rt: PluginRuntimeStatus | undefined }) {
  const { t } = useTranslation()
  if (!plugin.hasHostCode && !plugin.hasClientCode && !rt) return null
  const phase: PluginRuntimePhase = rt?.phase ?? 'registered'
  const abnormal = phase === 'error' || phase === 'activation-failed'
  return (
    <span
      data-testid="plugin-runtime-badge"
      data-phase={phase}
      className={`text-2xs border rounded px-1 leading-4 flex-shrink-0 ${PHASE_TONE[phase]} ${
        abnormal ? 'border-danger' : 'border-border-subtle'
      }`}
    >
      {t(PHASE_LABEL[phase])}
    </span>
  )
}

/**
 * 详情里只留两类**必须说人话**的事实（纪律⑦「静默退化必须在诊断通道留人话」）：
 *  ① **失败原因**：插件挂了却只显示「未生效」，作者无从下手；
 *  ② **能力面**：用户得知道它到底给了什么（工具 / 视图 / 命令）。
 * 其余（权限、进程号、装载耗时、目录）不进用户界面。
 */
function PluginFacts({
  plugin,
  rt,
  shadowedBy,
}: {
  plugin: PluginSummary
  rt: PluginRuntimeStatus | undefined
  shadowedBy?: string
}) {
  const { t } = useTranslation()
  const hasFacts =
    Boolean(rt?.lastError) ||
    Boolean(shadowedBy) ||
    plugin.toolNames.length > 0 ||
    plugin.viewRefs.length > 0 ||
    plugin.commandIds.length > 0
  if (!hasFacts) return null
  return (
    <div className="space-y-0.5" data-testid="plugin-facts">
      {rt?.lastError && (
        <div className="text-2xs text-danger break-words">
          <span>{t('workbench.plugins.diagLastError')}：</span>
          {rt.lastError}
        </div>
      )}
      {shadowedBy && (
        <div className="text-2xs text-warning break-words">
          {plugin.id} ← {shadowedBy}
        </div>
      )}
      {plugin.toolNames.length > 0 && (
        <div className="text-2xs text-text-faint font-mono break-words">tools: {plugin.toolNames.join(', ')}</div>
      )}
      {plugin.viewRefs.length > 0 && (
        <div className="text-2xs text-text-faint font-mono break-words">views: {plugin.viewRefs.join(', ')}</div>
      )}
      {plugin.commandIds.length > 0 && (
        <div className="text-2xs text-text-faint font-mono break-words">
          commands: {plugin.commandIds.join(', ')}
          <span className="font-sans text-text-tertiary">（{t('workbench.plugins.commandsHint', { kbd: chordText('Mod+K') })}）</span>
        </div>
      )}
    </div>
  )
}

/* ============================================================
 * ★ v0.36.0（F3.2）：安装错误码 → 人话
 * 错误码是 install.ts 抛的闭集（NO_FILE / EXTRACT_FAILED / …），
 * toast 里不能让用户看英文大写码 —— 逐码映射，未知码原样透传（保留可调试性）。
 * ============================================================ */
function installErrorText(t: (k: string) => string, error: string | undefined): string {
  const map: Record<string, string> = {
    NO_FILE: t('workbench.plugins.errNoFile'),
    CANCELLED: t('workbench.plugins.errCancelled'),
    EXTRACT_FAILED: t('workbench.plugins.errExtractFailed'),
    MANIFEST_INVALID: t('workbench.plugins.errManifestInvalid'),
    ENGINES_MISMATCH: t('workbench.plugins.errEnginesMismatch'),
    ENTRY_MISSING: t('workbench.plugins.errEntryMissing'),
    ALREADY_EXISTS: t('workbench.plugins.errAlreadyExists'),
    IO_ERROR: t('workbench.plugins.errIoError'),
    IPC_ERROR: t('workbench.plugins.errIpcError'),
  }
  return (error && map[error]) || error || t('workbench.plugins.errUnknown')
}

/* ============================================================
 * ★ v0.36.0（F3.6）：插件指南（使用 / 开发 双 tab 内嵌教程）
 * 设计文档：docs/versions/v0.36.0/03-interaction.md §5
 *
 * 为什么内嵌而不是只给外链：作者装 zip 时最多会点开一次「指南」，
 * 跳出应用去看 markdown 的转化率趋近于零。步骤是**结构化数据**
 * （key + 可选代码样例）而不是长文 —— 用户要的是「下一步做什么」。
 * 代码样例是通用文本不做翻译；title/body 全走 i18n（四语言齐备，
 * 由 i18n-interpolation-contract 契约测试把守）。
 * ============================================================ */

/** 清单样例（能直接过 VP1/VP2/VP6/VP7/VP9 校验的最小命令插件） */
const MANIFEST_SAMPLE = `{
  "schemaVersion": "1.1",
  "id": "my.hello",
  "name": "Hello 示例",
  "version": "0.1.0",
  "kind": "action",
  "main": "main.js",
  "engines": { "arkwork": ">=0.35.0" },
  "provides": {
    "action": { "actionId": "hello", "label": "Hello" },
    "commands": [{ "id": "hello", "title": "打个招呼" }]
  },
  "permissions": []
}`

/** Host 半样例：命令监听（与脚手架模板同款 API —— ctx.on / ctx.ark.log） */
const HOST_SAMPLE = `// main.js — Host 半（跑在宿主的独立进程里，CJS）
module.exports = {
  apply(ctx) {
    // 事件名 = command:<清单里声明的 id>；未声明的命令会当场报错
    ctx.on('command:hello', () => {
      ctx.ark.log('info', 'hello 命令被触发了')
      // 想跑 shell / 读文件 / 访问网络？先在 permissions 里声明：
      // await ctx.ark.shell.run('git', ['status'])
    })
  },
}`

interface GuideStep {
  key: string
  code?: string
}

const USAGE_STEPS: GuideStep[] = [
  { key: 'install' },
  { key: 'enable' },
  { key: 'command' },
  { key: 'uninstall' },
  { key: 'notes' },
]

const DEV_STEPS: GuideStep[] = [
  { key: 'scaffold' },
  { key: 'manifest', code: MANIFEST_SAMPLE },
  { key: 'host', code: HOST_SAMPLE },
  { key: 'package' },
  { key: 'verify' },
]

function PluginGuide({ tab }: { tab: 'usage' | 'dev' }) {
  const { t } = useTranslation()
  const steps = tab === 'usage' ? USAGE_STEPS : DEV_STEPS
  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-2.5" data-testid="plugin-guide">
      <div className="text-xs text-text-primary font-medium">{t(`workbench.plugins.guide.${tab}.title`)}</div>
      <p className="text-2xs text-text-secondary leading-relaxed">{t(`workbench.plugins.guide.${tab}.intro`)}</p>
      <ol className="space-y-2">
        {steps.map((s, i) => (
          <li key={s.key} className="rounded-lg border border-border-subtle bg-bg-surface p-2.5">
            <div className="flex items-center gap-1.5 mb-1">
              <span
                className="w-4 h-4 rounded-full bg-bg-input border border-border-subtle text-[10px] leading-none text-text-tertiary flex items-center justify-center flex-shrink-0"
                aria-hidden
              >
                {i + 1}
              </span>
              <span className="text-2xs text-text-primary font-medium">
                {t(`workbench.plugins.guide.${tab}.${s.key}.title`)}
              </span>
            </div>
            <div className="text-2xs text-text-tertiary leading-relaxed whitespace-pre-line">
              {t(`workbench.plugins.guide.${tab}.${s.key}.body`, { kbd: chordText('Mod+K') })}
            </div>
            {s.code && (
              <pre className="mt-1.5 rounded-md bg-bg-input border border-border-subtle p-2 text-[10px] leading-relaxed font-mono text-text-secondary overflow-x-auto whitespace-pre">
                {s.code}
              </pre>
            )}
          </li>
        ))}
      </ol>
    </div>
  )
}
