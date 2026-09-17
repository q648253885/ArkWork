/* ============================================================
 * ArkWork — keymap 公共出口（v0.31.0 B0）
 *
 * 消费方只从这里取东西，避免每个组件各挑一个内部文件造成耦合面发散。
 *
 * **注意**：本入口会连带引入 `actions.ts`（→ store / IPC），因此
 * `__tests__/keymap.test.ts` **刻意不 import 本文件**，
 * 而是直接 import `spec` / `registry` / `context` 这三个纯模块。
 * 这是有意的分层，不是遗漏 —— 见 `types.ts` 文件头。
 * ============================================================ */
export { registerDefaultKeybindings } from './bindings'
export type { KeymapHost } from './bindings'
export {
  clearKeybindings,
  chordsOf,
  listKeybindings,
  registerKeybinding,
  runDispatch,
  selectBindings,
  whenSatisfied,
} from './registry'
export { getContextKey, resetContext, setContextKey, snapshotContext } from './context'
export { GROUP_ORDER, KEYMAP_SPEC, MIGRATED_BRANCHES, PLANNED_SHARED_CHORDS, RESERVED_CHORDS } from './spec'
export type { KeymapId } from './spec'
export { chordText, chordsText, IS_MAC, useChord } from './useChord'
export type {
  DispatchEvent,
  Keybinding,
  KeybindingGroup,
  KeybindingOrigin,
  KeybindingSpec,
  WhenKey,
} from './types'
export { WHEN_KEYS } from './types'
