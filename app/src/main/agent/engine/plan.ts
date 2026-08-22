/**
 * v0.27.0 R2（§3.1 引擎拆分）：计划生成编排：PLAN_SYSTEM_PROMPT 家族与 tryGeneratePlan/generatePlan
 * 由 engine.ts 纯移动而来（行区间 1859-2048）。
 */

import type { Task, PlanItem } from '@shared/types/task'
import type {
  ReActEvent,
  ReActAction,
  ReActStep,
  PlanContent,
} from '@shared/types/react'
import type { Agent } from '@shared/types/agent'
import { getAdapter, getModel } from '../../llm/registry.js'
import type { LlmMessage, LlmTool, LlmCompleteResponse } from '../../llm/adapter.js'
// agent-context-compaction-robustness：LLM 调用健壮性（120s 超时 / 中止短路 / 重试分级）
import { callLlmWithRetry, withLlmTimeout, isContextOverflowError } from '../llm-call.js'
import { invokeSkill, skillToLlmTool, skillToolName, listSkills, getSkill, type SkillContext } from '../registry.js'
// v0.19.0 M1：系统提示词组装器（收敛 parts.push 硬拼逻辑）
import { buildSystemSections, renderSystemPrompt, buildPersonalitySegment } from '../prompt-assembly.js'
// v0.25.0 F1：提示词契约层（契约注册 + always-on 技能段 + 契约装配 + 门禁状态机）
import { collectAlwaysOnSections, assembleSystemPrompt } from '../prompt/sections.js'
import {
  collectGateSpecs,
  initGateStates,
  checkGateBeforeAdvance,
  confirmGate,
  findGateForStageDoc,
  isDocDrivenAgent,
} from '../prompt/gates.js'
import type { GateSpec } from '@shared/types/agent'
// v0.19.0 M2：唯一真源会话事件日志（Reason/Act/tool 事件落盘 session.jsonl）
import { appendSessionEvent } from '../session-log.js'
// v0.19.0 M3：轮次/步骤收件箱 + 停止候选钩子（turn/step 语义）
import { drainContinuations } from '../inbox.js'
import { emitTurnStopping } from '../turn-stopping.js'
import {
  matchStageGate,
  isCoreSkillsEnabled,
  buildGateBlockObservation,
  describeGateForLog,
  computeAllowedStage,
  matchForbiddenWritePath,
  matchForbiddenShellCommand,
  type StageGate,
} from '../../skills/builtin/react-core-skills/stage-gates.js'
import { appendL1, listEnabledL1, listL1, totalTokens } from '../../memory/l1-working.js'
import { persistRawL2 } from '../../memory/l2-file.js'
import { logger } from '../../system/logger.js'
import { genId } from '@shared/utils/id'
import { isNoisePlanItem } from '@shared/utils/plan-noise'
import { describeAction } from '@shared/utils/action-description'
import { createHash } from 'node:crypto'
import { updateTask, getTask } from '../../store/tasks.js'
import { getAgent } from '../../store/agents.js'
import {
  broadcastStep,
  broadcastTaskStatus,
  broadcastToolProgress,
  clearToolProgress,
  broadcastPlanItemStatus,
  broadcastPlanListSnapshot,
  broadcastTextDelta,
  type ToolProgress,
} from '../events.js'
// v0.27.0 R1：流式管道（completeWithStream 静默降级 + text-delta 增量泵）
import { completeWithStream, createTextDeltaPump, type TextDeltaPump } from '../llm-stream.js'
import { getWorkspaceDir } from '../../store/db.js'
import { saveCheckpoint, checkpointId } from '../../checkpoint/store.js'
// v0.8.0 记忆系统钩子
import { applyPending, getCuratedSnapshot } from '../../memory/l3-curated.js'
import { archiveTaskL1, initArchiveIndex } from '../../memory/l3-archive.js'
import { getProfile, synthesizeFromTaskL1 } from '../../memory/l4-profile.js'
import { evaluateDistillTrigger, autoPromoteDistill, getDistillMetrics } from '../../memory/distill.js'
import { runForSkillForge } from '../../memory/skill-forge.js'
import { compressMemory } from '../../ipc/memory.js'
// v0.15.0：统一压缩路径——自动压缩与 Turn Phase-0 均走两阶段 compact()（联动 L3b + 压缩后蒸馏）
import { compactTask } from '../../memory/compaction.js'
import { createMemoryPhase0 } from '../../memory/compaction-hook.js'
import type { CompressPolicy } from '@shared/types/memory'
// agent-context-compaction-robustness：上下文预算与分层压缩纯工具模块
import {
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
} from '../context.js'
import { getMemoryConfig, getSettings } from '../../ipc/settings.js'
// v0.8.0 知识库钩子
import { listKb, listEnabledKb } from '../../kb/store.js'
import { searchKb, initKbIndex } from '../../kb/index.js'
import { readFile } from 'node:fs/promises'
// Task 6：上下文占比可视化与下钻
import {
  computeContextBreakdown,
  type ContextBreakdownInput,
  type ContextBreakdownResult,
  type ContextToolEntry,
  type ContextSkillInstruction,
} from '../context-breakdown.js'

import { parsePlanItems } from './plan-parser.js'
import { safeSlice, emitProgress } from './broadcast.js'
import { emitContextSizeReport } from './context.js'
import { assembleMessages } from './messages.js'

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
const PLAN_SYSTEM_PROMPT_DOC_DRIVEN = `你是文档驱动开发的任务规划助手。请将用户请求拆解为按文档驱动开发阶段排列的计划清单。

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
  const items = parsePlanItems(raw)
  if (!items || items.length === 0) {
    logger.debug('Agent', 'plan parse failed — items empty/null, will fall back')
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

export async function generatePlan(
  task: Task,
  agent: Agent,
  modelId: string,
  signal: AbortSignal,
  extraSystemHint?: string,
  docDriven?: boolean,
): Promise<PlanContent | null> {
  // v0.17.4：react-core-skills 启用时，用文档驱动开发专用 prompt 替换通用 prompt。
  // v0.17.5：docDriven 由引擎层传入（已通过 getSkill 名称匹配），兜底 isCoreSkillsEnabled
  const useDocDriven = docDriven ?? isCoreSkillsEnabled(task, agent)
  const basePrompt = useDocDriven ? PLAN_SYSTEM_PROMPT_DOC_DRIVEN : PLAN_SYSTEM_PROMPT
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
  )
  if (plan) return plan
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
  )
  if (planBig) return planBig
  // 降级重试：精简 3~5 步 prompt + 512 maxTokens + 0.2 temperature
  logger.debug('Agent', 'plan generation first pass failed — retrying with condensed prompt (512 tok, t=0.2)')
  return tryGeneratePlan(
    PLAN_SYSTEM_PROMPT_RETRY,
    512,
    0.2,
    task,
    agent,
    modelId,
    signal,
    extraSystemHint,
  )
}
