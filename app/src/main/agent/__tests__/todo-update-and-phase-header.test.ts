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

test('seed.ts: @default / @coder systemPrompt 由引擎推进 + todo-update 显式推进清单（v0.18.x）', () => {
  // v0.18.x：写文件/跑命令等阶段内工具不再自动推进清单，改由 LLM 在子任务完成时调 todo-update 显式推进
  assert.match(
    seedSrc,
    /每个子任务[\s\S]{0,40}todo-update/,
    '每个子任务真正完成时应显式调用 todo-update 推进清单',
  )
  // 写文件/跑命令不再自动推进（避免清单抢跑、与真实执行进度错位）
  assert.match(
    seedSrc,
    /阶段内工具[\s\S]{0,10}不会[\s\S]{0,10}自动推进/,
    '写文件/跑命令等阶段内工具不应自动推进清单',
  )
  // 仍然禁止批量打标
  assert.match(seedSrc, /不要批量打标|禁止.*批量标/, '仍应禁止批量打标')
})

/* ---------- 4. 工具失败自动标 failed（源码契约） ---------- */

test('engine.ts: 工具失败时自动把 running 项标 failed（v0.17.6 改用 decidePlanAdvance）', () => {
  // v0.17.6：旧版"if !ok 兜底"已被 decidePlanAdvance 取代
  // 失败场景由 decidePlanAdvance 内部判断分支处理：act 失败 → running 项自动 failed
  assert.match(
    engineSrc,
    /decidePlanAdvance\(\s*ctx\.task\.planItems,\s*action\.tool,\s*ok/,
    '应使用 decidePlanAdvance 综合判断（失败/成功均进入）',
  )
  // decidePlanAdvance 内部：!ok 分支应标 failed
  assert.match(
    engineSrc,
    /!\s*ok[\s\S]{0,200}status\s*=\s*['"]failed['"]/,
    'decidePlanAdvance 内部：act 失败应把 running 项标 failed',
  )
  assert.match(
    engineSrc,
    /engine-decision|engine-decide/,
    '应在 resultSummary 追加 engine-decision 标记',
  )
  assert.match(
    engineSrc,
    /决策规则|决策日志|decidePlanAdvance/,
    '应保留决策规则说明',
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

/* ---------- 7. v0.17.6 引擎独立判断（不依赖 LLM 自调 todo_update） ---------- */

test('v0.17.6: 引擎独立判断函数 decidePlanAdvance 存在', () => {
  assert.match(engineSrc, /function\s+decidePlanAdvance\(/, '应定义 decidePlanAdvance 函数')
  assert.match(engineSrc, /function\s+isProductiveTool\(/, '应定义 isProductiveTool 函数')
  assert.match(engineSrc, /function\s+emitPlanStatus\(/, '应定义 emitPlanStatus 函数')
})

test('v0.18.x: 产成性工具白名单不再含 file-writer/file-editor/shell（避免清单抢跑）', () => {
  const productiveBody = engineSrc.match(/function\s+isProductiveTool\([\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(productiveBody, '应能提取 isProductiveTool 函数体')
  assert.doesNotMatch(productiveBody, /'file-writer'/, 'isProductiveTool 不应含 file-writer（写文件不自动推进清单）')
  assert.doesNotMatch(productiveBody, /'file-editor'/, 'isProductiveTool 不应含 file-editor')
  assert.doesNotMatch(productiveBody, /'shell'/, 'isProductiveTool 不应含 shell')
  assert.match(productiveBody, /'task_complete'/, 'isProductiveTool 应含 task_complete')
  assert.match(productiveBody, /'spec'[\s\S]{0,80}'plan'[\s\S]{0,80}'bugfix'/, 'isProductiveTool 应含 spec/plan/bugfix')
})

test('v0.17.6: 引擎兜底取代 LLM 自调 todo_update（act 结果驱动）', () => {
  // 旧版：只有 !ok 时兜底；新版：ok 时也根据工具类型自动判断
  assert.doesNotMatch(
    engineSrc,
    /!\s*ok\s*&&\s*ctx\.task\.planItems[\s\S]{0,200}engine-auto-mark-failed/,
    '旧版"仅失败兜底"逻辑应被替换',
  )
  assert.match(
    engineSrc,
    /decidePlanAdvance\(\s*ctx\.task\.planItems,\s*action\.tool,\s*ok/,
    '应使用 decidePlanAdvance 综合判断（ok 也可触发推进）',
  )
  // 不应对 todo_update 自己再调 decidePlanAdvance（避免循环）
  assert.match(
    engineSrc,
    /action\.tool\s*!==\s*['"]todo-update['"][\s\S]{0,40}action\.tool\s*!==\s*['"]todo_update['"]/,
    '应排除 todo_update 自身避免循环',
  )
})

test('v0.17.6: 每轮 Reason 前注入 plan_status（独立 user 消息）', () => {
  // emitPlanStatus 应在 reason_start 之后调用
  const reasonIdx = engineSrc.search(/await\s+emitEvent\(\s*\{\s*type:\s*['"]reason_start['"]/)
  const emitIdx = engineSrc.indexOf('emitPlanStatus(task, iteration', reasonIdx)
  assert.ok(reasonIdx > 0, '应先有 reason_start 事件')
  assert.ok(emitIdx > reasonIdx, 'emitPlanStatus 应在 reason_start 之后调用')
  assert.ok(emitIdx - reasonIdx < 2000, 'emitPlanStatus 距离 reason_start 不应过远')
})

test('v0.17.6: plan_status 在 assembleMessages 时作为独立 user 消息注入', () => {
  // assembleMessages 应识别 kind='plan_status' 并注入为 user 消息
  assert.match(
    engineSrc,
    /kind:\s*['"]plan_status['"]/,
    'assembleMessages 应识别 plan_status 类型',
  )
  // 注入内容必须明确"引擎独立判断"
  assert.match(
    engineSrc,
    /plan_status[\s\S]{0,400}引擎独立判断/,
    'plan_status 注入文本应含"引擎独立判断"',
  )
  // 必须以 user 角色注入
  assert.match(
    engineSrc,
    /plan_status[\s\S]{0,400}role:\s*['"]user['"]/,
    'plan_status 应以 user 角色注入',
  )
})

test('v0.17.6: MemoryKind 新增 plan_status', () => {
  const memSrc = readFileSync(
    fileURLToPath(new URL('../../../shared/types/memory.ts', import.meta.url)),
    'utf-8',
  )
  assert.match(
    memSrc,
    /'plan_status'\s*[\s\S]{0,80}v0\.17\.6/,
    'MemoryKind 应新增 plan_status 枚举值',
  )
})
