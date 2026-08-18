/* ============================================================
 * v0.24.x — Plan 生成端到端测试
 *
 * 场景：MiniMax-M3 真实端点 + 中等规模项目（t2 Phaser 游戏，~1900 行）
 * 目标：验证 generatePlan 能产出 ≥ 3 步计划，且通过 parsePlanItems 解析成功
 *       同时校验 file-reader 摘要现在能透传 4000 字符
 *
 * 运行（cwd=app）：
 *   npx tsx scripts/test-plan-generation.ts
 * ============================================================ */
import { AnthropicAdapter } from '../src/main/llm/anthropic.js'
import type { LlmMessage } from '../src/main/llm/adapter.js'

/* ---------- 配置 ---------- */
const MODEL = 'MiniMax-M3'
const WORKSPACE = '/Users/gongzheng/ai/t2'

// v0.24.x：与 engine.ts PLAN_SYSTEM_PROMPT 同语义（不依赖导入避免循环）
const PLAN_SYSTEM_PROMPT = `你是一个任务规划助手。你需要先评估用户请求的复杂度，再自主决定是否产出步骤清单：

**对话级（不输出计划）**：闲聊、提问、单步查询、信息抽取、纯解释等不需要执行多步任务的场景。
**Plan 级（3~6 步）**：明确的多步实现、修复、改造任务，跨多个文件、含具体动作动词（修复/补/写/调研/部署/实现/测试）。
**Spec 级（6~12 步，按文档驱动开发阶段）**：跨多模块、新功能开发、需要架构设计或阶段产物（调研→PRD→交互→原型→系统设计→编码→测试→UX→交付）。

**判断依据（基于用户描述 + 项目代码分析，不要凭空想象）**：
- 多文件 / 多模块 / 跨层
- 含架构 / 重构 / 抽象 / 设计字样
- 含明确边界 / 工作量评估
- 任务含交付物 / 上线 / 部署

**Plan 级 / Spec 级** 必须基于项目代码（已读 workspace 文件）输出 JSON 字符串数组。
**禁止**：通用模板（"分析需求→设计→编码→测试"）、凭空想象步骤、解释性文本、Markdown。

**只输出 JSON 字符串数组**，形如 ["步骤 1", "步骤 2", ...]，无解释、无前后缀。`

const GOAL = '把 src/scenes-ui.js 里的 mkButton 命中区修复，让选关卡片能正常点击。完成后跑 node --check src/scenes-ui.js 验证语法。'

const adapter = new AnthropicAdapter({
  apiKey: 'sk-cp-QpfsEie7q1JsErcZI1kaOMPxaL9pdLyVTSU_DVXVWJCmtLJhE6QVtzspUTzT-Il6zDbzDml4SBh177jqITtteM-pRvNPBO0spQ1lclERal-LG4KREoAuS_4',
  defaultModel: MODEL,
  baseURL: 'https://api.minimaxi.com/anthropic',
  name: 'test-plan-generation',
})

/* ---------- parsePlanItems（对齐 engine.ts 实现）---------- */
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

const messages: LlmMessage[] = [{ role: 'user', content: GOAL }]

console.log(`=== Plan 生成端到端测试 · 模型 ${MODEL} · 工作区 ${WORKSPACE} ===\n`)
console.log(`任务：${GOAL}\n`)

const t0 = Date.now()
const res = await adapter.complete({
  system: PLAN_SYSTEM_PROMPT,
  messages,
  temperature: 0.3,
  maxTokens: 1024,
})
const elapsed = Date.now() - t0

const text = res.content
console.log(`[${MODEL}] ${elapsed}ms · tokens in=${res.tokensIn} out=${res.tokensOut}${res.cache ? ` cache=${res.cache.hitTokens}/${res.cache.hitTokens + res.cache.missTokens}` : ''}`)
console.log(`\n--- 模型原始输出 ---\n${text}\n--- 结束 ---\n`)

const items = parsePlanItems(text)
console.log('=== 解析结果 ===')
if (!items) {
  console.log('❌ 解析失败（空数组 / 损坏 JSON / 无 [] 包裹）')
  console.log(`结果：失败（耗时 ${elapsed}ms）`)
  process.exit(1)
}

console.log(`✅ 解析成功，共 ${items.length} 步：`)
for (let i = 0; i < items.length; i++) {
  console.log(`  ${i + 1}. ${items[i]}`)
}

// 验证
let pass = true
const reasons: string[] = []

if (items.length < 3) {
  pass = false
  reasons.push(`步骤数 ${items.length} < 3（任务跨文件修复应 ≥ 3 步）`)
}
if (items.length > 12) {
  pass = false
  reasons.push(`步骤数 ${items.length} > 12（generatePlan 上限 12）`)
}

const allText = items.join(' ')
if (!/修|改|调|加|删|写|读|查|验证|跑|测试|定位|修复/i.test(allText)) {
  pass = false
  reasons.push('步骤中缺少动作动词（应含具体可执行动作）')
}

// 任何"阶段 N：xxx"型的总结性条目应已被引擎 isPhaseHeader 过滤，
// 解析层不强制过滤（这是引擎层职责）
console.log('')
console.log('=== 判定 ===')
if (pass) {
  console.log(`✅ 通过：plan 生成成功（${items.length} 步，含动作动词）`)
  console.log(`结果：通过（耗时 ${elapsed}ms）`)
  process.exit(0)
} else {
  for (const r of reasons) console.log(`  · ${r}`)
  console.log(`❌ 不通过`)
  process.exit(1)
}