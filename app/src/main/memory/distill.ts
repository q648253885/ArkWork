/* ============================================================
 * ArkWork — 记忆转化管线：蒸馏（v0.8.0 F805 §7.2 / Task 10 自动触发）
 * 任务 done 时按规模门槛评估触发 → 命中则自动蒸馏（不再征询用户）：
 *   - 门槛（任一）：主题观察 ≥10 / 跨会话复用 ≥5 / L2 条目 ≥50 / L2 体积 >1MB /
 *     L1/L2 存在超过 ttlDays 天的临时条目（时限触发）。
 *   - 完成后自动晋升 L3/L4（知识库 / 技能 / 用户画像），原始 L1/L2 临时条目删除
 *     （"转完删除对应内容"）。
 *   - UI 只收到一条轻量完成提示（distill_completed 事件），普通使用不再弹
 *     "是否需要蒸馏"建议卡。
 * 蒸馏草稿生成用 LLM（"distill-experience" 概念上是对用户不可见的内置 skill，
 * 实现上直接调 LLM，避免污染 skill registry）。
 * 失败静默降级为仅归档（不阻塞任务完成）。
 * 设计文档：versions/v0.8.0/01-memory.md §7
 * ============================================================ */
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { getWorkspaceDir, getTaskMemoryDir, getTaskDir } from '../store/db.js'
import { getAdapter } from '../llm/registry.js'
import { logger } from '../system/logger.js'
import { addPendingLine } from './l3-curated.js'
import { synthesizeFromTaskL1 } from './l4-profile.js'
import { listL1 } from './l1-working.js'
import { convertToKb } from './convert.js'
import type { MemoryItem, DistillDraft } from '@shared/types/memory'

/* ============================================================
 * v0.25.0 F3 重写要点（设计文档 §5）：
 *  - 关闭 reuseCount ≥5 蒸技能分支（distill.ts 旧 evaluateDistillTrigger 内 elif）
 *  - 关闭 evaluateCompactionDistillTrigger 整函数（空 transcript 蒸技能，已在 §5.1 删除）
 *  - 关闭 clearDistilledSources 的全部调用（L1/L2 不再因蒸馏被删除，由既有压缩/归档策略管理）
 *  - 蒸馏类别仅保留 facts / observations；skill 类别一律改走 skill-forge 管线
 *  - L1 不再是蒸馏源；L2 仅作为技能候选的合法来源，且必须经 forge 五阶段校验
 * ============================================================ */

export const DISTILL_THRESHOLDS = {
  /** 同一主题/关键词的观察累计门槛 */
  topicObservations: 10,
  /** L2 条目（步骤产物文件）总量门槛 */
  l2Count: 50,
  /** L2 文件体积门槛 */
  l2Bytes: 1024 * 1024,
  /** L1/L2 临时条目的时限（天）：超过即自动参与蒸馏或清理 */
  ttlDays: 7,
} as const

/** 触发评估输入 */
export interface DistillTriggerContext {
  taskId: string
  l1Items: MemoryItem[]
  /** 工具调用次数（Act 阶段次数） */
  toolCallCount: number
  /** 是否发生过排错成功（先失败后成功） */
  hadErrorRecovery: boolean
  /** 是否有用户纠正（续聊中用户指出错误） */
  hadUserCorrection: boolean
  /** 是否有偏好表达（用户消息含"我喜欢/不要/请用…"等） */
  hadPreferenceExpression: boolean
  /** 同一主题/关键词的 L2/L1 观察累计次数 */
  topicObservationCount?: number
  /** 当前任务 L2 文件总字节数 */
  l2Bytes?: number
  /** 当前任务 L2 条目（步骤产物文件）总数 */
  l2Count?: number
  /** 超过时限（ttlDays）的 L1 观察条数（自动参与蒸馏/清理） */
  staleL1Count?: number
  /** L2 步骤目录中最老文件距今的天数（0 = 无 L2 文件） */
  staleL2Days?: number
}

export interface DistillEvaluation {
  trigger: boolean
  reason: string
  /** v0.25.0 F3：蒸馏类别仅保留 facts / observations；skill 改走 skill-forge */
  category: 'facts' | 'observations' | null
}

