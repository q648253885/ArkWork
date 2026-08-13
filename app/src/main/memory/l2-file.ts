/* ============================================================
 * ArkWork — L2 File Memory
 * 设计文档 §9.3 — 任务工作目录的文件 + 产物
 * ============================================================ */
import { join, resolve, isAbsolute } from 'node:path'
import { getTaskDir, getWorkspaceDir } from '../store/db.js'
import { readTextFile, writeTextFile, listTree } from '../fs/workspace.js'
import type { FsNode } from '@shared/types/ipc'
import { logger } from '../system/logger.js'

/** 解析 path：相对路径相对任务工作目录，绝对路径直接用 */
export function resolveTaskPath(taskId: string, path: string): string {
  if (isAbsolute(path)) return resolve(path)
  return resolve(join(getTaskDir(taskId), path))
}

export async function listTaskFiles(taskId: string): Promise<FsNode[]> {
  const dir = getTaskDir(taskId)
  return listTree(dir, { maxDepth: 5, ignore: ['.git'] })
}

export async function readFileInTask(taskId: string, path: string) {
  const abs = resolveTaskPath(taskId, path)
  return readTextFile(abs)
}

export async function writeFileInTask(taskId: string, path: string, content: string): Promise<void> {
  const abs = resolveTaskPath(taskId, path)
  await writeTextFile(abs, content)
  logger.info('Tool', `wrote ${abs}`, taskId)
}

/** 持久化工具的大结果（>4K）到 L2 文件 */
export async function persistRawL2(
  taskId: string,
  stepId: string,
  raw: unknown,
): Promise<string> {
  const dir = join(getTaskDir(taskId), '.arkwork', 'steps')
  const path = join(dir, `${stepId}.json`)
  const fs = await import('node:fs/promises')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path, JSON.stringify(raw, null, 2), 'utf-8')
  return path
}

export async function readRawL2(path: string): Promise<unknown> {
  try {
    const fs = await import('node:fs/promises')
    const content = await fs.readFile(path, 'utf-8')
    return JSON.parse(content)
  } catch {
    return null
  }
}

/** L2 产物文件元信息 */
export interface RawL2Artifact {
  stepId: string
  path: string
  size: number
  createdAt: number
}

/**
 * 列出任务的 L2 产物文件（{taskDir}/.arkwork/steps/*.json）。
 * 记忆面板 L2 tab 与 memory:list 聚合共用；目录不存在返回空数组。
 */
export async function listRawL2(taskId: string): Promise<RawL2Artifact[]> {
  const dir = join(getTaskDir(taskId), '.arkwork', 'steps')
  const fs = await import('node:fs/promises')
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return []
  }
  const out: RawL2Artifact[] = []
  for (const name of entries) {
    if (!name.endsWith('.json')) continue
    const path = join(dir, name)
    try {
      const st = await fs.stat(path)
      out.push({ stepId: name.replace(/\.json$/, ''), path, size: st.size, createdAt: st.mtimeMs })
    } catch {
      // 文件可能被并发删除/截断，跳过
    }
  }
  return out.sort((a, b) => a.createdAt - b.createdAt)
}

export { getWorkspaceDir }
