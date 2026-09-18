/* ============================================================
 * ArkWork — Shared Types: Workbench Profile（插件模式 · v0.32.0）
 * 设计文档：
 *   · 仓库外正本 `agent_learn/docs/workbench-profile-v1.0/`（02/03/04/05/06）
 *   · 本仓库 `docs/versions/v0.32.0/04-system-design.md` 第二部分
 *
 * 一句话：`ArkWork = 底座 + Σ(能力插件)`，
 *         `垂直工作台 = Profile 对能力的一次声明式装配`。
 *
 * 本文件只放**类型与常量**（shared 层硬规则：零 electron / 零 renderer / 零 main）；
 * 解析、继承合并与校验等逻辑在 `shared/utils/profile-manifest.ts`（纯函数）。
 * ============================================================ */
import type { DockTabId } from './agent.js'

/** manifest schema 版本（为未来字段演进留升级路径） */
export const PROFILE_SCHEMA_VERSION = '1.0'

/** 九类插槽（正本 04 §2；`ui.*` 四小类合计为一类的子键） */
export type SlotKind =
  | 'agent'
  | 'tool'
  | 'ui.panel'
  | 'ui.renderer'
  | 'ui.action'
  | 'ui.homeModule'
  | 'ui.theme'
  | 'data'
  | 'auto'

export const SLOT_KINDS: SlotKind[] = [
  'agent',
  'tool',
  'ui.panel',
  'ui.renderer',
  'ui.action',
  'ui.homeModule',
  'ui.theme',
  'data',
  'auto',
]

/** Profile 来源：内置（代码即真源，不可删）/ 用户（profiles.json） */
export type ProfileSource = 'builtin' | 'user'

/**
 * CenterStage 无任务时可展示的模块页白名单。
 * ⚠️ 必须与 `renderer/store/types.ts` 的 `ModulePage` 保持一致 ——
 * 该断言由 `renderer/store/slices/profileSlice.ts` 顶部的
 * `PROFILE_HOME_MODULES satisfies readonly ModulePage[]` 在编译期把守
 * （shared 层不能反向 import renderer 类型）。
 */
export const PROFILE_HOME_MODULES = [
  'automations',
  'skills',
  'agents',
  'kb',
  'memory',
  'settings',
] as const

export type ProfileHomeModule = (typeof PROFILE_HOME_MODULES)[number]

/**
 * 可被 profile 声明的 Dock 面板全集（= 既有六固定面板）。
 * 与 `DockTabId` 同源：类型上是 `readonly DockTabId[]`，值用于解析期合法性校验
 * （manifest 来自 JSON，运行期必须按值校验而不能只靠类型）。
 */
export const PROFILE_DOCK_TABS: readonly DockTabId[] = [
  'files',
  'context',
  'terminal',
  'browser',
  'todos',
  'progress',
]

/** 能力引用：`type:ref` 三元组（capabilities[]） */
export interface ProfileCapabilityDecl {
  /** mcp = MCP server；skill = 技能包；panel = UI 面板插件（v1 只登记） */
  type: 'mcp' | 'skill' | 'panel'
  /** 形如 'mcp:tushare' / 'skill:builtin-coding-pack' / 'panel:quote-board' */
  ref: string
  /** 默认 false → 缺失走「部分激活」而非阻断（正本 02 §5） */
  required?: boolean
}

/** agent 层声明 */
export interface ProfileAgentDecl {
  id: string
  name: string
  /** 包内 persona 路径（v1 只登记不解析，遗留 L6）；与 personaText 二选一 */
  personaRef?: string
  /** 内联人格文本（v1 实际注入用） */
  personaText?: string
  /** 技能引用：'skill:xxx'（装配时并入工具集） */
  skills?: string[]
  /** 新任务默认使用该 agent（v1 只在快照与报告中体现） */
  defaultForNewTasks?: boolean
}

/** UI 层声明（声明式槽位 —— D4：不允许插件注入任意 React 代码） */
export interface ProfileUiDecl {
  /**
   * 生效的 Dock 面板与顺序 —— 取值必须是既有六固定面板 `DockTabId` 的子集。
   * 缺省（undefined）= 不改动（沿用 agent 预设）。
   * v1 刻意**不扩 DockTabId 闭集**：用子集/重排表达垂直台差异，
   * 零类型破坏；新增面板类型的能力归 Slot Service 后续版本（遗留 L4）。
   */
  dockTabs?: DockTabId[]
  /** 无任务时 CenterStage 优先展示的模块页 */
  homeModule?: ProfileHomeModule
  /** Composer 快捷 chips（纯文本，不做 i18n key 解析） */
  composerChips?: string[]
}

/** 数据层声明 */
export interface ProfileDataDecl {
  /** 记忆命名空间：[a-z0-9_-]{1,32}；同值即共享域记忆 */
  memoryNamespace: string
  /** 核心画像共享（默认 true；J4 双层画像的共享层） */
  shareCoreProfile?: boolean
  /** 关联目录（v1 只登记展示，不自动激活 → 遗留 L8） */
  defaultWorkspaceAssociation?: string
}

/** 自动化层声明（v1 只登记进快照，不写入用户 automations → 遗留 L5） */
export interface ProfileAutoDecl {
  /** 五段 cron（'分 时 日 月 周'） */
  cron: string
  taskTemplate: string
  /** 必须 ∈ agents[].id（V4 闭合校验） */
  agent?: string
}

