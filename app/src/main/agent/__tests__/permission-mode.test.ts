/* ============================================================
 * v0.15.0 权限模型单测
 * 覆盖：MODE_POLICIES、规则匹配与合并、evaluatePermission 流水线、doom_loop
 * 运行（cwd=app）：
 *   npx tsx --test src/main/agent/__tests__/permission-mode.test.ts
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MODE_POLICIES, isPermissionMode } from '../permission-mode.js'
import { detectDoomLoop, resetDoomLoop } from '../doom-loop.js'
import {
  parseRule,
  matchRule,
  mergeRules,
  loadRulesFromConfig,
  type Rule,
} from '../rules.js'
import { evaluatePermission } from '../permissions.js'

test('MODE_POLICIES: default 模式下轻写命令为 allow', () => {
  assert.equal(MODE_POLICIES.default.workspaceLightWrite, 'allow')
  assert.equal(MODE_POLICIES.default.highRisk, 'confirm')
})

test('MODE_POLICIES: acceptEdits 模式下轻写命令 allow', () => {
  assert.equal(MODE_POLICIES.acceptEdits.workspaceLightWrite, 'allow')
  assert.equal(MODE_POLICIES.acceptEdits.highRisk, 'confirm')
})

test('MODE_POLICIES: plan 模式下任何写都被 deny', () => {
  assert.equal(MODE_POLICIES.plan.workspaceLightWrite, 'deny')
  assert.equal(MODE_POLICIES.plan.highRisk, 'deny')
})

test('isPermissionMode 类型守卫', () => {
  assert.ok(isPermissionMode('default'))
  assert.ok(isPermissionMode('acceptEdits'))
  assert.ok(isPermissionMode('plan'))
  assert.ok(!isPermissionMode('bypass'))
})

test('detectDoomLoop: 同一命令同 cwd 连续 3 次触发', () => {
  resetDoomLoop()
  assert.equal(detectDoomLoop('npm test', '/work'), false)
  assert.equal(detectDoomLoop('npm test', '/work'), false)
  assert.equal(detectDoomLoop('npm test', '/work'), true)
})

test('detectDoomLoop: 不同 cwd 不触发', () => {
  resetDoomLoop()
  detectDoomLoop('npm test', '/work/a')
  detectDoomLoop('npm test', '/work/b')
  detectDoomLoop('npm test', '/work/c')
  assert.equal(detectDoomLoop('npm test', '/work/d'), false)
})

test('parseRule: 解析 Bash(rm -rf *) 形式', () => {
  const r = parseRule('Bash(rm -rf *)')
  assert.ok(r)
  assert.equal(r!.tool, 'Bash')
  assert.equal(r!.pattern, 'rm -rf *')
})

test('parseRule: 解析裸 Read 形式', () => {
  const r = parseRule('Read')
  assert.ok(r)
  assert.equal(r!.tool, 'Read')
  assert.equal(r!.pattern, '*')
})

test('matchRule: Bash(npm test) 精确匹配', () => {
  const rule = parseRule('Bash(npm test)')!
  assert.ok(matchRule(rule, 'Bash', 'npm test'))
  assert.ok(!matchRule(rule, 'Bash', 'npm test foo'))
})

test('matchRule: Bash(git diff:*) glob 匹配', () => {
  const rule = parseRule('Bash(git diff:*)')!
  assert.ok(matchRule(rule, 'Bash', 'git diff main'))
  assert.ok(matchRule(rule, 'Bash', 'git diff'))
  assert.ok(!matchRule(rule, 'Bash', 'git status'))
})

test('mergeRules: deny 取并集并优先', () => {
  const toRules = (list: string[]): Rule[] =>
    list.map((r) => parseRule(r)!).filter(Boolean)
  const merged = mergeRules(
    { deny: toRules(['Bash(rm -rf *)']), ask: [], allow: [], defaultMode: 'default' },
    { deny: toRules(['Bash(sudo *)']), ask: [], allow: toRules(['Bash(npm test)']), defaultMode: 'acceptEdits' },
    { deny: [], ask: [], allow: [], defaultMode: 'plan' },
    { deny: [], ask: [], allow: [], defaultMode: undefined },
  )
  assert.equal(merged.deny.length, 2)
  assert.equal(merged.allow.length, 1)
  assert.equal(merged.defaultMode, 'default')
})

test('evaluatePermission: 黑名单直接 deny', () => {
  const d = evaluatePermission({
    command: 'rm -rf /',
    cwd: '/tmp',
    workspaceDir: '/tmp',
    mode: 'default',
    rules: { allow: [], ask: [], deny: [] },
  })
  assert.equal(d.decision, 'deny')
  assert.equal(d.riskLevel, 'reject')
})

test('evaluatePermission: acceptEdits 下 mkdir 静默 allow', () => {
  const d = evaluatePermission({
    command: 'mkdir tmp',
    cwd: '/work',
    workspaceDir: '/work',
    mode: 'acceptEdits',
    rules: { allow: [], ask: [], deny: [] },
  })
  assert.equal(d.decision, 'allow')
})

test('evaluatePermission: default 模式下 mkdir 静默 allow', () => {
  const d = evaluatePermission({
    command: 'mkdir tmp',
    cwd: '/work',
    workspaceDir: '/work',
    mode: 'default',
    rules: { allow: [], ask: [], deny: [] },
  })
  assert.equal(d.decision, 'allow')
})

test('evaluatePermission: plan 模式下 mkdir 被 deny', () => {
  const d = evaluatePermission({
    command: 'mkdir tmp',
    cwd: '/work',
    workspaceDir: '/work',
    mode: 'plan',
    rules: { allow: [], ask: [], deny: [] },
  })
  assert.equal(d.decision, 'deny')
})

test('evaluatePermission: allow 规则覆盖（保持 allow）', () => {
  const d = evaluatePermission({
    command: 'npm test',
    cwd: '/work',
    workspaceDir: '/work',
    mode: 'default',
    rules: { allow: ['Bash(npm test)'], ask: [], deny: [] },
  })
  assert.equal(d.decision, 'allow')
})

test('evaluatePermission: deny 规则覆盖 allow', () => {
  const d = evaluatePermission({
    command: 'rm -rf tmp',
    cwd: '/work',
    workspaceDir: '/work',
    mode: 'default',
    rules: { allow: ['Bash(rm -rf tmp)'], ask: [], deny: ['Bash(rm -rf *)'] },
  })
  assert.equal(d.decision, 'deny')
})

test('evaluatePermission: rm tmp 在 default 模式 confirm', () => {
  const d = evaluatePermission({
    command: 'rm tmp',
    cwd: '/work',
    workspaceDir: '/work',
    mode: 'default',
    rules: { allow: [], ask: [], deny: [] },
  })
  assert.equal(d.decision, 'ask')
})

test('evaluatePermission: 受保护路径写触发 ask', () => {
  const d = evaluatePermission({
    command: 'echo x > .git/config',
    cwd: '/work',
    workspaceDir: '/work',
    mode: 'acceptEdits',
    rules: { allow: ['Bash(echo *)'], ask: [], deny: [] },
  })
  assert.equal(d.decision, 'ask')
})

test('loadRulesFromConfig: 解析 permissions.{ allow/ask/deny/defaultMode }', () => {
  const rules = loadRulesFromConfig('test', {
    permissions: {
      defaultMode: 'acceptEdits',
      allow: ['Bash(npm test)'],
      ask: ['Bash(npm install *)'],
      deny: ['Bash(rm -rf *)'],
    },
  })
  assert.equal(rules.defaultMode, 'acceptEdits')
  assert.equal(rules.allow.length, 1)
  assert.equal(rules.ask.length, 1)
  assert.equal(rules.deny.length, 1)
})

test('evaluatePermission: sed -n 只读输出静默 allow', () => {
  const d = evaluatePermission({
    command: "sed -n '520,919p' /work/game.js",
    cwd: '/work',
    workspaceDir: '/work',
    mode: 'default',
    rules: { allow: [], ask: [], deny: [] },
  })
  assert.equal(d.decision, 'allow')
  assert.equal(d.riskLevel, 'workspace-readonly')
})

test('evaluatePermission: default 模式下 cat heredoc 重定向写工作区内 allow', () => {
  const d = evaluatePermission({
    command: "cat > docs/README.md << 'EOF'\n# tank\nEOF",
    cwd: '/work',
    workspaceDir: '/work',
    mode: 'default',
    rules: { allow: [], ask: [], deny: [] },
  })
  assert.equal(d.decision, 'allow')
  assert.equal(d.riskLevel, 'workspace-light-write')
})

test('evaluatePermission: default 模式下 cat 重定向写工作区外 confirm', () => {
  const d = evaluatePermission({
    command: 'echo hello > /etc/passwd',
    cwd: '/work',
    workspaceDir: '/work',
    mode: 'default',
    rules: { allow: [], ask: [], deny: [] },
  })
  assert.equal(d.decision, 'ask')
  assert.equal(d.riskLevel, 'high-risk')
})

// v0.15.0 Task 6 修复：sed -i / tee 不再每次打扰；工作区内 default 与 acceptEdits 均 allow
test('evaluatePermission: sed -i 工作区内 default 模式 allow', () => {
  const d = evaluatePermission({
    command: 'sed -i "s/a/b/" README.md',
    cwd: '/work',
    workspaceDir: '/work',
    mode: 'default',
    rules: { allow: [], ask: [], deny: [] },
  })
  assert.equal(d.decision, 'allow')
  assert.equal(d.riskLevel, 'workspace-light-write')
})

test('evaluatePermission: sed -i 工作区内 acceptEdits 静默 allow', () => {
  const d = evaluatePermission({
    command: 'sed -i "s/a/b/" README.md',
    cwd: '/work',
    workspaceDir: '/work',
    mode: 'acceptEdits',
    rules: { allow: [], ask: [], deny: [] },
  })
  assert.equal(d.decision, 'allow')
  assert.equal(d.riskLevel, 'workspace-light-write')
})

test('evaluatePermission: tee 工作区内 acceptEdits 静默 allow', () => {
  const d = evaluatePermission({
    command: 'echo hello | tee README.md',
    cwd: '/work',
    workspaceDir: '/work',
    mode: 'acceptEdits',
    rules: { allow: [], ask: [], deny: [] },
  })
  assert.equal(d.decision, 'allow')
})

test('evaluatePermission: sed -i 越出 workspace 仍按 high-risk 强制 confirm', () => {
  const d = evaluatePermission({
    command: 'sed -i "s/a/b/" /etc/passwd',
    cwd: '/work',
    workspaceDir: '/work',
    mode: 'acceptEdits',
    rules: { allow: [], ask: [], deny: [] },
  })
  assert.equal(d.decision, 'ask')
  assert.equal(d.riskLevel, 'high-risk')
})

test('evaluatePermission: sudo / rm -rf 仍按 high-risk 强制 confirm', () => {
  const rm = evaluatePermission({
    command: 'rm -rf /',
    cwd: '/work',
    workspaceDir: '/work',
    mode: 'acceptEdits',
    rules: { allow: [], ask: [], deny: [] },
  })
  assert.equal(rm.decision, 'deny')
  const sudo = evaluatePermission({
    command: 'sudo apt install something',
    cwd: '/work',
    workspaceDir: '/work',
    mode: 'acceptEdits',
    rules: { allow: [], ask: [], deny: [] },
  })
  assert.equal(sudo.decision, 'ask')
  assert.equal(sudo.riskLevel, 'high-risk')
})