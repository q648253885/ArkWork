/* ============================================================
 * ArkWork — Workbench Profile manifest 纯函数层（v0.32.0）
 * 设计文档：docs/versions/v0.32.0/04-system-design.md §2.3 / §2.4
 *           正本 `workbench-profile-v1.0/03-Profile-Manifest规范.md` §4–§6
 *
 * 为什么独立成纯模块：`renderer/store/slices/*` 顶层读 `import.meta.env`，
 * node:test 无法导入；主进程模块又拖 electron 依赖。**解析/合并/校验必须
 * 零依赖纯函数**，才能被密闭单测逐条把守（沿用 `store/derive-conversation.ts`
 * / `store/settle.ts` / `shared/utils/flow-fold.ts` 的同一先例）。
 *
 * 覆盖校验规则：V1 结构 · V2 引用闭合 · V3 继承无环+深度 · V4 内部闭合 ·
 *              V5 插槽冲突 · V6 底座版本
 * ============================================================ */
import {
  PROFILE_DOCK_TABS,
  PROFILE_HOME_MODULES,
  PROFILE_SCHEMA_VERSION,
  type CompositionSnapshot,
  type ProfileAgentDecl,
  type ProfileAutoDecl,
  type ProfileCapabilityDecl,
  type ProfileDockPanelDecl,
  type ProfileRequirements,
  type ProfileSource,
  type ProfileUiDecl,
  type ProfileValidationContext,
  type ValidationIssue,
  type WorkbenchProfile,
} from '@shared/types/profile'
import { isRendererKind } from '@shared/types/vlib'
import { sanitizeThemeTokens } from './theme-tokens.js'

/** 继承链深度上限（= 允许的 extends 跳数；链长即认知负担） */
export const MAX_EXTENDS_DEPTH = 2

/** agent id 规则：`@` 开头 + 字母数字/连字符/下划线 */
const AGENT_ID_RE = /^@[A-Za-z0-9_-]+$/
/** profile id 规则：命名空间.名称 */
const PROFILE_ID_RE = /^[a-z0-9-]+\.[a-z0-9-]+$/
/** 记忆命名空间规则 */
const NAMESPACE_RE = /^[a-z0-9_-]{1,32}$/
/** 五段 cron 粗校验（分 时 日 月 周） */
const CRON_RE = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0

function issue(
  rule: ValidationIssue['rule'],
  level: ValidationIssue['level'],
  path: string,
  message: string,
  fix?: string,
): ValidationIssue {
  return { rule, level, path, message, fix }
}

/* ============================================================
 * 语义化版本比较（V6）
 * ============================================================ */

/** '1.2.3' → [1,2,3]（缺段按 0；非法段按 0，绝不抛） */
export function parseSemver(v: string): [number, number, number] {
  const parts = String(v ?? '')
    .trim()
    .split('.')
    .slice(0, 3)
    .map((p) => {
      const n = Number.parseInt(p, 10)
      return Number.isFinite(n) && n >= 0 ? n : 0
    })
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
}

/** base >= min ? （任一侧非法 → false，宁可阻断也不放行） */
export function meetsMinVersion(base: string, min: string): boolean {
  if (!isStr(base) || !isStr(min)) return false
  const a = parseSemver(base)
  const b = parseSemver(min)
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true
    if (a[i] < b[i]) return false
  }
  return true
}

