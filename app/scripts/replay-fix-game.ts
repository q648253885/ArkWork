/* ============================================================
 * v0.24.0 防打转实测：在 t2 工作区重跑「修复 game」
 *
 * 忠实复刻 engine ReAct 循环（消息组装 / 观察文本 / 工具调用），
 * 复用真实 skill（file-reader/grep-search/glob-search/file-editor/file-writer
 * —— 防打转就内置在它们内部）+ MiniMax-M3 真实端点。
 * 与 T-20260817-106u4s（105 轮 / 132 工具 / 1.56M tokens 未完成）对比。
 *
 * 运行（cwd=app）：
 *   npx tsx --experimental-loader ./src/main/store/__tests__/electron-mock-loader.mjs scripts/replay-fix-game.ts
 * ============================================================ */
import { execSync } from 'node:child_process'
import { AnthropicAdapter } from '../src/main/llm/anthropic.js'
import type { LlmMessage, LlmTool } from '../src/main/llm/adapter.js'
import type { ReActAction } from '../src/shared/types/react.js'
import { fileReader } from '../src/main/agent/skills/file-reader.js'
import { grepSearch } from '../src/main/agent/skills/grep-search.js'
import { globSearch } from '../src/main/agent/skills/glob-search.js'
import { fileEditor } from '../src/main/agent/skills/file-editor.js'
import { fileWriter } from '../src/main/agent/skills/file-writer.js'

/* ---------- 配置 ---------- */
// v0.24.2：默认指向 /Users/gongzheng/ai/ArkWork/test-t2（sandbox 写白名单内）。
// /Users/gongzheng/ai/t2 与 /t2-rw 在 macOS 沙箱下 src/scenes-ui.js 被 EPERM，
// agent 已诊断正确但环境不允许写入；用白名单内镜像验证 round-trip。
const WORKSPACE = process.env.REPLAY_WORKSPACE ?? '/Users/gongzheng/ai/ArkWork/test-t2'
const GOAL = '检查网页游戏为什么点击选关没有反应，修复问题。选关入口：主菜单的「选择关卡」按钮、选关页的 10 张关卡卡片。修复后运行 node --check 验证语法。'
const MAX_ITER = 40
const MODEL = 'MiniMax-M3'

const adapter = new AnthropicAdapter({
  apiKey: 'sk-cp-QpfsEie7q1JsErcZI1kaOMPxaL9pdLyVTSU_DVXVWJCmtLJhE6QVtzspUTzT-Il6zDbzDml4SBh177jqITtteM-pRvNPBO0spQ1lclERal-LG4KREoAuS_4',
  defaultModel: MODEL,
  baseURL: 'https://api.minimaxi.com/anthropic',
  name: 'replay-fix-game',
})

