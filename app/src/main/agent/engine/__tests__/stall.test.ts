/* ============================================================
 * ArkWork — 「零产出轮」守卫单测（v0.34.0 · TC-STALL-001..014）
 * 规格来源：docs/versions/v0.34.0/04-system-design.md §2.1 / §2.2
 *
 * 用户实测缺陷（本组的立组原因）：
 *   Windows 上小参数模型（qwen3.5:0.8b）在「看一下这个工作区的内容」上
 *   进入无限空转 —— 每轮都成功调用一次只读工具（file-reader，2ms）、
 *   内容全空、清单纹丝不动，一路跑到 maxIterations=200（≈100 分钟）。
 *   既有四道保护**全部失效**，原因各不相同（见 stall.ts 头注释）。
 *   因此本组用例的重点不是「正常情况不误伤」，而是
 *   **「每一条既有保护的盲区，新守卫都真的拦得住」**。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs stall
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_STALLED_ROUNDS,
  advanceStallCounter,
  isStallTerminal,
  isStalledRound,
  planSignature,
  type StallRoundInput,
} from '../stall.js'

/** 默认输入：什么都没有发生（判定表的「最坏情况」起点） */
const base: StallRoundInput = {
  hasToolCall: false,
  allReadonly: false,
  hasSayOutput: false,
  hasNewThought: false,
  planProgressed: false,
}

const row = (over: Partial<StallRoundInput>): StallRoundInput => ({ ...base, ...over })

/* ============================================================
 * 1. 真值表（设计 §2.1 的七行，逐行钉死）
 * ============================================================ */

test('TC-STALL-001 真值表逐行穷尽：设计 §2.1 的 7 行判定必须一字不差', () => {
  const table: Array<{ name: string; input: StallRoundInput; expected: boolean }> = [
    // 行 1：没有工具、没有推进、没有输出 —— 哑回合
    { name: '哑回合（无工具 / 无推进 / 无输出）', input: row({}), expected: true },
    // 行 2：正常叙述回合（对用户说了话）
    { name: '纯叙述回合（无工具 / 无推进 / 有输出）', input: row({ hasSayOutput: true }), expected: false },
    // 行 3：收口推进（清单动了）
    { name: '无工具但清单推进', input: row({ planProgressed: true }), expected: false },
    { name: '无工具、清单推进且有输出', input: row({ planProgressed: true, hasSayOutput: true }), expected: false },
    // 行 4：★ 本次报障的形态 —— 空转只读
    { name: '空转只读（有工具 / 全只读 / 无推进 / 无输出）', input: row({ hasToolCall: true, allReadonly: true }), expected: true },
    // 行 5：读后推进
    { name: '只读但有清单推进', input: row({ hasToolCall: true, allReadonly: true, planProgressed: true }), expected: false },
    { name: '只读 + 推进 + 输出', input: row({ hasToolCall: true, allReadonly: true, planProgressed: true, hasSayOutput: true }), expected: false },
    // 行 6：读完有结论
    { name: '只读但有条理输出', input: row({ hasToolCall: true, allReadonly: true, hasSayOutput: true }), expected: false },
    // 行 7：写类动作一律算进展（含「只读 + 写类」混合，allReadonly 为 false）
    { name: '写类工具（非只读）', input: row({ hasToolCall: true, allReadonly: false }), expected: false },
    { name: '写类工具且无任何其他信号', input: row({ hasToolCall: true, allReadonly: false, planProgressed: false, hasSayOutput: false }), expected: false },
    // 行 8（v0.34.x 误杀修正）：有新增思考叙述 = 有信息增益，不算零产出
    // （qwen3.5:9b @ Ollama 实测：「分析工作区」每轮读新文件 + 新思考，say 恒空、
    //  清单不收口，被旧口径连杀两轮 6 轮暂停）
    { name: '哑回合但有新增思考（无工具探索）', input: row({ hasNewThought: true }), expected: false },
    { name: '空转只读但每轮有新发现', input: row({ hasToolCall: true, allReadonly: true, hasNewThought: true }), expected: false },
    // 反向：thought 空 / 与上一轮一字不差的复读仍判零产出（qwen3.5:0.8b 空转、问候循环）
    { name: '空转只读且 thought 复读（hasNewThought=false）', input: row({ hasToolCall: true, allReadonly: true }), expected: true },
    { name: '哑回合且 thought 复读', input: row({}), expected: true },
  ]
  for (const r of table) {
    assert.equal(isStalledRound(r.input), r.expected, `${r.name} → 期望 ${r.expected}`)
  }
  // 穷尽性自检：2^5 = 32 种组合全部可判定（无抛错、无 undefined）
  let n = 0
  for (const hasToolCall of [false, true]) {
    for (const allReadonly of [false, true]) {
      for (const hasSayOutput of [false, true]) {
        for (const hasNewThought of [false, true]) {
          for (const planProgressed of [false, true]) {
            const out = isStalledRound({ hasToolCall, allReadonly, hasSayOutput, hasNewThought, planProgressed })
            assert.equal(typeof out, 'boolean', '穷尽遍历必须返回布尔值')
            n += 1
          }
        }
      }
    }
  }
  assert.equal(n, 32, '5 个布尔维度应穷尽 32 种组合')
})

