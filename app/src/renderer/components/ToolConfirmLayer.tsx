/* ============================================================
 * ArkWork — ToolConfirmLayer (v0.8.1)
 * 工具执行确认浮层：Agent 请求执行 shell / 其他工具时，
 * 展示命令原文 + 影响说明 + 风险等级（替代旧的 JSON / 原生 dialog）。
 *
 * 行为：
 *  - Esc → 关闭对话框（reason='dismissed'，不算「用户拒绝」）
 *  - 拒绝执行 → reason='denied'（唯一被记为「用户拒绝执行」的路径）
 *  - 允许执行 → resolve true；勾选「本次会话不再询问」则
 *    后续同一条命令直接放行（对齐 GitHub Copilot CLI 体验）
 *
 * Phase A Task 3：点击背景不再关闭 —— 必须显式选择「拒绝 / 允许执行」按钮；
 *   Esc 仍可作为快速取消入口（dismissed 语义保留）。
 * ============================================================ */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore, friendlyError } from '../store'
import { Icon } from '../icons'

const RISK_META: Record<string, { label: string; cls: string; dot: string }> = {
  low:    { label: 'toolconfirm.riskLow', cls: 'bg-success-soft text-success', dot: 'bg-success' },
  medium: { label: 'toolconfirm.riskMedium', cls: 'bg-warning-soft text-warning', dot: 'bg-warning' },
  high:   { label: 'toolconfirm.riskHigh', cls: 'bg-danger-soft text-danger',   dot: 'bg-danger' },
}

