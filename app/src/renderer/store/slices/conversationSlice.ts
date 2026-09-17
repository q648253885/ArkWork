/* ============================================================
 * ArkWork — 会话执行域 slice（v0.27.0 R3：自 store.ts 纯移动）
 * ReAct steps / 流式缓冲 / 工具与任务进度 / conversation / 文件树 / 日志
 * ============================================================ */
import type { StateCreator } from 'zustand'
import { ark } from '../../ipc/client'
import { deriveConversation, friendlyError } from '../meta'
import { shortTaskId, formatUpdatedAt } from '../../types'
import { simplifyFirstLine } from '../../utils/title'
import type { TaskProgress } from '@shared/types/progress'
// v0.31.0 B1：流式缓冲 key 规则与落定交接下沉到纯模块（可在 node:test 密闭断言）
import { appendDelta, clearBuffers, settleReasonStep } from '../settle'
import type { AppState } from '../types'

export const conversationSlice: StateCreator<
  AppState,
  [],
  [],
  Pick<
    AppState,
    | 'steps'
    | 'refreshSteps'
    | 'toggleStep'
    | 'appendStep'
    | 'updateStep'
    | 'streamBuffers'
    | 'applyTextDelta'
    | 'clearStreamBuffer'
    | 'toolProgress'
    | 'activeProgressByTask'
    | 'taskProgress'
    | 'setTaskProgress'
    | 'updateTaskProgressStep'
    | 'markTaskProgressMilestone'
    | 'setTaskProgressStage'
    | 'getTaskProgress'
    | 'refreshTaskProgress'
    | 'conversation'
    | 'files'
    | 'selectedFile'
    | 'selectedFileContent'
    | 'selectedFileLanguage'
    | 'setSelectedFile'
    | 'refreshFiles'
    | 'logs'
    | 'appendLog'
    | 'refreshLogs'
  >
