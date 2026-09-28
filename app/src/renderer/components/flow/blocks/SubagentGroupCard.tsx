/* ============================================================
 * ArkWork — SubagentGroupCard（v0.36.0 F4.1，交互原型 P5）
 *
 * 并行子 agent 组卡：delegate-agent 一次委派 N 个子任务时在交互区出现。
 * 数据来源：store.subagentGroups（task:subagent-progress 事件流，live-only）。
 *
 * 形态（对照已冻结原型 page-05-subagent.html）：
 *  - 运行中：外框卡 + 全局进度条 + 子卡片（状态点 / 模型徽标 / 耗时 /
 *    单步摘要 / 取消按钮；失败子卡给「重试该子任务」）
 *  - 全部终态：自动折叠为汇总条；点汇总条可再次展开
 *    —— 完成后长期占据交互区高度是真的会招人烦（v0.34.0 D52 同款教训）
 *
 * 五态映射（原型 statebar）：default=运行中卡组 / loading=排队态 /
 * empty=store 无数据则 project 不产出该块 / error=失败子卡 + 重试 /
 * success=自动折叠汇总。
 *
 * 有意偏离原型一处（已在 evidence/09 登记）：卡头右侧原本展示「父任务标题」，
 * 这里改为展示并发上限 / 总耗时 —— 该卡是纯投影产物，不该反向依赖任务元数据
 * （父任务标题在侧栏与顶栏已可见，卡内重复价值低）。
 * ============================================================ */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FlowBlock } from '@shared/types/flow'
import type { SubagentRunStatus } from '@shared/types/react'
import { useStore } from '../../../store'
import { Icon } from '../../../icons'

type SubagentGroupBlockT = Extract<FlowBlock, { kind: 'subagent-group' }>

/** 状态点颜色（对照原型 .sd-* 五态；running 带呼吸） */
const DOT_CLS: Record<SubagentRunStatus, string> = {
  queued: 'bg-text-tertiary',
  running: 'bg-accent animate-pulse',
  done: 'bg-success',
  failed: 'bg-danger',
  cancelled: 'bg-border-strong',
}

/** 非终态（未到达 done/failed/cancelled） */
function isLive(status: SubagentRunStatus): boolean {
  return status === 'queued' || status === 'running'
}

