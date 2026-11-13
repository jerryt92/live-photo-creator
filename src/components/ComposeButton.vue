<script setup lang="ts">
/** 合成按钮：idle → composing → saving（对应 iOS 端 actionSection）。 */
import { computed } from 'vue'
import { useI18n } from '../i18n'
import { useMaker } from '../features/livephoto/store'
import Icon from './Icon.vue'

const { t } = useI18n()
const { state, isWorking, canCompose, compose } = useMaker()

const label = computed(() => {
  switch (state.phase) {
    case 'composing':
      return t('livePhoto.action.composing')
    case 'saving':
      return t('livePhoto.action.saving')
    default:
      return t('livePhoto.action.compose')
  }
})
</script>

<template>
  <div class="action">
    <button
      class="compose"
      :class="{ working: isWorking }"
      type="button"
      :disabled="!canCompose"
      @click="compose()"
    >
      <span class="compose-inner">
        <span v-if="isWorking" class="spinner" aria-hidden="true" />
        <Icon v-else name="live" :size="20" />
        <span class="compose-label">{{ label }}</span>
      </span>
      <span v-if="isWorking" class="shimmer" aria-hidden="true" />
    </button>

    <div v-if="isWorking" class="progress" role="progressbar" :aria-valuenow="Math.round(state.progress * 100)" aria-valuemin="0" aria-valuemax="100">
      <div class="progress-bar" :style="{ transform: `scaleX(${Math.max(0.04, state.progress)})` }" />
    </div>

    <p v-if="!canCompose && !isWorking" class="hint">{{ t('livePhoto.action.hint') }}</p>
  </div>
</template>

<style scoped>
.action {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.compose {
  position: relative;
  width: 100%;
  min-height: 54px;
  border-radius: 16px;
  background: var(--accent);
  color: var(--accent-ink);
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 16px;
  letter-spacing: -0.01em;
  overflow: hidden;
  box-shadow: 0 6px 20px var(--accent-soft), var(--shadow-1);
  transition:
    background 0.2s,
    transform 0.15s var(--ease-out),
    opacity 0.2s,
    box-shadow 0.2s;
}

.compose:hover:not(:disabled) {
  background: var(--accent-hover);
}

.compose:active:not(:disabled) {
  transform: scale(0.98);
}

.compose:disabled {
  background: var(--surface-3);
  color: var(--ink-3);
  box-shadow: none;
  cursor: not-allowed;
}

.compose-inner {
  position: relative;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
}

.spinner {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.35);
  border-top-color: #fff;
  animation: spin 0.7s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.shimmer {
  position: absolute;
  inset: 0;
  background: linear-gradient(100deg, transparent 30%, rgba(255, 255, 255, 0.18) 50%, transparent 70%);
  background-size: 220% 100%;
  animation: shimmer 1.4s linear infinite;
}

@keyframes shimmer {
  from {
    background-position: 180% 0;
  }
  to {
    background-position: -80% 0;
  }
}

.progress {
  height: 4px;
  border-radius: 999px;
  background: var(--surface-3);
  overflow: hidden;
}

.progress-bar {
  height: 100%;
  border-radius: 999px;
  background: var(--accent);
  transform-origin: left;
  transition: transform 0.25s var(--ease-out);
}

.hint {
  text-align: center;
  font-size: 12.5px;
  color: var(--ink-3);
}
</style>
