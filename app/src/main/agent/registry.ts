/* ============================================================
 * ArkWork — Skill / Tool Registry
 * 设计文档 §10.5 / v0.6.0 §4.5（渐进式披露）
 * Skill = 内置工具 + MCP 工具的统一抽象
 *
 * v0.6.0 改造：
 *  - SkillContext 扩展：workspaceDir / agent / task / confirm / parentTaskId
 *  - listSkills 从文件夹存储读取（migrate 旧 skills.json）
 *  - invokeSkill 渐进式披露：instructionMd 按需加载，注入 additionalSystemHint
 *  - 新增 handler：shell / fetch-url / delegate-agent
 *  - 修复 task_complete / ask_user handler 键名（与 seed 对齐）
 * ============================================================ */
import { join, dirname, relative, sep } from 'node:path'
import { readFile, readdir, writeFile, mkdir, rm, copyFile, stat } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dialog } from 'electron'
import { getArkworkDir, getWorkspaceDir } from '../store/db.js'
import { builtinSkills } from '../store/seed.js'
import type { Agent, Skill } from '@shared/types/agent'
import type { Task } from '@shared/types/task'
import type { LlmTool } from '../llm/adapter.js'
import type { ToolConfirmRequest } from '@shared/types/ipc'
import { fileReader, type FileReaderArgs, type FileReaderResult } from './skills/file-reader.js'
import { fileWriter, type FileWriterArgs, type FileWriterResult } from './skills/file-writer.js'
import { fileEditor, type FileEditorArgs, type FileEditorResult } from './skills/file-editor.js'
import { globSearch, type GlobSearchArgs, type GlobSearchResult } from './skills/glob-search.js'
import { grepSearch, type GrepSearchArgs, type GrepSearchResult } from './skills/grep-search.js'
import { webSearch, type WebSearchArgs, type WebSearchResult } from './skills/web-search.js'
import { shell, type ShellArgs, type ShellResult } from './skills/shell.js'
import { assessCommandRisk } from './permissions.js'
import { MODE_POLICIES, type PermissionMode } from './permission-mode.js'
import { getSessionMode } from './session-mode.js'
import { loadPermissionSettings } from './settings-loader.js'
import { fetchUrl, type FetchUrlArgs, type FetchUrlResult } from './skills/fetch-url.js'
import { delegateAgent, type DelegateArgs, type DelegateResult } from './skills/delegate.js'
import { sessionSearch, type SessionSearchArgs, type SessionSearchResult } from './skills/session-search.js'
import { kbSearch, type KbSearchArgs, type KbSearchSkillResult } from './skills/kb-search.js'
import { kbEnable, type KbEnableArgs, type KbEnableResult } from './skills/kb-enable.js'
import { spec, type SpecArgs, type SpecResult } from '../skills/builtin/spec/index.js'
import { plan, type PlanArgs, type PlanResult } from '../skills/builtin/plan/index.js'
import { bugfix, type BugfixArgs, type BugfixResult } from '../skills/builtin/bugfix/index.js'
import { reactCoreSkills, type ReactCoreSkillsArgs, type ReactCoreSkillsResult } from '../skills/builtin/react-core-skills/index.js'
import { logger } from '../system/logger.js'

/**
 * Skill 执行上下文 — 由 engine 在每次 Act 阶段创建并传入 invokeSkill。
 *
 * v0.6.0 扩展字段：
 *  - workspaceDir：shell/fetch 等需要 cwd 的 skill 的默认工作目录
 *  - agent / task：当前 ReAct 循环的 agent 与 task，供 delegate-agent 复用
 *  - parentTaskId / isSubAgent：delegate-agent 委派时由父 ctx 派生
 *  - additionalSystemHint：invokeSkill 在加载 instructionMd 后写入；
 *    engine 在下一轮 Reason 时合并到 system 提示（渐进式披露）
 *  - confirm：用于 needsConfirmation=true 的 skill（如 shell），通过原生 dialog 询问用户
 */
export interface SkillContext {
  taskId: string
  signal: AbortSignal
  /** 工作区根目录（shell 的默认 cwd、相对路径解析基准） */
  workspaceDir?: string
  /** 当前执行的 Agent（delegate-agent 用于创建子任务） */
  agent?: Agent
  /** 当前执行的 Task（delegate-agent 用于读取 input 与 config） */
  task?: Task
  /** 父任务 id（delegate-agent 委派链路） */
  parentTaskId?: string
  /** 当前是否为子 agent 执行（影响日志与状态广播） */
  isSubAgent?: boolean
  /** invokeSkill 加载 instructionMd 后写入，engine 下一轮合并到 system 提示 */
  additionalSystemHint?: string
  /** 用户确认回调（v0.8.1：经 IPC 推送到 renderer 美观浮层展示；
   *  v0.14.0 Task 6：返回结果区分「显式拒绝 / 超时 / 关闭」，只有显式拒绝才算用户拒绝） */
  confirm?: (req: ToolConfirmRequest) => Promise<ConfirmOutcome>
  /** Task 8：会话级知识库开关（false 时 kb_search 直接跳过检索） */
  kbSessionEnabled?: boolean
}

