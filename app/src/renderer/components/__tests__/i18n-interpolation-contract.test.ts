/* ============================================================
 * ArkWork — i18n 插值变量契约（v0.34.0 · D54 · TC-I18NI-001..008）
 *
 * 用户实测缺陷（本组的立组原因）：
 *   右侧竖排栏的插件标签鼠标悬停后，tip 出的是 **`{{titile}}`**。
 *   根因：模板写的是 `{{title}}`，而调用点传的是 `{ label, id }` ——
 *   i18next 插不上值就把占位符**原样**吐出来。
 *
 * 为什么这一类缺陷必须靠机器把守：
 *   ① typecheck 全绿（键名与参数名都是字符串，类型系统看不见）；
 *   ② 现有测试全绿（没人断言过「传参名 == 模板变量名」）；
 *   ③ 运行时不报错（i18next 对缺参是**静默降级**，只在界面上显形，
 *      而有问题的入口往往要「装插件 + 悬停」两个动作才走到）。
 *   三者叠加 = 只有肉眼能发现，且极难复现 —— 正是契约用例的靶心。
 *
 * 判据（对每个能静态解析的 `t(key, { ... })` 调用点）：
 *   模板变量集合 ⊆ 传参名集合。缺参即失败（缺参 = 界面出现 `{{var}}`）。
 *   反向不判（多传无害，且 `t(k, {count})` 这类公共参数常被多传）。
 *
 * 覆盖方式：扫描 renderer 源码 + 四语言包；**纯静态**，零运行时依赖。
 * 运行（cwd=app）：node scripts/run-tests.mjs i18n-interpolation-contract
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RENDERER_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const LOCALES_ROOT = join(RENDERER_ROOT, 'i18n', 'locales')
const LANGS = ['zh', 'en', 'ja', 'ko'] as const

/** 语言包（扁平化为 `a.b.c` → 字符串） */
const bundles: Record<string, Map<string, string>> = {}
let zhTopLevel: Record<string, unknown> = {}
for (const l of LANGS) {
  const raw = JSON.parse(readFileSync(join(LOCALES_ROOT, `${l}.json`), 'utf-8')) as Record<string, unknown>
  if (l === 'zh') zhTopLevel = raw
  const flat = new Map<string, string>()
  const walk = (o: Record<string, unknown>, prefix: string): void => {
    for (const [k, v] of Object.entries(o)) {
      const key = prefix ? `${prefix}.${k}` : k
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v as Record<string, unknown>, key)
      else if (typeof v === 'string') flat.set(key, v)
    }
  }
  walk(raw, '')
  bundles[l] = flat
}

/**
 * i18n 顶层命名空间（取自 zh 包的顶层键）。
 *
 * 为什么必须有这层过滤：`t(...)` 这个名字在 renderer 里**不专属于 i18next** ——
 * `getTabMeta(t: (k: string) => string)` 这类局部注入的小助手、以及组件内
 * 自建的 `t` 回调都会出现，它们的 key 是本地语义（`'context'` / `'providerHeader'`），
 * 压根不在语言包里。不过滤会把它们全报成「缺键」——那是测试自己在制造噪音。
 * 判据：key 含 `.` 且首段是已知顶层命名空间，才当成 i18n 键参与判定。
 */
const NAMESPACES = new Set(Object.keys(zhTopLevel))

function isI18nKey(key: string): boolean {
  const i = key.indexOf('.')
  return i > 0 && NAMESPACES.has(key.slice(0, i))
}

/** 收集 renderer 下所有 .ts/.tsx（跳过测试自身与 __tests__） */
function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue
      collectSourceFiles(p, out)
    } else if (/\.tsx?$/.test(name)) {
      out.push(p)
    }
  }
  return out
}

interface CallSite {
  file: string
  key: string
  /** 调用点显式传的参数名 */
  params: string[]
  /** 因含嵌套对象/展开而无法静态解析（只记录，不判定） */
  opaque: boolean
}

