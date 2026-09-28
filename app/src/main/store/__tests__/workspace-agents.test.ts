/* ============================================================
 * v0.36.0 F2.3 — 工作区内置 agent（`.arkwork/agents/*.json`）单测
 *
 * 覆盖验收断言：
 *  1. 目录扫描：*.json 每文件一个 Agent；workspaceBuiltin 缺省补 true
 *  2. 容错：坏 JSON / 缺 id / 非 json 文件跳过且不抛（一个坏文件不拖垮面）
 *  3. getAgent：工作区优先遮蔽全局（近层遮蔽远层惯例）；全局兜底
 *  4. 缓存：invalidateAgentCache 后重扫可见目录改动
 *
 * 【D98 修正（2026-09-21，B7）】本套件原先用「electron 桩的共享工作区」
 * `/tmp/arkwork-test-userData/arkwork-data/workspace/default` —— 而
 * `skills-zip-export.test.ts` 的 after 会整根 `rm -rf /tmp/arkwork-test-userData`，
 * node:test 又是**多文件并行**，于是 mkdir 与 writeFile 之间父目录被别的套件抽走
 * → 随机 `ENOENT` 假红灯（单跑全绿、全量偶红）。
 * 两层修正：① electron 桩改为**每进程独占 userData 根**（根因：固定共享路径
 * = 跨套件隐式耦合，见 src/test/electron-stub.mjs）；② 本套件仍自建 `mkdtemp`
 * 工作区以明确表达「本套件独占自己的落盘根」。同时把 TC-WA-005 里
 * 「往共享 agents.json 塞同 id」的写法换成「工作区 @default 遮蔽内置 @default」——
 * 后者同样验证近层遮蔽，且不再写全局共享文件。
 *
 * 运行（cwd=app）：
 *   ./node_modules/.bin/tsx \
 *     --experimental-loader ./src/test/electron-mock-loader.mjs \
 *     --test src/main/store/__tests__/workspace-agents.test.ts
 * ============================================================ */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@shared/types/agent'

const { listWorkspaceAgents, getAgent, invalidateAgentCache } = await import('../agents.js')
const { setWorkspaceDir } = await import('../db.js')

/** 本套件专属工作区（mkdtemp：进程内唯一，杜绝跨套件抢目录） */
const WS_ROOT = await mkdtemp(join(tmpdir(), 'arkwork-ws-agents-'))
const wsAgentsDir = (): string => join(WS_ROOT, '.arkwork', 'agents')
setWorkspaceDir(WS_ROOT)

/** 最小合法 Agent 形状（缺省字段由类型断言补齐，只测 store 层关心的字段） */
function makeAgent(id: string, name = id): Agent {
  return {
    id,
    name,
    description: `ws agent ${id}`,
    avatarColor: '#123456',
    systemPrompt: `prompt of ${id}`,
    defaultSkillIds: ['S-core.file-reader'],
    defaultMcpIds: [],
    defaultModelId: 'm-test',
    defaultKbIds: [],
    defaultConfig: {} as Agent['defaultConfig'],
    isBuiltin: false,
    version: '0.36.0',
    source: 'custom',
  } as Agent
}

before(async () => {
  await rm(wsAgentsDir(), { recursive: true, force: true })
  invalidateAgentCache()
})

after(async () => {
  await rm(WS_ROOT, { recursive: true, force: true })
  invalidateAgentCache()
})

test('TC-WA-001 目录不存在 → 空数组（不抛）', async () => {
  await rm(wsAgentsDir(), { recursive: true, force: true })
  invalidateAgentCache()
  assert.deepEqual(await listWorkspaceAgents(), [])
})

test('TC-WA-002 扫描 *.json 每文件一个 Agent，workspaceBuiltin 缺省补 true', async () => {
  await mkdir(wsAgentsDir(), { recursive: true })
  await writeFile(join(wsAgentsDir(), 'researcher.json'), JSON.stringify(makeAgent('@ws-researcher')))
  await writeFile(join(wsAgentsDir(), 'reviewer.json'), JSON.stringify(makeAgent('@ws-reviewer')))
  invalidateAgentCache()
  const list = await listWorkspaceAgents()
  const ids = list.map((a) => a.id).sort()
  assert.deepEqual(ids, ['@ws-researcher', '@ws-reviewer'])
  for (const a of list) {
    assert.equal(a.workspaceBuiltin, true, '工作区 agent 应缺省标记 workspaceBuiltin=true')
  }
})

