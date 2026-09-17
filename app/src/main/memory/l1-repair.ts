/* ============================================================
 * ArkWork — L1 引擎提示脏数据修复（v0.31.0 D22 · 读时修复 / read-repair）
 *
 * 缺陷背景（用户实测）：
 *   loop.ts 的「清单未完成 / 输出截断 → 模型自愈」守卫，曾把自救提示以
 *   `appendL1({ role:'user', kind:'user_message' })` 落进 L1。而
 *   kind='user_message' 是渲染层判定「这是用户说的话」的唯一依据
 *   （derive-conversation.ts 把所有 user_message 映射成对话框气泡），
 *   于是用户重开任务后看到一句自己从没打过的话，且该提示永久留在
 *   模型上下文里以「用户发言」身份反复出现。
 *
 *   源头已在 loop.ts 修复（改走 pendingSystemHint 瞬时通道，不再落 L1）。
 *   但存量任务里已经写坏的行还在 —— 本模块负责把它们归档。
 *
 * 修复策略（读时修复，落点 memory:list）：
 *   - 不做启动期全量扫描（L1 JSONL 可能很大，逐任务全扫会拖慢启动）；
 *     在任务真正被打开（memory:list）时按签名匹配、命中即归档，幂等；
 *   - 归档（archivedAt + enabled=false）而非删除：LLM 装配（assembleMessages
 *     跳过 archivedAt）与对话派生（deriveConversation 过滤 archivedAt）
 *     双双生效，同时审计留痕、可回溯；
 *   - 签名必须与 loop.ts 的提示模板保持同步 —— 由
 *     engine-hint-guard.test.ts 的契约断言把守（模板串 ↔ 签名前缀一致）。
 * ============================================================ */
import type { MemoryItem } from '@shared/types/memory'
import { archiveMany, listL1 } from './l1-working.js'
import { logger } from '../system/logger.js'

/**
 * 引擎自愈提示的签名（与 loop.ts 守卫的三段模板一一对应；只匹配前缀，
 * 避免把用户引用/复述这些文案的真实消息误伤）：
 *  1. 温和提示：「任务清单仍有 N 项未完成（running/pending），而上一轮…」
 *  2. 强指令：「【重要】任务清单仍有 N 项未完成（running/pending），但…」
 *  3. 截断提示：「你上一轮回复被输出长度截断（finish=length）…」（可与 1/2 拼接）
 */
const ENGINE_HINT_PREFIXES: readonly string[] = [
  '任务清单仍有 ',
  '【重要】任务清单仍有 ',
  '你上一轮回复被输出长度截断（finish=length）',
]

/** 供契约测试断言「签名 ↔ loop.ts 模板」同步（导出不进运行时路径） */
export { ENGINE_HINT_PREFIXES }

/** 判定一条 L1 条目是否为引擎自愈提示（历史脏数据） */
export function isEngineHintUserMessage(item: MemoryItem): boolean {
  if (item.kind !== 'user_message') return false
  if (item.role !== 'user') return false
  if (item.archivedAt) return false
  return ENGINE_HINT_PREFIXES.some((p) => item.content.startsWith(p))
}

/**
 * 归档该任务 L1 中的引擎自愈提示脏数据（幂等；无命中时不写盘）。
 * @returns 归档条数（供日志/测试断言）
 */
export async function repairEngineHintUserMessages(taskId: string): Promise<number> {
  let archived: string[] = []
  try {
    const items = await listL1(taskId)
    archived = items.filter(isEngineHintUserMessage).map((m) => m.id)
    if (archived.length === 0) return 0
    await archiveMany(taskId, archived)
    logger.warn(
      'Memory',
      `repaired ${archived.length} engine-hint user_message item(s) (D22 legacy cleanup)`,
      taskId,
    )
    return archived.length
  } catch (err) {
    // 修复是尽力而为：失败只记日志，绝不阻断 memory:list
    logger.warn('Memory', `engine-hint repair skipped: ${(err as Error).message}`, taskId)
    return 0
  }
}
