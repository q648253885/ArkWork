/* ============================================================
 * v0.33.0 — 插件清单校验契约（TC-PLG-001..014）
 * 规格见 testcases/00-cumulative-matrix.md §3；
 * 被测：shared/utils/plugin-manifest.ts（VP1–VP6）
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs plugin-manifest
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePluginManifest, satisfiesEngineRange } from '../plugin-manifest.js'
import type { PluginIssue } from '@shared/types/plugin'
import { PLUGIN_KINDS } from '@shared/types/plugin'
import { VLIB_COMPONENTS } from '@shared/types/vlib'

/** 合法 panel 插件清单（最小可用） */
function panelRaw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    id: 'ark.plugin.watchlist',
    name: '自选股',
    version: '1.0.0',
    kind: 'panel',
    provides: {
      panel: {
        panelRef: 'panel:watchlist',
        title: '自选股',
        component: 'DataTable',
        data: { kind: 'static', rows: [{ symbol: '600519' }] },
      },
    },
    ...over,
  }
}

const errors = (issues: PluginIssue[]) => issues.filter((i) => i.level === 'error')

/* ============================================================
 * VP1 结构 + VP2 provides↔kind
 * ============================================================ */

test('TC-PLG-001 合法 panel 插件解析成功，kind 与 provides.panel 齐全', () => {
  const r = parsePluginManifest(panelRaw())
  assert.equal(errors(r.issues).length, 0, `不应有 error：${JSON.stringify(r.issues)}`)
  assert.ok(r.manifest)
  assert.equal(r.manifest!.kind, 'panel')
  assert.equal(r.manifest!.provides.panel?.panelRef, 'panel:watchlist')
  assert.equal(r.manifest!.provides.panel?.component, 'DataTable')
  assert.deepEqual(r.manifest!.provides.panel?.data, { kind: 'static', rows: [{ symbol: '600519' }] })
})

test('TC-PLG-002 缺 id / name / version / kind 各报一条 error，且带 JSON Path', () => {
  const r = parsePluginManifest({ provides: { panel: { panelRef: 'panel:x', title: 'x', component: 'DataTable', data: { kind: 'static', rows: [] } } } })
  const errs = errors(r.issues)
  for (const p of ['$.id', '$.name', '$.version', '$.kind']) {
    assert.ok(errs.some((i) => i.path === p), `缺少 ${p} 的 error`)
  }
  assert.equal(r.manifest, null)
})

test('TC-PLG-003 id 不符合「命名空间.名称」→ error；version 非语义化 → error', () => {
  for (const bad of ['watchlist', 'Ark.Plugin', 'ark..plugin', 'ark plugin']) {
    const r = parsePluginManifest(panelRaw({ id: bad }))
    assert.ok(errors(r.issues).some((i) => i.path === '$.id'), `${bad} 应被判非法`)
  }
  // 多段命名空间（reverse-DNS）是合法的 —— 内置插件就是这种形态
  assert.equal(errors(parsePluginManifest(panelRaw({ id: 'ark.plugin.deep.nested' })).issues).length, 0)
  const badVer = parsePluginManifest(panelRaw({ version: 'v1' }))
  assert.ok(errors(badVer.issues).some((i) => i.path === '$.version'))
})

test('TC-PLG-004 kind 不在 PLUGIN_KINDS → error，且提示列出合法值', () => {
  const r = parsePluginManifest(panelRaw({ kind: 'widget' }))
  const e = errors(r.issues).find((i) => i.path === '$.kind')
  assert.ok(e, '未知 kind 必须报 error')
  for (const k of PLUGIN_KINDS) assert.ok(String(e.fix).includes(k) || String(e.message).includes(k), '提示应列出合法 kind')
})

test('TC-PLG-005 VP2：panel 缺 provides.panel → error；theme 插件只给 provides.panel → error', () => {
  const noPanel = parsePluginManifest(panelRaw({ provides: {} }))
  assert.ok(errors(noPanel.issues).some((i) => i.path === '$.provides.panel'))
  const wrongKind = parsePluginManifest(panelRaw({ kind: 'theme', provides: { panel: panelRaw().provides as never } }))
  assert.ok(errors(wrongKind.issues).some((i) => i.path === '$.provides.theme'))
})

