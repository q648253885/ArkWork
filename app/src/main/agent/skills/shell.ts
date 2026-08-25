/* ============================================================
 * ArkWork — Builtin Skill: shell
 * v0.6.0 设计文档 §4.6 / v0.14.0 Task 6（权限分级统一）
 * v0.15.0：迁移到 evaluatePermission 三态决策（allow / ask / deny）
 *
 * 安全策略：
 *  1. 命令黑名单（rm -rf /、fork bomb、mkfs、dd of=/dev、shutdown 等）
 *     —— 单一来源：permissions.ts 的 REJECT_PATTERNS
 *  2. cwd 必须在 workspaceDir 内（防止越权写工作区之外的路径）
 *  3. v0.15.0：命令权限判定由 permissions.ts::evaluatePermission 唯一权威入口
 *  4. 执行超时（默认 30s，可由 args.timeoutMs 覆盖，上限 5 分钟）
 *
 * 返回：{ stdout, stderr, exitCode, command, cwd }
 * ============================================================ */
import { spawn } from 'node:child_process'
import { resolve, isAbsolute, relative } from 'node:path'
import { getWorkspaceDir } from '../../store/db.js'
import { logger } from '../../system/logger.js'
import {
  assessCommandRisk,
  evaluatePermission,
  type PermissionDecision,
} from '../permissions.js'
import { lightConfirmMemory } from '../light-confirm-memory.js'
import { loadPermissionSettings } from '../settings-loader.js'
import { getSessionMode, type PermissionMode } from '../session-mode.js'
import { classifyShellRisk, repeatTracker, isOutsideWorkspace } from '../shell-risk.js'
import { logShellAudit } from '../shell-audit.js'
import type { SkillContext } from '../registry.js'

export interface ShellArgs {
  command: string
  cwd?: string
  timeoutMs?: number
}

export interface ShellResult {
  command: string
  cwd: string
  stdout: string
  stderr: string
  exitCode: number | null
  durationMs: number
  timedOut: boolean
}

const MAX_TIMEOUT_MS = 2 * 60 * 1000  // v0.16.x：上限从 5min 收紧到 2min（参考 opencode BashTool）
const DEFAULT_TIMEOUT_MS = 15_000  // v0.16.x：默认 30s → 15s（绝大多数 shell 命令应在 15s 内完成）

/**
 * 命令安全分级（旧 3 级接口，v0.14.0 起委托 permissions.ts 唯一判定）。
 *
 * 由于分级需要按「工作区内 / 工作区外」区分（spec: 工作区内只读与
 * 工作区外只读查询默认放行），带 workspaceDir 的 assessCommandRisk
 * 才是运行时唯一权威；本函数保持向后兼容签名并做等级映射：
 *  - workspace-readonly / external-readonly / workspace-light-write → safe
 *  - high-risk → confirm
 *  - reject → reject
 */
export function assessShellCommand(
  command: string,
  workspaceDir?: string,
): { level: 'safe' | 'confirm' | 'reject'; impacts: string[] } {
  const risk = assessCommandRisk(command, workspaceDir ?? '')
  if (risk.level === 'reject') return { level: 'reject', impacts: risk.impacts }
  if (risk.level === 'high-risk') return { level: 'confirm', impacts: risk.impacts }
  return { level: 'safe', impacts: risk.impacts }
}

/** v0.15.0：从 ctx 推断当前 PermissionMode（默认 'default'） */
async function resolveShellDecision(
  command: string,
  cwd: string,
  workspaceDir: string,
  ctx: SkillContext,
): Promise<PermissionDecision> {
  // v0.28.0：五态模型 —— 局部类型放宽为 PermissionMode（autoApprove/bypassPermissions
  // 由 evaluatePermission 的 ModePolicy 流水线统一裁决，此处只负责解析生效模式）。
  let mode: PermissionMode = 'default'
  let rules = { allow: [] as string[], ask: [] as string[], deny: [] as string[] }
  try {
    const settings = await loadPermissionSettings(workspaceDir)
    rules = {
      allow: settings.allow.map((r) => r.raw),
      ask: settings.ask.map((r) => r.raw),
      deny: settings.deny.map((r) => r.raw),
    }
    // v0.15.0：会话模式（Shift+Tab 切换）优先，未切换回退配置 defaultMode
    let candidate: PermissionMode = getSessionMode(workspaceDir) ?? settings.defaultMode
    // v0.15.0 Task 6：智能体级 defaultPermissionMode 在 settings 未显式配置时生效。
    // 优先级：session override > settings.defaultMode > agent.defaultPermissionMode > 'default'。
    // 注意：candidate 已被 session/settings 写过，若 settings 没配置则保持 'default'（占位），
    // 下面会按 agent.defaultPermissionMode 兜底。
    if (
      candidate === 'default' &&
      ctx.agent?.defaultPermissionMode &&
      ctx.agent.defaultPermissionMode !== 'default'
    ) {
      candidate = ctx.agent.defaultPermissionMode
    }
    mode = candidate
  } catch (err) {
    logger.warn('Tool', `shell: failed to load permission settings: ${(err as Error).message}`, ctx.taskId)
  }
  return evaluatePermission({
    command,
    cwd,
    workspaceDir,
    mode,
    rules,
  })
}