test('TC-WA-003 容错：坏 JSON / 缺 id / 非 json 文件跳过且不抛', async () => {
  await rm(wsAgentsDir(), { recursive: true, force: true })
  await mkdir(wsAgentsDir(), { recursive: true })
  await writeFile(join(wsAgentsDir(), 'broken.json'), '{not-json')
  await writeFile(join(wsAgentsDir(), 'no-id.json'), JSON.stringify({ name: 'no id here' }))
  await writeFile(join(wsAgentsDir(), 'notes.txt'), 'ignored')
  await writeFile(join(wsAgentsDir(), 'good.json'), JSON.stringify(makeAgent('@ws-good')))
  invalidateAgentCache()
  const list = await listWorkspaceAgents()
  assert.deepEqual(list.map((a) => a.id), ['@ws-good'])
})

test('TC-WA-004 workspaceBuiltin 显式 false 时保留原值', async () => {
  await rm(wsAgentsDir(), { recursive: true, force: true })
  await mkdir(wsAgentsDir(), { recursive: true })
  const a = { ...makeAgent('@ws-explicit'), workspaceBuiltin: false }
  await writeFile(join(wsAgentsDir(), 'explicit.json'), JSON.stringify(a))
  invalidateAgentCache()
  const hit = (await listWorkspaceAgents()).find((x) => x.id === '@ws-explicit')
  assert.equal(hit?.workspaceBuiltin, false)
})

test('TC-WA-005 getAgent: 工作区 agent 遮蔽同名内置（近层遮蔽远层）', async () => {
  await rm(wsAgentsDir(), { recursive: true, force: true })
  await mkdir(wsAgentsDir(), { recursive: true })
  // 用内置 @default 作为「远层」：不写全局 agents.json（那是跨套件共享文件，写它会污染并行套件）
  const shadow = { ...makeAgent('@default', '工作区 Default'), systemPrompt: 'WORKSPACE WINS' }
  await writeFile(join(wsAgentsDir(), 'default.json'), JSON.stringify(shadow))
  invalidateAgentCache()
  assert.equal((await getAgent('@default'))?.systemPrompt, 'WORKSPACE WINS', '工作区应遮蔽内置同名 agent')
  // 反向：撤掉工作区文件后必须回落内置（证明上面的命中确实来自工作区而不是巧合）
  await rm(wsAgentsDir(), { recursive: true, force: true })
  invalidateAgentCache()
  assert.notEqual((await getAgent('@default'))?.systemPrompt, 'WORKSPACE WINS', '撤销后应回落全局/内置')
})

test('TC-WA-006 getAgent: 工作区无此 id 时回落全局（内置 seed agent）', async () => {
  await rm(wsAgentsDir(), { recursive: true, force: true })
  invalidateAgentCache()
  const hit = await getAgent('@default')
  assert.ok(hit, '内置 @default 应可命中（全局兜底）')
  assert.notEqual(hit?.workspaceBuiltin, true)
})

test('TC-WA-007 getAgent: 不存在的 id 返回 null', async () => {
  invalidateAgentCache()
  assert.equal(await getAgent('@no-such-ws-agent'), null)
})

test('TC-WA-008 缓存失效：invalidateAgentCache 后目录改动可见', async () => {
  await mkdir(wsAgentsDir(), { recursive: true })
  await writeFile(join(wsAgentsDir(), 'late.json'), JSON.stringify(makeAgent('@ws-late')))
  invalidateAgentCache()
  assert.ok((await listWorkspaceAgents()).some((a) => a.id === '@ws-late'))
  await rm(join(wsAgentsDir(), 'late.json'), { force: true })
  // 不失效 → 缓存仍含
  assert.ok((await listWorkspaceAgents()).some((a) => a.id === '@ws-late'), '未失效时应读缓存')
  invalidateAgentCache()
  assert.equal(
    (await listWorkspaceAgents()).some((a) => a.id === '@ws-late'),
    false,
    '失效后重扫应反映删除',
  )
})
