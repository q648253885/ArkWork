/* ============================================================
 * ArkWork — 统一完成门禁（TaskLedger 版 · v0.38.0 判据返工）
 * 设计文档：docs/versions/v0.38.0/04-system-design.md §4.5 / §6.3
 *
 * 本门禁覆盖四条收尾路径：
 *  ① task_complete 工具       （turn-end.finishViaTaskComplete）
 *  ② 无工具调用的最终答复      （loop.ts 最终答复分支）
 *  ③ 超迭代 / 引擎崩溃         （loop.ts 收尾）
 *  ④ 用户中止                  （abort.handleAbort）
 *
 * ── v0.38.0 改了什么（D150 / D151 / D152 / D153）────────────────────────
 *
 * 判据（D150）：此前 `newInstruction` 取 `pendingTreeSync`，而后者由
 *   `startIter > 0 && !isReplyContinuation && graphId` 推出 —— 三个条件全是
 *   **代理变量**（"用户是否又说话了"），于是"这个工作区是什么"这类纯只读提问
 *   被判为新指令型续聊，连续三轮被拦。
 *   现在改为 `workClass`：由 `classifyRunWork(本 run 实际工具调用)` 客观判定。
 *   全只读 → 直接放行，模型无需配合，也无法被诱导产假动作。
 *
 * 计数（D151）：此前另有一条 run 局部计数（`completeRefusals === 0`，
 *   每 run 归零、不写账本），与账本上限叠加后单 run 稳定产出 3 次拒绝且无法解释。
 *   现在**唯一**计数落点是 `ledger.resume.refusals`，上限 MAX_LEDGER_REFUSALS。
 *
 * 投递（D152/D153）：拒绝语义（判定）与投递分离 —— 判定留在这里（纯逻辑，可单测），
 *   投递移到 `gate-channel.ts`（system 指令 + 用户通告两条独立通道）。
 *   被拒轮模型已生成的正文由调用方经 `emitTurnNote` 保底投递。
 * ============================================================ */
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { logger } from '../../system/logger.js'
import { getWorkspaceDir } from '../../store/db.js'
import type { LedgerFile, LedgerItem } from '../ledger/types.js'
import { MAX_LEDGER_REFUSALS } from '../ledger/types.js'
import { loadLedger, mutate } from '../ledger/engine.js'
import { openItems } from '../ledger/project.js'
import { PLAN_TOOL_HINT } from '../ledger/hint.js'
import type { WorkClass } from './work-class.js'

export interface GuardFinishArgs {
  taskId: string
  iteration: number
  /**
   * 本 run 的工作性质（`classifyRunWork(toolsThisRun)` 的判定结果）。
   * `'readonly'` = 本 run 只调了只读工具（或什么都没调）→ 门禁直接豁免。
   */
  workClass: WorkClass
  /** 本 run 是否触碰过任务清单（`touchesPlanTree` 累计） */
  touchedTree: boolean
}

export type GuardAllowReason = 'clean' | 'readonly' | 'synced' | 'over-limit'

export type GuardFinishVerdict =
  /**
   * v0.39.0（D178）：放行分支也携带 `leftovers` —— 调用方据此判断"任务 done 但清单
   * 还有在途项"是否需要收口。此前只有拒绝分支带，于是超限放行后 loop 无从得知
   * 清单状态，`forceCloseOpenItems` 因此一直没有被接线。
   */
  | { allow: true; reason: GuardAllowReason; leftovers: LedgerItem[] }
  | {
      allow: false
      code: 'TREE_SYNC' | 'UNFINISHED' | 'ARTIFACT'
      message: string
      leftovers: LedgerItem[]
      /** 已拒绝次数（含本次）；**唯一**来源 ledger.resume.refusals */
      refusals: number
    }

/* ---------------- 成果产物核对（v0.38.1 · D176） ---------------- */

export type ArtifactViolationReason = 'missing' | 'not-found' | 'unverifiable'

export interface ArtifactViolation {
  itemId: string
  text: string
  reason: ArtifactViolationReason
}

const ARTIFACT_REASON_TEXT: Record<ArtifactViolationReason, string> = {
  missing: '未声明成果产物',
  'not-found': '声明的产物在磁盘上不存在',
  unverifiable: 'command 产物缺 check 校验说明',
}

