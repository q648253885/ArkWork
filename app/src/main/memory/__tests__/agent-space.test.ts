/* ============================================================
 * ArkWork — Agent 空间迁移用例（v0.36.0 · B4 / F1.1；v0.36.3 归属修订）
 * 规格来源：docs/versions/v0.36.0/04-system-design.md §3.2（决策 D1）·
 *          docs/versions/v0.36.0/15-v0363-memory-motion-path-design.md §4.1（修订）
 *
 * 本组钉住六件缺一不可的事：
 *   ① **搬什么**：L3a 的 user.md/pending + L4a 的 profile.json 三件进 Agent 空间；
 *      ★ v0.36.3 起 memory.md **不进 Agent 空间**（它属于工作区，见 TC-ASP-001/009/010）；
 *   ② **幂等**：跑一百次不会有副作用（启动时每次都调，必须无副作用）；
 *   ③ **自愈**：标记在、但工作区又冒出旧文件 → 仍然要搬（否则那些记忆永久失联）；
 *   ④ **冲突裁决**：两处都有时以 Agent 空间为准，工作区副本留 bak（不删数据）；
 *   ⑤ **失败不写标记**：搬不动就整体中止、下次重试，且**不阻断启动**；
 *   ⑥ **回迁（TC-MEM-011）**：Agent 空间里的旧 memory.md 复制回工作区 —— 幂等、
 *      不覆盖工作区已有记忆、不删源文件（多工作区还能各拿一份）。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs agent-space
 * ============================================================ */
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AGENT_SPACE_FILES,
  MIGRATED_BAK_SUFFIX,
  agentSpaceDir,
  agentSpaceLegacyMemoryPath,
  agentSpacePath,
  agentSpaceStatus,
  legacyWorkspacePath,
  migrateAgentSpace,
  seedWorkspaceMemoryFromAgentSpace,
  workspaceCuratedMemoryPath,
} from '../agent-space.js'
import { setWorkspaceDir } from '../../store/db.js'
import { getCuratedSnapshot, updateCuratedFile } from '../l3-curated.js'

const SPACE = agentSpaceDir()
let WS = ''

function freshWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'arkwork-asp-ws-'))
  mkdirSync(join(dir, '.arkwork'), { recursive: true })
  setWorkspaceDir(dir)
  return dir
}

function seedLegacy(files: Partial<Record<(typeof AGENT_SPACE_FILES)[number], string>>): void {
  for (const [f, content] of Object.entries(files)) {
    writeFileSync(join(WS, '.arkwork', f), content as string, 'utf-8')
  }
}

beforeEach(() => {
  rmSync(SPACE, { recursive: true, force: true })
  WS = freshWorkspace()
})

after(() => {
  rmSync(SPACE, { recursive: true, force: true })
})

/* ============================================================
 * 一、路径契约
 * ============================================================ */

test('TC-ASP-001 路径契约：三件进 Agent 空间；memory.md 属工作区（不在迁移清单里）', () => {
  assert.deepEqual(
    [...AGENT_SPACE_FILES].sort(),
    ['memory.pending.jsonl', 'profile.json', 'user.md'],
    '三件：L3a 的 user/pending + L4a 的 profile（L1/L2/memory.md 都不在此列）',
  )
  assert.ok(agentSpaceDir().includes('agent-space'), '目录名固定，便于用户自助查找')
  assert.equal(agentSpacePath('user.md'), join(agentSpaceDir(), 'user.md'))
  assert.equal(legacyWorkspacePath('user.md', '/tmp/ws-x'), join('/tmp/ws-x', '.arkwork', 'user.md'))
  // ★ v0.36.3：memory.md 的**生产位置**是工作区（项目偏好/规则随项目走）
  assert.equal(workspaceCuratedMemoryPath('/tmp/ws-x'), join('/tmp/ws-x', '.arkwork', 'memory.md'))
  assert.equal(
    agentSpaceLegacyMemoryPath().includes('agent-space'),
    true,
    'Agent 空间那份只是「回迁源」，不再是生产位置',
  )
  // 关键性质：Agent 空间路径**不含工作区**（否则「跨工作区共享」无从谈起）
  assert.equal(agentSpacePath('profile.json').includes(WS), false)
})

/* ============================================================
 * 二、首次迁移
 * ============================================================ */

