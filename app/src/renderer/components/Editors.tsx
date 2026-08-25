/* ============================================================
 * ArkWork — Agent / Skill / MCP Editors (v0.6.0)
 * 设计文档 §5
 *
 * 三个编辑器弹窗，store 驱动开关（agentEditorOpen / skillEditorOpen / mcpEditorOpen）。
 * 共用 Modal 容器（.dialog--wide），表单字段用 .dialog__field / .dialog__input。
 *
 * 约束：
 *  - 内置 Agent 编辑时，人格字段（systemPrompt/role/goal/backstory/name）禁用
 *  - 内置 Skill 编辑时，name/builtinHandler 禁用
 *  - 表单本地 state 初始化自 editingXxx；提交时调用 addXxx / updateXxx
 * ============================================================ */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '../store'
import { Icon } from '../icons'
import type { Agent, Skill, McpServer, BuiltinHandler } from '@shared/types/agent'

/* ============================================================
 * Modal — 共享弹窗容器
 * ============================================================ */
function Modal({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: React.ReactNode
  footer: React.ReactNode
}) {
  const { t } = useTranslation()
  // Esc 关闭
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="dialog-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      role="presentation"
    >
      <div
        className="dialog dialog--wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="editor-title"
      >
        <div className="flex items-center justify-between mb-4 flex-shrink-0">
          <div id="editor-title" className="text-base font-semibold text-text-primary">
            {title}
          </div>
          <button
            onClick={onClose}
            className="text-text-tertiary hover:text-text-primary p-1 rounded-md hover:bg-bg-hover transition-colors"
            aria-label={t('editors.close')}
          >
            <Icon.X width={16} height={16} />
          </button>
        </div>
        <div className="dialog__body">{children}</div>
        <div className="dialog__actions flex-shrink-0">{footer}</div>
      </div>
    </div>
  )
}

/* ============================================================
 * AgentEditor
 * ============================================================ */
const AVATAR_COLORS = ['#5B8DEF', '#34D399', '#FBBF24', '#F87171', '#a855f7', '#06B6D4', '#EC4899', '#10B981']

