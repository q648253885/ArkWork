/* ============================================================
 * v0.31.0 C2 — LLM 任务标题生成 测试
 *
 * 覆盖：
 *   1. cleanTitle / isPlaceholderTitleIn 纯函数行为（直连导入，零依赖模块）
 *   2. task-title.ts 编排层：titleSource 跳过条件、写回前重读竞态保护、
 *      titleSource:'llm' 写回 + broadcast、失败静默
 *   3. runner.ts 挂点：broadcastTaskStatus 之后 fire-and-forget
 *   4. store/tasks.ts：CreateTaskInput.titleSource 透传 + appendUserMessage 空壳回填
 *   5. 各创建点锁定：automations 'user' / delegate 'llm' / renderer renameTask 'user'
 *   6. renderer 机械改名直连（不带 titleSource，不锁死 LLM 升级）
 *
 * 运行（cwd=app）：
 *   npx tsx --test src/main/agent/__tests__/task-title.test.ts
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { cleanTitle, isPlaceholderTitleIn, TITLE_MAX_CHARS } from '../task-title-clean.js'

const src = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf-8')

/* ---------- 1. cleanTitle 纯函数行为 ---------- */

test('cleanTitle: 去句末标点与空白', () => {
  assert.equal(cleanTitle('帮我写一个爬虫脚本。'), '帮我写一个爬虫脚本')
  assert.equal(cleanTitle('  整理会议纪要！ '), '整理会议纪要')
  assert.equal(cleanTitle('生成周报?'), '生成周报')
})

test('cleanTitle: 剥一层引号包裹', () => {
  assert.equal(cleanTitle('「数据分析报告」'), '数据分析报告')
  assert.equal(cleanTitle('"Bug 修复"'), 'Bug 修复')
  assert.equal(cleanTitle('『待办清单』'), '待办清单')
})

test('cleanTitle: 去「任务：」类前缀（可多层）', () => {
  assert.equal(cleanTitle('任务：整理周报'), '整理周报')
  assert.equal(cleanTitle('Title: Fix login bug'), 'Fix login bug')
  assert.equal(cleanTitle('任务：标题：嵌套前缀'), '嵌套前缀')
})

test('cleanTitle: 取首个非空行（模型多行输出时只留标题行）', () => {
  assert.equal(cleanTitle('\n\n  代码重构  \n这是解释文本，不应出现'), '代码重构')
})

test('cleanTitle: 压缩内部连续空白 + 限长 16 码点（不截破代理对）', () => {
  assert.equal(cleanTitle('a    b\t\tc'), 'a b c')
  const long = '一二三四五六七八九十甲乙丙丁戊己庚辛'
  assert.equal(cleanTitle(long), long.slice(0, 16))
  assert.equal(cleanTitle(long).length, 16)
  // emoji 按码点截断，不产生残缺代理对
  const emojiTitle = cleanTitle('🚀'.repeat(20))
  assert.equal([...emojiTitle].length, TITLE_MAX_CHARS)
  assert.equal(emojiTitle, '🚀'.repeat(TITLE_MAX_CHARS))
})

test('cleanTitle: 空输入返回空串（调用方放弃本次结果）', () => {
  assert.equal(cleanTitle(''), '')
  assert.equal(cleanTitle('   \n  '), '')
  assert.equal(cleanTitle('「「」」') /* 剥完为空 */, '「」')
})

/* ---------- 2. isPlaceholderTitleIn 纯函数行为 ---------- */

test('isPlaceholderTitleIn: 空串与四语言占位（含数字后缀）', () => {
  const bases = ['未命名任务', 'Untitled task', '無題タスク', '제목 없는 작업']
  assert.equal(isPlaceholderTitleIn('', bases), true)
  assert.equal(isPlaceholderTitleIn('  ', bases), true)
  assert.equal(isPlaceholderTitleIn('未命名任务', bases), true)
  assert.equal(isPlaceholderTitleIn('未命名任务 3', bases), true)
  assert.equal(isPlaceholderTitleIn('Untitled task', bases), true)
  assert.equal(isPlaceholderTitleIn('Untitled task 12', bases), true)
  assert.equal(isPlaceholderTitleIn('無題タスク 2', bases), true)
  assert.equal(isPlaceholderTitleIn('제목 없는 작업 5', bases), true)
})

test('isPlaceholderTitleIn: 非占位标题返回 false', () => {
  const bases = ['未命名任务', 'Untitled task']
  assert.equal(isPlaceholderTitleIn('写爬虫', bases), false)
  assert.equal(isPlaceholderTitleIn('未命名任务备忘录', bases), false) // 前缀但非整词+后缀
  assert.equal(isPlaceholderTitleIn('Untitled taskbook', bases), false)
})

/* ---------- 3. task-title.ts 编排层契约 ---------- */

const titleSrc = src('../task-title.ts')

test('task-title: 跳过条件 —— titleSource 已置位或素材为空', () => {
  assert.match(titleSrc, /if\s*\(task\.titleSource\)\s*return/)
  assert.match(titleSrc, /const material = \(task\.input\?\.text \?\? ''\)\.trim\(\)/)
  assert.match(titleSrc, /if\s*\(!material\)\s*return/)
})

test('task-title: 占位基准来自四语言 MESSAGES 遍历（不硬编码文字）', () => {
  assert.match(titleSrc, /Object\.values\(MESSAGES\)/)
  assert.match(titleSrc, /\['tasks\.untitled'\]/)
})

