/* ============================================================
 * ArkWork — 目录·编辑器·选择器 slice（v0.27.0 R3：自 store.ts 纯移动）
 * agents/skills/mcps/models 目录 + 三类编辑器 CRUD + Picker 选择状态；
 * refreshCatalog / setSelectedAgent 联动 Dock 布局（跨域经 setAll）。
 * ============================================================ */
import type { StateCreator } from 'zustand'
import { ark } from '../../ipc/client'
import i18n from '../../i18n'
import { classifyLlmError, friendlyError, resolveDockLayout } from '../meta'
import type { AppState } from '../types'

export const catalogSlice: StateCreator<
  AppState,
  [],
  [],
  Pick<
    AppState,
    | 'agents'
    | 'skills'
    | 'mcps'
    | 'models'
    | 'refreshCatalog'
    | 'addModel'
    | 'updateModel'
    | 'removeModel'
    | 'testModel'
    | 'agentEditorOpen'
    | 'editingAgent'
    | 'openAgentEditor'
    | 'closeAgentEditor'
    | 'addAgent'
    | 'updateAgent'
    | 'removeAgent'
    | 'skillEditorOpen'
    | 'editingSkill'
    | 'openSkillEditor'
    | 'closeSkillEditor'
    | 'addSkill'
    | 'updateSkill'
    | 'removeSkill'
    | 'toggleSkillEnabled'
    | 'importSkill'
    | 'exportSkill'
    | 'readSkillInstruction'
    | 'mcpEditorOpen'
    | 'editingMcp'
    | 'openMcpEditor'
    | 'closeMcpEditor'
    | 'addMcp'
    | 'updateMcp'
    | 'removeMcp'
    | 'connectMcp'
    | 'disconnectMcp'
    | 'selectedAgentId'
    | 'setSelectedAgent'
    | 'selectedSkillIds'
    | 'toggleSkill'
    | 'selectedMcpIds'
    | 'toggleMcp'
    | 'selectedModelId'
    | 'setSelectedModel'
    | 'openPicker'
    | 'setOpenPicker'
  >
