/**
 * ArkWork — 任务面板（TaskPanel）
 *
 * 依据：docs/versions/v0.30.0/03-interaction.md §P1
 *       prototype/page-01-task-panel.html（已冻结的视觉基准）
 *
 * 这个面板要回答设计稿定义的**三个必答问题**：
 *   ① 它在做什么？   → 顶部 in_progress 行 + 状态图标
 *   ② 做到哪了？     → 树 / DAG + 进度计数 + 预算
 *   ③ 凭什么说做完了？→ Evidence 查看器（点任意 completed 节点展开证据链）
 *
 * ★ 与原 TodoPanel 的关系（重要）：
 *   本组件是 TodoPanel 的**原位升级**，不是替代品 ——
 *   当任务没有 TaskGraph（Tier 0/1 轻量任务、尚未建图的老任务）时，
 *   直接回落渲染 `<TodoPanel />`，**行为与 v0.29 完全一致**。
 *   这保证了"其他核心功能不变"在 UI 层的落地。
 *
 * 五态（03-interaction.md §P1）：
 *   默认 = 有图有数据 ｜ 加载 = 骨架行 ｜ 空 = 无图 → 回落 TodoPanel 或空态
 *   错误 = 图损坏（拒绝加载 + 错误字段 + 快照恢复入口）｜ 成功 = 全部 terminal
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Icon } from '../../icons'
import { useStore } from '../../store'
import type { GraphNotice, GraphRow, NodeStatus, ReplanPatch } from '@shared/types/ipc'
import { tierLabel } from '@shared/types/graph'
import { sanitizeTierReason } from '../../utils/tier-reason'
import { buildRoundIndex } from '../../utils/round-filter'
import { skippedCountOf, tokensLabelOf } from '../../utils/all-done'
import { TodoPanel } from './TodoPanel'
import { useGraph } from '../graph/useGraph'
import { GraphNotices } from '../graph/GraphNotices'
import { NodeRow } from '../graph/NodeRow'
import { EvidenceDrawer } from '../graph/EvidenceDrawer'
import { ConvergeCard, NeedsHumanCard, ReplanCard, CardButton, noticeToCard, type OpenedCard } from '../graph/ActionCards'
import { AC_META, formatTokens, statusMeta } from '../graph/graphMeta'
import { EmptyState } from '../ui'

/** 窄面板阈值：低于此宽度隐藏元信息（保留状态图标 + key + 标题） */
const NARROW_WIDTH = 360

/**
 * 筛选条 4 档（03-interaction.md §P1「筛选条 4 档映射」）。
 * 计数与过滤都基于 `snapshot.rows`（已剔除 goal），保证与进度分母同源。
 */
// v0.43.0（R4）：两 Tab —— 本轮任务（round === 当前轮次）/ 全部任务
type FilterKey = 'round' | 'all'
const FILTER_KEYS: readonly FilterKey[] = ['round', 'all']

/**
 * 不受折叠开关影响的状态（03-interaction.md §P1「边界交互」）。
 * needs_human 恒在置顶区；failed 混在树体里，二者都「永不自动折叠」。
 */
const NEVER_FOLD: ReadonlySet<NodeStatus> = new Set<NodeStatus>(['needs_human', 'failed'])

