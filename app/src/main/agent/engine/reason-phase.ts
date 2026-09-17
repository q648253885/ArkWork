/**
 * v0.27.0 R2/F7：Reason 阶段（由 loop.ts 纯移动，行为不变）。
 * 清单状态推进 / 消息与工具组装 / system 契约装配（前缀缓存稳定）/ 流式 LLM 调用
 * （completeWithStream + text-delta 泵）/ 思考预算重试 / Reactive Fallback 压缩重试 /
 * reasoning 落盘 L1 + reason step 广播 + reason_end 事件。
 *
 * v0.31.0 B1（交互区管道，修 RC-1 / RC-2 / RC-3 / RC-12）：
 * - 双通道贯通：`onReasoning` 接线到独立 `reasoning` 泵（此前全仓库无消费方）
 * - 流式期 delta 级协议剥离：`createSayStripper()` 拦下裸 `<<<SAY>>>` 标记
 * - 原生思考独立落 step.reasoning（不改 `thought` 的既有语义，避免答复被推理链污染）
 * - 中断双通道留存（见 abort.ts）
 */

import type { Task } from '@shared/types/task'
import type { ReActStep } from '@shared/types/react'
import type { Agent } from '@shared/types/agent'
import type { LlmCompleteResponse } from '../../llm/adapter.js'
import { getAdapter, getModel } from '../../llm/registry.js'
import { callLlmWithRetry, withLlmTimeout, isContextOverflowError } from '../llm-call.js'
import { completeWithStream, createTextDeltaPump, type TextDeltaPump } from '../llm-stream.js'
// v0.31.0 B1：流式期 delta 级协议剥离（与落定期 extractSayMarker 互补，不改最终数据）
import { createSayStripper } from '../../llm/stream-strip.js'
import { assembleSystemPrompt } from '../prompt/sections.js'
import { appendL1 } from '../../memory/l1-working.js'
import { compressMemory } from '../../ipc/memory.js'
import { logger } from '../../system/logger.js'
import { genId } from '@shared/utils/id'
import { updateTask } from '../../store/tasks.js'
import { getWorkspaceDir } from '../../store/db.js'
import { broadcastStep, broadcastTextDelta } from '../events.js'
import { emitEvent } from './broadcast.js'
import { emitPlanStatus } from './gates.js'
// v0.30.0：Sync · S1 Project（活跃窗口投影）
import { syncProject } from '../graph/sync.js'
import { markPlanItemInProgress } from '../graph/plan-sync.js'
import { assembleMessages, assembleTools } from './messages.js'
import { emitContextSizeReport } from './context.js'
import { persistAbortedReason } from './abort.js'
// v0.31.0 D22：瞬时提示通道标签（产出方自带，此处兜底）
import { labelEngineHint } from './hints.js'
import type { AlwaysOnContracts } from './run-setup.js'

export interface ReasonPhaseArgs {
  task: Task
  agent: Agent
  modelId: string
  signal: AbortSignal
  iteration: number
  pendingSystemHint: string | undefined
  memoryInjection: string
  alwaysOnContracts: AlwaysOnContracts
}

