/* ============================================================
 * ArkWork — Skill Store (CRUD 包装)
 * 设计文档 §4.2（F4/F7）
 *
 * 持久化层由 agent/registry.ts 的 writeSkillToFolder / deleteSkillFolder /
 * readSkillInstruction 提供（文件夹结构 {arkworkDir}/skills/{id}/）。
 * 本文件封装为 store 层语义，供 IPC 调用，并负责：
 *  - id 生成（S-custom.{slug}）
 *  - 输入校验（name 非空、schema 基本校验）
 *  - 内置 Skill 保护（source==='builtin' 不可改 name/builtinHandler，不可删）
 *  - 导入/导出（从目录读 skill.json + SKILL.md / 写出到目录）
 *  - CRUD 后失效 registry 内存缓存
 * ============================================================ */
import { join } from 'node:path'
import { basename, extname, relative, sep } from 'node:path'
import { readFile, writeFile, mkdir, mkdtemp, rm, readdir, stat, copyFile } from 'node:fs/promises'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import AdmZip from 'adm-zip'
import { getArkworkDir } from './db.js'
import {
  listSkills,
  writeSkillToFolder,
  deleteSkillFolder,
  readSkillInstruction,
  invalidateSkillCache,
  seedBuiltinSkillsToFolders,
} from '../agent/registry.js'
import type { Skill } from '@shared/types/agent'
import type { SkillAddInput, SkillUpdatePatch } from '@shared/types/ipc'
import { logger } from '../system/logger.js'
import { getUiLocale, tFor } from '../i18n/messages.js'

/**
 * v0.16.5：导出 Skill 的返回结果。
 * - 单内容技能（仅 skill.json + SKILL.md）→ { isZip: false, path: <目录> }
 * - 多内容技能（含 references/assets 等子目录文件）→ { isZip: true, path: <zip 文件> }
 */
export interface SkillExportResult {
  path: string
  isZip: boolean
  /** 打包的文件数（含 skill.json/SKILL.md）；目录导出时为写入的文件数 */
  fileCount: number
}

/** 导入时跳过的根文件名（这些文件由 writeSkillToFolder 单独处理） */
const SKILL_CORE_FILES = new Set(['skill.json', 'SKILL.md', 'skill.md'])

/**
 * 新建 Skill。
 * @param input - Skill 字段（不含 id，可选 id 与 instructionMdContent）
 * @returns 创建的 Skill（含生成的 id）
 * 错误：name 为空 / id 或 name 重复 / schema 无效
 */
export async function addSkill(input: SkillAddInput): Promise<Skill> {
  if (!input.name?.trim()) {
    throw new Error(tFor(getUiLocale(), 'skills.nameRequired'))
  }
  if (!input.namespace?.trim()) {
    throw new Error(tFor(getUiLocale(), 'skills.namespaceRequired'))
  }
  const skills = await listSkills()
  const id = input.id?.trim() || generateSkillId(input.namespace, input.name, skills)
  if (skills.find((s) => s.id === id)) {
    throw new Error(tFor(getUiLocale(), 'skills.idExists', { id }))
  }
  if (skills.find((s) => s.name === input.name)) {
    throw new Error(tFor(getUiLocale(), 'skills.nameExists', { name: input.name }))
  }
  // 校验 inputSchema 基本结构（必须是 object 类型或为空）
  if (input.inputSchema && input.inputSchema.type !== 'object') {
    throw new Error(tFor(getUiLocale(), 'skills.schemaTypeInvalid'))
  }
  const skill: Skill = {
    ...input,
    id,
    source: input.source ?? 'custom',
    enabled: input.enabled ?? true,
    // v0.19.0 M5：新建技能归属 user 层
    layer: 'user',
  }
  await writeSkillToFolder(skill, input.instructionMdContent)
  invalidateSkillCache()
  logger.info('System', `skill created: ${skill.id} (${skill.name})`)
  return skill
}

/**
 * 更新 Skill。
 * @param payload - { id, patch, instructionMdContent? }
 * 错误：不存在 / 内置 Skill 改 name 或 builtinHandler
 */
