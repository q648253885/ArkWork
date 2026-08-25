import type { SVGProps } from 'react'

/* ============================================================
 * 图标三级规格（v3.0 S1 — 密度有级，修复 v0.12.0 一刀切 22px）
 *
 * 语义化默认值，杜绝「新代码不传尺寸 → 掉进 22px 陷阱」：
 *   L · 主操作 20/1.75 — 发送、停止、设置、新建（工具栏主按钮）
 *   M · 行内   18/1.75 — 模块行、任务行、面板 Tab、通用按钮
 *   S · 装饰   14/1.6  — 徽标、chip、StatusBar、消息操作条
 *
 * 用法：<Icon.Plus /> 默认 M（行内）；主操作显式传 20，装饰显式传 14。
 * 历史：v0.11.0 之前默认 16/1.6；v0.12.0 一刀切 22/1.75 破坏行内密度；
 *       v0.17.0 主操作收敛为 20px（对齐交互文档 §3.10）。
 * ============================================================ */
const SPEC = {
  L: { width: 20, height: 20, strokeWidth: 1.75 },
  M: { width: 18, height: 18, strokeWidth: 1.75 },
  S: { width: 14, height: 14, strokeWidth: 1.6 },
} as const

type IconSpec = keyof typeof SPEC

const base = (props: SVGProps<SVGSVGElement>, spec: IconSpec = 'M') => ({
  ...SPEC[spec],
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  ...props,
})

