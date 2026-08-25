/* ============================================================
 * v0.24.2.1 — MCP tools → Skill 注入纯函数测试
 *
 * 验证 mcpServersToSkills() 在 listSkills() 内部的注入契约：
 *  1. 仅 status='connected' 的 server 注入；其他状态全部跳过
 *  2. id 格式 M-{namespace}.{toolName}，mcpRef 正确指向 (serverId, toolName)
 *  3. enabled=false 的 server 仍注入，但 enabled=false 由 assembleTools 过滤
 *  4. 多 server / 多 tool 不串号
 *
 * 走纯函数测试，不依赖 listSkills() 全套初始化（无需 electron 桩）
 *
 * 用法（cwd=app）：
 *   ./node_modules/.bin/tsx \
 *     --experimental-loader ./src/test/electron-mock-loader.mjs \
 *     --test src/main/agent/__tests__/mcp-injection.test.ts
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mcpServersToSkills } from '../registry.js'
import type { McpServer } from '@shared/types/agent'

function makeServer(over: Partial<McpServer> & { id: string; namespace: string; status: McpServer['status'] }): McpServer {
  return {
    name: over.id,
    transport: 'stdio',
    enabled: true,
    toolCount: 0,
    tools: [],
    ...over,
  } as McpServer
}

test('mcpServersToSkills: 仅注入 connected server 的 tools', () => {
  const servers: McpServer[] = [
    makeServer({
      id: 'M-echo', namespace: 'echo', status: 'connected',
      tools: [
        { name: 'echo', description: 'echo back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
      ],
    }),
    makeServer({
      id: 'M-fs', namespace: 'fs', status: 'disconnected',
      tools: [
        { name: 'read', description: 'read file', inputSchema: { type: 'object', properties: {} } },
        { name: 'write', description: 'write file', inputSchema: { type: 'object', properties: {} } },
      ],
    }),
    makeServer({
      id: 'M-broken', namespace: 'broken', status: 'error',
      tools: [{ name: 'noop', description: 'never', inputSchema: { type: 'object', properties: {} } }],
    }),
    makeServer({
      id: 'M-loading', namespace: 'loading', status: 'connecting',
      tools: [{ name: 'wait', description: 'wait', inputSchema: { type: 'object', properties: {} } }],
    }),
  ]
  const skills = mcpServersToSkills(servers)
  // 只有 connected 的 echo 注入 1 个
  assert.equal(skills.length, 1, `期望 1 个 skill，实际 ${skills.length}`)
  assert.equal(skills[0]!.id, 'M-echo.echo')
  assert.equal(skills[0]!.source, 'mcp')
  assert.equal(skills[0]!.namespace, 'echo')
  assert.deepEqual(skills[0]!.mcpRef, { serverId: 'M-echo', toolName: 'echo' })
  assert.equal(skills[0]!.layer, 'runtime')
  assert.equal(skills[0]!.enabled, true)
})

test('mcpServersToSkills: 多 server 多 tool 不串号', () => {
  const servers: McpServer[] = [
    makeServer({
      id: 'M-echo', namespace: 'echo', status: 'connected',
      tools: [
        { name: 'echo', description: 'a', inputSchema: { type: 'object', properties: {} } },
        { name: 'reverse', description: 'b', inputSchema: { type: 'object', properties: {} } },
      ],
    }),
    makeServer({
      id: 'M-search', namespace: 'search', status: 'connected',
      tools: [{ name: 'query', description: 'c', inputSchema: { type: 'object', properties: {} } }],
    }),
  ]
  const skills = mcpServersToSkills(servers)
  assert.equal(skills.length, 3)
  const ids = skills.map((s) => s.id).sort()
  assert.deepEqual(ids, ['M-echo.echo', 'M-echo.reverse', 'M-search.query'])
  // mcpRef 各自正确
  const reverse = skills.find((s) => s.id === 'M-echo.reverse')!
  assert.deepEqual(reverse.mcpRef, { serverId: 'M-echo', toolName: 'reverse' })
  const query = skills.find((s) => s.id === 'M-search.query')!
  assert.deepEqual(query.mcpRef, { serverId: 'M-search', toolName: 'query' })
})

test('mcpServersToSkills: enabled=false 的 server 仍注入 Skill，但 enabled=false 透传', () => {
  const servers: McpServer[] = [
    makeServer({
      id: 'M-off', namespace: 'off', status: 'connected', enabled: false,
      tools: [{ name: 'noop', description: 'never', inputSchema: { type: 'object', properties: {} } }],
    }),
  ]
  const skills = mcpServersToSkills(servers)
  assert.equal(skills.length, 1)
  assert.equal(skills[0]!.enabled, false)
})

test('mcpServersToSkills: 空 server 列表 → 空数组', () => {
  assert.deepEqual(mcpServersToSkills([]), [])
})

test('mcpServersToSkills: 缺少 description 时降级为空串', () => {
  const servers: McpServer[] = [
    makeServer({
      id: 'M-x', namespace: 'x', status: 'connected',
      tools: [{ name: 't', description: '', inputSchema: { type: 'object', properties: {} } }],
    }),
  ]
  const skills = mcpServersToSkills(servers)
  assert.equal(skills[0]!.description, '')
})
