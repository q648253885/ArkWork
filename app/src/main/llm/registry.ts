/* ============================================================
 * ArkWork — LLM Adapter Registry
 * 按 Model ID 路由到对应适配器，按需懒初始化
 * 每个 LlmModel 自带 baseURL/apiKey/kind，无需分层 Provider
 * ============================================================ */
import { join } from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { getArkworkDir } from '../store/db.js'
import type { LlmAdapter } from './adapter.js'
import { OpenAIAdapter } from './openai.js'
import { AnthropicAdapter } from './anthropic.js'
import { builtinModels } from '../store/seed.js'
import type { LlmModel, LlmProviderKind } from '@shared/types/agent'
import type { TestModelRequest, TestModelResult } from '@shared/types/ipc'
import { logger } from '../system/logger.js'
import { getUiLocale, tFor } from '../i18n/messages.js'

const adapters = new Map<string, LlmAdapter>()

/* ============ Models 持久化 ============ */

const MODELS_FILE = () => join(getArkworkDir(), 'models.json')

let cachedModels: LlmModel[] | null = null

async function loadModels(): Promise<LlmModel[]> {
  if (cachedModels) return cachedModels
  const path = MODELS_FILE()
  if (!existsSync(path)) {
    cachedModels = builtinModels
    return cachedModels
  }
  try {
    const raw = await readFile(path, 'utf-8')
    const parsed = JSON.parse(raw) as LlmModel[]
    // v0.4.0 数据迁移：过滤掉旧格式模型（无 kind 字段）
    // 旧版本 seed 写入了 gpt-4o-mini 等无 kind/apiKey 的占位模型，导致 buildAdapter 抛错
    const migrated = parsed.filter((m) => m && typeof m.kind === 'string')
    if (migrated.length !== parsed.length) {
      logger.info('LLM', `data migration: removed ${parsed.length - migrated.length} legacy models (missing 'kind' field)`)
      await persistModels(migrated)
    }
    cachedModels = migrated
  } catch (err) {
    logger.warn('LLM', `failed to read models: ${(err as Error).message}`)
    cachedModels = builtinModels
  }
  return cachedModels
}

export async function listModels(): Promise<LlmModel[]> {
  return loadModels()
}

export async function getModel(modelId: string): Promise<LlmModel | null> {
  const models = await loadModels()
  return models.find((m) => m.id === modelId) ?? null
}

export async function addModel(model: LlmModel): Promise<void> {
  const models = await loadModels()
  if (models.find((m) => m.id === model.id)) {
    throw new Error(`Model already exists: ${model.id}`)
  }
  models.push(model)
  await persistModels(models)
  logger.info('LLM', `model added: ${model.id} (${model.kind})`)
}

export async function updateModel(model: LlmModel): Promise<void> {
  const models = await loadModels()
  const idx = models.findIndex((m) => m.id === model.id)
  if (idx < 0) throw new Error(`Model not found: ${model.id}`)
  models[idx] = model
  await persistModels(models)
  adapters.delete(model.id)
  logger.info('LLM', `model updated: ${model.id}`)
}

export async function removeModel(id: string): Promise<void> {
  const models = await loadModels()
  const next = models.filter((m) => m.id !== id)
  await persistModels(next)
  adapters.delete(id)
  logger.info('LLM', `model removed: ${id}`)
}

async function persistModels(list: LlmModel[]): Promise<void> {
  await mkdir(getArkworkDir(), { recursive: true })
  await writeFile(MODELS_FILE(), JSON.stringify(list, null, 2), 'utf-8')
  cachedModels = list
}

/* ============ Adapter 构造 ============ */

/** 根据 modelId 获取 / 构造 adapter */
export async function getAdapter(modelId: string): Promise<LlmAdapter> {
  const cached = adapters.get(modelId)
  if (cached) return cached

  const model = await getModel(modelId)
  if (!model) {
    throw new Error(`Model not found: ${modelId}`)
  }

  const adapter = buildAdapter(model)
  adapters.set(modelId, adapter)
  logger.info('LLM', `adapter ready: ${model.name} (${model.kind})`)
  return adapter
}

