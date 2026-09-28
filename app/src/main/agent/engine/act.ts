/**
 * v0.27.0 R2（§3.1 引擎拆分）：Act 执行段：动作收集、观察摘要、executeAct 工具执行循环
 * 由 engine.ts 纯移动而来（行区间 2416-3010）。
 */

import {
  type Task,
  type PlanItem,
  type PlanItemStatus,
  type ReActEvent,
  type ReActAction,
  type ReActStep,
  type PlanContent,
  type Agent,
  getAdapter,
  getModel,
  type LlmMessage,
  type LlmTool,
  type LlmCompleteResponse,
  callLlmWithRetry,
  withLlmTimeout,
  isContextOverflowError,
  invokeSkill,
  skillToLlmTool,
  skillToolName,
  listSkills,
  getSkill,
  type SkillContext,
  isPluginToolName,
  isPluginControlTool,
  buildSystemSections,
  renderSystemPrompt,
  buildPersonalitySegment,
  collectAlwaysOnSections,
  assembleSystemPrompt,
  collectGateSpecs,
  initGateStates,
  checkGateBeforeAdvance,
  confirmGate,
  findGateForStageDoc,
  isDocDrivenAgent,
  type GateSpec,
  appendSessionEvent,
  drainContinuations,
  emitTurnStopping,
  matchStageGate,
  isCoreSkillsEnabled,
  buildGateBlockObservation,
  describeGateForLog,
  computeAllowedStage,
  matchForbiddenWritePath,
  matchForbiddenShellCommand,
  type StageGate,
  appendL1,
  listEnabledL1,
  listL1,
  totalTokens,
  persistRawL2,
  logger,
  genId,
  isNoisePlanItem,
  describeAction,
  createHash,
  updateTask,
  getTask,
  getAgent,
  broadcastStep,
  broadcastTaskStatus,
  broadcastToolProgress,
  clearToolProgress,
  broadcastPlanItemStatus,
  broadcastPlanListSnapshot,
  broadcastTextDelta,
  type ToolProgress,
  completeWithStream,
  createTextDeltaPump,
  type TextDeltaPump,
  getWorkspaceDir,
  saveCheckpoint,
  checkpointId,
  applyPending,
  getCuratedSnapshot,
  archiveTaskL1,
  initArchiveIndex,
  getProfile,
  synthesizeFromTaskL1,
  evaluateDistillTrigger,
  autoPromoteDistill,
  getDistillMetrics,
  runForSkillForge,
  compressMemory,
  compactTask,
  createMemoryPhase0,
  type CompressPolicy,
  estimatePayloadTokens,
  estimatePayloadTokensDetailed,
  estimateTextTokens,
  contextBudget,
  shouldCompact,
  truncateLongContent,
  MAX_REASONING_CONTENT,
  MAX_OBSERVATION_CONTENT,
  MICRO_COMPACT_PLACEHOLDER,
  OBSERVATION_TRUNCATED_MARK,
  getMemoryConfig,
  getSettings,
  listKb,
  listEnabledKb,
  searchKb,
  initKbIndex,
  readFile,
  computeContextBreakdown,
  type ContextBreakdownInput,
  type ContextBreakdownResult,
  type ContextToolEntry,
  type ContextSkillInstruction,
} from './engine-context.js'
// v0.34.4（D67）：未知工具名的「你是不是想用 X」（纯函数，见 shared/utils/tool-name-hint.ts）
import { unknownToolError } from '@shared/utils/tool-name-hint.js'
import { safeSlice } from './broadcast.js'
import { injectSkillInstruction } from './skills.js'
import { sanitizePlanItemText } from './plan-parser.js'
import { decidePlanAdvance } from './gates.js'
// v0.30.0：Sync 五子阶段的 act 后写回（S2 Drift → S3 Write → S4 Gate → S5 Event）
import { syncPostAct } from '../graph/sync.js'
import { renderGraphErrorForModel } from '../graph/invariants.js'
import { recordMetric } from '../graph/metrics.js'
// v0.38.0（D154）：任务清单控制面收敛 —— task_plan 的差异算法（纯函数）与投递出口
import { isDraftStatus, DRAFT_STATUSES, type PlanDraftItem } from '../ledger/plan-diff.js'
import type { LedgerArtifact } from '../ledger/types.js'
import { emitTurnNote } from './gate-channel.js'
import { isPlanTool, isRetiredPlanTool } from './work-class.js'
// v0.38.1（D177）：清单落库共享管线（task_plan 与正则清单回退共用）
import { commitPlanDraft } from './plan-commit-pipeline.js'
import type { LedgerItemStatus } from '../ledger/types.js'

/* ============================================================
 * v0.30.0：从 Act 参数中提取"漂移检测 / 验证匹配"所需的结构化信息
 *
 * 放在 engine 侧（而不是 graph 侧）的理由：**只有这里知道每个工具的参数形状**。
 * graph/drift.ts 与 graph/write.ts 只接受已经归一化的 files / command 字符串，
 * 保持内核与具体工具解耦。
 * ============================================================ */

/**
 * 提取本次 act 触碰的文件路径（用于 S2 漂移检测的文件交集信号）。
 *
 * 只覆盖**会产生文件系统副作用**的工具；读类工具的文件**也算**（读错文件同样是漂移）。
 */
export function extractTouchedFiles(tool: string, args: Record<string, unknown> | undefined): string[] {
  if (!args) return []
  const out: string[] = []
  const push = (v: unknown): void => {
    if (typeof v === 'string' && v.trim()) out.push(v.trim())
    else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string' && x.trim()) out.push(x.trim())
  }
  switch (tool) {
    case 'file-writer':
    case 'file-editor':
    case 'file-reader':
      push(args.path)
      break
    case 'glob-search':
      push(args.pattern)
      break
    case 'grep-search':
      push(args.path)
      break
    case 'shell':
      // shell 的文件改动无法可靠静态解析（可以 cat > x、tee、mkdir -p…），
      // 故**不猜测**：只把命令原文交给 E3 的启发式（它比对的是显式声明模块），
      // 文件信号留空 → drift 的文件信号为 null（被排除而不是算作"偏离"）。
      break
    default:
      break
  }
  return out
}

/**
 * 提取 shell 命令原文（用于 S3 的"验证命令匹配"）。
 *
 * 只处理 shell 工具 —— 验证命令必须通过 shell 执行，才能经过权限与风险守卫。
 */
export function extractShellCommand(tool: string, args: Record<string, unknown> | undefined): string | undefined {
  if (tool !== 'shell' || !args) return undefined
  const raw = args.command ?? args.cmd ?? args.script
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined
}

/** 大载荷字段：是"内容本体"不是"动作意图"，喂进语义信号会稀释重合度（v0.30.2 D13） */
const PAYLOAD_KEYS = new Set([
  'content', 'body', 'code', 'text', 'data', 'source', 'script', 'html', 'markdown', 'diff',
  'base64', 'buffer', 'json', 'value', 'items', 'args',
])

