/* ============================================================
 * v0.31.0 D21 — 设计系统 token 完整性契约（TC-TOKEN-001..003）
 *
 * 为什么需要这组用例（用户实测反馈：「交互区五彩斑斓、喧宾夺主、
 * 弱化命令执行卡片、主内容/思考/工具调用没有层次感」）：
 *   根因**不是**配色方案走偏，而是**一整类样式从未生效**：
 *     ① `--text-faint` 从未在 globals.css 定义，也未注册进 tailwind
 *        → `text-text-faint` 是空转 class，元信息继承主色 → 层次倒置；
 *     ② `--fill-secondary` / `--fill-tertiary` 同样缺失
 *        → `bg-fill-secondary` 空转，命令行面板/搜索结果/用户气泡**没有底色**
 *        → 命令执行卡片彻底塌平（这正是「弱化」的物理来源）；
 *     ③ `bg-danger/5`、`border-warning/40`、`bg-success/10` 这类**透明度
 *        修饰符**对纯 `var()` 颜色无效 —— Tailwind 无法对 `var()` 施加 alpha，
 *        utility 直接不生成。既没染成色，又掩盖了「卡片无底色」。
 *   三者共同点：typecheck 全绿、测试全绿、运行时零报错，**只有肉眼能发现**。
 *
 * 因此这里锁的是**结构性不变量**，不是像素：
 *   TC-TOKEN-001 tailwind 引用的每个 CSS 变量都必须在样式表里定义；
 *   TC-TOKEN-002 源码用到的语义颜色 class 必须已注册（不许再出现空转类）；
 *   TC-TOKEN-003 禁止对纯 var() 颜色加透明度修饰符（改为语义 token 或 inline）。
 *
 * 维护约定：新增设计 token 时，**两步都要做** —— globals.css 定义 +
 * tailwind.config.js 注册；缺任一步本套件立即失败。
 *
 * 运行（cwd=app）：
 *   node scripts/run-tests.mjs design-tokens
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const APP_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

const CSS = readFileSync(join(SRC_ROOT, 'styles/globals.css'), 'utf-8')
const TW = readFileSync(join(APP_ROOT, 'tailwind.config.js'), 'utf-8')

/** tailwind.config.js 里注册的颜色键 → CSS 变量名（只取 `var(--x)` 形式） */
function tailwindColorKeys(): Map<string, string> {
  const out = new Map<string, string>()
  // 形如：  'text-faint': 'var(--text-faint)',  或  accent: 'var(--accent)',
  for (const m of TW.matchAll(/^\s*'?([A-Za-z0-9_-]+)'?\s*:\s*'var\((--[A-Za-z0-9-]+)\)'/gm)) {
    out.set(m[1], m[2])
  }
  assert.ok(out.size > 20, `tailwind 颜色键解析过少（${out.size}），正则可能已失效`)
  return out
}

/** globals.css 中已定义的 CSS 变量名集合（:root 与 .dark 合并） */
function definedCssVars(): Set<string> {
  return new Set([...CSS.matchAll(/^\s*(--[A-Za-z0-9-]+)\s*:/gm)].map((m) => m[1]))
}

/** 语义颜色族前缀：只有命中这些族才做「必须已注册」判定（避开 text-left / border-b 等非颜色 utility） */
const COLOR_FAMILIES = [
  'text-',
  'fill-',
  'bg-',
  'border-',
  'surface',
  'business',
  'accent',
  'success',
  'warning',
  'danger',
  'info',
  'shell',
  'overlay',
  'input',
]

/** 收集渲染层源码中出现过的 className token */
function rendererClassTokens(): Set<string> {
  const tokens = new Set<string>()
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '__tests__') continue
        walk(p)
      } else if (/\.tsx?$/.test(e.name)) {
        const src = readFileSync(p, 'utf-8')
        for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
          const raw = m[1] ?? m[2] ?? ''
          for (const tk of raw.split(/[\s{}$?:()'"+]+/)) {
            if (tk) tokens.add(tk)
          }
        }
      }
    }
  }
  walk(join(SRC_ROOT))
  // 扫描器自检：token 过少说明正则已失效，用例会「空集合恒过」——必须当场失败
  assert.ok(tokens.size > 200, `className token 解析过少（${tokens.size}），扫描器可能已失效`)
  return tokens
}

/* ============================================================
 * TC-TOKEN-001 · tailwind 引用的 CSS 变量必须已定义
 * ============================================================ */
test('TC-TOKEN-001 tailwind.config.js 引用的每个 CSS 变量都在 globals.css 中定义', () => {
  const defined = definedCssVars()
  const missing: string[] = []
  for (const [key, cssVar] of tailwindColorKeys()) {
    if (!defined.has(cssVar)) missing.push(`${key} → ${cssVar}`)
  }
  assert.deepEqual(
    missing,
    [],
    `以下 tailwind 颜色键引用了未定义的 CSS 变量（class 会静默空转）：\n${missing.join('\n')}`,
  )
})

/* ============================================================
 * TC-TOKEN-002 · 源码使用的语义颜色 class 必须已注册
 * ============================================================ */
test('TC-TOKEN-002 渲染层使用的语义颜色 class 全部已在 tailwind 注册（无空转类）', () => {
  const keys = tailwindColorKeys()
  const offenders: string[] = []
  for (const tk of rendererClassTokens()) {
    const m = /^(text|bg|border)-([A-Za-z0-9-]+?)(?:\/\d+)?$/.exec(tk)
    if (!m) continue
    const suffix = m[2]
    if (!COLOR_FAMILIES.some((f) => suffix.startsWith(f))) continue
    if (!keys.has(suffix)) offenders.push(tk)
  }
  assert.deepEqual(
    offenders.sort(),
    [],
    `以下 class 的颜色键未注册，样式不会生成（典型：${
      'text-text-faint / bg-fill-secondary'
    }）：\n${offenders.join('\n')}`,
  )
})

/* ============================================================
 * TC-TOKEN-003 · 禁止对纯 var() 颜色使用透明度修饰符
 * ============================================================ */
test('TC-TOKEN-003 不对纯 var() 颜色使用 /opacity 修饰符（该写法不生成 class）', () => {
  const keys = tailwindColorKeys()
  const offenders: string[] = []
  for (const tk of rendererClassTokens()) {
    const m = /^(text|bg|border)-([A-Za-z0-9-]+?)\/(\d+)$/.exec(tk)
    if (!m) continue
    if (keys.has(m[2])) offenders.push(tk)
  }
  assert.deepEqual(
    offenders.sort(),
    [],
    `以下 class 对 var() 颜色加了透明度修饰符，Tailwind 无法生成（改用语义 token 或 inline style）：\n${offenders.join(
      '\n',
    )}`,
  )
})
