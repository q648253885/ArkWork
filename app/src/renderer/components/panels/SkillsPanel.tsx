/* ============================================================
 * ArkWork — SkillsPanel
 * polish2-workspace-name-task-title-skills-warning §Task 3：两区组织
 *   - 「已有技能」：内置 / 市场导入 / 本地导入 三组子标区分
 *   - 「市场」：浏览 / 安装入口
 * 单一列表内部按 source 分组小标题。
 * v0.27.1：市场 Tab 仅渲染可安装条目（installed 标记或与本地重名的一律过滤）。
 * v0.15.0：市场区升级为四标签页（发现 / 已安装 / 收藏 / 设置）+ 详情弹窗
 * ============================================================ */
import { useState, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Icon } from '../../icons'
import { useStore } from '../../store'
import { Tooltip, EmptyState } from '../ui'
import type { Skill } from '../../types'
import type { MarketplaceSource } from '@shared/types/ipc'
import { filterInstallableMarketItems } from '../../utils/market-filter'

/** polish2 §Task 3.1：两区(已有技能 / 市场) */
type SkillGroup = 'installed' | 'market'

/** 已有技能区下三种子组 */
type InstalledSubGroup = 'builtin' | 'market-installed' | 'local-installed'

/** 真正的 skill 来源 → 已有技能子组 */
function classifyInstalled(s: Skill): InstalledSubGroup {
  if (s.source === 'builtin') return 'builtin'
  if (s.source === 'market') return 'market-installed'
  return 'local-installed'
}

/** 子组展示元信息 */
function makeInstalledMeta(t: TFunction): Record<InstalledSubGroup, { label: string; hint: string; badgeCls: string; icon: React.ReactNode }> {
  return {
    builtin: {
      label: t('panel.skills.source.builtin'),
      hint: t('panel.skills.hint.builtin'),
      badgeCls: 'bg-accent-soft text-accent',
      icon: <Icon.Lock width={12} height={12} />,
    },
    'market-installed': {
      label: t('panel.skills.source.marketImported'),
      hint: t('panel.skills.hint.marketImported'),
      badgeCls: 'bg-warning-soft text-warning',
      icon: <Icon.Bolt width={12} height={12} />,
    },
    'local-installed': {
      label: t('panel.skills.source.localImported'),
      hint: t('panel.skills.hint.localImported'),
      badgeCls: 'bg-success-soft text-success',
      icon: <Icon.Upload width={12} height={12} />,
    },
  }
}

function makeGroupMeta(t: TFunction): Record<SkillGroup, { label: string; hint: string; icon: React.ReactNode }> {
  return {
    installed: {
      label: t('panel.skills.group.installed'),
      hint: t('panel.skills.group.installedHint'),
      icon: <Icon.List width={12} height={12} />,
    },
    market: {
      label: t('panel.skills.group.market'),
      hint: t('panel.skills.group.marketHint'),
      icon: <Icon.Bolt width={12} height={12} />,
    },
  }
}

