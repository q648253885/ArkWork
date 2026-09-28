/* ============================================================
 * v0.36.3 · D116 — 动效预算契约（TC-MOTION-001..008）
 *
 * 规格来源：docs/versions/v0.36.0/15-v0363-memory-motion-path-design.md §3
 *
 * 用户诉求原文：「去除所有高级动画，agent 需要在没有 gpu 的地方使用，
 *   所以优化整体交互，动效使用简单好用的能力，如简单的纯色呼吸变动，
 *   且要优化好，不要影响性能，防止卡顿出现。」
 *
 * 因此本组把守的不是「好看」而是**每帧成本**：
 *   · 连续动画只允许 `opacity`（合成器线程，零重排零重绘）；
 *     其余属性（transform / box-shadow / filter / background-position /
 *     width / height）在软件渲染（SwiftShader）下都是逐帧重绘。
 *   · transition 只允许颜色与透明度（hover 一次性触发，成本可忽略）。
 *   · `backdrop-filter`（毛玻璃）在任何环境下都昂贵，全量清零。
 *
 * 载体纪律：CSS 走文本断言；TSX 走 stripComments 后再断言（D101 纪律⑫：
 *   注释里会提反面教材，不剥注释会假阳性）。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs motion-budget
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from '@shared/utils/source-guard'

const RENDERER = fileURLToPath(new URL('../..', import.meta.url)) // src/renderer/
const GLOBALS = join(RENDERER, 'styles/globals.css')
const BROWSER_CHROME = join(RENDERER, 'components/BrowserChrome/BrowserChrome.css')

const rawCss = (p: string): string => readFileSync(p, 'utf-8')
const codeCss = (p: string): string => stripComments(rawCss(p))

/** 收集 renderer 下全部源码（排除 __tests__：守卫不该扫自己的断言文本） */
function sourceFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === '__tests__' || e.name === 'node_modules') continue
        walk(p)
      } else if (/\.(ts|tsx|css)$/.test(e.name)) {
        out.push(p)
      }
    }
  }
  walk(RENDERER)
  out.sort()
  return out
}

const ALL_SRC = sourceFiles()

