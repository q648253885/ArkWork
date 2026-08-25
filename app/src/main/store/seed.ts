/* ============================================================
 * ArkWork — Seed Data
 * 首次启动时写入默认 Agent / Skill / Model / 示例任务
 * ============================================================ */
import { existsSync } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { getArkworkDir, getWorkspaceDir } from '../store/db.js'
import type { Agent, LlmModel, Skill } from '@shared/types/agent'

const SEED_FLAG = 'seeded.v0.6.0.json'
const LEGACY_SEED_FLAGS = ['seeded.v1.json']  // 旧版本 flag，需触发升级迁移

async function isSeeded(): Promise<boolean> {
  const flag = join(getArkworkDir(), SEED_FLAG)
  return existsSync(flag)
}

async function markSeeded(): Promise<void> {
  const flag = join(getArkworkDir(), SEED_FLAG)
  await writeFile(flag, JSON.stringify({ ts: Date.now(), version: '0.6.0' }, null, 2))
}

async function writeIfMissing<T>(path: string, data: T): Promise<void> {
  if (existsSync(path)) return
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify(data, null, 2))
}

/**
 * v0.6.0 升级迁移：把新增的内置 Agent 合并到已有 agents.json。
 * 仅添加缺失的内置 agent（按 id 去重），不覆盖用户自定义 agent。
 * 已存在同名 builtin agent 的版本字段不强制升级（避免破坏用户可能的定制）。
 */
async function upgradeBuiltinAgents(): Promise<void> {
  const agentsPath = join(getArkworkDir(), 'agents.json')
  let existing: Agent[] = []
  if (existsSync(agentsPath)) {
    try {
      existing = JSON.parse(await readFile(agentsPath, 'utf-8')) as Agent[]
    } catch {
      existing = []
    }
  }
  const existingIds = new Set(existing.map((a) => a.id))
  const toAdd = BUILTIN_AGENTS.filter((a) => !existingIds.has(a.id))
  if (toAdd.length === 0) return
  const merged = [...existing, ...toAdd]
  await writeFile(agentsPath, JSON.stringify(merged, null, 2), 'utf-8')
  console.log(`[seed] upgrade: added ${toAdd.length} new builtin agents`)
}

