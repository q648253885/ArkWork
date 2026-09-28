/* ============================================================
 * ArkWork — 权限规则面板（v0.36.0 · F6.1 / P9）
 *
 * 交互规格来源：docs/versions/v0.36.0/03-interaction.md P9
 *   · 元素：规则列表（工具 / 路径 glob / 行为 allow-ask-deny / 来源）
 *           +「添加规则」表单（工具下拉 + 风险级 + 路径 glob + 行为）
 *           + 生效开关；**每行即时生效**
 *   · 五态：默认 / 加载 / 空（引导「运行中拦截弹窗可一键转为规则」）/ 错误 / 成功
 *
 * 三条设计要点（都不是随手决定的）：
 *  ① **来源必须可见**：同一条 `Bash(git diff:*)` 可能来自管理员下发（managed）、
 *     用户手写（project/user）或本工作区点「记住此选择」写下的（local）。
 *     前三种改了会被下次读取覆盖 —— 所以只有 local 行给开关与删除按钮，
 *     其余行显式标注「只读」，而不是给个按了没反应的按钮。
 *  ② **关停是登记不是删除**：关掉的规则仍在列表里（灰显 + 可再打开）。
 *     删掉就找不回来了，用户会不敢关。
 *  ③ **工具下拉必须诚实**：只有真正接入评估链的工具才进下拉（见
 *     `PERMISSION_TOOL_OPTIONS` 头注释与 TC-PRULES-004），否则等于教用户写废规则。
 *
 * 文案纪律（03-interaction §5）：**禁止**出现「诊断」字样，一律用户语言。
 * ============================================================ */
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '../../store'
import { Icon } from '../../icons'
import { SectionLabel } from '../ui'
import {
  PERMISSION_TOOL_OPTIONS,
  RULE_BEHAVIORS,
  formatRuleText,
  parseRuleText,
} from '@shared/utils/permission-rule'
import type {
  PermissionRuleBehavior,
  PermissionRuleEntry,
  PermissionRuleScope,
} from '@shared/types/permission'

/** 行为 → 展示样式（allow 绿 / ask 橙 / deny 红，与中文语义一致） */
const BEHAVIOR_TONE: Record<PermissionRuleBehavior, { cls: string; dot: string }> = {
  allow: { cls: 'bg-success-soft text-success border-success', dot: 'bg-success' },
  ask: { cls: 'bg-warning-soft text-warning border-warning', dot: 'bg-warning' },
  deny: { cls: 'bg-danger-soft text-danger border-danger', dot: 'bg-danger' },
}

/** 来源徽标样式：local 可写（高亮），其余只读（弱化） */
const SCOPE_TONE: Record<PermissionRuleScope, string> = {
  managed: 'border-border-subtle text-text-tertiary',
  local: 'border-accent text-accent',
  project: 'border-border-subtle text-text-tertiary',
  user: 'border-border-subtle text-text-tertiary',
}

