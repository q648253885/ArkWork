/* ============================================================
 * E2E（非密闭）：L4 synthesizeFromTaskL1 → profile.json（真实 LLM 合成）
 *
 * v0.27.0 R0：自 e2e-memory-layers.test.ts 拆出。本套件依赖：
 *   1. 本机真实 models.json（含 apiKey，~/Library/Application Support/ArkWork）；
 *   2. 外网可达 + deepseek-v4-flash 模型可用。
 * 因此不进 npm test 密闭链，已列入 scripts/run-tests.mjs EXCLUSIONS 显式欠账清单；
 * 需要验证时单跑：
 *   cd app
 *   npx tsx --experimental-loader ./src/test/electron-mock-loader.mjs \
 *     --test ./src/main/memory/__tests__/e2e-memory-l4-llm.test.ts
 *
 * L1→L3 的密闭产物验证见 e2e-memory-layers.test.ts。
 * ============================================================ */
import { mkdir, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setWorkspaceDir, getWorkspaceDir, getArkworkDir } from '../../store/db.js'
import { listL1 } from '../l1-working.js'
import { synthesizeFromTaskL1, getProfile } from '../l4-profile.js'

const TASK_ID = 'T-E2E-layers-001'

// 与 layers 套件同一隔离 workspace（复用其 L1 产物；单独跑时请先跑 layers 套件）
setWorkspaceDir('/tmp/arkwork-e2e-ws')
const WS = getWorkspaceDir()

/** 从真实用户数据复制 models.json（含 apiKey），供 L4 真实 LLM 合成 */
async function ensureModels(): Promise<string> {
  const arkworkDir = getArkworkDir()
  const target = join(arkworkDir, 'models.json')
  const source = join(homedir(), 'Library', 'Application Support', 'ArkWork', 'arkwork-data', 'models.json')
  if (!existsSync(source)) return 'NO_SOURCE'
  await mkdir(arkworkDir, { recursive: true })
  await copyFile(source, target)
  return target
}

test('L4: synthesizeFromTaskL1 → profile.json 出现产物（真实 LLM 合成）', async () => {
  const modelFile = await ensureModels()
  console.log(`   models.json: ${modelFile}`)
  if (modelFile === 'NO_SOURCE') {
    console.log('   ⚠️ 未找到真实 models.json，跳过 L4 真实 LLM 合成')
    return
  }
  const l1Items = await listL1(TASK_ID)
  const result = await synthesizeFromTaskL1(TASK_ID, l1Items, 'deepseek-v4-flash')
  const p = join(WS, '.arkwork', 'profile.json')
  assert.equal(existsSync(p), true)
  const profile = await getProfile()
  console.log(`✅ L4 产物: ${p} (version=${profile.version}, observations=${profile.observations.length}, synthesis=${profile.synthesis.length} 字符)`)
  assert.ok(result.newObservations > 0 || profile.version >= 1, 'L4 应至少产生一条观察或版本推进')
  assert.equal(existsSync(dirname(p)), true)
})
