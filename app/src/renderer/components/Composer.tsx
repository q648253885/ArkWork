/* ============================================================
 * ArkWork — Composer (v0.7.0)
 * 重设计：@ 引用（四段：Agent/Skill/File/Memory）+ / 命令；ctx 圆环；Esc 中断
 *
 * v0.7.0 变更：
 *   - @ 菜单新增 Memory 段（注入历史记忆条目作为上下文）
 *   - ModelChip 移入 TopBar，Composer 不再渲染模型选择器
 *   - 文件预览走 PreviewWindow 浮窗（不再开右栏）
 *   - ctx 圆环点击切换到 SidePanel 的 memory 面板
 *
 * 结构：
 *   chips: [@agent] [📄 file] [✦ skill] [🧠 memory]
 *   textarea（自动增高，≤ 8 行）
 *   tool row: [@] [/]  │  ◔ 8%  │  [发送/■ 停止]
 *
 * 键盘：
 *   Enter        发送
 *   Shift+Enter  换行
 *   Esc          关闭菜单 / 中断运行
 *   ↑ (空输入)   召回上一条
 * ============================================================ */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../icons'
import { contextColor, CONTEXT_NOISE_KINDS } from '../constants'
import { useStore, friendlyError, computeModelHealth } from '../store'
// v0.24.x：标题生成（基于首条用户消息首行）改由 store.sendMessage 调用 simplifyFirstLine
// import { simplifyFirstLine } from '../utils/title'
import type { PermissionMode } from '@shared/types/permission'
import { Tooltip } from './ui'
import { RunConsole } from './RunConsole'
import { ModelSwitcher } from './ModelSwitcher'
import { AgentChip } from './AgentChip'
import type { FsNode } from '../types'

type MenuKind = 'at' | 'slash' | 'agent' | null

// v0.15.0：权限模式循环与三态元信息（Composer chip / Settings 共用文案）
const PERMISSION_ORDER: PermissionMode[] = ['default', 'acceptEdits', 'plan']

const PERMISSION_META: Record<
  PermissionMode,
  { label: string; desc: string; cls: string; icon: React.ReactNode }
> = {
  default: {
    label: '默认权限',
    desc: '每次执行都需确认',
    cls: 'bg-bg-surface text-text-tertiary border-border-subtle hover:text-text-primary',
    icon: <Icon.Lock width={12} height={12} />,
  },
  acceptEdits: {
    label: '接受编辑',
    desc: '工作区内自动放行',
    cls: 'bg-accent-soft text-accent border-accent/40 hover:opacity-90',
    icon: <Icon.Edit width={12} height={12} />,
  },
  plan: {
    label: '只读权限',
    desc: '只读探索，写操作拒绝',
    cls: 'bg-warning-soft text-warning border-warning/40 hover:opacity-90',
    icon: <Icon.Eye width={12} height={12} />,
  },
}

interface FileChip {
  path: string
  name: string
}