/** 毫秒 → mm:ss（原型 --:-- 口径；无耗时给占位） */
function fmtClock(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '--:--'
  const total = Math.floor(ms / 1000)
  const mm = String(Math.floor(total / 60)).padStart(2, '0')
  const ss = String(total % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

export function SubagentGroupCard({ block }: { block: SubagentGroupBlockT }) {
  const { t } = useTranslation()
  const cancelSubagent = useStore((s) => s.cancelSubagent)
  const retrySubagent = useStore((s) => s.retrySubagent)
  /**
   * 展开态：null = 跟随 settled（运行中展开 / 终态折叠）；
   * 布尔 = 用户显式选择（点卡头切换后固定，不再被 settled 翻转）。
   */
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const [openRow, setOpenRow] = useState<string | null>(null)
  const expanded = userOpen ?? !block.settled

  const total = block.children.length
  const finished = block.children.filter((c) => !isLive(c.status)).length
  const failed = block.children.filter((c) => c.status === 'failed').length
  // 全局进度：终态占比（排队与运行都算未完成）
  const pct = total > 0 ? Math.round((finished / total) * 100) : 0
  // 墙钟耗时：并行执行下取最大子任务耗时 —— 求和会把并行度算成串行，是假数据
  const wallMs = block.children.reduce<number | undefined>(
    (max, c) => (c.durationMs === undefined ? max : Math.max(max ?? 0, c.durationMs)),
    undefined,
  )

  return (
    <div className="rounded-lg border border-border-default bg-bg-surface overflow-hidden select-text">
      {/* ---------- 卡头（运行中=标题条；终态=汇总条） ---------- */}
      <button
        type="button"
        data-testid="subagent-group-head"
        onClick={() => setUserOpen(!expanded)}
        className="w-full flex items-center gap-2 px-3.5 py-2.5 text-left hover:bg-bg-hover transition-colors"
      >
        <span
          className={`text-xs font-medium ${block.settled && failed === 0 ? 'text-success' : 'text-text-primary'}`}
        >
          {t('conversationflow.subagent.title', { count: total })}
        </span>
        <span className="text-2xs text-text-tertiary">
          {block.settled
            ? failed > 0
              ? t('conversationflow.subagent.settledWithFailures', { failed, total })
              : t('conversationflow.subagent.settledAll')
            : t('conversationflow.subagent.progress', { finished, total })}
        </span>
        <span className="flex-1" />
        <span className="text-2xs text-text-tertiary font-mono shrink-0">
          {block.settled ? fmtClock(wallMs) : t('conversationflow.subagent.concurrencyCap')}
        </span>
        {expanded ? (
          <Icon.ChevronDown className="shrink-0 text-text-tertiary" />
        ) : (
          <Icon.ChevronRight className="shrink-0 text-text-tertiary" />
        )}
      </button>

      {/* ---------- 全局进度条（原型 .progress；终态转绿 / 有失败转红） ---------- */}
      <div className="h-1 bg-bg-surface-2 relative">
        <i
          className={`absolute left-0 top-0 bottom-0 transition-all duration-300 ${
            block.settled ? (failed > 0 ? 'bg-danger' : 'bg-success') : 'bg-accent'
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* ---------- 展开体：子卡片 ---------- */}
      {expanded && (
        <div className="p-2 space-y-2">
          {block.children.map((c) => {
            const live = isLive(c.status)
            return (
              <div
                key={c.childTaskId}
                data-testid="subagent-card"
                data-status={c.status}
                className={`rounded-md border px-3 py-2 bg-bg-base ${
                  c.status === 'done'
                    ? 'border-success'
                    : c.status === 'failed'
                      ? 'border-danger'
                      : 'border-border-default'
                } ${c.status === 'cancelled' ? 'opacity-55' : ''}`}
              >
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${DOT_CLS[c.status]}`} />
                  <span className="text-xs font-medium text-text-primary truncate">@{c.agentName}</span>
                  {c.modelId && (
                    <span className="text-2xs font-mono text-info bg-info-soft border border-info rounded-full px-2 leading-4 shrink-0">
                      {c.modelId}
                    </span>
                  )}
                  <span className="flex-1" />
                  <span className="text-2xs text-text-tertiary font-mono shrink-0">{fmtClock(c.durationMs)}</span>
                </div>

                {/* 单步摘要：运行中给最新一步，终态给终态摘要（数据源同一字段） */}
                <div className="mt-1.5 text-xs text-text-secondary leading-5 break-words">
                  {c.stepSummary ?? (live ? t('conversationflow.subagent.waiting') : c.objective)}
                </div>

                <div className="flex items-center gap-2 mt-1.5">
                  {live && (
                    <button
                      type="button"
                      data-testid="subagent-cancel"
                      onClick={() => void cancelSubagent(c.childTaskId)}
                      className="text-2xs px-2 py-0.5 rounded border border-border-default text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
                    >
                      <Icon.X className="inline-block align-[-2px] mr-1" />
                      {t('conversationflow.subagent.cancel')}
                    </button>
                  )}
                  {c.status === 'failed' && (
                    <button
                      type="button"
                      data-testid="subagent-retry"
                      onClick={() =>
                        void retrySubagent({
                          parentTaskId: block.parentTaskId,
                          agentId: c.agentId,
                          objective: c.objective,
                        })
                      }
                      className="text-2xs px-2 py-0.5 rounded border border-border-default text-accent hover:bg-bg-hover transition-colors"
                    >
                      <Icon.RotateCcw className="inline-block align-[-2px] mr-1" />
                      {t('conversationflow.subagent.retry')}
                    </button>
                  )}
                  <span className="text-2xs text-text-tertiary">
                    {t(`conversationflow.subagent.status.${c.status}`)}
                  </span>
                  {/* 完整委派目标（一行摘要之外的原始意图） */}
                  {c.stepSummary && c.objective && (
                    <button
                      type="button"
                      onClick={() => setOpenRow(openRow === c.childTaskId ? null : c.childTaskId)}
                      className="text-2xs text-text-tertiary hover:text-text-primary transition-colors ml-auto"
                    >
                      {openRow === c.childTaskId
                        ? t('conversationflow.subagent.collapse')
                        : t('conversationflow.subagent.expand')}
                    </button>
                  )}
                </div>

                {openRow === c.childTaskId && c.objective && (
                  <div className="mt-1.5 text-2xs text-text-tertiary border-t border-border-subtle pt-1.5 whitespace-pre-wrap break-words">
                    {c.objective}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
