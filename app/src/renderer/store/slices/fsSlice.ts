/* ============================================================
 * ArkWork — 文件能力 slice（v0.31.0 B2 / B5）
 * 设计文档 docs/versions/v0.31.0/04-system-design.md §5.4.4
 *
 * 本 slice 是**文件状态的唯一写者**（§3.3 硬规则 3）：
 * 文档元数据 / 冲突 / 最近关闭 全部在这里，组件不得自持副本
 * （否则 C-12「同一文件三面徽标必须一致」必失败）。
 *
 * ⚠️ B2 范围的**有意裁剪**（登记于 testcases §4.1 + 04-system-design 变更记录）：
 *  - `tree` **不在本 slice 声明**：已有的 `conversationSlice.files` 就是文件树，
 *    再声明一个 `tree` 会立刻造成「两棵树两份徽标」——正是 C-12 / L11 要防的形态。
 *    B5 改造 `FilesPanel`（§3.2 的改造主体）时把 `files` 整体迁到本 slice 的 `tree`。
 *  - `watchState` / `watchError` / `recentBatches` / `agentWrites` / `root` 同属 chokidar 域，
 *    随 B5 的 `fs:watch-*` 频道一起落地；B2 先不声明，避免「声明了但没人写」的死状态。
 * 派生纪律：`dirtyPaths` 不单独存（见 services/editorDoc.deriveDirtyPaths）。
 * ============================================================ */
import type { StateCreator } from 'zustand'
import { ark } from '../../ipc/client'
import i18n from '../../i18n'
import { friendlyError, detectRenderer } from '../meta'
import {
  applyConflict,
  applyFailed,
  applyRevertedToDisk,
  applySaved,
  beginSave,
  createEditorDoc,
  markDirty as markDirtyPure,
  READONLY_REASON_KEY,
  selectLruEvictions,
  setViewMode,
  touchDoc as touchDocPure,
} from '../../services/editorDoc'
import { getEditorHandle, runSave } from '../../services/savePipeline'
import { baseNameOf } from '@shared/utils/path-display'
import { clearEditorSession, putInitialText } from '../../services/editorSession'
import type { AppState } from '../types'
import { isArkworkInternal } from '@shared/utils/paths'
import type { SaveOutcome } from '../../services/editorDoc'
import type { ConflictInfo, EditorDocMeta } from '@shared/types/fs'

/** 最近关闭列表长度上限（浮窗空态展示用） */
const RECENTLY_CLOSED_LIMIT = 20

const saveIo = {
  writeText: (req: Parameters<typeof ark.fs.writeText>[0]) => ark.fs.writeText(req),
  now: () => Date.now(),
}

/** 只读原因 → i18n 键的映射已随文档语义下沉到 services/editorDoc（READONLY_REASON_KEY） */

function baseName(p: string): string {
  return baseNameOf(p)
}

function readonlyToastMessage(doc: EditorDocMeta): string {
  const reasonKey = doc.readonlyReason ? READONLY_REASON_KEY[doc.readonlyReason] : ''
  const reason = reasonKey ? i18n.t(reasonKey) : ''
  return i18n.t('editor.readonly.toast', {
    name: baseName(doc.path),
    reason: doc.readonlyDetail ? `${reason}（${doc.readonlyDetail}）` : reason,
  })
}

export const fsSlice: StateCreator<
  AppState,
  [],
  [],
  Pick<
    AppState,
    | 'root'
    | 'docs'
    | 'conflicts'
    | 'recentlyClosed'
    | 'activeDocPath'
    | 'refreshTree'
    | 'openDoc'
    | 'closeDoc'
    | 'closeDocForce'
    | 'markDirty'
    | 'touchDoc'
    | 'setConflict'
    | 'setDocViewMode'
    | 'saveDoc'
    | 'revertDocToDisk'
    | 'reprobeDoc'
  >
