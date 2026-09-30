/* ============================================================
 * ArkWork — ToolBlock（v0.31.0 B4 · v0.36.2 D112 一行化 · v0.42.0 P5 去卡片化）
 * 工具块。契约：
 *  - 六态状态机（05 §二 T1）：pending/running/success/failed/guarded/cancelled，
 *    guarded（琥珀，Agent 拦截·非错误）与 failed（红）**视觉与语义可区分**（C-16）；
 *  - 视觉层级（v0.42.0 P5 对标 ZCode）：**行式无边框**呈现融入背景，
 *    状态点 + 异常语义色双编码（C-13 的「形状」维度随卡片退役）；
 *  - v0.36.2（D112）一行化：动作文本 + 可点击文件 + 结果摘要合并进头行，
 *    路径只出现一次（stripPaths 去重）；完整结果默认折叠（resultOpen 初始
 *    false），截断显示上限提示（C-18）；
 *  - 零原生 title（C-20，guarded 说明走 HoverCard）；
 *  - 字号与思考块同级 = text-xs/13px（C-14）。
 * ============================================================ */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FlowBlock, ToolCallKind, ToolStatus } from '@shared/types/flow'
import type { ToolCallView, ToolResultView } from '@shared/types/tool-present'
import { shortPathOf } from '@shared/utils/path-display'
import { ToolCallBody, ToolResultBody } from '../tools'
import { ChangeSummary } from '../ChangeSummary'
import { FileLink } from '../FileLink'
import { useOpenPath } from '../useOpenPath'
import { HoverCard } from '../HoverCard'

type ToolBlockT = Extract<FlowBlock, { kind: 'tool' }>

/**
 * 状态点色 —— v0.31.0 D21「颜色只留给异常」：
 *   落定的成功步骤占交互区绝大多数，若 success 也上绿，满屏绿点即用户所说的
 *   「五彩斑斓」。故 success / pending / cancelled 一律中性，只有
 *   running（在跑）/ failed（失败）/ guarded（拦截）三态上语义色。
 * 状态并未丢失：状态点 + 异常行语义色文字双编码仍在（C-16）。
 * v0.42.0 P5：左侧 2px 状态条随卡片化退役（ZCode 过程行无竖条）——
 * 三态可区分性由状态点承担。
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

/** 「像路径」的串才参与剥除（含分隔符），防误伤搜索 pattern 等普通词（TC-BLOCK-023） */
function looksPath(v: string): boolean {
  return v.length >= 2 && (v.includes('/') || v.includes('\\'))
}

/**
 * D112：把文本里与路径重复的片段剥掉（全路径与展示短路径两种变体），
 * 再清理残留分隔符 —— 「读取文件：src/app.ts」→「读取文件」、
 * 「src/app.ts · 120 行」→「120 行」。路径的**唯一**展示位交给行内 FileLink。
 */
export function stripPaths(text: string, paths: string[]): string {
  let out = text
  for (const p of paths) {
    if (!p) continue
    for (const variant of new Set([p, shortPathOf(p)])) {
      if (looksPath(variant)) out = out.split(variant).join(' ')
    }
  }
  return out.replace(/[\s：:·，,]+/g, ' ').trim()
}

/** 本次调用的全部路径：generic 卡取 locations，write 卡取 changes（D112 去重源） */
function pathsOfCall(call: ToolCallView): string[] {
  if (call.card === 'generic') return (call.locations ?? []).map((l) => l.path)
  if (call.card === 'write') return call.changes.map((c) => c.path)
  return []
}

/** 行内摘要（折叠态）：strip 后为空则不渲染（避免孤零零的分隔符） */
function inlineStats(result: ToolResultView, paths: string[]): string {
  return stripPaths(result.summary, paths)
}

