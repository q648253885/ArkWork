/* ============================================================
 * ArkWork — 记忆语义标题与引用块工具（v0.27.1 Fix-2）
 * 背景：@ 引用记忆时原始 content 无语义（首行常为内部状态格式），
 *       且 [memory:<id>] 标记此前无人解析（伪引用）。本模块提供：
 *   1) deriveMemoryTitle —— 按 kind 派生确定性语义标题（同输入同输出）
 *   2) expandMemoryQuotes —— 发送前把引用标记展开为可读引用块
 * 缓存红线：两者仅限渲染层展示与用户新消息尾部展开；禁止用于
 *   system prompt 注入或 L1 历史条目装配（改动缓存前缀字节 → 全量 miss）。
 * ============================================================ */

/** 标题派生输入（MemoryItem 的结构化最小集，便于测试桩构造） */
export interface MemoryTitleSource {
  kind: string
  content: string
  /** skill_instruction 等场景的 JSON 元数据（如 {"skillId":"...","skillName":"coder"}） */
  meta?: string | null
}

/** 标题最大长度（超长截断加省略号，保证菜单单行不溢出） */
const TITLE_MAX = 40

/** 去掉「（触发点：…）/ (触发点:…)」内部状态括注（全半角冒号均兼容） */
export function stripMemoryTriggerParens(raw: string): string {
  return raw.replace(/（触发点[：:][^）]*）/g, '').replace(/\(触发点[：:][^)]*\)/g, '')
}

/** 取首个非空行，trim 后截断到 max 字符 */
export function firstMeaningfulLine(raw: string, max = 48): string {
  const line = raw.split(/\r?\n/).find((l) => l.trim().length > 0) ?? ''
  return line.trim().slice(0, max)
}

/**
 * plan_status 触发描述提取：「触发点」+「当前运行第 N 项」。
 * （原 Composer 内 extractMemoryTrigger 的单源迁移版本）
 */
export function extractPlanStatusTrigger(content: string): string {
  const triggerMatch =
    content.match(/（触发点[：:]([^）]*)）/m) ?? content.match(/\(触发点[：:]([^)]*)\)/m)
  const trigger = triggerMatch?.[1]?.trim() ?? ''
  const runningMatch = content.match(/当前运行：第\s*(\d+)\s*项/m)
  const running = runningMatch ? `当前运行第 ${runningMatch[1]} 项` : ''
  if (trigger && running) return `${trigger} · ${running}`
  return trigger || running || ''
}

function truncate(text: string): string {
  return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX)}…` : text
}

/**
 * 派生记忆语义标题（确定性纯函数）。
 * 规则：plan→「计划清单 · N 项」；plan_status→「清单状态 · {触发描述}」；
 * skill_instruction→「技能指令 · {meta.skillName 回落首行}」；
 * kb_hit→「知识库命中 · {库名 #seq}」；file_ref/artifact_ref→按基名；
 * 其余 kind 回落到去噪后的首行摘要。
 */
export function deriveMemoryTitle(src: MemoryTitleSource): string {
  const { kind, content } = src
  if (kind === 'plan') {
    const count = (content.match(/^\s*\d+[.、．]/gm) ?? []).length
    return truncate(count > 0 ? `计划清单 · ${count} 项` : '计划清单')
  }
  if (kind === 'plan_status') {
    const trigger = extractPlanStatusTrigger(content)
    return truncate(trigger ? `清单状态 · ${trigger}` : '清单状态')
  }
  if (kind === 'skill_instruction') {
    let name = ''
    try {
      name = (JSON.parse(src.meta ?? '') as { skillName?: string }).skillName ?? ''
    } catch {
      name = ''
    }
    if (!name) {
      name = firstMeaningfulLine(stripMemoryTriggerParens(content), 80)
        .replace(/^#+\s*/, '')
        .slice(0, 24)
        .trim()
    }
    return truncate(name ? `技能指令 · ${name}` : '技能指令')
  }
  if (kind === 'kb_hit') {
    const m = content.match(/^\s*\[知识库 · ([^\]]+)\]/)
    return truncate(m ? `知识库命中 · ${m[1].trim()}` : '知识库命中')
  }
  if (kind === 'file_ref' || kind === 'artifact_ref') {
    const label = kind === 'file_ref' ? '文件引用' : '产物引用'
    const base = firstMeaningfulLine(content, 120).split(/[\\/]/).pop()?.trim() ?? ''
    return truncate(base ? `${label} · ${base}` : label)
  }
  return truncate(firstMeaningfulLine(stripMemoryTriggerParens(content), 36))
}

/** 引用标记：[memory:<id>]（id 不含 ] 与空白） */
const MEMORY_QUOTE_RE = /\[memory:([^\]\s]+)\]/g

/**
 * 把文本中的 [memory:id] 标记展开为可读引用块（发送前调用）。
 * 展开结果落在用户新消息尾部——属于每轮新增的前缀增量，
 * 不影响既有轮次缓存前缀的字节稳定性（v0.27.1 缓存红线合规）。
 * @param resolve id → 记忆条目最小集；未命中时替换为失效占位文本
 */
export function expandMemoryQuotes(
  text: string,
  resolve: (id: string) => MemoryTitleSource | undefined,
): string {
  return text.replace(MEMORY_QUOTE_RE, (raw, id: string) => {
    const item = resolve(id)
    if (!item) return `[引用记忆已失效：${id}]`
    return `\n【引用记忆 · ${deriveMemoryTitle(item)}】\n${item.content.trim()}\n`
  })
}
