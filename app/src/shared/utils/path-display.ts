/* ============================================================
 * ArkWork — 展示层路径工具（v0.33.1 W3 · 纯函数）
 *
 * 为什么在 shared：Windows 反斜杠路径的展示是**两端共同的坑** ——
 * main 侧工具卡（present.ts）与 renderer 侧文件名/页签（fsSlice、
 * ArtifactCard、PreviewWindow…）都在展示路径，且既有实现大量
 * `split('/')`，Windows 绝对路径（`D:\a\b\c.ts`）整串直出或 basename
 * 失效。展示口径必须单源，故下沉 shared（零依赖、可密闭单测）。
 *
 * 纪律：这些函数**只用于展示**，返回值不得回传给任何 fs/IPC 调用
 * （数据层路径保持模型/系统原样）。
 * ============================================================ */

/**
 * basename：同时认 POSIX `/` 与 Windows `\`（以及混合分隔符）。
 * 空串/纯分隔符 → 原样返回。
 */
export function baseNameOf(p: string): string {
  const s = String(p ?? '')
  const parts = s.split(/[/\\]/).filter(Boolean)
  if (parts.length === 0) return s
  return parts[parts.length - 1]!
}

/**
 * 目录名（basename 的对偶）：取最后一段之前的整串（保留原分隔符形态）。
 * 无上级 → 返回空串。
 */
export function dirNameOf(p: string): string {
  const s = String(p ?? '')
  const idx = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  return idx > 0 ? s.slice(0, idx) : ''
}

/**
 * 缩短长路径：保留尾部 `keepTail` 字符（从分隔符边界对齐），超出部分用 `…` 前缀。
 * 短于阈值原样返回。用于工具卡标题等「可读性优先」的展示位。
 */
export function shortPathOf(p: string, keepTail = 56): string {
  const s = String(p ?? '')
  if (s.length <= keepTail) return s
  const tail = s.slice(-keepTail)
  // 从尾部对齐到分隔符边界，避免截出半截文件名
  const cut = tail.search(/[/\\]/)
  return cut > 0 ? '…' + tail.slice(cut + 1) : '…' + tail
}
