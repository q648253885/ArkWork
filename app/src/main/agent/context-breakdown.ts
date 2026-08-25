/* ============================================================
 * ArkWork — 上下文占比可视化（纯工具模块）
 * agent-context-share-visualization spec Task 6
 *
 * 将任务上下文按 7 个分类（系统提示词 / 文件 / 工具及子智能体 /
 * 对话消息 / MCP / 技能 / 其他）统计 token 占比，产出可下钻明细。
 *
 * 纯计算模块：禁止 import electron / fs，便于 node:test 单元测试。
 * token 口径与 ./context.ts 的 estimateTextTokens 一致。
 *
 * 结果类型（ContextCategory / ContextDetail / ContextBreakdownItem /
 * ContextBreakdownResult）定义在 @shared/types/ipc（IPC 契约单一来源），
 * 此处仅作 re-export，供 main 侧消费方引用。
 * ============================================================ */
import type { LlmMessage, LlmTool } from '../llm/adapter.js'
import type { MemoryItem, MemoryKind } from '@shared/types/memory'
import type { PromptSection, SkillSource } from '@shared/types/agent'
import type {
  ContextCategory,
  ContextDetail,
  ContextBreakdownItem,
  ContextBreakdownResult,
} from '@shared/types/ipc'
import { estimateTextTokens } from './context.js'

// re-export IPC 契约类型，便于 main 侧统一从本模块引用
export type {
  ContextCategory,
  ContextDetail,
  ContextBreakdownItem,
  ContextBreakdownResult,
}

/** 工具明细条目（由编排层从 Skill + LlmTool 构造，保持本模块纯） */
export interface ContextToolEntry {
  skillId: string
  skillName: string
  source: SkillSource
  tool: LlmTool
  isMcp: boolean
  /** 锁定（Agent 默认能力，不可在任务内移除） */
  locked: boolean
}

/** 技能指令体条目 */
export interface ContextSkillInstruction {
  skillId: string
  skillName: string
  content: string
  locked: boolean
}

/** computeContextBreakdown 入参 */
export interface ContextBreakdownInput {
  maxTokens: number
  /** Agent 系统提示词 + 人格段 + 工作区指令（不含记忆注入）；systemSections 缺省时的回退口径 */
  systemPrompt: string
  /** v0.19.0 M1：有序系统提示词段（core-rules / personality / workspace …）。
   *  提供时 system 分类按下钻为逐段明细；缺省回退为单条 system-prompt 明细。 */
  systemSections?: PromptSection[]
  /** 记忆注入文本（策展记忆 / 用户画像 / 知识库状态行） */
  memoryInjection?: string
  /** L1 file_ref 条目（附加文件） */
  fileItems: MemoryItem[]
  /** 已装配的对话消息（与发送给 LLM 的 payload 同口径） */
  messages: LlmMessage[]
  /** 工具 schema 条目（含 MCP / 子智能体） */
  toolEntries: ContextToolEntry[]
  /** 技能 instruction.md 内容（按需加载，仅 enabled 技能） */
  skillInstructions: ContextSkillInstruction[]
}

/** 分类中文标签 */
export const CATEGORY_LABELS: Record<ContextCategory, string> = {
  system: '系统提示词',
  files: '文件',
  tools: '工具及子智能体',
  messages: '对话消息',
  mcp: 'MCP',
  skills: '技能',
  other: '其他',
}

/** 分类展示顺序 */
export const CATEGORY_ORDER: ContextCategory[] = [
  'system',
  'files',
  'tools',
  'messages',
  'mcp',
  'skills',
  'other',
]

/**
 * 对话类 L1 kind 集合（用于「清空对话消息」时筛选 L1 条目）。
 * 注意：file_ref / system_prompt 不在此列，清空对话不会动它们。
 */
export const CONVERSATION_KINDS: ReadonlySet<MemoryKind> = new Set<MemoryKind>([
  'user_message',
  'reasoning',
  'action',
  'observation',
  'plan',
  'kb_hit',
  'summary',
  'compressed_summary',
])

/** tokens 相对 max 的占比百分比（保留一位小数） */
function pctOf(tokens: number, max: number): number {
  if (max <= 0) return 0
  return Math.round((tokens / max) * 1000) / 10
}