export function TaskPanel() {
  const { t } = useTranslation()
  const selectedTaskId = useStore((s) => s.selectedTaskId)
  const task = useStore((s) => s.tasks.find((x) => x.id === s.selectedTaskId))
  const createToast = useStore((s) => s.pushToast)
  const createTask = useStore((s) => s.createTask)
  const setActiveActivity = useStore((s) => s.setActiveActivity)

  const g = useGraph(selectedTaskId)

  /** 显式折叠的节点集合：默认为空 = 初始全展开（03-interaction.md §P1「默认全展开」） */
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [foldAll, setFoldAll] = useState(false)
  const [drawerNodeId, setDrawerNodeId] = useState<string | null>(null)
  const [card, setCard] = useState<OpenedCard | null>(null)
  const [menu, setMenu] = useState<{ nodeId: string; x: number; y: number } | null>(null)
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [width, setWidth] = useState(NARROW_WIDTH)
  const rootRef = useRef<HTMLDivElement>(null)
  /** 筛选条当前档位：**默认「本轮任务」**（用户诉求：先看这一轮在做什么） */
  const [filter, setFilter] = useState<FilterKey>('round')
  /** 「定位▾」下拉是否展开 */
  const [locateOpen, setLocateOpen] = useState(false)

  /* ---------------- 面板宽度（窄面板降级） ---------------- */
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? NARROW_WIDTH
      setWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const narrow = width < NARROW_WIDTH

  const rows = g.snapshot?.rows ?? []
  const rowById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows])

  /** 「折叠 / 展开全部子树」：折叠时全部折叠；再次点击清空手动折叠、恢复全展开 */
  const toggleFoldAll = useCallback(() => {
    setFoldAll((v) => {
      if (!v) setCollapsedIds(new Set())
      return !v
    })
  }, [])

  /* ---------------- needs_human 置顶（最高视觉优先级） ---------------- */
  const waitingRows = useMemo(() => rows.filter((r) => r.status === 'needs_human'), [rows])

  /* ---------------- v0.43.0（R4）：轮次判据（账本为准，见 utils/round-filter.ts） ---------------- */
  // 账本快照 = 唯一真相源（`file.round` / `item.round`）；planItems 只是派生镜像兜底。
  const ledger = useStore((s) => (s.selectedTaskId ? s.ledgerSnapshots[s.selectedTaskId] : undefined))
  const roundIndex = useMemo(
    () => buildRoundIndex({ ledger, planItems: task?.planItems }),
    [ledger, task?.planItems],
  )
  const currentRound = roundIndex.current
  /** 行的轮次；null = 无法归属（历史行）→ 只进「全部任务」 */
  const rowRound = useCallback((r: GraphRow): number | null => roundIndex.roundOf(r), [roundIndex])

  /* ---------------- 两 Tab 计数 ---------------- */
  const filterCounts = useMemo<Record<FilterKey, number>>(
    () => ({ round: rows.filter((r) => rowRound(r) === currentRound).length, all: rows.length }),
    [rows, rowRound, currentRound],
  )

  /* ---------------- 「定位」候选：needs_human / in_progress / verifying ---------------- */
  const locateRows = useMemo(
    () => rows.filter((r) => r.status === 'needs_human' || r.status === 'in_progress' || r.status === 'verifying'),
    [rows],
  )

  // 树体：始终剔除 needs_human（已在置顶区渲染）；「本轮任务」= 当前轮次的行
  const visibleRows = useMemo(
    () =>
      rows.filter(
        (r) => r.status !== 'needs_human' && (filter === 'all' || rowRound(r) === currentRound),
      ),
    [rows, filter, rowRound, currentRound],
  )

  /** 单行是否处于折叠态：有子节点、非 neverFold、且（全局折叠 或 手动折叠） */
  const rowCollapsedOf = useCallback(
    (r: GraphRow): boolean =>
      r.hasChildren && !NEVER_FOLD.has(r.status) && (foldAll || collapsedIds.has(r.id)),
    [foldAll, collapsedIds],
  )

  /** 被任一「折叠祖先」遮住的行：折叠要真正隐藏后代，而不是只把父行变细 */
  const hiddenIds = useMemo(() => {
    const graph = g.graph
    const hidden = new Set<string>()
    if (!graph) return hidden
    for (const r of visibleRows) {
      let p = graph.nodes[r.id]?.parentId
      let guard = 0
      while (p && guard++ < 32) {
        const pr = rowById.get(p)
        if (pr && rowCollapsedOf(pr)) {
          hidden.add(r.id)
          break
        }
        p = graph.nodes[p]?.parentId
      }
    }
    return hidden
  }, [g.graph, visibleRows, rowById, rowCollapsedOf])

  const notices = useMemo(
    () => (g.snapshot?.notices ?? []).filter((n) => !dismissed.has(`${n.kind}-${n.refId ?? n.text}`)),
    [g.snapshot?.notices, dismissed],
  )

  /* ---------------- 动作 ---------------- */
  const toggle = useCallback((id: string) => {
    setFoldAll(false)
    setCollapsedIds((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }, [])

  /** 「定位」：展开祖先链 → 选中 → 滚动到可视区（并高亮） */
  const locateTo = useCallback(
    (id: string) => {
      setLocateOpen(false)
      setFilter('all')
      setSelectedId(id)
      const graph = g.graph
      if (graph) {
        const chain = new Set<string>([id])
        let cur = graph.nodes[id]?.parentId
        let guard = 0
        while (cur && guard++ < 32) {
          chain.add(cur)
          cur = graph.nodes[cur]?.parentId
        }
        setFoldAll(false)
        setCollapsedIds((s) => {
          const n = new Set(s)
          for (const c of chain) n.delete(c)
          return n
        })
      }
      requestAnimationFrame(() => {
        rootRef.current?.querySelector<HTMLElement>(`[data-node-id="${id}"]`)?.scrollIntoView({ block: 'nearest' })
      })
    },
    [g.graph],
  )

  const openDetail = useCallback(
    (id: string) => {
      const row = rows.find((r) => r.id === id)
      // 只有 completed 节点才有证据链可看；其余节点也允许打开（元信息 / AC）
      setDrawerNodeId(id)
      void row
    },
    [rows],
  )

  const openCard = useCallback(
    (notice: GraphNotice) => {
      const c = noticeToCard(notice, g.pendingPatches)
      if (c) setCard(c)
      else setDismissed((s) => new Set(s).add(`${notice.kind}-${notice.refId ?? notice.text}`))
    },
    [g.pendingPatches],
  )

  const drawerNode = useMemo(
    () => (drawerNodeId ? g.graph?.nodes[drawerNodeId] ?? null : null),
    [drawerNodeId, g.graph],
  )

  const labelOf = useCallback(
    (id: string) => {
      const n = g.graph?.nodes[id]
      return n ? `${n.key ? `${n.key} ` : ''}${n.title}` : id
    },
    [g.graph],
  )

  /** 通知 toast（沿用既有 ToastLayer） */
  const toast = useCallback(
    (msg: string) => {
      try {
        createToast?.({ type: 'success', message: msg, duration: 2000 })
      } catch {
        /* toast 失败不影响主流程 */
      }
    },
    [createToast],
  )

  /* ---------------- 键盘导航（↑↓ 移动 / ←→ 折叠展开 / Enter 打开） ---------------- */
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const list = [...waitingRows, ...visibleRows]
      if (list.length === 0) return
      const idx = list.findIndex((r) => r.id === selectedId)
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedId(list[Math.min(list.length - 1, idx + 1)]?.id ?? null)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedId(list[Math.max(0, idx - 1)]?.id ?? null)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        if (idx >= 0) {
          setFoldAll(false)
          setCollapsedIds((s) => {
            const n = new Set(s)
            n.delete(list[idx].id)
            return n
          })
        }
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        if (idx >= 0)
          setCollapsedIds((s) => {
            const n = new Set(s)
            n.add(list[idx].id)
            return n
          })
      } else if (e.key === 'Enter' && idx >= 0) {
        e.preventDefault()
        openDetail(list[idx].id)
      }
    },
    [waitingRows, visibleRows, selectedId, openDetail],
  )

  /* ============================================================
   * 分支 1：无图 → 回落既有 TodoPanel（行为与 v0.29 一致）
   * ============================================================ */
  if (!g.loading && !g.error && g.snapshot === null) {
    if (!selectedTaskId) {
      return (
        <EmptyState
          icon={<span className="text-2xl leading-none">○</span>}
          title={t('taskPanel.emptyTitle')}
          action={
            <div className="flex flex-wrap items-center justify-center gap-2">
              <CardButton variant="primary" onClick={() => void createTask({ title: '', text: '' })}>
                {t('taskPanel.emptyNewFromTemplate')}
              </CardButton>
              <CardButton onClick={() => setActiveActivity('tasks')}>
                {t('taskPanel.emptyViewHistory')}
              </CardButton>
            </div>
          }
        />
      )
    }
    return <TodoPanel />
  }

  /* ============================================================
   * 分支 2：图损坏（F20 降级态 —— 拒绝加载，不做部分渲染）
   * ============================================================ */
  if (g.broken || (g.error && g.error.code === 'SCHEMA_INVALID')) {
    return (
      <div className="flex h-full flex-col overflow-hidden" ref={rootRef}>
        <PanelHeader
          snapshot={null}
          narrow={narrow}
          foldAll={foldAll}
          onToggleFoldAll={toggleFoldAll}
          filter={filter}
          setFilter={setFilter}
          filterCounts={filterCounts}
          locateRows={locateRows}
          locateOpen={locateOpen}
          setLocateOpen={setLocateOpen}
          onLocate={locateTo}
        />
        <div className="flex-1 overflow-y-auto p-3">
          <div className="rounded-md border border-danger bg-danger-soft p-3">
            <h4 className="mb-2 text-sm font-semibold">{t('taskPanel.brokenTitle')}</h4>
            <div className="mb-2 break-all rounded-sm bg-bg-base p-2 font-mono text-2xs leading-[18px] text-text-secondary">
              {g.error?.message}
            </div>
            <p className="mb-3 text-xs leading-[18px] text-text-secondary">{g.error?.hint}</p>
            <div className="flex flex-wrap gap-2">
              <CardButton variant="primary" onClick={() => void g.restoreSnapshot('')}>
                {t('taskPanel.restoreSnapshot')}
              </CardButton>
              {/* v0.30.1 F3-2：诚实降级 —— 只读渲染视图属新功能，本版不假承诺，禁用 + 说明 */}
              <CardButton
                disabled
                onClick={() => {}}
                title={t('taskPanel.readOnlyOpenDisabledNote')}
              >
                {t('taskPanel.readOnlyOpen')}
              </CardButton>
              <CardButton
                onClick={() => {
                  g.clearError()
                  void g.refresh()
                }}
              >
                {t('taskPanel.retryLoad')}
              </CardButton>
            </div>
            <p className="mt-2 text-2xs leading-[16px] text-text-tertiary">
              {t('taskPanel.readOnlyOpenDisabledNote')}
            </p>
            <p className="mt-2 text-2xs text-text-tertiary">{t('taskPanel.brokenNote')}</p>
          </div>
        </div>
      </div>
    )
  }

  const snap = g.snapshot
  const allTerminal =
    !!snap && snap.progress.total > 0 && snap.progress.done === snap.progress.total
  const pendingPatch: ReplanPatch | undefined = card?.kind === 'replan'
    ? g.pendingPatches.find((p) => p.id === card.patchId)
    : undefined
  // v0.43.1（D217）：完成横幅文案 —— tokens 无数据整段不渲染（此前渲染出无数字的
  // 「· tokens」，根因 = 图快照 tokensUsed 结构性为 0，L-43-04）；账本已跳过项显式补
  // 「含跳过 N」（progressCounts 口径把 skipped 计入「完成」，文案与账本实况对齐）。
  // 统计语义（progressCounts / 头部 12/12）不动，本段只管展示层诚实。
  // ⚠️ 此处**不得**用 useMemo（D218）：本组件在上方有早退 return（轻量图回退
  // `<TodoPanel />` / 图 schema 损坏），早退路径 hook 数更少 → 快照到达后全量
  // 渲染即 React #310「Rendered more hooks than during the previous render」
  // （实机白屏）。纯字符串拼装开销可忽略，用普通派生值。
  const skippedTotal = skippedCountOf(ledger?.items)
  let allDoneNoticeText: string | undefined
  if (snap && allTerminal) {
    const tokensLabel = tokensLabelOf(snap.budget.tokensUsed, formatTokens)
    allDoneNoticeText = [
      t('taskPanel.allDone', { done: snap.progress.done, total: snap.progress.total }),
      tokensLabel ? `${tokensLabel} tokens` : undefined,
      skippedTotal > 0 ? t('taskPanel.allDoneSkipped', { count: skippedTotal }) : undefined,
    ]
      .filter((seg): seg is string => Boolean(seg))
      .join(' · ')
  }
  const waitingNode = card?.kind === 'needs-human' ? g.graph?.nodes[card.nodeId] : undefined

  return (
    <div className="relative flex h-full flex-col overflow-hidden" ref={rootRef} onKeyDown={onKeyDown} tabIndex={-1}>
      <PanelHeader
        snapshot={snap}
        narrow={narrow}
        foldAll={foldAll}
        onToggleFoldAll={toggleFoldAll}
        filter={filter}
        setFilter={setFilter}
        filterCounts={filterCounts}
        locateRows={locateRows}
        locateOpen={locateOpen}
        setLocateOpen={setLocateOpen}
        onLocate={locateTo}
      />

      {/* 加载态：骨架行（保持行高，避免布局跳动） */}
      {g.loading && !snap && (
        <div className="flex-1 overflow-hidden px-3 py-2" aria-busy="true">
          {[52, 78, 66, 84, 44, 70, 58].map((w, i) => (
            <div key={i} className="mb-2.5 h-2.5 rounded-sm bg-bg-surface-2" style={{ width: `${w}%` }} />
          ))}
          <p className="mt-3 text-center text-xs text-text-tertiary">{t('taskPanel.loading')}</p>
        </div>
      )}

      {/* 轻量模式（Tier 0/1）：不显示依赖图，只给内联清单提示 */}
      {snap?.lightweight && (
        <div className="shrink-0 border-b border-border-subtle px-3 py-2 text-2xs text-text-tertiary">
          {t('taskPanel.lightweightBanner', { tier: snap.tier })}
        </div>
      )}

      {snap && !allTerminal && <GraphNotices notices={notices} onOpen={openCard} onDismiss={(n) =>
        setDismissed((s) => new Set(s).add(`${n.kind}-${n.refId ?? n.text}`))
      } />}
      {snap && allTerminal && (
        <GraphNotices
          notices={[
            {
              kind: 'auto-applied',
              severity: 'success',
              text: allDoneNoticeText ?? '',
              dismissible: false,
            },
          ]}
          onOpen={() => undefined}
          onDismiss={() => undefined}
        />
      )}

      {/* v0.43.0（R3）：依赖图退役，只保留树视图 */}
      {(
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden" role="tree" aria-label={t('taskPanel.treeAria')}>
          {/* needs_human 置顶区 */}
          {waitingRows.length > 0 && (
            <div className="shrink-0 border-b border-border-subtle px-3 pt-2">
              <div className="mb-1 text-2xs tracking-wide text-danger">{t('taskPanel.pinnedLabel')}</div>
              {waitingRows.map((r) => (
                <NodeRow
                  key={`pinned-${r.id}`}
                  row={r}
                  expanded={false}
                  selected={selectedId === r.id}
                  summary={false}
                  narrow={narrow}
                  onSelect={() => {
                    setSelectedId(r.id)
                    setCard({ kind: 'needs-human', nodeId: r.id })
                  }}
                  onToggle={() => toggle(r.id)}
                  onOpenDetail={() => openDetail(r.id)}
                  onMenu={(a) => setMenu({ nodeId: r.id, ...a })}
                />
              ))}
            </div>
          )}

          {/* 树本体 */}
          <div className="min-h-0 flex-1 overflow-y-auto py-2">
            {visibleRows.length === 0 && !g.loading && (
              <p className="px-3 py-8 text-center text-xs text-text-tertiary">
                {t('taskPanel.emptyTree')}
              </p>
            )}
            {visibleRows.map((r) => {
              if (hiddenIds.has(r.id)) return null
              return (
                <NodeRow
                  key={r.id}
                  row={r}
                  expanded={!rowCollapsedOf(r)}
                  selected={selectedId === r.id}
                  summary={false}
                  narrow={narrow}
                  onSelect={() => setSelectedId(r.id)}
                  onToggle={() => toggle(r.id)}
                  onOpenDetail={() => openDetail(r.id)}
                  onMenu={(a) => setMenu({ nodeId: r.id, ...a })}
                />
              )
            })}
          </div>

          {/* AC 覆盖条 */}
          {snap && snap.spec.acceptance.length > 0 && (
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border-default px-3 py-2 text-2xs">
              <span className="text-text-secondary">{t('taskPanel.acceptance')}</span>
              {snap.spec.acceptance.map((a) => {
                const m = AC_META[a.status]
                return (
                  <span key={a.id} className={`inline-flex items-center gap-1 font-mono ${m.text}`} title={a.statement}>
                    <span aria-hidden>{m.glyph}</span>
                    {a.id}
                  </span>
                )
              })}
              <button
                type="button"
                className="ml-auto text-business-primary hover:underline"
                onClick={() => {
                  const first = snap.spec.acceptance[0]
                  const owner = first?.coveredBy[0]
                  if (owner) openDetail(owner)
                  else toast(t('taskPanel.noAcOwner'))
                }}
              >
                {t('taskPanel.expandAllAc', { n: snap.spec.acceptance.length })}
              </button>
            </div>
          )}
        </div>
      )}

      {/* ---------------- 覆盖层 ---------------- */}

      {/* 行内菜单 */}
      {menu && (
        <RowMenu
          x={menu.x}
          y={menu.y}
          row={rows.find((r) => r.id === menu.nodeId)}
          onClose={() => setMenu(null)}
          onMarkDone={() =>
            void g.setStatus({ nodeId: menu.nodeId, status: 'completed', reason: '用户手动标记完成' }).then((ok) => {
              toast(ok ? t('taskPanel.markedDone') : t('taskPanel.markFailed'))
              setMenu(null)
            })
          }
          onCancel={() =>
            void g.setStatus({ nodeId: menu.nodeId, status: 'cancelled', reason: '用户手动取消' }).then((ok) => {
              toast(ok ? t('taskPanel.markedCancelled') : t('taskPanel.markFailed'))
              setMenu(null)
            })
          }
          onForceDone={() =>
            void g
              .setStatus({
                nodeId: menu.nodeId,
                status: 'completed',
                force: true,
                reason: '用户强制标记完成（知悉绕过校验）',
              })
              .then((ok) => {
                toast(ok ? t('taskPanel.markedDone') : t('taskPanel.markFailed'))
                setMenu(null)
              })
          }
          onDelete={() =>
            void g.deleteNode(menu.nodeId, t('taskPanel.deletedByUser')).then((ok) => {
              toast(ok ? t('taskPanel.deleted') : t('taskPanel.markFailed'))
              setMenu(null)
            })
          }
        />
      )}

      {/* Evidence 抽屉 */}
      {drawerNode && (
        <EvidenceDrawer
          node={drawerNode}
          onClose={() => setDrawerNodeId(null)}
          onOpenEvidence={(ref) => {
            // v0.30.1 F3-3：接线到既有「在文件夹中显示」能力（fs:reveal-in-folder），
            // 不再弹假 toast。无可用路径时给出诚实说明。
            const target = ref?.trim()
            if (target) void window.ark.fs.revealInFolder(target)
            else toast(t('taskPanel.noEvidenceRef'))
          }}
          onOpenRevisions={() => toast(t('taskPanel.revisionsHint'))}
          zombie={(g.graph?.spec.driftReport?.zombieTasks ?? []).some((z) => z.taskId === drawerNode.id)}
        />
      )}

      {/* needs_human 卡片 */}
      {waitingNode && (
        <NeedsHumanCard
          node={waitingNode}
          hasNext={waitingRows.length > 1}
          error={g.error}
          onSubmit={(p) => g.answerBlock(p)}
          onSkip={(p) => g.answerBlock(p)}
          onCancelAll={(p) => g.answerBlock(p)}
          onClose={() => setCard(null)}
        />
      )}

      {/* Replan 卡片 */}
      {pendingPatch && (
        <ReplanCard
          patch={pendingPatch}
          labelOf={labelOf}
          error={g.error}
          onAccept={() => g.decideReplan({ patchId: pendingPatch.id, decision: 'accept' })}
          onReject={(note) => g.decideReplan({ patchId: pendingPatch.id, decision: 'reject', userNote: note })}
          onEdit={() => g.decideReplan({ patchId: pendingPatch.id, decision: 'edit' })}
          onViewDiff={() => toast(t('taskPanel.diffHint'))}
          onClose={() => setCard(null)}
        />
      )}

      {/* 收敛报告卡 */}
      {card?.kind === 'converge' && g.graph?.spec.driftReport && (
        <ConvergeCard
          report={g.graph.spec.driftReport}
          labelOf={labelOf}
          error={g.error}
          onAcceptAll={() => g.resolveConverge({ action: 'accept-all' })}
          onAcceptSome={(indices) => g.resolveConverge({ action: 'accept-some', indices })}
          onDismiss={() => g.resolveConverge({ action: 'dismiss' })}
          onClose={() => setCard(null)}
        />
      )}

      {/* 内联错误条（非模态操作的失败） */}
      {g.error && !g.broken && !waitingNode && !pendingPatch && card?.kind !== 'converge' && (
        <div className="absolute inset-x-2 bottom-2 z-[20] flex items-start gap-2 rounded-md border border-danger bg-danger-soft px-3 py-2 text-xs leading-[18px] shadow-md">
          <span aria-hidden>⚠</span>
          <span className="min-w-0 flex-1">
            <strong className="block">{g.error.message}</strong>
            <span className="text-text-secondary">{g.error.hint}</span>
          </span>
          <button type="button" onClick={g.clearError} aria-label={t('taskPanel.close')}>
            <Icon.X width={12} height={12} />
          </button>
        </div>
      )}

      {/* 面板提示（任务标题，便于多任务切换时确认在看哪个） */}
      {task && !narrow && (
        <span className="sr-only">{task.title}</span>
      )}
    </div>
  )
}

