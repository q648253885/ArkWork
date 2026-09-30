/* ============================================================
 * v0.14.0 — generatePlan / parsePlanItems 自主分级行为单测
 *
 * 设计：
 *  engine/plan.ts 的 generatePlan 高度依赖 llm/registry、memory、ipc 等模块
 *  （且需 electron-mock-loader 才能跑通），不便直接 mock adapter。
 *  本测试对「纯函数 + 字符串契约」做集成验证（task 描述中允许的方案）：
 *    1. parsePlanItems 行为：用源码内联提取的逻辑对典型输入做断言
 *       （不修改 engine.ts 实现，不读私有符号）
 *    2. PLAN_SYSTEM_PROMPT 字符串：readFileSync 读 engine/ 各模块源码做关键字断言
 *    3. generatePlan → PlanContent 上限契约：源码 regex 断言 items.slice(0, 12)
 *    4. 「对话级/Plan 级/Spec 级」三类任务差异化覆盖：简单/中等/复杂
 *
 *  运行（cwd=app）：
 *    ./node_modules/.bin/tsx --test src/main/agent/__tests__/generate-plan.test.ts
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parsePlanItems } from '@shared/utils/plan-parse'

/* v0.27.0 §3.2：parsePlanItems 已单源化至 @shared/utils/plan-parse，此处直接导入实测。 */
/* ---------- 1. parsePlanItems 纯函数行为 ---------- */
/* 注（v0.27.0 单源化实测）：v0.19.1 起解析器会过滤「无动作动词碎片/状态自报」噪声项，
 * 因此测试输入必须是动作句（如「执行 X」「修复 X」），纯序号占位文本按契约被丢弃。 */

test('parsePlanItems: 空字符串 → null（对话级任务场景）', () => {
  assert.equal(parsePlanItems(''), null)
})

test('parsePlanItems: undefined / null → null', () => {
  assert.equal(parsePlanItems(undefined as unknown as string), null)
  assert.equal(parsePlanItems(null as unknown as string), null)
})

test('parsePlanItems: 无 [] 包裹的纯文本 → null', () => {
  assert.equal(parsePlanItems('随便聊几句，不需要计划'), null)
})

test('parsePlanItems: 代码块包裹的空数组（对话级）→ null', () => {
  assert.equal(parsePlanItems('```json\n[]\n```'), null)
  assert.equal(parsePlanItems('```\n[]\n```'), null)
})

test('parsePlanItems: 5 步中等计划（Plan 级）→ 原样返回', () => {
  const raw = '```json\n["定位 auth middleware 文件", "修复 token 校验逻辑", "补全单元测试", "运行 typecheck", "运行 lint"]\n```'
  const out = parsePlanItems(raw)
  assert.ok(out)
  assert.equal(out!.length, 5)
  assert.deepEqual(out, [
    '定位 auth middleware 文件',
    '修复 token 校验逻辑',
    '补全单元测试',
    '运行 typecheck',
    '运行 lint',
  ])
})

test('parsePlanItems: 12 步复杂计划（Spec 级上限）→ 原样返回', () => {
  const items = [
    '阶段 1：架构调研', '梳理依赖', '输出 ADR',
    '阶段 2：搭建脚手架', '初始化目录', '接入依赖',
    '阶段 3：实现核心 A', '实现模块 a1', '实现模块 a2',
    '阶段 4：联调', '端到端测试', '文档与发布',
  ]
  const raw = JSON.stringify(items)
  const out = parsePlanItems(raw)
  assert.ok(out)
  assert.equal(out!.length, 12)
  assert.equal(out![0], '阶段 1：架构调研')
  assert.equal(out![11], '文档与发布')
})

test('parsePlanItems: 13 步超长计划（generatePlan 应截到 12）→ 原样返回 13', () => {
  // parsePlanItems 自身不截，由 generatePlan 在 .slice(0, 12) 截断
  // 这里只验证 parsePlanItems 不丢数据（输入须为动作句，见节首噪声过滤注）
  const items = Array.from({ length: 13 }, (_, i) => `执行子任务 ${i + 1}`)
  const out = parsePlanItems(JSON.stringify(items))
  assert.ok(out)
  assert.equal(out!.length, 13, 'parsePlanItems 不应主动截断，由 generatePlan 决定上限')
})

test('parsePlanItems: 数组中夹杂空串/非字符串 → 过滤掉', () => {
  const raw = '["修复登录页", "", "   ", 42, null, "验证支付流程"]'
  const out = parsePlanItems(raw)
  assert.ok(out)
  assert.equal(out!.length, 2)
  assert.deepEqual(out, ['修复登录页', '验证支付流程'])
})

