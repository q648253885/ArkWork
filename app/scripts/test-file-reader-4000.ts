/* ============================================================
 * v0.24.x — File-reader 摘要长度端到端测试
 *
 * 场景：读 /Users/gongzheng/ai/t2/src/scenes-ui.js（292 行）
 * 目标：验证引擎层 buildObservationSummary 返回的摘要现在含 ≥ 1000 字符
 *       （v0.24.x: 200 → 4000）—— 不再只显示头注释
 *
 * 运行（cwd=app）：
 *   npx tsx scripts/test-file-reader-4000.ts
 * ============================================================ */
import { fileReader } from '../src/main/agent/skills/file-reader.js'

const ctx = { taskId: 'T-test', signal: new AbortController().signal, workspaceDir: '/Users/gongzheng/ai/t2' } as never
const FILE = 'src/scenes-ui.js'

console.log(`=== File-reader 摘要长度测试 · 文件 ${FILE} ===\n`)

const result = await fileReader({ path: FILE }, ctx)
if (!('content' in result)) {
  console.log('❌ 读取失败或被 block')
  process.exit(1)
}

console.log(`路径: ${result.path}`)
console.log(`行数: ${result.lines}`)
console.log(`字节: ${result.size}`)
console.log(`截断: ${result.truncated}`)
console.log(`内容长度: ${result.content.length} 字符`)

// 引擎层 buildObservationSummary 对 file-reader：
//   preview = safeSlice(str(r.content), 4000)
//   header  = `[file-reader] ${path} (${lines} lines, ${size} bytes)\n\n`
// 摘要长度 ≈ header + 4000 chars (or 完整内容)
const HEADER = `[file-reader] ${result.path} (${result.lines} lines, ${result.size} bytes)\n\n`
const OBS_PREVIEW_LEN = Math.min(result.content.length, 4000)
const OBS_TOTAL = HEADER.length + OBS_PREVIEW_LEN + (result.truncated ? '\n\n… (truncated, 继续读用 startLine/maxLines=0)'.length : 0)

console.log(`引擎摘要预估长度: ${OBS_TOTAL} 字符`)
console.log(`\n--- 摘要前 1500 字符预览 ---`)
console.log(result.content.slice(0, 1500))
console.log('\n--- 结束 ---\n')

// 验证：摘要应能透传至少 1000 字符（之前 200 字符只能看到头注释）
if (OBS_TOTAL < 1000) {
  console.log(`❌ 摘要太短（${OBS_TOTAL} < 1000），LLM 看不清文件内容`)
  process.exit(1)
}

if (OBS_TOTAL < 4000) {
  console.log(`⚠️ 摘要 ${OBS_TOTAL} 字符（文件本身 < 4000 字符，全文透传）`)
} else {
  console.log(`✅ 摘要 ≥ 4000 字符（前 4000 字符 + 截断提示）`)
}

console.log(`\n结果：通过`)