/**
 * v0.30.1 详测 — TC-PRELOAD（桥接契约）
 *
 * 依据：docs/versions/v0.30.1/04-system-design.md §5.2（缺口 F3-1）
 *       docs/versions/v0.30.1/testcases/00-cumulative-matrix.md §3.4
 *
 * 本套件为**源码契约**（readFileSync + 正则）：preload 依赖 electron 运行时，
 * node:test 无 electron，故锁定「白名单存在性 + 映射目标」这一结构性不变量，
 * 与 v018-plan-item-patch-broadcast.test.ts 同手法。
 *
 * 运行（cwd=app）：
 *   npx tsx --test src/preload/__tests__/graph-default-policy.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf-8')

const PRELOAD = read('../index.ts')
const IPC_TYPES = read('../../shared/types/ipc.ts')
const MAIN_GRAPH = read('../../main/ipc/graph.ts')

/* ============================================================
 * 一、纯新增契约：graph.defaultPolicy 存在且映射到既有频道
 * ============================================================ */

test('TC-PRELOAD-001 preload graph API 含 defaultPolicy 且映射 graph:default-policy', () => {
  assert.match(
    PRELOAD,
    /defaultPolicy:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('graph:default-policy'\)/,
    'preload 的 graph.defaultPolicy 应映射到 graph:default-policy',
  )
  assert.match(
    MAIN_GRAPH,
    /ipcMain\.handle\('graph:default-policy'/,
    'main 侧应已注册 graph:default-policy handler（F3-1 复用的是既有频道）',
  )
  assert.ok(
    IPC_TYPES.includes('defaultPolicy') && IPC_TYPES.includes('PolicyBlock'),
    'ArkApi.graph 类型应声明 defaultPolicy: () => Promise<PolicyBlock>',
  )
})

/* ============================================================
 * 二、兼容性：既有 graph 白名单逐项不变（无移除 / 无改名）
 * ============================================================ */

test('TC-PRELOAD-002 既有 graph:* 白名单项逐项不变（纯新增）', () => {
  const inherited: Array<[string, string]> = [
    ['get', 'graph:get'],
    ['snapshot', 'graph:snapshot'],
    ['updateNode', 'graph:update-node'],
    ['createNode', 'graph:create-node'],
    ['deleteNode', 'graph:delete-node'],
    ['setStatus', 'graph:set-status'],
    ['answerBlock', 'graph:answer-block'],
    ['decideReplan', 'graph:decide-replan'],
    ['resolveConverge', 'graph:resolve-converge'],
    ['setTier', 'graph:set-tier'],
    ['exportMd', 'graph:export-md'],
    ['restoreSnapshot', 'graph:restore-snapshot'],
    ['runConverge', 'graph:run-converge'],
    ['pendingPatches', 'graph:pending-patches'],
    ['metrics', 'graph:metrics'],
    ['pendingPlan', 'graph:pending-plan'],
    ['decidePlan', 'graph:decide-plan'],
  ]
  for (const [method, channel] of inherited) {
    assert.match(
      PRELOAD,
      new RegExp(`${method}:\\s*\\([^)]*\\)\\s*=>\\s*ipcRenderer\\.invoke\\('${channel}'`),
      `既有 graph.${method} → ${channel} 不得移除或改名`,
    )
  }
  assert.match(PRELOAD, /onUpdate:\s*\(cb\)\s*=>/, '既有 graph.onUpdate 订阅通道不得移除')
})
