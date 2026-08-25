/* ============================================================
 * ArkWork — IPC: Market
 * 设计文档 §5（F10）· v0.6.1 SkillHub 集成
 *
 * v0.6.1（问题 3）：市场接入腾讯 SkillHub（https://skillhub.cn/）
 *  - 搜索：走 SkillHub 公开 HTTP API（GET https://api.skillhub.cn/api/skills，
 *    免鉴权、国内可达、中文分词搜索），API 失败时回退本地内置索引。
 *  - 安装：走 skillhub CLI（`skillhub install <slug> --dir <skillsDir>`），
 *    安装产物为标准 SKILL.md 目录，registry 直接识别。
 *  - CLI 管理：market:check-cli 检测；market:install-cli 一键安装。
 *
 * 通道：market:search / install / list-installed / check-cli / install-cli
 * ============================================================ */
import { ipcMain } from 'electron'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { listSkills, addSkill, removeSkill, reseedBuiltinSkills } from '../store/skills.js'
import { invalidateSkillCache } from '../agent/registry.js'
import { getArkworkDir, getWorkspaceDir } from '../store/db.js'
import { suggestSkillsForWorkspace } from '../skills/suggest.js'
import {
  loadMarketState,
  markInstalled,
  markUninstalled,
  toggleFavorite,
  recordRecentSearch,
  addSource,
  removeSource,
  updateSource,
  listSources as listMarketSources,
} from '../skills/market-state.js'
import type { Skill } from '@shared/types/agent'
import type {
  MarketSearchResult,
  SkillMetadata,
  SkillReview,
  MarketplaceSource,
  MarketSearchParams,
  MarketLocalState,
} from '@shared/types/ipc'
import { genId } from '@shared/utils/id'
import { logger } from '../system/logger.js'
// v0.29.0 F6：用户可见校验错误四语言化
import { getUiLocale, tFor } from '../i18n/messages.js'

/* ============================================================
 * SkillHub 配置
 * ============================================================ */
const SKILLHUB_API = 'https://api.skillhub.cn/api/skills'
const SKILLHUB_INSTALL_URL = 'https://skillhub-1388575217.cos.ap-guangzhou.myqcloud.com/install/install.sh'
const SKILLHUB_PREFIX = 'skillhub.'

/** SkillHub 12 个一级分类（中文名便于 UI 展示） */
const SKILLHUB_CATEGORIES: Record<string, string> = {
  'office-efficiency': '办公效率',
  'content-creation': '内容创作',
  'dev-programming': '开发编程',
  'data-analysis': '数据分析',
  'design-media': '设计多媒体',
  'ai-agent': 'AI Agent',
  'knowledge-management': '知识管理',
  'business-ops': '商业运营',
  'education': '教育学习',
  'professional': '行业专业',
  'it-ops-security': 'IT 运维与安全',
  'life-service': '生活服务',
}

/* ============================================================
 * 本地内置索引（SkillHub API 不可用时的 fallback）
 * ============================================================ */
interface MarketEntry {
  id: string
  name: string
  description: string
  tags: string[]
  source: 'builtin' | 'community'
  skillTemplate: Omit<Skill, 'id' | 'source' | 'enabled'>
  instructionMd?: string
}

