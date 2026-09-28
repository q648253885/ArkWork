/* ============================================================
 * ArkWork — 记忆转化管线（v0.36.0 · B4 / F1.2）
 * 设计文档：docs/versions/v0.36.0/04-system-design.md §3.2
 *
 * 一句话：**L1→L2→L3→L4 的转化只在这一个地方编排。**
 *
 * 为什么要把「编排」抽出来（此前它散在 memory-hooks 的一个大函数里）：
 *  ① 之前四步是**顺序 try/catch 堆在同一函数体**里：任何一步抛错只留一条 warn，
 *     外部（UI / 测试）看不出「哪一步没跑」—— 记忆这件事最怕静默丢步；
 *  ② 每步的「跳过」与「失败」语义不同（没到规模门槛是正常跳过，写盘失败是异常），
 *     混在一起就永远是「静默降级」；
 *  ③ 转化链必须**可测**：每步独立、可注入、可断言（这才是「写好测试用例」的前提）。
 *
 * 编排三态（触发点 → 步骤序列）：
 *   turn          → l1-append · l2-spill          （每轮）
 *   task-done     → l3b-archive · l3a-consolidate · l4-synthesize · distill-evaluate · skill-forge
 *   user-memorize → l3a-merge                     （用户显式「记住这条」）
 *
 * ⚠️ 诚实标注（turn 两态的语义）：**turn 级两步由引擎现行路径执行**（L1 追加在
 * appendL1 调用点、L2 大结果落盘在工具管线），管线在此做的是**结果核对 + 上报**，
 * 不重复写入 —— 重复写 L1 会制造重复记忆，比缺观测严重得多。
 * 换句话说：`turn` 触发器保证「转化链的可观测性完整」，不接管「写入动作本身」。
 * ============================================================ */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { listL1 } from './l1-working.js'
import { archiveTaskL1 } from './l3-archive.js'
import { applyPending } from './l3-curated.js'
import { consolidateL3a } from './consolidate.js'
import { evaluateProfileCycle, synthesizeFromTaskL1 } from './l4-profile.js'
import { autoPromoteDistill, evaluateDistillTrigger, getDistillMetrics } from './distill.js'
import { runForSkillForge } from './skill-forge.js'
import { getWorkspaceDir } from '../store/db.js'
import { emitEvent } from '../agent/engine/broadcast.js'
import { logger } from '../system/logger.js'
import type { Task } from '@shared/types/task'
import type { Agent } from '@shared/types/agent'
import type { MemoryItem } from '@shared/types/memory'

export type PipelineStage =
  | 'l1-append'
  | 'l2-spill'
  | 'l3a-merge'
  | 'l3a-consolidate'
  | 'l3b-archive'
  | 'l4-synthesize'
  | 'distill-evaluate'
  | 'skill-forge'

export type PipelineTrigger = 'turn' | 'task-done' | 'user-memorize'

/** 触发点 → 步骤序列（单一真源；测试直接断言这张表） */
export const PIPELINE_STAGES: Record<PipelineTrigger, readonly PipelineStage[]> = {
  turn: ['l1-append', 'l2-spill'],
  // task-done 顺序即契约（v0.36.3 插入 l3a-consolidate）：
  //   先 L3b 归档全量原文（不可丢的证据）→ 再 L3a 有损提炼出长期记忆 →
  //   然后才轮到「从记忆里长出来的东西」（画像合成 / 蒸馏 / 技能炼制）。
  //   巩固排在合成之前，是为了让画像合成读到「刚巩固过的项目/用户口径」。
  'task-done': [
    'l3b-archive',
    'l3a-consolidate',
    'l4-synthesize',
    'distill-evaluate',
    'skill-forge',
  ],
  'user-memorize': ['l3a-merge'],
}

export interface PipelineStepResult {
  stage: PipelineStage
  ok: boolean
  /** 条件未命中而正常跳过（≠ 失败）：例如未到蒸馏规模门槛 */
  skipped?: boolean
  detail: string
  durationMs: number
}

export interface PipelineRun {
  trigger: PipelineTrigger
  taskId: string
  ok: boolean
  steps: PipelineStepResult[]
}

export interface PipelineContext {
  task?: Task
  agent?: Agent
  modelId?: string
  /** 已取到的 L1 条目（缺省现取；供调用方复用同一次读取，避免重复扫盘） */
  l1Items?: MemoryItem[]
  /**
   * 测试/定制用的**步骤实现覆盖**（缺省走内置实现）。
   * 为什么留这个口子：管线的核心价值是「顺序 + 隔离 + 上报」，
   * 要验证「某步失败不拖垮后续」「跳过与失败语义不同」必须能注入失败，
   * 否则只能靠「构造一个恰好会抛错的环境」——那是脆弱的间接测试。
   */
  overrides?: Partial<Record<PipelineStage, () => Promise<StageOutcome>>>
}

