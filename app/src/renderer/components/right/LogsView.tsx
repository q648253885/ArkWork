/* ============================================================
 * ArkWork — LogsView
 * polish4 §E1：日志可复制 — 工具栏「复制」按钮 + 单条 hover 复制 +
 * 右键菜单 + user-select:text。
 * Task 8：功能日志错误第二行展示 — 两行布局，错误独立成行、
 * text-danger 高亮、超长默认折叠、一键复制完整错误。
 * ============================================================ */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../../icons'
import { useStore } from '../../store'
import { formatTime } from '../../types'
import { SectionLabel, EmptyState } from '../ui'
import type { LogEntry } from '@shared/types/ipc'

// v0.27.1：级别色改用主题 token 硬编码值移除——硬编码色在深浅皮肤下对比度不可控，
// 且与 danger/warning 等 token 脱钩（走查项：日志过滤 chip 颜色）
const LEVEL_COLOR: Record<string, string> = {
  DEBUG: 'var(--text-tertiary)',
  INFO: 'var(--text-secondary)',
  WARN: 'var(--warning)',
  ERROR: 'var(--danger)',
}

/** Task 8：状态徽章 — 成功(INFO)=绿 / 警告(WARN)=黄 / 失败(ERROR)=红 / 调试(DEBUG)=灰 */
const LEVEL_BADGE: Record<string, { label: string; color: string; bg: string }> = {
  DEBUG: { label: 'logsview.badgeDebug', color: 'var(--text-tertiary)', bg: 'rgba(107, 98, 92, 0.12)' },
  INFO: { label: 'logsview.badgeInfo', color: 'var(--success)', bg: 'var(--success-soft)' },
  WARN: { label: 'logsview.badgeWarn', color: 'var(--warning)', bg: 'var(--warning-soft)' },
  ERROR: { label: 'logsview.badgeError', color: 'var(--danger)', bg: 'var(--danger-soft)' },
}

/** Task 8：超长错误/结果折叠阈值（字符数） */
const COLLAPSE_THRESHOLD = 120

/** 默认视图隐藏 DEBUG 级（内部容错/重试路径日志），避免刷屏；审计仍可从日志文件查询 */
const DEFAULT_LEVEL_FILTER = new Set(['INFO', 'WARN', 'ERROR'])

/** polish4 §E1.2：把日志条目序列化为可粘贴文本（每条一行） */
function buildLogText(entries: { ts: number; level: string; source: string; message: string }[]): string {
  return entries
    .map((e) => `${formatTime(e.ts)} [${e.level}] [${e.source}] ${e.message}`)
    .join('\n')
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 降级到 textarea + execCommand
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
    return true
  } catch {
    return false
  }
}

type LogLike = { ts: number; level: string; source: string; message: string }

