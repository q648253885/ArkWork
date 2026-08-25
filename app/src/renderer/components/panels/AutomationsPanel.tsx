/* ============================================================
 * ArkWork — AutomationsPanel (v0.10.0)
 * 自动化列表面板：状态 / 触发类型 / 下次运行 + CRUD
 * - 列表：状态点 + 名称 + 触发类型 + 计划 + 上次运行
 * - 创建表单：名称 / Agent / 提示词 / 触发方式（手动 / cron）
 *   - 定时触发：频率 chip（只跑一次/每天/每周/每月/每个工作日/每个周末/自定义 cron）
 *             + 时间 picker（HH:MM）
 *             + 按频率的额外配置（每周勾日 / 每月选日）
 *             + 摘要行 + 自定义 cron 高级输入（保留全角归一化与常用预设）
 * - 运行 / 暂停-启用 / 删除
 * - 空态：「还没有自动化任务」+ 创建按钮
 * 复用 ModuleView 的 AutomationsView 逻辑
 * ============================================================ */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../../icons'
import { useStore } from '../../store'
import { Tooltip, EmptyState } from '../ui'

type FreqMode = 'once' | 'daily' | 'weekly' | 'monthly' | 'weekdays' | 'weekends' | 'custom'

interface FormState {
  name: string
  agentId: string
  prompt: string
  trigger: 'manual' | 'cron'
  cronExpr: string
  /** 自动化专用模型；空 = 跟随 Agent 默认 */
  modelId: string
  /* v0.10.0：可视化定时配置 */
  freqMode: FreqMode
  hour: number
  minute: number
  weekdays: number[]
  monthDay: number
}

const EMPTY_FORM: FormState = {
  name: '',
  agentId: '@default',
  prompt: '',
  trigger: 'manual',
  cronExpr: '',
  modelId: '',
  freqMode: 'daily',
  hour: 9,
  minute: 0,
  weekdays: [1, 2, 3, 4, 5],
  monthDay: 1,
}

/** 工作日名（周一~周日） */
const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
function weekdayName(t: (k: string) => string, w: number): string {
  return t(`panel.automations.weekday.${WEEKDAY_KEYS[w === 0 ? 6 : w - 1]}`)
}

/** v0.9.1：与主进程 cron.ts 同规则的轻量校验（5 段、各段在取值范围内） */
function isValidCronInput(expr: string): boolean {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return false
  const ranges: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]
  return fields.every((f, i) => {
    const [min, max] = ranges[i]
    return f.split(',').every((part) => {
      const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/)
      if (!m) return false
      if (m[2] !== undefined && parseInt(m[2], 10) < 1) return false
      if (m[1] === '*') return true
      const [a, b] = m[1].includes('-')
        ? m[1].split('-').map((s) => parseInt(s, 10))
        : [parseInt(m[1], 10), parseInt(m[1], 10)]
      return !Number.isNaN(a) && !Number.isNaN(b) && a >= min && b <= max && a <= b
    })
  })
}

/** 常用 cron 预设：让不熟悉 cron 语法的用户一键选择，避免"创建按钮无法点击" */
function buildCronPresets(t: (k: string) => string): { label: string; expr: string }[] {
  const calls: [string, string][] = [
    ['daily9', '0 9 * * *'],
    ['weekdays9', '0 9 * * 1-5'],
    ['monday9', '0 9 * * 1'],
    ['hourly', '0 * * * *'],
    ['midnight', '0 0 * * *'],
  ]
  return calls.map(([key, expr]) => ({ label: t(`panel.automations.presets.${key}`), expr }))
}

/**
 * 全角字符归一化为半角。
 * 中文输入法下输入 `０ ０ ＊ ＊ ＊` 等全角字符会导致 cron 校验失败、
 * 创建按钮被禁用且无法察觉；这里在输入/提交前统一归一化。
 */
