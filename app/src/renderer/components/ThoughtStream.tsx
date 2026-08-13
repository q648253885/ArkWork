/* ============================================================
 * ArkWork — ThoughtStream (v0.7.0)
 * 取代 StepStream 的扁平日志视图，重做为叙事流：
 * - 按 iteration 分组成"思考-行动"单元（reason + act + observation 一体）
 * - 思考块：灰色从属文本，无边框无标签无时间戳
 * - 工具卡：人性化一行（图标 + 动词短语 + 关键参数），运行中转圈、完成打勾
 * - 完成后折叠为人性化摘要行
 * - PlanCard：决策前置（计划 + 资源决策可见）
 * 设计文档：docs/versions/v0.7.0/05-react-stream.md
 *
 * v0.14.0 Task 4：顶部新增「并行进度」面板，
 * 按工具维度展示当前飞行中的多个 Act（per-requestId），
 * 避免 UI 漂移 / 互相覆盖。
 * ============================================================ */
import { useState, useMemo } from 'react'
import { getToolDisplay, argKeyLabel } from '../constants'
import { Icon } from '../icons'
import { useStore } from '../store'
import type { ReActStep } from '../types'
import type { ToolProgressEvent } from '@shared/types/ipc'

interface ThoughtStreamProps {
  steps: ReActStep[]
}

/** 模块级常量：空进度数组。避免 selector 每次返回新引用导致 useSyncExternalStore 无限循环（P0 白屏） */
const EMPTY_PROGRESS: ToolProgressEvent[] = []

/** 按 iteration 分组的单元 */
interface IterationUnit {
  iteration: number
  plan?: ReActStep
  reason?: ReActStep
  acts: ReActStep[]
  observation?: ReActStep
  ts: number
}

export function ThoughtStream({ steps }: ThoughtStreamProps) {
  // v0.13.0：默认展开 ToolCard 列表（对齐 00-design-system §ToolCard「按每次 Act 依次出现」），
  // 顶部保留折叠摘要行用于收起；Reason 仍默认折叠。
  const [expanded, setExpanded] = useState(true)
  const selectedTaskId = useStore((s) => s.selectedTaskId)
  const activeProgress = useStore((s) =>
    selectedTaskId ? s.activeProgressByTask[selectedTaskId] ?? EMPTY_PROGRESS : EMPTY_PROGRESS,
  )
  // v0.14.0 Task 4：当前在飞行的"多 act 并行"条数
  const inflight = activeProgress.filter((p) => p.status === 'running')

  if (steps.length === 0 && inflight.length === 0) return null

  // 按 iteration 分组
  const units = useMemo(() => groupByIteration(steps), [steps])
  const running = steps.find((s) => s.status === 'running')
  const failed = steps.find((s) => s.status === 'failed')

  const totalMs = steps.reduce((sum, s) => sum + (s.durationMs || 0), 0)

  /* ---- 运行中：展示当前单元的思考块 + 工具卡 ---- */
  if (running) {
    const currentUnit = units.find((u) => u.iteration === running.iteration) ?? units[units.length - 1]
    return (
      <div className="py-1 space-y-1">
        {/* v0.14.0 Task 4：按工具维度并行的进度聚合（不漂移、不互盖） */}
        {inflight.length > 0 && <ParallelProgressBar progress={inflight} />}
        {/* 之前已完成的单元折叠 */}
        {units.length > 1 && (
          <CollapsedSummary
            units={units.slice(0, -1)}
            totalMs={totalMs - (running.durationMs || 0)}
            expanded={expanded}
            onToggle={() => setExpanded((v) => !v)}
          />
        )}
        {expanded && units.slice(0, -1).map((u) => (
          <IterationBlock key={u.iteration} unit={u} />
        ))}
        {/* 当前运行中的单元 */}
        {currentUnit && <IterationBlock unit={currentUnit} isActive />}
      </div>
    )
  }

  /* ---- 完成或失败：折叠摘要 ---- */
  return (
    <div className="text-xs text-text-tertiary select-none">
      <CollapsedSummary
        units={units}
        totalMs={totalMs}
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
        failed={!!failed}
        failedStep={failed}
      />
      {expanded && (
        <div className="mt-0.5 space-y-2 pb-1">
          {units.map((u) => (
            <IterationBlock key={u.iteration} unit={u} />
          ))}
        </div>
      )}
    </div>
  )
}

/* ============================================================
 * 分组逻辑：按 iteration 归并 reason+act+observation 为单元
 * ============================================================ */