export async function runReasonPhase(
  args: ReasonPhaseArgs,
): Promise<{ response: LlmCompleteResponse }> {
  const { task, agent, modelId, signal, iteration, memoryInjection, alwaysOnContracts } = args
  let pendingSystemHint = args.pendingSystemHint
  await emitEvent(task.id, { type: 'reason_start', iteration })

  // v0.17.5：计划项状态推进 — 仅在首轮把第一个 pending 标为 running。
  // 后续轮次不再自动推进/重置，改由 LLM reasoning 声明驱动（见 act 后的逻辑）。
  // 此前每轮都把 running 重置为 pending 再标下一个，导致状态频繁跳动且与实际执行脱节。
  if (iteration === 0 && task.planItems && task.planItems.length > 0) {
    const firstPendingIdx = task.planItems.findIndex((it) => it.status === 'pending')
    if (firstPendingIdx >= 0) {
      const item = task.planItems[firstPendingIdx]
      // v0.30.0 D9：有图任务写图（唯一真相），镜像/广播由 saveGraph 补发；无图保持 v0.29 直写。
      if (task.graphId) await markPlanItemInProgress({ taskId: task.id, graphId: task.graphId, iteration }, item.id)
      else {
        item.status = 'running'
        item.updatedAt = Date.now()
        await updateTask(task.id, { planItems: task.planItems })
      }
    }
  }

  // v0.17.6：每轮 Reason 前注入引擎独立判断的清单状态（独立 user 消息，非 system prompt 文本）。
  // 模型必须以这条消息为准，避免"LLM 自报已完成"的失真。
  //
  // v0.30.0（Sync · S1 Project）：若该任务已有 TaskGraph，改用「活跃窗口投影」替代
  // 旧的扁平清单注入。投影内容 = [NOW] 当前任务 + 其验收条件 + [NEXT] 2–3 项 +
  // [DONE] 计数 + [BUDGET]，固定预算 ≤800 tok（超预算按 DONE→NEXT→验收细节 裁剪），
  // 并额外产出「锚点段」（GOAL + SCOPE-OUT，放进 system 尾部）与「工具后一行刷新」。
  //
  // 为什么保留旧路径：tier 0/1 轻量任务不建图（F20），且迁移前的老任务可能还没有图 ——
  // 此时 `emitPlanStatus` 的扁平六态注入仍是正确的呈现方式，行为不变。
  if (task.graphId) {
    try {
      const proj = await syncProject({ taskId: task.id, graphId: task.graphId, iteration })
      if (proj.anchorText) {
        // 锚点段（GOAL + SCOPE-OUT）恒在，不参与裁剪 —— 对抗 F4 目标漂移。
        // 走 pendingSystemHint 通道（瞬时、不进 L1、不破坏 system 前缀缓存）。
        pendingSystemHint = [proj.anchorText, pendingSystemHint].filter(Boolean).join('\n\n')
      }
    } catch (e) {
      logger.warn('Agent', `syncProject skipped: ${(e as Error).message}`, task.id)
    }
  } else if (task.planItems && task.planItems.length > 0) {
    try {
      await emitPlanStatus(task, iteration, '迭代开始')
    } catch (e) {
      logger.warn('Agent', `emitPlanStatus skipped: ${(e as Error).message}`, task.id)
    }
  }

  const startedAt = Date.now()
  // v0.15.0 Task 2 SubTask 2.5：Reactive Fallback 压缩后需重新组装，故用 let
  let messages = await assembleMessages(task, agent)
  const tools = await assembleTools(agent, task)

  // v0.20.0 缓存优化：动态 skill 指令不再拼进 system prompt（会破坏前缀缓存），
  // 改为追加到消息尾部（瞬时、不进 L1）。system 保持整轮字节稳定才能命中缓存。
  //
  // v0.31.0 D22：通道标签改由**产出方自带**（见 engine/hints.ts）——
  // 本通道同时承载技能体与引擎运行期提示，此前一律套 `[Skill 指令]`，
  // 使「清单未完成自救提示」被模型读成技能契约。此处只做兜底：产出方漏标时
  // 补 `[引擎提示]`，保证提示不会以「用户原话」形态出现在模型上下文里。
  if (pendingSystemHint) {
    const labeled = pendingSystemHint.startsWith('[')
      ? pendingSystemHint
      : labelEngineHint(pendingSystemHint)
    messages = [...messages, { role: 'user', content: labeled }]
  }

  // 合并 system prompt + 人格段 + 工作区路径 + 记忆注入
  // v0.6.4：注入 workspaceDir 绝对路径，让 agent 知道工作区位置可正确列目录
  // v0.8.0 F822：注入人格段（role/goal/backstory/styleGuide）
  // v0.8.0：注入 L3a 策展记忆 + L4a 用户画像（memoryInjection 在 run 启动时构建）
  // 必须先于 adapter.complete 构建 systemPrompt，否则下一轮 Reason 会 TDZ 报错。
  // v0.19.0 M1：由 prompt-assembly 组装器统一渲染
  // v0.25.0 F1：按契约装配 system prompt（替代 buildSystemSections 的散段逻辑）。
  // alwaysOnContracts 已在 run 入口加载并完成预算/合法性校验（required 缺失启动期 throw）；
  // 同 agent 逐字节稳定 → 命中前缀缓存。pendingSystemHint 仅承载运行期瞬时提示。
  const systemPrompt = (
    await assembleSystemPrompt(
      {
        agent,
        workspaceDir: getWorkspaceDir(),
        memoryInjection,
        planItems: task.planItems,
      },
      alwaysOnContracts,
    )
  ).text
  pendingSystemHint = undefined  // 用完即清，下一轮若不调用 skill 则不再注入

  const adapter = await getAdapter(modelId)
  const model = await getModel(modelId)
  await emitContextSizeReport({
    taskId: task.id,
    iteration,
    systemPrompt,
    messages,
    tools,
    memoryInjection,
    contextWindow: model?.contextWindow,
  })
  // polish4 §D1.3：LLM 调用错误分级重试包装（120s 超时 + 重试 + 中止短路）
  // v0.27.0 R1：统一走 completeWithStream —— 流式增量经 text-delta 泵广播给渲染层，
  // 返回值仍为聚合后的完整响应；落盘纪律不变（delta 仅渲染加速，非数据源）。
  const sendTextDelta = (p: Parameters<typeof broadcastTextDelta>[0]): void => broadcastTextDelta(p)
  // 当前尝试的两条增量泵引用（abort 时读取已累计文本做双通道部分落盘）。
  // 用 holder 对象：闭包内赋值 TS 不追踪，直接用 let 变量会被窄化为 never。
  const turnPumpRef: { current: TextDeltaPump | null } = { current: null }
  const reasonPumpRef: { current: TextDeltaPump | null } = { current: null }
  const callTurnLlm = (maxTokensOverride?: number): Promise<LlmCompleteResponse> =>
    withLlmTimeout(
      (sig) => {
        // v0.31.0 B1（修 RC-1）：双通道分离 —— 叙述与思考各自一条泵、各自计 seq。
        // 此前只接线 onText，`onReasoning` 全仓库无消费方 → 真思考从未进入 UI。
        const textPump = createTextDeltaPump(task.id, 'turn', 'text', sendTextDelta)
        const reasoningPump = createTextDeltaPump(task.id, 'turn', 'reasoning', sendTextDelta)
        turnPumpRef.current = textPump
        reasonPumpRef.current = reasoningPump
        // v0.31.0 B1（修 RC-2）：流式期剥离 `<<<SAY>>>…<<<END>>>`。
        // 此前流式缓冲装的是 content 原文（含裸标记），却被渲染成「思考中」块 —— 语义错位。
        const stripper = createSayStripper()
        return completeWithStream(
          adapter,
          {
            system: systemPrompt,
            messages,
            tools,
            temperature: task.config.temperature ?? agent.defaultConfig.temperature ?? 0.5,
            maxTokens: maxTokensOverride ?? task.config.maxTokens,
            signal: sig,
          },
          {
            onText: (d) => {
              for (const chunk of stripper.push(d)) {
                // 只有 text 通道入泵；say 通道在流式期不外发（落定期由 step.say 权威接管，
                // 流式期混入任何通道都会造成落定瞬间的内容跳变）。
                if (chunk.channel === 'text') textPump.push(chunk.text)
              }
            },
            onReasoning: (d) => reasoningPump.push(d),
          },
        ).then((resp) => {
          // ① 残余攒批立即发出（权威 step 随后按「取较长者」交接）
          textPump.flush()
          reasoningPump.flush()
          // ② 剥离器兜底收尾：未闭合的 SAY / 半截开标记一律回退 text（正本 R5）
          for (const chunk of stripper.finish()) {
            if (chunk.channel === 'text') textPump.push(chunk.text)
          }
          textPump.flush()
          // ③ 权威 say 仍以 extractSayMarker(resp.content) 为准（既有落定期实现，不改）
          return resp
        })
      },
      120_000,
      signal,
    )

  let response: LlmCompleteResponse
  try {
    response = await callLlmWithRetry(() => callTurnLlm(), signal)

    // v0.15.0 Task 5：思考模型输出预算被思考耗尽（finish=length + content 空 + 无 tool action）
    // → 提高 maxTokens 到 8192 重试一次；仍空则注入占位答复，避免任务静默 done 且无内容。
    if (
      response.finishReason === 'length' &&
      !response.content &&
      !(response.actions && response.actions.length > 0) &&
      response.reasoningContent
    ) {
      logger.warn('Agent', 'reasoning exhausted output budget (finish=length, empty content) — retry with maxTokens=8192', task.id)
      await emitContextSizeReport({
        taskId: task.id,
        iteration,
        systemPrompt,
        messages,
        tools,
        memoryInjection,
        contextWindow: model?.contextWindow,
      })
      const retryResp = await callLlmWithRetry(() => callTurnLlm(8192), signal)
      if (retryResp.content || (retryResp.actions && retryResp.actions.length > 0)) {
        response = retryResp
      } else {
        const placeholder = '模型思考时间过长，未产出有效内容，请重试或更换模型'
        response = { ...response, content: placeholder, thought: placeholder }
      }
    }
  } catch (err) {
    // v0.27.0 R1：用户中断 → 把已流出的部分文本作为本轮 reason 落盘
    // （append-only 真源不变：写的是停止时刻已确认收到的内容），UI 呈现「已停止」态；
    // 随后向上抛给外层 catch 走 handleAbort 的 paused/cancelled 收尾。
    if (signal.aborted || (err as Error)?.name === 'AbortError') {
      // v0.31.0 B1（C-9）：中断时**两个通道各自留存**部分内容 ——
      // 此前只落 text 通道，而真思考在 reasoning 通道 → 中断场景连"部分思考"都没有（RC-12）。
      await persistAbortedReason(task.id, iteration, startedAt, {
        thought: turnPumpRef.current?.accumulated ?? '',
        reasoning: reasonPumpRef.current?.accumulated ?? '',
      })
      throw err
    }
    // v0.15.0 Task 2 SubTask 2.5 Layer 3 Reactive Fallback：
    // context 超限类错误 → 激进压缩（保留更少轮次）后重试一次，避免任务直接失败
    if (isContextOverflowError(err)) {
      logger.warn('Agent', `context overflow — aggressive compact + retry once: ${(err as Error).message}`, task.id)
      try {
        const result = await compressMemory(task.id, {
          keepSystem: true,
          keepRecentTurns: 1, // 激进：只保留最近 1 轮
          keepUserTurns: true,
          keepFileRefs: false,
          dropFailed: true,
        })
        await emitEvent(task.id, {
          type: 'context_compacted',
          iteration,
          layer: 3,
          beforeTokens: result.beforeTokens,
          afterTokens: result.afterTokens,
          archivedCount: result.archivedIds.length,
        })
      } catch (compactErr) {
        logger.warn('Agent', `reactive compact failed (silent): ${(compactErr as Error).message}`, task.id)
      }
      // 压缩后重新组装 messages（compressMemory 已归档旧条目，L1 变小）
      messages = await assembleMessages(task, agent)
      await emitContextSizeReport({
        taskId: task.id,
        iteration,
        systemPrompt,
        messages,
        tools,
        memoryInjection,
        contextWindow: model?.contextWindow,
      })
      // 压缩后重试（走 callLlmWithRetry：压缩后端点仍可能抖动，裸单发会把
      // 一次瞬时 429/超时直接升级成 task_failed —— v0.28.1 fix C）。
      // v0.27.0 R1：复用 callTurnLlm → 流式管道同样生效；seq 从 1 重启，
      // Renderer 以 seq===1 截断上一轮残流。
      response = await callLlmWithRetry(() => callTurnLlm(), signal)
    } else {
      // 非 context 超限错误 → 走原 catch (line 383)，转为 task_failed
      throw err
    }
  }

  const durationMs = Date.now() - startedAt

  // 写入 L1：assistant reasoning — content 只存纯文本，action 放 meta
  // polish4 §A2.1：assistant meta 含完整多 tool actions（含 toolCallIds）
  // 单一 tool 时直接平铺；多 tool 时 multi=true + actions[] 数组
  const rActions = response.actions ?? (response.action ? [response.action] : [])
  const rToolIds = response.toolCallIds ?? (response.toolCallId ? [response.toolCallId] : [])
  const reasoningMeta = rActions.length > 0
    ? JSON.stringify(rActions.length === 1
        ? {
            tool: rActions[0].tool,
            args: rActions[0].args,
            actionId: rToolIds[0] ?? `call_${iteration}_0`,
            toolCallId: rToolIds[0] ?? `call_${iteration}_0`,
          }
        : {
            multi: true,
            actions: rActions.map((a, i) => ({
              tool: a.tool,
              args: a.args,
              actionId: rToolIds[i] ?? `call_${iteration}_${i}`,
              toolCallId: rToolIds[i] ?? `call_${iteration}_${i}`,
            })),
          })
    : undefined
  const reasoningItem = await appendL1({
    taskId: task.id,
    role: 'assistant',
    kind: 'reasoning',
    content: response.thought,
    iteration,
    meta: reasoningMeta,
    // DeepSeek 思考模式的 reasoning_content，存入 raw 供下一轮传回
    raw: response.reasoningContent ? { reasoningContent: response.reasoningContent } : undefined,
  })

  const reasonStep: ReActStep = {
    id: genId('step'),
    taskId: task.id,
    iteration,
    type: 'reason',
    thought: response.thought,
    // v0.31.0 B1（U6）：原生思考通道独立落 step（展示层据此判定来源徽标 native / content）
    reasoning: response.reasoningContent,
    // v0.25.0 F4：阶段叙述（结论 + 下一步），与 thought 分离；缺省 → UI 回落旧版 hint
    say: response.say,
    action: response.action ?? undefined,
    startedAt,
    durationMs,
    tokensIn: response.tokensIn,
    tokensOut: response.tokensOut,
    cacheHitTokens: response.cache?.hitTokens,
    cacheMissTokens: response.cache?.missTokens,
    status: 'success',
  }
  broadcastStep(reasonStep)

  await emitEvent(task.id, {
    type: 'reason_end',
    iteration,
    thought: response.thought,
    say: response.say,
    // v0.31.0 B1：原生思考通道随事件下发（订阅方无需再读 L1 raw）
    reasoning: response.reasoningContent,
    action: response.action,
    tokensIn: response.tokensIn,
    tokensOut: response.tokensOut,
    cacheHitTokens: response.cache?.hitTokens,
    cacheMissTokens: response.cache?.missTokens,
    durationMs,
  })

  logger.info(
    'LLM',
    `POST /chat (${model?.name ?? modelId}) ← ${response.tokensIn}+${response.tokensOut} tokens` +
      (response.cache ? ` (cache hit ${response.cache.hitTokens})` : '') +
      ` ⏱ ${durationMs}ms`,
    task.id,
  )
  return { response }
}
