/* ============================================================
 * ArkWork — Dock/TerminalPanel (v0.9.0 F902)
 * 终端面板（阶段一：只读时间线）
 * - 当前任务 shell 调用的只读时间线：命令 / 退出码 / 输出摘要，点击展开全文
 * - 数据源：ReAct steps 中的 act(toolName=shell) 记录（RunConsole/shell skill 执行记录）
 * - 阶段二（v0.10.0+）：node-pty 真交互终端（不引原生依赖，不做假终端）
 * ============================================================ */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../../icons'
import { useStore } from '../../store'
import { EmptyState, Tooltip } from '../ui'
interface ShellEntry {
  id: string
  command: string
  cwd?: string
  status: 'success' | 'failed' | 'running'
  summary: string
  error?: string
  startedAt: number
  durationMs: number
}

export function TerminalPanel() {
  const { t } = useTranslation()
  const steps = useStore((s) => s.steps)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const entries = useMemo<ShellEntry[]>(() => {
    const out: ShellEntry[] = []
    for (const s of steps) {
      if (s.type !== 'act' || (s.toolName !== 'shell' && s.action?.tool !== 'shell')) continue
      let command = ''
      let cwd = ''
      try {
        const args = s.toolArgs ? (JSON.parse(s.toolArgs) as Record<string, unknown>) : {}
        command = String(args.command ?? '')
        cwd = String(args.cwd ?? '')
      } catch { /* ignore */ }
      if (!command) continue
      out.push({
        id: s.id,
        command,
        cwd,
        status: s.status === 'running' ? 'running' : s.status === 'success' ? 'success' : 'failed',
        summary: s.resultSummary ?? (s.errorMessage ? t('dock.terminal.failed', { msg: s.errorMessage }) : ''),
        error: s.errorMessage,
        startedAt: s.startedAt,
        durationMs: s.durationMs,
      })
    }
    return out.sort((a, b) => b.startedAt - a.startedAt)
  }, [steps, t])

  const runningCount = entries.filter((e) => e.status === 'running').length

  const copyOutput = async (e: ShellEntry) => {
    const text = [e.command, e.cwd ? t('dock.terminal.dir', { dir: e.cwd }) : '', e.summary, e.error]
      .filter(Boolean)
      .join('\n')
    try {
      await navigator.clipboard.writeText(text)
    } catch { /* ignore */ }
  }

  return (
    <div className="flex flex-col h-full">
      {/* 头部 */}
      {/* v0.27.0 F14：澄清只读属性——副标签「输出查看器」+ 右侧说明图标 */}
      <div className="flex items-center gap-2 px-3 h-9 flex-shrink-0 border-b border-border-subtle">
        <span className="text-sm text-text-primary font-medium">{t('dock.terminal.title')}</span>
        <span className="text-2xs text-text-tertiary">{t('dock.terminal.output_viewer')}</span>
        <span className="text-2xs text-text-tertiary tabular">{t('dock.terminal.command_count', { count: entries.length })}</span>
        {runningCount > 0 && (
          <span className="flex items-center gap-1 text-2xs text-accent">
            <span className="w-1.5 h-1.5 rounded-full bg-accent pulse-dot" />
            {t('dock.terminal.running', { count: runningCount })}
          </span>
        )}
        <Tooltip label={t('dock.terminal.viewer_tooltip_label')} desc={t('dock.terminal.viewer_tooltip_desc')} className="ml-auto">
          <Icon.Info width={13} height={13} className="text-text-faint" />
        </Tooltip>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-1.5">
        {entries.length === 0 ? (
          <EmptyState
            icon={<Icon.Terminal width={22} height={22} />}
            title={t('dock.terminal.empty_title')}
            hint={t('dock.terminal.empty_hint')}
          />
        ) : (
          <div className="space-y-1">
            {entries.map((e) => {
              const expanded = expandedId === e.id
              return (
                <div
                  key={e.id}
                  data-state={e.status}
                  className={`rounded-md border transition-colors overflow-hidden ${
                    e.status === 'failed'
                      ? 'border-shell-err-border'
                      : e.status === 'running'
                        ? 'border-shell-run-border'
                        : 'border-shell-line'
                  }`}
                >
                  <button
                    onClick={() => setExpandedId(expanded ? null : e.id)}
                    aria-expanded={expanded}
                    aria-label={t('dock.terminal.command_aria', { command: e.command })}
                    className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left group bg-shell-bg"
                  >
                    <span
                      className={`flex-shrink-0 text-2xs font-mono w-7 text-center rounded px-0.5 py-px ${
                        e.status === 'success'
                          ? 'bg-shell-ok-soft text-shell-ok'
                          : e.status === 'failed'
                            ? 'bg-shell-err-soft text-shell-err'
                            : 'bg-shell-run-soft text-shell-run'
                      }`}
                    >
                      {e.status === 'success' ? '0' : e.status === 'failed' ? '✕' : '···'}
                    </span>
                    <span className="flex-1 min-w-0 truncate font-mono text-xs text-shell-fg">
                      $ {e.command}
                    </span>
                    <span className="flex-shrink-0 text-2xs text-shell-muted tabular">
                      {e.durationMs > 0 ? `${(e.durationMs / 1000).toFixed(1)}s` : ''}
                    </span>
                    {expanded ? (
                      <Icon.ChevronDown width={16} height={16} className="text-shell-muted flex-shrink-0" />
                    ) : (
                      <Icon.ChevronRight width={16} height={16} className="text-shell-muted flex-shrink-0" />
                    )}
                  </button>

                  {expanded && (
                    <div className="px-2.5 pb-2 pt-0.5 space-y-1 bg-shell-bg">
                      {e.cwd && (
                        <div className="text-2xs text-shell-muted font-mono truncate" title={e.cwd}>
                          {t('dock.terminal.dir', { dir: e.cwd })}
                        </div>
                      )}
                      <pre className="text-xs text-shell-fg whitespace-pre-wrap break-all font-mono bg-shell-line rounded px-2 py-1.5 max-h-48 overflow-y-auto">
                        {e.summary || t('dock.terminal.no_output_summary')}
                      </pre>
                      {e.error && <div className="text-2xs text-shell-stderr">{e.error}</div>}
                      <div className="flex justify-end">
                        <button onClick={() => copyOutput(e)} className="tool-card__btn">
                          {t('dock.terminal.copy_output')}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
