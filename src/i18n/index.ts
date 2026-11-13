/** 轻量 i18n：en / zh-Hans，自动检测 + 持久化。 */
import { computed, ref } from 'vue'
import { en, type MessageKey } from './en'
import { zhHans } from './zh-Hans'

export type Locale = 'en' | 'zh-Hans'

const STORAGE_KEY = 'lpc.locale'
const catalogs: Record<Locale, Record<MessageKey, string>> = { en, 'zh-Hans': zhHans }

function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'en' || saved === 'zh-Hans') return saved
  } catch {
    /* ignore */
  }
  const nav = navigator.language || 'en'
  return nav.toLowerCase().startsWith('zh') ? 'zh-Hans' : 'en'
}

const locale = ref<Locale>(detectLocale())

function applyLocale(l: Locale): void {
  document.documentElement.lang = l === 'zh-Hans' ? 'zh-Hans' : 'en'
  // 标签页标题与头部「标题 · 副标题」保持同一套文案，随语言切换
  const c = catalogs[l]
  document.title = `${c['app.title']} · ${c['app.tagline'].replace(/[。.]+$/, '')}`
}
applyLocale(locale.value)

export function useI18n() {
  const t = (key: MessageKey): string => catalogs[locale.value][key] ?? en[key] ?? key

  function setLocale(l: Locale): void {
    locale.value = l
    applyLocale(l)
    try {
      localStorage.setItem(STORAGE_KEY, l)
    } catch {
      /* ignore */
    }
  }

  function toggleLocale(): void {
    setLocale(locale.value === 'en' ? 'zh-Hans' : 'en')
  }

  const intlLocale = computed(() => (locale.value === 'zh-Hans' ? 'zh-CN' : 'en-US'))

  return { locale, t, setLocale, toggleLocale, intlLocale }
}

export type { MessageKey }
