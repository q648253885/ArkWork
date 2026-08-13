/**
 * Electron 专属 CSS 属性扩展
 * React 内置 CSSProperties 不含 WebkitAppRegion（Electron 无框窗口拖动区域）
 */
import type { CSSProperties } from 'react'

declare module 'react' {
  interface CSSProperties {
    WebkitAppRegion?: 'drag' | 'no-drag'
  }
}

// SVG / PNG 资源默认导入声明见 ./svg.d.ts（独立 ambient 文件，避免本文件
// 因顶层 import 变为模块后丢失 ambient 作用域）。
