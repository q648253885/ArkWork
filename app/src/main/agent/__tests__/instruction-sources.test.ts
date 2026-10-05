/* ============================================================
 * ArkWork — 指令源发现器用例库（TC-INS 组 · v0.47.0）
 * 设计文档：docs/versions/v0.47.0/04-system-design.md §二/§三
 *
 * 钉住 AGENTS.md（Codex 兼容）加载语义：
 *  · 全局层：~/.codex/AGENTS.md（接管 Codex 关键）→ ~/.arkwork/*；
 *  · 项目链：workspace 向上祖先链**全收集**，根→叶拼接（root-down，越近越后）；
 *  · 文件名优先级：AGENTS.md > AGENT.md > CLAUDE.md > CONTEXT.md；
 *  · 合并预算 32KiB（对齐 Codex project_doc_max_bytes），超额截断 + 后续跳过；
 *  · 嵌套就近注入：工作区内触达祖先链，根排除、已注入去重、单轮 8KiB。
 *
 * 全局源依赖 process.env.HOME（调用时读取）→ 每条用例经 withHome 隔离。
 * 运行（cwd=app）：node scripts/run-tests.mjs instruction-sources
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { stripComments } from '@shared/utils/source-guard'
import {
  discoverInstructionSources,
  ancestorDirsUnderWorkspace,
  collectNestedInstructions,
  renderInstructionSourcesBlock,
  INSTRUCTION_MERGE_BUDGET_BYTES,
  NESTED_TURN_BUDGET_BYTES,
} from '../instruction-sources.js'

/* ---------- 夹具 ---------- */
const seq = { n: 0 }
function mkDir(prefix: string): string {
  const p = join(tmpdir(), `${prefix}-${Date.now()}-${++seq.n}-${Math.random().toString(36).slice(2, 6)}`)
  mkdirSync(p, { recursive: true })
  return p
}
function withHome<T>(fn: (home: string) => T | Promise<T>): Promise<T> {
  const prev = process.env.HOME
  const home = mkDir('arkwork-ins-home')
  process.env.HOME = home
  return (async () => await fn(home))().finally(() => {
    if (prev === undefined) delete process.env.HOME
    else process.env.HOME = prev
  })
}

/* ---------- 1. 发现：全局层 ---------- */

test('TC-INS-001 ★ 全局层发现 ~/.codex/AGENTS.md（接管 Codex 关键），顺序在 ~/.arkwork 之前', async () => {
  await withHome(async (home) => {
    mkdirSync(join(home, '.codex'), { recursive: true })
    mkdirSync(join(home, '.arkwork'), { recursive: true })
    writeFileSync(join(home, '.codex', 'AGENTS.md'), 'codex-global-rule')
    writeFileSync(join(home, '.arkwork', 'AGENTS.md'), 'arkwork-global-rule')
    const ws = mkDir('arkwork-ins-ws')
    const d = discoverInstructionSources(ws)
    const scopes = d.sources.map((s) => s.scope)
    assert.deepEqual(scopes, ['codex-global', 'arkwork-global'])
    assert.match(d.sources[0]!.content, /codex-global-rule/)
    assert.match(d.sources[1]!.content, /arkwork-global-rule/)
    assert.ok(d.sources.every((s) => s.relPath === null), '全局源 relPath 必须为 null')
  })
})

test('TC-INS-002 无全局文件时全局层为空（不报错不占位）', async () => {
  await withHome(async () => {
    const d = discoverInstructionSources(mkDir('arkwork-ins-ws'))
    assert.equal(d.sources.length, 0)
    assert.equal(d.mergedBytes, 0)
    assert.equal(d.budgetExhausted, false)
  })
})

/* ---------- 2. 发现：项目链 ---------- */

test('TC-INS-003 工作区根 AGENTS.md → project-chain 单源，relPath 正确', () => {
  const ws = mkDir('arkwork-ins-ws')
  writeFileSync(join(ws, 'AGENTS.md'), '# 项目规则\n不要写注释')
  const d = discoverInstructionSources(ws)
  assert.equal(d.sources.length, 1)
  assert.equal(d.sources[0]!.scope, 'project-chain')
  assert.equal(d.sources[0]!.relPath, 'AGENTS.md')
  assert.match(d.sources[0]!.content, /不要写注释/)
})

