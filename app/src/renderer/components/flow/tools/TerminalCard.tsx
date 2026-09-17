/* ============================================================
 * ArkWork — TerminalCard（v0.31.0 B4）
 * shell / run_command 的 terminal 卡：命令行 + cwd + 输出 + 退出码。
 *
 * v0.31.0 D21（层次）：命令执行卡是交互区里**唯一允许「重」的工具卡** ——
 * 用户明确反馈「弱化命令执行卡片」。在中性卡片体系内，重量的来源是
 *   ① 填充面板底（--fill-secondary，比卡片底再深一档，此前该 token 未定义
 *      导致整块透明，卡片彻底塌平）② 命令行用 text-primary 提亮
 *   ③ `$ ` 前缀把它从「一段等宽文本」标识为「一条被执行的命令」。
 * 注意：加重靠明度与字形，不靠语义色 —— 否则又回到「五彩斑斓」。
 * ============================================================ */
import { useTranslation } from 'react-i18next'
import type { ToolCallView, ToolResultView } from '@shared/types/tool-present'

type TerminalCall = Extract<ToolCallView, { card: 'terminal' }>

export function TerminalCallView({ call }: { call: TerminalCall }) {
  return (
    <div className="mt-1 space-y-1 select-text">
      <pre className="text-xs font-mono text-text-primary bg-fill-secondary rounded-md border border-border-default px-2 py-1.5 overflow-x-auto whitespace-pre-wrap m-0 select-text">
        <span className="select-none text-text-faint">$ </span>
        {call.title}
      </pre>
      {call.cwd && (
        <div className="text-2xs font-mono text-text-faint truncate select-text">{call.cwd}</div>
      )}
    </div>
  )
}

type TerminalResult = Extract<ToolResultView, { card: 'terminal' }>

export function TerminalResultView({ result }: { result: TerminalResult }) {
  const { t } = useTranslation()
  const ok = result.exitCode === 0
  return (
    <div className="mt-1 select-text">
      <div className="flex items-center gap-2">
        {/* D21：退出码徽标去「彩色底块」——成功是常态，常态不上色 */}
        {result.exitCode != null && (
          <span
            className={`text-2xs font-mono px-1.5 py-0.5 rounded border border-border-default bg-fill-secondary select-none ${
              ok ? 'text-text-secondary' : 'text-danger'
            }`}
          >
            exit {result.exitCode}
          </span>
        )}
        {result.signal && (
          <span className="text-2xs font-mono text-warning select-none">signal {result.signal}</span>
        )}
        {result.truncated && (
          <span className="text-2xs text-text-faint select-none">{t('flow.truncatedResult')}</span>
        )}
      </div>
      {result.output && (
        <pre className="mt-1 text-xs font-mono text-text-secondary bg-fill-secondary rounded-md border border-border-default p-2 overflow-x-auto max-h-48 whitespace-pre-wrap m-0 select-text">
          {result.output}
        </pre>
      )}
    </div>
  )
}