/** 稳定的短哈希（FNV-1a 32bit → 8 位十六进制）—— persona 可追溯且跨平台一致 */
export function stableHash(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/* ============================================================
 * 引用归一化（manifest 的 'skill:x' 与底座裸 id 'x' 双向兼容）
 * ============================================================ */

/** 取引用尾部（'skill:x' → 'x'；无冒号则原样）—— 跨 type 归并与管理のため对外暴露 */
export function refTail(ref: string): string {
  const i = ref.indexOf(':')
  return i >= 0 ? ref.slice(i + 1) : ref
}

function refKind(ref: string): string {
  const i = ref.indexOf(':')
  return i >= 0 ? ref.slice(0, i) : ''
}

/** 判断能力引用是否在给定底数据集里命中（前缀与裸 id 都算命中） */
export function refResolves(ref: string, available: string[]): boolean {
  if (!isStr(ref)) return false
  const tail = refTail(ref)
  for (const a of available) {
    if (a === ref || a === tail || refTail(a) === tail) return true
  }
  return false
}

/* ============================================================
 * V1：结构校验 + 缺省值填充（JSON → 内存形态）
 * ============================================================ */

export interface ParseResult {
  profile: WorkbenchProfile | null
  issues: ValidationIssue[]
}

export function parseManifest(raw: unknown, source: ProfileSource): ParseResult {
  const issues: ValidationIssue[] = []

  if (!isObj(raw)) {
    issues.push(
      issue('V1', 'error', '$', 'manifest 必须是一个 JSON 对象', '检查文件是否被截断或少了外层大括号'),
    )
    return { profile: null, issues }
  }

  // ---- schemaVersion ----
  let schemaVersion = PROFILE_SCHEMA_VERSION
  if (!isStr(raw.schemaVersion)) {
    issues.push(
      issue('V1', 'warning', '$.schemaVersion', `缺少 schemaVersion，按当前版本 ${PROFILE_SCHEMA_VERSION} 处理`, `补 "schemaVersion": "${PROFILE_SCHEMA_VERSION}"`),
    )
  } else if (raw.schemaVersion !== PROFILE_SCHEMA_VERSION) {
    issues.push(
      issue('V1', 'error', '$.schemaVersion', `schemaVersion 为 ${String(raw.schemaVersion)}，底座仅支持 ${PROFILE_SCHEMA_VERSION}`, `改为 "${PROFILE_SCHEMA_VERSION}"（或升级底座）`),
    )
    schemaVersion = String(raw.schemaVersion)
  }

  // ---- id ----
  let id = ''
  if (!isStr(raw.id)) {
    issues.push(issue('V1', 'error', '$.id', 'id 必填且为非空字符串', '例如 "wb.coding"'))
  } else if (!PROFILE_ID_RE.test(raw.id)) {
    issues.push(
      issue('V1', 'error', '$.id', `id "${raw.id}" 不符合「命名空间.名称」格式（小写字母/数字/连字符）`, '例如 "wb.coding"'),
    )
  } else {
    id = raw.id
  }

  // ---- name / version ----
  if (!isStr(raw.name)) issues.push(issue('V1', 'error', '$.name', 'name 必填且为非空字符串'))
  if (!isStr(raw.version)) {
    issues.push(issue('V1', 'error', '$.version', 'version 必填且为非空字符串', '例如 "1.0.0"'))
  }

  // ---- data ----
  // v0.32.0 裁决：声明了 extends 的子台**可以省略 data**，从父台继承记忆命名空间
  // （「继承而来」是合法的，空才是错误 —— 否则子台必须无意义地重复抄一遍父台的
  // 命名空间，而抄错还会造成两个 profile 偷偷共享记忆域）。
  const inheritsData = isStr(raw.extends)
  let data: WorkbenchProfile['data'] = { memoryNamespace: '', shareCoreProfile: true }
  if (!isObj(raw.data)) {
    if (inheritsData) {
      issues.push(
        issue(
          'V1',
          'warning',
          '$.data',
          '未声明 data：将继承父工作台的数据层（含记忆命名空间）',
          '如需独立记忆域，显式声明 data.memoryNamespace',
        ),
      )
    } else {
      issues.push(issue('V1', 'error', '$.data', 'data 必填且为对象', '至少提供 "memoryNamespace"'))
    }
  } else {
    const ns = raw.data.memoryNamespace
    if (!isStr(ns)) {
      if (inheritsData) {
        issues.push(
          issue('V1', 'warning', '$.data.memoryNamespace', '未声明 memoryNamespace：继承父工作台的值', '例如 "coding"'),
        )
      } else {
        issues.push(
          issue('V1', 'error', '$.data.memoryNamespace', 'memoryNamespace 必填且为非空字符串', '例如 "coding"'),
        )
      }
    } else if (!NAMESPACE_RE.test(ns)) {
      issues.push(
        issue('V1', 'error', '$.data.memoryNamespace', `memoryNamespace "${ns}" 只允许小写字母/数字/下划线/连字符，长度 1–32`, '例如 "coding"'),
      )
    }
    data = {
      memoryNamespace: isStr(ns) ? ns : '',
      shareCoreProfile: raw.data.shareCoreProfile !== false,
      defaultWorkspaceAssociation: isStr(raw.data.defaultWorkspaceAssociation)
        ? raw.data.defaultWorkspaceAssociation
        : undefined,
    }
  }

  // ---- agents ----
  const agents: ProfileAgentDecl[] = []
  if (raw.agents !== undefined && !Array.isArray(raw.agents)) {
    issues.push(issue('V1', 'error', '$.agents', 'agents 必须是数组'))
  } else if (Array.isArray(raw.agents)) {
    raw.agents.forEach((a, i) => {
      const p = `$.agents[${i}]`
      if (!isObj(a)) {
        issues.push(issue('V1', 'error', p, '数组元素必须是对象'))
        return
      }
      if (!isStr(a.id) || !AGENT_ID_RE.test(a.id)) {
        issues.push(issue('V1', 'error', `${p}.id`, 'agent id 必填、以 @ 开头，仅含字母/数字/连字符/下划线', '例如 "@coder"'))
      }
      if (!isStr(a.name)) issues.push(issue('V1', 'error', `${p}.name`, 'agent name 必填'))
      const skills = Array.isArray(a.skills) ? a.skills.filter(isStr) : []
      if (a.skills !== undefined && !Array.isArray(a.skills)) {
        issues.push(issue('V1', 'warning', `${p}.skills`, 'skills 应为字符串数组，已忽略'))
      }
      if (isStr(a.id)) {
        agents.push({
          id: a.id,
          name: isStr(a.name) ? a.name : a.id,
          personaRef: isStr(a.personaRef) ? a.personaRef : undefined,
          personaText: isStr(a.personaText) ? a.personaText : undefined,
          skills,
          defaultForNewTasks: a.defaultForNewTasks === true,
        })
      }
    })
  }

  // ---- capabilities ----
  const capabilities: ProfileCapabilityDecl[] = []
  if (raw.capabilities !== undefined && !Array.isArray(raw.capabilities)) {
    issues.push(issue('V1', 'error', '$.capabilities', 'capabilities 必须是数组'))
  } else if (Array.isArray(raw.capabilities)) {
    raw.capabilities.forEach((c, i) => {
      const p = `$.capabilities[${i}]`
      if (!isObj(c)) {
        issues.push(issue('V1', 'error', p, '数组元素必须是对象'))
        return
      }
      const t = c.type
      if (t !== 'mcp' && t !== 'skill' && t !== 'panel') {
        issues.push(issue('V1', 'error', `${p}.type`, 'type 必须是 "mcp" | "skill" | "panel"'))
      }
      if (!isStr(c.ref)) {
        issues.push(issue('V1', 'error', `${p}.ref`, 'ref 必填，形如 "skill:xxx" / "mcp:xxx"', '例如 "skill:S-core.plan"'))
      }
      if ((t === 'mcp' || t === 'skill' || t === 'panel') && isStr(c.ref)) {
        capabilities.push({ type: t, ref: c.ref, required: c.required === true })
      }
    })
  }

  // ---- ui ----
  const ui: ProfileUiDecl = {}
  if (raw.ui !== undefined && !isObj(raw.ui)) {
    issues.push(issue('V1', 'error', '$.ui', 'ui 必须是对象'))
  } else if (isObj(raw.ui)) {
    if (raw.ui.dockTabs !== undefined) {
      if (!Array.isArray(raw.ui.dockTabs)) {
        issues.push(issue('V1', 'warning', '$.ui.dockTabs', 'dockTabs 应为数组，已忽略'))
      } else {
        const tabs = raw.ui.dockTabs.filter(isStr)
        const bad = tabs.filter((t) => !(PROFILE_DOCK_TABS as readonly string[]).includes(t))
        if (bad.length > 0) {
          issues.push(
            issue('V1', 'error', '$.ui.dockTabs', `不支持的 Dock 面板：${bad.join(' / ')}`, `可选：${PROFILE_DOCK_TABS.join(' / ')}`),
          )
        }
        ui.dockTabs = tabs.filter((t) => (PROFILE_DOCK_TABS as readonly string[]).includes(t)) as DockTabIdList
      }
    }

    /* ---- ★ v0.33.0：ui.dockPanels（开放面板引用） ---- */
    if (raw.ui.dockPanels !== undefined) {
      if (!Array.isArray(raw.ui.dockPanels)) {
        issues.push(issue('V1', 'warning', '$.ui.dockPanels', 'dockPanels 应为数组，已忽略'))
      } else {
        const out: ProfileDockPanelDecl[] = []
        raw.ui.dockPanels.forEach((d, i) => {
          const p = `$.ui.dockPanels[${i}]`
          if (!isObj(d)) {
            issues.push(issue('V1', 'error', p, '数组元素必须是对象'))
            return
          }
          if (d.slot !== 'inspector') {
            issues.push(issue('V1', 'error', `${p}.slot`, `slot 目前只支持 "inspector"（收到 ${JSON.stringify(d.slot)}）`, '改为 "inspector"'))
          }
          if (!isStr(d.panelRef)) {
            issues.push(issue('V1', 'error', `${p}.panelRef`, 'panelRef 必填，形如 "panel:watchlist"', '例如 "panel:watchlist"'))
          }
          let position: number | undefined
          if (d.position !== undefined) {
            if (typeof d.position !== 'number' || !Number.isInteger(d.position) || d.position < 0) {
              issues.push(issue('V1', 'error', `${p}.position`, 'position 必须是非负整数（0 = 置顶于内置面板之前）', '例如 2'))
            } else {
              position = d.position
            }
          }
          if (d.slot === 'inspector' && isStr(d.panelRef)) {
            out.push({ slot: 'inspector', panelRef: d.panelRef, position })
          }
        })
        if (out.length > 0) ui.dockPanels = out
      }
    }

    /* ---- ui.homeModule：v0.33.0 起放宽为 string（内置名 或 'module:<id>'） ---- */
    if (raw.ui.homeModule !== undefined) {
      if (!isStr(raw.ui.homeModule)) {
        issues.push(issue('V1', 'error', '$.ui.homeModule', 'homeModule 必须是非空字符串', `内置可选：${PROFILE_HOME_MODULES.join(' / ')}；插件模块写 "module:<id>"`))
      } else {
        ui.homeModule = raw.ui.homeModule
      }
    }

    if (raw.ui.composerChips !== undefined) {
      if (!Array.isArray(raw.ui.composerChips)) {
        issues.push(issue('V1', 'warning', '$.ui.composerChips', 'composerChips 应为字符串数组，已忽略'))
      } else {
        ui.composerChips = raw.ui.composerChips.filter(isStr).slice(0, 8)
      }
    }

    /* ---- ★ v0.33.0：ui.previewRenderers ---- */
    if (raw.ui.previewRenderers !== undefined) {
      if (!isObj(raw.ui.previewRenderers)) {
        issues.push(issue('V1', 'warning', '$.ui.previewRenderers', 'previewRenderers 应为对象（{ "<ext>": "<RendererKind>" }），已忽略'))
      } else {
        const out: Record<string, string> = {}
        for (const [k, v] of Object.entries(raw.ui.previewRenderers)) {
          const p = `$.ui.previewRenderers.${k}`
          if (!/^[a-z0-9]+$/.test(k)) {
            issues.push(issue('V1', 'error', p, `扩展名键 "${k}" 必须全小写字母数字且不含点`, '例如 "kchart"'))
            continue
          }
          if (!isStr(v)) {
            issues.push(issue('V1', 'error', p, '渲染器类型必须是非空字符串', '例如 "table"'))
            continue
          }
          out[k] = v
        }
        if (Object.keys(out).length > 0) ui.previewRenderers = out
      }
    }

    /* ---- ★ v0.33.0：ui.actionExtensions（只登记） ---- */
    if (raw.ui.actionExtensions !== undefined) {
      if (!Array.isArray(raw.ui.actionExtensions)) {
        issues.push(issue('V1', 'warning', '$.ui.actionExtensions', 'actionExtensions 应为字符串数组，已忽略'))
      } else {
        const out = raw.ui.actionExtensions.filter(isStr)
        if (out.length > 0) ui.actionExtensions = out
      }
    }

    /* ---- ★ v0.33.0：ui.theme（结构在 V1、合法性在 V2 —— 见 validateReferences） ---- */
    if (raw.ui.theme !== undefined) {
      if (!isObj(raw.ui.theme)) {
        issues.push(issue('V1', 'warning', '$.ui.theme', 'theme 应为对象（{ light, dark }），已忽略'))
      } else {
        const out: { light: Record<string, string>; dark: Record<string, string> } = { light: {}, dark: {} }
        for (const g of ['light', 'dark'] as const) {
          const grp = raw.ui.theme[g]
          if (grp === undefined) continue
          if (!isObj(grp)) {
            issues.push(issue('V1', 'warning', `$.ui.theme.${g}`, `${g} 应为对象，已忽略`))
            continue
          }
          for (const [k, v] of Object.entries(grp)) if (typeof v === 'string') out[g][k] = v
        }
        if (Object.keys(out.light).length > 0 || Object.keys(out.dark).length > 0) ui.theme = out
      }
    }
  }

  // ---- automation ----
  const automation: ProfileAutoDecl[] = []
  if (raw.automation !== undefined && !Array.isArray(raw.automation)) {
    issues.push(issue('V1', 'error', '$.automation', 'automation 必须是数组'))
  } else if (Array.isArray(raw.automation)) {
    raw.automation.forEach((a, i) => {
      const p = `$.automation[${i}]`
      if (!isObj(a)) {
        issues.push(issue('V1', 'error', p, '数组元素必须是对象'))
        return
      }
      if (!isStr(a.cron) || !CRON_RE.test(a.cron)) {
        issues.push(issue('V1', 'error', `${p}.cron`, 'cron 必填且为五段式（分 时 日 月 周）', '例如 "0 9 * * 1-5"'))
      }
      if (!isStr(a.taskTemplate)) {
        issues.push(issue('V1', 'error', `${p}.taskTemplate`, 'taskTemplate 必填'))
      }
      if (isStr(a.cron) && CRON_RE.test(a.cron) && isStr(a.taskTemplate)) {
        automation.push({
          cron: a.cron,
          taskTemplate: a.taskTemplate,
          agent: isStr(a.agent) ? a.agent : undefined,
        })
      }
    })
  }

  // ---- requirements ----
  const requirements: ProfileRequirements = {}
  if (raw.requirements !== undefined && !isObj(raw.requirements)) {
    issues.push(issue('V1', 'warning', '$.requirements', 'requirements 应为对象，已忽略'))
  } else if (isObj(raw.requirements)) {
    if (Array.isArray(raw.requirements.models)) requirements.models = raw.requirements.models.filter(isStr)
    if (isStr(raw.requirements.minBaseVersion)) requirements.minBaseVersion = raw.requirements.minBaseVersion
  }

  const hasError = issues.some((i) => i.level === 'error')
  const profile: WorkbenchProfile | null = hasError
    ? null
    : {
        schemaVersion,
        id,
        name: isStr(raw.name) ? raw.name : id,
        icon: isStr(raw.icon) ? raw.icon : undefined,
        description: isStr(raw.description) ? raw.description : undefined,
        version: isStr(raw.version) ? raw.version : '0.0.0',
        author: isStr(raw.author) ? raw.author : undefined,
        extends: isStr(raw.extends) ? raw.extends : undefined,
        agents,
        capabilities,
        ui,
        data,
        automation,
        requirements,
        source,
      }

  return { profile, issues }
}

/** 与 `DockTabId` 同构的本地别名，避免在上方 import 里再引一次类型 */
type DockTabIdList = NonNullable<ProfileUiDecl['dockTabs']>

/* ============================================================
 * V3：继承链
 * ============================================================ */

/** 链中出现重复 id → 成环 */
export function detectExtendsCycle(chain: string[]): boolean {
  const seen = new Set<string>()
  for (const id of chain) {
    if (seen.has(id)) return true
    seen.add(id)
  }
  return false
}

/** 链跳数（chain[0] 是叶子，末尾是根） */
export function extendsDepthOf(chain: string[]): number {
  return Math.max(0, chain.length - 1)
}

/* ============================================================
 * §2.4 单继承合并
 * ============================================================ */

export function mergeProfile(
  parent: WorkbenchProfile | null,
  child: WorkbenchProfile,
): WorkbenchProfile {
  if (!parent) return child

  // agents：按 id 合并，同名 child 覆盖
  const agents: ProfileAgentDecl[] = parent.agents.map((a) => ({ ...a }))
  for (const c of child.agents) {
    const i = agents.findIndex((a) => a.id === c.id)
    if (i >= 0) agents[i] = { ...c }
    else agents.push({ ...c })
  }

  // capabilities：type:ref 为键取并集，child 覆盖 required
  const caps: ProfileCapabilityDecl[] = parent.capabilities.map((c) => ({ ...c }))
  for (const c of child.capabilities) {
    const key = `${c.type}:${refTail(c.ref)}`
    const i = caps.findIndex((x) => `${x.type}:${refTail(x.ref)}` === key)
    if (i >= 0) caps[i] = { ...c }
    else caps.push({ ...c })
  }

  // ui：浅覆盖（child 有值即整体覆盖）
  const ui: ProfileUiDecl = { ...parent.ui, ...definedOnly(child.ui) }

  // data：子键逐一覆盖；命名空间为空即取父（'' 表示「本层没声明」而非「声明为空」）
  const data = {
    ...parent.data,
    ...definedOnly(child.data),
    memoryNamespace: child.data.memoryNamespace || parent.data.memoryNamespace,
  }

  // automation：取并集（cron + taskTemplate 为键）
  const autos: ProfileAutoDecl[] = parent.automation.map((a) => ({ ...a }))
  for (const a of child.automation) {
    const key = `${a.cron}|${a.taskTemplate}`
    if (!autos.some((x) => `${x.cron}|${x.taskTemplate}` === key)) autos.push({ ...a })
  }

  // requirements：models 并集 + minBaseVersion 取更高者
  const models = Array.from(new Set([...(parent.requirements.models ?? []), ...(child.requirements.models ?? [])]))
  const pMin = parent.requirements.minBaseVersion
  const cMin = child.requirements.minBaseVersion
  const minBaseVersion =
    pMin && cMin ? (meetsMinVersion(cMin, pMin) ? cMin : pMin) : (cMin ?? pMin)

  return {
    // 身份与版本取 child（继承不改变「我是谁」）
    schemaVersion: child.schemaVersion,
    id: child.id,
    name: child.name,
    icon: child.icon ?? parent.icon,
    description: child.description ?? parent.description,
    version: child.version,
    author: child.author ?? parent.author,
    extends: child.extends,
    agents,
    capabilities: caps,
    ui,
    data,
    automation: autos,
    requirements: { models, minBaseVersion },
    source: child.source,
  }
}

/** 仅保留非 undefined 的键（浅覆盖语义） */
function definedOnly<T extends object>(o: T): Partial<T> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v
  return out as Partial<T>
}

