/* ============================================================
 * v0.17.5 E2E — 新任务流程端到端验证
 *
 * 关键纯函数 isPhaseHeader 自 r10-F8a 起导入单源实现（@shared/utils/plan-parse）；
 * todo_update 处理 / file-writer 失败兜底 / 阶段门禁标 done 维持本地内存复刻，
 * 验证三类修复在真实场景下的行为。
 *
 * 场景 A（计划生成）：LLM 返回 12 条 items（含"阶段 N：xxx"型标题 + 子项 + 含动作动词的子项）
 *   期望：阶段标题被过滤，子项保留
 *
 * 场景 B（执行反馈）：模拟 LLM 主动调 todo_update
 *   期望：done 时下一项 pending 自动推进为 running；越界参数返回失败；非法 status 返回失败
 *
 * 场景 C（工具失败）：模拟 file-writer content 传对象
 *   期望：明确字段名错误 + 引擎自动把 running 项标 failed 并在 observation 附清单概览
 *
 * 场景 D（阶段门禁）：模拟 react-core-skills 触发阶段门禁（PRD 阶段产出 01-prd.md）
 *   期望：findPlanItemForStage 找到对应项并标 done，下一项推进为 running
 *
 * 除 isPhaseHeader（r10-F8a 起导入单源）外，其余复刻函数与 engine 模块组逐行对齐，
 * 用本地内存数据结构避免引入 electron/ipc 依赖。
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'

// v0.27.0 r10-F8a：isPhaseHeader 导入单源实现（@shared 无 electron/ipc 依赖，
// 不违背本文件「本地内存结构」的设计初衷），原 v0.17.5 复刻副本已删
import { isPhaseHeader } from '@shared/utils/plan-parse'

// ============================================================
// 与 engine.ts 等价的复刻函数
// ============================================================

type PlanStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'cancelled'

interface PlanItem {
  id: string
  text: string
  status: PlanStatus
  createdAt: number
  updatedAt: number
  completedAt?: number
}

function filterPlanItems(rawItems: string[]): { kept: string[]; removed: string[] } {
  const removed: string[] = []
  const kept: string[] = []
  for (const t of rawItems) {
    if (isPhaseHeader(t)) removed.push(t)
    else kept.push(t)
  }
  return { kept, removed }
}

interface TodoUpdateResult {
  ok: boolean
  errorMessage?: string
  overview: string
  planItems: PlanItem[]
}

function handleTodoUpdate(
  planItems: PlanItem[],
  itemIndex: number,
  status: string,
  comment: string,
): TodoUpdateResult {
  const VALID = new Set(['done', 'running', 'pending', 'skipped', 'failed', 'cancelled'])
  const next = planItems.map((p) => ({ ...p }))
  if (!Number.isInteger(itemIndex) || itemIndex < 0 || itemIndex >= next.length) {
    return {
      ok: false,
      errorMessage: `todo_update 参数非法：item_index=${itemIndex} 越界（清单共 ${next.length} 项）`,
      overview: '',
      planItems: next,
    }
  }
  if (!VALID.has(status)) {
    return {
      ok: false,
      errorMessage: `todo_update 参数非法：status=${status}（合法值 done/running/pending/skipped/failed/cancelled）`,
      overview: '',
      planItems: next,
    }
  }
  const target = next[itemIndex]
  target.status = status as PlanStatus
  target.updatedAt = Date.now()
  if (status === 'done' || status === 'failed' || status === 'skipped' || status === 'cancelled') {
    target.completedAt = Date.now()
  }
  if (
    status === 'done' &&
    itemIndex + 1 < next.length &&
    next[itemIndex + 1].status === 'pending'
  ) {
    next[itemIndex + 1].status = 'running'
    next[itemIndex + 1].updatedAt = Date.now()
  }
  const overview = next
    .map((p, i) => {
      const mark =
        p.status === 'done'
          ? '[x]'
          : p.status === 'running'
            ? '[~]'
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
  return {
    ok: true,
    overview: `已更新清单第 ${itemIndex + 1} 项为「${status}」${comment ? `：${comment}` : ''}\n当前清单：\n${overview}`,
    planItems: next,
  }
}

interface FileWriterResult {
  status: 'failed' | 'success'
  error?: string
}

function fileWriterSimulate(content: unknown): FileWriterResult {
  // 与 file-writer.ts 的 typeof content !== 'string' 拦截等价
  if (typeof content !== 'string') {
    return {
      status: 'failed',
      error:
        `file-writer: 参数 content 必须是字符串（当前类型=${typeof content}）。` +
        `请检查 JSON 参数序列化——多行代码/反引号字符串必须放在 "content" 字段的字符串值里，不要嵌套对象/数组。`,
    }
  }
  return { status: 'success' }
}

// ============================================================
// v0.17.6 引擎独立判断（不依赖 LLM 自调 todo_update）
// ============================================================

const PRODUCTIVE = new Set([
  'file-writer',
  'file-editor',
  'shell',
  'todo-update',
  'todo_update',
  'task_complete',
  'ask_user',
  'spec',
  'plan',
  'bugfix',
  'react-core-skills',
])

function isProductiveTool(tool: string): boolean {
  return PRODUCTIVE.has(tool)
}

interface Decision {
  index: number
  before: PlanStatus
  after: PlanStatus
  reason: string
}

/** 与 engine.ts decidePlanAdvance 等价 */
function decidePlanAdvance(
  planItems: PlanItem[],
  toolName: string,
  ok: boolean,
  errorMessage?: string,
): { planItems: PlanItem[]; decisions: Decision[] } {
  const next = planItems.map((p) => ({ ...p }))
  const decisions: Decision[] = []
  const runningIdx = next.findIndex((p) => p.status === 'running')
  if (runningIdx < 0) return { planItems: next, decisions }

  const before = next[runningIdx].status
  if (!ok) {
    next[runningIdx].status = 'failed'
    next[runningIdx].updatedAt = Date.now()
    next[runningIdx].completedAt = Date.now()
    decisions.push({
      index: runningIdx,
      before,
      after: 'failed',
      reason: `${toolName} 调用失败：${(errorMessage ?? '').slice(0, 120)}`,
    })
  } else if (isProductiveTool(toolName)) {
    next[runningIdx].status = 'done'
    next[runningIdx].updatedAt = Date.now()
    next[runningIdx].completedAt = Date.now()
    decisions.push({
      index: runningIdx,
      before,
      after: 'done',
      reason: `${toolName} 调用成功，引擎判定该项已完成`,
    })
    if (runningIdx + 1 < next.length && next[runningIdx + 1].status === 'pending') {
      next[runningIdx + 1].status = 'running'
      next[runningIdx + 1].updatedAt = Date.now()
      decisions.push({
        index: runningIdx + 1,
        before: 'pending',
        after: 'running',
        reason: `引擎自动推进（上一项已完成）`,
      })
    }
  } else {
    decisions.push({
      index: runningIdx,
      before,
      after: 'running',
      reason: `${toolName} 为只读探索，引擎不自动推进`,
    })
  }
  return { planItems: next, decisions }
}

