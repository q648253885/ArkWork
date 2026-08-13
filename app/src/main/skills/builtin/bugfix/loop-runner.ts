/* ============================================================
 * ArkWork — Bugfix Skill: loop-runner (v0.14.0 Task 11.3)
 * 目标驱动多轮续跑循环：
 *   评估当前状态 → 决定下一步修复动作（LLM）→ 执行修复（shell / file / delegate）
 *   → 验证目标（跑测试/检查）→ 达成停止 / 路径耗尽停止 / 超轮数失败
 *
 * 工具执行统一经 Task 5 容错链路（runFaultTolerant）5 档兜底
 * （重试 ≤3 次 → 替代方案 → 影响分析 → 用户决策 / 继续）。
 * 每轮尝试写入 attempts 数组，最终汇总 diffSummary 与测试输出。
 * ============================================================ */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { runFaultTolerant } from '../../../fault-tolerance/run-fault-tolerant.js'
import { delegateAgent } from '../../../agent/skills/delegate.js'
import type { SkillContext } from '../../../agent/registry.js'
import type { ShellResult } from '../../../agent/skills/shell.js'
import { logger } from '../../../system/logger.js'
import type { BugfixMode } from './mode.js'
import type { BugfixProgressEvent } from '@shared/types/ipc'
import type { ParsedGoal } from './goal-parser.js'

const execFileAsync = promisify(execFile)

export type BugfixStatus = 'achieved' | 'exhausted' | 'failed'

/** 单轮尝试记录（写入 attempts.jsonl） */
export interface BugfixAttempt {
  round: number
  /** LLM 判定的动作说明 */
  decision: string
  action: { type: 'patch' | 'verify' | 'stop'; command?: string; note?: string }
  executedAt: number
  verifyCommand?: string
  verifyOutput?: string
  verifyExit?: number | null
  /** 该轮验证是否达成目标 */
  ok: boolean
  error?: string
}

export interface BugfixDeps {
  ctx: SkillContext
  workspaceDir: string
  /** 执行内置 skill（shell / file-reader 等） */
  invokeTool: (
    skillId: string,
    args: Record<string, unknown>,
  ) => Promise<{ result: unknown; summary: string }>
  /** LLM 决策：输入（system, user），输出下一步动作 JSON 文本 */
  decide: (system: string, user: string) => Promise<string>
  /** 进度事件上报（taskId 由调用方注入） */
  emitProgress: (payload: Omit<BugfixProgressEvent, 'ts' | 'taskId'>) => void
  mode?: BugfixMode
  maxRounds?: number
  /** 验收命令猜测回调（默认按仓库类型 + repro 猜） */
  guessVerifyCommand?: () => string | null
}

export interface RunLoopResult {
  status: BugfixStatus
  attempts: BugfixAttempt[]
  diffSummary: string
  testOutput: string
}

export const DEFAULT_MAX_ROUNDS = 5

const PROMPT_SYSTEM = `你是「目标驱动多轮续跑」的 bugfix 决策器。每次只输出一个 JSON 对象（不要多余文字），格式：
{"action":"patch|verify|stop","command":"可选的 shell 命令","note":"简短说明"}
- patch：执行修复。command 省略时由编码 Agent 自动定位并修复。
- verify：运行验证/测试命令（command 必填）。
- stop：当已无新的修复路径、或确认当前无法达成目标时停止。
规则：先 verify 确认现状，再 patch，再 verify 确认达成；只输出真实存在的命令，绝不编造文件或命令。`

