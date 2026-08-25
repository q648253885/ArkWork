/* ============================================================
 * ArkWork — 命令权限分级（v0.14.0 Task 6 · 最终版）
 *
 * 本文件是 shell 命令权限判定的【唯一权威】入口：
 *  - registry.invokeSkill 对 shell 只调用 assessCommandRisk
 *  - skills/shell.ts 的 assessShellCommand 改为本文件的兼容委托
 *    （旧 3 级 safe/confirm/reject 由本文件 5 级映射而来）
 *
 * 设计目标：替代「任何 shell 命令都需确认」式的统一默认，
 * 对接 GitHub Copilot CLI / OpenAI Codex 的 permission-model 思路：
 *  - workspace-readonly：工作区内只读命令（ls / cat / grep / tree / du / stat / wc / head / tail ...）
 *  - external-readonly：工作区外的只读查询（ping / nslookup / dig / curl -I / uname / sw_vers / date ...）
 *  - workspace-light-write：工作区内的轻度写（mkdir / touch / cp / mv / ln / git commit / > 重定向到工作区内）
 *  - high-risk：其他写 / 网络写 / 系统写（rm / chmod / sudo / kill / npm install / git push ...）
 *  - reject：命中黑名单，直接拒绝
 *
 * 风险等级与 UI 行为映射：
 *  - workspace-readonly / external-readonly → policy=allow：直接放行，
 *    不弹确认、不报「用户拒绝」
 *  - workspace-light-write → policy=light-confirm：首次会话确认一次后
 *    记住选择（本会话内不再弹）
 *  - high-risk → policy=confirm：每次都走 ConfirmDialog
 *  - reject → 拒绝并报错
 *
 * 误报「用户拒绝」修复要点：
 *  1. 只读命令（含 find 带路径参数 / grep -r 等常见形式）在最早阶段
 *     落入 allow，根本不进入确认链路。
 *  2. git 只读子命令（status/log/diff/show 等）在「轻写」之前判定，
 *     避免被 \bgit\s+(status|...) 轻写模式截胡成需要确认。
 *  3. > / >> 重定向独立分析：/dev/null、2>&1 等无副作用重定向跳过；
 *     写工作区内 → 轻写；写工作区外 → 高风险。不再用 /\b>|>>/ 一刀切。
 *  4. 只读主命令 + 链式写操作（`ls && mkdir x`、`git status && git commit`）
 *     通过 WRITE_SIGNAL_PATTERNS 升级为 light-confirm / confirm。
 *  5. 确认结果区分 denied / dismissed / timeout：只有用户显式点击
 *     「拒绝」才标记为「用户拒绝执行」；对话框被关闭或超时不算。
 * ============================================================ */
import { isAbsolute, relative, resolve } from 'node:path'
import { MODE_POLICIES, type PermissionMode } from './permission-mode.js'
import { lightConfirmMemory } from './light-confirm-memory.js'
import { detectDoomLoop } from './doom-loop.js'
import { matchRule, type Rule } from './rules.js'

export type CommandRiskLevel =
  | 'workspace-readonly'
  | 'external-readonly'
  | 'workspace-light-write'
  | 'high-risk'
  | 'reject'

/** 内置拒绝：黑名单（shell.ts 运行时防御与 registry 共用本单一来源） */
export const REJECT_PATTERNS: RegExp[] = [
  /rm\s+-rf\s+\/(\s|$)/,
  /rm\s+-rf\s+~(\/|\s|$)/,
  /rm\s+-rf\s+\*(\s|$)/,
  /:\(\)\s*\{\s*:\s*\|\s*:&\s*\}\s*;/,
  /mkfs(\.|\s)/,
  /\bdd\s+.*of=\/dev\//,
  /shutdown(\s|$)/,
  /reboot(\s|$)/,
  /halt(\s|$)/,
  /\binit\s+0(\s|$)/,
  />\s*\/dev\/sd[a-z]/,
  /\bmv\s+.*\s+\/\s*$/,
  // polish7：与 shell-risk.ts 黑名单对齐
  /chmod\s+777\s+\//,
]

