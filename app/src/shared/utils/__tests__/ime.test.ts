/* ============================================================
 * v0.26.x — isImeComposing 单测
 *
 * 背景：拼音输入法组合期间按回车（确认上屏）被误判为「发送」，
 * 用户中文输一半消息就飞了。isImeComposing 是三个输入位
 * （Composer / RunConsole 追加指令 / ask_user 自定义回答）共用的守卫。
 *
 * 验收标准（用户原话）：
 * ① 拼音组合中回车 → 只上屏，不发送（守卫命中）
 * ② 英文模式单回车 → 直接发送（守卫不命中，一次回车即可）
 *
 * 运行（cwd=app）：./node_modules/.bin/tsx --test src/shared/utils/__tests__/ime.test.ts
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isImeComposing } from '../ime.js'

/* ---------- 1. 组合态 → 必须命中守卫（事件归输入法） ---------- */

test('isImeComposing: 拼音确认回车（isComposing=true）→ 命中', () => {
  assert.equal(isImeComposing({ isComposing: true, keyCode: 13 }), true)
})

test('isImeComposing: 老式浏览器组合态（keyCode=229，isComposing 缺省）→ 命中', () => {
  assert.equal(isImeComposing({ keyCode: 229 }), true)
})

test('isImeComposing: 组合中方向键候选翻页（isComposing=true）→ 命中', () => {
  assert.equal(isImeComposing({ isComposing: true, keyCode: 40 }), true)
})

test('isImeComposing: 组合中 Esc 取消（isComposing=true）→ 命中', () => {
  assert.equal(isImeComposing({ isComposing: true, keyCode: 27 }), true)
})

/* ---------- 2. 非组合态 → 守卫必须放行（英文模式单回车直接发送） ---------- */

test('isImeComposing: 英文模式普通回车（isComposing=false, keyCode=13）→ 不命中', () => {
  assert.equal(isImeComposing({ isComposing: false, keyCode: 13 }), false)
})

test('isImeComposing: 原生事件无 isComposing 字段且 keyCode=13（老环境兜底）→ 不命中', () => {
  assert.equal(isImeComposing({ keyCode: 13 }), false)
})

test('isImeComposing: Shift+Enter 换行（非组合态）→ 不命中，换行逻辑不受影响', () => {
  assert.equal(isImeComposing({ isComposing: false, keyCode: 13 }), false)
})

test('isImeComposing: 拼音上屏后的第二次回车（isComposing=false）→ 不命中，此时应发送', () => {
  assert.equal(isImeComposing({ isComposing: false, keyCode: 13 }), false)
})

/* ---------- 3. 形状兼容 ---------- */

test('isImeComposing: 空对象（字段全缺省）→ 不命中（宁可多发不误吞正常输入的反向风险由类型约束）', () => {
  assert.equal(isImeComposing({}), false)
})
