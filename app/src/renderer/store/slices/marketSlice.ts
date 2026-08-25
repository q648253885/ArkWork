/* ============================================================
 * ArkWork — SkillHub 市场 slice（v0.27.0 R3：自 store.ts 纯移动）
 * 搜索/安装/收藏/来源/详情 + CLI 检测与安装
 * ============================================================ */
import type { StateCreator } from 'zustand'
import i18n from '../../i18n'
import { ark } from '../../ipc/client'
import { friendlyError } from '../meta'
import type { AppState } from '../types'

export const marketSlice: StateCreator<
  AppState,
  [],
  [],
  Pick<
    AppState,
    | 'marketSkills'
    | 'marketLoading'
    | 'marketHasMore'
    | 'marketTotal'
    | 'marketPage'
    | 'marketPageSize'
    | 'marketQuery'
    | 'marketTags'
    | 'searchMarket'
    | 'installMarketSkill'
    | 'marketCli'
    | 'checkMarketCli'
    | 'installMarketCli'
    | 'marketInstalled'
    | 'marketFavorites'
    | 'marketSources'
    | 'marketDetail'
    | 'marketDetailOpen'
    | 'listInstalledMarket'
    | 'listMarketFavorites'
    | 'uninstallMarketSkill'
    | 'toggleMarketFavorite'
    | 'refreshMarketSources'
    | 'openMarketDetail'
    | 'closeMarketDetail'
  >
> = (set, get) => ({

  // ---- v0.6.0 Skill 市场 ----
  marketSkills: [],
  marketLoading: false,
  marketHasMore: false,
  marketTotal: 0,
  marketPage: 1,
  marketPageSize: 30,
  marketQuery: '',
  marketTags: [],
  // v0.6.1：SkillHub CLI 状态
  marketCli: null,
  checkMarketCli: async () => {
    try {
      const info = await ark.market.checkCli()
      set({ marketCli: info })
    } catch {
      set({ marketCli: null })
    }
  },
  installMarketCli: async () => {
    try {
      const info = await ark.market.installCli()
      set({ marketCli: info })
      get().pushToast({ type: 'success', message: i18n.t('slice.market.cliInstalled', { version: info.version ? `（${info.version}）` : '' }), duration: 3000 })
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  searchMarket: async (query, tags, page) => {
    const q = query ?? ''
    const t = tags ?? []
    const p = page ?? 1
    set({ marketLoading: true })
    try {
      const resp = await ark.market.search(q, t, p)
      set({
        // v0.8.0：改为真分页（翻页替换，不再追加）
        marketSkills: resp.results,
        marketHasMore: resp.hasMore,
        marketTotal: resp.total,
        marketPage: p,
        marketQuery: q,
        marketTags: t,
      })
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    } finally {
      set({ marketLoading: false })
    }
  },
  installMarketSkill: async (skillId) => {
    try {
      const skill = await ark.market.install(skillId)
      if (skill) {
        await get().refreshCatalog()
        get().pushToast({ type: 'success', message: i18n.t('slice.market.skillInstalled', { name: skill.name }), duration: 3000 })
        // 刷新市场列表以更新 installed 状态（使用上次搜索条件与当前页）
        const { marketQuery, marketTags, marketPage } = get()
        await get().searchMarket(marketQuery, marketTags, marketPage)
        return true
      }
      // 已安装
      get().pushToast({ type: 'warning', message: i18n.t('slice.market.skillAlreadyInstalled'), duration: 3000 })
      return false
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
      return false
    }
  },

  // ---- v0.15.0 市场增强 ----
  marketInstalled: [],
  marketFavorites: [],
  marketSources: [],
  marketDetail: null,
  marketDetailOpen: false,
  listInstalledMarket: async () => {
    try {
      const list = await ark.market.listInstalled()
      set({ marketInstalled: list })
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  listMarketFavorites: async () => {
    try {
      const state = await ark.market.getLocalState()
      const fav = (state.favorites ?? []).map((id) => ({
        id,
        name: id,
        description: i18n.t('slice.market.favoritedSkill'),
        tags: [],
        source: 'community' as const,
        installed: true,
      }))
      set({ marketFavorites: fav })
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  uninstallMarketSkill: async (skillId) => {
    try {
      await ark.market.uninstall(skillId)
      get().pushToast({ type: 'success', message: i18n.t('slice.market.skillUninstalled'), duration: 3000 })
      await get().refreshCatalog()
      await get().listInstalledMarket()
      const { marketQuery, marketTags, marketPage } = get()
      await get().searchMarket(marketQuery, marketTags, marketPage)
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  toggleMarketFavorite: async (skillId, favorited) => {
    try {
      await ark.market.toggleFavorite(skillId, favorited)
      await get().listMarketFavorites()
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  refreshMarketSources: async () => {
    try {
      const sources = await ark.market.listSources()
      set({ marketSources: sources })
    } catch {
      set({ marketSources: [] })
    }
  },
  openMarketDetail: async (skill) => {
    set({ marketDetailOpen: true })
    try {
      const meta = await ark.market.detail(skill.id)
      if (meta) {
        set({ marketDetail: meta })
      } else if ('metadata' in skill && skill.metadata) {
        set({ marketDetail: skill.metadata })
      } else {
        set({
          marketDetail: {
            id: skill.id,
            name: skill.name,
            displayName: skill.name,
            description: skill.description,
            category: 'other',
            tags: skill.tags,
            version: '1.0.0',
            author: { name: 'SkillHub' },
            keywords: skill.tags,
            downloads: skill.downloads ?? 0,
            rating: 0,
            ratingCount: 0,
            createdAt: '',
            updatedAt: '',
            contextCostEstimate: { baseline: 50, active: 1200, perTurn: 320 },
            compatibility: { minArkWorkVersion: '0.15.0', os: ['macos', 'linux', 'windows'], dependencies: [] },
            source: skill.source === 'builtin' ? 'builtin' : 'market',
            featured: false,
            deprecated: false,
            installed: skill.installed,
            favorited: false,
          },
        })
      }
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  closeMarketDetail: () => set({ marketDetailOpen: false, marketDetail: null }),
});
