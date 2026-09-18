/* ============================================================
 * ArkWork — ProcessFold（v0.32.0 进程折叠条）
 * 设计文档：docs/versions/v0.32.0/03-interaction.md §二 / §三
 *           docs/versions/v0.32.0/04-system-design.md §1.3–1.6
 *
 * 职责：把一段连续的思考 / 工具块收成**一行可判断的摘要**。主展示区只留
 * 「要做的事」（计划 / 叙述）与「结论」（答复 / 审批 / 错误），过程收进折叠条。
 *
 * 四条硬约束：
 *  ① **摘要必须有信息量**（TraeWork 官方论坛投诉的正向修复）——
 *     工具条按类别分列计数（已读取 3 个文件，搜索 2 次），思考条带来源与时长；
 *     禁止「已调用 N 次」式空壳。
 *  ② **展开态存 store**（`flow.blockUiState[run.id].userOpen`）而非组件
 *     useState —— 虚拟化（P2）后组件会频繁挂载/卸载，组件态会丢。
 *  ③ **异常不静默**：含 failed / guarded 时改语义色，且 standard 及以上自动展开。
 *  ④ **展开体复用既有渲染**：工具块走 BlockRenderer → ToolBlock；
 *     思考块走 ReasoningBlock 且 `forceOpen` 去掉内层头行（避免双重头）。
 * ============================================================ */
import { useTranslation } from 'react-i18next'
import { useStore } from '../../store'
import { EMPTY_REASON_KEY, reasoningSourceKey } from '@shared/utils/reasoning'
import {
  TOOL_FOLD_I18N_KEY,
  countToolRun,
  resolveFoldOpen,
  toolCountTotal,
  toolRunParts,
} from '@shared/utils/flow-fold'
import type { FlowFoldRun } from '@shared/types/flow'
import { BlockRenderer } from './BlockRenderer'
import { ReasoningBlock } from './blocks'

/** 毫秒 → 保留一位小数的秒（与 thought.summary.thoughtTime 口径一致） */
const fmtSec = (ms: number) => Math.round(ms / 100) / 10

export function ProcessFold({ run }: { run: FlowFoldRun }) {
  const { t } = useTranslation()
  const viewMode = useStore((s) => s.flow.viewMode)
  const showThinking = useStore((s) => s.flow.showThinking)
  const uiState = useStore((s) => s.flow.blockUiState[run.id])
  const setBlockOpen = useStore((s) => s.setBlockOpen)

  // showThinking 关闭时思考 run **不渲染**（而非折叠占位）—— 03 §2.2
  if (run.scope === 'reasoning' && !showThinking) return null

  const reasoningBlocks = run.blocks.filter(
    (b): b is Extract<typeof b, { kind: 'reasoning' }> => b.kind === 'reasoning',
  )
  const emptyReason =
    run.scope === 'reasoning' && reasoningBlocks.every((b) => !b.text.trim())

  // ---- 摘要文案（唯一数据源 = flow-fold 的纯函数）----
  const counts = countToolRun(run.blocks)
  const parts = toolRunParts(counts)
  const total = toolCountTotal(counts)
  const label =
    run.scope === 'tool'
      ? parts.length > 0
        ? parts.map((p) => t(TOOL_FOLD_I18N_KEY[p.kind], { n: p.count })).join(t('flow.fold.sep'))
        : `${t('flow.fold.tools')} × ${total}`
      : t('flow.fold.thinking')

  const failedReason = reasoningBlocks.some((b) => b.status === 'failed')
  const placeholder = emptyReason
    ? t(`thought.${EMPTY_REASON_KEY[failedReason ? 'failed' : 'noChannel']}`)
    : ''
  const sourceLabel =
    run.scope === 'reasoning' && reasoningBlocks.length > 0
      ? t(`thought.${reasoningSourceKey(reasoningBlocks[0].source)}`)
      : ''

  const state = run.hasFailure ? 'failed' : run.hasRunning ? 'running' : 'settled'
  const ariaName = run.scope === 'tool' ? t('flow.fold.tools') : t('flow.fold.thinking')

  // ---- 空思考：静态行（点了也没内容），不渲染箭头、不作为按钮 ----
  if (emptyReason) {
    return (
      <div className="flow-fold flow-fold--static" data-state={state} data-scope={run.scope}>
        <span className="flow-fold__label">{label}</span>
        <span className="flow-fold__placeholder">{placeholder}</span>
        {run.hasRunning && <span className="flow-fold__running">{t('flow.fold.running')}</span>}
        <span className="flex-1" />
        {run.durationMs > 0 && <span className="flow-fold__duration">{fmtSec(run.durationMs)}s</span>}
      </div>
    )
  }

  // 展开态三态语义（与投影层 blockOpenOf 同口径，见 flow-fold 的 D33 说明）：
  //   userOpen === null → 用户没碰过 → 走当前 viewMode 的默认策略
  //   userOpen !== null → 用户碰过 → 以 store 的应用态 open 为准
  const open = resolveFoldOpen({
    open: uiState?.open ?? false,
    userOpen: uiState?.userOpen ?? null,
    viewMode,
    hasFailure: run.hasFailure,
  })

  return (
    <div className="flow-fold" data-state={state} data-scope={run.scope}>
      <button
        type="button"
        className="flow-fold__head select-none"
        aria-expanded={open}
        aria-label={
          open
            ? t('flow.fold.collapseAria', { name: ariaName })
            : t('flow.fold.expandAria', { name: ariaName })
        }
        onClick={() => setBlockOpen(run.id, !open)}
      >
        <svg
          className={`flow-fold__chevron ${open ? 'is-open' : ''}`}
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden
        >
          <path
            d="M6 4l4 4-4 4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="flow-fold__label">{label}</span>
        {sourceLabel && <span className="flow-fold__meta">{sourceLabel}</span>}
        {run.hasRunning && <span className="flow-fold__running">{t('flow.fold.running')}</span>}
        <span className="flex-1" />
        {run.durationMs > 0 && <span className="flow-fold__duration">{fmtSec(run.durationMs)}s</span>}
      </button>
      {open && (
        <div className="flow-fold__body">
          {run.blocks.map((b) =>
            b.kind === 'reasoning' ? (
              <ReasoningBlock key={b.id} block={b} forceOpen />
            ) : (
              <BlockRenderer key={b.id} block={b} />
            ),
          )}
        </div>
      )}
    </div>
  )
}
