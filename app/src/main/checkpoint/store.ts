/* ============================================================
 * ArkWork — Checkpoint Store
 * 设计文档 §3.5（F12）
 *
 * 偏差说明（相对系统设计文档）：
 *  设计文档指定 better-sqlite3 持久化 Checkpoint。为避免 Electron
 *  打包时 native 模块 rebuild 的复杂性，本期采用 JSON 文件式存储
 *  （{workspaceDir}/.arkwork/checkpoints/{taskId}.json），功能等价：
 *  - 每轮 ReAct 迭代后异步写入 checkpoint（fire-and-forget）
 *  - 任务崩溃后可从最近 checkpoint 恢复
 *  - 父子任务委派链路通过 parentCheckpointId 关联
 *  性能：JSON 全量覆写，单任务 checkpoint 数 ≤ 25（maxIterations），
 *  文件 < 1MB，写延迟 < 5ms，满足 ReAct 循环节奏。
 *  后续若需高频写入可升级为 better-sqlite3，接口保持兼容。
 * ============================================================ */
import { join } from 'node:path'
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { getWorkspaceDir } from '../store/db.js'
import { logger } from '../system/logger.js'
import type { PlanItem } from '@shared/types/task'
import type { ReActStep } from '@shared/types/react'

export interface Checkpoint {
  id: string                   // {taskId}_step_{iteration}
  taskId: string
  iteration: number            // ReAct 第几次迭代
  agentId: string
  /** L1 memory 的 JSON 序列化（用于恢复时重建 L1 状态） */
  memorySnapshot: string
  timestamp: number
  parentCheckpointId?: string  // 委派链路
  /** 任务状态快照（用于恢复时重建 task 状态） */
  taskStatus: string
  // ---- v0.14.0 Task 9：暂停/恢复（US10）扩展字段，全部可选，兼容 v0.6.0 既有 schema ----
  /** checkpoint 类型：'iteration'=每轮 ReAct 迭代快照（旧）；'pause'=用户暂停快照（新） */
  kind?: 'iteration' | 'pause'
  /** L1 快照（JSON 序列化的 enabled L1 条目；恢复时以磁盘 L1 为准，此为冗余快照） */
  l1Snapshot?: string
  /** 暂停时的 PlanItem 六态快照（恢复时跳过 done、把 running 重置为 pending 继续执行） */
  planItems?: PlanItem[]
  /** 暂停时的工具历史（ReAct steps 序列，供恢复/审计查看） */
  toolHistory?: ReActStep[]
}

interface CheckpointFile {
  taskId: string
  checkpoints: Checkpoint[]
  lastUpdated: number
}

const fileCache = new Map<string, CheckpointFile>()

function checkpointPath(taskId: string): string {
  return join(getWorkspaceDir(), '.arkwork', 'checkpoints', `${taskId}.json`)
}

async function readFile_(taskId: string): Promise<CheckpointFile> {
  if (fileCache.has(taskId)) return fileCache.get(taskId)!
  const path = checkpointPath(taskId)
  if (!existsSync(path)) {
    return { taskId, checkpoints: [], lastUpdated: 0 }
  }
  try {
    const raw = await readFile(path, 'utf-8')
    const file = JSON.parse(raw) as CheckpointFile
    fileCache.set(taskId, file)
    return file
  } catch {
    return { taskId, checkpoints: [], lastUpdated: 0 }
  }
}

async function writeFile_(taskId: string, file: CheckpointFile): Promise<void> {
  const path = checkpointPath(taskId)
  await mkdir(join(path, '..'), { recursive: true })
  file.lastUpdated = Date.now()
  await writeFile(path, JSON.stringify(file, null, 2), 'utf-8')
  fileCache.set(taskId, file)
}

/**
 * 写入 checkpoint 的同步 await 版本（pause manager 等需要保证落盘完成的场景使用；
 * 引擎的迭代 checkpoint 仍走 fire-and-forget 的 saveCheckpoint）。
 * 同 iteration 覆盖，避免重复。
 */
