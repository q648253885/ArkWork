/* ============================================================
 * ArkWork — IPC: Workbench Profile（插件模式 · v0.32.0 / v0.33.0）
 * 设计文档 §8.4（通道表）+ docs/versions/v0.33.0/04-system-design.md §9.2
 *
 * v0.32.0 九通道：list / get-active / activate / snapshot / validate / import /
 *               delete / slots + 一条 main→renderer 广播 changed。
 * v0.33.0 新增五通道（配置能力）：import-file / update / clone / export / pick-file。
 *
 * 纪律：
 *  ① handler 只做「解析入参 → 调 profile/* → 组装返回」，不放业务逻辑；
 *  ② 失败不抛（除编程错误）—— 一律转成带原因的结果对象，让 UI 能逐条展示；
 *  ③ 切换成功后向所有窗口广播 `profile:changed`（多窗口一致性）；
 *  ④ **导入与更新走同一条校验管道**（`runImport`）—— 否则会出现
 *     「编辑能存、激活挂掉」这类只在用户点激活时才暴露的错。v0.33.0 起
 *     `import` / `import-file` / `update` / `clone` 全部复用它。
 * ============================================================ */
import { ipcMain, BrowserWindow, dialog } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, isAbsolute } from 'node:path'
import { ProfileChannel } from '@shared/types/ipc'
import type { ActivationReport, SlotKind, ValidationIssue, WorkbenchProfile } from '@shared/types/profile'
import {
  activateProfile,
  bootstrapActiveProfile,
  flattenChain,
  parseImportedManifest,
  probeBaseInventory,
  resolveChain,
  toValidationContext,
  currentSlotStats,
} from '../profile/activator.js'
import { summarize, validateReferences } from '@shared/utils/profile-manifest'
import { deleteUserProfile, getActiveProfileId, getLastSnapshot, getProfile, listProfiles, saveLastSnapshot, setActiveProfileId, upsertUserProfile } from '../profile/store.js'
import { resolveSlots, listSlotKinds } from '../profile/slots.js'
import { logger } from '../system/logger.js'

/** 向所有窗口推送切换事件（多窗口同源，避免只刷新一个窗） */
function broadcastChanged(profileId: string, ok: boolean): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(ProfileChannel.Changed, { profileId, ok })
  }
}

/** 把运行期对象还原为「可再解析的 manifest 字面量」（剥掉宿主填充的 `source`） */
function stripRuntime(p: WorkbenchProfile): Record<string, unknown> {
  const { source: _source, ...rest } = p
  return JSON.parse(JSON.stringify(rest)) as Record<string, unknown>
}

/** 浅层递归合并：对象递归、数组整体替换（编辑语义：给什么就是什么，不做元素级 diff） */
function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    const prev = out[k]
    if (v && typeof v === 'object' && !Array.isArray(v) && prev && typeof prev === 'object' && !Array.isArray(prev)) {
      out[k] = deepMerge(prev as Record<string, unknown>, v as Record<string, unknown>)
    } else {
      out[k] = v
    }
  }
  return out
}

/**
 * 唯一导入/更新管道：结构校验 → 继承链 × 引用闭合 → 落盘 → （可选）激活。
 * 导入与编辑共用它，杜绝「两条校验路径、两种通过标准」。
 */
