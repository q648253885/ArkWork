/* ============================================================
 * ArkWork — 工作台编辑抽屉（v0.33.0 建 · v0.36.0 两组化）
 * 设计文档：docs/versions/v0.36.0/03-interaction.md §4 P1（重构）
 *          docs/versions/v0.36.0/04-system-design.md §3.7（F5.2）
 *          （上游 v0.33.0/02-prd.md §3.2 / 03-interaction.md §「编辑抽屉」）
 *
 * 契约：
 *  ① **读写同一条管道** —— 打开时用 `profile:export` 取回 manifest 字面量，
 *     保存时用 `profile:update`（主进程复用与导入完全相同的校验管道），
 *     因此「编辑器里能存」与「激活能过」永远同一个标准；
 *  ② **内置台只读** —— 编辑内置台必须先克隆（`profile:update` 侧也会拒），
 *     这里在 UI 上就把它变成一等路径：按钮叫「克隆并编辑」；
 *  ③ **校验前置可见** —— 保存失败时把 `issues` 逐条回填在抽屉底部，
 *     不做「静默不保存」。
 *
 * ★ v0.36.0（F5.2）两组化 —— 用户实测诉求原文：「不想填十几个插槽字段」：
 *   · **基础（默认可见）＝ 用户真正要决定的三件事**：
 *     ① 用哪个智能体（单选）② 开哪些插件与技能（复选）③ Dock 面板布局；
 *   · **高级（默认折叠）＝ 一般不需要动的**：身份字段 / 继承 / 界面偏好 /
 *     主题 token / 记忆归属。
 *   同时把两处黑话换成人话：`memoryNamespace` → 「记忆归属」、
 *   `shareCoreProfile` → 「跨工作台共享核心画像」（文案见语言包）。
 *
 * 数据纪律：草稿**保留原始 manifest 对象**（`agentsRaw` / `capsRaw`），
 * 只在自己管理的字段上做增删 —— 这样 `patchOf` 回写时不会悄悄丢掉
 * 编辑器不认识的字段（`required` / `personaRef` / `interact` …）。
 * ============================================================ */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon, type IconName } from '../../icons'
import { Tooltip } from '../ui'
import { ark } from '../../ipc/client'
import { useStore } from '../../store'
import type { PluginSummary } from '@shared/types/plugin'
import type { ValidationIssue } from '@shared/types/profile'
import { PROFILE_HOME_MODULES, PROFILE_DOCK_TABS } from '@shared/types/profile'
import { ValidationIssuesView } from './ActivationReportView'

/** 可作为 profile icon 的宿主图标白名单（与 module 页保持同一批，禁 emoji） */
const ICON_CHOICES: IconName[] = [
  'Workspace', 'Bot', 'Bolt', 'Book', 'Brain', 'Graph', 'List', 'Star',
  'Sparkle', 'FolderOpen', 'File', 'Eye', 'Command', 'Box', 'Plug', 'Sparkle',
]

/** manifest 里 agent 的最小形状（编辑器只碰这几项，其余原样回写） */
export interface RawAgent {
  id: string
  name?: string
  personaRef?: string
  personaText?: string
  skills?: string[]
  defaultForNewTasks?: boolean
}

/** manifest 里 capability 的最小形状 */
export interface RawCapability {
  type: 'mcp' | 'skill' | 'panel'
  ref: string
  required?: boolean
}

export interface Draft {
  /* ---------- ① 智能体 ---------- */
  /** 原始对象数组（原样保留，回写时不丢字段） */
  agentsRaw: RawAgent[]
  /** 参与本台的 agent id（未勾 = 从 agents[] 移除） */
  agentOn: string[]
  /** 新建任务的默认 agent id（单选） */
  agentDefault: string

  /* ---------- ② 插件与技能 ---------- */
  capsRaw: RawCapability[]
  /** 生效的能力键（`<type>:<tail>`；未勾 = 从 capabilities[] 移除） */
  capsOn: string[]
  /** 新加的技能 tail（尚未进 capsRaw） */
  skillsAdded: string[]
  /**
   * v0.36.0（B11/P3-b）：工作台级插件白名单（真实消费端 = Inspector 过滤）。
   * null = manifest 未声明（全部插件面板照旧显示）；数组 = 白名单生效。
   * 勾选变动即时经 `profile:update` 窄通道持久化（内置台也放行此键）。
   */
  pluginRefsOverride: string[] | null

  /* ---------- ③ Dock 面板 ---------- */
  /** 顺序即 `ui.dockTabs` */
  dockTabs: string[]
  /** 插件面板：ref → position（缺省 = 追加末尾） */
  dockPanels: Array<{ panelRef: string; position?: number }>

