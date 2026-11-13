<script setup lang="ts">
/**
 * 实况预览台：按住播放视频，松开回到静帧。
 * 空态为同心圆取景器动画；有照片时显示静帧 + LIVE 徽标。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from '../i18n'
import Icon from './Icon.vue'

const props = defineProps<{
  photoUrl?: string
  videoUrl?: string
  stillTime?: number
  duration?: number
  width?: number
  height?: number
}>()

const { t } = useI18n()

const videoRef = ref<HTMLVideoElement | null>(null)
const holding = ref(false)
const videoReady = ref(false)
const muted = ref(false)
const progress = ref(0)
const ended = ref(false)

const emit = defineEmits<{ videoReady: [video: HTMLVideoElement] }>()
const live = computed(() => !!props.videoUrl)

let holdTimer: number | undefined
let rvfcHandle: number | undefined

function startPlayback(): void {
  const video = videoRef.value
  if (!video || !live.value) return
  holding.value = true
  ended.value = false
  // 循环播放贴合封面锚点：从所选封面时刻起播；未指定封面位置则从开头。
  const anchor = Math.max(props.stillTime ?? 0, 0)
  const start = props.duration ? Math.min(anchor, props.duration) : anchor
  progress.value = props.duration ? start / props.duration : 0
  video.currentTime = start
  void video.play().catch(() => {
    holding.value = false
  })
}

function stopPlayback(): void {
  window.clearTimeout(holdTimer)
  if (!holding.value) return
  holding.value = false
  ended.value = false
  const video = videoRef.value
  if (video) {
    video.pause()
    // 回到静帧时刻，便于下次播放前预览锚点
    if (props.stillTime !== undefined) {
      try {
        video.currentTime = props.stillTime
      } catch {
        /* ignore */
      }
    }
  }
}

function onPointerDown(e: PointerEvent): void {
  if (!live.value) return
  e.preventDefault()
  ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  window.clearTimeout(holdTimer)
  holdTimer = window.setTimeout(startPlayback, 130)
}

function onPointerUp(): void {
  stopPlayback()
}

function onKeyDown(e: KeyboardEvent): void {
  if (!live.value) return
  if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault()
    if (!holding.value) startPlayback()
  } else if (e.key === 'Escape') {
    stopPlayback()
  }
}

function onKeyUp(e: KeyboardEvent): void {
  if (e.key === ' ' || e.key === 'Enter') stopPlayback()
}

function onTimeUpdate(): void {
  const video = videoRef.value
  if (!video || !props.duration) return
  progress.value = Math.min(1, video.currentTime / props.duration)
}

function onEnded(): void {
  ended.value = true
  progress.value = 1
}

function onVideoPlaying(): void {
  const video = videoRef.value
  if (!video) return
  // 首帧真正上屏后再淡入，避免黑闪
  if ('requestVideoFrameCallback' in video) {
    rvfcHandle = (video as HTMLVideoElement & {
      requestVideoFrameCallback: (cb: () => void) => number
    }).requestVideoFrameCallback(() => {
      videoReady.value = true
    })
  } else {
    window.setTimeout(() => {
      videoReady.value = true
    }, 80)
  }
}

function toggleMute(): void {
  muted.value = !muted.value
}

watch(
  () => props.videoUrl,
  () => {
    stopPlayback()
    videoReady.value = false
    progress.value = 0
  },
)

onBeforeUnmount(() => {
  window.clearTimeout(holdTimer)
  const video = videoRef.value
  if (video && rvfcHandle !== undefined && 'cancelVideoFrameCallback' in video) {
    ;(video as HTMLVideoElement & { cancelVideoFrameCallback: (h: number) => void }).cancelVideoFrameCallback(rvfcHandle)
  }
  video?.pause()
})

const readout = computed(() => {
  const parts: string[] = []
  if (props.width && props.height) parts.push(`${props.width} × ${props.height}`)
  if (props.duration) parts.push(`${props.duration.toFixed(1)}s`)
  return parts.join('  ·  ')
})

const stageLabel = computed(() =>
  live.value ? `${t('preview.live')} — ${t('preview.hold')}` : t('preview.empty.title'),
)
</script>

