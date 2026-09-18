/* ============================================================
 * ArkWork — 提示词内容段注册实现（v0.25.0 F1 / 设计文档 §3.2/§3.3）
 *
 * 全部进入 system 的内容段在此登记契约（模块加载即注册，契约是唯一真源）：
 *   workspace-context(-100) → core-rules(0) → personality(100)
 *   → skill:{id} 常驻技能段(150，运行期 extras) → workspace(200)
 *   → memory(300) → plan-constraint(500)
 *
 * 引擎主路径：run 启动时 collectAlwaysOnSections(agent) 收集常驻技能段 →
 * assembleSystemPrompt(ctx, extras) 装配一次 → 循环内复用（不再每轮重建）。
 * ============================================================ */
import type { Agent, PromptSection } from '@shared/types/agent'
import { readFile } from 'node:fs/promises'
import { getSkill } from '../registry.js'
import { buildWorkspaceContext } from '../workspace-context.js'
import { buildPersonalitySegment, type SystemPromptContext } from '../prompt-assembly.js'
import {
  registerPromptSection,
  getRegisteredPromptSections,
  validatePromptSectionContract,
  assertSectionBudget,
  type PromptSectionContract,
} from './contract.js'
import { loadSkillFrontmatter } from './gates.js'
import { logger } from '../../system/logger.js'

/** 各段排序权重（与旧 prompt-assembly ORDER 一一对应；skill 段插在 personality 之后）。 */
export const SECTION_ORDER = {
  workspaceContext: -100,
  coreRules: 0,
  personality: 100,
  alwaysOnSkill: 150,
  // v0.32.0 G2：工作台上下文（在常驻技能之后、工作区之前 —— 先认身份再看环境）
  profileContext: 180,
  workspace: 200,
  memory: 300,
  // v0.33.1 W1：SAY 阶段叙述协议（静态；在 plan-constraint 之前）
  narrationProtocol: 490,
  planConstraint: 500,
} as const

/* ---------- 基础六段注册（模块加载即生效） ---------- */

registerPromptSection({
  id: 'workspace-context',
  order: SECTION_ORDER.workspaceContext,
  slot: { kind: 'system' },
  stability: 'run-static',
  owner: 'core',
  maxTokens: 4000,
  required: false,
  build: async (ctx) => {
    try {
      const wsCtx = buildWorkspaceContext(ctx.workspaceDir)
      return wsCtx.combined.trim().length > 0 ? wsCtx.combined : null
    } catch {
      return null // 工作区上下文构建失败（IO 异常 / 权限不足）—— 静默跳过
    }
  },
})

registerPromptSection({
  id: 'core-rules',
  order: SECTION_ORDER.coreRules,
  slot: { kind: 'system' },
  stability: 'static',
  owner: 'core',
  maxTokens: 8000,
  required: true,
  build: async (ctx) => {
    // 优先 agent.systemSections（可多段，按 order 升序渲染）；缺省回退 systemPrompt 单段。
    if (ctx.agent.systemSections?.length) {
      const sorted = [...ctx.agent.systemSections].sort((a, b) => a.order - b.order)
      const text = sorted.map((s) => s.text).join('\n\n---\n')
      return text.trim().length > 0 ? text : null
    }
    return ctx.agent.systemPrompt?.trim() ? ctx.agent.systemPrompt : null
  },
})

registerPromptSection({
  id: 'personality',
  order: SECTION_ORDER.personality,
  slot: { kind: 'system' },
  stability: 'agent-static',
  owner: 'agent',
  maxTokens: 400,
  required: false,
  build: async (ctx) => buildPersonalitySegment(ctx.agent) || null,
})

// v0.32.0 G2：工作台上下文段 —— 让 agent「知道自己是谁、在哪、记忆属于哪个域」。
//
// 为什么必须写进 system：profile 的存在意义是「让 agent 只在自己的命名空间
// 与人格内行动」；若不在提示词里声明，隔离就只剩「目录分开了」，agent 依旧
// 不知道边界在哪（正本 workbench-profile-v1.0/05 §3.1）。
//
// 稳定性取值 'run-static'：同一次 run 内文案不变 → 前缀缓存可复用；
// 跨 run（切了工作台）自然重算。maxTokens 180 由 assertSectionBudget 护栏。
registerPromptSection({
  id: 'profile-context',
  order: SECTION_ORDER.profileContext,
  slot: { kind: 'system' },
  stability: 'run-static',
  owner: 'core',
  maxTokens: 180,
  required: false,
  build: async () => {
    try {
      const { buildProfileContextSegment } = await import('../../profile/prompt-context.js')
      return await buildProfileContextSegment()
    } catch {
      // profile 子系统不可用（未启用 / 首次启动竞态）→ 省略本段，绝不拖垮装配
      return null
    }
  },
})

