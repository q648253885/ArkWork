/* ============================================================
 * ArkWork — v0.42.0 浮窗「编辑|预览」分段控件契约（TC-VSEG）
 * 载体：源码契约（readFileSync + stripComments）。
 *
 * 背景（用户裁决「编辑器放在单独下拉选择不合适」）：
 *   旧实现把「编辑器」混在标题栏渲染器下拉的 8 项里；v0.42.0 下拉退役，
 *   换成 Tab 栏右侧「编辑 | 预览」分段控件（对标 WorkBuddy / TraeWork）。
 *   rendererOverrides 机制保留（数据流零变化），仅入口收窄为两值。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs preview-view-segmented
 * ============================================================ */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripComments } from '@shared/utils/source-guard'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf-8')

const PREVIEW = stripComments(read('../PreviewWindow.tsx'))

describe('preview-view-segmented · TC-VSEG', () => {
  it('TC-VSEG-001 否定腿：标题栏渲染器下拉整组退役（selectorOpen 零残留）', () => {
    assert.doesNotMatch(PREVIEW, /selectorOpen/, '渲染器下拉的开合状态不得残留')
    assert.doesNotMatch(PREVIEW, /渲染器选择器/, '「渲染器选择器」UI 块不得回归')
    // 下拉的唯一特征交互（点开 → 全屏遮罩 → 枚举 RENDERER_REGISTRY 渲染菜单）不得回来
    assert.doesNotMatch(
      PREVIEW,
      /Object\.keys\(RENDERER_REGISTRY\)\.map/,
      '不得再枚举全渲染器注册表做菜单（跨类型互切已收敛为「编辑|预览」两值）',
    )
  })

  it('TC-VSEG-002 肯定腿：分段控件存在且两段分别接线 setRenderer 两值入口', () => {
    assert.match(PREVIEW, /data-testid="preview-view-segmented"/, '分段控件必须有稳定 testid')
    assert.match(PREVIEW, /data-seg="edit"/, '编辑段')
    assert.match(PREVIEW, /data-seg="preview"/, '预览段')
    // 编辑段 → 'editor'（CM6 可改）；预览段 → detectRenderer(path)（自然只读渲染）
    assert.match(PREVIEW, /setRenderer\('editor'\)/, '编辑段必须切到 editor 渲染器')
    assert.match(PREVIEW, /setRenderer\(detectRenderer\(activeFilePath\)\)/, '预览段必须切到该文件的自然渲染器')
    // 已打开文档的预览走 doc viewMode（renderEditorPreview 实时缓冲，未保存内容不丢）
    assert.match(PREVIEW, /setViewMode\('render'\)/, 'editor Tab 的预览段必须走 doc viewMode render（实时缓冲只读渲染）')
  })

  it('TC-VSEG-003 卫语句：分段控件只对「file Tab 且路径非空」出现（URL/面板/空 Tab 无编辑语义）', () => {
    assert.match(
      PREVIEW,
      /activeTab\.target\.kind === 'file' && !!activeTab\.target\.path/,
      '显示条件必须是 file Tab 且路径非空',
    )
  })

  it('TC-VSEG-004 Tab 栏常驻：单 Tab 也要给分段控件一个家（showTabBar 退役）', () => {
    assert.doesNotMatch(PREVIEW, /showTabBar/, 'Tab 栏常驻后 showTabBar 条件不得残留')
  })

  it('TC-VSEG-005 不回退：同路径单 Tab 去重 / CloseGuard / 保存链路的调用点仍在', () => {
    // v0.31.0 B2 的三条核心不变量，本版只动入口不动数据流
    const previewTabSvc = read('../../../services/previewTabs.ts')
    assert.match(previewTabSvc, /findFileTab/, '同路径单 Tab 去重纯函数仍在（唯一事实源）')
    assert.match(PREVIEW, /CloseGuardPrompt/, 'CloseGuard 三选一仍在')
    assert.match(PREVIEW, /saveDoc/, '保存链路仍在')
  })
})