<template>
  <div
    class="stage"
    :class="{ live, holding: holding && videoReady }"
    role="button"
    :tabindex="live ? 0 : -1"
    :aria-label="stageLabel"
    :aria-pressed="holding"
    @pointerdown="onPointerDown"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @pointerleave="onPointerUp"
    @keydown="onKeyDown"
    @keyup="onKeyUp"
    @contextmenu.prevent
  >
    <!-- 空态：同心圆取景器 -->
    <div v-if="!photoUrl && !videoUrl" class="empty">
      <svg class="rings" viewBox="0 0 120 120" aria-hidden="true">
        <circle class="ring ring-outer" cx="60" cy="60" r="52" />
        <circle class="ring ring-mid" cx="60" cy="60" r="36" />
        <circle class="ring ring-inner" cx="60" cy="60" r="20" />
        <circle class="core" cx="60" cy="60" r="7" />
      </svg>
      <p class="empty-title">{{ t('preview.empty.title') }}</p>
      <p class="empty-hint">{{ t('preview.empty.hint') }}</p>
    </div>

    <template v-else>
      <img v-if="photoUrl" class="photo" :src="photoUrl" :alt="t('livePhoto.photo.title')" draggable="false" />
      <video
        v-if="videoUrl"
        ref="videoRef"
        class="video"
        :class="{ show: !photoUrl || (holding && videoReady) }"
        :src="videoUrl"
        :muted="muted"
        playsinline
        preload="auto"
        @loadeddata="emit('videoReady', $event.target as HTMLVideoElement)"
        @timeupdate="onTimeUpdate"
        @ended="onEnded"
        @playing="onVideoPlaying"
      />

      <!-- 取景框四角 -->
      <div class="corners" aria-hidden="true">
        <span class="c tl" /><span class="c tr" /><span class="c bl" /><span class="c br" />
      </div>

      <!-- LIVE / STILL 徽标 -->
      <div class="badge" :class="{ on: live }">
        <span class="badge-dot" :class="{ pulse: live && !holding }" />
        <span class="badge-text">{{ live ? t('preview.live') : t('preview.still') }}</span>
      </div>

      <!-- 静音开关 -->
      <button
        v-if="live"
        class="mute"
        type="button"
        :aria-label="muted ? t('preview.unmute') : t('preview.mute')"
        :title="muted ? t('preview.unmute') : t('preview.mute')"
        @pointerdown.stop
        @click.stop="toggleMute"
      >
        <Icon :name="muted ? 'volumeX' : 'volume'" :size="16" />
      </button>

      <!-- 底部读数 / 提示 -->
      <div class="readout mono">
        <span v-if="holding && !ended" class="playing-label">{{ t('preview.playing') }}</span>
        <span v-else-if="live" class="hold-label">{{ t('preview.hold') }}</span>
        <span v-else class="hold-label">{{ t('preview.photoOnly') }}</span>
        <span v-if="readout" class="dims">{{ readout }}</span>
      </div>

      <!-- 播放进度 -->
      <div v-if="live" class="progress-track" aria-hidden="true">
        <div class="progress-fill" :style="{ transform: `scaleX(${holding ? progress : 0})` }" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.stage {
  position: relative;
  aspect-ratio: 4 / 3;
  border-radius: var(--radius-l);
  overflow: hidden;
  background:
    radial-gradient(120% 90% at 50% 0%, #1a1e28 0%, var(--stage-bg) 58%);
  box-shadow: var(--shadow-2);
  border: 1px solid var(--line);
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
  cursor: default;
  isolation: isolate;
}

.stage.live {
  cursor: pointer;
}

.stage:focus-visible {
  outline: 2px solid var(--info);
  outline-offset: 3px;
}

/* ---------- 空态 ---------- */
.empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 24px;
  text-align: center;
}

.rings {
  width: clamp(96px, 26vw, 132px);
  height: auto;
  margin-bottom: 14px;
}

.ring {
  fill: none;
  stroke-width: 1.6;
  transform-origin: 60px 60px;
}

.ring-outer {
  stroke: var(--accent);
  stroke-dasharray: 3 7;
  stroke-linecap: round;
  opacity: 0.85;
  animation: spin 26s linear infinite;
}

.ring-mid {
  stroke: var(--live-bg);
  opacity: 0.8;
  animation: spin 18s linear infinite reverse;
  stroke-dasharray: 60 12;
  stroke-linecap: round;
}