/**
 * 核对已完成项的成果产物（v0.38.1 · D176）。
 *
 * 用户裁决：**每个任务项都必须有成果产物，引擎核对产物后才允许收尾。**
 * 判据（只读，不执行任何命令）：
 *   · `done` 项未声明 artifact                    → missing
 *   · file / dir 产物：相对 workspace 解析后不存在
 *     （或类型不符：file 须是文件、dir 须是目录）  → not-found
 *   · command 产物：check 说明为空                → unverifiable
 *
 * 只做存在性核对，**不执行 check 命令** —— 命令来自模型声明，在门禁里执行
 * 等于给"诱导执行任意命令"开洞；语义核对由既有的 V 层验证体系（verification /
 * evidence）承担，这里只管"产物在不在"。
 */
export function verifyArtifacts(ledger: LedgerFile): ArtifactViolation[] {
  let ws = ''
  try {
    ws = getWorkspaceDir()
  } catch {
    // workspace 未就绪（极端夹具环境）→ 只能做绝对路径核对，相对路径按 not-found 处理
  }
  const out: ArtifactViolation[] = []
  for (const it of ledger.items) {
    if (it.status !== 'done') continue
    const a = it.artifact
    if (!a) {
      out.push({ itemId: it.id, text: it.text, reason: 'missing' })
      continue
    }
    if (a.kind === 'command') {
      // command 产物以 check 说明为核对依据（path 可省）
      if (!a.check || !a.check.trim()) out.push({ itemId: it.id, text: it.text, reason: 'unverifiable' })
      continue
    }
    // file / dir：path 为空串等同未声明（防脏数据绕过）
    if (!a.path || !a.path.trim()) {
      out.push({ itemId: it.id, text: it.text, reason: 'missing' })
      continue
    }
    const p = isAbsolute(a.path) ? a.path : join(ws, a.path)
    let ok = false
    try {
      if (existsSync(p)) {
        const st = statSync(p)
        ok = a.kind === 'dir' ? st.isDirectory() : st.isFile()
      }
    } catch {
      ok = false
    }
    if (!ok) out.push({ itemId: it.id, text: it.text, reason: 'not-found' })
  }
  return out
}

/**
 * 判定本轮是否允许收尾。纯判定（除读账本与产物存在性核对外无副作用）。
 *
 * 判定顺序（先命中先返回）：
 *   ① 账本不可读              → allow: clean    （不该因 IO 卡死任务）
 *   ② 清单为空                → allow: clean
 *   ③ workClass === 'readonly' → allow: readonly ← **D150 修复点**
 *   ④ touchedTree 且无在途项   → 核对成果产物（D176）→ 全部可核对则 allow: synced
 *   ⑤ refusals ≥ 上限          → allow: over-limit
 *   ⑥ mutating 且零写树        → 拒绝 TREE_SYNC
 *   ⑦ touchedTree 但有在途项   → 拒绝 UNFINISHED
 *   ⑧ 产物不可核对             → 拒绝 ARTIFACT（D176）
 */
