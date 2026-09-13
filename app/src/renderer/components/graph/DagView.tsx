/**
 * ArkWork — 任务面板 · 依赖图（DagView）
 *
 * 依据：docs/versions/v0.30.0/03-interaction.md §P7
 *       prototype/page-07-dag.html（已冻结的视觉基准）
 *
 * **direct source of truth**：wave 分层直接调用 `@shared/types/graph` 的
 * `computeWaves(graph)` —— 与引擎、图校验器用的是**同一个纯函数**。
 * 绝不在渲染层重写一遍拓扑排序：那会带来"面板显示的 wave 与引擎调度顺序不一致"
 * 这类极难发现的偏差（设计稿把"节点卡 click → 切回树视图定位"作为唯一交互，
 * 正是为了让两个视图共用同一份数据）。
 *
 * 本版 DAG **只做可视化**（F21 / P2）：不做真实并行调度。
 * 理由见 00-release-goal.md Scope Out S4（并行调度需要文件锁 + 乐观并发，
 * 属"多 Agent 升级"，与"其他核心功能不变"冲突）。
 */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { computeWaves, type TaskGraph } from '@shared/types/graph'
import { statusMeta, formatTokens } from './graphMeta'

export interface DagViewProps {
  graph: TaskGraph
  /** 点击节点 → 切回树视图并定位该行 */
  onLocate: (nodeId: string) => void
  /** 图不完整（节点过少）时的退回树视图 */
  onSwitchToTree: () => void
}

/** 超过这个节点数就按 wave 折叠（避免一屏铺开 40+ 卡片） */
const COLLAPSE_THRESHOLD = 40

export function DagView({ graph, onLocate, onSwitchToTree }: DagViewProps) {
  const { t } = useTranslation()
  const [collapsedWaves, setCollapsedWaves] = useState<Set<number>>(new Set())

  const waves = useMemo(() => computeWaves(graph), [graph])
  const nodeCount = Object.keys(graph.nodes).length

  // 空态：依赖关系不足以成图（< 2 节点）—— 与原型 P7「空」态一致
  if (nodeCount < 2) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <span className="text-2xl text-text-tertiary" aria-hidden>
          ○
        </span>
        <span className="text-base text-text-secondary">{t('taskPanel.dagNotEnough')}</span>
        <span className="text-xs text-text-tertiary">{t('taskPanel.dagNotEnoughHint')}</span>
        <button
          type="button"
          onClick={onSwitchToTree}
          className="rounded-md border border-border-default bg-bg-surface-2 px-3 py-1.5 text-xs hover:bg-bg-surface-3"
        >
          {t('taskPanel.backToTree')}
        </button>
      </div>
    )
  }

  // 错误态：成环（computeWaves 返回 null）→ 提示走 I4 修复，不渲染半张图
  if (!waves) {
    const inCycle = Object.values(graph.nodes)
      .filter((n) => n.dependsOn.length > 0)
      .slice(0, 6)
    return (
      <div className="flex-1 overflow-y-auto px-3 py-3">
        <div className="rounded-md border border-danger bg-danger-soft p-4">
          <h4 className="mb-2 text-base">{t('taskPanel.dagCycleTitle')}</h4>
          <div className="mb-3 rounded-sm bg-bg-base p-3 font-mono text-xs leading-[18px] text-text-secondary">
            {inCycle.map((n) => (
              <div key={n.id}>
                {n.key ?? n.id} → {(n.dependsOn.map((d) => graph.nodes[d]?.key ?? d) || []).join(', ')}
              </div>
            ))}
          </div>
          <p className="mb-3 text-xs leading-[18px] text-text-secondary">{t('taskPanel.dagCycleHint')}</p>
          <button
            type="button"
            onClick={onSwitchToTree}
            className="rounded-md border border-border-default bg-bg-surface-2 px-3 py-1.5 text-xs hover:bg-bg-surface-3"
          >
            {t('taskPanel.backToTree')}
          </button>
        </div>
      </div>
    )
  }

  const collapsible = nodeCount > COLLAPSE_THRESHOLD

  return (
    <div className="flex-1 overflow-auto px-3 py-4">
      <div className="flex min-w-max gap-5">
        {waves.map((waveIds, wi) => {
          const collapsed = collapsedWaves.has(wi)
          return (
            <section key={wi} className="w-[186px] shrink-0">
              <h3 className="mb-3 flex items-center gap-2 border-b border-dashed border-border-default pb-1.5 text-2xs uppercase tracking-wide text-text-tertiary">
                <span>
                  {t('taskPanel.dagWave')} {wi}
                </span>
                {/* 只有第一层注明「无依赖」，其余标注它依赖前一层 */}
                <span className="font-normal normal-case">
                  {wi === 0 ? t('taskPanel.dagNoDeps') : t('taskPanel.dagDependsPrev')}
                </span>
                <button
                  type="button"
                  className="ml-auto"
                  onClick={() =>
                    collapsible &&
                    setCollapsedWaves((s) => {
                      const n = new Set(s)
                      if (n.has(wi)) n.delete(wi)
                      else n.add(wi)
                      return n
                    })
                  }
                >
                  {waveIds.length}
                </button>
              </h3>
              {collapsed ? (
                <p className="text-2xs text-text-tertiary">{t('taskPanel.dagCollapsed', { n: waveIds.length })}</p>
              ) : (
                <ul>
                  {waveIds.map((id) => {
                    const n = graph.nodes[id]
                    if (!n) return null
                    const m = statusMeta(n.status)
                    const unmet = n.dependsOn
                      .map((d) => graph.nodes[d])
                      .filter((d) => d && d.status !== 'completed' && d.status !== 'cancelled')
                    return (
                      <li key={id}>
                        <button
                          type="button"
                          onClick={() => onLocate(id)}
                          className={`mb-3 block w-full rounded-md border border-border-default bg-bg-surface px-3 py-2 text-left transition-transform hover:-translate-y-px hover:border-accent ${m.bg}`}
                        >
                          <span className="mb-0.5 flex items-center gap-1.5 font-mono text-2xs text-text-tertiary">
                            <span className={m.text} aria-hidden>
                              {m.glyph}
                            </span>
                            {n.key ?? n.id}
                          </span>
                          <span className="block truncate text-sm leading-[18px]" title={n.title}>
                            {n.title}
                          </span>
                          <span className="mt-1 block text-2xs tabular-nums text-text-tertiary">
                            {formatTokens(n.tokensUsed) || '—'}
                            {n.status === 'blocked' && unmet.length > 0
                              ? ` · ${t('taskPanel.blockedBy', {
                                  keys: unmet.map((d) => d!.key ?? d!.id).join(', '),
                                })}`
                              : ''}
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}