export async function updateSkill(payload: SkillUpdatePatch): Promise<Skill> {
  const skills = await listSkills()
  const existing = skills.find((s) => s.id === payload.id)
  if (!existing) throw new Error(tFor(getUiLocale(), 'skills.notFound', { id: payload.id }))
  // 内置 Skill 保护：name / builtinHandler / source 不可改
  if (existing.source === 'builtin') {
    const protectedFields = ['name', 'builtinHandler', 'source', 'namespace']
    const attempted = Object.keys(payload.patch).filter((k) => protectedFields.includes(k))
    if (attempted.length > 0) {
      throw new Error(
        tFor(getUiLocale(), 'skills.builtinFieldsLocked', { fields: attempted.join(', ') }),
      )
    }
  }
  // 不允许通过 patch 改 id
  const { id: _omitId, ...safePatch } = payload.patch
  const updated: Skill = {
    ...existing,
    ...safePatch,
    id: existing.id,
    source: existing.source,
  }
  // instructionMdContent: undefined = 不动；null = 删除；string = 覆写
  let instructionMdContent: string | undefined
  if (payload.instructionMdContent !== undefined) {
    instructionMdContent = payload.instructionMdContent
  }
  await writeSkillToFolder(updated, instructionMdContent)
  invalidateSkillCache()
  logger.info('System', `skill updated: ${updated.id}`)
  return updated
}

/**
 * 删除 Skill。
 * @param id - Skill id
 * 错误：不存在 / 内置 Skill 不可删
 */
export async function removeSkill(id: string): Promise<void> {
  const skills = await listSkills()
  const existing = skills.find((s) => s.id === id)
  if (!existing) throw new Error(tFor(getUiLocale(), 'skills.notFound', { id }))
  if (existing.source === 'builtin') {
    throw new Error(tFor(getUiLocale(), 'skills.builtinDeleteLocked', { id }))
  }
  await deleteSkillFolder(id)
  invalidateSkillCache()
  logger.info('System', `skill removed: ${id}`)
}

/**
 * 切换 Skill 启用状态。
 * @param id - Skill id
 * @param enabled - true=启用, false=禁用
 * 错误：不存在
 */
export async function toggleSkill(id: string, enabled: boolean): Promise<void> {
  const skills = await listSkills()
  const existing = skills.find((s) => s.id === id)
  if (!existing) throw new Error(tFor(getUiLocale(), 'skills.notFound', { id }))
  await writeSkillToFolder({ ...existing, enabled })
  invalidateSkillCache()
}

/**
 * 读取 Skill 的 SKILL.md 指令体（用于编辑器回填）。
 * @param id - Skill id
 * @returns SKILL.md 内容；不存在返回 null
 */
export async function readInstruction(id: string): Promise<string | null> {
  return readSkillInstruction(id)
}

/**
 * 从目录导入 Skill。
 * 目录需含 skill.json（必需）+ SKILL.md（可选）。
 * @param dirPath - 源目录绝对路径
 * @returns 导入的 Skill
 * 错误：目录不存在 / 缺 skill.json / 解析失败 / id 已存在
 */
