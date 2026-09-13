/**
 * ArkWork — TaskGraph 工具集（9 个）
 *
 * 依据：docs/versions/v0.30.0/04-system-design.md §5.2（tools.ts）
 *       agent-design-v1.0/04-ReAct内核与任务协同.md §8.1
 *
 * 工具设计三原则（抄 Codex 官方，设计稿 §8.2）：
 *  1. **命名要具体** —— `task_update` 而不是 `update`；描述里写清"何时该调、何时不该调"
 *  2. **描述贴近底层语义** —— 让模型处于 in-distribution 状态
 *  3. **schema 校验在调用前** —— 参数缺失/类型错的兜底必须在外层（ReAct 头号踩坑）
 *
 * ★ **反模式警告（设计稿 §8.1 原话）**：不要让模型每步都调 `task_update`。
 *   每步都写 = Manus 的 1/3 动作浪费。所有工具描述里都写明了"语义边界"。
 *
 * 注册方式（最小侵入）：本模块导出规格与 handler，
 * 由 `store/seed.ts`（规格）与 `agent/registry.ts`（handler）各 spread 一次，
 * 不修改那两个文件里既有的任何一行。
 */
import type { Skill } from '@shared/types/agent'
import type { BuiltinHandler } from '../registry.js'
import type {
  AcceptanceCriterion,
  BlockingOption,
  Evidence,
  EvidenceKind,
  NodeLayer,
  NodePriority,
  NodeStatus,
  ReplanEventType,
  ReplanOp,
  TaskGraph,
  TaskNode,
} from '@shared/types/graph'
import { defaultVerification, generateNodeId } from '@shared/types/graph'
import { applyStatusChange } from './gate.js'
import { addEvidence, patchNode, renderAcceptance, updateNodeFields } from './write.js'
import { applyPatch, buildPatch, renderPatchSummary } from './replan.js'
import { getGraph, persist, summarizeGraph, type SyncCtx } from './sync.js'
import { renderGraphErrorForModel } from './invariants.js'
import { recordMetric } from './metrics.js'
import { getPlanApproval, listPendingPatches, registerPendingPatch, registerPlanApproval } from './pending.js'
import { logger } from '../../system/logger.js'

/* ============================================================
 * 一、工具规格（seed.ts 消费）
 * ============================================================ */

/** 任务工具共用的前置说明（避免 9 份描述里重复写同一段） */
const COMMON_PREAMBLE =
  '【何时用】只在**语义边界**上调用（一个子任务真正完成 / 需要改变计划 / 卡住需要人介入时）。' +
  '禁止每步都调用 —— 清单维护动作应控制在总动作的 5% 以内。' +
  '【数据模型】任务是一棵树（goal → milestone → task → step，四层同构），' +
  '节点带验收条件（acceptance）、证据（evidence）、依赖（dependsOn）与溯源（derivedFrom）。'

