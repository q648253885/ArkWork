/* ============================================================
 * ArkWork — TaskLedger 投影层（唯一读出口）
 * 设计文档 §3 / §6
 *
 * 三类消费者全部从这里取数，不允许自己拼：
 *  ① `Task.planItems`  —— 既有 UI 通道（ledger 是唯一写入者）
 *  ② 提示词 L1 段      —— 每轮注入，模型看到的清单**永远是账本当前状态**
 *  ③ IPC 快照          —— Renderer 的任务模式徽标 / 恢复点提示条
 * ============================================================ */
import type { PlanItem, PlanItemStatus } from '@shared/types/task'
import type { LedgerSnapshotView } from '@shared/types/ipc'
import type { LedgerFile, LedgerItem, LedgerItemStatus } from './types.js'
import { isLedgerOpen } from './types.js'
import { buildResumeHint } from './resume.js'

/* ---------------- ledger 态 → planItem 态 ---------------- */

/**
 * ledger 内部 9 态 → 既有 PlanItemStatus（图节点 / UI 通道用）。
 * v0.38.1（D177）：导出为唯一映射事实源 —— act.ts 此前私有一份同表，
 * 正则清单回退管线成为第二处消费者后按纪律⑧收敛到这里。
 */
export const TO_PLAN_STATUS: Readonly<Record<LedgerItemStatus, PlanItemStatus>> = {
  pending: 'pending',
  running: 'running',
  paused: 'paused',
  blocked: 'failed',
  verifying: 'running',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
  skipped: 'skipped',
}

/**
 * ledger → PlanItem[]（既有 UI 与迁移路径的唯一来源）
 *
 * v0.39.0（D185）：这里原本**丢弃** `parentId` —— 账本里挂着层级、界面却看不见，
 * 于是"支持子任务"在数据层成立、在用户眼里不成立。现在随投影一起带出，
 * UI（TaskPanel / 任务卡）据此缩进，不需要第二套层级计算。
 */
export function toPlanItems(l: LedgerFile): PlanItem[] {
  return l.items.map((it) => ({
    id: it.id,
    text: it.text,
    status: TO_PLAN_STATUS[it.status],
    createdAt: it.createdAt,
    updatedAt: it.updatedAt,
    completedAt: it.completedAt,
    source: (it.source || 'ledger-sync') as PlanItem['source'],
    parentId: it.parentId ?? null,
    // v0.43.0（R4）：所属任务轮次（旧账本无该字段 → 归一 1，「本轮任务」判据）
    round: it.round ?? 1,
  }))
}

/* ---------------- IPC 快照 ---------------- */

export function toSnapshotView(l: LedgerFile): LedgerSnapshotView {
  return {
    taskId: l.taskId,
    // v0.43.0（R4）：当前轮次随快照透出 —— 「本轮任务」Tab 的唯一判据（账本为准）
    round: l.round ?? 1,
    mode: l.mode,
    modeReason: l.modeReason,
    modeBy: l.modeBy,
    revision: l.revision,
    updatedAt: l.updatedAt,
    items: l.items.map((it) => ({
      id: it.id,
      text: it.text,
      status: it.status,
      parentId: it.parentId,
      acceptance: it.acceptance,
      note: it.note,
      attempts: it.attempts,
      completedAt: it.completedAt,
      // v0.43.0（R4）：逐项轮次（旧账本归一 1）—— 面板据此分区「本轮 / 全部」
      round: it.round ?? 1,
    })),
    resumeHint: l.resume?.hint,
    hasResumePoint: Boolean(l.resume?.hint) || l.items.some((it) => it.status === 'paused'),
    openCount: l.items.filter((it) => isLedgerOpen(it.status)).length,
  }
}

/* ---------------- 提示词投影 ---------------- */

const MARK: Readonly<Record<LedgerItemStatus, string>> = {
  pending: '[ ]',
  running: '[~]',
  paused: '[‖]',
  blocked: '[!]',
  verifying: '[?]',
  done: '[x]',
  failed: '[!]',
  cancelled: '[·]',
  skipped: '[-]',
}

/**
 * 渲染给模型看的清单快照（提示词 L1 段）。
 *
 * 三条设计取舍：
 *  ① **全量**而非"活跃窗口 5~7 个节点"—— 账本文件本身很小（几十项 × 一行），
 *     而"模型看不到某一项"的代价是它会重做或漏做。活跃窗口裁剪那是图投影
 *     （含 acceptance/evidence 全字段）的事，清单快照不裁。
 *  ② 恢复点**置顶**：续聊第一眼必须看到"上次做到哪"，这是治重复执行的关键。
 *  ③ 已完成项显式标注「禁止重做」—— 光有 [x] 不够，模型会当成"可以做一遍"。
 */