test('parsePlanItems: 损坏 JSON → null（不抛错）', () => {
  assert.equal(parsePlanItems('["步骤 1", "步骤 2"'), null)
  assert.equal(parsePlanItems('{not-json}'), null)
})

test('parsePlanItems: 含前后缀文本 + 数组 → 容忍', () => {
  const raw = '好的，我整理了 3 步：\n["梳理需求", "实现功能", "回归测试"]\n请按顺序执行。'
  const out = parsePlanItems(raw)
  assert.ok(out)
  assert.equal(out!.length, 3)
})

/* v0.24.1：思考型模型不输出 JSON 数组，输出散文/编号/箭头链的容错解析 */

test('parsePlanItems: 编号列表（1. 2. 3.）→ 提取为清单', () => {
  const raw = '好的，我按文档驱动流程来：\n1. 定位问题并梳理现状\n2. 修改代码实现技能调用\n3. 验证修复效果'
  const out = parsePlanItems(raw)
  assert.ok(out, '编号列表应能被容错解析')
  assert.equal(out!.length, 3)
  assert.equal(out![0], '定位问题并梳理现状')
  assert.equal(out![1], '修改代码实现技能调用')
  assert.equal(out![2], '验证修复效果')
})

test('parsePlanItems: 中文编号（一、二、三 或 1、2、3）→ 提取为清单', () => {
  const raw = '一、定位问题\n二、修改代码\n三、验证'
  const out = parsePlanItems(raw)
  assert.ok(out, '中文编号列表应能被容错解析')
  assert.equal(out!.length, 3)
})

test('parsePlanItems: 无序列表（- / * / •）→ 提取为清单', () => {
  const raw = '- 定位问题\n* 修改代码\n• 验证效果'
  const out = parsePlanItems(raw)
  assert.ok(out, '无序列表应能被容错解析')
  assert.equal(out!.length, 3)
})

test('parsePlanItems: 箭头链（A → B → C）→ 拆分为清单', () => {
  const raw = '定位问题 → 修改代码实现技能调用 → 验证修复效果'
  const out = parsePlanItems(raw)
  assert.ok(out, '箭头链应能被容错解析')
  assert.equal(out!.length, 3)
  assert.equal(out![0], '定位问题')
  assert.equal(out![2], '验证修复效果')
})

test('parsePlanItems: 编号列表混入说明性段落 → 只提取列表项', () => {
  const raw = '先说明背景：用户反馈 agent 调用 skill 但未实现使用。\n接下来：\n1. 定位根因\n2. 修复引擎\n3. 回归验证。'
  const out = parsePlanItems(raw)
  assert.ok(out)
  assert.equal(out!.length, 3)
})

/* ---------- 2. generatePlan 上限契约（PlanContent.items） ---------- */

test('generatePlan 上限契约：源码使用 .slice(0, 12) 截断', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../engine/plan.ts', import.meta.url)),
    'utf8',
  )
  assert.match(
    src,
    /items:\s*items\.slice\(\s*0\s*,\s*12\s*\)/,
    'generatePlan 应对 items 截到 12 以容纳分阶段计划',
  )
})

test('generatePlan 上限契约：空数组 / 解析失败 → return null', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../engine/plan.ts', import.meta.url)),
    'utf8',
  )
  // v0.9.x：if 块内先 logger.warn 再 return null（空 / 解析失败时降级重试或返回 null）
  assert.match(
    src,
    /if\s*\(\s*!items\s*\|\|\s*items\.length\s*===\s*0\s*\)\s*\{[\s\S]*?return\s+null/,
    'generatePlan 解析空 / 失败时应 return null',
  )
})

/* ---------- 3. PLAN_SYSTEM_PROMPT 关键字契约 ---------- */

function extractPlanPrompt(): string {
  const src = readFileSync(
    fileURLToPath(new URL('../engine/plan.ts', import.meta.url)),
    'utf8',
  )
  const m = src.match(/const\s+PLAN_SYSTEM_PROMPT\s*=\s*`([\s\S]*?)`/)
  if (!m) throw new Error('未找到 PLAN_SYSTEM_PROMPT 字面量')
  return m[1]!
}

test('PLAN_SYSTEM_PROMPT：含「对话级 / Plan 级 / Spec 级」三档', () => {
  const p = extractPlanPrompt()
  assert.match(p, /对话级/)
  assert.match(p, /Plan\s*级/)
  assert.match(p, /Spec\s*级/)
})

test('PLAN_SYSTEM_PROMPT：含「简单 / 中等 / 复杂」关键词', () => {
  const p = extractPlanPrompt()
  assert.match(p, /简单/)
  assert.match(p, /中等/)
  assert.match(p, /复杂/)
})