/* ============================================================
 * 头部工具条
 * ============================================================ */

function PanelHeader({
  snapshot,
  narrow,
  foldAll,
  onToggleFoldAll,
  filter,
  setFilter,
  filterCounts,
  locateRows,
  locateOpen,
  setLocateOpen,
  onLocate,
}: {
  snapshot: import('@shared/types/ipc').GraphSnapshot | null
  narrow: boolean
  foldAll: boolean
  onToggleFoldAll: () => void
  filter: FilterKey
  setFilter: (v: FilterKey) => void
  filterCounts: Record<FilterKey, number>
  locateRows: GraphRow[]
  locateOpen: boolean
  setLocateOpen: (v: boolean) => void
  onLocate: (id: string) => void
}) {
  const { t, i18n } = useTranslation()
  const [tierInfoOpen, setTierInfoOpen] = useState(false)
  const progress = snapshot?.progress
  const done = progress?.done ?? 0
  const total = progress?.total ?? 0
  // v0.43.0（R1）：标题 = **本轮目标简介**（graph.goal，轮次晋升时由引擎更新）；
  // goal 缺失或仍是「未命名任务」占位 → 一律兜底「本轮任务」，占位词不外露。
  const rawTitle = snapshot?.goal || snapshot?.title || ''
  const title = rawTitle && !/^未命名任务/.test(rawTitle) ? rawTitle : t('taskPanel.roundFallback')
  // v0.43.0（用户反馈②）：内部迁移语言（「迁移自 v0.x…」）属实现细节，展示层剥离后不渲染。
  const tierReason = sanitizeTierReason(snapshot?.tierReason)
  const progressTip = snapshot
    ? t('taskPanel.progressTip', {
        done,
        total,
        used: tokensLabelOf(snapshot.budget.tokensUsed, formatTokens) ?? '—',
        budget: snapshot.budget.tokenBudget ? formatTokens(snapshot.budget.tokenBudget) : '—',
      })
    : undefined

  return (
    <>
      {/* v0.43.0（R2）：档位说明弹层 —— Portal 逃逸裁切容器（纪律⑤），点遮罩/Esc 关闭 */}
      {tierInfoOpen && (
        <TierInfoPopover
          tier={snapshot?.tier ?? 2}
          reason={tierReason}
          onClose={() => setTierInfoOpen(false)}
        />
      )}
      <header className="shrink-0 border-b border-border-default px-3.5 pb-2.5 pt-3">
      {/* 标题行：task.title(=graph.goal) + 进度 + 定位（与列表留出呼吸空间） */}
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-lg font-semibold leading-6 tracking-tight" title={title}>
          <span className="mr-1.5 text-sm text-accent" aria-hidden>
            ◆
          </span>
          {title}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span className="text-sm font-medium tabular-nums text-text-secondary" title={progressTip}>
            {snapshot ? `${done}/${total}` : '—/—'}
          </span>
          {snapshot && locateRows.length > 0 && (
            <div className="relative">
              <button
                type="button"
                aria-haspopup="listbox"
                aria-expanded={locateOpen}
                onClick={() => setLocateOpen(!locateOpen)}
                title={t('taskPanel.locateTip')}
                className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-border-default bg-bg-surface-2 px-2 py-0.5 text-2xs text-text-secondary hover:bg-bg-surface-3 hover:text-text-primary"
              >
                <span className="text-[8px] text-danger" aria-hidden>
                  ●
                </span>
                {!narrow && t('taskPanel.locate')}
                <span className="tabular-nums text-text-tertiary">{locateRows.length}</span>
                <Icon.ChevronDown width={10} height={10} />
              </button>
              {locateOpen && (
                <ul className="absolute right-0 top-full z-[40] mt-1 max-h-64 w-[240px] overflow-y-auto rounded-md border border-border-default bg-bg-overlay py-1 shadow-md">
                  {locateRows.map((r) => {
                    const m = statusMeta(r.status)
                    return (
                      <li key={`locate-${r.id}`}>
                        <button
                          type="button"
                          onClick={() => onLocate(r.id)}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-bg-surface-2"
                        >
                          <span className={`shrink-0 ${m.text}`} aria-hidden>
                            {m.glyph}
                          </span>
                          {r.key && <span className="shrink-0 font-mono text-2xs text-text-tertiary">{r.key}</span>}
                          <span className="min-w-0 flex-1 truncate">{r.title}</span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )}
        </span>
      </div>

      {/* v0.43.0（R2）：档位独立行 —— T{n} · 释义 全文可见（窄态不截断）+ info 弹层入口 */}
      {snapshot && (
        <div className="mt-1.5 flex min-w-0 items-center gap-1.5">
          <span
            data-testid="graph-tier-badge"
            data-tier={snapshot.tier}
            className="inline-flex shrink-0 items-center whitespace-nowrap rounded-sm border border-border-default bg-info-soft px-2 py-0.5 text-2xs tabular-nums text-info"
          >
            {tierLabel(snapshot.tier, i18n.language)}
          </span>
          <button
            type="button"
            data-testid="tier-info-btn"
            aria-haspopup="dialog"
            aria-expanded={tierInfoOpen}
            title={t('taskPanel.tierInfo.title')}
            onClick={() => setTierInfoOpen(true)}
            className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-sm border border-border-default px-1.5 py-0.5 text-2xs text-text-secondary hover:border-border-strong hover:bg-bg-surface-3 hover:text-text-primary"
          >
            <Icon.Info width={12} height={12} aria-hidden />
            {t('taskPanel.tierInfo.helpLabel')}
          </button>
          {tierReason && (
            <span className="min-w-0 flex-1 truncate text-2xs text-text-tertiary" title={tierReason}>
              {tierReason}
            </span>
          )}
        </div>
      )}

      {/* 控制行：两 Tab（本轮任务 / 全部任务）+ 全局折叠 */}
      <div className="mt-2.5 flex min-w-0 flex-wrap items-center gap-2">
        <span className="inline-flex min-w-0 overflow-x-auto rounded-md border border-border-default bg-bg-surface-2 p-0.5">
          {FILTER_KEYS.map((k) => {
            const active = filter === k
            return (
              <button
                key={k}
                type="button"
                aria-pressed={active}
                onClick={() => setFilter(k)}
                className={`inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-1.5 py-0.5 text-2xs ${
                  active
                    ? 'bg-accent-soft font-medium text-accent'
                    : 'text-text-secondary hover:bg-bg-surface-3 hover:text-text-primary'
                }`}
              >
                {t(`taskPanel.filter.${k}`)}
                <span className={`tabular-nums ${active ? 'text-accent' : 'text-text-tertiary'}`}>{filterCounts[k]}</span>
              </button>
            )
          })}
        </span>

        <span className="ml-auto flex shrink-0 items-center gap-1">
          {/* v0.43.0（R3）：树/DAG 视图切换退役，只保留树视图；档位徽章移至标题下方独立行（R2） */}

          {/* v0.30.1 问题④：一键折叠改为状态化文案（全展开→「全部折叠」；已折叠→「全部展开」），图标随态；窄态降级为纯图标 */}
          <button
            type="button"
            aria-label={foldAll ? t('taskPanel.expandAllShort') : t('taskPanel.foldAllShort')}
            aria-pressed={foldAll}
            title={t('taskPanel.foldAll')}
            onClick={onToggleFoldAll}
            className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-sm border border-border-default px-2 py-0.5 text-2xs hover:bg-bg-surface-3 hover:text-text-primary ${
              foldAll ? 'text-accent' : 'text-text-secondary'
            }`}
          >
            {foldAll ? <Icon.ChevronRight width={12} height={12} /> : <Icon.ChevronDown width={12} height={12} />}
            {!narrow && <span>{foldAll ? t('taskPanel.expandAllShort') : t('taskPanel.foldAllShort')}</span>}
          </button>
        </span>
      </div>
      </header>
    </>
  )
}

/* ============================================================
 * v0.43.0（R2）：档位说明弹层 —— Portal 到 body（纪律⑤：逃逸裁切容器）。
 * 内容 = T0–T3 四档全量释义（i18n 唯一真源）+ 当前任务判定理由。
 * ============================================================ */
function TierInfoPopover({ tier, reason, onClose }: { tier: number; reason?: string; onClose: () => void }) {
  const { t, i18n } = useTranslation()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const tiers = [0, 1, 2, 3] as const
  return createPortal(
    <div
      className="fixed inset-0 z-[70]"
      role="dialog"
      aria-modal="true"
      aria-label={t('taskPanel.tierInfo.title')}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="absolute right-4 top-14 w-[320px] max-w-[90vw] rounded-lg border border-border-default bg-bg-overlay p-3 shadow-panel">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-semibold text-text-primary">{t('taskPanel.tierInfo.title')}</span>
          <button
            type="button"
            aria-label={t('taskPanel.foldAllShort')}
            onClick={onClose}
            className="rounded p-0.5 text-text-tertiary hover:bg-bg-hover hover:text-text-primary"
          >
            <Icon.X width={14} height={14} />
          </button>
        </div>
        <div className="space-y-1.5">
          {tiers.map((tv) => (
            <div
              key={tv}
              data-testid={`tier-info-${tv}`}
              className={`rounded-md border px-2 py-1.5 text-2xs leading-relaxed ${
                tv === tier ? 'border-info bg-info-soft text-text-primary' : 'border-border-subtle text-text-secondary'
              }`}
            >
              <span className="font-medium">{tierLabel(tv, i18n.language)}</span>
              <div className="mt-0.5">{t(`taskPanel.tierInfo.d${tv}`)}</div>
            </div>
          ))}
        </div>
        {reason && (
          <div className="mt-2 rounded-md bg-bg-surface-2 px-2 py-1.5 text-2xs leading-relaxed text-text-secondary">
            <span className="font-medium text-text-primary">{t('taskPanel.tierInfo.reasonLabel')}：</span>
            {reason}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

function SegBtn({
  active,
  onClick,
  label,
  showText = true,
  children,
}: {
  active: boolean
  onClick: () => void
  label: string
  showText?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      onClick={onClick}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-1.5 py-0.5 text-2xs ${
        active ? 'bg-accent-soft font-medium text-accent' : 'text-text-tertiary hover:text-text-primary'
      }`}
    >
      {children}
      {showText && <span>{label}</span>}
    </button>
  )
}

/* ============================================================
 * 行内「⋯」菜单（P1 的「人工改状态 / 追加子任务 / 手动完成 / 取消」）
 * ============================================================ */

function RowMenu({
  x,
  y,
  row,
  onClose,
  onMarkDone,
  onCancel,
  onForceDone,
  onDelete,
}: {
  x: number
  y: number
  row: GraphRow | undefined
  onClose: () => void
  onMarkDone: () => void
  onCancel: () => void
  onForceDone: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  /** 二次确认：危险动作（强制完成 / 删除）首击只「上膛」，再击才执行 —— 与 P3 双段确认一致 */
  const [confirm, setConfirm] = useState<null | 'forceDone' | 'delete'>(null)
  useEffect(() => {
    const h = (): void => onClose()
    window.addEventListener('click', h)
    window.addEventListener('scroll', h, true)
    return () => {
      window.removeEventListener('click', h)
      window.removeEventListener('scroll', h, true)
    }
  }, [onClose])

  if (!row) return null
  const m = statusMeta(row.status)

  const items: {
    label: string
    onClick: () => void
    danger?: boolean
    hint?: string
    armed?: boolean
  }[] = [
    { label: t('taskPanel.menuMarkDone'), onClick: onMarkDone },
    {
      label: confirm === 'forceDone' ? t('taskPanel.menuForceDoneConfirm') : t('taskPanel.menuForceDone'),
      onClick: () => (confirm === 'forceDone' ? onForceDone() : setConfirm('forceDone')),
      hint: t('taskPanel.menuForceDoneHint'),
      armed: confirm === 'forceDone',
    },
    { label: t('taskPanel.menuCancel'), onClick: onCancel },
    {
      label: confirm === 'delete' ? t('taskPanel.menuDeleteConfirm') : t('taskPanel.menuDelete'),
      onClick: () => (confirm === 'delete' ? onDelete() : setConfirm('delete')),
      danger: true,
      hint: t('taskPanel.menuDeleteHint'),
      armed: confirm === 'delete',
    },
  ]

  return (
    <ul
      role="menu"
      className="fixed z-[50] w-[220px] rounded-md border border-border-default bg-bg-overlay py-1 shadow-lg"
      style={{ left: Math.min(x, window.innerWidth - 236), top: y }}
      onClick={(e) => e.stopPropagation()}
    >
      <li className="border-b border-border-subtle px-3 py-1.5 text-2xs text-text-tertiary">
        <span className={m.text} aria-hidden>
          {m.glyph}
        </span>{' '}
        {row.key ?? row.id} · {t(`taskPanel.status.${row.status}` as never)}
      </li>
      {items.map((it) => (
        <li key={it.label}>
          <button
            type="button"
            onClick={it.onClick}
            title={it.hint}
            className={`block w-full px-3 py-1.5 text-left text-xs hover:bg-bg-surface-2 ${
              it.danger ? 'text-danger' : 'text-text-primary'
            } ${it.armed ? (it.danger ? 'bg-danger-soft font-medium' : 'bg-bg-surface-3 font-medium') : ''}`}
          >
            {it.label}
          </button>
        </li>
      ))}
    </ul>
  )
}
