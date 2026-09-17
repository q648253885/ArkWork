/* ============================================================
 * ArkWork — Editor: 保存冲突横幅（B2）
 * 设计文档 docs/versions/v0.31.0/04-system-design.md §6.3 硬要求 4 · 原型 07-conflict
 *
 * 三选一，**不做自动合并**（J3）：
 *   ① 对比差异     浮窗内临时只读双栏（左 = 磁盘版、右 = 内存版，不做行级 diff 高亮）
 *   ② 覆盖磁盘     先把磁盘版存进本地历史，再原子写（主进程 force 分支）
 *   ③ 还原磁盘     丢弃我的改动前，同样先存本地历史
 * 另有「稍后处理」——冲突是常驻可查的信号，不阻塞用户继续做别的事。
 *
 * 本横幅是本版**唯一的通栏打断**：左侧 3px var(--danger)，与 toast 层级严格分开。
 * ============================================================ */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../../icons'
import type { ConflictInfo } from '@shared/types/fs'

export interface ConflictBannerProps {
  info: ConflictInfo
  /** 内存版全文（对比栏右侧） */
  mineText: string
  onOverwrite: () => void
  onReload: () => void
  onDismiss: () => void
}

export function ConflictBanner({ info, mineText, onOverwrite, onReload, onDismiss }: ConflictBannerProps) {
  const { t } = useTranslation()
  const [diffOpen, setDiffOpen] = useState(false)

  return (
    <div
      className="flex-shrink-0 border-b border-border-subtle bg-danger-soft"
      style={{ borderLeft: '3px solid var(--danger)' }}
      data-conflict-banner={info.path}
      role="alert"
    >
      <div className="flex items-start gap-2 px-3 py-2">
        <Icon.X width={16} height={16} className="text-danger mt-0.5 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-2xs text-text-primary font-medium">{t('editor.conflict.title')}</div>
          <div className="text-2xs text-text-secondary mt-0.5">{t('editor.conflict.desc')}</div>
          <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
            <BannerBtn onClick={() => setDiffOpen((o) => !o)}>
              {diffOpen ? t('editor.conflict.diff.hide') : t('editor.conflict.diff.toggle')}
            </BannerBtn>
            <BannerBtn onClick={onOverwrite} danger title={t('editor.conflict.overwriteHint')}>
              {t('editor.conflict.action.overwrite')}
            </BannerBtn>
            <BannerBtn onClick={onReload} title={t('editor.conflict.reloadHint')}>
              {t('editor.conflict.action.reload')}
            </BannerBtn>
            <button
              type="button"
              onClick={onDismiss}
              className="px-2 py-0.5 text-2xs text-text-tertiary hover:text-text-primary transition-colors"
            >
              {t('editor.conflict.action.later')}
            </button>
          </div>
        </div>
      </div>

      {diffOpen && <DiffPane info={info} mineText={mineText} />}
    </div>
  )
}

/** 临时只读双栏：左 = 磁盘版、右 = 内存版（纯并排全文，不做行级 diff 高亮） */
function DiffPane({ info, mineText }: { info: ConflictInfo; mineText: string }) {
  const { t } = useTranslation()
  return (
    <div className="grid grid-cols-2 gap-px bg-border-subtle border-t border-border-subtle">
      <DiffColumn title={t('editor.conflict.diff.disk')} text={info.diskText} />
      <DiffColumn title={t('editor.conflict.diff.mine')} text={mineText} />
    </div>
  )
}

function DiffColumn({ title, text }: { title: string; text: string | null }) {
  const { t } = useTranslation()
  return (
    <div className="bg-bg-base min-w-0">
      <div className="px-2 py-1 text-2xs text-text-tertiary border-b border-border-subtle">{title}</div>
      {text === null ? (
        <div className="px-2 py-3 text-2xs text-text-tertiary">
          {t('editor.conflict.diff.unreadable')}
        </div>
      ) : (
        <pre className="px-2 py-1.5 max-h-[240px] overflow-auto text-2xs font-mono text-text-secondary whitespace-pre-wrap break-all m-0">
          {text}
        </pre>
      )}
    </div>
  )
}

function BannerBtn({
  onClick,
  children,
  danger,
  title,
}: {
  onClick: () => void
  children: React.ReactNode
  danger?: boolean
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`px-2 py-0.5 text-2xs rounded-md border transition-colors ${
        danger
          ? 'border-danger text-danger hover:bg-danger hover:text-white'
          : 'border-border-default text-text-secondary hover:bg-bg-hover hover:text-text-primary'
      }`}
    >
      {children}
    </button>
  )
}
