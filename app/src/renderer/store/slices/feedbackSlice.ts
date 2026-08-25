/* ============================================================
 * ArkWork — 反馈 slice（v0.27.0 R3：自 store.ts 纯移动）
 * Toast / 确认弹窗 / 工具确认请求 / 上下文 chip
 * ============================================================ */
import type { StateCreator } from 'zustand'
import i18n from '../../i18n'
import { ark } from '../../ipc/client'
import type { ToolConfirmRequest } from '@shared/types/ipc'
import type { AppState, ToastLevel } from '../types'

export const feedbackSlice: StateCreator<
  AppState,
  [],
  [],
  Pick<
    AppState,
    | 'toasts'
    | 'pushToast'
    | 'dismissToast'
    | 'confirmDialog'
    | 'confirm'
    | 'pendingConfirm'
    | 'respondConfirm'
    | 'ctxChips'
    | 'pushCtxChip'
  >
> = (set, get) => ({
  toasts: [],
  confirmDialog: {
    open: false,
    title: '',
    body: '',
    confirmLabel: i18n.t('slice.feedback.confirm'),
    cancelLabel: i18n.t('slice.feedback.cancel'),
    danger: false,
    focusCancel: false,
    onConfirm: () => {},
  },
  // v0.8.1：工具执行确认请求（Main 推送，ToolConfirmLayer 展示）
  pendingConfirm: null as ToolConfirmRequest | null,
  ctxChips: [],

  /**
   * 推送 Toast 通知（B2）。
   * @param t - Toast 内容（不含 id，由本方法生成）
   * @returns 生成的 toast id
   * 行为：
   *   - level='silent'：不渲染 UI，仅同步写一行 INFO 日志（用于工具预算等系统噪音）
   *   - level='info'（默认）：推入队列（上限 5 条），duration>0 时 setTimeout 自动移除
   *   - level='critical'：同 info，但 ToastLayer 用作「真正需用户处理」的提示
   */
  pushToast: (t) => {
    const level: ToastLevel = t.level ?? 'info'
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    if (level === 'silent') {
      // Phase A Task 4：silent 路由——不弹 UI，仅记日志
      console.info(`[toast/silent] ${t.message}`)
      return id
    }
    set((s) => ({
      toasts: [...s.toasts.slice(-4), { ...t, level, id }],  // 上限 5 条
    }))
    if (t.duration > 0) {
      setTimeout(() => get().dismissToast(id), t.duration)
    }
    return id
  },

  /**
   * 移除指定 Toast（B2）。
   * @param id - Toast id
   */
  dismissToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  /**
   * 异步确认对话框（B6），替代 window.confirm。
   * @param opts - 对话框选项（标题/正文/按钮文案/danger）
   * @returns Promise<boolean> — true=确认, false=取消
   * 实现：设置 confirmDialog 状态，返回 Promise，resolve 在 onConfirm 回调内。
   */
  confirm: (opts) => {
    return new Promise<boolean>((resolve) => {
      set({
        confirmDialog: {
          open: true,
          title: opts.title,
          body: opts.body,
          confirmLabel: opts.confirmLabel ?? i18n.t('slice.feedback.confirm'),
          cancelLabel: opts.cancelLabel ?? i18n.t('slice.feedback.cancel'),
          danger: opts.danger ?? false,
          focusCancel: opts.focusCancel ?? false,
          onConfirm: () => {
            set((s) => ({ confirmDialog: { ...s.confirmDialog, open: false } }))
            resolve(true)
          },
        },
      })
    })
  },

  /**
   * v0.8.1：回传工具执行确认结果（ToolConfirmLayer 调用）。
   * @param requestId - 来自 ToolConfirmRequest
   * @param allowed - true=允许执行
   * @param session - true=本次会话内不再询问同一条命令
   * @param reason - v0.14.0 Task 6：'denied'=显式拒绝；'dismissed'=Esc/点背景关闭（不算用户拒绝）
   */
  respondConfirm: (requestId, allowed, session, reason) => {
    void ark.confirm.respond(requestId, allowed, session, reason)
    set({ pendingConfirm: null })
  },

  /**
   * 推入上下文变更 chip（B4）— 对话流内可见的上下文操作痕迹。
   * @param chip - chip 内容（不含 id/ts）
   * 行为：推入队列（上限 3 条），3s 后自动移除（compress 变体 5s）。
   */
  pushCtxChip: (chip) => {
    const id = `chip-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const ts = Date.now()
    set((s) => ({
      ctxChips: [...s.ctxChips.slice(-2), { ...chip, id, ts }],  // 上限 3 条
    }))
    const ttl = chip.variant === 'compress' ? 5000 : 3000
    setTimeout(() => {
      set((s) => ({ ctxChips: s.ctxChips.filter((c) => c.id !== id) }))
    }, ttl)
  },

  /**
   * v0.9.1：接受蒸馏建议（写入 L3 策展/技能/画像观察）。
   * 落库成功后清卡 + 刷新 L3 pending 与记忆面板。
   * v0.14.0 Task 10：蒸馏改为全自动（distill-completed 事件），本建议卡链路已移除。
   */
});
