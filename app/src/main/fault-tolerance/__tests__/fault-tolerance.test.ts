/* ============================================================
 * v0.14.0 Task 5.10 — 容错分级模块单测
 *
 * 覆盖：
 *   1. 4 类错误归类（llm-fatal / non-retryable-tool / retryable-tool / unknown）
 *   2. 重试编排（全部成功 / 第 2 次成功 / 全部失败 共 3 个 case）
 *   3. 替代匹配（无替代 / 找到替代 / 当前 skill 自己被排除）
 *   4. 影响判断（LLM 路径 + 规则版 fallback）
 *   5. 5 档链路：覆盖「替代成功」「不影响后续」「LLM 致命 3 种主路径」
 *
 * 运行方式：
 *   cd app
 *   ./node_modules/.bin/tsx \
 *     --experimental-loader ./src/test/electron-mock-loader.mjs \
 *     --test src/main/fault-tolerance/__tests__/fault-tolerance.test.ts
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyError, isFaultError, RETRIES_EXHAUSTED_CODE } from '../classify.js'
import { retryWithBackoff, DEFAULT_BACKOFF_MS, DEFAULT_MAX_ATTEMPTS } from '../retry-with-backoff.js'
import { findAlternative, staticDependencyBlocks, scoreSkill } from '../alternative-skill-matcher.js'
import { analyzeImpact, parseImpactJson } from '../impact-analyzer.js'
import { runFaultTolerant, __setInvokeSkillForTest } from '../run-fault-tolerant.js'
import type { PlanItem } from '@shared/types/task'
import type { Skill } from '@shared/types/agent'
import type { LlmAdapter } from '../../llm/adapter.js'
import type { LlmCompleteResponse } from '../../llm/adapter.js'
import type { SkillRegistry } from '../types.js'

/* ============================================================
 * 1. 4 类错误归类
 * ============================================================ */
test('classify: HTTP 5xx → llm-fatal', () => {
  const err = Object.assign(new Error('upstream error'), { status: 502 })
  const f = classifyError(err, { provider: 'openai' })
  assert.equal(f.originalKind, 'llm-fatal')
  assert.equal(f.code, 'llm-502')
  assert.equal(f.llmProvider, 'openai')
  assert.equal(f.httpStatus, 502)
})

test('classify: HTTP 429 → llm-fatal', () => {
  const err = Object.assign(new Error('rate limit'), { status: 429 })
  const f = classifyError(err, { provider: 'anthropic' })
  assert.equal(f.originalKind, 'llm-fatal')
  assert.equal(f.code, 'llm-429')
})

test('classify: model self-reported failure (text) → llm-fatal', () => {
  const f = classifyError('model overloaded', { provider: 'openai' })
  assert.equal(f.originalKind, 'llm-fatal')
  assert.equal(f.code, 'llm-self-reported')
})

test('classify: empty response → llm-fatal', () => {
  const f = classifyError('empty response from upstream', { provider: 'openai' })
  assert.equal(f.originalKind, 'llm-fatal')
})

test('classify: ctx.httpStatus 5xx → llm-fatal (即使 err 本身无 status)', () => {
  const f = classifyError(new Error('boom'), { httpStatus: 503, provider: 'openai' })
  assert.equal(f.originalKind, 'llm-fatal')
  assert.equal(f.code, 'llm-503')
})

test('classify: 400 invalid parameter → non-retryable-tool', () => {
  const err = Object.assign(new Error('invalid argument'), { code: 'ERR_INVALID_ARGUMENT' })
  const f = classifyError(err, { toolName: 'file-reader' })
  assert.equal(f.originalKind, 'non-retryable-tool')
  assert.equal(f.toolName, 'file-reader')
})

test('classify: 403 forbidden → non-retryable-tool', () => {
  const err = Object.assign(new Error('forbidden'), { status: 403 })
  const f = classifyError(err, { toolName: 'shell' })
  assert.equal(f.originalKind, 'non-retryable-tool')
})

test('classify: 用户拒绝文案 → non-retryable-tool', () => {
  const f = classifyError('用户拒绝执行', { toolName: 'shell' })
  assert.equal(f.originalKind, 'non-retryable-tool')
})