export function Composer() {
  const [input, setInput] = useState('')
  const [menu, setMenu] = useState<MenuKind>(null)
  const [fileChips, setFileChips] = useState<FileChip[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  // v0.9.0 F904：模型切换器（工具栏首控）
  const [modelSwitcherOpen, setModelSwitcherOpen] = useState(false)
  // v0.24.x：权限模式下拉选择（替代 Shift+Tab 循环）
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const lastInputRef = useRef<string>('')

  const agents = useStore((s) => s.agents)
  const skills = useStore((s) => s.skills)
  const files = useStore((s) => s.files)
  const models = useStore((s) => s.models)
  const memory = useStore((s) => s.memory)
  const selectedAgentId = useStore((s) => s.selectedAgentId)
  const setSelectedAgent = useStore((s) => s.setSelectedAgent)
  const selectedSkillIds = useStore((s) => s.selectedSkillIds)
  const toggleSkill = useStore((s) => s.toggleSkill)
  const selectedModelId = useStore((s) => s.selectedModelId)
  // v0.8.0 F813：知识库 chip 数据
  const knowledgeBases = useStore((s) => s.knowledgeBases)
  const refreshKnowledge = useStore((s) => s.refreshKnowledge)
  const sendMessage = useStore((s) => s.sendMessage)
  const cancelTask = useStore((s) => s.cancelTask)
  const pauseTask = useStore((s) => s.pauseTask)
  const resumeTask = useStore((s) => s.resumeTask)
  const runTask = useStore((s) => s.runTask)
  // v0.24.x：Composer 不再触发自动重命名，store.renameTask 仅供任务侧栏手动重命名
  // const renameTask = useStore((s) => s.renameTask)
  const selectedTaskId = useStore((s) => s.selectedTaskId)
  const tasks = useStore((s) => s.tasks)
  const task = tasks.find((t) => t.id === selectedTaskId)
  const isRunning = task?.status === 'running'
  const isPaused = task?.status === 'paused'
  const isFailed = task?.status === 'failed'

  // v0.8.0 F813：知识库 chip 状态（task 级开关）
  // Task 2：按需引用 — 不再有默认集合；N=task.kbIds 长度（未设置/空都视为 0）
  const setTaskKbIds = useStore((s) => s.setTaskKbIds)
  const [kbMenuOpen, setKbMenuOpen] = useState(false)
  const taskKbIds = task?.kbIds ?? []
  const enabledKbCount = taskKbIds.length

  // v0.8.0 F813：首次挂载加载知识库列表
  useEffect(() => {
    void refreshKnowledge()
  }, [refreshKnowledge])

  const toggleTaskKb = async (kbId: string) => {
    if (!task) return
    const current = taskKbIds
    const next = current.includes(kbId)
      ? current.filter((id) => id !== kbId)
      : [...current, kbId]
    await setTaskKbIds(task.id, next)
  }

  // v0.14.x Task 2：步骤序号/跳动计时已从执行区移除（RunConsole 只展示自然语言动作描述）

  // v0.5.0（B2/B3/B4）：反馈与导出方法
  // v0.7.0：openRight 废弃，改用 setActiveActivity('memory') 切换 SidePanel
  const setActiveActivity = useStore((s) => s.setActiveActivity)
  const openPreview = useStore((s) => s.openPreview)
  const confirm = useStore((s) => s.confirm)
  const pushToast = useStore((s) => s.pushToast)
  // v0.15.0：权限模式（chip 循环切换）
  const permissionMode = useStore((s) => s.permissionMode)
  const setPermissionMode = useStore((s) => s.setPermissionMode)
  const exportConversation = useStore((s) => s.exportConversation)
  // v0.13.0：error 状态消息（用于失败时显示在输入框下方）
  const errorMessage = useStore((s) => s.error)

  const agent = agents.find((a) => a.id === selectedAgentId)
  const model = models.find((m) => m.id === selectedModelId)
  // v0.9.0 F904：模型健康态（未配置/已删除 → 禁用发送）
  const health = computeModelHealth(models, selectedModelId)
  const healthUnavailable = health === 'unconfigured' || health === 'missing'
  const selectedSkills = skills.filter((s) => selectedSkillIds.includes(s.id))

  // ============ 上下文 token：优先用引擎报告的实时 payload，回落到 L1 估算 ============
  const contextSize = useStore((s) => s.contextSize)
  // v0.23.1：当前任务的前缀缓存命中统计（端点上报过才显示命中率）
  const cacheUsage = useStore((s) => s.cacheUsage)
  const ctxUsed = useMemo(
    () => contextSize?.payloadTokens ?? memory.filter((m) => m.enabled && !m.archivedAt).reduce((s, m) => s + m.tokens, 0),
    [contextSize, memory],
  )
  // 百分比分母用引擎真实预算（≈窗口×85%，封顶 64K），对齐压缩触发线；窗口仅作展示
  const ctxBudget = contextSize?.budget ?? model?.contextWindow ?? 128_000
  const ctxWindow = contextSize?.modelContextWindow ?? model?.contextWindow ?? ctxBudget
  const ctxPct = Math.min(100, Math.round((ctxUsed / ctxBudget) * 100))

  // ============ 输入中检测 @ / / 触发 ============
  // 匹配末尾的 @xxx 或 /xxx，用于过滤菜单
  const trigger = useMemo(() => {
    if (menu === 'at') {
      const m = input.match(/@(\w*)$/)
      return m ? m[1] : ''
    }
    if (menu === 'slash') {
      const m = input.match(/\/(\w*)$/)
      return m ? m[1] : ''
    }
    return ''
  }, [input, menu])

  // ============ @ 菜单数据：分四段 智能体 / 技能 / 文件 / 记忆 ============
  // v0.24.x：@ 引用菜单已不包含「智能体」段（按用户要求）。智能体入口改为
  // 点击 Composer 顶部 chips 行的智能体 chip 弹出独立下拉（与 @ 解耦）。
  const atSections = useMemo(() => {
    const q = trigger.toLowerCase()
    const filter = (label: string) => !q || label.toLowerCase().includes(q)

    const skillItems = skills
      .filter((s) => filter(s.name))
      .map((s) => ({
        kind: 'skill' as const,
        id: s.id,
        label: s.name,
        hint: s.description,
        color: '#5B8DEF',
        section: '技能',
        active: selectedSkillIds.includes(s.id),
      }))

    const fileList: FsNode[] = []
    const walkFiles = (nodes: FsNode[]) => {
      for (const n of nodes) {
        if (n.type === 'file') fileList.push(n)
        if (n.children) walkFiles(n.children)
      }
    }
    walkFiles(files)
    const fileItems = fileList
      .filter((f) => filter(f.name))
      .slice(0, 20)
      .map((f) => ({
        kind: 'file' as const,
        id: f.path,
        label: f.name,
        hint: f.path,
        color: '#A6ABB5',
        section: '文件',
        active: fileChips.some((c) => c.path === f.path),
      }))

    // v0.7.0：Memory 段 — 已启用且未归档的 L1/L3 记忆条目
    // v0.8.1：过滤对话噪音（用户/模型对话），只保留资源条目（文件/技能/知识库等）
    // v0.24.x：记忆条目显示「可读摘要 + 触发内容 + token」三行：
    //   - 摘要：去掉 "(触发点：...) / 总项数=..." 这类内部状态格式噪音，仅取首行可读描述
    //   - 触发内容：若 memory.kind === 'plan_status'，提取"当前运行第 N 项"作为触发描述
    //   - token：保留量纲提示
    const memoryItems = memory
      .filter((m) => m.enabled && !m.archivedAt && (m.layer === 'L1' || m.layer === 'L3'))
      .filter((m) => !CONTEXT_NOISE_KINDS.has(m.kind))
      .filter((m) => !q || (m.content || '').toLowerCase().includes(q))
      .slice(0, 15)
      .map((m) => {
        const cleaned = cleanMemoryContent(m.content || '(空记忆)')
        const trigger = extractMemoryTrigger(m)
        return {
          kind: 'memory' as const,
          id: m.id,
          label: cleaned.summary || '(空记忆)',
          hint: trigger ? `${trigger} · ${m.layer} · ${m.tokens} tokens` : `${m.layer} · ${m.tokens} tokens`,
          color: '#9B6BFF',
          section: '记忆',
          active: false,
        }
      })

    return [...skillItems, ...fileItems, ...memoryItems]
  }, [trigger, skills, files, memory, selectedSkillIds, fileChips])

  // ============ v0.24.x：智能体下拉菜单（独立于 @ 引用）============
  const agentItems = useMemo(
    () =>
      agents.map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        color: a.avatarColor,
      })),
    [agents],
  )

  // ============ / 菜单数据 ============
  const slashCommands = useMemo(() => {
    const q = trigger.toLowerCase()
    const all = [
      { id: 'spec', label: '/spec', hint: '调用规格编写技能', section: '命令' },
      { id: 'plan', label: '/plan', hint: '调用计划技能', section: '命令' },
      { id: 'bugfix', label: '/bugfix', hint: '调用缺陷修复技能', section: '命令' },
      { id: 'clear', label: '清空上下文', hint: '清空当前任务记忆（仅清空显示，下次 LLM 不再注入）', section: '命令' },
      { id: 'compress', label: '压缩记忆', hint: '把已积累的对话压缩为摘要', section: '命令' },
      { id: 'export', label: '导出对话', hint: '导出为 Markdown 文件', section: '命令' },
      { id: 'new', label: '新建任务', hint: '放弃当前任务，开新对话', section: '命令' },
    ]
    return all.filter((c) => !q || c.label.toLowerCase().includes(q) || c.id.includes(q))
  }, [trigger])

  // 菜单总条目数
  const menuItems = menu === 'at' ? atSections : menu === 'slash' ? slashCommands : []
  useEffect(() => {
    setActiveIndex(0)
  }, [menu, trigger])

  // ============ v0.24.x：记忆内容清洗 + 触发描述提取 ============
  // 历史 L1 plan_status / iteration_step 等条目带有"（触发点：...）\n总项数=..."这种
  // 内部状态格式，对 LLM 有用但对用户不可读。这里抽取"当前运行第 N 项"作为触发描述，
  // 把首行可读部分作为摘要，避免把内部 status 字符串直接展示在 @ 引用面板中。
  function cleanMemoryContent(raw: string): { summary: string } {
    // 去掉 "（触发点：...）" 段
    const noTrigger = raw.replace(/（触发点：[^）]*）/g, '').replace(/\(触发点：[^)]*\)/g, '').trim()
    // 取首行非空内容
    const firstLine = noTrigger.split(/\r?\n/).find((l) => l.trim().length > 0) ?? ''
    return { summary: firstLine.slice(0, 48).trim() }
  }

  function extractMemoryTrigger(m: { kind: string; content: string }): string {
    if (m.kind !== 'plan_status') return ''
    const triggerMatch = m.content.match(/（触发点：([^）]*)）/m) ?? m.content.match(/\(触发点：([^)]*)\)/m)
    const trigger = triggerMatch?.[1]?.trim() ?? ''
    const runningMatch = m.content.match(/当前运行：第\s*(\d+)\s*项/m)
    const running = runningMatch ? `当前运行第 ${runningMatch[1]} 项` : ''
    if (trigger && running) return `${trigger} · ${running}`
    if (running) return running
    if (trigger) return trigger
    return ''
  }

  // ============ v0.24.x：标题改为「发送后」生成 ============
  // 取消 v0.23.0 的输入时 800ms debounce 实时同步——用户在敲字时若敲到一半
  // （甚至第一个字符）就触发了「未命名任务 → 一字标题」误显示，且中途会与其他
  // 用户/系统改标题的写入产生竞态。
  // 新策略：标题完全由 store.sendMessage / store.createTask 在发送成功后基
  // 于「首条已提交用户消息」首行生成；Composer 在此不持有 titleSyncTimer。
  // 历史占位「未命名任务 / 未命名任务 N」仍由 store 在续聊时刷新（polish2）。
  useEffect(() => {
    return () => {
      /* no-op：预留清理点，旧的 titleSyncTimer 已在 handleSend 中清掉 */
    }
  }, [])

  // ============ 输入变化：检测 @ / / 触发 ============
  const onChangeInput = (val: string) => {
    setInput(val)
    // 末尾出现 @ 或 /（且非行中插入）
    const atMatch = val.match(/@(\w*)$/)
    const slashMatch = val.match(/(?:^|\s)\/(\w*)$/)
    if (atMatch) {
      setMenu('at')
    } else if (slashMatch) {
      setMenu('slash')
    } else if (menu) {
      setMenu(null)
    }
  }

  // ============ 选择 @ 菜单项 ============
  const pickAtItem = (item: (typeof atSections)[number]) => {
    // 从输入中移除 @xxx 部分
    const cleaned = input.replace(/@(\w*)$/, '').replace(/\s+$/, '')
    // v0.24.x：智能体已不在 @ 引用中（顶部智能体 chip 点击→独立下拉切换）
    if (item.kind === 'skill') {
      // v0.16.7+：把「Use Skill: {name}」字面量插入到输入框，让 LLM 看到明文指令
      // 显式触发（@coder systemPrompt 已规定识别 "Use Skill: X" → 立即调用 X）。
      // 同时调 toggleSkill 走任务级 skillIds 通道作为冗余兜底。
      toggleSkill(item.id)
      const useTag = `Use Skill: ${item.label} `
      setInput(cleaned ? `${cleaned} ${useTag}` : useTag)
    } else if (item.kind === 'file') {
      const name = item.label
      const path = item.id
      if (!fileChips.some((c) => c.path === path)) {
        setFileChips((prev) => [...prev, { path, name }])
      }
      setInput(cleaned + ' ')
      // v0.7.0：文件预览走 PreviewWindow 浮窗（取代右栏）
      void openPreview(path)
    } else if (item.kind === 'memory') {
      // v0.7.0：memory 项 — 在输入框插入 [memory:<id>] 标记，并提示已注入
      const tag = `[memory:${item.id}]`
      setInput((prev) => (prev.endsWith(' ') ? prev + tag + ' ' : prev + ' ' + tag + ' '))
      pushToast({
        type: 'success',
        message: `已引用记忆：${item.label}`,
        duration: 2000,
      })
    }
    setMenu(null)
    textareaRef.current?.focus()
  }

  // ============ 选择 / 菜单项 ============
  const pickSlashCommand = (cmd: (typeof slashCommands)[number]) => {
    const cleaned = input.replace(/(?:^|\s)\/(\w*)$/, '').replace(/\s+$/, '')
    setInput(cleaned)
    setMenu(null)
    void runSlashCommand(cmd.id)
    textareaRef.current?.focus()
  }

  const runSlashCommand = async (id: string) => {
    const taskId = selectedTaskId
    if (!taskId) return
    if (id === 'spec' || id === 'plan' || id === 'bugfix') {
      const skill = skills.find((item) => item.name.toLowerCase() === id || item.id.toLowerCase() === id)
      if (skill) toggleSkill(skill.id)
      return
    }
    if (id === 'compress') {
      try {
        const result = await window.ark.memory.compress({
          taskId,
          policy: {
            keepSystem: true,
            keepRecentTurns: 3,
            keepUserTurns: true,
            keepFileRefs: true,
            dropFailed: true,
          },
        })
        await useStore.getState().refreshMemory(taskId)
        // v0.5.0（B2）：压缩成功反馈走 Toast + ctx-chip
        pushToast({
          type: 'success',
          message: `压缩完成：${result.beforeTokens} → ${result.afterTokens} tokens`,
          duration: 4000,
        })
        useStore.getState().pushCtxChip({
          text: `上下文已压缩 · ${result.beforeTokens} → ${result.afterTokens} tokens`,
          variant: 'compress',
        })
      } catch (e) {
        pushToast({ type: 'danger', message: friendlyError(e, '压缩失败'), duration: 0 })
      }
    } else if (id === 'new') {
      await useStore.getState().createTask({ title: '', text: '' })
    } else if (id === 'export') {
      exportConversation()
    } else if (id === 'clear') {
      // v0.5.0（B6）：window.confirm → store.confirm helper
      const ok = await confirm({
        title: '清空上下文记忆',
        body: '确定清空当前任务的上下文记忆吗？此操作不可撤销，下一轮推理将丢失历史上下文。',
        confirmLabel: '清空',
        danger: true,
      })
      if (!ok) return
      try {
        await window.ark.memory.clear(taskId)
        await useStore.getState().refreshMemory(taskId)
        pushToast({ type: 'success', message: '上下文已清空', duration: 3000 })
      } catch (e) {
        pushToast({ type: 'danger', message: friendlyError(e, '清空失败'), duration: 0 })
      }
    }
  }

  // v0.5.0（B3）：exportConversation 已迁移至 store.exportConversation()

  // ============ 发送 ============
  const handleSend = async () => {
    const text = input.trim()
    if (!text || isRunning) return
    lastInputRef.current = text
    // 把 file chips 以 [file: path] 附加到消息末尾（占位，真实路径作为上下文）
    const fileRefs = fileChips.map((c) => `@file:${c.path}`).join(' ')
    const fullText = fileRefs ? `${text}\n\n附件: ${fileRefs}` : text
    // v0.24.x：标题生成已迁移到 store.sendMessage（发送成功后基于首行生成）。
    // Composer 不再持有 timer / sentinel 状态；旧的清理分支直接移除。
    await sendMessage(fullText)
    setInput('')
    setFileChips([])
  }

  // ============ 中断 ============
  const handleStopOrEsc = () => {
    if (menu) {
      setMenu(null)
      return
    }
    if (isRunning && selectedTaskId) {
      void cancelTask(selectedTaskId)
    }
  }

  // ============ 键盘 ============
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 菜单打开时：↑ ↓ Enter Esc
    if (menu && menuItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((i) => Math.min(i + 1, menuItems.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((i) => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        const item = menuItems[activeIndex]
        if (menu === 'at' && item) pickAtItem(item as (typeof atSections)[number])
        else if (menu === 'slash' && item) pickSlashCommand(item as (typeof slashCommands)[number])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMenu(null)
        return
      }
    }

    // Esc 中断运行（无菜单时）
    if (e.key === 'Escape') {
      e.preventDefault()
      handleStopOrEsc()
      return
    }

    // Enter 发送 / Shift+Enter 换行
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (!isRunning) void handleSend()
      return
    }

    // ↑ 空输入时召回上一条
    if (e.key === 'ArrowUp' && input === '' && lastInputRef.current) {
      e.preventDefault()
      setInput(lastInputRef.current)
      return
    }
  }

  // ============ textarea 自适应高度 ============
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    const next = Math.min(el.scrollHeight, 8 * 25) // ≤ 8 行
    el.style.height = `${Math.max(40, next)}px`
  }, [input])

  // ============ 监听外部填充事件（示例 prompt 点击） ============
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail
      if (typeof detail === 'string') {
        setInput(detail)
        textareaRef.current?.focus()
      }
    }
    window.addEventListener('composer:fill', handler)
    return () => window.removeEventListener('composer:fill', handler)
  }, [])

  // v0.9.0 F904：⌘⇧M / TaskTitleBar chip 点击 → 打开模型切换器
  useEffect(() => {
    const handler = () => {
      setModelSwitcherOpen(true)
      textareaRef.current?.focus()
    }
    window.addEventListener('composer:open-model', handler)
    return () => window.removeEventListener('composer:open-model', handler)
  }, [])

  // v0.9.0 F906：⌘N → 聚焦 Composer（新建任务后让光标直接落在输入框）
  useEffect(() => {
    const handler = () => {
      textareaRef.current?.focus()
    }
    window.addEventListener('composer:focus', handler)
    return () => window.removeEventListener('composer:focus', handler)
  }, [])

  // v0.9.1：文件树「插入为上下文」→ 真实接入 file chips（替换原假成功 toast）
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ path: string; name: string }>).detail
      if (!detail?.path) return
      setFileChips((prev) =>
        prev.some((c) => c.path === detail.path) ? prev : [...prev, { path: detail.path, name: detail.name }],
      )
      pushToast({ type: 'success', message: `已将「${detail.name}」加入上下文`, duration: 2000 })
      textareaRef.current?.focus()
    }
    window.addEventListener('composer:attach-file', handler)
    return () => window.removeEventListener('composer:attach-file', handler)
  }, [pushToast])

  const removeSkill = (id: string) => toggleSkill(id)
  const removeFile = (path: string) =>
    setFileChips((prev) => prev.filter((c) => c.path !== path))

  // v0.5.0（B1）：运行/暂停/失败态 → 渲染 RunConsole 替代输入形态
  const handleAppendAndResume = async (text: string) => {
    if (!selectedTaskId) return
    try {
      // v0.16.7+：appendMessage 内部已自动 cancel + run，不再需要 resumeTask
      // （之前 race：appendMessage → runTask；resumeTask → 再次 cancel + run）
      await window.ark.task.appendMessage(selectedTaskId, text)
      await useStore.getState().refreshMemory(selectedTaskId)
    } catch (e) {
      pushToast({ type: 'danger', message: friendlyError(e, '追加消息失败'), duration: 0 })
    }
  }

  const handleRetry = () => {
    if (selectedTaskId) void runTask(selectedTaskId)
  }

  // v0.8.0：中断/停止（cancelled）后恢复为普通输入框，用户可直接继续输入；
  // running/paused/failed 仍走 RunConsole（暂停/重试/错误展示）
  if (task && (isRunning || isPaused || isFailed)) {
    return (
      <RunConsole
        status={isRunning ? 'running' : isPaused ? 'paused' : 'error'}
        errorMessage={isFailed ? useStore.getState().error ?? undefined : undefined}
        onPause={() => selectedTaskId && void pauseTask(selectedTaskId)}
        onResume={() => selectedTaskId && void resumeTask(selectedTaskId)}
        onCancel={() => selectedTaskId && void cancelTask(selectedTaskId)}
        onRetry={isFailed ? handleRetry : undefined}
        onAppendAndResume={isPaused ? handleAppendAndResume : undefined}
      />
    )
  }

  return (
    /* v0.24.x — 重新排版（Trae harness 风格）：
       - 顶部 chips 行：智能体入口（点击下拉切换）+ 引用 + 命令 + KB + 文件 chips
       - 输入框（floating capsule）
       - 底部工具行：模型 + 默认权限 + ctx 圆环 + 发送 */
    <div className="relative border-t border-border-subtle bg-bg-base flex-shrink-0" data-state={isRunning ? 'running' : isFailed ? 'error' : 'idle'}>
      {/* ============ 顶部 chips 行：智能体入口 + 引用 + 命令 + KB + 文件 ============ */}
      <div className="flex items-center gap-1 px-3 pt-2 pb-1 flex-wrap relative">
        {/* v0.24.x：智能体入口（点击弹出下拉选择）—— 替代原先静态 AgentChip */}
        <Tooltip label="切换智能体" desc="点击选择当前任务的智能体" placement="top" delay={150}>
          <button
            type="button"
            onClick={() => setMenu(menu === 'agent' ? null : 'agent')}
            aria-haspopup="listbox"
            aria-expanded={menu === 'agent'}
            className={`inline-flex items-center gap-1.5 h-[26px] px-2 rounded-md border text-2xs font-mono transition-colors ${
              menu === 'agent'
                ? 'bg-accent-soft border-accent text-accent'
                : 'bg-bg-surface border-border-subtle text-text-secondary hover:text-text-primary'
            }`}
          >
            <span
              className="relative inline-flex items-center justify-center w-3 h-3 rounded-full"
              style={{ backgroundColor: agent?.avatarColor ?? 'var(--text-secondary)' }}
            />
            <span className="font-medium">@{agent?.name ?? '未选择'}</span>
            <Icon.ChevronDown width={10} height={10} />
          </button>
        </Tooltip>

        {/* v0.24.x：「引用」按钮（@ 菜单入口）—— 移到顶部 */}
        <ToolIcon
          icon={<Icon.AtSign width={13} height={13} />}
          label="引用"
          tooltip="@ 引用 技能 / 文件 / 记忆"
          onClick={() => {
            if (menu === 'at') {
              setMenu(null)
              setInput((prev) => prev.replace(/@(\w*)$/, '').replace(/\s+$/, ''))
            } else {
              setInput((prev) => (prev.endsWith('@') ? prev : prev + (prev && !prev.endsWith(' ') ? ' ' : '') + '@'))
              setMenu('at')
            }
            textareaRef.current?.focus()
          }}
          active={menu === 'at'}
        />

        {/* v0.24.x：「命令」按钮（/ 菜单入口）—— 移到顶部 */}
        <ToolIcon
          icon={<Icon.Slash width={13} height={13} />}
          label="命令"
          tooltip="/ 命令"
          onClick={() => {
            if (menu === 'slash') {
              setMenu(null)
              setInput((prev) => prev.replace(/(?:^|\s)\/(\w*)$/, '').replace(/\s+$/, ''))
            } else {
              setInput((prev) => (prev.endsWith('/') ? prev : prev + (prev && !prev.endsWith(' ') ? ' ' : '') + '/'))
              setMenu('slash')
            }
            textareaRef.current?.focus()
          }}
          active={menu === 'slash'}
        />

        {/* 文件 chips 保留 */}
        {selectedSkills.map((s) => (
          <Chip key={s.id} color="#5B8DEF" onRemove={() => removeSkill(s.id)}>
            ✦ {s.name}
          </Chip>
        ))}
        {fileChips.map((c) => (
          <Chip key={c.path} color="#A6ABB5" onRemove={() => removeFile(c.path)}>
            {c.name}
          </Chip>
        ))}
        {/* v0.8.0 F813：知识库 chip — 点击展开启用清单 */}
        {knowledgeBases.length > 0 && (
<Tooltip label="知识库：点击选择当前任务启用的知识库">
          <button
            onClick={() => setKbMenuOpen((v) => !v)}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-2xs font-mono transition-colors ${
              enabledKbCount > 0
                ? 'bg-accent-soft border-accent text-accent'
                : 'bg-bg-surface border-border-subtle text-text-tertiary hover:text-text-secondary'
            }`}

          >
            <Icon.Book width={10} height={10} />
            知识库 {enabledKbCount}
          </button>
</Tooltip>
        )}

        {/* v0.24.x：智能体下拉面板（宽度自适应内容，显示完整名称与标签） */}
        {menu === 'agent' && (
          <PickerPopover
            title="切换智能体"
            onClose={() => setMenu(null)}
            panelClass="w-max min-w-[220px] max-w-[360px]"
          >
            {agentItems.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-text-tertiary">尚未配置智能体</div>
            ) : (
              <div className="flex flex-col">
                {agentItems.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => {
                      setSelectedAgent(a.id)
                      setMenu(null)
                    }}
                    className={`flex items-center gap-2 h-8 px-2.5 text-left transition-colors whitespace-nowrap ${
                      a.id === selectedAgentId ? 'bg-bg-active' : 'hover:bg-bg-hover'
                    }`}
                  >
                    <span
                      className="flex-shrink-0 h-5 w-5 flex items-center justify-center rounded-md text-xs font-medium"
                      style={{ background: `${a.color}22`, color: a.color }}
                    >
                      <Icon.Bot width={13} height={13} />
                    </span>
                    <span className="flex-1 min-w-0 text-xs text-text-primary overflow-hidden text-ellipsis">{a.name}</span>
                    {a.id === selectedAgentId && (
                      <span className="text-2xs text-success flex-shrink-0">✓ 当前</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </PickerPopover>
        )}
      </div>

      {/* v0.13.0：error 状态 — 红色边线 + 错误消息显示在输入框下方 */}
      {isFailed && errorMessage && (
        <div className="error-card mx-3 mt-2">
          <Icon.X width={16} height={16} className="text-danger flex-shrink-0" />
          <span className="error-card__message">{errorMessage}</span>
        </div>
      )}

      {/* v0.21.0 — DSH 风格 floating capsule 输入卡：22px radius、l2-darkmode-thin border、shadow-md */}
      <div className="px-3 pt-2">
        <div
          className={`flex items-start gap-2.5 rounded-3xl border px-4 py-2 transition-all duration-200 ${
            isFailed
              ? 'border-danger bg-bg-input shadow-md'
              : 'border-border-default bg-bg-input shadow-md focus-within:border-business-primary focus-within:shadow-lg'
          }`}
        >
          <span className="text-text-tertiary mt-1 select-none font-mono text-base">›</span>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => onChangeInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder=""
            rows={1}
            className="flex-1 resize-none text-sm text-text-primary placeholder-text-tertiary bg-transparent leading-relaxed px-1 py-2"
            style={{ minHeight: '44px', maxHeight: '320px' }}
          />
        </div>
      </div>

      {/* ============ 底部工具行：模型 + 默认权限 + ctx + 发送 ============ */}
      <div className="flex items-center gap-2 px-3 py-2">
        {/* 模型切换器 */}
        <ModelSwitcher open={modelSwitcherOpen} onOpenChange={setModelSwitcherOpen} />

        {/* v0.24.x：默认权限 chip —— 点击弹出下拉列表选择 */}
        <div className="relative">
          <Tooltip
            label={PERMISSION_META[permissionMode].label}
            desc={PERMISSION_META[permissionMode].desc}
            placement="top"
            delay={150}
          >
            <button
              onClick={() => setPermissionMenuOpen((v) => !v)}
              aria-haspopup="listbox"
              aria-expanded={permissionMenuOpen}
              aria-label="切换权限模式"
              className={`inline-flex items-center gap-1 h-8 px-2.5 rounded-md border text-2xs transition-colors focus-ring ${PERMISSION_META[permissionMode].cls}`}
            >
              {PERMISSION_META[permissionMode].icon}
              <span className="font-mono">{PERMISSION_META[permissionMode].label}</span>
              <Icon.ChevronDown width={10} height={10} />
            </button>
          </Tooltip>

          {permissionMenuOpen && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setPermissionMenuOpen(false)} />
              <div className="absolute z-30 bottom-full left-0 mb-1 w-60 bg-bg-overlay border border-border-default rounded-lg shadow-panel py-1 scale-in">
                <div className="px-3 py-1.5 border-b border-border-subtle text-2xs text-text-tertiary uppercase tracking-wider font-medium">
                  权限模式
                </div>
                {PERMISSION_ORDER.map((mode) => {
                  const meta = PERMISSION_META[mode]
                  const active = mode === permissionMode
                  return (
                    <button
                      key={mode}
                      onClick={() => {
                        void setPermissionMode(mode)
                        setPermissionMenuOpen(false)
                      }}
                      className={`w-full flex items-center gap-2 h-9 px-3 text-left transition-colors ${
                        active ? 'bg-bg-active' : 'hover:bg-bg-hover'
                      }`}
                    >
                      <span className="flex-shrink-0 text-text-secondary">{meta.icon}</span>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-text-primary">{meta.label}</div>
                        <div className="text-2xs text-text-tertiary truncate">{meta.desc}</div>
                      </div>
                      {active && <span className="text-2xs text-success flex-shrink-0">✓</span>}
                    </button>
                  )
                })}
              </div>
            </>
          )}
        </div>

        <div className="flex-1" />

        {/* ctx 上下文用量 */}
        <CtxRing
          used={ctxUsed}
          total={ctxBudget}
          window={ctxWindow}
          pct={ctxPct}
          cache={cacheUsage?.reported ? cacheUsage : null}
          onClick={() => setActiveActivity('memory')}
        />

        <Divider />

        {/* v0.21.0 — DSH 风格发送/停止：
            - 发送：业务蓝 (#3964FE) 圆角胶囊（DSH --dsw-alias-button-info-fill，34px 圆 icon 风格 + 文字）
            - 停止：保持 danger 红色，去除冗余高度 */}
        {isRunning ? (
          <Tooltip label="停止" kbd="Esc" desc="终止当前任务，已执行步骤保留" delay={150}>
            <button
              onClick={handleStopOrEsc}
              aria-label="停止运行 Esc"
              className="flex items-center gap-1.5 h-9 px-4 rounded-full bg-danger hover:opacity-90 text-text-inverse text-sm font-medium transition-opacity focus-ring"
            >
              <Icon.Stop width={14} height={14} />
              停止
            </button>
          </Tooltip>
        ) : (
          <Tooltip
            label="发送"
            kbd="⏎"
            desc={model && !healthUnavailable ? '发送消息给当前模型（Shift+Enter 换行）' : '请先在设置中配置并选择一个模型'}
            delay={150}
          >
            <button
              onClick={() => void handleSend()}
              disabled={!input.trim() || !model || healthUnavailable}
              aria-label="发送消息 ⏎"
              className="flex items-center gap-1.5 h-9 px-4 rounded-full text-text-inverse text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus-ring hover:opacity-90"
              style={{
                background: 'var(--business-primary)',
              }}
            >
              <Icon.Send width={14} height={14} />
              发送
            </button>
          </Tooltip>
        )}
      </div>

      {/* ============ @ 菜单 ============ */}
      {menu === 'at' && (
        <PickerPopover title={`@ 引用${trigger ? ` · ${trigger}` : ''}`} onClose={() => setMenu(null)}>
          {atSections.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-text-tertiary">
              {agents.length + skills.length === 0 ? '尚未配置智能体 / 技能' : '无匹配项'}
            </div>
          ) : (
            <>
              {(['技能', '文件', '记忆'] as const).map((section) => {
                const items = atSections.filter((i) => i.section === section)
                if (items.length === 0) return null
                return (
                  <div key={section}>
                    <div className="px-2.5 py-1.5 text-2xs text-text-tertiary uppercase tracking-wider font-medium">
                      {section}
                    </div>
                    {items.map((item) => {
                      const idx = atSections.indexOf(item)
                      const active = idx === activeIndex
                      return (
                        <button
                          key={item.id}
                          onMouseEnter={() => setActiveIndex(idx)}
                          onClick={() => pickAtItem(item)}
                          className={`w-full flex items-center gap-2.5 h-10 px-2.5 text-left transition-colors ${
                            active ? 'bg-bg-active' : 'hover:bg-bg-hover'
                          }`}
                        >
                          <AtItemIcon kind={item.kind} color={item.color} />
                          <div className="flex-1 min-w-0">
                            <div className="text-sm text-text-primary truncate">{item.label}</div>
                            {item.hint && (
                              <div className="text-2xs text-text-tertiary truncate">{item.hint}</div>
                            )}
                          </div>
                          {item.active && (
                            <span className="text-2xs text-success flex-shrink-0">✓ 已选</span>
                          )}
                        </button>
                      )
                    })}
                  </div>
                )
              })}
            </>
          )}
        </PickerPopover>
      )}

      {/* ============ / 菜单 ============ */}
      {menu === 'slash' && (
        <PickerPopover title={`/ 命令${trigger ? ` · ${trigger}` : ''}`} onClose={() => setMenu(null)}>
          {slashCommands.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-text-tertiary">无匹配命令</div>
          ) : (
            slashCommands.map((cmd, idx) => {
              const active = idx === activeIndex
              return (
                <button
                  key={cmd.id}
                  onMouseEnter={() => setActiveIndex(idx)}
                  onClick={() => pickSlashCommand(cmd)}
                  className={`w-full flex items-center gap-2.5 h-12 px-2.5 text-left transition-colors ${
                    active ? 'bg-bg-active' : 'hover:bg-bg-hover'
                  }`}
                >
                  <span className="flex-shrink-0 h-7 w-7 flex items-center justify-center rounded-md bg-accent-soft text-accent font-mono text-sm">
                    /
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-text-primary">{cmd.label}</div>
                    <div className="text-2xs text-text-tertiary truncate">{cmd.hint}</div>
                  </div>
                </button>
              )
            })
          )}
        </PickerPopover>
      )}

      {/* ============ v0.8.0 F813：知识库启用清单弹层 ============ */}
      {kbMenuOpen && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setKbMenuOpen(false)} />
          <div className="absolute z-30 left-3 right-3 bottom-full mb-1 bg-bg-overlay border border-border-default rounded-lg shadow-panel max-h-[360px] overflow-y-auto scale-in">
            <div className="px-3 py-2 border-b border-border-subtle text-2xs text-text-tertiary uppercase tracking-wider font-medium sticky top-0 bg-bg-overlay flex items-center gap-1.5">
              <Icon.Book width={11} height={11} />
              {enabledKbCount > 0 ? `知识库（当前任务启用 ${enabledKbCount}）` : '知识库（未启用）'}
            </div>
            {knowledgeBases.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-text-tertiary">
                尚未导入知识库，请在右侧知识库面板导入
              </div>
            ) : (
              <div className="py-1">
                {knowledgeBases.map((kb) => {
                  const hasError = !!kb.parseError
                  // Task 2：按需引用 — 只用显式集合判断，无默认勾选
                  const checked = taskKbIds.includes(kb.id)
                  return (
                    <label
                      key={kb.id}
                      className={`flex items-center gap-2.5 px-3 h-10 cursor-pointer transition-colors hover:bg-bg-hover ${
                        hasError ? 'opacity-50' : ''
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={hasError}
                        onChange={() => void toggleTaskKb(kb.id)}
                        className="accent-accent flex-shrink-0"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-text-primary truncate">{kb.name}</div>
                        {hasError ? (
                          <div className="text-2xs text-danger truncate">解析失败</div>
                        ) : (
                          <div className="text-2xs text-text-tertiary">{kb.chunks ?? 0} 块</div>
                        )}
                      </div>
                    </label>
                  )
                })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/* ============================================================
 * Chip — 引用 chip
 * ============================================================ */
function Chip({
  children,
  color,
  onRemove,
}: {
  children: React.ReactNode
  color: string
  onRemove?: () => void
}) {
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-bg-surface border border-border-subtle text-2xs font-mono"
      style={{ color }}
    >
      {children}
      {onRemove && (
<Tooltip label="移除">
        <button
          onClick={onRemove}
          className="text-text-tertiary hover:text-danger ml-0.5"

        >
          <Icon.X width={9} height={9} />
        </button>
</Tooltip>
      )}
    </span>
  )
}