export async function getDistillMetrics(
  taskId: string,
  l1Items: MemoryItem[],
): Promise<
  Pick<
    DistillTriggerContext,
    'topicObservationCount' | 'l2Bytes' | 'l2Count' | 'staleL1Count' | 'staleL2Days'
  >
> {
  const observations = l1Items.filter((m) => m.kind === 'observation' && !m.archivedAt)
  const topicCounts = new Map<string, number>()
  for (const item of observations) {
    const topic = item.meta?.trim().toLowerCase() || item.content.toLowerCase().split(/\s+/).slice(0, 3).join(' ')
    topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1)
  }
  // L1 时限：超过 ttlDays 天且未蒸馏的 observation 自动参与蒸馏/清理
  const ttlMs = DISTILL_THRESHOLDS.ttlDays * 24 * 60 * 60 * 1000
  const staleL1Count = observations.filter((m) => {
    if (!m.createdAt || m.distilled) return false
    return Date.now() - m.createdAt > ttlMs
  }).length
  const l2 = await getL2Stats(taskId)
  return {
    topicObservationCount: Math.max(0, ...topicCounts.values()),
    l2Bytes: l2.bytes,
    l2Count: l2.count,
    staleL1Count,
    staleL2Days: l2.oldestDays,
  }
}

export async function autoPromoteDistill(
  ctx: DistillTriggerContext,
  category: 'facts' | 'observations',
  modelId: string,
  draftOverride?: DistillDraft,
): Promise<string> {
  const draft = draftOverride ?? (await generateDistillDraft(ctx, category, modelId))
  // v0.25.0 F3：skill 类别禁用（已切到 skill-forge）；函数只处理 facts / observations
  if (draft.kind === 'observations' && draft.observations?.length) {
    for (const observation of draft.observations) {
      await addPendingLine('user.md', observation, ctx.taskId)
    }
    // F3：不再 clearDistilledSources —— L1 由既有压缩/归档策略管理
    logger.info('Memory', `automatic distill promoted ${draft.observations.length} profile observations`, ctx.taskId)
    return `已自动合并 ${draft.observations.length} 条用户画像观察`
  }
  if (draft.kind === 'facts' && draft.facts?.length) {
    const result = await convertToKb({
      kind: 'l1',
      taskId: ctx.taskId,
      content: draft.facts.map((fact) => `- ${fact}`).join('\\n'),
    })
    // F3：不再 clearDistilledSources —— L1 由既有压缩/归档策略管理
    logger.info('Memory', `automatic distill promoted to KB ${result.kbFileId}`, ctx.taskId)
    return '已自动合并到知识库'
  }
  return '自动蒸馏未提取到可晋升内容'
}

/** v0.25.0 F3：跨会话复用计数（旧 getReuseCount / REUSE_FILE）已废弃 —— 不再作为自动蒸馏触发条件；
 * 该指标仅保留供 UI 评估面板使用（不写入 distill-reuse.json、不参与触发判定）。
 * 如需恢复评估输入，应由调用方独立采集并传入 topicObservationCount。 */

/** L2 统计：字节数 / 条目（文件）总数 / 最老文件距今的天数（Task 10 时限） */
async function getL2Stats(taskId: string): Promise<{ bytes: number; count: number; oldestDays: number }> {
  const dir = join(getTaskDir(taskId), '.arkwork', 'steps')
  if (!existsSync(dir)) return { bytes: 0, count: 0, oldestDays: 0 }
  const names = await readdir(dir)
  let bytes = 0
  let count = 0
  let oldestMs = 0
  const now = Date.now()
  for (const name of names) {
    try {
      const st = await stat(join(dir, name))
      if (!st.isFile()) continue
      bytes += st.size
      count += 1
      oldestMs = Math.max(oldestMs, now - st.mtimeMs)
    } catch {
      // ignore files removed during a run
    }
  }
  return {
    bytes,
    count,
    oldestDays: oldestMs > 0 ? Math.floor(oldestMs / (24 * 60 * 60 * 1000)) : 0,
  }
}