test('TC-STALL-002 关键不变量：写类工具永远不算零产出（哪怕什么都没推进）', () => {
  // 语义：有产成性动作就是进展 —— 文件可能刚被建出来，清单还没同步
  for (const planProgressed of [false, true]) {
    for (const hasSayOutput of [false, true]) {
      assert.equal(
        isStalledRound(row({ hasToolCall: true, allReadonly: false, planProgressed, hasSayOutput })),
        false,
        '非只读工具（shell 写命令 / task_complete / ask_user / delegate-agent）必须视为有进展',
      )
    }
  }
})

test('TC-STALL-003 关键不变量：有面向用户的输出永远不算零产出', () => {
  for (const hasToolCall of [false, true]) {
    for (const allReadonly of [false, true]) {
      assert.equal(
        isStalledRound(row({ hasToolCall, allReadonly, hasSayOutput: true })),
        false,
        '说了话就算有产出（哪怕没调工具、没推进清单）',
      )
    }
  }
})

test('TC-STALL-004 关键不变量：清单推进永远不算零产出', () => {
  for (const hasToolCall of [false, true]) {
    for (const allReadonly of [false, true]) {
      assert.equal(
        isStalledRound(row({ hasToolCall, allReadonly, planProgressed: true })),
        false,
        '清单状态有变化就是实质进展',
      )
    }
  }
})

test('TC-STALL-005 本次报障的精确形态必须判为零产出（回归锚点）', () => {
  // 逐字复刻 Windows 实测：调了只读工具、参数每轮微变、无输出、清单不动
  const reported: StallRoundInput = {
    hasToolCall: true,
    allReadonly: true,
    hasSayOutput: false,
    hasNewThought: false,
    planProgressed: false,
  }
  assert.equal(isStalledRound(reported), true, '这正是 100 分钟空转的形态，必须被拦')
})

/* ============================================================
 * 2. 计数器推进 / 清零（真实生产函数，非复刻）
 * ============================================================ */

test('TC-STALL-006 零产出连续推进：1 → 2 → … → MAX_STALLED_ROUNDS', () => {
  let c = 0
  for (let i = 1; i <= MAX_STALLED_ROUNDS; i += 1) {
    c = advanceStallCounter(c, true)
    assert.equal(c, i, `第 ${i} 轮零产出后计数应为 ${i}`)
  }
  assert.equal(c, MAX_STALLED_ROUNDS)
})

test('TC-STALL-007 一次实质进展即归零（不累计历史空转）', () => {
  let c = 0
  for (let i = 0; i < MAX_STALLED_ROUNDS - 1; i += 1) c = advanceStallCounter(c, true)
  assert.equal(c, MAX_STALLED_ROUNDS - 1)
  c = advanceStallCounter(c, false)
  assert.equal(c, 0, '有产出轮必须归零 —— 否则「偶发进展」会被历史空转拖进终局')
  // 归零后重新累计需再满 6 轮
  for (let i = 0; i < MAX_STALLED_ROUNDS - 1; i += 1) c = advanceStallCounter(c, true)
  assert.equal(isStallTerminal(c), false, '归零后不足阈值不得判定终局')
})

