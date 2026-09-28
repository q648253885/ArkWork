/* ============================================================
 * ArkWork — 宿主 git 服务（v0.36.0 · B3 / F3.5）
 * 设计文档：docs/versions/v0.36.0/04-system-design.md §3.5
 *
 * 一句话：插件能碰到的 git **只有这一张封闭白名单** —— 没有任意命令透传。
 *
 * 设计要点（每条都有边界依据）：
 *  ① **op 闭集**：读 7 + 写 13 共 20 个 op，参数逐个校验；白名单外的 op 直接拒
 *     （E_GIT_UNKNOWN_OP）—— 想做白名单外的事，请去申请 shell 权限走宿主弹窗。
 *  ② **repo 作用域恒为工作区根**：不给插件指定任意路径的能力；file 类参数
 *     必须落在工作区内（resolve 后前缀断言，挡 `../` 与绝对路径注入）。
 *  ③ **审批分层**：读免审批；写走权限模式 —— plan 一律拒、default/acceptEdits
 *     弹确认浮层、autoApprove/bypassPermissions 直行（与 shell 语义同源）。
 *     confirm 函数注入（宿主用 renderer 浮层；单测注入收集器）。
 *  ④ **审计**：写类 op 无论成败逐条落 `.arkwork/logs/git-audit.jsonl`。
 *  ⑤ **引擎三级解析链**（§5 非功能设计 + D86）：显式覆盖 → dugite 内嵌 →
 *     系统 git；git 不常用，故懒解析，不进启动关键路径。执行器可注入 →
 *     单测不依赖真 git 二进制（唯一例外 TC-GS-030 走真仓端到端）。
 * ============================================================ */
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  getGitEngine,
  GitEngineUnavailableError,
  type GitExecResult,
} from './engine.js'

export type { GitExecResult } from './engine.js'

/** 权限模式（与 agent/permission-mode.ts 同名值；此处只做审批分层） */
export type GitPermissionMode = 'default' | 'autoApprove' | 'acceptEdits' | 'plan' | 'bypassPermissions'

/** 读类 op：免审批、不审计 */
export const GIT_READ_OPS = [
  'status',
  'diff',
  'log',
  'show',
  'branch-list',
  'stash-list',
  'blame',
] as const

/** 写类 op：走权限模式 + 审计 */
export const GIT_WRITE_OPS = [
  'add',
  'reset',
  'commit',
  'amend',
  'branch-create',
  'branch-delete',
  'checkout',
  'stash-push',
  'stash-pop',
  'push',
  'pull',
  'fetch',
  'init',
] as const

export type GitReadOp = (typeof GIT_READ_OPS)[number]
export type GitWriteOp = (typeof GIT_WRITE_OPS)[number]
export type GitOp = GitReadOp | GitWriteOp

export const GIT_ALL_OPS: readonly GitOp[] = [...GIT_READ_OPS, ...GIT_WRITE_OPS]

/** 网关错误码（Host 半拿到后原样回显；supervisor 不做二次解释） */
export const GIT_E = {
  UNKNOWN_OP: 'E_GIT_UNKNOWN_OP',
  BAD_ARGS: 'E_GIT_BAD_ARGS',
  DENIED: 'E_GIT_DENIED',
  NO_WORKSPACE: 'E_GIT_NO_WORKSPACE',
  PATH_OUTSIDE: 'E_GIT_PATH_OUTSIDE',
  FAILED: 'E_GIT_FAILED',
  NOT_REPO: 'E_GIT_NOT_REPO',
} as const

export class GitError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly detail?: unknown,
  ) {
    super(message)
  }
}

export interface GitAuditSink {
  (entry: {
    pluginId: string
    op: GitOp
    args?: unknown
    root: string
    result: 'success' | 'failed' | 'denied'
    reason?: string
    timestamp: number
    durationMs?: number
  }): Promise<void>
}

export interface GitConfirmRequest {
  pluginId: string
  op: GitWriteOp
  /** 人话描述：`git commit -m "…"` 等 */
  summary: string
  /** 结构化影响（确认浮层的 impacts 列表） */
  impacts: string[]
  root: string
}

