/* ============================================================
 * ArkWork — 工作区上下文构建器（v0.24.x）
 *
 * 借鉴 opencode / claude code 的做法，把工作区结构 / 环境信息 / 项目级规则
 * 自动注入到 system prompt，让 LLM「睁开眼就看见项目全貌」，无需反复 glob-search
 * 试探目录、读 README 推断栈、写 cat 才发现 cwd。
 *
 * 三大块（每块都是「启动时构建、运行期不变」的稳定段，可放 system 命中前缀缓存）：
 *   1. <env> 环境信息：cwd / git repo / platform / date / node / os
 *   2. <project> 项目结构：前 2 层目录树 + 关键文件列表（package.json 等）
 *   3. <agents-md> 项目规则：cwd 向上找的 AGENTS.md / CLAUDE.md / CONTEXT.md 内容
 *   4. <stack> 技术栈：自动检测 package.json 的 dependencies / devDependencies
 *
 * 设计要点：
 *   - 全部为纯函数，IO 在 buildWorkspaceContext() 内一次性完成
 *   - 失败回退：每个子模块 catch + 静默，不影响主流程
 *   - 大小控制：目录树、文件列表均设上限，避免撑爆 system prompt
 *   - 与 prompt-assembly 集成：返回单字符串直接作为 section.text 注入
 *
 * 与 opencode/claude code 的差异：
 *   - opencode: env+project 在 system，AGENTS.md 自动发现 + 优先级
 *   - claude code: CLAUDE.md 自动注入到 system，agents/ 子代理可声明自己的 md
 *   - ArkWork: 全部一次性拼好（简单为先），保留全局 ~/.arkwork/AGENTS.md 兜底
 * ============================================================ */
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs'
import { join, relative, resolve, basename, dirname, sep } from 'node:path'
import { execFileSync } from 'node:child_process'
import { platform } from 'node:os'

/* ---------- 1. <env> 环境信息 ---------- */

export interface EnvInfo {
  cwd: string
  workspaceDir: string
  isGitRepo: boolean
  gitBranch: string | null
  platform: NodeJS.Platform
  osVersion: string | null
  date: string
}

export function buildEnvInfo(workspaceDir: string): EnvInfo {
  let isGitRepo = false
  let gitBranch: string | null = null
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: workspaceDir, stdio: 'ignore' })
    isGitRepo = true
    try {
      gitBranch = execFileSync('git', ['branch', '--show-current'], { cwd: workspaceDir, encoding: 'utf-8' }).trim() || null
    } catch { /* 无分支信息不影响主流程 */ }
  } catch { /* 非 git 仓库或 git 未安装 */ }

  let osVersion: string | null = null
  if (platform() === 'darwin') {
    try {
      osVersion = execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf-8' }).trim()
    } catch { /* ignore */ }
  }

  return {
    cwd: process.cwd(),
    workspaceDir,
    isGitRepo,
    gitBranch,
    platform: platform(),
    osVersion,
    date: new Date().toISOString().slice(0, 10),
  }
}

export function renderEnvBlock(info: EnvInfo): string {
  const lines: string[] = [
    '## 环境信息',
    '',
    '<env>',
    `工作区根目录：${info.workspaceDir}`,
    `当前进程 cwd：${info.cwd}`,
    `Git 仓库：${info.isGitRepo ? '是' : '否'}${info.gitBranch ? `（分支 ${info.gitBranch}）` : ''}`,
    `平台：${info.platform}${info.osVersion ? ` ${info.osVersion}` : ''}`,
    `日期：${info.date}`,
    '</env>',
  ]
  return lines.join('\n')
}

/* ---------- 2. <project> 项目结构（目录树 + 关键文件）---------- */

/** 默认排除的目录（与 legacyGlob 一致，避免撑爆 system） */
const DEFAULT_EXCLUDED_DIRS = new Set([
  'node_modules', '.git', '.arkwork', 'dist', 'build', '.next', '.nuxt', '.cache',
  'coverage', '.turbo', '.vercel', 'target', 'out', 'release',
])

const MAX_TREE_NODES = 200  // 总节点上限
const MAX_TREE_DEPTH = 2     // 顶层 0/1/2 层

export interface ProjectTree {
  /** 缩进形式的目录树（不含文件大小 / 时间戳，节省 token） */
  tree: string
  /** 关键文件清单（package.json、tsconfig.json 等），相对工作区 */
  keyFiles: string[]
  /** 工作区根下的顶层条目（用于快速浏览） */
  rootEntries: string[]
}

