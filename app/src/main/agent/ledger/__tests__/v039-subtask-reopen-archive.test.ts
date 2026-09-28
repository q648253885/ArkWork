/**
 * v0.39.0 详测 — 子任务（F6）/ 重做（F8）/ 归档可追溯（F9）
 *   TC-SUB-001…008（D185） ｜ TC-RED-001…003（F8） ｜ TC-ARCH-001…006（D187）
 *
 * 依据：docs/versions/v0.39.0/04-system-design.md §3.6、§6.3、§7（D185/D187）
 *       docs/versions/v0.39.0/testcases/00-cumulative-matrix.md
 *
 * 三组都走**真账本 + 真文件**（不是源码守卫）：这三个功能的价值全在"数据真的
 * 变成那个形状"，用字符串断言等于什么都没测（TC-PUI-009 的教训）。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs v039-subtask-reopen-archive
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { setWorkspaceDir, getLedgerDir } = await import('../../../store/db.js')
const { resetTaskCollection, createTask, getTask } = await import('../../../store/tasks.js')

const WORKSPACE = mkdtempSync(join(tmpdir(), 'arkwork-v039-ledger-'))
setWorkspaceDir(WORKSPACE)
resetTaskCollection()

const {
  ensureLedger,
  loadLedger,
  mutate,
  sealLedger,
  toPlanItems,
  renderSnapshot,
} = await import('../index.js')
const { diffPlan, resolveParentTarget } = await import('../plan-diff.js')
const { PLAN_PARENT_HINT } = await import('../ops.js')
const { appendAuditLog, readAuditLog, archiveLedger, readLedgerArchive, auditLogPathOf, archivePathOf } =
  await import('../audit.js')

/* ---------------- 夹具 ---------------- */

function mkTask(texts: string[]): Promise<{ id: string }> {
  return createTask({
    title: 'v039 fixture',
    text: texts[0] ?? 'v039 fixture',
    agentId: 'default',
    modelId: 'm1',
  })
}

/** 用 diffPlan 算 layout 后提交（等价于 task_plan 的落库核心；不经过 engine 层） */
async function commit(taskId: string, draft: Array<{ text: string; status: string; parentRef?: string; note?: string }>) {
  const l = await loadLedger(taskId)
  assert.ok(l, '账本应存在')
  const { layout, changed, warnings } = diffPlan({ current: l.items, draft: draft as never })
  const res = await mutate(taskId, { kind: 'plan-commit', layout, reason: 'test', source: 'task-plan' }, { actor: 'test' })
  return { res, changed, warnings, layout }
}

/* ================= TC-SUB：子任务（D185） ================= */

test('TC-SUB-001 ★ 子任务真落库：parent 引用解析为 parentId（三种写法都收）', async () => {
  const t = await mkTask(['做一个小工具'])
  await ensureLedger(t as never, { seedFromPlanItems: false })

  const byIndex = await commit(t.id, [
    { text: '调研同类实现', status: 'doing' },
    { text: '看官方文档', status: 'todo', parentRef: '#1' },
  ])
  assert.equal(byIndex.res.ok, true, `plan-commit 应成功：${JSON.stringify(byIndex.res)}`)

  const l = (await loadLedger(t.id))!
  const parent = l.items[0]!
  const child = l.items[1]!
  assert.equal(child.parentId, parent.id, '★ `#1` 必须解析成父项 id（此前字段存在但快照不投影 = 模型侧不可达）')

  // 按父项文本前几个字
  await commit(t.id, [
    { text: '调研同类实现', status: 'doing' },
    { text: '看官方文档', status: 'todo', parentRef: '调研同类' },
    { text: '写结论', status: 'todo', parentRef: '调研同类' },
  ])
  const l2 = (await loadLedger(t.id))!
  assert.equal(l2.items.filter((i) => i.parentId === parent.id).length, 2, '文本前缀匹配同样可用')

  // 按父项 id
  await commit(t.id, [
    { text: '调研同类实现', status: 'doing' },
    { text: '看官方文档', status: 'todo', parentRef: parent.id },
  ])
  assert.equal((await loadLedger(t.id))!.items[1]!.parentId, parent.id, 'id 直引必须可用')
})

