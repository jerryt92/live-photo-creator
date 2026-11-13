<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from './i18n'
import { useMaker } from './features/livephoto/store'
import AppHeader from './components/AppHeader.vue'
import Icon from './components/Icon.vue'
import LivePreview from './components/LivePreview.vue'
import MediaRow from './components/MediaRow.vue'
import MetadataPanel from './components/MetadataPanel.vue'
import ComposeButton from './components/ComposeButton.vue'
import ResultPanel from './components/ResultPanel.vue'
import AppDialog from './components/AppDialog.vue'
import BrowserRequired from './components/BrowserRequired.vue'

const { t } = useI18n()
const { state, isWorking, selectPhoto, selectVideo, selectCoverFrame, removePhoto, removeVideo, dismissError } = useMaker()
// 版权年份随系统时间自动更新，无需每年手动维护。
const copyrightYear = new Date().getFullYear()
// 构建/启动时刻（vite define 注入），确认页面对应的代码版本。
const buildStamp = __BUILD_STAMP__
const coverDialog = ref<HTMLDialogElement>()
const coverInput = ref<HTMLInputElement>()
const coverVideo = ref<HTMLVideoElement>()
const coverOpen = ref(false)
const frameReady = ref(false)
const coverPosition = ref(0)

function openCoverPicker(): void {
  frameReady.value = false
  coverPosition.value = 0
  coverOpen.value = true
  coverDialog.value?.showModal()
}

function seekCover(event: Event): void {
  const video = coverVideo.value
  if (!video) return
  coverPosition.value = (event.target as HTMLInputElement).valueAsNumber
  video.currentTime = coverPosition.value
}

function uploadCover(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  coverDialog.value?.close()
  void selectPhoto(file)
}

async function useCoverFrame(): Promise<void> {
  const video = coverVideo.value
  if (!video || !frameReady.value || video.seeking) return
  video.pause()
  await selectCoverFrame(video)
  coverDialog.value?.close()
}
const userAgent = navigator.userAgent
const isMac = /\bMacintosh\b/i.test(userAgent)
const isIOS = /\b(?:iPhone|iPad|iPod)\b/i.test(userAgent) ||
  (isMac && navigator.maxTouchPoints > 1)
const isSafari = navigator.vendor === 'Apple Computer, Inc.' &&
  /\bVersion\/[^ ]+.*\bSafari\//.test(userAgent) &&
  !/\b(?:Chrome|Chromium|CriOS|FxiOS|Edg(?:e|A|iOS)?|OPR|OPiOS|DuckDuckGo|YaBrowser|GSA|MicroMessenger|QQBrowser|Instagram|FBAN|FBAV|Line|Brave)\b/i.test(userAgent) &&
  !('brave' in navigator)
const unsupportedDevice = !isMac && !isIOS
// 非 Apple 设备 → 不支持提示；Apple 设备但非 Safari → 全屏 Safari 引导（Mac 同样适用）。
const browserRequired = unsupportedDevice || !isSafari
const step = ref<'materials' | 'metadata' | 'export'>('materials')
const navigation = ref<HTMLElement>()
const steps = ['materials', 'metadata', 'export'] as const
const hasMaterials = computed(() => !!state.photo && !!state.video)

// 选完素材不自动跳页：由「下一步」按钮推进；合成完成进入导出；重置/素材缺失时回到素材页。
watch([() => state.photo, () => state.video, () => state.result], () => {
  if (state.result) {
    step.value = 'export'
  } else if (!hasMaterials.value && step.value !== 'materials') {
    step.value = 'materials'
  }
})
watch(step, () => {
  const nav = navigation.value
  if (!nav) return
  nav.querySelector<HTMLButtonElement>('[aria-current="step"]')?.focus({ preventScroll: true })
  nav.scrollIntoView({ block: 'nearest' })
}, { flush: 'post' })

function stepDisabled(target: typeof step.value): boolean {
  if (target === step.value) return false
  return isWorking.value ||
    (target === 'metadata' && !hasMaterials.value) ||
    (target === 'export' && !state.result)
}

const errorMessage = computed(() => {
  if (!state.errorCode) return ''
  const base = t(`livePhoto.error.${state.errorCode}` as const)
  return state.errorDetail ? `${base}\n${state.errorDetail}` : base
})

const previewDuration = computed(() => state.video?.duration)