export async function guardFinish(args: GuardFinishArgs): Promise<GuardFinishVerdict> {
  const { taskId, workClass, touchedTree } = args
  let ledger: LedgerFile | null = null
  try {
    ledger = await loadLedger(taskId)
  } catch (err) {
    logger.warn('Agent', `guardFinish 读取账本失败（放行）：${(err as Error).message}`, taskId)
    return { allow: true, reason: 'clean', leftovers: [] }
  }
  if (!ledger || ledger.items.length === 0) return { allow: true, reason: 'clean', leftovers: [] }

  // ③ 判据客观化 —— 本版核心修复：只读 run 不产生任何拦截
  if (workClass === 'readonly') return { allow: true, reason: 'readonly', leftovers: openItems(ledger) }

  const leftovers = openItems(ledger)
  const prior = ledger.resume?.refusals ?? 0
  const overLimit = prior >= MAX_LEDGER_REFUSALS

  const refuse = (code: 'TREE_SYNC' | 'UNFINISHED' | 'ARTIFACT', message: string): GuardFinishVerdict => ({
    allow: false,
    code,
    message,
    leftovers,
    refusals: prior + 1,
  })

  // ④ 已同步过清单：只剩「在途项」与「产物不可核对」两种拦截可能
  if (touchedTree) {
    if (leftovers.length === 0) {
      // v0.38.1（D176）：成果产物核对 —— 用户裁决"每个任务项必须有成果产物，
      // 引擎核对产物后才允许收尾"。缺声明 / 产物不在盘上 / command 缺校验说明
      // → 拒绝并点名（模型可经 task_plan 的 artifact 字段补声明后重新收尾）。
      const violations = verifyArtifacts(ledger)
      if (violations.length > 0) {
        if (overLimit) {
          logger.warn(
            'Agent',
            `完成门禁已达拒绝上限 ${MAX_LEDGER_REFUSALS}，放行（${violations.length} 项产物不可核对，尊重模型判断）`,
            taskId,
          )
          return { allow: true, reason: 'over-limit', leftovers }
        }
        const list = violations
          .map((v) => `  · ${v.text.slice(0, 40)}（${ARTIFACT_REASON_TEXT[v.reason]}）`)
          .join('\n')
        return refuse(
          'ARTIFACT',
          `以下 ${violations.length} 项已标记完成，但缺少可核对的成果产物：\n${list}\n` +
            `${PLAN_TOOL_HINT.update}：为每项补 artifact（file/dir 填相对工作区的 path；` +
            `command 填 check 校验说明），或把未实际完成的项改回 todo/doing。`,
        )
      }
      return { allow: true, reason: 'synced', leftovers }
    }
    if (overLimit) {
      logger.warn(
        'Agent',
        `完成门禁已达拒绝上限 ${MAX_LEDGER_REFUSALS}，放行（仅在途项将在收尾时收口）`,
        taskId,
      )
      return { allow: true, reason: 'over-limit', leftovers }
    }
    const list = leftovers.map((n) => `  · ${n.status}｜${n.text.slice(0, 40)}`).join('\n')
    return refuse(
      'UNFINISHED',
      `任务清单仍有 ${leftovers.length} 项未收口：\n${list}\n${PLAN_TOOL_HINT.update}；${PLAN_TOOL_HINT.finish}`,
    )
  }

  // ⑤⑥ 有实质动作但零写树
  if (overLimit) {
    logger.warn(
      'Agent',
      `完成门禁已达拒绝上限 ${MAX_LEDGER_REFUSALS}，放行（**不改写清单**，尊重模型的判断）`,
      taskId,
    )
    return { allow: true, reason: 'over-limit', leftovers }
  }
  return refuse(
    'TREE_SYNC',
    leftovers.length > 0
      ? `本次执行有实质动作，且清单仍有 ${leftovers.length} 项在途 —— 先把工作落进清单再收尾。${PLAN_TOOL_HINT.update}`
      : `本次执行有实质动作（写文件 / 执行命令 / 派子任务），但全程未更新任务清单。${PLAN_TOOL_HINT.update}`,
  )
}

/**
 * 记一次拒绝（跨 run 持久，写进账本）。
 *
 * v0.38.0：这是**唯一**的 `bump-refusal` 调用方 —— D151 的教训是
 * "两个计数器叠加得到的数字没有任何人可以解释"，所以此处不得再有第二个入口。
 * 清零点同样唯一：`ops.ts` 的 `touch-sync` 分支。
 *
 * v0.39.0（D180）：此前这里 `.catch(() => {})` 吞掉写失败 —— 计数永远停在旧值，
 * `overLimit` 永不成立，任务就在「拒绝 → continue」里烧到迭代上限（fail-closed）。
 * 现在返回是否写成功，由调用方按「连续写失败」做有界放行兜底。
 */
export async function recordRefusal(taskId: string): Promise<boolean> {
  try {
    const res = await mutate(taskId, { kind: 'bump-refusal' }, { actor: 'guard-finish' })
    if (!res.ok) {
      logger.warn('Agent', `完成门禁拒绝计数写入失败（账本拒绝）：${res.error?.message ?? '未知'}`, taskId)
      return false
    }
    return true
  } catch (err) {
    logger.warn('Agent', `完成门禁拒绝计数写入失败：${(err as Error).message}`, taskId)
    return false
  }
}

/**
 * 超限放行时把在途项收口，保证「任务 done 但清单有 pending」不会出现在界面上。
 *
 * v0.38.0：**仅 UNFINISHED 路径调用**。TREE_SYNC 超限放行时不得调用本函数 ——
 * 用户决策 P2 明确要求"超限后不逼模型做假动作、不改写清单"（模型判断清单无需变化
 * 时，清单就该原样不动）。
 *
 * v0.39.0（D178/D183）：**两个调用点，同一条判据** ——
 *   ① loop.ts 最终答复分支（无工具调用的收尾）；
 *   ② turn-end.ts `finishViaTaskComplete`（task_complete 工具分支）。
 * 两者的调用条件都是「`guardFinish` 放行且 `verdict.leftovers.length > 0`」，
 * 且都只发生在 D183 删除第二套守卫之后 —— 避免出现"任务 done、清单还有在途项"。
 */
export async function forceCloseOpenItems(taskId: string, reason: string): Promise<void> {
  await mutate(taskId, { kind: 'discard', reason }, { actor: 'guard-finish-override' })
}
