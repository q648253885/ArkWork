/* ============================================================
 * v0.19.0 M4 — 工具三段流水线（tool-pipeline）单测
 *
 * 覆盖验收断言（§7.3）：
 *  1. runToolPipeline：approve → execute → post；deny → 跳过 execute
 *  2. confirmBuiltinSkill 审批策略：
 *     - 只读直通（shell ls / file-reader）：approve 且不弹确认
 *     - 轻写确认（file-writer）：触发 confirm；shell 轻写按 mode 策略
 *     - 高风险确认（shell rm tmp）：每次 confirm
 *     - 拒绝（黑名单 / 命令过长 / plan 模式写）：deny
 *
 * 运行（cwd=app）：
 *   ./node_modules/.bin/tsx \
 *     --experimental-loader ./src/test/electron-mock-loader.mjs \
 *     --test src/main/agent/__tests__/tool-pipeline.test.ts
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runToolPipeline, type ToolPipelineContext } from '../tool-pipeline.js'
import { confirmBuiltinSkill, type SkillContext, type ConfirmOutcome } from '../registry.js'
import type { Skill } from '@shared/types/agent'
import type { ToolConfirmRequest } from '@shared/types/ipc'
import type { Task } from '@shared/types/task'

function makeTask(id = 'T-1'): Task {
  return { id, input: { text: 'hello' } } as Task
}

function makeSkill(builtinHandler?: Skill['builtinHandler'], needsConfirmation = true): Skill {
  return {
    id: `S-core.${builtinHandler ?? 'shell'}`,
    name: builtinHandler ?? 'shell',
    description: 'test',
    namespace: 'core',
    source: 'builtin',
    enabled: true,
    ...(builtinHandler ? { builtinHandler } : {}),
    needsConfirmation,
  }
}

function makeCtx(confirm?: SkillContext['confirm'], workspaceDir = '/work'): SkillContext {
  return {
    taskId: 'T-1',
    signal: new AbortController().signal,
    workspaceDir,
    confirm,
  }
}

function makeConfirm(respond: ConfirmOutcome = { allowed: true }) {
  const calls: ToolConfirmRequest[] = []
  const fn = async (req: ToolConfirmRequest): Promise<ConfirmOutcome> => {
    calls.push(req)
    return respond
  }
  return { fn, calls }
}

/* ---------- runToolPipeline：三段编排 ---------- */

test('runToolPipeline: pre approve → execute → post', async () => {
  const ctx = {} as ToolPipelineContext
  const order: string[] = []
  const out = await runToolPipeline(ctx, {
    pre: async () => {
      order.push('pre')
      return { verdict: 'approve' }
    },
    execute: async () => {
      order.push('execute')
      return { ok: true }
    },
    post: async (_c, raw) => {
      order.push('post')
      return { result: raw, summary: 'done' }
    },
  })
  assert.deepEqual(order, ['pre', 'execute', 'post'])
  assert.deepEqual(out, { result: { ok: true }, summary: 'done' })
})

test('runToolPipeline: pre deny → 跳过 execute/post，返回 deny 的 result 与 reason', async () => {
  const ctx = {} as ToolPipelineContext
  let executed = false
  let posted = false
  const out = await runToolPipeline(ctx, {
    pre: async () => ({ verdict: 'deny', reason: '禁止写入', result: { error: '禁止写入' } }),
    execute: async () => {
      executed = true
      return 'should not run'
    },
    post: async () => {
      posted = true
      return { result: 'x', summary: 'y' }
    },
  })
  assert.equal(executed, false)
  assert.equal(posted, false)
  assert.equal(out.summary, '禁止写入')
  assert.deepEqual(out.result, { error: '禁止写入' })
})

/* ---------- confirmBuiltinSkill：审批策略 ---------- */

test('needsConfirmation=false → approve 且不弹确认', async () => {
  const { fn, calls } = makeConfirm()
  const outcome = await confirmBuiltinSkill(
    makeSkill('shell', false),
    { command: 'ls' },
    makeCtx(fn),
    '/work',
    'default',
  )
  assert.equal(outcome.verdict, 'approve')
  assert.equal(calls.length, 0)
})

test('只读直通：shell ls 不弹确认，approve', async () => {
  const { fn, calls } = makeConfirm()
  const outcome = await confirmBuiltinSkill(
    makeSkill('shell'),
    { command: 'ls -la' },
    makeCtx(fn),
    '/work',
    'default',
  )
  assert.equal(outcome.verdict, 'approve')
  assert.equal(calls.length, 0)
})

test('只读直通：非 shell file-reader 不弹确认，approve', async () => {
  const { fn, calls } = makeConfirm()
  const outcome = await confirmBuiltinSkill(
    makeSkill('file-reader'),
    { path: '/work/a.ts' },
    makeCtx(fn),
    '/work',
    'default',
  )
  assert.equal(outcome.verdict, 'approve')
  assert.equal(calls.length, 0)
})