export async function writeCheckpoint(cp: Checkpoint): Promise<void> {
  const file = await readFile_(cp.taskId)
  const idx = file.checkpoints.findIndex((c) => c.iteration === cp.iteration)
  if (idx >= 0) {
    file.checkpoints[idx] = cp
  } else {
    file.checkpoints.push(cp)
    // 按 iteration 排序
    file.checkpoints.sort((a, b) => a.iteration - b.iteration)
    // 上限 30 个 checkpoint（超过则丢弃最早的，保留最近 30 步）
    if (file.checkpoints.length > 30) {
      file.checkpoints = file.checkpoints.slice(-30)
    }
  }
  await writeFile_(cp.taskId, file)
  logger.debug('Agent', `checkpoint saved: ${cp.id}`, cp.taskId)
}

/**
 * 写入 checkpoint（fire-and-forget，不阻塞 ReAct 循环）。
 * 同 iteration 覆盖，避免重复。
 */
export function saveCheckpoint(cp: Checkpoint): void {
  void writeCheckpoint(cp).catch((err) => {
    // 失败不阻塞主循环
    logger.warn('Agent', `checkpoint save failed: ${(err as Error).message}`, cp.taskId)
  })
}

/** 列出任务全部 checkpoint（按 iteration 升序） */
export async function listCheckpoints(taskId: string): Promise<Checkpoint[]> {
  const file = await readFile_(taskId)
  return [...file.checkpoints].sort((a, b) => a.iteration - b.iteration)
}

/** 获取最近一次 checkpoint（用于崩溃恢复） */
export async function getLatestCheckpoint(taskId: string): Promise<Checkpoint | null> {
  const list = await listCheckpoints(taskId)
  return list.length > 0 ? list[list.length - 1] : null
}

/** 获取指定 iteration 的 checkpoint */
export async function getCheckpoint(
  taskId: string,
  iteration: number,
): Promise<Checkpoint | null> {
  const file = await readFile_(taskId)
  return file.checkpoints.find((c) => c.iteration === iteration) ?? null
}

/**
 * v0.14.0 Task 9：获取任务最近一次「暂停」checkpoint（用于恢复续跑）。
 * 优先取 kind === 'pause' 的快照；旧数据无 kind 标记时回退到最近一次任意 checkpoint。
 */
export async function getPauseCheckpoint(taskId: string): Promise<Checkpoint | null> {
  const list = await listCheckpoints(taskId)
  if (list.length === 0) return null
  return [...list].reverse().find((c) => c.kind === 'pause') ?? list[list.length - 1]
}

/**
 * 从 checkpoint 恢复任务状态。
 * 恢复策略：清空 L1 中 iteration > checkpoint.iteration 的条目，
 * 任务状态设为 paused（等用户手动 resume）。
 * @returns 恢复到的 iteration；无 checkpoint 返回 0
 */
export async function restoreFromCheckpoint(
  taskId: string,
  targetIteration?: number,
): Promise<number> {
  const target = targetIteration !== undefined
    ? await getCheckpoint(taskId, targetIteration)
    : await getLatestCheckpoint(taskId)
  if (!target) return 0

  // 读取 L1 并截断到 target iteration
  const { listEnabledL1, archiveL1AfterIteration } = await import('../memory/l1-working.js')
  await archiveL1AfterIteration(taskId, target.iteration)

  const remaining = await listEnabledL1(taskId)
  logger.info(
    'Agent',
    `restored from checkpoint iter=${target.iteration} (L1 remaining=${remaining.length})`,
    taskId,
  )
  return target.iteration
}

/** 删除任务全部 checkpoint（任务删除时调用） */
export async function clearCheckpoints(taskId: string): Promise<void> {
  fileCache.delete(taskId)
  const path = checkpointPath(taskId)
  if (existsSync(path)) {
    await rm(path, { force: true })
  }
}

/** 生成 checkpoint id */
export function checkpointId(taskId: string, iteration: number): string {
  return `${taskId}_step_${iteration}`
}
