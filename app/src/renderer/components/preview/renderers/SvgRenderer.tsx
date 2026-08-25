/* ============================================================
 * ArkWork — SvgRenderer (v0.7.0)
 * SVG 预览：render / source 双态
 * - render：内联 SVG（dangerouslySetInnerHTML），渲染前做最小清洗（剥离 <script> 与 on* 事件属性）
 * - source：原始文本（等宽字体）
 * ============================================================ */

interface SvgRendererProps {
  content: string
  /** 视图模式：'render' | 'source'，默认 'render' */
  viewMode?: string
}

/** 最小清洗：移除 <script> 块与 on* 事件属性，降低本地文件预览的 XSS 面 */
function sanitizeSvg(src: string): string {
  return src
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
}

export function SvgRenderer({ content, viewMode = 'render' }: SvgRendererProps) {
  if (viewMode === 'source') {
    return (
      <pre className="h-full overflow-auto m-0 px-4 py-3 text-sm text-text-primary font-mono whitespace-pre-wrap break-words leading-relaxed">
        {content}
      </pre>
    )
  }

  return (
    <div className="h-full w-full flex items-center justify-center overflow-auto p-6 bg-bg-surface">
      <div
        className="max-w-full max-h-full [&>svg]:max-w-full [&>svg]:max-h-[60vh] [&>svg]:h-auto [&>svg]:w-auto"
        // 本地文件预览，已做最小清洗；仍属 dangerouslySetInnerHTML，仅信任本地来源
        dangerouslySetInnerHTML={{ __html: sanitizeSvg(content) }}
      />
    </div>
  )
}
