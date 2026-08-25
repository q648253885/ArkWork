#!/usr/bin/env node
/* ============================================================
 * ArkWork — 统一测试 runner（v0.27.0 R0）
 *
 * 取代 package.json 里 15 段手工 && 串接：
 *   - 自动发现 src 下所有 __tests__ 目录中的 *.test.ts / *.test.tsx
 *   - 所有套件统一挂 src/test/electron-mock-loader.mjs（单份 electron 桩）
 *   - 陈年红灯套件显式列入 EXCLUSIONS（带原因），逐版清账，不许静默新增
 *   - 支持过滤：node scripts/run-tests.mjs <substring> [more-substrings...]
 * ============================================================ */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const APP_ROOT = pathResolveHere()
function pathResolveHere() {
  // scripts/run-tests.mjs → app/
  return fileURLToPath(new URL('..', import.meta.url))
}

/** 已知红灯/环境不兼容套件（显式欠账清单；修复后请从此处移除） */
const EXCLUSIONS = [
  {
    match: 'e2e-memory-l4-llm.test.ts',
    reason: 'TODO(v0.28): 依赖真实 models.json apiKey + 外网 + deepseek-v4-flash，非密闭套件；单跑见该文件头注释',
  },
]

const LOADER_REL = 'src/test/electron-mock-loader.mjs'

function walk(dir, out) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue
      walk(p, out)
    } else if (/\.test\.(ts|tsx)$/.test(e.name)) {
      out.push(p)
    }
  }
  return out
}

function main() {
  const filters = process.argv.slice(2)
  const all = walk(join(APP_ROOT, 'src'), [])
  const relAll = all.map((p) => relative(APP_ROOT, p).split(sep).join('/')).sort()

  let candidates = relAll
  for (const reason0 of EXCLUSIONS) {
    candidates = candidates.filter((p) => !p.includes(reason0.match))
  }
  if (filters.length > 0) {
    candidates = candidates.filter((p) => filters.some((f) => p.includes(f)))
  }

  if (candidates.length === 0) {
    console.error('[run-tests] 未匹配到任何测试文件（filters=%s）', filters.join(' ') || '<none>')
    process.exit(1)
  }
  console.log(`[run-tests] 共 ${relAll.length} 个测试文件，本轮执行 ${candidates.length} 个（排除 ${EXCLUSIONS.length} 个显式欠账）`)
  for (const ex of EXCLUSIONS) console.log(`  [excluded] ${ex.match} —— ${ex.reason}`)

  const tsxBin = join(APP_ROOT, 'node_modules', '.bin', 'tsx')
  const loaderUrl = pathToFileURL(join(APP_ROOT, LOADER_REL)).href
  const absFiles = candidates.map((p) => join(APP_ROOT, p))

  const res = spawnSync(tsxBin, ['--experimental-loader', loaderUrl, '--test', ...absFiles], {
    cwd: APP_ROOT,
    stdio: 'inherit',
  })

  if (res.error) {
    console.error('[run-tests] 启动失败：%s', res.error.message)
    process.exit(1)
  }
  process.exit(res.status ?? 1)
}

main()
