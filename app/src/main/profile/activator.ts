/* ============================================================
 * ArkWork — ProfileActivator：工作台装配器（v0.32.0）
 * 设计文档：docs/versions/v0.32.0/04-system-design.md §2.5 / §2.10
 *           正本 `workbench-profile-v1.0/02-概念模型与装配架构.md` §4–§5
 *
 * 一次激活 = 「解析继承 → 校验 → 装配 → 记账」的事务：
 *
 *   resolveChain(id)  §单继承链（深度≤2、禁环 V3）
 *        ↓
 *   mergeProfile()    父 → 子浅合并（shared/utils/profile-manifest.ts）
 *        ↓
 *   validate()        V1–V6；**required 项缺失 = error = 阻断**
 *        ↓
 *   compose()         五层落地：agents / tools / ui / data / auto
 *        ↓
 *   persist()         只有全部成功才写 activeProfileId + 快照
 *
 * 事务性（正本 02 §5 G3）：任何一步抛错 → **回滚到上一个 profile**，
 * 且回滚过程本身再失败也必须如实写进报告（不许假装成功了）。
 *
 * 「永不静默半死」（G5）：每一项没挂上的东西都要进 `degraded[]`，
 * 带 layer / ref / reason / blocking 四要素，由 UI 逐条可见。
 * ============================================================ */
import { MAX_EXTENDS_DEPTH, detectExtendsCycle, extendsDepthOf, mergeProfile, parseManifest, refResolves, refTail, stableHash, toReport, validateReferences } from '@shared/utils/profile-manifest'
import { DOCK_TAB_TO_INSPECTOR } from '@shared/utils/panel-model'
import {
  type ActivationReport,
  type CompositionSnapshot,
  type Degradation,
  type PanelSlotPayload,
  type ProfileValidationContext,
  type SlotEntry,
  type SnapshotTool,
  type SnapshotUi,
  type ValidationIssue,
  type WorkbenchProfile,
} from '@shared/types/profile'
import { listSkills } from '../agent/registry.js'
import { logger } from '../system/logger.js'
import { getActiveProfileId, getLastSnapshot, getProfile, listProfiles, saveLastSnapshot, setActiveProfileId } from './store.js'
import { ensureMemoryNamespace, namespaceSnapshotEntries } from './namespace.js'
import { BASE_NAMESPACE, builtinRendererSlotEntries } from './builtins.js'
import { registerSlot, resetProfileSlots, slotStats } from './slots.js'
import { availableHomeModules, availablePanelRefs, pluginPanelPayloads, refreshPluginSlots } from '../plugins/registry.js'

/* ---------- 底座版本（V6） ---------- */

/**
 * 当前底座版本。延迟 + try/catch 读取：
 * 单测环境里 electron 是 stub，`app.getVersion()` 可能不存在 —— 宁可返回
 * fallback 也不让激活器起不来（dep 注入优先级更高，见 `setVersionResolver`）。
 */
let versionResolver: () => string = () => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron') as { app?: { getVersion?: () => string } }
    const v = app?.getVersion?.()
    return typeof v === 'string' && v ? v : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** 测试与降级场景可注入版本解析器（避免单测依赖 electron stub 细节） */
export function setVersionResolver(fn: () => string): void {
  versionResolver = fn
}

/* ---------- 继承链解析（V3） ---------- */

export interface ChainResult {
  /** 叶子在前、根在后：[child, parent, grandparent] */
  chain: WorkbenchProfile[]
  issues: ValidationIssue[]
}

