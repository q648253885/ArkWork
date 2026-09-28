/* ============================================================
 * ArkWork — Git Manager 随包代码插件用例（v0.36.0 · B3 / F3.5）
 * 设计文档：docs/versions/v0.36.0/04-system-design.md §3.5
 *
 * 为什么这个插件值得单独一组用例：
 *  ① 它是**唯一随包代码插件**（股票插件退役后），也是代码插件全链路的
 *     可执行范本 —— 用户装「插件开发指南」之前，先能看到一份真实可跑的实现；
 *  ② 它踩的是三套机制的交界：清单声明（provides.views/commands/permissions）
 *     ↔ 运行期注册（ctx.ark.views.register）↔ 能力网关（ctx.ark.git）；
 *     三者任何一处对不上都会「装得上但用不了」，且症状各不相同；
 *  ③ 它是**退役换血**的落点：股票插件必须真的被清掉，否则老用户目录里
 *     会长期躺着一个既不被承认、又没人删的残留（v0.34.1 的既定纪律）。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs plugin-git-manager
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  SAMPLE_PLUGIN_IDS,
  SAMPLE_PLUGIN_MANIFESTS,
  filesOf,
  isSamplePlugin,
  rawManifestOf,
} from '../sample-plugins.js'
import { RETIRED_SAMPLE_PLUGIN_IDS, removeRetiredSamplePlugins } from '../seed.js'
import { GIT_ALL_OPS, GIT_READ_OPS, GIT_WRITE_OPS } from '../../git/service.js'
/** 注释剥离器唯一真源（v0.36.0 · D101 收敛；本文件原有朴素正则副本已退役） */
import { stripComments } from '@shared/utils/source-guard'

const GIT_ID = 'ark.plugin.git-manager'

function manifest(): (typeof SAMPLE_PLUGIN_MANIFESTS)[number] {
  const m = SAMPLE_PLUGIN_MANIFESTS.find((x) => x.id === GIT_ID)
  assert.ok(m, '随包集里必须有 Git 管理插件（唯一代码插件范例）')
  return m
}

/* ============================================================
 * 一、清单契约
 * ============================================================ */

test('TC-PGM-001 清单形状：代码插件（main + renderer）且 kind=panel；engines 门槛对齐宿主版本', () => {
  const m = manifest()
  assert.equal(m.main, 'main.js', 'Host 半入口必填（代码插件与声明式插件的分界线）')
  assert.equal(m.renderer, 'panel.html', 'Client 半入口（自带界面）')
  assert.equal(m.kind, 'panel')
  assert.equal(m.engines?.arkwork, '^0.36.0', 'git 能力是 v0.36.0 引入的：老宿主上必须被 ENGINES_MISMATCH 拦住')
  assert.equal(m.enabledByDefault, true, '真实功能插件默认开（与股票插件同款决策）')
})

test('TC-PGM-002 权限恰为 git + views.register（要什么声明什么，不多不少）', () => {
  const m = manifest()
  assert.deepEqual([...(m.permissions ?? [])].sort(), ['git', 'views.register'])
})

test('TC-PGM-003 视图声明：viewRef 形如 view:*，placement 只允许 dock/float（VP8 封闭集）', () => {
  const m = manifest()
  const views = m.provides.views ?? []
  assert.equal(views.length, 1)
  assert.equal(views[0]!.viewRef, 'view:git')
  assert.ok(['dock', 'float'].includes(views[0]!.placement ?? 'dock'))
  assert.equal(views[0]!.renderer, 'panel.html')
})

test('TC-PGM-004 命令声明：QuickAction 入口（命令本质是 UI 动作，不给模型开工具）', () => {
  const m = manifest()
  const cmds = m.provides.commands ?? []
  assert.equal(cmds.length, 1)
  assert.equal(cmds[0]!.id, 'git.status')
  assert.match(cmds[0]!.title, /Git/)
  // 模型侧不新开工具：模型操作插件仍走既有 plugin_* 工具面
  assert.equal(m.provides.tools, undefined, '命令不该同时给模型开一个工具（两套入口 = 两套审批）')
})

/* ============================================================
 * 二、随包文件与 Host 半源码契约
 * ============================================================ */