/** Task 8：单条日志行 — 两行布局，错误独立成行、可折叠、可复制完整内容 */
function LogEntryRow({
  entry,
  index,
  onCopyLine,
}: {
  entry: LogEntry
  index: number
  onCopyLine: (entry: LogLike) => void
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)

  const isError = entry.level === 'ERROR'
  const isLong = entry.message.length > COLLAPSE_THRESHOLD
  const collapsed = isLong && !expanded
  const displayMessage = collapsed ? entry.message.slice(0, COLLAPSE_THRESHOLD) + '…' : entry.message

  const badge = LEVEL_BADGE[entry.level] ?? LEVEL_BADGE.INFO

  const handleCopyMsg = async () => {
    const ok = await copyToClipboard(entry.message)
    if (ok) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    }
  }

  return (
    <div
      data-log-index={index}
      className="log-entry group py-1 px-1.5 rounded-md hover:bg-bg-hover"
    >
      {/* 第一行：操作名称 + 状态徽章 + 时间戳 + 行复制（不被第二行遮挡） */}
      <div className="log-entry__head flex items-center gap-1.5">
        <span className="text-2xs font-semibold text-text-primary flex-shrink-0">
          {entry.source}
        </span>
        <span
          className="log-entry__badge text-2xs font-medium px-1.5 py-0.5 rounded-md flex-shrink-0"
          style={{ color: badge.color, background: badge.bg }}
        >
          {t(badge.label)}
        </span>
        <span className="text-2xs text-text-tertiary tabular flex-shrink-0">
          {formatTime(entry.ts)}
        </span>
        {/* polish4 §E1.3：单条 hover 行内复制（复制整条格式化日志） */}
        <button
          onClick={(e) => {
            e.stopPropagation()
            onCopyLine(entry)
          }}
          aria-label={t('logsview.copyLineAria')}
          title={t('logsview.copyLineTitle')}
          className="log-entry__hover-copy ml-auto opacity-0 group-hover:opacity-100 w-5 h-5 flex-shrink-0 flex items-center justify-center rounded text-text-tertiary hover:bg-bg-active hover:text-text-primary transition-opacity focus-ring"
        >
          <Icon.Copy width={12} height={12} aria-hidden="true" />
        </button>
      </div>

      {/* 第二行：错误详情 / 结果摘要，独立成行，不被遮挡、不截断（超长折叠） */}
      <div className="log-entry__body mt-0.5 min-w-0">
        <div
          className={`log-entry__msg font-mono text-xs leading-relaxed break-words ${
            isError ? 'log-entry__error text-danger' : 'text-text-secondary'
          } ${collapsed ? (isError ? 'log-entry__error--collapsed' : 'log-entry__msg--collapsed') : ''}`}
        >
          {displayMessage}
        </div>
      </div>

      {/* 操作按钮：展开/收起 + 复制错误（错误始终可复制；超长可展开） */}
      {(isLong || isError) && (
        <div className="log-entry__actions mt-1 flex items-center gap-2">
          {isLong && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                setExpanded((v) => !v)
              }}
              aria-expanded={expanded}
              className="log-entry__expand-btn inline-flex items-center gap-0.5 text-2xs text-text-tertiary hover:text-text-primary transition-colors focus-ring"
            >
              {expanded
                ? isError
                  ? t('logsview.collapseError')
                  : t('logsview.collapse')
                : isError
                  ? t('logsview.expandError')
                  : t('logsview.expand')}
              <Icon.ChevronDown
                width={10}
                height={10}
                aria-hidden="true"
                style={{
                  transform: expanded ? 'rotate(180deg)' : 'none',
                  transition: 'transform 150ms',
                }}
              />
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation()
              void handleCopyMsg()
            }}
            className="log-entry__copy-btn inline-flex items-center gap-0.5 text-2xs text-text-tertiary hover:text-text-primary transition-colors focus-ring"
          >
            {copied ? (
              <>
                <Icon.Check width={10} height={10} aria-hidden="true" />
                {t('logsview.copiedLine')}
              </>
            ) : (
              <>
                <Icon.Copy width={10} height={10} aria-hidden="true" />
                {isError ? t('logsview.copyErrorLine') : t('logsview.copyLine')}
              </>
            )}
          </button>
        </div>
      )}
    </div>
  )
}

