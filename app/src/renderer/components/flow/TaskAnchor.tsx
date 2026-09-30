/**
 * ArkWork — TaskAnchor（v0.36.4 D121 · 任务锚点 / v0.42.0 P5 胶囊化）
 *
 * 交互区顶部恒在锚点（对照 Claude Code subject/activeForm · ZCode Goal Mode）：
 *  - 核心任务 = graph.goal（规划阶段 LLM 产物）
 *  - 正在做   = 焦点节点 title/intent（LLM 规划产物；与主进程 S1 投影同口径）
 *               无图回落 planItems running 项文本
 *  - 用户意图 = 会话标题（D120 LLM 生成）+ 首条用户消息
 *
 * 所有锚点文本都是模型给出的结构化字段，本组件只渲染不造词（设计硬约束）。
 *
 * v0.42.0 P5（对标 ZCode）：整宽卡片 → **一行式胶囊** —— 胶囊文本优先显示
 * 「正在做」（ZCode 顶部胶囊即当前活动项），运行中带呼吸点；点击展开后仍呈现
 * 三行 LLM 产物（核心任务 / 正在做 / 用户意图），信息零丢失。不进过程组。
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '../../store'
import { useGraph } from '../graph/useGraph'
import { focusNodeLabel, pickFocusNode, planRunningText, userIntentText } from '../../flow/task-anchor'
import { Icon } from '../../icons'

export function TaskAnchor({ taskId }: { taskId: string }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
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

  // 胶囊文本：优先「正在做」（ZCode 顶部胶囊 = 当前活动项），回落任务标题
  const capsuleText = (isRunning && doing) || task?.title || t('taskAnchor.title')

  return (
    <div data-testid="task-anchor">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-fill-secondary py-1 pl-2.5 pr-2 text-left text-xs transition-colors hover:bg-bg-hover"
      >
        {isRunning && <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent breathe" />}
        <span className="min-w-0 truncate text-text-secondary">{capsuleText}</span>
        {expanded ? <Icon.ChevronDown width={12} height={12} className="shrink-0 text-text-tertiary" /> : <Icon.ChevronRight width={12} height={12} className="shrink-0 text-text-tertiary" />}
      </button>
      {expanded && (
        <div className="mt-1.5 space-y-1">
          {rows.map((row) => (
            <div key={row.key} className="flex min-w-0 items-baseline gap-2 text-xs leading-5">
              {/* v0.42.0：标签 chip 化 + live 行呼吸点（WorkBuddy 卡片处理） */}
              <span className="flex shrink-0 items-center gap-1">
                {row.live && <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent breathe" />}
                <span
                  className={
                    row.live
                      ? 'rounded bg-accent-soft px-1 py-px text-2xs leading-none text-accent'
                      : 'rounded bg-fill-secondary px-1 py-px text-2xs leading-none text-text-tertiary'
                  }
                >
                  {row.label}
                </span>
              </span>
              <span className="min-w-0 flex-1 break-words text-text-primary">{row.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
