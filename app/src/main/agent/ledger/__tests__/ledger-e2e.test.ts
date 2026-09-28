/* ============================================================
 * v0.37.0 详测 — 端到端模拟（TC-E2E-001…004）
 *
 * 对应文档：docs/versions/v0.37.0/testcases/00-cumulative-matrix.md §二 模块 C
 *
 * ★ 本组用例复现的是**用户实测到的那个场景**：
 *   「任务跑到一半被打断，再续聊时模型从第一个任务重新做起」
 *   诊断（任务中断与续聊重复执行诊断 v1.1）把它归因为四条根因链：
 *     L1 中断语义错配（park 被当成 discard）
 *     L2 图/账本镜像回写盖回陈旧状态
 *     L3 同轮并行写 last-writer-wins
 *     L4 完成门禁只挂一条通道
 *   本组用**真实文件 + 真实账本引擎**把「中断 → 续聊 → 继续推进」跑一遍，
 *   断言每一步之后磁盘上的状态都符合预期（不看内存态，只看账本）。
 *
 * 运行（cwd=app）：
 *   ./node_modules/.bin/tsx --experimental-loader ./src/test/electron-mock-loader.mjs \
 *     --test src/main/agent/ledger/__tests__/ledger-e2e.test.ts
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'

const { setWorkspaceDir } = await import('../../../store/db.js')
const { resetTaskCollection, createTask, getTask, updateTask } = await import('../../../store/tasks.js')

const WORKSPACE = mkdtempSync(join(tmpdir(), 'arkwork-e2e-'))
setWorkspaceDir(WORKSPACE)
resetTaskCollection()

const {
  ensureLedger,
  loadLedger,
  mutate,
  parkLedger,
  resumeLedger,
  sweepStale,
  sealLedger,
  renderSnapshot,
  openItems,
  ledgerFileOf,
} = await import('../index.js')
const { guardFinish } = await import('../../engine/ledger-guard.js')

/* ---------------- 夹具 ---------------- */

async function newTask(title: string, texts: string[]): Promise<string> {
  const t = await createTask({ title, text: texts[0] ?? title, agentId: 'default', modelId: 'm1' })
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

/** 从磁盘读账本（绕过内存缓存，验证"真的落盘了"） */
function ledgerOnDisk(taskId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(ledgerFileOf(taskId), 'utf-8'))
}

/* ============================================================
 * TC-E2E-001：中断续聊不重复执行第一项  ★ 本版核心验收（A5）
 *
 * 剧本：3 项清单 → 第 1 项 done → 用户中断 → 用户续聊
 * 期望：第 1 项**仍是 done**，第 2 项接着做；模型拿到的恢复点明说"禁止重做"
 * ============================================================ */

test('TC-E2E-001 中断续聊不重复执行第一项', async () => {
  const id = await newTask('e2e001', ['搭骨架', '写核心逻辑', '跑通验证'])
  let ledger = await ensureLedger((await getTask(id))!)
  const [i0, i1] = ledger.items

  // ① 第 1 项做完（模型 todo-update: set-status done + advance）
  await mutate(id, { kind: 'set-status', itemId: i0!.id, to: 'done', source: 'todo-update', note: '骨架已生成' })
  await mutate(id, { kind: 'advance', fromItemId: i0!.id, source: 'todo-update' })
  ledger = (await loadLedger(id))!
  assert.deepEqual(
    ledger.items.map((it) => it.status),
    ['done', 'running', 'pending'],
    '第 1 项 done、第 2 项 running、第 3 项 pending',
  )

  // ② 用户中断（Esc / 停止）→ park：running → paused，pending 保留
  const parked = await parkLedger(id, '用户中断')
  assert.equal(parked.ok, true)
  ledger = (await loadLedger(id))!
  assert.deepEqual(
    ledger.items.map((it) => it.status),
    ['done', 'paused', 'pending'],
    '中断后：done 保留、running 降为 paused、pending 不动（D131 —— 此前会全部 cancelled）',
  )
  assert.match(ledger.resume?.hint ?? '', /不要重做/, '恢复点必须写明"不要重做"')

  // ③ 续聊：run 入口的行为 = ensureLedger（已存在不重建）→ resumeLedger（三段式）
  //
  // ⚠️ 这里刻意传一个**陈旧的 task 对象**（planItems 全是 pending —— 模拟
  //    tasks.json 与账本不同步的真实形态）。若无脑重建，就会把 done 拉回 pending，
  //    于是模型照单重做第一项 —— 这正是用户实测到的 bug 形态。
  const staleTask = { ...(await getTask(id))!, planItems: ledger.items.map((it) => ({ ...it, status: 'pending' as const })) }
  const afterEnsure = await ensureLedger(staleTask as never, { seedFromPlanItems: true })
  assert.equal(afterEnsure.items[0]!.status, 'done', 'ensureLedger 已存在绝不重建（否则第一项被打回）')

  const resumed = await resumeLedger(id, '续聊恢复')
  assert.equal(resumed.ok, true)
  ledger = (await loadLedger(id))!
  assert.equal(ledger.items[0]!.status, 'done', '★ 第 1 项必须仍是 done（续聊不重做）')
  assert.notEqual(ledger.items[1]!.status, 'done', '第 2 项不应凭空中标完成')

  // ④ 提示词快照里必须显式声明"禁止重做" + 已完成的项
  const snapshot = renderSnapshot(ledger)
  assert.match(snapshot, /禁止重做/, '账本快照必须含"禁止重做"声明（模型每轮都看得到）')
  assert.match(snapshot, /搭骨架/, '快照应列出已完成项，供模型核对')

  // ⑤ 磁盘上的事实与内存一致（真落盘，不是只在内存里对）
  const disk = ledgerOnDisk(id)
  assert.deepEqual(
    (disk.items as Array<{ status: string }>).map((it) => it.status),
    ['done', 'paused', 'pending'],
    '磁盘账本与内存账本必须一致',
  )
})

