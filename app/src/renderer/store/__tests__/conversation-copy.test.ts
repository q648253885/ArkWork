/**
 * v0.34.1 — 「复制对话」契约测试（T2）
 *
 * 依据：docs/versions/v0.34.1（本版新增）—— 对话此前**只有导出**（落 .md 文件），
 * 用户想「把内容贴给别人」必须先落盘再打开，本版补一个复制入口。
 * 用例：TC-CPCV-001…008
 *
 * 为什么是**源码契约**而不是单测：
 *   tasksSlice 顶层读 `import.meta.env`（v0.31.0 B0 已记录），node:test 里
 *   import 即崩；与 interactive-copy.test.ts 同手法，锁结构性不变量。
 *
 * 三条不可退化的性质（每条都有独立用例，避免「全绿但测的是空气」）：
 *   ① 单一真源：复制与导出必须共用 buildConversationMarkdown（否则两份内容分叉）；
 *   ② 有挂点：类型 / store 实现 / 头部菜单 / 命令面板四处全接线（少一处 = 功能不可达）；
 *   ③ 有反馈：空内容 / 成功 / 失败三态各有 toast，且四语言 key 齐备（否则静默失败）。
 *
 * 运行（cwd=app）：
 *   npx tsx --test src/renderer/store/__tests__/conversation-copy.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf-8')

const SLICE = read('../slices/tasksSlice.ts')
const TYPES = read('../types.ts')
const STORE = read('../index.ts')
const HEADER = read('../../components/CenterStage.tsx')
const PALETTE = read('../../components/CommandPalette.tsx')
const LOCALES = ['zh', 'en', 'ja', 'ko'].map((l) => ({
  lang: l,
  json: JSON.parse(read(`../../i18n/locales/${l}.json`)) as Record<string, unknown>,
}))

/* ============================================================
 * ① 单一真源：复制与导出共用同一个 Markdown 构造器
 * ============================================================ */

