/**
 * v0.27.0 R2 切片后路径层修正：
 * 原 engine.ts 的 `../x` 导入（src/main 层）下移一层后应为 `../../x`；
 * 原 `./x` 导入（agent/ 层）已正确重写为 `../x`，按白名单保留。
 * 同时补 plan.ts 对共享解析器的导入。用后即删。
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'

const DIR = '/Users/gongzheng/ai/ArkWork/app/src/main/agent/engine'
const KEEP = new Set([
  'context-breakdown.js', 'context.js', 'events.js', 'inbox.js', 'llm-call.js',
  'llm-stream.js', 'prompt-assembly.js', 'prompt/gates.js', 'prompt/sections.js',
  'registry.js', 'session-log.js', 'turn-stopping.js',
])

let fixed = 0
for (const f of readdirSync(DIR).filter((n) => n.endsWith('.ts') && n !== 'index.ts')) {
  const p = `${DIR}/${f}`
  const out = readFileSync(p, 'utf8')
    .split('\n')
    .map((l) => {
      const m = l.match(/from '\.\.\/(.+?)'/)
      if (!m || KEEP.has(m[1])) return l
      fixed++
      return l.replace(`from '../`, `from '../../`)
    })
    .join('\n')
  writeFileSync(p, out)
}
console.log(`路径层修正: ${fixed} 处`)

// plan.ts 补共享解析器导入
const pp = `${DIR}/plan.ts`
const s = readFileSync(pp, 'utf8')
if (!s.includes('parsePlanItems')) throw new Error('plan.ts 未引用 parsePlanItems?')
writeFileSync(pp, s.replace(
  "import { safeSlice, emitProgress } from './broadcast.js'",
  "import { parsePlanItems } from './plan-parser.js'\nimport { safeSlice, emitProgress } from './broadcast.js'",
))
console.log('plan.ts 解析器导入已补')
