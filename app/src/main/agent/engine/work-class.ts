/* ============================================================
 * ArkWork — 本 run 工作性质分类（v0.38.0 / D150）
 * 设计文档：docs/versions/v0.38.0/04-system-design.md §6.1 / §4.2
 *
 * 为什么要有这个文件：
 *   完成门禁此前的判据是 `startIter > 0 && !isReplyContinuation && graphId`
 *   —— 三个条件全是**代理变量**（"用户是否又说话了"），没有一处读用户输入内容，
 *   于是"这个工作区是什么"这类纯只读提问被判为"新指令型续聊"，连续三轮被拦（D150）。
 *
 *   本模块提供**客观事实**：本 run 实际调用过哪些工具 → 是否发生了实质工作。
 *   模型无法说谎（事实由引擎统计），也不会被门禁诱导产假动作。
 *
 * 硬规则：
 *   · 叶子模块 —— 无 import（除 type），不得依赖 engine 内部（避免循环依赖）。
 *   · **只读白名单**而非写入黑名单：未登记的工具（MCP / 市场技能 / 未来新增）
 *     一律落到保守侧（视为有副作用）—— FR8.2。
 * ============================================================ */

/**
 * 只读工具白名单 —— **唯一事实源**（工程纪律⑧：导出常量 + 守卫，全仓只调守卫）。
 *
 * 语义：调用**不产生任何持久副作用**。
 * 与 `registry.ts` 的 `ToolRiskLevel` 对齐：命中项对应
 * `workspace-readonly` / `external-readonly` 两档。
 *
 * 为什么不把 MCP / 市场技能列进来：它们的副作用不可静态判定 → 保守处理。
 */
export const READONLY_TOOLS = [
  'file-reader',
  'glob-search',
  'grep-search',
  'web-search',
  'fetch-url',
  'session-search',
  'kb-search',
] as const

/* v0.39.0（W15）：删除零引用类型别名 `ReadonlyTool` —— 判定一律走守卫
 * `isReadonlyTool()`（纪律⑧：白名单只许一个事实源，类型别名会诱使调用方自建集合）。 */

const READONLY_SET: ReadonlySet<string> = new Set(READONLY_TOOLS)

/**
 * 控制动作：既不构成"实质工作"，也不构成"清单触碰"。
 * `turn_note` 是输出动作（只是说话），`task_complete` / `ask_user` 是终局控制。
 */
export const CONTROL_TOOLS = ['task_complete', 'ask_user', 'turn_note'] as const

/**
 * 清单的**唯一写入口** —— 真正落账本的工具（v0.38.0 / D154 控制面收敛）。
 *
 * ⚠️ 门禁的「本 run 是否同步过清单」**只能**用它判定（J1：判据必须观察实际发生的事）。
 * 历史工具名（见 `RETIRED_PLAN_TOOLS`）已下架，`act.ts` 的兜底分支在 `invokeSkill`
 * **之前**就 return —— 清单**没有被写过**。若把历史名也算作"触碰过树"，那么
 * "干了实质工作 + 清单陈旧"就会被**静默放行**（门禁形同虚设 → 续聊重做第一个任务）。
 * （设计文档 04-system-design §4.2：`TREE_TOUCH_TOOLS` 收敛为 `{'task_plan'}`。）
 * 不得在调用点自行展开本数组：那会引入第二份判断（纪律⑧）。
 */
export const PLAN_WRITE_TOOLS = ['task_plan'] as const

/**
 * v0.38.0（D154）**下架的清单工具名** —— 唯一事实源。
 * `engine/act.ts` 的废弃兜底分支只许引用本表（纪律⑧：白名单只许一个事实源），
 * 不得再写内联 if 链 —— 内联链在实现时漏掉了 `task_update` / `task_get` / `task_list`，
 * 模型调这三个名字会掉进 registry 的 `No handler` 静默路径。
 *
 * 集合来源：设计文档 04-system-design §4.2 下架清单（task_create / task_update /
 * replan / todo_update / submit_plan / request_plan / task_block / task_get /
 * task_list 共 9 个）+ `todo-update` 连字符历史拼写（seed 技能 id 形态）。
 */