registerPromptSection({
  id: 'workspace',
  order: SECTION_ORDER.workspace,
  slot: { kind: 'system' },
  stability: 'run-static',
  owner: 'core',
  maxTokens: 200,
  required: false,
  build: async () =>
    '## 当前工作区\n' +
    '工作区根目录见上方 <env> 段（权威来源，此处不再重复声明）。\n' +
    '使用 file-reader 的 path="." 可列出工作区根目录内容，path="src/" 等相对路径基于该目录解析。',
})

registerPromptSection({
  id: 'memory',
  order: SECTION_ORDER.memory,
  slot: { kind: 'system' },
  stability: 'run-static',
  owner: 'memory',
  maxTokens: 3000,
  required: false,
  build: async (ctx) => (ctx.memoryInjection?.trim() ? ctx.memoryInjection : null),
})

registerPromptSection({
  id: 'plan-constraint',
  order: SECTION_ORDER.planConstraint,
  slot: { kind: 'system' },
  stability: 'run-static',
  owner: 'core',
  maxTokens: 300,
  required: false,
  // v0.20.0 起为纯静态指令：不含每轮变化的进度列表（动态进度由 plan_status 独立消息承载）。
  build: async (ctx) => {
    if (!ctx.planItems || ctx.planItems.length === 0) return null
    // v0.34.x（问候循环修复）：死计划（全部条目已收口，无 pending/running）不再注入
    // 执行约束 —— 对已收口计划要求「严格按此执行」会诱导模型跑偏到与新指令无关的
    // 陈旧步骤（实测：任务被中断收口后，新消息仍被旧计划约束拉走）。与
    // messages.assembleMessages 的 planDead 静默同口径。
    const hasActionable = ctx.planItems.some(
      (p) => p.status === 'pending' || p.status === 'running',
    )
    if (!hasActionable) return null
    return (
      '## 计划执行约束\n' +
      '你已生成了计划清单，必须严格按此计划执行（当前进度见对话中的「清单状态」消息）。\n' +
      '每步 Reason 必须在开头声明"正在执行计划第 N 步：xxx"。' +
      '完成一个阶段性操作后，必须调用 todo-update 工具标记该步为 done 并说明下一步，' +
      '禁止全凭感觉推进或批量打标。' +
      '发现偏离计划或需跳过某步时，也调用 todo-update（skipped/failed）+ 说明原因。' +
      '若发现计划本身需调整，先用 ask_user 向用户确认。'
    )
  },
})

registerPromptSection({
  id: 'narration-protocol',
  order: SECTION_ORDER.narrationProtocol,
  slot: { kind: 'system' },
  stability: 'static',
  owner: 'core',
  maxTokens: 220,
  required: false,
  // ★ v0.33.1 W1：SAY 阶段叙述协议此前只有解析端（say-marker / stream-strip），
  // 提示词从未要求模型输出 —— 靠模型自觉，OpenAI 协议接 qwen3 等模型从不输出，
  // 交互区便没有「本轮结论 + 下一步」。
  build: async () =>
    '## 阶段叙述协议（每轮必须遵守）\n' +
    '每次回复（包括将要调用工具的回复）的正文**末尾**，用以下固定标记输出一段给用户看的阶段叙述：\n' +
    '<<<SAY>>>\n' +
    '（1~3 句：本轮得出的结论 + 下一步要做的事情。例如："已确认项目为 Vite + React 结构；接下来读取 src/ 入口文件确认依赖关系。"）\n' +
    '<<<END>>>\n' +
    '标记必须成对出现，叙述写在标记之间；标记之外不要复述这段内容。这段叙述会展示给用户，' +
    '因此要用人话总结，不要写代码或路径细节。',
})

/* ---------- always-on 常驻技能段（运行期 extras） ---------- */

