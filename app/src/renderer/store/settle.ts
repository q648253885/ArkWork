/* ============================================================
 * ArkWork — 流式缓冲与落定交接（v0.31.0 B1）
 *
 * 设计依据：docs/versions/v0.31.0/04-system-design.md §6.2
 *          agent_learn/docs/interaction-display-v1.0/04 §六（G8–G10 落定不跳变）
 * 验收：C-2（落定前后文本长度不减少）/ C-22（四条不变式）/ C-1（通道分离）
 *
 * ── 为什么抽成纯模块（而不是写在 slice 里）──────────────────
 *  `conversationSlice` 位于 renderer，其依赖链（`store/meta.ts` → `i18n/index.ts`）
 *  在模块顶层读取 `import.meta.env` 与 `document` —— 无法在 `node:test` 中实例化。
 *  把「缓冲 key 规则 + 落定交接」这两件**纯逻辑**抽出来：
 *    ① 用例可直接对纯函数做密闭断言（无需浏览器桩）；
 *    ② slice 退化为薄接线，逻辑只有一份实现，不存在"改一处忘一处"。
 *  这不是放宽测试强度，而是**收紧**：原来只能靠源码正则断言的东西，现在能跑行为。
 *
 * 纪律：本模块只依赖类型，零 IO / 零时间 / 零框架（同 flow/project.ts 的纯函数纪律）。
 * ============================================================ */

import type { ReActStep } from '@shared/types/react'
import type { TaskTextDeltaPayload, TextDeltaKind } from '@shared/types/ipc'

/** 流式缓冲表：key 三维 `${taskId}:${scope}:${kind}`，value 为该流最新 seq 与累计文本 */
export type StreamBuffers = Record<string, { seq: number; text: string }>

/**
 * 构造流式缓冲 key（**唯一实现**，禁止在别处手写模板串）。
 *
 * 为什么是三维：`scope` 回答"哪条管线"（turn / chat），`kind` 回答"哪条通道"
 * （text / reasoning）。旧版只有 `${taskId}:${scope}`，思考与叙述会撞同一缓冲 ——
 * 这是「真思考进不了 UI」的次生因（RC-1 的表现面）。
 *
 * @param taskId 任务 id
 * @param scope  'turn'（ReAct Reason）/ 'chat'（runChatOnce）
 * @param kind   'text'（叙述）/ 'reasoning'（思考）
 */
export function streamBufferKey(
  taskId: string,
  scope: TaskTextDeltaPayload['scope'],
  kind: TextDeltaKind,
): string {
  return `${taskId}:${scope}:${kind}`
}

/**
 * 应用一个流式增量（seq 单调追加 / 重启截断 / 乱序丢弃）。
 *
 * seq 规则（沿用 v0.27.0 R1 口径，不变）：
 *  - `seq === 1`  → 重启：截断上一轮残流，以本包为起点
 *  - `seq === cur.seq + 1` → 顺序续写
 *  - 其余 → 乱序包，**整体丢弃**（返回原引用，触发调用方浅比较短路）
 *
 * 每条通道各自计 seq，因此 text / reasoning 的 seq 相似值不会互相误判为乱序。
 *
 * @param buffers 当前缓冲表
 * @param payload 增量载荷（`task:text-delta`）
 * @returns 新缓冲表；乱序包时**返回入参同一引用**（供调用方判等跳过重渲染）
 */
export function appendDelta(buffers: StreamBuffers, payload: TaskTextDeltaPayload): StreamBuffers {
  const key = streamBufferKey(payload.taskId, payload.scope, payload.kind)
  const cur = buffers[key]
  if (cur && payload.seq !== cur.seq + 1 && payload.seq !== 1) return buffers
  const text = payload.seq === 1 || !cur ? payload.text : cur.text + payload.text
  return { ...buffers, [key]: { seq: payload.seq, text } }
}

export interface SettleResult {
  /** 处理后的 step（可能被「取较长者」改写 `reasoning` 并置 `truncated`） */
  step: ReActStep
  /** 处理后的缓冲表 */
  streamBuffers: StreamBuffers
  /** 本次是否发生了「保留流式较长者」（= 落了 `truncated` 标） */
  tookLonger: boolean
}

/**
 * reason 步骤落定时的缓冲交接（修 RC-3「落地瞬间跳变」）。
 *
 * 旧形态（v0.30.2）：`reason` 步骤到达即**无条件 `delete`** `${taskId}:turn` 缓冲。
 * 权威文本是 content **剥离 SAY 后**的内容，必然短于流式累计 → 用户看到文本被吞。
 *
 * 新形态（不变量②：落定后文本长度不减少）：
 *  1. 与 `kind='reasoning'` 通道比对（原生思考的真源）；
 *  2. 流式更长 → 保留流式文本并置 `truncated = true`（**显式**标记，不静默缩短）；
 *  3. 只清 `:turn:text` 缓冲 —— 叙述通道的权威内容在 answer / say 块里，不在此；
 *     `:turn:reasoning` **不删**：交给展示块读完后自行清理（TC-SETTLE-007）。
 *
 * 非 reason 步骤原样返回（引用不变），保证既有调用点零行为变化。
 *
 * @param step          即将落地的步骤
 * @param streamBuffers 当前缓冲表
 * @returns 交接结果
 */
export function settleReasonStep(step: ReActStep, streamBuffers: StreamBuffers): SettleResult {
  if (step.type !== 'reason') return { step, streamBuffers, tookLonger: false }

  const kText = streamBufferKey(step.taskId, 'turn', 'text')
  const kRsn = streamBufferKey(step.taskId, 'turn', 'reasoning')

  const streamed = streamBuffers[kRsn]?.text ?? ''
  const settled = step.reasoning ?? ''
  const tookLonger = streamed.length > settled.length
  const nextStep = tookLonger ? { ...step, reasoning: streamed, truncated: true } : step

  let nextBuffers = streamBuffers
  if (kText in streamBuffers) {
    nextBuffers = { ...streamBuffers }
    delete nextBuffers[kText]
  }
  return { step: nextStep, streamBuffers: nextBuffers, tookLonger }
}

/**
 * 清除缓冲：按 (task, scope?, kind?) 逐维收窄。
 *
 * @param buffers 当前缓冲表
 * @param taskId  目标任务
 * @param scope   省略 = 该任务全部作用域
 * @param kind    省略 = 该 (task, scope) 下全部通道
 * @returns 新缓冲表；无命中时返回入参同一引用
 */
export function clearBuffers(
  buffers: StreamBuffers,
  taskId: string,
  scope?: TaskTextDeltaPayload['scope'],
  kind?: TextDeltaKind,
): StreamBuffers {
  const scopes: Array<TaskTextDeltaPayload['scope']> = scope ? [scope] : ['turn', 'chat']
  const kinds: TextDeltaKind[] = kind ? [kind] : ['text', 'reasoning']
  const targets = scopes.flatMap((sc) => kinds.map((k) => streamBufferKey(taskId, sc, k)))
  if (!targets.some((k) => k in buffers)) return buffers
  const next = { ...buffers }
  for (const k of targets) delete next[k]
  return next
}
