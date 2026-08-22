/**
 * v0.27.0 R2（§3.2/F8）：generate-plan.test.ts 重定向到拆分后的 engine/ 模块。
 * - 删除自复刻解析器 → 直接测 @shared/utils/plan-parse 单源
 * - readFileSync 源码契约按最终归属重定向（plan/gates/loop/plan-parser）
 * 用后即删，不入库。
 */
import { readFileSync, writeFileSync } from 'node:fs'

const P = '/Users/gongzheng/ai/ArkWork/app/src/main/agent/__tests__/generate-plan.test.ts'
let src = readFileSync(P, 'utf8')

const R = (oldStr, newStr) => {
  const n = src.split(oldStr).length - 1
  if (n !== 1) throw new Error(`期望唯一命中，实际 ${n} 次：${oldStr.slice(0, 80)}…`)
  src = src.replace(oldStr, newStr)
}

const RF = (from) =>
  `  const src = readFileSync(\n    fileURLToPath(new URL('${from}', import.meta.url)),\n    'utf8',\n  )\n`

// ---------- 1. 头注释 ----------
R(` *  engine.ts 的 generatePlan 高度依赖 llm/registry、memory、ipc 等模块`, ` *  engine/plan.ts 的 generatePlan 高度依赖 llm/registry、memory、ipc 等模块`)
R(` *    2. PLAN_SYSTEM_PROMPT 字符串：readFileSync 读 engine.ts 源码做关键字断言`, ` *    2. PLAN_SYSTEM_PROMPT 字符串：readFileSync 读 engine/ 各模块源码做关键字断言`)

// ---------- 2. 删自复刻解析器 → 导入单源 ----------
R(
  `import { readFileSync } from 'node:fs'\nimport { fileURLToPath } from 'node:url'\n`,
  `import { readFileSync } from 'node:fs'\nimport { fileURLToPath } from 'node:url'\nimport { parsePlanItems } from '@shared/utils/plan-parse'\n`,
)

const copyStart = src.indexOf(`/** 从源码中"复刻" parsePlanItems 的等价实现`)
const copyEndMarker = `  return items.length >= 2 ? items.slice(0, 12) : null\n}\n\n`
const copyEnd = src.indexOf(copyEndMarker)
if (copyStart < 0 || copyEnd < 0) throw new Error('未定位到自复刻解析器块')
src = src.slice(0, copyStart) + `/* v0.27.0 §3.2：parsePlanItems 已单源化至 @shared/utils/plan-parse，此处直接导入实测。 */\n` + src.slice(copyEnd + copyEndMarker.length)

// ---------- 3. readFileSync 契约重定向 ----------
R(RF('../engine.ts') + `  assert.match(\n    src,\n    /items:\\s*items\\.slice\\(`, RF('../engine/plan.ts') + `  assert.match(\n    src,\n    /items:\\s*items\\.slice\\(`)
R(`test('v0.17.4: PLAN_SYSTEM_PROMPT_DOC_DRIVEN 包含全部 10 个阶段且顺序正确', () => {\n` + RF('../engine.ts'), `test('v0.17.4: PLAN_SYSTEM_PROMPT_DOC_DRIVEN 包含全部 10 个阶段且顺序正确', () => {\n` + RF('../engine/plan.ts'))
R(`test('v0.17.4: 文档驱动 prompt 明确 HTML 原型是设计文档不是编码', () => {\n` + RF('../engine.ts'), `test('v0.17.4: 文档驱动 prompt 明确 HTML 原型是设计文档不是编码', () => {\n` + RF('../engine/plan.ts'))
R(`  const engineSrc = readFileSync(\n    fileURLToPath(new URL('../engine.ts', import.meta.url)),`, `  const engineSrc = readFileSync(\n    fileURLToPath(new URL('../engine/plan.ts', import.meta.url)),`)
R(RF('../engine.ts') + `  // v0.9.x：if 块内先 logger.warn 再 return null（空 / 解析失败时降级重试或返回 null）`, RF('../engine/plan.ts') + `  // v0.9.x：if 块内先 logger.warn 再 return null（空 / 解析失败时降级重试或返回 null）`)
R(`function extractPlanPrompt(): string {\n` + RF('../engine.ts'), `function extractPlanPrompt(): string {\n` + RF('../engine/plan.ts'))
R(RF('../engine.ts') + `  // v0.17.4：react-core-skills 启用时用 PLAN_SYSTEM_PROMPT_DOC_DRIVEN 替换 PLAN_SYSTEM_PROMPT，`, RF('../engine/plan.ts') + `  // v0.17.4：react-core-skills 启用时用 PLAN_SYSTEM_PROMPT_DOC_DRIVEN 替换 PLAN_SYSTEM_PROMPT，`)
R(`test('v0.9.1: PLAN_SYSTEM_PROMPT_RETRY 常量存在且要求 3~5 步', () => {\n` + RF('../engine.ts'), `test('v0.9.1: PLAN_SYSTEM_PROMPT_RETRY 常量存在且要求 3~5 步', () => {\n` + RF('../engine/plan.ts'))
R(`test('v0.9.1: READONLY_TOOLS 存在且含 file-reader', () => {\n` + RF('../engine.ts'), `test('v0.9.1: READONLY_TOOLS 存在且含 file-reader', () => {\n` + RF('../engine/loop.ts'))
R(`test('v0.17.4: generatePlan 在 react-core-skills 启用时选择文档驱动 prompt', () => {\n` + RF('../engine.ts'), `test('v0.17.4: generatePlan 在 react-core-skills 启用时选择文档驱动 prompt', () => {\n` + RF('../engine/plan.ts'))
R(`test('v0.17.5: findPlanItemForStage 按阶段匹配计划项', () => {\n` + RF('../engine.ts'), `test('v0.17.5: findPlanItemForStage 按阶段匹配计划项', () => {\n` + RF('../engine/plan-parser.ts'))
R(`test('v0.17.5: 计划项完成检测改为阶段门禁驱动（移除激进 auto-advance）', () => {\n` + RF('../engine.ts'), `test('v0.17.5: 计划项完成检测改为阶段门禁驱动（移除激进 auto-advance）', () => {\n` + RF('../engine/gates.ts'))
R(`test('v0.17.4: 清单与阶段关联 hint 明确原型非编码', () => {\n` + RF('../engine.ts'), `test('v0.17.4: 清单与阶段关联 hint 明确原型非编码', () => {\n` + RF('../engine/plan.ts'))

if (src.includes("'../engine.ts'")) throw new Error('仍残留 ../engine.ts 引用')
writeFileSync(P, src)
console.log('generate-plan.test.ts 重定向完成')