/** 压缩空白并截断为展示片段 */
function snippet(text: string, n = 60): string {
  const t = (text || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

/** v0.19.0 M1：系统提示词段的友好展示名（core-rules 等固定段 → 中文；未知段回退 id / 标题） */
const SYSTEM_SECTION_LABELS: Record<string, string> = {
  'core-rules': '核心规则',
  'personality': '人格设定',
  'workspace': '工作区指令',
  'memory': '记忆注入',
  'skill-hint': '当前技能指令',
  'plan-constraint': '计划执行约束',
}

function systemSectionLabel(sec: PromptSection): string {
  const known = SYSTEM_SECTION_LABELS[sec.id]
  if (known) return known
  // 未知段：尝试从 `## 标题` 中抽取；否则回退为 id
  const title = sec.text.match(/^##\s+(.+)$/m)?.[1]?.trim()
  return title || sec.id
}

/**
 * 计算上下文占比明细。纯函数，不做任何 I/O。
 *
 * 分类口径：
 *  - system：Agent 系统提示词 + 人格段 + 工作区指令
 *  - files：L1 file_ref 条目（附加文件内容）
 *  - tools：非 MCP 技能的 tool schema（含 delegate-agent 子智能体）
 *  - messages：装配后的对话消息（user / assistant / tool）
 *  - mcp：source==='mcp' 的技能 tool schema
 *  - skills：enabled 技能的 SKILL.md 指令体（按需加载的部分）
 *  - other：记忆注入（策展记忆 / 用户画像 / 知识库状态行）
 *
 * totalTokens = 各分类 token 之和（自洽）；
 * overallPercentage = totalTokens / maxTokens。
 */
export function computeContextBreakdown(input: ContextBreakdownInput): ContextBreakdownResult {
  const max = input.maxTokens
  const items: ContextBreakdownItem[] = []

  // ---- system ----
  // v0.19.0 M1：若提供了有序 section，则按段下钻（core-rules / personality / workspace …）；
  // 否则回退为单条 system-prompt 明细（兼容旧调用方）。
  const sections = input.systemSections ?? []
  const systemTokens = sections.length
    ? sections.reduce((s, sec) => s + estimateTextTokens(sec.text), 0)
    : estimateTextTokens(input.systemPrompt)
  const systemDetails: ContextDetail[] = sections.length
    ? sections.map((sec) => ({
        id: `system:${sec.id}`,
        label: systemSectionLabel(sec),
        type: 'system-section',
        tokenCount: estimateTextTokens(sec.text),
        removable: false,
      }))
    : [
        {
          id: 'system:prompt',
          label: 'Agent 系统提示词 + 工作区指令',
          type: 'system-prompt',
          tokenCount: systemTokens,
          removable: false,
        },
      ]
  items.push({
    category: 'system',
    label: CATEGORY_LABELS.system,
    tokenCount: systemTokens,
    percentage: pctOf(systemTokens, max),
    details: systemDetails,
  })

  // ---- files ----
  // v0.19.x fix：此前 files 分类只统计 L1 file_ref（附加文件），任务对话中从未产生
  // file_ref → 面板"文件"恒为 0/空。现在把 file-reader 工具读到的文件内容观察
  // （tool 消息）也归入"文件"分类（从 messages 中拆出，避免双重计数）。
  const fileDetails: ContextDetail[] = input.fileItems.map((m) => ({
    id: m.id,
    label: snippet(m.content, 80) || `文件引用 #${m.id.slice(-4)}`,
    type: 'file',
    tokenCount: m.tokens,
    removable: true,
    data: m.meta,
  }))

  // ---- tools + mcp ----
  const toolDetails: ContextDetail[] = []
  const mcpDetails: ContextDetail[] = []
  for (const e of input.toolEntries) {
    const tokens = estimateTextTokens(JSON.stringify(e.tool))
    const isSubAgent =
      e.source === 'builtin' && (e.skillId.includes('delegate') || e.skillName.includes('delegate'))
    const d: ContextDetail = {
      id: e.skillId,
      label: e.skillName,
      type: isSubAgent ? 'sub-agent' : 'tool',
      tokenCount: tokens,
      removable: !e.locked,
    }
    if (e.isMcp) mcpDetails.push(d)
    else toolDetails.push(d)
  }
  const toolTokens = toolDetails.reduce((s, d) => s + d.tokenCount, 0)
  const mcpTokens = mcpDetails.reduce((s, d) => s + d.tokenCount, 0)
  items.push({
    category: 'tools',
    label: CATEGORY_LABELS.tools,
    tokenCount: toolTokens,
    percentage: pctOf(toolTokens, max),
    details: toolDetails,
  })
  items.push({
    category: 'mcp',
    label: CATEGORY_LABELS.mcp,
    tokenCount: mcpTokens,
    percentage: pctOf(mcpTokens, max),
    details: mcpDetails,
  })

  // ---- messages ----
  // 不展示工具调用的原始 JSON 参数：assistant 调用工具只显示工具名。
  // v0.19.x：file-reader 的 tool 消息（读到的文件内容）归入 files 分类，不进 messages。
  const FILE_READ_TOOLS = new Set(['file-reader'])
  const msgDetails: ContextDetail[] = []
  let msgTokens = 0
  for (let i = 0; i < input.messages.length; i++) {
    const m = input.messages[i]
    let tokens = estimateTextTokens(m.content)
    if (m.reasoningContent) tokens += estimateTextTokens(m.reasoningContent)
    if (m.toolCalls) {
      for (const tc of m.toolCalls) tokens += estimateTextTokens(tc.function.arguments)
    }
    if (m.role === 'tool' && m.name && FILE_READ_TOOLS.has(m.name)) {
      // 文件读取观察 → 文件分类（不可单条移除，避免破坏 tool_call 配对）
      fileDetails.push({
        id: `file-obs:${i}`,
        label: `文件读取：` + snippet(m.content, 70),
        type: 'file',
        tokenCount: tokens,
        removable: false,
      })
      continue
    }
    msgTokens += tokens
    let label: string
    if (m.role === 'user') {
      label = '用户：' + snippet(m.content, 50)
    } else if (m.role === 'assistant') {
      const names = m.toolCalls?.map((t) => t.function.name).join(', ')
      label = names ? `助手 · 调用工具：${names}` : '助手：' + snippet(m.content, 50)
    } else if (m.role === 'tool') {
      label = `工具结果${m.name ? ' · ' + m.name : ''}：` + snippet(m.content, 50)
    } else {
      label = snippet(m.content, 60)
    }
    // 单条对话消息不提供移除（避免破坏 tool_call 配对）；整类可通过「清空」归档
    msgDetails.push({ id: `msg:${i}`, label, type: 'message', tokenCount: tokens, removable: false })
  }
  const fileTokens = fileDetails.reduce((s, d) => s + d.tokenCount, 0)
  items.push({
    category: 'files',
    label: CATEGORY_LABELS.files,
    tokenCount: fileTokens,
    percentage: pctOf(fileTokens, max),
    details: fileDetails,
  })
  items.push({
    category: 'messages',
    label: CATEGORY_LABELS.messages,
    tokenCount: msgTokens,
    percentage: pctOf(msgTokens, max),
    details: msgDetails,
  })

  // ---- skills（instruction.md 指令体）----
  const skillDetails: ContextDetail[] = input.skillInstructions
    .filter((s) => s.content.trim().length > 0)
    .map((s) => ({
      id: s.skillId,
      label: s.skillName,
      type: 'skill-instruction',
      tokenCount: estimateTextTokens(s.content),
      removable: !s.locked,
    }))
  const skillTokens = skillDetails.reduce((s, d) => s + d.tokenCount, 0)
  items.push({
    category: 'skills',
    label: CATEGORY_LABELS.skills,
    tokenCount: skillTokens,
    percentage: pctOf(skillTokens, max),
    details: skillDetails,
  })

  // ---- other（记忆注入）----
  const otherTokens = input.memoryInjection ? estimateTextTokens(input.memoryInjection) : 0
  items.push({
    category: 'other',
    label: CATEGORY_LABELS.other,
    tokenCount: otherTokens,
    percentage: pctOf(otherTokens, max),
    details: [
      {
        id: 'other:memory-injection',
        label: '记忆注入（策展记忆 / 用户画像 / 知识库状态）',
        type: 'memory-injection',
        tokenCount: otherTokens,
        removable: false,
      },
    ],
  })

  // 按约定顺序排列
  items.sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category))

  const totalTokens = items.reduce((s, it) => s + it.tokenCount, 0)
  return {
    totalTokens,
    maxTokens: max,
    overallPercentage: pctOf(totalTokens, max),
    items,
    remainingTokens: Math.max(0, max - totalTokens),
  }
}
