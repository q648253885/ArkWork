/* ============================================================
 * v0.23.2 — 缓存命中率实测脚本
 *
 * 用产品同款 OpenAIAdapter + 用户真实模型配置（models.json），
 * 按 engine v0.23.2 的 append-only 组装方式构造 12 轮递增对话
 * （system/tools 固定，历史只追加不改写），逐轮读取真实
 * usage.prompt_cache_hit_tokens，输出逐轮与累计命中率。
 *
 * 运行（cwd=app）：
 *   npx tsx scripts/verify-cache.ts
 * ============================================================ */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { OpenAIAdapter } from '../src/main/llm/openai.js'
import type { LlmMessage, LlmTool } from '../src/main/llm/adapter.js'

/* ---------- 配置 ---------- */
const ROUNDS = Number(process.env.ROUNDS ?? 20)
const DATA_DIR = process.env.ARKWORK_DATA ?? join(homedir(), 'Library/Application Support/ArkWork/arkwork-data')

interface ModelCfg { id: string; kind: string; baseURL: string; apiKey: string; enabled?: boolean }
const models = JSON.parse(readFileSync(join(DATA_DIR, 'models.json'), 'utf-8')) as ModelCfg[]
const cfg = models.find((m) => m.kind === 'openai' && m.baseURL.includes('deepseek'))
if (!cfg) { console.error('未找到 DeepSeek 模型配置'); process.exit(1) }

const adapter = new OpenAIAdapter({
  apiKey: cfg.apiKey,
  defaultModel: cfg.id,
  baseURL: cfg.baseURL,
  name: 'verify-cache',
})

/* ---------- 固定 system / tools（跨轮逐字节稳定） ---------- */
const SYSTEM = `你是 ArkWork 工作台内的 ReAct Agent。工作区：/demo/phaser-game。
规则：
1. 每轮先思考再行动，行动只能是工具调用。
2. 工具结果会以 tool 消息回传，据此推进下一步。
3. 全部完成后调用 task_complete 并给出总结。
当前任务：为 Phaser 小游戏项目添加场景管理器，要求支持场景切换动画与预加载清单。`

const TOOLS: LlmTool[] = [
  { type: 'function', function: { name: 'read_file', description: '读取工作区文件内容', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'search_content', description: '在工作区内正则搜索', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'write_file', description: '写入工作区文件', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
]

/* ---------- append-only 历史（模拟 v0.23.2 引擎组装） ---------- */
const FILE = (i: number) => `src/scenes/Scene${i}.ts`
const RESULT = (i: number) =>
  `// Scene${i}: 场景骨架\nimport Phaser from 'phaser'\nexport class Scene${i} extends Phaser.Scene {\n  constructor() { super('Scene${i}') }\n  preload() {\n    this.load.image('bg${i}', 'assets/bg${i}.png')\n    this.load.atlas('ui${i}', 'assets/ui${i}.png', 'assets/ui${i}.json')\n  }\n  create() {\n    this.add.image(400, 300, 'bg${i}')\n    this.tweens.add({ targets: this.cameras.main, alpha: { from: 0, to: 1 }, duration: 300 })\n  }\n}\n// …后续 ${i * 37} 行实现细节：输入绑定、动画曲线、资源释放、场景切换钩子…`

const messages: LlmMessage[] = [
  { role: 'user', content: '开始执行场景管理器任务，按计划逐文件处理。' },
]

let callSeq = 0
const appendRound = (i: number) => {
  callSeq += 1
  const id = `call_verify_${callSeq}`
  messages.push({
    role: 'assistant',
    content: `我来读取 ${FILE(i)} 的现状，确认已有的场景结构。`,
    toolCalls: [{ id, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: FILE(i) }) } }],
  })
  messages.push({ role: 'tool', content: RESULT(i), name: 'read_file', toolCallId: id })
  messages.push({ role: 'user', content: `继续第 ${i + 1} 步。` })
}

/* ---------- 逐轮实测 ---------- */
const fmt = (n: number) => n.toLocaleString('en-US')
console.log(`模型: ${cfg.id} @ ${cfg.baseURL} · 轮数: ${ROUNDS}\n`)
console.log('轮次 | 输入tokens | 命中tokens | 本轮命中率')
console.log('-----+-----------+-----------+---------')

let sumIn = 0, sumHit = 0, sumMiss = 0
const perRound: Array<{ inTok: number; hit: number; rate: number }> = []
for (let r = 1; r <= ROUNDS; r++) {
  appendRound(r)
  const res = await adapter.complete({
    system: SYSTEM,
    messages: [...messages],
    tools: TOOLS,
    maxTokens: 32,
    temperature: 0,
  })
  const hit = res.cache?.hitTokens ?? 0
  const miss = res.cache?.missTokens ?? 0
  const inTok = res.tokensIn || hit + miss
  sumIn += inTok; sumHit += hit; sumMiss += miss
  const rate = inTok > 0 ? hit / inTok : 0
  perRound.push({ inTok, hit, rate })
  console.log(`${String(r).padStart(4)} | ${fmt(inTok).padStart(9)} | ${fmt(hit).padStart(9)} | ${(rate * 100).toFixed(1).padStart(5)}%`)
}

/* 稳态均值：剔除冷启动（前 2 轮缓存未建立）后按输入加权 */
const steadyRounds = perRound.slice(2)
const sIn = steadyRounds.reduce((s, x) => s + x.inTok, 0)
const sHit = steadyRounds.reduce((s, x) => s + x.hit, 0)

const cum = sumIn > 0 ? (sumHit / sumIn) * 100 : 0
const steady = sIn > 0 ? (sHit / sIn) * 100 : 0
console.log('-----+-----------+-----------+---------')
console.log(`累计输入 ${fmt(sumIn)} · 命中 ${fmt(sumHit)} · 未命中 ${fmt(sumMiss)}`)
console.log(`累计命中率（全部轮次）        = ${cum.toFixed(1)}%`)
console.log(`稳态命中率（第 3 轮起加权）    = ${steady.toFixed(1)}%`)
const pass = steady >= 85
console.log(pass ? `\n✅ 达标：稳态命中率 ${steady.toFixed(1)}% ≥ 85%（累计 ${cum.toFixed(1)}%，含冷启动）` : `\n❌ 未达标：稳态命中率 ${steady.toFixed(1)}% < 85%`)
process.exit(pass ? 0 : 2)
