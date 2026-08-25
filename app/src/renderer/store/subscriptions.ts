/* ============================================================
 * ArkWork — Renderer Store 事件订阅（v0.27.0 R3：自 store.ts 纯移动）
 * Main → Renderer 全部 IPC 推送的统一挂载点；由 index.ts 以
 * subscribeAll(set, get) 形式装配为 AppState.subscribeAll。
 * ============================================================ */
import i18n from '../i18n'
import { ark } from '../ipc/client'
import { applyThemeClass, classifyLlmError, deriveConversation, friendlyError } from './meta'
import { shortTaskId, formatUpdatedAt } from '../types'
import { simplifyFirstLine } from '../utils/title'
import type { AppState } from './types'
import type { Suggestion } from '@shared/types/conversation'
import type { LogEntry } from '@shared/types/ipc'
import type {
  ConfirmRespondReason,
  PlanItemStatusChanged,
  TaskTextDeltaPayload,
  ToolProgressClearEvent,
  ToolProgressEvent,
} from '@shared/types/ipc'

export function subscribeAll(
  set: (partial: Partial<AppState> | ((s: AppState) => Partial<AppState>)) => void,
  get: () => AppState,
): () => void {
    const unsubs: Array<() => void> = []

    // v0.15.0：会话权限模式变更（Shift+Tab / UI 切换）
    unsubs.push(
      ark.permission.onModeChanged((payload) => {
        if (payload && payload.mode) set({ permissionMode: payload.mode })
        void get().refreshPermissionRules()
      }),
    )

    // ReAct 步骤推送
    unsubs.push(
      ark.task.onStep((step) => {
        // 仅当 step 属于当前选中任务时才追加
        if (get().selectedTaskId === step.taskId) {
          get().appendStep(step)
        }
      }),
    )

    // v0.27.0 R1：流式文本增量（渲染加速通道）——仅缓存，UI 按需读取
    unsubs.push(
      ark.task.onTextDelta((payload) => {
        get().applyTextDelta(payload)
      }),
    )

    // 任务状态变化
    unsubs.push(
      ark.task.onStatusChange((task) => {
        // v0.27.0 R1：终态（含 paused/cancelled——中断时部分文本已随 cancelled reason step 落地）
        // 清空该任务全部流式缓冲，避免残留预览。
        const terminal =
          task.status === 'failed' || task.status === 'cancelled' || task.status === 'done' || task.status === 'paused'
        if (terminal) get().clearStreamBuffer(task.id)
        set((s) => ({
          tasks: s.tasks.map((t) => (t.id === task.id ? task : t)),
          selectedTask:
            s.selectedTaskId === task.id ? task : s.selectedTask,
          // v0.14.0 Task 4：任务失败/取消时清空飞行中的进度，避免 UI 残留
          activeProgressByTask:
            task.status === 'failed' || task.status === 'cancelled' || task.status === 'done'
              ? Object.fromEntries(
                  Object.entries(s.activeProgressByTask).filter(([k]) => k !== task.id),
                )
              : s.activeProgressByTask,
        }))
      }),
    )

    // v0.18.0 F1：PlanItem 六态变更（Main → Renderer 推送）。
    // 单条 patch 落地：原地更新 planItems 对应项 status / source / updatedAt；
    // 同时推进 planListVersion；命中当前 task 的 optimistic 项则 commit（删除乐观覆盖）。
    // Sidebar 任务行 / TodoPanel / 对话流 PlanMessage 三视图同源刷新（G3 保证）。
    unsubs.push(
      ark.task.onPlanItemStatusChanged((payload: PlanItemStatusChanged) => {
        set((s) => {
          // 1. 推进 version
          const nextVersions = { ...s.planListVersion }
          const prevVersion = nextVersions[payload.taskId] ?? 0
          if (payload.version > prevVersion) {
            nextVersions[payload.taskId] = payload.version
          }
          // 2. 更新 planItems（按 planItemId 寻址，老字段 index 兜底）
          const nextTasks = s.tasks.map((t) => {
            if (t.id !== payload.taskId) return t
            const items = t.planItems ? [...t.planItems] : []
            const idx =
              items.findIndex((p) => p.id === payload.planItemId) >= 0
                ? items.findIndex((p) => p.id === payload.planItemId)
                : payload.index
            if (idx < 0 || idx >= items.length) return t
            items[idx] = {
              ...items[idx]!,
              status: payload.status,
              source: payload.source,
              updatedAt: payload.ts,
              ...(payload.status === 'done' || payload.status === 'failed' || payload.status === 'cancelled' || payload.status === 'skipped'
                ? { completedAt: payload.ts }
                : {}),
            }
            return { ...t, planItems: items }
          })
          // 3. Optimistic reconcile：若命中正在等待的 planItemId，commit
          const overlay = { ...(s.optimisticOverlay[payload.taskId] ?? {}) }
          const flight = { ...(s.planItemInFlight[payload.taskId] ?? {}) }
          if (overlay[payload.planItemId]) {
            delete overlay[payload.planItemId]
            delete flight[payload.planItemId]
          }
          return {
            tasks: nextTasks,
            planListVersion: nextVersions,
            optimisticOverlay: { ...s.optimisticOverlay, [payload.taskId]: overlay },
            planItemInFlight: { ...s.planItemInFlight, [payload.taskId]: flight },
          }
        })
      }),
    )

    // v0.18.0 F2/F11：planItems 整对象快照（Main → Renderer）。
    // 触发场景：plan-regen 后；patch 落后差距 ≥ 5 时 Renderer 主动 invoke 后回推。
    // 行为：整 planItems 覆盖 + 推进 version；clear 当前 task 的 optimistic（整对象有更高优先级）。
    unsubs.push(
      ark.task.onPlanItemListSnapshot((payload) => {
        set((s) => {
          const nextVersions = { ...s.planListVersion }
          const prevVersion = nextVersions[payload.taskId] ?? 0
          if (payload.version > prevVersion) {
            nextVersions[payload.taskId] = payload.version
          }
          const nextTasks = s.tasks.map((t) =>
            t.id === payload.taskId ? { ...t, planItems: payload.planItems } : t,
          )
          return {
            tasks: nextTasks,
            planListVersion: nextVersions,
            optimisticOverlay: { ...s.optimisticOverlay, [payload.taskId]: {} },
            planItemInFlight: { ...s.planItemInFlight, [payload.taskId]: {} },
          }
        })
      }),
    )

    // v0.24.1：agent 自主浏览器 —— 收到 browser.open 请求时切到 Browser 标签
    // （v0.27.0 F12：browserLoad 状态随 webview 旧轨删除；URL 导航由 BrowserChrome dock 模式直听 IPC）
    unsubs.push(
      ark.browser.onLoadRequest((_req) => {
        set((s) => ({ inspectorTab: 'browser' }))
      }),
    )

    // v0.14.0 Task 4：按工具维度的并行 Act 进度（Main → Renderer）
    // 维护一个 per-requestId 字典 + 每 task 列表；UI 不会因多 act 并发互相覆盖
    unsubs.push(
      ark.task.onProgress((progress) => {
        set((s) => {
          const nextById = { ...s.toolProgress, [progress.requestId]: progress }
          const taskList = s.activeProgressByTask[progress.taskId] ?? []
          const nextTaskList = taskList.some((p) => p.requestId === progress.requestId)
            ? taskList.map((p) => (p.requestId === progress.requestId ? progress : p))
            : [...taskList, progress]
          // finished 后保留 6s 便于 UI 闪一下成功态，然后由 clear 事件移除
          return {
            toolProgress: nextById,
            activeProgressByTask: {
              ...s.activeProgressByTask,
              [progress.taskId]: nextTaskList,
            },
          }
        })
      }),
    )
    unsubs.push(
      ark.task.onProgressClear((payload: ToolProgressClearEvent) => {
        set((s) => {
          const taskList = s.activeProgressByTask[payload.taskId]
          if (!taskList) return s
          const nextList = payload.groupId
            ? taskList.filter((p) => p.groupId !== payload.groupId)
            : []
          const nextById = { ...s.toolProgress }
          for (const p of taskList) {
            if (!payload.groupId || p.groupId === payload.groupId) {
              delete nextById[p.requestId]
            }
          }
          return {
            toolProgress: nextById,
            activeProgressByTask: {
              ...s.activeProgressByTask,
              [payload.taskId]: nextList,
            },
          }
        })
      }),
    )

    // ReAct 事件（用于 Logs / 状态提示）
    unsubs.push(
      ark.task.onEvent((event) => {
        // 把关键事件写入 logs
        if (event.type === 'log') {
          get().appendLog({
            ts: Date.now(),
            level: event.level,
            source: event.source as LogEntry['source'],
            message: event.message,
          })
        } else if (event.type === 'ask_user') {
          // ask_user 暂停态：记录 Agent 问题全文，供门禁组件展示
          // 事件通常直接携带 question；若运行时缺失，回退到最近 ask_user 步骤提取
          const lastAskStep = [...get().steps]
            .reverse()
            .find((s) => (s as { type?: string }).type === 'ask_user') as
            | { question?: string }
            | undefined
          set({ askUserQuestion: event.question ?? lastAskStep?.question ?? null })
          // v0.27.1：建议选项改覆盖式写入——无选项时显式置空。旧逻辑"仅非空才写"
          // 会把上一轮建议卡片残留到下一轮提问，造成串题（缺陷 D1）
          const suggestions: Suggestion[] = Array.isArray(event.suggestions)
            ? event.suggestions.map((s, i) => ({
                id: `ask-${Date.now()}-${i}`,
                label: s.label,
                description: s.description,
                recommended: s.recommended,
              }))
            : []
          set({ suggestions })
        } else if (event.type === 'reason_end') {
          get().appendLog({
            ts: Date.now(),
            level: 'INFO',
            source: 'LLM',
            message:
              `iter ${event.iteration} reason_end tokens=${event.tokensIn ?? 0}+${event.tokensOut ?? 0}` +
              (event.cacheHitTokens !== undefined ? ` cacheHit=${event.cacheHitTokens}` : '') +
              ` ⏱${event.durationMs}ms`,
          })
          // v0.23.1：累计缓存命中统计（端点上报过即标记 reported，UI 据此显示命中率）
          if (event.cacheHitTokens !== undefined || event.cacheMissTokens !== undefined) {
            const prev = get().cacheUsage
            set({
              cacheUsage: {
                hitTokens: (prev?.hitTokens ?? 0) + (event.cacheHitTokens ?? 0),
                missTokens: (prev?.missTokens ?? 0) + (event.cacheMissTokens ?? 0),
                reported: true,
              },
            })
          }
        } else if (event.type === 'act_end') {
          get().appendLog({
            ts: Date.now(),
            // v0.19.x：门禁/预算拦截（softFail）按 WARN 橙色，只有真实工具报错才是 ERROR 红色
            level: event.ok ? 'INFO' : event.softFail ? 'WARN' : 'ERROR',
            source: 'Tool',
            message: `act_end ${event.resultSummary} ⏱${event.durationMs}ms`,
          })
        } else if (event.type === 'task_complete') {
          get().appendLog({
            ts: Date.now(),
            level: 'INFO',
            source: 'Agent',
            message: `task_complete: ${event.summary.slice(0, 100)}`,
          })
          // v0.15.0 Task 7：建议由 LLM 在 task_complete args.suggestions 真实生成；
          // 仅当 event.suggestions 非空数组时才写入 suggestions 状态（空 / 缺失 → 不渲染建议卡）
          if (Array.isArray(event.suggestions) && event.suggestions.length > 0) {
            const nextSteps: Suggestion[] = event.suggestions.map((s, i) => ({
              id: `task-complete-${Date.now()}-${i}`,
              label: s.label,
              description: s.description,
              recommended: s.recommended,
            }))
            set({ suggestions: nextSteps })
          }
        } else if (event.type === 'task_failed') {
          get().appendLog({
            ts: Date.now(),
            level: 'ERROR',
            source: 'Agent',
            message: `task_failed: ${event.error}`,
          })
          // v0.25.0 F2 P1：把错误详情主动推给用户（toast + 友好分类提示）。
          // LLM API 错误（402 余额不足 / 401 鉴权 / 429 限流 / 5xx 服务异常）原样透传，
          // 不让用户在 Composer 看到「运行失败」却不知道原因。
          const rawErr = String(event.error ?? '').trim()
          const hint = classifyLlmError(rawErr)
          get().pushToast({
            type: 'danger',
            message: hint
              ? i18n.t('slice.subscriptions.taskFailedHint', { error: rawErr, hint })
              : i18n.t('slice.subscriptions.taskFailed', { error: rawErr || i18n.t('slice.subscriptions.viewLogs') }),
            duration: 8000,
          })
        } else if (event.type === 'memory_compressed') {
          // v0.9.1：L1 自动压缩事件此前被静默丢弃，现接入 ctx-chip（诚实 UI）
          get().pushCtxChip({
            text: i18n.t('slice.subscriptions.contextCompressed', { before: event.beforeTokens, after: event.afterTokens }),
            variant: 'compress',
          })
        } else if (event.type === 'context_compacted') {
          get().pushCtxChip({
            text: i18n.t('slice.subscriptions.contextCompressedLayer', { layer: event.layer, before: event.beforeTokens, after: event.afterTokens }),
            variant: 'compress',
          })
        } else if (event.type === 'profile_updated') {
          // v0.9.1：L4 用户画像更新提示（此前被静默丢弃）
          get().pushCtxChip({
            text: i18n.t('slice.subscriptions.profileUpdated', { version: event.version, count: event.newObservations }),
            variant: 'update',
          })
        } else if (event.type === 'context_size_report') {
          // v0.15.x：仅当事件属于当前选中任务时更新真实 payload 用量
          if (get().selectedTaskId === event.taskId) {
            set({
              contextSize: {
                payloadTokens: event.payloadTokens,
                budget: event.budget,
                breakdown: {
                  systemTokens: event.systemTokens,
                  messagesTokens: event.messagesTokens,
                  toolsTokens: event.toolsTokens,
                  memoryInjectionTokens: event.memoryInjectionTokens,
                },
                modelContextWindow: event.modelContextWindow,
                reportedAt: Date.now(),
              },
            })
          }
        } else if (event.type === 'distill_completed') {
          // Task 10：蒸馏已后台自动完成（仅规模门槛命中才发生）——轻量 toast，不再弹"是否需要蒸馏"
          get().pushToast({
            type: 'success',
            message: event.message || i18n.t('slice.subscriptions.memoryMerged'),
            duration: 4000,
          })
          get().appendLog({
            ts: Date.now(),
            level: 'INFO',
            source: 'Memory',
            message: `distill_completed: ${event.category} — ${event.message}`,
          })
        } else if (event.type === 'task_progress') {
          // Task 9：阶段级进度回流（currentStage / overallPercentage / nextStepLabel）
          get().setTaskProgressStage(
            event.taskId,
            event.currentStage,
            event.overallPercentage,
            event.nextStepLabel,
          )
        } else if (event.type === 'task_step_complete') {
          // Task 9：SubTask（ReAct 步 / 必产文档子步骤）完成
          get().updateTaskProgressStep(
            event.taskId,
            event.stepId,
            event.ok ? 'completed' : 'failed',
            event.label,
          )
        } else if (event.type === 'task_milestone') {
          // Task 9：里程碑节点到达（含可选产物路径，可点击跳转）
          get().markTaskProgressMilestone(event.taskId, event.milestoneId, event.artifactPath)
        }
      }),
    )

    // v0.8.1：工具执行确认请求（Main → Renderer，ToolConfirmLayer 展示）
    unsubs.push(
      ark.confirm.onRequest((req) => {
        set({ pendingConfirm: req })
      }),
    )

    // Memory 变化
    unsubs.push(
      ark.memory.onChanged((taskId) => {
        if (get().selectedTaskId === taskId) {
          get().refreshMemory(taskId)
        }
      }),
    )

    // 日志推送
    unsubs.push(
      ark.log.onAppend((entry) => {
        get().appendLog(entry)
      }),
    )

    // v0.4.0：系统主题变化（仅当 theme==='system' 时联动 <html class>）
    unsubs.push(
      ark.theme.onSystemChange((systemTheme) => {
        const theme = get().theme
        const resolved = applyThemeClass(theme, systemTheme)
        set({ systemTheme, resolvedTheme: resolved })
      }),
    )

    return () => unsubs.forEach((u) => u())
}
