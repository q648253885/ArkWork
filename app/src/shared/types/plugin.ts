/* ============================================================
 * ArkWork — 能力插件（Capability Plugin）契约（v0.33.0；v0.35.0 增代码化）
 * 设计文档：docs/versions/v0.33.0/04-system-design.md §2.3 / §3 / §4
 *           正本 `workbench-profile-v1.0/02-概念模型与装配架构.md` §2（能力层）
 *           正本 `workbench-profile-v1.0/04-宿主插槽与UI扩展体系.md` §2（J2）
 *           ★ v0.35.0：docs/versions/v0.35.0/04-system-design.md §4.2 / §5
 *
 * 一句话：**行台包（profile）是「引用清单」，能力插件是「被引用的东西」**（D5）。
 *         profile 只声明差异，插件只贡献插槽条目 —— 两者都不含对方的实现体。
 *
 * ★ v0.35.0 变更（用户指令「插件代码要独立于 agent、可通过导入的形式（类似 VSCode）」）：
 *   插件从「纯声明式配置」升级为「**清单 + 可选代码**」：
 *     · `main`     → Host 半入口，跑在 Electron **utility process**（不是主进程内！）
 *     · `renderer` → Client 半入口，跑在 **`<iframe sandbox>`**（拿不到宿主 DOM）
 *   旧的声明式插件（只有 plugin.json + 白名单组件）**仍然是一等公民**（零代码路径）。
 *
 * ★ v0.35.0 撤销 D4 的绝对化表述：插件**可以**有代码，但代码不许直接碰宿主 ——
 *   两侧只能经**能力网关**（`ctx.ark.*` / `postMessage` 桥）访问宿主，
 *   且必须用 `permissions` 显式声明所需能力（**默认拒绝**）。
 *   即：**不是「禁止代码」，而是「代码没有后门」**（纪律⑫）。
 *
 * 本文件只放类型与常量（shared 层硬规则：零 electron / 零 renderer / 零 main）。
 * ============================================================ */
import type { PanelData, PanelInteract, VLibComponentName } from './vlib.js'

/**
 * 插件清单 schema 版本。
 * v0.35.0：`1.1` 为当前版本；`1.0`（v0.33–v0.34 的纯声明式清单）**仍受支持**
 * —— 兼容不是妥协，是因为「零代码插件」是合法的、被鼓励的轻形态（A14）。
 */
export const PLUGIN_SCHEMA_VERSION = '1.1'

/** 底座可解析的清单版本集合（不在此集合内即 error，见 VP1） */
export const SUPPORTED_PLUGIN_SCHEMA_VERSIONS = ['1.0', '1.1'] as const

/** 当前契约 API 版本（代码插件用；与清单 schemaVersion 独立演进） */
export const PLUGIN_API_VERSION = 1

/**
 * 五类插件 + v0.35.0 新增 `tool`（把插件能力接进模型工具表）。
 * 正本 04 §3 六类插槽中，能力插件可贡献的类别。
 */
export const PLUGIN_KINDS = ['panel', 'renderer', 'action', 'homeModule', 'theme', 'tool'] as const
export type PluginKind = (typeof PLUGIN_KINDS)[number]

/** 来源：随包示例（不可卸载）/ 全局用户插件 / 工作区插件（v0.35.0 新增） */
/**
 * 插件来源（v0.35.0 三级作用域，替代 v0.34.0 的 `'bundled' | 'local'`）：
 *  - `bundled`  ：**随包示例** —— 首启落盘，可禁用**不可卸载**
 *  - `global`   ：`{userData}/arkwork-data/plugins/` —— 全工作区共用
 *  - `workspace`：`<workspace>/.arkwork/plugins/` —— **本工作区专用，优先级最高**
 *
 * 解析顺序（后者**整份覆盖**前者，不做字段级 merge）：
 *   `bundled < global < workspace`
 * 旧值 `'local'` 读入时映射为 `'global'`（迁移层负责，见 registry.ts）。
 */
export type PluginSource = 'bundled' | 'global' | 'workspace'

