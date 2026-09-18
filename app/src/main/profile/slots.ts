/* ============================================================
 * ArkWork — Slot Service：统一插槽服务（v0.32.0）
 * 设计文档：docs/versions/v0.32.0/04-system-design.md §2.7
 *           正本 `workbench-profile-v1.0/04-宿主插槽与UI扩展体系.md` §2–§5
 *
 * 判断 J2「插槽先行，插件市场其次」：先有「注册进来放在哪」的统一契约，
 * 能力插件才有安放之处。底座不认识任何垂直领域 —— 它只认识九类插槽。
 *
 * 三条工程纪律：
 *  ① **id 重复用 throw 不用静默覆盖** —— 沿用 `keymap/registry.ts:36` 与
 *     `agent/prompt/contract.ts:71` 的既有先例（注册发生在启动期，抛错能
 *     第一时间暴露「注册了但没生效」这类极难定位的问题）。
 *  ② **注册可逆**（返回 Disposable）—— Cordis 无特权内核模型的无重启切换前提。
 *  ③ **冲突不静默**（同 position 触发回调）—— 对齐「冲突是信息不是故障」。
 * ============================================================ */
import { SLOT_KINDS, type Disposable, type SlotEntry, type SlotKind, type SlotQuery } from '@shared/types/profile'

const entries = new Map<SlotKind, SlotEntry[]>()
const conflictHandlers = new Map<SlotKind, Array<(a: SlotEntry, b: SlotEntry) => void>>()

function bucket(kind: SlotKind): SlotEntry[] {
  let arr = entries.get(kind)
  if (!arr) {
    arr = []
    entries.set(kind, arr)
  }
  return arr
}

/**
 * 注册一个插槽条目。
 * @throws 当同 kind 下 id 已存在（静默覆盖会让「注册了但没生效」无法定位）
 */
export function registerSlot(kind: SlotKind, entry: SlotEntry): Disposable {
  if (!SLOT_KINDS.includes(kind)) {
    throw new Error(`[slot] 未知插槽类型：${String(kind)}`)
  }
  if (!entry || typeof entry.id !== 'string' || entry.id.length === 0) {
    throw new Error(`[slot] ${kind} 的条目必须有非空 id`)
  }
  const arr = bucket(kind)
  if (arr.some((e) => e.id === entry.id)) {
    throw new Error(`[slot] ${kind} 已存在 id=${entry.id}（插槽 id 必须全局唯一，不做静默覆盖）`)
  }
  // 同 position 冲突 → 通知订阅方（不阻断注册，但绝不静默）
  if (entry.position !== undefined) {
    const same = arr.filter((e) => e.position === entry.position)
    for (const other of same) {
      for (const h of conflictHandlers.get(kind) ?? []) h(other, entry)
    }
  }
  arr.push(entry)
  return () => {
    const list = entries.get(kind)
    if (!list) return
    const i = list.findIndex((e) => e.id === entry.id)
    if (i >= 0) list.splice(i, 1)
  }
}

/** 按当前装配过滤查询（v1：query 只用于预留过滤位，返回全部）。结果确定性排序。 */
export function resolveSlots(kind: SlotKind, query?: SlotQuery): SlotEntry[] {
  const list = (entries.get(kind) ?? []).slice()
  let out = list
  if (query?.requiredOnly) out = out.filter((e) => (e.payload as { required?: boolean })?.required === true)
  return out.sort((a, b) => {
    const pa = a.position ?? Number.MAX_SAFE_INTEGER
    const pb = b.position ?? Number.MAX_SAFE_INTEGER
    if (pa !== pb) return pa - pb
    return a.id.localeCompare(b.id)
  })
}

/** 订阅某个插槽的 position 冲突（返回值取消订阅） */
export function onSlotConflict(
  kind: SlotKind,
  handler: (a: SlotEntry, b: SlotEntry) => void,
): Disposable {
  const arr = conflictHandlers.get(kind) ?? []
  arr.push(handler)
  conflictHandlers.set(kind, arr)
  return () => {
    const cur = conflictHandlers.get(kind)
    if (!cur) return
    const i = cur.indexOf(handler)
    if (i >= 0) cur.splice(i, 1)
  }
}

/**
 * 清空全部插槽条目（激活新 profile 时先清再按快照重注册）。
 * 注意：v1 只有 profile 一个注册来源，因此全清是安全的；
 * 一旦存量注册表（渲染器 / 动作 / 侧栏）迁槽（遗留 L4），
 * 本函数必须改为「只清非 builtin 来源」。
 */
export function resetProfileSlots(): void {
  entries.clear()
}

export function listSlotKinds(): SlotKind[] {
  return SLOT_KINDS.filter((k) => (entries.get(k)?.length ?? 0) > 0)
}

/** 可观测性：供激活报告与测试读取当前注册量 */
export function slotStats(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const k of SLOT_KINDS) out[k] = entries.get(k)?.length ?? 0
  return out
}
