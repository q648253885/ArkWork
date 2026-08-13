/* ============================================================
 * ArkWork — react-core-skills 阶段门禁识别（v0.16.x 新增）
 *
 * 背景：
 *   SKILL.md 写了「每阶段产出文档后必须 ask_user 门禁确认才进入下一阶段」，
 *   但此前这是纯 prompt 层约束，LLM 经常一次 reason 里既写 PRD 又开始编码。
 *
 *   本模块把门禁识别下沉到引擎层：识别 file-writer 写出的路径是否属于
 *   「阶段产物文档」，若是则：
 *     1) 推 task_progress 推进 currentStage（修复 ProgressPanel 阶段显示错位）
 *     2) 推 task_milestone 标记门禁到达
 *     3) 写 L1 observation + 抛 StopIteration 让 engine 在本 act 之后暂停任务
 *        并自动 ask_user（带 3 个标准门禁选项 + 用户主动放行兜底）
 *
 * 触发对象：仅当任务的 skillIds / agent.defaultSkillIds 含 react-core-skills 时。
 * ============================================================ */
import { dirname, join, relative } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'

/** react-core-skills 阶段定义（与 ProgressPanel.makeEmptyProgress 对齐） */
export type CoreStageId =
  | 'research'
  | 'prd'
  | 'interaction'
  | 'prototype'
  | 'system-design'

export interface StageGate {
  /** 阶段 id（与 ProgressPanel stages[].id 对齐） */
  stage: CoreStageId
  /** 阶段序号（research=0） */
  stageIndex: number
  /** 产物路径正则（绝对路径或相对路径，工作区根或 docs/ 子目录均命中） */
  pattern: RegExp
  /** 里程碑 id（与 ProgressPanel milestones[].id 对齐） */
  milestoneId: string
  /** 人类可读标签 */
  label: string
  /** 门禁问题文案（ask_user.question） */
  question: string
  /** 门禁建议选项 */
  suggestions: Array<{ label: string; description: string; recommended?: boolean }>
}

/** 文档驱动开发的门禁映射表（按阶段顺序） */
export const STAGE_GATES: StageGate[] = [
  {
    stage: 'research',
    stageIndex: 0,
    pattern: /(?:^|\/)00-opensource-research\.md$/i,
    milestoneId: 'research-done',
    label: '开源调研完成',
    question:
      '【阶段0 开源调研门禁】00-opensource-research.md 已产出。调研结论（直接使用 / 借鉴设计 / 确认自研）是否确认？',
    suggestions: [
      { label: '全部接受，继续', description: '认可调研结论，进入阶段1 PRD', recommended: true },
      { label: '补充调研', description: '再搜一轮关键词 / 加看 1~2 个开源项目' },
      { label: '推翻重来', description: '调研方向不对，重新确定技术路线' },
    ],
  },
  {
    stage: 'prd',
    stageIndex: 1,
    pattern: /(?:^|\/)01-prd\.md$/i,
    milestoneId: 'prd-frozen',
    label: 'PRD 已确认冻结',
    question:
      '【阶段1 PRD 门禁】01-prd.md 已产出。功能清单 P0/P1/P2 是否齐全？',
    suggestions: [
      { label: '全部接受，继续', description: 'PRD 已确认，进入阶段2 交互文档', recommended: true },
      { label: 'P0 减半', description: 'P0 保留核心，其余转 P1（说具体哪几项）' },
      { label: '加 P0 项', description: '再列几项必须做的（说具体）' },
    ],
  },
  {
    stage: 'interaction',
    stageIndex: 2,
    pattern: /(?:^|\/)02-interaction\.md$/i,
    milestoneId: 'interaction-done',
    label: '交互文档已确认',
    question:
      '【阶段2 交互文档门禁】02-interaction.md 已产出。交互流程 / 五态 / 设计 token 是否确认？',
    suggestions: [
      { label: '全部接受，继续', description: '进入阶段2.5 HTML 原型', recommended: true },
      { label: '调整交互', description: '改某页交互或跳转（说具体）' },
      { label: '合并到 PRD', description: '交互与 PRD 合一份精简文档，需确认' },
    ],
  },
  {
    stage: 'prototype',
    stageIndex: 3,
    pattern: /(?:^|\/)prototype\/.*\.html?$/i,
    milestoneId: 'prototype-frozen',
    label: 'HTML 原型已确认',
    question:
      '【阶段2.5 HTML 原型门禁】原型 index.html 已产出。视觉 / 五态 / 主流程是否冻结？',
    suggestions: [
      { label: '冻结，继续', description: '原型冻结为视觉基准，进入阶段3 系统设计', recommended: true },
      { label: '调整视觉', description: '改某页配色 / 字号 / 布局（说具体）' },
      { label: '加一页', description: '补漏掉的关键页面' },
    ],
  },
  {
    stage: 'system-design',
    stageIndex: 4,
    pattern: /(?:^|\/)03-system-design\.md$/i,
    milestoneId: 'design-frozen',
    label: '系统设计已确认',
    question:
      '【阶段3 系统设计门禁】03-system-design.md 已产出。技术选型 / 架构 / 数据模型 / 接口契约是否确认？',
    suggestions: [
      { label: '全部接受，开始编码', description: '系统设计冻结，进入阶段4 编码', recommended: true },
      { label: '改技术栈', description: '替换某项技术（说具体换什么）' },
      { label: '补接口', description: '补漏掉的接口契约' },
    ],
  },
]

