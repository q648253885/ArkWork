/* ============================================================
 * ArkWork — UserBlock（v0.31.0 B4）
 * v0.45.0（R-F）：hover 复制 —— 按钮浮在气泡**左外侧**（用户气泡靠右，
 * 左侧是空白区），不遮气泡内容。
 * ============================================================ */
import type { FlowBlock } from '@shared/types/flow'
import { CopyButton } from '../CopyButton'

export function UserBlock({ block }: { block: Extract<FlowBlock, { kind: 'user' }> }) {
  return (
    <div className="relative group flex justify-end">
      <CopyButton text={block.text} className="absolute left-0 top-0" />
      <div className="max-w-[85%] rounded-xl rounded-tr-sm bg-fill-secondary px-3.5 py-2 text-base text-text-primary select-text">
        {block.text}
        {block.tsLabel && (
          <span className="ml-2 text-2xs text-text-faint select-none">{block.tsLabel}</span>
        )}
      </div>
    </div>
  )
}