test('v0.28.0 轻写放行：file-writer 在 default 模式直接 approve（workspaceLightWrite=allow）', async () => {
  const { fn, calls } = makeConfirm({ allowed: true })
  const outcome = await confirmBuiltinSkill(
    makeSkill('file-writer'),
    { path: '/work/a.ts', content: 'x' },
    makeCtx(fn),
    '/work',
    'default',
  )
  assert.equal(outcome.verdict, 'approve')
  assert.equal(calls.length, 0)
})

test('轻写：shell mkdir 在 default 模式直接 approve（allow 策略）', async () => {
  const { fn, calls } = makeConfirm()
  const outcome = await confirmBuiltinSkill(
    makeSkill('shell'),
    { command: 'mkdir tmp' },
    makeCtx(fn),
    '/work',
    'default',
  )
  assert.equal(outcome.verdict, 'approve')
  assert.equal(calls.length, 0)
})

test('轻写：shell mkdir 在 plan 模式 deny（禁止写入）', async () => {
  const { fn, calls } = makeConfirm()
  const outcome = await confirmBuiltinSkill(
    makeSkill('shell'),
    { command: 'mkdir tmp' },
    makeCtx(fn),
    '/work',
    'plan',
  )
  assert.equal(outcome.verdict, 'deny')
  assert.equal(calls.length, 0)
  assert.match(outcome.reason, /禁止写入/)
})

test('高风险确认：shell rm tmp 触发 confirm，allow 后 approve', async () => {
  const { fn, calls } = makeConfirm({ allowed: true })
  const outcome = await confirmBuiltinSkill(
    makeSkill('shell'),
    { command: 'rm tmp' },
    makeCtx(fn),
    '/work',
    'default',
  )
  assert.equal(outcome.verdict, 'approve')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.command, 'rm tmp')
})

test('高风险确认：用户显式拒绝 → deny 且 reason=用户拒绝执行', async () => {
  const { fn, calls } = makeConfirm({ allowed: false, reason: 'denied' })
  const outcome = await confirmBuiltinSkill(
    makeSkill('shell'),
    { command: 'rm tmp' },
    makeCtx(fn),
    '/work',
    'default',
  )
  assert.equal(outcome.verdict, 'deny')
  assert.equal(calls.length, 1)
  assert.equal(outcome.reason, '用户拒绝执行')
})

test('拒绝：黑名单命令 rm -rf / → deny（不弹确认）', async () => {
  const { fn, calls } = makeConfirm()
  const outcome = await confirmBuiltinSkill(
    makeSkill('shell'),
    { command: 'rm -rf /' },
    makeCtx(fn),
    '/work',
    'default',
  )
  assert.equal(outcome.verdict, 'deny')
  assert.equal(calls.length, 0)
  assert.match(outcome.reason, /安全策略|高危/)
})

test('拒绝：shell 命令过长（>16384 字节）→ deny 且带结构化 result', async () => {
  const { fn, calls } = makeConfirm()
  const longCmd = 'echo ' + 'x'.repeat(20000)
  const outcome = await confirmBuiltinSkill(
    makeSkill('shell'),
    { command: longCmd },
    makeCtx(fn),
    '/work',
    'default',
  )
  assert.equal(outcome.verdict, 'deny')
  assert.equal(calls.length, 0)
  const result = outcome.result as { tooLarge?: boolean; sizeBytes?: number }
  assert.equal(result?.tooLarge, true)
  assert.equal(result?.sizeBytes, longCmd.length)
})

test('拒绝：shell 命令过长但嵌套 command 对象也能正确解析并拒绝', async () => {
  const { fn, calls } = makeConfirm()
  const longCmd = 'echo ' + 'y'.repeat(20000)
  const outcome = await confirmBuiltinSkill(
    makeSkill('shell'),
    { command: { command: longCmd } },
    makeCtx(fn),
    '/work',
    'default',
  )
  assert.equal(outcome.verdict, 'deny')
  assert.equal(calls.length, 0)
  assert.equal((outcome.result as { tooLarge?: boolean }).tooLarge, true)
})

test('确认结果区分：timeout / dismissed 不算「用户拒绝」', async () => {
  const timeoutCtx = makeCtx(makeConfirm({ allowed: false, reason: 'timeout' }).fn)
  const to = await confirmBuiltinSkill(makeSkill('shell'), { command: 'rm tmp' }, timeoutCtx, '/work', 'default')
  assert.equal(to.verdict, 'deny')
  assert.equal(to.reason, '命令确认超时，未执行')

  const dismissedCtx = makeCtx(makeConfirm({ allowed: false, reason: 'dismissed' }).fn)
  const dis = await confirmBuiltinSkill(makeSkill('shell'), { command: 'rm tmp' }, dismissedCtx, '/work', 'default')
  assert.equal(dis.verdict, 'deny')
  assert.equal(dis.reason, '命令确认已取消，未执行')
})
