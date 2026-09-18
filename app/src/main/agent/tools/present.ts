/* ============================================================
 * ArkWork — 工具呈现协议注册表（v0.31.0 B4 · §5.4.5）
 *
 * 职责：把「工具怎么呈现给用户」从「工具怎么执行」中分离（正本 R3 / C-17）。
 *  - 主进程与渲染层共用本模块（**纯函数、零 IO、零 electron 依赖**——渲染层
 *    `flow/project.ts` 直接 import，保证 `added/removed` 计数只有这一份实现）；
 *  - 本期只登记 8 个高频工具（read/writer/editor/glob/grep/shell/web-search/
 *    fetch-url），其余工具回落 generic（能力可降不可失，C-21）；
 *  - 缺省回落不引用渲染层 `getToolDisplay()`（跨层 import 禁止）—— 调用方
 *    （project.ts）以「旧 intent 合成串」作 fallbackTitle 传入，呈现不倒退（R3）。
 *
 * U2 裁决：`computeChanges`（行级 added/removed）是**全仓库唯一算法**，
 * ChangeSummary（inline / card 两形态）只消费本模块的输出，不得出现第二份实现。
 * ============================================================ */
import type {
  FileChange,
  SearchFileMatches,
  ToolCallView,
  ToolPresenter,
  ToolResultView,
} from '../../../shared/types/tool-present.js'
// v0.33.1 W3：Windows 路径展示归一（basename/缩短，分隔符兼容 / 与 \）
import { shortPathOf } from '../../../shared/utils/path-display.js'

/* ---------- 防御式取值（呈现层永不抛出） ---------- */

const asRec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

const asStr = (v: unknown): string => (typeof v === 'string' ? v : '')

const asNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/* ============================================================
 * U2：行级变更计数的唯一算法
 * ============================================================ */

/**
 * oldText/newText → FileChange（行级近似 diff：收缩公共前后缀，剩余即变更区）。
 * 确定性、纯函数；oldText === null 表示新建或覆盖（调用时拿不到前像，added = 全部行）。
 */
export function computeChanges(path: string, oldText: string | null, newText: string): FileChange {
  const oldLines = oldText === null ? [] : oldText.split('\n')
  const newLines = newText.split('\n')
  let start = 0
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++
  let endOld = oldLines.length
  let endNew = newLines.length
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld--
    endNew--
  }
  return { path, added: endNew - start, removed: endOld - start, oldText, newText }
}

/* ============================================================
 * grep 结果按文件分组（matches: {file,line,text} → SearchFileMatches[]）
 * ============================================================ */

function groupGrepMatches(
  matches: Array<{ file?: unknown; line?: unknown; text?: unknown }>,
): SearchFileMatches[] {
  const byFile = new Map<string, SearchFileMatches>()
  for (const m of matches) {
    const file = asStr(m.file)
    if (!file) continue
    let entry = byFile.get(file)
    if (!entry) {
      entry = { path: file, matches: [] }
      byFile.set(file, entry)
    }
    entry.matches.push({ lineNumber: asNum(m.line) ?? 0, line: asStr(m.text) })
  }
  return [...byFile.values()]
}

/* ============================================================
 * 8 个高频工具的 presenter（正本 R3：只做高频，其余回落）
 * ============================================================ */

interface PresenterEntry {
  names: string[]
  match?: (n: string) => boolean
  p: ToolPresenter
}