/** 解析 @keyframes：返回 [{ name, body }] */
function keyframes(css: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = []
  for (const m of css.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
    // 逐字符配平大括号取完整块
    let depth = 0
    let i = m.index! + m[0].length - 1
    const start = i
    for (; i < css.length; i += 1) {
      if (css[i] === '{') depth += 1
      else if (css[i] === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    out.push({ name: m[1]!, body: css.slice(start + 1, i) })
  }
  return out
}

/** 取关键帧体里被动的属性名（去 from/to 与百分比选择器） */
function animatedProps(body: string): string[] {
  const decls = body
    .replace(/^\s*(\d+%|from|to)\s*(,\s*(\d+%|from|to)\s*)*\{/gm, '\u0000{')
    .split('\u0000')
    .slice(1)
  const props: string[] = []
  for (const d of decls) {
    for (const m of d.matchAll(/([a-z-]+)\s*:/g)) props.push(m[1]!)
  }
  return [...new Set(props)]
}

/** 取所有 animation 简写声明（含换行） */
function animationDecls(css: string): string[] {
  return [...css.matchAll(/animation\s*:\s*([^;]+);/g)].map((m) => m[1]!.replace(/\s+/g, ' ').trim())
}

/* ============================================================
 * 1. 关键帧：只能动「不产生重绘」的属性
 * ============================================================ */

const FORBIDDEN_KF_PROPS = [
  'transform',
  'box-shadow',
  'filter',
  'backdrop-filter',
  'background-position',
  'width',
  'height',
  'top',
  'left',
  'inset',
]

test('TC-MOTION-001 ★ 全部 @keyframes 不得动 transform/box-shadow/filter/background-position/width/height', () => {
  for (const file of [GLOBALS, BROWSER_CHROME]) {
    for (const kf of keyframes(codeCss(file))) {
      for (const p of animatedProps(kf.body)) {
        assert.ok(
          !FORBIDDEN_KF_PROPS.includes(p),
          `${file} 的 @keyframes ${kf.name} 动了 ${p} —— 逐帧重绘，无 GPU 环境会卡`,
        )
      }
    }
  }
})

test('TC-MOTION-002 ★ infinite 连续动画的关键帧只允许 opacity（合成器唯一稳的路径）', () => {
  const perFile: [string, string][] = [
    [GLOBALS, codeCss(GLOBALS)],
    [BROWSER_CHROME, codeCss(BROWSER_CHROME)],
  ]
  let checked = 0
  for (const [file, css] of perFile) {
    const kfs = keyframes(css)
    for (const decl of animationDecls(css)) {
      if (!decl.includes('infinite')) continue
      const name = kfs.find((k) => new RegExp(`(^|\\s)${k.name}(\\s|$)`).test(decl))
      assert.ok(name, `${file} 的连续动画「${decl}」找不到对应 @keyframes —— 关键帧可能已改名`)
      const props = animatedProps(name!.body)
      // 也允许 animation 自身为 none 的收口分支（不含 infinite，已在上面过滤）
      assert.deepEqual(
        props.filter((p) => p !== 'opacity'),
        [],
        `${file} 的连续动画 @keyframes ${name!.name} 动了 [${props.join(', ')}] —— 连续动画只许动 opacity`,
      )
      checked += 1
    }
  }
  assert.ok(checked >= 4, `应至少把守 4 处连续动画，实际 ${checked} —— 断言可能已空转`)
})

/* ============================================================
 * 2. 禁用清单：高级动效 API 全量清零
 * ============================================================ */

test('TC-MOTION-003 ★ 渲染层不得再出现「高级动画」写法（旋转 / 毛玻璃 / 扫光 / 已删关键帧）', () => {
  const banned: [RegExp, string][] = [
    [/animate-spin/, 'Tailwind 旋转（连续 transform）'],
    [/backdrop-blur/, '毛玻璃工具类（backdrop-filter）'],
    [/backdrop-filter/, 'backdrop-filter 原生属性'],
    [/@keyframes\s+dsh-row-sweep/, '渐变扫光关键帧'],
    [/@keyframes\s+plan-spin/, '旋转关键帧'],
    [/@keyframes\s+bc-spin/, '浏览器加载旋转关键帧'],
    [/@keyframes\s+bc-indeterminate/, '进度条横扫关键帧'],
    [/@keyframes\s+pulse-border/, 'box-shadow 脉冲关键帧'],
    [/@keyframes\s+thinking-bar/, 'scaleY 形变关键帧'],
    [/@keyframes\s+slide-panel/, '位移滑出关键帧'],
    [/@keyframes\s+scale-in/, '缩放关键帧'],
  ]
  for (const file of ALL_SRC) {
    const src = stripComments(readFileSync(file, 'utf-8'))
    for (const [re, what] of banned) {
      assert.doesNotMatch(src, re, `${file} 仍含${what}（${re.source}）`)
    }
  }
})

test('TC-MOTION-004 TSX 侧只允许 animate-pulse（Tailwind 内置，仅 opacity）', () => {
  for (const file of ALL_SRC) {
    if (!/\.tsx?$/.test(file)) continue
    const src = stripComments(readFileSync(file, 'utf-8'))
    for (const m of src.matchAll(/animate-(?!none)[a-z-[\]]+/g)) {
      assert.equal(m[0], 'animate-pulse', `${file} 用了 ${m[0]} —— 只允许 animate-pulse，连续动效一律走 .breathe`)
    }
    // 手写呼吸类的唯一拼写
    assert.doesNotMatch(src, /animate-breathe/, `${file} 用了不存在的 animate-breathe，正确写法是 .breathe`)
  }
})

/* ============================================================
 * 3. 节奏唯一：呼吸只有一套参数
 * ============================================================ */

test('TC-MOTION-005 ★ 呼吸节奏唯一（1.6s ease-in-out / 谷值 0.55 / 起止满不透明）', () => {
  const checks: [string, string][] = [
    [GLOBALS, 'breathe'],
    [GLOBALS, 'pulse-dot'],
    [BROWSER_CHROME, 'bc-breathe'],
  ]
  for (const [file, name] of checks) {
    const kf = keyframes(codeCss(file)).find((k) => k.name === name)
    assert.ok(kf, `${file} 缺少 @keyframes ${name}`)
    // 起止满不透明：降级模式（duration≈0 + 单次迭代）停在终态，不是停在谷值
    assert.match(kf!.body, /0%,\s*100%\s*\{\s*opacity:\s*1\s*[;}]/, `${name} 起止必须满不透明（否则降级后永久半淡）`)
    assert.match(kf!.body, /50%\s*\{\s*opacity:\s*0?\.\d+/, `${name} 中点必须是谷值`)
    const low = kf!.body.match(/50%\s*\{\s*opacity:\s*([\d.]+)/)
    assert.equal(Number(low![1]), 0.55, `${name} 谷值必须 0.55（统一口径，避免各组件各调一套）`)

    const decl = animationDecls(codeCss(file)).find((d) => new RegExp(`(^|\\s)${name}(\\s|$)`).test(d))
    assert.ok(decl, `${name} 必须有引用处`)
    assert.match(decl!, /1\.6s ease-in-out infinite/, `${name} 引用处必须 1.6s ease-in-out infinite，实际「${decl}」`)
  }
})

/* ============================================================
 * 4. 过渡白名单：只许颜色与透明度
 * ============================================================ */

test('TC-MOTION-006 ★ transition 只允许 opacity/color/background-color/border-color，且字面时长 ≤ 200ms', () => {
  for (const file of [GLOBALS, BROWSER_CHROME]) {
    const css = codeCss(file)
    for (const m of css.matchAll(/transition\s*:\s*([^;]+);/g)) {
      const decl = m[1]!.replace(/\s+/g, ' ').trim()
      if (decl === 'none') continue
      // 取属性名（忽略时长/缓动/tailwind 注释）
      const props = decl
        .split(',')
        .map((part) => part.trim().split(/\s+/)[0]!)
        .filter((p) => p && !/^[\d.]/.test(p))
      for (const p of props) {
        assert.ok(
          ['opacity', 'color', 'background-color', 'border-color'].includes(p),
          `${file} 的 transition 含 ${p} —— 只允许颜色/透明度（实际「${decl}」）`,
        )
      }
      for (const dur of decl.matchAll(/([\d.]+)(ms|s)\b/g)) {
        const ms = dur[2] === 's' ? Number(dur[1]) * 1000 : Number(dur[1])
        assert.ok(ms <= 200, `${file} 的 transition 字面时长 ${ms}ms > 200ms（实际「${decl}」）`)
      }
    }
  }
})

/* ============================================================
 * 5. 语义不许丢：入场提示 / 运行态指示 / 降级双闸门
 * ============================================================ */

test('TC-MOTION-007 降级后仍保留入场与运行态语义（不是「一删了之」）', () => {
  const css = codeCss(GLOBALS)
  // 入场：折叠体（契约 TC-FOLD-017 也把守）与消息流、浮层
  assert.match(css, /animation:\s*flow-fold-in/, '折叠展开仍需入场提示')
  assert.match(css, /\.fade-in-up\s*\{\s*animation:\s*fade-in-up/, '消息流仍需渐入')
  assert.match(css, /\.scale-in\s*\{\s*animation:\s*fade-in-up/, '浮层渐入统一走 fade-in-up（scale 关键帧已删）')
  assert.match(css, /animation:\s*tooltip-in/, 'Tooltip 仍需渐入')
  // 运行态：卡片左侧状态条呼吸（原 shimmer 的替代）
  assert.match(
    css,
    /\.tool-card\[data-state="running"\]::before\s*\{[^}]*animation:\s*breathe/,
    'tool-card 运行态必须由左侧状态条呼吸表达',
  )
  assert.match(
    css,
    /\.react-reason\[data-state="running"\]::before\s*\{[^}]*animation:\s*breathe/,
    'react-reason 运行态必须由左侧状态条呼吸表达',
  )
  assert.match(css, /\.plan-row\[data-state="running"\] \.plan-row__circle\s*\{[^}]*animation:\s*breathe/, '清单运行态圆圈呼吸')
  assert.match(css, /\.turn-status\s*\{[^}]*animation:\s*dsh-turn-status-breath/s, 'turn-status 呼吸不得丢（D53 口径）')
})

test('TC-MOTION-008 ★ 降级双闸门仍在，且续接新的呼吸对象', () => {
  const css = codeCss(GLOBALS)
  // 闸门一：prefers-reduced-motion
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/, 'prefers-reduced-motion 闸门不得丢')
  // 闸门二：perf-lite 全局抑制 + 四处显式收口（含 opacity 拉满，避免停在谷值）
  assert.match(css, /html\.perf-lite \*[^{]*\{[^}]*animation-duration:\s*0\.01ms\s*!important/s)
  for (const sel of ['react-reason', 'tool-card', 'turn-status', 'stream-caret']) {
    assert.match(css, new RegExp(`html\\.perf-lite[^{}]*\\.${sel}`), `perf-lite 必须覆盖 .${sel}`)
  }
  for (const m of css.matchAll(/html\.perf-lite[^{}]*\{([^}]*)\}/g)) {
    if (!/animation:\s*none\s*!important/.test(m[1]!)) continue
    assert.match(m[1]!, /opacity:\s*1\s*!important/, `perf-lite 停动画处必须把 opacity 拉满：${m[0]}`)
  }
})