/* ============================================================
 * ArkWork — IPC: Memory
 * 设计文档 §5.4 / §9.3 / §9.5
 * v0.8.0：新增 L3a/L4a/蒸馏/转化/档案检索 IPC 通道
 * ============================================================ */
import { ipcMain } from 'electron'
import {
  listL1,
  toggleL1,
  editL1,
  archiveL1,
  archiveMany,
  appendL1,
  listEnabledL1,
  totalTokens,
  clearL1,
} from '../memory/l1-working.js'
import {
  getCuratedSnapshot,
  updateCuratedFile,
  listPending,
  applyPending,
  discardPending,
} from '../memory/l3-curated.js'
import { searchArchive } from '../memory/l3-archive.js'
import {
  listL2Memories,
  getL2Detail,
  deleteL2Memory,
  mergeL2Memories,
  exportL2Memories,
} from '../memory/l2-memory.js'
import {
  getProfile,
  updateSynthesis,
  deleteObservation,
  rollbackHistory,
} from '../memory/l4-profile.js'
import { convertToSkill, convertToKb } from '../memory/convert.js'
import { logger } from '../system/logger.js'
import type {
  CompressOpts,
  CompressResult,
  CompressPolicy,
  PendingEntry,
  UserProfile,
  ArchiveHit,
  ConvertSource,
  CuratedSnapshot,
  L2Memory,
  MemoryItem,
} from '@shared/types/memory'
import { getAdapter } from '../llm/registry.js'
import { getTask } from '../store/tasks.js'
// v0.29.0 F6：用户可见校验错误四语言化
import { getUiLocale, tFor } from '../i18n/messages.js'