test('task-title: 超时保护 —— AbortController + setTimeout + finally 清理', () => {
  assert.match(titleSrc, /setTimeout\(\(\)\s*=>\s*controller\.abort\(\),\s*TITLE_TIMEOUT_MS\)/)
  assert.match(titleSrc, /finally\s*\{[\s\S]*?clearTimeout\(timer\)/)
})

test('task-title: 竞态保护 —— 写回前重读任务，titleSource 已置位则放弃', () => {
  const completeIdx = titleSrc.indexOf('adapter.complete')
  const latestIdx = titleSrc.indexOf('const latest = await getTask(taskId)')
  assert.ok(completeIdx > 0, '应存在 adapter.complete 调用')
  assert.ok(latestIdx > completeIdx, '重读必须在 LLM 往返之后')
  assert.match(titleSrc, /if\s*\(!latest\s*\|\|\s*latest\.titleSource\)\s*return/)
  assert.match(titleSrc, /updateTask\(taskId,\s*\{\s*title,\s*titleSource:\s*'llm'\s*\}\)/)
  assert.match(titleSrc, /broadcastTaskStatus\(updated\)/)
})

test('task-title: 全程 try/catch 静默（失败不抛出，保留机械标题兜底）', () => {
  assert.match(titleSrc, /\}\s*catch\s*\(err\)\s*\{[\s\S]*?logger\.debug/)
})

/* ---------- 4. runner.ts 挂点契约 ---------- */

const runnerSrc = src('../runner.ts')

test('runner: maybeGenerateTaskTitle 挂点在 broadcastTaskStatus 之后、runReActLoop 之前', () => {
  assert.match(runnerSrc, /import\s+\{\s*maybeGenerateTaskTitle\s+\}\s+from\s+'\.\/task-title\.js'/)
  const broadcastIdx = runnerSrc.indexOf('broadcastTaskStatus(updated)')
  const titleIdx = runnerSrc.indexOf('void maybeGenerateTaskTitle(taskId)')
  const loopIdx = runnerSrc.indexOf('void runReActLoop(')
  assert.ok(broadcastIdx > 0, '应存在 running 广播')
  assert.ok(titleIdx > broadcastIdx, '标题生成必须挂在广播之后')
  assert.ok(loopIdx > titleIdx, '标题生成必须在 ReAct 循环启动之前')
})

/* ---------- 5. store/tasks.ts 契约 ---------- */

const tasksStoreSrc = src('../../store/tasks.ts')

test('store/tasks: CreateTaskInput.titleSource 透传落库', () => {
  assert.match(tasksStoreSrc, /titleSource\?:\s*'user'\s*\|\s*'llm'/)
  assert.match(tasksStoreSrc, /titleSource:\s*input\.titleSource/)
})

test('store/tasks: appendUserMessage 空壳任务回填 input.text（仅当原 text 为空）', () => {
  assert.match(
    tasksStoreSrc,
    /task\.input\.text\.trim\(\)\s*===\s*''[\s\S]*?\{\s*input:\s*\{\s*\.\.\.task\.input,\s*text\s*\}\s*\}/,
  )
})

/* ---------- 6. 各创建点锁定契约 ---------- */

test('automations: 创建任务置 titleSource=user（用户配置名，锁定）', () => {
  const s = src('../../store/automations.ts')
  assert.match(s, /title:\s*automation\.name[\s\S]*?titleSource:\s*'user'/)
})

test('delegate: 子任务置 titleSource=llm（标题已是模型产物，不再重生成）', () => {
  const s = src('../skills/delegate.ts')
  assert.match(s, /titleSource:\s*'llm'/)
})

test('shared/types: Task 与 IPC 契约包含 titleSource 字段', () => {
  assert.match(src('../../../shared/types/task.ts'), /titleSource\?:\s*'user'\s*\|\s*'llm'/)
  const ipc = src('../../../shared/types/ipc.ts')
  assert.match(ipc, /titleSource\?:\s*'user'\s*\|\s*'llm'/)
})

/* ---------- 7. renderer tasksSlice 契约 ---------- */

const sliceSrc = src('../../../renderer/store/slices/tasksSlice.ts')

test('renderer: renameTask 置 titleSource=user（手动改名锁定）', () => {
  assert.match(sliceSrc, /ark\.task\.update\(\{\s*id,\s*title,\s*titleSource:\s*'user'\s*\}\)/)
})

test('renderer: 续聊机械改名直连 update 不带 titleSource（即时反馈但不锁死 LLM 升级）', () => {
  // 提取 appendMessage 到 refreshTasks 之间的机械改名段，断言：
  //  ① 直连 ark.task.update（不走 renameTask）
  //  ② 段内不出现 titleSource（不锁定）
  const start = sliceSrc.indexOf('ark.task.appendMessage(taskId, text)')
  const end = sliceSrc.indexOf('await get().refreshTasks()', start)
  assert.ok(start > 0 && end > start, '机械改名段应位于 appendMessage 与 refreshTasks 之间')
  const block = sliceSrc.slice(start, end)
  assert.match(block, /ark\.task\.update\(\{\s*id:\s*taskId,\s*title:\s*simplified\s*\}\)/)
  // 只查代码不查注释（本块注释本身含 "titleSource" 字样）
  assert.ok(!/titleSource\s*:/.test(block), '机械改名不得写入 titleSource（保留 LLM 升级通道）')
  // 占位判定覆盖当前语言 + 中文遗留正则
  assert.match(block, /i18n\.t\('tasks\.untitled'\)/)
  assert.match(block, /未命名任务/)
})