> = (set, get) => {
  /** 把 SaveOutcome 写回 store（三态语义严格对齐 §6.3 时序） */
  const applyOutcome = (path: string, outcome: SaveOutcome): void => {
    if (outcome.kind === 'skipped') return

    if (outcome.kind === 'saved') {
      set((s) => {
        const doc = s.docs[path]
        if (!doc) return {}
        const conflicts = { ...s.conflicts }
        delete conflicts[path]
        return { docs: { ...s.docs, [path]: applySaved(doc, outcome.revision) }, conflicts }
      })
      return
    }

    if (outcome.kind === 'conflict') {
      const info: ConflictInfo = outcome.info
      set((s) => {
        const doc = s.docs[path]
        if (!doc) return {}
        return {
          docs: { ...s.docs, [path]: applyConflict(doc, info) },
          conflicts: { ...s.conflicts, [path]: info },
        }
      })
      get().pushToast({ type: 'warning', message: i18n.t('editor.conflict.toast'), duration: 6000 })
      return
    }

    // failed：dirty 必须保持 true（绝不静默清除 dirty / §5.2 E_WRITE_FAILED）
    set((s) => {
      const doc = s.docs[path]
      if (!doc) return {}
      return { docs: { ...s.docs, [path]: applyFailed(doc) } }
    })
    get().pushToast({ type: 'danger', message: outcome.message, duration: 0 })
  }

  return {
    /* ---- 状态 ---- */
    root: null,
    docs: {},
    conflicts: {},
    recentlyClosed: [],
    activeDocPath: null,

    /* ---- 树 ---- */
    /**
     * B2 阶段委托给既有 `refreshFiles`（`conversationSlice.files` 是当前的文件树真源）；
     * B5 接管为 `fsSlice.tree` 后本方法改为直接刷新本 slice。
     */
    refreshTree: async () => {
      await get().refreshFiles()
    },

    /* ---- 打开 / 关闭 ---- */
    openDoc: async (path, mode = 'preview') => {
      // `.arkwork` 是 agent 自身内容区（§7.2 写盘一律 E_ARKWORK_RESERVED，且在 WATCH_IGNORE 内），
      // **不是可编辑工作集**。但它在工作区之内，七种只读原因里没有对应项 —— 于是它会探成
      // 「可编辑」。若不在此拦，用户能在编辑器里改一个**永远存不下去**的文件，
      // 一路写到 Mod+S 才收到 E_ARKWORK_RESERVED：属「静默陷阱」（§7.3 禁止形态）。
      // 处置：退回只读渲染 Tab，不建 doc、不进编辑器。
      if (path && isArkworkInternal(path)) {
        await get().openPreview(path, { pinned: mode === 'pinned' })
        return
      }

      const s = get()
      const existing = s.docs[path]

      /**
       * D20 裁决：可编辑 ≠ 默认开编辑器。B2 曾把**所有**可编辑文件都强制
       * `rendererOverride: 'editor'`，结果 md/svg 这类有独立渲染态的文件
       * 被拉进源码视图，「markdown / 图片无法展示」且渲染态不可达。
       * 正确口径：只有**无独立渲染态**的文本类（code / fallback）默认进编辑器；
       * markdown / svg / table / image 等保持 detectRenderer 的原渲染器，
       * 用户仍可从渲染器下拉（setRenderer）切到 editor 编辑源码。
       */
      const defaultToEditor = (() => {
        const kind = detectRenderer(path)
        return kind === 'code' || kind === 'fallback'
      })()

      if (existing) {
        // 已打开：只更新时间戳并激活 Tab，**不重读磁盘**（重读会丢掉缓冲区）
        set((st) => ({ docs: { ...st.docs, [path]: touchDocPure(existing) }, activeDocPath: path }))
        await get().openPreview(path, {
          pinned: mode === 'pinned',
          rendererOverride: existing.editable && defaultToEditor ? 'editor' : undefined,
        })
        return
      }

      try {
        const res = await ark.fs.readText(path)
        const doc = createEditorDoc(res.probe, res.language)

        // 文本不进 store（J12）：交给 services/editorSession 的瞬时交接缓存
        if (res.content !== null) putInitialText(path, res.content)

        set((st) => {
          const docs = { ...st.docs, [path]: doc }
          // Tab 软上限（J9）：淘汰最久未用的**非 dirty** 文档
          for (const p of selectLruEvictions(docs)) {
            delete docs[p]
            clearEditorSession(p)
          }
          return { docs, activeDocPath: path }
        })

        if (!doc.editable && doc.readonlyReason) {
          get().pushToast({ type: 'warning', message: readonlyToastMessage(doc), duration: 4000 })
        }

        await get().openPreview(path, {
          pinned: mode === 'pinned',
          rendererOverride: doc.editable && defaultToEditor ? 'editor' : undefined,
        })
      } catch (err) {
        // 探针失败（越界路径 / 权限 / IPC 异常）：**仍要能打开**。
        // 兼容性承诺：修复前所有入口都是 `openPreview`，「点了文件一定能看到东西」
        // 是既有行为；若此处只弹 toast 而不开 Tab，等于静默退化。
        // 故退回只读渲染 Tab（越界等异常由 PreviewWindow 自身的 error 视图承载）。
        get().pushToast({ type: 'danger', message: friendlyError(err), duration: 4000 })
        await get()
          .openPreview(path, { pinned: mode === 'pinned' })
          .catch(() => {})
      }
    },

    /**
     * 关闭文档。**dirty / 保存中 → 返回 false 且不关闭**（A5/A6 禁止静默丢弃），
     * 由调用方弹「保存并关闭 / 丢弃改动 / 取消」三选一，再走 `closeDocForce`。
     */
    closeDoc: (path) => {
      const doc = get().docs[path]
      if (doc && (doc.dirty || doc.saveState === 'saving')) return false
      get().closeDocForce(path)
      return true
    },

    /** 丢弃改动并关闭（调用方须已取得用户确认） */
    closeDocForce: (path) => {
      const pw = get().previewWindow
      set((s) => {
        const docs = { ...s.docs }
        delete docs[path]
        const conflicts = { ...s.conflicts }
        delete conflicts[path]
        const recentlyClosed = [
          { path, closedAt: Date.now() },
          ...s.recentlyClosed.filter((r) => r.path !== path),
        ].slice(0, RECENTLY_CLOSED_LIMIT)
        return {
          docs,
          conflicts,
          recentlyClosed,
          activeDocPath: s.activeDocPath === path ? null : s.activeDocPath,
        }
      })
      clearEditorSession(path)
      // 同步关闭预览 Tab（避免「文档已关、Tab 还开着」的空壳）
      const tab = pw?.tabs.find((t) => t.target.kind === 'file' && t.target.path === path)
      if (tab) get().closePreviewTab(tab.id)
    },

    /* ---- 文档状态迁移 ---- */
    markDirty: (path, dirty) => {
      set((s) => {
        const doc = s.docs[path]
        if (!doc) return {}
        return { docs: { ...s.docs, [path]: markDirtyPure(doc, dirty) } }
      })
    },

    touchDoc: (path) => {
      set((s) => {
        const doc = s.docs[path]
        if (!doc) return {}
        return { docs: { ...s.docs, [path]: touchDocPure(doc) }, activeDocPath: path }
      })
    },

    setConflict: (path, c) => {
      set((s) => {
        const conflicts = { ...s.conflicts }
        if (c) conflicts[path] = c
        else delete conflicts[path]
        const doc = s.docs[path]
        const docs =
          doc && !c && doc.conflict ? { ...s.docs, [path]: { ...doc, conflict: null } } : s.docs
        return { conflicts, docs }
      })
    },

    setDocViewMode: (path, vm) => {
      set((s) => {
        const doc = s.docs[path]
        if (!doc) return {}
        return { docs: { ...s.docs, [path]: setViewMode(doc, vm) } }
      })
    },

    /* ---- 保存 ---- */
    saveDoc: async (path, opts) => {
      const doc = get().docs[path]
      if (!doc) return { kind: 'skipped', reason: 'clean' }
      // 无宿主句柄（Tab 已卸载）时不进入 saving，否则状态会卡在 saving
      if (!getEditorHandle(path)) return { kind: 'skipped', reason: 'busy' }
      if (doc.saveState !== 'idle') return { kind: 'skipped', reason: 'busy' }

      set((s) => ({ docs: { ...s.docs, [path]: beginSave(s.docs[path]) } }))
      const outcome = await runSave(doc, saveIo, opts)
      applyOutcome(path, outcome)
      return outcome
    },

    /**
     * 重新探测（只读态的「重新探测」出口：权限位被改 / agent 写完 / 文件回来了）。
     *
     * **仅在文档不 dirty 时重设 hash 基线**：dirty 文档重设基线会让下一次保存
     * 静默跳过 CAS（把「基于旧基线的提交」当成干净提交）——这正是 J3 要禁止的。
     */
    reprobeDoc: async (path) => {
      const current = get().docs[path]
      if (!current) return
      try {
        const res = await ark.fs.readText(path)
        const fresh = createEditorDoc(res.probe, res.language, current.openedAt)
        set((s) => {
          const doc = s.docs[path]
          if (!doc) return {}
          return {
            docs: {
              ...s.docs,
              [path]: {
                ...fresh,
                // 渲染层状态原样保留
                dirty: doc.dirty,
                saveState: doc.saveState,
                conflict: doc.conflict,
                viewMode: doc.viewMode,
                openedAt: doc.openedAt,
                lastActiveAt: Date.now(),
              },
            },
          }
        })
        if (res.content !== null) putInitialText(path, res.content)
        if (!current.editable && fresh.editable) {
          get().pushToast({ type: 'success', message: i18n.t('editor.readonly.action.retry'), duration: 2500 })
        }
      } catch (err) {
        get().pushToast({ type: 'danger', message: friendlyError(err), duration: 4000 })
      }
    },

    /** 还原磁盘（丢弃我的改动）：重读磁盘、替换缓冲区、清冲突（原型 07 第 3 项） */
    revertDocToDisk: async (path) => {
      try {
        const res = await ark.fs.readText(path)
        if (res.content === null) {
          get().pushToast({
            type: 'warning',
            message: readonlyToastMessage(createEditorDoc(res.probe, res.language)),
            duration: 4000,
          })
          return
        }
        getEditorHandle(path)?.setText(res.content, { markClean: true })
        putInitialText(path, res.content)
        set((s) => {
          const doc = s.docs[path]
          if (!doc) return {}
          const conflicts = { ...s.conflicts }
          delete conflicts[path]
          return { docs: { ...s.docs, [path]: applyRevertedToDisk(doc, res.probe) }, conflicts }
        })
      } catch (err) {
        get().pushToast({ type: 'danger', message: friendlyError(err), duration: 4000 })
      }
    },
  }
}
