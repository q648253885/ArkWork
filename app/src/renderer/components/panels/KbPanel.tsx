/* ============================================================
 * ArkWork — KbPanel (v0.8.0 F810-F813)
 * 知识库面板：导入文件 / 条目列表 / 试搜框
 * - 顶部：导入按钮（多选文件对话框）+ 进度展示
 * - 列表：勾选启用 / chunks 数 / 解析失败提示 / 操作菜单（重命名/重导入/删除）
 * - 底部：试搜框（直接体验检索效果）
 * 设计文档：versions/v0.8.0/02-knowledge-base.md §7
 * ============================================================ */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../../icons'
import { useStore } from '../../store'
import { ark } from '../../ipc/client'
import type { KnowledgeBase } from '@shared/types/conversation'
import type { KbImportProgress } from '@shared/types/ipc'
import { Tooltip, EmptyState, SectionLabel } from '../ui'
export function KbPanel() {
  const { t } = useTranslation()
  const knowledgeBases = useStore((s) => s.knowledgeBases)
  const refreshKnowledge = useStore((s) => s.refreshKnowledge)
  const pushToast = useStore((s) => s.pushToast)
  const confirm = useStore((s) => s.confirm)
  const [progress, setProgress] = useState<KbImportProgress | null>(null)
  // Task 7：按文件名跟踪每条目的实时状态（parsing/indexing/done/failed），
  // 解决"解析进度只显示在顶部进度条，行内看不出状态"。
  const [itemStatus, setItemStatus] = useState<Record<string, KbImportProgress['status']>>({})
  const [itemError, setItemError] = useState<Record<string, string>>({})
  const [searchQuery, setSearchQuery] = useState('')
  const [searchHits, setSearchHits] = useState<Array<{ kbName: string; seq: number; text: string }>>([])
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    void refreshKnowledge()
    const unsubChanged = ark.kb.onChanged(() => void refreshKnowledge())
    const unsubProgress = ark.kb.onImportProgress((p) => {
      setProgress(p)
      // 按文件名匹配条目记录状态；解析中/索引中 → 实时，结束态 1200ms 后清除
      setItemStatus((prev) => ({ ...prev, [p.name]: p.status }))
      if (p.status === 'failed') {
        setItemError((prev) => ({ ...prev, [p.name]: p.error ?? t('panel.kb.parseFailed') }))
      } else {
        setItemError((prev) => {
          const { [p.name]: _drop, ...rest } = prev
          void _drop
          return rest
        })
      }
      if (p.status === 'done' || p.status === 'failed') {
        setTimeout(() => {
          setItemStatus((prev) => {
            const { [p.name]: _drop, ...rest } = prev
            void _drop
            return rest
          })
          setItemError((prev) => {
            const { [p.name]: _drop, ...rest } = prev
            void _drop
            return rest
          })
        }, 1200)
      }
    })
    return () => {
      unsubChanged()
      unsubProgress()
    }
  }, [refreshKnowledge])

  // 试搜防抖
  useEffect(() => {
    const q = searchQuery.trim()
    if (!q) {
      setSearchHits([])
      return
    }
    setSearching(true)
    const timer = setTimeout(async () => {
      try {
        const result = await ark.kb.search(q, null, 5)
        setSearchHits(result.hits)
      } catch {
        setSearchHits([])
      } finally {
        setSearching(false)
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [searchQuery])

  const handleImport = async () => {
    try {
      const filePaths = await ark.kb.pickFiles()
      if (!filePaths || filePaths.length === 0) return
      const result = await ark.kb.import(filePaths)
      pushToast({
        type: result.failed > 0 ? 'warning' : 'success',
        message: t('panel.kb.importDone', { imported: result.imported, failed: result.failed }),
        duration: 4000,
      })
    } catch (err) {
      pushToast({ type: 'danger', message: t('panel.kb.importFailed', { message: (err as Error).message }), duration: 0 })
    }
  }

  const handleToggleEnabled = async (id: string, enabled: boolean) => {
    await ark.kb.setEnabled(id, enabled)
  }

  const handleRename = async (item: KnowledgeBase) => {
    const newName = window.prompt(t('panel.kb.renamePrompt'), item.name)
    if (!newName || newName === item.name) return
    try {
      await ark.kb.rename(item.id, newName)
      pushToast({ type: 'success', message: t('panel.kb.renamed'), duration: 2000 })
    } catch (err) {
      pushToast({ type: 'danger', message: t('panel.kb.renameFailed', { message: (err as Error).message }), duration: 0 })
    }
  }

  const handleReimport = async (item: KnowledgeBase) => {
    const ok = await confirm({
      title: t('panel.kb.reimportTitle'),
      body: t('panel.kb.reimportBody', { name: item.name }),
      confirmLabel: t('panel.kb.reimport'),
    })
    if (!ok) return
    try {
      const result = await ark.kb.reimport(item.id)
      pushToast({ type: 'success', message: t('panel.kb.reimportDone', { chunks: result.chunks }), duration: 3000 })
    } catch (err) {
      pushToast({ type: 'danger', message: t('panel.kb.reimportFailed', { message: (err as Error).message }), duration: 0 })
    }
  }

  const handleRemove = async (item: KnowledgeBase) => {
    const ok = await confirm({
      title: t('panel.kb.deleteTitle'),
      body: t('panel.kb.deleteBody', { name: item.name }),
      confirmLabel: t('panel.kb.delete'),
      danger: true,
    })
    if (!ok) return
    try {
      await ark.kb.remove(item.id)
      pushToast({ type: 'success', message: t('panel.kb.deleted'), duration: 2000 })
    } catch (err) {
      pushToast({ type: 'danger', message: t('panel.kb.deleteFailed', { message: (err as Error).message }), duration: 0 })
    }
  }

  // Task 8：全局 KB 开关（KB 面板入口旁显示状态，跨任务生效）
  const globalKbEnabled = useStore((s) => s.globalKbEnabled)
  const setGlobalKbEnabled = useStore((s) => s.setGlobalKbEnabled)
  const openModulePage = useStore((s) => s.openModulePage)

  return (
    <div className="flex flex-col h-full">
      {/* 头部 */}
      <div className="flex items-center gap-2 px-3 h-9 flex-shrink-0 border-b border-border-subtle">
        <Icon.Book width={16} height={16} className="text-accent" />
        <span className="text-sm text-text-primary font-medium">{t('panel.kb.title')}</span>
        <span className="text-2xs text-text-tertiary">{t('panel.kb.count', { count: knowledgeBases.length })}</span>
        {/* Task 8：KB 入口旁显示全局开关（点 chip 直接跳设置） */}
        <Tooltip label={t('panel.kb.globalHint')}>
          <button
            onClick={() => openModulePage('settings')}
            data-kb-toggle="panel-global-hint"
            className={`flex items-center gap-1 px-1.5 h-6 rounded text-2xs transition-colors ${
              globalKbEnabled
                ? 'text-success hover:bg-bg-hover'
                : 'text-text-tertiary hover:bg-bg-hover'
            }`}
          >
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${globalKbEnabled ? 'bg-success' : 'bg-text-tertiary'}`} />
            {globalKbEnabled ? t('panel.kb.enabled') : t('panel.kb.disabled')}
          </button>
        </Tooltip>
        <button
          onClick={handleImport}
          className="ml-auto flex items-center gap-1 px-2 py-0.5 text-xs text-accent hover:bg-accent-soft rounded transition-colors"
        >
          <Icon.Plus width={16} height={16} />
          {t('panel.kb.import')}
        </button>
      </div>

      {/* 导入进度 */}
      {progress && (
        <div className="px-3 py-2 border-b border-border-subtle bg-bg-surface flex-shrink-0">
          <div className="flex items-center gap-2 text-xs">
            {progress.status === 'parsing' && <Icon.Refresh width={16} height={16} className="animate-spin text-accent" />}
            {progress.status === 'indexing' && <Icon.Refresh width={16} height={16} className="animate-spin text-accent" />}
            {progress.status === 'done' && <Icon.Check width={16} height={16} className="text-success" />}
            {progress.status === 'failed' && <Icon.X width={16} height={16} className="text-danger" />}
            <span className="text-text-primary truncate flex-1">{progress.name}</span>
            <span className={`text-2xs tabular ${
              progress.status === 'done' ? 'text-success' :
              progress.status === 'failed' ? 'text-danger' :
              'text-text-tertiary'
            }`}>
              {progress.status === 'parsing' ? t('panel.kb.parsing') :
               progress.status === 'indexing' ? t('panel.kb.indexing') :
               progress.status === 'done' ? t('panel.kb.chunks', { chunks: progress.chunks }) :
               t('panel.kb.failed')}
            </span>
          </div>
          {progress.error && (
            <div className="mt-0.5 text-2xs text-danger truncate">{progress.error}</div>
          )}
        </div>
      )}

      {/* 条目列表 */}
      <div className="flex-1 overflow-y-auto">
        {knowledgeBases.length === 0 ? (
          <EmptyState
            icon={<Icon.Book width={22} height={22} />}
            title={t('panel.kb.emptyTitle')}
            hint={t('panel.kb.emptyHint')}
          />
        ) : (
          <div className="p-2.5 space-y-1">
            <div className="px-1 pb-1">
              <SectionLabel>{t('panel.kb.documents', { count: knowledgeBases.length })}</SectionLabel>
            </div>
            {knowledgeBases.map((item) => (
              <KbItemRow
                key={item.id}
                item={item}
                liveStatus={itemStatus[item.name]}
                liveError={itemError[item.name]}
                onToggle={(enabled) => handleToggleEnabled(item.id, enabled)}
                onRename={() => handleRename(item)}
                onReimport={() => handleReimport(item)}
                onRemove={() => handleRemove(item)}
              />
            ))}
          </div>
        )}
      </div>

      {/* 底部试搜框 */}
      <div className="p-2.5 border-t border-border-subtle flex-shrink-0">
        <div className="relative">
          <Icon.Search
            width={12}
            height={12}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none"
          />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('panel.kb.searchPlaceholder')}
            className="w-full pl-7 pr-2 py-1.5 text-xs bg-bg-surface border border-border-subtle rounded-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent transition-colors"
          />
          {searching && (
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-2xs text-text-tertiary">…</span>
          )}
        </div>
        {searchHits.length > 0 && (
          <div className="mt-1.5 space-y-1 max-h-40 overflow-y-auto">
            {searchHits.map((hit, i) => (
              <div key={i} className="px-1.5 py-1 text-xs rounded-md bg-bg-surface">
                <div className="text-2xs text-text-tertiary mb-0.5">{hit.kbName} · #{hit.seq}</div>
                <div className="text-text-secondary line-clamp-3">{hit.text}</div>
              </div>
            ))}
          </div>
        )}
        {searchQuery.trim() && !searching && searchHits.length === 0 && (
          <div className="mt-1.5 px-1.5 py-2 text-2xs text-text-tertiary">{t('panel.kb.noHits')}</div>
        )}
      </div>
    </div>
  )
}

function KbItemRow({
  item,
  liveStatus,
  liveError,
  onToggle,
  onRename,
  onReimport,
  onRemove,
}: {
  item: KnowledgeBase
  liveStatus?: KbImportProgress['status']
  liveError?: string
  onToggle: (enabled: boolean) => void
  onRename: () => void
  onReimport: () => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const [showMenu, setShowMenu] = useState(false)
  const enabled = item.enabled !== false
  const hasError = !!item.parseError
  const isParsing = liveStatus === 'parsing' || liveStatus === 'indexing'
  const sizeKb = item.size > 0 ? `${(item.size / 1024).toFixed(0)}KB` : ''

  // Task 7：状态徽标解析优先级
  //   liveStatus (parsing/indexing) > parseError (failed) > 已索引
  return (
    <div
      className="group flex items-start gap-2 px-2 py-1.5 text-xs rounded-md hover:bg-bg-hover transition-colors"
      onMouseEnter={() => setShowMenu(true)}
      onMouseLeave={() => setShowMenu(false)}
    >
      <input
        type="checkbox"
        checked={enabled}
        onChange={(e) => onToggle(e.target.checked)}
        className="mt-0.5 accent-accent flex-shrink-0"
        disabled={hasError || isParsing}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className={`truncate font-medium ${hasError || isParsing ? 'text-text-tertiary' : 'text-text-primary'}`} title={item.name}>
            {item.name}
          </span>
          {/* 状态徽标：解析中 / 已索引 / 失败 */}
          {isParsing && (
            <span className="flex items-center gap-0.5 text-2xs text-accent shrink-0" data-kb-status="parsing">
              <Icon.Refresh width={16} height={16} className="animate-spin" />
              {liveStatus === 'parsing' ? t('panel.kb.statusParsing') : t('panel.kb.statusIndexing')}
            </span>
          )}
          {!isParsing && hasError && (
            <span className="text-2xs text-danger shrink-0" data-kb-status="failed">{t('panel.kb.failed')}</span>
          )}
          {!isParsing && !hasError && (
            <span className="text-2xs text-success shrink-0" data-kb-status="indexed">{t('panel.kb.indexed')}</span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-2xs text-text-tertiary uppercase">{item.type}</span>
          {sizeKb && <span className="text-2xs text-text-tertiary">{sizeKb}</span>}
          {!isParsing && !hasError && (
            <span className="text-2xs text-text-tertiary">{t('panel.kb.chunks', { chunks: item.chunks ?? 0 })}</span>
          )}
        </div>
        {/* 失败：错误摘要 + 重试按钮（始终可见，不依赖 hover） */}
        {hasError && (
          <div className="mt-0.5 flex items-start gap-2">
            <div className="text-2xs text-danger line-clamp-2 flex-1" title={item.parseError}>
              {item.parseError}
            </div>
            <button
              onClick={onReimport}
              data-kb-action="retry"
              className="flex items-center gap-0.5 px-1.5 py-0.5 text-2xs text-accent hover:bg-accent-soft rounded transition-colors shrink-0"
            >
              <Icon.Refresh width={16} height={16} />
              {t('panel.kb.retry')}
            </button>
          </div>
        )}
      </div>
      {/* 操作菜单 */}
      {showMenu && (
        <div className="flex items-center gap-0.5 flex-shrink-0">
<Tooltip label={t('panel.kb.reimportTooltip')}>
          <button
            onClick={onReimport}

            className="p-1 text-text-tertiary hover:text-accent transition-colors"
          >
            <Icon.Refresh width={16} height={16} />
          </button>
</Tooltip>
<Tooltip label={t('panel.kb.rename')}>
          <button
            onClick={onRename}

            className="p-1 text-text-tertiary hover:text-accent transition-colors"
          >
            <Icon.Edit width={16} height={16} />
          </button>
</Tooltip>
<Tooltip label={t('panel.kb.delete')}>
          <button
            onClick={onRemove}

            className="p-1 text-text-tertiary hover:text-danger transition-colors"
          >
            <Icon.X width={16} height={16} />
          </button>
</Tooltip>
        </div>
      )}
    </div>
  )
}
