<script setup lang="ts">
/** iOS 风格错误弹框（对应 iOS 端 alert）。 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from '../i18n'
import Icon from './Icon.vue'

defineProps<{ message: string }>()
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const okRef = ref<HTMLButtonElement | null>(null)

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close')
}

onMounted(() => {
  okRef.value?.focus()
  document.addEventListener('keydown', onKey)
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <Teleport to="body">
    <div class="overlay" @click.self="emit('close')">
      <div class="dialog" role="alertdialog" aria-modal="true" :aria-label="t('livePhoto.error.title')">
        <span class="dialog-icon" aria-hidden="true">
          <Icon name="alert" :size="22" />
        </span>
        <h2 class="dialog-title">{{ t('livePhoto.error.title') }}</h2>
        <p class="dialog-message">{{ message }}</p>
        <button ref="okRef" class="dialog-ok" type="button" @click="emit('close')">
          {{ t('common.button.ok') }}
        </button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(8, 9, 12, 0.5);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  animation: fade-in 0.2s var(--ease-out);
}

@keyframes fade-in {
  from {
    opacity: 0;
  }
}

.dialog {
  width: min(340px, 100%);
  border-radius: 20px;
  background: var(--surface);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-2);
  padding: 22px 20px 18px;
  text-align: center;
  animation: dialog-in 0.28s var(--ease-spring);
}

@keyframes dialog-in {
  from {
    opacity: 0;
    transform: scale(0.92) translateY(8px);
  }
}

.dialog-icon {
  display: inline-grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: var(--danger-soft);
  color: var(--danger);
  margin-bottom: 10px;
}

.dialog-title {
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 700;
  letter-spacing: -0.01em;
  margin-bottom: 6px;
}

.dialog-message {
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--ink-2);
  margin-bottom: 16px;
}

.dialog-ok {
  width: 100%;
  min-height: 42px;
  border-radius: 12px;
  background: var(--accent);
  color: var(--accent-ink);
  font-weight: 700;
  font-size: 14.5px;
  transition: background 0.2s, transform 0.15s var(--ease-out);
}

.dialog-ok:hover {
  background: var(--accent-hover);
}

.dialog-ok:active {
  transform: scale(0.97);
}
</style>
