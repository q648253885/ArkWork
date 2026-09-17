/* ============================================================
 * ArkWork — 逻辑和弦工具（v0.31.0 B0 新建）
 *
 * 职责：**唯一真源** —— 逻辑和弦串 ↔ 平台物理键 的换算与比较。
 *
 * 三条纪律（跨平台硬规范，见 03-interaction §5.4 与项目长期记忆）：
 *   1. 业务代码只写**逻辑和弦**（`Mod+K` / `Ctrl+Tab` / `Mod+Backslash`），
 *      不写 `metaKey` / `ctrlKey` 判定，也不写裸修饰键符号（U+2318 / U+2303 / U+2325 / U+21E7）。
 *   2. 展示一律经 `chordToDisplay()`；JSX 与 i18n 内出现裸符号即违规
 *      （U+2303 在部分 Windows 字体缺字形）。
 *   3. `Mod` = 平台主修饰键（macOS 的 Command / 其它平台的 Ctrl）；`Ctrl` = **物理 Control**。
 *      两者同时出现在一条和弦里是退化的（非 macOS 上 Mod≡Ctrl），
 *      `findChordCollisions()` 会把这类写法暴露出来。
 *
 * 纯函数、零 DOM 依赖：事件参数用结构类型 `ChordEvent` 而非 `KeyboardEvent`，
 * 便于 node:test 直接构造普通对象做密闭单测（与 gate-nav.ts 同纪律）。
 *
 * 为什么 `Mod` 在 macOS 上**只**认 `metaKey`（不接受物理 Control 代偿）：
 *   迁移前的 `App.tsx` 用的是 `e.metaKey || e.ctrlKey`，等于让「Control+K/Control+B」与「Command+K/Command+B」
 *   等价。macOS 上「Control+1~9」已被 Mission Control 占用、「Control+↑/↓」被空间切换占用，
 *   保留这个「代偿」会把系统保留区误当成应用自己的键位，且与 B3 要新增的
 *   物理 `Ctrl+Tab` 语义互相污染。故本版收紧为精确匹配 ——
 *   这是**刻意登记的迁移偏差**，不是疏漏（见 04-system-design 「B0 精读后修正」）。
 * ============================================================ */

/** 修饰键 token 的规范书写（大小写敏感：只认这一种写法） */
export const MOD = 'Mod'
export const CTRL = 'Ctrl'
export const ALT = 'Alt'
export const SHIFT = 'Shift'

/** 逻辑和弦串，如 `'Mod+K'` / `'Shift+Tab'` / `'Escape'` */
export type Chord = string

/**
 * 结构化键盘事件 —— `KeyboardEvent` 的最小子集。
 * 只取比较用得到的 5 个字段，使单测无需 DOM。
 */
export interface ChordEvent {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}

export interface ParsedChord {
  /** 平台主修饰键（macOS 的 Command / 其它平台的 Ctrl） */
  mod: boolean
  /** 物理 Control */
  ctrl: boolean
  alt: boolean
  shift: boolean
  /** 规范化主键（小写；符号键收敛为逻辑名，见 SYMBOL_TO_LOGICAL） */
  key: string
}

/* ------------------------------------------------------------
 * 键名双向映射
 * ---------------------------------------------------------- */

/** 物理 key（`e.key.toLowerCase()` 后）→ 逻辑键名 */
const SYMBOL_TO_LOGICAL: Record<string, string> = {
  '\\': 'backslash',
  '/': 'slash',
  ',': 'comma',
  '.': 'period',
  ';': 'semicolon',
  "'": 'quote',
  '[': 'bracketleft',
  ']': 'bracketright',
  '-': 'minus',
  '=': 'equal',
  '`': 'backquote',
  ' ': 'space',
}

/** 逻辑键名字 → 物理 key（`SYMBOL_TO_LOGICAL` 的逆映射 + 显式别名） */
const LOGICAL_TO_SYMBOL: Record<string, string> = {
  backslash: '\\',
  slash: '/',
  comma: ',',
  period: '.',
  semicolon: ';',
  quote: "'",
  bracketleft: '[',
  bracketright: ']',
  minus: '-',
  equal: '=',
  backquote: '`',
  space: ' ',
}

