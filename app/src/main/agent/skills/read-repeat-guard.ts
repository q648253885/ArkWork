/**
 * v0.24.0 重复读检测器（升级自 v0.16.6 的 warn-only 版本）
 *
 * v0.23.x 实测（T-20260817-106u4s：105 轮 / 132 工具 / 1.56M tokens 修一行 bug）
 * 证明 warn-only 不够：同文件读 5-6 次、同关键词 grep 3+ 次，且旧版 hint 字段
 * 从未被 buildObservationSummary 消费，警告根本没到模型眼里。
 *
 * 新设计（三级判决）：
 *  - 第 1-2 次：pass 放行（正常探索）
 *  - 第 3 次：  warn  放行执行，但观察文本前置警告（真正送达模型）
 *  - 第 4 次起：block 不再执行，直接返回「缓存内容头 + 行动指令」，
 *              强制 Agent 停止重读、开始写代码/验证
 *  - file-editor / file-writer 写入成功后调用 invalidateReadsOf(path)
 *    清除该路径记录，保证「编辑后合法重读」不受影响
 */
import type { SkillContext } from '../registry.js'

export type RepeatVerdict =
  | { action: 'pass' }
  | { action: 'warn'; hint: string }
  | { action: 'block'; observation: string }

export interface RepeatReadOptions {
  /** warn 阈值（第 N 次触发警告，默认 3） */
  warnThreshold?: number
  /** block 阈值（第 N 次起拦截，默认 4） */
  blockThreshold?: number
}

interface RepeatEntry {
  count: number
  firstReadAt: number
  lastContentHead: string
}

/** 内部 Map：taskId → (signature → entry) */
const taskMaps = new WeakMap<object, Map<string, RepeatEntry>>()

function mapOf(ctx: SkillContext): Map<string, RepeatEntry> {
  let map = taskMaps.get(ctx as object)
  if (!map) {
    map = new Map()
    taskMaps.set(ctx as object, map)
  }
  return map
}

/**
 * 三级判决。signature 建议只含「决定内容等价性」的字段
 * （路径 / pattern / 分页参数），不含会漂移的临时字段。
 */
export function checkRepeatRead(
  ctx: SkillContext,
  tool: 'file-reader' | 'grep-search' | 'glob-search',
  signature: Record<string, unknown>,
  options: RepeatReadOptions = {},
): RepeatVerdict {
  const warnAt = options.warnThreshold ?? 3
  const blockAt = options.blockThreshold ?? 4
  const sig = stableSignature(signature)
  if (!sig) return { action: 'pass' }

  const map = mapOf(ctx)
  const entry = map.get(sig)
  if (!entry) {
    map.set(sig, { count: 1, firstReadAt: Date.now(), lastContentHead: '' })
    return { action: 'pass' }
  }
  entry.count += 1
  if (entry.count < warnAt) return { action: 'pass' }
  if (entry.count < blockAt) {
    return {
      action: 'warn',
      hint: `[重复读警告] 这是第 ${entry.count} 次对相同目标调用 ${tool}（${sig}）。重复读不会带来新信息。请基于上文已有内容直接行动：编辑文件 / 写代码 / 运行验证。`,
    }
  }
  return {
    action: 'block',
    observation: [
      `[已拦截] ${tool} 对相同目标（${sig}）已调用 ${entry.count} 次，本次不再执行。`,
      entry.lastContentHead
        ? `上次结果开头（内容已在你的上下文里）：\n${entry.lastContentHead}`
        : '上次结果已在你的上下文里。',
      '',
      '你现在必须行动，禁止继续读取/搜索相同目标：',
      '  1) 基于已有信息直接编辑目标文件（file-editor / file-writer）；',
      '  2) 或运行验证命令（shell）确认现状；',
      '  3) 若信息确实不足，换一个【不同的】文件或【不同的】关键词，不要重复本次调用。',
    ].join('\n'),
  }
}

/** skill 执行成功后记录内容头（前 600 字符），block 时回带给模型 */
export function recordRepeatResult(
  ctx: SkillContext,
  tool: 'file-reader' | 'grep-search' | 'glob-search',
  signature: Record<string, unknown>,
  content: string,
): void {
  const sig = stableSignature(signature)
  if (!sig) return
  const entry = mapOf(ctx).get(sig)
  if (entry) entry.lastContentHead = content.slice(0, 600)
}

/**
 * 文件被写入/编辑后清除相关读记录，保证「改完重读验证」合法。
 * path 匹配规则：签名里含该 path 子串的条目全部清除。
 */
export function invalidateReadsOf(ctx: SkillContext, path: string): void {
  if (!path) return
  const map = taskMaps.get(ctx as object)
  if (!map) return
  const p = path.replaceAll('\\', '/')
  for (const sig of map.keys()) {
    if (sig.includes(p)) map.delete(sig)
  }
}

/** 清空某 task 的所有读文件记录（如任务结束 / pause） */
export function clearRepeatReadMap(ctx: SkillContext): void {
  taskMaps.delete(ctx as object)
}

function stableSignature(signature: Record<string, unknown>): string | null {
  const keys = Object.keys(signature).sort()
  if (!keys.length) return null
  const parts: string[] = []
  for (const k of keys) {
    const v = signature[k]
    if (v === undefined || v === null || v === '') continue
    parts.push(`${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
  }
  if (!parts.length) return null
  return parts.join('|')
}
