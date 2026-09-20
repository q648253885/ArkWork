/* ============================================================
 * ArkWork — CapabilityPluginsPanel（v0.34.0 · P3；★ v0.35.0 扩代码插件）
 * 设计文档：docs/versions/v0.34.0/04-system-design.md §4.2
 *           ★ v0.35.0：docs/versions/v0.35.0/04-system-design.md §5.3 · §7
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
 * 简化取舍（延续 v0.34.0）：一行一插件；详情就地展开（不跳页）；顶部只放必要动作。
 * ============================================================ */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon, type IconName } from '../../icons'
import { Tooltip } from '../ui'
import { useStore } from '../../store'
import type { PluginKind, PluginRuntimePhase, PluginRuntimeStatus, PluginSummary } from '@shared/types/plugin'

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
  const openViews = useStore((s) => s.pluginOpenViews)
  const setEnabled = useStore((s) => s.setPluginEnabled)
  const uninstall = useStore((s) => s.uninstallPlugin)
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

  return (
    <div className="flex flex-col h-full min-h-0" data-testid="capability-plugins-panel">
      {/* ---------- 操作条 ---------- */}
      <div className="px-3 py-2 flex items-center gap-1.5 border-b border-border-subtle flex-shrink-0 flex-wrap">
        <ScopeSwitch
          scope={scope}
          workspaceCount={workspaceCount}
          globalCount={globalCount}
          onPick={(s) => void setScope(s)}
        />
        <span className="text-2xs text-text-tertiary mr-auto">
          {t('workbench.plugins.count', { total: visible.length, on: enabledCount })}
        </span>
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
            <Icon.Refresh width={13} height={13} aria-hidden className={busy ? 'animate-spin' : ''} />
          </button>
        </Tooltip>
        <button
          type="button"
          onClick={() => setShowScaffold((v) => !v)}
          aria-expanded={showScaffold}
          className="h-7 px-2 rounded-md border border-border-subtle text-2xs text-text-secondary hover:bg-bg-hover focus-ring"
          data-testid="new-plugin-toggle"
        >
          {t('workbench.plugins.newPlugin')}
        </button>
      </div>

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

                    {/* 运行期诊断（代码插件才有意义；纯声明式插件显示不出来就整段不显示） */}
                    <DiagBlock plugin={p} rt={rt} shadowedBy={shadowed.find((s) => s.id === p.id)?.by} />

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
                          onClick={() => void uninstall(p.id)}
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

        {/* ---------- 覆盖关系 + 会话数（诊断页的一行摘要） ---------- */}
        {(shadowed.length > 0 || openViews > 0) && (
          <section className="rounded-lg border border-border-subtle bg-bg-surface p-2.5 space-y-1">
            {shadowed.length > 0 && (
              <div className="flex items-center gap-1.5 text-2xs text-text-tertiary">
                <Icon.Warning width={12} height={12} aria-hidden />
                {t('workbench.plugins.diagShadowed', { count: shadowed.length })}
              </div>
            )}
            {openViews > 0 && (
              <div className="flex items-center gap-1.5 text-2xs text-text-faint">
                <Icon.Eye width={12} height={12} aria-hidden />
                {t('workbench.plugins.diagViews', { count: openViews })}
              </div>
            )}
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

/** 运行期诊断块（来源 / 入口 / 权限 / 激活态 / 耗时 / 最近错误） */
function DiagBlock({
  plugin,
  rt,
  shadowedBy,
}: {
  plugin: PluginSummary
  rt: PluginRuntimeStatus | undefined
  shadowedBy?: string
}) {
  const { t } = useTranslation()
  const status = rt
  const isCode = plugin.hasHostCode || plugin.hasClientCode
  if (!isCode && !status && !shadowedBy) return null

  const phase: PluginRuntimePhase = status?.phase ?? 'registered'
  return (
    <div className="rounded-md bg-bg-input border border-border-subtle p-2 space-y-0.5" data-testid="plugin-diag">
      <div className="text-2xs text-text-tertiary font-medium">{t('workbench.plugins.diagTitle')}</div>
      <div className="text-2xs text-text-faint flex items-center gap-1.5 flex-wrap">
        <span>{t('workbench.plugins.diagPhase')}</span>
        <span className={PHASE_TONE[phase]}>{t(PHASE_LABEL[phase])}</span>
        {typeof status?.activationMs === 'number' && (
          <span className="font-mono">
            {t('workbench.plugins.diagActivation')} {status.activationMs}ms
          </span>
        )}
        {typeof status?.hostPid === 'number' && (
          <span className="font-mono">
            {t('workbench.plugins.diagHostPid')} {status.hostPid}
          </span>
        )}
      </div>
      <div className="text-2xs text-text-faint break-words">
        <span>{t('workbench.plugins.diagPermissions')}：</span>
        <span className="font-mono">
          {status && status.permissions.length > 0
            ? status.permissions.join(' · ')
            : t('workbench.plugins.diagNoPermission')}
        </span>
      </div>
      {status?.lastError && (
        <div className="text-2xs text-danger break-words">
          <span>{t('workbench.plugins.diagLastError')}：</span>
          {status.lastError}
        </div>
      )}
      {shadowedBy && (
        <div className="text-2xs text-warning break-words">
          {plugin.id} ← {shadowedBy}
        </div>
      )}
      {plugin.hasHostCode && (
        <div className="text-2xs text-text-faint font-mono truncate" title={plugin.dir}>
          main.js
          {plugin.hasClientCode ? ' + renderer.js' : ''} @ {plugin.dir}
        </div>
      )}
      {plugin.toolNames.length > 0 && (
        <div className="text-2xs text-text-faint font-mono break-words">tools: {plugin.toolNames.join(', ')}</div>
      )}
      {plugin.viewRefs.length > 0 && (
        <div className="text-2xs text-text-faint font-mono break-words">views: {plugin.viewRefs.join(', ')}</div>
      )}
    </div>
  )
}
