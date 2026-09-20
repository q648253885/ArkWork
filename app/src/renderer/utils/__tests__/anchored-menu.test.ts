/* ============================================================
 * ArkWork — 锚定弹层定位计算（TC-AMEN 组）
 * 规格来源：docs/versions/v0.34.3/04-system-design.md §D59（规则 R1–R6）
 *
 * 为什么单独成组：「更多」弹层在 v0.34.2 装到用户机上时**点不开** ——
 * 它用 `absolute right-full` 渲染在 `overflow-x: hidden` 的栏盒内部，
 * 向容器左侧伸出的部分被裁成零宽。修法的一半就是本模块：把
 * 「触发器矩形 + 视口」换算成 `position: fixed` 的定位片段，
 * 让弹层的坐标不再寄生于任何会被裁切的祖先。
 *
 * 纯函数、零 DOM —— 用真值表把 R1–R6 逐条钉死。
 * 运行（cwd=app）：node scripts/run-tests.mjs anchored-menu
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MENU_DEFAULT_FLIP_RATIO,
  MENU_DEFAULT_GAP,
  MENU_DEFAULT_MARGIN,
  MENU_DEFAULT_MIN_HEIGHT,
  computeAnchoredMenu,
} from '../anchored-menu.js'

/** 本处真实几何：1200×800 视口，44px 宽竖排栏贴在最右 → 触发器左缘 x=1156 */
const VIEWPORT = { width: 1200, height: 800 }
const RAIL_RECT = { top: 700, bottom: 736, left: 1156, right: 1200 }

test('TC-AMEN-001 R1 右对齐触发器左缘：right = 视口宽 − 触发器左缘 + gap', () => {
  const { style } = computeAnchoredMenu(RAIL_RECT, VIEWPORT)
  // 1200 − 1156 + 4 = 48 ⇒ 弹层右缘落在 x = 1200 − 48 = 1152 = 1156 − 4
  assert.equal(style.right, 48)
  assert.equal(VIEWPORT.width - style.right, RAIL_RECT.left - MENU_DEFAULT_GAP)
})

test('TC-AMEN-002 R1 横向夹取：触发器贴最左时弹层也不会整块跑到视口之外', () => {
  const { style } = computeAnchoredMenu({ top: 10, bottom: 46, left: 0, right: 44 }, VIEWPORT)
  assert.ok(
    style.right <= VIEWPORT.width - MENU_DEFAULT_MARGIN,
    `right=${style.right} 必须 ≤ ${VIEWPORT.width - MENU_DEFAULT_MARGIN}`,
  )
  assert.ok(style.right >= MENU_DEFAULT_MARGIN, 'right 不得小于留白')
  // 右缘仍留在视口内（弹层不会 100% 消失）
  assert.ok(VIEWPORT.width - style.right >= 0)
})

test('TC-AMEN-003 R2/R3 触发器在下半屏 → 向上展开（锚 bottom，不出现 top）', () => {
  const { side, style } = computeAnchoredMenu(RAIL_RECT, VIEWPORT)
  assert.equal(side, 'up', '736 > 800×0.6=480 ⇒ 向上')
  assert.equal(style.position, 'fixed')
  assert.equal(style.bottom, VIEWPORT.height - RAIL_RECT.bottom)
  assert.equal(style.bottom, 64)
  assert.equal(style.top, undefined, '向上展开不得同时锚 top')
})

test('TC-AMEN-004 R2/R4 触发器在上半屏 → 向下展开（锚 top，不出现 bottom）', () => {
  const rect = { top: 100, bottom: 136, left: 1156, right: 1200 }
  const { side, style } = computeAnchoredMenu(rect, VIEWPORT)
  assert.equal(side, 'down', '136 ≤ 480 ⇒ 向下')
  assert.equal(style.top, rect.top)
  assert.equal(style.bottom, undefined, '向下展开不得同时锚 bottom')
})

test('TC-AMEN-005 R5 向上展开的 maxHeight = 触发器底边 − 留白', () => {
  const { style } = computeAnchoredMenu(RAIL_RECT, VIEWPORT)
  assert.equal(style.maxHeight, RAIL_RECT.bottom - MENU_DEFAULT_MARGIN)
  assert.equal(style.maxHeight, 728)
})

test('TC-AMEN-006 R5 向下展开的 maxHeight = 视口高 − 触发器顶边 − 留白', () => {
  const rect = { top: 100, bottom: 136, left: 1156, right: 1200 }
  const { style } = computeAnchoredMenu(rect, VIEWPORT)
  assert.equal(style.maxHeight, VIEWPORT.height - rect.top - MENU_DEFAULT_MARGIN)
  assert.equal(style.maxHeight, 692)
})

