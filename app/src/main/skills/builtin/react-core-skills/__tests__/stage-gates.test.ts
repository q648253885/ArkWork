/* ============================================================
 * v0.16.x — react-core-skills 阶段门禁识别单测
 *
 * 覆盖：
 *   1. matchStageGate 命中 5 个阶段产物文件
 *   2. 多文件同时匹配时取最高 stageIndex
 *   3. 不在白名单的路径不命中
 *   4. isCoreSkillsEnabled 启用判定
 *   5. engine.ts 集成 — 在 act 循环后插入门禁分支
 *
 *  运行（cwd=app）：
 *    npx tsx --test src/main/skills/builtin/react-core-skills/__tests__/stage-gates.test.ts
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  matchStageGate,
  isCoreSkillsEnabled,
  STAGE_GATES,
  computeAllowedStage,
  matchForbiddenWritePath,
  matchForbiddenShellCommand,
} from '../stage-gates.js'
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

test('matchStageGate: 命中 5 个阶段产物路径', () => {
  assert.equal(matchStageGate('00-opensource-research.md')?.stage, 'research')
  assert.equal(matchStageGate('01-prd.md')?.stage, 'prd')
  assert.equal(matchStageGate('02-interaction.md')?.stage, 'interaction')
  assert.equal(matchStageGate('prototype/index.html')?.stage, 'prototype')
  assert.equal(matchStageGate('prototype/mobile/index.html')?.stage, 'prototype')
  assert.equal(matchStageGate('03-system-design.md')?.stage, 'system-design')
})

test('matchStageGate: docs/v1.0/... 前缀也命中', () => {
  assert.equal(matchStageGate('docs/v1.0/01-prd.md')?.stage, 'prd')
  assert.equal(matchStageGate('docs/v1.0/prototype/index.html')?.stage, 'prototype')
})

test('matchStageGate: 不在白名单返回 undefined', () => {
  assert.equal(matchStageGate('README.md'), undefined)
  assert.equal(matchStageGate('src/main.tsx'), undefined)
  assert.equal(matchStageGate('package.json'), undefined)
  assert.equal(matchStageGate('docs/04-test-report.md'), undefined)
})

test('matchStageGate: PRD 命中 stageIndex=1（与 ProgressPanel stages 对齐）', () => {
  const gate = matchStageGate('01-prd.md')
  assert.ok(gate)
  assert.equal(gate.stageIndex, 1)
  assert.equal(gate.milestoneId, 'prd-frozen')
})

test('matchStageGate: 每个 gate 必须带 2~4 个 suggestions', () => {
  for (const g of STAGE_GATES) {
    assert.ok(
      g.suggestions.length >= 2 && g.suggestions.length <= 4,
      `${g.stage} suggestions 数量 ${g.suggestions.length} 不在 2~4 范围内`,
    )
    // 推荐项至多 1 个
    const recCount = g.suggestions.filter((s) => s.recommended).length
    assert.ok(
      recCount <= 1,
      `${g.stage} 有 ${recCount} 个推荐项，应 ≤ 1`,
    )
    // 每个 label 必须非空
    for (const s of g.suggestions) {
      assert.ok(s.label.length > 0, `${g.stage} suggestion label 空`)
    }
  }
})

test('isCoreSkillsEnabled: 任务/Agent 含 react-core-skills 时返回 true', () => {
  assert.equal(isCoreSkillsEnabled({ skillIds: ['react-core-skills'] }, undefined), true)
  assert.equal(
    isCoreSkillsEnabled({ skillIds: ['react-core-skills', 'web-search'] }, undefined),
    true,
  )
  // 命名变体（来自不同版本）
  assert.equal(
    isCoreSkillsEnabled({ skillIds: ['S-core.react-core-skills'] }, undefined),
    true,
  )
  // Agent 默认技能
  assert.equal(
    isCoreSkillsEnabled(undefined, { defaultSkillIds: ['react-core-skills'] }),
    true,
  )
  // 都没有
  assert.equal(isCoreSkillsEnabled({ skillIds: ['web-search'] }, { defaultSkillIds: ['shell'] }), false)
  assert.equal(isCoreSkillsEnabled(undefined, undefined), false)
})

test('engine.ts: 在 act 循环后插入 stage-gates 分支', () => {
  // 静态断言：保证本次修改不会被后续重构意外移除
  // v0.27.0 R2：stage-gates 集成断言仍锚定在主循环 loop.ts
  const enginePath = fileURLToPath(new URL('../../../../agent/engine/loop.ts', import.meta.url))
  const engineSrc = readFileSync(enginePath, 'utf-8')
  // 必须 import stage-gates 模块
  assert.match(engineSrc, /from\s+['"`].*stage-gates\.js['"`]/)
  // 必须有 stageGateHit 状态变量
  assert.match(engineSrc, /let\s+stageGateHit/)
  // 必须有 if (stageGateHit) 分支触发暂停 + ask_user
  assert.match(engineSrc, /if\s*\(\s*stageGateHit\s*\)/)
  // 门禁分支内必须推 task_progress + emit ask_user + status paused
  assert.match(engineSrc, /stageGateHit[\s\S]*?type:\s*'task_progress'/)
  assert.match(engineSrc, /stageGateHit[\s\S]*?type:\s*'ask_user'/)
  assert.match(engineSrc, /stageGateHit[\s\S]*?status:\s*'paused'[\s\S]*?return/)
  // 必须有匹配 file-writer 产出路径的逻辑
  assert.match(engineSrc, /a\.tool\s*===\s*'file-writer'[\s\S]{0,300}matchStageGate/)
})

test('stage-gates.ts: 5 个阶段按 stageIndex 升序排列', () => {
  for (let i = 0; i < STAGE_GATES.length - 1; i++) {
    assert.ok(
      STAGE_GATES[i].stageIndex < STAGE_GATES[i + 1].stageIndex,
      `${STAGE_GATES[i].stage}(${STAGE_GATES[i].stageIndex}) 应 < ${STAGE_GATES[i + 1].stage}(${STAGE_GATES[i + 1].stageIndex})`,
    )
  }
})

/* ============================================================
 * v0.17.x — 阶段感知写入守卫单测
 * ============================================================ */

