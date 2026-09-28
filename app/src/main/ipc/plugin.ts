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
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PluginChannel,
  PLUGIN_VIEW_METHODS,
  type PluginCommandEntry,
  type PluginRuntimeReport,
  type PluginViewCallRequest,
  type PluginViewCallResult,
  type PluginViewOpenResult,
  type PluginViewSummary,
} from '@shared/types/ipc'
import type { PluginKind, PluginSummary } from '@shared/types/plugin'
import {
  builtinManifestForExport,
  declaredPluginCommands,
  invalidatePlugins,
  listPluginSummaries,
  listPlugins,
  pluginViews,
  refreshPluginSlots,
  setPluginEnabled,
  uninstallPlugin,
} from '../plugins/registry.js'
import { installPluginFromZip, setPluginInstallBroadcaster } from '../plugins/install.js'
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
  // ★ v0.36.0（F3.2）：安装器完成落盘后的「重建插槽 + 广播」出口
  setPluginInstallBroadcaster(broadcast)

  /* ============================================================
   * A. 插拔
   * ============================================================ */

  ipcMain.handle(
    PluginChannel.List,
    async (_e, args?: { scope?: 'workspace' | 'global' | 'all' }): Promise<PluginSummary[]> => {
      // ★ D95：必须走 listPluginSummaries（含 enabled 三级解析）——
      // 直接 pluginSummaries(await listPlugins()) 会拿到占位 false，UI 永远显示「0 个启用」
      const all = await listPluginSummaries()
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

  ipcMain.handle(PluginChannel.Uninstall, async (_e, args: { id: string; purgeData?: boolean }) => {
    const id = str(args?.id)
    if (!id) return { ok: false, reason: 'bad-args' }
    // v0.36.0（F3.2）：purgeData —— 卸载时连插件私有 KV 一起清（UI 确认弹窗勾选）
    const res = await uninstallPlugin(id, { purgeData: args?.purgeData === true })
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
    const out = await listPluginSummaries()
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

  /* ============================================================
   * E. 安装 / 命令（★ v0.36.0 · B2 / F3.2 / F3.3）
   * ============================================================ */

  ipcMain.handle(
    PluginChannel.InstallZip,
    async (_e, args?: { zipPath?: string; confirmed?: boolean; overwrite?: boolean }) => {
      // 无 zipPath → 弹文件选择框（对话框归 main 侧所有，渲染层不给文件路径能力）
      let zipPath = typeof args?.zipPath === 'string' ? args.zipPath.trim() : ''
      if (!zipPath) {
        const res = await dialog.showOpenDialog({
          title: '安装插件包',
          filters: [{ name: '插件包', extensions: ['zip'] }],
          properties: ['openFile'],
        })
        if (res.canceled || res.filePaths.length === 0) {
          return { ok: false, error: 'CANCELLED', message: '已取消安装' }
        }
        zipPath = res.filePaths[0]!
      }
      const out = await installPluginFromZip({
        zipPath,
        confirmed: args?.confirmed === true,
        overwrite: args?.overwrite === true,
      })
      if (out.ok) await getPluginHostService()?.refreshIndex()
      return out
    },
  )

  ipcMain.handle(
    PluginChannel.ListCommands,
    async (_e, args?: { pluginId?: string }): Promise<PluginCommandEntry[]> => {
      const all = await declaredPluginCommands()
      const pid = typeof args?.pluginId === 'string' ? args.pluginId : ''
      return all
        .filter((x) => !pid || x.pluginId === pid)
        .map((x) => ({
          pluginId: x.pluginId,
          pluginName: x.pluginName,
          id: x.command.id,
          title: x.command.title,
          ...(x.command.icon ? { icon: x.command.icon } : {}),
          // 只有带 Host 半代码的插件才真正处理得了命令；
          // runCommand 侧还有二次校验（未激活即懒激活，激活失败如实报错）
          runnable: true,
        }))
    },
  )

  ipcMain.handle(PluginChannel.RunCommand, async (_e, args?: { pluginId?: string; commandId?: string }) => {
    const pluginId = typeof args?.pluginId === 'string' ? args.pluginId.trim() : ''
    const commandId = typeof args?.commandId === 'string' ? args.commandId.trim() : ''
    if (!pluginId || !commandId) return { ok: false, message: '参数缺失（pluginId / commandId）' }
    const svc = getPluginHostService()
    if (!svc) return { ok: false, message: '插件运行时未就绪' }
    try {
      await svc.runCommand(pluginId, commandId)
      logger.info('System', `[plugin] 命令已触发：${pluginId} / ${commandId}`)
      return { ok: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn('System', `[plugin] 命令触发失败：${pluginId} / ${commandId} — ${msg}`)
      return { ok: false, message: msg }
    }
  })
}

/** 供 host-service 装配时使用：把「上行到 UI」的出口交给它 */
export function pluginBroadcaster(): (channel: string, payload: unknown) => void {
  return broadcast
}
