/* ============================================================
 * ArkWork — 渲染层 SAY 标记兜底剥离（v0.36.0 B11/P4-c）
 *
 * 为什么渲染层还要剥一次（主进程 say-marker.ts 已在落定期剥离）：
 *  ① 主进程解析只在 LLM 适配器落定期做，且**未闭合 / 变体标记时原样透传**
 *     （say-marker.ts 的「视为没输出」分支）——裸标记会经
 *     `derive-conversation` → AnswerBlock 以满亮度 markdown 直出（实机截图）；
 *  ② `task_complete` 的 `args.summary` 从未过 say-marker 解析；
 *  ③ 模型输出变体（`<<SAY>>>`、`<SAY>`、全角/书名号混淆等）漏网。
 *
 * 定位：**兜底**，与主进程解析不冲突 —— 正常路径标记已在适配器剥掉，
 * 本模块对无标记文本是恒等变换。必须是纯函数（node:test 可密闭单测）。
 * ============================================================ */

/** 宽松标记形状：1~4 个开括号（含书名号 «）+ SAY/END + 1~4 个闭括号（含 »） */
const PAIRED_RE = /<[<«]{0,3}\s*SAY\s*[>»]{0,3}>[\s\S]*?<[<«]{0,3}\s*END\s*[>»]{0,3}>/gi
/** 独占一行的裸标记（未闭合段残留） */
const LINE_RE = /^[ \t]*<[<«]{0,3}\s*(?:SAY|END)\s*[>»]{0,3}>[ \t]*$/gim
/** 行内残留裸标记 */
const INLINE_RE = /<[<«]{0,3}\s*(?:SAY|END)\s*[>»]{0,3}>/gi

/**
 * 剥离 `<<<SAY>>>…<<<END>>>` 协议标记（含变体）。
 * ① 配对段整体删除（该段语义 = 阶段叙述摘要，落定后由 SayBlock 承载；
 *    兜底路径没有解析器，留着只会重复/泄漏）；
 * ② 裸标记行 / 行内裸标记删除（未闭合场景，保内容、去标记）；
 * ③ 收敛 3 连以上空行与首尾空白（剥除段留下的空洞）。
 */
export function stripSayMarkers(text: string): string {
  if (!text) return text
  // 快速路径：绝大多数文本无任何标记形状，原样返回（恒等语义，零分配）
  if (!/<[<«]{0,3}\s*(?:SAY|END)\s*[>»]{0,3}>/i.test(text)) return text
  let out = text.replace(PAIRED_RE, '')
  out = out.replace(LINE_RE, '')
  out = out.replace(INLINE_RE, '')
  out = out.replace(/\n{3,}/g, '\n\n')
  return out.trim()
}
