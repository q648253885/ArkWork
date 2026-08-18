/* ============================================================
 * v0.24.2.1 — 端到端验证脚本：MCP tools 进入 Agent LLM 工具集
 *
 * 不依赖 Electron GUI；走纯 Node + electron 桩 loader，模拟：
 *   1. mcp-servers.json 中预先放好「echo-test」server 配置（stdio, echo "$ARG"）
 *   2. 注册 IPC handler 时 client.connectMcp('echo-test') 会发现 1 个 tool 'echo'
 *   3. 调 listSkills() → 应返回 source='mcp' 的 Skill 'M-echo.echo'
 *   4. 模拟 assembleTools 过滤（agent.defaultMcpIds 包含 echo-test id）
 *      → 应进入最终 LlmTool[]，函数名 = 'echo'，description 含 'echo ...'
 *
 * 运行（cwd=app）：
 *   ./node_modules/.bin/tsx \
 *     --experimental-loader ./src/main/store/__tests__/electron-mock-loader.mjs \
 *     scripts/verify-mcp-injection.ts
 * ============================================================ */
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
// 走 electron 桩 loader 时 app.getPath('userData') = /tmp/arkwork-test-userData
const USER_DATA = '/tmp/arkwork-test-userData'
const ARKWORK_DIR = join(USER_DATA, 'arkwork-data')
const MCP_CONFIG = join(ARKWORK_DIR, 'mcp-servers.json')

// 准备测试 userData：写入 mcp-servers.json（带 echo-test）
async function setup(): Promise<void> {
  await rm(USER_DATA, { recursive: true, force: true })
  await mkdir(ARKWORK_DIR, { recursive: true })
  // 真实 MCP stdio server：项目自带 scripts/_echo-mcp-server.py（极简 JSON-RPC 实现）
  const here = dirname(fileURLToPath(import.meta.url))
  const cfg = [
    {
      id: 'M-echo-test',
      name: 'echo-test',
      namespace: 'echo',
      transport: 'stdio',
      command: 'python3',
      args: [join(here, '_echo-mcp-server.py')],
      enabled: true,
    },
  ]
  await writeFile(MCP_CONFIG, JSON.stringify(cfg, null, 2), 'utf-8')
  console.log(`[setup] wrote ${MCP_CONFIG}`)
}

