/* ============================================================
 * v0.31.0 B2 — renderer/services/editorDoc.ts 单测（TC-DOC-001..008）
 *
 * 载体纪律（见 testcases/00-cumulative-matrix.md §3.8）：
 *  - **纯函数 + 状态机，无 CM6 实例、无 React、无真实 IPC**
 *  - IPC 用最小 io 桩替身：只为断言「渲染层回传了什么」，不重测主进程
 *  - 每个用例点名一条设计约束（C-2 / C-3 / C-6 / C-12 / J3 / J9）
 *
 * 规格见 docs/versions/v0.31.0/04-system-design.md §4.3.2 / §5.4.3 / §5.4.4。
 *
 * 运行（cwd=app）：
 *   node scripts/run-tests.mjs renderer/services/__tests__
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_DOC_TABS,
  applyConflict,
  applyFailed,
  applyRevertedToDisk,
  applySaved,
  beginSave,
  createEditorDoc,
  deriveCloseProtectedPaths,
  deriveDirtyPaths,
  docStatus,
  encodingLabel,
  markDirty,
  saveEditorDoc,
  selectLruEvictions,
  setViewMode,
  touchDoc,
  type EditorHandle,
  type SaveIo,
} from '../editorDoc.js'
import type {
  ConflictInfo,
  EditorDocMeta,
  ReadonlyReason,
  TextProbe,
  WriteTextRequest,
  WriteTextResult,
} from '@shared/types/fs'

/* ---------- 夹具 ---------- */

function mkProbe(overrides: Partial<TextProbe> = {}): TextProbe {
  return {
    path: '/ws/src/a.ts',
    exists: true,
    byteLength: 128,
    lineCount: 5,
    encoding: 'utf-8',
    eol: 'lf',
    finalNewline: true,
    mtimeMs: 1_700_000_000_000,
    mode: 0o644,
    readonlyReason: null,
    fastHash: 'crc32:0d4a1185:b',
    ...overrides,
  }
}

/** 只读探针（binary 为例，只读原因判定见 main/fs/text.detectEncoding） */
function mkReadonlyProbe(reason: ReadonlyReason, detail?: string): TextProbe {
  return mkProbe({
    encoding: reason === 'binary' ? 'binary' : 'utf-8',
    readonlyReason: reason,
    ...(detail ? { readonlyDetail: detail } : {}),
  })
}

/** 文本真源替身：EditorState 只透出 getText() */
function mkHandle(text: string): Pick<EditorHandle, 'getText'> {
  return { getText: () => text }
}

interface CapturedIo extends SaveIo {
  requests: WriteTextRequest[]
  nowMs: number
}

/** io 桩：记录回传请求，按用例给定的应答/异常返回 */
function mkIo(
  answer: WriteTextResult | Error | ((req: WriteTextRequest) => WriteTextResult | Error),
): CapturedIo {
  const io: CapturedIo = {
    requests: [],
    nowMs: 1_700_000_100_000,
    now: () => io.nowMs,
    async writeText(req) {
      io.requests.push(req)
      const reply = typeof answer === 'function' ? answer(req) : answer
      if (reply instanceof Error) throw reply
      return reply
    },
  }
  return io
}

/** 构造带 code/payload 的跨 IPC 错误（preload 解码后的形态） */
function fsError(code: string, message: string, payload?: unknown): Error {
  const err = new Error(message) as Error & { code?: string; payload?: unknown }
  err.code = code
  if (payload !== undefined) err.payload = payload
  return err
}

function mkConflictInfo(): ConflictInfo {
  return {
    path: '/ws/src/a.ts',
    diskHash: 'crc32:deadbeef:200',
    diskMtimeMs: 1_700_000_050_000,
    source: 'external',
    diskText: 'externally edited\n',
    diskProbe: mkProbe({ fastHash: 'crc32:deadbeef:200' }),
  }
}

function opened(probe: TextProbe = mkProbe()): EditorDocMeta {
  return createEditorDoc(probe, 'typescript', 1_000)
}

/* ============================================================
 * TC-DOC-001 · §4.3.2 字段映射表逐项填充（不得造第二套）
 * ============================================================ */
