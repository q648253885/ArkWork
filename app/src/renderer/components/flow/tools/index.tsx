/* ============================================================
 * ArkWork — 工具卡注册表（v0.31.0 B4 · TC-BLOCK-001）
 * **只按 card 字段分发，全文件无 toolName 特判**（C-17：呈现与工具名解耦）。
 * 六类渲染器各有独立组件：Generic / Terminal / Read / Search / Web / Write。
 * ============================================================ */
import type { ToolCallView, ToolResultView } from '@shared/types/tool-present'
import { GenericCallView, GenericResultView, ResultSummaryLine } from './GenericCard'
import { TerminalCallView, TerminalResultView } from './TerminalCard'
import { ReadResultView } from './ReadCard'
import { SearchMatchesView, SearchPathsView } from './SearchCard'
import { WebSearchView, WebFetchView } from './WebCard'
import { WriteCallView, WriteResultView } from './WriteCard'

export { ResultSummaryLine }

export function ToolCallBody({ call }: { call: ToolCallView }) {
  switch (call.card) {
    case 'terminal':
      return <TerminalCallView call={call} />
    case 'write':
      return <WriteCallView call={call} />
    default:
      return <GenericCallView call={call} />
  }
}

export function ToolResultBody({ result }: { result: ToolResultView }) {
  switch (result.card) {
    case 'terminal':
      return <TerminalResultView result={result} />
    case 'read':
      return <ReadResultView result={result} />
    case 'search':
      return result.shape === 'matches' ? (
        <SearchMatchesView result={result} />
      ) : (
        <SearchPathsView result={result} />
      )
    case 'web':
      return result.kind === 'search' ? <WebSearchView result={result} /> : <WebFetchView result={result} />
    case 'write':
      return <WriteResultView result={result} />
    default:
      return <GenericResultView result={result} />
  }
}
