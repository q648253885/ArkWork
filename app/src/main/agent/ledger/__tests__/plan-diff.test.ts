/* ============================================================
 * v0.38.0 详测 — 计划差异比对（TC-PDIFF-001…014）
 *
 * 对应文档：docs/versions/v0.38.0/04-system-design.md §6.1 / §6.2
 *           docs/versions/v0.38.0/testcases/00-cumulative-matrix.md
 *
 * 为什么这组用例重要：
 *   D154 的病根是"模型有两套清单工具可选、语义还重叠"——收敛成 `task_plan`
 *   单入口后，**唯一入口的正确性完全押在 `diffPlan` 上**。
 *   如果差异算错，模型的意图会被悄悄改写（比报错更危险），所以这里对
 *   每条不变量（I1 / I8 / 转换表 / 终态不可消失）都单独立例。
 *
 * 硬要求：`diffPlan` 是**纯函数** —— 同输入必得同输出（本组末尾专门断言幂等）。
 *
 * 运行（cwd=app）：
 *   ./node_modules/.bin/tsx --test src/main/agent/ledger/__tests__/plan-diff.test.ts
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  diffPlan,
  toDraftSnapshot,
  toDraftStatus,
  isDraftStatus,
  DRAFT_STATUSES,
  textSimilarity,
  PAIR_SIMILARITY_MIN,
} from '../plan-diff.js'
import type { PlanDraftItem } from '../plan-diff.js'
import type { LedgerItem, LedgerItemStatus } from '../types.js'

/* ---------------- 夹具 ---------------- */

let seq = 0
function item(text: string, status: LedgerItemStatus, note?: string): LedgerItem {
  seq++
  return {
    id: `i${seq}`,
    text,
    status,
    parentId: null,
    dependsOn: [],
    acceptance: [],
    createdAt: 1000 + seq,
    updatedAt: 1000 + seq,
    source: 'task-plan',
    attempts: 0,
    ...(note ? { note } : {}),
  }
}

function draft(
  text: string,
  status: PlanDraftItem['status'],
  note?: string,
  artifact?: PlanDraftItem['artifact'],
): PlanDraftItem {
  return { text, status, ...(note ? { note } : {}), ...(artifact ? { artifact } : {}) }
}

const statusOps = (r: ReturnType<typeof diffPlan>) => r.ops.filter((o) => o.kind === 'status')
const createOps = (r: ReturnType<typeof diffPlan>) => r.ops.filter((o) => o.kind === 'create')
const dropOps = (r: ReturnType<typeof diffPlan>) => r.ops.filter((o) => o.kind === 'drop')
const retextOps = (r: ReturnType<typeof diffPlan>) => r.ops.filter((o) => o.kind === 'retext')

/* ============================================================
 * 一、词表（对外 5 态 / 对内 9 态）
 * ============================================================ */

test('TC-PDIFF-001 对外词表恰为 5 态，且 isDraftStatus 是唯一守卫', () => {
  assert.deepEqual([...DRAFT_STATUSES], ['todo', 'doing', 'done', 'skipped', 'blocked'])
  assert.equal(isDraftStatus('todo'), true)
  assert.equal(isDraftStatus('running'), false, 'running 是内部态，不得被对外词表接受')
  assert.equal(isDraftStatus('paused'), false)
  assert.equal(isDraftStatus(42), false)
})

test('TC-PDIFF-002 对内 9 态全部有对外投影，且降级不静默（paused/verifying/failed/cancelled 带人话标注）', () => {
  const all: LedgerItemStatus[] = [
    'pending', 'running', 'paused', 'blocked', 'verifying', 'done', 'failed', 'cancelled', 'skipped',
  ]
  for (const s of all) assert.ok(isDraftStatus(toDraftStatus(s)), `toDraftStatus(${s}) 必须落在对外 5 态内`)

  const snap = toDraftSnapshot([
    item('a', 'paused'),
    item('b', 'verifying'),
    item('c', 'failed'),
    item('d', 'cancelled'),
    item('e', 'done'),
  ])
  // 语义降级必须留下痕迹（纪律⑨：静默退化是复合缺陷的粘合剂）
  assert.match(snap[0]!.note ?? '', /已暂停/)
  assert.match(snap[1]!.note ?? '', /待验证/)
  assert.match(snap[2]!.note ?? '', /失败/)
  assert.match(snap[3]!.note ?? '', /已取消/)
  assert.equal(snap[4]!.note, undefined, 'done 是精确对应，不该加噪声标注')
})

/* ============================================================
 * 二、基础算子
 * ============================================================ */