const PARAM_RE = /t\(\s*'([A-Za-z0-9_.]+)'\s*,\s*\{([^{}]*)\}/g

function collectCallSites(): { sites: CallSite[]; opaqueCount: number } {
  const sites: CallSite[] = []
  let opaqueCount = 0
  for (const file of collectSourceFiles(RENDERER_ROOT)) {
    const src = readFileSync(file, 'utf-8')
    const rel = file.slice(RENDERER_ROOT.length)
    // 先找出「含嵌套花括号」的 t( 调用 —— 这些解析不了，只计数
    for (const m of src.matchAll(/t\(\s*'[A-Za-z0-9_.]+'\s*,\s*\{/g)) {
      const tail = src.slice(m.index! + m[0].length, m.index! + m[0].length + 400)
      const close = tail.indexOf('}')
      const open = tail.indexOf('{')
      if (open !== -1 && (close === -1 || open < close)) opaqueCount += 1
    }
    for (const m of src.matchAll(PARAM_RE)) {
      const key = m[1]!
      const body = m[2]!.trim()
      const params: string[] = []
      if (body.length > 0) {
        for (const part of body.split(',')) {
          const seg = part.trim()
          if (!seg) continue
          // 支持 `name: x` 与 `name`（TS 简写）
          const name = seg.includes(':') ? seg.slice(0, seg.indexOf(':')).trim() : seg
          if (/^[A-Za-z_$][\w$]*$/.test(name)) params.push(name)
        }
      }
      sites.push({ file: rel, key, params, opaque: body.includes('...') })
    }
  }
  return { sites, opaqueCount }
}

/** 模板变量名集合：`{{var}}` */
function templateVars(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([\w$]+)\s*\}\}/g)].map((m) => m[1]!)
}

/* ============================================================
 * 1. 主契约：模板变量 ⊆ 传参名
 * ============================================================ */

test('TC-I18NI-001 扫描本身有效：找到足量调用点（正则失效即静默全绿的护栏）', () => {
  const { sites } = collectCallSites()
  assert.ok(sites.length > 200, `解析到的 t(key, {...}) 调用点应远超 200，实际 ${sites.length} —— 正则可能已失效`)
  // 至少有一批确实带插值的键
  const withVars = sites.filter((s) => {
    const tpl = bundles.zh!.get(s.key)
    return tpl ? templateVars(tpl).length > 0 : false
  })
  assert.ok(withVars.length > 30, `带插值的调用点应有数十处，实际 ${withVars.length}`)
})

test('TC-I18NI-002 ★ 模板变量集合必须被调用点传参覆盖（缺参 = 界面出现 {{var}}）', () => {
  const { sites } = collectCallSites()
  const violations: string[] = []
  for (const s of sites) {
    if (s.opaque) continue
    const tpl = bundles.zh!.get(s.key)
    if (tpl === undefined) continue // 键不存在由 TC-I18NI-005 单独把守
    const need = templateVars(tpl)
    if (need.length === 0) continue
    const missing = need.filter((v) => !s.params.includes(v))
    if (missing.length > 0) {
      violations.push(`${s.file} t('${s.key}') 缺参 [${missing.join(', ')}]（模板需要 [${need.join(', ')}]）`)
    }
  }
  assert.deepEqual(violations, [], `存在未插值模板变量：\n${violations.join('\n')}`)
})

test('TC-I18NI-003 D54 精确回归锚点：panelTabTooltip / panelTabAria 的变量名与调用点同名', () => {
  // 模板侧
  assert.ok(bundles.zh!.has('inspector.panelTabTooltip'))
  assert.deepEqual(
    templateVars(bundles.zh!.get('inspector.panelTabTooltip')!).sort(),
    ['id', 'label'],
    'panelTabTooltip 模板变量必须是 {label, id} —— 缺陷正是「模板写 title、调用点传 label」',
  )
  assert.deepEqual(templateVars(bundles.zh!.get('inspector.panelTabAria')!).sort(), ['label'])
  for (const l of LANGS) {
    assert.deepEqual(
      templateVars(bundles[l]!.get('inspector.panelTabTooltip')!).sort(),
      ['id', 'label'],
      `${l} 的 panelTabTooltip 变量名必须一致（4 语言同名才叫契约）`,
    )
  }
  // 调用点侧：Inspector.tsx 必须传 { label, id }，且绝不能出现 title
  const inspector = readFileSync(join(RENDERER_ROOT, 'components/Inspector.tsx'), 'utf-8')
  const call = inspector.match(/t\('inspector\.panelTabTooltip',\s*\{[^}]*\}\)/)
  assert.ok(call, 'Inspector.tsx 必须调用 panelTabTooltip')
  assert.match(call![0]!, /\blabel\b/, '必须传 label')
  assert.match(call![0]!, /\bid\b/, '必须传 id')
  assert.doesNotMatch(call![0]!, /\btitle\b/, '不得再传 title（模板已不用它）')
})

test('TC-I18NI-004 四语言模板变量集合完全一致（只翻文案，不改变量名）', () => {
  const diffs: string[] = []
  for (const [key, zhText] of bundles.zh!) {
    const zhVars = templateVars(zhText).sort()
    for (const l of LANGS) {
      if (l === 'zh') continue
      const other = bundles[l]!.get(key)
      if (other === undefined) continue
      const vars = templateVars(other).sort()
      if (vars.join('|') !== zhVars.join('|')) {
        diffs.push(`${key}: zh=[${zhVars.join(',')}] vs ${l}=[${vars.join(',')}]`)
      }
    }
  }
  assert.deepEqual(diffs, [], `变量名跨语言漂移：\n${diffs.join('\n')}`)
})

