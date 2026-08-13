/* ============================================================
 * ArkWork — chat/task 分流判定（v0.14.0 Task 2）
 * 引擎入口前置判定：决定本次输入走 chat（单次推理直回）
 * 还是 task（进入 ReAct 循环 + 任务清单）。
 *
 * 设计目标：
 *  - 纯本地关键词 + 长度启发式判定，无 LLM 调用
 *  - 单次判定延迟目标 ≤ 5ms（在大量短文本下）
 *  - 关键词表覆盖中英文常见编码/多步/追问场景
 *  - 上下文续问（再试一次 / 继续 / repeat again）沿用 lastTurnKind
 * ============================================================ */

export type RouteKind = 'chat' | 'task'

export interface RouteDecision {
  kind: RouteKind
  reason: string
  latencyMs: number
}

export interface ClassifyRouteContext {
  /** Composer 当前会话是否启用了工具（KB / MCP / Shell 等） */
  hasTools?: boolean
  /** 上一轮已判定的 route（用于追问场景沿用） */
  lastTurnKind?: RouteKind
}

/* ----------------------------------------------------------------
 * 关键词表（substring 匹配，小写比较）
 * ---------------------------------------------------------------- */

// 编码类强信号词 —— 命中即 task
const CODE_KEYWORDS_ZH = [
  '写代码', '写一段', '写一个', '写个', '编写', '实现', '重构', '新建项目', '新建工程',
  '初始化项目', '搭建项目', '搭一个', '帮我写', '帮我实现', '帮我做', '帮我重构',
  '加上', '添加', '新增', '删除', '移除', '修改', '改动', '改成', '替换', '重命名',
  '修复', '排查', '调试', 'debug', '单测', '单元测试', '写测试', '跑测试', '测试一下',
  '跑一下', '运行一下', '执行一下', '编译', '打包', '部署', '发布', '提 PR', '提交',
  '迁移', '升级', '降级', '回滚', '合并', 'merge', '分支', 'git', 'commit',
]
const CODE_KEYWORDS_EN = [
  'implement', 'refactor', 'rewrite', 'rebuild', 'reimplement', 'recreate',
  'create project', 'scaffold', 'init project', 'initialize project',
  'add a', 'add new', 'add the', 'remove a', 'remove the', 'delete the', 'rename',
  'fix the', 'fix this', 'debug', 'debug the', 'debug this', 'troubleshoot',
  'write a test', 'write tests', 'add tests', 'run tests', 'run the tests',
  'compile', 'build', 'deploy', 'ship', 'release', 'commit', 'push', 'merge',
  'migrate', 'upgrade', 'downgrade', 'rollback',
]

// 多步连接词（task 信号，配合任意动作动词）
const MULTI_STEP_CONNECTORS_ZH = ['然后', '再', '之后', '接着', '并且', '接着再', '随后', '紧接着']
const MULTI_STEP_CONNECTORS_EN = ['then', 'next', 'after that', 'and then', 'afterwards', 'subsequently']

// 任意动作动词（用于"连接词 + 动词"组合判定）
const ACTION_VERBS_ZH = [
  '写', '实现', '改', '修', '删', '加', '跑', '执行', '编译', '打包', '部署', '提交',
  '检查', '看', '读', '读取', '打开', '关闭', '创建', '建', '生成', '列出', '找',
  '搜索', '替换', '更新', '升级', '迁移', '运行', '调用', '测试', '验证', '确认',
]
const ACTION_VERBS_EN = [
  'write', 'implement', 'fix', 'delete', 'add', 'run', 'execute', 'build', 'deploy',
  'commit', 'push', 'check', 'read', 'open', 'close', 'create', 'make', 'generate',
  'list', 'find', 'search', 'replace', 'update', 'upgrade', 'migrate', 'test',
  'verify', 'confirm', 'call', 'invoke',
]

// 纯问答信号词（chat）
const QA_KEYWORDS_ZH = [
  '是什么', '为什么', '怎么样', '如何', '能不能', '会不会', '是否可以', '可否',
  '解释一下', '解释', '介绍一下', '介绍', '说明', '说一下', '讲讲', '聊聊',
  '什么是', '何为', '定义', '含义', '意思', '用途',
]
const QA_KEYWORDS_EN = [
  'what is', 'what are', 'why', 'how', 'can you', 'could you', 'is it', 'are there',
  'explain', 'describe', 'tell me about', 'define', 'meaning of', 'what does', 'whats',
]

// 追问 / 续说信号词（chat，沿用 lastTurnKind）
const FOLLOWUP_KEYWORDS_ZH = ['再试一次', '再来一次', '继续', '接着说', '说下去', '继续刚才', '还是']
const FOLLOWUP_KEYWORDS_EN = ['try again', 'repeat', 'repeat again', 'continue', 'go on', 'keep going', 'more', 'again']