/* ============================================================
 * VP3 panel 载荷
 * ============================================================ */

test('TC-PLG-006 VP3：component 不在白名单 → error，提示列出全部组件名', () => {
  const r = parsePluginManifest(panelRaw({ provides: { panel: { panelRef: 'panel:x', title: 'x', component: 'MyTable', data: { kind: 'static', rows: [] } } } }))
  const e = errors(r.issues).find((i) => i.path === '$.provides.panel.component')
  assert.ok(e)
  for (const c of VLIB_COMPONENTS) assert.ok(String(e.fix).includes(c), 'fix 提示应列出白名单')
})

test('TC-PLG-007 VP3：panelRef 不匹配（大写 / 缺冒号 / 空格）→ error', () => {
  for (const bad of ['watchlist', 'panel:Watchlist', 'panel:my panel', 'panel:']) {
    const r = parsePluginManifest(panelRaw({ provides: { panel: { panelRef: bad, title: 'x', component: 'DataTable', data: { kind: 'static', rows: [] } } } }))
    assert.ok(errors(r.issues).some((i) => i.path === '$.provides.panel.panelRef'), `${bad} 应非法`)
  }
})

test('TC-PLG-008 VP3：data.kind 非法 → error；file 缺 path → error', () => {
  const badKind = parsePluginManifest(panelRaw({ provides: { panel: { panelRef: 'panel:x', title: 'x', component: 'DataTable', data: { kind: 'weird' } } } }))
  assert.ok(errors(badKind.issues).some((i) => i.path === '$.provides.panel.data.kind'))
  const noPath = parsePluginManifest(panelRaw({ provides: { panel: { panelRef: 'panel:x', title: 'x', component: 'DataTable', data: { kind: 'file' } } } }))
  assert.ok(errors(noPath.issues).some((i) => i.path === '$.provides.panel.data.path'))
  // mcp 必须给 server + method
  const noServer = parsePluginManifest(panelRaw({ provides: { panel: { panelRef: 'panel:x', title: 'x', component: 'DataTable', data: { kind: 'mcp' } } } }))
  assert.ok(errors(noServer.issues).some((i) => i.path === '$.provides.panel.data.server'))
})

test('TC-PLG-009 VP3：static 数据形状与组件不匹配（DataTable 缺 rows）→ error', () => {
  const r = parsePluginManifest(panelRaw({ provides: { panel: { panelRef: 'panel:x', title: 'x', component: 'DataTable', data: { kind: 'static' } } } }))
  const e = errors(r.issues).find((i) => i.path === '$.provides.panel.data')
  assert.ok(e, '「组件只认形状」必须在清单期拦下')
  assert.match(e!.message, /rows/)
})

/* ============================================================
 * VP4 renderer
 * ============================================================ */

test('TC-PLG-010 VP4：rendererKind 非法 → error；extensions 大写/带点/空数组 → error', () => {
  const base = { extensions: ['kchart'] }
  const badKind = parsePluginManifest(panelRaw({ kind: 'renderer', provides: { renderer: { ...base, rendererKind: '3d' } } }))
  assert.ok(errors(badKind.issues).some((i) => i.path === '$.provides.renderer.rendererKind'))
  for (const exts of [['KCHART'], ['.kchart'], []]) {
    const r = parsePluginManifest(panelRaw({ kind: 'renderer', provides: { renderer: { ...base, rendererKind: 'table', extensions: exts } } }))
    assert.ok(errors(r.issues).some((i) => i.path === '$.provides.renderer.extensions'), `${JSON.stringify(exts)} 应非法`)
  }
})

/* ============================================================
 * VP5 theme
 * ============================================================ */