/* ============================================================
 * TC-E2E-002：中断后恢复 —— 产出物校验通过则该项直接 done，不重做
 * 业界定论：判定依据是产出物，不是状态本身
 * ============================================================ */

test('TC-E2E-002 恢复时按产出物判定：存在且校验通过 → done（不重做）', async () => {
  const id = await newTask('e2e002', ['生成 dist/index.js', '生成 dist/report.md'])
  const ledger0 = await ensureLedger((await getTask(id))!)
  const [a, b] = ledger0.items

  // 给第 1 项挂产出物契约（相对工作区路径 + 完整性校验命令）
  const artDir = join(WORKSPACE, 'dist')
  mkdirSync(artDir, { recursive: true })
  writeFileSync(join(artDir, 'index.js'), 'console.log(1)\n', 'utf-8')

  await mutate(id, {
    kind: 'append',
    text: '__artifact_probe__',
    reason: '测试夹具：先建项再补 artifact',
  })
  // 直接改账本项字段（append 算子只收 text/acceptance/artifact —— 这里用公开算子组合）
  const l1 = (await loadLedger(id))!
  assert.equal(l1.items.length, 3)

  // 正身：第 1 项带产出物且文件存在 → 中断后 resume 判 done；第 2 项无产出物 → 保持 paused
  const path1 = 'dist/index.js'
  assert.equal(
    readFileSync(join(WORKSPACE, path1), 'utf-8').length > 0,
    true,
    '夹具：产出物已存在',
  )

  // 用一个真实带 artifact 的账本项：ensureLedger 的种子不带 artifact，
  // 故这里用「replace-all」重建（此时无终态项，合法）来注入 artifact 契约。
  const rebuilt = await mutate(id, {
    kind: 'replace-all',
    items: [
      {
        text: '生成 dist/index.js',
        artifact: { path: path1, kind: 'file', check: `test -s ${path1}` },
      },
      { text: '生成 dist/report.md', artifact: { path: 'dist/report.md', kind: 'file' } },
    ],
    reason: '测试夹具：注入产出物契约',
  })
  assert.equal(rebuilt.ok, true, `注入产出物契约失败：${rebuilt.error?.message ?? ''}`)

  const before = (await loadLedger(id))!
  const [it1, it2] = before.items
  // 中断：running → paused
  await parkLedger(id, '测试中断')
  const parked = (await loadLedger(id))!
  assert.equal(parked.items[0]!.status, 'paused')

  // 恢复：按产出物判定
  await resumeLedger(id, '按产出物恢复')
  const after = (await loadLedger(id))!
  assert.equal(after.items[0]!.status, 'done', '① 产出物存在且校验通过 → done（不重做）')
  assert.equal(after.items[1]!.status, 'pending', '② 产出物不存在 → 重置 pending 等调度')
  assert.notEqual(after.items[0]!.id, it2!.id, '夹具自检：两项确实是不同项')
  void a
  void b
  void it1
})

/* ============================================================
 * TC-E2E-003：续聊提新指令 → replan（add-only）后清单增长且旧项状态不变
 * ============================================================ */