const PRESENTERS: PresenterEntry[] = [
  /* ---------- file-reader ---------- */
  {
    names: ['file-reader', 'read_file', 'read'],
    match: (n) => n.includes('read') && n.includes('file'),
    p: {
      presentCall: (args) => {
        const a = asRec(args)
        const path = asStr(a.path) || '.'
        const offset = asNum(a.offset) ?? 0
        return {
          card: 'generic',
          // 展示用缩短路径（Windows 反斜杠长路径直出会把卡片撑爆）；locations 保留全路径供预览跳转
          title: `读取 ${shortPathOf(path)}`,
          kind: 'read',
          locations: [{ path, line: offset > 0 ? offset : undefined }],
          rawInput: args,
        }
      },
      presentResult: (args, result) => {
        const a = asRec(args)
        const r = asRec(result)
        const path = asStr(r.path) || asStr(a.path) || '.'
        const err = asStr(r.error)
        if (err) return { card: 'generic', summary: err, isError: true }
        const lines = Array.isArray(r.lines)
          ? (r.lines as Array<{ number: number; text: string }>)
          : null
        if (lines) {
          return {
            card: 'read',
            summary: `${shortPathOf(path)} · ${lines.length} 行`,
            path,
            offset: asNum(r.offset) ?? 0,
            lines,
            totalLines: asNum(r.totalLines) ?? lines.length,
            truncated: r.truncated === true,
          }
        }
        const content = asStr(r.content)
        if (content) {
          const all = content.split('\n')
          return {
            card: 'read',
            summary: `${shortPathOf(path)} · ${content.length} 字符`,
            path,
            offset: 0,
            lines: all.slice(0, 400).map((text, i) => ({ number: i + 1, text })),
            totalLines: all.length,
            truncated: all.length > 400,
          }
        }
        return { card: 'generic', summary: asStr(r.summary) || `${shortPathOf(path)} 已读取` }
      },
    },
  },

  /* ---------- file-writer ---------- */
  {
    names: ['file-writer', 'write_file', 'write'],
    match: (n) => n.includes('write') && n.includes('file'),
    p: {
      presentCall: (args) => {
        const a = asRec(args)
        const path = asStr(a.path)
        const content = asStr(a.content)
        return {
          card: 'write',
          title: `写入 ${shortPathOf(path)}`,
          kind: 'edit',
          changes: [computeChanges(path, null, content)],
          locations: [{ path }],
        }
      },
      presentResult: (args, result) => {
        const a = asRec(args)
        const r = asRec(result)
        const path = asStr(a.path)
        const err = asStr(r.error)
        if (err) return { card: 'generic', summary: err, isError: true }
        return {
          card: 'write',
          summary: asStr(r.summary) || `${shortPathOf(path)} 已写入`,
          changes: [computeChanges(path, null, asStr(a.content))],
          dryRun: r.dryRun === true,
        }
      },
    },
  },

  /* ---------- file-editor ---------- */
  {
    names: ['file-editor', 'edit_file', 'edit'],
    match: (n) => n.includes('edit') && n.includes('file'),
    p: {
      presentCall: (args) => {
        const a = asRec(args)
        const path = asStr(a.path)
        return {
          card: 'write',
          title: `编辑 ${shortPathOf(path)}`,
          kind: 'edit',
          changes: [computeChanges(path, asStr(a.oldStr), asStr(a.newStr))],
          locations: [{ path }],
        }
      },
      presentResult: (args, result) => {
        const a = asRec(args)
        const r = asRec(result)
        const path = asStr(a.path)
        const err = asStr(r.error)
        if (err) return { card: 'generic', summary: err, isError: true }
        const replacements = asNum(r.replacements) ?? 0
        return {
          card: 'write',
          summary: `已编辑 ${shortPathOf(path)} · ${replacements} 处替换`,
          changes: [computeChanges(path, asStr(a.oldStr), asStr(a.newStr))],
        }
      },
    },
  },

  /* ---------- glob-search ---------- */
  {
    names: ['glob-search', 'search_files', 'glob', 'list_files'],
    match: (n) => n.includes('glob') || n.includes('list') && n.includes('file'),
    p: {
      presentCall: (args) => {
        const a = asRec(args)
        return {
          card: 'generic',
          title: `查找文件 ${asStr(a.pattern) || '*'}`,
          kind: 'search',
          rawInput: args,
        }
      },
      presentResult: (_args, result) => {
        const r = asRec(result)
        const matches = Array.isArray(r.matches) ? (r.matches as unknown[]).map(String) : []
        const total = asNum(r.total) ?? matches.length
        if (matches.length === 0) {
          return { card: 'search', shape: 'paths', summary: '无匹配文件', paths: [], truncated: false, total: 0 }
        }
        return {
          card: 'search',
          shape: 'paths',
          summary: `${total} 个匹配`,
          paths: matches,
          truncated: r.truncated === true,
          total,
        }
      },
    },
  },

  /* ---------- grep-search ---------- */
  {
    names: ['grep-search', 'grep_search', 'grep'],
    match: (n) => n.includes('grep'),
    p: {
      presentCall: (args) => {
        const a = asRec(args)
        const path = asStr(a.path)
        return {
          card: 'generic',
          title: `搜索 ${asStr(a.pattern)}`,
          kind: 'search',
          locations: path ? [{ path }] : undefined,
          rawInput: args,
        }
      },
      presentResult: (_args, result) => {
        const r = asRec(result)
        const matches = Array.isArray(r.matches)
          ? (r.matches as Array<{ file?: unknown; line?: unknown; text?: unknown }>)
          : []
        const total = asNum(r.total) ?? matches.length
        return {
          card: 'search',
          shape: 'matches',
          summary: `${total} 处命中`,
          files: groupGrepMatches(matches),
          truncated: r.truncated === true,
          total,
        }
      },
    },
  },

  /* ---------- shell ---------- */
  {
    names: ['shell', 'run_command', 'bash', 'execute'],
    match: (n) => n.includes('shell') || n.includes('command') || n.includes('exec'),
    p: {
      presentCall: (args) => {
        const a = asRec(args)
        return { card: 'terminal', title: asStr(a.command), kind: 'execute', cwd: asStr(a.cwd) || undefined }
      },
      presentResult: (_args, result) => {
        const r = asRec(result)
        const stdout = asStr(r.stdout)
        const stderr = asStr(r.stderr)
        const exitCode = asNum(r.exitCode)
        const output = [stdout, stderr].filter(Boolean).join('\n')
        return {
          card: 'terminal',
          summary: `exit=${exitCode ?? '?'} · ${output.length} 字符`,
          output: output || undefined,
          exitCode,
          signal: asStr(r.signal) || undefined,
          truncated: r.timedOut === true,
        }
      },
    },
  },

  /* ---------- web-search ---------- */
  {
    names: ['web-search', 'web_search'],
    match: (n) => n.includes('web') && n.includes('search'),
    p: {
      presentCall: (args) => {
        const a = asRec(args)
        return { card: 'generic', title: `搜索 Web：${asStr(a.query)}`, kind: 'fetch', rawInput: args }
      },
      presentResult: (_args, result) => {
        const r = asRec(result)
        const results = Array.isArray(r.results)
          ? (r.results as Array<Record<string, unknown>>)
          : []
        return {
          card: 'web',
          kind: 'search',
          summary: `${asNum(r.total) ?? results.length} 条结果`,
          sources: results.map((x) => ({
            url: asStr(x.url),
            title: asStr(x.title) || undefined,
            snippet: asStr(x.snippet) || undefined,
          })),
          truncated: false,
        }
      },
    },
  },

  /* ---------- fetch-url ---------- */
  {
    names: ['fetch-url', 'web_fetch', 'fetch'],
    match: (n) => n.includes('fetch') || n === 'browser',
    p: {
      presentCall: (args) => {
        const a = asRec(args)
        return {
          card: 'generic',
          title: `抓取 ${asStr(a.url)}`,
          kind: 'fetch',
          locations: [{ path: asStr(a.url) }],
          rawInput: args,
        }
      },
      presentResult: (_args, result) => {
        const r = asRec(result)
        const url = asStr(r.finalUrl) || asStr(r.url)
        return {
          card: 'web',
          kind: 'fetch',
          summary: `${asNum(r.chars) ?? 0} 字符 · ${asStr(r.title) || url}`,
          url,
          statusCode: asNum(r.status) ?? 0,
          truncated: r.truncated === true,
        }
      },
    },
  },
]

