/* ============================================================
 * ArkWork — 插件视图的主题令牌导出（v0.35.0 · M13 配套）
 * 设计文档：docs/versions/v0.35.0/04-system-design.md §11「缺陷回溯登记」
 *   —— 「iframe 与宿主主题不同步」的处置：
 *      桥提供 `ui.theme.get` + theme 变更事件；
 *      宿主 token 以 CSS 变量注入 iframe 的 `:root`。
 *
 * ★ 为什么不能直接写 `iframe.contentDocument.documentElement.style`：
 *   沙箱是 `<iframe sandbox="allow-scripts">`，**没有 `allow-same-origin`**
 *   —— 宿主的 JS 拿不到 contentDocument（这正是我们要的安全属性）。
 *   所以主题只能**经报文送给插件**，由插件自己的 renderer.js 贴到 `:root`。
 *   脚手架生成的 `renderer.js` 就是这么做的，作者无需操心。
 *
 * ★ 为什么用**白名单**而不是把 :root 全量倒出去：
 *   ① 全量里混着宿主内部实现细节（v0.30 的编辑器 selection、DSH 兼容别名…），
 *      一旦插件依赖上，宿主改 token 就等于破坏第三方插件；
 *   ② 白名单是**契约**：列进去的才承诺向后兼容，没列的不承诺。
 * ============================================================ */

/**
 * 承诺给插件的令牌（**契约，只增不改名**）。
 *
 * 分组与 `globals.css` 的语义分层一致：背景 / 边框 / 文字 / 强调 / 状态。
 * 插件只应使用这些；想用别的颜色请自带（插件不该依赖未承诺的宿主内部实现）。
 */
export const PLUGIN_THEME_TOKENS = [
  // 背景阶梯
  '--bg-base',
  '--bg-surface',
  '--bg-surface-2',
  '--bg-surface-3',
  '--bg-overlay',
  '--bg-input',
  // 边框
  '--border-subtle',
  '--border-default',
  '--border-strong',
  // 文字（四级 + 反色）
  '--text-primary',
  '--text-secondary',
  '--text-tertiary',
  '--text-faint',
  '--text-inverse',
  // 强调（AI 与选中）
  '--accent',
  '--accent-soft',
  // 业务主色（主按钮与焦点环）
  '--business-primary',
  '--business-primary-soft',
  // 状态（「颜色只留给异常」）
  '--success',
  '--warning',
  '--danger',
  // 圆角与字号（插件对齐宿主密度用）
  '--radius-sm',
  '--radius-md',
  '--radius-lg',
] as const

/** 主题令牌快照：`{ '--bg-base': '#FFFFFF', … }` */
export type PluginThemeTokens = Record<string, string>

/**
 * 从「全部自定义属性」里挑出承诺集（纯函数，可单测）。
 *
 * 缺失的键**不出现在结果里**（不做 `undefined → ''` 的假值填充）：
 * 插件侧用 `tokens['--x'] ?? 自带默认值` 判断即可，副作用是零，而不是「把颜色设成空串」。
 */
export function pickPluginThemeTokens(source: Record<string, string | undefined | null>): PluginThemeTokens {
  const out: PluginThemeTokens = {}
  for (const name of PLUGIN_THEME_TOKENS) {
    const v = source[name]
    if (typeof v === 'string' && v.trim().length > 0) out[name] = v.trim()
  }
  return out
}

/**
 * 把令牌快照编译成一段可注入的 CSS（`--x: v;`）。
 *
 * **只做编译、不做过滤** —— 过滤已经在 `pickPluginThemeTokens` 完成了。
 * 值里的 `;` / `}` 是 CSS 注入面：这里显式剔除含这两种字符的值
 * （合法 CSS 值不会包含未转义的它们；扔掉一条坏值好过整段样式被吃穿）。
 */
export function themeTokensToCss(tokens: PluginThemeTokens, selector = ':root'): string {
  const decls: string[] = []
  for (const [k, v] of Object.entries(tokens)) {
    if (!k.startsWith('--')) continue
    if (!/^[-\w]+$/.test(k)) continue
    if (v.includes(';') || v.includes('}') || v.includes('{')) continue
    decls.push(`${k}:${v}`)
  }
  return decls.length === 0 ? '' : `${selector}{${decls.join(';')}}`
}

/**
 * 从当前文档读出令牌（**只在渲染层可用**，依赖 DOM）。
 *
 * 优先动态枚举 `documentElement` 的计算样式自定义属性 —— 这样插件看到的
 * 是**当下真实生效的值**（含 `.dark` 覆盖与用户自定义），而不是照抄 CSS 源。
 * 枚举不可用时（极老内核 / 测试环境）回落空集：宁可少给，不给错值
 * （少给时插件用自带默认色，界面仍可用；给错值会让插件显示成错误的颜色，
 *  反而像「插件坏了」）。
 */
export function collectPluginThemeTokens(): PluginThemeTokens {
  if (typeof window === 'undefined' || typeof document === 'undefined') return {}
  try {
    const cs = window.getComputedStyle(document.documentElement)
    const bag: Record<string, string> = {}
    for (let i = 0; i < cs.length; i++) {
      const prop = cs[i]
      if (typeof prop === 'string' && prop.startsWith('--')) {
        const v = cs.getPropertyValue(prop)
        if (v) bag[prop] = v
      }
    }
    // 枚举拿不到自定义属性时，逐条 getPropertyValue 兜底
    if (Object.keys(bag).length === 0) {
      for (const name of PLUGIN_THEME_TOKENS) {
        const v = cs.getPropertyValue(name)
        if (v) bag[name] = v
      }
    }
    return pickPluginThemeTokens(bag)
  } catch {
    return {}
  }
}