/**
 * 提取本次 act 的自然语言动作描述（用于 S2 漂移检测的第三信号 —— 语义/词法重合度）。
 *
 * v0.30.2 D13 根因修复：此前 act 调 syncPostAct 从不传 descriptions，sync.ts 兜底成
 * `[command ?? toolName]` —— 第三信号实际退化为「工具名 vs 节点意图」，调研/浏览类
 * 动作几乎必然 0 分（用户实测：调研任务 0.00 分连续 16 轮 hard 告警）。
 * 这里把工具参数中**承载意图**的文本（query/command/path/url/title/…）提出来喂给它，
 * 回归设计本意「Action 描述 vs 节点 intent」。大载荷字段（content/code/…）显式排除。
 *
 * 返回段落数组（tool 名固定为首段）；每段截断 120 字符、总量截断 360 字符。
 */
export function extractActionDescriptions(tool: string, args: Record<string, unknown> | undefined): string[] {
  const out: string[] = [tool]
  if (args) {
    for (const [k, v] of Object.entries(args)) {
      if (PAYLOAD_KEYS.has(k)) continue
      const texts = Array.isArray(v) ? v.slice(0, 3) : [v]
      for (const t of texts) {
        if (typeof t === 'string' && t.trim()) {
          out.push(`${k}: ${t.trim().slice(0, 120)}`)
        }
        if (out.length >= 6) break
      }
      if (out.length >= 6) break
    }
  }
  const joined = out.join(' | ')
  return [joined.slice(0, 360)]
}

