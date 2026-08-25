/* ============================================================
 * ArkWork — MemoryPanel (v0.8.0)
 * 记忆中心面板：四层记忆真数据视图
 * - 顶部：上下文预算（和 Composer 右下角一致，含压缩按钮/百分比/分类占比条）
 * - Tab：[L1 上下文] [L2 产物] [L3 知识] [L4 经验]
 * - L1：勾选列表 + 蒸馏徽标 + 转化菜单
 * - L2：产物网格（缩略图，点击 → openPreview）
 * - L3：当前快照 / 待生效条目 + 档案搜索框（真 IPC 数据）
 * - L4：画像综合卡 + 观察列表 + 历史版本（真 IPC 数据）
 * 设计文档：versions/v0.8.0/01-memory.md §9
 * ============================================================ */
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../../icons'
import { useStore, friendlyError } from '../../store'
import { ark } from '../../ipc/client'
import { MEMORY_LAYER_DESC, MEMORY_ROLE_COLOR, contextColor, CONTEXT_NOISE_KINDS } from '../../constants'
import { relativeTime } from '@shared/utils/id'
import type { MemoryItem, MemoryLayer } from '../../types'
import type {
  CuratedSnapshot,
  PendingEntry,
  UserProfile,
  ArchiveHit,
  L2Memory,
} from '@shared/types/memory'
import { Tooltip, SectionLabel, EmptyState } from '../ui'
type Tab = 'L1' | 'L2' | 'L3' | 'L4'

// 蒸馏目标 → 徽标 emoji（v0.8.0 + kb）
const DISTILL_BADGE: Record<string, string> = {
  l3_fact: '📄',
  skill: '🛠',
  profile: '🧠',
  kb: '📚',
}

/** v0.8.1：L1 上下文列表过滤掉对话噪音（用户/模型对话已在交互区展示），
 * 只保留有意义的上下文资源：系统提示 / 文件引用 / 产物引用 / 技能引用 / 知识库命中
 * （对齐 Hermes 等 agent 的上下文设计：上下文 = 资源清单，而非对话记录） */
const L1_NOISE_KINDS = CONTEXT_NOISE_KINDS

