/* ============================================================
 * v0.31.0 B2 — main/fs/write.ts 单测（TC-WRITE-001..010）
 *
 * 载体纪律（见 testcases/00-cumulative-matrix.md §3.6）：
 *  - **真实临时文件 + 真实故障注入**（不 mock 整个 fs 模块，只替换指定的 IO 原语）
 *  - 防的是 §6.3 四条硬要求：原子性 / 编码保真 / 同路径串行 / 冲突不静默
 *
 * 运行（cwd=app）：
 *   node scripts/run-tests.mjs main/fs/__tests__
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SELF_WRITE_TTL_MS,
  clearSelfWrites,
  hashFile,
  historyDirFor,
  historyIdFor,
  isSelfWrite,
  markSelfWrite,
  pendingWriteCount,
  tmpPathFor,
  writeText,
} from '../write.js'
import { fastHash, probeText, readText } from '../text.js'
import { FsError } from '@shared/utils/fs-error'
import type { ConflictInfo, WriteTextRequest } from '@shared/types/fs'

const HERE = dirname(fileURLToPath(import.meta.url))
const WRITE_SRC = resolve(HERE, '../write.ts')

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'arkwork-write-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** 默认请求（utf-8 / lf / 有末尾换行），各用例只覆盖关心的字段 */
function req(path: string, content: string, over: Partial<WriteTextRequest> = {}): WriteTextRequest {
  return {
    path,
    content,
    encoding: 'utf-8',
    eol: 'lf',
    finalNewline: true,
    origin: 'user-save',
    ...over,
  }
}

async function errOf(fn: () => Promise<unknown>): Promise<FsError | Error | null> {
  try {
    await fn()
    return null
  } catch (err) {
    return err as FsError
  }
}

async function tmpResidue(dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.isDirectory()) await walk(join(d, e.name))
      else if (e.name.endsWith('.arkwork-tmp')) out.push(join(d, e.name))
    }
  }
  await walk(dir)
  return out
}

/* ---------- TC-WRITE-001 ---------- */

test('TC-WRITE-001 原子性源码契约：tmp + 同目录 rename，无 writeFile(target) 直写', async () => {
  const src = await readFile(WRITE_SRC, 'utf-8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  // ① 临时文件命名固定为 {dir}/.{name}.arkwork-tmp
  assert.match(code, /\.\$\{basename\(target\)\}\.arkwork-tmp/, '临时文件必须是「同目录 + 隐藏 + 固定后缀」')
  assert.equal(tmpPathFor('/w/a/b.txt'), '/w/a/.b.txt.arkwork-tmp')

  // ② 落盘顺序：写 tmp → rename(tmp, target)
  assert.match(code, /ioWriteFile\(tmpPath, bytes\)/)
  assert.match(code, /ioRename\(tmpPath, target\)/, '必须同目录 rename 才原子')

  // ③ 根因形态根除：不得对 target 直写（C-6 的 workspace.ts:175 形态）
  assert.ok(!/writeFile\(\s*target\s*,/.test(code), '不得出现 writeFile(target, ...) 直写')
  assert.ok(!/writeFile\(\s*resolve\(\s*target/.test(code), '不得出现 writeFile(resolve(target), ...)')
  // 模板内只允许一处「裸 writeFile(」调用：历史快照（ioWriteFile 是大写 W，不在此列）
  const bareWriteFileCalls = [...code.matchAll(/(?:^|[^A-Za-z_$])writeFile\(/gm)]
  assert.equal(bareWriteFileCalls.length, 1, '模板内只允许一处裸 writeFile(：历史快照')
  assert.match(code, /writeFile\(join\(dir, `\$\{id\}\.snap`\), buf\)/)
})

/* ---------- TC-WRITE-002 ---------- */

test('TC-WRITE-002 故障注入：rename 失败 → 目标未被触碰、无半成品、无 tmp 残留', async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, 'a.txt')
    const before = Buffer.from('原始内容\n', 'utf-8')
    await writeFile(path, before)

    const err = await errOf(() =>
      writeText(req(path, '新内容\n'), {
        root: dir,
        io: {
          rename: async () => {
            throw new Error('ENOSPC: simulated power loss')
          },
        },
      }),
    )
    assert.ok(err instanceof FsError)
    assert.equal((err as FsError).code, 'E_WRITE_FAILED')

    assert.deepEqual(await readFile(path), before, '目标文件字节必须一字节未动')
    assert.deepEqual(await tmpResidue(dir), [], '不得留下 .arkwork-tmp 半成品')
    // 目录里除历史区（.arkwork，force 分支先落快照）外只剩原文件，没有任何半成品
    assert.deepEqual((await readdir(dir)).sort(), ['.arkwork', 'a.txt'])
    assert.deepEqual(await readdir(join(dir, '.arkwork')).catch(() => []), ['history'])
  })
})

/* ---------- TC-WRITE-003 ---------- */

test('TC-WRITE-003 成功路径结束后目录无 .arkwork-tmp 残留', async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, 'b.txt')
    await writeText(req(path, 'hello\n'), { root: dir })
    assert.deepEqual(await readFile(path, 'utf-8'), 'hello\n')
    assert.deepEqual(await tmpResidue(dir), [])
    await writeText(req(path, 'hello2\n'), { root: dir })
    assert.deepEqual(await tmpResidue(dir), [])
  })
})

