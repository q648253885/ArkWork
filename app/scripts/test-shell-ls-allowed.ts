/* ============================================================
 * v0.24.x — 验证 shell ls 不再被 detectShellFileOp 拦截
 *
 * 场景：shell 调 `ls -la`，应能正常返回结果（不再抛"违规"）。
 *      detectShellFileOp 对 ls / tree / stat / file / du / realpath / readlink 返回 null。
 *
 * 运行（cwd=app）：
 *   npx tsx --experimental-loader ./src/test/electron-mock-loader.mjs scripts/test-shell-ls-allowed.ts
 * ============================================================ */
import { shell } from '../src/main/agent/skills/shell.js'

const ctx = { taskId: 'T-test', signal: new AbortController().signal, workspaceDir: '/Users/gongzheng/ai/t2' } as never

async function tryCmd(cmd: string) {
  try {
    const r = await shell({ command: cmd }, ctx)
    return { ok: true, exitCode: r.exitCode, stdoutPreview: r.stdout.slice(0, 200).replace(/\n/g, ' | ') }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

console.log('=== shell ls / 列目录家族放行验证 ===\n')

const cmds = [
  'ls',
  'ls -la',
  'ls src/',
  'ls /Users/gongzheng/ai/t2',
  'tree -L 2 src/',
  'stat src/scenes-ui.js',
  'file src/scenes-ui.js',
  'du -sh src/',
  'realpath src/scenes-ui.js',
  // 反例：仍应拦截的文件读取类命令（验证 cat 仍被拦）
  'cat src/scenes-ui.js',
  'head -5 src/scenes-ui.js',
  'grep "mkButton" src/scenes-ui.js',
]

for (const cmd of cmds) {
  const r = await tryCmd(cmd)
  if (r.ok) {
    console.log(`✅ ${cmd} → exit=${r.exitCode} stdout="${r.stdoutPreview.slice(0, 80)}"`)
  } else {
    console.log(`❌ ${cmd} → ${r.error.slice(0, 120)}`)
  }
}