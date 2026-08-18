/* ============================================================
 * bugfix 技能开销量化：每个阶段独立测量，绕过 tool-call 协议
 *
 * 直接测 4 个阶段的 LLM 输入开销：决策器评估、委派定位、委派编辑、决策器收尾。
 *
 * 运行（cwd=app）：
 *   npx tsx scripts/repro-bugfix-overhead.ts
 * ============================================================ */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { OpenAIAdapter } from '../src/main/llm/openai.js'
import type { LlmMessage } from '../src/main/llm/adapter.js'

const DATA_DIR = join(process.env.HOME ?? '', 'Library/Application Support/ArkWork/arkwork-data')
const cfg = (JSON.parse(readFileSync(join(DATA_DIR, 'models.json'), 'utf-8')) as any[])
  .find((m) => m.kind === 'openai' && m.baseURL.includes('deepseek'))!
const adapter = new OpenAIAdapter({ apiKey: cfg.apiKey, defaultModel: cfg.id, baseURL: cfg.baseURL, name: 'repro' })

const workspace = mkdtempSync(join(tmpdir(), 'bugfix-'))
const code = `export function add(a: number, b: number): number { return a - b }\n`
const fixed = `export function add(a: number, b: number): number { return a + b }\n`
writeFileSync(join(workspace, 'add.ts'), code)

const tok = (s: string) => Math.ceil(s.length / 2.4)
let totalIn = 0, totalOut = 0, callCount = 0
async function llmCall(label: string, system: string, messages: LlmMessage[]) {
  callCount++
  const res = await adapter.complete({ system, messages, temperature: 0, maxTokens: 400 })
  totalIn += res.tokensIn; totalOut += res.tokensOut
  console.log(`  ${label.padEnd(34)} in=${String(res.tokensIn).padStart(4)} out=${String(res.tokensOut).padStart(4)}`)
  return res
}

const SYS_DECIDER = `你是 bugfix 决策器，每次只输出 JSON。`
const SYS_CODER = `你是 coding 子 Agent。修复 add.ts 第 2 行减号错误，读取→编辑→验证→结束。`
const GOAL = `add.ts 应实现 a+b。复现：node add.ts 应输出 5。`

console.log(`\n=== bugfix 修复 1 行 bug 开销量化（${cfg.id}）===\n`)
console.log(`工作区: ${workspace}`)
console.log(`Bug 实际改动量: ${tok(code)} tokens → ${tok(fixed)} tokens（差额 ${tok('  return a - b') - tok('  return a + b') + tok('  return a - b')} tokens）\n`)

/* 1. 决策器评估 */
console.log(`[A] loop-runner 决策器评估状态`)
const wsListing = execSync(`ls -la ${workspace} && cat ${workspace}/add.ts`, { encoding: 'utf-8' })
const repro = execSync(`cd ${workspace} && node -e "const fs=require('fs'); eval(fs.readFileSync('add.ts','utf-8')); console.log('add(2,3)=', add(2,3))"`, { encoding: 'utf-8', shell: '/bin/bash' })
await llmCall('A1 决策器评估', SYS_DECIDER, [{ role: 'user', content: `${GOAL}\n\n工作区:\n${wsListing}\n\n复现:\n${repro}\n\n下一步?` }])

/* 2. 委派 @coding Agent（完整 ReAct）*/
console.log(`\n[B] 委派 @coding Agent（ReAct）`)
const coder: LlmMessage[] = [{ role: 'user', content: GOAL }]

const r1 = await llmCall('B1 读取 add.ts', SYS_CODER, coder)
coder.push({ role: 'assistant', content: r1.content })
coder.push({ role: 'user', content: `add.ts 内容:\n${code}` })

const r2 = await llmCall('B2 编辑（- 改 +）', SYS_CODER, coder)
coder.push({ role: 'assistant', content: r2.content })
writeFileSync(join(workspace, 'add.ts'), fixed)
coder.push({ role: 'user', content: `已写入新 add.ts` })

const r3 = await llmCall('B3 运行验证', SYS_CODER, coder)
coder.push({ role: 'assistant', content: r3.content })
const verify = execSync(`cd ${workspace} && node -e "const fs=require('fs'); eval(fs.readFileSync('add.ts','utf-8')); console.log('add(2,3)=', add(2,3))"`, { encoding: 'utf-8', shell: '/bin/bash' })
coder.push({ role: 'user', content: `验证结果: ${verify.trim()} === 5 ?` })

const r4 = await llmCall('B4 总结 task_complete', SYS_CODER, coder)

/* 3. 决策器再评估 */
console.log(`\n[C] loop-runner 决策器再评估（验证后）`)
await llmCall('C1 决策器收尾', SYS_DECIDER, [{ role: 'user', content: `${GOAL}\n\n最近验证输出:\n${verify}\n\n已达成?` }])

console.log(`\n=== 汇总 ===`)
console.log(`实际 LLM 消耗: in=${totalIn} + out=${totalOut} = ${totalIn + totalOut} tokens`)
console.log(`LLM 调用次数: ${callCount} 次`)
console.log(`\n对照:`)
console.log(`  Bug 真实信息量:  ${tok(code)} tokens（一个 30 字节的文件）`)
console.log(`  修复真实信息量:  ${tok(fixed)} tokens`)
console.log(`  实际开销:        ${totalIn + totalOut} tokens`)
console.log(`  开销 / 修复信息量 = ${((totalIn + totalOut) / Math.max(tok(fixed), 1)).toFixed(0)}x`)