export const GRAPH_TOOL_SPECS: Skill[] = [
  {
    id: 'S-core.task-create',
    name: 'task_create',
    description:
      `${COMMON_PREAMBLE}\n\n创建一个任务节点（Planner 阶段建图，或 Replan 时追加）。` +
      '必须提供 title、layer、parentId（顶层节点传 null）；强烈建议提供 intent（为什么做）。' +
      '若节点需要机器可验证，请同时提供 acceptance（含 verify.command）。',
    namespace: 'core',
    source: 'builtin',
    builtinHandler: 'task_create',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '节点标题，≤80 字，动宾短语（如"实现 POST /notify 接口"）' },
        layer: {
          type: 'string',
          description: '层级：goal（目标）/ milestone（可独立验收的阶段）/ task（一次会话能完成的单元）/ step（单次工具调用级动作）',
        },
        parent_id: { type: 'string', description: '父节点 id；顶层节点传空字符串或省略' },
        intent: { type: 'string', description: '为什么做（一句话）。不填则必须提供 derived_from，否则违反 I7' },
        description: { type: 'string', description: '做什么（可选）' },
        priority: { type: 'string', description: 'p0 / p1 / p2，默认 p1' },
        depends_on: { type: 'array', items: { type: 'string' }, description: '依赖的节点 id 列表（有向边，不得成环）' },
        derived_from: {
          type: 'array',
          items: { type: 'string' },
          description: '溯源：本条服务的验收条件 id（如 ["AC-02"]）或父节点 id',
        },
        acceptance: {
          type: 'array',
          description:
            '验收条件列表。每条 {id, statement, type, verify:{command, expectExitCode}}。' +
            'type=test/command 时 verify.command 必填 —— 这是"完成由验证结果判定"的物理依据',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'AC-01 形态，同图内唯一' },
              statement: { type: 'string', description: 'WHEN ... THE SYSTEM SHALL ...' },
              type: { type: 'string', description: 'test / command / manual / checklist / invariant' },
              verify_command: { type: 'string', description: '机器可执行的验证命令' },
              expect_exit_code: { type: 'number', description: '期望退出码，默认 0' },
            },
          },
        },
        verification_required: {
          type: 'boolean',
          description:
            '是否需要经过 verifying 态（跑验证命令）才能 completed。默认 false。' +
            '凡是有机器可验证 acceptance 的节点都应设为 true',
        },
        context_refs: {
          type: 'array',
          description: '关键文件/符号指针（只存指针不内联内容）。漂移检测依赖它，声明越准越省事',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', description: 'file / symbol / memory / url / diff / session / rule' },
              ref: { type: 'string', description: '路径 / 符号名 / 记忆 id / URL' },
              note: { type: 'string', description: '为什么相关' },
            },
          },
        },
        token_budget: { type: 'number', description: '该节点允许消耗的 token 上限（可选）' },
      },
      required: ['title', 'layer'],
    },
    timeout: 5_000,
    needsConfirmation: false,
    enabled: true,
    tags: ['control', 'graph'],
  },
  {
    id: 'S-core.task-update',
    name: 'task_update',
    description:
      `${COMMON_PREAMBLE}\n\n更新一个节点的字段或状态。` +
      '【关键语义】把节点标 completed 时：若该节点 verification.required=true，引擎会先把它转为 verifying 并跑验证命令 —— ' +
      '只有验证通过才会变成 completed。**不要试图直接宣称完成**；' +
      '若缺证据，引擎会拒绝并把状态停在 verifying。\n' +
      '【提交证据】用 task_evidence 而不是本工具（本工具不接受 evidence 字段）。',
    namespace: 'core',
    source: 'builtin',
    builtinHandler: 'task_update',
    inputSchema: {
      type: 'object',
      properties: {
        node_id: { type: 'string', description: '目标节点 id（用 task_list 查看）' },
        status: {
          type: 'string',
          description:
            '目标状态：ready / in_progress / verifying / blocked / needs_human / completed / cancelled / failed。' +
            '未完成的节点不要标 completed（会因缺证据被拒）',
        },
        title: { type: 'string', description: '新标题（可选）' },
        notes: { type: 'string', description: '进度笔记（**追加**到已有 notes，不覆盖）' },
        priority: { type: 'string', description: 'p0 / p1 / p2' },
        depends_on: { type: 'array', items: { type: 'string' }, description: '重设依赖（用 relink 语义，慎用）' },
        reason: { type: 'string', description: '为什么改（改状态时建议提供；强制改状态时必须提供）' },
      },
      required: ['node_id'],
    },
    timeout: 5_000,
    needsConfirmation: false,
    enabled: true,
    tags: ['control', 'graph'],
  },
  {
    id: 'S-core.task-get',
    name: 'task_get',
    description:
      `${COMMON_PREAMBLE}\n\n读取单个节点的完整详情（验收条件、证据、依赖、作用域引用、修订次数）。` +
      '当你要确认"这个节点的完成标准到底是什么"时调用它 —— 比 task_list 详细。',
    namespace: 'core',
    source: 'builtin',
    builtinHandler: 'task_get',
    inputSchema: {
      type: 'object',
      properties: {
        node_id: { type: 'string', description: '节点 id' },
      },
      required: ['node_id'],
    },
    timeout: 5_000,
    needsConfirmation: false,
    enabled: true,
    tags: ['control', 'graph'],
  },
  {
    id: 'S-core.task-list',
    name: 'task_list',
    description:
      `${COMMON_PREAMBLE}\n\n读取整棵任务树的快照（含每节点状态/进度/依赖/验收通过情况）。` +
      '注意：引擎**每轮都会自动注入**活跃窗口（当前任务 + 验收条件 + 进度计数），' +
      '所以通常**不需要**主动调用本工具；只有在需要全局视图（如判断先做哪个）时才调。',
    namespace: 'core',
    source: 'builtin',
    builtinHandler: 'task_list',
    inputSchema: {
      type: 'object',
      properties: {
        include_evidence: { type: 'boolean', description: '是否包含证据摘要（默认 false，只列条数）' },
      },
    },
    timeout: 5_000,
    needsConfirmation: false,
    enabled: true,
    tags: ['control', 'graph'],
  },
  {
    id: 'S-core.task-evidence',
    name: 'task_evidence',
    description:
      `${COMMON_PREAMBLE}\n\n给节点附加一条**完成证据**。这是"凭什么说做完了"的留痕。\n` +
      '【可信度分级】human(5) > test(4) > command/lsp(3) > diff/artifact/screenshot(2)。' +
      '**diff 单独不能作为 completed 的充分证据**（它只证明"改了"，不证明"对了"）。' +
      '所以标 completed 前至少要有一条 test 或 command（带 exit_code）证据。',
    namespace: 'core',
    source: 'builtin',
    builtinHandler: 'task_evidence',
    inputSchema: {
      type: 'object',
      properties: {
        node_id: { type: 'string', description: '节点 id' },
        kind: {
          type: 'string',
          description: '证据类型：test（测试通过）/ command（命令结果）/ lsp（诊断）/ diff（代码变更）/ artifact（产物）/ screenshot（截图）/ human（人工确认）',
        },
        summary: { type: 'string', description: '一句话说明（如 "npm test -- auth 12 passed"）' },
        ref: { type: 'string', description: '输出文件路径 / commit sha / 图片路径（可选）' },
        exit_code: { type: 'number', description: '命令退出码（kind=test/command 时强烈建议提供）' },
      },
      required: ['node_id', 'kind', 'summary'],
    },
    timeout: 5_000,
    needsConfirmation: false,
    enabled: true,
    tags: ['control', 'graph'],
  },
  {
    id: 'S-core.task-block',
    name: 'task_block',
    description:
      `${COMMON_PREAMBLE}\n\n把节点转为 needs_human —— 卡住需要人给信息/决策/权限时用。**优先于硬扛或猜**。\n` +
      '必须给出具体问题（question）；能给选项就给（options，每项带代价说明）—— 把开放式问题变成选择题能大幅降低回答成本。\n' +
      '调用后该节点会置顶显示在任务面板（最高视觉优先级），人回答后自动回 ready。',
    namespace: 'core',
    source: 'builtin',
    builtinHandler: 'task_block',
    inputSchema: {
      type: 'object',
      properties: {
        node_id: { type: 'string', description: '节点 id（缺省：当前 in_progress 节点）' },
        question: { type: 'string', description: '需要人回答什么（具体、可回答，不要问"怎么办"）' },
        options: {
          type: 'array',
          description: '可选项（最多 4 个）。每个带 label + description（代价说明）',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: '选项文案（如"停服迁移"）' },
              description: { type: 'string', description: '代价说明（如"最快，约 30 分钟停机"）' },
            },
          },
        },
        timeout_action: { type: 'string', description: '超时后的默认动作：continue（默认，不自动决策）/ skip / cancel' },
      },
      required: ['question'],
    },
    timeout: 5_000,
    needsConfirmation: false,
    enabled: true,
    tags: ['control', 'graph'],
  },
  {
    id: 'S-core.request-plan',
    name: 'request_plan',
    description:
      `${COMMON_PREAMBLE}\n\n请求切换到 Planner 身份（只读探索 + 写计划）—— 当你发现当前任务需要先规划时用。\n` +
      '调用后引擎会弹出确认框征求用户同意；**用户拒绝则整个循环立即停止**（拒绝不是跳过，是中断）。' +
      '不要在只需要 1–2 步的事情上调用它。',
    namespace: 'core',
    source: 'builtin',
    builtinHandler: 'request_plan',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: '为什么需要先规划（说明当前任务的不确定性来自哪里）' },
      },
      required: ['reason'],
    },
    timeout: 5_000,
    needsConfirmation: false,
    enabled: true,
    tags: ['control', 'graph'],
  },
  {
    id: 'S-core.submit-plan',
    name: 'submit_plan',
    description:
      `${COMMON_PREAMBLE}\n\n（Planner 身份专用）提交计划申请用户批准。调用后引擎渲染计划卡，等待用户"批准 / 打回 / 编辑"。\n` +
      '批准后 acceptance 会被冻结（不可再改写，只能新增或标 waived）。',
    namespace: 'core',
    source: 'builtin',
    builtinHandler: 'submit_plan',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '计划摘要（一句话：这些任务做完意味着什么）' },
      },
      required: ['summary'],
    },
    timeout: 5_000,
    needsConfirmation: false,
    enabled: true,
    tags: ['control', 'graph'],
  },
  {
    id: 'S-core.replan',
    name: 'replan',
    description:
      `${COMMON_PREAMBLE}\n\n对任务图应用一组**结构化补丁**（不是"重新生成整个计划"）。` +
      '【必须】说明 reason（为什么改）—— 不可解释的重规划会破坏用户对系统的信任。\n' +
      '【批准级别】仅追加/加边 → 自动应用；invalidate 已完成任务或影响验收 → 需用户批准；改范围 → 需批准且视为 Spec 修订；' +
      '改已批准的验收条件 → **禁止**（必须新增 AC 或标 waived）。',
    namespace: 'core',
    source: 'builtin',
    builtinHandler: 'replan',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: '为什么需要调整（必填）。写清观察到的证据，而不是"计划不合理"' },
        trigger_event: {
          type: 'string',
          description: '触发事件：E1 连续失败 / E2 漂移超限 / E3 发现新依赖 / E4 假设被证伪 / E5 用户插需求 / E6 压缩后 / E7 完成率与验收不匹配 / E8 预算压力 / E9 定时兜底',
        },
        ops: {
          type: 'array',
          description:
            '补丁操作列表（原子事务：全应用或全回滚）。' +
            '每项形如 {op:"add", node:{...}} / {op:"update", id, patch:{...}} / {op:"remove", id, reason} / ' +
            '{op:"relink", id, depends_on:[...]} / {op:"reorder", ids:[...]}',
          items: { type: 'object' },
        },
      },
      required: ['reason', 'ops'],
    },
    timeout: 5_000,
    needsConfirmation: false,
    enabled: true,
    tags: ['control', 'graph'],
  },
]

