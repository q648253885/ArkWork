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
  // v0.37.0：任务模式自选（模型选，UI 不提供入口）+ 输出层次契约
  taskMode: 510,
  outputLayering: 520,
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
      '你已生成了计划清单，必须严格按**当前生效**计划执行（各项当前状态以对话中的「清单状态」消息为准）。\n' +
      '每步 Reason 必须在开头声明"正在执行计划第 N 步：xxx"。' +
      // v0.38.1（D166）：todo-update / task_create / replan 已在 v0.38.0 D154 从模型可见
      // 工具面下架（收敛为 task_plan 单入口），本段仍教模型调旧工具名 → 模型照做即吃
      // 「请改用 task_plan」软失败，空耗轮次（小模型尤其致命）。
      // v0.40.0（D202）：此处原为「**必须**通过 task_plan 提交完整最新清单」。
      //
      // 为什么改：`evidence/04`（v0.39.0）实测 —— 弱模型（qwen3.5 0.8b/9b）在
      // 「数十个工具定义 + 长上下文」下产出结构化 tool_call 的能力**极不稳定**
      // （`/v1` 通道 25 工具 + in≈3965 时 `tc=0 / content=0ch`，精确复现空响应）。
      // 把「必须调用 task_plan」写成硬性要求，等于把清单推进**全部**押在模型
      // 最不可靠的那项能力上 → 空转 / 伪调用 / 空响应三选一。
      //
      // v0.40.0 起：清单由**引擎侧的清单操作通道**独立维护（每轮依据客观进展判定，
      // 与模型是否发起工具调用无关），`task_plan` 降为「想改就改」的**可选快路径**。
      // 强模型继续用它效果好；弱模型不用它，清单照样推进 —— 这是「不影响正常 LLM」
      // 前提下对弱模型的适配，且**不含按模型名的分支**。
      '阶段性操作完成后，若你希望立即反映进展，可调用 task_plan 提交**完整最新清单**（把该步标为 done）并说明下一步；' +
      '**不调用也不会停滞** —— 引擎会依据你的实际进展独立维护清单。禁止全凭感觉批量打标。' +
      '发现偏离计划或需跳过某步时，可用 task_plan 把该项标为 skipped/failed + 说明原因。' +
      // v0.36.5 D125：旧句「若计划需调整先用 ask_user」与 D12 replan 通道直接冲突
      //（清单是活树），改写为「先同步、后执行」——同步走受审计通道，作废仍须用户批准。
      '用户追加新指令或实际情况与计划不符时，先按对话末尾『续聊指令与清单』规则同步清单，' +
      '再继续执行；未经用户批准不得整体作废。'
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

/**
 * v0.37.0（PRD F7 / 设计文档 §5）：**任务模式由模型自选**。
 *
 * 为什么不放 UI 让用户点：
 *  · 复杂度是模型读了任务之后才能判断的东西，用户点选等于让没看代码的人替看代码的人做决定；
 *  · UI 一旦提供选择入口，就会出现"用户选 spec 但任务是问答"的仪式化（修个 bug 拆 10 阶段）；
 *  · 模式会随执行推进升级（chat → plan → spec），静态下拉框没法表达。
 *
 * 因此：声明权在模型（`set-task-mode` 工具），引擎只在模型未声明时兜底推导。
 */
registerPromptSection({
  id: 'task-mode',
  order: SECTION_ORDER.taskMode,
  slot: { kind: 'system' },
  stability: 'static',
  owner: 'core',
  maxTokens: 400,
  required: false,
  build: async () =>
    '## 任务模式（**由你选择**，界面不提供手动切换）\n' +
    '开始前先判断本次任务的复杂度，选一种模式并调用 `set-task-mode` 工具写入清单：\n' +
    '  · `chat` 对话式 —— 问答 / 查询 / 检查 / 解释 / 单文件小改。清单 0~1 项，不要为只读任务凑步骤。\n' +
    '  · `plan` 计划式 —— 多文件、范围明确、需分步推进。清单 3~6 项。\n' +
    '  · `spec` 规格式 —— 跨模块 / 架构决策 / 新项目。分阶段清单，**每项必须带验收契约**（acceptance）与产出物。\n' +
    '只允许升级（chat → plan → spec），不允许中途降级去逃避已承诺的验收。\n' +
    '未显式声明时引擎会按清单规模兜底推导，并在清单里标注「引擎兜底」。',
})

/**
 * v0.37.0（PRD F9 / 设计文档 §6.1）：**输出层次契约**。
 *
 * 与 narration-protocol（SAY 标记）的区别：SAY 管的是**每轮**的一段叙述，
 * 本段管的是**最终答复**的四段结构 —— 用户做判断必需的信息必须分层且默认可见，
 * 细节默认折叠（行业共识：默认可见性由可判断性决定）。
 */
registerPromptSection({
  id: 'output-layering',
  order: SECTION_ORDER.outputLayering,
  slot: { kind: 'system' },
  stability: 'static',
  owner: 'core',
  maxTokens: 400,
  required: false,
  build: async () =>
    '## 最终答复的输出层次（四段，缺段请显式说明"无"而不是省略）\n' +
    '收尾时的正式答复按四段组织，让用户一眼能判断"做完了没有、改了什么、凭什么算做完"：\n' +
    '  1. **结论先行** —— 1~2 句说清本次结果与是否达成目标。\n' +
    '  2. **变更清单** —— 改了哪些文件 / 产出了什么（路径 + 一句话）。无改动写"无代码改动"。\n' +
    '  3. **验证结果** —— 跑过的命令 / 测试 / 校验及其结论。没跑过写"未验证"，**不要臆造**。\n' +
    '  4. **下一步** —— 还需要做什么、有哪些待确认项。\n' +
    '中间过程（思考、工具调用明细）不要塞进这四段，它们有独立的展示通道。',
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
