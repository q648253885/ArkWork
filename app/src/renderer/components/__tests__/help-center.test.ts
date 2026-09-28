/* ============================================================
 * v0.36.3 · R4 — 帮助中心契约（TC-HELP-001..004）
 *
 * 规格来源：docs/versions/v0.36.0/15-v0363-memory-motion-path-design.md
 *   §5.1（v0.30–v0.36 逐版对账表：需补齐的功能 + 动作）
 *   §5.2（落地方式：章节增删改写 / 键位表继续走注册表单一真源 / 四语言 parity /
 *        docs/user-guide.{zh-CN,en,ja,ko}.md 同步）
 *
 * 用户诉求原文：「整体更新帮助页面，将所有新增功能和修改的功能更新上去。」
 * —— 帮助页最容易出的两类问题是**内容漂移**（新功能没写）与**键位漂移**
 * （帮助页写着一套、注册表跑着另一套，历史上真发生过：v0.31.0 前漏列
 * 「Alt+6 终端」与「Shift+Tab 权限循环」）。本组把守的就是这两类。
 *
 * 载体纪律（D101 纪律⑫）：TSX 走 stripComments 后再断言 —— 文件头注释里
 * 正面提到 `Shift+Tab`、`Mod+Shift+W` 等键位（说明「为什么不再硬编码」），
 * 不剥注释会把注释本身当成硬编码证据（假阳性）。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs help-center
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from '@shared/utils/source-guard'

const RENDERER = fileURLToPath(new URL('../..', import.meta.url)) // app/src/renderer/
const REPO_ROOT = fileURLToPath(new URL('../../../../..', import.meta.url)) // 仓库根（含 docs/）
const HELP_CENTER = join(RENDERER, 'components/HelpCenter.tsx')
const LOCALES = join(RENDERER, 'i18n/locales')
const LANGS = ['zh', 'en', 'ja', 'ko'] as const
type Lang = (typeof LANGS)[number]

/* ============================================================
 * 1. 数据装载
 * ============================================================ */

const helpCenterSrc = readFileSync(HELP_CENTER, 'utf-8')
const helpCenterCode = stripComments(helpCenterSrc)

/** 章节数组顺序（§5.1 对账后的最终序） */
const EXPECTED_SECTIONS = [
  'workspace',
  'tasks',
  'parallel',
  'conversation',
  'files',
  'agents',
  'skills',
  'plugins',
  'workbench',
  'kb',
  'memory',
  'automations',
  'inspector',
  'settings',
  'performance',
] as const

/** 本版新增 / 改名的章节（§5.1 中动作列为「新增章节」「改…」的行） */
const NEW_OR_RENAMED = ['files', 'plugins', 'workbench', 'settings', 'performance'] as const

type Json = Record<string, unknown>
const raw: Record<Lang, Json> = {} as Record<Lang, Json>
for (const l of LANGS) {
  raw[l] = JSON.parse(readFileSync(join(LOCALES, `${l}.json`), 'utf-8')) as Json
}

/** 取 `help.sections.<id>` 子树 */
function section(l: Lang, id: string): Json {
  const help = raw[l]!.help as Json
  const sections = help.sections as Json
  return sections[id] as Json
}

/** 取某章某字段的字符串值 */
function text(l: Lang, id: string, field: 'title' | 'summary'): string {
  return section(l, id)[field] as string
}

/** 取 `bullets` / `actions` 的键集（数字字符串） */
function subKeys(l: Lang, id: string, group: 'bullets' | 'actions'): string[] {
  const node = section(l, id)[group] as Json | undefined
  return node ? Object.keys(node).sort((a, b) => Number(a) - Number(b)) : []
}

/* ============================================================
 * 2. TC-HELP-001 章节齐备（新增章节锚点在位）
 * ============================================================ */

test('TC-HELP-001a 章节数组与 §5.1 对账表逐条一致（顺序即信息架构）', () => {
  const ids = [...helpCenterCode.matchAll(/^\s{8}id: '([a-z]+)',$/gm)].map((m) => m[1]!)
  assert.deepEqual(
    ids,
    [...EXPECTED_SECTIONS],
    '章节 id 集合/顺序漂移 —— 帮助页信息架构是本版交付物的一部分，增删需同步本用例与 §5.1',
  )
})