/* ============================================================
 * 二、handler（registry.ts 消费）
 * ============================================================ */

/** 从 SkillContext 组装 SyncCtx 并取图 */
async function loadCtx(taskId: string, graphId?: string): Promise<{ ctx: SyncCtx; graph: TaskGraph | null }> {
  const ctx: SyncCtx = { taskId, graphId, iteration: 0 }
  const graph = await getGraph(ctx)
  return { ctx, graph }
}

/** 统一的"图不可用"返回 */
function noGraph(): Record<string, unknown> {
  return {
    ok: false,
    error: '当前任务没有任务图（可能是 Tier 0/1 轻量模式，或该任务尚未生成计划）。请在规划阶段先用 task_create 建图。',
  }
}

/** 统一的"写入被拒"返回（结构化错误，模型据此自纠） */
function rejected(err: Parameters<typeof renderGraphErrorForModel>[0]): Record<string, unknown> {
  return { ok: false, rejected: true, error: renderGraphErrorForModel(err) }
}

/** 节点 → 给模型看的紧凑文本 */
function renderNodeBrief(node: TaskNode, includeEvidence = false): string {
  const lines: string[] = []
  lines.push(`${node.key ?? node.id}【${node.status}】${node.title}`)
  if (node.intent) lines.push(`  为什么：${node.intent}`)
  if (node.description) lines.push(`  做什么：${node.description}`)
  if (node.dependsOn.length > 0) lines.push(`  依赖：${node.dependsOn.join(', ')}`)
  if (node.derivedFrom?.length) lines.push(`  溯源：${node.derivedFrom.join(', ')}`)
  if (node.acceptance.length > 0) lines.push(`  验收：\n${indent(renderAcceptance(node.acceptance), '    ')}`)
  if (includeEvidence) {
    lines.push(
      `  证据 ${node.evidence.length} 条：${
        node.evidence.length === 0
          ? '（无）'
          : '\n' + indent(node.evidence.map((e) => `- ${e.kind}: ${e.summary}`).join('\n'), '    ')
      }`,
    )
  } else if (node.evidence.length > 0) {
    lines.push(`  证据：${node.evidence.length} 条`)
  }
  if (node.status === 'needs_human' && node.blockingQuestion) lines.push(`  ❓ 待回答：${node.blockingQuestion}`)
  if (node.lastError) lines.push(`  ⚠ 最近错误：${node.lastError}`)
  if (node.attempts > 0) lines.push(`  尝试：${node.attempts}/${node.verification.maxAttempts}`)
  return lines.join('\n')
}