export function MemoryPanel() {
  const { t } = useTranslation()
  const memory = useStore((s) => s.memory)
  const [tab, setTab] = useState<Tab>('L1')

  const TABS = useMemo<{ id: Tab; label: string }[]>(
    () => [
      { id: 'L1', label: t('panel.memory.tab_l1') },
      { id: 'L2', label: t('panel.memory.tab_l2') },
      { id: 'L3', label: t('panel.memory.tab_l3') },
      { id: 'L4', label: t('panel.memory.tab_l4') },
    ],
    [t],
  )

  const grouped: Record<MemoryLayer, MemoryItem[]> = useMemo(
    () => ({
      L1: memory.filter((m) => m.layer === 'L1' && !L1_NOISE_KINDS.has(m.kind)),
      L2: memory.filter((m) => m.layer === 'L2'),
      L3: memory.filter((m) => m.layer === 'L3'),
      L4: memory.filter((m) => m.layer === 'L4'),
    }),
    [memory],
  )

  return (
    <div className="flex flex-col h-full">
      {/* 头部 */}
      <div className="flex items-center gap-2 px-3 h-9 flex-shrink-0 border-b border-border-subtle">
        <span className="text-sm text-text-primary font-medium">{t('panel.memory.title')}</span>
        <span className="text-2xs text-text-tertiary">{t('panel.memory.count', { count: memory.length })}</span>
      </div>

      {/* 上下文预算（v0.8.0 对齐 Trae Work：压缩按钮/百分比/分类占比条） */}
      <ContextBudget />

      {/* Tab 栏 */}
      <div className="flex items-center gap-0 px-2 border-b border-border-subtle flex-shrink-0">
        {TABS.map((t) => {
          const active = tab === t.id
          const count = grouped[t.id].length
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-2.5 py-2 text-xs font-medium border-b-2 -mb-px transition-colors ${
                active
                  ? 'text-accent border-accent'
                  : 'text-text-secondary border-transparent hover:text-text-primary'
              }`}
            >
              {t.label}
              {count > 0 && (
                <span className="ml-1 text-2xs text-text-tertiary tabular">{count}</span>
              )}
            </button>
          )
        })}
      </div>

      {/* 内容 */}
      <div className="flex-1 overflow-y-auto">
        {memory.length === 0 && tab === 'L1' ? (
          <EmptyState
            icon={<Icon.Brain width={22} height={22} />}
            title={t('panel.memory.l1_empty_title')}
            hint={t('panel.memory.l1_empty_hint')}
          />
        ) : tab === 'L1' ? (
          <L1View items={grouped.L1} />
        ) : tab === 'L2' ? (
          <L2View />
        ) : tab === 'L3' ? (
          <L3View />
        ) : (
          <L4View />
        )}
      </div>
    </div>
  )
}

/* ============================================================
 * ContextBudget — 上下文预算（v0.8.0 对齐 Trae Work）
 * 数据源：store.memory（与 Composer 右下角 ctx 圆环一致）
 * 展示：百分比 + 占比条（分类色段）+ 压缩按钮 + 分类图例
 * 分类：系统 / 用户 / 对话 / 文件 / 技能 / 知识库 / 其他
 * ============================================================ */

/** MemoryKind → 分类映射 */
function classifyKind(kind: MemoryItem['kind']): string {
  switch (kind) {
    case 'system_prompt':
      return 'system'
    case 'user_message':
      return 'user'
    case 'file_ref':
      return 'file'
    case 'distilled_skill_ref':
      return 'skill'
    case 'kb_hit':
      return 'kb'
    case 'reasoning':
    case 'action':
    case 'observation':
    case 'summary':
    case 'compressed_summary':
      return 'conversation'
    default:
      return 'other'
  }
}

/** v0.16 Task 7：L2 压缩记忆单独计入占比分类（按 layer 优先判定） */
function classifyItem(m: MemoryItem): string {
  if (m.layer === 'L2') return 'l2'
  return classifyKind(m.kind)
}

function buildCategoryMeta(t: (k: string) => string): Record<string, { label: string; color: string }> {
  return {
    system:       { label: t('panel.memory.cat.system'),       color: 'var(--text-tertiary)' },
    user:         { label: t('panel.memory.cat.user'),         color: 'var(--accent)' },
    conversation: { label: t('panel.memory.cat.conversation'), color: 'var(--success)' },
    file:         { label: t('panel.memory.cat.file'),         color: 'var(--warning)' },
    skill:        { label: t('panel.memory.cat.skill'),        color: '#a855f7' },
    kb:           { label: t('panel.memory.cat.kb'),           color: '#06B6D4' },
    l2:           { label: t('panel.memory.cat.l2'),           color: '#10B981' },
    other:        { label: t('panel.memory.cat.other'),        color: '#666B75' },
  }
}

function ContextBudget() {
  const { t } = useTranslation()
  const memory = useStore((s) => s.memory)
  const models = useStore((s) => s.models)
  const selectedModelId = useStore((s) => s.selectedModelId)
  const selectedTaskId = useStore((s) => s.selectedTaskId)
  const refreshMemory = useStore((s) => s.refreshMemory)
  const pushToast = useStore((s) => s.pushToast)
  const pushCtxChip = useStore((s) => s.pushCtxChip)
  const [compressing, setCompressing] = useState(false)

  const CATEGORY_META = buildCategoryMeta(t)

  const model = models.find((m) => m.id === selectedModelId)
  const contextSize = useStore((s) => s.contextSize)
  // 百分比分母用引擎真实预算（≈窗口×85%，封顶 64K），对齐压缩触发线
  const ctxBudget = contextSize?.budget ?? model?.contextWindow ?? 128_000
  const ctxWindow = contextSize?.modelContextWindow ?? model?.contextWindow ?? ctxBudget

  const activeItems = useMemo(
    () => memory.filter((m) => m.enabled && !m.archivedAt),
    [memory],
  )
  const ctxUsed = useMemo(
    () => contextSize?.payloadTokens ?? activeItems.reduce((s, m) => s + m.tokens, 0),
    [contextSize, activeItems],
  )
  const ctxPct = Math.min(100, Math.round((ctxUsed / ctxBudget) * 100))
  const color = contextColor(ctxPct)

  // 分类 token 统计
  const categoryTokens = useMemo(() => {
    const map = new Map<string, number>()
    for (const m of activeItems) {
      const cat = classifyItem(m)
      map.set(cat, (map.get(cat) ?? 0) + m.tokens)
    }
    return map
  }, [activeItems])

  const handleCompress = async () => {
    if (!selectedTaskId) return
    setCompressing(true)
    try {
      const result = await window.ark.memory.compress({
        taskId: selectedTaskId,
        policy: {
          keepSystem: true,
          keepRecentTurns: 3,
          keepUserTurns: true,
          keepFileRefs: true,
          dropFailed: true,
        },
      })
      await refreshMemory(selectedTaskId)
      pushToast({
        type: 'success',
        message: t('panel.memory.compress_done', {
          before: result.beforeTokens,
          after: result.afterTokens,
        }),
        duration: 4000,
      })
      pushCtxChip({
        text: t('panel.memory.compress_chip', {
          before: result.beforeTokens,
          after: result.afterTokens,
        }),
        variant: 'compress',
      })
    } catch (err) {
      pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    } finally {
      setCompressing(false)
    }
  }

  return (
    <div className="px-3 py-2.5 border-b border-border-subtle flex-shrink-0">
      {/* 第一行：标题 + 用量 + 压缩按钮 */}
      <div className="flex items-center gap-2 text-xs mb-2">
        <span className="text-text-tertiary">{t('panel.memory.ctx')}</span>
        <span className="tabular font-medium" style={{ color }}>
          {ctxUsed.toLocaleString()}
        </span>
        <span className="text-text-tertiary tabular">
          {t('panel.memory.budget', { value: ctxBudget.toLocaleString() })}
        </span>
        <span className="ml-auto flex items-center gap-2">
          <span className="text-2xs tabular font-medium" style={{ color }}>
            {ctxPct}%
          </span>
          <Tooltip
            label={t('panel.memory.compress')}
            desc={selectedTaskId ? t('panel.memory.compress_desc_selected') : t('panel.memory.compress_desc_none')}
            delay={150}
          >
            <button
              onClick={() => void handleCompress()}
              disabled={compressing || !selectedTaskId || ctxUsed === 0}
              aria-label={t('panel.memory.compress')}
              className="flex items-center gap-1 h-6 px-2 rounded-md text-2xs font-medium text-text-secondary bg-bg-hover hover:bg-bg-active hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <Icon.Refresh
                width={11}
                height={11}
                className={compressing ? 'animate-spin' : ''}
              />
              {t('panel.memory.compress')}
            </button>
          </Tooltip>
        </span>
      </div>

      {/* 第二行：分类占比条（多色叠加） */}
      <div className="h-2 bg-bg-elevated rounded-full overflow-hidden flex">
        {ctxUsed > 0 &&
          Array.from(categoryTokens.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([cat, tokens]) => {
              const meta = CATEGORY_META[cat]
              const w = (tokens / ctxUsed) * Math.min(ctxPct, 100)
              const pct = ctxUsed > 0 ? Math.round((tokens / ctxUsed) * 100) : 0
              return (
                <Tooltip
                  label={t('panel.memory.category_tooltip', {
                    label: meta?.label ?? cat,
                    tokens: tokens.toLocaleString(),
                    pct,
                  })}
                >
                  <div
                    key={cat}
                    style={{ width: `${w}%`, background: meta?.color ?? 'var(--text-tertiary)' }}
                    className="h-full transition-all"

                  />
                </Tooltip>
              )
            })}
      </div>

      {/* 第三行：图例 */}
      <div className="flex items-center gap-2.5 mt-1.5 flex-wrap">
        {Array.from(categoryTokens.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([cat, tokens]) => {
            const meta = CATEGORY_META[cat]
            if (!meta) return null
            const catPct = ctxUsed > 0 ? Math.round((tokens / ctxUsed) * 100) : 0
            return (
              <span key={cat} className="flex items-center gap-1 text-2xs text-text-tertiary tabular">
                <span
                  className="w-2 h-2 rounded-sm flex-shrink-0"
                  style={{ background: meta.color }}
                />
                {meta.label}
                <span className="text-text-tertiary">{tokens.toLocaleString()}</span>
              </span>
            )
          })}
        {categoryTokens.size === 0 && (
          <span className="text-2xs text-text-tertiary">{t('panel.memory.no_ctx_data')}</span>
        )}
      </div>
    </div>
  )
}

/* ============================================================
 * L1 — 工作记忆：勾选列表 + 蒸馏徽标 + 转化菜单
 * ============================================================ */
function L1View({ items }: { items: MemoryItem[] }) {
  const { t } = useTranslation()
  const selectedTaskId = useStore((s) => s.selectedTaskId)
  const toggleMemory = useStore((s) => s.toggleMemory)

  const handleToggle = (id: string, enabled: boolean) => {
    if (!selectedTaskId) return
    void toggleMemory(selectedTaskId, id, enabled)
  }

  if (items.length === 0) {
    return <EmptyState icon={<Icon.Brain width={20} height={20} />} title={t('panel.memory.l1_empty')} />
  }

  return (
    <div className="px-2 py-2">
      <div className="px-1.5 pb-1.5">
        <SectionLabel>{MEMORY_LAYER_DESC.L1}</SectionLabel>
      </div>
      {items.map((item) => (
        <MemoryItemRow
          key={item.id}
          item={item}
          onToggle={() => handleToggle(item.id, !item.enabled)}
        />
      ))}
    </div>
  )
}

function MemoryItemRow({
  item,
  onToggle,
}: {
  item: MemoryItem
  onToggle: () => void
}) {
  const { t } = useTranslation()
  const roleColor = MEMORY_ROLE_COLOR[item.role] ?? '#666B75'
  const distilledBadge = item.distilled ? DISTILL_BADGE[item.distilled.target] : null
  const [showMenu, setShowMenu] = useState(false)

  return (
    <div
      className={`group flex items-start gap-2 px-1.5 py-1 text-xs rounded-md transition-colors hover:bg-bg-hover ${
        item.enabled ? '' : 'opacity-50'
      }`}
      onMouseEnter={() => setShowMenu(true)}
      onMouseLeave={() => setShowMenu(false)}
    >
      <input
        type="checkbox"
        checked={item.enabled}
        onChange={onToggle}
        className="mt-0.5 accent-accent flex-shrink-0"
      />
      <span className="w-1 h-3 mt-1 rounded-sm flex-shrink-0" style={{ background: roleColor }} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-0.5">
          <span className="text-2xs text-text-tertiary uppercase tracking-wider">{item.kind}</span>
          {item.meta && (
            <span className="text-2xs text-text-tertiary truncate">{item.meta}</span>
          )}
          {distilledBadge && (
            <Tooltip label={t('panel.memory.distill_tooltip', { target: item.distilled!.target })} desc={t('panel.memory.distill_desc')}>
              <span className="flex-shrink-0">
                {distilledBadge}
              </span>
            </Tooltip>
          )}
          {item.tokens > 0 && (
            <span className="ml-auto text-2xs text-text-tertiary tabular">{item.tokens}t</span>
          )}
        </div>
        <div className="text-text-secondary truncate" title={item.content}>
          {item.content}
        </div>
      </div>
    </div>
  )
}

/* ============================================================
 * L2 — 压缩记忆（v0.16 Task 7）
 * 纯文本 + 小图标的紧凑列表，不展示大 JSON 卡片。
 * 每行：复选框 + 小图标 + summary + 意图标签 + 时间 + 压缩 token
 * 管理：查看（展开详情）/ 删除 / 合并（多选）/ 导出 / 搜索筛选
 * 数据源：memory:l2-list / memory:l2-detail（压缩后的摘要）
 * ============================================================ */

/** 意图 → 标签色 */
const L2_INTENT_COLOR: Record<string, string> = {
  'error-recovery': 'var(--danger)',
  config: 'var(--warning)',
  test: 'var(--success)',
  api: '#06B6D4',
  doc: '#a855f7',
  data: '#3B82F6',
  refactor: '#F59E0B',
  artifact: 'var(--text-tertiary)',
  general: 'var(--text-tertiary)',
}

function L2View() {
  const { t } = useTranslation()
  const selectedTaskId = useStore((s) => s.selectedTaskId)
  const refreshMemory = useStore((s) => s.refreshMemory)
  const pushToast = useStore((s) => s.pushToast)
  const [items, setItems] = useState<L2Memory[]>([])
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [intentFilter, setIntentFilter] = useState<string>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<L2Memory | null>(null)

  const reload = async () => {
    if (!selectedTaskId) {
      setItems([])
      return
    }
    setLoading(true)
    try {
      setItems(await ark.memory.l2List(selectedTaskId))
    } catch (err) {
      pushToast({ type: 'danger', message: t('panel.memory.load_failed', { msg: (err as Error).message }), duration: 3000 })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void reload()
    const unsub = ark.memory.onChanged(() => void reload())
    return () => unsub()
  }, [selectedTaskId])

  // 搜索 + 意图筛选
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return items.filter((m) => {
      if (intentFilter !== 'all' && m.intent !== intentFilter) return false
      if (!q) return true
      return (
        m.summary.toLowerCase().includes(q) ||
        m.entities.some((e) => e.toLowerCase().includes(q)) ||
        m.intent.toLowerCase().includes(q) ||
        m.compressedContent.toLowerCase().includes(q)
      )
    })
  }, [items, query, intentFilter])

  const intents = useMemo(() => {
    const set = new Set(items.map((m) => m.intent))
    return ['all', ...Array.from(set).sort()]
  }, [items])

  const totalCompressedTokens = useMemo(
    () => items.reduce((s, m) => s + m.compressedTokens, 0),
    [items],
  )

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleDelete = async (id: string) => {
    if (!selectedTaskId) return
    try {
      const next = await ark.memory.l2Delete(selectedTaskId, id)
      setItems(next)
      setSelected((prev) => {
        const n = new Set(prev)
        n.delete(id)
        return n
      })
      if (expandedId === id) {
        setExpandedId(null)
        setDetail(null)
      }
      await refreshMemory(selectedTaskId)
      pushToast({ type: 'success', message: t('panel.memory.deleted'), duration: 2000 })
    } catch (err) {
      pushToast({ type: 'danger', message: t('panel.memory.delete_failed', { msg: (err as Error).message }), duration: 0 })
    }
  }

  const handleMerge = async () => {
    if (!selectedTaskId || selected.size < 2) return
    try {
      const merged = await ark.memory.l2Merge(selectedTaskId, Array.from(selected))
      if (merged) {
        pushToast({ type: 'success', message: t('panel.memory.merged', { count: selected.size }), duration: 3000 })
      }
      setSelected(new Set())
      await reload()
      await refreshMemory(selectedTaskId)
    } catch (err) {
      pushToast({ type: 'danger', message: t('panel.memory.merge_failed', { msg: (err as Error).message }), duration: 0 })
    }
  }

  const handleExport = async (ids?: string[]) => {
    if (!selectedTaskId) return
    try {
      const { json, count } = await ark.memory.l2Export(selectedTaskId, ids)
      const blob = new Blob([json], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `l2-memory-${selectedTaskId}.json`
      a.click()
      URL.revokeObjectURL(url)
      pushToast({ type: 'success', message: t('panel.memory.exported', { count }), duration: 3000 })
    } catch (err) {
      pushToast({ type: 'danger', message: t('panel.memory.export_failed', { msg: (err as Error).message }), duration: 0 })
    }
  }

  const handleExpand = async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null)
      setDetail(null)
      return
    }
    setExpandedId(id)
    setDetail(null)
    if (!selectedTaskId) return
    try {
      setDetail(await ark.memory.l2Detail(selectedTaskId, id))
    } catch {
      // 静默
    }
  }

  if (items.length === 0 && !loading) {
    return (
      <EmptyState
        icon={<Icon.Box width={20} height={20} />}
        title={t('panel.memory.l2_empty_title')}
        hint={t('panel.memory.l2_empty_hint')}
      />
    )
  }

  return (
    <div className="py-2">
      <div className="px-2 pb-1.5 flex items-center gap-1.5">
        <SectionLabel>{MEMORY_LAYER_DESC.L2}</SectionLabel>
        <span className="text-2xs text-text-tertiary tabular ml-auto">
          {t('panel.memory.l2_count', { count: items.length, tokens: totalCompressedTokens })}
        </span>
      </div>

      {/* 工具栏：搜索 + 意图筛选 + 导出全部 */}
      <div className="px-2 pb-1.5 flex items-center gap-1.5">
        <div className="relative flex-1">
          <Icon.Search
            width={12}
            height={12}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('panel.memory.l2_search_placeholder')}
            className="w-full pl-7 pr-2 py-1 text-xs bg-bg-surface border border-border-subtle rounded-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent transition-colors"
          />
        </div>
        <select
          value={intentFilter}
          onChange={(e) => setIntentFilter(e.target.value)}
          className="h-6 px-1.5 text-2xs bg-bg-surface border border-border-subtle rounded-md text-text-secondary focus:outline-none focus:border-accent"
        >
          {intents.map((i) => (
            <option key={i} value={i}>
              {i === 'all' ? t('panel.memory.all_intents') : i}
            </option>
          ))}
        </select>
        <Tooltip label={t('panel.memory.export_all')}>
          <button
            onClick={() => void handleExport()}
            className="flex items-center justify-center h-6 w-6 rounded-md text-text-tertiary bg-bg-hover hover:bg-bg-active hover:text-text-primary transition-colors"
          >
            <Icon.Download width={12} height={12} />
          </button>
        </Tooltip>
      </div>

      {/* 选择操作栏 */}
      {selected.size > 0 && (
        <div className="mx-2 mb-1.5 px-2 py-1 flex items-center gap-2 rounded-md bg-bg-surface border border-border-subtle text-2xs">
          <span className="text-text-secondary">{t('panel.memory.selected', { count: selected.size })}</span>
          <button
            onClick={() => void handleMerge()}
            disabled={selected.size < 2}
            className="text-accent hover:underline disabled:opacity-40"
          >
            {t('panel.memory.merge_selected')}
          </button>
          <button
            onClick={() => void handleExport(Array.from(selected))}
            className="text-text-secondary hover:text-text-primary"
          >
            {t('panel.memory.export_selected')}
          </button>
          <button
            onClick={() => setSelected(new Set())}
            className="ml-auto text-text-tertiary hover:text-text-primary"
          >
            {t('panel.memory.cancel')}
          </button>
        </div>
      )}

      {/* 紧凑列表 */}
      <div className="px-1">
        {filtered.map((m) => (
          <L2MemoryRow
            key={m.id}
            item={m}
            selected={selected.has(m.id)}
            expanded={expandedId === m.id}
            detail={expandedId === m.id ? detail : null}
            onToggleSelect={() => toggleSelect(m.id)}
            onExpand={() => void handleExpand(m.id)}
            onDelete={() => void handleDelete(m.id)}
          />
        ))}
        {filtered.length === 0 && (
          <div className="px-2 py-3 text-2xs text-text-tertiary">{t('panel.memory.no_match')}</div>
        )}
      </div>
    </div>
  )
}

/** L2 紧凑列表行：小图标 + summary + 意图 + 时间 + token，展开显示详情 */
function L2MemoryRow({
  item,
  selected,
  expanded,
  detail,
  onToggleSelect,
  onExpand,
  onDelete,
}: {
  item: L2Memory
  selected: boolean
  expanded: boolean
  detail: L2Memory | null
  onToggleSelect: () => void
  onExpand: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const intentColor = L2_INTENT_COLOR[item.intent] ?? 'var(--text-tertiary)'
  return (
    <div className="group rounded-md hover:bg-bg-hover transition-colors">
      {/* 主行：复选框 + 小图标 + summary + 意图 + 时间 + token + 悬浮操作 */}
      <div className="flex items-center gap-1.5 px-1.5 py-1 text-xs">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          className="flex-shrink-0 accent-accent"
          style={{ width: 12, height: 12 }}
        />
        <Icon.File width={13} height={13} className="text-text-tertiary flex-shrink-0" />
        <button
          onClick={onExpand}
          className="flex-1 min-w-0 text-left text-text-primary truncate hover:text-accent transition-colors"
          title={item.summary}
        >
          {item.summary}
        </button>
        <span
          className="text-2xs px-1 rounded-sm flex-shrink-0 truncate max-w-[80px]"
          style={{ color: intentColor }}
          title={item.intent}
        >
          {item.intent}
        </span>
        <span className="text-2xs text-text-tertiary tabular flex-shrink-0">
          {relativeTime(item.updatedAt)}
        </span>
        <span className="text-2xs text-text-tertiary tabular flex-shrink-0">
          {item.compressedTokens}t
        </span>
        <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          <Tooltip label={expanded ? t('panel.memory.collapse') : t('panel.memory.view_detail')}>
            <button onClick={onExpand} className="text-text-tertiary hover:text-accent p-0.5">
              <Icon.Eye width={12} height={12} />
            </button>
          </Tooltip>
          <Tooltip label={t('panel.memory.delete')}>
            <button onClick={onDelete} className="text-text-tertiary hover:text-danger p-0.5">
              <Icon.Trash width={12} height={12} />
            </button>
          </Tooltip>
        </div>
      </div>
      {/* 展开详情：实体 / 压缩内容 / 引用 / 原始内容 */}
      {expanded && (
        <div className="px-1.5 pb-1.5 pl-7 space-y-1.5 text-2xs text-text-secondary">
          {detail ? (
            <>
              <div className="flex items-center gap-1 flex-wrap">
                <span className="text-text-tertiary flex-shrink-0">{t('panel.memory.entity')}</span>
                {detail.entities.length === 0 ? (
                  <span className="text-text-tertiary">{t('panel.memory.none')}</span>
                ) : (
                  detail.entities.slice(0, 10).map((e) => (
                    <span key={e} className="px-1 rounded-sm bg-bg-elevated text-text-secondary">
                      {e}
                    </span>
                  ))
                )}
              </div>
              <div>
                <span className="text-text-tertiary">{t('panel.memory.compressed_content')}</span>
                <pre className="mt-0.5 px-1.5 py-1 bg-bg-elevated rounded text-2xs text-text-secondary whitespace-pre-wrap break-all">
                  {detail.compressedContent}
                </pre>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-text-tertiary flex-shrink-0">{t('panel.memory.references')}</span>
                <span className="text-text-tertiary truncate">
                  {detail.references.join(', ') || t('panel.memory.none')}
                </span>
                <span className="ml-auto text-text-tertiary tabular flex-shrink-0">
                  {new Date(detail.createdAt).toLocaleString()}
                </span>
              </div>
              {detail.rawContent && (
                <div>
                  <span className="text-text-tertiary">{t('panel.memory.raw_content')}</span>
                  <pre className="mt-0.5 px-1.5 py-1 bg-bg-elevated rounded text-2xs text-text-tertiary whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
                    {detail.rawContent.slice(0, 4000)}
                    {detail.rawContent.length > 4000 ? t('panel.memory.truncated_suffix') : ''}
                  </pre>
                </div>
              )}
            </>
          ) : (
            <div className="text-text-tertiary">{t('panel.memory.loading')}</div>
          )}
        </div>
      )}
    </div>
  )
}

/* ============================================================
 * L3 — 知识记忆（v0.8.0 真数据：策展快照 + 待生效 + 档案搜索）
 * ============================================================ */
function L3View() {
  const { t } = useTranslation()
  const [curated, setCurated] = useState<CuratedSnapshot | null>(null)
  const [pending, setPending] = useState<PendingEntry[]>([])
  const [archiveQuery, setArchiveQuery] = useState('')
  const [archiveHits, setArchiveHits] = useState<ArchiveHit[]>([])
  const [searching, setSearching] = useState(false)
  const pushToast = useStore((s) => s.pushToast)

  const reload = async () => {
    try {
      const [c, p] = await Promise.all([ark.memory.l3Get(), ark.memory.l3PendingList()])
      setCurated(c)
      setPending(p)
    } catch {
      // 静默
    }
  }

  useEffect(() => {
    reload()
    const unsub = ark.memory.onChanged(() => reload())
    return () => unsub()
  }, [])

  // 档案搜索（防抖 300ms）
  useEffect(() => {
    const q = archiveQuery.trim()
    if (!q) {
      setArchiveHits([])
      return
    }
    setSearching(true)
    const timer = setTimeout(async () => {
      try {
        const hits = await ark.memory.archiveSearch(q, 10)
        setArchiveHits(hits)
      } catch {
        setArchiveHits([])
      } finally {
        setSearching(false)
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [archiveQuery])

  const handleApplyPending = async () => {
    try {
      const result = await ark.memory.l3PendingApply()
      pushToast({
        type: 'success',
        message: t('panel.memory.pending_merged', {
          count: result.applied,
          suffix: result.merged ? t('panel.memory.pending_merged_suffix') : '',
        }),
        duration: 3000,
      })
      reload()
    } catch (err) {
      pushToast({ type: 'danger', message: t('panel.memory.merge_failed', { msg: (err as Error).message }), duration: 0 })
    }
  }

  const handleDiscardPending = async (id: string) => {
    await ark.memory.l3PendingDiscard([id])
    reload()
  }

  return (
    <div className="p-2.5 space-y-3">
      <div>
        <SectionLabel>{MEMORY_LAYER_DESC.L3}</SectionLabel>
      </div>

      {/* 当前快照 */}
      <div className="space-y-2">
        <div className="px-1 text-2xs text-text-tertiary">{t('panel.memory.curated_snapshot')}</div>
        <CuratedFileView
          title="memory.md"
          content={curated?.memoryMd ?? ''}
          chars={curated?.memoryChars ?? 0}
          budget={curated?.memoryBudget ?? 2200}
          onSave={async (content) => {
            await ark.memory.l3Update('memory.md', content)
            reload()
          }}
        />
        <CuratedFileView
          title="user.md"
          content={curated?.userMd ?? ''}
          chars={curated?.userChars ?? 0}
          budget={curated?.userBudget ?? 1375}
          onSave={async (content) => {
            await ark.memory.l3Update('user.md', content)
            reload()
          }}
        />
      </div>

      {/* 待生效条目 */}
      <div>
        <div className="flex items-center gap-2 px-1 pb-1">
          <span className="text-2xs text-text-tertiary">{t('panel.memory.pending', { count: pending.length })}</span>
          {pending.length > 0 && (
            <button
              onClick={handleApplyPending}
              className="text-2xs text-accent hover:underline"
            >
              {t('panel.memory.merge_all')}
            </button>
          )}
        </div>
        {pending.length === 0 ? (
          <div className="px-1.5 py-2 text-2xs text-text-tertiary">{t('panel.memory.no_pending')}</div>
        ) : (
          pending.map((entry) => (
            <div
              key={entry.id}
              className="group flex items-start gap-1.5 px-1.5 py-1 text-xs text-text-secondary rounded-md hover:bg-bg-hover"
            >
              <span className="text-text-tertiary mt-0.5">⏳</span>
              <span className="flex-1 truncate" title={entry.line}>{entry.line}</span>
              <span className="text-2xs text-text-tertiary flex-shrink-0">{entry.targetFile}</span>
<Tooltip label={t('panel.memory.discard')}>
              <button
                onClick={() => handleDiscardPending(entry.id)}
                className="opacity-0 group-hover:opacity-100 text-text-tertiary hover:text-danger transition-opacity flex-shrink-0"

              >
                ✕
              </button>
</Tooltip>
            </div>
          ))
        )}
      </div>

      {/* 档案搜索 */}
      <div>
        <div className="px-1 pb-1 text-2xs text-text-tertiary">{t('panel.memory.archive_search')}</div>
        <div className="relative">
          <Icon.Search
            width={12}
            height={12}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none"
          />
          <input
            value={archiveQuery}
            onChange={(e) => setArchiveQuery(e.target.value)}
            placeholder={t('panel.memory.archive_placeholder')}
            className="w-full pl-7 pr-2 py-1 text-xs bg-bg-surface border border-border-subtle rounded-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent transition-colors"
          />
          {searching && (
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-2xs text-text-tertiary">
              …
            </span>
          )}
        </div>
        {archiveHits.length > 0 && (
          <div className="mt-1.5 space-y-1">
            {archiveHits.map((hit) => (
<Tooltip label={t('panel.memory.copy_snippet')}>
              <button
                key={hit.itemId}
                onClick={() => navigator.clipboard?.writeText(hit.snippet)}
                className="block w-full text-left px-1.5 py-1 text-xs rounded-md hover:bg-bg-hover transition-colors"

              >
                <div className="flex items-center gap-1.5 mb-0.5">
                  <span className="text-2xs text-text-tertiary truncate flex-1">{hit.taskTitle}</span>
                  <span className="text-2xs text-text-tertiary tabular">
                    {new Date(hit.createdAt).toLocaleDateString()}
                  </span>
                </div>
                <div className="text-text-secondary line-clamp-2">{hit.snippet}</div>
              </button>
</Tooltip>
            ))}
          </div>
        )}
        {archiveQuery.trim() && !searching && archiveHits.length === 0 && (
          <div className="px-1.5 py-2 text-2xs text-text-tertiary">{t('panel.memory.no_hit')}</div>
        )}
      </div>
    </div>
  )
}

/** 策展文件视图（可展开编辑） */
function CuratedFileView({
  title,
  content,
  chars,
  budget,
  onSave,
}: {
  title: string
  content: string
  chars: number
  budget: number
  onSave: (content: string) => Promise<void>
}) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(content)
  const [saving, setSaving] = useState(false)
  const overBudget = chars > budget

  useEffect(() => {
    setDraft(content)
  }, [content])

  const handleSave = async () => {
    setSaving(true)
    try {
      await onSave(draft)
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="px-1.5 py-1.5 rounded-md bg-bg-surface border border-border-subtle">
      <div className="flex items-center gap-1.5 mb-1">
        <span className="text-2xs text-text-primary font-medium">{title}</span>
        <span className={`text-2xs tabular ${overBudget ? 'text-warning' : 'text-text-tertiary'}`}>
          {chars}/{budget}
        </span>
        <button
          onClick={() => setEditing(!editing)}
          className="ml-auto text-2xs text-text-tertiary hover:text-accent transition-colors"
        >
          {editing ? t('panel.memory.cancel') : t('panel.memory.edit')}
        </button>
      </div>
      {editing ? (
        <div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="w-full h-24 px-2 py-1 text-xs bg-bg-base border border-border-subtle rounded text-text-primary focus:outline-none focus:border-accent resize-none"
          />
          <button
            onClick={handleSave}
            disabled={saving}
            className="mt-1 px-2 py-0.5 text-2xs bg-accent text-white rounded hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {saving ? t('panel.memory.saving') : t('panel.memory.save_immediate')}
          </button>
        </div>
      ) : (
        <div className="text-xs text-text-secondary leading-relaxed line-clamp-4 whitespace-pre-wrap">
          {content || t('panel.memory.empty')}
        </div>
      )}
    </div>
  )
}

/* ============================================================
 * L4 — 经验记忆（v0.8.0 真数据：画像合成 + 观察 + 历史）
 * ============================================================ */
function L4View() {
  const { t } = useTranslation()
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const pushToast = useStore((s) => s.pushToast)

  const reload = async () => {
    try {
      setProfile(await ark.memory.l4Get())
    } catch {
      // 静默
    }
  }

  useEffect(() => {
    reload()
    const unsub = ark.memory.onChanged(() => reload())
    return () => unsub()
  }, [])

  if (!profile) {
    return <EmptyState icon={<Icon.Bot width={20} height={20} />} title={t('panel.memory.loading')} />
  }

  const handleDeleteObs = async (id: string) => {
    try {
      const next = await ark.memory.l4DeleteObservation(id)
      setProfile(next)
    } catch (err) {
      pushToast({ type: 'danger', message: t('panel.memory.delete_failed', { msg: (err as Error).message }), duration: 0 })
    }
  }

  const handleRollback = async (version: number) => {
    try {
      const next = await ark.memory.l4Rollback(version)
      setProfile(next)
      pushToast({ type: 'success', message: t('panel.memory.rolled_back', { version }), duration: 3000 })
    } catch (err) {
      pushToast({ type: 'danger', message: t('panel.memory.rollback_failed', { msg: (err as Error).message }), duration: 0 })
    }
  }

  return (
    <div className="p-2.5 space-y-3">
      <SectionLabel>{MEMORY_LAYER_DESC.L4}</SectionLabel>

      {/* 画像综合卡 */}
      <ProfileSynthesisCard profile={profile} onUpdate={reload} />

      {/* 观察列表 */}
      <div>
        <div className="px-1 pb-1 text-2xs text-text-tertiary">{t('panel.memory.observations', { count: profile.observations.length })}</div>
        {profile.observations.length === 0 ? (
          <div className="px-1.5 py-2 text-2xs text-text-tertiary">{t('panel.memory.no_observations')}</div>
        ) : (
          profile.observations.slice(0, 20).map((obs) => (
            <div
              key={obs.id}
              className="group flex items-start gap-1.5 px-1.5 py-1 text-xs text-text-secondary rounded-md hover:bg-bg-hover"
            >
              <span className="text-text-tertiary mt-0.5">·</span>
              <span className="flex-1 truncate" title={obs.text}>{obs.text}</span>
<Tooltip label={t('panel.memory.delete')}>
              <button
                onClick={() => handleDeleteObs(obs.id)}
                className="opacity-0 group-hover:opacity-100 text-text-tertiary hover:text-danger transition-opacity flex-shrink-0"

              >
                ✕
              </button>
</Tooltip>
            </div>
          ))
        )}
      </div>

      {/* 历史版本 */}
      {profile.history.length > 0 && (
        <div>
          <div className="px-1 pb-1 text-2xs text-text-tertiary">{t('panel.memory.history', { count: profile.history.length })}</div>
          {profile.history.slice(0, 5).map((h) => (
            <div
              key={h.version}
              className="group flex items-center gap-1.5 px-1.5 py-1 text-xs text-text-secondary rounded-md hover:bg-bg-hover"
            >
              <span className="text-2xs text-text-tertiary tabular">v{h.version}</span>
              <span className="text-2xs text-text-tertiary">
                {new Date(h.archivedAt).toLocaleDateString()}
              </span>
<Tooltip label={t('panel.memory.rollback_tooltip')}>
              <button
                onClick={() => handleRollback(h.version)}
                className="ml-auto opacity-0 group-hover:opacity-100 text-2xs text-text-tertiary hover:text-accent transition-opacity"

              >
                {t('panel.memory.rollback')}
              </button>
</Tooltip>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** 画像 synthesis 编辑卡 */
function ProfileSynthesisCard({
  profile,
  onUpdate,
}: {
  profile: UserProfile
  onUpdate: () => void
}) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(profile.synthesis)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setDraft(profile.synthesis)
  }, [profile.synthesis])

  const handleSave = async () => {
    setSaving(true)
    try {
      await ark.memory.l4UpdateSynthesis(draft)
      setEditing(false)
      onUpdate()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="p-3 rounded-lg bg-bg-surface border border-border-subtle">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Icon.Bot width={16} height={16} className="text-accent" />
        <span className="text-xs text-text-primary font-medium">{t('panel.memory.user_profile')}</span>
        <span className="text-2xs text-text-tertiary tabular">v{profile.version}</span>
        <button
          onClick={() => setEditing(!editing)}
          className="ml-auto text-2xs text-text-tertiary hover:text-accent transition-colors"
        >
          {editing ? t('panel.memory.cancel') : t('panel.memory.edit')}
        </button>
      </div>
      {editing ? (
        <div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="w-full h-24 px-2 py-1 text-xs bg-bg-base border border-border-subtle rounded text-text-primary focus:outline-none focus:border-accent resize-none"
          />
          <button
            onClick={handleSave}
            disabled={saving}
            className="mt-1 px-2 py-0.5 text-2xs bg-accent text-white rounded hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {saving ? t('panel.memory.saving') : t('panel.memory.save')}
          </button>
        </div>
      ) : (
        <div className="text-xs text-text-secondary leading-relaxed whitespace-pre-wrap">
          {profile.synthesis || t('panel.memory.no_synthesis')}
        </div>
      )}
    </div>
  )
}
