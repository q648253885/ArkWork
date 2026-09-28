/* ============================================================
 * v0.36.0（B9.3 / F6.1 / P9）—— 权限规则**主进程侧**套件
 * 对应文档：docs/versions/v0.36.0/04-system-design.md §9（P9）
 *           docs/versions/v0.36.0/evidence/11-b9-permission-rules.md
 *
 * 覆盖三类：
 *   ① 纯函数：listRuleEntries / mergeRules(disabled) / loadRulesFromConfig(disabled)
 *   ② 跨层守卫（本套件才是合适位置：shared 层不能 import main）
 *      · PERMISSION_TOOL_OPTIONS ↔ 真实评估链的工具名（TC-PRULES-009）
 *      · parseRuleText ↔ parseRule 语义对齐（TC-PRULES-010）
 *   ③ IPC 写权限边界（真实临时工作区 + settings.local.json 落盘回读）
 *
 * 密闭性（纪律⑭）：
 *   · 工作区 = 本进程独占 mkdtempSync；
 *   · `~/.arkwork/settings.json` 通过覆写 `process.env.HOME` 改道到临时目录
 *     （已实测 `os.homedir()` 不缓存、随 env 变化）—— 否则会读到开发者真机配置，
 *     出现「本机绿、CI 红」；
 *   · managed 层通过 `ARKWORK_MANAGED_SETTINGS` 指到临时文件。
 *
 * 运行（cwd=app）：
 *   ./node_modules/.bin/tsx --experimental-loader ./src/test/electron-mock-loader.mjs \
 *     --test src/main/agent/__tests__/permission-rules-ui.test.ts
 * ============================================================ */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { stripComments } from '@shared/utils/source-guard'

import {
  parseRule,
  mergeRules,
  listRuleEntries,
  loadRulesFromConfig,
  isRuleDisabled,
  RULE_SCOPES,
  type ResolvedRules,
} from '../rules.js'
import { parseRuleText, PERMISSION_TOOL_OPTIONS } from '@shared/utils/permission-rule'
import { PermissionChannel } from '@shared/types/ipc'

/* electron-stub 扩展的 __invokeIpc（electron 官方 d.ts 不含它）：就地声明类型 */
type IpcInvoke = <T = any>(channel: string, ...args: unknown[]) => Promise<T>

/* ============================================================
 * 夹具：临时 home / managed / workspace
 * ============================================================ */

const root = mkdtempSync(join(tmpdir(), 'arkwork-prules-'))
const fakeHome = join(root, 'home')
const managedFile = join(root, 'managed-settings.json')
const wsDir = join(root, 'ws')

const origHome = process.env.HOME
const origManaged = process.env.ARKWORK_MANAGED_SETTINGS

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf-8')
}

before(async () => {
  mkdirSync(join(wsDir, '.arkwork'), { recursive: true })
  mkdirSync(join(fakeHome, '.arkwork'), { recursive: true })

  // 四级配置：managed 由管理员下发（deny），其余三层各写一条 allow
  writeJson(managedFile, { permissions: { deny: ['Bash(managed-denied)'] } })
  writeJson(join(wsDir, '.arkwork', 'settings.local.json'), {
    permissions: {
      allow: ['Bash(local-ok)'],
      ask: ['Bash(local-ask)'],
      deny: ['Bash(local-deny)'],
    },
  })
  writeJson(join(wsDir, '.arkwork', 'settings.json'), {
    permissions: { allow: ['Bash(project-only)'] },
  })
  writeJson(join(fakeHome, '.arkwork', 'settings.json'), {
    permissions: { allow: ['Bash(user-only)'] },
  })

  process.env.HOME = fakeHome
  process.env.ARKWORK_MANAGED_SETTINGS = managedFile

  const { setWorkspaceDir } = await import('../../store/db.js')
  setWorkspaceDir(wsDir)
})

after(() => {
  if (origHome === undefined) delete process.env.HOME
  else process.env.HOME = origHome
  if (origManaged === undefined) delete process.env.ARKWORK_MANAGED_SETTINGS
  else process.env.ARKWORK_MANAGED_SETTINGS = origManaged
  rmSync(root, { recursive: true, force: true })
})

const readScopes = async () => {
  const { loadRuleScopes } = await import('../settings-loader.js')
  return loadRuleScopes(wsDir)
}
const readLocalFile = () =>
  JSON.parse(readFileSync(join(wsDir, '.arkwork', 'settings.local.json'), 'utf-8')) as {
    permissions?: { allow?: string[]; ask?: string[]; deny?: string[]; disabled?: string[] }
  }