/** v0.8.1：工具执行确认请求体（与 shared/types/ipc 的 ToolConfirmRequest 一致） */
export type ConfirmRequest = ToolConfirmRequest

/**
 * v0.14.0 Task 6：确认结果。
 *  - { allowed: true } → 放行
 *  - { allowed: false, reason: 'denied' } → 用户显式点击「拒绝」（才记为「用户拒绝」）
 *  - { allowed: false, reason: 'dismissed' } → 对话框被关闭 / Esc / 点背景（不是拒绝）
 *  - { allowed: false, reason: 'timeout' } → 60s 未响应（不是拒绝）
 */
export type ConfirmOutcome =
  | { allowed: true }
  | { allowed: false; reason: 'denied' | 'timeout' | 'dismissed' }

export type BuiltinHandler =
  | ((args: unknown, ctx: SkillContext) => Promise<unknown>)
  | null

/**
 * polish4 §C1：builtin skill 风险分级（与 shell 已有 4 级对齐）。
 * - workspace-readonly / external-readonly：直通，不弹 confirm
 * - workspace-light-write：首次确认后本会话记住
 * - medium / high：每次确认
 */
export type ToolRiskLevel =
  | 'workspace-readonly'
  | 'external-readonly'
  | 'workspace-light-write'
  | 'medium'
  | 'high'

export interface ToolRisk {
  level: ToolRiskLevel
  impacts: string[]
}

const READONLY_BUILTINS: Record<string, ToolRiskLevel> = {
  'file-reader': 'workspace-readonly',
  'glob-search': 'workspace-readonly',
  'grep-search': 'workspace-readonly',
  'kb-search': 'workspace-readonly',
  'kb-enable': 'workspace-readonly',
  'session-search': 'workspace-readonly',
  'web-search': 'external-readonly',
  'fetch-url': 'external-readonly',
}

const LIGHT_WRITE_BUILTINS: Record<string, ToolRiskLevel> = {
  'file-writer': 'workspace-light-write',
  'file-editor': 'workspace-light-write',
  'delegate-agent': 'workspace-light-write',
  'task_complete': 'workspace-readonly',
  'ask_user': 'workspace-readonly',
}

/** polish4 §C1.1：builtin skill 静态风险映射 */
export function assessToolRisk(skill: Skill, _args: Record<string, unknown>): ToolRisk {
  const builtin = skill.builtinHandler ?? ''
  if (READONLY_BUILTINS[builtin]) {
    return { level: READONLY_BUILTINS[builtin], impacts: [`读取 ${builtin}（只读）`] }
  }
  if (LIGHT_WRITE_BUILTINS[builtin]) {
    return { level: LIGHT_WRITE_BUILTINS[builtin], impacts: [`调用 ${builtin}（可能跨会话写入）`] }
  }
  if (builtin === 'shell') {
    // shell 走自己 4 级 risk（assessCommandRisk），不重复
    return { level: 'medium', impacts: ['运行 shell 命令'] }
  }
  // market / custom / mcp / 其他 → 默认每次确认
  return { level: 'medium', impacts: [`调用技能 ${skill.name}`] }
}

/**
 * builtin handler 注册表。
 * 键名与 seed.ts 的 builtinHandler 字段保持一致（task_complete / ask_user 用下划线，
 * 与 LLM 调用的 tool name 一致；其余 file-reader / web-search / shell / fetch-url /
 * delegate-agent 用连字符）。
 */
const handlers: Record<string, BuiltinHandler> = {
  'file-reader': async (args, ctx) => fileReader(args as FileReaderArgs, ctx) as Promise<FileReaderResult>,
  'file-writer': async (args, ctx) => fileWriter(args as FileWriterArgs, ctx) as Promise<FileWriterResult>,
  'file-editor': async (args, ctx) => fileEditor(args as FileEditorArgs, ctx) as Promise<FileEditorResult>,
  'glob-search': async (args, ctx) => globSearch(args as GlobSearchArgs, ctx) as Promise<GlobSearchResult>,
  'grep-search': async (args, ctx) => grepSearch(args as GrepSearchArgs, ctx) as Promise<GrepSearchResult>,
  'web-search': async (args, ctx) => webSearch(args as WebSearchArgs, ctx) as Promise<WebSearchResult>,
  'fetch-url': async (args, ctx) => fetchUrl(args as FetchUrlArgs, ctx) as Promise<FetchUrlResult>,
  'shell': async (args, ctx) => shell(args as ShellArgs, ctx) as Promise<ShellResult>,
  'task_complete': async (args) => ({ acknowledged: true, summary: (args as { summary: string }).summary }),
  'ask_user': async (args) => ({ acknowledged: true, question: (args as { question: string }).question }),
  'delegate-agent': async (args, ctx) => delegateAgent(args as DelegateArgs, ctx) as Promise<DelegateResult>,
  'session-search': async (args, ctx) => sessionSearch(args as SessionSearchArgs, ctx) as Promise<SessionSearchResult>,
  'kb-search': async (args, ctx) => kbSearch(args as KbSearchArgs, ctx) as Promise<KbSearchSkillResult>,
  'kb-enable': async (args, ctx) => kbEnable(args as KbEnableArgs, ctx) as Promise<KbEnableResult>,
  'spec': async (args, ctx) => spec(args as SpecArgs, ctx) as Promise<SpecResult | { status: 'failed'; error: string }>,
  'plan': async (args, ctx) => plan(args as PlanArgs, ctx) as Promise<PlanResult | { status: 'failed'; error: string }>,
  'bugfix': async (args, ctx) => bugfix(args as BugfixArgs, ctx) as Promise<BugfixResult | { status: 'failed'; error: string }>,
  'react-core-skills': async (args, ctx) => reactCoreSkills(args as ReactCoreSkillsArgs, ctx) as Promise<ReactCoreSkillsResult | { status: 'failed'; error: string }>,
}

