/* ============================================================
 * ArkWork — 插件工具名（命名空间）单测（v0.35.0 · B9/B11 建立）
 * 规格来源：docs/versions/v0.35.0/04-system-design.md §11「缺陷回溯登记」
 *   风险：「插件工具与 skill 同名 → 模型侧歧义」
 *   处置：注册名强制 `plugin__<pluginId>__<name>` 前缀
 *
 * ★ 为什么这个模块值得单独一组用例（而不是散在 host-service 的用例里）：
 *   它被**三层**共用 —— main 的 host-service（注册/路由）、agent 引擎的 act.ts
 *   （工具分发）、messages.ts（工具清单装配）。拆名/拼名只要有一处口径不对，
 *   现象就是「模型调了工具，宿主找不到插件」——**没有任何报错**，只是工具静默失效。
 *   故这里把「拼名 / 拆名 / 往返」钉成闭集真值表。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs plugin-tool-name
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PLUGIN_TOOL_PREFIX,
  globalPluginToolName,
  isPluginToolName,
  splitPluginToolName,
  summarizePluginToolResult,
  prettyPluginToolName,
  PLUGIN_TOOL_SUMMARY_MAX,
  PLUGIN_CONTROL_TOOL_NAMES,
  isPluginControlTool,
} from '../plugin-tool-name.js'

/* ============================================================
 * 1. 前缀与拼名形状
 * ============================================================ */

test('TC-PTN-001 前缀是双下划线（单下划线会被工具名自身的下划线吃掉）', () => {
  assert.equal(PLUGIN_TOOL_PREFIX, 'plugin__')
  // 单下划线前缀会让 `plugin_list`（宿主控制工具）也落进插件工具命名空间 ——
  // 两个命名空间必须**不可混淆**，这是双下划线的存在理由。
  assert.ok(!'plugin_list'.startsWith(PLUGIN_TOOL_PREFIX))
})

test('TC-PTN-002 globalPluginToolName 拼接形状为 plugin__<id>__<name>', () => {
  assert.equal(globalPluginToolName('my.calc', 'get_kline'), 'plugin__my.calc__get_kline')
  assert.equal(globalPluginToolName('a', 'b'), 'plugin__a__b')
})

/* ============================================================
 * 2. 拆名：lastIndexOf('__') 而非 split('__')
 * ============================================================ */

test('TC-PTN-003 ★ 工具名含单下划线时正确拆回（作者写 get_kline 很自然）', () => {
  assert.deepEqual(splitPluginToolName('plugin__my.calc__get_kline'), { pluginId: 'my.calc', name: 'get_kline' })
  assert.deepEqual(splitPluginToolName('plugin__p__a_b_c'), { pluginId: 'p', name: 'a_b_c' })
})

test('TC-PTN-004 ★ 名字里含双下划线时按**最后一段**拆 —— 这是明确声明的取舍，不是完美还原', () => {
  // 取名 'a__b' 时全局名与「id 含 __」的形状无法区分（信息论上不可判）。
  // 本模块的选择是「按最后一段拆」：保证 `<name>` 一定拆得干净，
  // 代价是插件 id 里含 `__` 会被误拆 —— 该情形由清单校验（VP1）禁止。
  assert.deepEqual(splitPluginToolName('plugin__p__a__b'), { pluginId: 'p__a', name: 'b' })
  // 反面对照：split('__') 会给出四段。固定下标解析（[1]=id / [2]=name）在
  // 这种形状下会把 name 解析成 'a'（丢掉 'b'）—— 这就是必须用 lastIndexOf 的理由。
  const naive = 'plugin__p__a__b'.split('__')
  assert.equal(naive.length, 4)
  assert.equal(naive[1], 'p')
  assert.equal(naive[2], 'a')
  assert.notEqual(naive[2], 'a__b', '固定下标解析必然丢掉 name 的后半段')
})

test('TC-PTN-005 splitPluginToolName 真值表：形状不全一律 null（不得返回半成品）', () => {
  const bad: unknown[] = [
    'plugin__', // 裸前缀：无第二段
    'plugin____x', // 第二段分隔符在最前 → at <= 0
    'plugin__onlyid', // 只有 id，没有 name
    'plugin__id__', // name 为空
    'not_plugin__a__b', // 前缀不符
    'plugin_a__b', // 前缀不符（单下划线）
    '',
    42,
    null,
    undefined,
    { id: 'x' },
  ]
  for (const v of bad) {
    assert.equal(splitPluginToolName(v), null, `${String(v)} 应拆不出来（null）`)
  }
})

test('TC-PTN-006 ★ 往返恒等：拼名 → 拆名 → 与原值一致', () => {
  const cases: Array<[string, string]> = [
    ['my.calc', 'get_kline'],
    ['ark.plugin.stock', 'quote'],
    ['p', 'a_b_c'],
    ['ns.with.many.dots', 'tool'],
  ]
  for (const [id, name] of cases) {
    const g = globalPluginToolName(id, name)
    assert.deepEqual(splitPluginToolName(g), { pluginId: id, name }, `${g} 往返应恒等`)
  }
})

test('TC-PTN-007 isPluginToolName 与 splitPluginToolName 同判据（不得各自为政）', () => {
  const probes: unknown[] = [
    'plugin__a__b',
    'plugin__my.calc__get_kline',
    'plugin__',
    'plugin__onlyid',
    'plugin_list',
    'plugin_set_enabled',
    'file_reader',
    42,
    null,
  ]
  for (const p of probes) {
    assert.equal(
      isPluginToolName(p),
      splitPluginToolName(p) !== null,
      `isPluginToolName 与 splitPluginToolName 对 ${String(p)} 的判定必须一致`,
    )
  }
})

