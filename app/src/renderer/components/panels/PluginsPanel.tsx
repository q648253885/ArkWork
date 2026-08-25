/* ============================================================
 * ArkWork — PluginsPanel
 * v0.24.2 — 能力中心「插件」子页面：MCP Server 列表管理 UI
 *
 * 后端基础设施（client.ts / store/mcp-servers.ts / ipc/mcp.ts / McpEditor）
 * 已就绪，本面板只负责：
 *   - 列出全部 MCP server（含运行时状态 / 工具列表）
 *   - 触发 connect / disconnect
 *   - 调用 McpEditor 进行新建 / 编辑
 *   - 删除（带 confirm）
 *   - 状态点 + 错误展示
 *
 * 设计沿用 SkillsPanel 的 token 与紧凑布局（v4.2 暖夜色 + 紫罗兰）
 */
import { useMemo, useState } from 'react'
import { Icon } from '../../icons'
import { useStore } from '../../store'
import { Tooltip, EmptyState } from '../ui'
import { useTranslation } from 'react-i18next'
import type { McpServer } from '@shared/types/agent'

/** 运行时连接状态（与 McpServer.status 字段保持一致） */
type McpStatus = McpServer['status']

/* ============================================================
 * 状态徽标元信息
 * ============================================================ */
function getStatusMeta(t: (k: string) => string): Record<McpStatus, { dot: string; badge: string; label: string }> {
  return {
    connected: {
      dot: 'bg-success',
      badge: 'bg-success-soft text-success',
      label: t('panel.plugins.status.connected'),
    },
    connecting: {
      dot: 'bg-warning animate-pulse',
      badge: 'bg-warning-soft text-warning',
      label: t('panel.plugins.status.connecting'),
    },
    disconnected: {
      dot: 'bg-text-tertiary',
      badge: 'bg-bg-hover text-text-tertiary',
      label: t('panel.plugins.status.disconnected'),
    },
    error: {
      dot: 'bg-danger',
      badge: 'bg-danger-soft text-danger',
      label: t('panel.plugins.status.error'),
    },
  }
}

const TRANSPORT_LABEL: Record<McpServer['transport'], string> = {
  stdio: 'stdio',
  sse: 'sse',
}