test('TC-CPCV-001 存在纯函数 buildConversationMarkdown（复制与导出的唯一真源）', () => {
  assert.match(
    SLICE,
    /function buildConversationMarkdown\(/,
    'tasksSlice 应定义 buildConversationMarkdown 纯函数',
  )
})

test('TC-CPCV-002 导出走 buildConversationMarkdown（不得自建正文）', () => {
  const body = SLICE.slice(SLICE.indexOf('exportConversation:'), SLICE.indexOf('copyConversation:'))
  assert.ok(body.length > 0, '应能切出 exportConversation 段落')
  assert.match(
    body,
    /buildConversationMarkdown\(/,
    'exportConversation 必须调用 buildConversationMarkdown',
  )
})

test('TC-CPCV-003 ★ 复制走**同一个** buildConversationMarkdown（正文不得分叉）', () => {
  const start = SLICE.indexOf('copyConversation: async')
  assert.ok(start > 0, '应定义 copyConversation')
  const body = SLICE.slice(start, start + 900)
  assert.match(
    body,
    /buildConversationMarkdown\(task\.title, task\.agentId, get\(\)\.conversation\)/,
    'copyConversation 必须以与导出完全相同的入参调用 buildConversationMarkdown',
  )
})

/* ============================================================
 * ② 挂点：类型 / store 导出 / 头部菜单 / 命令面板
 * ============================================================ */

test('TC-CPCV-004 AppState 声明 copyConversation（渲染层可调用）', () => {
  assert.match(
    TYPES,
    /copyConversation:\s*\(\)\s*=>\s*Promise<void>/,
    'types.ts 的 AppState 应声明 copyConversation',
  )
})

test('TC-CPCV-005 store 装配整组展开 tasksSlice（slice 内所有 action 均可从 store 取到）', () => {
  assert.match(
    SLICE,
    /\|\s*'copyConversation'/,
    'tasksSlice 的 action 联合类型应含 copyConversation',
  )
  // 装配层是 `...tasksSlice(...)` 整组展开 —— 因此只要 slice 的返回类型含该项，
  // 组件侧 `useStore((s) => s.copyConversation)` 就必然可达（无需在装配层逐项登记）。
  // 反向风险：若哪天改成显式白名单 Pick，漏一项 = 组件静默 undefined，本用例会红。
  assert.match(
    STORE,
    /\.\.\.tasksSlice\(set, get, api\)/,
    'store/index.ts 应整组展开 tasksSlice',
  )
  assert.doesNotMatch(
    STORE,
    /Pick<AppState,/,
    'store 装配层不得改为显式白名单 Pick（会重新引入「漏登记即静默 undefined」的挂点风险）',
  )
})

test('TC-CPCV-006 头部「更多」菜单含复制项，且排在导出之前', () => {
  const copyIdx = HEADER.indexOf("t('centerstage.header.copy')")
  const exportIdx = HEADER.indexOf("t('centerstage.header.export')")
  assert.ok(copyIdx > 0, 'CenterStage 应有「复制对话」菜单项')
  assert.ok(exportIdx > 0, 'CenterStage 应仍保留「导出对话」菜单项')
  assert.ok(
    copyIdx < exportIdx,
    '复制项应排在导出之前（高频操作在前；顺序反了说明是后补挂上去的）',
  )
})

test('TC-CPCV-007 命令面板注册 copyConversation 命令（键盘可达）', () => {
  assert.match(
    PALETTE,
    /copyConversation/,
    'CommandPalette 应引用 copyConversation',
  )
  assert.match(
    PALETTE,
    /palette\.command\.copyConversation/,
    'CommandPalette 应有复制对话的命令文案',
  )
  // 依赖数组漏项 = 命令闭包捕获旧引用（v0.31.0 已踩过同类坑）。
  // 定位：命令列表 useMemo 结束于 `] as PaletteItem[]`，紧随其后就是它的 deps。
  const anchor = PALETTE.indexOf('] as PaletteItem[]')
  assert.ok(anchor > 0, 'CommandPalette 应有命令列表 useMemo（`] as PaletteItem[]`）')
  const deps = PALETTE.slice(anchor, anchor + 1500)
  assert.match(deps, /copyConversation/, 'copyConversation 必须进 useMemo 依赖数组')
})

/* ============================================================
 * ③ 反馈：三态 toast + 四语言齐备（静默失败是本功能最坏的结果）
 * ============================================================ */

test('TC-CPCV-008 三态反馈与四语言文案齐备（空 / 成功 / 失败）', () => {
  // 空：无选中任务或正文为空时不能「复制了个寂寞」还不吭声
  assert.match(
    SLICE,
    /copyConversationEmpty/,
    '空内容应走 warning toast',
  )
  // 成功 / 失败：clipboard 在非安全上下文会抛，必须可感知
  assert.match(SLICE, /copyConversationCopied/, '成功应有 success toast')
  assert.match(SLICE, /copyConversationFailed/, '失败应有 danger toast')
  assert.match(
    SLICE,
    /navigator\.clipboard\.writeText\(md\)/,
    '应真的写入剪贴板（写入的必须是与导出同源的 md）',
  )

  const keys = [
    'centerstage.header.copy',
    'slice.tasks.copyConversationCopied',
    'slice.tasks.copyConversationFailed',
    'slice.tasks.copyConversationEmpty',
    'palette.command.copyConversation',
  ]
  /** i18n 是**嵌套**结构（如 centerstage.header.copy），按路径取值 */
  const pick = (obj: Record<string, unknown>, path: string): unknown =>
    path.split('.').reduce<unknown>((acc, seg) => (acc as Record<string, unknown> | undefined)?.[seg], obj)

  for (const { lang, json } of LOCALES) {
    for (const k of keys) {
      const v = pick(json, k)
      assert.ok(
        typeof v === 'string' && v.trim() !== '',
        `i18n[${lang}] 缺 ${k}（缺 key 会渲染成裸 key）`,
      )
    }
  }
})
