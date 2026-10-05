/* ============================================================
 * v0.24.x — workspace-context 单元测试
 *
 * 覆盖：envInfo / projectTree / stack detect 三块
 *       + 指令源集成（v0.47.0 起发现/渲染迁移至 instruction-sources.ts，
 *         细粒度契约见 instruction-sources.test.ts；本文件只钉 buildWorkspaceContext 集成）
 *       + buildSystemSections 注入正确性
 *
 * 运行（cwd=app）：
 *   ./node_modules/.bin/tsx --test src/main/agent/__tests__/workspace-context.test.ts
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  buildEnvInfo,
  renderEnvBlock,
  buildProjectTree,
  renderProjectBlock,
  detectStack,
  renderStackBlock,
  buildWorkspaceContext,
} from '../workspace-context.js'

/* ---------- 辅助：临时工作区 ---------- */
function mkTmpWs(prefix: string): string {
  const p = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(p, { recursive: true })
  return p
}
function rmWs(p: string) {
  if (existsSync(p)) rmSync(p, { recursive: true, force: true })
}

/* ---------- 1. envInfo ---------- */

test('buildEnvInfo: 包含 cwd / workspaceDir / git / platform / date', () => {
  const ws = mkTmpWs('ark-env')
  try {
    const info = buildEnvInfo(ws)
    assert.equal(info.workspaceDir, ws)
    assert.equal(typeof info.cwd, 'string')
    assert.equal(typeof info.isGitRepo, 'boolean')
    assert.equal(info.isGitRepo, false, '临时目录不是 git 仓库')
    assert.equal(info.gitBranch, null)
    assert.ok(['darwin', 'linux', 'win32', 'freebsd', 'openbsd', 'sunos', 'aix'].includes(info.platform))
    assert.match(info.date, /^\d{4}-\d{2}-\d{2}$/)
  } finally { rmWs(ws) }
})