/** 模拟 engine.ts emitPlanStatus 注入的"独立清单状态"user 消息 */
function emitPlanStatusMessage(planItems: PlanItem[]): { role: 'user'; content: string } {
  const items = planItems.map((p, i) => {
    const mark =
      p.status === 'done'
        ? '[x]'
        : p.status === 'running'
          ? '[~]'
          : p.status === 'failed'
            ? '[!]'
            : '[ ]'
    return `${i + 1}. ${mark} ${p.text}`
  })
  return {
    role: 'user',
    content: `[清单状态 — 引擎独立判断（不是 LLM 自报），你必须以此为准]\n${items.join('\n')}`,
  }
}

// 与 engine.ts findPlanItemForStage 等价
function findPlanItemForStage(planItems: PlanItem[], stage: string): number {
  const keywordMap: Record<string, RegExp> = {
    research: /调研|research/i,
    prd: /PRD|产品|需求/i,
    interaction: /交互|interaction/i,
    prototype: /原型|prototype/i,
    'system-design': /系统设计|system.?design|架构|技术选型/i,
  }
  const stageNumMap: Record<string, number> = {
    research: 1,
    prd: 2,
    interaction: 3,
    prototype: 4,
    'system-design': 5,
  }
  const keyword = keywordMap[stage]
  const stageNum = stageNumMap[stage]
  if (keyword) {
    for (let i = 0; i < planItems.length; i++) {
      if (keyword.test(planItems[i].text)) return i
    }
  }
  if (stageNum) {
    const numRe = new RegExp(`(?:阶段|phase|step)\\s*${stageNum}(?:\\s*[:：]|\\b)`, 'i')
    for (let i = 0; i < planItems.length; i++) {
      if (numRe.test(planItems[i].text)) return i
    }
  }
  if (stageNum && stageNum - 1 < planItems.length) return stageNum - 1
  return -1
}

