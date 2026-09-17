/* ============================================================
 * ArkWork — Renderer Service: EditorSession（编辑器瞬时交接缓存）
 * 设计文档 docs/versions/v0.31.0/04-system-design.md §5.4.3 · 正本 J12
 *
 * 为什么需要这一层：正本 J12 明确规定**文本不进 store**（文本真源是 CM6 EditorState）。
 * 但 `fs:read-text` 的结果必须交到 `CodeEditorHost` 的 `initialText` 上，
 * 且 Tab 切换（宿主卸载/重挂）后还要能恢复撤销栈。
 * 因此这两类数据放在 store 之外的模块级缓存里：
 *
 *  - `initialTexts`  —— 打开时的初始文本（openDoc 写入；宿主卸载时刷新为
 *                        当前缓冲，供只读预览 / 冲突对比取「最新所见」；closeDoc 清除）
 *  - `editorStates`  —— 宿主卸载时 `handle.toJSON()` 的快照（切回时 `fromJSON` 恢复）
 *
 * 纪律：这两个 Map 都**不是**状态源；任何 UI 分支都不得以它们为渲染依据
 * （渲染依据永远是 `fsSlice.docs`）。closeDoc 时必须成对清理，避免泄漏。
 * ============================================================ */

const initialTexts = new Map<string, string>()
const editorStates = new Map<string, unknown>()

/** openDoc 成功后写入（仅一次） */
export function putInitialText(path: string, text: string): void {
  initialTexts.set(path, text)
}

/** 非删除式读取：宿主可能因 Tab 切换反复挂载 */
export function peekInitialText(path: string): string | undefined {
  return initialTexts.get(path)
}

export function putEditorState(path: string, state: unknown): void {
  editorStates.set(path, state)
}

export function peekEditorState(path: string): unknown {
  return editorStates.get(path)
}

/** 单个文档的缓存清理（closeDoc / 还原磁盘后调用） */
export function clearEditorSession(path: string): void {
  initialTexts.delete(path)
  editorStates.delete(path)
}

export function clearAllEditorSessions(): void {
  initialTexts.clear()
  editorStates.clear()
}

/** 诊断 / 测试用：当前持有的交接缓存条数 */
export function editorSessionSizes(): { initialTexts: number; editorStates: number } {
  return { initialTexts: initialTexts.size, editorStates: editorStates.size }
}
