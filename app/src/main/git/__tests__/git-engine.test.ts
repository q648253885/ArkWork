/* ============================================================
 * ArkWork — git 引擎解析单测（v0.36.0 · B3 / F3.5 · 决策 D86）
 * 规格来源：docs/versions/v0.36.0/04-system-design.md §3.5（D86 修订）
 *
 * 为什么这一组用例是「必须」而不是「锦上添花」：
 *  实机复现 —— dugite 的内嵌 git 是 GitHub Release 上的 ~50MB 二进制，
 *  本环境 **objects.githubusercontent.com 不可达**（ETIMEDOUT），
 *  即「按原设计只有 dugite 一条路」= 插件直接不可用。
 *  三级解析链因此不是优化项，而是**可用性底线**：任一级缺，必须能落到下一级。
 *
 * 本组钉住四件事：
 *   ① **优先级**：显式覆盖 > dugite 内嵌 > 系统 git（顺序不能反）；
 *   ② **诚实失败**：全都没有时抛 GitEngineUnavailableError，且消息含两条出路
 *      （装 git / ARKWORK_GIT_BIN）—— 用户不能只看到「失败了」；
 *   ③ **执行策略**：非交互 env（GIT_TERMINAL_PROMPT=0）必须注入 —— 否则
 *      无声挂起比报错更糟；超时可覆盖且真的会 kill（exitCode 124）；
 *   ④ **单例**：解析一次即缓存，resetGitEngineCache 可重试。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs git-engine
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  findSystemGit,
  getGitEngine,
  GitEngineUnavailableError,
  resetGitEngineCache,
  resolveDugiteRoot,
  resolveGitEngine,
} from '../engine.js'

const isWin = process.platform === 'win32'
const BIN_NAME = isWin ? 'git.exe' : 'git'

/** 造一个「假 git 发行版」目录结构：<root>/bin/git 可执行 */
function makeFakeGitDist(dir: string): string {
  const root = join(dir, 'git')
  mkdirSync(join(root, 'bin'), { recursive: true })
  writeFileSync(join(root, 'bin', BIN_NAME), '#!/bin/sh\nexit 0\n')
  chmodSync(join(root, 'bin', BIN_NAME), 0o755)
  return root
}

/** 造一个「假 dugite 包」：<dir>/package.json + <dir>/git/bin/git */
function makeFakeDugitePkg(dir: string, withBinary = true): string {
  const pkg = join(dir, 'dugite-pkg')
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'dugite', version: '0.0.0-test' }))
  if (withBinary) makeFakeGitDist(pkg)
  return pkg
}

/** 假 require：resolve('dugite/package.json') → 指定路径（不装真 dugite 也能测解析） */
function fakeRequire(pkgJsonPath: string): NodeRequire {
  return { resolve: () => pkgJsonPath } as unknown as NodeRequire
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'arkwork-git-engine-'))
}

/* ============================================================
 * 1. 优先级
 * ============================================================ */