/* ============================================================
 * 注册 / 查询 / 缺省回落（§5.4.5 签名照引）
 * ============================================================ */

const registry = new Map<string, ToolPresenter>()
for (const entry of PRESENTERS) {
  for (const n of entry.names) registry.set(n, entry.p)
}

export function registerPresenter(toolName: string, p: ToolPresenter): void {
  registry.set(toolName, p)
}

export function getPresenter(toolName: string): ToolPresenter | undefined {
  const n = (toolName ?? '').toLowerCase()
  const exact = registry.get(n)
  if (exact) return exact
  const hit = PRESENTERS.find((e) => e.match?.(n) === true)
  return hit?.p
}

/** 缺省回落：调用方以旧 `getToolDisplay()` 口径的合成串作 fallbackTitle（不倒退，R3） */
export function presentCallOrDefault(toolName: string, args: unknown, fallbackTitle?: string): ToolCallView {
  try {
    const p = getPresenter(toolName)
    if (p) return p.presentCall(args)
  } catch {
    /* 呈现层永不抛出 —— 失败一律回落 generic（C-21 能力可降不可失） */
  }
  return { card: 'generic', title: fallbackTitle ?? toolName ?? '' }
}

export function presentResultOrDefault(
  toolName: string,
  args: unknown,
  result: unknown,
  fallbackSummary?: string,
): ToolResultView {
  try {
    const p = getPresenter(toolName)
    if (p?.presentResult) return p.presentResult(args, result)
  } catch {
    /* 同上：呈现失败回落 generic 摘要 */
  }
  return {
    card: 'generic',
    summary: fallbackSummary ?? (typeof result === 'string' ? result : ''),
  }
}
