/* ============================================================
 * ArkWork — TaskLedger 变更算子（纯逻辑，作用于可变副本）
 * 设计文档 §3
 *
 * 每个算子返回 `{ ok, changed, error? }`：
 *  - `ok=false` → 整个 mutate 事务拒绝（副本丢弃，磁盘与缓存不动）
 *  - `changed` 记录实际生效的项，供广播与结果摘要使用
 *
 * 不变量（设计文档 §2.3）：
 *  I1 最多一项 running（spec 模式允许并行）
 *  I2 done 需验收契约（spec 模式缺 acceptance → 降级 verifying，不拒绝）
 *  I3/I8 终态不可逆（force 除外）
 *  I4 dependsOn 无环
 *  I5 父项 done 要求子项全终态
 *  I6 blocked 必须带 note
 * ============================================================ */
import {
  type LedgerFile,
  type LedgerItem,
  type LedgerItemStatus,
  type LedgerMode,
  type LedgerArtifact,
  type LedgerError,
  isLedgerTerminal,
  isLedgerOpen,
  canLedgerTransition,
} from './types.js'
import { appendLog } from './file.js'

/** v0.39.0（D186）：父项相关引导文案 —— 单一事实源，避免重复教模型同一个玩法 */
export const PLAN_PARENT_HINT = '任务层级：父 + 子，最多两层；用 `parent` 字段声明父项（父项 id / `#序号` / 父项文本前若干字均可）。'
import { evaluateArtifact } from './resume.js'
import type { PlanLayoutEntry } from './plan-diff.js'

export interface OpResult {
  ok: boolean
  changed: Array<{ itemId: string; from: LedgerItemStatus; to: LedgerItemStatus; note?: string }>
  error?: LedgerError
  /**
   * 引擎自动纠正的人话回执（v0.42.2 · D214c）。
   *
   * 为什么必须有：不变量改写（如 I2 把 done 降级 verifying）发生后，若只按
   * **预执行草案**回执（「完成：…」），模型看到的回执与实际落盘状态自相矛盾，
   * 只能反复重交（真机死循环实锤）。这里收集的是「事实 + 出路」，调用方
   * （plan-commit-pipeline → act.ts）必须拼进 observation。
   */
  warnings?: string[]
}

const OK_EMPTY: OpResult = { ok: true, changed: [] }

function fail(code: LedgerError['code'], message: string, hint?: string): OpResult {
  return { ok: false, changed: [], error: { code, message, hint } }
}

export type LedgerOp =
  | { kind: 'set-mode'; mode: LedgerMode; reason?: string; by: 'model' | 'engine' }
  | { kind: 'replace-all'; items: Array<{ text: string; acceptance?: string[]; artifact?: LedgerArtifact }>; reason: string }
  | { kind: 'append'; text: string; parentId?: string | null; acceptance?: string[]; artifact?: LedgerArtifact; reason: string; nodeId?: string }
  | { kind: 'set-status'; itemId: string; to: LedgerItemStatus; source: string; note?: string; force?: boolean }
  | { kind: 'advance'; fromItemId: string; source: string; note?: string; to?: LedgerItemStatus }
  | { kind: 'park'; reason: string; itemId?: string | null }
  | { kind: 'discard'; reason: string }
  | { kind: 'resume'; reason: string }
  | { kind: 'sweep-stale'; maxIdleMs: number; reason: string }
  | { kind: 'seal'; outcome: 'completed' | 'failed' | 'cancelled'; reason: string }
  /**
   * 任务图镜像**单向下推**到账本（v0.37.0 · D132）。
   * 图是富语义层（验收条件 / 依赖 / 验证证据），但**清单状态以账本为准**：
   * 图侧只能把状态推给账本，不得反向覆盖，也不得绕过账本直写 `planItems`。
   * 终态项一律不动（I8）—— 图落后于账本时以账本为准，这正是"重复执行"的防线。
   */
  | { kind: 'mirror'; items: Array<{ nodeId: string; to: LedgerItemStatus }>; reason: string }
  | { kind: 'touch-sync' }
  /** 完成门禁拒绝计数 +1（跨 run 持久，上限 MAX_LEDGER_REFUSALS） */
  | { kind: 'bump-refusal' }
  /**
   * v0.38.1（D176）：成果产物声明 —— 把一项与它的可核对产物绑定（null 清除）。
   * 完成门禁 ARTIFACT 判据的数据面：声明后由 guardFinish 做 file/dir 存在性核对。
   */
  | { kind: 'set-artifact'; itemId: string; artifact: LedgerArtifact | null }
  /**
   * v0.38.0（D154）：模型提交**完整计划**后的差异落库（控制面唯一入口的服务端实现）。
   *
   * 与 `replace-all` 的区别：
   *  - `replace-all` 是"全新计划"（有终态项即拒绝，防 replan 抹掉历史）；
   *  - `plan-commit` 是"增量式全量提交"—— draft 里通常**包含**已完成项，
   *    因此允许存在终态项。它按 `layout` 重建数组顺序，并**复用**已有项的
   *    id / createdAt / attempts / acceptance / nodeId（只更新状态 / note / 文本 / artifact）。
   *
   * v0.38.1（D175）：existing 项现在会应用 `layout.text`（配对成功 = 同一件工作，
   * 文本以模型最新提交为准）—— 此前文本不可更新，导致「整体重制计划」时新文本
   * 被静默丢弃。v0.38.1（D176）：existing 项在 `layout.artifact` 给出时覆盖产物声明。
   *
   * 状态变更复用 `setStatus` → I1/I2/I5/I6/I8 全部不变量照常生效。
   */
  | { kind: 'plan-commit'; layout: PlanLayoutEntry[]; reason: string; source: string }
  | { kind: 'note'; itemId: string; note: string }
  /**
   * v0.39.0（F8）：重做 —— 把一项从终态拉回「进行中」。
   * 为什么要有它：I8（终态不可逆）保护历史，但现实中「做完了却发现做错了」
   * 是常态。此前模型唯一的出路是新建一项（历史断裂）或调 force（语义含糊）；
   * 现在有了一条**带理由、带留痕**的正路。
   */
  | { kind: 'reopen'; itemId: string; reason: string; source: string }

