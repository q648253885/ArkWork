/* ============================================================
 * ArkWork — IPC: Permission Model (v0.15.0)
 * 设计文档 §01-shell-permission-redesign
 * ============================================================ */
import { ipcMain, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { getArkworkDir, getWorkspaceDir } from '../store/db.js'
import { evaluatePermission, type PermissionDecision } from '../agent/permissions.js'
import { loadPermissionSettings } from '../agent/settings-loader.js'
import { getSessionMode, setSessionMode, normalizeMode } from '../agent/session-mode.js'
import { PermissionChannel } from '@shared/types/ipc'
import type { PermissionMode, ResolvedRules } from '@shared/types/permission'
import { logger } from '../system/logger.js'

/** 当前 workspace 的会话级 PermissionMode（未切换时 undefined → 回退配置 defaultMode） */
export function currentSessionMode(): PermissionMode | undefined {
  return getSessionMode(getWorkspaceDir())
}

export async function resolveEffectiveRules(): Promise<ResolvedRules> {
  const ws = getWorkspaceDir()
  const settings = await loadPermissionSettings(ws)
  return {
    defaultMode: settings.defaultMode,
    allow: settings.allow.map((r) => r.raw),
    ask: settings.ask.map((r) => r.raw),
    deny: settings.deny.map((r) => r.raw),
    protectedPaths: [],
    additionalDirectories: [],
  }
}

export async function evaluateShellPermission(
  command: string,
  cwd: string,
): Promise<PermissionDecision> {
  const ws = getWorkspaceDir()
  const settings = await loadPermissionSettings(ws)
  // 会话模式优先，未切换时回退配置文件 defaultMode
  const mode = getSessionMode(ws) ?? settings.defaultMode
  return evaluatePermission({
    command,
    cwd,
    workspaceDir: ws,
    mode,
    rules: {
      allow: settings.allow.map((r) => r.raw),
      ask: settings.ask.map((r) => r.raw),
      deny: settings.deny.map((r) => r.raw),
    },
  })
}

export function registerPermissionHandlers(): void {
  ipcMain.handle(PermissionChannel.GetMode, async (): Promise<PermissionMode> => {
    const ws = getWorkspaceDir()
    const settings = await loadPermissionSettings(ws)
    return getSessionMode(ws) ?? settings.defaultMode
  })

  ipcMain.handle(
    PermissionChannel.SetMode,
    async (_e, mode: PermissionMode): Promise<PermissionMode> => {
      const normalized = normalizeMode(mode)
      if (!normalized) {
        throw new Error(`Invalid PermissionMode: ${String(mode)}`)
      }
      const ws = getWorkspaceDir()
      setSessionMode(ws, normalized)
      // 广播给 renderer
      BrowserWindow.getAllWindows().forEach((w) => {
        w.webContents.send('permission:mode-changed', { mode: normalized })
      })
      return normalized
    },
  )

  ipcMain.handle(PermissionChannel.ResolveRules, async (): Promise<ResolvedRules> => {
    return resolveEffectiveRules()
  })

  // v0.15.0：把一条规则追加写入 .arkwork/settings.local.json（仅 allow 规则，供「总是允许」使用）
  ipcMain.handle(
    PermissionChannel.AddRule,
    async (_e, payload: { rule: string; scope?: 'allow' }): Promise<void> => {
      const rule = (payload.rule ?? '').trim()
      if (!rule) return
      const ws = getWorkspaceDir()
      const localPath = join(ws, '.arkwork', 'settings.local.json')
      let settings: { permissions?: { allow?: string[] } } = {}
      if (existsSync(localPath)) {
        try {
          settings = JSON.parse(await readFile(localPath, 'utf-8')) as typeof settings
        } catch (err) {
          logger.warn('System', `permission:addRule parse failed: ${(err as Error).message}`)
          settings = {}
        }
      }
      settings.permissions = settings.permissions ?? {}
      settings.permissions.allow = settings.permissions.allow ?? []
      if (!settings.permissions.allow.includes(rule)) {
        settings.permissions.allow.push(rule)
      }
      await mkdir(join(ws, '.arkwork'), { recursive: true })
      await writeFile(localPath, JSON.stringify(settings, null, 2), 'utf-8')
    },
  )
}