/* ============================================================
 * ArkWork — B3 投影等价性测试（§6.6 R1 缓解 · 先测后写的落点）
 *
 * 方法：对同一历史任务，比较
 *   旧路径  deriveConversation(task, steps, memory) 的可见序列
 *   新路径  projectConversation(...) 拍平后的可见序列
 * 规范形式：Array<[blockKind, visibleText.slice(0, 200)]>
 *
 * 口径（§6.6，已登记 §11 的两条刻意差异）：
 *  - 「可见文本」= 块承载的正文（展开态可得），折叠摘要行 / hover 时间戳不计入；
 *  - 新路径独有可见类型 { notice, error } 为本版新增能力（软失败通告 / 轮级错误），
 *    旧行为本就不展示 —— 按登记修复过滤后必须逐块相等，不允许「看起来差不多」。
 *
 * 数据：app/.dev-data/arkwork-data 真实历史任务（steps.jsonl + l1.jsonl）。
 * 该目录为开发机 userData（不入库）；缺失时条件注册占位测试（显式登记，不静默造假）。
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { ConversationItem } from '@shared/types/conversation'
import type { ReActStep } from '@shared/types/react'
import type { MemoryItem } from '@shared/types/memory'
import type { Task } from '@shared/types/task'
import type { FlowBlock, FlowTurn } from '@shared/types/flow'
// v0.31.0 B3：旧路径对照取自纯模块（meta.ts 同名转出口，但直接引纯模块避免 i18n 链）
import { deriveConversation } from '../../store/derive-conversation'
import { reasoningText } from '@shared/utils/reasoning'
import { projectConversation, turnRenderSequence } from '../project'
import type { FlowUiState } from '../../store/types'

/* ---------- 真实数据定位（app/.dev-data/arkwork-data） ---------- */
/** 数据集中的任务（按 steps.jsonl 行数排序取代表性样本：最大 / 中等 / 小型） */
const FIXTURE_TASKS = ['T-20260811-3q6l0m', 'T-20260812-0q4l0l', 'T-20260803-3y4s3v']

const APP_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const DEV_DATA = join(APP_ROOT, '.dev-data', 'arkwork-data')
const WS = join(DEV_DATA, 'workspace', 'default', '.arkwork')
/** 数据判据锚定数据本体（steps.jsonl）而非 tasks.json —— 该 dev 实例未生成任务库
 * 也能跑等价（loadTask 有 null 回落，两侧同源输入不受影响）。 */
const HAS_DATA = existsSync(join(WS, 'memory', FIXTURE_TASKS[0], 'steps.jsonl'))

const loadSteps = (taskId: string): ReActStep[] => {
  const f = join(WS, 'memory', taskId, 'steps.jsonl')
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as ReActStep)
}

const loadMemory = (taskId: string): MemoryItem[] => {
  const f = join(WS, 'memory', taskId, 'l1.jsonl')
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as MemoryItem)
}

const loadTask = (taskId: string): Task | null => {
  const f = join(WS, 'tasks.json')
  if (!existsSync(f)) return null
  const raw = JSON.parse(readFileSync(f, 'utf8')) as unknown
  const arr: Task[] = Array.isArray(raw)
    ? (raw as Task[])
    : ((raw as { tasks?: Task[] }).tasks ?? [])
  return arr.find((t) => t?.id === taskId) ?? null
}

/* ---------- 旧路径规范序列（ConversationItem[] → canonical） ---------- */
type Canonical = Array<[string, string]>

function canonicalFromItems(items: ConversationItem[]): Canonical {
  const out: Canonical = []
  for (const item of items) {
    if (item.type === 'user') {
      out.push(['user', item.text ?? ''])
    } else if (item.type === 'plan') {
      out.push(['plan', item.plan?.goal ?? ''])
    } else if (item.type === 'assistant') {
      out.push(['answer', item.text ?? ''])
    } else if (item.type === 'react') {
      let sawTool = false
      const group = [...(item.steps ?? [])].sort((a, b) => a.startedAt - b.startedAt)
      for (const s of group) {
        if (s.type === 'reason') {
          if ((s.say ?? '').trim()) out.push(['say', s.say!])
          const t = reasoningText(s)
          if (t.trim()) out.push(['reasoning', t])
        } else if (s.type === 'act') {
          sawTool = true
          // 与新投影同一条 intent 规则（trim 后空串回落 toolName），保证口径一致
          out.push(['tool', (s.intent ?? '').trim() || s.toolName || ''])
        } else if (s.type === 'observation') {
          if (!sawTool) out.push(['tool', s.summary ?? '']) // 孤儿观察自成一卡
        }
      }
    }
  }
  return out.map(([k, v]) => [k, v.slice(0, 200)] as [string, string])
}