const BUILTIN_AGENTS: Agent[] = [
  {
    id: '@default',
    name: '通用助手',
    description: '默认通用 Agent，适合大多数日常任务',
    avatarColor: '#5B8DEF',
    role: '通用助手',
    goal: '用最少的工具调用完成用户的日常任务，必要时主动询问澄清',
    backstory: '一名经验丰富的全栈助理，擅长拆解模糊需求、选择合适工具、产出结构化结果',
    styleGuide: '要点式，先结论后依据，代码注释用英文',
    systemPrompt: `你是 ArkWork 通用 Agent。工作模式：ReAct（思考 → 选工具/技能 → 调用 → 观察 → 继续），目标是用最少调用完成用户任务。

## 1. 技能优先（Skill First）
收到任何任务后，第一步先检查可用技能列表中是否有匹配项：
- 用户明确说 "Use Skill: X" → 立即调用 X。
- 用户提到 spec / plan / bugfix / react-core-skills / 文档驱动 / 先出文档 / 设计稿 → 立即调用对应 Skill 作为首个工具调用。
- 任务本身涉及写代码、改 bug、UI 设计、新项目 → 优先调用 react-core-skills（如可用）获取场景路由和文档链规则。
- 禁止只引用 Skill 名称而不调用；禁止说"我会用 X"却直接写代码。

## 2. 工具选择层级（强制）
按以下顺序选择工具，违者视为错误调用：
1. 文件操作必须用专用文件工具，绝对禁止用 shell：
   - 读文件或目录 → file-reader
   - 写文件 → file-writer
   - 编辑文件 → file-editor
   - 按 glob 找文件 → glob-search
   - 在文件中搜索内容 → grep-search
2. 网络信息检索 → web-search / fetch-url。
3. shell 仅限：构建、测试、运行程序、git 操作、系统级安装/清理。即"必须执行命令才能拿到结果"的场景。
4. 与用户交互 / 确认 → ask_user；任务结束 → task_complete。

## 3. 禁止模式（DO NOT）
- 禁止用 shell 做 cat / grep / find / ls / sed / awk / echo 写文件 / tee / head / tail / wc 等文件/文本操作。
- 禁止用 shell 搜索文件或查看目录结构。
- 禁止先用 shell 试探再换文件工具；文件工具应作为首选。
- 禁止在一次迭代中重复调用同一工具同一参数（如连续两次 file-reader(".")）。
- 禁止在需要用户确认/门禁时静默决定。

## 4. 工作区探索纪律
- 第一步用 file-reader(path=".") 列出根目录一次。
- 最多再读 3~5 个关键文件（README、package.json、入口文件、相关配置文件）了解结构。
- 禁止反复列出同一目录或无限读取文件。一次探索后必须开始产出。

## 5. 每次调用工具后自检（必须执行）
工具返回后，立即问自己：
1. 我调用的工具/参数是否正确？是否偏离了当前目标？
2. 如果工具返回错误/空/与预期不符，是换参数重试、换工具，还是基于已有信息继续？
3. 本次调用是否重复了之前同一参数？如果是，立即改策略，禁止再次调用。

## 6. 任务清单（todo-update）
- 多步骤任务首轮必须创建 TodoWrite 清单；简单一问一答可省略。
- 清单状态推进规则（v0.18.0）：act 失败时引擎自动把当前项标 failed；写文件 / 跑命令等阶段内工具**不会**自动推进清单，避免清单抢跑、与真实执行进度错位。
- 每个子任务**真正完成**时，必须调用 todo-update 把当前项标 done 并说明下一步；跳过 / 重试 / 取消也调 todo-update（标 skipped / retry 等），但不要批量打标。
- 中断续聊时，先读取当前 Todo 状态；若发现"全部完成却又继续"的冲突，可调 todo-update 修正并告知用户。
- 最终交付前检查清单全部完成。

## 7. 终止与交付
- 任务完成调用 task_complete，参数包含：改了什么 / 验证结果 / 遗留风险。
- 需要用户输入或门禁确认时调用 ask_user。
- 最多 60 次迭代；单次工具超时 30 秒。工具调用预算按签名/类别动态管控（写入类 40、只读类 16），避免重复调用。`,
    defaultSkillIds: ['S-core.file-reader', 'S-core.file-writer', 'S-core.file-editor', 'S-core.glob-search', 'S-core.grep-search', 'S-core.web-search', 'S-core.fetch-url', 'S-core.shell', 'S-core.browser', 'S-core.todo-update'],
    defaultMcpIds: [],
    defaultModelId: '',
    defaultKbIds: [],
    defaultConfig: { temperature: 0.5, maxIterations: 60 },
    isBuiltin: true,
    version: '0.25.0',
    source: 'core',
    memoryScope: { useProfile: true, skillMemory: true },
  },
  {
    id: '@coder',
    name: 'Coding',
    description: '内置编码智能体，绑定软件工程文档驱动开发技能',
    avatarColor: '#10B981',
    role: '编码智能体',
    goal: '以文档驱动方式完成软件工程任务，产出高质量文档与代码',
    backstory: '一名严谨的全栈工程师，坚持文档先行、最小改动、改后必测，擅长把模糊需求拆解为可执行的文档链与编码任务',
    styleGuide: '要点式，先结论后依据，代码注释用英文，提交说明写清 why',
    systemPrompt: `你是 ArkWork 编码 Agent，处理软件工程任务。核心原则：文档先行、Skill 优先、工具层级正确、Todo 可见、改后必测。

## 1. 技能优先（Skill First）
收到任何任务后，第一步先检查可用技能列表中是否有匹配项，并优先调用：
- 用户明确说 "Use Skill: X" → 立即调用 X。
- 用户提到 spec / plan / bugfix / react-core-skills / 文档驱动 / 先出文档 / 设计稿 / 交互 / 原型 → 立即调用对应 Skill 作为首个工具调用。
- 任务涉及写代码、改 bug、加功能、新项目、UI 设计 → 优先调用 react-core-skills（如可用）获取场景路由和文档链规则。
- 禁止只引用 Skill 名称而不调用；禁止说"我会用 X"却直接写代码或落盘文件。
- 文档驱动流程被触发时，必须实际执行并产出对应文档，禁止只引用不执行。

## 2. 工具选择层级（强制）
按以下顺序选择工具，违者视为错误调用：
1. 文件操作必须用专用文件工具，绝对禁止用 shell：
   - 读文件或目录 → file-reader
   - 写文件 → file-writer
   - 编辑文件 → file-editor
   - 按 glob 找文件 → glob-search
   - 在文件中搜索内容 → grep-search
2. 网络信息检索（开源调研、查文档）→ web-search / fetch-url。
3. shell 仅限：构建、测试、运行程序、git 操作、系统级安装/清理。即"必须执行命令才能拿到结果"的场景。
4. 与用户交互 / 门禁确认 → ask_user；任务结束 → task_complete。

## 3. 禁止模式（DO NOT）
- 禁止用 shell 做 cat / grep / find / ls / sed / awk / echo 写文件 / tee / head / tail / wc 等文件/文本操作。
- 禁止用 shell 搜索文件或查看目录结构。
- 禁止先用 shell 试探再换文件工具；文件工具应作为首选。
- 禁止在一次迭代中重复调用同一工具同一参数（如连续两次 file-reader(".")）。
- 禁止在需要用户确认/门禁时静默决定。
- 禁止代码与已确认文档静默分叉：文档合理则改代码，文档过时则升小版本改文档。

## 4. 文档驱动开发准则（react-core-skills 摘要）
### 场景路由
- A 从 0 开始：新项目 / 新功能 / 跨 ≥3 模块 / 用户说"先出文档再写代码" → 完整流程（阶段 0~8）
- B 软件升级：升级 / 迭代 / 加功能 → 增量文档链
- C Bug 修复：修 bug / 修复 / 改一下 / 调整 → 缺陷处理链
- D UI 设计：UI / 改界面 / 设计 / 样式 → UI 专属链
- 路由冲突按用户最近一次明确表述优先；仍无法判定则 ask_user 不超过 3 个关键问题，禁止静默猜测。

### 阶段 0~8 简述
- 阶段 0 开源调研：web-search / fetch-url 搜 GitHub；评估后产出 00-opensource-research.md
- 阶段 1 PRD：目标用户 / 问题 / 功能清单 P0~P2 / 不做范围 / 成功指标；产出 01-prd.md
- 阶段 2 交互文档：页面清单 / 主流程 / 五态 / 设计 token；产出 02-interaction.md
- 阶段 2.5 HTML 原型：前端交互改动必产；纯静态单文件、:root token、五态切换；经用户确认后冻结
- 阶段 3 系统设计：架构 / 数据模型 / 接口契约 / 非功能；产出 03-system-design.md
- 阶段 4 编码：按设计拆任务，UI 1:1 还原原型，接口注释写清职责/输入/输出/错误
- 阶段 5 功能测试：先冒烟 → 再详测 → 后验收；产出 04-function-test-report.md
- 阶段 6 UI/UX 验证、阶段 7 部署交付、阶段 8 运维沉淀 / 手册（详见完整 SKILL.md）

### 门禁规则（强制）
- 每阶段文档产出完成后，用 ask_user 发出门禁确认：阶段名 + 产物路径 + 要点总结 + 待确认项。
- 用户未确认前不推进任何下游阶段；禁止静默跳阶段（阶段 0 除外仅可加速）。
- 文档-代码不一致时以文档为 source of truth：文档合理则修订代码，文档过时则修订文档并升小版本。

### 缺陷回溯
发现上游文档缺陷或代码-文档静默分叉时：定位问题文档 → 升小版本修订 → 同步下游文档 → 告知用户 → 继续原流程。

## 5. 每次调用工具后自检（必须执行）
工具返回后，立即问自己：
1. 我调用的工具/参数是否正确？是否偏离了当前目标？
2. 如果工具返回错误/空/与预期不符，是换参数重试、换工具，还是基于已有信息继续？
3. 本次调用是否重复了之前同一参数？如果是，立即改策略，禁止再次调用。

## 6. 编码原则
- 先读再改：动手前用 file-reader / glob-search / grep-search 了解结构与模式，模仿现有风格。
- 最小改动：只做任务直接要求的改动，不重构范围外代码、不添加多余注释/类型标注。
- 不过度工程：不为一次性操作创建抽象，不为不可能发生的场景加错误处理。
- 改后必测：修改后跑测试或冒烟验证；UI 改动对照原型 1:1 还原。
- 文档/注释/实现三者一致，禁止静默分叉。

## 7. 任务清单（todo-update）
- 收到软件工程任务后，首轮思考创建 TodoWrite 清单（场景 A 还要列出文档链阶段）。
- 清单状态推进规则（v0.18.0）：act 失败时引擎自动把当前项标 failed；写文件 / 跑命令等阶段内工具**不会**自动推进清单，避免清单抢跑、与真实执行进度错位。
- 每个子任务**真正完成**时，必须调用 todo-update 把当前项标 done 并说明下一步；跳过 / 重试 / 把失败项标 cancelled 也调 todo-update，但不要批量打标。
- 中断续聊时，先读取当前 Todo 状态；若发现"全部完成却又继续"的冲突，可调 todo-update 修正并告知用户。
- 最终交付前检查清单全部完成，并在 task_complete 摘要中说明验证结果与文档同步情况。

## 8. 终止与交付
- 任务完成调用 task_complete，参数包含：改了什么 / 验证结果 / 文档同步情况 / 遗留风险。
- 需要用户输入或门禁确认时调用 ask_user。
- 最多 80 次迭代；单次工具超时 30 秒。工具调用预算按签名/类别动态管控（写入类 40、只读类 16），避免重复调用。`,
    defaultSkillIds: ['S-core.react-core-skills', 'S-core.file-reader', 'S-core.file-writer', 'S-core.file-editor', 'S-core.glob-search', 'S-core.grep-search', 'S-core.shell', 'S-core.web-search', 'S-core.fetch-url', 'S-core.spec', 'S-core.plan', 'S-core.bugfix', 'S-core.browser', 'S-core.todo-update'],
    defaultMcpIds: [],
    // v0.25.0 F1：常驻能力 — run 启动时把 SKILL.md 指令体注入 system agent-static 段，
    // 任务全程生效。react-core-skills 的 frontmatter gates 同步初始化 task.gateStates，
    // 门禁机制阻断跳过阶段的行为（todo_update 标 done 时校验）。
    alwaysOnSkillIds: ['S-core.react-core-skills'],
    defaultModelId: '',
    defaultKbIds: [],
    defaultConfig: { temperature: 0.3, maxIterations: 80 },
    isBuiltin: true,
    version: '0.25.0',
    source: 'core',
    memoryScope: { useProfile: true, skillMemory: true },
    // v0.15.0 Task 6：@coder 默认 acceptEdits —— 工作区内轻写（sed -i/tee/mkdir/cp/...）不再每次弹确认；
    // 高危（rm -rf /、sudo、git push --force 等）仍走 confirm，由 permissions.ts + 受保护路径兜底
    defaultPermissionMode: 'acceptEdits',
  },
]