export function ToolConfirmLayer() {
  const { t } = useTranslation()
  const req = useStore((s) => s.pendingConfirm)
  const respondConfirm = useStore((s) => s.respondConfirm)
  // v0.15.0：总是允许此命令 → 写入 allow 规则
  const addPermissionRule = useStore((s) => s.addPermissionRule)
  const pushToast = useStore((s) => s.pushToast)
  const [session, setSession] = useState(false)
  const [alwaysAllow, setAlwaysAllow] = useState(false)
  const denyRef = useRef<HTMLButtonElement>(null)

  // 打开时聚焦「拒绝」（默认安全），并监听 Esc → 关闭对话框（不算「用户拒绝」，reason='dismissed'）
  useEffect(() => {
    if (!req) return
    requestAnimationFrame(() => denyRef.current?.focus())
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        respondConfirm(req.requestId, false, false, 'dismissed')
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [req, respondConfirm])

  if (!req) return null

  const risk = RISK_META[req.risk] ?? RISK_META.medium
  const isShell = !!req.command
  const copyCommand = () => {
    if (req.command) void navigator.clipboard?.writeText(req.command)
  }

  // Phase A Task 3：点击背景不再关闭（防误触）；仅保留 stopPropagation 阻止事件冒泡到上层。
  const swallowBackdrop = (e: React.MouseEvent) => {
    e.stopPropagation()
  }

  // v0.15.0：允许执行；勾选「总是允许此命令」则把 Bash(<command>) 写入 allow 规则，
  // 后续同一条命令不再确认（失败由 store 兜底 toast）。
  const handleAllow = async () => {
    if (alwaysAllow && isShell && req.command) {
      try {
        await addPermissionRule(`Bash(${req.command.trim()})`)
        pushToast({ type: 'success', message: t('toolconfirm.addedAllowRule'), duration: 2500 })
      } catch (e) {
        pushToast({ type: 'danger', message: friendlyError(e, t('toolconfirm.addAllowRuleFailed')), duration: 0 })
      }
    }
    respondConfirm(req.requestId, true, session, 'allowed')
  }

  return (
    <div className="dialog-backdrop" onClick={swallowBackdrop} role="presentation">
      <div
        className="w-[540px] max-w-[92vw] rounded-xl bg-bg-overlay border border-border-default shadow-panel overflow-hidden scale-in"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tool-confirm-title"
      >
        {/* 头部：图标 + 标题 + 风险徽标 */}
        <div className="flex items-start gap-3 px-5 pt-4 pb-3">
          <div className="w-9 h-9 rounded-lg bg-accent-soft text-accent flex items-center justify-center flex-shrink-0">
            <Icon.Terminal width={18} height={18} />
          </div>
          <div className="flex-1 min-w-0">
            <div id="tool-confirm-title" className="text-sm font-medium text-text-primary">
              {isShell ? t('toolconfirm.requestShell') : t('toolconfirm.requestSkill', { skill: req.skillName })}
            </div>
            <div className="mt-0.5 text-2xs text-text-tertiary">
              {isShell ? t('toolconfirm.toolOf', { skill: req.skillName }) : t('toolconfirm.needConfirm')}
            </div>
          </div>
          <span
            className={`flex items-center gap-1.5 px-2 h-5 rounded-full text-2xs font-medium flex-shrink-0 ${risk.cls}`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${risk.dot}`} />
            {t(risk.label)}
          </span>
        </div>

        {/* 命令原文（shell） */}
        {isShell && req.command && (
          <div className="px-5 pb-2.5">
            <div className="rounded-lg bg-bg-base border border-border-subtle overflow-hidden">
              <div className="flex items-center gap-1.5 px-3 h-7 border-b border-border-subtle">
                <span className="flex gap-1">
                  <span className="w-2 h-2 rounded-full bg-danger" />
                  <span className="w-2 h-2 rounded-full bg-warning" />
                  <span className="w-2 h-2 rounded-full bg-success" />
                </span>
                <span className="text-2xs text-text-tertiary ml-1">{t('toolconfirm.shell')}</span>
                <button
                  onClick={copyCommand}
                  className="ml-auto flex items-center gap-1 text-2xs text-text-tertiary hover:text-text-primary transition-colors"
                >
                  <Icon.Copy width={16} height={16} />
                  {t('toolconfirm.copy')}
                </button>
              </div>
              <pre className="px-3 py-2.5 text-xs font-mono text-text-primary whitespace-pre-wrap break-all max-h-44 overflow-y-auto select-text">
                {req.command}
              </pre>
            </div>
            {req.cwd && (
              <div className="mt-1.5 flex items-center gap-1.5 text-2xs text-text-tertiary">
                <Icon.File width={16} height={16} className="flex-shrink-0" />
                <span className="truncate">{t('toolconfirm.execDir', { dir: req.cwd })}</span>
              </div>
            )}
          </div>
        )}

        {/* 影响说明 */}
        <div className="px-5 pb-3">
          <div className="text-2xs text-text-tertiary mb-1.5">{t('toolconfirm.impacts')}</div>
          <div className="space-y-1.5">
            {req.impacts.map((imp, i) => (
              <div
                key={i}
                className={`flex items-start gap-2 px-2.5 py-1.5 rounded-md text-xs leading-relaxed ${
                  req.risk === 'high'
                    ? 'bg-danger-soft text-danger'
                    : 'bg-warning-soft text-warning'
                }`}
              >
                <span className="mt-0.5 flex-shrink-0">
                  {req.risk === 'high' ? '⚠' : '•'}
                </span>
                <span className="flex-1">{imp}</span>
              </div>
            ))}
          </div>
          {!isShell && req.argsSummary && (
            <div className="mt-2 rounded-md bg-bg-surface border border-border-subtle px-2.5 py-2 text-xs text-text-secondary font-mono whitespace-pre-wrap break-all max-h-32 overflow-y-auto select-text">
              {req.argsSummary}
            </div>
          )}
        </div>

        {/* 底部：会话记忆 + 总是允许 + 操作 */}
        <div className="flex items-center gap-3 px-5 py-3.5 border-t border-border-subtle bg-bg-surface">
          {isShell && (
            <div className="flex items-center gap-3">
              {req.command && (
                <label className="flex items-center gap-1.5 text-2xs text-text-secondary cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={alwaysAllow}
                    onChange={(e) => setAlwaysAllow(e.target.checked)}
                    className="accent-accent"
                  />
                  {t('toolconfirm.alwaysAllow')}
                </label>
              )}
              <label className="flex items-center gap-1.5 text-2xs text-text-secondary cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={session}
                  onChange={(e) => setSession(e.target.checked)}
                  className="accent-accent"
                />
                {t('toolconfirm.noAskSession')}
              </label>
            </div>
          )}
          <div className="flex-1" />
          <button
            ref={denyRef}
            onClick={() => respondConfirm(req.requestId, false, false, 'denied')}
            className="btn-ghost"
          >
            {t('toolconfirm.deny')}
          </button>
          <button
            onClick={() => void handleAllow()}
            className={req.risk === 'high' ? 'btn-danger' : 'btn-primary'}
          >
            {t('toolconfirm.allow')}
          </button>
        </div>
        {/* Phase A Task 3：明确告知用户关闭方式（按 Esc 或选择上方按钮） */}
        <div className="text-2xs text-text-tertiary text-center px-5 pb-3 -mt-1">
          {t('toolconfirm.closeHint')}
        </div>
      </div>
    </div>
  )
}
