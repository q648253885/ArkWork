/* ============================================================
 * ArkWork — Renderer Service: Preview Tabs（v0.31.0 B2 修复新增）
 * 设计文档 docs/versions/v0.31.0/04-system-design.md §5.4.3（openDoc）/ §3.3 规则 3
 *
 * 抽成纯模块的理由与 `store/settle.ts` 同：`uiSlice` 顶层读 `import.meta.env`，
 * Node 下无法实例化，故把**可判定不变量**下沉为纯函数，用例从「源码正则」
 * 升级为「行为断言」。
 *
 * 它守住的不变量只有一条，但它是**正确性**而非外观问题：
 *   **同一文件路径在浮窗里只能有一个 Tab。**
 *   两个 Tab 指向同一 path ⇒ 两个 `CodeEditorHost` 各自实例化 CM6 ⇒
 *   两次 `registerEditorHandle(path, handle)`，Map 按路径键唯一 ⇒ **后者覆盖前者**。
 *   结果是「在 A Tab 按保存，写出去的却是 B Tab 的缓冲」，且任一侧卸载时
 *   `unregisterEditorHandle(path)` 会把另一侧还在用的 handle 一并删掉
 *   （保存退化为 `skipped: no-handle`）。修法只能是源头去重。
 * ============================================================ */

/** `PreviewTab.target` 的结构子集（避免依赖 store 的具体类型，保持本模块零依赖） */
export interface TabTargetLike {
  kind: string
  path?: string
}

export interface TabLike {
  id: string
  target: TabTargetLike
}

/**
 * 纯函数：在已打开的 Tab 中，按**文件路径**找可复用的那一个。
 *
 * - 只匹配 `target.kind === 'file'`：URL Tab（`kind: 'url'`）不参与去重 ——
 *   同一网址开两个浏览器 Tab 是有意义的行为，保持「每次新建」。
 * - 空路径（`''`，`⌘E` 占位入口建的 file Tab）也按值参与匹配：
 *   多处重复打开空 Tab 同样无意义，复用更符合预期。
 * - 命中多个时返回**第一个**（去重应保证不会再出现多个；返回首个是确定性行为，
 *   便于用例断言）。
 */
export function findFileTab<T extends TabLike>(tabs: readonly T[], path: string): T | undefined {
  return tabs.find((t) => t.target.kind === 'file' && (t.target.path ?? '') === path)
}
