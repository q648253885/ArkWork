/* ============================================================
 * ArkWork — CapabilityRegistry：统一能力注册表（v0.36.0 F2.1）
 * 设计文档：docs/versions/v0.36.0/04-system-design.md §3.1
 *
 * 职责：把 4 类能力来源（builtin/custom/market 技能 · MCP 工具 ·
 * 插件声明工具 · 插件控制工具）统一为**一张可订阅索引**；
 * `assembleTools` 退化为纯投影（messages.ts 只做请求构造与空集转换）。
 *
 * 三层拆分（对标 dsh/Cordis）：
 *   · def      —— 接口层（回给 LLM 的 schema，即 LlmTool）
 *   · invoke   —— provider 层（真执行；skill 条目委托 invokeSkill，
 *                 插件条目委托 callPluginTool，因此渐进式披露 /
 *                 MCP 路由 / 三段流水线**零改动**）
 *   · project  —— 消费端投影（按任务请求筛出本轮可见工具）
 *
 * 行为锁定（设计 §3.1「迁移策略」）：
 *   project() 输出与改造前 assembleTools **逐字节一致**（同名排序
 *   localeCompare、enabled 过滤、只加不减叠加），由 capability-registry
 *   测试的 golden 镜像组锁死；唯一的新增行为是 F2.2 的 profile mcp 汇入
 *   （单独用例组覆盖）。
 *
 * 失效同频（设计 §5 性能）：skill provider 的重扫由 invalidateSkillCache()
 * 驱动（agent/registry.ts 单点接线，既有调用点全部自动继承），与现
 * invalidateSkillCache 同频；插件声明 provider 数据源是内存索引，
 * 每次 sync 轻量重建（插件启停无统一失效钩子，不做 dirty 缓存就
 * 永远不会 stale —— D78/D79「接线缺失」同型风险的预防性取舍）。
 * ============================================================ */
import type { SkillContext, ToolRiskLevel } from '../agent/registry.js'
import type { Skill } from '@shared/types/agent'
import type { LlmTool } from '../llm/adapter.js'

/** invokeSkill / callPluginTool 的返回形状（设计伪码中的 ToolResult） */
export interface SkillInvocationResult {
  result: unknown
  summary: string
}

/** 单条能力登记（设计 §3.1 CapabilityEntry） */
export interface CapabilityEntry {
  /** 沿用现有 id 规则（builtin S-core.* / M-{ns}.{tool} / plugin__<id>__<name>） */
  id: string
  /** 近层遮蔽远层（沿用 Skill.layer） */
  layer: 'bundled' | 'user' | 'project' | 'runtime'
  source: 'builtin' | 'mcp' | 'custom' | 'market' | 'plugin'
  /** 插件三级作用域投影：project 层 = workspace，其余 = global */
  scope: 'global' | 'workspace'
  instructionMode: 'always-on' | 'on-demand' | 'hint-only'
  risk: ToolRiskLevel
  /** 能力定义（接口层）：回给 LLM 的 schema */
  def: LlmTool
  /** 实现（provider 层）：委托 invokeSkill / callPluginTool */
  invoke(args: Record<string, unknown>, ctx: SkillContext): Promise<SkillInvocationResult>
  enabled: boolean
  /**
   * 投影判定用的来源标识：
   *   `mcp:<serverId>` —— MCP 工具（server 级展开判定）
   *   `skill`          —— 技能（id 集合过滤）
   *   `plugin:<id>` / `plugin:control` —— 插件类（全量附加）
   * 注意与 upsert/revoke 的 provider 键（'skill' | 'plugin:declared' | 'plugin:control'）区分。
   */
  providerId: string
}

/** 投影请求（设计 §3.1 project(req)） */
export interface ProjectRequest {
  /** agent.defaultSkillIds */
  agentDefaultSkillIds: string[]
  /** task.skillIds（会话级叠加） */
  taskSkillIds: string[]
  /** 当前工作台快照 layers.tools 的技能/MCP 引用（found 才叠加 —— 只加不减） */
  profileToolRefs: Array<{ kind: 'skill' | 'mcp'; ref: string; found: boolean }>
  /** agent.defaultMcpIds ∪ task.mcpIds（server 级展开） */
  connectedMcpIds: string[]
}

/* ============================================================
 * CapabilityRegistry
 * ============================================================ */

const MCP_PROVIDER_PREFIX = 'mcp:'

export class CapabilityRegistry {
  private providers = new Map<string, CapabilityEntry[]>()
  private listeners = new Set<() => void>()

  /** 幂等覆盖：同 provider 键重复 upsert = 整体替换（对齐缓存重建语义） */
  upsert(entries: CapabilityEntry[], providerKey: string): void {
    this.providers.set(providerKey, [...entries])
  }