/* ---------------- 内部工具 ---------------- */

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

function findIndex(l: LedgerFile, itemId: string): number {
  return l.items.findIndex((it) => it.id === itemId)
}

/** 幂等 setter：不合法转换按 force 决定拒绝还是穿透 */
function setStatus(
  l: LedgerFile,
  itemId: string,
  to: LedgerItemStatus,
  source: string,
  note: string | undefined,
  force: boolean,
  changed: OpResult['changed'],
  /**
   * v0.43.0（R5）：**完成必须有产物证据（全模式）**。
   * plan-commit 通道传 true —— 任何模式下 done 无 artifact 都降级 verifying；
   * 其余通道（set-status 等）默认 false —— 沿用 spec 模式「缺验收且无产物」降级
   *（手动标记完成的行为不变）。
   */
  artifactRequiredForDone = false,
): LedgerError | null {
  const idx = findIndex(l, itemId)
  if (idx < 0) {
    return { code: 'NOT_FOUND', message: `清单项不存在：${itemId}`, hint: '清单可能已被重构，请用 task_plan 重新提交完整清单（引擎会自动比对差异）。' }
  }
  const item = l.items[idx]!
  const from = item.status
  if (from === to) {
    // 幂等：只有 note 更新也算变更（人话理由可能升级）
    if (note && note !== item.note) {
      item.note = note
      item.updatedAt = Date.now()
      changed.push({ itemId, from, to, note })
    }
    return null
  }
  // I8 终态不可逆
  if (isLedgerTerminal(from) && !force) {
    return {
      code: 'INVARIANT',
      message: `清单项 ${itemId} 已处于终态 ${from}，不可回退为 ${to}`,
      hint: '这是不变量 I8（终态不可逆）。确需重做请用 reopen 算子（或经 task_plan 新建一项），不要改写已完成项。',
    }
  }
  if (!force && !canLedgerTransition(from, to)) {
    return { code: 'INVARIANT', message: `非法状态转换：${from} → ${to}（清单项 ${itemId}）` }
  }
  // I2：完成必须有证据 → 降级 verifying（不拒绝，避免模型卡死）。
  // v0.42.2（D214a）：task_plan 的 schema **没有 acceptance 字段** —— 唯一清单入口
  // 建出的项 acceptance 恒空，本判据原先使 spec 模式下 done **经清单路径永不可达**
  //（真机死循环：DeepSeek / qwen3.8 反复重交同一项 8+ 次）。可达出路 = D176 的
  // artifact 声明（完成门禁 ARTIFACT 判据收尾时会核对产物存在性，验收口径一致）：
  // 带声明的 done 不再降级。注意 plan-commit 已把 artifact 先于本判定落盘（D214a
  // 写入顺序修复），同一次提交里「标 done + 声明产物」一步到位。
  //
  // v0.43.0（R5）：把该降级从「spec 缺 acceptance」推广为**全模式完成必须有产物证据**。
  // 由 plan-commit 通道传 artifactRequiredForDone=true 触发（模型经清单标记完成的路径）；
  // set-status 手动路径保持原 spec 语义，行为不变。
  let target = to
  const artifactMissing = !force && to === 'done' && !item.artifact
  const specLegacy = l.mode === 'spec' && item.acceptance.length === 0
  if (artifactMissing && (artifactRequiredForDone || specLegacy)) {
    target = 'verifying'
    note = `${note ? `${note}｜` : ''}完成未声明成果产物，引擎降级为 verifying —— 带 artifact 声明重新提交即为 done`
  }
  // I6：blocked 必须带 note
  if (target === 'blocked' && !note) {
    return { code: 'INVARIANT', message: `清单项 ${itemId} 标 blocked 必须说明理由（note）` }
  }
  // I5：父项 done 要求子项全终态
  if (isLedgerTerminal(target) && target === 'done') {
    const children = l.items.filter((c) => c.parentId === itemId)
    const openChildren = children.filter((c) => !isLedgerTerminal(c.status))
    if (openChildren.length > 0) {
      return {
        code: 'INVARIANT',
        message: `清单项 ${itemId} 仍有 ${openChildren.length} 个子项未终态，不能标 done`,
        hint: '先把子项收口（done / cancelled / skipped）。',
      }
    }
  }
  // I1：最多一项 running（spec 模式允许并行）
  if (target === 'running' && l.mode !== 'spec') {
    const others = l.items.filter((it) => it.status === 'running' && it.id !== itemId)
    if (others.length > 0) {
      return {
        code: 'INVARIANT',
        message: `已有一项在执行（${others[0]!.text.slice(0, 24)}…），不能同时 running 第二项`,
        hint: '不变量 I1：一次只做一件事。先收口当前项，或切到规模式显式声明并行。',
      }
    }
  }

  item.status = target
  item.updatedAt = Date.now()
  item.source = source
  if (note !== undefined) item.note = note
  if (target === 'running') {
    item.startedAt = Date.now()
    item.attempts += 1
    item.completedAt = undefined
  }
  if (isLedgerTerminal(target)) item.completedAt = Date.now()
  changed.push({ itemId, from, to: target, note: item.note })
  appendLog(l, { at: Date.now(), op: 'set-status', itemId, from, to: target, by: source, note: item.note })
  return null
}

