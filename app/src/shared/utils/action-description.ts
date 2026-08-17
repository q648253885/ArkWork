/**
 * 动作意图描述（v0.21.0）。
 *
 * 把一次工具调用（tool + args）转成一句人类可读的「做什么」说明，
 * 用于交互区每个 Act 步骤的简介，解决「用户看到命令/写文件却不知道在干什么」的问题。
 * 描述只陈述客观动作（执行什么命令、读写哪个文件、检索什么），不臆测意图；
 * 更上层的「为什么做」由模型 Reason 的 thought 承载。
 */

/** 截断长字符串，避免命令/路径/正文撑爆单行 */
function truncate(s: string, max = 60): string {
  const t = s.trim()
  if (t.length <= max) return t
  return t.slice(0, max - 1) + '…'
}

function firstString(args: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = args[k]
    if (typeof v === 'string' && v.trim()) return truncate(v)
  }
  return ''
}

/** todo_update 状态 → 中文动词 */
const STATUS_ZH: Record<string, string> = {
  done: '完成',
  running: '进行中',
  pending: '待办',
  skipped: '跳过',
  failed: '失败',
  cancelled: '取消',
}

/** 工具名（含别名） → 动作短语前缀 + 从 args 取的关键字段 */
const ACTION_SPEC: Record<string, { verb: string; keys: string[] }> = {
  shell: { verb: '执行命令', keys: ['command'] },
  'file-reader': { verb: '读取文件', keys: ['path'] },
  'file-writer': { verb: '写入文件', keys: ['path'] },
  'file-editor': { verb: '编辑文件', keys: ['path'] },
  'glob-search': { verb: '查找文件', keys: ['pattern', 'path'] },
  'grep-search': { verb: '搜索代码', keys: ['pattern'] },
  'web-search': { verb: '网页检索', keys: ['query'] },
  'fetch-url': { verb: '抓取网页', keys: ['url'] },
  'kb-search': { verb: '查询知识库', keys: ['query'] },
  'session-search': { verb: '检索历史', keys: ['query'] },
  'delegate-agent': { verb: '委派子任务', keys: ['task'] },
  task_complete: { verb: '完成任务', keys: ['summary'] },
  ask_user: { verb: '询问用户', keys: ['question'] },
}

/**
 * 把工具调用转成人类可读动作描述。
 * 未知工具（MCP / 市场技能）兜底为「调用工具：{tool}」。
 */
export function describeAction(tool: string, args: Record<string, unknown>): string {
  // todo_update 结构特殊：带索引 + 状态，单独描述
  if (tool === 'todo-update' || tool === 'todo_update') {
    const idx = Number(args.item_index)
    const status = STATUS_ZH[String(args.status ?? '')] ?? String(args.status ?? '')
    const comment = firstString(args, ['comment'])
    const itemNo = Number.isInteger(idx) && idx >= 0 ? `第 ${idx + 1} 项` : '清单项'
    const suffix = comment ? `（${comment}）` : ''
    return `更新清单：${itemNo} → ${status}${suffix}`
  }

  const spec = ACTION_SPEC[tool]
  if (!spec) {
    return `调用工具：${tool}`
  }
  const detail = firstString(args, spec.keys)
  return detail ? `${spec.verb}：${detail}` : spec.verb
}
