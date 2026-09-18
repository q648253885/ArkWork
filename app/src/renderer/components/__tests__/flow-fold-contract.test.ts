/* ============================================================
 * v0.32.0 — 交互区折叠 UI 契约（TC-FOLD-013..018）
 *   —— 纯函数 adjacents 由 `shared/utils/__tests__/flow-fold.test.ts` 覆盖，
 *      这里守住**渲染侧不可退化的结构事实**（同 interactive-copy 体例）。
 *
 * 为什么是源码契约：StepView / ProcessFold 依赖 zustand + i18n + 组件树，
 * node:test 无法挂载；但「折叠行不许塌为空壳」「展开态必须进 store」
 * 这类约束一旦被改回去，只有源码断言能第一时间拦住。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs flow-fold-contract
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const R = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf-8')
const CODE = (rel: string): string => R(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

const STEP = '../../../../src/renderer/components/flow/StepView.tsx'
const FOLD = '../../../../src/renderer/components/flow/ProcessFold.tsx'
const CSS = '../../../../src/renderer/styles/globals.css'

test('TC-FOLD-013 StepView 走 segmentFlow 分段渲染，不再平铺全部块', () => {
  const src = CODE(STEP)
  assert.match(src, /segmentFlow\(/, '必须消费纯函数的分段结果')
  assert.match(src, /<ProcessFold/, '进程段必须交给 ProcessFold 渲染')
})

test('TC-FOLD-014 展开态存 store 而非组件 useState（虚拟化后组件态会丢）', () => {
  const fold = CODE(FOLD)
  assert.ok(!/useState<boolean>/.test(fold), '折叠展开态不得用组件本地 state')
  assert.match(fold, /useStore\(/, '必须读写 store')
  assert.match(fold, /s\.flow\.blockUiState\[run\.id\]/, '展开态必须落在 store 的 blockUiState 上')
  assert.match(fold, /setBlockOpen\(run\.id, !open\)/, '切换必须经 store action')
})

test('TC-FOLD-015 折叠行有信息量：工具按八分类计数，思考按时长/条数，不再是空壳摘要', () => {
  const fold = CODE(FOLD)
  assert.match(fold, /countToolRun\(run\.blocks\)/, '必须有工具 run 计数')
  assert.match(fold, /toolRunParts\(counts\)/, '摘要必须按类别分列（禁止「已调用 N 次」式空壳）')
  assert.match(fold, /flow-fold__duration/, '必须展示耗时（空壳摘要的头号投诉点）')
  const pure = R('../../../../src/shared/utils/flow-fold.ts')
  // 八分类真源：shared/types/tool-present.ts 的 ToolCallKind
  for (const kind of ['read', 'edit', 'delete', 'move', 'search', 'execute', 'fetch', 'other']) {
    assert.ok(pure.includes(`'${kind}'`), `flow-fold 缺kind ${kind}`)
  }
})

test('TC-FOLD-016 折叠条禁止原生 title 悬浮提示（项目既定规范：提示走 Tooltip）', () => {
  const fold = CODE(FOLD)
  assert.ok(!/title=/.test(fold), 'ProcessFold 不得使用原生 title 属性')
})

test('TC-FOLD-017 折叠条两态可读 + 反馈完整（hover / 焦点环 / 失败语义色）', () => {
  const css = R(CSS)
  // 折叠体：独立细线 + 缩进，不靠父容器偶然继承
  assert.match(css, /\.flow-fold__body \{[^}]*border-left: 1px solid var\(--border-subtle\)/s)
  assert.match(css, /\.flow-fold__body \{[^}]*animation: flow-fold-in/s, '展开要有入场提示')
  // 交互反馈：hover 底色 + focus 可见环（键盘可达）
  assert.match(css, /\.flow-fold__head:hover \{[^}]*background: var\(--bg-overlay-l1\)/s)
  assert.match(css, /\.flow-fold__head:focus-visible \{[^}]*outline: 2px solid/s)
  // 失败不静默：折叠态下失败也必须换语义色
  assert.match(css, /\.flow-fold\[data-state='failed'\][^{]*\{[^}]*color: var\(--danger\)/s)
  assert.ok(css.includes('v0.32.0'), 'CSS 必须带版本段的归属注释')
})

test('TC-FOLD-018 TurnHeader / TurnFooter 不含硬编码中文（文案一律走 i18n t()）', () => {
  for (const rel of [
    '../../../../src/renderer/components/flow/TurnHeader.tsx',
    '../../../../src/renderer/components/flow/TurnFooter.tsx',
    '../../../../src/renderer/components/flow/ProcessFold.tsx',
  ]) {
    const src = CODE(rel)
    const cjk = src.match(/[\u4e00-\u9fa5]+/g) ?? []
    // 允许出现在注释里；去注释后仍存在的中文 = 硬编码文案
    assert.deepEqual(cjk, [], `${rel} 存在硬编码中文：${cjk.slice(0, 3).join(' / ')}`)
  }
})

test('TC-FOLD-019 缺陷 D33 防回潮：折叠切换必须写入真实意图，且读数走应用态', () => {
  // 病根有两处，必须同时守住 —— 只修一处仍会「点开后收不起来」：
  //   ① store setter 恒写 userOpen:true → 三态门闩退化成恒真；
  //   ② 读数端把 userOpen 当展示态 → 门闩是不是真的都不影响显示。
  const slice = CODE('../../../../src/renderer/store/slices/uiSlice.ts')
  assert.ok(
    !/userOpen:\s*true/.test(slice),
    'setBlockOpen 不得硬编码 userOpen:true —— 这正是「收不起来」的病根（D33）',
  )
  assert.match(
    slice,
    /applyUserFoldToggle\(/,
    '折叠切换必须经 flow-fold 的纯函数写入（open 与 userOpen 同步落库）',
  )

  const fold = CODE(FOLD)
  assert.match(
    fold,
    /resolveFoldOpen\(\{[^}]*\bopen:/s,
    '读数必须把 store 的应用态 open 传给 resolveFoldOpen（与投影层 blockOpenOf 同口径）',
  )

  // 纯函数侧：门闩必须跟随用户意图，不能恒真
  const pure = R('../../../../src/shared/utils/flow-fold.ts')
  assert.match(
    pure,
    /export function applyUserFoldToggle\([\s\S]*?return \{ open, userOpen: open \}/,
    'applyUserFoldToggle 必须把 open 同时写进 userOpen',
  )
})
