/* ============================================================
 * v0.24.0 防重读集成实测：直接调 skill 函数（真实 IO，不 mock）
 * 复刻 T-20260817-106u4s 的打转模式：同文件读 6 次 + 同关键词 grep 4 次
 * 验证：第 4 次起 block（返回体携带行动指令）、编辑后可合法重读、
 *       零命中小工作区列出文件清单
 * （engine 的 withHint 消费逻辑为 3 行纯函数，由 typecheck + 单测覆盖）
 * 运行（cwd=app）：npx tsx scripts/verify-anti-loop.ts
 * ============================================================ */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileReader } from '../src/main/agent/skills/file-reader.js'
import { grepSearch } from '../src/main/agent/skills/grep-search.js'

const ws = mkdtempSync(join(tmpdir(), 'anti-loop-'))
mkdirSync(join(ws, 'src'), { recursive: true })
writeFileSync(join(ws, 'src/game.js'), 'export function onClick() { console.log("click") }\n')
writeFileSync(join(ws, 'src/ui.js'), 'export const button = { setInteractive: true }\n')
writeFileSync(join(ws, 'index.html'), '<html><body></body></html>\n')

const ctx = { taskId: 'verify', workspaceDir: ws } as never

let pass = 0, fail = 0
const check = (name: string, cond: boolean) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}`) }
}

console.log('=== 1. 同文件读 6 次（复刻 106u4s 打转模式）===')
for (let i = 1; i <= 6; i++) {
  const r = await fileReader({ path: 'src/game.js' }, ctx) as { content: string; hint?: string; blocked?: boolean }
  const blocked = !!r.blocked || r.content.includes('已拦截')
  if (i <= 2) check(`第 ${i} 次放行`, !blocked)
  else if (i === 3) check('第 3 次警告（执行 + hint）', !blocked && !!r.hint?.includes('重复读警告'))
  else check(`第 ${i} 次拦截 + 行动指令`, blocked && r.content.includes('禁止继续读取'))
}

console.log('=== 2. 编辑后重读（合法重读不被拦）===')
const { fileEditor } = await import('../src/main/agent/skills/file-editor.js')
await fileEditor({ path: 'src/game.js', oldStr: 'click', newStr: 'tap' }, ctx)
const r2 = await fileReader({ path: 'src/game.js' }, ctx) as { content: string }
check('编辑后重读放行', !r2.content.includes('已拦截'))

console.log('=== 3. 同关键词 grep 4 次 ===')
for (let i = 1; i <= 4; i++) {
  const r = await grepSearch({ pattern: 'setInteractive' }, ctx) as { hint?: string; matches: unknown[] }
  const blocked = r.matches.length === 0 && !!r.hint?.includes('已拦截')
  if (i < 4) check(`grep 第 ${i} 次放行（有命中）`, !blocked && r.matches.length > 0)
  else check('grep 第 4 次拦截', blocked && r.hint!.includes('禁止继续读取'))
}

console.log('=== 4. 零命中小工作区 → 文件清单引导 ===')
const rz = await grepSearch({ pattern: 'definitely_not_exists_xyz' }, ctx) as { hint?: string }
check('零命中列出全部文件', !!rz.hint?.includes('src/game.js') && !!rz.hint?.includes('index.html'))
check('引导直接读文件', !!rz.hint?.includes('file-reader'))

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