test('TC-PLG-011 VP5：theme token 键非法 → error；值 url(...) → error', () => {
  const badKey = parsePluginManifest(panelRaw({ kind: 'theme', provides: { theme: { light: { background: '#fff' } } } }))
  assert.ok(errors(badKey.issues).some((i) => i.path.startsWith('$.provides.theme')))
  const badValue = parsePluginManifest(panelRaw({ kind: 'theme', provides: { theme: { light: { '--accent': 'url(evil)' } } } }))
  assert.ok(errors(badValue.issues).some((i) => i.path === '$.provides.theme.light.--accent'))
  // 合法 token 全量保留
  const good = parsePluginManifest(panelRaw({ kind: 'theme', provides: { theme: { light: { '--accent': '#3b82f6' }, dark: { '--accent': '#60a5fa' } } } }))
  assert.equal(errors(good.issues).length, 0)
  const themeLight = good.manifest?.provides.theme?.light
  assert.equal(themeLight?.['--accent'] ?? '', '#3b82f6')
})

/* ============================================================
 * VP6 homeModule / action
 * ============================================================ */

test('TC-PLG-012 VP6：module 不匹配 module:<id> → error；actionId 为空 → error', () => {
  const badModule = parsePluginManifest(panelRaw({ kind: 'homeModule', provides: { homeModule: { module: 'market-overview', title: '行情' } } }))
  assert.ok(errors(badModule.issues).some((i) => i.path === '$.provides.homeModule.module'))
  const badAction = parsePluginManifest(panelRaw({ kind: 'action', provides: { action: { actionId: '', label: '标记' } } }))
  assert.ok(errors(badAction.issues).some((i) => i.path === '$.provides.action.actionId'))
})

/* ============================================================
 * 解析器健壮性
 * ============================================================ */

test('TC-PLG-013 解析器永不抛错：null / 字符串 / 数组 → manifest null + issues', () => {
  for (const bad of [null, 'plugin', [1, 2], 42, undefined]) {
    const r = parsePluginManifest(bad)
    assert.equal(r.manifest, null)
    assert.ok(r.issues.length > 0)
  }
})

test('TC-PLG-014 一次带 3 处问题 → 每条 error 都有 path 与 fix', () => {
  const r = parsePluginManifest(panelRaw({
    id: 'bad id',
    provides: { panel: { panelRef: 'panel:X', title: 'x', component: 'MyTable', data: { kind: 'static', rows: [] } } },
  }))
  const errs = errors(r.issues)
  assert.ok(errs.length >= 3, `至少 3 条 error，实际 ${errs.length}`)
  for (const e of errs) {
    assert.ok(e.path.length > 0, '每条 error 必须带 JSON Path')
    assert.ok(e.fix && e.fix.length > 0, `error（${e.path}）必须给修复建议`)
  }
})

/* ============================================================
 * v0.34.0（D54）—— 展示名含未解析模板占位符的告警
 * 规格：docs/versions/v0.34.0/04-system-design.md §6.5
 *
 * 用户实测：竖排栏插件标签悬停 tip 出 `{{titile}}`。
 * 除了 i18n 变量名错配（另有 i18n-interpolation-contract 把守），
 * 还有一种来源：**作者在 plugin.json 里直接写了占位符**。
 * 宿主展示层不做二次插值 → 界面原样显示 `{{...}}`。
 *
 * 取舍：这类清单**照常注册**（不是 error）——
 * `{{}}` 在作者自己的构建管线里是合法语法，宿主无权拒绝。
 * 但必须把事实作为 warning 报给作者，否则缺陷永远只在界面上显形。
 * ============================================================ */

const warnings = (issues: PluginIssue[]) => issues.filter((i) => i.level === 'warning')

