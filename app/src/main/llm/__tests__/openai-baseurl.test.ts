/* ============================================================
 * v0.31.1 — OpenAI 兼容端点 baseURL 归一化单测（TC-URL-001..006）
 *
 * 缺陷背景（用户实测）：OpenAI 官方 SDK 在 baseURL 后自动拼
 * `/chat/completions`；用户在设置里填的是**完整对话端点**
 *（…/v1/chat/completions 结尾）时，SDK 二次拼接成
 * `…/chat/completions/chat/completions` → 404。
 *
 * 修复：normalizeOpenAIBaseURL —— 尾部 `/chat/completions` 剥掉
 * （大小写不敏感、容忍尾斜杠），其余原样；OpenAIAdapter 构造与
 * registry 的 /models 连通性检查共用本函数（单一口径）。
 *
 * 载体：openai.ts 无 electron 依赖链，node:test 直连导入。
 * 运行（cwd=app）：
 *   node scripts/run-tests.mjs llm/__tests__
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeOpenAIBaseURL } from '../openai.js'

test('TC-URL-001 base 形式原样保留（SDK 行为不变）', () => {
  assert.equal(normalizeOpenAIBaseURL('https://api.openai.com/v1'), 'https://api.openai.com/v1')
  assert.equal(normalizeOpenAIBaseURL('https://api.deepseek.com'), 'https://api.deepseek.com')
})

test('TC-URL-002 完整对话端点剥掉 /chat/completions（本缺陷主场景）', () => {
  assert.equal(
    normalizeOpenAIBaseURL('https://api.example.com/v1/chat/completions'),
    'https://api.example.com/v1',
  )
})

test('TC-URL-003 容忍尾斜杠与大小写混写', () => {
  assert.equal(
    normalizeOpenAIBaseURL('https://api.example.com/v1/chat/completions/'),
    'https://api.example.com/v1',
  )
  assert.equal(
    normalizeOpenAIBaseURL('https://api.example.com/v1/Chat/Completions'),
    'https://api.example.com/v1',
  )
})

test('TC-URL-004 首尾空白先裁剪再判断', () => {
  assert.equal(
    normalizeOpenAIBaseURL('  https://api.example.com/v1/chat/completions  '),
    'https://api.example.com/v1',
  )
})

test('TC-URL-005 undefined / 空串原样返回（默认值链不受影响）', () => {
  assert.equal(normalizeOpenAIBaseURL(undefined), undefined)
  assert.equal(normalizeOpenAIBaseURL(''), '')
  assert.equal(normalizeOpenAIBaseURL('   '), '   ')
})

test('TC-URL-006 路径中段出现 chat/completions 不误伤（只看结尾）', () => {
  assert.equal(
    normalizeOpenAIBaseURL('https://gw.example.com/chat/completions/v1'),
    'https://gw.example.com/chat/completions/v1',
  )
})
