/**
 * ArkWork — Sync · S2 Drift（漂移检测）
 *
 * 依据：docs/versions/v0.30.0/04-system-design.md §6.1
 *       agent-design-v1.0/04-ReAct内核与任务协同.md §2.2-S2
 *
 * 解决的问题（设计稿 §02）：**F4 目标漂移** —— 模型从"改 auth 校验"
 * 慢慢滑到"顺手重构整个 middleware 层"，而没人发现。
 *
 * **一个必须记住的设计约束**：漂移检测**不能直接阻止** Agent。
 * 探索性工作天然会"偏离"当前任务的声明文件 —— 直接拦会把它变成一个
 * 笨拙的轨道机器人。它的作用是**把漂移变成显式事件**，触发 Replan 或
 * 人工确认，而不是默默跑偏。
 *
 * 三个信号（从便宜到昂贵，设计稿 §2.2-S2）：
 *  | 信号 | 方法 | 成本 |
 *  | 文件交集 | 本轮操作的文件 vs 节点 contextRefs 声明的文件 | 零（字符串比对） |
 *  | 符号交集 | 本轮读写的 symbol vs 节点声明 | 低 |
 *  | 语义相似度 | Action 描述 vs 节点 intent | 中（本版用词法重合度做代理） |
 *
 * **关于第三信号的本版取舍**：设计稿要求 embedding 余弦距离。本版**不引入
 * embedding**（零新依赖 + 每轮一次远程调用会显著增加延迟与成本），改为
 * **词法重合度**（中英混排的 token 交集）作为代理，并在返回值里标注
 * `semanticProxy: true`，以便埋点区分。若日后接入 embedding，只需替换
 * `computeLexicalOverlap` 的实现并翻转该标记。
 */
import type { TaskGraph, TaskNode } from '@shared/types/graph'

/** 单信号取值：0–1；`null` 表示该信号本轮不可用（会被排除并重新归一化权重） */
export type DriftSignal = number | null

export interface DriftSignals {
  /** 文件交集：本轮操作的文件有多少落在节点声明的 contextRefs 里 */
  file: DriftSignal
  /** 符号交集 */
  symbol: DriftSignal
  /** 语义相似度（本版为词法重合度代理） */
  semantic: DriftSignal
}

export interface DriftResult {
  /** 0–1，越高越一致 */
  score: number
  signals: DriftSignals
  /** 连续低分轮数（跨调用累积，由调用方传入并回写） */
  streak: number
  action: DriftAction
  /** 诊断说明（写日志/事件，给人看） */
  detail: string
  /** semantic 信号是否为代理实现（本版恒 true） */
  semanticProxy: boolean
}

export type DriftAction = 'none' | 'soft' | 'hard'

/** 阈值（设计稿 §2.2-S2） */
export const DRIFT_NORMAL = 0.7
export const DRIFT_SOFT = 0.4
/** 硬干预所需连续轮数 */
export const DRIFT_HARD_STREAK = 2

/** 本轮 Act 的观察输入 */
export interface DriftInput {
  /** 本轮所有动作的工具名 */
  toolNames: string[]
  /** 本轮动作读写到的文件（绝对或相对路径，调用方负责归一化） */
  files: string[]
  /** 本轮动作涉及到的符号（函数名/类名/导出名） */
  symbols: string[]
  /** 动作的自然语言描述（如 "执行命令：npm test"），用于第三信号 */
  descriptions: string[]
}

/** 各信号权重（可用信号集上的相对权重） */
const WEIGHTS: Record<keyof DriftSignals, number> = {
  file: 0.5,
  symbol: 0.25,
  semantic: 0.25,
}

/**
 * 计算漂移分数。
 *
 * @param graph      当前图（用于定位"当前任务"）
 * @param input      本轮 Act 的观察
 * @param prevStreak 上一轮的连续低分计数
 * @param nodeId     指定用哪个节点作为"当前任务"（缺省：in_progress → verifying → needs_human）
 */
