/* ============================================================
 * fix-react-loop-stale-task-state-async-robustness — events.ts 单测
 *
 * 覆盖：broadcast 函数全部包 try/catch，失败仅 warn 不抛错。
 *
 * 策略：源码静态断言（事件广播函数本身依赖 electron window 在纯 node
 * 环境不可用，这里通过校验源码 try/catch 包裹保证契约）。
 *
 * 运行（cwd=app）：
 *   npx tsx --test src/main/agent/__tests__/events-async-robustness.test.ts
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const EVENTS_PATH = fileURLToPath(new URL('../events.ts', import.meta.url))
const eventsSrc = readFileSync(EVENTS_PATH, 'utf-8')

/** 提取某个 export function 的源码片段 */
function functionBody(src: string, name: string): string {
  const re = new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\s*\\([^)]*\\)\\s*(?::[^{]+)?\\s*\\{`, 'g')
  const m = re.exec(src)
  if (!m) return ''
  // 找到匹配的右大括号
  let depth = 1
  let i = m.index + m[0].length
  while (i < src.length && depth > 0) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') depth--
    i++
  }
  return src.slice(m.index, i)
}

test('events: broadcastTaskStatus 包 try/catch + warn', () => {
  const body = functionBody(eventsSrc, 'broadcastTaskStatus')
  assert.match(body, /try\s*\{[\s\S]*broadcast\('task:status'/)
  assert.match(body, /catch[\s\S]*logger\.warn/)
})

test('events: broadcastReActEvent 包 try/catch', () => {
  const body = functionBody(eventsSrc, 'broadcastReActEvent')
  assert.match(body, /try\s*\{[\s\S]*broadcast\('task:event'/)
  assert.match(body, /catch[\s\S]*logger\.warn/)
})

test('events: broadcastStep 包 try/catch（broadcast 失败仅 warn）', () => {
  const body = functionBody(eventsSrc, 'broadcastStep')
  // 必须有 try { broadcast } 结构
  assert.match(body, /try\s*\{[\s\S]*broadcast\('task:step'/)
  assert.match(body, /catch[\s\S]*logger\.warn/)
})

test('events: broadcastToolProgress 包 try/catch', () => {
  const body = functionBody(eventsSrc, 'broadcastToolProgress')
  assert.match(body, /try\s*\{[\s\S]*broadcast\('task:progress'/)
  assert.match(body, /catch[\s\S]*logger\.warn/)
})

test('events: clearToolProgress 包 try/catch', () => {
  const body = functionBody(eventsSrc, 'clearToolProgress')
  // 函数体内必须出现 try 和 broadcast
  assert.match(body, /try\s*\{[\s\S]*broadcast\('task:progress:clear'/)
  assert.match(body, /catch[\s\S]*logger\.warn/)
})