export const RETIRED_PLAN_TOOLS = [
  'task_create',
  'task_update',
  'task_get',
  'task_list',
  'task_block',
  'request_plan',
  'submit_plan',
  'replan',
  'todo_update',
  'todo-update',
] as const

/**
 * **全部清单族工具名** = 唯一写入口 ∪ 历史名。
 * 用途只有一处：`classifyRunWork` —— 清单操作改的是"计划"而不是"文件"，不构成实质工作。
 * （历史名也计入：一次被兜底拒掉的旧名调用同样没干活，不应被判成 mutating。）
 *
 * ⚠️ 与 `PLAN_WRITE_TOOLS` 是**两个不同概念**，不要合并（同 `registry.ts` 的
 * `READONLY_BUILTINS` vs 本文件 `READONLY_TOOLS` 的取舍）：本表答"是不是清单操作"，
 * `PLAN_WRITE_TOOLS` 答"是不是真的写了账本"。`act.ts` 的引擎判定要前者
 * （旧名软失败时引擎不得顺手改清单），门禁 / 陈旧提醒要后者。
 */
export const PLAN_TOOLS = [...PLAN_WRITE_TOOLS, ...RETIRED_PLAN_TOOLS] as const

const NON_WORK_SET: ReadonlySet<string> = new Set<string>([...CONTROL_TOOLS, ...PLAN_TOOLS])
const PLAN_SET: ReadonlySet<string> = new Set<string>(PLAN_TOOLS)
const PLAN_WRITE_SET: ReadonlySet<string> = new Set<string>(PLAN_WRITE_TOOLS)
const RETIRED_PLAN_SET: ReadonlySet<string> = new Set<string>(RETIRED_PLAN_TOOLS)

/**
 * 工具是否只读（**唯一守卫** —— 全仓只许调本函数，纪律⑧）。
 * 未登记 → false（有副作用，保守）。
 */
export function isReadonlyTool(name: string): boolean {
  return READONLY_SET.has(name)
}

/**
 * 工具是否是**清单族**（含已下架的历史名）。
 *
 * 消费方：`act.ts` 的「无图任务引擎判定」—— 模型自己管清单时引擎不得代劳。
 * 不得在调用点自行 `PLAN_TOOLS.includes()`：那会引入第二份判断（纪律⑧）。
 */
export function isPlanTool(name: string): boolean {
  return PLAN_SET.has(name)
}

/**
 * 工具是否**真正写账本**（唯一写入口 `task_plan`）。
 *
 * 消费方：`plan-tree-sync.touchesPlanTree`（陈旧提醒计数 + 完成门禁的「零写树」客观事实源）、
 * `loop.ts` 的阶段结论节流（"本轮提交过计划"才算有输出）。
 * 不得在调用点自行展开 `PLAN_WRITE_TOOLS`：那会引入第二份判断（纪律⑧）。
 */
export function isPlanWriteTool(name: string): boolean {
  return PLAN_WRITE_SET.has(name)
}

/**
 * 工具名是否**已在 v0.38.0 下架**（唯一守卫）。
 *
 * 消费方：`engine/act.ts` 的废弃兜底分支 —— 命中即返回"请改用 task_plan"的
 * 可执行 observation（而不是掉进 registry 的 `No handler` 静默路径，纪律⑨）。
 */
export function isRetiredPlanTool(name: string): boolean {
  return RETIRED_PLAN_SET.has(name)
}

