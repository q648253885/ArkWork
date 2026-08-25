/* ============================================================
 * ArkWork — 自动化·知识库·Memory slice（v0.27.0 R3：自 store.ts 纯移动）
 * automations / knowledgeBases / memory / contextSize / cacheUsage；
 * refreshMemory 联动 conversation（跨域经 setAll）。
 * ============================================================ */
import type { StateCreator } from 'zustand'
import i18n from '../../i18n'
import { ark } from '../../ipc/client'
import { deriveConversation, friendlyError } from '../meta'
import type { AppState } from '../types'

export const kbMemorySlice: StateCreator<
  AppState,
  [],
  [],
  Pick<
    AppState,
    | 'automations'
    | 'knowledgeBases'
    | 'refreshAutomations'
    | 'createAutomation'
    | 'updateAutomation'
    | 'removeAutomation'
    | 'toggleAutomation'
    | 'runAutomation'
    | 'refreshKnowledge'
    | 'addKnowledge'
    | 'removeKnowledge'
    | 'memory'
    | 'refreshMemory'
    | 'toggleMemory'
    | 'contextSize'
    | 'setContextSize'
    | 'refreshContextSize'
    | 'cacheUsage'
  >
> = (set, get) => {
  const setAll = set as unknown as (
    partial: Partial<AppState> | ((s: AppState) => Partial<AppState>),
  ) => void
  return {
  // 模块视图数据（v0.5.0 B5→v0.6.4：改为真实后端数据）
  automations: [],
  knowledgeBases: [],
  refreshAutomations: async () => {
    try {
      const list = await ark.automation.list()
      setAll({ automations: list })
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  createAutomation: async (input) => {
    try {
      await ark.automation.create(input)
      await get().refreshAutomations()
      get().pushToast({ type: 'success', message: i18n.t('slice.kbMemory.automationCreated', { name: input.name }), duration: 3000 })
      return true
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
      return false
    }
  },
  updateAutomation: async (id, patch) => {
    try {
      await ark.automation.update(id, patch)
      await get().refreshAutomations()
      get().pushToast({ type: 'success', message: i18n.t('slice.kbMemory.automationUpdated'), duration: 3000 })
      return true
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
      return false
    }
  },
  removeAutomation: async (id) => {
    try {
      await ark.automation.remove(id)
      await get().refreshAutomations()
      get().pushToast({ type: 'success', message: i18n.t('slice.kbMemory.automationDeleted'), duration: 2000 })
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  toggleAutomation: async (id, status) => {
    try {
      await ark.automation.update(id, { status })
      await get().refreshAutomations()
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  runAutomation: async (id) => {
    try {
      // v0.9.1：主进程创建任务后立即启动运行；返回 taskId 后跳转过去看执行
      const { taskId } = await ark.automation.run(id)
      await get().refreshAutomations()
      await get().refreshTasks()
      // 从模块页跳回任务视图，直接看到运行过程
      if (get().modulePage) get().closeModulePage()
      await get().selectTask(taskId)
      get().pushToast({ type: 'success', message: i18n.t('slice.kbMemory.automationStarted'), duration: 3000 })
      return true
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
      return false
    }
  },
  refreshKnowledge: async () => {
    try {
      const list = await ark.kb.list()
      setAll({ knowledgeBases: list })
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  addKnowledge: async (input) => {
    try {
      await ark.kb.add(input)
      await get().refreshKnowledge()
      get().pushToast({ type: 'success', message: i18n.t('slice.kbMemory.kbAdded', { name: input.name }), duration: 3000 })
      return true
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
      return false
    }
  },
  removeKnowledge: async (id) => {
    try {
      await ark.kb.remove(id)
      await get().refreshKnowledge()
      get().pushToast({ type: 'success', message: i18n.t('slice.kbMemory.kbRemoved'), duration: 2000 })
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  // Memory
  memory: [],
  contextSize: null,
  setContextSize: (size) => setAll({ contextSize: size }),
  // v0.15.x：按需拉取任务真实 payload 估算（空闲/完成态也如实展示，不再只显示 L1 累加）
  refreshContextSize: async (taskId) => {
    try {
      const est = await ark.context.estimate(taskId)
      if (!est) return
      setAll({
        contextSize: {
          payloadTokens: est.payloadTokens,
          budget: est.budget,
          breakdown: est.breakdown,
          modelContextWindow: est.modelContextWindow,
          reportedAt: Date.now(),
        },
      })
    } catch (err) {
      // 估算失败静默：UI 回落 L1 累加口径
      console.warn('[store] refreshContextSize failed:', err)
    }
  },
  // v0.23.1：缓存命中统计初始为 null（未报告）
  cacheUsage: null,
  refreshMemory: async (taskId) => {
    try {
      const memory = await ark.memory.list(taskId)
      // v0.4.0-rev5：memory 更新后重新计算 conversation，
      // 因为 deriveConversation 现在从 memory 读取 user_message
      setAll((s) => ({
        memory,
        conversation: deriveConversation(s.selectedTask, s.steps, memory),
      }))
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  toggleMemory: async (taskId, id, enabled) => {
    try {
      await ark.memory.toggle(taskId, id, enabled)
      setAll((s) => ({
        memory: s.memory.map((m) => (m.id === id ? { ...m, enabled } : m)),
      }))
      // v0.5.0（B4）：勾选/取消后推送 ctx-chip，对话流可见上下文变更痕迹
      const activeCount = get().memory.filter((m) => m.enabled).length
      get().pushCtxChip({
        text: enabled
          ? i18n.t('slice.kbMemory.memoryEnabled')
          : i18n.t('slice.kbMemory.memoryDisabled'),
        variant: 'update',
      })
      void activeCount // 保留供未来精确文案（当前用 +/-1 占位）
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  }
}