test('TC-INS-004 ★ 祖先链全收集 + 根→叶拼接（monorepo 接管：外层约定不丢）', () => {
  const repo = mkDir('arkwork-ins-repo')
  const app = join(repo, 'packages', 'app')
  mkdirSync(app, { recursive: true })
  writeFileSync(join(repo, 'AGENTS.md'), 'repo-level-rule')
  writeFileSync(join(repo, 'packages', 'AGENTS.md'), 'packages-level-rule')
  writeFileSync(join(app, 'AGENTS.md'), 'app-level-rule')
  const d = discoverInstructionSources(app)
  const contents = d.sources.map((s) => s.content)
  assert.equal(d.sources.length, 3, '链上三层必须全部收集（旧实现只取最近一层）')
  assert.match(contents[0]!, /repo-level-rule/)
  assert.match(contents[1]!, /packages-level-rule/)
  assert.match(contents[2]!, /app-level-rule/)
  // relPath 相对 workspace：外层源以 .. 开头
  assert.equal(d.sources[0]!.relPath, join('..', '..', 'AGENTS.md'))
  assert.equal(d.sources[2]!.relPath, 'AGENTS.md')
})

test('TC-INS-005 同目录文件名优先级：AGENTS.md > AGENT.md > CLAUDE.md > CONTEXT.md', () => {
  const ws = mkDir('arkwork-ins-ws')
  writeFileSync(join(ws, 'AGENTS.md'), 'A')
  writeFileSync(join(ws, 'AGENT.md'), 'A-variant')
  writeFileSync(join(ws, 'CLAUDE.md'), 'C')
  assert.equal(discoverInstructionSources(ws).sources.length, 1, '同目录只取优先级最高的一个')

  const ws2 = mkDir('arkwork-ins-ws2')
  writeFileSync(join(ws2, 'AGENT.md'), 'A-variant')
  const d2 = discoverInstructionSources(ws2)
  assert.equal(d2.sources.length, 1)
  assert.match(d2.sources[0]!.path, /AGENT\.md$/, '无 AGENTS.md 时回落 AGENT.md（官方迁移容错）')

  const ws3 = mkDir('arkwork-ins-ws3')
  writeFileSync(join(ws3, 'CONTEXT.md'), 'X')
  assert.match(discoverInstructionSources(ws3).sources[0]!.path, /CONTEXT\.md$/)
})

test('TC-INS-006 ★ 合并预算：链上多源超预算 → 后续源跳过；单源超预算 → 截断 + 尾注指引', () => {
  // 场景 A：链上两个 20KB（父 + 子）→ 第源 20KB < 32KiB 不截断；第二源剩 12KB < 20KB → 跳过
  const chain = mkDir('arkwork-ins-chain')
  writeFileSync(join(chain, 'AGENTS.md'), 'P'.repeat(20 * 1024))
  const child = join(chain, 'sub')
  mkdirSync(child, { recursive: true })
  writeFileSync(join(child, 'AGENTS.md'), 'W'.repeat(20 * 1024))
  const d = discoverInstructionSources(child)
  assert.equal(d.sources.length, 2, '第一源收下；第二源按剩余预算截断收下')
  assert.equal(d.sources[0]!.truncated, false)
  assert.equal(d.sources[1]!.truncated, true, '剩余 12KB < 20KB → 第二源截断')
  assert.equal(d.sources[1]!.bytes, INSTRUCTION_MERGE_BUDGET_BYTES - 20 * 1024)
  assert.equal(d.mergedBytes, INSTRUCTION_MERGE_BUDGET_BYTES)
  assert.equal(d.budgetExhausted, true, '预算尽 → 其后不再并入')

  // 场景 B：单源 33KB → 截断在预算处，尾注指引 file-reader
  const huge = mkDir('arkwork-ins-huge')
  writeFileSync(join(huge, 'AGENTS.md'), 'H'.repeat(INSTRUCTION_MERGE_BUDGET_BYTES + 1024))
  const d2 = discoverInstructionSources(huge)
  assert.equal(d2.sources.length, 1)
  assert.equal(d2.sources[0]!.truncated, true)
  assert.equal(d2.sources[0]!.bytes, INSTRUCTION_MERGE_BUDGET_BYTES)
  assert.match(d2.sources[0]!.content, /已截断/)
  assert.match(d2.sources[0]!.content, /file-reader/)
})

