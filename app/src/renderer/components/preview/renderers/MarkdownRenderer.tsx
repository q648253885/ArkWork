/* ============================================================
 * ArkWork — MarkdownRenderer (v0.7.0)
 * 预览浮窗 Markdown 渲染器：render / source / split 三态
 * - render：调用既有 <Markdown> 组件渲染富文本
 * - source：原始文本（等宽字体）
 * - split：左侧源码 + 右侧渲染，双栏同步滚动由各自容器承担
 * ============================================================ */
import { Markdown } from '../../Markdown'

interface MarkdownRendererProps {
  content: string
  /** 视图模式：'render' | 'source' | 'split'，默认 'render' */
  viewMode?: string
}

export function MarkdownRenderer({ content, viewMode = 'render' }: MarkdownRendererProps) {
  const mode = viewMode === 'source' || viewMode === 'split' ? viewMode : 'render'

  if (mode === 'source') {
    return (
      <pre className="h-full overflow-auto m-0 px-4 py-3 text-sm text-text-primary font-mono whitespace-pre-wrap break-words leading-relaxed">
        {content}
      </pre>
    )
  }

  if (mode === 'split') {
    return (
      <div className="h-full flex min-h-0">
        <div className="w-1/2 overflow-auto border-r border-border-subtle min-h-0 bg-bg-base">
          <pre className="m-0 px-4 py-3 text-sm text-text-primary font-mono whitespace-pre-wrap break-words leading-relaxed">
            {content}
          </pre>
        </div>
        <div className="w-1/2 overflow-auto min-h-0">
          <div className="px-6 py-4">
            <Markdown content={content} />
          </div>
        </div>
      </div>
    )
  }

  // render
  return (
    <div className="h-full overflow-auto px-6 py-4">
      <Markdown content={content} />
    </div>
  )
}
