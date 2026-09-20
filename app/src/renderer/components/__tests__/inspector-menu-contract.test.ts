/* ============================================================
 * ArkWork — 「更多」弹层渲染契约（TC-MENU 组）
 * 规格来源：docs/versions/v0.34.3/04-system-design.md §D59 / §D60
 *
 * 为什么是**源码契约**：
 *   Inspector 依赖 zustand + i18n + 组件树，node:test 挂不起来（顶层读
 *   `import.meta.env`）。但本版要守的恰恰是「渲染宿主」「事件白名单」
 *   「样式真的绑到了激活态」这类**结构事实** —— 一旦被改回去，
 *   只有源码断言能第一时间拦住。
 *
 * ⚠️ 本组的能力边界（已登记为欠账 L-34-08，见 04-system-design.md §5）：
 *   它只能断言「宿主是 document.body 且 position:fixed」这一**结构等价物**，
 *   无法断言「像素上真的可见」。真正的可见性由**实机截图**把关
 *   （新纪律 ⑤：「在渲染树中」不等于「可见」）。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs inspector-menu-contract
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const R = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf-8')
const CODE = (rel: string): string =>
  R(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')

const INSPECTOR = '../Inspector.tsx'
const ANCHORED = '../../utils/anchored-menu.ts'
const TAILWIND = '../../../../tailwind.config.js'
const CSS = '../../styles/globals.css'

const src = (): string => CODE(INSPECTOR)

/* ---------- D59：浮层逃逸 ---------- */

test('TC-MENU-001 ★ 弹层逃逸栏盒：createPortal 到 document.body，不再用 absolute right-full', () => {
  const s = src()
  assert.match(s, /createPortal\(/, '弹层必须走 Portal 渲染')
  assert.match(s, /document\.body\s*,?\s*\)/, 'Portal 宿主必须是 document.body')
  // 旧写法必须消失 —— 它在 44px 宽、overflow-x:hidden 的栏盒里会被裁成零宽
  assert.ok(!/right-full/.test(s), '不得再用 right-full（会被 overflow-x: hidden 裁掉）')
})