  /** 可逆撤销（对齐 effect 账本语义）：清空某 provider 的全部条目 */
  revoke(providerKey: string): void {
    this.providers.delete(providerKey)
  }

  /** 全量条目（投影 / 测试 / 诊断用） */
  list(): CapabilityEntry[] {
    const out: CapabilityEntry[] = []
    for (const list of this.providers.values()) out.push(...list)
    return out
  }

  get(id: string): CapabilityEntry | undefined {
    return this.list().find((e) => e.id === id)
  }

  /**
   * 纯投影 —— 输出与改造前 assembleTools 逐字节一致：
   *   ① skillIdSet = agent 默认 ∪ task 会话 ∪ profile found 引用（只加不减）
   *   ② MCP：providerId === `mcp:<serverId>` 命中 connectedMcpIds 即纳入
   *      （server 级展开；F2.2 另把 profile found 的 mcp ref —— 即 M-xxx
   *      工具 id —— 并进 skillIdSet，与本判定取并集）
   *   ③ enabled !== false 过滤
   *   ④ 插件类条目**全量附加**（不受技能 id 集合约束 —— 与改造前一致：
   *      declaredTools 已滤 disabled 插件，控制工具恒可用）
   *   ⑤ 最后统一按 function.name localeCompare 排序（LLM 缓存前缀确定性）
   */
  project(req: ProjectRequest): LlmTool[] {
    const skillIdSet = new Set<string>([...req.agentDefaultSkillIds, ...req.taskSkillIds])
    for (const t of req.profileToolRefs) {
      // F2.2：profile 的 skill / mcp 引用都叠加进 id 集（mcp ref tail = M-{ns}.{tool}）
      if (t.found) skillIdSet.add(t.ref)
    }
    const mcpServerIdSet = new Set(req.connectedMcpIds)

    const out: LlmTool[] = []
    for (const entry of this.list()) {
      if (entry.providerId.startsWith(MCP_PROVIDER_PREFIX)) {
        const serverId = entry.providerId.slice(MCP_PROVIDER_PREFIX.length)
        if (!mcpServerIdSet.has(serverId) && !skillIdSet.has(entry.id)) continue
        if (!entry.enabled) continue
        out.push(entry.def)
      } else if (entry.providerId === 'skill') {
        if (!skillIdSet.has(entry.id)) continue
        if (!entry.enabled) continue
        out.push(entry.def)
      } else {
        // plugin:declared / plugin:control → 全量附加
        out.push(entry.def)
      }
    }
    return out.sort((a, b) => a.function.name.localeCompare(b.function.name))
  }