/* ============================================================
 * 3. ★ 两个命名空间不得混淆（本组最高价值的一条）
 * ============================================================ */

test('TC-PTN-008 ★ 宿主控制工具名不得被认领为插件工具（否则会去「找插件」然后报误导性错误）', () => {
  for (const name of PLUGIN_CONTROL_TOOL_NAMES) {
    assert.equal(isPluginToolName(name), false, `${name} 是宿主控制工具，不是插件工具`)
    assert.equal(isPluginControlTool(name), true, `${name} 必须被控制工具判定认领`)
    // 反向：插件工具不得被当成控制工具
    assert.equal(isPluginControlTool(globalPluginToolName('x', 'y')), false)
  }
})

test('TC-PTN-009 控制工具名是闭集且无重复（四个管理入口，插件坏了照样能用）', () => {
  assert.deepEqual(
    [...PLUGIN_CONTROL_TOOL_NAMES].sort(),
    ['plugin_detail', 'plugin_list', 'plugin_open_view', 'plugin_set_enabled'],
  )
  assert.equal(new Set(PLUGIN_CONTROL_TOOL_NAMES).size, PLUGIN_CONTROL_TOOL_NAMES.length, '不得重复')
})

test('TC-PTN-010 isPluginControlTool 真值表（前缀像但不是全等的一律不认）', () => {
  const probes: unknown[] = [
    'plugin_list ',
    'plugin-list',
    'Plugin_list',
    'plugin_list_extra',
    'plugin_',
    '',
    42,
    null,
  ]
  for (const p of probes) {
    assert.equal(isPluginControlTool(p), false, `${String(p)} 不应被判为控制工具`)
  }
})

/* ============================================================
 * 4. 结果摘要：必须比原始结果短，但不能短到没信息
 * ============================================================ */

test('TC-PTN-011 显式摘要字段优先，且优先级为 summary > message > text > result', () => {
  const r = { summary: 'S', message: 'M', text: 'T', result: 'R' }
  assert.equal(summarizePluginToolResult('p', 't', r), 'S')
  assert.equal(summarizePluginToolResult('p', 't', { message: 'M', text: 'T', result: 'R' }), 'M')
  assert.equal(summarizePluginToolResult('p', 't', { text: 'T', result: 'R' }), 'T')
  assert.equal(summarizePluginToolResult('p', 't', { result: 'R' }), 'R')
})

test('TC-PTN-012 空字符串/纯空白摘要字段被跳过（否则模型收到一片空白）', () => {
  assert.equal(summarizePluginToolResult('p', 't', { summary: '   ', message: 'M' }), 'M')
  // 四个字段都不可用时退化为 JSON —— 仍是「有信息」的，不是空串
  assert.equal(summarizePluginToolResult('p', 't', { summary: '' }), '{"summary":""}')
})

test('TC-PTN-013 字符串结果直接用；对象结果走 JSON；数组也走 JSON', () => {
  assert.equal(summarizePluginToolResult('p', 't', 'hello'), 'hello')
  assert.equal(summarizePluginToolResult('p', 't', { a: 1 }), '{"a":1}')
  assert.equal(summarizePluginToolResult('p', 't', [1, 2]), '[1,2]')
  assert.equal(summarizePluginToolResult('p', 't', 0), '0')
  assert.equal(summarizePluginToolResult('p', 't', null), 'null')
})

test('TC-PTN-014 ★ 超长结果被截断并显式标注（不得把整棵行情树灌进对话流）', () => {
  const long = 'x'.repeat(PLUGIN_TOOL_SUMMARY_MAX + 100)
  const out = summarizePluginToolResult('p', 't', long)
  assert.ok(out.length < long.length, '摘要必须比原文短')
  assert.match(out, /（已截断）$/)
  assert.ok(out.startsWith('x'.repeat(16)))
  // 边界：恰好等于上限不截断
  const exact = 'y'.repeat(PLUGIN_TOOL_SUMMARY_MAX)
  assert.equal(summarizePluginToolResult('p', 't', exact), exact)
})

test('TC-PTN-015 ★ 摘要是「尽力而为」，绝不因序列化失败而抛（抛出去会被误读成工具执行失败）', () => {
  const cyclic: Record<string, unknown> = { name: 'loop' }
  cyclic.self = cyclic
  let out = ''
  assert.doesNotThrow(() => {
    out = summarizePluginToolResult('my.plugin', 'my_tool', cyclic)
  })
  assert.match(out, /my\.plugin/)
  assert.match(out, /my_tool/)
  assert.match(out, /无法序列化/)

  // BigInt 也是 JSON.stringify 的抛点之一
  assert.doesNotThrow(() => summarizePluginToolResult('p', 't', { n: 1n }))
})

/* ============================================================
 * 5. 展示用短名
 * ============================================================ */

test('TC-PTN-016 prettyPluginToolName 合法名转「id › name」，非法名原样返回', () => {
  assert.equal(prettyPluginToolName('plugin__my.calc__get_kline'), 'my.calc › get_kline')
  assert.equal(prettyPluginToolName('file_reader'), 'file_reader')
  assert.equal(prettyPluginToolName('plugin__'), 'plugin__')
})
