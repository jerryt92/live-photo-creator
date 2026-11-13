/** 主题：auto / light / dark，持久化并跟随系统变化。 */
import { ref, watch } from 'vue'

export type ThemeMode = 'auto' | 'light' | 'dark'

const STORAGE_KEY = 'lpc.theme'

function readMode(): ThemeMode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'auto' || saved === 'light' || saved === 'dark') return saved
  } catch {
    /* ignore */
  }
  return 'auto'
}

const mode = ref<ThemeMode>(readMode())
const media = window.matchMedia('(prefers-color-scheme: dark)')

function apply(): void {
  const dark = mode.value === 'dark' || (mode.value === 'auto' && media.matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  document.documentElement.dataset.themeMode = mode.value
}

media.addEventListener('change', () => {
  if (mode.value === 'auto') apply()
})

watch(mode, (m) => {
  apply()
  try {
    localStorage.setItem(STORAGE_KEY, m)
  } catch {
    /* ignore */
  }
})

apply()

export function useTheme() {
  function cycle(): void {
    mode.value = mode.value === 'auto' ? 'light' : mode.value === 'light' ? 'dark' : 'auto'
  }
  function set(m: ThemeMode): void {
    mode.value = m
  }
  return { mode, cycle, set }
}