.ring-inner {
  stroke: var(--info);
  opacity: 0.65;
  stroke-dasharray: 2 6;
  stroke-linecap: round;
  animation: spin 12s linear infinite;
}

.core {
  fill: var(--accent);
  animation: breathe 2.6s var(--ease-out) infinite;
  transform-origin: 60px 60px;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes breathe {
  0%,
  100% {
    transform: scale(1);
    opacity: 1;
  }
  50% {
    transform: scale(1.35);
    opacity: 0.72;
  }
}

.empty-title {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: clamp(17px, 4.4vw, 21px);
  letter-spacing: -0.01em;
  color: var(--stage-ink);
}

.empty-hint {
  font-size: 13px;
  line-height: 1.55;
  color: rgba(242, 243, 247, 0.55);
  max-width: 34ch;
}

/* ---------- 静帧 / 视频 ---------- */
.photo,
.video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: var(--stage-bg);
}

.photo {
  transition: opacity 0.24s var(--ease-out), transform 0.5s var(--ease-out);
}

.stage.holding .photo {
  opacity: 0;
  transform: scale(1.015);
}

.video {
  opacity: 0;
  transition: opacity 0.24s var(--ease-out);
}

.video.show {
  opacity: 1;
}

/* ---------- 取景框 ---------- */
.corners {
  position: absolute;
  inset: 12px;
  pointer-events: none;
  opacity: 0.5;
  transition: opacity 0.3s var(--ease-out);
}

.stage.holding .corners {
  opacity: 0.9;
}

.c {
  position: absolute;
  width: 18px;
  height: 18px;
  border: 2px solid rgba(242, 243, 247, 0.75);
}

.c.tl {
  top: 0;
  left: 0;
  border-right: none;
  border-bottom: none;
  border-top-left-radius: 6px;
}

.c.tr {
  top: 0;
  right: 0;
  border-left: none;
  border-bottom: none;
  border-top-right-radius: 6px;
}

.c.bl {
  bottom: 0;
  left: 0;
  border-right: none;
  border-top: none;
  border-bottom-left-radius: 6px;
}

.c.br {
  bottom: 0;
  right: 0;
  border-left: none;
  border-top: none;
  border-bottom-right-radius: 6px;
}

/* ---------- 徽标 ---------- */
.badge {
  position: absolute;
  top: 14px;
  left: 14px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 999px;
  background: rgba(10, 12, 16, 0.55);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border: 1px solid rgba(242, 243, 247, 0.16);
  font-family: var(--font-display);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.14em;
  color: rgba(242, 243, 247, 0.72);
  pointer-events: none;
}

.badge.on {
  color: var(--live-ink);
  background: var(--live-bg);
  border-color: transparent;
}

.badge-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}

.badge-dot.pulse {
  animation: badge-pulse 1.8s var(--ease-out) infinite;
}

@keyframes badge-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(36, 26, 0, 0.35);
  }
  55% {
    box-shadow: 0 0 0 5px rgba(36, 26, 0, 0);
  }
}

/* ---------- 静音 ---------- */
.mute {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: rgba(10, 12, 16, 0.55);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border: 1px solid rgba(242, 243, 247, 0.16);
  color: rgba(242, 243, 247, 0.85);
  transition: transform 0.15s var(--ease-out), background 0.2s;
}

.mute:hover {
  background: rgba(10, 12, 16, 0.75);
}

.mute:active {
  transform: scale(0.92);
}

/* ---------- 读数 ---------- */
.readout {
  position: absolute;
  left: 14px;
  right: 14px;
  bottom: 12px;
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 10px;
  font-size: 11px;
  color: rgba(242, 243, 247, 0.66);
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
  pointer-events: none;
}

.hold-label,
.playing-label {
  font-family: var(--font-body);
  letter-spacing: 0.02em;
}

.playing-label {
  color: var(--live-bg);
}

.dims {
  opacity: 0.8;
  white-space: nowrap;
}

/* ---------- 进度 ---------- */
.progress-track {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  background: rgba(242, 243, 247, 0.12);
}

.progress-fill {
  height: 100%;
  background: var(--live-bg);
  transform-origin: left;
  transform: scaleX(0);
  transition: transform 0.12s linear;
}
</style>
