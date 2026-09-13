/**
 * v0.30.1 详测 — 渲染层 i18n 插值占位符契约（问题①）
 *
 * 依据：docs/versions/v0.30.1/04-system-design.md §3.2（白名单替换）+ §7.1（TC-I18N）
 * 用例：TC-I18N-001…006
 *
 * 背景（用户实测）：交互区出现字面量 `读取文件:{value}` —— 渲染层 i18next 默认仅
 * 识别 `{{ }}`，而白名单键误写成单花括号 `{value}`，故参数不被替换、原样渲染。
 *
 * 主进程反例（R1-b）：`main/i18n/messages.ts` 的 `tFor()` 是**自定义单花括号替换器**
 * （`text.split('{'+k+'}')`），故主进程文案的单花括号是**正确**写法，本套件正向锁定。
 *
 * 源码契约（readFileSync + 正则）：node:test 无 i18next 运行时，锁的是「模板写法」
 * 这一结构性不变量，与 task-panel-fix2.test.ts 同手法。
 *
 * 运行（cwd=app）：
 *   npx tsx --test src/renderer/i18n/__tests__/placeholder-interpolation.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf-8')

const LANGS = ['zh', 'en', 'ja', 'ko'] as const
type Lang = (typeof LANGS)[number]

const locales = Object.fromEntries(
  LANGS.map((l) => [l, JSON.parse(read(`../locales/${l}.json`)) as Record<string, unknown>]),
) as Record<Lang, Record<string, unknown>>

/** 单花括号占位符：`{value}` 这类「两侧无花括号」的写法（lookaround 排除 `{{ }}`） */
const SINGLE_BRACE = /(?<!\{)\{[A-Za-z_][A-Za-z0-9_]*\}(?!\})/

/** 展开对象为点分键 → 字符串值 */
function flatten(obj: unknown, prefix = '', out: Map<string, string> = new Map()): Map<string, string> {
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      flatten(v, prefix ? `${prefix}.${k}` : k, out)
    }
  } else if (typeof obj === 'string') {
    out.set(prefix, obj)
  }
  return out
}

const flat = Object.fromEntries(LANGS.map((l) => [l, flatten(locales[l])])) as Record<
  Lang,
  Map<string, string>
>

/** `action.*Detail` 白名单键（13 条，单一真源：zh.json action 命名空间） */
const DETAIL_KEYS = [...flat.zh.keys()].filter((k) => /^action\.[a-zA-Z]+Detail$/.test(k)).sort()

/* ============================================================
 * 一、TC-I18N-001 `action.*Detail` → {{value}}
 * ============================================================ */

test('TC-I18N-001 四语言 action.*Detail 均含 {{value}} 且无单花括号残留', () => {
  assert.equal(DETAIL_KEYS.length, 13, `action.*Detail 应恰 13 键，实际 ${DETAIL_KEYS.length}`)
  for (const lang of LANGS) {
    for (const key of DETAIL_KEYS) {
      const text = flat[lang].get(key)
      assert.ok(typeof text === 'string', `${lang}.json 缺 ${key}`)
      assert.match(text!, /\{\{value\}\}/, `${lang}.json ${key} 应含 {{value}}：${text}`)
      assert.doesNotMatch(text!, SINGLE_BRACE, `${lang}.json ${key} 仍有单花括号：${text}`)
    }
  }
})

/* ============================================================
 * 二、TC-I18N-002 / 003 callTool + todoUpdate → 双花括号
 * ============================================================ */

test('TC-I18N-002 四语言 action.callTool 含 {{tool}}（无 {tool}）', () => {
  for (const lang of LANGS) {
    const text = flat[lang].get('action.callTool')
    assert.ok(typeof text === 'string', `${lang}.json 缺 action.callTool`)
    assert.match(text!, /\{\{tool\}\}/, `${lang}.json action.callTool 应含 {{tool}}：${text}`)
    assert.doesNotMatch(text!, SINGLE_BRACE, `${lang}.json action.callTool 仍有单花括号：${text}`)
  }
})

test('TC-I18N-003 四语言 todoUpdate.* 含 {{item}}/{{comment}}/{{status}} 且逐键齐备', () => {
  const base = [...flat.zh.keys()].filter((k) => k.startsWith('action.todoUpdate.')).sort()
  assert.ok(base.length >= 14, `todoUpdate.* 应至少 14 键，实际 ${base.length}`)
  for (const lang of LANGS) {
    const keys = [...flat[lang].keys()].filter((k) => k.startsWith('action.todoUpdate.')).sort()
    assert.deepEqual(keys, base, `${lang}.json todoUpdate.* 键集应与 zh 一致`)
    for (const key of base) {
      const text = flat[lang].get(key)!
      assert.match(text, /\{\{item\}\}/, `${lang}.json ${key} 应含 {{item}}：${text}`)
      if (/Cmt$/.test(key)) {
        assert.match(text, /\{\{comment\}\}/, `${lang}.json ${key} 应含 {{comment}}：${text}`)
      }
      if (/other/.test(key)) {
        assert.match(text, /\{\{status\}\}/, `${lang}.json ${key} 应含 {{status}}：${text}`)
      }
      assert.doesNotMatch(text, SINGLE_BRACE, `${lang}.json ${key} 仍有单花括号：${text}`)
    }
  }
})

/* ============================================================
 * 三、TC-I18N-004 主进程单花括号反例（R1-b 正向锁定）
 * ============================================================ */

test('TC-I18N-004 主进程 tFor 为单花括号替换器，agents.invalidOverride 保持 {value}', () => {
  const src = read('../../../main/i18n/messages.ts')
  assert.match(
    src,
    /text\.split\(`\{\$\{k\}\}`\)\.join\(String\(v\)\)/,
    'tFor 应以 split(`{${k}}`) 实现单花括号替换（R1-b 事实）',
  )
  const hits = src.match(/'agents\.invalidOverride': '[^']*\{value\}'/g) ?? []
  assert.equal(hits.length, 4, `四语言 agents.invalidOverride 应保持单花括号 {value}，实际命中 ${hits.length}`)
})

/* ============================================================
 * 四、TC-I18N-005 / 006 键集一致 + 防误伤
 * ============================================================ */

test('TC-I18N-005 四语言键集完全一致，且含本版新增 foldAllShort/expandAllShort', () => {
  const base = [...flat.zh.keys()].sort()
  for (const lang of LANGS) {
    assert.deepEqual([...flat[lang].keys()].sort(), base, `${lang}.json 键集应与 zh 完全一致`)
  }
  for (const key of ['taskPanel.foldAllShort', 'taskPanel.expandAllShort']) {
    for (const lang of LANGS) {
      assert.ok(flat[lang].has(key), `${lang}.json 缺本版新增键 ${key}`)
    }
  }
})

test('TC-I18N-006 白名单键无未配对花括号；非白名单既有双花括号键未被波及', () => {
  const whitelist = [...DETAIL_KEYS, 'action.callTool', ...[...flat.zh.keys()].filter((k) => k.startsWith('action.todoUpdate.'))]
  for (const lang of LANGS) {
    for (const key of whitelist) {
      const text = flat[lang].get(key)!
      assert.doesNotMatch(text, SINGLE_BRACE, `${lang}.json ${key} 存在未配对单花括号：${text}`)
    }
  }
  // R1-a 防误伤：既有双花括号键（editors.temperatureLabel）保持原样
  const zhTemp = flat.zh.get('editors.temperatureLabel')
  assert.match(zhTemp ?? '', /\{\{value\}\}/, 'editors.temperatureLabel 既有 {{value}} 不应被本版改动')
})
