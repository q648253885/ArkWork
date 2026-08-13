/* ============================================================
 * ArkWork — 应用内品牌标识 (Task 1 / Task 2 视觉正中预留)
 * 复用 build-resources/icon-source.svg 的几何规范（squircle +
 * 三节点横梁 + 三阶段竖条 + 顶部观测镜），可在浅色/深色背景上稳定呈现。
 *
 * 使用：
 *   <Brand size={20} />                      // 行内（Onboarding 头部）
 *   <Brand size={48} withWordmark />          // 引导/设置页品牌卡
 * ============================================================ */
import type { CSSProperties } from 'react'
import brandSvg from '../assets/brand/arkwork-icon.svg'

interface BrandProps {
  size?: number
  withWordmark?: boolean
  className?: string
  style?: CSSProperties
  title?: string
}

export function Brand({
  size = 22,
  withWordmark = false,
  className,
  style,
  title = 'ArkWork',
}: BrandProps) {
  const dim = `${size}px`
  return (
    <span
      className={`inline-flex items-center gap-1.5 ${className ?? ''}`}
      style={style}
    >
      <img
        src={brandSvg}
        width={size}
        height={size}
        alt=""
        aria-hidden="true"
        draggable={false}
        style={{ width: dim, height: dim, display: 'inline-block' }}
      />
      {withWordmark && (
        <span
          className="font-semibold tracking-tight"
          style={{ fontSize: Math.round(size * 0.55) }}
        >
          {title}
        </span>
      )}
    </span>
  )
}

export default Brand