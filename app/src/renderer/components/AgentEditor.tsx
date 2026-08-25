/* ============================================================
 * ArkWork — AgentEditor (v0.8.0 F823)
 * 智能体编辑器弹窗 — Props 驱动：agent=null 新建，agent 非空 编辑
 * 设计文档 F823 §6
 * ============================================================ */
import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon, type IconName } from '../icons'
import { useStore } from '../store'
import type { Agent } from '@shared/types/agent'
import { SIDEBAR_WIDGETS, DEFAULT_SIDEBAR_WIDGET_IDS } from './sidebarRegistry'

const AVATAR_COLORS = [
  '#5B8DEF', '#34D399', '#FBBF24', '#F87171',
  '#a855f7', '#06B6D4', '#EC4899', '#10B981',
]

const INPUT_CLS =
  'w-full bg-bg-input border border-border-subtle rounded-md px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent transition-colors'
const LABEL_CLS = 'text-xs text-text-tertiary block mb-1.5'

interface AgentEditorProps {
  agent: Agent | null // null = 新建
  onClose: () => void
}

export function AgentEditor({ agent, onClose }: AgentEditorProps) {
  const { t } = useTranslation()
  const addAgent = useStore((s) => s.addAgent)
  const updateAgent = useStore((s) => s.updateAgent)
  const skills = useStore((s) => s.skills)
  const models = useStore((s) => s.models)
  const pushToast = useStore((s) => s.pushToast)

  const isEdit = !!agent
  const isBuiltin = !!agent?.isBuiltin

  const [name, setName] = useState(agent?.name ?? '')
  const [description, setDescription] = useState(agent?.description ?? '')
  const [avatarColor, setAvatarColor] = useState(agent?.avatarColor ?? AVATAR_COLORS[0])
  const [modelId, setModelId] = useState(agent?.defaultModelId ?? '')
  const [role, setRole] = useState(agent?.role ?? '')
  const [goal, setGoal] = useState(agent?.goal ?? '')
  const [backstory, setBackstory] = useState(agent?.backstory ?? '')
  const [styleGuide, setStyleGuide] = useState(agent?.styleGuide ?? '')
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt ?? '')
  const [skillIds, setSkillIds] = useState<string[]>(agent?.defaultSkillIds ?? [])
  const [useProfile, setUseProfile] = useState(agent?.memoryScope?.useProfile ?? true)
  const [skillMemory, setSkillMemory] = useState(agent?.memoryScope?.skillMemory ?? true)
  // Task 2：可组合侧边栏 — 启用的右侧 widget id 列表（缺省 = 注册表 defaultEnabled 集合）
  const [sidebarWidgetIds, setSidebarWidgetIds] = useState<string[]>(
    agent?.enabledSidebarWidgetIds ?? DEFAULT_SIDEBAR_WIDGET_IDS,
  )

  // Esc 关闭
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const toggleSkill = (id: string) => {
    setSkillIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )
  }

  const toggleSidebarWidget = (id: string) => {
    setSidebarWidgetIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )
  }

  const handleSave = async () => {
    if (!name.trim()) {
      pushToast({ type: 'warning', message: t('agentEditor.nameRequired'), duration: 3000 })
      return
    }
    // 内置 Agent 名称不可改；自定义 Agent 新建时用输入名
    const payload = {
      name: isBuiltin ? agent!.name : name.trim(),
      description: description.trim(),
      avatarColor,
      role: role.trim() || undefined,
      goal: goal.trim() || undefined,
      backstory: backstory.trim() || undefined,
      styleGuide: styleGuide.trim() || undefined,
      systemPrompt,
      defaultSkillIds: skillIds,
      defaultMcpIds: agent?.defaultMcpIds ?? [],
      defaultModelId: modelId,
      defaultKbIds: agent?.defaultKbIds ?? [],
      defaultConfig: agent?.defaultConfig ?? { temperature: 0.5, maxIterations: 25 },
      source: 'custom' as const,
      memoryScope: {
        useProfile,
        curatedKeys: agent?.memoryScope?.curatedKeys,
        skillMemory,
      },
      // Task 2：持久化启用的右侧侧边栏 widget 列表
      enabledSidebarWidgetIds: sidebarWidgetIds,
    }
    // v0.8.0：内置 Agent 可直接编辑（走 updateAgent）；自定义 Agent 新建走 addAgent
    const ok = isEdit && agent
      ? await updateAgent(agent.id, payload)
      : await addAgent(payload)
    if (ok) onClose()
  }

  // v0.8.0：技能列表显示所有已安装技能（含禁用）；内置 Agent 的固有技能集合
  const allSkills = skills
  const enabledModels = models.filter((m) => m.enabled)
  // 内置 Agent 编辑时，原有 defaultSkillIds 为固有技能（不可取消勾选）
  const intrinsicSkillIds = isBuiltin ? new Set(agent?.defaultSkillIds ?? []) : new Set<string>()

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg-overlay p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      role="presentation"
    >
      <div
        className="w-full max-w-2xl bg-bg-surface border border-border-subtle rounded-lg shadow-xl flex flex-col max-h-[90vh]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-editor-title"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle flex-shrink-0">
          <div className="flex items-center gap-2">
            <Icon.Bot width={16} height={16} className="text-accent" />
            <h2 id="agent-editor-title" className="text-base font-semibold text-text-primary">
              {isEdit ? t('agentEditor.titleEdit') : t('agentEditor.titleNew')}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="text-text-tertiary hover:text-text-primary p-1 rounded-md hover:bg-bg-hover transition-colors"
            aria-label={t('common.close')}
          >
            <Icon.X width={16} height={16} />
          </button>
        </div>

        {/* Body (scrollable) */}
        <div className="px-5 py-4 overflow-y-auto flex-1 space-y-4">
          {isBuiltin && (
            <div className="flex items-start gap-2 p-3 rounded-md bg-bg-elevated border border-border-subtle text-xs text-text-tertiary leading-relaxed">
              <Icon.Lock width={16} height={16} className="text-accent flex-shrink-0 mt-0.5" />
              <span>{t('agentEditor.builtinNotice')}</span>
            </div>
          )}

          {/* Avatar color */}
          <div>
            <label className={LABEL_CLS}>{t('agentEditor.avatarColor')}</label>
            <div className="flex gap-2 flex-wrap">
              {AVATAR_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setAvatarColor(c)}
                  className={`w-7 h-7 rounded-md border-2 flex items-center justify-center transition-transform ${
                    avatarColor === c ? 'border-text-primary scale-110' : 'border-transparent'
                  }`}
                  style={{ background: c }}
                  aria-label={t('agentEditor.colorAria', { color: c })}
                >
                  {avatarColor === c && (
                    <Icon.Check width={16} height={16} className="text-white" />
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Name */}
          <div>
            <label className={LABEL_CLS}>{t('agentEditor.nameLabel')}</label>
            <input
              className={INPUT_CLS}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('agentEditor.namePlaceholder')}
            />
          </div>

          {/* Model */}
          <div>
            <label className={LABEL_CLS}>{t('agentEditor.defaultModel')}</label>
            <select
              className={INPUT_CLS}
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
            >
              <option value="">{t('agentEditor.selectModelPlaceholder')}</option>
              {enabledModels.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
            {enabledModels.length === 0 && (
              <span className="text-xs text-text-tertiary mt-1 block">
                {t('agentEditor.noModelsEnabled')}
              </span>
            )}
          </div>

          {/* Description */}
          <div>
            <label className={LABEL_CLS}>{t('agentEditor.description')}</label>
            <input
              className={INPUT_CLS}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('agentEditor.descriptionPlaceholder')}
            />
          </div>

          {/* Role / Goal / Backstory / StyleGuide */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL_CLS}>{t('agentEditor.role')}</label>
              <input
                className={INPUT_CLS}
                value={role}
                onChange={(e) => setRole(e.target.value)}
                placeholder={t('agentEditor.rolePlaceholder')}
              />
            </div>
            <div>
              <label className={LABEL_CLS}>{t('agentEditor.goal')}</label>
              <input
                className={INPUT_CLS}
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder={t('agentEditor.goalPlaceholder')}
              />
            </div>
            <div>
              <label className={LABEL_CLS}>{t('agentEditor.backstory')}</label>
              <input
                className={INPUT_CLS}
                value={backstory}
                onChange={(e) => setBackstory(e.target.value)}
                placeholder={t('agentEditor.backstoryPlaceholder')}
              />
            </div>
            <div>
              <label className={LABEL_CLS}>{t('agentEditor.styleGuide')}</label>
              <input
                className={INPUT_CLS}
                value={styleGuide}
                onChange={(e) => setStyleGuide(e.target.value)}
                placeholder={t('agentEditor.styleGuidePlaceholder')}
              />
            </div>
          </div>

          {/* System Prompt */}
          <div>
            <label className={LABEL_CLS}>System Prompt</label>
            <textarea
              className={`${INPUT_CLS} resize-y`}
              rows={8}
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder={t('agentEditor.systemPromptPlaceholder')}
            />
          </div>

          {/* Skill cluster (固有能力) */}
          <div>
            <label className={LABEL_CLS}>
              {t('agentEditor.skillsLabel', { enabled: skillIds.length, total: allSkills.length })}
            </label>
            <div className="border border-border-subtle rounded-md max-h-56 overflow-y-auto divide-y divide-border-subtle">
              {allSkills.length === 0 && (
                <div className="px-3 py-3 text-xs text-text-tertiary">{t('agentEditor.noSkills')}</div>
              )}
              {allSkills.map((s) => {
                const active = skillIds.includes(s.id)
                const intrinsic = intrinsicSkillIds.has(s.id)
                return (
                  <label
                    key={s.id}
                    className={`flex items-start gap-2.5 px-3 py-2 ${intrinsic ? 'cursor-not-allowed bg-bg-elevated' : 'cursor-pointer hover:bg-bg-hover'}`}
                  >
                    <input
                      type="checkbox"
                      checked={active}
                      disabled={intrinsic}
                      onChange={() => !intrinsic && toggleSkill(s.id)}
                      className="mt-0.5 accent-accent"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm text-text-primary">{s.name}</span>
                        {intrinsic && (
                          <span className="flex items-center gap-0.5 text-2xs text-text-tertiary">
                            <Icon.Lock width={16} height={16} />
                            {t('agentEditor.intrinsicTag')}
                          </span>
                        )}
                        {!s.enabled && (
                          <span className="text-2xs px-1 py-0 rounded bg-bg-hover text-text-tertiary">{t('agentEditor.disabledTag')}</span>
                        )}
                      </div>
                      {s.description && (
                        <div className="text-xs text-text-tertiary truncate">
                          {s.description}
                        </div>
                      )}
                    </div>
                  </label>
                )
              })}
            </div>
          </div>

          {/* Sidebar widgets (侧边栏组件) — Task 2：可组合右侧面板 */}
          <div>
            <label className={LABEL_CLS}>
              {t('agentEditor.sidebarWidgetsLabel', { enabled: sidebarWidgetIds.length, total: SIDEBAR_WIDGETS.length })}
            </label>
            <div className="border border-border-subtle rounded-md max-h-48 overflow-y-auto divide-y divide-border-subtle">
              {SIDEBAR_WIDGETS.map((w) => {
                const active = sidebarWidgetIds.includes(w.widgetId)
                const IconComp = Icon[w.icon as IconName]
                return (
                  <label
                    key={w.widgetId}
                    className="flex items-start gap-2.5 px-3 py-2 cursor-pointer hover:bg-bg-hover"
                  >
                    <input
                      type="checkbox"
                      checked={active}
                      onChange={() => toggleSidebarWidget(w.widgetId)}
                      className="mt-0.5 accent-accent"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        {IconComp && <IconComp width={14} height={14} className="text-text-tertiary" />}
                        <span className="text-sm text-text-primary">{w.name}</span>
                        {!w.dockTabId && (
                          <span className="text-2xs px-1 py-0 rounded bg-bg-hover text-text-tertiary">
                            {t('agentEditor.extensionPointTag')}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-text-tertiary">
                        {w.dockTabId
                          ? t('agentEditor.dockTabDesc')
                          : t('agentEditor.extensionPointDesc')}
                      </div>
                    </div>
                  </label>
                )
              })}
            </div>
          </div>

          {/* Memory scope (记忆域) */}
          <div>
            <label className={LABEL_CLS}>{t('agentEditor.memoryScope')}</label>
            <div className="space-y-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={useProfile}
                  onChange={(e) => setUseProfile(e.target.checked)}
                  className="accent-accent"
                />
                <span className="text-sm text-text-primary">{t('agentEditor.memoryProfile')}</span>
                <span className="text-xs text-text-tertiary">— {t('agentEditor.memoryProfileDesc')}</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={skillMemory}
                  onChange={(e) => setSkillMemory(e.target.checked)}
                  className="accent-accent"
                />
                <span className="text-sm text-text-primary">{t('agentEditor.memorySkill')}</span>
                <span className="text-xs text-text-tertiary">— {t('agentEditor.memorySkillDesc')}</span>
              </label>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border-subtle flex-shrink-0">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-sm text-text-secondary border border-border-default hover:bg-bg-hover transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleSave}
            className="px-3 py-1.5 rounded-md text-sm bg-accent hover:bg-accent-hover text-text-inverse transition-colors"
          >
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
