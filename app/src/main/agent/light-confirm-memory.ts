import { isAbsolute, resolve } from 'node:path'

export interface LightConfirmCheckResult {
  remembered: boolean
  allowed?: boolean
  expired: boolean
}

interface LightConfirmEntry {
  allowed: boolean
  expiresAt: number
}

export class LightConfirmMemory {
  private readonly records = new Map<string, LightConfirmEntry>()
  private readonly ttlMs: number

  constructor(opts?: { ttlMs?: number }) {
    this.ttlMs = opts?.ttlMs ?? 30 * 60 * 1000
  }

  check(command: string, cwd: string, workspaceDir: string): LightConfirmCheckResult {
    const key = this.key(command, cwd, workspaceDir)
    const entry = this.records.get(key)
    if (!entry) return { remembered: false, expired: false }
    if (entry.expiresAt <= Date.now()) {
      this.records.delete(key)
      return { remembered: false, expired: true }
    }
    return { remembered: true, allowed: entry.allowed, expired: false }
  }

  remember(command: string, cwd: string, workspaceDir: string, allowed: boolean): void {
    this.records.set(this.key(command, cwd, workspaceDir), {
      allowed,
      expiresAt: Date.now() + this.ttlMs,
    })
  }

  clearSession(): void {
    this.records.clear()
  }

  pruneExpired(): void {
    const now = Date.now()
    for (const [key, entry] of this.records) {
      if (entry.expiresAt <= now) this.records.delete(key)
    }
  }

  private key(command: string, cwd: string, workspaceDir: string): string {
    const trimmed = command.trim()
    const cdMatch = trimmed.match(/^(?:cd\s+("[^"]+"|'[^']+'|\S+)\s*(?:&&|;)\s*)+/)
    let effectiveCwd = cwd
    if (cdMatch) {
      const cdCommands = cdMatch[0].matchAll(/cd\s+("[^"]+"|'[^']+'|\S+)\s*(?:&&|;)/g)
      for (const match of cdCommands) {
        const target = match[1].replace(/^["']|["']$/g, '')
        effectiveCwd = isAbsolute(target) ? target : resolve(effectiveCwd, target)
      }
    }
    const normalized = trimmed.replace(/^(?:cd\s+(?:"[^"]+"|'[^']+'|\S+)\s*(?:&&|;)\s*)+/, '').trim()
    return `${workspaceDir}\0${effectiveCwd}\0${normalized}`
  }
}

export const lightConfirmMemory = new LightConfirmMemory()
const pruneTimer = setInterval(() => lightConfirmMemory.pruneExpired(), 5 * 60 * 1000)
pruneTimer.unref?.()