test('TC-DOC-001 createEditorDoc 按 §4.3.2 映射表逐项填充', () => {
  const probe = mkProbe({ readonlyDetail: undefined })
  const doc = createEditorDoc(probe, 'typescript', 42_000)

  // 直取 probe 的字段
  assert.equal(doc.path, probe.path)
  assert.equal(doc.language, 'typescript')
  assert.equal(doc.readonlyReason, null)
  assert.equal(doc.diskSnapshotHash, probe.fastHash)
  assert.equal(doc.encoding, probe.encoding)
  assert.equal(doc.eol, probe.eol)
  assert.equal(doc.finalNewline, probe.finalNewline)

  // 派生字段（editable / viewMode）——唯一正确来源是 readonlyReason
  assert.equal(doc.editable, true, 'readonlyReason === null ⇒ editable')
  assert.equal(doc.viewMode, 'edit', '可编辑文档默认 source 视图')

  // 初始状态
  assert.equal(doc.dirty, false)
  assert.equal(doc.conflict, null)
  assert.equal(doc.saveState, 'idle')

  // LRU 双时间戳同源
  assert.equal(doc.openedAt, 42_000)
  assert.equal(doc.lastActiveAt, 42_000)

  // 可选字段缺省时不得写入 readonlyDetail 键（避免 undefined 漂移）
  assert.equal('readonlyDetail' in doc, false, 'probe 无 detail 时不得留 undefined 键')

  // 只读探针：editable=false 且 viewMode 锁 'render'
  const ro = createEditorDoc(mkReadonlyProbe('binary', 'NUL byte at 0x10'), 'plaintext', 7)
  assert.equal(ro.editable, false)
  assert.equal(ro.readonlyReason, 'binary')
  assert.equal(ro.readonlyDetail, 'NUL byte at 0x10')
  assert.equal(ro.viewMode, 'render', '只读文档不得停在编辑视图')
})

/* ============================================================
 * TC-DOC-002 · 编码三件套带入 + 保存原样回传（C-6 保真唯一职责）
 * ============================================================ */
test('TC-DOC-002 encoding/eol/finalNewline 从 probe 带入并原样回传', async () => {
  // CRLF + BOM + 无末尾换行 —— 三个易被「顺手归一化」的点同时施压
  const probe = mkProbe({ encoding: 'utf-8-bom', eol: 'crlf', finalNewline: false })
  const doc = opened(probe)

  assert.equal(doc.encoding, 'utf-8-bom')
  assert.equal(doc.eol, 'crlf')
  assert.equal(doc.finalNewline, false)

  const io = mkIo({ path: probe.path, bytes: 12, revision: 'crc32:11111111:c', mtimeMs: 1 })
  await saveEditorDoc({ ...doc, dirty: true }, mkHandle('x\r\n'), io)

  assert.equal(io.requests.length, 1)
  const req = io.requests[0]
  assert.equal(req.encoding, 'utf-8-bom', '编码必须原样回传')
  assert.equal(req.eol, 'crlf', '换行风格必须原样回传')
  assert.equal(req.finalNewline, false, '末尾换行约定必须原样回传')
  assert.equal(req.origin, 'user-save')

  // 反向：utf-16le 之类不可写编码一律折叠为 utf-8（只读文档本不该走到这，防误用）
  const weird = { ...doc, encoding: 'utf-16le' as const }
  const io2 = mkIo({ path: probe.path, bytes: 1, revision: 'h2', mtimeMs: 2 })
  await saveEditorDoc({ ...weird, dirty: true }, mkHandle('y'), io2)
  assert.equal(io2.requests[0].encoding, 'utf-8')
})

/* ============================================================
 * TC-DOC-003 · CLEAN → DIRTY → SAVING → CLEAN，基线前移到 revision
 * ============================================================ */
