/* ============================================================
 * v0.32.0 — Profile 视图投影契约（TC-PVIEW-001..006）
 *
 * 为什么单独在这里把守：`profileSlice` 顶层经 ipc/client 读 window、
 * 经 store/meta 读 import.meta.env，node:test 无法导入 —— 而「快照 ui 层
 * → 视图三字段」恰恰是最容易被写错的转换。因此把它抽成纯模块
 * （`renderer/utils/profile-view.ts`）后密闭覆盖。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs profile-view
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blockingDegradations, projectUiLayer, warningCount } from '../profile-view.js'
import type { CompositionSnapshot, Degradation } from '@shared/types/profile'

function snap(ui: CompositionSnapshot['layers']['ui'], degraded: Degradation[] = []): CompositionSnapshot {
  return {
    profileId: 'wb.x',
    profileVersion: '1.0.0',
    resolvedAt: 1700000000000,
    layers: { agents: [], tools: [], ui },
    degraded,
  }
}

test('TC-PVIEW-001 无快照 → 视图字段全为「不覆盖」空态（不得凭空生成 UI）', () => {
  // v0.36.0（B11/P3-b）：新增 pluginRefs 投影字段（null = 未声明不过滤）
  assert.deepEqual(projectUiLayer(null), {
    dockTabs: null,
    homeModule: null,
    composerChips: [],
    pluginRefs: null,
  })
})

test('TC-PVIEW-007 ★ v0.36.0（B11/P3-b）：ui.pluginRefs 快照行 → 白名单投影', () => {
  // applied=true 且非空 → 白名单生效
  const v = projectUiLayer(snap([{ slot: 'ui.pluginRefs', value: 'ark.plugin.git-manager', applied: true }]))
  assert.deepEqual(v.pluginRefs, ['ark.plugin.git-manager'])
  // applied=true 且 value 空串 → 显式空数组（全部隐藏），与未声明可区分
  const empty = projectUiLayer(snap([{ slot: 'ui.pluginRefs', value: '', applied: true }]))
  assert.deepEqual(empty.pluginRefs, [])
  // applied=false → 未声明（不过滤）
  const off = projectUiLayer(snap([{ slot: 'ui.pluginRefs', value: 'x', applied: false }]))
  assert.equal(off.pluginRefs, null)
})

test('TC-PVIEW-002 applied=false 的 ui 项必须被跳过（没生效就不能给 UI 用）', () => {
  const v = projectUiLayer(
    snap([
      { slot: 'ui.dockTabs', value: 'files,terminal', applied: false },
      { slot: 'ui.homeModule', value: 'kb', applied: false },
      { slot: 'ui.composerChips', value: 'a,b', applied: false },
    ]),
  )
  assert.equal(v.dockTabs, null)
  assert.equal(v.homeModule, null)
  assert.deepEqual(v.composerChips, [])
})

test('TC-PVIEW-003 dockTabs 逗号串 → 数组；空值不覆盖（留给用户/智能体偏好）', () => {
  const v = projectUiLayer(snap([{ slot: 'ui.dockTabs', value: 'files,terminal,todos', applied: true }]))
  assert.deepEqual(v.dockTabs, ['files', 'terminal', 'todos'])
  const empty = projectUiLayer(snap([{ slot: 'ui.dockTabs', value: '', applied: true }]))
  assert.equal(empty.dockTabs, null)
})

test('TC-PVIEW-004 homeModule 越界值不得投影（Unknown module 会让 CenterStage 白屏）', () => {
  const ok = projectUiLayer(snap([{ slot: 'ui.homeModule', value: 'memory', applied: true }]))
  assert.equal(ok.homeModule, 'memory')
  const bad = projectUiLayer(snap([{ slot: 'ui.homeModule', value: 'portfolio', applied: true }]))
  assert.equal(bad.homeModule, null)
})

test('TC-PVIEW-005 composerChips 截断在 8 条内并丢弃空串', () => {
  const many = Array.from({ length: 12 }, (_, i) => `chip${i}`).join(',')
  const v = projectUiLayer(snap([{ slot: 'ui.composerChips', value: `,${many},`, applied: true }]))
  assert.equal(v.composerChips.length, 8)
  assert.ok(!v.composerChips.includes(''))
})

test('TC-PVIEW-006 blocking 拆分：红点=阻断（会导致激活失败），橙点=非阻断降级', () => {
  const degraded: Degradation[] = [
    { layer: 'tools', ref: 'S-core.ghost', reason: '必需技能未安装', blocking: true },
    { layer: 'tools', ref: 'S-core.other', reason: '技能未安装', blocking: false },
    { layer: 'ui', ref: '0 9 * * 1-5', reason: '示例非阻断项', blocking: false },
  ]
  const s = snap([], degraded)
  assert.equal(blockingDegradations(s).length, 1)
  assert.equal(blockingDegradations(s)[0]!.ref, 'S-core.ghost')
  assert.equal(warningCount(s), 2)
  assert.equal(blockingDegradations(null).length, 0)
  assert.equal(warningCount(null), 0)
})
