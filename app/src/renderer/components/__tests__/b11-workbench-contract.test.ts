/* ============================================================
 * ArkWork — v0.36.0 B11 文件树 / 工作台路由 / 向导 契约测试
 * 形态：源码正则契约（沿用 task-panel-fix2.test.ts 范式）+ 纯字面量断言。
 * 纪律 #12：源码守卫断言前必须**剥离注释**（注释里提到坏写法会误报）；
 *           且「接线类代码必须有接线契约用例」（D78/D79 教训）。
 * 规格来源：docs/versions/v0.36.0/12-b11-fix-batch-design.md §二/§三/§四
 * 运行（cwd=app）：node scripts/run-tests.mjs b11-workbench-contract
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUILTIN_PROFILES } from '../../../main/profile/builtins.js'
import { stripComments } from '@shared/utils/source-guard'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const appRoot = join(ROOT, '../..')

/** 读源码并剥离注释（纪律 #12 + D101/D102：唯一真源 `stripComments`，禁止自写） */
function src(rel: string): string {
  return stripComments(readFileSync(join(appRoot, rel), 'utf-8'))
}

const FILES_PANEL = 'app/src/renderer/components/panels/FilesPanel.tsx'
const FS_SLICE = 'app/src/renderer/store/slices/fsSlice.ts'
const FS_IPC = 'app/src/main/ipc/fs.ts'
const WORKSPACE = 'app/src/main/fs/workspace.ts'
const PRELOAD = 'app/src/preload/index.ts'
const PROFILE_SLICE = 'app/src/renderer/store/slices/profileSlice.ts'
const WIZARD = 'app/src/renderer/components/workbench/ProfileWizard.tsx'
const EDITOR = 'app/src/renderer/components/workbench/ProfileEditor.tsx'

/* ---------- P1 文件树 ---------- */

test('TC-FTREE-001 顶层目录一次点击收起：toggle 按「当前生效态」取反（接线契约）', () => {
  const s = src(FS_SLICE)
  assert.match(s, /toggleTreeNode: \(path, defaultOpen\) =>/)
  assert.match(s, /!\(\s*s\.treeExpanded\[path\]\s*\?\?\s*defaultOpen\s*\)/)
})

test('TC-FTREE-002 懒加载接线：fs:list-dir IPC 全链路（main + preload + 渲染层调用）', () => {
  assert.match(src(FS_IPC), /'fs:list-dir'/)
  // v0.36.3 D115：用户面读取不再对越界硬拒（工作区内相对路径必须能展开），
  // 改经唯一归一化点 resolveUserPath（边界真源仍在 fs/guard.ts，LLM 工具面不受影响）
  assert.match(src(FS_IPC), /resolveUserPath\(dirPath\)/)
  assert.match(src(FS_IPC), /import \{[^}]*resolveUserPath[^}]*\} from '\.\.\/fs\/guard\.js'/)
  assert.match(src(PRELOAD), /listDir: \(dirPath\) => ipcRenderer\.invoke\('fs:list-dir', dirPath\)/)
  assert.match(src(FS_SLICE), /ark\.fs\.listDir\(path\)/)
})

test('TC-FTREE-003 深度边界语义：截断目录 children=undefined（未加载）而非 []（确认空）', () => {
  const s = src(WORKSPACE)
  assert.match(s, /depth \+ 1 >= maxDepth \? undefined : await walk/)
})

test('TC-FTREE-004 全部展开/收起都显式写展开表（v0.36.2 D113：收起不得清空表 —— 清空会让顶层回落 defaultOpen=true）', () => {
  const s = src(FS_SLICE)
  assert.match(s, /expandAllTreeNodes: \(\) =>/)
  assert.match(s, /walk\(get\(\)\.files\)/)
  // D113：collapseAll 对每个已加载文件夹显式写 false（两个 walk 各写 true / false）
  assert.match(s, /collapseAllTreeNodes: \(\) =>/, 'collapseAll 仍是 slice 方法')
  const panel = src(FILES_PANEL)
  assert.match(panel, /expandAllTreeNodes/)
  assert.match(panel, /collapseAllTreeNodes/)
  assert.match(panel, /Icon\.ChevronsDown/)
  assert.match(panel, /Icon\.ChevronsUp/)
  // D113：双击防抖（第二击不再取反，消除净零抖动）
  assert.match(panel, /lastToggleAt/, '双击防抖时间戳')
  assert.match(panel, /now - lastToggleAt\.current < 300/)
})

test('TC-FTREE-005 搜索过滤态 toggle 显式 no-op（此前点了无反馈）', () => {
  assert.match(src(FILES_PANEL), /if \(forceOpen\) return/)
})

test('TC-FTREE-006 初始深度 3 + 默认 ignore（node_modules 不再全量扫）', () => {
  const s = src(FS_IPC)
  assert.match(s, /listTree\(ws, \{ maxDepth: 3 \}\)/)
})

test('TC-FTREE-007 i18n 键四语言齐全（expandAll/collapseAll/loading）', () => {
  const localesDir = join(appRoot, 'app/src/renderer/i18n/locales')
  for (const f of ['zh.json', 'en.json', 'ja.json', 'ko.json']) {
    const j = JSON.parse(readFileSync(join(localesDir, f), 'utf-8'))
    for (const k of ['expandAll', 'expandAllDesc', 'collapseAll', 'collapseAllDesc', 'loading']) {
      assert.ok(j.panel?.files?.[k], `${f} 缺 panel.files.${k}`)
    }
    for (const k of ['pluginFilterHint', 'pluginFilterFailed', 'noAgent', 'noAgentHint']) {
      assert.ok(
        j.workbench?.editor?.[k] ?? j.workbench?.wizard?.[k],
        `${f} 缺 workbench 键 ${k}`,
      )
    }
  }
})

/* ---------- P2 工作台 → 知识库误跳 ---------- */

test('TC-WB-001 研究工作台不再声明 homeModule=kb（点研究台落在本位）', () => {
  const research = BUILTIN_PROFILES.find((p) => p.id === 'wb.research')
  assert.ok(research)
  assert.equal(research.ui.homeModule, undefined)
})

test('TC-WB-002 切台复位 modulePage（残留模块页不跨台携带）', () => {
  const s = src(PROFILE_SLICE)
  assert.match(s, /if \(get\(\)\.modulePage\) get\(\)\.closeModulePage\(\)/)
})

/* ---------- P3-c 创建工作台 agent 可选 ---------- */

test('TC-WIZ-001 向导 agent 步骤可跳过（canNext 不再强制 agentDefault + 显式「不绑定」选项）', () => {
  const s = src(WIZARD)
  assert.ok(!/step === 'agent'\s*\?\s*Boolean\(draft && draft\.agentDefault\)/.test(s), 'canNext 不得强制 agentDefault')
  assert.match(s, /data-agent="none"/)
  assert.match(s, /agentDefault: ''/, '「不绑定」必须把默认 agent 清空')
})

test('TC-WIZ-002 编辑器允许清空全部 agent（最后一个不可取消的旧守卫已移除）', () => {
  const s = src(EDITOR)
  assert.ok(!/agentOn\.length <= 1/.test(s), '旧守卫 agentOn.length <= 1 必须移除')
})