/* ----------------------------------------------------------------
 * 兜底阈值
 * ---------------------------------------------------------------- */
const CHAT_LENGTH_LIMIT = 80 // 字符数（保留中文字符宽度）
const HARD_TASK_LENGTH_HINT = 60 // 长文本 + 无问答信号 → 倾向 task
const MAX_LATENCY_MS_TARGET = 5 // 平均延迟目标

/* ----------------------------------------------------------------
 * 工具函数
 * ---------------------------------------------------------------- */
function lowercase(s: string): string {
  return s.toLowerCase()
}

function containsAny(haystack: string, needles: readonly string[]): string | null {
  for (const n of needles) {
    if (haystack.indexOf(n) !== -1) return n
  }
  return null
}

/** 文本是否包含多步连接词，并且该连接词之后出现动作动词 */
function hasMultiStepPattern(text: string): { connector: string; verb: string } | null {
  const lc = lowercase(text)
  for (const c of [...MULTI_STEP_CONNECTORS_ZH, ...MULTI_STEP_CONNECTORS_EN]) {
    const idx = lc.indexOf(c.toLowerCase())
    if (idx === -1) continue
    const after = lc.slice(idx + c.length)
    // 动作动词可能在连接词前面也可能在后面；为兼容"先 A 再 B"结构，
    // 只要整段文本中出现动作动词即视为多步 task 信号
    const verb = containsAny(lc, ACTION_VERBS_ZH) ?? containsAny(lc, ACTION_VERBS_EN)
    if (verb) return { connector: c, verb }
    void after
  }
  return null
}

/* ----------------------------------------------------------------
 * 核心判定函数
 * ---------------------------------------------------------------- */
export function classifyRoute(input: string, ctx?: ClassifyRouteContext): RouteDecision {
  const start = performance.now()
  const raw = input ?? ''
  const text = raw.trim()
  const ctxHasTools = ctx?.hasTools === true
  const lastKind: RouteKind = ctx?.lastTurnKind ?? 'chat'

  // 0) 空输入 → chat（视作打招呼/确认）
  if (text.length === 0) {
    return finish('chat', 'empty input → chat', start)
  }

  const lc = lowercase(text)

  // 1) 追问 / 续说 → 沿用上一轮 kind
  const followup = containsAny(lc, FOLLOWUP_KEYWORDS_ZH) ?? containsAny(lc, FOLLOWUP_KEYWORDS_EN)
  if (followup) {
    return finish(lastKind, `followup keyword "${followup}" → reuse lastTurnKind`, start)
  }

  // 2) 编码词命中 → task
  const codeHit =
    containsAny(text, CODE_KEYWORDS_ZH) ??
    containsAny(lc, CODE_KEYWORDS_EN.map(lowercase))
  if (codeHit) {
    return finish('task', `code keyword "${codeHit}" → task`, start)
  }

  // 3) 多步连接词 + 动作动词 → task
  const multi = hasMultiStepPattern(text)
  if (multi) {
    return finish('task', `multi-step "${multi.connector}" + verb "${multi.verb}" → task`, start)
  }

  // 4) 纯问答词 + 短文本 → chat
  const qaHit =
    containsAny(text, QA_KEYWORDS_ZH) ??
    containsAny(lc, QA_KEYWORDS_EN.map(lowercase))
  if (qaHit && text.length <= CHAT_LENGTH_LIMIT) {
    return finish('chat', `QA keyword "${qaHit}" + short text → chat`, start)
  }

  // 5) 兜底规则：长度 ≤ 80 + 无动作词 + 上面规则都没命中 → chat；否则 → task
  const hasAction =
    containsAny(text, ACTION_VERBS_ZH) !== null ||
    containsAny(lc, ACTION_VERBS_EN.map(lowercase)) !== null
  if (text.length <= CHAT_LENGTH_LIMIT && !hasAction) {
    return finish('chat', `short text (≤${CHAT_LENGTH_LIMIT}) + no action verb → chat`, start)
  }

  // 6) 工具已挂载 + 中长文本 → 倾向 task
  if (ctxHasTools && text.length >= HARD_TASK_LENGTH_HINT) {
    return finish('task', `hasTools + text ≥ ${HARD_TASK_LENGTH_HINT} → task`, start)
  }

  // 7) 默认兜底：长文本 → task；否则 → chat
  if (text.length > CHAT_LENGTH_LIMIT) {
    return finish('task', `long text (>${CHAT_LENGTH_LIMIT}) → task`, start)
  }
  return finish('chat', `default fallback → chat`, start)
}

function finish(kind: RouteKind, reason: string, start: number): RouteDecision {
  const latencyMs = Number((performance.now() - start).toFixed(3))
  return { kind, reason, latencyMs }
}

export const CLASSIFY_ROUTE_META = {
  MAX_LATENCY_MS_TARGET,
  CHAT_LENGTH_LIMIT,
  HARD_TASK_LENGTH_HINT,
}