test('TC-SUB-002 ★ 层级上限两层：第三层被拒且给出人话修复指引', async () => {
  const t = await mkTask(['三层不行'])
  await ensureLedger(t as never, { seedFromPlanItems: false })
  await commit(t.id, [
    { text: '父项', status: 'doing' },
    { text: '子项', status: 'todo', parentRef: '#1' },
  ])
  const l = (await loadLedger(t.id))!
  const childId = l.items[1]!.id
  // 试图把第三层挂到"子项"下
  const bad = await commit(t.id, [
    { text: '父项', status: 'doing' },
    { text: '子项', status: 'todo', parentRef: '#1' },
    { text: '孙项', status: 'todo', parentRef: childId },
  ])
  assert.equal(bad.res.ok, false, '★ 三层必须被拒（再深一层对"集中注意力"没有帮助，反而让快照难读）')
  assert.match(JSON.stringify(bad.res), /两层|层级/, '拒绝理由必须说清是层级问题')
  assert.ok(PLAN_PARENT_HINT.includes('最多两层'), '提示常量必须与判据同源（不得两处各写一份）')
})

test('TC-SUB-003 父项引用未命中：按顶级处理 + 记录 warning，**不整体拒绝**（面向弱模型）', async () => {
  const t = await mkTask(['未命中父项'])
  await ensureLedger(t as never, { seedFromPlanItems: false })
  const r = await commit(t.id, [
    { text: 'A 项', status: 'doing' },
    { text: 'B 项', status: 'todo', parentRef: '完全不存在的父项' },
  ])
  assert.equal(r.res.ok, true, '父项未命中不得让整份清单落不了库')
  const l = (await loadLedger(t.id))!
  assert.equal(l.items[1]!.parentId, null, '按顶级处理')
})

test('TC-SUB-004 自引用父项被拒（自己挂到自己）', async () => {
  const t = await mkTask(['自引用'])
  await ensureLedger(t as never, { seedFromPlanItems: false })
  await commit(t.id, [{ text: 'A', status: 'doing' }])
  const a = (await loadLedger(t.id))!.items[0]!
  const r = await commit(t.id, [{ text: 'A', status: 'doing', parentRef: a.id }])
  assert.equal(r.res.ok, false, '★ 自己不能当自己的父项（否则层级计算与快照渲染都会成环）')
})

test('TC-SUB-005 ★ 投影可见：快照渲染出两层缩进 + 复合编号 + 父项子项摘要', async () => {
  const t = await mkTask(['投影可见'])
  await ensureLedger(t as never, { seedFromPlanItems: false })
  await commit(t.id, [
    { text: '父项', status: 'doing' },
    { text: '子项一', status: 'done', parentRef: '#1' },
    { text: '子项二', status: 'todo', parentRef: '#1' },
  ])
  const l = (await loadLedger(t.id))!
  const snap = renderSnapshot(l)
  assert.match(snap, /1\. /, '父项用复合编号')
  assert.match(snap, /1\.1/, '★ 子项必须有二级编号（此前 parentId 在 toPlanItems 里被丢弃 → 模型永远看不到层级）')
  assert.match(snap, /1\.2/)
  const items = toPlanItems(l)
  assert.ok(items.some((p) => p.parentId), '★ toPlanItems 必须透传 parentId（D185 的核心修复点）')
})