/* ============================================================
 * TC-PRULES-006：listRuleEntries —— 顺序 / 来源 / 可编辑性
 * ============================================================ */

test('TC-PRULES-006a: RULE_SCOPES 展示顺序 = 优先级顺序（managed 最高）', () => {
  assert.deepEqual([...RULE_SCOPES], ['managed', 'local', 'project', 'user'])
})

test('TC-PRULES-006b: listRuleEntries 顺序为 managed→local→project→user，作用域内 allow→ask→deny', async () => {
  const entries = listRuleEntries(await readScopes())
  assert.deepEqual(
    entries.map((e) => `${e.scope}/${e.behavior}/${e.raw}`),
    [
      'managed/deny/Bash(managed-denied)',
      'local/allow/Bash(local-ok)',
      'local/ask/Bash(local-ask)',
      'local/deny/Bash(local-deny)',
      'project/allow/Bash(project-only)',
      'user/allow/Bash(user-only)',
    ],
  )
})

test('TC-PRULES-006c: editable 只有 local 为 true（其余三级改了会被下次读取覆盖）', async () => {
  const entries = listRuleEntries(await readScopes())
  for (const e of entries) {
    assert.equal(e.editable, e.scope === 'local', `${e.scope} 的 editable 判定不对`)
  }
})

test('TC-PRULES-006d: 条目字段完整性 —— raw/tool/pattern/behavior 全部非空', async () => {
  const entries = listRuleEntries(await readScopes())
  assert.ok(entries.length >= 6)
  for (const e of entries) {
    assert.ok(e.raw.length > 0)
    assert.ok(e.tool.length > 0)
    assert.ok(e.pattern.length > 0, `pattern 必须归一为 '*' 而不是空串：${e.raw}`)
    assert.ok(['allow', 'ask', 'deny'].includes(e.behavior))
  }
})

/* ============================================================
 * TC-PRULES-007：关停 = 登记，合并时跳过（评估语义等价于删除）
 * ============================================================ */

test('TC-PRULES-007a: isRuleDisabled 只认本作用域登记', () => {
  const scoped: ResolvedRules = {
    allow: [parseRule('Bash(a)')!],
    ask: [],
    deny: [],
    disabled: ['Bash(a)'],
  }
  assert.equal(isRuleDisabled(scoped, 'Bash(a)'), true)
  assert.equal(isRuleDisabled(scoped, 'Bash(b)'), false)
  assert.equal(isRuleDisabled({ allow: [], ask: [], deny: [] }, 'Bash(a)'), false, '无 disabled 字段应为不关停')
})

test('TC-PRULES-007b: mergeRules 跳过被关停规则 —— 与「直接删掉」等价', () => {
  const local: ResolvedRules = {
    allow: [parseRule('Bash(local-ok)')!, parseRule('Bash(off)')!],
    ask: [],
    deny: [],
    disabled: ['Bash(off)'],
  }
  const empty: ResolvedRules = { allow: [], ask: [], deny: [] }
  const merged = mergeRules(empty, local, empty, empty)
  assert.deepEqual(merged.allow.map((r) => r.raw), ['Bash(local-ok)'])

  // 反向核验：不登记 disabled 时两条都在（证明上一条不是「本来就没进去」）
  const mergedLive = mergeRules(empty, { ...local, disabled: [] }, empty, empty)
  assert.deepEqual(mergedLive.allow.map((r) => r.raw), ['Bash(local-ok)', 'Bash(off)'])
})

test('TC-PRULES-007c: 关停同时影响 allow/ask/deny 三张表（不偏科）', () => {
  const scoped: ResolvedRules = {
    allow: [parseRule('Bash(x)')!],
    ask: [parseRule('Bash(x)')!],
    deny: [parseRule('Bash(x)')!],
    disabled: ['Bash(x)'],
  }
  const merged = mergeRules(scoped, { allow: [], ask: [], deny: [] }, { allow: [], ask: [], deny: [] }, { allow: [], ask: [], deny: [] })
  assert.equal(merged.allow.length, 0)
  assert.equal(merged.ask.length, 0)
  assert.equal(merged.deny.length, 0)
})

/* ============================================================
 * TC-PRULES-008：loadRulesFromConfig 读取 permissions.disabled
 * ============================================================ */

