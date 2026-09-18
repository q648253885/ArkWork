/* ============================================================
 * ArkWork — Slot Service：统一插槽服务（v0.32.0 → v0.33.0）
 * 设计文档：docs/versions/v0.33.0/04-system-design.md §5
 *           正本 `workbench-profile-v1.0/04-宿主插槽与UI扩展体系.md` §2–§5
 *
 * 判断 J2「插槽先行，插件市场其次」：先有「注册进来放在哪」的统一契约，
 * 能力插件才有安放之处。底座不认识任何垂直领域 —— 它只认识九类插槽。
 *
 * v0.33.0 的两处升级（缺陷 D42 / D41）：
 *  ① **来源维度（`source`）** —— `resetProfileSlots()` 从「全清」改为「按来源清」。
 *     曾经的注释自己写明了这个隐患：「一旦存量注册表入槽，本函数必须改为
 *     只清非 builtin 来源」—— 现在存量注册表（渲染器 / 面板）真的入槽了。
 *  ② **覆盖语义** —— 同 kind 同 id、已有为 `builtin`、新来的是 `profile`/`plugin`
 *     时**允许覆盖**（这就是「插件接管渲染器扩展名」的实现基础），
 *     并触发 `onSlotConflict` 回调（冲突永不静默）。同来源重复仍然 throw。
 *
 * 三条工程纪律（不变）：
 *  ① **id 重复用 throw 不用静默覆盖**（同来源内）—— 注册发生在启动期，
 *     抛错能第一时间暴露「注册了但没生效」这类极难定位的问题。
 *  ② **注册可逆**（返回 Disposable）—— Cordis 无特权内核模型的无重启切换前提。
 *  ③ **冲突不静默**（触发回调）—— 对齐「冲突是信息不是故障」。
 * ============================================================ */
import {
  SLOT_KINDS,
  type Disposable,
  type SlotEntry,
  type SlotKind,
  type SlotQuery,
  type SlotSource,
} from '@shared/types/profile'

interface Bucket {
  entries: SlotEntry[]
  conflictHandlers: Array<(a: SlotEntry, b: SlotEntry) => void>
}

const buckets = new Map<SlotKind, Bucket>()

function bucket(kind: SlotKind): Bucket {
  let b = buckets.get(kind)
  if (!b) {
    b = { entries: [], conflictHandlers: [] }
    buckets.set(kind, b)
  }
  return b
}

/** 缺省来源 = builtin（既有测试直接构造无 source 的条目，见 §12 纪律 3） */
function sourceOf(e: SlotEntry): SlotSource {
  return e.source ?? 'builtin'
}

function notifyConflict(kind: SlotKind, a: SlotEntry, b: SlotEntry): void {
  const b0 = buckets.get(kind)
  if (!b0) return
  for (const h of b0.conflictHandlers) {
    try {
      h(a, b)
    } catch {
      // 监听方自己的错误不得影响注册流程
    }
  }
}

/**
 * 注册一个插槽条目。
 *
 * @param source 来源（缺省 `'builtin'`）
 * @throws 当同 kind 同 id 且**来源相同**时（静默覆盖会让「注册了但没生效」无法定位）
 */
