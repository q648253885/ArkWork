/* ============================================================
 * ArkWork — 提示词契约（v0.25.0 F1 / 设计文档 §3.2）
 *
 * 原则：每一类进入 LLM 上下文的内容都必须登记契约，契约是唯一真源；
 * 装配器只按契约装配，未登记的内容无法进入上下文（启动断言兜底）。
 *
 * 与 prompt-assembly.ts 的关系：
 *   - contract.ts 提供契约类型 + 注册表 + 预算断言（本文件）
 *   - sections.ts 登记全部内容段的实现（含 always-on 技能段收集）
 *   - prompt-assembly.ts 保留旧版 buildSystemSections 纯函数（既有测试兼容），
 *     引擎主路径改为 assembleSystemPrompt（按契约装配）
 * ============================================================ */
import { estimateTokens } from '@shared/utils/id'
import { logger } from '../../system/logger.js'
import type { SystemPromptContext } from '../prompt-assembly.js'

/** 内容稳定性分级（决定能否进 system 前缀缓存区）。 */
export type ContentStability =
  | 'static'        // 跨任务稳定（如 core-rules）
  | 'agent-static'  // 同一 agent 稳定（如常驻技能指令体）→ 可进 system 前缀缓存区
  | 'run-static'    // 单次 run 内稳定（如 memoryInjection、workspace-context）
  | 'volatile'      // 每轮变化（如 plan_status、skill 按需指令）→ 禁止进 system

/** 注入槽位。 */
export type InjectSlot =
  | { kind: 'system' }             // 进 system message（仅 static/agent-static/run-static）
  | { kind: 'message-tail' }       // 追加到当轮消息尾部（瞬时）
  | { kind: 'standalone-message' } // 独立 user 消息（如 plan_status、skill_instruction）

/** 内容段契约（进入 LLM 上下文的唯一合法登记形态）。 */
export interface PromptSectionContract {
  /** 唯一段 id（如 'core-rules' / 'skill:react-core-skills' / 'memory' / 'user-input'） */
  id: string
  /** 段内排序权重（升序渲染） */
  order: number
  slot: InjectSlot
  stability: ContentStability
  /** 来源归属（衔接关系的单一真源） */
  owner: 'core' | 'agent' | 'skill' | 'memory' | 'kb' | 'user'
  /** 预算护栏（超限 warn 不阻断） */
  maxTokens: number
  /** 必含段缺失时装配断言失败 */
  required: boolean
  /** 构建段正文；null = 本段省略 */
  build(ctx: SystemPromptContext): Promise<string | null>
}

/* ---------- 注册表 ---------- */

const registry = new Map<string, PromptSectionContract>()

/**
 * 校验契约合法性（注册与 extras 装配共用）。
 * 错误场景：
 *  - slot=system 但 stability=volatile → throw（volatile 段进 system 会破坏前缀缓存）
 */
export function validatePromptSectionContract(contract: PromptSectionContract): void {
  if (contract.slot.kind === 'system' && contract.stability === 'volatile') {
    throw new Error(
      `[prompt-contract] section '${contract.id}' is volatile but targets system slot — volatile content must not enter system prompt`,
    )
  }
}

/**
 * 登记一个内容段契约。
 * 错误场景：
 *  - id 重复 → throw（契约 id 必须全局唯一）
 *  - slot=system 但 stability=volatile → throw
 */
export function registerPromptSection(contract: PromptSectionContract): void {
  if (registry.has(contract.id)) {
    throw new Error(`[prompt-contract] duplicate section id: ${contract.id}`)
  }
  validatePromptSectionContract(contract)
  registry.set(contract.id, contract)
}

/** 已登记契约（按注册序）。 */
export function getRegisteredPromptSections(): PromptSectionContract[] {
  return [...registry.values()]
}

/** 测试辅助：清空注册表。 */
export function resetPromptSectionRegistry(): void {
  registry.clear()
}

/* ---------- 预算断言 ---------- */

export interface SectionBudgetReport {
  id: string
  tokens: number
  maxTokens: number
  overBudget: boolean
}

/**
 * 估算并断言单段预算。
 * 职责：超预算 logger.warn（不阻断装配）；返回报告供 context_size_report 标红。
 */
export function assertSectionBudget(section: { id: string; text: string; maxTokens: number }): SectionBudgetReport {
  const tokens = estimateTokens(section.text)
  const overBudget = tokens > section.maxTokens
  if (overBudget) {
    logger.warn(
      'Agent',
      `[prompt-contract] section '${section.id}' over budget: ${tokens} tokens > max ${section.maxTokens}`,
    )
  }
  return { id: section.id, tokens, maxTokens: section.maxTokens, overBudget }
}
