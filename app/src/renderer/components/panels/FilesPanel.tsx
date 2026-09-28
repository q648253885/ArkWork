/* ============================================================
 * ArkWork — FilesPanel (v0.7.0)
 * 文件树面板：复用 FilesView 逻辑，重构为干净面板版
 * - 顶部：模糊过滤搜索
 * - 树视图：展开/折叠，点击文件 → 预览浮窗
 * - 右键菜单：重命名 / 删除 / 复制路径 / 插入为上下文
 * - 状态徽标：M / A / D
 * - B11/P1：全部展开/收起 + 深层目录懒加载（fs:list-dir）；默认展开顶层、
 *   收起 COLLAPSED_DIRS；node_modules/.git/.arkwork 主进程侧已 ignore 不下发
 * ============================================================ */
import { useMemo, useRef, useState } from 'react'
import { Icon } from '../../icons'
import { useStore } from '../../store'
import { ark } from '../../ipc/client'
import { FILE_STATUS_COLOR } from '../../constants'
import type { FsNode } from '../../types'
import { Tooltip, EmptyState } from '../ui'
import { useTranslation } from 'react-i18next'
// 默认收起的目录名（仅影响「默认是否展开」的判定）
const COLLAPSED_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build'])

export function FilesPanel() {
  const { t } = useTranslation()
  const files = useStore((s) => s.files)
  const selectedFile = useStore((s) => s.selectedFile)
  const setSelectedFile = useStore((s) => s.setSelectedFile)
  const refreshFiles = useStore((s) => s.refreshFiles)
  const pushToast = useStore((s) => s.pushToast)
  // v0.36.0 B11/P1：展开状态收进 fsSlice（双挂载不再分叉）+ 懒加载缓存
  const treeExpanded = useStore((s) => s.treeExpanded)
  const toggleTreeNode = useStore((s) => s.toggleTreeNode)
  const expandAllTreeNodes = useStore((s) => s.expandAllTreeNodes)
  const collapseAllTreeNodes = useStore((s) => s.collapseAllTreeNodes)
  const dirChildren = useStore((s) => s.dirChildren)
  const dirLoading = useStore((s) => s.dirLoading)
  const loadTreeDir = useStore((s) => s.loadTreeDir)
  const invalidateDirCache = useStore((s) => s.invalidateDirCache)

  const [query, setQuery] = useState('')

  const stats = useMemo(() => countFiles(files), [files])
  const filtering = query.trim() !== ''
  const visible = useMemo(() => filterTree(files, query), [files, query])

  return (
    <div className="flex flex-col h-full">
      {/* 头部：标题 + 统计 + 全部展开/收起 + 刷新 */}
      <div className="flex items-center gap-2 px-3 h-9 flex-shrink-0 border-b border-border-subtle">
        <span className="text-sm text-text-primary font-medium">{t('panel.files.title')}</span>
        <span className="text-2xs text-text-tertiary tabular">
          {t('panel.files.stats', { files: stats.files, folders: stats.folders })}
        </span>
        {/* v0.36.0 B11/P1：全部展开 = 已加载树 BFS；全部收起 = 清空展开表。
            不做无限递归拉取全仓库（node_modules 类目录规模不可控）。 */}
        <Tooltip label={t('panel.files.expandAll')} desc={t('panel.files.expandAllDesc')}>
          <button
            onClick={expandAllTreeNodes}
            aria-label={t('panel.files.expandAll')}
            className="ml-auto p-1 rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-colors"
          >
            <Icon.ChevronsDown width={16} height={16} />
          </button>
        </Tooltip>
        <Tooltip label={t('panel.files.collapseAll')} desc={t('panel.files.collapseAllDesc')}>
          <button
            onClick={collapseAllTreeNodes}
            aria-label={t('panel.files.collapseAll')}
            className="p-1 rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-colors"
          >
            <Icon.ChevronsUp width={16} height={16} />
          </button>
        </Tooltip>
<Tooltip label={t('panel.files.refreshTooltip')}>
        <button
          onClick={() => {
            invalidateDirCache()
            void refreshFiles()
          }}
          className="p-1 rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-colors"

        >
          <Icon.Refresh width={16} height={16} />
        </button>
</Tooltip>
      </div>

      {/* 搜索框 */}
      <div className="px-2.5 py-2 flex-shrink-0">
        <div className="relative">
          <Icon.Search
            width={12}
            height={12}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('panel.files.searchPlaceholder')}
            className="w-full pl-7 pr-2 py-1 text-xs bg-bg-surface border border-border-subtle rounded-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent transition-colors"
          />
        </div>
      </div>

      {/* 树 */}
      <div className="flex-1 overflow-y-auto py-1.5">
        {files.length === 0 ? (
          <EmptyState
            icon={<Icon.Folder width={22} height={22} />}
            title={t('panel.files.empty.title')}
            hint={t('panel.files.empty.hint')}
          />
        ) : visible.length === 0 ? (
          <EmptyState
            icon={<Icon.Search width={22} height={22} />}
            title={t('panel.files.noMatch.title')}
            hint={t('panel.files.noMatch.hint', { query: query.trim() })}
          />
        ) : (
          visible.map((node) => (
            <FileTreeNode
              key={node.path}
              node={node}
              depth={0}
              expanded={treeExpanded}
              onToggle={toggleTreeNode}
              dirChildren={dirChildren}
              dirLoading={dirLoading}
              onLoadDir={(path) => void loadTreeDir(path)}
              selectedPath={selectedFile}
              forceOpen={filtering}
              onSelect={(path) => void setSelectedFile(path)}
              onToast={(msg, type = 'success') =>
                pushToast({ type, message: msg, duration: 2500 })
              }
            />
          ))
        )}
      </div>
    </div>
  )
}