test('TC-PGM-005 随包文件齐备：main.js 与 panel.html 都是落盘载荷（非空）', () => {
  const files = filesOf(GIT_ID)
  assert.ok(files, 'files 载荷必须存在（seed 落盘的唯一来源）')
  assert.ok(files!['main.js'] && files!['main.js']!.length > 200)
  assert.ok(files!['panel.html'] && files!['panel.html']!.length > 500)
  // 清单字段与 files 键必须对得上，否则落盘后 VP7「没有 Client 半入口」必红
  assert.ok(files![manifest().main!], `main 指向的文件必须在 files 里`)
  assert.ok(files![manifest().renderer!], `renderer 指向的文件必须在 files 里`)
})

test('TC-PGM-006 Host 半：注册的 viewRef 与清单声明逐一对应（声明给用户看，注册让它能开）', () => {
  const main = filesOf(GIT_ID)!['main.js']!
  const declared = (manifest().provides.views ?? []).map((v) => v.viewRef)
  for (const ref of declared) {
    assert.ok(main.includes(`'${ref}'`), `Host 半必须注册清单里声明的 ${ref}`)
  }
  assert.match(main, /ctx\.ark\.views\.register\(/, '视图靠运行期注册才会出现（清单声明不等于已注册）')
})

test('TC-PGM-007 Host 半：git 调用只经 ctx.ark.git，且**不自己实现审批**', () => {
  const main = filesOf(GIT_ID)!['main.js']!
  assert.match(main, /ctx\.ark\.git/, '走能力网关（网关负责权限闸门）')
  // 反例守卫：插件绕开网关直接起 git 进程 = 权限体系形同虚设
  assert.doesNotMatch(main, /child_process|execFile|spawn\(/, '插件不得自行起进程（审批与审计都会被绕过）')
  // 审批是宿主职责：插件侧出现确认 UI 反而是越界（它会绕过用户的权限模式）
  assert.doesNotMatch(main, /confirm|approve/i, '审批必须由宿主统一把关（见 git/service.ts）')
  // 桥方法名是 Client 半与 Host 半的契约点。
  // ★ 必须锚定完整命名空间 `ctx.ark.views.onCall` —— 只匹配 /onCall/ 会让
  //   「少写 .ark」这类笔误蒙混过关（B3 实机冒烟实录：ctx.views 为 undefined，
  //   插件激活直接 E_ACTIVATION_FAILED；而本用例当时仍是绿的）。
  assert.match(
    main,
    /ctx\.ark\.views\.onCall\(\s*'git\.run'/,
    'Client 半经 host.call 调进来的方法名必须稳定，且必须走 ctx.ark.views 命名空间',
  )
  // 反例守卫：不得出现裸 ctx.views（宿主 ctx 的 views 在 ark 命名空间下，没有顶层 views）
  // 断言前剥掉注释 —— 否则「注释里提到 ctx.views」会误报（本用例第一版就踩了这个坑）
  const code = stripComments(main)
  assert.doesNotMatch(code, /ctx\.views\b/, 'ctx 顶层没有 views —— 能力一律在 ctx.ark.* 下')
})

test('TC-PGM-008 Client 半：只经桥方法要数据，不自带网络/存储访问', () => {
  const html = filesOf(GIT_ID)!['panel.html']!
  assert.match(html, /postMessage/, 'iframe sandbox 与宿主通信只走 postMessage 桥')
  assert.doesNotMatch(html, /fetch\(|XMLHttpRequest|localStorage/, 'Client 半不得自行取数/落盘（沙箱外一律经 Host 半）')
  assert.match(html, /git\.run/, '数据都经 git.run 桥方法')
})

/* ============================================================
 * 三、来源与退役换血
 * ============================================================ */

test('TC-PGM-009 来源判定：git-manager 是随包（bundled，不可卸载）', () => {
  assert.equal(SAMPLE_PLUGIN_IDS.has(GIT_ID), true)
  assert.equal(isSamplePlugin(GIT_ID), true, 'bundled 插件必须被卸载守卫拦下')
  assert.equal(isSamplePlugin('ark.plugin.stock'), false, '退役插件不再是随包件（否则它删不掉）')
})

test('TC-PGM-010 股票插件已登记退役，且不再出现在随包清单里', () => {
  assert.ok(RETIRED_SAMPLE_PLUGIN_IDS.includes('ark.plugin.stock'), '不登记退役 = 老用户目录里永久残留')
  assert.equal(
    SAMPLE_PLUGIN_MANIFESTS.some((m) => m.id === 'ark.plugin.stock'),
    false,
    '退役插件不得再随包（否则「已退役」与「随包」自相矛盾）',
  )
  assert.equal(rawManifestOf('ark.plugin.stock'), null)
})

test('TC-PGM-011 退役清理幂等且只删退役件（用户的同级插件必须留着）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arkwork-plugins-'))
  try {
    for (const id of ['ark.plugin.stock', 'ark.plugin.workbench-guide', 'my.own.plugin']) {
      mkdirSync(join(dir, id), { recursive: true })
      writeFileSync(join(dir, id, 'plugin.json'), '{}')
    }
    const first = removeRetiredSamplePlugins(dir)
    assert.deepEqual(first.sort(), ['ark.plugin.stock', 'ark.plugin.workbench-guide'])
    assert.equal(existsSync(join(dir, 'ark.plugin.stock')), false)
    assert.equal(existsSync(join(dir, 'my.own.plugin')), true, '用户自己的插件绝不能被误删')
    // 幂等：第二次没有可删的，不得抛错
    assert.deepEqual(removeRetiredSamplePlugins(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TC-PGM-012 清理目标必须都是「已登记退役」的 id（防手滑把在用插件写进名单）', () => {
  const live = new Set(SAMPLE_PLUGIN_MANIFESTS.map((m) => m.id))
  for (const id of RETIRED_SAMPLE_PLUGIN_IDS) {
    assert.equal(live.has(id), false, `${id} 同时在「退役名单」与「随包清单」里 —— 会删掉正在用的插件`)
  }
})

/* ============================================================
 * 四、能力面与 git 服务白名单的一致性
 * ============================================================ */

test('TC-PGM-013 插件声明的 git 能力面 = 宿主白名单（不多不少），读 7 写 13', () => {
  const main = filesOf(GIT_ID)!['main.js']!
  // Host 半按 op 名动态取 ctx.ark.git[op]，故此处钉的是「服务白名单自身」的形状：
  // 任何一方单独改动都会被这组断言暴露（面板按钮与服务能力脱节 = 点了就报未知操作）
  assert.deepEqual([...GIT_READ_OPS].length, 7)
  assert.deepEqual([...GIT_WRITE_OPS].length, 13)
  assert.equal(GIT_ALL_OPS.length, 20)
  assert.match(
    main,
    /未知 git 操作/,
    '插件对「取不到 handler」要给人话而非 TypeError（真正的白名单终审在 main/git/service.ts 的 E_GIT_UNKNOWN_OP）',
  )
})

test('TC-PGM-014 面板用到的 op 必须都在白名单内（防面板与服务脱节）', () => {
  const html = filesOf(GIT_ID)!['panel.html']!
  const used = new Set<string>()
  // 面板侧统一经 `git(op, args)` 桥助手（见 panel.html 的桥客户端）
  for (const m of html.matchAll(/\bgit\(\s*'([a-z-]+)'/g)) used.add(m[1]!)
  assert.ok(used.size >= 4, `面板应至少调用 4 种 op（实际 ${[...used].join(',')}）`)
  for (const op of used) {
    assert.ok(
      (GIT_ALL_OPS as readonly string[]).includes(op),
      `面板调用了白名单外的 op「${op}」—— 点了必然报未知操作`,
    )
  }
  // 三个页签各自的数据来源必须都在（否则页签点开是空白，属于「能开不能用」）
  for (const op of ['status', 'log', 'branch-list']) {
    assert.ok(used.has(op), `面板缺少 ${op} 调用（对应页签会空白）`)
  }
})

/* ============================================================
 * 五、真执行契约（语义校验，而非源码 grep）
 *
 * 这一节是 B3 实机冒烟的教训落点：TC-PGM-006/007 是**源码正则**，
 * 只证明「文件里有这句话」，不证明「这句话在真 ctx 上成立」。
 * 实机冒烟实录：插件写 `ctx.views.onCall(...)`（漏了 .ark），
 * 正则断言全绿、单测全过，但真宿主激活直接
 * E_ACTIVATION_FAILED `Cannot read properties of undefined (reading 'onCall')`。
 * ⇒ 凡「函数/对象在真形状上才成立」的接线，必须有一个把载荷**真跑一遍**的用例。
 * ============================================================ */

test('TC-PGM-015 Host 半真执行：apply(ctx) 在真实 ctx 形状（无顶层 views）下不抛，三处注册都落到实处', async () => {
  const src = filesOf(GIT_ID)!['main.js']!

  // stub ctx 形状**照抄** host-runtime.ts 的 ctx 构造（能力全在 ctx.ark.* 下，
  // 顶层没有 views / git）。忠实性正是本用例的价值 —— 若插件写 ctx.views.*，
  // 这里会像真宿主一样抛 TypeError，而不是被正则放行。
  const calls: { views: unknown[]; onCall: Array<[string, unknown]>; events: string[]; git: Array<[string, unknown]> } = {
    views: [],
    onCall: [],
    events: [],
    git: [],
  }
  const stubCtx: Record<string, unknown> = {
    manifest: { id: GIT_ID, provides: { commands: [{ id: 'git.status', title: 'Git: Refresh' }] } },
    effect: (d: unknown) => d,
    on: (event: string) => {
      calls.events.push(event)
      return () => {}
    },
    ark: {
      log: () => {},
      workspace: { root: async () => '' },
      fs: {},
      net: {},
      shell: {},
      tools: {},
      views: {
        register: (def: unknown) => {
          calls.views.push(def)
          return () => {}
        },
        onCall: (method: string, handler: unknown) => {
          calls.onCall.push([method, handler])
          return () => {}
        },
      },
      panels: {},
      storage: {},
      renderer: { post: () => {} },
      /**
       * 忠实复刻 host-runtime.ts 的 git Proxy：**任意字符串 op 都返回函数**，
       * 未知 op 由主进程 git 服务终审（E_GIT_UNKNOWN_OP）—— 宿主半不做镜像白名单。
       * 这里让 stub 也照此拒绝未知 op，从而能验证「网关的拒绝能传回面板」。
       */
      git: new Proxy(
        {},
        {
          get: (_t, prop): unknown => {
            if (typeof prop !== 'string' || prop === 'then') return undefined
            return async (args?: unknown) => {
              calls.git.push([prop, args])
              if (!(GIT_ALL_OPS as readonly string[]).includes(prop)) {
                throw new Error(`git 操作「${prop}」不在白名单内`)
              }
              return { ok: true, op: prop }
            }
          },
        },
      ),
    },
  }
  assert.equal(stubCtx.views, undefined, '顶层不得有 views（与真宿主一致，否则本用例失去意义）')

  // 以 CommonJS 载荷方式装载（与 Host 半加载插件同构）
  const mod: { exports: { apply?: (c: unknown) => void } } = { exports: {} }
  new Function('module', 'exports', src)(mod, mod.exports)
  assert.equal(typeof mod.exports.apply, 'function', 'Host 半必须导出 apply(ctx)')

  assert.doesNotThrow(() => mod.exports.apply!(stubCtx), '对真实 ctx 形状必须能激活成功（B3 冒烟门槛）')

  // ① 视图注册落到实处（viewRef 与清单声明一致、placement 合法、renderer 指向面板）
  assert.equal(calls.views.length, 1)
  const v = calls.views[0] as { viewRef?: string; placement?: string; renderer?: string }
  assert.equal(v.viewRef, 'view:git')
  assert.equal(v.placement, 'dock')
  assert.equal(v.renderer, 'panel.html')

  // ② 桥方法登记（Client 半 host.call 的唯一落点）
  assert.deepEqual(
    calls.onCall.map((x) => x[0]),
    ['git.run'],
  )

  // ③ 命令监听（QuickAction 入口）
  assert.ok(calls.events.includes('command:git.status'), '必须监听清单声明的命令事件')

  // ④ 桥 handler 真把 op 路由到 ctx.ark.git.<op>（而非自行起进程/写死分支）
  const handler = calls.onCall[0]![1] as (p: unknown) => Promise<unknown>
  const ok = await handler({ op: 'status', args: { short: true } })
  assert.deepEqual(calls.git, [['status', { short: true }]], 'op/args 必须原样透传到能力网关')
  assert.deepEqual(ok, { ok: true, op: 'status' })

  // ⑤ 缺 op 要给人话而不是 TypeError（插件侧唯一需要自己守的入参校验）
  await assert.rejects(() => handler({}), /缺少 op/)

  // ⑥ 白名单外 op **不在插件侧拦截**，而是原样转发给网关、由网关拒绝
  //    （单一事实源：白名单只存在于 main/git/service.ts，插件侧镜像它迟早漂移）
  calls.git.length = 0
  await assert.rejects(() => handler({ op: 'not-an-op', args: {} }), /不在白名单内/)
  assert.deepEqual(
    calls.git.map((x) => x[0]),
    ['not-an-op'],
    '未知 op 必须转发给网关终审（若插件本地就拦了，等于悄悄多出一份白名单）',
  )
})

/* ============================================================
 * 六、面板文案人话契约（D111：Git 面板把 porcelain 原始码当徽标显示）
 *
 * 用户实测（打包版截图）：「更改」页里未跟踪文件前面是一颗裸 **`??`** 徽标 ——
 * `renderStatus` 直接拼 `e.x + e.y`。与 D103–D108 同形（用户可见的工程视角直出），
 * 但这次发生在**插件自带界面**里：宿主管不到插件文案（沙箱 iframe），
 * 只能由「随包示范」这一份契约用例把守。
 *
 * 本节把「真执行」做在**纯函数区**上：本仓没有 jsdom，面板脚本没有 DOM 跑不起来，
 * 所以面板源码用 `@@ARKWORK-PURE:START/END@@` 显式圈出无 DOM 依赖的映射函数，
 * 用例抽出该区源码 `new Function` 真跑 —— 断言的是**返回值**，不是正则命中（纪律⑫）。
 * ============================================================ */

const PURE_START = '/* @@ARKWORK-PURE:START@@ */'
const PURE_END = '/* @@ARKWORK-PURE:END@@ */'

/** 抽出面板的纯函数区并真跑一遍，返回其中的映射函数（D111 引入的可测性接缝） */
function panelPure(): {
  statusLabel: (e: { x?: string; y?: string }) => string
  statusHint: (e: { x?: string; y?: string }) => string
} {
  const html = filesOf(GIT_ID)!['panel.html']!
  const a = html.indexOf(PURE_START)
  const b = html.indexOf(PURE_END)
  assert.ok(
    a >= 0 && b > a,
    '面板必须保留纯函数区标记（@@ARKWORK-PURE:START/END@@）—— 用例靠它抽出映射函数真执行；' +
      '标记不在了，本组用例就退化成「看不见被测对象」，故按失败处理',
  )
  return new Function(`${html.slice(a + PURE_START.length, b)}\nreturn { statusLabel: statusLabel, statusHint: statusHint }`)()
}

test('TC-PGM-016 ★ D111：状态徽标返回人话，对任何 porcelain 码都不再原样吐码（真执行）', () => {
  const { statusLabel } = panelPure()
  // 表驱动：覆盖 porcelain XY 的常见形态（含 D111 的现场样本 '??'）
  const cases: Array<[{ x: string; y: string }, string]> = [
    [{ x: '?', y: '?' }, '未跟踪'], // ← 用户截图里那颗 ?? 徽标
    [{ x: ' ', y: 'M' }, '已修改'], // 改了没暂存
    [{ x: 'M', y: ' ' }, '已修改'], // 已暂存
    [{ x: 'M', y: 'M' }, '已修改'], // 两区都有改动
    [{ x: 'A', y: ' ' }, '新增'],
    [{ x: 'D', y: ' ' }, '已删除'],
    [{ x: 'R', y: ' ' }, '重命名'],
    [{ x: 'T', y: ' ' }, '类型变更'],
    [{ x: 'C', y: ' ' }, '已复制'],
    [{ x: 'U', y: 'U' }, '冲突'],
  ]
  for (const [entry, want] of cases) {
    const got = statusLabel(entry)
    assert.equal(got, want, `${entry.x}${entry.y} 应显示为「${want}」`)
    assert.notEqual(got, entry.x + entry.y, '徽标绝不能等于原始 porcelain 码（D111 的病灶）')
    assert.doesNotMatch(got, /^[\sMADRCUT?!]{1,2}$/, '徽标不得是 1–2 位 ASCII 状态码')
    assert.match(got, /[\u4e00-\u9fa5]/, '徽标必须是中文人话')
  }
  // 兜底：未知码也要给人话，而不是把码原样漏出去
  assert.equal(statusLabel({ x: 'Z', y: 'Z' }), '待提交')
  assert.match(statusLabel({ x: '', y: '' }), /[\u4e00-\u9fa5]/)
  assert.match(statusLabel({ x: 'D', y: 'D' }), /冲突|已删除/, 'D/D 属未合并，档位不低于「已删除」')
})

test('TC-PGM-017 ★ D111：徽标**只**经 statusLabel 渲染，源码中不存在任何 raw 状态码拼接（唯一入口）', () => {
  const code = stripComments(filesOf(GIT_ID)!['panel.html']!)
  // ★ 断言前必须剥注释（纪律⑫）：本轮新写的说明注释里**正好**提到了坏写法
  //   `e.x + e.y`，不剥注释的话下面两条 doesNotMatch 会把注释本身当违规（假红）。
  assert.match(code, /esc\(\s*statusLabel\(\s*e\s*\)\s*\)/, '更改列表的徽标必须经 statusLabel(e) 渲染')
  assert.doesNotMatch(code, /e\.x\s*\+\s*e\.y/, '原始码拼接是 D111 的病灶，不得回归（换皮写法也一并拦下）')
  // 唯一入口（纪律⑧）：映射函数只许定义一次，且必须真被调用
  assert.equal(
    (code.match(/function\s+statusLabel\s*\(/g) ?? []).length,
    1,
    'statusLabel 必须只有一个定义（唯一事实源）',
  )
  assert.equal((code.match(/function\s+statusHint\s*\(/g) ?? []).length, 1, 'statusHint 必须只有一个定义')
  assert.ok(
    (code.match(/statusHint\s*\(/g) ?? []).length >= 2,
    'statusHint 定义了却没人调用 —— 抽出来不用等于没抽（D102 的教训）',
  )
})

test('TC-PGM-018 ★ D111：补充提示区分暂存区/工作区，未跟踪不重复提示（真执行）', () => {
  const { statusHint } = panelPure()
  assert.equal(statusHint({ x: '?', y: '?' }), '', '未跟踪已在徽标里写明，不再重复')
  assert.equal(statusHint({ x: 'M', y: ' ' }), '已暂存')
  assert.equal(statusHint({ x: ' ', y: 'M' }), '未暂存')
  assert.equal(
    statusHint({ x: 'M', y: 'M' }),
    '已暂存 + 未暂存',
    '两区都有改动必须都说出来，否则用户看到「已暂存」会以为已经干净了',
  )
})

test('TC-PGM-019 ★ D111 面：面板里一切用户可见文案不得直出命令行/工程串（title · placeholder）', () => {
  const code = stripComments(filesOf(GIT_ID)!['panel.html']!)
  // ① 直接钉住 D111 的原始写法：tooltip/placeholder 里塞命令行原文
  assert.doesNotMatch(code, /title="git\s/, 'title 不得是命令行原文（原为 "git push origin" / "git status" / "git reset"）')
  assert.doesNotMatch(code, /placeholder="[^"]*git\s/, 'placeholder 不得是命令行原文（原为 "提交说明（git commit -m）"）')

  // ② 泛化：**静态**属性值必须是中文文案。
  //    ⚠️ 必须排除「拼接式」属性（如 renderLog 的 title="' + esc(e.subject) + '"）——
  //    那类属性运行时是数据（提交标题），源码里抓到的是拼接片段，不是文案。
  //    这里以「不含引号/加号」判定为静态字面量；漏判的失败形态是**假红**（能看见），
  //    不会静默放行，可接受。
  const isStatic = (v: string) => !v.includes("'") && !v.includes('+')
  let statics = 0
  for (const m of code.matchAll(/\btitle="([^"]*)"/g)) {
    const v = m[1]!
    if (!isStatic(v)) continue
    statics += 1
    assert.match(v, /[\u4e00-\u9fa5]/, `title「${v}」是给用户看的文案，不得是命令行原文`)
  }
  for (const m of code.matchAll(/\bplaceholder="([^"]*)"/g)) {
    const v = m[1]!
    if (!isStatic(v)) continue
    statics += 1
    assert.match(v, /[\u4e00-\u9fa5]/, `placeholder「${v}」同上`)
  }
  assert.ok(statics >= 4, `应检查到至少 4 处静态 title/placeholder（实际 ${statics}）—— 少了说明标记/正则漂了`)
})
