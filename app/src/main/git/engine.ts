/* ============================================================
 * ArkWork — git 引擎解析（v0.36.0 · B3 / F3.5 · 决策 D86）
 * 设计文档：docs/versions/v0.36.0/04-system-design.md §3.5
 *
 * 一句话：**别让「git 从哪来」成为单点故障**。
 *
 * 为什么需要这一层（D86，实机驱动）：
 *  原设计把 git 执行完全托付给 dugite。但 dugite 的内嵌 git 是一份
 *  ~50MB 的 GitHub Release 二进制（postinstall 下载），实测在受限网络下
 *  拿不到 —— 此时「插件可用」这条验收线直接归零，且**用户毫无补救手段**。
 *  而 macOS / Linux / Windows 开发者机器上绝大多数已有系统 git。
 *  故把「引擎来源」显式化为三级解析链，任一级可用即能用：
 *
 *    ① 显式覆盖  ARKWORK_GIT_BIN=<git 可执行文件绝对路径>      （用户兜底，最高优先）
 *    ② dugite 内嵌  node_modules/dugite/git/…（随包发行版）      （跨平台行为一致）
 *    ③ 系统 git    PATH 查找 git / git.exe                      （实测兜底）
 *    ④ 都没有 → GitEngineUnavailableError（人话报错，不静默）
 *
 * 执行策略（与 dugite.exec 的分工）：
 *  本模块**只负责定位 git 发行版**，执行统一走自带 spawn —— 理由三条：
 *    ① 非交互保证：GIT_TERMINAL_PROMPT=0 + GIT_PAGER=cat，否则 push/pull
 *       在无凭据时会**永久挂起**（比报错更糟：用户看到的是「卡住」）；
 *    ② 超时可控：超时 kill 子进程，错误可解释；
 *    ③ 环境单点：GIT_EXEC_PATH / GIT_CONFIG_SYSTEM 等只在 dugite 发行版
 *       下注入（系统 git 注入反而会破坏其自身解析）。
 *  dugite 于是从「执行器」降级为「git 发行版载体」—— 语义更窄，反而更稳。
 * ============================================================ */
import { execFile } from 'node:child_process'
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { createRequire } from 'node:module'

export type GitEngineKind = 'dugite' | 'system'

export interface GitExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface GitEngine {
  kind: GitEngineKind
  /** git 可执行文件绝对路径（unresolved 时为 'git'） */
  binPath: string
  /** git 发行版根（dugite 形态才有；系统 git 无） */
  distRoot?: string
  exec(root: string, args: string[]): Promise<GitExecResult>
}

export class GitEngineUnavailableError extends Error {
  readonly code = 'E_GIT_ENGINE_UNAVAILABLE'
  constructor(message: string) {
    super(message)
    this.name = 'GitEngineUnavailableError'
  }
}

/** 默认单次 git 调用超时（本地 op 毫秒级；网络 op push/pull/fetch 给足） */
const LOCAL_TIMEOUT_MS = 30_000
const NETWORK_TIMEOUT_MS = 120_000
const NETWORK_OPS = new Set(['push', 'pull', 'fetch', 'clone', 'ls-remote'])

/**
 * 超时可覆盖：`ARKWORK_GIT_TIMEOUT_MS`。
 * 为什么留这个口子：巨型仓库的 `status`/`log` 可能远超 30s，企业网下
 * `fetch` 也可能远超 120s —— 硬编码常量会让「大仓用户」无解。默认值不变，
 * 只有显式设置时才生效（单测也用它把超时压到毫秒级）。
 */
function readTimeoutOverride(env: NodeJS.ProcessEnv): number | undefined {
  const raw = Number(env.ARKWORK_GIT_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : undefined
}

/* ------------------------------------------------------------
 * 执行：统一 spawn（非交互 + 超时 + 输出规整）
 * ------------------------------------------------------------ */

function spawnGit(
  binPath: string,
  distRoot: string | undefined,
  winGitSub: string | undefined,
  root: string,
  args: string[],
  timeoutOverrideMs?: number,
): Promise<GitExecResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // ① 非交互：无终端的 Electron 主进程里，凭据提示会变成永久挂起
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    // ② 稳定输出：不随用户 locale 变（porcelain 之外的 op 也稳）
    LC_ALL: 'C',
    // ③ 关掉「检测到默认分支名」之类的建议噪音（stderr 摘要更干净）
    GIT_ADVICE: '0',
  }
  if (distRoot) {
    // dugite 形态：exec-path / templates / system gitconfig 都在发行版内
    const gitCore = winGitSub
      ? join(distRoot, winGitSub, 'libexec', 'git-core')
      : join(distRoot, 'libexec', 'git-core')
    if (existsSync(gitCore)) env.GIT_EXEC_PATH = gitCore

    const sysCfg = join(distRoot, 'etc', 'gitconfig')
    if (process.platform !== 'win32' && existsSync(sysCfg)) env.GIT_CONFIG_SYSTEM = sysCfg

    const templates = join(distRoot, 'share', 'git-core', 'templates')
    if (existsSync(templates)) env.GIT_TEMPLATE_DIR = templates

    if (winGitSub) {
      env.PATH = `${join(distRoot, winGitSub, 'bin')}${delimiter}${join(distRoot, winGitSub, 'usr', 'bin')}${delimiter}${env.PATH ?? ''}`
    }
  }

  const timeout =
    timeoutOverrideMs ??
    (args.some((a) => NETWORK_OPS.has(a)) ? NETWORK_TIMEOUT_MS : LOCAL_TIMEOUT_MS)

  return new Promise<GitExecResult>((resolve, reject) => {
    execFile(
      binPath,
      args,
      // maxBuffer：diff/log/blame 在大仓里可能很大；16MB 兜底而不是 SIGKILL
      { cwd: root, env, timeout, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: string | number; killed?: boolean; signal?: string }) | null
        if (!e) {
          resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), exitCode: 0 })
          return
        }
        // 超时：execFile 以 killed=true + SIGKILL 结束
        if (e.killed || e.signal === 'SIGKILL' || e.code === 'ETIMEDOUT') {
          resolve({
            stdout: String(stdout ?? ''),
            stderr: `git 执行超时（${Math.round(timeout / 1000)}s）已终止：git ${args.slice(0, 2).join(' ')}`,
            exitCode: 124,
          })
          return
        }
        // 起不来（ENOENT / EACCES）：这不是「git 报错」，是引擎不可用 —— 上抛
        if (typeof e.code === 'string' && (e.code === 'ENOENT' || e.code === 'EACCES')) {
          reject(new GitEngineUnavailableError(`无法执行 git（${binPath}）：${e.message}`))
          return
        }
        // git 自身以非 0 退出：带 stdout/stderr 正常返回（由 service 判定）
        const code = typeof e.code === 'number' ? e.code : 1
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), exitCode: code })
      },
    )
  })
}

