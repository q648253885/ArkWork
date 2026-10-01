/* ============================================================
 * ArkWork — TaskArtifactCard（v0.44.0 · R-B，第十二个块）
 * 任务的「成果产物」以独立卡片呈现 —— 产物是一等公民，不再和答复正文
 * 的一句话混排（用户实机反馈：答复里 "docs/SIMILAR_PROJECTS.md" 只是
 * 纯文本，不可点击、没有存在感）。
 *
 * 数据源：投影层把 planItems 中声明的 artifact（D176 证据门禁产物）收敛
 * 为 ArtifactBlock.entries（仅 file/dir、按 path 去重，见 flow/project.ts）。
 *
 * 呈现契约：
 *  - 每条经 FileLink（完整路径展示，D112；点击 useOpenPath → openDoc
 *    既有门面，不直连 openPreview）；
 *  - dir 型产物同样可打开（openDoc 对目录有既有语义）；
 *  - 空产物不出卡（投影层保证，诚实 UI）；
 *  - 视觉延续 v0.42.0 卡片语言：中性圆角底 + 标题行，与 PlanBlock 同族。
 * ============================================================ */
import { useTranslation } from 'react-i18next'
import type { FlowBlock } from '@shared/types/flow'
import { FileLink } from '../FileLink'
import { Icon } from '../../../icons'

type ArtifactBlockT = Extract<FlowBlock, { kind: 'artifact' }>

export function TaskArtifactCard({ block }: { block: ArtifactBlockT }) {
  const { t } = useTranslation()
  return (
    <div
      className="rounded-lg border border-border-subtle bg-fill-secondary px-3 py-2.5"
      data-kind="artifact-card"
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        <Icon.Box width={13} height={13} className="text-accent" aria-hidden />
        <span className="text-xs font-medium text-text-secondary">
          {t('flow.artifactCard.title')}
        </span>
        <span className="rounded-full bg-bg-base px-1.5 text-2xs tabular-nums text-text-tertiary">
          {block.entries.length}
        </span>
      </div>
      <div className="flex flex-col items-start gap-1">
        {block.entries.map((e, i) => (
          <FileLink key={`${e.path}:${i}`} path={e.path} className="text-[13px]" />
        ))}
      </div>
    </div>
  )
}
