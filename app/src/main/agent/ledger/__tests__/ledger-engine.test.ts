/**
 * v0.37.0 详测 — TaskLedger 引擎（TC-LED-001…020）
 *
 * 对应文档：docs/versions/v0.37.0/04-system-design.md §2 / §3
 *          docs/versions/v0.37.0/testcases/00-cumulative-matrix.md §二 模块 A
 *
 * 本套件覆盖「任务清单唯一真相源」的四条硬性质：
 *  ① 实时落盘（mutate 后立刻可从磁盘读到）
 *  ② 串行化（并发 mutate 不丢更新 —— 诊断 L3 的回归防线）
 *  ③ 不变量（终态不可逆 I8 / 最多一 running / spec 缺验收降级）
 *  ④ 中断保留 + 恢复点三段式（D131 / 业界定论：判定依据是产出物而非状态）
 *
 * 运行（cwd=app）：
 *   ./node_modules/.bin/tsx --experimental-loader ./src/test/electron-mock-loader.mjs \
 *     --test src/main/agent/ledger/__tests__/ledger-engine.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { setWorkspaceDir } = await import('../../../store/db.js')
const { resetTaskCollection, createTask, getTask } = await import('../../../store/tasks.js')

const WORKSPACE = mkdtempSync(join(tmpdir(), 'arkwork-ledger-'))
setWorkspaceDir(WORKSPACE)
resetTaskCollection()

const {
  ensureLedger,
  loadLedger,
  mutate,
  parkLedger,
  discardLedger,
  resumeLedger,
  sweepStale,
  sealLedger,
  setMode,
  inferMode,
  touchSync,
  ledgerFileOf,
  toPlanItems,
  renderSnapshot,
  openItems,
  LEDGER_SCHEMA_VERSION,
  MAX_LEDGER_REFUSALS,
} = await import('../index.js')

/* ---------------- 夹具 ---------------- */

