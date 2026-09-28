/* ============================================================
 * v0.36.0（B9.3 / F6.1 / P9）—— 权限规则 **UI 契约**（渲染层结构事实）
 *
 * 为什么是源码契约而不是渲染断言（沿用 profile-ui-contract / interactive-copy 体例）：
 *   · `permissionSlice` 经 ipc/client 读 `window` → node:test 无法 import；
 *   · 面板依赖 zustand + i18next + Icon 白名单（本仓无 jsdom）。
 * 因此这里守住**不可退化的结构事实**：
 *   挂载点真在渲染树里 / 五态 testid 齐 / editable 来源唯一 / IPC 三处同步 /
 *   「记住此选择」全链存在且旧单按钮已退役 / 文案纪律 / 无 emoji。
 *
 * ★ 组合关系：本套件（结构）+ `main/agent/__tests__/permission-rules-ui.test.ts`
 *   （语义：本地可写/越权拒绝/落盘回读）+ `shared/utils/__tests__/permission-rule.test.ts`
 *   （纯函数）三层互补，缺一层就有「全绿但功能坏」的空档。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs permission-panel-contract
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
/** 源码守卫的注释剥离器唯一真源（v0.36.0 · D101） */
import { stripComments } from '@shared/utils/source-guard'

const APP = '../../../..'
/** 注意：R/CODE 的路径是**相对本测试文件**解析的 */
const R = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf-8')
const CODE = (rel: string): string => stripComments(R(rel))

const PANEL = '../panels/PermissionRulesPanel.tsx'
const PANEL_ABS = fileURLToPath(new URL(PANEL, import.meta.url))
const SETTINGS = `${APP}/src/renderer/components/SettingsContent.tsx`
const TOOLCONFIRM = `${APP}/src/renderer/components/ToolConfirmLayer.tsx`
const SLICE = `${APP}/src/renderer/store/slices/permissionSlice.ts`
const TYPES = `${APP}/src/renderer/store/types.ts`
const IPC_TYPES = `${APP}/src/shared/types/ipc.ts`
const PRELOAD = `${APP}/src/preload/index.ts`
const MAIN_IPC = `${APP}/src/main/ipc/permission.ts`
const MAIN_IPC_INDEX = `${APP}/src/main/ipc/index.ts`

/* ============================================================
 * TC-PRULES-013：面板真在渲染树里（防「写了组件没人挂」）
 * ============================================================ */

test('TC-PRULES-013 权限规则面板必须被 SettingsContent 真实渲染，且内联三栏已移除', () => {
  const s = CODE(SETTINGS)
  assert.match(
    s,
    /import \{ PermissionRulesPanel \} from '\.\/panels\/PermissionRulesPanel'/,
    '必须具名 import 面板',
  )
  assert.match(s, /<PermissionRulesPanel \/>/, '必须在 PermissionSection 内真实渲染（不是只 import）')
  assert.ok(existsSync(PANEL_ABS), `${PANEL} 必须存在`)
  // 旧内联实现的三栏 chips 配色表不得残留（留着就是「一份改了不生效」）
  assert.doesNotMatch(s, /RULE_GROUPS/, '旧的 RULE_GROUPS 常量已删除，不得复活')
})

/* ============================================================
 * TC-PRULES-014：五态齐备（加载 / 错误 / 空 / 列表 / 规则预览）
 * ============================================================ */

test('TC-PRULES-014 P9 面板五态齐备（各态有稳定 testid，便于实机与后续 e2e 定位）', () => {
  const p = CODE(PANEL)
  for (const id of [
    'permission-rules-loading',
    'permission-rules-error',
    'permission-rules-empty',
    'permission-rules-list',
    'permission-rule-preview',
  ]) {
    assert.ok(p.includes(id), `面板缺 ${id}（五态之一没有落点）`)
  }
  // 加载态必须有条件（不能恒显示）；错误态必须能用「重试」自救
  assert.match(p, /if \(loading && entries\.length === 0\)/, '加载态必须只在「首次读取中」显示')
  assert.match(p, /rules === null && !loading/, '错误态判据必须是「从未成功过」')
  assert.match(p, /onClick=\{\(\) => void refresh\(\)\}/, '错误态必须给重试入口')
  // 空态必须给「运行中拦截弹窗可一键转规则」的引导，否则用户不知道规则从哪来
  assert.ok(p.includes('rules.emptyHint'), '空态必须给引导文案')
})

