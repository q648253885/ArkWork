/* ============================================================
 * ArkWork — 对话 Markdown 渲染（v0.34.4 · D69）
 *
 * 病：导出/复制走的是 `ConversationItem`（4 种 type）粗筛，而屏幕走的是
 * `projectConversation` → `FlowTurn`（**9 种 FlowBlock**）。两条投影、两套模型，
 * 于是用户看到「导出的内容和真正内容不一致」。v0.34.1 只统一了
 * 「复制 vs 导出」，**没人统一「导出 vs 屏幕」**。
 *
 * 治法（纪律⑪「一条投影链只许有一个消费者面」）：
 *   屏幕与导出**共用同一个 `projectConversation`**，本模块只负责把 FlowTurn[]
 *   序列化成人可读 Markdown。屏幕加一种块，导出必须同步能渲染它 ——
 *   由 `conversation-markdown.test.ts` 的「块覆盖真值表」把守：
 *   9 种 FlowBlock 每种至少一条断言，缺一即报红。
 *
 * 硬约束：
 *  - **纯函数**：无 i18n / store / DOM 依赖（node:test 可直接 import）。
 *    标签固定中文（与本机默认语言一致）；如需本地化，由调用方传 `labels`。
 *  - **确定性**：不调用 Date.now()；所有时间来自数据自带 ts / durationMs。
 * ============================================================ */
import type {
  FlowBlock,
  FlowTurn,
  FlowStep,
  TurnStatus,
  ReasoningSource,
  ToolStatus,
} from '@shared/types/flow'

export interface MarkdownLabels {
  agent: string
  turn: string
  step: string
  you: string
  assistant: string
  reasoning: string
  tool: string
  plan: string
  notice: string
  approval: string
  answer: string
  error: string
  /** v0.36.0（F4.1）：并行子 agent 组卡标题 */
  subagent: string
  /** v0.38.0（A5/D156）：阶段结论块标题 */
  note: string
  args: string
  result: string
  errorMsg: string
  duration: string
  tokens: string
  empty: string
}

export const DEFAULT_LABELS: MarkdownLabels = {
  agent: 'Agent',
  turn: '轮',
  step: '步骤',
  you: '你',
  assistant: '助手',
  reasoning: '思考过程',
  tool: '工具',
  plan: '计划清单',
  notice: '通知',
  approval: '待确认',
  answer: '答复',
  error: '错误',
  subagent: '并行子 agent',
  note: '阶段结论',
  args: '参数',
  result: '结果',
  errorMsg: '错误',
  duration: '耗时',
  tokens: 'tokens',
  empty: '（无内容）',
}

/* ---------- 小工具 ---------- */

