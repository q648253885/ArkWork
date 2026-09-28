/* ============================================================
 * ArkWork — 新建工作台向导（v0.36.0 · F5.3）
 * 设计文档：docs/versions/v0.36.0/03-interaction.md §3 流程 4 + §4 P1
 *          docs/versions/v0.36.0/04-system-design.md §3.7（F5.3）
 *
 * 为什么要有向导（用户实测诉求原文：「不想填十几个插槽字段」）：
 * 编辑抽屉是**改造已有台**的正确形态（字段全、可微调），但从零建台时
 * 它把「必须先想清楚 manifest 长什么样」这个负担丢给了用户。
 * 向导把这条路压成四步、每步只问一件事：
 *
 *   ① 模板（通用 / 代码 / 研究）→ ② 智能体（单选）→ ③ 插件与技能（多选）
 *   → ④ 命名 → 完成
 *
 * 「ProfileEditor 复用」的落地口径（设计 §3.7 原文）：
 *   · **模板 = 克隆三内置的预设 patch** —— 选模板即 `profile:clone` 一个内置台，
 *     因此不需要在向导里重新拼 manifest；
 *   · 序列化层复用编辑器的 `draftOf()` / `patchOf()`（同一份字段映射），
 *     向导只负责收集选择、把它们喂进同一根管道；
 *   · 落盘仍走 `profile:update` → 与导入/编辑**完全同一条校验管道**，
 *     不存在「向导能建、激活挂掉」这种只在最后一步暴露的错。
 *
 * 事务纪律：**到第 4 步才真正落盘**（前三步只改内存态）。中途退出不留半个台。
 * ============================================================ */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon, type IconName } from '../../icons'
import { useStore } from '../../store'
import { ark } from '../../ipc/client'
import type { PluginSummary } from '@shared/types/plugin'
import { ValidationIssuesView } from './ActivationReportView'
import { capKey, draftOf, patchOf, type Draft } from './ProfileEditor'
import type { ValidationIssue } from '@shared/types/profile'

/** 四个步骤（顺序即渲染顺序，显式数组 —— 不依赖对象键序） */
export const WIZARD_STEPS = ['template', 'agent', 'capabilities', 'name'] as const
export type WizardStep = (typeof WIZARD_STEPS)[number]

/** 模板 → 内置台 id（三内置，回退恒存在） */
const TEMPLATES: Array<{ id: string; icon: IconName }> = [
  { id: 'wb.base', icon: 'Sparkle' },
  { id: 'wb.coding', icon: 'Terminal' },
  { id: 'wb.research', icon: 'Book' },
]