/** 环检测（I4）：从 nodeId 出发沿 dependsOn 是否能回到自身 */
function hasCycle(l: LedgerFile, startId: string, deps: string[]): boolean {
  const seen = new Set<string>()
  const stack = [...deps]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (id === startId) return true
    if (seen.has(id)) continue
    seen.add(id)
    const node = l.items.find((it) => it.id === id)
    if (node) stack.push(...node.dependsOn)
  }
  return false
}

/* ---------------- 算子 ---------------- */

export async function applyOp(l: LedgerFile, op: LedgerOp): Promise<OpResult> {
  switch (op.kind) {
    case 'set-mode': {
      if (l.mode === op.mode && l.modeBy === op.by) return OK_EMPTY
      const from = l.mode
      l.mode = op.mode
      l.modeBy = op.by
      l.modeReason = op.reason ?? ''
      appendLog(l, { at: Date.now(), op: 'set-mode', from, to: op.mode, by: op.by, note: op.reason })
      return OK_EMPTY
    }

    case 'replace-all': {
      // 保留已完成项：整表替换只允许在「无任何终态项」时执行（防 replan 抹掉历史）
      const hasTerminal = l.items.some((it) => isLedgerTerminal(it.status))
      if (hasTerminal) {
        return fail(
          'INVARIANT',
          '清单已存在终态项，不能用 replace-all 整表替换',
          '不变量 I8：已完成的工作不可被抹掉。请经 task_plan 提交包含已完成项的完整清单（引擎按差异处理）。',
        )
      }
      const now = Date.now()
      const next = op.items.map((it, i) => {
        const item: LedgerItem = {
          id: newId(`li${i}`),
          text: it.text,
          status: i === 0 ? 'running' : 'pending',
          parentId: null,
          dependsOn: [],
          acceptance: it.acceptance ?? [],
          artifact: it.artifact,
          createdAt: now,
          updatedAt: now,
          startedAt: i === 0 ? now : undefined,
          source: 'plan-regen',
          attempts: i === 0 ? 1 : 0,
        }
        return item
      })
      // I4 环检测（本算子 dependsOn 全空，仅防御未来扩展）
      for (const it of next) {
        if (hasCycle({ ...l, items: next }, it.id, it.dependsOn)) {
          return fail('INVARIANT', `dependsOn 存在环：${it.id}`)
        }
      }
      l.items = next
      appendLog(l, { at: now, op: 'replace-all', by: 'engine', note: `${op.reason}（${next.length} 项）` })
      return { ok: true, changed: next.map((it) => ({ itemId: it.id, from: 'pending' as LedgerItemStatus, to: it.status })) }
    }

    case 'append': {
      const now = Date.now()
      const item: LedgerItem = {
        id: newId('li'),
        text: op.text,
        status: 'pending',
        parentId: op.parentId ?? null,
        dependsOn: [],
        acceptance: op.acceptance ?? [],
        artifact: op.artifact,
        createdAt: now,
        updatedAt: now,
        source: 'task-create',
        attempts: 0,
        nodeId: op.nodeId,
      }
      if (op.parentId) {
        const parent = l.items.find((it) => it.id === op.parentId)
        if (!parent) return fail('NOT_FOUND', `父清单项不存在：${op.parentId}`)
        if (isLedgerTerminal(parent.status)) {
          return fail('INVARIANT', `父清单项 ${op.parentId} 已终态（${parent.status}），不能挂子项`)
        }
      }
      l.items.push(item)
      appendLog(l, { at: now, op: 'append', itemId: item.id, by: 'task-create', note: op.text.slice(0, 60) })
      return { ok: true, changed: [{ itemId: item.id, from: 'pending', to: 'pending' }] }
    }

    case 'set-status': {
      const changed: OpResult['changed'] = []
      const err = setStatus(l, op.itemId, op.to, op.source, op.note, op.force ?? false, changed)
      return err ? fail(err.code, err.message, err.hint) : { ok: true, changed }
    }

    case 'advance': {
      const changed: OpResult['changed'] = []
      const from = op.to ?? 'done'
      const err = setStatus(l, op.fromItemId, from, op.source, op.note, true, changed)
      if (err) return fail(err.code, err.message, err.hint)
      // 自动推进：把下一个 pending 提到 running（不越权改 paused/blocked —— 那些需要人决定）
      const nextIdx = l.items.findIndex((it) => it.status === 'pending')
      if (nextIdx >= 0) {
        const next = l.items[nextIdx]!
        const e2 = setStatus(l, next.id, 'running', op.source, '引擎自动推进（上一项已收口）', true, changed)
        if (e2) return fail(e2.code, e2.message, e2.hint)
      }
      return { ok: true, changed }
    }

    /** D131：`park` = 「可恢复的暂停」。running → paused，pending 原样保留，写恢复点 */
    case 'park': {
      const changed: OpResult['changed'] = []
      const interrupted = op.itemId ?? l.items.find((it) => it.status === 'running')?.id ?? null
      for (const it of [...l.items]) {
        if (it.status === 'running') {
          const err = setStatus(l, it.id, 'paused', 'park', op.reason, true, changed)
          if (err) return fail(err.code, err.message, err.hint)
        }
      }
      l.resume = {
        ...l.resume,
        at: Date.now(),
        itemId: interrupted,
        reason: op.reason,
        hint: buildParkHint(l, interrupted, op.reason),
      }
      appendLog(l, { at: Date.now(), op: 'park', itemId: interrupted ?? undefined, by: 'engine', note: op.reason })
      return { ok: true, changed }
    }

    /** 明确取消：未完成项一律 cancelled（保留 v0.19.1 的既有语义） */
    case 'discard': {
      const changed: OpResult['changed'] = []
      for (const it of [...l.items]) {
        if (isLedgerOpen(it.status)) {
          const err = setStatus(l, it.id, 'cancelled', 'user-cancel', op.reason, true, changed)
          if (err) return fail(err.code, err.message, err.hint)
        }
      }
      l.resume = { ...l.resume, hint: undefined, itemId: null, reason: op.reason }
      appendLog(l, { at: Date.now(), op: 'discard', by: 'engine', note: op.reason })
      return { ok: true, changed }
    }

    /** 恢复点三段式判定（产出物为准，不是状态为准） */
    case 'resume': {
      const changed: OpResult['changed'] = []
      for (const it of [...l.items]) {
        if (it.status !== 'paused') continue
        const verdict = await evaluateArtifact(it)
        if (verdict === 'done') {
          const err = setStatus(l, it.id, 'done', 'resume', '产出物校验通过，判定中断前已完成', true, changed)
          if (err) return fail(err.code, err.message, err.hint)
        } else if (verdict === 'reset') {
          const err = setStatus(l, it.id, 'pending', 'resume', '产出物缺失或不完整，重置待执行', true, changed)
          if (err) return fail(err.code, err.message, err.hint)
        } else {
          // 无产出物声明：保持 paused，交给模型在下一轮自行判定
          it.attempts += 1
          changed.push({ itemId: it.id, from: 'paused', to: 'paused', note: '无产出物声明，保持暂停待模型判定' })
        }
      }
      appendLog(l, { at: Date.now(), op: 'resume', by: 'engine', note: op.reason })
      return { ok: true, changed }
    }

    /** 过期巡检：running 太久无进展 → paused（终态与 pending 不动） */
    case 'sweep-stale': {
      const changed: OpResult['changed'] = []
      const now = Date.now()
      for (const it of [...l.items]) {
        if (it.status !== 'running') continue
        const since = it.startedAt ?? it.updatedAt
        if (now - since < op.maxIdleMs) continue
        const err = setStatus(
          l,
          it.id,
          'paused',
          'sweep-stale',
          `${op.reason}（已 ${Math.round((now - since) / 1000)}s 无进展，暂停待你确认：继续 / 跳过 / 改路线）`,
          true,
          changed,
        )
        if (err) return fail(err.code, err.message, err.hint)
      }
      return { ok: true, changed }
    }

    /** 回合收口：把清单状态与任务终态对齐（D35/D36 的 ledger 版本） */
    case 'seal': {
      const changed: OpResult['changed'] = []
      for (const it of [...l.items]) {
        if (isLedgerTerminal(it.status)) continue
        let to: LedgerItemStatus = 'cancelled'
        if (op.outcome === 'failed' && (it.status === 'running' || it.status === 'verifying')) to = 'failed'
        if (op.outcome === 'completed') continue // completed 不动节点，只清恢复点
        const err = setStatus(l, it.id, to, 'seal', op.reason, true, changed)
        if (err) return fail(err.code, err.message, err.hint)
      }
      if (op.outcome === 'completed') l.resume = { ...l.resume, hint: undefined, itemId: null }
      appendLog(l, { at: Date.now(), op: `seal:${op.outcome}`, by: 'engine', note: op.reason })
      return { ok: true, changed }
    }

    /** 图 → 账本的单向镜像下推（图侧不得反向覆盖账本终态） */
    case 'mirror': {
      const changed: OpResult['changed'] = []
      for (const m of op.items) {
        const item = l.items.find((it) => it.nodeId === m.nodeId || it.id === m.nodeId)
        if (!item) continue
        if (item.status === m.to) continue
        // I8：账本已终态的项不接受图的在途状态（图落后于账本时以账本为准）
        if (isLedgerTerminal(item.status)) continue
        const err = setStatus(l, item.id, m.to, 'graph-mirror', op.reason, true, changed)
        if (err) return fail(err.code, err.message, err.hint)
      }
      if (changed.length > 0) {
        appendLog(l, { at: Date.now(), op: 'mirror', by: 'graph', note: `${op.reason}（${changed.length} 项）` })
      }
      return { ok: true, changed }
    }

    case 'touch-sync': {
      // v0.38.0（D151）：清零点**唯一**就在这一行 —— 拒绝计数归零，且不再维护
      // 第二个"待同步"布尔（那个字段已随 D128 通道一起删除）。
      l.resume = { ...l.resume, refusals: 0 }
      return OK_EMPTY
    }

    case 'bump-refusal': {
      l.resume = { ...l.resume, refusals: (l.resume?.refusals ?? 0) + 1 }
      return OK_EMPTY
    }

    case 'plan-commit': {
      const now = Date.now()
      const byId = new Map(l.items.map((it) => [it.id, it]))
      const changed: OpResult['changed'] = []
      // v0.42.2（D214c）：引擎自动纠正的人话回执（I2 降级等），随 OpResult 透传
      const warnings: string[] = []

      // v0.43.0（R4/R1）：**轮次晋升** —— 提交含新建项且**提交前账本已有项**
      // = replan（清单结构性变化）。轮次 +1；新建项 stamp 新轮次，沿用项保留原轮次
      //（「之前的任务只保留在全部中」）；提交 reason 即本轮目标简介（落 l.goal，
      // 经图同步下推 snapshot.goal）。
      // 判据两点，缺一不可：
      //  · 首次建计划（账本原为空）**不**晋升 —— 那不是 replan，第一轮就是 1；
      //  · 纯状态更新（无新建项）不晋升 —— 已完成项的重确认不会把任务踢出新轮次。
      const creates = op.layout.filter((e) => e.kind === 'new').length
      if (creates > 0) {
        // reason 即本轮目标简介 —— 首次建计划与 replan 都更新（面板标题随之刷新）。
        if (op.reason && op.reason.trim()) l.goal = op.reason.trim()
        // 仅「真 replan」（账本原有项）晋升轮次；首次建计划保持第 1 轮。
        if (l.items.length > 0) l.round = (l.round ?? 1) + 1
      }

      // ① 先落状态 —— 复用 setStatus 的全部不变量检查（I1/I2/I5/I6/I8）。
      //    v0.42.2（D214a）：**artifact 先于 setStatus 落盘** —— I2 的可达出路是
      //    「带 artifact 的 done 不降级」，若 artifact 在状态转换之后才写，同一次
      //    提交里「标 done + 声明产物」仍会被降级（多烧一轮 + 回执矛盾）。
      for (const entry of op.layout) {
        if (entry.kind !== 'existing') continue
        const it = byId.get(entry.id)
        if (!it) {
          return fail('NOT_FOUND', `清单项不存在：${entry.id}`, '清单可能已被重构，请重新读取后再提交。')
        }
        // v0.38.1（D176）：本条提交给出了 artifact 才覆盖（不给 = 保留既有声明）。
        // v0.42.2（D214a）：**先写**，供 setStatus 的 I2 判定使用。
        if (entry.artifact !== undefined) {
          it.artifact = entry.artifact
          it.updatedAt = now
        }
        // v0.43.0（R5）：**完成必须有产物证据（全模式）**——done 项在本提交与既有
        // 声明中都没有 artifact → setStatus 内部降级 verifying（D176 完成门禁口径
        // 前移到提交时；spec 模式的验收规则并入同一条）。
        // ⚠️ 降级必须发生在 setStatus **内部**（转换合法性检查通过之后）：
        // 此前把 'verifying' 当目标态直接送进状态机 → pending→verifying 非法转换 → 整单失败。
        if (entry.status !== it.status) {
          const wasVerifyingNeeded = entry.status === 'done' && !(entry.artifact ?? it.artifact)
          const err = setStatus(l, entry.id, entry.status, op.source, entry.note, false, changed, true)
          if (err) return fail(err.code, err.message, err.hint)
          // v0.42.2（D214c）：I2 降级发生后，实际落盘（verifying）与模型意图（done）
          // 不一致 —— 必须把「事实 + 出路」回给模型，否则回执说「完成」、快照却是
          // [?]，模型只能反复重交（真机死循环的直接驱动器）。
          if (wasVerifyingNeeded && it.status === 'verifying') {
            warnings.push(`项「${it.text.slice(0, 24)}」完成但未声明成果产物，done 已降级 verifying —— 带 artifact 声明重新提交即为 done`)
          }
        } else if (entry.note !== undefined && entry.note !== it.note) {
          it.note = entry.note
          it.updatedAt = now
        }
        // v0.38.1（D175）：文本以模型最新提交为准（配对成功 = 同一件工作）。
        // 此前这里不写 text —— 「整体重制计划」时新文本被静默丢弃，账本与模型意图漂移。
        if (entry.text !== undefined && entry.text !== it.text) {
          it.text = entry.text
          it.updatedAt = now
        }
      }

      // ② 按 layout 重建顺序 —— 复用已有项对象，保留 id / createdAt / attempts /
      //    acceptance / artifact / nodeId（"提交完整清单"不等于"重建清单"）
      const next: LedgerItem[] = []
      /** 本次提交内新建项的临时键 → 落库后的真实 id（供 parentKey 解析） */
      const keyToId = new Map<string, string>()
      for (const entry of op.layout) {
        if (entry.kind === 'existing') {
          next.push(byId.get(entry.id)!)
          continue
        }
        // v0.42.2（D214a）→ v0.43.0（R5）：新建项走与 existing 同一条判据
        //（done 必须有产物证据，全模式），否则「删了重建」就是旁路。
        let newStatus = entry.status
        let newNote = entry.note
        if (newStatus === 'done' && !entry.artifact) {
          newStatus = 'verifying'
          newNote = `${newNote ? `${newNote}｜` : ''}完成未声明成果产物，引擎降级为 verifying —— 带 artifact 声明重新提交即为 done`
          warnings.push(`新建项「${entry.text.slice(0, 24)}」缺成果产物声明，done 已降级 verifying（带 artifact 重提即为 done）`)
        }
        const item: LedgerItem = {
          id: newId('li'),
          text: entry.text,
          status: newStatus,
          parentId: null,
          dependsOn: [],
          acceptance: [],
          artifact: entry.artifact,
          createdAt: now,
          updatedAt: now,
          source: op.source,
          note: newNote,
          attempts: newStatus === 'running' ? 1 : 0,
          startedAt: newStatus === 'running' ? now : undefined,
          round: l.round ?? 1,
        }
        if (entry.key) keyToId.set(entry.key, item.id)
        next.push(item)
        // 回执用**实际落盘**状态（newStatus），而非模型草案（entry.status）——
        // I2 降级后两者不一致，回执必须说事实（D214c）。
        changed.push({ itemId: item.id, from: 'pending', to: newStatus, note: newNote })
      }

      // ②b v0.39.0（D185）：父项引用落地 —— parentKey 解析为真实 parentId。
      // `id:<x>` 直取；`k<n>` 取本批新建项。
      //
      // ⚠️ 判据与落盘必须分开：先算「本次提交的**终态**父子关系」→ 再判层级 → 最后才赋值。
      // 三个坑，每一个都踩过或差点踩到：
      //   ① 边解析边判 → 被 layout 顺序骗过。若「孙项」排在「子项」之前，处理孙项时子项
      //      还是顶级（parentId 尚未赋值）→ 三层静默通过（判据依赖遍历顺序 = 概率性漏洞）。
      //   ② 先赋值再判、失败直接 return → `next[i]` 是 `l.items` 的**引用**，
      //      盘上没写、内存里 parentId 已被改 = 双通道漂移（纪律⑱）。
      //   ③ 用 `parentKeys`（解析期拿到的既有 parentId）替终态值 → 同批内新建的链看不见。
      // 故：`finalParent` 取解析期新值与既有值之和，判完再统一落盘。
      const idOfKey = (key: string): string | null => {
        if (key.startsWith('id:')) return key.slice(3)
        return keyToId.get(key) ?? null
      }
      /** 本次提交的终态父子关系（itemId → parentId）；未挂父的项不在表内 */
      const finalParent = new Map<string, string>()
      const links: Array<{ child: LedgerItem; parent: LedgerItem; parentId: string }> = []
      for (const [i, entry] of op.layout.entries()) {
        if (!entry.parentKey) continue
        const child = next[i]!
        const parentId = idOfKey(entry.parentKey)
        if (!parentId) return fail('NOT_FOUND', `父项引用无法解析：${entry.parentKey}`)
        const parent = next.find((it) => it.id === parentId)
        if (!parent) return fail('NOT_FOUND', `父清单项不存在：${parentId}`)
        if (parent.id === child.id) return fail('INVARIANT', `清单项不能把自己设为父项：${child.text.slice(0, 20)}`)
        if (isLedgerTerminal(parent.status)) {
          return fail(
            'INVARIANT',
            `父清单项「${parent.text.slice(0, 20)}」已终态（${parent.status}），不能再挂子项`,
            '先把父项拉回进行中（reopen），或把新工作挂到别的未收口任务下。',
          )
        }
        finalParent.set(child.id, parentId)
        links.push({ child, parent, parentId })
      }

      // ②b′ 层级上限两层 —— 父项自身在**终态**里必须是顶级项。
      // 这一条同时吞掉环（A→B、B→A 时 B 的终态父项非空 → 报层级超限），不需要单独的环检测。
      for (const { child, parent } of links) {
        const grandparent = finalParent.get(parent.id) ?? parent.parentId ?? null
        if (!grandparent) continue
        return fail(
          'INVARIANT',
          `任务层级最多两层：「${child.text.slice(0, 20)}」的父项「${parent.text.slice(0, 20)}」自己也是子任务`,
          `${PLAN_PARENT_HINT}把第三层的工作合并到父项描述里，或拆成两个独立的顶级任务。`,
        )
      }

      // ②b″ 判据全通过，此刻才真正落盘（失败路径绝不留半挂状态）
      for (const { child, parentId } of links) {
        child.parentId = parentId
        child.updatedAt = now
      }

      // ②c I5 复核：挂完父子关系后再查一遍 —— 防止「父项本轮被标 done，同时又挂上了
      //     新的未收口子项」这种由同一次提交造成的矛盾态（setStatus 先于挂父执行，看不到）。
      for (const item of next) {
        if (!isLedgerTerminal(item.status)) continue
        const openChildren = next.filter((c) => c.parentId === item.id && !isLedgerTerminal(c.status))
        if (openChildren.length > 0) {
          return fail(
            'INVARIANT',
            `父清单项「${item.text.slice(0, 20)}」已终态（${item.status}），却有 ${openChildren.length} 个子项未收口`,
            '不变量 I5：先把子项收口（done / cancelled / skipped），父项才能结束。',
          )
        }
      }

      // ③ I4 环检测（本算子不建依赖，仅防御未来扩展）
      for (const it of next) {
        if (it.dependsOn.length > 0 && hasCycle({ ...l, items: next }, it.id, it.dependsOn)) {
          return fail('INVARIANT', `dependsOn 存在环：${it.id}`)
        }
      }

      l.items = next
      appendLog(l, { at: now, op: 'plan-commit', by: op.source, note: `${op.reason}（${next.length} 项）` })
      // v0.42.2（D214c）：引擎自动纠正随 OpResult 透传（调用方必须拼进 observation）
      return warnings.length > 0 ? { ok: true, changed, warnings } : { ok: true, changed }
    }

    case 'set-artifact': {
      const idx = findIndex(l, op.itemId)
      if (idx < 0) return fail('NOT_FOUND', `清单项不存在：${op.itemId}`)
      l.items[idx]!.artifact = op.artifact ?? undefined
      l.items[idx]!.updatedAt = Date.now()
      appendLog(l, {
        at: Date.now(),
        op: 'set-artifact',
        by: 'engine',
        note: `${l.items[idx]!.text.slice(0, 30)}：${op.artifact ? `${op.artifact.kind} ${op.artifact.path}` : '清除产物声明'}`,
      })
      return OK_EMPTY
    }

    case 'note': {
      const idx = findIndex(l, op.itemId)
      if (idx < 0) return fail('NOT_FOUND', `清单项不存在：${op.itemId}`)
      l.items[idx]!.note = op.note
      l.items[idx]!.updatedAt = Date.now()
      return OK_EMPTY
    }

    /** v0.39.0（F8）：重做 —— done/failed/skipped/cancelled → running（force + 留痕） */
    case 'reopen': {
      const idx = findIndex(l, op.itemId)
      if (idx < 0) return fail('NOT_FOUND', `清单项不存在：${op.itemId}`)
      const item = l.items[idx]!
      if (!isLedgerTerminal(item.status)) {
        return fail(
          'INVARIANT',
          `清单项「${item.text.slice(0, 24)}」当前为 ${item.status}，没有做成过，谈不上重做`,
          'reopen 只用于把已经结束（done / failed / skipped / cancelled）的项拉回来重做。',
        )
      }
      // ⚠️ 必须在 setStatus **之前**取 from：`item` 是 `l.items[idx]` 的引用，
      // setStatus 会把它的 status 改成 running，之后再读就永远记成 "running → running"
      // —— 留痕失去了唯一有价值的信息（从哪个终态拉回来的）。
      const fromStatus = item.status
      const changed: OpResult['changed'] = []
      const err = setStatus(l, item.id, 'running', op.source, `重做：${op.reason}`, true, changed)
      if (err) return fail(err.code, err.message, err.hint)
      appendLog(l, {
        at: Date.now(),
        op: 'reopen',
        itemId: item.id,
        from: fromStatus,
        to: 'running',
        by: op.source,
        note: op.reason,
      })
      return { ok: true, changed }
    }

    default:
      return fail('INVALID_OP', `未知算子：${JSON.stringify(op)}`)
  }
}

/** 生成人话恢复点：「上次做到 X，未完成 Y 待继续」 */
function buildParkHint(l: LedgerFile, itemId: string | null, reason: string): string {
  const done = l.items.filter((it) => it.status === 'done')
  const open = l.items.filter((it) => isLedgerOpen(it.status))
  const interrupted = itemId ? l.items.find((it) => it.id === itemId) : undefined
  const donePart = done.length > 0 ? `已完成 ${done.length} 项（最近一项：${done[done.length - 1]!.text.slice(0, 30)}）` : '尚无已完成项'
  const curPart = interrupted ? `中断时正在做「${interrupted.text.slice(0, 30)}」` : '中断时无进行中项'
  const openPart = open.length > 0 ? `未完成 ${open.length} 项待继续` : '无未完成项'
  return `${reason}｜${donePart}；${curPart}；${openPart}。续聊时请以此为基准，不要重做已完成项。`
}