test('PLAN_SYSTEM_PROMPT：含判断依据（多文件 / 架构 / 边界 / 工作量）', () => {
  const p = extractPlanPrompt()
  assert.match(p, /多文件|多模块/, '应含「多文件 / 多模块」判断依据')
  assert.match(p, /架构/, '应含「架构」判断依据')
  assert.match(p, /边界|工作/, '应含「边界 / 工作量」判断依据')
})

test('PLAN_SYSTEM_PROMPT：要求基于代码分析、禁止通用模板', () => {
  const p = extractPlanPrompt()
  assert.match(p, /项目代码|代码分析/, '应要求基于项目代码分析')
  assert.match(p, /禁止|不得|不要/, '应禁止通用模板 / 凭空想象')
})

test('PLAN_SYSTEM_PROMPT：要求只输出 JSON 数组、无解释', () => {
  const p = extractPlanPrompt()
  assert.match(p, /JSON\s*字符串数组|JSON\s*数组|只输出\s*JSON/, '应要求只输出 JSON 数组')
})

/* ---------- 4. 三档任务差异覆盖（端到端契约） ---------- */

test('简单任务（对话级）：mock adapter 返回空数组 → generatePlan 契约 null', () => {
  // 复现 generatePlan 末尾的判断逻辑
  const items = parsePlanItems('[]')
  if (!items || items.length === 0) {
    assert.equal(items, null, '空数组 → null（引擎据此跳过 plan L1）')
  } else {
    assert.fail('不应进入非空分支')
  }
})

test('中等任务（Plan 级）：mock adapter 返回 4 步 → PlanContent.items 长度在 3~6', () => {
  const items = parsePlanItems('["定位 auth", "修复 token", "补单测", "typecheck + lint"]')
  assert.ok(items)
  assert.ok(items!.length >= 3 && items!.length <= 6, `Plan 级应 3~6 步，实际 ${items!.length}`)
})

test('复杂任务（Spec 级）：mock adapter 返回 10+ 步分阶段 → PlanContent.items 长度 ≥ 8', () => {
  const raw = JSON.stringify([
    '阶段 1：调研', '梳理依赖', '输出 ADR',
    '阶段 2：搭建脚手架', '初始化目录', '接入依赖',
    '阶段 3：实现 A', '实现模块 a1', '实现模块 a2',
    '阶段 4：实现 B', '实现模块 b1', '实现模块 b2',
  ])
  const items = parsePlanItems(raw)
  assert.ok(items)
  assert.ok(items!.length >= 8, `Spec 级应 ≥ 8 步，实际 ${items!.length}`)
  // 模拟 generatePlan 的 .slice(0, 12) 上限
  const sliced = items!.slice(0, 12)
  assert.equal(sliced.length, 12, 'generatePlan 截到 12')
})

/* ---------- 5. v0.9.1 修复回归断言（maxTokens / RETRY / 截断 / READONLY_TOOLS / upgradeTo091） ---------- */

test('v0.9.1: generatePlan 首轮使用 maxTokens 1024（非 400）', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../engine/plan.ts', import.meta.url)),
    'utf8',
  )
  // v0.17.4：react-core-skills 启用时用 PLAN_SYSTEM_PROMPT_DOC_DRIVEN 替换 PLAN_SYSTEM_PROMPT，
  // 两者都通过 basePrompt 变量传入 tryGeneratePlan，maxTokens 仍为 1024。
  assert.match(
    src,
    /tryGeneratePlan\(\s*basePrompt,\s*1024/,
    'generatePlan 首次尝试应传 maxTokens 1024（v0.9.x 由 400 提升）',
  )
  // 同时确认 PLAN_SYSTEM_PROMPT_DOC_DRIVEN 常量存在
  assert.match(src, /const\s+PLAN_SYSTEM_PROMPT_DOC_DRIVEN\s*=/, '应定义文档驱动专用计划 prompt')
})

test('v0.9.1: PLAN_SYSTEM_PROMPT_RETRY 常量存在且要求 3~5 步', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../engine/plan.ts', import.meta.url)),
    'utf8',
  )
  assert.match(
    src,
    /const\s+PLAN_SYSTEM_PROMPT_RETRY\s*=/,
    'engine.ts 应定义 PLAN_SYSTEM_PROMPT_RETRY 精简重试 prompt',
  )
  const m = src.match(/const\s+PLAN_SYSTEM_PROMPT_RETRY\s*=\s*`([\s\S]*?)`/)
  assert.ok(m, '未找到 PLAN_SYSTEM_PROMPT_RETRY 字面量')
  assert.match(m![1]!, /3~5/, '重试 prompt 应要求 3~5 步')
  assert.match(m![1]!, /JSON\s*字符串数组/, '重试 prompt 应要求只输出 JSON 字符串数组')
})

