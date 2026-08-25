/* ============================================================
 * ArkWork — 上下文占比侧边栏（Task 6）
 * 以预算占比为核心，按 7 分类下钻查看并管理当前任务上下文。
 *  - 顶部：总占比 + 余量提示 + 进度条
 *  - 中部：每个分类一行（百分比进度条 + 名称 + 下钻 / 清空）
 *  - 展开：明细项（标签 / token / 移除按钮），单条不可移除时隐藏按钮
 *  - 底部：L1/L2 记忆层级说明（L2 待 Task 7 接入后展示）
 * ============================================================ */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../../icons'
import { useStore } from '../../store'
import type {
  ContextBreakdownItem,
  ContextBreakdownResult,
  ContextCategory,
  ContextDetail,
} from '@shared/types/ipc'

/** 分类展示色（与 Tailwind 主题解耦，固定语义色，便于深浅色一致） */
const CATEGORY_COLORS: Record<ContextCategory, string> = {
  system: '#8b5cf6',
  files: '#3b82f6',
  tools: '#f59e0b',
  messages: '#10b981',
  mcp: '#06b6d4',
  skills: '#ec4899',
  other: '#64748b',
}

/** 支持「整类清空」的分类：files / messages / tools / mcp / skills */
const CLEARABLE: ReadonlySet<ContextCategory> = new Set<ContextCategory>([
  'files',
  'messages',
  'tools',
  'mcp',
  'skills',
])

/** 分类的展示图标（与项目现有 Icon 集对齐） */
const CATEGORY_ICON: Record<ContextCategory, keyof typeof Icon> = {
  system: 'Brain',
  files: 'File',
  tools: 'Bolt',
  messages: 'List',
  mcp: 'Plug',
  skills: 'Eye',
  other: 'Box',
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return '0'
  // 保留 1 位小数，整数则不显示小数
  return value % 1 === 0 ? value.toFixed(0) : value.toFixed(1)
}

/** 明细类型的友好展示名（替代原始英文大写，与 UI 语言一致） */
const DETAIL_TYPE_KEYS: Record<string, string> = {
  'system-prompt': 'system_prompt',
  'system-section': 'system_section',
  file: 'file',
  tool: 'tool',
  'sub-agent': 'sub_agent',
  'skill-instruction': 'skill_instruction',
  message: 'message',
  'memory-injection': 'memory_injection',
  mcp: 'mcp',
}

function typeLabel(t: (key: string) => string, type: string): string {
  const key = DETAIL_TYPE_KEYS[type]
  return key ? t(`dock.context.detail.${key}`) : type
}

function PanelMessage({ icon, title, hint }: { icon?: React.ReactNode; title: string; hint?: string }) {
  const { t } = useTranslation()
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 flex-shrink-0 items-center border-b border-border-subtle px-3">
        <span className="text-sm font-medium text-text-primary">{t('dock.context.title')}</span>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-text-tertiary">
        {icon}
        <div className="text-xs">{title}</div>
        {hint && <div className="text-2xs">{hint}</div>}
      </div>
    </div>
  )
}

