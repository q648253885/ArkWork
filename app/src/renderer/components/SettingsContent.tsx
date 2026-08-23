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
import { useStore, type SettingsTab } from '../store'
import { SectionLabel } from './ui'
import { StepList } from './right/StepList'
import { LogsView } from './right/LogsView'
import { Icon } from '../icons'
import { ark } from '../ipc/client'
import type { PermissionMode } from '@shared/types/permission'
import type { LlmModel, LlmProviderKind } from '@shared/types/agent'
import type { TestModelResult } from '@shared/types/ipc'

// polish3 §Task 2.1：删除 shortcuts Tab；总表仅 HelpCenter 内展示
const TABS: { id: SettingsTab; label: string; hint: string }[] = [
  { id: 'models',     label: '模型',     hint: '配置大模型 API' },
  { id: 'workspace',  label: '工作区',   hint: '工作区路径与隔离' },
  { id: 'knowledge',  label: '知识库',   hint: '全局启用 / 关闭知识库注入' },
  { id: 'appearance', label: '外观',     hint: '主题与预览' },
  { id: 'advanced',   label: '高级',     hint: '压缩策略 / 开发者工具' },
]

const KIND_LABELS: Record<LlmProviderKind, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  ollama: 'Ollama',
  vllm: 'vLLM',
}

