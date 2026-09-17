/* ============================================================
 * ArkWork — Shared Utils: Path Predicates（v0.31.0 B2 修复新增）
 * 只放**纯函数**（§3.3 规则 4：`shared/` 仅类型 + 纯函数）。
 *
 * 为什么 renderer 需要这个谓词：
 *   `.arkwork` 是 agent 自身内容区 —— 写盘一律 `E_ARKWORK_RESERVED`（§7.2），
 *   且在 `WATCH_IGNORE` 内（§5.2 的 `fs:list-paths`）。它**不是可编辑工作集**。
 *   但它在**工作区之内**，而 `readonlyReason` 的七个原因里没有对应项
 *   （deleted / outside-workspace / binary / too-large / permission /
 *    agent-writing / non-utf8）—— 于是一个 `.arkwork` 下的产物文件会探成
 *   「可编辑」。若不拦，用户能在编辑器里改一个**永远存不下去**的文件：
 *   一路写到 `Mod+S` 才收到 `E_ARKWORK_RESERVED` toast，属「静默陷阱」。
 *
 * 与 `main/fs/guard.isInArkworkArea(root, target)` 的区别（**不可互相替代**）：
 *   - 那个是**基于 root 的相对路径首段判定**，语义是「工作区顶层那个 .arkwork」，
 *     用于写盘边界 —— 嵌套的 `src/.arkwork/` 不该被它命中。
 *   - 本函数**无 root、按路径段判定**，语义是「路径里含 .arkwork 段」，
 *     供**没有 root 上下文**的调用方（B2 的 renderer：`fsSlice.root` 尚为 null）
 *     做保守拦截 —— 宁可多拦（退化为只读渲染），不可放过（放出存不下去的编辑器）。
 * ============================================================ */

/** agent 自身内容区目录名。**全仓库唯一定义**（`main/fs/guard` 从此处引用） */
export const ARKWORK_DIRNAME = '.arkwork'

/**
 * 纯函数：路径是否含 `.arkwork` 路径段。
 * - 跨平台：按 `/` 与 `\` 双分隔符切分（不依赖 `node:path`，renderer 可用）
 * - 不做 `realpath`（renderer 无 fs 权限）；symlink 逃逸由 main 侧 guard 负责
 * - 结尾为 `.arkwork` 且无后续段（如 `/x/.arkwork`）也判命中
 */
export function isArkworkInternal(p: string): boolean {
  return p.split(/[\\/]/).includes(ARKWORK_DIRNAME)
}
