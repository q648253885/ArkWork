/* ============================================================
 * v0.31.0 B2 — main/fs/text.ts 单测（TC-TEXT-001..010）
 *
 * 载体纪律（见 testcases/00-cumulative-matrix.md §3.5）：
 *  - **真实临时文件**（`fs.mkdtemp` 隔离工作区），不用 mock fs
 *  - 编码 / EOL / BOM / 末尾换行四项是「逐字节」断言，不是字符串相等
 *
 * 运行（cwd=app）：
 *   node scripts/run-tests.mjs main/fs/__tests__
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  READONLY_MAX_BYTES,
  BOM_UTF8,
  decodeBuffer,
  detectEncoding,
  encodeText,
  fastHash,
  fastHashFile,
  probeText,
  readText,
} from '../text.js'
import { applyFinalNewline, countLines, detectEol, hasFinalNewline } from '@shared/utils/eol'

/* ---------- 夹具 ---------- */

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'arkwork-text-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** 往返：磁盘字节 → probe/解码 → 按 probe 回传编码 → 字节，逐字节相等 */
async function roundTrip(path: string): Promise<Buffer> {
  const { probe, content } = await readText(path)
  assert.notEqual(content, null, '可解码文件的 content 不应为 null')
  return encodeText(content as string, {
    encoding: probe.encoding === 'utf-8-bom' ? 'utf-8-bom' : 'utf-8',
    eol: probe.eol,
    finalNewline: probe.finalNewline,
  })
}

/* ---------- TC-TEXT-001 ---------- */

test('TC-TEXT-001 UTF-8 无 BOM 往返：encode(decode(bytes)) 逐字节等于原 bytes', async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, 'plain.txt')
    const original = Buffer.from('第一行\nsecond line\n', 'utf-8')
    await writeFile(path, original)

    const probe = await probeText(path)
    assert.equal(probe.encoding, 'utf-8', '无 BOM 的 UTF-8 应探测为 utf-8')
    assert.equal(probe.exists, true)
    assert.equal(probe.readonlyReason, null)

    assert.deepEqual(await roundTrip(path), original, '往返必须逐字节相等')
  })
})

/* ---------- TC-TEXT-002 ---------- */

test('TC-TEXT-002 UTF-8 BOM 探测 + 回写保留 BOM', async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, 'bom.txt')
    const body = Buffer.from('带 BOM 的内容\n', 'utf-8')
    const original = Buffer.concat([Buffer.from([...BOM_UTF8]), body])
    await writeFile(path, original)

    const probe = await probeText(path)
    assert.equal(probe.encoding, 'utf-8-bom')

    const { content } = await readText(path)
    assert.equal(content, '带 BOM 的内容\n', 'BOM 必须被剥离后才进入编辑器')

    const written = await roundTrip(path)
    assert.deepEqual([...written.subarray(0, 3)], [...BOM_UTF8], '前 3 字节必须是 EF BB BF')
    assert.deepEqual(written, original, 'BOM 保真往返必须逐字节相等')
  })
})

/* ---------- TC-TEXT-003 ---------- */

test('TC-TEXT-003 CRLF 探测 + 回写保留 CRLF（不归一为 LF）', async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, 'crlf.txt')
    const original = Buffer.from('a\r\nb\r\nc\r\n', 'utf-8')
    await writeFile(path, original)

    const probe = await probeText(path)
    assert.equal(probe.eol, 'crlf')
    assert.equal(probe.finalNewline, true)

    const written = await roundTrip(path)
    assert.deepEqual(written, original, 'CRLF 必须原样保留，否则 git 出现全文件 diff 噪音')
    assert.ok(written.includes(0x0d), '写出结果必须仍含 CR')
  })
})

/* ---------- TC-TEXT-004 ---------- */

test('TC-TEXT-004 末尾换行双向原样保留', async () => {
  await withTmpDir(async (dir) => {
    const withNl = join(dir, 'with-nl.txt')
    const withoutNl = join(dir, 'without-nl.txt')
    const bufWith = Buffer.from('x\ny\n', 'utf-8')
    const bufWithout = Buffer.from('x\ny', 'utf-8')
    await writeFile(withNl, bufWith)
    await writeFile(withoutNl, bufWithout)

    const p1 = await probeText(withNl)
    const p2 = await probeText(withoutNl)
    assert.equal(p1.finalNewline, true)
    assert.equal(p2.finalNewline, false, '无末尾换行的文件不得被追加换行')

    assert.deepEqual(await roundTrip(withNl), bufWith)
    assert.deepEqual(await roundTrip(withoutNl), bufWithout)

    // 纯函数双向
    assert.equal(applyFinalNewline('a\nb\n\n', true), 'a\nb\n')
    assert.equal(applyFinalNewline('a\nb\n', false), 'a\nb')
    assert.equal(hasFinalNewline('a\nb'), false)
    assert.equal(detectEol('a\r\nb\nc'), 'crlf', '只要出现一个 CRLF 即判 crlf')
    assert.equal(countLines(''), 0, '空文件 = 0 行')
  })
})

