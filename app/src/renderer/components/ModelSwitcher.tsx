/* ============================================================
 * ArkWork — ModelSwitcher (v0.9.0 F904)
 * 模型切换器：Composer 工具栏第一控件
 * - 全名显示：🤖 DeepSeek-V3 ▾（宽度上限 180px）
 * - 唯一带主色底衬的控件（8%，hover 14%），其余工具控件幽灵样式
 * - 下拉：搜索框 + 推荐分组（当前/智能体默认/最近使用）→ 按提供商分组 → 管理入口
 * - 能力角标：🧠 思考 / 🔧 工具调用 / 📏 hover 显示上下文长度
 * - 提示体系：hover 能力卡 tooltip + modelHealth 异常警示态 + 智能体默认 ↩ 切回
 * - ⌘⇧M 快速切换（App 全局快捷键 → composer:open-model 事件）
 * ============================================================ */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../icons'
import { useStore, computeModelHealth } from '../store'
import { Kbd, Tooltip } from './ui'
import type { LlmModel } from '@shared/types/agent'

const RECENT_KEY = 'arkwork:recent-models'

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    const arr = raw ? (JSON.parse(raw) as string[]) : []
    return Array.isArray(arr) ? arr.slice(0, 2) : []
  } catch { return [] }
}

function saveRecent(ids: string[]): void {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(ids.slice(0, 2))) } catch { /* ignore */ }
}

/** v0.9.0 §7：能力角标来自模型配置静态声明（supportsThinking/supportsTools），缺省用命名启发式兜底 */
function capOf(m: LlmModel): { thinking: boolean; tools: boolean } {
  const name = `${m.name} ${m.id}`.toLowerCase()
  const reasoningLike = /r1|reasoner|thinking|o1|o3|deepseek-reasoner/.test(name)
  return {
    thinking: m.supportsThinking ?? reasoningLike,
    tools: m.supportsTools ?? !reasoningLike,
  }
}

