/* ============================================================
 * ArkWork — Agent 空间（v0.36.0 · B4 / F1.1）
 * 设计文档：docs/versions/v0.36.0/04-system-design.md §3.2（决策 D1）
 *
 * 一句话：**L1/L2 属于工作区，L3a/L4a 属于 Agent 自己。**
 *
 * 为什么必须分开（这不是整理癖，是语义问题）：
 *  · L1 工作记忆 / L2 文件记忆 = 「这件事干到哪了」→ 天然属于**某个工作区**，
 *    换工作区就该换一套（在 A 项目里记的待办不该出现在 B 项目）；
 *  · L3a 策展记忆（memory.md/user.md）/ L4a 用户画像 = 「这个人怎么干活、
 *    偏好什么」→ 是**跨工作区的公共能力**，跟具体项目无关。
 *    过去它落在 {workspace}/.arkwork/ 下 ⇒ 换个工作区，Agent 就「失忆」了，
 *    同一个人的偏好要在每个项目里重新学一遍。
 *
 * 迁移协议（幂等 + 可回滚 + 不阻断启动）：
 *   ① agent-space/.migrated 存在 → 直接返回（不重复搬）
 *   ② 每个文件：工作区有、agent-space 没有 → 复制过去，原文件改名 *.migrated-bak
 *      两处都有 → **以 agent-space 为准**，工作区文件同样留 bak，记 warn
 *   ③ 全部成功才写 .migrated 标记（含版本与时间）
 *      任一步失败 → 中止、不写标记（下次启动重试），启动流程照常（try/catch warn）
 * ============================================================ */
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getArkworkDir, getWorkspaceDir } from '../store/db.js'
import { logger } from '../system/logger.js'

/** Agent 空间根：{userData}/arkwork-data/agent-space（跨工作区共享） */
export function agentSpaceDir(): string {
  return join(getArkworkDir(), 'agent-space')
}

/**
 * 迁入 Agent 空间的文件。
 * ★ v0.36.3 修订：`memory.md` **不再迁入** —— 它记的是项目偏好/规则，属于工作区
 * （口径见 l3-curated.ts 的 curatedPath 注释）。
 */
export const AGENT_SPACE_FILES = ['user.md', 'memory.pending.jsonl', 'profile.json'] as const
export type AgentSpaceFile = (typeof AGENT_SPACE_FILES)[number]

/** L3a 工作区策展文件（v0.36.3 回迁后的生产位置） */
export const WORKSPACE_MEMORY_FILE = 'memory.md'

/** 某文件在 Agent 空间中的绝对路径 */
export function agentSpacePath(file: AgentSpaceFile): string {
  return join(agentSpaceDir(), file)
}

/**
 * Agent 空间中的**旧** memory.md 路径。
 * v0.36.0–v0.36.2 期间它被迁到这里；v0.36.3 起只作为「回迁源」，
 * 不再作为生产读写位置（生产位置见 workspaceCuratedMemoryPath）。
 */
export function agentSpaceLegacyMemoryPath(): string {
  return join(agentSpaceDir(), WORKSPACE_MEMORY_FILE)
}

/** {workspace}/.arkwork/memory.md —— 生产写入位置（项目偏好 / 规则 / 事实） */
export function workspaceCuratedMemoryPath(workspaceDir?: string): string {
  return join(workspaceDir ?? getWorkspaceDir(), '.arkwork', WORKSPACE_MEMORY_FILE)
}

/** 某文件在（旧）工作区中的绝对路径 —— 仅迁移与回滚用，不再作为生产读写位置 */
export function legacyWorkspacePath(file: AgentSpaceFile, workspaceDir?: string): string {
  return join(workspaceDir ?? getWorkspaceDir(), '.arkwork', file)
}

/** 备份后缀：保留原文件，用户可手工回滚（迁移出问题时唯一自救手段） */
export const MIGRATED_BAK_SUFFIX = '.migrated-bak'

const MARKER = '.migrated'

export interface MigrateResult {
  migrated: boolean
  /** 本次真正搬运的文件 */
  moved: AgentSpaceFile[]
  /** 两处都在、以 agent-space 为准（工作区副本留 bak） */
  conflicts: AgentSpaceFile[]
  /** 失败原因（非空表示中止，未写标记） */
  error?: string
  /** 已有标记时的既有版本信息 */
  marker?: { version: string; at: string }
}

