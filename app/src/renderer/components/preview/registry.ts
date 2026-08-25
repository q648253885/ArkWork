/* ============================================================
 * ArkWork — Preview Renderer Registry (v0.7.0)
 * RendererKind → { 组件, 标签, 工具栏动作 }
 * 工具栏动作由 PreviewWindow 统一渲染并分发：
 *   - mode-switch：Markdown/SVG 视图模式切换（render/source[/split]）
 *   - viewport：  Browser 视口切换（desktop/tablet/mobile）
 *   - copy：      复制内容（图片/兜底复制路径）
 *   - export：    下载为文件
 *   - reveal：    在文件夹中显示
 *   - refresh：   重新读取文件内容
 * 渲染器内部状态（代码换行 / 图片缩放 / 表格排序）由各渲染器自带迷你工具条承担。
 * ============================================================ */
import type { ComponentType } from 'react'
import type { RendererKind } from '../../store'
import { MarkdownRenderer } from './renderers/MarkdownRenderer'
import { CodeRenderer } from './renderers/CodeRenderer'
import { ImageRenderer } from './renderers/ImageRenderer'
import { SvgRenderer } from './renderers/SvgRenderer'
import { TableRenderer } from './renderers/TableRenderer'
import { BrowserRenderer } from './renderers/BrowserRenderer'
import { FallbackRenderer } from './renderers/FallbackRenderer'

export interface RendererEntry {
  component: ComponentType<Record<string, unknown>>
  /** i18n 资源键（preview.registry.*），由组件 t() 渲染显示名 */
  labelKey: string
  toolbarActions: string[]
}

export const RENDERER_REGISTRY: Record<RendererKind, RendererEntry> = {
  markdown: {
    component: MarkdownRenderer as unknown as ComponentType<Record<string, unknown>>,
    labelKey: 'preview.registry.markdown',
    toolbarActions: ['mode-switch', 'copy', 'export', 'reveal', 'refresh'],
  },
  code: {
    component: CodeRenderer as unknown as ComponentType<Record<string, unknown>>,
    labelKey: 'preview.registry.code',
    toolbarActions: ['copy', 'export', 'reveal', 'refresh'],
  },
  image: {
    component: ImageRenderer as unknown as ComponentType<Record<string, unknown>>,
    labelKey: 'preview.registry.image',
    toolbarActions: ['copy', 'reveal', 'refresh'],
  },
  svg: {
    component: SvgRenderer as unknown as ComponentType<Record<string, unknown>>,
    labelKey: 'preview.registry.svg',
    toolbarActions: ['mode-switch', 'copy', 'export', 'reveal', 'refresh'],
  },
  table: {
    component: TableRenderer as unknown as ComponentType<Record<string, unknown>>,
    labelKey: 'preview.registry.table',
    toolbarActions: ['copy', 'export', 'reveal', 'refresh'],
  },
  browser: {
    component: BrowserRenderer as unknown as ComponentType<Record<string, unknown>>,
    labelKey: 'preview.registry.browser',
    toolbarActions: ['viewport', 'refresh'],
  },
  fallback: {
    component: FallbackRenderer as unknown as ComponentType<Record<string, unknown>>,
    labelKey: 'preview.registry.fallback',
    toolbarActions: ['reveal'],
  },
}

/** 各渲染器的可选视图模式（供 mode-switch / viewport 渲染分段控件） */
export const VIEW_MODES: Partial<Record<RendererKind, { value: string; labelKey: string }[]>> = {
  markdown: [
    { value: 'render', labelKey: 'preview.registry.mode.render' },
    { value: 'source', labelKey: 'preview.registry.mode.source' },
    { value: 'split', labelKey: 'preview.registry.mode.split' },
  ],
  svg: [
    { value: 'render', labelKey: 'preview.registry.mode.render' },
    { value: 'source', labelKey: 'preview.registry.mode.source' },
  ],
  browser: [
    { value: 'desktop', labelKey: 'preview.registry.mode.desktop' },
    { value: 'tablet', labelKey: 'preview.registry.mode.tablet' },
    { value: 'mobile', labelKey: 'preview.registry.mode.mobile' },
  ],
}

/** 渲染器默认视图模式 */
export function defaultViewMode(kind: RendererKind): string | undefined {
  return VIEW_MODES[kind]?.[0]?.value
}