/* ============================================================
 * v0.38.0（D159）：工具名形态归一化 —— 模型输出是不可信输入。
 *
 * 实机证据（2026-09-25 22:33 现场）：模型偶发把引擎自有下划线名写成连字符
 * （调 `task-plan` 而不是 `task_plan`）。未归一时的连锁反应：
 *   act 拦截分支不认（`action.tool === 'task_plan'` 精确匹配）→ 掉进 registry
 *   的开发者向报错 → `classifyRunWork(['task-plan'])` 因名字不在任何白名单
 *   而判 `mutating` → 完成门禁误拦（同一问题连续三轮被拒）。
 *
 * 设计约束：
 *   · **派生而非手维护**：别名表从 ENGINE_KNOWN_NAMES（只读 ∪ 控制 ∪ 清单族）
 *     系统性推导"下划线 ↔ 连字符"双向变体 —— 新增引擎工具名自动获得形态
 *     容错，不会重演"内联 if 链漏名字"（D154 前车之鉴）。
 *   · 只对"未知名的已知孪生"归一：MCP / 市场技能等未登记名一律原样透传。
 *   · 双向同形名（如 `todo_update` / `todo-update` 双双在册）不需要别名。
 *   · 归一化必须发生在**唯一摄取点**（v0.44.1 D219 起为 reason-phase.ts 的
 *     响应落定处 —— step 落盘/广播之前；loop.ts 保留幂等防线），
 *     任何分支 / 预算统计 / toolsThisRun 收集之前 —— 否则会出现 D157 的
 *     镜像缺陷（账本实际写了、判据认为没写）。
 * ============================================================ */

/** 引擎已知工具名全集（归一化的事实源）：只读 ∪ 控制 ∪ 清单族。 */
const ENGINE_KNOWN_NAMES: ReadonlySet<string> = new Set<string>([
  ...READONLY_TOOLS,
  ...CONTROL_TOOLS,
  ...PLAN_TOOLS,
])

/** 形态别名表：别名键（模型可能输出的孪生形态）→ 引擎正名。派生，勿手改。 */
const TOOL_NAME_ALIASES: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>()
  for (const name of ENGINE_KNOWN_NAMES) {
    if (!name.includes('_') && !name.includes('-')) continue
    const twin = name.includes('_') ? name.replace(/_/g, '-') : name.replace(/-/g, '_')
    if (!ENGINE_KNOWN_NAMES.has(twin)) m.set(twin, name)
  }
  return m
})()

/**
 * 工具名归一化（唯一守卫）。
 * 已知名的孪生拼写 → 正名；其余（含 MCP / 市场技能 / 未知名）原样返回。
 */
export function normalizeToolName(name: string): string {
  return TOOL_NAME_ALIASES.get(name) ?? name
}

/**
 * 就地归一化一次 Reason 响应里的全部工具名。
 *
 * v0.44.1（D219）：主调用点在 **reason-phase.ts**（响应落定后、reason step
 * 落盘/广播/L1 meta 之前）—— 否则孪生拼写会原样进 steps.jsonl / 事件，
 * 渲染层用正名精确匹配落空，最终答复整条不渲染。loop.ts 的调用保留为
 * 幂等防线。任何消费（控制分支 / collectActionsForIteration / toolsThisRun
 * 收集 / 预算统计）都必须发生在本调用之后。
 */
export function normalizeResponseToolNames(response: {
  action?: { tool: string } | null
  actions?: ReadonlyArray<{ tool: string }> | null
}): void {
  if (response.action) (response.action as { tool: string }).tool = normalizeToolName(response.action.tool)
  if (response.actions) for (const a of response.actions) (a as { tool: string }).tool = normalizeToolName(a.tool)
}

/** 本 run 的工作性质 */
export type WorkClass = 'readonly' | 'mutating'

/**
 * 判定本 run 的工作性质。
 *
 * `mutating` ⟺ 存在一个工具 t，满足 `t ∉ CONTROL_TOOLS ∪ PLAN_TOOLS`
 * 且 `!isReadonlyTool(t)`。
 *
 * 空集合（一轮没调任何工具）→ `'readonly'`（纯对话）。
 *
 * D159 防御：入参先过 `normalizeToolName` —— 即使上游漏掉摄取点归一，
 * 判据也不因拼写形态（`task-plan` vs `task_plan`）说谎。
 */
export function classifyRunWork(tools: readonly string[]): WorkClass {
  for (const raw of tools) {
    const t = normalizeToolName(raw)
    if (NON_WORK_SET.has(t)) continue
    if (!isReadonlyTool(t)) return 'mutating'
  }
  return 'readonly'
}