/* ---------- TC-TEXT-005 ---------- */

test('TC-TEXT-005 GBK：可读（content 非 null）但只读（non-utf8）', async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, 'gbk.txt')
    // 「你好世界测试」的 GBK 字节（与 UTF-8 不同，且非 UTF-8 合法序列）
    const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0xca, 0xc0, 0xbd, 0xe7, 0xb2, 0xe2, 0xca, 0xd4])
    await writeFile(path, gbk)

    const probe = await probeText(path)
    assert.equal(probe.encoding, 'gbk', 'GBK 字节应被启发式判为 gbk（而非 big5 同分落选）')
    assert.equal(probe.readonlyReason, 'non-utf8', '非 UTF-8 一律只读')
    assert.equal(probe.readonlyDetail, 'GBK')

    const { content } = await readText(path)
    assert.equal(content, '你好世界测试', '正本 B14 落地细化：非 UTF-8 仍须可读，否则用户无从判断是否转码')

    // 只读 ≠ 不可读：encode 层不接受 gbk（只写 utf-8 / utf-8-bom）
    const utf8 = encodeText(content as string, { encoding: 'utf-8', eol: 'lf', finalNewline: false })
    assert.equal(utf8.toString('utf-8'), '你好世界测试')
  })
})

/* ---------- TC-TEXT-006 ---------- */

test('TC-TEXT-006 big5 / gb18030 解码正确性（Electron 33 full-ICU · L6 验证项）', async () => {
  // L6 的验证目标是「运行时带 full-ICU，这些编解码器可用」。
  // GBK 与 Big5 在字节层**并非完全可区分**（见 L17 遗留），故此处直接对
  // `decodeBuffer` 断言，而非依赖探测结果——这是有意的测试强度取舍。
  const big5Bytes = Buffer.from([0xa7, 0x41, 0xa4, 0x40]) // 「你一」
  const gbkBytes = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]) // 「你好」
  const gb18030FourByte = Buffer.from([0x81, 0x39, 0x9a, 0x30]) // U+1E7A0 附近的 4 字节区

  assert.equal(decodeBuffer(big5Bytes, 'big5'), '你一')
  assert.equal(decodeBuffer(gbkBytes, 'gb18030'), '你好')
  assert.equal(decodeBuffer(gbkBytes, 'gbk'), '你好')
  assert.ok(decodeBuffer(gb18030FourByte, 'gb18030').length > 0, 'gb18030 四字节区必须可解码')

  // 转码保真：非 UTF-8 内容转 UTF-8 后字符不丢（B14「只读不可写」的转码出口）
  const transcoded = decodeBuffer(big5Bytes, 'big5')
  const back = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(transcoded, 'utf-8'))
  assert.equal(back, '你一')

  // 探测层：GBK 与 Big5 同分时 gbk 胜出（候选顺序即优先级）
  assert.equal(detectEncoding(gbkBytes), 'gbk')
})

/* ---------- TC-TEXT-007 ---------- */

test('TC-TEXT-007 UTF-16LE / UTF-16BE 探测与解码（含 BOM）', async () => {
  await withTmpDir(async (dir) => {
    const lePath = join(dir, 'le.txt')
    const bePath = join(dir, 'be.txt')
    // 'hi' 的 UTF-16：LE = 68 00 69 00；BE = 00 68 00 69
    const le = Buffer.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00])
    const be = Buffer.from([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69])
    await writeFile(lePath, le)
    await writeFile(bePath, be)

    const ple = await probeText(lePath)
    const pbe = await probeText(bePath)
    assert.equal(ple.encoding, 'utf-16le')
    assert.equal(pbe.encoding, 'utf-16be')

    const rle = await readText(lePath)
    const rbe = await readText(bePath)
    assert.equal(rle.content, 'hi')
    assert.equal(rbe.content, 'hi')

    // UTF-16 属非 UTF-8 → 只读（可读不可写）
    assert.equal(ple.readonlyReason, 'non-utf8')
    assert.equal(pbe.readonlyReason, 'non-utf8')
  })
})

/* ---------- TC-TEXT-008 ---------- */

test('TC-TEXT-008 NUL 字节 → binary，content = null，不尝试解码', async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, 'blob.bin')
    // PNG 魔数 + NUL：无 BOM 的二进制
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
    await writeFile(path, buf)

    const probe = await probeText(path)
    assert.equal(probe.encoding, 'binary')
    assert.equal(probe.readonlyReason, 'binary')
    assert.match(String(probe.readonlyDetail), /^NUL @ 0x[0-9a-f]+$/)

    const { content } = await readText(path)
    assert.equal(content, null, 'binary 不得返回文本')
    assert.equal(decodeBuffer(buf, 'binary'), '', 'binary 解码恒为空串（调用方应据 readonlyReason 拦截）')
  })
})

