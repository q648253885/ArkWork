/* ============================================================
 * TC-C1（v0.31.0 C1 批次 · 用户裁决两项 UI 修复）— 源码契约
 * 载体说明：三条均为「结构性不变量」，与 reason-dual-channel 同款双轨中的
 * ①源码契约轨（readFileSync + 正则，不 import 渲染层模块、零 DOM 依赖）：
 *   001 编辑器视图收敛：split 全链删除，mode-switch 只剩 edit / render
 *   002 只读可用性：宿主卸载时把当前缓冲回写交接缓存（切只读不再显示旧文本）
 *   003 markdown 分屏：双栏比例同步滚动 + 互斥锁防循环
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs c1-viewmodes
 * ============================================================ */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf-8')

const FS_TYPES = read('../../../../shared/types/fs.ts')
const REGISTRY = read('../registry.ts')
const EDITOR_PANEL = read('../../editor/EditorPanel.tsx')
const EDITOR_HOST = read('../../editor/CodeEditorHost.tsx')
const MARKDOWN_RENDERER = read('../renderers/MarkdownRenderer.tsx')

/** 去掉注释后的源码：避免「注释里提到过」被误判为「实现里有」。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('c1-viewmodes · TC-C1', () => {
  it('TC-C1-001 编辑器视图收敛：EditorViewMode 只剩 edit/render，VIEW_MODES.editor 无 split，EditorPanel 无分屏布局', () => {
    assert.doesNotMatch(
      stripComments(FS_TYPES),
      /'edit'\s*\|\s*'render'\s*\|\s*'split'/,
      'EditorViewMode 不得再含 split',
    )
    const registryCode = stripComments(REGISTRY)
    assert.match(registryCode, /editor:\s*\[/, 'VIEW_MODES.editor 必须存在')
    assert.doesNotMatch(
      registryCode.match(/editor:\s*\[[\s\S]*?\]/)?.[0] ?? '',
      /'split'/,
      '编辑器视图选项不得含 split（分屏归 markdown 等渲染器）',
    )
    const panelCode = stripComments(EDITOR_PANEL)
    assert.doesNotMatch(panelCode, /heightRatio/, 'EditorPanel 不得再消费 heightRatio（分屏布局已删）')
  })

  it('TC-C1-002 只读可用性：CodeEditorHost 卸载清理必须把当前缓冲回写 initialTexts（putInitialText）', () => {
    const hostCode = stripComments(EDITOR_HOST)
    // 卸载清理（unregisterEditorHandle(doc.path…) 调用点之前的同一清理块内）必须先回写缓冲
    const cleanup = hostCode.split('unregisterEditorHandle(doc.path')[0] ?? ''
    assert.match(
      cleanup,
      /putInitialText\(/,
      '宿主卸载时必须 putInitialText 回写当前缓冲，否则切只读渲染显示打开时旧文本',
    )
  })

  it('TC-C1-003 markdown 分屏：双栏同步滚动必须存在，且互斥锁防 A→B→A 循环', () => {
    const mdCode = stripComments(MARKDOWN_RENDERER)
    assert.match(mdCode, /onScroll/, 'split 双栏必须挂 onScroll 同步')
    assert.match(mdCode, /syncingRef/, '必须有互斥锁（syncingRef）阻断程序滚动触发的回环')
    assert.match(mdCode, /requestAnimationFrame/, '互斥锁必须经 rAF 释放（滚动事件异步到达）')
  })
})