function fmtDuration(ms: number | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/** HH:MM；无 ts 时返回空串（不编造） */
function fmtClock(ts: number | undefined): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return ''
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

const TURN_STATUS: Record<TurnStatus, string> = {
  running: '进行中',
  done: '已完成',
  failed: '失败',
  paused: '已暂停',
  cancelled: '已取消',
}

const STEP_STATUS: Record<FlowStep['status'], string> = {
  running: '进行中',
  done: '完成',
  failed: '失败',
  guarded: '被守卫拦截',
}

const TOOL_STATUS: Record<ToolStatus, string> = {
  pending: '等待',
  running: '进行中',
  success: '成功',
  failed: '失败',
  guarded: '被守卫拦截',
  cancelled: '已取消',
}

const REASONING_SOURCE: Record<ReasoningSource, string> = {
  native: '原生思考',
  content: '正文通道',
  none: '',
}

/** 统一收口「取文本、去空行、缩进」 */
function text(s: string | undefined): string {
  if (!s) return ''
  return s.replace(/\r\n/g, '\n').trim()
}

function pushBlocked(lines: string[], body: string): void {
  const t = text(body)
  if (!t) return
  lines.push(t, '')
}

/* ---------- 单块渲染 ---------- */

function renderToolArgs(block: Extract<FlowBlock, { kind: 'tool' }>, L: MarkdownLabels): string {
  const call = block.call
  const bits: string[] = [`**${L.tool}**：${call.title}`]
  if (call.kind) bits.push(`类型 \`${call.kind}\``)
  if (call.card === 'generic' && call.rawInput !== undefined) {
    let raw: string
    try {
      raw = JSON.stringify(call.rawInput, null, 2)
    } catch {
      raw = String(call.rawInput)
    }
    bits.push(`${L.args}：\n\`\`\`json\n${raw}\n\`\`\``)
  }
  if (call.card === 'terminal') {
    if (call.description) bits.push(call.description)
    if (call.cwd) bits.push(`cwd: ${call.cwd}`)
  }
  if (call.card === 'write' && call.changes.length > 0) {
    bits.push(
      call.changes
        .map((c) => `- \`${c.path}\` +${c.added} −${c.removed}`)
        .join('\n'),
    )
  }
  // generic / write 卡才带 locations（terminal 卡无此字段）
  const locs = call.card === 'generic' || call.card === 'write' ? call.locations : undefined
  if (locs && locs.length > 0) {
    bits.push(locs.map((l) => `- \`${l.path}${l.line ? `:${l.line}` : ''}\``).join('\n'))
  }
  return bits.join('\n')
}

function renderToolResult(block: Extract<FlowBlock, { kind: 'tool' }>, L: MarkdownLabels): string {
  const r = block.result
  const out: string[] = []
  out.push(`**状态**：${TOOL_STATUS[block.status]}${block.durationMs ? ` ｜ ${L.duration} ${fmtDuration(block.durationMs)}` : ''}`)
  if (block.intent) out.push(`**意图**：${block.intent}`)
  if (r) {
    const summary = text(r.summary)
    if (summary) out.push(`${L.result}：${summary}`)
    if (r.card === 'generic' && r.content) {
      out.push('```\n' + text(r.content) + '\n```')
    }
    if (r.card === 'terminal') {
      if (typeof r.exitCode === 'number') out.push(`exitCode: ${r.exitCode}`)
      if (r.output) out.push('```\n' + text(r.output) + '\n```')
    }
    if (r.card === 'read') {
      if (r.lines.length) {
        out.push(
          '```\n' +
            r.lines.map((l) => `${l.number}\t${l.text}`).join('\n') +
            '\n```',
        )
      }
    }
    if (r.card === 'search' && r.shape === 'paths') {
      if (r.paths.length) out.push(r.paths.map((p) => `- \`${p}\``).join('\n'))
    }
    if (r.card === 'search' && r.shape === 'matches') {
      const lines: string[] = []
      for (const f of r.files) {
        lines.push(`- \`${f.path}\``)
        for (const m of f.matches) lines.push(`  - L${m.lineNumber}: ${m.line}`)
      }
      if (lines.length) out.push(lines.join('\n'))
    }
    if (r.card === 'web' && r.kind === 'search') {
      const lines = r.sources.map((s, i) => `${i + 1}. [${s.title ?? s.url}](${s.url})`)
      if (lines.length) out.push(lines.join('\n'))
      if (r.answer) out.push(r.answer)
    }
    if (r.card === 'web' && r.kind === 'fetch') {
      out.push(`\`${r.url}\` → HTTP ${r.statusCode}`)
    }
    if (r.card === 'write') {
      out.push(r.changes.map((c) => `- \`${c.path}\` +${c.added} −${c.removed}`).join('\n'))
    }
  }
  if (block.errorMessage) out.push(`**${L.errorMsg}**：${block.errorMessage}`)
  if (block.rawL2Path) out.push(`_完整结果：${block.rawL2Path}_`)
  return out.filter((x) => x.trim()).join('\n')
}

function renderBlock(block: FlowBlock, L: MarkdownLabels, out: string[]): void {
  switch (block.kind) {
    case 'user':
      out.push(`### ${L.you}${fmtClock(block.ts) ? ` · ${fmtClock(block.ts)}` : ''}`, '')
      pushBlocked(out, block.text)
      break

    case 'say':
      // 模型显式产出的「结论 + 下一步」
      pushBlocked(out, block.text)
      break

    case 'reasoning': {
      const src = REASONING_SOURCE[block.source]
      const head = [L.reasoning, src, fmtDuration(block.durationMs) && `${L.duration} ${fmtDuration(block.durationMs)}`]
        .filter(Boolean)
        .join(' · ')
      out.push(`#### ${head}`, '')
      const body = text(block.text) || text(block.summary)
      pushBlocked(out, body)
      if (block.errorMessage) pushBlocked(out, `**${L.errorMsg}**：${block.errorMessage}`)
      break
    }

    case 'tool':
      out.push(`#### ${L.tool} · ${block.call.title}`, '')
      pushBlocked(out, renderToolArgs(block, L))
      pushBlocked(out, renderToolResult(block, L))
      // 子调用（缩进列表）
      if (block.children && block.children.length > 0) {
        out.push(`_子调用 ${block.children.length} 个_`, '')
      }
      break

    case 'plan': {
      const goal = text(block.goal)
      out.push(`#### ${L.plan}${goal ? ` · ${goal}` : ''}`, '')
      const marks: Record<string, string> = {
        done: '[x]', running: '[~]', failed: '[!]', skipped: '[-]', cancelled: '[·]', pending: '[ ]',
      }
      out.push(
        block.items
          .map((it, i) => `${marks[block.states[i]] ?? '[ ]'} ${i + 1}. ${it}`)
          .join('\n'),
        '',
      )
      break
    }

    case 'approval':
      out.push(`#### ${L.approval} · ${block.cardKind}`, '')
      if (block.refId) pushBlocked(out, `ref: ${block.refId}`)
      break

    case 'notice':
      out.push(`#### ${L.notice} · ${block.noticeKind}`, '')
      pushBlocked(out, block.text)
      if (block.detail) pushBlocked(out, block.detail)
      break

    case 'answer':
      out.push(`### ${L.answer} · ${block.origin}${block.tsLabel ? ` · ${block.tsLabel}` : ''}`, '')
      pushBlocked(out, block.text)
      break

    case 'error':
      out.push(`#### ${L.error}`, '')
      pushBlocked(out, block.text)
      if (block.detail) pushBlocked(out, block.detail)
      break

    // v0.36.0（F4.1）：并行子 agent 组卡（逐行：agent / 状态 / 耗时 / 摘要）
    case 'subagent-group': {
      out.push(`#### ${L.subagent} · ${block.children.length} 个${block.settled ? '' : '（进行中）'}`, '')
      out.push(
        block.children
          .map((c) => {
            const dur = fmtDuration(c.durationMs)
            const head = `- **@${c.agentName}** · ${c.status}${dur ? ` · ${L.duration} ${dur}` : ''}`
            const obj = text(c.objective)
            const sum = text(c.stepSummary)
            const detail = sum || obj
            return detail ? `${head}\n  ${detail}` : head
          })
          .join('\n'),
        '',
      )
      break
    }

    // v0.38.0（A5/D156）：阶段结论 —— 屏幕上是"不折叠的正文级块"，
    // 导出侧必须同等对待（D69 纪律：屏幕加一种块，导出同步可获得）
    case 'note':
      out.push(`#### ${L.note} · ${block.via}`, '')
      pushBlocked(out, block.text)
      break
  }
}

/* ---------- 主入口 ---------- */

/**
 * 把**与屏幕同一份**投影结果（`FlowTurn[]`）渲染为完整 Markdown。
 *
 * @param title   任务标题
 * @param agentId Agent id（用于页眉与助手署名）
 * @param turns   `projectConversation(...)` 的产物（与 TurnList 同源）
 * @param labels  标签覆盖（缺省中文）
 * @returns 完整 Markdown；无任何轮次时返回空串（调用方据此提示"没有可导出内容"）
 */
export function renderTurnsMarkdown(
  title: string,
  agentId: string,
  turns: FlowTurn[],
  labels: MarkdownLabels = DEFAULT_LABELS,
): string {
  if (!turns || turns.length === 0) return ''
  const L = labels
  const out: string[] = [`# ${title}`, '']
  out.push(`> ${L.agent}: @${agentId} ｜ ${turns.length} ${L.turn}`, '', '---', '')

  for (const turn of turns) {
    const h = turn.header
    const clock = fmtClock(h.startedAt)
    const dur = fmtDuration(h.durationMs)
    const head = [
      `## ${L.turn} #${h.index}`,
      clock,
      TURN_STATUS[h.status] ?? h.status,
      dur && `${L.duration} ${dur}`,
      (h.metrics.tokensIn || h.metrics.tokensOut) &&
        `↑${h.metrics.tokensIn} ↓${h.metrics.tokensOut} ${L.tokens}`,
    ]
      .filter(Boolean)
      .join(' · ')
    out.push(head, '')

    // 轮级错误（ErrorBlock 的轮级来源）
    if (h.errorMessage) out.push(`> **${L.errorMsg}**：${h.errorMessage}`, '')

    // 不走 iteration 的块（用户消息 / 终答 / 轮级错误）
    for (const b of turn.outerBlocks) renderBlock(b, L, out)

    for (const step of turn.steps) {
      const stepHead = [
        `### ${L.step} ${step.index}`,
        text(step.summary),
        STEP_STATUS[step.status] ?? step.status,
        step.durationMs ? `${L.duration} ${fmtDuration(step.durationMs)}` : '',
      ]
        .filter(Boolean)
        .join(' · ')
      out.push(stepHead, '')
      for (const b of step.blocks) renderBlock(b, L, out)
    }

    out.push('---', '')
  }

  const joined = out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
  return joined
}

/** 与 `renderTurnsMarkdown` 同源的空判定（调用方用于 toast 提示） */
export function hasRenderableTurns(turns: FlowTurn[]): boolean {
  if (!turns || turns.length === 0) return false
  return turns.some(
    (t) =>
      t.outerBlocks.length > 0 ||
      t.steps.length > 0 ||
      t.summary.toolTotal > 0,
  )
}
