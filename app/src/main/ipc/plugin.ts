/* ============================================================
 * ArkWork — IPC: Plugin Registry + Runtime（插件插拔能力 · v0.33.0；v0.35.0 扩代码插件）
 * 设计文档：docs/versions/v0.33.0/04-system-design.md §9.2
 *           ★ v0.35.0：docs/versions/v0.35.0/04-system-design.md §5.3
 *
 * 通道分三组：
 *  A. **插拔**（v0.33.0 既有）：list / set-enabled / uninstall / rescan / open-dir / export-sample
 *  B. **运行期**（v0.35.0 新增）：runtime-status / views
 *  C. **视图桥**（v0.35.0 新增）：view-open / view-close / view-call / view-event
 *  D. **作者工具**（v0.35.0 新增）：scaffold / migrate-check
 *  广播：plugin:changed / plugin:runtime-changed / plugin:view-post / plugin:view-open-request
 *
 * 纪律（沿用 v0.33.0 并加一条）：
 *  ① **失败不抛**（除编程错误）—— 一律返回 `{ok:false, reason}`，UI 逐条展示；
 *  ② **插拔即时生效** —— 任何改变启用集合的操作都走 `refreshPluginSlots()`；
 *  ③ `open-dir` / `export-sample` / `scaffold` 只做「打开/写样例」，
 *     不读任意用户路径（杜绝把 IPC 变成任意文件读）；
 *  ④ 单个坏插件**不阻断启动**；
 *  ⑤ ★ **每个入参都要校验**（preload 与 main 双处）—— v0.35.0 的 view-call
 *     直接带着「会话 id + 方法名」进来，是攻击面最宽的一个，必须先卡形状。
 * ============================================================ */
import { BrowserWindow, ipcMain, shell } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PluginChannel,
  PLUGIN_VIEW_METHODS,
  type PluginRuntimeReport,
  type PluginViewCallRequest,
  type PluginViewCallResult,
  type PluginViewOpenResult,
  type PluginViewSummary,
} from '@shared/types/ipc'
import type { PluginKind, PluginSummary } from '@shared/types/plugin'
import {
  builtinManifestForExport,
  invalidatePlugins,
  listPlugins,
  pluginSummaries,
  pluginViews,
  refreshPluginSlots,
  setPluginEnabled,
  uninstallPlugin,
} from '../plugins/registry.js'
import { ensurePluginsDir, pluginsDir, type PluginScope } from '../plugins/store.js'
import { scaffoldPlugin } from '../plugins/scaffold.js'
import { getPluginHostService } from '../plugins/runtime/host-service.js'
import { pluginAssetUrl } from '../plugins/protocol.js'
import { logger } from '../system/logger.js'

/** 广播到所有窗口（插件侧只有这一种「上行到 UI」的通道） */
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send(channel, payload)
  }
}

function broadcastPluginChanged(pluginId: string): void {
  broadcast(PluginChannel.Changed, { pluginId })
}

