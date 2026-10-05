/* ============================================================
 * ArkWork — 指令源发现器（v0.47.0 · F1/F2）
 * 设计文档：docs/versions/v0.47.0/04-system-design.md §二
 *
 * 兼容 AGENTS.md（Codex）语义，接管 Codex 项目：
 *   全局 ~/.codex/AGENTS.md（新增）→ ~/.arkwork/*（既有）
 *   项目 = workspace 向上祖先链**全收集**，根→叶拼接（root-down，越近越后 = 越具体越优先）
 *   文件名优先级（同目录）：AGENTS.md > AGENT.md > CLAUDE.md > CONTEXT.md
 *   合并预算 32KiB（对齐 Codex project_doc_max_bytes 默认），超额截断标注
 *
 * 与 Codex 的有意偏离（登记于设计文档 §2.1）：
 *   · 链的锚点 = workspace 向上 ≤6 层（无 git 依赖、防越走越远）；
 *   · 预算按「全局 + 项目链」合并总量计（更保守）。
 *
 * 注入层映射：
 *   全局 + 项目链 → L0 workspace-context system 段（run-static，前缀缓存）
 *   工作区内子目录嵌套 → L3 瞬时通道（collectNestedInstructions，volatile，绝不进 system）
 * ============================================================ */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

/** 同目录内文件名优先级（取第一个存在的；AGENTS.md 为规范正名，AGENT.md 是官方迁移容错） */
export const INSTRUCTION_FILE_NAMES = ['AGENTS.md', 'AGENT.md', 'CLAUDE.md', 'CONTEXT.md'] as const

/** 全局+项目链合并预算（对齐 Codex `project_doc_max_bytes` 默认 32KiB） */
export const INSTRUCTION_MERGE_BUDGET_BYTES = 32 * 1024

/** 单轮嵌套注入预算（瞬时通道，防提示膨胀） */
export const NESTED_TURN_BUDGET_BYTES = 8 * 1024

/** 项目链向上搜索层数上限（防爆走；Codex 侧为 git 根锚定） */
const MAX_CHAIN_DEPTH = 6

/** 指令源层级标签（UI 与渲染共用） */
export type InstructionScope = 'codex-global' | 'arkwork-global' | 'project-chain'

export interface InstructionSource {
  scope: InstructionScope
  /** 绝对路径 */
  path: string
  /** 相对 workspace 的路径（项目链）；全局源为 null */
  relPath: string | null
  /** 实际消费字节数（截断后） */
  bytes: number
  truncated: boolean
  content: string
}

export interface InstructionDiscovery {
  /** 按「全局 → 项目链根→叶」顺序排列，即注入顺序（越靠后越具体） */
  sources: InstructionSource[]
  mergedBytes: number
  /** 任一源被截断或因预算被跳过 */
  budgetExhausted: boolean
}

function findInDir(dir: string): string | null {
  for (const name of INSTRUCTION_FILE_NAMES) {
    const p = join(dir, name)
    if (existsSync(p) && statSync(p).isFile()) return p
  }
  return null
}

/** 读源内容；超过剩余预算时截断并标注（返回 null = 无内容/读失败） */
function readWithinBudget(path: string, remaining: number): { content: string; bytes: number; truncated: boolean } | null {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return null
    if (remaining <= 0) return null
    const raw = readFileSync(path, 'utf-8')
    const buf = Buffer.from(raw, 'utf-8')
    if (buf.length <= remaining) {
      return { content: raw, bytes: buf.length, truncated: false }
    }
    // 按码点截断（不劈代理对），尾注指引完整读取
    const sliced = raw.slice(0, remaining)
    return {
      content: `${sliced}\n\n... （指令文件超出剩余预算，已截断。完整内容请用 file-reader 读取：${path}）`,
      bytes: remaining,
      truncated: true,
    }
  } catch {
    return null
  }
}

/**
 * 发现全部指令源（全局 + 项目链）。
 * 输出顺序即注入顺序：越靠后越具体（Codex root-down 语义）。
 */