/** 多轮续跑主循环 */
export async function runLoop(goal: ParsedGoal, deps: BugfixDeps): Promise<RunLoopResult> {
  const mode = deps.mode ?? 'multi-attempt'
  const maxRounds = mode === 'single-attempt' ? 1 : (deps.maxRounds ?? DEFAULT_MAX_ROUNDS)
  const attempts: BugfixAttempt[] = []
  let status: BugfixStatus = 'exhausted'
  let testOutput = ''

  deps.emitProgress({ phase: 'goal-defined', attempt: 0, round: 0 })

  for (let round = 1; round <= maxRounds; round++) {
    const attemptNumber = attempts.length + 1
    deps.emitProgress({ phase: 'fixing', attempt: attemptNumber, round })
    const attempt: BugfixAttempt = {
      round,
      decision: '',
      action: { type: 'verify' },
      executedAt: Date.now(),
      ok: false,
    }

    // 1) 评估当前状态（工作区概况 + 最近一次验证输出）
    const state = await gatherState(deps, attempts)

    // 2) LLM 决定下一步修复动作
    let decision: DecideResult
    try {
      const raw = await deps.decide(PROMPT_SYSTEM, buildUserPrompt(goal, state))
      decision = parseDecision(raw)
    } catch (err) {
      decision = { action: 'stop', note: `决策失败：${(err as Error).message}` }
    }
    attempt.decision = decision.note ?? ''
    attempt.action = { type: decision.action, command: decision.command, note: decision.note }

    // 路径耗尽（LLM 判定无新路径）→ 停止
    if (decision.action === 'stop') {
      attempts.push(attempt)
      status = 'exhausted'
      break
    }

    // 3) 执行修复（patch）
    if (decision.action === 'patch') {
      try {
        const note = await executePatch(deps, decision.command, goal)
        attempt.action.note = (attempt.action.note ? `${attempt.action.note}；` : '') + note
      } catch (err) {
        attempt.error = (err as Error).message
        attempts.push(attempt)
        continue // 修复动作失败 → 进入下一轮重新评估（multi-attempt）
      }
    }

    // 4) 验证目标（跑测试/检查）
    deps.emitProgress({ phase: 'verifying', attempt: attemptNumber, round })
    const verifyCommand =
      decision.action === 'verify' && decision.command
        ? decision.command
        : (deps.guessVerifyCommand?.() ?? null)
    if (verifyCommand) {
      const v = await runShell(deps, verifyCommand)
      attempt.verifyCommand = verifyCommand
      attempt.verifyOutput = v?.output ?? ''
      attempt.verifyExit = v?.exitCode ?? null
      testOutput = attempt.verifyOutput
      attempt.ok = v?.ok ?? false
      if (attempt.ok) {
        status = 'achieved'
        attempts.push(attempt)
        break
      }
    } else {
      attempt.verifyOutput = '（未提供可执行的验证命令）'
      attempt.ok = false
    }
    attempts.push(attempt)
    // 未达成 → 下一轮（multi-attempt）；single-attempt 在此结束
  }

  // single-attempt 未达成 → failed（区别于多轮模式的 exhausted）
  if (status !== 'achieved' && mode === 'single-attempt') {
    status = 'failed'
  }

  const diffSummary = await collectDiffSummary(deps.workspaceDir)

  // 终态事件
  deps.emitProgress({
    phase: status === 'achieved' ? 'achieved' : 'not-achieved',
    attempt: attempts.length,
    round: attempts.length,
    result: {
      status,
      diffSummary,
      testOutput: testOutput.slice(0, 2000),
      attemptCount: attempts.length,
      goal: goal.goal,
    },
  })

  logger.info(
    'Tool',
    `bugfix:runLoop status=${status} rounds=${attempts.length} mode=${mode}`,
    deps.ctx.taskId,
  )
  return {
    status,
    attempts,
    diffSummary,
    testOutput: testOutput.slice(0, 4000),
  }
}

/* ============================================================
 * 内部辅助
 * ============================================================ */

interface DecideResult {
  action: 'patch' | 'verify' | 'stop'
  command?: string
  note?: string
}

function parseDecision(raw: string): DecideResult {
  const trimmed = (raw ?? '').trim()
  try {
    const obj = JSON.parse(trimmed) as Partial<DecideResult>
    const action =
      obj.action === 'patch' || obj.action === 'verify' || obj.action === 'stop'
        ? obj.action
        : 'verify'
    return {
      action,
      command: typeof obj.command === 'string' ? obj.command : undefined,
      note: typeof obj.note === 'string' ? obj.note : undefined,
    }
  } catch {
    // 容错：从文本提取 action 关键词
    const action = /"action"\s*:\s*"stop"|\bstop\b/i.test(trimmed)
      ? 'stop'
      : /patch|修复|修改/.test(trimmed)
        ? 'patch'
        : 'verify'
    return { action, note: trimmed.slice(0, 200) }
  }
}