test('TC-ASP-002 首次迁移：三件搬入 Agent 空间，原文件改名 .migrated-bak（可回滚）', async () => {
  seedLegacy({
    'user.md': '# 用户\n偏好简洁',
    'memory.pending.jsonl': '{"id":"p1"}\n',
    'profile.json': '{"version":3}',
  })
  const r = await migrateAgentSpace('0.36.0')

  assert.equal(r.error, undefined)
  assert.deepEqual([...r.moved].sort(), [...AGENT_SPACE_FILES].sort())
  for (const f of AGENT_SPACE_FILES) {
    assert.equal(existsSync(agentSpacePath(f)), true, `${f} 必须出现在 Agent 空间`)
    assert.equal(
      existsSync(join(WS, '.arkwork', f)),
      false,
      `${f} 不应再留在工作区（否则读哪份说不清）`,
    )
    assert.equal(
      existsSync(join(WS, '.arkwork', `${f}${MIGRATED_BAK_SUFFIX}`)),
      true,
      `${f} 必须留一份 bak —— 迁移出问题是用户唯一的自救手段`,
    )
  }
  // 内容原样（搬移不是格式化）
  assert.match(readFileSync(agentSpacePath('user.md'), 'utf-8'), /偏好简洁/)
  assert.equal(agentSpaceStatus().migrated, true)
  assert.equal(agentSpaceStatus().marker?.version, '0.36.0')
})

test('TC-ASP-003 幂等：二次调用不重复搬运、不覆盖内容、不产生新 bak', async () => {
  seedLegacy({ 'user.md': 'A' })
  await migrateAgentSpace('0.36.0')
  writeFileSync(agentSpacePath('user.md'), 'B', 'utf-8') // 迁移后用户改过内容

  const second = await migrateAgentSpace('0.36.0')
  assert.equal(second.migrated, false)
  assert.deepEqual(second.moved, [])
  assert.equal(readFileSync(agentSpacePath('user.md'), 'utf-8'), 'B', '幂等调用不得回写旧内容')
})

test('TC-ASP-004 ★ 自愈：标记已存在但工作区又出现旧文件 → 仍会被搬（不留失联记忆）', async () => {
  // 场景：用户装回旧版本跑了一阵 / 从旧机器恢复了工作区备份
  await migrateAgentSpace('0.36.0') // 先建立标记（此时无文件）
  assert.equal(agentSpaceStatus().migrated, true)

  seedLegacy({ 'user.md': '恢复出来的旧画像' })
  const r = await migrateAgentSpace('0.36.0')
  assert.deepEqual(r.moved, ['user.md'], '标记不是「一票否决」：有遗留就要搬')
  assert.equal(readFileSync(agentSpacePath('user.md'), 'utf-8'), '恢复出来的旧画像')
})

/* ============================================================
 * 三、冲突裁决与边界
 * ============================================================ */

test('TC-ASP-005 两处都有 → 以 Agent 空间为准（不覆盖），工作区副本留 bak 并记 conflict', async () => {
  mkdirSync(SPACE, { recursive: true })
  writeFileSync(agentSpacePath('profile.json'), '{"version":9}', 'utf-8')
  seedLegacy({ 'profile.json': '{"version":1}' })

  const r = await migrateAgentSpace('0.36.0')
  assert.deepEqual(r.conflicts, ['profile.json'])
  assert.deepEqual(r.moved, [])
  assert.equal(readFileSync(agentSpacePath('profile.json'), 'utf-8'), '{"version":9}', 'Agent 空间为准')
  assert.equal(
    readFileSync(join(WS, '.arkwork', `profile.json${MIGRATED_BAK_SUFFIX}`), 'utf-8'),
    '{"version":1}',
    '工作区那份留 bak —— 不删数据是底线',
  )
})

test('TC-ASP-006 只有 Agent 空间有、工作区没有 → 什么都不做也不报冲突', async () => {
  mkdirSync(SPACE, { recursive: true })
  writeFileSync(agentSpacePath('user.md'), 'only-here', 'utf-8')
  const r = await migrateAgentSpace('0.36.0')
  assert.deepEqual(r.moved, [])
  assert.deepEqual(r.conflicts, [])
  assert.equal(readFileSync(agentSpacePath('user.md'), 'utf-8'), 'only-here')
})

test('TC-ASP-007 两边都没有 → 正常返回、写标记（不再每次启动重复扫盘）', async () => {
  const r = await migrateAgentSpace('0.36.0')
  assert.equal(r.migrated, false)
  assert.equal(r.error, undefined)
  assert.equal(agentSpaceStatus().migrated, true)
})

test('TC-ASP-008 ★ 失败不写标记：搬不动则整体中止，下次启动可重试（启动不受阻）', async () => {
  // 故障注入：把 agent-space **建成文件**（不是目录）→ mkdir 必然失败
  mkdirSync(agentSpaceDir().replace(/\/agent-space$/, ''), { recursive: true })
  writeFileSync(SPACE, 'not-a-dir', 'utf-8')
  seedLegacy({ 'user.md': '要搬的内容' })

  const r = await migrateAgentSpace('0.36.0')
  assert.ok(r.error, '必须如实返回错误（不静默当成功）')
  assert.equal(existsSync(join(SPACE, '.migrated')), false, '失败不得写标记 —— 否则永远不再重试')
  assert.equal(
    existsSync(join(WS, '.arkwork', 'user.md')),
    true,
    '失败时原文件必须原地不动（宁可没迁成，也不能把数据弄丢）',
  )
})