/* ============================================================
 * 触发点判定（供 memory-hooks / ipc 复用；单一真源）
 * ============================================================ */

/** 是否到达「任务级转化」的触发条件：任务终态（done/failed） */
export function isTaskDoneTrigger(status: string): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled'
}

/* ============================================================
 * 管线主体
 * ============================================================ */

/**
 * 跑一条转化管线。**永不抛错**（每步独立隔离，失败只记 ok:false），
 * 因为它的调用点全在「任务生命周期收尾」上 —— 记忆转化失败不该把任务弄失败。
 */
export async function runMemoryPipeline(
  taskId: string,
  trigger: PipelineTrigger,
  ctx: PipelineContext = {},
): Promise<PipelineRun> {
  const stages = PIPELINE_STAGES[trigger]
  const steps: PipelineStepResult[] = []
  let l1 = ctx.l1Items

  for (const stage of stages) {
    const t0 = Date.now()
    try {
      if (!l1 && needsL1(stage)) l1 = await listL1(taskId)
      const override = ctx.overrides?.[stage]
      const r = override ? await override() : await runStage(stage, taskId, l1 ?? [], ctx)
      steps.push({ stage, ok: true, skipped: r.skipped, detail: r.detail, durationMs: Date.now() - t0 })
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      steps.push({ stage, ok: false, detail, durationMs: Date.now() - t0 })
      logger.warn('Memory', `pipeline ${trigger}/${stage} failed: ${detail}`, taskId)
    }
  }

  const run: PipelineRun = { trigger, taskId, ok: steps.every((s) => s.ok), steps }
  // 事件上报（供交互区呈现「转化链走到哪一步」）
  await emitEvent(taskId, {
    type: 'memory_pipeline',
    iteration: 0,
    trigger,
    steps: steps.map((s) => ({ stage: s.stage, ok: s.ok, skipped: s.skipped ?? false, detail: s.detail })),
  })
  return run
}

function needsL1(stage: PipelineStage): boolean {
  return (
    stage === 'l3b-archive' ||
    stage === 'l3a-consolidate' ||
    stage === 'l4-synthesize' ||
    stage === 'distill-evaluate'
  )
}

