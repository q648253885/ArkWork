/* ============================================================
 * ArkWork — IPC: Filesystem
 * 设计文档 §5.2 / §5.3
 * ============================================================ */
import { ipcMain, shell } from 'electron'
import { existsSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { listTaskFiles, readFileInTask, writeFileInTask } from '../memory/l2-file.js'
import { readTextFile, writeTextFile, listTree } from '../fs/workspace.js'
import { getWorkspaceDir } from '../store/db.js'
import { logger } from '../system/logger.js'
import { getArtifactsDir, validateArtifactPath } from '../fs/artifacts.js'
import { cleanArkworkTemp, getArkworkSize } from '../fs/cleanup.js'
import { getSettings, saveSettings } from './settings.js'
// v0.29.0 F6：用户可见校验错误四语言化
import { getUiLocale, tFor } from '../i18n/messages.js'

/** v0.9.1：文件操作安全边界——仅允许工作区内的路径，防止越界删改 */
function assertInWorkspace(absPath: string): string {
  const ws = resolve(getWorkspaceDir())
  const target = resolve(absPath)
  if (target !== ws && !target.startsWith(ws + sep)) {
    throw new Error(tFor(getUiLocale(), 'fs.pathOutsideWorkspace', { path: absPath }))
  }
  return target
}

export function registerFsHandlers(): void {
  ipcMain.handle('fs:list-files', async (_e, taskId?: string) => {
    try {
      if (taskId) return await listTaskFiles(taskId)
      const ws = getWorkspaceDir()
      if (!existsSync(ws)) return []
      return await listTree(ws, { maxDepth: 5, ignore: ['.git', '.arkwork'] })
    } catch (err) {
      logger.error('Tool', `fs:list-files failed: ${(err as Error).message}`, taskId)
      return []
    }
  })

  ipcMain.handle('fs:read-file', async (_e, path: string) => {
    return readTextFile(path)
  })

  // v0.6.3：在系统文件管理器中显示文件所在位置（参考 WorkBuddy「打开文件夹」）
  ipcMain.handle('fs:reveal-in-folder', async (_e, path: string) => {
    shell.showItemInFolder(path)
  })

  ipcMain.handle(
    'fs:write-file',
    async (_e, payload: { path: string; content: string }) => {
      await writeTextFile(payload.path, payload.content)
    },
  )

  // v0.9.1：重命名（仅工作区内，目标不能已存在）
  ipcMain.handle(
    'fs:rename',
    async (_e, payload: { path: string; newName: string }) => {
      const from = assertInWorkspace(payload.path)
      const newName = payload.newName?.trim()
      if (!newName) throw new Error(tFor(getUiLocale(), 'fs.renameEmpty'))
      if (/[\\/]/.test(newName)) throw new Error(tFor(getUiLocale(), 'fs.renameHasSeparator'))
      const to = resolve(from, '..', newName)
      assertInWorkspace(to)
      if (existsSync(to)) throw new Error(tFor(getUiLocale(), 'fs.renameExists', { name: newName }))
      await rename(from, to)
      logger.info('Tool', `fs:rename ${from} → ${to}`)
      return { path: to }
    },
  )

  // v0.9.1：删除到系统回收站（可恢复，不硬删）
  ipcMain.handle('fs:delete', async (_e, path: string) => {
    const target = assertInWorkspace(path)
    if (!existsSync(target)) throw new Error(tFor(getUiLocale(), 'fs.fileNotFound', { path }))
    await shell.trashItem(target)
    logger.info('Tool', `fs:delete (trash) ${target}`)
  })

  // 任务工作目录读写（用于 file-reader skill 的相对路径解析）
  ipcMain.handle(
    'fs:read-task-file',
    async (_e, payload: { taskId: string; path: string }) => {
      return readFileInTask(payload.taskId, payload.path)
    },
  )

  ipcMain.handle(
    'fs:write-task-file',
    async (_e, payload: { taskId: string; path: string; content: string }) => {
      await writeFileInTask(payload.taskId, payload.path, payload.content)
    },
  )

  // v0.15.x Task 3：用户产物目录与 .arkwork 临时目录治理

  /** 返回当前产物目录（优先 settings.artifactsDir，否则 {workspaceDir}/docs） */
  ipcMain.handle('fs:get-artifacts-dir', async () => {
    return getArtifactsDir()
  })

  /**
   * 设置产物目录并写入 settings.artifactsDir。
   * 传入空字符串表示恢复默认（{workspaceDir}/docs）。
   * 非空路径校验不得位于 .arkwork 下（防止污染 Agent 自身内容区域）。
   * 返回写入后的实际产物目录。
   */
  ipcMain.handle('fs:set-artifacts-dir', async (_e, dir: string) => {
    const target = typeof dir === 'string' ? dir.trim() : ''
    if (target) {
      validateArtifactPath(target)
    }
    const current = await getSettings()
    await saveSettings({ ...current, artifactsDir: target })
    logger.info('Tool', `fs:set-artifacts-dir → ${target || '(default {workspaceDir}/docs)'}`)
    return getArtifactsDir()
  })

  /** 手动触发 .arkwork 临时文件清理（保守策略：仅 temp/cache/logs 子目录） */
  ipcMain.handle('fs:clean-arkwork-temp', async (_e, maxAgeDays?: number) => {
    const result = await cleanArkworkTemp(maxAgeDays)
    logger.info('Tool', `fs:clean-arkwork-temp: cleaned ${result.cleaned.length}, skipped ${result.skipped.length}`)
    return result
  })

  /** 获取 .arkwork 目录总大小（字节） */
  ipcMain.handle('fs:get-arkwork-size', async () => {
    return getArkworkSize()
  })
}
