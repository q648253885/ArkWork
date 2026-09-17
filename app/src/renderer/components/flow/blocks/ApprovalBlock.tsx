/* ============================================================
 * ArkWork — ApprovalBlock（v0.31.0 B4）
 * 审批卡占位（needs-human / replan / converge 三类）。
 * 完整交互（批准 / 驳回动作）由既有 PlanApprovalCard / ActionCards 承担；
 * 历史轮中的审批块以静态卡呈现（不重复挂动作，防双通道写入）。
 * ============================================================ */
import { useTranslation } from 'react-i18next'
import type { FlowBlock } from '@shared/types/flow'

type ApprovalBlockT = Extract<FlowBlock, { kind: 'approval' }>

const LABEL_KEY: Record<ApprovalBlockT['cardKind'], string> = {
  'needs-human': 'flow.approvalNeedsHuman',
  replan: 'flow.approvalReplan',
  converge: 'flow.approvalConverge',
}

export function ApprovalBlock({ block }: { block: ApprovalBlockT }) {
  const { t } = useTranslation()
  return (
    <div
      className="rounded-lg border border-border-default bg-bg-surface px-3 py-2 text-xs text-text-secondary select-none flex items-center gap-2"
      style={{ borderLeftWidth: 2, borderLeftColor: 'var(--warning)' }}
    >
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-warning shrink-0" />
      <span>{t(LABEL_KEY[block.cardKind])}</span>
      {block.refId && <span className="text-2xs font-mono text-text-faint truncate">{block.refId}</span>}
    </div>
  )
}
