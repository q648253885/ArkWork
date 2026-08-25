/* ============================================================
 * v0.18.0 端到端行为断言 —— 任务清单推进修复 + 写文件工具摘要修复
 *
 * 不 mock LLM，纯源码契约断言：
 *  1. isProductiveTool 白名单不含 file-writer/file-editor/shell（避免清单抢跑）
 *  2. isProductiveTool 白名单仍含 task_complete/spec/plan/bugfix（引擎该推进的工具）
 *  3. buildObservationSummary 对 file-writer/file-editor 只回传路径+字节数/行数/替换数，
 *     不包含文件内容
 *  4. shell 摘要对 command 做了 120 字符截断（防 heredoc 全文泄露）
 *  5. TodoPanel：清单文本换行显示（不硬截断）、按钮汇聚为单一 ⋯ 菜单（按需展示）
 *  6. TodoPanel：展开详情只显示产物 resultSummary，不显示工具名/状态/耗时/异常
 *  7. ThoughtStream：ToolCard 结果默认折叠（resultOpen 初始 false）
 *  8. ThoughtStream：content/oldStr/newStr 等内容类参数按 60 字符摘要显示
 *  9. constants：TOOL_DISPLAY 已补 file-writer/file-editor/glob-search/grep-search
 * 10. seed：内置提示词明确写「阶段内工具不会自动推进」
 * 11. ThoughtStream：内部机制/门禁拦截（softFail）用中性「guarded」样式，不红色报错
 * 12. engine：ask_user 校验放宽（仅校验 question，suggestions 不足注入兜底）
 * 13. engine：计划生成首项标 running；任务失败时 markRunningPlanItemFailed 标 failed
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
// v0.27.0 R2：engine.ts 已拆分为 engine/ 目录，源码契约改为拼接全部模块后断言
const ENGINE_DIR = fileURLToPath(new URL('./engine/', root))
const engineSrc = readdirSync(ENGINE_DIR)
  .filter((f) => f.endsWith('.ts'))
  .sort()
  .map((f) => readFileSync(ENGINE_DIR + f, 'utf-8'))
  .join('\n')
const seedSrc = readFileSync(fileURLToPath(new URL('../store/seed.ts', root)), 'utf-8')
const rendererTodoPanelSrc = readFileSync(
  fileURLToPath(new URL('../../renderer/components/dock/TodoPanel.tsx', root)),
  'utf-8',
)
const rendererThoughtStreamSrc = readFileSync(
  fileURLToPath(new URL('../../renderer/components/ThoughtStream.tsx', root)),
  'utf-8',
)
const rendererConstantsSrc = readFileSync(
  fileURLToPath(new URL('../../renderer/constants.ts', root)),
  'utf-8',
)

/* ---------- 1-2. isProductiveTool 行为契约 ---------- */

function extractProductiveSet(): string[] {
  // 提取 PRODUCTIVE 数组字面量
  const m = engineSrc.match(/PRODUCTIVE\s*=\s*new Set\(\[([\s\S]*?)\]\)/)
  assert.ok(m, '应能提取 isProductiveTool 内的 PRODUCTIVE 集合')
  const body = m![1]!
  // 提取所有 'xxx' 字面量
  const items: string[] = []
  const re = /'([^']+)'/g
  let mm: RegExpExecArray | null
  while ((mm = re.exec(body)) !== null) items.push(mm[1]!)
  return items
}

test('v0.18.x fix: 阶段内写操作（file-writer/file-editor）不再自动推进清单', () => {
  const items = extractProductiveSet()
  assert.ok(
    !items.includes('file-writer'),
    `file-writer 不应在 isProductiveTool 白名单中（避免清单抢跑），当前集合：${items.join(',')}`,
  )
  assert.ok(
    !items.includes('file-editor'),
    `file-editor 不应在 isProductiveTool 白名单中（避免清单抢跑），当前集合：${items.join(',')}`,
  )
})

test('v0.18.x fix: shell 不再自动推进清单（多次命令属于同一阶段内）', () => {
  const items = extractProductiveSet()
  assert.ok(
    !items.includes('shell'),
    `shell 不应在 isProductiveTool 白名单中，当前集合：${items.join(',')}`,
  )
})

test('v0.18.x: 引擎仍自动推进的"产成性"工具保留', () => {
  const items = extractProductiveSet()
  for (const keep of ['task_complete', 'spec', 'plan', 'bugfix', 'react-core-skills']) {
    assert.ok(items.includes(keep), `${keep} 应保留在白名单中`)
  }
  // todo_update 走显式拦截路径，也应保留
  assert.ok(items.includes('todo-update') || items.includes('todo_update'),
    'todo-update 应保留（LLM 显式推进入口）')
})

