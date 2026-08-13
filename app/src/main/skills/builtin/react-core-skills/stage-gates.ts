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
import { dirname } from 'node:path'

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
  return ids.some((id) => /react.core.skills/i.test(id))
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