export async function shell(
  args: ShellArgs,
  ctx: SkillContext,
): Promise<ShellResult> {
  const command = (args.command ?? '').trim()
  if (!command) {
    throw new Error('shell: command 不能为空')
  }

  // 0. v0.16.6+ 文件操作重定向守卫：禁止用 shell 做 cat/grep/sed/awk 等。
  //    这些命令的目的是读/搜索文件，应改用 file-reader / grep-search / glob-search。
  //    重复读同一文件已被 file-reader 重复检测拦截，这里只做"工具替换提示"。
  const fileOpGuard = detectShellFileOp(command)
  if (fileOpGuard) {
    throw new Error(
      `shell: ${fileOpGuard.op} 用 shell 完成属违规。改用专用文件工具：` +
        fileOpGuard.alternative +
        `。示例：` +
        fileOpGuard.example,
    )
  }

  // 1. cwd 限制：必须在 workspaceDir 内
  const workspaceDir = ctx.workspaceDir ?? getWorkspaceDir()
  const cwd = resolveCwd(args.cwd, workspaceDir)
  const rel = relative(workspaceDir, cwd)
  if (rel.startsWith('..')) {
    throw new Error(`shell: cwd 越界（${cwd} 不在工作区 ${workspaceDir} 内）`)
  }

  // 2. Task 5：命令风险分级（low / medium / high）—— 放行 / 确认的权威依据
  const riskInfo = classifyShellRisk(command, cwd, workspaceDir)

  // 3. evaluatePermission 三态决策（保留黑名单 / deny 规则 / 显式 ask 规则 / 受保护路径）
  const decision = await resolveShellDecision(command, cwd, workspaceDir, ctx)

  // 黑名单 / deny 规则 → 直接拒绝并记录审计
  if (decision.decision === 'deny') {
    await logShellAudit({
      command, cwd, riskLevel: riskInfo.level, targetPath: riskInfo.targetPath,
      result: 'denied', timestamp: Date.now(), reason: decision.reason,
    }, workspaceDir)
    throw new Error(`shell: 命令被拒绝（${decision.reason}）`)
  }

  // 汇总是否需要用户确认
  let needConfirm = false
  const confirmReasons: string[] = []
  const impacts: string[] = []

  // 显式 ask（用户 ask 规则 / 受保护路径）→ 必须确认；
  // doom_loop 频率限制已废弃，改由下方 RepeatTracker 处理；
  // 风险分级型 ask（mode=..., risk=...）交给 classifyShellRisk 统一决策。
  const isLightConfirm =
    decision.decision === 'ask' &&
    decision.riskLevel === 'workspace-light-write' &&
    decision.reason.startsWith('mode=')
  if (decision.decision === 'ask' && !decision.doomLoop) {
    if (isExplicitAsk(decision.reason) || isLightConfirm) {
      needConfirm = true
      confirmReasons.push(decision.reason)
      impacts.push(...decision.impacts)
    }
  }

  // 高危命令 → 强制确认并展示风险原因与影响范围
  if (riskInfo.level === 'high') {
    needConfirm = true
    confirmReasons.push(riskInfo.reason)
  } else if (riskInfo.level === 'medium' && riskInfo.targetPath && isOutsideWorkspace(riskInfo.targetPath, workspaceDir)) {
    // 中危命令越出 workspace → 强制确认
    needConfirm = true
    confirmReasons.push(`中危命令目标超出工作区：${riskInfo.targetPath}`)
  }

  // 重复执行检测（替代 doom_loop 粗放频率限制）
  const repeat = repeatTracker.checkRepeat(command, cwd)
  if (repeat.isRepeat && repeat.withinWindow) {
    needConfirm = true
    confirmReasons.push(`短时间内已重复执行 ${repeat.count} 次，请确认是否继续`)
  }

  if (needConfirm) {
    if (!ctx.confirm) {
      await logShellAudit({
        command, cwd, riskLevel: riskInfo.level, targetPath: riskInfo.targetPath,
        result: 'denied', timestamp: Date.now(), reason: '需要确认但 confirm 通道未注册',
      }, workspaceDir)
      throw new Error(`shell: 命令需要确认（${confirmReasons.join('；')}），但 confirm 通道未注册`)
    }
    const outcome = await ctx.confirm({
      requestId: `shell:${Date.now()}`,
      skillName: 'shell',
      command,
      cwd,
      impacts: impacts.length ? impacts : confirmReasons,
      risk: riskInfo.level,
      taskId: ctx.taskId,
    })
    if (!outcome.allowed) {
      if (isLightConfirm && outcome.reason === 'denied') {
        lightConfirmMemory.remember(command, cwd, workspaceDir, false)
      }
      await logShellAudit({
        command, cwd, riskLevel: riskInfo.level, targetPath: riskInfo.targetPath,
        result: 'denied', timestamp: Date.now(), reason: `用户拒绝（${confirmReasons.join('；')}）`,
      }, workspaceDir)
      throw new Error(`shell: 用户拒绝执行（${confirmReasons.join('；')}）`)
    }
    if (isLightConfirm) {
      lightConfirmMemory.remember(command, cwd, workspaceDir, true)
    }
  }

  // 4. 超时
  const timeoutMs = Math.min(args.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)

  logger.info('Tool', `shell.exec: \`${command}\` in ${cwd} (timeout=${timeoutMs}ms) risk=${riskInfo.level}`, ctx.taskId)

  const result = await new Promise<ShellResult>((resolveFn) => {
    const startedAt = Date.now()
    // 用 sh -c 在 Unix / cmd /c 在 Windows 执行（保持 shell 语义）
    const isWin = process.platform === 'win32'
    const child = isWin
      ? spawn('cmd', ['/c', command], { cwd, windowsHide: true })
      : spawn('sh', ['-c', command], { cwd })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let exitCode: number | null = null

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf-8')
      // 防止单条输出爆炸（> 1MB 截断）
      if (stdout.length > 1_024 * 1024) {
        stdout = stdout.slice(0, 1_024 * 1024) + '\n… (stdout truncated at 1MB)'
        try { child.kill('SIGTERM') } catch { /* ignore */ }
      }
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf-8')
      if (stderr.length > 256 * 1024) {
        stderr = stderr.slice(0, 256 * 1024) + '\n… (stderr truncated at 256KB)'
      }
    })

    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGTERM') } catch { /* ignore */ }
      // 1s 后仍未退出强制 kill
      setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* ignore */ }
      }, 1000)
    }, timeoutMs)

    child.on('close', (code) => {
      clearTimeout(timer)
      exitCode = code
      const durationMs = Date.now() - startedAt
      logger.info('Tool', `shell.done: exit=${code} · ${durationMs}ms · stdout=${stdout.length}c stderr=${stderr.length}c`, ctx.taskId)
      resolveFn({
        command,
        cwd,
        stdout,
        stderr: stderr + (timedOut ? `\n… (timed out after ${timeoutMs}ms)` : ''),
        exitCode,
        durationMs,
        timedOut,
      })
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      const durationMs = Date.now() - startedAt
      resolveFn({
        command,
        cwd,
        stdout,
        stderr: stderr + `\nspawn error: ${err.message}`,
        exitCode: null,
        durationMs,
        timedOut: false,
      })
    })

    // 中断信号 → kill 子进程
    if (ctx.signal) {
      ctx.signal.addEventListener('abort', () => {
        try { child.kill('SIGTERM') } catch { /* ignore */ }
      }, { once: true })
    }
  })

  // Task 5：执行完毕记录审计（success / failed）
  await logShellAudit({
    command, cwd, riskLevel: riskInfo.level, targetPath: riskInfo.targetPath,
    result: result.exitCode === 0 ? 'success' : 'failed',
    timestamp: Date.now(),
    durationMs: result.durationMs,
    reason: result.exitCode === 0 ? undefined : `exit=${result.exitCode}`,
  }, workspaceDir)

  return result
}

