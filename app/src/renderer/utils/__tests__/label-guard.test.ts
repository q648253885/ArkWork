/* ============================================================
 * ArkWork — 展示名防御（v0.34.0 · D54 · TC-LBL-001..010）
 *               v0.36.0 · D91：两档 → 三档 · TC-LBL-011..014
 * 规格来源：docs/versions/v0.34.0/04-system-design.md §6.4 / §6.5
 *           docs/versions/v0.36.0/04-system-design.md §7（D91）
 *
 * 用户实测缺陷（v0.34.0）：竖排栏插件标签悬停 tip 出 `{{titile}}`。
 * 用户复报（v0.36.0）：竖排栏标签「最多三个字」—— 实机量到插件项
 *   「Git Man…」内容宽 52px / 渲染宽 37px，被裁切而不是省略。
 *
 * 本组钉住三条防线的**不同力度**（刻意不同，防止被「统一」掉）：
 *   guardRailLabel 竖排栏    ：模板防御 + **3** 字（44px 栏宽的硬约束）
 *   guardLabel     横向条    ：模板防御 + **8** 字（更多弹层 / 插件来源条）
 *   guardBodyTitle 面板正文  ：**只**防模板串，**不**截断（宽度充足）
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BAR_LABEL_MAX_CHARS,
  RAIL_LABEL_MAX_CHARS,
  UNRESOLVED_TEMPLATE_RE,
  guardBodyTitle,
  guardLabel,
  guardRailLabel,
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
  const { value, warns } = silencingWarn(() => guardRailLabel('{{titile}}'))
  assert.equal(value, '{{…', '必须原样截断保留线索 —— 换成空串会把上游缺陷藏起来')
  assert.equal(warns.length, 1, '必须留 warn 便于定位上游')
  assert.match(warns[0]!, /未解析模板占位符/)
})

test('TC-LBL-003 竖排栏：3 字以内原样（短标签不该被加省略号）', () => {
  for (const s of ['文件', '日志', '浏览器', 'Git', '123']) {
    assert.equal(guardRailLabel(s), s, `「${s}」长度 ${s.length} ≤ ${RAIL_LABEL_MAX_CHARS}，应原样`)
  }
})

test('TC-LBL-004 ★ 竖排栏：超 3 字 → 2 字 + 省略号（截断后总长恰等于上限）', () => {
  assert.equal(RAIL_LABEL_MAX_CHARS, 3, '竖排栏预算 = 3 字（与内置项同宽，见 TC-LBL-013）')
  // 恰好 3 字 → 原样（边界属于「不截断」一侧，与 TC-LBL-003 同一口径）
  assert.equal(guardRailLabel('上下文'), '上下文')
  const out = guardRailLabel('运行时指标') // 5 字
  assert.equal(out, '运行…')
  assert.equal(out.length, RAIL_LABEL_MAX_CHARS, '截断后总长必须等于上限（含省略号）')
  // 用户实测那一串：'Git Manager' 曾被 8 字档渲染成「Git Man…」（52px）撑破 44px 栏
  assert.equal(guardRailLabel('Git Manager'), 'Gi…', '8 字档的产物在栏里放不下 —— 必须是 2 字 + 省略号')
})

test('TC-LBL-005 竖排栏：脏输入不抛错（undefined / null / 空串）', () => {
  assert.equal(guardRailLabel(''), '')
  assert.equal(guardRailLabel(undefined as unknown as string), '')
  assert.equal(guardRailLabel(null as unknown as string), '')
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

test('TC-LBL-008 ★ 三档力度对照（同一输入三种输出 —— 防止未来被「统一」掉）', () => {
  const input = '{{titile}}' // 用户实测的那一串
  const rail = silencingWarn(() => guardRailLabel(input)).value
  const bar = silencingWarn(() => guardLabel(input)).value
  const body = silencingWarn(() => guardBodyTitle(input)).value
  assert.notEqual(rail, bar, '竖排栏（3 字）与横向条（8 字）力度刻意不同，不得合并')
  assert.notEqual(bar, body, '横向条与正文的力度同样刻意不同')
  assert.equal(rail.length, RAIL_LABEL_MAX_CHARS, '竖排栏受 3 字硬约束')
  assert.equal(body, input, '正文只防模板、不限长度')
})

test('TC-LBL-009 幂等：对已截断结果再调用不变形（防止二次截断吃掉内容）', () => {
  const once = guardRailLabel('运行时指标')
  assert.equal(guardRailLabel(once), once, '已 ≤3 字，再次调用必须原样')
  const bar = guardLabel('工作台与插件指南')
  assert.equal(guardLabel(bar), bar, '已 ≤8 字，再次调用必须原样')
  const body = guardBodyTitle('运行时指标')
  assert.equal(guardBodyTitle(body), body)
})

test('TC-LBL-010 竖排栏：中文按字符计（不按字节 —— 否则 1 个中文就被砍）', () => {
  assert.equal(guardRailLabel('数据表'), '数据表', '3 个汉字 = 3 字符，必须原样')
  assert.equal(guardRailLabel('K 线'), 'K 线', '含拉丁字母与空格，按字符计')
  assert.equal(guardRailLabel('日志'), '日志', '2 字原样')
})

/* ============================================================
 * D91 新增：竖排栏预算与「现实」的对齐（这才是本缺陷的把守方式）
 *
 * 8 字档之所以能活到用户复报，是因为它**从来没有对着真实数据校验过**：
 * 常量写在代码里、用例只断言「等于 8」，而 44px 栏宽到底放得下几个字，
 * 没有任何一条用例问过。以下两条把常量钉在可测量的现实上。
 * ============================================================ */

