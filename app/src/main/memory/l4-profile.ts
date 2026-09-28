/* ============================================================
 * ArkWork — L4a 用户画像（v0.8.0 F804）
 * 辩证合成循环：任务 done → 从 L1 提取画像观察 → 本地 LLM 合成 → 版本 +1。
 * 文件：{workspace}/.arkwork/profile.json
 * 结构沿用 v0.7.0 类型（version / synthesis / traits / observations / history 保留 10 版）。
 * 注入：synthesis（≤500 tokens）随 L3a 在 run 启动时注入；智能体可通过
 *       memoryScope.useProfile 关闭（见 03 文档）。
 * 设计文档：versions/v0.8.0/01-memory.md §6
 * ============================================================ */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { agentSpaceDir } from './agent-space.js'
import { genId } from '@shared/utils/id'
import { getAdapter } from '../llm/registry.js'
import { logger } from '../system/logger.js'
import { broadcast } from '../window.js'
import type {
  UserProfile,
  ProfileObservation,
  MemoryItem,
} from '@shared/types/memory'

function profilePath(): string {
  // ★ v0.36.0（决策 D1）：L4a 用户画像是「这个人的画像」，不随工作区走 ——
  // 换项目不该让 Agent 忘了用户是谁。旧位置由 agent-space.ts 首启迁移。
  return join(agentSpaceDir(), 'profile.json')
}

const DEFAULT_PROFILE: UserProfile = {
  version: 0,
  synthesis: '',
  traits: [],
  observations: [],
  history: [],
}

/** 画像 synthesis 字符预算（≈500 tokens，混合中英文字符约 1,800） */
const SYNTHESIS_BUDGET = 1800
/** 历史版本保留上限 */
const HISTORY_KEEP = 10

/* ============================================================
 * ★ v0.36.3：周期合成口径（设计文档 §4.2「L4 定期写入口径」）
 *
 * 为什么画像不能每次 task-done 都重写：画像是一次**辩证合成**（LLM 读旧画像 +
 * 全部观察 → 新画像），每次收尾都跑一遍会带来三个真问题：
 *  ① 同一批观察反复参与合成，画像被反复"推着走"，稳定性差（用户会觉得它变了）；
 *  ② 每个任务多一次长上下文 LLM 调用，纯为「几乎不变的内容」付费；
 *  ③ history 保留 10 版 → 一天跑十个任务就把真正的历史版本挤没了。
 *
 * 口径（任一满足即合成，否则跳过并在 detail 记明「未到周期」）：
 *  ① 从未合成过；② 距上次合成 ≥24h；③ 上次合成后累计完成 ≥5 个任务。
 * ============================================================ */

/** 周期阈值 */
export const L4_CYCLE = {
  /** 时间周期：24 小时 */
  ms: 24 * 60 * 60 * 1000,
  /** 任务数周期：5 个任务 */
  tasks: 5,
} as const

export interface ProfileCycleDecision {
  /** 本次是否该合成 */
  run: boolean
  /** 人话说明（无论跑不跑都要能说清为什么） */
  detail: string
  /** 记账后的状态（已落盘） */
  lastSynthesizedAt: number | null
  tasksSinceSynthesis: number
}

/**
 * 周期判定 + 记账：每次 task-done 调一次。
 * **会计入一个任务**（连「跳过」也计数），命中周期则 run:true（由调用方去合成）。
 * 未命中时立即落盘计数 —— 否则进程中断会让计数丢失，画像永远等不到第 5 个任务；
 * 命中时由合成流程重置（`synthesizeFromTaskL1` 成功则 lastSynthesizedAt=now、计数归零）。
 * @param now - 当前时间（测试注入）
 */
