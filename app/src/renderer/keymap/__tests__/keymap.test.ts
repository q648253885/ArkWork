/**
 * v0.31.0 B0 详测 — 键位中央化契约
 *
 * 依据：docs/versions/v0.31.0/04-system-design.md §5.4.1（键位注册表）
 *       docs/versions/v0.31.0/03-interaction.md §5.4/§5.5（键位裁决与总表）
 *       docs/versions/v0.31.0/testcases/00-cumulative-matrix.md §3.1（TC-KEY）
 * 用例：TC-KEY-001 … TC-KEY-010
 *
 * 手法：**只 import 纯模块**（spec / registry / context）—— 它们零 store、零 IPC、
 * 零 React 依赖，因此可以在 node:test 里直接断言注册表行为，不必退化成
 * 纯字符串匹配。仅 HelpCenter / i18n 两项因为「没有 DOM 渲染环境」才走源码契约。
 *
 * 运行（cwd=app）：
 *   node scripts/run-tests.mjs keymap
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { chordFromEvent, chordToDisplay, findChordCollisions, type Chord } from '@shared/utils/keys'
import { chordsOf, clearKeybindings, registerKeybinding, runDispatch, selectBindings } from '../registry'
import { resetContext, setContextKey, snapshotContext } from '../context'
import { KEYMAP_SPEC, MIGRATED_BRANCHES, PLANNED_SHARED_CHORDS, RESERVED_CHORDS } from '../spec'
import type { DispatchEvent, Keybinding, KeybindingSpec } from '../types'

/* ============================================================
 * 工具
 * ============================================================ */

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf-8')

/** 裸修饰键符号：U+2318 / U+2303 / U+2325 / U+21E7 */
const BARE_SYMBOLS = /[\u2318\u2303\u2325\u21e7]/

/** 全部声明的和弦（展平别名）—— 复用 registry 的 chordsOf，避免在此重复实现 */
function allSpecChords(): Chord[] {
  return KEYMAP_SPEC.flatMap((s) => chordsOf(s as KeybindingSpec))
}

/** 造一个合成绑定（用于测 registry 语义，不进产品键位表） */
function synthetic(id: string, chord: Chord, priority: number, handler: Keybinding['handler']): Keybinding {
  return { id, chord, priority, titleKey: `test.${id}`, group: 'global', handler, origin: 'default' }
}

/** 每个用例后清理，避免注册表与上下文互相污染 */
function cleanup(): void {
  clearKeybindings()
  resetContext()
}

/* ============================================================
 * 一、TC-KEY-001 迁移完备性：13 分支逐条落码，不多不少
 * ============================================================ */

test('TC-KEY-001 迁移前 App.tsx 的 13 个 keydown 分支逐条落到 KEYMAP_SPEC（双向无遗漏）', () => {
  // ① 分支数 = 13（迁移前实际为 13，非设计文档初稿所写的 10）
  assert.equal(MIGRATED_BRANCHES.length, 13, '迁移来源分支数应为 13')

  const specIds: string[] = KEYMAP_SPEC.map((s) => s.id)
  const declaredIds: string[] = MIGRATED_BRANCHES.flatMap((b) => [...b.ids])

  // ② 每个分支都至少映射到一条 id
  for (const b of MIGRATED_BRANCHES) {
    assert.ok(b.ids.length > 0, `分支 ${b.branch} 未映射任何键位 id`)
    assert.ok(b.before.length > 0, `分支 ${b.branch} 未记录迁移前的判定表达式`)
  }

  // ③ 双向完备：声明表 ⊆ 迁移映射，且迁移映射 ⊆ 声明表
  for (const id of specIds) {
    assert.ok(declaredIds.includes(id), `KEYMAP_SPEC 存在无迁移来源的键位：${id}`)
  }
  for (const id of declaredIds) {
    assert.ok(specIds.includes(id), `迁移分支映射了不存在的键位 id：${id}`)
  }

  // ④ id 全局唯一（注册表会拒绝重复，注册前先自证）
  assert.equal(new Set(specIds).size, specIds.length, 'KEYMAP_SPEC 存在重复 id')

  // ⑤ 每条声明必备字段齐全（titleKey 必须是 i18n key，禁止内联文案）
  for (const s of KEYMAP_SPEC) {
    assert.ok(s.id.trim().length > 0, '键位缺少 id')
    assert.ok(s.titleKey.startsWith('help.shortcuts.desc.') || s.titleKey.includes('.'), `titleKey 非 i18n key：${s.titleKey}`)
    assert.ok(['global', 'editor', 'region', 'inspector', 'help'].includes(s.group), `未知分组：${s.group}`)
    assert.equal(typeof s.priority, 'number', `priority 非数值：${s.id}`)
  }

  // ⑥ 键位总数出处：24 条（分支 10 / 11 各展开为 6 条，分支 1 为 2 个别名）
  assert.equal(KEYMAP_SPEC.length, 25, 'B0 键位声明应为 25 条')
})

