/* ============================================================
 * ArkWork — 「伪工具调用」检测（v0.38.0 / D160）
 * 设计文档：docs/versions/v0.38.0/04-system-design.md §6.2
 *
 * 为什么要有这个文件：
 *   2026-09-25 实机（真实 ArkWork + 局域网 Ollama qwen3.5:9b）任务
 *   T-20260925-3k582g：模型**可达且正常返回**（20+ 次 POST /chat 均 200，
 *   10–30s/次），但从未返回原生 `tool_calls` —— 它把工具调用**写成正文**：
 *
 *       bash
 *       复制
 *       file-reader(path=".")
 *       task_plan(items=[{ "id": 1, "title": "…", "status": "doing" }])
 *
 *   引擎只解析原生 tool_calls（`llm/openai.ts:parseOpenAIToolCalls`）→ 0 个动作
 *   → 判「无工具调用」→ 注入自愈提示 → 模型继续编更多伪代码 → **空转 21 轮**。
 *   既有 `stall.ts` 的零产出守卫救不了：`isStalledRound({ hasSayOutput: true })`
 *   把「一直在说话」当成有产出，计数每轮归零。
 *
 *   用户视角：任务一直"在说话、在演执行"，任务清单纹丝不动 —— 这是**静默退化**
 *   的最坏形态（纪律⑨：容错路径必须在诊断通道留人话）。
 *
 * 本模块只答一个问题：**这段正文是不是在"演"工具调用？**
 * 判据独立于「模型有没有说话」—— 说的是不是真动作，与说得多不多无关。
 *
 * 硬规则：
 *   · 工具名事实源复用 `work-class.ts` 的只读/控制/清单三张表（纪律⑧），
 *     本文件只补「引擎表外的高频写工具」四个名字，不复制既有名单。
 *   · 形态容错复用 `normalizeToolName`（`task-plan` / `task_plan` 同判）。
 * ============================================================ */
import { CONTROL_TOOLS, PLAN_TOOLS, READONLY_TOOLS, normalizeToolName } from './work-class.js'

/**
 * 引擎三张表之外的**高频写工具** —— 模型"演"调用时最常写的就是这几个。
 * （它们不在 `work-class` 的三张表里：那三张表答"是不是只读/控制/清单"，
 *   不含写工具；此处只服务于伪调用检测，故单独列出并保持极小。）
 * v0.41.0（D208）导出：正文工具降级通道的**可执行白名单**需要同一批写工具名。
 */
export const EXTRA_PSEUDO_TOOLS = ['file-writer', 'shell', 'file-editor', 'delegate-agent'] as const

/**
 * 伪调用检测的已知工具名全集（唯一事实源）
 * v0.41.0（D208）导出：正文工具降级通道（prose-tool-call.ts）的白名单复用本表
 * —— 「已知工具名」只有一个事实源，两处各留一份就是纪律⑦要禁的第二事实源。
 */
export const PSEUDO_KNOWN_NAMES: ReadonlySet<string> = new Set<string>([
  ...READONLY_TOOLS,
  ...CONTROL_TOOLS,
  ...PLAN_TOOLS,
  ...EXTRA_PSEUDO_TOOLS,
])

/**
 * 连续多少轮「无工具调用 + 正文出现伪调用」即判定：该模型本轮不会使用工具调用。
 *
 * 取 3（而不是 6）：伪调用是**确定性**信号（模型已把调用写出来了，只是没走协议），
 * 继续提示只是在烧 token —— 第 1 轮先给定向提示自愈，第 3 轮转人工。
 */
export const PSEUDO_CALL_STOP_ROUNDS = 3

/** 形如 `name(` / `name (` 的候选片段（名字过长/过短都不像工具名） */
const CANDIDATE_RE = /([A-Za-z][A-Za-z0-9_-]{2,40})\s*\(/g

/**
 * 检测正文里的伪工具调用，返回被"演"的工具名（未命中返回 null）。
 *
 * 只认**已知工具名 + 左括号**：普通散文里的 `useState(` / `function foo(`
 * 不在已知表内，不会误报。
 */
export function detectPseudoToolCall(text: string | undefined | null): string | null {
  if (!text) return null
  for (const m of text.matchAll(CANDIDATE_RE)) {
    const name = normalizeToolName(m[1]!)
    if (PSEUDO_KNOWN_NAMES.has(name)) return name
  }
  return null
}

/** 三个文本通道拼一起检测（模型可能只把伪代码写在某个通道里） */
export function detectPseudoToolCallInTurn(parts: {
  content?: string
  thought?: string
  reasoningContent?: string
}): string | null {
  return (
    detectPseudoToolCall(parts.content) ??
    detectPseudoToolCall(parts.thought) ??
    detectPseudoToolCall(parts.reasoningContent)
  )
}