export function ModelSwitcher({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (b: boolean) => void
}) {
  const { t } = useTranslation('translation', { keyPrefix: 'modelswitcher' })
  const models = useStore((s) => s.models)
  const selectedModelId = useStore((s) => s.selectedModelId)
  const setSelectedModel = useStore((s) => s.setSelectedModel)
  const agents = useStore((s) => s.agents)
  const selectedAgentId = useStore((s) => s.selectedAgentId)
  const setSettingsTab = useStore((s) => s.setSettingsTab)
  const openModulePage = useStore((s) => s.openModulePage)

  const [query, setQuery] = useState('')
  const [recent, setRecent] = useState<string[]>(loadRecent)
  const [activeIdx, setActiveIdx] = useState(0)
  const [showFirstRun, setShowFirstRun] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const model = models.find((m) => m.id === selectedModelId)
  const agent = agents.find((a) => a.id === selectedAgentId)
  const health = computeModelHealth(models, selectedModelId)
  const agentDefaultId = agent?.defaultModelId
  const agentDefault = models.find((m) => m.id === agentDefaultId)

  // 首次使用引导气泡（一次性，ui-state 记录）
  useEffect(() => {
    try {
      if (!localStorage.getItem('arkwork:model-switcher-onboarded')) {
        setShowFirstRun(true)
        localStorage.setItem('arkwork:model-switcher-onboarded', '1')
      }
    } catch { /* ignore */ }
  }, [])

  // 打开时聚焦搜索框；关闭时清空搜索
  useEffect(() => {
    if (open) {
      setTimeout(() => searchRef.current?.focus(), 30)
      setActiveIdx(0)
    } else {
      setQuery('')
    }
  }, [open])

  // 点击外部关闭
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) onOpenChange(false)
    }
    window.addEventListener('mousedown', onClick)
    return () => window.removeEventListener('mousedown', onClick)
  }, [open, onOpenChange])

  // 分组：推荐 → 提供商
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filter = (m: LlmModel) => !q || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)
    const enabled = models.filter(filter)

    const recommended: LlmModel[] = []
    const pushUnique = (m: LlmModel | undefined) => {
      if (m && recommended.length < 3 && !recommended.some((x) => x.id === m.id)) recommended.push(m)
    }
    pushUnique(model)
    pushUnique(agentDefault)
    for (const rid of recent) pushUnique(models.find((m) => m.id === rid))

    // 按提供商分组（保留推荐中已出现的项，避免重复）
    const providers: { kind: string; label: string; items: LlmModel[] }[] = []
    for (const m of enabled) {
      if (recommended.some((x) => x.id === m.id)) continue
      const kindLabel = m.kind === 'openai' ? t('kind.openai') : m.kind === 'anthropic' ? t('kind.anthropic') : m.kind === 'ollama' ? t('kind.ollama') : t('kind.vllm')
      const g = providers.find((p) => p.kind === m.kind)
      if (g) g.items.push(m)
      else providers.push({ kind: m.kind, label: kindLabel, items: [m] })
    }
    return { recommended, providers }
  }, [models, query, model, agentDefault, recent, t])

  // 扁平列表用于键盘导航
  const flatItems = useMemo(() => {
    const rec = groups.recommended.map((m) => ({ kind: 'recommended' as const, m }))
    const prov = groups.providers.flatMap((g) => g.items.map((m) => ({ kind: 'provider' as const, m })))
    return [...rec, ...prov]
  }, [groups])

  useEffect(() => { setActiveIdx(0) }, [query])

  const pick = (m: LlmModel) => {
    setSelectedModel(m.id)
    const next = [m.id, ...recent.filter((x) => x !== m.id)]
    setRecent(next)
    saveRecent(next)
    onOpenChange(false)
  }

  const openSettings = () => {
    setSettingsTab('models')
    openModulePage('settings')
    onOpenChange(false)
  }

  // 键盘
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((i) => Math.min(i + 1, flatItems.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = flatItems[activeIdx]
      if (item) pick(item.m)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onOpenChange(false)
    }
  }

  // ============ chip 外观（health 警示态） ============
  let chipCls = 'bg-accent-soft hover:bg-accent-soft border-accent text-text-primary'
  let chipLabel = model ? model.name || model.id : t('selectModel')
  let chipTitle = model ? `${model.name || model.id} · ${model.kind}` : t('selectModel')
  // v0.11.0 F1101：L3 能力卡（模型名称 + 上下文 + 能力角标）
  let chipCap = ''
  if (model) {
    const caps = model.contextWindow ? t('context', { ctx: (model.contextWindow / 1000).toFixed(0) }) : ''
    const thinking = model.supportsThinking ? t('supportThinking') : ''
    const tools = model.supportsTools ? t('supportTools') : ''
    chipCap = `${model.name || model.id} · ${model.kind}${caps ? ` ｜ ${caps}` : ''}${thinking || tools ? ` ｜ ${thinking} ${tools}`.trim() : ''}`
  }

  if (health === 'unconfigured') {
    chipCls = 'border-accent text-accent bg-accent-soft animate-pulse'
    chipLabel = t('health.unconfigured')
    chipTitle = t('health.unconfiguredTitle')
  } else if (health === 'missing') {
    chipCls = 'border-border-default text-text-tertiary bg-bg-hover line-through'
    chipLabel = t('health.missing')
    chipTitle = t('health.missingTitle')
  } else if (health === 'disabled') {
    chipCls = 'border-warning text-warning bg-warning-soft'
    chipLabel = `${model?.name || model?.id || t('model')}`
    chipTitle = t('health.disabledTitle')
  }

  return (
    <div className="relative" ref={boxRef}>
      {/* 首次使用引导气泡 */}
      {showFirstRun && !open && (
        <div className="absolute bottom-full left-0 mb-2 z-40 px-3 py-2 bg-bg-overlay border border-border-default rounded-lg shadow-panel text-xs text-text-secondary whitespace-nowrap slide-in">
          <div className="flex items-center gap-1.5">
            <span>{t('onboarding.title')}</span>
            <button
              onClick={() => setShowFirstRun(false)}
              className="text-text-tertiary hover:text-text-primary ml-1"
              aria-label={t('onboarding.dismiss')}
            >
              <Icon.X width={16} height={16} />
            </button>
          </div>
          <div className="absolute -bottom-1 left-4 w-2 h-2 bg-bg-overlay border-b border-r border-border-default rotate-45" />
        </div>
      )}

      {/* chip — v0.11.0 F1101：L3 能力卡 tooltip；F1104：40px 高（h-10） */}
      <Tooltip label={chipTitle} kbd="⌘⇧M" desc={t('chipDesc')} cap={chipCap || undefined} placement="top">
        <button
          onClick={() => onOpenChange(!open)}
          aria-label={t('chipSwitchAria', { label: chipLabel })}
          className={`flex items-center gap-1.5 h-10 px-3 rounded-lg text-xs border transition-colors focus-ring ${chipCls} ${
            open ? 'border-accent' : ''
          }`}
        >
          <Icon.Bot width={16} height={16} aria-hidden="true" />
          <span className="max-w-[150px] truncate">{chipLabel}</span>
          {/* 智能体默认模型 ≠ 当前 → ↩ 提示（只提示不自动切） */}
          {health === 'ok' && agentDefault && agentDefault.id !== selectedModelId && (
            <Tooltip label={t('agentDefaultTip', { agent: agent?.name ?? '', model: agentDefault.name || agentDefault.id })} placement="top">
              <span
                onClick={(e) => {
                  e.stopPropagation()
                  pick(agentDefault)
                }}
                className="text-accent text-xs leading-none px-0.5 hover:scale-110 transition-transform"
              >
                ↩
              </span>
            </Tooltip>
          )}
          <Icon.ChevronDown width={16} height={16} className="text-text-tertiary" />
        </button>
      </Tooltip>

      {/* 下拉 */}
      {open && (
        <div
          className="absolute left-0 bottom-full mb-1.5 w-72 z-40 bg-bg-overlay border border-border-default rounded-lg shadow-panel flex flex-col overflow-hidden scale-in"
          onKeyDown={onKeyDown}
        >
          {/* 搜索框 */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border-subtle">
            <Icon.Search width={16} height={16} className="text-text-tertiary" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('searchPlaceholder')}
              className="flex-1 text-sm text-text-primary placeholder:text-text-tertiary bg-transparent outline-none"
            />
            <Kbd>Esc</Kbd>
          </div>

          {/* 列表 */}
          <div className="max-h-[320px] overflow-y-auto py-1">
            {flatItems.length === 0 && (
              <div className="px-3 py-6 text-center text-xs text-text-tertiary">
                {t('noMatch')}
              </div>
            )}

            {groups.recommended.length > 0 && (
              <>
                <div className="px-3 py-1.5 text-2xs text-text-tertiary uppercase tracking-wider font-medium">{t('recommended')}</div>
                {groups.recommended.map((m) => (
                  <ModelRow key={m.id} m={m} activeIdx={activeIdx} flatItems={flatItems} onPick={pick} agentDefaultId={agentDefaultId} />
                ))}
              </>
            )}

            {groups.providers.map((g) => (
              <div key={g.kind}>
                <div className="px-3 py-1.5 text-2xs text-text-tertiary uppercase tracking-wider font-medium">{t('providerHeader', { label: g.label, count: g.items.length })}</div>
                {g.items.map((m) => (
                  <ModelRow key={m.id} m={m} activeIdx={activeIdx} flatItems={flatItems} onPick={pick} agentDefaultId={agentDefaultId} />
                ))}
              </div>
            ))}
          </div>

          {/* 底部管理入口 */}
          <button
            onClick={openSettings}
            className="flex items-center gap-2 px-3 py-2 border-t border-border-subtle text-sm text-accent hover:bg-accent-soft transition-colors"
          >
            <Icon.Settings width={16} height={16} />
            {t('manageConfig')}
          </button>
        </div>
      )}
    </div>
  )
}