export function registerMemoryHandlers(): void {
  ipcMain.handle('memory:list', async (_e, taskId: string) => {
    // 聚合 L1 工作记忆 + L2 压缩记忆，供记忆面板分层展示与上下文占比计量。
    // v0.16 Task 7：L2 改用压缩后的条目（compressed_summary），上下文以 compressedTokens
    // 计入，显著低于原始产物体积；meta 存 L2Memory.id 供详情查询。
    const l1 = await listL1(taskId)
    const l2 = await listL2Memories(taskId)
    const l2Items: MemoryItem[] = l2.map((m) => ({
      id: m.id,
      taskId,
      layer: 'L2',
      role: 'system',
      kind: 'compressed_summary',
      content: m.summary,
      enabled: true,
      iteration: -1,
      tokens: m.compressedTokens,
      meta: m.id,
      createdAt: m.createdAt,
      archivedAt: null,
    }))
    return [...l1, ...l2Items]
  })

  ipcMain.handle(
    'memory:toggle',
    async (_e, payload: { taskId: string; id: string; enabled: boolean }) => {
      await toggleL1(payload.taskId, payload.id, payload.enabled)
    },
  )

  ipcMain.handle(
    'memory:edit',
    async (_e, payload: { taskId: string; id: string; content: string }) => {
      await editL1(payload.taskId, payload.id, payload.content)
    },
  )

  ipcMain.handle(
    'memory:archive',
    async (_e, payload: { taskId: string; id: string }) => {
      await archiveL1(payload.taskId, payload.id)
    },
  )

  ipcMain.handle(
    'memory:compress',
    async (_e, payload: { taskId: string; opts: CompressOpts }): Promise<CompressResult> => {
      return compressMemory(payload.taskId, payload.opts.policy)
    },
  )

  ipcMain.handle('memory:clear', async (_e, taskId: string) => {
    await clearL1(taskId)
    return true
  })

  // ---- v0.8.0 L3a 策展记忆 ----
  ipcMain.handle('memory:l3-get', async (): Promise<CuratedSnapshot> => {
    return getCuratedSnapshot()
  })

  ipcMain.handle(
    'memory:l3-update',
    async (_e, payload: { file: 'memory.md' | 'user.md'; content: string }) => {
      await updateCuratedFile(payload.file, payload.content)
    },
  )

  ipcMain.handle('memory:l3-pending-list', async (): Promise<PendingEntry[]> => {
    return listPending()
  })

  ipcMain.handle(
    'memory:l3-pending-apply',
    async (_e, modelId?: string) => {
      return applyPending(modelId)
    },
  )

  ipcMain.handle(
    'memory:l3-pending-discard',
    async (_e, ids?: string[]) => {
      await discardPending(ids)
    },
  )

  // ---- v0.8.0 L4a 用户画像 ----
  ipcMain.handle('memory:l4-get', async (): Promise<UserProfile> => {
    return getProfile()
  })

  ipcMain.handle(
    'memory:l4-update-synthesis',
    async (_e, text: string): Promise<UserProfile> => {
      return updateSynthesis(text)
    },
  )

  ipcMain.handle(
    'memory:l4-delete-observation',
    async (_e, id: string): Promise<UserProfile> => {
      return deleteObservation(id)
    },
  )

  ipcMain.handle(
    'memory:l4-rollback',
    async (_e, version: number): Promise<UserProfile> => {
      return rollbackHistory(version)
    },
  )

  // ---- v0.8.0 蒸馏与转化（Task 10：distill-accept / distill-dismiss 已移除——蒸馏全自动）----
  ipcMain.handle(
    'memory:convert-to-skill',
    async (_e, payload: { source: ConvertSource; skillMd: string }) => {
      const result = await convertToSkill(payload.source, payload.skillMd)
      return { skillId: result.skill.id, skillName: result.skill.name }
    },
  )

  ipcMain.handle(
    'memory:convert-to-kb',
    async (_e, source: ConvertSource) => {
      const result = await convertToKb(source)
      return { kbFileId: result.kbFileId, filePath: result.filePath }
    },
  )

  // ---- v0.8.0 L3b 档案检索 ----
  ipcMain.handle(
    'memory:archive-search',
    async (_e, payload: { query: string; limit?: number }): Promise<ArchiveHit[]> => {
      return searchArchive(payload.query, payload.limit)
    },
  )

  // ---- v0.16 Task 7：L2 压缩记忆管理 ----
  // 列表：返回压缩后的摘要条目（不含 rawContent，保持轻量）
  ipcMain.handle('memory:l2-list', async (_e, taskId: string): Promise<L2Memory[]> => {
    const items = await listL2Memories(taskId)
    // 列表不回传 rawContent，避免大字段频繁过 IPC
    return items.map((m) => ({ ...m, rawContent: undefined }))
  })

  // 详情：返回单条完整记忆（含 rawContent，按需从产物文件读取）
  ipcMain.handle(
    'memory:l2-detail',
    async (_e, payload: { taskId: string; id: string }): Promise<L2Memory | null> => {
      return getL2Detail(payload.taskId, payload.id)
    },
  )

  // 删除单条
  ipcMain.handle(
    'memory:l2-delete',
    async (_e, payload: { taskId: string; id: string }): Promise<L2Memory[]> => {
      return deleteL2Memory(payload.taskId, payload.id)
    },
  )

  // 合并多条
  ipcMain.handle(
    'memory:l2-merge',
    async (_e, payload: { taskId: string; ids: string[] }): Promise<L2Memory | null> => {
      return mergeL2Memories(payload.taskId, payload.ids)
    },
  )

  // 导出为 JSON 字符串
  ipcMain.handle(
    'memory:l2-export',
    async (
      _e,
      payload: { taskId: string; ids?: string[] },
    ): Promise<{ json: string; count: number }> => {
      return exportL2Memories(payload.taskId, payload.ids)
    },
  )
}

const DEFAULT_POLICY: CompressPolicy = {
  keepSystem: true,
  keepRecentTurns: 3,
  keepUserTurns: true,
  keepFileRefs: true,
  dropFailed: true,
}

/**
 * 判定 L1 observation 是否为失败工具结果（v0.8.0 F801 dropFailed）。
 * buildObservationSummary 对失败工具写入 `[tool] failed: ...` 格式，据此识别。
 */
function isFailedObservation(m: { kind: string; content: string }): boolean {
  return m.kind === 'observation' && /\]\s*failed:/.test(m.content)
}

/**
 * 压缩 L1 上下文——按 policy 筛选保留/归档条目，其余 LLM 摘要为 compressed_summary。
 * v0.8.0：补实现 dropFailed（归档 failed 状态的 tool 结果 observation）。
 * @param taskId - 任务 id
 * @param policy - 压缩策略（默认保留 system/user/fileRef + 最近 3 轮 + 丢弃失败）
 */