  /** 订阅失效通知（MCP 连接/断开、技能落盘、插件启停）→ 返回退订函数 */
  subscribeInvalidated(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  /** 触发失效通知（markCapabilityDirty 内部调用；订阅者异常不阻断失效链路） */
  notifyInvalidated(): void {
    for (const fn of [...this.listeners]) {
      try {
        fn()
      } catch {
        // swallow
      }
    }
  }
}

/** 主进程单例（engine / sync 共用） */
export const capabilityRegistry = new CapabilityRegistry()

/* ============================================================
 * 惰性重扫（与 invalidateSkillCache 同频）
 * ============================================================ */

let skillCacheValid = false

/**
 * 失效 skill provider 的重扫标记（agent/registry.invalidateSkillCache 单点接线）。
 * 同时通知订阅者 —— MCP 连接断开、技能 CRUD、市场安装等全部既有调用点自动继承。
 */
export function markCapabilityDirty(source: 'skill' | 'plugin'): void {
  if (source === 'skill') skillCacheValid = false
  capabilityRegistry.notifyInvalidated()
}

/** 测试与启动引导用：重置为「未重扫」态 */
export function resetCapabilitySyncState(): void {
  skillCacheValid = false
}

/* ============================================================
 * 适配层：Skill / 插件工具 → CapabilityEntry（一次性适配，不大重写）
 * ============================================================ */

/**
 * Skill → CapabilityEntry。
 * def 与 agent/registry.skillToLlmTool 同规则（toolName 优先，slug 派生兜底），
 * 一致性由 capability-registry.test 的双源一致用例锁死。
 * invoke 动态委托 invokeSkill（运行时解析，模块求值期零循环依赖）。
 */
export function skillToCapabilityEntry(skill: Skill, risk: ToolRiskLevel): CapabilityEntry {
  const invoke = (args: Record<string, unknown>, ctx: SkillContext): Promise<SkillInvocationResult> =>
    import('../agent/registry.js').then((m) => m.invokeSkill(skill.id, args, ctx))
  return {
    id: skill.id,
    layer: skill.layer ?? 'user',
    source: skill.source,
    scope: skill.layer === 'project' ? 'workspace' : 'global',
    instructionMode: skill.instructionMode ?? 'on-demand',
    risk,
    def: {
      type: 'function',
      function: {
        name: skillToLlmToolName(skill),
        description: skill.description,
        parameters: skill.inputSchema ?? { type: 'object', properties: {} },
      },
    },
    invoke,
    enabled: skill.enabled !== false,
    providerId:
      skill.source === 'mcp' && skill.mcpRef
        ? `${MCP_PROVIDER_PREFIX}${skill.mcpRef.serverId}`
        : 'skill',
  }
}

/** 与 agent/registry.skillToolName 同规则（测试锁双源一致），避免投影反向静态依赖 registry */
function skillToLlmToolName(skill: Skill): string {
  if (skill.toolName) return skill.toolName
  const slug = skill.name
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
  if (slug) return slug
  const fromId = skill.id.replace(/^S-/, '').replace(/\./g, '-')
  return fromId || 'skill'
}

/** 插件声明工具 → CapabilityEntry（providerId = plugin:<id>；enabled 已由 declaredTools 过滤） */
export function pluginDeclaredToolToEntry(t: {
  pluginId: string
  description: string
  inputSchema: Record<string, unknown>
  globalName: string
}): CapabilityEntry {
  const pluginId = t.pluginId
  return {
    id: t.globalName,
    layer: 'runtime',
    source: 'plugin',
    scope: 'global',
    instructionMode: 'hint-only',
    risk: 'medium',
    def: {
      type: 'function',
      function: {
        name: t.globalName,
        description: `[插件 ${pluginId}] ${t.description}`,
        parameters: t.inputSchema,
      },
    },
    invoke: (args) =>
      import('../plugins/runtime/host-service.js').then((m) =>
        m.getPluginHostService()!.callPluginTool(t.globalName, args),
      ),
    enabled: true,
    providerId: `plugin:${pluginId}`,
  }
}

/**
 * 插件控制工具 → CapabilityEntry（宿主自有工具，恒可用）。
 * invoke 不在此执行：控制工具由引擎 act 阶段路由（act.ts isPluginControlTool 分支），
 * 与「插件自带工具走 entry.invoke」不同 —— 这里如实抛出路由说明，不假装可调。
 */
export function pluginControlToolToEntry(def: LlmTool): CapabilityEntry {
  return {
    id: def.function.name,
    layer: 'bundled',
    source: 'plugin',
    scope: 'global',
    instructionMode: 'hint-only',
    risk: 'workspace-readonly',
    def,
    invoke: () =>
      Promise.reject(
        new Error(
          'plugin-control-tool: 该工具由引擎 act 阶段路由执行（不经过 CapabilityEntry.invoke）',
        ),
      ),
    enabled: true,
    providerId: 'plugin:control',
  }
}

/* ============================================================
 * 同步：listSkills + 插件声明 → registry（assembleTools 每次调用前执行）
 * ============================================================ */

/**
 * 惰性重扫：skill provider 仅在失效后重建（listSkills 自带 workspace 缓存，
 * 重扫廉价）；plugin:declared 每次轻量重建（内存索引遍历）。
 *
 * provider 键恒为三个：'skill' / 'plugin:declared' / 'plugin:control'。
 */
export async function syncCapabilityRegistry(): Promise<void> {
  if (!skillCacheValid) {
    const { listSkills, assessToolRisk } = await import('../agent/registry.js')
    const skills = await listSkills()
    capabilityRegistry.upsert(
      skills.map((s) => skillToCapabilityEntry(s, assessToolRisk(s, {}).level)),
      'skill',
    )
    skillCacheValid = true
  }
  try {
    const { getPluginHostService } = await import('../plugins/runtime/host-service.js')
    const declared = getPluginHostService()?.declaredTools() ?? []
    capabilityRegistry.upsert(
      declared.map((t) => pluginDeclaredToolToEntry(t)),
      'plugin:declared',
    )
  } catch {
    // 插件运行时缺席（单测只跑 engine）→ 清空声明位，工具集退回无插件语义
    capabilityRegistry.revoke('plugin:declared')
  }
  try {
    const { PLUGIN_CONTROL_TOOLS } = await import('../agent/tools/plugins.js')
    capabilityRegistry.upsert(
      PLUGIN_CONTROL_TOOLS.map(pluginControlToolToEntry),
      'plugin:control',
    )
  } catch {
    capabilityRegistry.revoke('plugin:control')
  }
}
