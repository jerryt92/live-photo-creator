<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from '../i18n'
import { useMaker } from '../features/livephoto/store'
import { buildPvtZip } from '../features/livephoto/services/pvt'
import { HeicCoverError } from '../features/livephoto/services/heic'
import Icon from './Icon.vue'
import ImportGuide from './ImportGuide.vue'

const { t } = useI18n()
const props = defineProps<{ ios: boolean }>()
const { state, reset } = useMaker()
const retry = ref(0)
const downloadStarted = ref(false)
const archive = ref<{ url: string; name: string }>()
const downloadArea = ref<HTMLElement>()
const downloadsDialog = ref<HTMLDialogElement>()
// Safari may also be configured to save in On My iPhone or a custom location.
const iCloudDownloads = 'shareddocuments:///private/var/mobile/Library/Mobile%20Documents/com~apple~CloudDocs/Downloads'

function scrollToDownload(): void {
  const target = downloadArea.value
  if (!target) return
  target.focus({ preventScroll: true })
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  target.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'instant' : 'smooth' })
}

function showDownloadsGuide(): void {
  downloadStarted.value = true
  if (!props.ios) return
  // Let the browser process the download link before opening the guide.
  window.setTimeout(() => {
    const dialog = downloadsDialog.value
    if (dialog?.isConnected && !dialog.open) dialog.showModal()
  }, 0)
}

// showModal 默认聚焦底部第一个可聚焦元素，会把长弹框滚到底；打开时回到第一步。
function onDialogToggle(): void {
  const dialog = downloadsDialog.value
  if (dialog?.open) {
    dialog.scrollTop = 0
    dialog.focus({ preventScroll: true })
  }
}
const failure = ref<'unavailable' | 'encoding' | 'export'>()
const preparing = computed(() => !archive.value && !failure.value)
const failureMessage = computed(() => {
  if (failure.value === 'unavailable') {
    return window.isSecureContext ? 'result.hevcUnavailable' : 'result.hevcNeedsSecureContext'
  }
  if (failure.value === 'encoding') return 'result.heicEncodingFailed'
  return 'result.pvtFailed'
})

watch([() => state.result, retry], async ([result], _, onCleanup) => {
  downloadStarted.value = false
  archive.value = undefined
  failure.value = undefined
  if (!result) return

  const controller = new AbortController()
  let url: string | undefined
  onCleanup(() => {
    controller.abort()
    if (url) URL.revokeObjectURL(url)
  })
  try {
    const stem = result.photoName.replace(/\.JPG$/i, '')
    const blob = await buildPvtZip(result, stem, controller.signal)
    if (controller.signal.aborted) return
    url = URL.createObjectURL(blob)
    archive.value = { url, name: `${stem}.pvt.zip` }
  } catch (error) {
    if (controller.signal.aborted) return
    console.error('Photo export failed', error)
    failure.value = error instanceof HeicCoverError ? error.reason : 'export'
  }
}, { immediate: true })
</script>

<template>
  <section v-if="state.result" class="result">
    <header class="result-status">
      <span v-if="preparing" class="check-ring loading-ring" aria-hidden="true">
        <span class="spinner" />
      </span>
      <span v-else-if="archive" class="check-ring" aria-hidden="true">
        <svg viewBox="0 0 32 32" class="check-svg">
          <circle class="check-circle" cx="16" cy="16" r="14" />
          <path class="check-mark" d="M9.5 16.5l4.5 4.5 8.5-9.5" />
        </svg>
      </span>
      <h2 class="result-title" aria-live="polite" aria-atomic="true">
        {{ t(preparing ? 'result.preparingPvt' : failure ? 'result.pvtFailed' : 'result.title') }}
      </h2>
      <button v-if="!failure" class="download-jump" type="button" @click="scrollToDownload">
        {{ t('result.scrollToDownload') }}
        <Icon name="chevron" :size="15" />
      </button>
    </header>

    <div class="actions">
      <!-- 失败态：重试入口置顶 -->
      <template v-if="failure">
        <button class="primary" type="button" @click="retry++">
          {{ t('result.retryExport') }}
        </button>
        <p v-if="failure !== 'export'" class="share-note" role="status">{{ t(failureMessage) }}</p>
      </template>
      <!-- 正常态：先完整使用教程，最终下载按钮放教程下面 -->
      <template v-else>
        <ImportGuide />
        <div ref="downloadArea" class="download-area" tabindex="-1">
          <a v-if="archive" class="primary" :href="archive.url" :download="archive.name" @click="showDownloadsGuide">
            <Icon name="download" :size="18" />
            {{ t('result.downloadPvt') }}
          </a>
          <button v-else class="primary" type="button" disabled>
            {{ t('result.preparingPvt') }}
          </button>
        </div>
      </template>
      <button v-if="downloadStarted" class="secondary" type="button" @click="reset">
        <Icon name="again" :size="16" />
        {{ t('result.again') }}
      </button>
    </div>
    <dialog v-if="ios" ref="downloadsDialog" class="downloads-dialog" tabindex="-1" aria-labelledby="downloads-title" @click.self="downloadsDialog?.close()" @toggle="onDialogToggle">
      <h3 id="downloads-title">{{ t('result.importTitle') }}</h3>
      <ImportGuide :heading="false" />
      <a class="primary" :href="iCloudDownloads">{{ t('result.openICloudDownloads') }}</a>
    </dialog>
  </section>
