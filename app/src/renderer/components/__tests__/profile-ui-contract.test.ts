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
import { readFileSync, readdirSync } from 'node:fs'

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

test('TC-PUI-009 profile 的 dockTabs 是视图层覆盖，绝不回写 dockPrefs（不毁用户偏好）', () => {
  const dock = CODE(`${APP}/src/renderer/components/RightDock.tsx`)
  assert.match(dock, /profileDockTabs \?\? dockTabs/)
  // profile 覆盖点之后的 400 字符内不许出现写回（既有的用户自定义入口在更后面，属另一条语义）
  const at = dock.indexOf('profileDockTabs ?? dockTabs')
  assert.ok(at >= 0)
  assert.ok(!/setDockPrefs/.test(dock.slice(at, at + 400)), '不得在覆盖点附近反向写回偏好')
  const slice = CODE(`${APP}/src/renderer/store/slices/profileSlice.ts`)
  assert.ok(!/setDockPrefs/.test(slice), 'profileSlice 不得触碰 dockPrefs')
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

  assert.match(body, /await activateProfile\(id\)/, '启动挂载必须无条件调用 activateProfile')
  // 早退形态一网打尽：任何在 activateProfile 之前的 return
  const beforeCall = body.slice(0, body.indexOf('await activateProfile(id)'))
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
  // bootstrapProfile 之所以能无条件重挂，全靠 activateProfile 提交段先 reset 再注册。
  // 若这条前提被删掉，D34 的修复会立刻变成「第二次启动直接 throw」的启动崩溃。
  const act = CODE(`${APP}/src/main/profile/activator.ts`)
  const i = act.indexOf('resetProfileSlots()')
  assert.ok(i >= 0, '装配器必须调用 resetProfileSlots')
  const reg = act.indexOf('registerSlot(s.kind, s)', i)
  assert.ok(reg > i, '必须先清槽、后重注册（顺序反了会抛「同 kind 下 id 已存在」）')
})
