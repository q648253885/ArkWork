/* ============================================================
 * ArkWork — IPC: Workbench Profile（插件模式 · v0.32.0）
 * 设计文档 §8.4（通道表）+ docs/versions/v0.32.0/04-system-design.md §2.10
 *
 * 九个通道：list / get-active / activate / snapshot / validate / import /
 *          delete / slots + 一条 main→renderer 广播 changed。
 *
 * 纪律：
 *  ① handler 只做「解析入参 → 调 profile/* → 组装返回」，不放业务逻辑；
 *  ② 失败不抛（除编程错误）—— 一律转成带原因的结果对象，让 UI 能逐条展示；
 *  ③ 切换成功后向所有窗口广播 `profile:changed`（多窗口一致性）。
 * ============================================================ */
import { ipcMain, BrowserWindow } from 'electron'
import { ProfileChannel } from '@shared/types/ipc'
import type { SlotKind } from '@shared/types/profile'
import {
  activateProfile,
  flattenChain,
  parseImportedManifest,
  probeBaseInventory,
  resolveChain,
  toValidationContext,
  currentSlotStats,
} from '../profile/activator.js'
import { summarize, validateReferences } from '@shared/utils/profile-manifest'
import { deleteUserProfile, getActiveProfileId, getLastSnapshot, listProfiles, saveLastSnapshot, setActiveProfileId, upsertUserProfile } from '../profile/store.js'
import { resolveSlots, listSlotKinds } from '../profile/slots.js'
import { logger } from '../system/logger.js'

/** 向所有窗口推送切换事件（多窗口同源，避免只刷新一个窗） */
function broadcastChanged(profileId: string, ok: boolean): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(ProfileChannel.Changed, { profileId, ok })
  }
}

export function registerProfileHandlers(): void {
  /* ---------- 列表 ---------- */
  ipcMain.handle(ProfileChannel.List, async () => {
    const [all, activeId] = await Promise.all([listProfiles(), getActiveProfileId()])
    // 合并后的-effectiveness 不可知（涉及底座存货）→ 列表只给声明量，够 UI 用
    return all.map((p) => summarize(p, activeId))
  })

  /* ---------- 当前生效 ---------- */
  ipcMain.handle(ProfileChannel.GetActive, async () => {
    const [profileId, snapshot] = await Promise.all([getActiveProfileId(), getLastSnapshot()])
    return { profileId, snapshot }
  })

  /* ---------- 激活 ---------- */
  ipcMain.handle(ProfileChannel.Activate, async (_e, args: { id: string }) => {
    const id = String(args?.id ?? '')
    if (!id) {
      logger.warn('System', '[profile] activate 缺少 id')
      return null
    }
    const report = await activateProfile(id)
    broadcastChanged(report.ok ? report.profileId : report.stillActiveProfileId ?? '', report.ok)
    return report
  })

  /* ---------- 快照 ---------- */
  ipcMain.handle(ProfileChannel.Snapshot, async () => getLastSnapshot())

  /* ---------- 干跑校验（导入预览） ---------- */
  ipcMain.handle(ProfileChannel.Validate, async (_e, args: { raw: unknown }) => {
    const { profile, issues } = parseImportedManifest(args?.raw)
    if (!profile) {
      return { profileId: String((args?.raw as { id?: string })?.id ?? '<unknown>'), ok: false, issues }
    }
    const inv = await probeBaseInventory()
    const refIssues = validateReferences(profile, toValidationContext(inv))
    const all = [...issues, ...refIssues]
    return { profileId: profile.id, ok: !all.some((i) => i.level === 'error'), issues: all }
  })

  /* ---------- 导入 ---------- */
  ipcMain.handle(ProfileChannel.Import, async (_e, args: { raw: unknown; activate?: boolean }) => {
    const { profile, issues } = parseImportedManifest(args?.raw)
    const profileId = String((args?.raw as { id?: string })?.id ?? '<unknown>')
    if (!profile) return { ok: false, issues }

    // 继承链 × 引用闭合（与正式激活同一套规则，避免「导入能过、激活挂掉」）
    const all = await listProfiles()
    const byId = (pid: string) => all.find((p) => p.id === pid) ?? null
    const { chain, issues: chainIssues } = resolveChain(profile, byId)
    const merged = flattenChain(chain)
    const inv = await probeBaseInventory()
    const refIssues = validateReferences(merged, toValidationContext(inv, all.map((p) => p.id)))
    const merged2 = [...chainIssues, ...refIssues]

    if (merged2.some((i) => i.level === 'error')) {
      return { ok: false, issues: [...issues, ...merged2] }
    }

    await upsertUserProfile(profile)
    logger.info('System', `[profile] imported ${profile.id} v${profile.version}`)
    if (args?.activate === false) return { ok: true, issues }
    const report = await activateProfile(profile.id)
    broadcastChanged(report.ok ? report.profileId : report.stillActiveProfileId ?? '', report.ok)
    return { ok: report.ok, report, issues }
  })

  /* ---------- 删除 ---------- */
  ipcMain.handle(ProfileChannel.Delete, async (_e, args: { id: string }) => {
    const id = String(args?.id ?? '')
    const res = await deleteUserProfile(id)
    if (res.ok) logger.info('System', `[profile] deleted ${id}`)
    return res.ok ? { ok: true } : { ...res, reason: res.reason ?? 'not-found' }
  })

  /* ---------- 插槽明细（可观测性） ---------- */
  ipcMain.handle(ProfileChannel.Slots, async () => {
    const out: Partial<Record<SlotKind, ReturnType<typeof resolveSlots>>> = {}
    for (const kind of listSlotKinds()) out[kind] = resolveSlots(kind)
    return out
  })
}

