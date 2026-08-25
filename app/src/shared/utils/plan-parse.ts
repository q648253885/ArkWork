/**
 * v0.27.0 R2（§3.2 单源化）：计划清单解析器唯一实现。
 * 原 engine.ts 内私有实现整体迁出，供 engine/plan-parser.ts 与测试直接复用。
 * 纯函数模块：除 plan-noise 外零依赖。
 */
import { isNoisePlanItem } from './plan-noise.js'

/** 从 LLM 回复中解析步骤数组（容忍代码块围栏 / 前后缀文本，过滤噪声项） */
/**
 * v0.19.x：清单项文本规范化 —— 强制单行 + 长度硬上限。
 * 用户反馈清单项内容太多，必须一行内说清"做什么"（如"electron-builder 打包 .app"）。
 * 多行折叠为空格；超过 40 字截断加省略号。
 */
export function sanitizePlanItemText(x: string): string {
  const oneLine = x.replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim()
  return oneLine.length > 40 ? oneLine.slice(0, 40).trimEnd() + '…' : oneLine
}

export function parsePlanItems(raw: string): string[] | null {
  if (!raw) return null
  // 1) 主格式：JSON 字符串数组（可容忍代码块围栏 / 前后缀文本）
  const jsonItems = parsePlanItemsJson(raw)
  if (jsonItems && jsonItems.length > 0) return jsonItems
  // 2) 容错：编号 / 无序列表行（"1. xxx" / "- xxx" / "• xxx"）
  const lineItems = parsePlanItemsLines(raw)
  if (lineItems && lineItems.length > 0) return lineItems
  // 3) 容错：箭头链（"定位问题 → 直接修复 → 验证 → 汇报"）
  const arrowItems = parsePlanItemsArrows(raw)
  if (arrowItems && arrowItems.length > 0) return arrowItems
  return null
}

/** 主解析：从文本中提取 JSON 数组（容忍 ``` 围栏 / 前后缀）。 */
export function parsePlanItemsJson(raw: string): string[] | null {
  let text = raw.replace(/```(?:json)?\s*/g, '').replace(/```/g, '').trim()
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return null
  try {
    const arr = JSON.parse(text.slice(start, end + 1)) as unknown
    if (!Array.isArray(arr)) return null
    const items = arr
      .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      .map((x) => sanitizePlanItemText(x))
      .filter((x) => !isNoisePlanItem(x))
    return items.length > 0 ? items : null
  } catch {
    return null
  }
}

/** 容错：编号 / 无序列表行解析（v0.24.1 —— 思考型模型常输出散文式步骤而非 JSON）。 */
export function parsePlanItemsLines(raw: string): string[] | null {
  const lines = raw
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
  const items: string[] = []
  for (const line of lines) {
    const m = line.match(/^(?:\d+[.、)）:]|[一二三四五六七八九十]+[、.．]|[-*•·])\s*(.+?)[。；;]?\s*$/)
    if (!m) continue
    const text = sanitizePlanItemText(m[1])
    if (text && !isNoisePlanItem(text)) items.push(text)
  }
  return items.length > 0 ? items : null
}

/** 容错：箭头链解析（"A → B → C" / "A -> B" / "A => B"）。 */
export function parsePlanItemsArrows(raw: string): string[] | null {
  const parts = raw.split(/\s*(?:→|->|=>|⇒|→)\s*/)
  if (parts.length < 2) return null
  const items: string[] = []
  for (const part of parts) {
    const cleaned = part
      .replace(/^[\s\-*•·\d.、)）:：]+/, '')
      .replace(/[。；;,.，]$/, '')
      .trim()
    const text = sanitizePlanItemText(cleaned)
    if (text && !isNoisePlanItem(text)) items.push(text)
  }
  return items.length >= 2 ? items.slice(0, 12) : null
}

/**
 * v0.17.5：判断 planItem 文本是否为「阶段标题型」总结性条目（不可勾选）。
 * 阶段标题只是把若干子项打包成组的标签，模型一旦把阶段标题当成可勾选项，
 * 调一次工具就把整阶段都标 done，与真实执行进度脱节。
 *
 * 命中规则（满足任一即视为阶段标题）：
 *  - 以 "阶段 N" / "Phase N" 开头且没有具体动作动词（调研/写/实现/测试/...）
 *  - 文本中没有可识别的动词，仅含"技术选型/架构设计/搭建脚手架"等抽象总结词
 */
export function isPhaseHeader(text: string): boolean {
  const t = text.trim()
  // 规则 1：纯阶段标题前缀（如 "阶段 1：xxx" / "Phase 1: xxx"），后面无任何动作动词
  const phasePrefix = /^(阶段|phase|step|step\s*\d+)\s*\d*\s*[:：、]?\s*/i
  if (!phasePrefix.test(t)) return false
  const afterPrefix = t.replace(phasePrefix, '').trim()
  // 阶段标题通常 ≤ 20 字且不含具体动作动词
  if (afterPrefix.length > 30) return false
  const actionVerbs =
    /调研|搜索|写|实现|开发|编码|测试|部署|打包|封装|接入|初始化|创建|搭建|执行|产出|读取|列出|修复|补|跑|运行|完成|确认|导出|下载|配置|定位|输出|联调|排查|修改/i
  return !actionVerbs.test(afterPrefix)
}