/** 逻辑键名的书写别名（把 `Esc` / `Esc` 之类的宽松写法收敛到同一逻辑名） */
const KEY_TOKEN_ALIAS: Record<string, string> = {
  esc: 'escape',
  escape: 'escape',
  space: 'space',
  backslash: 'backslash',
  slash: 'slash',
  comma: 'comma',
  period: 'period',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  arrowup: 'arrowup',
  arrowdown: 'arrowdown',
  arrowleft: 'arrowleft',
  arrowright: 'arrowright',
}

/** 和弦 token（不含修饰键）→ 逻辑键名（别名表 + 符号表，两级收敛） */
function logicalKeyFromToken(token: string): string {
  const t = token.toLowerCase()
  // 必须先过别名表（`Esc`→escape 这类语义别名），再过符号表（`/`→slash）。
  // 漏掉符号表会让 `Mod+/` 解析出字面 `/`，与事件侧的 `slash` 永不相等 ——
  // TC-KEY-007 正是据此抓到的（符号键不归一会让「按了没反应」极难定位）。
  return KEY_TOKEN_ALIAS[t] ?? SYMBOL_TO_LOGICAL[t] ?? t
}

/** 物理事件 key → 逻辑键名 */
function logicalKeyFromEventKey(key: string): string {
  const k = key.toLowerCase()
  return SYMBOL_TO_LOGICAL[k] ?? k
}

/** 逻辑键名 → 展示用主键文案（非 macOS 与 macOS 共用；修饰键符号由 chordToDisplay 加） */
function displayKey(logical: string): string {
  const sym = LOGICAL_TO_SYMBOL[logical]
  if (sym !== undefined) return sym === ' ' ? 'Space' : sym
  switch (logical) {
    case 'escape':
      return 'Esc'
    case 'arrowup':
      return '↑'
    case 'arrowdown':
      return '↓'
    case 'arrowleft':
      return '←'
    case 'arrowright':
      return '→'
    default:
      return logical.length === 1 ? logical.toUpperCase() : logical.replace(/^./, (c) => c.toUpperCase())
  }
}

/* ------------------------------------------------------------
 * 解析 / 归一
 * ---------------------------------------------------------- */

/**
 * 解析逻辑和弦。修饰键 token 必须完整书写（`Mod` / `Ctrl` / `Alt` / `Shift`），
 * 其余 token 视为主键（取**最后一个**，容忍 `Mod+Shift+K` 这类顺序自由写法）。
 *
 * `Mod++`（加号键）这种以 `+` 结尾的写法按「主键 = +」处理。
 */
export function parseChord(chord: Chord): ParsedChord {
  const raw = chord.trim()
  // `Mod++` → tokens ['Mod','+']：尾部是加号键
  const trailingPlus = raw.endsWith('+')
  const body = trailingPlus ? raw.slice(0, -1) : raw
  const tokens = body.split('+').filter((t) => t.length > 0)

  let mod = false
  let ctrl = false
  let alt = false
  let shift = false
  let keyToken: string | null = null

  for (const token of tokens) {
    switch (token) {
      case MOD:
        mod = true
        break
      case CTRL:
        ctrl = true
        break
      case ALT:
        alt = true
        break
      case SHIFT:
        shift = true
        break
      default:
        keyToken = token
    }
  }

  if (trailingPlus) keyToken = '+'
  if (keyToken === null) throw new Error(`[keys] 和弦缺少主键：${chord}`)
  if (keyToken === '+') return { mod, ctrl, alt, shift, key: '+' }
  return { mod, ctrl, alt, shift, key: logicalKeyFromToken(keyToken) }
}

/** 事件 → 逻辑和弦串（规范化：修饰键顺序固定，主键收敛为逻辑名） */
export function chordFromEvent(e: ChordEvent): Chord {
  const parts: string[] = []
  if (e.metaKey) parts.push(MOD)
  if (e.ctrlKey) parts.push(CTRL)
  if (e.altKey) parts.push(ALT)
  if (e.shiftKey) parts.push(SHIFT)
  parts.push(logicalKeyFromEventKey(e.key))
  return parts.join('+')
}

/* ------------------------------------------------------------
 * 匹配
 * ---------------------------------------------------------- */

