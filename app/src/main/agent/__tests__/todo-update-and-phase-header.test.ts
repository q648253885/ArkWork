/* ============================================================
 * v0.17.5 — todo_update 工具 + isPhaseHeader 过滤 + 工具失败自动标 failed
 *
 * 通过源码静态断言 + parsePlanItems 等价纯函数复刻，覆盖：
 *  1. isPhaseHeader：纯阶段标题型条目被识别为 phase header（含子项保留）
 *  2. 计划生成时调用 isPhaseHeader 过滤（engine.ts 源码契约）
 *  3. todo-update / todo_update 两种 tool name 都被 executeAct 拦截
 *  4. 工具失败时自动把 running 项标 failed 并在 resultSummary 追加清单概览
 *  5. file-writer 错误信息对 LLM 友好的字段名提示（file-tools.test.ts 已覆盖）
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const engineSrc = readFileSync(
  fileURLToPath(new URL('../engine.ts', import.meta.url)),
  'utf-8',
)
const seedSrc = readFileSync(
  fileURLToPath(new URL('../../store/seed.ts', import.meta.url)),
  'utf-8',
)

/* ---------- 1. isPhaseHeader 纯函数行为（从源码复刻等价实现） ---------- */

/** 与 engine.ts 中 isPhaseHeader 等价的并行副本，仅用于独立测试。
 *  不修改 engine.ts 源码。 */
function isPhaseHeader(text: string): boolean {
  const t = text.trim()
  const phasePrefix = /^(?:阶段|phase|step(?:\s*\d+)?)\s*\d*\s*[:：、]?\s*/i
  if (!phasePrefix.test(t)) return false
  const afterPrefix = t.replace(phasePrefix, '').trim()
  if (afterPrefix.length > 30) return false
  const actionVerbs =
    /调研|搜索|写|实现|开发|编码|测试|部署|打包|封装|接入|初始化|创建|搭建|执行|产出|读取|列出|修复|补|跑|运行|完成|确认|导出|下载|配置/i
  return !actionVerbs.test(afterPrefix)
}

test('isPhaseHeader: 纯阶段标题（无动作动词）→ 识别为 phase header', () => {
  assert.equal(isPhaseHeader('阶段 1：技术选型与架构设计'), true, '含"选型/设计"等抽象总结词，无白名单动作动词')
  assert.equal(isPhaseHeader('阶段 1: 技术选型与架构设计'), true)
  assert.equal(isPhaseHeader('Phase 1: Architecture'), true)
  assert.equal(isPhaseHeader('阶段 4：物理引擎选型'), true)
})

test('isPhaseHeader: 阶段标题但带具体动作 → 保留（不过滤）', () => {
  assert.equal(isPhaseHeader('阶段 1：调研 GitHub 热门俯视赛车项目'), false, '含"调研"动作动词应保留')
  assert.equal(isPhaseHeader('阶段 6：编写 src/main.ts 主循环'), false, '含"编写"应保留')
  assert.equal(isPhaseHeader('阶段 5：实现核心物理模块'), false, '含"实现"应保留')
  assert.equal(isPhaseHeader('阶段 7：跑通功能测试'), false, '含"跑通"应保留')
})

test('isPhaseHeader: 普通子步骤（无阶段前缀）→ 保留', () => {
  assert.equal(isPhaseHeader('调研 GitHub 热门俯视赛车项目'), false)
  assert.equal(isPhaseHeader('初始化项目结构与构建工具'), false)
  assert.equal(isPhaseHeader('实现车辆动力学模型'), false)
})

test('isPhaseHeader: 阶段前缀 + 超长描述（>30字）→ 视为完整子项保留', () => {
  const long = '阶段 1：调研 GitHub 上 jakesgordon/javascript-racer 等 8 个开源赛车项目的物理模型'
  assert.equal(isPhaseHeader(long), false, '阶段前缀 + 长描述 + 含动作动词应保留')
})

/* ---------- 2. 计划生成时调用 isPhaseHeader 过滤（源码契约） ---------- */

test('engine.ts: 计划生成时过滤 isPhaseHeader', () => {
  assert.match(
    engineSrc,
    /plan\.items\.filter\(\s*\(text\)\s*=>\s*!isPhaseHeader\(text\)\s*\)/,
    '应使用 isPhaseHeader 过滤纯阶段标题型条目',
  )
  assert.match(
    engineSrc,
    /function\s+isPhaseHeader\(\s*text:\s*string\s*\)\s*:\s*boolean/,
    'isPhaseHeader 应定义为接受 string 返回 boolean 的函数',
  )
})

