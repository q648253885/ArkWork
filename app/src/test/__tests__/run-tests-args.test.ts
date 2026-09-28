/* ============================================================
 * TC-RUNNER —— 测试 runner 参数构造（v0.38.1 · D164）
 *
 * 背景：D158 的 `node --import tsx/esm` 依赖 node ≥ 20.6；用户实机
 * v18.11.0 上 runner 直接 `bad option: --import` 退出（此前从未在本机
 * 跑通过）。D164 把「按 node 版本选 flag」收敛为纯函数
 * `scripts/run-tests-args.mjs`（单一事实源），本文件直测其决策表。
 *
 * 判据来源（本机实测）：
 *   · v18.11.0：`--import` 不可用（CLI 与 NODE_OPTIONS 双拒）、
 *     `--test-concurrency` 不可用（18.17 才有）、
 *     `--experimental-loader tsx/esm` + mock loader 双链 3/3 绿（0.7s/文件）
 *   · v20.6+：`--import` 快路径（D158 原设计，语义不变）
 * ============================================================ */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCleanupInjection,
  buildTsLoaderArgs,
  nodeSupport,
  parseNodeVersion,
  resolvePoolSize,
} from '../../../scripts/run-tests-args.mjs'

const MOCK_URL = 'file:///app/src/test/electron-mock-loader.mjs'

describe('TC-RUNNER parseNodeVersion', () => {
  it('TC-RUNNER-001 解析 v18.11.0 / 裸版本 / 非法输入', () => {
    assert.deepEqual(parseNodeVersion('v18.11.0'), { major: 18, minor: 11, patch: 0 })
    assert.deepEqual(parseNodeVersion('20.6.1'), { major: 20, minor: 6, patch: 1 })
    assert.deepEqual(parseNodeVersion(undefined), { major: 0, minor: 0, patch: 0 })
    assert.deepEqual(parseNodeVersion('garbage'), { major: 0, minor: 0, patch: 0 })
  })
})

describe('TC-RUNNER nodeSupport 能力位', () => {
  it('TC-RUNNER-002a v18.11：--import / --test-concurrency / isolation 全不可用', () => {
    const s = nodeSupport({ major: 18, minor: 11, patch: 0 })
    assert.equal(s.tsxViaImport, false)
    assert.equal(s.testConcurrency, false)
    assert.equal(s.isolationNone, false)
  })
  it('TC-RUNNER-002b 边界：v18.17 有 concurrency；v20.6 有 --import；v20 无 isolation 门槛', () => {
    assert.equal(nodeSupport({ major: 18, minor: 17, patch: 0 }).testConcurrency, true)
    assert.equal(nodeSupport({ major: 18, minor: 16, patch: 9 }).testConcurrency, false)
    assert.equal(nodeSupport({ major: 20, minor: 5, patch: 0 }).tsxViaImport, false)
    assert.equal(nodeSupport({ major: 20, minor: 6, patch: 0 }).tsxViaImport, true)
    assert.equal(nodeSupport({ major: 20, minor: 0, patch: 0 }).isolationNone, true)
    assert.equal(nodeSupport({ major: 21, minor: 0, patch: 0 }).tsxViaImport, true)
  })
})

describe('TC-RUNNER buildTsLoaderArgs', () => {
  it('TC-RUNNER-003a node18 → 双 experimental-loader 链（tsx 在前，mock 在后）', () => {
    const args = buildTsLoaderArgs(nodeSupport({ major: 18, minor: 11, patch: 0 }), MOCK_URL)
    assert.deepEqual(args, ['--experimental-loader', 'tsx/esm', '--experimental-loader', MOCK_URL])
    assert.ok(!args.includes('--import'), 'node18 不得出现 --import（bad option 根因）')
  })
  it('TC-RUNNER-003b node20.6+ → --import tsx/esm 快路径 + mock loader（D158 原语义）', () => {
    const args = buildTsLoaderArgs(nodeSupport({ major: 20, minor: 6, patch: 0 }), MOCK_URL)
    assert.deepEqual(args, ['--import', 'tsx/esm', '--experimental-loader', MOCK_URL])
  })
})

describe('TC-RUNNER buildCleanupInjection', () => {
  it('TC-RUNNER-004a node18 → --require tmp-cleanup.cjs（--import 不允许进 NODE_OPTIONS；且 --require 只收路径不收 URL）', () => {
    const inj = buildCleanupInjection(
      nodeSupport({ major: 18, minor: 11, patch: 0 }),
      'file:///mjs',
      '/app/src/test/tmp-cleanup.cjs',
    )
    assert.equal(inj.flag, '--require')
    assert.equal(inj.url, '/app/src/test/tmp-cleanup.cjs')
  })
  it('TC-RUNNER-004b node20.6+ → --import tmp-cleanup.mjs（D148 原语义）', () => {
    const inj = buildCleanupInjection(
      nodeSupport({ major: 20, minor: 6, patch: 0 }),
      'file:///mjs',
      'file:///cjs',
    )
    assert.equal(inj.flag, '--import')
    assert.equal(inj.url, 'file:///mjs')
  })
})

describe('TC-RUNNER resolvePoolSize（D164 全局并发池）', () => {
  it('TC-RUNNER-005a 均未设 → 自动 min(cpu-1, 8)', () => {
    assert.equal(resolvePoolSize(undefined, undefined, 10), 8)
    assert.equal(resolvePoolSize(undefined, '', 4), 3)
    assert.equal(resolvePoolSize(undefined, undefined, 2), 1)
    assert.equal(resolvePoolSize(undefined, undefined, 0), 1)
  })
  it('TC-RUNNER-005b TEST_CONCURRENCY 优先于 TEST_SHARDS；非法/0/负 → 1；小数向下取整', () => {
    assert.equal(resolvePoolSize('4', '2', 10), 4)
    assert.equal(resolvePoolSize(undefined, '2', 10), 2)
    assert.equal(resolvePoolSize('1', undefined, 10), 1)
    assert.equal(resolvePoolSize('abc', undefined, 10), 1)
    assert.equal(resolvePoolSize(undefined, '0', 10), 1)
    assert.equal(resolvePoolSize('-2', undefined, 10), 1)
    assert.equal(resolvePoolSize('2.9', undefined, 10), 2)
  })
})
