/* ============================================================
 * ArkWork — QuickOpen (v0.7.0 F714)
 * ⌘P 文件快速切换：模糊匹配文件名，回车在 PreviewWindow 浮窗打开
 * - 输入框 + 文件列表（路径分组简显示）
 * - 键盘：↑↓ 导航 / ⏎ 打开 / Esc 关闭
 * - 选中文件后调用 store.openPreview 弹浮窗
 * ============================================================ */
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../icons'
import { useStore } from '../store'
import { Kbd } from './ui'
import type { FsNode } from '../types'

/** 收集文件树中所有文件节点 */
function collectFiles(nodes: FsNode[]): FsNode[] {
  const out: FsNode[] = []
  const walk = (list: FsNode[]) => {
    for (const n of list) {
      if (n.type === 'file') out.push(n)
      if (n.children) walk(n.children)
    }
  }
  walk(nodes)
  return out
}

/** 评分：连续匹配权重更高（粗略实现） */
function fuzzyScore(label: string, query: string): number {
  if (!query) return 0
  const l = label.toLowerCase()
  const q = query.toLowerCase()
  if (l.includes(q)) {
    // 完整子串匹配加分；开头匹配再加分
    let score = 100 - l.indexOf(q)
    if (l.startsWith(q)) score += 200
    return score
  }
  // 模糊匹配分数
  let qi = 0
  let consecutive = 0
  let maxConsec = 0
  for (let i = 0; i < l.length && qi < q.length; i++) {
    if (l[i] === q[qi]) {
      qi++
      consecutive++
      maxConsec = Math.max(maxConsec, consecutive)
    } else {
      consecutive = 0
    }
  }
  return qi === q.length ? 10 + maxConsec * 5 : -1
}

export function QuickOpen() {
  const { t } = useTranslation()
  const open = useStore((s) => s.quickOpenOpen)
  const setOpen = useStore((s) => s.setQuickOpenOpen)
  const files = useStore((s) => s.files)
  const openPreview = useStore((s) => s.openPreview)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)

  // 关闭时重置
  useEffect(() => {
    if (!open) {
      setQuery('')
      setActiveIndex(0)
    }
  }, [open])

  // 全部文件扁平化
  const allFiles = useMemo(() => collectFiles(files), [files])

  // 过滤 + 排序
  const filtered = useMemo(() => {
    const q = query.trim()
    if (!q) {
      // 无 query：最近修改在前（FsNode 没有时间戳，按名称）
      return allFiles.slice(0, 50)
    }
    return allFiles
      .map((f) => ({ f, score: fuzzyScore(f.name, q) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 50)
      .map((x) => x.f)
  }, [allFiles, query])

  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  // 键盘导航
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((i) => Math.min(i + 1, filtered.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const target = filtered[activeIndex]
        if (target) {
          void openPreview(target.path)
          setOpen(false)
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, filtered, activeIndex, openPreview, setOpen])

  if (!open) return null

  // 简单的目录前缀提取（取父目录）
  const dirOf = (path: string): string => {
    const idx = path.lastIndexOf('/')
    return idx > 0 ? path.slice(0, idx) : ''
  }

  return (
    <div
      className="fixed inset-0 z-[55] flex items-start justify-center pt-[10vh] bg-black/40 backdrop-blur-sm"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-[560px] max-h-[60vh] bg-bg-overlay border border-border-default rounded-lg shadow-panel flex flex-col overflow-hidden scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 搜索框 */}
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border-subtle">
          <Icon.Search width={16} height={16} className="text-text-tertiary" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('quickopen.placeholder')}
            className="flex-1 text-sm text-text-primary placeholder-text-tertiary bg-transparent outline-none"
          />
          <Kbd>Esc</Kbd>
        </div>

        {/* 结果列表 */}
        <div className="flex-1 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-text-tertiary">
              {allFiles.length === 0 ? t('quickopen.noFiles') : t('quickopen.noMatch')}
            </div>
          ) : (
            filtered.map((f, idx) => {
              const active = idx === activeIndex
              const dir = dirOf(f.path)
              return (
                <button
                  key={f.path}
                  onMouseEnter={() => setActiveIndex(idx)}
                  onClick={() => {
                    void openPreview(f.path)
                    setOpen(false)
                  }}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors ${
                    active ? 'bg-bg-active text-text-primary' : 'text-text-secondary hover:bg-bg-hover'
                  }`}
                >
                  <Icon.File width={16} height={16} className="text-text-tertiary flex-shrink-0" />
                  <span className="text-sm truncate flex-shrink min-w-0">{f.name}</span>
                  {dir && (
                    <span className="text-2xs text-text-tertiary truncate ml-auto pl-2">
                      {dir}
                    </span>
                  )}
                  {active && (
                    <span className="text-2xs text-accent flex-shrink-0">
                      <Kbd>⏎</Kbd>
                    </span>
                  )}
                </button>
              )
            })
          )}
        </div>

        {/* 底部 */}
        <div className="flex items-center gap-3 px-3 py-1.5 border-t border-border-subtle text-2xs text-text-tertiary">
          <span className="flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            {t('quickopen.navigate')}
          </span>
          <span className="flex items-center gap-1">
            <Kbd>⏎</Kbd>
            {t('quickopen.openInWindow')}
          </span>
          <span className="flex items-center gap-1">
            <Kbd>Esc</Kbd>
            {t('quickopen.close')}
          </span>
          <span className="ml-auto">
            {t('quickopen.fileCount', { shown: filtered.length, total: allFiles.length })}
          </span>
        </div>
      </div>
    </div>
  )
}