function normalizeCron(expr: string): string {
  return expr
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/＊/g, '*')
    .replace(/／/g, '/')
    .replace(/，/g, ',')
    .replace(/－/g, '-')
    .replace(/\u3000/g, ' ')
    .trim()
}

/**
 * v0.10.0：把可视化配置转成 cron 表达式。
 * - once / daily:    `M H * * *`（once 语义按 spec 简化与 daily 同表达，后续 Task 处理 runOnce）
 * - weekdays:        `M H * * 1-5`
 * - weekends:        `M H * * 6,0`
 * - weekly:          `M H * * dow,...`（dow 0=周日）
 * - monthly:         `M H D * *`
 * - weekly 无选中工作日时返回 null（UI 应阻止提交）
 * - custom 由用户输入控制，不通过本函数生成
 */
function freqToCron(
  freq: FreqMode,
  hour: number,
  minute: number,
  weekdays: number[],
  monthDay: number,
): string | null {
  const h = Math.max(0, Math.min(23, Math.trunc(hour)))
  const m = Math.max(0, Math.min(59, Math.trunc(minute)))
  if (freq === 'once' || freq === 'daily') return `${m} ${h} * * *`
  if (freq === 'weekdays') return `${m} ${h} * * 1-5`
  if (freq === 'weekends') return `${m} ${h} * * 6,0`
  if (freq === 'weekly') {
    if (!weekdays || weekdays.length === 0) return null
    const sorted = [...new Set(weekdays)].sort((a, b) => a - b)
    return `${m} ${h} * * ${sorted.join(',')}`
  }
  if (freq === 'monthly') {
    const d = Math.max(1, Math.min(31, Math.trunc(monthDay)))
    return `${m} ${h} ${d} * *`
  }
  return null
}

/**
 * v0.10.0：把 cron 表达式反推为可视化配置（编辑模式预填用）。
 * 若不能匹配已知可视化模式，返回 null（UI 应回退到 custom）。
 */
function cronToFreq(cron: string): {
  freqMode: FreqMode
  hour: number
  minute: number
  weekdays: number[]
  monthDay: number
} | null {
  const f = cron.trim().split(/\s+/)
  if (f.length !== 5) return null
  const [min, hour, dom, mon, dow] = f
  if (
    min.includes(',') ||
    hour.includes(',') ||
    min.includes('-') ||
    hour.includes('-') ||
    min.includes('/') ||
    hour.includes('/') ||
    dom.includes(',') ||
    dom.includes('-') ||
    dom.includes('/') ||
    mon !== '*'
  ) {
    return null
  }
  if (min === '*' || hour === '*') return null
  const m = parseInt(min, 10)
  const h = parseInt(hour, 10)
  if (Number.isNaN(m) || Number.isNaN(h)) return null

  const out = {
    freqMode: 'custom' as FreqMode,
    hour: h,
    minute: m,
    weekdays: [1, 2, 3, 4, 5] as number[],
    monthDay: 1,
  }

  // daily
  if (dom === '*' && mon === '*' && dow === '*') return { ...out, freqMode: 'daily' }
  // weekdays
  if (dom === '*' && mon === '*' && dow === '1-5') return { ...out, freqMode: 'weekdays' }
  // weekends
  if (dom === '*' && mon === '*' && dow === '6,0') return { ...out, freqMode: 'weekends' }
  // weekly: 单个或多个数字（0~7）
  if (dom === '*' && mon === '*' && /^[\d,]+$/.test(dow)) {
    const ws = dow
      .split(',')
      .map((s) => parseInt(s, 10))
      .filter((n) => !Number.isNaN(n))
    if (ws.length > 0 && ws.every((n) => n >= 0 && n <= 7)) {
      const norm = ws.map((n) => (n === 7 ? 0 : n)).sort((a, b) => a - b)
      return {
        ...out,
        freqMode: 'weekly',
        weekdays: norm.length === 7 ? [1, 2, 3, 4, 5, 6, 0] : norm,
      }
    }
  }
  // monthly: D * *
  if (/^\d{1,2}$/.test(dom) && mon === '*' && dow === '*') {
    return { ...out, freqMode: 'monthly', monthDay: parseInt(dom, 10) }
  }
  return null
}