/* ---------- 3-4. file-writer/file-editor/shell 摘要契约 ---------- */

/**
 * 提取 buildObservationSummary 内 `if (tool === 'xxx')` 起到下一个 `if (tool ===` 前的代码块。
 * 用「下一个 if 分支」做边界，避免模板字符串里 `${}` 的花括号干扰。
 */
function extractBranchBody(name: string): string {
  const startRe = new RegExp(`if\\s*\\(\\s*tool\\s*===\\s*['"]${name}['"]\\s*\\)\\s*\\{`)
  const m = engineSrc.match(startRe)
  if (!m || m.index === undefined) return ''
  const start = m.index + m[0].length
  // 找下一个 if (tool === ...) 或函数结束
  const nextRe = /\n\s*if\s*\(\s*tool\s*===|\n\}\s*\n*\}/g
  let end = engineSrc.length
  let mm: RegExpExecArray | null
  while ((mm = nextRe.exec(engineSrc)) !== null) {
    if (mm.index > start) {
      end = mm.index
      break
    }
  }
  return engineSrc.slice(start, end)
}

test('v0.18.x fix: file-writer 摘要只含路径+字节数+行数+新建/覆盖标记', () => {
  const body = extractBranchBody('file-writer')
  assert.ok(body.length > 0, '应存在 file-writer 摘要分支')
  // 必须使用 r.path
  assert.match(body, /r\.path/, '应使用 r.path')
  assert.match(body, /r\.bytes/, '应包含字节数')
  assert.match(body, /r\.lines/, '应包含行数')
  assert.match(body, /r\.created/, '应区分新建/覆盖')
  // 不应回写文件内容
  assert.doesNotMatch(body, /r\.content/, 'file-writer 摘要不应回写文件内容')
  assert.doesNotMatch(body, /r\.text/, 'file-writer 摘要不应回写文件内容')
})

test('v0.18.x fix: file-editor 摘要只含路径+替换数', () => {
  const body = extractBranchBody('file-editor')
  assert.ok(body.length > 0, '应存在 file-editor 摘要分支')
  assert.match(body, /r\.path/, '应使用 r.path')
  assert.match(body, /r\.replacements/, '应包含替换数')
  assert.doesNotMatch(body, /r\.newStr/, 'file-editor 摘要不应回写 newStr')
  assert.doesNotMatch(body, /r\.oldStr/, 'file-editor 摘要不应回写 oldStr')
})

test('v0.18.x fix: shell 摘要对 command 做 120 字符截断', () => {
  const body = extractBranchBody('shell')
  assert.ok(body.length > 0, '应存在 shell 摘要分支')
  assert.match(body, /safeSlice\([^,]+,\s*120\s*\)/, 'command 应做 120 字符截断')
  // 仍保留 stdout/stderr 截断
  assert.match(body, /safeSlice\([^,]+,\s*800\s*\)/, 'stdout 应做 800 字符截断')
})

/* ---------- 5-6. TodoPanel UI 契约 ---------- */

test('v0.18.x fix: TodoPanel 文本换行显示，不硬截断', () => {
  // 不应再定义 ITEM_TEXT_MAX / truncateItem（硬截断会让内容显示不全）
  assert.doesNotMatch(rendererTodoPanelSrc, /ITEM_TEXT_MAX/, '不应再硬编码 42 字符截断上限')
  assert.doesNotMatch(rendererTodoPanelSrc, /function truncateItem/, '不应再保留 truncateItem 硬截断函数')
  // 文本应换行显示 + title 悬浮完整文案
  assert.match(rendererTodoPanelSrc, /break-words/, '清单项文本应允许换行（break-words）')
  assert.match(rendererTodoPanelSrc, /title=\{item\}/, '整行应悬浮显示完整文本')
})

test('v0.18.x fix: TodoPanel 展开详情只显示产物，不显示工具名/状态/耗时/异常', () => {
  // 展开详情应只渲染 resultSummary（产物），不渲染工具名/状态/耗时/异常
  assert.match(rendererTodoPanelSrc, /step\.resultSummary/, '应展示 resultSummary（产物）')
  assert.doesNotMatch(rendererTodoPanelSrc, /step\.toolName/, '不应再展示工具名')
  assert.doesNotMatch(rendererTodoPanelSrc, /step\.durationMs/, '不应再展示耗时')
  assert.doesNotMatch(rendererTodoPanelSrc, /step\.errorMessage/, '不应再展示异常信息')
  assert.match(rendererTodoPanelSrc, /dock\.todo\.no_artifact/, '空态文案应使用 i18n key dock.todo.no_artifact（「暂无产物记录」）')
})