let cachedSkills: Skill[] | null = null

/**
 * 列出全部 skill。
 * v0.6.0：从文件夹存储读取（{arkworkDir}/skills/{id}/skill.json），
 * 首次启动若不存在则迁移旧 skills.json，再不济返回 builtin。
 * 渐进式披露：仅读 skill.json（~200 bytes），不读 SKILL.md。
 */
export async function listSkills(): Promise<Skill[]> {
  if (cachedSkills) return cachedSkills
  const skillsDir = join(getArkworkDir(), 'skills')
  // 1. 文件夹存储不存在 → 尝试迁移旧 skills.json
  if (!existsSync(skillsDir)) {
    await migrateLegacySkillsJson()
  }
  // 2. 扫描所有子文件夹，读 skill.json
  if (existsSync(skillsDir)) {
    const skills = await loadSkillsFromFolders(skillsDir)
    if (skills.length > 0) {
      cachedSkills = skills
      return cachedSkills
    }
  }
  // 3. fallback：内置 skill
  cachedSkills = builtinSkills.map((s) => {
    if (s.instructionMd && !isAbsolute(s.instructionMd)) {
      // 仓库内置 SKILL.md：相对 app/src/main/skills/builtin/{id}/ 解析
      const builtinPath = join(getArkworkDir(), '..', '..', '..', s.instructionMd)
      return { ...s, instructionMd: builtinPath }
    }
    return s
  })
  return cachedSkills
}

export async function getSkill(id: string): Promise<Skill | null> {
  const skills = await listSkills()
  return skills.find((s) => s.id === id) ?? null
}

/**
 * v0.6.1：返回 Skill 的 LLM 工具名（ASCII 安全）。
 * 优先用 skill.toolName（SkillHub 等第三方技能安装时写入 slug）；
 * 否则由 name 生成（小写、非字母数字转连字符、截断）。
 */
export function skillToolName(skill: Skill): string {
  if (skill.toolName) return skill.toolName
  const slug = skill.name
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
  // v0.8.0：中文/纯符号名生成的 slug 为空 → 用 id 派生 ASCII 名，避免多个技能都退化为 "skill"
  if (slug) return slug
  const fromId = skill.id.replace(/^S-/, '').replace(/\./g, '-')
  return fromId || 'skill'
}

export function skillToLlmTool(skill: Skill): LlmTool {
  return {
    type: 'function',
    function: {
      name: skillToolName(skill),
      description: skill.description,
      parameters: skill.inputSchema ?? { type: 'object', properties: {} },
    },
  }
}

/**
 * 调用 Skill。返回结果与简短摘要。
 *
 * v0.6.0 渐进式披露（§4.5）：
 *  - 若 skill.instructionMd 指向有效文件，读取全文写入 ctx.additionalSystemHint
 *  - engine 在下一轮 Reason 时将 additionalSystemHint 合并到 system 提示
 *  - 列表阶段（listSkills）不读 instructionMd，仅在 invoke 时按需加载
 */