/** v0.10.0：根据 freqMode/hour/minute/weekdays/monthDay 生成一行人类可读摘要 */
function buildSummary(
  t: (k: string, o?: Record<string, unknown>) => string,
  freq: FreqMode,
  hour: number,
  minute: number,
  weekdays: number[],
  monthDay: number,
  cronExpr: string,
): string {
  const hh = String(hour).padStart(2, '0')
  const mm = String(minute).padStart(2, '0')
  const hm = `${hh}:${mm}`
  switch (freq) {
    case 'once':
      return t('panel.automations.summary.once', { time: hm })
    case 'daily':
      return t('panel.automations.summary.daily', { time: hm })
    case 'weekdays':
      return t('panel.automations.summary.weekdays', { time: hm })
    case 'weekends':
      return t('panel.automations.summary.weekends', { time: hm })
    case 'weekly': {
      if (!weekdays || weekdays.length === 0) return t('panel.automations.summary.weekly_unknown', { time: hm })
      const names = weekdays
        .slice()
        .sort((a, b) => a - b)
        .map((w) => weekdayName(t, w))
      return t('panel.automations.summary.weekly', { names: names.join('/'), time: hm })
    }
    case 'monthly':
      return t('panel.automations.summary.monthly', { day: monthDay, time: hm })
    case 'custom':
      return t('panel.automations.summary.custom', { expr: cronExpr || '—' })
  }
}