function groupByIteration(steps: ReActStep[]): IterationUnit[] {
  const map = new Map<number, IterationUnit>()
  for (const s of steps) {
    const u = map.get(s.iteration) ?? {
      iteration: s.iteration,
      acts: [],
      ts: s.startedAt,
    }
    if (s.type === 'plan') u.plan = s
    else if (s.type === 'reason') u.reason = s
    else if (s.type === 'act') u.acts.push(s)
    else if (s.type === 'observation') u.observation = s
    u.ts = Math.min(u.ts, s.startedAt)
    map.set(s.iteration, u)
  }
  return Array.from(map.values()).sort((a, b) => a.iteration - b.iteration)
}

/* ============================================================
 * CollapsedSummary — 折叠摘要行
 * "▸ 已思考 3.2s · 调用 3 个工具（读取文件 ×2 · 搜索网页 ×1）· 共 12.4s"
 * ============================================================ */
function CollapsedSummary({
  units,
  totalMs,
  expanded,
  onToggle,
  failed,
  failedStep,
}: {
  units: IterationUnit[]
  totalMs: number
  expanded: boolean
  onToggle: () => void
  failed?: boolean
  failedStep?: ReActStep
}) {
  const toolSteps = units.flatMap((u) => u.acts).filter((a) => a.toolName)
  const toolCount = toolSteps.length
  const reasonCount = units.filter((u) => u.reason).length

  // 工具调用摘要：按动词分组
  const toolSummary = useMemo(() => {
    const groups = new Map<string, number>()
    for (const s of toolSteps) {
      const display = getToolDisplay(s.toolName ?? '', parseArgs(s.toolArgs))
      const key = display.verb
      groups.set(key, (groups.get(key) ?? 0) + 1)
    }
    return Array.from(groups.entries())
      .map(([verb, count]) => `${verb}${count > 1 ? ` ×${count}` : ''}`)
      .join(' · ')
  }, [toolSteps])

  const summary = failed
    ? `✕ ${failedStep?.errorMessage?.slice(0, 60) || failedStep?.thought?.slice(0, 60) || '执行失败'}`
    : `已思考 ${(totalMs / 1000).toFixed(1)}s${toolCount > 0 ? ` · 调用 ${toolCount} 个工具（${toolSummary}）` : ''}${reasonCount > 0 ? ` · ${reasonCount} 轮思考` : ''} · 共 ${(totalMs / 1000).toFixed(1)}s`

  return (
    <button
      onClick={onToggle}
      className="w-full flex items-center gap-1.5 py-1 px-0.5 rounded-md hover:bg-bg-hover transition-colors group"
    >
      {expanded ? (
        <Icon.ChevronDown width={16} height={16} className="text-text-tertiary flex-shrink-0" />
      ) : (
        <Icon.ChevronRight width={16} height={16} className="text-text-tertiary flex-shrink-0" />
      )}
      <span className={`flex-1 text-left truncate text-xs ${failed ? 'text-danger' : 'text-text-tertiary'}`}>
        {summary}
      </span>
    </button>
  )
}

/* ============================================================
 * IterationBlock — 一个 iteration 的叙事单元
 * 思考块（默认折叠，点击展开） + 工具卡列表
 * v0.8.0：计划清单已由 ConversationFlow 的 PlanChecklist 独立展示，
 * 此处不再渲染 PlanCard，避免重复。
 * ============================================================ */
function IterationBlock({ unit, isActive }: { unit: IterationUnit; isActive?: boolean }) {
  return (
    <div
      className="space-y-1"
      data-react-iteration={String(unit.iteration)}
      id={`react-iter-${unit.iteration}`}
    >
      {/* 思考块 — v0.13.0 Reason 视觉分离 */}
      {unit.reason && <ThinkBlock step={unit.reason} isActive={isActive} />}

      {/* 工具卡 — v0.13.0 独立 ToolCard */}
      {unit.acts.map((act) => (
        <ToolCard key={act.id} step={act} observation={unit.observation} />
      ))}

      {/* Observation 视觉分离（淡色 observation 卡） */}
      {unit.observation && unit.observation.summary && (
        <div className="react-observation">
          <div className="react-observation__label">结果</div>
          <div>{unit.observation.summary}</div>
        </div>
      )}
    </div>
  )
}