function indent(text: string, pad: string): string {
  return text
    .split('\n')
    .map((l) => `${pad}${l}`)
    .join('\n')
}

export const GRAPH_TOOL_HANDLERS: Record<string, BuiltinHandler> = {
  /**
   * 创建节点。
   * 副作用：可能落盘（`persist`）+ 广播 `graph_patch`。
   */
  task_create: (async (args: Record<string, unknown>, ctx): Promise<unknown> => {
    const { ctx: sctx, graph } = await loadCtx(ctx.taskId, ctx.task?.graphId)
    if (!graph) return noGraph()

    const title = String(args.title ?? '').trim()
    if (!title) return { ok: false, error: 'title 必填（≤80 字的动宾短语）' }
    const layer = String(args.layer ?? 'task') as NodeLayer
    if (!['goal', 'milestone', 'task', 'step'].includes(layer)) {
      return { ok: false, error: `layer 非法：${layer}（只能是 goal / milestone / task / step）` }
    }
    const parentId = (args.parent_id as string) || null
    if (parentId && !graph.nodes[parentId]) {
      return { ok: false, error: `parent_id 不存在：${parentId}。请先用 task_list 查看现有节点。` }
    }

    const acceptance = parseAcceptance(args.acceptance)
    const required =
      typeof args.verification_required === 'boolean'
        ? (args.verification_required as boolean)
        : acceptance.some((a) => a.verify?.command)

    const node: TaskNode = {
      id: generateNodeId(),
      key: nextKey(graph),
      parentId,
      layer,
      title: title.slice(0, 80),
      intent: (args.intent as string) || undefined,
      description: (args.description as string) || undefined,
      status: 'ready',
      assignee: { kind: 'agent', id: ctx.agent?.id ?? 'agent' },
      priority: ((args.priority as NodePriority) ?? 'p1') as NodePriority,
      children: [],
      dependsOn: (args.depends_on as string[]) ?? [],
      derivedFrom: (args.derived_from as string[]) ?? ['manual:agent'],
      acceptance,
      evidence: [],
      verification: defaultVerification({ required, command: acceptance[0]?.verify?.command }),
      contextRefs: parseContextRefs(args.context_refs),
      tokenBudget: typeof args.token_budget === 'number' ? (args.token_budget as number) : undefined,
      tokensUsed: 0,
      attempts: 0,
      sessionIds: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      revision: 1,
    }

    const op: ReplanOp = { op: 'add', node }
    // 建图工具走 Replan 通道（即使单条 add 也走）—— 保证"所有图变更都有审计"这一条不被绕过
    const built = buildPatch(graph, {
      triggerEvent: 'E3',
      reason: `task_create：新增 ${node.key ?? ''} ${node.title}`,
      ops: [op],
      by: { kind: 'agent', id: ctx.agent?.id ?? 'agent' },
    })
    if (!built.patch) return rejected(built.error!)
    const res = applyPatch(graph, built.patch, true)
    if (res.error) return rejected(res.error)
    const saved = await persist(sctx, res.graph, { changes: res.changes, source: 'task_create', reason: built.patch.reason })
    recordMetric('sync_action', { op: 'create' })
    return {
      ok: true,
      node_id: node.id,
      key: node.key,
      status: 'created',
      text: `已创建 ${node.key ?? node.id}「${node.title}」（${layer}）。当前图：${JSON.stringify(summarizeGraph(saved).counts)}`,
    }
  }) as BuiltinHandler,

  /**
   * 更新节点字段/状态。状态变更走 `applyStatusChange`（含 I1–I7 门禁与 I2 降级）。
   */
  task_update: (async (args: Record<string, unknown>, ctx): Promise<unknown> => {
    const { ctx: sctx, graph } = await loadCtx(ctx.taskId, ctx.task?.graphId)
    if (!graph) return noGraph()
    const nodeId = String(args.node_id ?? '')
    const node = graph.nodes[nodeId]
    if (!node) return { ok: false, error: `节点不存在：${nodeId}。请先用 task_list 查看。` }

    let work = graph
    // 1) 非状态字段
    const patch: Partial<TaskNode> = {}
    if (typeof args.title === 'string') patch.title = (args.title as string).slice(0, 80)
    if (args.priority) patch.priority = args.priority as NodePriority
    if (typeof args.notes === 'string') {
      patch.notes = [node.notes, args.notes as string].filter(Boolean).join('\n')
    }
    if (Array.isArray(args.depends_on)) patch.dependsOn = args.depends_on as string[]
    if (Object.keys(patch).length > 0) work = updateNodeFields(work, nodeId, patch)

    // 2) 状态（单独走门禁）
    let downgraded = false
    if (typeof args.status === 'string') {
      const to = args.status as NodeStatus
      const res = applyStatusChange(work, nodeId, to, 'task-update', graph)
      if (res.error) return rejected(res.error)
      work = res.graph
      downgraded = !!res.downgraded
    }

    const saved = await persist(sctx, work, {
      changes: [{ nodeId, from: node.status, to: work.nodes[nodeId].status, source: 'task-update', reason: args.reason as string | undefined }],
      source: 'task_update',
      reason: args.reason as string | undefined,
    })
    recordMetric('sync_action', { op: 'update' })

    const after = saved.nodes[nodeId]
    return {
      ok: true,
      downgraded,
      status: after.status,
      text:
        `已更新 ${after.key ?? nodeId}。当前状态：${after.status}` +
        (downgraded
          ? '\n⚠ 你的"完成"宣称被降级为 verifying：该节点没有充分证据（至少需要一条 test 或 command 证据）。请先跑验证命令并用 task_evidence 提交结果。'
          : ''),
    }
  }) as BuiltinHandler,

  /** 读取单节点详情（只读，无副作用） */
  task_get: (async (args: Record<string, unknown>, ctx): Promise<unknown> => {
    const { graph } = await loadCtx(ctx.taskId, ctx.task?.graphId)
    if (!graph) return noGraph()
    const node = graph.nodes[String(args.node_id ?? '')]
    if (!node) return { ok: false, error: `节点不存在：${String(args.node_id)}` }
    return { ok: true, node_id: node.id, text: renderNodeBrief(node, true) }
  }) as BuiltinHandler,

  /** 读取整树快照（只读） */
  task_list: (async (args: Record<string, unknown>, ctx): Promise<unknown> => {
    const { graph } = await loadCtx(ctx.taskId, ctx.task?.graphId)
    if (!graph) return noGraph()
    const includeEvidence = args.include_evidence === true
    const lines: string[] = [`目标：${graph.goal}`, `复杂度：T${graph.policy.tier} · Spec：${graph.spec.state}`, '']
    const visit = (id: string, depth: number): void => {
      const n = graph.nodes[id]
      if (!n) return
      if (depth > 0) lines.push(indent(renderNodeBrief(n, includeEvidence), '  '.repeat(depth)))
      else lines.push(renderNodeBrief(n, includeEvidence))
      for (const c of n.children) visit(c, depth + 1)
    }
    for (const r of graph.rootIds) visit(r, 0)
    const s = summarizeGraph(graph)
    lines.push('', `统计：${JSON.stringify(s.counts)} · 累计 ${s.tokensUsed} tokens`)
    return { ok: true, text: lines.join('\n'), counts: s.counts, graphRevision: graph.graphRevision }
  }) as BuiltinHandler,

  /** 追加证据（只读图结构，只改 evidence） */
  task_evidence: (async (args: Record<string, unknown>, ctx): Promise<unknown> => {
    const { ctx: sctx, graph } = await loadCtx(ctx.taskId, ctx.task?.graphId)
    if (!graph) return noGraph()
    const nodeId = String(args.node_id ?? '')
    if (!graph.nodes[nodeId]) return { ok: false, error: `节点不存在：${nodeId}` }
    const kind = String(args.kind ?? 'command') as EvidenceKind
    const allowed: EvidenceKind[] = ['test', 'command', 'diff', 'screenshot', 'human', 'artifact', 'lsp']
    if (!allowed.includes(kind)) {
      return { ok: false, error: `kind 非法：${kind}。合法值：${allowed.join(' / ')}` }
    }
    const summary = String(args.summary ?? '').trim()
    if (!summary) return { ok: false, error: 'summary 必填（一句话说明这条证据证明了什么）' }

    const evidence: Evidence = {
      kind,
      summary: summary.slice(0, 200),
      ref: typeof args.ref === 'string' ? (args.ref as string) : undefined,
      exitCode: typeof args.exit_code === 'number' ? (args.exit_code as number) : undefined,
      at: Date.now(),
      by: { kind: 'agent', id: ctx.agent?.id ?? 'agent' },
    }
    const work = addEvidence(graph, nodeId, evidence)
    const saved = await persist(sctx, work, {
      changes: [{ nodeId, source: 'task_evidence', reason: `追加 ${kind} 证据` }],
      source: 'task_evidence',
    })
    recordMetric('sync_action', { op: 'evidence' })
    const n = saved.nodes[nodeId]
    return {
      ok: true,
      evidenceCount: n.evidence.length,
      text: `已为 ${n.key ?? nodeId} 追加 ${kind} 证据（共 ${n.evidence.length} 条）。${
        kind === 'diff' ? '注意：diff 不能单独作为 completed 的充分证据，请补一条 test 或 command。' : ''
      }`,
    }
  }) as BuiltinHandler,

  /** 转为 needs_human（I6 会强制要求 blockingQuestion） */
  task_block: (async (args: Record<string, unknown>, ctx): Promise<unknown> => {
    const { ctx: sctx, graph } = await loadCtx(ctx.taskId, ctx.task?.graphId)
    if (!graph) return noGraph()
    const question = String(args.question ?? '').trim()
    if (!question) {
      return {
        ok: false,
        error: 'blockingQuestion 必填 —— 请写清"需要人回答什么"。若你其实不需要人介入，请改回 ready 继续执行。',
      }
    }
    const nodeId = (args.node_id as string) || pickRunningId(graph)
    if (!nodeId || !graph.nodes[nodeId]) {
      return { ok: false, error: '找不到目标节点（无 in_progress 节点，请显式提供 node_id）' }
    }
    const options = parseOptions(args.options)

    // 先写 blocking 字段（I6 要求 question + since 同时存在）
    let work = patchNode(graph, nodeId, (n) => ({
      ...n,
      blockingQuestion: question,
      blockingOptions: options.length > 0 ? options : undefined,
      blockingSince: Date.now(),
      timeoutAction: (args.timeout_action as 'continue' | 'skip' | 'cancel') ?? 'continue',
    }))
    const res = applyStatusChange(work, nodeId, 'needs_human', 'task-block', graph)
    if (res.error) return rejected(res.error)
    work = res.graph
    const saved = await persist(sctx, work, {
      changes: [{ nodeId, from: graph.nodes[nodeId].status, to: 'needs_human', source: 'task-block', reason: question }],
      source: 'task_block',
    })
    const n = saved.nodes[nodeId]
    // 广播置顶卡片事件
    const { broadcastReActEvent } = await import('../events.js')
    broadcastReActEvent({
      type: 'graph_needs_human',
      taskId: ctx.taskId,
      graphId: saved.id,
      nodeId,
      question,
      options,
      since: n.blockingSince ?? Date.now(),
    })
    recordMetric('sync_action', { op: 'block' })
    return {
      ok: true,
      node_id: nodeId,
      text: `已把 ${n.key ?? nodeId} 转为 needs_human 并在任务面板置顶。问题已交给用户，等待回答后该节点会自动回到 ready —— 你可以先去推进其它 ready 节点。`,
    }
  }) as BuiltinHandler,

  /** 请求切换到 Planner 身份（引擎负责弹确认框） */
  request_plan: (async (args: Record<string, unknown>, ctx): Promise<unknown> => {
    const reason = String(args.reason ?? '').trim()
    if (!reason) return { ok: false, error: 'reason 必填（说明当前任务的不确定性来自哪里）' }
    // P8：登记「正在生成」闸门瞬时态 —— 对话流内联卡 PlanApprovalCard 先显示 loading 态
    registerPlanApproval({
      taskId: ctx.taskId,
      graphId: ctx.task?.graphId,
      state: 'generating',
      proposedAt: getPlanApproval(ctx.taskId)?.proposedAt ?? Date.now(),
      uncovered: [],
    })
    const { broadcastReActEvent } = await import('../events.js')
    broadcastReActEvent({
      type: 'graph_plan_gate',
      taskId: ctx.taskId,
      graphId: ctx.task?.graphId ?? '',
      plan: getPlanApproval(ctx.taskId)!,
    })
    recordMetric('sync_action', { op: 'plan-requested' })
    // 实际的身份切换由 engine 在 act 收尾时处理（需要用户确认 + 注入 synthetic message）
    return {
      ok: true,
      requested: true,
      reason,
      text: `已向用户申请切换到 Planner 身份（理由：${reason}）。等待用户确认；若用户拒绝，本轮循环会立即停止。`,
    }
  }) as BuiltinHandler,

  /** 提交计划申请批准（Planner 身份） */
  submit_plan: (async (args: Record<string, unknown>, ctx): Promise<unknown> => {
    const { graph } = await loadCtx(ctx.taskId, ctx.task?.graphId)
    if (!graph) return noGraph()
    const summary = String(args.summary ?? '').trim()
    // 覆盖率检查（设计稿 §5.1：每条 AC 必须被至少一个节点覆盖，否则 Spec 不能 approved）
    const uncovered = graph.spec.acceptance.filter((ac) => ac.coveredBy.length === 0)
    if (uncovered.length > 0) {
      return {
        ok: false,
        rejected: true,
        error:
          `计划未被接受：有 ${uncovered.length} 条验收条件没有任务覆盖 —— ${uncovered.map((a) => a.id).join(', ')}。\n` +
          `请先为它们建立任务节点（用 derived_from 指回对应 AC），再重新提交。理由：没有节点覆盖的验收条件永远不会被执行，等于没有验收。`,
      }
    }
    // P8：登记「等待批准」闸门态 —— 让对话流内联卡 PlanApprovalCard 从 loading 变为可操作
    registerPlanApproval({
      taskId: ctx.taskId,
      graphId: graph.id,
      state: 'pending',
      proposedAt: getPlanApproval(ctx.taskId)?.proposedAt ?? Date.now(),
      uncovered: [],
    })
    const { broadcastReActEvent } = await import('../events.js')
    broadcastReActEvent({
      type: 'graph_plan_gate',
      taskId: ctx.taskId,
      graphId: graph.id,
      plan: getPlanApproval(ctx.taskId)!,
    })
    recordMetric('sync_action', { op: 'plan-submitted' })
    // 实际的身份保持/切换由 engine 在 act 收尾时处理（用户批准后才冻结 acceptance）
    return {
      ok: true,
      submitted: true,
      summary,
      text: '计划已提交，等待用户批准（批准后验收条件会被冻结，之后不可再改写）。',
    }
  }) as BuiltinHandler,

  /** 提交 Replan 补丁 */
  replan: (async (args: Record<string, unknown>, ctx): Promise<unknown> => {
    const { ctx: sctx, graph } = await loadCtx(ctx.taskId, ctx.task?.graphId)
    if (!graph) return noGraph()

    const ops = parseOps(args.ops)
    if (ops.length === 0) return { ok: false, error: 'ops 不能为空' }
    const trigger = (String(args.trigger_event ?? 'E3') as ReplanEventType) ?? 'E3'

    const built = buildPatch(graph, {
      triggerEvent: trigger,
      reason: String(args.reason ?? ''),
      ops,
      by: { kind: 'agent', id: ctx.agent?.id ?? 'agent' },
    })
    if (!built.patch) return rejected(built.error!)
    const patch = built.patch

    // 第 4 级：禁止
    if (patch.approvalLevel === 4) {
      return {
        ok: false,
        rejected: true,
        error:
          '该变更被禁止：修改已批准的验收条件需要走 Spec 修订流程（新增 AC 或把原 AC 标 waived），不能原地改写。\n' +
          '理由：如果 Agent 能修改自己的成功标准，它就会通过弱化标准来"通过"测试。',
      }
    }

    // 第 1 级：自动应用
    if (patch.approvalLevel === 1) {
      const res = applyPatch(graph, patch, true)
      if (res.error) return rejected(res.error)
      const saved = await persist(sctx, res.graph, { changes: res.changes, source: 'replan', reason: patch.reason })
      recordMetric('sync_action', { op: 'replan-auto' })
      const sum = renderPatchSummary(graph, patch)
      return {
        ok: true,
        applied: true,
        patchId: patch.id,
        text:
          `补丁已自动应用（第 1 级：仅追加/加边，不影响已完成工作）。\n` +
          `改了什么：${sum.changes.map((c) => `${c.op} ${c.text}`).join('；')}\n` +
          `代价：预计 +${sum.cost.extraTokens} tokens`,
      }
    }

    // 第 2/3 级：等用户批准
    // ★ v0.30.1 问题②：必须先把补丁登记进待决注册表并广播，
    //   否则前端拿不到待批准项、`graph:decide-replan` 会因 getPendingPatch 落空返回 NOT_FOUND。
    //   registerPendingPatch 内部按 patch.id 去重（同一补丁重复提交不会堆叠）。
    const before = listPendingPatches(graph.id).filter((p) => p.state === 'pending').length
    registerPendingPatch(graph.id, patch)
    const after = listPendingPatches(graph.id).filter((p) => p.state === 'pending').length
    if (after > before) {
      const { broadcastReActEvent } = await import('../events.js')
      broadcastReActEvent({
        type: 'graph_replan_proposed',
        taskId: ctx.taskId,
        graphId: graph.id,
        patch,
      })
    }
    recordMetric('sync_action', { op: 'replan-pending' })
    const sum = renderPatchSummary(graph, patch)
    return {
      ok: true,
      pending: true,
      patchId: patch.id,
      approvalLevel: patch.approvalLevel,
      impact: patch.impact,
      text:
        `补丁已生成，**等待用户批准**（第 ${patch.approvalLevel} 级：${sum.approvalLabel}）。\n` +
        `为什么：${sum.reason}\n` +
        `改了什么：${sum.changes.map((c) => `${c.op} ${c.text}`).join('；')}\n` +
        `代价：影响已完成任务 ${sum.cost.invalidated.length} 项${sum.cost.invalidated.length ? `（${sum.cost.invalidated.join(', ')}）` : ''} · ` +
        `影响验收 ${sum.cost.affectedACs.join(', ') || '无'} · 预计 +${sum.cost.extraTokens} tokens\n` +
        `请先继续别的工作，用户确认后本补丁会自动应用；不要重复提交同一补丁。`,
    }
  }) as BuiltinHandler,
}