test('v0.9.1: parsePlanItems 对截断的 12 步 JSON（缺 ]）→ null', () => {
  const items = Array.from({ length: 12 }, (_, i) => `步骤 ${i + 1}`)
  const raw = JSON.stringify(items).slice(0, -1) // 去掉结尾 ]
  assert.equal(parsePlanItems(raw), null, '截断 JSON 解析失败应返回 null，触发降级重试')
})

test('v0.9.1: parsePlanItems 对完整 12 步数组 → 12 项', () => {
  // 输入须为动作句（v0.19.1 噪声过滤契约，见节首注）
  const items = Array.from({ length: 12 }, (_, i) => `执行子任务 ${i + 1}`)
  const out = parsePlanItems(JSON.stringify(items))
  assert.ok(out)
  assert.equal(out!.length, 12)
  assert.equal(out![0], '执行子任务 1')
  assert.equal(out![11], '执行子任务 12')
})

test('v0.38.0: 只读白名单唯一事实源在 work-class.ts（isReadonlyTool）', () => {
  // v0.38.1（D166 测试侧改写随新语义）：v0.38.0 纪律⑧ 删除 loop.ts 本地 READONLY_TOOLS
  //（loop / registry / plan-tree-sync 三份语义漂移是 D150 温床），收敛为 work-class.ts 单源。
  const src = readFileSync(
    fileURLToPath(new URL('../engine/work-class.ts', import.meta.url)),
    'utf8',
  )
  assert.match(
    src,
    /export const READONLY_TOOLS = \[\s*'file-reader'/,
    'READONLY_TOOLS 应定义且含 file-reader（数组 → READONLY_SET）',
  )
  assert.match(
    src,
    /export function isReadonlyTool\(name: string\): boolean/,
    '应导出 isReadonlyTool（唯一判定入口）',
  )
  const loopSrc = readFileSync(
    fileURLToPath(new URL('../engine/loop.ts', import.meta.url)),
    'utf8',
  )
  assert.match(loopSrc, /isReadonlyTool\(a\.tool\)/, 'loop.ts Act 路径应消费 isReadonlyTool')
})

test('v0.19.0: seed.ts 使用 syncBuiltinAgentsToLatest 统一同步内置 Agent 到最新版本', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../../store/seed.ts', import.meta.url)),
    'utf8',
  )
  assert.match(src, /async\s+function\s+syncBuiltinAgentsToLatest/, 'seed.ts 应定义 syncBuiltinAgentsToLatest')
  // v0.38.1（D166 测试侧改写随新语义）：版本钉子不再写死具体号（v0.34.4 → 0.38.0，
  // 此后每次提示词改写都会再升），只钉「≥0.34.4」单调语义：
  // syncBuiltinAgentsToLatest 只在 version 落后时同步，因此改提示词必须同时升版本。
  // 锚定 @default 定义块取 version（seed.ts 里另有标志文件版本等杂项 match，不可用首个）。
  const defIdx = src.indexOf("id: '@default'")
  assert.ok(defIdx >= 0, 'seed.ts 应定义 @default 内置 Agent')
  const coderIdx = src.indexOf("id: '@coder'")
  const defSrc = src.slice(defIdx, coderIdx > 0 ? coderIdx : undefined)
  const ver = defSrc.match(/version:\s*'(\d+)\.(\d+)\.(\d+)'/)
  assert.ok(ver, '@default 应带 version 字段')
  const nums = ver!.slice(1).map(Number)
  const [maj, min, pat] = [nums[0]!, nums[1]!, nums[2]!]
  assert.ok(
    maj > 0 || min > 34 || (min === 34 && pat >= 4),
    `@default.version 应 ≥0.34.4（实得 ${ver![0]}；提示词修正需触发同步）`,
  )
  assert.match(src, /systemSections/, '内置 Agent 应派生 systemSections')
  assert.match(src, /## 1\. 技能优先/, '@default.systemPrompt 应含技能优先段')
  assert.match(src, /## 2\. 工具选择层级/, '@default.systemPrompt 应含工具选择层级段')
  assert.match(src, /## 3\. 禁止模式/, '@default.systemPrompt 应含禁止模式段')
  assert.match(src, /file-writer/, '@default.defaultSkillIds 应包含 file-writer')
  assert.match(src, /file-editor/, '@default.defaultSkillIds 应包含 file-editor')
  assert.match(src, /glob-search/, '@default.defaultSkillIds 应包含 glob-search')
  assert.match(src, /grep-search/, '@default.defaultSkillIds 应包含 grep-search')
  assert.match(src, /S-core\.browser/, '@default.defaultSkillIds 应包含 browser（v0.24.1 agent 自主浏览器）')
})

/* ---------- 6. v0.17.4 文档驱动计划 prompt 与阶段对齐验证 ---------- */

test('v0.17.4: PLAN_SYSTEM_PROMPT_DOC_DRIVEN 包含全部 10 个阶段且顺序正确', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../engine/plan.ts', import.meta.url)),
    'utf8',
  )
  const m = src.match(/const\s+PLAN_SYSTEM_PROMPT_DOC_DRIVEN\s*=\s*`([\s\S]*?)`/)
  assert.ok(m, 'PLAN_SYSTEM_PROMPT_DOC_DRIVEN 应存在')
  const prompt = m![1]!

  // 10 个阶段必须按顺序出现
  const stages = [
    '1. 开源调研',
    '2. PRD',
    '3. 交互文档',
    '4. HTML 原型',
    '5. 系统设计',
    '6. 编码',
    '7. 功能测试',
    '8. UI 测试',
    '9. UX 校验',
    '10. 交付打包',
  ]
  for (const s of stages) {
    assert.ok(prompt.includes(s), `prompt 应包含阶段 "${s}"`)
  }

  // 验证顺序：各阶段在文本中的位置必须递增
  let lastPos = -1
  for (const s of stages) {
    const pos = prompt.indexOf(s)
    assert.ok(pos > lastPos, `阶段 "${s}" 应出现在前一个阶段之后 (pos=${pos}, lastPos=${lastPos})`)
    lastPos = pos
  }
})

