/**
 * ArkWork — 任务面板 · 节点行（NodeRow）
 *
 * 依据：docs/versions/v0.30.0/03-interaction.md §P1「元素清单 / 节点行」
 *       prototype/page-01-task-panel.html（已冻结的视觉基准）
 *
 * 行内信息密度（默认折叠态）：`[状态图标] [T-03] 标题 [进度] [耗时] [token]`
 *
 * ★ 两条硬性规则在这里落实（不允许在别处再判断一次）：
 *   1. **needs_human 是面板最高视觉优先级** —— 唯一红主色 / 唯一角标 / 唯一 600 字重。
 *   2. **`verifying` 的图标旋转、`in_progress` 的脉冲** 由状态元数据驱动，
 *      不在这里写 if —— 保证与 Evidence 抽屉、DAG 视图的口径完全一致。
 */
import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../../icons'
import { Tooltip } from '../ui'
import type { GraphRow } from '@shared/types/ipc'
import { LAYER_LABEL, formatDuration, formatTokens, statusMeta } from './graphMeta'

export interface NodeRowProps {
  row: GraphRow
  /** 是否展开（由面板持有一个 Set） */
  expanded: boolean
  /** 是否是当前选中行 */
  selected: boolean
  /** 是否已完成子树被折叠成摘要行 */
  summary: boolean
  /** 点击整行 */
  onSelect: () => void
  /** 点击折叠箭头 */
  onToggle: () => void
  /** 打开 Evidence / 详情 */
  onOpenDetail: () => void
  /** 行内「⋯」菜单（由面板渲染菜单本体） */
  onMenu: (anchor: { x: number; y: number }) => void
}

function NodeRowImpl({
  row,
  expanded,
  selected,
  summary,
  onSelect,
  onToggle,
  onOpenDetail,
  onMenu,
}: NodeRowProps) {
  const { t } = useTranslation()
  const m = statusMeta(row.status)
  // 缩进步长 14px/层；超过 4 层封顶（更深的层级关系改由层徽章表达）
  const indent = Math.min(row.depth, 4) * 14
  const interactiveChildren = row.hasChildren && !summary

  /** 折叠摘要行：`T-02 ✓ 3 个子任务 · 8.2k · 2m` */
  const summaryText =
    summary && row.doneChildCount > 0
      ? `${statusMeta('completed').glyph} ${t('taskPanel.subtasks', { count: row.doneChildCount })}${
          row.tokensUsed ? ` · ${formatTokens(row.tokensUsed)}` : ''
        }`
      : null

  return (
    <div
      role="treeitem"
      aria-selected={selected}
      aria-label={`${row.key ?? row.id} ${row.title} ${t(`taskPanel.status.${row.status}` as never)}`}
      tabIndex={0}
      onClick={onSelect}
      onDoubleClick={onOpenDetail}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpenDetail()
        if (e.key === ' ') {
          e.preventDefault()
          if (interactiveChildren) onToggle()
        }
      }}
      className={[
        'group relative flex h-7 items-center gap-2 rounded-sm pr-2 text-base leading-5 cursor-pointer',
        'transition-colors duration-100',
        selected ? 'bg-bg-surface-3' : 'hover:bg-bg-surface-2',
        m.bg,
        m.weight,
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ paddingLeft: 4 + indent }}
    >
      {/* 左侧竖条（in_progress / verifying / needs_human / failed） */}
      {m.bar && <span className={`absolute left-0 top-1 bottom-1 w-0.5 rounded-full ${m.bar}`} aria-hidden />}

      {/* 折叠箭头 */}
      {interactiveChildren ? (
        <button
          type="button"
          aria-label={expanded ? t('taskPanel.collapse') : t('taskPanel.expand')}
          onClick={(e) => {
            e.stopPropagation()
            onToggle()
          }}
          className="w-3 shrink-0 text-text-tertiary hover:text-text-primary"
        >
          {expanded ? '▾' : '▸'}
        </button>
      ) : (
        <span className="w-3 shrink-0" aria-hidden />
      )}

      {/* 状态图标 */}
      <span
        className={`w-4 shrink-0 text-center text-xs ${m.text} ${
          m.animate === 'pulse' ? 'animate-pulse' : m.animate === 'spin' ? 'inline-block animate-spin' : ''
        }`}
        aria-hidden
      >
        {m.glyph}
      </span>

      {/* key + 标题 */}
      {row.key && <span className="shrink-0 font-mono text-xs text-text-tertiary">{row.key}</span>}
      <span
        className={[
          'min-w-0 truncate',
          summary ? 'text-text-secondary' : '',
          row.layer === 'goal' ? 'text-xl font-semibold' : row.layer === 'milestone' ? 'font-medium' : '',
          row.status === 'completed' && !summary ? 'text-text-secondary' : '',
          row.status === 'cancelled' ? 'text-text-tertiary line-through' : '',
          row.status === 'blocked' ? 'text-text-tertiary' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        title={row.title}
      >
        {row.title}
      </span>

      {/* 折叠摘要（子任务数 / token / 耗时） */}
      {summaryText && <span className="shrink-0 text-xs text-text-tertiary">{summaryText}</span>}

      {/* 元信息区（窄面板下由面板层控制隐藏） */}
      <span className="ml-auto flex shrink-0 items-center gap-2 text-2xs tabular-nums text-text-tertiary">
        {/* needs_human 的未读角标 —— 全面板唯一的角标 */}
        {!!row.pendingQuestions && (
          <span className="inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-danger px-1 font-semibold text-white">
            {row.pendingQuestions}
          </span>
        )}
        {/* 等待时长（needs_human） */}
        {row.status === 'needs_human' && row.waitingMs !== undefined && (
          <span className="text-warning">{t('taskPanel.waiting', { time: formatDuration(row.waitingMs) })}</span>
        )}
        {/* 正在验证的命令 */}
        {!!row.runningCommand && (
          <span className="max-w-[9rem] truncate font-mono text-warning" title={row.runningCommand}>
            {row.runningCommand}
          </span>
        )}
        {/* 被依赖阻塞 */}
        {!!row.blockedBy?.length && (
          <Tooltip label={t('taskPanel.blockedByTip')}>
            <span className="rounded-sm border border-border-default px-1 leading-[14px]">
              {t('taskPanel.blockedBy', { keys: row.blockedBy.join(', ') })}
            </span>
          </Tooltip>
        )}
        {/* 失败尝试 */}
        {!!row.attemptsLabel && <span className="text-danger">{row.attemptsLabel}</span>}
        {/* 进度 token / 耗时 */}
        {!summary && !!row.tokensUsed && <span>{formatTokens(row.tokensUsed)}</span>}
        {/* 层徽章 */}
        {row.layer !== 'goal' && (
          <span className="rounded-sm border border-border-default px-1 text-[9px] leading-[14px]">
            {LAYER_LABEL[row.layer]}
          </span>
        )}
      </span>

      {/* 行内操作菜单 */}
      <button
        type="button"
        aria-label={t('taskPanel.rowMenu')}
        onClick={(e) => {
          e.stopPropagation()
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
          onMenu({ x: r.left, y: r.bottom + 4 })
        }}
        className="ml-1 hidden h-5 w-5 shrink-0 items-center justify-center rounded-sm text-text-tertiary hover:bg-bg-surface-3 hover:text-text-primary group-hover:flex"
      >
        <Icon.Settings width={12} height={12} />
      </button>
    </div>
  )
}

export const NodeRow = memo(NodeRowImpl)
