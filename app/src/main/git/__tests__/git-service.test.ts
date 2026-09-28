/* ============================================================
 * ArkWork — 宿主 git 服务单测（v0.36.0 · B3 / F3.5）
 * 规格来源：docs/versions/v0.36.0/04-system-design.md §3.5 · §7
 *
 * ★ 注入式：exec / confirm / audit / mode / root / now 全部注入 ——
 *   单测不依赖 dugite 二进制（§5 非功能：执行器可注入是硬性要求）。
 *   唯一例外 TC-GS-030：dugite 已安装时才跑真仓端到端（否则 skip ——
 *   真实二进制的链路验证由 B6 实机门槛兜底，单测不能被 50MB 包卡死）。
 *
 * 本组钉住五件缺一不可的事：
 *   ① **op 闭集** —— 白名单外一律 E_GIT_UNKNOWN_OP，没有任意命令透传；
 *   ② **作用域恒工作区根** —— 绝对路径 / `..` 逃逸拒（E_GIT_PATH_OUTSIDE），
 *      但 `..foo` 这类「名字以 .. 开头」的合法文件不得误杀；
 *   ③ **审批分层与 shell 语义同源** —— plan 拒 / default+acceptEdits 弹层 /
 *      autoApprove+bypass 直行；缺省 confirm = 拒（宁可不可用不静默放行）；
 *   ④ **审计只对写** —— denied/failed/success 全落，读类一律不落；
 *   ⑤ **输出可渲染** —— status/log/branch-list/stash-list 解析成结构，
 *      rename 的 `old -> new` 单行形态必须正确拆出 origPath。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs git-service
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createGitService,
  GitError,
  GIT_ALL_OPS,
  GIT_E,
  GIT_READ_OPS,
  GIT_WRITE_OPS,
  type GitConfirmRequest,
  type GitExecResult,
  type GitPermissionMode,
} from '../service.js'
import { getGitEngine, resetGitEngineCache, resolveGitEngine } from '../engine.js'

/* ============================================================
 * 注入脚手架
 * ============================================================ */

interface ExecCall {
  root: string
  args: string[]
}

/** 可编排的假执行器：按序弹出回应，默认 `ok`（exitCode 0、stdout 空） */
function makeExecScript(responses: Array<Partial<GitExecResult> | Error> = []) {
  const calls: ExecCall[] = []
  const exec = async (_root: string, args: string[]): Promise<GitExecResult> => {
    calls.push({ root: _root, args })
    const r = responses.shift()
    if (r instanceof Error) throw r
    return { stdout: '', stderr: '', exitCode: 0, ...r }
  }
  return { calls, exec }
}

/** 测试台：mode / confirm / audit / root / now 全可控 */
function makeHarness(opts: {
  root?: string | undefined
  execScript?: ReturnType<typeof makeExecScript>
  mode?: string
  confirmAllowed?: boolean | ((req: GitConfirmRequest) => boolean)
  withConfirm?: boolean
}) {
  const script = opts.execScript ?? makeExecScript()
  const confirms: GitConfirmRequest[] = []
  const audit: Array<Record<string, unknown>> = []
  const svc = createGitService({
    root: () => opts.root,
    exec: script.exec,
    mode: (() => Promise.resolve(opts.mode ?? 'default')) as () => Promise<GitPermissionMode>,
    confirm:
      opts.withConfirm === false
        ? undefined
        : async (req) => {
            confirms.push(req)
            if (typeof opts.confirmAllowed === 'function') return { allowed: opts.confirmAllowed(req) }
            if (opts.confirmAllowed === false) return { allowed: false, reason: '用户点了取消' }
            return { allowed: true }
          },
    audit: async (entry) => {
      audit.push(entry as Record<string, unknown>)
    },
  })
  return { svc, script, confirms, audit }
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'arkwork-git-svc-'))
}

/* ============================================================
 * 1. op 闭集
 * ============================================================ */

test('TC-GS-001 op 白名单形状：读 7 + 写 13 = 20，无重复，服务对象同源暴露', () => {
  assert.equal(GIT_READ_OPS.length, 7)
  assert.equal(GIT_WRITE_OPS.length, 13)
  assert.equal(GIT_ALL_OPS.length, 20)
  assert.equal(new Set(GIT_ALL_OPS).size, 20, '读写两表不得有交集')
  assert.equal(new Set(GIT_READ_OPS).size, 7)
  const svc = createGitService({})
  assert.equal(svc.GIT_ALL_OPS, GIT_ALL_OPS)
})