/* ============================================================
 * V2 / V4 / V5 / V6：引用闭合与版本
 * ============================================================ */

export function validateReferences(
  profile: WorkbenchProfile,
  ctx: ProfileValidationContext,
): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  // ---- V2 能力引用闭合 ----
  profile.capabilities.forEach((c, i) => {
    const p = `$.capabilities[${i}].ref`
    if (c.type === 'panel') {
      // ★ v0.33.0：面板能力**真解析**（缺陷 D43 —— 此前恒报「只登记不挂载」，
      // 导致声明 required 面板的工作台永远激活不了）。
      // `ctx.panels === undefined` 时无法判定 → 跳过（保持既有单测构造的 ctx 可用）。
      if (ctx.panels === undefined) {
        issues.push(
          issue('V2', 'warning', p, `未提供面板清单，跳过「${c.ref}」的引用闭合校验`, '由激活器传入 panels 上下文即可校验'),
        )
        return
      }
      if (!refResolves(c.ref, ctx.panels)) {
        if (c.required) {
          issues.push(
            issue('V2', 'error', p, `必需面板 ${c.ref} 未安装或未启用`, `去工作台中心的「插件」页启用提供该面板的插件，或把 required 改为 false`),
          )
        } else {
          issues.push(
            issue('V2', 'warning', p, `面板 ${c.ref} 未安装或未启用（非必需）`, '将走「部分激活」：该面板不出现并记入激活报告'),
          )
        }
      }
      return
    }
    const pool = c.type === 'mcp' ? ctx.mcpServers : ctx.skills
    if (!refResolves(c.ref, pool)) {
      const what = c.type === 'mcp' ? 'MCP server' : '技能'
      if (c.required) {
        issues.push(
          issue('V2', 'error', p, `必需${what} ${c.ref} 未安装`, `去能力中心安装 ${refTail(c.ref)}，或把 required 改为 false`),
        )
      } else {
        issues.push(
          issue('V2', 'warning', p, `${what} ${c.ref} 未安装（非必需）`, '将走「部分激活」：跳过该项并记入激活报告'),
        )
      }
    }
  })

  /* ============================================================
   * ★ v0.33.0：V2 扩展 —— ui 层的引用闭合
   * ============================================================ */

  // ---- V2 · ui.dockPanels[].panelRef 必须能解析 ----
  const dockPanels = profile.ui.dockPanels ?? []
  if (ctx.panels !== undefined) {
    dockPanels.forEach((d, i) => {
      if (!refResolves(d.panelRef, ctx.panels!)) {
        issues.push(
          issue(
            'V2',
            // v0.34.0（D55）：原为 error（**硬阻断激活**）—— 这是两层语义不一致：
            // `composeProfile` 对同一情形是「ui 层降级（非阻断）」（TC-PACT-017 明确断言），
            // 而激活入口却因 error 直接 `ok:false` 拒绝整个台。
            // 真实后果（Windows/本机实测）：插件是可**由用户随时关掉**的可选项，
            // 一旦某个 profile 引用了它的面板，用户关掉插件后该台就**切不过去**了 ——
            // 引用闭合的严格性换来的是「配置陷阱」，不是安全性。
            // 现降为 warning：照常激活 + 该面板不产出条目 + 记入 degraded（「不静默半死」）。
            'warning',
            `$.ui.dockPanels[${i}].panelRef`,
            `面板 ${d.panelRef} 未安装或未启用 —— 该面板将不显示（其余装配照常）`,
            '到「能力 → 插件」启用提供该面板的插件；或从 dockPanels 里删掉这一项',
          ),
        )
      }
    })
  }

  // ---- V2 · ui.previewRenderers 的值必须是合法 RendererKind ----
  for (const [ext, kind] of Object.entries(profile.ui.previewRenderers ?? {})) {
    if (!isRendererKind(kind)) {
      issues.push(
        issue('V2', 'error', `$.ui.previewRenderers.${ext}`, `未知渲染器类型「${kind}」`, '取值见宿主渲染器白名单（markdown / code / table / …）'),
      )
    }
  }

  // ---- V2 · ui.theme token 合法性（只覆盖不新增） ----
  if (profile.ui.theme) {
    const { rejected } = sanitizeThemeTokens(profile.ui.theme)
    for (const r of rejected) {
      issues.push(
        issue('V2', 'error', `$.ui.theme.${r.group}.${r.key}`, `主题 token 不合法：${r.reason}`, '键必须形如 --x-y，值只允许颜色或 px/rem/em/%'),
      )
    }
  }

  // ---- V2 · ui.homeModule 必须是内置模块名或已注册的 module: 引用 ----
  if (profile.ui.homeModule) {
    const builtinOk = (PROFILE_HOME_MODULES as readonly string[]).includes(profile.ui.homeModule)
    if (!builtinOk) {
      const known = ctx.homeModules
      if (known !== undefined && !refResolves(profile.ui.homeModule, known)) {
        issues.push(
          issue('V2', 'warning', '$.ui.homeModule', `首页模块 ${profile.ui.homeModule} 未注册`, '启用提供该模块的插件，或改用内置模块名'),
        )
      } else if (known === undefined && !/^module:[\w.-]+$/.test(profile.ui.homeModule)) {
        issues.push(
          issue('V2', 'error', '$.ui.homeModule', `homeModule 取值不合法：${profile.ui.homeModule}`, `内置可选：${PROFILE_HOME_MODULES.join(' / ')}；插件模块写 "module:<id>"`),
        )
      }
    }
  }

  // ---- V2 · ui.actionExtensions（v0.33.0 只入槽登记，消费端未接线 → 只给提示） ----
  ;(profile.ui.actionExtensions ?? []).forEach((a, i) => {
    issues.push(
      issue('V2', 'warning', `$.ui.actionExtensions[${i}]`, `动作扩展 ${a} 已登记但本版消费端未接线`, '该动作暂不会出现在任何 UI；见遗留 L-33-03'),
    )
  })

  // ---- V4 内部闭合：automation.agent ⊆ agents ----
  const agentIds = new Set(profile.agents.map((a) => a.id))
  profile.automation.forEach((a, i) => {
    if (a.agent && !agentIds.has(a.agent)) {
      issues.push(
        issue('V4', 'error', `$.automation[${i}].agent`, `automation.agent "${a.agent}" 不在本 manifest 的 agents 中`, `改为 ${Array.from(agentIds).join(' / ') || '（先声明 agents）'}`),
      )
    }
  })

  // ---- V4 UI 内部闭合 ----
  const tabs = profile.ui.dockTabs ?? []
  const dupTab = tabs.filter((t, i) => tabs.indexOf(t) !== i)
  if (dupTab.length > 0) {
    issues.push(
      issue('V5', 'error', '$.ui.dockTabs', `dockTabs 存在重复项：${Array.from(new Set(dupTab)).join(' / ')}`, '每个面板只能出现一次'),
    )
  }
  const chips = profile.ui.composerChips ?? []
  if (chips.length > 0 && chips.some((c) => c.length > 24)) {
    issues.push(issue('V1', 'warning', '$.ui.composerChips', 'composerChips 单项超过 24 字，界面会被撑破', '缩短文案'))
  }

  /* ============================================================
   * ★ v0.33.0：V5 落地 —— 合并后的面板位次与渲染器扩展名冲突
   *
   * 注意：这里收到的是**合并后**的 profile（继承链已展开），因此
   * 「两个来源」表现为两个 panelRef —— 无法再区分父子包，故错误消息
   * 同时提示「可能在父包或本包」，把判断权交回用户。
   * ============================================================ */

  // ---- V5 · 同 slot 同 position 的面板 ----
  const byPosition = new Map<number, string[]>()
  for (const d of profile.ui.dockPanels ?? []) {
    if (d.position === undefined) continue
    const arr = byPosition.get(d.position) ?? []
    arr.push(d.panelRef)
    byPosition.set(d.position, arr)
  }
  for (const [pos, refs] of byPosition) {
    if (refs.length > 1) {
      issues.push(
        issue(
          'V5',
          'error',
          '$.ui.dockPanels',
          `position ${pos} 上有多个面板：${refs.join(' / ')}（两个来源可能在父包或本包）`,
          '给其中一个改一个不同的 position（面板插槽位次必须唯一）',
        ),
      )
    }
  }

  // ---- V5 · 同一 panelRef 重复声明 ----
  const refSeen = new Map<string, number>()
  ;(profile.ui.dockPanels ?? []).forEach((d, i) => {
    const prev = refSeen.get(d.panelRef)
    if (prev !== undefined) {
      issues.push(
        issue('V5', 'error', `$.ui.dockPanels[${i}].panelRef`, `面板 ${d.panelRef} 重复声明（与第 ${prev + 1} 项冲突）`, '同一面板只能声明一次'),
      )
    } else {
      refSeen.set(d.panelRef, i)
    }
  })

  // ---- V5 能力去重（同 type:ref 只允许一次）----
  const seen = new Map<string, number>()
  profile.capabilities.forEach((c, i) => {
    const key = `${c.type}:${refTail(c.ref)}`
    const prev = seen.get(key)
    if (prev !== undefined) {
      issues.push(
        issue('V5', 'warning', `$.capabilities[${i}]`, `能力 ${c.ref} 与第 ${prev + 1} 项重复`, '删除重复声明'),
      )
    } else {
      seen.set(key, i)
    }
  })

  // ---- V6 底座版本 ----
  const min = profile.requirements.minBaseVersion
  if (min) {
    if (!meetsMinVersion(ctx.baseVersion, min)) {
      issues.push(
        issue('V6', 'error', '$.requirements.minBaseVersion', `本工作台要求底座 ≥ ${min}，当前 ${ctx.baseVersion}`, '升级 ArkWork 后再激活'),
      )
    }
  }

  // ---- V4 至少一个可用的 agent（否则装配出空壳台）----
  if (profile.agents.length === 0) {
    issues.push(
      issue('V4', 'warning', '$.agents', '未声明任何 agent，新任务将回落底座默认 agent', '补一个 agents[] 项'),
    )
  }

  return issues
}

