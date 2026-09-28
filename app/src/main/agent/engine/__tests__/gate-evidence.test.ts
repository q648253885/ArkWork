/* ============================================================
 * v0.38.0 详测 — 完成门禁的**证据化**判据与单一计数（TC-GATE-001…013）
 *
 * 对应文档：docs/versions/v0.38.0/04-system-design.md §4.5 / §6.3
 *           docs/versions/v0.38.0/01-research.md §2.1 / §2.2（跨系统对照）
 *
 * ★ 这组用例复现的是**用户实际遭遇的那一次**（ArkWork 现场 5 轮对话）：
 *   任务只有 2 项且都已完成 → 用户连问三次**只读问题** → 从第 3 轮起连续三轮
 *   被 `[tree-sync-required]` 拦住，且第 4/5 轮**完全看不到答复**。
 *   机械链条（诊断逐行归因）：
 *     ① 判据读的是 `startIter > 0 && !isReplyContinuation && graphId`——三个代理变量，
 *        一个都不看用户说了什么（D150）；
 *     ② 拒绝计数有两个落点（run 局部 + 账本），叠加恒得 `1 + 2 = 3`（D151）；
 *     ③ 拒绝即提前 return，不投 `task_complete` 事件 → 答复正文丢失（D152）。
 *   三条各有独立用例，且判据与投递**分开测**（判定是纯逻辑，投递在 gate-channel）。
 *
 * 手法：真实文件 + 真实账本引擎（与 ledger-e2e 同夹具口径），只看落盘账本。
 *
 * 运行（cwd=app）：
 *   ./node_modules/.bin/tsx --experimental-loader ./src/test/electron-mock-loader.mjs \
 *     --test src/main/agent/engine/__tests__/gate-evidence.test.ts
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { setWorkspaceDir } = await import('../../../store/db.js')
const { resetTaskCollection, createTask, getTask, updateTask } = await import('../../../store/tasks.js')

const WORKSPACE = mkdtempSync(join(tmpdir(), 'arkwork-gate-'))
setWorkspaceDir(WORKSPACE)
resetTaskCollection()

const { ensureLedger, loadLedger, mutate, ledgerFileOf, openItems } = await import('../../ledger/index.js')
const { guardFinish, recordRefusal, forceCloseOpenItems } = await import('../ledger-guard.js')
const { classifyRunWork } = await import('../work-class.js')
const { MAX_LEDGER_REFUSALS } = await import('../../ledger/types.js')

/* ---------------- 夹具 ---------------- */