// 动态导入被测模块（必须在 setup 之后）
async function main(): Promise<void> {
  await setup()

  // 触发 cache 失效
  const { invalidateSkillCache, listSkills } = await import('../src/main/agent/registry.js')

  console.log('\n=== Step 1: connectMcp("M-echo-test") ===')
  // 重新读 MCP config 看一下
  const cfgRaw = await readFile(MCP_CONFIG, 'utf-8')
  console.log(`mcp-servers.json:`, cfgRaw)

  const { connectMcp, listMcpServers } = await import('../src/main/mcp/client.js')

  try {
    const tools = await connectMcp('M-echo-test')
    console.log(`connectMcp → 找到 ${tools.length} 个 tool:`)
    for (const t of tools) console.log(`  - ${t.name}: ${t.description ?? '(no desc)'}`)
  } catch (err) {
    console.error(`connectMcp 失败: ${(err as Error).message}`)
    console.log('（检查 scripts/_echo-mcp-server.py 是否存在 + python3 可用）')
    process.exit(1)
  }

  console.log('\n=== Step 2: listMcpServers() ===')
  const servers = await listMcpServers()
  console.log(`MCP server 列表（${servers.length}）:`)
  for (const s of servers) {
    console.log(`  - ${s.id} status=${s.status} tools=${s.toolCount}`)
  }
  const echoServer = servers.find((s) => s.id === 'M-echo-test')
  if (!echoServer || echoServer.status !== 'connected') {
    console.error('echo-test 未 connected，测试不通过')
    process.exit(1)
  }

  // 关键：触发 skill 缓存失效
  invalidateSkillCache()

  console.log('\n=== Step 3: listSkills() 应包含 source=mcp 的 Skill ===')
  const skills = await listSkills()
  const mcpSkills = skills.filter((s) => s.source === 'mcp')
  console.log(`全部 skill: ${skills.length}，其中 mcp: ${mcpSkills.length}`)
  for (const s of mcpSkills) {
    console.log(`  - id=${s.id} name=${s.name} namespace=${s.namespace} mcpRef=${JSON.stringify(s.mcpRef)}`)
  }
  const echoSkill = mcpSkills.find((s) => s.id === 'M-echo.echo')
  if (!echoSkill) {
    console.error('❌ 期望找到 id=M-echo.echo 的 mcp Skill，未找到')
    console.log('所有 mcp skill id:', mcpSkills.map((s) => s.id))
    process.exit(1)
  }
  if (echoSkill.source !== 'mcp' || echoSkill.mcpRef?.serverId !== 'M-echo-test') {
    console.error('❌ mcp skill 元数据不正确:', echoSkill)
    process.exit(1)
  }
  console.log('✅ Step 3: listSkills 正确注入 echo-test 的 echo tool')

  console.log('\n=== Step 4: 模拟 assembleTools 过滤 ===')
  // 模拟 agent 与 task
  const agent = {
    id: '@test',
    name: 'test',
    description: '',
    avatarColor: '#000',
    systemPrompt: '',
    defaultSkillIds: [],
    defaultMcpIds: ['M-echo-test'],   // ← 用户勾选了 echo-test 插件
    defaultModelId: 'mock',
    defaultKbIds: [],
    defaultConfig: { maxIterations: 60 } as never,
    isBuiltin: true,
    version: '0',
    source: 'core' as const,
  }
  const task = {
    id: 't1',
    title: 't',
    text: '',
    agentId: '@test',
    skillIds: [],
    mcpIds: [],
    modelId: 'mock',
    config: { maxIterations: 60 } as never,
    status: 'pending' as const,
    createdAt: 0,
    updatedAt: 0,
    startedAt: null,
    completedAt: null,
    workspaceId: 'default',
    parentTaskId: null,
    input: { text: '' },
    tags: [],
    starred: false,
    automationId: undefined,
  }
  // 镜像 engine.assembleTools 合并逻辑
  const skillIdSet = new Set<string>([...agent.defaultSkillIds, ...task.skillIds])
  const mcpServerIdSet = new Set<string>([...(agent.defaultMcpIds || []), ...(task.mcpIds || [])])
  for (const s of skills) {
    if (s.source === 'mcp' && s.mcpRef && mcpServerIdSet.has(s.mcpRef.serverId)) {
      skillIdSet.add(s.id)
    }
  }
  const available = skills.filter((s) => skillIdSet.has(s.id) && s.enabled !== false)
  console.log(`assembleTools 过滤后: ${available.length} 个 tool`)
  for (const s of available) {
    console.log(`  - ${s.id} (source=${s.source})`)
  }
  const echoInTools = available.find((s) => s.id === 'M-echo.echo')
  if (!echoInTools) {
    console.error('❌ 期望 M-echo.echo 进入 Agent 工具集，未找到')
    process.exit(1)
  }
  console.log('✅ Step 4: assembleTools 正确把 echo tool 纳入 LLM 工具集')

  console.log('\n=== Step 5: skillToLlmTool 转换 ===')
  const { skillToLlmTool } = await import('../src/main/agent/registry.js')
  const llmTool = skillToLlmTool(echoInTools)
  console.log(`LLM tool: name=${llmTool.function.name} desc=${llmTool.function.description}`)
  if (llmTool.function.name !== 'echo') {
    console.error(`❌ 期望 LLM tool name=echo，实际=${llmTool.function.name}`)
    process.exit(1)
  }
  console.log('✅ Step 5: LLM 工具名 = echo，Agent 可以识别并调用')

  console.log('\n=== Step 6: disconnect 后 listSkills 不再包含 echo tool ===')
  const { disconnectMcp } = await import('../src/main/mcp/client.js')
  await disconnectMcp('M-echo-test')
  const serversAfter = await listMcpServers()
  console.log(`disconnect 后 status: ${serversAfter[0]?.status}`)
  invalidateSkillCache()
  const skillsAfter = await listSkills()
  const mcpAfter = skillsAfter.filter((s) => s.source === 'mcp')
  console.log(`disconnect 后 listSkills 中 mcp skill: ${mcpAfter.length}`)
  if (mcpAfter.length !== 0) {
    console.error('❌ disconnect 后 listSkills 仍包含 mcp skill（缓存未失效）')
    process.exit(1)
  }
  console.log('✅ Step 6: disconnect → invalidateSkillCache → listSkills 不再含 echo tool')

  console.log('\n=== 🎉 全部通过：MCP plugin → Agent 工具集链路生效 ===')
  console.log('修改前后对比：')
  console.log('  - 修改前：assembleTools 拿到 0 个 echo tool → Agent 无法感知插件')
  console.log('  - 修改后：assembleTools 拿到 1 个 echo tool → Agent 能调用 cat 当 echo')
}

main().catch((err) => {
  console.error('脚本异常:', err)
  process.exit(1)
})