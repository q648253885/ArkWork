/* ============================================================
 * ArkWork — User Artifacts Directory
 * 用户产物（文档、代码、测试、手册）默认输出目录治理。
 *  - .arkwork（应用数据目录 + 工作区隐藏目录）仅存放 Agent 自身内容与临时文件
 *  - 用户产物默认保存到 {workspaceDir}/docs，可通过 settings.artifactsDir 配置
 * ============================================================ */
import { existsSync, readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { getArkworkDir, getWorkspaceDir } from '../store/db.js'

const SETTINGS_FILE = () => join(getArkworkDir(), 'settings.json')

/**
 * 读取 settings.artifactsDir（同步，供路径解析使用）。
 * 文件缺失或解析失败时返回空字符串，调用方回退到默认 {workspaceDir}/docs。
 */
function readArtifactsDirSetting(): string {
  const path = SETTINGS_FILE()
  if (!existsSync(path)) return ''
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw) as { artifactsDir?: string }
    return typeof parsed.artifactsDir === 'string' ? parsed.artifactsDir.trim() : ''
  } catch {
    return ''
  }
}

/**
 * 用户产物默认目录：
 *  - 优先使用 settings.artifactsDir（非空时）
 *  - 否则回退到 {workspaceDir}/docs
 */
export function getArtifactsDir(): string {
  const configured = readArtifactsDirSetting()
  if (configured) return resolve(configured)
  return join(getWorkspaceDir(), 'docs')
}

/** 将相对路径解析为产物目录下的绝对路径 */
export function resolveArtifactPath(relativePath: string): string {
  return join(getArtifactsDir(), relativePath)
}

/**
 * 检查路径是否位于 ArkWork 自身目录下：
 *  - 应用数据目录 getArkworkDir()（全局配置与临时文件）
 *  - 工作区隐藏目录 {workspaceDir}/.arkwork（项目级配置与记忆）
 * 这两个区域均禁止写入用户产物。
 */
export function isInArkwork(filePath: string): boolean {
  const target = resolve(filePath)
  const arkworkData = resolve(getArkworkDir())
  if (target === arkworkData || target.startsWith(arkworkData + sep)) return true
  const wsArkwork = resolve(join(getWorkspaceDir(), '.arkwork'))
  if (target === wsArkwork || target.startsWith(wsArkwork + sep)) return true
  return false
}

/**
 * 校验产物路径不在 .arkwork 下，若在则抛出错误。
 * 防止用户产物污染 Agent 自身内容区域（可能被清理策略误删）。
 */
export function validateArtifactPath(filePath: string): void {
  if (isInArkwork(filePath)) {
    throw new Error(
      `产物路径不能位于 .arkwork 目录下（该目录仅存放 Agent 自身内容与临时文件）：${filePath}`,
    )
  }
}

/** 确保产物目录存在 */
export async function ensureArtifactsDir(): Promise<void> {
  const dir = getArtifactsDir()
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }
}
