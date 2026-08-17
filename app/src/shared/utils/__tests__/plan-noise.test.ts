/* ============================================================
 * v0.19.1 — isNoisePlanItem 噪声过滤单测
 *
 * 背景：清单（PlanItems）曾出现与真实执行严重脱节的情况，根因之一是
 * LLM 复述历史清单状态 / 输出残句 / 纯名词碎片，被当作计划项落库。
 * isNoisePlanItem 负责把这些「噪声项」在解析阶段过滤掉。
 *
 * 运行（cwd=app）：./node_modules/.bin/tsx --test src/shared/utils/__tests__/plan-noise.test.ts
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isNoisePlanItem } from '../plan-noise.js'

/* ---------- 1. 用户 v0.19.0 反馈的真实噪声样本 → 应全部丢弃 ---------- */

test('isNoisePlanItem: 纯名词碎片「等待」→ 噪声', () => {
  assert.equal(isNoisePlanItem('等待'), true)
})

test('isNoisePlanItem: 纯名词碎片「碰撞模型基础参数」→ 噪声', () => {
  assert.equal(isNoisePlanItem('碰撞模型基础参数'), true)
})

test('isNoisePlanItem: 顿号结尾残句「编写赛车类:加速度、转向、漂移、」→ 噪声', () => {
  assert.equal(isNoisePlanItem('编写赛车类:加速度、转向、漂移、'), true)
})

test('isNoisePlanItem: 清单状态自报（已更新清单/当前清单）→ 噪声', () => {
  const echo =
    '已更新清单第2项为「done」:设计简稿完成:核心玩法(漂移/氮气/碰撞/结算)、4 张霓虹夜赛风格赛道、' +
    '解锁要素(赛车/涂装/赛道/氮气等级+localStorage 存档)、UI 结构。下一步:搭建Vite+TS+PixiJS 项目骨架。' +
    '当前清单:[x]1.调研主流浏览器2D/3D游戏技术栈[x]2.撰写游戏设计简稿[~]3.搭建项目骨架'
  assert.equal(isNoisePlanItem(echo), true)
})

test('isNoisePlanItem: 带 [x]/[~] 状态标记的历史清单投影 → 噪声', () => {
  assert.equal(isNoisePlanItem('[x] 撰写游戏设计简稿'), true)
  assert.equal(isNoisePlanItem('[~] 搭建项目骨架'), true)
})

/* ---------- 2. 合法动作句 → 应保留 ---------- */

test('isNoisePlanItem: 合法中文动作句 → 非噪声', () => {
  assert.equal(isNoisePlanItem('撰写游戏设计简稿'), false)
  assert.equal(isNoisePlanItem('搭建项目骨架'), false)
  assert.equal(isNoisePlanItem('实现可调参的物理循环'), false)
  assert.equal(isNoisePlanItem('编写赛车类:加速度、转向、漂移、碰撞模型基础参数'), false)
  assert.equal(isNoisePlanItem('调研主流浏览器 2D/3D 游戏技术栈'), false)
})

test('isNoisePlanItem: 合法英文动作句 → 非噪声', () => {
  assert.equal(isNoisePlanItem('Implement authentication flow'), false)
  assert.equal(isNoisePlanItem('Fix token validation in session.ts'), false)
  assert.equal(isNoisePlanItem('Run typecheck and lint'), false)
  assert.equal(isNoisePlanItem('Refactor the rendering loop'), false)
})

/* ---------- 3. 边界 ---------- */

test('isNoisePlanItem: 空 / 纯空白 → 噪声', () => {
  assert.equal(isNoisePlanItem(''), true)
  assert.equal(isNoisePlanItem('   '), true)
})

test('isNoisePlanItem: 英文纯名词短语（无动作动词）→ 噪声', () => {
  assert.equal(isNoisePlanItem('collision model base parameters'), true)
})