test('TC-INS-007 预算常量对齐 Codex 默认（32KiB / 嵌套 8KiB）', () => {
  assert.equal(INSTRUCTION_MERGE_BUDGET_BYTES, 32 * 1024)
  assert.equal(NESTED_TURN_BUDGET_BYTES, 8 * 1024)
})

/* ---------- 3. 嵌套就近注入 ---------- */

test('TC-INS-008 ★ ancestorDirsUnderWorkspace：工作区内 root→叶；工作区外为空', () => {
  const ws = mkDir('arkwork-ins-ws')
  const sub = join(ws, 'src', 'components')
  mkdirSync(sub, { recursive: true })
  assert.deepEqual(ancestorDirsUnderWorkspace(ws, join(sub, 'a.tsx')), [ws, join(ws, 'src'), sub])
  // 工作区外（兄弟目录）
  const outside = mkDir('arkwork-ins-outside')
  assert.deepEqual(ancestorDirsUnderWorkspace(ws, join(outside, 'x.md')), [])
  // 文件本身就是根级
  assert.deepEqual(ancestorDirsUnderWorkspace(ws, join(ws, 'f.md')), [ws])
})

test('TC-INS-009 ★ collectNestedInstructions：根排除 + 嵌套命中 + 已注入去重', () => {
  const ws = mkDir('arkwork-ins-ws')
  const sub = join(ws, 'src')
  mkdirSync(sub, { recursive: true })
  writeFileSync(join(ws, 'AGENTS.md'), 'root-rule')
  writeFileSync(join(sub, 'AGENTS.md'), 'sub-rule')
  const sub2 = join(ws, 'lib')
  mkdirSync(sub2, { recursive: true })
  writeFileSync(join(sub2, 'AGENTS.md'), 'lib-rule')

  // 第一次：触达 src/a.ts → 命中 src（根 ws 被排除）
  const first = collectNestedInstructions(ws, [join(sub, 'a.ts')], new Set())
  assert.match(first.text, /sub-rule/)
  assert.ok(!first.text.includes('root-rule'), '根文件已在 system 段，不得重复注入')
  assert.deepEqual(first.dirs, [sub])
  // 第二次：同 run 已注入 src → 只剩 lib
  const second = collectNestedInstructions(ws, [join(sub, 'b.ts'), join(sub2, 'c.ts')], new Set(first.dirs))
  assert.match(second.text, /lib-rule/)
  assert.ok(!second.text.includes('sub-rule'), '已注入目录必须去重')
  // 全部注入过 → 空
  const third = collectNestedInstructions(ws, [join(sub, 'd.ts')], new Set([...first.dirs, ...second.dirs]))
  assert.equal(third.text, '')
})

test('TC-INS-010 collectNestedInstructions：无指令文件的目录也被记为已处理（防反复探测）', () => {
  const ws = mkDir('arkwork-ins-ws')
  const empty = join(ws, 'docs')
  mkdirSync(empty, { recursive: true })
  const r = collectNestedInstructions(ws, [join(empty, 'a.md')], new Set())
  assert.equal(r.text, '')
  assert.deepEqual(r.dirs, [empty], '无文件目录也进 dirs（调用方记账后不再探测）')
})

