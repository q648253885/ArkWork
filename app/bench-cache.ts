/* eslint-disable */
/**
 * 缓存命中率实测：对比 v0.19.0（system 每轮变化） vs v0.20.0（稳定前缀 + 动态尾部）
 * 直接调用真实 adapter 打 DeepSeek / MiniMax API，逐轮记录 usage 缓存字段。
 * 运行：cd app && npx tsx bench-cache.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { OpenAIAdapter } from './src/main/llm/openai.js'
import { AnthropicAdapter } from './src/main/llm/anthropic.js'
import type { LlmCacheUsage, LlmCompleteRequest, LlmMessage, LlmTool } from './src/main/llm/adapter.js'

interface ModelCfg { id: string; name: string; kind: string; baseURL?: string; apiKey?: string }

const MODELS_PATH = join(homedir(), 'Library/Application Support/ArkWork/arkwork-data/models.json')
const models = JSON.parse(readFileSync(MODELS_PATH, 'utf-8')) as ModelCfg[]

const SYSTEM = [
  '## 角色',
  '你是 ArkWork 的 ReAct Agent，负责分析问题、调用工具、推进任务。',
  '## 行为准则',
  '- 先 Reason 再 Action；',
  '- 每步只做最小必要操作；',
  '- 完成阶段性操作后调用 todo-update 标记进度。',
  '## 计划执行约束',
  '你已生成了计划清单，必须严格按此计划执行（当前进度见对话中的「清单状态」消息）。',
  '每步 Reason 必须在开头声明"正在执行计划第 N 步：xxx"。',
].join('\n')

// 模拟 assembleTools 的确定性排序
const TOOLS: LlmTool[] = [
  { type: 'function', function: { name: 'todo-update', description: '更新任务清单项状态', parameters: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' } }, required: ['id', 'status'] } } },
  { type: 'function', function: { name: 'file-read', description: '读取文件内容', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'file-write', description: '写入文件', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'grep-search', description: '在代码库中搜索文本', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'run-command', description: '执行 shell 命令', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
].sort((a, b) => a.function.name.localeCompare(b.function.name))

const TASK_MSG: LlmMessage = {
  role: 'user',
  content:
    '请检查项目并修复缓存命中率问题：读取 src/main/llm/adapter.ts，分析系统提示词稳定性，然后提出优化方案并写入 docs/。',
}

/** 模拟 N 轮真实对话增长（assistant tool_call + tool result 配对） */
function buildConversation(steps: number): LlmMessage[] {
  const msgs: LlmMessage[] = [TASK_MSG]
  for (let i = 0; i < steps; i++) {
    msgs.push({
      role: 'assistant',
      content: `第 ${i} 步：先读取文件确认内容，再决定下一步。`,
      // DeepSeek thinking 模式要求 assistant 消息带 reasoning_content 传回
      reasoningContent: `（思考：第 ${i} 步需要读取 file-${i}.txt 确认内容）`,
      toolCalls: [
        {
          id: `call_${i}`,
          type: 'function',
          function: { name: 'file-read', arguments: JSON.stringify({ path: `file-${i}.txt` }) },
        },
      ],
    })
    msgs.push({
      role: 'tool',
      toolCallId: `call_${i}`,
      name: 'file-read',
      content: `file-${i}.txt 内容：第 ${i} 段数据，用于缓存命中率基准测试。`,
    })
  }
  return msgs
}

interface Row { iter: number; promptTokens: number; hit: number; miss: number; hitRate: string; cacheField: string }

async function runMode(
  label: string,
  adapter: { complete(req: LlmCompleteRequest): Promise<{ tokensIn: number; cache?: LlmCacheUsage }> },
  mode: 'new' | 'old',
  iterations: number,
): Promise<Row[]> {
  const rows: Row[] = []
  for (let i = 0; i < iterations; i++) {
    const system = mode === 'new' ? SYSTEM : `${SYSTEM}\n[当前进度] 已完成第 ${i} 步，剩余 ${iterations - i} 步`
    const res = await adapter.complete({
      system,
      messages: buildConversation(i),
      tools: TOOLS,
      temperature: 0,
      maxTokens: 48,
    })
    const hit = res.cache?.hitTokens ?? 0
    const miss = res.cache?.missTokens ?? res.tokensIn
    const total = hit + miss
    const rate = total > 0 ? ((hit / total) * 100).toFixed(1) : 'n/a'
    rows.push({
      iter: i + 1,
      promptTokens: res.tokensIn,
      hit,
      miss,
      hitRate: `${rate}%`,
      cacheField: res.cache ? `hit=${res.cache.hitTokens} miss=${res.cache.missTokens}${res.cache.writeTokens !== undefined ? ` write=${res.cache.writeTokens}` : ''}` : '(厂商未返回缓存字段)',
    })
  }
  return rows
}

function print(label: string, rows: Row[]): void {
  console.log(`\n=== ${label} ===`)
  for (const r of rows) {
    console.log(`  iter ${r.iter}: prompt=${r.promptTokens} hit=${r.hit} miss=${r.miss} 命中率=${r.hitRate}  ${r.cacheField}`)
  }
}

async function main(): Promise<void> {
  for (const m of models) {
    const kind = (m.kind ?? '').toLowerCase()
    let adapter: { complete(req: LlmCompleteRequest): Promise<{ tokensIn: number; cache?: LlmCacheUsage }> }
    if (kind === 'openai' || kind === 'vllm' || kind === 'ollama' || kind === 'custom-openai') {
      adapter = new OpenAIAdapter({ apiKey: m.apiKey ?? '', defaultModel: m.id, baseURL: m.baseURL, name: m.name, provider: 'custom-openai' })
    } else if (kind === 'anthropic') {
      adapter = new AnthropicAdapter({ apiKey: m.apiKey ?? '', defaultModel: m.id, baseURL: m.baseURL, name: m.name })
    } else {
      console.log(`\n=== ${m.name}: 跳过（kind=${m.kind}）===`)
      continue
    }

    const name = m.name || m.id
    try {
      print(`[${name}] 新版 v0.20.0（稳定前缀 + 动态尾部）`, await runMode('', adapter, 'new', 4))
      print(`[${name}] 旧版 v0.19.0（system 每轮变化）`, await runMode('', adapter, 'old', 4))
    } catch (err) {
      console.log(`\n=== ${name}: 失败 — ${(err as Error).message} ===`)
    }
  }
}

main().catch((err) => {
  console.error('bench failed:', err)
  process.exit(1)
})