/* ---------- TC-TEXT-009 ---------- */

test('TC-TEXT-009 快速哈希：同内容同 hash / 改一字节即变 / 跨进程稳定 / 与流式同口径', async () => {
  // 跨进程稳定：用**独立实现**（Python zlib.crc32 实测值）锁死格式与数值
  assert.equal(fastHash(Buffer.from('hello world', 'utf-8')), 'crc32:0d4a1185:b')
  assert.match(fastHash(Buffer.from('x')), /^crc32:[0-9a-f]{8}:[0-9a-f]+$/)
  assert.equal(fastHash(Buffer.from('')), 'crc32:00000000:0')

  // 同内容同 hash（不同对象、不同进程皆然）
  assert.equal(fastHash(Buffer.from('abc')), fastHash(Buffer.from('abc')))

  // 改 1 字节即变（采样窗口内）
  const a = Buffer.from('hello world')
  const b = Buffer.from('hello worlD')
  assert.notEqual(fastHash(a), fastHash(b))

  await withTmpDir(async (dir) => {
    // 大文件：采样窗口内改 1 字节必须变
    const big = Buffer.alloc(64 * 1024, 0x41)
    const bigPath = join(dir, 'big.txt')
    await writeFile(bigPath, big)
    const h1 = await fastHashFile(bigPath, big.length)
    assert.equal(h1, fastHash(big), 'fastHashFile 与 fastHash 必须同口径（否则 CAS 必然假冲突）')

    const mutated = Buffer.from(big)
    mutated[10] = 0x42
    const bigPath2 = join(dir, 'big2.txt')
    await writeFile(bigPath2, mutated)
    assert.notEqual(await fastHashFile(bigPath2, mutated.length), h1)

    // 串里带真实长度
    assert.ok(h1.endsWith(`:${big.length.toString(16)}`), '哈希串必须携带真实字节长度')
  })
})

/* ---------- TC-TEXT-010 ---------- */

test('TC-TEXT-010 超 readOnlyMaxBytes → too-large，content = null', async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, 'large.txt')
    await writeFile(path, Buffer.alloc(4096, 0x41))

    const probe = await probeText(path, { maxBytes: 1024 })
    assert.equal(probe.readonlyReason, 'too-large')
    assert.match(String(probe.readonlyDetail), /4\.0 KB > 1\.0 KB/)
    assert.equal(probe.byteLength, 4096, '真实字节数必须如实上报')
    assert.equal(probe.lineCount, 0, '超限文件不做全文解码，行数不猜')

    const { content, probe: p2 } = await readText(path, { maxBytes: 1024 })
    assert.equal(content, null)
    assert.equal(p2.readonlyReason, 'too-large')

    // 未超限时同一文件可编辑
    const ok = await probeText(path, { maxBytes: READONLY_MAX_BYTES })
    assert.equal(ok.readonlyReason, null)
  })
})

/* ---------- 只读七原因补充：缺权限位（TC-GUARD-006 的 text 侧事实） ---------- */

test('probeText 缺写权限位 → readonlyReason = permission 且 detail 含具体权限位', async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, 'ro.txt')
    await writeFile(path, 'content\n')
    await chmod(path, 0o444)
    const probe = await probeText(path)
    await chmod(path, 0o644) // 复原，避免影响目录清理
    assert.equal(probe.readonlyReason, 'permission')
    assert.match(String(probe.readonlyDetail), /mode 0444/)
    assert.match(String(probe.readonlyDetail), /owner/)
  })
})

/* ---------- 缺失文件（deleted）不抛错 ---------- */

test('probeText 缺失文件 → exists:false + deleted（只读是正常态，不是异常态）', async () => {
  await withTmpDir(async (dir) => {
    const probe = await probeText(join(dir, 'nope.txt'))
    assert.equal(probe.exists, false)
    assert.equal(probe.readonlyReason, 'deleted')
    assert.equal(probe.fastHash, 'crc32:00000000:0')

    const { content, language } = await readText(join(dir, 'nope.txt'))
    assert.equal(content, null)
    assert.equal(language, 'text')
  })
})

/* ---------- 语言判定（复用 workspace.detectLanguage） ---------- */

test('readText 语言判定复用 workspace 扩展名表', async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, 'x.md')
    await writeFile(path, '# t\n', 'utf-8')
    const { language } = await readText(path)
    assert.equal(language, 'markdown')
    assert.equal(await readFile(path, 'utf-8'), '# t\n')
  })
})
