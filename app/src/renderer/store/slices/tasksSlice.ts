/* ============================================================
 * ArkWork — 任务域 slice（v0.27.0 R3：自 store.ts 纯移动）
 * 任务 CRUD / 乐观清单（v0.18.0 F1-F4）/ 建议 / 工作区；
 * 跨域写入（ui/files/logs/memory/conversation 等）经模块内 setAll。
 * ============================================================ */
import type { StateCreator } from 'zustand'
import i18n from '../../i18n'
import { ark } from '../../ipc/client'
import {
  clampWidth,
  deriveConversation,
  friendlyError,
  INSPECTOR_TAB_ORDER,
  resolveDockLayout,
  sanitizeHiddenTabs,
  sanitizeInspectorOrder,
} from '../meta'
import {
  loadActiveWorkspace,
  loadUiState,
  loadWorkspaces,
  saveActiveWorkspace,
  saveWorkspaces,
} from '../persist'
import { shortTaskId, formatUpdatedAt } from '../../types'
import { simplifyFirstLine } from '../../utils/title'
import type { AppState, DockPrefs, Workspace } from '../types'

/* ============================================================
 * v0.18.0 (03 §5)：Optimistic UI 2s TTL
 * markPlanItemOptimistic 启动定时器；超时未收到 patch 回执则
 * reject（Toast + 回滚，不卡死）。commit / reject 时清除。
 * ============================================================ */
const OPTIMISTIC_TTL_MS = 2000
const optimisticTimers = new Map<string, ReturnType<typeof setTimeout>>()

function clearOptimisticTimer(taskId: string, planItemId: string): void {
  const key = `${taskId}:${planItemId}`
  const timer = optimisticTimers.get(key)
  if (timer) {
    clearTimeout(timer)
    optimisticTimers.delete(key)
  }
}

export const tasksSlice: StateCreator<
  AppState,
  [],
  [],
  Pick<
    AppState,
    | 'tasks'
    | 'selectedTaskId'
    | 'selectedTask'
    | 'optimisticOverlay'
    | 'planListVersion'
    | 'planItemInFlight'
    | 'markPlanItemOptimistic'
    | 'commitPlanItemOptimistic'
    | 'rejectPlanItemOptimistic'
    | 'askUserQuestion'
    | 'suggestions'
    | 'setSuggestions'
    | 'clearSuggestions'
    | 'clearAskUser'
    | 'selectTask'
    | 'refreshTasks'
    | 'createTask'
    | 'sendMessage'
    | 'runTask'
    | 'pauseTask'
    | 'cancelTask'
    | 'resumeTask'
    | 'regenerateMessage'
    | 'exportConversation'
    | 'deleteTask'
    | 'toggleStar'
    | 'renameTask'
    | 'setTaskKbIds'
    | 'setTaskKbEnabled'
    | 'globalKbEnabled'
    | 'setGlobalKbEnabled'
    | 'workspaces'
    | 'activeWorkspaceId'
    | 'createWorkspace'
    | 'removeWorkspace'
    | 'switchWorkspace'
    | 'workspaceConfirmedForTask'
    | 'confirmWorkspace'
    | 'resetWorkspaceConfirm'
  >