export function buildObservationSummary(
  tool: string,
  result: unknown,
  summary: string,
  ok: boolean,
): string {
  /* 失败时根据工具名返回可操作的替代建议，引导 LLM 自主恢复。
   *
   * v0.34.4（D63）：本表是「失败 → 建议 → 再失败」死循环的唯一来源，纪律⑩：
   * **不得建议本轮刚被拒绝的那条调用**。建议必须满足「换参数 / 换工具 / 换层次」至少其一。
   *
   * 血案：v0.17.x 修过 `file-reader` 分支里的 `shell ls`（见下），却把同一类错误
   * 留在了本分支自己身上——第 ② 条建议 `file-reader({ path: "." })` 正是刚刚被
   * 「同参数调用已达上限（5/5）」拦掉的那条调用。真机记录（t1 · T-20260919-6c3v48）：
   * 模型照做 → I18/I24/I39/I45/I49 连续 5 次重试同一条被拦调用，51 轮零产物。
   *
   * 因此：① 建议里只出现**尚未被拦**的工具与参数形态；② 每个分支都要给"改什么"，
   * 不许退化成"换一种方法"这类空话（D63 同族：glob-search 落 default → 空话 →
   * 模型弹回 file-reader，两个已耗尽工具乒乓）。 */
  const suggestionFor = (t: string): string => {
    // v0.38.0（D154）：已下架的历史清单工具名 —— 判断走唯一守卫（纪律⑧）。
    // 不得再逐个 `case`：内联清单会随下架名单扩容而静默漏项
    // （v0.38.0 实现时正是漏了 task_update / task_get / task_list）。
    if (isRetiredPlanTool(t)) {
      return '\n\n💡 替代建议：该工具已废弃 —— 任务清单控制面已收敛为单一入口 task_plan。请改用 task_plan 提交你当前认为正确的**完整清单**（引擎自动算差异）。不要新造工具名。'
    }
    switch (t) {
      case 'web-search':
        return '\n\n💡 替代建议：1) 用 fetch-url 直接访问可能包含答案的网站 2) 用 shell 执行 curl 检查网络连通性 3) 基于已有知识推理并说明信息缺口。'
      case 'shell':
        return '\n\n💡 替代建议：1) 用 file-reader 读取文件内容 2) 调整命令参数后重试 3) 检查路径是否正确。'
      case 'fetch-url':
        return '\n\n💡 替代建议：1) 检查 URL 是否正确 2) 用 web-search 搜索相似内容 3) 尝试其他 URL。'
      case 'file-reader':
        // v0.17.x：shell 的 ls/cat 已被文件工具守卫拦截，此处不得再建议 shell ls，
        // 否则会形成「失败 → 建议 shell ls → 又被拦截」的死循环。改为指向专用文件工具。
        // v0.34.4（D63）：同上理由，**不得再建议 file-reader 自身**（尤其 path="."）。
        return '\n\n💡 替代建议：1) 换**不同**的 path（同一 path 本轮已被拒绝，再试必然再失败）2) 用 glob-search({ pattern: "docs/**/*" }) 缩小范围列出候选文件 3) 用 grep-search 直接在文件内容里找关键词 4) 若已读到足够信息，**停止探索、直接开始产出**（写文件 / 给出结论）。'
      case 'glob-search':
      case 'grep-search':
        return '\n\n💡 替代建议：1) 换**更精确**的 pattern（如 "docs/**/*.md"、"src/**/*.ts"），不要再用 "**/*" 2) 改用 file-reader({ path: "<具体子目录>" }) 逐层列出 3) 若已拿到文件清单，**停止列举、直接读文件或开始产出**。'
      case 'task_plan':
        // v0.38.0（D154）：清单控制面唯一入口。失败时把契约再讲一遍 ——
        // 常见失败是 items 为空 / status 用了非法值（如 "completed"）。
        return '\n\n💡 替代建议：用 task_plan({ items: [{ text: "要做什么", status: "todo|doing|done|skipped|blocked", note: "可选" }, …] }) 提交**完整**清单；items 必须非空数组，status 只接受那 5 个值。'
      case 'turn_note':
        return '\n\n💡 替代建议：turn_note({ text: "1–3 句具体结论" }) —— text 不能为空，写"已确认 X，接下来做 Y"，不要写"正在处理中"。'
      case 'task_complete':
      case 'ask_user':
        return ''
      default:
        return '\n\n💡 替代建议：1) 换一个**参数不同**的工具，或改用同类工具的另一形态 2) 若已拿到足够信息，直接进入产出（写文件 / 给出结论）3) 说明当前信息缺口，让用户补齐。'
    }
  }
  if (!ok) {
    return `[${tool}] failed: ${summary}${suggestionFor(tool)}`
  }
  // v0.24.0：统一消费 result.hint（防重读警告 / 拦截指令 / 零命中提示）。
  // v0.16.6 引入 hint 后一直没人读它——警告从未到达模型，这是"重读打转"未被纠正的根因之一。
  const hintText =
    result !== null && typeof result === 'object' &&
    typeof (result as Record<string, unknown>).hint === 'string'
      ? (result as Record<string, unknown>).hint as string
      : ''
  const withHint = (body: string) => (hintText ? `${body}\n\n⚠️ ${hintText}` : body)
  // v0.6.1：防御非标准返回结构（如用户拒绝执行 → { error }，或工具返回非对象）
  // 修复 v0.6.0 缺陷：result 缺字段时访问 .slice 抛 TypeError，导致整个 ReAct loop failed
  if (result === null || typeof result !== 'object') {
    return `[${tool}] ${summary}`
  }
  const anyResult = result as Record<string, unknown>
  if (typeof anyResult.error === 'string') {
    // 非标准失败返回（如用户拒绝执行、工具内部返回 error）：对执行类工具追加替代建议
    return `[${tool}] ${anyResult.error}${suggestionFor(tool)}`
  }
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  if (tool === 'file-reader') {
    const r = result as { content: string; lines: number; size: number; truncated: boolean; path: string }
    // v0.24.x fix: 200→4000，避免 thought stream 只显示头注释导致 LLM 误判文件已读完。
    // 实测：user 反馈 file-reader 反复返回 "...(truncated)" 头注释（200 字符太少），
    // LLM 看不清实际代码 → 反复调 file-reader 换 maxLines 重读同一文件 → 触发防重读 block。
    // 4000 字符 ≈ 60~80 行 JS/CSS，能容纳大多数 UI/工具函数实现段，
    // 详情在 Inspector 面板按需查看全文。
    const preview = safeSlice(str(r.content), 4000)
    return withHint(`[file-reader] ${r.path} (${r.lines} lines, ${r.size} bytes)\n\n${preview}${r.truncated ? '\n\n… (truncated, 继续读用 startLine/maxLines=0)' : ''}`)
  }
  // v0.18.x fix：写文件 / 编辑文件只回传摘要（路径 + 字节/行数/替换数），
  // 不回写文件内容，避免把整段代码透传进 thought stream / 工具卡，导致显示过长。
  if (tool === 'file-writer') {
    const r = result as { path: string; bytes: number; lines: number; created: boolean }
    return `[file-writer] ${r.path} (${r.bytes} bytes, ${r.lines} lines${r.created ? ', 新建' : ', 覆盖'})`
  }
  if (tool === 'file-editor') {
    const r = result as { path: string; replacements: number }
    return `[file-editor] ${r.path} (${r.replacements} replacements)`
  }
  if (tool === 'web-search') {
    const r = result as { results: Array<{ title: string; url: string; snippet: string }>; total: number; query: string }
    const results = r.results ?? []
    const lines = results.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`).join('\n\n')
    // 空结果等同于搜索失败：追加替代建议
    const emptySuggestion = results.length === 0 || r.total === 0 ? suggestionFor('web-search') : ''
    return `[web-search] query: "${r.query}" · ${r.total} results\n\n${lines}${emptySuggestion}`
  }
  if (tool === 'fetch-url') {
    const r = result as { url: string; finalUrl: string; title: string; text: string; chars: number; truncated: boolean; status: number }
    const header = `[fetch-url] ${r.url}${r.finalUrl !== r.url ? ` → ${r.finalUrl}` : ''} (status=${r.status}, ${r.chars} chars${r.truncated ? ', truncated' : ''})${r.title ? `\n标题：${r.title}` : ''}`
    const preview = safeSlice(str(r.text), 1500)
    return `${header}\n\n${preview}${r.truncated ? '\n\n… (truncated)' : ''}`
  }
  if (tool === 'shell') {
    const r = result as { command: string; cwd: string; stdout: string; stderr: string; exitCode: number | null; durationMs: number; timedOut: boolean }
    const out = safeSlice(str(r.stdout), 800)
    const err = safeSlice(str(r.stderr), 400)
    // v0.18.x fix：命令本身可能内嵌 heredoc 全文（写文件场景），截断避免泄露整段内容
    const cmd = safeSlice(str(r.command), 120)
    const header = `[shell] \`${cmd}\` exit=${r.exitCode} · ${r.durationMs}ms${r.timedOut ? ' · timed out' : ''}`
    return `${header}\n\nstdout:\n${out}${str(r.stdout).length > 800 ? '\n… (truncated)' : ''}${err ? `\n\nstderr:\n${err}${str(r.stderr).length > 400 ? '\n… (truncated)' : ''}` : ''}`
  }
  if (tool === 'delegate-agent') {
    // v0.36.0 F4.1：targets 数组化 —— 每个委派目标逐行呈现
    const r = result as { results?: Array<{ agentId: string; taskId: string | null; status: string; summary: string; iterations: number }> }
    const items = r.results ?? []
    const lines = items.map((it, i) =>
      `${i + 1}. @${it.agentId}（子任务 ${it.taskId ?? '未创建'}）· status=${it.status} · ${it.iterations} iterations\n   摘要：${safeSlice(str(it.summary), 400)}`,
    )
    const header = items.length === 1 ? '[delegate-agent] 委派 1 个子任务' : `[delegate-agent] 并行委派 ${items.length} 个子任务`
    return `${header}\n\n${lines.join('\n\n')}`
  }
  if (tool === 'session-search') {
    const r = result as { query: string; total: number; hits: Array<{ taskTitle: string; snippet: string; createdAt: number }> }
    const lines = (r.hits ?? []).map((h, i) => `${i + 1}. ${h.taskTitle}\n   ${safeSlice(h.snippet, 400)}`).join('\n\n')
    return `[session-search] query: "${r.query}" · ${r.total} archive hits\n\n${lines}`
  }
  // v0.24.0：default 分支剥离 hint 字段（已由 withHint 前置送达），避免 JSON 里重复一遍
  const { hint: _stripped, ...rest } = anyResult as Record<string, unknown>
  return withHint(`[${tool}] ${summary}\n\n${safeSlice(JSON.stringify(rest), 800)}`)
}

/* ============================================================
 * v0.14.0 Task 4：并行 Act 工具调用辅助
 *  - collectActionsForIteration：从 LLM 响应中提取所有工具调用；
 *    适配器同时回传 actions: ReActAction[]，旧路径退化为 [action]
 *  - executeAct：单条 act 的实际执行包装（错误隔离，单条失败不阻塞同组其它 act）
 *  - toFinishedProgress：act 完成后构造用于广播的 ToolProgress
 * ============================================================ */
/**
 * v0.37.0：清单概览渲染（反馈给 LLM，让它看到更新后的**账本**状态）。
 * 相比 v0.18.x 的五档 mark，新增 `paused`（中断待续）与 `verifying`（待验收）——
 * 这两个状态此前无符号，模型会把"暂停"误读成"没开始"从而重做（D131 同源）。
 */
function renderOverview(items: ReadonlyArray<{ status: string; text: string }>): string {
  return items
    .map((p, i) => {
      const mark =
        p.status === 'done'
          ? '[x]'
          : p.status === 'running'
            ? '[~]'
            : p.status === 'paused'
              ? '[‖]'
              : p.status === 'verifying'
                ? '[?]'
                : p.status === 'failed'
                  ? '[!]'
                  : p.status === 'skipped'
                    ? '[-]'
                    : p.status === 'cancelled'
                      ? '[·]'
                      : '[ ]'
      return `${mark} ${i + 1}. ${p.text}`
    })
    .join('\n')
}