/* ---------- TC-WRITE-004 ---------- */

test('TC-WRITE-004 CAS 相等 → 写入成功；revision = 新 hash；mtimeMs 递增', async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, 'c.txt')
    await writeFile(path, 'v1\n', 'utf-8')

    const probe = await probeText(path)
    const beforeMtime = probe.mtimeMs
    await new Promise((r) => setTimeout(r, 12))

    const res = await writeText(req(path, 'v2\n', { expectedDiskHash: probe.fastHash }), { root: dir })
    assert.equal(res.path, path)
    assert.equal(res.bytes, Buffer.byteLength('v2\n'))
    assert.equal(res.revision, fastHash(Buffer.from('v2\n')), 'revision 必须是写入后内容的新哈希')
    assert.ok(res.mtimeMs > beforeMtime, 'mtimeMs 必须递增')
    assert.equal(res.historyId, undefined, 'CAS 命中不是「覆盖」分支，不落历史')
    assert.deepEqual(await readFile(path, 'utf-8'), 'v2\n')

    // 写完的 revision 必须能作为下一次 CAS 的基线（自洽性）
    const probe2 = await probeText(path)
    assert.equal(probe2.fastHash, res.revision, 'probe 基线必须与 writeText 的 revision 同口径')
  })
})

/* ---------- TC-WRITE-005 ---------- */

test('TC-WRITE-005 CAS 失配 → E_CONFLICT（带 ConflictInfo），磁盘逐字节未变', async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, 'd.txt')
    const disk = Buffer.from('磁盘版本\n', 'utf-8')
    await writeFile(path, disk)

    const err = await errOf(() =>
      writeText(req(path, '我的版本\n', { expectedDiskHash: 'crc32:deadbeef:1' }), { root: dir }),
    )
    assert.ok(err instanceof FsError)
    assert.equal((err as FsError).code, 'E_CONFLICT')

    const info = (err as FsError).payload as ConflictInfo
    assert.equal(info.path, path)
    assert.equal(info.diskHash, fastHash(disk), '载荷必须携带磁盘当前真实指纹')
    assert.equal(info.diskText, '磁盘版本\n', '载荷必须携带磁盘版文本供双栏对比')
    assert.equal(info.source, 'unknown', 'B2 阶段来源归因保守为 unknown（watch 归 B5）')
    assert.equal(info.diskProbe.fastHash, fastHash(disk))

    assert.deepEqual(await readFile(path), disk, '冲突时绝不自动覆盖')
    assert.deepEqual(await tmpResidue(dir), [])
  })
})

/* ---------- TC-WRITE-006 ---------- */