/* ============================================================
 * ThinkBlock — v0.13.0 Reason 块（独立视觉容器）
 * 灰色从属卡片，无背景块、仅 1px 边线。流式时尾缀光标；完成后"Reasoning · 3.2s ▾"
 * v0.13.0：💭 emoji 替换为 SVG Brain 图标（对齐 00-design-system §1.2）
 * ============================================================ */
function ThinkBlock({ step, isActive }: { step: ReActStep; isActive?: boolean }) {
  const [showFull, setShowFull] = useState(false)
  const thought = step.thought ?? ''
  const isRunning = step.status === 'running' && isActive
  const duration = step.durationMs

  if (!thought) return null

  // 默认折叠（运行中也折叠，点击展开）
  const showBody = showFull

  return (
    <div className="react-reason">
      <button
        onClick={() => setShowFull((v) => !v)}
        className="react-reason__head"
      >
        <span className="react-reason__icon" aria-hidden="true">
          <Icon.Brain width={12} height={12} />
        </span>
        <span>Reasoning</span>
        {isRunning && <span className="w-1 h-1 rounded-full bg-accent pulse-dot" />}
        <span className="react-reason__duration tabular">
          {isRunning ? '…' : duration > 0 ? `${(duration / 1000).toFixed(1)}s` : ''}
        </span>
      </button>
      {showBody && (
        <div className="react-reason__body">
          {thought}
          {isRunning && (
            <span className="inline-block w-0.5 h-3.5 bg-accent ml-0.5 animate-pulse" />
          )}
        </div>
      )}
    </div>
  )
}

/* ============================================================
 * ToolCard — v0.13.0 独立工具调用卡
 * - 五态：pending / running / success / failed / cancelled
 * - 参数默认折叠；结果默认展开
 * - 操作：复制 / 重试
 * ============================================================ */
