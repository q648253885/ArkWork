/* ============================================================
 * ArkWork — 模型侧**插件控制工具**（v0.35.0 · M17）
 * 设计文档：docs/versions/v0.35.0/04-system-design.md §3（M17）· §12（B9）
 *
 * 用户裁决（长期有效）：
 *   「插件能控制的是浮窗和右侧侧边栏，**大模型可以控制插件**」。
 * 本模块就是后半句的落地：给模型四个工具，让它能问「有哪些插件」、
 * 「这个插件怎么了」、「把它停掉」、「把那个视图打开给我看」。
 *
 * 与「插件贡献的工具」的区别（**名字空间刻意分开**，很容易搞混）：
 *   · `plugin__<pluginId>__<name>` —— 插件**自带**的工具，由插件实现，
 *     走 supervisor 调进插件进程（见 host-service.callPluginTool）；
 *   · `plugin_list` / `plugin_detail` / `plugin_set_enabled` / `plugin_open_view`
 *     —— **宿主**提供的工具，用来管理插件本身，由本模块直接实现。
 *   前者要插件配合，后者不需要：插件坏了、没激活、被禁用了，后者照样能用
 *   （这正是「诊断」这件事的前提 —— 用坏掉的东西去诊断坏掉的东西是不可能的）。
 *
 * ★ 依赖倒置：向上广播（请求渲染层打开视图）不 import `ipc/plugin.ts`，
 *   而是由装配处注入 emitter —— 引擎层不该知道「有窗口」这件事，
 *   否则 node:test 里跑引擎就得连 BrowserWindow 一起桩掉。
 * ============================================================ */
import type { LlmTool } from '../../llm/adapter.js'
import type { PluginRuntimePhase, PluginSummary } from '@shared/types/plugin'
// 名字与判定放在**零依赖纯模块**里（act.ts 要静态用它；本文件会拉起插件运行时，
// 不能让引擎为了判断一个工具名而把 Electron 依赖拖进模块图）。此处转出以免调用点多记路径。
export { PLUGIN_CONTROL_TOOL_NAMES, isPluginControlTool } from '@shared/utils/plugin-tool-name'
export type { PluginControlToolName } from '@shared/utils/plugin-tool-name'
import type { PluginControlToolName } from '@shared/utils/plugin-tool-name'

/* ============================================================
 * 向上广播的注入点（装配处设置；测试注入收集器）
 * ============================================================ */
type ViewOpenEmitter = (payload: { pluginId: string; viewRef: string }) => void
let emitViewOpen: ViewOpenEmitter | null = null

export function setPluginViewOpenEmitter(fn: ViewOpenEmitter | null): void {
  emitViewOpen = fn
}

/* ============================================================
 * 工具声明（回给 LLM 的 schema）
 *
 * 为什么把 description 写这么细：模型看不到插件目录，也看不到主进程日志。
 * 这些描述是它**唯一**的被告知渠道 —— 写含糊它就只能猜参数名然后被拒，
 * 而每一次被拒都是一次完整的 LLM 往返。
 * ============================================================ */