/** 环境要求（声明但不装配） */
export interface ProfileRequirements {
  models?: string[]
  /** 语义化版本下限，与底座版本比较（V6） */
  minBaseVersion?: string
}

/** Workbench Profile（workbench.json 的内存形态） */
export interface WorkbenchProfile {
  schemaVersion: string
  /** 命名空间.名称：[a-z0-9-]+\.[a-z0-9-]+，全局唯一 */
  id: string
  name: string
  /** 宿主 `Icon` 组件名（禁 emoji —— 项目硬规范） */
  icon?: string
  description?: string
  /** manifest 自身语义化版本 */
  version: string
  author?: string
  /** 单继承：父 profile id（深度 ≤ 2、禁环 —— V3） */
  extends?: string
  agents: ProfileAgentDecl[]
  capabilities: ProfileCapabilityDecl[]
  ui: ProfileUiDecl
  data: ProfileDataDecl
  automation: ProfileAutoDecl[]
  requirements: ProfileRequirements
  /** 来源（内置 / 用户），由宿主填充，不出现在 workbench.json 里 */
  source: ProfileSource
}

/* ---------- 校验 ---------- */

export type ValidationRule = 'V1' | 'V2' | 'V3' | 'V4' | 'V5' | 'V6'

export interface ValidationIssue {
  rule: ValidationRule
  level: 'error' | 'warning'
  /** JSON Path 定位，如 '$.capabilities[1].ref' */
  path: string
  /** 人话解释 */
  message: string
  /** 修复建议 */
  fix?: string
}

export interface ValidationReport {
  profileId: string
  /** 无 error 级问题即视为通过（warning 不阻断） */
  ok: boolean
  issues: ValidationIssue[]
}

/* ---------- 装配快照 ---------- */

export interface SnapshotAgent {
  id: string
  name: string
  /** persona 稳定短哈希（可追溯「这个任务当时用的人格」） */
  personaHash: string
  defaultForNewTasks: boolean
  skills: string[]
}

export interface SnapshotTool {
  kind: 'skill' | 'mcp'
  ref: string
  /** 是否在底座实际找到（listSkills 命中） */
  found: boolean
  required: boolean
}

export interface SnapshotUi {
  slot: string
  value: string
  /** 是否真正生效（未生效即进了 degraded） */
  applied: boolean
}

export interface SnapshotData {
  key: string
  value: string
  applied: boolean
}

export interface SnapshotAuto {
  cron: string
  taskTemplate: string
  agent?: string
  /** v1 恒为 false —— 只登记不注册（遗留 L5） */
  registered: false
}

/** 装配快照（可追溯 / 可 diff / 可回滚） */
export interface CompositionSnapshot {
  profileId: string
  profileVersion: string
  resolvedAt: number
  layers: {
    agents: SnapshotAgent[]
    tools: SnapshotTool[]
    ui: SnapshotUi[]
    data: SnapshotData[]
    auto: SnapshotAuto[]
  }
  degraded: Degradation[]
}

export type ProfileLayer = 'agents' | 'tools' | 'ui' | 'data' | 'auto'

/** 降级记录：任何降级都必须逐条可见（「永不静默半死」） */
export interface Degradation {
  layer: ProfileLayer
  ref: string
  /** 人话原因：'未安装' / '技能未启用' / '不支持的模块页' … */
  reason: string
  /** true = 本次激活被阻断（required 项缺失） */
  blocking: boolean
}

/** 激活报告 */
export interface ActivationReport {
  ok: boolean
  profileId: string
  resolvedAt: number
  validation: ValidationReport
  snapshot?: CompositionSnapshot
  degraded: Degradation[]
  /** 事务性：失败时仍生效的是上一个 profile */
  stillActiveProfileId: string | null
  durationMs: number
}

/** 列表项（列表不需要整份 manifest） */
export interface ProfileSummary {
  id: string
  name: string
  icon?: string
  version: string
  description?: string
  source: ProfileSource
  active: boolean
  namespace: string
  agents: number
  capabilities: number
  /** 是否可在 UI 删除（内置 / 当前生效 → false） */
  deletable: boolean
}

/** 校验上下文（引用闭合 V2/V5 所需的「底座实际有什么」） */
export interface ProfileValidationContext {
  /** 可用技能 id（含 'skill:' 前缀与裸 id 两种写法均可命中） */
  skills: string[]
  /** 可用 MCP server id */
  mcpServers: string[]
  /** 底座版本（V6） */
  baseVersion: string
  /** 已存在（同级候选）的 profile id → 供 V5 同 position 冲突检测 */
  siblingProfileIds?: string[]
}

/* ---------- 插槽层 ---------- */

export interface SlotEntry {
  /** 插槽内唯一 id（规范 '<source>:<name>'，如 'builtin:todos'） */
  id: string
  kind: SlotKind
  /** i18n key 或字面量（宿主组件库是唯一消费者） */
  label: string
  /** 各插槽自定义载荷 */
  payload: unknown
  /** resolve 排序键（升序；缺省排最后） */
  position?: number
}

export interface SlotQuery {
  profileId?: string
  requiredOnly?: boolean
}

/** 注册返回值（可逆注册 —— Cordis 模型的无重启切换前提） */
export type Disposable = () => void