/* ---------- 新路径规范序列（FlowTurn[] → canonical） ---------- */
const NEW_KINDS = new Set(['notice', 'error']) // §11 登记的新增可见类型（本版能力，非回归）

function visibleOf(b: FlowBlock): string {
  switch (b.kind) {
    case 'user': return b.text
    case 'say': return b.text
    case 'reasoning': return b.text
    case 'answer': return b.text
    case 'tool': return b.intent ?? b.call.title
    case 'plan': return b.goal
    case 'notice': return b.text
    case 'error': return b.text
    case 'approval': return b.cardKind
  }
}

function canonicalFromTurns(turns: FlowTurn[]): Canonical {
  const out: Canonical = []
  for (const t of turns) {
    for (const b of turnRenderSequence(t)) {
      if (NEW_KINDS.has(b.kind)) continue
      out.push([b.kind, visibleOf(b).slice(0, 200)])
    }
  }
  return out
}

/* ---------- 共用驱动 ---------- */
const UI: FlowUiState = {
  viewMode: 'standard',
  showThinking: true,
  blockUiState: {},
  turnUiState: {},
  scrollAnchorByTask: {},
}

function assertEquivalent(taskId: string): void {
  const task = loadTask(taskId) ?? ({
    id: taskId,
    input: { text: '' },
    createdAt: 0,
  } as unknown as Task)
  const steps = loadSteps(taskId)
  const memory = loadMemory(taskId)
  assert.ok(steps.length > 0, `${taskId} 无 steps.jsonl，数据集失效`)

  const items = deriveConversation(task, steps, memory)
  const turns = projectConversation({
    taskId,
    items,
    steps,
    events: [], // 渲染层暂无 session 事件通道（§11 登记）；本测试锚定 items/steps 等价
    streamBuffers: {},
    planItems: task.planItems ?? [],
    viewMode: 'standard',
    showThinking: true,
    ui: UI,
    now: 0,
  })

  const oldSeq = canonicalFromItems(items)
  const newSeq = canonicalFromTurns(turns)

  // 差异定位：给出首个不一致处，便于逐条判定「修复 vs 回归」
  if (JSON.stringify(oldSeq) !== JSON.stringify(newSeq)) {
    const n = Math.max(oldSeq.length, newSeq.length)
    for (let i = 0; i < n; i++) {
      const o = JSON.stringify(oldSeq[i] ?? null)
      const w = JSON.stringify(newSeq[i] ?? null)
      if (o !== w) {
        assert.fail(
          `等价性差异 @${i}（旧 ${oldSeq.length} 块 / 新 ${newSeq.length} 块）\n` +
          `  旧: ${o}\n  新: ${w}`,
        )
      }
    }
  }
  assert.deepEqual(newSeq, oldSeq, `${taskId} 投影可见序列与旧路径不等价`)
}

/* ============================================================
 * TC-FLOW-005 / 006 / 007：真实历史任务投影等价（v0.4–v0.30 各时期形态）
 * 数据缺失时条件注册一个占位测试（显式登记，不静默造假；
 * Node v18 test runner 无 test.skip 静态方法，故用条件注册）。
 * ============================================================ */
if (HAS_DATA) {
  for (const taskId of FIXTURE_TASKS) {
    test(`TC-FLOW 等价性 · ${taskId}（真实历史任务）`, () => {
      assertEquivalent(taskId)
    })
  }

  test('TC-FLOW 等价性 · 纯函数等幂（真实数据两次求值一致）', () => {
    const taskId = FIXTURE_TASKS[0]
    const task = loadTask(taskId) ?? ({
      id: taskId,
      input: { text: '' },
      createdAt: 0,
    } as unknown as Task)
    const steps = loadSteps(taskId)
    const memory = loadMemory(taskId)
    const items = deriveConversation(task, steps, memory)
    const input = {
      taskId,
      items,
      steps,
      events: [],
      streamBuffers: {},
      planItems: task?.planItems ?? [],
      viewMode: 'standard' as const,
      showThinking: true,
      ui: UI,
      now: 0,
    }
    const a = JSON.stringify(projectConversation(input))
    const b = JSON.stringify(projectConversation(input))
    assert.equal(a, b, '同一输入两次投影结果必须逐字节一致（纯函数硬规则 §3.3-2）')
  })
} else {
  test('TC-FLOW 等价性 · app/.dev-data 数据集缺失（占位：数据集仅存在于开发机 userData）', () => {
    assert.ok(!HAS_DATA, '数据集存在性已翻转，请核对 HAS_DATA 判据')
  })
}