test('TC-DOC-003 状态机迁移与 diskSnapshotHash 基线前移', () => {
  let doc = opened()
  assert.equal(docStatus(doc), 'clean')

  doc = markDirty(doc, true, 2_000)
  assert.equal(docStatus(doc), 'dirty')
  assert.equal(doc.lastActiveAt, 2_000)

  doc = beginSave(doc)
  assert.equal(doc.saveState, 'saving')
  assert.equal(docStatus(doc), 'saving', 'saving 优先于 dirty 展示')

  doc = applySaved(doc, 'crc32:newhash:3f', 3_000)
  assert.equal(doc.saveState, 'idle')
  assert.equal(doc.dirty, false)
  assert.equal(docStatus(doc), 'clean')
  assert.equal(doc.diskSnapshotHash, 'crc32:newhash:3f', '基线必须前移到新 revision')

  // 冲突态优先于一切
  const conflicted = applyConflict(doc, mkConflictInfo(), 4_000)
  assert.equal(docStatus(conflicted), 'conflicted')

  // markDirty 幂等时也要刷新 lastActiveAt（LRU 需要活跃信号）
  const same = markDirty(conflicted, true, 5_000)
  assert.equal(same.dirty, true)
  assert.equal(same.lastActiveAt, 5_000)
})

/* ============================================================
 * TC-DOC-004 · per-doc 互斥：saving 中再次保存 ⇒ skipped('busy')
 * ============================================================ */
test('TC-DOC-004 saveState !== idle 时再次保存返回 skipped(busy)', async () => {
  const io = mkIo({ path: '/ws/src/a.ts', bytes: 1, revision: 'h', mtimeMs: 1 })

  // 连按 Mod+S：第一次进入 saving，第二次必须被挡掉且**不发第二次 IPC**
  const saving = beginSave({ ...opened(), dirty: true })
  const first = await saveEditorDoc(saving, mkHandle('z'), io)
  assert.deepEqual(first, { kind: 'skipped', reason: 'busy' })
  assert.equal(io.requests.length, 0, 'busy 时不得发出写请求')

  // 非 dirty 且非 force ⇒ clean
  assert.deepEqual(await saveEditorDoc(opened(), mkHandle(''), io), {
    kind: 'skipped',
    reason: 'clean',
  })

  // 只读文档 ⇒ not-editable（force 才放行）
  const ro = createEditorDoc(mkReadonlyProbe('permission', 'mode 0444'), 'plaintext')
  const io2 = mkIo({ path: ro.path, bytes: 1, revision: 'h', mtimeMs: 1 })
  assert.deepEqual(await saveEditorDoc({ ...ro, dirty: true }, mkHandle('t'), io2), {
    kind: 'skipped',
    reason: 'not-editable',
  })
  assert.equal(io2.requests.length, 0)
})

/* ============================================================
 * TC-DOC-005 · 保存失败 ⇒ failed，且 dirty 保持 true（关键回归）
 * ============================================================ */
test('TC-DOC-005 保存失败返回 failed 且 dirty 绝不被静默清除', async () => {
  const io = mkIo(new Error('EACCES: permission denied'))
  const dirtyDoc = { ...opened(), dirty: true }

  const outcome = await saveEditorDoc(dirtyDoc, mkHandle('edited'), io)
  assert.equal(outcome.kind, 'failed')
  assert.match((outcome as { message: string }).message, /permission denied/)

  // applyFailed：saveState 归位 idle（否则文档永久卡在 saving），dirty 必须保留
  const after = applyFailed(beginSave(dirtyDoc), 9_000)
  assert.equal(after.saveState, 'idle')
  assert.equal(after.dirty, true, '失败后 dirty 必须为 true —— 否则用户改动被静默丢弃')
  assert.equal(docStatus(after), 'dirty')

  // 明文错误（未带 code）也归入 failed，不得误判为 conflict
  const io2 = mkIo(fsError('E_WRITE_FAILED', 'disk full'))
  const o2 = await saveEditorDoc(dirtyDoc, mkHandle('edited'), io2)
  assert.equal(o2.kind, 'failed')
})

/* ============================================================
 * TC-DOC-006 · 冲突 ⇒ conflict 摘要落地，编辑缓冲不丢（J3 不自动合并）
 * ============================================================ */
