/* ============================================================
 * ArkWork — 插件可逆 effect 账本单测（v0.35.0 · B2/B11 建立）
 * 规格来源：docs/versions/v0.35.0/04-system-design.md §3（M5）· §6.3
 *   纪律⑬ 原文：「**卸载路径必须与装载路径对称** —— 只有装载代码没有卸载代码
 *               = 未完成」；§6.3 对称性把守：「测试用『装载→卸载→比对账本为空
 *               + 插槽集合回到装载前』判定」。
 *
 * 病（D74）：v0.34.x 靠「枚举来源再重注册」来撤销，漏一种来源就留下静默残留
 *   （插槽还在、定时器还在、watcher 还在），且无处可查。
 * 治法：装载期记账，卸载期按账本**逆序**撤销。本文件逐条钉住「治法」的每个性质。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs plugin-effects
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PluginEffectLedger, type Disposer } from '../effects.js'

/** 记录调用顺序的 disposer */
function recorder(log: string[], tag: string, opts: { throw?: boolean } = {}): Disposer {
  return () => {
    log.push(tag)
    if (opts.throw) throw new Error(`${tag} 炸了`)
  }
}

/* ============================================================
 * 1. 记账与句柄
 * ============================================================ */

test('TC-PEFF-001 register 入账；countOf / totalCount / pluginIds / entriesOf 如实反映', () => {
  const led = new PluginEffectLedger()
  assert.equal(led.countOf('a'), 0)
  assert.equal(led.totalCount(), 0)
  assert.deepEqual(led.pluginIds(), [])

  led.register('a', 'slot', 'ui.panel p1', () => {})
  led.register('a', 'timer', 'poll 8s', () => {})
  led.register('b', 'tool', 'my_tool', () => {})

  assert.equal(led.countOf('a'), 2)
  assert.equal(led.countOf('b'), 1)
  assert.equal(led.totalCount(), 3)
  assert.deepEqual(led.pluginIds().sort(), ['a', 'b'])
  assert.deepEqual(
    led.entriesOf('a').map((e) => e.kind),
    ['slot', 'timer'],
  )
  // seq 递增（撤销按倒序，诊断也用得到）
  const seqs = led.entriesOf('a').map((e) => e.seq)
  assert.ok(seqs[1]! > seqs[0]!, 'seq 必须递增')
})

test('TC-PEFF-002 ★ register 未给撤销函数 = 编程错误，必须早失败（不得静默入账一条撤不掉的）', () => {
  const led = new PluginEffectLedger()
  for (const bad of [undefined, null, 'nope', 42, {}]) {
    assert.throws(
      () => led.register('a', 'slot', 'x', bad as unknown as Disposer),
      /未提供撤销函数/,
      `${String(bad)} 应被拒绝`,
    )
  }
  assert.equal(led.totalCount(), 0, '拒绝的登记不得留在账本里')
})

/* ============================================================
 * 2. ★ 纪律⑬：装载 → 卸载 → 账本为空
 * ============================================================ */

test('TC-PEFF-003 ★ 对称性：装载 N 条 → revokeAll → 账本归零且 disposer 全部跑到', async () => {
  const led = new PluginEffectLedger()
  const log: string[] = []
  const kinds = ['slot', 'timer', 'watcher', 'tool', 'view-session'] as const
  for (const k of kinds) led.register('p', k, `${k}-1`, recorder(log, k))
  assert.equal(led.countOf('p'), kinds.length)

  const res = await led.revokeAll('p')
  assert.equal(res.revoked, kinds.length)
  assert.deepEqual(res.failed, [])
  assert.equal(led.countOf('p'), 0, '撤销后账本必须为空（这就是对称性判据）')
  assert.equal(led.totalCount(), 0)
  assert.deepEqual(led.pluginIds(), [])
  assert.deepEqual(log.sort(), [...kinds].sort(), '每一条 disposer 都必须真的跑到')
})

test('TC-PEFF-004 ★ 逆序（LIFO）撤销：后登记的先生效（资源释放的通用正确顺序）', async () => {
  const led = new PluginEffectLedger()
  const log: string[] = []
  led.register('p', 'a', '1', recorder(log, '1'))
  led.register('p', 'b', '2', recorder(log, '2'))
  led.register('p', 'c', '3', recorder(log, '3'))
  await led.revokeAll('p')
  assert.deepEqual(log, ['3', '2', '1'], '必须逆序撤销')
})

/* ============================================================
 * 3. 逐条隔离与幂等（卸载路径的健壮性）
 * ============================================================ */

test('TC-PEFF-005 ★ 逐条隔离：一条抛错不得中断其余；失败项以 kind:label → 原因 收口', async () => {
  const led = new PluginEffectLedger()
  const log: string[] = []
  led.register('p', 'slot', 'ok-1', recorder(log, 'ok-1'))
  led.register('p', 'timer', 'bad', recorder(log, 'bad', { throw: true }))
  led.register('p', 'tool', 'ok-2', recorder(log, 'ok-2'))

  const res = await led.revokeAll('p')
  assert.equal(res.revoked, 2, '其余两条必须照常撤销')
  assert.equal(res.failed.length, 1)
  assert.match(res.failed[0]!, /timer:bad/)
  assert.match(res.failed[0]!, /炸了/)
  assert.deepEqual(log, ['ok-2', 'bad', 'ok-1'], '抛错的那条不许中断流程')
  assert.equal(led.countOf('p'), 0, '失败也不留在账本里 —— 否则每轮都要重试同一条')
})

