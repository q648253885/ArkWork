/* ============================================================
 * v0.31.0 B5 — main/fs/paths.ts 单测（TC-GOTO-006 主进程侧 / TC-WATCH-010）
 *
 * 载体：真实临时目录；QuickOpen 候选集（扁平清单）的 ignore / 截断 / 字段口径。
 * 运行（cwd=app）：node scripts/run-tests.mjs main/fs/__tests__
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LIST_PATHS_LIMIT, listWorkspacePaths } from '../paths.js'

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'arkwork-paths-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('LIST_PATHS_LIMIT = 20000（§7.1 QuickOpen 性能预算）', () => {
  assert.equal(LIST_PATHS_LIMIT, 20000)
})

test('TC-GOTO-006 扁平清单：ignore 规则 / rel/size/language/mtimeMs 字段 / 截断', async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, 'src'), { recursive: true })
    await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true })
    await mkdir(join(dir, '.git'), { recursive: true })
    await writeFile(join(dir, 'README.md'), '# hi')
    await writeFile(join(dir, 'src', 'a.ts'), 'let a = 1')
    await writeFile(join(dir, 'node_modules', 'pkg', 'index.js'), 'x')
    await writeFile(join(dir, '.git', 'config'), 'x')
    await writeFile(join(dir, '.hidden'), 'x')
    await writeFile(join(dir, '.DS_Store'), 'x')

    const res = await listWorkspacePaths(dir)
    assert.equal(res.root, dir)
    assert.equal(res.truncated, false)
    const rels = res.files.map((f) => f.rel).sort()
    assert.deepEqual(rels, ['README.md', join('src', 'a.ts')].sort())

    const md = res.files.find((f) => f.rel === 'README.md')
    assert.ok(md, 'README.md 应在清单中')
    assert.equal(md!.size, 4)
    assert.equal(md!.language, 'markdown')
    assert.ok(md!.path.startsWith(dir))
    assert.ok(md!.mtimeMs > 0)
    const ts = res.files.find((f) => f.rel === join('src', 'a.ts'))
    assert.equal(ts!.language, 'typescript')

    // 截断语义：limit=1 → 只取 1 条 + truncated=true（TC-GOTO-006）
    const limited = await listWorkspacePaths(dir, { limit: 1 })
    assert.equal(limited.files.length, 1)
    assert.equal(limited.truncated, true)
  })
})

test('空工作区 → 空清单不抛错；不存在的根 → 空清单不抛错', async () => {
  await withTempDir(async (dir) => {
    const empty = await listWorkspacePaths(dir)
    assert.deepEqual(empty.files, [])
    assert.equal(empty.truncated, false)
    const missing = await listWorkspacePaths(join(dir, 'nope'))
    assert.deepEqual(missing.files, [])
  })
})
