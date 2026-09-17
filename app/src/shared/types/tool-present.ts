/* ============================================================
 * ArkWork — Shared Types: 工具呈现协议（v0.31.0）
 * 设计文档：docs/agent_learn/interaction-display-v1.0/07 §2.1 后半 · 本仓库
 * docs/versions/v0.31.0/04-system-design.md §4.1 / §5.4.5 / §5.4.6。
 * 主进程 `main/agent/tools/present.ts`（B4）与渲染层 `components/flow/` 共用的
 * 呈现契约；不改变工具执行语义。
 * ============================================================ */

export type ToolCallKind =
  | 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'fetch' | 'other'

export interface FileLocation { path: string; line?: number }

/** 变更摘要条目。oldText === null 表示新建或覆盖（调用时拿不到前像） */
export interface FileChange {
  path: string
  added: number
  removed: number
  oldText: string | null
  newText: string
}

export interface CodeLine { number: number; text: string }
export interface SearchLineMatch { lineNumber: number; line: string }
export interface SearchFileMatches { path: string; matches: SearchLineMatch[] }
export interface WebSource { url: string; title?: string; snippet?: string; publishedAt?: string }

/** 工具声明「这次调用怎么渲染」（pending 态） */
export type ToolCallView =
  | { card: 'generic'; title: string; kind?: ToolCallKind; rawInput?: unknown; locations?: FileLocation[] }
  | { card: 'terminal'; title: string; kind?: ToolCallKind; description?: string; cwd?: string }
  | { card: 'write'; title: string; kind?: ToolCallKind; changes: FileChange[]; locations?: FileLocation[] }

/** 工具声明「这次调用的结果怎么渲染」（settled 态） */
export type ToolResultView =
  | { card: 'generic'; title?: string; summary: string; content?: string; isError?: boolean }
  | { card: 'terminal'; title?: string; summary: string; output?: string; exitCode?: number; signal?: string; truncated?: boolean }
  | { card: 'read'; title?: string; summary: string; path: string; offset: number; lines: CodeLine[]; totalLines: number; lang?: string; truncated?: boolean }
  | { card: 'search'; shape: 'matches'; summary: string; files: SearchFileMatches[]; truncated: boolean; total: number }
  | { card: 'search'; shape: 'paths'; summary: string; paths: string[]; truncated: boolean; total: number }
  | { card: 'web'; kind: 'search'; summary: string; sources: WebSource[]; answer?: string; truncated: boolean }
  | { card: 'web'; kind: 'fetch'; summary: string; url: string; statusCode: number; truncated?: boolean }
  | { card: 'write'; title?: string; summary: string; changes: FileChange[]; dryRun?: boolean }

/** 工具声明呈现的接口（主进程侧工具注册时提供） */
export interface ToolPresenter<A = unknown, R = unknown> {
  presentCall: (args: A) => ToolCallView
  /** 缺省时 UI 用 call view 的 title + 原始 result 文本兜底（05 §4.2 T5-d） */
  presentResult?: (args: A, result: R) => ToolResultView
}
