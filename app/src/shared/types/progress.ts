/* ============================================================
 * ArkWork — Shared Types: Task Progress Summary (Task 9)
 *
 * 任务侧边栏进度摘要数据模型（与 react-core-skills 场景 A 的
 * 阶段 0~8 一致；非文档驱动任务仍可自由使用 steps/milestones
 * 结构表达阶段性产物）。
 *
 * 进度在 Renderer store 内按 taskId 索引（独立于对话流）；
 * 通过 task:progress / task:step-complete / task:milestone
 * 三类事件从主进程回流。重要节点（如 PRD 已确认、原型已
 * 确认、编码完成）以 milestone 表示，到达后可点击跳转查看
 * 对应产物（artifactPath 通常位于用户指定 docs 目录）。
 * ============================================================ */

/** 步骤级状态（与 PlanItemStatus 解耦，独立表达摘要视图步骤状态） */
export type TaskProgressStepStatus = 'pending' | 'running' | 'completed' | 'failed'

/** 阶段级元信息（与 react-core-skills 场景 A 阶段 0~8 对齐的默认集合） */
export interface TaskProgressStage {
  /** 阶段 id（如 'prd' / 'prototype' / 'code'） */
  id: string
  /** 阶段展示名（如"PRD 编写""HTML 原型确认""编码""测试"） */
  label: string
  /** 阶段在总进度里的索引（从 0 起） */
  index: number
}

/** 摘要中的单个步骤（react-core-skills 必产文档或子步骤） */
export interface TaskProgressStep {
  id: string
  label: string
  status: TaskProgressStepStatus
  /** 步骤开始时间（status='running' 起） */
  startedAt?: number
  /** 步骤完成时间（status='completed' | 'failed' 时存在） */
  completedAt?: number
}

/** 里程碑节点（如"PRD 已确认冻结""HTML 原型已确认""编码完成""测试全绿"） */
export interface TaskProgressMilestone {
  id: string
  /** 展示文案 */
  label: string
  /** 到达时间（未到达时为 undefined） */
  reachedAt?: number
  /** 关联产物路径（到达后可点击跳转） */
  artifactPath?: string
  /** 里程碑描述（可选） */
  description?: string
}

/** 任务进度摘要主体（按 taskId 索引） */
export interface TaskProgress {
  taskId: string
  /** 当前阶段 id（如 'prd' / 'code'，与 TaskProgressStage.id 对齐） */
  currentStage: string
  /** 当前阶段名（冗余存储便于首屏直接渲染，不必遍历 stages） */
  currentStageLabel: string
  /** 当前阶段索引 */
  currentStageIndex: number
  /** 总阶段数 */
  totalStages: number
  /** 阶段列表（顺序固定；前端直接渲染阶段进度） */
  stages: TaskProgressStage[]
  /** 已完成的步骤列表（紧凑展示，最近完成项优先） */
  completedSteps: TaskProgressStep[]
  /** 下一步预览（pending | running 的第一项；空表示任务完成） */
  nextStep?: TaskProgressStep
  /** 里程碑节点（已到达的高亮，未到达的灰色） */
  milestones: TaskProgressMilestone[]
  /** 整体完成百分比（0~100） */
  overallPercentage: number
  /** 最近一次更新时间 */
  updatedAt: number
}

/** react-core-skills 场景 A 默认阶段（与 SKILL.md 阶段 0~8 一致） */
export const REACT_CORE_STAGES: TaskProgressStage[] = [
  { id: 'research', label: '开源调研', index: 0 },
  { id: 'prd', label: 'PRD 编写', index: 1 },
  { id: 'interaction', label: '交互文档', index: 2 },
  { id: 'prototype', label: 'HTML 原型', index: 3 },
  { id: 'system-design', label: '系统设计', index: 4 },
  { id: 'code', label: '编码', index: 5 },
  { id: 'test', label: '功能测试', index: 6 },
  { id: 'delivery', label: '部署交付', index: 7 },
  { id: 'ops', label: '运维沉淀', index: 8 },
]

/** react-core-skills 场景 A 默认里程碑（与 SKILL.md 各阶段产物对齐） */
export const REACT_CORE_MILESTONES: TaskProgressMilestone[] = [
  {
    id: 'prd-frozen',
    label: 'PRD 已确认冻结',
    description: '01-prd.md 已通过用户门禁',
  },
  {
    id: 'prototype-frozen',
    label: 'HTML 原型已确认',
    description: 'prototype/ 已通过用户冻结为视觉基准',
  },
  {
    id: 'design-frozen',
    label: '系统设计已确认',
    description: '03-system-design.md 已通过用户门禁',
  },
  {
    id: 'code-done',
    label: '编码完成',
    description: '编码阶段已通过冒烟测试',
  },
  {
    id: 'test-passed',
    label: '测试全绿',
    description: 'P0 用例全部通过 + 阻塞/严重清零',
  },
]

/** 初始空进度（任务首次进入时的占位态；UI 据此渲染空态） */
export function createEmptyProgress(taskId: string, stages: TaskProgressStage[] = REACT_CORE_STAGES): TaskProgress {
  return {
    taskId,
    currentStage: stages[0]?.id ?? '',
    currentStageLabel: stages[0]?.label ?? '准备中',
    currentStageIndex: 0,
    totalStages: stages.length,
    stages: [...stages],
    completedSteps: [],
    nextStep: undefined,
    milestones: REACT_CORE_MILESTONES.map((m) => ({ ...m })),
    overallPercentage: 0,
    updatedAt: Date.now(),
  }
}

/**
 * 计算整体完成百分比 — stages 总权重按均匀分布；
 * 当前阶段内的进度按 (completedStepsInStage / stepsInStage) 折算。
 * 简化口径：默认按 (currentStageIndex + stage内进度) / totalStages。
 */
export function computeOverallPercentage(
  currentStageIndex: number,
  totalStages: number,
  stageProgress: number, // 0~1
): number {
  if (totalStages <= 0) return 0
  const ratio = (currentStageIndex + Math.max(0, Math.min(1, stageProgress))) / totalStages
  return Math.round(ratio * 100)
}