test('TC-MENU-002 ★ Portal 与 fixed 成对：定位必须由 computeAnchoredMenu 产出', () => {
  const s = src()
  assert.match(s, /computeAnchoredMenu\(/, '定位必须走纯函数（可被 TC-AMEN 真值表覆盖）')
  assert.match(s, /style=\{moreMenuStyle\}/, '定位片段必须真的铺到弹层上')
  // fixed 只能有一个来源：纯函数。组件里硬编码 position 会让两处漂移
  assert.ok(!/position:\s*'fixed'/.test(s), '组件不得自行硬编码 position（真源在 anchored-menu.ts）')
  assert.match(CODE(ANCHORED), /position:\s*'fixed'/, '纯函数必须产出 position: fixed')
})

test('TC-MENU-003 弹层受开关控制：仅在 overflowOpen 为真时进入 Portal', () => {
  const s = src()
  const idxGuard = s.indexOf('{overflowOpen &&')
  const idxPortal = s.indexOf('createPortal(')
  assert.ok(idxGuard >= 0, '必须存在 overflowOpen 守卫')
  assert.ok(idxPortal > idxGuard, 'Portal 必须在 overflowOpen 守卫之内（不得常驻挂载）')
  assert.match(s, /moreMenuStyle &&/, '位置未算出前不渲染，避免 (0,0) 闪帧')
})

test('TC-MENU-004 testid 与职责一致：名字里不得再出现 plugin（它现在也收内置项）', () => {
  const s = src()
  assert.match(s, /data-testid="inspector-more-tabs"/, '触发器 testid 应为 inspector-more-tabs')
  assert.match(s, /data-testid="inspector-more-tabs-menu"/, '弹层 testid 应为 inspector-more-tabs-menu')
  assert.ok(!/inspector-more-plugin-tabs/.test(s), '旧 testid 应已改名')
  assert.ok(!/inspector-plugin-tabs-menu/.test(s), '旧 testid 应已改名')
})

/* ---------- D60：关闭与键盘 ---------- */

test('TC-MENU-005 ★ 外部关闭必须排除触发器自身（否则「点触发器不切换」复发）', () => {
  const s = src()
  assert.match(s, /moreBtnRef\.current\?\.contains\(target\)/, '必须排除触发器')
  // 时序说明：不排除时 mousedown 先关、同一手势的 click 再开 ⇒ 表现为「点了没反应」
  assert.match(s, /window\.addEventListener\('mousedown',\s*onPointerDown\)/, '关闭监听应挂在 mousedown 上')
})

test('TC-MENU-006 ★ 外部关闭必须排除弹层自身（点菜单内部不得收起）', () => {
  const s = src()
  assert.match(s, /moreMenuRef\.current\?\.contains\(target\)/, '必须排除弹层')
  assert.match(s, /ref=\{moreMenuRef\}/, '弹层需挂 ref 才能被排除')
})

test('TC-MENU-007 ★ keydown 是白名单：不得再出现「任意键都关」的旧形态', () => {
  const s = src()
  assert.match(s, /window\.addEventListener\('keydown',\s*onKeyDown\)/, '必须用命名处理器')
  // v0.34.2 的缺陷形态：一个无差别 close 同时挂到 mousedown 与 keydown
  assert.ok(
    !/const close = \(\) => setOverflowOpen\(false\)/.test(s),
    '不得再用无差别 close（它会把键盘导航自己打断）',
  )
  assert.match(s, /if \(!isNav\) return/, '非白名单按键必须直接返回、不干预')
})

test('TC-MENU-008 Esc 关闭并归还焦点', () => {
  const s = src()
  assert.match(s, /e\.key === 'Escape'/, '必须处理 Escape')
  assert.match(s, /closeMoreMenu\(true\)/, 'Esc 分支必须带 refocus 标记')
  assert.match(s, /moreBtnRef\.current\?\.focus\(\)/, '关闭后必须把焦点还给触发器')
})

test('TC-MENU-009 ↑↓ / Home / End 移动焦点，且导航期间不关闭', () => {
  const s = src()
  for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
    assert.ok(s.includes(`'${key}'`), `必须处理 ${key}`)
  }
  assert.match(s, /'\[role="menuitem"\]'/, '导航目标必须是 menuitem 集合')
  assert.match(s, /items\[next\]\?\.focus\(/, '必须真的把焦点移过去')
  // 导航分支里只允许 preventDefault + focus，不得出现关闭
  const navBlock = s.slice(s.indexOf('const isNav'), s.indexOf('const onViewportChange'))
  assert.ok(!/setOverflowOpen\(false\)/.test(navBlock), '导航期间不得关闭菜单')
  assert.match(navBlock, /e\.preventDefault\(\)/, '导航需拦截默认滚动行为')
})

test('TC-MENU-010 Tab 关闭（焦点即将离开菜单）', () => {
  const s = src()
  assert.match(s, /e\.key === 'Tab'/, '必须处理 Tab')
})

/* ---------- 激活态与 aria ---------- */

test('TC-MENU-011 ★ 激活项必须有可见样式，且所用 token 已两步注册', () => {
  const s = src()
  assert.match(s, /data-active=\{active\}/, '激活项需带 data-active（可测性）')
  // 光有属性没有样式 = 用户看不出当前面板是哪一个（v0.34.2 的实际形态）
  assert.match(s, /active\s*\?\s*'bg-bg-overlay-l2 text-text-primary'/, '激活态必须有背景与文字色')
  assert.match(s, /active\s*\?\s*'bg-accent'/, '激活态必须有 accent 指示条（与竖排栏指示条同语言）')
  assert.match(s, /bg-transparent/, '非激活时指示条应透明占位，避免行内抖动')

  // 设计系统纪律：新增 token 两步缺一即静默失效 —— 这里把两步都钉死
  const tw = R(TAILWIND)
  assert.match(tw, /'bg-overlay-l2'\s*:\s*'var\(--bg-overlay-l2\)'/, 'bg-overlay-l2 必须注册到 tailwind')
  assert.match(tw, /\baccent\s*:\s*'var\(--accent\)'/, 'accent 必须注册到 tailwind')
  const css = R(CSS)
  assert.match(css, /--bg-overlay-l2\s*:/, 'globals.css 必须定义 --bg-overlay-l2')
  assert.match(css, /--accent\s*:/, 'globals.css 必须定义 --accent')
})

test('TC-MENU-012 aria 关联完整：id 单一真源，触发器与弹层互指', () => {
  const s = src()
  assert.match(s, /const MORE_MENU_ID = 'inspector-more-tabs-menu'/, 'id 必须是单一常量')
  assert.match(s, /aria-haspopup="menu"/, '触发器需声明弹出 menu')
  assert.match(s, /aria-expanded=\{overflowOpen\}/, '触发器需暴露展开态')
  assert.match(
    s,
    /aria-controls=\{overflowOpen \? MORE_MENU_ID : undefined\}/,
    'aria-controls 必须与 id 同源，且仅在展开时挂（避免悬空引用）',
  )
  assert.match(s, /id=\{MORE_MENU_ID\}/, '弹层 id 必须与 aria-controls 同源')
  assert.match(s, /role="menu"/, '弹层需 role=menu')
  assert.match(s, /role="menuitem"/, '项需 role=menuitem')
  assert.match(s, /overflow-y-auto/, '限高后必须可内部滚动（否则溢出屏幕）')
})
