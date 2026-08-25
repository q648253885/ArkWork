/* ============================================================
 * ArkWork — CodeRenderer (v0.7.0)
 * 只读语法高亮代码视图：行号 + 自动换行切换
 * 不引入第三方高亮库，使用轻量正则 tokenizer 按语言分词着色：
 *   字符串 / 注释 / 数字 / 关键字 / 标识符 / 标点
 * 注释前缀按语言判定（//、#、--），避免误伤 CSS 的 # 与 SQL 的 --。
 * 自动换行为本渲染器内部状态，故内置一行迷你工具条。
 * ============================================================ */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../../../icons'

interface CodeRendererProps {
  content: string
  language: string
}

/* 关键字集合（小写为主，含常见 SQL 大写形式） */
const KEYWORDS = new Set<string>([
  // JS/TS
  'import','export','from','default','const','let','var','function','return','if','else','for','while','do','switch','case','break','continue','class','interface','type','extends','implements','new','await','async','try','catch','finally','throw','typeof','instanceof','in','of','as','enum','public','private','protected','readonly','static','get','set','void','this','super','yield','delete','namespace','module','declare','abstract','satisfies',
  // 字面量
  'true','false','null','undefined','nan','infinity',
  // Python
  'def','elif','lambda','pass','with','not','and','or','is','none','self','cls','nonlocal','global','assert','raise','except','finally','yield','async','await','print',
  // Go
  'package','func','go','chan','select','defer','range','map','struct','fallthrough','interface','goroutine',
  // Rust
  'fn','let','mut','pub','match','impl','trait','use','crate','mod','move','ref','where','unsafe','dyn','self',
  // Java/Kotlin/Scala
  'boolean','int','float','double','char','byte','short','long','string','object','val','fun','when','data','sealed','open','companion','suspend','object','extends','throws',
  // shell / misc
  'echo','exit','cd','pwd','export','source','alias','unset','local','readonly','declare',
  // SQL（大写）
  'SELECT','FROM','WHERE','INSERT','UPDATE','DELETE','CREATE','TABLE','DROP','ALTER','INTO','VALUES','SET','JOIN','LEFT','RIGHT','INNER','OUTER','FULL','ON','AND','OR','NOT','NULL','PRIMARY','KEY','FOREIGN','REFERENCES','INDEX','UNIQUE','DEFAULT','AUTOINCREMENT','DISTINCT','GROUP','BY','ORDER','HAVING','LIMIT','OFFSET','AS','UNION','ALL','EXISTS','BETWEEN','LIKE','IN','IS','CASE','WHEN','THEN','ELSE','END','COUNT','SUM','AVG','MIN','MAX',
])

/* 各语言的行注释前缀 */
const SLASH_COMMENT = new Set([
  'ts','tsx','js','jsx','json','java','kt','kotlin','c','cpp','c++','h','hpp','cs','csharp','go','rs','rust','swift','php','dart','scala','groovy','gradle','m','mm','ts','javascript','typescript',
])
const HASH_COMMENT = new Set([
  'py','python','rb','ruby','sh','bash','zsh','shell','yaml','yml','toml','ini','conf','makefile','make','dockerfile','r','perl','ps1','powershell','cmake','dockerfile',
])
const DASH_COMMENT = new Set(['sql','hs','haskell','lua','ada','vhdl'])

function commentPrefixes(lang: string): string[] {
  const l = lang.toLowerCase()
  const out: string[] = []
  if (SLASH_COMMENT.has(l)) out.push('//')
  if (HASH_COMMENT.has(l)) out.push('#')
  if (DASH_COMMENT.has(l)) out.push('--')
  // 兜底：未识别语言默认不启用行注释高亮（避免误伤）
  return out
}

type Tok = { t: string; v: string }