/* ============================================================
 * ModelRow — 下拉单项（能力角标 / 当前标记 / 智能体默认 ✨）
 * ============================================================ */
function ModelRow({
  m,
  activeIdx,
  flatItems,
  onPick,
  agentDefaultId,
}: {
  m: LlmModel
  activeIdx: number
  flatItems: { kind: string; m: LlmModel }[]
  onPick: (m: LlmModel) => void
  agentDefaultId?: string
}) {
  const { t } = useTranslation('translation', { keyPrefix: 'modelswitcher' })
  const selectedModelId = useStore((s) => s.selectedModelId)
  const idx = flatItems.findIndex((x) => x.m.id === m.id)
  const active = idx === activeIdx
  const cap = capOf(m)
  const isDefault = m.id === agentDefaultId

  return (
    <button
      onMouseEnter={() => { /* activeIdx 由键盘管理，hover 不强改 */ }}
      onClick={() => onPick(m)}
      className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors ${
        active ? 'bg-bg-active' : 'hover:bg-bg-hover'
      }`}
      title={`${m.name || m.id} · ${m.kind}${m.contextWindow ? ` · ${t('context', { ctx: (m.contextWindow / 1000).toFixed(0) })}` : ''}`}
    >
      <Icon.Bot width={16} height={16} aria-hidden="true" className="flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm text-text-primary truncate">{m.name || m.id}</span>
          {isDefault && (
<Tooltip label={t('agentDefault')}>
            <span className="text-2xs text-warning flex-shrink-0">★</span>
</Tooltip>
          )}
        </div>
        <div className="text-2xs text-text-tertiary truncate">
          {m.kind}
          {m.contextWindow ? ` · ctx ${(m.contextWindow / 1000).toFixed(0)}k` : ''}
        </div>
      </div>
      {/* 能力角标 */}
      <div className="flex items-center gap-1 flex-shrink-0 text-2xs">
<Tooltip label={t('thinkModeTooltip')}>
        {cap.thinking && <span className="px-1.5 py-px rounded bg-bg-hover text-text-secondary">{t('thinkBadge')}</span>}
</Tooltip>
<Tooltip label={t('toolModeTooltip')}>
        {cap.tools && <span className="px-1.5 py-px rounded bg-bg-hover text-text-secondary">{t('toolBadge')}</span>}
</Tooltip>
      </div>
      {m.id === selectedModelId && <Icon.Check width={16} height={16} className="text-accent flex-shrink-0" />}
    </button>
  )
}