const MARKET_ENTRIES: MarketEntry[] = [
  {
    id: 'market.pdf-extract',
    name: 'pdf-extract',
    description: '提取 PDF 文本的文本与元数据（依赖 pdftotext / pdfinfo）',
    tags: ['file', 'pdf', 'io'],
    source: 'community',
    skillTemplate: {
      name: 'pdf-extract',
      description: '提取 PDF 文本的文本与元数据（依赖 pdftotext / pdfinfo）',
      namespace: 'custom',
      builtinHandler: undefined,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'PDF 文件绝对路径' },
          maxPages: { type: 'number', default: 50, description: '最多提取的页数' },
        },
        required: ['path'],
      },
      timeout: 60_000,
      needsConfirmation: false,
      tags: ['file', 'pdf'],
    },
    instructionMd: `# pdf-extract

提取指定 PDF 文件的文本内容。

## 使用方式
- 参数 path 必须是 PDF 文件绝对路径
- 依赖系统已安装 pdftotext（poppler-utils）
- 大文件用 maxPages 限制提取页数避免超时

## 输出
返回 { path, pages, text, chars } 结构。
`,
  },
  {
    id: 'market.git-diff',
    name: 'git-diff',
    description: '读取 git 仓库的 diff / log / status（受限于工作区目录）',
    tags: ['git', 'vcs', 'shell'],
    source: 'community',
    skillTemplate: {
      name: 'git-diff',
      description: '读取 git 仓库的 diff / log / status（受限于工作区目录）',
      namespace: 'custom',
      builtinHandler: 'shell',
      inputSchema: {
        type: 'object',
        properties: {
          subcommand: {
            type: 'string',
            description: 'git 子命令，如 "diff" / "log --oneline -10" / "status"',
          },
        },
        required: ['subcommand'],
      },
      timeout: 30_000,
      needsConfirmation: true,
      tags: ['git', 'vcs'],
    },
    instructionMd: `# git-diff

在工作区内执行 git 只读子命令（diff / log / status / show）。

## 限制
- 仅允许只读子命令，禁止 push / commit / reset 等写操作
- cwd 限制在工作区目录内
- 大 diff 输出会截断，建议带 --stat 或限制行数

## 调用示例
\`\`\`json
{ "subcommand": "diff --stat HEAD~1" }
\`\`\`
`,
  },
  {
    id: 'market.markdown-to-html',
    name: 'markdown-to-html',
    description: '把 Markdown 文本转换为 HTML（纯前端实现，无外部依赖）',
    tags: ['markdown', 'convert', 'text'],
    source: 'community',
    skillTemplate: {
      name: 'markdown-to-html',
      description: '把 Markdown 文本转换为 HTML',
      namespace: 'custom',
      inputSchema: {
        type: 'object',
        properties: {
          markdown: { type: 'string', description: 'Markdown 源文本' },
        },
        required: ['markdown'],
      },
      timeout: 5_000,
      needsConfirmation: false,
      tags: ['markdown', 'convert'],
    },
  },
]

/* ============================================================
 * SkillHub CLI 检测 / 安装
 * ============================================================ */

export interface SkillHubCliInfo {
  installed: boolean
  path?: string
  version?: string
}

/**
 * 检测 skillhub CLI。
 * 依次检查：PATH 中的 skillhub → ~/.local/bin/skillhub。
 */
export function checkSkillHubCli(): SkillHubCliInfo {
  // 1. PATH 检测
  try {
    const r = spawnSync('skillhub', ['--version'], { timeout: 5000, encoding: 'utf-8' })
    if (r.status === 0 && r.stdout.trim()) {
      return { installed: true, path: 'skillhub', version: r.stdout.trim().split('\n')[0] }
    }
  } catch {
    // ignore
  }
  // 2. ~/.local/bin/skillhub（安装脚本默认路径）
  const homeCli = join(homedir(), '.local', 'bin', 'skillhub')
  if (existsSync(homeCli)) {
    try {
      const r = spawnSync(homeCli, ['--version'], { timeout: 5000, encoding: 'utf-8' })
      if (r.status === 0 && r.stdout.trim()) {
        return { installed: true, path: homeCli, version: r.stdout.trim().split('\n')[0] }
      }
    } catch {
      // ignore
    }
    return { installed: true, path: homeCli }
  }
  return { installed: false }
}

/** 执行 shell 命令，收集 stdout/stderr，带超时 */
function runCli(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGTERM') } catch { /* ignore */ }
    }, timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr: stderr + (timedOut ? '\n… (timed out)' : '') })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr: `spawn error: ${err.message}` })
    })
  })
}

/**
 * 安装 skillhub CLI（curl | bash 官方脚本）。
 * 注意：执行第三方脚本有安全风险，仅在用户确认后由前端调用。
 */
export async function installSkillHubCli(): Promise<SkillHubCliInfo> {
  const script = `curl -fsSL ${SKILLHUB_INSTALL_URL} | bash`
  logger.info('System', 'installing skillhub CLI…')
  const r = await runCli('/bin/sh', ['-c', script], 120_000)
  if (r.code !== 0) {
    logger.error('System', `skillhub CLI install failed: ${r.stderr.slice(0, 300)}`)
    throw new Error(tFor(getUiLocale(), 'market.cliInstallFailed', { message: r.stderr.slice(0, 200) }))
  }
  const info = checkSkillHubCli()
  if (!info.installed) {
    throw new Error(tFor(getUiLocale(), 'market.cliNotDetected'))
  }
  logger.info('System', `skillhub CLI installed: ${info.path} (${info.version ?? '?'})`)
  return info
}

/* ============================================================
 * SkillHub API 搜索
 * ============================================================ */

interface SkillHubItem {
  name?: string
  slug?: string
  description_zh?: string
  description?: string
  downloads?: number
  installs?: number
  category?: string
}