test('TC-PEFF-006 幂等：重复 revokeAll 为空操作（工作区切换 + 禁用 + 退出可能叠加触发）', async () => {
  const led = new PluginEffectLedger()
  const log: string[] = []
  led.register('p', 'slot', 'x', recorder(log, 'x'))

  const first = await led.revokeAll('p')
  assert.equal(first.revoked, 1)
  const second = await led.revokeAll('p')
  assert.deepEqual(second, { revoked: 0, failed: [] })
  assert.deepEqual(log, ['x'], 'disposer 不得被跑第二次')

  // 从未登记的插件也是空操作（不抛）
  assert.deepEqual(await led.revokeAll('never-registered'), { revoked: 0, failed: [] })
})

test('TC-PEFF-007 多插件隔离：撤销 A 不碰 B', async () => {
  const led = new PluginEffectLedger()
  const log: string[] = []
  led.register('a', 'slot', 'a1', recorder(log, 'a1'))
  led.register('b', 'slot', 'b1', recorder(log, 'b1'))
  await led.revokeAll('a')
  assert.equal(led.countOf('a'), 0)
  assert.equal(led.countOf('b'), 1, 'B 必须原封不动')
  assert.deepEqual(log, ['a1'])
})

/* ============================================================
 * 4. kinds 过滤：插槽重注册 ≠ 插件卸载
 * ============================================================ */

test('TC-PEFF-008 ★ kinds 过滤：只撤 slot，tool/view/timer 必须留下（否则宿主与插件状态分叉）', async () => {
  const led = new PluginEffectLedger()
  const log: string[] = []
  led.register('p', 'slot', 's1', recorder(log, 's1'))
  led.register('p', 'slot', 's2', recorder(log, 's2'))
  led.register('p', 'tool', 't1', recorder(log, 't1'))
  led.register('p', 'timer', 'tm1', recorder(log, 'tm1'))

  const res = await led.revokeAll('p', { kinds: ['slot'] })
  assert.equal(res.revoked, 2)
  assert.deepEqual(log, ['s2', 's1'], '只撤 slot，且仍按逆序')
  assert.deepEqual(
    led.entriesOf('p').map((e) => e.kind).sort(),
    ['timer', 'tool'],
    '其余类别必须留着 —— 插件进程还以为自己注册着工具，宿主不能先忘了',
  )
  // 再撤剩下两类
  assert.equal((await led.revokeAll('p')).revoked, 2)
  assert.equal(led.countOf('p'), 0)
})

test('TC-PEFF-009 kinds 过滤：类目全不命中 → 空操作（不误伤、不写回）', async () => {
  const led = new PluginEffectLedger()
  const log: string[] = []
  led.register('p', 'tool', 't1', recorder(log, 't1'))
  const res = await led.revokeAll('p', { kinds: ['slot'] })
  assert.deepEqual(res, { revoked: 0, failed: [] })
  assert.equal(led.countOf('p'), 1)
  assert.deepEqual(log, [])
})

/* ============================================================
 * 5. 提前主动释放句柄
 * ============================================================ */

test('TC-PEFF-010 句柄提前释放：跑一次即出账，重复调用幂等', () => {
  const led = new PluginEffectLedger()
  const log: string[] = []
  const release = led.register('p', 'timer', 'once', recorder(log, 'once'))
  release()
  assert.deepEqual(log, ['once'])
  assert.equal(led.countOf('p'), 0)
  release() // 再来一次
  assert.deepEqual(log, ['once'], '不得重复执行 disposer')
})

test('TC-PEFF-011 ★ 已 revokeAll 之后再调句柄：不抛、也不误删同插件的其它条目', async () => {
  const led = new PluginEffectLedger()
  const log: string[] = []
  const release = led.register('p', 'a', '1', recorder(log, '1'))
  led.register('p', 'b', '2', recorder(log, '2'))
  await led.revokeAll('p', { kinds: ['b'] })
  assert.equal(led.countOf('p'), 1)
  assert.doesNotThrow(() => release())
  assert.equal(led.countOf('p'), 0, '句柄只该摘掉自己那一条')
})

test('TC-PEFF-012 句柄的 disposer 抛错不冒泡给调用方（卸载全流程还会再兜一次）', () => {
  const led = new PluginEffectLedger()
  const release = led.register('p', 'timer', 'boom', () => {
    throw new Error('释放失败')
  })
  assert.doesNotThrow(() => release())
  assert.equal(led.countOf('p'), 0)
})

/* ============================================================
 * 6. 诊断视图与收尾
 * ============================================================ */

test('TC-PEFF-013 kindsOf 按类别汇总（诊断面板「这个插件留了 3 个定时器」靠它）', () => {
  const led = new PluginEffectLedger()
  led.register('p', 'timer', 'a', () => {})
  led.register('p', 'timer', 'b', () => {})
  led.register('p', 'slot', 'c', () => {})
  assert.deepEqual(led.kindsOf('p'), { timer: 2, slot: 1 })
  assert.deepEqual(led.kindsOf('unknown'), {})
})

test('TC-PEFF-014 clear 清空全部并重置 seq；新实例之间不共享任何状态', () => {
  const a = new PluginEffectLedger()
  const b = new PluginEffectLedger()
  a.register('p', 'slot', 'x', () => {})
  assert.equal(b.totalCount(), 0, '两个账本必须互相独立')

  a.clear()
  assert.equal(a.totalCount(), 0)
  assert.deepEqual(a.pluginIds(), [])
  // seq 重置：clear 后首条的 seq 回到 1
  a.register('p', 'slot', 'y', () => {})
  assert.equal(a.entriesOf('p')[0]!.seq, 1)
})
