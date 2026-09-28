/* ============================================================
 * v0.36.0（B7 / F4.1–F4.3）— 子 agent 并行 UI 契约（TC-SU-001..012）
 *
 * 为什么是源码契约而不是渲染断言：
 *   · SubagentGroupCard 依赖 zustand + i18n + icons，node:test 直接 import 会拉
 *     window/store 一整条链；本仓库既有体例（profile-ui-contract / perf-mode）
 *     对这类组件用「结构事实」契约。
 * 但**不因此放宽**（纪律⑥ / D89 的教训）：
 *   · 每条断言锚的是**在位的接线**（谁 import 谁、谁渲染谁、谁调用谁），
 *     而不是"文件里出现过某个词"；
 *   · 凡是「按钮 → store → IPC → main handler」四段链路，四段一起断；
 *     少一段就报红（这正是 D78/D79「函数全对、接线缺失」的守门方式）。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs subagent-ui-contract
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripComments } from '@shared/utils/source-guard'

const R = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf-8')
/** 去注释后的源码（避免注释里的示例串被误判为真实代码 —— D89 的教训） */
const CODE = (rel: string): string =>
  stripComments(R(rel))

const APP = '../../../..'

/* ============================================================
 * 一、块在渲染树中（不是"文件存在"就算数）
 * ============================================================ */

test('TC-SU-001 BlockRenderer 真实渲染 SubagentGroupCard（kind switch 有分支 + 组件在 import 里）', () => {
  const src = CODE(`${APP}/src/renderer/components/flow/BlockRenderer.tsx`)
  assert.match(
    src,
    /import \{[^}]*SubagentGroupCard[^}]*\} from '\.\/blocks'/,
    '必须从 blocks 桶引入组件',
  )
  assert.match(src, /case 'subagent-group':\s*return <SubagentGroupCard block=\{block\} \/>/, 'kind switch 必须真渲染它')
})

test('TC-SU-002 blocks/index 桶导出 SubagentGroupCard（否则 import 解析不到）', () => {
  const src = CODE(`${APP}/src/renderer/components/flow/blocks/index.ts`)
  assert.match(src, /export \{ SubagentGroupCard \} from '\.\/SubagentGroupCard'/)
})

test('TC-SU-003 project.ts：subagentGroups → 末轮 outerBlocks 的 subagent-group 块（含 settled 与 running 提升）', () => {
  const src = CODE(`${APP}/src/renderer/flow/project.ts`)
  assert.match(src, /subagentGroups\?: SubagentChildView\[\]/, 'ProjectInput 必须显式接收该数据源')
  assert.match(src, /kind: 'subagent-group'/, '必须产出该块')
  assert.match(
    src,
    /const settled = subChildren\.every/,
    'settled 必须是"全部到达终态"的判定，不能硬编码',
  )
  assert.match(src, /if \(!settled\) t\.status = 'running'/, '未终结时要让该轮保持运行态（轮头不能显示已完成）')
  assert.match(src, /turns\[turns\.length - 1\]/, '必须挂末轮（delegate 是阻塞式工具调用，过程就在最后一轮）')
})

test('TC-SU-004 TurnList 把 store.subagentGroups 喂进投影（含 useMemo 依赖，否则不刷新）', () => {
  const src = CODE(`${APP}/src/renderer/components/flow/TurnList.tsx`)
  assert.match(src, /s\.subagentGroups\[s\.selectedTaskId\]/, '必须从 store 取当前任务的组')
  assert.match(src, /subagentGroups,\s*\n\s*\}\)/, '必须传给 projectConversation')
  assert.match(src, /\[taskId, items, steps, streamBuffer, textStreamBuffer, task\?\.planItems, flow, subagentGroups, flowEvents\]/, '依赖数组必须含 subagentGroups（v0.36.0 B11 扩入 textStreamBuffer；v0.38.0 扩入 flowEvents）')
})

/* ============================================================
 * 二、store 侧：字段认领 + 事件接线
 * ============================================================ */

test('TC-SU-005 AppState 声明了 subagentGroups 一族字段，且 tasksSlice 真的认领', () => {
  const types = R(`${APP}/src/renderer/store/types.ts`)
  for (const f of [
    'subagentGroups',
    'applySubagentProgress',
    'backfillSubagentStep',
    'cancelSubagent',
    'retrySubagent',
  ]) {
    assert.match(types, new RegExp(`\\b${f}\\b`), `AppState 必须声明 ${f}`)
  }
  const slice = CODE(`${APP}/src/renderer/store/slices/tasksSlice.ts`)
  for (const f of [
    'subagentGroups: {}',
    'applySubagentProgress:',
    'backfillSubagentStep:',
    'cancelSubagent: async',
    'retrySubagent: async',
  ]) {
    assert.ok(slice.includes(f), `tasksSlice 必须实现 ${f}`)
  }
  // 字段必须写进 Pick 白名单，否则 slice 的返回值不被类型接受（形同虚设）
  assert.match(slice, /'subagentGroups'/)
  assert.match(slice, /'cancelSubagent'/)
})

test('TC-SU-006 subscriptions：进度事件落 store + 留函数日志；子任务 step 回填摘要', () => {
  const src = CODE(`${APP}/src/renderer/store/subscriptions.ts`)
  assert.match(src, /event\.type === 'task:subagent-progress'/, '必须收口该事件')
  assert.match(src, /get\(\)\.applySubagentProgress\(event\)/, '必须真正写进 store（不是只打日志）')
  assert.match(
    src,
    /backfillSubagentStep\(step\.taskId, summary\)/,
    '子任务步进必须回填 stepSummary（否则卡片上只有终态一句话）',
  )
})

