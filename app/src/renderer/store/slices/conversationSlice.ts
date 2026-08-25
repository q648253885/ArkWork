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
  // v0.27.0 R1：流式增量缓冲（key=`${taskId}:${scope}`）
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
  appendStep: (step) =>
    setAll((s) => {
      const exists = s.steps.find((p) => p.id === step.id)
      const nextSteps = exists
        ? s.steps.map((p) => (p.id === step.id ? step : p))
        : [...s.steps, step]
      // v0.27.0 R1：reason 步骤到达 → 权威内容已随 step 落地，清掉 turn 流式缓冲
      // 避免「流式预览 + 权威渲染」双份展示（R-stream-3）。
      let streamBuffers = s.streamBuffers
      if (step.type === 'reason' && s.streamBuffers[`${step.taskId}:turn`]) {
        streamBuffers = { ...s.streamBuffers }
        delete streamBuffers[`${step.taskId}:turn`]
      }
      return {
        steps: nextSteps,
        conversation: deriveConversation(s.selectedTask, nextSteps, s.memory),
        streamBuffers,
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

  // v0.27.0 R1：流式增量缓冲维护
  applyTextDelta: (payload) =>
    setAll((s) => {
      const key = `${payload.taskId}:${payload.scope}`
      const cur = s.streamBuffers[key]
      // seq 规则：顺序续写（seq===cur+1）或重启（seq===1 截断上一轮残流）；
      // 其余乱序包直接丢弃（R-stream-2）。
      if (cur && payload.seq !== cur.seq + 1 && payload.seq !== 1) return s
      const text =
        payload.seq === 1 || !cur ? payload.text : cur.text + payload.text
      return { streamBuffers: { ...s.streamBuffers, [key]: { seq: payload.seq, text } } }
    }),
  clearStreamBuffer: (taskId, scope) =>
    setAll((s) => {
      const targets = scope ? [`${taskId}:${scope}`] : [`${taskId}:turn`, `${taskId}:chat`]
      if (!targets.some((k) => k in s.streamBuffers)) return s
      const next = { ...s.streamBuffers }
      for (const k of targets) delete next[k]
      return { streamBuffers: next }
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
      // v0.7.0：文件选择后弹浮窗预览（取代右栏 Tab）
      void get().openPreview(path)
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
