/* ============================================================
 * v0.16.5 — Skill zip 导入/导出多内容技能测试
 *
 * 覆盖：
 *  1. importSkillFromZip：含 references/assets 的 zip → skill 文件夹保留全部子目录
 *  2. exportSkillToDir：单内容技能 → 导出为目录
 *  3. exportSkillToDir：多内容技能 → 打包为 zip 含全部文件
 *  4. zip 重新导入已打包的 zip → 还原所有文件
 *
 * 运行（cwd=app）：
 *   ./node_modules/.bin/tsx \
 *     --experimental-loader ./src/test/electron-mock-loader.mjs \
 *     --test src/main/store/__tests__/skills-zip-export.test.ts
 *
 * 复用 src/test/electron-mock-loader.mjs（把 electron 替换为桩，
 * 让 db.ts 的 app.getPath('userData') → /tmp/arkwork-test-userData）。
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'

// 用独立的临时 userData 目录，避开 electron 桩的固定 /tmp/arkwork-test-userData
// 让多测试间互不污染：每次 run 前手动 mkdir 一个新的临时目录，
// 然后把 process.env 注入 db.ts。
//
// 简单做法：直接走 db.ts 的 getArkworkDir() 路径（electron 桩固定返回
// /tmp/arkwork-test-userData），所有测试都共享它。beforeEach 删除并重建
// skills/ 目录即可。arkwork-data 目录会自动创建。
const TEST_ARKWORK_DIR = '/tmp/arkwork-test-userData/arkwork-data'

test.before(async () => {
  mkdirSync(TEST_ARKWORK_DIR, { recursive: true })
})

test.beforeEach(async () => {
  const skillsDir = join(TEST_ARKWORK_DIR, 'skills')
  if (existsSync(skillsDir)) {
    await rm(skillsDir, { recursive: true, force: true })
  }
  await mkdir(skillsDir, { recursive: true })
})

test.after(async () => {
  await rm('/tmp/arkwork-test-userData', { recursive: true, force: true }).catch(() => {})
})

const { importSkillFromZip, exportSkillToDir, listSkills, removeSkill } =
  await import('../skills.js')

/* ---------- 1. zip 导入保留 references / assets ---------- */

test('importSkillFromZip: 含 references/ 和 assets/ 的 zip 完整保留子目录文件', async () => {
  const zipPath = join(TEST_ARKWORK_DIR, 'doc-skill.zip')
  const zip = new AdmZip()
  zip.addFile(
    'skill.json',
    Buffer.from(
      JSON.stringify({
        name: 'doc-skill',
        description: '测试技能',
        namespace: 'imported',
      }),
      'utf-8',
    ),
  )
  zip.addFile('SKILL.md', Buffer.from('# doc-skill\n\n主指令', 'utf-8'))
  zip.addFile('references/00-template.md', Buffer.from('# Template 0', 'utf-8'))
  zip.addFile('references/01-template.md', Buffer.from('# Template 1', 'utf-8'))
  zip.addFile('assets/example.html', Buffer.from('<html></html>', 'utf-8'))
  zip.writeZip(zipPath)

  const skill = await importSkillFromZip(zipPath)
  assert.equal(skill.name, 'doc-skill')

  const skillDir = join(TEST_ARKWORK_DIR, 'skills', skill.id)
  assert.ok(existsSync(join(skillDir, 'skill.json')), '应有 skill.json')
  assert.ok(existsSync(join(skillDir, 'SKILL.md')), '应有 SKILL.md')
  assert.ok(
    existsSync(join(skillDir, 'references', '00-template.md')),
    '应保留 references/00-template.md',
  )
  assert.ok(
    existsSync(join(skillDir, 'references', '01-template.md')),
    '应保留 references/01-template.md',
  )
  assert.ok(existsSync(join(skillDir, 'assets', 'example.html')), '应保留 assets/example.html')

  const all = await listSkills()
  assert.ok(all.find((s) => s.id === skill.id), 'listSkills 应能返回该技能')
})