/* ============================================================
 * 二、TC-KEY-002 三平台零撞键
 * ============================================================ */

test('TC-KEY-002 全部键位在 macOS 与非 macOS 上均零撞键（含别名与预留位）', () => {
  const chords = [...allSpecChords(), ...RESERVED_CHORDS.map((r) => r.chord)]

  for (const isMac of [true, false]) {
    const collisions = findChordCollisions(chords, isMac)
    assert.deepEqual(
      collisions,
      [],
      `${isMac ? 'macOS' : '非 macOS'} 上存在撞键：${JSON.stringify(collisions)}`,
    )
  }

  // 声明内部自身也不得重叠（别名之间亦然：Mod+/ 与 Mod+? 不得等价）
  for (const isMac of [true, false]) {
    assert.deepEqual(findChordCollisions(allSpecChords(), isMac), [], '同一键位内部别名撞键')
  }
})

/* ============================================================
 * 三、TC-KEY-003 预留位不被占用 + 既有三组键位互不重叠
 * ============================================================ */

test('TC-KEY-003 后续批次预留和弦未被 B0 占用，且既有三组键位互不重叠', () => {
  const specChords = allSpecChords()
  const reservedChords = RESERVED_CHORDS.map((r) => r.chord)

  // ① 预留位与现有键位零交集（撞键检测已覆盖，此处给出更直白的失败信息）
  for (const c of reservedChords) {
    const asChord = chordToDisplay(c, true)
    assert.ok(!specChords.includes(c), `预留和弦已被占用：${c}（${asChord}）`)
  }

  // ② 预留位自身无重复登记
  assert.equal(new Set(reservedChords).size, reservedChords.length, 'RESERVED_CHORDS 存在重复登记')
  for (const r of RESERVED_CHORDS) {
    assert.ok(r.batch.length > 0 && r.actionKey.length > 0, `预留位缺少批次/动作标注：${r.chord}`)
  }

  // ③ 本版新增键位**不含** Alt+Mod 组合（03-interaction §5.4：规避 AltGr 等价）
  for (const c of specChords) {
    assert.ok(!c.includes('Alt+Mod') && !c.includes('Mod+Alt'), `B0 键位不得含 Alt+Mod 组合：${c}`)
  }

  // ④ 三组既有键位「能力入口 / Inspector / 帮助」各自的数字位互不重叠
  const cap = specChords.filter((c) => /^Mod\+[1-6]$/.test(c))
  const insp = specChords.filter((c) => /^Alt\+[1-6]$/.test(c))
  const helpNum = specChords.filter((c) => /^Ctrl\+Alt\+[0-9]$/.test(c))
  assert.equal(cap.length, 6, '能力入口应为 Mod+1~6 共 6 条')
  assert.equal(insp.length, 6, 'Inspector 直达应为 Alt+1~6 共 6 条')
  assert.equal(helpNum.length, 0, 'B0 不应占用 Ctrl+Alt 数字位')
  assert.equal(new Set([...cap, ...insp]).size, 12, 'Mod+N 与 Alt+N 两组不得重叠')

  // ⑤ macOS 上 Mod 只认 Command（不接受 Control 代偿）—— 见 keys.ts 文件头的偏差登记
  const macK: DispatchEvent = { key: 'k', metaKey: true }
  const macCtrlK: DispatchEvent = { key: 'k', metaKey: false, ctrlKey: true }
  assert.deepEqual(chordFromEvent(macK), 'Mod+k')
  assert.deepEqual(chordFromEvent(macCtrlK), 'Ctrl+k')
})