/**
 * ★ v0.35.0 插件权限白名单（唯一真源）。
 *
 * 设计取向：**默认拒绝**。插件不声明 = 拿不到；声明了白名单外的名字 = 装载期即 error（VP9），
 * 不静默忽略（静默忽略会让作者以为"声明了就有"，排查成本极高）。
 */
export const PLUGIN_PERMISSIONS = [
  'fs:workspace-read', // 读工作区内文本
  'fs:workspace-write', // 写工作区内文本
  'net', // 主进程代发 HTTP（规避 CORS）
  'shell', // 执行外部命令
  'git', // v0.36.0：git 封闭白名单操作（读免审批；写走权限模式 + 审计）
  'tools.register', // 向模型注册工具
  'views.register', // 注册 iframe 视图
  'panels.register', // 注册白名单组件面板
  'storage', // 插件私有 KV
  'model.invoke', // 反向调用宿主模型
] as const
export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number]

/** 懒激活事件（对齐 VS Code activationEvents 的口径，但只保留 ArkWork 有意义的四种） */
export type PluginActivationEvent =
  | 'onStartup' // 宿主启动即激活
  | 'onWorkspaceOpen' // 打开工作区后激活
  | `onView:${string}` // 该视图被打开时激活
  | `onTool:${string}` // 该工具被模型调用时激活
  | `onPanel:${string}` // 该面板被打开时激活

/** kind='panel'：贡献一个 Inspector 面板 */
export interface PluginPanelProvide {
  /** 'panel:<name>' */
  panelRef: string
  title: string
  icon?: string
  component: VLibComponentName
  data: PanelData
  /** v0.34.1：交互声明（行点击 → 浮窗打开面板） */
  interact?: PanelInteract
}

/**
 * ★ v0.35.0：kind='panel' 且带代码时的**代码视图**（跑在 iframe 里）。
 *
 * 为什么是 iframe 而不是 React 组件：VS Code 官方原话 ——
 * 「we do not provide direct access to the underlying UI DOM to extension writers」。
 * 渲染层已沙箱化，插件代码若直接注入渲染树，等于主动打开 CSP 缺口且与宿主生命周期绑死。
 * iframe 不带 `allow-same-origin` → 插件**天然**拿不到宿主 DOM / storage / cookie，
 * 不需要我们写一堆"禁止访问"的检查（安全靠结构，不靠纪律）。
 */
export interface PluginViewProvide {
  /** 'view:<name>' */
  viewRef: string
  title: string
  icon?: string
  /** Client 半入口（相对插件目录；缺省时用清单顶层的 `renderer`） */
  renderer?: string
  /** 摆放位置：**只允许右侧侧边栏（dock）与浮窗（float）** */
  placement: 'dock' | 'float'
  initialSize?: { w: number; h: number }
}

/** ★ v0.35.0：kind='tool' / 或面板插件附加贡献的**模型可见工具**（声明部分） */
export interface PluginToolProvide {
  /** 模型可见名（装载时会加 `plugin__<ns>__` 前缀防冲突） */
  name: string
  description: string
  /** JSON Schema */
  inputSchema: Record<string, unknown>
}

/** kind='renderer'：接管一个或多个扩展名的渲染方式 */
export interface PluginRendererProvide {
  /** 必须是宿主 `RendererKind` 白名单成员（由校验器按值判定） */
  rendererKind: string
  /** 小写、无点（如 'kchart'） */
  extensions: string[]
  /** 该扩展名已被内置占用时必须显式置 true 才允许接管（正本 04 §5） */
  override?: boolean
  /** i18n 键；缺省用宿主默认名 */
  labelKey?: string
}

/** kind='action'：贡献一个选中/工具栏动作（v0.33.0 只入槽登记） */
export interface PluginActionProvide {
  actionId: string
  label: string
}

/** kind='homeModule'：贡献一个 CenterStage 首页模块 */
export interface PluginHomeModuleProvide {
  /** 'module:<id>' */
  module: string
  title: string
  icon?: string
}

