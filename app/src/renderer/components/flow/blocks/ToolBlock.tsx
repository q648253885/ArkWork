/* ============================================================
 * ArkWork — ToolBlock（v0.31.0 B4）
 * 工具块。契约：
 *  - 六态状态机（05 §二 T1）：pending/running/success/failed/guarded/cancelled，
 *    guarded（琥珀，Agent 拦截·非错误）与 failed（红）**视觉与语义可区分**（C-16）；
 *  - 视觉层级三重编码（C-13）：形状（卡边框）+ 图标（KindIcon 按呈现类别）+ 色（状态点）；
 *  - 结果摘要默认可见（C-11 零点击），完整结果默认折叠（resultOpen 初始 false，
 *    v018 契约转写）；截断显示上限提示（C-18）；
 *  - 零原生 title（C-20，guarded 说明走 HoverCard）；
 *  - 字号与思考块同级 = text-xs/13px（C-14）。
 * ============================================================ */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FlowBlock, ToolCallKind, ToolStatus } from '@shared/types/flow'
import { ToolCallBody, ToolResultBody, ResultSummaryLine } from '../tools'
import { HoverCard } from '../HoverCard'

type ToolBlockT = Extract<FlowBlock, { kind: 'tool' }>

/**
 * 状态点色 —— v0.31.0 D21「颜色只留给异常」：
 *   落定的成功步骤占交互区绝大多数，若 success 也上绿，满屏绿点即用户所说的
 *   「五彩斑斓」。故 success / pending / cancelled 一律中性，只有
 *   running（在跑）/ failed（失败）/ guarded（拦截）三态上语义色。
 * 状态并未丢失：左状态条 + 状态点 + 说明文字三重编码仍在（C-13 / C-16）。
 */
function dotColor(status: ToolStatus): string {
  switch (status) {
    case 'running':
      return 'var(--business-primary)'
    case 'failed':
      return 'var(--danger)'
    case 'guarded':
      return 'var(--warning)'
    default:
      return 'var(--text-faint)'
  }
}

/**
 * 左侧 2px 状态条（D21）：卡片底色恒定中性，状态色只出现在这一条上。
 * 与状态点同口径 —— 落定态中性，异常态语义色。
 */
function railColor(status: ToolStatus): string {
  switch (status) {
    case 'running':
      return 'var(--business-primary)'
    case 'failed':
      return 'var(--danger)'
    case 'guarded':
      return 'var(--warning)'
    default:
      return 'var(--border-strong)'
  }
}

/** 呈现类别图标（C-13 三重编码之「图标」维；14px 线性） */
function KindIcon({ kind }: { kind?: ToolCallKind }) {
  const common = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none' as const }
  const stroke = { stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  switch (kind) {
    case 'read':
      return (
        <svg {...common} className="shrink-0 text-text-faint">
          <path d="M4 1.5h5.5L12.5 4.5V14.5H4z" {...stroke} />
          <path d="M9.5 1.5v3h3" {...stroke} />
        </svg>
      )
    case 'edit':
      return (
        <svg {...common} className="shrink-0 text-text-faint">
          <path d="M11.5 2l2.5 2.5L6 12.5l-3.5.5.5-3.5z" {...stroke} />
        </svg>
      )
    case 'delete':
      return (
        <svg {...common} className="shrink-0 text-text-faint">
          <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 9h5.8l.6-9" {...stroke} />
        </svg>
      )
    case 'move':
      return (
        <svg {...common} className="shrink-0 text-text-faint">
          <path d="M2 8h12M8 2v12M8 2l-2 2M8 2l2 2M8 14l-2-2M8 14l2-2" {...stroke} />
        </svg>
      )
    case 'search':
      return (
        <svg {...common} className="shrink-0 text-text-faint">
          <circle cx="7" cy="7" r="4.5" {...stroke} />
          <path d="M10.5 10.5L14 14" {...stroke} />
        </svg>
      )
    case 'execute':
      return (
        <svg {...common} className="shrink-0 text-text-faint">
          <path d="M2.5 4l4 4-4 4M8 12.5h5.5" {...stroke} />
        </svg>
      )
    case 'fetch':
      return (
        <svg {...common} className="shrink-0 text-text-faint">
          <circle cx="8" cy="8" r="6" {...stroke} />
          <path d="M2 8h12M8 2c-2.5 2.2-2.5 9.8 0 12M8 2c2.5 2.2 2.5 9.8 0 12" {...stroke} />
        </svg>
      )
    default:
      return <span className="inline-block w-1 h-1 rounded-full bg-fill-tertiary shrink-0" />
  }
}

export function ToolBlock({ block }: { block: ToolBlockT }) {
  const { t } = useTranslation()
  const [resultOpen, setResultOpen] = useState(false)
  const failed = block.status === 'failed'
  const guarded = block.status === 'guarded'
  const running = block.status === 'running'

  return (
    <div
      id={`tool-${block.id}`}
      className="rounded-lg border border-border-default bg-bg-surface px-3 py-2 select-text"
      style={{ borderLeftWidth: 2, borderLeftColor: railColor(block.status) }}
    >
      {/* 头行：状态点 + 类别图标 + 意图 + 时长 + 结果开关（控件 select-none，F1-4） */}
      <div className="flex items-center gap-2 select-none">
        {guarded ? (
          <HoverCard tip={<span>{t('thought.guardedTitle')}</span>}>
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-warning shrink-0" />
          </HoverCard>
        ) : (
          <span
            className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${running ? 'animate-pulse' : ''}`}
            style={{ background: dotColor(block.status) }}
          />
        )}
        <KindIcon kind={block.call.kind} />
        <span className="text-xs text-text-secondary truncate">{block.intent || block.call.title}</span>
        <span className="flex-1" />
        {block.durationMs > 0 && (
          <span className="text-2xs text-text-faint shrink-0 select-none">
            {(block.durationMs / 1000).toFixed(1)}s
          </span>
        )}
        {block.result && (
          <button
            type="button"
            className="tool-card__btn text-2xs px-1.5 py-0.5 rounded text-text-faint hover:text-text-primary select-none shrink-0"
            onClick={() => setResultOpen(!resultOpen)}
          >
            {resultOpen ? t('flow.hideResult') : t('flow.showResult')}
          </button>
        )}
      </div>

      {/* 调用卡（按 card 字段分发，无 toolName 特判） */}
      <ToolCallBody call={block.call} />

      {/* guarded / failed 的说明文本：琥珀 vs 红（C-16 可区分） */}
      {guarded && block.errorMessage && (
        <div className="mt-1 text-xs text-warning whitespace-pre-wrap select-text">{block.errorMessage}</div>
      )}
      {failed && block.errorMessage && (
        <div className="mt-1 text-xs text-danger whitespace-pre-wrap select-text">{block.errorMessage}</div>
      )}

      {/* 结果：摘要默认可见（C-11），完整结果默认折叠（resultOpen 初始 false） */}
      {block.result && !resultOpen && <ResultSummaryLine result={block.result} />}
      {block.result && resultOpen && (
        <div className="mt-1">
          <ToolResultBody result={block.result} />
        </div>
      )}
    </div>
  )
}
