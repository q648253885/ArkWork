/* ============================================================
 * ArkWork — 开发态伪本地化 postProcessor（v0.29.0）
 * 将所有译文逐字符叠加组合波浪线（U+0334）并前后填充，
 * 用于快速暴露固定宽度截断、溢出遮挡等布局缺陷。
 * 启用方式（仅 DEV 生效）：
 *   - URL 带 ?pseudo 参数，或
 *   - localStorage['arkwork:pseudo'] === '1'
 * ============================================================ */
import type { PostProcessorModule } from 'i18next'

const PREFIX = '! '
const SUFFIX = ' !'
const COMBINING_TILDE = '\u0334'

function pseudoTransform(input: string): string {
  let out = ''
  let changed = false
  for (const ch of input) {
    if (/\s/.test(ch)) {
      out += ch
    } else {
      out += ch + COMBINING_TILDE
      changed = true
    }
  }
  return changed ? `${PREFIX}${out}${SUFFIX}` : input
}

export const PSEUDO_POST_PROCESSOR_NAME = 'pseudo'

export function isPseudoEnabled(): boolean {
  if (!import.meta.env.DEV) return false
  try {
    if (new URLSearchParams(window.location.search).has('pseudo')) return true
    return localStorage.getItem('arkwork:pseudo') === '1'
  } catch {
    return false
  }
}

export const pseudoPostProcessor: PostProcessorModule = {
  type: 'postProcessor',
  name: PSEUDO_POST_PROCESSOR_NAME,
  process(value: string): string {
    return isPseudoEnabled() ? pseudoTransform(value) : value
  },
}