</template>

<style scoped>
.result {
  display: flex;
  flex-direction: column;
  gap: 14px;
  animation: result-in 0.5s var(--ease-out);
}

@keyframes result-in {
  from {
    opacity: 0;
    transform: translateY(14px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.result-status {
  display: flex;
  align-items: center;
  gap: 12px;
}

.download-jump {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
  min-height: 44px;
  margin-inline-start: auto;
  padding: 0 8px;
  color: var(--ink);
  font-size: 12px;
  font-weight: 800;
}

.download-jump:hover {
  color: var(--accent);
}

.download-jump svg {
  transform: rotate(90deg);
}

.download-area {
  display: grid;
  border-radius: 15px;
}

.check-ring {
  flex-shrink: 0;
  width: 40px;
  height: 40px;
}

.loading-ring {
  display: grid;
  place-items: center;
}

.spinner {
  width: 28px;
  height: 28px;
  border: 2.4px solid var(--line-strong);
  border-top-color: var(--ink);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(1turn);
  }
}

@media (prefers-reduced-motion: reduce) {
  .spinner {
    animation: none;
  }
}

.check-svg {
  width: 100%;
  height: 100%;
  fill: none;
  stroke-width: 2.4;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.check-circle {
  stroke: var(--success);
  stroke-dasharray: 88;
  stroke-dashoffset: 88;
  animation: draw 0.6s var(--ease-out) forwards;
}

.check-mark {
  stroke: var(--success);
  stroke-dasharray: 22;
  stroke-dashoffset: 22;
  animation: draw 0.35s 0.45s var(--ease-out) forwards;
}

@keyframes draw {
  to {
    stroke-dashoffset: 0;
  }
}

.result-title {
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.015em;
}

.actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.primary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 50px;
  text-decoration: none;
  border-radius: 15px;
  background: var(--ink);
  color: var(--bg);
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 15px;
  transition: transform 0.15s var(--ease-out), opacity 0.2s;
}

.primary:hover {
  opacity: 0.88;
}

.primary:active {
  transform: scale(0.98);
}

.primary:disabled {
  opacity: 0.6;
}

.secondary {
  align-self: center;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  padding: 0 14px;
  color: var(--ink);
}

.share-note {
  font-size: 12px;
  color: var(--ink-2);
  line-height: 1.5;
}

.downloads-dialog {
  width: min(420px, calc(100% - 40px));
  max-height: calc(100% - 40px);
  margin: auto;
  padding: 20px;
  border: 1px solid var(--line);
  border-radius: 20px;
  background: var(--surface);
  color: var(--ink);
  box-shadow: var(--shadow-2);
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--line-strong) transparent;
}

.downloads-dialog::-webkit-scrollbar {
  width: 8px;
}

.downloads-dialog::-webkit-scrollbar-track {
  background: transparent;
}

.downloads-dialog::-webkit-scrollbar-thumb {
  background: var(--line-strong);
  border-radius: 999px;
}

.downloads-dialog::-webkit-scrollbar-thumb:hover {
  background: var(--ink-3);
}

.downloads-dialog[open] {
  display: grid;
  gap: 10px;
}

/* 横向轮播的固有宽度不得撑破弹框网格轨道 */
.downloads-dialog > * {
  min-width: 0;
}

.downloads-dialog::backdrop {
  background: rgba(8, 9, 12, 0.55);
}

.downloads-dialog h3 {
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 700;
  letter-spacing: -0.01em;
}


</style>
