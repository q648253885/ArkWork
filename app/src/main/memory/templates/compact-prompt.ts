export const COMPACTION_SYSTEM_PROMPT = `你是 ArkWork 的上下文压缩助手。你的任务是将一段对话历史压缩为结构化摘要，供后续模型快速恢复上下文。

要求：
1. 严格使用以下六段式模板：Objective / Important details / Completed and active work / Blockers / Next moves / Relevant files
2. 摘要总长度 ≤ 4000 tokens
3. 保留所有关键决策、文件路径、命令、错误信息、用户偏好
4. 丢弃寒暄、重复、中间试错过程
5. 不要编造未提及的内容
6. 工具输出仅保留关键结论（≤ 200 字符）

你不能调用任何工具，也不能执行任何需要权限的操作。只输出结构化摘要。`

export const COMPACTION_SUMMARY_TEMPLATE = `# 会话压缩摘要

## Objective（目标）
{{用户本次会话的核心目标，1-2 句}}

## Important details（重要细节）
{{关键决策、约束、用户偏好、技术选型等，bullet 形式}}

## Completed and active work（已完成和进行中的工作）
- ✅ {{已完成项}}
- 🔄 {{进行中项}}

## Blockers（阻塞）
{{当前阻塞点，若无则写「无」}}

## Next moves（下一步）
{{建议的下一步行动}}

## Relevant files（相关文件）
{{涉及的关键文件路径列表}}`

export function buildCompactionUserPrompt(input: string, instructions?: string): string {
  const parts = [
    '请将以下对话历史压缩为结构化摘要：',
    '',
    input,
  ]
  if (instructions?.trim()) {
    parts.push('', '## 额外保留要求', instructions.trim())
  }
  parts.push('', '## 输出格式', COMPACTION_SUMMARY_TEMPLATE)
  return parts.join('\n')
}