export function computeDrift(
  graph: TaskGraph,
  input: DriftInput,
  prevStreak = 0,
  nodeId?: string,
): DriftResult {
  const focus = nodeId ? graph.nodes[nodeId] : pickFocus(graph)
  if (!focus) {
    return {
      score: 1,
      signals: { file: null, symbol: null, semantic: null },
      streak: 0,
      action: 'none',
      detail: '无进行中节点，跳过漂移检测',
      semanticProxy: true,
    }
  }

  // 本轮没有任何动作（纯文本回合）→ 不判定漂移，也不清 streak（避免"说一句话就洗白"）
  if (input.toolNames.length === 0 && input.files.length === 0 && input.symbols.length === 0) {
    return {
      score: 1,
      signals: { file: null, symbol: null, semantic: null },
      streak: prevStreak,
      action: 'none',
      detail: '本轮无工具调用，跳过漂移检测',
      semanticProxy: true,
    }
  }

  const declaredFiles = focus.contextRefs.filter((r) => r.kind === 'file').map((r) => r.ref)
  const declaredSymbols = focus.contextRefs.filter((r) => r.kind === 'symbol').map((r) => r.ref)

  const signals: DriftSignals = {
    file: intersectionRatio(input.files, declaredFiles),
    symbol: intersectionRatio(input.symbols, declaredSymbols),
    semantic: computeLexicalOverlap(
      input.descriptions.join(' '),
      [focus.intent, focus.description, focus.title].filter(Boolean).join(' '),
    ),
  }

  // 可用信号加权平均（null 的信号被排除并重新归一化权重）
  let weightSum = 0
  let acc = 0
  for (const key of Object.keys(WEIGHTS) as (keyof DriftSignals)[]) {
    const v = signals[key]
    if (v === null) continue
    weightSum += WEIGHTS[key]
    acc += WEIGHTS[key] * v
  }
  const score = weightSum > 0 ? acc / weightSum : 1

  const streak = score < DRIFT_SOFT ? prevStreak + 1 : 0
  let action: DriftAction = 'none'
  // 阈值语义（相对设计稿 §2.2-S2 的一处澄清）：
  //   score >= 0.7            → 正常
  //   score <  0.7            → 至少给一次软提示（0.4–0.7 是设计稿的软提示区间）
  //   score <  0.4 持续 2 轮   → 硬干预
  // ★ 为什么把 0.4 以下但未满 2 轮的也算 soft：设计稿只写了"持续 2 轮硬干预"，
  //   没说第 1 轮怎么办。若静默处理，第 1 轮的偏离信号会**完全丢失** ——
  //   而软提示的成本只是一行文本，收益是模型有机会自纠。
  //   （该取舍由 TC-SYNC-010 明确固化。）
  // ★ v0.30.2 D13：无声明不 hard —— 节点未声明任何可比对对象（file/symbol
  //   refs 全空）时唯一活信号是语义代理，其权重被归一化放大到 1.0，误报集中
  //   爆发（用户实测：调研任务 0.00 分连续 16 轮 hard）。hard 文案的
  //   「声明相关的文件：（未声明）」自证不成立 —— 判定漂移等于惩罚"声明不全"，
  //   与 intersectionRatio 的既有立场一致。降级 soft：漂移仍是显式信息，但不要求人工确认。
  const hasDeclaredRefs = declaredFiles.length > 0 || declaredSymbols.length > 0
  if (score < DRIFT_SOFT && streak >= DRIFT_HARD_STREAK && hasDeclaredRefs) action = 'hard'
  else if (score < DRIFT_NORMAL) action = 'soft'

  // 诊断说明：写日志 / 挂事件 / 给用户看，三处共用同一份文案，避免口径漂移
  const detail =
    action === 'none'
      ? `一致（${score.toFixed(2)}）`
      : action === 'soft'
        ? `轻度偏离 ${focus.key ?? focus.id}（${score.toFixed(2)}）：本轮动作与「${describeFocus(focus)}」关联较弱`
        : `持续偏离 ${focus.key ?? focus.id} 已 ${streak} 轮（${score.toFixed(2)}）：本轮动作与「${describeFocus(focus)}」几乎无交集`

  return { score, signals, streak, action, detail, semanticProxy: true }
}

/** 把漂移结果渲染成给模型的软提示（一行，不啰嗦） */
export function renderDriftHint(focus: TaskNode | undefined, result: DriftResult): string {
  if (result.action !== 'soft' || !focus) return ''
  return (
    `⚠ 注意：你本轮的动作与当前任务「${focus.key ?? focus.id} ${focus.title}」关联较弱（一致性 ${result.score.toFixed(2)}）。` +
    `如果这是完成它必须做的准备工作，请忽略此提示；如果不是，请先确认是否应该调整计划（replan）。`
  )
}

/**
 * v0.30.2 D13-F：剥离 v0.29 → v0.30 迁移期写进 intent 的机器前缀
 * （「迁移自 v0.29 清单项：<原文>」）。存量已迁移图无法重写数据，
 * 在渲染与语义取词层统一自愈；新迁移已不再产生该前缀（migrate.ts）。
 */
export function cleanIntent(intent: string | undefined, fallbackTitle: string): string {
  if (!intent) return fallbackTitle
  return intent.replace(/^迁移自 v[\w.]+ 清单项：/, '') || fallbackTitle
}