export function collectActionsForIteration(response: LlmCompleteResponse): ReActAction[] {
  if (response.actions && response.actions.length > 0) return response.actions
  if (response.action) return [response.action]
  return []
}

/**
 * v0.19.x：控制工具（task_complete / ask_user）分支在暂停/完成任务时不再进入 Act 阶段，
 * 若本轮 LLM 并行返回多个 action，则除控制动作外的 assistant tool_calls 会悬空。
 * 为每个 pending action 补写配对 observation（控制动作写真实结果，其余写"跳过"），
 * 避免 assembleMessages 的 reconcileToolCalls 每轮剥离 dangling tool_calls。
 */
export async function appendPairedControlObservations(args: {
  taskId: string
  iteration: number
  actions: ReActAction[]
  actionIds: string[]
  controlTool: 'task_complete' | 'ask_user'
  controlContent: string
  skipPrefix: string
}): Promise<void> {
  for (let i = 0; i < args.actions.length; i++) {
    const a = args.actions[i]
    const callId = args.actionIds[i] ?? `call_${args.iteration}_${i}`
    const isControl = a.tool === args.controlTool
    await appendL1({
      taskId: args.taskId,
      role: 'tool',
      kind: 'observation',
      content: isControl ? args.controlContent : `${args.skipPrefix}${a.tool}`,
      iteration: args.iteration,
      meta: JSON.stringify({
        tool: a.tool,
        toolCallId: callId,
        actionId: callId,
        ...(isControl ? {} : { skipped: true }),
      }),
    })
  }
}

export interface ActExecutionResult {
  completedStep: ReActStep
  result: unknown
  resultSummary: string
  durationMs: number
  ok: boolean
  errorMessage?: string
  /**
   * v0.39.0（W2）：失败分类短码（`timeout` / `notfound` / `permission` / `parse` /
   * `context` / `exit` …）。供规划通道的失败摘要挑选**建议话术**（见 digest.ts）——
   * 模型在失败面前最需要的是"下一步该换什么"，不是更长的一串红字。
   */
  failureCode?: string
  additionalSystemHint?: string
}

export interface ActContext {
  task: Task
  agent: Agent
  signal: AbortSignal
  /** v0.17.x：react-core-skills 阶段写入守卫开关 */
  coreSkillsEnabled?: boolean
  /** v0.17.x：当前允许推进到的阶段（0~5），仅 coreSkillsEnabled 时有效 */
  allowedStage?: number
  /** v0.18.0：当前 ReAct 迭代编号（用于 patch payload 的 ts_iteration 字段） */
  iteration?: number
}