/** 便捷：结构 + 引用一次跑完（V2–V6 需要 ctx，V1 不需要） */
export function validateManifest(
  profile: WorkbenchProfile,
  ctx: ProfileValidationContext,
): ValidationIssue[] {
  return validateReferences(profile, ctx)
}

export function toReport(profileId: string, issues: ValidationIssue[]) {
  return { profileId, ok: !issues.some((i) => i.level === 'error'), issues }
}

/* ============================================================
 * 装配快照 diff（人话行）
 * ============================================================ */

export function diffSnapshots(a: CompositionSnapshot | null, b: CompositionSnapshot | null): string[] {
  if (!a && !b) return []
  if (!a) return [`profile: ${b!.profileId}（新增）`]
  if (!b) return [`profile: ${a.profileId}（移除）`]
  const lines: string[] = []
  if (a.profileId !== b.profileId) lines.push(`profile: ${a.profileId} → ${b.profileId}`)
  if (a.profileVersion !== b.profileVersion) lines.push(`version: ${a.profileVersion} → ${b.profileVersion}`)

  const cmp = (label: string, x: string[], y: string[]) => {
    const added = y.filter((v) => !x.includes(v))
    const removed = x.filter((v) => !y.includes(v))
    if (added.length || removed.length) {
      lines.push(`${label}: +${added.length} / -${removed.length}${added.length ? ` （+${added.join(', ')}）` : ''}${removed.length ? ` （-${removed.join(', ')}）` : ''}`)
    }
  }
  cmp('agents', a.layers.agents.map((x) => x.id), b.layers.agents.map((x) => x.id))
  cmp('tools', a.layers.tools.map((x) => x.ref), b.layers.tools.map((x) => x.ref))
  cmp('ui', a.layers.ui.map((x) => `${x.slot}=${x.value}`), b.layers.ui.map((x) => `${x.slot}=${x.value}`))
  cmp('data', a.layers.data.map((x) => `${x.key}=${x.value}`), b.layers.data.map((x) => `${x.key}=${x.value}`))
  cmp('auto', a.layers.auto.map((x) => x.cron), b.layers.auto.map((x) => x.cron))
  if (a.degraded.length !== b.degraded.length) {
    lines.push(`degraded: ${a.degraded.length} → ${b.degraded.length}`)
  }
  return lines
}

/* ============================================================
 * 摘要（列表项）
 * ============================================================ */

export function summarize(
  profile: WorkbenchProfile,
  activeProfileId: string | null,
): import('@shared/types/profile').ProfileSummary {
  return {
    id: profile.id,
    name: profile.name,
    icon: profile.icon,
    version: profile.version,
    description: profile.description,
    source: profile.source,
    active: profile.id === activeProfileId,
    namespace: profile.data.memoryNamespace,
    agents: profile.agents.length,
    capabilities: profile.capabilities.length,
    deletable: profile.source === 'user' && profile.id !== activeProfileId,
  }
}
