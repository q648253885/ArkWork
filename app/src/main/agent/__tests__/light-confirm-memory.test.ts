import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LightConfirmMemory } from '../light-confirm-memory.js'

const cwd = '/work/project'
const workspaceDir = '/work'

test('LightConfirmMemory: 首次检查未记录', () => {
  const memory = new LightConfirmMemory()
  assert.deepEqual(memory.check('mkdir tmp', cwd, workspaceDir), {
    remembered: false,
    expired: false,
  })
})

test('LightConfirmMemory: 允许后再次执行自动通过', () => {
  const memory = new LightConfirmMemory()
  memory.remember('mkdir tmp', cwd, workspaceDir, true)
  assert.deepEqual(memory.check('mkdir tmp', cwd, workspaceDir), {
    remembered: true,
    allowed: true,
    expired: false,
  })
})

test('LightConfirmMemory: 拒绝后再次执行被拦', () => {
  const memory = new LightConfirmMemory()
  memory.remember('mkdir tmp', cwd, workspaceDir, false)
  assert.deepEqual(memory.check('mkdir tmp', cwd, workspaceDir), {
    remembered: true,
    allowed: false,
    expired: false,
  })
})

test('LightConfirmMemory: 30 分钟后过期', () => {
  const originalNow = Date.now
  let now = 1_000
  Date.now = () => now
  try {
    const memory = new LightConfirmMemory()
    memory.remember('mkdir tmp', cwd, workspaceDir, true)
    now += 30 * 60 * 1000
    assert.deepEqual(memory.check('mkdir tmp', cwd, workspaceDir), {
      remembered: false,
      expired: true,
    })
  } finally {
    Date.now = originalNow
  }
})

test('LightConfirmMemory: 不同命令独立记忆', () => {
  const memory = new LightConfirmMemory()
  memory.remember('mkdir tmp', cwd, workspaceDir, true)
  assert.equal(memory.check('touch file.txt', cwd, workspaceDir).remembered, false)
})

test('LightConfirmMemory: 去除前导 cd 后按实际 cwd 规范化', () => {
  const memory = new LightConfirmMemory()
  memory.remember('cd src && mkdir tmp', workspaceDir, workspaceDir, true)
  assert.equal(memory.check('mkdir tmp', '/work/src', workspaceDir).allowed, true)
})
