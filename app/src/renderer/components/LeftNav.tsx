/* ============================================================
 * ArkWork — LeftNav (v0.9.0 F900)
 * 全局导航：左侧收编全部「非任务相关内容」
 * - 主按钮：「+ 新建任务」（⌘N）— 冷启动第一动作，视觉权重最高
 * - 任务列表：既有 TasksPanel 能力整体平移（时间分组 / 搜索 / 右键菜单 / 运行中脉冲）
 * - 分隔线：之上 = 任务，之下 = 全局模块
 * - 全局模块：⏰自动化 / ⚡能力 / 🤖智能体 / 📚知识库 / 🧠记忆 → CenterStage 整页切换
 * - 底部：⚙设置 / 折叠按钮（⌘B → 64px 图标栏 = ActivityBar 折叠态）
 * ============================================================ */
import { useStore, type ModulePage } from '../store'
import { useTranslation } from 'react-i18next'
import { Icon } from '../icons'
import { Tooltip } from './ui'
import { TasksPanel } from './panels/TasksPanel'

/** 全局模块行定义（图标 + 标签 + 对应 CenterStage 模块页）；label 为 i18n key，渲染处 t(label) 取值 */
const MODULES: { page: ModulePage; icon: keyof typeof Icon; label: string }[] = [
  { page: 'automations', icon: 'Clock', label: 'leftnav.modules.automations' },
  { page: 'skills', icon: 'Bolt', label: 'leftnav.modules.skills' },
  { page: 'agents', icon: 'Bot', label: 'leftnav.modules.agents' },
  { page: 'kb', icon: 'Book', label: 'leftnav.modules.kb' },
  { page: 'memory', icon: 'Brain', label: 'leftnav.modules.memory' },
]

export function LeftNav() {
  const leftNavCollapsed = useStore((s) => s.leftNavCollapsed)
  const { t } = useTranslation()

  // 折叠态 = v0.7.0 ActivityBar 交互（图标栏），组件复用不删除
  if (leftNavCollapsed) return <ActivityBar />

  return (
    <div className="flex flex-col w-60 h-full bg-bg-base border-r border-border-subtle flex-shrink-0 select-none min-w-0">
      {/* 紧凑主操作：单一新建入口 + 就近折叠 */}
      <div className="p-2 pb-1.5 flex-shrink-0 flex items-center gap-1.5">
        <NewTaskButton />
        <Tooltip label={t('leftnav.collapse.title')} kbd="⌘B" placement="right" delay={150}>
          <button
            onClick={() => useStore.getState().toggleLeftNav()}
            className="w-8 h-8 flex-shrink-0 flex items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-colors focus-ring"
            aria-label={`${t('leftnav.collapse.title')} ⌘B`}
          >
            <Icon.ChevronLeft width={16} height={16} />
          </button>
        </Tooltip>
      </div>

      {/* 任务列表 */}
      <div className="flex-1 min-h-0 border-t border-border-subtle">
        <TasksPanel />
      </div>

      {/* 全局模块：保持纵向单列列表 */}
      <div className="flex-shrink-0 border-t border-border-subtle py-1.5 px-1.5">
        <div className="px-2 py-1 text-2xs text-text-tertiary uppercase tracking-wider font-semibold">
          {t('leftnav.global')}
        </div>
        <div className="space-y-0.5">
          {MODULES.map((m) => (
            <ModuleRow key={m.page} page={m.page} icon={m.icon} label={t(m.label)} />
          ))}
        </div>
      </div>
    </div>
  )
}

/* ============================================================
 * NewTaskButton — 「+ 新建任务」主按钮
 * ============================================================ */
function NewTaskButton() {
  const createTask = useStore((s) => s.createTask)
  const { t } = useTranslation()
  return (
    <Tooltip label={t('leftnav.newTask.title')} kbd="⌘N" desc={t('leftnav.newTask.desc')}>
      <button
        onClick={() => void createTask({ title: '', text: '' })}
        className="flex-1 flex items-center justify-center gap-1.5 h-8 rounded-md bg-accent hover:bg-accent-hover active:scale-[0.98] text-text-inverse text-xs font-medium transition-[color,background-color,transform] focus-ring"
      >
        <Icon.Plus width={16} height={16} />
        {t('leftnav.newTask.title')}
      </button>
    </Tooltip>
  )
}

/* ============================================================
 * ModuleRow — 全局模块行（图标 + 文字 + 徽标；点击打开模块页）
 * ============================================================ */