test('matchForbiddenWritePath: 文档阶段禁止写脚手架/源码', () => {
  // 调研阶段（allowedStage=0）写 package.json / src 入口 / index.html 应被拦
  assert.equal(matchForbiddenWritePath('package.json', 0).blocked, true)
  assert.equal(matchForbiddenWritePath('src/index.tsx', 0).blocked, true)
  assert.equal(matchForbiddenWritePath('index.html', 0).blocked, true)
  assert.equal(matchForbiddenWritePath('vite.config.ts', 0).blocked, true)
  assert.equal(matchForbiddenWritePath('src/App.test.tsx', 3).blocked, true)
})

test('matchForbiddenWritePath: 进入编码阶段后放行脚手架', () => {
  assert.equal(matchForbiddenWritePath('package.json', 5).blocked, false)
  assert.equal(matchForbiddenWritePath('src/index.tsx', 5).blocked, false)
  assert.equal(matchForbiddenWritePath('index.html', 5).blocked, false)
})

test('matchForbiddenWritePath: 保留路径任何阶段都禁止', () => {
  for (const stage of [0, 3, 5]) {
    assert.equal(matchForbiddenWritePath('tasks.json', stage).blocked, true)
    assert.equal(matchForbiddenWritePath('.arkwork/memory/l1.jsonl', stage).blocked, true)
    assert.equal(matchForbiddenWritePath('.git/config', stage).blocked, true)
  }
})

test('matchForbiddenWritePath: docs/ 产物区（含原型 index.html）放行', () => {
  // 阶段二·五必须产出 docs/v1.0/prototype/index.html，不能被脚手架规则误伤
  assert.equal(matchForbiddenWritePath('docs/v1.0/prototype/index.html', 3).blocked, false)
  assert.equal(matchForbiddenWritePath('docs/v1.0/prototype/index.html', 4).blocked, false)
  assert.equal(matchForbiddenWritePath('docs/v1.0/00-opensource-research.md', 0).blocked, false)
  assert.equal(matchForbiddenWritePath('docs/v1.0/03-system-design.md', 4).blocked, false)
})

test('matchForbiddenShellCommand: 文档阶段禁止脚手架初始化命令', () => {
  assert.equal(matchForbiddenShellCommand('npm create vite@latest .', 0).blocked, true)
  assert.equal(matchForbiddenShellCommand('npx create-react-app myapp', 1).blocked, true)
  assert.equal(matchForbiddenShellCommand('git clone https://github.com/x/y.git', 0).blocked, true)
  assert.equal(matchForbiddenShellCommand('mkdir -p src', 2).blocked, true)
  // 进入编码阶段放行
  assert.equal(matchForbiddenShellCommand('npm create vite@latest .', 5).blocked, false)
})

test('matchForbiddenShellCommand: 保留路径 / docs 产物放行', () => {
  assert.equal(matchForbiddenShellCommand('echo "{}" > tasks.json', 5).blocked, true)
  assert.equal(matchForbiddenShellCommand('mkdir -p docs/v1.0/prototype', 3).blocked, false)
  assert.equal(matchForbiddenShellCommand('ls -la', 0).blocked, false)
})

test('computeAllowedStage: 依据已产出文档推导阶段边界', () => {
  const ws = mkdtempSync(join(tmpdir(), 'arkwork-gate-'))
  try {
    assert.equal(computeAllowedStage(ws), 0) // 无 docs 目录 → 调研
    const docs = join(ws, 'docs', 'v1.0')
    mkdirSync(docs, { recursive: true })
    writeFileSync(join(docs, '00-opensource-research.md'), 'x')
    assert.equal(computeAllowedStage(ws), 1) // 调研完成 → PRD
    writeFileSync(join(docs, '01-prd.md'), 'x')
    assert.equal(computeAllowedStage(ws), 2)
    writeFileSync(join(docs, '02-interaction.md'), 'x')
    assert.equal(computeAllowedStage(ws), 3)
    mkdirSync(join(docs, 'prototype'), { recursive: true })
    writeFileSync(join(docs, 'prototype', 'index.html'), 'x')
    assert.equal(computeAllowedStage(ws), 4) // 原型完成 → 系统设计
    writeFileSync(join(docs, '03-system-design.md'), 'x')
    assert.equal(computeAllowedStage(ws), 5) // 系统设计冻结 → 编码
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})