test('v0.17.4: 文档驱动 prompt 明确 HTML 原型是设计文档不是编码', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../engine/plan.ts', import.meta.url)),
    'utf8',
  )
  const m = src.match(/const\s+PLAN_SYSTEM_PROMPT_DOC_DRIVEN\s*=\s*`([\s\S]*?)`/)
  const prompt = m![1]!
  assert.match(prompt, /HTML 原型.*设计稿.*非编码/, '应明确 HTML 原型是设计稿非编码')
  assert.match(prompt, /阶段 1~5 都是文档\/设计产出.*禁止.*编码/, '应禁止阶段 1~5 安排编码')
  assert.match(prompt, /编码步骤只能出现在阶段 6/, '应限定编码只在阶段 6')
})

test('v0.17.4: 文档驱动 prompt 的产物路径与 STAGE_GATES 正则对齐', () => {
  const engineSrc = readFileSync(
    fileURLToPath(new URL('../engine/plan.ts', import.meta.url)),
    'utf8',
  )
  const promptMatch = engineSrc.match(/const\s+PLAN_SYSTEM_PROMPT_DOC_DRIVEN\s*=\s*`([\s\S]*?)`/)
  const prompt = promptMatch![1]!

  const gatesSrc = readFileSync(
    fileURLToPath(new URL('../../skills/builtin/react-core-skills/stage-gates.ts', import.meta.url)),
    'utf8',
  )

  // prompt 中每个阶段的产出文件，必须在 STAGE_GATES 有对应的正则
  const expectedPairs = [
    { stage: '开源调研', file: '00-opensource-research.md', gatePattern: '00-opensource-research\\.md' },
    { stage: 'PRD', file: '01-prd.md', gatePattern: '01-prd\\.md' },
    { stage: '交互文档', file: '02-interaction.md', gatePattern: '02-interaction\\.md' },
    { stage: 'HTML 原型', file: 'prototype/index.html', gatePattern: 'prototype\\/.*\\.html?' },
    { stage: '系统设计', file: '03-system-design.md', gatePattern: '03-system-design\\.md' },
  ]
  for (const { stage, file, gatePattern } of expectedPairs) {
    assert.ok(prompt.includes(file), `prompt 阶段"${stage}"应包含产物路径 ${file}`)
    assert.ok(
      new RegExp(gatePattern).test(gatesSrc),
      `STAGE_GATES 应包含匹配 ${file} 的正则 (${gatePattern})`,
    )
  }
})

/* ---------- 6.5 v0.36.5 D124：文档驱动 prompt 的 Tier-0 对话级出口 ---------- */