test('classify: ETIMEDOUT → retryable-tool', () => {
  const err = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })
  const f = classifyError(err, { toolName: 'fetch-url' })
  assert.equal(f.originalKind, 'retryable-tool')
  assert.equal(f.toolName, 'fetch-url')
})

test('classify: 502/503/504 → retryable-tool', () => {
  for (const status of [502, 503, 504]) {
    const err = Object.assign(new Error('upstream'), { status })
    const f = classifyError(err, { toolName: 'web-search' })
    assert.equal(f.originalKind, 'retryable-tool', `status ${status} should be retryable-tool`)
  }
})

test('classify: timeout 文案 → retryable-tool', () => {
  const f = classifyError('mcp 工具调用超时', { toolName: 'kb-search' })
  assert.equal(f.originalKind, 'retryable-tool')
})

test('classify: unknown 错误 → unknown', () => {
  const f = classifyError('just a generic thing', { toolName: 'foo' })
  assert.equal(f.originalKind, 'unknown')
})

test('classify: unknown 错误缺省 → unknown', () => {
  const f = classifyError(new Error('whatever'))
  assert.equal(f.originalKind, 'unknown')
})

test('isFaultError: 正确识别', () => {
  const good = classifyError('boom', { toolName: 'x' })
  assert.equal(isFaultError(good), true)
  assert.equal(isFaultError(new Error('x')), false)
  assert.equal(isFaultError(null), false)
  assert.equal(isFaultError('plain string'), false)
})

/* ============================================================
 * 2. 重试编排（全部成功 / 第 2 次成功 / 全部失败）
 * ============================================================ */
test('retry: 全部成功 — 第一次就成功', async () => {
  const r = await retryWithBackoff(async () => 42, {
    // 退避可不等待（设 0 数组即可）
    backoffMs: [0, 0, 0],
  })
  assert.equal(r.value, 42)
  assert.equal(r.attempts.length, 1)
  assert.equal(r.attempts[0]!.ok, true)
})

test('retry: 第 2 次成功', async () => {
  let calls = 0
  const r = await retryWithBackoff(async () => {
    calls++
    if (calls < 2) {
      const err = Object.assign(new Error('boom'), { code: 'ETIMEDOUT' })
      throw err
    }
    return 'ok'
  }, {
    backoffMs: [0, 0, 0],
  })
  assert.equal(r.value, 'ok')
  assert.equal(r.attempts.length, 2)
  assert.equal(r.attempts[0]!.ok, false)
  assert.equal(r.attempts[0]!.error?.originalKind, 'retryable-tool')
  assert.equal(r.attempts[1]!.ok, true)
  assert.equal(calls, 2)
})

test('retry: 全部失败 — 抛 retries-exhausted FaultError', async () => {
  let calls = 0
  let capturedOnAttempt: number | null = null
  await assert.rejects(
    retryWithBackoff(async () => {
      calls++
      const err = Object.assign(new Error('still failing'), { code: 'ETIMEDOUT' })
      throw err
    }, {
      maxAttempts: 3,
      backoffMs: [0, 0, 0],
      onAttempt: (n, _err) => {
        capturedOnAttempt = n
      },
    }),
    (err: unknown) => {
      const f = isFaultError(err) ? err : null
      assert.ok(f, 'should throw FaultError')
      assert.equal(f!.code, RETRIES_EXHAUSTED_CODE)
      assert.equal(f!.originalKind, 'retryable-tool')
      return true
    },
  )
  assert.equal(calls, 3)
  assert.equal(capturedOnAttempt, 3)
})

test('retry: 不可重试错误直接抛（不消耗重试）', async () => {
  let calls = 0
  await assert.rejects(
    retryWithBackoff(async () => {
      calls++
      const err = Object.assign(new Error('bad input'), { code: 'ERR_INVALID_ARGUMENT' })
      throw err
    }, {
      maxAttempts: 3,
      backoffMs: [0, 0, 0],
    }),
    (err: unknown) => {
      const f = isFaultError(err) ? err : null
      assert.ok(f)
      // 不可重试错误原样抛出（带 attempts 信息）
      assert.notEqual(f!.code, RETRIES_EXHAUSTED_CODE)
      return true
    },
  )
  // 只调用一次
  assert.equal(calls, 1)
})