test('TC-AMEN-007 R5 空间不足时保底：maxHeight 不低于 minHeight（弹层内部滚动，不塌成 0）', () => {
  const { style } = computeAnchoredMenu(
    { top: 60, bottom: 90, left: 1156, right: 1200 },
    { width: 1200, height: 100 },
  )
  assert.equal(style.maxHeight, MENU_DEFAULT_MIN_HEIGHT, '可用 82 < 下限 120 → 取下限')
  assert.ok(style.maxHeight > 0)
})

test('TC-AMEN-008 缺省参数生效：gap=4 / margin=8 / minHeight=120 / flipRatio=0.6', () => {
  assert.equal(MENU_DEFAULT_GAP, 4)
  assert.equal(MENU_DEFAULT_MARGIN, 8)
  assert.equal(MENU_DEFAULT_MIN_HEIGHT, 120)
  assert.equal(MENU_DEFAULT_FLIP_RATIO, 0.6)

  const rect = { top: 100, bottom: 136, left: 1156, right: 1200 }
  const noOpts = computeAnchoredMenu(rect, VIEWPORT)
  const explicit = computeAnchoredMenu(rect, VIEWPORT, {
    gap: MENU_DEFAULT_GAP,
    margin: MENU_DEFAULT_MARGIN,
    minHeight: MENU_DEFAULT_MIN_HEIGHT,
    flipRatio: MENU_DEFAULT_FLIP_RATIO,
  })
  assert.deepEqual(noOpts, explicit, '不传 options 应与显式传缺省值完全一致')
  assert.equal(noOpts.style.right, 48, '仍按 gap=4 对齐')
})

test('TC-AMEN-009 自定义选项生效：gap / margin / flipRatio 都可覆盖', () => {
  // bottom=300：可用 300−20=280 > 下限 120，才能直接断言 maxHeight 的公式
  const rect = { top: 264, bottom: 300, left: 1156, right: 1200 }
  const { side, style } = computeAnchoredMenu(rect, VIEWPORT, {
    gap: 12,
    margin: 20,
    flipRatio: 0.1, // 300 > 800×0.1 = 80 ⇒ 翻转成向上
  })
  assert.equal(style.right, VIEWPORT.width - rect.left + 12, 'gap 覆盖生效')
  assert.equal(side, 'up', 'flipRatio 覆盖生效')
  assert.equal(style.maxHeight, rect.bottom - 20, 'margin 覆盖生效')
})

test('TC-AMEN-010 R6 输出取整：小数输入不产生半像素坐标', () => {
  const { style } = computeAnchoredMenu(
    { top: 700.6, bottom: 736.4, left: 1155.7, right: 1200 },
    VIEWPORT,
  )
  assert.equal(style.right, 48, 'clamp(48.3) → 48')
  assert.equal(style.bottom, 64, 'round(63.6) → 64')
  assert.equal(style.maxHeight, 728, 'round(728.4) → 728')
  for (const [k, v] of Object.entries(style)) {
    if (typeof v === 'number') assert.ok(Number.isInteger(v), `${k}=${v} 必须是整数`)
  }
})

test('TC-AMEN-011 非法输入兜底：NaN / 缺字段 / 零视口 → 不抛错、不返回 undefined', () => {
  const bad = computeAnchoredMenu(
    { top: Number.NaN, bottom: Number.NaN, left: Number.NaN, right: Number.NaN },
    { width: Number.NaN, height: Number.NaN },
  )
  assert.ok(bad && typeof bad === 'object')
  assert.ok(bad.side === 'up' || bad.side === 'down')
  assert.equal(bad.style.position, 'fixed')
  assert.ok(Number.isFinite(bad.style.right))
  assert.ok(bad.style.maxHeight >= MENU_DEFAULT_MIN_HEIGHT)

  // 视口整体缺失（防御性：真实调用来自 window，但渲染路径上不许抛错）
  const noViewport = computeAnchoredMenu(RAIL_RECT, undefined as unknown as { width: number; height: number })
  assert.equal(noViewport.style.position, 'fixed')
  assert.ok(Number.isFinite(noViewport.style.right))

  // 零尺寸视口：仍给出可用下限，而不是 0/负数
  const zero = computeAnchoredMenu(RAIL_RECT, { width: 0, height: 0 })
  assert.ok(zero.style.maxHeight >= MENU_DEFAULT_MIN_HEIGHT, '不得塌成 0')
  assert.ok(Number.isFinite(zero.style.right))
})

test('TC-AMEN-012 契约：返回体只含 side 与 style，且 style.position 恒为 fixed', () => {
  const out = computeAnchoredMenu(RAIL_RECT, VIEWPORT)
  assert.deepEqual(Object.keys(out).sort(), ['side', 'style'])
  assert.equal(out.style.position, 'fixed')
  // fixed ≠ absolute：这正是「逃出 overflow 裁切」的关键，不得被改回
  assert.notEqual(out.style.position, 'absolute')
})
