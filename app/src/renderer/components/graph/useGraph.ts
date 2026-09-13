/**
 * ArkWork — 任务面板状态钩子（useGraph）
 *
 * 依据：docs/versions/v0.30.0/04-system-design.md §5.1
 *       docs/versions/v0.30.0/03-interaction.md（P1 页的五态契约）
 *
 * ★ **架构取舍（有意为之，须在后续版本复核）**：
 *   本钩子把图状态放在**组件内部**，而不是塞进全局 zustand store。
 *
 *   理由：
 *    1. 任务面板是图的**唯一消费者**（对话流里的 Plan 卡片走的是既有 planItems 通道，
 *       不改）；把状态提升到全局会引入 4 个中心文件的改动
 *       （types.ts / index.ts / subscriptions.ts / 新 slice），
 *       与"其他核心功能不变"的边界相冲突。
 *    2. 面板的生命周期与任务切换强绑定：订阅与清理都在同一个 useEffect 里，
 *       比"全局订阅 + 手动 view 过滤"更不容易漏清理。
 *
 *   代价：如果将来有第二个消费者（如独立窗口的任务图），需要把它提升到 store。
 *   届时按"缺陷回溯"流程改文档再改代码。
 *
 * 五态契约（03-interaction.md §P1「页面五态」）由本钩子提供原料：
 *   默认 = snapshot 有数据；加载 = loading；空 = snapshot 为 null 且非加载；
 *   错误 = error 非空；成功 = 全部节点 terminal（由组件自行判定）
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  GraphConvergePayload,
  GraphNodeCreatePayload,
  GraphNodeUpdatePayload,
  GraphReplanDecisionPayload,
  GraphSetStatusPayload,
  GraphSnapshot,
  GraphWriteError,
  ReplanPatch,
  TaskGraph,
  Tier,
} from '@shared/types/ipc'

export interface UseGraphResult {
  /** 面板快照（null = 该任务无图 / 轻量模式） */
  snapshot: GraphSnapshot | null
  /** 是否在加载中（首次进入或切换任务） */
  loading: boolean
  /** 结构化错误（含 hint）—— UI 直接显示 hint，不自己拼文案 */
  error: GraphWriteError | null
  /** 图 schema 校验失败（F20 的"图损坏"降级态） */
  broken: boolean
  /** 待批准的 Replan 补丁 */
  pendingPatches: ReplanPatch[]
  /** 原始图（Evidence 查看器与编辑需要完整节点） */
  graph: TaskGraph | null
  /** 手动刷新 */
  refresh: () => Promise<void>
  /** 清空错误（用户关闭内联红条时） */
  clearError: () => void
  /* ---- 动作（全部返回是否成功；失败时 error 已被写入） ---- */
  updateNode: (p: Omit<GraphNodeUpdatePayload, 'taskId'>) => Promise<boolean>
  createNode: (p: Omit<GraphNodeCreatePayload, 'taskId'>) => Promise<boolean>
  deleteNode: (nodeId: string, reason: string) => Promise<boolean>
  setStatus: (p: Omit<GraphSetStatusPayload, 'taskId'>) => Promise<boolean>
  answerBlock: (p: { nodeId: string; action: 'submit' | 'skip' | 'cancel-all'; answer?: string; note?: string }) => Promise<boolean>
  decideReplan: (p: Omit<GraphReplanDecisionPayload, 'taskId'>) => Promise<boolean>
  resolveConverge: (p: Omit<GraphConvergePayload, 'taskId'>) => Promise<boolean>
  setTier: (tier: Tier) => Promise<boolean>
  exportMd: () => Promise<string | null>
  runConverge: () => Promise<boolean>
  restoreSnapshot: (stamp: string) => Promise<boolean>
}

/**
 * 订阅并操作一个任务的 TaskGraph。
 *
 * @param taskId 当前任务 id；为空时钩子不发起任何请求（保持空态）
 */
