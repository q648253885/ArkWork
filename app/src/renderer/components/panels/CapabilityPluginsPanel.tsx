/* ============================================================
 * ArkWork — CapabilityPluginsPanel（v0.34.0 · P3）
 * 设计文档：docs/versions/v0.34.0/04-system-design.md §4.2
 *
 * 能力插件管理（**能力页「插件」Tab 的唯一内容**）。
 * v0.33.0 里它叫 `workbench/PluginsView`，埋在「设置 → 工作台中心 → 插件」；
 * 用户实测反馈「能力里的插件与工作区的插件重叠」→ 本版迁到能力页并**简化**。
 *
 * 简化取舍（对照 dsh 的「来源分层」+ VS Code 扩展列表形态）：
 *  - 列表**一行一插件**：图标 · 名称 · 版本 · 来源徽标；右侧一个开关 + 问题标记；
 *  - 详情**就地展开**（不跳页）：插件 id · 贡献了什么 · 校验问题 · 操作；
 *  - 顶部只有三个动作：重新扫描 / 打开目录 / 新建插件（含清单样例，收起态）；
 *  - 砍掉：常驻的 JSON 教程区（移入「新建插件」）、诊断信息的重复展示。
 *
 * 数据与 IPC 全部复用既有 store（plugin:list/scan/enable/disable/uninstall），
 * **不新增后端接口** —— 本版只做管理面的搬迁与简化。
 * ============================================================ */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon, type IconName } from '../../icons'
import { Tooltip } from '../ui'
import { useStore } from '../../store'
import type { PluginKind } from '@shared/types/plugin'

/** kind → 图标（禁 emoji） */
const KIND_ICON: Record<PluginKind, IconName> = {
  panel: 'Workspace',
  renderer: 'Eye',
  action: 'Command',
  homeModule: 'Workspace',
  theme: 'Sparkle',
}

/** 新建插件的清单样例（原 PluginsView 的常驻教程移到这里，按需展开） */
const SAMPLE_JSON = `{
  "schemaVersion": "1.0",
  "id": "local.demo",
  "name": "我的演示插件",
  "version": "1.0.0",
  "kind": "panel",
  "provides": {
    "panel": {
      "panelRef": "panel:demo",
      "title": "演示面板",
      "icon": "Sparkle",
      "component": "KeyValueList",
      "data": {
        "kind": "static",
        "rows": [{ "key": "作者", "value": "你" }]
      }
    }
  }
}`

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
  const setEnabled = useStore((s) => s.setPluginEnabled)
  const uninstall = useStore((s) => s.uninstallPlugin)
  const rescan = useStore((s) => s.rescanPlugins)
  const openDir = useStore((s) => s.openPluginsDir)
  const exportSample = useStore((s) => s.exportPluginSample)

  const [showSample, setShowSample] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const enabledCount = plugins.filter((p) => p.enabled).length
  const brokenCount = plugins.filter((p) => Boolean(p.invalidReason)).length

  return (
    <div className="flex flex-col h-full min-h-0" data-testid="capability-plugins-panel">
      {/* ---------- 操作条 ---------- */}
      <div className="px-3 py-2 flex items-center gap-1.5 border-b border-border-subtle flex-shrink-0 flex-wrap">
        <span className="text-2xs text-text-tertiary mr-auto">
          {t('workbench.plugins.count', { total: plugins.length, on: enabledCount })}
        </span>
        <Tooltip label={t('workbench.plugins.openDir')}>
          <button
            type="button"
            onClick={() => void openDir()}
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
          onClick={() => setShowSample((v) => !v)}
          aria-expanded={showSample}
          className="h-7 px-2 rounded-md border border-border-subtle text-2xs text-text-secondary hover:bg-bg-hover focus-ring"
          data-testid="new-plugin-toggle"
        >
          {t('workbench.plugins.newPlugin')}
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-2">
        {/* ---------- 新建插件引导（按需展开；原常驻教程移入） ---------- */}
        {showSample && (
          <section className="rounded-lg border border-border-subtle bg-bg-surface p-3" data-testid="new-plugin-guide">
            <div className="text-2xs text-text-secondary mb-1.5">{t('workbench.plugins.newPluginHint')}</div>
            <pre className="rounded-md bg-bg-input border border-border-subtle p-2.5 font-mono text-2xs text-text-secondary overflow-auto">
              {SAMPLE_JSON}
            </pre>
            <button
              type="button"
              onClick={() => void openDir()}
              className="mt-2 text-2xs text-accent hover:underline"
            >
              {t('workbench.plugins.openDir')}
            </button>
          </section>
        )}

        {/* ---------- 空态 ---------- */}
        {loaded && plugins.length === 0 && (
          <div className="py-8 text-center">
            <Icon.Plug width={22} height={22} className="text-text-faint mx-auto mb-2" aria-hidden />
            <div className="text-xs text-text-secondary mb-1">{t('workbench.plugins.empty')}</div>
            <div className="text-2xs text-text-faint">{t('workbench.plugins.emptyHint')}</div>
          </div>
        )}

        {/* ---------- 列表：一行一插件 ---------- */}
        <ul className="space-y-1">
          {plugins.map((p) => {
            const KindIcon = Icon[KIND_ICON[p.kind]] ?? Icon.Plug
            const expanded = expandedId === p.id
            const bundled = p.source === 'bundled'
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
                      {bundled ? t('workbench.plugins.sourceBundled') : t('workbench.plugins.sourceLocal')}
                    </span>
                    {p.invalidReason && (
                      <Icon.Warning width={12} height={12} className="text-danger flex-shrink-0" aria-hidden />
                    )}
                  </button>
                  <PluginSwitch
                    checked={p.enabled}
                    disabled={busy || Boolean(p.invalidReason)}
                    ariaLabel={t('workbench.plugins.toggleAria', { name: p.name })}
                    onChange={(next) => void setEnabled(p.id, next)}
                  />
                  <Icon.ChevronDown
                    width={12}
                    height={12}
                    aria-hidden
                    className={`text-text-faint flex-shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
                  />
                </div>

                {/* ---------- 详情（就地展开） ---------- */}
                {expanded && (
                  <div className="px-2.5 pb-2 pt-0.5 border-t border-border-subtle space-y-1" data-testid="plugin-detail">
                    <div className="text-2xs text-text-tertiary">
                      <span className="font-mono">{p.id}</span>
                      {' · '}
                      {p.contributionLabel}
                    </div>
                    {p.description && <div className="text-2xs text-text-faint">{p.description}</div>}
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