export async function importSkillFromDir(dirPath: string): Promise<Skill> {
  if (!existsSync(dirPath)) {
    throw new Error(tFor(getUiLocale(), 'skills.importDirNotFound', { dir: dirPath }))
  }
  const skillJsonPath = join(dirPath, 'skill.json')
  if (!existsSync(skillJsonPath)) {
    throw new Error(tFor(getUiLocale(), 'skills.skillJsonMissing', { dir: dirPath }))
  }
  let skill: Skill
  try {
    const raw = await readFile(skillJsonPath, 'utf-8')
    skill = JSON.parse(raw) as Skill
  } catch (err) {
    throw new Error(tFor(getUiLocale(), 'skills.skillJsonParseFailed', { message: (err as Error).message }))
  }
  if (!skill.name?.trim()) {
    throw new Error(tFor(getUiLocale(), 'skills.skillJsonNoName'))
  }
  // v0.8.0：市面通用 skill.json 常不含 id/namespace，按 name 派生 id 兜底，避免后续崩溃
  if (!skill.id) {
    const skills = await listSkills()
    skill = {
      ...skill,
      id: generateSkillId(skill.namespace || 'imported', skill.name, skills),
      namespace: skill.namespace || 'imported',
    }
  }
  // 检查 id 冲突
  const skills = await listSkills()
  if (skills.find((s) => s.id === skill.id)) {
    throw new Error(tFor(getUiLocale(), 'skills.duplicateIdOnImport', { id: skill.id }))
  }
  // 读取 SKILL.md（若存在）
  const skillMdPath = join(dirPath, 'SKILL.md')
  let instructionMdContent: string | undefined
  if (existsSync(skillMdPath)) {
    instructionMdContent = await readFile(skillMdPath, 'utf-8')
  }
  // 标记为 custom 来源（导入即归己）；v0.8.0：确保 ASCII toolName（中文名技能不会退化冲突）
  // v0.14.0 Task 5：记录导入来源（本地目录路径），UI 据此展示「已导入」来源
  skill = {
    ...skill,
    source: 'custom',
    enabled: skill.enabled ?? true,
    toolName: skill.toolName ?? asciiToolName(skill.id),
    installedFrom: skill.installedFrom ?? dirPath,
    // v0.19.0 M5：导入技能归属 user 层
    layer: 'user',
  }
  await writeSkillToFolder(skill, instructionMdContent)
  invalidateSkillCache()
  logger.info('System', `skill imported from ${dirPath}: ${skill.id}`)
  return skill
}

/**
 * v0.8.0：从 Markdown 文件导入 Skill。
 * 将单个 .md 文件作为 SKILL.md 内容，生成最小 skill 元数据。
 * @param filePath - .md 文件绝对路径
 * @returns 导入的 Skill
 */
