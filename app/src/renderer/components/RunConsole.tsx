/* ============================================================
 * ArkWork — RunConsole (v0.5.0, B1 → v0.8.0 → v0.14.x Task 2)
 * 运行控制台：Composer 在 running / paused / failed / cancelled 态的变身形态。
 *
 * 职责：
 *   - 常驻 暂停/继续/停止 三键 + rAF 计时 + 人类可读动作描述
 *   - 暂停态渲染迷你 textarea，支持「追加指令后点继续」
 *   - 错误态展示 errorMessage + 重试按钮
 *   - v0.8.0：cancelled（含启动时回收的意外中断任务）→ 重新执行按钮
 *   - v0.27.1：ask_user 内嵌问答卡已移除——该场景由 Composer 槽位级的
 *     AskUserGate 独占接管（键盘可选、与输入框互斥不冲突），本组件
 *     只服务普通 running/paused/failed/cancelled 态。
 *
 * Task 2 — 文案已统一为「正在…」自然语言描述（executionDescription / reasoningDescription）；
 * 不再显示机械编号、步骤序号或每帧跳动的数字计时，避免抖动（不依赖 transition/transform）。
 *
 * 设计文档 §3.1.1 / §3.2.1
 * 纯展示 + 事件转发，状态由父组件（Composer）传入。
 * ============================================================ */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../icons'
import { Tooltip } from './ui'
import { executionDescription, reasoningDescription } from '../constants'
import { intentText } from '../utils/intent-text'
import { useStore } from '../store'
import { isImeComposing } from '@shared/utils/ime'

interface RunConsoleProps {
  status: 'running' | 'paused' | 'error' | 'cancelled'
  errorMessage?: string
  onPause: () => void
  onResume: () => void
  onCancel: () => void
  onRetry?: () => void
  onRerun?: () => void
  onAppendAndResume?: (text: string) => void
}