function buildTree(
  dir: string,
  workspaceDir: string,
  depth: number,
  counter: { count: number },
): string[] {
  if (counter.count >= MAX_TREE_NODES) return []
  if (depth > MAX_TREE_DEPTH) return []

  let entries: Array<import('node:fs').Dirent<string>>
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }

  // 排序：目录在前，文件在后，按字母序
  entries.sort((a, b) => {
    const ad = a.isDirectory() ? 0 : 1
    const bd = b.isDirectory() ? 0 : 1
    if (ad !== bd) return ad - bd
    return a.name.localeCompare(b.name)
  })

  const lines: string[] = []
  const indent = '  '.repeat(depth)
  for (const e of entries) {
    if (counter.count >= MAX_TREE_NODES) break
    if (DEFAULT_EXCLUDED_DIRS.has(e.name)) continue
    if (e.name.startsWith('.') && depth > 0) continue  // 隐藏 .xxx 内部目录（除根的 . 开头的）
    if (e.isDirectory()) {
      lines.push(`${indent}${e.name}/`)
      counter.count++
      const child = buildTree(join(dir, e.name), workspaceDir, depth + 1, counter)
      lines.push(...child)
    } else {
      lines.push(`${indent}${e.name}`)
      counter.count++
    }
  }
  return lines
}

const KEY_FILES = [
  'package.json', 'tsconfig.json', 'tsconfig.node.json', 'vite.config.ts',
  'electron.vite.config.ts', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock',
  'README.md', 'CLAUDE.md', 'AGENTS.md', 'CONTEXT.md',
  '.gitignore', 'index.html', 'main.js', 'main.ts',
  'Cargo.toml', 'go.mod', 'composer.json', 'build.gradle', 'build.gradle.kts',
  'pom.xml', 'requirements.txt', 'pyproject.toml',
]

export function buildProjectTree(workspaceDir: string): ProjectTree {
  const counter = { count: 0 }
  const lines = buildTree(workspaceDir, workspaceDir, 0, counter)
  const tree = lines.join('\n') || '(空目录)'

  // 关键文件清单
  const keyFiles: string[] = []
  for (const f of KEY_FILES) {
    const p = join(workspaceDir, f)
    if (existsSync(p) && statSync(p).isFile()) {
      keyFiles.push(f)
    }
  }

  // 根目录条目
  let rootEntries: string[] = []
  try {
    const es = readdirSync(workspaceDir, { withFileTypes: true })
    rootEntries = es
      .filter((e) => !DEFAULT_EXCLUDED_DIRS.has(e.name))
      .map((e) => e.name + (e.isDirectory() ? '/' : ''))
      .sort()
  } catch { /* ignore */ }

  return { tree, keyFiles, rootEntries }
}

export function renderProjectBlock(tree: ProjectTree): string {
  const lines: string[] = [
    '## 项目结构',
    '',
    '<project>',
    '顶层条目：',
    tree.rootEntries.map((e) => `  - ${e}`).join('\n'),
    '',
    `目录树（前 ${MAX_TREE_DEPTH + 1} 层，共 ${tree.tree.split('\n').length} 个节点）：`,
    '```',
    tree.tree,
    '```',
    '',
    '关键文件：',
    tree.keyFiles.length > 0
      ? tree.keyFiles.map((f) => `  - ${f}`).join('\n')
      : '  (未发现)',
    '</project>',
  ]
  return lines.join('\n')
}

/* ---------- 3. <agents-md> 项目规则（AGENTS.md / CLAUDE.md）---------- */

const AGENT_FILE_NAMES = ['AGENTS.md', 'CLAUDE.md', 'CONTEXT.md'] as const
const GLOBAL_AGENT_PATHS = [
  // 全局兜底（类比 claude code 的 ~/.claude/CLAUDE.md）
  // v0.25.0 F1 fix：原路径 join(HOME, '.arkworkAGENTS.md') 少了目录分隔符，
  // 全局规则文件永不加载 —— 修正为 ~/.arkwork/AGENTS.md / ~/.arkwork/CLAUDE.md
  join(process.env.HOME || '', '.arkwork', 'AGENTS.md'),
  join(process.env.HOME || '', '.arkwork', 'CLAUDE.md'),
]
const MAX_AGENT_FILE_BYTES = 8 * 1024  // 单文件 8KB 上限（避免撑爆 system）