export function renderSnapshot(l: LedgerFile, opts?: { maxItems?: number }): string {
  const max = opts?.maxItems ?? 40
  const items = l.items.slice(0, max)
  const counts = l.items.reduce(
    (acc, it) => {
      acc[it.status] = (acc[it.status] ?? 0) + 1
      return acc
    },
    {} as Record<string, number>,
  )
  const lines: string[] = []
  lines.push(`**任务清单（唯一真相 · 账本 r${l.revision} · 模式 ${l.mode}${l.modeBy === 'model' ? ' · 模型自选' : ' · 引擎兜底'}）**`)
  if (l.goal) lines.push(`目标：${l.goal.slice(0, 120)}`)
  lines.push(
    `统计：共 ${l.items.length} 项｜done=${counts.done ?? 0} running=${counts.running ?? 0} ` +
      `paused=${counts.paused ?? 0} pending=${counts.pending ?? 0} verifying=${counts.verifying ?? 0} ` +
      `failed=${counts.failed ?? 0} cancelled=${counts.cancelled ?? 0} skipped=${counts.skipped ?? 0}`,
  )
  const resume = buildResumeHint(l)
  if (resume) lines.push(`**恢复点**：${resume}`)
  lines.push('')
  // v0.39.0（D185）：有父子关系时按层级缩进 —— 模型看到的清单必须是真实结构，
  // 否则它无法判断"做完这批子项，父项才算完"。
  const hasTree = items.some((it) => it.parentId)
  const depthOf = hasTree ? buildDepthMap(l.items) : null
  /** 父项 id → 已渲染的子项序号（产出 1.1 / 1.2 这类复合编号） */
  const childSeq = new Map<string, number>()
  let seq = 0
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!
    const depth = depthOf?.get(it.id) ?? 0
    let idx: string
    if (depth === 0) {
      seq += 1
      idx = `${seq}.`
    } else {
      const n = (childSeq.get(it.parentId ?? '') ?? 0) + 1
      childSeq.set(it.parentId ?? '', n)
      idx = `${indent(depth)}${seq}.${n}`
    }
    const childSummary = depth === 0 && hasTree ? childSummaryOf(l.items, it.id, MARK) : ''
    let line = `${idx} ${MARK[it.status]} ${it.text.slice(0, 80)}${childSummary}`
    if (it.acceptance.length > 0) line += `（验收：${it.acceptance.join('、').slice(0, 80)}）`
    if (it.note && (it.status === 'paused' || it.status === 'blocked' || it.status === 'verifying')) {
      line += ` — ${it.note.slice(0, 80)}`
    }
    lines.push(line)
  }
  if (l.items.length > max) lines.push(`…（另有 ${l.items.length - max} 项已省略，用 task_plan 提交完整清单同步）`)
  const done = l.items.filter((it) => it.status === 'done')
  if (done.length > 0) {
    lines.push('')
    // v0.38.1（D166）：旧文案教模型用 todo_update「把 done 改回 running」—— 工具已下架
    //（D154），且 done 是终态（I8：done 无出边，task_plan 草稿改它会被终态保护拦下），
    // 模型照做必然失败打转。正确动作：直接重做该工作；需跟踪返工就新增一项。
    lines.push(`**已完成 ${done.length} 项，禁止重做**；若判断某项虽标 done 但实际未完成：直接重做该工作即可（清单状态不必改回），` +
      `需要跟踪返工时用 task_plan 提交完整清单并**新增**一项说明原因，不要试图改动已完成项。`)
  }
  return lines.join('\n')
}

/* v0.39.0（W15）：**已删除** `renderTree`。
 *
 * 它是 v0.36.x 的「树形快照」实现；v0.39.0 的层级投影落在 `renderSnapshot`
 * （`buildDepthMap` + 复合编号 + 父项子项摘要）里 —— 同一份清单出现**两种树形渲染**
 * 就是纪律⑧要禁的第二事实源（模型可能照其中一份行事），故整份删除而非保留。
 */

/* ---------------- 层级投影（v0.39.0 / D185） ---------------- */

/** 计算每项深度（0 = 顶级）；同时做「父项不存在」与「越级（>2 层）」的兜底裁剪 */
export function buildDepthMap(items: readonly LedgerItem[]): Map<string, number> {
  const byId = new Map(items.map((it) => [it.id, it]))
  const depth = new Map<string, number>()
  const walk = (it: LedgerItem, d: number): void => {
    depth.set(it.id, d)
    for (const c of items.filter((x) => x.parentId === it.id)) walk(c, d + 1)
  }
  for (const root of items.filter((it) => !it.parentId || !byId.has(it.parentId))) walk(root, 0)
  for (const it of items) if (!depth.has(it.id)) depth.set(it.id, 0)
  return depth
}

function indent(depth: number): string {
  return `${'  '.repeat(depth)}└ `
}

/** 父项行尾的「子项 n/m 已收口」摘要 —— 让模型一眼看出父项还差多少 */
function childSummaryOf(
  items: readonly LedgerItem[],
  parentId: string,
  mark: Readonly<Record<LedgerItemStatus, string>>,
): string {
  const children = items.filter((x) => x.parentId === parentId)
  if (children.length === 0) return ''
  const closed = children.filter((c) => !isLedgerOpen(c.status)).length
  const open = children.filter((c) => c.status === 'running' || c.status === 'verifying')
  const tail = open.length > 0 ? `，进行中：${open[0]!.text.slice(0, 24)}` : ''
  void mark
  return `（子项 ${closed}/${children.length} 已收口${tail}）`
}

/** 未收口项（完成门禁判定用） */
export function openItems(l: LedgerFile): LedgerItem[] {
  return l.items.filter((it) => isLedgerOpen(it.status))
}