/* ============================================================
 * 四、TC-KEY-004 `when` 门控：全部满足才可触发
 * ============================================================ */

test('TC-KEY-004 when 门控：空 when 无条件，非空 when 需全部满足', () => {
  cleanup()
  try {
    registerKeybinding(synthetic('t.any', 'Mod+Y', 0, () => undefined))
    registerKeybinding({ ...synthetic('t.editor', 'Mod+U', 0, () => undefined), when: ['editorFocused'] })
    registerKeybinding({ ...synthetic('t.two', 'Mod+I', 0, () => undefined), when: ['editorFocused', 'dirty'] })

    const emptyCtx = snapshotContext()
    assert.equal(selectBindings({ key: 'y', metaKey: true }, emptyCtx, true).length, 1, '空 when 应无条件命中')
    assert.equal(selectBindings({ key: 'u', metaKey: true }, emptyCtx, true).length, 0, 'when 未满足不得命中')
    assert.equal(selectBindings({ key: 'i', metaKey: true }, emptyCtx, true).length, 0, 'when 部分满足不得命中')

    setContextKey('editorFocused', true)
    const ctx1 = snapshotContext()
    assert.equal(selectBindings({ key: 'u', metaKey: true }, ctx1, true).length, 1, 'when 满足后应命中')
    assert.equal(selectBindings({ key: 'i', metaKey: true }, ctx1, true).length, 0, '两个条件只满足一个不得命中')

    setContextKey('dirty', true)
    assert.equal(selectBindings({ key: 'i', metaKey: true }, snapshotContext(), true).length, 1, '两个条件都满足应命中')

    // 复位后回到不满足（谁置位谁复位）
    setContextKey('editorFocused', false)
    setContextKey('dirty', false)
    assert.equal(getSnapshot('editorFocused'), false, '复位后应为 false')
    assert.equal(getSnapshot('dirty'), false, '复位后应为 false')
  } finally {
    cleanup()
  }
})

/** 本地小工具：读单个上下文键（走 snapshot 以复用同一真源） */
function getSnapshot(k: keyof ReturnType<typeof snapshotContext>): boolean {
  return snapshotContext()[k]
}

/* ============================================================
 * 五、TC-KEY-005 priority 消歧：同 when 下高优先级先命中
 * ============================================================ */

test('TC-KEY-005 同 when 下高 priority 先命中（窄作用域可覆盖宽作用域）', () => {
  cleanup()
  try {
    const calls: string[] = []
    registerKeybinding(synthetic('t.wide', 'Mod+L', 0, () => { calls.push('wide') }))
    registerKeybinding(synthetic('t.narrow', 'Mod+L', 10, () => { calls.push('narrow') }))

    const ctx = snapshotContext()
    const ordered = selectBindings({ key: 'l', metaKey: true }, ctx, true)
    assert.deepEqual(ordered.map((b) => b.id), ['t.narrow', 't.wide'], '应优先级降序排列')

    assert.equal(runDispatch({ key: 'l', metaKey: true }, ctx, true), true, '应被消费')
    assert.deepEqual(calls, ['narrow'], '高优先级应先执行且消费后不再继续')
  } finally {
    cleanup()
  }
})

/* ============================================================
 * 六、TC-KEY-006 handler 返回 false = 不消费，继续冒泡
 * ============================================================ */