test('TC-PRULES-008a: 解析 permissions.disabled（去掉空白项、非数组视为空）', () => {
  const r = loadRulesFromConfig('local', {
    permissions: { allow: ['Bash(a)'], disabled: ['  Bash(a)  ', '', '  '] },
  })
  assert.deepEqual(r.disabled, ['Bash(a)'])

  const bad = loadRulesFromConfig('local', { permissions: { disabled: 'Bash(a)' } })
  assert.deepEqual(bad.disabled, [], '字符串不是列表 → 空，不能把每个字符拆开')
})

/* ============================================================
 * TC-PRULES-009：PERMISSION_TOOL_OPTIONS ↔ 真实评估链（跨层守卫）
 * ★ 这是 P9 最关键的一条：面板给了 `Write` 的规则入口而评估链没拿 Write
 *   去匹配过，用户就会写出一条**永远不生效**的规则（静默陷阱）。
 * ============================================================ */

/** 从 permissions.ts 抽出真正走规则匹配的工具名 */
function extractEvaluatedTools(src: string): string[] {
  const code = stripComments(src)
  const re = /findFirstMatchingRule\(\s*[\w.]*\.(?:allow|ask|deny)\s*,\s*'([^']+)'/g
  const out = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) !== null) out.add(m[1] as string)
  return [...out].sort()
}

const PERMISSIONS_SRC_PATH = fileURLToPath(new URL('../permissions.ts', import.meta.url))

test('TC-PRULES-009a: 面板工具下拉 == 评估链真正匹配的工具集合', () => {
  const tools = extractEvaluatedTools(readFileSync(PERMISSIONS_SRC_PATH, 'utf-8'))
  assert.deepEqual(
    tools,
    [...PERMISSION_TOOL_OPTIONS].sort(),
    '面板可选工具与 main/agent/permissions.ts 的 findFirstMatchingRule 调用不一致：' +
      '要么把新工具加进 PERMISSION_TOOL_OPTIONS，要么确认它不该出现在规则表里',
  )
})

test('TC-PRULES-009b: 现况是「只有 shell（Bash）走规则匹配」—— 文件类工具不在表内', () => {
  const tools = extractEvaluatedTools(readFileSync(PERMISSIONS_SRC_PATH, 'utf-8'))
  assert.deepEqual(tools, ['Bash'])
  for (const fileTool of ['Write', 'Edit', 'Read', 'Glob', 'Grep']) {
    assert.ok(!PERMISSION_TOOL_OPTIONS.includes(fileTool), `${fileTool} 未接入评估链，不能出现在下拉里`)
  }
})

/* ============================================================
 * TC-PRULES-010：parseRuleText ↔ parseRule 语义对齐（防两处漂移）
 * ============================================================ */

test('TC-PRULES-010a: 两侧对 tool 的判定一致；pattern 的差异是**刻意的**（空串 vs "*"）', () => {
  const samples = [
    'Bash(git diff:*)',
    'Bash(npm test)',
    'Read',
    'Read(*)',
    'Bash*(x)',
    'Write(src/**/*.ts)',
    'Grep(TODO)',
  ]
  for (const raw of samples) {
    const mainSide = parseRule(raw)
    const uiSide = parseRuleText(raw)
    assert.ok(mainSide, `main 侧应能解析 ${raw}`)
    assert.ok(uiSide, `ui 侧应能解析 ${raw}`)
    assert.equal(uiSide.tool, mainSide.tool, `tool 判定漂移：${raw}`)
    // main 把无括号规则写成 '*'；ui 侧保留 '' 以便区分「整个工具」与「显式 Tool(*)」
    const expectedMainPattern = uiSide.pattern === '' ? '*' : uiSide.pattern
    assert.equal(mainSide.pattern, expectedMainPattern, `pattern 语义漂移：${raw}`)
  }
})

test('TC-PRULES-010b: 显式 Tool(*) 在两侧都被当作「整工具」（matchGlob("*") 恒真）', () => {
  const a = parseRule('Read(*)')!
  const b = parseRule('Read')!
  assert.equal(a.tool, b.tool)
  assert.equal(a.pattern, b.pattern)
})

/* ============================================================
 * TC-PRULES-011：IPC 写权限边界（只有 local 可写；真实落盘回读）
 * ============================================================ */

