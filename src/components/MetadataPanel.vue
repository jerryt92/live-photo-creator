<script setup lang="ts">
/** 元数据面板：来源分段选择 + 拍摄时间/位置读数。 */
import { computed } from 'vue'
import { useI18n } from '../i18n'
import { useMaker } from '../features/livephoto/store'
import { formatCaptureDate, formatCoordinate } from '../features/livephoto/services/capture'
import SegmentedControl from './SegmentedControl.vue'

const { t, intlLocale } = useI18n()
const { state, isWorking, selectedMetadata } = useMaker()

const sourceOptions = computed(() => [
  { value: 'photo', label: t('livePhoto.photo.title') },
  { value: 'video', label: t('livePhoto.video.title') },
])

const dateText = computed(() => {
  const date = selectedMetadata.value.creationDate
  return date ? formatCaptureDate(date, intlLocale.value) : t('livePhoto.metadata.missing')
})

const locationText = computed(() => {
  const coordinate = selectedMetadata.value.coordinate
  return coordinate ? formatCoordinate(coordinate) : t('livePhoto.metadata.missing')
})
</script>

<template>
  <section class="card" :class="{ working: isWorking }">
    <header class="card-head">
      <h2 class="card-title">{{ t('livePhoto.metadata.section') }}</h2>
    </header>

    <div class="card-body">
      <div class="field">
        <span class="field-label">{{ t('livePhoto.metadata.source') }}</span>
        <SegmentedControl
          v-model="state.metadataSource"
          :options="sourceOptions"
          :disabled="isWorking"
          :aria-label="t('livePhoto.metadata.source')"
        />
      </div>

      <dl class="readings">
        <div class="reading">
          <dt>{{ t('photo.preview.info.captureDate') }}</dt>
          <dd class="mono" :class="{ missing: !selectedMetadata.creationDate }">{{ dateText }}</dd>
        </div>
        <div class="reading">
          <dt>{{ t('photo.preview.info.location') }}</dt>
          <dd class="mono" :class="{ missing: !selectedMetadata.coordinate }">{{ locationText }}</dd>
        </div>
      </dl>
    </div>

    <footer class="card-foot">{{ t('livePhoto.metadata.footer') }}</footer>
  </section>
</template>

<style scoped>
.card {
  border-radius: var(--radius-l);
  background: var(--surface);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-1);
  overflow: hidden;
  transition: opacity 0.25s;
}

.card.working {
  opacity: 0.7;
}

.card-head {
  padding: 14px 16px 0;
}

.card-title {
  font-family: var(--font-display);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--ink-3);
}

.card-body {
  padding: 12px 16px 14px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.field-label {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--ink-2);
}

.readings {
  margin: 0;
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--line);
}

.reading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 14px;
  padding: 10px 0;
  border-bottom: 1px solid var(--line);
}

.reading:last-child {
  border-bottom: none;
  padding-bottom: 2px;
}

.reading dt {
  font-size: 13.5px;
  color: var(--ink-2);
  flex-shrink: 0;
}

.reading dd {
  margin: 0;
  font-size: 12.5px;
  color: var(--ink);
  text-align: right;
  min-width: 0;
  overflow-wrap: anywhere;
}

.reading dd.missing {
  color: var(--ink-3);
  font-family: var(--font-body);
}

.card-foot {
  padding: 10px 16px 14px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--ink-3);
  border-top: 1px solid var(--line);
  background: var(--surface-2);
}
</style>
