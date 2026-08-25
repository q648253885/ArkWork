/* ============================================================
 * ArkWork — SettingsContent (redesign-workspace-navigation Task 4 + polish3 Task 2)
 * 设置页面内容：作为 Center Stage 一级页面（modulePage='settings'）
 * 替代 v0.11.0 F1102 SettingsDialog（role=dialog 的 Modal）。
 *
 * 复用 SettingsDialog 的四分区逻辑：
 *   Models / Workspace / Knowledge / Appearance / Advanced
 * 快捷键总表已迁出至 HelpCenter 内唯一展示（polish3 §Task 2）。
 * 行为：所有修改即时生效，破坏性操作继续走 confirm()。
 *
 * 注意：本组件不使用 role=dialog / backdrop / modal，
 * 由外层 ModulePage 提供头部与关闭按钮，焦点与快捷键归属 ModulePage。
 * ============================================================ */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore, type SettingsTab } from '../store'
import { SectionLabel } from './ui'
import { StepList } from './right/StepList'
import { LogsView } from './right/LogsView'
import { Icon } from '../icons'
import { ark } from '../ipc/client'
import type { PermissionMode } from '@shared/types/permission'
import type { LlmModel, LlmProviderKind } from '@shared/types/agent'
import type { Locale, TestModelResult } from '@shared/types/ipc'

// polish3 §Task 2.1：删除 shortcuts Tab；总表仅 HelpCenter 内展示
// label/hint 为 i18n key（settings.tabs.*）
const TABS: { id: SettingsTab; label: string; hint: string }[] = [
  { id: 'models',     label: 'settings.tabs.models',     hint: 'settings.tabs.modelsHint' },
  { id: 'workspace',  label: 'settings.tabs.workspace',  hint: 'settings.tabs.workspaceHint' },
  { id: 'knowledge',  label: 'settings.tabs.knowledge',  hint: 'settings.tabs.knowledgeHint' },
  { id: 'appearance', label: 'settings.tabs.appearance', hint: 'settings.tabs.appearanceHint' },
  { id: 'advanced',   label: 'settings.tabs.advanced',   hint: 'settings.tabs.advancedHint' },
]

const KIND_LABELS: Record<LlmProviderKind, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  ollama: 'Ollama',
  vllm: 'vLLM',
}

// hint 为 i18n key（settings.models.kindHints.*）
const KIND_HINTS: Record<LlmProviderKind, string> = {
  openai: 'settings.models.kindHints.openai',
  anthropic: 'settings.models.kindHints.anthropic',
  ollama: 'settings.models.kindHints.ollama',
  vllm: 'settings.models.kindHints.vllm',
}

const KIND_DEFAULT_URL: Record<LlmProviderKind, string> = {
  openai: '',
  anthropic: '',
  ollama: 'http://127.0.0.1:11434/v1',
  vllm: 'http://127.0.0.1:8000/v1',
}

/**
 * redesign-workspace-navigation Task 4 + polish3 Task 2：设置页面正文。
 * 由 ModulePage 嵌入；不再依赖 role=dialog / backdrop。
 * SHORTCUTS / ShortcutsSection 已删除（polish3 §Task 2.3）：快捷键总表
 * 仅在 HelpCenter 内 ⌘? 打开后查看，目录中有独立"快捷键"项直达总表。
 */
export function SettingsContent() {
  const { t } = useTranslation()
  const settingsTab = useStore((s) => s.settingsTab)
  const setSettingsTab = useStore((s) => s.setSettingsTab)
  const models = useStore((s) => s.models)

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 顶部 Tab 栏：与 ModulePage 头部分离，作为内容子导航 */}
      <div className="flex items-center gap-1 px-5 pt-4 flex-shrink-0 overflow-x-auto" role="tablist" aria-label={t('settings.tabs.barAriaLabel')}>
        {TABS.map((tab) => {
          const active = settingsTab === tab.id
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={active}
              onClick={() => setSettingsTab(tab.id)}
              title={t(tab.hint)}
              className={`flex items-center h-8 px-3.5 rounded-md text-xs transition-colors focus-ring ${
                active
                  ? 'bg-bg-active text-text-primary font-medium'
                  : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
              }`}
            >
              {t(tab.label)}
            </button>
          )
        })}
      </div>

      {/* 正文 */}
      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
        {settingsTab === 'models' && <ModelsSection models={models} />}
        {settingsTab === 'workspace' && <WorkspaceSection />}
        {settingsTab === 'knowledge' && <KnowledgeSection />}
        {settingsTab === 'appearance' && <AppearanceSection />}
        {settingsTab === 'advanced' && <DeveloperSection />}
      </div>

      {/* 底部说明；关闭按钮在 ModulePage 头部右上角统一提供 */}
      <div className="flex items-center px-5 py-3 border-t border-border-subtle flex-shrink-0">
        <span className="text-2xs text-text-tertiary">
          {t('settings.tabs.footer')}
        </span>
      </div>
    </div>
  )
}