/** 文件路径 → 命中的阶段门禁（取最高 stageIndex 防止单次写多文件匹配到低阶段） */
export function matchStageGate(relOrAbsPath: string): StageGate | undefined {
  if (!relOrAbsPath) return undefined
  // 归一化：把工作区绝对路径裁成相对路径
  const norm = relOrAbsPath.replace(/\\/g, '/')
  let hit: StageGate | undefined
  for (const g of STAGE_GATES) {
    if (g.pattern.test(norm)) {
      if (!hit || g.stageIndex > hit.stageIndex) hit = g
    }
  }
  return hit
}

/** 当前任务是否启用了 react-core-skills（决定是否要强制门禁） */
export function isCoreSkillsEnabled(task: { skillIds?: string[] } | undefined, agent: { defaultSkillIds?: string[] } | undefined): boolean {
  const ids = [...(task?.skillIds ?? []), ...(agent?.defaultSkillIds ?? [])]
  // v0.17.5： broaden 匹配——用户安装的技能可能叫"文档驱动开发"（中文名），
  // generateSkillId 会剥离中文字符导致 ID 变成 S-imported.skill，
  // /react.core.skills/i 匹配不到。这里同时匹配 ID 和名称中的关键词。
  return ids.some((id) =>
    /react.core.skills/i.test(id) ||
    /文档驱动|doc.?driven|structured.?dev/i.test(id)
  )
}

/**
 * 构造「门禁未确认 → 中止继续」observation 文案。
 * engine 在 act_end 后若检测到门禁，将这段 observation 写入 L1 并
 * 抛 StopIteration；本轮 reason 终止，下一轮 Reason 会先看到该 observation。
 */
export function buildGateBlockObservation(gate: StageGate): string {
  return (
    `[react-core-skills 阶段门禁] 检测到阶段产物 ${gate.label}（路径匹配）。` +
    `必须立即调用 ask_user 并附 2~4 个 suggestions 完成门禁确认；` +
    `未通过门禁前禁止进入下一阶段。当前阶段：${gate.stage}（${gate.stageIndex}）。` +
    `门禁问题已由引擎自动生成（question + suggestions 见主进程日志），请直接转发给用户。`
  )
}

/** 给 logger 用的简化标识 */
export function describeGateForLog(gate: StageGate): string {
  return `${gate.stage}#${gate.stageIndex}(${gate.milestoneId})`
}

/**
 * v0.16.x：路径归一化为相对工作区路径（用于 matchStageGate 比较）。
 * 若传的是绝对路径且在工作区下，裁掉前缀；否则原样返回。
 */