export function resolveChain(
  leaf: WorkbenchProfile,
  byId: (id: string) => WorkbenchProfile | null,
): ChainResult {
  const issues: ValidationIssue[] = []
  const chain: WorkbenchProfile[] = [leaf]
  const seenIds: string[] = [leaf.id]
  let cursor: WorkbenchProfile | undefined = leaf
  let hops = 0

  while (cursor?.extends) {
    const parentId = cursor.extends
    if (chain.length - 1 >= MAX_EXTENDS_DEPTH) {
      issues.push({
        rule: 'V3',
        level: 'error',
        path: '$.extends',
        message: `继承链深度超过上限 ${MAX_EXTENDS_DEPTH}（${seenIds.join(' → ')} → ${parentId}）`,
        fix: '拆多层继承为更浅的链，或把父台内容复制到子台',
      })
      break
    }
    const parent = byId(parentId)
    if (!parent) {
      issues.push({
        rule: 'V3',
        level: 'error',
        path: '$.extends',
        message: `父工作台 ${parentId} 不存在`,
        fix: '安装该工作台，或去掉 extends 字段',
      })
      break
    }
    seenIds.push(parentId)
    if (detectExtendsCycle(seenIds)) {
      issues.push({
        rule: 'V3',
        level: 'error',
        path: '$.extends',
        message: `继承链成环：${seenIds.join(' → ')}`,
        fix: '断开环：让某一层不再 extends',
      })
      break
    }
    chain.push(parent)
    cursor = parent
    hops += 1
  }

  if (hops <= MAX_EXTENDS_DEPTH && extendsDepthOf(seenIds) > MAX_EXTENDS_DEPTH) {
    issues.push({
      rule: 'V3',
      level: 'error',
      path: '$.extends',
      message: `继承链跳数 ${extendsDepthOf(seenIds)} 超过上限 ${MAX_EXTENDS_DEPTH}`,
      fix: '减少继承层数',
    })
  }
  return { chain, issues }
}

/** 链合并：父在前逐层被子覆盖（chain[0] 是叶子） */
export function flattenChain(chain: WorkbenchProfile[]): WorkbenchProfile {
  let merged: WorkbenchProfile | null = null
  for (let i = chain.length - 1; i >= 0; i--) {
    merged = mergeProfile(merged, chain[i]!)
  }
  return merged!
}

/* ---------- 装配上下文 ---------- */

export interface BaseInventory {
  skills: string[]
  mcpServers: string[]
  baseVersion: string
}

/**
 * 查询底座实际有什么（V2 引用闭合的事实源）。
 * 失败不阻断：技能列表读不出来时退化为空数组 —— 这会让所有技能引用被判
 * 「未安装」，必需要求（required:true）随之阻断激活并给出明确原因，
 * 比假装激活成功更符合「不静默半死」。
 */
export async function probeBaseInventory(): Promise<BaseInventory> {
  let skills: string[] = []
  let mcpServers: string[] = []
  try {
    const list = await listSkills()
    skills = list.map((s: { id: string }) => s.id)
    mcpServers = list.filter((s: { source?: string; id: string }) => s.source === 'mcp').map((s: { id: string }) => s.id)
  } catch (err) {
    logger.warn('System', `[profile] probeBaseInventory failed: ${String(err)}`)
  }
  return { skills, mcpServers, baseVersion: versionResolver() }
}

export function toValidationContext(
  inv: BaseInventory,
  siblingProfileIds?: string[],
  extra?: { panels?: string[]; homeModules?: string[] },
): ProfileValidationContext {
  return {
    skills: inv.skills,
    mcpServers: inv.mcpServers,
    baseVersion: inv.baseVersion,
    siblingProfileIds,
    ...(extra?.panels !== undefined ? { panels: extra.panels } : {}),
    ...(extra?.homeModules !== undefined ? { homeModules: extra.homeModules } : {}),
  }
}

/**
 * 面板解析上下文（★ v0.33.0）。
 *
 * 缺陷 D43 的修复核心：v0.32.0 的 `capabilities[].type === 'panel'` **恒降级**
 * （硬编码「v1 只登记不挂载」），导致声明 required 面板的工作台永远激活不了。
 * 现在由插件注册表提供事实源：命中 → 不降级；未命中 → 按 required 阻断/降级。
 */
export interface ComposePanels {
  /** `panel:<name>` → 插件贡献的面板载荷 */
  payloads: Map<string, PanelSlotPayload>
  /** 全部可用面板 ref（含内置六面板的裸名与 `panel:` 形式） */
  available: Set<string>
}

const EMPTY_PANELS: ComposePanels = { payloads: new Map(), available: new Set() }

/* ---------- 五层装配 ---------- */

export interface ComposeResult {
  snapshot: CompositionSnapshot
  degraded: Degradation[]
  slots: SlotEntry[]
}