const asScope = (v: unknown, dflt: PluginScope = 'global'): PluginScope =>
  v === 'workspace' ? 'workspace' : v === 'global' ? 'global' : dflt

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export function registerPluginHandlers(): void {
  /* ============================================================
   * A. 插拔
   * ============================================================ */

  ipcMain.handle(
    PluginChannel.List,
    async (_e, args?: { scope?: 'workspace' | 'global' | 'all' }): Promise<PluginSummary[]> => {
      const all = pluginSummaries(await listPlugins())
      const scope = args?.scope
      if (!scope || scope === 'all') return all
      return all.filter((p) => p.source === scope || (scope === 'global' && p.source === 'bundled'))
    },
  )

  ipcMain.handle(
    PluginChannel.SetEnabled,
    async (_e, args: { id: string; enabled: boolean; scope?: 'workspace' | 'global' }) => {
      const id = str(args?.id)
      if (!id) return { ok: false, reason: 'bad-args' }
      const res = await setPluginEnabled(id, args?.enabled !== false, asScope(args?.scope))
      if (res.ok) {
        await getPluginHostService()?.refreshIndex()
        broadcastPluginChanged(id)
      }
      return res
    },
  )

  ipcMain.handle(PluginChannel.Uninstall, async (_e, args: { id: string }) => {
    const id = str(args?.id)
    if (!id) return { ok: false, reason: 'bad-args' }
    const res = await uninstallPlugin(id)
    if (res.ok) {
      await getPluginHostService()?.refreshIndex()
      broadcastPluginChanged(id)
    }
    return res
  })

  ipcMain.handle(PluginChannel.Rescan, async (): Promise<PluginSummary[]> => {
    invalidatePlugins()
    await refreshPluginSlots()
    await getPluginHostService()?.refreshIndex()
    const out = pluginSummaries(await listPlugins())
    broadcastPluginChanged('*')
    return out
  })

  ipcMain.handle(PluginChannel.OpenDir, async (_e, args?: { scope?: 'workspace' | 'global' }) => {
    const dir = ensurePluginsDir(asScope(args?.scope))
    try {
      await shell.openPath(dir)
      return { ok: true, path: dir }
    } catch (err) {
      logger.warn('System', `[plugin] 打开目录失败：${String(err)}`)
      return { ok: false, path: dir }
    }
  })

  ipcMain.handle(PluginChannel.ExportSample, async (_e, args: { id: string }) => {
    const id = str(args?.id)
    const manifest = builtinManifestForExport(id)
    if (!manifest) return { ok: false, reason: 'not-found' }
    const root = ensurePluginsDir('global')
    // 目录名用 id 的末段（`ark.plugin.workbench-guide` → `workbench-guide`），
    // 与 `store.ts` 的扫描约定一致（见 `scanPluginsIn`）
    const short = manifest.id.split('.').pop() ?? manifest.id
    const dir = join(root, `${short}.sample`)
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const file = join(dir, 'plugin.json')
      writeFileSync(file, JSON.stringify(manifest, null, 2), 'utf-8')
      const readme = join(dir, 'README.md')
      if (!existsSync(readme)) {
        writeFileSync(
          readme,
          [
            `# ${manifest.name}（示例插件）`,
            '',
            '这是宿主内置插件的清单样例，用于快速上手插件开发。',
            '',
            '用法：',
            '',
            `1. 在 ${pluginsDir('global')} 下新建目录，例如 \`my-plugin/\`；`,
            '2. 把本目录的 `plugin.json` 复制进去并改 `id` / `name` / `provides`；',
            '3. 回到 ArkWork 的「能力 → 插件」点「重新扫描」。',
            '',
            '> 想写会跑的代码？用「新建插件」脚手架，它会生成 Host 半 + Client 半的最小工作集。',
            '',
          ].join('\n'),
          'utf-8',
        )
      }
      await shell.openPath(dir)
      logger.info('System', `[plugin] 导出样例 ${id} → ${dir}`)
      return { ok: true, path: dir }
    } catch (err) {
      logger.warn('System', `[plugin] 导出样例失败：${String(err)}`)
      return { ok: false, reason: 'fs-error' }
    }
  })

  /* ============================================================
   * B. 运行期
   * ============================================================ */

  ipcMain.handle(PluginChannel.RuntimeStatus, async (_e, args?: { id?: string }): Promise<PluginRuntimeReport> => {
    const svc = getPluginHostService()
    const all = await listPlugins()
    const items = svc?.runtimeStatuses() ?? []
    const shadowed = all
      .filter((p) => p.shadowedBy)
      .map((p) => ({ id: p.manifest.id, by: p.shadowedBy! }))
    const id = str(args?.id)
    return {
      items: id ? items.filter((s) => s.id === id) : items,
      shadowed,
      openViews: svc?.openViewCount() ?? 0,
    }
  })

  ipcMain.handle(PluginChannel.Views, async (): Promise<PluginViewSummary[]> => {
    const svc = getPluginHostService()
    const list = await pluginViews()
    return list.map((v) => ({
      pluginId: v.pluginId,
      source: v.source,
      viewRef: v.viewRef,
      title: v.title,
      icon: v.icon,
      placement: v.placement,
      order: v.order,
      active: svc?.supervisor.isActive(v.pluginId) ?? false,
    }))
  })

  /* ============================================================
   * C. 视图桥
   * ============================================================ */

  ipcMain.handle(
    PluginChannel.ViewOpen,
    async (_e, args: { pluginId: string; viewRef: string }): Promise<PluginViewOpenResult> => {
      const pluginId = str(args?.pluginId)
      const viewRef = str(args?.viewRef)
      if (!pluginId || !viewRef) return { ok: false, reason: 'bad-args', message: 'pluginId 与 viewRef 都不能为空' }
      const svc = getPluginHostService()
      if (!svc) return { ok: false, reason: 'not-found', message: '插件宿主服务未初始化' }
      const r = await svc.openView(pluginId, viewRef)
      if (!r.ok) return { ok: false, reason: r.reason, message: r.message }
      return {
        ok: true,
        sessionId: r.session.sessionId,
        url: pluginAssetUrl(pluginId, r.rel),
        title: r.session.title,
      }
    },
  )

  ipcMain.handle(PluginChannel.ViewClose, async (_e, args: { sessionId: string }) => {
    const sessionId = str(args?.sessionId)
    if (!sessionId) return { ok: false }
    return { ok: getPluginHostService()?.closeView(sessionId) ?? false }
  })

  ipcMain.handle(
    PluginChannel.ViewCall,
    async (_e, args: PluginViewCallRequest): Promise<PluginViewCallResult> => {
      const sessionId = str(args?.sessionId)
      const method = str(args?.method)
      if (!sessionId || !method) {
        return { ok: false, error: { code: 'bad-args', message: 'sessionId 与 method 都不能为空' } }
      }
      // ⑤ 双处校验之二：白名单在 main 再卡一次（preload 那次是给作者早期反馈，不是安全边界）
      if (!(PLUGIN_VIEW_METHODS as readonly string[]).includes(method)) {
        logger.warn('System', `[plugin] 拒绝白名单外的桥调用：${method}`)
        return { ok: false, error: { code: 'method-not-allowed', message: `桥方法「${method}」不在白名单内` } }
      }
      const svc = getPluginHostService()
      if (!svc) return { ok: false, error: { code: 'E_INTERNAL', message: '插件宿主服务未初始化' } }
      return await svc.viewCall(sessionId, method, args?.params)
    },
  )

  ipcMain.on(
    PluginChannel.ViewEvent,
    (_e, args: { sessionId: string; event: string; params?: unknown }) => {
      // 事件是**尽力而为**的单向通道：不回执、不抛错
      const svc = getPluginHostService()
      if (!svc) return
      const sessionId = str(args?.sessionId)
      const event = str(args?.event)
      if (!sessionId || !event) return
      void svc
        .viewCall(sessionId, event, args?.params)
        .then((r) => {
          if (!r.ok) logger.debug('System', `[plugin] 视图事件 ${event} 被拒：${r.error?.message ?? ''}`)
        })
        .catch(() => {})
    },
  )

  /* ============================================================
   * D. 作者工具
   * ============================================================ */

  ipcMain.handle(
    PluginChannel.Scaffold,
    async (_e, args: { id: string; name: string; kind: string; scope: 'workspace' | 'global' }) => {
      const id = str(args?.id).trim()
      const name = str(args?.name).trim()
      const kind = str(args?.kind) || 'panel'
      if (!id || !name) return { ok: false, reason: 'bad-args' }
      const res = scaffoldPlugin({ id, name, kind: kind as PluginKind, scope: asScope(args?.scope) })
      if (res.ok) {
        invalidatePlugins()
        await refreshPluginSlots()
        await getPluginHostService()?.refreshIndex()
        await shell.openPath(res.dir!)
        broadcastPluginChanged('*')
      }
      return { ok: res.ok, dir: res.dir, reason: res.reason, message: res.message }
    },
  )

  ipcMain.handle(PluginChannel.MigrateCheck, async () => {
    // 死条目对账在 `listPlugins()` 里随扫描发生（reconcileKnownIds），
    // 这里只是把它显式触发一次并回报结果，供 UI 的「检查」按钮用。
    invalidatePlugins()
    const before = await listPlugins()
    await getPluginHostService()?.refreshIndex()
    return {
      cleaned: [],
      migrated: [],
      // 顺带把「被覆盖的插件」告诉调用方（诊断页要用）
      shadowed: before.filter((p) => p.shadowedBy).map((p) => `${p.manifest.id} ← ${p.shadowedBy}`),
    }
  })
}

/** 供 host-service 装配时使用：把「上行到 UI」的出口交给它 */
export function pluginBroadcaster(): (channel: string, payload: unknown) => void {
  return broadcast
}
