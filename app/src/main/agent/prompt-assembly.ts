/* ============================================================
 * ArkWork — 系统提示词组装器（v0.19.0 M1 / v0.20.0 缓存优化）
 * 把原先散落在 engine.ts 的 parts.push() 硬拼逻辑收敛为
 * 「有序 section 收集 → 按 order 排序 → 统一渲染」的纯函数流水线。
 * 借鉴 dsh prompt-system 的 section/scope 设计；本版 scope 预留不启用。
 *
 * v0.20.0 缓存优化：system prompt 只保留「运行期稳定」段
 * （core-rules → personality → workspace → memory → plan-constraint 静态指令）。
 * 每轮变化的 skill 指令、计划进度不再拼入 system（改为消息尾部注入），
 * 保证 system 逐字节稳定，DeepSeek / MiniMax 前缀缓存才可命中。
 * ============================================================ */
import type { Agent, PromptSection } from '@shared/types/agent'
import type { PlanItem } from '@shared/types/task'
import { buildWorkspaceContext } from './workspace-context.js'

/** 组装系统提示词的运行时上下文。 */
export interface SystemPromptContext {
  /** 当前 agent 定义（含 systemSections / systemPrompt / role/goal/backstory/styleGuide） */
  agent: Agent
  /** 工作区绝对路径 */
  workspaceDir: string
  /** L3a 策展 + L4a 画像 + KB 状态行（run 启动时由 buildMemoryInjection 构建，可为空） */
  memoryInjection?: string
  /** 任务计划清单（可为空；仅用于决定是否注入静态计划约束，不含每轮进度） */
  planItems?: PlanItem[]
}

/** 各段排序权重（升序渲染；与旧 engine.ts 拼装顺序一一对应） */
const ORDER = {
  workspaceContext: -100,  // v0.24.x：ArkWork 系统提示词最先（env / stack / tree / AGENTS.md），位于 coreRules 之前
  coreRules: 0,
  personality: 100,
  workspace: 200,
  memory: 300,
  planConstraint: 500,
} as const

/**
 * 构建人格段（自 engine.ts 迁入，行为不变）。
 * 职责：把 role/goal/backstory/styleGuide 拼为 '## 人格设定' 段；全空返回空串。
 * 副作用：无（纯函数）。
 */
export function buildPersonalitySegment(agent: Agent): string {
  const lines: string[] = []
  if (agent.role?.trim()) lines.push(`- 角色：${agent.role.trim()}`)
  if (agent.goal?.trim()) lines.push(`- 目标：${agent.goal.trim()}`)
  if (agent.backstory?.trim()) lines.push(`- 背景：${agent.backstory.trim()}`)
  if (agent.styleGuide?.trim()) lines.push(`- 表达风格：${agent.styleGuide.trim()}`)
  if (lines.length === 0) return ''
  return `## 人格设定\n${lines.join('\n')}`
}

/** 各段排序权重（升序渲染；与旧 engine.ts 拼装顺序一一对应）
 * v0.24.x：移除 —— 改为模块顶部 const，附带 workspaceContext 权重
 */

/**
 * 构建有序系统提示词 section 列表。
 * 职责：收集静态段（core-rules、personality、workspace、memory、plan-constraint
 *       静态指令），按 order 升序返回；空文本段跳过。
 * v0.20.0：skill-hint 与动态计划进度已移出 system（由 engine 以消息尾部注入），
 *          保证 system 逐字节稳定以命中前缀缓存。
 * 副作用：无（纯函数）。
 */
export function buildSystemSections(ctx: SystemPromptContext): PromptSection[] {
  const sections: PromptSection[] = []

  // core-rules：优先用 agent.systemSections（可多段）；缺省回退为 systemPrompt 单段。
  const core = ctx.agent.systemSections?.length
    ? ctx.agent.systemSections
    : [{ id: 'core-rules', order: ORDER.coreRules, text: ctx.agent.systemPrompt }]
  sections.push(...core)

  // personality（静态段）
  const personality = buildPersonalitySegment(ctx.agent)
  if (personality) sections.push({ id: 'personality', order: ORDER.personality, text: personality })

  // workspace（file-reader 用法说明；v0.25.0 F1：根目录声明删除——<env> 段为权威来源，避免重复）
  const wsHint =
    `## 当前工作区\n` +
    `工作区根目录见上方 <env> 段（权威来源，此处不再重复声明）。\n` +
    `使用 file-reader 的 path="." 可列出工作区根目录内容，path="src/" 等相对路径基于该目录解析。`
  sections.push({ id: 'workspace', order: ORDER.workspace, text: wsHint })

  // v0.24.x：工作区上下文感知（借鉴 opencode / claude code）——
  // 自动注入 <env> 环境 / <stack> 技术栈 / <project> 目录树 / <agents-md> 项目规则。
  // 一次性构建、运行期稳定，可放 system 命中前缀缓存。
  // 失败时 buildWorkspaceContext 内部 catch + 静默，不会阻塞主流程。
  try {
    const wsCtx = buildWorkspaceContext(ctx.workspaceDir)
    if (wsCtx.combined.trim().length > 0) {
      sections.push({
        id: 'workspace-context',
        order: ORDER.workspaceContext,
        text: wsCtx.combined,
      })
    }
  } catch {
    // 工作区上下文构建失败（IO 异常 / 权限不足）—— 静默跳过
  }

  // memory（记忆注入，运行期构建一次）
  if (ctx.memoryInjection) {
    sections.push({ id: 'memory', order: ORDER.memory, text: ctx.memoryInjection })
  }

  // plan-constraint（计划执行约束，v0.20.0 起改为纯静态指令：不含每轮变化的进度列表。
  // 动态进度由 kind='plan_status' 独立 user 消息承载，见 engine.emitPlanStatus）
  if (ctx.planItems && ctx.planItems.length > 0) {
    sections.push({
      id: 'plan-constraint',
      order: ORDER.planConstraint,
      text:
        `## 计划执行约束\n` +
        `你已生成了计划清单，必须严格按此计划执行（当前进度见对话中的「清单状态」消息）。\n` +
        `每步 Reason 必须在开头声明"正在执行计划第 N 步：xxx"。` +
        `完成一个阶段性操作后，必须调用 todo-update 工具标记该步为 done 并说明下一步，` +
        `禁止全凭感觉推进或批量打标。` +
        `发现偏离计划或需跳过某步时，也调用 todo-update（skipped/failed）+ 说明原因。` +
        `若发现计划本身需调整，先用 ask_user 向用户确认。`,
    })
  }

  return sections
    .filter((s) => s.text.trim().length > 0)
    .sort((a, b) => a.order - b.order)
}

/**
 * 将有序 section 列表渲染为最终 system 字符串。
 * 职责：按 order 顺序用 '\n\n---\n' 连接。
 * 副作用：无（纯函数）。
 */
export function renderSystemPrompt(sections: PromptSection[]): string {
  return sections.map((s) => s.text).join('\n\n---\n')
}
