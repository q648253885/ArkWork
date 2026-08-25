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
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// v0.27.0 R2：engine.ts 已拆分为 engine/ 目录，源码契约改为拼接全部模块后断言
const ENGINE_DIR = fileURLToPath(new URL('../engine/', import.meta.url))
const engineSrc = readdirSync(ENGINE_DIR)
  .filter((f) => f.endsWith('.ts'))
  .sort()
  .map((f) => readFileSync(ENGINE_DIR + f, 'utf-8'))
  .join('\n')

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
  // 必须在 catch 分支调用 emitEvent(task_failed) + updateTask({ status: 'failed' }) + broadcastTaskStatus
  // 注：emitEvent 携带 task.id 首参（v0.8.x 后统一签名），test 断言跟随实际代码
  assert.match(
    engineSrc,
    /catch\s*\(\s*err\s*\)\s*\{[\s\S]*?emitEvent\(\s*task\.id,\s*\{\s*type:\s*'task_failed'[\s\S]*?updateTask\(task\.id,\s*\{\s*status:\s*'failed'[\s\S]*?broadcastTaskStatus/,
  )
})

test('engine: ask_user 校验 question 缺失/空时注入兜底（不再拒绝重试）', () => {
  // v0.25.2：question 缺失/空 → 注入兜底问题后正常暂停，避免「拒绝重试 → 空转报错」。
  // 必须含 hasQuestion 判定
  assert.match(engineSrc, /hasQuestion\s*=\s*typeof\s+rawQuestion\s*===\s*['"]string['"]/)
  // 缺问题走 buildFallbackAskUserQuestion 兜底（三目 false 分支 + 外层 guard）
  assert.match(engineSrc, /buildFallbackAskUserQuestion\(\)/)
  assert.match(engineSrc, /if\s*\(!\s*hasQuestion\s*\)/)
  assert.match(engineSrc, /function\s+buildFallbackAskUserQuestion\(\)[\s\S]*?return\s*['"]/)
  // 行为不再走 ok:false 拒绝，正常 pause
  assert.match(engineSrc, /await\s+updateTask\(task\.id,\s*\{\s*status:\s*['"]paused['"]\s*\}/)
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