export function composeProfile(
  profile: WorkbenchProfile,
  inv: BaseInventory,
  nsApplied: boolean,
  panels: ComposePanels = EMPTY_PANELS,
): ComposeResult {
  const degraded: Degradation[] = []
  const slots: SlotEntry[] = []
  const now = Date.now()

  /* --- agents 层 --- */
  const agents = profile.agents.map((a) => ({
    id: a.id,
    name: a.name,
    personaHash: stableHash(a.personaText ?? a.personaRef ?? `${a.id}@${profile.id}`),
    defaultForNewTasks: a.defaultForNewTasks === true,
    skills: a.skills ?? [],
  }))
  for (const a of profile.agents) {
    slots.push({
      id: `agent:${a.id}`,
      kind: 'agent',
      label: a.name,
      source: 'profile',
      payload: { agentId: a.id, personaText: a.personaText, profileId: profile.id },
    })
  }

  /* --- tools 层（capabilities + agents[].skills） --- */
  const skillRefs = new Map<string, { required: boolean; from: 'capability' | 'agent' }>()
  for (const c of profile.capabilities) {
    if (c.type === 'skill') skillRefs.set(refTail(c.ref), { required: c.required === true, from: 'capability' })
  }
  for (const a of profile.agents) {
    for (const s of a.skills ?? []) {
      if (!skillRefs.has(refTail(s))) skillRefs.set(refTail(s), { required: false, from: 'agent' })
    }
  }
  const tools: SnapshotTool[] = Array.from(skillRefs.entries()).map(([tail, meta]) => {
    const found = refResolves(tail, inv.skills)
    if (!found) {
      degraded.push({
        layer: 'tools',
        ref: tail,
        reason: meta.required ? '必需技能未安装' : '技能未安装',
        blocking: meta.required,
      })
    }
    return { kind: 'skill' as const, ref: tail, found, required: meta.required }
  })
  // mcp 能力（连接已由 mcp 模块管理，这里只登记 + 降级核实）
  for (const c of profile.capabilities) {
    if (c.type !== 'mcp') continue
    const tail = refTail(c.ref)
    const found = refResolves(c.ref, inv.mcpServers)
    if (!found) {
      degraded.push({
        layer: 'tools',
        ref: tail,
        reason: c.required ? '必需 MCP server 未连接' : 'MCP server 未连接',
        blocking: c.required === true,
      })
    }
    tools.push({ kind: 'mcp', ref: tail, found, required: c.required === true })
    slots.push({
      id: `tool:mcp:${tail}`,
      kind: 'tool',
      label: tail,
      source: 'profile',
      payload: { mcpServer: tail, profileId: profile.id },
    })
  }
  /* --- panel 能力：★ v0.33.0 真解析（缺陷 D43） ---
   * v0.32.0 此处无条件 push 一条「只登记不挂载」降级 → 声明 required 面板的台
   * 永远激活不了。现在查插件面板注册表：命中即视为已就绪（是否**显示**由
   * `ui.dockPanels` 决定），未命中才按 required 决定阻断/降级。 */
  for (const c of profile.capabilities) {
    if (c.type !== 'panel') continue
    const ref = c.ref.includes(':') ? c.ref : `panel:${c.ref}`
    if (panels.available.has(ref) || panels.available.has(refTail(c.ref))) {
      continue
    }
    degraded.push({
      layer: 'ui',
      ref: refTail(c.ref),
      reason: '面板未安装或未启用（在工作台中心的「插件」页启用提供该面板的插件）',
      blocking: c.required === true,
    })
  }
  for (const s of skillRefs.keys()) {
    slots.push({
      id: `tool:skill:${s}`,
      kind: 'tool',
      label: s,
      source: 'profile',
      payload: { skillId: s, profileId: profile.id },
    })
  }

  /* --- ui 层 --- */
  const themeTokens = profile.ui.theme ?? {}
  const previewRenderers = Object.entries(profile.ui.previewRenderers ?? {})
  const actionExts = profile.ui.actionExtensions ?? []
  const ui: SnapshotUi[] = [
    {
      slot: 'ui.dockTabs',
      value: (profile.ui.dockTabs ?? []).join(','),
      applied: (profile.ui.dockTabs ?? []).length > 0,
    },
    {
      slot: 'ui.dockPanels',
      value: (profile.ui.dockPanels ?? []).map((d) => d.panelRef).join(','),
      applied: (profile.ui.dockPanels ?? []).length > 0,
    },
    { slot: 'ui.homeModule', value: profile.ui.homeModule ?? '', applied: Boolean(profile.ui.homeModule) },
    {
      slot: 'ui.composerChips',
      value: (profile.ui.composerChips ?? []).join(','),
      applied: (profile.ui.composerChips ?? []).length > 0,
    },
    {
      slot: 'ui.theme',
      value: [...Object.keys(themeTokens.light ?? {}), ...Object.keys(themeTokens.dark ?? {})].join(','),
      applied: Object.keys(themeTokens.light ?? {}).length + Object.keys(themeTokens.dark ?? {}).length > 0,
    },
    {
      slot: 'ui.previewRenderers',
      value: previewRenderers.map(([k, v]) => `${k}=${v}`).join(','),
      applied: previewRenderers.length > 0,
    },
    {
      slot: 'ui.actionExtensions',
      value: actionExts.join(','),
      applied: actionExts.length > 0,
    },
  ]

  /* --- ui.panel：内置面板（来自 dockTabs）+ 开放面板（来自 dockPanels） ---
   * 去重：同一 panelRef 只产一条（dockPanels 的存在使内置项不必重复） */
  const panelRefsDone = new Set<string>()
  const pushPanelEntry = (ref: string, position: number | undefined): void => {
    if (panelRefsDone.has(ref)) return
    const normalized = ref.includes(':') ? ref : `panel:${ref}`
    if (panelRefsDone.has(normalized)) return

    const builtinDock = (Object.entries(DOCK_TAB_TO_INSPECTOR) as Array<[string, string]>).find(
      ([dockId]) => `panel:${dockId}` === normalized || dockId === ref,
    )
    if (builtinDock) {
      panelRefsDone.add(ref)
      panelRefsDone.add(normalized)
      slots.push({
        id: normalized,
        kind: 'ui.panel',
        label: builtinDock[1],
        source: 'profile',
        ...(position !== undefined ? { position } : {}),
        payload: { panelRef: normalized, title: builtinDock[1], builtin: true },
      })
      return
    }

    const payload = panels.payloads.get(normalized)
    if (payload) {
      panelRefsDone.add(ref)
      panelRefsDone.add(normalized)
      slots.push({
        id: normalized,
        kind: 'ui.panel',
        label: payload.title,
        source: 'profile',
        ...(position !== undefined ? { position } : {}),
        payload: { ...payload, profileId: profile.id },
      })
      return
    }

    // 未命中 → 降级（不产条目）；`required` 语义由 capabilities 负责，
    // `dockPanels` 里的缺失一律非阻断（用户可在编辑器里删掉这一项）
    degraded.push({
      layer: 'ui',
      ref: refTail(normalized),
      reason: '面板未安装或未启用（在工作台中心的「插件」页启用提供该面板的插件）',
      blocking: false,
    })
  }

  for (const t of profile.ui.dockTabs ?? []) pushPanelEntry(t, undefined)
  for (const d of profile.ui.dockPanels ?? []) pushPanelEntry(d.panelRef, d.position)

  /* --- ui.homeModule --- */
  if (profile.ui.homeModule) {
    slots.push({
      id: `homeModule:${profile.ui.homeModule}`,
      kind: 'ui.homeModule',
      label: profile.ui.homeModule,
      source: 'profile',
      payload: { module: profile.ui.homeModule, profileId: profile.id },
    })
  }

  /* --- ui.action：chips 与动作扩展分开登记（缺陷 D45：语义不再污染） --- */
  ;(profile.ui.composerChips ?? []).forEach((chip, i) => {
    slots.push({
      id: `action:chip:${i}`,
      kind: 'ui.action',
      label: chip,
      source: 'profile',
      position: 100 + i,
      payload: { actionId: `chip:${i}`, label: chip, origin: 'chip' },
    })
  })
  actionExts.forEach((a, i) => {
    slots.push({
      id: `action:${a}`,
      kind: 'ui.action',
      label: a,
      source: 'profile',
      position: 200 + i,
      payload: { actionId: a, label: a, origin: `profile:${profile.id}` },
    })
  })

  /* --- ui.renderer：previewRenderers 覆盖声明（每个扩展名一条） --- */
  previewRenderers.forEach(([ext, kind], i) => {
    slots.push({
      id: `renderer:${ext}`,
      kind: 'ui.renderer',
      label: ext,
      source: 'profile',
      position: 1000 + i,
      payload: { rendererKind: kind, extensions: [ext], override: true, labelKey: `preview.registry.${kind}` },
    })
  })

  /* --- ui.theme：token 覆盖（空集不产条目 —— 避免无谓的样式重算） --- */
  if (Object.keys(themeTokens.light ?? {}).length + Object.keys(themeTokens.dark ?? {}).length > 0) {
    slots.push({
      id: `theme:${profile.id}`,
      kind: 'ui.theme',
      label: profile.name,
      source: 'profile',
      payload: { light: themeTokens.light ?? {}, dark: themeTokens.dark ?? {}, profileId: profile.id },
    })
  }

  /* --- data 层 --- */
  const ns = profile.data.memoryNamespace || BASE_NAMESPACE
  const data = namespaceSnapshotEntries(ns, profile.data.shareCoreProfile !== false).map((e) => ({
    key: e.key,
    value: e.value,
    applied: nsApplied ? e.applied : false,
  }))
  if (!nsApplied) {
    degraded.push({ layer: 'data', ref: ns, reason: '记忆命名空间目录未就绪', blocking: false })
  }
  slots.push({
    id: `data:ns:${ns}`,
    kind: 'data',
    label: ns,
    source: 'profile',
    payload: { namespace: ns, shareCore: profile.data.shareCoreProfile !== false, profileId: profile.id },
  })

  /* --- auto 层（本版只登记不注册 → 遗留 L-33-07） --- */
  const auto = profile.automation.map((a) => ({ cron: a.cron, taskTemplate: a.taskTemplate, agent: a.agent, registered: false as const }))
  for (const a of profile.automation) {
    const required = (a as { required?: boolean }).required === true
    degraded.push({
      layer: 'auto',
      ref: a.cron,
      reason: '定时任务本版只登记不注册（automation 模块尚未开放 profile 来源）',
      blocking: false,
    })
    slots.push({
      id: `auto:${a.cron}`,
      kind: 'auto',
      label: a.cron,
      source: 'profile',
      payload: { cron: a.cron, taskTemplate: a.taskTemplate, agent: a.agent, required },
    })
  }

  return {
    snapshot: {
      profileId: profile.id,
      profileVersion: profile.version,
      resolvedAt: now,
      layers: { agents, tools, ui, data, auto },
      degraded,
    },
    degraded,
    slots,
  }
}