/* ============================================================
 * 三、四段链路：按钮 → store → IPC → main handler
 * ============================================================ */

test('TC-SU-007 卡片按钮不是死按钮：取消/重试都接到 store 动作', () => {
  const src = CODE(`${APP}/src/renderer/components/flow/blocks/SubagentGroupCard.tsx`)
  assert.match(src, /const cancelSubagent = useStore\(\(s\) => s\.cancelSubagent\)/)
  assert.match(src, /const retrySubagent = useStore\(\(s\) => s\.retrySubagent\)/)
  assert.match(src, /void cancelSubagent\(c\.childTaskId\)/, '取消按钮必须真的调用')
  assert.match(src, /void retrySubagent\(\{/, '重试按钮必须真的调用')
  // 失败态必须给重试入口（原型 P5 error 态）
  assert.match(src, /data-testid="subagent-retry"/)
  assert.match(src, /data-status=\{c\.status\}/, '状态必须落到 DOM（实机走查与 UI 测试要靠它）')
})

test('TC-SU-008 IPC 四段同步：ArkApi 声明 / preload 实现 / main handler 注册 / 通道名一致', () => {
  const ipcTypes = R(`${APP}/src/shared/types/ipc.ts`)
  const preload = CODE(`${APP}/src/preload/index.ts`)
  const taskIpc = CODE(`${APP}/src/main/ipc/task.ts`)

  assert.match(ipcTypes, /cancelSubagent: \(childTaskId: string\) => Promise<SubagentActionResult>/)
  assert.match(ipcTypes, /retrySubagent: \(payload: \{\s*\n\s*parentTaskId: string/)
  assert.match(ipcTypes, /export type SubagentActionResult =/)

  assert.match(preload, /cancelSubagent: \(childTaskId\) => ipcRenderer\.invoke\('task:cancel-subagent', childTaskId\)/)
  assert.match(preload, /retrySubagent: \(payload\) => ipcRenderer\.invoke\('task:retry-subagent', payload\)/)

  assert.match(taskIpc, /ipcMain\.handle\('task:cancel-subagent'/)
  assert.match(taskIpc, /ipcMain\.handle\('task:retry-subagent'/)
  assert.match(taskIpc, /cancelDelegateChild\(childTaskId\)/, '取消必须走真实的中断入口')
  assert.match(taskIpc, /await delegateAgent\(/, '重试必须复用 delegate 通道单发（不是另起一套）')
})

test('TC-SU-009 取消失败不得静默：回执带人话 message，store 侧要弹 toast', () => {
  const taskIpc = CODE(`${APP}/src/main/ipc/task.ts`)
  assert.match(taskIpc, /ok: false, message: '子任务已结束或不在运行中，无需取消'/)
  const slice = CODE(`${APP}/src/renderer/store/slices/tasksSlice.ts`)
  assert.match(slice, /if \(!r\.ok\) get\(\)\.pushToast\(\{ type: 'warning', message: r\.message/, '失败必须有可见反馈（纪律⑨）')
})

/* ============================================================
 * 四、导出同源（D69）与 i18n parity
 * ============================================================ */

test('TC-SU-010 导出与屏幕同源：buildConversationMarkdown 也传 subagentGroups', () => {
  const src = CODE(`${APP}/src/renderer/store/slices/tasksSlice.ts`)
  assert.match(
    src,
    /subagentGroups: state\.subagentGroups\[taskId\]/,
    '导出必须与 TurnList 同一入参（D69：屏幕看得到、导出看不到 = 缺陷）',
  )
})

test('TC-SU-011 i18n 四语言 parity：subagent 与 composer agent 选择器文案齐全', () => {
  const need = {
    conversationflow: ['subagent'],
    composer: ['agentFilterPlaceholder', 'agentFilterEmpty', 'agentSectionGlobal', 'agentSectionWorkspace', 'manageAgents'],
  }
  for (const loc of ['zh', 'en', 'ja', 'ko']) {
    const dict = JSON.parse(R(`${APP}/src/renderer/i18n/locales/${loc}.json`)) as Record<string, Record<string, unknown>>
    for (const [section, keys] of Object.entries(need)) {
      for (const k of keys) {
        assert.ok(dict[section]?.[k], `${loc}.json 缺 ${section}.${k}`)
      }
    }
    const sub = dict.conversationflow!.subagent as Record<string, unknown>
    for (const k of ['title', 'progress', 'settledAll', 'settledWithFailures', 'cancel', 'retry', 'waiting', 'status']) {
      assert.ok(sub[k], `${loc}.json 缺 conversationflow.subagent.${k}`)
    }
  }
})

test('TC-SU-012 无 emoji 图标（一律 Icon.*），且 P6 面板真做了分区与过滤', () => {
  const card = CODE(`${APP}/src/renderer/components/flow/blocks/SubagentGroupCard.tsx`)
  assert.match(card, /import \{ Icon \} from '\.\.\/\.\.\/\.\.\/icons'/)
  assert.doesNotMatch(card, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, '不得使用 emoji 图标')

  const composer = CODE(`${APP}/src/renderer/components/Composer.tsx`)
  assert.match(composer, /const \[agentFilter, setAgentFilter\] = useState\(''\)/, 'P6 必须有输入过滤')
  assert.match(composer, /AgentSection/, '必须有分区组件')
  assert.match(composer, /a\.workspaceBuiltin === true/, '分区依据必须是 workspaceBuiltin（不是靠名字猜）')
  assert.match(
    composer,
    /onClick=\{\(\) => \{\s*\n\s*openModulePage\('agents'\)/,
    '「管理 agent」必须真的跳到 agents 模块页',
  )
})