test('TC-PLG-015 panel title 含 {{…}} → 报 VP3 warning，但**照常注册**（不半注册）', () => {
  const r = parsePluginManifest(
    panelRaw({
      provides: {
        panel: {
          panelRef: 'panel:watchlist',
          title: '{{titile}}',
          component: 'DataTable',
          data: { kind: 'static', rows: [{ a: 1 }] },
        },
      },
    }),
  )
  assert.ok(r.manifest, '不得因告警拒注册 —— 照常生效，只是告知作者')
  assert.equal(errors(r.issues).length, 0, '不得产生 error')
  const w = warnings(r.issues)
  assert.equal(w.length, 1, `应恰有 1 条 warning，实际 ${JSON.stringify(r.issues)}`)
  assert.equal(w[0]!.rule, 'VP3')
  assert.equal(w[0]!.path, '$.provides.panel.title')
  assert.match(w[0]!.message, /模板占位符/)
  assert.ok(w[0]!.fix && w[0]!.fix.length > 0, '告警也要给修复建议')
  // 注册后 title 保持原样（宿主不做替换 —— 线索必须留在屏幕上）
  assert.equal(r.manifest!.provides.panel!.title, '{{titile}}')
})

test('TC-PLG-016 panel title 内嵌占位符（句中）同样识别', () => {
  const r = parsePluginManifest(
    panelRaw({
      provides: {
        panel: {
          panelRef: 'panel:watchlist',
          title: '来自插件的面板：{{title}}',
          component: 'DataTable',
          data: { kind: 'static', rows: [{ a: 1 }] },
        },
      },
    }),
  )
  assert.ok(r.manifest)
  assert.equal(warnings(r.issues).length, 1)
})

test('TC-PLG-017 正常 title 不产生任何告警（不许把 warn 通道刷成噪音）', () => {
  const r = parsePluginManifest(panelRaw())
  assert.ok(r.manifest)
  assert.equal(warnings(r.issues).length, 0, `正常清单不得有告警：${JSON.stringify(r.issues)}`)
})

test('TC-PLG-018 homeModule title / action label 含占位符 → 各自 VP6 warning', () => {
  const hm = parsePluginManifest({
    schemaVersion: '1.0',
    id: 'ark.plugin.home',
    name: '首页',
    version: '1.0.0',
    kind: 'homeModule',
    provides: { homeModule: { module: 'module:overview', title: '{{homeTitle}}' } },
  })
  assert.ok(hm.manifest, '告警不阻断注册')
  assert.equal(warnings(hm.issues).length, 1)
  assert.equal(warnings(hm.issues)[0]!.rule, 'VP6')
  assert.equal(warnings(hm.issues)[0]!.path, '$.provides.homeModule.title')

  const ac = parsePluginManifest({
    schemaVersion: '1.0',
    id: 'ark.plugin.act',
    name: '动作',
    version: '1.0.0',
    kind: 'action',
    provides: { action: { actionId: 'annotate', label: '{{label}}' } },
  })
  assert.ok(ac.manifest)
  assert.equal(warnings(ac.issues).length, 1)
  assert.equal(warnings(ac.issues)[0]!.path, '$.provides.action.label')
})

test('TC-PLG-019 单花括号 / 空 title → 不误报（边界：必填失败时不再叠占位符告警）', () => {
  const single = parsePluginManifest(
    panelRaw({
      provides: {
        panel: {
          panelRef: 'panel:watchlist',
          title: '速度 {v}',
          component: 'DataTable',
          data: { kind: 'static', rows: [{ a: 1 }] },
        },
      },
    }),
  )
  assert.ok(single.manifest)
  assert.equal(warnings(single.issues).length, 0, '单花括号不是 i18n 模板，不得误报')

  const empty = parsePluginManifest(
    panelRaw({
      provides: {
        panel: {
          panelRef: 'panel:watchlist',
          title: '',
          component: 'DataTable',
          data: { kind: 'static', rows: [{ a: 1 }] },
        },
      },
    }),
  )
  assert.equal(empty.manifest, null)
  assert.equal(warnings(empty.issues).length, 0, '必填校验失败时不必再报占位符告警')
})

/* ============================================================
 * D61 回归：http 数据源在清单层必须被认可
 * ============================================================ */