export async function invokeSkill(
  skillId: string,
  args: Record<string, unknown>,
  ctx: SkillContext,
): Promise<{ result: unknown; summary: string }> {
  const skill = await getSkill(skillId)
  if (!skill) {
    throw new Error(`Skill not found: ${skillId}`)
  }

  // 渐进式披露：按需加载 SKILL.md 指令体
  if (skill.instructionMd) {
    try {
      const instruction = await readFile(skill.instructionMd, 'utf-8')
      // v0.16.5：多内容技能支持——在指令末尾追加技能目录路径提示，
      // 让 LLM 能用 file-reader（绝对路径）访问 references/ assets/ 等子目录文件。
      // 之前版本只读单文件，LLM 即使看到"references/xxx.md"指引也无法解析路径。
      const skillDir = dirname(skill.instructionMd)
      const extrasHint = await buildSkillExtrasHint(skillDir)
      ctx.additionalSystemHint = extrasHint
        ? `${instruction}\n\n---\n${extrasHint}`
        : instruction
    } catch (err) {
      logger.warn('Tool', `failed to load instructionMd for ${skill.id}: ${(err as Error).message}`, ctx.taskId)
    }
  }

  if (skill.source === 'builtin' && skill.builtinHandler) {
    const handler = handlers[skill.builtinHandler]
    if (!handler) {
      throw new Error(`No handler for builtin skill: ${skill.builtinHandler}`)
    }
    // needsConfirmation：v0.8.1 起经 renderer 美观浮层确认（默认注入），
    // shell 场景先按命令安全分级决定是否真的需要询问。
    // v0.14.0 Task 6：使用新的 4 级 risk level 评估；
    //  - workspace-readonly / external-readonly：直接放行（不进 confirm 链路，不报"被拒绝"）
    //  - workspace-light-write：首次确认后本会话记住
    //  - high-risk：每次都问
    //  - reject：直接拒绝
    if (skill.needsConfirmation && !ctx.confirm) {
      ctx.confirm = makeRendererConfirm()
    }
    if (skill.needsConfirmation && ctx.confirm) {
      let outcome: ConfirmOutcome = { allowed: true }
      if (skill.builtinHandler === 'shell') {
        const argsRec = args as Record<string, unknown>
        // v0.15.x 防御：LLM 偶发把 command 字段传成嵌套对象（如 { command: { command: '...' } }），
        // 直接 String() 会得到 '[object Object]'，既污染弹窗也会触发高风险误判。
        // 尝试按字符串 → 嵌套 command → JSON.stringify 顺序回退。
        let cmd = ''
        const rawCmd = argsRec.command
        if (typeof rawCmd === 'string') {
          cmd = rawCmd
        } else if (rawCmd && typeof rawCmd === 'object') {
          const inner = (rawCmd as Record<string, unknown>).command
          cmd = typeof inner === 'string' ? inner : ''
          if (!cmd) cmd = JSON.stringify(rawCmd)
        }
        cmd = cmd.trim()
        // v0.15.x polish6：shell command 长度上限。
        // 超长命令（典型：>4KB heredoc 写文件）会被 Anthropic streaming 截断，
        // reconcileToolCalls 剥离 dangling toolCalls 后内容直接落到 thought UI，
        // 污染显示且无法真正执行。一律拒绝，引导 Agent 用专用写文件技能。
        const MAX_SHELL_COMMAND_LENGTH = 4096
        if (cmd.length > MAX_SHELL_COMMAND_LENGTH) {
          logger.warn(
            'Tool',
            `shell command too large (${cmd.length} bytes > ${MAX_SHELL_COMMAND_LENGTH}) — reject, suggest file-writer`,
            ctx.taskId,
          )
          return {
            result: {
              error: `shell: command 过长（${cmd.length} 字节 > ${MAX_SHELL_COMMAND_LENGTH} 字节）。请改用 file-writer 或 file-editor 技能。`,
              tooLarge: true,
              sizeBytes: cmd.length,
              suggestion: 'file-writer / file-editor',
            },
            summary: `命令过长（${cmd.length} 字节），已拒绝。请改用 file-writer 或 file-editor 技能。`,
          }
        }
        const wsDir = ctx.workspaceDir ?? getWorkspaceDir()
        const risk = assessCommandRisk(cmd, wsDir)
        // 1) 拒绝类（黑名单 / 不可执行）
        if (risk.level === 'reject') {
          logger.warn('Tool', `shell rejected: ${cmd.slice(0, 120)}`, ctx.taskId)
          return {
            result: { error: '命令被安全策略拦截（高危操作），已拒绝执行' },
            summary: '命令被拒绝：命中高危规则，请改用安全命令',
          }
        }
        // 2) 工作区内只读 / 工作区外只读：直接放行，不进确认链路（不弹框、不报「用户拒绝」）
        if (risk.level === 'workspace-readonly' || risk.level === 'external-readonly') {
          outcome = { allowed: true }
        }
        // 3) 工作区轻写：按 mode 决定是否走确认。
        //    - plan 模式：deny（拒绝写入，与 MODE_POLICIES 一致）
        //    - default / acceptEdits：放行（不再弹窗打扰；与 MODE_POLICIES + shell.ts 一致）
        //    - 其他（兜底）：保留旧行为（首次确认后记住）
        else if (risk.level === 'workspace-light-write') {
          const mode = await resolveEffectivePermissionMode(wsDir)
          const policy = MODE_POLICIES[mode].workspaceLightWrite
          if (policy === 'allow') {
            outcome = { allowed: true }
          } else if (policy === 'deny') {
            return {
              result: { error: `当前模式（${mode}）禁止工作区内写入` },
              summary: `当前模式（${mode}）禁止写入`,
            }
          } else {
            outcome = await ctx.confirm({
              requestId: '',
              skillName: '运行命令',
              command: cmd,
              cwd: ctx.workspaceDir,
              impacts: risk.impacts,
              risk: 'low',
              taskId: ctx.taskId,
            })
            if (outcome.allowed) {
              approveCommandForSession(cmd)
            }
          }
        }
        // 4) 高风险：每次都问（勾选「本次会话不再询问」才记住）
        else {
          outcome = await ctx.confirm({
            requestId: '',
            skillName: '运行命令',
            command: cmd,
            cwd: ctx.workspaceDir,
            impacts: risk.impacts,
            risk: risk.impacts.some((i) => /删除|不可恢复|重置|管理员|覆盖|管理员|解压/.test(i)) ? 'high' : 'medium',
            taskId: ctx.taskId,
          })
        }
      } else {
        // polish4 §C1.2：非 shell builtin 走统一评估；workspace-readonly / external-readonly 直通
        const risk = assessToolRisk(skill, args)
        if (risk.level === 'workspace-readonly' || risk.level === 'external-readonly') {
          outcome = { allowed: true }
        } else {
          // 其他需要确认的工具：展示技能名 + 参数摘要
          const argsPreview = JSON.stringify(args, null, 2).slice(0, 500)
          outcome = await ctx.confirm({
            requestId: '',
            skillName: skill.name,
            impacts: risk.impacts,
            risk: risk.level === 'workspace-light-write' ? 'low' : 'medium',
            argsSummary: argsPreview,
            taskId: ctx.taskId,
          })
        }
      }
      if (!outcome.allowed) {
        // 误报修复：只有用户显式点击「拒绝」才记为「用户拒绝执行」；
        // 对话框被关闭（Esc/点背景）或 60s 超时都不算用户拒绝。
        const msg =
          outcome.reason === 'denied'
            ? '用户拒绝执行'
            : outcome.reason === 'timeout'
              ? '命令确认超时，未执行'
              : '命令确认已取消，未执行'
        return { result: { error: msg }, summary: msg }
      }
    }
    const startedAt = Date.now()
    const result = await handler(args, ctx)
    const summary = summarizeResult(skill.builtinHandler, result)
    logger.info('Tool', `skill ${skill.name} (${Date.now() - startedAt}ms)`, ctx.taskId)
    return { result, summary }
  }

  if (skill.source === 'mcp' && skill.mcpRef) {
    // v0.6.0：由 mcp/client.ts 路由（M8 实现）
    const { callMcpTool } = await import('../mcp/client.js')
    const startedAt = Date.now()
    const result = await callMcpTool(skill.mcpRef.serverId, skill.mcpRef.toolName, args, ctx.signal)
    const summary = `[mcp:${skill.mcpRef.serverId}.${skill.mcpRef.toolName}] ${JSON.stringify(result).slice(0, 200)}`
    logger.info('Tool', `mcp skill ${skill.name} (${Date.now() - startedAt}ms)`, ctx.taskId)
    return { result, summary }
  }

  // v0.8.0：指令型技能（custom / market / imported 等无内置 handler、无 mcpRef 的技能）。
  // 按市面通用方式（Anthropic/SkillHub 风格）：SKILL.md 即指令体，LLM 调用后获得全文，
  // 自行按步骤执行（必要时配合 file-reader / shell 等基础工具）。
  // 上一段已把 instructionMd 读入 ctx.additionalSystemHint，这里直接返回给 LLM。
  const instruction = ctx.additionalSystemHint ?? ''
  if (instruction.trim()) {
    const resultText = `【技能：${skill.name}】\n\n${instruction}`
    return {
      result: { instruction: resultText },
      summary: `已加载技能 ${skill.name} 的指令（${resultText.length} 字符），请严格按指令执行`,
    }
  }

  // 无指令体也无处理器：给出可操作的提示，避免模型卡死
  return {
    result: {
      instruction: `技能「${skill.name}」没有可执行的内容（缺少 SKILL.md 指令或处理器）。请跳过该技能，改用其他可用工具完成目标。`,
    },
    summary: `技能 ${skill.name} 无可执行内容，已提示模型跳过`,
  }
}