test('renderEnvBlock: 包含 <env> 标签与所有字段', () => {
  const ws = mkTmpWs('ark-env-render')
  try {
    const info = buildEnvInfo(ws)
    const block = renderEnvBlock(info)
    assert.match(block, /## 环境信息/)
    assert.match(block, /<env>/)
    assert.match(block, /<\/env>/)
    assert.match(block, new RegExp(ws.replace(/[/\\]/g, '\\$&')))
    assert.match(block, /Git 仓库：否/)
  } finally { rmWs(ws) }
})

/* ---------- 2. projectTree ---------- */

test('buildProjectTree: 排除 node_modules / .git / dist 等', () => {
  const ws = mkTmpWs('ark-tree')
  try {
    mkdirSync(join(ws, 'node_modules', 'foo'), { recursive: true })
    mkdirSync(join(ws, 'src'), { recursive: true })
    writeFileSync(join(ws, 'src', 'index.ts'), 'export const x = 1')
    writeFileSync(join(ws, 'README.md'), '# test')
    const tree = buildProjectTree(ws)
    assert.match(tree.tree, /src\//)
    assert.match(tree.tree, /index\.ts/)
    assert.doesNotMatch(tree.tree, /node_modules/)
    assert.match(tree.rootEntries.join('\n'), /src\//)
    assert.doesNotMatch(tree.rootEntries.join('\n'), /node_modules/)
    assert.ok(tree.keyFiles.includes('README.md'))
  } finally { rmWs(ws) }
})

test('buildProjectTree: 关键文件清单覆盖 package.json / tsconfig.json', () => {
  const ws = mkTmpWs('ark-tree-key')
  try {
    writeFileSync(join(ws, 'package.json'), '{}')
    writeFileSync(join(ws, 'tsconfig.json'), '{}')
    const tree = buildProjectTree(ws)
    assert.ok(tree.keyFiles.includes('package.json'))
    assert.ok(tree.keyFiles.includes('tsconfig.json'))
  } finally { rmWs(ws) }
})

test('renderProjectBlock: 含 <project> 标签 + 目录树代码块 + 关键文件清单', () => {
  const ws = mkTmpWs('ark-tree-render')
  try {
    mkdirSync(join(ws, 'src'), { recursive: true })
    const block = renderProjectBlock(buildProjectTree(ws))
    assert.match(block, /## 项目结构/)
    assert.match(block, /<project>/)
    assert.match(block, /<\/project>/)
    assert.match(block, /目录树/)
    assert.match(block, /```/)
    assert.match(block, /关键文件/)
  } finally { rmWs(ws) }
})

/* ---------- 3. stack detect ---------- */

test('detectStack: Node 项目 + package.json dependencies → frameworks', () => {
  const ws = mkTmpWs('ark-stack-node')
  try {
    writeFileSync(join(ws, 'package.json'), JSON.stringify({
      name: 'demo', version: '1.0.0',
      engines: { node: '>=18' },
      dependencies: { react: '^18.0.0', 'tailwindcss': '^3.0.0', 'phaser': '^3.0.0' },
    }))
    const info = detectStack(ws)
    assert.equal(info.node, true)
    assert.equal(info.projectName, 'demo')
    assert.equal(info.projectVersion, '1.0.0')
    assert.equal(info.nodeVersion, '>=18')
    assert.ok(info.frameworks.includes('React'))
    assert.ok(info.frameworks.includes('Tailwind'))
    assert.ok(info.frameworks.includes('Phaser'))
  } finally { rmWs(ws) }
})

test('detectStack: 多语言并存', () => {
  const ws = mkTmpWs('ark-stack-multi')
  try {
    writeFileSync(join(ws, 'package.json'), '{}')
    writeFileSync(join(ws, 'Cargo.toml'), '')
    writeFileSync(join(ws, 'go.mod'), '')
    const info = detectStack(ws)
    assert.equal(info.node, true)
    assert.equal(info.rust, true)
    assert.equal(info.go, true)
    assert.equal(info.python, false)
  } finally { rmWs(ws) }
})

test('renderStackBlock: Node + frameworks 渲染', () => {
  const ws = mkTmpWs('ark-stack-render')
  try {
    writeFileSync(join(ws, 'package.json'), JSON.stringify({
      name: 'foo', version: '0.1.0',
      dependencies: { react: '*' },
    }))
    const block = renderStackBlock(detectStack(ws))
    assert.match(block, /## 技术栈/)
    assert.match(block, /<stack>/)
    assert.match(block, /Node\.js/)
    assert.match(block, /React/)
    assert.match(block, /项目：foo/)
  } finally { rmWs(ws) }
})

/* ---------- 4. 指令源集成（v0.47.0：发现/渲染细节见 instruction-sources.test.ts）---------- */

/** HOME 隔离（全局指令源来自 ~/.codex / ~/.arkwork，真实 HOME 会污染断言） */
async function withHome<T>(fn: () => T | Promise<T>): Promise<T> {
  const prev = process.env.HOME
  const fakeHome = mkTmpWs('arkwork-home-empty')
  process.env.HOME = fakeHome
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env.HOME
    else process.env.HOME = prev
    rmSync(fakeHome, { recursive: true, force: true })
  }
}

test('workspace-context: 根 AGENTS.md 进入 instructions 与 combined', async () => {
  const ws = mkTmpWs('ark-inst-agents')
  await withHome(async () => {
    try {
      writeFileSync(join(ws, 'AGENTS.md'), '# 项目规则\n不要写注释')
      const ctx = buildWorkspaceContext(ws)
      assert.equal(ctx.instructions.sources.length, 1)
      assert.equal(ctx.instructions.sources[0]!.scope, 'project-chain')
      assert.equal(ctx.instructions.sources[0]!.relPath, 'AGENTS.md')
      assert.match(ctx.combined, /## 项目与全局指令/)
      assert.match(ctx.combined, /不要写注释/)
      assert.match(ctx.combined, /优先级：用户的当前消息/)
    } finally { rmWs(ws) }
  })
})

test('workspace-context: 无任何指令源时省略该段（诚实省 token）', async () => {
  const ws = mkTmpWs('ark-inst-empty')
  await withHome(async () => {
    try {
      const ctx = buildWorkspaceContext(ws)
      assert.equal(ctx.instructions.sources.length, 0)
      assert.ok(!ctx.combined.includes('项目与全局指令'))
    } finally { rmWs(ws) }
  })
})

test('workspace-context: Codex 全局 ~/.codex/AGENTS.md 被发现（接管 Codex 关键）', async () => {
  const ws = mkTmpWs('ark-inst-codex-global')
  const home = mkTmpWs('arkwork-home-codex')
  const prev = process.env.HOME
  process.env.HOME = home
  try {
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(join(home, '.codex', 'AGENTS.md'), '# 全局 Codex 约定\n始终用 pnpm')
    const ctx = buildWorkspaceContext(ws)
    const codex = ctx.instructions.sources.find((s) => s.scope === 'codex-global')
    assert.ok(codex, 'codex-global 源必须被发现')
    assert.match(codex.content, /始终用 pnpm/)
    assert.match(ctx.combined, /全局（Codex/)
  } finally {
    if (prev === undefined) delete process.env.HOME
    else process.env.HOME = prev
    rmSync(home, { recursive: true, force: true })
    rmWs(ws)
  }
})

/* ---------- 5. 总入口 buildWorkspaceContext ---------- */

test('buildWorkspaceContext: 一次返回完整 combined 字符串', async () => {
  const ws = mkTmpWs('ark-full')
  await withHome(async () => {
    try {
      writeFileSync(join(ws, 'package.json'), JSON.stringify({ name: 'demo', dependencies: { react: '*' } }))
      writeFileSync(join(ws, 'AGENTS.md'), 'test rule')
      mkdirSync(join(ws, 'src'), { recursive: true })
      const ctx = buildWorkspaceContext(ws)
      assert.ok(ctx.combined.length > 100)
      assert.match(ctx.combined, /## 环境信息/)
      assert.match(ctx.combined, /## 技术栈/)
      assert.match(ctx.combined, /## 项目结构/)
      assert.match(ctx.combined, /## 项目与全局指令/)
      assert.match(ctx.combined, /React/)
      assert.match(ctx.combined, /test rule/)
    } finally { rmWs(ws) }
  })
})

test('buildWorkspaceContext: 失败安全降级（不存在的目录 → 只丢 IO 部分，env/stack 仍可用）', () => {
  // 注意：env + stack 不依赖 IO（只 stat 几个常见文件），所以失败时仍能返回部分结果
  const ctx = buildWorkspaceContext('/nonexistent/workspace/should/not/exist/xyz')
  assert.ok(ctx.envInfo.date)
  assert.equal(ctx.envInfo.isGitRepo, false)
  // stack 全部 false
  assert.equal(ctx.stack.node, false)
  // tree 应该是 "(空目录)" 或类似
  assert.equal(ctx.tree.rootEntries.length, 0)
})