/* ============================================================
 * ArkWork — Editor: EditorPanel（编辑器 Tab 的组装层，懒加载入口）
 * 设计文档 docs/versions/v0.31.0/04-system-design.md §3.5 / §5.4.3 · 原型 06/07
 *
 * 组装顺序（自上而下）：
 *   冲突横幅（唯一的通栏打断） → 编辑区（edit）或只读渲染（render） → 状态条
 * 只读文档不走编辑区，直接给只读卡片（七原因 + 出口）。
 *
 * 本组件只从 `fsSlice` 读状态、只调 `fsSlice` 的 action（§3.3 硬规则 3：
 * 文件状态的唯一写者）。它自己不持有任何文件状态副本。
 *
 * ⚠️ B2 裁剪：deleted 态的「另存恢复」需要 `fs:save-as` 频道（走原生保存对话框），
 * 该频道不在 B2 频道表内（§5.1），故 B2 不提供该按钮，登记为 B5/B6 遗留。
 * ============================================================ */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '../../store'
import { ark } from '../../ipc/client'
import { Icon } from '../../icons'
import { CodeEditorHost } from './CodeEditorHost'
import { ConflictBanner } from './ConflictBanner'
import { ReadonlyCard } from './ReadonlyCard'
import { encodingLabel } from '../../services/editorDoc'
import { getEditorHandle } from '../../services/savePipeline'
import { peekInitialText } from '../../services/editorSession'

export interface EditorPanelProps {
  path: string
  /** 只读渲染内容（由 PreviewWindow 提供：分屏/只读视图用，避免编辑器反向依赖各渲染器） */
  renderPreview?: React.ReactNode
}