test('TC-DOC-006 冲突返回 ConflictInfo 且缓冲与 dirty 均保留', async () => {
  const info = mkConflictInfo()
  const io = mkIo(fsError('E_CONFLICT', 'disk changed', info))
  // 用户缓冲内容：必须原封不动
  const buffer = 'my local edit — 用户内容\n'
  const handle = mkHandle(buffer)
  const dirtyDoc = { ...opened(), dirty: true }

  const outcome = await saveEditorDoc(dirtyDoc, handle, io)
  assert.equal(outcome.kind, 'conflict')
  const got = (outcome as { info: ConflictInfo }).info
  assert.equal(got.diskHash, info.diskHash)
  assert.equal(got.source, 'external')

  // 关键：CAS 不等于「已写盘」，比较前不得覆盖磁盘
  assert.equal(io.requests.length, 1)
  assert.equal(io.requests[0].expectedDiskHash, dirtyDoc.diskSnapshotHash)
  assert.equal(io.requests[0].content, buffer, '冲突时用户缓冲不得被替换')

  const after = applyConflict(beginSave(dirtyDoc), got, 6_000)
  assert.equal(after.dirty, true, '冲突后仍是未保存状态')
  assert.equal(after.saveState, 'idle')
  assert.deepEqual(after.conflict, {
    diskHash: info.diskHash,
    diskMtimeMs: info.diskMtimeMs,
    source: 'external',
  })
  assert.equal(docStatus(after), 'conflicted')
  assert.equal(handle.getText(), buffer, '缓冲文本仍在（真源是 EditorState，本层不动它）')

  // E_CONFLICT 但 payload 缺失/畸形 ⇒ 退化为 failed，不得抛未捕获异常
  const io2 = mkIo(fsError('E_CONFLICT', 'no payload'))
  assert.equal((await saveEditorDoc(dirtyDoc, handle, io2)).kind, 'failed')
  const io3 = mkIo(fsError('E_CONFLICT', 'bad payload', { nope: 1 }))
  assert.equal((await saveEditorDoc(dirtyDoc, handle, io3)).kind, 'failed')

  // 「覆盖磁盘」分支：force 时跳过 CAS（不带 expectedDiskHash）
  const io4 = mkIo({ path: dirtyDoc.path, bytes: 3, revision: 'h4', mtimeMs: 4 })
  const forced = await saveEditorDoc(dirtyDoc, handle, io4, { force: true })
  assert.equal(forced.kind, 'saved')
  assert.equal('expectedDiskHash' in io4.requests[0], false, 'force 分支必须跳过 CAS')

  // 还原磁盘：冲突清空、三件套随磁盘刷新
  const diskProbe = mkProbe({ encoding: 'utf-8', eol: 'crlf', finalNewline: true, fastHash: 'h5' })
  const reverted = applyRevertedToDisk(after, diskProbe, 7_000)
  assert.equal(reverted.conflict, null)
  assert.equal(reverted.dirty, false)
  assert.equal(reverted.diskSnapshotHash, 'h5')
  assert.equal(reverted.eol, 'crlf', '还原后换行风格必须跟磁盘走')
})

/* ============================================================
 * TC-DOC-007 · Tab 软上限 20 的 LRU 淘汰，dirty Tab 永不淘汰（J9）
 * ============================================================ */
test('TC-DOC-007 LRU 淘汰只动非 dirty Tab，且以 lastActiveAt 为准', () => {
  assert.equal(MAX_DOC_TABS, 20)

  const docs: Record<string, EditorDocMeta> = {}
  const mk = (n: number, dirty: boolean, at: number): EditorDocMeta => ({
    ...opened(mkProbe({ path: `/ws/${n}.ts` })),
    path: `/ws/${n}.ts`,
    dirty,
    lastActiveAt: at,
  })

  // 21 个 Tab：0 号最久未用且 dirty；1 号次久但干净；2..20 新鲜
  for (let i = 2; i <= 20; i++) docs[`/ws/${i}.ts`] = mk(i, false, 1_000 + i)
  docs['/ws/0.ts'] = mk(0, true, 0) // 最久未用，但 dirty
  docs['/ws/1.ts'] = mk(1, false, 1) // 次久未用，干净

  const evicted = selectLruEvictions(docs)
  assert.equal(evicted.length, 1, '超出 1 个 ⇒ 只淘汰 1 个')
  assert.deepEqual(evicted, ['/ws/1.ts'], '淘汰干净且最久未用的；dirty 的 0 号必须保住')

  // 未超限 ⇒ 不淘汰
  const underLimit: Record<string, EditorDocMeta> = { ...docs }
  delete underLimit['/ws/20.ts']
  assert.deepEqual(selectLruEvictions(underLimit), [])

  // 全部 dirty ⇒ 宁可不淘汰，也不丢用户内容
  const allDirty: Record<string, EditorDocMeta> = {}
  for (let i = 0; i <= 20; i++) allDirty[`/ws/${i}.ts`] = mk(i, true, i)
  assert.deepEqual(selectLruEvictions(allDirty), [])

  // saving / conflicted 同样受保护：它们 lastActiveAt 最小（最该被淘汰），
  // 但受保护 ⇒ 只能退而淘汰最久未用的干净 Tab（/ws/2.ts）
  const saving = mk(21, false, -1)
  saving.saveState = 'saving'
  const conflicted = mk(22, false, -2)
  conflicted.conflict = { diskHash: 'h', diskMtimeMs: 0, source: 'external' }
  const mixed: Record<string, EditorDocMeta> = { '/ws/21.ts': saving, '/ws/22.ts': conflicted }
  for (let i = 2; i <= 20; i++) mixed[`/ws/${i}.ts`] = mk(i, false, 1_000 + i)
  assert.equal(Object.keys(mixed).length, 21, '夹具应为 21 个 Tab（超限 1）')
  assert.deepEqual(selectLruEvictions(mixed), ['/ws/2.ts'], 'saving/conflicted 不得淘汰')
})

