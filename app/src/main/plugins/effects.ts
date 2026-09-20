/* ============================================================
 * ArkWork — 插件可逆 effect 账本（v0.35.0 · 纪律⑬的物理载体）
 * 设计文档：docs/versions/v0.35.0/04-system-design.md §3（M5）· §6.3
 *
 * 病（D74）：v0.34.x 的卸载路径是「`refreshPluginSlots()` 清 `plugin` 来源 → 重注册」——
 *   靠**枚举来源**来撤销，而不是靠**记住自己注册过什么**。漏一种来源、漏一处注册点，
 *   就留下静默残留（插槽还在、定时器还在、watcher 还在），且无处可查。
 *
 * 治法（借鉴 Cordis 的 effect 模型）：**装载期记账，卸载期按账本逆序撤销**。
 *   · 每一次「注册/监听/开资源」都必须带一个 disposer 入账；
 *   · `revokeAll(pluginId)` 逆序（LIFO）执行，符合资源释放的通用正确顺序；
 *   · 逆序执行中途某一条抛错 **不得中断** 其余撤销（逐条隔离），失败项收进返回值；
 *   · 幂等：重复 revoke 为空操作（工作区切换 + 禁用 + 退出可能叠加触发）。
 *
 * 纪律⑬：**卸载路径必须与装载路径对称** —— 只有装载代码没有卸载代码 = 未完成。
 *   本文件的 `countOf(pluginId)` 就是给测试当对称性判据用的：
 *   「装载 → 撤销 → 账本为空 + 插槽集合回到装载前」。
 * ============================================================ */

/** 一次可逆副作用的撤销函数 */
export type Disposer = () => void | Promise<void>

/** 账本条目 */
export interface EffectEntry {
  /** 自增序号（诊断与排序用；撤销按倒序） */
  seq: number
  pluginId: string
  /** 归类（诊断面板显示「这个插件留了 3 个定时器」要靠它） */
  kind: string
  /** 人话标签（撤销失败时定位） */
  label: string
  dispose: Disposer
}

/** 撤销结果（失败不抛，收集后由调用方决定怎么呈现） */
export interface RevokeResult {
  revoked: number
  /** 撤销过程抛错的条目（label: 原因） */
  failed: string[]
}

export class PluginEffectLedger {
  private readonly byPlugin = new Map<string, EffectEntry[]>()
  private seq = 0

  /**
   * 登记一次可逆副作用。
   *
   * @param pluginId 归属插件（撤销按它分组）
   * @param kind     归类（如 'slot' / 'timer' / 'watcher' / 'tool' / 'view-session'）
   * @param label    人话标签（如 'ui.panel panel:stock-quotes'）
   * @param dispose  撤销函数
   * @returns 立即撤销这一个 effect 的句柄（插件主动提前释放时用）
   * @throws 当 `dispose` 不是函数 —— 这是**编程错误**（不是外部输入），应当早失败
   */
  register(pluginId: string, kind: string, label: string, dispose: Disposer): () => void {
    if (typeof dispose !== 'function') {
      throw new Error(`[plugin-effect] ${pluginId} 的 ${kind}:${label} 未提供撤销函数（纪律⑬）`)
    }
    const entry: EffectEntry = { seq: ++this.seq, pluginId, kind, label, dispose }
    const list = this.byPlugin.get(pluginId)
    if (list) list.push(entry)
    else this.byPlugin.set(pluginId, [entry])

    let done = false
    return () => {
      if (done) return
      done = true
      const arr = this.byPlugin.get(pluginId)
      if (!arr) return
      const i = arr.indexOf(entry)
      if (i >= 0) arr.splice(i, 1)
      if (arr.length === 0) this.byPlugin.delete(pluginId)
      try {
        void entry.dispose()
      } catch {
        /* 主动提前释放失败：不抛给调用方（卸载全流程还会再兜一次） */
      }
    }
  }

  /**
   * 逆序撤销某插件的副作用。
   *
   * 逐条隔离：一条抛错不影响其余；失败项以 `label: message` 收进 `failed`。
   * 幂等：清空后再调用返回 `{revoked:0, failed:[]}`。
   *
   * @param kinds 只撤销这些类别（缺省 = 全部）。
   *   ★ 为什么需要它：**插槽重注册**（`refreshPluginSlots`）与**插件卸载**是两件事 ——
   *   前者只该撤掉 `slot` 类，若把 `tool` / `view` / `panel` 一起撤掉，就会
   *   「插件进程还以为自己注册着工具，而宿主侧已经忘了」——两边状态分叉。
   */
  async revokeAll(pluginId: string, opts: { kinds?: readonly string[] } = {}): Promise<RevokeResult> {
    const list = this.byPlugin.get(pluginId)
    if (!list || list.length === 0) return { revoked: 0, failed: [] }
    const only = opts.kinds ? new Set(opts.kinds) : null
    const keep: EffectEntry[] = []
    const drop: EffectEntry[] = []
    for (const e of list) {
      if (!only || only.has(e.kind)) drop.push(e)
      else keep.push(e)
    }
    if (drop.length === 0) return { revoked: 0, failed: [] }
    if (keep.length === 0) this.byPlugin.delete(pluginId)
    else this.byPlugin.set(pluginId, keep)

    const failed: string[] = []
    let revoked = 0
    for (let i = drop.length - 1; i >= 0; i -= 1) {
      const e = drop[i]!
      try {
        await e.dispose()
        revoked += 1
      } catch (err) {
        failed.push(`${e.kind}:${e.label} → ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return { revoked, failed }
  }

  /** 某插件当前未撤销的条目（诊断 / 对称性断言用） */
  entriesOf(pluginId: string): readonly EffectEntry[] {
    return this.byPlugin.get(pluginId) ?? []
  }

  /** 条目数（对称性断言：装载后 > 0，撤销后 === 0） */
  countOf(pluginId: string): number {
    return this.byPlugin.get(pluginId)?.length ?? 0
  }

  /** 全部插件的条目总数（泄漏体检用） */
  totalCount(): number {
    let n = 0
    for (const list of this.byPlugin.values()) n += list.length
    return n
  }

  /** 当前有未撤销条目的插件 id 列表（诊断面板「谁还没收干净」） */
  pluginIds(): string[] {
    return Array.from(this.byPlugin.keys())
  }

  /** 按 kind 汇总（诊断面板「这个插件留了哪些类别的资源」） */
  kindsOf(pluginId: string): Record<string, number> {
    const out: Record<string, number> = {}
    for (const e of this.entriesOf(pluginId)) out[e.kind] = (out[e.kind] ?? 0) + 1
    return out
  }

  /** 清空（测试收尾 / 应用退出前的兜底） */
  clear(): void {
    this.byPlugin.clear()
    this.seq = 0
  }
}

/** 全局唯一账本（主进程内单实例；插件运行时与插槽装配共用） */
export const pluginEffects = new PluginEffectLedger()