/* ============================================================
 * 三、参数解析（schema 兜底 —— ReAct 的头号踩坑是幻觉 Action）
 * ============================================================ */

function parseAcceptance(raw: unknown): AcceptanceCriterion[] {
  if (!Array.isArray(raw)) return []
  const out: AcceptanceCriterion[] = []
  for (const [i, item] of raw.entries()) {
    const o = item as Record<string, unknown>
    const statement = String(o?.statement ?? '').trim()
    if (!statement) continue
    const type = (String(o?.type ?? 'command') as AcceptanceCriterion['type']) ?? 'command'
    const cmd = typeof o?.verify_command === 'string' ? (o.verify_command as string) : undefined
    out.push({
      id: String(o?.id ?? `AC-${String(i + 1).padStart(2, '0')}`),
      statement: statement.slice(0, 400),
      type,
      verify: cmd
        ? { command: cmd, expectExitCode: typeof o?.expect_exit_code === 'number' ? (o.expect_exit_code as number) : 0 }
        : undefined,
      status: 'pending',
      coveredBy: [],
    })
  }
  return out
}

function parseContextRefs(raw: unknown): TaskNode['contextRefs'] {
  if (!Array.isArray(raw)) return []
  const out: TaskNode['contextRefs'] = []
  for (const item of raw) {
    const o = item as Record<string, unknown>
    const kind = String(o?.kind ?? 'file') as TaskNode['contextRefs'][number]['kind']
    const ref = String(o?.ref ?? '').trim()
    if (!ref) continue
    out.push({ kind, ref, note: typeof o?.note === 'string' ? (o.note as string) : undefined })
  }
  return out
}