test('TC-HELP-001b 本版新增/改名章节的锚点在源码与四语言包里都在位', () => {
  for (const id of NEW_OR_RENAMED) {
    assert.ok(
      helpCenterCode.includes(`help.sections.${id}.title`),
      `HelpCenter.tsx 缺少章节 ${id} 的标题锚点（§5.1 要求新增/改写该章）`,
    )
    assert.ok(
      helpCenterCode.includes(`help.sections.${id}.summary`),
      `HelpCenter.tsx 缺少章节 ${id} 的摘要锚点`,
    )
    for (const l of LANGS) {
      assert.ok(text(l, id, 'title').length > 0, `${l} 缺少 help.sections.${id}.title`)
      assert.ok(text(l, id, 'summary').length > 0, `${l} 缺少 help.sections.${id}.summary`)
      assert.ok(subKeys(l, id, 'bullets').length > 0, `${l} 的 ${id} 至少要有 1 条要点`)
      assert.ok(subKeys(l, id, 'actions').length > 0, `${l} 的 ${id} 至少要有 1 个跳转入口`)
    }
  }
})

test('TC-HELP-001c 旧章节键已物理删除（models / privacy → settings / performance，不许留悬挂引用）', () => {
  for (const l of LANGS) {
    const sections = (raw[l]!.help as Json).sections as Json
    assert.ok(!('models' in sections), `${l} 仍留着 help.sections.models —— 已更名为 settings`)
    assert.ok(!('privacy' in sections), `${l} 仍留着 help.sections.privacy —— 已更名为 performance`)
  }
  assert.doesNotMatch(helpCenterCode, /help\.sections\.(models|privacy)\./, 'HelpCenter 仍引用旧章节键')
})

test('TC-HELP-001d 每章标题/摘要在源码里都经 t() 取用（不得出现写死的展示文案）', () => {
  for (const id of EXPECTED_SECTIONS) {
    assert.ok(helpCenterCode.includes(`t('help.sections.${id}.title')`), `章节 ${id} 的标题未走 i18n`)
  }
  // 要点至少逐条取自 i18n（不要求全部，但 key 形态必须出现在源码里）
  const bulletRefs = [...helpCenterCode.matchAll(/help\.sections\.\w+\.bullets\.\d+/g)]
  assert.ok(
    bulletRefs.length >= EXPECTED_SECTIONS.length,
    `源码里 i18n 要点引用只有 ${bulletRefs.length} 处 —— 章节要点可能被写死在组件里`,
  )
})

/* ============================================================
 * 3. TC-HELP-002 无硬编码键位（注册表唯一真源，反向断言）
 * ============================================================ */

