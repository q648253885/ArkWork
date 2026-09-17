/* ============================================================
 * ArkWork — HoverCard（v0.31.0 B4 · C-20）
 * 交互区禁用原生 title 属性（悬停延迟且不可控样式）——
 * 一切悬停提示走本组件（纯 CSS group-hover，无 portal、无依赖）。
 * ============================================================ */
import type { ReactNode } from 'react'

export function HoverCard({ tip, children }: { tip: ReactNode; children: ReactNode }) {
  return (
    <span className="relative inline-flex group">
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-full mb-1.5 z-50 hidden group-hover:inline-flex items-center rounded-md bg-fill-secondary border border-border-default px-2 py-1 shadow-lg whitespace-nowrap text-2xs text-text-primary select-none"
      >
        {tip}
      </span>
    </span>
  )
}
