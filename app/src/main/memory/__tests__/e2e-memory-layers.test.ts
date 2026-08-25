/* ============================================================
 * E2E 验证：L1 → L2 → L3a/L3b 全链路记忆分层产物
 *
 * 在隔离的临时 workspace 驱动真实记忆管线：
 *   L1  appendL1            → .arkwork/memory/{taskId}/l1.jsonl
 *   L2  persistRawL2(大结果) → {workspace}/tasks/{taskId}/.arkwork/steps/{stepId}.json
 *   L3a addPendingLine+applyPending → .arkwork/memory.md / user.md
 *   L3b archiveTaskL1       → .arkwork/archive/items.jsonl + index.json
 *
 * v0.27.0 R0：L4（synthesizeFromTaskL1 真实 LLM 合成 → profile.json）已拆分至
 * e2e-memory-l4-llm.test.ts —— 该用例依赖真实 API key 与网络，不进密闭 npm test 链，
 * 见 scripts/run-tests.mjs EXCLUSIONS 显式欠账清单。
 *
 * 运行：
 *   cd app
 *   npx tsx --experimental-loader ./src/test/electron-mock-loader.mjs \
 *     ./src/main/memory/__tests__/e2e-memory-layers.test.ts
 * ============================================================ */
import { readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setWorkspaceDir, getWorkspaceDir } from '../../store/db.js'
import { appendL1, listL1 } from '../l1-working.js'
import { persistRawL2, listRawL2 } from '../l2-file.js'
import { addPendingLine, applyPending } from '../l3-curated.js'
import { initArchiveIndex, archiveTaskL1, searchArchive } from '../l3-archive.js'

const TASK_ID = 'T-E2E-layers-001'
const TASK_TITLE = '验证记忆分层端到端产物'

// 隔离 workspace，避免污染真实数据
setWorkspaceDir('/tmp/arkwork-e2e-ws')
const WS = getWorkspaceDir()

test('L1: appendL1 → l1.jsonl 出现产物', async () => {
  // v0.27.0 R0：先清场再追加——l1.jsonl 为追加式文件，跨次运行残留会使计数断言翻倍
  await rm(join(WS, '.arkwork', 'memory', TASK_ID), { recursive: true, force: true })
  await appendL1({ taskId: TASK_ID, role: 'system', kind: 'system_prompt', content: '你是 ArkWork 智能体。', enabled: true })
  await appendL1({ taskId: TASK_ID, role: 'user', kind: 'user_message', content: '帮我创建一个 Python 脚本，读取 CSV 并输出统计。', iteration: 0 })
  await appendL1({ taskId: TASK_ID, role: 'assistant', kind: 'plan', iteration: 0, content: '## 计划清单\n1. 分析需求\n2. 编写脚本' })
  // 明确画像信号：偏好 + 纠正（L4 提取依赖）
  await appendL1({ taskId: TASK_ID, role: 'user', kind: 'user_message', content: '注意，我喜欢简洁的代码，注释要充足；另外你这个方案不对，应该用 pandas 而不是手写循环。', iteration: 1 })
  await appendL1({ taskId: TASK_ID, role: 'assistant', kind: 'reasoning', iteration: 2, content: '用户偏好 pandas，我需要改用 pandas 重写统计逻辑。', raw: { reasoningContent: 'deep thinking about csv parsing strategy and edge cases' } })
  await appendL1({ taskId: TASK_ID, role: 'tool', kind: 'observation', iteration: 2, content: '[file-reader] list(.) → 2 entries', enabled: true })

  const all = await listL1(TASK_ID)
  assert.equal(all.length, 6)
  const l1File = join(WS, '.arkwork', 'memory', TASK_ID, 'l1.jsonl')
  assert.equal(existsSync(l1File), true)
  const raw = await readFile(l1File, 'utf-8')
  console.log(`\n✅ L1 产物: ${l1File} (${raw.split('\n').filter(Boolean).length} 条)`)
})

test('L2: persistRawL2 大结果 → steps/{stepId}.json 出现产物', async () => {
  const bigOutput = `{"rows":[${Array.from({ length: 300 }, (_, i) => `{"id":${i},"name":"item-${i}","desc":"${'x'.repeat(30)}"}`).join(',')}]}`
  assert.ok(bigOutput.length > 4000, `fixture 应 >4000 字符，实际 ${bigOutput.length}`)
  const stepId = 'step-e2e-raw'
  const path = await persistRawL2(TASK_ID, stepId, JSON.parse(bigOutput))
  assert.equal(existsSync(path), true)
  const size = (await readFile(path, 'utf-8')).length
  console.log(`✅ L2 产物: ${path} (${size} 字符)`)
})

test('L2: listRawL2 可枚举产物（memory:list 聚合的数据源）', async () => {
  const artifacts = await listRawL2(TASK_ID)
  assert.ok(artifacts.length >= 1, '应至少枚举到 1 个 L2 产物文件')
  const art = artifacts[0]
  assert.equal(art.stepId, 'step-e2e-raw')
  assert.ok(art.size > 4000)
  console.log(`✅ L2 枚举: ${art.path} (stepId=${art.stepId}, ${art.size} 字节)`)
})

test('L3a: addPendingLine + applyPending → memory.md / user.md 出现产物', async () => {
  await addPendingLine('memory.md', '项目使用 Python + pandas 处理数据', TASK_ID)
  await addPendingLine('user.md', '用户偏好简洁、注释充足的代码', TASK_ID)
  const result = await applyPending() // 无 modelId：仅追加不调 LLM
  assert.equal(result.applied, 2)
  for (const f of ['memory.md', 'user.md']) {
    const p = join(WS, '.arkwork', f)
    assert.equal(existsSync(p), true, `${f} 应存在`)
    console.log(`✅ L3a 产物: ${p} (${(await readFile(p, 'utf-8')).length} 字符)`)
  }
})

test('L3b: archiveTaskL1 → archive/items.jsonl + index.json 出现产物并可检索', async () => {
  await initArchiveIndex()
  const l1Items = await listL1(TASK_ID)
  await archiveTaskL1(TASK_ID, TASK_TITLE, l1Items)
  const itemsFile = join(WS, '.arkwork', 'archive', 'items.jsonl')
  const indexFile = join(WS, '.arkwork', 'archive', 'index.json')
  assert.equal(existsSync(itemsFile), true)
  // index.json 为防抖（800ms）异步落盘，轮询等待出现
  let waited = 0
  while (!existsSync(indexFile) && waited < 3000) {
    await new Promise((r) => setTimeout(r, 100))
    waited += 100
  }
  assert.equal(existsSync(indexFile), true, 'index.json 应在防抖窗口内落盘')
  const lines = (await readFile(itemsFile, 'utf-8')).split('\n').filter(Boolean)
  assert.ok(lines.length >= 4, `归档至少 4 条（排除 system_prompt），实际 ${lines.length}`)
  console.log(`✅ L3b 产物: ${itemsFile} (${lines.length} 条) + ${indexFile} (等待 ${waited}ms)`)

  const hits = await searchArchive('csv 统计', 3)
  assert.ok(hits.length > 0, 'archiveSearch 应检索到归档内容')
  console.log(`   archiveSearch("csv 统计") → ${hits.length} 条命中: ${hits[0]?.taskTitle}`)
})
