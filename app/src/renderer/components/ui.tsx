import { useStore } from '../store'
import { STATUS_CHAR, STATUS_COLOR } from '../constants'
import type { TaskStatus } from '../types'
import { useRef, useState } from 'react'

/* ============================================================
 * StatusDot — 任务状态指示
 * ============================================================ */
export function StatusDot({
  status,
  pulse = false,
  size = 14,
}: {
  status: TaskStatus
  pulse?: boolean
  size?: number
}) {
  const color = STATUS_COLOR[status]
  const char = STATUS_CHAR[status]
  const showPulse = pulse && (status === 'running')
  return (
    <span
      className={`inline-flex items-center justify-center rounded-full flex-shrink-0 ${
        showPulse ? 'pulse-dot' : ''
      }`}
      style={{ width: size, height: size, background: color }}
      title={status}
    >
      <span
        className="font-semibold leading-none"
        style={{ color: 'var(--text-inverse)', fontSize: Math.max(8, size - 5) }}
      >
        {char}
      </span>
    </span>
  )
}

/* ============================================================
 * Kbd — 键盘按键提示
 * ============================================================ */
export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-md text-[11px] font-medium bg-bg-elevated text-text-secondary border border-border-default">
      {children}
    </kbd>
  )
}

/* ============================================================
 * Tooltip — 悬停提示（v3.0 双通道）
 * 历史：
 *   v0.11.0 F1101：三层模型 L1 名称+快捷键 / L2 一句话说明 / L3 能力卡
 *   v0.11.0 实现：350ms 延迟、hover + focus 双触发
 *   v0.12.0 升级：仅鼠标悬停触发（移除 focus，解决 Tab 切换闪现）
 *   v3.0（S2 修正）：恢复 focus 触发但仅 focus-visible（键盘可达，
 *     鼠标点击聚焦不弹，不重演 v0.12.0 的 Tab 闪现问题）；
 *     键盘触发 0ms 立即显示，鼠标按 delay 分级（高频 150 / 低频 350）
 *
 * 行为规约：
 *   - 鼠标：进入延迟 delay 出现（默认 350，高频操作传 150）
 *   - 键盘：Tab 聚焦（:focus-visible）立即出现，blur 关闭
 *   - mouse leave 时立即关闭
 *   - 鼠标进入 tooltip 自身不立即关闭（hoverable，WCAG 1.4.13）
 * ============================================================ */
