/**
 * v0.36.4 详测 — D120 任务标题：轻量模型旁路 + 终态重试
 *
 * 依据：docs/versions/v0.36.4/16-v0364-windows-compat-design.md §二 D120
 * 用户实测（Windows 10 + qwen3 27B @ 2 vCPU）：任务名永远「未命名任务」。
 *
 * 根因：标题生成走任务模型本身（27B 思考模型，标题调用可达分钟级）+
 * 45s 超时必中 + 失败后无重试 → titleSource 永远为空 → 永远占位标题。
 *
 * 修复面（对齐 OpenCode small_model 模式；**思考保留** —— 用户裁决 Ollama 需要 think）：
 *   - getTitleAdapter：设置 lightweightModelId 且模型启用 → 用它；否则回落任务模型；
 *   - TITLE_TIMEOUT_MS 45s → 120s（轻量模型通常秒级，上限只是兜底）；
 *   - runner.ts .finally 终态重试（titleSource 竞态保护防覆盖）。
 *
 * 手法：源码契约（剥离注释后断言；真执行需 mock registry/存储/Electron，收益低）。
 *
 * 运行（cwd=app）：
 *   ./node_modules/.bin/tsx --experimental-loader ./src/test/electron-mock-loader.mjs \
 *     --test src/main/agent/__tests__/task-title-d120.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { stripComments } from '@shared/utils/source-guard'

// 剥离注释走唯一真源 @shared/utils/source-guard（D101/D102，TC-D102-001 守卫）

const TITLE = stripComments(readFileSync(new URL('../task-title.ts', import.meta.url), 'utf-8'))
const RUNNER = stripComments(readFileSync(new URL('../runner.ts', import.meta.url), 'utf-8'))
const IPC_TYPES = stripComments(readFileSync(new URL('../../../shared/types/ipc.ts', import.meta.url), 'utf-8'))
const SETTINGS_UI = stripComments(readFileSync(new URL('../../../renderer/components/SettingsContent.tsx', import.meta.url), 'utf-8'))

test('TC-D120-001 超时上限 120s（45s 在 27B@2vCPU 上必超时）', () => {
  assert.match(TITLE, /const TITLE_TIMEOUT_MS = 120_000/, 'TITLE_TIMEOUT_MS 应为 120_000')
  assert.doesNotMatch(TITLE, /TITLE_TIMEOUT_MS = 45_000/, '不得残留 45s 旧值')
})

test('TC-D120-002 轻量模型旁路：lightweightModelId 优先且校验 enabled，异常静默回落', () => {
  assert.match(TITLE, /async function getTitleAdapter\(/, 'getTitleAdapter 应存在')
  assert.match(
    TITLE,
    /await getTitleAdapter\(task\.modelId\)/,
    'maybeGenerateTaskTitle 应经 getTitleAdapter 选 adapter（不再直用任务模型）',
  )
  assert.match(
    TITLE,
    /getSettings\(\)\)\.lightweightModelId\?\.trim\(\)/,
    '应读取设置的 lightweightModelId',
  )
  assert.match(TITLE, /const m = await getModel\(lightId\)\s*if \(m\?\.enabled\)/, '轻量模型必须存在且启用才使用')
  assert.match(TITLE, /return getAdapter\(taskModelId\)/, '未配置/不可用时回落任务模型（行为与旧版一致）')
  assert.match(TITLE, /catch \(err\)[\s\S]{0,120}logger\.debug[\s\S]{0,120}falling back/, '查找异常应静默回落不阻断')
})

test('TC-D120-003 runner.ts 终态重试：.finally 里再次调用标题生成', () => {
  const finallyIdx = RUNNER.indexOf('.finally(() => {')
  assert.ok(finallyIdx >= 0, 'runTask 应有 .finally 收尾块')
  const finallyBlock = RUNNER.slice(finallyIdx, RUNNER.indexOf('})', finallyIdx) + 2)
  assert.match(
    finallyBlock,
    /void maybeGenerateTaskTitle\(taskId\)/,
    '终态收尾应重试标题生成（启动时超时失败的最后机会）',
  )
  // 竞态保护：titleSource 已置位则跳过（不得覆盖用户命名 / 已生成标题）
  assert.match(TITLE, /if \(task\.titleSource\) return/, 'titleSource 已置位应跳过')
  assert.match(TITLE, /if \(!latest \|\| latest\.titleSource\) return/, '写回前应重读任务做竞态保护')
})

test('TC-D120-004 设置面：lightweightModelId 类型声明 + 设置页轻量模型选择器', () => {
  assert.match(
    IPC_TYPES,
    /lightweightModelId\?: string/,
    'AppSettings 应声明 lightweightModelId?: string',
  )
  assert.match(
    IPC_TYPES,
    /perfMode\?: 'auto' \| 'on' \| 'off'/,
    'AppSettings 应声明 perfMode 三态（PERF-1 同版交付）',
  )
  assert.match(
    SETTINGS_UI,
    /patch\(\{ lightweightModelId: e\.target\.value \}\)/,
    '设置页应有轻量模型选择器并写回 lightweightModelId',
  )
  assert.match(SETTINGS_UI, /lightModelNone|lightModelDesc/, '轻量模型区应有空态/说明文案（i18n key）')
})
