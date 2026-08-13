/* ============================================================
 * ArkWork — Dock/TerminalPanel (v0.9.0 F902)
 * 终端面板（阶段一：只读时间线）
 * - 当前任务 shell 调用的只读时间线：命令 / 退出码 / 输出摘要，点击展开全文
 * - 数据源：ReAct steps 中的 act(toolName=shell) 记录（RunConsole/shell skill 执行记录）
 * - 阶段二（v0.10.0+）：node-pty 真交互终端（不引原生依赖，不做假终端）
 * ============================================================ */
import { useMemo, useState } from 'react'
import { Icon } from '../../icons'
import { useStore } from '../../store'
import { Tooltip, EmptyState } from '../ui'
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
        summary: s.resultSummary ?? (s.errorMessage ? `失败：${s.errorMessage}` : ''),
        error: s.errorMessage,
        startedAt: s.startedAt,
        durationMs: s.durationMs,
      })
    }
    return out.sort((a, b) => b.startedAt - a.startedAt)
  }, [steps])

  const runningCount = entries.filter((e) => e.status === 'running').length

  return (
    <div className="flex flex-col h-full">
      {/* 头部 */}
      <div className="flex items-center gap-2 px-3 h-9 flex-shrink-0 border-b border-border-subtle">
        <span className="text-sm text-text-primary font-medium">终端</span>
        <span className="text-2xs text-text-tertiary tabular">{entries.length} 条命令</span>
        {runningCount > 0 && (
          <span className="flex items-center gap-1 text-2xs text-accent">
            <span className="w-1.5 h-1.5 rounded-full bg-accent pulse-dot" />
            {runningCount} 执行中
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-1.5">
        {entries.length === 0 ? (
          <EmptyState
            icon={<Icon.Terminal width={22} height={22} />}
            title="暂无终端记录"
            hint="任务执行中的命令会出现在这里"
          />
        ) : (
          <div className="space-y-1">
            {entries.map((e) => {
              const expanded = expandedId === e.id
              return (
                <div
                  key={e.id}
                  className={`rounded-md border transition-colors ${
                    e.status === 'failed'
                      ? 'border-danger/30 bg-danger-soft/20'
                      : e.status === 'running'
                        ? 'border-accent/30 bg-accent-soft/10'
                        : 'border-border-subtle bg-bg-surface'
                  }`}
                >
<Tooltip label="点击展开全文">
                  <button
                    onClick={() => setExpandedId(expanded ? null : e.id)}
                    className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left group"

                  >
                    <span
                      className={`flex-shrink-0 text-2xs font-mono w-7 text-center rounded px-0.5 py-px ${
                        e.status === 'success'
                          ? 'bg-success/15 text-success'
                          : e.status === 'failed'
                            ? 'bg-danger/15 text-danger'
                            : 'bg-accent/15 text-accent'
                      }`}
                    >
                      {e.status === 'success' ? '0' : e.status === 'failed' ? '✕' : '···'}
                    </span>
                    <span className="flex-1 min-w-0 truncate font-mono text-xs text-text-primary">
                      $ {e.command}
                    </span>
                    <span className="flex-shrink-0 text-2xs text-text-tertiary tabular">
                      {e.durationMs > 0 ? `${(e.durationMs / 1000).toFixed(1)}s` : ''}
                    </span>
                    {expanded ? (
                      <Icon.ChevronDown width={16} height={16} className="text-text-tertiary flex-shrink-0" />
                    ) : (
                      <Icon.ChevronRight width={16} height={16} className="text-text-tertiary flex-shrink-0" />
                    )}
                  </button>
</Tooltip>

                  {expanded && (
                    <div className="px-2.5 pb-2 pt-0.5 space-y-1">
                      {e.cwd && (
                        <div className="text-2xs text-text-tertiary font-mono truncate" title={e.cwd}>
                          目录：{e.cwd}
                        </div>
                      )}
                      <pre className="text-xs text-text-secondary whitespace-pre-wrap break-all font-mono bg-bg-base/60 rounded px-2 py-1.5 max-h-48 overflow-y-auto">
                        {e.summary || '(无输出摘要)'}
                      </pre>
                      {e.error && <div className="text-2xs text-danger">{e.error}</div>}
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