test('TC-WRITE-006 expectedDiskHash = undefined → 强制覆盖、跳过 CAS，且先落本地历史', async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, 'e.txt')
    const old = Buffer.from('旧内容\n', 'utf-8')
    await writeFile(path, old)

    // 先制造一个「磁盘已变」的事实，证明 force 分支确实跳过了 CAS
    const stale = 'crc32:00000000:0'
    const res = await writeText(req(path, '覆盖内容\n', { expectedDiskHash: undefined }), { root: dir })
    assert.equal(res.historyId, historyIdFor(fastHash(old)), '覆盖前必须先落旧版本快照')

    const snap = await readFile(join(historyDirFor(dir), `${res.historyId}.snap`))
    assert.deepEqual(snap, old, '历史快照必须是覆盖前的逐字节内容')
    assert.deepEqual(await readFile(path, 'utf-8'), '覆盖内容\n')

    // 对照：同一 stale 基线走 CAS 分支必须冲突
    const err = await errOf(() => writeText(req(path, 'x\n', { expectedDiskHash: stale }), { root: dir }))
    assert.equal((err as FsError).code, 'E_CONFLICT')

    // 文件不存在时 force 创建：无旧版本 → 无历史
    const created = await writeText(req(join(dir, 'new.txt'), 'brand new\n'), { root: dir })
    assert.equal(created.historyId, undefined)
    assert.deepEqual(await readFile(join(dir, 'new.txt'), 'utf-8'), 'brand new\n')
  })
})

/* ---------- TC-WRITE-007 ---------- */

test('TC-WRITE-007 并发写同路径串行化：20 次并发末态 = 最后一次内容，无交错损坏', async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, 'race.txt')
    const payloads = Array.from({ length: 20 }, (_, i) => `payload-${String(i).padStart(2, '0')}\n`)

    const results = await Promise.all(
      payloads.map((p) => writeText(req(path, p), { root: dir })),
    )
    assert.equal(results.length, 20)
    assert.deepEqual(await readFile(path, 'utf-8'), payloads[19], '末态必须是最后一次调用的内容')
    assert.deepEqual(await tmpResidue(dir), [], '串行链上不得残留任何 tmp')

    // 每个 revision 都在语义上自洽（都是某次写入内容的哈希）
    const expectedHashes = new Set(payloads.map((p) => fastHash(Buffer.from(p, 'utf-8'))))
    for (const r of results) assert.ok(expectedHashes.has(r.revision), 'revision 必须是某次写入内容的哈希')

    // 队列排空（无泄漏的互斥链）；cleanup 在 microtask 里跑，先让出一拍
    await new Promise((r) => setTimeout(r, 0))
    assert.equal(pendingWriteCount(), 0)
  })
})

/* ---------- TC-WRITE-008 ---------- */

test('TC-WRITE-008 编码保真端到端：按 probe 回传的 encoding/eol/finalNewline 组装字节', async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, 'fidelity.txt')
    const original = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('第一行\r\n第二行\r\n', 'utf-8'),
    ])
    await writeFile(path, original)

    const { probe, content } = await readText(path)
    assert.equal(probe.encoding, 'utf-8-bom')
    assert.equal(probe.eol, 'crlf')
    assert.equal(probe.finalNewline, true)

    // 用户在编辑器里改了一行；encoding/eol/finalNewline 原样回传（渲染层不得重新推断）
    const edited = (content as string).replace('第二行', '第二行改')
    await writeText(
      req(path, edited, {
        expectedDiskHash: probe.fastHash,
        encoding: 'utf-8-bom',
        eol: probe.eol,
        finalNewline: probe.finalNewline,
      }),
      { root: dir },
    )

    const after = await readFile(path)
    assert.deepEqual([...after.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM 必须保留')
    assert.equal(after.toString('utf-8').replace('\uFEFF', ''), '第一行\r\n第二行改\r\n', 'CRLF 与末尾换行必须保留')
    assert.ok(after.includes(0x0d), '不得被归一为 LF（否则 git 全文件 diff）')

    // 无 BOM + 无末尾换行的对照：不得被追加
    const p2 = join(dir, 'plain.txt')
    await writeFile(p2, 'a\nb', 'utf-8')
    const r2 = await readText(p2)
    await writeText(
      req(p2, `${r2.content}c`, {
        expectedDiskHash: r2.probe.fastHash,
        encoding: 'utf-8',
        eol: r2.probe.eol,
        finalNewline: r2.probe.finalNewline,
      }),
      { root: dir },
    )
    assert.equal(await readFile(p2, 'utf-8'), 'a\nbc', '原文件无末尾换行 → 保存后也不得追加')
    assert.deepEqual([...(await readFile(p2)).subarray(0, 3)], [0x61, 0x0a, 0x62])
  })
})

