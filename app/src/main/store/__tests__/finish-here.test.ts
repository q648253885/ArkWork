/* ============================================================
 * ArkWork — 「就此结束」硬终局拦截接线契约（v0.41.0 / TC-FH-001…005 · D207）
 * 上游：docs/versions/v0.41.0/testcases/00-cumulative-matrix.md 模块 N
 * 运行（cwd=app）：node scripts/run-tests.mjs finish-here
 *
 * 纪律⑭：接线类代码必须有接线契约 —— 断言调用点存在且顺序正确
 *（函数全对但没人调 = 死代码；顺序不对 = 守卫被架空）。
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { relative } from 'node:path'
import { getRepoScan } from '@shared/utils/repo-scan'

const SRC = fileURLToPath(new URL('../../..', import.meta.url)) // → app/src
const scan = getRepoScan(SRC)
const rel = (abs: string): string => relative(SRC, abs).split('\\').join('/')
const code = (abs: string): string => scan.stripped(abs)

/** store/tasks.ts（剥注释后的生产代码） */
const tasksCode = code(scan.all.find((a) => rel(a) === 'main/store/tasks.ts')!)
/** AskUserGate（渲染层自由文本路径） */
const gateCode = code(scan.all.find((a) => rel(a) === 'renderer/components/AskUserGate.tsx')!)
/** messages.ts 原文（四语言 suggest.finishHere.label 契约用） */
const messagesRaw = scan.raw(scan.all.find((a) => rel(a) === 'main/i18n/messages.ts')!)

const { resolveFinishHereAction } = await import('@shared/utils/finish-phrase')

test('TC-FH-001 resolveFinishHereAction 真值表（主进程拦截分支与谓词共用一份语义）', () => {
  assert.equal(resolveFinishHereAction('就此结束', 'running'), 'cancel')
  assert.equal(resolveFinishHereAction('就此结束', 'done'), 'ack-only')
  assert.equal(resolveFinishHereAction('继续任务', 'running'), null)
})

test('TC-FH-002 ★ 接线契约：拦截点在 transient cancel / pending 重置 / runTask 之前，且命中路径不重跑', () => {
  // 断言范围限定在 appendUserMessage 函数体内 —— 全文 indexOf 会撞上
  // createTask / reconcile 等处同形字符串（v0.41.0 实测教训）
  const fnStart = tasksCode.indexOf('export async function appendUserMessage')
  const fnEnd = tasksCode.indexOf('export async function deleteTask')
  assert.ok(fnStart > 0 && fnEnd > fnStart, 'appendUserMessage 函数体定位失败')
  const fn = tasksCode.slice(fnStart, fnEnd)
  // ① 拦截分支存在
  assert.match(fn, /const finishHere = resolveFinishHereAction\(text, task\.status\)/,
    'appendUserMessage 必须调用 resolveFinishHereAction（顺序链的唯一入口）')
  // ② 拦截点必须早于 transient cancel / pending 重置 / runTask ——
  //    用索引断言顺序（stripComments 后源码里的物理顺序即执行顺序）
  const idxIntercept = fn.indexOf('resolveFinishHereAction(text, task.status)')
  const idxTransient = fn.indexOf('cancelTask(taskId, { transient: true })')
  const idxPending = fn.indexOf("status: 'pending'")
  const idxRun = fn.indexOf('void runTask(taskId)')
  assert.ok(idxIntercept > 0, '拦截调用必须存在')
  assert.ok(idxTransient > idxIntercept, `拦截必须早于 transient cancel（${idxIntercept} < ${idxTransient}）`)
  assert.ok(idxPending > idxIntercept, '拦截必须早于 pending 重置')
  assert.ok(idxRun > idxIntercept, '拦截必须早于 runTask')
  // ③ 命中分支内不得出现 runTask / status:'pending'（两腿：命中即终局，不重排不重跑）
  const hitBranch = fn.slice(idxIntercept, idxTransient)
  assert.ok(hitBranch.includes("finishHere === 'cancel'"), '命中分支应包含 cancel 子分支')
  assert.ok(!hitBranch.includes('runTask'), '命中分支不得调用 runTask（终局指令不得发回模型）')
  assert.ok(!hitBranch.includes("status: 'pending'"), '命中分支不得把任务重置为 pending')
  // ④ 完整终局走非 transient cancelTask（与 D171 chip 的 onStop 同语义）
  assert.match(fn, /await cancelTask\(taskId\)/, '命中分支必须调完整 cancelTask（含 sealGraph/sealLedger）')
  assert.doesNotMatch(hitBranch, /transient: true/, '命中分支不得走 transient（transient 只清控制器、不落终态）')
  // ⑤ 回执必须发 turn_note（人话，纪律⑨）
  assert.match(fn, /type: 'turn_note'/, '拦截路径必须投递 turn_note 回执')
})