/* ============================================================
 * AtItemIcon — @ 菜单项图标（大号，带分类色）
 * ============================================================ */
function AtItemIcon({ kind, color }: { kind: 'skill' | 'file' | 'memory'; color: string }) {
  // v0.24.x：「agent」已不在 @ 引用中（顶部智能体 chip 独立入口）
  if (kind === 'skill') {
    return (
      <span
        className="flex-shrink-0 h-7 w-7 flex items-center justify-center rounded-md text-xs font-medium"
        style={{ background: `${color}22`, color }}
      >
        <Icon.Sparkle width={15} height={15} />
      </span>
    )
  }
  if (kind === 'memory') {
    return (
      <span
        className="flex-shrink-0 h-7 w-7 flex items-center justify-center rounded-md text-xs font-medium"
        style={{ background: `${color}22`, color }}
      >
        <Icon.Brain width={15} height={15} />
      </span>
    )
  }
  return (
    <span className="flex-shrink-0 h-7 w-7 flex items-center justify-center rounded-md bg-bg-base text-text-secondary">
      <Icon.File width={15} height={15} />
    </span>
  )
}

/* ============================================================
 * ToolIcon — 工具行的小按钮
 * ============================================================ */
function ToolIcon({
  icon,
  label,
  tooltip,
  onClick,
  active,
}: {
  icon: React.ReactNode
  label: string
  tooltip: string
  onClick: () => void
  active: boolean
}) {
  return (
    <Tooltip label={tooltip} placement="top" delay={150}>
      <button
        onClick={onClick}
        aria-label={tooltip}
        className={`flex items-center gap-1 h-9 px-2.5 rounded-md text-xs transition-colors focus-ring ${
          active
            ? 'bg-accent-soft text-accent'
            : 'text-text-tertiary hover:bg-bg-hover hover:text-text-primary'
        }`}
      >
        {icon}
        <span className="font-mono">{label}</span>
      </button>
    </Tooltip>
  )
}

