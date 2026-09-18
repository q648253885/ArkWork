/* ============================================================
 * v0.32.0 — 插件模式 UI 契约（TC-PUI-001..010）
 *
 * 为什么是源码契约而不是渲染断言：
 *   · `profileSlice` 顶层经 ipc/client 读 window → node:test 无法 import；
 *   · ProfileSwitcher 依赖 zustand + i18n + icons。
 * 因此这里守住**不可退化的结构事实**（挂载点 / 字段归属 / IPC 三处同步 /
 * i18n 四语言 parity / 无 emoji / 折叠条不涉及 profile 泄漏），同
 * `interactive-copy.test.ts` 与 `perf-mode.test.ts` 的既有体例。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs profile-ui-contract
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const R = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf-8')
/** 去注释后的源码（避免注释里的示例串被误判为真实代码） */
const CODE = (rel: string): string => R(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

const APP = '../../../..'

test('TC-PUI-001 TopBar 挂载 ProfileSwitcher 且位于右侧控制区', () => {
  const src = CODE(`${APP}/src/renderer/components/TopBar.tsx`)
  assert.match(src, /import \{ ProfileSwitcher \} from '\.\/ProfileSwitcher'/)
  assert.match(src, /<ProfileSwitcher \/>/, '必须在 TopBar 里真实渲染')
  // 顺序：ProfileSwitcher 出现在 settings 按钮之前（右侧控制区最左）
  assert.ok(src.indexOf('<ProfileSwitcher />') < src.indexOf("openModulePage('settings')"))
})

test('TC-PUI-002 profileSlice 认领的字段必须在 AppState 里声明齐（否则 slice 形同虚设）', () => {
  const slice = CODE(`${APP}/src/renderer/store/slices/profileSlice.ts`)
  const types = R(`${APP}/src/renderer/store/types.ts`)
  for (const f of [
    'profiles',
    'activeProfileId',
    'profileSnapshot',
    'profileDegraded',
    'profileLastReport',
    'profileBusy',
    'profileLoaded',
    'profileDockTabs',
    'profileHomeModule',
    'profileComposerChips',
    'loadProfiles',
    'switchProfile',
    'applyProfileToView',
    'subscribeProfileChanges',
  ]) {
    assert.ok(new RegExp(`\\n\\s+${f}\\b`).test(types), `AppState 缺少 ${f}`)
    assert.ok(new RegExp(`\\b${f}\\b`).test(slice), `slice 未产出 ${f}`)
  }
})

test('TC-PUI-003 IPC 三处同步：通道常量 / ArkApi 接口 / preload 实现', () => {
  const ipcTypes = R(`${APP}/src/shared/types/ipc.ts`)
  const preload = CODE(`${APP}/src/preload/index.ts`)
  assert.match(ipcTypes, /export const ProfileChannel/)
  assert.match(ipcTypes, /profile: \{/)
  for (const ch of ['profile:list', 'profile:get-active', 'profile:activate', 'profile:validate', 'profile:import', 'profile:delete', 'profile:slots']) {
    assert.ok(ipcTypes.includes(`'${ch}'`), `ipc.ts 缺 ${ch}`)
    assert.ok(preload.includes(`invoke('${ch}'`), `preload 缺 ${ch}`)
  }
  assert.match(preload, /ipcRenderer\.on\('profile:changed'/)
})

test('TC-PUI-004 main/ipc/index.ts 注册 profile handlers 并导出启动钩子；主进程真实调用它', () => {
  const idx = CODE(`${APP}/src/main/ipc/index.ts`)
  const mainIdx = CODE(`${APP}/src/main/index.ts`)
  assert.match(idx, /registerProfileHandlers\(\)/)
  assert.match(idx, /export async function bootstrapIpcSideEffects/)
  assert.match(mainIdx, /await bootstrapIpcSideEffects\(\)/, '主进程必须在窗口创建前挂载 profile')
})

test('TC-PUI-005 降级必须可见：徽标 + 可展开明细 + 快照三层都要存在', () => {
  const src = CODE(`${APP}/src/renderer/components/ProfileSwitcher.tsx`)
  assert.match(src, /profile-switcher__badge/, '必须有降级徽标')
  assert.match(src, /profile-switcher__degraded-list/, '必须有逐条降级明细')
  assert.match(src, /profile-switcher__snapshot/, '必须有装配快照面板')
  assert.match(src, /d\.blocking \? 'text-danger' : 'text-text-secondary'/, '阻断项与非阻断项视觉必须可区分')
})

test('TC-PUI-006 图标禁用 emoji：manifest icon 走宿主 Icon 白名单查表 + 回落', () => {
  const src = CODE(`${APP}/src/renderer/components/ProfileSwitcher.tsx`)
  assert.match(src, /table\[key\] \?\? Icon\.Box/, '未知 icon 名必须回落到内置图标')
  // emoji 检测（项目硬规范：禁 emoji 图标）
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u
  assert.ok(!emoji.test(src), '组件源码不得出现 emoji')
})

test('TC-PUI-007 profile i18n 四语言完全 parity（漏一门就是用户看到 {{key}}）', () => {
  const dir = new URL(`${APP}/src/renderer/i18n/locales/`, import.meta.url)
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  assert.deepEqual(files.sort(), ['en.json', 'ja.json', 'ko.json', 'zh.json'])
  const collect = (obj: unknown, prefix = '', out: string[] = []): string[] => {
    if (typeof obj !== 'object' || obj === null) return out
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof v === 'object') collect(v, `${prefix}${k}.`, out)
      else out.push(`${prefix}${k}`)
    }
    return out
  }
  const profiles = files.map((f) => {
    const json = JSON.parse(readFileSync(new URL(f, dir), 'utf-8')) as { profile?: unknown }
    assert.ok(json.profile, `${f} 缺 profile 段`)
    return collect(json.profile, 'profile.').sort()
  })
  for (let i = 1; i < profiles.length; i++) {
    assert.deepEqual(profiles[i], profiles[0], `${files[i]} 的 profile 键与 ${files[0]} 不一致`)
  }
  // aria 里不许残留未插值变量（TC-PUI-007 的直接诱因）
  const zh = JSON.parse(readFileSync(new URL('zh.json', dir), 'utf-8')) as { profile: { switcher: { aria: string } } }
  assert.ok(!zh.profile.switcher.aria.includes('{{kbd}}'))
})

test('TC-PUI-008 切换失败不得改写视图态（事务性在 UI 侧的镜像保证）', () => {
  const src = CODE(`${APP}/src/renderer/store/slices/profileSlice.ts`)
  // 注意：`subscribeProfileChanges` 在接口声明里先出现过一次，不能拿它当右边界
  const start = src.indexOf('switchProfile: async')
  const body = start >= 0 ? src.slice(start, start + 1200) : ''
  assert.match(body, /if \(!report\.ok\)/, '必须分支处理失败')
  assert.ok(body.indexOf('set({ profileBusy: false, profileLastReport: report })') < body.indexOf('if (!report.ok)'), '失败记录在前，视图更新在后')
  assert.match(body, /pushToast/, '失败必须给用户可感知反馈')
})


test('TC-PUI-010 工具集联动只加不减：assembleTools 并入 profile 技能而非替换', () => {
  const src = CODE(`${APP}/src/main/agent/engine/messages.ts`)
  assert.match(src, /getLastSnapshot\(\)/, '必须读取当前工作台快照')
  assert.match(src, /skillIdSet\.add\(t\.ref\)/, '并入是叠加语义')
  assert.ok(!/return \[\.\.\.snap/.test(src), '不得用快照整体替换既有工具集')
})

test('TC-PUI-011 缺陷 D34 防回潮：启动挂载必须每次真重挂（插槽是进程内内存态）', () => {
  // 病根：bootstrapProfile 里「磁盘快照已匹配 → 直接 return」的早退。
  // 插槽注册表是 profile/slots.ts 的模块级 Map，新进程里本来就是空的，
  // 于是第二次及以后的每次启动都空挂五层插槽，而 UI 与快照都宣称「已激活」。
  const src = CODE(`${APP}/src/main/ipc/profile.ts`)
  const start = src.indexOf('export async function bootstrapProfile')
  assert.ok(start >= 0, '未找到 bootstrapProfile')
  const body = src.slice(start)

  assert.match(body, /await bootstrapActiveProfile\(\)/, '启动挂载必须无条件调用 bootstrapActiveProfile（v0.33.0：内置插槽+装配+插件刷新三步收敛）')
  // 早退形态一网打尽：任何在 activateProfile 之前的 return
  const beforeCall = body.slice(0, body.indexOf('await bootstrapActiveProfile()'))
  assert.ok(
    !/\breturn\b/.test(beforeCall),
    'activateProfile 之前不得出现任何 return —— 早退即 D34 回归',
  )
  assert.ok(
    !/existing\.profileId === id/.test(body),
    '「快照匹配即跳过」的判据不得复现（磁盘有快照 ≠ 运行时已装配）',
  )
  // 理由必须写在注释里（去注释后的 CODE 里查不到，回原文查）
  assert.ok(R(`${APP}/src/main/ipc/profile.ts`).includes('D34'), '必须留下缺陷编号与理由，避免后人「优化」回去')
})

test('TC-PUI-012 装配器必须自带清槽，否则重入式重挂会撞 id 唯一约束', () => {
  // bootstrapProfile 之所以能无条件重挂，全靠提交段「先按来源清、再注册」（v0.33.0
  // 起收敛进 applyProfileSlots）。若这条前提被删掉，D34 的修复会立刻变成
  // 「第二次启动直接 throw」的启动崩溃。回滚段同理，必须复用同一入口。
  const act = CODE(`${APP}/src/main/profile/activator.ts`)
  const fnStart = act.indexOf('export function applyProfileSlots')
  assert.ok(fnStart >= 0, '装配器必须保留 applyProfileSlots 作为唯一清槽+注册入口')
  const body = act.slice(fnStart, act.indexOf('\n}', fnStart))
  const i = body.indexOf('resetProfileSlots(')
  assert.ok(i >= 0, 'applyProfileSlots 必须按来源清槽（resetProfileSlots）')
  assert.match(body.slice(i, i + 40), /resetProfileSlots\(\s*'profile'\s*\)/, '清槽必须限定 profile 来源，不能连内置/插件一起清（D42）')
  const reg = body.indexOf('registerSlot(s.kind, s', i)
  assert.ok(reg > i, '必须先清槽、后重注册（顺序反了会抛「同 kind 下 id 已存在」）')
  // 提交段与回滚段都必须走同一入口，杜绝「只清一处」的半修
  assert.equal(
    (act.match(/applyProfileSlots\(/g) ?? []).length >= 3,
    true,
    '提交段 / 回滚段 / 定义处都必须经过 applyProfileSlots',
  )
})

/* ============================================================
 * v0.33.0 追加（TC-PUI-009 改写 + TC-PUI-013..020）
 * ============================================================ */

test('TC-PUI-009（v0.33.0 改写）profile 的 Tab 顺序是视图层覆盖，绝不回写偏好', () => {
  // RightDock 已删除（TC-PUI-013），覆盖点收敛进 Inspector：
  // 内置 Tab 顺序仍来自用户偏好，面板 Tab 插入点只认 manifest position。
  const ins = CODE(`${APP}/src/renderer/components/Inspector.tsx`)
  assert.match(ins, /profilePanels/, 'Inspector 必须消费 profilePanels（面板 Tab）')
  const slice = CODE(`${APP}/src/renderer/store/slices/profileSlice.ts`)
  assert.ok(!/setDockPrefs/.test(slice), 'profileSlice 不得触碰 dockPrefs（用户拖拽偏好不被覆盖）')
})

test('TC-PUI-013 RightDock.tsx 文件不存在（死组件已清理，不得复活）', () => {
  const { existsSync } = await0()
  assert.equal(existsSync(new URL(`${APP}/src/renderer/components/RightDock.tsx`, import.meta.url)), false)
})

/** existsSync 的小助手（避免顶部再 import 一个用不到的分支） */
function await0() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return { existsSync: (u: URL) => { try { return R0(u) } catch { return false } } }
}
function R0(u: URL): string {
  // readFileSync 抛错 = 不存在
  return readFileSync(u, 'utf-8')
}

test('TC-PUI-014 App.tsx 渲染 Inspector（消费方必须在渲染树中）', () => {
  const app = CODE(`${APP}/src/renderer/App.tsx`)
  assert.match(app, /<Inspector/)
})

test('TC-PUI-015 Inspector 面板 Tab 顺序走 mergePanelOrder（顺序真源唯一）', () => {
  const ins = CODE(`${APP}/src/renderer/components/Inspector.tsx`)
  assert.match(ins, /mergePanelOrder\(/, '最终 Tab 序必须经 mergePanelOrder 合成')
  // 内置六 Tab 顺序来自用户偏好（inspectorTabOrder 过滤隐藏项），面板插入点只认 profilePanels
  assert.match(ins, /builtinTabsOf\(visibleBuiltin\)/, 'base 必须是用户偏好管辖的内置序')
  assert.match(ins, /profilePanels/, 'panels 必须来自插槽派生的 profilePanels')
})

test('TC-PUI-016 面板 Tab 不参与拖拽（顺序真源 = manifest position）', () => {
  const ins = CODE(`${APP}/src/renderer/components/Inspector.tsx`)
  // 实现为「只有内置 Tab 才可拖拽」——比字面 draggable={false} 更强
  assert.match(ins, /draggable\s*=\s*builtin/, 'draggable 必须收敛在内置 Tab（面板禁拖）')
})

test('TC-PUI-017 CenterStage 无任务分支读取 profileHomeModule（首页模块真生效）', () => {
  const cs = CODE(`${APP}/src/renderer/components/CenterStage.tsx`)
  assert.match(cs, /profileHomeModule/, '无任务首屏必须消费 profileHomeModule')
})

test('TC-PUI-018 profileSlice 调用 ark.profile.slots() 并落 store（插槽消费链路存在）', () => {
  const slice = CODE(`${APP}/src/renderer/store/slices/profileSlice.ts`)
  assert.match(slice, /ark\.profile\.slots\(\)/, '必须从主进程拉插槽快照')
  assert.match(slice, /deriveFromSlots/, '插槽快照必须经纯函数派生（panels/renderer/theme）')
})

test('TC-PUI-019 主题覆盖在 App 层落地（applyResolvedTheme + 清理对称）', () => {
  const app = CODE(`${APP}/src/renderer/App.tsx`)
  assert.match(app, /applyResolvedTheme/, '必须经 profile-theme 的落地函数（含存在性过滤）')
  assert.match(app, /clearThemeOverride/, 'effect 清理必须对称（先清上次写的键）')
  assert.match(app, /themeOverrides/, '覆盖表必须来自 store（不得组件自持副本）')
})

test('TC-PUI-020 全仓零 import RightDock（含表述清理）', () => {
  const walk = (dir: URL): URL[] => {
    const out: URL[] = []
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const u = new URL(`${e.name}${e.isDirectory() ? '/' : ''}`, dir)
      if (e.isDirectory()) out.push(...walk(u))
      else if (/\.(tsx?|jsx?)$/.test(e.name)) out.push(u)
    }
    return out
  }
  const root = new URL(`${APP}/src/renderer/`, import.meta.url)
  for (const f of walk(root)) {
    const src = R(fileURLToPath(f))
    assert.ok(!/from\s+'[^']*RightDock'/.test(src), `${f.pathname} 不得再 import RightDock`)
  }
})
