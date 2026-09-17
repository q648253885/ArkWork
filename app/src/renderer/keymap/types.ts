/* ============================================================
 * ArkWork — 键位注册表类型（v0.31.0 B0）
 *
 * 三层键位：**默认层**（本目录 spec.ts）/ **上下文层**（`when` 门控）/
 * **用户覆盖层**（P2，本版只留 `id` 稳定锚点，不实现 UI）。
 *
 * 为什么把「声明」与「处理」拆开（spec.ts / actions.ts）：
 *   `spec.ts` 是**纯数据、零 import**，因此 node:test 可以直接 import 它做
 *   完备性 / 撞键 / 预留位断言，不需要 DOM、不需要 store、不需要 electron 桩。
 *   若把 handler 与声明写在一起，注册表就必须连带拉起 store 与 IPC，
 *   单测只能退化为「源码字符串匹配」，覆盖强度会大幅下降。
 * ============================================================ */
import type { Chord } from '@shared/utils/keys'

export type { Chord }

/**
 * 上下文门控键。全部满足才可触发（空数组 = 无条件）。
 *
 * 本版（B0）只会真正用到 `dialogOpen` 之外的少数几个；
 * 其余为 B2–B5 预留，**不得**为了"看起来完整"而提前赋值 ——
 * 未赋值的键恒为 false（context.ts 的默认值语义）。
 */
export type WhenKey =
  | 'editorFocused'
  | 'previewFocused'
  | 'dialogOpen'
  | 'hasSelection'
  | 'hasOpenTab'
  | 'dirty'
  | 'regionIsChat'
  | 'regionIsFiles'
  | 'regionIsSplit'

export const WHEN_KEYS: readonly WhenKey[] = [
  'editorFocused',
  'previewFocused',
  'dialogOpen',
  'hasSelection',
  'hasOpenTab',
  'dirty',
  'regionIsChat',
  'regionIsFiles',
  'regionIsSplit',
] as const

export type KeybindingGroup = 'global' | 'editor' | 'region' | 'inspector' | 'help'

/** 键位来源：默认层 / 用户覆盖层（P2）。帮助中心据此标注"已自定义" */
export type KeybindingOrigin = 'default' | 'user'

/**
 * 键位**声明**（纯数据）。
 *
 * `id` 是稳定锚点：用户覆盖与帮助中心都以此为准，**不得随文案改动**。
 * `titleKey` 必须是 i18n key —— 禁止内联文案（否则 4 语言必然漂移）。
 */
export interface KeybindingSpec {
  id: string
  /** 主和弦 + 别名（同义键并列，如 `Mod+/` 与 `Mod+?`）。空数组视为非法 */
  chord: Chord | readonly Chord[]
  /** 全部满足才可触发；省略 = 无条件 */
  when?: readonly WhenKey[]
  /** 数值大者优先（同 when 下消歧；后续批次用高优先级抢占同和弦的窄作用域） */
  priority: number
  /** 帮助中心展示的 i18n key */
  titleKey: string
  group: KeybindingGroup
  /** 是否进帮助中心（默认 true；内部派生键位置 false） */
  showInHelp?: boolean
}

/**
 * 可分发的最小事件面。
 *
 * 故意不直接用 `KeyboardEvent`：单测可传普通对象（只给 `key` 与 4 个修饰位），
 * 无需 DOM。真实 `KeyboardEvent` 结构上满足本接口，可直接传入。
 */
export interface DispatchEvent {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  preventDefault?: () => void
  stopPropagation?: () => void
  target?: unknown
}

/**
 * 已注册的键位 = 声明 + 处理函数。
 *
 * `handler` 返回 `false` 表示**不消费**：注册表会继续尝试下一候选
 * （Escape 链与 `when` 消歧都依赖这条语义）。返回其它值 / undefined = 已消费。
 */
export interface Keybinding extends KeybindingSpec {
  handler: (e: DispatchEvent) => boolean | void
  origin: KeybindingOrigin
}