export function ToolBlock({ block }: { block: ToolBlockT }) {
  const { t } = useTranslation()
  const [resultOpen, setResultOpen] = useState(false)
  const open = useOpenPath()
  const failed = block.status === 'failed'
  const guarded = block.status === 'guarded'
  const running = block.status === 'running'

  const call = block.call
  // D112：一行化的两个前提 —— 去重路径集 + 是否抑制独立调用体行
  const paths = useMemo(() => pathsOfCall(call), [call])
  const inlineSubject =
    (call.card === 'generic' && (call.locations?.length ?? 0) > 0) || call.card === 'write'
  const text = useMemo(() => stripPaths(block.intent || call.title, paths), [block.intent, call, paths])
  // 折叠态行内结果摘要（write 卡由 ChangeSummary 携带 +/− 信号，不再显示文本摘要）
  const stats = block.result && !resultOpen && call.card !== 'write' ? inlineStats(block.result, paths) : ''
  const truncated = block.result && 'truncated' in block.result && block.result.truncated === true

  return (
    // v0.42.0 P5（对标 ZCode 过程行）：去卡片化 —— 无边框无底色的**行式**呈现，
    // 视觉融入背景（ZCode 语言：正文强、过程弱）；hover 才浮出轻底。
    // 三态可区分性（C-16）由状态点 + 语义色文字双编码保留（形状维度随卡片退役）。
    <div
      id={`tool-${block.id}`}
      className="rounded-md px-1 py-0.5 select-text transition-colors hover:bg-bg-hover"
    >
      {/* 头行（D112 一行化）：状态点 + 类别图标 + 动作文 + 行内文件 + 行内摘要 + 时长 + 结果开关 */}
      <div className="flex items-center gap-2 select-none min-w-0">
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
        <KindIcon kind={call.kind} />
        {text && (
          <span className="text-xs text-text-secondary truncate shrink-0 max-w-[45%]">{text}</span>
        )}
        {/* 行内文件（可点击，全路径传参 —— openDoc 唯一门面，展示即全路径） */}
        {call.card === 'generic' && (call.locations?.length ?? 0) > 0 && (
          <span className="flex items-center gap-1.5 min-w-0 overflow-hidden">
            {call.locations!.map((loc, i) => (
              <FileLink key={`${loc.path}:${i}`} path={loc.path} line={loc.line} className="text-xs" />
            ))}
          </span>
        )}
        {/* write 卡：ChangeSummary 上移进头行（路径本就可点击，+/− 是核心信号） */}
        {call.card === 'write' && (
          <span className="min-w-0 overflow-hidden">
            <ChangeSummary changes={call.changes} variant="inline" onOpenFile={open} />
          </span>
        )}
        {/* 行内结果摘要（信号层 text-primary，B11/P4-b 口径） */}
        {stats && (
          <span className="text-xs text-text-primary truncate min-w-0">
            {stats}
            {truncated && (
              <span className="ml-1.5 text-2xs text-text-faint select-none">{t('flow.truncatedResult')}</span>
            )}
          </span>
        )}
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

      {/* 调用卡（按 card 字段分发，无 toolName 特判）。
          D112：generic+locations / write 的调用体已上移头行，不再重复渲染。 */}
      {!inlineSubject && <ToolCallBody call={call} />}

      {/* guarded / failed 的说明文本：琥珀 vs 红（C-16 可区分） */}
      {guarded && block.errorMessage && (
        <div className="mt-1 text-xs text-warning whitespace-pre-wrap select-text">{block.errorMessage}</div>
      )}
      {failed && block.errorMessage && (
        <div className="mt-1 text-xs text-danger whitespace-pre-wrap select-text">{block.errorMessage}</div>
      )}

      {/* 结果：完整内容默认折叠（resultOpen 初始 false），展开后整块渲染。
          v0.42.0：展开区加左侧树线，与侧栏清单展开区同一视觉语言。 */}
      {block.result && resultOpen && (
        <div className="mt-1 ml-1 border-l-2 border-border-subtle pl-2.5">
          <ToolResultBody result={block.result} />
        </div>
      )}
    </div>
  )
}