export async function evaluateProfileCycle(now: number = Date.now()): Promise<ProfileCycleDecision> {
  const p = await getProfile()
  const last = p.lastSynthesizedAt ?? null
  const tasks = (p.tasksSinceSynthesis ?? 0) + 1

  const firstTime = last === null && p.version === 0
  const byTime = last !== null && now - last >= L4_CYCLE.ms
  const byTasks = tasks >= L4_CYCLE.tasks

  if (firstTime || byTime || byTasks) {
    const why = firstTime
      ? '首次合成'
      : byTime
        ? `距上次 ${Math.round((now - (last as number)) / 3600000)}h ≥ 24h`
        : `累计 ${tasks} 个任务 ≥ ${L4_CYCLE.tasks}`
    return { run: true, detail: `命中周期（${why}）`, lastSynthesizedAt: last, tasksSinceSynthesis: tasks }
  }

  const hours = last === null ? '从未' : `${Math.round((now - last) / 3600000)}h`
  const next: UserProfile = { ...p, tasksSinceSynthesis: tasks }
  await writeProfile(next)
  return {
    run: false,
    detail: `未到周期（已 ${hours} / 已 ${tasks} 任务）`,
    lastSynthesizedAt: last,
    tasksSinceSynthesis: tasks,
  }
}

/**
 * 读取用户画像——run 启动注入与面板展示共用。
 */
export async function getProfile(): Promise<UserProfile> {
  const path = profilePath()
  if (!existsSync(path)) return { ...DEFAULT_PROFILE }
  try {
    const raw = await readFile(path, 'utf-8')
    const p = JSON.parse(raw) as UserProfile
    return { ...DEFAULT_PROFILE, ...p }
  } catch {
    return { ...DEFAULT_PROFILE }
  }
}

async function writeProfile(profile: UserProfile): Promise<void> {
  await mkdir(dirname(profilePath()), { recursive: true })
  await writeFile(profilePath(), JSON.stringify(profile, null, 2), 'utf-8')
  broadcast('memory:changed', '')
}

/** 手动编辑 synthesis（MemoryPanel 内编辑，立即生效） */
export async function updateSynthesis(text: string): Promise<UserProfile> {
  const p = await getProfile()
  const next = { ...p, synthesis: text }
  await writeProfile(next)
  logger.info('Memory', `L4a synthesis updated (${text.length} chars)`)
  return next
}

/** 删除单条观察 */
export async function deleteObservation(id: string): Promise<UserProfile> {
  const p = await getProfile()
  const next = { ...p, observations: p.observations.filter((o) => o.id !== id) }
  await writeProfile(next)
  return next
}

/** 回滚到历史版本——把指定历史快照设为当前 synthesis，并推一份当前到 history */
export async function rollbackHistory(version: number): Promise<UserProfile> {
  const p = await getProfile()
  const target = p.history.find((h) => h.version === version)
  if (!target) return p
  const next: UserProfile = {
    ...p,
    synthesis: target.snapshot,
    version: p.version + 1,
    history: [
      { version: p.version, snapshot: p.synthesis, archivedAt: Date.now() },
      ...p.history,
    ].slice(0, HISTORY_KEEP),
  }
  await writeProfile(next)
  logger.info('Memory', `L4a rolled back to v${version}, now v${next.version}`)
  return next
}

export interface SynthesizeResult {
  profile: UserProfile
  newObservations: number
  synthesisUpdated: boolean
}

/**
 * 辩证合成——任务 done 后调用。
 * 1. 从 L1 提取候选片段（user_message + 含用户纠正的 reasoning）；
 * 2. LLM 抽取画像观察（偏好/纠正/风格反馈）；
 * 3. LLM 合成「旧 synthesis + 新观察」→ 版本 +1；
 * 4. 旧 synthesis 推入 history（保留 10 版）。
 * 全程失败静默降级（不影响任务 done）。
 * @param taskId
 * @param l1Items - 该任务全部 L1 条目
 * @param modelId - 用于抽取与合成的模型
 */
