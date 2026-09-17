/* ============================================================
 * ArkWork — WriteCard（v0.31.0 B4）
 * file-writer / file-editor 的 write 卡：ChangeSummary（variant 'inline'，
 * U2 唯一算法的产物）+ dryRun 徽标。
 * ============================================================ */
import { useTranslation } from 'react-i18next'
import type { ToolCallView, ToolResultView } from '@shared/types/tool-present'
import { ChangeSummary } from '../ChangeSummary'
import { useOpenPath } from '../useOpenPath'

type WriteCall = Extract<ToolCallView, { card: 'write' }>

export function WriteCallView({ call }: { call: WriteCall }) {
  // D21：变更清单里的文件路径可点击 —— 唯一门面仍是 openDoc
  const open = useOpenPath()
  return (
    <div className="mt-1 select-text">
      <ChangeSummary changes={call.changes} variant="inline" onOpenFile={open} />
    </div>
  )
}

type WriteResult = Extract<ToolResultView, { card: 'write' }>

export function WriteResultView({ result }: { result: WriteResult }) {
  const { t } = useTranslation()
  const open = useOpenPath()
  return (
    <div className="mt-1 select-text">
      {result.dryRun === true && (
        <span className="text-2xs px-1.5 py-0.5 rounded bg-fill-secondary border border-border-default text-text-faint select-none">
          {t('flow.dryRun')}
        </span>
      )}
      <ChangeSummary changes={result.changes} variant="inline" onOpenFile={open} />
    </div>
  )
}
