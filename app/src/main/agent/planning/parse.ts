/* ============================================================
 * ArkWork — 规划输出统一解析器（v0.39.0 · F3/F4）
 * 设计文档：docs/versions/v0.39.0/04-system-design.md §6.2
 *
 * 为什么重写而不是继续加分支：
 *   v0.38.1 的 engine/plan-regex.ts 只认两种形态（fenced JSON / outline），
 *   且 **直接把模型自报的 `done` 落库** —— 结合 I8（终态不可回退）与 D176
 *   （产物门禁），一旦误提取即进入不可自愈状态（D181）。v0.39.0 把它升级为
 *   「五级降级链 + 统一安全不变量」，并供规划通道与回退路径共用同一份语义。
 *
 * 三条硬约束：
 *   · **纯函数** —— 无 IO / 无 Date.now() / 无随机；同一输入必得同一输出。
 *   · **宁缺毋滥** —— 提取不到返回 null，调用方回落既有守卫链；绝不把普通
 *     正文误判成清单。
 *   · **不自证完成** —— 解析器产出的 `done` 一律降级 `todo`（S1，D181 解药）。
 * ============================================================ */
import type { DraftStatus, PlanDraftItem } from '../ledger/plan-diff.js'
import { isDraftStatus } from '../ledger/plan-diff.js'
import type { PlanParseVia } from './types.js'
import { PARSE_MAX_ITEMS, PARSE_MAX_TEXT } from './types.js'

export interface PlanParseResult {
  draft: PlanDraftItem[]
  via: PlanParseVia
  /** 0–1，仅供诊断；不参与决策（决策一律走「有结果 / null」） */
  confidence: number
  warnings: string[]
}

interface RawDraftItem {
  text: string
  status?: unknown
  note?: unknown
  parentRef?: unknown
}

const MAX_TEXT = PARSE_MAX_TEXT

function clipText(s: string): string {
  const t = s.trim()
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT - 1)}…` : t
}

/* ---------------- L1/L2/L3：JSON 家族 ---------------- */

/** L1：整段本身就是合法 JSON 数组 */
export function parseJsonStrict(raw: string, allowDone = false): PlanParseResult | null {
  const t = raw.trim()
  if (!t.startsWith('[')) return null
  try {
    const v: unknown = JSON.parse(t)
    return Array.isArray(v) ? finalize(v, 'json-strict', 1, allowDone) : null
  } catch {
    return null
  }
}

/**
 * L2：代码块内的 JSON。支持三种载体：裸数组、`{items:[…]}`、`{plan:[…]}`。
 *
 * 取**最后一个**合法块：实机观察到模型「先写错一次、再改正」，
 * 取第一个会把废弃草案当成主草案。
 */
export function parseJsonFence(raw: string, allowDone = false): PlanParseResult | null {
  const blocks = raw.match(/```(?:json|jsonc|json5)?\s*([\s\S]*?)```/gi)
  if (!blocks || blocks.length === 0) return null
  let hit: PlanParseResult | null = null
  for (const block of blocks) {
    const body = block.replace(/^```(?:json|jsonc|json5)?/i, '').replace(/```$/, '').trim()
    if (!body.startsWith('[') && !body.startsWith('{')) continue
    const r = parseLooseObject(body, allowDone)
    if (r) hit = r
  }
  return hit
}

/**
 * L3：从正文里切出 `[` … `]` 之间再做修补解析。
 *
 * v0.40.0（D205）：**枚举每一个 `]` 作为候选终点**，而不是只试最后一个。
 *
 * 原实现取 `lastIndexOf(']')` —— 一旦正文里有**两段**数组，切出的是「两段拼接」，
 * 永远不是合法 JSON，整层静默失效。实测（打包 0.40.0 + `qwen3.5:0.8b`，任务
 * `T-20260928-1b2p4e`）模型把同一段清单 JSON **说了两遍**：
 *
 *   [{"text":"读取 CSV","status":"done"},…]⏎[{"text":"读取 CSV","status":"done"},…]
 *
 * → `json-strict` 失败（整段非单值）→ `json-fence` 失败（无围栏）
 * → `json-repair` 取到拼接串**也失败** → 清单维护报 `unparsable`。
 * 从后往前逐端点试，第一次成功的那个切片就是一段完整数组（重复时的末段同样可用）。
 */
export function parseJsonRepair(raw: string, allowDone = false): PlanParseResult | null {
  const start = raw.indexOf('[')
  if (start < 0) return null
  for (let end = raw.length - 1; end > start; end--) {
    if (raw[end] !== ']') continue
    const body = repairJson(raw.slice(start, end + 1))
    if (!body) continue
    let v: unknown
    try {
      v = JSON.parse(body)
    } catch {
      continue // 这个终点切出来的不是合法 JSON：试前一个
    }
    if (Array.isArray(v)) {
      const res = finalize(v, 'json-repair', 0.7, allowDone)
      if (res) return res
    }
  }
  return null
}

/** 对象包装形态（`{items:[…]}` / `{plan:[…]}` / `{tasks:[…]}`） */
function parseLooseObject(body: string, allowDone = false): PlanParseResult | null {
  const repaired = repairJson(body)
  if (!repaired) return null
  let v: unknown
  try {
    v = JSON.parse(repaired)
  } catch {
    return null
  }
  if (Array.isArray(v)) return finalize(v, 'json-fence', 0.95, allowDone)
  if (typeof v === 'object' && v !== null) {
    for (const key of ['items', 'plan', 'tasks', 'steps']) {
      const arr = (v as Record<string, unknown>)[key]
      if (Array.isArray(arr)) return finalize(arr, 'json-fence', 0.95, allowDone)
    }
  }
  return null
}

/**
 * 面向弱模型的 JSON 修补：去注释（**字符串感知**）→ 补裸键值引号 →
 * 单引号转双引号 → 去尾逗号。
 *
 * 为什么必须字符串感知：清单文本里常见 URL（`http://…`）或路径，
 * 朴素的行注释正则会把它们砍掉，得到「合法但语义全错」的结果 ——
 * 这类静默错误比解析失败危险得多。
 */
