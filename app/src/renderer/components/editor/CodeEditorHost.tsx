/* ============================================================
 * ArkWork — Editor: CodeEditorHost（CM6 唯一实例化点）
 * 设计文档 docs/versions/v0.31.0/04-system-design.md §3.3 硬规则 1 / §5.4.3
 *
 * 硬规则：**外壳/组件不得 import `@codemirror/*`** —— 唯一合法入口就是本目录。
 * 违反即整个 renderer 主 chunk 被污染（§1.2 分包验收失败）。
 *
 * 本组件只做三件事：持有 EditorState、把改动/光标上报、把外部指令落到 state。
 * **它不读盘、不写盘**：保存一律经 `fsSlice.saveDoc` → `savePipeline` → `fs:write-text`。
 * ============================================================ */
import { useEffect, useRef } from 'react'
import { EditorState, Compartment } from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view'
import { defaultKeymap, history, historyField, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, foldGutter, indentOnInput } from '@codemirror/language'
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete'
import { search, searchKeymap, openSearchPanel } from '@codemirror/search'
import { arkEditorExtensions } from './theme'
import { loadLanguage } from './languages'
import { registerEditorHandle, unregisterEditorHandle } from '../../services/savePipeline'
import { peekEditorState, putEditorState, putInitialText } from '../../services/editorSession'
import type { EditorHandle } from '../../services/editorDoc'
import type { EditorDocMeta } from '@shared/types/fs'

/** 撤销栈随 EditorState 序列化（切 Tab 回来仍可撤销） */
const HISTORY_FIELDS = { history: historyField }

export interface CodeEditorHostProps {
  doc: EditorDocMeta
  /** 初始文本（来自 fs:read-text）；此后文本真源是 EditorState */
  initialText: string
  /** 外部写入缓冲（选中动作的「替换选区」走此路径，不直接改 state） */
  applyExternal?: { seq: number; text: string } | null
  onDirtyChange: (dirty: boolean) => void
  onSelectionChange: (sel: { line: number; col: number; selectedText: string | null }) => void
  onCursorChange?: (pos: { line: number; col: number }) => void
  onRequestSave: () => void
  onRequestFind?: () => void
}

