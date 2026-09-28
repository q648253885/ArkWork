/* ============================================================
 * ArkWork — v0.36.2 缺陷批契约测试（D112 / D113 / D114）
 * 形态：源码正则契约（沿用 b11-workbench-contract 范式，注释剥离防误报）。
 * 规格来源：docs/versions/v0.36.0/14-v0362-fixes-design.md
 * 运行（cwd=app）：node scripts/run-tests.mjs v0362-fixes
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from '@shared/utils/source-guard'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const appRoot = join(ROOT, '../..')

/** 读源码并剥离注释（纪律 #12：唯一真源 `stripComments`，禁止自写） */
function src(rel: string): string {
  return stripComments(readFileSync(join(appRoot, rel), 'utf-8'))
}

const TOOL_BLOCK = 'app/src/renderer/components/flow/blocks/ToolBlock.tsx'
const TOOLS_INDEX = 'app/src/renderer/components/flow/tools/index.tsx'
const GENERIC_CARD = 'app/src/renderer/components/flow/tools/GenericCard.tsx'
const PROFILE_EDITOR = 'app/src/renderer/components/workbench/ProfileEditor.tsx'

/* ---------- D112 工具卡一行化 ---------- */

test('TC-BLOCK-020 一行化：路径去重 + 行内 FileLink（stripPaths 接线契约）', () => {
  const s = src(TOOL_BLOCK)
  assert.match(s, /stripPaths/, 'stripPaths 辅助存在')
  assert.match(s, /looksPath/, '「像路径」守卫存在（防误伤搜索 pattern）')
  assert.match(s, /shortPathOf/, '剥除覆盖展示短路径变体')
  // 行内文件可点击：FileLink 全路径传参（openDoc 唯一门面）
  assert.match(s, /<FileLink\s+key=\{`\$\{loc\.path\}:\$\{i\}`\}\s+path=\{loc\.path\}/, '行内 FileLink')
  // 调用体抑制：generic+locations / write 的 chips 行不再重复渲染
  assert.match(s, /inlineSubject/, 'inlineSubject 判定')
  assert.match(s, /!\s*inlineSubject\s*&&\s*<ToolCallBody/, '抑制重复调用体')
  // 行内结果摘要 + 展开完整结果并存
  assert.match(s, /<ToolResultBody result=\{block\.result\}/, '展开态完整结果')
})

test('TC-BLOCK-021 write 卡 ChangeSummary 上移头行，ResultSummaryLine 退役', () => {
  const s = src(TOOL_BLOCK)
  assert.match(s, /<ChangeSummary changes=\{call\.changes\}/, 'write 卡 ChangeSummary 进头行')
  assert.doesNotMatch(src(GENERIC_CARD), /ResultSummaryLine/, 'ResultSummaryLine 已删除')
  assert.doesNotMatch(src(TOOLS_INDEX), /ResultSummaryLine/, '注册表不再再导出')
})

test('TC-BLOCK-023 stripPaths 防误伤：仅剥「像路径」的串（含分隔符）', () => {
  const s = src(TOOL_BLOCK)
  assert.match(s, /v\.includes\('\/'\) \|\| v\.includes\('\\\\'\)/, '分隔符守卫')
  assert.match(s, /v\.length >= 2/, '长度守卫')
})

/* ---------- D114 工作台克隆 id ---------- */

test('TC-WB-030 克隆 id 为单点「命名空间.名称」格式并与既有台去重', () => {
  const s = src(PROFILE_EDITOR)
  // 旧写法（两点 id）必须消失
  assert.doesNotMatch(s, /\$\{profileId\}\.edited/, '禁止 `${profileId}.edited`（两点必被 V1 拒）')
  // 新写法：名称段追加 -edited；冲突时 -2、-3 … 去重
  assert.match(s, /`\$\{profileId\}-edited`/, '单点克隆 id')
  assert.match(s, /for \(let n = 2; taken\.has\(newId\); n\+\+\)/, '去重循环')
  assert.match(s, /new Set\(profiles\.map\(\(p\) => p\.id\)\)/, '既有 id 集')
})