export interface AgentFiles {
  /** 从 cwd 向上找到的第一个文件（最具体优先），按优先级合并 */
  projectFiles: Array<{ name: string; relPath: string; content: string }>
  /** 全局兜底文件 */
  globalFiles: Array<{ path: string; content: string }>
}

function findProjectAgentFile(workspaceDir: string): string | null {
  // 从 workspaceDir 向上找 AGENTS.md / CLAUDE.md / CONTEXT.md，找到第一个存在的就停
  let dir = resolve(workspaceDir)
  const root = resolve(dir, sep)  // 根目录 sentinel
  for (let depth = 0; depth < 6; depth++) {  // 最多向上 6 层
    for (const name of AGENT_FILE_NAMES) {
      const p = join(dir, name)
      if (existsSync(p) && statSync(p).isFile()) {
        return p
      }
    }
    if (dir === root) break
    const parent = dirname(dir)
    if (parent === dir) break  // 到根了
    dir = parent
  }
  return null
}

function safeRead(p: string): string | null {
  try {
    if (!existsSync(p) || !statSync(p).isFile()) return null
    if (statSync(p).size > MAX_AGENT_FILE_BYTES) {
      // 超大文件：截断并标注
      const buf = readFileSync(p, 'utf-8').slice(0, MAX_AGENT_FILE_BYTES)
      return buf + `\n\n... (文件超过 ${MAX_AGENT_FILE_BYTES / 1024}KB，已截断。完整内容请用 file-reader 读取)`
    }
    return readFileSync(p, 'utf-8')
  } catch {
    return null
  }
}

export function discoverAgentFiles(workspaceDir: string): AgentFiles {
  const projectFiles: AgentFiles['projectFiles'] = []
  const found = findProjectAgentFile(workspaceDir)
  if (found) {
    const content = safeRead(found)
    if (content) {
      projectFiles.push({
        name: basename(found),
        relPath: relative(workspaceDir, found) || basename(found),
        content,
      })
    }
  }

  const globalFiles: AgentFiles['globalFiles'] = []
  for (const p of GLOBAL_AGENT_PATHS) {
    const content = safeRead(p)
    if (content) {
      globalFiles.push({ path: p, content })
    }
  }
  return { projectFiles, globalFiles }
}

export function renderAgentFilesBlock(files: AgentFiles): string {
  if (files.projectFiles.length === 0 && files.globalFiles.length === 0) {
    return ''  // 无规则时省略该段，节省 token
  }
  const lines: string[] = [
    '## 项目规则（AGENTS.md / CLAUDE.md）',
    '',
    '工作区或全局规则文件被自动加载到 system prompt，请严格遵守：',
    '',
  ]
  for (const f of files.projectFiles) {
    lines.push(`### 项目级 ${f.name}（${f.relPath}）`, '', '```markdown', f.content.trim(), '```', '')
  }
  for (const f of files.globalFiles) {
    lines.push(`### 全局 ${basename(f.path)}（${f.path}）`, '', '```markdown', f.content.trim(), '```', '')
  }
  return lines.join('\n').trimEnd()
}

/* ---------- 4. <stack> 技术栈检测 ---------- */

export interface StackInfo {
  /** 是否 Node / JS 生态 */
  node: boolean
  /** 是否 Python */
  python: boolean
  /** 是否 Rust */
  rust: boolean
  /** 是否 Go */
  go: boolean
  /** 是否 Java */
  java: boolean
  /** 主要框架 / 库（从 package.json 提取） */
  frameworks: string[]
  /** Node 版本（package.json 的 engines） */
  nodeVersion: string | null
  /** 项目名 / version */
  projectName: string | null
  projectVersion: string | null
}

function readPackageJson(workspaceDir: string): Record<string, unknown> | null {
  const p = join(workspaceDir, 'package.json')
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>
  } catch {
    return null
  }
}