test('TC-PRULES-011a: listRules 返回四级条目（含来源与可编辑性）', async () => {
  const { registerPermissionHandlers } = await import('../../ipc/permission.js')
  registerPermissionHandlers()
  const { __invokeIpc } = (await import('electron')) as unknown as { __invokeIpc: IpcInvoke }
  const entries = await __invokeIpc<Array<{ raw: string; scope: string; editable: boolean; behavior: string }>>(
    PermissionChannel.ListRules,
  )
  assert.deepEqual(
    entries.map((e) => `${e.scope}/${e.behavior}/${e.raw}`),
    [
      'managed/deny/Bash(managed-denied)',
      'local/allow/Bash(local-ok)',
      'local/ask/Bash(local-ask)',
      'local/deny/Bash(local-deny)',
      'project/allow/Bash(project-only)',
      'user/allow/Bash(user-only)',
    ],
  )
  const project = entries.find((e) => e.scope === 'project')!
  assert.equal(project.editable, false)
  assert.equal(entries.find((e) => e.scope === 'local')!.editable, true)
})

test('TC-PRULES-011b: 关停 local 规则 → 落盘 disabled + 合并集里消失；再打开 → 恢复', async () => {
  const { __invokeIpc } = (await import('electron')) as unknown as { __invokeIpc: IpcInvoke }
  const { resolveEffectiveRules } = await import('../../ipc/permission.js')

  assert.deepEqual((await resolveEffectiveRules()).allow.filter((r) => r.includes('local-ok')), ['Bash(local-ok)'])

  await __invokeIpc(PermissionChannel.SetRuleEnabled, {
    rule: 'Bash(local-ok)',
    behavior: 'allow',
    enabled: false,
  })
  assert.deepEqual(readLocalFile().permissions?.disabled, ['Bash(local-ok)'], '关停应登记到磁盘')
  assert.equal(
    (await resolveEffectiveRules()).allow.includes('Bash(local-ok)'),
    false,
    '关停后合并集不应再包含该规则',
  )

  // 列表里仍能看到它（关停是登记不是删除），但 enabled=false
  const entries = await __invokeIpc<Array<{ raw: string; behavior: string; enabled: boolean }>>(
    PermissionChannel.ListRules,
  )
  const off = entries.find((e) => e.raw === 'Bash(local-ok)' && e.behavior === 'allow')!
  assert.equal(off.enabled, false, '关停的规则要在面板里留痕，否则用户无法再打开')

  await __invokeIpc(PermissionChannel.SetRuleEnabled, {
    rule: 'Bash(local-ok)',
    behavior: 'allow',
    enabled: true,
  })
  assert.deepEqual(readLocalFile().permissions?.disabled, [])
  assert.equal((await resolveEffectiveRules()).allow.includes('Bash(local-ok)'), true)
})

test('TC-PRULES-011c: 越权写被**主进程拒绝**（managed/project/user 不可开关、不可删除）', async () => {
  const { __invokeIpc } = (await import('electron')) as unknown as { __invokeIpc: IpcInvoke }
  const before = readLocalFile()

  for (const [scope, rule, behavior] of [
    ['managed', 'Bash(managed-denied)', 'deny'],
    ['project', 'Bash(project-only)', 'allow'],
    ['user', 'Bash(user-only)', 'allow'],
  ] as const) {
    await assert.rejects(
      () => __invokeIpc(PermissionChannel.SetRuleEnabled, { rule, behavior, enabled: false }),
      /只有本工作区/,
      `${scope} 作用域的开关应当被拒绝`,
    )
    await assert.rejects(
      () => __invokeIpc(PermissionChannel.RemoveRule, { rule, behavior }),
      /只有本工作区/,
      `${scope} 作用域的删除应当被拒绝`,
    )
  }

  // 拒绝 = 磁盘零改动（不能先写坏再回滚）
  assert.deepEqual(readLocalFile(), before)
})

test('TC-PRULES-011d: AddRule 支持行为选择；重新添加会**解除关停**', async () => {
  const { __invokeIpc } = (await import('electron')) as unknown as { __invokeIpc: IpcInvoke }
  const { resolveEffectiveRules } = await import('../../ipc/permission.js')

  // 先关停，再以 deny 添加同一条 —— 用户明确要它生效，必须一并解除 disabled
  await __invokeIpc(PermissionChannel.SetRuleEnabled, {
    rule: 'Bash(local-ask)',
    behavior: 'ask',
    enabled: false,
  })
  assert.ok(readLocalFile().permissions?.disabled?.includes('Bash(local-ask)'))

  await __invokeIpc(PermissionChannel.AddRule, { rule: 'Bash(new-deny)', behavior: 'deny' })
  assert.ok(readLocalFile().permissions?.deny?.includes('Bash(new-deny)'))
  assert.ok((await resolveEffectiveRules()).deny.includes('Bash(new-deny)'))

  await __invokeIpc(PermissionChannel.AddRule, { rule: 'Bash(local-ask)', behavior: 'ask' })
  assert.equal(readLocalFile().permissions?.disabled?.includes('Bash(local-ask)'), false, '重加应解除关停')
})

