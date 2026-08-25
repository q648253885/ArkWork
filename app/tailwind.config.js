/** @type {import('tailwindcss').Config} */
export default {
  // v0.4.0：class 模式（<html class="dark">）驱动浅深皮肤切换
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // v0.13.0 — 3 层背景（stone warm gray）
        'bg-base': 'var(--bg-base)',
        'bg-surface': 'var(--bg-surface)',
        'bg-surface-2': 'var(--bg-surface-2)',
        'bg-surface-3': 'var(--bg-surface-3)',
        'bg-overlay': 'var(--bg-overlay)',
        // 语义化半透明叠加
        'bg-hover': 'var(--bg-hover)',
        'bg-active': 'var(--bg-active)',
        // v0.17.0 中性 overlay 阶梯（hover/active/selected）
        'bg-overlay-l1': 'var(--bg-overlay-l1)',
        'bg-overlay-l2': 'var(--bg-overlay-l2)',
        'bg-overlay-l3': 'var(--bg-overlay-l3)',
        'bg-overlay-l4': 'var(--bg-overlay-l4)',
        // 兼容旧名
        'bg-elevated': 'var(--bg-overlay)',
        'bg-input': 'var(--bg-input)',

        // 3 级边框（v0.13）
        'border-subtle': 'var(--border-subtle)',
        'border-default': 'var(--border-default)',
        'border-strong': 'var(--border-strong)',

        // 文字（v0.13 — 保留三级）
        'text-primary': 'var(--text-primary)',
        'text-secondary': 'var(--text-secondary)',
        'text-tertiary': 'var(--text-tertiary)',
        'text-disabled': 'var(--text-disabled)',
        'text-inverse': 'var(--text-inverse)',

        // Accent 6 档（v0.13 靛紫蓝 #4F46E5）
        'accent-50': 'var(--accent-50)',
        'accent-100': 'var(--accent-100)',
        'accent-300': 'var(--accent-300)',
        'accent-500': 'var(--accent-500)',
        accent: 'var(--accent)',
        'accent-600': 'var(--accent-600)',
        'accent-700': 'var(--accent-700)',
        'accent-hover': 'var(--accent-hover)',
        'accent-active': 'var(--accent-active)',
        'accent-soft': 'var(--accent-soft)',
        'accent-strong': 'var(--accent-strong)',
        success: 'var(--success)',
        'success-soft': 'var(--success-soft)',
        warning: 'var(--warning)',
        'warning-soft': 'var(--warning-soft)',
        danger: 'var(--danger)',
        'danger-soft': 'var(--danger-soft)',
        info: 'var(--info)',
        'info-soft': 'var(--info-soft)',
        // v0.17.0 Shell 终端专属
        'shell-bg': 'var(--shell-bg)',
        'shell-fg': 'var(--shell-fg)',
        'shell-stderr': 'var(--shell-stderr)',
        // v0.27.1：锁深终端面板语义色——面板底色恒为深色，其上的文字/边框
        // 必须用本组锁深 token，不能用随主题翻转的 text-*/success/danger 等
        // （否则浅色主题下出现"深底黑字"不可读，缺陷：终端侧边栏浅色黑字）
        'shell-muted': 'var(--shell-muted)',
        'shell-ok': 'var(--shell-ok)',
        'shell-ok-soft': 'var(--shell-ok-soft)',
        'shell-run': 'var(--shell-run)',
        'shell-run-soft': 'var(--shell-run-soft)',
        'shell-run-border': 'var(--shell-run-border)',
        'shell-err': 'var(--shell-err)',
        'shell-err-soft': 'var(--shell-err-soft)',
        'shell-err-border': 'var(--shell-err-border)',
        'shell-line': 'var(--shell-line)',
        // v0.27.1：业务主色工具族——Sidebar 等处自 v0.21.0 起使用了
        // business-primary(-soft) 类名但从未注册（编译产物中无此类），
        // 选中态样式整体失效；此处补注册 + business-ring 供 ring 使用
        'business-primary': 'var(--business-primary)',
        'business-primary-hover': 'var(--business-primary-hover)',
        'business-primary-soft': 'var(--business-primary-soft)',
        'business-ring': 'var(--business-primary-ring)',
      },
      fontFamily: {
        // v0.21.0：移除 Inter / JetBrains Mono 外链依赖，改用系统字体栈（与 globals.css --font-sans 一致）
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', 'Helvetica', 'Arial', 'sans-serif'],
        display: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', 'Helvetica', 'Arial', 'sans-serif'],
        mono: ['SF Mono', 'JetBrains Mono', 'Fira Code', 'Consolas', 'Liberation Mono', 'Menlo', 'Courier', 'PingFang SC', 'Microsoft YaHei'],
      },
      borderRadius: {
        DEFAULT: '8px',
        sm: '6px',
        md: '8px',
        lg: '12px',
        xl: '16px',
        '2xl': '20px',
        '3xl': '22px',   // v0.21.0：DSH 风格 Composer floating card radius
      },
      fontSize: {
        // v0.13.0 — Modular 1.2 scale，主体 15px（WorkBuddy 量级）
        '2xs': ['11px', { lineHeight: '16px' }],   // caption
        xs: ['12px', { lineHeight: '18px' }],       // meta
        sm: ['13px', { lineHeight: '20px' }],       // 行号、标签
        base: ['14px', { lineHeight: '20px' }],     // body（主体，v0.17.0 14px 基线）
        md: ['14px', { lineHeight: '22px' }],       // 次级正文
        lg: ['17px', { lineHeight: '26px' }],       // 强调正文、卡标题
        xl: ['20px', { lineHeight: '28px' }],       // 任务标题
        '2xl': ['26px', { lineHeight: '34px' }],    // 页标题
        '3xl': ['32px', { lineHeight: '40px' }],    // hero
        '4xl': ['42px', { lineHeight: '50px' }],
      },
      spacing: {
        0.5: '2px',
        1.5: '6px',
        2.5: '10px',
        3.5: '14px',
        8: '32px', // v0.3.0 对话流段落间距
      },
      boxShadow: {
        // v0.4.0 — 阴影也由 CSS 变量驱动（浅深皮肤投影强度不同）
        'sm': 'var(--shadow-sm)',
        'md': 'var(--shadow-md)',
        'lg': 'var(--shadow-lg)',
        'accent': '0 0 0 3px var(--accent-soft)',
        'panel': 'var(--shadow-panel)',
      },
      transitionDuration: {
        DEFAULT: '150ms',
        fast: '100ms',
      },
      transitionTimingFunction: {
        smooth: 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
  plugins: [],
}