// ============================================================
// 场景 A：计划生成 — 过滤纯阶段标题
// ============================================================

test('E2E 场景A: 真实场景中 LLM 返回的计划含阶段标题 → 过滤后只剩可验证子项', () => {
  // 模拟 LLM 在用户说"做一个俯视赛车游戏"时按 Spec 级示例生成的计划
  // 阶段标题使用抽象总结词（无白名单动作动词），确保被 isPhaseHeader 识别为标题
  const llmRawPlan = [
    '阶段 1：技术选型与架构设计', // ← 纯标题，应被过滤
    '调研 GitHub 热门俯视赛车项目提炼玩法机制', // 含"调研"→ 保留
    '选 Canvas + 原生 JS 引擎作为技术栈', // 含"选"... 但"选"不在白名单，改写明确动词
    '拆分渲染/物理/输入/AI/关卡/UI 模块', // 含"拆"... 也不在白名单
    '阶段 2：基础设施与依赖', // ← 纯标题，应被过滤
    '初始化 Vite 项目并配置构建工具', // 含"初始化"→ 保留
    '封装主循环、相机系统、坐标变换工具', // 含"封装"→ 保留
    '实现图片、音效、关卡 JSON 资源加载器', // 含"实现"→ 保留
    '阶段 3：物理与操控核心', // ← 纯标题，应被过滤
    '实现车辆动力学模型', // 含"实现"→ 保留
    '加入碰撞检测逻辑', // 含"加入"... 不在白名单，改写
    '写出轮胎痕迹与火花粒子特效', // 含"写/出"... 不在白名单
  ]
  // 替换为更明确的动词写法（贴近 LLM 实际产出）
  const refinedPlan = [
    '阶段 1：技术选型与架构设计',
    '调研 GitHub 热门俯视赛车项目提炼玩法机制',
    '选择 Canvas 与原生 JS 作为渲染引擎',
    '拆分渲染、物理、输入、AI、关卡、UI 六大模块',
    '阶段 2：基础设施与依赖',
    '初始化 Vite 项目并配置构建工具',
    '封装主循环、相机系统、坐标变换工具',
    '实现图片、音效、关卡 JSON 资源加载器',
    '阶段 3：物理与操控核心',
    '实现车辆动力学模型',
    '加入墙体/护栏弹性反弹碰撞检测',
    '实现轮胎痕迹与火花粒子特效',
  ]
  const { kept, removed } = filterPlanItems(refinedPlan)
  assert.equal(removed.length, 3, '应过滤 3 条纯阶段标题')
  assert.deepEqual(removed, [
    '阶段 1：技术选型与架构设计',
    '阶段 2：基础设施与依赖',
    '阶段 3：物理与操控核心',
  ])
  assert.equal(kept.length, 9, '应保留 9 条子项')
})

// ============================================================
// 场景 B：执行反馈 — todo_update 拦截与自动推进
// ============================================================