export function ProfileWizard({
  plugins,
  onClose,
  onCreated,
}: {
  plugins: PluginSummary[]
  onClose: () => void
  onCreated: () => Promise<void> | void
}) {
  const { t } = useTranslation()
  const profiles = useStore((s) => s.profiles)
  const pushToast = useStore((s) => s.pushToast)

  const [step, setStep] = useState<WizardStep>('template')
  const [templateId, setTemplateId] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [name, setName] = useState('')
  const [newId, setNewId] = useState('')
  const [loading, setLoading] = useState(false)
  const [issues, setIssues] = useState<ValidationIssue[]>([])

  const stepIndex = WIZARD_STEPS.indexOf(step)

  /** 选模板 = 取回内置台字面量并喂进编辑器的序列化层（复用，不重写映射） */
  const pickTemplate = useCallback(
    async (id: string) => {
      setTemplateId(id)
      setLoading(true)
      setIssues([])
      try {
        const res = await ark.profile.export({ id })
        if (!res.ok) {
          setIssues([{ rule: 'V1', level: 'error', path: '$.id', message: t('workbench.wizard.loadFailed'), fix: '' }])
          return
        }
        const d = draftOf(JSON.parse(res.json))
        setDraft(d)
        const tpl = profiles.find((p) => p.id === id)
        setName(tpl ? `${tpl.name} 副本` : id)
        setNewId(`${id}.${Date.now().toString(36)}`)
      } finally {
        setLoading(false)
      }
    },
    [profiles, t],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  /** ④ 完成：克隆内置台 → 同一根管道 update → 激活 */
  const finish = async () => {
    if (!draft) return
    setLoading(true)
    setIssues([])
    try {
      const clone = await ark.profile.clone({ fromId: templateId, newId: newId.trim(), newName: name.trim() })
      if (!clone.ok) {
        setIssues(
          clone.issues.length > 0
            ? clone.issues
            : [{ rule: 'V1', level: 'error', path: '$.id', message: t(`workbench.editor.cloneFail.${clone.reason ?? 'invalid'}`), fix: '' }],
        )
        return
      }
      const res = await ark.profile.update({ id: newId.trim(), patch: patchOf({ ...draft, name: name.trim() }) })
      if (!res.ok) {
        setIssues(res.issues)
        if (!res.issues.length) {
          pushToast({ type: 'warning', message: t('workbench.wizard.createFailed'), duration: 5000 })
        }
        return
      }
      await ark.profile.activate({ id: newId.trim() })
      await onCreated()
      pushToast({ type: 'success', message: t('workbench.wizard.created', { name: name.trim() }), duration: 4000 })
      onClose()
    } finally {
      setLoading(false)
    }
  }

  const pluginPanels = plugins.filter((p) => p.enabled && p.panelRefs.length > 0)
  const pluginViews = plugins.filter((p) => p.enabled && p.viewRefs.length > 0)
  const canNext =
    step === 'template'
      ? Boolean(templateId && draft)
      : step === 'agent'
        ? // v0.36.0（B11/P3-c）：agent 可选 —— 不绑定也能建台（空 agents 仅 warning）
          Boolean(draft)
        : step === 'capabilities'
          ? true
          : Boolean(name.trim() && /^[a-z0-9-]+\.[a-z0-9-]+$/.test(newId.trim()))

  const scopeLabel = (s: PluginSummary['source']): string =>
    s === 'bundled'
      ? t('workbench.plugins.sourceBundled')
      : s === 'workspace'
        ? t('workbench.plugins.scopeWorkspace')
        : t('workbench.plugins.scopeGlobal')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" role="dialog" aria-modal="true" aria-label={t('workbench.wizard.title')}>
      <div className="absolute inset-0 bg-bg-overlay" onClick={onClose} />
      <div className="relative w-[560px] max-h-[80vh] rounded-xl border border-border-default bg-bg-base shadow-lg flex flex-col">
        <header className="flex items-center gap-2 h-12 px-4 border-b border-border-subtle flex-shrink-0">
          <Icon.Sparkle width={15} height={15} className="text-accent flex-shrink-0" aria-hidden />
          <div className="text-xs font-medium text-text-primary flex-1">{t('workbench.wizard.title')}</div>
          <button onClick={onClose} aria-label={t('workbench.editor.close')} className="w-8 h-8 flex items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary focus-ring">
            <Icon.X width={15} height={15} />
          </button>
        </header>

        {/* 步进条：显式四步（≤4 是设计约束，不是巧合） */}
        <ol data-testid="wizard-steps" className="flex items-center gap-1 px-4 py-2 border-b border-border-subtle flex-shrink-0">
          {WIZARD_STEPS.map((x, i) => (
            <li key={x} className="flex items-center gap-1" data-step={x} data-active={x === step ? 'true' : 'false'}>
              <span
                className={`inline-flex items-center justify-center w-4 h-4 rounded-full text-2xs ${i <= stepIndex ? 'bg-accent text-text-inverse' : 'bg-bg-surface text-text-faint border border-border-subtle'}`}
                aria-hidden
              >
                {i + 1}
              </span>
              <span className={`text-2xs ${x === step ? 'text-text-primary' : 'text-text-faint'}`}>
                {t(`workbench.wizard.step.${x}`)}
              </span>
              {i < WIZARD_STEPS.length - 1 && <Icon.ChevronRight width={10} height={10} className="text-text-faint" aria-hidden />}
            </li>
          ))}
        </ol>

        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
          {/* ① 模板 */}
          {step === 'template' && (
            <div className="space-y-2">
              <p className="text-2xs text-text-faint">{t('workbench.wizard.templateHint')}</p>
              <ul className="space-y-1.5">
                {TEMPLATES.map((tp) => {
                  const meta = profiles.find((p) => p.id === tp.id)
                  const IconCmp = Icon[tp.icon]
                  const on = templateId === tp.id
                  return (
                    <li key={tp.id}>
                      <button
                        type="button"
                        data-template={tp.id}
                        onClick={() => void pickTemplate(tp.id)}
                        className={`w-full text-left flex items-start gap-2.5 rounded-lg border px-3 py-2 focus-ring ${on ? 'border-accent bg-accent-soft' : 'border-border-subtle bg-bg-surface hover:bg-bg-hover'}`}
                      >
                        <IconCmp width={16} height={16} className={`mt-0.5 flex-shrink-0 ${on ? 'text-accent' : 'text-text-tertiary'}`} aria-hidden />
                        <span className="min-w-0 flex-1">
                          <span className="block text-xs text-text-primary truncate">{meta?.name ?? tp.id}</span>
                          {meta?.description && <span className="block text-2xs text-text-tertiary mt-0.5">{meta.description}</span>}
                        </span>
                        {on && <Icon.Check width={13} height={13} className="text-accent flex-shrink-0 mt-0.5" aria-hidden />}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          {/* ② 智能体 */}
          {step === 'agent' && draft && (
            <div className="space-y-2">
              <p className="text-2xs text-text-faint">{t('workbench.wizard.agentHint')}</p>
              <ul className="space-y-1">
                {draft.agentsRaw.map((a) => (
                  <li key={a.id} className="flex items-center gap-2 rounded-md border border-border-subtle bg-bg-surface px-2.5 py-1.5">
                    <input
                      type="radio"
                      name="wizard-agent"
                      data-agent={a.id}
                      checked={draft.agentDefault === a.id}
                      onChange={() => setDraft({ ...draft, agentDefault: a.id, agentOn: [a.id] })}
                    />
                    <span className="text-xs text-text-primary font-mono">{a.id}</span>
                    {a.name && <span className="text-2xs text-text-tertiary truncate">{a.name}</span>}
                  </li>
                ))}
                {draft.agentsRaw.length === 0 && <li className="text-2xs text-text-faint">{t('workbench.editor.noAgents')}</li>}
              </ul>
              {/* v0.36.0（B11/P3-c）：agent 可选 —— 显式「不绑定」出口（radio 只能换选
                  不能取消的问题修复）；不绑定 = agents: []，manifest 校验仅 warning */}
              <label className="flex items-center gap-2 rounded-md border border-border-subtle bg-bg-surface px-2.5 py-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="wizard-agent"
                  data-agent="none"
                  checked={!draft.agentDefault}
                  onChange={() => setDraft({ ...draft, agentDefault: '', agentOn: [] })}
                />
                <span className="text-xs text-text-primary">{t('workbench.wizard.noAgent')}</span>
                <span className="text-2xs text-text-tertiary truncate">{t('workbench.wizard.noAgentHint')}</span>
              </label>
            </div>
          )}

          {/* ③ 插件与技能 */}
          {step === 'capabilities' && draft && (
            <div className="space-y-2">
              <p className="text-2xs text-text-faint">{t('workbench.wizard.capHint')}</p>
              {pluginPanels.length === 0 && pluginViews.length === 0 ? (
                <p className="text-2xs text-text-faint">{t('workbench.editor.noPlugins')}</p>
              ) : (
                <ul className="space-y-1">
                  {[...pluginPanels, ...pluginViews].flatMap((p) =>
                    [...p.panelRefs, ...p.viewRefs].map((ref) => (
                      <li key={`${p.id}:${ref}`} className="flex items-center gap-2 rounded-md border border-border-subtle bg-bg-surface px-2.5 py-1.5">
                        <input
                          type="checkbox"
                          id={`wz-${ref}`}
                          data-wizard-cap={ref}
                          checked={draft.capsOn.includes(capKey('panel', ref))}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              capsOn: e.target.checked
                                ? [...draft.capsOn, capKey('panel', ref)]
                                : draft.capsOn.filter((k) => k !== capKey('panel', ref)),
                            })
                          }
                        />
                        <label htmlFor={`wz-${ref}`} className="text-xs text-text-primary font-mono flex-1 truncate cursor-pointer">
                          {ref}
                        </label>
                        <span className="text-2xs text-text-faint border border-border-subtle rounded px-1 leading-4 flex-shrink-0">
                          {scopeLabel(p.source)}
                        </span>
                      </li>
                    )),
                  )}
                </ul>
              )}
            </div>
          )}

          {/* ④ 命名 */}
          {step === 'name' && (
            <div className="space-y-3">
              <div>
                <label className="block text-2xs text-text-tertiary mb-1" htmlFor="wz-name">{t('workbench.wizard.nameLabel')}</label>
                <input
                  id="wz-name"
                  data-testid="wizard-name"
                  className="w-full h-8 px-2.5 rounded-md bg-bg-input border border-border-subtle text-xs text-text-primary focus-ring outline-none"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-2xs text-text-tertiary mb-1" htmlFor="wz-id">{t('workbench.wizard.idLabel')}</label>
                <input
                  id="wz-id"
                  data-testid="wizard-id"
                  className="w-full h-8 px-2.5 rounded-md bg-bg-input border border-border-subtle text-xs text-text-primary font-mono focus-ring outline-none"
                  value={newId}
                  onChange={(e) => setNewId(e.target.value)}
                />
                <p className="text-2xs text-text-faint mt-1">{t('workbench.wizard.idHint')}</p>
              </div>
            </div>
          )}

          {issues.length > 0 && (
            <section>
              <div className="text-2xs font-medium text-danger mb-1.5">{t('workbench.editor.saveIssues')}</div>
              <ValidationIssuesView issues={issues} />
            </section>
          )}
        </div>

        <footer className="flex items-center gap-2 h-14 px-4 border-t border-border-subtle flex-shrink-0">
          <button
            type="button"
            disabled={stepIndex === 0 || loading}
            onClick={() => setStep(WIZARD_STEPS[stepIndex - 1]!)}
            className="h-8 px-3 rounded-md border border-border-subtle text-xs text-text-secondary hover:bg-bg-hover disabled:opacity-40 focus-ring"
          >
            {t('workbench.wizard.back')}
          </button>
          <div className="flex-1" />
          {step !== 'name' ? (
            <button
              type="button"
              data-testid="wizard-next"
              disabled={!canNext || loading}
              onClick={() => setStep(WIZARD_STEPS[stepIndex + 1]!)}
              className="h-8 px-3 rounded-md bg-business-primary text-text-inverse text-xs hover:bg-business-primary-hover disabled:opacity-50 focus-ring"
            >
              {t('workbench.wizard.next')}
            </button>
          ) : (
            <button
              type="button"
              data-testid="wizard-finish"
              disabled={!canNext || loading}
              onClick={() => void finish()}
              className="h-8 px-3 rounded-md bg-business-primary text-text-inverse text-xs hover:bg-business-primary-hover disabled:opacity-50 focus-ring"
            >
              {loading ? t('workbench.wizard.creating') : t('workbench.wizard.finish')}
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}