export function CodeEditorHost(props: CodeEditorHostProps) {
  const {
    doc,
    initialText,
    applyExternal,
    onDirtyChange,
    onSelectionChange,
    onCursorChange,
    onRequestSave,
    onRequestFind,
  } = props

  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const handleRef = useRef<EditorHandle | null>(null)
  const languageCompartment = useRef(new Compartment())
  const readOnlyCompartment = useRef(new Compartment())
  // 回调放 ref：避免父组件每次 render 重建 extensions（会重建整个 EditorState）
  const cbRef = useRef({ onDirtyChange, onSelectionChange, onCursorChange, onRequestSave, onRequestFind })
  cbRef.current = { onDirtyChange, onSelectionChange, onCursorChange, onRequestSave, onRequestFind }

  /* ---- 建/销毁编辑器（只在 path 变化时重建） ---- */
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const reportSelection = (view: EditorView): void => {
      const sel = view.state.selection.main
      const line = view.state.doc.lineAt(sel.head)
      const selectedText = sel.empty ? null : view.state.sliceDoc(sel.from, sel.to)
      const pos = { line: line.number, col: sel.head - line.from + 1 }
      cbRef.current.onSelectionChange({ ...pos, selectedText })
      cbRef.current.onCursorChange?.(pos)
    }

    const extensions = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter(),
      drawSelection(),
      dropCursor(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      autocompletion(),
      rectangularSelection(),
      highlightActiveLine(),
      search({ top: true }),
      EditorView.lineWrapping,
      ...arkEditorExtensions,
      readOnlyCompartment.current.of([
        EditorState.readOnly.of(!doc.editable),
        EditorView.editable.of(doc.editable),
      ]),
      languageCompartment.current.of([]),
      keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            cbRef.current.onRequestSave()
            return true
          },
        },
        {
          key: 'Mod-f',
          preventDefault: true,
          run: (view) => {
            const custom = cbRef.current.onRequestFind
            if (custom) {
              custom()
              return true
            }
            return openSearchPanel(view)
          },
        },
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...completionKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) cbRef.current.onDirtyChange(true)
        if (update.docChanged || update.selectionSet) reportSelection(update.view)
      }),
    ]

    // 恢复上次卸载时的状态（切 Tab 回来后撤销栈仍在），否则用初始文本
    const restored = peekEditorState(doc.path)
    let state: EditorState
    try {
      state = restored
        ? EditorState.fromJSON(restored as never, { extensions }, HISTORY_FIELDS)
        : EditorState.create({ doc: initialText, extensions })
    } catch {
      state = EditorState.create({ doc: initialText, extensions })
    }

    const view = new EditorView({ state, parent: host })
    viewRef.current = view

    const handle: EditorHandle = {
      getText: () => view.state.doc.toString(),
      setText: (text, _opts) => {
        // 整文替换（还原磁盘 / 选中动作回灌）；是否清 dirty 由调用方决定
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
        })
      },
      getCursor: () => {
        const sel = view.state.selection.main
        const line = view.state.doc.lineAt(sel.head)
        return { line: line.number, col: sel.head - line.from + 1 }
      },
      setCursor: (pos) => {
        const total = view.state.doc.lines
        const lineNo = Math.min(Math.max(1, pos.line), total)
        const line = view.state.doc.line(lineNo)
        const at = Math.min(line.from + Math.max(0, pos.col - 1), line.to)
        view.dispatch({ selection: { anchor: at } })
        view.dispatch({ effects: EditorView.scrollIntoView(at, { y: 'center' }) })
      },
      restoreCursorRatio: (ratio) => {
        const total = view.state.doc.lines
        const lineNo = Math.min(Math.max(1, Math.round(ratio * total)), total)
        const line = view.state.doc.line(lineNo)
        view.dispatch({ selection: { anchor: line.from } })
      },
      getScrollLineRatio: () => {
        const scroller = view.scrollDOM
        if (!scroller.scrollHeight || scroller.scrollHeight <= scroller.clientHeight) return 0
        return scroller.scrollTop / (scroller.scrollHeight - scroller.clientHeight)
      },
      focus: () => view.focus(),
      toJSON: () => view.state.toJSON(HISTORY_FIELDS),
      fromJSON: (s) => {
        try {
          view.setState(EditorState.fromJSON(s as never, { extensions }, HISTORY_FIELDS))
        } catch {
          /* 反序列化失败：保留当前 state，不阻断编辑 */
        }
      },
      destroy: () => view.destroy(),
    }
    handleRef.current = handle
    registerEditorHandle(doc.path, handle)
    reportSelection(view)

    return () => {
      // v0.31.0 C1：把当前缓冲回写交接缓存 —— 宿主卸载（切只读渲染 / 切 Tab）后，
      // 只读预览与冲突对比从 peekInitialText 取的是**最新缓冲**而非打开时的旧文本
      //（修复「编辑后切只读显示陈旧内容」）。撤销栈仍走 editorStates 快照。
      putInitialText(doc.path, view.state.doc.toString())
      putEditorState(doc.path, view.state.toJSON(HISTORY_FIELDS))
      unregisterEditorHandle(doc.path, handle)
      handleRef.current = null
      viewRef.current = null
      view.destroy()
    }
    // 只依赖 path 与只读态：语言/文本变化走各自的 effect，避免重建编辑器丢撤销栈
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.path, doc.editable])

  /* ---- 语言包懒加载（独立 chunk） ---- */
  useEffect(() => {
    let cancelled = false
    const view = viewRef.current
    if (!view) return
    void loadLanguage(doc.language).then((support) => {
      if (cancelled || !viewRef.current) return
      viewRef.current.dispatch({
        effects: languageCompartment.current.reconfigure(support ?? []),
      })
    })
    return () => {
      cancelled = true
    }
  }, [doc.language, doc.path])

  /* ---- 外部写入缓冲（选中动作「替换选区」） ---- */
  const lastAppliedSeq = useRef<number>(-1)
  useEffect(() => {
    const view = viewRef.current
    if (!view || !applyExternal || applyExternal.seq === lastAppliedSeq.current) return
    lastAppliedSeq.current = applyExternal.seq
    const sel = view.state.selection.main
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: applyExternal.text },
      selection: { anchor: sel.from + applyExternal.text.length },
    })
    view.focus()
  }, [applyExternal])

  /* ---- 只读态变化（原位 reconfigure，不重建实例） ---- */
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: readOnlyCompartment.current.reconfigure([
        EditorState.readOnly.of(!doc.editable),
        EditorView.editable.of(doc.editable),
      ]),
    })
  }, [doc.editable])

  return <div ref={hostRef} className="h-full w-full overflow-hidden" data-editor-host={doc.path} />
}

/** 外部（选中动作 / 查找）触发搜索面板 */
export function requestFindPanel(view: EditorView): boolean {
  return openSearchPanel(view)
}
