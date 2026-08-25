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
import { getWorkspaceDir } from '../store/db.js'
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
  return join(getWorkspaceDir(), '.arkwork', 'profile.json')
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
