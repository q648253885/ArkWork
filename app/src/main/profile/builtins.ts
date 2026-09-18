/* ============================================================
 * ArkWork — 内置 Workbench Profile（v0.32.0）
 * 设计文档：docs/versions/v0.32.0/04-system-design.md §2.8
 *           正本 `workbench-profile-v1.0/06-垂直工作台案例与首发路线.md` §2
 *
 * 三个内置台（首发顺序 D6：代码台验证机制 → 股票台验证组件 → 动画台旗舰）：
 *   · wb.base     通用工作台   —— 底座等价形态（零垂直差异）
 *   · wb.coding   代码开发台   —— **机制验证台**：激活后体验应与「裸 ArkWork 用
 *                                 @coder」完全一致，证明装配层零损耗
 *   · wb.research 研究工作台   —— 验证「技能白名单 + 命名空间隔离 + 首页模块」组合
 *
 * 硬纪律：manifest 只**引用**底座已存在的实体（技能 id 取 `main/store/seed.ts`
 * 的 `S-core.*`），绝不内联实现 —— 引用不存在的实体只会产生降级记录（可验证），
 * 不会让激活失败（非必需项）。
 *
 * 这里写字面量而非 .json 文件：内置台随底座发版，代码即真源；
 * 且同一份字面量要经过与用户导入完全相同的 `parseManifest` 校验路径，
 * 避免「内置走特殊通道、校验被绕过」。
 * ============================================================ */
import { parseManifest } from '@shared/utils/profile-manifest'
import type { WorkbenchProfile } from '@shared/types/profile'

/** 底座默认命名空间（v0.30.x 既有单空间记忆的归属） */
export const BASE_NAMESPACE = 'default'

const RAW_BUILTINS: Array<Record<string, unknown>> = [
  /* ---------- 通用工作台：底座等价形态 ---------- */
  {
    schemaVersion: '1.0',
    id: 'wb.base',
    name: '通用工作台',
    icon: 'Sparkle',
    version: '1.0.0',
    description: '底座默认形态：全部通用能力与原 ArkWork 一致，不做任何垂直定制。',
    author: 'local',
    agents: [
      {
        id: '@default',
        name: '通用助手',
        personaText: '你是 ArkWork 的通用助手，面向日常办公、调研、写作与分析任务。',
        defaultForNewTasks: true,
      },
    ],
    capabilities: [],
    ui: {},
    data: { memoryNamespace: BASE_NAMESPACE, shareCoreProfile: true },
    automation: [],
    requirements: { minBaseVersion: '0.31.0' },
  },

  /* ---------- 代码开发工作台：机制验证台 ---------- */
  {
    schemaVersion: '1.0',
    id: 'wb.coding',
    name: '代码开发工作台',
    icon: 'Terminal',
    version: '1.0.0',
    description: '面向代码开发：文档驱动开发技能包 + 文件/终端优先的面板布局 + 独立记忆域。',
    author: 'local',
    agents: [
      {
        id: '@coder',
        name: '代码工程师',
        personaText:
          '你是 ArkWork 的代码工程师，遵循「文档驱动开发」：先确认设计文档与接口契约，再动手写代码；改动前先读现有实现，禁止静默偏离已确认的设计。',
        skills: [
          'skill:S-core.spec',
          'skill:S-core.plan',
          'skill:S-core.bugfix',
          'skill:S-core.grep-search',
        ],
        defaultForNewTasks: true,
      },
    ],
    capabilities: [
      // 非必需：未安装时走部分激活 + 降级记录（这正是「不静默半死」的演示面）
      { type: 'skill', ref: 'skill:S-core.react-core-skills', required: false },
    ],
    ui: {
      dockTabs: ['files', 'terminal', 'todos', 'context', 'browser'],
      composerChips: ['继续任务', '修 bug', '写测试'],
    },
    data: { memoryNamespace: 'coding', shareCoreProfile: true },
    automation: [],
    requirements: { minBaseVersion: '0.31.0' },
  },

  /* ---------- 研究工作台 ---------- */
  {
    schemaVersion: '1.0',
    id: 'wb.research',
    name: '研究工作台',
    icon: 'Book',
    version: '1.0.0',
    description: '面向调研与写作：检索/抓取/知识库技能 + 知识库首页 + 独立记忆域。',
    author: 'local',
    agents: [
      {
        id: '@researcher',
        name: '研究员',
        personaText:
          '你是 ArkWork 的研究员，输出要求：结论先行、标注来源与置信度、无法证实的部分诚实列为未知区，绝不编造。',
        skills: ['skill:S-core.web-search', 'skill:S-core.fetch-url', 'skill:S-core.kb-search'],
        defaultForNewTasks: true,
      },
    ],
    capabilities: [{ type: 'skill', ref: 'skill:S-core.kb-search', required: false }],
    ui: {
      dockTabs: ['context', 'files', 'todos', 'browser'],
      homeModule: 'kb',
      composerChips: ['找资料', '写综述', '列未知区'],
    },
    data: { memoryNamespace: 'research', shareCoreProfile: true },
    automation: [],
    requirements: { minBaseVersion: '0.31.0' },
  },
]

/**
 * 内置 profile（已过 V1 结构校验）。
 * 内置台若结构非法属于编程错误 → **启动期抛错**，与插槽 id 重复同一纪律：
 * 宁可启动失败也不静默少一个台（有 `profile-manifest.test.ts` 在 CI 期把守）。
 */
export const BUILTIN_PROFILES: WorkbenchProfile[] = RAW_BUILTINS.map((raw) => {
  const { profile, issues } = parseManifest(raw, 'builtin')
  if (!profile) {
    const detail = issues.map((i) => `${i.rule} ${i.path}: ${i.message}`).join('; ')
    throw new Error(`[profile] 内置 manifest ${String(raw.id)} 结构非法：${detail}`)
  }
  return profile
})

export function getBuiltinProfile(id: string): WorkbenchProfile | null {
  return BUILTIN_PROFILES.find((p) => p.id === id) ?? null
}

/** 首次启动的兜底 profile（永远存在） */
export const DEFAULT_PROFILE_ID = 'wb.base'

/** 原始字面量（供测试直接对快照与字面量做一致性断言） */
export const RAW_BUILTIN_MANIFESTS = RAW_BUILTINS