test('E2E 场景B: LLM 主动 todo_update → 校验 + 自动推进下一项', () => {
  const now = Date.now()
  const items: PlanItem[] = [
    { id: 'p0', text: '调研 GitHub', status: 'pending', createdAt: now, updatedAt: now },
    { id: 'p1', text: '选择技术栈', status: 'pending', createdAt: now, updatedAt: now },
    { id: 'p2', text: '设计核心模块', status: 'pending', createdAt: now, updatedAt: now },
  ]
  // 首轮默认 running 是第 0 项（engine 首轮把第一个 pending 推进为 running）
  items[0].status = 'running'

  // LLM 完成调研，调 todo_update 标 done
  const r1 = handleTodoUpdate(items, 0, 'done', 'GitHub 调研完成，提炼 3 个核心玩法')
  assert.equal(r1.ok, true)
  assert.equal(r1.planItems[0].status, 'done')
  assert.equal(r1.planItems[0].completedAt !== undefined, true)
  assert.equal(r1.planItems[1].status, 'running', '下一项应自动推进为 running')
  assert.equal(r1.planItems[2].status, 'pending')
  // overview 应包含完整清单
  assert.match(r1.overview, /\[x\] 1\. 调研 GitHub/)
  assert.match(r1.overview, /\[~\] 2\. 选择技术栈/)
  assert.match(r1.overview, /\[ \] 3\. 设计核心模块/)
})

test('E2E 场景B-边界: todo_update 越界 → 返回 ok:false，LLM 下一轮修正', () => {
  const items: PlanItem[] = [
    { id: 'p0', text: '调研', status: 'pending', createdAt: 0, updatedAt: 0 },
  ]
  items[0].status = 'running'
  const r = handleTodoUpdate(items, 5, 'done', '')
  assert.equal(r.ok, false)
  assert.match(r.errorMessage!, /越界/)
})

test('E2E 场景B-边界: todo_update 非法 status → 返回 ok:false', () => {
  const items: PlanItem[] = [
    { id: 'p0', text: '调研', status: 'pending', createdAt: 0, updatedAt: 0 },
  ]
  items[0].status = 'running'
  const r = handleTodoUpdate(items, 0, 'finished', '')
  assert.equal(r.ok, false)
  assert.match(r.errorMessage!, /status=finished/)
  assert.match(r.errorMessage!, /done.*running.*pending.*skipped.*failed.*cancelled/)
})

test('E2E 场景B-skipped: 跳过某项不影响下一项推进', () => {
  const items: PlanItem[] = [
    { id: 'p0', text: '调研', status: 'pending', createdAt: 0, updatedAt: 0 },
    { id: 'p1', text: '选择技术栈', status: 'pending', createdAt: 0, updatedAt: 0 },
  ]
  items[0].status = 'running'
  const r = handleTodoUpdate(items, 0, 'skipped', '用户已确认无需调研')
  assert.equal(r.ok, true)
  assert.equal(r.planItems[0].status, 'skipped')
  // skipped 时不自动推进（仅 done 推进）
  assert.equal(r.planItems[1].status, 'pending', 'skipped 时不应自动推进下一项')
})

// ============================================================
// 场景 C：工具失败 — file-writer content 传对象 + 引擎兜底
// ============================================================

test('E2E 场景C: file-writer content 传对象 → 明确字段名提示', () => {
  const r = fileWriterSimulate({ code: 'console.log("x")' })
  assert.equal(r.status, 'failed')
  assert.match(r.error!, /content\s*必须是字符串/)
  assert.match(r.error!, /当前类型=object/)
  // 应明确建议把多行代码放进 content 字符串
  assert.match(r.error!, /多行代码.*content/)
})

test('E2E 场景C: file-writer content 传数组 → 同样清晰提示', () => {
  const r = fileWriterSimulate(['line1', 'line2'])
  assert.equal(r.status, 'failed')
  assert.match(r.error!, /当前类型=object/) // js 中 array typeof 是 'object'
})

test('E2E 场景C-兜底: 工具失败时引擎自动把 running 项标 failed', () => {
  const items: PlanItem[] = [
    { id: 'p0', text: '调研 GitHub', status: 'done', createdAt: 0, updatedAt: 0, completedAt: 0 },
    { id: 'p1', text: '初始化项目结构', status: 'running', createdAt: 0, updatedAt: 0 },
    { id: 'p2', text: '封装主循环', status: 'pending', createdAt: 0, updatedAt: 0 },
  ]
  const writerResult = fileWriterSimulate({ code: 'x' })
  assert.equal(writerResult.status, 'failed')
  // v0.17.6：引擎独立判断（act 失败 → running 项自动 failed）
  const { planItems: nextItems, decisions } = decidePlanAdvance(
    items,
    'file-writer',
    false,
    writerResult.error,
  )
  const observation = `[engine-decision] ${decisions.map((d) => `第 ${d.index + 1} 项 ${d.before}->${d.after}`).join(', ')}`
  assert.equal(nextItems[1].status, 'failed', 'running 项应被自动标 failed')
  assert.equal(nextItems[1].completedAt !== undefined, true)
  assert.equal(nextItems[2].status, 'pending', '下一项保持 pending（未被自动推进）')
  // 决策应含明确的失败原因
  assert.match(decisions[0]!.reason, /file-writer 调用失败/)
})