export function LogsView() {
  const { t } = useTranslation()
  const logs = useStore((s) => s.logs)
  const pushToast = useStore((s) => s.pushToast)
  const [filter, setFilter] = useState('')
  const [levelFilter, setLevelFilter] = useState<Set<string>>(new Set(DEFAULT_LEVEL_FILTER))
  // 右键菜单状态：{ entryIndex, x, y }
  const [ctxMenu, setCtxMenu] = useState<
    | { index: number | null; x: number; y: number }
    | null
  >(null)

  const filtered = useMemo(() => {
    return logs.filter((e) => {
      if (filter && !e.message.toLowerCase().includes(filter.toLowerCase())) return false
      if (levelFilter.size > 0 && !levelFilter.has(e.level)) return false
      return true
    })
  }, [logs, filter, levelFilter])

  const toggleLevel = (lv: string) =>
    setLevelFilter((prev) => {
      const next = new Set(prev)
      if (next.has(lv)) next.delete(lv)
      else next.add(lv)
      return next
    })

  const handleCopy = async (entries: LogLike[], label: string) => {
    const text = buildLogText(entries)
    if (!text) {
      pushToast({ type: 'warning', message: t('logsview.noCopiable'), duration: 2000 })
      return
    }
    const ok = await copyToClipboard(text)
    pushToast({
      type: ok ? 'success' : 'danger',
      message: ok ? `${label}：${entries.length} ${t('logsview.entriesUnit')}` : t('logsview.copyFailedManual'),
      duration: 2000,
    })
  }

  return (
    <div className="flex flex-col h-full" onClick={() => setCtxMenu(null)}>
      {/* 工具栏：搜索 + 等级筛选 + 复制 */}
      <div className="px-3 py-2 border-b border-border-subtle flex items-center gap-1.5 flex-wrap">
        <Icon.Search width={16} height={16} className="text-text-tertiary flex-shrink-0" />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t('logsview.filterPlaceholder')}
          className="flex-1 min-w-[80px] px-1 py-0.5 text-xs text-text-primary placeholder:text-text-tertiary bg-transparent outline-none"
        />
        <div className="flex items-center gap-1 flex-shrink-0">
          {(['DEBUG', 'INFO', 'WARN', 'ERROR'] as const).map((lv) => {
            const active = levelFilter.size === 0 || levelFilter.has(lv)
            return (
              <button
                key={lv}
                onClick={() => toggleLevel(lv)}
                className={`px-1 py-0.5 rounded text-[10px] leading-none font-medium border transition-colors ${
                  active
                    ? 'border-border-default'
                    : 'border-border-subtle text-text-tertiary opacity-50'
                }`}
                style={active ? { color: LEVEL_COLOR[lv] } : undefined}
              >
                {lv}
              </button>
            )
          })}
        </div>
        {/* polish4 §E1.1：复制按钮 */}
        <button
          onClick={() => void handleCopy(filtered, t('logsview.copyFilteredLabel'))}
          aria-label={t('logsview.copyFilteredAria')}
          title={t('logsview.copyFilteredTitle')}
          className="ml-1 flex items-center gap-1 px-2 py-0.5 rounded-md text-2xs font-medium border border-border-default text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors focus-ring"
        >
          <Icon.Copy width={12} height={12} aria-hidden="true" />
          {t('logsview.copyFilteredBtn')}
        </button>
      </div>

      {/* 日志列表（user-select:text 启用选区复制） */}
      <div
        className="flex-1 overflow-y-auto px-2 py-2 font-mono text-xs leading-relaxed select-text"
        onContextMenu={(e) => {
          e.preventDefault()
          const target = (e.target as HTMLElement).closest('[data-log-index]')
          const idx = target ? Number(target.getAttribute('data-log-index')) : null
          setCtxMenu({ index: idx, x: e.clientX, y: e.clientY })
        }}
      >
        {filtered.length === 0 ? (
          <EmptyState
            icon={<Icon.Terminal width={22} height={22} />}
            title={logs.length === 0 ? t('logsview.emptyTitle') : t('logsview.noMatchTitle')}
            hint={logs.length === 0 ? t('logsview.emptyHint') : undefined}
          />
        ) : (
          filtered.map((entry, i) => (
            <LogEntryRow
              key={`${entry.ts}-${i}`}
              entry={entry}
              index={i}
              onCopyLine={(e) => void handleCopy([e], t('logsview.copiedOneEntry'))}
            />
          ))
        )}
      </div>

      {/* polish4 §E1.4：右键菜单 */}
      {ctxMenu && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setCtxMenu(null)} />
          <div
            role="menu"
            className="fixed z-40 min-w-[200px] py-1 bg-bg-overlay border border-border-default rounded-md shadow-panel text-xs"
            style={{ left: ctxMenu.x, top: ctxMenu.y }}
          >
            <button
              role="menuitem"
              disabled={ctxMenu.index === null}
              onClick={() => {
                const entry = ctxMenu.index === null ? null : filtered[ctxMenu.index]
                if (entry) void handleCopy([entry], t('logsview.copiedOneEntry'))
                setCtxMenu(null)
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-bg-hover disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {t('logsview.ctxCopyLine')}
            </button>
            <button
              role="menuitem"
              onClick={() => {
                void handleCopy(filtered, t('logsview.copyFilteredLabel'))
                setCtxMenu(null)
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-bg-hover"
            >
              {t('logsview.ctxCopyFilteredAll', { count: filtered.length })}
            </button>
            <button
              role="menuitem"
              onClick={() => {
                void handleCopy(logs, t('logsview.copyAllLabel'))
                setCtxMenu(null)
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-bg-hover"
            >
              {t('logsview.ctxCopyAll', { count: logs.length })}
            </button>
          </div>
        </>
      )}

      {/* 底部统计 */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-t border-border-subtle bg-bg-surface">
        <SectionLabel>{filtered.length} entries</SectionLabel>
        {levelFilter.size > 0 && (
          <button
            onClick={() => setLevelFilter(new Set())}
            className="text-2xs text-text-tertiary hover:text-text-primary transition-colors"
          >
            {t('logsview.clearFilter')}
          </button>
        )}
      </div>
    </div>
  )
}