const FRAMEWORK_KEYWORDS: Array<[RegExp, string]> = [
  [/electron/i, 'Electron'],
  [/next/i, 'Next.js'],
  [/nuxt/i, 'Nuxt'],
  [/vue/i, 'Vue'],
  [/react/i, 'React'],
  [/vite/i, 'Vite'],
  [/tailwind/i, 'Tailwind'],
  [/typescript/i, 'TypeScript'],
  [/phaser/i, 'Phaser'],
  [/three/i, 'Three.js'],
  [/express/i, 'Express'],
  [/fastify/i, 'Fastify'],
  [/koa/i, 'Koa'],
  [/nestjs|@nestjs/i, 'NestJS'],
  [/prisma/i, 'Prisma'],
  [/drizzle/i, 'Drizzle'],
  [/@anthropic-ai\/sdk/i, 'Anthropic SDK'],
  [/openai/i, 'OpenAI SDK'],
  [/zustand/i, 'Zustand'],
  [/redux/i, 'Redux'],
]

export function detectStack(workspaceDir: string): StackInfo {
  const info: StackInfo = {
    node: false, python: false, rust: false, go: false, java: false,
    frameworks: [], nodeVersion: null, projectName: null, projectVersion: null,
  }

  // 文件存在性判断（轻量、不读内容）
  info.node = existsSync(join(workspaceDir, 'package.json'))
  info.python = existsSync(join(workspaceDir, 'pyproject.toml')) || existsSync(join(workspaceDir, 'requirements.txt'))
  info.rust = existsSync(join(workspaceDir, 'Cargo.toml'))
  info.go = existsSync(join(workspaceDir, 'go.mod'))
  info.java = existsSync(join(workspaceDir, 'pom.xml')) || existsSync(join(workspaceDir, 'build.gradle'))

  // package.json 细节
  const pkg = readPackageJson(workspaceDir)
  if (pkg) {
    info.projectName = typeof pkg.name === 'string' ? pkg.name : null
    info.projectVersion = typeof pkg.version === 'string' ? pkg.version : null
    if (pkg.engines && typeof pkg.engines === 'object') {
      const engines = pkg.engines as Record<string, unknown>
      if (typeof engines.node === 'string') info.nodeVersion = engines.node
    }
    const deps = {
      ...(pkg.dependencies as Record<string, string> | undefined ?? {}),
      ...(pkg.devDependencies as Record<string, string> | undefined ?? {}),
    }
    const matched = new Set<string>()
    for (const depName of Object.keys(deps)) {
      for (const [re, label] of FRAMEWORK_KEYWORDS) {
        if (re.test(depName)) matched.add(label)
      }
    }
    info.frameworks = Array.from(matched).sort()
  }

  return info
}

export function renderStackBlock(info: StackInfo): string {
  if (!info.node && !info.python && !info.rust && !info.go && !info.java) {
    return ''  // 无法识别则省略
  }
  const lines: string[] = ['## 技术栈', '', '<stack>']
  const tags: string[] = []
  if (info.node) tags.push(`Node.js${info.nodeVersion ? ` ${info.nodeVersion}` : ''}`)
  if (info.python) tags.push('Python')
  if (info.rust) tags.push('Rust')
  if (info.go) tags.push('Go')
  if (info.java) tags.push('Java')
  lines.push(`生态：${tags.join(' / ')}`)
  if (info.projectName) {
    lines.push(`项目：${info.projectName}${info.projectVersion ? ` @ ${info.projectVersion}` : ''}`)
  }
  if (info.frameworks.length > 0) {
    lines.push(`框架/库：${info.frameworks.join('、')}`)
  }
  lines.push('</stack>')
  return lines.join('\n')
}

/* ---------- 5. 总入口：buildWorkspaceContext ---------- */

export interface WorkspaceContext {
  envInfo: EnvInfo
  tree: ProjectTree
  stack: StackInfo
  agentFiles: AgentFiles
  /** 拼接好的完整文本（可直接作为 PromptSection.text 注入 system） */
  combined: string
}

/**
 * 一次性构建工作区上下文。
 * 任何子模块失败都安全降级（catch + 静默），不阻塞主流程。
 */
export function buildWorkspaceContext(workspaceDir: string): WorkspaceContext {
  const envInfo = buildEnvInfo(workspaceDir)
  const tree = buildProjectTree(workspaceDir)
  const stack = detectStack(workspaceDir)
  const agentFiles = discoverAgentFiles(workspaceDir)

  const blocks: string[] = [
    renderEnvBlock(envInfo),
    renderStackBlock(stack),
    renderProjectBlock(tree),
    renderAgentFilesBlock(agentFiles),
  ].filter((b) => b.trim().length > 0)

  return {
    envInfo,
    tree,
    stack,
    agentFiles,
    combined: blocks.join('\n\n---\n\n'),
  }
}