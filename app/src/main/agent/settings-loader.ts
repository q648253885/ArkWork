/* ArkWork — 四级权限配置加载与合并（v0.15.0） */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { PermissionMode } from './permission-mode.js'
import { ResolvedRules, loadRulesFromConfig, mergeRules } from './rules.js'

export interface ShellSettings {
  defaultTimeoutMs?: number
  maxTimeoutMs?: number
  maxStdoutBytes?: number
  maxStderrBytes?: number
  doomLoopThreshold?: number
  doomLoopWindowMs?: number
}

export interface AgentSettings {
  maxIterations?: number
}

export interface CompactionSettings {
  autoCompress?: boolean
  compressThreshold?: number
  keepTokens?: number
  maxFailures?: number
}

export interface PermissionSettings {
  defaultMode: PermissionMode
  allow: ResolvedRules['allow']
  ask: ResolvedRules['ask']
  deny: ResolvedRules['deny']
  shell: ShellSettings
  agent: AgentSettings
  compaction: CompactionSettings
}

function managedSettingsPath(): string | undefined {
  if (process.env.ARKWORK_MANAGED_SETTINGS && existsSync(process.env.ARKWORK_MANAGED_SETTINGS)) {
    return process.env.ARKWORK_MANAGED_SETTINGS
  }
  const fallback = join('/etc', 'arkwork', 'settings.json')
  if (existsSync(fallback)) return fallback
  return undefined
}

async function readSettingsFile(path: string): Promise<Record<string, unknown>> {
  if (!existsSync(path)) return {}
  try {
    const raw = await readFile(path, 'utf-8')
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

function mergeShell(...scopes: ShellSettings[]): ShellSettings {
  return {
    defaultTimeoutMs: scopes.find((s) => s.defaultTimeoutMs !== undefined)?.defaultTimeoutMs,
    maxTimeoutMs: scopes.find((s) => s.maxTimeoutMs !== undefined)?.maxTimeoutMs,
    maxStdoutBytes: scopes.find((s) => s.maxStdoutBytes !== undefined)?.maxStdoutBytes,
    maxStderrBytes: scopes.find((s) => s.maxStderrBytes !== undefined)?.maxStderrBytes,
    doomLoopThreshold: scopes.find((s) => s.doomLoopThreshold !== undefined)?.doomLoopThreshold,
    doomLoopWindowMs: scopes.find((s) => s.doomLoopWindowMs !== undefined)?.doomLoopWindowMs,
  }
}

function mergeAgent(...scopes: AgentSettings[]): AgentSettings {
  return {
    maxIterations: scopes.find((s) => s.maxIterations !== undefined)?.maxIterations,
  }
}

function mergeCompaction(...scopes: CompactionSettings[]): CompactionSettings {
  return {
    autoCompress: scopes.find((s) => s.autoCompress !== undefined)?.autoCompress,
    compressThreshold: scopes.find((s) => s.compressThreshold !== undefined)?.compressThreshold,
    keepTokens: scopes.find((s) => s.keepTokens !== undefined)?.keepTokens,
    maxFailures: scopes.find((s) => s.maxFailures !== undefined)?.maxFailures,
  }
}

export async function loadPermissionSettings(workspaceDir: string): Promise<PermissionSettings> {
  const managedPath = managedSettingsPath()
  const managed = managedPath ? await readSettingsFile(managedPath) : {}
  const local = workspaceDir ? await readSettingsFile(join(workspaceDir, '.arkwork', 'settings.local.json')) : {}
  const project = workspaceDir ? await readSettingsFile(join(workspaceDir, '.arkwork', 'settings.json')) : {}
  const user = await readSettingsFile(join(homedir(), '.arkwork', 'settings.json'))

  const managedRules = loadRulesFromConfig('managed', managed)
  const localRules = loadRulesFromConfig('local', local)
  const projectRules = loadRulesFromConfig('project', project)
  const userRules = loadRulesFromConfig('user', user)
  const rules = mergeRules(managedRules, localRules, projectRules, userRules)

  const shellSection = (s: Record<string, unknown>) => (s.shell ?? {}) as ShellSettings
  const agentSection = (s: Record<string, unknown>) => (s.agent ?? {}) as AgentSettings
  const compactionSection = (s: Record<string, unknown>) => (s.compaction ?? {}) as CompactionSettings

  return {
    defaultMode: rules.defaultMode ?? 'default',
    allow: rules.allow,
    ask: rules.ask,
    deny: rules.deny,
    shell: mergeShell(
      shellSection(managed),
      shellSection(local),
      shellSection(project),
      shellSection(user),
    ),
    agent: mergeAgent(
      agentSection(managed),
      agentSection(local),
      agentSection(project),
      agentSection(user),
    ),
    compaction: mergeCompaction(
      compactionSection(managed),
      compactionSection(local),
      compactionSection(project),
      compactionSection(user),
    ),
  }
}
