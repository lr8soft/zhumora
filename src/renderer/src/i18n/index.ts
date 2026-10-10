// ============================================================
// i18n 初始化 — i18next + react-i18next
// 支持 6 种语言: en, zh, ja, es, fr, de
// 自动检测系统语言，用户可在 Settings 中手动切换
// ============================================================
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './locales/en'
import zh from './locales/zh'
import ja from './locales/ja'
import es from './locales/es'
import fr from './locales/fr'
import de from './locales/de'
import { flowTranslations } from '../flow/translations'

export type AppLanguage = 'en' | 'zh' | 'ja' | 'es' | 'fr' | 'de' | 'auto'

export const SUPPORTED_LANGUAGES: { code: AppLanguage; label: string; nativeLabel: string }[] = [
  { code: 'auto', label: 'Auto', nativeLabel: 'Auto (System)' },
  { code: 'en', label: 'English', nativeLabel: 'English' },
  { code: 'zh', label: 'Chinese', nativeLabel: '中文' },
  { code: 'ja', label: 'Japanese', nativeLabel: '日本語' },
  { code: 'es', label: 'Spanish', nativeLabel: 'Español' },
  { code: 'fr', label: 'French', nativeLabel: 'Français' },
  { code: 'de', label: 'German', nativeLabel: 'Deutsch' }
]

/**
 * 检测系统语言
 * 优先级: navigator.language → navigator.languages[0] → 'en'
 */
export function detectSystemLanguage(): string {
  const navLang = (navigator.language || '').toLowerCase()
  const navLangs = navigator.languages || []

  // 取第一个可用语言
  const candidates = [navLang, ...navLangs.map(l => l.toLowerCase())]

  for (const candidate of candidates) {
    if (candidate.startsWith('zh')) return 'zh'
    if (candidate.startsWith('ja')) return 'ja'
    if (candidate.startsWith('es')) return 'es'
    if (candidate.startsWith('fr')) return 'fr'
    if (candidate.startsWith('de')) return 'de'
    if (candidate.startsWith('en')) return 'en'
  }

  return 'en'
}

/**
 * 获取实际生效的语言代码
 * 如果 lang === 'auto'，则返回检测到的系统语言
 */
export function getEffectiveLanguage(lang: AppLanguage): string {
  if (lang === 'auto') return detectSystemLanguage()
  return lang
}

/**
 * 从 localStorage 读取用户选择的语言
 */
function getStoredLanguage(): AppLanguage {
  try {
    const stored = localStorage.getItem('zhumora-language')
    if (stored && SUPPORTED_LANGUAGES.some(l => l.code === stored)) {
      return stored as AppLanguage
    }
  } catch { /* localStorage not available */ }
  return 'auto'
}

/**
 * 保存语言选择到 localStorage
 */
export function storeLanguage(lang: AppLanguage): void {
  try {
    localStorage.setItem('zhumora-language', lang)
  } catch { /* localStorage not available */ }
}

// 初始化 i18n
const storedLang = getStoredLanguage()
const effectiveLang = getEffectiveLanguage(storedLang)

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: { ...en, flow: flowTranslations.en } },
    zh: { translation: { ...zh, flow: flowTranslations.zh } },
    ja: { translation: { ...ja, flow: flowTranslations.ja } },
    es: { translation: { ...es, flow: flowTranslations.es } },
    fr: { translation: { ...fr, flow: flowTranslations.fr } },
    de: { translation: { ...de, flow: flowTranslations.de } }
  },
  lng: effectiveLang,
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false
  },
  react: {
    useSuspense: false
  }
})

export default i18n
