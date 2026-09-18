/* ============================================================
 * ArkWork — Preload Script
 * 设计文档 §8.4
 * 通过 contextBridge 暴露 ark API 给 Renderer
 * ============================================================ */
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import type { ArkApi, PermissionModeEvent } from '@shared/types/ipc'
import { decodeFsError } from '@shared/utils/fs-error'
import type { FsBatchEvent, FsErrorCode } from '@shared/types/fs'

/**
 * v0.31.0 B2：把主进程经 `throwEncodedFsError` 包装过的 FsError 还原为
 * 带 `code` / `payload` 的 Error。
 *
 * 原因：`ipcRenderer.invoke` 的 reject 只会保留 Error.message，
 * 而 §5.2 契约要求渲染层能按 `E_CONFLICT` 分支并读取 `ConflictInfo` 载荷。
 * 本函数是 preload 侧**唯一**的非纯转发逻辑，只做载荷还原、不做类型重声明。
 */
async function invokeFs<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as T
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const decoded = decodeFsError(message)
    if (decoded) {
      const out = new Error(decoded.message) as Error & { code?: FsErrorCode; payload?: unknown }
      out.code = decoded.code
      out.payload = decoded.payload
      throw out
    }
    throw err
  }
}

const ark: ArkApi = {
  task: {
    list: () => ipcRenderer.invoke('task:list'),
    get: (id) => ipcRenderer.invoke('task:get', id),
    create: (input) => ipcRenderer.invoke('task:create', input),
    update: (patch) => ipcRenderer.invoke('task:update', patch),
    delete: (id) => ipcRenderer.invoke('task:delete', id),
    run: (id) => ipcRenderer.invoke('task:run', id),
    pause: (id) => ipcRenderer.invoke('task:pause', id),
    resume: (id) => ipcRenderer.invoke('task:resume', id),
    cancel: (id) => ipcRenderer.invoke('task:cancel', id),
    appendMessage: (taskId, text) => ipcRenderer.invoke('task:append-message', { taskId, text }),
    listSteps: (taskId) => ipcRenderer.invoke('task:steps', taskId),
    onStep: (cb) => {
      const handler = (_e: IpcRendererEvent, step: Parameters<typeof cb>[0]) => cb(step)
      ipcRenderer.on('task:step', handler)
      return () => ipcRenderer.removeListener('task:step', handler)
    },
    /** v0.27.0 R1：流式文本增量订阅（渲染加速通道；完整响应仍以 task:step 为准） */
    onTextDelta: (cb) => {
      const handler = (_e: IpcRendererEvent, payload: Parameters<typeof cb>[0]) => cb(payload)
      ipcRenderer.on('task:text-delta', handler)
      return () => ipcRenderer.removeListener('task:text-delta', handler)
    },
    /** v0.14.0 Task 4：按工具维度进度聚合（用于并行 Act 渲染） */
    onProgress: (cb) => {
      const handler = (_e: IpcRendererEvent, progress: Parameters<typeof cb>[0]) => cb(progress)
      ipcRenderer.on('task:progress', handler)
      return () => ipcRenderer.removeListener('task:progress', handler)
    },
    onProgressClear: (cb) => {
      const handler = (_e: IpcRendererEvent, payload: Parameters<typeof cb>[0]) => cb(payload)
      ipcRenderer.on('task:progress:clear', handler)
      return () => ipcRenderer.removeListener('task:progress:clear', handler)
    },
    onEvent: (cb) => {
      const handler = (_e: IpcRendererEvent, event: Parameters<typeof cb>[0]) => cb(event)
      ipcRenderer.on('task:event', handler)
      return () => ipcRenderer.removeListener('task:event', handler)
    },
    onStatusChange: (cb) => {
      const handler = (_e: IpcRendererEvent, task: Parameters<typeof cb>[0]) => cb(task)
      ipcRenderer.on('task:status', handler)
      return () => ipcRenderer.removeListener('task:status', handler)
    },
    /** v0.14.0 Task 8：PlanItem 六态变更推送 */
    onPlanItemStatusChanged: (cb) => {
      const handler = (_e: IpcRendererEvent, payload: Parameters<typeof cb>[0]) => cb(payload)
      ipcRenderer.on('task:plan-item-status-changed', handler)
      return () => ipcRenderer.removeListener('task:plan-item-status-changed', handler)
    },
    /** v0.18.0：planItems 整对象快照（落后兜底专用） */
    onPlanItemListSnapshot: (cb) => {
      const handler = (_e: IpcRendererEvent, payload: Parameters<typeof cb>[0]) => cb(payload)
      ipcRenderer.on('task:plan-list-snapshot', handler)
      return () => ipcRenderer.removeListener('task:plan-list-snapshot', handler)
    },
    /** v0.18.0：用户在 TodoPanel 行手动切状态 */
    cancelPlanItem: (payload) => ipcRenderer.invoke('task:plan-item-cancel', payload),
    retryPlanItem: (payload) => ipcRenderer.invoke('task:plan-item-retry', payload),
    markDonePlanItem: (payload) => ipcRenderer.invoke('task:plan-item-mark-done', payload),
    /** v0.18.0：Renderer 主动拉取 planItems（patch 落后兜底） */
    fetchPlanItemList: (taskId) => ipcRenderer.invoke('task:plan-list-snapshot', taskId),
    // Task 9：进度摘要持久化（覆盖式写入 / 启动时一次性加载）
    progressSave: (payload) => ipcRenderer.invoke('task:progress-save', payload),
    progressLoad: () => ipcRenderer.invoke('task:progress-load'),
  },
  // v0.14.0 Task 11：bugfix 技能 — 进度订阅（操作岛台）+ 模式切换（⌘K）
  bugfix: {
    onProgress: (cb) => {
      const handler = (_e: IpcRendererEvent, event: Parameters<typeof cb>[0]) => cb(event)
      ipcRenderer.on('bugfix:progress', handler)
      return () => ipcRenderer.removeListener('bugfix:progress', handler)
    },
    getMode: () => ipcRenderer.invoke('bugfix:mode:get'),
    setMode: (mode) => ipcRenderer.invoke('bugfix:mode:set', { mode }),
  },
  agent: {
    list: () => ipcRenderer.invoke('agent:list'),
    get: (id) => ipcRenderer.invoke('agent:get', id),
    add: (input) => ipcRenderer.invoke('agent:add', input),
    update: (id, patch) => ipcRenderer.invoke('agent:update', { id, patch }),
    remove: (id) => ipcRenderer.invoke('agent:remove', { id }),
    manualOverride: (value) => ipcRenderer.invoke('agent:manual-override', value),
  },
  skill: {
    list: () => ipcRenderer.invoke('skill:list'),
    add: (input) => ipcRenderer.invoke('skill:add', input),
    update: (patch) => ipcRenderer.invoke('skill:update', patch),
    remove: (id) => ipcRenderer.invoke('skill:remove', { id }),
    toggle: (id, enabled) => ipcRenderer.invoke('skill:toggle', { id, enabled }),
    importFromDir: (dirPath) => ipcRenderer.invoke('skill:import', { dirPath }),
    exportToDir: (id, targetDir) => ipcRenderer.invoke('skill:export', { id, targetDir }),
    readInstruction: (id) => ipcRenderer.invoke('skill:read-instruction', { id }),
  },
  mcp: {
    list: () => ipcRenderer.invoke('mcp:list'),
    add: (input) => ipcRenderer.invoke('mcp:add', input),
    update: (id, patch) => ipcRenderer.invoke('mcp:update', { id, patch }),
    remove: (id) => ipcRenderer.invoke('mcp:remove', { id }),
    connect: (id) => ipcRenderer.invoke('mcp:connect', { id }),
    disconnect: (id) => ipcRenderer.invoke('mcp:disconnect', { id }),
    callTool: (serverId, toolName, args) => ipcRenderer.invoke('mcp:call-tool', { serverId, toolName, args }),
    toggle: (id, enabled) => ipcRenderer.invoke('mcp:toggle', { id, enabled }),
  },
  market: {
    search: (queryOrParams, tags, page) => {
      const payload = typeof queryOrParams === 'string'
        ? { query: queryOrParams, tags, page }
        : queryOrParams
      return ipcRenderer.invoke('market:search', payload)
    },
    install: (skillId) => ipcRenderer.invoke('market:install', { skillId }),
    uninstall: (skillId) => ipcRenderer.invoke('market:uninstall', { skillId }),
    detail: (skillId) => ipcRenderer.invoke('market:detail', { skillId }),
    review: (skillId, rating, comment) => ipcRenderer.invoke('market:review', { skillId, rating, comment }),
    toggleFavorite: (skillId, favorited) => ipcRenderer.invoke('market:toggle-favorite', { skillId, favorited }),
    listSources: () => ipcRenderer.invoke('market:list-sources'),
    listInstalled: () => ipcRenderer.invoke('market:list-installed'),
    getLocalState: () => ipcRenderer.invoke('market:get-local-state'),
    addSource: (source) => ipcRenderer.invoke('market:add-source', { source }),
    removeSource: (sourceId) => ipcRenderer.invoke('market:remove-source', { sourceId }),
    // v0.6.1：SkillHub CLI 管理
    checkCli: () => ipcRenderer.invoke('market:check-cli'),
    installCli: () => ipcRenderer.invoke('market:install-cli'),
  },
  permission: {
    getMode: () => ipcRenderer.invoke('permission:getMode'),
    setMode: (mode) => ipcRenderer.invoke('permission:setMode', mode),
    resolveRules: () => ipcRenderer.invoke('permission:resolveRules'),
    addRule: (rule, scope) => ipcRenderer.invoke('permission:addRule', { rule, scope }),
    onModeChanged: (cb) => {
      const handler = (_e: IpcRendererEvent, payload: PermissionModeEvent) => cb(payload)
      ipcRenderer.on('permission:mode-changed', handler)
      return () => ipcRenderer.removeListener('permission:mode-changed', handler)
    },
  },
  model: {
    list: () => ipcRenderer.invoke('model:list'),
    add: (model) => ipcRenderer.invoke('model:add', model),
    update: (model) => ipcRenderer.invoke('model:update', model),
    remove: (id) => ipcRenderer.invoke('model:remove', id),
    test: (req) => ipcRenderer.invoke('model:test', req),
  },
  automation: {
    list: () => ipcRenderer.invoke('automation:list'),
    create: (input) => ipcRenderer.invoke('automation:create', input),
    update: (id, patch) => ipcRenderer.invoke('automation:update', { id, patch }),
    remove: (id) => ipcRenderer.invoke('automation:remove', { id }),
    run: (id) => ipcRenderer.invoke('automation:run', id),
  },
  kb: {
    list: () => ipcRenderer.invoke('kb:list'),
    add: (input) => ipcRenderer.invoke('kb:add', input),
    remove: (id) => ipcRenderer.invoke('kb:remove', { id }),
    // v0.8.0 F810/F811
    pickFiles: () => ipcRenderer.invoke('kb:pick-files'),
    import: (filePaths) => ipcRenderer.invoke('kb:import', filePaths),
    rename: (id, newName) => ipcRenderer.invoke('kb:rename', { id, newName }),
    reimport: (id) => ipcRenderer.invoke('kb:reimport', { id }),
    search: (query, kbIds, limit) => ipcRenderer.invoke('kb:search', { query, kbIds, limit }),
    setEnabled: (id, enabled) => ipcRenderer.invoke('kb:set-enabled', { id, enabled }),
    onImportProgress: (cb) => {
      const handler = (_e: IpcRendererEvent, progress: import('../shared/types/ipc').KbImportProgress) => cb(progress)
      ipcRenderer.on('kb:import-progress', handler)
      return () => ipcRenderer.removeListener('kb:import-progress', handler)
    },
    onChanged: (cb) => {
      const handler = () => cb()
      ipcRenderer.on('kb:changed', handler)
      return () => ipcRenderer.removeListener('kb:changed', handler)
    },
  },
  memory: {
    list: (taskId) => ipcRenderer.invoke('memory:list', taskId),
    toggle: (taskId, id, enabled) => ipcRenderer.invoke('memory:toggle', { taskId, id, enabled }),
    edit: (taskId, id, content) => ipcRenderer.invoke('memory:edit', { taskId, id, content }),
    archive: (taskId, id) => ipcRenderer.invoke('memory:archive', { taskId, id }),
    compress: (opts) => ipcRenderer.invoke('memory:compress', { taskId: opts.taskId, opts }),
    clear: (taskId) => ipcRenderer.invoke('memory:clear', taskId),
    // v0.8.0 L3a 策展记忆
    l3Get: () => ipcRenderer.invoke('memory:l3-get'),
    l3Update: (file, content) => ipcRenderer.invoke('memory:l3-update', { file, content }),
    l3PendingList: () => ipcRenderer.invoke('memory:l3-pending-list'),
    l3PendingApply: (modelId) => ipcRenderer.invoke('memory:l3-pending-apply', modelId),
    l3PendingDiscard: (ids) => ipcRenderer.invoke('memory:l3-pending-discard', ids),
    // v0.8.0 L4a 用户画像
    l4Get: () => ipcRenderer.invoke('memory:l4-get'),
    l4UpdateSynthesis: (text) => ipcRenderer.invoke('memory:l4-update-synthesis', text),
    l4DeleteObservation: (id) => ipcRenderer.invoke('memory:l4-delete-observation', id),
    l4Rollback: (version) => ipcRenderer.invoke('memory:l4-rollback', version),
    // v0.8.0 蒸馏与转化（Task 10：distill-accept / distill-dismiss 已移除——蒸馏全自动）
    convertToSkill: (source, skillMd) => ipcRenderer.invoke('memory:convert-to-skill', { source, skillMd }),
    convertToKb: (source) => ipcRenderer.invoke('memory:convert-to-kb', source),
    // v0.8.0 L3b 档案检索
    archiveSearch: (query, limit) => ipcRenderer.invoke('memory:archive-search', { query, limit }),
    // v0.16 Task 7：L2 压缩记忆管理
    l2List: (taskId) => ipcRenderer.invoke('memory:l2-list', taskId),
    l2Detail: (taskId, id) => ipcRenderer.invoke('memory:l2-detail', { taskId, id }),
    l2Delete: (taskId, id) => ipcRenderer.invoke('memory:l2-delete', { taskId, id }),
    l2Merge: (taskId, ids) => ipcRenderer.invoke('memory:l2-merge', { taskId, ids }),
    l2Export: (taskId, ids) => ipcRenderer.invoke('memory:l2-export', { taskId, ids }),
    onChanged: (cb) => {
      const handler = (_e: IpcRendererEvent, taskId: string) => cb(taskId)
      ipcRenderer.on('memory:changed', handler)
      return () => ipcRenderer.removeListener('memory:changed', handler)
    },
  },
  // v0.15.x：上下文真实用量按需估算；Task 6：占比可视化与下钻
  context: {
    estimate: (taskId) => ipcRenderer.invoke('context:estimate', taskId),
    getBreakdown: (taskId) => ipcRenderer.invoke('context:get-breakdown', taskId),
    removeItem: (taskId, category, detailId) =>
      ipcRenderer.invoke('context:remove-item', { taskId, category, detailId }),
    clearCategory: (taskId, category) =>
      ipcRenderer.invoke('context:clear-category', { taskId, category }),
  },
  fs: {
    listFiles: (taskId) => ipcRenderer.invoke('fs:list-files', taskId),
    readFile: (path) => ipcRenderer.invoke('fs:read-file', path),
    writeFile: (path, content) => ipcRenderer.invoke('fs:write-file', { path, content }),
    revealInFolder: (path) => ipcRenderer.invoke('fs:reveal-in-folder', path),
    // v0.9.1：重命名 / 删除（回收站）
    rename: (path, newName) => ipcRenderer.invoke('fs:rename', { path, newName }),
    delete: (path) => ipcRenderer.invoke('fs:delete', path),
    // v0.15.x Task 3：用户产物目录与 .arkwork 临时目录治理
    getArtifactsDir: () => ipcRenderer.invoke('fs:get-artifacts-dir'),
    setArtifactsDir: (dir) => ipcRenderer.invoke('fs:set-artifacts-dir', dir),
    cleanArkworkTemp: (maxAgeDays) => ipcRenderer.invoke('fs:clean-arkwork-temp', maxAgeDays),
    getArkworkSize: () => ipcRenderer.invoke('fs:get-arkwork-size'),
    /* ---- v0.31.0 B2：编辑器文件能力（§5.3） ---- */
    statPath: (path) => invokeFs('fs:stat-path', path),
    probeText: (path) => invokeFs('fs:probe-text', path),
    readText: (path) => invokeFs('fs:read-text', path),
    writeText: (req) => invokeFs('fs:write-text', req),
    hashFile: (path) => invokeFs('fs:hash-file', path),
    /* ---- v0.31.0 B5：文件能力 P1（§5.3，类型全部从 @shared/types 转发，不重声明） ---- */
    createFile: (parentDir, name) => invokeFs('fs:create-file', { parentDir, name }),
    createFolder: (parentDir, name) => invokeFs('fs:create-folder', { parentDir, name }),
    move: (from, to) => invokeFs('fs:move', { from, to }),
    listPaths: (opts) => invokeFs('fs:list-paths', opts),
    watchStart: (opts) => invokeFs('fs:watch-start', opts),
    watchStop: () => invokeFs('fs:watch-stop'),
    watchStatus: () => invokeFs('fs:watch-status'),
    onBatch: (cb) => {
      const handler = (_e: IpcRendererEvent, ev: FsBatchEvent) => cb(ev)
      ipcRenderer.on('fs:batch', handler)
      return () => ipcRenderer.removeListener('fs:batch', handler)
    },
  },
  log: {
    list: (taskId) => ipcRenderer.invoke('log:list', taskId),
    onAppend: (cb) => {
      const handler = (_e: IpcRendererEvent, entry: Parameters<typeof cb>[0]) => cb(entry)
      ipcRenderer.on('log:append', handler)
      return () => ipcRenderer.removeListener('log:append', handler)
    },
  },
  // v0.24.1：agent 自主驱动的内置浏览器
  // v0.27.0 F12：loadDone / onDidFinishLoad / onDidFailLoad 随 webview 旧轨删除
  /**
   * v0.30.0：TaskGraph 任务面板（17 个 invoke 频道 + 1 个订阅通道）
   *
   * 全部返回 `GraphResult<T>` 包络；订阅通道 `graph:update` 收敛了 9 种图事件
   * （patch / status / evidence / needs-human / replan / converge / notice / created / plan），
   * 渲染层只需处理一个回调 —— 避免为每种图事件开一条通道。
   *
   * `plan` 事件 = P8 计划闸门（`graph_plan_gate`）：request_plan / submit_plan / decide-plan
   * 均会广播，携带 `refresh: true`。对话流内联卡 `PlanApprovalCard` 据此重读 `pendingPlan`。
   */
  graph: {
    get: (taskId) => ipcRenderer.invoke('graph:get', taskId),
    snapshot: (taskId) => ipcRenderer.invoke('graph:snapshot', taskId),
    updateNode: (payload) => ipcRenderer.invoke('graph:update-node', payload),
    createNode: (payload) => ipcRenderer.invoke('graph:create-node', payload),
    deleteNode: (payload) => ipcRenderer.invoke('graph:delete-node', payload),
    setStatus: (payload) => ipcRenderer.invoke('graph:set-status', payload),
    answerBlock: (payload) => ipcRenderer.invoke('graph:answer-block', payload),
    decideReplan: (payload) => ipcRenderer.invoke('graph:decide-replan', payload),
    resolveConverge: (payload) => ipcRenderer.invoke('graph:resolve-converge', payload),
    setTier: (payload) => ipcRenderer.invoke('graph:set-tier', payload),
    exportMd: (taskId) => ipcRenderer.invoke('graph:export-md', taskId),
    restoreSnapshot: (payload) => ipcRenderer.invoke('graph:restore-snapshot', payload),
    runConverge: (taskId) => ipcRenderer.invoke('graph:run-converge', taskId),
    pendingPatches: (taskId) => ipcRenderer.invoke('graph:pending-patches', taskId),
    metrics: () => ipcRenderer.invoke('graph:metrics'),
    // v0.30.1 F3-1：轻量/无图时降级读取默认 policy 供面板展示（main 侧频道已存在）
    defaultPolicy: () => ipcRenderer.invoke('graph:default-policy'),
    // v0.30.0 P8：计划闸门（Plan 审批卡）—— pendingPlan 读、decidePlan 决
    pendingPlan: (taskId) => ipcRenderer.invoke('graph:pending-plan', taskId),
    decidePlan: (payload) => ipcRenderer.invoke('graph:decide-plan', payload),
    onUpdate: (cb) => {
      const handler = (_e: IpcRendererEvent, payload: Parameters<typeof cb>[0]) => cb(payload)
      ipcRenderer.on('graph:update', handler)
      return () => ipcRenderer.removeListener('graph:update', handler)
    },
  },
  browser: {
    onLoadRequest: (cb) => {
      const handler = (_e: IpcRendererEvent, req: Parameters<typeof cb>[0]) => cb(req)
      ipcRenderer.on('browser:load', handler)
      return () => ipcRenderer.removeListener('browser:load', handler)
    },
    resolve: (input) => ipcRenderer.invoke('browser:resolve', input),
  },
  // v0.25.0 F2：WebContentsView 多 Tab 路由（view-manager）
  browserTabs: {
    create: (args) => ipcRenderer.invoke('browser:tabs:create', args ?? {}),
    close: (args) => ipcRenderer.invoke('browser:tabs:close', args),
    activate: (args) => ipcRenderer.invoke('browser:tabs:activate', args),
    navigate: (args) => ipcRenderer.invoke('browser:tabs:navigate', args),
    setBounds: (args) => ipcRenderer.invoke('browser:tabs:set-bounds', args),
    list: () => ipcRenderer.invoke('browser:tabs:list'),
    setAgentDriven: (args) => ipcRenderer.invoke('browser:tabs:set-agent-driven', args),
    // v0.25.0 F2 P1：dock ↔ 独立窗口（修复「dock 切标签丢内容」「浮窗浏览器不可用」bug）
    detach: (args) => ipcRenderer.invoke('browser:tabs:detach', args),
    attach: (args) => ipcRenderer.invoke('browser:tabs:attach', args),
    // v0.25.0 F2 P1：宿主变化通知（attach/detach 完成后 push；BrowserPanel 收到后立即 setBounds）
    onHostChanged: (cb) => {
      const handler = (_e: IpcRendererEvent, payload: { tabId: string; host: 'dock' | 'window' }) => cb(payload)
      ipcRenderer.on('browser:tab-host-changed', handler)
      return () => ipcRenderer.removeListener('browser:tab-host-changed', handler)
    },
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    getSecret: (key) => ipcRenderer.invoke('settings:get-secret', key),
    setSecret: (key, value) => ipcRenderer.invoke('settings:set-secret', { key, value }),
    pickWorkspace: () => ipcRenderer.invoke('settings:pick-workspace'),
    activateWorkspace: (path: string) => ipcRenderer.invoke('settings:activate-workspace', path),
  },
  // v0.32.0：Workbench Profile（插件模式 · 垂直工作台）
  profile: {
    list: () => ipcRenderer.invoke('profile:list'),
    getActive: () => ipcRenderer.invoke('profile:get-active'),
    activate: (args) => ipcRenderer.invoke('profile:activate', args),
    snapshot: () => ipcRenderer.invoke('profile:snapshot'),
    validate: (args) => ipcRenderer.invoke('profile:validate', args),
    import: (args) => ipcRenderer.invoke('profile:import', args),
    delete: (args) => ipcRenderer.invoke('profile:delete', args),
    slots: () => ipcRenderer.invoke('profile:slots'),
    onChanged: (cb) => {
      const handler = (_e: IpcRendererEvent, payload: Parameters<typeof cb>[0]) => cb(payload)
      ipcRenderer.on('profile:changed', handler)
      return () => ipcRenderer.removeListener('profile:changed', handler)
    },
  },
  // v0.4.0：主题（同步原生界面 + 监听系统主题变化）
  theme: {
    apply: (t) => ipcRenderer.invoke('theme:apply', t),
    getSystemTheme: () => ipcRenderer.invoke('theme:get-system'),
    onSystemChange: (cb) => {
      const handler = (_e: IpcRendererEvent, systemTheme: Parameters<typeof cb>[0]) => cb(systemTheme)
      ipcRenderer.on('theme:system-changed', handler)
      return () => ipcRenderer.removeListener('theme:system-changed', handler)
    },
  },
  // v0.3.0：平台标识（用于 TopBar 按系统预留窗口控件空间）
  platform: process.platform,
  // v0.8.1：工具执行确认（Main → Renderer 浮层）
  confirm: {
    onRequest: (cb) => {
      const handler = (_e: IpcRendererEvent, req: import('../shared/types/ipc').ToolConfirmRequest) => cb(req)
      ipcRenderer.on('tool:confirm', handler)
      return () => ipcRenderer.removeListener('tool:confirm', handler)
    },
    respond: (requestId, allowed, session, reason) =>
      ipcRenderer.invoke('tool:confirm:respond', { requestId, allowed, session, reason }),
  },
  // v0.3.0：跨平台窗口控制（Windows 自定义标题栏按钮）
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  },
  // v0.14.0 Task 2：chat/task 分流判定
  route: {
    classify: (input, ctx) =>
      ipcRenderer.invoke('route:classify', { input, ctx }) as Promise<import('../shared/types/ipc').RouteClassifyDecision>,
  },
}

contextBridge.exposeInMainWorld('ark', ark)