// v0.19.0 M1：为内置 Agent 派生有序 systemSections（core-rules 单段，文本与 systemPrompt 一致）。
// 单一真源仍是 systemPrompt；systemSections 仅作为组装器的结构化入口，避免双份文案漂移。
for (const agent of BUILTIN_AGENTS) {
  agent.systemSections = [{ id: 'core-rules', order: 0, text: agent.systemPrompt }]
}

/** v0.8.0：已废弃的内置 Agent id 列表（精简为仅保留通用助手；@coder 于 v0.15.0 恢复） */
const DEPRECATED_BUILTIN_AGENT_IDS = ['@researcher', '@writer', '@code-reviewer']

const BUILTIN_SKILLS: Skill[] = [
  {
    id: 'S-core.file-reader',
    name: 'file-reader',
    // v0.28.0：cat-n 行号输出 + offset/limit 分页续读 + 目录 stat 元信息
    description:
      '读取工作区内的文件或目录内容。文件返回带行号的 cat-n 格式（行号→内容），便于后续 file-editor 精确定位；' +
      '目录返回条目列表并附大小与修改时间。大文件分页读法：传 offset（1-based 起始行）+ limit（本次行数），' +
      '截断时按返回的 nextOffset 续读。读目录结构优先用本工具而非 shell ls。',
    namespace: 'core',
    source: 'builtin',
    builtinHandler: 'file-reader',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件或目录的绝对路径，或相对于当前工作区的路径（如 README.md、src/、.）' },
        maxLines: { type: 'number', description: '[兼容旧名] 等价于 limit，优先用 limit；不传或传 0 表示读全文' },
        startLine: { type: 'number', description: '[兼容旧名] 起始行（从 0 开始），等价于 offset-1，优先用 offset' },
        offset: { type: 'number', description: '起始行号（从 1 开始）。大文件分页读的第一页可不传，续读传上次返回的 nextOffset' },
        limit: { type: 'number', description: '最多返回行数（默认全文）。>1000 行的大文件建议配合 offset 分页，每次 300~500 行' },
      },
      required: ['path'],
    },
    timeout: 10_000,
    needsConfirmation: false,
    enabled: true,
    tags: ['file', 'io'],
  },
  {
    id: 'S-core.file-writer',
    name: 'file-writer',
    // v0.28.0：教学文案补充 plan 禁写与受保护路径说明
    description:
      '将文本内容写入工作区文件，替代 shell 的 echo/tee/重定向；受保护路径（.env、密钥等）禁止写入，plan 模式下本工具不可用',
    namespace: 'core',
    source: 'builtin',
    builtinHandler: 'file-writer',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径（相对工作区或绝对路径）' },
        content: { type: 'string', description: '要写入的文本内容' },
        overwrite: { type: 'boolean', default: false, description: '是否覆盖已存在文件' },
      },
      required: ['path', 'content'],
    },
    timeout: 10_000,
    needsConfirmation: false,
    enabled: true,
    tags: ['file', 'io', 'write'],
  },
  {
    id: 'S-core.file-editor',
    name: 'file-editor',
    // v0.28.0：教学文案对齐引导性报错——0 命中先 grep 核对原文、多命中需唯一化或 all
    description:
      '对文件执行搜索替换编辑，替代 shell 的 sed -i。oldStr/newStr 必须从 file-reader 输出中逐字复制（不含行号前缀）；' +
      'oldStr 未命中会报错并提示先 grep-search 核对原文，多处命中会被拒绝——请扩大上下文使其唯一，或传 all=true 替换全部。plan 模式下本工具不可用',
    namespace: 'core',
    source: 'builtin',
    builtinHandler: 'file-editor',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径（相对工作区或绝对路径）' },
        oldStr: { type: 'string', description: '文件中要替换的完整原文' },
        newStr: { type: 'string', description: '替换后的新文本' },
        all: { type: 'boolean', default: false, description: '是否替换所有匹配（默认仅替换第一处）' },
      },
      required: ['path', 'oldStr', 'newStr'],
    },
    timeout: 10_000,
    needsConfirmation: false,
    enabled: true,
    tags: ['file', 'io', 'write'],
  },
  {
    id: 'S-core.glob-search',
    name: 'glob-search',
    // v0.28.0：mtime 降序 + 上限 1000 + 截断尾注
    description:
      '按 glob 模式搜索工作区文件，替代 shell 的 find/ls；结果按修改时间降序（最近改动的排最前），上限 1000，' +
      '截断时会提示总量与收窄方法。例如 **/*.ts、src/**/*.json',
    namespace: 'core',
    source: 'builtin',
    builtinHandler: 'glob-search',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'glob 模式，如 **/*.ts' },
        path: { type: 'string', description: '起始目录（相对工作区，默认工作区根）' },
      },
      required: ['pattern'],
    },
    timeout: 15_000,
    needsConfirmation: false,
    enabled: true,
    tags: ['file', 'search'],
  },
  {
    id: 'S-core.grep-search',
    name: 'grep-search',
    // v0.28.0：output_mode 三态 + context 行 + multiline + head_limit（Claude Code Grep 对齐）
    description:
      '在工作区文件中搜索正则/文本，替代 shell 的 grep/rg。找文件用 outputMode="files_with_matches"（最省 token）；' +
      '统计用 "count"；看代码上下文用默认 content 并可传 context=N 附前后 N 行。返回文件、行号、rg 风格上下文',
    namespace: 'core',
    source: 'builtin',
    builtinHandler: 'grep-search',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '要搜索的正则表达式或文本' },
        path: { type: 'string', description: '搜索目录或文件（相对工作区，默认工作区根）' },
        glob: { type: 'string', description: '可选的 glob 过滤，如 **/*.ts' },
        caseSensitive: { type: 'boolean', default: false, description: '是否区分大小写' },
        outputMode: {
          type: 'string',
          enum: ['content', 'files_with_matches', 'count'],
          description: '输出模式：content=逐行命中（默认）；files_with_matches=仅列含命中的文件（找文件首选，最省 token）；count=每文件命中计数',
        },
        context: { type: 'number', description: '命中行前后各附 N 行上下文（0~10），等价于同时设 contextBefore/contextAfter；仅 content 模式' },
        contextBefore: { type: 'number', description: '命中行前 N 行上下文（0~10）' },
        contextAfter: { type: 'number', description: '命中行后 N 行上下文（0~10）' },
        multiline: { type: 'boolean', default: false, description: '跨行匹配模式（pattern 可含 \\n）' },
        headLimit: { type: 'number', default: 250, description: '最大返回条数（上限 2000）' },
        maxResults: { type: 'number', description: '[兼容旧名] 等价于 headLimit，优先用 headLimit' },
      },
      required: ['pattern'],
    },
    timeout: 15_000,
    needsConfirmation: false,
    enabled: true,
    tags: ['file', 'search'],
  },
  {
    id: 'S-core.web-search',
    name: 'web-search',
    description: '在互联网上搜索关键词，返回前 N 条结果',
    namespace: 'core',
    source: 'builtin',
    builtinHandler: 'web-search',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number', default: 5 },
      },
      required: ['query'],
    },
    timeout: 20_000,
    needsConfirmation: false,
    enabled: true,
    tags: ['web', 'search'],
  },
  {
    id: 'S-core.fetch-url',
    name: 'fetch-url',
    description: '抓取指定 URL 的页面正文（HTML 转纯文本）',
    namespace: 'core',
    source: 'builtin',
    builtinHandler: 'fetch-url',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要抓取的网页 URL' },
        maxChars: { type: 'number', default: 20000, description: '最多返回的字符数' },
      },
      required: ['url'],
    },
    timeout: 20_000,
    needsConfirmation: false,
    enabled: true,
    tags: ['web', 'fetch'],
  },
  {
    id: 'S-core.shell',
    name: 'shell',
    description: '在工作区执行 shell 命令（受黑名单限制，默认需用户确认）',
    namespace: 'core',
    source: 'builtin',
    builtinHandler: 'shell',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 shell 命令' },
        cwd: { type: 'string', description: '工作目录（默认为当前工作区）' },
        timeoutMs: { type: 'number', default: 30000, description: '超时毫秒数' },
      },
      required: ['command'],
    },
    timeout: 60_000,
    needsConfirmation: true,
    enabled: true,
    tags: ['shell', 'exec'],
  },
  {
    id: 'S-core.browser',
    name: 'browser',
    description:
      '在 ArkWork 内置浏览器中打开并测试网页或本地 HTML 文件，支持自主验证与跟进。' +
      '子动作：open（打开 URL 或本地文件）、eval（在页面执行 JS 探测/断言）、snapshot（页面快照：标题/URL/正文/画布）、' +
      'console（读取页面 console 日志，定位 JS 错误）、screenshot（截图留证）、close（结束会话）。' +
      '适合：改完网页后自查运行效果、检查控制台报错、验证交互是否生效。',
    namespace: 'core',
    source: 'builtin',
    builtinHandler: 'browser',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['open', 'eval', 'snapshot', 'console', 'screenshot', 'close'],
          description: '要执行的浏览器动作',
        },
        url: { type: 'string', description: 'open 时的 URL（http/https）；无协议且像路径时视为本地文件' },
        path: { type: 'string', description: 'open 时的本地 HTML 文件路径（相对工作区或绝对路径）' },
        js: { type: 'string', description: 'eval 时要执行的 JS 表达式/语句，建议返回可序列化值或字符串' },
        file: { type: 'string', description: 'screenshot 的保存路径（相对工作区或绝对路径；省略则存 .arkwork/browser-shots/）' },
        limit: { type: 'number', description: 'console 最多返回条数（默认 100）' },
      },
      required: ['action'],
    },
    timeout: 30_000,
    needsConfirmation: false,
    enabled: true,
    tags: ['browser', 'web', 'test'],
  },
  {
    id: 'S-core.task-complete',
    name: 'task_complete',
    description: '任务完成时调用，参数是最终交付物摘要；可选 suggestions 字段由 LLM 真实生成（基于本次任务实际内容，不复用固定模板）',
    namespace: 'core',
    source: 'builtin',
    builtinHandler: 'task_complete',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        // v0.15.0 Task 7：LLM 真实生成的下一步建议（替代 store 中的硬编码 generateNextStepSuggestions）
        suggestions: {
          type: 'array',
          description: '由 LLM 基于本次任务实际内容思考生成的下一步建议（2~4 条），不传或传空数组 → 不展示建议卡片',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: '建议的简短文案（作为用户回复发送）' },
              description: { type: 'string', description: '建议的补充说明（可选）' },
              recommended: { type: 'boolean', description: '是否标记为推荐项（可选）' },
            },
            required: ['label'],
          },
        },
      },
      required: ['summary'],
    },
    timeout: 1_000,
    needsConfirmation: false,
    enabled: true,
    tags: ['control'],
  },
  {
    id: 'S-core.ask-user',
    name: 'ask_user',
    // v0.16.x：硬约束 — 必须给 2~4 个 suggestions，禁止让用户自由输入（对齐
    // 「门禁 + 选择」原则；react-core-skills 等准则型技能也强制遵循）。
    description:
      '向用户提问并**必须**附带 2~4 个建议选项（suggestions）。仅传 question 等于让用户自由输入，违反「门禁 + 选择」原则，引擎会拒绝并要求重试。',
    namespace: 'core',
    source: 'builtin',
    builtinHandler: 'ask_user',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要向用户提出的问题（应包含上下文与待确认项）' },
        // v0.16.x：suggestions 由「可选」升为「必填」2~4 个，前端渲染为可点击卡片
        suggestions: {
          type: 'array',
          minItems: 2,
          maxItems: 4,
          description: '**必填**：2~4 个建议选项。每项是 {label, description?, recommended?}。label 是一行简短文案（作为用户回复发送）；description 是补充说明；recommended=true 标记为推荐项（仅一项）。',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: '建议的简短文案（作为用户回复发送）' },
              description: { type: 'string', description: '建议的补充说明（可选）' },
              recommended: { type: 'boolean', description: '是否标记为推荐项（仅一项为 true）' },
            },
            required: ['label'],
          },
        },
      },
      required: ['question', 'suggestions'],
    },
    timeout: 60_000,
    needsConfirmation: false,
    enabled: true,
    tags: ['control'],
  },
  {
    // v0.17.5：todo_update — 让 LLM 主动更新任务清单状态（对齐 Claude Code TodoWrite）。
    // 引擎层不再全凭感觉自动打标，改为 LLM 每完成一个阶段操作后主动调用本工具
    // 更新清单 + 说明下一步，实现「执行 → 检查 → 更新 → 反馈」闭环。
    id: 'S-core.todo-update',
    name: 'todo_update',
    description:
      '更新任务清单（planItems）中某一项的状态。每完成一个阶段性操作后必须调用，把当前项标为 done 并说明下一步；发现偏离计划或需跳过时也要调用。item_index 是清单中的 0-based 序号，status 取值 done/running/pending/skipped/failed。',
    namespace: 'core',
    source: 'builtin',
    builtinHandler: 'todo_update',
    inputSchema: {
      type: 'object',
      properties: {
        item_index: { type: 'number', description: '要更新的清单项索引（0-based，对应清单顺序）' },
        status: { type: 'string', description: '目标状态：done（已完成）/ running（进行中）/ pending（待办）/ skipped（跳过）/ failed（失败）' },
        comment: { type: 'string', description: '进度说明：完成了什么、下一步要做什么、或偏离原因' },
      },
      required: ['item_index', 'status'],
    },
    timeout: 5_000,
    needsConfirmation: false,
    enabled: true,
    tags: ['control'],
  },
  {
    id: 'S-core.delegate-agent',
    name: 'delegate-agent',
    description: '将子任务委派给另一个 Agent 执行，返回其摘要结果（用于多 Agent 协作）',
    namespace: 'core',
    source: 'builtin',
    builtinHandler: 'delegate-agent',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: '要委派的目标 Agent id（如 @researcher）' },
        task: { type: 'string', description: '委派给子 Agent 的任务描述' },
      },
      required: ['agentId', 'task'],
    },
    timeout: 300_000,
    needsConfirmation: false,
    enabled: true,
    tags: ['multi-agent', 'delegate'],
  },
  {
    id: 'S-core.session-search',
    name: 'session-search',
    description: '检索历史任务档案记忆，返回与查询相关的过往对话片段（任务标题+时间+内容截断）',
    namespace: 'core',
    source: 'builtin',
    builtinHandler: 'session-search',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索关键词或自然语言查询' },
        limit: { type: 'number', default: 5, description: '返回条数上限（默认 5，最大 20）' },
      },
      required: ['query'],
    },
    timeout: 15_000,
    needsConfirmation: false,
    enabled: true,
    tags: ['memory', 'archive', 'search'],
  },
  {
    id: 'S-core.kb-search',
    name: 'kb-search',
    description: '检索知识库切块（用户导入的 pdf/docx/txt/md 文档），返回相关片段。无启用知识库时返回引导提示。',
    namespace: 'core',
    source: 'builtin',
    builtinHandler: 'kb-search',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索关键词或自然语言查询' },
        limit: { type: 'number', default: 5, description: '返回条数上限（默认 5，最大 20）' },
      },
      required: ['query'],
    },
    timeout: 15_000,
    needsConfirmation: false,
    enabled: true,
    tags: ['knowledge', 'search'],
  },
  {
    id: 'S-core.kb-enable',
    name: 'kb-enable',
    description: '为当前任务启用知识库条目（kbIds 缺省时启用全部已解析成功的条目）。',
    namespace: 'core',
    source: 'builtin',
    builtinHandler: 'kb-enable',
    inputSchema: {
      type: 'object',
      properties: {
        kbIds: {
          type: 'array',
          items: { type: 'string' },
          description: '要启用的知识库 id 集合；缺省或空表示启用全部',
        },
      },
    },
    timeout: 5_000,
    needsConfirmation: false,
    enabled: true,
    tags: ['knowledge', 'control'],
  },
  // v0.14.0 Task 6：内置编码技能 spec / plan
  {
    id: 'S-core.spec',
    name: 'spec',
    description: '委派编码 Agent 生成 spec.md / tasks.md / checklist.md 三件套，保存到工作区 .arkwork/specs/<taskName>/',
    namespace: 'core',
    source: 'builtin',
    builtinHandler: 'spec',
    instructionMd: 'app/src/main/skills/builtin/spec/SKILL.md',
    inputSchema: {
      type: 'object',
      required: ['taskName'],
      properties: {
        taskName: { type: 'string', description: '任务名称（同时作为三件套目录名）' },
        scope: { type: 'string', description: '可选的范围说明' },
      },
    },
    timeout: 300_000,
    needsConfirmation: false,
    enabled: true,
    tags: ['coding', 'spec'],
  },
  {
    id: 'S-core.plan',
    name: 'plan',
    description: '委派编码 Agent 生成 plan.md，保存到 .arkwork/documents/<taskName>/ 并返回步骤化的 PlanItem 列表',
    namespace: 'core',
    source: 'builtin',
    builtinHandler: 'plan',
    instructionMd: 'app/src/main/skills/builtin/plan/SKILL.md',
    inputSchema: {
      type: 'object',
      required: ['taskName'],
      properties: {
        taskName: { type: 'string', description: '任务名称' },
        scope: { type: 'string', description: '可选的范围说明' },
      },
    },
    timeout: 300_000,
    needsConfirmation: false,
    enabled: true,
    tags: ['coding', 'plan'],
  },
  // v0.14.0 Task 11：内置 bugfix 技能（目标驱动多轮续跑）
  {
    id: 'S-core.bugfix',
    name: 'bugfix',
    description: '目标驱动多轮续跑缺陷修复：把 bug 现象/复现路径/期望行为解析为可验证目标（Given/When/Then），自动 评估→修复→验证 直至达成或路径耗尽，产物落盘 .arkwork/bugfix/<taskName>/',
    namespace: 'core',
    source: 'builtin',
    builtinHandler: 'bugfix',
    instructionMd: 'app/src/main/skills/builtin/bugfix/SKILL.md',
    inputSchema: {
      type: 'object',
      required: ['symptom', 'expected'],
      properties: {
        symptom: { type: 'string', description: 'bug 现象（必填）' },
        repro: { type: 'string', description: '复现路径（可选：命令或步骤描述）' },
        expected: { type: 'string', description: '期望行为（必填）' },
      },
    },
    timeout: 600_000,
    needsConfirmation: false,
    enabled: true,
    tags: ['coding', 'bugfix'],
  },
  // v0.15.0：内置文档驱动开发准则技能（准则型，注入系统提示词）
  {
    id: 'S-core.react-core-skills',
    name: 'react-core-skills',
    description: '软件工程文档驱动开发准则：根据场景自动路由文档链，产出 PRD/交互/设计/测试/手册等产物',
    namespace: 'core',
    source: 'builtin',
    builtinHandler: 'react-core-skills',
    instructionMd: 'app/src/main/skills/builtin/react-core-skills/SKILL.md',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '软件开发任务描述（用于场景路由与文档链触发）' },
      },
    },
    timeout: 10_000,
    needsConfirmation: false,
    enabled: true,
    tags: ['coding', 'docs', 'swe'],
  },
]

