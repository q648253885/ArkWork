/* ============================================================
 * ArkWork — 随包示例插件（v0.33.0 引入；v0.34.1 P6 收敛为「唯一范例 = 真实功能插件」；
 *                        v0.36.0（F3.5）股票退役 → Git Manager 代码插件登场）
 * 设计文档：docs/versions/v0.36.0/04-system-design.md §3.5
 *
 * ★ v0.36.0 变更（用户裁决：「删除股票插件，开发一个 git 管理插件」）：
 *   股票行情插件（ark.plugin.stock）移入退役名单（seed.ts 的
 *   RETIRED_SAMPLE_PLUGIN_IDS），存量用户目录由 removeRetiredSamplePlugins
 *   清理；唯一随包示例改为**代码插件**（有 Host 半 + 自带界面）：
 *
 *     ark.plugin.git-manager  Git 管理（侧边栏视图 · 封闭白名单 git 操作）
 *       · view:git   侧边栏：状态 / 暂存 / 提交 / 历史 / 分支 / 推送
 *       · command:git.status   QuickAction：刷新状态
 *
 *   它是**代码插件的官方范例**，覆盖声明式示例覆盖不到的能力点：
 *     ① `main` Host 半：ctx.views.register（运行期注册）+ ctx.views.onCall（桥方法）
 *     ② `ctx.ark.git.<op>`：封闭白名单 git 能力（读 7 免审批；写 13 走权限
 *        模式 + 宿主确认浮层 + 审计，见 main/git/service.ts）
 *     ③ `provides.views`：插件自带界面（iframe sandbox，经 host.call 桥回 Host 半）
 *     ④ `provides.commands`：QuickAction 命令入口（ctx.on('command:<id>')）
 *     ⑤ `files`：随包多文件（main.js / panel.html 由 seed.ts 落盘）
 *
 * 为什么清单仍以代码字面量为真源（而不是随包 resources 文件）：
 *  ① 代码即真源，避免「打包漏文件 → 示例插件凭空消失」；
 *  ② 落盘动作由代码执行，路径/内容可测（见 seed.ts）；
 *  ③ 用户可自由编辑落盘后的 plugin.json —— 那是**用户副本**，不再回写。
 * ============================================================ */
import { parsePluginManifest } from '@shared/utils/plugin-manifest'
import type { PluginManifest } from '@shared/types/plugin'

/** 插件目录名（`{userData}/arkwork-data/plugins`，见 store.ts） */
export const PLUGIN_DIR_NAME = 'plugins'

/* ============================================================
 * Host 半（main.js）与 Client 半（panel.html）的随包源码。
 *
 * 为什么内嵌为字符串而不是独立资源文件：与清单同一「代码即真源」纪律 ——
 * seed 落盘时可整体校验，测试可直接断言内容（不需要打包器配合）。
 * ⚠️ 模板串内**不得出现反引号与 `${`**（会终止外层模板字面量）。
 * ============================================================ */

const GIT_MANAGER_MAIN_JS = `/* ArkWork Git 管理 — Host 半（CommonJS；随包范例，可复制改造）
 * 职责：
 *   ① 运行期注册视图（与清单 provides.views 声明配套：声明给用户看，注册让它能开）
 *   ② 登记桥方法 git.run —— Client 半经 host.call 调进来，转发到 ctx.ark.git
 *   ③ 监听 QuickAction 命令 command:git.status
 * 审批边界：读类 op 免审批；写类 op 由宿主按权限模式弹确认浮层 —— 插件侧无需也
 * 不应自己实现审批（宿主统一把关，见 main/git/service.ts）。
 */
module.exports = {
  apply: function (ctx) {
    // ① 运行期注册视图（viewRef 必须与清单 provides.views 声明一致：view:git）
    //    title 给 3 字以内：竖排栏只有 44px，v0.36.0（D91）起宿主对超长名
    //    按 3 字截断；声明得合适就不用靠省略号（完整名在清单 name 与 tooltip 里）
    //    icon 必须是渲染层 icons.tsx 已登记的名字（v0.36.0 D92：写错会静默变成圆点）
    ctx.ark.views.register({
      viewRef: 'view:git',
      title: 'Git',
      icon: 'Branch',
      renderer: 'panel.html',
      placement: 'dock',
    })

    // ② 桥方法：Client 半 -> host.call { method:'git.run', params:{op,args} } -> 这里
    // 注意命名空间：所有能力都在 ctx.ark.* 下（ctx.views 是 undefined —— 实机 B3 冒烟踩过）
    ctx.ark.views.onCall('git.run', function (p) {
      const params = p && typeof p === 'object' ? p : {}
      const op = typeof params.op === 'string' ? params.op : ''
      if (!op) return Promise.reject(new Error('git.run 缺少 op 参数'))
      const fn = ctx.ark.git[op]
      if (typeof fn !== 'function') return Promise.reject(new Error('未知 git 操作：' + op))
      return Promise.resolve(fn(params.args ?? {}))
    })

    // ③ QuickAction：刷新状态（通知 Client 半重拉数据）
    ctx.on('command:git.status', function () {
      ctx.ark.renderer.post({ kind: 'git:refresh' })
    })
  },
}
`

