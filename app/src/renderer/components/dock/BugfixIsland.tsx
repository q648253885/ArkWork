/* ============================================================
 * ArkWork — Dock/BugfixIsland (v0.14.0 Task 11.7)
 * 操作岛台：订阅 bugfix:progress，实时展示 4 阶段进度
 * （目标定义 → 修复中 → 验证中 → 已达成 / 未达成），
 * 终态展开 BugfixResultCard（diff 摘要 + 测试输出 + 达成结论）。
 * 只渲染当前选中任务的进度；无进度时不渲染。
 * ============================================================ */
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '../../store'
import { ark } from '../../ipc/client'
import type { BugfixProgressEvent } from '@shared/types/ipc'
import { Icon } from '../../icons'
import { BugfixResultCard } from '../BugfixResultCard'

const STAGE_KEYS: Array<BugfixProgressEvent['phase']> = ['goal-defined', 'fixing', 'verifying', 'achieved']

const PHASE_PROGRESS: Record<BugfixProgressEvent['phase'], number> = {
  'goal-defined': 18,
  fixing: 52,
  verifying: 82,
  achieved: 100,
  'not-achieved': 100,
}

export function BugfixIsland() {
  const { t } = useTranslation()
  const selectedTaskId = useStore((s) => s.selectedTaskId)
  const [event, setEvent] = useState<BugfixProgressEvent | null>(null)

  const STAGES = useMemo(
    () =>
      STAGE_KEYS.map((key) => ({
        key,
        label: t(`dock.bugfix.stage_${key}`),
      })),
    [t],
  )

  const phaseLabel = (phase: BugfixProgressEvent['phase']): string => t(`dock.bugfix.phase_${phase}`)

  useEffect(() => {
    return ark.bugfix.onProgress((e) => {
      // 切换任务后仍保留旧事件，但渲染时按 selectedTaskId 过滤；
      // 同一任务的新事件直接覆盖
      setEvent((prev) => (prev && prev.taskId !== e.taskId ? prev : e))
    })
  }, [])

  // 仅展示当前选中任务的进度
  if (!event || event.taskId !== selectedTaskId) return null

  const terminal = event.phase === 'achieved' || event.phase === 'not-achieved'
  const achieved = event.phase === 'achieved'
  const percent = PHASE_PROGRESS[event.phase]
  const activeIndex = terminal
    ? STAGES.length - 1
    : STAGES.findIndex((s) => s.key === event.phase)

  return (
    <div className="px-3 pt-2 flex-shrink-0">
      <div
        className={`mx-auto max-w-[620px] rounded-xl border bg-bg-overlay backdrop-blur px-3.5 py-2.5 transition-colors ${
          terminal
            ? achieved
              ? 'border-success shadow-panel'
              : 'border-danger shadow-panel'
            : 'border-border-subtle shadow-panel'
        }`}
        role="status"
        aria-label={t('dock.bugfix.aria_progress', { phase: phaseLabel(event.phase) })}
      >
        {/* 顶行：标题 + 阶段文案 + 轮次 */}
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center justify-center w-5 h-5 rounded-md bg-accent-soft text-accent flex-shrink-0">
            <Icon.Bolt width={13} height={13} />
          </span>
          <span className="text-xs font-medium text-text-primary">bugfix</span>
          <span
            className={`text-2xs ${
              terminal ? (achieved ? 'text-success' : 'text-danger') : 'text-text-secondary'
            }`}
          >
            {phaseLabel(event.phase)}
          </span>
          {!terminal && (
            <span className="ml-auto text-2xs text-text-tertiary tabular">
              round {event.round} · attempt {event.attempt}
            </span>
          )}
        </div>

        {/* 4 阶段进度条 */}
        <div className="mt-2 flex items-center gap-1">
          {STAGES.map((stage, i) => {
            const isDone = terminal ? true : i < activeIndex
            const isActive = !terminal && i === activeIndex
            return (
              <div key={stage.key} className="flex-1">
                <div
                  className={`h-1 rounded-full transition-all duration-500 ${
                    terminal
                      ? achieved
                        ? 'bg-success'
                        : 'bg-danger'
                      : isDone
                        ? 'bg-success'
                        : isActive
                          ? 'bg-accent animate-pulse'
                          : 'bg-bg-elevated'
                  }`}
                />
              </div>
            )
          })}
        </div>

        {/* 阶段标签 */}
        <div className="mt-1.5 flex items-center justify-between px-0.5">
          {STAGES.map((stage, i) => (
            <span
              key={stage.key}
              className={`text-2xs ${
                i <= activeIndex || terminal ? 'text-text-secondary' : 'text-text-tertiary'
              }`}
            >
              {i === STAGES.length - 1 && terminal
                ? achieved
                  ? t('dock.bugfix.phase_achieved')
                  : t('dock.bugfix.phase_not_achieved')
                : stage.label}
            </span>
          ))}
          {!terminal && (
            <span className="text-2xs text-text-tertiary tabular ml-auto">{percent}%</span>
          )}
        </div>

        {/* 终态：结果卡片 */}
        {terminal && event.result && (
          <div className="mt-2.5">
            <BugfixResultCard result={event.result} />
          </div>
        )}
      </div>
    </div>
  )
}
