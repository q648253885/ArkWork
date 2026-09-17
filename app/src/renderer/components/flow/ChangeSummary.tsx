/* ============================================================
 * ArkWork — ChangeSummary（v0.31.0 B4 · U2 裁决的**唯一实现处**）
 * 两种形态消费同一份数据：
 *  - variant 'inline'：工具卡片内嵌（B4）；
 *  - variant 'card'  ：产物卡片形态（B5 ArtifactCard，showBar 开启）。
 * added/removed 的算法在 main/agent/tools/present.ts::computeChanges ——
 * 本组件**只消费**，不得出现第二份计数实现（TC-BLOCK-015）。
 * ============================================================ */
import type { FileChange } from '@shared/types/tool-present'

export interface ChangeSummaryProps {
  changes: FileChange[]
  variant: 'inline' | 'card'
  /** 变更分布条（产物卡显示、工具卡内联不显示） */
  showBar?: boolean
  onOpenFile?: (path: string) => void
}

export function ChangeSummary({ changes, variant, showBar, onOpenFile }: ChangeSummaryProps) {
  const totalAdded = changes.reduce((s, c) => s + c.added, 0)
  const totalRemoved = changes.reduce((s, c) => s + c.removed, 0)
  const total = totalAdded + totalRemoved
  return (
    <div className={variant === 'card' ? 'space-y-2' : 'space-y-1'}>
      {showBar && total > 0 && (
        <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-fill-secondary select-none">
          {/* D21：bg-success/70 这类透明度修饰符对纯 var() 颜色无效（class 空转），
              变更条此前完全没有颜色。改用无修饰符语义色。 */}
          <div className="bg-success" style={{ width: `${(totalAdded / total) * 100}%` }} />
          <div className="bg-danger" style={{ width: `${(totalRemoved / total) * 100}%` }} />
        </div>
      )}
      {changes.map((c) => (
        <div key={`${c.path}:${c.added}:${c.removed}`} className="flex items-center gap-2 text-2xs font-mono select-text">
          {onOpenFile ? (
            <button
              type="button"
              className="truncate text-text-secondary text-left hover:text-text-primary select-none"
              onClick={() => onOpenFile(c.path)}
            >
              {c.path}
            </button>
          ) : (
            <span className="truncate text-text-secondary">{c.path}</span>
          )}
          <span className="text-success shrink-0 select-none">+{c.added}</span>
          <span className="text-danger shrink-0 select-none">−{c.removed}</span>
          {c.oldText === null && (
            <span className="text-2xs text-text-faint shrink-0 select-none">new</span>
          )}
        </div>
      ))}
    </div>
  )
}
