/* ArkWork — 命令粒度 doom_loop 检测（v0.15.0） */

export interface CommandFingerprint {
  command: string
  cwd: string
}

export const DOOM_LOOP_THRESHOLD = 3
export const DOOM_LOOP_WINDOW_MS = 60_000

const recentCalls: Array<CommandFingerprint & { ts: number }> = []

export function detectDoomLoop(command: string, cwd: string): boolean {
  const now = Date.now()
  const fp: CommandFingerprint = {
    command: command.trim().replace(/\s+/g, ' '),
    cwd,
  }

  while (recentCalls.length > 0 && now - recentCalls[0].ts > DOOM_LOOP_WINDOW_MS) {
    recentCalls.shift()
  }

  const count = recentCalls.filter(
    (c) => c.command === fp.command && c.cwd === fp.cwd,
  ).length

  recentCalls.push({ ...fp, ts: now })

  return count + 1 >= DOOM_LOOP_THRESHOLD
}

export function resetDoomLoop(): void {
  recentCalls.length = 0
}
