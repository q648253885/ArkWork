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

/** 内部 Map：taskId → (signature → entry)
 *
 * v0.34.4（D70）：**这里曾经是 `WeakMap<object, …>`，键是 `ctx` 对象身份 —— 这是本条守卫
 * 自 v0.24.0 起在生产上完全失效的根因。**
 *
 * 为什么失效：`SkillContext` 由 `act.ts:414` 在 `executeAct()` 内部**每次工具调用新建**
 * （对象里含 `iteration` 等逐次变化的字段，不可能复用）；`WeakMap` 按对象身份取值
 * ⇒ 每次调用都命中不到上一次的 bucket，计数恒为 1 ⇒ 永远停在 `pass`。
 *
 * 真机证据（t1 · T-20260919-6c3v48，51 轮空转）：
 *   · 同一文件 `docs/v1.0/00-release-goal.md` 被**成功读取 9 次**（两种写法各 5/4 次）；
 *   · 出题人本意是第 4 次起 block —— 实际是 0 次 warn、0 次 block；
 *   · `session.jsonl` 383 条事件里 `重复读警告` / `已拦截` 出现次数 = **0 / 0**。
 *
 * 为什么用例没拦住：`read-repeat-guard.test.ts` 用**模块级单例** `const ctx = {taskId:'test'}`
 * 复用同一个对象，测的是「意图」而非「接线」—— 与 v0.32.1 D38-a 的教训同型（纪律③）。
 *
 * 修正：键改为**稳定标识 `taskId`**（`SkillContext.taskId` 为必填 string）。
 * 因改为强引用 Map，配套加**空闲过期 + 上限淘汰**，避免跨任务无界增长
 * （`clearRepeatReadMap` 在生产代码里从未被调用，不能指望它兜底）。
 */
const MAX_TASKS = 64
/** 空闲多久视为任务已结束，可回收（毫秒） */
const TASK_IDLE_MS = 30 * 60 * 1000

interface TaskBucket {
  map: Map<string, RepeatEntry>
  lastTouchedAt: number
}

const taskMaps = new Map<string, TaskBucket>()

/** 任务标识：优先 taskId；缺失时归入同一兜底桶（宁可多拦，不可漏拦） */
function keyOf(ctx: SkillContext): string {
  const id = (ctx as { taskId?: unknown }).taskId
  return typeof id === 'string' && id ? id : '__no_task__'
}

function pruneIdle(): void {
  const now = Date.now()
  for (const [k, b] of taskMaps) {
    if (now - b.lastTouchedAt > TASK_IDLE_MS) taskMaps.delete(k)
  }
  if (taskMaps.size <= MAX_TASKS) return
  // 仍超上限 → 按最后触碰时间淘汰最旧的（Map 保持插入序，但 lastTouchedAt 更准）
  const byAge = [...taskMaps.entries()].sort((a, b) => a[1].lastTouchedAt - b[1].lastTouchedAt)
  for (let i = 0; i < byAge.length - MAX_TASKS; i++) taskMaps.delete(byAge[i][0])
}

function mapOf(ctx: SkillContext): Map<string, RepeatEntry> {
  pruneIdle()
  const k = keyOf(ctx)
  let bucket = taskMaps.get(k)
  if (!bucket) {
    bucket = { map: new Map(), lastTouchedAt: 0 }
    taskMaps.set(k, bucket)
  }
  bucket.lastTouchedAt = Date.now()
  return bucket.map
}

/** 仅供测试：当前登记的桶数（验证有界性） */
export function repeatGuardBucketCount(): number {
  return taskMaps.size
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
  const bucket = taskMaps.get(keyOf(ctx))
  if (!bucket) return
  const p = path.replaceAll('\\', '/')
  for (const sig of bucket.map.keys()) {
    if (sig.includes(p)) bucket.map.delete(sig)
  }
}

/** 清空某 task 的所有读文件记录（如任务结束 / pause） */
export function clearRepeatReadMap(ctx: SkillContext): void {
  taskMaps.delete(keyOf(ctx))
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