/** 把漂移结果渲染成硬干预文本（要求人确认或 Replan） */
export function renderDriftHardBlock(focus: TaskNode | undefined, result: DriftResult): string {
  if (!focus) return ''
  return (
    `偏离点：正在做的「${focus.key ?? focus.id} ${focus.title}」${focus.intent ? `（目的：${cleanIntent(focus.intent, focus.title)}）` : ''}\n` +
    `  · 声明相关的文件：${focus.contextRefs.filter((r) => r.kind === 'file').map((r) => r.ref).join(', ') || '（未声明）'}\n` +
    `  · 实际一致性分数：${result.score.toFixed(2)}（连续 ${result.streak} 轮低于 ${DRIFT_SOFT}）`
  )
}

/* ============================================================
 * 内部：信号计算
 * ============================================================ */

/**
 * 交集比例。
 *
 * 返回 `null`（信号不可用）的两种情况：
 *  - 本轮没有操作任何该类对象（无信息，不能算作"偏离"）
 *  - 当前节点没有声明该类引用（无法比对 —— 这是**节点的信息缺失**，
 *    判定漂移等于惩罚"声明不全"，不公平）
 */
function intersectionRatio(actual: string[], declared: string[]): DriftSignal {
  if (actual.length === 0 || declared.length === 0) return null
  const declaredSet = new Set(declared.map(normalizeRef))
  let hit = 0
  for (const a of actual) {
    if (declaredSet.has(normalizeRef(a))) hit += 1
  }
  return hit / actual.length
}

/** 路径归一化：统一分隔符、去掉尾部斜杠、转小写（macOS 大小写不敏感） */
function normalizeRef(ref: string): string {
  return ref.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * 词法重合度（语义相似度的**代理实现**，见文件头说明）。
 *
 * 做法：把两段文本切成 token（英文按单词、中文按 2-gram），
 * 计算 `|A ∩ B| / |A|` —— 即"本轮动作的描述有多少词是任务意图里出现过的"。
 * 不对称是有意的：动作描述里出现新词（比如"顺便重构 router"）才是漂移信号，
 * 而任务意图里有额外词（未提及的细节）不算漂移。
 *
 * 两段文本任一为空时返回 `null`（信号不可用）。
 *
 * ★ **阈值标定（PROXY_CALIBRATION）—— 这是一个必须解释的工程取舍**：
 *   设计稿的 0.7 / 0.4 是给 **embedding 余弦相似度** 标定的。余弦在不同文本长度上
 *   都很稳；而**词法重合度对短文本天然偏低**（中文 2-gram 会把"测试用意图"切成
 *   测试/试用/用意/意图 四个，动作描述里只要多两个新词，重合度就掉到 0.5）。
 *   直接把 0.7 套到代理上会产生**系统性误报** —— 后果是用户学会无视漂移提示，
 *   这正是我在 converge 里刻意避免的失效模式（噪音化）。
 *
 *   做法：把原始重合度**归一化**后再套用同一组阈值。标定值 0.6 的含义是
 *   "词法重合度到 0.6 就已经算明确切题"（技术文本里这个值相当高）。
 *   接入真实 embedding 时，只需把标定值改回 1.0 并翻转 `semanticProxy` 标记。
 */
const PROXY_CALIBRATION = 0.6

function computeLexicalOverlap(actionText: string, intentText: string): DriftSignal {
  const a = tokenize(actionText)
  const b = tokenize(intentText)
  if (a.size === 0 || b.size === 0) return null
  let hit = 0
  for (const t of a) if (b.has(t)) hit += 1
  const raw = hit / a.size
  return Math.min(1, raw / PROXY_CALIBRATION)
}

/** 中英混排分词：英文单词（≥3 字符）+ 中文 2-gram；过滤停用词 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'then', 'than', '执行', '命令',
  '文件', '读取', '写入', '检查', '运行', '使用', '进行', '当前', '一个', '这个',
])

function tokenize(text: string): Set<string> {
  const out = new Set<string>()
  if (!text) return out
  const lower = text.toLowerCase()
  // 英文/数字词
  for (const m of lower.matchAll(/[a-z0-9_.]{3,}/g)) {
    const t = m[0]
    if (!STOPWORDS.has(t)) out.add(t)
  }
  // 中文 2-gram
  const cjk = lower.replace(/[^\u4e00-\u9fa5]/g, ' ')
  for (const seg of cjk.split(/\s+/)) {
    for (let i = 0; i + 2 <= seg.length; i++) {
      const g = seg.slice(i, i + 2)
      if (!STOPWORDS.has(g)) out.add(g)
    }
  }
  return out
}

/** 选出"当前任务" */
function pickFocus(graph: TaskGraph): TaskNode | undefined {
  const nodes = Object.values(graph.nodes)
  return (
    nodes.find((n) => n.status === 'needs_human') ??
    nodes.find((n) => n.status === 'verifying') ??
    nodes.find((n) => n.status === 'in_progress')
  )
}

function describeFocus(node: TaskNode): string {
  // v0.30.2 D13-F：语义信号取词同样剥离迁移机器前缀（前缀 token 对重合度是纯噪音）
  return cleanIntent(node.intent, node.title)
}