test('TC-GS-002 白名单外的 op → E_GIT_UNKNOWN_OP，detail.allowed 带全量闭集', async () => {
  const { svc } = makeHarness({ root: tmpRoot(), withConfirm: false })
  for (const bad of ['shell', 'rebase', 'push --force', '', 'rm -rf /', 'status; x']) {
    await assert.rejects(
      () => svc.run('p', bad),
      (e: GitError) => e.code === 'E_GIT_UNKNOWN_OP',
      `op「${bad}」必须被拒`,
    )
  }
  await assert.rejects(
    () => svc.run('p', 'rebase'),
    (e: GitError) => {
      const allowed = (e.detail as { allowed?: string[] })?.allowed
      return Array.isArray(allowed) && allowed.length === 20
    },
  )
})

/* ============================================================
 * 2. 作用域恒工作区根
 * ============================================================ */

test('TC-GS-003 无工作区 → E_GIT_NO_WORKSPACE（读也拒，不给裸跑机会）', async () => {
  const { svc } = makeHarness({ root: undefined, mode: 'autoApprove' })
  for (const op of ['status', 'add']) {
    await assert.rejects(
      () => svc.run('p', op),
      (e: GitError) => e.code === 'E_GIT_NO_WORKSPACE',
    )
  }
})

test('TC-GS-004 root 每次现场取：工作区切换后 exec 跟着新 root 走', async () => {
  const roots = [tmpRoot(), tmpRoot()]
  let i = 0
  const script = makeExecScript()
  const svc = createGitService({
    root: () => roots[i++]!,
    exec: script.exec,
    mode: (() => Promise.resolve('autoApprove')) as () => Promise<GitPermissionMode>,
  })
  await svc.run('p', 'status')
  await svc.run('p', 'status')
  assert.equal(script.calls.length, 2)
  assert.equal(script.calls[0]!.root, roots[0])
  assert.equal(script.calls[1]!.root, roots[1])
  rmSync(roots[0], { recursive: true, force: true })
  rmSync(roots[1], { recursive: true, force: true })
})

/* ============================================================
 * 3. 参数校验与路径断言
 * ============================================================ */

