/* ============================================================
 * ArkWork — 思考来源判定（v0.31.0 B1）
 *
 * 设计依据：
 *  - agent_learn/docs/interaction-display-v1.0/04-思考内容展示规范.md §三（G4）· §四（G5）
 *  - docs/versions/v0.31.0/04-system-design.md §4.2 / §6.1
 *
 * 为什么单独成模块（而不是写在 `components/flow/project.ts` 里）：
 *  - B1 阶段 `project.ts` 尚未存在，但 B1 的 TC-DUAL-004 要求来源判定已可断言；
 *  - 来源判定是**纯派生**（无 IO / 无时间 / 无框架），B3 的投影层与 B1 的展示层
 *    必须共用同一份实现 —— 否则「原生/文本思考」徽标会与折叠摘要口径分叉。
 *
 * 放置层级理由：`shared/` 是唯一的共享层，且本模块只依赖类型 + 纯函数（§3.3-4）。
 * ============================================================ */

import type { ReActStep } from '../types/react'

/**
 * 思考来源（正本 `ReasoningSource` 的落地形态）。
 * - `native`  模型原生思考通道有内容（DeepSeek `reasoning_content` / Anthropic `thinking_delta`）
 * - `content` 原生通道为空，但 `thought`（content 剥离 SAY 后的剩余物）非空
 * - `none`    两者都空 —— **必须显式记录**，用于占位与统计（正本 §七 G11）
 */
export type ReasoningSource = 'native' | 'content' | 'none'

/**
 * 判定某条 reason 步骤的思考来源。
 *
 * 取值只看「有没有内容」，不看「内容够不够长」：长度为 0 与全是空白都算无内容，
 * 这样占位分支与统计口径一致（避免「有 3 个空格所以算 native」的荒谬结果）。
 *
 * @param step ReAct 步骤（非 reason 类型时按字段自然回落，调用方自行过滤）
 * @returns 来源枚举；`native` 优先于 `content`（正本 G4：两者互斥，原生通道胜出）
 */
export function deriveReasoningSource(step: Pick<ReActStep, 'reasoning' | 'thought'>): ReasoningSource {
  if ((step.reasoning ?? '').trim()) return 'native'
  if ((step.thought ?? '').trim()) return 'content'
  return 'none'
}

/**
 * 取该步骤**应当展示**的思考文本：原生思考优先，其次回落剥离后的 content 文本。
 *
 * 说明：`thought` 在 v0.31.0 之前的语义已经稳定（剥离 SAY 后的剩余物），
 * 全仓库有 12 处消费者（最终答复回落 / 任务 summary / session-log）依赖它，
 * 因此 B1 **不改变 `thought` 的写入口径**，只在展示层做「原生优先」的合成。
 *
 * @returns 展示文本；两者皆空时返回空串（调用方走占位分支）
 */
export function reasoningText(step: Pick<ReActStep, 'reasoning' | 'thought'>): string {
  return (step.reasoning ?? '').trim() ? (step.reasoning as string) : (step.thought ?? '')
}

/**
 * 取文本首句（到第一个中英文句末标点为止；无标点时整段）。
 *
 * 为什么集中在此而不是留在组件里：B4 起投影层（flow/project.ts）的思考块
 * 折叠摘要 `summary: firstSentence(reasoningText(step))` 与流式缓冲摘要
 * 必须用同一口径切句，否则同一段文本在流式/落定两态显示成不同长度 ——
 * 用户会以为是两个不同的内容。（v0.31.0 B4 载体注记：say 首句优先的
 * `reasoningSummary` 已随块拆分删除 —— say 现在独立渲染为 SayBlock，
 * 折叠行不再需要替它站岗。）
 */
export function firstSentence(s: string | undefined | null): string {
  if (!s) return ''
  const t = s.replace(/\n+/g, ' ').trim()
  const m = t.match(/^([^。！？!?；;]+)[。！？!?；;]/)
  return m ? m[1].trim() : t
}

