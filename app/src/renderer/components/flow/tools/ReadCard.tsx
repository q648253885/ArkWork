/* ============================================================
 * ArkWork — ReadCard（v0.31.0 B4）
 * file-reader 的 read 结果卡：CodeLines（行号 + 截断提示 C-18）。
 * ============================================================ */
import type { ToolResultView } from '@shared/types/tool-present'
import { CodeLines } from '../CodeLines'

type ReadResult = Extract<ToolResultView, { card: 'read' }>

export function ReadResultView({ result }: { result: ReadResult }) {
  return (
    <div className="mt-1 select-text">
      <CodeLines
        lines={result.lines}
        totalLines={result.totalLines}
        lang={result.lang}
      />
    </div>
  )
}