/** 工作区内只读主命令（不写磁盘、不发网络；cd 在 spawn 的子 shell 中无持久副作用） */
const WORKSPACE_READONLY_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'less', 'more', 'grep', 'rg', 'find', 'wc',
  'sort', 'uniq', 'diff', 'file', 'stat', 'tree', 'du', 'pwd', 'cd',
  // polish7：纯输出 / 哈希 / 路径处理命令，与 echo 同样归 workspace-readonly
  'echo', 'printf', 'md5sum', 'sha1sum', 'sha256sum', 'sha512sum',
  'basename', 'dirname', 'readlink', 'realpath',
])

/** git 只读子命令（在工作区内归 workspace-readonly） */
const GIT_READONLY_RE = /\bgit\s+(status|log|diff|show|branch\s+--list|remote\s+-v|config\s+--(get|list))\b/

/**
 * 文本处理命令的「只读形式」主命令。
 * 仅当以这些主命令开头，且不含已知的写动作开关时，归为 workspace-readonly。
 * - sed：默认打印输出（`-n`/`-e`/`-E`/`-l` 等都是只读）。`-i` / `--in-place` 显式原地改写，
 *   已落入 WORKSPACE_LIGHT_WRITE_PATTERNS（与 mkdir/cp/mv 同级），无需在此匹配。
 * - awk：默认纯文本流处理，不修改输入文件。`awk '... system(...)'` 会执行子命令，但保守起见
 *   此处只放行主命令以 awk 开头的情形，不阻断含 system() 的写法——后者会自然被高风险规则覆盖
 *   （`/bawk\b.*\bsystem\(/` 由高风险兜底的可控性较差，且大部分 awk 脚本只是文本处理，频繁
 *   confirm 会拖累体验；改在「写信号升级」机制中处理）。
 * - perl：`-ne` / `-pe` 是「按行执行」的标准只读形式；`-i` / `-i.bak` 同样原地改写，
 *   与 sed -i 一样由 light-write 路径识别。
 *
 * 注意：本匹配只是「先于轻写 / 兜底高风险」的快速放行路径——
 *   - 输出重定向（> / >> 到非 /dev/null）在流水线第 3 步单独分析；
 *   - 危险主命令（sudo / rm / chmod 等）仍由黑名单 / 高风险模式兜底。
 */
const TEXT_PROCESSING_READONLY_BASES = new Set(['sed', 'awk', 'gawk', 'nawk', 'perl'])

/** 工作区外只读查询：网络探测 / 系统信息查询（不写） */
const EXTERNAL_READONLY_COMMANDS = new Set([
  'ping', 'nslookup', 'dig', 'host', 'traceroute', 'mtr',
  'uname', 'sw_vers', 'hostname', 'whoami', 'id', 'uptime', 'date', 'cal',
  'ps', 'top', 'htop', 'free', 'df', 'pstree', 'lsof', 'netstat', 'ss', 'ifconfig', 'ip',
  'env', 'printenv', 'which', 'whereis', 'type', 'readlink', 'dirname', 'basename',
  'getent', 'history', 'echo', 'printf',
  'curl',  // 仅 -I / --head / -s + GET 才算只读；-o / -O / --output 已被 high-risk 截获
  // v0.16.6+：node 跑脚本视为"可控副作用的只读执行"——若脚本有重定向/写文件，会被流水线第 3 步独立拦截。
  // 把 node 放进白名单可让 Agent 跑 CDP 测试脚本（node _smoke_test.mjs）等无需 60s 确认。
  // 真危险写法（node -e '...rm...'）仍由 OUTPUT_REDIRECT 路径独立捕获。
  'node',
])

/** 工作区内轻度写（低风险，首次确认后本会话记住） */
const WORKSPACE_LIGHT_WRITE_PATTERNS: RegExp[] = [
  /\bmkdir\b/,
  /\btouch\b/,
  /\bcp\b/,
  /\bmv\b/,
  /\bln\b/,
  /\bgit\s+(add|commit|branch|stash|diff|status|log|show|remote|config|mv|switch\s+-c)\b/,
  /\bnpm\s+(run|test|build|start|dev|lint|format|preview)\b/,
  /\byarn\s+(run|test|build|start|lint|format)\b/,
  /\bpnpm\s+(run|test|build|start|lint)\b/,
  /\bnode\s+[\w./-]+\.(js|mjs|cjs|ts)\b/,
  /\bpython3?\s+[\w./-]+\.py\b/,
  /\bdeno\s+run\b/,
  // Task 6：sed -i / tee 等同属工作区内「原地改写」，与 mkdir/cp/mv 同级
  // 仅当目标文件落 workspace 内 → 视为轻写；越出 workspace 仍由路径/重定向分析兜底为 high-risk
  /\bsed\s+-i\b/,
  /\btee\b/,
]

