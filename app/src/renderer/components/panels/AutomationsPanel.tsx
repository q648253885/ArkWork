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

/** 中文工作日名（周一~周日） */
const WEEKDAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'] as const

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
const CRON_PRESETS: { label: string; expr: string }[] = [
  { label: '每天 9:00', expr: '0 9 * * *' },
  { label: '每个工作日 9:00', expr: '0 9 * * 1-5' },
  { label: '每周一 9:00', expr: '0 9 * * 1' },
  { label: '每小时整点', expr: '0 * * * *' },
  { label: '每天 0:00', expr: '0 0 * * *' },
]

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
      return `只跑一次 ${hm}`
    case 'daily':
      return `每天 ${hm}`
    case 'weekdays':
      return `每个工作日 ${hm}`
    case 'weekends':
      return `每个周末 ${hm}`
    case 'weekly': {
      if (!weekdays || weekdays.length === 0) return '每周 ? ' + hm
      const names = weekdays
        .slice()
        .sort((a, b) => a - b)
        .map((w) => WEEKDAY_NAMES[w === 0 ? 6 : w - 1])
      return `每周 ${names.join('/')} ${hm}`
    }
    case 'monthly':
      return `每月 ${monthDay} 日 ${hm}`
    case 'custom':
      return `自定义 cron: ${cronExpr || '—'}`
  }
}

