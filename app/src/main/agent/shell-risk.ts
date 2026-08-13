/* ============================================================
 * ArkWork — Shell 命令风险分级与重复检测（Task 5）
 *
 * 取代粗放的「限制 shell 动作频率」策略：
 *  1. classifyShellRisk：按命令模式识别 low / medium / high 三级风险，
 *     并检测目标路径是否越出当前 workspace。
 *  2. RepeatTracker：识别同一命令在短时间内对同一 cwd 的重复执行，
 *     超过阈值时提示用户确认（替代 doom_loop 的强制 ask）。
 *
 * 配合 shell-audit.ts 写入审计日志；shell.ts 据此决定放行 / 确认。
 * ============================================================ */
import { isAbsolute, relative, resolve } from 'node:path'
import { homedir } from 'node:os'

export type RiskLevel = 'low' | 'medium' | 'high'

export interface ShellRiskInfo {
  level: RiskLevel
  reason: string
  /** 命令涉及的写 / 删除目标路径（若可解析） */
  targetPath?: string
}

/* -------------------- 高危模式（强制确认） -------------------- */

interface HighPattern {
  re: RegExp
  reason: string
}

const HIGH_RISK_PATTERNS: HighPattern[] = [
  { re: /rm\s+-\w*(?:r\w*f|f\w*r)\w*\s+~(\/|\s|$)/, reason: 'rm -rf 删除用户主目录（灾难性）' },
  { re: /rm\s+-\w*(?:r\w*f|f\w*r)\w*\s+\$HOME(\b|$)/, reason: 'rm -rf 删除用户主目录（灾难性）' },
  { re: /mkfs(\.|\s|$)/, reason: 'mkfs 格式化文件系统（不可恢复）' },
  { re: /\bdd\s+[^|;&]*of=\/dev\//, reason: 'dd 写入设备文件（可能抹除磁盘）' },
  { re: /chmod\s+777\s+\/(?:\s|$)/, reason: 'chmod 777 修改根目录权限' },
  { re: /:\s*\(\)\s*\{\s*:\s*\|\s*:&\s*\}\s*;/, reason: 'fork bomb（会耗尽进程）' },
  { re: /\bshutdown\b/, reason: '关机命令' },
  { re: /\breboot\b/, reason: '重启命令' },
  { re: /\bhalt\b/, reason: '停机命令' },
  // sudo 涉及系统级目录修改
  {
    re: /\bsudo\b[^|;&\n]*\b\/(?:etc|usr|System|boot|bin|sbin|lib|var)(?:\/|\b|$)/,
    reason: 'sudo 修改系统级目录（/etc、/usr、/System 等）',
  },
  // sudo 本身即特权提升，统一按高危确认
  { re: /\bsudo\b/, reason: 'sudo 以管理员权限执行（可能影响系统）' },
]

/** rm -rf / （根目录）单独判定：flags 含 r 与 f，目标为 / */
function isRmRfRoot(command: string): boolean {
  return /rm\s+-\w*(?:r\w*f|f\w*r)\w*\s+\/(?:\s|$)/.test(command)
}

/* -------------------- 中危模式（workspace 内放行+审计，越界确认） -------------------- */

interface MediumPattern {
  re: RegExp
  reason: string
}

const MEDIUM_RISK_PATTERNS: MediumPattern[] = [
  { re: /\bsed\s+(-\w+\s+)*--?i\b|sed\s+-\w*i\w*\b/, reason: 'sed -i 原地改写文件' },
  { re: /\bfind\b[^|;&\n]*-exec\b/, reason: 'find -exec 批量执行' },
  { re: /\bfind\b[^|;&\n]*-delete\b/, reason: 'find -delete 批量删除' },
  { re: /\b(?:curl|wget)\b[^|;&\n]*\|\s*(?:bash|sh|zsh)\b/, reason: '网络下载脚本直接执行（curl|bash）' },
  { re: /\bdocker\s+system\s+prune\b/, reason: 'docker system prune 清理大量资源' },
  { re: /\bnpm\s+publish\b/, reason: 'npm publish 发布到仓库' },
  { re: /\bgit\s+push\s+[^|;&]*(-f\b|--force\b|--force-with-lease\b)/, reason: 'git push --force 强推覆盖远程' },
  // 破坏性但非灾难级：rm / rmdir / chmod / chown（非根、非主目录的常规删除与权限修改）
  { re: /\brm\b/, reason: '删除文件或目录' },
  { re: /\brmdir\b/, reason: '删除目录' },
  { re: /\bchmod\b/, reason: '修改文件权限' },
  { re: /\bchown\b/, reason: '修改文件所有者' },
]

/* -------------------- 路径解析工具 -------------------- */

/** 重定向目标是否为无副作用设备 / fd 复制 */
function isHarmlessRedirectTarget(target: string): boolean {
  if (/^&/.test(target)) return true
  if (/^\/dev\/(?:null|zero|stdin|stdout|stderr)(?:\s|$)/.test(target)) return true
  if (/^\/dev\/fd\/\d+/.test(target)) return true
  return false
}

/** 解析输出重定向目标路径 */
function extractRedirectTarget(command: string): string | null {
  const m = command.match(/(?:>>|>)\s*("([^"]+)"|'([^']+)'|(\S+))/)
  if (!m) return null
  return m[2] ?? m[3] ?? m[4] ?? null
}

/** 判断路径是否落在 workspaceDir 之外（绝对 / 相对路径都解析） */
export function isOutsideWorkspace(p: string, workspaceDir: string): boolean {
  if (!p || !workspaceDir) return false
  const abs = isAbsolute(p) ? p : resolve(workspaceDir, p)
  const rel = relative(workspaceDir, abs)
  return rel.startsWith('..') || rel.startsWith('/')
}

/** 判断路径是否落在用户主目录之外 */
function isOutsideHome(p: string): boolean {
  if (!p) return false
  const home = homedir()
  if (!home) return false
  const abs = isAbsolute(p) ? p : resolve(home, p)
  const rel = relative(home, abs)
  return rel.startsWith('..') || rel.startsWith('/')
}

/**
 * 解析命令中涉及的写 / 删除目标路径（重定向目标或路径参数）。
 * 仅返回第一个看起来像路径的 token，用于越界判定。
 */
function extractTargetPath(command: string, workspaceDir: string): string | undefined {
  // 1. 重定向目标
  const redirect = extractRedirectTarget(command)
  if (redirect && !isHarmlessRedirectTarget(redirect)) {
    return redirect.replace(/^["']|["']$/g, '')
  }
  // 2. 路径参数：跳过选项 / 环境变量赋值 / 管道符 / sed 表达式
  const tokens = command.split(/\s+/).filter(Boolean)
  for (const tok of tokens) {
    if (tok.startsWith('-')) continue
    if (/^[A-Z_]+=/.test(tok)) continue
    if (tok === '|' || tok === '&&' || tok === ';' || tok === '||') continue
    // sed 替换表达式 s/.../.../ 、y/.../.../
    if (/^[sy]:?\/.*\/.*\/[a-z]*$/i.test(tok)) continue
    // polish7 修复：引号包裹的 sed 表达式（如 '"s/a/b/"'）也必须跳过，
    // 否则会被误判为路径 token，导致越界升级失效。
    if (/^['"][sy]:?\/.*\/.*\/[a-z]*['"]$/i.test(tok)) continue
    // 引号包裹的非路径表达式（如 's/a/b/' 不带引号的边界也会被前一行覆盖；此处仅放行真路径）
    if (/^['"].*\/.*['"]$/.test(tok) && !/^[/'"]/.test(tok.replace(/^['"]|['"]$/g, ''))) {
      // 仍可能是路径，交给后续路径特征判定
    }
    const stripped = tok.replace(/^["']|["']$/g, '')
    if (!stripped) continue
    // 只把「像路径」的 token 当作目标：绝对路径、含分隔符、带扩展名
    const looksLikePath =
      isAbsolute(stripped) ||
      stripped.includes('/') ||
      /^\.\.?\//.test(stripped) ||
      /\.[a-z]{1,5}$/i.test(stripped)
    if (!looksLikePath) continue
    void workspaceDir
    return stripped
  }
  return undefined
}

/* -------------------- classifyShellRisk -------------------- */

/**
 * 评估一条 shell 命令的风险等级（low / medium / high）。
 *
 * 判定顺序：
 *  1. 高危模式（rm -rf /、mkfs、dd of=/dev、sudo、fork bomb 等）→ high
 *  2. 中危模式（sed -i、find -delete、curl|bash、rm、chmod 等）→ medium
 *  3. 其余 → low（只读 / 非破坏性）
 *  4. 目标路径越界：中危命令的目标路径超出 workspaceDir 时升级为 high；
 *     高危命令的目标超出用户主目录时标记越界。
 *
 * @param command 命令原文
 * @param cwd 命令执行目录（保留参数，当前不参与判定）
 * @param workspaceDir 工作区根目录，用于越界判定
 */
export function classifyShellRisk(
  command: string,
  cwd?: string,
  workspaceDir?: string,
): ShellRiskInfo {
  void cwd
  const trimmed = (command ?? '').trim()
  if (!trimmed) {
    return { level: 'low', reason: '空命令' }
  }

  const ws = workspaceDir ?? ''

  // 1. 高危模式
  if (isRmRfRoot(trimmed)) {
    return { level: 'high', reason: 'rm -rf 删除根目录（灾难性）' }
  }
  for (const { re, reason } of HIGH_RISK_PATTERNS) {
    if (re.test(trimmed)) {
      const targetPath = extractTargetPath(trimmed, ws)
      return { level: 'high', reason, targetPath }
    }
  }

  // 2. 中危模式
  let mediumHit: MediumPattern | undefined
  for (const p of MEDIUM_RISK_PATTERNS) {
    if (p.re.test(trimmed)) {
      mediumHit = p
      break
    }
  }

  if (mediumHit) {
    const targetPath = extractTargetPath(trimmed, ws)
    // 中危命令目标越出 workspace → 升级为高危
    if (targetPath && ws && isOutsideWorkspace(targetPath, ws)) {
      return {
        level: 'high',
        reason: `${mediumHit.reason}（目标超出工作区：${targetPath}）`,
        targetPath,
      }
    }
    // rm -rf 目标越出用户主目录 → 升级为高危（大批量删除）
    if (targetPath && /\brm\s+-\w*(?:r\w*f|f\w*r)/.test(trimmed) && isOutsideHome(targetPath)) {
      return {
        level: 'high',
        reason: `${mediumHit.reason}（目标超出用户主目录：${targetPath}）`,
        targetPath,
      }
    }
    return { level: 'medium', reason: mediumHit.reason, targetPath }
  }

  // 3. 低危（默认）
  return { level: 'low', reason: '只读 / 非破坏性操作' }
}

/* ============================================================
 * RepeatTracker — 同命令同 cwd 短时间重复执行检测
 *
 * 替代 doom_loop 的粗放频率限制：
 *  - 记录最近 windowMs（默认 5 分钟）内同一命令在同一 cwd 下的执行次数
 *  - 超过阈值（默认 3 次）时 isRepeat=true，由 shell.ts 提示用户确认
 *  - 内部 Map 存储，定期清理过期记录
 * ============================================================ */

export interface RepeatCheckResult {
  /** 是否超过阈值（本次计入后 count > threshold） */
  isRepeat: boolean
  /** 窗口内累计执行次数（含本次） */
  count: number
  /** 窗口内存在先前记录 */
  withinWindow: boolean
}

export class RepeatTracker {
  private readonly windowMs: number
  private readonly threshold: number
  private readonly records: Map<string, number[]>
  private cleaner: NodeJS.Timeout | null = null

  constructor(opts?: { windowMs?: number; threshold?: number }) {
    this.windowMs = opts?.windowMs ?? 5 * 60 * 1000
    this.threshold = opts?.threshold ?? 3
    this.records = new Map()
  }

  /** 记录本次执行并返回窗口内的重复情况 */
  checkRepeat(command: string, cwd?: string): RepeatCheckResult {
    const now = Date.now()
    const key = this.key(command, cwd)
    const fresh = (this.records.get(key) ?? []).filter((ts) => now - ts < this.windowMs)
    fresh.push(now)
    this.records.set(key, fresh)
    const count = fresh.length
    return {
      isRepeat: count > this.threshold,
      count,
      withinWindow: count >= 2,
    }
  }

  /** 清理所有过期记录 */
  cleanup(): void {
    const now = Date.now()
    for (const [k, arr] of this.records) {
      const fresh = arr.filter((ts) => now - ts < this.windowMs)
      if (fresh.length === 0) this.records.delete(k)
      else this.records.set(k, fresh)
    }
  }

  /** 启动定期清理（unref，不阻止进程退出） */
  startPeriodicCleanup(intervalMs = 5 * 60 * 1000): void {
    if (this.cleaner) return
    this.cleaner = setInterval(() => this.cleanup(), intervalMs)
    this.cleaner.unref?.()
  }

  /** 重置全部记录（测试用） */
  reset(): void {
    this.records.clear()
  }

  private key(command: string, cwd?: string): string {
    return `${(command ?? '').trim().replace(/\s+/g, ' ')}@${cwd ?? ''}`
  }
}

/** shell.ts 使用的全局单例 */
export const repeatTracker = new RepeatTracker()
repeatTracker.startPeriodicCleanup()
