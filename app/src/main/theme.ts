/* ============================================================
 * ArkWork — ThemeService (v0.4.0)
 * 设计文档 §3.1 / §5.1 / §5.2
 *
 * 职责：
 *   1. 同步 Electron 原生界面主题（文件选择器/对话框/上下文菜单）
 *      —— 通过 nativeTheme.themeSource 控制
 *   2. 监听系统主题变化并广播给渲染层（'system' 模式下联动）
 *
 * 公共方法：
 *   - applyTheme(theme): 设置 nativeTheme.themeSource；'system' 时传 'system'
 *   - getSystemTheme(): 读 nativeTheme.shouldUseDarkColors，返回 'light' | 'dark'
 *   - onSystemChange(cb): 监听 'updated' 事件，返回取消订阅函数
 *
 * 错误场景：无（同步 API，不抛错）
 * ============================================================ */
import { nativeTheme } from 'electron'
import type { ThemeMode, ResolvedTheme } from '@shared/types/ipc'
import { logger } from './system/logger.js'

/**
 * 应用主题到原生界面。
 * - 'light' / 'dark'：强制原生界面进入对应主题
 * - 'system'：跟随操作系统
 */
export function applyTheme(theme: ThemeMode): void {
  // nativeTheme.themeSource 接受 'system' | 'light' | 'dark'
  nativeTheme.themeSource = theme
  logger.info('System', `theme applied: ${theme}`)
}

/**
 * 读取系统当前实际主题（'system' 解析后的结果）。
 * 用于渲染层在 'system' 模式下决定 <html class="dark">。
 */
export function getSystemTheme(): ResolvedTheme {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

/**
 * 订阅系统主题变化。
 * 用户在 OS 设置中切换浅深色时触发，广播给所有渲染窗口。
 *
 * @param cb 回调，参数为系统当前实际主题
 * @returns 取消订阅函数
 */
export function onSystemChange(cb: (systemTheme: ResolvedTheme) => void): () => void {
  const listener = () => {
    const resolved: ResolvedTheme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
    logger.info('System', `native theme changed → ${resolved}`)
    cb(resolved)
  }
  nativeTheme.on('updated', listener)
  return () => {
    nativeTheme.off('updated', listener)
  }
}