export function RunConsole({
  status,
  errorMessage,
  onPause,
  onResume,
  onCancel,
  onRetry,
  onRerun,
  onAppendAndResume,
}: RunConsoleProps) {
  const { t } = useTranslation('translation', { keyPrefix: 'runconsole' })
  const [appendText, setAppendText] = useState('')
  const appendRef = useRef<HTMLTextAreaElement>(null)

  // 暂停态聚焦追加输入框
  useEffect(() => {
    if (status === 'paused') {
      appendRef.current?.focus()
    }
  }, [status])

  // Task 2：从 store.steps 派生当前活动描述（替代机械步骤编号 / 跳动计时）
  //   - running：有 act step → 用该工具名；否则推理文案
  //   - paused/error/cancelled：复用最近一次 act step 的工具名 / 失败动作
  //   - 文案切换保持相同行高，不使用 transition，避免位置抖动
  const steps = useStore((s) => s.steps)
  // v0.24.x：限制 description 最大 40 字（输入区"Agent 正在干嘛"短描述原则）
  // 此前 lastAct.intent 来自 LLM thought，可能一整段话直接铺在输入框顶端，UI
  // 出现"运行控制台里塞了一篇思考"体感——参考 Trae harness / DeepSeek Harness，
  // 输入区只显式一个动作动词短语，不展开 thought 全文。
  const DESCRIPTION_MAX = 40
  const truncate40 = (s: string): string => {
    const cleaned = s.replace(/\n+/g, ' ').trim()
    return cleaned.length > DESCRIPTION_MAX ? cleaned.slice(0, DESCRIPTION_MAX) + '…' : cleaned
  }
  const description = useMemo(() => {
    const truncated = (raw: string): string => {
      // 先尝试按 40 字截断；若截断前末尾是省略号 / 句号，则不再附加 …
      const trimmed = truncate40(raw)
      return trimmed
    }
    if (status === 'running') {
      const lastAct = [...steps].reverse().find((s) => s.type === 'act')
      if (lastAct) {
        const failed = lastAct.status === 'failed'
        const raw = failed ? t('description.runError') : (intentText(lastAct) || executionDescription(lastAct.toolName))
        return truncated(raw)
      }
      const lastReason = [...steps].reverse().find((s) => s.type === 'reason')
      return truncated(reasoningDescription(lastReason ? 'finalizing' : 'thinking'))
    }
    if (status === 'paused') {
      const lastAct = [...steps].reverse().find((s) => s.type === 'act')
      const raw = lastAct
        ? t('description.pausedResume', {
            desc: (intentText(lastAct) || executionDescription(lastAct.toolName)).replace(/…$/, ''),
          })
        : t('description.pausedWait')
      return truncated(raw)
    }
    if (status === 'error') {
      return t('description.error')
    }
    if (status === 'cancelled') {
      return t('description.cancelled')
    }
    return truncated(reasoningDescription('thinking'))
  }, [status, steps, t])

  const handleAppendAndResume = () => {
    const text = appendText.trim()
    if (text && onAppendAndResume) {
      onAppendAndResume(text)
      setAppendText('')
    } else {
      onResume()
    }
  }

  const handleAppendKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // v0.26.x fix：IME 组合中的回车归输入法（确认拼音），不触发提交/续跑
    if (isImeComposing(e.nativeEvent)) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleAppendAndResume()
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      onResume()
    }
  }

  return (
    <div className="relative border-t border-border-subtle bg-bg-base flex-shrink-0">
      <div className="px-3 pt-2 pb-3">
        {/* 错误态：inline 错误信息 */}
        {status === 'error' && errorMessage && (
          <div className="error-card mb-2" style={{ margin: '0 0 8px 0' }}>
            <Icon.X width={16} height={16} className="text-danger flex-shrink-0" />
            <span className="error-card__message">{errorMessage}</span>
            {onRetry && (
              <button onClick={onRetry} className="error-card__retry">
                {t('retry')}
              </button>
            )}
          </div>
        )}

        {/* RunConsole 主体 */}
        <div className="run-console" data-state={status}>
          {/* 状态点 */}
          <span className="run-console__dot" />

          {/* 动作描述（Task 2：人类可读、无跳动数字、不抖动） */}
          <span className="run-console__meta" aria-live="polite">
            <span>{description}</span>
          </span>

          <div className="flex-1" />

          {/* 暂停态：追加指令输入框（v0.27.1 起 ask_user 场景由 AskUserGate 接管，
              到达本组件的暂停均为普通手动暂停，恒可追加指令） */}
          {status === 'paused' && (
            <div className="flex items-center gap-2 flex-1 max-w-[480px]">
              <textarea
                ref={appendRef}
                value={appendText}
                onChange={(e) => setAppendText(e.target.value)}
                onKeyDown={handleAppendKeyDown}
                placeholder={t('placeholder')}
                rows={1}
                className="flex-1 resize-none text-sm text-text-primary placeholder-text-tertiary bg-bg-input border border-border-subtle rounded-md px-3 py-2 focus:border-accent outline-none"
                style={{ minHeight: '60px', maxHeight: '160px' }}
              />
            </div>
          )}

          {/* v0.22.0 — DSH 风格运行控制按钮组：
              - 36px 高、6px 圆角胶囊（DSH Button atom outline / primary）
              - 继续 / 重执行：业务蓝主色
              - 暂停 / 停止：ghost 风格 + hover 浅红
              - 重试：危险色描边按钮 */}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {status === 'running' && (
              <Tooltip label={t('pause')} kbd="⌥⏸" desc={t('pauseTooltipDesc')} delay={150}>
                <button
                  onClick={onPause}
                  aria-label={t('pauseAria')}
                  className="flex items-center gap-1.5 h-9 px-3 rounded-md text-text-secondary hover:bg-bg-hover text-xs font-medium transition-colors focus-ring"
                >
                  <Icon.Pause width={14} height={14} />
                  {t('pause')}
                </button>
              </Tooltip>
            )}
            {status === 'paused' && (
              <Tooltip label={t('resumeTooltip')} kbd="⌥▶" desc={t('resumeTooltipDesc')} delay={150}>
                <button
                  onClick={handleAppendAndResume}
                  aria-label={t('resumeAria')}
                  className="flex items-center gap-1.5 h-9 px-3 rounded-md text-text-inverse text-xs font-medium transition-colors focus-ring"
                  style={{ background: 'var(--business-primary)' }}
                >
                  <Icon.Play width={14} height={14} />
                  {t('resume')}
                </button>
              </Tooltip>
            )}
            {status === 'error' && onRetry && (
              <Tooltip label={t('retry')} desc={t('retryTooltipDesc')} delay={150}>
                <button
                  onClick={onRetry}
                  aria-label={t('retry')}
                  className="flex items-center gap-1.5 h-9 px-3 rounded-md text-danger hover:bg-danger-soft text-xs font-medium transition-colors focus-ring"
                >
                  <Icon.Refresh width={14} height={14} />
                  {t('retry')}
                </button>
              </Tooltip>
            )}
            {status === 'cancelled' && onRerun && (
              <Tooltip label={t('rerunTask')} desc={t('rerunTooltipDesc')} delay={150}>
                <button
                  onClick={onRerun}
                  aria-label={t('rerunAria')}
                  className="flex items-center gap-1.5 h-9 px-3 rounded-md text-text-inverse text-xs font-medium transition-colors focus-ring"
                  style={{ background: 'var(--business-primary)' }}
                >
                  <Icon.Refresh width={14} height={14} />
                  {t('rerun')}
                </button>
              </Tooltip>
            )}
            {status !== 'cancelled' && (
              <Tooltip label={t('stop')} kbd="Esc" desc={t('stopTooltipDesc')} delay={150}>
                <button
                  onClick={onCancel}
                  aria-label={t('stopAria')}
                  className="flex items-center gap-1.5 h-9 px-3 rounded-md text-text-tertiary hover:text-danger hover:bg-danger-soft text-xs font-medium transition-colors focus-ring"
                >
                  <Icon.Stop width={14} height={14} />
                  {t('stop')}
                </button>
              </Tooltip>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