/** kind='theme'：贡献一组 token 覆盖值 */
export interface PluginThemeProvide {
  light?: Record<string, string>
  dark?: Record<string, string>
}

/**
 * ★ v0.36.0：命令贡献点（对齐 VS Code `contributes.commands`）。
 *
 * 命令是插件**主动能力**的最小暴露单元：
 *  - UI 侧出现在 QuickAction（Mod+K）与插件面板的操作列表里；
 *  - 触发后经 `plugin:run-command` → supervisor 直发 `host/emit`
 *    （event=`command:<id>`），插件在 `ctx.on('command:<id>')` 里执行。
 *
 * 与 `tools` 的分工：tool 是**模型可见**的（进模型工具表），command 是**用户可见**的
 * （进 UI 命令面板）—— 两者可以指向同一份逻辑，但登记渠道互不替代。
 */
export interface PluginCommandContribution {
  /** 命令全名（`<pluginId内可读段>.<动作>`；同插件内唯一，跨插件允许重复触发隔离） */
  id: string
  /** 展示名（QuickAction / 插件详情里直接显示） */
  title: string
  /** 可选图标（emoji 或 vlib 图标名） */
  icon?: string
}

export interface PluginProvides {
  /**
   * ★ v0.36.0：命令贡献（不与 kind 联动 —— 任何 kind 的插件都可附带命令；
   * 但声明了命令就必须有 Host 半代码 `main`，否则命令无人处理（VP9））。
   */
  commands?: PluginCommandContribution[]
  panel?: PluginPanelProvide
  /**
   * v0.34.1：一个插件贡献**多个**面板。
   * 为什么要有它：真实插件天然是多面板的（列表 + 详情 + 图表），
   * 而一个面板一个插件会让「启用列表」忘了开详情就点不动 ——
   * 同属一个插件的面板必须同生共死。
   */
  panels?: PluginPanelProvide[]
  /** ★ v0.35.0：代码视图（iframe；只能进浮窗与右侧侧边栏） */
  views?: PluginViewProvide[]
  /** ★ v0.35.0：模型可见工具 */
  tools?: PluginToolProvide[]
  renderer?: PluginRendererProvide
  action?: PluginActionProvide
  homeModule?: PluginHomeModuleProvide
  theme?: PluginThemeProvide
}

/** plugin.json 的内存形态 */
export interface PluginManifest {
  schemaVersion: string
  /** 命名空间.名称（`^[a-z0-9-]+(?:\.[a-z0-9-]+)+$`，命名空间可多段/reverse-DNS） */
  id: string
  name: string
  version: string
  author?: string
  description?: string
  kind: PluginKind
  /** 缺省 true：新装插件默认启用 */
  enabledByDefault?: boolean

  /* ---------- ★ v0.35.0 新增 ---------- */

  /** 契约 API 版本（缺省 1） */
  apiVersion?: number
  /** 宿主兼容范围，如 `{ arkwork: '>=0.35.0' }` */
  engines?: { arkwork?: string }
  /** Host 半入口（相对插件目录的 js；跑在 utility process） */
  main?: string
  /** Client 半入口（相对插件目录的 js/html；跑在 iframe） */
  renderer?: string
  /** 懒激活事件（缺省 = 不自动激活，仅被视图/工具触发） */
  activation?: string[]
  /** 能力声明（默认拒绝；白名单外即 error） */
  permissions?: PluginPermission[]

  /** 贡献点（按 kind 选填；v0.34.x 起一直是本契约的核心字段） */
  provides: PluginProvides
}

/** 插件运行期阶段（诊断面板与懒激活共用） */
export type PluginRuntimePhase =
  | 'registered' // 已登记但未激活（懒激活：没命中事件）
  | 'activating' // 正在装载/执行 apply
  | 'active' // 已激活
  | 'activation-failed' // apply 抛错或超时
  | 'error' // 运行期未捕获异常或心跳缺失
  | 'stopped' // 已停用（禁用/卸载/工作区切换）

