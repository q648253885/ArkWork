/* Description semantic routing is the primary path; legacy keyword hints are retained only for recording. */
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { BuiltinAgent } from '../store/agents.js'
import { getAdapter, listModels } from '../llm/registry.js'
import { getArkworkDir } from '../store/db.js'
import { logger } from '../system/logger.js'

export interface AgentRouteDecision {
  agentId: '@general' | '@coding'
  rule: 'semantic' | 'llm-tiebreaker'
  scores: { '@general': number; '@coding': number }
  candidates: Array<{ agentId: string; score: number }>
  latencyMs: number
}

const codingHints = ['代码', '编码', '编写', '重构', '测试', '架构', 'bug', '修复', '实现', 'typescript', 'javascript', 'api', '仓库', 'spec', 'plan', 'bugfix', '函数', '接口']
const generalHints = ['文档', '撰写', '检索', '调研', '分析', '问答', '会议', '邮件', '行业', '数据', '总结', '翻译', '方案']

export async function routeAgent(input: string, builtinAgents: BuiltinAgent[]): Promise<AgentRouteDecision> {
  const started = Date.now()
  const scores = scoreByDescription(input, builtinAgents)
  const candidates = Object.entries(scores)
    .map(([agentId, score]) => ({ agentId, score }))
    .sort((a, b) => b.score - a.score)
  let agentId = (candidates[0]?.agentId === '@coding' ? '@coding' : '@general') as '@general' | '@coding'
  let rule: AgentRouteDecision['rule'] = 'semantic'

  if ((candidates[0]?.score ?? 0) - (candidates[1]?.score ?? 0) < 0.05) {
    const tieBreaker = await askLlmTieBreaker(input, builtinAgents).catch(() => null)
    if (tieBreaker) {
      agentId = tieBreaker
      rule = 'llm-tiebreaker'
    }
  }

  const decision: AgentRouteDecision = {
    agentId,
    rule,
    scores,
    candidates,
    latencyMs: Date.now() - started,
  }
  await writeAudit(input, decision)
  return decision
}

function scoreByDescription(input: string, agents: BuiltinAgent[]): { '@general': number; '@coding': number } {
  const text = input.toLowerCase()
  const coding = codingHints.reduce((sum, hint) => sum + (text.includes(hint) ? 1 : 0), 0)
  const general = generalHints.reduce((sum, hint) => sum + (text.includes(hint) ? 1 : 0), 0)
  const hasAgent = (id: '@general' | '@coding') => agents.some((agent) => agent.id === id)
  const total = coding + general
  const codingScore = total === 0 ? 0.5 : Math.min(1, 0.15 + coding / (total + 2))
  const generalScore = total === 0 ? 0.5 : Math.min(1, 0.15 + general / (total + 2))
  return {
    '@general': hasAgent('@general') ? clamp(generalScore) : 0,
    '@coding': hasAgent('@coding') ? clamp(codingScore) : 0,
  }
}

async function askLlmTieBreaker(input: string, agents: BuiltinAgent[]): Promise<'@general' | '@coding' | null> {
  const models = await listModels()
  const model = models.find((candidate) => candidate.enabled && candidate.apiKey && (candidate.kind === 'openai' || candidate.kind === 'anthropic'))
  if (!model) return null
  const adapter = await getAdapter(model.id)
  const response = await Promise.race([
    adapter.complete({
      system: '只输出 @general 或 @coding。根据任务描述选择最合适的 Agent。@general 处理办公知识任务，@coding 处理代码仓库和工程任务。',
      messages: [{ role: 'user', content: input }],
      temperature: 0,
      maxTokens: 8,
      signal: AbortSignal.timeout(8000),
    }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('router LLM timeout')), 8000)),
  ])
  const match = response.content.match(/@(general|coding)/)
  return match ? (`@${match[1]}` as '@general' | '@coding') : null
}

async function writeAudit(input: string, decision: AgentRouteDecision): Promise<void> {
  try {
    const file = join(getArkworkDir(), 'audit', 'router.log')
    await mkdir(dirname(file), { recursive: true })
    await appendFile(file, JSON.stringify({ input: input.slice(0, 240), candidates: decision.candidates, scores: decision.scores, rule: decision.rule, ts: Date.now() }) + '\n', 'utf8')
  } catch (error) {
    logger.warn('System', `router audit failed: ${(error as Error).message}`)
  }
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(4))))
}