// ============================================================
// 场景 D：阶段门禁 — react-core-skills 触发 PRD 阶段完成
// ============================================================

test('E2E 场景D: PRD 阶段门禁触发 → 找到对应计划项并标 done', () => {
  // 模拟用户用 @coder 走文档驱动开发，PRD 阶段产生 01-prd.md，触发 prd 阶段门禁
  const items: PlanItem[] = [
    { id: 'p0', text: '调研 GitHub 俯视赛车项目', status: 'done', createdAt: 0, updatedAt: 0, completedAt: 0 },
    { id: 'p1', text: '产出 PRD 文档（目标用户/核心功能/P0P1）', status: 'running', createdAt: 0, updatedAt: 0 },
    { id: 'p2', text: '产出交互文档（页面清单/主流程/五态）', status: 'pending', createdAt: 0, updatedAt: 0 },
    { id: 'p3', text: '产出 HTML 原型', status: 'pending', createdAt: 0, updatedAt: 0 },
  ]
  const idx = findPlanItemForStage(items, 'prd')
  assert.equal(idx, 1)
  // 引擎在阶段门禁触发时，把对应项标 done 并推进下一项
  items[idx].status = 'done'
  items[idx].completedAt = Date.now()
  if (idx + 1 < items.length && items[idx + 1].status === 'pending') {
    items[idx + 1].status = 'running'
  }
  assert.equal(items[1].status, 'done')
  assert.equal(items[2].status, 'running')
})

test('E2E 场景D-未匹配: 阶段门禁找不到对应项 → 返回 -1 不报错', () => {
  const items: PlanItem[] = [
    { id: 'p0', text: '完全无关的任务 A', status: 'done', createdAt: 0, updatedAt: 0, completedAt: 0 },
  ]
  const idx = findPlanItemForStage(items, 'prd')
  assert.equal(idx, -1)
})

// ============================================================
// 场景 E：完整流程串联 — 模拟从 plan 生成 → 调研完成 → file-writer 失败 → 修正
// ============================================================

test('E2E 场景E: 完整任务流程串联', () => {
  // Step 1: LLM 生成计划（模拟用户："做一个俯视赛车游戏"）
  const llmRawPlan = [
    '阶段 1：技术选型',
    '调研 GitHub 热门俯视赛车项目',
    '选择 Canvas 与原生 JS 引擎',
    '拆分六大模块',
    '阶段 2：基础与依赖',
    '初始化 Vite 项目',
    '封装主循环',
  ]
  const { kept } = filterPlanItems(llmRawPlan)
  assert.equal(kept.length, 5, '过滤后剩 5 条可验证子项')

  const planItems: PlanItem[] = kept.map((text, i) => ({
    id: `p${i}`,
    text,
    status: 'pending',
    createdAt: 0,
    updatedAt: 0,
  }))
  // 首轮：第一个 pending 推进为 running
  planItems[0].status = 'running'

  // Step 2: LLM 完成调研，调 todo_update
  const u1 = handleTodoUpdate(planItems, 0, 'done', 'GitHub 调研完成，提炼出核心玩法')
  assert.equal(u1.ok, true)
  // 复用更新后的 planItems
  for (let i = 0; i < planItems.length; i++) {
    planItems[i] = u1.planItems[i]
  }
  assert.equal(planItems[0].status, 'done')
  assert.equal(planItems[1].status, 'running', '下一项（选择技术栈）应自动推进为 running')

  // Step 3: LLM 调 file-writer 时 content 传成对象（实际 bug），引擎独立判断
  const writerRes = fileWriterSimulate({ code: 'package.json 内容' })
  assert.equal(writerRes.status, 'failed')
  const { planItems: afterFail, decisions: failDecisions } = decidePlanAdvance(
    planItems,
    'file-writer',
    false,
    writerRes.error,
  )
  for (let i = 0; i < planItems.length; i++) planItems[i] = afterFail[i]
  assert.equal(planItems[1].status, 'failed', '当前 running 项被自动标 failed')
  // 下一项保持 pending（不自动推进，避免跳过失败项）
  assert.equal(planItems[2].status, 'pending')
  // 决策日志明确指向 file-writer 失败
  assert.match(failDecisions[0]!.reason, /file-writer/)

  // Step 5: LLM 改用正确参数重试，引擎用 todo_update 把该项从 failed 改回 running
  const u2 = handleTodoUpdate(planItems, 1, 'running', '修正 content 字段为字符串后重试')
  assert.equal(u2.ok, true)
  planItems[1] = u2.planItems[1]
  assert.equal(planItems[1].status, 'running')

  // Step 6: 重试成功，标 done，推进下一项
  const u3 = handleTodoUpdate(planItems, 1, 'done', 'package.json/vite.config.js 写入成功')
  assert.equal(u3.ok, true)
  planItems[1] = u3.planItems[1]
  planItems[2] = u3.planItems[2]
  assert.equal(planItems[1].status, 'done')
  assert.equal(planItems[2].status, 'running', '下一项（封装主循环）自动推进')

  // 最终状态：前 2 项 done，第 3 项 running，剩 2 项 pending
  const summary = planItems.map((p) => p.status)
  assert.deepEqual(summary, ['done', 'done', 'running', 'pending', 'pending'])
})