export const Icon = {
  Plus: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  Search: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  ),
  Bolt: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" />
    </svg>
  ),
  Box: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <path d="M21 8 12 3 3 8v8l9 5 9-5V8z" />
      <path d="m3 8 9 5 9-5M12 13v8" />
    </svg>
  ),
  Bot: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <rect x="4" y="8" width="16" height="12" rx="2" />
      <path d="M12 2v6M9 14h.01M15 14h.01" />
    </svg>
  ),
  List: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
    </svg>
  ),
  Book: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5z" />
      <path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20" />
    </svg>
  ),
  Folder: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <path d="M3 7v12a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1h-9l-2-3H4a1 1 0 0 0-1 1z" />
    </svg>
  ),
  FolderOpen: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <path d="M3 7v12a1 1 0 0 0 1 1h13l4-9H7a2 2 0 0 0-1.7 1L3 7z" />
      <path d="M3 7 5 4h5l2 3" />
    </svg>
  ),
  ChevronRight: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <path d="m9 6 6 6-6 6" />
    </svg>
  ),
  ChevronDown: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  ),
  ChevronLeft: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <path d="m15 6-6 6 6 6" />
    </svg>
  ),
  X: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  ),
  Play: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <path d="m6 4 14 8-14 8V4z" />
    </svg>
  ),
  Pause: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <path d="M6 4h4v16H6zM14 4h4v16h-4z" />
    </svg>
  ),
  Stop: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <rect x="5" y="5" width="14" height="14" rx="2" />
    </svg>
  ),
  Send: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <path d="m22 2-7 20-4-9-9-4 20-7z" />
    </svg>
  ),
  Paperclip: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <path d="M21.4 11.05 12 20.5a4.95 4.95 0 0 1-7-7l8.5-8.5a3.5 3.5 0 0 1 5 5L10 18" />
    </svg>
  ),
  Brain: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.95.5 2.5 2.5 0 0 1-2.5-3A2.5 2.5 0 0 1 3 12a2.5 2.5 0 0 1 1.5-4.5A2.5 2.5 0 0 1 9.5 2zM14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.95.5 2.5 2.5 0 0 0 2.5-3A2.5 2.5 0 0 0 21 12a2.5 2.5 0 0 0-1.5-4.5A2.5 2.5 0 0 0 14.5 2z" />
    </svg>
  ),
  Settings: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
  Command: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z" />
    </svg>
  ),
  File: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  ),
  Note: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M8 13h8M8 17h5" />
    </svg>
  ),
  Eye: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
  Terminal: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <path d="M4 17l6-5-6-5M12 19h8" />
    </svg>
  ),
  Graph: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <circle cx="6" cy="6" r="2" />
      <circle cx="18" cy="6" r="2" />
      <circle cx="12" cy="18" r="2" />
      <path d="M7.5 7.5 16 16M16.5 7.5 9 16" />
    </svg>
  ),
  Star: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <path d="M12 2l3 7 7 .5-5.5 4.5L18 21l-6-4-6 4 1.5-7L2 9.5 9 9z" />
    </svg>
  ),
  Check: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <path d="m5 12 5 5L20 7" />
    </svg>
  ),
  Filter: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <path d="M3 4h18l-7 8v6l-4 2v-8z" />
    </svg>
  ),
  Refresh: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5" />
    </svg>
  ),
  Clock: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  ),
  Dot: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)} fill="currentColor" stroke="none">
      <circle cx="12" cy="12" r="5" />
    </svg>
  ),
  Sparkle: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
  Branch: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <circle cx="6" cy="6" r="2" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="9" r="2" />
      <path d="M6 8v8M18 11a6 6 0 0 1-6 6" />
    </svg>
  ),
  ArrowUp: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  ),
  ArrowDown: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <path d="M12 5v14M19 12l-7 7-7-7" />
    </svg>
  ),
  AtSign: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <circle cx="12" cy="12" r="4" />
      <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
    </svg>
  ),
  Slash: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <path d="M16 4 8 20" />
    </svg>
  ),
  // v0.6.0：CRUD / 管理图标
  Edit: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  ),
  Trash: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  ),
  Download: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M7 10l5 5 5-5M12 15V3" />
    </svg>
  ),
  Upload: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M17 8l-5-5-5 5M12 3v12" />
    </svg>
  ),
  Plug: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <path d="M12 22v-5" />
      <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <path d="M9 7h6v4a3 3 0 0 1-6 0V7Z" />
      <path d="M12 14v3" />
    </svg>
  ),
  Power: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <path d="M12 2v10" />
      <path d="M18.4 6.6a9 9 0 1 1-12.8 0" />
    </svg>
  ),
  Info: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4M12 8h.01" />
    </svg>
  ),
  // v0.14.0 Task 8：清单存在失败步骤时的任务行 warning 角标（feather alert-triangle）
  Warning: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  ),
  // v0.6.3：文件操作图标
  Copy: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  ),
  ExternalLink: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  ),
  // v0.8.0 F824：内置锁定标识
  Lock: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  ),
  // v0.13.0：主题图标（替代 emoji 表达状态/能力，对齐 00-design-system §1.2）
  Sun: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  ),
  Moon: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  ),
  System: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  ),
  // fix-workspace-task-automation-memory Task 2：线程行 ⋯ 菜单
  MoreHorizontal: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  ),
  // redesign-workspace-navigation — 原创 ArkWork 工作区图形
  // 语义：四格工作区面板，每格代表一个独立上下文（左上深色块 = 当前激活的工作区）。
  // 不使用任何具象图形（机器人/文件夹/扳手），确保与同类产品商标拉开差异。
  Workspace: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <rect x="3" y="3" width="8" height="8" rx="1.5" fill="currentColor" fillOpacity="0.85" stroke="none" />
      <rect x="13" y="3" width="8" height="8" rx="1.5" />
      <rect x="3" y="13" width="8" height="8" rx="1.5" />
      <rect x="13" y="13" width="8" height="8" rx="1.5" />
    </svg>
  ),
  // Task 9：进度摘要（带勾选项的清单图标，与「清单」Tab 区分）
  ListChecks: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <path d="m3 6 2 2 4-4" />
      <path d="m3 13 2 2 4-4" />
      <path d="M12 6h9M12 13h9M12 20h9" />
    </svg>
  ),
  // v0.18.0：planItem 行操作按钮 — 重试 / 取消 / StepList 联动
  RotateCcw: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  ),
  ArrowUpDown: (p: SVGProps<SVGSVGElement>) => (
    <svg {...base(p)}>
      <path d="m7 4 0 16M3 8l4-4 4 4" />
      <path d="m17 20 0 -16M21 16l-4 4 -4 -4" />
    </svg>
  ),
}

export type IconName = keyof typeof Icon