test('TC-PLG-020 [D61 回归] http 数据源合法 url → 无 error（不得被当作未知 kind 拒绝）', () => {
  const ok = parsePluginManifest(
    panelRaw({
      provides: {
        panel: {
          panelRef: 'panel:watchlist',
          title: '自选股',
          component: 'DataTable',
          data: { kind: 'http', http: { url: 'https://example.com/quotes.json', path: 'data.list' }, rows: [] },
        },
      },
    }),
  )
  assert.equal(errors(ok.issues).length, 0, `http 源必须放行：${JSON.stringify(ok.issues)}`)
  assert.ok(ok.manifest, 'http 源面板必须正常注册')

  // 反面：http 缺 url / 非 http(s) 协议仍要拦（放行不等于不校验）
  const noUrl = parsePluginManifest(
    panelRaw({
      provides: {
        panel: {
          panelRef: 'panel:watchlist',
          title: '自选股',
          component: 'DataTable',
          data: { kind: 'http', http: {}, rows: [] },
        },
      },
    }),
  )
  assert.ok(errors(noUrl.issues).some((i) => i.path === '$.provides.panel.data.http.url'), '缺 url 必须报错')

  const badProto = parsePluginManifest(
    panelRaw({
      provides: {
        panel: {
          panelRef: 'panel:watchlist',
          title: '自选股',
          component: 'DataTable',
          data: { kind: 'http', http: { url: 'ftp://example.com/a.json' }, rows: [] },
        },
      },
    }),
  )
  assert.ok(errors(badProto.issues).some((i) => i.path === '$.provides.panel.data.http.url'), '非 http(s) 协议必须报错')
})

/* ============================================================
 * ★ v0.35.0 — engines.arkwork 兼容判定（TC-PMF-ENG-001..008）
 *
 * 为什么单独立组：`satisfiesEngineRange` 此前**零覆盖**，而它有两个叠加缺陷：
 *   ① 运算符分组写成了非捕获组 `(?:>=|\^)?` → `r[1]` 拿到的是主版本号数字，
 *      运算符恒为 ''，判定掉进「精确等值」分支且比较对象是 NaN → 恒 false；
 *   ② 调用方（registry）从未注入宿主版本 → 恒为占位值 '0.0.0'。
 * 结果：**任何**声明 engines 的插件都被判不兼容。两个缺陷各自都能让 VP8 失效，
 * 所以本组既测正常语义，也测「恒 false」这个曾经的失败形态不再回来。
 * ============================================================ */

test('TC-PMF-ENG-001 ★ >= 语义：宿主不低于要求即兼容', () => {
  assert.equal(satisfiesEngineRange('>=0.30.0', '0.35.0'), true, '这正是曾经恒 false 的那条')
  assert.equal(satisfiesEngineRange('>=0.35.0', '0.35.0'), true, '边界：相等即满足')
  assert.equal(satisfiesEngineRange('>=0.35.1', '0.35.0'), false)
  assert.equal(satisfiesEngineRange('>=0.36.0', '0.35.0'), false)
  assert.equal(satisfiesEngineRange('>=0.34.99', '0.35.0'), true)
})

test('TC-PMF-ENG-002 ^ 语义：本实现定义为「同主版本且不低于」（0.x 下不设上限，属刻意简化）', () => {
  assert.equal(satisfiesEngineRange('^0.35.0', '0.35.0'), true)
  assert.equal(satisfiesEngineRange('^0.35.0', '0.35.2'), true)
  assert.equal(satisfiesEngineRange('^0.35.0', '0.34.9'), false)
  assert.equal(satisfiesEngineRange('^0.30.0', '0.35.0'), true)
  // ★ 与 npm semver 的**刻意差异**：npm 把 0.x 的次版本当破坏性边界（^0.35.0 → <0.36.0），
  //   本实现只比主版本号（0.35.0 与 0.36.0 主版本都是 0 → 兼容）。
  //   这里如实钉住**本实现的语义**，而不是照抄 npm —— 免得下次有人「按 semver 修」时
  //   以为这是 bug，改完又和下面这条断言打架。
  assert.equal(
    satisfiesEngineRange('^0.35.0', '0.36.0'),
    true,
    '同主版本（0=0）且不低于 → 兼容；上限不在本实现的语义里',
  )
  assert.equal(satisfiesEngineRange('^1.0.0', '2.0.0'), false, '主版本不同 → 不兼容')
})

