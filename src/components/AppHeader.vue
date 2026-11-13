<script setup lang="ts">
import { useI18n } from '../i18n'
import { useTheme } from '../composables/useTheme'
import Icon from './Icon.vue'

const { t, locale, toggleLocale } = useI18n()
const { mode, cycle } = useTheme()

const themeIcon = { auto: 'monitor', light: 'sun', dark: 'moon' } as const
</script>

<template>
  <header class="header">
    <div class="header-inner">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">
          <Icon name="live" :size="26" />
        </span>
        <div class="brand-text">
          <h1 class="brand-title">{{ t('app.title') }}</h1>
          <p class="brand-tagline">{{ t('app.tagline') }}</p>
        </div>
      </div>

      <div class="controls">
        <button
          class="ctl lang"
          type="button"
          :aria-label="t('header.language')"
          :title="t('header.language')"
          @click="toggleLocale"
        >
          <Icon name="language" :size="15" />
          <span class="lang-label">{{ locale === 'en' ? '中文' : 'EN' }}</span>
        </button>
        <button
          class="ctl"
          type="button"
          :aria-label="`${t('header.theme')}: ${t(`header.theme.${mode}` as const)}`"
          :title="t(`header.theme.${mode}` as const)"
          @click="cycle"
        >
          <Icon :name="themeIcon[mode]" :size="16" />
        </button>
      </div>
    </div>
  </header>
</template>

<style scoped>
.header {
  position: sticky;
  top: 0;
  z-index: 40;
  background: color-mix(in srgb, var(--bg) 78%, transparent);
  backdrop-filter: blur(14px) saturate(1.3);
  -webkit-backdrop-filter: blur(14px) saturate(1.3);
  border-bottom: 1px solid var(--line);
  padding-top: env(safe-area-inset-top);
}

.header-inner {
  max-width: 620px;
  margin: 0 auto;
  height: var(--header-h);
  padding: 0 18px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.brand {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 11px;
  min-width: 0;
}

.brand-mark {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border-radius: 12px;
  color: var(--accent);
  background: var(--accent-soft);
  flex-shrink: 0;
}

.brand-text {
  flex: 1;
  min-width: 0;
}

.brand-title {
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 700;
  letter-spacing: -0.015em;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.brand-tagline {
  font-size: 11.5px;
  color: var(--ink-3);
  line-height: 1.3;
}

.controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.ctl {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 34px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid var(--line-strong);
  background: var(--surface);
  color: var(--ink-2);
  font-size: 12.5px;
  font-weight: 600;
  transition:
    transform 0.15s var(--ease-out),
    color 0.2s,
    border-color 0.2s,
    background 0.2s;
}

.ctl:hover {
  color: var(--ink);
  border-color: var(--ink-3);
}

.ctl:active {
  transform: scale(0.94);
}

.lang-label {
  font-family: var(--font-display);
  letter-spacing: 0.02em;
}

@media (max-width: 380px) {
  .brand-tagline {
    display: none;
  }
}

/* 极窄屏：语言按钮只留图标、品牌名缩字号，保证完整显示 */
@media (max-width: 370px) {
  .lang-label {
    display: none;
  }
  .ctl.lang {
    padding: 0 9px;
  }
  .brand-title {
    font-size: 14px;
  }
}
</style>
