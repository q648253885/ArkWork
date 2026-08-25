/* ============================================================
 * ArkWork — Bugfix Skill: index (v0.14.0 Task 11)
 * 入口：校验入参 → parseGoal → （按模式）多轮续跑 / 单轮修复
 * → 产物落盘 <workspace>/.arkwork/bugfix/<taskName>/
 *     { goal.md, attempts.jsonl, diff.patch, result.md }
 * → 返回 { goal, status, attempts, diffSummary, testOutput, resultDir }
 * ============================================================ */
import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getWorkspaceDir } from '../../../store/db.js'
import { getAdapter } from '../../../llm/registry.js'
import { invokeSkill, type SkillContext } from '../../../agent/registry.js'
import { logger } from '../../../system/logger.js'
import { parseGoal, type ParsedGoal } from './goal-parser.js'
import { runLoop, type BugfixAttempt, type BugfixStatus, type BugfixDeps } from './loop-runner.js'
import { getBugfixMode, type BugfixMode } from './mode.js'
import { emitBugfixProgress } from './progress.js'

const execFileAsync = promisify(execFile)

export interface BugfixArgs {
  /** bug 现象（必填） */
  symptom: string
  /** 复现路径（可选：命令或步骤描述） */
  repro?: string
  /** 期望行为（必填） */
  expected: string
  /** 产物目录名（缺省由 symptom 派生） */
  taskName?: string
}

export interface BugfixResult {
  goal: string
  status: BugfixStatus
  attempts: BugfixAttempt[]
  diffSummary: string
  testOutput: string
  resultDir: string
}