/**
 * 调 SkillHub 公开 API 搜索技能。
 * @param query - 关键词（中文分词搜索）
 * @param category - 一级分类（可选）
 * @returns 标准化 MarketSearchResult[]；installed 与本地已装技能比对
 */
async function searchSkillHubApi(
  query: string,
  category?: string,
  page = 1,
  pageSize = 30,
): Promise<{ results: MarketSearchResult[]; total: number; hasMore: boolean }> {
  const params = new URLSearchParams({ sortBy: 'score', pageSize: String(pageSize), page: String(page) })
  if (query) params.set('keyword', query)
  if (category) params.set('category', category)

  const res = await fetch(`${SKILLHUB_API}?${params.toString()}`, {
    headers: { 'User-Agent': 'ArkWork/0.6.4', 'Accept-Language': 'zh-CN,zh;q=0.9' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`SkillHub API HTTP ${res.status}`)

  const data = (await res.json()) as {
    data?: { skills?: SkillHubItem[]; total?: number }
  }
  const items = data.data?.skills ?? []
  const total = data.data?.total ?? 0
  if (items.length === 0) return { results: [], total, hasMore: false }

  const installed = await listSkills()
  const installedIds = new Set(installed.map((s) => s.id))

  const results = items
    .filter((s) => s.slug && s.name)
    .map((s): MarketSearchResult => {
      const id = `${SKILLHUB_PREFIX}${s.slug}`
      return {
        id,
        name: s.name!,
        // v0.6.4：不再截断描述，详情 Modal 展示完整内容
        description: s.description_zh || s.description || '',
        tags: s.category ? [s.category] : [],
        source: 'community',
        installed: installedIds.has(id) || installed.some((x) => x.name === s.name),
        downloads: s.downloads ?? s.installs,
        slug: s.slug,
      }
    })

  return { results, total, hasMore: page * pageSize < total }
}

/* ============================================================
 * 本地索引搜索（fallback）
 * ============================================================ */
async function searchLocalMarket(
  query: string,
  tags: string[],
): Promise<MarketSearchResult[]> {
  const installed = await listSkills()
  const installedIds = new Set(installed.map((s) => s.name))
  const q = query.toLowerCase()

  return MARKET_ENTRIES.filter((e) => {
    if (tags.length > 0 && !tags.every((t) => e.tags.includes(t))) return false
    if (q) {
      const hay = `${e.name} ${e.description} ${e.tags.join(' ')}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  }).map((e) => ({
    id: e.id,
    name: e.name,
    description: e.description,
    tags: e.tags,
    source: e.source,
    installed: installedIds.has(e.skillTemplate.name),
  }))
}

/* ============================================================
 * IPC Handlers
 * ============================================================ */

export function registerMarketHandlers(): void {
  /**
   * 搜索市场 Skill（v0.6.1：SkillHub API 优先，本地索引兜底）。
   * @param payload - { query?, tags? }（tags[0] 作为 SkillHub category）
   * @returns MarketSearchResult[]
   */
  ipcMain.handle(
    'market:search',
    async (
      _e,
      payload: { query?: string; tags?: string[]; page?: number },
    ): Promise<{ results: MarketSearchResult[]; total: number; hasMore: boolean }> => {
      const query = (payload.query ?? '').trim()
      const tags = payload.tags ?? []
      const page = payload.page ?? 1
      const category = tags.find((t) => SKILLHUB_CATEGORIES[t])

      // 优先 SkillHub
      try {
        const resp = await searchSkillHubApi(query, category, page)
        // v0.6.4：本地 fallback 仅首页生效，不支持分页
        if (page === 1 && resp.results.length === 0) {
          const local = await searchLocalMarket(query, tags)
          await recordRecentSearch(query)
          return { results: local, total: local.length, hasMore: false }
        }
        await recordRecentSearch(query)
        return resp
      } catch (err) {
        logger.warn('System', `SkillHub search failed, fallback to local: ${(err as Error).message}`)
        if (page === 1) {
          const local = await searchLocalMarket(query, tags)
          await recordRecentSearch(query)
          return { results: local, total: local.length, hasMore: false }
        }
        return { results: [], total: 0, hasMore: false }
      }
    },
  )

  /**
   * 安装市场 Skill。
   * @param payload - { skillId }
   *  - skillhub.* → 走 skillhub CLI 安装（需 CLI 已安装）
   *  - market.*   → 本地模板写入
   * @returns 安装的 Skill；已安装返回 null
   * 错误：skillhub CLI 未安装 / 安装命令失败
   */
  ipcMain.handle('market:install', async (_e, payload: { skillId: string }): Promise<Skill | null> => {
    const { skillId } = payload

    // SkillHub 技能：CLI 安装
    if (skillId.startsWith(SKILLHUB_PREFIX)) {
      const slug = skillId.slice(SKILLHUB_PREFIX.length)
      return installFromSkillHub(slug, skillId)
    }

    // 本地模板
    const entry = MARKET_ENTRIES.find((e) => e.id === skillId)
    if (!entry) {
      throw new Error(tFor(getUiLocale(), 'market.skillNotFound', { id: skillId }))
    }
    const installed = await listSkills()
    if (installed.find((s) => s.name === entry.skillTemplate.name)) {
      logger.info('System', `market install skipped (already installed): ${entry.name}`)
      return null
    }
    const skill = await addSkill({
      ...entry.skillTemplate,
      // v0.14.0 Task 5：市场安装统一标记 source='market' 并记录包名（installedFrom），
      // UI 据此在「已导入」分组展示市场包名来源
      source: 'market',
      enabled: true,
      instructionMdContent: entry.instructionMd,
      installedFrom: entry.id,
    })
    await markInstalled(entry.id, 'market', '1.0.0')
    invalidateSkillCache()
    logger.info('System', `market installed: ${skill.id} from ${entry.id}`)
    return skill
  })

  /** v0.15.0：卸载已安装技能 */
  ipcMain.handle(
    'market:uninstall',
    async (_e, payload: { skillId: string }): Promise<void> => {
      const installed = await listSkills()
      const skill = installed.find(
        (s) => s.id === payload.skillId || s.installedFrom === payload.skillId,
      )
      if (!skill) return
      await removeSkill(skill.id)
      await markUninstalled(payload.skillId)
      invalidateSkillCache()
    },
  )

  /** v0.15.0：技能详情（合并服务端/本地） */
  ipcMain.handle(
    'market:detail',
    async (_e, payload: { skillId: string }): Promise<SkillMetadata | null> => {
      const { skillId } = payload
      if (skillId.startsWith(SKILLHUB_PREFIX)) {
        const slug = skillId.slice(SKILLHUB_PREFIX.length)
        try {
          const res = await fetch(`${SKILLHUB_API}/${encodeURIComponent(slug)}`, {
            headers: { 'User-Agent': 'ArkWork/0.15.0' },
            signal: AbortSignal.timeout(10_000),
          })
          if (res.ok) {
            const data = (await res.json()) as { data?: Partial<SkillMetadata> }
            if (data.data && data.data.id) {
              const state = await loadMarketState()
              data.data.installed = !!state.installed[skillId]
              data.data.favorited = state.favorites.includes(skillId)
              return data.data as SkillMetadata
            }
          }
        } catch (err) {
          logger.warn('System', `market detail fetch failed: ${(err as Error).message}`)
        }
      }
      const local = MARKET_ENTRIES.find((e) => e.id === skillId)
      if (!local) return null
      const state = await loadMarketState()
      const metadata: SkillMetadata = {
        id: local.id,
        name: local.skillTemplate.name,
        displayName: local.skillTemplate.name,
        description: local.description,
        category: 'other',
        tags: local.tags,
        version: '1.0.0',
        author: { name: 'ArkWork' },
        keywords: local.tags,
        downloads: 0,
        rating: 0,
        ratingCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        contextCostEstimate: { baseline: 50, active: 1200, perTurn: 320 },
        compatibility: { minArkWorkVersion: '0.15.0', os: ['macos', 'linux', 'windows'], dependencies: [] },
        source: 'builtin',
        featured: false,
        deprecated: false,
        installed: !!state.installed[skillId],
        favorited: state.favorites.includes(skillId),
      }
      return metadata
    },
  )

  /** v0.15.0：技能评价（仅本地持久化，未来可对接服务端） */
  ipcMain.handle(
    'market:review',
    async (
      _e,
      payload: { skillId: string; rating: number; comment?: string },
    ): Promise<SkillReview> => {
      const review: SkillReview = {
        id: genId('rev'),
        skillId: payload.skillId,
        userId: 'me',
        userName: 'You',
        rating: payload.rating,
        comment: payload.comment,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      logger.info('System', `market review: ${payload.skillId} ${payload.rating}星`)
      return review
    },
  )

  /** v0.15.0：收藏切换 */
  ipcMain.handle(
    'market:toggle-favorite',
    async (_e, payload: { skillId: string; favorited: boolean }): Promise<void> => {
      await toggleFavorite(payload.skillId, payload.favorited)
    },
  )

  /** v0.15.0：市场源管理 */
  ipcMain.handle('market:list-sources', async (): Promise<MarketplaceSource[]> => {
    return listMarketSources()
  })

  ipcMain.handle(
    'market:add-source',
    async (_e, payload: { source: MarketplaceSource }): Promise<MarketplaceSource> => {
      await addSource(payload.source)
      return payload.source
    },
  )

  ipcMain.handle(
    'market:remove-source',
    async (_e, payload: { sourceId: string }): Promise<void> => {
      await removeSource(payload.sourceId)
    },
  )

  ipcMain.handle(
    'market:update-source',
    async (
      _e,
      payload: { sourceId: string; patch: Partial<MarketplaceSource> },
    ): Promise<void> => {
      await updateSource(payload.sourceId, payload.patch)
    },
  )

  /** v0.15.0：基于当前 workspace 特征推荐技能 */
  ipcMain.handle('market:suggest', async (): Promise<SkillMetadata[]> => {
    return suggestSkillsForWorkspace(getWorkspaceDir())
  })

  /** v0.15.0：本地持久化市场状态（收藏/已装/源，供「收藏」「设置」标签页） */
  ipcMain.handle('market:get-local-state', async (): Promise<MarketLocalState> => {
    return loadMarketState()
  })

  /** 检测 skillhub CLI 是否可用 */
  ipcMain.handle('market:check-cli', async (): Promise<SkillHubCliInfo> => {
    return checkSkillHubCli()
  })

  /** 安装 skillhub CLI（用户确认后调用） */
  ipcMain.handle('market:install-cli', async (): Promise<SkillHubCliInfo> => {
    return installSkillHubCli()
  })

  /** 列出所有已安装 Skill（market 视角） */
  ipcMain.handle('market:list-installed', async (): Promise<MarketSearchResult[]> => {
    const installed = await listSkills()
    return installed.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      tags: s.tags ?? [],
      source: s.source === 'builtin' ? 'builtin' : 'community',
      installed: true,
    }))
  })

  /** 重新播种内置 Skill（调试用） */
  ipcMain.handle('market:reseed-builtin', async () => {
    await reseedBuiltinSkills()
    return listSkills()
  })
}

/**
 * 用 skillhub CLI 安装技能到 ArkWork skills 目录。
 * @param slug - SkillHub 技能 slug
 * @param skillId - 市场 id（skillhub.<slug>），写入 Skill.installedFrom
 */
async function installFromSkillHub(slug: string, skillId: string): Promise<Skill | null> {
  // 已安装检查（按 name / installedFrom）
  const installed = await listSkills()
  if (installed.find((s) => s.name === slug || s.installedFrom === skillId)) {
    logger.info('System', `skillhub install skipped (already installed): ${slug}`)
    return null
  }

  const cli = checkSkillHubCli()
  if (!cli.installed) {
    throw new Error(tFor(getUiLocale(), 'market.cliNotInstalled'))
  }

  const skillsDir = join(getArkworkDir(), 'skills')
  logger.info('System', `skillhub install: ${slug} → ${skillsDir}`)
  const r = await runCli(cli.path!, ['install', slug, '--dir', skillsDir], 120_000)
  if (r.code !== 0) {
    logger.error('System', `skillhub install failed: ${r.stderr.slice(0, 300)}`)
    throw new Error(tFor(getUiLocale(), 'market.installFailed', { message: (r.stderr || r.stdout).slice(0, 200) }))
  }

  // 刷新 registry 缓存，让新装的 SKILL.md 目录被扫描到
  invalidateSkillCache()
  const after = await listSkills()

  // 优先匹配 installedFrom；否则按 name 匹配
  const skill =
    after.find((s) => s.installedFrom === skillId) ??
    after.find((s) => s.name === slug) ??
    null

  if (skill) {
    logger.info('System', `skillhub installed: ${skill.id} (${slug})`)
    return skill
  }
  // 安装成功但未识别（目录格式特殊）——返回一个占位 Skill 供 UI 反馈
  logger.warn('System', `skillhub installed but not registered: ${slug}（目录在 ${skillsDir}/${slug}）`)
  return {
    id: skillId,
    name: slug,
    description: 'SkillHub 技能（目录已安装，格式待识别）',
    namespace: 'market',
    source: 'market',
    enabled: true,
  } as Skill
}