/* ============================================================
 * FileTreeNode — 递归树节点
 * ============================================================ */
function FileTreeNode({
  node,
  depth,
  expanded,
  onToggle,
  dirChildren,
  dirLoading,
  onLoadDir,
  selectedPath,
  onSelect,
  forceOpen,
  onToast,
}: {
  node: FsNode
  depth: number
  expanded: Record<string, boolean>
  onToggle: (path: string, defaultOpen: boolean) => void
  /** B11/P1：懒加载目录缓存（path → 单层子项） */
  dirChildren: Record<string, FsNode[]>
  dirLoading: Record<string, boolean>
  /** 展开一个 children 未加载（undefined）的目录时触发 */
  onLoadDir: (path: string) => void
  selectedPath: string | null
  onSelect: (path: string) => void
  forceOpen: boolean
  onToast: (msg: string, type?: 'success' | 'warning' | 'danger') => void
}) {
  const { t } = useTranslation()
  // 默认语义与旧版一致：顶层目录展开、COLLAPSED_DIRS（dist/build/.next 等）收起。
  const defaultOpen = depth < 1 && !COLLAPSED_DIRS.has(node.name)
  const isOpen = forceOpen || (expanded[node.path] ?? defaultOpen)
  const isSelected = selectedPath === node.path
  const [menuOpen, setMenuOpen] = useState(false)
  // v0.9.1：行内重命名状态
  const [renaming, setRenaming] = useState(false)
  const [renameDraft, setRenameDraft] = useState(node.name)
  // v0.36.2（D113）：双击的第二击不再取反 —— 双击 = 两次 click = 取反两次 = 净零，
  // 观感即「点了没反应，要再点一次才生效」。
  const lastToggleAt = useRef(0)
  const refreshFiles = useStore((s) => s.refreshFiles)
  const invalidateDirCache = useStore((s) => s.invalidateDirCache)
  const confirm = useStore((s) => s.confirm)

  // v0.9.1：提交重命名（Enter 提交 / Esc 取消 / 失焦提交）
  const commitRename = async () => {
    const newName = renameDraft.trim()
    setRenaming(false)
    if (!newName || newName === node.name) {
      setRenameDraft(node.name)
      return
    }
    try {
      await ark.fs.rename(node.path, newName)
      onToast(t('panel.files.renamed', { name: newName }))
      invalidateDirCache()
      await refreshFiles()
    } catch (err) {
      onToast(t('panel.files.renameFailed', { message: (err as Error).message }), 'danger')
      setRenameDraft(node.name)
    }
  }

  // v0.9.1：删除到系统回收站（可恢复），ConfirmDialog 二次确认
  const handleDelete = async () => {
    const ok = await confirm({
      title: t('panel.files.deleteTitle'),
      body: t('panel.files.deleteBody', { name: node.name }),
      confirmLabel: t('panel.files.moveToTrash'),
      danger: true,
    })
    if (!ok) return
    try {
      await ark.fs.delete(node.path)
      onToast(t('panel.files.movedToTrash', { name: node.name }))
      invalidateDirCache()
      await refreshFiles()
    } catch (err) {
      onToast(t('panel.files.deleteFailed', { message: (err as Error).message }), 'danger')
    }
  }

  if (node.type === 'folder') {
    // B11/P1：子项优先取节点自带 children；未加载（undefined）时回落懒加载缓存。
    // children === [] 表示「已加载且确认为空目录」——不再触发懒加载。
    const kids = node.children ?? dirChildren[node.path]
    const needsLoad = kids === undefined
    const isLoading = Boolean(dirLoading[node.path])
    const handleToggle = () => {
      if (forceOpen) return // 搜索过滤态下 toggle 无效果，显式 no-op（B11/P1）
      const now = Date.now()
      if (now - lastToggleAt.current < 300) return
      lastToggleAt.current = now
      onToggle(node.path, defaultOpen)
      // 展开一个未加载目录 → 触发单层懒加载
      if (!isOpen && needsLoad) onLoadDir(node.path)
    }
    return (
      <div>
        <button
          onClick={handleToggle}
          aria-expanded={isOpen}
          className="w-full flex items-center gap-1.5 pl-2 pr-2 py-1 text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors"
          style={{ paddingLeft: 8 + depth * 14 }}
        >
          {isOpen ? (
            <Icon.ChevronDown width={16} height={16} className="text-text-tertiary flex-shrink-0" />
          ) : (
            <Icon.ChevronRight width={16} height={16} className="text-text-tertiary flex-shrink-0" />
          )}
          <Icon.Folder
            width={14}
            height={14}
            className={isOpen ? 'text-accent' : 'text-text-secondary'}
          />
          <span className="flex-1 text-left truncate">{node.name}</span>
        </button>
        {isOpen &&
          (isLoading ? (
            <div
              className="py-1 text-2xs text-text-tertiary"
              style={{ paddingLeft: 8 + (depth + 1) * 14 + 22 }}
            >
              {t('panel.files.loading')}
            </div>
          ) : (
            (kids ?? []).map((child) => (
              <FileTreeNode
                key={child.path}
                node={child}
                depth={depth + 1}
                expanded={expanded}
                onToggle={onToggle}
                dirChildren={dirChildren}
                dirLoading={dirLoading}
                onLoadDir={onLoadDir}
                selectedPath={selectedPath}
                onSelect={onSelect}
                forceOpen={forceOpen}
                onToast={onToast}
              />
            ))
          ))}
      </div>
    )
  }

  const statusColor = FILE_STATUS_COLOR[node.status ?? ' '] ?? 'transparent'

  return (
    <div
      onClick={() => onSelect(node.path)}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setMenuOpen(true)
      }}
      className={`group relative w-full flex items-center gap-1.5 pl-2 pr-1.5 py-1 text-sm cursor-pointer transition-colors ${
        isSelected
          ? 'bg-bg-active text-text-primary'
          : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
      }`}
      style={{ paddingLeft: 8 + depth * 14 + 22 }}
      title={node.path}
    >
      <Icon.File width={16} height={16} className="text-text-tertiary flex-shrink-0" />
      {/* v0.9.1：行内重命名输入框（Enter 提交 / Esc 取消） */}
      {renaming ? (
        <input
          autoFocus
          value={renameDraft}
          onChange={(e) => setRenameDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') void commitRename()
            else if (e.key === 'Escape') {
              setRenaming(false)
              setRenameDraft(node.name)
            }
          }}
          onBlur={() => void commitRename()}
          className="flex-1 min-w-0 px-1 py-0 text-sm bg-bg-overlay border border-accent rounded text-text-primary outline-none"
        />
      ) : (
        <span
          className="flex-1 text-left truncate"
          onDoubleClick={(e) => {
            // v0.9.1：双击文件名也可进入重命名（对齐 Trae/VSCode 习惯）
            e.stopPropagation()
            setRenaming(true)
          }}
        >
          {node.name}
        </span>
      )}

      {/* 非 hover：行数 / 大小 / 状态徽标 */}
      <span className="ml-auto flex items-center gap-1.5 group-hover:hidden flex-shrink-0">
        {node.lines != null && (
          <span className="text-2xs text-text-tertiary tabular">{node.lines}L</span>
        )}
        {node.size != null && (
          <span className="text-2xs text-text-tertiary tabular">{formatSize(node.size)}</span>
        )}
        {node.status && node.status !== ' ' && (
          <span className="text-2xs font-semibold w-3 text-center" style={{ color: statusColor }}>
            {node.status}
          </span>
        )}
      </span>

      {/* hover：操作按钮 */}
      <span className="ml-auto hidden group-hover:flex items-center gap-0.5 flex-shrink-0">
        <RowAction
          title={t('panel.files.copyPath')}
          desc={t('panel.files.copyPathDesc')}
          onClick={async (e) => {
            e.stopPropagation()
            try {
              await navigator.clipboard.writeText(node.path)
              onToast(t('panel.files.pathCopied'))
            } catch {
              onToast(t('panel.files.copyFailed'), 'danger')
            }
          }}
        >
          <Icon.Copy width={16} height={16} />
        </RowAction>
        <RowAction
          title={t('panel.files.revealInFolder')}
          desc={t('panel.files.revealInFolderDesc')}
          onClick={(e) => {
            e.stopPropagation()
            void ark.fs.revealInFolder(node.path)
          }}
        >
          <Icon.ExternalLink width={16} height={16} />
        </RowAction>
      </span>

      {/* 右键菜单 */}
      {menuOpen && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setMenuOpen(false)} />
          <div className="absolute right-1 top-full mt-0.5 z-30 bg-bg-overlay border border-border-default rounded-md shadow-panel scale-in py-1 min-w-[160px]">
            <MenuItem
              icon={<Icon.Edit width={16} height={16} />}
              label={t('panel.files.rename')}
              onClick={() => {
                setMenuOpen(false)
                setRenaming(true)
              }}
            />
            <MenuItem
              icon={<Icon.Trash width={16} height={16} />}
              label={t('panel.files.delete')}
              danger
              onClick={() => {
                setMenuOpen(false)
                void handleDelete()
              }}
            />
            <div className="my-1 border-t border-border-subtle" />
            <MenuItem
              icon={<Icon.Copy width={16} height={16} />}
              label={t('panel.files.copyPath')}
              onClick={async () => {
                setMenuOpen(false)
                try {
                  await navigator.clipboard.writeText(node.path)
                  onToast(t('panel.files.pathCopied'))
                } catch {
                  onToast(t('panel.files.copyFailed'), 'danger')
                }
              }}
            />
            <MenuItem
              icon={<Icon.Paperclip width={16} height={16} />}
              label={t('panel.files.insertAsContext')}
              onClick={() => {
                setMenuOpen(false)
                // v0.9.1：真实接入 Composer file chips（原假成功 toast）
                window.dispatchEvent(
                  new CustomEvent('composer:attach-file', {
                    detail: { path: node.path, name: node.name },
                  }),
                )
              }}
            />
          </div>
        </>
      )}
    </div>
  )
}

