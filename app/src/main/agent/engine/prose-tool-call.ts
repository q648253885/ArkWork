/* ============================================================
 * ArkWork — Ollama qwen3.5 正文工具调用降级通道（v0.41.0 / D208）
 *
 * 为什么要有这个文件：
 *   实机（用户局域网 Ollama qwen3.5:9b，2026-09-28 会话导出）里模型
 *   **从不返回原生 tool_calls**，把调用写成正文 JSON：
 *
 *       正在执行计划第 1 步：分析项目结构（读取根目录文件列表）。
 *       {"tool": "file-reader", "path": "."}
 *
 *   既有防线全部接不住：伪调用守卫只认 `name(` 形态（pseudo-call.ts 的
 *   CANDIDATE_RE），JSON 块不命中；D177 正则回退只解析**清单数组**；
 *   PlanOps 只覆盖清单五类操作 —— 通用工具调用（读文件 / 跑命令）出现在
 *   正文里即永久丢失，4 轮后 D168 停机。用户裁决：对 qwen3.5 开启 think、
 *   让模型输出标准格式正文，引擎解析后代为**真实执行**。
 *
 * 硬规则（纪律㊵ / ㊶ / ⑦）：
 *   · 谓词**默认关闭**：非 ollama 形态或非 qwen3.5 模型，请求体、提示词、
 *     循环行为逐字节零变化（TC-PTC-013 / TC-PTL-002/003 钉死）。
 *   · 白名单是**防幻觉执行的最后闸**：不在表内的名字（模型常幻觉出
 *     引擎没有的工具）一律计入 invalid，绝不执行（TC-PTC-006）。
 *   · 「像工具调用但失败」才计 invalid；普通对象（如清单数组的元素）
 *     静默跳过 —— 清单归 D177 正则回退管，两通道互不抢活（TC-PTC-011）。
 * ============================================================ */
import type { LlmModel } from '@shared/types/agent'
import { CONTROL_TOOLS, PLAN_WRITE_TOOLS, READONLY_TOOLS, normalizeToolName } from './work-class.js'
import { EXTRA_PSEUDO_TOOLS } from './pseudo-call.js'
import { isOllamaLikeEndpoint } from '../../llm/registry.js'
import { repairJson } from '../planning/parse.js'

/** 降级通道**可执行**白名单（唯一事实源）—— 注意**不含**已下架的 RETIRED_PLAN_TOOLS：
 *  伪调用检测表（PSEUDO_KNOWN_NAMES）含退役名是为了"认得出"，本表是为了"敢执行"。 */
const PROSE_TOOL_WHITELIST: ReadonlySet<string> = new Set<string>([
  ...READONLY_TOOLS,
  ...CONTROL_TOOLS,
  ...PLAN_WRITE_TOOLS,
  ...EXTRA_PSEUDO_TOOLS,
])

/** 单轮最多代为执行的工具调用数（防御模型一次喷一长串） */
export const PROSE_TOOL_CALL_LIMIT = 4

export interface ProseToolCall {
  tool: string
  args: Record<string, unknown>
}

export interface ProseToolExtract {
  calls: ProseToolCall[]
  /** 「像工具调用但失败」的数量（幻觉名 / 参数不可修复）；普通对象不计数 */
  invalid: number
}

/** 这些键是调用元信息 / 叙述性键，扁平形态下不得混进 args */
const RESERVED_KEYS: ReadonlySet<string> = new Set([
  'tool',
  'name',
  'arguments',
  'args',
  'parameters',
  'input',
  'thought',
  'reasoning',
  'say',
  'explanation',
  'note',
  'comment',
  'description',
])

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

/**
 * 从一段候选文本里捞出**所有顶层 JSON 值**（对象/数组）。
 * 三段式：直解 → repairJson 修补 → 字符串感知的花括号扫描。
 * 第三段是给真实弱模型准备的：同一段 JSON 说两遍（D205 同族）、
 * 叙述与 JSON 混排、数组被拆成两半 —— 直解全挂，只有逐对象捞才救得回来。
 */
function parseLooseValues(s: string): unknown[] {
  const out: unknown[] = []
  const t = s.trim()
  if (t === '') return out
  const direct = tryParse(t)
  if (direct !== undefined) {
    out.push(direct)
    return out
  }
  const repaired = repairJson(t)
  if (repaired !== null) {
    const v = tryParse(repaired)
    if (v !== undefined) {
      out.push(v)
      return out
    }
  }
  // 字符串感知的花括号扫描：只在直解/修补都失败时才走（成本兜底：限长 20k）
  const scan = t.length > 20_000 ? t.slice(0, 20_000) : t
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < scan.length; i++) {
    const ch = scan[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') {
      if (depth === 0) start = i
      depth += 1
    } else if (ch === '}') {
      if (depth === 0) continue
      depth -= 1
      if (depth === 0 && start >= 0) {
        const v = tryParse(scan.slice(start, i + 1))
        if (v !== undefined) out.push(v)
        start = -1
      }
    }
  }
  return out
}

