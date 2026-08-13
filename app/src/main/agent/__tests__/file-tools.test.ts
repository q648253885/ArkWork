/* ============================================================
 * ArkWork — 文件工具 Skill 单元测试（v0.16.0）
 * 使用临时目录，不依赖 electron / db.js / @shared 别名
 * ============================================================ */
import { fileWriter } from '../skills/file-writer.js'
import { fileEditor } from '../skills/file-editor.js'
import { globSearch } from '../skills/glob-search.js'
import { grepSearch } from '../skills/grep-search.js'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert'

// 本地最小 SkillContext，避免加载 registry.ts 的完整模块图
interface TestCtx {
  taskId: string
  signal: AbortSignal
  workspaceDir: string
}

function makeCtx(workspaceDir: string): TestCtx {
  return {
    taskId: 'T-test',
    signal: new AbortController().signal,
    workspaceDir,
  }
}

// file-writer 的测试入口
async function writeFileTest(path: string, content: string, workspaceDir: string, overwrite?: boolean) {
  return fileWriter({ path, content, overwrite } as { path: string; content: string; overwrite?: boolean }, makeCtx(workspaceDir) as unknown as Parameters<typeof fileWriter>[1])
}

async function editFileTest(path: string, oldStr: string, newStr: string, workspaceDir: string, all?: boolean) {
  return fileEditor({ path, oldStr, newStr, all } as { path: string; oldStr: string; newStr: string; all?: boolean }, makeCtx(workspaceDir) as unknown as Parameters<typeof fileEditor>[1])
}

async function globTest(pattern: string, workspaceDir: string, path?: string) {
  return globSearch({ pattern, path } as { pattern: string; path?: string }, makeCtx(workspaceDir) as unknown as Parameters<typeof globSearch>[1])
}

async function grepTest(pattern: string, workspaceDir: string, glob?: string) {
  return grepSearch({ pattern, glob } as { pattern: string; glob?: string }, makeCtx(workspaceDir) as unknown as Parameters<typeof grepSearch>[1])
}

async function readText(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  return readFile(path, 'utf-8')
}

test('file-writer: 新建文件并返回元信息', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arkwork-file-tools-'))
  const res = await writeFileTest('hello.txt', 'Hello\nWorld', dir)
  assert.ok(!('status' in res), '应成功而非失败')
  assert.equal((res as { bytes: number }).bytes, 11)
  assert.equal((res as { lines: number }).lines, 2)
  assert.equal((res as { created: boolean }).created, true)
})

test('file-writer: 覆盖已存在文件需 overwrite=true', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arkwork-file-tools-'))
  await writeFileTest('a.txt', 'old', dir)
  const res1 = await writeFileTest('a.txt', 'new', dir)
  assert.equal((res1 as { status: string }).status, 'failed', '未设置 overwrite 应失败')
  const res2 = await writeFileTest('a.txt', 'new', dir, true)
  assert.ok(!('status' in res2), 'overwrite=true 应成功')
})

test('file-writer: 禁止写入受保护路径 .env', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arkwork-file-tools-'))
  const res = await writeFileTest('.env', 'secret', dir)
  assert.equal((res as { status: string }).status, 'failed')
})

test('file-editor: 替换第一处匹配', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arkwork-file-tools-'))
  await writeFileTest('src.js', 'foo foo foo', dir)
  const res = await editFileTest('src.js', 'foo', 'bar', dir)
  assert.equal((res as { replacements: number }).replacements, 1)
  const after = await readText(join(dir, 'src.js'))
  assert.equal(after, 'bar foo foo')
})

test('file-editor: 替换全部匹配', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arkwork-file-tools-'))
  await writeFileTest('src.js', 'foo foo foo', dir)
  const res = await editFileTest('src.js', 'foo', 'bar', dir, true)
  assert.equal((res as { replacements: number }).replacements, 3)
  const after = await readText(join(dir, 'src.js'))
  assert.equal(after, 'bar bar bar')
})

test('file-editor: 未找到 oldStr 返回失败状态', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arkwork-file-tools-'))
  await writeFileTest('src.js', 'foo', dir)
  const res = await editFileTest('src.js', 'baz', 'bar', dir)
  assert.equal((res as { status: string }).status, 'failed')
})

test('glob-search: 按扩展名查找文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arkwork-file-tools-'))
  await mkdir(join(dir, 'src'), { recursive: true })
  await writeFileTest('src/a.ts', '1', dir)
  await writeFileTest('src/b.ts', '2', dir)
  await writeFileTest('src/c.js', '3', dir)
  const res = await globTest('**/*.ts', dir)
  assert.ok(!('status' in res), 'glob-search 应成功')
  const matches = (res as { matches: string[] }).matches
  assert.equal(matches.length, 2)
  assert.ok(matches.includes('src/a.ts'))
  assert.ok(matches.includes('src/b.ts'))
})

test('grep-search: 在文件中搜索内容', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arkwork-file-tools-'))
  await writeFileTest('a.ts', 'const x = 1\nconst y = 2', dir)
  await writeFileTest('b.ts', 'const z = 3', dir)
  const res = await grepTest('const', dir, '**/*.ts')
  assert.ok(!('status' in res), 'grep-search 应成功')
  const total = (res as { total: number }).total
  assert.equal(total, 3)
  assert.equal((res as { scannedFiles: number }).scannedFiles, 2)
})