/* ============================================================
 * TC-PRULES-015：editable 的来源唯一（主进程判定，UI 不得自行推断）
 * ============================================================ */

test('TC-PRULES-015 逐行可写性只看 entry.editable，UI 不得自判 scope===\'local\'', () => {
  const p = CODE(PANEL)
  assert.match(p, /entry\.editable \?/, '行内分支必须以 entry.editable 为准')
  // 反向：不得以 scope 自行推导可写性（四级策略一旦变化，两边就会不一致）
  assert.doesNotMatch(p, /entry\.scope === 'local'/, '不得在 UI 侧推断可写性 —— editable 由主进程给定')
  // scope 只用于展示（徽标文案 / 配色 / 悬停提示）
  assert.match(p, /settings\.permission\.rules\.scope\.\$\{entry\.scope\}/, 'scope 应只用于展示来源')
  // 只读行必须显式标注，而不是给一个按了没反应的开关
  assert.ok(p.includes('settings.permission.rules.readonly'), '只读行必须显式标注')
  assert.ok(p.includes('settings.permission.rules.readonlyHint'), '只读行必须给出「为什么不能改」')
})

/* ============================================================
 * TC-PRULES-016：store 认领齐 + AppState 声明齐 + 与主进程字段对齐
 * ============================================================ */

