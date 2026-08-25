/* ============================================================
 * ArkWork — CenterStage (v0.14.0)
 * 中栏：路由 modulePage → 模块页，否则渲染任务对话
 * - v0.14.0 Task 4：移除 TaskHeader 下方常驻 PlanBar，
 *   计划项改为在 ConversationFlow 内 PlanMessage 卡片展示，与右侧 TodoPanel 共用
 *   store 导出的 derivePlanItems 派生结果。
 * - 任务模式下 Inspector 在右栏（由 App 控制）
 * - 无任务 + 无模块页 → ConversationGreeting
 *
 * 设计文档：docs/versions/v0.14.0/01-information-architecture.md §5
 * ============================================================ */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../icons'
import { useStore, derivePlanItems } from '../store'
import { Tooltip } from './ui'
import { Composer } from './Composer'
import { ConversationFlow } from './ConversationFlow'
import { ModulePage } from './ModulePage'
import { BugfixIsland } from './dock/BugfixIsland'
import { STATUS_COLOR, STATUS_CHAR, STATUS_LABEL } from '../constants'
import { formatUpdatedAt } from '../types'
import type { TaskStatus } from '@shared/types/task'

export function CenterStage() {
  const tasks = useStore((s) => s.tasks)
  const selectedTaskId = useStore((s) => s.selectedTaskId)
  const conversation = useStore((s) => s.conversation)
  const modulePage = useStore((s) => s.modulePage)
  const steps = useStore((s) => s.steps)
  const task = tasks.find((t) => t.id === selectedTaskId)

  // v0.9.0 F900 §3.2：模块页模式 → 整页切换
  if (modulePage) {
    return <ModulePage page={modulePage} />
  }

  if (!task) {
    return <ConversationGreeting />
  }

  // v0.14.0 Task 4：派生真实计划项数（与对话 PlanMessage / TodoPanel 同源）
  const planItems = derivePlanItems(steps)
  const stepCount = planItems.length

  // v0.4.0-rev1 + polish-workspace-task-title-skills-context-help §Task 2:
  // 新任务刚创建时尚未发消息，沿用 ConversationFlow 但仅显示任务头 + Composer；
  // 不再渲染 GreetingContent(场景示例卡 / 快捷键提示)，保持工作区简洁。
  const isEmptyConversation =
    conversation.length === 0 &&
    task.input.text === '' &&
    task.status !== 'running'

  if (isEmptyConversation) {
    return (
      <div className="flex-1 flex flex-col min-w-0 min-h-0 relative bg-bg-base overflow-hidden">
        <TaskHeader task={task} stepCount={stepCount} />
        <BugfixIsland />
        <ConversationFlow items={conversation} />
        <Composer />
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0 relative bg-bg-base overflow-hidden">
      <TaskHeader task={task} stepCount={stepCount} />
      {/* v0.14.0 Task 4：PlanBar 已移除 — 计划作为 PlanMessage 卡片内嵌于对话流 */}
      {/* v0.14.0 Task 11：bugfix 操作岛台 — 订阅 bugfix:progress 实时刷新 */}
      <BugfixIsland />
      <ConversationFlow items={conversation} />
      <Composer />
    </div>
  )
}

/* ============================================================
 * TaskHeader — v0.13.0 任务头（56px）
 * 顶部：状态点 + 标题 + shortId + ⋯ 菜单 + 元数据行
 * ============================================================ */
function TaskHeader({
  task,
  stepCount,
}: {
  task: ReturnType<typeof useStore.getState>['tasks'][number]
  stepCount: number
}) {
  const cancelTask = useStore((s) => s.cancelTask)
  const pauseTask = useStore((s) => s.pauseTask)
  const resumeTask = useStore((s) => s.resumeTask)
  const deleteTask = useStore((s) => s.deleteTask)
  const toggleStar = useStore((s) => s.toggleStar)
  const renameTask = useStore((s) => s.renameTask)
  const confirm = useStore((s) => s.confirm)
  const { t } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [titleDraft, setTitleDraft] = useState(task.title)
  const statusColor = STATUS_COLOR[task.status as TaskStatus] ?? '#666B75'
  const statusChar = STATUS_CHAR[task.status as TaskStatus] ?? '•'

  // polish-workspace-task-title-skills-context-help §Task 5.3：模型显示已收敛到 Composer 唯一入口，
  // TaskHeader 不再查询 selectedModelId / models / modelHealth。
  const exportConversation = () => {
    useStore.getState().exportConversation()
  }

  const commitRename = () => {
    const next = titleDraft.trim()
    if (next && next !== task.title) {
      void renameTask(task.id, next)
    } else {
      setTitleDraft(task.title)
    }
    setRenaming(false)
  }

  return (
    <div className="task-header" id="task-header">
      <div className="task-header__title-row">
        <span
          className={`inline-flex items-center justify-center w-2 h-2 rounded-full flex-shrink-0 ${
            task.status === 'running' ? 'pulse-dot' : ''
          }`}
          style={{ background: statusColor }}
        />
        {renaming ? (
          <input
            autoFocus
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitRename() }
              if (e.key === 'Escape') { setTitleDraft(task.title); setRenaming(false) }
            }}
            className="flex-1 min-w-0 text-base text-text-primary bg-bg-input border border-accent rounded px-1.5 py-0.5 outline-none"
          />
        ) : (
          <Tooltip label={t('centerstage.header.renameTooltip')} desc={t('centerstage.header.renameTooltipDesc')}>
            <span
              className="task-header__title"
              onDoubleClick={() => { setTitleDraft(task.title); setRenaming(true) }}
            >
              {task.title}
            </span>
          </Tooltip>
        )}

        {/* v0.13.0：状态徽章 */}
        <span
          className="inline-flex items-center gap-1 px-1.5 h-5 rounded-md text-2xs font-medium flex-shrink-0"
          style={{ color: statusColor, background: `color-mix(in srgb, ${statusColor} 12%, transparent)` }}
        >
          {statusChar} {STATUS_LABEL[task.status as TaskStatus] ?? task.status}
        </span>

        {/* 模型 chip 已下线（polish-workspace-task-title-skills-context-help §Task 5.3），
            大模型仅在 Composer 唯一展示。 */}

        {/* ⋯ 菜单 */}
        <div className="relative flex-shrink-0">
          <Tooltip label={t('centerstage.header.more')} desc={t('centerstage.header.moreDesc')} delay={150}>
            <button
              onClick={() => setMenuOpen((v) => !v)}
              aria-label={t('centerstage.header.more')}
              className="h-7 w-7 flex items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-colors focus-ring"
            >
              <Icon.ChevronDown width={16} height={16} />
            </button>
          </Tooltip>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 top-full mt-1 w-40 py-1 bg-bg-overlay border border-border-subtle rounded-md shadow-panel scale-in z-30">
                <MenuItem
                  label={task.starred ? t('centerstage.header.unstar') : t('centerstage.header.star')}
                  onClick={() => { setMenuOpen(false); void toggleStar(task.id) }}
                />
                <MenuItem
                  label={t('centerstage.header.rename')}
                  onClick={() => { setMenuOpen(false); setTitleDraft(task.title); setRenaming(true) }}
                />
                <MenuItem
                  label={t('centerstage.header.export')}
                  onClick={() => { setMenuOpen(false); exportConversation() }}
                />
                {task.status === 'running' && (
                  <MenuItem
                    label={t('centerstage.header.pause')}
                    onClick={() => { setMenuOpen(false); void pauseTask(task.id) }}
                  />
                )}
                {task.status === 'paused' && (
                  <MenuItem
                    label={t('centerstage.header.resume')}
                    onClick={() => { setMenuOpen(false); void resumeTask(task.id) }}
                  />
                )}
                {task.status === 'running' && (
                  <MenuItem
                    label={t('centerstage.header.stop')}
                    onClick={() => { setMenuOpen(false); void cancelTask(task.id) }}
                  />
                )}
                <div className="my-1 border-t border-border-subtle" />
                <MenuItem
                  label={t('centerstage.header.delete')}
                  danger
                  onClick={() => {
                    setMenuOpen(false)
                    void confirm({
                      title: t('centerstage.header.delete'),
                      body: t('centerstage.header.deleteBody', { title: task.title }),
                      confirmLabel: t('centerstage.header.deleteConfirm'),
                      danger: true,
                    }).then((ok) => {
                      if (ok) {
                        if (task.status === 'running') void cancelTask(task.id).then(() => deleteTask(task.id))
                        else void deleteTask(task.id)
                      }
                    })
                  }}
                />
              </div>
            </>
          )}
        </div>
      </div>

      {/* 元数据行 — KB · Steps · Runtime · ⌘↵ Run（polish-workspace-task-title-skills-context-help §Task 5.3：
          Model 字段已移除，模型仅在 Composer 唯一展示） */}
      <div className="task-header__meta">
        <span className="tabular">{(task.kbIds ?? []).length || 0} KB</span>
        <span>·</span>
        <span className="tabular">{stepCount} steps</span>
        <span>·</span>
        <span className="tabular flex items-center gap-1">
          <Icon.Clock width={11} height={11} className="text-text-tertiary" aria-hidden="true" />
          {formatUpdatedAt(task.updatedAt)}
        </span>
        <span>·</span>
        <span>
          <kbd className="font-mono text-2xs px-1 py-0.5 rounded border border-border-subtle bg-bg-surface">⌘↵</kbd>{' '}
          Run
        </span>
      </div>
    </div>
  )
}