/* ============================================================
 * Skill 文件夹存储（M5/M6 共用）
 *
 * 目录结构：
 *   {arkworkDir}/skills/
 *   ├── S-core.file-reader/
 *   │   ├── skill.json       # 元数据（不含 instructionMd 内容，仅存相对路径）
 *   │   └── SKILL.md         # 可选指令体
 *   └── S-custom.xxx/
 *       ├── skill.json
 *       └── SKILL.md
 * ============================================================ */

/** skill.json 的持久化结构（与 Skill 接口一致，instructionMd 字段存相对路径或文件名） */
export async function writeSkillToFolder(skill: Skill, instructionMdContent?: string): Promise<void> {
  const dir = join(getArkworkDir(), 'skills', skill.id)
  await mkdir(dir, { recursive: true })
  // 若提供指令体内容，写入 SKILL.md 并在元数据中标记
  let persistSkill: Skill = { ...skill }
  if (instructionMdContent !== undefined) {
    await writeFile(join(dir, 'SKILL.md'), instructionMdContent, 'utf-8')
    persistSkill = { ...skill, instructionMd: 'SKILL.md' }
  }
  await writeFile(join(dir, 'skill.json'), JSON.stringify(persistSkill, null, 2), 'utf-8')
  // 失效缓存
  cachedSkills = null
}

/** 删除 skill 文件夹 */
export async function deleteSkillFolder(skillId: string): Promise<void> {
  const dir = join(getArkworkDir(), 'skills', skillId)
  if (existsSync(dir)) {
    await rm(dir, { recursive: true, force: true })
  }
  cachedSkills = null
}

/** 读取 skill 文件夹内的 SKILL.md 内容（用于编辑器回填） */
export async function readSkillInstruction(skillId: string): Promise<string | null> {
  const dir = join(getArkworkDir(), 'skills', skillId)
  const mdPath = join(dir, 'SKILL.md')
  if (!existsSync(mdPath)) return null
  try {
    return await readFile(mdPath, 'utf-8')
  } catch {
    return null
  }
}