/* ============================================================
 * 四、生产读写路径确实改到了新位置（改路径不算完，得看真实写入）
 * ============================================================ */

test('TC-ASP-009 ★ L3a 生产读写位置：memory.md 落工作区、user.md 落 Agent 空间', async () => {
  await updateCuratedFile('memory.md', '本项目用 pnpm，测试必须全绿才收尾')
  await updateCuratedFile('user.md', '偏好简洁优雅的 UI')

  assert.equal(
    readFileSync(workspaceCuratedMemoryPath(), 'utf-8'),
    '本项目用 pnpm，测试必须全绿才收尾',
    '项目记忆必须落在工作区（换项目就该换一套）',
  )
  assert.equal(
    existsSync(agentSpacePath('user.md')),
    true,
    '用户偏好留在 Agent 空间（跨工作区通用）',
  )

  const snap = await getCuratedSnapshot()
  assert.equal(snap.memoryMd, '本项目用 pnpm，测试必须全绿才收尾')
  assert.equal(snap.userMd, '偏好简洁优雅的 UI', '两份快照读的是一处真源')
})

test('TC-ASP-010 换工作区：user.md 不失忆（跨工作区共享），memory.md 各归各的项目', async () => {
  await updateCuratedFile('user.md', '属于这个人的偏好，不属于这个项目')
  await updateCuratedFile('memory.md', 'A 项目的约定')

  const wsB = freshWorkspace() // 切到另一个工作区
  assert.notEqual(wsB, WS)
  const snap = await getCuratedSnapshot()
  assert.equal(snap.memoryMd, '', 'B 项目不该继承 A 项目的约定')
  assert.equal(snap.userMd, '属于这个人的偏好，不属于这个项目', '但用户偏好必须还在')

  await updateCuratedFile('memory.md', 'B 项目的约定')
  assert.equal(readFileSync(workspaceCuratedMemoryPath(), 'utf-8'), 'B 项目的约定')
  // A 项目那份原样留在自己的工作区（互不干扰）
  assert.equal(readFileSync(join(WS, '.arkwork', 'memory.md'), 'utf-8'), 'A 项目的约定')
})

/* ============================================================
 * 五、★ v0.36.3：memory.md 从 Agent 空间回迁工作区（TC-MEM-011）
 * ============================================================ */

test('TC-MEM-011 ★ 回迁：Agent 空间旧 memory.md 复制为工作区记忆（幂等 / 不覆盖 / 不删源）', async () => {
  // 场景：v0.36.0–v0.36.2 期间 memory.md 被迁进 Agent 空间，本版要把它搬回工作区
  mkdirSync(SPACE, { recursive: true })
  writeFileSync(agentSpaceLegacyMemoryPath(), '本项目规则：文档先行；测试必须全绿才收尾', 'utf-8')

  const r = await seedWorkspaceMemoryFromAgentSpace()
  assert.equal(r.copied, true)
  assert.equal(
    readFileSync(workspaceCuratedMemoryPath(), 'utf-8'),
    '本项目规则：文档先行；测试必须全绿才收尾',
    '内容必须原样落到工作区',
  )
  assert.equal(
    existsSync(agentSpaceLegacyMemoryPath()),
    true,
    '源文件**不删** —— 用户可能还有别的工作区要拿这份内容',
  )

  // 幂等：再跑一次不会覆盖工作区里已被用户/巩固管线改过的内容
  await updateCuratedFile('memory.md', '工作区自己的现行记忆')
  const again = await seedWorkspaceMemoryFromAgentSpace()
  assert.equal(again.copied, false)
  assert.match(again.reason ?? '', /工作区已有记忆/)
  assert.equal(readFileSync(workspaceCuratedMemoryPath(), 'utf-8'), '工作区自己的现行记忆')

  // 无源时不动：源被清掉后再跑，不该凭空造文件
  rmSync(agentSpaceLegacyMemoryPath(), { force: true })
  const wsC = freshWorkspace()
  const none = await seedWorkspaceMemoryFromAgentSpace()
  assert.equal(none.copied, false)
  assert.match(none.reason ?? '', /无需回迁/)
  assert.equal(existsSync(join(wsC, '.arkwork', 'memory.md')), false, '无源就不该凭空造文件')
})