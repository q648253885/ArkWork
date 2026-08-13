/* ============================================================
 * ArkWork — RunConsole (v0.5.0, B1 → v0.8.0 → v0.14.x Task 2)
 * 运行控制台：Composer 在 running / paused / failed / cancelled 态的变身形态。
 *
 * 职责：
 *   - 常驻 暂停/继续/停止 三键 + rAF 计时 + 人类可读动作描述
 *   - 暂停态渲染迷你 textarea，支持「追加指令后点继续」
 *   - 错误态展示 errorMessage + 重试按钮
 *   - v0.8.0：cancelled（含启动时回收的意外中断任务）→ 重新执行按钮
 *
 * Task 2 — 文案已统一为「正在…」自然语言描述（executionDescription / reasoningDescription）；
 * 不再显示机械编号、步骤序号或每帧跳动的数字计时，避免抖动（不依赖 transition/transform）。
 *
 * 设计文档 §3.1.1 / §3.2.1
 * 纯展示 + 事件转发，状态由父组件（Composer）传入。
 * ============================================================ */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../icons'
import { Tooltip } from './ui'
import { SuggestionCards } from './SuggestionCards'
import { executionDescription, reasoningDescription } from '../constants'
import { useStore } from '../store'

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
  const [appendText, setAppendText] = useState('')
  const appendRef = useRef<HTMLTextAreaElement>(null)
  // v0.16.x：ask_user 暂停态专属「自定义回答」输入（与底部 textarea 隔离，
  // 各自持有独立的 value，避免相互串扰）。
  const [askUserCustomText, setAskUserCustomText] = useState('')

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
  // ask_user 暂停态：Agent 提问全文（非 ask_user 暂停时为 null，不展示卡片）
  const askUserQuestion = useStore((s) => s.askUserQuestion)
  const suggestions = useStore((s) => s.suggestions)
  const description = useMemo(() => {
    if (status === 'running') {
      const lastAct = [...steps].reverse().find((s) => s.type === 'act')
      if (lastAct) {
        const failed = lastAct.status === 'failed'
        return failed ? '工具调用失败，正在处理…' : executionDescription(lastAct.toolName)
      }
      const lastReason = [...steps].reverse().find((s) => s.type === 'reason')
      return reasoningDescription(lastReason ? 'finalizing' : 'thinking')
    }
    if (status === 'paused') {
      const lastAct = [...steps].reverse().find((s) => s.type === 'act')
      return lastAct ? `${executionDescription(lastAct.toolName).replace(/…$/, '')}（已暂停）` : '已暂停 · 等待你的指令…'
    }
    if (status === 'error') {
      return '运行出错 · 请查看上方错误信息'
    }
    if (status === 'cancelled') {
      return '已中断 · 可点击右侧重新执行'
    }
    return reasoningDescription('thinking')
  }, [status, steps])

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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleAppendAndResume()
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      onResume()
    }
  }

  // v0.16.x：ask_user 暂停态「自定义回答」提交 — 文本经 onAppendAndResume
  // 走 appendMessage → runTask 通道，与点击建议卡片路径一致。提交后清空输入框。
  const submitAskUserCustom = () => {
    const text = askUserCustomText.trim()
    if (!text || !onAppendAndResume) return
    onAppendAndResume(text)
    setAskUserCustomText('')
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
                重试
              </button>
            )}
          </div>
        )}

        {/* ask_user 暂停态：明确展示 Agent 问题全文，用户无需翻阅思考块 */}
        {status === 'paused' && askUserQuestion && (
          <div className="rounded-lg bg-accent-soft/50 border border-accent/30 px-3 py-2 mb-2 text-sm text-text-primary whitespace-pre-wrap break-words">
            需要你处理：{askUserQuestion}
            {/* v0.16.7+：ask_user 暂停态同步渲染建议卡片（紧贴问题下方，不在
                ConversationFlow 里），点击建议直接调 onAppendAndResume 触发续聊。
                之前 Suggestions 只渲染在 ConversationFlow 末尾，用户需滚动到
                历史消息区才能看到，体感像是"没出选项对话框"。 */}
            {suggestions.length > 0 && onAppendAndResume && (
              <div className="mt-2">
                <SuggestionCards
                  suggestions={suggestions}
                  onSelect={(s) => {
                    onAppendAndResume(s.label)
                  }}
                />
              </div>
            )}
            {/* v0.16.x：选项都不符合时 — 紧贴问题下方提供「自定义回答」输入区，
                用户可直接键入补充内容后点「提交」续聊，无需回到底部 textarea。
                提交走与建议卡片相同的 onAppendAndResume 通道（appendMessage → runTask）。 */}
            {onAppendAndResume && (
              <div className="mt-2">
                <div className="flex items-center gap-1.5 mb-1.5 px-0.5">
                  <Icon.Edit width={12} height={12} className="text-text-tertiary flex-shrink-0" />
                  <span className="text-2xs text-text-tertiary uppercase tracking-wider font-medium">
                    都不符合？自己说
                  </span>
                </div>
                <div className="flex items-start gap-2">
                  <textarea
                    value={askUserCustomText}
                    onChange={(e) => setAskUserCustomText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        submitAskUserCustom()
                      }
                    }}
                    placeholder="输入你想补充的指令后回车提交…（Shift+Enter 换行）"
                    rows={1}
                    className="flex-1 resize-none text-sm text-text-primary placeholder-text-tertiary bg-bg-input border border-border-subtle rounded-md px-3 py-1.5 focus:border-accent outline-none"
                    style={{ minHeight: '36px', maxHeight: '120px' }}
                  />
                  <button
                    onClick={submitAskUserCustom}
                    disabled={askUserCustomText.trim().length === 0}
                    aria-label="提交自定义回答"
                    className="inline-flex items-center gap-1 h-9 px-3 rounded-md bg-accent hover:bg-accent-hover disabled:bg-bg-hover disabled:text-text-tertiary text-text-inverse text-xs font-medium transition-colors focus-ring disabled:cursor-not-allowed"
                  >
                    <Icon.Send width={12} height={12} />
                    提交
                  </button>
                </div>
              </div>
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

          {/* 暂停态：追加指令输入框 */}
          {status === 'paused' && (
            <div className="flex items-center gap-2 flex-1 max-w-[480px]">
              <textarea
                ref={appendRef}
                value={appendText}
                onChange={(e) => setAppendText(e.target.value)}
                onKeyDown={handleAppendKeyDown}
                placeholder="追加指令后点继续…（留空直接继续）"
                rows={1}
                className="flex-1 resize-none text-sm text-text-primary placeholder-text-tertiary bg-bg-input border border-border-subtle rounded-md px-3 py-2 focus:border-accent outline-none"
                style={{ minHeight: '60px', maxHeight: '160px' }}
              />
            </div>
          )}

          {/* 控制按钮组 — v0.11.0 F1104：44px 命中区（h-11） + L2 Tooltip */}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {status === 'running' && (
              <Tooltip label="暂停" kbd="⌥⏸" desc="暂停当前任务，可编辑输入追加指令" delay={150}>
                <button
                  onClick={onPause}
                  aria-label="暂停运行"
                  className="flex items-center gap-1.5 h-11 px-3.5 rounded-lg text-text-secondary hover:bg-bg-hover text-xs font-medium transition-colors focus-ring"
                >
                  <Icon.Pause width={16} height={16} />
                  暂停
                </button>
              </Tooltip>
            )}
            {status === 'paused' && (
              <Tooltip label="继续运行" kbd="⌥▶" desc="从检查点恢复执行" delay={150}>
                <button
                  onClick={handleAppendAndResume}
                  aria-label="继续运行"
                  className="flex items-center gap-1.5 h-11 px-3.5 rounded-lg bg-accent hover:bg-accent-hover text-text-inverse text-xs font-medium transition-colors focus-ring"
                >
                  <Icon.Play width={16} height={16} />
                  继续
                </button>
              </Tooltip>
            )}
            {status === 'error' && onRetry && (
              <Tooltip label="重试" desc="以相同输入重跑本轮" delay={150}>
                <button
                  onClick={onRetry}
                  aria-label="重试"
                  className="flex items-center gap-1.5 h-11 px-3.5 rounded-lg text-danger hover:bg-danger-soft text-xs font-medium transition-colors focus-ring"
                >
                  <Icon.Refresh width={16} height={16} />
                  重试
                </button>
              </Tooltip>
            )}
            {status === 'cancelled' && onRerun && (
              <Tooltip label="重新执行该任务" desc="以相同输入重跑" delay={150}>
                <button
                  onClick={onRerun}
                  aria-label="重新执行该任务"
                  className="flex items-center gap-1.5 h-11 px-3.5 rounded-lg bg-accent hover:bg-accent-hover text-text-inverse text-xs font-medium transition-colors focus-ring"
                >
                  <Icon.Refresh width={16} height={16} />
                  重新执行
                </button>
              </Tooltip>
            )}
            {status !== 'cancelled' && (
              <Tooltip label="停止" kbd="Esc" desc="终止当前任务，已执行步骤保留" delay={150}>
                <button
                  onClick={onCancel}
                  aria-label="停止运行"
                  className="flex items-center gap-1.5 h-11 px-3.5 rounded-lg text-text-tertiary hover:text-danger hover:bg-danger-soft text-xs font-medium transition-colors focus-ring"
                >
                  <Icon.Stop width={16} height={16} />
                  停止
                </button>
              </Tooltip>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