export async function importSkillFromMarkdown(filePath: string): Promise<Skill> {
  if (!existsSync(filePath)) {
    throw new Error(tFor(getUiLocale(), 'skills.fileNotFound', { path: filePath }))
  }
  const ext = extname(filePath).toLowerCase()
  if (ext !== '.md' && ext !== '.markdown') {
    throw new Error(tFor(getUiLocale(), 'skills.mdOnly', { ext }))
  }
  const content = await readFile(filePath, 'utf-8')
  if (!content.trim()) {
    throw new Error(tFor(getUiLocale(), 'skills.fileEmpty'))
  }
  // v0.8.0：优先识别 frontmatter 中的 name / description（市面通用 Skill 格式）
  const fm = parseSkillFrontmatter(content)
  const fileName = basename(filePath, ext)
  const name = fm.name?.trim() || fileName.trim() || 'imported-skill'
  const skills = await listSkills()
  // 检查 name 冲突
  if (skills.find((s) => s.name === name)) {
    throw new Error(tFor(getUiLocale(), 'skills.duplicateNameMd', { name }))
  }
  const id = generateSkillId('imported', name, skills)
  // 描述优先级：frontmatter > 首行标题 > 文件名
  let description = fm.description?.trim() ?? ''
  if (!description) {
    const firstLine = content.split('\n').find((l) => l.trim()) ?? ''
    const descMatch = firstLine.match(/^#+\s*(.+)/)
    description = descMatch ? descMatch[1].trim() : tFor(getUiLocale(), 'skills.importedDesc', { file: fileName })
  }
  const skill: Skill = {
    id,
    name,
    description,
    namespace: 'imported',
    source: 'custom',
    enabled: true,
    // v0.19.0 M5：导入技能归属 user 层
    layer: 'user',
    // v0.8.0：ASCII 工具名（中文名技能生成 slug 会退化为 "skill"，此处用 id 派生保证唯一）
    toolName: asciiToolName(id),
    tags: ['imported', 'markdown'],
    inputSchema: { type: 'object', properties: {} },
    timeout: 60_000,
    needsConfirmation: false,
    // v0.14.0 Task 5：记录本地路径来源
    installedFrom: filePath,
  }
  await writeSkillToFolder(skill, content)
  invalidateSkillCache()
  logger.info('System', `skill imported from markdown: ${filePath} → ${skill.id}`)
  return skill
}

/**
 * v0.8.0 + polish-workspace-task-title-skills-context-help §Task 3.2 + v0.16.5：
 * 从 ZIP 文件导入 Skill,**完整解压所有文件**保留目录结构到 Skill 文件夹。
 *
 * v0.16.5 修复：之前版本注释说"完整解压"，实际只把 skill.json + SKILL.md 写到
 * 最终 skill 文件夹，references/assets 等子目录文件被丢弃。现在改为：
 *  1. 解压到临时目录
 *  2. 调 importSkillFromDir/importSkillFromMarkdown 创建 skill 文件夹（写 skill.json+SKILL.md）
 *  3. 把 zip 中除 skill.json/SKILL.md/skill.md 外的所有文件（含子目录）复制到 skill 文件夹
 *
 * 支持两种 zip 结构：
 *  1. 含 skill.json（+ 可选 SKILL.md + 子目录其他文件）→ 走 importSkillFromDir 逻辑
 *  2. 仅含 SKILL.md（或任意 .md + 其他文件）→ 走 markdown 导入逻辑
 * 顶层为单目录包裹时（如 `my-skill/`）会剥除该层前缀，避免在 Skill 文件夹下产生双层根。
 * @param filePath - .zip 文件绝对路径
 * @returns 导入的 Skill
 */
export async function importSkillFromZip(filePath: string): Promise<Skill> {
  if (!existsSync(filePath)) {
    throw new Error(tFor(getUiLocale(), 'skills.fileNotFound', { path: filePath }))
  }
  const ext = extname(filePath).toLowerCase()
  if (ext !== '.zip') {
    throw new Error(tFor(getUiLocale(), 'skills.zipOnly', { ext }))
  }
  const zip = new AdmZip(filePath)
  const entries = zip.getEntries()
  if (entries.length === 0) {
    throw new Error(tFor(getUiLocale(), 'skills.zipEmpty'))
  }
  // 解压到临时目录
  const tmpDir = await mkdtemp(join(tmpdir(), 'arkwork-skill-'))
  try {
    zip.extractAllTo(tmpDir, true)
    // 计算剥除的顶层单目录前缀（zip 多见 `my-skill/...` 单一顶层目录）
    const topLevelEntries = readdirSync(tmpDir)
    const onlyOneTopDir =
      topLevelEntries.length === 1 && statSync(join(tmpDir, topLevelEntries[0])).isDirectory()
    const root = onlyOneTopDir ? join(tmpDir, topLevelEntries[0]) : tmpDir
    const rootPrefix = onlyOneTopDir ? topLevelEntries[0] + '/' : ''

    // 把所有非目录条目按原始相对路径写入 root，保留目录结构
    const writtenFiles: string[] = []
    for (const entry of entries) {
      if (entry.isDirectory) continue
      const rel = entry.entryName
      if (!rel.startsWith(rootPrefix)) continue
      const stripped = rel.slice(rootPrefix.length)
      if (!stripped) continue
      const dest = join(root, stripped)
      const destDir = join(dest, '..')
      await mkdir(destDir, { recursive: true })
      await writeFile(dest, entry.getData())
      writtenFiles.push(stripped)
    }
    if (writtenFiles.length === 0) {
      throw new Error(tFor(getUiLocale(), 'skills.zipNoFiles'))
    }
    // 识别 skill.json → 走目录导入（含嵌套子目录）
    let skill: Skill
    const skillJsonPath = join(root, 'skill.json')
    const skillMdPath = join(root, 'SKILL.md')
    const skillMdAltPath = join(root, 'skill.md')
    if (existsSync(skillJsonPath)) {
      skill = await importSkillFromDir(root)
    } else if (existsSync(skillMdPath)) {
      skill = await importSkillFromMarkdown(skillMdPath)
    } else if (existsSync(skillMdAltPath)) {
      skill = await importSkillFromMarkdown(skillMdAltPath)
    } else {
      // 兜底：取第一个 .md 作为主指令，其他文件已全部保留在 root 下
      const mdFile = writtenFiles.find((f) => f.toLowerCase().endsWith('.md'))
      if (!mdFile) throw new Error(tFor(getUiLocale(), 'skills.zipNoEntry'))
      skill = await importSkillFromMarkdown(join(root, mdFile))
    }

    // v0.16.5：把 zip 中的额外文件（references/assets 等子目录）复制到 skill 文件夹
    // 之前版本这一步缺失，导致多内容技能加载后只剩 SKILL.md
    const skillDir = join(getArkworkDir(), 'skills', skill.id)
    const extras = await copySkillExtras(root, skillDir)
    if (extras > 0) {
      logger.info('System', `skill zip extras copied: ${extras} files → ${skillDir}`)
    }
    return skill
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * v0.16.5：把 srcDir 下除核心文件（skill.json/SKILL.md/skill.md）外的所有文件
 * （含子目录）复制到 destDir，保留相对路径。返回复制的文件数。
 * 已存在的同名文件会被覆盖。
 */
async function copySkillExtras(srcDir: string, destDir: string): Promise<number> {
  let count = 0
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      const srcPath = join(dir, e.name)
      if (e.isDirectory()) {
        await walk(srcPath)
      } else if (e.isFile()) {
        // 跳过根目录下的核心文件（已由 writeSkillToFolder 处理）
        const isRoot = dir === srcDir
        if (isRoot && SKILL_CORE_FILES.has(e.name)) continue
        // 跳过 macOS 元数据
        if (e.name === '.DS_Store') continue
        const relPath = relative(srcDir, srcPath)
        const destPath = join(destDir, relPath)
        await mkdir(join(destPath, '..'), { recursive: true })
        await copyFile(srcPath, destPath)
        count++
      }
    }
  }
  await walk(srcDir)
  return count
}

/**
 * v0.16.5：列出 skill 文件夹下的额外文件（除 skill.json/SKILL.md/skill.md 外）。
 * 返回相对 skill 文件夹的路径列表（如 ['references/00-opensource.md', 'assets/example.html']）。
 * 用于导出时判断是否需要打包 zip。
 */
async function listSkillExtras(skillDir: string): Promise<string[]> {
  const result: string[] = []
  if (!existsSync(skillDir)) return result
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      const srcPath = join(dir, e.name)
      if (e.isDirectory()) {
        await walk(srcPath)
      } else if (e.isFile()) {
        const isRoot = dir === skillDir
        if (isRoot && SKILL_CORE_FILES.has(e.name)) continue
        if (e.name === '.DS_Store') continue
        result.push(relative(skillDir, srcPath).split(sep).join('/'))
      }
    }
  }
  await walk(skillDir)
  return result
}