/** 解析 cwd：相对路径基于 workspaceDir，绝对路径必须落在 workspaceDir 内 */
function resolveCwd(cwd: string | undefined, workspaceDir: string): string {
  if (!cwd) return workspaceDir
  const abs = isAbsolute(cwd) ? cwd : resolve(workspaceDir, cwd)
  return abs
}

/**
 * v0.16.6+ 文件操作重定向：检测 shell 命令首段是否在用 shell 完成"本应用专用
 * 文件工具"的工作。命中则返回替代工具与示例，让调用方立即改用 file-reader /
 * grep-search / glob-search，避免 token 白白消耗在 stdout 截断的结果上。
 *
 * 设计要点：
 *  - 只匹配命令首段（去掉前导 cd / sudo 等），误判风险小
 *  - 允许白名单：`node _smoke_test.mjs`、`bash test.sh`、`echo "..."`、`mkdir -p`
 *    等"必须执行命令才能拿到结果"的场景不命中
 *  - 不做"上下文级"判定（之前是否刚用过 file-reader），那是另一层逻辑
 */
function detectShellFileOp(
  command: string,
): { op: string; alternative: string; example: string } | null {
  // 去前导 cd / sudo / env 等
  const stripped = command.replace(/^\s*(?:cd\s+\S+\s*&&\s*|sudo\s+|env\s+)+/i, '').trim()
  // 取首段（到第一个 | / ; / && 或结尾）
  const firstSegment = stripped.split(/[|;&]/)[0].trim()
  // 取首 token
  const firstToken = firstSegment.split(/\s+/)[0] ?? ''
  // 去掉前缀路径如 /usr/bin/cat
  const base = firstToken.replace(/^.*\//, '').toLowerCase()
  switch (base) {
    case 'cat':
      return {
        op: 'cat 文件',
        alternative: 'file-reader({ path })',
        example: 'file-reader({ path: "src/main/foo.ts" })',
      }
    case 'head':
    case 'tail':
    case 'less':
    case 'more':
      return {
        op: `${base} 翻看文件`,
        alternative: 'file-reader({ path, maxLines?, startLine? })',
        example: 'file-reader({ path: "src/main/foo.ts", maxLines: 50, startLine: 100 })',
      }
    case 'wc':
      // wc 在 awk 前后统计数字时是合法的（cat | wc），但单独 wc -l 文件名应拦截
      if (/^wc\s+(?:-[a-z]*l[a-z]*\s+)?\S+/.test(firstSegment)) {
        return {
          op: 'wc 文件行数',
          alternative: 'file-reader 直接读 + 看返回的 lines 字段',
          example: 'file-reader({ path: "src/main/foo.ts" }) 返回 { lines, bytes, content }',
        }
      }
      return null
    case 'grep':
    case 'egrep':
    case 'fgrep':
    case 'rg':
      return {
        op: 'grep 搜索文件内容',
        alternative: 'grep-search({ path, pattern, maxResults?, caseSensitive? })',
        example: 'grep-search({ path: "src/main/foo.ts", pattern: "TODO", maxResults: 30 })',
      }
    case 'find':
      return {
        op: 'find 找文件',
        alternative: 'glob-search({ pattern })',
        example: 'glob-search({ pattern: "**/*.test.ts" })',
      }
    case 'ls':
      // v0.24.x：ls 列目录不在 file-reader/grep-search 的"读取文件内容"语义范畴，
      // 属于纯目录枚举（dirent），与 `cat`/`head`/`grep` 读取文件内容不同。
      // permissions.ts WORKSPACE_READONLY_COMMANDS 已把 ls 归为 allow，
      // 不应再在文件操作守卫里阻拦 —— 否则 LLM 会反复用 file-reader 列目录、
      // glob-search 反而不能直接给完整路径列表。
      return null
    case 'tree':
      // tree 同上：递归列目录，与 ls 同质，权限层已放行
      return null
    case 'stat':
      // stat 查看文件元信息（大小/时间），不读内容，权限层已放行
      return null
    case 'file':
      // file 命令判断文件类型，不读内容
      return null
    case 'du':
      // du 看磁盘占用，不读内容
      return null
    case 'realpath':
    case 'readlink':
      // 路径解析，不读内容
      return null
    case 'sed':
    case 'awk':
      // sed -i / awk '{print}' 都是文件操作；awk 处理 stdin 流式数据允许
      if (/\s+-i(\s|$)|(\s|^)[A-Za-z_][\w./-]+\s*$/.test(firstSegment)) {
        return {
          op: `${base} 处理文件`,
          alternative: 'file-reader 取内容 + file-writer 写出 / file-editor 改行',
          example: 'file-reader + file-writer({ path, content })',
        }
      }
      return null
    default:
      return null
  }
}

/**
 * Task 5：判定 evaluatePermission 的 reason 是否属于「显式 ask」（来自
 * 用户 ask 规则或受保护路径），与风险分级型 ask（mode=..., risk=...）
 * 区分。显式 ask 需要走到 confirm 链路；分级型 ask 由 classifyShellRisk
 * 统一决策（workspace 内默认放行+审计，越界升 high 走 confirm）。
 */
function isExplicitAsk(reason: string | undefined): boolean {
  if (!reason) return false
  // ask 规则命中 / 受保护路径 → 显式
  if (reason.startsWith('命中 ask 规则')) return true
  if (reason.startsWith('操作命中受保护路径')) return true
  // doom_loop 由 RepeatTracker 接管
  if (reason.startsWith('doom_loop 检测')) return false
  return false
}
