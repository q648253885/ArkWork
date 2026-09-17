import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './i18n'
import App from './App'
import { RootErrorBoundary } from './components/ErrorBoundary'
import './styles/globals.css'

// D19 加固：根级错误边界。此前 renderer 零 ErrorBoundary，任何渲染期异常
// （如 lazy 编辑器缺 Suspense）都会整树卸载 → 白屏无线索。边界放 App 外层，
// 只兜树级崩溃；重试点击会清 error 复位子树（比整页 reload 保留更多内存态）。
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </StrictMode>,
)