export const PLUGIN_CONTROL_TOOLS: LlmTool[] = [
  {
    type: 'function',
    function: {
      name: 'plugin_list',
      description:
        '列出已安装的插件（id / 名称 / 版本 / 来源 / 启用态 / 运行期状态）。' +
        '来源有三档：bundled（随包示例，不可卸载）、global（全局）、workspace（仅当前工作区）。' +
        '用户抱怨「某个能力不生效」「界面多了/少了东西」时先调它。',
      parameters: {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            enum: ['all', 'global', 'workspace'],
            description: '只看某一级作用域；缺省 all',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'plugin_detail',
      description:
        '查一个插件的详细情况：贡献了什么（面板 / 视图 / 工具）、声明了哪些权限、' +
        '运行期状态（已注册未激活 / 激活中 / 已激活 / 激活失败 / 运行期错误）、' +
        '装载耗时与**最近一次错误的人话描述**。排查「插件装了但没用」时用它。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '插件 id（plugin_list 里的 id 字段）' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'plugin_set_enabled',
      description:
        '启用或禁用一个插件。**这是会立即改变用户界面的操作**：禁用后它贡献的面板/视图/工具' +
        '立刻消失，正在运行的插件进程会被停掉。仅在用户明确要求或排查确认必要后调用，' +
        '并在结果里说明你改了什么。随包示例插件可以禁用但不可卸载。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '插件 id' },
          enabled: { type: 'boolean', description: 'true = 启用，false = 禁用' },
          scope: {
            type: 'string',
            enum: ['global', 'workspace'],
            description: '把这条偏好写到哪一级；缺省 global',
          },
        },
        required: ['id', 'enabled'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'plugin_open_view',
      description:
        '在界面上打开某个插件视图（panel 型视图进右侧侧边栏，float 型进浮窗）。' +
        '插件会按需被激活。用户说「打开那个插件面板」「给我看下 XX 插件」时用它。',
      parameters: {
        type: 'object',
        properties: {
          plugin_id: { type: 'string', description: '插件 id' },
          view_ref: { type: 'string', description: '视图 ref（形如 view:xxx，来自 plugin_detail）' },
        },
        required: ['plugin_id', 'view_ref'],
      },
    },
  },
]

/* ============================================================
 * 执行
 * ============================================================ */
export interface PluginControlResult {
  result: unknown
  summary: string
}

/** 运行期阶段 → 人话（回给模型的状态词，不要让它去猜 `activation-failed` 是什么） */
const PHASE_TEXT: Record<PluginRuntimePhase, string> = {
  registered: '已登记但未激活（正常：插件是懒激活的）',
  activating: '正在激活',
  active: '已激活',
  'activation-failed': '激活失败（插件代码抛错或超时）',
  error: '运行期出错',
  stopped: '已停止',
}

/**
 * 执行一个插件控制工具。
 *
 * 错误策略：**抛**（由 act.ts 的 catch 转成工具失败回给模型）。
 * 这里不吞错 —— 模型的下一步动作取决于它知道「为什么失败」。
 */
export async function invokePluginControlTool(
  name: PluginControlToolName,
  args: Record<string, unknown>,
): Promise<PluginControlResult> {
  // 动态 import：本模块被 `assembleTools` / `act.ts` 以**函数级**按需加载，
  // 顶层静态 import 会让「只是想知道工具名」的调用点也把插件运行时拉起来
  const { getPluginHostService } = await import('../../plugins/runtime/host-service.js')
  const svc = getPluginHostService()
  if (!svc) {
    throw new Error('plugin-runtime-unavailable: 插件运行时未装配（应用可能还在启动中）')
  }
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

  switch (name) {
    /* ---------- 列表 ---------- */
    case 'plugin_list': {
      const scope = str(args.scope) || 'all'
      // 索引是同步的、已经并入启用态与校验结果 —— 不必走异步 registry 扫描
      const all = svc.indexSnapshot()
      const rows = all
        .filter((p) => scope === 'all' || p.source === (scope === 'workspace' ? 'workspace' : scope))
        .map((p) => ({
          id: p.id,
          name: p.manifest.name,
          version: p.manifest.version,
          kind: p.manifest.kind,
          source: p.source,
          enabled: p.enabled,
          runtime: svc.phaseOf(p.id),
          invalid: p.invalidReason,
        }))
      return {
        result: { total: rows.length, scope, plugins: rows },
        summary:
          rows.length === 0
            ? `没有${scope === 'all' ? '' : `「${scope}」作用域的`}插件`
            : `${rows.length} 个插件：` +
              rows.map((r) => `${r.id}(${r.enabled ? '启用' : '禁用'}·${r.runtime})`).join('、'),
      }
    }

    /* ---------- 详情 ---------- */
    case 'plugin_detail': {
      const id = str(args.id)
      if (!id) throw new Error('参数错误：plugin_detail 需要 id')
      const all = svc.indexSnapshot()
      const p = all.find((x) => x.id === id)
      if (!p) throw new Error(`插件不存在：${id}（先用 plugin_list 确认 id）`)
      const status = svc.runtimeStatuses().find((s) => s.id === id)
      const views = (p.manifest.provides.views ?? []).map((v) => ({
        viewRef: v.viewRef,
        title: v.title,
        placement: v.placement ?? 'dock',
      }))
      const tools = (p.manifest.provides.tools ?? []).map((t) => t.name)
      const detail = {
        id: p.id,
        name: p.manifest.name,
        version: p.manifest.version,
        author: p.manifest.author,
        description: p.manifest.description,
        kind: p.manifest.kind,
        source: p.source,
        dir: p.dir,
        enabled: p.enabled,
        uninstallable: p.source !== 'bundled',
        invalidReason: p.invalidReason,
        hasHostCode: Boolean(p.manifest.main),
        hasClientCode: Boolean(p.manifest.renderer),
        permissions: p.manifest.permissions ?? [],
        views,
        tools,
        runtime: {
          phase: status?.phase ?? 'registered',
          text: PHASE_TEXT[status?.phase ?? 'registered'],
          activationMs: status?.activationMs,
          lastError: status?.lastError,
        },
      }
      return {
        result: detail,
        summary:
          `${p.manifest.name} v${p.manifest.version}（${p.id}，来源 ${p.source}，` +
          `${p.enabled ? '已启用' : '已禁用'}）· 状态：${PHASE_TEXT[status?.phase ?? 'registered']}` +
          (views.length > 0 ? ` · 视图：${views.map((v) => v.viewRef).join('/')}` : '') +
          (tools.length > 0 ? ` · 工具：${tools.join('/')}` : '') +
          (status?.lastError ? ` · ⚠️ 最近错误：${status.lastError}` : ''),
      }
    }

    /* ---------- 启停 ---------- */
    case 'plugin_set_enabled': {
      const id = str(args.id)
      if (!id) throw new Error('参数错误：plugin_set_enabled 需要 id')
      if (typeof args.enabled !== 'boolean') {
        throw new Error('参数错误：plugin_set_enabled 的 enabled 必须是 true / false')
      }
      const scope = args.scope === 'workspace' ? 'workspace' : 'global'
      const before = svc.indexSnapshot().find((p) => p.id === id)
      if (!before) throw new Error(`插件不存在：${id}（先用 plugin_list 确认 id）`)

      // 走与 IPC 同一条通道（`registry.setPluginEnabled` 内部会调 teardownHook
      // 把插件进程拆掉、再重建插槽）—— 不在这里自己拼「改配置 + 拔进程」，
      // 那种第二实现正是 v0.32.2 审计里 B4/B5 沉没的同型错
      const { setPluginEnabled } = await import('../../plugins/registry.js')
      const res = await setPluginEnabled(id, args.enabled, scope)
      if (!res.ok) throw new Error(`插件 ${id} 操作失败：${res.reason ?? 'unknown'}`)

      await svc.refreshIndex()
      return {
        result: { id, enabled: args.enabled, scope, ok: true },
        summary: `已${args.enabled ? '启用' : '禁用'}插件 ${before.manifest.name}（${id}），写入 ${scope} 级偏好；界面上的相关面板/视图已随之更新。`,
      }
    }

    /* ---------- 打开视图 ---------- */
    case 'plugin_open_view': {
      const pluginId = str(args.plugin_id)
      const viewRef = str(args.view_ref)
      if (!pluginId || !viewRef) throw new Error('参数错误：plugin_open_view 需要 plugin_id 与 view_ref')
      const p = svc.indexSnapshot().find((x) => x.id === pluginId)
      if (!p) throw new Error(`插件不存在：${pluginId}（先用 plugin_list 确认 id）`)
      const declared = (p.manifest.provides.views ?? []).find((v) => v.viewRef === viewRef)
      if (!declared) {
        const known = (p.manifest.provides.views ?? []).map((v) => v.viewRef)
        throw new Error(
          known.length === 0
            ? `插件 ${pluginId} 没有贡献任何视图`
            : `插件 ${pluginId} 没有名为 ${viewRef} 的视图（它有：${known.join('、')}）`,
        )
      }
      if (!emitViewOpen) {
        throw new Error('plugin-open-unavailable: 界面通道未就绪，无法打开视图')
      }
      // 只发「请打开」的请求，**不在主进程里替渲染层做决定** ——
      // 视图住侧边栏还是浮窗是渲染层的事（placement 也在那边解析）
      emitViewOpen({ pluginId, viewRef })
      return {
        result: { pluginId, viewRef, placement: declared.placement ?? 'dock', requested: true },
        summary: `已请求打开插件视图「${declared.title ?? viewRef}」（${pluginId}）。若用户界面上没有出现，可能是插件未启用或激活失败 —— 用 plugin_detail 查原因。`,
      }
    }
  }
}

/** 诊断用：把插件行拍成一行文本（测试与日志共用，避免两处各写一份格式化） */
export function formatPluginRow(p: PluginSummary & { runtime?: string }): string {
  return `${p.id} ${p.version} ${p.source}${p.enabled ? '' : ' (disabled)'}${p.runtime ? ` ${p.runtime}` : ''}`
}