/* ============================================================
 * Knowledge Section — Task 8：全局知识库开关
 *  - 总开关：关闭后 kb_query 不再注入上下文（Inspector 上下文面板显示 "知识库：未启用"）
 *  - 会话级开关在 ContextPanel 顶部（独立 UI）
 *  - 当前 KB 数量 + 解析状态摘要
 * ============================================================ */
function KnowledgeSection() {
  const { t } = useTranslation()
  const globalKbEnabled = useStore((s) => s.globalKbEnabled)
  const setGlobalKbEnabled = useStore((s) => s.setGlobalKbEnabled)
  const knowledgeBases = useStore((s) => s.knowledgeBases)
  const openModulePage = useStore((s) => s.openModulePage)

  const enabledCount = knowledgeBases.filter((k) => !k.parseError && k.enabled !== false).length
  const failedCount = knowledgeBases.filter((k) => !!k.parseError).length

  return (
    <section className="space-y-4">
      <div>
        <div className="flex items-center justify-between mb-2">
          <SectionLabel>{t('settings.knowledge.globalTitle')}</SectionLabel>
          <span className="text-2xs text-text-tertiary">
            {t('settings.knowledge.effectiveImmediately')}
          </span>
        </div>
        <div className="rounded-md border border-border-subtle bg-bg-base p-3.5">
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={globalKbEnabled}
              onChange={(e) => void setGlobalKbEnabled(e.target.checked)}
              data-kb-toggle="global"
              className="mt-0.5 accent-accent"
            />
            <div className="flex-1 min-w-0">
              <div className="text-sm text-text-primary font-medium">
                {t('settings.knowledge.enableInjection')}
              </div>
              <div className="text-2xs text-text-tertiary mt-0.5 leading-relaxed">
                {t('settings.knowledge.injectBodyPrefix')}<code className="text-text-secondary">kb-search</code>{t('settings.knowledge.injectBodySuffix')}
              </div>
            </div>
          </label>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <SectionLabel>{t('settings.knowledge.currentTitle')}</SectionLabel>
          <button
            onClick={() => openModulePage('kb')}
            className="flex items-center h-8 px-3 rounded-md text-xs text-accent hover:bg-accent-soft transition-colors focus-ring"
          >
            {t('settings.knowledge.openPanel')}
          </button>
        </div>
        <div className="rounded-md border border-border-subtle bg-bg-base p-3.5 space-y-1.5 text-xs text-text-secondary">
          <div className="flex items-center justify-between">
            <span>{t('settings.knowledge.indexedCount')}</span>
            <span className="font-mono text-text-primary">{enabledCount}</span>
          </div>
          <div className="flex items-center justify-between">
            <span>{t('settings.knowledge.parseFailed')}</span>
            <span className={`font-mono ${failedCount > 0 ? 'text-danger' : 'text-text-tertiary'}`}>{failedCount}</span>
          </div>
          <div className="flex items-center justify-between">
            <span>{t('settings.knowledge.totalCount')}</span>
            <span className="font-mono text-text-primary">{knowledgeBases.length}</span>
          </div>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <SectionLabel>{t('settings.knowledge.sessionTitle')}</SectionLabel>
        </div>
        <div className="rounded-md border border-border-subtle bg-bg-base p-3.5 text-xs text-text-secondary">
          {t('settings.knowledge.sessionDesc')}
        </div>
      </div>
    </section>
  )
}

/* ============================================================
 * Permission Section — v0.15.0 权限模型（位于 Developer Tab 顶部）
 *  - 会话模式三选一（default / acceptEdits / plan）
 *  - 合并规则三栏（allow / ask / deny）+ 自定义 allow 规则输入
 * v0.28.0（F6）：扩为五态 —— autoApprove 直选；bypassPermissions 需二次确认
 * ============================================================ */
// label/desc 为 i18n key（settings.permission.modeOptions.*）
const PERMISSION_OPTIONS: { id: PermissionMode; label: string; desc: string }[] = [
  { id: 'default', label: 'settings.permission.modeOptions.default.label', desc: 'settings.permission.modeOptions.default.desc' },
  { id: 'autoApprove', label: 'settings.permission.modeOptions.autoApprove.label', desc: 'settings.permission.modeOptions.autoApprove.desc' },
  { id: 'acceptEdits', label: 'settings.permission.modeOptions.acceptEdits.label', desc: 'settings.permission.modeOptions.acceptEdits.desc' },
  { id: 'plan', label: 'settings.permission.modeOptions.plan.label', desc: 'settings.permission.modeOptions.plan.desc' },
  { id: 'bypassPermissions', label: 'settings.permission.modeOptions.bypassPermissions.label', desc: 'settings.permission.modeOptions.bypassPermissions.desc' },
]