/** 单个 JSON 对象 → 工具调用；返回 invalid 表示「像工具调用但失败」 */
function toProseCall(obj: Record<string, unknown>): { call?: ProseToolCall; invalid?: boolean } {
  const hasNameKey = typeof obj.tool === 'string' || typeof obj.name === 'string'
  if (!hasNameKey) return {} // 普通对象（清单元素等）→ 静默跳过，不计 invalid
  const rawName = (obj.tool ?? obj.name) as string
  const tool = normalizeToolName(rawName.trim())
  if (!PROSE_TOOL_WHITELIST.has(tool)) return { invalid: true }
  const explicit = obj.arguments ?? obj.args ?? obj.parameters ?? obj.input
  let args: Record<string, unknown>
  if (explicit !== undefined && explicit !== null) {
    if (isPlainObject(explicit)) {
      args = explicit
    } else if (typeof explicit === 'string') {
      const v = tryParse(explicit) ?? (repairJson(explicit) !== null ? tryParse(repairJson(explicit)!) : undefined)
      if (!isPlainObject(v)) return { invalid: true }
      args = v
    } else {
      return { invalid: true }
    }
  } else {
    // ★ 实机主形态：扁平键 —— {"tool":"file-reader","path":"."}
    // 除保留键外全部视作参数（TC-PTC-003）
    args = {}
    for (const [k, v] of Object.entries(obj)) {
      if (!RESERVED_KEYS.has(k)) args[k] = v
    }
  }
  return { call: { tool, args } }
}

/**
 * 从模型答复正文中提取工具调用。
 *
 * 接受形态（按真实弱模型输出归纳，用例 TC-PTC-001…015）：
 *   ① fenced ```json / ``` 代码块内的对象或对象数组；
 *   ② 裸 JSON 对象（无 fence）；
 *   ③ 键名兼容 tool|name + arguments|args|parameters|input；
 *   ④ 扁平形态 {"tool":"file-reader","path":"."}（保留键以外的键全视作参数）；
 *   ⑤ 同段 JSON 说两遍 / 叙述与 JSON 混排（花括号扫描兜底）。
 *
 * 宁缺毋滥：普通散文、代码、清单数组一律不产出；重复调用去重。
 */
export function extractProseToolCalls(raw: string | null | undefined): ProseToolExtract {
  if (!raw || !raw.includes('{')) return { calls: [], invalid: 0 }
  const calls: ProseToolCall[] = []
  const seen = new Set<string>()
  let invalid = 0

  const consider = (value: unknown): boolean => {
    // 返回 true = 已达上限，停止全部扫描
    const items = Array.isArray(value) ? value : [value]
    for (const item of items) {
      if (!isPlainObject(item)) continue
      const r = toProseCall(item)
      if (r.invalid) {
        invalid += 1
        continue
      }
      if (!r.call) continue
      const key = JSON.stringify(r.call)
      if (seen.has(key)) continue
      seen.add(key)
      calls.push(r.call)
      if (calls.length >= PROSE_TOOL_CALL_LIMIT) return true
    }
    return false
  }

  // 候选 1：fenced 代码块（先给优先级 —— 明确的代码块比全文扫描更可信）
  let sawFence = false
  for (const m of raw.matchAll(/```(?:json)?[ \t]*\r?\n?([\s\S]*?)```/g)) {
    sawFence = true
    for (const v of parseLooseValues(m[1]!)) {
      if (consider(v)) return { calls, invalid }
    }
  }
  // 候选 2：整段正文（裸 JSON / 叙述混排；去重靠 seen，fence 已命中过的不会重复计入）
  if (!sawFence || calls.length === 0) {
    for (const v of parseLooseValues(raw)) {
      if (consider(v)) return { calls, invalid }
    }
  }
  return { calls, invalid }
}

/**
 * 降级通道**激活谓词**（默认关闭的唯一开关）：
 *   ollama 形态端点（kind=ollama/vllm 或 baseURL 含 :11434）+ 模型 id 含 qwen3.5。
 * 其余一切模型/端点 → false → 主循环、请求体、提示词零变化（I-P6）。
 */
export function isProseToolFallbackModel(model: LlmModel | null | undefined): boolean {
  if (!model || typeof model.id !== 'string') return false
  if (!isOllamaLikeEndpoint(model)) return false
  return /qwen3\.5/i.test(model.id)
}

/**
 * 契约提示（激活后替换通用自愈提示）—— 只对命中谓词的 run 注入。
 * 讲清三件事：原生工具调用不可用 → 正文 JSON 形态 → 每轮至多一个。
 * 工具名清单直接取自可执行白名单（纪律⑦：不复制第二份名单）。
 */
export function proseToolContractHint(): string {
  const names = [...PROSE_TOOL_WHITELIST].join('、')
  return (
    '【引擎提示 · 正文工具通道】你当前运行环境暂时无法使用原生工具调用（function calling）。' +
    '需要执行操作时，请直接在答复正文中输出一个 JSON 工具调用（可以放进 ```json 代码块），格式：' +
    '{"tool": "工具名", "arguments": { …参数… }}，参数也可以与 tool 并列写在同一个对象里。' +
    '引擎会解析该 JSON 并真实执行对应工具、把结果回传给你。每次答复至多输出一个工具调用。' +
    `可用工具名包括：${names}。除该 JSON 外，不要输出伪代码，也不要描述"将要调用"——直接给出 JSON 即可。`
  )
}
