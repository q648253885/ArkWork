/* ============================================================
 * ArkWork — Profile 提示词上下文段（v0.32.0 G2）
 * 设计文档：docs/versions/v0.32.0/04-system-design.md §2.6 / §2.11-G2
 *           正本 `workbench-profile-v1.0/05-数据与记忆隔离.md` §3.1
 *
 * 职责单一：把「当前工作台是谁 / 记忆域在哪 / 共享层在哪 / 本台人格」压成
 * 一段 ≤180 token 的 system 文本。默认台（`wb.base`）**返回 null** ——
 * 通用形态不需要多这一行，别给每一次对话都加噪声。
 *
 * ⚠️ 诚实标注：本段只做「声明」，不改任何读写路径 —— 真正的 L3/L4 记忆
 * 文件落盘路径改命名空间是破坏性迁移，登记为遗留 L7。
 * ============================================================ */
import { BASE_NAMESPACE } from './builtins.js'
import { CORE_NAMESPACE, resolveCoreMemoryDir, resolveMemoryNamespaceDir } from './namespace.js'
import { getLastSnapshot } from './store.js'

/** 段渲染用的极简形态（拒绝把整份快照塞进提示词） */
interface SegmentView {
  profileId: string
  namespace: string
  coreDir: string
  nsDir: string
  persona: string | null
  shareCore: boolean
}

export function pickSegmentView(input: {
  profileId: string
  namespace: string
  persona?: string | null
  shareCore?: boolean
}): SegmentView {
  const ns = input.namespace || BASE_NAMESPACE
  return {
    profileId: input.profileId,
    namespace: ns,
    coreDir: resolveCoreMemoryDir(),
    nsDir: resolveMemoryNamespaceDir(ns),
    persona: input.persona?.trim() ? input.persona.trim() : null,
    shareCore: input.shareCore !== false,
  }
}

/**
 * 渲染段正文（纯函数，可单测）。
 * 形态刻意做成「身份 + 边界 + 人格」三句，避免大段散文稀释注意力。
 */
export function renderSegment(v: SegmentView): string {
  const lines = [
    '## 当前工作台',
    `- 工作台：${v.profileId}`,
    `- 你的记忆域：${v.namespace}（写入目录 ${v.nsDir}）`,
  ]
  if (v.shareCore) lines.push(`- 跨工作台共享的核心画像：${CORE_NAMESPACE}（可读取，写入须谨慎，目录 ${v.coreDir}）`)
  else lines.push('- 核心画像：本工作台不共享（独立记忆）')
  if (v.persona) lines.push(`- 本台人格：${v.persona}`)
  return lines.join('\n')
}

/** 段构建入口（由 `agent/prompt/sections.ts` 动态调用） */
export async function buildProfileContextSegment(): Promise<string | null> {
  try {
    const snap = await getLastSnapshot()
    if (!snap) return null
    // 默认命名空间 = 通用形态 → 不渲染（保持 v0.31 的提示词体积）
    if (snap.profileId === 'wb.base') return null
    const nsEntry = snap.layers.data.find((d) => d.key === 'memoryNamespace')
    const shareEntry = snap.layers.data.find((d) => d.key === 'sharedCoreNamespace')
    const namespace = nsEntry?.value || BASE_NAMESPACE
    const view = pickSegmentView({
      profileId: snap.profileId,
      namespace,
      shareCore: shareEntry?.applied !== false,
    })
    return renderSegment(view)
  } catch {
    return null
  }
}