test('TC-STALL-008 交错序列：空转 3 / 进展 1 / 空转 6 → 只在最后触达阈值', () => {
  const seq = [true, true, true, false, true, true, true, true, true, true]
  let c = 0
  const terminals: number[] = []
  seq.forEach((stalled, i) => {
    c = advanceStallCounter(c, stalled)
    if (isStallTerminal(c)) terminals.push(i)
  })
  assert.deepEqual(terminals, [9], '只有序列末尾那次才达到 6（下标 9）')
})

test('TC-STALL-009 脏输入防御：负数 / NaN / 小数 / 超界一律归一', () => {
  assert.equal(advanceStallCounter(-3, true), 1, '负数按 0 起算')
  assert.equal(advanceStallCounter(Number.NaN, true), 1, 'NaN 按 0 起算')
  assert.equal(advanceStallCounter(2.7, true), 3, '小数向下取整后再 +1')
  assert.equal(advanceStallCounter(-3, false), 0)
  assert.equal(advanceStallCounter(999, false), 0, '归零与当前值无关')
})

test('TC-STALL-010 阈值常量与终局判定同源（防止有人只改一处）', () => {
  assert.equal(MAX_STALLED_ROUNDS, 6, 'Q1 采用值：6 轮')
  assert.equal(isStallTerminal(MAX_STALLED_ROUNDS - 1), false, '差一轮不终局')
  assert.equal(isStallTerminal(MAX_STALLED_ROUNDS), true, '刚好阈值即终局（>= 语义）')
  assert.equal(isStallTerminal(MAX_STALLED_ROUNDS + 5), true, '超过阈值仍然终局')
  assert.equal(isStallTerminal(0), false)
  // 阈值可注入（便于未来按模型能力分级），缺省即生产值
  assert.equal(isStallTerminal(3, 3), true)
  assert.equal(isStallTerminal(3, 4), false)
})

/* ============================================================
 * 3. planSignature（「本轮清单是否推进」的判据）
 * ============================================================ */

test('TC-STALL-011 planSignature：undefined / 空数组 → 空串（同一起点，不误判推进）', () => {
  assert.equal(planSignature(undefined), '')
  assert.equal(planSignature([]), '')
  assert.equal(planSignature(undefined), planSignature([]), '两者必须同形，否则「清单为空」会被误判成推进')
})

test('TC-STALL-012 planSignature：仅 status 敏感 —— 节点数不变、只翻状态即视为推进', () => {
  const before = [{ status: 'pending' }, { status: 'pending' }]
  const after = [{ status: 'running' }, { status: 'pending' }]
  assert.notEqual(planSignature(before), planSignature(after), '状态翻转必须被识别为推进')
  // 同一状态序列 → 签名相同（这才是「零产出」成立的前提）
  assert.equal(planSignature(before), planSignature([{ status: 'pending' }, { status: 'pending' }]))
})

test('TC-STALL-013 planSignature：纯文本字段变化不构成推进（防「假装在动」）', () => {
  const a = [{ status: 'running', title: '步骤一' }]
  const b = [{ status: 'running', title: '步骤一（改）' }]
  assert.equal(planSignature(a), planSignature(b), '文案改动不是进展 —— 否则模型改标题就能永远逃避守卫')
})

test('TC-STALL-014 签名是快照字符串：底层对象后续被改写不回溯影响已存快照', () => {
  // loop.ts 的用法：Act 之前存 `planSigBefore`（字符串），Act 之后重新求值比较。
  // 若签名返回的是「对象引用组成的数组」，就地基被原地改写后比较会恒等 → 守卫永不触发。
  const items = [{ status: 'pending' }]
  const before = planSignature(items)
  items[0]!.status = 'done' // 原地改写（loop.ts 第 772 行正是这种写法）
  const after = planSignature(items)
  assert.equal(before, 'pending', '快照必须是值语义（字符串），不能随对象变化')
  assert.equal(after, 'done')
  assert.notEqual(before, after, '快照必须能反映后续变化 —— 这正是「本轮是否推进」的判据')
})
