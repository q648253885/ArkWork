/* ============================================================
 * ArkWork — 键位处理函数（v0.31.0 B0）
 *
 * 迁移前 `App.tsx` 里 13 个分支的**逐条搬运**。这里只做「动作」，
 * 不做和弦识别 —— 和弦与上下文判定全在 registry。
 *
 * 为什么 handler 自己调 `e.preventDefault()` 而不由分发器统一调：
 *   迁移前每个分支的 preventDefault 时机各不相同（有的分支刻意**不**拦，
 *   如「表单内 Shift+Tab 放行」与 Esc 链的若干"只关一层"分支）。
 *   统一拦会把原生行为一并吃掉。因此**保持 handler 自持**，
 *   分发器只负责"是否已被消费"（返回 false = 继续冒泡）。
 *
 * 本文件**不可**被 node:test 直接 import：它依赖 store 与 IPC 客户端，
 * 二者在无 `window` 环境下会抛错。单测只读 `spec.ts` / `registry.ts` /
 * `context.ts`（见 types.ts 文件头对拆分的说明）。
 * ============================================================ */
import i18n from '../i18n'
import { useStore, type InspectorTabId, type ModulePage } from '../store'
import type { PermissionMode } from '@shared/types/permission'
import type { DispatchEvent } from './types'
import type { KeymapId } from './spec'

/**
 * 宿主提供的回调 —— 键位处理需要触达 App 组件的局部状态时经此注入，
 * 避免注册表反向依赖 React 组件（否则无法在应用启动期一次性注册）。
 */
export interface KeymapHost {
  /** Esc：暂停/停止确认弹窗当前是否打开（迁移前读的是 `escPauseRef.current`） */
  isPauseConfirmOpen: () => boolean
  /** Esc：关闭该弹窗 */
  closePauseConfirm: () => void
  /** Esc：打开该弹窗（携带当前 running 任务） */
  openPauseConfirm: (task: { id: string; title: string }) => void
}

/** 权限模式循环顺序（v0.28.0 F6：四态；bypassPermissions 只能经下拉/设置页进入） */
const PERMISSION_ORDER: readonly PermissionMode[] = ['default', 'autoApprove', 'acceptEdits', 'plan']

/** 表单元素判定：这些元素内保留原生 Shift+Tab / 方向键行为 */
function isFormTarget(target: unknown): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null
  if (!el) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable === true
}

/**
 * 构造 `id → handler` 映射。宿主注入后即可注册。
 *
 * 每个 handler 的注释保留**迁移来源行号**，便于与 `git show v0.30.2:src/renderer/App.tsx` 对账。
 */
/** handler 类型别名：返回 `false` = 不消费，注册表继续尝试下一候选 */
export type KeyHandler = (e: DispatchEvent) => boolean | void