test('TC-PDIFF-003 空清单 + 全新 draft → 全 create，summary 说人话', () => {
  const r = diffPlan({ current: [], draft: [draft('读代码', 'todo'), draft('写测试', 'todo')] })
  assert.equal(createOps(r).length, 2)
  assert.equal(r.changed, 2)
  assert.equal(r.layout.length, 2)
  assert.equal(r.protectedIds.length, 0)
  assert.match(r.summary, /新增 2 项/)
  // 摘要面向用户，不得出现内部枚举字面量
  assert.doesNotMatch(r.summary, /pending|running|create|todo\b/)
})

test('TC-PDIFF-004 同一份清单原样提交 → changed 0（"已检视，无需变化"是合法结果）', () => {
  const cur = [item('读代码', 'done'), item('写测试', 'pending')]
  const r = diffPlan({ current: cur, draft: [draft('读代码', 'done'), draft('写测试', 'todo')] })
  assert.equal(r.changed, 0, '这是判断外化的物理依据：模型必须能"提交相同清单"来表达无需变化')
  assert.equal(r.ops.length, 0)
  assert.equal(r.summary, '', '无变化时摘要为空 —— UI 不该弹出"更新了 0 项"')
  assert.deepEqual(
    r.layout.map((e) => e.kind),
    ['existing', 'existing'],
  )
})

test('TC-PDIFF-005 状态推进 pending→doing→done 逐条成 op，from/to 准确', () => {
  const cur = [item('A', 'pending'), item('B', 'pending')]
  const r = diffPlan({ current: cur, draft: [draft('A', 'doing'), draft('B', 'done')] })
  const ops = statusOps(r)
  assert.equal(ops.length, 2)
  assert.deepEqual(
    ops.map((o) => [o.from, o.to]),
    [['pending', 'running'], ['pending', 'done']],
  )
})

test('TC-PDIFF-006 ★ D175 措辞微调（文本不同）走顺序兜底配对，文本按 draft 更新（retext 算子）', () => {
  const cur = [item('读代码', 'running'), item('写测试', 'pending')]
  const r = diffPlan({
    current: cur,
    draft: [draft('读一遍代码', 'doing'), draft('补测试', 'todo')],
  })
  // D175 前：配对成功但 plan-commit 不写 text → 新文本静默蒸发（现场：坦克大战重制清单，
  // 8 条新文本全部丢失、面板永远显示旧 FPS 条目）。D175 后：文本更新是一等公民算子。
  assert.equal(createOps(r).length, 0, '措辞微调不能退化成"全删全增"——这是最伤用户信任的形态')
  assert.equal(dropOps(r).length, 0)
  assert.equal(retextOps(r).length, 2, '配对成功且文本不同 → 必须产生 retext 算子（可解释、可计数）')
  assert.deepEqual(
    r.layout.map((e) => (e.kind === 'existing' ? e.id : 'x')),
    [cur[0]!.id, cur[1]!.id],
    '仍是复用既有项，不是重建',
  )
  assert.equal(r.layout[0]!.kind === 'existing' ? r.layout[0]!.text : undefined, '读一遍代码')
  assert.equal(r.layout[1]!.kind === 'existing' ? r.layout[1]!.text : undefined, '补测试')
  assert.match(r.summary, /更新描述 2 项/, '摘要必须如实宣称文本更新（不许静默改写）')
})

test('TC-PDIFF-007 重排：layout 顺序 = draft 顺序，且引用既有 id（不重建项）', () => {
  const cur = [item('A', 'pending'), item('B', 'pending')]
  const r = diffPlan({ current: cur, draft: [draft('B', 'todo'), draft('A', 'todo')] })
  assert.equal(r.changed, 0, '纯重排不产生状态/增删算子')
  assert.deepEqual(
    r.layout.map((e) => (e.kind === 'existing' ? e.id : 'x')),
    [cur[1]!.id, cur[0]!.id],
  )
})

test('TC-PDIFF-008 note 变更单独成 op；note 相同则不成 op', () => {
  const cur = [item('A', 'done', '已跑 npm test')]
  const same = diffPlan({ current: cur, draft: [draft('A', 'done', '已跑 npm test')] })
  assert.equal(same.ops.filter((o) => o.kind === 'note').length, 0)

  const changed = diffPlan({ current: cur, draft: [draft('A', 'done', '已跑 npm test + tsc')] })
  const notes = changed.ops.filter((o) => o.kind === 'note')
  assert.equal(notes.length, 1)
  assert.equal(notes[0]!.note, '已跑 npm test + tsc')
})

/* ============================================================
 * 三、不变量（I1 / I8 / 转换表 / 终态不可消失）
 * ============================================================ */