export default function EditorPanel({ path, renderPreview }: EditorPanelProps) {
  const { t } = useTranslation()
  const doc = useStore((s) => s.docs[path])
  const conflict = useStore((s) => s.conflicts[path])
  const markDirty = useStore((s) => s.markDirty)
  const saveDoc = useStore((s) => s.saveDoc)
  const reprobeDoc = useStore((s) => s.reprobeDoc)
  const revertDocToDisk = useStore((s) => s.revertDocToDisk)
  const closeDocForce = useStore((s) => s.closeDocForce)

  const [sel, setSel] = useState({ line: 1, col: 1 })
  // 「稍后处理」只收起横幅视觉，不清除冲突（徽标继续留着，原型 07）
  const [dismissed, setDismissed] = useState<string | null>(null)
  const dismissedRef = useRef(dismissed)
  dismissedRef.current = dismissed
  useEffect(() => {
    // 冲突换了一版（或消失）→ 重新弹出横幅
    if (conflict && dismissedRef.current && dismissedRef.current !== conflict.diskHash) {
      setDismissed(null)
    }
  }, [conflict])

  // 冲突对比右侧文本：优先实时缓冲区，宿主未挂载时退回初始文本
  const mineText = useMemo(
    () => (conflict ? (getEditorHandle(path)?.getText() ?? peekInitialText(path) ?? '') : ''),
    [conflict, path],
  )

  if (!doc) {
    return (
      <div className="h-full flex items-center justify-center text-text-tertiary">
        <Icon.File width={20} height={20} />
      </div>
    )
  }

  // ⚠️ 不变量：**可编辑文档一定有初始文本**，否则 `?? ''` 会让用户面对一个空编辑器，
  // 一按保存就把文件抹成空 —— 这是本版本最危险的一类静默数据丢失。
  // 成立性论证（不是巧合，改动时须重新论证）：
  //   `editable === true` ⇔ `probe.readonlyReason === null`（services/editorDoc.createEditorDoc）
  //   而 `content === null` 只在 binary / too-large / deleted 三种探针下发生，
  //   这三者都会给出非 null 的 readonlyReason ⇒ 推导出 `editable === false`，与本分支矛盾。
  // 因此进入下面的编辑器分支时 `peekInitialText` 必非 null。
  // 若将来新增「能让 editable 为 true 但 content 为 null」的路径，必须在此处改为
  // 「不渲染编辑器 + 只读卡片」，绝不能落到 `?? ''`。
  const initialText = peekInitialText(path) ?? ''
  const viewMode = doc.viewMode
  // v0.31.0 C1：split 已删 —— 编辑器只有 编辑 / 只读渲染 两态；
  // 分屏是 markdown 等渲染器的能力（MarkdownRenderer 自带双栏同步滚动）
  const showEditor = doc.editable && viewMode === 'edit'
  const showPreview = doc.editable && viewMode === 'render'
  const showBanner = !!conflict && dismissed !== conflict.diskHash

  return (
    <div className="h-full flex flex-col min-h-0" data-editor-panel={path}>
      {showBanner && conflict && (
        <ConflictBanner
          info={conflict}
          mineText={mineText}
          onOverwrite={() => void saveDoc(path, { force: true })}
          onReload={() => void revertDocToDisk(path)}
          onDismiss={() => setDismissed(conflict.diskHash)}
        />
      )}

      {!doc.editable ? (
        <div className="flex-1 min-h-0">
          <ReadonlyCard
            doc={doc}
            onReveal={() => void ark.fs.revealInFolder(path)}
            onRetry={() => void reprobeDoc(path)}
            onClose={() => closeDocForce(path)}
          />
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col">
          {showEditor && (
            <div className="flex-1 min-h-0" onMouseDown={() => useStore.getState().touchDoc(path)}>
              <CodeEditorHost
                doc={doc}
                initialText={initialText}
                onDirtyChange={(dirty) => markDirty(path, dirty)}
                onSelectionChange={(s) => setSel({ line: s.line, col: s.col })}
                onRequestSave={() => void saveDoc(path)}
              />
            </div>
          )}
          {showPreview && (
            <div className="flex-1 min-h-0 overflow-hidden">
              {renderPreview ?? (
                <div className="h-full flex items-center justify-center text-2xs text-text-tertiary">
                  {t('editor.mode.render')}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <EditorStatusBar
        path={path}
        line={sel.line}
        col={sel.col}
        language={doc.language}
        encoding={encodingLabel(doc)}
        dirty={doc.dirty}
        saving={doc.saveState === 'saving'}
        conflict={!!conflict}
        editable={doc.editable}
      />
    </div>
  )
}

/* ------------------------------------------------------------
 * 状态条（原型 07：行 9, 列 62 · TypeScript · UTF-8 · CRLF · 未保存）
 * ---------------------------------------------------------- */

function EditorStatusBar(props: {
  path: string
  line: number
  col: number
  language: string
  encoding: string
  dirty: boolean
  saving: boolean
  conflict: boolean
  editable: boolean
}) {
  const { path, line, col, language, encoding, dirty, saving, conflict, editable } = props
  const { t } = useTranslation()
  const state = saving
    ? { label: t('editor.status.saving'), cls: 'text-text-tertiary' }
    : conflict
      ? { label: t('editor.status.conflict'), cls: 'text-danger' }
      : dirty
        ? { label: t('editor.status.dirty'), cls: 'text-warning' }
        : { label: t('editor.status.saved'), cls: 'text-success' }

  return (
    <div className="flex items-center gap-2 h-6 px-3 flex-shrink-0 bg-bg-surface border-t border-border-subtle">
      <span className="text-2xs text-text-tertiary font-mono tabular flex-shrink-0">
        {t('editor.status.lineCol', { line, col })}
      </span>
      <span className="text-2xs text-text-tertiary flex-shrink-0">{language}</span>
      <span className="text-2xs text-text-tertiary font-mono flex-shrink-0">{encoding}</span>
      {!editable && (
        <span className="text-2xs text-warning flex-shrink-0">{t('editor.status.readonly')}</span>
      )}
      <span className="flex-1 min-w-0" />
      <span className="text-2xs text-text-disabled font-mono truncate max-w-[45%]" title={path}>
        {path}
      </span>
      <span className={`text-2xs flex-shrink-0 ${state.cls}`}>{state.label}</span>
    </div>
  )
}
