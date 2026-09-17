/* ============================================================
 * ArkWork — Dock/ProgressPanel (Task 9)
 * 任务侧边栏进度摘要（任务上下文 Dock Tab 之一）
 *
 * 数据源：store.taskProgress[taskId]（按 taskId 索引的独立 store），
 * 由 Main 进程推 task:progress / task_step_complete / task_milestone
 * 三类事件回流；本地通过 IPC 持久化到 .arkwork/cache/task-progress.json。
 *
 * UI 组成（自上而下）：
 *   1. 当前阶段（名 + X/N）+ 整体百分比进度条
 *   2. 已完成步骤紧凑列表（最近 16 条；点击可复制 / 后续可挂对话定位）
 *   3. 下一步骤预览（pending/running 时高亮，否则显示"任务完成"）
 *   4. 里程碑列表（已到达的高亮绿色，未到达的灰色；已到达可点击跳产物）
 *
 * 与 React-Core-Skills 阶段 0~8（开源调研→PRD→交互→原型→系统设计→
 * 编码→测试→交付→运维沉淀）严格对齐；非文档驱动任务仍可复用同一
 * 数据结构（步/里程碑自定义），UI 不耦合具体场景。
 * ============================================================ */
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '../../store'
import type { TaskProgress, TaskProgressMilestone, TaskProgressStage, TaskProgressStep } from '@shared/types/progress'
import { isArkworkInternal } from '@shared/utils/paths'
import type { GraphRow, GraphSnapshot } from '@shared/types/ipc'
import { EmptyState, Tooltip } from '../ui'
import { Icon } from '../../icons'
import { statusMeta, formatWaiting } from '../graph/graphMeta'

/* ============================================================
 * v0.30.0：图感知活跃节点（11 态适配）
 *
 * 依据：docs/versions/v0.30.0/00-release-goal.md「ProgressPanel 适配 11 态」
 * 语义边界：本面板的**阶段 / 里程碑 / 进度百分比展示不变**（既有约定）；
 * 仅把「下一步预览」区升级为图感知 —— 当所选任务有 TaskGraph 时，
 * 按 needs_human > verifying > in_progress > blocked 的优先级展示活跃节点。
 *
 * 为什么独立订阅而不复用 useGraph：本面板只需要轻量快照（不含图本体与
 * 待决补丁），且与 TaskPanel 分属不同 Dock 页签，生命周期不同。
 * ============================================================ */

/** 订阅当前任务的图快照（无图 / 轻量模式 / 损坏时返回 null，本面板不承担降级展示） */
function useGraphSnapshot(taskId: string | null): GraphSnapshot | null {
  const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null)

  useEffect(() => {
    if (!taskId) {
      setSnapshot(null)
      return
    }
    let alive = true
    const load = async (): Promise<void> => {
      try {
        const res = await window.ark.graph.snapshot(taskId)
        if (!alive) return
        setSnapshot(res.ok && res.data && !res.data.lightweight ? res.data : null)
      } catch {
        if (alive) setSnapshot(null) // 快照失败不阻塞既有进度展示
      }
    }
    void load()
    // graph:update 载荷含 taskId；只响应当前任务，避免多任务串台
    const off = window.ark.graph.onUpdate((payload) => {
      if (payload.taskId === taskId) void load()
    })
    return () => {
      alive = false
      off()
    }
  }, [taskId])

  return snapshot
}

/**
 * 从图快照提取活跃节点行（按视觉优先级排序）。
 * 11 态中只有这四种是"进行中"语义；terminal 态（completed/cancelled/failed）
 * 与排队态（draft/proposed/approved/ready）不进入本区 —— 面板底部已有计数与里程碑表达。
 */
function activeGraphRows(snapshot: GraphSnapshot | null): GraphRow[] {
  if (!snapshot) return []
  const order: Record<string, number> = { needs_human: 0, verifying: 1, in_progress: 2, blocked: 3 }
  return snapshot.rows
    .filter((r) => order[r.status] !== undefined)
    .sort((a, b) => order[a.status] - order[b.status])
}