export interface GitServiceDeps {
  /** 工作区根（repo 唯一作用域）。缺省每次现场取（工作区可切换）。 */
  root?: () => string | undefined
  /** git 执行器（缺省走 git/engine.ts 的三级引擎链；测试注入桩） */
  exec?(root: string, args: string[]): Promise<GitExecResult>
  /** 权限模式（缺省恒 default → 写必弹确认；宿主接线接会话模式） */
  mode?(): Promise<GitPermissionMode>
  /** 写类 op 的确认浮层（缺省 = 一律拒绝 → 强制接线显式提供） */
  confirm?(req: GitConfirmRequest): Promise<{ allowed: boolean; reason?: string }>
  /** 审计出口（缺省 git/audit.ts；测试注入收集器） */
  audit?: GitAuditSink
  now?(): number
}

/** 各 op 的参数形状（人话描述 → 确认浮层 impacts；不是 JSON Schema） */
const OP_SUMMARY: Record<GitWriteOp, (a: GitArgs) => { summary: string; impacts: string[] }> = {
  add: (a) => ({ summary: `git add ${fmtFiles(a)}`, impacts: [`暂存文件：${fmtFiles(a)}`] }),
  reset: (a) => ({ summary: `git reset ${fmtFiles(a)}`, impacts: [`取消暂存：${fmtFiles(a)}`] }),
  commit: (a) => ({ summary: `git commit -m ${JSON.stringify(str(a.message))}`, impacts: [`提交暂存区内容，说明：${str(a.message)}`] }),
  amend: (a) => ({ summary: `git commit --amend`, impacts: ['改写最近一次提交（含说明与内容）'] }),
  'branch-create': (a) => ({ summary: `git branch ${str(a.name)}`, impacts: [`创建分支 ${str(a.name)}`] }),
  'branch-delete': (a) => ({ summary: `git branch -d ${str(a.name)}`, impacts: [`删除分支 ${str(a.name)}`] }),
  checkout: (a) => ({ summary: `git checkout ${str(a.ref)}`, impacts: [`切换到 ${str(a.ref)}（未提交改动可能受影响）`] }),
  'stash-push': (a) => ({ summary: `git stash push`, impacts: ['把当前改动收进 stash（工作区变干净）'] }),
  'stash-pop': (a) => ({ summary: `git stash pop`, impacts: ['恢复最近一次 stash（可能产生冲突）'] }),
  push: (a) => ({ summary: `git push ${str(a.remote, 'origin')} ${str(a.branch, '')}`.trim(), impacts: ['把本地提交推到远端'] }),
  pull: (a) => ({ summary: `git pull ${str(a.remote, 'origin')}`.trim(), impacts: ['拉取并合并远端改动（可能产生冲突）'] }),
  fetch: (a) => ({ summary: `git fetch ${str(a.remote, '')}`.trim(), impacts: ['获取远端最新引用（不改工作区）'] }),
  init: () => ({ summary: `git init`, impacts: ['在工作区根初始化新仓库'] }),
}

type GitArgs = Record<string, unknown>

export interface GitRunResult {
  op: GitOp
  /** 结构化输出（status/log/branch-list 等已解析；其余给 stdout 原文） */
  output: unknown
}

