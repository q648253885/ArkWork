/* ============================================================
 * v0.37.0 详测 — TaskLedger 接线契约（TC-WIRE-001…008）
 *
 * 对应文档：docs/versions/v0.37.0/04-system-design.md §7（接线清单 W1–W10）
 *          docs/versions/v0.37.0/testcases/00-cumulative-matrix.md §二 模块 B
 *
 * ★ 为什么"接线"要单独立一组用例（纪律③）
 *   函数写对 ≠ 接上了。v0.36.0 的 D78/D79 就是「函数全对、调用点缺失」。
 *   本组用例断言的是**调用点存在 + 顺序正确 + 没有第二条旁路**：
 *     · WIRE-001 abort 暂停分支 → park（不是 discard）
 *     · WIRE-002/003 完成门禁覆盖 task_complete 与最终答复两条通道，且**先于** seal
 *     · WIRE-004/005 门禁拒绝与上限（跨 run 持久）
 *     · WIRE-006/007 模型工具与用户点击都经 ledger.mutate
 *     · WIRE-008 **全仓除 ledger 外无第二处写 planItems**（唯一真相源的收敛证明）
 *
 * 运行（cwd=app）：
 *   ./node_modules/.bin/tsx --experimental-loader ./src/test/electron-mock-loader.mjs \
 *     --test src/main/agent/ledger/__tests__/ledger-wiring-contract.test.ts
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, mkdtempSync } from 'node:fs'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

// 纪律⑲：注释剥离只用唯一真源（自写正则会把字符串里的 `/*` 之后整段吞掉）
const { stripComments } = await import('@shared/utils/source-guard.js')

const { setWorkspaceDir } = await import('../../../store/db.js')
const { resetTaskCollection, createTask, getTask } = await import('../../../store/tasks.js')

const WORKSPACE = mkdtempSync(join(tmpdir(), 'arkwork-wire-'))
setWorkspaceDir(WORKSPACE)
resetTaskCollection()

const { ensureLedger, loadLedger, mutate } = await import('../index.js')
const { guardFinish, recordRefusal, forceCloseOpenItems } = await import('../../engine/ledger-guard.js')

/* ---------------- 源码读取工具 ---------------- */

const MAIN_DIR = fileURLToPath(new URL('../../../', import.meta.url)) // → src/main/
const ENGINE_DIR = join(MAIN_DIR, 'agent', 'engine')

const RAW = new Map<string, string>()
function rawSrc(absPath: string): string {
  const hit = RAW.get(absPath)
  if (hit !== undefined) return hit
  const s = readFileSync(absPath, 'utf-8')
  RAW.set(absPath, s)
  return s
}