function parseOptions(raw: unknown): BlockingOption[] {
  if (!Array.isArray(raw)) return []
  return raw
    .slice(0, 4)
    .map((item) => {
      const o = item as Record<string, unknown>
      return {
        label: String(o?.label ?? '').trim(),
        description: typeof o?.description === 'string' ? (o.description as string) : undefined,
      }
    })
    .filter((o) => o.label.length > 0)
}

/** 解析 Replan ops；非法项被丢弃并记日志（不因一个坏项废掉整个补丁） */
function parseOps(raw: unknown): ReplanOp[] {
  if (!Array.isArray(raw)) return []
  const out: ReplanOp[] = []
  for (const item of raw) {
    const o = item as Record<string, unknown>
    const op = String(o?.op ?? '')
    try {
      switch (op) {
        case 'add': {
          const n = (o.node ?? {}) as Record<string, unknown>
          if (!n.title) break
          out.push({
            op: 'add',
            after: typeof o.after === 'string' ? (o.after as string) : undefined,
            node: {
              id: generateNodeId(),
              key: undefined,
              parentId: (n.parent_id as string) || null,
              layer: ((n.layer as NodeLayer) ?? 'task') as NodeLayer,
              title: String(n.title).slice(0, 80),
              intent: (n.intent as string) || undefined,
              description: (n.description as string) || undefined,
              status: 'ready',
              assignee: { kind: 'agent', id: 'agent' },
              priority: ((n.priority as NodePriority) ?? 'p1') as NodePriority,
              children: [],
              dependsOn: (n.depends_on as string[]) ?? [],
              derivedFrom: (n.derived_from as string[]) ?? ['replan'],
              acceptance: parseAcceptance(n.acceptance),
              evidence: [],
              verification: defaultVerification({
                required: n.verification_required === true,
              }),
              contextRefs: parseContextRefs(n.context_refs),
              tokensUsed: 0,
              attempts: 0,
              sessionIds: [],
              createdAt: Date.now(),
              updatedAt: Date.now(),
              revision: 1,
            },
          })
          break
        }
        case 'remove':
          out.push({ op: 'remove', id: String(o.id ?? ''), reason: String(o.reason ?? '重规划删除') })
          break
        case 'update':
          out.push({ op: 'update', id: String(o.id ?? ''), patch: (o.patch ?? {}) as Partial<TaskNode> })
          break
        case 'relink':
          out.push({ op: 'relink', id: String(o.id ?? ''), dependsOn: (o.depends_on as string[]) ?? [] })
          break
        case 'reorder':
          out.push({ op: 'reorder', ids: (o.ids as string[]) ?? [] })
          break
        default:
          logger.warn('Agent', `replan: 未知 op "${op}"，已忽略`)
      }
    } catch (err) {
      logger.warn('Agent', `replan: op 解析失败（已忽略）：${(err as Error).message}`)
    }
  }
  return out.filter((op) => (op.op === 'add' ? true : 'id' in op ? !!op.id : true))
}

