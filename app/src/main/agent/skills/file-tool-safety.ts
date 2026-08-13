/* ============================================================
 * ArkWork — 文件工具安全边界与日志（v0.16.0）
 * 与主 logger 动态解耦，便于单元测试不加载 electron 模块图。
 * ============================================================ */
import { isAbsolute, resolve, relative } from 'node:path'
import { mkdir } from 'node:fs/promises'

/** 文件工具所需的最小 SkillContext，避免循环依赖 registry.ts */
export interface FileToolContext {
  taskId: string
  signal: AbortSignal
  workspaceDir?: string
}

/** 受保护路径：与 permissions.ts 保持一致，避免文件工具误写关键文件 */
export const PROTECTED_PATHS: RegExp[] = [
  /(?:^|\/)\.git\/.+/,
  /(?:^|\/)\.arkwork\/.+/,
  /(^|\/)\.env(\.|$)/,
  /(^|\/)\.env\..+/,
  /(^|\/)\.gitignore$/,
  /(^|\/)secrets\/.+/,
  /(^|\/)\..*\.pem$/,
  /(^|\/)\..*\.key$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)yarn\.lock$/,
  // v0.17.x：工作区根目录 tasks.json 是 ArkWork 自身的任务存储，Agent 误写为
  // 自建清单会覆盖任务列表并导致 store 解析崩溃（items.findIndex）。禁止写入。
  /(?:^|\/)tasks\.json$/,
]

/** 解析相对于工作区的绝对路径 */
export function resolveWorkspacePath(
  rawPath: string,
  workspaceDir: string,
): { abs: string; rel: string } {
  const abs = isAbsolute(rawPath) ? rawPath : resolve(workspaceDir, rawPath)
  const rel = relative(workspaceDir, abs)
  return { abs, rel }
}

/** 检查路径是否在工作区内 */
export function isInsideWorkspace(rel: string): boolean {
  return !rel.startsWith('..') && !isAbsolute(rel)
}

/** 检查是否命中受保护路径 */
export function isProtectedPath(abs: string): boolean {
  return PROTECTED_PATHS.some((re) => re.test(abs))
}

/** 动态获取 workspaceDir；测试环境可传 ctx.workspaceDir 避免加载 db.js */
export async function getWorkspaceDirFromCtx(ctx: FileToolContext): Promise<string> {
  if (ctx.workspaceDir) return ctx.workspaceDir
  const { getWorkspaceDir } = await import('../../store/db.js')
  return getWorkspaceDir()
}

/** 确保父目录存在 */
export async function ensureParentDir(abs: string): Promise<void> {
  const parent = abs.includes('/') ? abs.slice(0, abs.lastIndexOf('/')) : ''
  if (parent) {
    await mkdir(parent, { recursive: true })
  }
}

/** 日志：生产环境用主 logger，测试环境退化到 console */
export async function logInfo(source: string, message: string, taskId?: string): Promise<void> {
  try {
    const { logger } = await import('../../system/logger.js')
    logger.info(source as LogSource, message, taskId)
  } catch {
    console.log(`[${source}]${taskId ? ` (${taskId})` : ''} ${message}`)
  }
}

export async function logError(source: string, message: string, taskId?: string): Promise<void> {
  try {
    const { logger } = await import('../../system/logger.js')
    logger.error(source as LogSource, message, taskId)
  } catch {
    console.error(`[${source}]${taskId ? ` (${taskId})` : ''} ${message}`)
  }
}

/** 与主 logger 一致的 source 类型（仅用于类型断言） */
type LogSource = 'Tool' | 'System' | 'Agent' | 'LLM'
