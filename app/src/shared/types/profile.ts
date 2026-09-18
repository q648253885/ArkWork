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
import type { AnyPanelSlotPayload, PanelSlotPayload } from './vlib.js'

export type { PanelSlotPayload, AnyPanelSlotPayload }

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
   * 生效的**内置** Dock 面板与顺序 —— 取值必须是既有六固定面板 `DockTabId` 的子集。
   * 缺省（undefined）= 不改动（沿用 agent 预设）。
   * v0.33.0 起本字段**真正生效**（驱动 Inspector 的可见集与顺序，见
   * `docs/versions/v0.33.0/04-system-design.md` §7.2）；此前因消费者
   * `RightDock.tsx` 无挂载点而完全不生效（缺陷 D40）。
   */
  dockTabs?: DockTabId[]
  /**
   * ★ v0.33.0 新增 —— **开放面板引用**（能力插件面板挂载点）。
   * 与 `dockTabs`（闭集）的分工：`dockTabs` 表达「内置六面板的取子集与顺序」，
   * `dockPanels` 表达「把某个面板（内置或插件贡献）插到第 N 位」。
   * `panel` 能力的必需项缺失时阻断激活（见 activator 的 panel 解析段）。
   */
  dockPanels?: ProfileDockPanelDecl[]
  /**
   * 无任务时 CenterStage 优先展示的模块页。
   * v0.33.0 起由闭集放宽为 `string`：六个内置模块名，或插件贡献的 `module:<id>`。
   * 值级校验分两层：`validateReferences`（V2，warning/error）+ `projectUiLayer`
   * （只把内置名投给 CenterStage；`module:` 引用本版只登记，见遗留 L-33-02）。
   */
  homeModule?: string
  /** Composer 快捷 chips（纯文本，不做 i18n key 解析） */
  composerChips?: string[]
  /**
   * ★ v0.33.0 新增 —— 渲染器覆盖：`{ '<ext>': '<RendererKind>' }`。
   * 让垂直台/插件自带文件类型渲染（正本 03 §3 `ui.previewRenderers`）。
   */
  previewRenderers?: Record<string, string>
  /**
   * ★ v0.33.0 新增 —— 选中动作扩展（正本 03 §3 `ui.actionExtensions`）。
   * v0.33.0 **只入槽登记 + 诊断可见**，消费端迁移属遗留 L-33-03。
   */
  actionExtensions?: string[]
  /**
   * ★ v0.33.0 新增 —— 主题 token 覆盖集（正本 04 §6）。
   * **只覆盖不新增**：键必须已存在于 `:root`，值经 `isSafeTokenValue` 白名单。
   */
  theme?: { light?: Record<string, string>; dark?: Record<string, string> }
}

/** `ui.dockPanels[]` 元素：一个开放面板引用 */
export interface ProfileDockPanelDecl {
  /** v0.33.0 只支持 'inspector'（原 RightDock 宿主已删除，见缺陷 D40） */
  slot: 'inspector'
  /** `panel:<name>` —— 内置六面板名或插件贡献的面板 */
  panelRef: string
  /** 插入序；`0` = 置顶于内置六面板之前；缺省 = 追加到末尾 */
  position?: number
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
  /**
   * ★ v0.33.0：可用面板 ref（内置六面板 + 已启用插件贡献的面板）。
   * 供 V2 校验 `ui.dockPanels[].panelRef` 引用闭合。
   * 缺省（`undefined`）→ **跳过该项校验**（保持既有测试构造的 ctx 可用）。
   */
  panels?: string[]
  /**
   * ★ v0.33.0：可用首页模块（六个内置模块名 + 插件贡献的 `module:<id>`）。
   * 缺省 → 只校验内置六名（向后兼容）。
   */
  homeModules?: string[]
}

/* ---------- 插槽层 ---------- */

/**
 * 插槽条目来源 ★ v0.33.0 —— 决定 `resetProfileSlots()` 的清理范围。
 *
 * 为什么必须有这一维（缺陷 D42）：v0.32.0 的 `resetProfileSlots()` 是全清，
 * 一旦存量注册表（渲染器 / 面板基础项）入槽，每次切换工作台都会**误删内置项**；
 * 而全清本身是「profile 是唯一注册来源」这一已失效假设的产物。
 */
export type SlotSource = 'builtin' | 'profile' | 'plugin'

export interface AgentSlotPayload {
  agentId: string
  personaText?: string
  profileId: string
}

export interface ToolSlotPayload {
  skillId?: string
  mcpServer?: string
  profileId: string
}

/** `ui.renderer` 载荷：接管一个/多个扩展名的渲染方式 */
export interface RendererSlotPayload {
  /** 必须是宿主 `RendererKind` 白名单成员（值级校验在 validateReferences / plugin-manifest） */
  rendererKind: string
  /** 小写、无点 */
  extensions: string[]
  /** 允许接管已被占用的扩展名（正本 04 §5） */
  override?: boolean
  labelKey: string
}

export interface ActionSlotPayload {
  actionId: string
  label: string
  /** 出处：`builtin` / `profile:<id>` / `plugin:<id>` / `chip`（快捷 chip 走此值） */
  origin: string
}

export interface HomeModuleSlotPayload {
  /** 六个内置模块名，或 `module:<id>`（插件贡献） */
  module: string
  title?: string
  icon?: string
  pluginId?: string
  profileId?: string
}

export interface ThemeSlotPayload {
  light: Record<string, string>
  dark: Record<string, string>
  pluginId?: string
  profileId?: string
}

export interface DataSlotPayload {
  namespace: string
  shareCore?: boolean
  profileId: string
}

export interface AutoSlotPayload {
  cron: string
  taskTemplate: string
  agent?: string
  required?: boolean
}

/** 九类插槽的载荷联合（判别键在 `SlotEntry.kind` 上，非 payload 内部） */
export type SlotEntryPayload =
  | AgentSlotPayload
  | ToolSlotPayload
  | AnyPanelSlotPayload
  | RendererSlotPayload
  | ActionSlotPayload
  | HomeModuleSlotPayload
  | ThemeSlotPayload
  | DataSlotPayload
  | AutoSlotPayload

export interface SlotEntry {
  /** 插槽内唯一 id（规范 `<kind 域>:<name>`，如 'panel:todos' / 'tool:skill:x'） */
  id: string
  kind: SlotKind
  /** i18n key 或字面量（宿主组件库是唯一消费者） */
  label: string
  /** ★ v0.33.0：来源。**可选、缺省视为 `'builtin'`**（既有测试直接构造无 source 的条目） */
  source?: SlotSource
  /** 各插槽自定义载荷（已由 v0.32.0 的 `unknown` 收敛为判别联合 —— 缺陷 D41 的一半） */
  payload: SlotEntryPayload
  /** resolve 排序键（升序；缺省排最后） */
  position?: number
}

export interface SlotQuery {
  profileId?: string
  requiredOnly?: boolean
  /** ★ v0.33.0：按来源过滤（诊断页与插件刷新用） */
  source?: SlotSource
}

/** 注册返回值（可逆注册 —— Cordis 模型的无重启切换前提） */
export type Disposable = () => void
