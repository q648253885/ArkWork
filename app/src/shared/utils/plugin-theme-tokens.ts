/* ============================================================
 * ArkWork — 插件视图主题令牌**契约清单**（v0.36.0 · D96 下沉）
 * 设计文档：docs/versions/v0.35.0/04-system-design.md §11「缺陷回溯登记」
 *
 * ★ 为什么放在 shared 而不是 renderer：
 *   这份清单是**契约**——宿主（渲染层注入）与插件（CSS 里 `var(--x)`）两端
 *   都要对着它校验。原先它住在 `renderer/utils/plugin-theme.ts`，
 *   main 层的守门用例（TC-SMPL-029：随包插件 CSS 只许用承诺过的 token）
 *   只能动态 import 渲染层文件 —— 该文件依赖 DOM（`window`/`document`），
 *   一进 `tsconfig.node.json`（lib=ES2022，无 DOM）就是 4 个 TS2304/TS2584。
 *   契约属于两端共有，**下沉到 shared 是唯一正解**（纪律 8：白名单只许一个事实源）。
 *
 * ★ 为什么用**白名单**而不是把 :root 全量倒出去：
 *   ① 全量里混着宿主内部实现细节，插件一旦依赖，宿主改 token 就等于破坏第三方插件；
 *   ② 白名单是**契约**：列进去的才承诺向后兼容（**只增不改名**），没列的不承诺。
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

/** 单个令牌名（`--bg-base` 这类） */
export type PluginThemeToken = (typeof PLUGIN_THEME_TOKENS)[number]

/** 守卫：只有承诺过的令牌才算「插件可用」（全仓只许调这个，不再手写 includes） */
export function isPluginThemeToken(name: string): name is PluginThemeToken {
  return (PLUGIN_THEME_TOKENS as readonly string[]).includes(name)
}