/**
 * 读取 agent.alwaysOnSkillIds 并加载指令体为契约段。
 * 职责：run 启动时收集常驻技能（instructionMode=always-on）的 SKILL.md 全文，
 *       包装为 id='skill:{skillId}' 的 agent-static 契约段（同一 agent 逐字节稳定 → 命中前缀缓存）。
 * 错误场景：技能不存在 / 指令体缺失 / 模式非 always-on → 跳过 + warn，不阻塞任务。
 */
export async function collectAlwaysOnSections(agent: Agent): Promise<PromptSectionContract[]> {
  const ids = agent.alwaysOnSkillIds ?? []
  if (ids.length === 0) return []
  const contracts: PromptSectionContract[] = []
  for (const skillId of ids) {
    try {
      const skill = await getSkill(skillId)
      if (!skill) {
        logger.warn('Agent', `[prompt] always-on skill not found: ${skillId} — skipped`)
        continue
      }
      if (!skill.instructionMd) {
        logger.warn('Agent', `[prompt] always-on skill '${skillId}' has no instructionMd — skipped`)
        continue
      }
      const fm = await loadSkillFrontmatter(skill)
      const mode = fm.instructionMode ?? skill.instructionMode ?? 'on-demand'
      if (mode !== 'always-on') {
        logger.warn(
          'Agent',
          `[prompt] always-on skill '${skillId}' instructionMode='${mode}' (expected 'always-on') — skipped`,
        )
        continue
      }
      const full = await readFile(skill.instructionMd, 'utf-8')
      // 剥离 frontmatter，只注入指令体正文
      const body = full.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
      if (!body) {
        logger.warn('Agent', `[prompt] always-on skill '${skillId}' instruction body empty — skipped`)
        continue
      }
      const text = `## 常驻技能：${skill.name}（任务全程生效，必须遵循）\n${body}`
      contracts.push({
        id: `skill:${skillId}`,
        order: SECTION_ORDER.alwaysOnSkill,
        slot: { kind: 'system' },
        stability: 'agent-static',
        owner: 'skill',
        maxTokens: 16000,
        required: false,
        build: async () => text, // collect 时已加载，装配阶段零 IO
      })
    } catch (err) {
      logger.warn('Agent', `[prompt] always-on skill '${skillId}' load failed: ${(err as Error).message}`)
    }
  }
  return contracts
}

/* ---------- 契约装配器 ---------- */

export interface AssembledSystemPrompt {
  /** 渲染后的 system 字符串（与旧 renderSystemPrompt 同格式） */
  text: string
  /** 按渲染顺序的段列表（供调试 / 测试断言） */
  sections: PromptSection[]
}

/**
 * 按契约装配 system prompt（替代 buildSystemSections 的散段逻辑）。
 * 职责：注册契约 + extras 统一校验 → 逐段 build → required 缺失 throw →
 *       超预算 warn（不阻断）→ order 排序 → '\n\n---\n' 连接。
 * 错误场景：
 *  - extras 与已注册段 id 冲突 → throw
 *  - required 段 build 为空 → throw（启动期暴露配置错误）
 */
export async function assembleSystemPrompt(
  ctx: SystemPromptContext,
  extras: PromptSectionContract[] = [],
): Promise<AssembledSystemPrompt> {
  const registered = getRegisteredPromptSections()
  const registeredIds = new Set(registered.map((c) => c.id))
  for (const extra of extras) {
    validatePromptSectionContract(extra)
    if (registeredIds.has(extra.id)) {
      throw new Error(`[prompt-contract] extra section id conflicts with registered: ${extra.id}`)
    }
  }

  const contracts = [...registered, ...extras].filter((c) => c.slot.kind === 'system')
  const sections: PromptSection[] = []
  for (const c of contracts) {
    let text: string | null
    try {
      text = await c.build(ctx)
    } catch (err) {
      if (c.required) {
        throw new Error(`[prompt-contract] required section '${c.id}' build failed: ${(err as Error).message}`)
      }
      logger.warn('Agent', `[prompt-contract] section '${c.id}' build failed — skipped`)
      continue
    }
    if (!text || text.trim().length === 0) {
      if (c.required) {
        throw new Error(`[prompt-contract] required section '${c.id}' is empty`)
      }
      continue
    }
    assertSectionBudget({ id: c.id, text, maxTokens: c.maxTokens })
    sections.push({ id: c.id, order: c.order, text })
  }

  sections.sort((a, b) => a.order - b.order)
  return { text: sections.map((s) => s.text).join('\n\n---\n'), sections }
}
