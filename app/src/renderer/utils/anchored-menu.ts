/* ============================================================
 * ArkWork — 锚定弹层的定位计算（v0.34.3 · D59）
 *
 * 规格来源：docs/versions/v0.34.3/04-system-design.md §D59（规则 R1–R6）
 *
 * 为什么需要它（用户实测缺陷：「更多」点不开）：
 *   「更多」弹层原先用 `absolute right-full` 渲染在 `.inspector-toolbar` **内部**，
 *   而该容器是 `overflow-x: hidden`（`globals.css:1960`）且仅 44px 宽。
 *   `right-full`（`right: 100%`）让弹层向**容器左侧之外**生长 ——
 *   弹层 `min-w: 160px`，100% 落在裁切区外 ⇒ **一个像素都看不见**。
 *   逻辑函数全对、DOM 里也确实挂载了，唯独屏幕上没有。
 *
 *   修法分两半，**缺一不可**（用例把这条耦合钉死）：
 *     ① **逃逸**：弹层用 `createPortal` 渲染到 `document.body`，不再是栏盒的后代；
 *     ② **定位**：用 `position: fixed` 按触发器矩形现算坐标 ——
 *        `fixed` 的包含块是视口，与任何祖先的 `overflow` 无关。
 *
 *   本模块只负责②：把「触发器矩形 + 视口尺寸」换算成可直接铺给 `style` 的片段。
 *   纯函数、零 DOM 依赖 ⇒ 可在 node:test 里密闭断言（TC-AMEN 组）。
 *
 * 定位规则（逐条对应用例）：
 *   R1 右对齐：弹层右缘贴触发器**左缘**再让开 `gap`，并夹取在视口内；
 *   R2 翻转：触发器底边落在视口 `flipRatio` 之下 ⇒ **向上**展开（本处恒成立：
 *          竖排栏在窗口最右、触发器在栏底，向下必溢出屏幕）；
 *   R3 向上展开：`bottom = 视口高 − 触发器底边`（弹层底边与触发器底边对齐）；
 *   R4 向下展开：`top = 触发器顶边`（弹层顶边与触发器顶边对齐）；
 *   R5 限高：`maxHeight = max(minHeight, 该方向可用空间)` —— 空间不足时由弹层
 *          自身 `overflow-y: auto` 滚动，而不是溢出屏幕或塌成 0；
 *   R6 取整：所有输出 `Math.round`，避免半像素造成的 1px 抖动。
 * ============================================================ */

/** 触发器在视口中的矩形（`getBoundingClientRect()` 的投影子集） */
export interface MenuAnchorRect {
  top: number
  bottom: number
  left: number
  right: number
}

/** 视口尺寸（`window.innerWidth` / `window.innerHeight`） */
export interface ViewportSize {
  width: number
  height: number
}

export interface AnchoredMenuOptions {
  /** 弹层与触发器之间的间距（px）。缺省 4 */
  gap?: number
  /** 视口边缘留白（px）。缺省 8 */
  margin?: number
  /** `maxHeight` 下限（px）。缺省 120 —— 视口极矮时仍给出可用窗口，由弹层内部滚动消化 */
  minHeight?: number
  /** 翻转判据：触发器底边落在此比例之下 ⇒ 向上展开。缺省 0.6 */
  flipRatio?: number
}

/** 可直接铺开的定位片段（`position` 恒为 `fixed`） */
export interface AnchoredMenuStyle {
  position: 'fixed'
  top?: number
  bottom?: number
  right: number
  maxHeight: number
}

export interface AnchoredMenuPlacement {
  /** `'down'` = 向下展开（锚 `top`）；`'up'` = 向上展开（锚 `bottom`） */
  side: 'down' | 'up'
  style: AnchoredMenuStyle
}

export const MENU_DEFAULT_GAP = 4
export const MENU_DEFAULT_MARGIN = 8
export const MENU_DEFAULT_MIN_HEIGHT = 120
export const MENU_DEFAULT_FLIP_RATIO = 0.6

/** 有限数值兜底：非有限（undefined / NaN / ±Infinity）时取 fallback */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * 职责一句话：把「触发器矩形 + 视口尺寸」换算成弹层的 `fixed` 定位片段。
 *
 * 输入：`rect`（触发器 `getBoundingClientRect()`）、`viewport`（`window.innerWidth/Height`）、
 *      可选 `options`（间距 / 留白 / 限高下限 / 翻转比例）
 * 输出：`side`（展开方向）+ `style`（含 `position: 'fixed'`，可直接铺给 JSX）
 * 错误场景：**无**。全定义函数，非法输入一律按 0 / 缺省值兜底，绝不抛错、绝不返回 undefined
 *          （理由：它跑在渲染路径上，抛错等于整栏白屏；宁可位置略偏也不能崩）。
 */
export function computeAnchoredMenu(
  rect: MenuAnchorRect,
  viewport: ViewportSize,
  options: AnchoredMenuOptions = {},
): AnchoredMenuPlacement {
  const gap = Math.max(0, finite(options.gap, MENU_DEFAULT_GAP))
  const margin = Math.max(0, finite(options.margin, MENU_DEFAULT_MARGIN))
  const minHeight = Math.max(0, finite(options.minHeight, MENU_DEFAULT_MIN_HEIGHT))
  const rawRatio = finite(options.flipRatio, MENU_DEFAULT_FLIP_RATIO)
  const flipRatio = clamp(rawRatio, 0, 1)

  const vw = Math.max(0, finite(viewport?.width, 0))
  const vh = Math.max(0, finite(viewport?.height, 0))
  const top = finite(rect?.top, 0)
  const bottom = finite(rect?.bottom, top)
  const left = finite(rect?.left, 0)

  // R1 右对齐触发器左缘 + 夹取在视口内（夹取保证弹层不会整块跑到屏幕之外）
  const right = Math.round(clamp(vw - left + gap, margin, Math.max(margin, vw - margin)))

  // R2 触发器在下半屏 → 向上展开
  const side: 'down' | 'up' = bottom > vh * flipRatio ? 'up' : 'down'

  // R5 该方向的可用空间（扣掉视口留白）
  const space = side === 'up' ? bottom - margin : vh - top - margin
  const maxHeight = Math.round(Math.max(minHeight, space))

  // R3 / R4 / R6
  const style: AnchoredMenuStyle =
    side === 'up'
      ? { position: 'fixed', bottom: Math.round(vh - bottom), right, maxHeight }
      : { position: 'fixed', top: Math.round(top), right, maxHeight }

  return { side, style }
}