  /* ---------- 高级 ---------- */
  name: string
  icon: string
  version: string
  description: string
  /** 父工作台 id（单继承，深度 ≤ 2） */
  extends: string
  homeModule: string
  composerChips: string
  memoryNamespace: string
  shareCoreProfile: boolean
  /** 主题 token 覆盖（键值对行） */
  themeRows: Array<{ group: 'light' | 'dark'; key: string; value: string }>
}

function emptyDraft(): Draft {
  return {
    agentsRaw: [],
    agentOn: [],
    agentDefault: '',
    capsRaw: [],
    capsOn: [],
    skillsAdded: [],
    pluginRefsOverride: null,
    dockTabs: [],
    dockPanels: [],
    name: '',
    icon: '',
    version: '1.0.0',
    description: '',
    extends: '',
    homeModule: '',
    composerChips: '',
    memoryNamespace: '',
    shareCoreProfile: true,
    themeRows: [],
  }
}

/** 能力键：`<type>:<tail>`（与 `validateReferences` 的去重口径同源） */
export function capKey(type: string, ref: string): string {
  const tail = ref.includes(':') ? ref.slice(ref.indexOf(':') + 1) : ref
  return `${type}:${tail}`
}

/** manifest 字面量 → 表单草稿（字段缺失一律回落空值，绝不抛错） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function draftOf(raw: any): Draft {
  const ui = (raw?.ui ?? {}) as Record<string, unknown>
  const theme = (ui.theme ?? {}) as { light?: Record<string, string>; dark?: Record<string, string> }
  const rows: Draft['themeRows'] = []
  for (const g of ['light', 'dark'] as const) {
    for (const [k, v] of Object.entries(theme[g] ?? {})) rows.push({ group: g, key: k, value: String(v) })
  }
  const dockPanels = Array.isArray(ui.dockPanels)
    ? (ui.dockPanels as Array<Record<string, unknown>>)
        .map((d) => ({
          panelRef: String(d?.panelRef ?? ''),
          position: typeof d?.position === 'number' ? d.position : undefined,
        }))
        .filter((d) => d.panelRef.length > 0)
    : []
  const agentsRaw: RawAgent[] = (Array.isArray(raw?.agents) ? raw.agents : [])
    .filter((a: unknown) => !!a && typeof (a as RawAgent).id === 'string')
    .map((a: RawAgent) => ({ ...a }))
  const capsRaw: RawCapability[] = (Array.isArray(raw?.capabilities) ? raw.capabilities : []).filter(
    (c: RawCapability) => !!c && typeof c.ref === 'string' && typeof c.type === 'string',
  )
  const defaultAgent = agentsRaw.find((a) => a.defaultForNewTasks === true)?.id ?? agentsRaw[0]?.id ?? ''
  return {
    agentsRaw,
    agentOn: agentsRaw.map((a) => a.id),
    agentDefault: defaultAgent,
    capsRaw,
    capsOn: capsRaw.map((c) => capKey(c.type, c.ref)),
    skillsAdded: [],
    pluginRefsOverride: Array.isArray(raw?.pluginRefs) ? (raw.pluginRefs as unknown[]).map(String) : null,
    dockTabs: Array.isArray(ui.dockTabs) ? (ui.dockTabs as unknown[]).map(String) : [],
    dockPanels,
    name: String(raw?.name ?? ''),
    icon: String(raw?.icon ?? ''),
    version: String(raw?.version ?? '1.0.0'),
    description: String(raw?.description ?? ''),
    extends: String(raw?.extends ?? ''),
    homeModule: String(ui.homeModule ?? ''),
    composerChips: Array.isArray(ui.composerChips) ? (ui.composerChips as unknown[]).map(String).join(', ') : '',
    memoryNamespace: String((raw?.data as Record<string, unknown>)?.memoryNamespace ?? ''),
    shareCoreProfile: (raw?.data as Record<string, unknown>)?.shareCoreProfile !== false,
    themeRows: rows,
  }
}

/** 草稿 → `profile:update` 的 patch（只回传编辑器管辖的字段） */
export function patchOf(draft: Draft): Record<string, unknown> {
  const light: Record<string, string> = {}
  const dark: Record<string, string> = {}
  for (const r of draft.themeRows) {
    if (r.key.trim().length === 0) continue
    if (r.group === 'light') light[r.key.trim()] = r.value.trim()
    else dark[r.key.trim()] = r.value.trim()
  }
  const chips = draft.composerChips.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 5)

  // ① 智能体：未勾的从 agents[] 移除；默认标记只留在选中的那一个上
  const agents = draft.agentsRaw
    .filter((a) => draft.agentOn.includes(a.id))
    .map((a) => ({ ...a, defaultForNewTasks: a.id === draft.agentDefault }))

  // ② 能力：保留原对象（不丢 required），只做「勾掉 = 移除」+ 新加技能
  const caps: RawCapability[] = draft.capsRaw.filter((c) => draft.capsOn.includes(capKey(c.type, c.ref)))
  for (const s of draft.skillsAdded) {
    const ref = `skill:${s}`
    if (!caps.some((c) => capKey(c.type, c.ref) === capKey('skill', ref))) {
      caps.push({ type: 'skill', ref, required: false })
    }
  }

  return {
    name: draft.name.trim(),
    icon: draft.icon.trim() || undefined,
    version: draft.version.trim(),
    description: draft.description.trim() || undefined,
    extends: draft.extends.trim() || undefined,
    agents,
    capabilities: caps,
    ui: {
      dockTabs: draft.dockTabs,
      dockPanels: draft.dockPanels.map((d) => (d.position === undefined ? { panelRef: d.panelRef } : d)),
      homeModule: draft.homeModule || undefined,
      composerChips: chips,
      theme: Object.keys(light).length + Object.keys(dark).length > 0 ? { light, dark } : undefined,
    },
    data: {
      memoryNamespace: draft.memoryNamespace.trim(),
      shareCoreProfile: draft.shareCoreProfile,
    },
  }
}

