<script setup lang="ts">
/** 素材行：缩略图 + 标题 + 详情 + 移除（对应 iOS 端 mediaRow）。 */
import { computed, ref } from 'vue'
import { useI18n } from '../i18n'
import type { MediaItem, MediaKind } from '../features/livephoto/models'
import Icon from './Icon.vue'

const props = defineProps<{
  kind: MediaKind
  item: MediaItem | null
  importing: boolean
  disabled: boolean
}>()

const emit = defineEmits<{
  select: [file: File]
  remove: []
  chooseCover: []
}>()

const { t } = useI18n()
const inputRef = ref<HTMLInputElement | null>(null)
const dragging = ref(false)

const accept = computed(() => (props.kind === 'photo' ? 'image/*' : 'video/*'))

const title = computed(() =>
  props.kind === 'photo' ? t('livePhoto.photo.title') : t('livePhoto.video.title'),
)

const detail = computed(() => {
  if (!props.item) {
    return props.kind === 'photo' ? t('livePhoto.photo.placeholder') : t('livePhoto.video.placeholder')
  }
  const parts: string[] = []
  if (props.item.duration !== undefined) {
    const d = props.item.duration
    const minutes = Math.floor(d / 60)
    const seconds = Math.floor(d % 60)
    parts.push(`${minutes}:${String(seconds).padStart(2, '0')}`)
  }
  if (props.item.pixelSize) {
    parts.push(`${Math.round(props.item.pixelSize.width)} × ${Math.round(props.item.pixelSize.height)}`)
  }
  return parts.length > 0 ? parts.join(' · ') : t('livePhoto.media.selected')
})

function pick(): void {
  if (props.disabled || props.importing) return
  if (props.kind === 'photo') emit('chooseCover')
  else inputRef.value?.click()
}

function onFileChange(e: Event): void {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) emit('select', file)
  input.value = ''
}

function onDrop(e: DragEvent): void {
  dragging.value = false
  if (props.disabled || props.importing) return
  const file = e.dataTransfer?.files?.[0]
  if (!file) return
  const ok = props.kind === 'photo' ? file.type.startsWith('image/') : file.type.startsWith('video/')
  if (ok) emit('select', file)
}
</script>

<template>
  <div
    class="row"
    :class="{ disabled, dragging, filled: !!item }"
    role="button"
    :tabindex="disabled ? -1 : 0"
    :aria-label="title"
    @click="pick"
    @keydown.enter.prevent="pick"
    @keydown.space.prevent="pick"
    @dragover.prevent="dragging = true"
    @dragleave="dragging = false"
    @drop.prevent="onDrop"
  >
    <input ref="inputRef" type="file" :accept="accept" hidden @change="onFileChange" />

    <div class="thumb" :class="{ pop: !!item?.previewUrl }">
      <img v-if="item?.previewUrl" :src="item.previewUrl" alt="" draggable="false" />
      <Icon v-else :name="kind === 'photo' ? 'photo' : 'video'" :size="22" />
      <span v-if="item && kind === 'video'" class="play-chip" aria-hidden="true">
        <Icon name="play" :size="9" />
      </span>
    </div>

    <div class="meta">
      <span class="title">{{ title }}</span>
      <span class="detail" :class="{ placeholder: !item }">
        {{ importing ? t('materials.importing') : detail }}
      </span>
      <span v-if="!item" class="drop-hint">{{ t('materials.dropHint') }}</span>
    </div>

    <span v-if="importing" class="spinner" aria-hidden="true" />
    <Icon v-else class="chevron" name="chevron" :size="15" />

    <button
      v-if="item && !importing"
      class="remove"
      type="button"
      :aria-label="kind === 'photo' ? t('livePhoto.photo.remove') : t('livePhoto.video.remove')"
      :disabled="disabled"
      @click.stop="emit('remove')"
    >
      <Icon name="xCircle" :size="19" />
    </button>
  </div>
</template>

<style scoped>
.row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-radius: var(--radius-m);
  background: var(--surface);
  border: 1px solid var(--line);
  cursor: pointer;
  transition:
    border-color 0.2s,
    background 0.2s,
    transform 0.15s var(--ease-out),
    box-shadow 0.2s;
}

.row:hover {
  border-color: var(--line-strong);
  box-shadow: var(--shadow-1);
}

.row:active {
  transform: scale(0.985);
}

.row.disabled {
  opacity: 0.6;
  pointer-events: none;
}

.row.dragging {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.thumb {
  position: relative;
  width: 56px;
  height: 56px;
  flex-shrink: 0;
  border-radius: 12px;
  overflow: hidden;
  display: grid;
  place-items: center;
  background: var(--surface-3);
  color: var(--ink-3);
  border: 1px solid var(--line);
}

.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.thumb.pop img {
  animation: thumb-pop 0.35s var(--ease-spring);
}

@keyframes thumb-pop {
  from {
    transform: scale(0.82);
    opacity: 0;
  }
  to {
    transform: scale(1);
    opacity: 1;
  }
}

.play-chip {
  position: absolute;
  right: 4px;
  bottom: 4px;
  width: 17px;
  height: 17px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.5);
  color: #fff;
}

.meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.title {
  font-family: var(--font-display);
  font-weight: 600;
  font-size: 15px;
  letter-spacing: -0.01em;
}

.detail {
  font-size: 12.5px;
  color: var(--ink-2);
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail.placeholder {
  color: var(--ink-3);
}

.drop-hint {
  display: none;
  font-size: 11px;
  color: var(--ink-3);
}

@media (hover: hover) and (pointer: fine) {
  .drop-hint {
    display: block;
  }
}

.chevron {
  color: var(--ink-3);
  flex-shrink: 0;
}

.spinner {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  border-radius: 50%;
  border: 2px solid var(--line-strong);
  border-top-color: var(--accent);
  animation: spin 0.7s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.remove {
  flex-shrink: 0;
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  color: var(--ink-3);
  transition: color 0.2s, background 0.2s, transform 0.15s var(--ease-out);
}

.remove:hover {
  color: var(--danger);
  background: var(--danger-soft);
}

.remove:active {
  transform: scale(0.9);
}
</style>