> = (set, get) => {
  const setAll = set as unknown as (
    partial: Partial<AppState> | ((s: AppState) => Partial<AppState>),
  ) => void
  return {

  // ReAct Trace
  steps: [],
  // v0.27.0 R1：流式增量缓冲（v0.31.0 B1 起 key=`${taskId}:${scope}:${kind}`）
  streamBuffers: {},
  // v0.14.0 Task 4：并行 Act 进度（per-requestId）
  toolProgress: {},
  activeProgressByTask: {},
  // Task 9：进度摘要（按 taskId 索引，独立持久化到 .arkwork/cache/task-progress.json）
  taskProgress: {},
  /**
   * Task 9：覆盖式写入任务进度摘要。
   * 通常由 `task:progress` 事件直接调用（Main → Renderer），无需派生计算。
   * 同时异步触发 IPC 持久化，避免页面切换或重启丢失。
   */
  setTaskProgress: (taskId, progress) => {
    const next: TaskProgress = { ...progress, updatedAt: Date.now() }
    setAll((s) => ({ taskProgress: { ...s.taskProgress, [taskId]: next } }))
    // 异步持久化（不阻塞渲染；失败仅记 warn，不抛错）
    void ark.task.progressSave({ taskId, progress: next }).catch((err) => {
      console.warn('[store] task.progressSave failed:', err)
    })
  },
  /**
   * Task 9：标记某 SubTask 完成（completed / failed）。
   * 内部维护 completedSteps 紧凑列表（最多保留最近 16 条，超出截断）；
   * 同时刷新 nextStep 与 overallPercentage。
   */
  updateTaskProgressStep: (taskId, stepId, status, label) => {
    const now = Date.now()
    const cur = get().taskProgress[taskId]
    if (!cur) return
    const completed = cur.completedSteps.filter((s) => s.id !== stepId)
    if (status === 'completed' || status === 'failed') {
      completed.unshift({
        id: stepId,
        label: label ?? stepId,
        status: status === 'completed' ? 'completed' : 'failed',
        completedAt: now,
      })
      // 紧凑列表：保留最近 16 条
      if (completed.length > 16) completed.length = 16
    }
    const updated: TaskProgress = {
      ...cur,
      completedSteps: completed,
      updatedAt: now,
    }
    setAll((s) => ({ taskProgress: { ...s.taskProgress, [taskId]: updated } }))
    void ark.task.progressSave({ taskId, progress: updated }).catch((err) => {
      console.warn('[store] task.progressSave failed:', err)
    })
  },
  /**
   * Task 9：标记里程碑到达（含可选产物路径）。
   * 已到达的 milestone 不重复置位；记录 reachedAt 与 artifactPath。
   */
  markTaskProgressMilestone: (taskId, milestoneId, artifactPath) => {
    const cur = get().taskProgress[taskId]
    if (!cur) return
    const now = Date.now()
    const milestones = cur.milestones.map((m) =>
      m.id === milestoneId
        ? { ...m, reachedAt: m.reachedAt ?? now, artifactPath: artifactPath ?? m.artifactPath }
        : m,
    )
    const updated: TaskProgress = { ...cur, milestones, updatedAt: now }
    setAll((s) => ({ taskProgress: { ...s.taskProgress, [taskId]: updated } }))
    void ark.task.progressSave({ taskId, progress: updated }).catch((err) => {
      console.warn('[store] task.progressSave failed:', err)
    })
  },
  /**
   * Task 9：阶段切换（currentStage / overallPercentage）。
   * 若 nextStepLabel 提供，则同步设置 nextStep（保持一字段存当前阶段下一步预览）。
   */
  setTaskProgressStage: (taskId, stage, overallPercentage, nextStepLabel) => {
    const cur = get().taskProgress[taskId]
    if (!cur) return
    const stageMeta = cur.stages.find((s) => s.id === stage)
    const updated: TaskProgress = {
      ...cur,
      currentStage: stage,
      currentStageLabel: stageMeta?.label ?? stage,
      currentStageIndex: stageMeta?.index ?? cur.currentStageIndex,
      overallPercentage: Math.max(0, Math.min(100, Math.round(overallPercentage))),
      nextStep: nextStepLabel ? { id: `next-${stage}`, label: nextStepLabel, status: 'running' } : cur.nextStep,
      updatedAt: Date.now(),
    }
    setAll((s) => ({ taskProgress: { ...s.taskProgress, [taskId]: updated } }))
    void ark.task.progressSave({ taskId, progress: updated }).catch((err) => {
      console.warn('[store] task.progressSave failed:', err)
    })
  },
  /**
   * Task 9：读取某任务的进度摘要（无则返回 undefined）。
   * 用于 ProgressPanel 派生渲染。
   */
  getTaskProgress: (taskId) => get().taskProgress[taskId],
  /**
   * Task 9：从主进程缓存恢复全部进度（应用启动时调用一次）。
   * 失败静默（缓存不存在视为首次启动，UI 自然走空态）。
   */
  refreshTaskProgress: async () => {
    try {
      const map = await ark.task.progressLoad()
      if (!map) return
      setAll({ taskProgress: map })
    } catch (err) {
      console.warn('[store] task.progressLoad failed:', err)
    }
  },
  refreshSteps: async (taskId) => {
    try {
      const steps = await ark.task.listSteps(taskId)
      setAll({ steps })
      const task = get().selectedTask
      setAll((s) => ({ conversation: deriveConversation(task, steps, s.memory) }))
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  toggleStep: (id) =>
    setAll((s) => ({
      steps: s.steps.map((p) => (p.id === id ? { ...p, expanded: !p.expanded } : p)),
    })),
  appendStep: (stepIn) =>
    setAll((s) => {
      // v0.31.0 B1（修 RC-3「落地瞬间跳变」）：落定交接逻辑全部在纯模块 `store/settle.ts`，
      // 此处只做接线 —— 缓冲 key 规则、取较长者、清哪条通道只有一份实现。
      const settled = settleReasonStep(stepIn, s.streamBuffers)
      const step = settled.step
      const exists = s.steps.find((p) => p.id === step.id)
      const nextSteps = exists
        ? s.steps.map((p) => (p.id === step.id ? step : p))
        : [...s.steps, step]
      return {
        steps: nextSteps,
        conversation: deriveConversation(s.selectedTask, nextSteps, s.memory),
        streamBuffers: settled.streamBuffers,
      }
    }),
  updateStep: (step) =>
    setAll((s) => {
      const nextSteps = s.steps.map((p) => (p.id === step.id ? step : p))
      return {
        steps: nextSteps,
        conversation: deriveConversation(s.selectedTask, nextSteps, s.memory),
      }
    }),

  // v0.27.0 R1：流式增量缓冲维护（v0.31.0 B1 起 key 三维 + 逻辑下沉纯模块）
  applyTextDelta: (payload) =>
    setAll((s) => {
      const next = appendDelta(s.streamBuffers, payload)
      // 乱序包 → 纯函数返回入参同一引用 → 不产生新状态（避免无谓重渲染）
      return next === s.streamBuffers ? s : { streamBuffers: next }
    }),
  clearStreamBuffer: (taskId, scope, kind) =>
    setAll((s) => {
      const next = clearBuffers(s.streamBuffers, taskId, scope, kind)
      return next === s.streamBuffers ? s : { streamBuffers: next }
    }),

  // 派生对话流
  conversation: [],

  // 文件树
  files: [],
  selectedFile: null,
  selectedFileContent: null,
  selectedFileLanguage: 'text',
  setSelectedFile: async (path) => {
    if (!path) {
      setAll({ selectedFile: null, selectedFileContent: null })
      return
    }
    setAll({ selectedFile: path, selectedFileContent: null })
    try {
      const content = await ark.fs.readFile(path)
      setAll({
        selectedFileContent: content.content,
        selectedFileLanguage: content.language,
      })
      // v0.31.0 B2：改为走 `fsSlice.openDoc` —— 它先经 `fs:read-text` 探针判定
      // 「可编辑 / 只读七原因」，可编辑则把 Tab 开成编辑器（§3.5 / §5.4.3）。
      // 修复前这里直连 `openPreview`，渲染器由 `detectRenderer` 按扩展名给，
      // 于是**任何文件都落在只读渲染器上**，编辑器永远不可达。
      void get().openDoc(path)
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  refreshFiles: async (taskId) => {
    try {
      const files = await ark.fs.listFiles(taskId)
      setAll({ files })
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },

  // Logs
  logs: [],
  appendLog: (entry) =>
    setAll((s) => ({ logs: [...s.logs.slice(-499), entry] })),
  refreshLogs: async (taskId) => {
    try {
      const logs = await ark.log.list(taskId)
      setAll({ logs })
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  }
}