/* ============================================================
 * 激活主流程
 * ============================================================ */

/** 当前生效的事実只认 store；本模块不缓存 activeId（避免与主进程双源不同步） */
export async function activateProfile(id: string): Promise<ActivationReport> {
  const startedAt = Date.now()
  const stillActive = await getActiveProfileId()

  const fail = (issues: ValidationIssue[], note?: string): ActivationReport => ({
    ok: false,
    profileId: id,
    resolvedAt: Date.now(),
    validation: toReport(id, issues),
    degraded: [],
    stillActiveProfileId: stillActive,
    durationMs: Date.now() - startedAt,
    ...(note ? { validation: { profileId: id, ok: false, issues: [...issues, { rule: 'V1', level: 'error', path: '$', message: note }] } } : {}),
  })

  // 1) 取 manifest
  const all = await listProfiles()
  const leaf = all.find((p) => p.id === id) ?? null
  if (!leaf) {
    return fail([{ rule: 'V1', level: 'error', path: '$.id', message: `工作台 ${id} 不存在`, fix: '从列表里选一个已安装的工作台' }])
  }

  // 2) 继承链 + 合并
  const byId = (pid: string) => all.find((p) => p.id === pid) ?? null
  const { chain, issues: chainIssues } = resolveChain(leaf, byId)
  const profile = flattenChain(chain)
  const structuralIssues = [...chainIssues, ...validatePureStructure(profile)]

  // 3) 引用闭合（V2/V4/V5/V6）—— 事实源：底座存货 + 插件注册表
  const inv = await probeBaseInventory()
  const [panelMap, panelRefs, homeModules] = await Promise.all([
    pluginPanelPayloads(),
    availablePanelRefs(),
    availableHomeModules(),
  ])
  const panelsCtx: ComposePanels = { payloads: panelMap, available: new Set(panelRefs) }
  const refIssues = validateReferences(
    profile,
    toValidationContext(inv, all.map((p) => p.id), { panels: panelRefs, homeModules }),
  )
  const issues = [...structuralIssues, ...refIssues]
  const validation = toReport(id, issues)

  if (!validation.ok) {
    logger.warn('System', `[profile] activate ${id} 被校验阻断：${issues.filter((i) => i.level === 'error').map((i) => i.message).join(' | ')}`)
    return {
      ok: false,
      profileId: id,
      resolvedAt: Date.now(),
      validation,
      degraded: [],
      stillActiveProfileId: stillActive,
      durationMs: Date.now() - startedAt,
    }
  }

  // 4) 装配 —— data 层先落地（目录就绪失败不阻断，只降级）
  let nsApplied = true
  try {
    ensureMemoryNamespace(profile.data.memoryNamespace || BASE_NAMESPACE)
  } catch (err) {
    nsApplied = false
    logger.warn('System', `[profile] ns ensure failed: ${String(err)}`)
  }
  const composed = composeProfile(profile, inv, nsApplied, panelsCtx)

  // 5) required 缺失 → 阻断（required 语义：宁可激活失败，也不半死）
  const blockers = composed.degraded.filter((d) => d.blocking)
  if (blockers.length > 0) {
    logger.warn('System', `[profile] activate ${id} 部分激活失败：${blockers.map((b) => `${b.ref}(${b.reason})`).join(' | ')}`)
    return {
      ok: false,
      profileId: id,
      resolvedAt: Date.now(),
      validation,
      snapshot: composed.snapshot,
      degraded: composed.degraded,
      stillActiveProfileId: stillActive,
      durationMs: Date.now() - startedAt,
    }
  }

  // 6) 提交：清 profile 来源 → 重注册 → 落盘（任一步失败都要回滚）
  const prevSnapshot = await getLastSnapshot()
  try {
    applyProfileSlots(composed.slots)
    await saveLastSnapshot(composed.snapshot)
    await setActiveProfileId(profile.id, composed.snapshot)
    logger.info(
      'System',
      `[profile] activated ${profile.id} v${profile.version}（agents=${composed.snapshot.layers.agents.length} tools=${composed.snapshot.layers.tools.length} slots=${composed.slots.length} degraded=${composed.degraded.length}）`,
    )
    return {
      ok: true,
      profileId: profile.id,
      resolvedAt: composed.snapshot.resolvedAt,
      validation,
      snapshot: composed.snapshot,
      degraded: composed.degraded,
      stillActiveProfileId: profile.id,
      durationMs: Date.now() - startedAt,
    }
  } catch (err) {
    // 回滚：把上一个 profile 重新挂回（尽力而为，失败也要写进报告）
    let rollbackNote = ''
    try {
      const prev = await getProfile(stillActive)
      if (prev) {
        const prevInv = await probeBaseInventory()
        const prevPanelMap = await pluginPanelPayloads()
        const prevPanelRefs = await availablePanelRefs()
        const prevComposed = composeProfile(prev, prevInv, true, {
          payloads: prevPanelMap,
          available: new Set(prevPanelRefs),
        })
        applyProfileSlots(prevComposed.slots)
        await saveLastSnapshot(prevSnapshot ?? prevComposed.snapshot)
        await setActiveProfileId(prev.id, prevSnapshot ?? prevComposed.snapshot)
        rollbackNote = `已回滚到 ${prev.id}`
      }
    } catch (rollbackErr) {
      rollbackNote = `回滚失败：${String(rollbackErr)}`
      logger.error('System', `[profile] rollback failed: ${String(rollbackErr)}`)
    }
    logger.error('System', `[profile] activate ${id} 提交阶段失败：${String(err)}；${rollbackNote}`)
    return {
      ok: false,
      profileId: id,
      resolvedAt: Date.now(),
      validation: {
        profileId: id,
        ok: false,
        issues: [
          ...issues,
          {
            rule: 'V1',
            level: 'error',
            path: '$.commit',
            message: `装配提交失败：${String(err)}${rollbackNote ? `（${rollbackNote}）` : ''}`,
            fix: '查看日志定位注册冲突；当前仍生效的是上一个工作台',
          },
        ],
      },
      degraded: composed.degraded,
      stillActiveProfileId: stillActive,
      durationMs: Date.now() - startedAt,
    }
  }
}