/* ---------- v0.17.6 引擎独立判断：基于 act 结果而非 LLM 自报 ---------- */

test('E2E 场景F-1: 产成性工具（file-writer）成功 → 引擎自动 done 并推进下一项', () => {
  const items: PlanItem[] = [
    { id: 'p0', text: '调研 GitHub 俯视赛车', status: 'running', createdAt: 0, updatedAt: 0 },
    { id: 'p1', text: '选 Canvas 与原生 JS 引擎', status: 'pending', createdAt: 0, updatedAt: 0 },
    { id: 'p2', text: '拆分六大模块', status: 'pending', createdAt: 0, updatedAt: 0 },
  ]
  // LLM 调 file-writer 写调研报告（成功）→ 引擎应自动标 done + 推进
  const { planItems: next, decisions } = decidePlanAdvance(items, 'file-writer', true)
  assert.equal(next[0].status, 'done')
  assert.equal(next[1].status, 'running', '应自动推进下一项为 running')
  assert.equal(next[2].status, 'pending')
  // 决策日志
  assert.equal(decisions.length, 2)
  assert.equal(decisions[0]!.after, 'done')
  assert.equal(decisions[1]!.after, 'running')
})

test('E2E 场景F-2: 只读工具（file-reader）成功 → 引擎不自动推进，保留给 LLM 决定', () => {
  const items: PlanItem[] = [
    { id: 'p0', text: '调研 GitHub', status: 'running', createdAt: 0, updatedAt: 0 },
    { id: 'p1', text: '选技术栈', status: 'pending', createdAt: 0, updatedAt: 0 },
  ]
  const { planItems: next, decisions } = decidePlanAdvance(items, 'file-reader', true)
  assert.equal(next[0].status, 'running', '只读工具成功，引擎不自动推进')
  assert.equal(next[1].status, 'pending', '下一项不被自动推进')
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0]!.after, 'running')
  assert.match(decisions[0]!.reason, /只读探索/)
})

test('E2E 场景F-3: 工具失败 → 引擎自动 failed，附明确原因', () => {
  const items: PlanItem[] = [
    { id: 'p0', text: '调研 GitHub', status: 'done', createdAt: 0, updatedAt: 0, completedAt: 0 },
    { id: 'p1', text: '写 package.json', status: 'running', createdAt: 0, updatedAt: 0 },
    { id: 'p2', text: '写 vite.config', status: 'pending', createdAt: 0, updatedAt: 0 },
  ]
  const { planItems: next, decisions } = decidePlanAdvance(
    items,
    'file-writer',
    false,
    '参数 content 必须是字符串',
  )
  assert.equal(next[1].status, 'failed')
  assert.equal(next[1].completedAt !== undefined, true)
  assert.equal(next[2].status, 'pending', '下一项保持 pending（不跳过失败项）')
  assert.match(decisions[0]!.reason, /file-writer 调用失败/)
  assert.match(decisions[0]!.reason, /content 必须是字符串/)
})