export function useGraph(taskId: string | null | undefined): UseGraphResult {
  const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null)
  const [graph, setGraph] = useState<TaskGraph | null>(null)
  const [pendingPatches, setPendingPatches] = useState<ReplanPatch[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<GraphWriteError | null>(null)
  const [broken, setBroken] = useState(false)
  /** 竞态防护：只有最后一次请求的结果才允许落状态 */
  const reqSeq = useRef(0)

  /** 拉一次完整快照 + 图 + 待决补丁 */
  const load = useCallback(
    async (silent = false) => {
      if (!taskId) {
        setSnapshot(null)
        setGraph(null)
        setPendingPatches([])
        setBroken(false)
        return
      }
      const seq = ++reqSeq.current
      if (!silent) setLoading(true)
      try {
        const [snap, full, patches] = await Promise.all([
          window.ark.graph.snapshot(taskId),
          window.ark.graph.get(taskId),
          window.ark.graph.pendingPatches(taskId).catch(() => [] as ReplanPatch[]),
        ])
        if (seq !== reqSeq.current) return // 已被更新的请求取代
        if (!snap.ok) {
          setError(snap.error)
          // 图损坏（SCHEMA_INVALID 且非"没有图"）→ F20 降级态
          setBroken(snap.error.code === 'SCHEMA_INVALID')
          setSnapshot(null)
        } else {
          setSnapshot(snap.data)
          setBroken(false)
        }
        setGraph(full.ok ? full.data : null)
        setPendingPatches(patches)
      } catch (e) {
        if (seq !== reqSeq.current) return
        setError({
          code: 'IO_ERROR',
          message: `读取任务图失败：${(e as Error).message}`,
          hint: '请检查主进程日志；若持续失败，可在任务列表里重新打开该任务。',
        })
      } finally {
        if (seq === reqSeq.current) setLoading(false)
      }
    },
    [taskId],
  )

  useEffect(() => {
    void load()
  }, [load])

  // 订阅增量刷新：只在属于本任务时刷（避免多任务串台）
  useEffect(() => {
    if (!taskId) return
    const off = window.ark.graph.onUpdate((payload) => {
      if (payload.taskId !== taskId) return
      // refresh 标记 = 大变更（图创建 / Replan / 收敛 / needs_human），必须重新拉快照；
      // 其余（patch / status）也拉一次 —— 面板是"轻量投影"，本地做增量合并的收益
      // 抵不上维护合并逻辑的成本与出错风险（快照本身已做折叠与裁剪）
      void load(true)
    })
    return off
  }, [taskId, load])

  /** 统一处理动作响应：ok → 落快照；错误 → 落 error */
  const runAction = useCallback(
    async (
      fn: () => Promise<{ ok: true; data: GraphSnapshot } | { ok: false; error: GraphWriteError }>,
    ): Promise<boolean> => {
      try {
        const res = await fn()
        if (res.ok) {
          setSnapshot(res.data)
          setError(null)
          // 动作可能改变图结构（新建/删除/应用补丁）→ 后台补一次完整图
          void load(true)
          return true
        }
        setError(res.error)
        return false
      } catch (e) {
        setError({
          code: 'IO_ERROR',
          message: `操作失败：${(e as Error).message}`,
          hint: '请重试；若持续失败请检查主进程日志。',
        })
        return false
      }
    },
    [load],
  )

  const actions = useMemo(
    () => ({
      updateNode: (p: Omit<GraphNodeUpdatePayload, 'taskId'>) =>
        taskId ? runAction(() => window.ark.graph.updateNode({ taskId, ...p })) : Promise.resolve(false),
      createNode: (p: Omit<GraphNodeCreatePayload, 'taskId'>) =>
        taskId ? runAction(() => window.ark.graph.createNode({ taskId, ...p })) : Promise.resolve(false),
      deleteNode: (nodeId: string, reason: string) =>
        taskId ? runAction(() => window.ark.graph.deleteNode({ taskId, nodeId, reason })) : Promise.resolve(false),
      setStatus: (p: Omit<GraphSetStatusPayload, 'taskId'>) =>
        taskId ? runAction(() => window.ark.graph.setStatus({ taskId, ...p })) : Promise.resolve(false),
      answerBlock: (p: { nodeId: string; action: 'submit' | 'skip' | 'cancel-all'; answer?: string; note?: string }) =>
        taskId ? runAction(() => window.ark.graph.answerBlock({ taskId, ...p })) : Promise.resolve(false),
      decideReplan: (p: Omit<GraphReplanDecisionPayload, 'taskId'>) =>
        taskId ? runAction(() => window.ark.graph.decideReplan({ taskId, ...p })) : Promise.resolve(false),
      resolveConverge: (p: Omit<GraphConvergePayload, 'taskId'>) =>
        taskId ? runAction(() => window.ark.graph.resolveConverge({ taskId, ...p })) : Promise.resolve(false),
      setTier: (tier: Tier) =>
        taskId ? runAction(() => window.ark.graph.setTier({ taskId, tier })) : Promise.resolve(false),
      exportMd: async () => {
        if (!taskId) return null
        const res = await window.ark.graph.exportMd(taskId)
        if (res.ok) return res.data.path
        setError(res.error)
        return null
      },
      runConverge: () => (taskId ? runAction(() => window.ark.graph.runConverge(taskId)) : Promise.resolve(false)),
      restoreSnapshot: (stamp: string) =>
        taskId ? runAction(() => window.ark.graph.restoreSnapshot({ taskId, stamp })) : Promise.resolve(false),
    }),
    [taskId, runAction],
  )

  return {
    snapshot,
    graph,
    pendingPatches,
    loading,
    error,
    broken,
    refresh: () => load(),
    clearError: () => setError(null),
    ...actions,
  }
}

/* ============================================================
 * needs_human 的等待时长实时递增
 * ============================================================ */

/**
 * 每 10 秒触发一次重渲染，用于 needs_human 卡片的"等待 2m14s"实时递增。
 *
 * 为什么不用 setInterval 直接改 state：只需要一个 tick 计数，
 * 由消费方自己算差值 —— 避免把时间塞进快照导致组件重挂载。
 * 组件卸载时自动清理。
 */
export function useWaitingTick(enabled: boolean): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const id = window.setInterval(() => setTick((t) => t + 1), 10_000)
    return () => window.clearInterval(id)
  }, [enabled])
  return tick
}