export function createGitService(deps: GitServiceDeps = {}) {
  const now = deps.now ?? (() => Date.now())
  const rootOf = deps.root ?? ((): string | undefined => undefined)

  /**
   * 缺省执行器：懒取单例引擎（§5：git 不进启动关键路径）。
   * 引擎不可用（没内嵌 git 也没系统 git）→ 一次性人话报错，带上补救手段
   * ——「用户毫无办法」比「功能缺失」更糟（D86）。
   */
  async function defaultExec(root: string, args: string[]): Promise<GitExecResult> {
    const { engine, error } = getGitEngine()
    if (!engine) {
      throw new GitError(GIT_E.FAILED, error?.message ?? '未找到可用的 git 引擎')
    }
    try {
      return await engine.exec(root, args)
    } catch (err) {
      if (err instanceof GitEngineUnavailableError) {
        throw new GitError(GIT_E.FAILED, err.message)
      }
      throw err
    }
  }

  const exec = deps.exec ?? defaultExec
  const audit = deps.audit
  const modeOf =
    deps.mode ??
    (async (): Promise<GitPermissionMode> => 'default')
  // 缺省 confirm = 拒绝（保守缺省：忘了接浮层时，写操作宁可不可用也不静默放行）
  const confirm = deps.confirm

  async function run(pluginId: string, op: string, rawArgs: unknown = {}): Promise<GitRunResult> {
    const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {}) as GitArgs

    // ① op 闭集
    if (!(GIT_ALL_OPS as readonly string[]).includes(op)) {
      throw new GitError(GIT_E.UNKNOWN_OP, `git 操作「${op}」不在白名单内`, {
        allowed: GIT_ALL_OPS,
      })
    }
    const opT = op as GitOp
    const isWrite = (GIT_WRITE_OPS as readonly string[]).includes(op)

    // ② repo 作用域
    const root = rootOf()
    if (!root) throw new GitError(GIT_E.NO_WORKSPACE, '当前没有打开的工作区，无法执行 git 操作')

    // ③ 参数校验 + 路径断言（file 类参数必须落在工作区内）
    //    统一前置 -c core.quotepath=false：git 默认把非 ASCII 路径转成
    //    八进制转义（\351\241...），中文文件名在面板里就成了乱码（B11/P3-a）。
    //    单点收敛在这里，而不是散到 20 个 op 各自加。
    const gitArgs = ['-c', 'core.quotepath=false', ...buildArgs(opT, args, root)]

    // ④ 审批（读直行；写按模式分层）
    if (isWrite) {
      const mode = await modeOf()
      const { summary, impacts } = OP_SUMMARY[opT as GitWriteOp](args)
      let allowed = true
      let denyReason = ''
      if (mode === 'plan') {
        allowed = false
        denyReason = '当前为 Plan 模式，禁止 git 写操作'
      } else if (mode !== 'autoApprove' && mode !== 'bypassPermissions') {
        if (!confirm) {
          allowed = false
          denyReason = 'git 写操作需要确认，但确认浮层未就绪'
        } else {
          const r = await confirm({ pluginId, op: opT as GitWriteOp, summary, impacts, root })
          allowed = r.allowed
          if (!r.allowed) denyReason = r.reason ?? '用户拒绝了该 git 写操作'
        }
      }
      if (!allowed) {
        await audit?.({
          pluginId, op: opT, args, root, result: 'denied', reason: denyReason,
          timestamp: now(),
        })
        throw new GitError(GIT_E.DENIED, denyReason)
      }
    }

    // ⑤ 执行
    const t0 = now()
    try {
      const out = await exec(root, gitArgs)
      const dur = now() - t0
      if (out.exitCode !== 0) {
        const detail = summarize(out.stderr || out.stdout)
        if (isWrite) {
          await audit?.({ pluginId, op: opT, args, root, result: 'failed', reason: detail, timestamp: now(), durationMs: dur })
        }
        throw new GitError(GIT_E.FAILED, `git ${op} 失败：${detail}`, { exitCode: out.exitCode })
      }
      if (isWrite) {
        await audit?.({ pluginId, op: opT, args, root, result: 'success', timestamp: now(), durationMs: dur })
      }
      return { op: opT, output: parseOutput(opT, out.stdout) }
    } catch (err) {
      if (err instanceof GitError) throw err
      const reason = `git ${op} 执行异常：${summarize(String(err))}`
      // 「写类 op 无论成败逐条落」—— 执行器抛异常也是失败，一样要审计
      if (isWrite) {
        await audit?.({ pluginId, op: opT, args, root, result: 'failed', reason, timestamp: now() })
      }
      throw new GitError(GIT_E.FAILED, reason)
    }
  }

  return { run, GIT_ALL_OPS, GIT_READ_OPS, GIT_WRITE_OPS }
}

