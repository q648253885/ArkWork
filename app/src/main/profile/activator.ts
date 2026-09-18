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
import {
  type ActivationReport,
  type CompositionSnapshot,
  type Degradation,
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
import { registerSlot, resetProfileSlots, slotStats } from './slots.js'
import { BASE_NAMESPACE } from './builtins.js'

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

export function toValidationContext(inv: BaseInventory, siblingProfileIds?: string[]): ProfileValidationContext {
  return {
    skills: inv.skills,
    mcpServers: inv.mcpServers,
    baseVersion: inv.baseVersion,
    siblingProfileIds,
  }
}

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
  // mcp 能力（v1：连接已由 mcp 模块管理，这里只登记 + 降级核实）
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
      payload: { mcpServer: tail, profileId: profile.id },
    })
  }
  // panel 能力：v1 只登记不挂载（宿主垂直组件库未开放 → 一律降级，绝不假装生效）
  for (const c of profile.capabilities) {
    if (c.type !== 'panel') continue
    degraded.push({
      layer: 'ui',
      ref: refTail(c.ref),
      reason: '面板插件在 v1 只登记不挂载（宿主垂直组件库尚未开放）',
      blocking: c.required === true,
    })
  }
  for (const s of skillRefs.keys()) {
    slots.push({
      id: `tool:skill:${s}`,
      kind: 'tool',
      label: s,
      payload: { skillId: s, profileId: profile.id },
    })
  }

  /* --- ui 层 --- */
  const ui: SnapshotUi[] = [
    {
      slot: 'ui.dockTabs',
      value: (profile.ui.dockTabs ?? []).join(','),
      applied: (profile.ui.dockTabs ?? []).length > 0,
    },
    { slot: 'ui.homeModule', value: profile.ui.homeModule ?? '', applied: Boolean(profile.ui.homeModule) },
    {
      slot: 'ui.composerChips',
      value: (profile.ui.composerChips ?? []).join(','),
      applied: (profile.ui.composerChips ?? []).length > 0,
    },
  ]
  for (const t of profile.ui.dockTabs ?? []) {
    slots.push({ id: `ui.panel:${t}`, kind: 'ui.panel', label: t, payload: { tabId: t, profileId: profile.id } })
  }
  if (profile.ui.homeModule) {
    slots.push({
      id: `ui.homeModule:${profile.ui.homeModule}`,
      kind: 'ui.homeModule',
      label: profile.ui.homeModule,
      payload: { module: profile.ui.homeModule, profileId: profile.id },
    })
  }
  ;(profile.ui.composerChips ?? []).forEach((chip, i) => {
    slots.push({ id: `ui.action:chip:${i}`, kind: 'ui.action', label: chip, payload: { chip, profileId: profile.id }, position: 100 + i })
  })

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
  slots.push({ id: `data:ns:${ns}`, kind: 'data', label: ns, payload: { namespace: ns, profileId: profile.id } })

  /* --- auto 层（v1 只登记不注册 → 遗留 L5） --- */
  const auto = profile.automation.map((a) => ({ cron: a.cron, taskTemplate: a.taskTemplate, agent: a.agent, registered: false as const }))
  for (const a of profile.automation) {
    degraded.push({
      layer: 'auto',
      ref: a.cron,
      reason: '定时任务在 v1 只登记不注册（automation 模块尚未开放 profile 来源）',
      blocking: false,
    })
    slots.push({ id: `auto:${a.cron}`, kind: 'auto', label: a.cron, payload: { cron: a.cron, profileId: profile.id } })
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

  // 3) 引用闭合（V2/V4/V5/V6）
  const inv = await probeBaseInventory()
  const refIssues = validateReferences(profile, toValidationContext(inv, all.map((p) => p.id)))
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
  const composed = composeProfile(profile, inv, nsApplied)

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

  // 6) 提交：清槽 → 重注册 → 落盘（任一步失败都要回滚）
  const prevSnapshot = await getLastSnapshot()
  try {
    resetProfileSlots()
    for (const s of composed.slots) registerSlot(s.kind, s)
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
        resetProfileSlots()
        const prevInv = await probeBaseInventory()
        const prevComposed = composeProfile(prev, prevInv, true)
        for (const s of prevComposed.slots) registerSlot(s.kind, s)
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

/** 启动期：把持久化下来的 activeProfileId 重新挂起来（幂等） */
export async function bootstrapActiveProfile(): Promise<ActivationReport> {
  const id = await getActiveProfileId()
  return activateProfile(id)
}

/** 可观测性：当前插槽注册量（诊断面板 / 测试用） */
export function currentSlotStats(): Record<string, number> {
  return slotStats()
}

/** 从 JSON 字面量解析（导入走） */
export function parseImportedManifest(raw: unknown) {
  return parseManifest(raw, 'user')
}
