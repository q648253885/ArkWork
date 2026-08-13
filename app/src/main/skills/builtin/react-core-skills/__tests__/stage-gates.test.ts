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
import { matchStageGate, isCoreSkillsEnabled, STAGE_GATES } from '../stage-gates.js'
import { readFileSync } from 'node:fs'
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
  const enginePath = fileURLToPath(new URL('../../../../agent/engine.ts', import.meta.url))
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