/** 单个插件的运行期诊断（v0.35.0 IPC `plugin:runtime-status`） */
export interface PluginRuntimeStatus {
  id: string
  phase: PluginRuntimePhase
  /** apply 耗时（ms）；未激活为 undefined */
  activationMs?: number
  /** 最近一次错误的人话描述（纪律⑦：静默退化必须留诊断人话） */
  lastError?: string
  /** 实际生效的权限（清单声明 ∩ 白名单） */
  permissions: PluginPermission[]
  /** Host 半进程 pid（跑在 utility process，**不是主进程 pid**） */
  hostPid?: number
}

/** 注册表条目 */
export interface InstalledPlugin {
  manifest: PluginManifest
  source: PluginSource
  /** 插件所在目录（bundled 亦为落盘目录） */
  dir: string
  /** 实际生效的启用态（已并入用户显式偏好） */
  enabled: boolean
  /** 校验失败原因（非空时该插件的 provides 不产生任何插槽条目） */
  invalidReason?: string
  /** ★ v0.35.0：被更高优先级作用域的同 id 插件覆盖时，这里记覆盖者来源 */
  shadowedBy?: PluginSource
}

/** 插件校验问题（VP1–VP10；与 profile 的 ValidationIssue 同构但独立编号空间） */
export type PluginRule = 'VP1' | 'VP2' | 'VP3' | 'VP4' | 'VP5' | 'VP6' | 'VP7' | 'VP8' | 'VP9' | 'VP10'

export interface PluginIssue {
  rule: PluginRule
  level: 'error' | 'warning'
  /** JSON Path，如 '$.provides.panel.component' */
  path: string
  message: string
  fix?: string
}

export interface PluginParseResult {
  manifest: PluginManifest | null
  issues: PluginIssue[]
}

/** 插件列表行（UI 用；不含数据体） */
export interface PluginSummary {
  id: string
  name: string
  version: string
  author?: string
  description?: string
  kind: PluginKind
  source: PluginSource
  enabled: boolean
  dir: string
  /** 人话贡献摘要，如 '面板 ×1' */
  contributionLabel: string
  /**
   * v0.33.0：该插件贡献的面板 ref（`panel:<name>`）。
   * 配置中心的面板选择器据此列出「可勾进工作台的插件面板」，
   * 使编辑器不必再单独走一条「可用面板」IPC。
   */
  panelRefs: string[]
  /** v0.33.0：该插件贡献的首页模块 ref（`module:<id>`），供首页模块下拉使用 */
  homeModules: string[]
  /** 校验失败原因（UI 展示在「校验问题」区） */
  invalidReason?: string
  /** 是否可卸载（bundled → false；global/workspace → true） */
  uninstallable: boolean

  /* ---------- ★ v0.35.0 新增 ---------- */

  /** 该插件贡献的代码视图（iframe） */
  viewRefs: string[]
  /** 该插件贡献的模型工具名 */
  toolNames: string[]
  /** ★ v0.36.0：该插件贡献的命令 id（QuickAction 与插件详情用） */
  commandIds: string[]
  /** Host 半入口是否存在（作者视角「我是代码插件还是声明式插件」的判据） */
  hasHostCode: boolean
  /** Client 半入口是否存在 */
  hasClientCode: boolean
  /** 被同 id 高优先级作用域覆盖时标记 */
  shadowedBy?: PluginSource
}

/** 来源的中文显示名（UI 与日志共用，避免各写一份映射） */
export const PLUGIN_SOURCE_LABEL: Record<PluginSource, string> = {
  bundled: '随包',
  global: '全局',
  workspace: '本工作区',
}

/** 来源的排列优先级（越小越先被覆盖）——**唯一真源**，registry 与 UI 共用 */
export const PLUGIN_SOURCE_ORDER: readonly PluginSource[] = ['bundled', 'global', 'workspace']

/** 视图摆放位置的中文显示名 */
export const PLUGIN_PLACEMENT_LABEL: Record<PluginViewProvide['placement'], string> = {
  dock: '右侧侧边栏',
  float: '浮窗',
}