function buildAdapter(model: LlmModel): LlmAdapter {
  const kind: LlmProviderKind = model.kind
  const apiKey = model.apiKey ?? ''
  const baseURL = model.baseURL

  switch (kind) {
    case 'openai':
      if (!apiKey) {
        throw new Error(tFor(getUiLocale(), 'llm.keyMissingOpenai', { model: model.id }))
      }
      return new OpenAIAdapter({
        apiKey,
        defaultModel: model.id,
        name: model.name,
        provider: 'openai',
        baseURL,
      })

    case 'anthropic':
      if (!apiKey) {
        throw new Error(tFor(getUiLocale(), 'llm.keyMissingAnthropic', { model: model.id }))
      }
      return new AnthropicAdapter({
        apiKey,
        defaultModel: model.id,
        name: model.name,
        baseURL,
      })

    case 'ollama': {
      const ollamaBase = baseURL ?? 'http://127.0.0.1:11434/v1'
      return new OpenAIAdapter({
        apiKey: apiKey || 'ollama',
        defaultModel: model.id,
        baseURL: ollamaBase,
        name: model.name,
        provider: 'ollama',
      })
    }

    case 'vllm': {
      // vLLM 暴露 OpenAI 兼容接口
      if (!baseURL) {
        throw new Error(tFor(getUiLocale(), 'llm.keyMissingVllm'))
      }
      return new OpenAIAdapter({
        apiKey: apiKey || 'vllm-dummy',
        defaultModel: model.id,
        baseURL,
        name: model.name,
        provider: 'custom-openai',
      })
    }

    default:
      throw new Error(`Unknown model kind: ${kind}`)
  }
}

/* ============ 连通性测试 ============ */

export async function testModel(req: TestModelRequest): Promise<TestModelResult> {
  // v0.29.0 F6：测试结果 message 直接展示在设置页，随 UI 语言切换
  const locale = getUiLocale()
  try {
    const { kind, baseURL, apiKey, modelId } = req

    if (kind === 'ollama') {
      const base = (baseURL ?? 'http://127.0.0.1:11434/v1').replace(/\/v1$/, '')
      const res = await fetch(`${base}/api/tags`, {
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) return { ok: false, message: `HTTP ${res.status}` }
      const data = (await res.json()) as { models?: Array<{ name: string }> }
      const models = data.models?.map((m) => m.name) ?? []
      return { ok: true, message: tFor(locale, 'llm.connectOkWithCount', { count: models.length }), models }
    }

    // OpenAI 兼容端点（openai / vllm）
    if (kind === 'openai' || kind === 'vllm') {
      const url = (baseURL ?? 'https://api.openai.com/v1') + '/models'
      const res = await fetch(url, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) return { ok: false, message: `HTTP ${res.status}: ${await res.text().catch(() => '')}` }
      const data = (await res.json()) as { data?: Array<{ id: string }> }
      const models = data.data?.map((m) => m.id) ?? []
      return { ok: true, message: tFor(locale, 'llm.connectOkWithCount', { count: models.length }), models }
    }

    if (kind === 'anthropic') {
      // Anthropic 没有 /models 接口，用最小消息测试
      const res = await fetch((baseURL ?? 'https://api.anthropic.com') + '/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey ?? '',
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: modelId ?? 'claude-3-5-haiku-20241022',
          max_tokens: 8,
          messages: [{ role: 'user', content: 'ping' }],
        }),
        signal: AbortSignal.timeout(10000),
      })
      if (res.ok) return { ok: true, message: tFor(locale, 'llm.connectOk') }
      const text = await res.text().catch(() => '')
      return { ok: false, message: `HTTP ${res.status}: ${text.slice(0, 200)}` }
    }

    return { ok: false, message: tFor(locale, 'llm.unsupportedProtocol', { kind }) }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
}
