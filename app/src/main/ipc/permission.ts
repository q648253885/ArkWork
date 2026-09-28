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
import { loadPermissionSettings, loadRuleScopes } from '../agent/settings-loader.js'
import { listRuleEntries } from '../agent/rules.js'
import { getSessionMode, setSessionMode, normalizeMode } from '../agent/session-mode.js'
import { PermissionChannel } from '@shared/types/ipc'
import type {
  PermissionMode,
  PermissionRuleBehavior,
  PermissionRuleEntry,
  ResolvedRules,
} from '@shared/types/permission'
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

  /* ============================================================
   * ★ v0.36.0（F6.1 / P9）：规则面板的三条新通道
   *
   * 写权限边界（唯一）：只有 `local`（`<ws>/.arkwork/settings.local.json`）可写。
   * `managed` 由管理员下发、`project`/`user` 由用户手写文件 —— 从 UI 改它们
   * 只会被下次读取覆盖，属「改了也没用」的静默陷阱，因此**主进程直接拒绝**，
   * 而不是让界面先改再悄悄回滚。
   * ============================================================ */

  ipcMain.handle(PermissionChannel.ListRules, async (): Promise<PermissionRuleEntry[]> => {
    const scopes = await loadRuleScopes(getWorkspaceDir())
    return listRuleEntries(scopes)
  })

  ipcMain.handle(
    PermissionChannel.AddRule,
    async (_e, payload: { rule: string; behavior?: PermissionRuleBehavior }): Promise<void> => {
      const rule = (payload.rule ?? '').trim()
      if (!rule) return
      const behavior: PermissionRuleBehavior = payload.behavior ?? 'allow'
      await mutateLocalPermissions((permissions) => {
        const list = Array.isArray(permissions[behavior]) ? (permissions[behavior] as string[]) : []
        if (!list.includes(rule)) list.push(rule)
        permissions[behavior] = list
        // 重新添加 = 用户明确要它生效 → 一并解除关停（否则会出现「加了却还是不生效」）
        permissions.disabled = (Array.isArray(permissions.disabled) ? permissions.disabled : []).filter(
          (r) => r !== rule,
        )
      })
    },
  )

  ipcMain.handle(
    PermissionChannel.RemoveRule,
    async (_e, payload: { rule: string; behavior: PermissionRuleBehavior }): Promise<void> => {
      const rule = (payload.rule ?? '').trim()
      if (!rule) return
      await mutateLocalPermissions((permissions, scopes) => {
        if (!isLocalRule(scopes, rule, payload.behavior)) {
          throw new Error(`只有本工作区的自定义规则可以删除：${rule}`)
        }
        permissions[payload.behavior] = (permissions[payload.behavior] ?? []).filter((r) => r !== rule)
        permissions.disabled = (permissions.disabled ?? []).filter((r) => r !== rule)
      })
    },
  )

  ipcMain.handle(
    PermissionChannel.SetRuleEnabled,
    async (_e, payload: { rule: string; behavior: PermissionRuleBehavior; enabled: boolean }): Promise<void> => {
      const rule = (payload.rule ?? '').trim()
      if (!rule) return
      await mutateLocalPermissions((permissions, scopes) => {
        if (!isLocalRule(scopes, rule, payload.behavior)) {
          throw new Error(`只有本工作区的自定义规则可以开关：${rule}`)
        }
        const disabled = new Set(permissions.disabled ?? [])
        if (payload.enabled) disabled.delete(rule)
        else disabled.add(rule)
        permissions.disabled = [...disabled]
      })
    },
  )
}

/** `settings.local.json` 的 `permissions` 段（只声明我们真正会写的字段） */
interface LocalPermissions {
  allow?: string[]
  ask?: string[]
  deny?: string[]
  disabled?: string[]
}

/** 判断某条规则是否确实来自 `local` 作用域（用于拒绝越权改写） */
function isLocalRule(scopes: Awaited<ReturnType<typeof loadRuleScopes>>, rule: string, behavior: PermissionRuleBehavior): boolean {
  return scopes.local[behavior].some((r) => r.raw === rule)
}

/**
 * 读改写 `settings.local.json` 的 `permissions` 段。
 *
 * 为什么不用「临时文件 + rename」：这份文件是**用户也会手改**的配置，
 * 我们在写入前刚读过一次，竞态窗口极小；而引入 rename 会让用户在编辑器里
 * 持有的文件句柄失效（WPS/VS Code 都会提示「文件已被外部修改」）。
 * 保持直接写，是既有权衡（v0.15.0 起如此），本版不动。
 */
async function mutateLocalPermissions(
  mutate: (
    permissions: LocalPermissions,
    scopes: Awaited<ReturnType<typeof loadRuleScopes>>,
  ) => void,
): Promise<void> {
  const ws = getWorkspaceDir()
  const localPath = join(ws, '.arkwork', 'settings.local.json')
  let settings: { permissions?: LocalPermissions } = {}
  if (existsSync(localPath)) {
    try {
      settings = JSON.parse(await readFile(localPath, 'utf-8')) as typeof settings
    } catch (err) {
      logger.warn('System', `permission:local parse failed: ${(err as Error).message}`)
      settings = {}
    }
  }
  settings.permissions = settings.permissions ?? {}
  // 写之前先取作用域快照，供「是否为 local 规则」判定
  const scopes = await loadRuleScopes(ws)
  mutate(settings.permissions, scopes)
  await mkdir(join(ws, '.arkwork'), { recursive: true })
  await writeFile(localPath, JSON.stringify(settings, null, 2), 'utf-8')
}