export async function synthesizeFromTaskL1(
  taskId: string,
  l1Items: MemoryItem[],
  modelId: string,
): Promise<SynthesizeResult> {
  const profile = await getProfile()
  const candidates = pickObservationCandidates(l1Items)
  if (candidates.length === 0) {
    return { profile, newObservations: 0, synthesisUpdated: false }
  }

  try {
    // 1. LLM 抽取观察
    const observations = await extractObservations(candidates, modelId)
    if (observations.length === 0) {
      return { profile, newObservations: 0, synthesisUpdated: false }
    }
    const newObs: ProfileObservation[] = observations.map((text) => ({
      id: genId('obs'),
      text,
      sourceTaskId: taskId,
      createdAt: Date.now(),
      merged: false,
    }))

    // 2. LLM 合成新 synthesis
    const oldSynthesis = profile.synthesis
    const newSynthesis = await synthesizeProfile(oldSynthesis, [...profile.observations, ...newObs], modelId)

    // 3. 版本 +1，推旧版本入 history
    const historyEntry = {
      version: profile.version,
      snapshot: oldSynthesis,
      archivedAt: Date.now(),
    }
    const next: UserProfile = {
      version: profile.version + 1,
      synthesis: newSynthesis,
      traits: profile.traits,
      observations: [...profile.observations, ...newObs],
      history: [historyEntry, ...profile.history].slice(0, HISTORY_KEEP),
      // ★ v0.36.3：合成成功即重置周期记账（下次合成要等 24h 或再攒 5 个任务）
      lastSynthesizedAt: Date.now(),
      tasksSinceSynthesis: 0,
    }
    await writeProfile(next)
    logger.info('Memory', `L4a synthesized v${next.version} (+${newObs.length} obs)`, taskId)
    return { profile: next, newObservations: newObs.length, synthesisUpdated: true }
  } catch (err) {
    logger.warn('Memory', `L4a synthesis failed (silent): ${(err as Error).message}`, taskId)
    return { profile, newObservations: 0, synthesisUpdated: false }
  }
}

/** 从 L1 挑选可能含画像信号的候选条目（user_message + reasoning） */
function pickObservationCandidates(items: MemoryItem[]): MemoryItem[] {
  return items.filter(
    (m) =>
      !m.archivedAt &&
      (m.kind === 'user_message' || m.kind === 'reasoning') &&
      m.content.trim().length > 0,
  )
}

/** LLM 抽取画像观察——返回观察文本数组 */
async function extractObservations(
  candidates: MemoryItem[],
  modelId: string,
): Promise<string[]> {
  const adapter = await getAdapter(modelId)
  const transcript = candidates
    .map((m) => `[${m.role}/${m.kind}] ${m.content.slice(0, 800)}`)
    .join('\n')
    .slice(0, 6000)
  const resp = await adapter.complete({
    system:
      '你是用户画像分析助手。从以下任务对话片段中，提取用户表达的偏好、纠正意见、风格反馈。\n' +
      '只提取明确的画像信号，忽略普通任务指令。\n' +
      '以 JSON 字符串数组形式返回，如 ["偏好简洁回答", "纠正了某个错误"]。无则返回 []。',
    messages: [{ role: 'user', content: transcript }],
    temperature: 0.2,
    maxTokens: 400,
  })
  return parseStringArray(resp.content)
}

/** LLM 合成新画像 synthesis */
async function synthesizeProfile(
  oldSynthesis: string,
  observations: ProfileObservation[],
  modelId: string,
): Promise<string> {
  const adapter = await getAdapter(modelId)
  const obsText = observations.map((o) => `- ${o.text}`).join('\n')
  const resp = await adapter.complete({
    system:
      '你是用户画像合成助手。基于旧画像与新增观察，辩证合成新的用户画像描述（≤500 tokens）。\n' +
      '保留稳定特征，吸收新观察，矛盾时以最新观察为准。\n直接输出画像描述文本，不要解释。',
    messages: [
      {
        role: 'user',
        content: `## 旧画像\n${oldSynthesis || '（空）'}\n\n## 全部观察\n${obsText}`,
      },
    ],
    temperature: 0.3,
    maxTokens: 800,
  })
  const synthesis = resp.content.trim()
  if (!synthesis) return oldSynthesis
  // 超预算尾部截断
  return synthesis.length > SYNTHESIS_BUDGET ? synthesis.slice(0, SYNTHESIS_BUDGET) : synthesis
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
