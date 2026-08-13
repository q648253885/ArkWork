/* ============================================================
 * fix-react-loop-stale-task-state-async-robustness — engine.ts 单测
 *
 * 覆盖：
 *   1. RunOptions 新增 startGeneration 字段
 *   2. emitEvent 包 try/catch，broadcast 失败仅 warn
 *   3. runReActLoop 入口 try/catch 保留 AbortError → handleAbort 分支
 *
 * 策略：源码静态断言（engine.ts 依赖大量 electron + LLM 模块无法在纯 node 环境跑）
 *
 * 运行（cwd=app）：
 *   npx tsx --test src/main/agent/__tests__/engine-async-robustness.test.ts
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ENGINE_PATH = fileURLToPath(new URL('../engine.ts', import.meta.url))
const engineSrc = readFileSync(ENGINE_PATH, 'utf-8')

test('engine: RunOptions 新增 startGeneration?: number 字段', () => {
  assert.match(engineSrc, /export\s+interface\s+RunOptions\s*\{[\s\S]*startGeneration\?:\s*number[\s\S]*\}/)
})

test('engine: emitEvent 包 try/catch，broadcast 失败仅 warn', () => {
  assert.match(
    engineSrc,
    /async\s+function\s+emitEvent\([\s\S]*?try\s*\{[\s\S]*broadcast\('task:event'[\s\S]*?\}\s*catch\s*\([\s\S]*?logger\.warn\([\s\S]*?emitEvent broadcast failed/s,
  )
})

test('engine: runReActLoop catch 分支 AbortError → handleAbort', () => {
  // 必须有：signal.aborted || err.name === 'AbortError' → handleAbort 路径
  assert.match(
    engineSrc,
    /signal\.aborted\s*\|\|\s*\(err\s+as\s+Error\)\?\.name\s*===\s*'AbortError'[\s\S]*handleAbort/,
  )
})

test('engine: catch 分支写 failed + errorMessage', () => {
  // 必须在 catch 分支调用 updateTask({ status: 'failed' })
  assert.match(
    engineSrc,
    /catch\s*\(\s*err\s*\)\s*\{[\s\S]*?emitEvent\(\s*\{\s*type:\s*'task_failed'[\s\S]*?updateTask\(task\.id,\s*\{\s*status:\s*'failed'[\s\S]*?broadcastTaskStatus/,
  )
})

test('engine: ask_user 校验 suggestions < 2 时拒绝并写 observation + act_end failed', () => {
  // v0.16.x：硬约束 — ask_user.suggestions 必须 2~4 个有效项；不合规则引擎拒绝、
  // 写 L1 observation 让 LLM 重试，不暂停任务。覆盖 issue "执行大项目时
  // 没有让用户选择选项，只能手动输入"。
  assert.match(
    engineSrc,
    /ask_user\.suggestions\s+必须是\s+2~4\s+个有效项/s,
  )
  // 必须含 invalidAskUser 分支判断
  assert.match(engineSrc, /const\s+invalidAskUser\s*=/)
  // 不合规时必须 emit act_end with ok=false
  assert.match(
    engineSrc,
    /invalidAskUser[\s\S]*?ok:\s*false[\s\S]*?errorMessage:\s*reason/s,
  )
  // 不合规时必须 continue（不暂停任务，让下一轮 Reason 重试）
  assert.match(engineSrc, /invalidAskUser[\s\S]*?continue/)
  // 合规时仍走原有 ask_user 暂停分支（验证至少一处保留）
  assert.match(engineSrc, /await\s+updateTask\(task\.id,\s*\{\s*status:\s*'paused'\s*\}/)
})

test('seed: ask_user 工具 description 强约束必须传 suggestions', () => {
  // 工具描述必须显式声明"必须附带 suggestions"
  const seedPath = fileURLToPath(new URL('../../store/seed.ts', import.meta.url))
  const seedSrc = readFileSync(seedPath, 'utf-8')
  assert.match(
    seedSrc,
    /id:\s*'S-core\.ask-user'[\s\S]*?description:\s*\n?\s*['"`].*必须.*suggestions.*2~4/s,
  )
  // inputSchema.required 必须含 suggestions
  assert.match(
    seedSrc,
    /S-core\.ask-user'[\s\S]*?required:\s*\[\s*'question',\s*'suggestions'\s*\]/s,
  )
  // suggestions 必须有 minItems=2, maxItems=4
  assert.match(
    seedSrc,
    /minItems:\s*2,\s*\n?\s*maxItems:\s*4/s,
  )
})