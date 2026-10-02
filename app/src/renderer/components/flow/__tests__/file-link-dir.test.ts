/* ============================================================
 * ArkWork — 文件夹路径不可点击（v0.45.0 · D220 · TC-DIRK）
 *
 * 用户实机反馈：交互区里的文件路径链接，如果是**文件夹**，点击本就无法
 * 预览（openDoc → readText 对目录必然失败），不应渲染为可点链接。
 * 本套件钉住：
 *  ① FileLink 契约：dirKind 直传 prop + fs:pathKind 异步探测（模块级缓存）
 *     + 目录态渲染为**非交互** chip（span / 无 open 调用 / 文件夹图标）；
 *  ② 产物卡：已知 kind === 'dir' 直传（跳过探测）；
 *  ③ i18n：flow.pathIsDir 四语言齐备。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs file-link-dir
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { stripComments } from '@shared/utils/source-guard'

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')
const src = (rel: string): string => stripComments(read(rel))

test('TC-DIRK-001 FileLink 契约：dirKind 直传 + pathKind 探测缓存 + 目录态非交互', () => {
  const s = src('../FileLink.tsx')
  // 判定两路
  assert.match(s, /dirKind\?: boolean/, 'dirKind 直传 prop 必须在（调用方已知 kind 时零开销）')
  assert.match(s, /pathKind\(path\)/, '未知 kind 走 fs:pathKind 轻探测')
  assert.match(s, /kindCache\.set\(path/, '模块级缓存（同路径只探测一次）')
  // 目录态 = 非交互：span 承载（不是 button）、不调 open(path)、data-dir-link 供契约断言
  assert.match(s, /data-dir-link="true"/, '目录态标记（契约锚点）')
  const dirBranch = s.slice(s.indexOf('if (isDir)'))
  assert.ok(dirBranch.includes('<span'), '目录态必须是 span（非 button 语义）')
  assert.ok(!/onClick=\{\(\) => open\(path\)\}/.test(dirBranch.split('return (')[1] ?? ''), '目录态不得绑定 open(path)')
  assert.match(s, /flow\.pathIsDir/, '目录态提示走 i18n')
})

test('TC-DIRK-002 产物卡：dir 型产物直传 dirKind（跳过探测）', () => {
  const s = src('../blocks/TaskArtifactCard.tsx')
  assert.match(s, /dirKind=\{e\.kind === 'dir'\}/, '产物卡必须把已知 kind 传给 FileLink')
})

test('TC-DIRK-003 i18n：flow.pathIsDir 四语言齐备', () => {
  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const raw = read(`../../../i18n/locales/${lang}.json`)
    assert.match(raw, /"pathIsDir"\s*:/, `${lang}.flow.pathIsDir 缺失`)
  }
})