test('TC-HELP-002a 键位表必须来自 listKeybindings() 单一真源', () => {
  assert.match(helpCenterCode, /\blistKeybindings\s*\(\s*\)/, 'HelpCenter 必须调用 listKeybindings()')
  assert.match(helpCenterCode, /\bGROUP_ORDER\b/, '必须按 GROUP_ORDER 分组渲染')
  assert.match(helpCenterCode, /\bchordsText\s*\(/, '展示串必须经 chordsText() 单点产出')
})

test('TC-HELP-002b ★ 反向断言：源码里不得再出现任何裸修饰键符号或字面和弦', () => {
  // 裸修饰键符号（macOS 的 U+2318 系列）—— 展示串由 keymap 单点决定，此处零平台分支
  assert.doesNotMatch(helpCenterCode, /[⌘⇧⌥⌃]/, 'HelpCenter 不得硬编码修饰键符号')
  // 字面和弦：Cmd+X / Ctrl+X / Shift+X / Alt+X / Option+X
  const literals = [...helpCenterCode.matchAll(/['"`](?:Cmd|Ctrl|Shift|Alt|Option)\+/g)].map((m) => m[0]!)
  assert.deepEqual(literals, [], `HelpCenter 出现字面和弦：${literals.join(' / ')}`)
})

test('TC-HELP-002c 分组标题映射必须覆盖 GROUP_ORDER 全部分组', () => {
  const order = ['global', 'inspector', 'help', 'editor', 'region']
  for (const g of order) {
    assert.ok(
      new RegExp(`^\\s{2}${g}: 'help\\.shortcuts\\.group\\.${g}',`, 'm').test(helpCenterCode),
      `GROUP_TITLE_KEY 缺少分组 ${g}（分组增删时 typecheck 也会红，此处再把一道）`,
    )
  }
})

/* ============================================================
 * 4. TC-HELP-003 四语言键集 parity（帮助文案不得含未传参占位符）
 * ============================================================ */

test('TC-HELP-003a 四语言 help.sections 叶子键集完全一致', () => {
  const leaves = (l: Lang): string[] => {
    const out: string[] = []
    const walk = (o: Json, p: string): void => {
      for (const [k, v] of Object.entries(o)) {
        const key = `${p}.${k}`
        if (v && typeof v === 'object' && !Array.isArray(v)) walk(v as Json, key)
        else out.push(key)
      }
    }
    walk((raw[l]!.help as Json).sections as Json, 'help.sections')
    return out.sort()
  }
  const base = leaves('zh')
  assert.ok(base.length > 100, `help.sections 叶子键应超 100，实际 ${base.length}`)
  for (const l of LANGS) {
    if (l === 'zh') continue
    const other = leaves(l)
    const missing = base.filter((k) => !other.includes(k))
    const extra = other.filter((k) => !base.includes(k))
    assert.deepEqual(missing, [], `${l} 缺键（只补了 zh 不算完成）`)
    assert.deepEqual(extra, [], `${l} 多键（zh 为键集真源）`)
  }
})

test('TC-HELP-003b 每章的要点条数与跳转入口数在四语言间一致', () => {
  for (const id of EXPECTED_SECTIONS) {
    const b = subKeys('zh', id, 'bullets')
    const a = subKeys('zh', id, 'actions')
    for (const l of LANGS) {
      if (l === 'zh') continue
      assert.deepEqual(subKeys(l, id, 'bullets'), b, `${l} 的 ${id}.bullets 条数与 zh 不一致`)
      assert.deepEqual(subKeys(l, id, 'actions'), a, `${l} 的 ${id}.actions 个数与 zh 不一致`)
    }
  }
})

test('TC-HELP-003c 帮助章节文案零插值占位符（否则调用点未传参 = 界面出现 {{var}}）', () => {
  // 只扫 help.sections：help.subtitle 等既有键合法使用 {{kbd}}，由 TC-I18NI-002 把守传参
  const offenders: string[] = []
  const walk = (o: Json, p: string): void => {
    for (const [k, v] of Object.entries(o)) {
      const key = `${p}.${k}`
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v as Json, key)
      else if (typeof v === 'string' && /\{\{/.test(v)) offenders.push(`${key} = ${v}`)
    }
  }
  for (const l of LANGS) walk((raw[l]!.help as Json).sections as Json, l)
  assert.deepEqual(
    offenders,
    [],
    `help.sections.* 文案不得含 {{ }} 占位符（这些键在 HelpCenter 里是纯静态取用，没有调用点会传参）：\n${offenders.join('\n')}`,
  )
})

/* ============================================================
 * 5. TC-HELP-004 用户指南四语言含新章节标题（文档与应用内文案对齐）
 * ============================================================ */

const DOC_FILE: Record<Lang, string> = {
  zh: 'user-guide.zh-CN.md',
  en: 'user-guide.en.md',
  ja: 'user-guide.ja.md',
  ko: 'user-guide.ko.md',
}

test('TC-HELP-004a 四语言用户指南都覆盖本版新增/改名章节的标题', () => {
  for (const l of LANGS) {
    const doc = readFileSync(join(REPO_ROOT, 'docs', DOC_FILE[l]), 'utf-8')
    for (const id of NEW_OR_RENAMED) {
      const title = text(l, id, 'title')
      assert.ok(
        doc.includes(title),
        `${DOC_FILE[l]} 未覆盖章节标题「${title}」—— 应用内帮助页改了，文档没跟上`,
      )
    }
  }
})

test('TC-HELP-004b 用户指南目录与正文章节同步（§5.2：目录与正文章节同步）', () => {
  const minChapters = EXPECTED_SECTIONS.length + 1 // 指南比帮助页多出「安装」等前置章，故取 > 帮助页章节数
  for (const l of LANGS) {
    const doc = readFileSync(join(REPO_ROOT, 'docs', DOC_FILE[l]), 'utf-8')
    const headings = doc.match(/^## \d+\. /gm) ?? []
    const toc = doc.match(/^\d+\. \[/gm) ?? []
    assert.equal(
      toc.length,
      headings.length,
      `${DOC_FILE[l]} 目录 ${toc.length} 条、正文编号章节 ${headings.length} 个 —— 目录与正文必须同步`,
    )
    assert.ok(
      headings.length > minChapters - 1,
      `${DOC_FILE[l]} 只有 ${headings.length} 章，未覆盖本版功能（帮助页已有 ${EXPECTED_SECTIONS.length} 章）`,
    )
  }
})

test('TC-HELP-004c 已删除的错误键位不得残留在用户指南里（历史文档曾写「⌘1~9 切换 Agent」）', () => {
  for (const l of LANGS) {
    const doc = readFileSync(join(REPO_ROOT, 'docs', DOC_FILE[l]), 'utf-8')
    assert.doesNotMatch(
      doc,
      /[⌘][1]~[9]|⌘1~9/,
      `${DOC_FILE[l]} 仍写着「⌘1~9」—— 实际键位是 ⌘1~⌘7 直达能力页，不是切换 Agent`,
    )
  }
})