test('importSkillFromZip: 仅 SKILL.md 无 skill.json 的 zip 也应保留额外文件', async () => {
  const zipPath = join(TEST_ARKWORK_DIR, 'md-only.zip')
  const zip = new AdmZip()
  zip.addFile('SKILL.md', Buffer.from('# md-only\n\n主指令\n\nreferences 内嵌模板', 'utf-8'))
  zip.addFile('references/extra.md', Buffer.from('# Extra', 'utf-8'))
  zip.addFile('assets/pic.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  zip.writeZip(zipPath)

  const skill = await importSkillFromZip(zipPath)
  const skillDir = join(TEST_ARKWORK_DIR, 'skills', skill.id)
  assert.ok(existsSync(join(skillDir, 'SKILL.md')))
  assert.ok(existsSync(join(skillDir, 'references', 'extra.md')), '应保留 references/extra.md')
  assert.ok(existsSync(join(skillDir, 'assets', 'pic.png')), '应保留 assets/pic.png')
})

test('importSkillFromZip: 顶层单目录包裹（my-skill/...）也正确剥前缀', async () => {
  const zipPath = join(TEST_ARKWORK_DIR, 'wrapped.zip')
  const zip = new AdmZip()
  zip.addFile('my-skill/SKILL.md', Buffer.from('# wrapped\n\n指令', 'utf-8'))
  zip.addFile('my-skill/references/ref.md', Buffer.from('ref content', 'utf-8'))
  zip.writeZip(zipPath)

  const skill = await importSkillFromZip(zipPath)
  const skillDir = join(TEST_ARKWORK_DIR, 'skills', skill.id)
  assert.ok(!existsSync(join(skillDir, 'my-skill')), '不应出现双层根目录 my-skill/')
  assert.ok(
    existsSync(join(skillDir, 'references', 'ref.md')),
    '应保留剥前缀后的 references/ref.md',
  )
})

/* ---------- 2. 单内容技能导出为目录 ---------- */

test('exportSkillToDir: 仅 skill.json + SKILL.md 的单内容技能 → 导出为目录', async () => {
  const zipPath = join(TEST_ARKWORK_DIR, 'simple.zip')
  const zip = new AdmZip()
  zip.addFile(
    'skill.json',
    Buffer.from(
      JSON.stringify({ name: 'simple-skill', description: '单内容', namespace: 'imported' }),
      'utf-8',
    ),
  )
  zip.addFile('SKILL.md', Buffer.from('# simple\n\n指令', 'utf-8'))
  zip.writeZip(zipPath)
  const skill = await importSkillFromZip(zipPath)

  const targetDir = join(TEST_ARKWORK_DIR, 'export-out')
  const result = await exportSkillToDir(skill.id, targetDir)
  assert.equal(result.isZip, false, '单内容应导出为目录')
  assert.equal(result.fileCount, 2, '应有 2 个文件（skill.json + SKILL.md）')
  assert.ok(existsSync(join(targetDir, 'skill.json')))
  assert.ok(existsSync(join(targetDir, 'SKILL.md')))
})

/* ---------- 3. 多内容技能导出为 zip ---------- */

test('exportSkillToDir: 含 references/ 的多内容技能 → 打包为 zip', async () => {
  const zipPath = join(TEST_ARKWORK_DIR, 'multi.zip')
  const zip = new AdmZip()
  zip.addFile(
    'skill.json',
    Buffer.from(
      JSON.stringify({ name: 'multi-skill', description: '多内容', namespace: 'imported' }),
      'utf-8',
    ),
  )
  zip.addFile('SKILL.md', Buffer.from('# multi\n\n指令', 'utf-8'))
  zip.addFile('references/a.md', Buffer.from('# A', 'utf-8'))
  zip.addFile('references/b.md', Buffer.from('# B', 'utf-8'))
  zip.addFile('assets/x.html', Buffer.from('<x/>', 'utf-8'))
  zip.writeZip(zipPath)
  const skill = await importSkillFromZip(zipPath)

  const targetDir = join(TEST_ARKWORK_DIR, 'export-out')
  const result = await exportSkillToDir(skill.id, targetDir)
  assert.equal(result.isZip, true, '多内容应导出为 zip')
  assert.equal(result.fileCount, 5, '应有 5 个文件（skill.json + SKILL.md + 3 extras）')
  assert.ok(result.path.endsWith('.zip'), '路径应以 .zip 结尾')

  const reimported = new AdmZip(result.path)
  const names = reimported.getEntries().map((e) => e.entryName).sort()
  assert.deepEqual(names, [
    'SKILL.md',
    'assets/x.html',
    'references/a.md',
    'references/b.md',
    'skill.json',
  ])
})

/* ---------- 4. 导出 zip → 再次导入 → 内容完整还原 ---------- */

test('round-trip: 多内容技能导出 zip 后再导入，references/assets 完整还原', async () => {
  const origZip = join(TEST_ARKWORK_DIR, 'orig.zip')
  const zip = new AdmZip()
  zip.addFile(
    'skill.json',
    Buffer.from(
      JSON.stringify({ name: 'rt-skill', description: '往返测试', namespace: 'imported' }),
      'utf-8',
    ),
  )
  zip.addFile('SKILL.md', Buffer.from('# round-trip', 'utf-8'))
  zip.addFile('references/r1.md', Buffer.from('r1 content', 'utf-8'))
  zip.addFile('assets/payload.txt', Buffer.from('payload', 'utf-8'))
  zip.writeZip(origZip)
  const skill1 = await importSkillFromZip(origZip)

  const targetDir = join(TEST_ARKWORK_DIR, 'round-trip-out')
  const exported = await exportSkillToDir(skill1.id, targetDir)
  assert.equal(exported.isZip, true)

  await removeSkill(skill1.id)

  const skill2 = await importSkillFromZip(exported.path)
  assert.equal(skill2.name, 'rt-skill')
  const skillDir = join(TEST_ARKWORK_DIR, 'skills', skill2.id)
  assert.ok(existsSync(join(skillDir, 'references', 'r1.md')), '应还原 references/r1.md')
  assert.ok(existsSync(join(skillDir, 'assets', 'payload.txt')), '应还原 assets/payload.txt')

  await removeSkill(skill2.id)
})