export function createHandlers(host: KeymapHost): Record<KeymapId, KeyHandler> {
  /* 两个共用实现：分支 10 / 11 各自 6 条声明，避免六份复制粘贴漂移 */
  const gotoModule =
    (page: ModulePage): KeyHandler =>
    (e) => {
      e.preventDefault?.()
      useStore.getState().openModulePage(page)
    }
  const gotoTab =
    (slot: number): KeyHandler =>
    (e) => {
      e.preventDefault?.()
      const s = useStore.getState()
      const tab = s.inspectorTabOrder.filter((t2) => !s.hiddenInspectorTabs.includes(t2))[slot] as
        | InspectorTabId
        | undefined
      if (!tab) return
      s.setInspectorTab(tab)
      if (s.rightDockCollapsed) s.toggleRightDock()
    }

  return {
    /* ---- App.tsx:77（分支 1）HelpCenter 开 / 关 ---- */
    'help.toggle': () => {
      useStore.getState().toggleHelp()
    },
    'help.toggleAlt': () => {
      useStore.getState().toggleHelp()
    },

    /* ---- App.tsx:84（分支 2）Quick Action ---- */
    'palette.quickAction': () => {
      const s = useStore.getState()
      s.setCmdPaletteOpen(!s.cmdPaletteOpen)
    },

    /* ---- App.tsx:92（分支 3）QuickOpen ---- */
    'quickOpen.toggle': () => {
      const s = useStore.getState()
      s.setQuickOpenOpen(!s.quickOpenOpen)
    },

    /* ---- App.tsx:100（分支 4）新建任务 ---- */
    'task.new': () => {
      const s = useStore.getState()
      // 迁移前语义：先退出模块页，再建任务并把焦点交给 Composer
      if (s.modulePage) s.closeModulePage()
      void s.createTask({ title: '', text: '' })
      window.dispatchEvent(new Event('composer:focus'))
    },

    /* ---- App.tsx:110（分支 5）折叠左侧栏 ---- */
    'nav.toggleLeft': () => {
      useStore.getState().toggleLeftNav()
    },

    /* ---- App.tsx:117（分支 6）折叠右侧栏 ---- */
    'inspector.toggleRight': () => {
      useStore.getState().toggleRightDock()
    },

    /* ---- App.tsx:125（分支 7）浮窗开关 ---- */
    'preview.toggle': () => {
      const s = useStore.getState()
      if (s.previewWindow) s.closePreview()
      else
        void s.openPreview('').catch(() => {
          /* 占位，无害：迁移前即为空实现 */
        })
    },

    /* ---- App.tsx:134（分支 8）设置页 ---- */
    'module.settings': () => {
      const s = useStore.getState()
      if (s.modulePage === 'settings') s.closeModulePage()
      else s.openModulePage('settings')
    },

    /* ---- App.tsx:143（分支 9）工作区切换器 ----
     * 迁移前用 window 自定义事件与 TopBar 解耦，保持不动（不引入 store 穿透）。 */
    'workspace.switcher': (e) => {
      e.preventDefault?.()
      window.dispatchEvent(new CustomEvent('topbar:open-workspace'))
    },

    /* ---- App.tsx:152（分支 10）能力入口 1~6 ---- */
    'module.goto.agents': gotoModule('agents'),
    'module.goto.skills': gotoModule('skills'),
    'module.goto.kb': gotoModule('kb'),
    'module.goto.memory': gotoModule('memory'),
    'module.goto.automations': gotoModule('automations'),
    'module.goto.settings': gotoModule('settings'),

    /* ---- App.tsx:165（分支 11）Inspector Tab 直达 ----
     * 序号取自 `inspectorTabOrder` 过滤掉隐藏项后的第 N 项（**不是**硬编码 tab 名），
     * 以便用户自定义 Tab 顺序后快捷键跟随。命中时同步展开内容面板。 */
    'inspector.tab.todos': gotoTab(0),
    'inspector.tab.context': gotoTab(1),
    'inspector.tab.files': gotoTab(2),
    'inspector.tab.logs': gotoTab(3),
    'inspector.tab.browser': gotoTab(4),
    'inspector.tab.terminal': gotoTab(5),

    /* ---- App.tsx:184（分支 12）权限模式循环 ----
     * 表单内**放行原生 Shift+Tab**（不拦、不切换），这是迁移前既有语义。 */
    'permission.cycle': (e) => {
      if (isFormTarget(e.target)) return true
      e.preventDefault?.()
      const s = useStore.getState()
      const next = PERMISSION_ORDER[(PERMISSION_ORDER.indexOf(s.permissionMode) + 1) % PERMISSION_ORDER.length]
      void s.setPermissionMode(next)
      const labels: Record<PermissionMode, string> = {
        default: i18n.t('app.permissionMode.default'),
        autoApprove: i18n.t('app.permissionMode.autoApprove'),
        acceptEdits: i18n.t('app.permissionMode.acceptEdits'),
        plan: i18n.t('app.permissionMode.plan'),
        bypassPermissions: i18n.t('app.permissionMode.bypass'),
      }
      s.pushToast({ type: 'success', message: labels[next], duration: 2000 })
    },

    /* ---- App.tsx:207（分支 13）Escape 优先级链 ----
     * 9 级顺序**即语义**（同一时刻只关闭最上面一层）。改动顺序前先读
     * 04-system-design §6 的浮层层级表。 */
    'overlay.escape': (e) => {
      const s = useStore.getState()
      // Task 14：HelpCenter 最高优先级（任何浮层之先）
      if (s.helpOpen) {
        s.setHelpOpen(false)
        return
      }
      if (s.quickOpenOpen) {
        s.setQuickOpenOpen(false)
        return
      }
      if (s.cmdPaletteOpen) {
        s.setCmdPaletteOpen(false)
        return
      }
      // 这两层由各自组件处理 Esc（ConfirmDialog / 工具确认层），此处只"让位"
      if (s.confirmDialog.open) return
      if (s.pendingConfirm) return
      if (s.previewWindow) {
        s.closePreview()
        return
      }
      if (s.modulePage) {
        s.closeModulePage()
        return
      }
      // v0.14.0 Task 9：Esc 暂停/停止确认 —— 弹窗已开时再次 Esc 关闭它
      if (host.isPauseConfirmOpen()) {
        host.closePauseConfirm()
        return
      }
      const runningTask = s.tasks.find((t2) => t2.status === 'running')
      if (runningTask) {
        e.preventDefault?.()
        host.openPauseConfirm({ id: runningTask.id, title: runningTask.title })
        return
      }
      if (!s.rightDockCollapsed) {
        s.toggleRightDock()
      }
    },
  }
}