export function repairJson(input: string): string | null {
  let out = ''
  let inStr = false
  let quote = '"'
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!
    const next = input[i + 1]
    if (inStr) {
      out += c
      if (c === '\\') {
        out += next ?? ''
        i += 1
      } else if (c === quote) {
        inStr = false
      }
      continue
    }
    if (c === '"' || c === "'") {
      inStr = true
      quote = c
      out += c
      continue
    }
    if (c === '/' && next === '/') {
      while (i < input.length && input[i] !== '\n') i += 1
      out += '\n'
      continue
    }
    if (c === '/' && next === '*') {
      i += 2
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) i += 1
      i += 1
      continue
    }
    out += c
  }
  // 裸键值补引号（{ text: "a" } → { "text": "a" }）
  let s = out.replace(/([{,]\s*)([A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5]*)\s*:/g, '$1"$2":')
  // 单引号字符串 → 双引号（仅在整段不含双引号时做，避免破坏内含英文撇号的正文）
  if (s.includes("'") && !s.includes('"')) s = s.replace(/'/g, '"')
  // 尾逗号
  s = s.replace(/,(\s*[}\]])/g, '$1')
  return s.trim() === '' ? null : s
}

/* ---------------- L4：Markdown checklist ---------------- */

/**
 * 逐行清单形态 —— 覆盖两种**行首标记**写法（≥2 行才成立）：
 *
 *   A. 勾选框：`- [ ] 步骤` / `* [x] 步骤` / `1. [ ] 步骤`
 *   B. 状态括号：`[done] 步骤` / `[todo] 步骤` / `[running] 步骤`
 *
 * B 形态是 v0.40.0 真机补入的（D205 同批）：实测 `qwen3.5:0.8b`
 * （打包 0.40.0，任务 `T-20260928-1b2p4e`）在清单维护回合输出的是
 * `[running] 读取 CSV 文件并解析数据 ⏎ [pending] 处理列结构…` —— 既不是勾选框，
 * 也没有计划类标题 → 五层降级链**全部落空**，`plan-ops` 报 `unparsable`。
 *
 * 两种形态归同一 `via='checklist'`（不新增 `PlanParseVia` 成员：该枚举是
 * 诊断与文档的共同事实源，扩面会牵动矩阵与门禁）。
 */
