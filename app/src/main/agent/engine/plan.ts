/**
 * v0.27.0 R2（§3.1 引擎拆分）：计划生成编排：PLAN_SYSTEM_PROMPT 家族与 tryGeneratePlan/generatePlan
 * 由 engine.ts 纯移动而来（行区间 1859-2048）。
 */

import {
  type Task,
  type PlanItem,
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
import { parsePlanItems } from './plan-parser.js'
import { safeSlice, emitProgress } from './broadcast.js'
import { emitContextSizeReport } from './context.js'
import { assembleMessages } from './messages.js'
// v0.39.0（W1）：开局规划通道（独立、不带工具的一次调用）
import { runPlannerPass, getPlannerModelId } from '../planning/runner.js'
import type { PlannerRequest } from '../planning/types.js'

/**
 * v0.38.1（D168）①：解析「直接答案 JSON 对象」形态的辅助。
 * 仅接受严格对象（非数组）；解析失败返回 null（调用方据此走原解析链）。
 */
function safeParseJsonObject(s: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(s)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/* ============================================================
 * v0.9.1 计划生成（TraeWork 式 Spec/Plan/对话三模式）
 * 用一次轻量 LLM 调用，先评估任务复杂度，再自主决定是否产出计划及粒度。
 * 生成失败（解析失败/超时/中断）或评估为对话级任务时返回 null，任务照常运行。
 * ============================================================ */
const PLAN_SYSTEM_PROMPT = `你是一个任务规划助手。你需要先评估用户请求的复杂度，再自主决定是否产出步骤清单：

**对话级（简单任务，不产出计划）**
- 适用：问答、查询、单文件小改、解释说明、代码片段补全、单一概念解释
- 判断依据：单文件改动、无架构决策、边界清晰、预估工作量小
- 输出：空数组 []（不得编造步骤凑数）

**Plan 级（中等任务，concise 计划）**
- 适用：功能开发、bugfix、模块重构、多文件改动但范围明确
- 判断依据：影响多个文件、有清晰范围但需分步推进、工作量适中
- 输出：3~6 个步骤，按执行顺序排列；每步一行、20 字以内的动宾短语，一行内说清"做什么"，不带解释和修饰

**Spec 级（复杂任务，分阶段详细计划）**
- 适用：系统级、跨多模块、架构改动、新项目搭建、技术选型
- 判断依据：跨多文件/多模块、需架构决策、边界待澄清、工作量大
- 输出：按"阶段"组织的详细计划，每阶段含子步骤；阶段标题前置"阶段 N："或"Phase N："，子步骤紧跟其后
- **关键约束（v0.17.5）**：
  - 阶段标题（"阶段 1：技术选型与架构设计"）只是分组标签，**不要作为可勾选清单项**——只列出该阶段下可验证的子步骤（如"调研 GitHub 热门项目并提炼玩法机制"）
  - 每个清单项必须包含具体动作动词（调研/写/实现/测试/打包/运行/...），描述"做什么"而不是"是什么阶段"
  - 子步骤应是单次或少数几次工具调用就能完成的可验证动作，不要过于宽泛

**通用要求**：
- 步骤必须基于对项目代码（文件、模块、调用关系）的分析，禁止使用通用模板或凭空想象
- 步骤之间相互独立、按执行顺序排列
- 每步一行短句（参考样式："整体验证：typecheck + npm test"、"electron-builder 打包 .app"），禁止长句、子句嵌套或多行描述
- 只输出 JSON 字符串数组，不要任何解释、前后缀或代码块标记
- **硬性格式约束（v0.24.1）**：最终回复必须只包含 JSON 数组本身（如 ["a","b"]），禁止 Markdown 代码块、禁止序号前缀（"1. "）、禁止任何正文说明。若你是思考型模型，思考过程只放在内部，不要把思考写进回复。
- 如果实在无法给出有效步骤，输出 []（空数组）即可

**示例输出（对话级）**：[]
**示例输出（Plan 级）**：["定位 auth middleware 文件并梳理流程", "在 session.ts 中修复 token 校验逻辑", "补全单元测试覆盖回归用例", "运行 typecheck 与 lint 确认无回归"]
**示例输出（Spec 级）**：["阶段 1：架构调研", "梳理现有模块依赖与边界", "输出 ADR 草案", "阶段 2：搭建脚手架", "初始化目录结构", "接入核心依赖", "阶段 3：实现核心能力", "实现 A 模块", "实现 B 模块", "阶段 4：联调与验收", "端到端测试", "文档与发布"]`

/**
 * v0.17.4：文档驱动开发专用计划 prompt。
 * 当 react-core-skills 启用时替换通用 PLAN_SYSTEM_PROMPT，强制计划项 1:1 对齐
 * 文档驱动开发阶段。解决「清单与执行内容不匹配」——旧 prompt 的 Spec 级示例
 * 用自建阶段（架构调研→搭建脚手架→…），与文档驱动开发阶段完全不对齐。
 */
const PLAN_SYSTEM_PROMPT_DOC_DRIVEN = `你是文档驱动开发的任务规划助手。**先评估任务复杂度，再决定是否产出阶段清单**：

**Tier-0 对话级出口（不产出清单）**：问答、查询、检查、分析、解释等**只读任务**（无 docs/ 交付物、无多步产出）→ 输出 []（引擎将回退为单项清单「用户原始请求」）。禁止为只读任务强行套用下方 10 阶段。

**文档驱动级（产出清单）**：需要产出代码/文档交付物的多步任务 → 拆解为按文档驱动开发阶段排列的计划清单。

**阶段清单（必须严格按此顺序，不得跳阶段、不得重命名阶段）**：
1. 开源调研：搜索 GitHub 等开源社区类似项目，评估借鉴/自研，产出 docs/v1.0/00-opensource-research.md
2. PRD：明确目标用户、核心问题、功能清单（P0/P1/P2），产出 docs/v1.0/01-prd.md
3. 交互文档：页面清单、主流程图、五态设计、设计 token，产出 docs/v1.0/02-interaction.md
4. HTML 原型：纯静态 HTML 交互原型（设计稿，非编码），产出 docs/v1.0/prototype/index.html
5. 系统设计：技术选型、架构分层、数据模型、接口契约，产出 docs/v1.0/03-system-design.md
6. 编码：按系统设计实现功能（此阶段才允许写 src/、package.json 等代码文件）
7. 功能测试：冒烟→详测→验收，产出 docs/v1.0/04-function-test-report.md
8. UI 测试：对照原型逐页验证，产出 docs/v1.0/05-ui-test-report.md
9. UX 校验：用户视角走查，产出 docs/v1.0/06-ux-review-report.md
10. 交付打包：构建产物 + 快速开始说明

**关键约束**：
- HTML 原型（阶段 4）是设计文档的一部分，不是编码。产出物是 docs/v1.0/prototype/*.html
- 阶段 1~5 都是文档/设计产出，禁止在此期间安排任何编码步骤（初始化项目、搭建 src、写代码）
- 编码步骤只能出现在阶段 6，测试步骤只能出现在阶段 7~9
- 每个清单项格式："阶段 N：xxx"，N 对应上方阶段编号；xxx 为 20 字以内动宾短语
- 小型功能允许合并阶段 1~5 为一份精简设计文档，但阶段顺序不变

**只输出 JSON 字符串数组，不要任何解释、前后缀或代码块标记**
- **硬性格式约束（v0.24.1）**：最终回复必须只包含 JSON 数组本身；禁止 Markdown 代码块、禁止序号前缀、禁止正文说明。思考型模型的思考过程只放内部。
- 每个清单项含动作动词（调研/编写/产出/编码/测试/打包…），不要纯阶段标题

**示例**：["阶段 1：调研开源项目并产出调研文档", "阶段 2：编写 PRD 与功能范围", "阶段 3：编写交互文档与设计 token", "阶段 4：产出 HTML 交互原型", "阶段 5：编写系统设计文档", "阶段 6：编码实现核心功能", "阶段 7：功能测试并产出报告", "阶段 8：UI 测试并产出报告", "阶段 9：执行 UX 校验", "阶段 10：打包交付"]`

/** v0.9.x：generatePlan 首次解析失败时的降级精简 prompt（强制 3~5 步紧凑清单） */
const PLAN_SYSTEM_PROMPT_RETRY = `你是一个任务规划助手。请将用户请求拆解为 3~5 个简短、可执行的步骤清单。
要求：
- 每步一行、20 字以内动宾短语，按执行顺序排列
- 步骤应针对具体任务（如涉及新项目，包含"创建项目目录""实现核心功能""测试运行"等实际步骤），禁止通用模板
- 只输出 JSON 字符串数组，不要任何解释、前后缀或代码块标记
- **硬性格式约束（v0.24.1）**：最终回复必须只包含 JSON 数组本身；思考型模型的思考过程只放内部，不要写进回复
示例输出：["创建项目目录并初始化结构", "实现核心功能", "编写测试并运行验证"]`

/**
 * v0.9.x：单次计划生成尝试（首次 + 降级重试共用）。
 * 解析失败（含 Spec 级长计划被 maxTokens 截断）时返回 null，由调用方决定是否降级重试。
 *
 * v0.30.0 / P8：`onNull` 回传失败成因，供调用方区分——
 *  - `explicitEmpty=true`：模型**显式**输出空数组 `[]`（Tier 0，单步/问答/确定性小改），
 *    属**正常**结果，不弹 Plan 闸门错误态；
 *  - `explicitEmpty=false`：模型输出不可解析（非 JSON / 被截断），属**真实失败**，
 *    三级降级链全部失败后由 `generatePlan` 上报为错误态（原型 page-08 error）。
 */
export async function tryGeneratePlan(
  systemPrompt: string,
  maxTokens: number,
  temperature: number,
  task: Task,
  agent: Agent,
  modelId: string,
  signal: AbortSignal,
  extraSystemHint?: string,
  onNull?: (info: { explicitEmpty: boolean }) => void,
): Promise<PlanContent | null> {
  const messages = await assembleMessages(task, agent, { excludePlanContext: true })
  const adapter = await getAdapter(modelId)
  const planModel = await getModel(modelId)
  // v0.17.x：计划生成同样注入 skill 准则，保证计划项与文档驱动开发阶段对齐
  const planSystemPrompt = extraSystemHint
    ? `${systemPrompt}\n\n---\n${extraSystemHint}`
    : systemPrompt
  await emitContextSizeReport({
    taskId: task.id,
    iteration: 0,
    systemPrompt: planSystemPrompt,
    messages,
    tools: undefined,
    contextWindow: planModel?.contextWindow,
  })
  // v0.15.0 Task 5：计划生成同样受 120s 超时保护（用户中止原样抛出，超时抛 LlmTimeoutError）
  const response = await withLlmTimeout(
    (sig) =>
      adapter.complete({
        system: planSystemPrompt,
        messages,
        temperature,
        maxTokens,
        signal: sig,
      }),
    120_000,
    signal,
  )
  const raw = response.thought || response.content
  logger.info('Agent', `plan LLM raw (maxTokens=${maxTokens}): ${safeSlice(String(raw ?? ''), 200)}`)
  // v0.38.1（D168）①：小模型把「最终答案」直接回给 plan prompt —— 实测
  // qwen3.5:0.8b 对 1+1 问答返回 `{"answer":"1+1=2","task_complete":true}`。
  // 语义上与「对话级 → 输出 []」同愿（模型明确表态无步骤可拆），按
  // **显式空计划（Tier 0）**处理：不建清单，答案由 ReAct 正文直接给出。
  // 仅认「可解析 JSON 对象 + task_complete === true」的严格形态（防误判宽松文本）。
  const rawStr = String(raw ?? '').trim()
  if (rawStr.startsWith('{')) {
    const asObj = safeParseJsonObject(rawStr)
    if (asObj && asObj['task_complete'] === true) {
      logger.info('Agent', 'plan LLM returned direct-answer JSON (task_complete=true) — Tier 0, no plan')
      onNull?.({ explicitEmpty: true })
      return null
    }
  }
  const items = parsePlanItems(raw)
  if (!items || items.length === 0) {
    logger.debug('Agent', 'plan parse failed — items empty/null, will fall back')
    // 显式空计划（模型主动回 `[]`，Tier 0）与真实解析失败必须区分：
    // 前者不弹错误态卡片，后者由 generatePlan 在三级全败后上报 degraded。
    onNull?.({ explicitEmpty: /\[\s*\]/.test(String(raw ?? '')) })
    return null
  }
  logger.info('Agent', `plan parsed: ${items.length} items`)
  return {
    goal: safeSlice(task.input.text || '任务计划', 80),
    items: items.slice(0, 12),
    useResources: [],
    skipResources: [],
  }
}

/* ============================================================
 * v0.39.0（W1）：开局规划通道调用。
 *
 * 三条硬约束（缺一即退化成"又多烧一次 token"）：
 *   ① **回落优先于成功**：任何失败都 return null，让既有三级链照常兜底；
 *   ② **不写任何状态**：不落账本、不写 L1、不发事件 —— 只把清单交给调用方，
 *      落库仍由 `run-setup.ts` → `plan-commit-pipeline` 完成（依赖方向铁律）；
 *   ③ **用户中止原样抛出**：与 `tryGeneratePlan` 同口径，否则 Esc 停不下来。
 * ============================================================ */
async function tryPlannerFirstPass(
  task: Task,
  modelId: string,
  signal: AbortSignal,
  extraSystemHint?: string,
): Promise<PlanContent | null> {
  try {
    const plannerModelId = await getPlannerModelId(modelId)
    const req: PlannerRequest = {
      taskId: task.id,
      trigger: 'run-start',
      goal: safeSlice(task.input.text || '任务计划', 120),
      items: [],
      failures: [],
      constraints: extraSystemHint ? [safeSlice(extraSystemHint, 200)] : undefined,
    }
    const res = await runPlannerPass({
      req,
      modelId: plannerModelId,
      signal,
      // 开局放宽到 60s（设计 §6.5）：这是整条 run 唯一一次"慢一点可以接受"的调用，
      // 后面的 W2/W3/W4 重排一律走 20s 预算。
      timeoutMs: 60_000,
    })
    if (!res.ok || res.draft.length === 0) {
      logger.info('Agent', `planner 开局未产出清单（${res.summary}）—— 回落既有计划链`, task.id)
      return null
    }
    const items = res.draft
      .map((d) => String(d.text ?? '').trim())
      .filter((t) => t.length > 0)
      .slice(0, 12)
    if (items.length === 0) return null
    logger.info('Agent', `planner 开局产出 ${items.length} 项（via=${res.via}，${res.attempts} 次）`, task.id)
    return { goal: safeSlice(task.input.text || '任务计划', 80), items, useResources: [], skipResources: [] }
  } catch (err) {
    // 中止必须继续向上抛（否则 Esc 无法中断开局），其余一律回落
    if ((err as Error)?.name === 'AbortError' || signal.aborted) throw err
    logger.warn('Agent', `planner 开局异常（回落既有计划链）：${(err as Error).message}`, task.id)
    return null
  }
}

export async function generatePlan(
  task: Task,
  agent: Agent,
  modelId: string,
  signal: AbortSignal,
  extraSystemHint?: string,
  docDriven?: boolean,
  /**
   * v0.30.0 / P8：三级降级链**全部失败**（且非模型显式空计划）时回调。
   * 由 `run-setup.ts` 据此登记 Plan 闸门的**错误态**（`degraded=true`），
   * 使对话流内联卡 `PlanApprovalCard` 能展示原型 page-08 的 error 态。
   */
  onDegraded?: () => void,
  /**
   * v0.38.1（D170）：模型显式表态「无需清单」（Tier 0）时的回调。
   * 由 `run-setup.ts` 据此把本 run 标记为**对话级**（chatMode）——
   * loop 守卫对对话级任务「答复即终局」，不再走 4 轮停滞暂停。
   */
  onExplicitEmpty?: () => void,
): Promise<PlanContent | null> {
  // ============================================================
  // v0.39.0（W1 · F1）：**规划通道优先**。
  //
  // 这是用户裁决「任务要作为单独的核心交互，单独一次与大模型交互」的落点：
  // 开局这一次计划**不再**由「主对话上下文 + 完整工具列表」的那次调用顺手产出，
  // 而是走一条**独立的、不带工具的、短上下文**的调用 —— 给模型一个只做一件事的
  // 回合（推演该做什么、按什么顺序做），注意力不被工具定义与历史噪声分散。
  //
  // 失败即回落：**任何**异常 / 不可解析 / 超时都 return 到下面的既有三级链，
  // 行为与 v0.38.1 完全一致（这是"不影响正常 LLM"的另一半保证）。
  // ============================================================
  const plannerPlan = await tryPlannerFirstPass(task, modelId, signal, extraSystemHint)
  if (plannerPlan) return plannerPlan

  // v0.17.4：react-core-skills 启用时，用文档驱动开发专用 prompt 替换通用 prompt。
  // v0.17.5：docDriven 由引擎层传入（已通过 getSkill 名称匹配），兜底 isCoreSkillsEnabled
  const useDocDriven = docDriven ?? isCoreSkillsEnabled(task, agent)
  const basePrompt = useDocDriven ? PLAN_SYSTEM_PROMPT_DOC_DRIVEN : PLAN_SYSTEM_PROMPT
  // 只要任一次尝试是「模型显式回空数组」，就按 Tier 0 处理（不弹错误态）——
  // 宁可漏报也不误报：把简单任务误判成"计划生成失败"比漏一次提示更伤体验。
  let sawExplicitEmpty = false
  const onNull = (info: { explicitEmpty: boolean }): void => {
    if (info.explicitEmpty) sawExplicitEmpty = true
  }
  // 首次：完整 Spec/Plan/对话三模式 prompt。v0.9.x 由 maxTokens 400 提升至 1024，
  // 避免 Spec 级 12 步中文计划被截断导致 parsePlanItems 返回 null。
  const plan = await tryGeneratePlan(
    basePrompt,
    1024,
    0.3,
    task,
    agent,
    modelId,
    signal,
    extraSystemHint,
    onNull,
  )
  if (plan) return plan
  // v0.38.1（D169）：模型显式表态「无需清单」（Tier 0：回 `[]` 或 direct-answer JSON）时
  // **立即短路降级链**。此前的 sawExplicitEmpty 只用于免弹 degraded 错误态，重试链照走：
  // 4096 重试与精简「强制 3~5 步」重试都会覆盖模型的 Tier-0 判定——实测 qwen3.5:9b
  // 对「1+1等于几」两次正确回 `[]`，仍被精简 prompt 强扭成 2 项清单后空转（D168 守卫兜底）。
  // 显式空 → 返回 null，由 run-setup 走单项兜底清单（与文档驱动 prompt 的 Tier-0 出口语义一致）。
  if (sawExplicitEmpty) {
    onExplicitEmpty?.()
    return null
  }
  // v0.15.0：思考模型（deepseek-v4-flash 等）可能在 1024 输出预算内只完成思考
  // （finish=length、content 空、plan 解析失败）。此时加大输出预算重试一次；
  // 旧的 512 降级重试对思考模型只会更快耗尽预算，故放在最后兜底。
  const planBig = await tryGeneratePlan(
    basePrompt,
    4096,
    0.3,
    task,
    agent,
    modelId,
    signal,
    extraSystemHint,
    onNull,
  )
  if (planBig) return planBig
  // v0.38.1（D169）：4096 重试才得到显式空时同样短路，不再进精简重试。
  if (sawExplicitEmpty) {
    onExplicitEmpty?.()
    return null
  }
  // 降级重试：精简 3~5 步 prompt + 512 maxTokens + 0.2 temperature
  logger.debug('Agent', 'plan generation first pass failed — retrying with condensed prompt (512 tok, t=0.2)')
  const planSmall = await tryGeneratePlan(
    PLAN_SYSTEM_PROMPT_RETRY,
    512,
    0.2,
    task,
    agent,
    modelId,
    signal,
    extraSystemHint,
    onNull,
  )
  // 三级全败（且非显式空计划）→ 上报 P8 错误态：任务退回扁平清单路径，但让用户看见"为何没有图"。
  if (!planSmall && !sawExplicitEmpty) onDegraded?.()
  return planSmall
}
