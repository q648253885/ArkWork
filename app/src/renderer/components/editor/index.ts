/* ============================================================
 * ArkWork — Editor 目录出口（B2）
 * 设计文档 docs/versions/v0.31.0/04-system-design.md §3.3 硬规则 1 / §3.5
 *
 * **`components/editor/` 是全仓库唯一允许 import `@codemirror/*` 的目录**。
 * 其它任何组件（含 PreviewWindow / registry）只能通过本出口的懒加载组件触达 CM6，
 * 否则 CM6 会被并进 renderer 主 chunk，分包验收（§1.2）失败。
 * ============================================================ */
import { lazy } from 'react'

/**
 * 懒加载的编辑器面板。
 * `registry.ts` 的 `RENDERER_REGISTRY.editor.component` 必须指向本组件，
 * **不能**改成静态 import —— 那是「主 chunk 被 CM6 污染」的唯一成因。
 */
export const LazyEditorPanel = lazy(() => import('./EditorPanel'))

export { LazyEditorPanel as EditorPanel }
