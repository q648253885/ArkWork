/* ============================================================
 * ArkWork — 展示名防御（v0.34.0 · D54 · TC-LBL-001..010）
 * 规格来源：docs/versions/v0.34.0/04-system-design.md §6.4 / §6.5
 *
 * 用户实测缺陷：竖排栏插件标签悬停 tip 出 `{{titile}}`。
 * 本组钉住两条防线的**不同力度**：
 *   guardLabel     竖排栏：模板防御 + 8 字符截断（屏幕只有 44px）
 *   guardBodyTitle 面板正文：**只**防模板串，**不**截断（宽度充足）
 * 把正文也截断是纯损失 —— 「工作台与插件指南」会被砍成「工作台与插件指…」。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs label-guard
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RAIL_LABEL_MAX_CHARS,
  UNRESOLVED_TEMPLATE_RE,
  guardBodyTitle,
  guardLabel,
  hasUnresolvedTemplate,
} from '../label-guard.js'

/** 静音 console.warn（这些函数会告警，测试输出不必被刷屏） */
function silencingWarn<T>(fn: () => T): { value: T; warns: string[] } {
  const warns: string[] = []
  const orig = console.warn
  console.warn = (...a: unknown[]) => {
    warns.push(a.map(String).join(' '))
  }
  try {
    return { value: fn(), warns }
  } finally {
    console.warn = orig
  }
}

test('TC-LBL-001 未解析模板串识别：{{…}} 各种形态', () => {
  assert.equal(hasUnresolvedTemplate('{{titile}}'), true)
  assert.equal(hasUnresolvedTemplate('来自插件的面板：{{title}}'), true, '内嵌在句中也要认出来')
  assert.equal(hasUnresolvedTemplate('{{ label }}'), true, '允许内部空格')
  assert.equal(hasUnresolvedTemplate('{{标题}}'), true, '允许中文变量名')
  assert.equal(hasUnresolvedTemplate('{{a}}{{b}}'), true, '多占位符')
  assert.equal(hasUnresolvedTemplate('正常名称'), false)
  assert.equal(hasUnresolvedTemplate('{单花括号}'), false, '单花括号不是 i18n 模板')
  assert.equal(hasUnresolvedTemplate(''), false)
  assert.equal(hasUnresolvedTemplate(null), false)
  assert.equal(hasUnresolvedTemplate(undefined), false)
  assert.equal(UNRESOLVED_TEMPLATE_RE.source.length > 0, true)
})

test('TC-LBL-002 ★ 竖排栏：模板串原样保留线索 + 截断（不静默替换成空）', () => {
  const { value, warns } = silencingWarn(() => guardLabel('{{titile}}'))
  assert.equal(value, '{{titil…', '必须原样截断保留线索 —— 换成空串会把上游缺陷藏起来')
  assert.equal(warns.length, 1, '必须留 warn 便于定位上游')
  assert.match(warns[0]!, /未解析模板占位符/)
})

test('TC-LBL-003 竖排栏：8 字符以内原样（短标签不该被加省略号）', () => {
  for (const s of ['文件', '日志', '浏览器', '插件指南', '12345678']) {
    assert.equal(guardLabel(s), s, `「${s}」长度 ${s.length} ≤ ${RAIL_LABEL_MAX_CHARS}，应原样`)
  }
})

test('TC-LBL-004 竖排栏：超 8 字符 → 7 字 + 省略号（截断后总长恰等于上限）', () => {
  assert.equal(RAIL_LABEL_MAX_CHARS, 8)
  // 恰好 8 字 → 原样（边界属于「不截断」一侧，与 TC-LBL-003 同一口径）
  assert.equal(guardLabel('工作台与插件指南'), '工作台与插件指南')
  const out = guardLabel('工作台与插件指南针') // 9 字
  assert.equal(out, '工作台与插件指…')
  assert.equal(out.length, RAIL_LABEL_MAX_CHARS, '截断后总长必须等于上限（含省略号）')
  assert.equal(guardLabel('一二三四五六七八九'), '一二三四五六七…', '取前 7 字符 + 省略号')
  assert.equal(guardLabel('123456789').length, RAIL_LABEL_MAX_CHARS)
})

test('TC-LBL-005 竖排栏：脏输入不抛错（undefined / null / 空串）', () => {
  assert.equal(guardLabel(''), '')
  assert.equal(guardLabel(undefined as unknown as string), '')
  assert.equal(guardLabel(null as unknown as string), '')
})

test('TC-LBL-006 ★ 正文：模板串只告警、**不改字**（正文不做长度截断）', () => {
  const long = '工作台与插件指南（含面板 / 渲染器 / 动作 / 首页模块 / 主题五类插槽说明）'
  assert.equal(guardBodyTitle(long), long, '正文标题绝不能截断 —— 宽度由用户拖拽决定，没有 44px 硬约束')
  const { value, warns } = silencingWarn(() => guardBodyTitle('{{title}}'))
  assert.equal(value, '{{title}}', '正文同样原样保留线索')
  assert.equal(warns.length, 1)
  assert.match(warns[0]!, /面板标题/)
})

test('TC-LBL-007 正文：正常标题不产生任何告警（避免把 warn 通道刷成噪音）', () => {
  const { warns } = silencingWarn(() => guardBodyTitle('运行时指标'))
  assert.deepEqual(warns, [])
})

test('TC-LBL-008 两条防线力度对照（同一输入两种输出 —— 防止未来被「统一」掉）', () => {
  const input = '{{titile}}' // 用户实测的那一串
  const rail = silencingWarn(() => guardLabel(input)).value
  const body = silencingWarn(() => guardBodyTitle(input)).value
  assert.notEqual(rail, body, '竖排栏与正文的截断力度**刻意不同**，不得合并成一个函数')
  assert.equal(rail.length, RAIL_LABEL_MAX_CHARS, '竖排栏受 8 字符硬约束')
  assert.equal(body, input, '正文只防模板、不限长度')
})

test('TC-LBL-009 幂等：对已截断结果再调用不变形（防止二次截断吃掉内容）', () => {
  const once = guardLabel('工作台与插件指南')
  assert.equal(guardLabel(once), once, '已 ≤8 字符，再次调用必须原样')
  const body = guardBodyTitle('运行时指标')
  assert.equal(guardBodyTitle(body), body)
})

test('TC-LBL-010 竖排栏：中文按字符计（不按字节 —— 否则 3 个中文就被砍）', () => {
  assert.equal(guardLabel('数据表'), '数据表', '3 个汉字 = 3 字符，必须原样')
  assert.equal(guardLabel('运行时指标'), '运行时指标', '5 字原样')
  assert.equal(guardLabel('K 线渲染器'), 'K 线渲染器', '含拉丁字母与空格，按字符计')
})