/** 失效 skill 内存缓存（CRUD 后调用） */
export function invalidateSkillCache(): void {
  cachedSkills = null
}

/** 从文件夹存储加载全部 skill 元数据 */
async function loadSkillsFromFolders(skillsDir: string): Promise<Skill[]> {
  const result: Skill[] = []
  let entries: string[]
  try {
    entries = await readdir(skillsDir)
  } catch {
    return result
  }
  for (const name of entries) {
    const dir = join(skillsDir, name)
    // 只处理目录
    try {
      if (!(await stat(dir)).isDirectory()) continue
    } catch {
      continue
    }
    const skillJsonPath = join(dir, 'skill.json')
    if (existsSync(skillJsonPath)) {
      // 格式 A：skill.json（ArkWork 原生 / 用户自定义）
      try {
        const raw = await readFile(skillJsonPath, 'utf-8')
        const skill = JSON.parse(raw) as Skill
        // 兼容旧数据：未设 enabled 字段默认 true
        if (skill.enabled === undefined) skill.enabled = true
        // instructionMd 转为绝对路径（listSkills 不读内容，invokeSkill 才读）
        if (skill.instructionMd && !isAbsolute(skill.instructionMd)) {
          skill.instructionMd = join(dir, skill.instructionMd)
        }
        result.push(skill)
      } catch (err) {
        logger.warn('Tool', `failed to parse skill.json for ${name}: ${(err as Error).message}`)
      }
      continue
    }
    // 格式 B：SKILL.md-only（v0.6.1，SkillHub 等第三方标准格式）
    // 无 skill.json 但有 SKILL.md → 解析 frontmatter 生成 Skill 元数据
    if (existsSync(join(dir, 'SKILL.md'))) {
      const skill = parseSkillMdOnly(dir, name)
      if (skill) result.push(skill)
    }
  }
  return result
}

/**
 * v0.6.1：解析 SKILL.md-only 目录（Anthropic/SkillHub 标准格式）。
 * frontmatter 示例：
 *   ---
 *   name: weekly-report-pro
 *   description: 生成周报
 *   ---
 * 元数据规则：id=目录名（保证删除/指令读取路径一致）；toolName=目录名（ASCII 安全）；
 * name/description 从 frontmatter 读取（缺省用目录名）。
 */
function parseSkillMdOnly(dir: string, folderName: string): Skill | null {
  const mdPath = join(dir, 'SKILL.md')
  let raw: string
  try {
    raw = readFileSync(mdPath, 'utf-8')
  } catch {
    return null
  }
  let name = folderName
  let description = ''
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (fm) {
    const nameMatch = fm[1].match(/^name:\s*(.+)$/m)
    const descMatch = fm[1].match(/^description:\s*(.+)$/m)
    if (nameMatch) name = nameMatch[1].trim()
    if (descMatch) description = descMatch[1].trim()
  }
  return {
    id: folderName,
    name,
    description: description || `${folderName}（SkillHub 技能）`,
    namespace: 'market',
    source: 'market',
    enabled: true,
    toolName: folderName,
    instructionMd: 'SKILL.md',
    inputSchema: { type: 'object', properties: {} },
    tags: ['skillhub'],
    installedFrom: `skillhub.${folderName}`,
  }
}

/**
 * 迁移：把旧 skills.json（扁平数组）拆分为文件夹结构。
 * 原文件备份为 skills.json.bak。内置 skill 也一并写入文件夹。
 */
async function migrateLegacySkillsJson(): Promise<void> {
  const legacyPath = join(getArkworkDir(), 'skills.json')
  if (!existsSync(legacyPath)) {
    // 无旧文件 → 直接播种内置 skill 到文件夹
    await seedBuiltinSkillsToFolders()
    return
  }
  try {
    const raw = await readFile(legacyPath, 'utf-8')
    const skills = JSON.parse(raw) as Skill[]
    // 写入文件夹结构
    for (const skill of skills) {
      if (skill.enabled === undefined) skill.enabled = true
      await writeSkillToFolder(skill)
    }
    // 补齐内置 skill（若旧 skills.json 不包含新加的 shell / fetch-url / delegate-agent）
    await seedBuiltinSkillsToFolders()
    // 备份原文件
    const bakPath = join(getArkworkDir(), 'skills.json.bak')
    if (!existsSync(bakPath)) {
      await copyFile(legacyPath, bakPath)
    }
    // 删除旧文件（避免下次再次迁移）
    await rm(legacyPath, { force: true })
    logger.info('System', `migrated skills.json → folder storage (${skills.length} skills)`)
  } catch (err) {
    logger.error('System', `migrate skills.json failed: ${(err as Error).message}`)
    // 失败时 fallback 到内置 skill
    await seedBuiltinSkillsToFolders()
  }
}

/** 把内置 skill 同步到文件夹存储。
 * v0.6.2：已存在时也会覆盖更新元数据（description/inputSchema 等），但保留用户修改过的 enabled 状态。
 */