function ModuleRow({
  page,
  icon,
  label,
}: {
  page: ModulePage
  icon: keyof typeof Icon
  label: string
}) {
  const modulePage = useStore((s) => s.modulePage)
  const openModulePage = useStore((s) => s.openModulePage)
  const automations = useStore((s) => s.automations)
  const knowledgeBases = useStore((s) => s.knowledgeBases)
  const skills = useStore((s) => s.skills)
  const mcps = useStore((s) => s.mcps)
  const memory = useStore((s) => s.memory)
  const IconComp = Icon[icon]
  const active = modulePage === page
  const { t } = useTranslation()

  // 徽标（沿用 v0.8.0 口径的简化版）：自动化=启用数，能力=技能+插件，知识库=条目数，记忆=生效上下文数
  let badge = 0
  if (page === 'automations') badge = automations.filter((a) => a.status === 'active').length
  else if (page === 'skills') badge = skills.length + mcps.length
  else if (page === 'kb') badge = knowledgeBases.length
  else if (page === 'memory') badge = memory.filter((m) => m.enabled && !m.archivedAt).length

  // 模块页 L2 描述（v0.12.0 Tooltip 增强）
  const descriptions: Record<ModulePage, string> = {
    automations: t('leftnav.descriptions.automations'),
    // v0.24.2：能力中心统一收纳技能 + MCP 插件
    skills: t('leftnav.descriptions.skills'),
    agents: t('leftnav.descriptions.agents'),
    kb: t('leftnav.descriptions.kb'),
    memory: t('leftnav.descriptions.memory'),
    // redesign-workspace-navigation Task 3：settings 已加入 ModulePage 联合类型。
    // LeftNav 实际不再挂载（被 Sidebar CapabilityEntries 替代），此处仅为通过 typecheck。
    settings: t('leftnav.descriptions.settings'),
  }

  return (
    <Tooltip label={label} desc={descriptions[page]}>
      <button
        onClick={() => openModulePage(page)}
        className={`w-full flex items-center gap-2 h-8 px-3 rounded-md text-sm transition-colors ${
          active
            ? 'bg-bg-surface text-text-primary'
            : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
        }`}
      >
        <IconComp width={18} height={18} className={active ? 'text-accent' : 'text-text-tertiary'} />
      <span className="flex-1 text-left truncate">{label}</span>
      {badge > 0 && (
        <span className="text-2xs text-text-tertiary tabular px-1.5 py-px rounded-full bg-bg-hover">
          {badge}
        </span>
      )}
      </button>
    </Tooltip>
  )
}

/* ============================================================
 * ActivityBar — v0.7.0 组件的 v0.9.0 归宿：LeftNav 折叠态（64px 图标栏）
 * 点击模块直接跳转模块页；点击任务/新建展开左栏。组件复用不删除。
 * ============================================================ */
function ActivityBar() {
  const toggleLeftNav = useStore((s) => s.toggleLeftNav)
  const openModulePage = useStore((s) => s.openModulePage)
  const createTask = useStore((s) => s.createTask)
  const tasks = useStore((s) => s.tasks)
  const runningTasks = tasks.some((t) => t.status === 'running')
  // v3.0：ActivityBar 也响应模块页 active 状态（响应式订阅，而非 getState 快照）
  const activeModulePage = useStore((s) => s.modulePage)
  const { t } = useTranslation()

  const moduleIcons: { page: ModulePage; icon: keyof typeof Icon; label: string }[] = [
    { page: 'automations', icon: 'Clock', label: 'leftnav.modules.automations' },
    { page: 'skills', icon: 'Bolt', label: 'leftnav.modules.skills' },
    { page: 'agents', icon: 'Bot', label: 'leftnav.modules.agents' },
    { page: 'kb', icon: 'Book', label: 'leftnav.modules.kb' },
    { page: 'memory', icon: 'Brain', label: 'leftnav.modules.memory' },
  ]

  return (
    <div className="flex flex-col items-center w-16 h-full bg-bg-base border-r border-border-subtle select-none flex-shrink-0">
      {/* 展开入口紧邻任务列表，避免落在侧栏最下方 */}
      <div className="flex flex-col items-center gap-1 pt-2">
        <Tooltip label={`${t('leftnav.expand.title')} ⌘B`} placement="right">
          <button
            onClick={toggleLeftNav}
            className="w-9 h-9 flex items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-colors"
            aria-label={t('leftnav.expand.title')}
          >
            <Icon.ChevronRight width={18} height={18} />
          </button>
        </Tooltip>

        {/* 新建任务 */}
        <Tooltip label={`${t('leftnav.newTask.title')} ⌘N`} placement="right">
          <button
            onClick={() => void createTask({ title: '', text: '' })}
            className="relative w-9 h-9 flex items-center justify-center rounded-md bg-accent hover:bg-accent-hover text-text-inverse transition-colors"
            aria-label={t('leftnav.newTask.title')}
          >
            <Icon.Plus width={18} height={18} />
          </button>
        </Tooltip>

        {/* 任务列表（点击展开左栏） */}
        <Tooltip label={`${t('leftnav.taskList.title')} ⌘B`} placement="right">
          <button
            onClick={toggleLeftNav}
            className="relative w-9 h-9 flex items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-colors"
            aria-label={t('leftnav.taskList.title')}
          >
            <Icon.List width={18} height={18} />
            {runningTasks && (
              <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-accent pulse-dot" />
            )}
          </button>
        </Tooltip>

        <div className="w-8 h-px bg-border-subtle my-1" />

        {/* 全局模块 */}
        {moduleIcons.map((m) => {
          const IconComp = Icon[m.icon]
          const active = activeModulePage === m.page
          const entryLabel = t(m.label)
          return (
            <Tooltip key={m.page} label={entryLabel} placement="right" delay={150}>
              <button
                onClick={() => openModulePage(m.page)}
                className={`w-9 h-9 flex items-center justify-center rounded-md transition-colors focus-ring ${
                  active
                    ? 'bg-accent-soft text-accent'
                    : 'text-text-tertiary hover:bg-bg-hover hover:text-text-primary'
                }`}
                aria-label={entryLabel}
              >
                <IconComp width={18} height={18} />
              </button>
            </Tooltip>
          )
        })}
      </div>
    </div>
  )
}