function buildUserPrompt(goal: ParsedGoal, state: string): string {
  return [
    '## 目标（Given/When/Then）',
    goal.goal,
    '',
    '## 验收标准',
    ...goal.acceptanceCriteria.map((c) => `- ${c}`),
    '',
    '## 当前状态',
    state,
    '',
    '## 请输出下一步动作 JSON',
  ].join('\n')
}

/** 评估当前状态：工作区概况 + 最近一次验证输出 */
async function gatherState(deps: BugfixDeps, attempts: BugfixAttempt[]): Promise<string> {
  const parts: string[] = []
  try {
    const r = await deps.invokeTool('file-reader', { path: deps.workspaceDir })
    const text =
      r.result && typeof r.result === 'object'
        ? JSON.stringify(r.result).slice(0, 1200)
        : String(r.result ?? '')
    parts.push(`## 工作区概况\n${text}`)
  } catch {
    parts.push('## 工作区概况\n（读取失败）')
  }
  const last = attempts.length > 0 ? attempts[attempts.length - 1] : undefined
  if (last?.verifyOutput) {
    parts.push(`## 最近一次验证输出（round ${last.round}）\n${last.verifyOutput.slice(0, 1500)}`)
  }
  return parts.join('\n\n')
}

/** 经容错 5 档链路执行 shell 命令（内部统一封装） */
async function runShell(
  deps: BugfixDeps,
  command: string,
): Promise<{ output: string; exitCode: number | null; ok: boolean } | null> {
  const outcome = await runFaultTolerant(
    () => deps.invokeTool('shell', { command, cwd: deps.workspaceDir, timeoutMs: 60_000 }),
    {
      taskId: deps.ctx.taskId,
      toolCall: { toolName: 'shell', args: { command } },
      signal: deps.ctx.signal,
    },
  )
  if (outcome.outcome === 'retry-succeeded' || outcome.outcome === 'alternative-succeeded') {
    const r = outcome.value as (ShellResult & { error?: string }) | undefined
    if (!r) return null
    if (r.error) return { output: r.error, exitCode: null, ok: false }
    const output = [r.stdout, r.stderr].filter(Boolean).join('\n')
    return { output, exitCode: r.exitCode ?? null, ok: r.exitCode === 0 }
  }
  if (outcome.outcome === 'cancelled' || outcome.outcome === 'llm-fatal') {
    throw new Error(`shell 执行被中断：${outcome.fault?.message ?? 'aborted'}`)
  }
  // no-impact / impacts-followers（重试耗尽等）→ 记为失败，不中断循环
  return {
    output: `命令失败：${outcome.fault?.message ?? 'unknown'}`,
    exitCode: null,
    ok: false,
  }
}

/** 执行修复：优先用决策给出的命令；否则委派 @coding Agent 自动定位修复 */
async function executePatch(deps: BugfixDeps, command: string | undefined, goal: ParsedGoal): Promise<string> {
  if (command && command.trim()) {
    const r = await runShell(deps, command.trim())
    if (!r || !r.ok) {
      throw new Error(r ? `修复命令未成功：${r.output.slice(0, 300)}` : '修复命令执行失败')
    }
    return `已执行修复命令：${command.trim()}`
  }
  const result = await delegateAgent(
    {
      agentId: '@coding',
      task: [
        '你是缺陷修复执行子 Agent。请针对以下目标定位问题并修复代码。',
        '只做修复本身，不要扩大范围；必要时可运行测试确认。',
        '完成后用 task_complete 摘要说明改动了哪些文件。',
        '',
        goal.goal,
        '',
        '验收标准：',
        ...goal.acceptanceCriteria.map((c) => `- ${c}`),
      ].join('\n'),
    },
    deps.ctx,
  )
  if (result.status !== 'done') {
    throw new Error(`修复委派未完成：${result.summary}`)
  }
  return `已委派编码 Agent 修复：${result.summary.slice(0, 200)}`
}

/** diff 摘要（git diff --stat；非 git 仓库时给出提示） */
async function collectDiffSummary(workspaceDir: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['diff', '--stat'], {
      cwd: workspaceDir,
      timeout: 10_000,
    })
    return stdout.trim() || '（工作区无未提交改动）'
  } catch {
    return '（无法读取 git diff —— 非 git 仓库或 git 不可用）'
  }
}