test('v0.18.x fix: TodoPanel 按钮汇聚为 ⋯ 菜单，按状态显示', () => {
  assert.match(rendererTodoPanelSrc, /menuOpenId/, '应使用 menuOpenId state 控制菜单展开')
  assert.match(rendererTodoPanelSrc, /hasActions\s*=\s*canMarkDone\s*\|\|\s*canRetry\s*\|\|\s*canCancel\s*\|\|\s*canLocate/, '应计算 hasActions')
  // 菜单项文案（i18n key，zh 语义：标记为已完成/重试该项/取消该项/定位到执行步骤）
  assert.match(rendererTodoPanelSrc, /dock\.todo\.mark_done/, '菜单应含「标记为已完成」key')
  assert.match(rendererTodoPanelSrc, /dock\.todo\.retry/, '菜单应含「重试该项」key')
  assert.match(rendererTodoPanelSrc, /dock\.todo\.cancel/, '菜单应含「取消该项」key')
  assert.match(rendererTodoPanelSrc, /dock\.todo\.locate_step/, '菜单应含「定位到执行步骤」key')
})

test('v0.18.x: TodoPanel 行内按钮按状态显示（不可用的不渲染）', () => {
  // 四个布尔判断都存在
  for (const k of ['canMarkDone', 'canRetry', 'canCancel', 'canLocate']) {
    assert.ok(rendererTodoPanelSrc.includes(k), `TodoPanel 应计算 ${k}`)
  }
  // canRetry 只在 failed 状态可用
  assert.match(rendererTodoPanelSrc, /canRetry\s*=\s*st\s*===\s*['"]failed['"]/, 'canRetry 仅在 failed 状态可用')
})

/* ---------- 7-8. ThoughtStream ToolCard 契约 ---------- */

test('v0.18.x fix: ToolCard 结果默认折叠', () => {
  assert.match(rendererThoughtStreamSrc, /useState\(false\)/, 'resultOpen 默认应为 false')
  // resultOpen 应被命名为 resultOpen
  assert.match(rendererThoughtStreamSrc, /resultOpen/, '应存在 resultOpen state')
})

test('v0.18.x fix: 内容类参数（content/oldStr/newStr）按 60 字符摘要显示', () => {
  assert.match(rendererThoughtStreamSrc, /CONTENT_ARG_KEYS/, '应定义 CONTENT_ARG_KEYS')
  assert.match(rendererThoughtStreamSrc, /['"]content['"]/, 'CONTENT_ARG_KEYS 应含 content')
  assert.match(rendererThoughtStreamSrc, /oldStr/, 'CONTENT_ARG_KEYS 应含 oldStr')
  assert.match(rendererThoughtStreamSrc, /newStr/, 'CONTENT_ARG_KEYS 应含 newStr')
  assert.match(rendererThoughtStreamSrc, /truncate\([^,]+,\s*60\s*\)/, '内容参数应截断到 60 字符')
  // 标注总字符数
  assert.match(rendererThoughtStreamSrc, /字符/, '摘要应标注总字符数')
})

/* ---------- 9. constants TOOL_DISPLAY 补全 ---------- */

test('v0.18.x: TOOL_DISPLAY 已补 file-writer/file-editor/glob-search/grep-search', () => {
  for (const k of ['file-writer', 'file-editor', 'glob-search', 'grep-search']) {
    assert.ok(rendererConstantsSrc.includes(k), `TOOL_DISPLAY 应含 ${k}`)
  }
})

/* ---------- 10. seed.ts 提示词契约 ---------- */

test('v0.18.x: seed.ts 提示词明确「阶段内工具不会自动推进」', () => {
  assert.match(
    seedSrc,
    /阶段内工具[^。\n]*不会自动推进|阶段内工具[\s\S]{0,30}不会自动推进|不会[\s\S]{0,10}自动推进/,
    '应说明阶段内工具不会自动推进清单',
  )
  // 同时保留显式推进入口
  assert.match(seedSrc, /todo-update/, '应保留 todo-update 显式推进入口')
})

/* ---------- 11. ThoughtStream 软失败（内部机制/门禁拦截）中性显示契约 ---------- */

test('v0.18.x fix: 内部机制/门禁拦截（softFail）用中性 guarded 样式，不红色报错', () => {
  // 任务级失败判断应排除 softFail 步骤
  assert.match(
    rendererThoughtStreamSrc,
    /status\s*===\s*['"]failed['"]\s*&&\s*!s\.softFail/,
    '任务级 failed 判断应排除 softFail 步骤',
  )
  // 软失败步骤走 guarded 状态（v0.19.x 淡橙色警告，区别于红色真实报错）
  assert.match(rendererThoughtStreamSrc, /isSoftFail/, '应计算 isSoftFail 标记')
  assert.match(rendererThoughtStreamSrc, /['"]guarded['"]/, '软失败应映射到 guarded 状态')
  // 软失败图标显示橙色点而非红色 ✕
  assert.match(rendererThoughtStreamSrc, /bg-warning/, '软失败应使用橙色状态点')
  assert.match(rendererThoughtStreamSrc, /keyPrefix:\s*'thought'/, 'ThoughtStream 应使用 thought keyPrefix')
  assert.match(rendererThoughtStreamSrc, /t\('guardedTitle'\)/, '软失败图标应有拦截说明 title（thought.guardedTitle，zh 语义「Agent 拦截（门禁/预算，非错误）」）')
  // 软失败 errorMessage 用 text-warning 而非 text-danger
  assert.match(rendererThoughtStreamSrc, /text-warning\s+whitespace-pre-wrap/, '软失败异常信息应橙色警告显示')
})

/* ---------- 12. engine ask_user 校验放宽契约 ---------- */

test('v0.18.x + v0.25.2: ask_user 校验 question 非空，缺失注入兜底，suggestions 不足注入兜底', () => {
  // 校验只依赖 question 是否存在/非空，缺失时注入兜底问题而非拒绝（v0.25.2）
  assert.match(engineSrc, /hasQuestion\s*=\s*typeof\s+rawQuestion\s*===\s*['"]string['"]/, '应判定 question 是否为有效字符串')
  assert.match(
    engineSrc,
    /hasQuestion\s*=\s*typeof\s+rawQuestion\s*===\s*['"]string['"]\s*&&\s*rawQuestion\.trim\(\)\.length\s*>\s*0/,
    'hasQuestion 应只判定 question 缺失/空字符串',
  )
  assert.doesNotMatch(
    engineSrc,
    /hasQuestion[\s\S]{0,300}suggestions\s*<\s*2/,
    '不应再因 suggestions 不足而拒绝',
  )
  // 缺问题 → 注入兜底问题（v0.25.2）
  assert.match(engineSrc, /buildFallbackAskUserQuestion/, '缺 question 时应走兜底问题')
  // suggestions 不足时注入兜底选项
  assert.match(engineSrc, /finalSuggestions/, '应计算 finalSuggestions')
  assert.match(engineSrc, /label:\s*tFor\(locale,\s*['"]suggest\.continue\.label['"]\)/, '兜底应含「继续」选项（v0.29.0 F6：suggest.continue.label）')
  assert.match(engineSrc, /label:\s*tFor\(locale,\s*['"]suggest\.pause\.label['"]\)/, '兜底应含「暂停」选项（v0.29.0 F6：suggest.pause.label）')
})

/* ---------- 13. engine 清单首项 running + 任务失败标 failed 契约 ---------- */

test('v0.18.x fix: 计划生成时首项标 running，清单初始即有反应', () => {
  assert.match(
    engineSrc,
    /status:\s*i\s*===\s*0\s*\?\s*['"]running['"]\s*as const\s*:\s*['"]pending['"]\s*as const/,
    '计划首项应标 running，其余 pending',
  )
})

test('v0.18.x fix: 任务失败时 markRunningPlanItemFailed 把 running 项标 failed', () => {
  assert.match(engineSrc, /function markRunningPlanItemFailed/, '应存在 markRunningPlanItemFailed 函数')
  assert.match(
    engineSrc,
    /findIndex\(\(p\)\s*=>\s*p\.status\s*===\s*['"]running['"]\)/,
    '应优先查找 running 项',
  )
  assert.match(engineSrc, /target\.status\s*=\s*['"]failed['"]/, '目标项应标 failed')
  assert.match(engineSrc, /source:\s*['"]engine-fail['"]/, '失败来源应为 engine-fail')
  // 失败路径接入该函数（v0.23.2：max-iterations 改为优雅暂停不再标 failed，
  // 真实失败路径剩 catch task_failed 与上下文溢出 fast-fail 等 ≥2 处）
  const callCount = (engineSrc.match(/await\s+markRunningPlanItemFailed\(task\)/g) ?? []).length
  assert.ok(callCount >= 2, `markRunningPlanItemFailed 应至少在 2 个失败路径接入，当前 ${callCount} 处`)
})