export function toRelPath(p: string, workspaceDir?: string): string {
  if (!p) return p
  if (workspaceDir && (p === workspaceDir || p.startsWith(workspaceDir + '/'))) {
    return p.slice(workspaceDir.length + 1)
  }
  return p
}

/** 把字符串安全的拼到 stage gate 用 join（防御 dirname 抛错） */
export function safeJoinDir(filePath: string): string {
  try {
    return dirname(filePath)
  } catch {
    return ''
  }
}

/* ============================================================
 * v0.17.x：阶段感知写入守卫（清单 ↔ 阶段 关联）
 *
 * 背景：此前门禁只在「写完阶段产物文档后」被动暂停，无法阻止 Agent 在
 * 调研阶段就越级搭建脚手架（mkdir src、写 package.json / index.html 等）。
 * opencode / Claude Code 的清单关联思路是：每个计划项绑定到某个阶段，
 * 当前阶段只允许执行该阶段对应的产物/工具，越级写入直接拦截。
 *
 * 本模块把「允许写什么」与「当前处于哪个阶段」绑定：
 *   - 保留路径（tasks.json / .arkwork / .git）任何阶段都禁止写入；
 *   - 脚手架/源码路径（src/、package.json、配置文件、入口文件、测试文件）
 *     仅当系统设计冻结（allowedStage >= 5）后才允许写入。
 * ============================================================ */

/** 编码阶段（系统设计冻结前）禁止写入的「脚手架 / 源码」路径特征 */
const SCAFFOLD_PATH_PATTERNS: RegExp[] = [
  /(?:^|\/)src(?:\/|$)/i,
  /(?:^|\/)package\.json$/i,
  /(?:^|\/)(tsconfig|jsconfig)\.json$/i,
  /(?:^|\/)(vite|webpack|rollup|esbuild|babel|next|nuxt|astro|vitest|playwright)\.config\.[a-z0-9]+$/i,
  /(?:^|\/)\.eslintrc(?:\.(?:js|cjs|mjs|json|yaml|yml))?$/i,
  /(?:^|\/)\.prettierrc(?:\.(?:js|cjs|mjs|json|yaml|yml))?$/i,
  /(?:^|\/)index\.html$/i,
  /(?:^|\/)(main|App|index)\.(tsx?|jsx?|vue)$/i,
  /\.(test|spec)\.(tsx?|jsx?|vue|js)$/i,
]

/** 脚手架初始化命令（npm/yarn/pnpm create|init、npx create-*、degit、git clone） */
const SCAFFOLD_INIT_RE =
  /(?:^|[\s;&|()])(?:npx|npm|yarn|pnpm)\s+(?:create|init)\b|(?:^|[\s;&|()])(?:npx\s+create-[a-z0-9-]+|degit\b|git\s+clone\b)/i

function normalizePathForGate(p: string): string {
  return (p ?? '').replace(/\\/g, '/')
}

/** 递归收集目录下所有文件（同步，返回相对 base 的 posix 相对路径） */
function listFilesSync(dir: string, base: string, out: string[]): void {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      listFilesSync(full, base, out)
    } else {
      out.push(relative(base, full).replace(/\\/g, '/'))
    }
  }
}

/**
 * 依据工作区里已产出的阶段文档，推导当前允许推进到的阶段边界（0~5）。
 * 返回值 = 「已通过的最高门禁」+1，即当前正在进行的阶段 index：
 *   0 = 开源调研（只能写 00-opensource-research.md）
 *   1 = PRD
 *   2 = 交互文档
 *   3 = HTML 原型
 *   4 = 系统设计
 *   5 = 编码（允许 src/、package.json 等脚手架）
 * 未启用 react-core-skills 的任务无需调用。
 */
export function computeAllowedStage(workspaceDir: string): number {
  const docsDir = join(workspaceDir, 'docs')
  if (!existsSync(docsDir)) return 0
  const rels: string[] = []
  listFilesSync(docsDir, workspaceDir, rels)
  let stage = 0
  for (const gate of STAGE_GATES) {
    if (rels.some((r) => gate.pattern.test(r))) {
      stage = Math.max(stage, gate.stageIndex + 1)
    }
  }
  return stage
}