/** 生成下一个人类可读 key（T-01…） */
function nextKey(graph: TaskGraph): string {
  let max = 0
  for (const node of Object.values(graph.nodes)) {
    const m = /^T-(\d+)$/.exec(node.key ?? '')
    if (m) max = Math.max(max, Number(m[1]))
    const g = /^G-(\d+)$/.exec(node.key ?? '')
    if (g) max = Math.max(max, Number(g[1]))
  }
  return `T-${String(max + 1).padStart(2, '0')}`
}

function pickRunningId(graph: TaskGraph): string | undefined {
  return Object.values(graph.nodes).find((n) => n.status === 'in_progress')?.id
}

/**
 * 工具名 → 是否需要 graph 上下文（供 registry 判定"轻量模式下应隐藏这些工具"）。
 *
 * `policy.builtinTaskListEnabled === false` 时（接入外部任务系统），
 * 引擎会把这些工具从工具集移除（设计稿 §8.2 / A4 准则）。
 */
export const GRAPH_TOOL_NAMES: readonly string[] = GRAPH_TOOL_SPECS.map((s) => s.name!)

/** 允许关闭的图工具（task_* 系列；request_plan/submit_plan 属身份协议，不可关闭） */
export const DISABLEABLE_GRAPH_TOOLS: readonly string[] = [
  'task_create',
  'task_update',
  'task_get',
  'task_list',
  'task_evidence',
  'task_block',
  'replan',
]
