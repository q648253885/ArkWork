/* ============================================================
 * v0.31.1 — 编辑器/输入区原生右键菜单契约单测（TC-CTX-001..003）
 *
 * 缺陷背景（用户实测，Windows）：文件编辑器里右键没有任何菜单，
 * 无法复制/粘贴。Electron 默认不提供右键菜单 —— 修复在
 * window.ts 给主窗口注册 webContents 'context-menu' 原生菜单：
 * 可编辑区（CM6 contenteditable / 输入框）给 剪切/复制/粘贴/全选；
 * 只读区有选中文本时给「复制」；纯浏览区不弹（不抢占文件树等
 * 页面自定义菜单）。
 *
 * 载体约束：window.ts 属 electron 链模块，Node 下无法实例化 ——
 * 源码契约体例（同 TC-TH）。
 *
 * 运行（cwd=app）：
 *   node scripts/run-tests.mjs main/__tests__
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf-8')
const code = (rel: string): string => read(rel).replace(/\/\/.*$/gm, '')

/* ============================================================
 * TC-CTX-001 · 主窗口必须注册 context-menu 原生菜单
 * ============================================================ */
test('TC-CTX-001 window.ts 注册 webContents context-menu 并弹原生菜单', () => {
  const src = code('../window.ts')
  assert.match(
    src,
    /webContents\.on\('context-menu'[\s\S]*?Menu\.buildFromTemplate\(template\)\.popup\(/,
    '主窗口必须注册 context-menu 且经 Menu.popup 弹出原生菜单',
  )
})

/* ============================================================
 * TC-CTX-002 · 四个角色齐全，且显隐受 isEditable / 选区把守
 * ============================================================ */
test('TC-CTX-002 菜单含 cut/copy/paste/selectAll，纯浏览区（不可编辑且无选区）不弹', () => {
  const src = code('../window.ts')
  for (const role of ['cut', 'copy', 'paste', 'selectAll']) {
    assert.match(src, new RegExp(`role:\\s*'${role}'`), `缺少 role: '${role}'`)
  }
  assert.match(
    src,
    /const editable = params\.isEditable[\s\S]*?const hasSelection = params\.selectionText\.trim\(\)\.length > 0[\s\S]*?if \(!editable && !hasSelection\) return/,
    '必须按 isEditable/选区动态显隐，纯浏览区直接 return（不抢占页面右键）',
  )
})

/* ============================================================
 * TC-CTX-003 · 菜单文案走 i18n（contextmenu.* 四语言键集一致）
 * ============================================================ */
test('TC-CTX-003 contextmenu.* 四语言键集一致（C-G4 口径）', () => {
  const src = read('../i18n/messages.ts')
  for (const key of ['contextmenu.cut', 'contextmenu.copy', 'contextmenu.paste', 'contextmenu.selectAll']) {
    const count = src.split(`'${key}':`).length - 1
    assert.equal(count, 4, `${key} 必须在 zh/en/ja/ko 四语言各出现 1 次（实际 ${count}）`)
  }
  assert.match(code('../window.ts'), /tFor\(locale, 'contextmenu\./, '菜单 label 必须经 tFor 取 i18n 文案')
})
