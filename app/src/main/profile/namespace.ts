/* ============================================================
 * ArkWork — 记忆命名空间（v0.32.0）
 * 设计文档：docs/versions/v0.32.0/04-system-design.md §2.6
 *           正本 `workbench-profile-v1.0/05-数据与记忆隔离.md` §3（J4 双层画像）
 *
 * 目录结构：
 *   {userData}/arkwork-data/profiles/
 *   ├── core/memory/          ← 核心画像：**跨 profile 共享**（身份/语言/沟通偏好）
 *   └── ns/<name>/memory/     ← 域命名空间：领域偏好与事实，agent 永远看不到其他域
 *
 * ⚠️ 诚实标注（遗留 L7）：本模块**只负责目录就绪、路径解析与快照登记**，
 * 尚未把既有 L3/L4 记忆文件的读写路径按命名空间改写 —— 那是一次破坏性迁移
 * （l3-curated / l3-archive / l4-profile / compaction 的落盘路径 + 存量搬移 +
 * 回滚），必须独立版本 + 迁移器 + 备份。本版通过 `profile-context` 提示段
 * 让 agent「知道自己是谁、在哪」，见 §2.11 G2。
 * ============================================================ */
import { join } from 'node:path'
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { getArkworkDir } from '../store/db.js'
import { logger } from '../system/logger.js'

/** 核心画像命名空间（跨台共享层，J4） */
export const CORE_NAMESPACE = 'core'

/** 命名空间目录名白名单化 —— manifest 已校验，这里仍做防御（阻断路径穿越） */
function safeSegment(ns: string): string {
  const cleaned = String(ns ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 32)
  return cleaned || 'default'
}

/** 命名空间根：{arkworkDir}/profiles */
export function namespaceRoot(): string {
  return join(getArkworkDir(), 'profiles')
}

/** 核心画像记忆目录（不存在也返回路径，供展示） */
export function resolveCoreMemoryDir(): string {
  return join(namespaceRoot(), CORE_NAMESPACE, 'memory')
}

/** 域命名空间记忆目录（不存在也返回路径，供展示） */
export function resolveMemoryNamespaceDir(ns: string): string {
  return join(namespaceRoot(), 'ns', safeSegment(ns), 'memory')
}

/**
 * 就绪化命名空间目录（幂等）。
 * 建 `core/memory` 与 `ns/<ns>/memory`，各写一份 `.ns.json` 标记
 * （记录命名空间名与共享语义，供诊断与未来迁移器识别）。
 *
 * @returns 实际创建的目录列表（幂等调用返回空数组）
 */
export function ensureMemoryNamespace(ns: string): string[] {
  const created: string[] = []
  const targets: Array<{ dir: string; namespace: string; shared: boolean }> = [
    { dir: resolveCoreMemoryDir(), namespace: CORE_NAMESPACE, shared: true },
    { dir: resolveMemoryNamespaceDir(ns), namespace: safeSegment(ns), shared: false },
  ]
  for (const t of targets) {
    try {
      if (!existsSync(t.dir)) {
        mkdirSync(t.dir, { recursive: true })
        created.push(t.dir)
      }
      const marker = join(t.dir, '..', '.ns.json')
      if (!existsSync(marker)) {
        writeFileSync(
          marker,
          JSON.stringify({ namespace: t.namespace, shared: t.shared, createdAt: Date.now() }, null, 2),
          'utf-8',
        )
      }
    } catch (err) {
      // 目录就绪是「尽力而为」：失败不得阻断激活（激活报告另有降级项）
      logger.warn('System', `[profile] ensureMemoryNamespace(${t.namespace}) failed: ${String(err)}`)
    }
  }
  return created
}

/** 已就绪的域命名空间列表（不含 core） */
export function listNamespaces(): string[] {
  const base = join(namespaceRoot(), 'ns')
  try {
    if (!existsSync(base)) return []
    return readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

/** 一次激活要落进快照的 data 层项（键名即快照 `SnapshotData.key`） */
export function namespaceSnapshotEntries(ns: string, shareCore: boolean) {
  return [
    { key: 'memoryNamespace', value: safeSegment(ns), applied: true },
    { key: 'sharedCoreNamespace', value: shareCore ? CORE_NAMESPACE : '', applied: shareCore },
    { key: 'namespaceDir', value: resolveMemoryNamespaceDir(ns), applied: true },
  ]
}