test('TC-SUB-006 resolveParentTarget 真值表（纯函数）', () => {
  const draft = [{ text: '甲', status: 'todo' }, { text: '乙', status: 'todo' }, { text: '丙', status: 'todo' }]
  const current = [{ id: 'it_x', text: '既有甲', status: 'todo' }, { id: 'it_y', text: '既有乙', status: 'todo' }] as never
  assert.deepEqual(resolveParentTarget('#2', 0, draft as never, current), { kind: 'draft', index: 1 })
  assert.equal(resolveParentTarget('#1', 0, draft as never, current), null, '不能指向自己')
  assert.equal(resolveParentTarget('#9', 0, draft as never, current), null, '越界序号')
  assert.deepEqual(resolveParentTarget('it_y', 0, draft as never, current), { kind: 'current', id: 'it_y' })
  assert.deepEqual(resolveParentTarget('甲', 1, draft as never, current), { kind: 'draft', index: 0 })
  assert.equal(resolveParentTarget('  ', 0, draft as never, current), null, '空引用')
  assert.equal(resolveParentTarget('x', 0, draft as never, current), null, '单字不足以匹配（防误伤）')
})

test('TC-SUB-007 子任务状态独立推进，父项收口不自动级联（父子各自可核）', async () => {
  const t = await mkTask(['父子独立'])
  await ensureLedger(t as never, { seedFromPlanItems: false })
  await commit(t.id, [
    { text: '父项', status: 'doing' },
    { text: '子项一', status: 'doing', parentRef: '#1' },
    { text: '子项二', status: 'todo', parentRef: '#1' },
  ])
  const l = (await loadLedger(t.id))!
  const child1 = l.items[1]!
  const r = await mutate(t.id, { kind: 'set-status', itemId: child1.id, to: 'done', source: 'test' }, { actor: 'test' })
  assert.equal(r.ok, true)
  const after = (await loadLedger(t.id))!
  assert.equal(after.items[1]!.status, 'done')
  // ⚠️ 账本侧词汇是 running（draft 侧的 `doing` 经 DRAFT_TO_LEDGER 映射），
  //    此前断言写成 `doing` 是拿模型的词去对账本的字段 —— 测试自己写错了。
  assert.equal(after.items[0]!.status, 'running', '★ 子项完成不得把父项自动标完成（完成必须有可核对产物）')
  assert.notEqual(after.items[0]!.status, 'done', '父项自己没被核过，不许被"子项都完事"顺带标完')
})

test('TC-SUB-008 子任务不入顶层序号序列的错位防御：父项在子项之后声明也能对上', async () => {
  const t = await mkTask(['次序'])
  await ensureLedger(t as never, { seedFromPlanItems: false })
  // 子项写在父项**前面**（弱模型常见），parent 用父项在 draft 中的序号
  const r = await commit(t.id, [
    { text: '子项', status: 'todo', parentRef: '#2' },
    { text: '父项', status: 'doing' },
  ])
  assert.equal(r.res.ok, true)
  const l = (await loadLedger(t.id))!
  const child = l.items.find((i) => i.text === '子项')!
  const parent = l.items.find((i) => i.text === '父项')!
  assert.equal(child.parentId, parent.id, '序号按 draft 顺序解析，与落库顺序无关')
})

/* ================= TC-RED：重做 / reopen（F8） ================= */

test('TC-RED-001 ★ reopen：把 done 拉回 running，且**留痕**（log 里能看见 from/to/理由）', async () => {
  const t = await mkTask(['重做'])
  await ensureLedger(t as never, { seedFromPlanItems: false })
  await commit(t.id, [{ text: '写文档', status: 'doing' }])
  const item = (await loadLedger(t.id))!.items[0]!
  await mutate(t.id, { kind: 'set-status', itemId: item.id, to: 'done', source: 'test' }, { actor: 'test' })

  const r = await mutate(t.id, { kind: 'reopen', itemId: item.id, reason: '产物路径写错了', source: 'model' }, { actor: 'model' })
  assert.equal(r.ok, true, `reopen 应成功：${JSON.stringify(r)}`)
  const after = (await loadLedger(t.id))!
  assert.equal(after.items[0]!.status, 'running', '★ 终态 → 进行中')
  const entry = after.log.at(-1)!
  assert.equal(entry.op, 'reopen')
  assert.equal(entry.from, 'done', '★ from 必须是改动**前**的状态（item 是数组元素引用，先 setStatus 再读会永远记成 running→running）')
  assert.equal(entry.to, 'running')
  assert.equal(entry.by, 'model', '留痕要记清是谁改的')
  assert.match(entry.note ?? '', /产物路径写错了/, '必须带理由（不可追溯的重做等于没有 I8 保护）')
})