/* ---------- TC-WRITE-009 ---------- */

test('TC-WRITE-009 「覆盖磁盘」前落 .arkwork/history/<id>.snap 并返回 historyId', async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, 'g.txt')
    await writeFile(path, 'v0\n', 'utf-8')
    const r1 = await writeText(req(path, 'v1\n', { expectedDiskHash: undefined }), { root: dir })
    assert.ok(r1.historyId, '覆盖已存在文件必须返回 historyId')
    assert.equal(r1.historyId, historyIdFor(fastHash(Buffer.from('v0\n', 'utf-8'))))
    assert.ok(!r1.historyId.includes(':'), 'historyId 不得含 `:`（Windows 非法文件名字符）')

    const f = await stat(join(historyDirFor(dir), `${r1.historyId}.snap`))
    assert.ok(f.isFile())

    // 连续覆盖：不断累积快照，且互不覆盖
    const r2 = await writeText(req(path, 'v2\n', { expectedDiskHash: undefined }), { root: dir })
    assert.notEqual(r2.historyId, r1.historyId)
    assert.equal(await readFile(join(historyDirFor(dir), `${r2.historyId}.snap`), 'utf-8'), 'v1\n')
  })
})

/* ---------- TC-WRITE-010 ---------- */

test('TC-WRITE-010 本地历史写入失败 → 保存继续（历史是加分项，不阻断保存）', async () => {
  await withTmpDir(async (dir) => {
    // 故障注入：把 .arkwork/history 造成**文件**，mkdip 必失败（EEXIST/ENOTDIR）
    await mkdir(join(dir, '.arkwork'), { recursive: true })
    await writeFile(join(dir, '.arkwork', 'history'), 'not a directory')

    const path = join(dir, 'h.txt')
    await writeFile(path, 'old\n', 'utf-8')

    const res = await writeText(req(path, 'new\n', { expectedDiskHash: undefined }), { root: dir })
    assert.equal(res.historyId, undefined, '历史失败时 historyId 缺省')
    assert.deepEqual(await readFile(path, 'utf-8'), 'new\n', '保存必须继续进行')
    assert.equal(res.revision, fastHash(Buffer.from('new\n')))
  })
})

/* ---------- 附属契约：自写回环抑制 + hashFile ---------- */

test('writeText 登记自写抑制（chokidar 回环抑制的 500ms TTL）', async () => {
  clearSelfWrites()
  await withTmpDir(async (dir) => {
    const path = join(dir, 'self.txt')
    const res = await writeText(req(path, 'x\n'), { root: dir })
    assert.equal(isSelfWrite(path, res.revision), true, '刚写完的 (path, 新指纹) 必须命中自写登记')
    assert.equal(isSelfWrite(path, 'crc32:deadbeef:1'), false, '指纹不同 = 他人改动，不得误判为自写')
    assert.equal(isSelfWrite(path, res.revision, Date.now() + SELF_WRITE_TTL_MS + 1), false, 'TTL 过期即失效')

    markSelfWrite(path, 'crc32:11111111:1')
    assert.equal(isSelfWrite(path, 'crc32:11111111:1'), true)
    clearSelfWrites()
    assert.equal(isSelfWrite(path, 'crc32:11111111:1'), false)
  })
})

test('hashFile 与 writeText 的 revision / probe 基线三者同口径', async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, 'h.txt')
    await writeFile(path, Buffer.alloc(50 * 1024, 0x5a)) // 超过单窗口 → 走采样路径
    const viaFile = await hashFile(path, dir)
    const viaProbe = (await probeText(path)).fastHash
    const viaWrite = (await writeText(req(path, 'shrink\n'), { root: dir })).revision
    assert.equal(viaFile, viaProbe, 'hashFile 与 probeText 基线必须一致')
    assert.equal(viaWrite, fastHash(Buffer.from('shrink\n')))
    await assert.rejects(() => hashFile('/etc/passwd', dir), (e: FsError) => e.code === 'E_PATH_OUTSIDE_WORKSPACE')
  })
})