const GIT_MANAGER_PANEL_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  /* ★ 主题令牌契约（v0.36.0 · D94）：这里只允许使用宿主承诺的令牌名
     （renderer/utils/plugin-theme.ts 的 PLUGIN_THEME_TOKENS，只增不改名）。
     先前写的 --bg-raised / --bg-hover 不在契约里 —— 宿主不下发，深色主题下
     就落到浅色兜底值，按钮和输入框变成一块块白底（实机截图可见）。
     想用契约外的颜色请插件自带字面量，不要猜宿主内部令牌名。 */
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font: 13px/1.5 -apple-system, 'Segoe UI', 'PingFang SC', sans-serif;
    color: var(--text-primary, #1f2328);
    background: var(--bg-base, #ffffff);
    padding: 12px;
  }
  .row { display: flex; align-items: center; gap: 8px; }
  .bar { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .bar h3 { font-size: 13px; font-weight: 600; flex: 1; }
  button {
    font: inherit; padding: 3px 10px; border-radius: 6px; cursor: pointer;
    border: 1px solid var(--border-default, #d0d7de);
    background: var(--bg-surface-2, #f6f8fa); color: inherit;
  }
  button.primary { background: var(--accent, #2563eb); border-color: var(--accent, #2563eb); color: #fff; }
  button:disabled { opacity: .5; cursor: default; }
  ul { list-style: none; }
  li {
    display: flex; gap: 6px; align-items: center; padding: 3px 4px;
    border-radius: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  li:hover { background: var(--bg-surface-3, rgba(0,0,0,.04)); }
  .badge {
    font-size: 11px; font-family: ui-monospace, monospace; padding: 0 5px;
    border-radius: 4px; background: var(--bg-surface-2, #f6f8fa);
    border: 1px solid var(--border-default, #d0d7de); flex: none;
  }
  .muted { color: var(--text-secondary, #6e7781); }
  .tabs { display: flex; gap: 2px; margin-bottom: 8px; border-bottom: 1px solid var(--border-default, #d0d7de); }
  .tabs button { border: none; background: none; border-radius: 6px 6px 0 0; padding: 4px 10px; }
  .tabs button.on { font-weight: 600; box-shadow: inset 0 -2px 0 var(--accent, #2563eb); }
  #msg { width: 100%; margin: 8px 0; padding: 5px 8px; font: inherit; border-radius: 6px;
         border: 1px solid var(--border-default, #d0d7de); background: var(--bg-surface-2, #fff); color: inherit; }
  #err { color: var(--danger, #cf222e); margin-top: 8px; word-break: break-all; display: none; }
  .commit { flex: 1; text-align: right; overflow: hidden; text-overflow: ellipsis; }
</style>
</head>
<body>
  <div class="bar">
    <h3>Git</h3>
    <span id="branch" class="muted"></span>
    <!-- ★ D111：title / placeholder 是**用户可见文案**，不得直出命令行原文
         （与 renderer/constants.ts 的「废除工程视角直出」同一条纪律）。
         契约用例 TC-PGM-019 会把每个 title/placeholder 都过一遍 CJK 断言。 -->
    <button id="btn-push" title="推送到远程仓库">推送</button>
    <button id="btn-refresh" title="重新读取工作区状态">刷新</button>
  </div>
  <div class="tabs">
    <button data-tab="changes" class="on">更改</button>
    <button data-tab="history">历史</button>
    <button data-tab="branches">分支</button>
  </div>

  <div id="tab-changes">
    <ul id="changes"></ul>
    <input id="msg" placeholder="填写提交说明">
    <div class="row">
      <button id="btn-commit" class="primary">暂存全部并提交</button>
      <button id="btn-unstage" title="撤出暂存（保留工作区改动）">取消暂存</button>
    </div>
  </div>

  <div id="tab-history" style="display:none">
    <ul id="history"></ul>
  </div>

  <div id="tab-branches" style="display:none">
    <ul id="branches"></ul>
  </div>

  <div id="err"></div>

<script>
/* ---------- 桥客户端（与宿主脚手架同一报文契约；经典脚本，无 import/export） ---------- */
var pending = {}
var seq = 1
var sessionId = null

function call(method, params) {
  if (!sessionId) return Promise.reject(new Error('宿主尚未完成握手'))
  const id = seq++
  return new Promise(function (resolve, reject) {
    pending[id] = { resolve: resolve, reject: reject }
    parent.postMessage({ kind: 'call', id: id, method: method, params: params }, '*')
  })
}

function git(op, args) {
  return call('host.call', { method: 'git.run', params: { op: op, args: args ?? {} } })
}

function applyTheme(tokens) {
  if (!tokens) return
  const root = document.documentElement
  for (const k in tokens) root.style.setProperty(k, tokens[k])
}

function showErr(e) {
  const el = document.getElementById('err')
  el.textContent = e && e.message ? e.message : String(e)
  el.style.display = 'block'
}
function clearErr() {
  const el = document.getElementById('err')
  el.style.display = 'none'
}

/* ---------- 渲染 ---------- */
var currentTab = 'changes'

/* ★★ 纯函数区：只做「状态码 → 人话」的映射，**不碰 DOM**。
   为什么要显式圈出来：本仓没有 jsdom，面板脚本没法整体装载；契约用例
   （TC-PGM-016 / TC-PGM-018）按下面两个标记**抽出本区源码后 new Function 真跑一遍** ——
   于是「状态徽标到底显示什么」是**语义校验**，而不是源码 grep（纪律⑫）。
   标记本身是护栏：删掉或改名 = 用例报红，不要顺手清理。 */
/* @@ARKWORK-PURE:START@@ */
/* git porcelain 状态码 → 人话（D111）。
   XY 两位：X = 暂存区状态、Y = 工作区状态；'?' + '?' 是未跟踪。
   用户不该在面板上看到「??」「M」这类工程码 —— 与 renderer/constants.ts 的
   「废除工程视角直出（大写标签 + 时间戳 + 原始参数串）」是同一条纪律，
   只是这次发生在**插件面板**（插件自带界面，宿主管不到它的文案，只能契约测试管）。 */
function statusLabel(e) {
  const x = e.x || ' '
  const y = e.y || ' '
  if (x === '?' && y === '?') return '未跟踪'
  // 未合并：任一位是 U，或 A/A、D/D —— 这类文件要人先解决冲突
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) return '冲突'
  // 工作区优先于暂存区：用户更关心「还有什么没提交」
  const c = y !== ' ' ? y : x
  if (c === 'M') return '已修改'
  if (c === 'T') return '类型变更'
  if (c === 'A') return '新增'
  if (c === 'D') return '已删除'
  if (c === 'R') return '重命名'
  if (c === 'C') return '已复制'
  return '待提交'
}

/* 补充提示：改动落在暂存区还是工作区（徽标只说「改了什么」，这里补「改在哪」）。
   未跟踪文件不重复提示 —— 徽标已经写明「未跟踪」。 */
function statusHint(e) {
  const x = e.x || ' '
  const y = e.y || ' '
  if (x === '?' && y === '?') return ''
  const staged = x !== ' '
  const unstaged = y !== ' '
  if (staged && unstaged) return '已暂存 + 未暂存'
  return staged ? '已暂存' : '未暂存'
}
/* @@ARKWORK-PURE:END@@ */

function esc(s) {
  const d = document.createElement('span')
  d.textContent = s == null ? '' : String(s)
  return d.innerHTML
}

function renderStatus(res) {
  const entries = (res && res.output && res.output.entries) || []
  document.getElementById('changes').innerHTML = entries.length
    ? entries.map(function (e) {
        const label = e.origPath ? e.path + ' ← ' + e.origPath : e.path
        // ★ D111：徽标一律经 statusLabel（人话），**禁止**再拼 e.x + e.y 原始码。
        //   补充提示同样经 esc 转义 —— 它是本地常量，但统一走 esc 免去将来注入面。
        return '<li><span class="badge">' + esc(statusLabel(e)) + '</span><span class="commit">' + esc(label) +
          '</span><span class="muted">' + esc(statusHint(e)) + '</span></li>'
      }).join('')
    : '<li class="muted">工作区干净</li>'
}

function renderLog(res) {
  const entries = (res && res.output && res.output.entries) || []
  document.getElementById('history').innerHTML = entries.length
    ? entries.map(function (e) {
        return '<li><span class="badge">' + esc(e.short) + '</span><span class="commit" title="' + esc(e.subject) + '">' +
          esc(e.subject) + '</span><span class="muted">' + esc((e.author || '') + ' ' + (e.date || '').slice(0, 10)) + '</span></li>'
      }).join('')
    : '<li class="muted">暂无提交</li>'
}

function renderBranches(res) {
  const entries = (res && res.output && res.output.entries) || []
  document.getElementById('branches').innerHTML = entries.length
    ? entries.map(function (b) {
        return '<li><span class="badge">' + (b.current ? '*' : ' ') + '</span><span class="commit">' + esc(b.name) + '</span></li>'
      }).join('')
    : '<li class="muted">无分支信息</li>'
}

function busy(on) {
  document.getElementById('btn-commit').disabled = on
  document.getElementById('btn-refresh').disabled = on
}

function refresh() {
  clearErr()
  busy(true)
  return git('status').then(function (res) {
    renderStatus(res)
    document.getElementById('branch').textContent = ''
    busy(false)
    if (currentTab === 'history') return loadTab('history')
    if (currentTab === 'branches') return loadTab('branches')
  }).catch(function (e) { busy(false); showErr(e) })
}

function loadTab(tab) {
  clearErr()
  if (tab === 'history') return git('log', { limit: 50 }).then(renderLog).catch(showErr)
  if (tab === 'branches') return git('branch-list').then(renderBranches).catch(showErr)
}

/* ---------- 事件 ---------- */
document.getElementById('btn-refresh').addEventListener('click', refresh)
document.getElementById('btn-push').addEventListener('click', function () {
  clearErr(); busy(true)
  git('push', {}).then(function () { busy(false); refresh() }).catch(function (e) { busy(false); showErr(e) })
})
document.getElementById('btn-commit').addEventListener('click', function () {
  const msg = document.getElementById('msg').value.trim()
  if (!msg) { showErr(new Error('请先填写提交说明')); return }
  clearErr(); busy(true)
  git('add', { files: ['.'] })
    .then(function () { return git('commit', { message: msg }) })
    .then(function () { document.getElementById('msg').value = ''; busy(false); refresh() })
    .catch(function (e) { busy(false); showErr(e) })
})
document.getElementById('btn-unstage').addEventListener('click', function () {
  clearErr(); busy(true)
  git('reset', { files: ['.'] }).then(function () { busy(false); refresh() }).catch(function (e) { busy(false); showErr(e) })
})
Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (b) {
  b.addEventListener('click', function () {
    currentTab = b.getAttribute('data-tab')
    Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (x) { x.classList.remove('on') })
    b.classList.add('on')
    document.getElementById('tab-changes').style.display = currentTab === 'changes' ? '' : 'none'
    document.getElementById('tab-history').style.display = currentTab === 'history' ? '' : 'none'
    document.getElementById('tab-branches').style.display = currentTab === 'branches' ? '' : 'none'
    loadTab(currentTab)
  })
})

/* ---------- 生命周期 ---------- */
window.addEventListener('message', function (e) {
  const m = e.data
  if (!m || typeof m !== 'object') return
  if (m.kind === 'lifecycle' && m.phase === 'activate') {
    sessionId = m.sessionId
    applyTheme(m.theme)
    void call('ui.ready', { name: 'Git Manager' })
    refresh()
    return
  }
  if (m.kind === 'event' && m.payload && m.payload.kind === 'git:refresh') { refresh(); return }
  if (m.kind === 'reply') {
    const p = pending[m.id]
    if (!p) return
    delete pending[m.id]
    if (m.ok) p.resolve(m.result)
    else p.reject(new Error((m.error && m.error.message) || '调用失败'))
  }
})
</script>
</body>
</html>
`

const RAW_BUILTINS: Array<Record<string, unknown>> = [
  {
    // v0.35.0：1.0 → 1.1（`order` 字段与代码插件入口同版）
    schemaVersion: '1.1',
    id: 'ark.plugin.git-manager',
    name: 'Git 管理',
    version: '1.0.0',
    author: 'ArkWork',
    description: '工作区 Git 状态、暂存、提交、历史与推送（封闭白名单操作，写操作需宿主确认）',
    kind: 'panel',
    main: 'main.js',
    renderer: 'panel.html',
    // 真实功能 → 默认启用（与原股票插件同款决策）
    enabledByDefault: true,
    // 宿主版本门槛：git 能力（ctx.ark.git）是 v0.36.0 引入的
    engines: { arkwork: '^0.36.0' },
    permissions: ['git', 'views.register'],
    provides: {
      views: [
        {
          viewRef: 'view:git',
          // v0.36.0（D91）：竖排栏标签预算 3 字（栏宽 44px）—— 声明值直接决定
          // 用户看到的名字，超长会被宿主截成「XX…」（完整名见本插件 name 字段）
          title: 'Git',
          // v0.36.0（D92）：必须是 icons.tsx 里已登记的名字；先前写的 'GitBranch'
          // 不在图标集内（只有 'Branch'），静默退化成一颗圆点
          icon: 'Branch',
          renderer: 'panel.html',
          placement: 'dock',
        },
      ],
      commands: [{ id: 'git.status', title: 'Git: 刷新状态' }],
    },
    // 随包多文件（seed.ts 落盘；不计入 plugin.json）
    files: {
      'main.js': GIT_MANAGER_MAIN_JS,
      'panel.html': GIT_MANAGER_PANEL_HTML,
    },
  },
]

/**
 * 随包示例插件（已过 VP1–VP6 校验）。
 * 清单结构非法属于**编程错误** → 模块加载期抛错（有测试在 CI 期把守）——
 * 落盘之后这些插件与用户插件同路径，坏清单会出现在「能力 → 插件」的问题区。
 *
 * `files` 是 seed 的落盘载荷而不是清单字段，参与 VP 校验前剥掉。
 */
export const SAMPLE_PLUGIN_MANIFESTS: PluginManifest[] = RAW_BUILTINS.map((raw) => {
  const { files: _files, ...manifestRaw } = raw
  const { manifest, issues } = parsePluginManifest(manifestRaw)
  if (!manifest) {
    const detail = issues.map((i) => `${i.rule} ${i.path}: ${i.message}`).join('; ')
    throw new Error(`[plugin] 随包示例插件 ${String(raw.id)} 清单非法：${detail}`)
  }
  return manifest
})

/** 原始字面量（供测试直接对落盘结果与字面量做一致性断言；含 files 载荷） */
export const RAW_SAMPLE_PLUGINS = RAW_BUILTINS

/** 随包示例插件 id 集合 —— 注册表据此判定 `source: 'bundled'`（不可卸载） */
export const SAMPLE_PLUGIN_IDS: ReadonlySet<string> = new Set(
  RAW_BUILTINS.map((raw) => String(raw.id)),
)

/** 是否随包示例插件（按 id 判定；卸载守卫与来源标记共用同一真源） */
export function isSamplePlugin(id: string): boolean {
  return SAMPLE_PLUGIN_IDS.has(id)
}

/** 供 UI 的「导出示例插件模板」用（让作者拿到可编辑的清单） */
export function sampleManifestForExport(id: string): PluginManifest | null {
  return SAMPLE_PLUGIN_MANIFESTS.find((p) => p.id === id) ?? null
}

/** 可编辑副本：落盘用的纯 JSON（剥离解析期派生字段，避免写回冗余） */
export function rawManifestOf(id: string): Record<string, unknown> | null {
  return RAW_BUILTINS.find((r) => String(r.id) === id) ?? null
}

/** 随包插件的附带文件载荷（`files` 字段；seed 落盘用） */
export function filesOf(id: string): Record<string, string> {
  const raw = RAW_BUILTINS.find((r) => String(r.id) === id)
  const files = raw?.files
  return files && typeof files === 'object' ? (files as Record<string, string>) : {}
}