/**
 * 事件是否匹配和弦。
 *
 * `isMac` 只影响 `Mod` 的展开：macOS → `metaKey`；其它平台 → `ctrlKey`。
 * 其余修饰键精确比较（多按一个修饰键即不匹配，避免 `Mod+K` 被 `Mod+Shift+K` 抢走）。
 */
export function matchesChord(chord: Chord, e: ChordEvent, isMac: boolean): boolean {
  const p = parseChord(chord)
  const modDown = isMac ? e.metaKey === true : e.ctrlKey === true
  if (p.mod !== modDown) return false
  if (p.ctrl !== (e.ctrlKey === true)) return false
  if (p.alt !== (e.altKey === true)) return false
  if (p.shift !== (e.shiftKey === true)) return false
  return p.key === logicalKeyFromEventKey(e.key)
}

/**
 * 找出互相冲突的和弦对。
 *
 * 冲突 = 在给定平台上，两个不同的规范写法会命中同一次按键。
 * 典型来源：`Mod+G` 与 `Ctrl+G`（非 macOS 上退化等价）—— 键位表**不得**这么写。
 */
export function findChordCollisions(chords: readonly Chord[], isMac: boolean): Array<[Chord, Chord]> {
  const seen = new Map<Chord, Chord>()
  const collisions: Array<[Chord, Chord]> = []
  for (const chord of chords) {
    const canonical = canonicalChord(chord, isMac)
    const prev = seen.get(canonical)
    if (prev !== undefined && prev !== chord) collisions.push([prev, chord])
    else seen.set(canonical, chord)
  }
  return collisions
}

/**
 * 和弦的**平台规范化**写法：把 `Mod` 展开成该平台上的物理语义。
 * 用于撞键检测（`Mod+G` 在非 macOS 上应规范化为 `Ctrl+G`，从而与显式 `Ctrl+G` 撞上）。
 */
export function canonicalChord(chord: Chord, isMac: boolean): Chord {
  const p = parseChord(chord)
  const parts: string[] = []
  if (isMac) {
    if (p.mod) parts.push('meta')
    if (p.ctrl) parts.push('ctrl')
  } else {
    // 非 macOS：Mod 与 Ctrl 都是物理 Ctrl → 写进同一格，退化才能被发现
    if (p.mod || p.ctrl) parts.push('ctrl')
  }
  if (p.alt) parts.push('alt')
  if (p.shift) parts.push('shift')
  parts.push(p.key)
  return parts.join('+')
}

/* ------------------------------------------------------------
 * 展示
 * ---------------------------------------------------------- */

/**
 * 和弦 → 人类可读展示串。
 * macOS 用符号（U+2318 / U+2303 / U+2325 / U+21E7，无分隔符，与系统习惯一致）；
 * 其它平台用 `Ctrl+` / `Alt+` / `Shift+` 文本。
 *
 * **本函数是唯一允许产出上述符号的地方** —— 其他任何文件产出裸符号都是违规。
 */
export function chordToDisplay(chord: Chord, isMac: boolean): string {
  const p = parseChord(chord)
  const key = displayKey(p.key)
  if (!isMac) {
    const parts: string[] = []
    if (p.mod) parts.push('Ctrl')
    if (p.ctrl) parts.push('Ctrl')
    if (p.alt) parts.push('Alt')
    if (p.shift) parts.push('Shift')
    parts.push(key)
    return parts.join('+')
  }
  // macOS：用 Unicode 转义而非字面量 —— 本文件本身也必须「零裸符号字面量」，
  // 这样「全仓库零裸符号」的校验脚本可以只对本函数做一次白名单豁免。
  let s = ''
  if (p.mod) s += '\u2318'
  if (p.ctrl) s += '\u2303'
  if (p.alt) s += '\u2325'
  if (p.shift) s += '\u21e7'
  return s + key
}

/** 和弦组（别名）→ 展示串数组，去重后保序 */
export function chordsToDisplay(chords: readonly Chord[], isMac: boolean): string[] {
  const out: string[] = []
  for (const c of chords) {
    const s = chordToDisplay(c, isMac)
    if (!out.includes(s)) out.push(s)
  }
  return out
}