const BRACKET_STATUS_RE = /^\s*\[(todo|doing|running|done|skipped|blocked|pending)\]\s*(.+)$/i
/** 行属性状态词 → 对外 5 态（running/pending 是内部 9 态词，需归一） */
const BRACKET_STATUS_MAP: Record<string, string> = {
  todo: 'todo',
  pending: 'todo',
  doing: 'doing',
  running: 'doing',
  done: 'done',
  skipped: 'skipped',
  blocked: 'blocked',
}

export function parseChecklist(raw: string, allowDone = false): PlanParseResult | null {
  const out: RawDraftItem[] = []
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*(?:[-*+]|\d{1,2}[.、)])\s*\[([ xX])\]\s+(.+)$/)
    if (m) {
      const body = m[2]!.trim()
      if (!body) continue
      if (out.length >= PARSE_MAX_ITEMS) break
      // [x] 由 sanitize 降级为 todo（S1），此处保留信号以便告警文案准确
      out.push({ text: body, status: m[1]!.toLowerCase() === 'x' ? 'done' : 'todo' })
      continue
    }
    const b = line.match(BRACKET_STATUS_RE)
    if (b) {
      const body = b[2]!.trim()
      if (!body) continue
      if (out.length >= PARSE_MAX_ITEMS) break
      out.push({ text: body, status: BRACKET_STATUS_MAP[b[1]!.toLowerCase()] ?? 'todo' })
      continue
    }
    if (out.length > 0) break
  }
  if (out.length < 2) return null
  return finalize(out, 'checklist', 0.8, allowDone)
}

/* ---------------- L5：计划类标题 + 列表 outline ---------------- */

/** 从一句清单文本里识别状态标记（outline 形态无结构化 status，靠关键词） */
function statusFromKeywords(line: string): string {
  if (/已完成|已做完|做完了|✅/.test(line)) return 'done'
  if (/进行中|正在执行|正在做|🔄/.test(line)) return 'doing'
  if (/已跳过|跳过/.test(line)) return 'skipped'
  if (/受阻|等待|阻塞/.test(line)) return 'blocked'
  return 'todo'
}

/**
 * 「计划类标题 + 编号/列表」形态。
 *
 * 误伤防御（这是全解析器最脆的一层）：① 必须有计划类标题；② 必须 ≥2 条；
 * ③ 遇到第一个非列表段落即停（清单区块结束）。
 */
export function parseOutline(raw: string, allowDone = false): PlanParseResult | null {
  const heading = raw.match(
    /^[^\S\n]*(?:#{1,4}\s*)?.{0,12}(?:任务清单|计划清单|执行计划|实施计划|开发计划|清单|计划)[^\S\n]*[:：]?[^\S\n]*$/m,
  )
  if (!heading || heading.index === undefined) return null
  const after = raw.slice(heading.index + heading[0].length)
  const out: RawDraftItem[] = []
  for (const line of after.split('\n')) {
    if (out.length > 0 && !/^\s*(?:\d{1,2}[.、)．]|[•\-*+])\s*\S/.test(line)) break
    const m = line.match(/^\s*(?:\d{1,2}[.、)．]|[•\-*+])\s+(.+)$/)
    if (!m) continue
    const body = m[1]!.trim()
    if (!body) continue
    if (out.length >= PARSE_MAX_ITEMS) break
    out.push({ text: body, status: statusFromKeywords(body) })
  }
  if (out.length < 2) return null
  return finalize(out, 'outline', 0.6, allowDone)
}

/* ---------------- 统一收口：形状转换 + 安全不变量 ---------------- */

/**
 * 把任意一层产出的原始条目转成 `PlanDraftItem`，并施加安全不变量。
 *
 * 安全不变量顺序（有先后依赖，改动前先看这里）：
 *   S4 去空 / 截断 / 去重 → S3 非法态归 todo → **S1 done 降级 todo**
 *   → S2 最多一个 doing → S5 噪声上限 → S6 纯函数
 */