/**
 * 「存在写操作」的信号模式（不含 git 只读子命令），用于：
 * 只读主命令 + 链式写操作（如 `ls && mkdir x`、`git status && git commit`）
 * 时把命令从 allow 升级为 light-confirm / confirm，避免写操作漏过确认。
 * 注意：重定向 `>` / `>>` 不在此列 —— 由 assessCommandRisk 第 3 步
 * 单独分析（/dev/null、2>&1 等无害目标跳过；写工作区内 → 轻写）。
 */
const WRITE_SIGNAL_PATTERNS: RegExp[] = [
  /\bmkdir\b/, /\btouch\b/, /\bcp\b/, /\bmv\b/, /\bln\b/,
  /\bnpm\s+(run|test|build|start|dev|lint|format|preview)\b/,
  /\byarn\s+(run|test|build|start|lint|format)\b/,
  /\bpnpm\s+(run|test|build|start|lint)\b/,
  /\bnode\s+[\w./-]+\.(js|mjs|cjs|ts)\b/,
  /\bpython3?\s+[\w./-]+\.py\b/,
  /\bdeno\s+run\b/,
  /\bgit\s+(add|commit|stash|mv|switch\s+-c)\b/,
]

/** 高风险：删除/系统写/网络写/包安装（重定向 > 由 extractRedirectTarget 单独分析，不在此列） */
const HIGH_RISK_PATTERNS: RegExp[] = [
  // 删除/覆盖/权限/链接（不可逆或可破坏数据）
  // 注：sed -i / tee 已从 HIGH 默认列表移除（v0.15.0 Task 6 修复）—— 与 mkdir/cp/mv 同级视作工作区内轻写，
  // 由 extractArgPaths + isInsideWorkspace 兜底：参数路径越出 workspace → 仍按 high-risk 处理
  /\brm\b/, /\brmdir\b/, /\bchmod\b/, /\bchown\b/,
  /\bunlink\b/, /\bxattr\b/, /\bdefaults\s+write\b/,
  // 包管理/安装（改 lockfile 或系统环境）
  /\bnpm\s+(i|install|add|remove|rm|uninstall|ci|update)\b/,
  /\byarn\s+(add|remove|install)\b/, /\bpnpm\s+(add|remove|install)\b/,
  /\bpip\s+install\b/, /\bpip3\s+install\b/, /\bbrew\s+(install|uninstall|upgrade)\b/,
  /\bnpx\s+[a-z@-]+\s*(--|$)/, /\bcargo\s+(build|install|publish|add)\b/,
  /\bgo\s+(build|install|mod\s+(tidy|download))\b/,
  // git 危险子命令（推送/历史改写/丢弃工作区）
  /\bgit\s+(push|pull|reset|rebase|merge|checkout|tag|fetch|clean|rm|restore|filter-branch|clone)\b/,
  // 进程/系统
  /\bkill\b/, /\bpkill\b/, /\bkillall\b/, /\bsudo\b/,
  /\bsystemctl\s+(start|stop|restart|enable|disable|daemon-reload)\b/,
  /\bservice\s+\w+\s+(start|stop|restart)\b/,
  /\bapt\s+(install|remove|purge|update|upgrade)\b/, /\bdnf\s+(install|remove|update)\b/,
  // 网络写/传输/下载到磁盘
  /\bcurl\s+.*(-o|--output|--create-dirs|-O)/, /\bwget\b/, /\bscp\b/, /\brsync\b/, /\bsftp\b/,
  // polish7：curl|bash / wget|bash / curl URL | sh 等直接管道执行网络内容（远程代码执行）
  /\b(?:curl|wget)\b[^|;&\n]*\|\s*(?:bash|sh|zsh|ksh)\b/,
  // 其他有副作用的系统级操作
  /\bshutdown\b/, /\breboot\b/, /\bdd\b/, /\bmkfs/, /\bopen\s+-a\b/, /\bunzip\b/, /\btar\s+-x\b/,
]

