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

## 6. 任务清单（TodoWrite / todo-update）
- 多步骤任务首轮必须创建 TodoWrite 清单；简单一问一答可省略。
- 每完成一个具体步骤，立即调用 todo-update 工具标记该步 done 并说明下一步，禁止批量标记多个任务后再继续。
- 每完成一个阶段性操作后，都要自己检查清单和后续要做的事，及时用 todo-update 更新、及时反馈。
- 中断续聊时先核对当前 Todo 状态；若发现与实际进度冲突，立即用 todo-update 修正并告知用户。
- 最终交付前检查清单是否全部完成。

## 7. 终止与交付
- 任务完成调用 task_complete，参数包含：改了什么 / 验证结果 / 遗留风险。
- 需要用户输入或门禁确认时调用 ask_user。
- 最多 60 次迭代；单次工具超时 30 秒。工具调用预算按签名/类别动态管控（写入类 40、只读类 16），避免重复调用。`,
    defaultSkillIds: ['S-core.file-reader', 'S-core.file-writer', 'S-core.file-editor', 'S-core.glob-search', 'S-core.grep-search', 'S-core.web-search', 'S-core.fetch-url', 'S-core.shell', 'S-core.todo-update'],
    defaultMcpIds: [],
    defaultModelId: '',
    defaultKbIds: [],
    defaultConfig: { temperature: 0.5, maxIterations: 60 },
    isBuiltin: true,
    version: '0.17.5',
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

## 7. 任务清单（TodoWrite / todo-update）
- 收到软件工程任务后，首轮思考创建 TodoWrite 清单（场景 A 还要列出文档链阶段）。
- 每完成一个具体步骤，立即调用 todo-update 工具标记该步 done 并说明下一步，禁止批量标记多个任务后再继续。
- 每完成一个阶段性操作后，都要自己检查清单和后续要做的事，及时用 todo-update 更新、及时反馈。
- 中断续聊时，先读取当前 Todo 状态；若发现"全部完成却又继续"的冲突，立即用 todo-update 修正并告知用户。
- 最终交付前检查清单全部完成，并在 task_complete 摘要中说明验证结果与文档同步情况。

## 8. 终止与交付
- 任务完成调用 task_complete，参数包含：改了什么 / 验证结果 / 文档同步情况 / 遗留风险。
- 需要用户输入或门禁确认时调用 ask_user。
- 最多 80 次迭代；单次工具超时 30 秒。工具调用预算按签名/类别动态管控（写入类 40、只读类 16），避免重复调用。`,
    defaultSkillIds: ['S-core.react-core-skills', 'S-core.file-reader', 'S-core.file-writer', 'S-core.file-editor', 'S-core.glob-search', 'S-core.grep-search', 'S-core.shell', 'S-core.web-search', 'S-core.fetch-url', 'S-core.spec', 'S-core.plan', 'S-core.bugfix', 'S-core.todo-update'],
    defaultMcpIds: [],
    defaultModelId: '',
    defaultKbIds: [],
    defaultConfig: { temperature: 0.3, maxIterations: 80 },
    isBuiltin: true,
    version: '0.17.5',
    source: 'core',
    memoryScope: { useProfile: true, skillMemory: true },
    // v0.15.0 Task 6：@coder 默认 acceptEdits —— 工作区内轻写（sed -i/tee/mkdir/cp/...）不再每次弹确认；
    // 高危（rm -rf /、sudo、git push --force 等）仍走 confirm，由 permissions.ts + 受保护路径兜底
    defaultPermissionMode: 'acceptEdits',
  },
]

/** v0.8.0：已废弃的内置 Agent id 列表（精简为仅保留通用助手；@coder 于 v0.15.0 恢复） */
const DEPRECATED_BUILTIN_AGENT_IDS = ['@researcher', '@writer', '@code-reviewer']