export async function seedBuiltinSkillsToFolders(): Promise<void> {
  const skillsDir = join(getArkworkDir(), 'skills')
  for (const skill of builtinSkills) {
    const dir = join(skillsDir, skill.id)
    await mkdir(dir, { recursive: true })
    let next: Skill = skill
    const metaPath = join(dir, 'skill.json')
    if (existsSync(metaPath)) {
      try {
        const raw = await readFile(metaPath, 'utf-8')
        const existing = JSON.parse(raw) as Skill
        // 保留用户可能手动关闭/开启的 enabled；其余字段以内置最新版为准
        next = { ...skill, enabled: existing.enabled ?? skill.enabled }
      } catch {
        // 解析失败则直接覆盖
      }
    }
    await writeSkillToFolder(next)
  }
}

function isAbsolute(p: string): boolean {
  return p.startsWith('/') || /^[a-zA-Z]:/.test(p)
}

/**
 * v0.16.5：扫描 skill 目录下的额外资源文件（references/assets 等子目录），
 * 生成给 LLM 的路径提示。仅当存在额外文件时返回非空字符串。
 *
 * 提示格式：
 *   【技能资源目录】
 *   - 技能目录：/abs/path/to/skills/S-xxx
 *   - 资源文件（按需用 file-reader 读取绝对路径）：
 *     - references/00-opensource-research-template.md
 *     - references/01-prd-template.md
 *     - assets/example-prototype.html
 *   - 读取示例：file-reader(path="/abs/path/to/skills/S-xxx/references/00-opensource-research-template.md")
 *
 * 限制：最多列 20 个文件，超出用 "..." 概括，避免 hint 过长污染 system prompt。
 */
async function buildSkillExtrasHint(skillDir: string): Promise<string> {
  if (!existsSync(skillDir)) return ''
  const CORE_FILES = new Set(['skill.json', 'SKILL.md', 'skill.md'])
  const files: string[] = []
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        await walk(p)
      } else if (e.isFile()) {
        const isRoot = dir === skillDir
        if (isRoot && CORE_FILES.has(e.name)) continue
        if (e.name === '.DS_Store') continue
        files.push(relative(skillDir, p).split(sep).join('/'))
      }
    }
  }
  try {
    await walk(skillDir)
  } catch {
    return ''
  }
  if (files.length === 0) return ''
  files.sort()
  const MAX_LIST = 20
  const listed = files.slice(0, MAX_LIST)
  const more = files.length > MAX_LIST ? `\n     - … (还有 ${files.length - MAX_LIST} 个文件)` : ''
  const fileList = listed.map((f) => `     - ${f}`).join('\n')
  return [
    '【技能资源目录】',
    `- 技能目录：${skillDir}`,
    '- 资源文件（按需用 file-reader 读取绝对路径，不要用相对路径）：',
    fileList + more,
    `- 读取示例：file-reader(path="${skillDir}/${listed[0]}")`,
  ].join('\n')
}

function summarizeResult(handler: string, result: unknown): string {
  if (
    result &&
    typeof result === 'object' &&
    'status' in result &&
    (result as { status: unknown }).status === 'failed' &&
    'error' in result
  ) {
    return `failed: ${(result as { error: string }).error.slice(0, 200)}`
  }
  if (handler === 'file-reader') {
    const r = result as FileReaderResult
    return `${r.lines} lines · ${r.size} bytes · ${r.path}`
  }
  if (handler === 'file-writer') {
    const r = result as FileWriterResult
    return `wrote ${r.bytes} bytes · ${r.lines} lines · ${r.path}`
  }
  if (handler === 'file-editor') {
    const r = result as FileEditorResult
    return `edited ${r.path} · ${r.replacements} replacements`
  }
  if (handler === 'glob-search') {
    const r = result as GlobSearchResult
    return `${r.total} matches for "${r.pattern}"`
  }
  if (handler === 'grep-search') {
    const r = result as GrepSearchResult
    return `${r.total} hits for "${r.pattern}" in ${r.scannedFiles} files`
  }
  if (handler === 'web-search') {
    const r = result as WebSearchResult
    return `${r.total} results for "${r.query}"`
  }
  if (handler === 'fetch-url') {
    const r = result as FetchUrlResult
    return `${r.chars} chars from ${r.url}`
  }
  if (handler === 'shell') {
    const r = result as ShellResult
    return `exit=${r.exitCode} · ${r.stdout.length + r.stderr.length} chars`
  }
  if (handler === 'task_complete') {
    return `task_complete acknowledged`
  }
  if (handler === 'ask_user') {
    return `ask_user acknowledged`
  }
  if (handler === 'delegate-agent') {
    const r = result as DelegateResult
    return `delegated to ${r.agentId} · ${r.summary.slice(0, 100)}`
  }
  if (handler === 'session-search') {
    const r = result as SessionSearchResult
    return `${r.total} archive hits for "${r.query}"`
  }
  if (handler === 'react-core-skills') {
    const r = result as ReactCoreSkillsResult
    return `react-core-skills instruction loaded (${r.instruction.length} chars)`
  }
  return JSON.stringify(result).slice(0, 200)
}

