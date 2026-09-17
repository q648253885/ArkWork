/* ============================================================
 * ArkWork — Main: FS Agent-Writes（agent 写盘登记表）
 * 设计文档 docs/versions/v0.31.0/04-system-design.md §6.4
 *
 * 职责边界（与 fs/write.ts 的自写登记表互补，**两张表只做归因、不做事件上报**）：
 *  - `write.ts markSelfWrite`：**编辑器保存**（fs:write-text）的自写回环抑制，
 *    TTL 500ms + hash 比对（防 chokidar 事件激发「自己刚保存的文件」重载）；
 *  - 本表：**agent 工具写盘**（file-writer / file-editor）的来源归因，
 *    TTL 5000ms（工具调用成功 → 磁盘事件到达之间的合理延迟，TC-WATCH-011）。
 *
 * 「靠机制不靠纪律」（§6.4 关键设计）：登记缺失只会让 watch 把事件归因为
 * `'external'`（徽标降级为外部变更），**事件本身永不丢**——chokidar 是唯一
 * 感知通道，本表只增强归因精度。即未来新增任意写盘工具零接入也不会丢事件。
 *
 * 纯模块纪律：不 import electron / chokidar / i18n —— node:test 可直连密闭断言。
 * ============================================================ */
import { resolve } from 'node:path'

/** agent 写盘登记窗口（工具调用到磁盘事件之间的合理延迟；L12 实测后可调，调整须同步 TC-WATCH-011） */
export const AGENT_WRITE_TTL_MS = 5000

/** 登记表规模上限（防御性：超过即全量清扫过期项，避免长会话 Map 无界增长） */
const REGISTRY_SOFT_LIMIT = 512

const agentWrites = new Map<string, { until: number }>()

/**
 * agent 工具写盘成功后登记（file-writer / file-editor 拿到 abs 后调用）。
 * 注意入参必须是**解析后的绝对路径**（与 chokidar 事件的路径口径一致）。
 */
export function markAgentWrite(absPath: string, now: number = Date.now()): void {
  if (agentWrites.size >= REGISTRY_SOFT_LIMIT) purgeExpired(now)
  agentWrites.set(resolve(absPath), { until: now + AGENT_WRITE_TTL_MS })
}

/** 命中且未过期 → true（watch 批次归因为 'agent'） */
export function isAgentWrite(absPath: string, now: number = Date.now()): boolean {
  const hit = agentWrites.get(resolve(absPath))
  if (!hit) return false
  if (hit.until < now) {
    agentWrites.delete(resolve(absPath))
    return false
  }
  return true
}

/** 清空登记表（测试隔离用） */
export function clearAgentWrites(): void {
  agentWrites.clear()
}

function purgeExpired(now: number): void {
  for (const [key, hit] of agentWrites) {
    if (hit.until < now) agentWrites.delete(key)
  }
}