/* ============================================================
 * PlanBar — v0.14.0 Task 4 已下线
 * 原紧贴 TaskHeader 下方的常驻 PlanBar 已移除；计划展示改由
 * ConversationFlow 内的 PlanMessage 卡片承担，统一派生源见 store 的
 * derivePlanItems。
 * 旧 reconcilePlanStatesWithTask / scrollToPlanStep / PlanRowState 等
 * 内部函数一并清理，避免两份实现并存导致状态不同步。
 * ============================================================ */

function MenuItem({
  label,
  onClick,
  danger,
}: {
  label: string
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2 text-sm transition-colors ${
        danger ? 'text-danger hover:bg-danger-soft' : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
      }`}
    >
      {label}
    </button>
  )
}

/* ============================================================
 * ConversationGreeting — 工作区空态(polish-workspace-task-title-skills-context-help §Task 2.2)
 * 仅展示工作区标识 + 一句短引导，移除场景卡与快捷键提示。
 * ============================================================ */
function ConversationGreeting() {
  const workspaces = useStore((s) => s.workspaces)
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const ws = workspaces.find((w) => w.id === activeWorkspaceId) ?? workspaces[0]
  return (
    <div className="flex-1 flex flex-col min-w-0 bg-bg-base">
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-12">
        <WorkspaceOnlyHint name={ws?.name} />
      </div>
      <Composer />
    </div>
  )
}

/**
 * polish-workspace-task-title-skills-context-help §Task 2.2:
 * 工作区空态仅展示工作区本身 + 一句短引导，不再出现"开始新对话"/场景卡/快捷键提示。
 */
function WorkspaceOnlyHint({ name }: { name?: string }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col items-center gap-3 max-w-[480px] text-center">
      <span className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-bg-surface border border-border-subtle text-accent">
        <Icon.Workspace width={22} height={22} aria-hidden="true" />
      </span>
      <h1 className="text-base font-semibold text-text-primary">
        {name ? t('centerstage.greeting.workspace', { name }) : t('centerstage.greeting.workspaceOnly')}
      </h1>
      <p className="text-xs text-text-tertiary">
        {t('centerstage.greeting.hint')}
      </p>
    </div>
  )
}

