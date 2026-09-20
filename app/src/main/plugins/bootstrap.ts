/* ============================================================
 * ArkWork — 插件运行时装配（v0.35.0 · 组合根接线层）
 * 设计文档：docs/versions/v0.35.0/04-system-design.md §2 · §6.1 · §6.3
 *
 * 为什么单独一个文件：`main/index.ts` 是「启动顺序表」，不该塞进插件运行时的
 * 六七条接线细节（协议注册 / 服务初始化 / 索引刷新 / 激活 / 工作区切换 / 退出）。
 * 把接线收在这里，`index.ts` 只留三行：
 *
 *   registerPluginSchemePrivileges()   ← 必须在 app ready **之前**
 *   await bootstrapPluginRuntime()     ← ready 之后（在窗口创建之前）
 *   shutdownPluginRuntime()            ← before-quit
 *
 * ★ 顺序上有两条是硬约束（写错不会有报错，只会「全部不生效」）：
 *  ① `registerPluginSchemePrivileges()` 必须在 `app.whenReady()` **之前**：
 *     `standard: true` 的特权注册只被 Electron 在 ready 前接受，之后调用静默无效
 *     —— 于是 `arkwork-plugin://` 的 iframe 没有独立源、fetch 也被 CORS 挡掉。
 *  ② `bootstrapPluginRuntime()` 必须在 `bootstrapIpcSideEffects()` **之后**：
 *     它要读工作区级插件目录，而工作区路径由 profile/IPC 侧效果确定。
 * ============================================================ */
import { join } from 'node:path'
import { app } from 'electron'

import { logger } from '../system/logger.js'
import { pluginBroadcaster } from '../ipc/plugin.js'
import { setPluginViewOpenEmitter } from '../agent/tools/plugins.js'
import { setHostVersion, setPluginTeardownHook } from './registry.js'
import { registerPluginProtocol } from './protocol.js'
import {
  getPluginHostService,
  initPluginHostService,
  refreshPluginsAndIndex,
  teardownPlugin,
} from './runtime/host-service.js'

/** 已经装配过（重复调用是 no-op，而不是再起一套服务） */
let booted = false

/**
 * 装配插件运行时。
 *
 * @param opts.mainDir `out/main` 的绝对路径（`import.meta.url` 的 dirname）。
 *   用调用方传入而不是在模块内自算：本模块会被打进 `index.js`，
 *   但「index.js 在哪」是 index.ts 才知道的事实（dev 与 asar 内都成立）。
 */
export async function bootstrapPluginRuntime(opts: { mainDir: string }): Promise<void> {
  if (booted) return
  booted = true

  const entryPath = join(opts.mainDir, 'plugin-host.js')

  // ⓪ 宿主版本注入 —— **必须早于第一次扫描**（④）。
  //   registry 的 VP8 用 `hostVersion` 判 `engines.arkwork` 是否满足；不注入则
  //   永远是占位值 '0.0.0'，于是**任何**声明了 engines 的插件都会被判为
  //   「当前版本 0.0.0 不满足」而标成 invalid —— 作者照着文档写反而装不上。
  //   （接线类缺陷的典型形态：函数本身全对，错的是没人调用它。）
  setHostVersion(app.getVersion())

  // ① 协议：`arkwork-plugin://<pluginId>/<rel>`（只放行该插件目录内的文件）
  await registerPluginProtocol({
    dirOf: (pluginId) => getPluginHostService()?.entryOf(pluginId)?.dir,
    logger,
  })

  // ② 宿主服务（唯一知道「插件进程」存在的地方）
  initPluginHostService({
    entryPath,
    broadcast: pluginBroadcaster(),
  })

  // ③ 拔插与运行期连通：禁用/卸载插件时先拆掉它的进程与会话
  //    （不接这条 → 插件被禁用后进程还在跑、工具还挂在模型可见集里，D74 的同型错）
  setPluginTeardownHook(async (id) => {
    await teardownPlugin(id)
  })

  // ③.5 模型侧控制工具的「请打开视图」出口。
  //   `plugin_open_view` 只能**请求**，不能自己开 —— 视图住侧边栏还是浮窗
  //   是渲染层的决定（placement 的解析也在那边）。这里把请求交给广播。
  const broadcast = pluginBroadcaster()
  setPluginViewOpenEmitter((payload) => broadcast('plugin:view-open-request', payload))

  // ④ 首次扫描 + 索引（此时**不启动任何进程** —— 懒激活）
  await refreshPluginsAndIndex()

  // ⑤ 命中 `onStartup` 的常驻插件才在这里拉起
  try {
    await getPluginHostService()?.activatePersistentPlugins('startup')
  } catch (err) {
    // 激活失败是**逐插件**的事（supervisor 已把 phase 记成 activation-failed），
    // 走到这里说明连遍历都炸了 —— 记日志但不阻断启动
    logger.warn('System', `[plugin] 启动期激活失败：${String(err)}`)
  }

  logger.info('System', '[plugin] 运行时已装配')
}

/**
 * 工作区切换 / 关闭后调用。
 *
 * 为什么要**专门拆掉 workspace 来源的插件**：它们的目录在被切走的那个工作区里，
 * 进程还活着就会继续持有那个目录的路径 —— 插件随后任何一次 `fs.read` 都会
 * 读到一个「用户以为已经离开的」目录（v0.35.0 三级作用域引入的新孤儿形态）。
 * 全局与随包插件不受影响（它们的目录与工作区无关）。
 */
export async function onWorkspaceSwitchedPluginRuntime(): Promise<void> {
  const svc = getPluginHostService()
  if (!svc) return
  try {
    const wsPlugins = svc.listBySource('workspace')
    for (const id of wsPlugins) await teardownPlugin(id)
    if (wsPlugins.length > 0) {
      logger.info('System', `[plugin] 工作区切换：已停止 ${wsPlugins.length} 个工作区插件`)
    }
    await refreshPluginsAndIndex()
    await getPluginHostService()?.activatePersistentPlugins('workspace')
  } catch (err) {
    logger.warn('System', `[plugin] 工作区切换时的插件重算失败：${String(err)}`)
  }
}

/** 退出前：先让插件自己跑完 effect 清理（`host/dispose`），再杀进程 */
export function shutdownPluginRuntime(): void {
  try {
    getPluginHostService()?.shutdown()
  } catch (err) {
    // 退出路径上的异常只能吞掉（否则会拦住 quit）
    logger.warn('System', `[plugin] 退出清理失败：${String(err)}`)
  }
}

/** 供测试复位（生产不用） */
export function __resetPluginBootstrapForTest(): void {
  booted = false
}
