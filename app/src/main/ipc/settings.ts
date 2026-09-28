/* ============================================================
 * ArkWork — IPC: Settings & Secrets
 * 设计文档 §8.5
 * ============================================================ */
import { ipcMain } from 'electron'
import { join } from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { getArkworkDir } from '../store/db.js'
// v0.29.0 F6：语言字段变更时同步主进程 i18n 缓存
import { setCachedUiLocale } from '../i18n/messages.js'
import { pickWorkspace, ensureWorkspace, assertWorkspaceWritable } from '../fs/workspace.js'
import { setWorkspaceDir } from '../store/db.js'
import { resetTaskCollection, reconcileStaleTasks } from '../store/tasks.js'
// ★ v0.35.0：工作区切换时重算插件运行时（workspace 级插件随工作区拆/建）
import { onWorkspaceSwitchedPluginRuntime } from '../plugins/bootstrap.js'
import { logger } from '../system/logger.js'
import type { AppSettings, SecretKeys } from '@shared/types/ipc'

const SETTINGS_FILE = () => join(getArkworkDir(), 'settings.json')
const SECRETS_FILE = () => join(getArkworkDir(), 'secrets.json')

async function readSettings(): Promise<AppSettings> {
  const path = SETTINGS_FILE()
  const fallback: AppSettings = {
    workspaceDir: '',
    defaultModelId: '',
    defaultAgentId: '@default',
    // v0.4.0：默认深色（与历史版本一致；用户可在设置→外观切换）
    theme: 'dark',
    // Task 8：默认开启（与历史版本一致）
    kbEnabled: true,
    // 空字符串表示使用默认 {workspaceDir}/docs
    artifactsDir: '',
  }
  if (!existsSync(path)) return fallback
  try {
    const raw = await readFile(path, 'utf-8')
    const parsed = JSON.parse(raw) as AppSettings
    // Task 8：旧 settings.json 没有 kbEnabled 字段 → 补默认值（保持 UX 一致）
    if (parsed.kbEnabled === undefined) parsed.kbEnabled = true
    return parsed
  } catch {
    return fallback
  }
}

/**
 * v0.8.0：供 engine 读取记忆配置（自动压缩开关与阈值）。
 * 缺省值：autoCompress=true, compressThreshold=24000。
 * v0.36.0 F1.3：compressThreshold 不再是绝对触发阈值 —— 仅当用户显式设置时
 * （compressThresholdSet=true）作为模型窗口公式的**覆盖上限**（见
 * compaction.resolveAutoCompactThreshold）；未设置时完全由模型窗口驱动。
 */
export async function getMemoryConfig(): Promise<{
  autoCompress: boolean
  compressThreshold: number
  compressThresholdSet: boolean
}> {
  const s = await readSettings()
  return {
    autoCompress: s.memory?.autoCompress ?? true,
    compressThreshold: s.memory?.compressThreshold ?? 24_000,
    compressThresholdSet: s.memory?.compressThreshold !== undefined,
  }
}

/**
 * v0.9.1 §Task 6：暴露 settings 给 store 层（如 automations）使用，
 * 避免回退到 IPC 链路。
 */
export async function getSettings(): Promise<AppSettings> {
  return readSettings()
}

async function writeSettings(settings: AppSettings): Promise<void> {
  await mkdir(getArkworkDir(), { recursive: true })
  await writeFile(SETTINGS_FILE(), JSON.stringify(settings, null, 2), 'utf-8')
}

/**
 * v0.15.x Task 3：供其它 IPC 模块（如 fs:set-artifacts-dir）复用的写入入口。
 * 写入前由调用方负责字段校验。
 */
export async function saveSettings(settings: AppSettings): Promise<void> {
  await writeSettings(settings)
}

async function readSecrets(): Promise<SecretKeys> {
  const path = SECRETS_FILE()
  if (!existsSync(path)) return {}
  try {
    const raw = await readFile(path, 'utf-8')
    return JSON.parse(raw) as SecretKeys
  } catch {
    return {}
  }
}

async function writeSecrets(secrets: SecretKeys): Promise<void> {
  await mkdir(getArkworkDir(), { recursive: true })
  await writeFile(SECRETS_FILE(), JSON.stringify(secrets, null, 2), 'utf-8')
}

export function registerSettingsHandlers(): void {
  ipcMain.handle('settings:get', async () => readSettings())

  ipcMain.handle('settings:set', async (_e, patch: Partial<AppSettings>) => {
    const current = await readSettings()
    const next = { ...current, ...patch }
    await writeSettings(next)
    // v0.29.0 F6：语言字段变更时同步主进程 i18n 缓存（非法值由 setCachedUiLocale 内部忽略）
    if (patch.language !== undefined) setCachedUiLocale(patch.language)
  })

  ipcMain.handle('settings:get-secret', async (_e, key: keyof SecretKeys) => {
    const secrets = await readSecrets()
    return secrets[key]
  })

  ipcMain.handle(
    'settings:set-secret',
    async (_e, payload: { key: keyof SecretKeys; value: string }) => {
      const current = await readSecrets()
      const next = { ...current, [payload.key]: payload.value }
      await writeSecrets(next)
    },
  )

  ipcMain.handle('settings:pick-workspace', async () => {
    return pickWorkspace()
  })

  ipcMain.handle('settings:activate-workspace', async (_e, path: string) => {
    // 预检可写性：目录不可写（EPERM/EACCES）时提前报错，避免切换到该工作区后任务无法落盘
    await assertWorkspaceWritable(path)
    setWorkspaceDir(path)
    // v0.4.0-rev2：重置 task collection 单例，确保后续 listTasks/createTask 读取新工作区的 tasks.json
    resetTaskCollection()
    await ensureWorkspace()
    // v0.38.0（D163）：**陈旧任务回收必须跟工作区走**。
    // 启动链路里的 reconcileStaleTasks（index.ts）跑在 renderer 恢复上次工作区
    // **之前** —— 那时 workspaceDir 还是 default（空壳），真实工作区的
    // running 任务一条都回收不到，UI 重开后卡在虚假的「运行中 / 正在思考」
    // （实机复现：T-20260926-48411u 重启后仍 running）。工作区一旦激活，
    // 这里的回收才是真正对着用户数据的；paused 不动（有 checkpoint，可续跑）。
    try {
      const fixed = await reconcileStaleTasks()
      if (fixed > 0) logger.info('System', `[workspace] activate 后回收 ${fixed} 个陈旧 running 任务`)
    } catch (err) {
      logger.warn('System', `[workspace] activate 后回收失败（不阻断）：${String(err)}`)
    }
    // ★ v0.35.0：工作区级插件随工作区切换（先拆旧工作区来源的插件进程，再扫新目录）。
    // 放在 ensureWorkspace 之后：扫描需要新工作区的 `.arkwork/plugins/` 已在盘上。
    // 失败只 warn —— 插件是附加能力，绝不能拦住「切换工作区」这个基本操作。
    try {
      await onWorkspaceSwitchedPluginRuntime()
    } catch (err) {
      logger.warn('System', `[plugin] 工作区切换后重算插件失败：${String(err)}`)
    }
    return true
  })
}