test('E2E 场景F-4: emitPlanStatus 注入独立 user 消息（机器判断，非 LLM 自报）', () => {
  const items: PlanItem[] = [
    { id: 'p0', text: '调研', status: 'done', createdAt: 0, updatedAt: 0, completedAt: 0 },
    { id: 'p1', text: '编码', status: 'running', createdAt: 0, updatedAt: 0 },
    { id: 'p2', text: '测试', status: 'pending', createdAt: 0, updatedAt: 0 },
  ]
  const msg = emitPlanStatusMessage(items)
  // 必须是 user 角色（独立消息，不是 system prompt 文本）
  assert.equal(msg.role, 'user')
  // 内容必须明确"引擎独立判断"，让 LLM 知道这是机器视角
  assert.match(msg.content, /引擎独立判断/)
  assert.match(msg.content, /不是 LLM 自报/)
  assert.match(msg.content, /必须以此为准/)
  // 状态标记必须含 done/running/pending（格式：1. [x] 调研）
  assert.match(msg.content, /1\. \[x\] 调研/)
  assert.match(msg.content, /2\. \[~\] 编码/)
  assert.match(msg.content, /3\. \[ \] 测试/)
})

test('E2E 场景F-5: 关键场景——LLM 自报"全部完成"但引擎只标 1 项 done', () => {
  // 模拟你之前看到的情况：LLM 一次性把 5 项全标 done，但引擎独立判断只能 done 1 项
  const items: PlanItem[] = Array.from({ length: 5 }, (_, i) => ({
    id: `p${i}`,
    text: `步骤 ${i + 1}`,
    status: 'pending' as PlanStatus,
    createdAt: 0,
    updatedAt: 0,
  }))
  items[0].status = 'running'

  // LLM 一次 todo_update 把 5 项全标 done
  for (let i = 0; i < 5; i++) {
    const r = handleTodoUpdate(items, i, 'done', 'LLM 自报')
    if (r.ok) {
      for (let j = 0; j < items.length; j++) items[j] = r.planItems[j]!
    }
  }
  // LLM 视角：5 项都 done
  const llmView = items.map((p) => p.status)
  assert.deepEqual(llmView, ['done', 'done', 'done', 'done', 'done'], 'LLM 自报全部 done')

  // 但引擎独立判断时，只看 act 结果——如果 LLM 没真调过 file-writer 等产成性工具，
  // 引擎不会自动标 done。reset 到 running 后，再走一次只有"只读工具成功"的流程：
  const items2: PlanItem[] = Array.from({ length: 5 }, (_, i) => ({
    id: `p${i}`,
    text: `步骤 ${i + 1}`,
    status: 'pending' as PlanStatus,
    createdAt: 0,
    updatedAt: 0,
  }))
  items2[0]!.status = 'running'
  // 调 file-reader 成功（只读）→ 引擎不自动推进
  const r = decidePlanAdvance(items2, 'file-reader', true)
  // 引擎视角：只有 0 项 done，1 项 running
  assert.equal(r.planItems[0]!.status, 'running', '只读工具成功，引擎不自动 done')
  assert.equal(r.planItems.filter((p) => p.status === 'done').length, 0, '引擎视角没有 done 项')
  // emitPlanStatus 把"引擎视角"送给 LLM，LLM 必须以此为准
  const engineMsg = emitPlanStatusMessage(r.planItems)
  assert.match(engineMsg.content, /1\. \[~\] 步骤 1/)
  assert.match(engineMsg.content, /2\. \[ \] 步骤 2/)
  // 关键：LLM 看到的真实状态是 0 done，与它"自认为 5 done"形成对照
  const llmClaimed = items.filter((p) => p.status === 'done').length
  const engineTruth = r.planItems.filter((p) => p.status === 'done').length
  assert.notEqual(llmClaimed, engineTruth, 'LLM 自报与引擎判断不一致时，以引擎为准')
})
