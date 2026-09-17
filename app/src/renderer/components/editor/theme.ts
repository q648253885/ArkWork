/* ============================================================
 * ArkWork — Editor: CM6 主题与语法高亮（B2）
 * 设计文档 docs/versions/v0.31.0/04-system-design.md §3.1 / §3.3 硬规则 1
 *
 * 硬约束：**语法色一律引用 `var(--syn-*)`**，不写任何字面色值。
 * 由此「切换主题」不需要重建 EditorView，也不需要 JS 参与——
 * 只切 `<html class="dark">`，CM6 的 CSS 变量即随之改变（零 JS 换肤）。
 * 唯一例外是 caret / selection 等必须走 CSS 类而非 token 的样式，
 * 它们也统一放在本文件，避免颜色散落到组件里。
 * ============================================================ */
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import type { Extension } from '@codemirror/state'

/** 语法高亮：6 档 --syn-* 映射到 Lezer tag 集合 */
export const arkHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: 'var(--syn-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null, t.atom, t.constant(t.name)], color: 'var(--syn-number)' },
  { tag: [t.lineComment, t.blockComment, t.docComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: 'var(--syn-function)' },
  { tag: [t.typeName, t.className, t.namespace, t.tagName, t.attributeName], color: 'var(--syn-type)' },
  { tag: [t.definition(t.variableName), t.variableName, t.propertyName], color: 'var(--text-primary)' },
  { tag: [t.punctuation, t.bracket, t.separator], color: 'var(--text-secondary)' },
  { tag: t.invalid, color: 'var(--danger)' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.link, color: 'var(--business-primary)', textDecoration: 'underline' },
  { tag: t.heading, color: 'var(--text-primary)', fontWeight: '600' },
  { tag: t.monospace, fontFamily: 'var(--editor-font-family)' },
])

/**
 * 编辑器外观。**所有取值走 token**：字号 / 字族 / 颜色 / 圆角全部是变量，
 * 深色与浅色共用同一份主题定义（这正是「零 JS 换肤」的实现方式）。
 */
export const arkEditorTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: 'var(--editor-font-size)',
    fontFamily: 'var(--editor-font-family)',
    backgroundColor: 'var(--bg-base)',
    color: 'var(--text-primary)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--editor-font-family)',
    lineHeight: '1.6',
    overflow: 'auto',
  },
  '.cm-content': {
    caretColor: 'var(--accent)',
    padding: 'var(--space-2) 0',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--accent-strong)',
  },
  '.cm-activeLine': { backgroundColor: 'var(--bg-overlay-l1)' },
  '.cm-activeLineGutter': {
    backgroundColor: 'var(--bg-overlay-l1)',
    color: 'var(--text-secondary)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--bg-surface)',
    color: 'var(--text-disabled)',
    border: 'none',
    borderRight: '1px solid var(--border-subtle)',
    fontFamily: 'var(--editor-font-family)',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 var(--space-2) 0 var(--space-3)' },
  '.cm-foldGutter .cm-gutterElement': { color: 'var(--text-disabled)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--accent-soft)',
    outline: '1px solid var(--accent)',
  },
  '.cm-nonmatchingBracket': { color: 'var(--danger)' },
  '.cm-searchMatch': { backgroundColor: 'var(--warning-soft)', outline: '1px solid var(--warning)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--accent-soft)' },
  '.cm-panels': {
    backgroundColor: 'var(--bg-overlay)',
    color: 'var(--text-primary)',
    borderTop: '1px solid var(--border-subtle)',
  },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border-default)' },
  '.cm-textfield': {
    backgroundColor: 'var(--bg-input)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 'var(--editor-font-size)',
  },
  '.cm-button': {
    backgroundColor: 'var(--bg-surface-2)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-sm)',
    backgroundImage: 'none',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--bg-overlay)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-md)',
    color: 'var(--text-primary)',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--accent-soft)',
    color: 'var(--text-primary)',
  },
  '.cm-placeholder': { color: 'var(--text-disabled)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--bg-overlay-l3)' },
})

export const arkEditorExtensions: Extension[] = [arkEditorTheme, syntaxHighlighting(arkHighlightStyle)]