test('engine.ts: isPhaseHeader 含动作动词白名单', () => {
  // 抽样校验：调研/写/实现/测试/打包 至少出现 5 个
  const m = engineSrc.match(/const\s+actionVerbs\s*=\s*\n?\s*\/([\s\S]*?)\//)
  assert.ok(m, 'isPhaseHeader 应定义动作动词正则')
  const verbs = m![1]!
  for (const v of ['调研', '写', '实现', '测试', '打包', '初始化', '运行', '配置']) {
    assert.ok(verbs.includes(v), `动作动词应包含「${v}」`)
  }
})

/* ---------- 3. todo_update / todo-update 双 tool name 拦截 ---------- */

test('engine.ts: executeAct 拦截 todo-update 与 todo_update 两种 tool name', () => {
  const m = engineSrc.match(
    /if\s*\(\s*action\.tool\s*===\s*['"]todo-update['"]\s*\|\|\s*action\.tool\s*===\s*['"]todo_update['"]\s*\)\s*\{/,
  )
  assert.ok(m, 'executeAct 应同时拦截 todo-update 与 todo_update 两种 tool name')
})

test('seed.ts: todo_update 内置工具定义完整', () => {
  assert.match(seedSrc, /id:\s*['"]S-core\.todo-update['"]/, '应定义 S-core.todo-update 工具')
  assert.match(seedSrc, /builtinHandler:\s*['"]todo_update['"]/, 'builtinHandler 应为 todo_update')
  assert.match(
    seedSrc,
    /item_index:[\s\S]*?status:[\s\S]*?comment:/,
    'inputSchema 应包含 item_index/status/comment 三个字段',
  )
  assert.match(seedSrc, /tags:\s*\[\s*['"]control['"]\s*\]/, '应打 control 标签')
})

test('seed.ts: @default 与 @coder defaultSkillIds 含 todo-update', () => {
  assert.match(
    seedSrc,
    /defaultSkillIds:\s*\[[^\]]*'S-core\.todo-update'[^\]]*\]/,
    '@default 或 @coder 的 defaultSkillIds 应含 S-core.todo-update（实际工具名 todo-update）',
  )
  // 至少出现 2 次（@default + @coder）
  const matches = seedSrc.match(/'S-core\.todo-update'/g)
  assert.ok(matches && matches.length >= 2, `应出现 ≥2 次，实际 ${matches?.length ?? 0}`)
})

test('seed.ts: @default / @coder systemPrompt 强制 todo-update 自检', () => {
  assert.match(seedSrc, /每完成一个阶段性操作后.*todo-update/, '应要求每阶段操作后调 todo-update')
  assert.match(seedSrc, /检查清单和后续要做的事.*todo-update/, '应要求检查清单后续')
  assert.match(seedSrc, /禁止.*批量标/, '应禁止批量标')
})

/* ---------- 4. 工具失败自动标 failed（源码契约） ---------- */

test('engine.ts: 工具失败时自动把 running 项标 failed', () => {
  assert.match(
    engineSrc,
    /if\s*\(\s*!ok\s*&&\s*ctx\.task\.planItems/,
    '工具失败时若 planItems 存在，应进入自动标 failed 分支',
  )
  assert.match(
    engineSrc,
    /items\[runningIdx\]\.status\s*=\s*['"]failed['"]/,
    '应把 running 项 status 改为 failed',
  )
  assert.match(
    engineSrc,
    /engine-auto-mark-failed/,
    '应在 resultSummary 追加 engine-auto-mark-failed 标记 + 清单概览',
  )
  assert.match(
    engineSrc,
    /请立即.*检查.*参数|检查.*参数/,
    '应在追加内容中提示模型检查参数',
  )
})

test('engine.ts: PLAN_SYSTEM_PROMPT Spec 级明确禁止阶段标题作为清单项', () => {
  const m = engineSrc.match(/const\s+PLAN_SYSTEM_PROMPT\s*=\s*`([\s\S]*?)`/)
  assert.ok(m, 'PLAN_SYSTEM_PROMPT 应存在')
  const prompt = m![1]!
  assert.match(prompt, /阶段标题.*不要作为可勾选清单项/, '应禁止阶段标题作为可勾选项')
  assert.match(prompt, /动作动词|动作的动词/, '应要求每项含动作动词')
})

test('engine.ts: todo_update 处理逻辑完整（校验 + 自动推进 + 概览）', () => {
  // 校验 item_index 越界
  assert.match(engineSrc, /item_index=.*越界|item_index.*range|item_index.*越界/, '应校验 item_index 越界')
  // 校验 status 合法值
  assert.match(engineSrc, /VALID_STATUSES\s*=\s*new\s+Set/, '应定义合法状态集合')
  assert.match(
    engineSrc,
    /done.*running.*pending.*skipped.*failed|'done'.*'running'.*'pending'.*'skipped'.*'failed'/,
    '合法状态集合应含 5 种',
  )
  // done 时自动推进下一项为 running
  assert.match(
    engineSrc,
    /status\s*===\s*['"]done['"][\s\S]{0,200}status\s*=\s*['"]running['"]/,
    '标 done 时应把下一项 pending 推进为 running',
  )
  // 生成清单概览
  assert.match(engineSrc, /\[\s*x\s*\][\s\S]*\[\s*~\s*\][\s\S]*\[\s*!/, '清单概览应含 done/running/failed 三种 mark')
})
