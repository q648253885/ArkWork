/* ============================================================
 * ArkWork — 限流器 registry 接线契约用例（v0.48.0 · TC-RLA，W2）
 *
 * buildAdapter 是 18 个 getAdapter 调用点的唯一汇聚处 —— 在此套
 * wrapWithRateLimit 即可零改动覆盖全部 LLM 通道。本套件锁定：
 *   · registry.ts 的包装接线真实存在（有写必须有读，纪律⑭）；
 *   · 模型配置更新的失效路径（adapters.delete → 重建即生效）未被破坏；
 *   · rate-limit.ts 的覆盖面（complete + completeStream）与单一判据；
 *   · shared 类型契约（LlmRateLimitConfig / LlmModel.rateLimit）。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs rate-limit-registry-wiring
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 注释剥离器唯一真源（纪律㉒） */
import { stripComments } from '@shared/utils/source-guard'

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')
const REG = stripComments(read('../registry.ts'))
const RL = stripComments(read('../rate-limit.ts'))
const TYPES = stripComments(read('../../../shared/types/agent.ts'))

test('TC-RLA-001 ★ registry 接线：buildAdapter 返回前套 wrapWithRateLimit；配置失效路径完好', () => {
  assert.match(REG, /import \{ wrapWithRateLimit \} from '\.\/rate-limit\.js'/, '包装器导入存在')
  assert.match(REG, /return wrapWithRateLimit\(buildRawAdapter\(model\), model,/, 'buildAdapter 返回前必须包装（唯一汇聚点）')
  assert.match(REG, /function buildRawAdapter\(model: LlmModel\): LlmAdapter/, '原始构造拆分为 buildRawAdapter')
  // 模型配置更新/删除的缓存失效路径 —— 限频参数变更靠「重建即生效」
  assert.match(REG, /adapters\.delete\(model\.id\)/, 'updateModel 必须失效缓存（限频修改后重建生效）')
  assert.match(REG, /adapters\.delete\(id\)/, 'removeModel 必须失效缓存')
})

test('TC-RLA-002 ★ 包装覆盖面：complete + completeStream 双入口；未配置直通判据唯一', () => {
  assert.match(RL, /complete: \(req\) =>\s*limiter\.run/, 'complete 入口经 limiter.run')
  assert.match(RL, /wrapped\.completeStream = \(req, handlers\) =>\s*limiter\.run/, 'completeStream 入口经 limiter.run')
  assert.match(RL, /const params = effectiveRateLimit\(model\)/, '判据唯一：effectiveRateLimit（UI 与包装层共用）')
  assert.match(RL, /if \(!params\) return adapter/, '未配置 → 原样返回（零开销直通）')
  assert.match(RL, /return adapter\.complete\(req\)\s*\}, req\.signal\)/, 'complete 入口 signal 透传（中止语义）')
  assert.match(RL, /return stream\(req, handlers\)\s*\}, req\.signal\)/, 'completeStream 入口 signal 透传（中止语义）')
})

test('TC-RLA-003 ★ 类型契约：LlmRateLimitConfig 两字段可选 + LlmModel.rateLimit 可选（缺省零影响）', () => {
  assert.match(TYPES, /export interface LlmRateLimitConfig \{/, '类型定义存在')
  assert.match(TYPES, /minIntervalMs\?: number/, 'minIntervalMs 可选（0/undefined = 不限制）')
  assert.match(TYPES, /maxConcurrent\?: number/, 'maxConcurrent 可选（0/undefined = 不限制）')
  assert.match(TYPES, /rateLimit\?: LlmRateLimitConfig/, 'LlmModel.rateLimit 可选挂载')
})
