import { useMemo } from 'react'
import { useStore } from '../../store'
import { formatTime } from '../../types'
import { SectionLabel } from '../ui'
import { Icon } from '../../icons'
import { executionDescription, reasoningDescription } from '../../constants'

/** v0.7.0：REACT_TYPE_COLOR/LABEL 已废除，StepList 为开发者视图，使用内联映射 */
const STEP_TYPE_COLOR: Record<string, string> = {
  plan: 'var(--accent)',
  reason: 'var(--accent)',
  act: 'var(--success)',
  observation: 'var(--text-secondary)',
}
const STEP_TYPE_LABEL: Record<string, string> = {
  plan: 'Plan',
  reason: 'Reason',
  act: 'Act',
  observation: 'Observation',
}

/* v0.5.0（B9）：GraphView → StepList。
 * 原名暗示 DAG 图，实为列表视图，重命名为 StepList；真 DAG 排期。实现不变。 */
export function StepList() {
  const steps = useStore((s) => s.steps)
  const task = useStore((s) => s.tasks.find((t) => t.id === s.selectedTaskId))

  // v0.14.x Task 2：开发者视图保留技术细节（iter/耗时/token），
  // 但补一行人类可读的"当前动作"描述，方便对照真实执行状态
  const currentDescription = useMemo(() => {
    if (task?.status !== 'running') return ''
    const lastAct = [...steps].reverse().find((s) => s.type === 'act')
    if (lastAct) {
      return lastAct.status === 'failed'
        ? '工具调用失败，正在处理…'
        : executionDescription(lastAct.toolName)
    }
    const lastReason = [...steps].reverse().find((s) => s.type === 'reason')
    return reasoningDescription(lastReason ? 'finalizing' : 'thinking')
  }, [task?.status, steps])

  return (
    <div className="flex flex-col h-full">
      {/* 头部 */}
      <div className="px-3 py-2 border-b border-border-subtle flex items-center gap-2">
        <SectionLabel>ReAct DAG</SectionLabel>
        <span className="text-2xs text-text-tertiary tabular">
          {steps.length} steps · iter {steps[steps.length - 1]?.iteration ?? 0}
        </span>
      </div>

      {/* Task 2：人类可读的当前动作（运行中时） */}
      {task?.status === 'running' && currentDescription && (
        <div className="px-3 py-1.5 border-b border-border-subtle bg-bg-base/40 text-2xs text-text-secondary flex items-center gap-1.5">
          <span className="w-1 h-1 rounded-full bg-accent pulse-dot flex-shrink-0" />
          <span className="truncate">{currentDescription}</span>
        </div>
      )}

      {/* DAG 列表 */}
      <div className="flex-1 overflow-y-auto px-3 py-3">
        <div className="space-y-1">
          {steps.map((step, i) => {
            const color = STEP_TYPE_COLOR[step.type] ?? 'var(--text-tertiary)'
            const isLast = i === steps.length - 1
            const isRunning = step.status === 'running'
            return (
              <div key={step.id} className="flex items-stretch gap-2">
                {/* 左侧轨道 */}
                <div className="flex flex-col items-center flex-shrink-0">
                  <div
                    className={`w-7 h-7 rounded-lg flex items-center justify-center text-2xs font-semibold border-2 ${
                      isRunning ? 'pulse-dot' : ''
                    }`}
                    style={{
                      borderColor: color,
                      background: isRunning ? `${color}20` : 'transparent',
                      color,
                    }}
                  >
                    {step.iteration}
                  </div>
                  {!isLast && <div className="w-px flex-1 bg-border-default mt-0.5" />}
                </div>

                {/* 内容 */}
                <div className="flex-1 pb-2 min-w-0">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span
                      className="text-2xs font-semibold px-1.5 py-0.5 rounded-md"
                      style={{ color, background: `${color}15` }}
                    >
                      {STEP_TYPE_LABEL[step.type] ?? step.type}
                    </span>
                    <span className="text-2xs text-text-tertiary tabular">{formatTime(step.startedAt)}</span>
                    {step.durationMs > 0 && (
                      <span className="text-2xs text-text-tertiary tabular">
                        <Icon.Clock width={10} height={10} className="inline-block mr-0.5 -mt-px" aria-hidden="true" />
                        {(step.durationMs / 1000).toFixed(2)}s
                      </span>
                    )}
                    {step.tokensIn && (
                      <span className="text-2xs text-text-tertiary tabular">in {step.tokensIn}</span>
                    )}
                    {step.tokensOut && (
                      <span className="text-2xs text-text-tertiary tabular">out {step.tokensOut}</span>
                    )}
                    {isRunning && (
                      <span className="text-2xs text-accent flex items-center gap-1 ml-auto">
                        <span className="w-1 h-1 rounded-full bg-accent pulse-dot" />
                        running
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-text-secondary">
                    {step.thought && <div className="leading-relaxed">{step.thought}</div>}
                    {step.toolName && (
                      <div className="mt-0.5 font-mono">
                        <span className="text-text-tertiary">tool: </span>
                        <span className="text-success">{step.toolName}</span>
                        {step.toolArgs && (
                          <span className="text-text-tertiary"> {step.toolArgs}</span>
                        )}
                      </div>
                    )}
                    {step.summary && (
                      <div className="mt-0.5 px-2 py-1 rounded-md bg-bg-surface border-l-2 border-border-default text-text-secondary text-2xs whitespace-pre-wrap">
                        {step.summary}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        {/* 图例 */}
        <div className="mt-4 pt-3 border-t border-border-subtle flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-2xs text-text-tertiary">
            <span className="w-2.5 h-2.5 rounded-md border-2" style={{ borderColor: STEP_TYPE_COLOR.reason }} />
            Reason
          </span>
          <span className="flex items-center gap-1.5 text-2xs text-text-tertiary">
            <span className="w-2.5 h-2.5 rounded-md border-2" style={{ borderColor: STEP_TYPE_COLOR.act }} />
            Act
          </span>
          <span className="flex items-center gap-1.5 text-2xs text-text-tertiary">
            <span className="w-2.5 h-2.5 rounded-md border-2" style={{ borderColor: STEP_TYPE_COLOR.observation }} />
            Observation
          </span>
        </div>
      </div>
    </div>
  )
}
