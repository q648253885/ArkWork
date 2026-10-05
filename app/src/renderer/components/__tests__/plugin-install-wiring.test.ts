/* ============================================================
 * ArkWork — 插件 zip 安装两段式握手接线契约（TC-PIW 组 · v0.46.1 / D222）
 * 缺陷：两段式安装的第一段在主进程弹文件框选完包后，needsConfirm 预览
 *   结果不回带 zipPath，确认弹窗点「确认安装」时只传 confirmed/overwrite →
 *   主进程 IPC 层见 zipPath 为空**再弹一次文件选择框**（用户报：
 *   「弹出确认安装后，又一次弹出选择插件」）。
 *
 * 为什么是源码契约：
 *   渲染层无 jsdom / testing-library 基建（同 inspector-menu-contract.test.ts
 *   头注）。本组钉的是「确认段必须把预览段回带的 zipPath 原样传回」这条
 *   跨进程握手 —— 典型「函数与类型全对、只有接线丢字段」（D95/D198 同族），
 *   主进程真执行用例（TC-PI-019）盖不到渲染层这一半，只有源码断言能拦住回潮。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs plugin-install-wiring
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripComments } from '@shared/utils/source-guard'

const PANEL = (): string => stripComments(readFileSync(new URL('../panels/CapabilityPluginsPanel.tsx', import.meta.url), 'utf-8'))

/** 确认段调用形态（confirmed:true 只出现在 onConfirmInstall 一处） */
const CONFIRM_CALL = /installPlugin\(\{[^}]*confirmed:\s*true[^}]*\}\)/

test('TC-PIW-001 ★ D222 接线：确认段 installPlugin 调用必须把预览回带的 zipPath 原样传回', () => {
  const s = PANEL()
  const m = s.match(CONFIRM_CALL)
  assert.ok(m, '确认段必须存在 installPlugin({ … confirmed: true … }) 调用')
  assert.match(
    m[0],
    /zipPath:\s*pendingInstall\?\.zipPath/,
    '确认段必须带 zipPath: pendingInstall?.zipPath（D222 —— 不传则主进程再弹文件选择框）',
  )
})

test('TC-PIW-002 预览段必须把完整结果存入 pendingInstall（zipPath 随之入状态）', () => {
  const s = PANEL()
  // needsConfirm 分支必须 setPendingInstall(res) —— 只挑字段存（如 { manifest: res.manifest }）
  // 会把 zipPath 再次弄丢，握手照样断
  assert.match(s, /setPendingInstall\(res\)/, '预览结果必须整体进 pendingInstall（zipPath 借它流到确认段）')
})
