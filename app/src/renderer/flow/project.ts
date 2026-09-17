/* ============================================================
 * ArkWork — 交互区投影层（v0.31.0 B3）
 * 设计文档：docs/versions/v0.31.0/04-system-design.md §5.4.2 / §6.6；
 * 正本 interaction-display-v1.0/07 §2.1。
 *
 * ConversationItem[]（旧 deriveConversation 产出，兼容期双轨）+ ReActStep[] +
 * SessionEvent[] → FlowTurn[]（层级骨架：Turn → Step → Block）。
 *
 * 硬规则（04 §3.3-2）：**本模块必须是纯函数** —— 无 window / document /
 * Date.now() 依赖；时间一律由入参（input.now / 数据自带 ts）带入。
 * 等价性测试（flow/__tests__/equivalence.test.ts）据此对同一输入反复求值。
 * ============================================================ */
import type { ConversationItem, SessionEvent } from '@shared/types/conversation'
import type { PlanItem } from '@shared/types/task'
import type { PlanItemStatus } from '@shared/types/task'
import type { ReActStep } from '@shared/types/react'
import type {
  FlowBlock,
  FlowStep,
  FlowTurn,
  FlowViewMode,
  ReasoningSource,
  SayBlock,
  ToolBlock,
  ToolCallKind,
  ToolStatus,
  TurnStatus,
} from '@shared/types/flow'
import {
  deriveReasoningSource,
  reasoningText,
  firstSentence,
} from '@shared/utils/reasoning'
// v0.31.0 B4：工具呈现协议（main 侧纯模块，渲染层直接消费 —— added/removed
// 计数全仓库唯一实现，§5.4.5 / U2）
import { presentCallOrDefault, presentResultOrDefault } from '../../main/agent/tools/present'
import type { BlockUiState, FlowUiState } from '../store/types'

/* ============================================================
 * 输入 / 输出签名（§5.4.2）
 * ============================================================ */

export interface ProjectInput {
  taskId: string
  /** 现有 ConversationItem[]（兼容期双轨：由旧 deriveConversation 产出） */
  items: ConversationItem[]
  steps: ReActStep[]
  events: SessionEvent[]
  streamBuffers: Record<string, { seq: number; text: string }>
  planItems: PlanItem[]
  viewMode: FlowViewMode
  showThinking: boolean
  /** 折叠态：blockUiState / turnUiState */
  ui: FlowUiState
  /** 注入时间源，保证纯函数可测（硬规则 §3.3-2） */
  now: number
  /**
   * v0.31.0 B3 实装补充（已登记 §11）：轮头 agent 信息。
   * 旧路径由组件层按 selectedAgent 注入；投影层需要同源数据填 TurnHeaderInfo，
   * 故作为可选入参显式传入（缺省给空串，TurnHeader 自行回落）。
   */
  agent?: { id: string; name: string; avatarColor: string }
}

