/* ============================================================
 * ArkWork — IPC: Plugin Registry（插件插拔能力 · v0.33.0）
 * 设计文档：docs/versions/v0.33.0/04-system-design.md §9.2
 *           正本 `workbench-profile-v1.0/04-宿主插槽与UI扩展体系.md` §2–§5
 *
 * 六条 invoke + 一条广播：
 *   list / set-enabled / uninstall / rescan / open-dir / export-sample
 *   + main→renderer `plugin:changed`
 *
 * 纪律：
 *  ① **失败不抛**（除编程错误）—— 一律返回 `{ok:false, reason}`，UI 逐条展示；
 *  ② **插拔即时生效** —— 任何改变启用集合的操作都必须调用 `refreshPluginSlots()`
 *     （它只清 `plugin` 来源，不动 profile/builtin，见 D42），然后广播
 *     `plugin:changed`，renderer 据此免重启刷新；
 *  ③ `open-dir` / `export-sample` 涉及文件系统与 `shell`，只做「打开/写样例」，
 *     不读任意用户路径（杜绝把 IPC 变成任意文件读）；
 *  ④ 单个坏插件**不阻断启动**（注册表逐插件独立校验，见 registry.ts）。
 * ============================================================ */
import { BrowserWindow, ipcMain, shell } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PluginChannel } from '@shared/types/ipc'
import type { PluginSummary } from '@shared/types/plugin'
import {
  builtinManifestForExport,
  invalidatePlugins,
  listPlugins,
  pluginSummaries,
  refreshPluginSlots,
  setPluginEnabled,
  uninstallPlugin,
} from '../plugins/registry.js'
import { ensurePluginsDir, pluginsDir } from '../plugins/store.js'
import { logger } from '../system/logger.js'

/** 插件集合或启停态变化 → 所有窗口刷新（插槽已重建，UI 免重启） */
function broadcastPluginChanged(pluginId: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(PluginChannel.Changed, { pluginId })
  }
}

export function registerPluginHandlers(): void {
  /* ---------- 列表 ---------- */
  ipcMain.handle(PluginChannel.List, async (): Promise<PluginSummary[]> => pluginSummaries(await listPlugins()))

  /* ---------- 启停 ---------- */
  ipcMain.handle(PluginChannel.SetEnabled, async (_e, args: { id: string; enabled: boolean }) => {
    const id = String(args?.id ?? '')
    if (!id) return { ok: false, reason: 'bad-args' }
    const res = await setPluginEnabled(id, args?.enabled !== false)
    if (res.ok) broadcastPluginChanged(id)
    return res
  })

  /* ---------- 卸载（内置会被拒） ---------- */
  ipcMain.handle(PluginChannel.Uninstall, async (_e, args: { id: string }) => {
    const id = String(args?.id ?? '')
    if (!id) return { ok: false, reason: 'bad-args' }
    const res = await uninstallPlugin(id)
    if (res.ok) broadcastPluginChanged(id)
    return res
  })

  /* ---------- 重扫（文件系统外部改动后手动刷新） ---------- */
  ipcMain.handle(PluginChannel.Rescan, async (): Promise<PluginSummary[]> => {
    invalidatePlugins()
    await refreshPluginSlots()
    const out = pluginSummaries(await listPlugins())
    broadcastPluginChanged('*')
    return out
  })

  /* ---------- 打开插件目录 ---------- */
  ipcMain.handle(PluginChannel.OpenDir, async () => {
    const dir = ensurePluginsDir()
    try {
      await shell.openPath(dir)
      return { ok: true, path: dir }
    } catch (err) {
      logger.warn('System', `[plugin] 打开目录失败：${String(err)}`)
      return { ok: false, path: dir }
    }
  })

  /* ---------- 导出内置样例（作者脚手架） ---------- */
  ipcMain.handle(PluginChannel.ExportSample, async (_e, args: { id: string }) => {
    const id = String(args?.id ?? '')
    const manifest = builtinManifestForExport(id)
    if (!manifest) return { ok: false, reason: 'not-found' }
    const root = ensurePluginsDir()
    // 目录名用 id 的末段（`ark.plugin.workbench-guide` → `workbench-guide`），
    // 与 `store.ts` 的扫描约定一致（见 `scanUserPlugins`）
    const short = manifest.id.split('.').pop() ?? manifest.id
    const dir = join(root, `${short}.sample`)
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const file = join(dir, 'plugin.json')
      writeFileSync(file, JSON.stringify(manifest, null, 2), 'utf-8')
      // 顺手放一份 README，说明「复制到 plugins/<你的插件名>/plugin.json 即可生效」
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
            `1. 在 ${pluginsDir()} 下新建目录，例如 \`my-plugin/\`；`,
            '2. 把本目录的 `plugin.json` 复制进去并改 `id` / `name` / `provides`；',
            '3. 回到 ArkWork 的「工作台中心 → 插件」点「重新扫描」。',
            '',
            '> 插件不能注入任意代码：面板只能引用宿主组件白名单，数据只能是 static/file/mcp。',
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
}
