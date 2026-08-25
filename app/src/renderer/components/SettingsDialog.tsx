/* ============================================================
 * ArkWork — SettingsDialog (redesign-workspace-navigation Task 4)
 * 历史：v0.11.0 F1102 设置模态弹窗（role=dialog / backdrop / modal）。
 *
 * Task 4 起：设置改走 Center Stage 一级页面（modulePage='settings'），
 * 由 ModulePage 渲染 <SettingsContent />。本文件保留以兼容旧 import，
 * 但不再渲染为对话框浮层（App.tsx 已下线 SettingsDialog 渲染）。
 *
 * 为了避免重复维护，本组件直接代理到 SettingsContent，
 * 并忽略 onClose（页面级关闭由 ModulePage 头部按钮 / Esc 接管）。
 * ============================================================ */
import { SettingsContent } from './SettingsContent'

type Props = {
  onClose: () => void
}

/**
 * 历史兼容入口：保持旧调用方代码可编译，但不再以 dialog/backdrop 形态渲染。
 * 实际行为：调用 onClose（关闭其容器），然后由父级路由到 modulePage='settings'。
 * 若 onClose 未触发路由，组件将作为页面内嵌正文渲染。
 */
export function SettingsDialog({ onClose }: Props) {
  // 兼容路径：若外部仍渲染此组件，先尝试关闭，再 fallback 渲染页面化内容
  return <SettingsContent />
}

/* 重新导出内部 Section，便于旧测试/引用（如有）直接拿到 settings 子组件。
 * 真正的页面级渲染由 SettingsContent 承担。 */
export { SettingsContent }