test('TC-LBL-011 横向条上限必须大于竖排栏（否则「更多」弹层与来源条白挨一刀）', () => {
  assert.ok(
    BAR_LABEL_MAX_CHARS > RAIL_LABEL_MAX_CHARS,
    '横向条宽度 ≥160px，上限必须比 44px 的竖排栏宽 —— 两者相等说明又合并成一个常量了',
  )
  // 「更多」弹层与来源条的实际语料：插件展示名（含官方示例）不该被 8 字砍掉
  for (const s of ['Git 管理', '运行时指标', '工作台与插件指南']) {
    assert.equal(guardLabel(s), s, `横向条应容得下「${s}」（${s.length} 字）`)
  }
})

test('TC-LBL-012 ★ 竖排栏预算必须容纳全部内置中文标签（常量与现实对齐的把守者）', () => {
  // 内置六项的展示名就是竖排栏的「既定宽度基准」（清单/上下文/文件/日志/浏览器/终端）。
  // 插件项被截到比它们还短就丢信息；比它们长就会把栏撑破 ——
  // 所以 RAIL_LABEL_MAX_CHARS 必须恰好等于**内置中文名的最长字数**。
  const localePath = join(
    fileURLToPath(new URL('../..', import.meta.url)),
    'i18n',
    'locales',
    'zh.json',
  )
  const zh = JSON.parse(readFileSync(localePath, 'utf-8')) as {
    meta?: { inspector?: Record<string, string> }
  }
  const labels = Object.values(zh.meta?.inspector ?? {})
  assert.ok(labels.length >= 6, `meta.inspector 至少 6 个内置标签，实得 ${labels.length}`)

  for (const label of labels) {
    assert.ok(
      label.length <= RAIL_LABEL_MAX_CHARS,
      `内置标签「${label}」(${label.length} 字) 超过竖排栏预算 ${RAIL_LABEL_MAX_CHARS} —— ` +
        '要么缩短语言包，要么调大 RAIL_LABEL_MAX_CHARS（同时复核 44px 栏宽）',
    )
  }
  const longest = Math.max(...labels.map((l) => l.length))
  assert.equal(
    RAIL_LABEL_MAX_CHARS,
    longest,
    `竖排栏预算应等于内置最长标签的字数（${longest}）—— 大了会放过撑破栏的插件名（本缺陷根因），小了会砍掉内置项`,
  )
})

test('TC-LBL-013 用户实测记录：被报缺陷的那一串输入必须已被收进预算', () => {
  // 这条用例的唯一价值是**留下缺陷的指纹**：把「报障时的输入」写成断言，
  // 让后来者一眼看出常量改动的动机（而不是随手把 3 改成 4）。
  const reported = 'Git Manager' // 官方示例插件当时的 provides.views[].title
  assert.ok(
    reported.length > RAIL_LABEL_MAX_CHARS,
    '报障输入必须仍超预算 —— 若不再超，说明常量又被放大，应复核 44px 栏宽',
  )
  assert.equal(guardRailLabel(reported), 'Gi…', '当时的正确产物是 2 字 + 省略号')
  assert.equal(guardRailLabel(reported).length, RAIL_LABEL_MAX_CHARS)
})
