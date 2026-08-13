/* ============================================================
 * ArkWork — OnboardingLayer (v0.5.0 / B7)
 * 首次启动 3 步引导清单。非模态浮层（z-onboarding < dialog），
 * 不阻断主交互。3 步全过或点「跳过」即写入 localStorage 永久隐藏。
 * 触发：!onboardingDone && (models.length===0 || workspaces.length<=1 || tasks.length===0)
 * ============================================================ */
import { useEffect, useState } from 'react'
import { Icon } from '../icons'
import { Brand } from './Brand'
import { useStore } from '../store'

const ONBOARDING_KEY = 'arkwork:onboarding-done'

function loadDone(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_KEY) === '1'
  } catch {
    return false
  }
}

function saveDone(): void {
  try {
    localStorage.setItem(ONBOARDING_KEY, '1')
  } catch {
    /* ignore */
  }
}

interface Step {
  id: string
  title: string
  desc: string
  done: boolean
  actionLabel: string
  onAction: () => void
}

export function OnboardingLayer() {
  const [dismissed, setDismissed] = useState(() => loadDone())

  const models = useStore((s) => s.models)
  const workspaces = useStore((s) => s.workspaces)
  const tasks = useStore((s) => s.tasks)
  const conversation = useStore((s) => s.conversation)
  const setSettingsTab = useStore((s) => s.setSettingsTab)
  const openModulePage = useStore((s) => s.openModulePage)
  const createWorkspace = useStore((s) => s.createWorkspace)
  const createTask = useStore((s) => s.createTask)

  const steps: Step[] = [
    {
      id: 'models',
      title: '配置模型',
      desc: '在设置中填入 API Key 并选择默认模型',
      done: models.length > 0,
      actionLabel: '去配置',
      onAction: () => {
        setSettingsTab('models')
        openModulePage('settings')
      },
    },
    {
      id: 'workspace',
      title: '打开工作区',
      desc: '关联一个本地文件夹，任务将保存在其中',
      done: workspaces.length > 1,
      actionLabel: '打开文件夹',
      onAction: () => void createWorkspace(),
    },
    {
      id: 'task',
      title: '开始首个任务',
      desc: '在下方输入框描述你的需求，回车发送',
      done: conversation.length > 0,
      actionLabel: tasks.length === 0 ? '新建任务' : '查看任务',
      onAction: () => {
        if (tasks.length === 0) void createTask({ title: '', text: '' })
      },
    },
  ]

  const allDone = steps.every((s) => s.done)
  // 触发条件：未完成引导 且 任一步骤未达标
  const shouldShow =
    !dismissed && !allDone && (models.length === 0 || workspaces.length <= 1 || tasks.length === 0)

  // 全部完成 → 持久化并隐藏
  useEffect(() => {
    if (allDone && !dismissed) {
      saveDone()
      setDismissed(true)
    }
  }, [allDone, dismissed])

  if (!shouldShow) return null

  const handleSkip = () => {
    saveDone()
    setDismissed(true)
  }

  return (
    <div
      className="fixed bottom-12 right-4 w-72 z-[45] bg-bg-overlay border border-border-default rounded-lg shadow-panel scale-in"
      role="region"
      aria-label="新手引导"
    >
      {/* 头部 */}
      <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-border-subtle">
        <Brand size={16} />
        <span className="text-sm text-text-primary font-medium">欢迎使用 ArkWork</span>
        <button
          onClick={handleSkip}
          className="ml-auto w-6 h-6 flex items-center justify-center rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
          aria-label="跳过引导"
        >
          <Icon.X width={16} height={16} />
        </button>
      </div>

      {/* 步骤清单 */}
      <div className="p-2 space-y-0.5">
        {steps.map((step, i) => (
          <div
            key={step.id}
            className="flex items-start gap-2.5 px-2 py-2 rounded-md hover:bg-bg-hover transition-colors"
          >
            <div className="flex-shrink-0 mt-0.5">
              {step.done ? (
                <span className="w-5 h-5 rounded-full bg-success/15 text-success flex items-center justify-center">
                  <Icon.Check width={16} height={16} />
                </span>
              ) : (
                <span className="w-5 h-5 rounded-full border border-border-default text-text-tertiary flex items-center justify-center text-2xs font-medium tabular">
                  {i + 1}
                </span>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div
                className={`text-sm font-medium ${
                  step.done ? 'text-text-tertiary line-through' : 'text-text-primary'
                }`}
              >
                {step.title}
              </div>
              <div className="text-2xs text-text-tertiary leading-relaxed mt-0.5">{step.desc}</div>
              {!step.done && (
                <button
                  onClick={step.onAction}
                  className="mt-1.5 text-2xs text-accent hover:text-accent-hover font-medium transition-colors"
                >
                  {step.actionLabel} →
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* 底部跳过 */}
      <div className="px-3.5 py-2 border-t border-border-subtle flex items-center justify-between">
        <span className="text-2xs text-text-tertiary">
          {steps.filter((s) => s.done).length}/{steps.length} 完成
        </span>
        <button
          onClick={handleSkip}
          className="text-2xs text-text-tertiary hover:text-text-primary transition-colors"
        >
          跳过
        </button>
      </div>
    </div>
  )
}