export type GitService = ReturnType<typeof createGitService>

/* ============================================================
 * 参数构造（封闭形状：每个 op 只接受自己认识的字段）
 * ============================================================ */

function buildArgs(op: GitOp, a: GitArgs, root: string): string[] {
  const strOr = (v: unknown, d = ''): string => (typeof v === 'string' && v.trim() ? v.trim() : d)
  const numOr = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
  const inRoot = (rel: string): string => {
    // 只收工作区相对路径；绝对路径与 `..` 逃逸一律拒。
    // r === '' 表示 rel 就是工作区根本身（'' / '.' / './'）—— `git add -- .` 依赖它。
    if (isAbsolute(rel)) {
      throw new GitError(GIT_E.PATH_OUTSIDE, `路径「${rel}」必须是工作区相对路径`, { rel })
    }
    const r = relative(root, resolve(root, rel))
    // 注意用 `..${sep}` 而不是 startsWith('..')：名字以 `..` 开头的文件（如 `..foo`）是合法路径
    if (r === '..' || r.startsWith(`..${sep}`) || isAbsolute(r)) {
      throw new GitError(GIT_E.PATH_OUTSIDE, `路径「${rel}」不在工作区内`, { rel })
    }
    return (r ? join(root, r) : root).split(sep).join('/')
  }
  const files = (v: unknown, dflt: string[]): string[] => {
    // 缺省值同样要过路径断言（'.' → 工作区根的绝对路径），保证 exec 拿到的 file
    // 参数形状统一 —— 显式传 '.' 与缺省不该有两种形状。
    if (v === undefined) return dflt.map(inRoot)
    if (typeof v === 'string') return [inRoot(v)]
    if (Array.isArray(v) && v.every((x) => typeof x === 'string') && v.length > 0) {
      return (v as string[]).map((f) => inRoot(f))
    }
    throw new GitError(GIT_E.BAD_ARGS, 'files 必须是非空字符串或字符串数组')
  }

  switch (op) {
    /* ---- 读 ---- */
    case 'status':
      return ['status', '--porcelain=v1', '-b']
    case 'diff': {
      const args = ['diff', '--no-color']
      if (a.staged === true) args.push('--cached')
      if (typeof a.file === 'string' && a.file) args.push('--', inRoot(a.file))
      return args
    }
    case 'log': {
      const limit = Math.min(Math.max(Math.trunc(numOr(a.limit, 50)), 1), 200)
      return ['log', `--max-count=${limit}`, '--pretty=format:%H%x09%h%x09%an%x09%aI%x09%s']
    }
    case 'show':
      return ['show', '--no-color', '--stat', strOr(a.sha, 'HEAD')]
    case 'branch-list':
      return ['branch', '--list', '--all', '--format=%(refname:short)%09%(HEAD)']
    case 'stash-list':
      return ['stash', 'list', '--pretty=format:%gd%x09%aI%x09%s']
    case 'blame':
      return ['blame', '--porcelain', inRoot(assertStr(a.file, 'file'))]

    /* ---- 写 ---- */
    case 'add':
      return ['add', '--', ...files(a.files, ['.'])]
    case 'reset':
      return ['reset', '--', ...files(a.files, [])]
    case 'commit': {
      const msg = assertStr(a.message, 'message')
      return ['commit', '-m', msg]
    }
    case 'amend': {
      const msg = typeof a.message === 'string' && a.message.trim() ? a.message.trim() : null
      return msg ? ['commit', '--amend', '-m', msg] : ['commit', '--amend', '--no-edit']
    }
    case 'branch-create':
      return ['branch', assertStr(a.name, 'name'), ...(typeof a.from === 'string' && a.from ? [a.from] : [])]
    case 'branch-delete': {
      const force = a.force === true ? '-D' : '-d'
      return ['branch', force, assertStr(a.name, 'name')]
    }
    case 'checkout':
      return ['checkout', assertStr(a.ref, 'ref')]
    case 'stash-push':
      return typeof a.message === 'string' && a.message ? ['stash', 'push', '-m', a.message] : ['stash', 'push']
    case 'stash-pop':
      return ['stash', 'pop']
    case 'push': {
      const remote = strOr(a.remote, 'origin')
      const branch = strOr(a.branch, '')
      return branch ? ['push', remote, branch] : ['push', remote]
    }
    case 'pull': {
      const remote = strOr(a.remote, 'origin')
      const branch = strOr(a.branch, '')
      return branch ? ['pull', remote, branch] : ['pull', remote]
    }
    case 'fetch': {
      const remote = strOr(a.remote, '')
      return remote ? ['fetch', remote] : ['fetch']
    }
    case 'init':
      return ['init']
  }
}