/** 图感知活跃节点行（视觉映射复用 graphMeta —— 状态颜色的唯一映射点） */
function GraphActiveRow({ row }: { row: GraphRow }) {
  const m = statusMeta(row.status)
  return (
    <div className={`flex items-center gap-1.5 rounded px-1.5 py-1 text-xs ${m.bg}`} title={row.title}>
      <span className={`flex-shrink-0 tabular ${m.text}`} aria-hidden>
        {m.glyph}
      </span>
      <span className={`min-w-0 flex-1 truncate ${m.text} ${m.weight}`}>
        {row.key ? `${row.key} ` : ''}
        {row.title}
      </span>
      {row.status === 'verifying' && row.runningCommand && (
        <code className="max-w-[45%] flex-shrink-0 truncate text-2xs text-text-tertiary" title={row.runningCommand}>
          {row.runningCommand}
        </code>
      )}
      {row.status === 'needs_human' && row.waitingMs !== undefined && row.waitingMs > 0 && (
        <span className="flex-shrink-0 text-2xs tabular text-danger">{formatWaiting(row.waitingMs)}</span>
      )}
    </div>
  )
}

/**
 * 初始化空进度（无 taskProgress 记录时展示骨架，与 react-core-skills 阶段对齐）。
 * 注意：这里使用本地组件内 const，不修改 store；store 仅在收到事件后填充。
 */
function makeEmptyProgress(t: (key: string, opts?: Record<string, unknown>) => string, taskId: string): TaskProgress {
  const stages: TaskProgressStage[] = [
    { id: 'research', label: t('dock.progress.stage_research'), index: 0 },
    { id: 'prd', label: t('dock.progress.stage_prd'), index: 1 },
    { id: 'interaction', label: t('dock.progress.stage_interaction'), index: 2 },
    { id: 'prototype', label: t('dock.progress.stage_prototype'), index: 3 },
    { id: 'system-design', label: t('dock.progress.stage_system_design'), index: 4 },
    { id: 'code', label: t('dock.progress.stage_code'), index: 5 },
    { id: 'test', label: t('dock.progress.stage_test'), index: 6 },
    { id: 'delivery', label: t('dock.progress.stage_delivery'), index: 7 },
    { id: 'ops', label: t('dock.progress.stage_ops'), index: 8 },
  ]
  return {
    taskId,
    currentStage: 'research',
    currentStageLabel: t('dock.progress.stage_research'),
    currentStageIndex: 0,
    totalStages: stages.length,
    stages,
    completedSteps: [],
    nextStep: undefined,
    milestones: [
      { id: 'prd-frozen', label: t('dock.progress.milestone_prd') },
      { id: 'prototype-frozen', label: t('dock.progress.milestone_prototype') },
      { id: 'design-frozen', label: t('dock.progress.milestone_design') },
      { id: 'code-done', label: t('dock.progress.milestone_code') },
      { id: 'test-passed', label: t('dock.progress.milestone_test') },
    ],
    overallPercentage: 0,
    updatedAt: 0,
  }
}

