/* ============================================================
 * ArkWork — Shared Types: Memory
 * 设计文档 §9.3
 * ============================================================ */

/** v0.7.0：+ L4 经验记忆层 */
export type MemoryLayer = 'L1' | 'L2' | 'L3' | 'L4'
export type MemoryRole = 'system' | 'user' | 'assistant' | 'tool'
export type MemoryKind =
  | 'reasoning'
  | 'action'
  | 'observation'
  | 'summary'
  | 'file_ref'
  | 'kb_hit'
  | 'compressed_summary'
  | 'system_prompt'
  | 'user_message'
  | 'plan'                    // polish4 §B1：ReAct 计划清单（assistant 输出）
  | 'plan_status'             // v0.17.6：引擎独立判断后的清单状态（结构化注入每轮推理）
  | 'skill_instruction'       // v0.25.0 F1：on-demand 技能指令体（invokeSkill 后持续生效至任务结束；与 plan_status 同管道复用归档/压缩）
  // v0.7.0 新增：记忆→技能/智能体转化管线相关 kind
  | 'curated_fact'           // 被蒸馏进 L3 的事实
  | 'profile_observation'    // 被识别为画像观察的片段
  | 'distilled_skill_ref'    // 指向蒸馏产出的技能
  | 'artifact_ref'           // 指向 L2 产物（与预览浮窗联动）

export interface MemoryItem {
  id: string
  taskId: string
  layer: MemoryLayer
  role: MemoryRole
  kind: MemoryKind
  content: string
  /** 是否进入下一轮推理上下文（核心字段，"上下文可选择"） */
  enabled: boolean
  iteration: number              // -1 for system/global
  tokens: number
  meta?: string
  raw?: unknown
  createdAt: number
  archivedAt: number | null
  replaces?: string[]
  /** v0.7.0：蒸馏标记 — 这条记忆流向了哪里（诚实 UI）
   *  v0.8.0：target 新增 'kb'（记忆转化管线可把 L3/L4 条目沉淀进知识库） */
  distilled?: { target: 'l3_fact' | 'skill' | 'profile' | 'kb'; targetId: string }
}

/* ============================================================
 * v0.7.0 — L3 策展记忆 / L4 用户画像 / 蒸馏草稿 类型
 * ============================================================ */

/** L3a 策展记忆文件 */
export interface CuratedMemoryFile {
  path: 'memory.md' | 'user.md'
  budgetChars: number
}

/** L3a 待生效条目（暂存区） */
export interface PendingEntry {
  id: string
  targetFile: 'memory.md' | 'user.md'
  line: string
  sourceTaskId?: string
  createdAt: number
}

/** L3b 档案检索命中 */
export interface ArchiveHit {
  itemId: string
  taskId: string
  taskTitle: string
  snippet: string
  rank: number
  createdAt: number
}

/** L4a 用户画像 */
export interface UserProfile {
  version: number
  synthesis: string
  traits: ProfileTrait[]
  observations: ProfileObservation[]
  history: Array<{ version: number; snapshot: string; archivedAt: number }>
}

export interface ProfileTrait {
  key: string
  value: string
  confidence: number
  since: string
}

export interface ProfileObservation {
  id: string
  text: string
  sourceTaskId: string
  createdAt: number
  merged: boolean
}

/** v0.7.0 F705：蒸馏草稿 */
export interface DistillDraft {
  kind: 'facts' | 'skill' | 'observations'
  facts?: string[]
  skillMd?: string
  observations?: string[]
  triggerReason: string
}

/* ============================================================
 * v0.8.0 — L3a 策展快照 / 记忆转化（IPC 共用类型）
 * ============================================================ */

/** L3a 策展快照（run 启动注入与面板展示共用） */
export interface CuratedSnapshot {
  memoryMd: string
  userMd: string
  memoryChars: number
  userChars: number
  memoryBudget: number
  userBudget: number
}

/** 记忆转化源——手动转化 L3/L4 条目为技能/知识库 */
export interface ConvertSource {
  kind: 'l1' | 'l3a' | 'l3b' | 'l4'
  l1ItemId?: string
  taskId?: string
  content: string
}

/** 转化为技能的结果 */
export interface ConvertToSkillResult {
  skillId: string
  skillName: string
}

/** 转化为知识库条目的结果 */
export interface ConvertToKbResult {
  kbFileId: string
  filePath: string
}

export interface MemoryTogglePatch {
  id: string
  enabled: boolean
}

export interface MemoryEditPatch {
  id: string
  content: string
}

export interface CompressPolicy {
  keepSystem: boolean
  keepRecentTurns: number       // 保留最近 N 轮 Reason/Act/Obs
  keepUserTurns: boolean
  keepFileRefs: boolean
  dropFailed: boolean
}

export interface CompressOpts {
  taskId: string
  policy: CompressPolicy
  compressionModelId?: string
  instructions?: string
}

export interface CompressResult {
  beforeTokens: number
  afterTokens: number
  summaryId: string
  archivedIds: string[]
}

/* ============================================================
 * v0.14.0 Task 12 — Context Compaction（显式压缩阶段）类型
 * ============================================================ */

/**
 * L1 快照 — compact() 的输入，由 Phase 0 钩子（compaction-hook）从 l1-working 组装。
 * 压缩时保留最近 N 轮原文 + 历史摘要 + 关键实体清单，旧条目归档。
 */
export interface L1Snapshot {
  taskId: string
  /** 参与计量/压缩的 L1 条目（按 createdAt 升序，enabled 且未归档） */
  items: MemoryItem[]
  /** 当前 token 预算（达到 80% 触发压缩前预警） */
  budgetTokens: number
  /** 快照创建时间 */
  createdAt: number
}

/* ============================================================
 * v0.16 Task 7 — L2 压缩记忆（紧凑 UI + 去重/摘要/分片）
 * 原始 L2 产物文件经去重 + 摘要后的紧凑形态：
 *  - 上下文注入使用 compressedContent（token 数显著低于原始）
 *  - 原始内容保留在 rawContent / references（详情查看用，不注入）
 * ============================================================ */

/** L2 压缩记忆条目 */
export interface L2Memory {
  id: string
  /** 一行摘要（紧凑列表展示用） */
  summary: string
  /** 提取的关键实体（相似度检测与分片检索共用） */
  entities: string[]
  /** 意图/类别标签（如 'error-recovery' / 'config' / 'artifact'） */
  intent: string
  /** 压缩后内容（上下文注入时使用） */
  compressedContent: string
  /** 压缩后 token 数（上下文占比计量用） */
  compressedTokens: number
  createdAt: number
  updatedAt: number
  /** 合并的来源条目 id 列表（去重合并时累积） */
  references: string[]
  /** 原始内容（详情查看用，不注入上下文；可空，按需从产物文件读取） */
  rawContent?: string
}
