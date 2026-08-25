/* ============================================================
 * ArkWork — i18n 初始化（v0.29.0）
 * react-i18next 接入；zh/en/ja/ko 四语言资源静态打包（桌面端离线可用）。
 * 首帧语言：localStorage 预读（防闪烁，无记录回退 zh）；
 * settings.json 校正由 store.init() 的启动决策流完成。
 * ============================================================ */
import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from './locales/zh.json'
import en from './locales/en.json'
import ja from './locales/ja.json'
import ko from './locales/ko.json'
import { isPseudoEnabled, pseudoPostProcessor } from './pseudo'
import type { Locale } from '@shared/types/ipc'

export const LOCALE_RESOURCES = {
  zh: { translation: zh },
  en: { translation: en },
  ja: { translation: ja },
  ko: { translation: ko },
} as const

/** 宽松校验：未知值 → null */
export function normalizeLocale(v: unknown): Locale | null {
  return v === 'zh' || v === 'en' || v === 'ja' || v === 'ko' ? v : null
}

/** localStorage 预读（无闪烁脚本语义）；无合法记录 → null */
export function localeFromStorage(): Locale | null {
  try {
    return normalizeLocale(localStorage.getItem('arkwork:language'))
  } catch {
    return null
  }
}

/** 全新安装系统语言探测：按优先级匹配 navigator.languages 前两位子标签，未命中回退 zh */
export function detectSystemLocale(): Locale {
  try {
    const tags = typeof navigator !== 'undefined' && navigator.languages?.length
      ? navigator.languages
      : [typeof navigator !== 'undefined' ? navigator.language : '']
    for (const tag of tags) {
      const base = String(tag || '').slice(0, 2).toLowerCase()
      if (base === 'zh' || base === 'en' || base === 'ja' || base === 'ko') return base
    }
  } catch {
    /* ignore */
  }
  return 'zh'
}

/** 同步 <html lang> 与 data-locale（CSS 据此切换字体栈/行高变量） */
export function applyLocaleDocument(locale: Locale): void {
  document.documentElement.lang = locale
  document.documentElement.dataset.locale = locale
}

/** 运行时切换语言（供 store.setLanguage 调用）：i18next + 文档属性一并生效 */
export async function setActiveLocale(locale: Locale): Promise<void> {
  await i18next.changeLanguage(locale)
  applyLocaleDocument(locale)
}

const initialLocale = localeFromStorage() ?? 'zh'

if (import.meta.env.DEV && isPseudoEnabled()) {
  i18next.use(pseudoPostProcessor)
}

void i18next.use(initReactI18next).init({
  resources: LOCALE_RESOURCES,
  lng: initialLocale,
  fallbackLng: 'zh',
  interpolation: { escapeValue: false },
  returnEmptyString: false,
})

applyLocaleDocument(initialLocale)

export default i18next
