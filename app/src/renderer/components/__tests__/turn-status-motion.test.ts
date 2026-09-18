/* ============================================================
 * ArkWork — 「运行中」呼吸动效契约（v0.34.0 · P2 · D53 · TC-TSTAT-001..012）
 * 规格来源：docs/versions/v0.34.0/04-system-design.md §3
 *
 * 用户实测诉求原文：
 *   「蓝色的运行中，呼吸效果不太好，不要让字体本来就渐变，让他本来是纯色的，
 *     然后再一起呼吸变化，要不看不清蓝色的内容。」
 *
 * 拆开是两件事，本组分别把守：
 *   ① **可读性**（用户直接说的）—— 渐变文字靠 `background-clip: text` 实现，
 *      文字颜色由背景决定；在呼吸过程中基色被拉走 → 蓝色内容看不清。
 *      修法：文字**纯色**，把动效移到 `opacity`（整体一起呼吸）。
 *   ② **性能**（上一版 D50 的教训，不能修 ① 时把它改回来）——
 *      `background-position` 会触发 **paint**；`opacity` 走合成器线程。
 *      两个缺陷方向相反，因此必须**同时**把守：既不许回到渐变，
 *      也不许用 background-position 做呼吸。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs turn-status-motion
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CSS = readFileSync(fileURLToPath(new URL('../../styles/globals.css', import.meta.url)), 'utf-8')

/** 取所有 `.turn-status { … }` 规则体（含 perf-lite / media 变体） */
function turnStatusBodies(): { body: string; index: number }[] {
  const out: { body: string; index: number }[] = []
  for (const m of CSS.matchAll(/\.turn-status\s*\{([^}]*)\}/g)) {
    out.push({ body: m[1]!, index: m.index! })
  }
  assert.ok(out.length >= 2, `应至少解析出 2 段 .turn-status 规则，实际 ${out.length}`)
  return out
}

/** 主规则（暗/亮共用的那条：含 color 且不含 !important 的动画） */
function mainRule(): string {
  const hit = turnStatusBodies().find((r) => /color\s*:/.test(r.body) && !/!important/.test(r.body))
  assert.ok(hit, '未找到 .turn-status 主规则（含 color 且无 !important）—— 选择器可能已改名')
  return hit!.body
}

/** perf-lite 变体 */
function perfLiteRule(): string {
  const hit = turnStatusBodies().find((r) => /!important/.test(r.body))
  assert.ok(hit, "未找到 .turn-status 的 perf-lite 变体（应含 !important）")
  return hit!.body
}

/* ============================================================
 * 1. 可读性：文字必须纯色（不许再渐变）
 * ============================================================ */

test('TC-TSTAT-001 ★ 主规则不得使用 background-clip:text（渐变文字的可读性根因）', () => {
  const body = mainRule()
  assert.doesNotMatch(body, /background-clip/, '禁止 background-clip（含 -webkit- 前缀）—— 曾致「蓝色内容看不清」')
  assert.doesNotMatch(body, /-webkit-background-clip/, '禁止 -webkit-background-clip')
})

test('TC-TSTAT-002 ★ 主规则不得设置背景图/渐变（纯色文字的前提）', () => {
  const body = mainRule()
  assert.doesNotMatch(body, /background-image/, '不得设背景图')
  assert.doesNotMatch(body, /linear-gradient|radial-gradient|conic-gradient/, '不得设渐变')
})