test('v0.36.5 D124: 文档驱动 prompt 含 Tier-0 对话级出口（只读任务 → []）', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../engine/plan.ts', import.meta.url)),
    'utf8',
  )
  const m = src.match(/const\s+PLAN_SYSTEM_PROMPT_DOC_DRIVEN\s*=\s*`([\s\S]*?)`/)
  assert.ok(m, 'PLAN_SYSTEM_PROMPT_DOC_DRIVEN 应存在')
  const prompt = m![1]
  // 出口段存在且排在 10 阶段清单之前（头部评估，不是尾部补丁）
  assert.match(prompt, /Tier-0 对话级出口/, '应包含 Tier-0 出口段标题')
  assert.match(prompt, /只读任务/, '出口应覆盖问答/查询/检查/分析类只读任务')
  assert.match(prompt, /输出 \[\]/, '出口动作必须是输出空数组（走 plan-fallback 单项路径）')
  assert.match(prompt, /禁止为只读任务强行套用下方 10 阶段/, '应显式禁止只读任务套用 10 阶段')
  const exitIdx = prompt.indexOf('Tier-0 对话级出口')
  const stagesIdx = prompt.indexOf('**阶段清单（')
  assert.ok(exitIdx >= 0 && stagesIdx > exitIdx, 'Tier-0 出口必须在 10 阶段清单之前（头部先评估）')
  // 出口与既有锚点并存：文档驱动级定义 + 10 阶段措辞不丢（v0.17.4 既有用例继续兜底）
  assert.match(prompt, /文档驱动级（产出清单）/, '应保留文档驱动级分支定义')
})

test('v0.36.5 D125: plan 注入前缀改中性权威（不再复读「请严格按此计划执行」）', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../engine/messages.ts', import.meta.url)),
    'utf8',
  )
  assert.doesNotMatch(
    src,
    /请严格按此计划执行，每步完成后继续下一步/,
    '历史 user 消息前缀不得再附加僵化执行指令（与 D12 replan 通道冲突）',
  )
  assert.match(
    src,
    /计划清单 — 初始计划快照（各项当前状态以「清单状态」消息为准）/,
    '前缀应改为中性权威快照声明（对齐 ZCode formatTodoStateForModel）',
  )
})

test('v0.36.5 D125: plan-constraint 段冲突句改写（sections.ts 与遗留 prompt-assembly 同步）', () => {
  for (const rel of ['../prompt/sections.ts', '../prompt-assembly.ts']) {
    const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
    assert.doesNotMatch(
      src,
      /先用 ask_user 向用户确认/,
      `${rel}：旧句「若计划需调整先用 ask_user」与 D12 replan 通道冲突，应改写`,
    )
    // v0.40.0（D202）：本条钉的是 D125 的**语义**（先同步、后执行），不是工具名。
    // 原来把「用 task_plan 提交同步后的完整清单」整句钉死，而 D202 正是要把这类
    // 硬性要求去掉 —— 弱模型做不到时会被判为「不用工具」→ 空转（evidence/04）。
    // 清单维护的责任已移交引擎侧的清单操作通道，故判据放宽为两种写法都收，
    // 「不许再提必须通过 task_plan」由 TC-OPS-020 反向钉死。
    assert.match(
      src,
      /先按对话末尾『续聊指令与清单』规则(?:用 task_plan 提交同步后的完整清单|同步清单)/,
      `${rel}：应改为「先同步、后执行」（语义判据，不绑定 task_plan 工具名）`,
    )
    assert.match(
      src,
      /未经用户批准不得整体作废/,
      `${rel}：整体作废仍须经用户批准（D12 v2 不变量）`,
    )
  }
})

test('v0.17.4: generatePlan 在 react-core-skills 启用时选择文档驱动 prompt', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../engine/plan.ts', import.meta.url)),
    'utf8',
  )
  // v0.17.5：docDriven 由引擎层传入（getSkill 名称匹配），兜底 isCoreSkillsEnabled
  assert.match(src, /const\s+useDocDriven\s*=\s*docDriven\s*\?\?\s*isCoreSkillsEnabled\(task,\s*agent\)/, '应调用 isCoreSkillsEnabled 兜底判断')
  assert.match(src, /const\s+basePrompt\s*=\s*useDocDriven\s*\?\s*PLAN_SYSTEM_PROMPT_DOC_DRIVEN\s*:\s*PLAN_SYSTEM_PROMPT/, '应根据判断结果选择 prompt')
  // 两次 tryGeneratePlan 都应使用 basePrompt（首次 + 加大预算重试）
  const matches = src.match(/tryGeneratePlan\(\s*basePrompt/g)
  assert.ok(matches && matches.length >= 2, '首次和重试都应使用 basePrompt')
})