/* ---------- 工具（对齐 assembleTools 的核心集）---------- */
const TOOLS: LlmTool[] = [
  { type: 'function', function: { name: 'file-reader', description: '读取工作区内文件内容或列目录。参数：path（相对工作区）', parameters: { type: 'object', properties: { path: { type: 'string' }, maxLines: { type: 'number' }, startLine: { type: 'number' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'grep-search', description: '在工作区文件中正则搜索。参数：pattern、可选 path/glob/caseSensitive/maxResults', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'glob-search', description: '按 glob 模式查找文件。参数：pattern（如 **/*.js）', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'file-editor', description: '搜索替换方式编辑文件（必须精确匹配 oldStr）。参数：path/oldStr/newStr', parameters: { type: 'object', properties: { path: { type: 'string' }, oldStr: { type: 'string' }, newStr: { type: 'string' } }, required: ['path', 'oldStr', 'newStr'] } } },
  { type: 'function', function: { name: 'file-writer', description: '写入/覆盖工作区文件。参数：path/content', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'shell', description: '执行构建/测试/验证命令（禁止文件读写类操作）。参数：command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'task_complete', description: '任务完成时调用，参数：summary', parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } } },
]

const SYSTEM = `你是 ArkWork 编码 Agent，处理软件工程任务。核心原则：工具层级正确、改后必测。

## 工具选择层级（强制）
1. 文件操作必须用专用文件工具，绝对禁止用 shell 做 cat/grep/find/ls/sed/awk/echo 写文件/head/tail 等文件操作：
   - 读文件或目录 → file-reader；写文件 → file-writer；编辑文件 → file-editor；找文件 → glob-search；搜内容 → grep-search
2. shell 仅限：构建、测试、运行程序、语法检查（node --check）。
3. 任务结束 → task_complete（附总结）。

## 禁止模式（DO NOT）
- 禁止在一次迭代中重复调用同一工具同一参数（如连续两次 file-reader 同一文件、grep 同一关键词）。
- 禁止换一个近似关键词反复 grep 同一批文件；小项目只有 6 个源文件，直接读文件即可。
- 禁止只探索不行动：读完 1-2 个文件就该定位并编辑。
- 本工作区源文件都很小（每个 <300 行）：读文件时不要用 maxLines/startLine 分页，一次读完整文件。
- 若观察结果出现「重复读警告」或「已拦截」：立即停止读取该目标，基于已有内容直接编辑或验证。
- 不要反复用 shell 做 wc -l / cat / head 等文件统计，文件信息（行数/大小）已在 file-reader 结果里给出。
- grep 关键词会被归一化：换序/换转义写同一组 alternation（如 "levelSelect|selectLevel|关卡"）也算重复，第二次就警告、第三次拦截。

## 本次任务背景（已诊断线索）
- 「选关没反应」候选根因：
  - 主菜单 mkButton（src/scenes-ui.js line 20）：btn.setInteractive(new Phaser.Geom.Rectangle(0,0,w,h))
    ——Container 内部 bg 在 (0,0)，hitArea 仅覆盖右下象限，左上点不到。
  - 卡片已修：line 161 setInteractive(new Phaser.Geom.Rectangle(-95,-85,190,170))
- 建议：把 mkButton 的 hitArea 改成 setInteractive(new Phaser.Geom.Rectangle(-w/2,-h/2,w,h), ...)
  —— 这样无论调用方传入 (W/2, cy) 还是 (W/2, cy+76) 都能正确命中。
- 改完跑 node --check src/scenes-ui.js 验证语法，再调用 task_complete 汇报。

## 每次调用工具后自检
1. 上次结果已给出关键信息了吗？如果已读过某文件/已搜过某关键词，不要再读/再搜。
2. 若工具返回零命中/失败，是基于已有信息推理下一步，而不是换参数重试同样的事情。

## 编码原则
- 最小改动：只修直接相关代码，不重构范围外代码。
- 改后必测：修改后运行 node --check <file> 验证语法；能用 node 静态验证逻辑更好。

工作区：${WORKSPACE}（Phaser 网页小游戏，源文件在 src/，入口 index.html）。
当前任务：${GOAL}`

/* ---------- shell 文件操作守卫（对齐真实引擎 shell.ts detectShellFileOp + node -e fs 拦截）---------- */
function shellFileOpGuard(command: string): string | null {
  // 1. 首 token 级文件命令（cat/head/tail/wc/grep/find/ls/sed/awk…）
  const stripped = command.replace(/^\s*(?:cd\s+\S+\s*&&\s*|sudo\s+|env\s+)+/i, '').trim()
  const firstSegment = stripped.split(/[|;&]/)[0].trim()
  const base = (firstSegment.split(/\s+/)[0] ?? '').replace(/^.*\//, '').toLowerCase()
  const fileOpHint: Record<string, string> = {
    cat: '读文件请用 file-reader({ path })',
    head: '翻看文件请用 file-reader({ path, maxLines, startLine })',
    tail: '翻看文件请用 file-reader({ path, maxLines, startLine })',
    less: '翻看文件请用 file-reader({ path })',
    more: '翻看文件请用 file-reader({ path })',
    grep: '搜内容请用 grep-search({ path, pattern })',
    egrep: '搜内容请用 grep-search({ path, pattern })',
    fgrep: '搜内容请用 grep-search({ path, pattern })',
    rg: '搜内容请用 grep-search({ path, pattern })',
    find: '找文件请用 glob-search({ pattern })',
    ls: '列目录请用 glob-search({ pattern }) 或 file-reader({ path })',
    tree: '递归列目录请用 glob-search({ pattern })',
    sed: '改文件请用 file-editor / file-writer',
    awk: '处理文件请用 file-reader + file-editor / file-writer',
  }
  if (base === 'wc' && /^wc\s+(?:-[a-z]*l[a-z]*\s+)?\S+/.test(firstSegment)) return '统计文件请直接用 file-reader（结果含 lines 字段）'
  if (fileOpHint[base]) return fileOpHint[base]
  // 2. node -e / node -p 里用 fs 读写文件（第二轮实测 22 次变体读文件的绕过路径）
  if (/node\s+(?:-[ep]\b)/.test(stripped) && /fs\s*\.\s*(?:readFileSync|writeFileSync|readdirSync|statSync|readFile|writeFile)/.test(stripped)) {
    return 'node -e 里读文件请改用 file-reader({ path })（fs 文件操作被拦截）'
  }
  return null
}

/* ---------- ctx：单对象（防打转 WeakMap 按对象隔离，全程复用）---------- */
const ctx = { taskId: 'T-replay', signal: new AbortController().signal, workspaceDir: WORKSPACE } as never

/* ---------- 观察文本（复刻 engine buildObservationSummary 语义 + hint 消费）---------- */
function obsText(tool: string, r: unknown, ok: boolean, errMsg?: string): string {
  const hint = r !== null && typeof r === 'object' && typeof (r as Record<string, unknown>).hint === 'string'
    ? (r as Record<string, unknown>).hint as string
    : ''
  const warn = hint ? `\n\n⚠️ ${hint}` : ''
  if (!ok) return `[${tool}] failed: ${errMsg}${warn}`
  const rec = r as Record<string, unknown>
  const s = (v: unknown, n = 0) => (typeof v === 'string' ? (n ? v.slice(0, n) : v) : '')
  switch (tool) {
    case 'file-reader': {
      const content = s(rec.content)
      return `[file-reader] ${rec.path} (${rec.lines} lines, ${rec.size} bytes)\n\n${content.slice(0, 200)}${rec.truncated ? '\n\n… (truncated)' : ''}${warn}`
    }
    case 'file-editor': return `[file-editor] ${rec.path} (${rec.replacements} replacements)${warn}`
    case 'file-writer': return `[file-writer] ${rec.path} (${rec.bytes} bytes, ${rec.lines} lines${rec.created ? ', 新建' : ''})${warn}`
    case 'grep-search': {
      const matches = Array.isArray(rec.matches) ? rec.matches as Array<{ file: string; line: number; text: string }> : []
      const lines = matches.slice(0, 20).map((m) => `${m.file}:${m.line} ${m.text}`).join('\n')
      return `[grep-search] "${rec.pattern}" · ${rec.total} hits in ${rec.scannedFiles} files\n\n${lines}${matches.length > 20 ? '\n…' : ''}${warn}`
    }
    case 'glob-search': {
      const m = Array.isArray(rec.matches) ? rec.matches as string[] : []
      return `[glob-search] ${rec.pattern} → ${m.length} files\n${m.slice(0, 30).join('\n')}${warn}`
    }
    case 'shell': {
      const out = s(rec.stdout, 800)
      const err = s(rec.stderr, 400)
      return `[shell] \`${s(rec.command, 120)}\` exit=${rec.exitCode}\n\nstdout:\n${out}${err ? `\n\nstderr:\n${err}` : ''}${warn}`
    }
    default: return `[${tool}] ${s(JSON.stringify(rec), 400)}${warn}`
  }
}

/* ---------- 工具执行（真实 skill + 内置 shell）---------- */
async function execute(tool: string, args: Record<string, unknown>): Promise<{ text: string; ok: boolean; blocked: boolean }> {
  try {
    let r: unknown
    switch (tool) {
      case 'file-reader': r = await fileReader({ path: String(args.path), maxLines: args.maxLines as number | undefined, startLine: args.startLine as number | undefined }, ctx); break
      case 'grep-search': r = await grepSearch({ pattern: String(args.pattern), path: args.path as string | undefined, glob: args.glob as string | undefined }, ctx); break
      case 'glob-search': r = await globSearch({ pattern: String(args.pattern) }, ctx); break
      case 'file-editor': r = await fileEditor({ path: String(args.path), oldStr: String(args.oldStr), newStr: String(args.newStr ?? '') }, ctx); break
      case 'file-writer': r = await fileWriter({ path: String(args.path), content: String(args.content ?? '') }, ctx); break
      case 'shell': {
        const command = String(args.command ?? '')
        if (/rm\s+-rf|git\s+reset\s+--hard|:\s*>\s*|mv\s+\/\s|dd\s+/.test(command)) {
          return { text: `[shell] 命令被安全策略拒绝：${command}`, ok: false, blocked: false }
        }
        // 对齐真实引擎：shell 不允许做文件操作，强制走专用文件工具
        const guard = shellFileOpGuard(command)
        if (guard) {
          return { text: `[shell] 文件操作被拦截：\`${command.slice(0, 120)}\`\n\n⚠️ ${guard}`, ok: false, blocked: true }
        }
        try {
          const out = execSync(command, { cwd: WORKSPACE, shell: '/bin/bash', timeout: 20_000, encoding: 'utf-8', maxBuffer: 4 * 1024 * 1024 })
          r = { command, cwd: WORKSPACE, stdout: out, stderr: '', exitCode: 0 }
        } catch (e: unknown) {
          const err = e as { stdout?: string; stderr?: string; status?: number | null }
          r = { command, cwd: WORKSPACE, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? ''), exitCode: err.status ?? -1 }
        }
        break
      }
      default:
        return { text: `Tool not found: ${tool}`, ok: false, blocked: false }
    }
    const failed = r !== null && typeof r === 'object' && typeof (r as Record<string, unknown>).status === 'string' && (r as Record<string, unknown>).status === 'failed'
    const errMsg = failed && typeof (r as Record<string, unknown>).error === 'string' ? (r as Record<string, unknown>).error as string : undefined
    // blocked：file-reader/grep block 走 blocked:true + content 字段；shell 守卫走 hint
    const recR = r as Record<string, unknown> | null
    const blocked = !failed && recR !== null && (
      recR.blocked === true ||
      (typeof recR.hint === 'string' && (recR.hint as string).includes('已拦截'))
    )
    return { text: obsText(tool, r, !failed, errMsg), ok: !failed, blocked }
  } catch (e) {
    return { text: obsText(tool, null, false, e instanceof Error ? e.message : String(e)), ok: false, blocked: false }
  }
}

/* ---------- 主循环（复刻 engine runReActLoop）---------- */
const messages: LlmMessage[] = [{ role: 'user', content: GOAL }]
let callSeq = 0
const stats = {
  iterations: 0, toolCalls: 0, byTool: {} as Record<string, number>,
  tokensIn: 0, tokensOut: 0, cacheHit: 0, cacheMiss: 0,
  blocked: 0, done: false, reason: '',
}

console.log(`=== 重跑「修复 game」 @ ${MODEL} · 工作区 ${WORKSPACE} ===\n`)

for (let iter = 1; iter <= MAX_ITER; iter++) {
  stats.iterations = iter
  // v0.24.1：LLM 调用加 120s 超时（防止单轮挂死整个 runner）
  const res = await Promise.race([
    adapter.complete({ system: SYSTEM, messages, tools: TOOLS, temperature: 0.3, maxTokens: 2048 }),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`LLM 调用超时 120s (iter ${iter})`)), 120_000)),
  ])
  stats.tokensIn += res.tokensIn; stats.tokensOut += res.tokensOut
  if (res.cache) { stats.cacheHit += res.cache.hitTokens; stats.cacheMiss += res.cache.missTokens }

  const actions: ReActAction[] = res.actions ?? (res.action ? [res.action] : [])
  const toolCallIds: string[] = res.toolCallIds ?? []

  // 无动作 → 结束
  if (actions.length === 0) {
    stats.done = true
    stats.reason = `第 ${iter} 轮无工具调用，任务按完成结束`
    const answer = (res.content || '').slice(0, 200)
    console.log(`\n[${iter}] 无工具调用。模型回复：${answer || '(空)'}`)
    break
  }

  // assistant 消息：reason + 全部 toolCalls
  const toolCalls = actions.map((a, i) => ({
    id: toolCallIds[i] ?? `call_${callSeq + i + 1}`,
    type: 'function' as const,
    function: { name: a.tool, arguments: JSON.stringify(a.args) },
  }))
  callSeq += actions.length
  messages.push({
    role: 'assistant',
    content: res.content || null,
    toolCalls,
  })

  // 逐条执行 action → tool observation
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i]
    stats.toolCalls++
    stats.byTool[a.tool] = (stats.byTool[a.tool] ?? 0) + 1
    const r = await execute(a.tool, a.args)
    if (r.blocked) stats.blocked++
    messages.push({ role: 'tool', content: r.text, toolCallId: toolCallIds[i] ?? `call_${callSeq - actions.length + i + 1}`, name: a.tool })

    if (a.tool === 'task_complete') {
      stats.done = true
      stats.reason = `第 ${iter} 轮调用 task_complete`
      console.log(`\n[${iter}] ✅ task_complete：${String(a.args.summary ?? '').slice(0, 300)}`)
      break
    }
  }
  if (stats.done) break

  const rate = stats.tokensIn > 0 ? (stats.cacheHit / stats.tokensIn * 100).toFixed(0) : '-'
  const acts = actions.map((a) => `${a.tool}(${JSON.stringify(a.args).slice(0, 60)})`).join(' | ')
  console.log(`[${iter}] ${acts} · 累计 in=${stats.tokensIn.toLocaleString()} cache=${rate}% 拦截=${stats.blocked}`)
}