export function discoverInstructionSources(workspaceDir: string): InstructionDiscovery {
  const sources: InstructionSource[] = []
  let mergedBytes = 0
  let budgetExhausted = false

  const consume = (scope: InstructionScope, path: string, relPath: string | null): void => {
    if (budgetExhausted) {
      budgetExhausted = true
      return
    }
    const r = readWithinBudget(path, INSTRUCTION_MERGE_BUDGET_BYTES - mergedBytes)
    if (!r) {
      // 文件存在但预算已尽 → 截断态置位（后续源全部跳过）
      if (existsSync(path) && statSync(path).isFile() && INSTRUCTION_MERGE_BUDGET_BYTES - mergedBytes <= 0) {
        budgetExhausted = true
      }
      return
    }
    if (r.truncated) budgetExhausted = true
    mergedBytes += r.bytes
    sources.push({ scope, path, relPath, bytes: r.bytes, truncated: r.truncated, content: r.content })
  }

  // ---- 全局层：Codex 全局优先发现（外部约定先入上下文），ArkWork 自家全局在后（更后读 = 更优先）----
  const home = process.env.HOME || ''
  const globalPaths: Array<[InstructionScope, string]> = [
    ['codex-global', join(home, '.codex', 'AGENTS.md')],
    ['arkwork-global', join(home, '.arkwork', 'AGENTS.md')],
    ['arkwork-global', join(home, '.arkwork', 'CLAUDE.md')],
  ]
  for (const [scope, p] of globalPaths) {
    if (home && existsSync(p) && statSync(p).isFile()) consume(scope, p, null)
  }

  // ---- 项目链层：workspace 向上收集全部命中，再按「根 → 叶」输出 ----
  const chain: string[] = []
  let dir = resolve(workspaceDir)
  const fsRoot = resolve(dir, sep)
  for (let depth = 0; depth <= MAX_CHAIN_DEPTH; depth++) {
    const hit = findInDir(dir)
    if (hit) chain.push(hit)
    if (dir === fsRoot) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  for (const p of chain.reverse()) {
    consume('project-chain', p, relative(workspaceDir, p) || basename(p))
  }

  return { sources, mergedBytes, budgetExhausted }
}

/**
 * 绝对路径在工作区内的祖先目录链（根 → 叶）。
 * 工作区外路径返回空数组（嵌套注入只认工作区内触达）。
 */
export function ancestorDirsUnderWorkspace(workspaceDir: string, absPath: string): string[] {
  const ws = resolve(workspaceDir)
  const dir = resolve(dirname(absPath))
  const rel = relative(ws, dir)
  if (rel.startsWith('..') || resolve(rel) === rel) return [] // 越界（.. 开头 / 绝对盘符回跳）
  const chain: string[] = []
  let cur = ws
  chain.push(cur)
  for (const part of rel.split(sep).filter(Boolean)) {
    cur = join(cur, part)
    chain.push(cur)
  }
  return chain
}

/**
 * 收集触达目录的嵌套指令（就近覆盖，Codex "closest wins" 的瞬时注入形态）。
 * 排除已注入目录（含 workspace 根——根文件已在 system 段），root→叶拼接，
 * 单轮预算 NESTED_TURN_BUDGET_BYTES。
 */
export function collectNestedInstructions(
  workspaceDir: string,
  touchedAbsPaths: string[],
  alreadyInjectedDirs: ReadonlySet<string>,
): { text: string; dirs: string[] } {
  const ws = resolve(workspaceDir)
  // 待注入目录 = 触达路径祖先链（限工作区内）− 已注入；按 root→叶去重排序
  const pending: string[] = []
  for (const p of touchedAbsPaths) {
    for (const dir of ancestorDirsUnderWorkspace(ws, p)) {
      if (dir === ws) continue // 根文件已在 system 段
      if (alreadyInjectedDirs.has(dir)) continue
      if (!pending.includes(dir)) pending.push(dir)
    }
  }
  if (pending.length === 0) return { text: '', dirs: [] }
  pending.sort((a, b) => a.length - b.length) // root→叶（路径长度升序即深度升序）

  let budget = NESTED_TURN_BUDGET_BYTES
  const blocks: string[] = []
  const injected: string[] = []
  for (const dir of pending) {
    const hit = findInDir(dir)
    if (!hit) {
      // 该目录没有指令文件 → 记为已处理，避免同目录反复探测
      injected.push(dir)
      continue
    }
    const r = readWithinBudget(hit, budget)
    if (!r) break
    budget -= r.bytes
    injected.push(dir)
    const rel = relative(ws, dir)
    blocks.push(`### ${rel || '.'}（${basename(hit)}）\n\n\`\`\`markdown\n${r.content.trim()}\n\`\`\``)
  }
  if (blocks.length === 0) return { text: '', dirs: injected }
  return { text: blocks.join('\n\n'), dirs: injected }
}

/**
 * 渲染 system 段（L0）。
 * 标题声明 Codex 兼容；段尾附优先级契约（用户消息 > 指令文件 > memory.md）。
 */
export function renderInstructionSourcesBlock(d: InstructionDiscovery): string {
  if (d.sources.length === 0) return ''
  const lines: string[] = [
    '## 项目与全局指令（AGENTS.md · Codex 兼容）',
    '',
    '以下项目/全局指令文件被自动加载到 system prompt，请严格遵守：',
    '',
  ]
  for (const s of d.sources) {
    const label =
      s.scope === 'codex-global'
        ? `全局（Codex ~/.codex/AGENTS.md）`
        : s.scope === 'arkwork-global'
          ? `全局（${basename(s.path)}）`
          : `项目级（${s.relPath ?? s.path}）`
    lines.push(`### ${label}${s.truncated ? '（已按预算截断）' : ''}`, '', '```markdown', s.content.trim(), '```', '')
  }
  lines.push(
    '> 优先级：用户的当前消息 > 上述指令文件 > memory.md 工作区记忆。三者冲突时以用户当前消息为准。',
  )
  return lines.join('\n').trimEnd()
}