/** 构造一个用 Electron 原生 dialog 实现的 confirm 函数（main 进程内使用） */
function makeNativeConfirm(): (message: string) => Promise<boolean> {
  return async (message: string) => {
    const { getMainWindow } = await import('../window.js')
    const win = getMainWindow()
    const result = await dialog.showMessageBox(win!, {
      type: 'question',
      title: 'ArkWork · Skill 确认',
      message: 'Agent 请求执行操作',
      detail: message,
      buttons: ['允许执行', '拒绝'],
      defaultId: 1,
      cancelId: 1,
    })
    return result.response === 0
  }
}

/* ============================================================
 * v0.8.1：工具执行确认（Main → Renderer 美观浮层）
 *
 * 流程：
 *  - makeRendererConfirm 推送 ToolConfirmRequest 到 renderer（tool:confirm 通道）
 *  - renderer 展示浮层（命令原文 + 影响说明），用户点「允许/拒绝」后
 *    经 tool:confirm:respond IPC 回传 → respondToolConfirm 兑现 Promise
 *  - 会话内已批准的同一条命令不再重复询问（对齐 GitHub Copilot CLI
 *    "approve for session" 体验）
 *  - v0.14.0 Task 6 误报修复：
 *    60s 无响应按「超时」处理（reason='timeout'），不当作「用户拒绝」；
 *    Esc / 点背景关闭按「取消」处理（reason='dismissed'）。
 *    只有用户显式点击「拒绝」按钮才是 reason='denied'（真正报「用户拒绝执行」）。
 * ============================================================ */
const pendingToolConfirms = new Map<
  string,
  { resolve: (outcome: ConfirmOutcome) => void; command?: string }
>()

/** 会话内已批准的命令（key = 去空白后的完整命令） */
const sessionApprovedCommands = new Set<string>()

/**
 * 解析当前任务实际生效的 PermissionMode。
 * 优先级：session override > settings.defaultMode > agent.defaultPermissionMode > 'default'。
 * 与 shell.ts 的解析逻辑保持一致，确保两条路径（registry 内置 shell handler /
 * shell.ts 子流程）对同一任务使用同一 mode。
 */
async function resolveEffectivePermissionMode(workspaceDir?: string): Promise<PermissionMode> {
  try {
    const settings = workspaceDir ? await loadPermissionSettings(workspaceDir) : null
    let candidate: PermissionMode = getSessionMode(workspaceDir ?? '') ?? settings?.defaultMode ?? 'default'
    return candidate
  } catch {
    return 'default'
  }
}

/** 本会话记住某条命令为已批准（工作区轻写首次确认后自动调用，同命令不再弹） */
export function approveCommandForSession(cmd: string): void {
  const key = (cmd ?? '').trim()
  if (!key) return
  sessionApprovedCommands.add(key)
  logger.info('Tool', `shell light-write approved for session: ${key.slice(0, 120)}`)
}

/** renderer 回传确认结果时由 ipc/tool.ts 调用 */
export function respondToolConfirm(
  requestId: string,
  allowed: boolean,
  session = false,
  reason: 'allowed' | 'denied' | 'dismissed' = 'denied',
): void {
  const entry = pendingToolConfirms.get(requestId)
  if (!entry) return
  pendingToolConfirms.delete(requestId)
  if (allowed && session && entry.command) {
    sessionApprovedCommands.add(entry.command)
    logger.info('Tool', `shell approved for session: ${entry.command.slice(0, 120)}`)
  }
  const outcome: ConfirmOutcome = allowed
    ? { allowed: true }
    : { allowed: false, reason: reason === 'dismissed' ? 'dismissed' : 'denied' }
  entry.resolve(outcome)
}

/** 构造经 renderer 美观浮层确认的 confirm 函数；无窗口时回退原生 dialog */
function makeRendererConfirm(): (req: ToolConfirmRequest) => Promise<ConfirmOutcome> {
  return async (req) => {
    // 会话内同命令已批准 → 直接放行，不再打扰用户
    if (req.command) {
      const key = req.command.trim()
      if (sessionApprovedCommands.has(key)) return { allowed: true }
    }
    const { getMainWindow } = await import('../window.js')
    const win = getMainWindow()
    if (!win || win.isDestroyed()) {
      const native = makeNativeConfirm()
      const detail = req.command
        ? `命令：\n${req.command}\n\n影响：\n${req.impacts.join('\n')}`
        : req.impacts.join('\n')
      const allowed = await native(detail)
      // 原生 dialog 无法区分「拒绝按钮 / Esc / 关闭」，统一按取消处理，不报「用户拒绝」
      return allowed ? { allowed: true } : { allowed: false, reason: 'dismissed' }
    }
    const requestId = randomUUID()
    return new Promise<ConfirmOutcome>((resolve) => {
      pendingToolConfirms.set(requestId, {
        resolve,
        command: req.command?.trim(),
      })
      win.webContents.send('tool:confirm', { ...req, requestId })
      // 60s 未响应 → 按超时处理（不是「用户拒绝」）
      setTimeout(() => {
        const entry = pendingToolConfirms.get(requestId)
        if (entry) {
          pendingToolConfirms.delete(requestId)
          entry.resolve({ allowed: false, reason: 'timeout' })
        }
      }, 60_000)
    })
  }
}