const BUILTIN_SKILLS: Skill[] = [
  {
    id: 'S-core.file-reader',
    name: 'file-reader',
    description: '读取工作区内的文件或目录内容（文本、代码、JSON、目录列表等）',
    namespace: 'core',
    source: 'builtin',
    builtinHandler: 'file-reader',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件或目录的绝对路径，或相对于当前工作区的路径（如 README.md、src/、.）' },
        maxLines: { type: 'number', description: '最多读取行数（0 表示全部）' },
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
    description: '将文本内容写入工作区文件，替代 shell 的 echo/tee/重定向；禁止覆盖受保护路径',
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
    description: '对文件执行搜索替换编辑，替代 shell 的 sed -i；oldStr 必须完整匹配文件原文',
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
    description: '按 glob 模式搜索工作区文件，替代 shell 的 find/ls；例如 **/*.ts、src/**/*.json',
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
    description: '在工作区文件中搜索正则/文本，替代 shell 的 grep/rg；返回文件、行号、上下文',
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
        maxResults: { type: 'number', default: 100, description: '最大返回条数' },
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

// v0.6.2 增量升级标志：修复 file-reader 路径、给内置 Agent 加 shell skill
const UPGRADE_062_FLAG = 'seeded.v0.6.2.json'
// v0.9.0 增量升级标志：工具容错恢复 systemPrompt 更新
const UPGRADE_090_FLAG = 'seeded.v0.9.0.json'
// v0.9.1 增量升级标志：工作区探索规则 systemPrompt 更新
const UPGRADE_091_FLAG = 'seeded.v0.9.1.json'
// v0.15.0 增量升级标志：恢复 @coder 内置智能体并绑定 react-core-skills
const UPGRADE_0150_FLAG = 'seeded.v0.15.0.json'
// v0.16.0 增量升级标志：系统提示词工具优先级 + 新增文件工具 Skill
const UPGRADE_0160_FLAG = 'seeded.v0.16.0.json'

async function isUpgraded062(): Promise<boolean> {
  return existsSync(join(getArkworkDir(), UPGRADE_062_FLAG))
}

async function markUpgraded062(): Promise<void> {
  const flag = join(getArkworkDir(), UPGRADE_062_FLAG)
  await writeFile(flag, JSON.stringify({ ts: Date.now(), version: '0.6.2' }, null, 2))
}

async function isUpgraded090(): Promise<boolean> {
  return existsSync(join(getArkworkDir(), UPGRADE_090_FLAG))
}

async function markUpgraded090(): Promise<void> {
  const flag = join(getArkworkDir(), UPGRADE_090_FLAG)
  await writeFile(flag, JSON.stringify({ ts: Date.now(), version: '0.9.0' }, null, 2))
}

async function isUpgraded091(): Promise<boolean> {
  return existsSync(join(getArkworkDir(), UPGRADE_091_FLAG))
}

async function markUpgraded091(): Promise<void> {
  const flag = join(getArkworkDir(), UPGRADE_091_FLAG)
  await writeFile(flag, JSON.stringify({ ts: Date.now(), version: '0.9.1' }, null, 2))
}

/**
 * v0.6.2 增量升级：同步已有内置 Agent 的关键字段。
 * 保留用户自定义 Agent 和用户对内置 Agent 的 model/temperature 等个性化修改，
 * 只更新 systemPrompt、defaultSkillIds、version 等由版本变更引入的字段。
 */
async function upgradeTo062(): Promise<void> {
  if (await isUpgraded062()) return
  const agentsPath = join(getArkworkDir(), 'agents.json')
  if (existsSync(agentsPath)) {
    try {
      const raw = await readFile(agentsPath, 'utf-8')
      const existing = JSON.parse(raw) as Agent[]
      const builtinMap = new Map(BUILTIN_AGENTS.map((a) => [a.id, a]))
      let changed = false
      const updated = existing.map((a) => {
        if (!a.isBuiltin) return a
        const latest = builtinMap.get(a.id)
        if (!latest) return a
        const next = {
          ...a,
          systemPrompt: latest.systemPrompt,
          defaultSkillIds: latest.defaultSkillIds,
          version: latest.version,
          role: latest.role ?? a.role,
          goal: latest.goal ?? a.goal,
          backstory: latest.backstory ?? a.backstory,
        }
        if (JSON.stringify(next.defaultSkillIds) !== JSON.stringify(a.defaultSkillIds) ||
            next.systemPrompt !== a.systemPrompt || next.version !== a.version) {
          changed = true
        }
        return next
      })
      if (changed) {
        await writeFile(agentsPath, JSON.stringify(updated, null, 2), 'utf-8')
        console.log('[seed] v0.6.2 upgrade: synced builtin agents')
      }
    } catch (err) {
      console.error('[seed] v0.6.2 upgrade agents failed:', (err as Error).message)
    }
  }
  await markUpgraded062()
}

/**
 * v0.9.0 增量升级：更新内置 Agent 的 systemPrompt（新增容错恢复段）。
 * 与 upgradeTo062 逻辑相同，但使用独立守卫标志，确保已升级用户也能拿到新 prompt。
 */
async function upgradeTo090(): Promise<void> {
  if (await isUpgraded090()) return
  const agentsPath = join(getArkworkDir(), 'agents.json')
  if (existsSync(agentsPath)) {
    try {
      const raw = await readFile(agentsPath, 'utf-8')
      const existing = JSON.parse(raw) as Agent[]
      const builtinMap = new Map(BUILTIN_AGENTS.map((a) => [a.id, a]))
      let changed = false
      const updated = existing.map((a) => {
        if (!a.isBuiltin) return a
        const latest = builtinMap.get(a.id)
        if (!latest) return a
        const next = {
          ...a,
          systemPrompt: latest.systemPrompt,
          version: latest.version,
        }
        if (next.systemPrompt !== a.systemPrompt || next.version !== a.version) {
          changed = true
        }
        return next
      })
      if (changed) {
        await writeFile(agentsPath, JSON.stringify(updated, null, 2), 'utf-8')
        console.log('[seed] v0.9.0 upgrade: synced builtin agent systemPrompt')
      }
    } catch (err) {
      console.error('[seed] v0.9.0 upgrade agents failed:', (err as Error).message)
    }
  }
  await markUpgraded090()
}

/**
 * v0.9.1 增量升级：更新内置 Agent 的 systemPrompt（新增工作区探索规则段）。
 * 与 upgradeTo090 逻辑相同，但使用独立守卫标志，确保已升级用户也能拿到新 prompt。
 */
async function upgradeTo091(): Promise<void> {
  if (await isUpgraded091()) return
  const agentsPath = join(getArkworkDir(), 'agents.json')
  if (existsSync(agentsPath)) {
    try {
      const raw = await readFile(agentsPath, 'utf-8')
      const existing = JSON.parse(raw) as Agent[]
      const builtinMap = new Map(BUILTIN_AGENTS.map((a) => [a.id, a]))
      let changed = false
      const updated = existing.map((a) => {
        if (!a.isBuiltin) return a
        const latest = builtinMap.get(a.id)
        if (!latest) return a
        const next = {
          ...a,
          systemPrompt: latest.systemPrompt,
          version: latest.version,
        }
        if (next.systemPrompt !== a.systemPrompt || next.version !== a.version) {
          changed = true
        }
        return next
      })
      if (changed) {
        await writeFile(agentsPath, JSON.stringify(updated, null, 2), 'utf-8')
        console.log('[seed] v0.9.1 upgrade: synced builtin agent systemPrompt')
      }
    } catch (err) {
      console.error('[seed] v0.9.1 upgrade agents failed:', (err as Error).message)
    }
  }
  await markUpgraded091()
}

async function isUpgraded0150(): Promise<boolean> {
  return existsSync(join(getArkworkDir(), UPGRADE_0150_FLAG))
}

async function markUpgraded0150(): Promise<void> {
  const flag = join(getArkworkDir(), UPGRADE_0150_FLAG)
  await writeFile(flag, JSON.stringify({ ts: Date.now(), version: '0.15.0' }, null, 2))
}

/**
 * v0.15.0 增量升级：恢复 @coder 内置智能体（v0.8.0 曾废弃，现恢复并绑定 react-core-skills 准则）。
 * 仅添加缺失的内置 agent（按 id 去重），不覆盖用户自定义 agent；
 * 已存在的 @coder 同步其 systemPrompt / defaultSkillIds / version 等关键字段。
 *
 * v0.15.1 幂等化修复：此前 flag 存在即短路（isUpgraded0150），导致已固化的旧版
 * @coder 数据（version 0.8.0 / 旧 systemPrompt / defaultPermissionMode 缺失）永远无法升级。
 * 现在每次启动都会检查内置 agent 版本是否落后于最新定义，落后则强制同步关键字段；
 * flag 仅用于一次性补齐缺失 agent 与避免重复新增。
 */
async function upgradeTo0150(): Promise<void> {
  const agentsPath = join(getArkworkDir(), 'agents.json')
  const wasUpgraded = await isUpgraded0150()
  if (existsSync(agentsPath)) {
    try {
      const raw = await readFile(agentsPath, 'utf-8')
      const existing = JSON.parse(raw) as Agent[]
      const existingIds = new Set(existing.map((a) => a.id))
      // 1. 补齐缺失的内置 agent（@coder 在 v0.8.0 被删除，此处恢复；仅首次执行）
      const toAdd = !wasUpgraded ? BUILTIN_AGENTS.filter((a) => !existingIds.has(a.id)) : []
      // 2. 幂等同步：已存在的内置 agent 若 version 落后于最新定义，强制同步关键字段。
      //    version 相同则跳过（不覆盖用户对 description/role 等的微调，也不重复写盘）。
      const builtinMap = new Map(BUILTIN_AGENTS.map((a) => [a.id, a]))
      let changed = toAdd.length > 0
      const updated = existing.map((a) => {
        if (!a.isBuiltin) return a
        const latest = builtinMap.get(a.id)
        if (!latest) return a
        if (a.version === latest.version) return a
        changed = true
        const next = {
          ...a,
          systemPrompt: latest.systemPrompt,
          defaultSkillIds: latest.defaultSkillIds,
          version: latest.version,
          role: latest.role ?? a.role,
          goal: latest.goal ?? a.goal,
          description: latest.description,
          // v0.15.0 Task 6：@coder 智能体默认 acceptEdits —— 已存在 agent 也同步升级
          defaultPermissionMode: latest.defaultPermissionMode ?? a.defaultPermissionMode,
        }
        return next
      })
      if (changed) {
        const merged = [...updated, ...toAdd]
        await writeFile(agentsPath, JSON.stringify(merged, null, 2), 'utf-8')
        console.log(`[seed] v0.15.0 upgrade: restored @coder (added ${toAdd.length}, synced fields)`)
      }
    } catch (err) {
      console.error('[seed] v0.15.0 upgrade agents failed:', (err as Error).message)
    }
  }
  await markUpgraded0150()
}

async function isUpgraded0160(): Promise<boolean> {
  return existsSync(join(getArkworkDir(), UPGRADE_0160_FLAG))
}

async function markUpgraded0160(): Promise<void> {
  const flag = join(getArkworkDir(), UPGRADE_0160_FLAG)
  await writeFile(flag, JSON.stringify({ ts: Date.now(), version: '0.16.4' }, null, 2))
}

/**
 * v0.16.x 增量升级：同步系统提示词（工具/技能优先级 / TodoWrite / 文件工具优先）
 * 与 defaultSkillIds（新增 file-writer / file-editor / glob-search / grep-search）。
 * 已存在的内置 agent 若 version 落后于最新定义，强制同步关键字段；不覆盖用户自定义 agent。
 */
async function upgradeTo0160(): Promise<void> {
  const wasUpgraded = await isUpgraded0160()
  const agentsPath = join(getArkworkDir(), 'agents.json')
  if (existsSync(agentsPath)) {
    try {
      const raw = await readFile(agentsPath, 'utf-8')
      const existing = JSON.parse(raw) as Agent[]
      const existingIds = new Set(existing.map((a) => a.id))
      // 首次：补齐缺失的内置 agent
      const toAdd = !wasUpgraded ? BUILTIN_AGENTS.filter((a) => !existingIds.has(a.id)) : []
      const builtinMap = new Map(BUILTIN_AGENTS.map((a) => [a.id, a]))
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
          defaultSkillIds: latest.defaultSkillIds,
          version: latest.version,
          role: latest.role ?? a.role,
          goal: latest.goal ?? a.goal,
          description: latest.description,
          defaultPermissionMode: latest.defaultPermissionMode ?? a.defaultPermissionMode,
        }
      })
      if (changed) {
        const merged = [...updated, ...toAdd]
        await writeFile(agentsPath, JSON.stringify(merged, null, 2), 'utf-8')
        console.log(`[seed] v0.16.x upgrade: synced builtin agents (added ${toAdd.length})`)
      }
    } catch (err) {
      console.error('[seed] v0.16.0 upgrade agents failed:', (err as Error).message)
    }
  }
  await markUpgraded0160()
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

  // 3. v0.6.2 增量升级（即使已经 v0.6.0 seed 过也会执行一次）
  await upgradeTo062()

  // 4. v0.8.0 增量升级：删除废弃的内置 Agent（精简为仅保留通用助手）
  await removeDeprecatedBuiltinAgents()

  // 5. v0.9.0 增量升级：更新内置 Agent systemPrompt（新增容错恢复段）
  await upgradeTo090()

  // 6. v0.9.1 增量升级：更新内置 Agent systemPrompt（新增工作区探索规则段）
  await upgradeTo091()

  // 7. v0.15.0 增量升级：恢复 @coder 内置智能体并绑定 react-core-skills 准则
  await upgradeTo0150()

  // 8. v0.16.0 增量升级：系统提示词工具优先级 + 新增文件工具 Skill
  await upgradeTo0160()
}

/**
 * v0.8.0：删除已废弃的内置 Agent（@researcher / @writer / @code-reviewer）。
 * 仅删除 isBuiltin=true 且 id 在 DEPRECATED 列表中的条目；用户自定义副本不受影响。
 * 注：@coder 于 v0.15.0 恢复（见 upgradeTo0150），不再纳入废弃列表。
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