test('TC-TSTAT-003 文字色是语义 token 的纯色（不是硬编码、不是 currentColor 兜底）', () => {
  const body = mainRule()
  assert.match(body, /color\s*:\s*var\(--business-primary\)/, '必须用 --business-primary（「运行中」= 主按钮/焦点环同一支色）')
  assert.doesNotMatch(body, /color\s*:\s*#[0-9a-fA-F]{3,8}/, '不得硬编码色值 —— 亮/暗两主题会失真')
  assert.doesNotMatch(body, /-webkit-text-fill-color/, '不得用 text-fill-color 绕开 color（那正是渐变文字的老写法）')
})

test('TC-TSTAT-004 盒子随换行撑高（历史修复点不得被回退）', () => {
  const body = mainRule()
  assert.match(body, /min-height\s*:\s*26px/, '必须 min-height（固定 height 会裁掉第二行字形）')
  assert.doesNotMatch(body, /^\s*height\s*:\s*26px/m, '不得回退为固定 height')
})

/* ============================================================
 * 2. 动效：整体透明度呼吸（走合成器）
 * ============================================================ */

test('TC-TSTAT-005 ★ 呼吸走 opacity（合成器线程），不得用 background-position（paint）', () => {
  const body = mainRule()
  assert.match(body, /animation\s*:/, '主规则必须挂动画')
  assert.doesNotMatch(body, /background-position/, 'background-position 触发 paint —— D50 已修过，不得回退')
  assert.doesNotMatch(body, /filter\s*:/, 'filter 亦走 paint 路径，避免')
})

test('TC-TSTAT-006 关键帧只动 opacity 一个属性（动得越少越稳）', () => {
  const kf = CSS.match(/@keyframes\s+dsh-turn-status-breath\s*\{([\s\S]*?)\n\}/)
  assert.ok(kf, '必须存在 dsh-turn-status-breath 关键帧')
  const body = kf![1]!
  const props = [...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]!)
  const animateProps = props.filter((p) => !['from', 'to'].includes(p))
  assert.deepEqual(
    [...new Set(animateProps)],
    ['opacity'],
    `关键帧只应动 opacity，实际动了 [${[...new Set(animateProps)].join(', ')}]`,
  )
  assert.match(body, /0%,\s*100%\s*\{\s*opacity:\s*0?\.\d+/, '起止同值（呼吸回到原点，不跳变）')
  assert.match(body, /50%\s*\{\s*opacity:\s*1/, '中点最亮（呼吸的「吸」）')
})

test('TC-TSTAT-007 呼吸幅度落在可读区间：谷值不得低于 0.5', () => {
  const kf = CSS.match(/@keyframes\s+dsh-turn-status-breath\s*\{([\s\S]*?)\n\}/)!
  const low = kf[1]!.match(/0%,\s*100%\s*\{\s*opacity:\s*([\d.]+)/)
  assert.ok(low, '应能解析出谷值')
  const v = Number(low![1])
  assert.ok(v >= 0.5, `谷值 ${v} 低于 0.5 —— 用户诉求是「能看清」，过淡等于把内容藏起来`)
  assert.ok(v < 1, `谷值 ${v} 必须 < 1，否则没有呼吸`)
})

test('TC-TSTAT-008 周期落在呼吸区间：1.2s ～ 3s（太快像闪烁、太慢像卡住）', () => {
  const body = mainRule()
  const m = body.match(/animation\s*:[^;]*?([\d.]+)s\s+(ease-in-out|ease|linear)/)
  assert.ok(m, '动画应显式给出时长与缓动')
  const dur = Number(m![1])
  assert.ok(dur >= 1.2 && dur <= 3, `周期 ${dur}s 超出 1.2–3s 的呼吸区间`)
  assert.equal(m![2], 'ease-in-out', '呼吸必须对称缓动（linear 会显得机械）')
})

/* ============================================================
 * 3. 两处关闸：降级与无障碍（关了之后必须是「满不透明」而不是「不动但半透明」）
 * ============================================================ */

test('TC-TSTAT-009 ★ perf-lite 关闸必须同时归零动画与透明度', () => {
  const body = perfLiteRule()
  assert.match(body, /animation\s*:\s*none\s*!important/, '性能模式必须停动画')
  assert.match(body, /opacity\s*:\s*1\s*!important/, '停动画后必须把透明度拉满 —— 否则文字永久停在半淡状态（比有动画更糟）')
})

test('TC-TSTAT-010 ★ prefers-reduced-motion 关闸同样要拉满透明度', () => {
  const block = CSS.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.turn-status\s*\{([^}]*)\}/)
  assert.ok(block, '必须有 prefers-reduced-motion 分支')
  assert.match(block![1]!, /animation\s*:\s*none/, '应停动画')
  assert.match(block![1]!, /opacity\s*:\s*1/, '必须把透明度拉满（无障碍用户看到的是完整文字）')
})

test('TC-TSTAT-011 两处关闸各自独立（perf-lite 不得依赖 reduced-motion，反之亦然）', () => {
  // 两个关闸的实现位置不同：perf-lite 是 html 类 + !important 全局；
  // reduced-motion 是媒体查询内。若有人把其中一个删掉、指望另一个兜底，
  // 就会出现「开了性能模式仍在呼吸」或「系统偏好减少动效却还在呼吸」。
  assert.match(CSS, /html\.perf-lite\s+\.turn-status\s*\{/, 'perf-lite 关闸必须挂在 html.perf-lite 下')
  const mediaIdx = CSS.indexOf('@media (prefers-reduced-motion: reduce)')
  const tsIdx = CSS.indexOf('.turn-status', CSS.indexOf('@keyframes dsh-turn-status-breath'))
  assert.ok(mediaIdx !== -1 && tsIdx !== -1)
  assert.ok(tsIdx < mediaIdx + 200 || mediaIdx < tsIdx, '两处关闸都必须存在（顺序不敏感，存在性敏感）')
})

test('TC-TSTAT-012 旧写法整体清除：全表不得再有「turn-status + background-clip」组合', () => {
  // 逐段扫描：任何 .turn-status 规则体（含任何前缀/变体）都不得含 background-clip
  for (const { body, index } of turnStatusBodies()) {
    assert.doesNotMatch(
      body,
      /background-clip|-webkit-text-fill-color/,
      `位置 ${index} 的 .turn-status 规则仍是渐变文字写法 —— 回归 D53`,
    )
  }
  // 并且 turn-status 附近不得残留 gradient 关键字（防止改名后绕过）
  const near = CSS.slice(Math.max(0, CSS.indexOf('.turn-status {') - 1200), CSS.indexOf('.turn-status {') + 1200)
  assert.doesNotMatch(near, /background-clip/, '主规则上下文内不得有 background-clip')
})