async function clearDistilledSources(taskId: string, items: MemoryItem[]): Promise<void> {
  // v0.25.0 F3：禁用 —— L1/L2 不再因蒸馏被清除；保留 stub 以兼容历史外部引用。
  // 调用点已全部移除；如未来需要重做蒸馏清理，应改走 l1 archive + l2 retention 通道。
  void taskId
  void items
}

/**
 * 评估是否自动触发蒸馏（Task 10：仅按规模门槛，命中即后台自动执行，不再征询用户）。
 * v0.25.0 F3 精简：
 *  - 删 reuseCount ≥5 蒸技能分支（不再自动转技能；技能走 skill-forge）
 *  - 删 skill 类别（蒸馏类别仅 facts / observations）
 * 触发条件（任一命中）：
 *  - 同一主题/关键词的 L1/L2 观察累计 ≥ topicObservations
 *  - L2 条目总量 ≥ l2Count 或 L2 文件体积 > l2Bytes（L2 → L3 规模门槛）
 *  - L1/L2 存在超过 ttlDays 天的临时条目（时限触发）
 * 普通任务（工具调用多、有排错/纠正/偏好表达但不达规模）不会触发。
 * @param ctx - 触发上下文
 * @returns 是否触发 + 原因 + 蒸馏类别
 */
export async function evaluateDistillTrigger(
  ctx: DistillTriggerContext,
): Promise<DistillEvaluation> {
  let category: 'facts' | 'observations' | null = null
  let reason = ''

  if ((ctx.topicObservationCount ?? 0) >= DISTILL_THRESHOLDS.topicObservations) {
    category = ctx.hadPreferenceExpression ? 'observations' : 'facts'
    reason = `同一主题观察累计 ${ctx.topicObservationCount} 条，达到自动蒸馏门槛`
  } else if ((ctx.l2Count ?? 0) >= DISTILL_THRESHOLDS.l2Count) {
    category = ctx.hadPreferenceExpression ? 'observations' : 'facts'
    reason = `L2 条目总量 ${ctx.l2Count} 条，达到自动蒸馏门槛`
  } else if ((ctx.l2Bytes ?? 0) > DISTILL_THRESHOLDS.l2Bytes) {
    category = ctx.hadPreferenceExpression ? 'observations' : 'facts'
    reason = `L2 文件体积超过 ${DISTILL_THRESHOLDS.l2Bytes / 1024 / 1024}MB，已自动蒸馏`
  } else if ((ctx.staleL1Count ?? 0) > 0 || (ctx.staleL2Days ?? 0) >= DISTILL_THRESHOLDS.ttlDays) {
    category = 'facts'
    reason = `存在超过 ${DISTILL_THRESHOLDS.ttlDays} 天的 L1/L2 临时条目（L1 过期 ${ctx.staleL1Count ?? 0} 条 / L2 最老 ${ctx.staleL2Days ?? 0} 天），自动蒸馏并清理`
  }

  if (!category) {
    return { trigger: false, reason: '', category: null }
  }

  // 用户已通过 IPC 忽略的类别（memory:distill-dismiss）不再自动触发
  if (existsSync(dismissedPath())) {
    try {
      const ignored = JSON.parse(await readFile(dismissedPath(), 'utf-8')) as string[]
      if (Array.isArray(ignored) && ignored.includes(category)) {
        return { trigger: false, reason: '', category: null }
      }
    } catch {
      // 读取失败视为未忽略
    }
  }

  return { trigger: true, reason, category }
}

/** 用户忽略某类别蒸馏建议的落盘文件（{workspace}/.arkwork/distill-dismissed.json） */
const DISMISSED_FILE = 'distill-dismissed.json'

function dismissedPath(): string {
  return join(getWorkspaceDir(), '.arkwork', DISMISSED_FILE)
}

/**
 * 接受蒸馏草稿（memory:distill-accept）——复用 autoPromoteDistill 的晋升逻辑，
 * 把草稿落库为技能 / 用户画像观察 / 知识库，并清理已蒸馏的 L1/L2 源。
 */