test('TC-E2E-003 续聊新指令：add-only 补丁后清单增长且旧项状态不变', async () => {
  const id = await newTask('e2e003', ['原有 A', '原有 B'])
  const l0 = await ensureLedger((await getTask(id))!)
  await mutate(id, { kind: 'set-status', itemId: l0.items[0]!.id, to: 'done', source: 'todo-update' })
  await mutate(id, { kind: 'advance', fromItemId: l0.items[0]!.id, source: 'todo-update' })
  const before = (await loadLedger(id))!
  const statusesBefore = before.items.map((it) => it.status)

  // 用户续聊：「再加一个需求」→ 模型不能整表重写（那会抹掉已完成项）
  const replaceAttempt = await mutate(id, {
    kind: 'replace-all',
    items: [{ text: '重写整张清单' }],
    reason: '（反例）整表替换应被拒',
  })
  assert.equal(replaceAttempt.ok, false, '整表替换（replace-all）必须被拒 —— 否则已完成项被抹掉')
  assert.match(replaceAttempt.error?.message ?? '', /终态|replace-all/, '拒绝理由应指向不变量 I8')

  // add-only：追加
  const appended = await mutate(id, { kind: 'append', text: '新增需求 C', reason: '用户续聊追加' })
  assert.equal(appended.ok, true)

  const after = (await loadLedger(id))!
  assert.equal(after.items.length, before.items.length + 1, '清单应增长 1 项')
  assert.deepEqual(
    after.items.slice(0, statusesBefore.length).map((it) => it.status),
    statusesBefore,
    '★ 旧项状态必须一字不变（replan 是 add-only 补丁，不是整表重写）',
  )
  assert.equal(after.items[after.items.length - 1]!.text, '新增需求 C')
})

/* ============================================================
 * TC-E2E-004：长跑过期巡检 —— running 无进展 → paused，且任务可继续推进
 * ============================================================ */

test('TC-E2E-004 过期巡检：陈旧 running → paused，任务继续下一项', async () => {
  const id = await newTask('e2e004', ['长跑任务 1', '长跑任务 2', '长跑任务 3'])
  const l0 = await ensureLedger((await getTask(id))!)

  // 把 running 项的时间推到 30 分钟前（模拟"跑了很久没有任何进展"）
  const stale = Date.now() - 30 * 60 * 1000
  const raw = JSON.parse(readFileSync(ledgerFileOf(id), 'utf-8'))
  raw.items[0].startedAt = stale
  raw.items[0].updatedAt = stale
  writeFileSync(ledgerFileOf(id), JSON.stringify(raw, null, 2), 'utf-8')
  const { invalidateLedgerCache } = await import('../file.js')
  invalidateLedgerCache(id)

  const swept = await sweepStale(id, 10 * 60 * 1000, '执行长时间无进展')
  assert.equal(swept.ok, true)
  const after = (await loadLedger(id))!
  assert.equal(after.items[0]!.status, 'paused', '陈旧 running 必须降为 paused（不再假装在跑）')
  assert.match(after.items[0]!.note ?? '', /无进展|暂停待你确认/, '必须留下人话说明（静默降级是复合缺陷的粘合剂）')

  // 巡检不得误伤终态项
  await mutate(id, { kind: 'set-status', itemId: l0.items[1]!.id, to: 'done', source: 'todo-update' })
  // v0.38.1（D176）：done 项必须声明**真实存在**的产物，否则 ARTIFACT 门禁会拦收尾
  writeFileSync(join(WORKSPACE, 'e2e004-art-1.txt'), 'ok', 'utf-8')
  await mutate(id, { kind: 'set-artifact', itemId: l0.items[1]!.id, artifact: { path: 'e2e004-art-1.txt', kind: 'file' } })
  await sweepStale(id, 1, '激进阈值巡检')
  const after2 = (await loadLedger(id))!
  assert.equal(after2.items[1]!.status, 'done', '已完成的项不得被巡检改动')

  // 巡检后任务仍可推进：把陈旧项交给人决定（跳过），再继续下一项
  await mutate(id, { kind: 'set-status', itemId: after2.items[0]!.id, to: 'skipped', source: 'todo-update', note: '用户确认跳过' })
  const progress = await mutate(id, {
    kind: 'set-status',
    itemId: after2.items[2]!.id,
    to: 'running',
    source: 'todo-update',
    note: '跳过陈旧项后接着做下一项',
  })
  assert.equal(progress.ok, true, `巡检不应把任务卡死 —— 仍可继续推进（${progress.error?.message ?? ''}）`)

  // 全部收口后才能过完成门禁
  await mutate(id, { kind: 'set-status', itemId: after2.items[2]!.id, to: 'done', source: 'todo-update' })
  // v0.38.1（D176）：第三项收口同样补产物声明
  writeFileSync(join(WORKSPACE, 'e2e004-art-2.txt'), 'ok', 'utf-8')
  await mutate(id, { kind: 'set-artifact', itemId: after2.items[2]!.id, artifact: { path: 'e2e004-art-2.txt', kind: 'file' } })
  const finalLedger = (await loadLedger(id))!
  assert.equal(openItems(finalLedger).length, 0, '清单应已全部收口')
  // v0.38.0（D150）：判据改为客观事实 —— 本 run 有实质动作且触碰过清单 → synced
  const verdict = await guardFinish({ taskId: id, iteration: 9, workClass: 'mutating', touchedTree: true })
  assert.equal(verdict.allow, true, '清单收口后应放行收尾')

  const sealed = await sealLedger(id, 'completed', '任务完成')
  assert.equal(sealed.ok, true)
  const done = (await loadLedger(id))!
  assert.equal(done.resume?.hint, undefined, '收口后应清掉恢复点（不再显示"待续"提示条）')
})