export function PluginsPanel() {
  const { t } = useTranslation()
  const mcps = useStore((s) => s.mcps)
  const openMcpEditor = useStore((s) => s.openMcpEditor)
  const removeMcp = useStore((s) => s.removeMcp)
  const connectMcp = useStore((s) => s.connectMcp)
  const disconnectMcp = useStore((s) => s.disconnectMcp)
  const refreshCatalog = useStore((s) => s.refreshCatalog)
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState<Record<string, 'connecting' | 'disconnecting' | null>>({})

  const filterMatch = (m: McpServer) =>
    !filter.trim() ||
    m.name.toLowerCase().includes(filter.toLowerCase()) ||
    m.namespace.toLowerCase().includes(filter.toLowerCase()) ||
    (m.command ?? '').toLowerCase().includes(filter.toLowerCase())

  const filtered = useMemo(() => mcps.filter(filterMatch), [mcps, filter])

  const handleConnect = async (id: string) => {
    setBusy((s) => ({ ...s, [id]: 'connecting' }))
    try {
      await connectMcp(id)
    } finally {
      setBusy((s) => ({ ...s, [id]: null }))
    }
  }

  const handleDisconnect = async (id: string) => {
    setBusy((s) => ({ ...s, [id]: 'disconnecting' }))
    try {
      await disconnectMcp(id)
    } finally {
      setBusy((s) => ({ ...s, [id]: null }))
    }
  }

  return (
    <div className="p-3 flex flex-col h-full" data-testid="plugins-panel">
      {/* 操作栏：新建 + 刷新 + 总数 */}
      <div className="flex items-center gap-1.5 mb-2 flex-shrink-0">
        <button
          onClick={() => openMcpEditor(null)}
          className="flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium text-text-inverse bg-accent hover:bg-accent-hover transition-colors flex-shrink-0"
        >
          <Icon.Plus width={16} height={16} />
          {t('panel.plugins.new')}
        </button>
        <Tooltip label={t('panel.plugins.refreshTooltip')}>
          <button
            onClick={() => void refreshCatalog()}
            className="flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs text-text-secondary border border-border-default hover:bg-bg-hover hover:text-text-primary transition-colors flex-shrink-0"
          >
            <Icon.Refresh width={16} height={16} />
            {t('panel.plugins.refresh')}
          </button>
        </Tooltip>
        <span className="ml-auto text-2xs text-text-tertiary tabular flex-shrink-0">
          {t('panel.plugins.count', { count: mcps.length })}
        </span>
      </div>

      {/* 搜索框 */}
      <div className="mb-2 flex-shrink-0">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t('panel.plugins.searchPlaceholder')}
          className="w-full h-7 px-2 text-xs bg-bg-input border border-border-subtle rounded-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent transition-colors"
        />
      </div>

      {/* 说明卡 */}
      <div className="mb-3 px-2.5 py-2 rounded-md bg-bg-surface border border-border-subtle text-2xs text-text-tertiary leading-relaxed flex items-start gap-1.5">
        <Icon.Info width={14} height={14} className="mt-px flex-shrink-0" />
        <span>
          {t('panel.plugins.desc')}
        </span>
      </div>

      {/* 列表 / 空态 */}
      {mcps.length === 0 ? (
        <EmptyState
          icon={<Icon.Plug width={22} height={22} />}
          title={t('panel.plugins.empty.title')}
          hint={t('panel.plugins.empty.hint')}
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Icon.Search width={22} height={22} />}
          title={t('panel.plugins.noMatch.title')}
          hint={t('panel.plugins.noMatch.hint', { query: filter.trim() })}
        />
      ) : (
        <div className="space-y-2 overflow-y-auto flex-1" data-testid="plugins-list">
          {filtered.map((m) => (
            <PluginRow
              key={m.id}
              mcp={m}
              busy={busy[m.id] ?? null}
              onConnect={() => void handleConnect(m.id)}
              onDisconnect={() => void handleDisconnect(m.id)}
              onEdit={() => openMcpEditor(m)}
              onDelete={() => void removeMcp(m.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/* ============================================================
 * PluginRow — 单个 MCP server 卡片
 * ============================================================ */
function PluginRow({
  mcp,
  busy,
  onConnect,
  onDisconnect,
  onEdit,
  onDelete,
}: {
  mcp: McpServer
  busy: 'connecting' | 'disconnecting' | null
  onConnect: () => void
  onDisconnect: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const meta = getStatusMeta(t)[mcp.status]
  const isConnected = mcp.status === 'connected'
  const isBusy = busy !== null

  // 拼接命令预览（命令 + 参数前 80 字符）
  const commandPreview = (() => {
    if (mcp.transport === 'sse') return mcp.url ?? ''
    const cmd = mcp.command ?? ''
    const args = (mcp.args ?? []).join(' ')
    const full = args ? `${cmd} ${args}` : cmd
    return full.length > 80 ? full.slice(0, 80) + '…' : full
  })()

  const toolNames = mcp.tools.slice(0, 3).map((t) => t.name)
  const moreCount = mcp.tools.length - toolNames.length

  return (
    <div
      className="rounded-lg bg-bg-surface border border-border-subtle hover:border-border-default transition-colors overflow-hidden"
      data-testid={`plugin-row-${mcp.id}`}
    >
      {/* 第一行：状态点 + 名称 + namespace + transport + 展开 chevron */}
      <div
        className="flex items-center gap-2 px-2.5 py-2 cursor-pointer"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${meta.dot}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-sm text-text-primary truncate">{mcp.name}</span>
            <span className="text-2xs px-1.5 py-0.5 rounded bg-bg-hover text-text-tertiary font-mono flex-shrink-0">
              {mcp.namespace}
            </span>
            <span className="text-2xs px-1.5 py-0.5 rounded bg-bg-hover text-text-tertiary flex-shrink-0">
              {TRANSPORT_LABEL[mcp.transport]}
            </span>
            {!mcp.enabled && (
              <span className="text-2xs px-1.5 py-0.5 rounded bg-bg-hover text-text-tertiary flex-shrink-0">
                {t('panel.plugins.disabled')}
              </span>
            )}
          </div>
          {commandPreview && (
            <div
              className="text-2xs text-text-tertiary truncate mt-0.5 font-mono"
              title={commandPreview}
            >
              {commandPreview}
            </div>
          )}
        </div>
        <Icon.ChevronDown
          width={14}
          height={14}
          className={`text-text-tertiary flex-shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
        />
      </div>

      {/* 第二行：状态徽标 + 工具数 + 操作 */}
      <div className="flex items-center gap-1 px-2.5 pb-2 -mt-0.5">
        <span className={`text-2xs px-1.5 py-0.5 rounded ${meta.badge} flex-shrink-0`}>
          {meta.label}
        </span>
        {isConnected && (
          <span className="text-2xs text-text-tertiary flex-shrink-0">
            {t('panel.plugins.toolsCount', { count: mcp.toolCount })}
          </span>
        )}
        {mcp.status === 'error' && mcp.lastError && (
          <Tooltip label={mcp.lastError}>
            <span className="text-2xs text-danger flex-shrink-0 truncate max-w-[200px]">
              · {mcp.lastError}
            </span>
          </Tooltip>
        )}
        <div className="flex items-center gap-0.5 ml-auto">
          {isConnected ? (
            <IconBtn
              title={t('panel.plugins.disconnect')}
              onClick={onDisconnect}
              disabled={isBusy}
              busy={busy === 'disconnecting'}
              busyText={t('panel.plugins.disconnecting')}
            >
              <Icon.Power width={16} height={16} />
            </IconBtn>
          ) : (
            <IconBtn
              title={
                mcp.enabled
                  ? mcp.status === 'connecting'
                    ? t('panel.plugins.connecting')
                    : t('panel.plugins.connect')
                  : t('panel.plugins.disabledConnect')
              }
              onClick={onConnect}
              disabled={isBusy || !mcp.enabled || mcp.status === 'connecting'}
              busy={busy === 'connecting'}
              busyText={t('panel.plugins.status.connecting')}
            >
              <Icon.Play width={16} height={16} />
            </IconBtn>
          )}
          <IconBtn title={t('panel.plugins.edit')} onClick={onEdit} disabled={isBusy}>
            <Icon.Edit width={16} height={16} />
          </IconBtn>
          <IconBtn title={t('panel.plugins.delete')} onClick={onDelete} disabled={isBusy} danger>
            <Icon.Trash width={16} height={16} />
          </IconBtn>
        </div>
      </div>

      {/* 展开：工具列表 / 详细字段 */}
      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-border-subtle space-y-2">
          {isConnected && mcp.tools.length > 0 && (
            <div>
              <div className="text-2xs text-text-tertiary mb-1.5">{t('panel.plugins.discoveredTools')}</div>
              <div className="flex flex-wrap gap-1">
                {toolNames.map((name) => (
                  <span
                    key={name}
                    className="text-2xs px-1.5 py-0.5 rounded bg-bg-hover text-text-secondary font-mono"
                  >
                    {name}
                  </span>
                ))}
                {moreCount > 0 && (
                  <span className="text-2xs px-1.5 py-0.5 rounded bg-bg-hover text-text-tertiary">
                    +{moreCount}
                  </span>
                )}
              </div>
            </div>
          )}
          {mcp.transport === 'stdio' && (
            <div className="text-2xs text-text-tertiary space-y-0.5">
              <div>
                <span className="text-text-secondary">Command</span> ·{' '}
                <span className="font-mono">{mcp.command ?? '—'}</span>
              </div>
              {mcp.args && mcp.args.length > 0 && (
                <div>
                  <span className="text-text-secondary">Args</span> ·{' '}
                  <span className="font-mono">{mcp.args.join(' ')}</span>
                </div>
              )}
            </div>
          )}
          {mcp.transport === 'sse' && (
            <div className="text-2xs text-text-tertiary">
              <span className="text-text-secondary">URL</span> ·{' '}
              <span className="font-mono">{mcp.url ?? '—'}</span>
            </div>
          )}
          {mcp.env && Object.keys(mcp.env).length > 0 && (
            <div className="text-2xs text-text-tertiary">
              <span className="text-text-secondary">Env</span> ·{' '}
              <span className="font-mono">
                {t('panel.plugins.envCount', { count: Object.keys(mcp.env).length })}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/* ============================================================
 * IconBtn — 行内图标按钮（沿用 SkillsPanel 风格）
 * ============================================================ */
function IconBtn({
  title,
  onClick,
  disabled,
  danger,
  busy,
  busyText,
  children,
}: {
  title: string
  onClick: (e: React.MouseEvent) => void
  disabled?: boolean
  danger?: boolean
  busy?: boolean
  busyText?: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={busy ? busyText ?? title : title}
      aria-label={title}
      disabled={disabled || busy}
      onClick={(e) => {
        e.stopPropagation()
        if (!disabled && !busy) onClick(e)
      }}
      className={`w-7 h-7 flex items-center justify-center rounded-md transition-colors ${
        disabled || busy
          ? 'text-text-tertiary opacity-40 cursor-not-allowed'
          : danger
            ? 'text-text-tertiary hover:text-danger hover:bg-danger-soft'
            : 'text-text-tertiary hover:text-text-primary hover:bg-bg-hover'
      }`}
    >
      {children}
    </button>
  )
}