test('TC-KEY-006 handler 返回 false 时不消费：继续尝试下一候选；全 false 时返回 false', () => {
  cleanup()
  try {
    const calls: string[] = []
    registerKeybinding(synthetic('t.high', 'Mod+M', 10, () => { calls.push('high'); return false }))
    registerKeybinding(synthetic('t.low', 'Mod+M', 0, () => { calls.push('low') }))

    const ctx = snapshotContext()
    assert.equal(runDispatch({ key: 'm', metaKey: true }, ctx, true), true, '低优先级消费后整体应返回 true')
    assert.deepEqual(calls, ['high', 'low'], 'false 应触发冒泡到下一候选')

    // 全部 false → 未消费（调用方据此不做 preventDefault）
    calls.length = 0
    clearKeybindings()
    registerKeybinding(synthetic('t.a', 'Mod+M', 0, () => { calls.push('a'); return false }))
    registerKeybinding(synthetic('t.b', 'Mod+M', 0, () => { calls.push('b'); return false }))
    assert.equal(runDispatch({ key: 'm', metaKey: true }, snapshotContext(), true), false, '全 false 应返回未消费')
    assert.deepEqual(calls, ['a', 'b'], '同优先级按注册顺序尝试，与迁移前 if 链自上而下一致')

    // 无候选 → 未消费（不拦）
    assert.equal(runDispatch({ key: 'z', metaKey: true }, snapshotContext(), true), false, '无候选不得消费')
  } finally {
    cleanup()
  }
})

/* ============================================================
 * 七、TC-KEY-007 `Mod+/` 焦点域分流的机制前提（裁决 ①）
 * ============================================================ */

test('TC-KEY-007 Mod+/ 由宽作用域（帮助）持有，编辑器可用高优先级 when 接管', () => {
  const shared = PLANNED_SHARED_CHORDS.find((s) => s.chord === 'Mod+/')
  assert.ok(shared, 'PLANNED_SHARED_CHORDS 应登记 Mod+/ 的分流计划')

  const holder = KEYMAP_SPEC.find((s) => s.id === shared?.currentId) as KeybindingSpec | undefined
  assert.ok(holder, `当前持有者不存在：${shared?.currentId}`)
  assert.ok(
    !holder?.when || holder.when.length === 0,
    'B0 阶段帮助键位必须是宽作用域（无 when），否则 B2 无法用 editorFocused 覆盖',
  )
  assert.ok(
    shared?.takeover.when.includes('editorFocused'),
    '接管条件应为 editorFocused（正本裁决 ①：编辑器内为行注释）',
  )

  cleanup()
  try {
    // 机制自证：同和弦、窄 when、高优先级 → 仅在上下文满足时胜出
    registerKeybinding(synthetic('t.wide', 'Mod+/', 0, () => undefined))
    registerKeybinding({ ...synthetic('t.narrow', 'Mod+/', 10, () => undefined), when: ['editorFocused'] })

    const off = selectBindings({ key: '/', metaKey: true }, snapshotContext(), true)
    assert.deepEqual(off.map((b) => b.id), ['t.wide'], '未聚焦编辑器时应由宽作用域胜出')

    setContextKey('editorFocused', true)
    const on = selectBindings({ key: '/', metaKey: true }, snapshotContext(), true)
    assert.deepEqual(on.map((b) => b.id), ['t.narrow', 't.wide'], '聚焦编辑器时应由窄作用域先胜出')
  } finally {
    cleanup()
  }
})

/* ============================================================
 * 八、TC-KEY-008 `Mod+G` 让位：「查找下一个」不被抢，跳转行用 Ctrl+G
 * ============================================================ */