test('retry: LLM 致命异常直接抛（不消耗重试）', async () => {
  let calls = 0
  await assert.rejects(
    retryWithBackoff(async () => {
      calls++
      const err = Object.assign(new Error('upstream 500'), { status: 500 })
      throw err
    }, {
      maxAttempts: 3,
      backoffMs: [0, 0, 0],
    }),
    (err: unknown) => {
      const f = isFaultError(err) ? err : null
      assert.ok(f)
      assert.equal(f!.originalKind, 'llm-fatal')
      return true
    },
  )
  assert.equal(calls, 1)
})

test('retry: 默认 maxAttempts / backoffMs 正确', () => {
  assert.equal(DEFAULT_MAX_ATTEMPTS, 3)
  assert.deepEqual([...DEFAULT_BACKOFF_MS], [1000, 2000, 4000])
})

test('retry: AbortSignal 触发后立即终止', async () => {
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 5)
  let calls = 0
  await assert.rejects(
    retryWithBackoff(
      async () => {
        calls++
        const err = Object.assign(new Error('econnreset'), { code: 'ECONNRESET' })
        throw err
      },
      {
        maxAttempts: 3,
        backoffMs: [50, 50, 50],
        signal: ac.signal,
      },
    ),
    (err: unknown) => {
      assert.match((err as Error).message, /aborted/)
      return true
    },
  )
  // 中断之前最多调用 1 次
  assert.ok(calls <= 1)
})

/* ============================================================
 * 3. 替代匹配
 * ============================================================ */

function buildSkill(over: Partial<Skill> = {}): Skill {
  return {
    id: 'S-test.' + (over.id ?? 'unknown'),
    name: 'unknown',
    description: '',
    namespace: 'test',
    source: 'custom',
    enabled: true,
    ...over,
  }
}

const REGISTRY_EMPTY: SkillRegistry = {
  list: async () => [],
  get: async () => null,
}

test('findAlternative: 无替代 → 返回空', async () => {
  const r = await findAlternative('unknown-tool', REGISTRY_EMPTY)
  assert.deepEqual(r, [])
})

test('findAlternative: 找到替代 — 评分 top-3', async () => {
  const target: Skill = buildSkill({
    id: 'S-test.web-search',
    name: 'web-search',
    description: '在互联网上搜索关键词，返回前 N 条结果',
    tags: ['web', 'search'],
    namespace: 'core',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'number' } },
      required: ['query'],
    },
  })
  const alts: Skill[] = [
    buildSkill({
      id: 'S-test.fetch-url',
      name: 'fetch-url',
      description: '抓取指定 URL 的页面正文',
      tags: ['web', 'fetch'],
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
    }),
    buildSkill({
      id: 'S-test.session-search',
      name: 'session-search',
      description: '搜索历史任务',
      tags: ['memory', 'search'],
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    }),
    buildSkill({
      id: 'S-test.unrelated',
      name: 'unrelated',
      description: 'completely unrelated',
      tags: ['totally', 'different'],
      inputSchema: {
        type: 'object',
        properties: { nothing: { type: 'string' } },
        required: ['nothing'],
      },
    }),
  ]
  const reg: SkillRegistry = {
    list: async () => [target, ...alts],
    get: async (id) => [target, ...alts].find((s) => s.id === id) ?? null,
  }
  const r = await findAlternative('S-test.web-search', reg)
  assert.ok(r.length >= 1 && r.length <= 3, `top-3, got ${r.length}`)
  // 自己被排除
  assert.equal(r.find((m) => m.skillId === 'S-test.web-search'), undefined)
  // 分数都 ≥ 0.2
  for (const m of r) assert.ok(m.score >= 0.2)
})

test('findAlternative: 排除自己与 disabled', async () => {
  const target: Skill = buildSkill({
    id: 'S-test.web-search',
    name: 'web-search',
    description: 'search',
    tags: ['web'],
    enabled: true,
  })
  const self: Skill = buildSkill({
    id: 'S-test.web-search',
    name: 'web-search',
    description: 'search',
    tags: ['web'],
    enabled: true,
  })
  const disabled: Skill = buildSkill({
    id: 'S-test.web-search-2',
    name: 'web-search-2',
    description: 'search',
    tags: ['web'],
    enabled: false,
  })
  const reg: SkillRegistry = {
    list: async () => [target, self, disabled],
    get: async (id) => ([target, self, disabled].find((s) => s.id === id) ?? null),
  }
  const r = await findAlternative('S-test.web-search', reg)
  assert.equal(r.length, 0)
})

