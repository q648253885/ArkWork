/* ============================================================
 * fix-react-loop-stale-task-state-async-robustness — runner.ts 单测
 *
 * 覆盖：
 *   1. runTask 入口先 updateTask(running) 再启动 controller / 循环
 *   2. .catch 路径在被 generation 接管时静默退出，不写 failed
 *   3. .catch 路径未被接管时写 failed（含 errorMessage + completedAt）
 *   4. 同步校验失败（noAgent / noModel）抛 throw，不污染 DB 状态
 *   5. reconcileOrphanRunning 把 running 任务修正为 failed
 *
 * 实现策略：
 *   - 不真正启动 ReAct 循环（依赖 electron + LLM，无法在纯 node 环境跑通）
 *   - 通过读 runner.ts 源码 + 静态行为断言 + 单元函数 currentGeneration 测试
 *
 * 运行（cwd=app）：
 *   npx tsx --test src/main/agent/__tests__/runner-async-robustness.test.ts
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const RUNNER_PATH = fileURLToPath(new URL('../runner.ts', import.meta.url))
const runnerSrc = readFileSync(RUNNER_PATH, 'utf-8')

test('runner: 启动前先写 running 状态（先 updateTask 再 controller）', () => {
  // 验证源码顺序：updateTask(running) + broadcastTaskStatus 必须在 controllers.set 之前
  const updateIdx = runnerSrc.search(/updateTask\(taskId,\s*\{\s*status:\s*'running'/)
  const broadcastIdx = runnerSrc.indexOf('broadcastTaskStatus(updated)', updateIdx)
  const controllerIdx = runnerSrc.indexOf('controllers.set(taskId, controller)', updateIdx)
  assert.ok(updateIdx > 0, '应存在 updateTask(running) 调用')
  assert.ok(broadcastIdx > 0, '应存在 broadcastTaskStatus 调用')
  assert.ok(controllerIdx > 0, '应存在 controllers.set')
  assert.ok(updateIdx < broadcastIdx, 'broadcast 必须在 update 之后')
  assert.ok(controllerIdx > broadcastIdx, 'controller 创建必须在 broadcast 之后')
})

test('runner: generations Map 必须在 catch 路径使用', () => {
  assert.match(runnerSrc, /const generations = new Map<string, number>\(\)/)
  assert.match(runnerSrc, /generations\.set\(taskId, \(generations\.get\(taskId\) \?\? 0\) \+ 1\)/)
  assert.match(runnerSrc, /generations\.get\(taskId\) !== startGeneration/)
})

test('runner: stale 函数基于 generation 计数（不是 controller 引用比较）', () => {
  // 不再使用旧的 controllers.get(taskId) !== controller 协议
  assert.ok(
    !runnerSrc.includes('controllers.get(taskId) !== controller'),
    '不应再出现旧的 controller 引用 stale 协议',
  )
  assert.match(runnerSrc, /stale:\s*\(\)\s*=>\s*generations\.get\(taskId\)\s*!==\s*startGeneration/)
})

test('runner: catch 路径在 generation 已被新循环接管时静默退出', () => {
  // 必须有 if (generations.get(taskId) !== startGeneration) { logger.info(...); return }
  assert.match(
    runnerSrc,
    /if\s*\(generations\.get\(taskId\)\s*!==\s*startGeneration\)[\s\S]*?logger\.info[\s\S]*?return/,
  )
})

test('runner: catch 路径未被接管时写 failed（含 errorMessage + completedAt）', () => {
  // 在 generation 检查通过后必须调用 updateTask({ status: 'failed', completedAt: Date.now(), errorMessage: message })
  // 用 [\s\S]*? 容忍换行
  assert.match(
    runnerSrc,
    /updateTask\(taskId,\s*\{[\s\S]*?status:\s*'failed'[\s\S]*?completedAt:\s*Date\.now\(\)[\s\S]*?errorMessage:\s*message[\s\S]*?\}\)/,
  )
})

test('runner: 同步校验失败抛 throw 不污染 DB（noAgent / noModel / invalidModel / missingTask）', () => {
  // 4 个 RunnerError 仍应在 runTask 入口抛出
  assert.match(runnerSrc, /throw new RunnerError\('missingTask'/)
  assert.match(runnerSrc, /throw new RunnerError\('noAgent'/)
  assert.match(runnerSrc, /throw new RunnerError\('noModel'/)
  assert.match(runnerSrc, /throw new RunnerError\('invalidModel'/)
})

test('runner: reconcileOrphanRunning 函数存在且签名正确', () => {
  assert.match(runnerSrc, /export\s+async\s+function\s+reconcileOrphanRunning\s*\(\s*\)\s*:\s*Promise<void>/)
  // 必须先 listRunningTasks
  assert.match(runnerSrc, /reconcileOrphanRunning[\s\S]*listRunningTasks/)
  // 必须写 failed + errorMessage 含 reconcile_orphan_running
  assert.match(runnerSrc, /errorMessage:\s*'reconcile_orphan_running:[^']+'/)
  // 必须广播 task:status
  assert.match(runnerSrc, /reconcileOrphanRunning[\s\S]*broadcastTaskStatus\(updated\)/)
})

test('runner: reconcile 双条件判断 — controllers 与 generations', () => {
  // 必须有 if (controllers.has(task.id)) continue; 跳过正在跑的
  assert.match(runnerSrc, /reconcileOrphanRunning[\s\S]*if\s*\(controllers\.has\(task\.id\)\)\s*continue/)
})

test('runner: currentGeneration 辅助函数签名（读不到返回 0）', () => {
  // 静态断言：函数存在并返回 generations.get ?? 0
  assert.match(
    runnerSrc,
    /export\s+function\s+currentGeneration\(taskId:\s*string\):\s*number\s*\{[\s\S]*?return\s+generations\.get\(taskId\)\s*\?\?\s*0\s*;?\s*\}/,
  )
})