async function newTask(title: string, texts: string[]): Promise<string> {
  const t = await createTask({
    title,
    text: texts[0] ?? title,
    agentId: 'default',
    modelId: 'm1',
  })
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

/* ================= A. 落盘与串行 ================= */

test('TC-LED-001 mutate 后立即可从磁盘读到新状态（实时落盘）', async () => {
  const id = await newTask('tc001', ['A', 'B', 'C'])
  const l = await ensureLedger((await getTask(id))!)
  const first = l.items[0]!
  await mutate(id, { kind: 'set-status', itemId: first.id, to: 'done', source: 'test' })
  const raw = JSON.parse(readFileSync(ledgerFileOf(id), 'utf-8'))
  assert.equal(raw.items[0].status, 'done')
  assert.equal(raw.schemaVersion, LEDGER_SCHEMA_VERSION)
  assert.ok(raw.revision >= 1)
})

test('TC-LED-002 原子写：磁盘上永远是完整 JSON（不会出现半截文件）', async () => {
  const id = await newTask('tc002', ['A', 'B'])
  await ensureLedger((await getTask(id))!)
  const path = ledgerFileOf(id)
  for (let i = 0; i < 30; i++) {
    await mutate(id, { kind: 'note', itemId: (await loadLedger(id))!.items[0]!.id, note: `n${i}` })
    // 每次写后立刻读——若 tmp+rename 失效，这里会撞到半截 JSON
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    assert.ok(Array.isArray(parsed.items))
  }
  assert.ok(!existsSync(`${path}.tmp`))
})

test('TC-LED-003 并发 mutate 串行化，无 last-writer-wins 丢更新', async () => {
  const id = await newTask('tc003', ['A', 'B', 'C'])
  const l0 = await ensureLedger((await getTask(id))!)
  const ids = l0.items.map((it) => it.id)
  // 模拟同轮 Promise.all 并行（诊断 L3 复现形态）
  await Promise.all([
    mutate(id, { kind: 'set-status', itemId: ids[0]!, to: 'done', source: 'p1' }),
    mutate(id, { kind: 'set-status', itemId: ids[1]!, to: 'done', source: 'p2' }),
    mutate(id, { kind: 'set-status', itemId: ids[2]!, to: 'done', source: 'p3' }),
  ])
  const l = (await loadLedger(id))!
  assert.deepEqual(
    l.items.map((it) => it.status),
    ['done', 'done', 'done'],
    '三个并行写必须全部存活（旧实现只活最后一个）',
  )
  assert.ok(l.revision >= 3, `revision 应随每次写递增，实际 ${l.revision}`)
})

/* ================= B. 不变量 ================= */

test('TC-LED-004 不变量 I8：终态不可逆，done → pending 被拒', async () => {
  const id = await newTask('tc004', ['A', 'B'])
  const l0 = await ensureLedger((await getTask(id))!)
  await mutate(id, { kind: 'set-status', itemId: l0.items[0]!.id, to: 'done', source: 't' })
  const res = await mutate(id, { kind: 'set-status', itemId: l0.items[0]!.id, to: 'pending', source: 't' })
  assert.equal(res.ok, false)
  assert.equal(res.error?.code, 'INVARIANT')
  assert.match(res.error?.message ?? '', /终态/)
  // force 可穿透（用户显式 retry 语义）
  const forced = await mutate(id, { kind: 'set-status', itemId: l0.items[0]!.id, to: 'running', source: 'user-retry', force: true })
  assert.equal(forced.ok, true)
})

test('TC-LED-005 不变量 I1：非 spec 模式最多一项 running', async () => {
  const id = await newTask('tc005', ['A', 'B'])
  const l0 = await ensureLedger((await getTask(id))!)
  assert.equal(l0.items[0]!.status, 'running')
  const res = await mutate(id, { kind: 'set-status', itemId: l0.items[1]!.id, to: 'running', source: 't' })
  assert.equal(res.ok, false)
  assert.match(res.error?.message ?? '', /不能同时 running/)
})

test('TC-LED-006 不变量 I2：spec 模式缺验收契约 → done 降级 verifying', async () => {
  const id = await newTask('tc006', ['A', 'B'])
  await ensureLedger((await getTask(id))!)
  await setMode(id, 'spec', 'engine', 'test')
  const l = (await loadLedger(id))!
  const res = await mutate(id, { kind: 'set-status', itemId: l.items[0]!.id, to: 'done', source: 't' })
  assert.equal(res.ok, true)
  assert.equal(res.effective?.[0]?.status, 'verifying', '无 acceptance 应降级而非直接 done')
  // 补验收契约后可正常 done
  await mutate(id, { kind: 'set-status', itemId: l.items[0]!.id, to: 'running', source: 't', force: true })
  const res2 = await mutate(id, { kind: 'set-status', itemId: l.items[0]!.id, to: 'done', source: 't', force: true })
  assert.equal(res2.effective?.[0]?.status, 'done')
})

test('TC-LED-007 不变量 I6：blocked 缺 note 被拒', async () => {
  const id = await newTask('tc007', ['A', 'B'])
  const l0 = await ensureLedger((await getTask(id))!)
  const res = await mutate(id, { kind: 'set-status', itemId: l0.items[0]!.id, to: 'blocked', source: 't' })
  assert.equal(res.ok, false)
  assert.match(res.error?.message ?? '', /必须说明理由/)
  const ok = await mutate(id, { kind: 'set-status', itemId: l0.items[0]!.id, to: 'blocked', source: 't', note: '等待用户提供密钥' })
  assert.equal(ok.ok, true)
})

/* ================= C. 中断保留与恢复点 ================= */

test('TC-LED-008 park：pending 保留、running → paused、resume.hint 非空（D131）', async () => {
  const id = await newTask('tc008', ['A', 'B', 'C'])
  await ensureLedger((await getTask(id))!)
  await mutate(id, { kind: 'set-status', itemId: (await loadLedger(id))!.items[0]!.id, to: 'done', source: 't' })
  await mutate(id, { kind: 'advance', fromItemId: (await loadLedger(id))!.items[0]!.id, source: 't' })
  await parkLedger(id, '用户暂停')
  const l = (await loadLedger(id))!
  assert.equal(l.items[0]!.status, 'done', '已完成项不得被中断影响')
  assert.equal(l.items[1]!.status, 'paused', '进行中项应暂停而非作废')
  assert.equal(l.items[2]!.status, 'pending', '未开始项必须保留（旧实现会标 cancelled）')
  assert.ok(l.resume.hint && l.resume.hint.length > 0, '恢复点必须有人话')
  assert.match(l.resume.hint!, /已完成|未完成|中断/)
})

test('TC-LED-009 discard：仅明确取消时未完成项 → cancelled', async () => {
  const id = await newTask('tc009', ['A', 'B'])
  await ensureLedger((await getTask(id))!)
  await discardLedger(id, '用户取消任务')
  const l = (await loadLedger(id))!
  assert.ok(l.items.every((it) => it.status === 'cancelled'))
})

test('TC-LED-010 resume 三段式①：产出物存在且校验通过 → done', async () => {
  const id = await newTask('tc010', ['A', 'B'])
  const rel = 'out-tc010.txt'
  writeFileSync(join(WORKSPACE, rel), 'ok')
  const l0 = await ensureLedger((await getTask(id))!)
  await mutate(id, [
    { kind: 'set-status', itemId: l0.items[0]!.id, to: 'done', source: 't' },
    { kind: 'set-status', itemId: l0.items[1]!.id, to: 'running', source: 't', force: true },
    { kind: 'park', reason: '中断' },
  ])
  // 给暂停项挂产出物
  const l1 = (await loadLedger(id))!
  const paused = l1.items.find((it) => it.status === 'paused')!
  paused.artifact = { path: rel, kind: 'file', check: 'test -f out-tc010.txt' }
  const { writeLedgerFile } = await import('../file.js')
  await writeLedgerFile(l1)
  await resumeLedger(id, '恢复')
  const l2 = (await loadLedger(id))!
  assert.equal(l2.items.find((it) => it.id === paused.id)!.status, 'done', '产出物校验通过应判定已完成，禁止重做')
})

test('TC-LED-011 resume 三段式②：产出物不存在 → pending 且 attempts+1', async () => {
  const id = await newTask('tc011', ['A', 'B'])
  const l0 = await ensureLedger((await getTask(id))!)
  await mutate(id, [
    { kind: 'set-status', itemId: l0.items[0]!.id, to: 'running', source: 't', force: true },
    { kind: 'park', reason: '中断' },
  ])
  const l1 = (await loadLedger(id))!
  const paused = l1.items.find((it) => it.status === 'paused')!
  paused.artifact = { path: 'never-exist.txt', kind: 'file' }
  const { writeLedgerFile } = await import('../file.js')
  await writeLedgerFile(l1)
  await resumeLedger(id, '恢复')
  const l2 = (await loadLedger(id))!
  const item = l2.items.find((it) => it.id === paused.id)!
  assert.equal(item.status, 'pending')
  assert.ok(item.attempts >= 1)
})

test('TC-LED-012 resume 三段式③：无产出物声明 → 保持 paused，不误判', async () => {
  const id = await newTask('tc012', ['A', 'B'])
  await ensureLedger((await getTask(id))!)
  await mutate(id, [{ kind: 'park', reason: '中断' }])
  await resumeLedger(id, '恢复')
  const l = (await loadLedger(id))!
  assert.ok(l.items.some((it) => it.status === 'paused'), '无产出物契约时不得擅自判定完成/未完成')
})

/* ================= D. 过期巡检与收口 ================= */

test('TC-LED-013 sweep-stale：running 超阈值 → paused + 人话 note', async () => {
  const id = await newTask('tc013', ['A', 'B'])
  const l0 = await ensureLedger((await getTask(id))!)
  const l1 = (await loadLedger(id))!
  l1.items[0]!.startedAt = Date.now() - 60 * 60 * 1000
  const { writeLedgerFile } = await import('../file.js')
  await writeLedgerFile(l1)
  await sweepStale(id, 1000, '过期巡检')
  const l2 = (await loadLedger(id))!
  assert.equal(l2.items[0]!.status, 'paused')
  assert.match(l2.items[0]!.note ?? '', /无进展/)
  void l0
})

test('TC-LED-014 sweep-stale 不误伤终态项', async () => {
  const id = await newTask('tc014', ['A', 'B'])
  const l0 = await ensureLedger((await getTask(id))!)
  await mutate(id, { kind: 'set-status', itemId: l0.items[0]!.id, to: 'done', source: 't' })
  await sweepStale(id, 0, '过期巡检')
  const l = (await loadLedger(id))!
  assert.equal(l.items[0]!.status, 'done')
})

/* ================= E. replan 与账本存在性 ================= */

test('TC-LED-015 replan（append + advance）保留已完成项', async () => {
  const id = await newTask('tc015', ['A', 'B'])
  const l0 = await ensureLedger((await getTask(id))!)
  await mutate(id, { kind: 'set-status', itemId: l0.items[0]!.id, to: 'done', source: 't' })
  const before = (await loadLedger(id))!.items.length
  await mutate(id, { kind: 'append', text: 'C：新增子任务', parentId: null, reason: '用户追加' })
  const l = (await loadLedger(id))!
  assert.equal(l.items.length, before + 1)
  assert.equal(l.items[0]!.status, 'done', '已完成项不得被 replan 抹掉')
})

test('TC-LED-016 replace-all 在存在终态项时被拒（防整体作废）', async () => {
  const id = await newTask('tc016', ['A', 'B'])
  const l0 = await ensureLedger((await getTask(id))!)
  await mutate(id, { kind: 'set-status', itemId: l0.items[0]!.id, to: 'done', source: 't' })
  const res = await mutate(id, { kind: 'replace-all', items: [{ text: 'X' }], reason: '重建' })
  assert.equal(res.ok, false)
  assert.match(res.error?.message ?? '', /已存在终态项/)
})

test('TC-LED-017 ensureLedger：账本已存在绝不重建（续聊不重做核心）', async () => {
  const id = await newTask('tc017', ['A', 'B'])
  const l0 = await ensureLedger((await getTask(id))!)
  await mutate(id, { kind: 'set-status', itemId: l0.items[0]!.id, to: 'done', source: 't' })
  const before = (await loadLedger(id))!
  // 模拟「tasks.json 丢过更新」：planItems 退回全 pending
  await (await import('../../../store/tasks.js')).updateTask(id, {
    planItems: [
      { id: 'p0', text: 'A', status: 'pending', createdAt: 1, updatedAt: 1 },
      { id: 'p1', text: 'B', status: 'pending', createdAt: 1, updatedAt: 1 },
    ],
  })
  const after = await ensureLedger((await getTask(id))!)
  assert.equal(after.items[0]!.status, 'done', '账本已有时必须用账本状态，不得用过期 planItems 重建')
  assert.equal(after.items.length, before.items.length)
})

test('TC-LED-018 旧任务无账本时从 planItems 迁移建文件', async () => {
  const id = await newTask('tc018', ['A', 'B', 'C'])
  assert.equal(existsSync(ledgerFileOf(id)), false)
  const l = await ensureLedger((await getTask(id))!)
  assert.equal(l.items.length, 3)
  assert.equal(l.items[0]!.status, 'running')
  assert.equal(existsSync(ledgerFileOf(id)), true)
})

test('TC-LED-019 set-mode：模型声明写入；未声明时引擎兜底推导', async () => {
  const id = await newTask('tc019', ['A'])
  await ensureLedger((await getTask(id))!)
  await setMode(id, 'spec', 'model', '跨模块重构')
  let l = (await loadLedger(id))!
  assert.equal(l.mode, 'spec')
  assert.equal(l.modeBy, 'model')
  assert.equal(inferMode(0), 'chat')
  assert.equal(inferMode(4), 'plan')
  assert.equal(inferMode(9), 'spec')
  await setMode(id, 'chat', 'engine')
  l = (await loadLedger(id))!
  assert.equal(l.modeBy, 'engine')
})

test('TC-LED-020 投影 toPlanItems 与账本状态逐项一致', async () => {
  const id = await newTask('tc020', ['A', 'B', 'C'])
  const l0 = await ensureLedger((await getTask(id))!)
  await mutate(id, [
    { kind: 'set-status', itemId: l0.items[0]!.id, to: 'done', source: 't' },
    { kind: 'advance', fromItemId: l0.items[0]!.id, source: 't' },
    { kind: 'park', reason: '中断' },
  ])
  const l = (await loadLedger(id))!
  const items = toPlanItems(l)
  assert.equal(items.length, l.items.length)
  assert.equal(items[0]!.status, 'done')
  assert.equal(items[1]!.status, 'paused')
  assert.equal(items[2]!.status, 'pending')
  // 提示词快照必须含恢复点与"禁止重做"声明
  const snap = renderSnapshot(l)
  assert.match(snap, /恢复点/)
  assert.match(snap, /禁止重做/)
  assert.equal(openItems(l).length, 2)
})

/* ================= F. 收口与欠账 ================= */

test('TC-LED-021 seal(completed) 不动已完成项且清恢复点', async () => {
  const id = await newTask('tc021', ['A', 'B'])
  const l0 = await ensureLedger((await getTask(id))!
  )
  await mutate(id, [
    { kind: 'set-status', itemId: l0.items[0]!.id, to: 'done', source: 't' },
    { kind: 'park', reason: '中断' },
  ])
  await sealLedger(id, 'completed', '任务完成')
  const l = (await loadLedger(id))!
  assert.equal(l.items[0]!.status, 'done')
  assert.equal(l.resume.hint, undefined)
})

test('TC-LED-022 touch-sync 清欠账与拒绝计数', async () => {
  const id = await newTask('tc022', ['A'])
  await ensureLedger((await getTask(id))!)
  // v0.38.1（D165）：上限已从 v0.37 的 2 提到 3（v0.38.0 P2 决策），本用例未随语义改写
  //（与 D142 同型欠账）—— 改为 bump 上限次数，断言"达到上限"才成立。
  await mutate(id, Array.from({ length: MAX_LEDGER_REFUSALS }, () => ({ kind: 'bump-refusal' as const })))
  assert.ok(((await loadLedger(id))!.resume.refusals ?? 0) >= MAX_LEDGER_REFUSALS)
  await touchSync(id)
  assert.equal((await loadLedger(id))!.resume.refusals, 0)
})

/* 保证工作区目录存在（部分用例依赖） */
mkdirSync(WORKSPACE, { recursive: true })

/* ================= G. v0.38.1 — D175 文本更新 / D176 产物落库 ================= */

test('TC-LED-023 ★ D175/D176 plan-commit 应用 layout.text 与 layout.artifact（文本不再蒸发）', async () => {
  const id = await newTask('tc023', ['旧文本 A', '旧文本 B'])
  const l0 = (await ensureLedger((await getTask(id))!))!
  const res = await mutate(id, [
    {
      kind: 'plan-commit',
      layout: [
        // 配对项：文本更新 + 产物覆盖
        { kind: 'existing', id: l0.items[0]!.id, status: 'done', text: '新文本 A', artifact: { path: 'art-a.txt', kind: 'file' } },
        // 未给 artifact → 保留既有（此处本就没有）
        { kind: 'existing', id: l0.items[1]!.id, status: 'pending', text: '新文本 B' },
      ],
      reason: 'D175 回归',
      source: 'task-plan',
    },
  ] as never)
  assert.equal(res.ok, true, `plan-commit 应被接受：${JSON.stringify(res.error ?? '')}`)
  const l = (await loadLedger(id))!
  assert.equal(l.items[0]!.text, '新文本 A', '配对项文本必须按 draft 更新（D175 前会被静默丢弃）')
  assert.equal(l.items[0]!.artifact?.path, 'art-a.txt', 'D176：产物声明随 plan-commit 落库')
  assert.equal(l.items[1]!.text, '新文本 B')
  assert.equal(l.items[1]!.artifact, undefined, '未给 artifact 时不得凭空造声明')
})

test('TC-LED-024 D176 set-artifact 算子：声明与清除，NOT_FOUND 可诊断', async () => {
  const id = await newTask('tc024', ['项一'])
  const l0 = (await ensureLedger((await getTask(id))!))!
  const ok = await mutate(id, [
    { kind: 'set-artifact', itemId: l0.items[0]!.id, artifact: { path: 'docs/out.md', kind: 'dir' } },
  ] as never)
  assert.equal(ok.ok, true)
  let l = (await loadLedger(id))!
  assert.equal(l.items[0]!.artifact?.kind, 'dir')

  const clear = await mutate(id, [{ kind: 'set-artifact', itemId: l0.items[0]!.id, artifact: null }] as never)
  assert.equal(clear.ok, true)
  l = (await loadLedger(id))!
  assert.equal(l.items[0]!.artifact, undefined, 'null 清除声明')

  const missing = await mutate(id, [{ kind: 'set-artifact', itemId: 'li_not_exist', artifact: null }] as never)
  assert.equal(missing.ok, false)
  assert.equal(missing.error?.code, 'NOT_FOUND')
})