test('TC-PDIFF-009 I1：draft 里多个 doing → 只留第一个，其余降 todo 并留 warning', () => {
  const r = diffPlan({
    current: [],
    draft: [draft('A', 'doing'), draft('B', 'doing'), draft('C', 'doing')],
  })
  const layouts = r.layout.filter((e) => e.kind === 'new')
  assert.deepEqual(
    layouts.map((e) => e.status),
    ['running', 'pending', 'pending'],
  )
  assert.equal(r.warnings.length, 1)
  assert.match(r.warnings[0]!, /只能有一项/)
})

test('TC-PDIFF-010 I8：终态项被 draft 给非终态 → 状态不动 + 记入 protectedIds', () => {
  const cur = [item('A', 'done')]
  const r = diffPlan({ current: cur, draft: [draft('A', 'doing')] })
  assert.equal(statusOps(r).length, 0, 'I8：终态不可逆，绝不产生"done → running"这类算子')
  assert.deepEqual(r.protectedIds, [cur[0]!.id])
  const lay = r.layout.find((e) => e.kind === 'existing')
  assert.equal(lay?.status, 'done')
})

test('TC-PDIFF-011 终态项从 draft 中消失 → 不 drop，按原顺序追加在末尾（用户不会以为它没做过）', () => {
  const cur = [item('已完成的老项', 'done'), item('在途项', 'pending')]
  const r = diffPlan({ current: cur, draft: [draft('在途项', 'doing')] })
  assert.equal(dropOps(r).length, 0)
  assert.ok(r.protectedIds.includes(cur[0]!.id))
  const last = r.layout[r.layout.length - 1]!
  assert.equal(last.kind === 'existing' ? last.id : '', cur[0]!.id)
})

test('TC-PDIFF-012 非终态项从 draft 中消失 → 真 drop（移除 1 项进摘要）', () => {
  const cur = [item('A', 'pending'), item('B', 'running')]
  const r = diffPlan({ current: cur, draft: [draft('A', 'todo')] })
  assert.equal(dropOps(r).length, 1)
  assert.equal(dropOps(r)[0]!.text, 'B')
  assert.match(r.summary, /移除 1 项/)
})

test('TC-PDIFF-013 转换表保护：verifying → todo 不被允许 → 保持原状 + warning（不静默吞掉）', () => {
  const cur = [item('A', 'verifying')]
  const r = diffPlan({ current: cur, draft: [draft('A', 'todo')] })
  assert.equal(statusOps(r).length, 0)
  assert.deepEqual(r.protectedIds, [cur[0]!.id])
  assert.equal(r.layout[0]!.status, 'verifying')
  assert.equal(r.warnings.length, 1, '被拒的转换必须留人话，否则模型无法解释为什么状态没变')
  assert.match(r.warnings[0]!, /不能直接转为/)
})

/* ============================================================
 * 四、纯度 / 稳定性
 * ============================================================ */

test('TC-PDIFF-014 ★ 幂等：同输入同输出（纯函数，无 Date.now / 无隐藏状态）', () => {
  const cur = [item('A', 'done'), item('B', 'running'), item('C', 'pending'), item('D', 'skipped')]
  const d = [draft('B', 'done'), draft('C', 'doing'), draft('E', 'todo'), draft('A', 'todo')]
  const a = JSON.stringify(diffPlan({ current: cur, draft: d }))
  const b = JSON.stringify(diffPlan({ current: cur, draft: d }))
  assert.equal(a, b, 'diffPlan 一旦沾上时间/随机，重放就会得到不同的算子 —— 幂等是它的验收底线')
})

test('TC-PDIFF-014b summary 只讲人话：不含内部术语与工具名', () => {
  // ① 完成 + 新增同时出现
  const cur1 = [item('A', 'pending')]
  const r1 = diffPlan({ current: cur1, draft: [draft('A', 'done'), draft('B', 'todo'), draft('C', 'todo')] })
  assert.match(r1.summary, /完成：/)
  assert.match(r1.summary, /新增 2 项/)
  assert.doesNotMatch(r1.summary, /移除/)

  // ② 移除单独出现（current 多出且非终态）
  const cur2 = [item('A', 'pending'), item('B', 'pending'), item('C', 'pending')]
  const r2 = diffPlan({ current: cur2, draft: [draft('A', 'todo')] })
  assert.match(r2.summary, /移除 2 项/)

  // ③ 两段摘要都必须是人话：不得出现内部枚举 / 工具名 / 算子名
  for (const s of [r1.summary, r2.summary]) {
    assert.doesNotMatch(s, /task_plan|todo_update|pending|running|create|drop|status/)
  }
})

/* ============================================================
 * 五、v0.38.1 — D175 配对门控 / D176 成果产物
 * ============================================================ */