test('v0.17.5: findPlanItemForStage 按阶段匹配计划项', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../engine/plan-parser.ts', import.meta.url)),
    'utf8',
  )
  assert.match(src, /function\s+findPlanItemForStage/, '应定义 findPlanItemForStage 辅助函数')
  // 关键词映射覆盖 5 个文档驱动阶段
  assert.match(src, /research:\s*\/调研\|research\/i/, 'research 阶段应匹配调研关键词')
  assert.match(src, /prd:\s*\/PRD\|产品\|需求\/i/, 'prd 阶段应匹配 PRD 关键词')
  assert.match(src, /interaction:\s*\/交互\|interaction\/i/, 'interaction 阶段应匹配交互关键词')
  assert.match(src, /prototype:\s*\/原型\|prototype\/i/, 'prototype 阶段应匹配原型关键词')
  assert.match(src, /'system-design':\s*\/系统设计\|system\.\?design\|架构\|技术选型\/i/, 'system-design 阶段应匹配系统设计关键词')
})

test('v0.17.5: 计划项完成检测改为阶段门禁驱动（移除激进 auto-advance）', () => {
  const gatesSrc = readFileSync(
    fileURLToPath(new URL('../engine/gates.ts', import.meta.url)),
    'utf8',
  )
  // v0.27.0 R2：门禁命中后的完成标注调用点随拆分迁至主循环 loop.ts
  const loopSrc = readFileSync(
    fileURLToPath(new URL('../engine/loop.ts', import.meta.url)),
    'utf8',
  )
  // 不应再有「act 全部成功 → running 标 done」的激进逻辑
  assert.doesNotMatch(gatesSrc, /actResults\.every\(\(r\) => r\.ok\)/, '不应再有 actResults.every 自动标 done')
  assert.doesNotMatch(loopSrc, /actResults\.every\(\(r\) => r\.ok\)/, '不应再有 actResults.every 自动标 done')
  // 应改为阶段门禁驱动
  assert.match(loopSrc, /findPlanItemForStage\(task\.planItems,\s*gate\.stage\)/, '阶段门禁触发时应用 findPlanItemForStage 标 done')
})

test('v0.17.4: 清单与阶段关联 hint 明确原型非编码', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../engine/run-setup.ts', import.meta.url)),
    'utf8',
  )
  assert.match(src, /HTML 原型是设计文档的一部分.*不是编码步骤/, 'hint 应明确原型非编码')
  assert.match(src, /在系统设计.*冻结前.*禁止执行任何编码/, 'hint 应禁止系统设计冻结前编码')
})

test('v0.38.1（D168）①: plan prompt 收到「直接答案 JSON（task_complete=true）」按 Tier-0 显式空计划处理', () => {
  // 实测 qwen3.5:0.8b 对 1+1 问答返回 {"answer":"1+1=2","task_complete":true} ——
  // 原设计解析失败 → 兜底建清单 → 模型无力收尾 → 烧到迭代上限。语义上与 [] 同愿。
  const src = readFileSync(fileURLToPath(new URL('../engine/plan.ts', import.meta.url)), 'utf8')
  assert.match(src, /safeParseJsonObject\(rawStr\)/, '必须严格解析 JSON 对象（防误判宽松文本）')
  assert.match(src, /asObj\['task_complete'\] === true/, '只认 task_complete === true 的显式表态')
  assert.match(src, /onNull\?\.\(\{ explicitEmpty: true \}\)/, '必须按 Tier 0 显式空计划上报（不弹错误态）')
  // 严格形态守卫：只对「{」开头做对象解析，数组路径（["1+1=2"] 会被当成 1 项清单）不受影响
  assert.match(src, /rawStr\.startsWith\('\{'\)/, '只对对象形态做直接答案判定')
})

test('v0.38.1（D169）: 模型显式空清单（Tier 0）必须短路降级链，不得被精简重试强扭成清单', () => {
  // 实测 qwen3.5:9b 对 1+1 问答两次正确回 []，仍被 4096 重试 + 精简「强制 3~5 步」
  // 重试覆盖成 2 项清单后空转。sawExplicitEmpty 必须在每次 try 失败后立即短路。
  const src = readFileSync(fileURLToPath(new URL('../engine/plan.ts', import.meta.url)), 'utf8')
  // 短路点必须早于 4096 重试与精简重试（出现两次：planBig 前 + planSmall 前）
  // v0.38.1（D170）：短路体改为回调 + return null 的多行形态（回调置 chatMode）
  const shortCircuits =
    src.match(/if \(sawExplicitEmpty\) \{\s*\n\s*onExplicitEmpty\?\.\(\)\s*\n\s*return null\s*\n\s*\}/g) ?? []
  assert.ok(shortCircuits.length >= 2, `显式空短路必须覆盖两级重试（实测 ${shortCircuits.length} 处）`)
  // 精简重试（PLAN_SYSTEM_PROMPT_RETRY）必须位于最后一个短路点之后
  const lastShort = src.lastIndexOf('if (sawExplicitEmpty)')
  const retryAt = src.indexOf('PLAN_SYSTEM_PROMPT_RETRY,')
  assert.ok(retryAt > lastShort, '精简重试必须被显式空短路保护（模型已表态无需清单时不可达）')
  // Tier-0 判定保持宽松匹配（宁可漏报也不误报的反向：[] 才算显式空）
  assert.match(src, /onNull\?\.\(\{ explicitEmpty: \/\\\[\\s\*\\\]\/\.test\(String\(raw \?\? ''\)\) \}\)/, '[] 判定必须走既有正则口径')
})

