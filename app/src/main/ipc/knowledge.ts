/* ============================================================
 * ArkWork — IPC: Knowledge Base (v0.8.0)
 * 通道：kb:list / add / remove / import / rename / reimport / search / set-enabled
 * 持久化由 kb/store.ts 负责，解析由 kb/parse.ts，索引由 kb/index.ts。
 * 设计文档：versions/v0.8.0/02-knowledge-base.md §3-§5
 * ============================================================ */
import { ipcMain, BrowserWindow, dialog } from 'electron'
import { join } from 'node:path'
import { copyFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import {
  listKb,
  addKbEntry,
  removeKb,
  renameKb,
  setKbEnabled,
  saveChunks,
  markParseError,
  clearChunksByKbId,
  getKb,
  kbFilePath,
  filesDirAbs,
} from '../kb/store.js'
import { parseFile, detectFormat, fileExt, MAX_FILE_SIZE } from '../kb/parse.js'
import { chunkText, addToIndex, searchKb, rebuildKbIndex, initKbIndex } from '../kb/index.js'
import { logger } from '../system/logger.js'
import type { KbAddInput, KbImportProgress, KbSearchResult } from '@shared/types/ipc'
import { getUiLocale, tFor } from '../i18n/messages.js'

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

function broadcastChanged(): void {
  broadcast('kb:changed', undefined)
}

function broadcastProgress(progress: KbImportProgress): void {
  broadcast('kb:import-progress', progress)
}

export function registerKnowledgeHandlers(): void {
  /** 列出所有知识库条目（v0.8.0 走新 kb/store） */
  ipcMain.handle('kb:list', async () => listKb())

  /**
   * 添加知识库条目（元数据模式，不解析内容）。
   * Task 15 修复：此前 kb:add 写旧 legacy knowledge.json、kb:list 读新 kb.json，
   * 导致经 kb:add 添加的条目列表不可见。现统一写入新 kb/store，与 kb:list 同源；
   * 未提供源文件内容的条目标记"需重新导入解析"。
   */
  ipcMain.handle('kb:add', async (_e, input: KbAddInput) => {
    const name = input.name?.trim() || (input.path?.split(/[/\\]/).filter(Boolean).pop() ?? '未命名')
    const ext = (name.split('.').pop() ?? 'unknown').toLowerCase()
    const entry = await addKbEntry({ name, ext, size: input.size ?? 0 })
    if (!input.path) {
      await markParseError(entry.id, tFor(getUiLocale(), 'kb.legacyEntryError'))
    }
    broadcastChanged()
    return entry
  })

  /** 删除知识库条目（含切块与原文文件） */
  ipcMain.handle('kb:remove', async (_e, payload: { id: string }) => {
    await removeKb(payload.id)
    logger.info('System', `knowledge removed via IPC: ${payload.id}`)
    broadcastChanged()
  })

  /**
   * F810 打开文件选择对话框（主进程侧，返回选中的文件路径数组）。
   * 设计：renderer 不直接调 electron.dialog，通过 IPC 调用主进程。
   */
  ipcMain.handle('kb:pick-files', async () => {
    const locale = getUiLocale()
    const result = await dialog.showOpenDialog({
      title: tFor(locale, 'dialog.importKbTitle'),
      filters: [
        { name: tFor(locale, 'dialog.documentFiles'), extensions: ['pdf', 'docx', 'txt', 'md', 'markdown'] },
      ],
      properties: ['openFile', 'multiSelections'],
    })
    return result.canceled ? [] : result.filePaths
  })

  /**
   * F810 导入文件（文件路径数组，由 kb:pick-files 选出后传入）。
   * 解析→切块→索引→写清单，全程推送进度，失败不中断后续文件。
   * @returns { imported, failed }
   */
  ipcMain.handle('kb:import', async (_e, filePaths: string[]) => {
    await initKbIndex()
    let imported = 0
    let failed = 0

    for (const filePath of filePaths) {
      const filename = filePath.split(/[/\\]/).pop() ?? filePath
      const format = detectFormat(filename)
      const ext = fileExt(filename)

      // 格式检查
      if (format === 'unknown') {
        failed++
        broadcastProgress({ name: filename, status: 'failed', error: `不支持的格式（仅支持 pdf/docx/txt/md）` })
        continue
      }

      // 大小检查
      try {
        const st = await stat(filePath)
        if (st.size > MAX_FILE_SIZE) {
          failed++
          broadcastProgress({ name: filename, status: 'failed', error: `文件超过 20MB 限制` })
          continue
        }
      } catch (err) {
        failed++
        broadcastProgress({ name: filename, status: 'failed', error: `无法读取文件：${(err as Error).message}` })
        continue
      }

      broadcastProgress({ name: filename, status: 'parsing' })

      // Task 7：先集中存储原文再解析——解析失败也落库（markParseError），
      // 保证列表出现"失败"徽标 + 重试入口（kb:reimport 用集中存储的原文重试）。
      const st = await stat(filePath)
      const entry = await addKbEntry({ name: filename, ext, size: st.size })
      try {
        await copyFile(filePath, kbFilePath(entry.id, ext))
      } catch (err) {
        failed++
        await markParseError(entry.id, `原文复制失败：${(err as Error).message}`)
        broadcastProgress({ name: filename, status: 'failed', error: '原文复制失败' })
        broadcastChanged()
        continue
      }

      // 解析
      const parseResult = await parseFile(filePath, format)
      if (parseResult.error || !parseResult.text.trim()) {
        failed++
        const error = parseResult.error || tFor(getUiLocale(), 'kb.parseEmpty')
        await markParseError(entry.id, error)
        broadcastProgress({ name: filename, status: 'failed', error })
        broadcastChanged()
        continue
      }

      broadcastProgress({ name: filename, status: 'indexing' })

      // 切块 + 索引
      const chunks = chunkText(parseResult.text, entry.id)
      await saveChunks(entry.id, chunks)
      addToIndex(entry.id, entry.name, chunks)

      broadcastProgress({ name: filename, status: 'done', chunks: chunks.length })
      imported++
    }

    broadcastChanged()
    return { imported, failed }
  })

  /** 重命名知识库条目 */
  ipcMain.handle('kb:rename', async (_e, payload: { id: string; newName: string }) => {
    await renameKb(payload.id, payload.newName)
    broadcastChanged()
  })

  /**
   * F811 重导入（重新解析 + 切块 + 索引）。
   * 用于旧条目迁移后激活、或源文件更新后刷新。
   */
  ipcMain.handle('kb:reimport', async (_e, payload: { id: string }) => {
    const entry = await getKb(payload.id)
    if (!entry) throw new Error(tFor(getUiLocale(), 'kb.entryNotFound', { id: payload.id }))

    const absPath = join(filesDirAbs(), `${entry.id}.${entry.type}`)
    if (!existsSync(absPath)) {
      throw new Error(tFor(getUiLocale(), 'kb.sourceFileMissing', { path: absPath }))
    }

    broadcastProgress({ name: entry.name, status: 'parsing' })

    const format = detectFormat(entry.name)
    const parseResult = await parseFile(absPath, format)
    if (parseResult.error || !parseResult.text.trim()) {
      const error = parseResult.error || tFor(getUiLocale(), 'kb.parseEmpty')
      await markParseError(entry.id, error)
      broadcastProgress({ name: entry.name, status: 'failed', error })
      broadcastChanged()
      throw new Error(error)
    }

    broadcastProgress({ name: entry.name, status: 'indexing' })

    // 先清旧切块再重新写
    await clearChunksByKbId(entry.id)
    const chunks = chunkText(parseResult.text, entry.id)
    await saveChunks(entry.id, chunks)
    // 索引重建（增量删除复杂，直接重建最稳）
    await rebuildKbIndex()

    broadcastProgress({ name: entry.name, status: 'done', chunks: chunks.length })
    broadcastChanged()
    return { chunks: chunks.length }
  })

  /**
   * F812 检索知识库。
   * @param payload - { query, kbIds?, limit? }
   */
  ipcMain.handle('kb:search', async (_e, payload: { query: string; kbIds?: string[] | null; limit?: number }) => {
    const hits = await searchKb(payload.query, payload.kbIds ?? null, payload.limit ?? 5)
    const result: KbSearchResult = {
      hits,
      total: hits.length,
    }
    return result
  })

  /** 切换 enabled 开关 */
  ipcMain.handle('kb:set-enabled', async (_e, payload: { id: string; enabled: boolean }) => {
    await setKbEnabled(payload.id, payload.enabled)
    broadcastChanged()
  })
}