/** 构建单行 tokenizer 正则；注释前缀按语言动态拼接 */
function buildLineRegex(prefixes: string[]): RegExp {
  const commentAlt = prefixes.length
    ? prefixes
        .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .map((p) => `(?:${p}[^\\n]*)`)
        .join('|')
    : '(?!x)x' // 永不匹配占位
  // 1: 字符串 2: 行注释 3: 块注释(单行) 4: 数字 5: 标识符 6: 空白 7: 标点
  return new RegExp(
    `(` +
      '`(?:\\\\.|[^`\\\\])*`' + '|' +
      `"(?:\\\\.|[^"\\\\])*"` + '|' +
      `'(?:\\\\.|[^'\\\\])*'` +
    `)|(${commentAlt})|(\\/\\*.*?\\*\\/)|(\\b\\d+(?:\\.\\d+)?\\b)|([A-Za-z_$][\\w$]*)|(\\s+)|([\\s\\S])`,
    'g',
  )
}

function tokenizeLine(line: string, re: RegExp): Tok[] {
  const toks: Tok[] = []
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) {
    if (m[1]) toks.push({ t: 'string', v: m[1] })
    else if (m[2]) toks.push({ t: 'comment', v: m[2] })
    else if (m[3]) toks.push({ t: 'comment', v: m[3] })
    else if (m[4]) toks.push({ t: 'number', v: m[4] })
    else if (m[5]) toks.push({ t: KEYWORDS.has(m[5]) ? 'keyword' : 'ident', v: m[5] })
    else if (m[6]) toks.push({ t: 'ws', v: m[6] })
    else if (m[7]) toks.push({ t: 'punct', v: m[7] })
  }
  return toks
}

const TOK_COLOR: Record<string, string> = {
  keyword: 'var(--accent)',
  string: 'var(--success)',
  comment: 'var(--text-tertiary)',
  number: 'var(--warning)',
  punct: 'var(--text-secondary)',
  ident: 'var(--text-primary)',
  ws: 'inherit',
}

export function CodeRenderer({ content, language }: CodeRendererProps) {
  const { t } = useTranslation()
  const [wrap, setWrap] = useState(false)

  const { lines, langLabel } = useMemo(() => {
    const re = buildLineRegex(commentPrefixes(language))
    const ls = content.replace(/\r\n/g, '\n').split('\n')
    const tokenized = ls.map((l) => tokenizeLine(l, re))
    return { lines: tokenized, langLabel: language || 'text' }
  }, [content, language])

  return (
    <div className="h-full flex flex-col bg-bg-base min-h-0">
      {/* 迷你工具条 */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-border-subtle bg-bg-overlay flex-shrink-0">
        <span className="text-2xs text-text-tertiary uppercase tracking-wider font-mono">{langLabel}</span>
        <span className="text-2xs text-text-tertiary tabular ml-1">{t('preview.code.lines', { count: lines.length })}</span>
        <button
          type="button"
          onClick={() => setWrap((w) => !w)}
          className={`ml-auto px-2 py-0.5 text-2xs rounded-md transition-colors ${
            wrap ? 'bg-bg-active text-text-primary' : 'text-text-tertiary hover:bg-bg-hover hover:text-text-primary'
          }`}
        >
          {wrap ? t('preview.code.wrap') : t('preview.code.noWrap')}
        </button>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(content)
            } catch {
              /* ignore */
            }
          }}
          className="flex items-center gap-1 px-1.5 py-0.5 text-2xs text-text-tertiary hover:bg-bg-hover hover:text-text-primary rounded-md transition-colors"
        >
          <Icon.Copy width={16} height={16} />
          {t('preview.code.copy')}
        </button>
      </div>

      {/* 代码体 */}
      <div className="flex-1 overflow-auto min-h-0">
        <div className={`flex font-mono text-xs leading-relaxed ${wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'}`}>
          {/* 行号列 */}
          <div className="select-none text-right text-text-tertiary bg-bg-surface px-2 py-3 border-r border-border-subtle sticky left-0">
            {lines.map((_, i) => (
              <div key={i} className="tabular">{i + 1}</div>
            ))}
          </div>
          {/* 代码列 */}
          <div className="px-3 py-3 min-w-0 flex-1">
            {lines.map((toks, i) => (
              <div key={i}>
                {toks.length === 0 ? (
                  '\u00A0' /* 空行占位以保留高度 */
                ) : (
                  toks.map((tk, j) => (
                    <span key={j} style={{ color: TOK_COLOR[tk.t] ?? 'inherit' }} className={tk.t === 'comment' ? 'italic' : undefined}>
                      {tk.v}
                    </span>
                  ))
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
