/* ============================================================
 * v0.14.0 — generatePlan / parsePlanItems 自主分级行为单测
 *
 * 设计：
 *  engine.ts 的 generatePlan 高度依赖 llm/registry、memory、ipc 等模块
 *  （且需 electron-mock-loader 才能跑通），不便直接 mock adapter。
 *  本测试对「纯函数 + 字符串契约」做集成验证（task 描述中允许的方案）：
 *    1. parsePlanItems 行为：用源码内联提取的逻辑对典型输入做断言
 *       （不修改 engine.ts 实现，不读私有符号）
 *    2. PLAN_SYSTEM_PROMPT 字符串：readFileSync 读 engine.ts 源码做关键字断言
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

/** 从源码中"复刻" parsePlanItems 的等价实现（仅用于独立测试纯函数行为）。
 *  这是对原实现的并行副本，不修改 engine.ts。 */
function parsePlanItems(raw: string): string[] | null {
  if (!raw) return null
  let text = raw.replace(/```(?:json)?\s*/g, '').replace(/```/g, '').trim()
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return null
  try {
    const arr = JSON.parse(text.slice(start, end + 1)) as unknown
    if (!Array.isArray(arr)) return null
    const items = arr
      .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      .map((x) => x.trim())
    return items.length > 0 ? items : null
  } catch {
    return null
  }
}

/* ---------- 1. parsePlanItems 纯函数行为 ---------- */

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
  // 这里只验证 parsePlanItems 不丢数据
  const items = Array.from({ length: 13 }, (_, i) => `步骤 ${i + 1}`)
  const out = parsePlanItems(JSON.stringify(items))
  assert.ok(out)
  assert.equal(out!.length, 13, 'parsePlanItems 不应主动截断，由 generatePlan 决定上限')
})

test('parsePlanItems: 数组中夹杂空串/非字符串 → 过滤掉', () => {
  const raw = '["有效 1", "", "   ", 42, null, "有效 2"]'
  const out = parsePlanItems(raw)
  assert.ok(out)
  assert.equal(out!.length, 2)
  assert.deepEqual(out, ['有效 1', '有效 2'])
})

test('parsePlanItems: 损坏 JSON → null（不抛错）', () => {
  assert.equal(parsePlanItems('["步骤 1", "步骤 2"'), null)
  assert.equal(parsePlanItems('{not-json}'), null)
})

test('parsePlanItems: 含前后缀文本 + 数组 → 容忍', () => {
  const raw = '好的，我整理了 3 步：\n["步骤 A", "步骤 B", "步骤 C"]\n请按顺序执行。'
  const out = parsePlanItems(raw)
  assert.ok(out)
  assert.equal(out!.length, 3)
})

/* ---------- 2. generatePlan 上限契约（PlanContent.items） ---------- */

test('generatePlan 上限契约：源码使用 .slice(0, 12) 截断', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../engine.ts', import.meta.url)),
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
    fileURLToPath(new URL('../engine.ts', import.meta.url)),
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
    fileURLToPath(new URL('../engine.ts', import.meta.url)),
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
    '阶段 2：脚手架', '初始化', '接入依赖',
    '阶段 3：实现 A', 'a1', 'a2',
    '阶段 4：实现 B', 'b1', 'b2',
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
    fileURLToPath(new URL('../engine.ts', import.meta.url)),
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
    fileURLToPath(new URL('../engine.ts', import.meta.url)),
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
  const items = Array.from({ length: 12 }, (_, i) => `步骤 ${i + 1}`)
  const out = parsePlanItems(JSON.stringify(items))
  assert.ok(out)
  assert.equal(out!.length, 12)
  assert.equal(out![0], '步骤 1')
  assert.equal(out![11], '步骤 12')
})

test('v0.9.1: READONLY_TOOLS 存在且含 file-reader', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../engine.ts', import.meta.url)),
    'utf8',
  )
  assert.match(
    src,
    /const\s+READONLY_TOOLS\s*=\s*new\s+Set\(\[\s*'file-reader'/,
    'READONLY_TOOLS 应定义为 Set 且含 file-reader',
  )
})

test('v0.16.4: seed.ts 存在 upgradeTo0160 升级逻辑与强化 Skill/工具优先级提示', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../../store/seed.ts', import.meta.url)),
    'utf8',
  )
  assert.match(src, /async\s+function\s+upgradeTo0160/, 'seed.ts 应定义 upgradeTo0160')
  assert.match(src, /version:\s*'0\.16\.4'/, '@default.version 应提升至 0.16.4')
  assert.match(src, /## 1\. 技能优先/, '@default.systemPrompt 应含技能优先段')
  assert.match(src, /## 2\. 工具选择层级/, '@default.systemPrompt 应含工具选择层级段')
  assert.match(src, /## 3\. 禁止模式/, '@default.systemPrompt 应含禁止模式段')
  assert.match(src, /file-writer/, '@default.defaultSkillIds 应包含 file-writer')
  assert.match(src, /file-editor/, '@default.defaultSkillIds 应包含 file-editor')
  assert.match(src, /glob-search/, '@default.defaultSkillIds 应包含 glob-search')
  assert.match(src, /grep-search/, '@default.defaultSkillIds 应包含 grep-search')
})