/* ============================================================
 * 2. 键存在性 + 孤键（本轮搬迁产生的孤儿键不得再被引用）
 * ============================================================ */

test('TC-I18NI-005 调用点引用的键必须在 4 语言全部存在（不得只在 zh 里补）', () => {
  const { sites } = collectCallSites()
  const keys = new Set(sites.filter((s) => isI18nKey(s.key)).map((s) => s.key))
  assert.ok(keys.size > 100, `过滤后的 i18n 键应超 100 个，实际 ${keys.size} —— 命名空间过滤可能过严`)
  const missing: string[] = []
  for (const key of keys) {
    for (const l of LANGS) {
      if (!bundles[l]!.has(key)) missing.push(`${l}: ${key}`)
    }
  }
  assert.deepEqual(missing, [], `语言包缺键：\n${missing.join('\n')}`)
})

test('TC-I18NI-006 v0.34.0 新增的 Tab / 插件管理键 4 语言齐备', () => {
  const required = [
    'panel.abilities.tab.skills',
    'panel.abilities.tab.plugins',
    'panel.abilities.tab.mcp',
    'panel.abilities.hint.skills',
    'panel.abilities.hint.plugins',
    'panel.abilities.hint.mcp',
    'workbench.plugins.newPlugin',
    'workbench.plugins.newPluginHint',
    'workbench.plugins.detailAria',
    'workbench.plugins.sourceBundled',
    'workbench.plugins.sourceLocal',
    'workbench.plugins.export',
    'workbench.plugins.uninstallShort',
    'conversationflow.foldedTurns',
    'conversationflow.collapseTurns',
    'inspector.morePluginTabs',
    'inspector.morePluginTabsAria',
  ]
  for (const key of required) {
    for (const l of LANGS) {
      assert.ok(bundles[l]!.has(key), `${l} 缺少 ${key}`)
    }
  }
})

test('TC-I18NI-007 孤儿键：PluginsView 删除后其独占键不得再被任何源码引用', () => {
  // 设计 §4.3：键定义保留一个版本（向后兼容），但**不得再有引用**
  const orphans = [
    'workbench.plugins.showSample',
    'workbench.plugins.hideSample',
    'workbench.plugins.listTitle',
    'workbench.plugins.sourceUser',
    'workbench.plugins.issuesTitle',
    'workbench.tab.plugins',
    'workbench.tab.pluginsBadge',
  ]
  const { sites } = collectCallSites()
  const referenced = new Set(sites.filter((s) => isI18nKey(s.key)).map((s) => s.key))
  for (const k of orphans) {
    assert.equal(referenced.has(k), false, `${k} 是原 PluginsView 的独占键，不应再被引用`)
    // 键本身仍应在（保留一个版本）
    assert.ok(bundles.zh!.has(k), `${k} 应保留定义（设计 §4.3：保留一个版本）`)
  }
})

test('TC-I18NI-008 能力页三 Tab 与工作台中心两子页的 key 契约', () => {
  // 能力页：三 Tab 齐备，且 hint 三条各有内容
  const abilities = JSON.parse(JSON.stringify({
    tab: ['skills', 'plugins', 'mcp'],
  })) as { tab: string[] }
  for (const id of abilities.tab) {
    const key = `panel.abilities.tab.${id}`
    const hint = `panel.abilities.hint.${id}`
    for (const l of LANGS) {
      assert.ok(bundles[l]!.get(key)?.length, `${l} 的 ${key} 不得为空`)
      assert.ok(bundles[l]!.get(hint)?.length, `${l} 的 ${hint} 不得为空`)
    }
  }
  // 工作台中心：只剩两个子页；plugins 键保留（孤儿，见 TC-I18NI-007）
  const center = readFileSync(join(RENDERER_ROOT, 'components/workbench/WorkbenchCenter.tsx'), 'utf-8')
  assert.match(center, /type Tab = 'profiles' \| 'diagnostics'/, '工作台中心必须收敛为两子页')
  assert.doesNotMatch(center, /tab === 'plugins'/, '不得再渲染 plugins 子页')
  assert.doesNotMatch(center, /from '\.\/PluginsView'/, '不得再引用已删除的 PluginsView')
  for (const id of ['profiles', 'diagnostics']) {
    for (const l of LANGS) assert.ok(bundles[l]!.has(`workbench.tab.${id}`), `${l} 缺 workbench.tab.${id}`)
  }
})