export function AgentEditor() {
  const { t } = useTranslation()
  const open = useStore((s) => s.agentEditorOpen)
  const editing = useStore((s) => s.editingAgent)
  const close = useStore((s) => s.closeAgentEditor)
  const addAgent = useStore((s) => s.addAgent)
  const updateAgent = useStore((s) => s.updateAgent)
  const skills = useStore((s) => s.skills)

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [avatarColor, setAvatarColor] = useState(AVATAR_COLORS[0])
  const [role, setRole] = useState('')
  const [goal, setGoal] = useState('')
  const [backstory, setBackstory] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [skillIds, setSkillIds] = useState<string[]>([])
  const [temperature, setTemperature] = useState('0.5')
  const [maxIterations, setMaxIterations] = useState('25')

  useEffect(() => {
    if (open) {
      setName(editing?.name ?? '')
      setDescription(editing?.description ?? '')
      setAvatarColor(editing?.avatarColor ?? AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)])
      setRole(editing?.role ?? '')
      setGoal(editing?.goal ?? '')
      setBackstory(editing?.backstory ?? '')
      setSystemPrompt(editing?.systemPrompt ?? '')
      setSkillIds(editing?.defaultSkillIds ?? [])
      setTemperature(String(editing?.defaultConfig?.temperature ?? 0.5))
      setMaxIterations(String(editing?.defaultConfig?.maxIterations ?? 25))
    }
  }, [open, editing])

  if (!open) return null

  const isBuiltin = editing?.isBuiltin ?? false
  const isEdit = !!editing

  const toggleSkill = (id: string) => {
    setSkillIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )
  }

  const handleSubmit = async () => {
    if (!name.trim()) {
      useStore.getState().pushToast({ type: 'warning', message: t('editors.agent.nameRequired'), duration: 3000 })
      return
    }
    const payload = {
      name: name.trim(),
      description: description.trim(),
      avatarColor,
      role: role.trim() || undefined,
      goal: goal.trim() || undefined,
      backstory: backstory.trim() || undefined,
      systemPrompt,
      defaultSkillIds: skillIds,
      defaultMcpIds: [],
      defaultModelId: '',
      defaultKbIds: [],
      source: 'custom' as const,
      defaultConfig: {
        temperature: Number(temperature) || 0.5,
        maxIterations: Number(maxIterations) || 25,
      },
    }
    if (isEdit && editing) {
      await updateAgent(editing.id, payload)
    } else {
      await addAgent(payload)
    }
  }

  return (
    <Modal
      open={open}
      title={isEdit ? t('editors.agent.editTitle', { builtin: isBuiltin ? t('editors.builtinSuffix') : '' }) : t('editors.agent.newTitle')}
      onClose={close}
      footer={
        <>
          <button onClick={close} className="btn-ghost">{t('editors.cancel')}</button>
          <button onClick={handleSubmit} className="btn-primary">
            {isEdit ? t('editors.save') : t('editors.create')}
          </button>
        </>
      }
    >
      <div className="dialog__field">
        <label className="dialog__field-label">{t('editors.nameLabel')}</label>
        <input
          className="dialog__input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={isBuiltin}
          placeholder={t('editors.agent.namePlaceholder')}
        />
        {isBuiltin && <span className="dialog__field-hint">{t('editors.agent.nameBuiltinHint')}</span>}
      </div>

      <div className="dialog__field">
        <label className="dialog__field-label">{t('editors.descriptionLabel')}</label>
        <input
          className="dialog__input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={isBuiltin}
          placeholder={t('editors.agent.descriptionPlaceholder')}
        />
      </div>

      <div className="dialog__field">
        <label className="dialog__field-label">{t('editors.avatarColorLabel')}</label>
        <div className="flex gap-2 flex-wrap">
          {AVATAR_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setAvatarColor(c)}
              className={`w-7 h-7 rounded-md border-2 transition-transform ${
                avatarColor === c ? 'border-text-primary scale-110' : 'border-transparent'
              }`}
              style={{ background: c }}
              aria-label={t('editors.colorAria', { color: c })}
            />
          ))}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="dialog__field" style={{ margin: 0 }}>
          <label className="dialog__field-label">{t('editors.agent.roleLabel')}</label>
          <input
            className="dialog__input"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            disabled={isBuiltin}
            placeholder={t('editors.agent.rolePlaceholder')}
          />
        </div>
        <div className="dialog__field" style={{ margin: 0 }}>
          <label className="dialog__field-label">{t('editors.agent.goalLabel')}</label>
          <input
            className="dialog__input"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            disabled={isBuiltin}
            placeholder={t('editors.agent.goalPlaceholder')}
          />
        </div>
        <div className="dialog__field" style={{ margin: 0 }}>
          <label className="dialog__field-label">{t('editors.agent.maxIterationsLabel')}</label>
          <input
            className="dialog__input"
            type="number"
            min={1}
            max={50}
            value={maxIterations}
            onChange={(e) => setMaxIterations(e.target.value)}
          />
        </div>
      </div>

      <div className="dialog__field">
        <label className="dialog__field-label">{t('editors.agent.backstoryLabel')}</label>
        <input
          className="dialog__input"
          value={backstory}
          onChange={(e) => setBackstory(e.target.value)}
          disabled={isBuiltin}
          placeholder={t('editors.agent.backstoryPlaceholder')}
        />
      </div>

      <div className="dialog__field">
        <label className="dialog__field-label">{t('editors.agent.systemPromptLabel')}</label>
        <textarea
          className="dialog__textarea"
          rows={8}
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          disabled={isBuiltin}
          placeholder={t('editors.agent.systemPromptPlaceholder')}
        />
        {isBuiltin && <span className="dialog__field-hint">{t('editors.agent.personaBuiltinHint')}</span>}
      </div>

      <div className="dialog__field">
        <label className="dialog__field-label">
          {t('editors.agent.defaultSkillsLabel', { selected: skillIds.length, total: skills.length })}
        </label>
        <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto p-2 rounded-md bg-bg-surface border border-border-subtle">
          {skills.length === 0 && (
            <span className="text-xs text-text-tertiary">{t('editors.agent.noSkills')}</span>
          )}
          {skills.filter((s) => s.enabled).map((s) => {
            const active = skillIds.includes(s.id)
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => toggleSkill(s.id)}
                className={`px-2 py-1 rounded-md text-xs font-medium transition-colors ${
                  active
                    ? 'bg-accent text-text-inverse'
                    : 'bg-bg-hover text-text-secondary hover:text-text-primary'
                }`}
              >
                {s.name}
              </button>
            )
          })}
        </div>
      </div>

      <div className="dialog__field" style={{ marginBottom: 0 }}>
        <label className="dialog__field-label">{t('editors.temperatureLabel', { value: temperature })}</label>
        <input
          type="range"
          min={0}
          max={1}
          step={0.1}
          value={temperature}
          onChange={(e) => setTemperature(e.target.value)}
          className="w-full"
        />
      </div>
    </Modal>
  )
}