export function sanitizeDraft(
  items: readonly RawDraftItem[],
  via: PlanParseVia,
  allowDone = false,
): { items: PlanDraftItem[]; warnings: string[] } | null {
  const warnings: string[] = []
  const out: PlanDraftItem[] = []
  const seen = new Set<string>()
  let doingSeen = false
  let doneDowngraded = 0

  for (const raw of items) {
    if (out.length >= PARSE_MAX_ITEMS) break
    if (typeof raw.text !== 'string') continue
    const text = clipText(raw.text)
    if (!text) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    let status: DraftStatus = isDraftStatus(raw.status) ? raw.status : 'todo'
    if (!isDraftStatus(raw.status) && raw.status !== undefined && raw.status !== null) {
      warnings.push(`「${text.slice(0, 20)}」的状态无法识别，已按待做处理`)
    }
    // S1：引擎不得替模型宣告完成（D181 解药）
    //
    // v0.40.0（PlanOps）：`allowDone` 为放行开关，**默认 false** —— 既有两条路径
    // （规划通道 / 正文解析回退）行为零变化。为什么要放行：PlanOps 的
    // update / complete 要求模型输出**完整**清单并「保留已完成项」，若此处
    // 无条件降级，模型原样返回清单就会把已完成项**回退成待做** —— 清单倒退，
    // 与本版目标正好相反。放行只发生在 PlanOps 的 update / complete 两类调用。
    const declaredDone = status === 'done'
    if (declaredDone && !allowDone) {
      status = 'todo'
      doneDowngraded += 1
    }
    // S2：最多一个 doing
    if (status === 'doing') {
      if (doingSeen) {
        status = 'todo'
        warnings.push(`「${text.slice(0, 20)}」被降为待做：同时只能有一项在进行中`)
      } else {
        doingSeen = true
      }
    }
    const note = typeof raw.note === 'string' && raw.note.trim() ? raw.note.trim().slice(0, 200) : undefined
    const parentRef = typeof raw.parentRef === 'string' && raw.parentRef.trim() ? raw.parentRef.trim() : undefined
    const item: PlanDraftItem = {
      text,
      status,
      ...(note ? { note } : {}),
      ...(parentRef ? { parentRef } : {}),
    }
    if (declaredDone && !allowDone) {
      item.note = note
        ? `${note}｜解析自正文，未经执行验证`
        : '解析自正文，未经执行验证（引擎不代你确认完成，可经 task_plan 标为已完成）'
    }
    out.push(item)
  }

  if (doneDowngraded > 0) {
    warnings.push(`${doneDowngraded} 项声明为「已完成」，因缺少可核对的执行证据已降级为待做`)
  }
  if (out.length === 0) return null
  void via
  return { items: out, warnings }
}

function finalize(
  raw: readonly RawDraftItem[],
  via: PlanParseVia,
  confidence: number,
  allowDone = false,
): PlanParseResult | null {
  const res = sanitizeDraft(raw, via, allowDone)
  if (!res) return null
  return { draft: res.items, via, confidence, warnings: res.warnings }
}

/**
 * 统一入口：五级降级链的公共调用点。提取不到返回 null（宁缺毋滥）。
 * 层序（不可乱）：json-strict → json-fence → json-repair → checklist → outline。
 *
 * @param opts.allowDone 放行解析出的 `done`（默认 false）。
 *   只有 v0.40.0 的 PlanOps `update` / `complete` 需要它 —— 它们要求模型
 *   输出**完整**清单并保留已完成项，无条件降级会让清单倒退。
 *   既有调用方（规划通道 / 正文解析回退）不传 → 行为完全不变。
 */
export function parsePlannerOutput(
  raw: string | null | undefined,
  opts?: { allowDone?: boolean },
): PlanParseResult | null {
  if (!raw || !raw.trim()) return null
  const allowDone = opts?.allowDone === true
  return (
    parseJsonStrict(raw, allowDone) ??
    parseJsonFence(raw, allowDone) ??
    parseJsonRepair(raw, allowDone) ??
    parseChecklist(raw, allowDone) ??
    parseOutline(raw, allowDone)
  )
}
