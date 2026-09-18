/* ============================================================
 * ArkWork — 能力插件（Capability Plugin）契约（v0.33.0）
 * 设计文档：docs/versions/v0.33.0/04-system-design.md §2.3 / §3 / §4
 *           正本 `workbench-profile-v1.0/02-概念模型与装配架构.md` §2（能力层）
 *           正本 `workbench-profile-v1.0/04-宿主插槽与UI扩展体系.md` §2（J2）
 *
 * 一句话：**行台包（profile）是「引用清单」，能力插件是「被引用的东西」**（D5）。
 *         profile 只声明差异，插件只贡献插槽条目 —— 两者都不含对方的实现体。
 *
 * 插件**不允许**注入任意 React 代码：面板插件只能引用宿主组件白名单
 * （`VLibComponentName`）+ 声明数据形状（D4 / 正本 04 §1 反面论证）。
 *
 * 本文件只放类型与常量（shared 层硬规则：零 electron / 零 renderer / 零 main）。
 * ============================================================ */
import type { PanelData, PanelInteract, VLibComponentName } from './vlib.js'

/** 插件清单 schema 版本 */
export const PLUGIN_SCHEMA_VERSION = '1.0'

/** 五类插件（正本 04 §3 六类插槽中，能力插件可贡献的五类） */
export const PLUGIN_KINDS = ['panel', 'renderer', 'action', 'homeModule', 'theme'] as const
export type PluginKind = (typeof PLUGIN_KINDS)[number]

/** 来源：内置（代码字面量，不可删）/ 用户（`{arkworkDir}/plugins/` 目录，可卸载） */
/**
 * 插件来源（v0.34.0 语义，替代 v0.33.0 的 `'builtin' | 'user'`）：
 *  - `bundled`：**随包示例插件** —— 首启落盘到插件目录，可禁用**不可卸载**
 *  - `local`  ：本地/用户自建插件 —— 可禁用、可卸载
 * 判定真源：插件 id 是否属于随包示例清单（见 main/plugins/sample-plugins.ts）。
 */
export type PluginSource = 'bundled' | 'local'

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

export interface PluginProvides {
  panel?: PluginPanelProvide
  /**
   * v0.34.1：一个插件贡献**多个**面板。
   * 为什么要有它：真实插件天然是多面板的（列表 + 详情 + 图表），
   * 而一个面板一个插件会让「启用列表」忘了开详情就点不动 ——
   * 同属一个插件的面板必须同生共死。
   */
  panels?: PluginPanelProvide[]
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
  provides: PluginProvides
}

/** 注册表条目 */
export interface InstalledPlugin {
  manifest: PluginManifest
  source: PluginSource
  /** 用户插件所在目录（内置为空串） */
  dir: string
  /** 实际生效的启用态（已并入用户显式偏好） */
  enabled: boolean
  /** 校验失败原因（非空时该插件的 provides 不产生任何插槽条目） */
  invalidReason?: string
}

/** 插件校验问题（VP1–VP6；与 profile 的 ValidationIssue 同构但独立编号空间） */
export type PluginRule = 'VP1' | 'VP2' | 'VP3' | 'VP4' | 'VP5' | 'VP6'

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
  /** 是否可卸载（内置 → false） */
  uninstallable: boolean
}