/**
 * 启动期挂载（幂等）：由 main/index.ts 在 IPC 注册后调用。
 * 失败只 warn —— 工作台挂不上也必须能进应用（用户至少还能手动切换）。
 *
 * ⚠️ v0.32.0 缺陷 D34 —— **每次进程启动都必须真重挂，禁止「快照已匹配就早退」**。
 *
 * 曾经的写法是：
 * ```ts
 * if (existing && existing.profileId === id) return   // ← 错的
 * ```
 * 它把「磁盘上有正确快照」误当成「运行时已装配」。但**插槽注册表是进程内内存态**
 * （`profile/slots.ts` 的模块级 `Map`），新进程里本来是空的。于是第二次及以后的
 * 每次启动都会：`activeProfileId` 说 `wb.coding` 已激活、UI 徽标显示 `wb.coding`、
 * 快照五层齐全 —— 而 agents / tools / ui.* / data / auto **一个插槽都没注册**。
 * 这正是「静默半死」：一切看起来都对，能力却全空挂。
 *
 * 为什么可以直接重挂：`activateProfile` 提交段的第一句就是 `resetProfileSlots()`
 * 再逐个重注册（`activator.ts:423-424`），本身就是幂等可重入的 —— 那个早退
 * 既无必要，也是本缺陷的唯一成因。
 *
 * 为什么 G1/G2 没暴露这条缺陷：它们读的是**磁盘快照**（`profile/store.ts` 的
 * `getLastSnapshot`），跨启动天然有效。所以「提示词里写了工作台、工具却不在」
 * 这种不一致可以长期存在而不报错 —— 只有插槽消费方才看得出。
 */
export async function bootstrapProfile(): Promise<void> {
  try {
    const id = await getActiveProfileId()
    const existing = await getLastSnapshot()
    // 不判早退：无条件重挂（见上方 D34 说明）
    const report = await activateProfile(id)
    if (!report.ok) {
      logger.warn(
        'System',
        `[profile] 启动挂载 ${id} 失败，仍可手动切换：${report.validation.issues.map((i) => i.message).join(' | ')}`,
      )
      // 保留原 activeId 不动；有旧快照才回写（没有就维持「无快照」，
      // 由下一次成功激活补写 —— 不拿失败报告的半成品快照污染磁盘）
      if (existing) await saveLastSnapshot(existing)
    } else {
      logger.info('System', `[profile] 启动挂载 ${report.profileId} ok（slots=${JSON.stringify(currentSlotStats())}）`)
    }
  } catch (err) {
    logger.error('System', `[profile] bootstrap failed: ${String(err)}`)
  }
}