/** 合并后的结果仍需过一遍结构自检（合并可能产出空 data / 空 id） */
function validatePureStructure(p: WorkbenchProfile): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (!p.data.memoryNamespace) {
    issues.push({
      rule: 'V1',
      level: 'error',
      path: '$.data.memoryNamespace',
      message: '合并后 memoryNamespace 为空（继承链上没有任何一层提供）',
      fix: '在任一继承层补 data.memoryNamespace',
    })
  }
  return issues
}

/* ============================================================
 * 插槽提交与内置登记（★ v0.33.0）
 * ============================================================ */

/**
 * 把一份装配快照的条目落到插槽表：**只清 `profile` 来源**（缺陷 D42）。
 *
 * 为什么逐条 try/catch 而不是整体失败：单个条目注册冲突（例如插件已占用同 id）
 * 不该让整次切换失败 —— 失败项由调用方日志可见，其余条目照常生效，
 * 这与「部分激活不阻塞」的既有精神一致。
 */
export function applyProfileSlots(entries: SlotEntry[]): number {
  resetProfileSlots('profile')
  let n = 0
  for (const s of entries) {
    try {
      registerSlot(s.kind, s, 'profile')
      n += 1
    } catch (err) {
      logger.warn('System', `[profile] 插槽注册失败（${s.kind} ${s.id}）：${String(err)}`)
    }
  }
  return n
}