test('scoreSkill: 同 category + 高 schema 重叠 → 高分', () => {
  const a: Skill = buildSkill({
    id: 'a',
    name: 'web-search',
    description: 'search web',
    tags: ['web'],
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  })
  const b: Skill = buildSkill({
    id: 'b',
    name: 'web-search-2',
    description: 'search web',
    tags: ['web'],
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  })
  const m = scoreSkill(a, b)
  assert.equal(m.reasons.category, 1)
  assert.equal(m.reasons.schema, 1)
  assert.ok(m.score >= 0.9)
})

test('staticDependencyBlocks: 含依赖文案 → true', () => {
  const current: PlanItem = {
    id: 'p1',
    text: 'summarize',
    status: 'failed',
    createdAt: 1,
    updatedAt: 1,
  }
  const following: PlanItem[] = [
    {
      id: 'p2',
      text: '基于前一步结果生成报告（依赖 p1 的输出）',
      status: 'pending',
      createdAt: 2,
      updatedAt: 2,
    },
  ]
  const r = staticDependencyBlocks(following, current)
  assert.equal(r.blocksFollowers, true)
  assert.match(r.reason, /p2/)
})

test('staticDependencyBlocks: 无依赖文案 → false', () => {
  const current: PlanItem = {
    id: 'p1',
    text: 'summarize',
    status: 'failed',
    createdAt: 1,
    updatedAt: 1,
  }
  const following: PlanItem[] = [
    {
      id: 'p2',
      text: 'deploy site',
      status: 'pending',
      createdAt: 2,
      updatedAt: 2,
    },
  ]
  const r = staticDependencyBlocks(following, current)
  assert.equal(r.blocksFollowers, false)
})

test('staticDependencyBlocks: 空 following → false', () => {
  const current: PlanItem = {
    id: 'p1',
    text: 'a',
    status: 'failed',
    createdAt: 1,
    updatedAt: 1,
  }
  const r = staticDependencyBlocks([], current)
  assert.equal(r.blocksFollowers, false)
})

/* ============================================================
 * 4. 影响判断（LLM 路径 + 规则版 fallback）
 * ============================================================ */

function makeLlmAdapter(reply: string): LlmAdapter {
  return {
    name: 'fake',
    provider: 'openai',
    async complete(): Promise<LlmCompleteResponse> {
      return {
        content: reply,
        thought: '',
        action: null,
        tokensIn: 0,
        tokensOut: 0,
        finishReason: 'stop',
      }
    },
  }
}

test('analyzeImpact: LLM 路径返回 JSON → 透传', async () => {
  const current: PlanItem = {
    id: 'p1',
    text: 'a',
    status: 'failed',
    createdAt: 1,
    updatedAt: 1,
  }
  const following: PlanItem[] = [
    { id: 'p2', text: 'b', status: 'pending', createdAt: 2, updatedAt: 2 },
  ]
  const a = makeLlmAdapter('{"blocksFollowers": true, "reason": "p2 needs p1"}')
  const r = await analyzeImpact(current, following, { adapter: a })
  assert.equal(r.blocksFollowers, true)
  assert.equal(r.reason, 'p2 needs p1')
  assert.ok(r.latencyMs >= 0)
})

test('analyzeImpact: LLM 路径返回脏 JSON → fallback 规则版', async () => {
  const current: PlanItem = {
    id: 'p1',
    text: 'a',
    status: 'failed',
    createdAt: 1,
    updatedAt: 1,
  }
  const following: PlanItem[] = [
    {
      id: 'p2',
      text: '依赖 p1',
      status: 'pending',
      createdAt: 2,
      updatedAt: 2,
    },
  ]
  const a = makeLlmAdapter('not even json')
  const r = await analyzeImpact(current, following, { adapter: a })
  // fallback 规则版应能识别「依赖」
  assert.equal(r.blocksFollowers, true)
})

