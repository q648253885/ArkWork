/* ============================================================
 * ArkWork — Builtin Skill: browser
 * v0.24.1 — agent 可自主驱动的内置浏览器工具
 *
 * 借鉴 opencode / deepseek harness 的 browser 工具模型：
 * 让 agent 在 ArkWork 的内置浏览器（右栏 BrowserPanel 的 webview）中
 * 自主打开网页 / 本地 HTML，执行 JS 探测、读取 console（找 JS 错误）、
 * 截图留证，实现「网页相关内容由 agent 自行测试与跟进验证」。
 *
 * 子动作（action）：
 *   open       —— 打开 URL 或本地 HTML 文件（相对工作区路径或绝对路径）
 *   eval       —— 在页面内执行 JS（返回结果；用于探测 DOM / 触发交互 / 断言）
 *   snapshot   —— 页面快照：标题 / URL / 正文文本 / 画布状态
 *   console    —— 读取页面 console 日志（重点关注 error / warn）
 *   screenshot —— 截图保存 PNG（file 省略时存 .arkwork/browser-shots/）
 *   close      —— 结束浏览器会话
 *
 * 典型测试链路（示例）：
 *   browser(open path="index.html") → browser(console) → browser(eval js="...")
 *   → browser(snapshot) → browser(screenshot file="docs/verify.png") → browser(close)
 * ============================================================ */
import type { SkillContext } from '../registry.js'
import {
  browserOpen,
  browserEval,
  browserSnapshot,
  browserConsoleLogs,
  browserScreenshot,
  browserClose,
  browserSessionInfo,
  type BrowserTarget,
} from '../../browser/controller.js'
import { logger } from '../../system/logger.js'

export interface BrowserArgs {
  action: 'open' | 'eval' | 'snapshot' | 'console' | 'screenshot' | 'close'
  /** open：URL 或本地路径 */
  url?: string
  path?: string
  /** eval：要执行的 JS 表达式 / 语句（建议返回可序列化值或字符串） */
  js?: string
  /** screenshot：保存路径（相对工作区或绝对路径；省略则存 .arkwork/browser-shots/） */
  file?: string
  /** console：最多返回条数 */
  limit?: number
}

export interface BrowserResult {
  action: string
  ok: boolean
  summary: string
  url?: string
  result?: unknown
  console?: Array<{ level: string; message: string; line: number }>
  path?: string
  bytes?: number
  opened?: boolean
  error?: string
}

export async function browser(args: BrowserArgs, ctx: SkillContext): Promise<BrowserResult> {
  const action = args.action
  if (!action) throw new Error('browser: action 不能为空（open/eval/snapshot/console/screenshot/close）')
  logger.info('Tool', `browser:${action}`, ctx.taskId)

  switch (action) {
    case 'open': {
      let target: BrowserTarget
      if (args.url && /^https?:\/\//i.test(args.url)) {
        target = { kind: 'url', url: args.url }
      } else if (args.path) {
        target = { kind: 'file', path: args.path }
      } else if (args.url) {
        // 无协议但像路径 → 视为本地文件
        target = { kind: 'file', path: args.url }
      } else {
        throw new Error('browser.open: 需要 url 或 path')
      }
      const { url } = await browserOpen(target)
      return { action, ok: true, summary: `已打开 ${url}`, url }
    }

    case 'eval': {
      if (!args.js) throw new Error('browser.eval: 需要 js 参数')
      const result = await browserEval(args.js)
      const short = result.length > 800 ? `${result.slice(0, 800)}…（共 ${result.length} 字符）` : result
      return { action, ok: true, summary: short, result }
    }

    case 'snapshot': {
      const snap = await browserSnapshot()
      if (snap.ok === false) {
        return { action, ok: false, summary: String(snap.error ?? '快照失败'), error: String(snap.error ?? '') }
      }
      const summary = `标题「${snap.title ?? ''}」· ${snap.url ?? ''} · 正文 ${String(snap.bodyText ?? '').length} 字符 · ${snap.hasCanvas ? `画布 ${(snap.canvas as { w?: number } | null)?.w}x${(snap.canvas as { h?: number } | null)?.h}` : '无画布'}`
      return { action, ok: true, summary, result: snap }
    }

    case 'console': {
      const logs = browserConsoleLogs(Math.min(args.limit ?? 100, 200))
      const errors = logs.filter((l) => l.level === 'error' || l.level === 'warning')
      const summary = `共 ${logs.length} 条 console 日志，其中 error/warn ${errors.length} 条`
      return { action, ok: true, summary, console: logs.slice(-50) }
    }

    case 'screenshot': {
      const { path, bytes } = await browserScreenshot(args.file)
      return { action, ok: true, summary: `截图已保存：${path}（${bytes} bytes）`, path, bytes }
    }

    case 'close': {
      const info = browserSessionInfo()
      const r = browserClose()
      return { action, ok: true, summary: `浏览器会话已结束（原打开：${info.opened ? info.url : '否'}）`, ...r }
    }

    default:
      throw new Error(`browser: 未知 action「${String(action)}」`)
  }
}