test('TC-PDIFF-015 ★ D175 坦克大战现场回归：整体重制计划不得被按位置错配（文本蒸发防线）', () => {
  // 现场：旧 FPS 清单（已 cancelled）× 新坦克清单（8 项全新文本）
  // D175 前的行为：顺序兜底强行配对 → plan-commit 不写 text → 新文本全部蒸发，
  //   面板永远是旧条目（用户实测实证）；账本 changed=7 全是 note 覆写，看似成功实则空转。
  const cur = [
    item('搭建交付骨架：index.html 五态 DOM + styles.css 全量样式', 'cancelled'),
    item('实现 P0 核心：config/input/player/raycaster/main 状态机', 'cancelled'),
    item('实现 P0 战斗：entities/weapons/waves/hud', 'cancelled'),
  ]
  const r = diffPlan({
    current: cur,
    draft: [
      draft('搭建坦克大战项目骨架：目录结构与页面框架', 'doing'),
      draft('实现坦克移动 / 炮弹发射与碰撞检测', 'todo'),
      draft('实现敌人 AI 与波次刷新', 'todo'),
      draft('HUD 与音效接入', 'todo'),
    ],
  })
  assert.equal(createOps(r).length, 4, '四条全新工作必须全部 create（文本不被吞）')
  assert.equal(retextOps(r).length, 0, '完全不同的工作不得产生 retext（错配 = 静默改写别人的文本）')
  assert.equal(dropOps(r).length, 0, '旧项已终态 → 走终态保护，不 drop')
  assert.equal(r.protectedIds.length, 3, '三个旧终态项全部保留（用户不会以为它没做过）')
  // 布局：新 4 项在前（draft 顺序），旧 3 项保护性追加在末尾
  assert.deepEqual(
    r.layout.map((e) => e.kind),
    ['new', 'new', 'new', 'new', 'existing', 'existing', 'existing'],
  )
  for (let i = 0; i < 4; i++) {
    const e = r.layout[i]!
    assert.equal(e.kind === 'new' ? e.text : '', r.layout[i]!.kind === 'new' ? e.text : '')
  }
})

test('TC-PDIFF-016 D175 相似度门控边界：相似度阈值纯函数、单调合理（微调过线、异类不过线）', () => {
  assert.ok(PAIR_SIMILARITY_MIN > 0 && PAIR_SIMILARITY_MIN <= 0.2, '阈值必须放行 TC-PDIFF-006 的最弱配对（读代码↔读一遍代码 J=0.2）')
  assert.equal(textSimilarity('读代码', '读代码'), 1, '同文本 = 1')
  assert.equal(textSimilarity('读代码', '读一遍代码'), PAIR_SIMILARITY_MIN, '最弱契约配对恰好压线（J=1/5）')
  assert.ok(textSimilarity('写测试', '补测试') >= PAIR_SIMILARITY_MIN, '措辞微调必须过线（否则退化成全删全增）')
  assert.ok(
    textSimilarity('搭建交付骨架：index.html 五态 DOM + styles.css', '实现坦克移动与炮弹碰撞检测') <
      PAIR_SIMILARITY_MIN,
    '完全不同的工作必须不过线（否则错配）',
  )
  assert.ok(
    textSimilarity('实现 P0 核心逻辑', '实现 P0 核心逻辑（含配置加载）') >= PAIR_SIMILARITY_MIN,
    '同工作的扩充描述应过线',
  )
  // 纯函数：同输入同输出
  assert.equal(textSimilarity('甲项', '乙项'), textSimilarity('甲项', '乙项'))
})

test('TC-PDIFF-017 ★ D176 artifact 随 layout 透传：existing 覆盖声明、new 随项携带', () => {
  const art = { path: 'docs/out.html', kind: 'file' as const }
  const cur = [item('写文档', 'running'), item('跑冒烟', 'pending')]
  const r = diffPlan({
    current: cur,
    draft: [
      draft('写文档', 'done', '已产出', art),
      draft('跑冒烟', 'done', '全绿', { path: '', kind: 'command', check: 'npm test 退出码 0' }),
    ],
  })
  const e0 = r.layout[0]!
  assert.equal(e0.kind === 'existing' ? e0.artifact?.path : '', 'docs/out.html', 'existing 项携带 artifact 供 plan-commit 覆盖')
  const e1 = r.layout[1]!
  assert.equal(e1.kind === 'existing' ? e1.artifact?.kind : '', 'command')
  assert.equal(e1.kind === 'existing' ? e1.artifact?.check : '', 'npm test 退出码 0')

  // new 项同样携带
  const r2 = diffPlan({ current: [], draft: [draft('新项', 'todo', undefined, art)] })
  const n0 = r2.layout[0]!
  assert.equal(n0.kind === 'new' ? n0.artifact?.path : '', 'docs/out.html')
})
