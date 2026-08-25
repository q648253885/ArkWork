import { useStore } from '../store'
import { STATUS_CHAR, STATUS_COLOR } from '../constants'
import type { TaskStatus } from '../types'
import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

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
      if (activeRef.current) handleOpen()
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

  // v0.24.x fix：tooltip 改用 portal 渲染到 body + fixed 定位 ——
  // 之前 absolute 定位会被左右侧边栏（overflow 容器）裁剪/遮挡，
  // 且 z-50 低于侧边面板的堆叠上下文。portal 后脱离裁剪容器，
  // fixed + zIndex 9999 保证永远显示在最顶层。
  const wrapperRef = useRef<HTMLSpanElement>(null)
  const tipRef = useRef<HTMLSpanElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  // v0.27.2：open 后在 paint 前用 useLayoutEffect 同步测量定位。
  // 旧 rAF 方案可能先于 React commit 执行——tipRef 尚为 null 时 computePos
  // 早退，pos 恒为 null，tooltip 却已按 measured=true 以 opacity:1 卡死在
  // 视口左上角 (0,0)，直接盖住左上角真实按钮（工作区切换键中招）。
  // layout effect 在 DOM 提交后、绘制前运行，refs 必然就绪，竞态根除。
  useLayoutEffect(() => {
    if (!open) return
    const wrap = wrapperRef.current
    const tip = tipRef.current
    if (!wrap || !tip) return
    const wr = wrap.getBoundingClientRect()
    const tr = tip.getBoundingClientRect()
    const gap = 8
    const pad = 8
    // v0.27.2：空间不足先翻转、后收边。旧逻辑对贴顶元素把负 top 直接
    // Math.max(pad,…) 压回屏内，tooltip 恰好叠在触发按钮上导致无法点击
    //（右上角设置键、顶栏工作区键均中招）。翻转后仅在对侧也放不下时才收边。
    const fitsTop = wr.top - tr.height - gap >= pad
    const fitsBottom = wr.bottom + gap + tr.height <= window.innerHeight - pad
    let place = placement
    if (place === 'top' && !fitsTop && fitsBottom) place = 'bottom'
    else if (place === 'bottom' && !fitsBottom && fitsTop) place = 'top'
    let top = 0
    let left = 0
    if (place === 'top') {
      top = wr.top - tr.height - gap
      left = wr.left + wr.width / 2 - tr.width / 2
    } else if (place === 'bottom') {
      top = wr.bottom + gap
      left = wr.left + wr.width / 2 - tr.width / 2
    } else if (place === 'left') {
      top = wr.top + wr.height / 2 - tr.height / 2
      left = wr.left - tr.width - gap
    } else {
      top = wr.top + wr.height / 2 - tr.height / 2
      left = wr.right + gap
    }
    // 视口内收边，避免 tooltip 超出屏幕
    top = Math.max(pad, Math.min(top, window.innerHeight - tr.height - pad))
    left = Math.max(pad, Math.min(left, window.innerWidth - tr.width - pad))
    setPos({ top, left })
    setMeasured(true)
  }, [open, placement])

  // open 置位时先隐藏一帧，待 layout effect 量完尺寸再显示，避免旧坐标闪现
  const [measured, setMeasured] = useState(false)
  const handleOpen = () => {
    setOpen(true)
    setMeasured(false)
  }

  const hasRich = !!(kbd || desc || cap)
  const wrapperCls = block
    ? `relative block ${className ?? ''}`
    : `relative inline-flex ${className ?? ''}`

  const tooltipEl = open
    ? createPortal(
        <span
          ref={tipRef}
          role="tooltip"
          onMouseEnter={onTipEnter}
          onMouseLeave={onTipLeave}
          className="pointer-events-auto"
          style={{
            position: 'fixed',
            top: pos?.top ?? 0,
            left: pos?.left ?? 0,
            zIndex: 9999,
            background: 'var(--tooltip-bg)',
            color: 'var(--tooltip-text)',
            borderRadius: '8px',
            padding: hasRich ? '8px 11px' : '5px 9px',
            boxShadow: 'var(--shadow-md)',
            maxWidth: '340px',
            // v0.27.2：纯 label 长文案（如 ctx 圆环的用量明细）不再 nowrap——
            // 旧写法文字会溢出气泡底色之外，视觉上如同被遮挡；统一折行显示
            whiteSpace: 'normal',
            opacity: measured ? 1 : 0,
            transition: 'opacity 140ms ease',
            pointerEvents: measured ? 'auto' : 'none',
          }}
          aria-hidden={!measured}
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
            <span
              className="block text-[11.5px] opacity-85 mt-1 leading-snug"
              style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
            >
              {desc}
            </span>
          )}
          {cap && (
            <span
              className="block text-[11px] opacity-90 mt-1.5 pt-1.5 border-t leading-relaxed"
              style={{
                borderColor: 'var(--tooltip-kbd-border)',
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
            >
              {cap}
            </span>
          )}
        </span>,
        document.body,
      )
    : null

  return (
    <span
      ref={wrapperRef}
      className={wrapperCls.trim()}
      onMouseEnter={() => show()}
      onMouseLeave={hide}
      onFocus={onFocus}
      onBlur={hide}
    >
      {children}
      {tooltipEl}
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
