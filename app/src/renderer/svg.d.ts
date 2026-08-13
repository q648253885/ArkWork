/* ============================================================
 * v0.13.0 — renderer 静态资源（SVG）默认导入声明
 *
 * 注意：必须放在独立的 .d.ts 文件中且**不包含顶层 import/export**，
 * 否则该文件会被 TypeScript 当作 ESM 模块，ambient declare module '*.svg'
 * 将只在该模块作用域内生效，导致其它组件无法解析 SVG 路径。
 * ============================================================ */
declare module '*.svg' {
  const src: string
  export default src
}

declare module '*.png' {
  const src: string
  export default src
}