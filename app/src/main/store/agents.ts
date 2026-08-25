/* ============================================================
 * ArkWork — Agent / Model Store
 * 设计文档 §10.1 / v0.6.0 §4.1（F3 Agent CRUD）
 *
 * v0.6.0 新增：
 *  - addAgent：创建自定义 Agent，生成 id（@{name-slug}），写入 agents.json
 *  - updateAgent：更新 Agent 字段；内置 Agent 仅允许改非人格字段（skillIds/mcpIds/config）
 *  - removeAgent：删除 Agent；内置 Agent 抛错
 *  - 内存缓存失效机制：CRUD 后清空 listAgents 缓存
 * ============================================================ */
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { getArkworkDir } from './db.js'
import type { Agent, LlmModel } from '@shared/types/agent'
import type { AgentAddInput } from '@shared/types/ipc'
import { builtinAgents, builtinModels } from './seed.js'
import { logger } from '../system/logger.js'
import { getUiLocale, tFor } from '../i18n/messages.js'

export interface BuiltinAgent {
  id: '@general' | '@coding'
  description: string
  defaultSkillIds: string[]
}

export const builtinAgentRegistry: BuiltinAgent[] = [
  {
    id: '@general',
    description:
      '通用办公 Agent：擅长文档撰写、信息检索、行业调研、数据分析、对话问答；不擅长代码编写与重构。适合一句话直达的轻量任务。它能够整理会议纪要、撰写邮件与方案、提炼资料要点、比较信息来源、解释表格数据并生成清晰结论；面对无需修改代码仓库、无需运行测试、无需进行系统架构设计的日常知识工作时，应优先选择该 Agent。',
    defaultSkillIds: ['S-core.file-reader', 'S-core.web-search', 'S-core.fetch-url', 'S-core.kb-search'],
  },
  {
    id: '@coding',
    description:
      '编码 Agent：擅长代码编写、重构、测试、架构设计、Bug 修复；关联 spec / plan / bugfix 内置编码技能。适合需要多步、可分解、可验证目标的编码任务。它能够阅读项目结构、定位实现、修改源文件、执行构建与测试、分析报错并验证修复结果；当任务涉及仓库改动、接口实现、性能优化、依赖配置、代码评审或技术方案落地时，应优先选择该 Agent。',
    defaultSkillIds: ['S-core.file-reader', 'S-core.shell', 'S-core.spec', 'S-core.plan', 'S-core.bugfix'],
  },
]

export type ManualAgentOverride = BuiltinAgent['id'] | 'auto'

let manualAgentOverride: ManualAgentOverride = 'auto'

export function getManualAgentOverride(): ManualAgentOverride {
  return manualAgentOverride
}

export function setManualAgentOverride(value: ManualAgentOverride): ManualAgentOverride {
  if (value !== 'auto' && value !== '@general' && value !== '@coding') {
    throw new Error(tFor(getUiLocale(), 'agents.invalidOverride', { value: String(value) }))
  }
  manualAgentOverride = value
  return manualAgentOverride
}

let cachedAgents: Agent[] | null = null

/** 列出所有 Agent（内置 + 自定义） */
export async function listAgents(): Promise<Agent[]> {
  if (cachedAgents) return cachedAgents
  const path = join(getArkworkDir(), 'agents.json')
  if (!existsSync(path)) {
    cachedAgents = builtinAgents
    return cachedAgents
  }
  try {
    const raw = await readFile(path, 'utf-8')
    cachedAgents = JSON.parse(raw) as Agent[]
  } catch {
    cachedAgents = builtinAgents
  }
  return cachedAgents
}

export async function getAgent(id: string): Promise<Agent | null> {
  // v0.16.7：兼容老命名（@general/@coding → @default/@coder）。早期 builtinAgentRegistry
  // 使用 @general/@coding，但 seed.ts 实际写入 @default/@coder；route-agent / spec /
  // plan / bugfix 仍按 @general/@coding 查找。这里做 alias 转发，避免「Agent 不存在」。
  const idAliases: Record<string, string> = {
    '@general': '@default',
    '@coding': '@coder',
  }
  const resolvedId = idAliases[id] ?? id
  const agents = await listAgents()
  return agents.find((a) => a.id === resolvedId) ?? null
}

/**
 * 创建自定义 Agent。
 * @param input - Agent 字段（不含 id/isBuiltin/version）
 * @returns 创建的 Agent（含生成的 id）
 * 错误场景：
 *  - name 为空 → throw
 *  - id 或 name 与已存在 Agent 重复 → throw
 */