/* ============================================================
 * TC-DOC-008 · dirtyPaths 派生自 docs，不单独存（C-12 契约固化）
 * ============================================================ */
test('TC-DOC-008 dirtyPaths 与关闭保护集均为派生值', () => {
  const docs: Record<string, EditorDocMeta> = {
    '/ws/dirty.ts': { ...opened(mkProbe({ path: '/ws/dirty.ts' })), path: '/ws/dirty.ts', dirty: true },
    '/ws/clean.ts': { ...opened(mkProbe({ path: '/ws/clean.ts' })), path: '/ws/clean.ts' },
    '/ws/conflict.ts': {
      ...opened(mkProbe({ path: '/ws/conflict.ts' })),
      path: '/ws/conflict.ts',
      dirty: true,
      conflict: { diskHash: 'h', diskMtimeMs: 0, source: 'agent' },
    },
  }

  assert.deepEqual(deriveDirtyPaths(docs).sort(), ['/ws/conflict.ts', '/ws/dirty.ts'])

  // 派生值随 docs 变化，无需任何同步代码（这正是「不单独存」的理由）
  delete docs['/ws/dirty.ts']
  assert.deepEqual(deriveDirtyPaths(docs), ['/ws/conflict.ts'])

  // 关闭保护集：dirty ∪ saving
  const saving: EditorDocMeta = {
    ...opened(mkProbe({ path: '/ws/saving.ts' })),
    path: '/ws/saving.ts',
    saveState: 'saving',
  }
  const guarded = deriveCloseProtectedPaths({ ...docs, '/ws/saving.ts': saving }).sort()
  assert.deepEqual(guarded, ['/ws/conflict.ts', '/ws/saving.ts'])
  assert.deepEqual(deriveCloseProtectedPaths({}), [])

  // 视图态：只读锁 render（v0.31.0 C1：split 已删，视图只剩 edit / render）
  const ro = createEditorDoc(mkReadonlyProbe('too-large'), 'plaintext')
  assert.equal(setViewMode(ro, 'render').viewMode, 'render', '只读文档锁定只读渲染')
  const editable = opened()
  assert.equal(setViewMode(editable, 'render').viewMode, 'render')
  assert.equal(setViewMode(setViewMode(editable, 'render'), 'edit').viewMode, 'edit', '可来回切换')

  // touchDoc 只动活跃时间，不动内容
  const touched = touchDoc({ ...editable, dirty: true }, 12_345)
  assert.equal(touched.lastActiveAt, 12_345)
  assert.equal(touched.dirty, true)

  // 状态条文案（原型 07）：三件套全部可见
  assert.equal(encodingLabel(opened(mkProbe({ encoding: 'utf-8', eol: 'lf' }))), 'UTF-8 · LF')
  assert.equal(
    encodingLabel(opened(mkProbe({ encoding: 'utf-8-bom', eol: 'crlf', finalNewline: false }))),
    'UTF-8 BOM · CRLF · 无末尾换行',
  )
})
