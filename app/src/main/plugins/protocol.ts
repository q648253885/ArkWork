/* ============================================================
 * ArkWork — 插件资源协议 `arkwork-plugin://`（v0.35.0 · M9）
 * 设计文档：docs/versions/v0.35.0/04-system-design.md §1（选型）· §5.2 · §9
 *
 * 为什么需要一条自定义协议（而不是让 iframe 直接 `file://` 读插件目录）：
 *  ① `file://` 无法按插件收口 —— 一旦放行，插件就能读整块磁盘；
 *     本 handler 只放行**该插件自己目录内**的文件（realpath + 目录前缀双校验）；
 *  ② 沙箱 iframe 里的 `file://` 行为不稳（不同 Electron 版本对 opaque origin
 *     加载 file 的处理并不一致），自定义协议可以自己定 CORS/CSP；
 *  ③ 不必把插件拷进 asar —— 插件就在用户目录里，作者改完即可重载。
 *
 * **两条安全边界**（在 handler 里物理执行）：
 *  · 入口 realpath 后必须仍在该插件目录内（挡 `..` 与 symlink 逃逸）；
 *  · 响应带 `connect-src 'none'` 的 CSP —— Client 半**拿不到直连网络**，
 *    要联网必须回 Host 半走 `ctx.ark.net.fetch`（那条路有权限闸门与审计）。
 *    这不是「不给功能」，而是把网络的唯一出口钉在有闸门的地方。
 * ============================================================ */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'

/** 自定义协议名（唯一真源；渲染层 iframe 的 src 前缀也用它） */
export const PLUGIN_SCHEME = 'arkwork-plugin'

/** 协议 URL 前缀（渲染层拼 src 用） */
export const PLUGIN_SCHEME_PREFIX = `${PLUGIN_SCHEME}://`

/**
 * 在 `app.whenReady()` **之前**注册协议特权。
 *
 * 为什么必须早：自定义 scheme 若不声明为 `standard`，Chromium 会把它当成
 * 不透明 scheme —— 相对路径解析、CORS 与 fetch 全部失效（表现为「iframe 白屏」，
 * 且没有任何报错）。`standard: true` 让它具备 `//host/path` 语义。
 */
export const PLUGIN_SCHEME_PRIVILEGES = {
  scheme: PLUGIN_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
  },
} as const

/* ============================================================
 * URL 解析（纯函数，可单测）
 * ============================================================ */

export interface PluginAssetRef {
  pluginId: string
  /** 插件目录内的相对路径（已去掉前导 `/`） */
  rel: string
}

/**
 * 把 `arkwork-plugin://<pluginId>/<rel>` 解析成结构化引用。
 *
 * @returns 非法 URL / 非本协议 / 缺 pluginId 时返回 null（调用方回 400）
 */
export function parsePluginAssetUrl(rawUrl: string): PluginAssetRef | null {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return null
  }
  if (u.protocol !== `${PLUGIN_SCHEME}:`) return null
  // host 部分即 pluginId（`ark.plugin.stock` 这种带点的 id 在 standard scheme 下合法）
  const pluginId = decodeURIComponent(u.hostname)
  if (!pluginId) return null
  const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '')
  if (!rel) return null
  return { pluginId, rel }
}

/** 相对路径是否含非法段（`..` / 空段 / 绝对路径 / 反斜杠） */
export function isSafeRelPath(rel: string): boolean {
  if (!rel) return false
  if (rel.includes('\\')) return false
  if (isAbsolute(rel)) return false
  return !rel.split('/').some((s) => s === '' || s === '.' || s === '..')
}

/** 扩展名 → MIME（只列插件真正会用到的那些；未列出一律 octet-stream，绝不猜） */
export function mimeOf(rel: string): string {
  const ext = extname(rel).toLowerCase()
  switch (ext) {
    case '.html':
    case '.htm':
      return 'text/html; charset=utf-8'
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'text/javascript; charset=utf-8'
    case '.css':
      return 'text/css; charset=utf-8'
    case '.json':
      return 'application/json; charset=utf-8'
    case '.svg':
      return 'image/svg+xml'
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    case '.ico':
      return 'image/x-icon'
    case '.woff':
      return 'font/woff'
    case '.woff2':
      return 'font/woff2'
    case '.txt':
    case '.md':
      return 'text/plain; charset=utf-8'
    case '.wasm':
      return 'application/wasm'
    default:
      return 'application/octet-stream'
  }
}

/**
 * Client 半的 CSP。
 *
 * `connect-src 'none'` 是关键一条：插件界面**不能直连网络**，
 * 要取数必须回 Host 半走网关（那条路有 permissions 闸门 + 审计日志）。
 * 其余放宽（inline / eval）是因为 iframe 本身已是完全不可信来源，
 * 真正的边界在进程与网关，不在这一层脚本策略上 —— 与其做一层会误伤打包器
 * 的严格策略，不如把边界做在**能审计的地方**。
 */
