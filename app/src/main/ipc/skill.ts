/* ============================================================
 * ArkWork — IPC: Skill
 * 设计文档 §4.2（F4/F7）
 *
 * 通道：skill:list / add / update / remove / toggle / import / export / read-instruction
 * 持久化由 store/skills.ts → agent/registry.ts（文件夹存储）。
 * 内置 Skill 受保护：update 仅允许改非核心字段，remove 直接抛错。
 * ============================================================ */
import { ipcMain, dialog } from 'electron'
import { stat } from 'node:fs/promises'
import { extname } from 'node:path'
import {
  listSkills,
  addSkill,
  updateSkill,
  removeSkill,
  toggleSkill,
  readInstruction,
  importSkillFromDir,
  importSkillFromMarkdown,
  importSkillFromZip,
  exportSkillToDir,
} from '../store/skills.js'
import type { SkillAddInput, SkillUpdatePatch } from '@shared/types/ipc'
import { logger } from '../system/logger.js'
import { getUiLocale, tFor } from '../i18n/messages.js'

export function registerSkillHandlers(): void {
  /** 列出全部 Skill */
  ipcMain.handle('skill:list', async () => listSkills())

  /** 新建 Skill */
  ipcMain.handle('skill:add', async (_e, input: SkillAddInput) => {
    return addSkill(input)
  })

  /** 更新 Skill */
  ipcMain.handle('skill:update', async (_e, payload: SkillUpdatePatch) => {
    return updateSkill(payload)
  })

  /** 删除 Skill */
  ipcMain.handle('skill:remove', async (_e, payload: { id: string }) => {
    await removeSkill(payload.id)
    logger.info('System', `skill removed via IPC: ${payload.id}`)
  })

  /** 切换 Skill 启用状态 */
  ipcMain.handle(
    'skill:toggle',
    async (_e, payload: { id: string; enabled: boolean }) => {
      await toggleSkill(payload.id, payload.enabled)
    },
  )

  /** 读取 SKILL.md 指令体 */
  ipcMain.handle('skill:read-instruction', async (_e, payload: { id: string }) => {
    return readInstruction(payload.id)
  })

  /**
   * 导入 Skill。
   * v0.8.0：支持目录（含 skill.json）/ Markdown 文件 / ZIP 文件三种来源。
   * payload.filePath 为空时弹出原生选择器（同时允许选目录或文件）。
   * 兼容旧 payload.dirPath 字段。
   */
  ipcMain.handle(
    'skill:import',
    async (_e, payload: { dirPath?: string; filePath?: string }) => {
      let filePath = payload.filePath ?? payload.dirPath
      if (!filePath) {
        const locale = getUiLocale()
        const result = await dialog.showOpenDialog({
          title: tFor(locale, 'dialog.pickSkillTitle'),
          properties: ['openFile', 'openDirectory'],
          filters: [
            { name: tFor(locale, 'dialog.skillPackageName'), extensions: ['md', 'markdown', 'zip'] },
            { name: tFor(locale, 'dialog.allFiles'), extensions: ['*'] },
          ],
        })
        if (result.canceled || result.filePaths.length === 0) {
          throw new Error(tFor(locale, 'error.userCanceledPick'))
        }
        filePath = result.filePaths[0]
      }
      const stats = await stat(filePath)
      if (stats.isDirectory()) {
        return importSkillFromDir(filePath)
      }
      const ext = extname(filePath).toLowerCase()
      if (ext === '.md' || ext === '.markdown') {
        return importSkillFromMarkdown(filePath)
      }
      if (ext === '.zip') {
        return importSkillFromZip(filePath)
      }
      throw new Error(tFor(getUiLocale(), 'error.unsupportedSkillFileType', { ext: ext || tFor(getUiLocale(), 'error.noExtension') }))
    },
  )

  /**
   * 导出 Skill。
   * v0.16.5：单内容技能导出为目录，多内容技能打包为 zip。
   * payload.targetDir 为空时弹出原生目录选择器。
   * 返回 { path, isZip, fileCount } 让前端展示精确的导出位置。
   */
  ipcMain.handle(
    'skill:export',
    async (_e, payload: { id: string; targetDir?: string }) => {
      let targetDir = payload.targetDir
      if (!targetDir) {
        const locale = getUiLocale()
        const result = await dialog.showOpenDialog({
          title: tFor(locale, 'dialog.pickExportDirTitle'),
          properties: ['openDirectory'],
        })
        if (result.canceled || result.filePaths.length === 0) {
          throw new Error(tFor(locale, 'error.userCanceledPickDir'))
        }
        targetDir = result.filePaths[0]
      }
      return exportSkillToDir(payload.id, targetDir)
    },
  )
}