test('TC-FH-003 短语清单 ⊇ i18n suggest.finishHere.label 四 locale 值（改文案必须同步清单）', async () => {
  const labels = [...messagesRaw.matchAll(/'suggest\.finishHere\.label':\s*'([^']+)'/g)].map((m) => m[1]!)
  assert.equal(labels.length, 4, `messages.ts 应有且仅有 4 条 suggest.finishHere.label（实测 ${labels.length}）`)
  const { FINISH_HERE_PHRASES } = await import('@shared/utils/finish-phrase')
  for (const label of labels) {
    assert.ok(
      (FINISH_HERE_PHRASES as readonly string[]).includes(label),
      `i18n 标签「${label}」不在 FINISH_HERE_PHRASES 内 —— 改文案必须同步 shared/utils/finish-phrase.ts`,
    )
  }
})

test('TC-FH-004 渲染层接线：AskUserGate 自由文本命中终局短语走 onStop（与 chip 同通道）', () => {
  assert.match(gateCode, /import \{ isFinishHerePhrase \} from '@shared\/utils\/finish-phrase'/,
    'AskUserGate 必须导入共享谓词（不得复制第二份短语清单，纪律⑦）')
  // answer() 内命中 → clearAskUser + onStop，且不走 onAnswer
  const answerIdx = gateCode.indexOf('const answer = (text: string)')
  assert.ok(answerIdx > 0, 'answer() 必须存在')
  const answerBody = gateCode.slice(answerIdx, gateCode.indexOf('const handleShellKeyDown'))
  assert.match(answerBody, /isFinishHerePhrase\(trimmed\)/, 'answer() 必须做终局短语判定')
  const hit = answerBody.slice(answerBody.indexOf('isFinishHerePhrase(trimmed)'))
  // 命中分支（isFinishHerePhrase 为真）必须先于兜底 onAnswer 出现，
  // 且命中分支内部不得调用 onAnswer
  const hitBranch = hit.slice(0, hit.indexOf('}'))
  assert.ok(hitBranch.includes('onStop()'), '命中分支内应 onStop()')
  assert.ok(!hitBranch.includes('onAnswer(trimmed)'), '命中分支不得再走 onAnswer')
})

test('TC-FH-005 ack 路径不改任务状态；cancel 路径清 pendingAskUser 并广播', () => {
  const fnStart = tasksCode.indexOf('export async function appendUserMessage')
  const fnEnd = tasksCode.indexOf('export async function deleteTask')
  const fn = tasksCode.slice(fnStart, fnEnd)
  const idxAck = fn.indexOf("finishHere === 'cancel'")
  assert.ok(idxAck > 0)
  const block = fn.slice(idxAck, fn.indexOf('const { cancelTask } = await import'))
  assert.ok(block.includes('任务已结束，无需再次结束'), 'ack 文案应明确任务已结束')
  assert.ok(!block.includes('updateTask('), 'ack 路径不得改任务状态')
  const cancelBlock = fn.slice(idxAck, fn.indexOf('logger.info(\'System\', `finish-here phrase on terminal'))
  assert.match(cancelBlock, /pendingAskUser: undefined/, 'cancel 路径应清 pendingAskUser（D198 同族：不留无因由提问）')
  assert.match(cancelBlock, /broadcastTaskStatus\(finished\)/, 'cancel 路径应广播终态')
})

/* ============================================================
 * v0.41.0（D211 · 实机 UI 验收抓到）：迁移层逐字段重建 PlanItem 时漏掉
 * parentId —— 任务从盘上读一次，子任务层级被静默剥掉。契约：迁移必须
 * 保留层级字段（合法字符串透传，非法归 null）。
 * ============================================================ */
test('TC-FH-006 ★ D211 迁移层保留 parentId（重启后层级不得静默消失）', async () => {
  const migrateCode = code(scan.all.find((a) => rel(a) === 'main/store/tasks.migrate.ts')!)
  assert.match(
    migrateCode,
    /parentId: typeof obj\['parentId'\] === 'string'/,
    'normalizePlanItem 必须保留 parentId（否则读盘一次层级就消失，D211）',
  )
  // 真执行：走一次 normalizePlanItem 等价路径 —— 直接验证迁移模块导出的行为
  const now = Date.now()
  const rawTask = {
    id: 'T-TEST',
    workspaceId: 'default',
    title: 't',
    status: 'running',
    agentId: 'a',
    skillIds: [],
    mcpIds: [],
    modelId: 'm',
    input: { text: 'x' },
    config: {},
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    completedAt: null,
    parentTaskId: null,
    tags: [],
    planItems: [
      { id: 'p1', text: '父', status: 'done', createdAt: now, updatedAt: now },
      { id: 'p1a', text: '子', status: 'done', createdAt: now, updatedAt: now, parentId: 'p1' },
      { id: 'p1b', text: '坏', status: 'pending', createdAt: now, updatedAt: now, parentId: 42 },
    ],
  }
  const { migrateTasks } = await import('../tasks.migrate.js')
  const { tasks } = migrateTasks([rawTask])
  const items = tasks[0]?.planItems ?? []
  assert.equal(items[1]?.parentId, 'p1', '合法 parentId 必须保留（D211 核心）')
  assert.equal(items[2]?.parentId, null, '非法 parentId 归 null（顶级兜底）')
})