// 输入预览的视频 objectURL：随素材变化创建/回收，避免每次渲染都新建。
const inputVideoUrl = ref<string | undefined>()
function prepareDefaultCover(video: HTMLVideoElement): void {
  if (state.photo || state.result || video.currentSrc !== inputVideoUrl.value) return
  void selectCoverFrame(video, true)
}
watch(
  () => state.video?.file,
  (file) => {
    if (inputVideoUrl.value) URL.revokeObjectURL(inputVideoUrl.value)
    inputVideoUrl.value = file ? URL.createObjectURL(file) : undefined
    // 视频成功选择后立即触发一次首帧封面生成；预览元素 loadeddata
    // 在 iOS 上对高清视频是懒触发的，不能只依赖它。
    if (file && !state.photo && !state.result) void selectCoverFrame(undefined, true)
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  if (inputVideoUrl.value) URL.revokeObjectURL(inputVideoUrl.value)
})
</script>

<template>
  <BrowserRequired v-if="browserRequired" :unsupported="unsupportedDevice" />
  <AppHeader v-else />

  <main v-if="!browserRequired" class="shell">
    <!-- 预览台 -->
    <section v-reveal class="hero" aria-label="Preview">
      <LivePreview
        :photo-url="state.result?.photoUrl ?? state.photo?.previewUrl"
        :video-url="state.result?.videoUrl ?? inputVideoUrl"
        @video-ready="prepareDefaultCover"
        :still-time="state.result?.stillTimeSeconds ?? state.coverTime"
        :duration="previewDuration"
        :width="state.video?.pixelSize?.width ?? state.photo?.pixelSize?.width"
        :height="state.video?.pixelSize?.height ?? state.photo?.pixelSize?.height"
      />
      <!-- 本地处理声明：紧贴预览台下方，加粗强调隐私承诺 -->
      <p class="privacy-note">
        <Icon name="shieldCheck" :size="14" />{{ t('app.footer') }}
      </p>
    </section>

    <div class="step-bar">
      <nav ref="navigation" class="step-navigation" :aria-label="t('workflow.label')">
        <button
          v-for="target in steps"
          :key="target"
          type="button"
          :aria-current="step === target ? 'step' : undefined"
          :aria-controls="`step-${target}`"
          :disabled="stepDisabled(target)"
          @click="step = target"
        >
          {{ t(`workflow.${target}`) }}
        </button>
      </nav>

      <!-- 主操作固定在 tab 下方：素材页「下一步」，元数据页「合成实况照片」 -->
      <div v-if="step !== 'export'" class="step-action">
        <template v-if="step === 'materials'">
          <button
            class="next"
            type="button"
            :disabled="!hasMaterials || isWorking"
            @click="step = 'metadata'"
          >
            <span>{{ t('workflow.next') }}</span>
            <Icon name="chevron" :size="16" />
          </button>
          <p v-if="!hasMaterials && !isWorking" class="action-hint">{{ t('livePhoto.action.hint') }}</p>
        </template>
        <ComposeButton v-else-if="isSafari" />
      </div>
    </div>

    <section v-show="step === 'materials'" id="step-materials" class="materials" aria-labelledby="materials-title">
      <header class="section-head">
        <h2 id="materials-title" class="section-title">{{ t('livePhoto.materials.section') }}</h2>
      </header>
      <div class="rows">
        <MediaRow
          kind="video"
          :item="state.video"
          :importing="state.importingKind === 'video'"
          :disabled="isWorking"
          @select="selectVideo"
          @remove="removeVideo"
        />
        <MediaRow
          kind="photo"
          :item="state.photo"
          :importing="state.importingKind === 'photo'"
          :disabled="isWorking"
          @select="selectPhoto"
          @choose-cover="openCoverPicker"
          @remove="state.video ? selectCoverFrame() : removePhoto()"
        />
      </div>
      <p class="section-foot">{{ t('livePhoto.materials.footer') }}</p>
    </section>

    <section v-show="step === 'metadata'" id="step-metadata" class="metadata-step">
      <MetadataPanel />
    </section>

    <section v-show="step === 'export'" id="step-export">
      <ResultPanel v-if="state.result" :ios="isIOS" />
    </section>

    <footer class="footer">
      <p class="copyright">© {{ copyrightYear }} jerryt92</p>
      <!-- 构建标记：页面右下角短码用于确认运行的是最新代码（旧标签页/缓存一眼可辨）。 -->
      <p class="build-stamp mono">build {{ buildStamp }}</p>
    </footer>
  </main>

  <dialog v-if="!browserRequired" ref="coverDialog" class="cover-dialog" aria-labelledby="cover-picker-title" @close="coverOpen = false">
    <h2 id="cover-picker-title">{{ t('cover.choose') }}</h2>
    <template v-if="coverOpen && inputVideoUrl">
      <p>{{ t('cover.seek') }}</p>
      <video
        ref="coverVideo"
        :src="inputVideoUrl"
        muted
        playsinline
        preload="auto"
        @play="coverVideo?.pause()"
        @loadeddata="frameReady = true"
        @seeking="frameReady = false"
        @seeked="frameReady = true"
        @error="frameReady = false"
      />
      <input
        class="cover-position"
        type="range"
        min="0"
        :max="previewDuration ?? 0"
        step="0.01"
        :value="coverPosition"
        :disabled="!previewDuration || isWorking"
        :aria-label="t('cover.position')"
        @input="seekCover"
      />
      <button type="button" class="cover-primary" :disabled="!frameReady || isWorking" @click="useCoverFrame">
        {{ t('cover.useFrame') }}
      </button>
    </template>
    <input ref="coverInput" type="file" accept="image/*" hidden @change="uploadCover" />
    <button type="button" :disabled="isWorking" @click="coverInput?.click()">{{ t('cover.upload') }}</button>
    <button type="button" :disabled="isWorking" @click="coverDialog?.close()">{{ t('common.button.cancel') }}</button>
  </dialog>

  <AppDialog v-if="state.errorCode" :message="errorMessage" @close="dismissError" />