test('TC-GS-005 file 类参数收绝对路径 → E_GIT_PATH_OUTSIDE（不给插件指定任意路径）', async () => {
  const root = tmpRoot()
  try {
    const { svc, script } = makeHarness({ root, mode: 'autoApprove' })
    for (const files of ['/etc/passwd', join(root, '..', 'outside.txt')]) {
      await assert.rejects(
        () => svc.run('p', 'add', { files }),
        (e: GitError) => e.code === 'E_GIT_PATH_OUTSIDE',
      )
    }
    assert.equal(script.calls.length, 0, '路径被拒时不得触达执行器')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TC-GS-006 `..` 逃逸 → E_GIT_PATH_OUTSIDE', async () => {
  const root = tmpRoot()
  try {
    const { svc } = makeHarness({ root, mode: 'autoApprove' })
    for (const files of ['../escape.txt', 'sub/../../escape.txt', '..']) {
      await assert.rejects(
        () => svc.run('p', 'add', { files }),
        (e: GitError) => e.code === 'E_GIT_PATH_OUTSIDE',
        `files=${String(files)} 必须被拒`,
      )
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TC-GS-007 ★ `..foo`（名字以 .. 开头的合法文件）不得被误杀', async () => {
  const root = tmpRoot()
  try {
    const { svc, script } = makeHarness({ root, mode: 'autoApprove' })
    const out = await svc.run('p', 'add', { files: '..foo' })
    assert.equal(out.op, 'add')
    assert.deepEqual(script.calls[0]!.args.slice(2), ['add', '--', `${root}/..foo`])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TC-GS-008 files 缺省 / "." → add 的是工作区根本身（git add -- . 语义）', async () => {
  const root = tmpRoot()
  try {
    const { svc, script } = makeHarness({ root, mode: 'autoApprove' })
    await svc.run('p', 'add', {})
    assert.deepEqual(script.calls[0]!.args.slice(2), ['add', '--', root])
    await svc.run('p', 'add', { files: '.' })
    assert.deepEqual(script.calls[1]!.args.slice(2), ['add', '--', root])
    await svc.run('p', 'add', { files: './' })
    assert.deepEqual(script.calls[2]!.args.slice(2), ['add', '--', root], '带 ./ 尾巴也是根')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TC-GS-009 files 形状校验：空数组 / 非字符串元素 / 数字 → E_GIT_BAD_ARGS', async () => {
  const root = tmpRoot()
  try {
    const { svc } = makeHarness({ root, mode: 'autoApprove' })
    for (const files of [[], ['a.txt', 42], 3, true]) {
      await assert.rejects(
        () => svc.run('p', 'add', { files }),
        (e: GitError) => e.code === 'E_GIT_BAD_ARGS',
        `files=${JSON.stringify(files)} 必须被拒`,
      )
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TC-GS-010 commit 的 message 必填且 trim；amend 无 message 走 --no-edit', async () => {
  const root = tmpRoot()
  try {
    const { svc, script } = makeHarness({ root, mode: 'autoApprove' })
    for (const message of [undefined, '', '   ']) {
      await assert.rejects(
        () => svc.run('p', 'commit', { message }),
        (e: GitError) => e.code === 'E_GIT_BAD_ARGS',
      )
    }
    await svc.run('p', 'commit', { message: '  修复登录  ' })
    assert.deepEqual(script.calls[0]!.args.slice(2), ['commit', '-m', '修复登录'])
    await svc.run('p', 'amend', {})
    assert.deepEqual(script.calls[1]!.args.slice(2), ['commit', '--amend', '--no-edit'])
    await svc.run('p', 'amend', { message: '改说明' })
    assert.deepEqual(script.calls[2]!.args.slice(2), ['commit', '--amend', '-m', '改说明'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TC-GS-011 log 的 limit 钳制在 1..200（缺省 50；脏值回落）', async () => {
  const root = tmpRoot()
  try {
    const { svc, script } = makeHarness({ root })
    const cases: Array<[unknown, number]> = [
      [undefined, 50],
      [0, 1],
      [-5, 1],
      [99999, 200],
      [10.9, 10],
      ['lots', 50],
    ]
    for (const [limit, want] of cases) {
      await svc.run('p', 'log', { limit })
      const last = script.calls.at(-1)!.args
      assert.ok(last.includes(`--max-count=${want}`), `limit=${String(limit)} → --max-count=${want}，实际 ${last.join(' ')}`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TC-GS-012 diff 的 staged/--cached 与 file 断言；blame 的 file 必填', async () => {
  const root = tmpRoot()
  try {
    const { svc, script } = makeHarness({ root })
    await svc.run('p', 'diff', {})
    assert.deepEqual(script.calls[0]!.args.slice(2), ['diff', '--no-color'])
    await svc.run('p', 'diff', { staged: true })
    assert.deepEqual(script.calls[1]!.args.slice(2), ['diff', '--no-color', '--cached'])
    await svc.run('p', 'diff', { file: 'src/a.ts' })
    assert.deepEqual(script.calls[2]!.args.slice(2), ['diff', '--no-color', '--', `${root}/src/a.ts`])
    await assert.rejects(
      () => svc.run('p', 'blame', {}),
      (e: GitError) => e.code === 'E_GIT_BAD_ARGS',
      'blame 缺 file 必须拒',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ============================================================
 * 4. 审批分层（与 shell 语义同源）
 * ============================================================ */

test('TC-GS-013 ★ 读类 op 恒直行：plan 模式也不拦、无 confirm 也行、不审计', async () => {
  const root = tmpRoot()
  try {
    const { svc, script, confirms, audit } = makeHarness({ root, mode: 'plan', withConfirm: false })
    for (const op of GIT_READ_OPS) {
      await svc.run('p', op, op === 'blame' ? { file: 'a.ts' } : {})
    }
    assert.equal(script.calls.length, 7)
    assert.equal(confirms.length, 0)
    assert.equal(audit.length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TC-GS-014 plan 模式 + 写 op → E_GIT_DENIED（audit denied；执行器未触达）', async () => {
  const root = tmpRoot()
  try {
    const { svc, script, audit } = makeHarness({ root, mode: 'plan' })
    await assert.rejects(
      () => svc.run('p1', 'commit', { message: 'x' }),
      (e: GitError) => e.code === 'E_GIT_DENIED' && /Plan/.test(e.message),
    )
    assert.equal(script.calls.length, 0)
    assert.equal(audit.length, 1)
    assert.equal(audit[0]!.result, 'denied')
    assert.equal(audit[0]!.pluginId, 'p1')
    assert.equal(audit[0]!.op, 'commit')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TC-GS-015 default 模式 + 确认浮层未就绪 → E_GIT_DENIED（宁可不可用不静默放行）', async () => {
  const root = tmpRoot()
  try {
    const { svc, script, audit } = makeHarness({ root, mode: 'default', withConfirm: false })
    await assert.rejects(
      () => svc.run('p', 'push', {}),
      (e: GitError) => e.code === 'E_GIT_DENIED' && /确认/.test(e.message),
    )
    assert.equal(script.calls.length, 0)
    assert.equal(audit[0]!.result, 'denied')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TC-GS-016 confirm 拒绝 → E_GIT_DENIED，拒绝原因透传进 audit', async () => {
  const root = tmpRoot()
  try {
    const { svc, script, audit } = makeHarness({ root, mode: 'default', confirmAllowed: false })
    await assert.rejects(() => svc.run('p', 'reset', { files: 'a.ts' }))
    assert.equal(script.calls.length, 0)
    assert.equal(audit[0]!.result, 'denied')
    assert.equal(audit[0]!.reason, '用户点了取消')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TC-GS-017 confirm 允许 → 执行 + audit success；confirm 收到结构化请求', async () => {
  const root = tmpRoot()
  try {
    const { svc, script, confirms, audit } = makeHarness({ root, mode: 'default', confirmAllowed: true })
    const out = await svc.run('plugin.git', 'add', { files: 'src/a.ts' })
    assert.equal(out.op, 'add')
    assert.equal(script.calls.length, 1)
    const req = confirms[0]!
    assert.equal(req.pluginId, 'plugin.git')
    assert.equal(req.op, 'add')
    assert.equal(req.root, root)
    assert.equal(req.summary, 'git add src/a.ts')
    assert.deepEqual(req.impacts, ['暂存文件：src/a.ts'])
    assert.equal(audit[0]!.result, 'success')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TC-GS-018 ★ autoApprove / bypassPermissions 直行写 op，confirm 不被触达', async () => {
  const root = tmpRoot()
  try {
    for (const mode of ['autoApprove', 'bypassPermissions']) {
      const { svc, script, confirms, audit } = makeHarness({ root, mode })
      await svc.run('p', 'commit', { message: '直行' })
      assert.equal(script.calls.length, 1, `${mode} 必须直行`)
      assert.equal(confirms.length, 0, `${mode} 不弹浮层`)
      assert.equal(audit[0]!.result, 'success', `${mode} 也要审计`)
      script.calls.length = 0
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TC-GS-019 acceptEdits 走确认浮层（与 shell 同源：自动批的是文件编辑，不是 git 写）', async () => {
  const root = tmpRoot()
  try {
    const { svc, confirms } = makeHarness({ root, mode: 'acceptEdits', confirmAllowed: true })
    await svc.run('p', 'stash-push', {})
    assert.equal(confirms.length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TC-GS-020 缺省 mode（宿主未接线）恒 default → 写必弹确认', async () => {
  const root = tmpRoot()
  try {
    const confirms: GitConfirmRequest[] = []
    const svc = createGitService({
      root: () => root,
      exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      confirm: async (req) => {
        confirms.push(req)
        return { allowed: true }
      },
    })
    await svc.run('p', 'init')
    assert.equal(confirms.length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ============================================================
 * 5. 审计（写类全落、读类不落）
 * ============================================================ */

test('TC-GS-021 audit 的 durationMs 来自注入时钟（失败/成功都带耗时）', async () => {
  const root = tmpRoot()
  try {
    let t = 1000
    const calls: ExecCall[] = []
    const audit: Array<Record<string, unknown>> = []
    const svc = createGitService({
      root: () => root,
      exec: async (_root, args) => {
        calls.push({ root: _root, args })
        const failing = calls.length >= 2
        t += 500 // exec 期间时钟推进（durationMs 的来源）
        return failing
          ? { stdout: '', stderr: 'boom', exitCode: 128 }
          : { stdout: '', stderr: '', exitCode: 0 }
      },
      mode: (() => Promise.resolve('autoApprove')) as () => Promise<GitPermissionMode>,
      audit: async (e) => {
        audit.push(e as Record<string, unknown>)
      },
      now: () => t,
    })
    await svc.run('p', 'add', { files: 'a' })
    await assert.rejects(() => svc.run('p', 'commit', { message: 'x' }))
    assert.equal(audit[0]!.result, 'success')
    assert.equal(audit[0]!.durationMs, 500)
    assert.equal(audit[1]!.result, 'failed')
    assert.equal(audit[1]!.durationMs, 500)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TC-GS-022 exec 非零退出 → E_GIT_FAILED，stderr 摘要进 message 与 audit.reason', async () => {
  const root = tmpRoot()
  try {
    const script = makeExecScript([{ stdout: '', stderr: "error: pathspec 'nope' did not match", exitCode: 128 }])
    const { svc, audit } = makeHarness({ root, mode: 'autoApprove', execScript: script })
    await assert.rejects(
      () => svc.run('p', 'checkout', { ref: 'nope' }),
      (e: GitError) => e.code === 'E_GIT_FAILED' && e.message.includes("pathspec 'nope'"),
    )
    assert.equal(audit[0]!.result, 'failed')
    assert.equal(audit[0]!.reason, "error: pathspec 'nope' did not match")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TC-GS-023 exec 抛异常（非 GitError）→ 包装成 E_GIT_FAILED + audit failed', async () => {
  const root = tmpRoot()
  try {
    const script = makeExecScript([new Error('ENOENT: dugite gone')])
    const { svc, audit } = makeHarness({ root, mode: 'autoApprove', execScript: script })
    await assert.rejects(
      () => svc.run('p', 'fetch', {}),
      (e: GitError) => e.code === 'E_GIT_FAILED' && e.message.includes('ENOENT'),
    )
    assert.equal(audit[0]!.result, 'failed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TC-GS-024 读失败不审计：exitCode≠0 的读 op 抛 E_GIT_FAILED 但 audit 空', async () => {
  const root = tmpRoot()
  try {
    const script = makeExecScript([{ stdout: '', stderr: 'not a git repository', exitCode: 128 }])
    const { svc, audit } = makeHarness({ root, execScript: script })
    await assert.rejects(
      () => svc.run('p', 'status'),
      (e: GitError) => e.code === 'E_GIT_FAILED',
    )
    assert.equal(audit.length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ============================================================
 * 6. 输出解析（Client 半可直接渲染的结构）
 * ============================================================ */

test('TC-GS-025 ★ status 解析：porcelain 行 + rename 单行 `old -> new` 拆 origPath', async () => {
  const root = tmpRoot()
  try {
    const script = makeExecScript([
      {
        stdout: [
          '## main...origin/main [ahead 1]',
          ' M src/modified.ts',
          'A  src/added.ts',
          '?? untracked.txt',
          'R  src/old-name.ts -> src/new-name.ts',
          'D  src/deleted.ts',
          '',
        ].join('\n'),
      },
    ])
    const { svc } = makeHarness({ root, execScript: script })
    const out = (await svc.run('p', 'status')) as { output: { entries: Array<Record<string, string>> } }
    const entries = out.output.entries
    assert.deepEqual(
      entries,
      [
        { x: ' ', y: 'M', path: 'src/modified.ts' },
        { x: 'A', y: ' ', path: 'src/added.ts' },
        { x: '?', y: '?', path: 'untracked.txt' },
        { x: 'R', y: ' ', path: 'src/new-name.ts', origPath: 'src/old-name.ts' },
        { x: 'D', y: ' ', path: 'src/deleted.ts' },
      ],
      '## 分支行忽略；rename 必须拆成 new + origPath（非 -z 的 porcelain v1 是单行 -> 形态）',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TC-GS-026 log 解析：5 段 tab；subject 自身含 tab 时原样保留', async () => {
  const root = tmpRoot()
  try {
    const script = makeExecScript([
      {
        stdout: [
          'abcdef1234567890abcdef1234567890abcdef12\tabcdef1\t张三\t2026-09-20T10:00:00+08:00\t修复登录bug',
          '9999991234567890999999123456789099999999\t9999999\t李四\t2026-09-19T09:00:00+08:00\ta\tb',
          '',
        ].join('\n'),
      },
    ])
    const { svc } = makeHarness({ root, execScript: script })
    const out = (await svc.run('p', 'log', { limit: 2 })) as {
      output: { entries: Array<Record<string, string>> }
    }
    const [first, second] = out.output.entries
    assert.equal(first!.hash, 'abcdef1234567890abcdef1234567890abcdef12')
    assert.equal(first!.short, 'abcdef1')
    assert.equal(first!.author, '张三')
    assert.equal(first!.date, '2026-09-20T10:00:00+08:00')
    assert.equal(first!.subject, '修复登录bug')
    assert.equal(second!.subject, 'a\tb', 'subject 里的 tab 必须 rejoined，不得截断')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TC-GS-027 branch-list 解析：`*` 标当前分支；stash-list 三段', async () => {
  const root = tmpRoot()
  try {
    const script = makeExecScript([
      { stdout: 'main\t*\nfeature/x\t\nremotes/origin/main\t\n' },
      { stdout: 'stash@{0}\t2026-09-20T10:00:00+08:00\tWIP on main: 1a2b3c4 fix\n' },
    ])
    const { svc } = makeHarness({ root, execScript: script })
    const bl = (await svc.run('p', 'branch-list')) as { output: { entries: Array<Record<string, unknown>> } }
    assert.deepEqual(bl.output.entries, [
      { name: 'main', current: true },
      { name: 'feature/x', current: false },
      { name: 'remotes/origin/main', current: false },
    ])
    const sl = (await svc.run('p', 'stash-list')) as { output: { entries: Array<Record<string, string>> } }
    assert.equal(sl.output.entries[0]!.ref, 'stash@{0}')
    assert.equal(sl.output.entries[0]!.date, '2026-09-20T10:00:00+08:00')
    assert.equal(sl.output.entries[0]!.subject, 'WIP on main: 1a2b3c4 fix')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TC-GS-028 其余 op（diff/show/init…）输出保底为 { stdout } 原文', async () => {
  const root = tmpRoot()
  try {
    const script = makeExecScript([{ stdout: 'diff --git a/x b/x\n' }])
    const { svc } = makeHarness({ root, mode: 'autoApprove', execScript: script })
    const out = (await svc.run('p', 'diff')) as { output: { stdout: string } }
    assert.equal(out.output.stdout, 'diff --git a/x b/x\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TC-GS-029 GitError 三字段保真（code / message / detail）', () => {
  const e = new GitError('E_GIT_FAILED', 'boom', { exitCode: 1 })
  assert.equal(e.code, 'E_GIT_FAILED')
  assert.equal(e.message, 'boom')
  assert.deepEqual(e.detail, { exitCode: 1 })
  assert.ok(e instanceof Error)
  assert.equal(e instanceof GitError, true)
})

/* ============================================================
 * 7. 真仓端到端（有任一可用 git 引擎就跑；都没有才 skip）
 *
 * D86 修订：原用例只在 dugite 内嵌就位时跑 —— 实测该二进制在受限网络下
 * **拿不到**（GitHub Release ETIMEDOUT），等于这条最关键的链路永远 skip。
 * 现改为「引擎三级链任一可用即跑」，本机走系统 git 也照跑：
 * 真进程、真仓库、真 stderr、真审计。
 * ============================================================ */

let gitEngineAvailable = false
try {
  resetGitEngineCache()
  gitEngineAvailable = getGitEngine().engine !== null
} catch {
  /* 无引擎：skip */
}

test(
  'TC-GS-030 ★ 真仓端到端（真 git）：init → add → commit → log → 分支 → push → 审计',
  { skip: !gitEngineAvailable ? '本机无可用 git 引擎' : false },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'arkwork-git-real-'))
    const bare = mkdtempSync(join(tmpdir(), 'arkwork-git-bare-'))
    const audit: Array<Record<string, unknown>> = []
    // 提交身份用 env 注入（不依赖用户 ~/.gitconfig —— 干净环境/CI 也要过）
    const savedAuthor = {
      name: process.env.GIT_AUTHOR_NAME,
      email: process.env.GIT_AUTHOR_EMAIL,
      cname: process.env.GIT_COMMITTER_NAME,
      cemail: process.env.GIT_COMMITTER_EMAIL,
    }
    process.env.GIT_AUTHOR_NAME = 'ArkWork Test'
    process.env.GIT_AUTHOR_EMAIL = 'test@arkwork.local'
    process.env.GIT_COMMITTER_NAME = 'ArkWork Test'
    process.env.GIT_COMMITTER_EMAIL = 'test@arkwork.local'

    // 注意：不注入 exec —— 走 defaultExec（真引擎链路）
    const svc = createGitService({
      root: () => root,
      mode: (() => Promise.resolve('autoApprove')) as () => Promise<GitPermissionMode>,
      audit: async (e) => {
        audit.push(e as Record<string, unknown>)
      },
    })
    try {
      await svc.run('t', 'init')
      writeFileSync(join(root, 'hello.txt'), 'hello\n', 'utf-8')
      await svc.run('t', 'add', { files: 'hello.txt' })

      const st = (await svc.run('t', 'status')) as { output: { entries: Array<Record<string, string>> } }
      assert.equal(st.output.entries.length, 1)
      assert.equal(st.output.entries[0]!.path, 'hello.txt')
      assert.equal(st.output.entries[0]!.x, 'A')

      await svc.run('t', 'commit', { message: 'feat: hello' })
      const lg = (await svc.run('t', 'log', { limit: 5 })) as { output: { entries: Array<Record<string, string>> } }
      assert.equal(lg.output.entries.length, 1)
      assert.equal(lg.output.entries[0]!.subject, 'feat: hello')
      assert.equal(lg.output.entries[0]!.author, 'ArkWork Test')

      // 分支必须在有提交之后才能创建（空仓 `git branch` 会报 not a valid object name）
      await svc.run('t', 'branch-create', { name: 'feature/demo' })
      await svc.run('t', 'checkout', { ref: 'feature/demo' })
      const bl = (await svc.run('t', 'branch-list')) as { output: { entries: Array<Record<string, unknown>> } }
      assert.ok(bl.output.entries.some((b) => b.name === 'feature/demo' && b.current === true))

      const df = (await svc.run('t', 'diff', {})) as { output: { stdout: string } }
      assert.equal(typeof df.output.stdout, 'string')

      /* --- push 到本地 bare 远端（真网络 op 路径，离线可跑） --- */
      execFileSync(gitBinForTest(), ['init', '--bare', bare], { stdio: 'ignore' })
      appendFileSync(
        join(root, '.git', 'config'),
        `\n[remote "origin"]\n\turl = ${bare}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
      )
      await svc.run('t', 'push', { remote: 'origin', branch: 'feature/demo' })
      await svc.run('t', 'fetch', { remote: 'origin' })
      // bare 远端真收到提交
      const remoteHeads = execFileSync(
        gitBinForTest(),
        ['--git-dir', bare, 'rev-parse', 'refs/heads/feature/demo'],
        { encoding: 'utf-8' },
      ).trim()
      assert.match(remoteHeads, /^[0-9a-f]{40}$/)

      /* --- 失败路径：真 stderr 摘要落审计 --- */
      await assert.rejects(
        () => svc.run('t', 'checkout', { ref: 'no-such-branch' }),
        (e: GitError) => e.message.includes('no-such-branch'),
      )
      assert.equal(audit.at(-1)!.result, 'failed')

      const ops = audit.map((a) => a.op)
      assert.deepEqual(ops, [
        'init',
        'add',
        'commit',
        'branch-create',
        'checkout',
        'push',
        'fetch',
        'checkout',
      ])
      assert.ok(audit.slice(0, -1).every((a) => a.result === 'success'))
    } finally {
      if (savedAuthor.name === undefined) delete process.env.GIT_AUTHOR_NAME
      else process.env.GIT_AUTHOR_NAME = savedAuthor.name
      if (savedAuthor.email === undefined) delete process.env.GIT_AUTHOR_EMAIL
      else process.env.GIT_AUTHOR_EMAIL = savedAuthor.email
      if (savedAuthor.cname === undefined) delete process.env.GIT_COMMITTER_NAME
      else process.env.GIT_COMMITTER_NAME = savedAuthor.cname
      if (savedAuthor.cemail === undefined) delete process.env.GIT_COMMITTER_EMAIL
      else process.env.GIT_COMMITTER_EMAIL = savedAuthor.cemail
      rmSync(root, { recursive: true, force: true })
      rmSync(bare, { recursive: true, force: true })
    }
  },
)

test('TC-GS-031 引擎不可用 → service 层人话报错（E_GIT_FAILED 且给两条出路）', async (t) => {
  const savedPath = process.env.PATH
  const savedBin = process.env.ARKWORK_GIT_BIN
  process.env.PATH = ''
  delete process.env.ARKWORK_GIT_BIN
  resetGitEngineCache()
  try {
    let unavailable = false
    try {
      resolveGitEngine()
    } catch {
      unavailable = true
    }
    if (!unavailable) {
      t.skip('本机存在随包 git 发行版，构造不出「引擎缺失」')
      return
    }
    const svc = createGitService({ root: () => tmpdir() })
    await assert.rejects(
      () => svc.run('t', 'status'),
      (e: GitError) => {
        assert.equal(e.code, GIT_E.FAILED)
        assert.match(e.message, /安装 git/)
        assert.match(e.message, /ARKWORK_GIT_BIN/)
        return true
      },
    )
    // 读类 op 也走同一条引擎链（不是只有写才碰引擎）
    assert.equal(GIT_READ_OPS.includes('status'), true)
  } finally {
    if (savedPath === undefined) delete process.env.PATH
    else process.env.PATH = savedPath
    if (savedBin === undefined) delete process.env.ARKWORK_GIT_BIN
    else process.env.ARKWORK_GIT_BIN = savedBin
    resetGitEngineCache()
  }
})

test('TC-GS-032 引擎种类可上报（面板能显示「用哪个 git」—— 用户可自救）', (t) => {
  resetGitEngineCache()
  const { engine } = getGitEngine()
  if (!engine) {
    t.skip('本机无可用 git 引擎')
    return
  }
  assert.ok(engine.kind === 'dugite' || engine.kind === 'system')
  assert.ok(engine.binPath.length > 0)
})

/** 测试自身的 git 调用（配置远端/读 bare 仓库）—— 不走 service，不参与断言口径 */
function gitBinForTest(): string {
  const { engine } = getGitEngine()
  return engine?.binPath ?? 'git'
}

/* ============================================================
 * v0.36.0（B11/P3-a）：quotepath 乱码修复
 * 规格来源：docs/versions/v0.36.0/12-b11-fix-batch-design.md §四（P3-a）
 * ============================================================ */

test('TC-GIT-001 ★ B11：所有 git 调用统一前置 -c core.quotepath=false（中文文件名不再八进制转义）', async () => {
  // 读类 op
  const scriptRead = makeExecScript([{ stdout: '## main' }])
  const hRead = makeHarness({ root: tmpRoot(), execScript: scriptRead, withConfirm: false })
  await hRead.svc.run('p', 'status')
  assert.deepEqual(scriptRead.calls[0]?.args.slice(0, 2), ['-c', 'core.quotepath=false'])
  assert.equal(scriptRead.calls[0]?.args[2], 'status', '业务参数必须在 -c 之后原样保留')

  // 写类 op 同样覆盖（审批通过后执行的那次调用）
  const scriptWrite = makeExecScript()
  const hWrite = makeHarness({ root: tmpRoot(), execScript: scriptWrite, confirmAllowed: true })
  await hWrite.svc.run('p', 'commit', { message: 'msg' })
  assert.deepEqual(scriptWrite.calls[0]?.args.slice(0, 2), ['-c', 'core.quotepath=false'])
  assert.ok(scriptWrite.calls[0]?.args.includes('commit'))
})

test('TC-GIT-002 ★ B11：真仓端到端 —— 中文文件名 status 输出无八进制转义（git 可用时）', async (t) => {
  const root = tmpRoot()
  const git = gitBinForTest()
  try {
    execFileSync(git, ['-C', root, 'init', '-q'])
    execFileSync(git, ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'])
    writeFileSync(join(root, '项目分析报告.md'), 'x')
    const { engine } = getGitEngine()
    if (!engine) {
      t.skip('本机无可用 git 引擎')
      return
    }
    const { svc } = makeHarness({ root, withConfirm: false })
    const out = await svc.run('p', 'status')
    const raw = JSON.stringify(out.output)
    assert.ok(!raw.includes('\\351'), '不允许出现八进制转义（\\351 = 「项」首字节）')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