export async function executeAct(
  action: ReActAction,
  placeholder: ReActStep,
  ctx: ActContext,
): Promise<ActExecutionResult> {
  const actStartedAt = placeholder.startedAt
  // Task 8：会话级 KB 开关 = 全局开关 × 任务级开关（任一关闭即关闭，切换立即生效）
  const settings = await getSettings()
  const skillCtx: SkillContext = {
    taskId: placeholder.taskId,
    signal: ctx.signal,
    workspaceDir: getWorkspaceDir(),
    agent: ctx.agent,
    task: ctx.task,
    // Task 8：会话级 KB 开关（task.kbEnabled 默认 undefined = 视为开启）
    kbSessionEnabled: settings.kbEnabled !== false && ctx.task?.kbEnabled !== false,
    // v0.25.0 F1：技能指令体生命周期回调（三态）
    //  - always-on：指令体已在 system agent-static 段（collectAlwaysOnSections），跳过注入
    //  - on-demand：appendL1 kind='skill_instruction'，持续生效至任务结束
    //  - hint-only：不注入指令体（仅 description 进 tools 列表）
    onInstructionLoaded: async (payload) => {
      if (payload.instructionMode === 'hint-only') {
        logger.debug('Tool', `skill '${payload.skillId}' hint-only — skip instruction injection`, placeholder.taskId)
        return
      }
      if (payload.instructionMode === 'always-on') {
        logger.debug('Tool', `skill '${payload.skillId}' always-on — instruction already in system`, placeholder.taskId)
        return
      }
      // on-demand：写 L1 skill_instruction（持久化，与 plan_status 同管道）
      await injectSkillInstruction(
        ctx.task,
        { id: payload.skillId, name: payload.skillName },
        payload.text,
        ctx.iteration ?? 0,
      )
    },
  }
  let result: unknown
  let resultSummary = ''
  let rawL2Path: string | undefined
  let ok = true
  let errorMessage: string | undefined
  // v0.30.2 D13-E：本次 act 是否为技能加载（工具名 = skillToolName 动态名）。
  // 技能加载是准备动作，与节点意图零词法关联是预期行为，不参与漂移判定。
  let skillAct = false
  try {
    // v0.17.x：阶段感知写入守卫（react-core-skills 启用时）——
    // 拦截文档阶段越级写脚手架/源码，或写入 ArkWork 保留路径（tasks.json / .arkwork / .git）。
    if (ctx.coreSkillsEnabled) {
      const allowedStage = ctx.allowedStage ?? 0
      const actArgs = (action.args ?? {}) as Record<string, unknown>
      let guard: { blocked: boolean; reason: string } = { blocked: false, reason: '' }
      if (action.tool === 'file-writer' || action.tool === 'file-editor') {
        guard = matchForbiddenWritePath(String(actArgs.path ?? ''), allowedStage)
      } else if (action.tool === 'shell') {
        guard = matchForbiddenShellCommand(String(actArgs.command ?? ''), allowedStage)
      }
      if (guard.blocked) {
        const durationMs = Date.now() - actStartedAt
        const blockedStep: ReActStep = {
          ...placeholder,
          result: { error: guard.reason },
          resultSummary: guard.reason,
          durationMs,
          status: 'failed',
          errorMessage: guard.reason,
          softFail: true,
        }
        logger.warn('Tool', `${action.tool} blocked by stage guard: ${guard.reason}`, placeholder.taskId)
        return {
          completedStep: blockedStep,
          result: { error: guard.reason },
          resultSummary: guard.reason,
          durationMs,
          ok: false,
          errorMessage: guard.reason,
        }
      }
    }

    // v0.37.0（PRD F7）：set-task-mode —— **模型自选**任务模式。
    // 与 todo-update 同族（控制类工具，不走普通 skill 调用，必须在 invokeSkill 之前拦截）。
    // UI 不提供任何模式选择入口，声明权归模型；引擎只在模型未声明时兜底推导。
    if (action.tool === 'set-task-mode' || action.tool === 'set_task_mode') {
      const args = (action.args ?? {}) as Record<string, unknown>
      const rawMode = String(args.mode ?? '').trim()
      const reason = typeof args.reason === 'string' ? args.reason.slice(0, 200) : ''
      const valid = rawMode === 'chat' || rawMode === 'plan' || rawMode === 'spec'
      const durationMs = Date.now() - actStartedAt
      if (!valid) {
        const errMsg = `set-task-mode 参数非法：mode=${rawMode || '(空)'}（合法值 chat / plan / spec）`
        return {
          completedStep: { ...placeholder, result: { error: errMsg }, resultSummary: errMsg, durationMs, status: 'failed', errorMessage: errMsg, softFail: true },
          result: { error: errMsg }, resultSummary: errMsg, durationMs, ok: false, errorMessage: errMsg,
        }
      }
      const { setMode } = await import('../ledger/engine.js')
      const res = await setMode(placeholder.taskId, rawMode, 'model', reason || '模型自选')
      const summary = res.ok
        ? `任务模式已由模型设为 ${rawMode}（${reason || '未给理由'}），账本 r${res.revision}`
        : `任务模式写入失败：${res.error?.message ?? '未知原因'}`
      return {
        completedStep: { ...placeholder, result: { mode: rawMode, ok: res.ok }, resultSummary: summary, durationMs, status: res.ok ? 'success' : 'failed', errorMessage: res.ok ? undefined : summary },
        result: { mode: rawMode, ok: res.ok },
        resultSummary: summary,
        durationMs,
        ok: res.ok,
        errorMessage: res.ok ? undefined : summary,
      }
    }

    // ============================================================
    // v0.38.0（D154）：`task_plan` —— 任务清单的**唯一控制入口**。
    //
    // 收敛前模型侧有 11 个清单工具、两套定位语义（图工具按 node_id、账本工具按
    // item_index），且语义重叠（都能新增）→ 模型没有唯一正确答案可选，现场形态是
    // 「判断摇摆 / 用一个工具冒充另一个」。现在只有一个动作：
    // **提交你当前认为正确的完整清单**，差异由 `diffPlan`（纯函数）计算。
    //
    // 控制类工具 → 必须在 invokeSkill 之前拦截。
    // ============================================================
    if (action.tool === 'task_plan') {
      const args = (action.args ?? {}) as Record<string, unknown>
      const durationMs = Date.now() - actStartedAt
      const reason = typeof args.reason === 'string' ? args.reason.slice(0, 200) : ''

      // ---------- ① 形状校验（失败即回**可执行** observation，不静默丢弃） ----------
      const rawItems = args.items
      const shapeErrors: string[] = []
      const draft: PlanDraftItem[] = []
      if (!Array.isArray(rawItems) || rawItems.length === 0) {
        shapeErrors.push('items 必须是非空数组')
      } else {
        rawItems.forEach((it, i) => {
          const o = (it ?? {}) as Record<string, unknown>
          const text = typeof o.text === 'string' ? o.text.trim() : ''
          if (!text) {
            shapeErrors.push(`第 ${i + 1} 项缺少 text`)
            return
          }
          if (!isDraftStatus(o.status)) {
            shapeErrors.push(
              `第 ${i + 1} 项 status=${String(o.status)} 非法（合法值：${DRAFT_STATUSES.join(' / ')}）`,
            )
            return
          }
          // v0.38.1（D176）：成果产物声明（可选；done 项缺声明会被完成门禁 ARTIFACT 拦下）
          const rawArt = (o.artifact ?? undefined) as Record<string, unknown> | undefined
          let artifact: LedgerArtifact | undefined
          if (rawArt) {
            const p = typeof rawArt.path === 'string' ? rawArt.path.trim() : ''
            const check = typeof rawArt.check === 'string' ? rawArt.check.trim() : ''
            if (rawArt.kind === 'file' || rawArt.kind === 'dir') {
              if (!p) {
                shapeErrors.push(`第 ${i + 1} 项 artifact.kind=${rawArt.kind} 需要 path（相对工作区）`)
                return
              }
              artifact = { path: p, kind: rawArt.kind, check: check || undefined }
            } else if (rawArt.kind === 'command') {
              if (!check) {
                shapeErrors.push(`第 ${i + 1} 项 artifact.kind=command 需要 check（校验方式说明）`)
                return
              }
              artifact = { path: p, kind: 'command', check }
            } else {
              shapeErrors.push(`第 ${i + 1} 项 artifact.kind=${String(rawArt.kind)} 非法（file / dir / command）`)
              return
            }
          }
          draft.push({
            text,
            status: o.status,
            note: typeof o.note === 'string' && o.note.trim() ? o.note.trim().slice(0, 200) : undefined,
            ...(artifact ? { artifact } : {}),
          })
        })
      }
      if (shapeErrors.length > 0) {
        const errMsg = `task_plan 参数非法：${shapeErrors.slice(0, 3).join('；')}。请重新提交**完整**清单（items 非空，status 用 todo/doing/done/skipped/blocked）。`
        logger.warn('Agent', errMsg, placeholder.taskId)
        return {
          completedStep: { ...placeholder, result: { error: errMsg }, resultSummary: errMsg, durationMs, status: 'failed', errorMessage: errMsg, softFail: true },
          result: { error: errMsg }, resultSummary: errMsg, durationMs, ok: false, errorMessage: errMsg,
        }
      }

      // ---------- ②–⑦ 落库管线（v0.38.1 / D177 收敛到共享模块） ----------
      //   建账 → diffPlan → plan-commit → touch-sync → 图对账 → 阶段结论，
      //   与 D177 正则清单回退共用同一条管线（纪律⑧：单一实现，不漂移）。
      const committed = await commitPlanDraft({
        task: ctx.task,
        iteration: ctx.iteration ?? 0,
        draft,
        reason,
        source: 'task-plan',
      })
      if (!committed.ok) {
        const errMsg = `task_plan 被任务清单引擎拒绝：${committed.errorMessage ?? '未知原因'}`
        logger.warn('Agent', errMsg, placeholder.taskId)
        return {
          completedStep: { ...placeholder, result: { error: errMsg }, resultSummary: errMsg, durationMs, status: 'failed', errorMessage: errMsg, softFail: true },
          result: { error: errMsg }, resultSummary: errMsg, durationMs, ok: false, errorMessage: errMsg,
        }
      }
      const led = await import('../ledger/engine.js')
      const fresh = await led.loadLedger(placeholder.taskId)
      const freshItems = fresh?.items ?? []
      const diff = committed.diff!
      const graphSyncDegraded = committed.graphSyncDegraded

      // ---------- ⑧ observation：把引擎算出的差异回给模型，便于它确认自己的改动 ----------
      const overview = renderOverview(freshItems.map((it) => ({ status: it.status, text: it.text })))
      const protectedText =
        diff.protectedIds.length > 0 ? `\n（已保留 ${diff.protectedIds.length} 项已完成 / 终态清单项，不会回退）` : ''
      const warnText = diff.warnings.length > 0 ? `\n\n⚠️ 引擎自动纠正：${diff.warnings.join('；')}` : ''
      const degradeText = graphSyncDegraded
        ? `\n\n⚠️ 注意：任务图通道本次未同步（清单账本已记录，以账本为准）。已完成项不要重做。`
        : ''
      const summary =
        diff.changed === 0
          ? `清单已检视，无需变化（共 ${freshItems.length} 项）。\n当前清单：\n${overview}`
          : `清单已更新（${diff.summary}）${protectedText}。\n当前清单：\n${overview}${warnText}${degradeText}`
      // 落库日志已由共享管线输出（`${source}(ledger): changed=…`），此处不再重复
      return {
        completedStep: { ...placeholder, result: { changed: diff.changed, items: freshItems.length }, resultSummary: summary, durationMs, status: 'success' },
        result: { changed: diff.changed, items: freshItems.length, overview },
        resultSummary: summary,
        durationMs,
        ok: true,
      }
    }

    // ============================================================
    // v0.38.0（D154 / FR9.1）：**旧清单工具名的迁移兜底**。
    //
    // 9 个清单工具已下架（改由 `task_plan` 单入口承担）。历史会话 / 未刷新工具表的
    // 模型仍可能调旧名 —— 这里必须给出**可执行**的替代指引，绝不静默失败、
    // 也绝不退化成"直写 planItems"的第二条写入通道（纪律⑨）。
    //
    // 唯一事实源：`work-class.ts` 的 `RETIRED_PLAN_TOOLS`（纪律⑧）—— 此前是内联
    // if 链，漏了 `task_update` / `task_get` / `task_list`，它们会掉进 registry 的
    // `No handler for builtin skill` 静默路径（模型拿不到任何可执行指引）。
    // ============================================================
    if (isRetiredPlanTool(action.tool)) {
      const durationMs = Date.now() - actStartedAt
      const errMsg =
        `[deprecated-tool] 「${action.tool}」已废弃（v0.38.0：任务清单控制面收敛为单一入口）。\n` +
        `请改用 task_plan 提交你当前认为正确的**完整清单**（不是增量）：\n` +
        `  task_plan({ items: [ { text: "要做什么", status: "todo|doing|done|skipped|blocked", note: "可选说明" }, … ] })\n` +
        `引擎会与当前清单比对，自动计算新增 / 状态变化 / 删除，并保留已完成项。\n` +
        `判断「清单无需变化」时，提交与现在**相同**的清单即可（引擎会记录你已做过检视）。`
      logger.warn('Agent', `deprecated tool called: ${action.tool}`, placeholder.taskId)
      return {
        completedStep: { ...placeholder, result: { error: errMsg, deprecated: action.tool }, resultSummary: errMsg, durationMs, status: 'failed', errorMessage: errMsg, softFail: true },
        result: { error: errMsg, deprecated: action.tool },
        resultSummary: errMsg,
        durationMs,
        ok: false,
        errorMessage: errMsg,
      }
    }

    // ============================================================
    // v0.38.0（D156）：`turn_note` —— 阶段结论（给用户的输出，不是工具副作用）。
    //   P7 触发点②：模型每得出一个中间结论 / 完成一个小任务就投一条，用户在长任务
    //   里能看到进展，而不是"思考 8 轮，然后一次性给最终结果"。
    //   与 `task_complete` 的区别：它**不结束本轮**，只是把结论投进交互区。
    //   **不写 L1**：输出不是输入（否则会被当成上下文/用户消息反复回灌）。
    // ============================================================
    if (action.tool === 'turn_note') {
      const args = (action.args ?? {}) as Record<string, unknown>
      const durationMs = Date.now() - actStartedAt
      const text = typeof args.text === 'string' ? args.text.trim() : ''
      if (!text) {
        const errMsg = 'turn_note 参数非法：text 不能为空。请写 1–3 句具体结论（"已确认 X，接下来做 Y"）。'
        return {
          completedStep: { ...placeholder, result: { error: errMsg }, resultSummary: errMsg, durationMs, status: 'failed', errorMessage: errMsg, softFail: true },
          result: { error: errMsg }, resultSummary: errMsg, durationMs, ok: false, errorMessage: errMsg,
        }
      }
      await emitTurnNote({
        taskId: placeholder.taskId,
        iteration: ctx.iteration ?? 0,
        text: text.slice(0, 1000),
        via: 'model',
      })
      const summary = `已向用户投递阶段结论（${Math.min(text.length, 1000)} 字）。`
      logger.info('Agent', `turn_note emitted (${text.length} chars)`, placeholder.taskId)
      return {
        completedStep: { ...placeholder, result: { note: text.slice(0, 200) }, resultSummary: summary, durationMs, status: 'success' },
        result: { note: text.slice(0, 200) },
        resultSummary: summary,
        durationMs,
        ok: true,
      }
    }
    // 找到 skill id：按 LLM 工具名匹配（v0.6.1：兼容 SkillHub 中文名技能，见 skillToolName）
    // ★ v0.35.0：插件工具（`plugin__<pluginId>__<name>`）。
    // 走独立分支而不是塞进 skill 路径：它的**执行边界在另一个进程**，
    // 失败语义（插件未激活 / 进程判死 / 调用超时）与 skill 完全不同，
    // 混在一条链上会让这些错误被当成「工具不存在」而推给模型重猜名字。
    // ★ v0.35.0：插件控制工具（**宿主**提供的，与插件自带工具刻意分开命名空间）。
    // 放在插件工具分支之前：这几个在插件运行时缺席时也要能给出人话错误，
    // 而不是掉进 `isPluginToolName` 的兜底里被当成「插件抛错」。
    if (isPluginControlTool(action.tool)) {
      const { invokePluginControlTool } = await import('../tools/plugins.js')
      const r = await invokePluginControlTool(action.tool, (action.args ?? {}) as Record<string, unknown>)
      result = r.result
      resultSummary = r.summary
    } else if (isPluginToolName(action.tool)) {
      const { getPluginHostService } = await import('../../plugins/runtime/host-service.js')
      const svc = getPluginHostService()
      if (!svc) throw new Error(`plugin-runtime-unavailable: 插件运行时未装配，无法调用 ${action.tool}`)
      const r = await svc.callPluginTool(action.tool, action.args ?? {})
      result = r.result
      resultSummary = r.summary
      const resultJson = JSON.stringify(result)
      if (resultJson.length > 4000) {
        rawL2Path = await persistRawL2(placeholder.taskId, placeholder.id, result)
      }
    } else {
      const skills = await listSkills()
      const skill = skills.find((s) => skillToolName(s) === action.tool)
      // v0.34.4（D67）：未知工具必须回「你是不是想用 X」，否则模型只能再猜一个名字
      // （真机：`todo-write` 被拒时真实工具就叫 `todo_update`，只差一个词根）。
      if (!skill) throw new Error(unknownToolError(action.tool, skills.map((s) => skillToolName(s))))
      skillAct = true

      const r = await invokeSkill(skill.id, action.args, skillCtx)
      result = r.result
      resultSummary = r.summary

      // 大结果落 L2
      const resultJson = JSON.stringify(result)
      if (resultJson.length > 4000) {
        rawL2Path = await persistRawL2(placeholder.taskId, placeholder.id, result)
      }
    }
  } catch (err) {
    ok = false
    errorMessage = (err as Error).message
    result = { error: errorMessage }
    resultSummary = `failed: ${errorMessage}`
    logger.error('Tool', `${action.tool} failed: ${errorMessage}`, placeholder.taskId)
  }
  // v0.23.0：判定软失败（橙色警告）vs 真实失败（红色错误）。
  // 软失败：工具未找到 / 参数非法 / 权限拒绝 / 用户拒绝 / 命令确认超时 / shell 退出码非 0
  // （用户禁用 shell 等场景均为非致命，提示用户修改命令即可，不该让 step 变红）。
  // 真实失败：网络 5xx / MCP 子进程退出 / 文件系统权限等致命错。
  let isSoftFail = false
  if (!ok && errorMessage) {
    const msg = errorMessage
    if (
      msg.includes('Tool not found') ||
      msg.includes('tool-not-found') ||
      msg.includes('参数非法') ||
      msg.includes('参数错误') ||
      msg.includes('schema') ||
      msg.includes('validation failed') ||
      msg.includes('invalid argument') ||
      msg.includes('参数校验') ||
      msg.includes('Permission denied') ||
      msg.includes('permission denied') ||
      msg.includes('用户拒绝') ||
      msg.includes('用户已取消') ||
      msg.includes('命令确认') ||
      msg.includes('确认超时') ||
      msg.includes('确认已取消') ||
      msg.includes('exited with code') ||
      msg.includes('exit code') ||
      msg.includes('退出码') ||
      msg.includes('exitCode')
    ) {
      isSoftFail = true
    }
  }
  // v0.17.6：引擎独立决策——基于 act 结果推进清单状态，**不依赖 LLM 自调 todo_update**。
  // 决策规则（详见 decidePlanAdvance）：
  //   1. act 失败 → running 项自动 failed
  //   2. act 成功 + 产成性工具（file-writer / file-editor / shell / spec / ...）→ running 项自动 done 并推进下一项
  //   3. act 成功 + 只读工具（file-reader / web-search / ...）→ 保持 running，让 LLM 决定
  // v0.18.0 F1：决策落定后通过 broadcastPlanItemStatus 推单条 patch（不调整对象广播）。
  // 写入顺序：先落盘（updateTask）→ 再广播 patch，保证内存/磁盘/三视图一致。
  // ============================================================
  // v0.30.0（Sync · S2–S5）：有 TaskGraph 时改走图写回
  //
  // 与下面既有 `decidePlanAdvance` 路径的**唯一语义差异**：
  //   判定依据从「工具调用成功」换成「验收通过」。
  //   普通工具成功不再自动把节点标 done —— 只有验证命令（匹配
  //   `verification.command` 或 `acceptance[].verify.command`，退出码符合期望）
  //   才会更新验收状态并推进完成。
  //
  // 在同一位置追加三个子阶段：S2 Drift（比对动作 vs 任务意图）、
  // S4 Gate（写前跑 I1–I7）、S5 Event（E1–E9 → Replan / 干预 / 收敛）。
  //
  // 无图时（tier 0/1 轻量任务、尚未迁移的老任务）继续走下面的既有路径，
  // **行为与 v0.29 完全一致**。
  // ============================================================
  if (ctx.task.graphId) {
    try {
      const syncRes = await syncPostAct(
        { taskId: placeholder.taskId, graphId: ctx.task.graphId, iteration: ctx.iteration ?? 0 },
        {
          toolName: action.tool,
          ok,
          args: action.args ?? {},
          errorMessage,
          files: extractTouchedFiles(action.tool, action.args),
          command: extractShellCommand(action.tool, action.args),
          // v0.30.2 D13：喂真实动作描述给第三信号（此前退化为 toolName 兜底 → 语义恒 0）
          descriptions: extractActionDescriptions(action.tool, action.args ?? {}),
          // v0.30.2 D13-E：技能加载不参与漂移判定（sync.ts 据此跳过 S2）
          metaTool: skillAct,
        },
      )
      recordMetric('tool_call')

      // 验证触发：把"该跑哪条命令"以指令性 observation 交给模型执行。
      // 为什么不在这里直接跑：复用既有 shell 工具通道才能保证命令经过
      // assessCommandRisk / shell-audit / 当前 permission-mode；引擎内直跑
      // 会绕过（或重复实现）这套守卫。详见 04-system-design.md §6.2 的回溯说明。
      if (syncRes.verifyTrigger) {
        const node = syncRes.graph?.nodes[syncRes.verifyTrigger.nodeId]
        resultSummary +=
          `\n\n[verification-required] 节点 ${node?.key ?? syncRes.verifyTrigger.nodeId} 已进入 verifying，` +
          `但"完成"要由验证结果判定，不是由宣称判定。请立即执行验证命令：\n` +
          `  \`${syncRes.verifyTrigger.command}\`\n` +
          `跑完后本节点会按退出码自动转为 completed（退出码符合期望）或 failed（超次触发重规划）。`
      }

      // 门禁拒绝：把结构化错误（含 hint）交给模型自纠
      if (syncRes.gateError) {
        resultSummary += `\n\n[gate-rejected] ${renderGraphErrorForModel(syncRes.gateError)}`
      }

      // 状态变更摘要（沿用既有 [engine-decision] 的呈现习惯，便于 UI/日志一致）
      if (syncRes.changes.length > 0) {
        const lines = syncRes.changes
          .map((c) => {
            const g = syncRes.graph
            const key = g?.nodes[c.nodeId]?.key ?? c.nodeId
            const t = c.from && c.to ? `${c.from} → ${c.to}` : '字段更新'
            return `  - ${key}：${t}（${(c.reason ?? '').slice(0, 80)}）`
          })
          .join('\n')
        resultSummary += `\n\n[engine-decision] 引擎独立判断任务图状态：\n${lines}`
        logger.info(
          'Agent',
          `graph-sync tool=${action.tool} ok=${ok} ${syncRes.changes
            .map((c) => `${c.nodeId}:${c.from ?? '-'}->${c.to ?? '-'}`)
            .join(',')}`,
          placeholder.taskId,
        )
      }

      // 漂移软提示（不阻止，只把漂移变成显式信息）
      if (syncRes.driftHint) {
        resultSummary += `\n\n${syncRes.driftHint}`
      }
      // 漂移硬干预提示（v0.30.2 D13：同一任务只提请一次，见 sync.ts hardAlerted）。
      // 文案实话实说：E2 ask 事件目前不暂停执行，这里是让模型自纠/调方向；
      // 用户可在对话流看到该提示并随时介入。
      if (syncRes.driftHardText) {
        resultSummary += `\n\n[drift-alert] 检测到持续偏离（本提示对同一任务只提请一次；请自纠或用 task_plan 调整清单方向）：\n${syncRes.driftHardText}`
      }
    } catch (syncErr) {
      // Sync 是增强不是关键路径：任何异常都不允许让 act 失败
      logger.warn('Agent', `graph-sync skipped: ${(syncErr as Error).message}`, placeholder.taskId)
    }
  } else if (ctx.task.planItems && ctx.task.planItems.length > 0 && !isPlanTool(action.tool)) {
    try {
      const { decisions } = decidePlanAdvance(
        ctx.task.planItems,
        action.tool,
        ok,
        errorMessage,
      )
      if (decisions.length > 0) {
        // ============================================================
        // v0.37.0（缺陷 D132）：无图任务（tier 0/1）的引擎判定也走账本。
        // 此前这里 `updateTask({ planItems: nextItems })` 直写，与 todo_update
        // （账本通道）形成两条写入通道 —— 同轮内后者覆盖前者，正是"清单与真相
        // 不一致"的第二种形态（对比 §4.2）。现在统一经 ledger.mutate 串行落盘。
        // ============================================================
        const ledX = await import('../ledger/engine.js')
        const { toPlanItems } = await import('../ledger/project.js')
        const applyDecision = async (d: (typeof decisions)[number]): Promise<void> => {
          const item = ctx.task.planItems?.[d.index]
          if (!item) return
          const source = d.after === 'failed' ? 'engine-fail' : 'engine-decide'
          const op =
            d.after === 'done'
              ? ({ kind: 'advance', fromItemId: item.id, source, note: d.reason } as const)
              : ({ kind: 'set-status', itemId: item.id, to: d.after, source, note: d.reason, force: true } as const)
          let r = await ledX.mutate(placeholder.taskId, op, { actor: 'engine-decide' })
          if (!r.ok && r.error?.code === 'NOT_FOUND') {
            try {
              await ledX.ensureLedger(ctx.task, { seedFromPlanItems: true })
              r = await ledX.mutate(placeholder.taskId, op, { actor: 'engine-decide' })
            } catch (err) {
              logger.warn('Agent', `engine-decision 建账失败：${(err as Error).message}`, placeholder.taskId)
            }
          }
          if (!r.ok) {
            logger.warn('Agent', `engine-decision 被账本拒绝：${r.error?.message ?? '未知'}`, placeholder.taskId)
          }
        }
        // 1) 串行落账（账本内 per-task 锁保证不丢更新）
        for (const d of decisions) await applyDecision(d)
        // 2) 以账本为准回读，作为本轮后续展示的唯一依据
        const fresh = await ledX.loadLedger(placeholder.taskId)
        const nextItems = fresh ? toPlanItems(fresh) : (ctx.task.planItems ?? [])
        ctx.task.planItems = nextItems
        // 3) 单条 patch 广播（F1 通道激活）；多 decisions 串行 N 次 + version 单调自增
        for (const d of decisions) {
          const item = nextItems[d.index]
          if (!item) continue
          broadcastPlanItemStatus(placeholder.taskId, [
            {
              planItemId: item.id,
              index: d.index,
              fromStatus: d.before,
              status: item.status,
              source: item.status === 'failed' ? 'engine-fail' : 'engine-decide',
              reason: d.reason,
              ts_iteration: ctx.iteration,
            },
          ])
        }
        const overview = nextItems.map((p, i) => {
          const mark =
            p.status === 'done'
              ? '[x]'
              : p.status === 'running'
                ? '[~]'
                : p.status === 'failed'
                  ? '[!]'
                  : p.status === 'skipped'
                    ? '[-]'
                    : '[ ]'
          return `${mark} ${i + 1}. ${p.text}`
        }).join('\n')
        // v0.18.x fix: reason 截 80 字防爆行；overview 已在路径 A 打印过，
        // 路径 B 走 patch 通道（broadcastPlanItemStatus）让 Renderer 维护当前态，
        // 这里不重复打印整张清单，避免 thought stream 被压成 10+ 行扁平文本。
        const decisionList = decisions
          .map((d) => {
            const reason = (d.reason ?? '').length > 80
              ? (d.reason ?? '').slice(0, 80) + '…'
              : d.reason ?? ''
            return `  - 第 ${d.index + 1} 项：${d.before} → ${d.after}（${reason}）`
          })
          .join('\n')
        resultSummary += `\n\n[engine-decision] 引擎独立判断清单状态：\n${decisionList}`
        // 记日志
        if (decisions.some((d) => d.after === 'done' || d.after === 'failed')) {
          logger.info(
            'Agent',
            `engine-decision tool=${action.tool} ok=${ok} ${decisions.map((d) => `${d.index}:${d.before}->${d.after}`).join(',')}`,
            placeholder.taskId,
          )
        }
      }
    } catch (decideErr) {
      logger.warn('Agent', `engine-decide skipped: ${(decideErr as Error).message}`, placeholder.taskId)
    }
  }
  const durationMs = Date.now() - actStartedAt
  return {
    completedStep: {
      ...placeholder,
      result,
      resultSummary,
      rawL2Path,
      durationMs,
      status: ok ? 'success' : 'failed',
      errorMessage,
      // v0.23.0：软失败标记供 Renderer 区分橙色警告与红色错误
      softFail: !ok && isSoftFail,
    },
    result,
    resultSummary,
    durationMs,
    ok,
    errorMessage,
    // v0.39.0（W2）：失败短码 —— 只在失败时给，供规划通道挑建议话术
    failureCode: ok ? undefined : classifyFailureCode(errorMessage),
    additionalSystemHint: skillCtx.additionalSystemHint,
  }
}