export function AutomationsPanel() {
  const { t } = useTranslation()
  const autos = useStore((s) => s.automations)
  const agents = useStore((s) => s.agents)
  const models = useStore((s) => s.models)
  const createAutomation = useStore((s) => s.createAutomation)
  const updateAutomation = useStore((s) => s.updateAutomation)
  const removeAutomation = useStore((s) => s.removeAutomation)
  const toggleAutomation = useStore((s) => s.toggleAutomation)
  const runAutomation = useStore((s) => s.runAutomation)
  const pushToast = useStore((s) => s.pushToast)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  // 预设下拉 key：选择后重置，允许重复选择同一预设
  const [presetKey, setPresetKey] = useState(0)
  const CRON_PRESETS = buildCronPresets(t)

  // 默认 agentId 取第一个 agent；新建时若其有 defaultModelId 则大模型预填该值
  const defaultAgentId = agents[0]?.id ?? '@default'
  const defaultAgentModelId = agents.find((a) => a.id === defaultAgentId)?.defaultModelId ?? ''

  /** Agent 切换：若当前未选模型，自动预填新 Agent 的 defaultModelId（若存在） */
  const handleAgentChange = (agentId: string) => {
    setForm((f) => {
      if (!f.modelId) {
        const nextAgent = agents.find((a) => a.id === agentId)
        if (nextAgent?.defaultModelId) {
          return { ...f, agentId, modelId: nextAgent.defaultModelId }
        }
      }
      return { ...f, agentId }
    })
  }

  /** v0.10.0：把可视化配置同步写回 cronExpr（custom 模式不覆盖） */
  const syncCronFromFreq = (next: FormState): FormState => {
    if (next.freqMode === 'custom') return next
    const cron = freqToCron(next.freqMode, next.hour, next.minute, next.weekdays, next.monthDay)
    if (cron === null) return next // 留空由校验拦截
    return { ...next, cronExpr: cron }
  }

  /** 打开新建表单（+ 按钮 / 空态按钮共用）：默认 freqMode=daily */
  const openCreateForm = () => {
    setEditingId(null)
    const seed: FormState = {
      ...EMPTY_FORM,
      agentId: defaultAgentId,
      modelId: defaultAgentModelId,
      freqMode: 'daily',
      hour: 9,
      minute: 0,
      weekdays: [1, 2, 3, 4, 5],
      monthDay: 1,
    }
    const seeded = syncCronFromFreq(seed)
    setForm(seeded)
    setShowForm(true)
  }

  const submit = async () => {
    if (!form.name.trim() || !form.prompt.trim()) return
    // cron 不再通过禁用按钮拦截：这里给出明确提示，避免"按钮无法点击"无从下手
    if (form.trigger === 'cron') {
      // weekly 必须至少选一个工作日
      if (form.freqMode === 'weekly' && form.weekdays.length === 0) {
        pushToast({ type: 'danger', message: t('panel.automations.need_weekday'), duration: 5000 })
        return
      }
      const expr = normalizeCron(form.cronExpr)
      if (!expr) {
        pushToast({ type: 'danger', message: t('panel.automations.need_time'), duration: 5000 })
        return
      }
      if (!isValidCronInput(expr)) {
        pushToast({
          type: 'danger',
          message: t('panel.automations.invalid_time', { expr }),
          duration: 7000,
        })
        return
      }
      setForm((f) => ({ ...f, cronExpr: expr }))
    }
    const payload = {
      name: form.name.trim(),
      agentId: form.agentId || defaultAgentId,
      prompt: form.prompt.trim(),
      trigger: form.trigger,
      cronExpr: form.trigger === 'cron' ? normalizeCron(form.cronExpr) : undefined,
      modelId: form.modelId || undefined,
    }
    const ok = editingId ? await updateAutomation(editingId, payload) : await createAutomation(payload)
    if (ok) {
      setForm(EMPTY_FORM)
      setShowForm(false)
      setEditingId(null)
    }
  }

  const closeForm = () => {
    setShowForm(false)
    setEditingId(null)
  }

  /** 切换频率 chip：同步 cronExpr */
  const handleFreqChange = (freq: FreqMode) => {
    setForm((f) => syncCronFromFreq({ ...f, freqMode: freq }))
  }

  /** 时间 picker 的 onChange：限制范围并同步 cronExpr */
  const handleHourChange = (val: string) => {
    const n = parseInt(val, 10)
    const h = Number.isNaN(n) ? 0 : Math.max(0, Math.min(23, n))
    setForm((f) => syncCronFromFreq({ ...f, hour: h }))
  }
  const handleMinuteChange = (val: string) => {
    const n = parseInt(val, 10)
    const m = Number.isNaN(n) ? 0 : Math.max(0, Math.min(59, n))
    setForm((f) => syncCronFromFreq({ ...f, minute: m }))
  }

  /** 每周多选切换工作日 */
  const toggleWeekday = (w: number) => {
    setForm((f) => {
      const exists = f.weekdays.includes(w)
      const nextDays = exists ? f.weekdays.filter((x) => x !== w) : [...f.weekdays, w]
      return syncCronFromFreq({ ...f, weekdays: nextDays })
    })
  }

  /** 每月选日 */
  const handleMonthDayChange = (val: string) => {
    const n = parseInt(val, 10)
    const d = Number.isNaN(n) ? 1 : Math.max(1, Math.min(31, n))
    setForm((f) => syncCronFromFreq({ ...f, monthDay: d }))
  }

  // 当前 cron 校验状态（用于输入框下方红字提示）
  const normalizedCron = normalizeCron(form.cronExpr)
  const cronOk = !normalizedCron || isValidCronInput(normalizedCron)

  return (
    <div className="flex flex-col h-full">
      {/* 头部 */}
      <div className="flex items-center gap-2 px-3 h-9 flex-shrink-0 border-b border-border-subtle">
        <span className="text-sm text-text-primary font-medium">{t('panel.automations.title')}</span>
        <span className="text-2xs text-text-tertiary">{autos.length}</span>
        {!showForm && (
          <Tooltip label={t('panel.automations.new_tooltip')} desc={t('panel.automations.new_desc')}>
            <button
              onClick={openCreateForm}
              className="ml-auto h-7 w-7 flex items-center justify-center rounded-md bg-accent hover:bg-accent-hover text-text-inverse transition-colors"
            >
              <Icon.Plus width={16} height={16} />
            </button>
          </Tooltip>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-2.5 space-y-2.5">
        {/* 新建/编辑表单 */}
        {showForm && (
          <div className="p-3 rounded-lg bg-bg-surface border border-border-default space-y-2.5">
            {/* 表单标题 */}
            <div className="text-sm font-medium">
              {editingId ? t('panel.automations.edit_title') : t('panel.automations.new_title')}
            </div>

            {/* 名称 */}
            <div className="space-y-1">
              <label className="block text-xs text-text-secondary">{t('panel.automations.name')}</label>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder={t('panel.automations.name_placeholder')}
                className="w-full h-8 px-3 text-xs rounded-md bg-bg-input border border-border-default focus:border-accent outline-none"
              />
            </div>

            {/* 提示词 */}
            <div className="space-y-1">
              <label className="block text-xs text-text-secondary">{t('panel.automations.prompt')}</label>
              <textarea
                value={form.prompt}
                onChange={(e) => setForm({ ...form, prompt: e.target.value })}
                placeholder={t('panel.automations.prompt_placeholder')}
                rows={3}
                className="w-full px-3 py-2 text-xs rounded-md bg-bg-input border border-border-default focus:border-accent outline-none resize-none"
              />
            </div>

            {/* Agent */}
            <div className="space-y-1">
              <label className="block text-xs text-text-secondary">{t('panel.automations.agent')}</label>
              <select
                value={form.agentId}
                onChange={(e) => handleAgentChange(e.target.value)}
                className="w-full h-8 px-2 text-xs rounded-md bg-bg-input border border-border-default focus:border-accent outline-none"
              >
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>

            {/* 大模型 */}
            <div className="space-y-1">
              <label className="block text-xs text-text-secondary">{t('panel.automations.model')}</label>
              <select
                value={form.modelId}
                onChange={(e) => setForm({ ...form, modelId: e.target.value })}
                className="w-full h-8 px-2 text-xs rounded-md bg-bg-input border border-border-default focus:border-accent outline-none"
              >
                <option value="">{t('panel.automations.follow_agent')}</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
              {models.length === 0 && (
                <div className="text-2xs text-text-tertiary">{t('panel.automations.no_models')}</div>
              )}
            </div>

            {/* 触发方式 */}
            <div className="space-y-1">
              <label className="block text-xs text-text-secondary">{t('panel.automations.trigger')}</label>
              <select
                value={form.trigger}
                onChange={(e) => setForm({ ...form, trigger: e.target.value as 'manual' | 'cron' })}
                className="w-full h-8 px-2 text-xs rounded-md bg-bg-input border border-border-default focus:border-accent outline-none"
              >
                <option value="manual">{t('panel.automations.manual_trigger')}</option>
                <option value="cron">{t('panel.automations.cron_trigger')}</option>
              </select>
            </div>

            {/* 定时时间（仅 cron）：三段式 UI */}
            {form.trigger === 'cron' && (
              <div className="space-y-2">
                <label className="block text-xs text-text-secondary">{t('panel.automations.schedule')}</label>

                {/* 段一：频率 chip 组（单选） */}
                <div className="flex flex-wrap gap-1.5">
                  {([
                    { value: 'once', label: t('panel.automations.freq.once') },
                    { value: 'daily', label: t('panel.automations.freq.daily') },
                    { value: 'weekdays', label: t('panel.automations.freq.weekdays') },
                    { value: 'weekends', label: t('panel.automations.freq.weekends') },
                    { value: 'weekly', label: t('panel.automations.freq.weekly') },
                    { value: 'monthly', label: t('panel.automations.freq.monthly') },
                    { value: 'custom', label: t('panel.automations.freq.custom') },
                  ] as { value: FreqMode; label: string }[]).map((opt) => {
                    const active = form.freqMode === opt.value
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => handleFreqChange(opt.value)}
                        className={
                          'h-7 px-3 rounded-md text-xs transition-colors ' +
                          (active
                            ? 'bg-accent text-text-inverse'
                            : 'text-text-secondary border border-border-default hover:bg-bg-hover')
                        }
                      >
                        {opt.label}
                      </button>
                    )
                  })}
                </div>

                {/* 段二：时间 picker（非 custom 时显示） */}
                {form.freqMode !== 'custom' && (
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number"
                      min={0}
                      max={23}
                      value={form.hour}
                      onChange={(e) => handleHourChange(e.target.value)}
                      className="w-14 h-8 px-2 text-xs text-center rounded-md bg-bg-input border border-border-default focus:border-accent outline-none"
                      aria-label={t('panel.automations.hour')}
                    />
                    <span className="text-text-tertiary text-xs">:</span>
                    <input
                      type="number"
                      min={0}
                      max={59}
                      value={form.minute}
                      onChange={(e) => handleMinuteChange(e.target.value)}
                      className="w-14 h-8 px-2 text-xs text-center rounded-md bg-bg-input border border-border-default focus:border-accent outline-none"
                      aria-label={t('panel.automations.minute')}
                    />
                  </div>
                )}

                {/* 段三：按频率的额外配置 */}
                {form.freqMode === 'weekly' && (
                  <div className="flex flex-wrap gap-1.5">
                    {[1, 2, 3, 4, 5, 6, 0].map((w) => {
                      const active = form.weekdays.includes(w)
                      const label = weekdayName(t, w)
                      return (
                        <button
                          key={w}
                          type="button"
                          onClick={() => toggleWeekday(w)}
                          className={
                            'h-7 px-2.5 rounded-md text-xs transition-colors ' +
                            (active
                              ? 'bg-accent text-text-inverse'
                              : 'bg-bg-surface border border-border-subtle hover:border-border-default')
                          }
                        >
                          {label}
                        </button>
                      )
                    })}
                  </div>
                )}
                {form.freqMode === 'monthly' && (
                  <select
                    value={form.monthDay}
                    onChange={(e) => handleMonthDayChange(e.target.value)}
                    className="h-8 px-2 text-xs rounded-md bg-bg-input border border-border-default focus:border-accent outline-none"
                    aria-label={t('panel.automations.month_day')}
                  >
                    {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                      <option key={d} value={d}>
                        {t('panel.automations.day', { day: d })}
                      </option>
                    ))}
                  </select>
                )}

                {/* 段四：摘要行（始终显示） */}
                <div className="text-2xs text-text-tertiary">
                  {buildSummary(
                    t,
                    form.freqMode,
                    form.hour,
                    form.minute,
                    form.weekdays,
                    form.monthDay,
                    form.cronExpr,
                  )}
                </div>

                {/* 自定义 cron 高级输入（仅 custom 时可改；其他模式 disabled 显示当前存储值） */}
                {form.freqMode === 'custom' ? (
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <select
                        key={presetKey}
                        defaultValue=""
                        onChange={(e) => {
                          const v = e.target.value
                          if (v) {
                            const norm = normalizeCron(v)
                            setForm((f) => ({ ...f, cronExpr: norm, freqMode: 'custom' }))
                            setPresetKey((k) => k + 1)
                          }
                        }}
                        className="h-8 px-2 text-xs rounded-md bg-bg-input border border-border-default focus:border-accent outline-none flex-shrink-0"
                      >
                        <option value="" disabled>{t('panel.automations.presets_label')}</option>
                        {CRON_PRESETS.map((p) => (
                          <option key={p.expr} value={p.expr}>{p.label} · {p.expr}</option>
                        ))}
                      </select>
                      <input
                        value={form.cronExpr}
                        onChange={(e) =>
                          setForm((f) => ({
                            ...f,
                            freqMode: 'custom',
                            cronExpr: normalizeCron(e.target.value),
                          }))
                        }
                        placeholder={t('panel.automations.cron_placeholder')}
                        className="flex-1 min-w-0 h-8 px-3 text-xs font-mono rounded-md bg-bg-input border border-border-default focus:border-accent outline-none"
                      />
                    </div>
                    {!normalizedCron && (
                      <div className="text-2xs text-text-tertiary">
                        {t('panel.automations.cron_hint')}
                      </div>
                    )}
                    {normalizedCron && !cronOk && (
                      <div className="text-2xs text-danger">
                        {t('panel.automations.cron_invalid')}
                      </div>
                    )}
                  </div>
                ) : (
                  <input
                    value={form.cronExpr}
                    disabled
                    aria-label={t('panel.automations.cron_display_label')}
                    className="w-full h-8 px-3 text-xs font-mono rounded-md bg-bg-input border border-border-default text-text-tertiary cursor-not-allowed outline-none"
                  />
                )}
              </div>
            )}

            <div className="flex items-center justify-end gap-2">
              <button
                onClick={closeForm}
                className="h-8 px-3 rounded-md text-xs text-text-secondary border border-border-default hover:bg-bg-hover transition-colors"
              >
                {t('panel.automations.cancel')}
              </button>
              <button
                onClick={() => void submit()}
                disabled={!form.name.trim() || !form.prompt.trim()}
                className="h-8 px-4 rounded-md text-xs font-medium text-text-inverse bg-accent hover:bg-accent-hover transition-colors disabled:opacity-50"
              >
                {t('panel.automations.create')}
              </button>
            </div>
          </div>
        )}

        {/* 自动化列表 */}
        {autos.map((a) => (
          <AutomationRow
            key={a.id}
            id={a.id}
            name={a.name}
            agentId={a.agentId}
            prompt={a.prompt}
            trigger={a.trigger}
            cronExpr={a.cronExpr}
            status={a.status}
            lastRun={a.lastRun}
            nextRun={a.nextRun}
            onRun={() => void runAutomation(a.id)}
            onToggle={() =>
              void toggleAutomation(a.id, a.status === 'active' ? 'paused' : 'active')
            }
            onEdit={() => {
              setEditingId(a.id)
              // 反推可视化配置；命中则预填 freqMode 等，未命中则回退 custom
              const base: FormState = {
                ...EMPTY_FORM,
                name: a.name,
                agentId: a.agentId,
                prompt: a.prompt,
                trigger: a.trigger,
                cronExpr: a.cronExpr ?? '',
                modelId: a.modelId ?? '',
              }
              const parsed =
                a.trigger === 'cron' && a.cronExpr ? cronToFreq(a.cronExpr) : null
              const seeded: FormState = parsed
                ? {
                    ...base,
                    freqMode: parsed.freqMode,
                    hour: parsed.hour,
                    minute: parsed.minute,
                    weekdays: parsed.weekdays,
                    monthDay: parsed.monthDay,
                    cronExpr: a.cronExpr ?? '',
                  }
                : { ...base, freqMode: 'custom', cronExpr: a.cronExpr ?? '' }
              setForm(seeded)
              setShowForm(true)
            }}
            onDelete={() => void removeAutomation(a.id)}
          />
        ))}

        {/* 空态 */}
        {autos.length === 0 && !showForm && (
          <EmptyState
            icon={<Icon.Bolt width={22} height={22} />}
            title={t('panel.automations.empty_title')}
            hint={t('panel.automations.empty_hint')}
            action={
              <button
                onClick={openCreateForm}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-medium text-text-inverse bg-accent hover:bg-accent-hover transition-colors"
              >
                <Icon.Plus width={16} height={16} />
                {t('panel.automations.create_btn')}
              </button>
            }
          />
        )}
      </div>
    </div>
  )
}