const KIND_HINTS: Record<LlmProviderKind, string> = {
  openai: 'OpenAI 官方或兼容端点；baseURL 留空用官方默认',
  anthropic: 'Claude 系列模型',
  ollama: '本地 Ollama 服务，默认 http://127.0.0.1:11434/v1',
  vllm: '本地 vLLM 推理服务，OpenAI 兼容接口',
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
  const settingsTab = useStore((s) => s.settingsTab)
  const setSettingsTab = useStore((s) => s.setSettingsTab)
  const models = useStore((s) => s.models)

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 顶部 Tab 栏：与 ModulePage 头部分离，作为内容子导航 */}
      <div className="flex items-center gap-1 px-5 pt-4 flex-shrink-0 overflow-x-auto" role="tablist" aria-label="设置分区">
        {TABS.map((tab) => {
          const active = settingsTab === tab.id
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={active}
              onClick={() => setSettingsTab(tab.id)}
              title={tab.hint}
              className={`flex items-center h-8 px-3.5 rounded-md text-xs transition-colors focus-ring ${
                active
                  ? 'bg-bg-active text-text-primary font-medium'
                  : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
              }`}
            >
              {tab.label}
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
          所有修改即时生效 · 破坏性操作需二次确认
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
          <SectionLabel>全局知识库</SectionLabel>
          <span className="text-2xs text-text-tertiary">
            设置后立即生效，无需重启
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
                启用知识库注入
              </div>
              <div className="text-2xs text-text-tertiary mt-0.5 leading-relaxed">
                关闭后，Agent 调用 <code className="text-text-secondary">kb-search</code> 时将
                返回引导提示而非检索结果，Composer 上下文面板显示「知识库：未启用」。
              </div>
            </div>
          </label>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <SectionLabel>当前知识库</SectionLabel>
          <button
            onClick={() => openModulePage('kb')}
            className="flex items-center h-8 px-3 rounded-md text-xs text-accent hover:bg-accent-soft transition-colors focus-ring"
          >
            打开知识库面板
          </button>
        </div>
        <div className="rounded-md border border-border-subtle bg-bg-base p-3.5 space-y-1.5 text-xs text-text-secondary">
          <div className="flex items-center justify-between">
            <span>已索引条目</span>
            <span className="font-mono text-text-primary">{enabledCount}</span>
          </div>
          <div className="flex items-center justify-between">
            <span>解析失败</span>
            <span className={`font-mono ${failedCount > 0 ? 'text-danger' : 'text-text-tertiary'}`}>{failedCount}</span>
          </div>
          <div className="flex items-center justify-between">
            <span>条目总数</span>
            <span className="font-mono text-text-primary">{knowledgeBases.length}</span>
          </div>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <SectionLabel>会话级开关</SectionLabel>
        </div>
        <div className="rounded-md border border-border-subtle bg-bg-base p-3.5 text-xs text-text-secondary">
          会话级「知识库」开关位于 Inspector 「上下文」面板顶部，
          切换任务互不影响，关闭后仅当前会话不再注入 KB。
        </div>
      </div>
    </section>
  )
}

/* ============================================================
 * Permission Section — v0.15.0 权限模型（位于 Developer Tab 顶部）
 *  - 会话模式三选一（default / acceptEdits / plan）
 *  - 合并规则三栏（allow / ask / deny）+ 自定义 allow 规则输入
 * ============================================================ */
const PERMISSION_OPTIONS: { id: PermissionMode; label: string; desc: string }[] = [
  { id: 'default', label: '默认权限', desc: '每次执行都需确认' },
  { id: 'acceptEdits', label: '接受编辑', desc: '工作区内自动放行' },
  { id: 'plan', label: '只读权限', desc: '只读探索，写操作拒绝' },
]

const RULE_GROUPS: { key: 'allow' | 'ask' | 'deny'; label: string; cls: string; dot: string }[] = [
  { key: 'allow', label: '允许', cls: 'bg-success-soft text-success border-success', dot: 'bg-success' },
  { key: 'ask', label: '询问', cls: 'bg-warning-soft text-warning border-warning', dot: 'bg-warning' },
  { key: 'deny', label: '拒绝', cls: 'bg-danger-soft text-danger border-danger', dot: 'bg-danger' },
]

function PermissionSection() {
  const permissionMode = useStore((s) => s.permissionMode)
  const setPermissionMode = useStore((s) => s.setPermissionMode)
  const permissionRules = useStore((s) => s.permissionRules)
  const refreshPermissionRules = useStore((s) => s.refreshPermissionRules)
  const addPermissionRule = useStore((s) => s.addPermissionRule)
  const [ruleDraft, setRuleDraft] = useState('')

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
        <SectionLabel>权限</SectionLabel>
        <span className="text-2xs text-text-tertiary">Shift+Tab 快捷切换</span>
      </div>
      <div className="rounded-md border border-border-subtle bg-bg-base p-3.5 space-y-3.5">
        {/* 会话模式 segmented control */}
        <div>
          <div className="text-xs text-text-secondary mb-1.5">会话模式</div>
          <div className="flex items-center gap-0.5 rounded-md border border-border-subtle bg-bg-overlay p-0.5 w-fit">
            {PERMISSION_OPTIONS.map((opt) => {
              const active = permissionMode === opt.id
              return (
                <button
                  key={opt.id}
                  onClick={() => void setPermissionMode(opt.id)}
                  title={opt.desc}
                  className={`flex items-center min-h-8 px-3 rounded font-mono text-xs transition-colors focus-ring ${
                    active
                      ? 'bg-accent-soft text-accent font-medium'
                      : 'text-text-tertiary hover:text-text-primary hover:bg-bg-hover'
                  }`}
                >
                  {opt.label}
                </button>
              )
            })}
          </div>
          <div className="mt-1.5 text-2xs text-text-tertiary">
            {PERMISSION_OPTIONS.find((o) => o.id === permissionMode)?.desc}
          </div>
        </div>

        {/* 合并规则三栏 */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs text-text-secondary">合并规则</span>
            <span className="text-2xs text-text-tertiary">{totalRules} 条</span>
          </div>
          {totalRules === 0 ? (
            <div className="text-xs text-text-tertiary py-3 text-center bg-bg-overlay rounded-md">
              暂无自定义规则
            </div>
          ) : (
            <div className="space-y-2.5">
              {RULE_GROUPS.map((g) => {
                const items = permissionRules?.[g.key] ?? []
                return (
                  <div key={g.key}>
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${g.dot}`} />
                      <span className="text-2xs text-text-tertiary">{g.label}</span>
                      <span className="text-2xs text-text-tertiary">{items.length}</span>
                    </div>
                    {items.length === 0 ? (
                      <div className="text-2xs text-text-tertiary pl-3">无</div>
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
          <div className="text-xs text-text-secondary mb-1.5">自定义 allow 规则</div>
          <div className="flex items-center gap-2">
            <input
              value={ruleDraft}
              onChange={(e) => setRuleDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleAddRule()
              }}
              className="input flex-1"
              placeholder="Bash(npm test) 或 Bash(git diff:*)"
            />
            <button
              onClick={() => void handleAddRule()}
              disabled={!ruleDraft.trim()}
              className="flex items-center h-8 px-3 rounded-md text-xs text-accent hover:bg-accent-soft transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus-ring"
            >
              添加 allow 规则
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
  const [tab, setTab] = useState<'logs' | 'graph'>('logs')
  return (
    <section className="space-y-4">
      <PermissionSection />
      <div>
        <div className="flex items-center justify-between mb-2">
          <SectionLabel>压缩与蒸馏策略</SectionLabel>
        </div>
        <div className="rounded-md border border-border-subtle bg-bg-base p-3.5 space-y-1.5 text-xs text-text-secondary">
          <div className="flex items-center justify-between">
            <span>L1 自动压缩触发阈值</span>
            <span className="font-mono text-text-primary">80% token</span>
          </div>
          <div className="flex items-center justify-between">
            <span>压缩策略</span>
            <span className="font-mono text-text-primary">相似度 0.6 + 时间衰减 7 天</span>
          </div>
          <div className="flex items-center justify-between">
            <span>蒸馏自动触发门槛</span>
            <span className="font-mono text-text-primary">主题 10 条 / 复用 5 次 / L2 ≥ 50 条</span>
          </div>
          <div className="flex items-center justify-between">
            <span>L1/L2 临时条目时限</span>
            <span className="font-mono text-text-primary">7 天自动蒸馏清理</span>
          </div>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <SectionLabel>开发者工具</SectionLabel>
          <div className="flex items-center gap-0.5">
            {(['logs', 'graph'] as const).map((t) => {
              const active = tab === t
              return (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`flex items-center min-h-8 px-2.5 rounded-md text-xs transition-colors focus-ring ${
                    active
                      ? 'bg-bg-active text-text-primary'
                      : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
                  }`}
                >
                  {t === 'logs' ? '日志' : '图谱'}
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
      title: '移除工作区',
      body: `确定移除工作区「${name}」吗？任务数据保留在磁盘，但不再显示在此列表中。`,
      confirmLabel: '移除',
      danger: true,
    })
    if (ok) removeWorkspace(id)
  }

  const handleOpenFolder = async (path?: string) => {
    if (!path) {
      pushToast({ type: 'warning', message: '默认工作区无关联文件夹', duration: 2500 })
      return
    }
    try {
      await ark.fs.revealInFolder(path)
    } catch (e) {
      pushToast({ type: 'danger', message: `打开文件夹失败：${(e as Error).message}`, duration: 3000 })
    }
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <SectionLabel>工作区（任务与记忆按工作区隔离）</SectionLabel>
        <button
          onClick={() => void createWorkspace()}
          className="flex items-center h-8 px-3 rounded-md text-xs text-accent hover:bg-accent-soft transition-colors focus-ring"
        >
          <Icon.Plus width={16} height={16} />
          添加工作区
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
                    <span className="text-2xs px-1.5 py-0.5 rounded bg-accent text-text-inverse">当前</span>
                  )}
                  {running && <span className="text-2xs text-accent">运行中</span>}
                </div>
                <div className="flex flex-wrap items-center justify-end gap-1 flex-shrink-0">
                  <button
                    onClick={() => void handleOpenFolder(ws.path)}
                    className="flex items-center min-h-8 px-2.5 rounded text-xs text-text-secondary hover:text-text-primary hover:bg-bg-base transition-colors focus-ring"
                  >
                    打开文件夹
                  </button>
                  {!active && (
                    <button
                      onClick={() => void switchWorkspace(ws.id)}
                      className="flex items-center min-h-8 px-2.5 rounded text-xs text-text-secondary hover:text-accent hover:bg-bg-base transition-colors focus-ring"
                    >
                      切换
                    </button>
                  )}
                  {!active && ws.id !== 'default' && (
                    <button
                      onClick={() => void handleRemove(ws.id, ws.name)}
                      className="flex items-center min-h-8 px-2.5 rounded text-xs text-text-secondary hover:text-danger hover:bg-bg-base transition-colors focus-ring"
                    >
                      移除
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
            暂无工作区，点击「添加工作区」创建
          </div>
        )}
      </div>
    </section>
  )
}

/* ============================================================
 * Appearance Section — v0.4.0 主题三态切换（F101-F103）
 * ============================================================ */
const THEME_OPTIONS: { id: 'light' | 'dark' | 'system'; label: string; desc: string; icon: string }[] = [
  { id: 'light',  label: '浅色',     desc: '明亮背景，适合白天与高亮环境', icon: '☀️' },
  { id: 'dark',   label: '深色',     desc: '深色背景，护眼、降低反差',   icon: '🌙' },
  { id: 'system', label: '跟随系统', desc: '自动跟随操作系统的浅深设置',  icon: '💻' },
]

function AppearanceSection() {
  const theme = useStore((s) => s.theme)
  const resolvedTheme = useStore((s) => s.resolvedTheme)
  const setTheme = useStore((s) => s.setTheme)

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <SectionLabel>外观</SectionLabel>
        <span className="text-2xs text-text-tertiary">
          当前实际：{resolvedTheme === 'dark' ? '深色' : '浅色'}
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
                {opt.label}
              </span>
              <span className="text-2xs text-text-tertiary leading-relaxed">{opt.desc}</span>
            </button>
          )
        })}
      </div>

      {/* 预览区 */}
      <div className="mt-4 rounded-lg border border-border-subtle bg-bg-overlay p-4">
        <div className="text-2xs text-text-tertiary uppercase tracking-wider mb-2">预览</div>
        <div className="rounded-md bg-bg-base border border-border-subtle p-3.5 space-y-2.5">
          <div className="text-sm text-text-primary">这是一段正文文字，用于预览当前主题的对比度。</div>
          <div className="text-xs text-text-secondary">这是次级文字，用于辅助说明。</div>
          <div className="text-2xs text-text-tertiary">这是元信息文字（时间戳、徽章）。</div>
          <div className="flex items-center gap-2 pt-1">
            <span className="px-2.5 py-1 rounded-md bg-accent text-text-inverse text-xs">主按钮</span>
            <span className="px-2.5 py-1 rounded-md border border-border-default text-text-secondary text-xs">次按钮</span>
            <span className="px-2 py-0.5 rounded bg-success-soft text-success text-2xs">成功</span>
            <span className="px-2 py-0.5 rounded bg-warning-soft text-warning text-2xs">警告</span>
            <span className="px-2 py-0.5 rounded bg-danger-soft text-danger text-2xs">错误</span>
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
    setTestResult((r) => ({ ...r, [m.id]: { ok: false, message: '测试中…' } }))
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
      title: '删除模型',
      body: `确定删除模型「${m.name || m.id}」吗？此操作不可撤销。`,
      confirmLabel: '删除',
      danger: true,
    })
    if (ok) await removeModel(m.id)
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <SectionLabel>大模型配置</SectionLabel>
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
          + 添加
        </button>
      </div>

      <div className="space-y-2">
        {models.length === 0 && (
          <div className="text-sm text-text-tertiary py-8 text-center bg-bg-overlay rounded-md">
            暂无模型配置，点击「添加」创建
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
                  {testing === m.id ? '测试中…' : '测试'}
                </button>
                <button
                  onClick={() => setEditing(m)}
                  className="flex items-center min-h-8 px-2.5 rounded text-xs text-text-secondary hover:text-text-primary hover:bg-bg-base transition-colors focus-ring"
                >
                  编辑
                </button>
                <button
                  onClick={() => void handleRemove(m)}
                  className="flex items-center min-h-8 px-2.5 rounded text-xs text-text-secondary hover:text-danger hover:bg-bg-base transition-colors focus-ring"
                >
                  删除
                </button>
              </div>
            </div>
            <div className="text-xs text-text-tertiary space-y-0.5">
              <div>
                model id: <code className="text-text-secondary">{m.id}</code>
              </div>
              <div>
                url: <code className="text-text-secondary">{m.baseURL || '默认（官方端点）'}</code>
              </div>
              <div>
                apiKey: {m.apiKey ? `已配置（${m.apiKey.slice(0, 6)}…）` : <span className="italic">未配置</span>}
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
                    可用模型: {testResult[m.id].models!.slice(0, 5).join(', ')}
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
  const isEdit = !!model.id
  const [draft, setDraft] = useState<LlmModel>(model)

  const idError = !draft.id
    ? '请填写 Model ID'
    : !isEdit && existingIds.has(draft.id)
      ? '该 ID 已存在，请更换'
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
          {isEdit ? '编辑' : '新建'}模型配置
        </h3>
      </div>
      <div className="px-5 py-4 space-y-3">
        <Field label="Model ID（发送给 API 的值）" error={idError}>
          <input
            value={draft.id}
            onChange={(e) => setDraft({ ...draft, id: e.target.value })}
            className={`input ${idError ? 'border-danger' : ''}`}
            placeholder="如 gpt-4o-mini、llama3.1、claude-3-5-sonnet"
            disabled={isEdit}
          />
        </Field>
        <Field label="显示名（可选）">
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            className="input"
            placeholder="留空则用 model id"
          />
        </Field>
        <Field label="协议类型">
          <select value={draft.kind} onChange={(e) => onKindChange(e.target.value as LlmProviderKind)} className="input">
            {Object.entries(KIND_LABELS).map(([k, label]) => (
              <option key={k} value={k}>{label}</option>
            ))}
          </select>
          <p className="text-2xs text-text-tertiary mt-1">{KIND_HINTS[draft.kind]}</p>
        </Field>
        <Field label="Base URL">
          <input
            value={draft.baseURL ?? ''}
            onChange={(e) => setDraft({ ...draft, baseURL: e.target.value })}
            className="input"
            placeholder={draft.kind === 'openai' ? '留空使用 OpenAI 官方默认' : '如 http://127.0.0.1:8000/v1'}
          />
        </Field>
        <Field label="API Key">
          <input
            type="password"
            value={draft.apiKey ?? ''}
            onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
            className="input"
            placeholder={draft.kind === 'ollama' || draft.kind === 'vllm' ? '本地服务可留空' : '必填'}
            autoComplete="off"
          />
        </Field>
        <Field label="Context Window（可选）">
          <input
            type="number"
            value={draft.contextWindow ?? 0}
            onChange={(e) => setDraft({ ...draft, contextWindow: Number(e.target.value) || undefined })}
            className="input"
            placeholder="如 128000"
          />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
          />
          <span>启用</span>
        </label>
      </div>
      <div className="flex justify-end gap-2 px-5 py-3 border-t border-border-subtle">
        <button onClick={onCancel} className="btn-ghost">取消</button>
        <button
          onClick={() => onSave({ ...draft, name: draft.name || draft.id })}
          className="btn-primary"
          disabled={!!idError}
        >
          保存
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