const BUILTIN_MODELS: LlmModel[] = [
  // 无内置模型 — 用户在设置页按需添加，每个模型自带 id+url+协议+key
]

/**
 * v0.19.0 M1：统一同步内置 Agent 到最新定义（幂等）。
 * 取代 v0.6.2 / v0.9.0 / v0.9.1 / v0.15.0 / v0.16.0 / v0.18.0 六段增量升级：
 * 用 agent.version 字段判断是否落后（不再依赖守卫 flag），落后则幂等同步关键字段。
 * 职责：
 *  1) 补齐缺失的内置 agent（按 id 去重，仅新增不覆盖）；
 *  2) 已存在内置 agent 若 version 落后，同步 systemPrompt / systemSections /
 *     defaultSkillIds / version / role / goal / backstory / description / defaultPermissionMode；
 *  3) 用户自定义 agent（isBuiltin=false）永不覆盖。
 * 副作用：仅当存在待补齐或落后项时写 agents.json。
 */
async function syncBuiltinAgentsToLatest(): Promise<void> {
  const agentsPath = join(getArkworkDir(), 'agents.json')
  if (!existsSync(agentsPath)) return
  try {
    const raw = await readFile(agentsPath, 'utf-8')
    const existing = JSON.parse(raw) as Agent[]
    const existingIds = new Set(existing.map((a) => a.id))
    const builtinMap = new Map(BUILTIN_AGENTS.map((a) => [a.id, a]))
    const toAdd = BUILTIN_AGENTS.filter((a) => !existingIds.has(a.id))
    let changed = toAdd.length > 0
    const updated = existing.map((a) => {
      if (!a.isBuiltin) return a
      const latest = builtinMap.get(a.id)
      if (!latest) return a
      if (a.version === latest.version) return a
      changed = true
      return {
        ...a,
        systemPrompt: latest.systemPrompt,
        systemSections: latest.systemSections ?? a.systemSections,
        defaultSkillIds: latest.defaultSkillIds,
        version: latest.version,
        role: latest.role ?? a.role,
        goal: latest.goal ?? a.goal,
        backstory: latest.backstory ?? a.backstory,
        description: latest.description,
        defaultPermissionMode: latest.defaultPermissionMode ?? a.defaultPermissionMode,
      }
    })
    if (changed) {
      const merged = [...updated, ...toAdd]
      await writeFile(agentsPath, JSON.stringify(merged, null, 2), 'utf-8')
      console.log(`[seed] syncBuiltinAgentsToLatest: added ${toAdd.length}, synced stale builtin agents`)
    }
  } catch (err) {
    console.error('[seed] syncBuiltinAgentsToLatest failed:', (err as Error).message)
  }
}

