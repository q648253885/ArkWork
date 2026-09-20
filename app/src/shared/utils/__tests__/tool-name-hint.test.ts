/* ============================================================
 * ArkWork — 未知工具名「你是不是想用 X」用例（v0.34.4 · TC-THINT-001..012）
 * 规格来源：docs/versions/v0.34.4/00-release-goal.md §3.6（D67）
 *
 * 立组原因（真机 t1 · T-20260919-6c3v48 · I25）：
 *   -> CALL todo-write {...}
 *      RESULT {"error":"Tool not found: todo-write"}
 *   而当时**真实注册**的工具就叫 `todo_update`。错误回执不含任何恢复信息，
 *   模型只能再猜一个名字 → 再失败（纪律⑩「错误回执不得指向已被拒绝的调用」同族）。
 *
 * 注意 `todo-write` 与 `todo_update` 的归一化编辑距离达 4，**纯 Levenshtein 会漏**
 * —— 因此本条按「词根」判近似（TC-THINT-005 专门钉住这个反例）。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs tool-name-hint
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { suggestToolNames, unknownToolError } from '../tool-name-hint.js'

/** 真实内置工具名的一个代表子集（取自 seed.ts 的 S-core.*） */
const AVAILABLE = [
  'file-reader',
  'file-writer',
  'file-editor',
  'glob-search',
  'grep-search',
  'web-search',
  'fetch-url',
  'shell',
  'browser',
  'todo_update',
  'task_complete',
  'ask_user',
  'submit_plan',
  'delegate-agent',
  'session-search',
]

test('TC-THINT-001 ★ [D67] 真机反例：todo-write → 必须给出 todo_update', () => {
  const got = suggestToolNames('todo-write', AVAILABLE)
  assert.ok(got.length > 0, '★ 必须给出候选（真机此处只回了一句 Tool not found）')
  assert.equal(got[0], 'todo_update', `★ 首选候选必须是真实工具名，实际 ${got[0]}`)
})

test('TC-THINT-002 写法差异归一：todo-update / todoUpdate / TODO_UPDATE 都指向 todo_update', () => {
  for (const req of ['todo-update', 'todoUpdate', 'TODO_UPDATE', 'todo update']) {
    assert.equal(
      suggestToolNames(req, AVAILABLE)[0],
      'todo_update',
      `${req} 应归一命中 todo_update`,
    )
  }
})

test('TC-THINT-003 完全同名（归一化后）→ 最高优先，分值为 0 档', () => {
  // 归一化后同名 → 必须排第一，且不受其它近似项干扰
  const got = suggestToolNames('file_reader', AVAILABLE)
  assert.equal(got[0], 'file-reader', 'file_reader 应命中 file-reader')
  const got2 = suggestToolNames('glob search', AVAILABLE)
  assert.equal(got2[0], 'glob-search')
})

test('TC-THINT-004 子串近似：search → 给出 search 族候选', () => {
  const got = suggestToolNames('search', AVAILABLE)
  assert.ok(got.length > 0, '应给出候选')
  for (const n of got) {
    assert.ok(n.includes('search'), `子串近似候选应含 search，实际 ${n}`)
  }
})

test('TC-THINT-005 ★ [D67] 词根判定优先于编辑距离（todo-* 与 todo_* 距离达 4 仍须命中）', () => {
  // 显式钉住：若改用纯 Levenshtein(≤2) 判定，本用例会失败。
  const got = suggestToolNames('todo-write', AVAILABLE)
  assert.ok(
    got.includes('todo_update'),
    '★ 首词根相同的必须入选 —— 编辑距离在这里是错的度量',
  )
})

test('TC-THINT-006 毫不相干的工具名 → 空数组（不得瞎猜）', () => {
  assert.deepEqual(suggestToolNames('zzzzzzzz', AVAILABLE), [])
  assert.deepEqual(suggestToolNames('', AVAILABLE), [])
  assert.deepEqual(suggestToolNames('todo-write', []), [], '无可用工具时不得编造')
})

test('TC-THINT-007 最多返回 max 个，且按相似度稳定排序（同分按名典序）', () => {
  const got = suggestToolNames('search', AVAILABLE, 2)
  assert.equal(got.length, 2, '应遵守 max')
  // 稳定性：同一输入两次调用结果完全一致
  assert.deepEqual(suggestToolNames('search', AVAILABLE, 2), got)
})

test('TC-THINT-008 unknownToolError：保留原始名 + 列出候选 + 明确要求别自造', () => {
  const msg = unknownToolError('todo-write', AVAILABLE)
  assert.match(msg, /Tool not found: todo-write/, '必须保留原始请求名（诊断需要）')
  assert.match(msg, /todo_update/, '必须给出候选名')
  assert.match(msg, /不要自造工具名|已注册/, '必须明确要求改用已注册工具名')
})

test('TC-THINT-009 unknownToolError：无候选时退化为旧的单句文案（不编造、不加噪）', () => {
  const msg = unknownToolError('zzzzzzzz', AVAILABLE)
  assert.equal(msg, 'Tool not found: zzzzzzzz', '无相似项时不得附会候选')
})

test('TC-THINT-010 大小写/横线下划线混写不误判：不同词根的不入选', () => {
  // browser 与 browserTabs 首词根相同（同一族）→ 入选；web-search 与 shell 不同族 → 不入选
  const got = suggestToolNames('browser', ['browser', 'shell', 'web-search'])
  assert.deepEqual(got, ['browser'], '只有同族才入选')
})

test('TC-THINT-011 中文/混合名不崩（不得抛错）', () => {
  assert.doesNotThrow(() => suggestToolNames('文档驱动开发', AVAILABLE))
  assert.doesNotThrow(() => unknownToolError('文档驱动开发', AVAILABLE))
})

test('TC-THINT-012 ★ 接线存在性：act.ts 必须用 unknownToolError（而非裸字符串）', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const src = readFileSync(
    fileURLToPath(new URL('../../../main/agent/engine/act.ts', import.meta.url)),
    'utf-8',
  )
  assert.match(
    src,
    /if \(!skill\) throw new Error\(unknownToolError\(/,
    '★ act.ts 的未知工具分支必须调用 unknownToolError —— 函数写了没人叫 = D38-a 重演',
  )
  assert.doesNotMatch(
    src,
    /throw new Error\(`Tool not found: \$\{action\.tool\}`\)/,
    '★ 旧的无恢复信息写法必须已被替换',
  )
})
