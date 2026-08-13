/* ============================================================
 * ArkWork — IPC: Model
 * 模型配置 CRUD + 连通性测试
 * ============================================================ */
import { ipcMain } from 'electron'
import {
  listModels,
  addModel,
  updateModel,
  removeModel,
  testModel,
} from '../llm/registry.js'
import type { LlmModel } from '@shared/types/agent'
import type { TestModelRequest } from '@shared/types/ipc'

export function registerModelHandlers(): void {
  ipcMain.handle('model:list', async () => listModels())
  ipcMain.handle('model:add', async (_e, model: LlmModel) => {
    await addModel(model)
  })
  ipcMain.handle('model:update', async (_e, model: LlmModel) => {
    await updateModel(model)
  })
  ipcMain.handle('model:remove', async (_e, id: string) => {
    await removeModel(id)
  })
  ipcMain.handle('model:test', async (_e, req: TestModelRequest) => {
    return testModel(req)
  })
}