export async function addAgent(input: AgentAddInput): Promise<Agent> {
  if (!input.name?.trim()) {
    throw new Error(tFor(getUiLocale(), 'agents.nameRequired'))
  }
  const agents = await listAgents()
  // id 生成：优先用传入的 id，否则基于 name 生成
  const id = input.id?.trim() || generateAgentId(input.name, agents)
  if (agents.find((a) => a.id === id)) {
    throw new Error(tFor(getUiLocale(), 'agents.idExists', { id }))
  }
  if (agents.find((a) => a.name === input.name)) {
    throw new Error(tFor(getUiLocale(), 'agents.nameExists', { name: input.name }))
  }
  const agent: Agent = {
    ...input,
    id,
    isBuiltin: false,
    version: '0.8.0',
    source: 'custom',
    // v0.8.0 F822：记忆域缺省全开
    memoryScope: input.memoryScope ?? {
      useProfile: true,
      skillMemory: true,
    },
  }
  const next = [...agents, agent]
  await writeAgents(next)
  cachedAgents = next
  logger.info('System', `agent created: ${agent.id} (@${agent.name})`)
  return agent
}

/**
 * 更新 Agent。
 * @param id - Agent id
 * @param patch - 要更新的字段
 * @returns 更新后的 Agent
 * 错误场景：
 *  - 不存在 → throw
 *  - 内置 Agent 试图改 name → throw（名称为标识符，不可改）
 *  - 内置 Agent 试图移除固有技能（defaultSkillIds 中原有项被删除）→ throw
 *  - 写入失败 → throw
 *
 * v0.8.0 变更：内置 Agent（通用助手）现可编辑人格字段（systemPrompt/role/goal/backstory/styleGuide），
 *             也可新增固有能力（defaultSkillIds 只增不减），但不可删除原有固有技能。
 */
export async function updateAgent(id: string, patch: Partial<Agent>): Promise<Agent> {
  const agents = await listAgents()
  const idx = agents.findIndex((a) => a.id === id)
  if (idx < 0) throw new Error(tFor(getUiLocale(), 'agents.notFound', { id }))
  const existing = agents[idx]
  // 内置 Agent 保护：name 不可改（标识符）
  if (existing.isBuiltin && patch.name !== undefined && patch.name !== existing.name) {
    throw new Error(tFor(getUiLocale(), 'agents.builtinNameLocked', { name: existing.name }))
  }
  // 内置 Agent 保护：固有技能只增不减
  if (existing.isBuiltin && patch.defaultSkillIds !== undefined) {
    const originalSkillIds = new Set(existing.defaultSkillIds)
    const removed = existing.defaultSkillIds.filter((sid) => !patch.defaultSkillIds!.includes(sid))
    if (removed.length > 0) {
      throw new Error(tFor(getUiLocale(), 'agents.builtinSkillsLocked', { ids: removed.join(', ') }))
    }
  }
  // 不允许通过 patch 改 id / isBuiltin / source
  const { id: _omitId, isBuiltin: _omitBuiltin, source: _omitSource, ...safePatch } = patch
  const updated: Agent = {
    ...existing,
    ...safePatch,
    id: existing.id,
    isBuiltin: existing.isBuiltin,
    source: existing.source,
    version: '0.8.0',
  }
  agents[idx] = updated
  await writeAgents(agents)
  cachedAgents = agents
  logger.info('System', `agent updated: ${updated.id}`)
  return updated
}

/**
 * 删除 Agent。
 * @param id - Agent id
 * 错误场景：
 *  - 不存在 → throw
 *  - 内置 Agent → throw
 */
export async function removeAgent(id: string): Promise<void> {
  const agents = await listAgents()
  const idx = agents.findIndex((a) => a.id === id)
  if (idx < 0) throw new Error(tFor(getUiLocale(), 'agents.notFound', { id }))
  if (agents[idx].isBuiltin) {
    throw new Error(tFor(getUiLocale(), 'agents.builtinDeleteLocked', { id }))
  }
  const next = agents.filter((a) => a.id !== id)
  await writeAgents(next)
  cachedAgents = next
  logger.info('System', `agent removed: ${id}`)
}

/** 失效缓存（外部修改 agents.json 后调用） */
export function invalidateAgentCache(): void {
  cachedAgents = null
}

async function writeAgents(agents: Agent[]): Promise<void> {
  const path = join(getArkworkDir(), 'agents.json')
  await writeFile(path, JSON.stringify(agents, null, 2), 'utf-8')
}

/**
 * 生成 Agent id：@{name-slug}
 * name-slug = name 转小写、空格转连字符、去特殊字符、截断到 20 字符
 * 若冲突则追加数字后缀（-2, -3...）
 */
function generateAgentId(name: string, existing: Agent[]): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 20) || 'agent'
  let id = `@${slug}`
  let n = 2
  while (existing.find((a) => a.id === id)) {
    id = `@${slug}-${n}`
    n++
  }
  return id
}

/* ============================================================
 * Model Store（原有逻辑，未改动）
 * ============================================================ */

export async function listModels(): Promise<LlmModel[]> {
  const path = join(getArkworkDir(), 'models.json')
  if (!existsSync(path)) return builtinModels
  try {
    const raw = await readFile(path, 'utf-8')
    return JSON.parse(raw) as LlmModel[]
  } catch {
    return builtinModels
  }
}

export async function getModel(id: string): Promise<LlmModel | null> {
  const models = await listModels()
  return models.find((m) => m.id === id) ?? null
}
