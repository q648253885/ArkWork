/* ============================================================
 * v0.36.0（B9.3 / F6.1 / P9）—— 权限规则**纯函数**套件
 * 对应文档：docs/versions/v0.36.0/04-system-design.md §9（P9）
 *           docs/versions/v0.36.0/evidence/11-b9-permission-rules.md
 *
 * 分工：本套件只测 `shared/utils/permission-rule.ts`（零依赖纯函数，两侧 tsconfig 都编）。
 *   「与主进程评估链一致」这类**跨层守卫**在 `main/agent/__tests__/permission-rules-ui.test.ts`
 *   （TC-PRULES-009/010），因为 shared 层不能 import main。
 *
 * 运行（cwd=app）：
 *   ./node_modules/.bin/tsx --experimental-loader ./src/test/electron-mock-loader.mjs \
 *     --test src/shared/utils/__tests__/permission-rule.test.ts
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseRuleText,
  formatRuleText,
  toolOfRule,
  patternOfRule,
  suggestRuleFromCommand,
  RULE_BEHAVIORS,
  PERMISSION_TOOL_OPTIONS,
} from '../permission-rule.js'

/* ============================================================
 * TC-PRULES-001：parseRuleText 拆解（含「整个工具」与「显式 Tool(*)」的区分）
 * ============================================================ */

test('TC-PRULES-001a: parseRuleText 解析 Tool(glob)', () => {
  const p = parseRuleText('Bash(git diff:*)')
  assert.deepEqual(p, { tool: 'Bash', pattern: 'git diff:*' })
})

test('TC-PRULES-001b: parseRuleText 解析裸 Tool → pattern 为空串（≠ 显式 *）', () => {
  assert.deepEqual(parseRuleText('Read'), { tool: 'Read', pattern: '' })
  // 显式 `Tool(*)` 保留 `*` —— 展示上两者不该混为一谈（语义等价，见源文件注释）
  assert.deepEqual(parseRuleText('Read(*)'), { tool: 'Read', pattern: '*' })
  assert.notDeepEqual(parseRuleText('Read'), parseRuleText('Read(*)'))
})

test('TC-PRULES-001c: parseRuleText 容忍首尾空白', () => {
  assert.deepEqual(parseRuleText('  Bash(npm test) \n'), { tool: 'Bash', pattern: 'npm test' })
})

test('TC-PRULES-001d: parseRuleText 非法输入 → null（空串 / 含空格裸词 / 前导非词字符）', () => {
  assert.equal(parseRuleText(''), null)
  assert.equal(parseRuleText('   '), null)
  // 含空格的裸词不是合法规则（`Bash(git diff)` 才行）
  assert.equal(parseRuleText('git diff'), null)
  // 前导 `-` 既进不了 `Tool(glob)` 分支，也进不了裸词分支
  assert.equal(parseRuleText('-Bash(x)'), null)
})

test('TC-PRULES-001e: parseRuleText 接受含 `*` 的工具名 glob（与 main parseRule 同款宽松）', () => {
  // 工具名允许含 `*`（如 `Bash*`），与 main/agent/rules.ts 的正则一致
  assert.deepEqual(parseRuleText('Bash*(x)'), { tool: 'Bash*', pattern: 'x' })
})

/* ============================================================
 * TC-PRULES-002：formatRuleText ↔ parseRuleText 往返
 * ============================================================ */

test('TC-PRULES-002a: formatRuleText 空/`*` pattern 退化为整个工具', () => {
  assert.equal(formatRuleText('Bash'), 'Bash')
  assert.equal(formatRuleText('Bash', ''), 'Bash')
  assert.equal(formatRuleText('Bash', '*'), 'Bash')
  assert.equal(formatRuleText('Bash', '   '), 'Bash')
})

test('TC-PRULES-002b: formatRuleText 带 glob 生成 Tool(glob)', () => {
  assert.equal(formatRuleText('Bash', 'git diff:*'), 'Bash(git diff:*)')
  assert.equal(formatRuleText('Write', 'src/**/*.ts'), 'Write(src/**/*.ts)')
})

test('TC-PRULES-002c: formatRuleText 空工具名 → 空串（不产坏规则）', () => {
  assert.equal(formatRuleText(''), '')
  assert.equal(formatRuleText('   ', 'x'), '')
})

test('TC-PRULES-002d: 往返一致性 —— format(parse(x)) 对合法规则收敛', () => {
  for (const raw of ['Bash(git diff:*)', 'Bash(npm test)', 'Read', 'Bash*(x)']) {
    const p = parseRuleText(raw)
    assert.ok(p, `应能解析 ${raw}`)
    const rebuilt = formatRuleText(p.tool, p.pattern)
    // 裸规则的 pattern 为空 → 退化回裸规则（这正是「整个工具」的规范写法）
    const expected = p.pattern === '' ? p.tool : raw
    assert.equal(rebuilt, expected, `往返失败：${raw}`)
    // 再解析一次必须与首次等价（幂等）
    assert.deepEqual(parseRuleText(rebuilt), p, `幂等失败：${rebuilt}`)
  }
})