function ToolCard({ step, observation }: { step: ReActStep; observation?: ReActStep }) {
  const [argsOpen, setArgsOpen] = useState(false) // v0.13.0：默认折叠
  const [resultOpen, setResultOpen] = useState(true) // v0.13.0：默认展开
  const parsedArgs = parseArgs(step.toolArgs)
  const display = getToolDisplay(step.toolName ?? '', parsedArgs)
  const argText = display.argSummary(parsedArgs)
  const isRunning = step.status === 'running'
  const isFailed = step.status === 'failed'
  const isSuccess = step.status === 'success'
  const isCancelled = step.status === 'cancelled'
  const duration = step.durationMs
  const state = isRunning
    ? 'running'
    : isFailed
      ? 'failed'
      : isSuccess
        ? 'success'
        : isCancelled
          ? 'cancelled'
          : 'pending'

  // 失败-重试折叠：同 iteration 同工具的失败+成功
  const obsSummary = observation?.summary
  const hasArgs = !!step.toolArgs
  const hasResult = !!(step.resultSummary || obsSummary || step.errorMessage)

  // v0.15.x：是否展示"详情"按钮
  // 当解析后只有 1 个参数，且该值已经在 argSummary 中展示时，不再显示"详情"按钮（避免冗余）
  const argEntries = Object.entries(parsedArgs)
  const singleArgCovered =
    argEntries.length === 1 &&
    !!argText &&
    !!argEntries[0] &&
    argText.includes(String(argEntries[0][1] ?? ''))
  const showDetailBtn = hasArgs && !singleArgCovered

  const copyResult = async () => {
    const text = step.resultSummary ?? obsSummary ?? ''
    try {
      await navigator.clipboard.writeText(text)
    } catch { /* ignore */ }
  }
  const retry = () => {
    window.dispatchEvent(new CustomEvent('react:retry-tool', { detail: { stepId: step.id, toolName: step.toolName } }))
  }

  return (
    <div
      id={`tool-${step.id}`}
      className="tool-card"
      data-state={state}
      title={formatTimeShort(step.startedAt)}
    >
      <button
        onClick={() => setResultOpen((v) => !v)}
        className="tool-card__head"
      >
        {/* 状态描述：图标 + 动词 + 关键参数（一行） */}
        <span className="tool-card__head-text">
          {display.icon} {display.verb}
          {argText && (
            <>
              <span className="tool-card__head-sep">·</span>
              <span className="tool-card__head-arg">{argText}</span>
            </>
          )}
        </span>
        {/* 耗时 */}
        {duration > 0 && (
          <span className="tool-card__duration tabular">
            ⏱ {(duration / 1000).toFixed(1)}s
          </span>
        )}
        {/* 状态图标 */}
        <span className="flex-shrink-0">
          {isRunning ? (
            <span className="inline-block w-3 h-3 border-[1.5px] border-accent border-t-transparent rounded-full animate-spin" />
          ) : isFailed ? (
            <span className="text-danger">✕</span>
          ) : (
            <span className="text-success">✓</span>
          )}
        </span>
      </button>

      {(resultOpen && (hasResult || step.errorMessage)) && (
        <div className="tool-card__body">
          {step.errorMessage && (
            <div className="text-danger whitespace-pre-wrap">{step.errorMessage}</div>
          )}
          {step.resultSummary && (
            <div className="tool-card__result">{step.resultSummary}</div>
          )}
          {obsSummary && (
            <div className="tool-card__result text-text-tertiary">{obsSummary}</div>
          )}
          {/* v0.13.0：操作行 — 复制 / 重试 / 详情 toggle */}
          <div className="tool-card__actions">
            {showDetailBtn && (
              <button
                onClick={() => setArgsOpen((v) => !v)}
                className="tool-card__btn"
              >
                {argsOpen ? '收起' : '详情'}
              </button>
            )}
            {hasResult && (
              <button onClick={copyResult} className="tool-card__btn">
                复制结果
              </button>
            )}
            {isFailed && (
              <button onClick={retry} className="tool-card__btn tool-card__btn--retry">
                重试
              </button>
            )}
          </div>
          {argsOpen && hasArgs && (
            <div className="tool-card__args">
              {argEntries.map(([k, v]) => {
                const valueText = stringifyArgValue(v)
                return (
                  <div className="tool-card__arg-row" key={k}>
                    <span className="tool-card__arg-key">{argKeyLabel(k)}</span>
                    <span
                      className="tool-card__arg-value"
                      title={valueText}
                    >
                      {valueText}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
          {/* L2 大结果入口 */}
          {step.rawL2Path && (
            <button className="tool-card__btn">查看完整输出 →</button>
          )}
        </div>
      )}
    </div>
  )
}

/* ============================================================
 * 工具函数
 * ============================================================ */
function parseArgs(toolArgs?: string): Record<string, unknown> {
  if (!toolArgs) return {}
  try {
    return JSON.parse(toolArgs)
  } catch {
    return {}
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s
}

/** v0.15.x：参数值渲染。
 * - 字符串：超长截断 + title 悬浮完整内容
 * - 对象/数组：JSON 序列化
 * - 其它：String() 转换
 */
function stringifyArgValue(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return truncate(v, 200)
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try {
    return truncate(JSON.stringify(v, null, 2), 400)
  } catch {
    return String(v)
  }
}

function formatTimeShort(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

/* ============================================================
 * v0.14.0 Task 4：并行进度条（按工具维度）
 * 同一轮发起多个 Act 调用时，按 requestId 分别展示，
 * 防止单一"正在执行…"互相覆盖；finished 状态在动画后由
 * `clear` 事件移除以保持列表干净。
 * ============================================================ */
function ParallelProgressBar({ progress }: { progress: ToolProgressEvent[] }) {
  return (
    <div
      className="rounded-lg border border-border-subtle bg-bg-surface/50 px-2 py-1.5 space-y-1"
      data-testid="parallel-progress"
    >
      <div className="flex items-center gap-1.5 text-2xs text-text-tertiary">
        <Icon.Branch width={16} height={16} />
        <span>并行执行 {progress.length} 个工具</span>
      </div>
      {progress.map((p) => {
        const isRunning = p.status === 'running'
        const isFailed = p.status === 'failed'
        const cls = isRunning
          ? 'bg-accent-soft text-accent'
          : isFailed
            ? 'bg-danger-soft text-danger'
            : 'bg-success-soft text-success'
        return (
          <div
            key={p.requestId}
            className="flex items-center gap-1.5 text-2xs"
            data-tool={p.tool}
            data-status={p.status}
          >
            <span
              className={`px-1.5 py-0.5 rounded font-medium ${cls}`}
            >
              {p.tool}
            </span>
            <span className="text-text-tertiary truncate">
              {p.resultSummary ?? (isRunning ? '执行中…' : p.status)}
            </span>
            {isRunning && (
              <span className="ml-auto inline-block w-3 h-3 border-[1.5px] border-accent border-t-transparent rounded-full animate-spin flex-shrink-0" />
            )}
            {typeof p.durationMs === 'number' && p.durationMs > 0 && (
              <span className="ml-auto text-2xs text-text-tertiary tabular flex-shrink-0">
                ⏱ {(p.durationMs / 1000).toFixed(1)}s
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
