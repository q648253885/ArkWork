/**
 * v0.27.0 R2 修复二：动态/类型位置 import() 的路径层 + 补兄弟模块导入。用后即删。
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'

const DIR = '/Users/gongzheng/ai/ArkWork/app/src/main/agent/engine'
const KEEP = new Set([
  'context-breakdown.js', 'context.js', 'events.js', 'inbox.js', 'llm-call.js',
  'llm-stream.js', 'prompt-assembly.js', 'prompt/gates.js', 'prompt/sections.js',
  'registry.js', 'session-log.js', 'turn-stopping.js',
])

let n = 0
for (const f of readdirSync(DIR).filter((x) => x.endsWith('.ts'))) {
  const p = `${DIR}/${f}`
  let s = readFileSync(p, 'utf8')
  s = s.replace(/import\('([^']+)'\)/g, (m, path) => {
    if (!path.startsWith('../')) return m
    const rest = path.slice(3)
    if (rest.startsWith('../')) return m // 已两层
    if (KEEP.has(rest)) return m
    n++
    return `import('../../${rest}')`
  })
  if (f === 'dispatch.ts') {
    const a = s.includes("import('./runner.js')")
    if (!a) throw new Error('dispatch runner 锚点丢失')
    s = s.replace("import('./runner.js')", "import('../runner.js')")
    n++
  }
  writeFileSync(p, s)
}
console.log(`import() 路径修正: ${n} 处`)

// ---------- 兄弟模块导入补充 ----------
function insertAfterImports(file, extraLines) {
  const p = `${DIR}/${file}`
  const lines = readFileSync(p, 'utf8').split('\n')
  let last = -1
  lines.forEach((l, i) => {
    if (/^import\b/.test(l) || /^export\s*\{[^}]*\}\s*from\s*'/.test(l)) last = i
  })
  if (last < 0) throw new Error(`${file} 未找到导入区`)
  lines.splice(last + 1, 0, ...extraLines)
  writeFileSync(p, lines.join('\n'))
}

insertAfterImports('act.ts', [
  "import { injectSkillInstruction } from './skills.js'",
  "import { sanitizePlanItemText } from './plan-parser.js'",
  "import { decidePlanAdvance } from './gates.js'",
])
insertAfterImports('context.ts', [
  "import { emitEvent } from './broadcast.js'",
  "import { buildMemoryInjection } from './memory-hooks.js'",
  "import { assembleMessages, assembleTools } from './messages.js'",
])
insertAfterImports('loop.ts', [
  "import type { ActContext, ActExecutionResult } from './act.js'",
  "import { isPhaseHeader } from './plan-parser.js'",
])
insertAfterImports('messages.ts', [
  "import { emitEvent } from './broadcast.js'",
])

const mh = `${DIR}/memory-hooks.ts`
const mhs = readFileSync(mh, 'utf8')
if (!mhs.includes("import { safeSlice, emitProgress } from './broadcast.js'")) throw new Error('memory-hooks 锚点丢失')
writeFileSync(mh, mhs.replace(
  "import { safeSlice, emitProgress } from './broadcast.js'",
  "import { safeSlice, emitEvent, emitProgress } from './broadcast.js'",
))
console.log('兄弟导入补充完成')
