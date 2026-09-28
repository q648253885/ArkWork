/* ============================================================
 * v0.36.3 · D115 — 交互区路径边界（渲染层接线契约，TC-PATH-007..009）
 *
 * 用户现象原文：「交互区点击文件，如果是相对路径，显示无法打开，路径越界，
 *   仅允许操作工作区内的文件：src/main/java/com/travelsky/codeagent/agent」
 *
 * 主进程侧的根因与修法由 guard-userpath.test.ts（TC-PATH-001..006）把守；
 * 本组把守**渲染层不得再引入第二套越界判定**，也就是「点了文件一定能看到东西」
 * 这条既有兼容性承诺不得被回退。
 *
 * 载体纪律：组件依赖 zustand + i18n，node:test 无法挂载 → 源码契约体例
 * （读源码 + stripComments 后断言，见 D101 纪律⑫）。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs filelink-path
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { stripComments } from '@shared/utils/source-guard'

const CODE = (rel: string): string =>
  stripComments(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8'))

const FILE_LINK = '../../../components/flow/FileLink.tsx'
const USE_OPEN_PATH = '../../../components/flow/useOpenPath.ts'
const FS_SLICE = '../../../store/slices/fsSlice.ts'
const EDITOR_DOC = '../../../services/editorDoc.ts'

test('TC-PATH-007 FileLink 点击走唯一门面 openDoc（不得自行判定越界 / 不得直连 IPC）', () => {
  const link = CODE(FILE_LINK)
  const facade = CODE(USE_OPEN_PATH)

  assert.match(link, /useOpenPath\(\)/, 'FileLink 必须经 useOpenPath')
  assert.match(facade, /useStore\(\(s\)\s*=>\s*s\.openDoc\)/, 'useOpenPath 必须取 fsSlice.openDoc（唯一门面）')
  // 渲染层不许有第二套边界判定（越界真源只在主进程 fs/guard.ts）
  for (const [name, src] of [
    ['FileLink', link],
    ['useOpenPath', facade],
  ] as const) {
    assert.ok(!/isInsideWorkspace/.test(src), `${name} 不得自带工作区边界判定`)
    assert.ok(!/ark\.fs\.readText/.test(src), `${name} 不得直连 fs:read-text（绕过 openDoc 会让只读/可编辑通路分叉）`)
  }
})

test('TC-PATH-008 ★ openDoc 不预判越界：探针失败仍退回只读预览（「点了就能看到东西」）', () => {
  const src = CODE(FS_SLICE)
  // 唯一保留的路径级拦截是 .arkwork 保留区（它是在工作区之内、但有专属只读通路）
  assert.match(src, /isArkworkInternal\(path\)/, '.arkwork 保留区拦截仍需保留')
  assert.ok(!/isInsideWorkspace/.test(src), '渲染层不得预判越界 —— 越界只约束 LLM 工具面')

  // catch 兜底：异常也必须开 Tab，不得只弹 toast
  const at = src.indexOf('catch (err)')
  assert.ok(at !== -1, 'openDoc 必须保留 catch 兜底分支')
  const tail = src.slice(at, at + 700)
  assert.match(tail, /pushToast\(/, '探针失败必须有用户可见反馈')
  assert.match(tail, /openPreview\(/, '探针失败必须回落 openPreview（否则点相对路径会「打不开」）')
})

test('TC-PATH-009 工作区外文件的可读表达齐备（只读原因 → 文案 → 出口）', () => {
  const doc = CODE(EDITOR_DOC)
  assert.match(
    doc,
    /'outside-workspace':\s*'editor\.readonly\.reason\.outsideWorkspace'/,
    'outside-workspace 必须有文案映射（复用既有键，不新增）',
  )
  // 四种语言都得有这条文案，否则切语言会露英文键名
  const localeDir = '../../../i18n/locales/'
  for (const f of ['zh', 'en', 'ja', 'ko']) {
    const json = JSON.parse(readFileSync(fileURLToPath(new URL(`${localeDir}${f}.json`, import.meta.url)), 'utf-8'))
    const reason = json?.editor?.readonly?.reason
    assert.ok(reason && reason.outsideWorkspace, `${f}.json 缺 editor.readonly.reason.outsideWorkspace`)
  }
})