export async function acceptDistillDraft(
  draft: DistillDraft,
  taskId: string,
  modelId: string,
): Promise<string> {
  // v0.25.0 F3：技能草稿不再走 autoPromoteDistill —— 应由 skill-forge 五阶段管线接管。
  if (draft.kind === 'skill') {
    return '技能草稿请走 skill-forge 管线（task-done 时机触发），不接受 L1 直接蒸馏'
  }
  const l1Items = await listL1(taskId)
  return autoPromoteDistill(
    {
      taskId,
      l1Items,
      toolCallCount: 0,
      hadErrorRecovery: false,
      hadUserCorrection: false,
      hadPreferenceExpression: false,
    },
    draft.kind,
    modelId,
    draft,
  )
}

/**
 * 忽略某类别蒸馏建议（memory:distill-dismiss）——持久化记录，
 * 后续自动蒸馏评估不再对该类别触发。
 */
export async function dismissDistillDraft(category: string): Promise<void> {
  const path = dismissedPath()
  let ignored: string[] = []
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf-8')) as unknown
      if (Array.isArray(parsed)) ignored = parsed.filter((x): x is string => typeof x === 'string')
    } catch {
      ignored = []
    }
  }
  if (!ignored.includes(category)) {
    ignored.push(category)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(ignored, null, 2), 'utf-8')
  }
}

/**
 * 生成蒸馏草稿——用 LLM 从 L1 提取事实/提取观察。
 * v0.25.0 F3：skill 类别由 skill-forge 接管，不再在本函数中生成（详见设计文档 §5.3）。
 * @param ctx - 触发上下文
 * @param category - 蒸馏类别（仅 facts / observations）
 * @param modelId - 用于草稿生成的模型
 * @returns 蒸馏草稿
 */
export async function generateDistillDraft(
  ctx: DistillTriggerContext,
  category: 'facts' | 'observations',
  modelId: string,
): Promise<DistillDraft> {
  const transcript = buildTranscript(ctx.l1Items)
  const adapter = await getAdapter(modelId)

  if (category === 'observations') {
    const observations = await draftObservations(transcript, adapter)
    return { kind: 'observations', observations, triggerReason: '偏好表达提取' }
  }
  // facts
  const facts = await draftFacts(transcript, adapter)
  return { kind: 'facts', facts, triggerReason: '可复用事实提取' }
}

/** 把 L1 条目拼成对话记录供 LLM 分析（仅 facts/observations 用；技能改走 skill-forge） */
function buildTranscript(items: MemoryItem[]): string {
  return items
    .filter((m) => !m.archivedAt && m.kind !== 'system_prompt')
    .map((m) => `[${m.role}/${m.kind}] ${m.content.slice(0, 600)}`)
    .join('\n')
    .slice(0, 8000)
}

async function draftFacts(
  transcript: string,
  adapter: Awaited<ReturnType<typeof getAdapter>>,
): Promise<string[]> {
  const resp = await adapter.complete({
    system:
      '你是经验蒸馏助手。从以下任务对话中提取可复用的事实（技术发现、配置要点、踩坑结论）。\n' +
      '以 JSON 字符串数组返回，每条一句话，如 ["发现 X 库的 Y API 需要显式传 Z"]。无则返回 []。',
    messages: [{ role: 'user', content: transcript }],
    temperature: 0.2,
    maxTokens: 500,
  })
  return parseStringArray(resp.content)
}

async function draftObservations(
  transcript: string,
  adapter: Awaited<ReturnType<typeof getAdapter>>,
): Promise<string[]> {
  const resp = await adapter.complete({
    system:
      '你是用户画像分析助手。从以下任务对话中提取用户的偏好与习惯表达。\n' +
      '以 JSON 字符串数组返回，每条一句话，如 ["偏好要点式回答", "习惯用 TypeScript"]。无则返回 []。',
    messages: [{ role: 'user', content: transcript }],
    temperature: 0.2,
    maxTokens: 400,
  })
  return parseStringArray(resp.content)
}

function parseStringArray(raw: string): string[] {
  try {
    const start = raw.indexOf('[')
    const end = raw.lastIndexOf(']')
    if (start < 0 || end < 0) return []
    const arr = JSON.parse(raw.slice(start, end + 1)) as unknown
    if (!Array.isArray(arr)) return []
    return arr.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
  } catch {
    return []
  }
}

// 复用：L4a 合成入口（供 engine 在 run done 时直接调用，避免循环依赖）
export { synthesizeFromTaskL1 }
