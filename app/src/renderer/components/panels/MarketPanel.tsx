/* ============================================================
 * ArkWork — MarketPanel (v0.8.0 F820)
 * Skill 市场面板：搜索 SkillHub / 安装技能 / CLI 引导
 * - 顶部搜索框（300ms 防抖）
 * - CLI 未安装时展示「一键安装 skillhub」引导卡片
 * - 结果列表：名称 / 描述 / 下载量 / 安装按钮（已安装置灰）
 * ============================================================ */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../icons'
import { useStore } from '../../store'
import { Tooltip, EmptyState } from '../ui'
import { useTranslation } from 'react-i18next'
import type { MarketSearchResult } from '@shared/types/ipc'

export function MarketPanel() {
  const { t } = useTranslation()
  const marketSkills = useStore((s) => s.marketSkills)
  const marketLoading = useStore((s) => s.marketLoading)
  const marketTotal = useStore((s) => s.marketTotal)
  const marketPage = useStore((s) => s.marketPage)
  const marketPageSize = useStore((s) => s.marketPageSize)
  const marketHasMore = useStore((s) => s.marketHasMore)
  const marketCli = useStore((s) => s.marketCli)
  const skills = useStore((s) => s.skills)
  const searchMarket = useStore((s) => s.searchMarket)
  const installMarketSkill = useStore((s) => s.installMarketSkill)
  const checkMarketCli = useStore((s) => s.checkMarketCli)
  const installMarketCli = useStore((s) => s.installMarketCli)

  const [query, setQuery] = useState('')
  const [installing, setInstalling] = useState<Record<string, boolean>>({})
  const [cliInstalling, setCliInstalling] = useState(false)
  const firstRun = useRef(true)

  // 挂载：检查 CLI + 加载初始结果
  useEffect(() => {
    void checkMarketCli()
    void searchMarket()
  }, [checkMarketCli, searchMarket])

  // 搜索防抖 300ms（跳过首次挂载，避免与初始加载重复）
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false
      return
    }
    const t = setTimeout(() => {
      void searchMarket(query)
    }, 300)
    return () => clearTimeout(t)
  }, [query, searchMarket])

  // 已安装技能名集合（按名称比对，叠加服务端 installed 标记）
  const installedNames = useMemo(
    () => new Set(skills.map((s) => s.name)),
    [skills],
  )

  // v0.8.0：分页信息
  const totalPages = marketTotal > 0 ? Math.max(1, Math.ceil(marketTotal / marketPageSize)) : 1
  const canPrev = marketPage > 1
  const canNext = marketHasMore || marketPage < totalPages

  const goToPage = (page: number) => {
    if (page < 1 || page > totalPages || page === marketPage) return
    // 沿用当前搜索条件翻页
    const q = query
    void searchMarket(q, [], page)
  }

  const handleInstall = async (id: string) => {
    setInstalling((m) => ({ ...m, [id]: true }))
    try {
      await installMarketSkill(id)
    } finally {
      setInstalling((m) => ({ ...m, [id]: false }))
    }
  }

  const handleInstallCli = async () => {
    setCliInstalling(true)
    try {
      await installMarketCli()
    } finally {
      setCliInstalling(false)
    }
  }

  const showCliCard = !!marketCli && !marketCli.installed

  return (
    <div className="flex flex-col h-full">
      {/* 头部 */}
      <div className="flex items-center gap-2 px-3 h-9 flex-shrink-0 border-b border-border-subtle">
        <span className="text-sm text-text-primary font-medium">{t('panel.market.title')}</span>
        {marketTotal > 0 && (
          <span className="text-2xs text-text-tertiary tabular">{marketTotal}</span>
        )}
      </div>

      {/* 搜索框 */}
      <div className="px-2.5 py-2 flex-shrink-0">
        <div className="flex items-center gap-2 px-3 h-8 rounded-lg bg-bg-surface border border-border-subtle focus-within:border-accent transition-colors">
          <Icon.Search width={16} height={16} className="text-text-tertiary flex-shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('panel.market.searchPlaceholder')}
            className="flex-1 min-w-0 bg-transparent text-xs text-text-primary placeholder:text-text-tertiary outline-none"
          />
          {marketLoading && (
            <span className="text-2xs text-text-tertiary flex-shrink-0">{t('panel.market.searching')}</span>
          )}
        </div>
      </div>

      {/* CLI 引导卡片：未检测到 skillhub CLI 时展示 */}
      {showCliCard && (
        <div className="mx-2.5 mb-2 flex-shrink-0 p-3 rounded-lg bg-bg-surface border border-border-subtle flex items-start gap-2.5">
          <Icon.Terminal width={16} height={16} className="text-text-tertiary mt-0.5 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-xs text-text-primary font-medium">{t('panel.market.cliTitle')}</div>
            <div className="text-2xs text-text-tertiary mt-0.5">
              {t('panel.market.cliHint')}
            </div>
            <button
              onClick={() => void handleInstallCli()}
              disabled={cliInstalling}
              className="mt-2 inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium text-text-inverse bg-accent hover:bg-accent-hover disabled:opacity-60 transition-colors"
            >
              <Icon.Download width={16} height={16} />
              {cliInstalling ? t('panel.market.installing') : t('panel.market.cliInstall')}
            </button>
          </div>
        </div>
      )}

      {/* 结果列表 */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {marketLoading && marketSkills.length === 0 ? (
          <EmptyState
            icon={<Icon.Box width={22} height={22} />}
            title={t('panel.market.loading')}
            hint={t('panel.market.loadingHint')}
          />
        ) : !marketLoading && marketSkills.length === 0 ? (
          <EmptyState
            icon={<Icon.Search width={22} height={22} />}
            title={t('panel.market.noResultsTitle')}
            hint={query.trim() ? t('panel.market.noResultsQuery', { query: query.trim() }) : t('panel.market.noResultsEmpty')}
          />
        ) : (
          <div className="space-y-2 pt-1">
            {marketLoading && (
              <div className="text-center text-2xs text-text-tertiary py-1">{t('panel.market.loading')}</div>
            )}
            {marketSkills.map((item) => (
              <MarketSkillRow
                key={item.id}
                item={item}
                isInstalled={item.installed || installedNames.has(item.name)}
                installing={!!installing[item.id]}
                onInstall={() => void handleInstall(item.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* v0.8.0：分页栏 */}
      {marketTotal > 0 && (
        <div className="flex items-center gap-2 px-3 h-9 flex-shrink-0 border-t border-border-subtle text-2xs text-text-tertiary tabular">
          <span>{t('panel.market.total', { count: marketTotal.toLocaleString() })}</span>
          <div className="ml-auto flex items-center gap-1">
<Tooltip label={t('panel.market.prevTooltip')}>
            <button
              onClick={() => goToPage(marketPage - 1)}
              disabled={!canPrev || marketLoading}

              className="w-6 h-6 flex items-center justify-center rounded-md text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <Icon.ChevronLeft width={16} height={16} />
            </button>
</Tooltip>
            <span className="min-w-[60px] text-center">
              {marketPage} / {totalPages}
            </span>
<Tooltip label={t('panel.market.nextTooltip')}>
            <button
              onClick={() => goToPage(marketPage + 1)}
              disabled={!canNext || marketLoading}

              className="w-6 h-6 flex items-center justify-center rounded-md text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <Icon.ChevronRight width={16} height={16} />
            </button>
</Tooltip>
          </div>
        </div>
      )}
    </div>
  )
}

/* ============================================================
 * MarketSkillRow — 市场技能条目
 * ============================================================ */
function MarketSkillRow({
  item,
  isInstalled,
  installing,
  onInstall,
}: {
  item: MarketSearchResult
  isInstalled: boolean
  installing: boolean
  onInstall: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex items-start gap-2.5 p-2.5 rounded-lg bg-bg-surface border border-border-subtle hover:border-border-default transition-colors">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm text-text-primary truncate">{item.name}</span>
          {item.source && (
            <span className="text-2xs px-1.5 py-0.5 rounded bg-bg-hover text-text-tertiary uppercase flex-shrink-0">
              {item.source}
            </span>
          )}
        </div>
        <div className="text-xs text-text-tertiary line-clamp-2 mt-0.5">
          {item.description || t('panel.market.noDescription')}
        </div>
        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
          {typeof item.downloads === 'number' && (
            <span className="flex items-center gap-1 text-2xs text-text-tertiary tabular">
              <Icon.Download width={16} height={16} />
              {formatCount(item.downloads)}
            </span>
          )}
          {item.tags?.slice(0, 3).map((t) => (
            <span
              key={t}
              className="text-2xs px-1.5 py-0.5 rounded bg-bg-hover text-text-tertiary"
            >
              {t}
            </span>
          ))}
        </div>
      </div>
      <div className="flex-shrink-0">
        {isInstalled ? (
          <span className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md text-xs text-text-tertiary bg-bg-hover">
            <Icon.Check width={16} height={16} />
            {t('panel.market.installed')}
          </span>
        ) : (
          <button
            onClick={onInstall}
            disabled={installing}
            className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md text-xs font-medium text-text-inverse bg-accent hover:bg-accent-hover disabled:opacity-60 transition-colors"
          >
            <Icon.Download width={16} height={16} />
            {installing ? t('panel.market.installing') : t('panel.market.install')}
          </button>
        )}
      </div>
    </div>
  )
}

/* ============================================================
 * formatCount — 下载量简化展示（1.2k）
 * ============================================================ */
function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return String(n)
}