> = (set, get) => {
  const setAll = set as unknown as (
    partial: Partial<AppState> | ((s: AppState) => Partial<AppState>),
  ) => void
  return {

  // Catalog
  agents: [],
  skills: [],
  mcps: [],
  models: [],
  refreshCatalog: async () => {
    try {
      const [agents, skills, mcps, models] = await Promise.all([
        ark.agent.list(),
        ark.skill.list(),
        ark.mcp.list(),
        ark.model.list(),
      ])
      setAll({
        agents,
        skills,
        mcps,
        models,
        // v0.6.4：默认选中 @default agent（通用助手始终存在）
        selectedAgentId: get().selectedAgentId || agents.find((a) => a.id === '@default')?.id || agents[0]?.id || '',
        // v0.3.0：默认选中第一个启用的模型，避免用户每次手动选择
        // v0.25.1：优先恢复上次持久化的选择（存在且仍在模型中），否则回退到首个启用模型
        selectedModelId: (() => {
          const last = (() => { try { return localStorage.getItem('arkwork:selected-model-id') || '' } catch { return '' } })()
          if (last && models.some((m) => m.id === last)) return last
          return get().selectedModelId || models.find((m) => m.enabled)?.id || models[0]?.id || ''
        })(),
      })
      // v0.9.0 F905：目录加载后同步 RightDock 布局
      const agentId = get().selectedAgentId
      if (agentId) {
        const layout = resolveDockLayout(agentId, get().dockPrefs[agentId])
        setAll({
          dockTabs: layout.tabs,
          dockDefaultTab: layout.defaultTab,
          activeDockTab: layout.tabs.includes(get().activeDockTab) ? get().activeDockTab : layout.defaultTab,
        })
      }
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },

  addModel: async (model) => {
    try {
      await ark.model.add(model)
      await get().refreshCatalog()
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  updateModel: async (model) => {
    try {
      await ark.model.update(model)
      await get().refreshCatalog()
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  removeModel: async (id) => {
    try {
      await ark.model.remove(id)
      await get().refreshCatalog()
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  testModel: async (req) => {
    try {
      return await ark.model.test(req)
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    }
  },

  // ---- v0.6.0 Agent CRUD ----
  agentEditorOpen: false,
  editingAgent: null,
  openAgentEditor: (agent) =>
    setAll({ agentEditorOpen: true, editingAgent: agent ?? null }),
  closeAgentEditor: () => setAll({ agentEditorOpen: false, editingAgent: null }),
  addAgent: async (input) => {
    try {
      const agent = await ark.agent.add(input)
      await get().refreshCatalog()
      setAll({ agentEditorOpen: false, editingAgent: null })
      get().pushToast({ type: 'success', message: i18n.t('slice.catalog.createdAgent', { name: agent.name }), duration: 3000 })
      return agent
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
      return null
    }
  },
  updateAgent: async (id, patch) => {
    try {
      const agent = await ark.agent.update(id, patch)
      await get().refreshCatalog()
      setAll({ agentEditorOpen: false, editingAgent: null })
      get().pushToast({ type: 'success', message: i18n.t('slice.catalog.agentUpdated'), duration: 3000 })
      return agent
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
      return null
    }
  },
  removeAgent: async (id) => {
    const agent = get().agents.find((a) => a.id === id)
    const ok = await get().confirm({
      title: i18n.t('slice.catalog.deleteAgentTitle'),
      body: i18n.t('slice.catalog.deleteAgentBody', { name: agent?.name ?? id }),
      confirmLabel: i18n.t('slice.catalog.delete'),
      danger: true,
    })
    if (!ok) return false
    try {
      await ark.agent.remove(id)
      await get().refreshCatalog()
      // 若删除的是当前选中 agent，回退到第一个
      if (get().selectedAgentId === id) {
        const next = get().agents[0]?.id ?? ''
        setAll({ selectedAgentId: next })
      }
      get().pushToast({ type: 'success', message: i18n.t('slice.catalog.agentDeleted'), duration: 3000 })
      return true
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
      return false
    }
  },

  // ---- v0.6.0 Skill CRUD ----
  skillEditorOpen: false,
  editingSkill: null,
  openSkillEditor: (skill) =>
    setAll({ skillEditorOpen: true, editingSkill: skill ?? null }),
  closeSkillEditor: () => setAll({ skillEditorOpen: false, editingSkill: null }),
  addSkill: async (input) => {
    try {
      const skill = await ark.skill.add(input)
      await get().refreshCatalog()
      setAll({ skillEditorOpen: false, editingSkill: null })
      get().pushToast({ type: 'success', message: i18n.t('slice.catalog.createdSkill', { name: skill.name }), duration: 3000 })
      return skill
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
      return null
    }
  },
  updateSkill: async (patch) => {
    try {
      const skill = await ark.skill.update(patch)
      await get().refreshCatalog()
      setAll({ skillEditorOpen: false, editingSkill: null })
      get().pushToast({ type: 'success', message: i18n.t('slice.catalog.skillUpdated'), duration: 3000 })
      return skill
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
      return null
    }
  },
  removeSkill: async (id) => {
    const skill = get().skills.find((s) => s.id === id)
    const ok = await get().confirm({
      title: i18n.t('slice.catalog.deleteSkillTitle'),
      body: i18n.t('slice.catalog.deleteSkillBody', { name: skill?.name ?? id }),
      confirmLabel: i18n.t('slice.catalog.delete'),
      danger: true,
    })
    if (!ok) return false
    try {
      await ark.skill.remove(id)
      await get().refreshCatalog()
      // 从会话级选中中移除
      setAll((s) => ({
        selectedSkillIds: s.selectedSkillIds.filter((x) => x !== id),
      }))
      get().pushToast({ type: 'success', message: i18n.t('slice.catalog.skillDeleted'), duration: 3000 })
      return true
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
      return false
    }
  },
  toggleSkillEnabled: async (id, enabled) => {
    try {
      await ark.skill.toggle(id, enabled)
      await get().refreshCatalog()
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  importSkill: async (dirPath) => {
    try {
      const skill = await ark.skill.importFromDir(dirPath ?? '')
      await get().refreshCatalog()
      get().pushToast({ type: 'success', message: i18n.t('slice.catalog.importedSkill', { name: skill.name }), duration: 3000 })
      return skill
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
      return null
    }
  },
  exportSkill: async (id, targetDir) => {
    try {
      const result = await ark.skill.exportToDir(id, targetDir ?? '')
      const msg = result.isZip
        ? i18n.t('slice.catalog.exportedZip', { count: result.fileCount, path: result.path })
        : i18n.t('slice.catalog.exportedDir', { count: result.fileCount, path: result.path })
      get().pushToast({ type: 'success', message: msg, duration: 5000 })
      return result
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
      return null
    }
  },
  readSkillInstruction: async (id) => {
    try {
      return await ark.skill.readInstruction(id)
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
      return null
    }
  },

  // ---- v0.6.0 Mcp CRUD ----
  mcpEditorOpen: false,
  editingMcp: null,
  openMcpEditor: (mcp) =>
    setAll({ mcpEditorOpen: true, editingMcp: mcp ?? null }),
  closeMcpEditor: () => setAll({ mcpEditorOpen: false, editingMcp: null }),
  addMcp: async (input) => {
    try {
      const mcp = await ark.mcp.add(input)
      await get().refreshCatalog()
      setAll({ mcpEditorOpen: false, editingMcp: null })
      get().pushToast({ type: 'success', message: i18n.t('slice.catalog.mcpAdded', { name: mcp.name }), duration: 3000 })
      return mcp
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
      return null
    }
  },
  updateMcp: async (id, patch) => {
    try {
      const mcp = await ark.mcp.update(id, patch)
      await get().refreshCatalog()
      setAll({ mcpEditorOpen: false, editingMcp: null })
      get().pushToast({ type: 'success', message: i18n.t('slice.catalog.mcpUpdated'), duration: 3000 })
      return mcp
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
      return null
    }
  },
  removeMcp: async (id) => {
    const mcp = get().mcps.find((m) => m.id === id)
    const ok = await get().confirm({
      title: i18n.t('slice.catalog.deleteMcpTitle'),
      body: i18n.t('slice.catalog.deleteMcpBody', { name: mcp?.name ?? id }),
      confirmLabel: i18n.t('slice.catalog.delete'),
      danger: true,
    })
    if (!ok) return false
    try {
      await ark.mcp.remove(id)
      await get().refreshCatalog()
      setAll((s) => ({
        selectedMcpIds: s.selectedMcpIds.filter((x) => x !== id),
      }))
      get().pushToast({ type: 'success', message: i18n.t('slice.catalog.mcpDeleted'), duration: 3000 })
      return true
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
      return false
    }
  },
  connectMcp: async (id) => {
    try {
      await ark.mcp.connect(id)
      await get().refreshCatalog()
      get().pushToast({ type: 'success', message: i18n.t('slice.catalog.mcpConnected'), duration: 3000 })
      return true
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err, i18n.t('slice.catalog.mcpConnectFailed')), duration: 0 })
      return false
    }
  },
  disconnectMcp: async (id) => {
    try {
      await ark.mcp.disconnect(id)
      await get().refreshCatalog()
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  // Pickers
  selectedAgentId: '',
  setSelectedAgent: (id) =>
    setAll((s) => {
      // v0.9.0 F905：RightDock 随智能体自适应（预设 × 用户偏好）
      const layout = resolveDockLayout(id, s.dockPrefs[id])
      return {
        selectedAgentId: id,
        dockTabs: layout.tabs,
        dockDefaultTab: layout.defaultTab,
        // 兜底规则：当前选中 Tab 在新预设中不存在 → 选中 defaultTab
        activeDockTab: layout.tabs.includes(s.activeDockTab) ? s.activeDockTab : layout.defaultTab,
      }
    }),
  selectedSkillIds: [],
  toggleSkill: (id) =>
    setAll((s) => ({
      selectedSkillIds: s.selectedSkillIds.includes(id)
        ? s.selectedSkillIds.filter((x) => x !== id)
        : [...s.selectedSkillIds, id],
    })),
  selectedMcpIds: [],
  toggleMcp: (id) =>
    setAll((s) => ({
      selectedMcpIds: s.selectedMcpIds.includes(id)
        ? s.selectedMcpIds.filter((x) => x !== id)
        : [...s.selectedMcpIds, id],
    })),
  selectedModelId: '',
  setSelectedModel: (id) => {
    // v0.9.0 F904 §4.3：切换模型留痕 — 对话流插入非模态 chip
    // v0.27.0 R3：slice 内禁止 useStore 自引用，改经组合后的 get()
    const s = get()
    if (s.selectedModelId && s.selectedModelId !== id) {
      const model = s.models.find((m) => m.id === id)
      if (model) {
        s.pushCtxChip({
          text: i18n.t('slice.catalog.modelSwitched', { model: model.name || model.id }),
          variant: 'update',
        })
      }
    }
    setAll({ selectedModelId: id })
    // v0.25.1：持久化所选模型，重启后保持上次选择（例：MiniMax M3）
    try { localStorage.setItem('arkwork:selected-model-id', id) } catch { /* ignore */ }
  },
  openPicker: null,
  setOpenPicker: (p) => setAll({ openPicker: p }),
  }
}
