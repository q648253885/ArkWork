/**
 * 动作意图展示层翻译（v0.29.0 F5）。
 *
 * 主进程广播的 ReActStep 自 v0.29.0 起携带 intentKey + intentParams
 * （见 shared/utils/action-description.ts describeActionKey）；
 * 渲染层在展示时用当前语言翻译，历史记录无 intentKey 时回落 intent 原文（zh）。
 * 用模块级 i18next 实例惰性取词，保证语言切换即时生效（与 constants.ts 同模式）。
 */
import i18next from '../i18n'
import type { ReActStep } from '@shared/types/react'

type IntentCarrier = Pick<ReActStep, 'intent' | 'intentKey' | 'intentParams'>

/** 取步骤的动作意图本地化文本；无法提供时返回 undefined（由调用方走各自回退链） */
export function intentText(step: IntentCarrier | null | undefined): string | undefined {
  if (!step) return undefined
  if (step.intentKey) return i18next.t(step.intentKey, { ...step.intentParams })
  return step.intent || undefined
}