test('TC-PRULES-016 store 字段/动作在 AppState 与 slice 两侧都成立（漏一处 slice 形同虚设）', () => {
  const slice = CODE(SLICE)
  const types = R(TYPES)
  for (const f of [
    'permissionRuleEntries',
    'permissionRulesLoading',
    'removePermissionRule',
    'setPermissionRuleEnabled',
  ]) {
    assert.ok(new RegExp(`\\n\\s+${f}\\b`).test(types), `AppState 缺少 ${f}`)
    assert.ok(new RegExp(`\\b${f}\\b`).test(slice), `slice 未产出 ${f}`)
  }
  // 刷新必须**同时**拉合并集与条目集（少一个，面板就会拿旧数据做逐行开关）
  assert.match(slice, /ark\.permission\.resolveRules\(\)/)
  assert.match(slice, /ark\.permission\.listRules\(\)/)
  assert.match(slice, /Promise\.all\(/, '两份数据必须并行拉取')
  // 逐行操作必须以「条目」为键（raw + behavior），否则同原文跨行为会误伤
  assert.match(slice, /removeRule\(\{ rule: entry\.raw, behavior: entry\.behavior \}\)/)
  assert.match(slice, /setRuleEnabled\(\{ rule: entry\.raw, behavior: entry\.behavior, enabled \}\)/)
  // 乐观更新后必须以磁盘真值覆盖回来（不做假象）
  assert.match(slice, /finally \{[\s\S]*?refreshPermissionRules\(\)/, '开关失败必须回读真值')
})

/* ============================================================
 * TC-PRULES-017：IPC 三处同步（通道常量 / ArkApi / preload / 主进程注册）
 * ============================================================ */

test('TC-PRULES-017 规则通道三处同步：常量 + ArkApi 签名 + preload 实现 + 主进程 handler', () => {
  const ipcTypes = R(IPC_TYPES)
  const preload = CODE(PRELOAD)
  const mainIpc = CODE(MAIN_IPC)
  const mainIndex = CODE(MAIN_IPC_INDEX)

  for (const ch of ['permission:listRules', 'permission:removeRule', 'permission:setRuleEnabled']) {
    assert.ok(ipcTypes.includes(`'${ch}'`), `PermissionChannel 缺 ${ch}`)
    assert.ok(preload.includes(`ipcRenderer.invoke('${ch}'`), `preload 未实现 ${ch}`)
    assert.ok(mainIpc.includes(`PermissionChannel.`), '主进程必须按 PermissionChannel 常量注册')
  }
  for (const m of ['listRules', 'removeRule', 'setRuleEnabled']) {
    assert.ok(new RegExp(`\\n\\s+${m}:`).test(ipcTypes), `ArkApi.permission 缺 ${m}`)
    assert.ok(new RegExp(`\\n\\s+${m}:`).test(preload), `preload.permission 缺 ${m}`)
  }
  // addRule 的第二参语义已从 scope 改名 behavior（旧名骗人：当时只能写 allow）
  assert.match(ipcTypes, /addRule: \(rule: string, behavior\?: PermissionRuleBehavior\)/)
  assert.doesNotMatch(ipcTypes, /addRule: \(rule: string, scope\?/, '不得再保留历史上骗人的 scope 形参名')
  // 启动时必须注册（否则三处同步了但没人接）
  assert.match(mainIndex, /registerPermissionHandlers\(\)/, 'main/ipc/index.ts 必须注册权限 handler')
})

/* ============================================================
 * TC-PRULES-018：「记住此选择」全链 + 旧单按钮退役
 * ============================================================ */

test('TC-PRULES-018 拦截浮层的「记住此选择」链完整：建议 → 行为 → 预览 → 提交', () => {
  const tc = CODE(TOOLCONFIRM)
  // 建议规则与面板共用同一个纯函数（两处各写一份必然漂移）
  assert.match(tc, /import \{ RULE_BEHAVIORS, suggestRuleFromCommand \} from '@shared\/utils\/permission-rule'/)
  assert.match(tc, /suggestRuleFromCommand\(req\.command\)/, '必须由**被拦下的那次命令**推导建议')
  assert.match(tc, /rememberBehavior/, '必须有可选的记住行为')
  assert.match(tc, /addPermissionRule\(suggestedRule, rememberBehavior\)/, '提交必须带上选中的行为')
  assert.match(tc, /toolconfirm\.rememberPreview/, '必须先把「将写入什么」给用户看')
  assert.match(tc, /RULE_BEHAVIORS\.map/, '行为下拉必须来自唯一清单')
  // 旧实现（单按钮「总是允许」无条件写 allow）不得复活
  assert.doesNotMatch(tc, /alwaysAllow/, '旧的 alwaysAllow 单按钮已退役，不得复活')
  assert.doesNotMatch(tc, /toolconfirm\.addedAllowRule/, '旧的固定文案已退役')
})

/* ============================================================
 * TC-PRULES-019：文案与图标纪律
 * ============================================================ */

test('TC-PRULES-019 面板不得出现「诊断」字样；图标一律 Icon.* 白名单（禁 emoji）', () => {
  const p = CODE(PANEL)
  assert.doesNotMatch(p, /诊断/, '文案纪律：一律用户语言，禁止「诊断」字样（03-interaction §5）')
  assert.doesNotMatch(p, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, '禁止 emoji 图标')
  assert.match(p, /from '\.\.\/\.\.\/icons'/, '图标必须走 Icon.* 白名单')
})

/* ============================================================
 * TC-PRULES-020：面板不得把「规则不存在」当作错误（五态不许塌成四态）
 * ============================================================ */

test('TC-PRULES-020 五态互斥不塌陷：空态与错误态是两件事', () => {
  const p = CODE(PANEL)
  // 空态：读取成功但零条目 → 引导；错误态：从未成功 → 重试。
  // 若把两者合一，用户会把「读不到文件」当成「没有规则」——最糟的静默退化（纪律⑨）。
  const emptyBlock = p.slice(p.indexOf('entries.length === 0 ?'), p.indexOf('permission-rules-empty') + 200)
  assert.match(emptyBlock, /permission-rules-empty/)
  assert.doesNotMatch(emptyBlock, /rules\.loadFailed/, '空态不得复用错误态文案')
  assert.ok(
    p.indexOf('permission-rules-error') < p.indexOf('permission-rules-empty'),
    '错误态必须在空态之前短路（先判「从未成功」再判「零条目」）',
  )
})