export async function seedDefaults(): Promise<void> {
  // 1. 检查是否已 v0.6.0 seed 过
  if (!(await isSeeded())) {
    // 2. 检查是否为旧版本升级（存在 legacy flag 但无 v0.6.0 flag）
    const isUpgrade = LEGACY_SEED_FLAGS.some((f) => existsSync(join(getArkworkDir(), f)))

    const dir = getArkworkDir()
    if (isUpgrade) {
      // 升级路径：合并新增内置 agent 到已有 agents.json
      // skills 由 registry.ts 的 migrateLegacySkillsJson + seedBuiltinSkillsToFolders 处理
      await upgradeBuiltinAgents()
    } else {
      // 全新安装：写入内置数据
      await writeIfMissing(join(dir, 'agents.json'), BUILTIN_AGENTS)
      await writeIfMissing(join(dir, 'skills.json'), BUILTIN_SKILLS)
    }
    await writeIfMissing(join(dir, 'models.json'), BUILTIN_MODELS)
    await writeIfMissing(join(dir, 'secrets.json'), {})
    await writeIfMissing(join(dir, 'settings.json'), {
      workspaceDir: getWorkspaceDir(),
      defaultModelId: '',
      defaultAgentId: '@default',
      theme: 'dark',
      // 空字符串表示使用默认 {workspaceDir}/docs
      artifactsDir: '',
    })

    await markSeeded()
  }

  // 3. v0.8.0：删除废弃的内置 Agent（精简为仅保留通用助手）
  await removeDeprecatedBuiltinAgents()

  // 4. v0.19.0 M1：统一同步内置 Agent 到最新定义
  //    （取代 v0.6.2 / v0.9.0 / v0.9.1 / v0.15.0 / v0.16.0 / v0.18.0 六段增量升级）
  await syncBuiltinAgentsToLatest()
}

