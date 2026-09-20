/* ============================================================
 * ArkWork — 插件工具名（命名空间 · 纯函数 · v0.35.0）
 * 设计文档：docs/versions/v0.35.0/04-system-design.md §11「缺陷回溯登记」
 *   —— 「插件工具与 skill 同名 → 模型侧歧义」的处置：
 *      工具注册名强制 `plugin__<ns>__<name>` 前缀（沿用 MCP 的命名空间手法）。
 *
 * ★ 为什么单独一个模块（而不是留在 host-service.ts 里）：
 *   这些函数被**三个**互不相干的层用到 ——
 *     · `main/plugins/runtime/host-service.ts`（注册/路由）
 *     · `main/agent/engine/act.ts`（工具分发）
 *     · `main/agent/engine/messages.ts`（工具清单装配）
 *   其中 act.ts / messages.ts 属于 agent 引擎，**不该 import 插件运行时**
 *   （那会把 `utilityProcess` 这些 Electron 依赖拖进引擎模块图，单测就得跟着
 *    起 electron 桩）。放这里，引擎只依赖一个零依赖的纯模块。
 *
 * ★ 为什么是 `__` 双下划线分段而不是 `:` 或 `.`：
 *   工具名要能安全地作为 JSON Schema / 函数名跨厂商传递。`:` 在部分厂商的
 *   工具名校验里非法；`.` 与插件 id 自身用的点号冲突（拆不回来）。
 *   VS Code 的 `publisher.extension` 用 `.` 是因为它没有「工具名」这一层。
 * ============================================================ */

/**
 * 插件工具在模型侧的全局名前缀。
 *
 * 必须加前缀的理由：插件工具、内置 skill、MCP 工具的**名字空间是同一个**
 * （`assembleTools` 交出去的就是一张平表）。插件是第三方输入，不加前缀时
 * 一个叫 `file-reader` 的插件会静默顶掉宿主的同名工具 —— 而 `act.ts` 是按
 * 名字精确匹配的，撞名之后没有任何报错，只是「工具行为变了」。
 */
export const PLUGIN_TOOL_PREFIX = 'plugin__'

/** 拼全局工具名（`plugin__<pluginId>__<name>`） */
export function globalPluginToolName(pluginId: string, name: string): string {
  return `${PLUGIN_TOOL_PREFIX}${pluginId}__${name}`
}

/**
 * 是否是插件工具名。
 *
 * 要求至少 `plugin__<id>__<name>` 三段都有内容 —— 只认前缀会让
 * 一个手写的裸名 `plugin__` 走进插件分发路径，然后报一个
 * 「插件 不存在」的误导性错误。
 */
export function isPluginToolName(name: unknown): boolean {
  if (typeof name !== 'string' || !name.startsWith(PLUGIN_TOOL_PREFIX)) return false
  return splitPluginToolName(name) !== null
}

/**
 * 全局名 → `{ pluginId, name }`（拆不出 → null）。
 *
 * 用 `lastIndexOf('__')` 而不是 `split('__')`：**工具名里可以含下划线**
 * （作者写 `get_kline` 很自然）。按最后一段拆，`plugin__my.calc__get_kline`
 * 仍能正确还原成 `{ 'my.calc', 'get_kline' }`；
 * 而 `split('__')` 会给出 `['plugin', 'my.calc', 'get', 'kline']`，拼不回来。
 * 代价是「插件 id 里含 `__`」会拆错 —— 这个由清单校验（VP1）禁止。
 */
export function splitPluginToolName(globalName: unknown): { pluginId: string; name: string } | null {
  if (typeof globalName !== 'string') return null
  if (!globalName.startsWith(PLUGIN_TOOL_PREFIX)) return null
  const rest = globalName.slice(PLUGIN_TOOL_PREFIX.length)
  const at = rest.lastIndexOf('__')
  if (at <= 0) return null // 没有第二段 → 不是合法插件工具名
  const pluginId = rest.slice(0, at)
  const name = rest.slice(at + 2)
  if (pluginId.length === 0 || name.length === 0) return null
  return { pluginId, name }
}

/** 摘要长度上限（与宿主 skill 的 summary 同口径；超出即截断并标注） */
export const PLUGIN_TOOL_SUMMARY_MAX = 500

/**
 * 插件工具结果的摘要（回给模型的 `resultSummary`）。
 *
 * 原则：**摘要必须比原始结果短**，但不能短到没信息。工具返回通常是对象
 * （例如一整棵行情树），直接 `JSON.stringify` 会把它灌进对话流。策略：
 * 显式摘要字段优先 → 字符串截断 → JSON 截断。
 *
 * ★ `JSON.stringify` 可能抛（循环引用 / BigInt）：那种情况下摘要退化成
 *   一句话，但**绝不抛** —— 抛出去会让调用方把「摘要写不出来」当成
 *   「工具执行失败」，是一次纯粹的误报。
 */
export function summarizePluginToolResult(pluginId: string, name: string, result: unknown): string {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const o = result as Record<string, unknown>
    for (const key of ['summary', 'message', 'text', 'result']) {
      const v = o[key]
      if (typeof v === 'string' && v.trim().length > 0) {
        return truncate(v.trim())
      }
    }
  }
  if (typeof result === 'string') return truncate(result)
  let json = ''
  try {
    json = JSON.stringify(result) ?? ''
  } catch {
    return `插件 ${pluginId} 的工具 ${name} 已执行（结果含循环引用，无法序列化）`
  }
  return truncate(json)
}

function truncate(s: string): string {
  return s.length > PLUGIN_TOOL_SUMMARY_MAX ? `${s.slice(0, PLUGIN_TOOL_SUMMARY_MAX)}…（已截断）` : s
}

/** 展示用短名（诊断面板里 `plugin__my.calc__get_kline` → `my.calc › get_kline`） */
export function prettyPluginToolName(globalName: string): string {
  const parts = splitPluginToolName(globalName)
  return parts ? `${parts.pluginId} › ${parts.name}` : globalName
}

/* ============================================================
 * 宿主的**插件控制工具**名（闭集）
 *
 * 与上面 `plugin__…` 是两回事，刻意分开命名空间：
 *   · `plugin__<id>__<name>`：插件**自带**的工具，要插件活着才能用；
 *   · `plugin_list` / `plugin_detail` / `plugin_set_enabled` / `plugin_open_view`：
 *     **宿主**提供的管理工具，插件坏了/没激活/被禁用了照样能用
 *     —— 否则「用坏掉的东西去诊断坏掉的东西」是不可能的。
 *
 * 放在这个零依赖纯模块里（而不是 `main/agent/tools/plugins.ts`）：
 * `act.ts` 需要**静态**判定工具名是不是控类型，而 `plugins.ts` 要 import
 * 插件运行时（`utilityProcess` 等 Electron 依赖）—— 让引擎静态依赖后者，
 * 会把 Electron 拖进引擎的模块图，node:test 里跑引擎就得连 BrowserWindow 一起桩。
 * ============================================================ */
export const PLUGIN_CONTROL_TOOL_NAMES = [
  'plugin_list',
  'plugin_detail',
  'plugin_set_enabled',
  'plugin_open_view',
] as const
export type PluginControlToolName = (typeof PLUGIN_CONTROL_TOOL_NAMES)[number]

export function isPluginControlTool(name: unknown): name is PluginControlToolName {
  return typeof name === 'string' && (PLUGIN_CONTROL_TOOL_NAMES as readonly string[]).includes(name)
}
