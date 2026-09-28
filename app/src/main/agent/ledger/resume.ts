/* ============================================================
 * ArkWork — 恢复点语义（TaskLedger）
 * 设计文档 §4.3
 *
 * 业界定论（Harness Engineering，经诊断 §4.3③ 引用）：
 *   「判断 IN_PROGRESS 到底是『真在跑』还是『跑到一半挂了』，
 *     **依据是产出物而非状态本身**。」
 *
 * 三段式：
 *   ① 产出物存在且完整性校验通过 → 判定已完成 → done（不重做）
 *   ② 产出物不存在或非法         → 半成品 → 重置 pending 等调度
 *   ③ 未声明产出物               → 无法判定，保持 paused 交模型决定（不误判）
 *
 * ③ 的存在很重要：tier 0/1 的轻量任务本来就没有产出物契约，
 * 强行按「无产出物 = 没做完」处理会把已完成的工作打回去重做 —— 那正是本版要治的病。
 * ============================================================ */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getWorkspaceDir } from '../../store/db.js'
import { logger } from '../../system/logger.js'
import type { LedgerFile, LedgerItem } from './types.js'
import { isLedgerOpen } from './types.js'

const execFileAsync = promisify(execFile)

export type ArtifactVerdict = 'done' | 'reset' | 'unknown'

const CHECK_TIMEOUT_MS = 8_000

/** 跑完整性校验命令（超时/异常一律视为不通过，不静默放行） */
async function runCheck(cmd: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('/bin/sh', ['-c', cmd], {
      cwd: getWorkspaceDir(),
      timeout: CHECK_TIMEOUT_MS,
      maxBuffer: 1024 * 256,
    })
    return true
  } catch (err) {
    logger.debug('Agent', `ledger artifact check 未通过：${cmd} → ${(err as Error).message.slice(0, 120)}`)
    return false
  }
}

/**
 * 单个清单项的产出物判定。
 * @returns 'done' 已完成 / 'reset' 需重做 / 'unknown' 无法判定
 */
export async function evaluateArtifact(item: LedgerItem): Promise<ArtifactVerdict> {
  const art = item.artifact
  if (!art || !art.path) return 'unknown'
  const abs = join(getWorkspaceDir(), art.path)
  let exists = false
  try {
    exists = existsSync(abs)
  } catch {
    exists = false
  }
  if (!exists) return 'reset'
  if (art.check && art.check.trim()) {
    const ok = await runCheck(art.check)
    return ok ? 'done' : 'reset'
  }
  return 'done'
}

/** 人话恢复点（注入提示词 L3 段 + 交互区提示条） */
export function buildResumeHint(l: LedgerFile): string {
  const custom = l.resume?.hint?.trim()
  const done = l.items.filter((it) => it.status === 'done')
  const open = l.items.filter((it) => isLedgerOpen(it.status))
  const parts: string[] = []
  if (custom) parts.push(custom)
  if (open.length > 0) {
    const first = open[0]!
    parts.push(`未完成 ${open.length} 项，当前应继续：${first.text.slice(0, 40)}（状态 ${first.status}）`)
  } else {
    parts.push('清单已全部收口，无需续做')
  }
  if (done.length > 0) {
    parts.push(`已完成 ${done.length} 项，**禁止重做**：${done.map((d) => d.text.slice(0, 18)).join(' / ').slice(0, 160)}`)
  }
  return parts.join('。')
}

/** 是否存在需要被恢复的中断痕迹 */
export function hasResumePoint(l: LedgerFile | null): boolean {
  if (!l) return false
  return Boolean(l.resume?.hint) || l.items.some((it) => it.status === 'paused')
}
