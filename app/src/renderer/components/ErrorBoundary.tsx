/* ============================================================
 * ArkWork — Renderer 顶层错误边界（D19 加固）
 *
 * 背景：renderer 此前**零 ErrorBoundary** —— 任何渲染期未捕获异常
 * （如 D19：lazy 编辑器无 Suspense 边界）都会让 React 卸载整棵树，
 * 用户看到的是整窗白屏、无任何报错线索，主进程日志也无 ERROR。
 *
 * 职责：兜住根级渲染异常，降级为「错误卡 + 重载」；异常详情打 console
 * （开发态可见，生产态 DevTools 可查），**不打扰主进程日志纪律**。
 * 放置位置：main.tsx（App 外层）—— 只兜「树级崩溃」这一层，
 * 细粒度边界（若未来需要）由各面板自行再加。
 * ============================================================ */
import { Component, type ErrorInfo, type ReactNode } from 'react'
import i18next from '../i18n'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export class RootErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[RootErrorBoundary]', error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div
        className="h-screen w-screen flex flex-col items-center justify-center gap-3 bg-bg-base text-text-primary p-8"
        role="alert"
      >
        <div className="text-sm font-medium">{i18next.t('errorBoundary.title')}</div>
        <div className="text-2xs text-text-secondary max-w-[80%] break-all text-center">
          {error.message}
        </div>
        <button
          type="button"
          onClick={() => {
            this.setState({ error: null })
          }}
          className="px-3 py-1 text-xs rounded-md border border-border-default hover:bg-bg-hover transition-colors"
        >
          {i18next.t('errorBoundary.retry')}
        </button>
      </div>
    )
  }
}