export function SkillsPanel() {
  const { t } = useTranslation()
  const skills = useStore((s) => s.skills)
  const openSkillEditor = useStore((s) => s.openSkillEditor)
  const removeSkill = useStore((s) => s.removeSkill)
  const toggleSkillEnabled = useStore((s) => s.toggleSkillEnabled)
  const exportSkill = useStore((s) => s.exportSkill)
  const importSkill = useStore((s) => s.importSkill)
  const marketSkills = useStore((s) => s.marketSkills)
  const marketLoading = useStore((s) => s.marketLoading)
  const searchMarket = useStore((s) => s.searchMarket)
  const [filter, setFilter] = useState('')
  const [activeGroup, setActiveGroup] = useState<SkillGroup>('installed')

  // polish2 §Task 3：市场 Tab 数据预加载（独立 MarketPanel 已下线，本页是唯一市场入口）。
  useEffect(() => {
    if (marketSkills.length === 0 && !marketLoading) void searchMarket()
  }, [marketSkills.length, marketLoading, searchMarket])

  // polish2 §Task 3.3：已有技能按子组分组
  const installedGroups = useMemo(() => {
    const acc: Record<InstalledSubGroup, Skill[]> = {
      builtin: [],
      'market-installed': [],
      'local-installed': [],
    }
    for (const s of skills) acc[classifyInstalled(s)].push(s)
    return acc
  }, [skills])

  // v0.27.1：市场 Tab 计数只统计可安装条目（过滤 installed 标记 + 本地重名）
  const localSkillNames = useMemo(() => new Set(skills.map((s) => s.name)), [skills])
  const marketInstallable = useMemo(
    () => filterInstallableMarketItems(marketSkills, localSkillNames),
    [marketSkills, localSkillNames],
  )

  const groupMeta = useMemo(() => makeGroupMeta(t), [t])
  const installedMeta = useMemo(() => makeInstalledMeta(t), [t])

  const counts: Record<SkillGroup, number> = {
    installed: skills.length,
    market: marketInstallable.length,
  }

  const filterMatch = (s: Skill) =>
    !filter.trim() ||
    s.name.toLowerCase().includes(filter.toLowerCase()) ||
    (s.description || '').toLowerCase().includes(filter.toLowerCase())

  return (
    <div className="p-3 flex flex-col h-full">
      {/* 操作栏：按钮独占一行（避免与搜索框挤压导致按钮文字折叠） */}
      <div className="flex items-center gap-1.5 mb-2 flex-shrink-0">
        <button
          onClick={() => openSkillEditor(null)}
          className="flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium text-text-inverse bg-accent hover:bg-accent-hover transition-colors flex-shrink-0"
        >
          <Icon.Plus width={16} height={16} />
          {t('panel.skills.newSkill')}
        </button>
        <Tooltip label={t('panel.skills.importTooltip')}>
          <button
            onClick={() => void importSkill()}
            className="flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs text-text-secondary border border-border-default hover:bg-bg-hover hover:text-text-primary transition-colors flex-shrink-0"
          >
            <Icon.Upload width={16} height={16} />
            {t('panel.skills.import')}
          </button>
        </Tooltip>
        <span className="ml-auto text-2xs text-text-tertiary tabular flex-shrink-0">
          {t('panel.skills.count', { count: skills.length })}
        </span>
      </div>
      {/* 搜索框独占一行 */}
      <div className="mb-2 flex-shrink-0">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t('panel.skills.searchPlaceholder')}
          className="w-full h-7 px-2 text-xs bg-bg-input border border-border-subtle rounded-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent transition-colors"
        />
      </div>

      {/* polish2 §Task 3.2：两 Tab — 已有技能 / 市场 */}
      <div
        className="mb-2 flex-shrink-0 flex items-center gap-1 border-b border-border-subtle"
        data-testid="skills-three-groups"
      >
        {(Object.keys(groupMeta) as SkillGroup[]).map((g) => {
          const meta = groupMeta[g]
          const active = g === activeGroup
          return (
            <button
              key={g}
              onClick={() => setActiveGroup(g)}
              data-group={meta.label}
              className={`flex items-center gap-1 px-2 h-7 text-xs transition-colors border-b-2 -mb-px ${
                active
                  ? 'border-accent text-text-primary'
                  : 'border-transparent text-text-tertiary hover:text-text-secondary'
              }`}
            >
              {meta.icon}
              <span>{meta.label}</span>
              <span className="tabular text-2xs text-text-tertiary">{counts[g]}</span>
            </button>
          )
        })}
      </div>

      {activeGroup === 'market' ? (
        <MarketHub />
      ) : skills.length === 0 ? (
        <EmptyState
          icon={<Icon.Box width={22} height={22} />}
          title={t('panel.skills.empty.title')}
          hint={t('panel.skills.empty.hint')}
        />
      ) : (
        <div className="space-y-4 overflow-y-auto flex-1" data-testid="skills-installed-list">
          {(Object.keys(installedMeta) as InstalledSubGroup[]).map((sub) => {
            const meta = installedMeta[sub]
            const items = installedGroups[sub].filter(filterMatch)
            if (items.length === 0) return null
            return (
              <div key={sub} data-installed-subgroup={sub}>
                <div className="flex items-center gap-2 mb-1.5">
                  <span
                    className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-2xs ${meta.badgeCls}`}
                  >
                    {meta.icon}
                    {meta.label}
                  </span>
                  <span className="text-2xs text-text-tertiary tabular">{items.length}</span>
                  <span className="text-2xs text-text-tertiary">· {meta.hint}</span>
                </div>
                <div className="space-y-2">
                  {items.map((s) => (
                    <SkillRow
                      key={s.id}
                      skill={s}
                      subgroup={sub}
                      onEdit={() => openSkillEditor(s)}
                      onDelete={() => void removeSkill(s.id)}
                      onToggle={(enabled) => void toggleSkillEnabled(s.id, enabled)}
                      onExport={() => void exportSkill(s.id)}
                    />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/* ============================================================
 * v0.15.0：市场中心 — 四标签页（发现 / 已安装 / 收藏 / 设置）
 * ============================================================ */
type MarketTab = 'discover' | 'installed' | 'favorites' | 'settings'

function makeMarketTabs(t: TFunction): { id: MarketTab; label: string; icon: React.ReactNode }[] {
  return [
    { id: 'discover', label: t('panel.skills.market.tab.discover'), icon: <Icon.Search width={14} height={14} /> },
    { id: 'installed', label: t('panel.skills.market.tab.installed'), icon: <Icon.Box width={14} height={14} /> },
    { id: 'favorites', label: t('panel.skills.market.tab.favorites'), icon: <Icon.Star width={14} height={14} /> },
    { id: 'settings', label: t('panel.skills.market.tab.settings'), icon: <Icon.Settings width={14} height={14} /> },
  ]
}

function MarketHub() {
  const { t } = useTranslation()
  const [tab, setTab] = useState<MarketTab>('discover')
  const tabs = useMemo(() => makeMarketTabs(t), [t])

  return (
    <div className="flex flex-col flex-1 min-h-0" data-testid="market-hub">
      {/* 四标签页切换（复用顶层 Tab 的 border-b-2 风格） */}
      <div className="flex items-center gap-1 border-b border-border-subtle flex-shrink-0">
        {tabs.map((tb) => {
          const active = tb.id === tab
          return (
            <button
              key={tb.id}
              onClick={() => setTab(tb.id)}
              data-market-tab={tb.id}
              className={`flex items-center gap-1 px-2 h-7 text-xs transition-colors border-b-2 -mb-px ${
                active
                  ? 'border-accent text-text-primary'
                  : 'border-transparent text-text-tertiary hover:text-text-secondary'
              }`}
            >
              {tb.icon}
              <span>{tb.label}</span>
            </button>
          )
        })}
      </div>

      {/* 标签页内容 */}
      <div className="flex-1 min-h-0 flex flex-col pt-2">
        {tab === 'discover' && <DiscoverTab />}
        {tab === 'installed' && <InstalledTab />}
        {tab === 'favorites' && <FavoritesTab />}
        {tab === 'settings' && <SettingsTab />}
      </div>

      <MarketDetailModal />
    </div>
  )
}

/* ============================================================
 * 发现 — 搜索（300ms 防抖）+ 结果列表 + 分页
 * ============================================================ */
function DiscoverTab() {
  const { t } = useTranslation()
  const marketSkills = useStore((s) => s.marketSkills)
  const marketLoading = useStore((s) => s.marketLoading)
  const marketTotal = useStore((s) => s.marketTotal)
  const marketPage = useStore((s) => s.marketPage)
  const marketPageSize = useStore((s) => s.marketPageSize)
  const marketHasMore = useStore((s) => s.marketHasMore)
  const marketQuery = useStore((s) => s.marketQuery)
  const skills = useStore((s) => s.skills)
  const searchMarket = useStore((s) => s.searchMarket)
  const installMarketSkill = useStore((s) => s.installMarketSkill)
  const openMarketDetail = useStore((s) => s.openMarketDetail)

  const [query, setQuery] = useState(marketQuery)
  const [installing, setInstalling] = useState<Record<string, boolean>>({})
  const firstRun = useRef(true)

  // 搜索防抖 300ms（跳过首次挂载，避免与顶部预加载重复）
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false
      return
    }
    const timer = setTimeout(() => {
      void searchMarket(query)
    }, 300)
    return () => clearTimeout(timer)
  }, [query, searchMarket])

  // 已安装技能名集合（叠加服务端 installed 标记）
  const installedNames = useMemo(() => new Set(skills.map((s) => s.name)), [skills])

  // v0.27.1：市场 Tab 仅渲染可安装条目——服务端 installed 标记或与本地重名的一律隐藏
  const installableItems = useMemo(
    () => filterInstallableMarketItems(marketSkills, installedNames),
    [marketSkills, installedNames],
  )

  const totalPages = marketTotal > 0 ? Math.max(1, Math.ceil(marketTotal / marketPageSize)) : 1
  const canPrev = marketPage > 1
  const canNext = marketHasMore || marketPage < totalPages

  const goToPage = (page: number) => {
    if (page < 1 || page > totalPages || page === marketPage) return
    // 沿用已提交的搜索条件翻页
    void searchMarket(marketQuery, [], page)
  }

  const handleInstall = async (id: string) => {
    setInstalling((m) => ({ ...m, [id]: true }))
    try {
      await installMarketSkill(id)
    } finally {
      setInstalling((m) => ({ ...m, [id]: false }))
    }
  }

  return (
    <div className="flex flex-col flex-1 min-h-0" data-testid="skills-market-list">
      {/* 搜索框 */}
      <div className="flex-shrink-0 mb-2">
        <div className="flex items-center gap-2 px-3 h-8 rounded-lg bg-bg-input border border-border-subtle focus-within:border-accent transition-colors">
          <Icon.Search width={15} height={15} className="text-text-tertiary flex-shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('panel.skills.market.searchPlaceholder')}
            className="flex-1 min-w-0 bg-transparent text-xs text-text-primary placeholder:text-text-tertiary outline-none"
          />
          {marketLoading && (
            <span className="text-2xs text-text-tertiary flex-shrink-0">{t('panel.skills.searching')}</span>
          )}
        </div>
      </div>

      {/* 结果列表 */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {marketLoading && marketSkills.length === 0 ? (
          <EmptyState
            icon={<Icon.Box width={22} height={22} />}
            title={t('panel.skills.loading')}
            hint={t('panel.skills.market.loadingHint')}
          />
        ) : marketSkills.length === 0 ? (
          <EmptyState
            icon={<Icon.Search width={22} height={22} />}
            title={t('panel.skills.market.noResults.title')}
            hint={query.trim() ? t('panel.skills.market.noResults.hint', { query: query.trim() }) : t('panel.skills.market.noResults.hintEmpty')}
          />
        ) : installableItems.length === 0 ? (
          <EmptyState
            icon={<Icon.Check width={22} height={22} />}
            title={t('panel.skills.market.noInstallable.title')}
            hint={
              query.trim()
                ? t('panel.skills.market.noInstallable.hint', { query: query.trim() })
                : t('panel.skills.market.noInstallable.hintEmpty')
            }
          />
        ) : (
          <div className="space-y-2">
            {marketLoading && (
              <div className="text-center text-2xs text-text-tertiary py-1">{t('panel.skills.loading')}</div>
            )}
            {installableItems.map((item) => {
              return (
                <div
                  key={item.id}
                  data-testid="skills-market-installable"
                  onClick={() => void openMarketDetail(item)}
                  className="rounded-lg bg-bg-surface border border-border-subtle hover:border-border-default transition-colors px-3 py-2 flex items-center gap-2 cursor-pointer"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm text-text-primary truncate">
                        {item.metadata?.displayName || item.name}
                      </span>
                    </div>
                    <div className="text-xs text-text-tertiary truncate">
                      {item.description || t('panel.skills.noDescription')}
                    </div>
                    {typeof item.downloads === 'number' && item.downloads > 0 && (
                      <div className="flex items-center gap-1 mt-0.5 text-2xs text-text-tertiary tabular">
                        <Icon.Download width={13} height={13} />
                        {t('panel.skills.downloads', { count: formatCount(item.downloads) })}
                      </div>
                    )}
                  </div>
                  <button
                    data-testid="skills-market-install-btn"
                    onClick={(e) => {
                      e.stopPropagation()
                      void handleInstall(item.id)
                    }}
                    disabled={!!installing[item.id]}
                    className="flex items-center gap-1 h-7 px-2.5 rounded-md text-xs font-medium text-text-inverse bg-accent hover:bg-accent-hover disabled:opacity-60 transition-colors flex-shrink-0"
                  >
                    <Icon.Download width={14} height={14} />
                    {installing[item.id] ? t('panel.skills.installing') : t('panel.skills.install')}
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 分页栏 */}
      {marketTotal > 0 && (
        <div className="flex items-center gap-2 pt-2 flex-shrink-0 text-2xs text-text-tertiary tabular">
          <span>{t('panel.skills.market.total', { count: marketTotal.toLocaleString() })}</span>
          <div className="ml-auto flex items-center gap-1">
            <Tooltip label={t('panel.skills.prevPage')}>
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
            <Tooltip label={t('panel.skills.nextPage')}>
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
 * 已安装 — 市场安装的技能列表（卸载后 store 自动刷新）
 * ============================================================ */
function InstalledTab() {
  const { t } = useTranslation()
  const marketInstalled = useStore((s) => s.marketInstalled)
  const listInstalledMarket = useStore((s) => s.listInstalledMarket)
  const uninstallMarketSkill = useStore((s) => s.uninstallMarketSkill)
  const [uninstalling, setUninstalling] = useState<Record<string, boolean>>({})

  // 挂载时加载
  useEffect(() => {
    void listInstalledMarket()
  }, [listInstalledMarket])

  const handleUninstall = async (id: string) => {
    setUninstalling((m) => ({ ...m, [id]: true }))
    try {
      await uninstallMarketSkill(id)
    } finally {
      setUninstalling((m) => ({ ...m, [id]: false }))
    }
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      {marketInstalled.length === 0 ? (
        <EmptyState
          icon={<Icon.Box width={22} height={22} />}
          title={t('panel.skills.market.installed.empty.title')}
          hint={t('panel.skills.market.installed.empty.hint')}
        />
      ) : (
        <div className="space-y-2">
          {marketInstalled.map((item) => (
            <div
              key={item.id}
              className="rounded-lg bg-bg-surface border border-border-subtle hover:border-border-default transition-colors px-3 py-2 flex items-center gap-2"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm text-text-primary truncate">
                    {item.metadata?.displayName || item.name}
                  </span>
                  <span className="text-2xs px-1.5 py-0.5 rounded bg-bg-hover text-text-tertiary flex-shrink-0">
                    {item.source === 'builtin' ? t('panel.skills.source.builtin') : t('panel.skills.source.market')}
                  </span>
                </div>
                <div className="text-xs text-text-tertiary truncate">
                  {item.description || t('panel.skills.noDescription')}
                </div>
              </div>
              <button
                onClick={() => void handleUninstall(item.id)}
                disabled={!!uninstalling[item.id]}
                className="flex items-center gap-1 h-7 px-2.5 rounded-md text-xs text-text-secondary border border-border-default hover:bg-bg-hover hover:text-text-primary disabled:opacity-60 transition-colors flex-shrink-0"
              >
                <Icon.Trash width={14} height={14} />
                {uninstalling[item.id] ? t('panel.skills.uninstalling') : t('panel.skills.uninstall')}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* ============================================================
 * 收藏 — 收藏的技能列表（取消收藏后 store 自动刷新）
 * ============================================================ */
function FavoritesTab() {
  const { t } = useTranslation()
  const marketFavorites = useStore((s) => s.marketFavorites)
  const listMarketFavorites = useStore((s) => s.listMarketFavorites)
  const toggleMarketFavorite = useStore((s) => s.toggleMarketFavorite)
  const [toggling, setToggling] = useState<Record<string, boolean>>({})

  // 挂载时加载
  useEffect(() => {
    void listMarketFavorites()
  }, [listMarketFavorites])

  const handleRemove = async (id: string) => {
    setToggling((m) => ({ ...m, [id]: true }))
    try {
      await toggleMarketFavorite(id, false)
    } finally {
      setToggling((m) => ({ ...m, [id]: false }))
    }
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      {marketFavorites.length === 0 ? (
        <EmptyState
          icon={<Icon.Star width={22} height={22} />}
          title={t('panel.skills.market.favorites.empty.title')}
          hint={t('panel.skills.market.favorites.empty.hint')}
        />
      ) : (
        <div className="space-y-2">
          {marketFavorites.map((item) => (
            <div
              key={item.id}
              className="rounded-lg bg-bg-surface border border-border-subtle hover:border-border-default transition-colors px-3 py-2 flex items-center gap-2"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <Icon.Star width={14} height={14} className="text-warning flex-shrink-0" />
                  <span className="text-sm text-text-primary truncate">{item.name}</span>
                </div>
                <div className="text-xs text-text-tertiary truncate">
                  {item.description || t('panel.skills.noDescription')}
                </div>
              </div>
              <button
                onClick={() => void handleRemove(item.id)}
                disabled={!!toggling[item.id]}
                className="flex items-center gap-1 h-7 px-2.5 rounded-md text-xs text-text-secondary border border-border-default hover:bg-bg-hover hover:text-text-primary disabled:opacity-60 transition-colors flex-shrink-0"
              >
                <Icon.Star width={14} height={14} />
                {toggling[item.id] ? t('panel.skills.cancelling') : t('panel.skills.unfavorite')}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* ============================================================
 * 设置 — SkillHub CLI 状态 + 市场源列表（enabled 只读展示）
 * ============================================================ */
const SOURCE_TYPE_CLS: Record<MarketplaceSource['type'], string> = {
  skillhub: 'bg-accent-soft text-accent',
  github: 'bg-bg-hover text-text-secondary',
  local: 'bg-success-soft text-success',
  url: 'bg-warning-soft text-warning',
}

function SettingsTab() {
  const { t } = useTranslation()
  const marketCli = useStore((s) => s.marketCli)
  const checkMarketCli = useStore((s) => s.checkMarketCli)
  const installMarketCli = useStore((s) => s.installMarketCli)
  const marketSources = useStore((s) => s.marketSources)
  const refreshMarketSources = useStore((s) => s.refreshMarketSources)
  const [cliInstalling, setCliInstalling] = useState(false)

  // 挂载时检查 CLI + 加载市场源
  useEffect(() => {
    void checkMarketCli()
    void refreshMarketSources()
  }, [checkMarketCli, refreshMarketSources])

  const handleInstallCli = async () => {
    setCliInstalling(true)
    try {
      await installMarketCli()
    } finally {
      setCliInstalling(false)
    }
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto space-y-3">
      {/* SkillHub CLI 状态卡 */}
      <div className="rounded-lg bg-bg-surface border border-border-subtle p-3 flex items-start gap-2.5">
        <Icon.Terminal width={16} height={16} className="text-text-tertiary mt-0.5 flex-shrink-0" />
        {marketCli?.installed ? (
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-text-primary font-medium">SkillHub CLI</span>
              <span className="text-2xs px-1.5 py-0.5 rounded bg-success-soft text-success">{t('panel.skills.cli.installed')}</span>
            </div>
            <div className="text-2xs text-text-tertiary mt-0.5">
              {marketCli.version ? t('panel.skills.cli.version', { version: marketCli.version }) : t('panel.skills.cli.versionFallback')}
            </div>
          </div>
        ) : (
          <div className="flex-1 min-w-0">
            <div className="text-xs text-text-primary font-medium">{t('panel.skills.cli.notDetected')}</div>
            <div className="text-2xs text-text-tertiary mt-0.5">
              {t('panel.skills.cli.installHint')}
            </div>
            <button
              onClick={() => void handleInstallCli()}
              disabled={cliInstalling}
              className="mt-2 inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium text-text-inverse bg-accent hover:bg-accent-hover disabled:opacity-60 transition-colors"
            >
              <Icon.Download width={15} height={15} />
              {cliInstalling ? t('panel.skills.installing') : t('panel.skills.cli.installButton')}
            </button>
          </div>
        )}
      </div>

      {/* 市场源列表 */}
      <div>
        <div className="text-2xs text-text-tertiary px-1 mb-1.5">{t('panel.skills.market.sourcesCount', { count: marketSources.length })}</div>
        {marketSources.length === 0 ? (
          <EmptyState
            icon={<Icon.Box width={22} height={22} />}
            title={t('panel.skills.market.sources.empty.title')}
            hint={t('panel.skills.market.sources.empty.hint')}
          />
        ) : (
          <div className="space-y-2">
            {marketSources.map((src) => (
              <div
                key={src.id}
                className="rounded-lg bg-bg-surface border border-border-subtle px-3 py-2 flex items-center gap-2"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm text-text-primary truncate">{src.name}</span>
                    <span
                      className={`text-2xs px-1.5 py-0.5 rounded flex-shrink-0 ${SOURCE_TYPE_CLS[src.type]}`}
                    >
                      {t(`panel.skills.source.${src.type}`)}
                    </span>
                  </div>
                  <div className="text-2xs text-text-tertiary truncate font-mono mt-0.5">{src.url}</div>
                </div>
                {/* enabled 静态展示（无对应 IPC，只读） */}
                <span className="flex items-center gap-1.5 flex-shrink-0">
                  <span
                    className={`w-8 h-[18px] rounded-full flex items-center px-[2px] ${
                      src.enabled ? 'bg-accent' : 'bg-bg-active'
                    }`}
                  >
                    <span
                      className={`w-[14px] h-[14px] bg-white rounded-full transition-transform ${
                        src.enabled ? 'translate-x-[14px]' : 'translate-x-0'
                      }`}
                    />
                  </span>
                  <span className="text-2xs text-text-tertiary">
                    {src.enabled ? t('panel.skills.enabled') : t('panel.skills.disabled')}
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/* ============================================================
 * 市场详情弹窗 — SKILL.md 元数据 / Context cost / 兼容性
 * Esc 关闭 / 点击背景关闭（参考 ToolConfirmLayer）
 * ============================================================ */
const OS_LABEL: Record<string, string> = {
  macos: 'macOS',
  linux: 'Linux',
  windows: 'Windows',
}

function MarketDetailModal() {
  const { t } = useTranslation()
  const open = useStore((s) => s.marketDetailOpen)
  const detail = useStore((s) => s.marketDetail)
  const closeMarketDetail = useStore((s) => s.closeMarketDetail)
  const installMarketSkill = useStore((s) => s.installMarketSkill)
  const uninstallMarketSkill = useStore((s) => s.uninstallMarketSkill)
  const toggleMarketFavorite = useStore((s) => s.toggleMarketFavorite)
  const openMarketDetail = useStore((s) => s.openMarketDetail)
  const [busy, setBusy] = useState<'install' | 'uninstall' | 'favorite' | null>(null)

  // Esc 关闭
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeMarketDetail()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, closeMarketDetail])

  if (!open || !detail) return null

  // 操作后重新拉取详情，保持 installed / favorited 状态最新
  const refresh = () => openMarketDetail(detail)

  const handleInstall = async () => {
    setBusy('install')
    try {
      await installMarketSkill(detail.id)
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  const handleUninstall = async () => {
    setBusy('uninstall')
    try {
      await uninstallMarketSkill(detail.id)
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  const handleToggleFavorite = async () => {
    setBusy('favorite')
    try {
      await toggleMarketFavorite(detail.id, !detail.favorited)
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  const cost = detail.contextCostEstimate
  const compat = detail.compatibility

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeMarketDetail()
      }}
    >
      <div
        className="w-[640px] max-w-[92vw] max-h-[80vh] overflow-y-auto rounded-xl bg-bg-overlay border border-border-default shadow-panel scale-in flex flex-col"
        role="dialog"
        aria-modal="true"
      >
        {/* 头部：名称 + 徽标 + 评分/下载 + 关闭 */}
        <div className="flex items-start gap-3 px-5 pt-4 pb-3 flex-shrink-0">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-base font-medium text-text-primary truncate">{detail.displayName}</span>
              <span className="text-2xs px-1.5 py-0.5 rounded bg-bg-hover text-text-secondary font-mono flex-shrink-0">
                v{detail.version}
              </span>
              <span className="text-2xs px-1.5 py-0.5 rounded bg-accent-soft text-accent flex-shrink-0">
                {t(`panel.skills.category.${detail.category}`, { defaultValue: detail.category })}
              </span>
              {detail.installed && (
                <span className="text-2xs px-1.5 py-0.5 rounded bg-success-soft text-success flex-shrink-0">
                  {t('panel.skills.installed')}
                </span>
              )}
            </div>
            <div className="flex items-center gap-3 mt-1.5 text-2xs text-text-tertiary">
              {detail.ratingCount > 0 ? (
                <span className="flex items-center gap-1 text-warning">
                  <Icon.Star width={14} height={14} />
                  <span className="tabular">{detail.rating.toFixed(1)}</span>
                  <span className="text-text-tertiary">{t('panel.skills.ratingCount', { count: detail.ratingCount })}</span>
                </span>
              ) : (
                <span>{t('panel.skills.noRating')}</span>
              )}
              {detail.downloads > 0 && (
                <span className="flex items-center gap-1 tabular">
                  <Icon.Download width={14} height={14} />
                  {t('panel.skills.downloads', { count: formatCount(detail.downloads) })}
                </span>
              )}
            </div>
          </div>
          <button
            onClick={closeMarketDetail}
            aria-label={t('panel.skills.close')}
            className="w-7 h-7 flex items-center justify-center rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors flex-shrink-0"
          >
            <Icon.X width={16} height={16} />
          </button>
        </div>

        {/* 主体 */}
        <div className="px-5 pb-5 space-y-4">
          <p className="text-xs text-text-secondary leading-relaxed whitespace-pre-wrap">
            {detail.description || t('panel.skills.noDescription')}
          </p>

          {/* Context cost 估算 */}
          <div className="rounded-lg bg-bg-surface border border-border-subtle p-3">
            <div className="text-2xs text-text-tertiary mb-2">{t('panel.skills.detail.contextTitle')}</div>
            <div className="grid grid-cols-3 gap-2">
              {[
                { label: t('panel.skills.detail.costBaseline'), value: cost.baseline },
                { label: t('panel.skills.detail.costActive'), value: cost.active },
                { label: t('panel.skills.detail.costPerTurn'), value: cost.perTurn },
              ].map((c) => (
                <div key={c.label} className="rounded-md bg-bg-base border border-border-subtle px-2.5 py-2">
                  <div className="text-2xs text-text-tertiary">{c.label}</div>
                  <div className="text-sm text-text-primary font-medium tabular mt-0.5">
                    ~{c.value.toLocaleString()}
                    <span className="text-2xs text-text-tertiary font-normal"> {t('panel.skills.detail.tokens')}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 兼容性 */}
          <div className="rounded-lg bg-bg-surface border border-border-subtle p-3">
            <div className="text-2xs text-text-tertiary mb-2">{t('panel.skills.detail.compatTitle')}</div>
            <div className="space-y-1.5 text-xs text-text-secondary">
              <div className="flex items-center gap-2">
                <Icon.Lock width={14} height={14} className="text-text-tertiary flex-shrink-0" />
                <span className="text-2xs text-text-tertiary w-20 flex-shrink-0">ArkWork</span>
                <span className="tabular">{compat.minArkWorkVersion || '—'}+</span>
              </div>
              <div className="flex items-center gap-2">
                <Icon.Terminal width={14} height={14} className="text-text-tertiary flex-shrink-0" />
                <span className="text-2xs text-text-tertiary w-20 flex-shrink-0">{t('panel.skills.detail.compatOs')}</span>
                <span>{compat.os.length > 0 ? compat.os.map((o) => OS_LABEL[o] ?? o).join(' / ') : t('panel.skills.detail.compatAll')}</span>
              </div>
              <div className="flex items-start gap-2">
                <Icon.Plug width={14} height={14} className="text-text-tertiary flex-shrink-0 mt-0.5" />
                <span className="text-2xs text-text-tertiary w-20 flex-shrink-0">{t('panel.skills.detail.compatDeps')}</span>
                <span>{compat.dependencies.length > 0 ? compat.dependencies.join('，') : t('panel.skills.detail.compatNoDeps')}</span>
              </div>
            </div>
          </div>

          {/* 元信息 */}
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-2xs text-text-tertiary">
            {detail.author?.name && <span>{t('panel.skills.detail.author', { name: detail.author.name })}</span>}
            {detail.license && <span>{t('panel.skills.detail.license', { license: detail.license })}</span>}
            {detail.updatedAt && <span>{t('panel.skills.detail.updated', { date: formatDate(detail.updatedAt) })}</span>}
          </div>
        </div>

        {/* 底部操作 */}
        <div className="flex items-center gap-2 px-5 py-3.5 border-t border-border-subtle bg-bg-surface flex-shrink-0">
          {detail.installed ? (
            <button
              onClick={() => void handleUninstall()}
              disabled={busy !== null}
              className="flex items-center gap-1 h-7 px-2.5 rounded-md text-xs text-danger border border-border-default hover:bg-danger-soft disabled:opacity-60 transition-colors"
            >
              <Icon.Trash width={14} height={14} />
              {busy === 'uninstall' ? t('panel.skills.uninstalling') : t('panel.skills.uninstall')}
            </button>
          ) : (
            <button
              onClick={() => void handleInstall()}
              disabled={busy !== null}
              className="flex items-center gap-1 h-7 px-2.5 rounded-md text-xs font-medium text-text-inverse bg-accent hover:bg-accent-hover disabled:opacity-60 transition-colors"
            >
              <Icon.Download width={14} height={14} />
              {busy === 'install' ? t('panel.skills.installing') : t('panel.skills.install')}
            </button>
          )}
          <div className="flex-1" />
          <button
            onClick={() => void handleToggleFavorite()}
            disabled={busy !== null}
            className="flex items-center gap-1 h-7 px-2.5 rounded-md text-xs text-text-secondary border border-border-default hover:bg-bg-hover hover:text-text-primary disabled:opacity-60 transition-colors"
          >
            <Icon.Star width={14} height={14} className={detail.favorited ? 'text-warning' : ''} />
            {busy === 'favorite' ? t('panel.skills.processing') : detail.favorited ? t('panel.skills.unfavorite') : t('panel.skills.favorite')}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ============================================================
 * 市场通用工具
 * ============================================================ */
function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return String(n)
}

function formatDate(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/* ============================================================
 * 开关 / 行内图标按钮
 * ============================================================ */
function Switch({ on, onClick, title }: { on: boolean; onClick: () => void; title?: string }) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      title={title}
      aria-label={title ?? (on ? t('panel.skills.switchOn') : t('panel.skills.switchOff'))}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={`w-8 h-[18px] rounded-full transition-colors flex-shrink-0 flex items-center px-[2px] ${
        on ? 'bg-accent' : 'bg-bg-active'
      }`}
    >
      <span
        className={`w-[14px] h-[14px] bg-white rounded-full transition-transform ${
          on ? 'translate-x-[14px]' : 'translate-x-0'
        }`}
      />
    </button>
  )
}

function IconBtn({
  title,
  onClick,
  disabled,
  danger,
  children,
}: {
  title: string
  onClick: (e: React.MouseEvent) => void
  disabled?: boolean
  danger?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation()
        if (!disabled) onClick(e)
      }}
      className={`w-7 h-7 flex items-center justify-center rounded-md transition-colors ${
        disabled
          ? 'text-text-tertiary opacity-40 cursor-not-allowed'
          : danger
            ? 'text-text-tertiary hover:text-danger hover:bg-danger-soft'
            : 'text-text-tertiary hover:text-text-primary hover:bg-bg-hover'
      }`}
    >
      {children}
    </button>
  )
}

/* ============================================================
 * SkillRow — 技能行（启用/禁用 + 展开 SKILL.md 预览 + 编辑/导出/删除）
 * polish2 §Task 3：依据 subgroup（builtin / market-installed / local-installed）
 * 展示对应徽标；徽标颜色在子组小标题处体现，SkillRow 上保持紧凑。
 * ============================================================ */
function SkillRow({
  skill,
  subgroup,
  onEdit,
  onDelete,
  onToggle,
  onExport,
}: {
  skill: Skill
  subgroup: InstalledSubGroup
  onEdit: () => void
  onDelete: () => void
  onToggle: (enabled: boolean) => void
  onExport: () => void
}) {
  const readSkillInstruction = useStore((s) => s.readSkillInstruction)
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [instruction, setInstruction] = useState<string | null>(null)
  const [loadingInstr, setLoadingInstr] = useState(false)
  const isBuiltin = subgroup === 'builtin'

  // 展开时加载 SKILL.md 内容
  useEffect(() => {
    if (!expanded || instruction !== null || loadingInstr) return
    setLoadingInstr(true)
    void readSkillInstruction(skill.id).then((content) => {
      setInstruction(content)
      setLoadingInstr(false)
    })
  }, [expanded, skill.id, instruction, loadingInstr, readSkillInstruction])

  return (
    <div
      className="rounded-lg bg-bg-surface border border-border-subtle hover:border-border-default transition-colors overflow-hidden"
      data-testid={`skill-row-${subgroup}`}
    >
      {/* 第一行：状态点 + 名称 + 状态徽标 + 展开 chevron */}
      <div
        className="flex items-center gap-2 px-2.5 py-2 cursor-pointer"
        onClick={() => setExpanded((v) => !v)}
      >
        <span
          className={`w-2 h-2 rounded-full flex-shrink-0 ${skill.enabled ? 'bg-success' : 'bg-text-tertiary'}`}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-sm text-text-primary truncate">{skill.name}</span>
            {/* 来源徽标已由子组小标题承担，SkillRow 上只展示状态 / 锁 / 需确认 */}
            {isBuiltin && (
              <Icon.Lock width={16} height={16} className="text-text-tertiary flex-shrink-0" />
            )}
            {skill.needsConfirmation && (
              <span className="text-2xs px-1.5 py-0.5 rounded bg-warning-soft text-warning flex-shrink-0">{t('panel.skills.needsConfirmation')}</span>
            )}
            {!skill.enabled && (
              <span className="text-2xs px-1.5 py-0.5 rounded bg-bg-hover text-text-tertiary flex-shrink-0">{t('panel.skills.notEnabled')}</span>
            )}
          </div>
          <div className="text-xs text-text-tertiary truncate mt-0.5">{skill.description || t('panel.skills.noDescription')}</div>
          {/* polish2 §Task 3：来源追溯 — 市场导入展示 skillhub 包名；本地导入展示文件路径 */}
          {subgroup !== 'builtin' && skill.installedFrom && (
            <div
              data-testid="skill-source-detail"
              data-source-kind={subgroup}
              className="text-2xs text-text-tertiary truncate mt-0.5 font-mono"
              title={skill.installedFrom}
            >
              {t('panel.skills.sourceDetail', { source: skill.installedFrom })}
            </div>
          )}
        </div>
        <Icon.ChevronDown
          width={14}
          height={14}
          className={`text-text-tertiary flex-shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
        />
      </div>
      {/* 第二行：开关 + 操作图标（紧凑排布，不挤压名称） */}
      <div className="flex items-center gap-1 px-2.5 pb-2 -mt-0.5">
        <Switch
          on={skill.enabled}
          onClick={() => onToggle(!skill.enabled)}
          title={skill.enabled ? t('panel.skills.switchOn') : t('panel.skills.switchOff')}
        />
        <span className="text-2xs text-text-tertiary ml-0.5">
          {skill.enabled ? t('panel.skills.statusEnable') : t('panel.skills.statusDisable')}
        </span>
        <div className="flex items-center gap-0.5 ml-auto">
          <IconBtn title={t('panel.skills.edit')} onClick={onEdit} disabled={isBuiltin}>
            <Icon.Edit width={16} height={16} />
          </IconBtn>
          <IconBtn title={t('panel.skills.export')} onClick={onExport}>
            <Icon.Download width={16} height={16} />
          </IconBtn>
          <IconBtn
            title={isBuiltin ? t('panel.skills.deleteBuiltin') : t('panel.skills.delete')}
            disabled={isBuiltin}
            danger
            onClick={onDelete}
          >
            <Icon.Trash width={16} height={16} />
          </IconBtn>
        </div>
      </div>
      {/* 内联 SKILL.md 预览 */}
      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-border-subtle">
          {loadingInstr ? (
            <div className="py-4 text-center text-xs text-text-tertiary">{t('panel.skills.loading')}</div>
          ) : instruction ? (
            <pre className="text-xs text-text-secondary whitespace-pre-wrap font-mono leading-relaxed max-h-60 overflow-y-auto">
              {instruction}
            </pre>
          ) : (
            <div className="py-2 text-xs text-text-tertiary">{t('panel.skills.noInstruction')}</div>
          )}
        </div>
      )}
    </div>
  )
}