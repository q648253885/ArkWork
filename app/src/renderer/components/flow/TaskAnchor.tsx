/**
 * ArkWork — TaskAnchor（v0.36.4 D121 · 任务锚点卡）
 *
 * 交互区顶部恒在锚点（对照 Claude Code subject/activeForm · ZCode Goal Mode）：
 *  - 核心任务 = graph.goal（规划阶段 LLM 产物）
 *  - 正在做   = 焦点节点 title/intent（LLM 规划产物；与主进程 S1 投影同口径）
 *               无图回落 planItems running 项文本
 *  - 用户意图 = 会话标题（D120 LLM 生成）+ 首条用户消息
 *
 * 所有锚点文本都是模型给出的结构化字段，本组件只渲染不造词（设计硬约束）。
 * 可折叠，默认展开；不进过程组（它是锚点，不是过程）。
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '../../store'
import { useGraph } from '../graph/useGraph'
import { focusNodeLabel, pickFocusNode, planRunningText, userIntentText } from '../../flow/task-anchor'
import { Icon } from '../../icons'

export function TaskAnchor({ taskId }: { taskId: string }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(true)
  const task = useStore((s) => s.tasks.find((tl) => tl.id === taskId))
  const isRunning = task?.status === 'running'
  // 图数据：goal + 焦点节点（useGraph 组件内订阅，与任务面板同源）
  const { graph } = useGraph(taskId)

  const goal = graph?.goal?.trim() || null
  const doing = focusNodeLabel(pickFocusNode(graph)) ?? planRunningText(task?.planItems)
  const intent = userIntentText(task?.input?.text)

  // 三行全空（无图、未跑、无输入）→ 不渲染空卡
  if (!goal && !doing && !intent) return null

  const rows: Array<{ key: string; label: string; text: string; live?: boolean }> = []
  if (goal) rows.push({ key: 'goal', label: t('taskAnchor.goal'), text: goal })
  if (doing && isRunning) rows.push({ key: 'doing', label: t('taskAnchor.doing'), text: doing, live: true })
  if (intent) rows.push({ key: 'intent', label: t('taskAnchor.intent'), text: intent })

  return (
    <div className="rounded-lg border border-border-default bg-bg-surface px-3.5 py-2.5" data-testid="task-anchor">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-1.5 text-left text-xs font-medium text-text-secondary hover:text-text-primary"
      >
        {expanded ? <Icon.ChevronDown width={12} height={12} /> : <Icon.ChevronRight width={12} height={12} />}
        <span className="truncate">{task?.title ?? t('taskAnchor.title')}</span>
      </button>
      {expanded && (
        <div className="mt-1.5 space-y-1">
          {rows.map((row) => (
            <div key={row.key} className="flex min-w-0 items-baseline gap-2 text-xs leading-5">
              <span
                className={
                  row.live
                  ? 'shrink-0 text-accent'
                  : 'shrink-0 text-text-tertiary'
                }
              >
                {row.label}
              </span>
              <span className="min-w-0 flex-1 break-words text-text-primary">{row.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