/** 阶段节点（用于阶段进度横条） */
function StageNode({
  stage,
  isCurrent,
  isCompleted,
}: {
  stage: TaskProgressStage
  isCurrent: boolean
  isCompleted: boolean
}) {
  const { t } = useTranslation()
  return (
    <Tooltip label={t('dock.progress.stage_tooltip', { index: stage.index + 1, label: stage.label })}>
      <div
        className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-2xs whitespace-nowrap ${
          isCurrent
            ? 'bg-accent-soft text-accent font-medium'
            : isCompleted
              ? 'bg-success-soft text-success'
              : 'bg-bg-elevated text-text-tertiary'
        }`}
      >
        {isCompleted ? (
          <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden>
            <path d="M2 5.2 4.2 7.4 8 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <span className="tabular text-2xs">{stage.index + 1}</span>
        )}
        <span>{stage.label}</span>
      </div>
    </Tooltip>
  )
}

/** 里程碑节点（已到达高亮，可点击跳产物） */
function MilestoneRow({
  milestone,
  onOpenArtifact,
}: {
  milestone: TaskProgressMilestone
  onOpenArtifact: (path: string) => void
}) {
  const { t } = useTranslation()
  const reached = !!milestone.reachedAt
  const clickable = reached && !!milestone.artifactPath
  const handleClick = () => {
    if (clickable && milestone.artifactPath) onOpenArtifact(milestone.artifactPath)
  }
  return (
    <button
      type="button"
      disabled={!clickable}
      onClick={handleClick}
      className={`group flex items-start gap-2 w-full px-2 py-1.5 rounded-md text-left transition-colors ${
        reached
          ? clickable
            ? 'hover:bg-success-soft cursor-pointer'
            : 'cursor-default'
          : 'cursor-default opacity-60'
      }`}
      aria-label={
        reached
          ? clickable
            ? t('dock.progress.milestone_label_open', { label: milestone.label })
            : milestone.label
          : t('dock.progress.milestone_label_not_reached', { label: milestone.label })
      }
    >
      <span
        className={`flex-shrink-0 w-3.5 h-3.5 mt-0.5 rounded-full flex items-center justify-center ${
          reached ? 'bg-success text-white' : 'border border-border-default'
        }`}
      >
        {reached && (
          <svg width="8" height="8" viewBox="0 0 10 10" fill="none" aria-hidden>
            <path d="M2 5.2 4.2 7.4 8 3" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      <span className="flex-1 min-w-0">
        <span
          className={`block text-xs ${
            reached ? 'text-text-primary font-medium' : 'text-text-tertiary'
          }`}
        >
          {milestone.label}
        </span>
        {milestone.description && (
          <span className="block text-2xs text-text-tertiary mt-0.5">{milestone.description}</span>
        )}
      </span>
      {clickable && (
        <Icon.ExternalLink
          width={12}
          height={12}
          className="flex-shrink-0 mt-1 text-text-tertiary group-hover:text-accent transition-colors"
        />
      )}
    </button>
  )
}

/** 已完成步骤行（紧凑 + 完成时间） */
function CompletedStepRow({ step }: { step: TaskProgressStep }) {
  const failed = step.status === 'failed'
  return (
    <div className="flex items-start gap-2 px-2 py-1">
      <span
        className={`flex-shrink-0 w-2.5 h-2.5 mt-1.5 rounded-full ${
          failed ? 'bg-danger' : 'bg-success'
        }`}
      />
      <span className="flex-1 min-w-0">
        <span
          className={`block text-2xs leading-relaxed truncate ${
            failed ? 'text-danger' : 'text-text-secondary'
          }`}
          title={step.label}
        >
          {step.label}
        </span>
      </span>
      {step.completedAt && (
        <span className="text-2xs text-text-tertiary tabular flex-shrink-0">
          {formatStepTime(step.completedAt)}
        </span>
      )}
    </div>
  )
}

/** 时间戳 → HH:MM:SS（紧凑显示） */
function formatStepTime(ts: number): string {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

export function ProgressPanel() {
  const { t } = useTranslation()
  const selectedTaskId = useStore((s) => s.selectedTaskId)
  const taskProgress = useStore((s) => s.taskProgress)
  const openPreview = useStore((s) => s.openPreview)
  const setSelectedFile = useStore((s) => s.setSelectedFile)
  // Task 9：已完成步骤展开/折叠（紧凑列表默认折叠最近 5 条之前）
  const [showAllSteps, setShowAllSteps] = useState(false)
  // v0.30.0：图感知活跃节点（有 TaskGraph 时替代通用「下一步」预览）
  const graphSnapshot = useGraphSnapshot(selectedTaskId)
  const graphRows = useMemo(() => activeGraphRows(graphSnapshot), [graphSnapshot])

  /** 当前任务的进度摘要（无则用骨架占位，避免空态闪烁） */
  const progress = useMemo<TaskProgress | null>(() => {
    if (!selectedTaskId) return null
    return taskProgress[selectedTaskId] ?? makeEmptyProgress(t, selectedTaskId)
  }, [selectedTaskId, taskProgress, t])

  /** 已完成步骤紧凑列表（默认仅展示最近 5 条） */
  const visibleSteps = useMemo(() => {
    if (!progress) return []
    return showAllSteps ? progress.completedSteps : progress.completedSteps.slice(0, 5)
  }, [progress, showAllSteps])

  if (!selectedTaskId) {
    return (
      <EmptyState
        icon={<Icon.ListChecks width={22} height={22} />}
        title={t('dock.progress.no_task')}
        hint={t('dock.progress.no_task_hint')}
      />
    )
  }
  if (!progress) return null

  const reachedMilestones = progress.milestones.filter((m) => !!m.reachedAt).length
  const totalMilestones = progress.milestones.length

  /** 跳产物：`.arkwork` 内部产物走只读 openPreview；工作区产物交 setSelectedFile（→ fsSlice.openDoc） */
  const openArtifact = (path: string) => {
    // v0.31.0 B2：判定改用共享纯函数 —— 原先硬编码 `.arkwork/` 字面量，
    // 对「无尾斜杠的 .arkwork 路径」漏判（`.arkwork` 自身、`x/.arkwork`）。
    // 工作区产物经 setSelectedFile → openDoc，可编辑则直接进编辑器。
    if (isArkworkInternal(path)) {
      void openPreview(path)
    } else {
      void setSelectedFile(path)
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* 头部：当前阶段 + 整体进度 */}
      <div className="px-3 py-2.5 border-b border-border-subtle flex-shrink-0 space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-text-primary truncate">
            {progress.currentStageLabel}
          </span>
          <span className="text-2xs text-text-tertiary tabular flex-shrink-0">
            {progress.currentStageIndex + 1}/{progress.totalStages}
          </span>
          <span className="ml-auto text-2xs text-text-tertiary tabular">
            {progress.overallPercentage}%
          </span>
        </div>
        {/* 整体进度条 */}
        <div className="w-full h-1.5 bg-bg-elevated rounded-full overflow-hidden">
          <div
            className="h-full rounded-full bg-success transition-all duration-500"
            style={{ width: `${Math.max(0, Math.min(100, progress.overallPercentage))}%` }}
          />
        </div>
        {/* 阶段水平节点（紧凑） */}
        <div className="flex flex-wrap gap-1 pt-1">
          {progress.stages.map((stage) => (
            <StageNode
              key={stage.id}
              stage={stage}
              isCurrent={stage.id === progress.currentStage}
              isCompleted={stage.index < progress.currentStageIndex}
            />
          ))}
        </div>
      </div>

      {/* 下一步预览：图感知（有活跃节点时）→ 通用 nextStep（无图 / 全部 terminal） */}
      {graphRows.length > 0 ? (
        <div className="px-2.5 py-2 border-b border-border-subtle flex-shrink-0 space-y-1">
          <div className="text-2xs text-text-tertiary mb-0.5">{t('dock.progress.graph_active')}</div>
          {graphRows.slice(0, 4).map((row) => (
            <GraphActiveRow key={row.id} row={row} />
          ))}
          {graphRows.length > 4 && (
            <div className="text-2xs text-text-tertiary px-1.5">+{graphRows.length - 4}</div>
          )}
        </div>
      ) : progress.nextStep && (
        <div className="px-3 py-2 border-b border-border-subtle bg-accent-soft flex-shrink-0">
          <div className="text-2xs text-text-tertiary mb-0.5">{t('dock.progress.next_step')}</div>
          <div className="flex items-center gap-1.5 text-xs text-text-primary">
            <span className="w-1.5 h-1.5 rounded-full bg-accent pulse-dot flex-shrink-0" />
            <span className="truncate">{progress.nextStep.label}</span>
          </div>
        </div>
      )}

      {/* 已完成步骤（紧凑列表） */}
      <div className="flex-shrink-0 border-b border-border-subtle">
        <div className="flex items-center justify-between px-3 py-1.5">
          <span className="text-2xs text-text-tertiary uppercase tracking-wider">
            {t('dock.progress.completed_steps', { count: progress.completedSteps.length })}
          </span>
          {progress.completedSteps.length > 5 && (
            <button
              onClick={() => setShowAllSteps((v) => !v)}
              className="text-2xs text-text-tertiary hover:text-accent transition-colors"
            >
              {showAllSteps ? t('dock.progress.collapse') : t('dock.progress.expand')}
            </button>
          )}
        </div>
        {progress.completedSteps.length === 0 ? (
          <div className="px-3 pb-2.5 text-2xs text-text-tertiary">{t('dock.progress.no_completed_steps')}</div>
        ) : (
          <div className="pb-1 max-h-40 overflow-y-auto">
            {visibleSteps.map((step) => (
              <CompletedStepRow key={step.id} step={step} />
            ))}
          </div>
        )}
      </div>

      {/* 里程碑（已到达高亮，未到达灰色；已到达可点击跳产物） */}
      <div className="flex-1 min-h-0 overflow-y-auto px-1 py-2">
        <div className="flex items-center justify-between px-2 py-1.5">
          <span className="text-2xs text-text-tertiary uppercase tracking-wider">
            {t('dock.progress.milestones', { reached: reachedMilestones, total: totalMilestones })}
          </span>
          {progress.updatedAt > 0 && (
            <span className="text-2xs text-text-tertiary tabular">
              {formatStepTime(progress.updatedAt)}
            </span>
          )}
        </div>
        <div className="space-y-0.5">
          {progress.milestones.map((m) => (
            <MilestoneRow key={m.id} milestone={m} onOpenArtifact={openArtifact} />
          ))}
        </div>
      </div>
    </div>
  )
}
