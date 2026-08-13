/* ============================================================
 * ArkWork — IPC: Router（v0.14.0 Task 2）
 * 暴露 chat/task 分流判定给渲染进程的 Composer
 * ============================================================ */
import { ipcMain } from 'electron'
import { classifyRoute, type RouteDecision, type ClassifyRouteContext } from '../router/classify-route.js'
import { logger } from '../system/logger.js'

/** 'route:classify' 入参 */
export interface RouteClassifyRequest {
  input: string
  ctx?: ClassifyRouteContext
}

export function registerRouterHandlers(): void {
  ipcMain.handle('route:classify', async (_e, payload: RouteClassifyRequest): Promise<RouteDecision> => {
    try {
      const input = typeof payload?.input === 'string' ? payload.input : ''
      const ctx = payload?.ctx
      const decision = classifyRoute(input, ctx)
      logger.debug('System', `classifyRoute → ${decision.kind} (${decision.latencyMs}ms) ${decision.reason}`)
      return decision
    } catch (err) {
      logger.error('System', `classifyRoute error: ${(err as Error).message}`)
      // 失败兜底：返回 chat（保守策略，避免误进 ReAct 阻塞用户）
      return { kind: 'chat', reason: 'classifier error → fallback chat', latencyMs: 0 }
    }
  })
}