test('TC-RED-002 reopen 拒绝非终态项（"没做成过谈不上重做"）', async () => {
  const t = await mkTask(['非终态'])
  await ensureLedger(t as never, { seedFromPlanItems: false })
  await commit(t.id, [{ text: '进行中项', status: 'doing' }])
  const item = (await loadLedger(t.id))!.items[0]!
  const r = await mutate(t.id, { kind: 'reopen', itemId: item.id, reason: 'x', source: 'model' }, { actor: 'model' })
  assert.equal(r.ok, false)
  assert.equal(r.error?.code, 'INVARIANT')
  assert.match(r.error?.message ?? '', /没有做成过/, '理由必须是人话（纪律⑨）')
})

test('TC-RED-003 reopen 后可以再次推进到 done（重做 → 完成闭环）', async () => {
  const t = await mkTask(['闭环'])
  await ensureLedger(t as never, { seedFromPlanItems: false })
  await commit(t.id, [{ text: 'A', status: 'doing' }])
  const id = (await loadLedger(t.id))!.items[0]!.id
  await mutate(t.id, { kind: 'set-status', itemId: id, to: 'done', source: 't' }, { actor: 't' })
  await mutate(t.id, { kind: 'reopen', itemId: id, reason: '返工', source: 'model' }, { actor: 'model' })
  const r = await mutate(t.id, { kind: 'set-status', itemId: id, to: 'done', source: 't' }, { actor: 't' })
  assert.equal(r.ok, true)
  assert.equal((await loadLedger(t.id))!.items[0]!.status, 'done')
})

/* ================= TC-ARCH：审计 / 归档 / 可追溯（D187） ================= */

test('TC-ARCH-001 审计日志永久追加（JSONL，一行一条），且与环形 log 解耦', async () => {
  const t = await mkTask(['审计'])
  await ensureLedger(t as never, { seedFromPlanItems: false })
  await commit(t.id, [{ text: 'A', status: 'doing' }])
  await commit(t.id, [{ text: 'A', status: 'doing' }, { text: 'B', status: 'todo' }])
  const path = auditLogPathOf(t.id)
  assert.ok(existsSync(path), '★ 每次 mutate 都应追加永久审计日志（此前 log 只有环形 50 条，重开任务什么都不剩）')
  const lines = readFileSync(path, 'utf-8').split('\n').filter((x) => x.trim())
  assert.ok(lines.length >= 2, `至少两条（实测 ${lines.length}）`)
  for (const line of lines) JSON.parse(line) // 每行必须是合法 JSON（可被外部工具消费）
})

test('TC-ARCH-002 readAuditLog 倒序返回、limit 生效、坏行被跳过', async () => {
  const t = await mkTask(['读审计'])
  await ensureLedger(t as never, { seedFromPlanItems: false })
  await commit(t.id, [{ text: 'A', status: 'doing' }])
  await commit(t.id, [{ text: 'A', status: 'doing' }, { text: 'B', status: 'todo' }])
  const all = readAuditLog(t.id, 1000)
  const limited = readAuditLog(t.id, 1)
  assert.equal(limited.length, 1)
  assert.deepEqual(limited[0], all.at(-0) && all[0], '★ 最新在前（UI 打开"历史"第一眼要看到最近发生的事）')
  // 塞一行坏数据，读取不得整份失败
  appendAuditLog({ taskId: t.id, entries: [] })
  const { appendFileSync } = await import('node:fs')
  appendFileSync(auditLogPathOf(t.id), '{ 这不是 JSON\n', 'utf-8')
  assert.equal(readAuditLog(t.id, 1000).length >= 1, true, '坏行只跳过，不拖垮整体读取')
  assert.deepEqual(readAuditLog('不存在的任务', 10), [], '无文件返回空数组（不抛）')
})

