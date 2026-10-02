/* ============================================================
 * ArkWork — 侧栏任务运行标识与新任务实时入列（v0.45.0 · R-H · TC-SIDE）
 *
 * 用户实机反馈：① 正在执行的任务在侧栏没有醒目运行标识；② 自动化定时
 * 触发创建的任务不出现在侧栏（要重启才可见），且同名任务无法区分轮次。
 * 引擎层本就支持多任务并行（per-task AbortController，runner.ts），本组
 * 改动只在展示/订阅层。本套件以源码契约钉住三条链路：
 *  ① 订阅层：onStatusChange 对未知任务**头部插入**（automation / delegate
 *     的任务以 running 事件为第一存活信号，实时入列）；
 *  ② 展示层：任务行 running → 脉冲点（animate-ping 外圈 + 实心点 + 徽标
 *     i18n 键四语言齐备）；
 *  ③ 命名层：automation 触发的任务 title = 名称 + 触发时间（MM-DD HH:mm），
 *     titleSource='user' 保持锁定。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs sidebar-running
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { stripComments } from '@shared/utils/source-guard'

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')
const src = (rel: string): string => stripComments(read(rel))

test('TC-SIDE-001 订阅层：onStatusChange 对未知任务头部插入（自动化/委派任务实时入列）', () => {
  const s = src('../../store/subscriptions.ts')
  // 追加判定：先查再插，未知任务插到列表头
  assert.match(s, /s\.tasks\.some\(\(t\) => t\.id === task\.id\)/, '必须先判定任务是否已在列表')
  assert.match(s, /\[task, \.\.\.s\.tasks\]/, '未知任务必须头部插入（新任务 updatedAt 最新）')
  // 回归护栏：既有 map 原位更新路径仍在（同任务状态刷新不产生重复行）
  assert.match(s, /s\.tasks\.map\(\(t\) => \(t\.id === task\.id \? task : t\)\)/, '已知任务仍走原位替换')
})

test('TC-SIDE-002 展示层：任务行 running → 脉冲点 + 徽标文案', () => {
  const s = src('../Sidebar.tsx')
  assert.match(s, /const isRunning = task\.status === 'running'/, '运行判定以任务级 status 为权威')
  assert.match(s, /animate-pulse/, '脉冲外圈动画（animate-pulse 是守卫 TC-MOTION-004 唯一放行的 Tailwind 动效；连续动效另有 .breathe）')
  assert.match(s, /sidebar\.threadRow\.runningBadge/, '运行徽标走 i18n（不硬编码中文）')
  // 静态路径保留：非 running 任务仍是原来的色点
  assert.match(s, /inline-block w-1\.5 h-1\.5 rounded-full flex-shrink-0/, '非运行任务保持静态色点')
})

test('TC-SIDE-003 i18n：runningBadge 四语言齐备', () => {
  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const raw = read(`../../i18n/locales/${lang}.json`)
    assert.match(raw, /"runningBadge"\s*:/, `${lang}.sidebar.threadRow.runningBadge 缺失`)
  }
})

test('TC-SIDE-004 命名层：automation 任务 title = 名称 + 触发时间（MM-DD HH:mm）', () => {
  const s = src('../../../main/store/automations.ts')
  assert.match(s, /`\$\{automation\.name\} \$\{stamp\}`/, 'title 必须拼接时间戳')
  assert.match(s, /getMonth\(\) \+ 1/, '月/日/时/分机械拼接（padStart 两位）')
  assert.match(s, /titleSource: 'user'/, 'titleSource=user 保持锁定（防 LLM 标题覆盖，v0.31.0 C2 语义不变）')
})