export const PLUGIN_VIEW_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' ${PLUGIN_SCHEME}:`,
  `style-src 'unsafe-inline' ${PLUGIN_SCHEME}:`,
  `img-src ${PLUGIN_SCHEME}: data: blob:`,
  `font-src ${PLUGIN_SCHEME}: data:`,
  `media-src ${PLUGIN_SCHEME}: data: blob:`,
  "connect-src 'none'",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

/* ============================================================
 * 目录收口（realpath + 前缀）
 * ============================================================ */

/**
 * 把插件目录 + 相对路径解析成**确实在目录内**的绝对路径。
 *
 * `realpath` 是必须的：光看字符串前缀挡不住 symlink 逃逸
 * （插件目录里放一个指向 `~/.ssh` 的软链即可）。手法沿用 `main/fs/guard.ts`。
 *
 * @returns 合法返回绝对路径；否则返回 null（调用方回 404 —— **不回 403**，
 *          避免把「目录里有什么/没有什么」变成可探测的信息）
 */
export function resolveInsidePlugin(dir: string, rel: string): string | null {
  if (!isSafeRelPath(rel)) return null
  try {
    const base = realpathSync(dir)
    const target = resolve(base, rel)
    if (!existsSync(target)) return null
    const real = realpathSync(target)
    const r = relative(base, real)
    if (r === '') return null // 目录本身不是可读资源
    if (r.startsWith('..') || isAbsolute(r) || r.split(sep).includes('..')) return null
    if (!statSync(real).isFile()) return null
    return real
  } catch {
    return null
  }
}

/* ============================================================
 * Handler
 * ============================================================ */
export interface PluginProtocolDeps {
  /** pluginId → 插件目录绝对路径（不在册 / 已卸载返回 undefined） */
  dirOf(pluginId: string): string | undefined
  logger?: { warn(scope: string, msg: string): void }
}

/**
 * 构造 `arkwork-plugin://` 的 handler（不依赖 electron，便于单测）。
 *
 * @returns 一个 `(Request) => Promise<Response>`；把它交给 `protocol.handle`
 */
export function createPluginAssetHandler(
  deps: PluginProtocolDeps,
): (req: { url: string }) => Promise<Response> {
  return async (req) => {
    const notFound = (): Response => new Response('not found', { status: 404, headers: noStore() })

    const ref = parsePluginAssetUrl(req.url)
    if (!ref) return new Response('bad request', { status: 400, headers: noStore() })

    const dir = deps.dirOf(ref.pluginId)
    if (!dir) {
      deps.logger?.warn('System', `[plugin] 协议请求了不在册的插件：${ref.pluginId}`)
      return notFound()
    }
    const abs = resolveInsidePlugin(dir, ref.rel)
    if (!abs) {
      // 记一条 warn 而不是静默 —— 「插件试图读目录外的东西」是值得知道的事实
      deps.logger?.warn('System', `[plugin:${ref.pluginId}] 拒绝越界的资源请求：${ref.rel}`)
      return notFound()
    }

    try {
      const buf = readFileSync(abs)
      const mime = mimeOf(abs)
      const headers: Record<string, string> = {
        ...noStore(),
        'Content-Type': mime,
        // opaque origin 的沙箱 iframe 取自己的资源也算跨域，必须显式放行
        'Access-Control-Allow-Origin': '*',
      }
      if (mime.startsWith('text/html')) headers['Content-Security-Policy'] = PLUGIN_VIEW_CSP
      return new Response(new Uint8Array(buf), { status: 200, headers })
    } catch (err) {
      deps.logger?.warn('System', `[plugin:${ref.pluginId}] 读取资源失败 ${ref.rel}：${String(err)}`)
      return notFound()
    }
  }
}

function noStore(): Record<string, string> {
  return { 'Cache-Control': 'no-store' }
}

/* ============================================================
 * 生产接线（electron）
 * ============================================================ */

/** 在 `app.whenReady()` 之前调用（`registerSchemesAsPrivileged` 的硬要求） */
export function registerPluginSchemePrivileges(): void {
  // 动态 import 避免本模块被 node:test 直接 import 时拉入 electron 的副作用
  void (async () => {
    const { protocol } = await import('electron')
    protocol.registerSchemesAsPrivileged([PLUGIN_SCHEME_PRIVILEGES as never])
  })()
}

/** 在 `app.whenReady()` 之后调用：把 handler 挂上 */
export async function registerPluginProtocol(deps: PluginProtocolDeps): Promise<void> {
  const { protocol } = await import('electron')
  const handler = createPluginAssetHandler(deps)
  try {
    protocol.handle(PLUGIN_SCHEME, (req) => handler(req))
  } catch (err) {
    deps.logger?.warn('System', `[plugin] 注册 ${PLUGIN_SCHEME}:// 失败：${String(err)}`)
  }
}

/** 视图入口 → iframe src（渲染层与主进程共用同一拼法，避免两处漂移） */
export function pluginAssetUrl(pluginId: string, rel: string): string {
  const safe = rel.replace(/^\/+/, '')
  return `${PLUGIN_SCHEME_PREFIX}${encodeURIComponent(pluginId)}/${safe}`
}