/** 剥离注释后的源码（断言一律用它 —— 纪律⑫/⑲） */
function readSrc(absPath: string): string {
  return stripComments(rawSrc(absPath))
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '__tests__' || e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

/**
 * 截取源码区间（含起点，不含终点）。
 * ⚠️ 锚点可以是注释（区间定位用**原文**），但返回值是**剥注释后**的文本 ——
 *    否则"断言没命中"会退化成"锚点没命中"，报错指向错误的地方。
 */
function sliceRaw(absPath: string, from: string, to: string, label: string): string {
  const raw = rawSrc(absPath)
  const i = raw.indexOf(from)
  assert.notEqual(i, -1, `未找到区间起点：${label} → ${from}`)
  const j = to === '' ? raw.length : raw.indexOf(to, i)
  assert.notEqual(j, -1, `未找到区间终点：${label} → ${to}`)
  return stripComments(raw.slice(i, j))
}

/* ============================================================
 * TC-WIRE-001：abort 暂停分支 → park（保留），取消分支 → discard（作废）
 * ============================================================ */

test('TC-WIRE-001 abort paused 分支调 park（未完成项不被 cancelled）', () => {
  const abortPath = join(ENGINE_DIR, 'abort.ts')
  const abortSrc = readSrc(abortPath)
  // paused 分支区间：从 v0.37.0 的暂停注释到本函数结束
  const pausedRegion = sliceRaw(
    abortPath,
    "await updateTask(task.id, { status: 'paused' })",
    'v0.19.0 M3：停止候选处',
    'abort.ts paused 分支',
  )
  assert.match(pausedRegion, /await\s+parkIncompletePlanItems\(/, 'paused 分支必须调 parkIncompletePlanItems（D131）')
  assert.doesNotMatch(
    pausedRegion,
    /discardIncompletePlanItems\(/,
    'paused 分支不得再出现 discardIncompletePlanItems —— 那会把可恢复的工作作废',
  )

  // 取消分支仍走 discard（语义不变）
  const cancelledRegion = sliceRaw(
    abortPath,
    'const current = await getTask(task.id)',
    "await updateTask(task.id, { status: 'paused' })",
    'abort.ts cancelled 分支',
  )
  assert.match(cancelledRegion, /await\s+discardIncompletePlanItems\(/, 'cancelled 分支仍走 discard')

  // gates.ts：park 只写账本，不再直写 planItems
  const gatesPath = join(ENGINE_DIR, 'gates.ts')
  const gatesSrc = readSrc(gatesPath)
  assert.match(gatesSrc, /export async function parkIncompletePlanItems\(/, 'gates.ts 应导出 parkIncompletePlanItems')
  const parkFn = sliceRaw(
    gatesPath,
    'export async function parkIncompletePlanItems(',
    'v0.32.1（缺陷 D35）',
    'parkIncompletePlanItems 函数体',
  )
  assert.match(parkFn, /parkLedger\(/, 'park 必须经账本')
  assert.doesNotMatch(parkFn, /updateTask\([^)]*planItems/, 'park 函数体内不得直写 planItems')
})

/* ============================================================
 * TC-WIRE-002 / 003：完成门禁覆盖两条收尾通道，且必须先于 seal
 * ============================================================ */

test('TC-WIRE-002 guardFinish 覆盖 task_complete 路径（且先于 sealLedger）', () => {
  const p = join(ENGINE_DIR, 'turn-end.ts')
  const src = readSrc(p)
  const iGuard = src.indexOf('await guardFinish(')
  assert.notEqual(iGuard, -1, 'turn-end.ts 必须调用 guardFinish（D134）')
  const iSeal = src.indexOf('sealLedger(')
  assert.notEqual(iSeal, -1, 'turn-end.ts 应在收尾处 sealLedger')
  assert.ok(
    iGuard < iSeal,
    `guardFinish 必须先于 sealLedger（门禁在前、收口在后）。实测 guard@${iGuard} / seal@${iSeal}`,
  )
  // 拒绝分支三件套：留痕（count） + 投递（system 指令 + 用户通告） + 保底答复
  const region = sliceRaw(p, 'await guardFinish(', '完成语义变更', 'turn-end 门禁段')
  assert.match(region, /recordRefusal\(/, '拒绝必须计数（跨 run 持久）')
  // v0.38.0（D153）：判定与投递分离 —— 理由经 gate-channel 走 system 通道
  assert.match(region, /refuseViaGate\(/, '拒绝必须经 gate-channel 投递（不在判定层写 L1）')
  assert.match(region, /emitTurnNote\(/, '被拒轮已生成的正文必须保底投给用户（D152）')
  assert.doesNotMatch(region, /emitRefusal\(/, 'emitRefusal 已删除（判定与投递必须分离）')
  assert.match(region, /return true/, '被拒时不得结束回合')
})

test('TC-WIRE-003 guardFinish 覆盖最终答复路径（零 tool_calls 直接收尾）', () => {
  const p = join(ENGINE_DIR, 'loop.ts')
  const src = readSrc(p)
  // 最终答复分支：模型未调工具 → 判定为最终回复 → 收尾
  const region = sliceRaw(p, '模型未调用工具，且清单无未完成项', "type: 'task_complete'", 'loop.ts 最终答复分支')
  assert.match(region, /await\s+guardFinish\(/, '最终答复分支必须过账本门禁')
  assert.match(region, /recordRefusal\(/, '拒绝必须计数')
  assert.match(region, /refuseViaGate\(/, '拒绝必须经 gate-channel 投递')
  assert.match(region, /emitTurnNote\(/, '被拒轮正文必须保底投递')
  // v0.38.0（D150/D151）：判据必须是**客观事实**，且 run 局部计数不得再进判定
  assert.match(region, /workClass:\s*classifyRunWork\(toolsThisRun\)/, '判据 = 本 run 实际工具调用')
  assert.match(region, /touchedTree:\s*treeTouchedThisRun/, '判据 = 本 run 是否写过清单')
  const guardCall = region.slice(region.indexOf('await guardFinish('), region.indexOf('await guardFinish(') + 400)
  assert.doesNotMatch(guardCall, /completeRefusals/, 'D151：run 局部计数不得再进 guardFinish')
  const iGuard = src.indexOf('await guardFinish(')
  const iSeal = src.indexOf("sealLedger(task.id, 'completed'")
  assert.notEqual(iSeal, -1, 'loop.ts 收尾应 sealLedger')
  assert.ok(iGuard >= 0 && iGuard < iSeal, 'guardFinish 必须先于 sealLedger')
})

/* ============================================================
 * TC-WIRE-004 / 005：门禁拒绝语义与上限（跨 run 持久）
 * ============================================================ */

async function newTask(title: string, texts: string[]): Promise<string> {
  const t = await createTask({ title, text: texts[0] ?? title, agentId: 'default', modelId: 'm1' })
  const now = Date.now()
  await (await import('../../../store/tasks.js')).updateTask(t.id, {
    planItems: texts.map((text, i) => ({
      id: `p${i}`,
      text,
      status: i === 0 ? 'running' : 'pending',
      createdAt: now,
      updatedAt: now,
    })),
  })
  return t.id
}

test('TC-WIRE-004 【D150】客观判据：只读 run 一律放行；有实质动作且零写树才拒绝', async () => {
  const id = await newTask('wire004', ['A', 'B'])
  await ensureLedger((await getTask(id))!)

  // ★ 本版核心修复点：全只读 run（哪怕清单有在途项）→ 直接放行，不产生任何拦截。
  //   现场「连问三轮只读问题被拦三次」就是这条判据缺失所致。
  const ro = await guardFinish({ taskId: id, iteration: 3, workClass: 'readonly', touchedTree: false })
  assert.equal(ro.allow, true, '只读 run 不得被拦（D150）')
  if (ro.allow) assert.equal(ro.reason, 'readonly', '放行理由应显式标注 readonly')

  // 有实质动作（写文件 / 跑命令）+ 零写树 → TREE_SYNC 拒绝
  const v1 = await guardFinish({ taskId: id, iteration: 4, workClass: 'mutating', touchedTree: false })
  assert.equal(v1.allow, false, '有实质动作且零写树必须被拦')
  if (v1.allow) return
  assert.equal(v1.code, 'TREE_SYNC')
  assert.equal(v1.refusals, 1, '首次拒绝计数为 1')
  // 拒绝理由必须是人话（这条 message 会作为「判定依据」出现在给模型的指令里）
  assert.match(v1.message, /清单/, '必须点名"清单"这件事')
  assert.doesNotMatch(v1.message, /TREE_SYNC|tree-sync-required|todo_update|guardFinish/, '不得出现内部标记 / 旧工具名')

  // 计数写在账本上（跨 run 持久）
  await recordRefusal(id)
  const l = (await loadLedger(id))!
  assert.equal(l.resume?.refusals, 1, '拒绝次数必须落在账本上（唯一落点）')
})

test('TC-WIRE-005 【D151】拒绝上限后放行，且清单自动收口自洽', async () => {
  const { MAX_LEDGER_REFUSALS } = await import('../types.js')
  const id = await newTask('wire005', ['A', 'B', 'C'])
  await ensureLedger((await getTask(id))!)

  // 前 MAX 次：清单有在途项 → UNFINISHED，且计数逐次递增（单一来源 = 账本）
  for (let i = 0; i < MAX_LEDGER_REFUSALS; i++) {
    const v = await guardFinish({ taskId: id, iteration: 2 + i, workClass: 'mutating', touchedTree: true })
    assert.equal(v.allow, false, `未达上限（第 ${i + 1}/${MAX_LEDGER_REFUSALS} 次）不应放行`)
    if (!v.allow) {
      assert.equal(v.code, 'UNFINISHED')
      assert.equal(v.refusals, i + 1, 'refusals 必须等于账本计数（不得有第二套计数叠加）')
    }
    await recordRefusal(id)
  }

  // 第 MAX+1 次：达到上限 → 放行（防死循环）
  const vLast = await guardFinish({ taskId: id, iteration: 9, workClass: 'mutating', touchedTree: true })
  assert.equal(vLast.allow, true, `已达上限 ${MAX_LEDGER_REFUSALS} 次，应放行`)
  if (vLast.allow) assert.equal(vLast.reason, 'over-limit')

  // 放行后必须收口：不允许出现「任务 done 但清单仍有 pending」
  await forceCloseOpenItems(id, '完成门禁超限放行：未执行项收为 cancelled')
  const l = (await loadLedger(id))!
  const open = l.items.filter((it) => !['done', 'failed', 'cancelled', 'skipped'].includes(it.status))
  assert.equal(open.length, 0, `清单必须自洽，实测仍在途：${open.map((o) => `${o.status}/${o.text}`).join('、')}`)
})

/* ============================================================
 * TC-WIRE-006 / 007：模型工具与用户点击都经 ledger.mutate
 * ============================================================ */

test('TC-WIRE-006 【D154/D177】task_plan 单入口走 ledger（共享管线，act.ts 无任何 planItems 直写）', () => {
  // v0.38.1（D177）：落库管线收敛到 plan-commit-pipeline.ts（task_plan 与
  // 正则清单回退两条入口共享）—— 不变量断言随之指向管线本体，
  // act.ts 只保留「经管线 + 人话拒绝回传」的接线断言。
  const pipelinePath = join(ENGINE_DIR, 'plan-commit-pipeline.ts')
  const pipeline = readSrc(pipelinePath)
  assert.match(pipeline, /diffPlan\(/, '差异必须由纯函数 diffPlan 计算（模型不持有 id，不自己算 diff）')
  assert.match(pipeline, /kind: 'plan-commit'/, '落库必须经 plan-commit 算子（唯一写入口）')
  assert.match(pipeline, /ensureLedger\(/, 'NOT_FOUND 时必须自动补建后重试')
  assert.match(pipeline, /touch-sync/, '提交清单必须清零门禁拒绝计数（唯一清零点 = touch-sync）')
  assert.doesNotMatch(
    pipeline,
    /updateTask\s*\([^)]{0,240}planItems/,
    '管线不得直写 task.planItems（账本是唯一写入者）',
  )

  const actPath = join(ENGINE_DIR, 'act.ts')
  const src = readSrc(actPath)
  const region = sliceRaw(
    actPath,
    "action.tool === 'task_plan'",
    '// 找到 skill id',
    'act.ts task_plan 分支',
  )
  assert.match(region, /commitPlanDraft\(/, 'task_plan 必须经共享管线落库（不得自带第二套实现）')
  assert.match(region, /被任务清单引擎拒绝/, '被不变量拒绝时必须把人话理由回给模型')
  assert.doesNotMatch(
    region,
    /updateTask\s*\([^)]{0,240}planItems/,
    'task_plan 分支不得直写 planItems（第二个写入者）',
  )

  // 旧工具名必须留一条**可执行**的迁移兜底（FR9.1：不静默失败）
  assert.match(region, /deprecated-tool/, '旧工具名必须回可执行的迁移指引')
  assert.match(
    region,
    /isRetiredPlanTool\(action\.tool\)/,
    '兜底条件必须调唯一守卫（纪律⑧）：名字清单在 work-class.RETIRED_PLAN_TOOLS，不在此内联',
  )
  assert.doesNotMatch(
    region,
    /action\.tool === 'todo_update'/,
    '不得回到内联 if 链 —— 实现时它曾漏掉 task_update / task_get / task_list（静默掉进 No handler）',
  )
})

/* ============================================================
 * TC-WIRE-010 / 011：判定与投递分离 + 白名单唯一事实源
 * ============================================================ */

test('TC-WIRE-010 【D152/D153】门禁投递走 gate-channel 双出口，判定层不写 L1', () => {
  const gate = readSrc(join(ENGINE_DIR, 'gate-channel.ts'))
  assert.match(gate, /export async function refuseViaGate\(/, '应有统一拒绝出口')
  assert.match(gate, /export async function emitTurnNote\(/, '应有阶段结论出口')
  assert.match(gate, /export async function injectInputJudgement\(/, '应有新输入判断注入出口')
  // 控制指令走 system 通道 + 专用 kind；绝不伪装成 user_message（D153 根因）
  assert.match(gate, /role: 'system'/, '指令必须走 system 通道')
  assert.match(gate, /kind: 'gate_hint'/, '须用专用 kind')
  assert.match(gate, /kind: 'input_judgement'/)
  assert.doesNotMatch(gate, /role: 'user'/, '控制指令不得走 user 通道')
  assert.match(gate, /请勿复述/, '指令文案必须显式禁止复述')

  // 判定层必须保持"纯判定"：不得自己写 L1（投递已迁出）
  const guard = readSrc(join(ENGINE_DIR, 'ledger-guard.ts'))
  assert.doesNotMatch(guard, /appendL1\(/, 'guardFinish 不得直接投递指令')
  assert.doesNotMatch(guard, /emitEvent\(/, 'guardFinish 不得直接投递事件')
  assert.doesNotMatch(guard, /completeRefusals/, 'D151：不得再有 run 局部计数')
})

test('TC-WIRE-011 【纪律⑧】只读白名单 / 清单工具白名单只有一个事实源', () => {
  const wc = readSrc(join(ENGINE_DIR, 'work-class.ts'))
  assert.match(wc, /export const READONLY_TOOLS =/, '白名单应导出（唯一事实源）')
  assert.match(wc, /export function isReadonlyTool\(/, '应提供唯一守卫')
  assert.match(wc, /export const PLAN_TOOLS =/, '清单族（含历史名）应导出')
  assert.match(wc, /export const PLAN_WRITE_TOOLS =/, '唯一写入口应导出')
  assert.match(wc, /export const RETIRED_PLAN_TOOLS =/, '下架名单应导出（act.ts 兜底唯一引用源）')
  assert.match(wc, /export function isPlanTool\(/, '应提供 isPlanTool 守卫')
  assert.match(wc, /export function isPlanWriteTool\(/, '应提供 isPlanWriteTool 守卫')
  assert.match(wc, /export function isRetiredPlanTool\(/, '应提供 isRetiredPlanTool 守卫')

  // 消费方只许调守卫：loop.ts 不得再有本地只读集合
  const loop = readSrc(join(ENGINE_DIR, 'loop.ts'))
  assert.doesNotMatch(loop, /const READONLY_TOOLS = new Set/, 'loop 不得再维护第二份只读白名单')
  assert.match(loop, /isReadonlyTool\(a\.tool\)/, '只读判定必须调守卫')
  assert.doesNotMatch(loop, /READONLY_TOOLS\.has\(/, '不得绕过守卫直接查集合')

  // plan-tree-sync 必须调写入口守卫，而不是自建集合字面量、也不是拿「清单族」充数
  const sync = readSrc(join(ENGINE_DIR, 'plan-tree-sync.ts'))
  assert.match(sync, /isPlanWriteTool\(t\)/, '写树判定必须调唯一写入口守卫')
  assert.doesNotMatch(sync, /new Set\(\['todo_update'/, '不得再自建清单工具名集合')
  assert.doesNotMatch(sync, /new Set<string>\(PLAN_TOOLS\)/, '「清单族」不等于「写账本」，不得混用')
  // registry 的 READONLY_BUILTINS 若仍存在，须与守卫同源（登记为遗留项时不阻断）
  void 0
})

test('TC-WIRE-007 IPC 三个手动操作走 ledger（源码守卫）', () => {
  const p = join(MAIN_DIR, 'ipc', 'plan-items.ts')
  const src = readSrc(p)
  assert.match(src, /'task:plan-item-cancel'/, '应注册取消')
  assert.match(src, /'task:plan-item-retry'/, '应注册重试')
  assert.match(src, /'task:plan-item-mark-done'/, '应注册标记完成')
  // setPlanItemStatus 定义在文件后半段（导出在前），故终点取文件尾
  const setFn = sliceRaw(p, 'async function setPlanItemStatus(', '', 'setPlanItemStatus 函数体')
  assert.match(setFn, /mutate\(/, '手动操作必须经 ledger.mutate')
  assert.match(setFn, /ensureLedger\(/, '无账本时先建账')
  assert.doesNotMatch(setFn, /updateTask\([^)]*planItems/, '不得回退成直写 planItems')
})

/* ============================================================
 * TC-WIRE-008：全仓除 ledger 外无第二处写 planItems
 *
 * 分类器：
 *   · PROJECTION —— `updateTask({ planItems: toPlanItems(...) })`：账本→任务的**单向投影**，合法
 *   · SEED       —— 白名单文件里的「建账前种子」，且其后 600 字符内必须出现 ensureLedger（种子必须被账本消费）
 *   · 其余       —— 违规（第二个写入者）
 * ============================================================ */

/**
 * 白名单：**建账前 / 无账本**的兼容直写。
 * 每条都必须同时满足「同文件内存在账本路由」—— 否则白名单会变成永久后门（纪律⑮）。
 */
const LEGACY_WHITELIST: Record<string, { reason: string; requires: string }> = {
  'agent/engine/run-setup.ts': {
    reason: '首轮计划清单：尚无账本，先落 tasks.json 再 ensureLedger 建账（种子）',
    requires: 'ensureLedger(',
  },
  'pause/manager.ts': {
    reason: '旧任务无账本时以 checkpoint 为种子建账',
    requires: 'ensureLedger(',
  },
  'agent/graph/store.ts': {
    reason: '无账本的旧任务：图镜像兼容直写（账本一旦存在即走 mirror 算子）',
    requires: "kind: 'mirror'",
  },
}

/** 取 `(` 起点的**配对括号**内的实参文本（定长窗口会把后续语句误判进来） */
function callArgs(src: string, openIdx: number): string {
  let depth = 0
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i]
    if (c === '(') depth += 1
    else if (c === ')') {
      depth -= 1
      if (depth === 0) return src.slice(openIdx + 1, i)
    }
  }
  return src.slice(openIdx + 1, openIdx + 400)
}

test('TC-WIRE-008 源码守卫：全仓除 ledger 外无第二处写 planItems', () => {
  const files = walk(MAIN_DIR)
  const violations: string[] = []
  let projection = 0
  let legacy = 0

  for (const abs of files) {
    const rel = relative(MAIN_DIR, abs).split('\\').join('/')
    // ledger 模块自身是唯一写入者（engine.ts 的 syncProjections）
    if (rel.startsWith('agent/ledger/')) continue
    const src = readSrc(abs)
    const re = /updateTask\s*\(/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src)) !== null) {
      const args = callArgs(src, m.index + m[0].length - 1)
      if (!/\bplanItems\b/.test(args)) continue
      const line = src.slice(0, m.index).split('\n').length
      const site = `${rel}:${line}`
      // ① 投影：账本 → Task.planItems 的**单向**回写，合法
      if (/toPlanItems\s*\(/.test(args)) {
        projection += 1
        continue
      }
      // ② 白名单兼容直写：必须同文件内存在账本路由，否则视为后门
      const wl = LEGACY_WHITELIST[rel]
      if (wl && src.includes(wl.requires)) {
        legacy += 1
        continue
      }
      violations.push(site)
    }
  }

  assert.deepEqual(
    violations,
    [],
    `以下位置在账本之外直写 planItems（第二个写入者 → 真相源分裂）：\n${violations.join('\n')}`,
  )
  // 非空断言：防止"找不到任何匹配"式的假绿
  assert.ok(projection >= 1, `应至少存在 1 处账本→任务的投影写入（实测 ${projection}）`)
  assert.ok(legacy >= 1, `应至少存在 1 处白名单兼容直写（实测 ${legacy}）`)
  assert.equal(
    Object.keys(LEGACY_WHITELIST).length,
    3,
    '白名单不得静默扩张（新增直写必须走账本，或显式登记并说明原因）',
  )
})

/* ============================================================
 * 附加守卫：快照广播与提示词注入（W8 / W9）—— 接线存在性
 * ============================================================ */

test('TC-WIRE-009 每轮注入账本快照 + 变更广播通道已接线', () => {
  const msgSrc = readSrc(join(ENGINE_DIR, 'messages.ts'))
  assert.match(msgSrc, /renderSnapshot\(/, '每轮应注入账本权威快照（D138）')
  assert.match(msgSrc, /任务清单账本（唯一真相源）/, '快照必须声明它是唯一真相源')

  const engineSrc = readSrc(join(MAIN_DIR, 'agent', 'ledger', 'engine.ts'))
  assert.match(engineSrc, /broadcast\('task:ledger-changed'/, '账本变更广播必须接线')
  assert.match(engineSrc, /toPlanItems\(ledger\)/, '投影必须回写 Task.planItems（UI 才有真相）')
})