function assertStr(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v.trim()) {
    throw new GitError(GIT_E.BAD_ARGS, `参数 ${field} 必填（非空字符串）`)
  }
  return v.trim()
}

function str(v: unknown, d = ''): string {
  return typeof v === 'string' && v.trim() ? v.trim() : d
}

function fmtFiles(a: GitArgs): string {
  if (a.files === undefined) return '.'
  if (typeof a.files === 'string') return a.files
  if (Array.isArray(a.files)) return (a.files as string[]).join(' ')
  return '?'
}

/** stderr 摘要（设计：截 500 字符；去 ANSI 噪声行首尾空白） */
function summarize(s: string): string {
  const t = (s ?? '').trim()
  return t.length > 500 ? `${t.slice(0, 500)}…` : t
}

/* ============================================================
 * 输出解析（给 Client 半/面板可直接渲染的结构）
 * ============================================================ */

export interface GitStatusEntry {
  x: string
  y: string
  path: string
  /** 重命名/复制的原路径（git status -z 的 R/C 第二段） */
  origPath?: string
}
export interface GitLogEntry {
  hash: string
  short: string
  author: string
  date: string
  subject: string
}
export interface GitBranchEntry {
  name: string
  current: boolean
}

function parseOutput(op: GitOp, stdout: string): unknown {
  switch (op) {
    case 'status': {
      // porcelain v1：`XY <path>`；R/C 后跟第二行原路径。用 NUL 分隔最稳，
      // 但 dugite stdout 拿到的就是文本；-z 与否由调用侧决定 —— 这里按 -z 前提解析不了，
      // 故退回逐行 + R/C 特判（status 行的路径不含换行，安全）。
      const entries: GitStatusEntry[] = []
      const lines = stdout.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        if (!line.trim()) continue
        if (line.startsWith('# ') || line.startsWith('## ')) continue // 分支行忽略（-b 的输出走 branch 解析）
        const x = line[0] ?? ' '
        const y = line[1] ?? ' '
        const path = line.slice(3)
        if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
          // porcelain v1（无 -z）的 rename 是**单行** `XY origPath -> newPath`；
          // 先按 ` -> ` 拆，拆不到再兜底取下一行（-z 形态 origPath 在独立段）。
          const arrow = path.indexOf(' -> ')
          if (arrow > 0) {
            entries.push({ x, y, path: path.slice(arrow + 4), origPath: path.slice(0, arrow) })
          } else {
            const orig = lines[++i] ?? ''
            entries.push({ x, y, path, origPath: orig.trim() })
          }
        } else {
          entries.push({ x, y, path })
        }
      }
      return { entries }
    }
    case 'log': {
      const entries: GitLogEntry[] = stdout
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => {
          const [hash, short, author, date, ...rest] = l.split('\t')
          return { hash: hash ?? '', short: short ?? '', author: author ?? '', date: date ?? '', subject: rest.join('\t') }
        })
      return { entries }
    }
    case 'branch-list': {
      const entries: GitBranchEntry[] = stdout
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => {
          const [name, head] = l.split('\t')
          return { name: name ?? '', current: head === '*' }
        })
      return { entries }
    }
    case 'stash-list': {
      const entries = stdout
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => {
          const [ref, date, ...rest] = l.split('\t')
          return { ref: ref ?? '', date: date ?? '', subject: rest.join('\t') }
        })
      return { entries }
    }
    default:
      return { stdout }
  }
}
