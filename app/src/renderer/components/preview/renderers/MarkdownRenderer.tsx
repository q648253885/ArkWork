/* ============================================================
 * ArkWork — MarkdownRenderer (v0.7.0 / v0.31.0 C1)
 * 预览浮窗 Markdown 渲染器：render / source / split 三态
 * - render：调用既有 <Markdown> 组件渲染富文本
 * - source：原始文本（等宽字体）
 * - split：左侧源码 + 右侧渲染，双栏**比例同步滚动**（v0.31.0 C1：
 *   用户要求分屏必须共同滚动；互斥锁防止 scroll 事件互相触发死循环）
 * ============================================================ */
import { useRef } from 'react'
import { Markdown } from '../../Markdown'

interface MarkdownRendererProps {
  content: string
  /** 视图模式：'render' | 'source' | 'split'，默认 'render' */
  viewMode?: string
}

/**
 * split 双栏比例同步滚动。
 * 实现要点：
 *  - 按滚动比例（scrollTop / 可滚动距离）换算对侧位置，两侧内容高度不同也能对齐；
 *  - `syncingRef` 互斥锁：程序触发的对侧滚动会再次激发 onScroll，用「来源标记 +
 *    requestAnimationFrame 释放」阻断 A→B→A 循环；
 *  - 任一侧不可滚动（内容不足一屏）时跳过该次同步，不强行对齐。
 */
function useSplitScrollSync() {
  const srcRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<HTMLDivElement | null>(null)
  // 'src' | 'view' = 当前正在由哪一侧驱动的同步；null = 空闲
  const syncingRef = useRef<'src' | 'view' | null>(null)

  /** 可滚动比例；不可滚动（差值 ≤1px）返回 -1 表示跳过 */
  const ratioOf = (el: HTMLElement | null): number => {
    if (!el) return -1
    const max = el.scrollHeight - el.clientHeight
    return max > 1 ? el.scrollTop / max : -1
  }

  const applyRatio = (el: HTMLElement | null, ratio: number) => {
    if (!el || ratio < 0) return
    const max = el.scrollHeight - el.clientHeight
    if (max <= 1) return
    el.scrollTop = ratio * max
  }

  const onSrcScroll = () => {
    if (syncingRef.current === 'view') return
    syncingRef.current = 'src'
    applyRatio(viewRef.current, ratioOf(srcRef.current))
    requestAnimationFrame(() => {
      syncingRef.current = null
    })
  }

  const onViewScroll = () => {
    if (syncingRef.current === 'src') return
    syncingRef.current = 'view'
    applyRatio(srcRef.current, ratioOf(viewRef.current))
    requestAnimationFrame(() => {
      syncingRef.current = null
    })
  }

  return { srcRef, viewRef, onSrcScroll, onViewScroll }
}

export function MarkdownRenderer({ content, viewMode = 'render' }: MarkdownRendererProps) {
  const mode = viewMode === 'source' || viewMode === 'split' ? viewMode : 'render'
  const split = useSplitScrollSync()

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
        <div
          ref={split.srcRef}
          onScroll={split.onSrcScroll}
          className="w-1/2 overflow-auto border-r border-border-subtle min-h-0 bg-bg-base"
        >
          <pre className="m-0 px-4 py-3 text-sm text-text-primary font-mono whitespace-pre-wrap break-words leading-relaxed">
            {content}
          </pre>
        </div>
        <div ref={split.viewRef} onScroll={split.onViewScroll} className="w-1/2 overflow-auto min-h-0">
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