/* ============================================================
 * SkillEditor
 * ============================================================ */
const BUILTIN_HANDLERS: BuiltinHandler[] = [
  'file-reader', 'web-search', 'shell', 'fetch-url',
  'task_complete', 'ask_user', 'delegate-agent',
]

export function SkillEditor() {
  const { t } = useTranslation()
  const open = useStore((s) => s.skillEditorOpen)
  const editing = useStore((s) => s.editingSkill)
  const close = useStore((s) => s.closeSkillEditor)
  const addSkill = useStore((s) => s.addSkill)
  const updateSkill = useStore((s) => s.updateSkill)
  const readInstruction = useStore((s) => s.readSkillInstruction)

  const [name, setName] = useState('')
  const [namespace, setNamespace] = useState('custom')
  const [description, setDescription] = useState('')
  const [builtinHandler, setBuiltinHandler] = useState<BuiltinHandler | ''>('')
  const [timeout, setTimeout_] = useState('30000')
  const [needsConfirmation, setNeedsConfirmation] = useState(false)
  const [tags, setTags] = useState('')
  const [inputSchema, setInputSchema] = useState('{}')
  const [instructionMd, setInstructionMd] = useState('')

  useEffect(() => {
    if (open) {
      setName(editing?.name ?? '')
      setNamespace(editing?.namespace ?? 'custom')
      setDescription(editing?.description ?? '')
      setBuiltinHandler(editing?.builtinHandler ?? '')
      setTimeout_(String(editing?.timeout ?? 30000))
      setNeedsConfirmation(editing?.needsConfirmation ?? false)
      setTags((editing?.tags ?? []).join(', '))
      setInputSchema(JSON.stringify(editing?.inputSchema ?? { type: 'object', properties: {} }, null, 2))
      setInstructionMd('')
      // 异步加载已有 SKILL.md 内容
      if (editing) {
        void readInstruction(editing.id).then((md) => {
          if (md) setInstructionMd(md)
        })
      }
    }
  }, [open, editing, readInstruction])

  if (!open) return null

  const isBuiltin = editing?.source === 'builtin'
  const isEdit = !!editing

  const handleSubmit = async () => {
    if (!name.trim()) {
      useStore.getState().pushToast({ type: 'warning', message: t('editors.skill.nameRequired'), duration: 3000 })
      return
    }
    let parsedSchema: Record<string, unknown> = { type: 'object', properties: {} }
    try {
      parsedSchema = JSON.parse(inputSchema)
    } catch {
      useStore.getState().pushToast({ type: 'warning', message: t('editors.skill.invalidSchema'), duration: 3000 })
      return
    }
    const tagArr = tags.split(',').map((t) => t.trim()).filter(Boolean)
    const basePayload = {
      name: name.trim(),
      namespace: namespace.trim() || 'custom',
      description: description.trim(),
      source: 'custom' as const,
      builtinHandler: builtinHandler || undefined,
      inputSchema: parsedSchema,
      timeout: Number(timeout) || 30000,
      needsConfirmation,
      tags: tagArr,
      enabled: true,
    }
    if (isEdit && editing) {
      await updateSkill({
        id: editing.id,
        patch: basePayload,
        instructionMdContent: instructionMd,
      })
    } else {
      await addSkill({
        ...basePayload,
        instructionMdContent: instructionMd || undefined,
      })
    }
  }

  return (
    <Modal
      open={open}
      title={isEdit ? t('editors.skill.editTitle', { builtin: isBuiltin ? t('editors.builtinSuffix') : '' }) : t('editors.skill.newTitle')}
      onClose={close}
      footer={
        <>
          <button onClick={close} className="btn-ghost">{t('editors.cancel')}</button>
          <button onClick={handleSubmit} className="btn-primary">
            {isEdit ? t('editors.save') : t('editors.create')}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <div className="dialog__field" style={{ margin: 0 }}>
          <label className="dialog__field-label">{t('editors.nameLabel')}</label>
          <input
            className="dialog__input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={isBuiltin}
            placeholder={t('editors.skill.namePlaceholder')}
          />
        </div>
        <div className="dialog__field" style={{ margin: 0 }}>
          <label className="dialog__field-label">{t('editors.namespaceLabel')}</label>
          <input
            className="dialog__input"
            value={namespace}
            onChange={(e) => setNamespace(e.target.value)}
            disabled={isBuiltin}
            placeholder={t('editors.skill.namespacePlaceholder')}
          />
        </div>
      </div>

      <div className="dialog__field" style={{ marginTop: '12px' }}>
        <label className="dialog__field-label">{t('editors.skill.descriptionLabel')}</label>
        <input
          className="dialog__input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('editors.skill.descriptionPlaceholder')}
        />
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="dialog__field" style={{ margin: 0 }}>
          <label className="dialog__field-label">{t('editors.skill.builtinHandlerLabel')}</label>
          <select
            className="dialog__select"
            value={builtinHandler}
            onChange={(e) => setBuiltinHandler(e.target.value as BuiltinHandler | '')}
            disabled={isBuiltin}
          >
            <option value="">{t('editors.skill.noBuiltinHandler')}</option>
            {BUILTIN_HANDLERS.map((h) => (
              <option key={h} value={h}>{h}</option>
            ))}
          </select>
        </div>
        <div className="dialog__field" style={{ margin: 0 }}>
          <label className="dialog__field-label">{t('editors.timeoutLabel')}</label>
          <input
            className="dialog__input"
            type="number"
            value={timeout}
            onChange={(e) => setTimeout_(e.target.value)}
          />
        </div>
        <div className="dialog__field" style={{ margin: 0 }}>
          <label className="dialog__field-label">{t('editors.skill.needsConfirmationLabel')}</label>
          <label className="flex items-center gap-2 mt-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={needsConfirmation}
              onChange={(e) => setNeedsConfirmation(e.target.checked)}
            />
            <span className="text-xs text-text-secondary">{t('editors.skill.confirmBeforeExec')}</span>
          </label>
        </div>
      </div>

      <div className="dialog__field" style={{ marginTop: '12px' }}>
        <label className="dialog__field-label">{t('editors.skill.tagsLabel')}</label>
        <input
          className="dialog__input"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder={t('editors.skill.tagsPlaceholder')}
        />
      </div>

      <div className="dialog__field">
        <label className="dialog__field-label">{t('editors.skill.inputSchemaLabel')}</label>
        <textarea
          className="dialog__textarea"
          rows={8}
          value={inputSchema}
          onChange={(e) => setInputSchema(e.target.value)}
          placeholder='{ "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] }'
        />
        <span className="dialog__field-hint">{t('editors.skill.inputSchemaHint')}</span>
      </div>

      <div className="dialog__field" style={{ marginBottom: 0 }}>
        <label className="dialog__field-label">{t('editors.skill.instructionLabel')}</label>
        <textarea
          className="dialog__textarea"
          rows={6}
          value={instructionMd}
          onChange={(e) => setInstructionMd(e.target.value)}
          placeholder={t('editors.skill.instructionPlaceholder')}
        />
        <span className="dialog__field-hint">{t('editors.skill.instructionHint')}</span>
      </div>
    </Modal>
  )
}

/* ============================================================
 * McpEditor
 * ============================================================ */
export function McpEditor() {
  const { t } = useTranslation()
  const open = useStore((s) => s.mcpEditorOpen)
  const editing = useStore((s) => s.editingMcp)
  const close = useStore((s) => s.closeMcpEditor)
  const addMcp = useStore((s) => s.addMcp)
  const updateMcp = useStore((s) => s.updateMcp)

  const [name, setName] = useState('')
  const [transport, setTransport] = useState<'stdio' | 'sse'>('stdio')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [url, setUrl] = useState('')
  const [env, setEnv] = useState('')
  const [enabled, setEnabled] = useState(true)

  useEffect(() => {
    if (open) {
      setName(editing?.name ?? '')
      setTransport(editing?.transport ?? 'stdio')
      setCommand(editing?.command ?? '')
      setArgs((editing?.args ?? []).join(' '))
      setUrl(editing?.url ?? '')
      // env 序列化为 KEY=VALUE 每行一个
      const envObj = editing?.env ?? {}
      const envLines = Object.entries(envObj).map(([k, v]) => `${k}=${v}`)
      setEnv(envLines.join('\n'))
      setEnabled(editing?.enabled ?? true)
    }
  }, [open, editing])

  if (!open) return null

  const isEdit = !!editing

  const handleSubmit = async () => {
    if (!name.trim()) {
      useStore.getState().pushToast({ type: 'warning', message: t('editors.mcp.nameRequired'), duration: 3000 })
      return
    }
    if (transport === 'stdio' && !command.trim()) {
      useStore.getState().pushToast({ type: 'warning', message: t('editors.mcp.stdioCommandRequired'), duration: 3000 })
      return
    }
    if (transport === 'sse' && !url.trim()) {
      useStore.getState().pushToast({ type: 'warning', message: t('editors.mcp.sseUrlRequired'), duration: 3000 })
      return
    }
    // 解析 env（每行 KEY=VALUE）
    const envObj: Record<string, string> = {}
    for (const line of env.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx > 0) {
        envObj[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim()
      }
    }
    const payload = {
      name: name.trim(),
      namespace: name.trim().toLowerCase().replace(/[^a-z0-9]/g, ''),
      transport,
      command: transport === 'stdio' ? command.trim() : undefined,
      args: transport === 'stdio' ? args.trim().split(/\s+/).filter(Boolean) : undefined,
      url: transport === 'sse' ? url.trim() : undefined,
      env: envObj,
      enabled,
    }
    if (isEdit && editing) {
      await updateMcp(editing.id, payload)
    } else {
      await addMcp(payload)
    }
  }

  return (
    <Modal
      open={open}
      title={isEdit ? t('editors.mcp.editTitle') : t('editors.mcp.newTitle')}
      onClose={close}
      footer={
        <>
          <button onClick={close} className="btn-ghost">{t('editors.cancel')}</button>
          <button onClick={handleSubmit} className="btn-primary">
            {isEdit ? t('editors.save') : t('editors.create')}
          </button>
        </>
      }
    >
      <div className="dialog__field">
        <label className="dialog__field-label">{t('editors.nameLabel')}</label>
        <input
          className="dialog__input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('editors.mcp.namePlaceholder')}
        />
      </div>

      <div className="dialog__field">
        <label className="dialog__field-label">{t('editors.transportLabel')}</label>
        <div className="flex gap-2">
          {(['stdio', 'sse'] as const).map((val) => (
            <button
              key={val}
              type="button"
              onClick={() => setTransport(val)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                transport === val
                  ? 'bg-accent text-text-inverse'
                  : 'bg-bg-hover text-text-secondary hover:text-text-primary'
              }`}
            >
              {val === 'stdio' ? t('editors.mcp.stdioOption') : t('editors.mcp.sseOption')}
            </button>
          ))}
        </div>
      </div>

      {transport === 'stdio' ? (
        <>
          <div className="dialog__field">
            <label className="dialog__field-label">{t('editors.commandLabel')}</label>
            <input
              className="dialog__input"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder={t('editors.mcp.commandPlaceholder')}
            />
          </div>
          <div className="dialog__field">
            <label className="dialog__field-label">{t('editors.mcp.argsLabel')}</label>
            <input
              className="dialog__input"
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder={t('editors.mcp.argsPlaceholder')}
            />
          </div>
        </>
      ) : (
        <div className="dialog__field">
          <label className="dialog__field-label">{t('editors.urlLabel')}</label>
          <input
            className="dialog__input"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={t('editors.mcp.urlPlaceholder')}
          />
        </div>
      )}

      <div className="dialog__field">
        <label className="dialog__field-label">{t('editors.mcp.envLabel')}</label>
        <textarea
          className="dialog__textarea"
          rows={4}
          value={env}
          onChange={(e) => setEnv(e.target.value)}
          placeholder={'GITHUB_PERSONAL_ACCESS_TOKEN=ghp_xxx'}
        />
        <span className="dialog__field-hint">{t('editors.mcp.envHint')}</span>
      </div>

      <div className="dialog__field" style={{ marginBottom: 0 }}>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span className="text-xs text-text-secondary">{t('editors.mcp.enableLabel')}</span>
        </label>
      </div>

      {isEdit && (
        <div className="mt-4 p-3 rounded-md bg-bg-surface border border-border-subtle text-xs text-text-tertiary leading-relaxed">
          <Icon.Info width={16} height={16} className="inline mr-1" />
          {t('editors.mcp.reloadHint')}
        </div>
      )}
    </Modal>
  )
}

/* ============================================================
 * Editors — 组合入口（挂载在 App 根节点，store 驱动开关）
 * ============================================================ */
export function Editors() {
  return (
    <>
      <AgentEditor />
      <SkillEditor />
      <McpEditor />
    </>
  )
}