/* ============================================================
 * AutomationRow — 单条自动化
 * ============================================================ */

/** v0.9.1：ISO 时间 → 友好的本地短格式（今天显示时分，否则月日+时分） */
function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (sameDay) return hm
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

function AutomationRow({
  id: _id,
  name,
  agentId,
  prompt,
  trigger,
  cronExpr,
  status,
  lastRun,
  nextRun,
  onRun,
  onToggle,
  onEdit,
  onDelete,
}: {
  id: string
  name: string
  agentId: string
  prompt: string
  trigger: 'manual' | 'cron'
  cronExpr?: string
  status: 'active' | 'paused'
  lastRun?: string
  nextRun?: string
  onRun: () => void
  onToggle: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  void _id
  const { t } = useTranslation()
  const active = status === 'active'
  return (
    <div className="p-3 rounded-lg bg-bg-surface border border-border-subtle hover:border-border-default transition-colors">
      {/* 第一行：状态点 + 名称 + 状态标签 */}
      <div className="flex items-center gap-2 mb-1.5">
        <Icon.Bolt width={16} height={16} className={active ? 'text-warning' : 'text-text-tertiary'} />
        <span className="text-sm text-text-primary font-medium truncate flex-1">{name}</span>
        <span
          className={`text-2xs flex items-center gap-1 flex-shrink-0 ${
            active ? 'text-success' : 'text-text-tertiary'
          }`}
        >
          <span
            className="w-1.5 h-1.5 rounded-full"
            style={{ background: active ? 'var(--success)' : 'var(--info)' }}
          />
          {active ? t('panel.automations.running') : t('panel.automations.paused')}
        </span>
      </div>

      {/* 第二行：触发类型 / 计划 / 上次运行 / 下次运行 */}
      <div className="text-2xs text-text-tertiary mb-1.5 space-y-0.5">
        <div className="font-mono">
          {trigger === 'cron'
            ? t('panel.automations.schedule_line_cron', { expr: cronExpr ?? '—', agent: agentId })
            : t('panel.automations.schedule_line_manual', { agent: agentId })}
        </div>
        <div>
          {lastRun
            ? t('panel.automations.last_run', { time: formatTime(lastRun) })
            : t('panel.automations.not_run')}
          {/* v0.9.1：cron 调度器已真实生效，展示下次触发时间 */}
          {trigger === 'cron' && nextRun && (
            <span className="text-accent">
              {t('panel.automations.next', { time: formatTime(nextRun) })}
            </span>
          )}
        </div>
      </div>

      {/* 第三行：提示词预览 */}
      <div className="text-xs text-text-tertiary mb-2 line-clamp-1">{prompt}</div>

      {/* 操作 */}
      <div className="flex items-center gap-1.5">
        <button
          onClick={onRun}
          className="h-7 px-2.5 rounded-md text-xs text-text-inverse bg-accent hover:bg-accent-hover transition-colors flex items-center gap-1"
        >
          <Icon.Play width={16} height={16} />
          {t('panel.automations.run_now')}
        </button>
        <button
          onClick={onToggle}
          className="h-7 px-2.5 rounded-md text-xs text-text-secondary border border-border-default hover:bg-bg-hover transition-colors"
        >
          {active ? t('panel.automations.pause') : t('panel.automations.enable')}
        </button>
        <button
          onClick={onEdit}
          className="h-7 px-2.5 rounded-md text-xs text-text-secondary border border-border-default hover:bg-bg-hover transition-colors"
        >
          {t('panel.automations.edit')}
        </button>
        <Tooltip label={t('panel.automations.delete_tooltip')} desc={t('panel.automations.delete_desc')} placement="left">
          <button
            onClick={onDelete}
            className="h-7 w-7 flex items-center justify-center rounded-md text-text-tertiary hover:text-danger hover:bg-bg-hover transition-colors ml-auto"
          >
            <Icon.Trash width={16} height={16} />
          </button>
        </Tooltip>
      </div>
    </div>
  )
}