test('v0.38.1（调研 G1）: task_plan 纪律教学固化 —— 完成即标记/唯一 doing/禁批量/只读不建项', () => {
  // 对齐 opencode「Task Management」与 dsh todo_write 的共性状态机纪律：
  // 一次一个进行中、完成即标记不批量、无清单任务不造项（尊重模型自主判断）。
  // seed.ts §6 已具备全部要点（本轮调研核对结论：无需改 prompt，测试固化）。
  const src = readFileSync(fileURLToPath(new URL('../../store/seed.ts', import.meta.url)), 'utf8')
  assert.match(src, /同一时刻最多一项 doing/, '一次只允许一个进行中（opencode/dsh todo 同款状态机）')
  assert.match(src, /禁止批量打标/, '完成即标记、不得批量（opencode Task Management 同款纪律）')
  assert.match(src, /真正完成\*\*（该项状态改为 done）/, '「真正完成才标 done」语义必须在提示词中')
  assert.match(src, /不要\*\*为了留痕而造项/, '只读问答不得为留痕造项（Tier-0 同源语义）')
})

test('v0.38.1（D170）: plan 显式空回调接线 —— run-setup 据此置 chatMode 对话级降级', () => {
  // 实测：qwen3.5 对「你好」被兜底成单项清单后走完全套守卫链。D169 短路后
  // 语义上应更进一步：显式空 = 模型说「这是纯对话」→ 答复即终局。
  const planSrc = readFileSync(fileURLToPath(new URL('../engine/plan.ts', import.meta.url)), 'utf8')
  assert.match(planSrc, /onExplicitEmpty\?: \(\) => void,/, 'generatePlan 签名必须声明 onExplicitEmpty 回调')
  const calls = planSrc.match(/onExplicitEmpty\?\.\(\)/g) ?? []
  assert.ok(calls.length >= 2, `两处短路点都必须调用回调（实测 ${calls.length} 处）`)
  // run-setup 侧：置位 + 传递（loop 侧消费由 TC-STALLG-024 钉住）
  const runSrc = readFileSync(fileURLToPath(new URL('../engine/run-setup.ts', import.meta.url)), 'utf8')
  assert.match(runSrc, /chatMode: boolean/, 'PreparedRun 必须声明 chatMode（答复即终局）')
  assert.match(runSrc, /chatMode = true/, 'plan 显式空回调必须置 chatMode = true')
})

test('v0.38.1（D172）: seed §6 收窄「不建清单」边界 —— 分析/调研类属实质工作应建轻量清单', () => {
  // 实测 deepseek-flash 把「分析一下这个项目需要什么技术」判为只读问答不建清单
  // （思考过程 "No task_plan change needed (read-only Q&A)"）。根因：§6「不调用」
  // 边界写得太宽。修正为模型无关的统一纪律，不设 provider/模型名分支。
  const src = readFileSync(fileURLToPath(new URL('../../store/seed.ts', import.meta.url)), 'utf8')
  const hits = src.match(/分析、调研、评审、方案类请求属于实质工作/g) ?? []
  assert.ok(hits.length >= 2, `@default 与 @coder 都要带该纪律（实测 ${hits.length} 处）`)
  assert.match(src, /纯问候 \/ 闲聊 \/ 对已答复内容的简短确认/, '「不调用」边界必须收窄到纯问候/闲聊/简短确认')
  // 版本钉子：改提示词必须升 version 触发 syncBuiltinAgentsToLatest 同步存量 Agent
  // v0.42.2（D214，纪律㉔ 改写）：§6 增层级规划/收尾引导 + defaultSkillIds 补
  // task-complete → 0.42.2（本钉子随每次 seed 提示词/技能清单变更同步上移）
  const versions = src.match(/version: '0\.42\.2'/g) ?? []
  assert.ok(versions.length >= 3, `内置 Agent version 必须升至 0.42.2（实测 ${versions.length} 处）`)
})