/**
 * v0.39.0（W2）：把一条失败消息归到少数几类短码。
 *
 * 为什么只要短码：失败摘要喂给规划模型时，原文已经截断到 160 字了；真正决定
 * 「该给什么建议」的是**类别**（超时该拆小、权限该换位置、解析失败该换结构），
 * 而不是具体报错文本。分类失败返回 `undefined` —— 摘要侧有兜底建议。
 */
export function classifyFailureCode(message?: string): string | undefined {
  const m = String(message ?? '')
  if (!m.trim()) return undefined
  if (/timeout|超时|timed?\s*out/i.test(m)) return 'timeout'
  if (/not\s*found|不存在|没有找到|enoent/i.test(m)) return 'notfound'
  if (/permission|权限|denied|eacces|禁止/i.test(m)) return 'permission'
  if (/parse|json|解析|unexpected token/i.test(m)) return 'parse'
  if (/context|上下文|overflow|过长|too long/i.test(m)) return 'context'
  if (/exit\s*(code)?\s*\d+|non-zero|命令.*失败|command failed/i.test(m)) return 'exit'
  return undefined
}

export function toFinishedProgress(step: ReActStep, groupId: string): ToolProgress {
  return {
    taskId: step.taskId,
    groupId,
    requestId: step.id,
    tool: step.toolName ?? 'unknown',
    status: step.status === 'success'
      ? 'success'
      : step.status === 'cancelled'
        ? 'cancelled'
        : 'failed',
    startedAt: step.startedAt,
    finishedAt: step.startedAt + step.durationMs,
    durationMs: step.durationMs,
    errorMessage: step.errorMessage,
    resultSummary: step.resultSummary,
  }
}