function Divider() {
  return <span className="w-px h-4 bg-border-subtle mx-0.5" />
}

/* ============================================================
 * CtxRing — 上下文用量（圆环 + 文字标识，放在发送按钮左侧）
 * ============================================================ */
function CtxRing({
  used,
  total,
  window,
  pct,
  cache,
  onClick,
}: {
  used: number
  total: number
  window: number
  pct: number
  cache?: { hitTokens: number; missTokens: number } | null
  onClick?: () => void
}) {
  const color = contextColor(pct)
  const radius = 6
  const circ = 2 * Math.PI * radius
  const offset = circ - (pct / 100) * circ
  const overLimit = pct > 95
  // v0.23.1：缓存命中率 = 命中 /（命中 + 未命中）；端点未报告（cache=null）不显示
  const cacheTotal = cache ? cache.hitTokens + cache.missTokens : 0
  const cachePct = cache && cacheTotal > 0 ? Math.round((cache.hitTokens / cacheTotal) * 100) : null
  const cacheText = cache && cachePct !== null ? ` · 缓存命中 ${cachePct}%（命中 ${cache.hitTokens.toLocaleString()} / 输入 ${cacheTotal.toLocaleString()} tokens）` : ''
  const tooltipText = overLimit
    ? `上下文已超预算 ${pct}%，建议使用 /压缩记忆 降低占用${cacheText}`
    : `上下文用量：${used.toLocaleString()} / 预算 ${total.toLocaleString()} tokens（${pct}%）· 模型窗口 ${window.toLocaleString()}${cacheText}`

  return (
    <Tooltip label={tooltipText} placement="top">
      <div
        onClick={onClick}
        className={`flex items-center gap-1.5 h-8 px-2.5 rounded-md hover:bg-bg-hover transition-colors ${onClick ? 'cursor-pointer' : 'cursor-default'}`}
      >
        <div className="relative w-4 h-4 flex items-center justify-center">
          <svg width="16" height="16" viewBox="0 0 16 16" className="-rotate-90">
            <circle
              cx="8"
              cy="8"
              r={radius}
              fill="none"
              stroke="var(--ring-track)"
              strokeWidth="1.5"
            />
            <circle
              cx="8"
              cy="8"
              r={radius}
              fill="none"
              stroke={color}
              strokeWidth="1.5"
              strokeDasharray={circ}
              strokeDashoffset={offset}
              strokeLinecap="round"
            />
          </svg>
        </div>
        <span className="text-xs font-mono tabular" style={{ color }}>
          {pct}%
        </span>
        {/* v0.23.1：缓存命中率常驻小字（仅端点上报过缓存数据时显示） */}
        {cachePct !== null && (
          <span
            className="text-2xs font-mono tabular text-text-tertiary"
            title={`前缀缓存命中率 ${cachePct}% · 命中 ${(cache?.hitTokens ?? 0).toLocaleString()} / 输入 ${cacheTotal.toLocaleString()} tokens`}
          >
            ⚡{cachePct}%
          </span>
        )}
        {overLimit && (
<Tooltip label="输入 /压缩记忆 以降低占用">
          <span className="text-2xs text-danger">
            /压缩
          </span>
</Tooltip>
        )}
      </div>
    </Tooltip>
  )
}

/* ============================================================
 * PickerPopover — 浮层容器（绝对定位在 Composer 上方）
 * ============================================================ */
function PickerPopover({
  title,
  children,
  onClose,
  panelClass,
}: {
  title: string
  children: React.ReactNode
  onClose?: () => void
  /** v0.24.x：面板宽度类（默认 left-3 right-3 撑满；agent 列表传 w-max 自适应） */
  panelClass?: string
}) {
  return (
    <>
      {/* 点击遮罩层关闭菜单 */}
      <div
        className="fixed inset-0 z-20"
        onClick={onClose}
      />
      <div className={`absolute z-30 left-3 bottom-full mb-1 bg-bg-overlay border border-border-default rounded-lg shadow-panel max-h-[420px] overflow-y-auto scale-in ${
        panelClass ?? 'right-3'
      }`}>
        <div className="px-3 py-2 border-b border-border-subtle text-2xs text-text-tertiary uppercase tracking-wider font-medium flex items-center gap-1.5 sticky top-0 bg-bg-overlay">
          <Icon.Search width={11} height={11} />
          {title}
        </div>
        <div className="py-1">{children}</div>
      </div>
    </>
  )
}