function RowAction({
  title,
  desc,
  onClick,
  children,
}: {
  title: string
  desc?: string
  onClick: (e: React.MouseEvent) => void
  children: React.ReactNode
}) {
  return (
    <Tooltip label={title} desc={desc} placement="left">
      <button
        onClick={onClick}
        aria-label={title}
        className="p-1 rounded-md text-text-tertiary hover:bg-bg-active hover:text-text-primary transition-colors"
      >
        {children}
      </button>
    </Tooltip>
  )
}

function MenuItem({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-xs transition-colors ${
        danger
          ? 'text-danger hover:bg-danger-soft'
          : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
      }`}
    >
      {icon}
      {label}
    </button>
  )
}

/* ============================================================
 * 辅助函数
 * ============================================================ */

/** 按文件名模糊过滤树 */
function filterTree(nodes: FsNode[], query: string): FsNode[] {
  const q = query.trim().toLowerCase()
  if (!q) return nodes
  const out: FsNode[] = []
  for (const n of nodes) {
    if (n.type === 'file') {
      if (n.name.toLowerCase().includes(q)) out.push(n)
    } else {
      if (n.name.toLowerCase().includes(q)) {
        out.push(n) // 文件夹名命中 → 保留整棵子树
      } else {
        const kids = filterTree(n.children ?? [], query)
        if (kids.length > 0) out.push({ ...n, children: kids })
      }
    }
  }
  return out
}

function countFiles(nodes: FsNode[]): { files: number; folders: number } {
  let files = 0
  let folders = 0
  for (const n of nodes) {
    if (n.type === 'folder') {
      folders++
      if (n.children) {
        const sub = countFiles(n.children)
        files += sub.files
        folders += sub.folders
      }
    } else {
      files++
    }
  }
  return { files, folders }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`
}