test('TC-PMF-ENG-003 精确值语义：必须逐位相等', () => {
  assert.equal(satisfiesEngineRange('0.35.0', '0.35.0'), true)
  assert.equal(satisfiesEngineRange('0.35.0', '0.35.1'), false)
  assert.equal(satisfiesEngineRange('0.35.0', '0.34.9'), false)
})

test('TC-PMF-ENG-004 ★ 三位数字比较（不是字符串比较）：0.9.0 低于 0.35.0 是错的，0.10.0 高于 0.9.0 才对', () => {
  // 若有人把实现改成字符串比较，这两条会立刻红 —— 这是本组的存在理由之一。
  assert.equal(satisfiesEngineRange('>=0.10.0', '0.9.0'), false, '0.9.0 < 0.10.0（数值比较）')
  assert.equal(satisfiesEngineRange('>=0.9.0', '0.10.0'), true, '0.10.0 > 0.9.0')
  assert.equal(satisfiesEngineRange('>=1.0.0', '0.99.99'), false)
  assert.equal(satisfiesEngineRange('>=0.0.1', '0.0.2'), true)
})

test('TC-PMF-ENG-005 宿主版本读不出来 → 放行（宁可放过，不误杀）', () => {
  for (const bad of ['', 'dev', '0.35', 'v0.35.0', 'abc', '0.35.0-beta.1']) {
    assert.equal(satisfiesEngineRange('>=99.0.0', bad), true, `宿主版本 ${bad} 无法解析时应放行`)
  }
})

test('TC-PMF-ENG-006 范围写法非法 → 不兼容（先把关形状，避免「看不懂就放过」）', () => {
  for (const bad of ['>=1.0', '1.0.0.0', '~1.0.0', '>= 1.0.0', '*', '', '>=x.y.z']) {
    assert.equal(satisfiesEngineRange(bad, '0.35.0'), false, `非法范围 ${bad} 应判不兼容`)
  }
})

test('TC-PMF-ENG-007 ★ 回归锁：合法范围在「宿主版本正常」时不得整片判 false（旧缺陷形态）', () => {
  // 旧实现下这四条全为 false。用一整片断言把「恒 false」这个形态钉死。
  const cases: Array<[string, string]> = [
    ['>=0.30.0', '0.35.0'],
    ['^0.30.0', '0.35.0'],
    ['>=0.35.0', '0.35.0'],
    ['0.35.0', '0.35.0'],
  ]
  for (const [range, host] of cases) {
    assert.equal(satisfiesEngineRange(range, host), true, `${range} @ ${host} 应兼容`)
  }
})

test('TC-PMF-ENG-008 清单层：engines.arkwork 写法非法 → VP8 error + fix，且整体拒绝解析', () => {
  const r = parsePluginManifest(panelRaw({ engines: { arkwork: '>=1.0' } }))
  // 解析器的既定契约：只要出现 error 级问题就 `manifest: null`（不给出半成品清单）
  assert.equal(r.manifest, null, '有 error 时不产出清单 —— 避免下游拿着半合法清单跑起来')
  const hit = r.issues.filter((i) => i.path.includes('engines'))
  assert.ok(hit.length > 0, 'engines 写法非法必须报出来')
  assert.equal(hit[0]!.rule, 'VP8')
  assert.equal(hit[0]!.level, 'error')
  assert.ok(Boolean(hit[0]!.fix), '必须给人话修法')
})

test('TC-PMF-ENG-009 清单层：合法 engines 写法被保留进清单（供主进程按真实版本判 VP8）', () => {
  const r = parsePluginManifest(panelRaw({ engines: { arkwork: '>=0.30.0' } }))
  assert.ok(r.manifest, `合法 engines 不该被拒：${JSON.stringify(r.issues)}`)
  assert.equal(r.manifest!.engines?.arkwork, '>=0.30.0', '形状校验通过后要原样带进清单')
  assert.equal(r.issues.length, 0, '合法写法不该产生噪音')
})