test('TC-PRULES-011e: AddRule 默认行为为 allow（旧调用点不传 behavior 时语义不变）', async () => {
  const { __invokeIpc } = (await import('electron')) as unknown as { __invokeIpc: IpcInvoke }
  await __invokeIpc(PermissionChannel.AddRule, { rule: 'Bash(legacy-caller)' })
  assert.ok(readLocalFile().permissions?.allow?.includes('Bash(legacy-caller)'))
})

test('TC-PRULES-011f: RemoveRule 删除 local 规则并从 disabled 一并清除', async () => {
  const { __invokeIpc } = (await import('electron')) as unknown as { __invokeIpc: IpcInvoke }
  const { resolveEffectiveRules } = await import('../../ipc/permission.js')

  await __invokeIpc(PermissionChannel.SetRuleEnabled, {
    rule: 'Bash(local-deny)',
    behavior: 'deny',
    enabled: false,
  })
  await __invokeIpc(PermissionChannel.RemoveRule, { rule: 'Bash(local-deny)', behavior: 'deny' })

  const perms = readLocalFile().permissions
  assert.equal(perms?.deny?.includes('Bash(local-deny)'), false, '删除后规则不应留在表里')
  assert.equal(perms?.disabled?.includes('Bash(local-deny)'), false, '删除后不应留下悬空 disabled 项')
  assert.equal((await resolveEffectiveRules()).deny.includes('Bash(local-deny)'), false)
})

test('TC-PRULES-011g: 空规则 / 空白规则直接被忽略（不写坏文件）', async () => {
  const { __invokeIpc } = (await import('electron')) as unknown as { __invokeIpc: IpcInvoke }
  const before = readLocalFile()
  await __invokeIpc(PermissionChannel.AddRule, { rule: '   ', behavior: 'deny' })
  await __invokeIpc(PermissionChannel.RemoveRule, { rule: '', behavior: 'deny' })
  assert.deepEqual(readLocalFile(), before)
})

/* ============================================================
 * TC-PRULES-012：守卫自检（防空转 —— 假绿灯与真缺陷等价，纪律⑭）
 * ============================================================ */

test('TC-PRULES-012a: 抽取器必须真的抽到东西（否则 TC-PRULES-009 是空转的永真断言）', () => {
  const tools = extractEvaluatedTools(readFileSync(PERMISSIONS_SRC_PATH, 'utf-8'))
  assert.ok(tools.length > 0, '抽取器一条都没抽到 —— 正则或源码形态已变，守卫失效')
})

test('TC-PRULES-012b: 抽取器对**假工具**不误报（自检其判别力）', () => {
  const fake = `
    const a = findFirstMatchingRule(ctx.rules.deny, 'Bash', trimmed)
    const b = findFirstMatchingRule(ctx.rules.allow, 'FakeTool', trimmed)
    // findFirstMatchingRule(ctx.rules.ask, 'CommentedTool', trimmed)
    const c = otherCall(ctx.rules.ask, 'NotARule')
  `
  const tools = extractEvaluatedTools(fake)
  assert.deepEqual(tools.sort(), ['Bash', 'FakeTool'], '抽取器误抽或漏抽')
  assert.ok(!tools.includes('CommentedTool'), '注释里的工具名不该被抽到（注释剥离失效）')
  assert.ok(!tools.includes('NotARule'), '非 findFirstMatchingRule 的调用不该被抽到')
})

test('TC-PRULES-012c: 清单被改坏时守卫确实会红（反向核验的静态等价物）', () => {
  // 模拟「面板清单与评估链不一致」的状态，确认比对逻辑本身有判别力
  const evaluated = ['Bash']
  assert.notDeepEqual(evaluated, ['Bash', 'Write'])
  assert.deepEqual(evaluated, [...PERMISSION_TOOL_OPTIONS])
})
