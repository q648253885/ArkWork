/* ============================================================
 * ArkWork — UserBlock（v0.31.0 B4）
 * ============================================================ */
import type { FlowBlock } from '@shared/types/flow'

export function UserBlock({ block }: { block: Extract<FlowBlock, { kind: 'user' }> }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-xl rounded-tr-sm bg-fill-secondary px-3.5 py-2 text-base text-text-primary select-text">
        {block.text}
        {block.tsLabel && (
          <span className="ml-2 text-2xs text-text-faint select-none">{block.tsLabel}</span>
        )}
      </div>
    </div>
  )
}