let builtinSlotsInstalled = false

/**
 * 登记**内置**插槽条目（来源 `builtin`）。
 *
 * 幂等：重复调用直接返回（`registerSlot` 对同来源同 id 会 throw —— 那是「启动期
 * 编程错误」的守卫，不该被幂等性要求破坏）。启动期在 `bootstrapActiveProfile`
 * 里调一次即可；测试可先 `resetProfileSlots()` 再调。
 */
export function ensureBuiltinSlots(): number {
  if (builtinSlotsInstalled) return 0
  const entries = builtinRendererSlotEntries()
  let n = 0
  for (const e of entries) {
    try {
      registerSlot(e.kind, e, 'builtin')
      n += 1
    } catch (err) {
      logger.warn('System', `[profile] 内置插槽注册失败（${e.kind} ${e.id}）：${String(err)}`)
    }
  }
  builtinSlotsInstalled = true
  logger.info('System', `[profile] 内置插槽登记：${n} 条（ui.renderer）`)
  return n
}

/** 测试用：重置「内置已登记」标记（配合 `resetProfileSlots()`） */
export function resetBuiltinSlotFlag(): void {
  builtinSlotsInstalled = false
}

/**
 * 启动期：把持久化下来的 activeProfileId 重新挂起来（幂等）。
 *
 * 顺序固定（`04-system-design.md` §4.4）：
 *   ① 内置插槽（builtin 来源）
 *   ② 装配当前 profile（profile 来源）
 *   ③ 插件贡献（plugin 来源）
 * 三者来源隔离，顺序固定的意义只是**消除不确定性**。
 */
export async function bootstrapActiveProfile(): Promise<ActivationReport> {
  ensureBuiltinSlots()
  const id = await getActiveProfileId()
  const report = await activateProfile(id)
  try {
    await refreshPluginSlots()
  } catch (err) {
    logger.warn('System', `[profile] 插件插槽刷新失败：${String(err)}`)
  }
  return report
}

/** 可观测性：当前插槽注册量（诊断面板 / 测试用） */
export function currentSlotStats(): Record<string, number> {
  return slotStats()
}

/** 从 JSON 字面量解析（导入走） */
export function parseImportedManifest(raw: unknown) {
  return parseManifest(raw, 'user')
}
