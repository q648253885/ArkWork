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
     （shared/utils/plugin-theme-tokens.ts 的 PLUGIN_THEME_TOKENS，只增不改名）。
     契约外的颜色一律插件自带字面量（下方 diff 行着色即自带字面量），
     不要猜宿主内部令牌名。 */
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font: 13px/1.5 -apple-system, 'Segoe UI', 'PingFang SC', sans-serif;
    color: var(--text-primary, #1f2328);
    background: var(--bg-base, #ffffff);
    padding: 12px;
  }
  .row { display: flex; align-items: center; gap: 8px; }
  .flex1 { flex: 1; }
  .bar { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .bar h3 { font-size: 13px; font-weight: 600; flex: 1; }
  button {
    font: inherit; padding: 3px 10px; border-radius: 6px; cursor: pointer;
    border: 1px solid var(--border-default, #d0d7de);
    background: var(--bg-surface-2, #f6f8fa); color: inherit;
  }
  button.primary { background: var(--accent, #2563eb); border-color: var(--accent, #2563eb); color: #fff; }
  button.mini { font-size: 11px; padding: 1px 7px; border-radius: 5px; flex: none; }
  button:disabled { opacity: .5; cursor: default; }
  ul { list-style: none; }
  li.file {
    display: flex; gap: 6px; align-items: center; padding: 3px 4px;
    border-radius: 6px; white-space: nowrap; overflow: hidden;
  }
  li.file:hover { background: var(--bg-surface-3, rgba(0,0,0,.04)); }
  li.file .ftitle { flex: 1; overflow: hidden; text-overflow: ellipsis; direction: rtl; text-align: left; }
  li.file .fshint { flex: none; font-size: 11px; }
  li.file .ops { flex: none; display: none; gap: 4px; }
  li.file:hover .ops { display: inline-flex; }
  li.branch.current .ftitle { font-weight: 600; color: var(--accent, #2563eb); }
  /* 分组头（v0.42.0：已暂存 / 未暂存 两组，对齐代码工具的源代码管理形态） */
  .group { margin-bottom: 8px; }
  .group-head {
    display: flex; align-items: center; gap: 6px; padding: 3px 4px;
    font-size: 12px; font-weight: 600; cursor: pointer; user-select: none;
    border-radius: 6px;
  }
  .group-head:hover { background: var(--bg-surface-3, rgba(0,0,0,.04)); }
  .group-head .caret { display: inline-block; transition: none; width: 12px; }
  .group.closed ul { display: none; }
  .group.closed .caret { opacity: .5; }
  .gtitle { flex: none; }
  .empty-hint { padding: 8px 4px; }
  .badge {
    font-size: 11px; font-family: ui-monospace, monospace; padding: 0 5px;
    border-radius: 4px; background: var(--bg-surface-2, #f6f8fa);
    border: 1px solid var(--border-default, #d0d7de); flex: none;
  }
  .muted { color: var(--text-secondary, #6e7781); }
  .tabs { display: flex; gap: 2px; margin-bottom: 8px; border-bottom: 1px solid var(--border-default, #d0d7de); }
  .tabs button { border: none; background: none; border-radius: 6px 6px 0 0; padding: 4px 10px; }
  .tabs button.on { font-weight: 600; box-shadow: inset 0 -2px 0 var(--accent, #2563eb); }
  #msg { width: 100%; margin: 0; padding: 5px 8px; font: inherit; border-radius: 6px;
         border: 1px solid var(--border-default, #d0d7de); background: var(--bg-input, var(--bg-surface-2, #fff)); color: inherit; }
  #new-branch { flex: 1; min-width: 0; margin: 0; padding: 5px 8px; font: inherit; border-radius: 6px;
         border: 1px solid var(--border-default, #d0d7de); background: var(--bg-input, var(--bg-surface-2, #fff)); color: inherit; }
  #err { margin-top: 8px; word-break: break-all; display: none; }
  /* v0.45.0（R-G）：错误从裸红字改为警告条 —— 短人话 + 原始 stderr 折叠进「详情」，
     长串 stderr 不再糊满面板（实机反馈样式不美观）。 */
  #err .err-bar {
    display: flex; align-items: baseline; gap: 6px;
    color: var(--danger, #cf222e);
    /* 契约外颜色用自带字面量（TC-SMPL-029：var() 引用的令牌名必须在宿主契约内） */
    background: rgba(207, 34, 46, .07);
    border: 1px solid var(--border-default, #d0d7de);
    border-radius: 8px; padding: 6px 9px; font-size: 12px;
  }
  #err details { margin-top: 4px; font-size: 11px; }
  #err summary { color: var(--text-secondary, #6e7781); cursor: pointer; user-select: none; width: fit-content; }
  #err pre {
    margin: 4px 0 0; padding: 6px 8px; white-space: pre-wrap; word-break: break-all;
    font: 11px/1.5 ui-monospace, monospace; color: var(--text-secondary, #6e7781);
    background: var(--bg-surface-2, #f6f8fa); border: 1px solid var(--border-subtle, #eaeef2);
    border-radius: 6px; max-height: 120px; overflow: auto;
  }
  /* v0.45.0（R-G）：非 git 仓库空态 —— 隐藏全部操作面，给「初始化仓库」出口。
     判定来自 errSpeak/isNotRepoError（纯函数区，契约用例真跑）。 */
  body.norepo .bar button, body.norepo .tabs, body.norepo #tab-changes,
  body.norepo #tab-history, body.norepo #tab-branches, body.norepo #err { display: none !important; }
  #norepo { display: none; margin: 28px auto 0; max-width: 300px; text-align: center; }
  body.norepo #norepo { display: block; }
  #norepo .nicon { font-size: 30px; line-height: 1; margin-bottom: 10px; }
  #norepo .ntitle { font-size: 14px; font-weight: 600; margin-bottom: 6px; }
  #norepo .ndesc { color: var(--text-secondary, #6e7781); font-size: 12px; margin-bottom: 14px; }
  /* 差异 / 提交详情盒（v0.42.0 新增：点击文件行内联展开） */
  .diff-box { border: 1px solid var(--border-default, #d0d7de); border-radius: 8px;
              margin-top: 8px; background: var(--bg-surface, #fff); overflow: hidden; }
  .diff-head { display: flex; align-items: center; gap: 6px; padding: 4px 8px;
               border-bottom: 1px solid var(--border-subtle, #eaeef2); }
  .diff-title { font-family: ui-monospace, monospace; font-size: 11px; color: var(--text-secondary, #6e7781);
                overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .diff-view { max-height: 260px; overflow: auto; font: 11px/1.6 ui-monospace, monospace; padding: 4px 0; }
  .diff-view div { white-space: pre; padding: 0 8px; }
  .d-add  { color: var(--success, #1a7f37); background: rgba(46, 160, 67, .12); }
  .d-del  { color: var(--danger, #cf222e); background: rgba(248, 81, 73, .10); }
  .d-hunk { color: var(--accent, #2563eb); background: var(--accent-soft, rgba(57,100,254,.10)); }
  .d-file { color: var(--text-tertiary, #8c959f); }
  .d-ctx  { color: var(--text-secondary, #6e7781); }
</style>
</head>
<body>
  <div class="bar">
    <h3>Git</h3>
    <span id="branch" class="badge" style="display:none"></span>
    <!-- ★ D111：title / placeholder 是**用户可见文案**，不得直出命令行原文
         （与 renderer/constants.ts 的「废除工程视角直出」同一条纪律）。
         契约用例 TC-PGM-019 会把每个 title/placeholder 都过一遍 CJK 断言。 -->
    <button id="btn-pull" title="拉取远程更新">拉取</button>
    <button id="btn-push" title="推送到远程仓库">推送</button>
    <button id="btn-refresh" title="重新读取工作区状态">刷新</button>
  </div>
  <div class="tabs">
    <button data-tab="changes" class="on">更改</button>
    <button data-tab="history">历史</button>
    <button data-tab="branches">分支</button>
  </div>

  <div id="tab-changes">
    <div id="group-staged" class="group">
      <div class="group-head" data-group="staged">
        <span class="caret">▾</span>
        <span class="gtitle">已暂存</span>
        <span id="staged-count" class="muted"></span>
        <span class="flex1"></span>
        <button class="mini" data-op="unstage-all" title="撤出全部暂存（改动保留在工作区）">全部取消暂存</button>
      </div>
      <ul id="staged-list"></ul>
    </div>
    <div id="group-unstaged" class="group">
      <div class="group-head" data-group="unstaged">
        <span class="caret">▾</span>
        <span class="gtitle">未暂存</span>
        <span id="unstaged-count" class="muted"></span>
        <span class="flex1"></span>
        <button class="mini" data-op="stage-all" title="暂存全部改动">全部暂存</button>
      </div>
      <ul id="unstaged-list"></ul>
    </div>
    <div id="clean-hint" class="muted empty-hint" style="display:none">工作区干净，没有未提交的改动</div>
    <div id="commit-row">
      <input id="msg" placeholder="填写提交说明（只提交已暂存的改动）">
      <div class="row" style="margin-top:6px">
        <button id="btn-commit" class="primary" title="把已暂存的改动写入版本历史">提交已暂存</button>
        <span id="commit-hint" class="muted"></span>
      </div>
    </div>
    <div id="diff-box" class="diff-box" style="display:none">
      <div class="diff-head">
        <span id="diff-title" class="diff-title"></span>
        <span class="flex1"></span>
        <button id="diff-close" class="mini" title="收起差异详情">收起</button>
      </div>
      <div id="diff-view" class="diff-view"></div>
    </div>
  </div>

  <div id="tab-history" style="display:none">
    <ul id="history"></ul>
    <div id="commit-detail" class="diff-box" style="display:none">
      <div class="diff-head">
        <span class="diff-title">提交详情</span>
        <span class="flex1"></span>
        <button id="commit-detail-close" class="mini" title="收起提交详情">收起</button>
      </div>
      <div id="commit-detail-view" class="diff-view"></div>
    </div>
  </div>

  <div id="tab-branches" style="display:none">
    <div class="row" style="margin-bottom:8px">
      <input id="new-branch" placeholder="新分支名称">
      <button id="btn-branch-create" title="从当前版本创建新分支">新建</button>
    </div>
    <ul id="branches"></ul>
  </div>

  <!-- v0.45.0（R-G）：非 git 仓库空态（body.norepo 时显示，操作面全部隐藏） -->
  <div id="norepo">
    <div class="nicon">📁</div>
    <div class="ntitle">当前工作区不是 Git 仓库</div>
    <div class="ndesc">初始化后即可在这里查看更改、提交与分支。也可以在终端自行执行 git init 或克隆已有仓库。</div>
    <button id="btn-norepo-init" class="primary" title="在工作区根初始化新仓库（等同 git init）">初始化仓库</button>
  </div>

  <!-- v0.45.0（R-G）：错误条 = 一句人话 + 原始 stderr 折叠（替代裸红字直出） -->
  <div id="err">
    <div class="err-bar"><span id="err-text"></span></div>
    <details><summary>详情</summary><pre id="err-raw"></pre></details>
  </div>

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

/* v0.45.0（R-G）：showErr 重构 —— 短人话 + 原文折叠；"不是 git 仓库"切空态。
   空态判定用纯函数 isNotRepoError（契约用例真跑），此处只做 DOM 编排。 */
function showErr(e) {
  const wrap = document.getElementById('err')
  const raw = e && e.message ? e.message : String(e)
  if (isNotRepoError(raw)) {
    document.body.classList.add('norepo')
    wrap.style.display = 'none'
    return
  }
  document.body.classList.remove('norepo')
  document.getElementById('err-text').textContent = errSpeak(raw)
  document.getElementById('err-raw').textContent = raw
  wrap.style.display = 'block'
}
function clearErr() {
  const el = document.getElementById('err')
  el.style.display = 'none'
}

/* ---------- 渲染 ---------- */
var currentTab = 'changes'
var expandedDiffKey = null
var expandedCommitSha = null
var busyFlag = false

/* ★★ 纯函数区：只做「状态码 → 人话」「分组」「diff 行分类」的映射，**不碰 DOM**。
   为什么要显式圈出来：本仓没有 jsdom，面板脚本没法整体装载；契约用例
   （TC-PGM-016 / TC-PGM-018 / TC-PGM-020…）按下面两个标记**抽出本区源码后 new Function 真跑一遍** ——
   于是「状态徽标到底显示什么」是**语义校验**，而不是源码 grep（纪律⑫）。
   标记本身是护栏：删掉或改名 = 用例报红，不要顺手清理。 */
/* @@ARKWORK-PURE:START@@ */
/* 换行符（避免在模板串里写字面转义；区外代码同样可用 —— 区在脚本顶层作用域内） */
var NL = String.fromCharCode(10)
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

/* v0.42.0：更改分组（对齐代码工具源代码管理形态）——
   已暂存（X≠' '）一组、未暂存（Y≠' ' 或未跟踪）一组。
   同一文件两区都有改动时在两组各出现一次（VSCode 同口径）；
   未跟踪（'??'）只进未暂存组 —— 它还没有基线版本，谈不上「已暂存」。 */
function groupChanges(entries) {
  const staged = []
  const unstaged = []
  const list = entries || []
  for (let i = 0; i < list.length; i++) {
    const e = list[i]
    const x = e.x || ' '
    const y = e.y || ' '
    if (x === '?' && y === '?') { unstaged.push(e); continue }
    if (x !== ' ') staged.push(e)
    if (y !== ' ') unstaged.push(e)
  }
  return { staged: staged, unstaged: unstaged }
}

/* v0.42.0：unified diff 逐行分类（渲染用）。上限 400 行防大 diff 卡死面板。
   分类优先级：文件头（diff/index/+++ /---）→ hunk 头（@@）→ 增行（+）→
   删行（−）→ 上下文。前缀判定必须在增删行之前（'---' 也是 '-' 开头）。 */
function parseDiffLines(diffText) {
  const MAX_LINES = 400
  const s = String(diffText == null ? '' : diffText)
  if (!s) return { lines: [], truncated: false }
  const lines = s.split(NL)
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    let cls = 'd-ctx'
    if (line.indexOf('diff ') === 0 || line.indexOf('index ') === 0 || line.indexOf('+++') === 0 || line.indexOf('---') === 0) cls = 'd-file'
    else if (line.indexOf('@@') === 0) cls = 'd-hunk'
    else if (line.indexOf('+') === 0) cls = 'd-add'
    else if (line.indexOf('-') === 0) cls = 'd-del'
    out.push({ cls: cls, text: line })
  }
  return { lines: out.slice(0, MAX_LINES), truncated: out.length > MAX_LINES }
}

/* v0.42.0：分支列表 → 当前分支名（头部徽标用）。空列表 / 无当前位返回空串。 */
function branchLabel(entries) {
  const list = entries || []
  for (let i = 0; i < list.length; i++) {
    if (list[i].current) return list[i].name || ''
  }
  return ''
}

/* v0.45.0（R-G）：git stderr → 一句人话（错误条短文案；原文折叠进「详情」）。
   实机反馈：非 git 仓库时面板直出红字「git status 失败：fatal: not a git
   repository (or any of the parent directories): .git」，用户看不懂。
   常见错误先映射，未命中兜底透传原 message（诚实优先，不编造）。
   注意：本函数位于外层 TS 模板串内，注释/正则里不得出现反引号。 */
function errSpeak(message) {
  const m = String(message == null ? '' : message)
  if (/not a git repository/i.test(m)) return '当前工作区不是 Git 仓库'
  if (/nothing to commit/i.test(m)) return '没有可提交的内容'
  if (/no tracking information|no upstream/i.test(m)) return '当前分支还没有关联远程分支，无法拉取 / 推送'
  if (/failed to push some refs|\\[remote rejected\\]|\\[rejected\\]|fetch first/i.test(m)) return '推送被拒绝：远程有新提交，请先拉取再推送'
  if (/non-fast-forward/i.test(m)) return '推送被拒绝：本地与远程历史不一致，请先拉取'
  if (/Permission denied|authentication/i.test(m)) return '认证失败：请检查远程仓库的访问权限 / 凭据'
  if (/Could not resolve host|Connection timed out|Network is unreachable/i.test(m)) return '网络不通：无法连接远程仓库'
  return m
}

/* v0.45.0（R-G）：是否"不是 git 仓库"错误（驱动面板空态切换）。 */
function isNotRepoError(message) {
  return /not a git repository/i.test(String(message == null ? '' : message))
}
/* @@ARKWORK-PURE:END@@ */

function esc(s) {
  const d = document.createElement('span')
  d.textContent = s == null ? '' : String(s)
  return d.innerHTML
}

function escAttr(s) {
  // 用 split/join 而不是 replace(/"/g)：契约测试的注释剥离器按引号跟踪字符串，
  // 正则字面量里的引号会把后续块注释误判成字符串内文（TC-PGM-017 假红实录）。
  return esc(s).split('"').join('&quot;')
}

/* 行内文件行：徽标一律经 statusLabel（人话），**禁止**再拼 e.x + e.y 原始码（D111）。 */
function fileRowHtml(e, staged) {
  const label = e.origPath ? e.path + ' ← ' + e.origPath : e.path
  const untracked = statusLabel(e) === '未跟踪'
  const key = (staged ? 'staged:' : 'unstaged:') + e.path
  const ops = staged
    ? '<button class="mini" data-op="unstage">取消暂存</button>'
    : '<button class="mini" data-op="stage">暂存</button>'
  return '<li class="file" data-key="' + escAttr(key) + '" data-path="' + escAttr(e.path) + '"' +
    (staged ? ' data-staged="1"' : '') + (untracked ? ' data-untracked="1"' : '') + '>' +
    '<span class="badge">' + esc(statusLabel(e)) + '</span>' +
    '<span class="ftitle">' + esc(label) + '</span>' +
    '<span class="muted fshint">' + esc(statusHint(e)) + '</span>' +
    '<span class="ops">' + ops + '</span></li>'
}

function renderGroup(kind, list) {
  const groupEl = document.getElementById('group-' + kind)
  const ul = document.getElementById(kind + '-list')
  const empty = !list || list.length === 0
  groupEl.style.display = empty ? 'none' : ''
  document.getElementById(kind + '-count').textContent = empty ? '' : list.length + ' 个文件'
  let html = ''
  for (let i = 0; i < list.length; i++) html += fileRowHtml(list[i], kind === 'staged')
  ul.innerHTML = html
}

function renderStatus(res) {
  const entries = (res && res.output && res.output.entries) || []
  const g = groupChanges(entries)
  renderGroup('staged', g.staged)
  renderGroup('unstaged', g.unstaged)
  const clean = entries.length === 0
  document.getElementById('clean-hint').style.display = clean ? '' : 'none'
  document.getElementById('commit-row').style.display = clean ? 'none' : ''
  hideDiff()
  updateCommitButton()
}

function renderLog(res) {
  const entries = (res && res.output && res.output.entries) || []
  document.getElementById('history').innerHTML = entries.length
    ? entries.map(function (e) {
        return '<li class="file" data-sha="' + escAttr(e.hash) + '"><span class="badge">' + esc(e.short) + '</span>' +
          '<span class="ftitle" title="' + esc(e.subject) + '">' + esc(e.subject) + '</span>' +
          '<span class="muted fshint">' + esc((e.author || '') + ' ' + (e.date || '').slice(0, 10)) + '</span></li>'
      }).join('')
    : '<li class="muted">暂无提交</li>'
}

function renderBranches(res) {
  const entries = (res && res.output && res.output.entries) || []
  document.getElementById('branches').innerHTML = entries.length
    ? entries.map(function (b) {
        const ops = b.current
          ? '<span class="badge">当前</span>'
          : '<span class="ops"><button class="mini" data-op="checkout">切换</button>' +
            '<button class="mini" data-op="branch-del">删除</button></span>'
        return '<li class="file branch' + (b.current ? ' current' : '') + '" data-name="' + escAttr(b.name) + '">' +
          '<span class="ftitle">' + esc(b.name) + '</span>' + ops + '</li>'
      }).join('')
    : '<li class="muted">无分支信息</li>'
  applyBranch(entries)
}

/* 头部分支徽标（branch-list 的当前位；无仓库 / 空列表 → 藏起来） */
function applyBranch(entries) {
  const label = branchLabel(entries)
  const el = document.getElementById('branch')
  el.textContent = label
  el.style.display = label ? '' : 'none'
}

function updateCommitButton() {
  const btn = document.getElementById('btn-commit')
  const msg = document.getElementById('msg').value.trim()
  const stagedCount = document.querySelectorAll('#staged-list li.file').length
  btn.disabled = busyFlag || stagedCount === 0 || !msg
  document.getElementById('commit-hint').textContent = stagedCount === 0 ? '先在上方把要提交的文件暂存' : ''
}

function busy(on) {
  busyFlag = on
  const ids = ['btn-commit', 'btn-refresh', 'btn-push', 'btn-pull', 'btn-branch-create', 'btn-norepo-init']
  for (let i = 0; i < ids.length; i++) {
    const el = document.getElementById(ids[i])
    if (el) el.disabled = on
  }
  updateCommitButton()
}

function refresh() {
  clearErr()
  busy(true)
  return Promise.all([git('status'), git('branch-list')])
    .then(function (rs) {
      /* v0.45.0（R-G）：成功读取 = 是 git 仓库，退出空态（防止残留误判） */
      document.body.classList.remove('norepo')
      renderStatus(rs && rs[0])
      applyBranch((rs && rs[1] && rs[1].output && rs[1].output.entries) || [])
      busy(false)
      if (currentTab === 'history') return loadTab('history')
      if (currentTab === 'branches') return loadTab('branches')
    })
    .catch(function (e) { busy(false); showErr(e) })
}

/* v0.45.0（R-G）：空态「初始化仓库」—— 走既有写类白名单 op（宿主确认浮层 + 审计
   由宿主把关，与面板其它写操作同一通道），成功后退出空态并重读。 */
function initRepo() {
  busy(true)
  return git('init', {})
    .then(function () {
      busy(false)
      document.body.classList.remove('norepo')
      refresh()
    })
    .catch(function (e) { busy(false); showErr(e) })
}

function loadTab(tab) {
  clearErr()
  if (tab === 'history') return git('log', { limit: 50 }).then(renderLog).catch(showErr)
  if (tab === 'branches') return git('branch-list').then(renderBranches).catch(showErr)
}

/* ---------- 写操作统一走 runWrite（宿主确认浮层 + 审计由宿主把关，插件不做自己的审批） ---------- */
function runWrite(op, args) {
  clearErr()
  busy(true)
  return git(op, args)
    .then(function () { busy(false); refresh() })
    .catch(function (e) { busy(false); showErr(e) })
}

/* ---------- 差异 / 提交详情（点击展开，再次点击或「收起」收起） ---------- */
function hideDiff() {
  expandedDiffKey = null
  document.getElementById('diff-box').style.display = 'none'
}

function toggleDiff(li) {
  const key = li.getAttribute('data-key') || ''
  const path = li.getAttribute('data-path') || ''
  if (expandedDiffKey === key) { hideDiff(); return }
  expandedDiffKey = key
  const view = document.getElementById('diff-view')
  document.getElementById('diff-title').textContent = path
  document.getElementById('diff-box').style.display = ''
  view.innerHTML = '<div class="d-file">读取差异…</div>'
  if (li.getAttribute('data-untracked') === '1') {
    view.innerHTML = '<div class="d-file">未跟踪文件还没有基线版本，提交后可在这里查看差异</div>'
    return
  }
  const args = li.getAttribute('data-staged') === '1' ? { file: path, staged: true } : { file: path }
  git('diff', args).then(function (res) {
    if (expandedDiffKey !== key) return
    const text = (res && res.output && res.output.stdout) || ''
    const parsed = parseDiffLines(text)
    if (!parsed.lines.length) {
      view.innerHTML = '<div class="d-file">无差异</div>'
      return
    }
    let html = ''
    for (let i = 0; i < parsed.lines.length; i++) {
      html += '<div class="' + parsed.lines[i].cls + '">' + (esc(parsed.lines[i].text) || '&nbsp;') + '</div>'
    }
    if (parsed.truncated) html += '<div class="d-file">差异过长，只显示前 400 行</div>'
    view.innerHTML = html
  }).catch(function (e) { showErr(e) })
}

function hideCommitDetail() {
  expandedCommitSha = null
  document.getElementById('commit-detail').style.display = 'none'
}

function toggleCommit(li) {
  const sha = li.getAttribute('data-sha') || ''
  if (!sha) return
  if (expandedCommitSha === sha) { hideCommitDetail(); return }
  expandedCommitSha = sha
  const view = document.getElementById('commit-detail-view')
  document.getElementById('commit-detail').style.display = ''
  view.innerHTML = '<div class="d-file">读取提交详情…</div>'
  git('show', { sha: sha }).then(function (res) {
    if (expandedCommitSha !== sha) return
    const text = (res && res.output && res.output.stdout) || ''
    const lines = text.split(NL)
    const capped = lines.slice(0, 200)
    let html = ''
    for (let i = 0; i < capped.length; i++) {
      html += '<div class="d-ctx">' + (esc(capped[i]) || '&nbsp;') + '</div>'
    }
    if (lines.length > 200) html += '<div class="d-file">详情过长，只显示前 200 行</div>'
    view.innerHTML = html || '<div class="d-file">无详情</div>'
  }).catch(function (e) { showErr(e) })
}

/* ---------- 事件（委托：行内按钮 > 组头 > 文件行） ---------- */
document.getElementById('tab-changes').addEventListener('click', function (ev) {
  const target = ev.target
  if (!target || !target.closest) return
  const btn = target.closest('button[data-op]')
  if (btn) {
    const op = btn.getAttribute('data-op')
    if (op === 'stage-all') return runWrite('add', { files: ['.'] })
    if (op === 'unstage-all') return runWrite('reset', { files: ['.'] })
    const li = btn.closest('li.file')
    const path = li ? (li.getAttribute('data-path') || '') : ''
    if (!path) return
    if (op === 'stage') return runWrite('add', { files: [path] })
    if (op === 'unstage') return runWrite('reset', { files: [path] })
    return
  }
  const head = target.closest('.group-head')
  if (head) {
    head.parentElement.classList.toggle('closed')
    return
  }
  const li = target.closest('li.file')
  if (li) toggleDiff(li)
})

document.getElementById('diff-close').addEventListener('click', hideDiff)
document.getElementById('commit-detail-close').addEventListener('click', hideCommitDetail)

document.getElementById('tab-history').addEventListener('click', function (ev) {
  const target = ev.target
  if (!target || !target.closest) return
  const li = target.closest('li.file')
  if (li) toggleCommit(li)
})

document.getElementById('tab-branches').addEventListener('click', function (ev) {
  const target = ev.target
  if (!target || !target.closest) return
  const btn = target.closest('button[data-op]')
  if (!btn) return
  const li = btn.closest('li.branch')
  const name = li ? (li.getAttribute('data-name') || '') : ''
  if (!name) return
  if (btn.getAttribute('data-op') === 'checkout') return runWrite('checkout', { ref: name })
  if (btn.getAttribute('data-op') === 'branch-del') return runWrite('branch-delete', { name: name })
})

document.getElementById('btn-refresh').addEventListener('click', refresh)
/* v0.45.0（R-G）：空态初始化按钮 */
document.getElementById('btn-norepo-init').addEventListener('click', initRepo)
document.getElementById('btn-push').addEventListener('click', function () {
  runWrite('push', {})
})
document.getElementById('btn-pull').addEventListener('click', function () {
  runWrite('pull', {})
})
document.getElementById('btn-commit').addEventListener('click', function () {
  const msg = document.getElementById('msg').value.trim()
  if (!msg) { showErr(new Error('请先填写提交说明')); return }
  clearErr()
  busy(true)
  git('commit', { message: msg })
    .then(function () { document.getElementById('msg').value = ''; busy(false); refresh() })
    .catch(function (e) { busy(false); showErr(e) })
})
document.getElementById('msg').addEventListener('input', updateCommitButton)
document.getElementById('btn-branch-create').addEventListener('click', function () {
  const name = document.getElementById('new-branch').value.trim()
  if (!name) { showErr(new Error('请先填写分支名称')); return }
  clearErr()
  busy(true)
  git('branch-create', { name: name })
    .then(function () { document.getElementById('new-branch').value = ''; busy(false); refresh() })
    .catch(function (e) { busy(false); showErr(e) })
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
    // v0.42.0：1.0.0 → 1.1.0（面板升级：暂存分组 / 单文件操作 / 内联 diff / 分支操作；
    // 存量「仅差 version」的官方副本按未改动处理自动升级，见 isUntouchedCopy 真值表）
    version: '1.1.0',
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