export async function bugfix(
  args: BugfixArgs,
  ctx: SkillContext,
): Promise<BugfixResult | { status: 'failed'; error: string }> {
  try {
    const symptom = (args?.symptom ?? '').trim()
    const expected = (args?.expected ?? '').trim()
    if (!symptom || !expected) {
      return { status: 'failed', error: 'bugfix: symptom 与 expected 不能为空' }
    }

    const workspace = ctx.workspaceDir ?? getWorkspaceDir()
    const taskName = (args?.taskName ?? '').trim() || slugify(symptom.slice(0, 24))
    const directory = join(workspace, '.arkwork', 'bugfix', taskName)
    await mkdir(directory, { recursive: true })

    // 1) 目标解析（Given/When/Then + 验收标准）
    const parsed = parseGoal({ symptom, repro: args?.repro, expected })
    const mode = getBugfixMode()
    await writeFile(join(directory, 'goal.md'), formatGoalMd(parsed, mode), 'utf-8')

    // 2) 组装循环依赖并运行
    const deps: BugfixDeps = {
      ctx,
      workspaceDir: workspace,
      invokeTool: (skillId, toolArgs) => invokeSkill(skillId, toolArgs, ctx),
      decide: await makeDecider(ctx),
      emitProgress: (p) => emitBugfixProgress({ taskId: ctx.taskId, ...p }),
      mode,
      guessVerifyCommand: () => guessVerifyCommand(workspace, args?.repro),
    }
    const result = await runLoop(parsed, deps)

    // 3) 产物落盘
    await writeAttempts(join(directory, 'attempts.jsonl'), result.attempts)
    await writeDiffPatch(join(directory, 'diff.patch'), workspace)
    await writeFile(join(directory, 'result.md'), formatResultMd(parsed, result), 'utf-8')

    logger.info(
      'Tool',
      `bugfix: ${taskName} status=${result.status} rounds=${result.attempts.length} mode=${mode} → ${directory}`,
      ctx.taskId,
    )
    return {
      goal: parsed.goal,
      status: result.status,
      attempts: result.attempts,
      diffSummary: result.diffSummary,
      testOutput: result.testOutput,
      resultDir: directory,
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logger.error('Tool', `bugfix failed: ${error}`, ctx.taskId)
    return { status: 'failed', error }
  }
}

/* ============================================================
 * 内部辅助
 * ============================================================ */

/** 构造 LLM 决策回调；模型不可用时走规则兜底 */
async function makeDecider(ctx: SkillContext): Promise<BugfixDeps['decide']> {
  const modelId = ctx.task?.modelId
  let adapter: Awaited<ReturnType<typeof getAdapter>> | null = null
  if (modelId) {
    try {
      adapter = await getAdapter(modelId)
    } catch (err) {
      logger.warn('Tool', `bugfix: LLM adapter 不可用（${(err as Error).message}），决策走兜底`, ctx.taskId)
    }
  }
  return async (system: string, user: string) => {
    if (!adapter) return fallbackDecide(user)
    try {
      const resp = await adapter.complete({
        system,
        messages: [{ role: 'user', content: user }],
        temperature: 0,
        maxTokens: 300,
        signal: ctx.signal,
      })
      return resp.content
    } catch (err) {
      logger.warn('Tool', `bugfix: LLM 决策失败（${(err as Error).message}），走兜底`, ctx.taskId)
      return fallbackDecide(user)
    }
  }
}

/** 无 LLM 时的兜底决策：首轮先验证现状，之后判定路径耗尽 */
function fallbackDecide(user: string): string {
  if (/最近一次验证输出/.test(user)) {
    return JSON.stringify({ action: 'stop', note: '无 LLM 决策能力且已验证未达成，路径耗尽' })
  }
  return JSON.stringify({ action: 'verify', note: '无 LLM 决策能力：先执行复现/测试命令确认现状' })
}

/** 验收命令猜测：优先 repro 中的命令，其次按仓库类型猜测试命令 */
function guessVerifyCommand(workspaceDir: string, repro?: string): string | null {
  const r = (repro ?? '').trim()
  const backtick = r.match(/`([^`]+)`/)
  const candidate = (backtick?.[1] ?? r).trim()
  if (candidate && /^(?:npm|yarn|pnpm|npx|node|python|go|cargo|bash|sh|make|git|ruby|bundle)\b/.test(candidate)) {
    return candidate
  }
  const checks: Array<[string, string]> = [
    ['package.json', 'npm test'],
    ['pnpm-lock.yaml', 'pnpm test'],
    ['yarn.lock', 'yarn test'],
    ['go.mod', 'go test ./...'],
    ['Cargo.toml', 'cargo test'],
    ['pytest.ini', 'python -m pytest -q'],
    ['requirements.txt', 'python -m pytest -q'],
  ]
  for (const [file, cmd] of checks) {
    if (existsSync(join(workspaceDir, file))) return cmd
  }
  return null
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'bugfix'
  )
}

function formatGoalMd(parsed: ParsedGoal, mode: BugfixMode): string {
  return [
    '# bugfix 目标',
    '',
    `模式：${mode === 'single-attempt' ? '单轮修复（single-attempt）' : '多轮续跑（multi-attempt）'}`,
    '',
    '## 目标（Given/When/Then）',
    '',
    parsed.goal,
    '',
    '## 验收标准',
    '',
    ...parsed.acceptanceCriteria.map((c) => `- ${c}`),
    '',
  ].join('\n')
}

async function writeAttempts(path: string, attempts: BugfixAttempt[]): Promise<void> {
  const lines = attempts.map((a) => JSON.stringify(a))
  await writeFile(path, lines.length ? lines.join('\n') + '\n' : '', 'utf-8')
}

async function writeDiffPatch(path: string, workspaceDir: string): Promise<void> {
  try {
    const { stdout } = await execFileAsync('git', ['diff'], { cwd: workspaceDir, timeout: 10_000 })
    await writeFile(path, stdout, 'utf-8')
  } catch {
    await writeFile(path, '# 无法生成 diff（非 git 仓库或 git 不可用）\n', 'utf-8')
  }
}

function formatResultMd(
  parsed: ParsedGoal,
  result: { status: BugfixStatus; attempts: BugfixAttempt[]; diffSummary: string; testOutput: string },
): string {
  const statusLabel =
    result.status === 'achieved'
      ? '已达成'
      : result.status === 'exhausted'
        ? '推进路径耗尽（未达成）'
        : '未达成（单轮模式）'
  return [
    '# bugfix 结果',
    '',
    `状态：${statusLabel}（${result.status}）`,
    `尝试轮数：${result.attempts.length}`,
    '',
    '## diff 摘要',
    '',
    '```',
    result.diffSummary,
    '```',
    '',
    '## 测试输出（最后一次验证）',
    '',
    '```',
    result.testOutput.slice(0, 3000) || '（无）',
    '```',
    '',
    '## 目标',
    '',
    parsed.goal,
    '',
  ].join('\n')
}