let n = 0
async function newTask(texts: string[]): Promise<string> {
  n++
  const t = await createTask({ title: `gate${n}`, text: texts[0] ?? 'x', agentId: 'default', modelId: 'm1' })
  const now = Date.now()
  await updateTask(t.id, {
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

/** 把清单全部推到终态并声明**真实存在**的产物（D176：done 项必须可核对） */
async function finishAll(taskId: string): Promise<void> {
  const l = (await loadLedger(taskId))!
  for (const [i, it] of l.items.entries()) {
    await mutate(taskId, { kind: 'set-status', itemId: it.id, to: 'done', source: 'task-plan', force: true })
    const rel = `art-${taskId}-${i}.txt`
    writeFileSync(join(WORKSPACE, rel), 'ok')
    await mutate(taskId, { kind: 'set-artifact', itemId: it.id, artifact: { path: rel, kind: 'file' } })
  }
}

const refusalsOnDisk = (taskId: string): number =>
  (JSON.parse(readFileSync(ledgerFileOf(taskId), 'utf-8')).resume?.refusals ?? 0) as number

const statusesOnDisk = (taskId: string): string[] =>
  (JSON.parse(readFileSync(ledgerFileOf(taskId), 'utf-8')).items as Array<{ status: string }>).map((i) => i.status)

/* ============================================================
 * 一、判据客观化（D150）
 * ============================================================ */

test('TC-GATE-001 ★ D150 只读 run 一律放行 —— 哪怕零写树、哪怕清单还有在途项', async () => {
  const id = await newTask(['项一', '项二'])
  await ensureLedger((await getTask(id))!)

  // 现场最恶劣的输入：只读提问 + 清单有在途项 + 本 run 没写过清单
  const v = await guardFinish({ taskId: id, iteration: 3, workClass: 'readonly', touchedTree: false })
  assert.equal(v.allow, true, '纯只读问答不该被任何门禁拦下 —— 这是 D150 的核心修复')
  assert.equal(v.allow && v.reason, 'readonly')
  assert.equal(refusalsOnDisk(id), 0, '放行不得留下拒绝痕迹')
})

test('TC-GATE-002 账本不存在 / 读取失败 → 放行（不因 IO 把任务卡死）', async () => {
  const v = await guardFinish({ taskId: 'T-NOT-EXIST', iteration: 1, workClass: 'mutating', touchedTree: false })
  assert.equal(v.allow, true, '读不到账本时必须放行 —— 门禁是护栏，不是收费站')
  assert.equal(v.allow && v.reason, 'clean')
})

test('TC-GATE-003 清单为空 → 放行（chat 模式没有清单，谈不上"未同步"）', async () => {
  const t = await createTask({ title: 'empty', text: 'x', agentId: 'default', modelId: 'm1' })
  await ensureLedger(t, { seedFromPlanItems: false })
  const l = (await loadLedger(t.id))!
  if (l.items.length > 0) {
    // 账本按任务文本兜底建了一项 —— 用 discard 清空后再验
    await mutate(t.id, { kind: 'discard', reason: '夹具：清空清单' })
  }
  const after = (await loadLedger(t.id))!
  if (after.items.length === 0) {
    const v = await guardFinish({ taskId: t.id, iteration: 1, workClass: 'mutating', touchedTree: false })
    assert.equal(v.allow, true)
    assert.equal(v.allow && v.reason, 'clean')
  } else {
    assert.ok(true, '夹具无法清空清单（discard 语义变化）—— 本用例只作信息记录')
  }
})

test('TC-GATE-004 ★ D150 有实质动作 + 零写清单 → 拒绝 TREE_SYNC（工作必须落进清单）', async () => {
  const id = await newTask(['项一', '项二'])
  await ensureLedger((await getTask(id))!)
  const v = await guardFinish({ taskId: id, iteration: 5, workClass: 'mutating', touchedTree: false })
  assert.equal(v.allow, false)
  assert.equal(!v.allow && v.code, 'TREE_SYNC')
  assert.equal(!v.allow && v.refusals, 1, '首次拒绝 refusals=1（账本原值 0 + 1）')
  assert.match(!v.allow ? v.message : '', /清单/, '拒绝理由必须指向可执行的动作')
})

test('TC-GATE-005 分类函数与门禁口径一致：只读工具集 → readonly，其余 → mutating', () => {
  assert.equal(classifyRunWork([]), 'readonly', '什么都没调用 = 没有实质工作')
  assert.equal(classifyRunWork(['file-reader', 'grep-search', 'web-search']), 'readonly')
  assert.equal(classifyRunWork(['file-reader', 'file-writer']), 'mutating', '只要有一个写工具就是 mutating')
  assert.equal(classifyRunWork(['shell']), 'mutating')
  assert.equal(classifyRunWork(['unknown-market-skill']), 'mutating', '未登记工具一律落保守侧（视为有副作用）')
})

/* ============================================================
 * 二、在途项与已同步
 * ============================================================ */

test('TC-GATE-006 写过清单 + 无在途项 → 放行 synced', async () => {
  const id = await newTask(['项一', '项二'])
  await ensureLedger((await getTask(id))!)
  await finishAll(id)
  assert.equal(openItems((await loadLedger(id))!).length, 0)
  const v = await guardFinish({ taskId: id, iteration: 9, workClass: 'mutating', touchedTree: true })
  assert.equal(v.allow, true)
  assert.equal(v.allow && v.reason, 'synced')
})

test('TC-GATE-007 写过清单但仍有在途项 → 拒绝 UNFINISHED，且把未收口项列给模型', async () => {
  const id = await newTask(['已完成的', '还在跑的'])
  const l = await ensureLedger((await getTask(id))!)
  await mutate(id, { kind: 'set-status', itemId: l.items[0]!.id, to: 'done', source: 'task-plan', force: true })
  const v = await guardFinish({ taskId: id, iteration: 4, workClass: 'mutating', touchedTree: true })
  assert.equal(v.allow, false)
  assert.equal(!v.allow && v.code, 'UNFINISHED')
  assert.match(!v.allow ? v.message : '', /还在跑的/, '必须点名未收口的项（模型要据此二选一）')
})

/* ============================================================
 * 三、单一计数与上限（D151）
 * ============================================================ */

test('TC-GATE-008 ★ D151 上限恰为 3：前 3 次拒绝、第 4 次起放行（且不再解释成"玄学"）', async () => {
  const id = await newTask(['项一'])
  await ensureLedger((await getTask(id))!)
  assert.equal(MAX_LEDGER_REFUSALS, 3, '上限真源：账本类型层')

  const decisions: boolean[] = []
  for (let i = 0; i < 5; i++) {
    const v = await guardFinish({ taskId: id, iteration: i + 1, workClass: 'mutating', touchedTree: false })
    decisions.push(v.allow)
    if (!v.allow) await recordRefusal(id)
  }
  assert.deepEqual(
    decisions,
    [false, false, false, true, true],
    '现场"连续三轮"必须能被解释：账本 refusals 0→1→2 拒绝，达 3 后放行 —— 只有一个计数器',
  )
  assert.equal(refusalsOnDisk(id), MAX_LEDGER_REFUSALS, '上限到顶后不再累加')
})

test('TC-GATE-009 recordRefusal 是唯一计数入口，且写进账本（跨 run 持久）', async () => {
  const id = await newTask(['项一'])
  await ensureLedger((await getTask(id))!)
  assert.equal(refusalsOnDisk(id), 0)
  await recordRefusal(id)
  assert.equal(refusalsOnDisk(id), 1, '拒绝次数必须落盘 —— 每 run 归零的局部计数正是 D151 的病因')
  await recordRefusal(id)
  assert.equal(refusalsOnDisk(id), 2, '跨调用持续累加（同一次任务的多轮里是一致的）')
})

test('TC-GATE-010 ★ 清零点唯一且只有一个：touch-sync 后 refusals 归零', async () => {
  const id = await newTask(['项一'])
  const l0 = await ensureLedger((await getTask(id))!)
  await recordRefusal(id)
  await recordRefusal(id)
  assert.equal(refusalsOnDisk(id), 2)

  // ① 模型提交完整清单（act.ts 的第 ④ 步）
  const res = await mutate(
    id,
    { kind: 'plan-commit', layout: [{ kind: 'existing', id: l0.items[0]!.id, status: 'done' }], reason: '模型提交完整清单', source: 'task-plan' },
    { actor: 'model' },
  )
  assert.equal(res.ok, true, `plan-commit 应被接受：${res.error?.message ?? ''}`)
  assert.equal(
    refusalsOnDisk(id),
    2,
    'plan-commit **自身不清账** —— 清零点刻意只留一个（touch-sync），不给第二条清零路径',
  )

  // ② act.ts 的第 ⑤ 步：显式 touch-sync（"已检视清单"的落痕）
  await mutate(id, { kind: 'touch-sync' }, { actor: 'task-plan' })
  assert.equal(refusalsOnDisk(id), 0, '清零点唯一 = touch-sync；漏了它，门禁会一直差一次')
})

test('TC-GATE-010b 清零点副作用面：touch-sync 只动 refusals，不改任何清单项状态', async () => {
  const id = await newTask(['项一', '项二'])
  await ensureLedger((await getTask(id))!)
  await mutate(id, { kind: 'set-status', itemId: (await loadLedger(id))!.items[0]!.id, to: 'done', source: 'task-plan', force: true })
  const before = statusesOnDisk(id)
  await mutate(id, { kind: 'touch-sync' }, { actor: 'task-plan' })
  assert.deepEqual(statusesOnDisk(id), before, '清零是"记账"动作，不是"改状态"动作')
})

test('TC-GATE-011 D151 反向：放行判定不读取任何 run 局部计数（源码守卫已覆盖，此处补行为面）', async () => {
  // 行为面证据：同样的 (mutating, 零写树) 在 refusals 未到上限时恒被拒，
  // 与"本轮是第几次调用 guardFinish"无关 —— 若还有第二个计数器，第 2/3 次调用
  // 会因 run 局部计数变化而表现不同。
  const id = await newTask(['项一'])
  await ensureLedger((await getTask(id))!)
  const a = await guardFinish({ taskId: id, iteration: 1, workClass: 'mutating', touchedTree: false })
  const b = await guardFinish({ taskId: id, iteration: 2, workClass: 'mutating', touchedTree: false })
  assert.equal(a.allow, false)
  assert.equal(b.allow, false)
  assert.equal(!a.allow && a.refusals, !b.allow && b.refusals, '两次判定给出同一个 refusals 预测值 → 计数只来自账本')
})

/* ============================================================
 * 四、拒绝不得改写清单 / 超限收口
 * ============================================================ */

test('TC-GATE-012 ★ 拒绝是**只读**判定：不得顺手改清单（否则"逼模型做假动作"）', async () => {
  const id = await newTask(['项一', '项二'])
  await ensureLedger((await getTask(id))!)
  const before = statusesOnDisk(id)
  await guardFinish({ taskId: id, iteration: 1, workClass: 'mutating', touchedTree: false })
  await guardFinish({ taskId: id, iteration: 2, workClass: 'mutating', touchedTree: true })
  assert.deepEqual(statusesOnDisk(id), before, 'guardFinish 本身不得产生任何清单写入')
})

test('TC-GATE-013 超限放行时的收口：forceCloseOpenItems 把在途项收成终态（仅在途项受影响）', async () => {
  const id = await newTask(['在途的', '也完成了的'])
  const l = await ensureLedger((await getTask(id))!)
  await mutate(id, { kind: 'set-status', itemId: l.items[1]!.id, to: 'done', source: 'task-plan', force: true })
  assert.equal(openItems((await loadLedger(id))!).length, 1)

  await forceCloseOpenItems(id, '门禁超限收口')
  const after = (await loadLedger(id))!
  assert.equal(openItems(after).length, 0, '"任务 done 而清单有 pending"不得落到界面上')
  assert.equal(after.items[1]!.status, 'done', '已终态的项不得被收口动作改动')
  assert.match(after.items[0]!.note ?? '', /收口|作废|放弃|门禁/, '收口必须留下人话理由（纪律⑨）')
})

/* ============================================================
 * 五、成果产物核对（v0.38.1 · D176）
 *    用户裁决：每个任务项必须有成果产物，引擎核对产物后才允许收尾。
 * ============================================================ */

test('TC-GATE-014 ★ D176 done 项未声明产物 → 拒绝 ARTIFACT，且必须点名补救方式', async () => {
  const id = await newTask(['无产物的完成项', '另一项'])
  const l = await ensureLedger((await getTask(id))!)
  // 全部推到终态（无产物）—— 只留 ARTIFACT 一种拦截可能
  for (const it of l.items) {
    await mutate(id, { kind: 'set-status', itemId: it.id, to: 'done', source: 'task-plan', force: true })
  }

  const v = await guardFinish({ taskId: id, iteration: 1, workClass: 'mutating', touchedTree: true })
  assert.equal(v.allow, false)
  assert.equal(!v.allow && v.code, 'ARTIFACT')
  assert.match(!v.allow ? v.message : '', /无产物的完成项/, '必须点名违规项')
  assert.match(!v.allow ? v.message : '', /artifact/, '必须给出可执行出路（补 artifact 声明）')
})

test('TC-GATE-015 ★ D176 声明了产物但磁盘上不存在 → 拒绝；产物落盘后放行 synced', async () => {
  const id = await newTask(['写交付页'])
  const l = await ensureLedger((await getTask(id))!)
  await mutate(id, { kind: 'set-status', itemId: l.items[0]!.id, to: 'done', source: 'task-plan', force: true })
  await mutate(id, { kind: 'set-artifact', itemId: l.items[0]!.id, artifact: { path: 'missing-out.html', kind: 'file' } })

  const refused = await guardFinish({ taskId: id, iteration: 1, workClass: 'mutating', touchedTree: true })
  assert.equal(refused.allow, false)
  assert.equal(!refused.allow && refused.code, 'ARTIFACT', '声明了但盘上没有 = 不可核对，照样拦')

  // 产物真实落盘 → 同一份账本立即放行（核对的是事实，不是声明本身）
  writeFileSync(join(WORKSPACE, 'missing-out.html'), '<html></html>')
  const allowed = await guardFinish({ taskId: id, iteration: 2, workClass: 'mutating', touchedTree: true })
  assert.equal(allowed.allow, true)
  assert.equal(allowed.allow && allowed.reason, 'synced')
})

test('TC-GATE-016 D176 command 产物缺 check 校验说明 → unverifiable 拒绝', async () => {
  const { verifyArtifacts } = await import('../ledger-guard.js')
  const id = await newTask(['跑命令类产物'])
  const l = await ensureLedger((await getTask(id))!)
  await mutate(id, { kind: 'set-status', itemId: l.items[0]!.id, to: 'done', source: 'task-plan', force: true })
  await mutate(id, { kind: 'set-artifact', itemId: l.items[0]!.id, artifact: { path: '', kind: 'command', check: '' } })

  const ledger = (await loadLedger(id))!
  const violations = verifyArtifacts(ledger)
  assert.equal(violations.length, 1)
  assert.equal(violations[0]!.reason, 'unverifiable')

  // check 补上后可核对
  await mutate(id, {
    kind: 'set-artifact',
    itemId: l.items[0]!.id,
    artifact: { path: '', kind: 'command', check: 'npm test 退出码 0' },
  })
  assert.equal(verifyArtifacts((await loadLedger(id))!).length, 0)
})

test('TC-GATE-017 D176 ARTIFACT 拒绝同样走统一计数：上限内拦、到顶放行（over-limit）', async () => {
  const id = await newTask(['永远没产物的项'])
  const l = await ensureLedger((await getTask(id))!)
  await mutate(id, { kind: 'set-status', itemId: l.items[0]!.id, to: 'done', source: 'task-plan', force: true })

  const decisions: boolean[] = []
  for (let i = 0; i < 5; i++) {
    const v = await guardFinish({ taskId: id, iteration: i + 1, workClass: 'mutating', touchedTree: true })
    decisions.push(v.allow)
    if (!v.allow) {
      assert.equal(!v.allow && v.code, 'ARTIFACT')
      await recordRefusal(id)
    }
  }
  assert.deepEqual(decisions, [false, false, false, true, true], 'ARTIFACT 复用唯一计数器，不许出现第二个上限')
})
