/* ============================================================
 * ArkWork — IPC: Filesystem
 * 设计文档 §5.2 / §5.3
 * ============================================================ */
import { ipcMain, shell } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { listTaskFiles, readFileInTask, writeFileInTask } from '../memory/l2-file.js'
import { readTextFile, writeTextFile, listTree } from '../fs/workspace.js'
import { getWorkspaceDir } from '../store/db.js'
import { logger } from '../system/logger.js'
import { getArtifactsDir, validateArtifactPath } from '../fs/artifacts.js'
import { cleanArkworkTemp, getArkworkSize } from '../fs/cleanup.js'
import { getSettings, saveSettings } from './settings.js'
// v0.29.0 F6：用户可见校验错误四语言化
import { getUiLocale, tFor } from '../i18n/messages.js'
// v0.31.0 B2：编辑器文件能力（路径边界已提升为共享实现，见 fs/guard.ts）
import { assertInWorkspace, assertWritableTarget, isInsideRoot } from '../fs/guard.js'
import { probeText, readText } from '../fs/text.js'
import { hashFile, writeText } from '../fs/write.js'
// v0.31.0 B5：文件能力 P1（扁平清单 + chokidar 监听）
import { listWorkspacePaths } from '../fs/paths.js'
import { startWatching, stopWatching, watchStatus } from '../fs/watch.js'
// fs:batch 的 M→R 广播走 window.broadcast（与 task:text-delta 同一推送面）
import { broadcast as broadcastToWindows } from '../window.js'
import { throwEncodedFsError } from '@shared/utils/fs-error'
import type { FsErrorCode, TextProbe, WriteTextRequest } from '@shared/types/fs'

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

  /**
   * ⚠️ **简单写**（保留至旧调用方迁移完毕，§5.1 变更表）：
   * 直写、不原子、不探测编码、不检测冲突。
   * **编辑器保存必须走 `fs:write-text`**；agent 写盘路径刻意不动（J2）。
   */
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
      const from = await assertInWorkspace(payload.path)
      const newName = payload.newName?.trim()
      if (!newName) throw new Error(tFor(getUiLocale(), 'fs.renameEmpty'))
      if (/[\\/]/.test(newName)) throw new Error(tFor(getUiLocale(), 'fs.renameHasSeparator'))
      const to = resolve(from, '..', newName)
      await assertInWorkspace(to)
      if (existsSync(to)) throw new Error(tFor(getUiLocale(), 'fs.renameExists', { name: newName }))
      await rename(from, to)
      logger.info('Tool', `fs:rename ${from} → ${to}`)
      return { path: to }
    },
  )

  // v0.9.1：删除到系统回收站（可恢复，不硬删）
  ipcMain.handle('fs:delete', async (_e, path: string) => {
    const target = await assertInWorkspace(path)
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

  /* ============================================================
   * v0.31.0 B2 — 编辑器文件能力（§5.1 新增频道）
   *
   * 统一纪律：
   *  ① 写类频道一律先过 `assertInWorkspace`（fs/guard.ts，全仓库唯一实现）；
   *  ② 抛错一律经 `throwEncodedFsError` 包装 —— Electron 只序列化 Error.message，
   *     不包装则 `code` / `ConflictInfo` 载荷全部丢失，渲染层无法分支。
   * ============================================================ */

  /** 单路径 stat（= probe 的轻量子集；保留 TextProbe 形状避免第二套类型） */
  ipcMain.handle('fs:stat-path', async (_e, path: string): Promise<TextProbe> => {
    try {
      await assertInWorkspace(path)
      return await probeText(path)
    } catch (err) {
      throwEncodedFsError(err)
    }
  })

  /** 编码 / EOL / BOM / 只读原因 / 快速哈希探测 */
  ipcMain.handle('fs:probe-text', async (_e, path: string): Promise<TextProbe> => {
    try {
      await assertInWorkspace(path)
      return await probeText(path)
    } catch (err) {
      throwEncodedFsError(err)
    }
  })

  /** 读文本 + probe —— **编辑器打开的唯一入口**（§5.2） */
  ipcMain.handle('fs:read-text', async (_e, path: string) => {
    try {
      await assertInWorkspace(path)
      return await readText(path)
    } catch (err) {
      throwEncodedFsError(err)
    }
  })

  /** 原子写 + CAS 冲突检测 + 编码保真（§6.3） */
  ipcMain.handle('fs:write-text', async (_e, req: WriteTextRequest) => {
    try {
      return await writeText(req)
    } catch (err) {
      const code = (err as { code?: FsErrorCode }).code
      if (code === 'E_CONFLICT') {
        logger.info('Tool', `fs:write-text conflict: ${req?.path}`)
      } else if (code === 'E_WRITE_FAILED') {
        logger.error('Tool', `fs:write-text failed: ${(err as Error).message}`)
      }
      throwEncodedFsError(err)
    }
  })

  /** 单文件快速哈希（"另存恢复"等场景校验；与 writeText 的 revision 同口径） */
  ipcMain.handle('fs:hash-file', async (_e, path: string): Promise<string> => {
    try {
      return await hashFile(path)
    } catch (err) {
      throwEncodedFsError(err)
    }
  })

  /* ============================================================
   * v0.31.0 B5 — 文件能力 P1（§5.1 频道 5~12）
   *
   * 纪律：
   *  ① 写类频道（create-file / create-folder / move）一律 assertWritableTarget
   *     （边界 + .arkwork 保留区，复用 guard 唯一实现，不另写 startsWith）；
   *  ② 名称校验复用 rename 的既有键（renameEmpty / renameHasSeparator）；
   *  ③ watch 的广播函数注入 window.broadcast —— fs/watch.ts 本身不 import electron
   *     （node:test 可密闭单测），electron 只在本 IPC 层出现。
   * ============================================================ */

  /** 表项名校验（create-file / create-folder 共用）：非空 + 无路径分隔符 */
  const requireEntryName = (raw: unknown): string => {
    const name = typeof raw === 'string' ? raw.trim() : ''
    if (!name) throw new Error(tFor(getUiLocale(), 'fs.renameEmpty'))
    if (/[\\/]/.test(name)) throw new Error(tFor(getUiLocale(), 'fs.renameHasSeparator'))
    return name
  }

  /** 新建文件（先落盘再打开，无 Untitled 态 —— J6）：空文件 + utf-8 */
  ipcMain.handle(
    'fs:create-file',
    async (_e, payload: { parentDir: string; name: string }): Promise<{ path: string }> => {
      try {
        const name = requireEntryName(payload?.name)
        const parent = await assertWritableTarget(payload?.parentDir ?? '')
        const target = resolve(parent, name)
        if (existsSync(target)) {
          throw new Error(tFor(getUiLocale(), 'fs.targetExists', { path: name }))
        }
        await writeFile(target, '', 'utf-8')
        logger.info('Tool', `fs:create-file ${target}`)
        return { path: target }
      } catch (err) {
        throwEncodedFsError(err)
      }
    },
  )

  /** 新建文件夹（父目录必须已存在；目标不得已存在） */
  ipcMain.handle(
    'fs:create-folder',
    async (_e, payload: { parentDir: string; name: string }): Promise<{ path: string }> => {
      try {
        const name = requireEntryName(payload?.name)
        const parent = await assertWritableTarget(payload?.parentDir ?? '')
        const target = resolve(parent, name)
        if (existsSync(target)) {
          throw new Error(tFor(getUiLocale(), 'fs.targetExists', { path: name }))
        }
        await mkdir(target)
        logger.info('Tool', `fs:create-folder ${target}`)
        return { path: target }
      } catch (err) {
        throwEncodedFsError(err)
      }
    },
  )

  /**
   * 树内拖拽移动 / 重命名。契约：`to` 是**完整目标路径**
   * （渲染层 join(destDir, name) 后传入，本频道不猜意图）。
   * 拒绝：目标已存在、目录移入自身或其子目录。
   */
  ipcMain.handle(
    'fs:move',
    async (_e, payload: { from: string; to: string }): Promise<{ path: string }> => {
      try {
        const from = await assertWritableTarget(payload?.from ?? '')
        const to = await assertWritableTarget(payload?.to ?? '')
        if (!existsSync(from)) {
          throw new Error(tFor(getUiLocale(), 'fs.fileNotFound', { path: payload.from }))
        }
        if (existsSync(to)) {
          throw new Error(tFor(getUiLocale(), 'fs.targetExists', { path: payload.to }))
        }
        if (isInsideRoot(from, to)) {
          throw new Error(tFor(getUiLocale(), 'fs.moveIntoItself'))
        }
        await rename(from, to)
        logger.info('Tool', `fs:move ${from} → ${to}`)
        return { path: to }
      } catch (err) {
        throwEncodedFsError(err)
      }
    },
  )

  /** 扁平路径清单（QuickOpen 候选；ignore 与 chokidar 共用同一份配置 —— TC-WATCH-010） */
  ipcMain.handle(
    'fs:list-paths',
    async (_e, opts?: { root?: string; limit?: number }) => {
      try {
        const root = opts?.root ? await assertInWorkspace(opts.root) : getWorkspaceDir()
        return await listWorkspacePaths(root, { limit: opts?.limit })
      } catch (err) {
        throwEncodedFsError(err)
      }
    },
  )

  /** 启动监听，返回首个快照（E_WATCH_INIT → 渲染层进手动刷新横幅，禁止静默降级 —— A18） */
  ipcMain.handle(
    'fs:watch-start',
    async (_e, opts?: { root?: string }) => {
      try {
        const root = opts?.root ? await assertInWorkspace(opts.root) : getWorkspaceDir()
        return await startWatching({
          root,
          broadcast: (e) => broadcastToWindows('fs:batch', e),
        })
      } catch (err) {
        throwEncodedFsError(err)
      }
    },
  )

  ipcMain.handle('fs:watch-stop', async () => {
    await stopWatching()
  })

  ipcMain.handle('fs:watch-status', async () => {
    return watchStatus()
  })
}