test('TC-KEY-008 Mod+G 全表零占用（macOS 系统级查找下一个），跳转行登记为 Ctrl+G', () => {
  const specChords = allSpecChords()
  const reserved = RESERVED_CHORDS.map((r) => r.chord)

  assert.ok(!specChords.includes('Mod+G'), 'Mod+G 不得被 B0 键位占用')
  assert.ok(!reserved.includes('Mod+G'), 'Mod+G 不得被任何批次预留')

  const gotoLine = RESERVED_CHORDS.find((r) => r.actionKey === 'editor.gotoLine')
  assert.ok(gotoLine, '跳转行应登记在预留表')
  assert.equal(gotoLine?.chord, 'Ctrl+G', '跳转行必须用 Ctrl+G')
  assert.equal(gotoLine?.batch, 'B2', '跳转行随编辑器内核（B2）落地')

  // Ctrl 系写法在 macOS 上不得被 Mod 吞掉 —— 见 keys.ts 的精确匹配说明
  assert.notDeepEqual(chordFromEvent({ key: 'g', metaKey: true }), chordFromEvent({ key: 'g', ctrlKey: true }))
})

/* ============================================================
 * 九、TC-KEY-009 帮助中心改为从注册表读（源码契约）
 * ============================================================ */

test('TC-KEY-009 HelpCenter 从注册表读键位表，不再硬编码和弦', () => {
  const HELP = read('../../components/HelpCenter.tsx')

  // ① 不再有硬编码的 `{ keys: '...', desc: ... }` 列表（迁移前 22 行）
  assert.doesNotMatch(HELP, /keys:\s*'/, 'HelpCenter 不应再硬编码和弦串')

  // ② 从 keymap 取数据与展示
  assert.match(HELP, /from '\.\.\/keymap'/, 'HelpCenter 应从 keymap 公共出口取键位')
  assert.match(HELP, /listKeybindings\s*\(/, 'HelpCenter 应调用 listKeybindings() 取键位')
  // 展示串经 chordsText()（纯函数，可安全用于 .map）；useChord() 为单值场景备选
  assert.match(HELP, /(chordsText|useChords?)\s*\(/, 'HelpCenter 应用 chordsText()/useChord() 渲染和弦')

  // ③ 帮助中心内的和弦文案不得内联 —— 一律经 keymap 产出
  assert.doesNotMatch(HELP, BARE_SYMBOLS, 'HelpCenter 内不得出现裸修饰键符号')

  // ④ 迁移前那条「Mod+?」提示与实现不一致（实现要求 !shiftKey，美式布局下永不触发）；
  //    本版按实现为准登记 Mod+? 别名，两者都在注册表里，故帮助中心应能取到 2 条 help 组键位
  const helpGroup = KEYMAP_SPEC.filter((s) => s.group === 'help')
  assert.equal(helpGroup.length, 2, 'help 组应含 Mod+/ 与 Mod+? 两条')

  // ⑤ B0 修正了迁移前的两处漏列：Alt+6 终端与 Shift+Tab 权限循环都必须出现在总表里
  assert.match(HELP, /listKeybindings/, '总表应为注册表全量，而非手写字面量')
  assert.equal(KEYMAP_SPEC.filter((s) => s.id === 'inspector.tab.terminal').length, 1, '终端键位应入表')
  assert.equal(KEYMAP_SPEC.filter((s) => s.id === 'permission.cycle').length, 1, '权限循环键位应入表')
})

/* ============================================================
 * 十、TC-KEY-010 全量零裸修饰键符号
 * ============================================================ */

test('TC-KEY-010 键位域与 i18n 内零裸修饰键符号（U+2318/U+2303/U+2325/U+21E7）', () => {
  // ① 键位域自身（keymap 全目录 + keys.ts 纯函数）
  const keymapDir = fileURLToPath(new URL('../', import.meta.url))
  const keymapFiles = readdirSync(keymapDir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.tsx?$/.test(e.name))
    .map((e) => `../${e.name}`)
  keymapFiles.push('../__tests__/keymap.test.ts')
  keymapFiles.push('../../../shared/utils/keys.ts')
  for (const rel of keymapFiles) {
    const src = read(rel.startsWith('..') ? rel : `../${rel}`)
    assert.doesNotMatch(src, BARE_SYMBOLS, `${rel} 内出现裸修饰键符号`)
  }

  // ② 4 语言键位文案：新增/迁移的 help.describe 与 aria 一律用 {{kbd}} 插值
  const locales = ['zh', 'en', 'ja', 'ko'] as const
  for (const loc of locales) {
    const json = read(`../../i18n/locales/${loc}.json`)
    assert.doesNotMatch(json, BARE_SYMBOLS, `i18n ${loc}.json 内出现裸修饰键符号`)

    // 本版新增的两条键位说明必须存在（4 语言对等）
    assert.match(json, /"permissionCycle"\s*:/, `${loc}.json 缺 help.shortcuts.desc.permissionCycle`)
    assert.match(json, /"inspTerminal"\s*:/, `${loc}.json 缺 help.shortcuts.desc.inspTerminal`)

    // 迁移前带裸符号的 aria 文案应已改为插值
    assert.match(json, /\{\{kbd\}\}/, `${loc}.json 应使用 {{kbd}} 插值承载和弦`)
  }

  // ③ 反向保证：chordToDisplay 是符号的唯一产出点，且平台分支正确
  assert.equal(chordToDisplay('Mod+K', false), 'Ctrl+K')
  assert.equal(chordToDisplay('Mod+Shift+W', false), 'Ctrl+Shift+W')
  assert.match(chordToDisplay('Mod+K', true), /K$/)
  assert.notEqual(chordToDisplay('Mod+K', true), 'Ctrl+K')
  assert.equal(chordToDisplay('Escape', false), 'Esc')
  assert.equal(chordToDisplay('Escape', true), 'Esc')
  assert.equal(chordToDisplay('Shift+Tab', false), 'Shift+Tab')
})

/* ============================================================
 * v0.31.1 追加 — Windows Mod 匹配回归（TC-KEY-011..013）
 *
 * 缺陷：matchesChord 旧实现对 `Mod+K`（p.ctrl=false）比较
 * `p.ctrl !== e.ctrlKey`，Windows 上按 Ctrl+K 时 e.ctrlKey=true
 * → 恒不匹配，全部 Mod 和弦在 Windows 失效（用户实测）。
 * 修复：非 macOS 上把 Mod 合并进物理 Ctrl 位（needCtrl = mod||ctrl），
 * 与 canonicalChord「Mod/Ctrl 退化同格」口径一致。
 * ============================================================ */
test('TC-KEY-011 Windows 上 Ctrl+K 匹配 Mod+K（本缺陷主场景）', async () => {
  const { matchesChord } = await import('@shared/utils/keys')
  assert.equal(matchesChord('Mod+K', { key: 'k', ctrlKey: true }, false), true)
  assert.equal(matchesChord('Mod+Shift+W', { key: 'w', ctrlKey: true, shiftKey: true }, false), true)
  assert.equal(matchesChord('Mod+,', { key: ',', ctrlKey: true }, false), true)
})

test('TC-KEY-012 Windows 匹配仍保持修饰键精确性（多按即不匹配）', async () => {
  const { matchesChord } = await import('@shared/utils/keys')
  // Mod+K 不被 Mod+Shift+K 满足
  assert.equal(matchesChord('Mod+K', { key: 'k', ctrlKey: true, shiftKey: true }, false), false)
  // 不按 Ctrl 不匹配
  assert.equal(matchesChord('Mod+K', { key: 'k' }, false), false)
  // 显式 Ctrl 和弦在 Windows 上仍匹配物理 Ctrl
  assert.equal(matchesChord('Ctrl+G', { key: 'g', ctrlKey: true }, false), true)
})

test('TC-KEY-013 macOS 语义回归：Cmd 命中 Mod、物理 Ctrl 不代偿（B0 刻意偏差不变）', async () => {
  const { matchesChord } = await import('@shared/utils/keys')
  assert.equal(matchesChord('Mod+K', { key: 'k', metaKey: true }, true), true)
  // Control+K 不代偿 Mod+K（B0 刻意登记的迁移偏差）
  assert.equal(matchesChord('Mod+K', { key: 'k', ctrlKey: true }, true), false)
})
