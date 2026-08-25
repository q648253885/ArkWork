/* ============================================================
 * 端到端：导入「文档驱动开发.zip」并验证 references/ assets/ 完整
 * 运行（cwd=app）：
 *   ./node_modules/.bin/tsx --experimental-loader ./src/test/electron-mock-loader.mjs \
 *     src/main/store/__tests__/e2e-doc-skill.test.ts
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { SkillContext } from '../../agent/registry.js'

const { importSkillFromZip, listSkills, exportSkillToDir } = await import('../skills.js')
const { invokeSkill } = await import('../../agent/registry.js')
const TEST_ARKWORK_DIR = '/tmp/arkwork-test-userData/arkwork-data'
const ZIP_PATH = '/Users/gongzheng/ai/project/文档驱动开发.zip'

// 清理
import('node:fs/promises').then(async (fs) => {
  const skillsDir = join(TEST_ARKWORK_DIR, 'skills')
  if (existsSync(skillsDir)) {
    await fs.rm(skillsDir, { recursive: true, force: true })
  }
  await fs.mkdir(skillsDir, { recursive: true })
})

test('e2e: 导入「文档驱动开发.zip」后 references/ 全部存在', async () => {
  // v0.27.0 R0：样本包属机器本地产物（不在仓库内），缺失时跳过而非红——密闭测试链不依赖仓库外文件
  if (!existsSync(ZIP_PATH)) {
    console.log(`[e2e] skip: 样本包不存在（${ZIP_PATH}），放置后可单跑本套件`)
    return
  }
  const fs = await import('node:fs/promises')
  const skillsDir = join(TEST_ARKWORK_DIR, 'skills')
  if (existsSync(skillsDir)) await fs.rm(skillsDir, { recursive: true, force: true })
  await fs.mkdir(skillsDir, { recursive: true })

  const skill = await importSkillFromZip(ZIP_PATH)
  console.log('[e2e] imported skill:', skill.id, skill.name)

  const skillDir = join(TEST_ARKWORK_DIR, 'skills', skill.id)
  // 关键：references/ 全部存在
  const expectedRefs = [
    '00-opensource-research-template.md',
    '01-prd-template.md',
    '02-interaction-template.md',
    '03-system-design-template.md',
    '04-function-test-checklist.md',
    '05-ui-test-checklist.md',
    '06-ux-review-checklist.md',
    '07-design-guidelines.md',
    '08-delivery-checklist.md',
    '09-ui-prototype-guidelines.md',
  ]
  for (const r of expectedRefs) {
    const p = join(skillDir, 'references', r)
    assert.ok(existsSync(p), `应存在 references/${r}`)
  }
  // assets 也存在
  assert.ok(existsSync(join(skillDir, 'assets', 'example-prototype.html')))
  console.log('[e2e] ✅ references 全部存在，assets 也存在')

  // 验证 listSkills 能返回
  const all = await listSkills()
  const found = all.find((s) => s.id === skill.id)
  assert.ok(found, 'listSkills 应能返回该技能')
  console.log('[e2e] ✅ listSkills 返回该技能')
})

test('e2e: invokeSkill 加载的 hint 包含 references 路径', async () => {
  const all = await listSkills()
  const skill = all.find((s) => s.name === '文档驱动开发') || all.find((s) => s.tags?.includes('imported'))
  if (!skill) {
    console.log('[e2e] skip: 文档驱动开发 skill 未找到')
    return
  }
  // 构造 ctx（显式标注 SkillContext，使 invokeSkill 回写的 additionalSystemHint 可被读取）
  const ctx: SkillContext = {
    taskId: 'e2e-test',
    signal: new AbortController().signal,
    workspaceDir: '/tmp/e2e-ws',
  }
  const { result } = await invokeSkill(skill.id, {}, ctx)
  // result.instruction 包含主 SKILL.md 内容 + 资源目录 hint
  const text = JSON.stringify(result)
  assert.ok(text.includes('【技能资源目录】'), 'hint 应包含【技能资源目录】块')
  assert.ok(text.includes('references/00-opensource-research-template.md'), 'hint 应列出 references 路径')
  console.log('[e2e] ✅ hint 包含资源目录路径')
  // 同时 ctx.additionalSystemHint 也应被设置
  assert.ok(ctx.additionalSystemHint?.includes('【技能资源目录】'))
  console.log('[e2e] ✅ ctx.additionalSystemHint 包含资源目录')
})

test('e2e: 导出多内容技能 → zip 含 references 与 assets', async () => {
  const all = await listSkills()
  const skill = all.find((s) => s.tags?.includes('imported'))
  if (!skill) {
    console.log('[e2e] skip')
    return
  }
  const targetDir = join(TEST_ARKWORK_DIR, 'export-test')
  const result = await exportSkillToDir(skill.id, targetDir)
  assert.equal(result.isZip, true, '多内容应导出为 zip')
  console.log('[e2e] 导出:', result.path, 'fileCount=', result.fileCount)
  // 检查文件大小
  const st = statSync(result.path)
  assert.ok(st.size > 30_000, 'zip 应 > 30KB（含 references）')
  console.log('[e2e] ✅ zip 导出成功，大小', st.size, 'bytes')
})