test('analyzeImpact: 注入 LLM 抛错 → fallback 规则版', async () => {
  const current: PlanItem = {
    id: 'p1',
    text: 'a',
    status: 'failed',
    createdAt: 1,
    updatedAt: 1,
  }
  const following: PlanItem[] = [
    {
      id: 'p2',
      text: 'depends on p1 — 后续步骤',
      status: 'pending',
      createdAt: 2,
      updatedAt: 2,
    },
  ]
  const errAdapter: LlmAdapter = {
    name: 'fake',
    provider: 'openai',
    async complete() {
      throw new Error('timeout')
    },
  }
  const r = await analyzeImpact(current, following, { adapter: errAdapter })
  assert.equal(r.blocksFollowers, true)
  assert.match(r.reason, /dependencies|depends|p1|p2|前置|依赖/)
})

test('analyzeImpact: 无 adapter → 规则版', async () => {
  const current: PlanItem = {
    id: 'p1',
    text: 'a',
    status: 'failed',
    createdAt: 1,
    updatedAt: 1,
  }
  const following: PlanItem[] = [
    {
      id: 'p2',
      text: 'depends on p1',
      status: 'pending',
      createdAt: 2,
      updatedAt: 2,
    },
  ]
  const r = await analyzeImpact(current, following)
  assert.equal(r.blocksFollowers, true)
})

test('parseImpactJson: 正常 JSON', () => {
  const r = parseImpactJson('{"blocksFollowers": false, "reason": "ok"}')
  assert.deepEqual(r, { blocksFollowers: false, reason: 'ok' })
})

test('parseImpactJson: 字段缺失 → null', () => {
  assert.equal(parseImpactJson('{"reason": "x"}'), null)
  assert.equal(parseImpactJson('{"blocksFollowers": true}'), null)
  assert.equal(parseImpactJson('not json'), null)
})

test('parseImpactJson: 模型输出含多余文本也能解析', () => {
  const r = parseImpactJson('思考后回答：{"blocksFollowers": true, "reason": "ok"} 完毕')
  assert.deepEqual(r, { blocksFollowers: true, reason: 'ok' })
})

/* ============================================================
 * 5. 5 档链路（编排器 end-to-end）
 * ============================================================ */

test('runFaultTolerant: 替代成功 → alternative-succeeded', async () => {
  // 始终失败 → 替代成功
  const targetFailure = new Error('ETIMEDOUT') as Error & { code: string }
  targetFailure.code = 'ETIMEDOUT'
  // 注入 invokeSkill 桩：替代 skill 直接返回 instruction（模拟真实 invokeSkill 对 custom skill 的处理）
  __setInvokeSkillForTest(async (_skillId, _args, _skillCtx) => ({
    result: { instruction: 'mock alternative skill instruction' },
    summary: 'fake alternative',
  }))
  try {
    const reg: SkillRegistry = {
      list: async () => [
        buildSkill({
          id: 'S-test.web-search',
          name: 'web-search',
          description: 'search',
          tags: ['web'],
          enabled: true,
          inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        }),
        buildSkill({
          id: 'S-test.web-search-alt',
          name: 'web-search-alt',
          description: 'search',
          tags: ['web'],
          enabled: true,
          inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        }),
      ],
      get: async (id) => {
        const skills = [
          buildSkill({
            id: 'S-test.web-search',
            name: 'web-search',
            description: 'search',
            tags: ['web'],
            enabled: true,
            inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
          }),
          buildSkill({
            id: 'S-test.web-search-alt',
            name: 'web-search-alt',
            description: 'search',
            tags: ['web'],
            enabled: true,
            inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
          }),
        ]
        return skills.find((s) => s.id === id) ?? null
      },
    }
    const onPlanItemCalls: Array<{ id: string; status: string }> = []
    const r = await runFaultTolerant(
      async () => {
        throw targetFailure
      },
      {
        taskId: 't1',
        planItemId: 'p1',
        planItem: {
          id: 'p1',
          text: 'do thing',
          status: 'running',
          createdAt: 1,
          updatedAt: 1,
        },
        followingPlanItems: [],
        toolCall: { toolName: 'S-test.web-search', args: { query: 'x' } },
      },
      {
        registry: reg,
        retry: { maxAttempts: 3, backoffMs: [0, 0, 0] },
        onPlanItemFailed: async (id, _tid, _note) => {
          onPlanItemCalls.push({ id, status: 'failed' })
        },
      },
    )
    // 替代成功（无 builtin handler 的 fallback 也算成功）
    assert.equal(r.outcome, 'alternative-succeeded')
    assert.equal(r.alternativeSkillId, 'S-test.web-search-alt')
    assert.match(r.note ?? '', /web-search-alt/)
    // 失败回调不应被调用（替代成功是 done 备注）
    assert.equal(onPlanItemCalls.length, 0)
  } finally {
    __setInvokeSkillForTest(null)
  }
})

