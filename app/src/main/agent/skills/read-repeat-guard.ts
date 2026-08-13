/**
 * v0.16.6+ 重复读检测器
 *
 * 用户原话：「读文件工具的限制应该仅限于一直读重复的文件才进行干预」。
 *
 * 设计：
 *  - 维护一张 key → { count, firstReadAt } 的 Map（按 taskId 隔离）
 *  - key = "<tool>:<signature>"，signature = 把路径/pattern/maxLines 等参数规范化后的字符串
 *  - 第一次调用返回 null（放行 + 计数）
 *  - 第 N+1 次相同 signature 调用返回"已读 N 次"提示，但不阻断，让 Agent 自己判断
 *  - 阈值：file-reader / grep-search / glob-search 连续 3 次相同参数触发提示
 *  - 故意不阻断：用户允许 Agent 在需要时"再看一眼"；只是提醒它已经看过了
 *
 * 这个模块同时给 file-reader / grep-search / glob-search / file-editor 共用。
 */
import type { SkillContext } from '../registry.js'

export interface RepeatReadOptions {
  /** 触发提示的重复次数阈值（默认 3） */
  threshold?: number
}

interface RepeatEntry {
  count: number
  firstReadAt: number
  lastWarnedAt: number
  lastSignature: string
}

/** 内部 Map：taskId → (signature → entry) */
const taskMaps = new WeakMap<object, Map<string, RepeatEntry>>()

/**
 * 检查本次调用是否构成「重复读」。返回：
 *  - null = 第一次或差异调用，放行
 *  - string = 命中重复，给出提示语（不阻断，工具仍执行）
 */
export function checkRepeatRead(
  ctx: SkillContext,
  tool: 'file-reader' | 'grep-search' | 'glob-search',
  signature: Record<string, unknown>,
  options: RepeatReadOptions = {},
): string | null {
  const threshold = options.threshold ?? 3
  const sig = stableSignature(signature)
  if (!sig) return null

  let map = taskMaps.get(ctx as object)
  if (!map) {
    map = new Map()
    taskMaps.set(ctx as object, map)
  }

  const now = Date.now()
  const entry = map.get(sig)
  if (!entry) {
    map.set(sig, { count: 1, firstReadAt: now, lastWarnedAt: 0, lastSignature: sig })
    return null
  }
  entry.count += 1
  if (entry.count <= threshold) return null
  // 阈值后：每 60 秒最多提示一次，避免刷屏
  if (now - entry.lastWarnedAt < 60_000) return null
  entry.lastWarnedAt = now
  return formatHint(tool, entry.count, sig)
}

/** 清空某 task 的所有读文件记录（如任务结束 / pause） */
export function clearRepeatReadMap(ctx: SkillContext): void {
  taskMaps.delete(ctx as object)
}

function stableSignature(signature: Record<string, unknown>): string | null {
  const keys = Object.keys(signature).sort()
  if (!keys.length) return null
  // 过滤 undefined / null
  const parts: string[] = []
  for (const k of keys) {
    const v = signature[k]
    if (v === undefined || v === null) continue
    parts.push(`${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
  }
  if (!parts.length) return null
  return parts.join('|')
}

function formatHint(tool: string, count: number, sig: string): string {
  return (
    `[重复读警告] ${tool} 已对相同 signature 调用 ${count} 次：` +
    sig +
    `。重复读同一内容不会带来新信息。请思考：\n` +
    `  1) 你已经从这次阅读里得到所需信息了吗？\n` +
    `  2) 如果是新需求（如起新分支 / 写新模块），先写代码 / 写测试 / 跑实测，不要再读同一文件。\n` +
    `  3) 若需要"对照最近一次修改"做 diff，应改用 file-editor 或 git diff，不要整体重读。`
  )
}