test('TC-ARCH-003 ★ sealLedger 即归档（四条终态路径零遗漏的接法）', async () => {
  const t = await mkTask(['归档'])
  await ensureLedger(t as never, { seedFromPlanItems: false })
  await commit(t.id, [{ text: 'A', status: 'doing' }])
  await sealLedger(t.id, 'completed', '任务完成（测试）')
  const snap = readLedgerArchive(t.id)
  assert.ok(snap, '★ seal 必须触发归档 —— 否则 archiveLedger 定义得再好也没有调用点（D78/D79 同型）')
  assert.equal(snap.outcome, 'completed')
  assert.equal(snap.reason, '任务完成（测试）')
  assert.equal(snap.items.length, 1)
  assert.ok(snap.archivedAt > 0)
  assert.ok(snap.log.length >= 1, '归档要带上完整 log（供追溯）')
  assert.equal(snap.auditVersion, 1, '归档带版本号（格式演进时可判读）')
})

test('TC-ARCH-004 archiveLedger 幂等：同 revision 同 outcome 不重写（时间戳不变）', async () => {
  const t = await mkTask(['幂等'])
  await ensureLedger(t as never, { seedFromPlanItems: false })
  await commit(t.id, [{ text: 'A', status: 'todo' }])
  const l = (await loadLedger(t.id))!
  assert.equal(archiveLedger(t.id, l, 'completed', '第一次'), true)
  const a1 = readLedgerArchive(t.id)!
  assert.equal(archiveLedger(t.id, l, 'completed', '第二次'), true)
  const a2 = readLedgerArchive(t.id)!
  assert.equal(a2.archivedAt, a1.archivedAt, '★ 同 revision 不得重写（幂等）')
  assert.equal(a2.reason, '第一次', '旧快照保留')
  // outcome 变了（同一 revision 被重新判定）→ 必须重写
  assert.equal(archiveLedger(t.id, l, 'cancelled', '改判取消'), true)
  assert.equal(readLedgerArchive(t.id)!.outcome, 'cancelled')
})

test('TC-ARCH-005 归档内容含父子结构：重开后仍能看到层级（可追溯）', async () => {
  const t = await mkTask(['层级追溯'])
  await ensureLedger(t as never, { seedFromPlanItems: false })
  await commit(t.id, [
    { text: '父项', status: 'doing' },
    { text: '子项', status: 'todo', parentRef: '#1' },
  ])
  await sealLedger(t.id, 'failed', '测试失败归档')
  const snap = readLedgerArchive(t.id)!
  const child = snap.items.find((i) => i.text === '子项')!
  assert.ok(child.parentId, '★ 归档必须保留 parentId —— 否则"任务做完了，但当时怎么拆的"就永远查不回来')
  assert.equal(snap.outcome, 'failed')
})

test('TC-ARCH-006 归档文件独立于账本文件，且路径稳定可诊断', async () => {
  const t = await mkTask(['路径'])
  await ensureLedger(t as never, { seedFromPlanItems: false })
  assert.equal(auditLogPathOf(t.id).startsWith(getLedgerDir()), true)
  assert.equal(archivePathOf(t.id).startsWith(getLedgerDir()), true)
  assert.notEqual(auditLogPathOf(t.id), archivePathOf(t.id))
  assert.equal(readLedgerArchive('不存在的任务'), null, '无归档返回 null（不抛）')
})