/** 纯函数：无 window / document / Date.now 依赖 */
export function projectConversation(input: ProjectInput): FlowTurn[] {
  const { taskId, items, viewMode, ui, now, agent } = input
  const stepCollapsedDefault = viewMode === 'compact'

  /* ---------- 中间态（可变，构建期专用；出口全部冻结为普通对象） ---------- */
  interface MutableTurn {
    id: string
    index: number
    trigger: 'user' | 'automation' | 'steering'
    agentId: string
    agentName: string
    agentAvatarColor: string
    startedAt: number
    steps: FlowStep[]
    outerBlocks: FlowBlock[]
    thinkingMs: number
    tokensIn: number
    tokensOut: number
    cacheHitTokens: number
    cacheMissTokens: number
    toolCounts: Partial<Record<ToolCallKind, number>>
    toolTotal: number
    minIter: number
    maxIter: number
    status: TurnStatus
    errorMessage?: string
    lastSayId?: string
  }

  const turns: MutableTurn[] = []
  let cur: MutableTurn | null = null
  /** 前一个 react 组首个 reason 步的 action 工具（assistant 项 origin 推导用） */
  let lastReasonTool: string | undefined

  const newTurn = (trigger: MutableTurn['trigger'], ts: number): MutableTurn => {
    const index = turns.length + 1
    const t: MutableTurn = {
      id: `${taskId}:turn-${index}`,
      index,
      trigger,
      agentId: agent?.id ?? '',
      agentName: agent?.name ?? '',
      agentAvatarColor: agent?.avatarColor ?? '',
      startedAt: ts,
      steps: [],
      outerBlocks: [],
      thinkingMs: 0,
      tokensIn: 0,
      tokensOut: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      toolCounts: {},
      toolTotal: 0,
      minIter: Number.MAX_SAFE_INTEGER,
      maxIter: -1,
      status: 'done',
    }
    turns.push(t)
    return t
  }
  const ensureTurn = (trigger: MutableTurn['trigger'], ts: number): MutableTurn => {
    if (!cur) cur = newTurn(trigger, ts)
    return cur
  }

  /* ---------- Block id（确定性：turn/step/kind/序号，无随机源） ---------- */
  const mkBlockId = (turnIdx: number, stepIdx: number, kind: string, seq: number) =>
    `${taskId}:t${turnIdx}:s${stepIdx}:${kind}:${seq}`

  /* ---------- 工具名 → 呈现类别（B3 简化分类；B4 由 present.ts 接管） ---------- */
  const classifyToolKind = (name?: string): ToolCallKind => {
    const n = (name ?? '').toLowerCase()
    if (!n) return 'other'
    if (n.includes('read')) return 'read'
    if (n.includes('write') || n.includes('edit')) return 'edit'
    if (n.includes('delete') || n.includes('remove')) return 'delete'
    if (n.includes('move') || n.includes('rename')) return 'move'
    if (n.includes('search') || n.includes('grep') || n.includes('find')) return 'search'
    if (n.includes('command') || n.includes('shell') || n.includes('exec') || n.includes('terminal')) return 'execute'
    if (n.includes('web') || n.includes('fetch') || n.includes('browser')) return 'fetch'
    return 'other'
  }

  const mapToolStatus = (s: ReActStep): ToolStatus => {
    if (s.status === 'running') return 'running'
    if (s.status === 'cancelled') return 'cancelled'
    if (s.softFail) return 'guarded'
    if (s.status === 'failed') return 'failed'
    return 'success'
  }

  const safeParseArgs = (raw?: string): Record<string, unknown> | undefined => {
    if (!raw) return undefined
    try {
      const v = JSON.parse(raw)
      return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined
    } catch {
      return undefined
    }
  }

  const fmtTime = (ts: number): string => {
    if (!ts) return ''
    const d = new Date(ts)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  const truncate80 = (s: string): string => (s.length > 80 ? s.slice(0, 80) + '…' : s)

  /* ---------- 单个 ReAct iteration 组 → FlowStep ---------- */
  const buildStep = (groupIn: ReActStep[], turn: MutableTurn): FlowStep => {
    const group = [...groupIn].sort((a, b) => a.startedAt - b.startedAt)
    const iteration = group[0]?.iteration ?? 0
    turn.minIter = Math.min(turn.minIter, iteration)
    turn.maxIter = Math.max(turn.maxIter, iteration)

    const blocks: FlowBlock[] = []
    let blockSeq = 0
    let lastTool: ToolBlock | undefined
    let sawTool = false
    let failed = false
    let running = false
    let guarded = false
    let sayCount = 0
    let summary = ''

    for (const s of group) {
      // 计量（全步累计；B3 思考 token 无独立来源，留空）
      turn.tokensIn += s.tokensIn ?? 0
      turn.tokensOut += s.tokensOut ?? 0
      turn.cacheHitTokens += s.cacheHitTokens ?? 0
      turn.cacheMissTokens += s.cacheMissTokens ?? 0

      if (s.type === 'reason') {
        turn.thinkingMs += s.durationMs ?? 0
        const source: ReasoningSource = deriveReasoningSource(s)
        const text = reasoningText(s)
        if (source !== 'none' && text.trim()) {
          blocks.push({
            kind: 'reasoning',
            id: mkBlockId(turn.index, iteration, 'reasoning', blockSeq++),
            turn: turn.index,
            step: iteration,
            seq: blockSeq,
            source,
            text,
            summary: firstSentence(text),
            truncated: s.truncated,
            startedAt: s.startedAt,
            durationMs: s.durationMs ?? 0,
            status: s.status === 'running' ? 'streaming' : s.status === 'failed' ? 'failed' : 'settled',
            errorMessage: s.errorMessage,
          })
        }
        const say = (s.say ?? '').trim()
        if (say) {
          const sb: SayBlock = {
            kind: 'say',
            id: mkBlockId(turn.index, iteration, 'say', blockSeq++),
            turn: turn.index,
            step: iteration,
            text: s.say!,
            status: s.status === 'running' ? 'streaming' : 'settled',
            isSummarySource: false, // 后置 pass 标记本轮最后一个 say
            ts: s.startedAt,
          }
          blocks.push(sb)
          sayCount++
          turn.lastSayId = sb.id
        }
        // v0.31.0 B3 等价性修复：answer 唯一来源 = assistant ConversationItem
        // （与旧 deriveConversation 同源 —— 旧路径对 isFinalAnswer 三分支合成
        // assistant 项；react 组侧不再重复产出，见 §11 登记项）。
        if (s.status === 'running') running = true
        if (s.status === 'failed' && !s.softFail) failed = true
        if (s.softFail) {
          guarded = true
          blocks.push({
            kind: 'notice',
            id: mkBlockId(turn.index, iteration, 'notice', blockSeq++),
            turn: turn.index,
            step: iteration,
            noticeKind: 'soft-fail',
            text: s.errorMessage ?? firstSentence(reasoningText(s)),
            level: 'warning',
            ts: s.startedAt,
          })
        }
        if (!summary) summary = truncate80(firstSentence(reasoningText(s)) || '')
      } else if (s.type === 'act') {
        const kind = classifyToolKind(s.toolName)
        turn.toolCounts[kind] = (turn.toolCounts[kind] ?? 0) + 1
        turn.toolTotal++
        // 等价性口径（R1）：可见文本 = 旧路径同一条 intent 合成串，恒为 string
        const composedIntent = (s.intent ?? '').trim() || s.toolName || ''
        const toolArgs = safeParseArgs(s.toolArgs)
        // v0.31.0 B4：呈现协议 —— 高频工具出富卡（read/write/search/web/terminal），
        // 其余回落 generic（fallbackTitle = composedIntent，呈现不倒退 R3）
        const tb: ToolBlock = {
          kind: 'tool',
          id: mkBlockId(turn.index, iteration, 'tool', blockSeq++),
          turn: turn.index,
          step: iteration,
          call: presentCallOrDefault(s.toolName ?? '', toolArgs, composedIntent),
          status: mapToolStatus(s),
          startedAt: s.startedAt,
          durationMs: s.durationMs ?? 0,
          errorMessage: s.errorMessage,
          intent: composedIntent,
        }
        if (s.result !== undefined && s.result !== null) {
          tb.result = presentResultOrDefault(s.toolName ?? '', toolArgs, s.result, s.resultSummary)
          const isError = s.status === 'failed' && !s.softFail
          if (isError && tb.result.card === 'generic') tb.result.isError = true
        } else if (s.resultSummary) {
          tb.result = {
            card: 'generic',
            summary: s.resultSummary,
            isError: s.status === 'failed' && !s.softFail,
          }
        }
        blocks.push(tb)
        lastTool = tb
        sawTool = true
        if (!summary) summary = truncate80(composedIntent)
        if (s.status === 'running') running = true
        if (s.status === 'failed' && !s.softFail) failed = true
        if (s.softFail) {
          guarded = true
          blocks.push({
            kind: 'notice',
            id: mkBlockId(turn.index, iteration, 'notice', blockSeq++),
            turn: turn.index,
            step: iteration,
            noticeKind: 'soft-fail',
            text: s.errorMessage ?? s.resultSummary ?? '',
            level: 'warning',
            ts: s.startedAt,
          })
        }
      } else if (s.type === 'observation') {
        // observation 归并进最近的 ToolBlock（同一工具调用的结果视图）；孤儿观察自成一卡
        if (lastTool && sawTool) {
          if (s.rawL2Path && !lastTool.rawL2Path) lastTool.rawL2Path = s.rawL2Path
          if (!lastTool.result && s.summary) {
            lastTool.result = { card: 'generic', summary: s.summary }
          }
        } else {
          const tb: ToolBlock = {
            kind: 'tool',
            id: mkBlockId(turn.index, iteration, 'tool', blockSeq++),
            turn: turn.index,
            step: iteration,
            call: { card: 'generic', title: s.summary ?? '', kind: 'other' },
            status: mapToolStatus(s),
            startedAt: s.startedAt,
            durationMs: s.durationMs ?? 0,
          }
          if (s.summary) tb.result = { card: 'generic', summary: s.summary }
          if (s.rawL2Path) tb.rawL2Path = s.rawL2Path
          blocks.push(tb)
          turn.toolTotal++
          lastTool = tb
        }
        if (!summary && s.summary) summary = truncate80(s.summary)
      }
    }

    const status: FlowStep['status'] = failed ? 'failed' : running ? 'running' : guarded ? 'guarded' : 'done'
    return {
      index: iteration,
      summary,
      status,
      collapsed: stepCollapsedDefault,
      durationMs: group.reduce((sum, s) => sum + (s.durationMs ?? 0), 0),
      blocks,
    }
  }

  /* ---------- 计划卡 → PlanBlock（outerBlocks；不走 iteration，与旧渲染一致） ---------- */
  const aggregateOf = (states: PlanItemStatus[]): PlanItemStatus | null => {
    if (states.length === 0) return null
    if (states.some((x) => x === 'failed')) return 'failed'
    if (states.every((x) => x === 'done')) return 'done'
    if (states.some((x) => x === 'running')) return 'running'
    return 'pending'
  }

  const planStatesOf = (item: ConversationItem): PlanItemStatus[] => {
    const n = item.plan?.items?.length ?? 0
    const persisted = input.planItems
    if (persisted.length === n && n > 0) return persisted.map((p) => p.status)
    return (item.planStates ?? []) as PlanItemStatus[]
  }

  /* ---------- 主时间线：items 顺序即真实发生顺序 ---------- */
  for (const item of items) {
    if (item.type === 'user') {
      cur = newTurn('user', item.ts ?? 0)
      cur.outerBlocks.push({
        kind: 'user',
        id: `${cur.id}:user:0`,
        turn: cur.index,
        step: 0,
        text: item.text ?? '',
        ts: item.ts ?? 0,
        tsLabel: item.tsLabel ?? fmtTime(item.ts ?? 0),
      })
    } else if (item.type === 'plan') {
      const t = ensureTurn('automation', item.ts ?? 0)
      const states = planStatesOf(item)
      t.outerBlocks.push({
        kind: 'plan',
        id: item.id,
        turn: t.index,
        step: 0,
        goal: item.plan?.goal ?? '',
        items: item.plan?.items ?? [],
        states,
        aggregate: aggregateOf(states),
        collapsed: false,
        ts: item.ts ?? 0,
      })
    } else if (item.type === 'react') {
      const group = item.steps ?? []
      const ts = group.length > 0 ? Math.min(...group.map((s) => s.startedAt)) : (item.ts ?? 0)
      const t = ensureTurn('automation', ts)
      t.steps.push(buildStep(group, t))
      // 记录该组首个 reason 步的 action 工具 —— 供后续 assistant 项推导 origin
      // （deriveConversation 的 isFinalAnswer 三分支：task_complete / ask_user / 无 action）
      lastReasonTool = group
        .slice()
        .sort((a, b) => a.startedAt - b.startedAt)
        .find((s) => s.type === 'reason')?.action?.tool
    } else if (item.type === 'assistant') {
      const t = ensureTurn('automation', item.ts ?? 0)
      t.outerBlocks.push({
        kind: 'answer',
        id: item.id,
        turn: t.index,
        step: 0,
        text: item.text ?? '',
        origin:
          lastReasonTool === 'task_complete'
            ? 'task-complete'
            : lastReasonTool === 'ask_user'
              ? 'ask-user'
              : 'plain',
        streaming: false,
        ts: item.ts ?? 0,
        tsLabel: item.tsLabel ?? fmtTime(item.ts ?? 0),
      })
      lastReasonTool = undefined
    }
  }

  if (turns.length === 0) return []

  /* ---------- 事件层（SessionEvent）：轮级状态 + 压缩/失败通告 ----------
   * B3 简化（已登记 §11）：渲染层暂无 session 事件读取通道（TurnList 传空数组），
   * 本段逻辑先行就位并配 project.test.ts 用例，通道接入在 B5/B6。 */
  const turnForIteration = (iter: number | undefined): MutableTurn => {
    if (iter === undefined || !Number.isFinite(iter)) return turns[turns.length - 1]
    const hit = turns.find((t) => iter >= t.minIter && iter <= t.maxIter)
    return hit ?? turns[turns.length - 1]
  }
  for (const ev of input.events) {
    if (ev.type === 'memory_compressed' || ev.type === 'context_compacted') {
      const t = turnForIteration('iteration' in ev ? ev.iteration : undefined)
      t.outerBlocks.push({
        kind: 'notice',
        id: `${t.id}:notice:${ev.type}:${(ev as { seq?: number }).seq ?? ''}`,
        turn: t.index,
        step: 'iteration' in ev ? ev.iteration : 0,
        noticeKind: 'compaction',
        text: `L${'layer' in ev ? ev.layer : 1} 上下文压缩：${ev.beforeTokens} → ${ev.afterTokens} tokens`,
        level: 'info',
        ts: (ev as { ts?: number }).ts ?? t.startedAt,
      })
    } else if (ev.type === 'task_failed') {
      const t = turnForIteration(ev.iteration)
      t.status = 'failed'
      t.errorMessage = ev.error
      t.outerBlocks.push({
        kind: 'error',
        id: `${t.id}:error:${ev.seq ?? t.outerBlocks.length}`,
        turn: t.index,
        step: 0,
        text: ev.error,
        actions: ['retry'],
        ts: (ev as { ts?: number }).ts ?? t.startedAt,
      })
    } else if (ev.type === 'task_paused') {
      const t = turnForIteration(ev.iteration)
      t.status = 'paused'
    } else if (ev.type === 'max_iterations_reached') {
      const t = turnForIteration(ev.iteration)
      t.outerBlocks.push({
        kind: 'error',
        id: `${t.id}:error:maxiter:${ev.seq ?? t.outerBlocks.length}`,
        turn: t.index,
        step: 0,
        text: '已达到最大迭代次数',
        actions: [],
        ts: (ev as { ts?: number }).ts ?? t.startedAt,
      })
    }
  }

  /* ---------- 流式思考缓冲（B1 管道的展示侧出口） ----------
   * 缓冲存在 ⇒ reason step 尚未落定 ⇒ 以 streaming ReasoningBlock 挂到最后一轮
   * （等价于旧路径的 StreamingThinkBlock 位置：列表末尾）。历史数据无缓冲，零影响。 */
  const streamKey = `${taskId}:turn:reasoning`
  const buf = input.streamBuffers[streamKey]
  if (buf && buf.text.trim()) {
    const t = turns[turns.length - 1]
    const nextIter = (t.maxIter === Number.MAX_SAFE_INTEGER ? 0 : t.maxIter) + 1
    const lastStep = t.steps[t.steps.length - 1]
    const target: FlowStep = lastStep && lastStep.status === 'running'
      ? lastStep
      : {
          index: nextIter,
          summary: '',
          status: 'running',
          collapsed: false,
          durationMs: 0,
          blocks: [],
        }
    if (target !== lastStep) t.steps.push(target)
    target.blocks.push({
      kind: 'reasoning',
      id: `${t.id}:s${target.index}:reasoning:stream`,
      turn: t.index,
      step: target.index,
      seq: 0,
      source: 'native',
      text: buf.text,
      summary: firstSentence(buf.text),
      startedAt: now,
      durationMs: 0,
      status: 'streaming',
    })
    t.status = 'running'
  }

  /* ---------- 出口组装（冻结 + 默认折叠态应用） ---------- */
  const blockOpenOf = (id: string, dflt: boolean, bs: Record<string, BlockUiState> | undefined): boolean => {
    const st = bs?.[id]
    if (st && st.userOpen !== null) return st.open
    return dflt
  }

  return turns.map((t) => {
    const durationMs = t.steps.reduce((sum, s) => sum + s.durationMs, 0)
    const lastSayInTurn = t.lastSayId
    const applySayFlag = (blocks: FlowBlock[]) => {
      for (const b of blocks) {
        if (b.kind === 'say') (b as SayBlock).isSummarySource = b.id === lastSayInTurn
      }
    }
    t.steps.forEach((s) => applySayFlag(s.blocks))
    applySayFlag(t.outerBlocks)

    const blocksUi = ui?.blockUiState
    const steps: FlowStep[] = t.steps.map((s) => ({
      ...s,
      collapsed: blockOpenOf(`step:${s.index}`, s.collapsed, blocksUi),
      blocks: s.blocks,
    }))

    return {
      id: t.id,
      header: {
        index: t.index,
        trigger: t.trigger,
        agentId: t.agentId,
        agentName: t.agentName,
        agentAvatarColor: t.agentAvatarColor,
        startedAt: t.startedAt,
        durationMs,
        status: t.status,
        metrics: {
          tokensIn: t.tokensIn,
          tokensOut: t.tokensOut,
          cacheHitTokens: t.cacheHitTokens,
          cacheMissTokens: t.cacheMissTokens,
        },
        errorMessage: t.errorMessage,
      },
      steps,
      outerBlocks: t.outerBlocks,
      summary: {
        thinkingMs: t.thinkingMs,
        toolCounts: t.toolCounts,
        toolTotal: t.toolTotal,
        metrics: {
          tokensIn: t.tokensIn,
          tokensOut: t.tokensOut,
          cacheHitTokens: t.cacheHitTokens,
          cacheMissTokens: t.cacheMissTokens,
        },
        firstFailedBlockId: t.steps
          .flatMap((s) => s.blocks)
          .find((b) => (b.kind === 'tool' || b.kind === 'reasoning') && 'status' in b && (b.status === 'failed'))?.id,
      },
      collapsed: ui?.turnUiState?.[t.id]?.collapsed ?? false,
    }
  })
}

/**
 * Turn 渲染序列：outerBlocks 与 steps 按 ts 归并（同 ts 时 step 在前，
 * 与旧路径「react 组先于 assistant 消息」的稳定排序语义一致）。
 * TurnView / 等价性测试共用这一份合并规则，避免两处口径漂移。
 */
export function turnRenderSequence(turn: FlowTurn): FlowBlock[] {
  const tsOf = (b: FlowBlock): number =>
    'ts' in b ? b.ts : 'startedAt' in b ? b.startedAt : Number.MAX_SAFE_INTEGER
  /* 真 ts 归并（§5.4.2）：steps 与 outerBlocks 统一按 ts 排序，同 ts step 在前。
   * sort 稳定（Node ≥12），step-step 平局保持 items 原序。
   * v0.31.0 B3 等价性修复：原两段式切分（ts < firstStepTs ? before : after）会把
   * turn 中段产出的 assistant answer 甩到全部 steps 之后，见 §11。 */
  const entries: Array<{ ts: number; isStep: boolean; blocks: FlowBlock[] }> = []
  for (const s of turn.steps) {
    const ts = s.blocks.length > 0 ? Math.min(...s.blocks.map(tsOf)) : Number.MAX_SAFE_INTEGER
    entries.push({ ts, isStep: true, blocks: s.blocks })
  }
  for (const b of turn.outerBlocks) entries.push({ ts: tsOf(b), isStep: false, blocks: [b] })
  entries.sort((a, e) => a.ts - e.ts || (a.isStep === e.isStep ? 0 : a.isStep ? -1 : 1))
  return entries.flatMap((e) => e.blocks)
}