/** 全部 agent 技能 ∪ 能力技能（编辑器里的「技能」清单），已去重 */
export function skillsOf(draft: Draft): string[] {
  const out = new Set<string>()
  for (const a of draft.agentsRaw) for (const s of a.skills ?? []) out.add(capKey('skill', s).slice('skill:'.length))
  for (const c of draft.capsRaw) if (c.type === 'skill') out.add(capKey('skill', c.ref).slice('skill:'.length))
  for (const s of draft.skillsAdded) out.add(s)
  return Array.from(out).sort()
}

const field =
  'w-full h-8 px-2.5 rounded-md bg-bg-input border border-border-subtle text-xs text-text-primary focus-ring outline-none'
const label = 'block text-2xs text-text-tertiary mb-1'
const groupTitle = 'text-2xs font-medium text-text-secondary uppercase tracking-wider'

export function ProfileEditor({
  profileId,
  source,
  plugins,
  onClose,
  onSaved,
}: {
  profileId: string
  source: 'builtin' | 'user'
  plugins: PluginSummary[]
  onClose: () => void
  onSaved: () => Promise<void> | void
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [issues, setIssues] = useState<ValidationIssue[]>([])
  const [saving, setSaving] = useState(false)
  /** 高级组：默认折叠（F5.2「十余字段收敛为两组」的另一半） */
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [newSkill, setNewSkill] = useState('')
  /** 免编辑模式（内置台未克隆时）：全表单只读 */
  const [readonly, setReadonly] = useState(source === 'builtin')
  /** v0.36.2（D114）：克隆 id 与既有工作台去重用 */
  const profiles = useStore((s) => s.profiles)

  useEffect(() => {
    let alive = true
    setLoading(true)
    void (async () => {
      try {
        const res = await ark.profile.export({ id: profileId })
        if (!alive) return
        if (!res.ok) {
          setLoadError(t('workbench.editor.loadFailed'))
          return
        }
        setDraft(draftOf(JSON.parse(res.json)))
        setLoadError(null)
      } catch (err) {
        if (alive) setLoadError(err instanceof Error ? err.message : String(err))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [profileId, t])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const save = async (activate: boolean) => {
    setSaving(true)
    setIssues([])
    try {
      let id = profileId
      if (readonly) {
        // 内置台 → 克隆成用户台。
        // v0.36.2（D114）：id 必须是单点「命名空间.名称」（PROFILE_ID_RE 只允许一个点）
        // —— 此前 `${profileId}.edited` 生成 wb.research.edited（两个点）必然被 V1 校验
        // 拒绝。改为在名称段追加 -edited 后缀（wb.research → wb.research-edited），
        // 并与既有工作台 id 去重（-2、-3 …），二次克隆不再直接撞冲突。
        const taken = new Set(profiles.map((p) => p.id))
        let newId = `${profileId}-edited`
        for (let n = 2; taken.has(newId); n++) newId = `${profileId}-edited-${n}`
        const cloned = await ark.profile.clone({ fromId: profileId, newId, newName: draft.name || `${profileId} 副本` })
        if (!cloned.ok) {
          setIssues(cloned.issues)
          if (!cloned.issues.length) {
            setIssues([])
            setLoadError(t(`workbench.editor.cloneFail.${cloned.reason ?? 'invalid'}`))
          }
          return
        }
        id = newId
      }
      const res = await ark.profile.update({ id, patch: patchOf(draft) })
      if (!res.ok) {
        if (res.reason === 'builtin') {
          setReadonly(true)
          setLoadError(t('workbench.editor.builtinReadonly'))
          return
        }
        if (res.reason === 'not-found') {
          setLoadError(t('workbench.editor.notFound'))
          return
        }
        setIssues(res.issues)
        return
      }
      setIssues(res.issues)
      await onSaved()
      if (activate) {
        await ark.profile.activate({ id })
        await onSaved()
      }
      onClose()
    } finally {
      setSaving(false)
    }
  }

  /** 启用中的插件贡献的面板/视图（③ 的可选项） */
  const pluginPanels = plugins.filter((p) => p.enabled && p.panelRefs.length > 0)
  /** 启用中的插件贡献的代码视图（也是可被引用的面板） */
  const pluginViews = plugins.filter((p) => p.enabled && p.viewRefs.length > 0)
  const pluginModules = plugins.flatMap((p) => p.homeModules)
  const skills = skillsOf(draft)
  const activeProfileId = useStore((s) => s.activeProfileId)

  /**
   * v0.36.0（B11/P3-b）：插件勾选 → `profile:update` 窄通道（仅 pluginRefs 键）。
   * 内置台主进程放行此键（落 builtinOverrides），用户台走正常合并校验管道；
   * 保存的是当前生效台时重新激活，让 Inspector 的过滤立即生效。
   */
  const togglePluginRef = (pluginId: string, on: boolean) => {
    const all = [...pluginPanels, ...pluginViews].map((p) => p.id)
    const current = draft.pluginRefsOverride ?? all
    const next = on
      ? Array.from(new Set([...current, pluginId]))
      : current.filter((x) => x !== pluginId)
    setDraft({ ...draft, pluginRefsOverride: next })
    void (async () => {
      try {
        const res = await ark.profile.update({ id: profileId, patch: { pluginRefs: next } })
        if (!res.ok) {
          setLoadError(t('workbench.editor.pluginFilterFailed'))
          return
        }
        if (activeProfileId === profileId) await ark.profile.activate({ id: profileId })
        await onSaved()
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err))
      }
    })()
  }
  const scopeLabel = (s: PluginSummary['source']): string =>
    s === 'bundled'
      ? t('workbench.plugins.sourceBundled')
      : s === 'workspace'
        ? t('workbench.plugins.scopeWorkspace')
        : t('workbench.plugins.scopeGlobal')

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={t('workbench.editor.title')}>
      <div className="flex-1 bg-bg-overlay" onClick={onClose} />
      <div className="w-[480px] h-full bg-bg-base border-l border-border-default shadow-lg flex flex-col">
        <header className="flex items-center gap-2 h-12 px-4 border-b border-border-subtle flex-shrink-0">
          <Icon.Edit width={15} height={15} className="text-accent flex-shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium text-text-primary truncate">{t('workbench.editor.title')}</div>
            <div className="text-2xs text-text-faint font-mono truncate">{profileId}</div>
          </div>
          <Tooltip label={t('workbench.editor.close')}>
            <button onClick={onClose} aria-label={t('workbench.editor.close')} className="w-8 h-8 flex items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary focus-ring">
              <Icon.X width={15} height={15} />
            </button>
          </Tooltip>
        </header>

        {readonly && (
          <div className="flex items-start gap-1.5 px-4 py-2 bg-info-soft border-b border-border-subtle text-2xs text-text-secondary flex-shrink-0">
            <Icon.Info width={12} height={12} className="mt-px flex-shrink-0" aria-hidden />
            <span>{t('workbench.editor.builtinReadonly')}</span>
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
          {loading && <div className="text-xs text-text-faint">{t('workbench.editor.loading')}</div>}
          {loadError && (
            <div className="rounded-md border border-danger bg-danger-soft px-2.5 py-1.5 text-xs text-danger">{loadError}</div>
          )}

          {!loading && (
            <>
              {/* ============================== 基础组 ============================== */}
              <div className={groupTitle}>{t('workbench.editor.group.base')}</div>

              {/* ① 智能体 */}
              <section className="space-y-1.5" data-group="agent">
                <div className="text-xs text-text-primary">{t('workbench.editor.agentTitle')}</div>
                <p className="text-2xs text-text-faint">{t('workbench.editor.agentHint')}</p>
                {draft.agentsRaw.length === 0 && (
                  <div className="rounded-md border border-warning bg-warning-soft px-2.5 py-1.5 text-2xs text-warning">
                    {t('workbench.editor.noAgents')}
                  </div>
                )}
                <ul className="space-y-1">
                  {draft.agentsRaw.map((a) => {
                    const on = draft.agentOn.includes(a.id)
                    return (
                      <li key={a.id} className="flex items-center gap-2 rounded-md border border-border-subtle bg-bg-surface px-2 py-1">
                        <input
                          type="radio"
                          name="wb-default-agent"
                          aria-label={t('workbench.editor.agentDefaultAria', { id: a.id })}
                          disabled={readonly || !on}
                          checked={on && draft.agentDefault === a.id}
                          onChange={() => setDraft({ ...draft, agentDefault: a.id })}
                        />
                        <span className="text-xs text-text-primary flex-1 font-mono truncate">{a.id}</span>
                        {a.name && <span className="text-2xs text-text-tertiary truncate max-w-[110px]">{a.name}</span>}
                        <label className="flex items-center gap-1 text-2xs text-text-tertiary">
                          <input
                            type="checkbox"
                            checked={on}
                            // v0.36.0（B11/P3-c）：允许清到 0 个 agent（空 agents 仅
                            // manifest warning，不再强制保留最后一个）
                            disabled={readonly}
                            onChange={(e) => {
                              const next = e.target.checked
                                ? [...draft.agentOn, a.id]
                                : draft.agentOn.filter((x) => x !== a.id)
                              const fallback = next.includes(draft.agentDefault) ? draft.agentDefault : (next[0] ?? '')
                              setDraft({ ...draft, agentOn: next, agentDefault: fallback })
                            }}
                          />
                          {t('workbench.editor.agentInclude')}
                        </label>
                      </li>
                    )
                  })}
                </ul>
              </section>

              {/* ② 插件与技能 */}
              <section className="space-y-2" data-group="capabilities">
                <div className="text-xs text-text-primary">{t('workbench.editor.capTitle')}</div>
                <p className="text-2xs text-text-faint">{t('workbench.editor.capHint')}</p>

                <div>
                  <div className={label}>{t('workbench.editor.skillsTitle')}</div>
                  {skills.length === 0 ? (
                    <p className="text-2xs text-text-faint">{t('workbench.editor.noSkills')}</p>
                  ) : (
                    <ul className="space-y-1">
                      {skills.map((s) => (
                        <li key={s} className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            id={`skill-${s}`}
                            data-skill={s}
                            disabled={readonly}
                            checked={draft.capsOn.includes(capKey('skill', s))}
                            onChange={(e) =>
                              setDraft({
                                ...draft,
                                capsOn: e.target.checked
                                  ? [...draft.capsOn, capKey('skill', s)]
                                  : draft.capsOn.filter((k) => k !== capKey('skill', s)),
                              })
                            }
                          />
                          <label htmlFor={`skill-${s}`} className="text-xs text-text-primary font-mono truncate cursor-pointer">
                            {s}
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="flex items-center gap-1.5 mt-1.5">
                    <input
                      className={field}
                      placeholder={t('workbench.editor.skillAddPlaceholder')}
                      aria-label={t('workbench.editor.skillAdd')}
                      value={newSkill}
                      disabled={readonly}
                      onChange={(e) => setNewSkill(e.target.value)}
                    />
                    <button
                      type="button"
                      disabled={readonly || newSkill.trim().length === 0}
                      onClick={() => {
                        const s = newSkill.trim()
                        setDraft({
                          ...draft,
                          skillsAdded: draft.skillsAdded.includes(s) ? draft.skillsAdded : [...draft.skillsAdded, s],
                          capsOn: draft.capsOn.includes(capKey('skill', s))
                            ? draft.capsOn
                            : [...draft.capsOn, capKey('skill', s)],
                        })
                        setNewSkill('')
                      }}
                      className="h-8 px-2.5 rounded-md border border-border-subtle text-xs text-text-secondary hover:bg-bg-hover disabled:opacity-40 focus-ring flex-shrink-0"
                    >
                      {t('workbench.editor.skillAdd')}
                    </button>
                  </div>
                </div>

                <div>
                  <div className={label}>{t('workbench.editor.pluginsTitle')}</div>
                  <p className="text-2xs text-text-faint">{t('workbench.editor.pluginFilterHint')}</p>
                  {pluginPanels.length === 0 && pluginViews.length === 0 ? (
                    <p className="text-2xs text-text-faint">{t('workbench.editor.noPlugins')}</p>
                  ) : (
                    <ul className="space-y-1">
                      {[...pluginPanels, ...pluginViews].flatMap((p) => {
                        // v0.36.0（B11/P3-b）：勾选直接写工作台 pluginRefs 白名单
                        // （真实消费端 = Inspector 面板过滤），不再写无消费端的
                        // capabilities 声明。null = 未声明 → 视为全开（现状兼容）。
                        const checked = draft.pluginRefsOverride
                          ? draft.pluginRefsOverride.includes(p.id)
                          : true
                        return (
                          <li key={`${p.id}:${[...p.panelRefs, ...p.viewRefs].join(',')}`} className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              id={`plug-${p.id}`}
                              data-plugin-ref={p.id}
                              checked={checked}
                              onChange={(e) => togglePluginRef(p.id, e.target.checked)}
                            />
                            <label htmlFor={`plug-${p.id}`} className="text-xs text-text-primary font-mono truncate flex-1 cursor-pointer">
                              {p.id}
                            </label>
                            <span className="text-2xs text-text-faint border border-border-subtle rounded px-1 leading-4 flex-shrink-0">
                              {scopeLabel(p.source)}
                            </span>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </div>
              </section>

              {/* ③ Dock 面板 */}
              <section className="space-y-1.5" data-group="dock">
                <div className="text-xs text-text-primary">{t('workbench.editor.dockTitle')}</div>
                <p className="text-2xs text-text-faint">{t('workbench.editor.dockBuiltinHint')}</p>
                <ul className="space-y-1">
                  {draft.dockTabs.map((tab, i) => (
                    <li key={tab} className="flex items-center gap-2 rounded-md border border-border-subtle bg-bg-surface px-2 py-1">
                      <span className="text-xs text-text-primary flex-1 font-mono">{tab}</span>
                      <button type="button" disabled={readonly || i === 0} aria-label={t('workbench.editor.moveUp')} onClick={() => {
                        const next = [...draft.dockTabs]
                        ;[next[i - 1], next[i]] = [next[i], next[i - 1]]
                        setDraft({ ...draft, dockTabs: next })
                      }} className="w-6 h-6 flex items-center justify-center rounded text-text-tertiary hover:bg-bg-hover disabled:opacity-30 focus-ring">
                        <Icon.ArrowUp width={12} height={12} />
                      </button>
                      <button type="button" disabled={readonly} aria-label={t('workbench.editor.remove')} onClick={() => setDraft({ ...draft, dockTabs: draft.dockTabs.filter((x) => x !== tab) })} className="w-6 h-6 flex items-center justify-center rounded text-text-tertiary hover:bg-bg-hover disabled:opacity-30 focus-ring">
                        <Icon.X width={12} height={12} />
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="flex flex-wrap gap-1.5">
                  {PROFILE_DOCK_TABS.filter((d) => !draft.dockTabs.includes(d)).map((d) => (
                    <button key={d} type="button" disabled={readonly} onClick={() => setDraft({ ...draft, dockTabs: [...draft.dockTabs, d] })} className="rounded border border-border-subtle px-1.5 py-0.5 text-2xs text-text-secondary hover:bg-bg-hover disabled:opacity-40 focus-ring">
                      + {d}
                    </button>
                  ))}
                </div>

                <div className="pt-1">
                  <div className={label}>{t('workbench.editor.group.dockPanels')}</div>
                  {pluginPanels.length === 0 ? (
                    <p className="text-2xs text-text-faint">{t('workbench.editor.noPluginPanels')}</p>
                  ) : (
                    <ul className="space-y-1">
                      {pluginPanels.flatMap((p) => p.panelRefs).map((ref) => {
                        const picked = draft.dockPanels.find((d) => d.panelRef === ref)
                        return (
                          <li key={ref} className="flex items-center gap-2 rounded-md border border-border-subtle bg-bg-surface px-2 py-1">
                            <input
                              type="checkbox"
                              id={`panel-${ref}`}
                              checked={Boolean(picked)}
                              disabled={readonly}
                              onChange={(e) =>
                                setDraft({
                                  ...draft,
                                  dockPanels: e.target.checked
                                    ? [...draft.dockPanels, { panelRef: ref }]
                                    : draft.dockPanels.filter((d) => d.panelRef !== ref),
                                })
                              }
                            />
                            <label htmlFor={`panel-${ref}`} className="text-xs text-text-primary flex-1 font-mono truncate cursor-pointer">{ref}</label>
                            {picked && (
                              <input
                                type="number"
                                min={0}
                                aria-label={t('workbench.editor.position')}
                                placeholder={t('workbench.editor.position')}
                                className="w-16 h-6 px-1.5 rounded bg-bg-input border border-border-subtle text-2xs text-text-primary outline-none focus-ring"
                                value={picked.position ?? ''}
                                disabled={readonly}
                                onChange={(e) => {
                                  const v = e.target.value === '' ? undefined : Number(e.target.value)
                                  setDraft({
                                    ...draft,
                                    dockPanels: draft.dockPanels.map((d) => (d.panelRef === ref ? { panelRef: ref, position: v } : d)),
                                  })
                                }}
                              />
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </div>
              </section>

              {/* ============================== 高级组（默认折叠） ============================== */}
              <section className="border-t border-border-subtle pt-3">
                <button
                  type="button"
                  data-testid="advanced-toggle"
                  aria-expanded={showAdvanced}
                  onClick={() => setShowAdvanced((v) => !v)}
                  className="w-full flex items-center gap-1.5 text-left"
                >
                  <span className={groupTitle}>{t('workbench.editor.group.advanced')}</span>
                  <span className="text-2xs text-text-faint truncate flex-1">{t('workbench.editor.group.advancedHint')}</span>
                  <Icon.ChevronDown
                    width={12}
                    height={12}
                    className={`text-text-faint flex-shrink-0 transition-transform ${showAdvanced ? 'rotate-180' : ''}`}
                    aria-hidden
                  />
                </button>

                {showAdvanced && (
                  <div className="space-y-4 mt-3" data-testid="advanced-panel">
                    {/* 身份 */}
                    <div className="space-y-2">
                      <div className="text-2xs text-text-tertiary">{t('workbench.editor.group.identity')}</div>
                      <div>
                        <label className={label} htmlFor="wb-name">{t('workbench.editor.name')}</label>
                        <input id="wb-name" className={field} value={draft.name} disabled={readonly} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className={label} htmlFor="wb-version">{t('workbench.editor.version')}</label>
                          <input id="wb-version" className={field} value={draft.version} disabled={readonly} onChange={(e) => setDraft({ ...draft, version: e.target.value })} />
                        </div>
                        <div>
                          <label className={label} htmlFor="wb-icon">{t('workbench.editor.icon')}</label>
                          <select id="wb-icon" className={field} value={draft.icon} disabled={readonly} onChange={(e) => setDraft({ ...draft, icon: e.target.value })}>
                            <option value="">{t('workbench.editor.iconNone')}</option>
                            {ICON_CHOICES.map((n) => (
                              <option key={n} value={n}>{n}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <div>
                        <label className={label} htmlFor="wb-desc">{t('workbench.editor.description')}</label>
                        <textarea id="wb-desc" rows={2} className={`${field} h-auto py-1.5 resize-y`} value={draft.description} disabled={readonly} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
                      </div>
                    </div>

                    {/* 继承 */}
                    <div>
                      <label className={label} htmlFor="wb-extends">{t('workbench.editor.extends')}</label>
                      <input id="wb-extends" className={`${field} font-mono`} placeholder={t('workbench.editor.extendsPlaceholder')} value={draft.extends} disabled={readonly} onChange={(e) => setDraft({ ...draft, extends: e.target.value })} />
                      <p className="text-2xs text-text-faint mt-1">{t('workbench.editor.extendsHint')}</p>
                    </div>

                    {/* 界面偏好 */}
                    <div className="space-y-2">
                      <div className="text-2xs text-text-tertiary">{t('workbench.editor.group.ui')}</div>
                      <div>
                        <label className={label} htmlFor="wb-home">{t('workbench.editor.homeModule')}</label>
                        <select id="wb-home" className={field} value={draft.homeModule} disabled={readonly} onChange={(e) => setDraft({ ...draft, homeModule: e.target.value })}>
                          <option value="">{t('workbench.editor.homeModuleNone')}</option>
                          <optgroup label={t('workbench.editor.homeModuleBuiltin')}>
                            {PROFILE_HOME_MODULES.map((m) => (
                              <option key={m} value={m}>{m}</option>
                            ))}
                          </optgroup>
                          {pluginModules.length > 0 && (
                            <optgroup label={t('workbench.editor.homeModulePlugin')}>
                              {pluginModules.map((m) => (
                                <option key={m} value={m}>{m}</option>
                              ))}
                            </optgroup>
                          )}
                        </select>
                      </div>
                      <div>
                        <label className={label} htmlFor="wb-chips">{t('workbench.editor.composerChips')}</label>
                        <input id="wb-chips" className={field} placeholder={t('workbench.editor.composerChipsHint')} value={draft.composerChips} disabled={readonly} onChange={(e) => setDraft({ ...draft, composerChips: e.target.value })} />
                      </div>
                    </div>

                    {/* 主题覆盖 */}
                    <section className="space-y-1.5">
                      <div className="text-2xs text-text-tertiary">{t('workbench.editor.group.theme')}</div>
                      <p className="text-2xs text-text-faint">{t('workbench.editor.themeHint')}</p>
                      {draft.themeRows.map((r, i) => (
                        <div key={i} className="flex items-center gap-1.5">
                          <select
                            className="w-16 h-7 px-1 rounded bg-bg-input border border-border-subtle text-2xs text-text-primary outline-none"
                            value={r.group}
                            disabled={readonly}
                            onChange={(e) => {
                              const rows = [...draft.themeRows]
                              rows[i] = { ...r, group: e.target.value as 'light' | 'dark' }
                              setDraft({ ...draft, themeRows: rows })
                            }}
                          >
                            <option value="light">light</option>
                            <option value="dark">dark</option>
                          </select>
                          <input className="flex-1 h-7 px-2 rounded bg-bg-input border border-border-subtle text-2xs font-mono text-text-primary outline-none" placeholder="--radius-sm" value={r.key} disabled={readonly} onChange={(e) => {
                            const rows = [...draft.themeRows]
                            rows[i] = { ...r, key: e.target.value }
                            setDraft({ ...draft, themeRows: rows })
                          }} />
                          <input className="w-24 h-7 px-2 rounded bg-bg-input border border-border-subtle text-2xs text-text-primary outline-none" placeholder="#4F46E5" value={r.value} disabled={readonly} onChange={(e) => {
                            const rows = [...draft.themeRows]
                            rows[i] = { ...r, value: e.target.value }
                            setDraft({ ...draft, themeRows: rows })
                          }} />
                          <button type="button" disabled={readonly} aria-label={t('workbench.editor.remove')} onClick={() => setDraft({ ...draft, themeRows: draft.themeRows.filter((_, j) => j !== i) })} className="w-6 h-6 flex items-center justify-center rounded text-text-tertiary hover:bg-bg-hover disabled:opacity-30 focus-ring">
                            <Icon.X width={12} height={12} />
                          </button>
                        </div>
                      ))}
                      <button type="button" disabled={readonly} onClick={() => setDraft({ ...draft, themeRows: [...draft.themeRows, { group: 'light', key: '', value: '' }] })} className="text-2xs text-accent hover:underline disabled:opacity-40">
                        + {t('workbench.editor.addToken')}
                      </button>
                    </section>

                    {/* 记忆归属（v0.36.0：文案人话化） */}
                    <section className="space-y-2">
                      <div className="text-2xs text-text-tertiary">{t('workbench.editor.group.data')}</div>
                      <div>
                        <label className={label} htmlFor="wb-ns">{t('workbench.editor.memoryNamespace')}</label>
                        <input id="wb-ns" className={`${field} font-mono`} placeholder="my-workspace" value={draft.memoryNamespace} disabled={readonly} onChange={(e) => setDraft({ ...draft, memoryNamespace: e.target.value })} />
                        <p className="text-2xs text-text-faint mt-1">{t('workbench.editor.memoryNamespaceHint')}</p>
                      </div>
                      <label className="flex items-start gap-2 text-xs text-text-secondary">
                        <input type="checkbox" className="mt-0.5" checked={draft.shareCoreProfile} disabled={readonly} onChange={(e) => setDraft({ ...draft, shareCoreProfile: e.target.checked })} />
                        <span>
                          {t('workbench.editor.shareCoreProfile')}
                          <span className="block text-2xs text-text-faint mt-0.5">{t('workbench.editor.shareCoreProfileHint')}</span>
                        </span>
                      </label>
                    </section>
                  </div>
                )}
              </section>

              {issues.length > 0 && (
                <section>
                  <div className="text-2xs font-medium text-danger mb-1.5">{t('workbench.editor.saveIssues')}</div>
                  <ValidationIssuesView issues={issues} />
                </section>
              )}
            </>
          )}
        </div>

        <footer className="flex items-center gap-2 h-14 px-4 border-t border-border-subtle flex-shrink-0">
          <button type="button" onClick={onClose} className="h-8 px-3 rounded-md border border-border-subtle text-xs text-text-secondary hover:bg-bg-hover focus-ring">
            {t('workbench.editor.cancel')}
          </button>
          <div className="flex-1" />
          <button type="button" disabled={saving || loading} onClick={() => void save(false)} className="h-8 px-3 rounded-md border border-border-subtle text-xs text-text-secondary hover:bg-bg-hover disabled:opacity-50 focus-ring">
            {saving ? t('workbench.editor.saving') : t('workbench.editor.saveOnly')}
          </button>
          <button type="button" disabled={saving || loading} onClick={() => void save(true)} className="h-8 px-3 rounded-md bg-business-primary text-text-inverse text-xs hover:bg-business-primary-hover disabled:opacity-50 focus-ring">
            {readonly ? t('workbench.editor.cloneAndSave') : t('workbench.editor.saveAndActivate')}
          </button>
        </footer>
      </div>
    </div>
  )
}
