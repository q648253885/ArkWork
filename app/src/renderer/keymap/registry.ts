/* ============================================================
 * ArkWork — 键位注册表（v0.31.0 B0）
 *
 * 取代迁移前 `App.tsx` 里那段 13 分支的 if 链。三件事：
 *   1. **注册**：`registerKeybinding()` 返回取消函数（沿用项目既有清理式签名）
 *   2. **选择**：`selectBindings()` 纯筛选（和弦匹配 + when 全满足 + 优先级降序）
 *   3. **分发**：`runDispatch()` 逐个调用 handler，返回 false 则继续冒泡
 *
 * 为什么把选择与分开发开：
 *   `selectBindings()` 是纯函数，帮助中心和单测都能直接调它断言
 *   「哪条键位会在当前上下文下胜出」，不需要构造事件分发副作用。
 *
 * 分发的返回值语义（与迁移前 if 链对齐）：
 *   - 命中并消费 → true（App.tsx 据此决定是否 `preventDefault`）
 *   - 全部 handler 都返回 false → false（继续冒泡，不 `preventDefault`）
 * ============================================================ */
import { matchesChord, type Chord } from '@shared/utils/keys'
import { getContextKey } from './context'
import type { DispatchEvent, Keybinding, KeybindingSpec, WhenKey } from './types'

const entries: Keybinding[] = []

/** 展平 `chord` 的别名数组 */
export function chordsOf(spec: KeybindingSpec): Chord[] {
  return typeof spec.chord === 'string' ? [spec.chord] : [...spec.chord]
}

/**
 * 注册一条键位。重复 `id` 视为编程错误（**抛错而非静默覆盖**）：
 * 静默覆盖会让「注册了但没生效」这类问题极难定位，
 * 而注册发生在应用启动期，抛错能第一时间暴露。
 */
export function registerKeybinding(b: Keybinding): () => void {
  if (entries.some((e) => e.id === b.id)) {
    throw new Error(`[keymap] 键位 id 重复注册：${b.id}`)
  }
  if (chordsOf(b).length === 0) {
    throw new Error(`[keymap] 键位缺少和弦：${b.id}`)
  }
  entries.push(b)
  return () => {
    const i = entries.indexOf(b)
    if (i >= 0) entries.splice(i, 1)
  }
}

/** 全部已注册键位（注册顺序）。帮助中心按 `group` 分组后展示 */
export function listKeybindings(): Keybinding[] {
  return [...entries]
}

/** 清空注册表（单测清理用；应用运行期不应调用） */
export function clearKeybindings(): void {
  entries.length = 0
}

/** `when` 是否全部满足 */
export function whenSatisfied(when: readonly WhenKey[] | undefined): boolean {
  if (!when || when.length === 0) return true
  return when.every((k) => getContextKey(k))
}

/**
 * 选出当前上下文下可触发的键位，**优先级降序**（同级保持注册顺序，稳定排序）。
 *
 * 同 when 下若两条键位和弦相同，高 `priority` 者先被尝试；
 * handler 返回 false 时继续尝试下一条 —— 这是「窄作用域覆盖宽作用域」的机制。
 */
export function selectBindings(
  e: DispatchEvent,
  ctx: Readonly<Record<WhenKey, boolean>>,
  isMac: boolean,
): Keybinding[] {
  const hit = entries.filter((b) => {
    if (!chordsOf(b).some((c) => matchesChord(c, e, isMac))) return false
    if (!b.when || b.when.length === 0) return true
    return b.when.every((k) => ctx[k] === true)
  })
  return hit.sort((a, b) => b.priority - a.priority)
}

/**
 * 分发：按优先级尝试候选，`handler` 返回 `false` 则继续冒泡。
 * 返回 `true` 表示**已被消费**（调用方应停止后续处理）。
 */
export function runDispatch(
  e: DispatchEvent,
  ctx: Readonly<Record<WhenKey, boolean>>,
  isMac: boolean,
): boolean {
  for (const b of selectBindings(e, ctx, isMac)) {
    const r = b.handler(e)
    if (r !== false) return true
  }
  return false
}
