/* ============================================================
 * ArkWork — Skill Market Local State (v0.15.0)
 * 持久化 installed / favorites / recentSearches / marketplaces
 * ============================================================ */
import { join } from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { getArkworkDir } from '../store/db.js'
import type {
  MarketLocalState,
  MarketplaceSource,
  SkillReview,
} from '@shared/types/ipc'

const STATE_FILE = 'market-state.json'

export const DEFAULT_OFFICIAL_SOURCES: MarketplaceSource[] = [
  {
    id: 'skillhub-official',
    name: 'SkillHub 官方',
    url: 'https://api.skillhub.cn/api/skills',
    type: 'skillhub',
    enabled: true,
    autoUpdate: true,
  },
]

export const DEFAULT_LOCAL_STATE: MarketLocalState = {
  installed: {},
  favorites: [],
  recentSearches: [],
  marketplaces: DEFAULT_OFFICIAL_SOURCES,
}

function statePath(): string {
  return join(getArkworkDir(), 'config', STATE_FILE)
}

let cached: MarketLocalState | null = null

export async function loadMarketState(): Promise<MarketLocalState> {
  if (cached) return cached
  const path = statePath()
  if (!existsSync(path)) {
    cached = {
      installed: {},
      favorites: [],
      recentSearches: [],
      marketplaces: [...DEFAULT_OFFICIAL_SOURCES],
    }
    return cached
  }
  try {
    const raw = await readFile(path, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<MarketLocalState> & {
      installedFromMarket?: string[]
      reviews?: Record<string, SkillReview[]>
      sources?: MarketplaceSource[]
    }
    const next: MarketLocalState = {
      installed: parsed.installed ?? {},
      favorites: parsed.favorites ?? [],
      recentSearches: parsed.recentSearches ?? [],
      marketplaces:
        parsed.marketplaces ??
        parsed.sources ??
        [...DEFAULT_OFFICIAL_SOURCES],
    }
    cached = next
    return next
  } catch {
    const next: MarketLocalState = {
      installed: {},
      favorites: [],
      recentSearches: [],
      marketplaces: [...DEFAULT_OFFICIAL_SOURCES],
    }
    cached = next
    return next
  }
}

async function saveMarketState(state: MarketLocalState): Promise<void> {
  cached = state
  const path = statePath()
  await mkdir(join(getArkworkDir(), 'config'), { recursive: true })
  await writeFile(path, JSON.stringify(state, null, 2), 'utf-8')
}

export async function markInstalled(
  skillId: string,
  source: string,
  version: string,
): Promise<void> {
  const state = await loadMarketState()
  state.installed[skillId] = {
    version,
    installedAt: new Date().toISOString(),
    source,
    enabled: true,
    lastUsedAt: null,
    useCount: 0,
  }
  await saveMarketState(state)
}

export async function markUninstalled(skillId: string): Promise<void> {
  const state = await loadMarketState()
  delete state.installed[skillId]
  await saveMarketState(state)
}

export async function toggleFavorite(skillId: string, favorited: boolean): Promise<void> {
  const state = await loadMarketState()
  if (favorited) {
    if (!state.favorites.includes(skillId)) state.favorites.push(skillId)
  } else {
    state.favorites = state.favorites.filter((id) => id !== skillId)
  }
  await saveMarketState(state)
}

export async function recordRecentSearch(query: string): Promise<void> {
  if (!query.trim()) return
  const state = await loadMarketState()
  state.recentSearches = [query, ...state.recentSearches.filter((q) => q !== query)].slice(0, 20)
  await saveMarketState(state)
}

export async function addSource(source: MarketplaceSource): Promise<void> {
  const state = await loadMarketState()
  if (state.marketplaces.find((s: MarketplaceSource) => s.id === source.id)) return
  state.marketplaces.push(source)
  await saveMarketState(state)
}

export async function removeSource(sourceId: string): Promise<void> {
  const state = await loadMarketState()
  state.marketplaces = state.marketplaces.filter((s: MarketplaceSource) => s.id !== sourceId)
  await saveMarketState(state)
}

export async function updateSource(sourceId: string, patch: Partial<MarketplaceSource>): Promise<void> {
  const state = await loadMarketState()
  state.marketplaces = state.marketplaces.map((s: MarketplaceSource) =>
    s.id === sourceId ? { ...s, ...patch } : s,
  )
  await saveMarketState(state)
}

export async function listSources(): Promise<MarketplaceSource[]> {
  const state = await loadMarketState()
  return state.marketplaces
}

export function resetMarketStateForTest(): void {
  cached = null
}