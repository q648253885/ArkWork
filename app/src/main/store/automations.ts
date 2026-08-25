/* ============================================================
 * ArkWork — Automation Store
 * 触发器驱动的 Agent 自动执行规则
 *
 * 持久化：{arkworkDir}/automations.json（单文件 JSON 数组）
 * v1：trigger='manual' 由用户手动触发 run；trigger='cron' 由 cronExpr 定时触发。
 * runAutomation 解析有效 Agent（getAgent）与 defaultModelId，调用
 * tasks.createTask 创建任务，再用 agent/runner.runTask 真正启动引擎。
 *
 * v0.9.1 §Task 6：
 *  - addAutomation 增加 getAgent 校验（拒绝不存在的 Agent）
 *  - writeAutomations 改为 tmp + rename 原子写（防止崩溃半截 JSON）
 *  - runAutomation 解析 agent.skillIds / agent.defaultModelId 与 mcpIds，
 *    并把 mcpIds → skillIds 注入，让 createTask 携带完整资源
 *  - runTask 异常不再被吞，向上 throw → IPC 自动回传 Renderer
 * ============================================================ */
import { join, dirname } from 'node:path'
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { getArkworkDir } from './db.js'
import { createTask } from './tasks.js'
import { isValidCron, nextCronTime } from '../automation/cron.js'
import { getAgent, getModel } from './agents.js'
import type { Automation } from '@shared/types/conversation'
import type { AutomationCreateInput } from '@shared/types/ipc'
import { genId } from '@shared/utils/id'
import { logger } from '../system/logger.js'
// v0.29.0 F6：用户可见校验错误四语言化
import { getUiLocale, tFor } from '../i18n/messages.js'

function automationsPath(): string {
  return join(getArkworkDir(), 'automations.json')
}

async function readAutomations(): Promise<Automation[]> {
  const path = automationsPath()
  if (!existsSync(path)) return []
  try {
    const raw = await readFile(path, 'utf-8')
    const data = JSON.parse(raw) as Automation[]
    return Array.isArray(data) ? data : []
  } catch (err) {
    console.error(`[store] failed to read ${path}:`, err)
    return []
  }
}

/**
 * 原子写：先写临时文件，再 rename 替换（POSIX rename 原子）。
 * 防止崩溃或被杀进程时留下半截 JSON 导致整组自动化丢失。
 */
async function writeAutomations(items: Automation[]): Promise<void> {
  const path = automationsPath()
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
  const payload = JSON.stringify(items, null, 2)
  await writeFile(tmp, payload, 'utf-8')
  await rename(tmp, path)
}

/** 列出所有自动化规则（按创建时间倒序）；v0.9.1：cron 且 active 的规则附带下次触发时间 */
export async function listAutomations(): Promise<Automation[]> {
  const items = await readAutomations()
  const sorted = items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
  return sorted.map((a) => {
    if (a.trigger === 'cron' && a.cronExpr && a.status === 'active') {
      const next = nextCronTime(a.cronExpr)
      return { ...a, nextRun: next ? next.toISOString() : undefined }
    }
    return a
  })
}

export async function getAutomation(id: string): Promise<Automation | null> {
  const items = await readAutomations()
  return items.find((a) => a.id === id) ?? null
}

/**
 * 新建自动化规则。
 * v0.9.1 §Task 6：增加 getAgent 校验——不接受 agentId 指向不存在 Agent 的自动化，
 * 否则后续 runAutomation 会抛 "Agent not found"，且无法在列表中感知问题。
 * @param input - Automation 字段（不含 id / createdAt / lastRun）
 * @returns 创建的 Automation
 * 错误：name 为空 / agentId 为空 / Agent 不存在 / prompt 为空 / cron 表达式无效
 */
export async function addAutomation(input: AutomationCreateInput): Promise<Automation> {
  if (!input.name?.trim()) {
    throw new Error(tFor(getUiLocale(), 'auto.nameRequired'))
  }
  if (!input.agentId?.trim()) {
    throw new Error(tFor(getUiLocale(), 'auto.agentRequired'))
  }
  // §Task 6：先验证 Agent 真实存在——避免下游 runAutomation 失败
  const agent = await getAgent(input.agentId)
  if (!agent) {
    throw new Error(tFor(getUiLocale(), 'auto.agentNotFoundHint', { id: input.agentId }))
  }
  if (!input.prompt?.trim()) {
    throw new Error(tFor(getUiLocale(), 'auto.promptRequired'))
  }
  if (input.trigger === 'cron') {
    if (!input.cronExpr?.trim()) {
      throw new Error(tFor(getUiLocale(), 'auto.cronRequired'))
    }
    if (!isValidCron(input.cronExpr.trim())) {
      throw new Error(tFor(getUiLocale(), 'auto.cronInvalid', { expr: input.cronExpr }))
    }
  }
  const items = await readAutomations()
  const automation: Automation = {
    id: input.id?.trim() || genId('auto'),
    name: input.name.trim(),
    agentId: input.agentId,
    prompt: input.prompt,
    trigger: input.trigger,
    cronExpr: input.trigger === 'cron' ? input.cronExpr : undefined,
    status: input.status ?? 'active',
    createdAt: new Date().toISOString(),
    modelId: input.modelId,
  }
  const next = [...items, automation]
  await writeAutomations(next)
  logger.info('System', `automation created: ${automation.id} "${automation.name}"`)
  return automation
}