export function Tooltip({
  label,
  children,
  placement = 'top',
  kbd,
  desc,
  cap,
  delay = 350,
  block = false,
  className,
}: {
  label: string
  children: React.ReactNode
  placement?: 'top' | 'bottom' | 'left' | 'right'
  /** v0.11.0：快捷键键帽（L1 增强） */
  kbd?: string
  /** v0.11.0：一句话说明（L2） */
  desc?: string
  /** v0.11.0：能力卡内容（L3，如 "上下文 64K · 🧠思考 · 🔧工具"） */
  cap?: string
  /** v0.12.0：鼠标出现延迟 ms，默认 350；高频操作（发送/停止）传 150 */
  delay?: number
  /** v0.12.0：块级包裹（用于 chip / 整行可提示对象） */
  block?: boolean
  /** v0.12.0：透传 wrapper className（用于微调布局） */
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [hoverTip, setHoverTip] = useState(false)
  const timerRef = useRef<number | null>(null)
  // 进入/离开 + 进出 tooltip 自身都需考虑；只要任一为 true，保持显示
  const activeRef = useRef(false)

  const show = (immediate = false) => {
    activeRef.current = true
    if (timerRef.current) return
    timerRef.current = window.setTimeout(() => {
      if (activeRef.current) setOpen(true)
    }, immediate ? 0 : delay)
  }
  const hide = () => {
    activeRef.current = false
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    // 短暂延迟以允许 tooltip hover 接续（hoverable，WCAG 1.4.13）
    window.setTimeout(() => {
      if (!activeRef.current && !hoverTip) setOpen(false)
    }, 80)
  }
  const onTipEnter = () => {
    setHoverTip(true)
    activeRef.current = true
  }
  const onTipLeave = () => {
    setHoverTip(false)
    activeRef.current = false
    if (!activeRef.current) setOpen(false)
  }
  // v3.0：键盘焦点触发（仅 :focus-visible，鼠标点击聚焦不弹）
  const onFocus = (e: React.FocusEvent) => {
    const t = e.target as HTMLElement
    if (typeof t.matches === 'function' && t.matches(':focus-visible')) show(true)
  }

  const posCls =
    placement === 'top'
      ? 'bottom-full mb-1.5 left-1/2 -translate-x-1/2'
      : placement === 'bottom'
        ? 'top-full mt-1.5 left-1/2 -translate-x-1/2'
        : placement === 'left'
          ? 'right-full mr-1.5 top-1/2 -translate-y-1/2'
          : 'left-full ml-1.5 top-1/2 -translate-y-1/2'

  const hasRich = !!(kbd || desc || cap)
  const wrapperCls = block
    ? `relative block ${className ?? ''}`
    : `relative inline-flex ${className ?? ''}`

  return (
    <span
      className={wrapperCls.trim()}
      onMouseEnter={() => show()}
      onMouseLeave={hide}
      onFocus={onFocus}
      onBlur={hide}
    >
      {children}
      <span
        role="tooltip"
        onMouseEnter={onTipEnter}
        onMouseLeave={onTipLeave}
        className={`pointer-events-auto absolute ${posCls} z-50 ${
          open ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-0.5'
        }`}
        style={{
          background: 'var(--tooltip-bg)',
          color: 'var(--tooltip-text)',
          borderRadius: '8px',
          padding: hasRich ? '8px 11px' : '5px 9px',
          boxShadow: 'var(--shadow-md)',
          maxWidth: '340px',
          whiteSpace: hasRich ? 'normal' : 'nowrap',
          transition: 'opacity 140ms ease, transform 140ms ease',
          pointerEvents: open ? 'auto' : 'none',
        }}
        aria-hidden={!open}
      >
        <span className="flex items-center gap-1.5 text-xs font-medium leading-relaxed">
          {label}
          {kbd && (
            <span
              className="inline-flex items-center font-mono text-[10.5px] leading-none px-1.5 py-0.5 rounded"
              style={{
                background: 'var(--tooltip-kbd-bg)',
                border: '1px solid var(--tooltip-kbd-border)',
                marginLeft: '3px',
              }}
            >
              {kbd}
            </span>
          )}
        </span>
        {desc && (
          <span className="block text-[11.5px] opacity-85 mt-1 leading-snug">{desc}</span>
        )}
        {cap && (
          <span className="block text-[11px] opacity-90 mt-1.5 pt-1.5 border-t leading-relaxed" style={{ borderColor: 'var(--tooltip-kbd-border)' }}>
            {cap}
          </span>
        )}
      </span>
    </span>
  )
}

/* ============================================================
 * EmptyState — 空状态
 * ============================================================ */
export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon?: React.ReactNode
  title: string
  hint?: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center h-full p-6 text-center">
      {icon && <div className="text-text-tertiary mb-2.5">{icon}</div>}
      <div className="text-sm text-text-secondary mb-1">{title}</div>
      {hint && <div className="text-xs text-text-tertiary max-w-[280px]">{hint}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  )
}

/* ============================================================
 * SectionLabel — 小节标题
 * ============================================================ */
export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-2xs text-text-tertiary uppercase tracking-wider font-medium">
      {children}
    </div>
  )
}

/* ============================================================
 * useResize — 拖拽调整左右栏宽度
 * ============================================================ */
export function useResize() {
  const leftWidth = useStore((s) => s.leftWidth)
  const rightWidth = useStore((s) => s.rightWidth)
  const setLeftWidth = useStore((s) => s.setLeftWidth)
  const setRightWidth = useStore((s) => s.setRightWidth)

  const startLeftResize = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = leftWidth
    const move = (mv: MouseEvent) => setLeftWidth(startW + (mv.clientX - startX))
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'col-resize'
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const startRightResize = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = rightWidth
    const move = (mv: MouseEvent) => setRightWidth(startW + (startX - mv.clientX))
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'col-resize'
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return { startLeftResize, startRightResize }
}