async function runImport(
  raw: unknown,
  activate: boolean,
): Promise<{ ok: boolean; report?: ActivationReport; issues: ValidationIssue[] }> {
  const { profile, issues } = parseImportedManifest(raw)
  const profileId = String((raw as { id?: string })?.id ?? '<unknown>')
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
  logger.info('System', `[profile] saved ${profileId} v${profile.version}`)
  if (!activate) return { ok: true, issues }
  const report = await activateProfile(profile.id)
  broadcastChanged(report.ok ? report.profileId : report.stillActiveProfileId ?? '', report.ok)
  return { ok: report.ok, report, issues }
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

  /* ---------- 导入（JSON 字面量） ---------- */
  ipcMain.handle(ProfileChannel.Import, async (_e, args: { raw: unknown; activate?: boolean }) =>
    runImport(args?.raw, args?.activate !== false),
  )

  /* ---------- 导入（磁盘文件） ---------- */
  ipcMain.handle(ProfileChannel.ImportFile, async (_e, args: { path: string; activate?: boolean }) => {
    const fail = (message: string): { ok: boolean; issues: ValidationIssue[] } => ({
      ok: false,
      issues: [{ rule: 'V1', level: 'error', path: '$.<file>', message }],
    })
    const p = String(args?.path ?? '')
    // 守卫：只接受绝对路径 + 已存在 + `*.json`（防「把任意文件当 manifest 读」）
    if (!p || !isAbsolute(p)) return fail('导入路径必须是绝对路径')
    if (extname(p).toLowerCase() !== '.json') return fail('只接受 .json 文件')
    if (!existsSync(p)) return fail(`文件不存在：${p}`)
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(p, 'utf-8'))
    } catch (err) {
      return fail(`JSON 解析失败：${String(err)}`)
    }
    return runImport(raw, args?.activate !== false)
  })

  /* ---------- 增量更新（内置台需先克隆） ---------- */
  ipcMain.handle(ProfileChannel.Update, async (_e, args: { id: string; patch: Record<string, unknown> }) => {
    const id = String(args?.id ?? '')
    const existing = await getProfile(id)
    if (!existing) return { ok: false, issues: [] as ValidationIssue[], reason: 'not-found' as const }
    if (existing.source === 'builtin') return { ok: false, issues: [] as ValidationIssue[], reason: 'builtin' as const }
    const patch = (args?.patch ?? {}) as Record<string, unknown>
    // id 不允许被 patch 改走（要改 id 请用 clone）
    const raw = deepMerge(stripRuntime(existing), { ...patch, id })
    const res = await runImport(raw, true)
    if (!res.ok && !res.report) return { ...res, reason: 'invalid' as const }
    return res
  })

  /* ---------- 克隆（内置台 → 用户台的主路径） ---------- */
  ipcMain.handle(ProfileChannel.Clone, async (_e, args: { fromId: string; newId: string; newName?: string }) => {
    const fromId = String(args?.fromId ?? '')
    const newId = String(args?.newId ?? '')
    const src = await getProfile(fromId)
    if (!src) return { ok: false, issues: [] as ValidationIssue[], reason: 'not-found' as const }
    const all = await listProfiles()
    if (all.some((p) => p.id === newId)) return { ok: false, issues: [] as ValidationIssue[], reason: 'id-exists' as const }
    const raw = {
      ...stripRuntime(src),
      id: newId,
      name: String(args?.newName ?? '').trim() || `${src.name} 副本`,
    }
    const { profile, issues } = parseImportedManifest(raw)
    if (!profile) return { ok: false, issues, reason: 'invalid' as const }
    await upsertUserProfile(profile)
    logger.info('System', `[profile] cloned ${fromId} → ${newId}`)
    return { ok: true, profile: { ...profile, source: 'user' as const }, issues }
  })

  /* ---------- 导出（不给 targetPath 时只回字面量） ---------- */
  ipcMain.handle(ProfileChannel.Export, async (_e, args: { id: string; targetPath?: string }) => {
    const id = String(args?.id ?? '')
    const p = await getProfile(id)
    if (!p) return { ok: false, json: '', reason: 'not-found' as const }
    const json = JSON.stringify(stripRuntime(p), null, 2)
    const target = args?.targetPath
    if (!target) return { ok: true, json }
    if (!isAbsolute(target) || extname(target).toLowerCase() !== '.json') {
      return { ok: false, json, reason: 'invalid-path' as const }
    }
    try {
      writeFileSync(target, json, 'utf-8')
    } catch (err) {
      logger.warn('System', `[profile] export 写盘失败：${String(err)}`)
      return { ok: false, json, reason: 'write-failed' as const }
    }
    return { ok: true, path: target, json }
  })

  /* ---------- 原生文件选择器 ---------- */
  ipcMain.handle(ProfileChannel.PickFile, async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const filters = [{ name: 'Workbench Profile', extensions: ['json'] }]
    const res = win
      ? await dialog.showOpenDialog(win, { title: '选择工作台清单', properties: ['openFile'], filters })
      : await dialog.showOpenDialog({ title: '选择工作台清单', properties: ['openFile'], filters })
    if (res.canceled || res.filePaths.length === 0) return { path: null }
    const path = res.filePaths[0]
    // 顺带解析回传：让 renderer 走真正的干跑（validate）而不必自己读盘。
    // 读盘失败不抛错 —— 交给调用方展示 error。
    try {
      return { path, raw: JSON.parse(readFileSync(path, 'utf-8')) as unknown }
    } catch (err) {
      return { path, error: `读取或解析失败：${String(err)}` }
    }
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
    // v0.33.0：改走 bootstrapActiveProfile —— 把 ①登记内置插槽 ②装配 profile
    // ③刷新插件插槽 三步收敛到唯一入口，避免「插件插槽只在手动激活时才注册」。
    const report = await bootstrapActiveProfile()
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
