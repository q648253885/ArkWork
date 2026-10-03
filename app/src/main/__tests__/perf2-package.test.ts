/**
 * v0.46.0 — PERF-2 W17 打包瘦身守卫：dependencies 不得回填 renderer 专属包
 *
 * 依据：docs/versions/v0.46.0/04-system-design.md §二 C（W17）
 * 背景：electron-builder 只打包 dependencies 的 node_modules；renderer 专属依赖
 * 已被 Vite 打进 out/renderer，留在 dependencies 里随 asar 双份出货。
 * 本守卫钉住「迁移不回退」——任何人把 react/echarts/@codemirror 等加回
 * dependencies 都会报红（除非它真的成了主进程运行时依赖，那时应同步改本用例）。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs perf2-package
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

interface Pkg {
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
  optionalDependencies?: Record<string, string>
}

const pkg = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf-8'),
) as Pkg

/** v0.46.0 迁移清单：renderer 专属 + 测试专用（tsx），main/preload 零 import（已核实） */
const RENDERER_ONLY = [
  'react',
  'react-dom',
  'react-i18next',
  'i18next',
  'zustand',
  'echarts',
  'tsx',
  '@codemirror/autocomplete',
  '@codemirror/commands',
  '@codemirror/lang-css',
  '@codemirror/lang-html',
  '@codemirror/lang-javascript',
  '@codemirror/lang-json',
  '@codemirror/lang-markdown',
  '@codemirror/lang-python',
  '@codemirror/lang-yaml',
  '@codemirror/language',
  '@codemirror/search',
  '@codemirror/state',
  '@codemirror/view',
  '@lezer/highlight',
]

test('TC-PKG46-001 renderer 专属依赖不得回填 dependencies（asar 双份出货守卫）', () => {
  const backfilled = RENDERER_ONLY.filter((k) => k in pkg.dependencies)
  assert.deepEqual(backfilled, [], `以下包不得出现在 dependencies（应在 devDependencies）: ${backfilled.join(', ')}`)
})

test('TC-PKG46-002 迁移清单已全部落在 devDependencies（防「迁移半途丢失」）', () => {
  const missing = RENDERER_ONLY.filter((k) => !(k in pkg.devDependencies))
  assert.deepEqual(missing, [], `以下包既不在 dependencies 也不在 devDependencies（迁移丢失）: ${missing.join(', ')}`)
})

test('TC-PKG46-003 主进程运行时依赖必须留在 dependencies（防过度迁移）', () => {
  const mustStay = ['@anthropic-ai/sdk', 'adm-zip', 'chokidar', 'mammoth', 'minisearch', 'openai', 'pdf-parse', 'ws']
  const gone = mustStay.filter((k) => !(k in pkg.dependencies))
  assert.deepEqual(gone, [], `以下主进程运行时依赖被误移出 dependencies: ${gone.join(', ')}`)
})