if (!stats.done) {
  stats.reason = `达到 ${MAX_ITER} 轮上限未完成`
  console.log(`\n❌ ${stats.reason}`)
}

/* ---------- 汇总 ---------- */
const rate = stats.tokensIn > 0 ? (stats.cacheHit / stats.tokensIn * 100).toFixed(1) : 'n/a'
console.log('\n=== 汇总 ===')
console.log(`迭代: ${stats.iterations} 轮`)
console.log(`工具调用: ${stats.toolCalls} 次`)
console.log(`  明细: ${JSON.stringify(stats.byTool)}`)
console.log(`重复读拦截: ${stats.blocked} 次`)
console.log(`tokens: in=${stats.tokensIn.toLocaleString()} out=${stats.tokensOut.toLocaleString()} 合计=${(stats.tokensIn + stats.tokensOut).toLocaleString()}`)
console.log(`缓存命中率: ${rate}%（hit=${stats.cacheHit.toLocaleString()} miss=${stats.cacheMiss.toLocaleString()}）`)
console.log(`结果: ${stats.done ? '✅ ' + stats.reason : '❌ ' + stats.reason}`)
console.log(`\n对照 106u4s：105 轮 / 132 工具 / in=1,471,876 out=86,478 / 未完成`)
process.exit(0)
