/* ============================================================
 * ArkWork — Browser Toolbar 入口（v0.26.0 P0 / 浏览器重设计 §2.1）
 *
 * 浮窗（detach 出去的无边框小窗）与 dock 迷你路由共用的独立 Vite entry。
 * 主进程加载：
 *   prod  → pathToFileURL(out/renderer/browser-toolbar.html)
 *   dev   → <ELECTRON_RENDERER_URL>/browser-toolbar.html
 * 路由：?mode=float|dock（缺省 float），渲染对应形态的 BrowserChrome。
 *
 * 纪律：本文件及子组件禁止声明 const ark / let ark（contextBridge 属性不可
 * shadow，会 SyntaxError）；一律 window.ark.* 或解构别名。
 * ============================================================ */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserChrome } from '../components/BrowserChrome'
import '../styles/globals.css'
import '../components/BrowserChrome/BrowserChrome.css'

const params = new URLSearchParams(window.location.search)
const rawMode = params.get('mode')
const mode: 'float' | 'dock' = rawMode === 'dock' ? 'dock' : 'float'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserChrome mode={mode} />
  </StrictMode>,
)