export interface StageOutcome {
  skipped?: boolean
  detail: string
}
async function runStage(
  stage: PipelineStage,
  taskId: string,
  l1: MemoryItem[],
  ctx: PipelineContext,
): Promise<StageOutcome> {
  switch (stage) {
    /* ---- ① L1：本轮工作记忆（引擎已写；此处核对落盘事实） ---- */
    case 'l1-append': {
      const items = l1.length > 0 ? l1 : await listL1(taskId)
      if (items.length === 0) return { skipped: true, detail: '该任务暂无 L1 条目' }
      const file = join(getWorkspaceDir(), '.arkwork', 'memory', taskId, 'l1.jsonl')
      return {
        detail: `L1 在册 ${items.length} 条${existsSync(file) ? '' : '（⚠️ 索引与落盘文件不一致）'}`,
      }
    }

    /* ---- ② L2：大结果落盘（工具管线已写；此处统计规模） ---- */
    case 'l2-spill': {
      const dir = join(getWorkspaceDir(), '.arkwork', 'steps')
      let spilled = 0
      let bytes = 0
      try {
        for (const name of readdirSync(dir)) {
          if (!name.endsWith('.json')) continue
          spilled += 1
          bytes += statSync(join(dir, name)).size
        }
      } catch {
        /* 目录不存在 = 本轮没有大结果，属正常 */
      }
      return {
        detail: spilled === 0 ? '本轮无溢出条目（无大结果落盘）' : `溢出 ${spilled} 个文件（${Math.round(bytes / 1024)}KB）`,
      }
    }

    /* ---- ③ L3a：用户显式「记住这条」→ 暂存区合并进策展记忆 ---- */
    case 'l3a-merge': {
      const r = await applyPending(ctx.modelId)
      // ⚠️ 语义陷阱（D87，测试当场抓出）：applyPending 的 `merged` 字段意思是
      // 「超字符预算、做了**有损归并**」，**不是**「有没有合并」。
      // 正确口径看 `applied`（写入条数）—— 曾按 merged 判定，导致「明明写进去了
      // 却报 skipped」，用户以为没生效。
      if (r.applied === 0) return { skipped: true, detail: '暂存区为空，无需合并' }
      return {
        detail:
          `已合并 ${r.applied} 条进策展记忆` +
          (r.merged
            ? `（超预算：memory=${r.memoryMerged} user=${r.userMerged} 已归并压缩）`
            : ''),
      }
    }

    /* ---- ④ L3b：任务归档（ADD-only，跳过 system_prompt） ---- */
    case 'l3b-archive': {
      const candidates = l1.filter((m) => m.kind !== 'system_prompt')
      if (candidates.length === 0) return { skipped: true, detail: '无可归档条目（全部为 system_prompt）' }
      await archiveTaskL1(taskId, (ctx.task?.input?.text ?? '').slice(0, 80) || taskId, l1)
      return { detail: `归档 ${candidates.length} 条进 L3b 档案` }
    }

    /* ---- ④b L3a：收尾巩固（本任务 L1/L2 → 项目记忆 / 用户偏好） ---- */
    case 'l3a-consolidate': {
      if (!ctx.modelId) return { skipped: true, detail: '无模型 id（巩固需 LLM），跳过' }
      const r = await consolidateL3a(taskId, { modelId: ctx.modelId, l1Items: l1 })
      return { skipped: r.skipped, detail: r.detail }
    }

    /* ---- ⑤ L4a：画像辩证合成（版本 +1） ---- */
    case 'l4-synthesize': {
      if (!ctx.modelId) return { skipped: true, detail: '无模型 id（合成需 LLM），跳过' }
      // ★ v0.36.3：先过周期闸门（记账 + 判定），未到周期就不合成
      // —— 画像「定期写入」而非每次收尾重写（口径见 l4-profile.ts 顶部注释）
      const cycle = await evaluateProfileCycle()
      if (!cycle.run) return { skipped: true, detail: cycle.detail }
      const r = await synthesizeFromTaskL1(taskId, l1, ctx.modelId)
      if (!r.synthesisUpdated) return { skipped: true, detail: `画像未更新（新观察 ${r.newObservations} 条）` }
      await emitEvent(taskId, {
        type: 'profile_updated',
        iteration: 0,
        version: r.profile.version,
        newObservations: r.newObservations,
      })
      return { detail: `画像更新至 v${r.profile.version}（新观察 ${r.newObservations} 条）` }
    }

    /* ---- ⑥ 蒸馏评估（规模门槛命中才真正执行） ---- */
    case 'distill-evaluate': {
      if (!ctx.modelId) return { skipped: true, detail: '无模型 id，跳过蒸馏' }
      const base = buildDistillContext(taskId, l1)
      const metrics = await getDistillMetrics(taskId, l1)
      const evalResult = await evaluateDistillTrigger({ ...base, ...metrics })
      if (!evalResult.trigger || !evalResult.category) {
        return { skipped: true, detail: `未达规模门槛（${evalResult.reason || '规模不足'}）` }
      }
      const message = await autoPromoteDistill({ ...base, ...metrics }, evalResult.category, ctx.modelId)
      await emitEvent(taskId, {
        type: 'distill_completed',
        iteration: 0,
        taskId,
        category: evalResult.category,
        message,
      })
      return { detail: `蒸馏完成（${evalResult.category}）：${message}` }
    }

    /* ---- ⑦ 技能炼制（skill-forge 五阶段严格管线） ---- */
    case 'skill-forge': {
      if (!ctx.modelId) return { skipped: true, detail: '无模型 id，跳过技能炼制' }
      const r = await runForSkillForge(taskId, ctx.modelId)
      if (!r.skill) return { skipped: true, detail: `未产出技能（阶段 ${r.stage}：${r.reason}）` }
      await emitEvent(taskId, {
        type: 'distill_completed',
        iteration: 0,
        taskId,
        category: 'skill',
        message: r.reason,
      })
      return { detail: `产出技能「${r.skill.name}」` }
    }
  }
}

/* ============================================================
 * 蒸馏触发上下文（从 L1 启发式提取信号）
 * 位置说明：v0.36.0 从 engine/memory-hooks.ts 移到这里 —— 它属于「转化链」而非
 * 「引擎钩子」，且 memory-hooks 现在要调管线，留在这里会形成循环依赖。
 * ============================================================ */

export function buildDistillContext(
  taskId: string,
  l1Items: MemoryItem[],
): import('./distill.js').DistillTriggerContext {
  const observations = l1Items.filter((m) => m.kind === 'observation' && !m.archivedAt)
  const toolCallCount = observations.length
  const hadErrorRecovery = observations.some(
    (m, i) => /\]\s*failed:/.test(m.content) && observations.slice(i + 1).some((n) => !/\]\s*failed:/.test(n.content)),
  )
  const userMessages = l1Items.filter((m) => m.kind === 'user_message')
  const hadUserCorrection = userMessages.some((m) =>
    /不对|错了|不是|纠正|应该|重新|重做/.test(m.content),
  )
  const hadPreferenceExpression = userMessages.some((m) =>
    /我喜欢|我习惯|请用|不要|偏好|希望|最好/.test(m.content),
  )
  return { taskId, l1Items, toolCallCount, hadErrorRecovery, hadUserCorrection, hadPreferenceExpression }
}