/**
 * 更新自动化规则字段。
 * @param id - Automation id
 * @param patch - 要更新的字段（id / createdAt 不允许通过 patch 改）
 * @returns 更新后的 Automation
 * 错误：不存在 / Agent 不存在 / trigger='cron' 未提供 cronExpr / cron 表达式无效
 */
export async function updateAutomation(
  id: string,
  patch: Partial<Automation>,
): Promise<Automation> {
  const items = await readAutomations()
  const idx = items.findIndex((a) => a.id === id)
  if (idx < 0) throw new Error(tFor(getUiLocale(), 'auto.notFound', { id }))
  const existing = items[idx]
  const { id: _omitId, createdAt: _omitCreatedAt, ...safePatch } = patch
  const trigger = safePatch.trigger ?? existing.trigger
  const cronExpr = safePatch.cronExpr ?? existing.cronExpr
  if (trigger === 'cron') {
    if (!cronExpr?.trim()) {
      throw new Error(tFor(getUiLocale(), 'auto.cronRequired'))
    }
    if (!isValidCron(cronExpr.trim())) {
      throw new Error(tFor(getUiLocale(), 'auto.cronInvalid', { expr: cronExpr }))
    }
  }
  // 若 patch 含 agentId，校验 Agent 真实存在
  if (safePatch.agentId && safePatch.agentId !== existing.agentId) {
    const agent = await getAgent(safePatch.agentId)
    if (!agent) throw new Error(tFor(getUiLocale(), 'agents.notFound', { id: safePatch.agentId }))
  }
  const updated: Automation = {
    ...existing,
    ...safePatch,
    id: existing.id,
    createdAt: existing.createdAt,
    trigger,
    cronExpr: trigger === 'cron' ? cronExpr : undefined,
  }
  items[idx] = updated
  await writeAutomations(items)
  logger.info('System', `automation updated: ${updated.id}`)
  return updated
}

/** 删除自动化规则。 */
export async function removeAutomation(id: string): Promise<void> {
  const items = await readAutomations()
  const next = items.filter((a) => a.id !== id)
  await writeAutomations(next)
  logger.info('System', `automation removed: ${id}`)
}

/**
 * 触发运行：解析 agent 真实资源（skillIds / defaultModelId / mcpIds），
 * 创建任务并立即启动 ReAct。异常不再静默吞——向上 throw 让 IPC 返回真实失败，
 * Renderer 用 friendlyError 分类展示（如 noModel / noAgent）。
 *
 * 错误：
 *  - automation 不存在 / 已暂停
 *  - Agent 不存在（理论上 addAutomation 已拦住，这里仍然防御）
 *  - Agent 没有有效模型（getModel 返回 null）→ Error("noModel: ...")，让 UI 提示
 *  - runTask 启动失败（runner 内部异常透传）
 */
export async function runAutomation(id: string): Promise<{ taskId: string }> {
  const automation = await getAutomation(id)
  if (!automation) throw new Error(tFor(getUiLocale(), 'auto.notFound', { id }))
  if (automation.status === 'paused') {
    throw new Error(tFor(getUiLocale(), 'auto.paused', { id }))
  }
  const agent = await getAgent(automation.agentId)
  if (!agent) {
    throw new Error(tFor(getUiLocale(), 'auto.noAgent', { id: automation.agentId }))
  }

  // §Task 6：解析并透传 Agent 的真实资源
  // 合并 agent 默认 skills 与 defaultMcpIds（mcp 对应的 skill 在 invoke 时由 registry 路由）
  const agentSkillIds = [...new Set([...(agent.defaultSkillIds ?? []), ...(agent.defaultMcpIds ?? [])])]
  // 模型：自动化专属 modelId → Agent 默认 → 全局默认；均无则报错，由 UI 引导用户在设置中配置
  let modelId = automation.modelId
  if (!modelId) modelId = agent.defaultModelId
  if (!modelId) {
    try {
      const { getSettings } = await import('../ipc/settings.js')
      const settings = await getSettings()
      modelId = settings.defaultModelId ?? ''
    } catch {
      modelId = ''
    }
  }
  if (!modelId) {
    throw new Error(tFor(getUiLocale(), 'auto.noModelSetup'))
  }
  // 二次确认模型存在（getModel 抛错让错误信息更具体）
  const model = await getModel(modelId)
  if (!model || !model.enabled) {
    throw new Error(tFor(getUiLocale(), 'auto.noModelUnavailable', { modelId }))
  }

  const task = await createTask({
    title: automation.name,
    text: automation.prompt,
    agentId: automation.agentId,
    skillIds: agentSkillIds,
    modelId,
    automationId: automation.id,
  })

  // 记录最近一次运行时间
  const items = await readAutomations()
  const idx = items.findIndex((a) => a.id === id)
  if (idx >= 0) {
    items[idx] = { ...items[idx], lastRun: new Date().toISOString() }
    await writeAutomations(items)
  }

  // §Task 6：runTask 异常不再被吞——向上抛出让 IPC 把真实错误带回 Renderer，
  // Renderer 通过 friendlyError 识别 noModel / noAgent / 通用错误并提示用户
  const { runTask } = await import('../agent/runner.js')
  await runTask(task.id)

  logger.info('System', `automation run: ${id} → task ${task.id} (started)`)
  return { taskId: task.id }
}
