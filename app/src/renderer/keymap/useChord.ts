/* ============================================================
 * ArkWork — 和弦展示 hook（v0.31.0 B0）
 *
 * 组件里**唯一**允许产出键位提示文案的入口。
 * 规则：JSX 与 i18n 内不得出现裸修饰键符号（U+2318/U+2303/U+2325/U+21E7），
 * i18n 侧用 `{{kbd}}` 插值，插值值由本 hook 提供。
 *
 * 平台判定的唯一来源是 preload 暴露的 `ark.platform`（不读 `navigator.platform`）。
 * 平台在单次会话内不变，故取模块级常量而非每次渲染计算 ——
 * 键位提示会在列表里渲染几十次，避免无意义的重算。
 * ============================================================ */
import { ark } from '../ipc/client'
import { chordToDisplay, type Chord } from '@shared/utils/keys'

/** 当前平台是否 macOS（唯一判定处） */
export const IS_MAC: boolean = ark.platform === 'darwin'

/** 单个和弦 → 展示串（如 macOS 上的 `Mod+K` → Command 符号 + K） */
export function useChord(chord: Chord): string {
  return chordToDisplay(chord, IS_MAC)
}

/**
 * 和弦组（别名）→ 展示串数组；帮助中心用于「主键 / 备选键」并列。
 *
 * 刻意**不**叫 `useChords`：它内部没有任何 hook，命名成 `use*` 会触发
 * react-hooks 规则而在 `.map()` 里被误判为违规调用。展示逻辑没必要伪装成 hook。
 */
export function chordsText(chord: Chord | readonly Chord[]): string[] {
  const list: readonly Chord[] = typeof chord === 'string' ? [chord] : chord
  return list.map((c) => chordToDisplay(c, IS_MAC))
}

/**
 * 纯函数版本（非组件场景：事件回调、helper、单测）。
 * 与 `useChord` 同源同平台判定，不得另写实现。
 */
export function chordText(chord: Chord): string {
  return chordToDisplay(chord, IS_MAC)
}