export interface WriteGuardResult {
  blocked: boolean
  reason: string
}

function isReservedToken(token: string): boolean {
  const t = normalizePathForGate(token)
  return (
    /(?:^|\/)tasks\.json$/i.test(t) ||
    t.includes('.arkwork/') ||
    t.includes('.git/')
  )
}

/**
 * docs/ 是文档驱动开发的唯一产物区（调研/PRD/交互/原型/系统设计）。
 * 原型阶段要产出 docs/v1.0/prototype/index.html 等 HTML，这些是「设计稿」而非
 * 编码脚手架，任何阶段都必须放行，否则会误伤阶段二·五的原型 index.html。
 */
function isDocsArtifact(p: string): boolean {
  return /(?:^|\/)docs\//i.test(normalizePathForGate(p))
}

/**
 * 检查 file-writer / file-editor 的目标路径在当前阶段是否允许写入。
 *  - 保留路径（tasks.json / .arkwork / .git）任何阶段都禁止；
 *  - 脚手架路径仅在进入编码阶段（allowedStage >= 5）后允许。
 */
export function matchForbiddenWritePath(
  path: string,
  allowedStage: number,
): WriteGuardResult {
  const norm = normalizePathForGate(path)
  if (!norm) return { blocked: false, reason: '' }
  if (isReservedToken(norm)) {
    return {
      blocked: true,
      reason: `禁止写入 ArkWork 保留路径：${norm}（tasks.json / .arkwork / .git 由系统管理，请改用 docs/v*/ 存放清单与文档）`,
    }
  }
  // docs/ 产物区（含原型 index.html）任何阶段放行，不属于脚手架拦截范围
  if (isDocsArtifact(norm)) return { blocked: false, reason: '' }
  if (allowedStage < 5) {
    for (const re of SCAFFOLD_PATH_PATTERNS) {
      if (re.test(norm)) {
        return {
          blocked: true,
          reason: `阶段门禁：当前处于文档阶段（阶段 ${allowedStage}），禁止写入脚手架/源码 ${norm}。请先完成 调研→PRD→交互→原型→系统设计，待系统设计冻结后再进入编码。`,
        }
      }
    }
  }
  return { blocked: false, reason: '' }
}

/**
 * 检查 shell 命令在当前阶段是否允许执行。
 *  - 保留路径任何阶段禁止；
 *  - 脚手架初始化命令 / 脚手架路径仅在进入编码阶段后允许。
 */
export function matchForbiddenShellCommand(
  command: string,
  allowedStage: number,
): WriteGuardResult {
  const cmd = (command ?? '').trim()
  if (!cmd) return { blocked: false, reason: '' }
  if (allowedStage < 5 && SCAFFOLD_INIT_RE.test(cmd)) {
    return {
      blocked: true,
      reason: `阶段门禁：当前处于文档阶段（阶段 ${allowedStage}），禁止执行项目脚手架命令。请先完成 调研→PRD→交互→原型→系统设计。`,
    }
  }
  for (const raw of cmd.split(/[\s;&|()]+/).filter(Boolean)) {
    const token = normalizePathForGate(raw.replace(/^["']|["']$/g, '').replace(/,$/g, ''))
    if (!token || token.startsWith('-')) continue
    if (isReservedToken(token)) {
      return {
        blocked: true,
        reason: `禁止对 ArkWork 保留路径执行 shell 写操作：${token}（tasks.json / .arkwork / .git 由系统管理）`,
      }
    }
    if (isDocsArtifact(token)) continue
    if (allowedStage < 5) {
      for (const re of SCAFFOLD_PATH_PATTERNS) {
        if (re.test(token)) {
          return {
            blocked: true,
            reason: `阶段门禁：当前处于文档阶段（阶段 ${allowedStage}），禁止通过 shell 创建/写入脚手架路径 ${token}。`,
          }
        }
      }
    }
  }
  return { blocked: false, reason: '' }
}