export function AutomationsPanel() {
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
        pushToast({ type: 'danger', message: '请选择至少一个工作日', duration: 5000 })
        return
      }
      const expr = normalizeCron(form.cronExpr)
      if (!expr) {
        pushToast({ type: 'danger', message: '请填写定时时间：可直接选择上方"常用预设"（如"每天 9:00"）', duration: 5000 })
        return
      }
      if (!isValidCronInput(expr)) {
        pushToast({
          type: 'danger',
          message: `定时时间无效：${expr}。格式为 分 时 日 月 周，如 0 9 * * 1-5（工作日 9:00），或选择上方常用预设`,
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
        <span className="text-sm text-text-primary font-medium">自动化</span>
        <span className="text-2xs text-text-tertiary">{autos.length}</span>
        {!showForm && (
          <Tooltip label="新建自动化" desc="定时任务 / 触发器配置">
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
              {editingId ? '编辑自动化' : '新建自动化'}
            </div>

            {/* 名称 */}
            <div className="space-y-1">
              <label className="block text-xs text-text-secondary">名称</label>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="如：每日代码审查"
                className="w-full h-8 px-3 text-xs rounded-md bg-bg-input border border-border-default focus:border-accent outline-none"
              />
            </div>

            {/* 提示词 */}
            <div className="space-y-1">
              <label className="block text-xs text-text-secondary">提示词</label>
              <textarea
                value={form.prompt}
                onChange={(e) => setForm({ ...form, prompt: e.target.value })}
                placeholder="如：检查最近的 git 提交并生成代码审查报告"
                rows={3}
                className="w-full px-3 py-2 text-xs rounded-md bg-bg-input border border-border-default focus:border-accent outline-none resize-none"
              />
            </div>

            {/* Agent */}
            <div className="space-y-1">
              <label className="block text-xs text-text-secondary">Agent</label>
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
              <label className="block text-xs text-text-secondary">大模型</label>
              <select
                value={form.modelId}
                onChange={(e) => setForm({ ...form, modelId: e.target.value })}
                className="w-full h-8 px-2 text-xs rounded-md bg-bg-input border border-border-default focus:border-accent outline-none"
              >
                <option value="">跟随 Agent 默认</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
              {models.length === 0 && (
                <div className="text-2xs text-text-tertiary">无可用模型，请到设置配置</div>
              )}
            </div>

            {/* 触发方式 */}
            <div className="space-y-1">
              <label className="block text-xs text-text-secondary">触发方式</label>
              <select
                value={form.trigger}
                onChange={(e) => setForm({ ...form, trigger: e.target.value as 'manual' | 'cron' })}
                className="w-full h-8 px-2 text-xs rounded-md bg-bg-input border border-border-default focus:border-accent outline-none"
              >
                <option value="manual">手动触发</option>
                <option value="cron">定时触发</option>
              </select>
            </div>

            {/* 定时时间（仅 cron）：三段式 UI */}
            {form.trigger === 'cron' && (
              <div className="space-y-2">
                <label className="block text-xs text-text-secondary">定时时间</label>

                {/* 段一：频率 chip 组（单选） */}
                <div className="flex flex-wrap gap-1.5">
                  {([
                    { value: 'once', label: '只跑一次' },
                    { value: 'daily', label: '每天' },
                    { value: 'weekdays', label: '每个工作日' },
                    { value: 'weekends', label: '每个周末' },
                    { value: 'weekly', label: '每周' },
                    { value: 'monthly', label: '每月' },
                    { value: 'custom', label: '自定义 cron' },
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
                      aria-label="小时"
                    />
                    <span className="text-text-tertiary text-xs">:</span>
                    <input
                      type="number"
                      min={0}
                      max={59}
                      value={form.minute}
                      onChange={(e) => handleMinuteChange(e.target.value)}
                      className="w-14 h-8 px-2 text-xs text-center rounded-md bg-bg-input border border-border-default focus:border-accent outline-none"
                      aria-label="分钟"
                    />
                  </div>
                )}

                {/* 段三：按频率的额外配置 */}
                {form.freqMode === 'weekly' && (
                  <div className="flex flex-wrap gap-1.5">
                    {[1, 2, 3, 4, 5, 6, 0].map((w) => {
                      const active = form.weekdays.includes(w)
                      const label = WEEKDAY_NAMES[w === 0 ? 6 : w - 1]
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
                    aria-label="每月几号"
                  >
                    {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                      <option key={d} value={d}>
                        {d} 日
                      </option>
                    ))}
                  </select>
                )}

                {/* 段四：摘要行（始终显示） */}
                <div className="text-2xs text-text-tertiary">
                  {buildSummary(
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
                        <option value="" disabled>常用预设…</option>
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
                        placeholder="cron 表达式（如：0 9 * * 1-5）"
                        className="flex-1 min-w-0 h-8 px-3 text-xs font-mono rounded-md bg-bg-input border border-border-default focus:border-accent outline-none"
                      />
                    </div>
                    {!normalizedCron && (
                      <div className="text-2xs text-text-tertiary">
                        格式：分 时 日 月 周，如 0 9 * * 1-5（工作日 9:00）；可直接选上方常用预设
                      </div>
                    )}
                    {normalizedCron && !cronOk && (
                      <div className="text-2xs text-danger">
                        cron 表达式无效 · 格式：分 时 日 月 周（如 0 9 * * 1-5 = 工作日 9:00）
                      </div>
                    )}
                  </div>
                ) : (
                  <input
                    value={form.cronExpr}
                    disabled
                    aria-label="当前 cron 表达式（由可视化配置生成）"
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
                取消
              </button>
              <button
                onClick={() => void submit()}
                disabled={!form.name.trim() || !form.prompt.trim()}
                className="h-8 px-4 rounded-md text-xs font-medium text-text-inverse bg-accent hover:bg-accent-hover transition-colors disabled:opacity-50"
              >
                创建
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
            title="还没有自动化任务"
            hint="预设 Agent 和提示词，一键或定时执行"
            action={
              <button
                onClick={openCreateForm}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-medium text-text-inverse bg-accent hover:bg-accent-hover transition-colors"
              >
                <Icon.Plus width={16} height={16} />
                创建自动化
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
          {active ? '运行中' : '已暂停'}
        </span>
      </div>

      {/* 第二行：触发类型 / 计划 / 上次运行 / 下次运行 */}
      <div className="text-2xs text-text-tertiary mb-1.5 space-y-0.5">
        <div className="font-mono">
          {trigger === 'cron' ? `⏰ 计划：${cronExpr ?? '—'}` : '👆 手动触发'} · @{agentId}
        </div>
        <div>
          {lastRun ? `上次运行：${formatTime(lastRun)}` : '尚未运行'}
          {/* v0.9.1：cron 调度器已真实生效，展示下次触发时间 */}
          {trigger === 'cron' && nextRun && (
            <span className="text-accent"> · 下次：{formatTime(nextRun)}</span>
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
          立即运行
        </button>
        <button
          onClick={onToggle}
          className="h-7 px-2.5 rounded-md text-xs text-text-secondary border border-border-default hover:bg-bg-hover transition-colors"
        >
          {active ? '暂停' : '启用'}
        </button>
        <button
          onClick={onEdit}
          className="h-7 px-2.5 rounded-md text-xs text-text-secondary border border-border-default hover:bg-bg-hover transition-colors"
        >
          编辑
        </button>
        <Tooltip label="删除自动化" desc="确认后删除，任务数据保留在磁盘" placement="left">
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