</template>

<style scoped>
.shell {
  width: 100%;
  max-width: 620px;
  margin: 0 auto;
  padding: 18px 16px calc(28px + env(safe-area-inset-bottom));
  display: flex;
  flex-direction: column;
  gap: 22px;
  flex: 1;
}

.hero {
  margin-top: 2px;
}

.privacy-note {
  margin-top: 10px;
  padding: 0 4px;
  text-align: center;
  font-size: 12.5px;
  font-weight: 700;
  line-height: 1.55;
  color: var(--ink-2);
}

.privacy-note svg {
  vertical-align: -2.5px;
  margin-right: 5px;
  color: var(--success);
}

.step-bar {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.step-action {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.next {
  width: 100%;
  min-height: 50px;
  border-radius: 16px;
  background: var(--ink);
  color: var(--bg);
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 15px;
  letter-spacing: -0.01em;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  box-shadow: var(--shadow-1);
  transition:
    transform 0.15s var(--ease-out),
    background 0.2s,
    color 0.2s,
    opacity 0.2s;
}

.next:hover:not(:disabled) {
  opacity: 0.92;
}

.next:active:not(:disabled) {
  transform: scale(0.98);
}

.next:disabled {
  background: var(--surface-3);
  color: var(--ink-3);
  box-shadow: none;
  cursor: not-allowed;
}

.action-hint {
  text-align: center;
  font-size: 12.5px;
  color: var(--ink-3);
}

.step-navigation {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 4px;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: 16px;
  background: var(--surface);
}

.step-navigation button {
  min-height: 44px;
  padding: 6px;
  border-radius: 11px;
  color: var(--ink-2);
  font-size: 13px;
  font-weight: 700;
}

.step-navigation button[aria-current="step"] {
  background: var(--ink);
  color: var(--bg);
}

.step-navigation button:disabled {
  opacity: 0.45;
}

.metadata-step {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.cover-dialog {
  width: min(440px, calc(100% - 32px));
  max-height: calc(100% - 32px);
  margin: auto;
  padding: 18px;
  border: 1px solid var(--line);
  border-radius: 20px;
  background: var(--surface);
  color: var(--ink);
}

.cover-dialog[open] { display: grid; gap: 10px; }
.cover-dialog::backdrop { background: rgba(8, 9, 12, 0.55); }
.cover-dialog h2 { font-size: 18px; }
.cover-dialog p { color: var(--ink-2); font-size: 13px; }
.cover-dialog video { width: 100%; max-height: 42dvh; background: #000; border-radius: 12px; }
.cover-position { width: 100%; min-height: 32px; accent-color: var(--accent); }
.cover-dialog button { min-height: 44px; border: 1px solid var(--line); border-radius: 12px; }
.cover-dialog .cover-primary { background: var(--ink); color: var(--bg); }
.cover-dialog button:disabled { opacity: 0.5; }

.section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 0 4px 9px;
}

.section-title {
  font-family: var(--font-display);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--ink-3);
}

.rows {
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.section-foot {
  padding: 9px 4px 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--ink-3);
}

.footer {
  margin-top: 8px;
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 11.5px;
  color: var(--ink-3);
  line-height: 1.5;
}

.copyright {
  font-family: var(--font-display);
  font-weight: 600;
  letter-spacing: 0.04em;
}

.build-stamp {
  font-size: 10.5px;
  color: var(--ink-3);
  opacity: 0.65;
}

</style>
