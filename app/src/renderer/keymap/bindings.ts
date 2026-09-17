/* ============================================================
 * ArkWork — 默认键位注册（v0.31.0 B0）
 *
 * 把 `spec.ts` 的声明与 `actions.ts` 的处理函数 zip 起来注册。
 * 应用启动期调用一次（`App.tsx` 的 useEffect），返回注销函数。
 *
 * 完整性由**两处**共同保证：
 *   1. 编译期：`actions.ts` 的返回类型是 `Record<KeymapId, KeyHandler>`
 *      —— 少一个声明就 typecheck 失败；
 *   2. 运行期：下面的运行时兜底（防御 `as unknown as` 之类的绕过）。
 * 两者都留着是有意的：类型是纪律，运行时断言是底线。
 * ============================================================ */
import { createHandlers, type KeymapHost } from './actions'
import { chordsOf, registerKeybinding } from './registry'
import { KEYMAP_SPEC } from './spec'

export type { KeymapHost }

/**
 * 注册全部默认键位。返回注销函数（全部解除）。
 *
 * 重复调用会因 id 重复而抛错 —— 这是刻意的：应用只应注册一次，
 * 若未来出现"注册两次"（如热更新重复执行），宁可当场炸也不要静默叠加出双触发。
 */
export function registerDefaultKeybindings(host: KeymapHost): () => void {
  const handlers = createHandlers(host)
  const unregister = KEYMAP_SPEC.map((spec) => {
    const handler = handlers[spec.id]
    if (typeof handler !== 'function') {
      throw new Error(`[keymap] 声明缺少处理函数：${spec.id}`)
    }
    // 走 registry 的 chordsOf 做别名展平：`as const` 声明里 chord 是字符串字面量，
    // 就地写三元会让 else 分支退化成 never（TS 收窄过窄），复用纯函数既避坑又只有一处实现。
    return registerKeybinding({ ...spec, chord: chordsOf(spec), handler, origin: 'default' })
  })
  return () => {
    for (const un of unregister) un()
  }
}