test('TC-INS-011 collectNestedInstructions：嵌套链 root→叶 + 单轮预算截断', () => {
  const ws = mkDir('arkwork-ins-ws')
  const mid = join(ws, 'a')
  const leaf = join(mid, 'b')
  mkdirSync(leaf, { recursive: true })
  writeFileSync(join(mid, 'AGENTS.md'), 'M'.repeat(5 * 1024))
  writeFileSync(join(leaf, 'AGENTS.md'), 'L'.repeat(5 * 1024))
  const r = collectNestedInstructions(ws, [join(leaf, 'f.ts')], new Set())
  // mid 5KB 消费后剩 3KB < 5KB → leaf 截断收下（预算 8KiB 总量守恒）
  assert.match(r.text, /### a（AGENTS\.md）/, 'root→叶：浅层在前')
  assert.match(r.text, /已截断/, 'leaf 超剩余预算 → 截断标注')
  assert.equal(r.dirs.length, 2, '两个链目录都记账（防下轮重复探测）')
})

/* ---------- 4. 渲染 ---------- */

test('TC-INS-012 渲染：空 → 空串；有源 → Codex 兼容标题 + 层级标签 + 优先级契约行', async () => {
  assert.equal(renderInstructionSourcesBlock({ sources: [], mergedBytes: 0, budgetExhausted: false }), '')
  await withHome(async (home) => {
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(join(home, '.codex', 'AGENTS.md'), 'codex-rule')
    const ws = mkDir('arkwork-ins-ws')
    writeFileSync(join(ws, 'AGENTS.md'), 'proj-rule')
    const d = discoverInstructionSources(ws)
    const block = renderInstructionSourcesBlock(d)
    assert.match(block, /## 项目与全局指令（AGENTS\.md · Codex 兼容）/)
    assert.match(block, /全局（Codex/)
    assert.match(block, /项目级（AGENTS\.md）/)
    assert.match(block, /codex-rule/)
    assert.match(block, /proj-rule/)
    assert.match(block, /优先级：用户的当前消息 > 上述指令文件 > memory\.md/)
    // 注入顺序 = 渲染顺序：全局在前、项目在后（越具体越后）
    assert.ok(block.indexOf('codex-rule') < block.indexOf('proj-rule'))
  })
})

/* ---------- 5. 接线契约（源码守卫，剥注释） ---------- */

const R = (rel: string): string => stripComments(readFileSync(new URL(rel, import.meta.url), 'utf-8'))

test('TC-INS-013 ★ loop 接线：collectNestedInstructions 在 actResults 之后调用且追加不覆盖 pendingSystemHint', () => {
  const s = R('../engine/loop.ts')
  assert.match(s, /import \{ collectNestedInstructions \} from '\.\.\/instruction-sources\.js'/, '必须 import 发现器')
  const iImport = s.indexOf('collectNestedInstructions } from')
  const iAct = s.indexOf('for (const r of actResults)')
  const iCall = s.indexOf('collectNestedInstructions(getWorkspaceDir()')
  assert.ok(iAct > 0 && iCall > iAct, '嵌套注入必须在 actResults 收集之后（本轮触达 → 下一轮注入）')
  assert.ok(iImport > 0)
  // 追加语义（与 replanHint 同型）：已有 hint 时 \n\n---\n 拼接，不覆盖
  assert.match(s, /pendingSystemHint \? `\$\{pendingSystemHint\}\\n\\n---\\n\$\{block\}` : block/)
  // per-run 去重集合存在且被写入
  assert.match(s, /nestedInjectedDirs = new Set<string>\(\)/)
  assert.match(s, /nestedInjectedDirs\.add\(d\)/)
})

test('TC-INS-014 IPC + preload 接线：settings:instruction-sources 三处齐全（handler/preload/类型）', () => {
  const ipc = R('../../ipc/settings.ts')
  assert.match(ipc, /ipcMain\.handle\('settings:instruction-sources'/)
  assert.match(ipc, /discoverInstructionSources\(workspaceDir\)/, 'IPC 必须复用引擎同一发现函数（单一事实源）')
  const preload = R('../../../preload/index.ts')
  assert.match(preload, /instructionSources: \(\) => ipcRenderer\.invoke\('settings:instruction-sources'\)/)
  const types = R('../../../shared/types/ipc.ts')
  assert.match(types, /instructionSources: \(\) => Promise<InstructionSourcesReport>/)
  assert.match(types, /export interface InstructionSourcesReport/)
})

test('TC-INS-015 ★ workspace-context 迁移无转发壳残留（D196 教训）：旧导出与旧实现不得回潮', () => {
  const ws = R('../workspace-context.ts')
  assert.ok(!/discoverAgentFiles/.test(ws), '旧发现函数必须整体删除')
  assert.ok(!/renderAgentFilesBlock/.test(ws), '旧渲染函数必须整体删除')
  assert.ok(!/AGENT_FILE_NAMES|MAX_AGENT_FILE_BYTES/.test(ws), '旧常量不得残留')
  assert.match(ws, /from '\.\/instruction-sources\.js'/, '必须委托新单一事实源')
})
