/* ============================================================
 * ArkWork — spec 模式 done 可达性用例（v0.42.2 · TC-SDR，对应 D214 三联）
 *
 * 真机根因（DeepSeek Flash v4.1 会话导出，同一清单项被反复「完成」8+ 次）：
 *  ① D214a I2 出路不可达 —— spec 模式缺验收的项 done 一律降级 verifying，而
 *     task_plan schema 没有 acceptance 字段（acceptance 恒空）→ 经清单路径
 *     永远无法 done；artifact 也不参与判定，且 plan-commit 写入顺序是
 *     artifact 后于 setStatus（同提交带产物仍被降级）。
 *  ② D214b 默认 agent defaultSkillIds 缺 S-core.task-complete —— 模型思考
 *     原话 "not in the function list"（提示词承诺的工具不存在）。
 *  ③ D214c 反馈矛盾 —— diff 摘要按预执行草案说「完成」，实际落盘 verifying
 *     （快照 [?]），模型只能反复重交（每轮都是真实变更，同参数拦截拦不住）。
 *
 * 修复：I2 出路 = 带 artifact 的 done 不降级 + plan-commit artifact 先落 +
 *      新建项同判据 + OpResult.warnings 透传 + seed 补 task-complete。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs spec-done-reachability
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const { setWorkspaceDir } = await import('../../../store/db.js')
const { resetTaskCollection, createTask, updateTask, getTask } = await import('../../../store/tasks.js')

const WORKSPACE = mkdtempSync(join(tmpdir(), 'arkwork-spec-done-'))
setWorkspaceDir(WORKSPACE)
resetTaskCollection()

const { ensureLedger, loadLedger, mutate, setMode } = await import('../index.js')
import { stripComments } from '@shared/utils/source-guard'

/* ---------------- 夹具 ---------------- */

async function newTaskWithLedger(mode: 'plan' | 'spec', texts: string[]) {
  const t = await createTask({
    title: `SDR-${mode}-${texts.length}`,
    text: texts[0] ?? '任务',
    agentId: 'default',
    modelId: 'm1',
  })
  const now = Date.now()
  // 与 ledger-engine.test.ts 同款夹具（createTask → updateTask 写 planItems → ensureLedger 播种）
  await updateTask(t.id, {
    planItems: texts.map((text, i) => ({
      id: `p${i}`,
      text,
      status: 'pending' as const,
      createdAt: now,
      updatedAt: now,
    })),
  })
  await ensureLedger((await getTask(t.id))!)
  if (mode === 'spec') {
    const res = await setMode(t.id, 'spec', 'engine')
    assert.ok(res.ok, `切 spec 模式失败：${res.error?.message}`)
  }
  return t.id
}

/* ---------------- 一、I2 真值表（真执行） ---------------- */

/** 取账本首项真实 id（ensureLedger 的 id 是 `li_<ts>_<rand>`，不可硬编码） */
async function firstItemId(taskId: string): Promise<string> {
  const l = await loadLedger(taskId)
  assert.ok(l && l.items.length > 0, '夹具账本必须有首项')
  return l.items[0]!.id
}

test('TC-SDR-001 ★ I2 真值表：spec+无验收+无 artifact → verifying（note 含出路）；带 artifact → done；plan 模式不变', async () => {
  // ① spec + 无验收 + 无 artifact → verifying（降级，但 note 必须写可达出路）
  const t1 = await newTaskWithLedger('spec', ['实现功能 A'])
  const id1 = await firstItemId(t1)
  const r1 = await mutate(t1, { kind: 'plan-commit', layout: [{ kind: 'existing', id: id1, status: 'done' }], reason: 'test', source: 'task-plan' })
  assert.ok(r1.ok)
  const l1 = await loadLedger(t1)
  assert.equal(l1!.items[0]!.status, 'verifying', 'spec 缺验收缺产物：done 降级 verifying')
  assert.match(l1!.items[0]!.note ?? '', /verifying/, '降级必须留人话 note')
  assert.match(l1!.items[0]!.note ?? '', /artifact/, 'note 必须指明可达出路（带 artifact 重提即为 done）')

  // ② spec + 无验收 + **带 artifact** → done（v0.42.2 D214a 核心修复：出路可达）
  const t2 = await newTaskWithLedger('spec', ['实现功能 B'])
  const id2 = await firstItemId(t2)
  const r2 = await mutate(t2, {
    kind: 'plan-commit',
    layout: [{ kind: 'existing', id: id2, status: 'done', artifact: { path: 'out/b.md', kind: 'file' } }],
    reason: 'test',
    source: 'task-plan',
  })
  assert.ok(r2.ok)
  const l2 = await loadLedger(t2)
  assert.equal(l2!.items[0]!.status, 'done', '★ 带 artifact 的 done 必须直接生效（一次提交，不再降级）')

  // ③ plan 模式 + 无验收 → done（行为不变）
  const t3 = await newTaskWithLedger('plan', ['实现功能 C'])
  const id3 = await firstItemId(t3)
  const r3 = await mutate(t3, { kind: 'plan-commit', layout: [{ kind: 'existing', id: id3, status: 'done' }], reason: 'test', source: 'task-plan' })
  assert.ok(r3.ok)
  const l3 = await loadLedger(t3)
  assert.equal(l3!.items[0]!.status, 'done', '非 spec 模式不受 I2 影响（既有行为）')
})

