<script setup lang="ts" generic="T extends string">
/** 分段控件（滑动拇指），泛型以匹配字面量联合值（如 SizeTier）。 */
defineProps<{
  modelValue: T
  options: { value: T; label: string }[]
  disabled?: boolean
  ariaLabel?: string
}>()

const emit = defineEmits<{ 'update:modelValue': [value: T] }>()
</script>

<template>
  <div class="segmented" :class="{ disabled }" role="radiogroup" :aria-label="ariaLabel">
    <span
      class="thumb"
      :style="{
        width: `calc((100% - 6px) / ${options.length})`,
        transform: `translateX(${options.findIndex((o) => o.value === modelValue) * 100}%)`,
      }"
      aria-hidden="true"
    />
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      class="option"
      :class="{ active: option.value === modelValue }"
      role="radio"
      :aria-checked="option.value === modelValue"
      :disabled="disabled"
      @click="emit('update:modelValue', option.value)"
    >
      {{ option.label }}
    </button>
  </div>
</template>

<style scoped>
.segmented {
  position: relative;
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  padding: 3px;
  border-radius: 12px;
  background: var(--surface-3);
  border: 1px solid var(--line);
}

.segmented.disabled {
  opacity: 0.55;
  pointer-events: none;
}

.thumb {
  position: absolute;
  top: 3px;
  bottom: 3px;
  left: 3px;
  border-radius: 9px;
  background: var(--surface);
  box-shadow: var(--shadow-1);
  transition: transform 0.28s var(--ease-spring);
}

.option {
  position: relative;
  z-index: 1;
  padding: 7px 10px;
  border-radius: 9px;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--ink-2);
  transition: color 0.2s;
  white-space: nowrap;
}

.option.active {
  color: var(--ink);
}
</style>
