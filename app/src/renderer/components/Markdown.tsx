/* ============================================================
 * ArkWork — Markdown (v0.3.0)
 * 简易 parser，输出 React 节点，配合 globals.css 的 .md-body 样式
 * 支持的语法：
 *   - 标题 #/##/###/####
 *   - 段落
 *   - 代码块 ```lang ... ``` （含语言标签 + 复制按钮）
 *   - 行内代码 `code`
 *   - 粗体 **text** / 斜体 *text*
 *   - 链接 [text](url)
 *   - 无序列表 - / *
 *   - 有序列表 1.
 *   - 任务列表 - [ ] / - [x]
 *   - 引用 >
 *   - 水平分割线 ---
 *   - 表格 | a | b |
 *   - ECharts 图表 ```echarts {json}```（echarts option JSON，渲染交互图表）
 *   - 流式光标（streaming=true 时在末尾加 ▍）
 * 渲染为受控 React 节点（避免 XSS）；图表仅引入 echarts，其余零依赖。
 * ============================================================ */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as echarts from 'echarts'
import { Icon } from '../icons'

interface MarkdownProps {
  content: string
  /** 流式渲染中：在末尾追加闪烁光标 */
  streaming?: boolean
}

export function Markdown({ content, streaming = false }: MarkdownProps) {
  const blocks = parseBlocks(content)

  return (
    <div className="md-body">
      {blocks.map((block, i) => {
        const isLast = i === blocks.length - 1
        return (
          <BlockRenderer
            key={i}
            block={block}
            streamingCursor={streaming && isLast}
          />
        )
      })}
      {streaming && blocks.length === 0 && (
        <span className="stream-cursor" />
      )}
    </div>
  )
}

/* ============================================================
 * 块级解析
 * ============================================================ */
type Block =
  | { type: 'heading'; level: 1 | 2 | 3 | 4; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'code'; lang: string; code: string }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] }
  | { type: 'task'; items: { text: string; done: boolean }[] }
  | { type: 'quote'; text: string }
  | { type: 'hr' }
  | { type: 'table'; header: string[]; rows: string[][] }
  | { type: 'chart'; option: string }

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // 空行跳过
    if (line.trim() === '') {
      i++
      continue
    }

    // 代码块 / ECharts 图表块
    if (line.trim().startsWith('```')) {
      const lang = line.trim().slice(3).trim()
      const buf: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        buf.push(lines[i])
        i++
      }
      i++ // 跳过结束的 ```
      const code = buf.join('\n')
      if (lang === 'echarts' || lang === 'chart') {
        blocks.push({ type: 'chart', option: code })
      } else {
        blocks.push({ type: 'code', lang: lang || 'text', code })
      }
      continue
    }

    // 标题
    const h = line.match(/^(#{1,4})\s+(.*)$/)
    if (h) {
      blocks.push({
        type: 'heading',
        level: h[1].length as 1 | 2 | 3 | 4,
        text: h[2],
      })
      i++
      continue
    }

    // 水平线
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      blocks.push({ type: 'hr' })
      i++
      continue
    }

    // 表格（简单判定：本行有 |，下一行是 | --- |）
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:\-|]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const header = splitTableRow(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitTableRow(lines[i]))
        i++
      }
      blocks.push({ type: 'table', header, rows })
      continue
    }

    // 任务列表项 - [ ] / - [x]
    const taskMatch = line.match(/^\s*[-*]\s+\[([xX ]?)\]\s+(.*)$/)
    if (taskMatch) {
      const items: { text: string; done: boolean }[] = []
      while (i < lines.length) {
        const m = lines[i].match(/^\s*[-*]\s+\[([xX ]?)\]\s+(.*)$/)
        if (!m) break
        items.push({ text: m[2], done: m[1].toLowerCase() === 'x' })
        i++
      }
      blocks.push({ type: 'task', items })
      continue
    }

    // 无序列表
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length) {
        const m = lines[i].match(/^\s*[-*+]\s+(.*)$/)
        if (!m) break
        items.push(m[1])
        i++
      }
      blocks.push({ type: 'ul', items })
      continue
    }

    // 有序列表
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length) {
        const m = lines[i].match(/^\s*\d+\.\s+(.*)$/)
        if (!m) break
        items.push(m[1])
        i++
      }
      blocks.push({ type: 'ol', items })
      continue
    }

    // 引用
    if (line.trim().startsWith('>')) {
      const buf: string[] = []
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''))
        i++
      }
      blocks.push({ type: 'quote', text: buf.join('\n') })
      continue
    }

    // 普通段落：连续非空、非特殊前缀的行合并
    const buf: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].trim().startsWith('```') &&
      !/^(#{1,4})\s/.test(lines[i]) &&
      !/^\s*[-*]\s/.test(lines[i]) &&
      !/^\s*\d+\.\s/.test(lines[i]) &&
      !lines[i].trim().startsWith('>') &&
      !/^\s*([-*_])\1{2,}\s*$/.test(lines[i])
    ) {
      buf.push(lines[i])
      i++
    }
    blocks.push({ type: 'paragraph', text: buf.join(' ') })
  }

  return blocks
}

function splitTableRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim())
}

/* ============================================================
 * Block 渲染
 * ============================================================ */
function BlockRenderer({
  block,
  streamingCursor,
}: {
  block: Block
  streamingCursor: boolean
}) {
  switch (block.type) {
    case 'heading': {
      const text = <InlineText text={block.text} />
      const cls = block.level === 1 ? 'h1' : block.level === 2 ? 'h2' : block.level === 3 ? 'h3' : 'h4'
      const Tag = (block.level === 1 ? 'h1' : block.level === 2 ? 'h2' : block.level === 3 ? 'h3' : 'h4') as React.ElementType
      return (
        <Tag className={cls}>
          {text}
          {streamingCursor && <span className="stream-cursor" />}
        </Tag>
      )
    }
    case 'paragraph':
      return (
        <p>
          <InlineText text={block.text} />
          {streamingCursor && <span className="stream-cursor" />}
        </p>
      )
    case 'code':
      return <CodeBlock lang={block.lang} code={block.code} streamingCursor={streamingCursor} />
    case 'chart':
      return <EChartBlock option={block.option} />
    case 'ul':
      return (
        <ul>
          {block.items.map((it, i) => (
            <li key={i}>
              <InlineText text={it} />
            </li>
          ))}
          {streamingCursor && <span className="stream-cursor" />}
        </ul>
      )
    case 'ol':
      return (
        <ol>
          {block.items.map((it, i) => (
            <li key={i}>
              <InlineText text={it} />
            </li>
          ))}
          {streamingCursor && <span className="stream-cursor" />}
        </ol>
      )
    case 'task':
      return (
        <ul style={{ listStyle: 'none', paddingLeft: 0 }}>
          {block.items.map((it, i) => (
            <li key={i} style={{ listStyle: 'none' }}>
              <TaskItem text={it.text} done={it.done} />
            </li>
          ))}
          {streamingCursor && <span className="stream-cursor" />}
        </ul>
      )
    case 'quote':
      return (
        <blockquote>
          <InlineText text={block.text} />
          {streamingCursor && <span className="stream-cursor" />}
        </blockquote>
      )
    case 'hr':
      return <hr />
    case 'table':
      return (
        <table>
          <thead>
            <tr>
              {block.header.map((h, i) => (
                <th key={i}>
                  <InlineText text={h} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, ri) => (
              <tr key={ri}>
                {row.map((c, ci) => (
                  <td key={ci}>
                    <InlineText text={c} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {streamingCursor && <span className="stream-cursor" />}
        </table>
      )
  }
}

/* ============================================================
 * 代码块：左上角语言标签 + 右上角复制按钮
 * ============================================================ */
function CodeBlock({
  lang,
  code,
  streamingCursor,
}: {
  lang: string
  code: string
  streamingCursor: boolean
}) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // ignore
    }
  }
  return (
    <pre>
      <span className="lang-tag">{lang}</span>
      <button onClick={handleCopy} className="copy-btn" type="button">
        {copied ? t('markdown.copied') : t('markdown.copy')}
      </button>
      <code>
        {code}
        {streamingCursor && <span className="stream-cursor" />}
      </code>
    </pre>
  )
}

/* ============================================================
 * ECharts 图表块：```echarts {option JSON}``` → 交互图表
 * JSON 非法时回退为等宽代码展示，保证内容不丢失
 * ============================================================ */
function EChartBlock({ option }: { option: string }) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  const [invalid, setInvalid] = useState<string | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let chart: echarts.ECharts | null = null
    try {
      const opt = JSON.parse(option)
      if (!opt || typeof opt !== 'object' || Array.isArray(opt)) throw new Error('invalid option')
      chart = echarts.init(el)
      chart.setOption(opt)
      setInvalid(null)
    } catch (e) {
      setInvalid(option)
      return
    }
    const onResize = () => chart?.resize()
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      chart?.dispose()
    }
  }, [option])

  if (invalid !== null) {
    return (
      <pre>
        <span className="lang-tag">{t('markdown.jsonInvalid')}</span>
        <code>{invalid}</code>
      </pre>
    )
  }

  return (
    <div className="echart-wrap">
      <span className="echart-title">{t('markdown.chart')}</span>
      <div ref={ref} className="echart-canvas" />
    </div>
  )
}

