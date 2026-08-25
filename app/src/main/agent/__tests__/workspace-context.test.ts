/* ============================================================
 * v0.24.x — workspace-context 单元测试
 *
 * 覆盖：envInfo / projectTree / stack detect / agentFiles 四块
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
  discoverAgentFiles,
  renderAgentFilesBlock,
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

/* ---------- 4. AGENTS.md 自动发现 ---------- */

test('discoverAgentFiles: 找到工作区根 AGENTS.md', () => {
  const ws = mkTmpWs('ark-md-agents')
  try {
    writeFileSync(join(ws, 'AGENTS.md'), '# 项目规则\n不要写注释')
    const files = discoverAgentFiles(ws)
    assert.equal(files.projectFiles.length, 1)
    assert.equal(files.projectFiles[0]!.name, 'AGENTS.md')
    assert.match(files.projectFiles[0]!.content, /不要写注释/)
  } finally { rmWs(ws) }
})

test('discoverAgentFiles: CLAUDE.md 优先级', () => {
  const ws = mkTmpWs('ark-md-claude')
  try {
    writeFileSync(join(ws, 'AGENTS.md'), '# A')
    writeFileSync(join(ws, 'CLAUDE.md'), '# C')
    const files = discoverAgentFiles(ws)
    // 项目级只取第一个找到的（按 AGENTS / CLAUDE / CONTEXT 顺序）
    assert.equal(files.projectFiles.length, 1)
    assert.match(files.projectFiles[0]!.name, /AGENTS\.md|CLAUDE\.md/)
  } finally { rmWs(ws) }
})

test('discoverAgentFiles: 大于 8KB 截断', () => {
  const ws = mkTmpWs('ark-md-big')
  try {
    const big = 'A'.repeat(10 * 1024)
    writeFileSync(join(ws, 'AGENTS.md'), big)
    const files = discoverAgentFiles(ws)
    assert.equal(files.projectFiles.length, 1)
    assert.match(files.projectFiles[0]!.content, /文件超过 8KB，已截断/)
  } finally { rmWs(ws) }
})

test('renderAgentFilesBlock: 无文件时返回空字符串', () => {
  const block = renderAgentFilesBlock({ projectFiles: [], globalFiles: [] })
  assert.equal(block, '')
})

test('renderAgentFilesBlock: 有文件时含 AGENTS.md 标记', () => {
  const block = renderAgentFilesBlock({
    projectFiles: [{ name: 'AGENTS.md', relPath: 'AGENTS.md', content: '测试规则' }],
    globalFiles: [],
  })
  assert.match(block, /## 项目规则/)
  assert.match(block, /AGENTS\.md/)
  assert.match(block, /测试规则/)
})

/* ---------- 5. 总入口 buildWorkspaceContext ---------- */

test('buildWorkspaceContext: 一次返回完整 combined 字符串', () => {
  const ws = mkTmpWs('ark-full')
  try {
    writeFileSync(join(ws, 'package.json'), JSON.stringify({ name: 'demo', dependencies: { react: '*' } }))
    writeFileSync(join(ws, 'AGENTS.md'), 'test rule')
    mkdirSync(join(ws, 'src'), { recursive: true })
    const ctx = buildWorkspaceContext(ws)
    assert.ok(ctx.combined.length > 100)
    assert.match(ctx.combined, /## 环境信息/)
    assert.match(ctx.combined, /## 技术栈/)
    assert.match(ctx.combined, /## 项目结构/)
    assert.match(ctx.combined, /## 项目规则/)
    assert.match(ctx.combined, /React/)
    assert.match(ctx.combined, /test rule/)
  } finally { rmWs(ws) }
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