export function registerSlot(kind: SlotKind, entry: SlotEntry, source?: SlotSource): Disposable {
  if (!SLOT_KINDS.includes(kind)) {
    throw new Error(`[slot] 未知插槽类型：${String(kind)}`)
  }
  if (!entry || typeof entry.id !== 'string' || entry.id.length === 0) {
    throw new Error(`[slot] ${kind} 的条目必须有非空 id`)
  }
  const src = source ?? sourceOf(entry)
  const b = bucket(kind)
  const idx = b.entries.findIndex((e) => e.id === entry.id)

  if (idx >= 0) {
    const existing = b.entries[idx]!
    if (sourceOf(existing) === src) {
      throw new Error(
        `[slot] ${kind} 已存在 id=${entry.id}（来源 ${src} 内不允许重复注册，不做静默覆盖）`,
      )
    }
    if (sourceOf(existing) !== 'builtin') {
      // profile 覆盖 profile、plugin 覆盖 plugin 都属上层策略错误 → 同样抛错
      throw new Error(
        `[slot] ${kind} 的 id=${entry.id} 已被来源 ${sourceOf(existing)} 占用，不能由 ${src} 覆盖`,
      )
    }
    // builtin 被 profile/plugin 覆盖：允许，但必须留痕（不静默）
    const prev = existing
    b.entries[idx] = { ...entry, source: src }
    notifyConflict(kind, prev, entry)
    return () => {
      const list = buckets.get(kind)?.entries
      if (!list) return
      const i = list.findIndex((e) => e.id === entry.id && sourceOf(e) === src)
      // 撤销覆盖 → 恢复被覆盖的 builtin 条目（可逆注册）
      if (i >= 0) list[i] = prev
    }
  }

  // 同 position 冲突 → 通知订阅方（不阻断注册，但绝不静默）
  if (entry.position !== undefined) {
    const same = b.entries.filter((e) => e.position === entry.position)
    for (const other of same) notifyConflict(kind, other, entry)
  }

  const stored: SlotEntry = { ...entry, source: src }
  b.entries.push(stored)
  return () => {
    const list = buckets.get(kind)?.entries
    if (!list) return
    const i = list.findIndex((e) => e.id === stored.id && sourceOf(e) === src)
    if (i >= 0) list.splice(i, 1)
  }
}

/** 按当前装配过滤查询。结果确定性排序（position 升序、同值按 id）。 */
export function resolveSlots(kind: SlotKind, query?: SlotQuery): SlotEntry[] {
  let out = (buckets.get(kind)?.entries ?? []).slice()
  if (query?.requiredOnly) {
    out = out.filter((e) => (e.payload as { required?: boolean })?.required === true)
  }
  if (query?.source) {
    out = out.filter((e) => sourceOf(e) === query.source)
  }
  return out.sort((a, b) => {
    const pa = a.position ?? Number.MAX_SAFE_INTEGER
    const pb = b.position ?? Number.MAX_SAFE_INTEGER
    if (pa !== pb) return pa - pb
    return a.id.localeCompare(b.id)
  })
}

/** 订阅某个插槽的冲突（返回取消订阅） */
export function onSlotConflict(
  kind: SlotKind,
  handler: (a: SlotEntry, b: SlotEntry) => void,
): Disposable {
  const b = bucket(kind)
  b.conflictHandlers.push(handler)
  return () => {
    const cur = buckets.get(kind)?.conflictHandlers
    if (!cur) return
    const i = cur.indexOf(handler)
    if (i >= 0) cur.splice(i, 1)
  }
}

/**
 * 清理插槽条目。
 *
 * @param source 有值 → **只清该来源**（v0.33.0 主用法）；无值 → 全清（既有语义，
 *               供单测与「重置一切」场景使用，见 §12 纪律 4）。
 */
export function resetProfileSlots(source?: SlotSource): void {
  if (source === undefined) {
    // 全清条目但**保留冲突订阅**（订阅方在应用启动期注册一次，不该被清掉）
    for (const b of buckets.values()) b.entries = []
    return
  }
  for (const b of buckets.values()) {
    b.entries = b.entries.filter((e) => sourceOf(e) !== source)
  }
}

export function listSlotKinds(): SlotKind[] {
  return SLOT_KINDS.filter((k) => (buckets.get(k)?.entries.length ?? 0) > 0)
}

/** 可观测性：供激活报告与测试读取当前注册量 */
export function slotStats(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const k of SLOT_KINDS) out[k] = buckets.get(k)?.entries.length ?? 0
  return out
}

/** ★ v0.33.0：按 kind × source 的来源分布（诊断页用） */
export function slotSourceStats(): Record<SlotKind, Record<SlotSource, number>> {
  const out = {} as Record<SlotKind, Record<SlotSource, number>>
  for (const k of SLOT_KINDS) {
    const dist: Record<SlotSource, number> = { builtin: 0, profile: 0, plugin: 0 }
    for (const e of buckets.get(k)?.entries ?? []) dist[sourceOf(e)] += 1
    out[k] = dist
  }
  return out
}

/** 全部插槽的完整快照（诊断页与 `profile:slots` IPC 用） */
export function snapshotAllSlots(): Partial<Record<SlotKind, SlotEntry[]>> {
  const out: Partial<Record<SlotKind, SlotEntry[]>> = {}
  for (const k of listSlotKinds()) out[k] = resolveSlots(k)
  return out
}