/**
 * 导出 Skill。
 *
 * v0.16.5 行为变更：
 *  - 单内容技能（仅 skill.json + SKILL.md）→ 导出为目录（原行为）
 *  - 多内容技能（含 references/assets 等子目录文件）→ 打包为 zip 文件
 *    保存到 `{targetDir}/{skillName}.zip`，便于完整分发与重新导入
 *
 * @param id - Skill id
 * @param targetDir - 目标目录（不存在则创建）
 * @returns { path, isZip, fileCount } — 导出的最终路径与是否为 zip
 * 错误：Skill 不存在 / 写入失败
 */
export async function exportSkillToDir(id: string, targetDir: string): Promise<SkillExportResult> {
  const skills = await listSkills()
  const existing = skills.find((s) => s.id === id)
  if (!existing) throw new Error(tFor(getUiLocale(), 'skills.notFound', { id }))
  await mkdir(targetDir, { recursive: true })

  // 检测 skill 文件夹下的额外文件
  const skillDir = join(getArkworkDir(), 'skills', id)
  const extras = await listSkillExtras(skillDir)
  // 准备导出用的元数据（instructionMd 改为相对 'SKILL.md'）
  const exportable: Skill = { ...existing }
  if (exportable.instructionMd) {
    exportable.instructionMd = 'SKILL.md'
  }
  const instruction = await readSkillInstruction(id)

  if (extras.length === 0) {
    // 单内容技能 → 导出为目录
    await writeFile(join(targetDir, 'skill.json'), JSON.stringify(exportable, null, 2), 'utf-8')
    if (instruction !== null) {
      await writeFile(join(targetDir, 'SKILL.md'), instruction, 'utf-8')
    }
    const fileCount = 1 + (instruction !== null ? 1 : 0)
    logger.info('System', `skill exported to dir ${targetDir}: ${id} (${fileCount} files)`)
    return { path: targetDir, isZip: false, fileCount }
  }

  // 多内容技能 → 打包为 zip
  // 文件名：优先用 toolName（ASCII 安全），否则用 id 派生
  const baseName = (existing.toolName || id.replace(/^S-/, '').replace(/\./g, '-'))
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 60) || 'skill'
  const zipPath = join(targetDir, `${baseName}.zip`)
  const zip = new AdmZip()
  // 写入 skill.json
  zip.addFile('skill.json', Buffer.from(JSON.stringify(exportable, null, 2), 'utf-8'))
  let fileCount = 1
  // 写入 SKILL.md
  if (instruction !== null) {
    zip.addFile('SKILL.md', Buffer.from(instruction, 'utf-8'))
    fileCount++
  }
  // 写入所有额外文件（保留相对路径）
  for (const rel of extras) {
    const absPath = join(skillDir, rel)
    try {
      const data = await readFile(absPath)
      zip.addFile(rel, data)
      fileCount++
    } catch (err) {
      logger.warn('System', `skill export: skip ${rel}: ${(err as Error).message}`)
    }
  }
  zip.writeZip(zipPath)
  logger.info('System', `skill exported to zip ${zipPath}: ${id} (${fileCount} files, ${extras.length} extras)`)
  return { path: zipPath, isZip: true, fileCount }
}