export function PermissionRulesPanel() {
  const { t } = useTranslation()
  const entries = useStore((s) => s.permissionRuleEntries)
  const rules = useStore((s) => s.permissionRules)
  const loading = useStore((s) => s.permissionRulesLoading)
  const refresh = useStore((s) => s.refreshPermissionRules)
  const addRule = useStore((s) => s.addPermissionRule)
  const removeRule = useStore((s) => s.removePermissionRule)
  const setEnabled = useStore((s) => s.setPermissionRuleEnabled)

  // ---- 表单（受控）----
  const [tool, setTool] = useState<string>(PERMISSION_TOOL_OPTIONS[0] ?? 'Bash')
  const [pattern, setPattern] = useState('')
  const [behavior, setBehavior] = useState<PermissionRuleBehavior>('allow')

  // 挂载时拉一次；主进程广播 / setPermissionMode / 增删改都会触发刷新
  useEffect(() => {
    void refresh()
  }, [refresh])

  const preview = useMemo(() => formatRuleText(tool, pattern), [tool, pattern])
  const previewValid = parseRuleText(preview) !== null

  const submit = async () => {
    if (!previewValid) return
    await addRule(preview, behavior)
    setPattern('')
  }

  /* ---------- 五态：加载 / 错误 / 空 / 默认 / （成功由 toast 承担） ---------- */
  if (loading && entries.length === 0) {
    return (
      <Shell>
        <div data-testid="permission-rules-loading" className="text-xs text-text-tertiary py-4 text-center">
          {t('settings.permission.rules.loading')}
        </div>
      </Shell>
    )
  }

  if (rules === null && !loading) {
    return (
      <Shell>
        <div data-testid="permission-rules-error" className="flex items-center gap-2 py-3 px-3 rounded-md bg-danger-soft">
          <Icon.Warning width={14} height={14} className="text-danger flex-shrink-0" aria-hidden />
          <span className="text-xs text-danger flex-1">{t('settings.permission.rules.loadFailed')}</span>
          <button type="button" onClick={() => void refresh()} className="btn-ghost text-xs">
            {t('settings.permission.rules.retry')}
          </button>
        </div>
      </Shell>
    )
  }

  return (
    <Shell>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs text-text-secondary">{t('settings.permission.rules.listTitle')}</span>
        <span className="text-2xs text-text-tertiary">
          {t('settings.permission.rules.count', { count: entries.length })}
        </span>
      </div>

      {entries.length === 0 ? (
        <div data-testid="permission-rules-empty" className="rounded-md bg-bg-overlay px-3 py-4 text-center">
          <div className="text-xs text-text-secondary">{t('settings.permission.rules.emptyTitle')}</div>
          <div className="mt-1 text-2xs text-text-tertiary leading-relaxed">
            {t('settings.permission.rules.emptyHint')}
          </div>
        </div>
      ) : (
        <ul data-testid="permission-rules-list" className="space-y-1">
          {entries.map((e) => (
            <RuleRow
              key={`${e.scope}:${e.behavior}:${e.raw}`}
              entry={e}
              onToggle={(next) => void setEnabled(e, next)}
              onRemove={() => void removeRule(e)}
            />
          ))}
        </ul>
      )}

      {/* ---------- 添加规则 ---------- */}
      <div className="pt-3 mt-3 border-t border-border-subtle space-y-2">
        <div className="text-xs text-text-secondary">{t('settings.permission.rules.addTitle')}</div>
        <div className="flex items-center gap-2 flex-wrap">
          <select
            aria-label={t('settings.permission.rules.toolLabel')}
            value={tool}
            onChange={(ev) => setTool(ev.target.value)}
            className="input h-8 w-28 font-mono text-xs"
          >
            {PERMISSION_TOOL_OPTIONS.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <input
            value={pattern}
            onChange={(ev) => setPattern(ev.target.value)}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter') void submit()
            }}
            aria-label={t('settings.permission.rules.patternLabel')}
            placeholder={t('settings.permission.rules.patternPlaceholder')}
            className="input flex-1 min-w-[180px] h-8 font-mono text-xs"
          />
          <select
            aria-label={t('settings.permission.rules.behaviorLabel')}
            value={behavior}
            onChange={(ev) => setBehavior(ev.target.value as PermissionRuleBehavior)}
            className="input h-8 w-24 text-xs"
          >
            {RULE_BEHAVIORS.map((b) => (
              <option key={b} value={b}>
                {t(`settings.permission.ruleGroups.${b}`)}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!previewValid}
            className="flex items-center gap-1 h-8 px-3 rounded-md text-xs text-accent hover:bg-accent-soft transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus-ring"
          >
            <Icon.Plus width={13} height={13} aria-hidden />
            {t('settings.permission.rules.add')}
          </button>
        </div>
        {/* 规则预览：让用户在按下「添加」之前就知道**到底会写下什么** */}
        <div className="flex items-center gap-1.5 text-2xs text-text-tertiary">
          <span>{t('settings.permission.rules.preview')}</span>
          <code
            data-testid="permission-rule-preview"
            className="font-mono px-1.5 py-0.5 rounded bg-bg-overlay text-text-secondary"
          >
            {preview || '—'}
          </code>
        </div>
        <div className="text-2xs text-text-faint leading-relaxed">
          {t('settings.permission.rules.toolScopeHint', { tools: PERMISSION_TOOL_OPTIONS.join(' / ') })}
        </div>
      </div>
    </Shell>
  )
}

/** 面板外壳（标题 + 容器），三处状态分支共用，避免各写一遍样式 */
function Shell({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  return (
    <div>
      <SectionLabel>{t('settings.permission.rules.title')}</SectionLabel>
      <div className="rounded-md border border-border-subtle bg-bg-base p-3.5 space-y-2">{children}</div>
    </div>
  )
}

/** 单行规则：行为 + 规则原文 + 来源 + 开关 + 删除 */
function RuleRow({
  entry,
  onToggle,
  onRemove,
}: {
  entry: PermissionRuleEntry
  onToggle: (next: boolean) => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const tone = BEHAVIOR_TONE[entry.behavior]
  return (
    <li
      data-testid="permission-rule-row"
      data-scope={entry.scope}
      data-enabled={entry.enabled ? '1' : '0'}
      className={`flex items-center gap-2 px-2 py-1.5 rounded-md ${entry.enabled ? 'bg-bg-overlay' : 'bg-bg-base opacity-60'}`}
    >
      <span className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${tone.dot}`} aria-hidden />
      <span className={`px-1.5 py-0.5 rounded border text-2xs flex-shrink-0 ${tone.cls}`}>
        {t(`settings.permission.ruleGroups.${entry.behavior}`)}
      </span>
      <code className="font-mono text-xs text-text-primary truncate flex-1" title={entry.raw}>
        {entry.raw}
      </code>
      <span
        className={`px-1.5 py-0.5 rounded border text-2xs flex-shrink-0 ${SCOPE_TONE[entry.scope]}`}
        title={t(`settings.permission.rules.scope.${entry.scope}Hint`)}
      >
        {t(`settings.permission.rules.scope.${entry.scope}`)}
      </span>
      {entry.editable ? (
        <>
          <label className="flex items-center gap-1 text-2xs text-text-tertiary cursor-pointer select-none flex-shrink-0">
            <input
              type="checkbox"
              checked={entry.enabled}
              onChange={(ev) => onToggle(ev.target.checked)}
              className="accent-accent"
            />
            {entry.enabled ? t('settings.permission.rules.enabled') : t('settings.permission.rules.disabled')}
          </label>
          <button
            type="button"
            onClick={onRemove}
            aria-label={t('settings.permission.rules.remove')}
            title={t('settings.permission.rules.remove')}
            className="flex-shrink-0 p-1 rounded text-text-tertiary hover:text-danger hover:bg-danger-soft transition-colors focus-ring"
          >
            <Icon.Trash width={13} height={13} aria-hidden />
          </button>
        </>
      ) : (
        <span className="text-2xs text-text-faint flex-shrink-0" title={t('settings.permission.rules.readonlyHint')}>
          {t('settings.permission.rules.readonly')}
        </span>
      )}
    </li>
  )
}
