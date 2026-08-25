/* ============================================================
 * ArkWork — Bugfix Skill: goal-parser (v0.14.0 Task 11.2)
 * 把用户描述（现象 / 复现路径 / 期望行为）解析为
 * Given/When/Then 形式的可验证目标与验收标准。
 * 纯函数，无副作用，可单测。
 * ============================================================ */

export interface BugfixInput {
  /** bug 现象（必填） */
  symptom: string
  /** 复现路径（可选：可为命令，也可为步骤描述） */
  repro?: string
  /** 期望行为（必填） */
  expected: string
}

export interface ParsedGoal {
  /** Given/When/Then 形式的目标描述 */
  goal: string
  /** 可验证的验收标准（测试断言 / 行为校验） */
  acceptanceCriteria: string[]
}

/** 将用户描述转为可验证目标（Given/When/Then） */
export function parseGoal(input: BugfixInput): ParsedGoal {
  const symptom = (input.symptom ?? '').trim()
  const repro = (input.repro ?? '').trim()
  const expected = (input.expected ?? '').trim()
  // 现象与期望行为都为空 → 无法形成目标
  if (!symptom && !expected) {
    return { goal: '', acceptanceCriteria: [] }
  }
  const given = repro
    ? `Given 按复现路径执行：${repro}`
    : symptom
      ? `Given 当前存在缺陷现象：${symptom}`
      : 'Given 当前行为不符合预期'
  const goal = [
    given,
    'When 完成修复并再次触发该路径',
    `Then 期望行为成立：${expected}` + (symptom ? `，且不再出现「${symptom}」` : ''),
  ].join('\n')
  return {
    goal,
    acceptanceCriteria: buildAcceptanceCriteria(symptom, repro, expected),
  }
}

/** 生成可验证验收标准（测试断言 / 行为校验） */
export function buildAcceptanceCriteria(symptom: string, repro: string, expected: string): string[] {
  const criteria: string[] = []
  if (repro) {
    criteria.push(`复现路径在修复后执行成功（退出码 0）：${repro}`)
  }
  if (symptom) {
    criteria.push(`缺陷消失：运行复现路径不再出现「${symptom}」`)
  }
  if (expected) {
    criteria.push(`行为校验通过：${expected}`)
  }
  // 若期望行为中包含反引号命令（如 `npm test`），追加为测试断言
  const testMatch = expected.match(/`([^`]+)`/)
  if (testMatch?.[1]) {
    criteria.push(`测试/检查命令通过：${testMatch[1]}`)
  }
  return criteria
}