test('TC-GE-001 显式覆盖 ARKWORK_GIT_BIN 优先于 dugite 内嵌与系统 git', () => {
  const dir = tmp()
  try {
    const dist = makeFakeGitDist(dir)
    const explicit = join(dist, 'bin', BIN_NAME)
    const e = resolveGitEngine({ ARKWORK_GIT_BIN: explicit, PATH: '' } as NodeJS.ProcessEnv)
    assert.equal(e.kind, 'system')
    assert.equal(e.binPath, explicit)
    // 即便 dugite 也在，覆盖仍然赢（resolveGitEngine 不该看 dugite）
    assert.equal(e.distRoot, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TC-GE-002 ARKWORK_GIT_BIN 指向不存在的文件 → 明确报错（不静默回落）', () => {
  assert.throws(
    () => resolveGitEngine({ ARKWORK_GIT_BIN: '/no/such/git', PATH: '' } as NodeJS.ProcessEnv),
    (e: unknown) => {
      assert.ok(e instanceof GitEngineUnavailableError)
      assert.match(e.message, /ARKWORK_GIT_BIN/)
      assert.match(e.message, /\/no\/such\/git/)
      return true
    },
  )
})

test('TC-GE-003 dugite 内嵌就位 → kind=dugite 且带 distRoot（用于注入 GIT_EXEC_PATH）', () => {
  const dir = tmp()
  try {
    const pkg = makeFakeDugitePkg(dir)
    const expectedRoot = join(pkg, 'git')
    assert.equal(resolveDugiteRoot(fakeRequire(join(pkg, 'package.json'))), expectedRoot)
    const e = resolveGitEngine({ PATH: '' } as NodeJS.ProcessEnv, fakeRequire(join(pkg, 'package.json')))
    assert.equal(e.kind, 'dugite')
    assert.equal(e.distRoot, expectedRoot)
    assert.equal(e.binPath, join(expectedRoot, 'bin', BIN_NAME))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TC-GE-004 dugite 包在但内嵌二进制缺失（本环境实况）→ 不认，落到系统 git', () => {
  const dir = tmp()
  try {
    const pkg = makeFakeDugitePkg(dir, false)
    const sysDir = join(dir, 'sysbin')
    mkdirSync(sysDir, { recursive: true })
    const sysGit = join(sysDir, BIN_NAME)
    writeFileSync(sysGit, '#!/bin/sh\nexit 0\n')
    chmodSync(sysGit, 0o755)

    assert.equal(resolveDugiteRoot(fakeRequire(join(pkg, 'package.json'))), null)
    const e = resolveGitEngine({ PATH: sysDir } as NodeJS.ProcessEnv, fakeRequire(join(pkg, 'package.json')))
    assert.equal(e.kind, 'system')
    assert.equal(e.binPath, sysGit)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TC-GE-005 系统 git：PATH 多目录逐个探测，跳过不存在与不可执行者', () => {
  if (isWin) return
  const dir = tmp()
  try {
    const bad = join(dir, 'bad')
    const good = join(dir, 'good')
    mkdirSync(bad, { recursive: true })
    mkdirSync(good, { recursive: true })
    // 不可执行（缺 X_OK）必须被跳过 —— 否则 spawn 时才炸，错误更难解释
    writeFileSync(join(bad, 'git'), '#!/bin/sh\nexit 0\n')
    const goodGit = join(good, 'git')
    writeFileSync(goodGit, '#!/bin/sh\nexit 0\n')
    chmodSync(goodGit, 0o755)

    assert.equal(findSystemGit(`${bad}:/nonexistent:${good}`), goodGit)
    assert.equal(findSystemGit(''), null)
    assert.equal(findSystemGit(undefined), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TC-GE-006 全都没有 → 抛错，且消息给出两条出路（装 git / ARKWORK_GIT_BIN）', () => {
  assert.throws(
    () => resolveGitEngine({ PATH: '' } as NodeJS.ProcessEnv, fakeRequire('/no/such/dugite/package.json')),
    (e: unknown) => {
      assert.ok(e instanceof GitEngineUnavailableError)
      assert.equal(e.code, 'E_GIT_ENGINE_UNAVAILABLE')
      assert.match(e.message, /安装 git/)
      assert.match(e.message, /ARKWORK_GIT_BIN/)
      return true
    },
  )
})

/* ============================================================
 * 2. 单例与缓存
 * ============================================================ */

test('TC-GE-007 getGitEngine 单例缓存；reset 后可重新解析（用户装完 git 能重试）', () => {
  resetGitEngineCache()
  const first = getGitEngine()
  const second = getGitEngine()
  assert.equal(first, second, '未 reset 时必须返回同一对象（懒解析只做一次）')
  resetGitEngineCache()
  const third = getGitEngine()
  assert.notEqual(first, third, 'reset 后必须重新解析')
  // engine 与 error 二者恰有其一
  assert.equal(Boolean(third.engine) !== Boolean(third.error), true)
  resetGitEngineCache()
  // 本机（开发/CI）应至少有一条路可用 —— 都没有则后续真执行用例自行 skip
  const e = resolveGitEngine()
  assert.ok(e.kind === 'dugite' || e.kind === 'system')
})

/* ============================================================
 * 3. 执行策略（真进程；无真 git 时 skip）
 * ============================================================ */

function realEngineOrSkip(t: { skip: (msg: string) => void }) {
  resetGitEngineCache()
  const { engine } = getGitEngine()
  if (!engine) {
    t.skip('本机无可用 git 引擎')
    return null
  }
  return engine
}

test('TC-GE-008 ★ 真执行：git --version 走通（引擎→spawn→stdout 全链路）', (t) => {
  const engine = realEngineOrSkip(t)
  if (!engine) return
  return engine.exec(tmpdir(), ['--version']).then((r) => {
    assert.equal(r.exitCode, 0)
    assert.match(r.stdout, /git version/i)
    assert.equal(r.stderr, '')
  })
})

test('TC-GE-009 非交互与稳定 env 必须注入（GIT_TERMINAL_PROMPT=0 / GIT_PAGER=cat / LC_ALL=C）', async (t) => {
  if (isWin) {
    t.skip('POSIX shell 脚本载体，Windows 不适用')
    return
  }
  const dir = tmp()
  try {
    const script = join(dir, 'fake-git')
    writeFileSync(
      script,
      '#!/bin/sh\nprintf "PROMPT=%s\\nPAGER=%s\\nLC=%s\\n" "$GIT_TERMINAL_PROMPT" "$GIT_PAGER" "$LC_ALL"\nexit 0\n',
    )
    chmodSync(script, 0o755)
    const e = resolveGitEngine({ ARKWORK_GIT_BIN: script, PATH: '' } as NodeJS.ProcessEnv)
    const r = await e.exec(dir, ['status'])
    assert.equal(r.exitCode, 0)
    // 这三行是「不挂起 + 输出稳定」的硬保证
    assert.match(r.stdout, /PROMPT=0/)
    assert.match(r.stdout, /PAGER=cat/)
    assert.match(r.stdout, /LC=C/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TC-GE-010 超时可覆盖且真的终止子进程（exitCode=124 + 人话 stderr）', async (t) => {
  if (isWin) {
    t.skip('POSIX shell 脚本载体，Windows 不适用')
    return
  }
  const dir = tmp()
  try {
    const script = join(dir, 'slow-git')
    writeFileSync(script, '#!/bin/sh\nsleep 30\n')
    chmodSync(script, 0o755)
    const e = resolveGitEngine({
      ARKWORK_GIT_BIN: script,
      PATH: '',
      ARKWORK_GIT_TIMEOUT_MS: '300',
    } as NodeJS.ProcessEnv)
    const t0 = Date.now()
    const r = await e.exec(dir, ['status'])
    const cost = Date.now() - t0
    assert.equal(r.exitCode, 124, '超时必须归一为 124（区别于 git 自身的非 0 退出）')
    assert.match(r.stderr, /超时/)
    assert.ok(cost < 10_000, `应在超时后很快返回，实际 ${cost}ms`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TC-GE-011 二进制不可执行（EACCES/ENOENT）→ GitEngineUnavailableError，不当成「git 报错」', async (t) => {
  if (isWin) {
    t.skip('POSIX 权限位语义，Windows 不适用')
    return
  }
  const dir = tmp()
  try {
    const script = join(dir, 'gone-git')
    writeFileSync(script, '#!/bin/sh\nexit 0\n')
    chmodSync(script, 0o755)
    const e = resolveGitEngine({ ARKWORK_GIT_BIN: script, PATH: '' } as NodeJS.ProcessEnv)
    rmSync(script) // 解析通过后消失 → spawn ENOENT
    await assert.rejects(
      () => e.exec(dir, ['status']),
      (err: unknown) => {
        assert.ok(err instanceof GitEngineUnavailableError)
        assert.match(err.message, /无法执行 git/)
        return true
      },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
