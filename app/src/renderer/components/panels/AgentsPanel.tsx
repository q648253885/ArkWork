/* ============================================================
 * ArkWork — AgentsPanel (Task 3)
 * 智能体独立面板：从 SkillsExpertsPanel 拆分而来。
 *  - 只展示智能体列表、创建/编辑与相关操作
 *  - 不再渲染技能或市场 Tab
 *  - AgentEditor 弹窗生命周期由面板自身管理（agent + open 状态）
 * ============================================================ */
import { useState } from 'react'
import { Icon } from '../../icons'
import { useStore } from '../../store'
import { Tooltip, SectionLabel, EmptyState } from '../ui'
import { AgentEditor } from '../AgentEditor'
import type { Agent } from '../../types'

export function AgentsPanel() {
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null)
  const [agentEditorOpen, setAgentEditorOpen] = useState(false)

  const openAgentEditor = (agent: Agent | null) => {
    setEditingAgent(agent)
    setAgentEditorOpen(true)
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto">
        <AgentsView onEdit={openAgentEditor} />
      </div>

      {/* 智能体编辑器弹窗：保留原 SkillsExpertsPanel 中的生命周期管理 */}
      {agentEditorOpen && (
        <AgentEditor
          agent={editingAgent}
          onClose={() => {
            setAgentEditorOpen(false)
            setEditingAgent(null)
          }}
        />
      )}
    </div>
  )
}

/* ============================================================
 * Agents — 智能体卡片墙
 * ============================================================ */
function AgentsView({ onEdit }: { onEdit: (agent: Agent | null) => void }) {
  const agents = useStore((s) => s.agents)
  const skills = useStore((s) => s.skills)
  const setSelectedAgent = useStore((s) => s.setSelectedAgent)
  const createTask = useStore((s) => s.createTask)

  if (agents.length === 0) {
    return (
      <div className="p-3">
        <div className="mb-3">
          <button
            onClick={() => onEdit(null)}
            className="flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium text-text-inverse bg-accent hover:bg-accent-hover transition-colors"
          >
            <Icon.Plus width={16} height={16} />
            新建智能体
          </button>
        </div>
        <EmptyState
          icon={<Icon.Bot width={22} height={22} />}
          title="暂无智能体"
          hint="创建智能体后可在此管理"
        />
      </div>
    )
  }

  return (
    <div className="p-3">
      <div className="flex items-center gap-2 mb-3">
        <SectionLabel>智能体（{agents.length}）</SectionLabel>
        <button
          onClick={() => onEdit(null)}
          className="ml-auto flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium text-text-inverse bg-accent hover:bg-accent-hover transition-colors"
        >
          <Icon.Plus width={16} height={16} />
          新建
        </button>
      </div>
      <div className="grid grid-cols-1 gap-2.5">
        {agents.map((a) => {
          const chips = a.defaultSkillIds
            .map((id) => skills.find((s) => s.id === id)?.name)
            .filter((n): n is string => !!n)
            .slice(0, 3)
          return (
            <AgentCard
              key={a.id}
              agent={a}
              chips={chips}
              onStart={() => {
                setSelectedAgent(a.id)
                void createTask({ title: `与 @${a.name} 对话`, text: '' })
              }}
              onEdit={() => onEdit(a)}
            />
          )
        })}
      </div>
    </div>
  )
}

function AgentCard({
  agent,
  chips,
  onStart,
  onEdit,
}: {
  agent: Agent
  chips: string[]
  onStart: () => void
  onEdit: () => void
}) {
  const successRate = agent.metrics
    ? agent.metrics.uses > 0
      ? Math.round((agent.metrics.success / agent.metrics.uses) * 100)
      : null
    : null

  return (
    <div className="p-3 rounded-lg bg-bg-surface border border-border-subtle hover:border-border-default transition-colors">
      <div className="flex items-start gap-2.5">
        {/* 头像 */}
        <div
          className="w-10 h-10 rounded-lg flex items-center justify-center text-sm font-semibold text-white flex-shrink-0"
          style={{ background: agent.avatarColor }}
        >
          {agent.name[0]?.toUpperCase() ?? '?'}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5">
            <span className="text-sm text-text-primary font-medium truncate">@{agent.name}</span>
            {agent.isBuiltin && (
              <Tooltip label="内置智能体">
                <span className="flex-shrink-0">
                  <Icon.Lock width={16} height={16} className="text-text-tertiary" />
                </span>
              </Tooltip>
            )}
          </div>
          <div className="text-xs text-text-secondary mb-1.5 truncate">
            {agent.role || agent.description || '（无描述）'}
          </div>
          {/* 技能 chips */}
          {chips.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-1.5">
              {chips.map((c) => (
                <span
                  key={c}
                  className="text-2xs px-1.5 py-0.5 rounded bg-bg-hover text-text-tertiary"
                >
                  {c}
                </span>
              ))}
              {agent.defaultSkillIds.length > 3 && (
                <span className="text-2xs px-1.5 py-0.5 text-text-tertiary">
                  +{agent.defaultSkillIds.length - 3}
                </span>
              )}
            </div>
          )}
          {/* 指标 */}
          <div className="text-2xs text-text-tertiary flex items-center gap-2 tabular">
            {successRate !== null && (
              <span className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-success" />
                成功率 {successRate}%
              </span>
            )}
            <span>技能 {agent.defaultSkillIds.length}</span>
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 mt-2.5">
        <button
          onClick={onStart}
          className="flex-1 h-7 rounded-md text-xs font-medium text-text-inverse bg-accent hover:bg-accent-hover transition-colors flex items-center justify-center gap-1"
        >
          <Icon.Play width={16} height={16} />
          开始任务
        </button>
        <button
          onClick={onEdit}
          className="h-7 px-2.5 rounded-md text-xs text-text-secondary border border-border-default hover:bg-bg-hover hover:text-text-primary transition-colors"
        >
          编辑
        </button>
      </div>
    </div>
  )
}