> = (set, get) => {
  const setAll = set as unknown as (
    partial: Partial<AppState> | ((s: AppState) => Partial<AppState>),
  ) => void
  return {

  // 任务
  tasks: [],
  selectedTaskId: null,
  selectedTask: null,
  // v0.18.0：optimistic overlay（用户手动切状态后立即本地生效，patch 回执 reconcile）
  optimisticOverlay: {},
  planListVersion: {},
  planItemInFlight: {},
  markPlanItemOptimistic: (taskId, planItemId, targetStatus) => {
    const current = get().planListVersion[taskId] ?? 0
    // 客户端预测：patch 到达后 version 必然 = current + 1；用 clientVersion 标乐观版本
    const clientVersion = current + 1
    setAll((s) => ({
      optimisticOverlay: {
        ...s.optimisticOverlay,
        [taskId]: {
          ...(s.optimisticOverlay[taskId] ?? {}),
          [planItemId]: { targetStatus, submittedTs: Date.now(), clientVersion },
        },
      },
      planItemInFlight: {
        ...s.planItemInFlight,
        [taskId]: { ...(s.planItemInFlight[taskId] ?? {}), [planItemId]: 'submitted' },
      },
    }))
    // v0.18.0 (03 §5)：2s TTL 兜底 —— 超时仍未收到 patch 回执则回滚 + Toast
    const key = `${taskId}:${planItemId}`
    const existing = optimisticTimers.get(key)
    if (existing) clearTimeout(existing)
    optimisticTimers.set(
      key,
      setTimeout(() => {
        optimisticTimers.delete(key)
        const s = get()
        // 仍处于 submitted（未被 commit / reject）才回滚，避免与正常 patch 竞态
        if (s.planItemInFlight[taskId]?.[planItemId] === 'submitted') {
          s.rejectPlanItemOptimistic(taskId, planItemId, i18n.t('slice.tasks.requestTimeout'))
        }
      }, OPTIMISTIC_TTL_MS),
    )
    return clientVersion
  },
  commitPlanItemOptimistic: (taskId, planItemId) => {
    clearOptimisticTimer(taskId, planItemId)
    setAll((s) => {
      const next = { ...(s.optimisticOverlay[taskId] ?? {}) }
      delete next[planItemId]
      const nextFlight = { ...(s.planItemInFlight[taskId] ?? {}) }
      delete nextFlight[planItemId]
      return {
        optimisticOverlay: { ...s.optimisticOverlay, [taskId]: next },
        planItemInFlight: { ...s.planItemInFlight, [taskId]: nextFlight },
      }
    })
  },
  rejectPlanItemOptimistic: (taskId, planItemId, reason) => {
    clearOptimisticTimer(taskId, planItemId)
    setAll((s) => {
      const next = { ...(s.optimisticOverlay[taskId] ?? {}) }
      delete next[planItemId]
      const nextFlight = { ...(s.planItemInFlight[taskId] ?? {}) }
      delete nextFlight[planItemId]
      return {
        optimisticOverlay: { ...s.optimisticOverlay, [taskId]: next },
        planItemInFlight: { ...s.planItemInFlight, [taskId]: nextFlight },
      }
    })
    // 弹 Toast 提示拒绝原因（不阻塞 UI）
    const toastId = get().pushToast({
      type: 'warning',
      level: 'critical',
      message: i18n.t('slice.tasks.planRejected', { reason }),
      duration: 4000,
    })
    void toastId
  },
  askUserQuestion: null,
  // Task 4：建议优先的任务交互 — 建议卡片状态
  suggestions: [],
  setSuggestions: (suggestions) => setAll({ suggestions }),
  clearSuggestions: () => setAll({ suggestions: [] }),
  // v0.27.1：ask_user 门禁双清——问题全文与建议卡片必须同时清空，
  // 避免只清其一导致下一轮提问残留上一轮状态（缺陷 D1）
  clearAskUser: () => setAll({ askUserQuestion: null, suggestions: [] }),
  selectTask: async (id) => {
    // Task 4：任务切换时清空建议卡片 + ask_user 暂停态
    setAll({ selectedTaskId: id, askUserQuestion: null, contextSize: null, suggestions: [], cacheUsage: null })
    const task = get().tasks.find((t) => t.id === id) ?? null
    setAll({ selectedTask: task })
    // 加载相关数据（文件列表恒为工作区根目录，v0.6.3）
    await Promise.all([
      get().refreshMemory(id),
      get().refreshContextSize(id),
      get().refreshSteps(id),
      get().refreshFiles(),
      get().refreshLogs(id),
    ])
    // 重新计算 conversation（v0.4.0-rev5：传入 memory 以显示 L1 中的 user_message）
    setAll((s) => ({ conversation: deriveConversation(task, s.steps, s.memory) }))
    // v0.18.0 F2：切换任务时主动拉取一次 planItems 整对象（防止长时间挂起后 patch 队列堆积）
    try {
      const planItems = await ark.task.fetchPlanItemList(id)
      const current = get().planListVersion[id] ?? 0
      if (planItems && planItems.length >= 0) {
        setAll((s) => ({
          tasks: s.tasks.map((t) => (t.id === id ? { ...t, planItems } : t)),
          // 注意：fetchPlanItemList 不返回 version，仅作为 hydrate；后续 patch 仍以 push 为准
          optimisticOverlay: { ...s.optimisticOverlay, [id]: {} },
          planItemInFlight: { ...s.planItemInFlight, [id]: {} },
        }))
      }
      void current
    } catch (err) {
      // 静默忽略：hydrate 失败不影响主链路；后续 patch 仍能推进
      void err
    }
  },
  refreshTasks: async () => {
    try {
      const tasks = await ark.task.list()
      setAll({ tasks })
      // 如果当前选中任务不在列表中，清空选中
      const sel = get().selectedTaskId
      if (sel && !tasks.find((t) => t.id === sel)) {
        setAll({ selectedTaskId: null, selectedTask: null, conversation: [] })
      }
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  createTask: async (input) => {
    try {
      // 新建任务时清空 ask_user 暂停态与建议卡片
      setAll({ askUserQuestion: null, suggestions: [] })
      // v0.4.0-rev3：复用空任务——本次创建为空任务（text===''）且当前选中任务是空任务
      // （pending + input.text==='' + 无对话）时，直接返回当前任务，不创建新的。
      // 避免用户连续点"新建任务"堆积一堆空任务。
      // 安全性：rev2 已用随机 ID 解决覆盖问题，复用时直接返回不调用后端 createTask，无 ID 冲突。
      // sendMessage 路径带 text 非空，天然不触发复用。
      const currentTaskId = get().selectedTaskId
      const currentTask = currentTaskId
        ? get().tasks.find((t) => t.id === currentTaskId)
        : null
      const isCurrentEmpty =
        !!currentTask &&
        currentTask.status === 'pending' &&
        currentTask.input.text === '' &&
        get().conversation.length === 0
      if (input.text === '' && isCurrentEmpty && currentTask) {
        // 复用当前空任务——不调用后端，不增加任务数
        return currentTask
      }

      const agentId = get().selectedAgentId || '@default'
      const modelId = get().selectedModelId
      if (!modelId) {
        get().pushToast({ type: 'warning', message: i18n.t('slice.tasks.selectModelFirst'), duration: 4000 })
        return null
      }
      const skillIds = get().selectedSkillIds
      // v0.24.2.1：透传当前选中的 MCP server 列表，让 engine.assembleTools 把
      //   对应 server 的所有 tool 纳入 LLM 工具集（之前仅 selectedSkillIds，
      //   MCP tools 永远到不了 Agent 视野）。
      const mcpIds = get().selectedMcpIds
      const task = await ark.task.create({
        title: input.title,
        text: input.text,
        agentId,
        skillIds,
        mcpIds,
        modelId,
      })
      await get().refreshTasks()
      await get().selectTask(task.id)
      // 自动展开左侧导航栏，便于用户定位到新建的任务
      if (get().leftNavCollapsed) {
        get().setLeftNavCollapsed(false)
      }
      return task
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
      return null
    }
  },
  sendMessage: async (text) => {
    try {
      // v0.27.1：发送新消息时双清 ask_user 状态（用户已做出决策/输入）
      setAll({ askUserQuestion: null, suggestions: [] })
      const taskId = get().selectedTaskId
      const modelId = get().selectedModelId
      if (!modelId) {
        get().pushToast({ type: 'warning', message: i18n.t('slice.tasks.selectModelFirst'), duration: 4000 })
        return
      }
      // 有选中任务 → 追加消息并续聊；否则新建任务
      if (taskId) {
        // v0.6.5：先检查任务是否仍存在于 tasks.json（防止数据丢失后前端残留 selectedTaskId）
        const existing = get().tasks.find((t) => t.id === taskId)
        if (!existing) {
          // 任务记录已丢失——自动降级为新建任务，避免 "Task not found" 阻塞用户
          setAll({ selectedTaskId: null, selectedTask: null, conversation: [], steps: [], memory: [] })
          const task = await get().createTask({ title: text.slice(0, 40), text })
          if (task) await get().runTask(task.id)
          return
        }
        // v0.4.0：续聊时用当前选中的 modelId 更新任务，修复旧任务 modelId 失效问题
        if (existing.modelId !== modelId) {
          await ark.task.update({ id: taskId, modelId })
        }
        // v0.8.0：@ 引用的技能合并进任务（续聊路径此前会静默丢失 skillIds）
        const pickedSkills = get().selectedSkillIds
        if (pickedSkills.length > 0) {
          const merged = [...new Set([...(existing.skillIds ?? []), ...pickedSkills])]
          if (merged.length !== (existing.skillIds ?? []).length) {
            await ark.task.update({ id: taskId, skillIds: merged })
          }
        }
        // v0.24.2.1：镜像 skillIds 处理 — 续聊也合并 mcpIds，避免「上一轮没勾选
        //   MCP → 本轮续聊后 Agent 仍看不见插件工具」。
        const pickedMcps = get().selectedMcpIds
        if (pickedMcps.length > 0) {
          const mergedMcps = [...new Set([...(existing.mcpIds ?? []), ...pickedMcps])]
          if (mergedMcps.length !== (existing.mcpIds ?? []).length) {
            await ark.task.update({ id: taskId, mcpIds: mergedMcps })
          }
        }
        await ark.task.appendMessage(taskId, text)
        // v0.16.7+：appendMessage 内部已自动 cancel + run，renderer 不再重复调 runTask，
        // 避免与 main 进程内 fire-and-forget 的 runTask 产生竞态。
        // polish2-workspace-name-task-title-skills-warning §Task 2：续聊路径首条消息触发自动重命名。
        // 仅在 title 仍是占位"未命名任务"或"未命名任务 N"时覆盖，已手动重命名则保留。
        const placeholder = /^未命名任务(\s\d+)?$/
        if (placeholder.test(existing.title)) {
          const simplified = simplifyFirstLine(text)
          if (simplified) {
            await get().renameTask(taskId, simplified)
          }
        }
        await get().refreshTasks()
        await get().refreshMemory(taskId)
        // v0.16.7+：不再调 ark.task.run —— appendMessage 内部已自动触发。
      } else {
        const task = await get().createTask({ title: simplifyFirstLine(text), text })
        if (task) {
          await get().runTask(task.id)
        } else {
          // createTask 返回 null（无模型）——error 已 set，此处补一句明确提示
          get().pushToast({ type: 'warning', message: get().error || i18n.t('slice.tasks.taskCreateFailed'), duration: 4000 })
        }
      }
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  runTask: async (id) => {
    try {
      await ark.task.run(id)
    } catch (err) {
      // Phase A Task 4：模型相关错误视为 critical（用户必须介入处理）
      const msg = friendlyError(err)
      const level = /模型|model|api key|api_key|余额|认证/i.test(msg) ? 'critical' : 'info'
      get().pushToast({ type: 'danger', level, message: msg, duration: 0 })
    }
  },
  pauseTask: async (id) => {
    try {
      await ark.task.pause(id)
      // v0.27.1：暂停成功后防御性双清（手动暂停不应残留任何 ask 状态）
      setAll({ askUserQuestion: null, suggestions: [] })
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  cancelTask: async (id) => {
    try {
      await ark.task.cancel(id)
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  /**
   * 恢复已暂停的任务（B1）。
   * @param id - 任务 id
   * 错误场景：任务非 paused 态、后端 resume 失败 → Toast 提示。
   */
  resumeTask: async (id) => {
    try {
      await ark.task.resume(id)
      // v0.27.1：恢复成功后双清问题卡片与建议卡片（原仅清问题、漏清建议 → 缺陷 D1）
      setAll({ askUserQuestion: null, suggestions: [] })
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  /**
   * 从指定 iteration 重新生成（B3）。
   * @param taskId - 任务 id
   * @param iteration - 重新生成的起始 iteration
   * v0.5.0 限制：后端 runner.ts 暂无「回滚到指定 iteration」能力，
   * 退化为「整轮重跑」——重置状态为 pending 后重新 run。后端能力就绪后升级为精确回滚。
   */
  regenerateMessage: async (taskId, _iteration) => {
    try {
      await ark.task.update({ id: taskId, status: 'pending' })
      await ark.task.run(taskId)
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  /**
   * 导出当前任务对话为 Markdown 文件（B3，提取自 Composer）。
   * 读 selectedTask + conversation，生成 Blob → 下载。
   * 无选中任务时静默返回。
   */
  exportConversation: () => {
    const task = get().selectedTask
    if (!task) return
    const items = get().conversation
    const lines: string[] = [`# ${task.title}`, '']
    for (const it of items) {
      if (it.type === 'user') {
        lines.push('## You', '')
        lines.push(it.text ?? '', '')
      } else if (it.type === 'assistant') {
        lines.push(`## @${task.agentId}`, '')
        lines.push(it.text ?? '', '')
      } else if (it.type === 'react' && it.steps) {
        lines.push(`### ${i18n.t('slice.tasks.exportStepStream')}`, '')
        for (const s of it.steps) {
          lines.push(`- [${s.type}] ${s.summary || s.thought || ''}`)
        }
        lines.push('')
      }
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${shortTaskId(task.id)}.md`
    a.click()
    URL.revokeObjectURL(url)
  },
  deleteTask: async (id) => {
    try {
      await ark.task.delete(id)
      // 如果删除的是当前选中任务，清空选中
      if (get().selectedTaskId === id) {
        setAll({ selectedTaskId: null, selectedTask: null, conversation: [], steps: [], memory: [], contextSize: null, cacheUsage: null })
      }
      // Task 9：删除任务时同步清理内存中的进度摘要（持久化缓存由 IPC 层清理，
      // 这里只清理前端状态，避免下次同名任务误读旧进度）
      setAll((s) => {
        if (!(id in s.taskProgress)) return {}
        const next = { ...s.taskProgress }
        delete next[id]
        return { taskProgress: next }
      })
      await get().refreshTasks()
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  toggleStar: async (id) => {
    try {
      const task = get().tasks.find((t) => t.id === id)
      if (!task) return
      const next = !task.starred
      await ark.task.update({ id, starred: next })
      setAll((s) => ({
        tasks: s.tasks.map((t) => (t.id === id ? { ...t, starred: next } : t)),
      }))
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  renameTask: async (id, title) => {
    try {
      await ark.task.update({ id, title })
      setAll((s) => ({
        tasks: s.tasks.map((t) => (t.id === id ? { ...t, title } : t)),
        selectedTask: s.selectedTaskId === id ? { ...s.selectedTask!, title } : s.selectedTask,
      }))
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  setTaskKbIds: async (taskId, kbIds) => {
    try {
      await ark.task.update({ id: taskId, kbIds })
      setAll((s) => ({
        tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, kbIds } : t)),
      }))
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  // Task 8：会话级 KB 开关
  setTaskKbEnabled: async (taskId, enabled) => {
    try {
      await ark.task.update({ id: taskId, kbEnabled: enabled })
      setAll((s) => ({
        tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, kbEnabled: enabled } : t)),
        selectedTask: s.selectedTaskId === taskId ? { ...s.selectedTask!, kbEnabled: enabled } : s.selectedTask,
      }))
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  // Task 8：全局 KB 开关（持久化到 settings.json；下次启动 init 重新读取）
  globalKbEnabled: true,
  setGlobalKbEnabled: async (enabled) => {
    setAll({ globalKbEnabled: enabled })
    try {
      await window.ark.settings.set({ kbEnabled: enabled })
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err, i18n.t('slice.tasks.kbSaveFailed')), duration: 0 })
    }
  },

  // ---- 工作区管理 ----
  workspaces: loadWorkspaces(),
  activeWorkspaceId: loadActiveWorkspace(),
  // Phase A Task 2：工作区确认状态（会话级内存，不持久化）
  workspaceConfirmedForTask: {},
  confirmWorkspace: (taskId) =>
    setAll((s) => ({
      workspaceConfirmedForTask: { ...s.workspaceConfirmedForTask, [taskId]: true },
    })),
  resetWorkspaceConfirm: (taskId) =>
    setAll((s) => {
      if (taskId === '*') return { workspaceConfirmedForTask: {} }
      if (!(taskId in s.workspaceConfirmedForTask)) return {}
      const next = { ...s.workspaceConfirmedForTask }
      delete next[taskId]
      return { workspaceConfirmedForTask: next }
    }),
  createWorkspace: async () => {
    try {
      const path = await window.ark.settings.pickWorkspace()
      if (!path) return // 用户取消
      // 从路径提取文件夹名作为工作区名
      const folderName = path.split('/').pop() || i18n.t('slice.tasks.unnamedWorkspace')
      const ws: Workspace = {
        id: `ws-${Date.now()}`,
        name: folderName,
        path,
        createdAt: Date.now(),
      }
      const next = [...get().workspaces, ws]
      saveWorkspaces(next)
      setAll({ workspaces: next })
      // 切换到新工作区
      await get().switchWorkspace(ws.id)
    } catch (err) {
      get().pushToast({ type: 'danger', message: i18n.t('slice.tasks.createWorkspaceFailed', { error: (err as Error).message }), duration: 0 })
    }
  },
  removeWorkspace: (id) => {
    if (id === 'default') return // 默认工作区不可移除
    const remaining = get().workspaces.filter((w) => w.id !== id)
    if (remaining.length === 0) return
    saveWorkspaces(remaining)
    // 先更新 workspaces 列表（无论是否当前激活，都要从列表移除）
    setAll({ workspaces: remaining })
    // 如果移除的是当前工作区，切回 default
    if (get().activeWorkspaceId === id) {
      void get().switchWorkspace('default')
    }
  },
  switchWorkspace: async (id) => {
    const ws = get().workspaces.find((w) => w.id === id)
    if (!ws) return
    try {
      // 后端切换 workspaceDir（空路径=内置 default 目录，其他用关联路径）
      await window.ark.settings.activateWorkspace(ws.path)
      saveActiveWorkspace(id)
      setAll({
        activeWorkspaceId: id,
        selectedTaskId: null,
        selectedTask: null,
        conversation: [],
        steps: [],
        memory: [],
        files: [],
        logs: [],
        selectedFile: null,
        selectedFileContent: null,
        contextSize: null,
        cacheUsage: null,
        modulePage: null,
        // Phase A Task 2：切换工作区 → 清空所有任务的确认缓存（路径变了旧确认失效）
        workspaceConfirmedForTask: {},
        // v0.9.0：ui-state 按工作区隔离 — 切换后重载该工作区布局
        // v0.13.0：宽度值加载时也必须 clamp 到合法范围（64–320 / 280–480）
        leftNavCollapsed: loadUiState('leftnav', false),
        rightDockCollapsed: loadUiState('rightdock', false),
        rightDockWidth: clampWidth(loadUiState('rightdock-w', 360), 280, 480),
        sidePanelWidth: clampWidth(loadUiState('sidepanel-w', 240), 64, 320),
        dockPrefs: loadUiState<Record<string, DockPrefs>>('dockprefs', {}),
        inspectorTabOrder: sanitizeInspectorOrder(loadUiState('inspector-tab-order', INSPECTOR_TAB_ORDER)),
        hiddenInspectorTabs: sanitizeHiddenTabs(loadUiState('inspector-tab-hidden', [])),
      })
      // 同步当前智能体的 Dock 布局
      const agentId = get().selectedAgentId
      if (agentId) {
        const layout = resolveDockLayout(agentId, get().dockPrefs[agentId])
        setAll({ dockTabs: layout.tabs, dockDefaultTab: layout.defaultTab, activeDockTab: layout.defaultTab })
      }
      // 刷新任务列表（新工作区目录下的任务）
      await get().refreshTasks()
      // v0.11.0 F1103：切换工作区留痕 — 对话流插入 chip（可追溯「记忆怎么变了」）
      get().pushCtxChip({
        text: i18n.t('slice.tasks.workspaceSwitched', { name: ws.name }),
        variant: 'update',
      })
    } catch (err) {
      get().pushToast({ type: 'danger', message: i18n.t('slice.tasks.switchWorkspaceFailed', { error: (err as Error).message }), duration: 0 })
    }
  },
  }
}