/* ------------------------------------------------------------
 * 定位：digite 内嵌 → 系统 PATH
 * ------------------------------------------------------------ */

function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false
    if (process.platform !== 'win32') accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** dugite 发行版根（若包在、且内嵌 git 二进制已就位） */
export function resolveDugiteRoot(requireCjs?: NodeRequire): string | null {
  try {
    const req = requireCjs ?? createRequire(import.meta.url)
    const pkgDir = dirname(req.resolve('dugite/package.json'))
    const root = join(pkgDir, 'git')
    const bin =
      process.platform === 'win32'
        ? join(root, 'cmd', 'git.exe')
        : join(root, 'bin', 'git')
    return isExecutableFile(bin) ? root : null
  } catch {
    return null
  }
}

function winGitSubfolder(): string | undefined {
  if (process.platform !== 'win32') return undefined
  if (process.arch === 'x64') return 'mingw64'
  if (process.arch === 'arm64') return 'clangarm64'
  return 'mingw32'
}

/** 系统 git：PATH 逐个目录探测（不 shell out —— 无 `which` 依赖） */
export function findSystemGit(pathEnv: string | undefined): string | null {
  const names = process.platform === 'win32' ? ['git.exe', 'git.cmd', 'git.bat'] : ['git']
  for (const dir of (pathEnv ?? '').split(delimiter)) {
    if (!dir) continue
    for (const n of names) {
      const cand = join(dir, n)
      if (isExecutableFile(cand)) return cand
    }
  }
  return null
}

/**
 * 解析链（纯函数式：env 注入便于单测；不缓存 —— 调用方按需 memo）。
 * 顺序：ARKWORK_GIT_BIN → dugite 内嵌 → 系统 git → 抛错
 */
export function resolveGitEngine(env: NodeJS.ProcessEnv = process.env, requireCjs?: NodeRequire): GitEngine {
  const tmo = readTimeoutOverride(env)

  /* ① 显式覆盖 */
  const override = (env.ARKWORK_GIT_BIN ?? '').trim()
  if (override) {
    if (!isExecutableFile(override)) {
      throw new GitEngineUnavailableError(
        `环境变量 ARKWORK_GIT_BIN 指向的文件不可执行：${override}`,
      )
    }
    return {
      kind: 'system',
      binPath: override,
      exec: (root, args) => spawnGit(override, undefined, undefined, root, args, tmo),
    }
  }

  /* ② dugite 内嵌发行版 */
  const dugiteRoot = resolveDugiteRoot(requireCjs)
  if (dugiteRoot) {
    const bin =
      process.platform === 'win32'
        ? join(dugiteRoot, 'cmd', 'git.exe')
        : join(dugiteRoot, 'bin', 'git')
    const sub = winGitSubfolder()
    return {
      kind: 'dugite',
      binPath: bin,
      distRoot: dugiteRoot,
      exec: (root, args) => spawnGit(bin, dugiteRoot, sub, root, args, tmo),
    }
  }

  /* ③ 系统 git */
  const sys = findSystemGit(env.PATH)
  if (sys) {
    return {
      kind: 'system',
      binPath: sys,
      exec: (root, args) => spawnGit(sys, undefined, undefined, root, args, tmo),
    }
  }

  /* ④ 无 */
  throw new GitEngineUnavailableError(
    '未找到可用的 git：既没有随包内嵌的 git，系统 PATH 里也没有 git。' +
      '请安装 git，或用环境变量 ARKWORK_GIT_BIN 指定 git 可执行文件路径。',
  )
}

/* ------------------------------------------------------------
 * 懒单例（§5 非功能设计：git 不在启动关键路径上）
 * ------------------------------------------------------------ */
let cached: { engine: GitEngine | null; error: Error | null } | null = null

/** 取得引擎；不可用时不抛，返回 null + 原因（调用侧决定如何报人话） */
export function getGitEngine(): { engine: GitEngine | null; error: Error | null } {
  if (!cached) {
    try {
      cached = { engine: resolveGitEngine(), error: null }
    } catch (e) {
      cached = { engine: null, error: e as Error }
    }
  }
  return cached
}

/** 测试用：重置单例（也用于「用户装了 git 后重试」） */
export function resetGitEngineCache(): void {
  cached = null
}