test('runFaultTolerant: 重试成功 → retry-succeeded', async () => {
  let calls = 0
  const r = await runFaultTolerant(
    async () => {
      calls++
      if (calls < 2) {
        const err = Object.assign(new Error('econnreset'), { code: 'ECONNRESET' })
        throw err
      }
      return 'value-1'
    },
    {
      taskId: 't1',
      toolCall: { toolName: 'S-test.fetch-url', args: { url: 'https://x' } },
    },
    {
      retry: { maxAttempts: 3, backoffMs: [0, 0, 0] },
      registry: REGISTRY_EMPTY,
    },
  )
  assert.equal(r.outcome, 'retry-succeeded')
  assert.equal(r.value, 'value-1')
  assert.equal(calls, 2)
})

test('runFaultTolerant: LLM 致命 → llm-fatal（不弹卡）', async () => {
  const r = await runFaultTolerant(
    async () => {
      const err = Object.assign(new Error('upstream 500'), { status: 500 })
      throw err
    },
    {
      taskId: 't1',
      toolCall: { toolName: 'web-search', args: { query: 'x' } },
    },
    {
      retry: { maxAttempts: 3, backoffMs: [0, 0, 0] },
      registry: REGISTRY_EMPTY,
    },
  )
  assert.equal(r.outcome, 'llm-fatal')
  assert.equal(r.fault?.originalKind, 'llm-fatal')
})

test('runFaultTolerant: 重试耗尽 + 无替代 + 不影响后续 → no-impact', async () => {
  let onFailedCalled = 0
  const r = await runFaultTolerant(
    async () => {
      const err = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })
      throw err
    },
    {
      taskId: 't1',
      planItemId: 'p1',
      planItem: {
        id: 'p1',
        text: 'a',
        status: 'running',
        createdAt: 1,
        updatedAt: 1,
      },
      followingPlanItems: [
        { id: 'p2', text: 'deploy site', status: 'pending', createdAt: 2, updatedAt: 2 },
        { id: 'p3', text: 'notify user', status: 'pending', createdAt: 3, updatedAt: 3 },
      ],
      toolCall: { toolName: 'S-test.web-search', args: {} },
    },
    {
      retry: { maxAttempts: 3, backoffMs: [0, 0, 0] },
      registry: REGISTRY_EMPTY,
      onPlanItemFailed: async () => {
        onFailedCalled++
      },
    },
  )
  assert.equal(r.outcome, 'no-impact')
  assert.equal(onFailedCalled, 1)
})

test('runFaultTolerant: 重试耗尽 + 无替代 + 影响后续 → impacts-followers', async () => {
  let cardPushed: { fault: unknown; impact: unknown } | null = null
  // 注入 pushFaultCard hook：通过监听 broadcast 不可行，这里直接断言 outcome
  const r = await runFaultTolerant(
    async () => {
      const err = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })
      throw err
    },
    {
      taskId: 't1',
      planItemId: 'p1',
      planItem: {
        id: 'p1',
        text: 'a',
        status: 'running',
        createdAt: 1,
        updatedAt: 1,
      },
      followingPlanItems: [
        {
          id: 'p2',
          text: 'b（依赖 p1 输出）',
          status: 'pending',
          createdAt: 2,
          updatedAt: 2,
        },
      ],
      toolCall: { toolName: 'S-test.web-search', args: {} },
    },
    {
      retry: { maxAttempts: 2, backoffMs: [0, 0] },
      registry: REGISTRY_EMPTY,
      onPlanItemFailed: async () => {
        // 在弹卡分支里不应被调用
        cardPushed = null
      },
    },
  )
  assert.equal(r.outcome, 'impacts-followers')
})