async function readMarker(): Promise<{ version: string; at: string } | null> {
  const p = join(agentSpaceDir(), MARKER)
  if (!existsSync(p)) return null
  try {
    const raw = JSON.parse(await readFile(p, 'utf-8')) as { version?: string; at?: string }
    return { version: String(raw.version ?? ''), at: String(raw.at ?? '') }
  } catch {
    // 标记坏了 = 迁移状态未知 → 当作没迁过（幂等：再跑一次不会有副作用）
    return null
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * 幂等迁移（首启调用；也可由「设置 → 记忆」手动触发）。
 *
 * @param version 当前应用版本（写进标记，便于日后判断是否需要二次迁移）
 * @param workspaceDir 覆盖工作区路径（测试用；缺省取当前工作区）
 */
export async function migrateAgentSpace(version: string, workspaceDir?: string): Promise<MigrateResult> {
  const dir = agentSpaceDir()
  const existing = await readMarker()

  // ★ 自愈而非「一票否决」：标记只说明「迁过」，不能证明「以后不会再冒出来」。
  //   真实场景：用户装回旧版本跑了一阵、或从旧机器恢复了工作区备份 ——
  //   L3a 文件会重新出现在工作区里。此时若只看标记直接 return，这些记忆就**永久
  //   失联**（既不迁移也不报错）。故每次启动做 4 次 statSync：确认工作区侧真的没有
  //   遗留文件，才认定「无需迁移」；有遗留就照常搬（幂等，无副作用）。
  const leftover = AGENT_SPACE_FILES.filter((f) => isFile(legacyWorkspacePath(f, workspaceDir)))
  if (existing && leftover.length === 0) {
    return { migrated: false, moved: [], conflicts: [], marker: existing }
  }

  const moved: AgentSpaceFile[] = []
  const conflicts: AgentSpaceFile[] = []
  try {
    await mkdir(dir, { recursive: true })
    for (const f of AGENT_SPACE_FILES) {
      const src = legacyWorkspacePath(f, workspaceDir)
      const dst = agentSpacePath(f)
      const srcThere = isFile(src)
      const dstThere = isFile(dst)

      if (srcThere && !dstThere) {
        // ① 只在工作区：搬过去（copy 后再改名，避免跨设备 rename 失败丢数据）
        await copyFile(src, dst)
        await rename(src, `${src}${MIGRATED_BAK_SUFFIX}`)
        moved.push(f)
      } else if (srcThere && dstThere) {
        // ② 两处都有：agent-space 为准（它才是「跨工作区」的那份），工作区副本留 bak
        await rename(src, `${src}${MIGRATED_BAK_SUFFIX}`)
        conflicts.push(f)
        logger.warn(
          'Memory',
          `[agent-space] ${f} 在工作区与 Agent 空间各有一份，已以 Agent 空间为准；工作区副本保留为 ${f}${MIGRATED_BAK_SUFFIX}`,
        )
      }
      // ③ 都没有 / 只有 agent-space：什么都不做
    }

    await writeFile(
      join(dir, MARKER),
      JSON.stringify({ version, at: new Date().toISOString(), moved, conflicts }, null, 2),
      'utf-8',
    )
    if (moved.length > 0) {
      logger.info('Memory', `[agent-space] 迁移完成：${moved.join(', ')} → ${dir}`)
    }
    return { migrated: moved.length > 0, moved, conflicts }
  } catch (err) {
    // 不写标记 → 下次启动重试；启动流程不受阻（调用方只 warn）
    const error = err instanceof Error ? err.message : String(err)
    logger.warn('Memory', `[agent-space] 迁移中止（未写标记，下次重试）：${error}`)
    return { migrated: false, moved, conflicts, error }
  }
}

/* ============================================================
 * ★ v0.36.3（设计文档 §4.1 归属修订）：memory.md 回迁工作区
 *
 * 背景：v0.36.0 把 L3a 两份快照**一并**迁进 Agent 空间，理由是「同一个人的偏好
 * 不该在每个项目里重新学一遍」。这理由对 `user.md` 成立，对 `memory.md` 不成立 ——
 * 后者记的是**项目规则/偏好**（用 pnpm、测试必须全绿才收尾、产物落 docs/…），
 * 换个项目就完全不该生效。于是本版把它迁回工作区。
 *
 * 回迁策略（幂等 + 不丢数据 + 不覆盖）：
 *   · 源 = {agentSpace}/memory.md（老版本迁过去的那份），**只读不删** ——
 *     用户可能同时在多个工作区跑，删掉源会让其它工作区再也拿不到这份内容；
 *   · 目标 = {workspace}/.arkwork/memory.md；
 *   · 目标已有非空内容 → 什么都不做（工作区那份才是「当前项目的记忆」）；
 *   · 失败只 warn，不阻断启动（下次启动重试）。
 * ============================================================ */

export interface WorkspaceMemorySeedResult {
  /** 本次是否真的复制了内容 */
  copied: boolean
  from: string
  to: string
  /** 未复制时的人话原因 */
  reason?: string
}

/**
 * 首启把 Agent 空间里的旧 memory.md 复制为工作区记忆（幂等，可反复调用）。
 *
 * @param workspaceDir 覆盖工作区路径（测试用；缺省取当前工作区）
 */
export async function seedWorkspaceMemoryFromAgentSpace(
  workspaceDir?: string,
): Promise<WorkspaceMemorySeedResult> {
  const from = agentSpaceLegacyMemoryPath()
  const to = workspaceCuratedMemoryPath(workspaceDir)

  if (!isFile(from)) {
    return { copied: false, from, to, reason: 'Agent 空间无旧 memory.md（无需回迁）' }
  }
  if (statSync(from).size === 0) {
    return { copied: false, from, to, reason: 'Agent 空间 memory.md 为空（无需回迁）' }
  }
  if (isFile(to) && statSync(to).size > 0) {
    return { copied: false, from, to, reason: '工作区已有记忆，不覆盖' }
  }

  try {
    await mkdir(dirname(to), { recursive: true })
    await copyFile(from, to)
    logger.info('Memory', `[l3a] memory.md 已回迁工作区：${to}（源文件保留在 Agent 空间，未删除）`)
    return { copied: true, from, to }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    logger.warn('Memory', `[l3a] memory.md 回迁失败（不阻断启动，下次重试）：${reason}`)
    return { copied: false, from, to, reason }
  }
}

/**
 * 迁移状态（供「记忆归属」面板展示「Agent 空间已就绪 / 尚未迁移」）。
 * 注意：这里**不**检查文件级完整性 —— 状态是「是否已完成迁移」这一个事实。
 */
export function agentSpaceStatus(): { dir: string; migrated: boolean; marker: { version: string; at: string } | null } {
  const p = join(agentSpaceDir(), MARKER)
  if (!existsSync(p)) return { dir: agentSpaceDir(), migrated: false, marker: null }
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as { version?: string; at?: string }
    return {
      dir: agentSpaceDir(),
      migrated: true,
      marker: { version: String(raw.version ?? ''), at: String(raw.at ?? '') },
    }
  } catch {
    return { dir: agentSpaceDir(), migrated: false, marker: null }
  }
}