// label 为 i18n key（settings.permission.ruleGroups.*）
const RULE_GROUPS: { key: 'allow' | 'ask' | 'deny'; label: string; cls: string; dot: string }[] = [
  { key: 'allow', label: 'settings.permission.ruleGroups.allow', cls: 'bg-success-soft text-success border-success', dot: 'bg-success' },
  { key: 'ask', label: 'settings.permission.ruleGroups.ask', cls: 'bg-warning-soft text-warning border-warning', dot: 'bg-warning' },
  { key: 'deny', label: 'settings.permission.ruleGroups.deny', cls: 'bg-danger-soft text-danger border-danger', dot: 'bg-danger' },
]

function PermissionSection() {
  const { t } = useTranslation()
  const permissionMode = useStore((s) => s.permissionMode)
  const setPermissionMode = useStore((s) => s.setPermissionMode)
  const confirm = useStore((s) => s.confirm)
  const permissionRules = useStore((s) => s.permissionRules)
  const refreshPermissionRules = useStore((s) => s.refreshPermissionRules)
  const addPermissionRule = useStore((s) => s.addPermissionRule)
  const [ruleDraft, setRuleDraft] = useState('')

  // v0.28.0（F6）：bypass 需二次确认（danger 实心 + 默认焦点在取消），其余直切
  const handleSelectMode = async (mode: PermissionMode) => {
    if (mode === 'bypassPermissions') {
      const ok = await confirm({
        title: t('settings.permission.bypassConfirmTitle'),
        body: [
          t('settings.permission.confirmBody0'),
          t('settings.permission.confirmBody1'),
          t('settings.permission.confirmBody2'),
          t('settings.permission.confirmBody3'),
          '',
          t('settings.permission.confirmBody5'),
        ].join('\n'),
        confirmLabel: t('settings.permission.bypassConfirmLabel'),
        cancelLabel: t('settings.permission.cancel'),
        danger: true,
        focusCancel: true,
      })
      if (!ok) return
    }
    await setPermissionMode(mode)
  }

  // 挂载时拉取一次合并规则；主进程广播 / setPermissionMode / addPermissionRule 会自动刷新
  useEffect(() => {
    void refreshPermissionRules()
  }, [refreshPermissionRules])

  const handleAddRule = async () => {
    const rule = ruleDraft.trim()
    if (!rule) return
    await addPermissionRule(rule)
    setRuleDraft('')
  }

  const totalRules =
    (permissionRules?.allow.length ?? 0) +
    (permissionRules?.ask.length ?? 0) +
    (permissionRules?.deny.length ?? 0)

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <SectionLabel>{t('settings.permission.title')}</SectionLabel>
        <span className="text-2xs text-text-tertiary">{t('settings.permission.fastSwitchHint')}</span>
      </div>
      <div className="rounded-md border border-border-subtle bg-bg-base p-3.5 space-y-3.5">
        {/* 会话模式 segmented control */}
        <div>
          <div className="text-xs text-text-secondary mb-1.5">{t('settings.permission.sessionMode')}</div>
          <div className="flex items-center gap-0.5 rounded-md border border-border-subtle bg-bg-overlay p-0.5 w-fit">
            {PERMISSION_OPTIONS.map((opt) => {
              const active = permissionMode === opt.id
              return (
                <button
                  key={opt.id}
                  onClick={() => void handleSelectMode(opt.id)}
                  title={t(opt.desc)}
                  className={`flex items-center min-h-8 px-3 rounded font-mono text-xs transition-colors focus-ring ${
                    active
                      ? 'bg-accent-soft text-accent font-medium'
                      : 'text-text-tertiary hover:text-text-primary hover:bg-bg-hover'
                  }`}
                >
                  {t(opt.label)}
                </button>
              )
            })}
          </div>
          <div className="mt-1.5 text-2xs text-text-tertiary">
            {PERMISSION_OPTIONS.find((o) => o.id === permissionMode) && t(PERMISSION_OPTIONS.find((o) => o.id === permissionMode)!.desc)}
          </div>
        </div>

        {/* 合并规则三栏 */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs text-text-secondary">{t('settings.permission.ruleMerged')}</span>
            <span className="text-2xs text-text-tertiary">{t('settings.permission.ruleCount', { count: totalRules })}</span>
          </div>
          {totalRules === 0 ? (
            <div className="text-xs text-text-tertiary py-3 text-center bg-bg-overlay rounded-md">
              {t('settings.permission.noCustomRules')}
            </div>
          ) : (
            <div className="space-y-2.5">
              {RULE_GROUPS.map((g) => {
                const items = permissionRules?.[g.key] ?? []
                return (
                  <div key={g.key}>
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${g.dot}`} />
                      <span className="text-2xs text-text-tertiary">{t(g.label)}</span>
                      <span className="text-2xs text-text-tertiary">{items.length}</span>
                    </div>
                    {items.length === 0 ? (
                      <div className="text-2xs text-text-tertiary pl-3">{t('settings.permission.none')}</div>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {items.map((r, i) => (
                          <span
                            key={`${g.key}-${i}`}
                            className={`px-2 py-0.5 rounded border font-mono text-2xs ${g.cls}`}
                          >
                            {r}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* 自定义 allow 规则输入 */}
        <div>
          <div className="text-xs text-text-secondary mb-1.5">{t('settings.permission.customAllowRules')}</div>
          <div className="flex items-center gap-2">
            <input
              value={ruleDraft}
              onChange={(e) => setRuleDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleAddRule()
              }}
              className="input flex-1"
              placeholder={t('settings.permission.addRulePlaceholder')}
            />
            <button
              onClick={() => void handleAddRule()}
              disabled={!ruleDraft.trim()}
              className="flex items-center h-8 px-3 rounded-md text-xs text-accent hover:bg-accent-soft transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus-ring"
            >
              {t('settings.permission.addAllowRule')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ============================================================
 * Developer Section — 高级：日志 / 图谱（原开发者 Tab）+ 压缩策略只读
 * ============================================================ */
function DeveloperSection() {
  const { t } = useTranslation()
  const [tab, setTab] = useState<'logs' | 'graph'>('logs')
  return (
    <section className="space-y-4">
      <PermissionSection />
      <div>
        <div className="flex items-center justify-between mb-2">
          <SectionLabel>{t('settings.developer.compressionTitle')}</SectionLabel>
        </div>
        <div className="rounded-md border border-border-subtle bg-bg-base p-3.5 space-y-1.5 text-xs text-text-secondary">
          <div className="flex items-center justify-between">
            <span>{t('settings.developer.compressThresholdLabel')}</span>
            <span className="font-mono text-text-primary">80% token</span>
          </div>
          <div className="flex items-center justify-between">
            <span>{t('settings.developer.compressStrategyLabel')}</span>
            <span className="font-mono text-text-primary">{t('settings.developer.compressStrategyValue')}</span>
          </div>
          <div className="flex items-center justify-between">
            <span>{t('settings.developer.distillThresholdLabel')}</span>
            <span className="font-mono text-text-primary">{t('settings.developer.distillThresholdValue')}</span>
          </div>
          <div className="flex items-center justify-between">
            <span>{t('settings.developer.tempEntryTtlLabel')}</span>
            <span className="font-mono text-text-primary">{t('settings.developer.tempEntryTtlValue')}</span>
          </div>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <SectionLabel>{t('settings.developer.toolsTitle')}</SectionLabel>
          <div className="flex items-center gap-0.5">
            {(['logs', 'graph'] as const).map((tt) => {
              const active = tab === tt
              return (
                <button
                  key={tt}
                  onClick={() => setTab(tt)}
                  className={`flex items-center min-h-8 px-2.5 rounded-md text-xs transition-colors focus-ring ${
                    active
                      ? 'bg-bg-active text-text-primary'
                      : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
                  }`}
                >
                  {tt === 'logs' ? t('settings.developer.logsTab') : t('settings.developer.graphTab')}
                </button>
              )
            })}
          </div>
        </div>
        <div className="rounded-md border border-border-subtle bg-bg-overlay overflow-hidden h-[260px]">
          {tab === 'logs' ? <LogsView /> : <StepList />}
        </div>
      </div>
    </section>
  )
}

// polish3 §Task 2.3：ShortcutsSection 与 SHORTCUTS 数据已删除；
// 快捷键总表仅在 HelpCenter 内展示（HelpAction 跳转 ⌘?）。

/* ============================================================
 * Workspace Section — 工作区管理（并入设置弹窗，原 TopBar 下拉）
 * ============================================================ */
function WorkspaceSection() {
  const { t } = useTranslation()
  const workspaces = useStore((s) => s.workspaces)
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const switchWorkspace = useStore((s) => s.switchWorkspace)
  const removeWorkspace = useStore((s) => s.removeWorkspace)
  const createWorkspace = useStore((s) => s.createWorkspace)
  const confirm = useStore((s) => s.confirm)
  const pushToast = useStore((s) => s.pushToast)
  const tasks = useStore((s) => s.tasks)

  const runningByWs = (wsId: string) =>
    tasks.filter((t) => t.status === 'running' && t.workspaceId === wsId).length

  const handleRemove = async (id: string, name: string) => {
    const ok = await confirm({
      title: t('settings.workspace.removeConfirmTitle'),
      body: t('settings.workspace.removeConfirmBody', { name }),
      confirmLabel: t('settings.workspace.remove'),
      danger: true,
    })
    if (ok) removeWorkspace(id)
  }

  const handleOpenFolder = async (path?: string) => {
    if (!path) {
      pushToast({ type: 'warning', message: t('settings.workspace.noFolderToast'), duration: 2500 })
      return
    }
    try {
      await ark.fs.revealInFolder(path)
    } catch (e) {
      pushToast({ type: 'danger', message: t('settings.workspace.openFolderFail', { message: (e as Error).message }), duration: 3000 })
    }
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <SectionLabel>{t('settings.workspace.title')}</SectionLabel>
        <button
          onClick={() => void createWorkspace()}
          className="flex items-center h-8 px-3 rounded-md text-xs text-accent hover:bg-accent-soft transition-colors focus-ring"
        >
          <Icon.Plus width={16} height={16} />
          {t('settings.workspace.add')}
        </button>
      </div>

      <div className="space-y-2">
        {workspaces.map((ws) => {
          const active = ws.id === activeWorkspaceId
          const running = runningByWs(ws.id) > 0
          return (
            <div
              key={ws.id}
              className={`rounded-md border p-3 transition-colors ${
                active ? 'border-accent bg-accent-soft' : 'border-border-subtle bg-bg-overlay'
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${running ? 'bg-accent pulse-dot' : active ? 'bg-success' : 'bg-text-tertiary'}`} />
                  <span className="text-sm font-medium text-text-primary truncate">{ws.name}</span>
                  {active && (
                    <span className="text-2xs px-1.5 py-0.5 rounded bg-accent text-text-inverse">{t('settings.workspace.current')}</span>
                  )}
                  {running && <span className="text-2xs text-accent">{t('settings.workspace.running')}</span>}
                </div>
                <div className="flex flex-wrap items-center justify-end gap-1 flex-shrink-0">
                  <button
                    onClick={() => void handleOpenFolder(ws.path)}
                    className="flex items-center min-h-8 px-2.5 rounded text-xs text-text-secondary hover:text-text-primary hover:bg-bg-base transition-colors focus-ring"
                  >
                    {t('settings.workspace.openFolder')}
                  </button>
                  {!active && (
                    <button
                      onClick={() => void switchWorkspace(ws.id)}
                      className="flex items-center min-h-8 px-2.5 rounded text-xs text-text-secondary hover:text-accent hover:bg-bg-base transition-colors focus-ring"
                    >
                      {t('settings.workspace.switch')}
                    </button>
                  )}
                  {!active && ws.id !== 'default' && (
                    <button
                      onClick={() => void handleRemove(ws.id, ws.name)}
                      className="flex items-center min-h-8 px-2.5 rounded text-xs text-text-secondary hover:text-danger hover:bg-bg-base transition-colors focus-ring"
                    >
                      {t('settings.workspace.remove')}
                    </button>
                  )}
                </div>
              </div>
              {ws.path && (
                <div className="text-2xs text-text-tertiary font-mono truncate">{ws.path}</div>
              )}
            </div>
          )
        })}
        {workspaces.length === 0 && (
          <div className="text-sm text-text-tertiary py-8 text-center bg-bg-overlay rounded-md">
            {t('settings.workspace.empty')}
          </div>
        )}
      </div>
    </section>
  )
}

/* ============================================================
 * Appearance Section — v0.4.0 主题三态切换（F101-F103）
 * ============================================================ */
// v0.29.0：label/desc 为 i18n key（renderer/i18n/locales/*.json 的 settings.appearance.*）
const THEME_OPTIONS: { id: 'light' | 'dark' | 'system'; label: string; desc: string; icon: string }[] = [
  { id: 'light',  label: 'settings.appearance.light', desc: 'settings.appearance.lightDesc', icon: '☀️' },
  { id: 'dark',   label: 'settings.appearance.dark', desc: 'settings.appearance.darkDesc',  icon: '🌙' },
  { id: 'system', label: 'settings.appearance.system', desc: 'settings.appearance.systemDesc', icon: '💻' },
]

// v0.29.0：语言选项以各自语言原生显示（W3C 本地化惯例）
const LANGUAGE_OPTIONS: { id: Locale; label: string }[] = [
  { id: 'zh', label: '中文' },
  { id: 'en', label: 'English' },
  { id: 'ja', label: '日本語' },
  { id: 'ko', label: '한국어' },
]

function AppearanceSection() {
  const theme = useStore((s) => s.theme)
  const resolvedTheme = useStore((s) => s.resolvedTheme)
  const setTheme = useStore((s) => s.setTheme)
  // v0.29.0：界面语言
  const { t } = useTranslation()
  const language = useStore((s) => s.language)
  const setLanguage = useStore((s) => s.setLanguage)

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <SectionLabel>{t('settings.appearance.title')}</SectionLabel>
        <span className="text-2xs text-text-tertiary">
          {resolvedTheme === 'dark' ? t('settings.appearance.actualDark') : t('settings.appearance.actualLight')}
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
        {THEME_OPTIONS.map((opt) => {
          const active = theme === opt.id
          return (
            <button
              key={opt.id}
              onClick={() => void setTheme(opt.id)}
              className={`flex flex-col items-start gap-1 p-3.5 rounded-lg border text-left transition-colors focus-ring ${
                active
                  ? 'border-accent bg-accent-soft'
                  : 'border-border-subtle bg-bg-overlay hover:bg-bg-hover hover:border-border-default'
              }`}
            >
              <span className="text-xl leading-none">{opt.icon}</span>
              <span className={`text-sm font-medium ${active ? 'text-accent' : 'text-text-primary'}`}>
                {t(opt.label)}
              </span>
              <span className="text-2xs text-text-tertiary leading-relaxed">{t(opt.desc)}</span>
            </button>
          )
        })}
      </div>

      {/* v0.29.0：界面语言（切换即时生效；选项以各自语言原生显示，不做翻译） */}
      <div className="mt-4">
        <div className="text-xs text-text-secondary mb-2">{t('settings.language.label')}</div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          {LANGUAGE_OPTIONS.map((opt) => {
            const active = language === opt.id
            return (
              <button
                key={opt.id}
                onClick={() => void setLanguage(opt.id)}
                aria-pressed={active}
                className={`min-h-10 px-3 py-2 rounded-lg border text-sm font-medium text-left transition-colors focus-ring ${
                  active
                    ? 'border-accent bg-accent-soft text-accent'
                    : 'border-border-subtle bg-bg-overlay text-text-primary hover:bg-bg-hover hover:border-border-default'
                }`}
              >
                {opt.label}
              </button>
            )
          })}
        </div>
        <div className="text-2xs text-text-tertiary mt-1.5 leading-relaxed">{t('settings.language.desc')}</div>
      </div>

      {/* 预览区 */}
      <div className="mt-4 rounded-lg border border-border-subtle bg-bg-overlay p-4">
        <div className="text-2xs text-text-tertiary uppercase tracking-wider mb-2">{t('settings.appearance.preview')}</div>
        <div className="rounded-md bg-bg-base border border-border-subtle p-3.5 space-y-2.5">
          <div className="text-sm text-text-primary">{t('settings.appearance.previewBody')}</div>
          <div className="text-xs text-text-secondary">{t('settings.appearance.previewBodySecondary')}</div>
          <div className="text-2xs text-text-tertiary">{t('settings.appearance.previewBodyMeta')}</div>
          <div className="flex items-center gap-2 pt-1">
            <span className="px-2.5 py-1 rounded-md bg-accent text-text-inverse text-xs">{t('settings.appearance.previewPrimary')}</span>
            <span className="px-2.5 py-1 rounded-md border border-border-default text-text-secondary text-xs">{t('settings.appearance.previewSecondary')}</span>
            <span className="px-2 py-0.5 rounded bg-success-soft text-success text-2xs">{t('settings.appearance.previewSuccess')}</span>
            <span className="px-2 py-0.5 rounded bg-warning-soft text-warning text-2xs">{t('settings.appearance.previewWarning')}</span>
            <span className="px-2 py-0.5 rounded bg-danger-soft text-danger text-2xs">{t('settings.appearance.previewError')}</span>
          </div>
        </div>
      </div>
    </section>
  )
}

/* ============================================================
 * Models Section — 大模型配置（沿用 SettingsView 逻辑）
 * ============================================================ */
function ModelsSection({ models }: { models: LlmModel[] }) {
  const { t } = useTranslation()
  const addModel = useStore((s) => s.addModel)
  const updateModel = useStore((s) => s.updateModel)
  const removeModel = useStore((s) => s.removeModel)
  const testModel = useStore((s) => s.testModel)
  const confirm = useStore((s) => s.confirm)
  const [editing, setEditing] = useState<LlmModel | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<Record<string, TestModelResult>>({})

  const handleTest = async (m: LlmModel) => {
    setTesting(m.id)
    setTestResult((r) => ({ ...r, [m.id]: { ok: false, message: t('settings.models.testing') } }))
    const result = await testModel({
      kind: m.kind,
      baseURL: m.baseURL,
      apiKey: m.apiKey,
      modelId: m.id,
    })
    setTestResult((r) => ({ ...r, [m.id]: result }))
    setTesting(null)
  }

  const handleRemove = async (m: LlmModel) => {
    const ok = await confirm({
      title: t('settings.models.deleteConfirmTitle'),
      body: t('settings.models.deleteConfirmBody', { name: m.name || m.id }),
      confirmLabel: t('settings.models.delete'),
      danger: true,
    })
    if (ok) await removeModel(m.id)
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <SectionLabel>{t('settings.models.title')}</SectionLabel>
        <button
          onClick={() =>
            setEditing({
              id: '',
              name: '',
              kind: 'openai',
              baseURL: '',
              apiKey: '',
              contextWindow: 128_000,
              enabled: true,
            })
          }
          className="flex items-center h-8 px-3 rounded-md text-xs text-accent hover:bg-accent-soft transition-colors focus-ring"
        >
          + {t('settings.models.add')}
        </button>
      </div>

      <div className="space-y-2">
        {models.length === 0 && (
          <div className="text-sm text-text-tertiary py-8 text-center bg-bg-overlay rounded-md">
            {t('settings.models.empty')}
          </div>
        )}
        {models.map((m) => (
          <div key={m.id} className="rounded-md border border-border-subtle bg-bg-overlay p-3">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
              <div className="flex items-center gap-2">
                <span className={`inline-block w-1.5 h-1.5 rounded-full ${m.enabled ? 'bg-success' : 'bg-text-tertiary'}`} />
                <span className="text-sm font-medium text-text-primary">{m.name || m.id}</span>
                <span className="text-2xs px-1.5 py-0.5 rounded bg-bg-base text-text-tertiary uppercase tracking-wider">
                  {KIND_LABELS[m.kind]}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => void handleTest(m)}
                  disabled={testing === m.id}
                  className="flex items-center min-h-8 px-2.5 rounded text-xs text-text-secondary hover:text-text-primary hover:bg-bg-base transition-colors disabled:opacity-50 focus-ring"
                >
                  {testing === m.id ? t('settings.models.testing') : t('settings.models.test')}
                </button>
                <button
                  onClick={() => setEditing(m)}
                  className="flex items-center min-h-8 px-2.5 rounded text-xs text-text-secondary hover:text-text-primary hover:bg-bg-base transition-colors focus-ring"
                >
                  {t('settings.models.edit')}
                </button>
                <button
                  onClick={() => void handleRemove(m)}
                  className="flex items-center min-h-8 px-2.5 rounded text-xs text-text-secondary hover:text-danger hover:bg-bg-base transition-colors focus-ring"
                >
                  {t('settings.models.delete')}
                </button>
              </div>
            </div>
            <div className="text-xs text-text-tertiary space-y-0.5">
              <div>
                model id: <code className="text-text-secondary">{m.id}</code>
              </div>
              <div>
                url: <code className="text-text-secondary">{m.baseURL || t('settings.models.defaultEndpoint')}</code>
              </div>
              <div>
                apiKey: {m.apiKey ? t('settings.models.apiKeyConfigured', { key: m.apiKey.slice(0, 6) }) : <span className="italic">{t('settings.models.apiKeyNotConfigured')}</span>}
                {m.contextWindow ? ` · ctx ${(m.contextWindow / 1000).toFixed(0)}k` : ''}
              </div>
            </div>
            {testResult[m.id] && (
              <div
                className={`mt-2 px-2 py-1.5 rounded text-xs ${
                  testResult[m.id].ok ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger'
                }`}
              >
                {testResult[m.id].ok ? '✓ ' : '✗ '}
                {testResult[m.id].message}
                {testResult[m.id].models && testResult[m.id].models!.length > 0 && (
                  <div className="mt-1 text-text-tertiary">
                    {t('settings.models.availableModels')} {testResult[m.id].models!.slice(0, 5).join(', ')}
                    {testResult[m.id].models!.length > 5 && ' …'}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {editing && (
        <ModelEditor
          model={editing}
          existingIds={new Set(models.map((m) => m.id))}
          onSave={async (m) => {
            if (models.find((x) => x.id === editing.id)) {
              await updateModel(m)
            } else {
              await addModel(m)
            }
            setEditing(null)
          }}
          onCancel={() => setEditing(null)}
        />
      )}
    </section>
  )
}

/* ============================================================
 * Model Editor（保留内嵌编辑器 — 不再依赖 role=dialog 的旧 Modal 容器，
 * 由本页面的 ModulePage 头部提供关闭支持；保持焦点管理简单）。
 * ============================================================ */
function ModelEditor({
  model,
  existingIds,
  onSave,
  onCancel,
}: {
  model: LlmModel
  existingIds: Set<string>
  onSave: (m: LlmModel) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const isEdit = !!model.id
  const [draft, setDraft] = useState<LlmModel>(model)

  const idError = !draft.id
    ? t('settings.models.editor.idRequired')
    : !isEdit && existingIds.has(draft.id)
      ? t('settings.models.editor.idExists')
      : null

  const onKindChange = (kind: LlmProviderKind) => {
    const prevDefault = KIND_DEFAULT_URL[draft.kind]
    const nextDefault = KIND_DEFAULT_URL[kind]
    const baseURL = !draft.baseURL || draft.baseURL === prevDefault ? nextDefault : draft.baseURL
    setDraft({ ...draft, kind, baseURL })
  }

  return (
    <div className="mt-4 rounded-lg border border-border-default bg-bg-overlay shadow-panel">
      <div className="px-5 py-3 border-b border-border-subtle">
        <h3 className="text-sm font-medium text-text-primary">
          {t('settings.models.editor.title', { action: t(isEdit ? 'settings.models.edit' : 'settings.models.new') })}
        </h3>
      </div>
      <div className="px-5 py-4 space-y-3">
        <Field label={t('settings.models.editor.idLabel')} error={idError}>
          <input
            value={draft.id}
            onChange={(e) => setDraft({ ...draft, id: e.target.value })}
            className={`input ${idError ? 'border-danger' : ''}`}
            placeholder={t('settings.models.editor.idPlaceholder')}
            disabled={isEdit}
          />
        </Field>
        <Field label={t('settings.models.editor.nameLabel')}>
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            className="input"
            placeholder={t('settings.models.editor.namePlaceholder')}
          />
        </Field>
        <Field label={t('settings.models.editor.kindLabel')}>
          <select value={draft.kind} onChange={(e) => onKindChange(e.target.value as LlmProviderKind)} className="input">
            {Object.entries(KIND_LABELS).map(([k, label]) => (
              <option key={k} value={k}>{label}</option>
            ))}
          </select>
          <p className="text-2xs text-text-tertiary mt-1">{t(KIND_HINTS[draft.kind])}</p>
        </Field>
        <Field label="Base URL">
          <input
            value={draft.baseURL ?? ''}
            onChange={(e) => setDraft({ ...draft, baseURL: e.target.value })}
            className="input"
            placeholder={draft.kind === 'openai' ? t('settings.models.editor.baseUrlPlaceholderOpenai') : t('settings.models.editor.baseUrlPlaceholderLocal')}
          />
        </Field>
        <Field label="API Key">
          <input
            type="password"
            value={draft.apiKey ?? ''}
            onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
            className="input"
            placeholder={draft.kind === 'ollama' || draft.kind === 'vllm' ? t('settings.models.editor.apiKeyPlaceholderLocal') : t('settings.models.editor.apiKeyPlaceholderRequired')}
            autoComplete="off"
          />
        </Field>
        <Field label={t('settings.models.editor.contextWindowLabel')}>
          <input
            type="number"
            value={draft.contextWindow ?? 0}
            onChange={(e) => setDraft({ ...draft, contextWindow: Number(e.target.value) || undefined })}
            className="input"
            placeholder={t('settings.models.editor.contextWindowPlaceholder')}
          />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
          />
          <span>{t('settings.models.editor.enabled')}</span>
        </label>
      </div>
      <div className="flex justify-end gap-2 px-5 py-3 border-t border-border-subtle">
        <button onClick={onCancel} className="btn-ghost">{t('settings.models.editor.cancel')}</button>
        <button
          onClick={() => onSave({ ...draft, name: draft.name || draft.id })}
          className="btn-primary"
          disabled={!!idError}
        >
          {t('settings.models.editor.save')}
        </button>
      </div>
    </div>
  )
}

/* ============================================================
 * Field — 表单字段
 * ============================================================ */
function Field({
  label,
  children,
  error,
}: {
  label: string
  children: React.ReactNode
  error?: string | null
}) {
  return (
    <div>
      <label className="block text-xs text-text-secondary mb-1.5">{label}</label>
      {children}
      {error && <p className="mt-1 text-2xs text-danger">{error}</p>}
    </div>
  )
}