/**
 * v0.15.0：受保护路径写确认。
 * 任何对以下路径的写操作都强制 confirm，覆盖前面的 allow 决策。
 * 注意 git commit 不算写 .git（通过 git CLI 改 index）；直接 Write(.git/HEAD) 才触发。
 */
export const PROTECTED_PATHS: RegExp[] = [
  /(?:^|\/)\.git\/.+/,
  /(?:^|\/)\.arkwork\/.+/,
  /(^|\/)\.env(\.|$)/,
  /(^|\/)\.env\..+/,
  /(^|\/)\.gitignore$/,
  /(^|\/)secrets\/.+/,
  /(^|\/)\..*\.pem$/,
  /(^|\/)\..*\.key$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)yarn\.lock$/,
  // v0.17.x：工作区根目录 tasks.json 是 ArkWork 自身的任务存储，Agent 误写为
  // 自建清单会覆盖任务列表并导致 store 解析崩溃（items.findIndex）。禁止写入。
  /(?:^|\/)tasks\.json$/,
]

/** v0.15.0：判定命令是否对受保护路径有写动作（含链式重定向 / 重定向目标） */
function touchesProtectedPath(command: string, cwd: string, workspaceDir: string): boolean {
  const trimmed = command.trim()
  const effective = trimmed.replace(/^(?:cd\s+\S+\s*(?:&&|;)\s*)+/, '').trim() || trimmed
  const tokens = effective.split(/\s+/).filter(Boolean)
  for (const t of tokens) {
    if (t.startsWith('-')) continue
    if (/^[A-Z_]+=/.test(t)) continue
    const stripped = t.replace(/^["']|["']$/g, '')
    if (!stripped) continue
    const abs = isAbsolute(stripped) ? stripped : resolve(workspaceDir || cwd, stripped)
    if (PROTECTED_PATHS.some((re) => re.test(abs))) return true
  }
  // 重定向目标（新版 extractRedirectTarget 已内置 fd 复制 / 设备文件排除，返回 null 即跳过）
  const redirect = extractRedirectTarget(effective)
  if (redirect) {
    const abs = isAbsolute(redirect) ? redirect : resolve(workspaceDir || cwd, redirect)
    if (PROTECTED_PATHS.some((re) => re.test(abs))) return true
  }
  return false
}

export interface RiskAssessment {
  level: CommandRiskLevel
  /** 该等级对应的 UI 行为：'allow' = 静默通过；'light-confirm' = 首次确认后记住；'confirm' = 每次都问 */
  policy: 'allow' | 'light-confirm' | 'confirm'
  impacts: string[]
  /** 解析出的主命令（用于 UI 展示） */
  base: string
}

/** 提取一条命令的「主命令」：剥离 sudo / 路径前缀 / 引号 */
export function baseCommand(command: string): string {
  const trimmed = command.trim()
  const first = trimmed.split(/[\s|;&()]+/)[0] ?? ''
  return first.replace(/^sudo\s+/, '').split('/').pop() ?? ''
}

/** 解析命令中出现的文件参数（简化：取所有非选项的剩余 token） */
function extractArgPaths(command: string): string[] {
  const trimmed = command.trim()
  // 去掉前导 sudo / env / 主命令
  const tokens = trimmed.split(/\s+/).filter(Boolean)
  const out: string[] = []
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.startsWith('-')) continue // 选项
    if (/^[A-Z_]+=/.test(t)) continue // VAR=val
    if (t === '|') continue
    out.push(t.replace(/^["']|["']$/g, ''))
  }
  return out
}

/** 判断路径是否落在 workspaceDir 内（绝对路径或相对路径都解析） */
function isInsideWorkspace(p: string, workspaceDir: string): boolean {
  if (!p) return false
  const abs = isAbsolute(p) ? p : resolve(workspaceDir, p)
  const rel = relative(workspaceDir, abs)
  return !rel.startsWith('..') && !rel.startsWith('/')
}

/**
 * 提取「输出重定向到文件」的目标路径。命中条件：
 *   - 包含 `>` 或 `>>`（不含 `2>&1`、`>&2`、`&>` 等 fd 复制 / 设备路径）
 *   - 目标不是设备文件（`/dev/null`、`/dev/zero`、`/dev/urandom` 等）
 *   - 不含 heredoc 语法干扰（`<< EOF` 仅是输入源，与 `>` 配合时仍以 `>` 后的路径为准）
 *
 * 返回：去除引号后的目标路径字符串；不命中返回 null。
 *
 * 示例：
 *   `cat > docs/README.md`                  → 'docs/README.md'
 *   `echo hello >> a.log`                   → 'a.log'
 *   `cat << 'EOF' > file.txt`               → 'file.txt'
 *   `echo > /dev/null`                      → null（设备文件）
 *   `cmd 2>&1`                              → null（fd 复制）
 *   `echo > /etc/passwd`                    → '/etc/passwd'（调用方再判断越界）
 */
function extractRedirectTarget(command: string): string | null {
  // 先去掉 heredoc 块（`<< EOF ... EOF`）—— heredoc 是输入源，不影响输出目标
  const stripped = command.replace(/<<\s*[<'"]?[\w-]+[>'"]?(?:\s*\S*)?[\s\S]*?(?=\n\S|$)/g, '')
  // 匹配 `>` / `>>`，排除 `>&` / `2>&` / `&>`（fd 复制或追加到 fd）
  const m = stripped.match(/(?<![&<>0-9])\s*>>?\s*([^\s|&<>]+)/)
  if (!m) return null
  const target = m[1].replace(/^["']|["']$/g, '')
  if (!target) return null
  // 设备文件 / 特殊 fd → 不算"写入工作区文件"
  // polish7 修复：/tmp 是普通目录（不是 /dev/null 那种设备文件），写入 /tmp
  // 是越界工作区外 → 应判 high-risk 而不是 null 跳过。之前误把 /tmp 当设备。
  if (/^\/(?:dev\/|proc\/|sys\/)/.test(target)) return null
  // 纯数字 fd → 不算文件路径
  if (/^\d+$/.test(target)) return null
  // 形如 `&1` / `&2` 等 fd 引用
  if (/^&[0-9]+$/.test(target)) return null
  return target
}

/**
 * 评估一条 shell 命令的风险等级 + UI 策略（唯一权威入口）。
 * @param command - 命令原文
 * @param workspaceDir - 工作区根目录，用于判断「工作区内」；为空时
 *                       相对路径按进程 cwd 解析（仅影响路径判定，不影响主命令白名单）
 */
export function assessCommandRisk(
  command: string,
  workspaceDir: string,
): RiskAssessment {
  const trimmed = command.trim()
  if (!trimmed) {
    return { level: 'reject', policy: 'confirm', impacts: ['空命令'], base: '' }
  }
  // 0. 剥离开头 cd 链（`cd src && ls` / `cd a; cd b && cmd`）后只评估主体
  const effective = trimmed.replace(/^(?:cd\s+\S+\s*(?:&&|;)\s*)+/, '').trim() || trimmed
  // 1. 黑名单 → reject
  for (const re of REJECT_PATTERNS) {
    if (re.test(effective)) {
      return {
        level: 'reject',
        policy: 'confirm',
        impacts: ['命令命中安全策略黑名单（高危操作，禁止执行）'],
        base: baseCommand(effective),
      }
    }
  }
  const base = baseCommand(effective)
  // 链中是否出现写操作信号（只读主命令 + `&& mkdir` 等需要升级判定）
  const hasWriteSignal = () =>
    WRITE_SIGNAL_PATTERNS.some((re) => re.test(effective)) ||
    /\bsed\s+(?:[^\s]+\s+)*(-i(?:\.[\w.]+)?|--in-place)\b/.test(effective) ||
    /\bperl\s+(?:[^\s]+\s+)*(-i(?:\.[\w.]+)?|--in-place)\b/.test(effective) ||
    /\btee\b/.test(effective)

  // 2. 高风险模式 → 走确认面板（每次询问）
  for (const re of HIGH_RISK_PATTERNS) {
    if (re.test(effective)) {
      return {
        level: 'high-risk',
        policy: 'confirm',
        impacts: inferHighRiskImpacts(effective),
        base,
      }
    }
  }

  // 3. 输出重定向分析（> 与 >>；新版 extractRedirectTarget 已内置 fd 复制 / 设备文件排除）
  const redirect = extractRedirectTarget(effective)
  if (redirect) {
    const inside = isInsideWorkspace(redirect, workspaceDir)
    if (inside) {
      return {
        level: 'workspace-light-write',
        policy: 'light-confirm',
        impacts: [`改写文件：${redirect}`],
        base,
      }
    }
    // 写到工作区外 → 走高风险
    return {
      level: 'high-risk',
      policy: 'confirm',
      impacts: [`改写工作区外的文件：${redirect}`],
      base,
    }
  }

  // 4. 只读白名单（先于轻写：避免 git status/log 等被轻写模式截胡成需要确认；
  //    若链中还有写操作信号则升级，如 `ls && mkdir x`）
  if (base === 'git' && GIT_READONLY_RE.test(effective) && !hasWriteSignal()) {
    return {
      level: 'workspace-readonly',
      policy: 'allow',
      impacts: [],
      base,
    }
  }
  if (WORKSPACE_READONLY_COMMANDS.has(base) && !hasWriteSignal()) {
    return {
      level: 'workspace-readonly',
      policy: 'allow',
      impacts: [],
      base,
    }
  }
  // 4b. 文本处理命令的「只读形式」识别：sed -n / awk / perl -ne 等
  //     与 WORKSPACE_READONLY_COMMANDS 并列但优先（避免被兜底成高风险）。
  //     - `awk ... system(` 这种危险写法 → 升级为 high-risk；
  //     - `sed -i` / `sed --in-place` / `perl -i` / `perl -i.bak` 原地改写 → 不在本步放行，
  //       让下方第 5 步的 WORKSPACE_LIGHT_WRITE_PATTERNS 接管（与 mkdir/cp/mv 同级）。
  const hasTextInPlaceWrite =
    /\bsed\s+(-i|--in-place)\b/.test(effective) ||
    /\bperl\s+(-i(?:\.[\w.]+)?|--in-place)\b/.test(effective)
  if (
    TEXT_PROCESSING_READONLY_BASES.has(base) &&
    !hasWriteSignal() &&
    !hasTextInPlaceWrite
  ) {
    if (/\bawk\b[^\n]*\bsystem\s*\(/.test(effective)) {
      return {
        level: 'high-risk',
        policy: 'confirm',
        impacts: ['awk 调用 system() 可能执行任意子命令'],
        base,
      }
    }
    return {
      level: 'workspace-readonly',
      policy: 'allow',
      impacts: [],
      base,
    }
  }

  // 5. 工作区内轻写模式（mkdir / touch / cp / mv / ln / git commit / npm run...）
  for (const re of WORKSPACE_LIGHT_WRITE_PATTERNS) {
    if (re.test(effective)) {
      // 检查所有参数路径是否在工作区内
      const args = extractArgPaths(effective)
      const allInside = args.length === 0 || args.every((a) => isInsideWorkspace(a, workspaceDir))
      if (allInside) {
        return {
          level: 'workspace-light-write',
          policy: 'light-confirm',
          impacts: inferLightWriteImpacts(effective),
          base,
        }
      }
      // 任意参数在工作区外 → 走高风险
      return {
        level: 'high-risk',
        policy: 'confirm',
        impacts: [`命令涉及工作区外的文件：${args.find((a) => !isInsideWorkspace(a, workspaceDir))}`],
        base,
      }
    }
  }

  // 6. 主命令在工作区外只读白名单（网络探测 / 系统信息查询）
  if (EXTERNAL_READONLY_COMMANDS.has(base) && !hasWriteSignal()) {
    return {
      level: 'external-readonly',
      policy: 'allow',
      impacts: [],
      base,
    }
  }

  // 7. 兜底保守策略：未知主命令 → 高风险确认
  return {
    level: 'high-risk',
    policy: 'confirm',
    impacts: [`未识别的主命令「${base}」，按高风险处理`],
    base,
  }
}

function inferLightWriteImpacts(command: string): string[] {
  const impacts: string[] = []
  if (/\bmkdir\b/.test(command)) impacts.push('创建新目录')
  if (/\btouch\b/.test(command)) impacts.push('创建或更新文件时间戳')
  if (/\bcp\b/.test(command)) impacts.push('复制文件或目录')
  if (/\bmv\b/.test(command)) impacts.push('移动/重命名文件或目录')
  if (/\bln\b/.test(command)) impacts.push('创建链接')
  if (/\bsed\s+-i\b/.test(command)) impacts.push('原地改写工作区内文件内容')
  if (/\btee\b/.test(command)) impacts.push('写入工作区内文件内容')
  if (/\bgit\s+commit\b/.test(command)) impacts.push('创建本地 Git 提交')
  if (/\bgit\s+(add|branch|stash|switch\s+-c|mv|config)\b/.test(command)) impacts.push('修改工作区 Git 状态（本地，未推送）')
  if (/\bnpm\s+(run|test|build)/.test(command)) impacts.push('运行项目脚本（npm run / build）')
  if (impacts.length === 0) impacts.push('在工作区内创建或修改文件')
  return impacts
}

function inferHighRiskImpacts(command: string): string[] {
  const impacts: string[] = []
  if (/\brm\b/.test(command)) impacts.push('删除文件或目录（不可恢复）')
  if (/\bchmod\b/.test(command)) impacts.push('修改文件权限')
  if (/\bchown\b/.test(command)) impacts.push('修改文件所有者')
  if (/\bnpm\s+(i|install|add|remove|rm|uninstall|ci|update)\b/.test(command)) impacts.push('安装/卸载 npm 依赖（修改 package.json / lockfile）')
  if (/\b(pip|pip3)\s+install\b/.test(command)) impacts.push('安装 Python 包（修改环境依赖）')
  if (/\bbrew\s+(install|uninstall|upgrade)\b/.test(command)) impacts.push('安装/卸载/升级 Homebrew 软件包')
  if (/\bgit\s+push\b/.test(command)) impacts.push('推送到远程仓库')
  if (/\bgit\s+(pull|reset|rebase|merge|clean|filter-branch|restore)\b/.test(command)) impacts.push('改写 Git 历史或工作区状态')
  if (/\b(kill|pkill|killall)\b/.test(command)) impacts.push('终止相关进程')
  if (/\bsudo\b/.test(command)) impacts.push('以管理员权限执行（可能影响系统）')
  if (/\bcurl\s+.*(-o|-O|--output)\b/.test(command) || /\bwget\b/.test(command)) impacts.push('从网络下载并写入文件')
  if (/\bunzip\b/.test(command) || /\btar\s+-x\b/.test(command)) impacts.push('解压文件到磁盘')
  if (/\bxattr\b/.test(command)) impacts.push('修改文件扩展属性')
  if (impacts.length === 0) impacts.push('执行该命令可能对工作区或系统产生不可逆副作用')
  return impacts
}

/* ============================================================
 * v0.15.0：evaluatePermission — 权限判定的【唯一权威入口】
 *
 * 流水线（第一个匹配决定结果）：
 *   0. 黑名单 REJECT_PATTERNS → deny（v0.28.0：仅 bypassPermissions 策略可穿透）
 *   1. deny 规则 → deny（不可覆盖）
 *   2. ask 规则 → ask
 *   3. allow 规则 → allow
 *   4. assessCommandRisk 5 级分级 + MODE_POLICIES[mode] 映射
 *   5. 受保护路径检查（写操作命中 → confirm，覆盖前面的 allow；
 *      v0.28.0：仅 policy.protectedPaths==='confirm' 时生效，即 bypass 放行）
 *   6. doom_loop 防卡死 → 升级为 ask（v0.28.0：bypassPermissions 跳过）
 * ============================================================ */

export interface PermissionContext {
  command: string
  cwd: string
  workspaceDir: string
  mode: PermissionMode
  /** 四级合并后的 allow/deny/ask 规则原始字符串列表 */
  rules: { allow: string[]; ask: string[]; deny: string[] }
}

export interface PermissionDecision {
  decision: 'allow' | 'ask' | 'deny'
  reason: string
  riskLevel: CommandRiskLevel
  impacts: string[]
  doomLoop?: boolean
}

function findFirstMatchingRule(
  rules: string[],
  tool: 'Bash',
  commandOrPath: string,
): string | null {
  for (const raw of rules) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    const m = trimmed.match(/^([A-Za-z0-9_][A-Za-z0-9_*]*?)\((.*)\)$/)
    let ruleTool: string
    let pattern: string | undefined
    if (m) {
      ruleTool = m[1]
      pattern = m[2]
    } else {
      ruleTool = trimmed
      pattern = '*'
    }
    if (!matchRule({ raw: trimmed, tool: ruleTool, pattern }, tool, commandOrPath)) {
      continue
    }
    return trimmed
  }
  return null
}

export function evaluatePermission(ctx: PermissionContext): PermissionDecision {
  const trimmed = ctx.command.trim()
  if (!trimmed) {
    return { decision: 'deny', reason: '空命令', riskLevel: 'reject', impacts: ['空命令'] }
  }

  // 0. 黑名单（v0.28.0 策略化：policy.reject!=='allow' 时拦截；
  // autoApprove 保持硬墙，唯一可穿透的是 bypassPermissions）
  const policy = MODE_POLICIES[ctx.mode]
  if (policy.reject !== 'allow' && REJECT_PATTERNS.some((re) => re.test(trimmed))) {
    return {
      decision: 'deny',
      reason: '命令命中安全策略黑名单',
      riskLevel: 'reject',
      impacts: ['命令命中安全策略黑名单（高危操作，禁止执行）'],
    }
  }

  // 1. deny 规则
  const denyHit = findFirstMatchingRule(ctx.rules.deny, 'Bash', trimmed)
  if (denyHit) {
    return {
      decision: 'deny',
      reason: `命中 deny 规则：${denyHit}`,
      riskLevel: 'high-risk',
      impacts: [`命中 deny 规则：${denyHit}`],
    }
  }

  // 2. ask 规则
  const askHit = findFirstMatchingRule(ctx.rules.ask, 'Bash', trimmed)
  if (askHit) {
    return {
      decision: 'ask',
      reason: `命中 ask 规则：${askHit}`,
      riskLevel: 'high-risk',
      impacts: [`命中 ask 规则：${askHit}`],
    }
  }

  // 3. allow 规则
  const allowHit = findFirstMatchingRule(ctx.rules.allow, 'Bash', trimmed)
  // 注意：allow 不直接返回 —— 还要经过受保护路径 + doom_loop 检查

  // 4. assessCommandRisk + MODE_POLICIES（policy 已在第 0 步解析）
  const risk = assessCommandRisk(trimmed, ctx.workspaceDir)
  const riskToPolicy: Record<CommandRiskLevel, 'allow' | 'light-confirm' | 'confirm' | 'deny'> = {
    'workspace-readonly': 'allow',
    'external-readonly': 'allow',
    'workspace-light-write': policy.workspaceLightWrite,
    'high-risk': policy.highRisk,
    'reject': policy.reject,
  }
  let decision: 'allow' | 'light-confirm' | 'confirm' | 'deny' =
    riskToPolicy[risk.level] ?? 'confirm'

  if (allowHit && decision === 'light-confirm') {
    decision = 'allow'
  }

  let reason = allowHit ? `命中 allow 规则：${allowHit}` : `mode=${ctx.mode}, risk=${risk.level}`

  if (decision === 'light-confirm') {
    const mem = lightConfirmMemory.check(trimmed, ctx.cwd, ctx.workspaceDir)
    if (mem.remembered) {
      decision = mem.allowed ? 'allow' : 'deny'
      reason = mem.allowed ? '会话内已确认通过' : '会话内已拒绝'
    }
  }

  // 5. 受保护路径（v0.28.0：policy.protectedPaths==='confirm' 时强制覆盖 allow；
  // bypassPermissions（'allow'）放行，其余状态维持硬墙语义）
  if (
    policy.protectedPaths === 'confirm' &&
    decision !== 'deny' &&
    touchesProtectedPath(trimmed, ctx.cwd, ctx.workspaceDir)
  ) {
    decision = 'confirm'
    reason = '操作命中受保护路径（.git / .arkwork / .env / lockfile / 密钥文件）'
  }

  // 6. doom_loop（v0.28.0：bypassPermissions 跳过升级，避免全自动任务被打断）
  const doom = detectDoomLoop(trimmed, ctx.cwd)
  let finalDecision: 'allow' | 'ask' | 'deny'
  if (decision === 'confirm' || decision === 'light-confirm') {
    finalDecision = 'ask'
  } else if (doom && decision === 'allow' && ctx.mode !== 'bypassPermissions') {
    finalDecision = 'ask'
    reason = 'doom_loop 检测：同命令同 cwd 60 秒内连续执行 3 次'
  } else {
    finalDecision = decision
  }

  return {
    decision: finalDecision,
    reason,
    riskLevel: risk.level,
    impacts: risk.impacts,
    doomLoop: doom,
  }
}