/**
 * 生成 Skill id：S-{namespace}.{slug}
 * slug = name 转小写、空格转连字符、去特殊字符、截断到 30 字符
 * 若冲突则追加数字后缀（-2, -3...）
 */
function generateSkillId(namespace: string, name: string, existing: Skill[]): string {
  const ns = namespace.toLowerCase().replace(/[^a-z0-9]/g, '') || 'custom'
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30) || 'skill'
  let id = `S-${ns}.${slug}`
  let n = 2
  while (existing.find((s) => s.id === id)) {
    id = `S-${ns}.${slug}-${n}`
    n++
  }
  return id
}

/**
 * v0.8.0：解析 SKILL.md 的 frontmatter（市面通用格式）。
 * ---
 * name: xxx
 * description: yyy
 * ---
 * @returns name / description（未命中返回 undefined）
 */
function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fm) return {}
  const nameMatch = fm[1].match(/^name:\s*(.+)$/m)
  const descMatch = fm[1].match(/^description:\s*(.+)$/m)
  return {
    name: nameMatch?.[1]?.trim(),
    description: descMatch?.[1]?.trim(),
  }
}

/**
 * v0.8.0：从 Skill id 派生 ASCII 工具名，保证唯一且可被 LLM 调用。
 * 例：S-imported.pdf-extract → imported-pdf-extract
 * 例：S-custom.周报 → custom-zhou-bao-xxxx（id 的 slug 段本身已是 ASCII）
 */
function asciiToolName(id: string): string {
  const stripped = id.replace(/^S-/, '').replace(/\./g, '-')
  return stripped || 'skill'
}

/** 重新播种内置 Skill 到文件夹（供 market install 调用） */
export async function reseedBuiltinSkills(): Promise<void> {
  await seedBuiltinSkillsToFolders()
  invalidateSkillCache()
}

export { listSkills }