export async function compressMemory(
  taskId: string,
  policy: CompressPolicy = DEFAULT_POLICY,
): Promise<CompressResult> {
  const all = await listL1(taskId)
  const beforeTokens = totalTokens(all)

  // 1. 分类
  // v0.19.x fix：按完整「轮次」（reasoning + 其后连续 observation）保留最近 N 轮，
  // 不再按 2*N 条消息硬切，避免从 observation 中间切开产生孤立 tool 消息
  // （前置 assistant tool_calls 被归档），导致每轮 assembleMessages 报 orphan。
  let keepFromIdx = 0
  let seenTurns = 0
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].kind === 'reasoning') {
      seenTurns += 1
      if (seenTurns >= policy.keepRecentTurns) {
        keepFromIdx = i
        break
      }
    }
  }
  const recentIds = new Set(all.slice(keepFromIdx).map((m) => m.id))

  // v0.19.x fix：dropFailed 必须与轮次对齐。此前「无条件丢弃失败 observation」会在
  // 保留其前置 reasoning（含 assistant tool_calls）的同时删除配对 tool 响应，导致
  // assembleMessages 重建出「有 tool_calls 无 tool 响应」的消息，每轮触发
  // reconcileToolCalls "stripped dangling tool_calls"（并向 OpenAI 兼容端点发送 400 风险）。
  // 现在仅当失败 observation 所属 reasoning 整轮被归档时才丢弃；reasoning 被保留时，
  // 失败 observation 一并保留。
  const failedObsKeep = new Map<string, boolean>()
  if (policy.dropFailed) {
    let lastReasoningId: string | null = null
    for (const m of all) {
      if (m.kind === 'reasoning') {
        lastReasoningId = m.id
      } else if (m.kind === 'observation') {
        if (lastReasoningId) failedObsKeep.set(m.id, recentIds.has(lastReasoningId))
      }
    }
  }

  const keep = all.filter((m) => {
    if (m.archivedAt) return false
    // dropFailed：仅丢弃「整轮被归档」的失败工具结果（避免 dangling tool_calls）
    if (policy.dropFailed && isFailedObservation(m)) {
      return failedObsKeep.get(m.id) ?? false
    }
    if (policy.keepSystem && m.kind === 'system_prompt') return true
    if (policy.keepUserTurns && m.kind === 'user_message') return true
    if (policy.keepFileRefs && m.kind === 'file_ref') return true
    if (recentIds.has(m.id)) return true
    return false
  })

  const compress = all.filter((m) => !keep.includes(m) && !m.archivedAt)
  const toArchiveIds = compress.map((m) => m.id)

  // 2. 调用压缩模型
  const toCompressText = compress.map((m) => m.content).join('\n\n---\n\n')
  let summary: string
  try {
    const t = await getTask(taskId)
    // v0.4.0：移除 'gpt-4o-mini' 硬编码——任务 modelId 为空时抛错走 catch 降级
    const modelId = t?.modelId ?? ''
    if (!modelId) throw new Error(tFor(getUiLocale(), 'memory.compressNoModel'))
    const adapter = await getAdapter(modelId)
    const resp = await adapter.complete({
      system: '你是上下文压缩助手。把以下内容压缩为简洁摘要，保留关键信息，丢弃冗余。',
      messages: [{ role: 'user', content: toCompressText }],
      temperature: 0.2,
      maxTokens: 800,
    })
    summary = resp.content
  } catch (err) {
    logger.warn('Memory', `compression LLM call failed, using naive truncation: ${(err as Error).message}`, taskId)
    summary = toCompressText.slice(0, 1500) + '\n\n… (truncated due to LLM failure)'
  }

  // 3. 写入
  await archiveMany(taskId, toArchiveIds)
  const summaryItem = await appendL1({
    taskId,
    role: 'system',
    kind: 'compressed_summary',
    content: `[Compressed Summary]\n${summary}`,
    enabled: true,
  })

  const afterItems = await listEnabledL1(taskId)
  const afterTokens = totalTokens(afterItems)

  return {
    beforeTokens,
    afterTokens,
    summaryId: summaryItem.id,
    archivedIds: toArchiveIds,
  }
}