/**
 * v0.8.0：删除已废弃的内置 Agent（@researcher / @writer / @code-reviewer）。
 * 仅删除 isBuiltin=true 且 id 在 DEPRECATED 列表中的条目；用户自定义副本不受影响。
 * 注：@coder 于 v0.15.0 恢复（现由 syncBuiltinAgentsToLatest 维护），不再纳入废弃列表。
 */
async function removeDeprecatedBuiltinAgents(): Promise<void> {
  const agentsPath = join(getArkworkDir(), 'agents.json')
  if (!existsSync(agentsPath)) return
  let existing: Agent[] = []
  try {
    existing = JSON.parse(await readFile(agentsPath, 'utf-8')) as Agent[]
  } catch {
    return
  }
  const before = existing.length
  const filtered = existing.filter(
    (a) => !(a.isBuiltin && DEPRECATED_BUILTIN_AGENT_IDS.includes(a.id)),
  )
  if (filtered.length === before) return
  await writeFile(agentsPath, JSON.stringify(filtered, null, 2), 'utf-8')
  console.log(`[seed] v0.8.0: removed ${before - filtered.length} deprecated builtin agents`)
}

export const builtinAgents = BUILTIN_AGENTS
export const builtinSkills = BUILTIN_SKILLS
export const builtinModels = BUILTIN_MODELS