function TaskItem({ text, done }: { text: string; done: boolean }) {
  return (
    <span
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '8px',
        color: done ? 'var(--text-tertiary)' : 'inherit',
        textDecoration: done ? 'line-through' : 'none',
      }}
    >
      <span
        style={{
          marginTop: '4px',
          width: '14px',
          height: '14px',
          borderRadius: '3px',
          border: `1px solid ${done ? 'var(--success)' : 'var(--border-default)'}`,
          background: done ? 'var(--success)' : 'transparent',
          color: '#0E1014',
          fontSize: '10px',
          lineHeight: '14px',
          textAlign: 'center',
          flexShrink: 0,
        }}
      >
        {done ? '✓' : ''}
      </span>
      <span style={{ flex: 1 }}>
        <InlineText text={text} />
      </span>
    </span>
  )
}

/* ============================================================
 * 行内解析：**bold** / *italic* / ~~strike~~ / `code` / [text](url)
 * ============================================================ */
function InlineText({ text }: { text: string }) {
  // 用 split + 正则捕获组依次处理（bold 优先于 italic，避免 `**` 被 `*` 截断）
  const parts = text.split(/(\*\*[^*]+\*\*|~~[^~]+~~|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*[^*]+\*)/g)
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith('**') && p.endsWith('**')) {
          return (
            <strong key={i}>
              {p.slice(2, -2)}
            </strong>
          )
        }
        if (p.startsWith('~~') && p.endsWith('~~')) {
          return <s key={i}>{p.slice(2, -2)}</s>
        }
        if (p.startsWith('`') && p.endsWith('`')) {
          return <code key={i}>{p.slice(1, -1)}</code>
        }
        const link = p.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
        if (link) {
          return (
            <a key={i} href={link[2]} target="_blank" rel="noreferrer noopener">
              {link[1]}
            </a>
          )
        }
        if (p.startsWith('*') && p.endsWith('*') && p.length > 2) {
          return <em key={i}>{p.slice(1, -1)}</em>
        }
        return <span key={i}>{p}</span>
      })}
    </>
  )
}

/* 重新生成入口（外部 hover 操作行使用，预留导出） */
export function MarkdownActions({ onCopy }: { onCopy?: () => void }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
      <button
        onClick={async () => {
          if (!onCopy) return
          onCopy()
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
        className="flex items-center gap-1 px-1.5 py-0.5 rounded text-2xs text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
      >
        <Icon.File width={16} height={16} />
        {copied ? t('markdown.copiedAction') : t('markdown.copyAction')}
      </button>
    </div>
  )
}