/* ============================================================
 * TC-PRULES-003：toolOfRule / patternOfRule 的展示兜底
 * ============================================================ */

test('TC-PRULES-003a: toolOfRule 正常取工具名', () => {
  assert.equal(toolOfRule('Bash(git diff:*)'), 'Bash')
  assert.equal(toolOfRule('Read'), 'Read')
})

test('TC-PRULES-003b: toolOfRule 对**坏规则**回落为括号前首段（UI 不能因坏数据崩）', () => {
  assert.equal(toolOfRule('git diff'), 'git diff')
  assert.equal(toolOfRule('Bash(git diff)extra'), 'Bash')
})

test('TC-PRULES-003c: patternOfRule 无参规则归一为 `*`', () => {
  assert.equal(patternOfRule('Read'), '*')
  assert.equal(patternOfRule('Read(*)'), '*')
  assert.equal(patternOfRule('Bash(git diff:*)'), 'git diff:*')
  // 坏规则也归一为 `*`，不抛
  assert.equal(patternOfRule('not a rule'), '*')
})

/* ============================================================
 * TC-PRULES-004：suggestRuleFromCommand —— 浮层「记住此选择」的建议粒度
 * ★ 安全取向：只建议，不代替用户决定（源文件注释）；粒度默认到子命令。
 * ============================================================ */

test('TC-PRULES-004a: 子命令粒度 —— `git diff --stat` → Bash(git diff:*)', () => {
  assert.equal(suggestRuleFromCommand('git diff --stat'), 'Bash(git diff:*)')
  assert.equal(suggestRuleFromCommand('npm test -- --watch'), 'Bash(npm test:*)')
})

test('TC-PRULES-004b: 单令牌命令退化 —— `ls` → Bash(ls)；`rm -rf build` 的第二令牌是 flag 也被排除', () => {
  assert.equal(suggestRuleFromCommand('ls'), 'Bash(ls)')
  // `-rf` 不是词（以 `-` 开头）→ 退化为整命令
  assert.equal(suggestRuleFromCommand('rm -rf build'), 'Bash(rm)')
})

test('TC-PRULES-004c: 去掉前导 env 赋值与 sudo 后再取主体', () => {
  assert.equal(suggestRuleFromCommand('FOO=1 sudo npm test'), 'Bash(npm test:*)')
  assert.equal(suggestRuleFromCommand('sudo rm -rf /'), 'Bash(rm)')
})

test('TC-PRULES-004d: 路径参数不作子命令 —— `node /tmp/a.js` → Bash(node)', () => {
  assert.equal(suggestRuleFromCommand('node /tmp/a.js'), 'Bash(node)')
})

test('TC-PRULES-004e: 空命令 → 工具级规则；tool 参数可替换', () => {
  assert.equal(suggestRuleFromCommand(''), 'Bash')
  assert.equal(suggestRuleFromCommand('   '), 'Bash')
  assert.equal(suggestRuleFromCommand('', 'Write'), 'Write')
})

test('TC-PRULES-004f: 建议结果必须能被 parseRuleText 解析（否则面板会展示坏规则）', () => {
  const samples = [
    'git diff --stat',
    'npm test -- --watch',
    'ls',
    'rm -rf build',
    'FOO=1 sudo npm test',
    'node /tmp/a.js',
    'echo "hello world"',
    'a-b --c',
  ]
  for (const s of samples) {
    const sug = suggestRuleFromCommand(s)
    assert.ok(parseRuleText(sug), `建议结果不可解析：${s} → ${sug}`)
  }
})

/* ============================================================
 * TC-PRULES-005：清单形状（内容一致性由 main 侧 TC-PRULES-009 把守）
 * ============================================================ */

test('TC-PRULES-005a: RULE_BEHAVIORS 顺序稳定为 allow/ask/deny', () => {
  assert.deepEqual([...RULE_BEHAVIORS], ['allow', 'ask', 'deny'])
})

test('TC-PRULES-005b: PERMISSION_TOOL_OPTIONS 为只读非空清单', () => {
  assert.ok(Array.isArray(PERMISSION_TOOL_OPTIONS))
  assert.ok(PERMISSION_TOOL_OPTIONS.length > 0)
  for (const t of PERMISSION_TOOL_OPTIONS) {
    assert.equal(typeof t, 'string')
    assert.ok(t.length > 0)
    // 工具下拉里不能出现空串/占位符 —— 否则用户会造出无意义规则
    assert.ok(/^[A-Za-z][A-Za-z0-9_]*$/.test(t), `工具名形态不合法：${t}`)
  }
  assert.equal(new Set(PERMISSION_TOOL_OPTIONS).size, PERMISSION_TOOL_OPTIONS.length, '清单有重复项')
})