test('TC-SDR-002 ★ plan-commit 写入顺序：同一次提交「标 done + 带 artifact」一步到位（D214a 顺序修复）', async () => {
  // 复刻真机现场：项已在 verifying（上一轮被降级过），模型这次带 artifact 重提 done
  // → 必须单次提交落 done，不需要第二轮（修复前：I2 先判（artifact 未写）→ 降级 →
  //   artifact 后写 → 项停在 verifying+artifact，还得再交一次）。
  const t = await newTaskWithLedger('spec', ['产出设计方案'])
  const id = await firstItemId(t)
  // 第一轮：无 artifact 的 done → verifying（降级 + 留 note）
  await mutate(t, { kind: 'plan-commit', layout: [{ kind: 'existing', id, status: 'done' }], reason: 'r1', source: 'task-plan' })
  const mid = await loadLedger(t)
  assert.equal(mid!.items[0]!.status, 'verifying')

  // 第二轮：带 artifact 重提 done → 一次到位
  const r = await mutate(t, {
    kind: 'plan-commit',
    layout: [{ kind: 'existing', id, status: 'done', artifact: { path: 'docs/CLIENT_DESIGN.md', kind: 'file' } }],
    reason: 'r2',
    source: 'task-plan',
  })
  assert.ok(r.ok)
  const l = await loadLedger(t)
  assert.equal(l!.items[0]!.status, 'done', '带 artifact 重提必须一次落 done（死循环出口）')
})

test('TC-SDR-003 新建项一致性：spec 新建 done 无 artifact → verifying（「删了重建」旁路封死）；带 artifact → done', async () => {
  const t = await newTaskWithLedger('spec', ['占位'])
  const r = await mutate(t, {
    kind: 'plan-commit',
    layout: [
      { kind: 'new', text: '无产物的新完成项', status: 'done' },
      { kind: 'new', text: '带产物的新完成项', status: 'done', artifact: { path: 'out/x.md', kind: 'file' } },
    ],
    reason: 'test',
    source: 'task-plan',
  })
  assert.ok(r.ok)
  const l = await loadLedger(t)
  const noArt = l!.items.find((it) => it.text === '无产物的新完成项')!
  const withArt = l!.items.find((it) => it.text === '带产物的新完成项')!
  assert.equal(noArt.status, 'verifying', '新建 done 无 artifact 同样降级（旁路封死）')
  assert.equal(withArt.status, 'done', '新建 done 带 artifact 直接生效')
})

/* ---------------- 二、反馈一致（D214c） ---------------- */

test('TC-SDR-004 ★ 降级发生 → OpResult.warnings 非空且含「事实 + 出路」；管线透传', async () => {
  const t = await newTaskWithLedger('spec', ['功能 D'])
  const id = await firstItemId(t)
  const r = await mutate(t, { kind: 'plan-commit', layout: [{ kind: 'existing', id, status: 'done' }], reason: 'test', source: 'task-plan' })
  assert.ok(r.ok)
  assert.ok(Array.isArray(r.warnings) && r.warnings.length > 0, 'I2 降级必须产生 warnings（否则回执与落盘矛盾）')
  assert.match(r.warnings!.join(''), /verifying/, 'warnings 必须写明降级事实')
  assert.match(r.warnings!.join(''), /artifact/, 'warnings 必须给出路（带 artifact 重提）')
  // 无降级 → warnings 缺省（不空转）
  const r2 = await mutate(t, { kind: 'plan-commit', layout: [{ kind: 'existing', id, status: 'done', artifact: { path: 'out/d.md', kind: 'file' } }], reason: 'test2', source: 'task-plan' })
  assert.ok(r2.ok)
  assert.equal(r2.warnings, undefined, '无降级时不得产生空 warnings')
})

/* ---------------- 三、D214b：task-complete 必须真实可达 ---------------- */

test('TC-SDR-005 ★ 三份内置 agent defaultSkillIds 都含 S-core.task-complete（提示词承诺的工具必须存在）', () => {
  const seed = stripComments(readFileSync(fileURLToPath(new URL('../../../store/seed.ts', import.meta.url)), 'utf-8'))
  const lists = seed.match(/defaultSkillIds: \[[^\]]*\]/g) ?? []
  assert.ok(lists.length >= 3, `应至少 3 份 defaultSkillIds（实际 ${lists.length}）`)
  for (const [i, list] of lists.entries()) {
    assert.match(list, /S-core\.task-complete/, `第 ${i + 1} 份 agent 的技能清单必须含 task-complete（D214b：真机模型原话 "not in the function list"）`)
  }
})
