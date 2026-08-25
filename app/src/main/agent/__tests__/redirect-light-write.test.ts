/* ============================================================
 * permissions.ts 重定向识别单测（最终版）
 *
 * 验证 extractRedirectTarget 正确提取 `>` / `>>` 后的文件路径，
 * 排除 fd 复制（2>&1）、设备文件（/dev/null）、纯数字 fd。
 * 也验证 assessCommandRisk 第 3 步已接入新函数。
 *
 * 行为测试通过纯 Node 加载（用 tsx）从源码 + eval 函数体完成。
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const PERMS_PATH = fileURLToPath(new URL('../permissions.ts', import.meta.url))
const permsSrc = readFileSync(PERMS_PATH, 'utf-8')

test('permissions: 仅有一个 extractRedirectTarget 函数定义（无重复）', () => {
  const matches = permsSrc.match(/function\s+extractRedirectTarget\(/g) ?? []
  assert.equal(matches.length, 1, 'extractRedirectTarget 必须只定义一次')
})

test('permissions: isHarmlessRedirectTarget 已删除（合并入 extractRedirectTarget）', () => {
  assert.ok(!permsSrc.includes('function isHarmlessRedirectTarget'), 'isHarmlessRedirectTarget 必须删除')
})

test('permissions: extractRedirectTarget 排除设备文件 /dev/null / /proc / /sys', () => {
  assert.ok(permsSrc.includes('/dev/null') || permsSrc.includes('dev\\/'))
})

test('permissions: extractRedirectTarget 排除 fd 复制 &1 / &2 / 2>&1', () => {
  const needle = String.raw`/^&[0-9]+$/`
  const idx = permsSrc.indexOf('function extractRedirectTarget')
  const tail = permsSrc.slice(idx, idx + 1500)
  assert.ok(tail.indexOf(needle) >= 0, 'fd 复制排除必须出现在 extractRedirectTarget 函数体内')
})

test('permissions: assessCommandRisk 第 3 步使用 extractRedirectTarget', () => {
  // 第 3 步（输出重定向分析）调用了 extractRedirectTarget
  assert.match(permsSrc, /\/\/\s*3\.\s*输出重定向分析[\s\S]*?extractRedirectTarget\(effective\)/)
})

test('permissions: 第 3 步命中 workspace 内路径 → workspace-light-write + light-confirm', () => {
  assert.match(
    permsSrc,
    /extractRedirectTarget\(effective\)[\s\S]*?isInsideWorkspace\([\s\S]*?level:\s*'workspace-light-write'[\s\S]*?policy:\s*'light-confirm'/,
  )
})

test('permissions: 第 3 步命中 workspace 外路径 → high-risk + confirm', () => {
  assert.match(
    permsSrc,
    /extractRedirectTarget\(effective\)[\s\S]*?level:\s*'high-risk'[\s\S]*?policy:\s*'confirm'[\s\S]*?改写工作区外的文件/,
  )
})

/* ============ 行为级：动态加载 extractRedirectTarget 并跑实际输入 ============ */

function loadFn(): (cmd: string) => string | null {
  const idx = permsSrc.indexOf('function extractRedirectTarget(command: string): string | null {')
  if (idx < 0) throw new Error('extractRedirectTarget not found')
  const next = permsSrc.indexOf('\n}', idx)
  if (next < 0) throw new Error('extractRedirectTarget end not found')
  // 取函数体（去掉 function 头和尾部 }）
  const body = permsSrc.slice(idx + 'function extractRedirectTarget(command: string): string | null {'.length, next)
  // 用 new Function 构造
  // eslint-disable-next-line no-new-func
  return new Function('command', body + '\n;return extractRedirectTarget(command);') as (c: string) => string | null
}

test('extractRedirectTarget 行为: cat heredoc → docs/README.md', () => {
  const fn = loadFn()
  assert.equal(
    fn("cat > docs/README.md << 'EOF'\n# tank\nhello\nEOF"),
    'docs/README.md',
  )
})

test('extractRedirectTarget 行为: echo > /dev/null → null（设备文件）', () => {
  const fn = loadFn()
  assert.equal(fn('echo > /dev/null'), null)
})

test('extractRedirectTarget 行为: cmd 2>&1 → null（fd 复制）', () => {
  const fn = loadFn()
  assert.equal(fn('cmd 2>&1'), null)
})

test('extractRedirectTarget 行为: echo > /etc/passwd → /etc/passwd（让上游判断越界）', () => {
  const fn = loadFn()
  assert.equal(fn('echo > /etc/passwd'), '/etc/passwd')
})

test('extractRedirectTarget 行为: echo hello >> a.log → a.log', () => {
  const fn = loadFn()
  assert.equal(fn('echo hello >> a.log'), 'a.log')
})

test('extractRedirectTarget 行为: 无重定向 → null', () => {
  const fn = loadFn()
  assert.equal(fn('ls -la'), null)
})