/**
 * 空思考占位的场景判定（正本 §7.1 G11 的四场景）。
 * - `failed`          思考失败（`status === 'failed'`）—— 失败不静默
 * - `directExec`      本轮无需思考（模型直接产出工具调用，如纯 `file-reader`）
 * - `budgetExhausted` 思考耗尽输出预算（内核已自动重试 + 注入占位答复）
 * - `noChannel`       模型未提供思考通道（provider 不支持 reasoning）
 *
 * 注意判定顺序：**先失败、再直接执行、后能力缺失**（与只读原因同样的"先硬后软"原则）。
 */
export type EmptyReasonKind = 'failed' | 'directExec' | 'budgetExhausted' | 'noChannel'

/**
 * 判定空思考的占位场景。
 *
 * @param step 当前步骤
 * @param budgetExhausted 上游是否报告过本轮"思考耗尽预算 + 自动重试"（内核侧信号；
 *                        缺省 false —— 该场景在内核侧已被占位答复填满，通常不会走到这里）
 */
export function describeEmptyReason(
  step: Pick<ReActStep, 'status' | 'action' | 'reasoning' | 'thought'>,
  budgetExhausted = false,
): EmptyReasonKind {
  if (step.status === 'failed') return 'failed'
  if (step.action) return 'directExec'
  if (budgetExhausted) return 'budgetExhausted'
  return 'noChannel'
}

/**
 * 空思考占位场景 → i18n 键（`thought.placeholder.*`）。
 * 集中在此而非散落在组件里，便于 4 语言键集一致性检查（C-G4 / TC-PKG-004）覆盖。
 */
export const EMPTY_REASON_KEY: Record<EmptyReasonKind, string> = {
  failed: 'placeholder.failed',
  directExec: 'placeholder.directExec',
  budgetExhausted: 'placeholder.budgetExhausted',
  noChannel: 'placeholder.noChannel',
}

/**
 * 思考来源 → i18n 键（`thought.source.*`），供来源徽标使用（正本 §四 G5）。
 *
 * 三种来源**都有**徽标：`none` 显示「无来源」而非隐藏 —— 正本要求
 * 「用户有权知道自己在看哪一种」，静默不显示会让"没有思考"看起来像 UI 故障。
 */
export function reasoningSourceKey(source: ReasoningSource): string {
  if (source === 'native') return 'source.native'
  if (source === 'content') return 'source.content'
  return 'source.none'
}

/* ============================================================
 * 展开态解析链（正本 03-interaction §4.2）
 * ============================================================ */

/**
 * 思考最短可见时长（毫秒）。
 *
 * 为什么需要它（C-8）：模型偶尔「闪念即答」——reasoning 只有几十毫秒就落定，
 * 折叠语义会立刻把块收起来，用户只看到一次闪烁，等于没看见。
 * 短于此阈值的思考即使已完成也保持展开。
 */
export const MIN_VISIBLE_MS = 1200

export interface ReasoningOpenInput {
  /** 用户手动干预：`null` = 未干预（自动态生效）；非 null = 用户意志最高（R4） */
  userOpen: boolean | null
  /** 是否仍在流式（未落定） */
  streaming: boolean
  /** 本步已耗时（ms）；流式中传当前实时值，落定后传 `durationMs` */
  elapsedMs: number
  /** 是否失败（失败必须展开——失败不静默） */
  failed: boolean
  /** 落定后的默认展开策略（来自三档视图模式 policy，B3 接入） */
  autoOpenWhenSettled: boolean
}

/**
 * 解析思考块是否展开（纯函数，判定顺序**有意义**，不可调换）。
 *
 * ```
 * ① userOpen !== null        → 用户意志最高（模式与保护都不覆盖）
 * ② streaming                → 展开
 * ③ elapsedMs < minVisibleMs → 展开（防「闪一下就没」）
 * ④ failed                   → 展开
 * ⑤ 否则                     → autoOpenWhenSettled
 * ```
 *
 * 为什么不把 ③ 放在 ② 前面：流式中 `elapsedMs` 还在增长，先判时长会把
 * 「刚刚开始流式」的思考误判为"已超过阈值"或反之，造成展开态抖动。
 *
 * @returns 是否展开
 */
export function resolveReasoningOpen(input: ReasoningOpenInput): boolean {
  if (input.userOpen !== null) return input.userOpen
  if (input.streaming) return true
  if (input.elapsedMs < MIN_VISIBLE_MS) return true
  if (input.failed) return true
  return input.autoOpenWhenSettled
}