export function ContextPanel() {
  const { t } = useTranslation()
  const selectedTaskId = useStore((s) => s.selectedTaskId)
  const refreshMemory = useStore((s) => s.refreshMemory)
  const refreshContextSize = useStore((s) => s.refreshContextSize)
  const openModulePage = useStore((s) => s.openModulePage)
  const [breakdown, setBreakdown] = useState<ContextBreakdownResult | null>(null)
  const [expanded, setExpanded] = useState<Set<ContextCategory>>(new Set())
  const [loading, setLoading] = useState(false)
  const [busyKey, setBusyKey] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!selectedTaskId) {
      setBreakdown(null)
      return
    }
    setLoading(true)
    try {
      const result = await window.ark.context.getBreakdown(selectedTaskId)
      setBreakdown(result)
    } finally {
      setLoading(false)
    }
  }, [selectedTaskId])

  useEffect(() => {
    setExpanded(new Set())
    void load()
  }, [load])

  useEffect(() => {
    const off = window.ark.memory.onChanged((taskId) => {
      if (taskId === selectedTaskId) void load()
    })
    return off
  }, [load, selectedTaskId])

  const refreshAll = useCallback(async () => {
    if (!selectedTaskId) return
    await Promise.all([load(), refreshMemory(selectedTaskId), refreshContextSize(selectedTaskId)])
  }, [load, refreshContextSize, refreshMemory, selectedTaskId])

  const removeItem = async (item: ContextBreakdownItem, detail: ContextDetail) => {
    if (!selectedTaskId) return
    const key = `${item.category}:${detail.id}`
    setBusyKey(key)
    try {
      if (await window.ark.context.removeItem(selectedTaskId, item.category, detail.id)) {
        await refreshAll()
      }
    } finally {
      setBusyKey(null)
    }
  }

  const clearCategory = async (item: ContextBreakdownItem) => {
    if (!selectedTaskId || item.details.length === 0) return
    setBusyKey(`clear:${item.category}`)
    try {
      if (await window.ark.context.clearCategory(selectedTaskId, item.category)) {
        await refreshAll()
      }
    } finally {
      setBusyKey(null)
    }
  }

  const toggleExpanded = (category: ContextCategory) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(category)) next.delete(category)
      else next.add(category)
      return next
    })
  }

  if (!selectedTaskId) {
    return <PanelMessage icon={<Icon.Box width={22} height={22} />} title={t('dock.context.empty_select_title')} hint={t('dock.context.empty_select_hint')} />
  }

  if (loading && !breakdown) {
    return <PanelMessage title={t('dock.context.loading')} />
  }

  if (!breakdown) {
    return <PanelMessage icon={<Icon.Box width={22} height={22} />} title={t('dock.context.load_failed')} />
  }

  const overall = Math.min(100, breakdown.overallPercentage)
  const remainingPct = Math.max(0, 100 - breakdown.overallPercentage)
  const overallTone = overall >= 90 ? 'bg-danger' : overall >= 75 ? 'bg-warning' : 'bg-accent'

  return (
    <div className="flex h-full flex-col bg-bg-base">
      {/* 头部：标题 + 总 token 数 */}
      <div className="flex h-9 flex-shrink-0 items-center border-b border-border-subtle px-3">
        <span className="text-sm font-medium text-text-primary">{t('dock.context.title')}</span>
        <span className="ml-auto text-2xs tabular text-text-tertiary">
          {breakdown.totalTokens.toLocaleString()} tokens
        </span>
      </div>

      {/* 总占比区：标题 / 百分比 / 余量 / 进度条 */}
      <div className="flex-shrink-0 border-b border-border-subtle px-3 py-3">
        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0">
            <div className="text-2xs text-text-tertiary">{t('dock.context.workspace_overall')}</div>
            <div className="mt-0.5 flex items-baseline gap-1">
              <span className="font-mono text-xl font-semibold tabular text-text-primary">
                {formatPercent(breakdown.overallPercentage)}%
              </span>
              <span className="text-2xs text-text-tertiary">/ 100%</span>
            </div>
          </div>
          <div className="pb-0.5 text-right text-2xs leading-relaxed text-text-tertiary">
            <div>{t('dock.context.remaining', { pct: formatPercent(remainingPct) })}</div>
            <div className="font-mono tabular">{breakdown.remainingTokens.toLocaleString()} tokens</div>
          </div>
        </div>
        <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-bg-surface ring-1 ring-border-subtle">
          <div
            className={`h-full rounded-full transition-[width] duration-500 ${overallTone}`}
            style={{ width: `${overall}%` }}
          />
        </div>
        <div className="mt-1.5 flex justify-between text-2xs text-text-tertiary">
          <span>{t('dock.context.used', { count: breakdown.totalTokens.toLocaleString() })}</span>
          <span>{t('dock.context.budget', { count: breakdown.maxTokens.toLocaleString() })}</span>
        </div>
      </div>

      {/* 分类列表（可下钻） */}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        <div className="space-y-1">
          {breakdown.items.map((item) => {
            const isOpen = expanded.has(item.category)
            const color = CATEGORY_COLORS[item.category]
            const canClear = CLEARABLE.has(item.category) && item.details.length > 0
            const widthPct = Math.max(0, Math.min(100, item.percentage))
            const IconComp = Icon[CATEGORY_ICON[item.category]]
            return (
              <section
                key={item.category}
                className="overflow-hidden rounded-lg border border-border-subtle bg-bg-surface"
              >
                {/* 分类头部：可点击下钻 */}
                <div className="flex items-start gap-1.5 px-2 py-2">
                  <button
                    type="button"
                    onClick={() => toggleExpanded(item.category)}
                    className="flex min-w-0 flex-1 items-start gap-2 rounded text-left transition-colors hover:bg-bg-hover"
                    aria-expanded={isOpen}
                  >
                    <span
                      className={`mt-0.5 inline-block text-text-tertiary transition-transform duration-200 ${
                        isOpen ? 'rotate-90' : ''
                      }`}
                      aria-hidden="true"
                    >
                      ›
                    </span>
                    <span className="mt-0.5 flex-shrink-0 text-text-tertiary">
                      <IconComp width={14} height={14} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-xs font-medium text-text-secondary">
                          {item.label}
                        </span>
                        <span className="flex-shrink-0 font-mono text-xs font-semibold tabular text-text-primary">
                          {formatPercent(item.percentage)}%
                        </span>
                      </div>
                      {/* 分类进度条（点击行为：切换下钻） */}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          toggleExpanded(item.category)
                        }}
                        className="mt-1.5 block w-full"
                        aria-label={t('dock.context.category_aria', { label: item.label, pct: formatPercent(item.percentage) })}
                      >
                        <div className="h-1.5 overflow-hidden rounded-full bg-bg-base">
                          <div
                            className="h-full rounded-full transition-[width] duration-500"
                            style={{ width: `${widthPct}%`, backgroundColor: color }}
                          />
                        </div>
                      </button>
                      <div className="mt-1 flex justify-between text-2xs tabular text-text-tertiary">
                        <span>{t('dock.context.count_items', { count: item.details.length })}</span>
                        <span>{item.tokenCount.toLocaleString()} tokens</span>
                      </div>
                    </div>
                  </button>
                  {canClear && (
                    <button
                      type="button"
                      disabled={busyKey !== null}
                      onClick={() => void clearCategory(item)}
                      className="mt-0.5 flex-shrink-0 rounded px-1.5 py-0.5 text-2xs text-text-tertiary transition-colors hover:bg-danger-soft hover:text-danger disabled:opacity-40"
                    >
                      {busyKey === `clear:${item.category}` ? t('dock.context.clearing') : t('dock.context.clear')}
                    </button>
                  )}
                </div>

                {/* 下钻明细：带高度过渡 */}
                <div
                  className={`grid transition-[grid-template-rows] duration-200 ease-out ${
                    isOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
                  }`}
                >
                  <div className="overflow-hidden">
                    {item.details.length === 0 ? (
                      <div className="border-t border-border-subtle px-3 py-2 text-2xs text-text-tertiary">
                        {t('dock.context.category_empty')}
                      </div>
                    ) : (
                      <ul className="border-t border-border-subtle">
                        {item.details.map((detail) => {
                          const detailKey = `${item.category}:${detail.id}`
                          const isBusy = busyKey === detailKey
                          return (
                            <li
                              key={detailKey}
                              className="flex items-start gap-2 border-b border-border-subtle px-3 py-1.5 last:border-b-0"
                            >
                              <span
                                className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full"
                                style={{ backgroundColor: color }}
                                aria-hidden="true"
                              />
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-2xs text-text-secondary" title={detail.label}>
                                  {detail.label}
                                </div>
                                <div className="mt-0.5 flex items-center gap-1.5 text-2xs text-text-tertiary">
                                  <span className="font-mono tabular">{detail.tokenCount.toLocaleString()} tokens</span>
                                  <span>·</span>
                                  <span className="tracking-wide">{typeLabel(t, detail.type)}</span>
                                </div>
                              </div>
                              {detail.removable && (
                                <button
                                  type="button"
                                  disabled={busyKey !== null}
                                  onClick={() => void removeItem(item, detail)}
                                  className="flex-shrink-0 rounded px-1.5 py-0.5 text-2xs text-text-tertiary transition-colors hover:bg-danger-soft hover:text-danger disabled:opacity-40"
                                  title={t('dock.context.remove_tooltip')}
                                >
                                  {isBusy ? '…' : t('dock.context.remove')}
                                </button>
                              )}
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </div>
                </div>
              </section>
            )
          })}
        </div>
      </div>

      {/* L1 / L2 层级说明（Task 7 接入 L2 后，此处会展示 L2 压缩记忆统计） */}
      <div className="flex-shrink-0 border-t border-border-subtle bg-bg-surface px-3 py-2 text-2xs leading-relaxed text-text-tertiary">
        <div className="flex items-center gap-1.5">
          <Icon.Brain width={12} height={12} />
          <span className="font-medium text-text-secondary">{t('dock.context.memory_tier')}</span>
          <button
            type="button"
            onClick={() => openModulePage('memory')}
            className="ml-auto text-accent hover:underline"
          >
            {t('dock.context.memory_center')}
          </button>
        </div>
        <ul className="mt-1 space-y-0.5 tabular">
          <li>
            <span className="text-text-secondary">{t('dock.context.l1_working_memory')}</span>
            <span className="ml-1">{t('dock.context.l1_desc')}</span>
          </li>
          <li>
            <span className="text-text-secondary">{t('dock.context.l2_compressed_memory')}</span>
            <span className="ml-1">{t('dock.context.l2_desc')}</span>
          </li>
        </ul>
      </div>
    </div>
  )
}
