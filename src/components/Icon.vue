<script setup lang="ts">
/** 内联 SVG 图标集（24×24，描边风格）。 */
const props = defineProps<{ name: string; size?: number }>()

const icons: Record<string, string> = {
  live: '<circle cx="12" cy="12" r="9" stroke-dasharray="2.6 3.4"/><circle cx="12" cy="12" r="5.2"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  photo: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="M3.5 17.5l5-4.5 3.5 3 4-4.5 4.5 5"/>',
  video: '<rect x="3" y="5.5" width="13.5" height="13" rx="2.5"/><path d="M16.5 10.5l4.5-2.8v8.6l-4.5-2.8"/>',
  chevron: '<path d="M9 5.5l6.5 6.5L9 18.5"/>',
  xCircle: '<circle cx="12" cy="12" r="9"/><path d="M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6"/>',
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6"/>',
  moon: '<path d="M20 13.5A8.2 8.2 0 0110.5 4 8.2 8.2 0 1020 13.5z"/>',
  monitor: '<rect x="3" y="4.5" width="18" height="12.5" rx="2"/><path d="M9 20.5h6M12 17v3.5"/>',
  language: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.4 3.9 5.4 3.9 9s-1.3 6.6-3.9 9c-2.6-2.4-3.9-5.4-3.9-9S9.4 5.4 12 3z"/>',
  download: '<path d="M12 3.5v11M7.5 10L12 14.5 16.5 10M4.5 17v2A1.5 1.5 0 006 20.5h12a1.5 1.5 0 001.5-1.5v-2"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>',
  link: '<path d="M10 13.5a5 5 0 007.5.5l2-2a5 5 0 00-7-7l-1.2 1.1"/><path d="M14 10.5a5 5 0 00-7.5-.5l-2 2a5 5 0 007 7l1.2-1.1"/>',
  share: '<path d="M12 3.5v11M7.5 8L12 3.5 16.5 8M4.5 13v6A1.5 1.5 0 006 20.5h12a1.5 1.5 0 001.5-1.5v-6"/>',
  check: '<path d="M4.5 12.5l5 5L19.5 7"/>',
  play: '<path d="M8 5.5l10 6.5-10 6.5z" fill="currentColor" stroke="none"/>',
  volume: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4z"/><path d="M15.5 9a4.3 4.3 0 010 6M18 6.8a7.6 7.6 0 010 10.4"/>',
  volumeX: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
  again: '<path d="M4 12a8 8 0 108-8 8.6 8.6 0 00-6 2.5L4 8.5"/><path d="M4 3.5v5h5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><circle cx="12" cy="7.8" r="0.6" fill="currentColor" stroke="none"/>',
  file: '<path d="M6 3.5h8L19 8.5v10A1.5 1.5 0 0117.5 20h-11A1.5 1.5 0 015 18.5v-13A1.5 1.5 0 016.5 3.5z"/><path d="M14 3.5v5h5"/>',
  alert: '<path d="M12 3.5L22 20H2L12 3.5z"/><path d="M12 10v4.5"/><circle cx="12" cy="17" r="0.6" fill="currentColor" stroke="none"/>',
  sparkles: '<path d="M12 4l1.8 4.7L18.5 10.5l-4.7 1.8L12 17l-1.8-4.7L5.5 10.5l4.7-1.8L12 4z"/><path d="M18.5 15.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1z"/>',
  shieldCheck: '<path d="M12 3.2l6.8 2.6v5.2c0 4.4-2.9 7.4-6.8 9-3.9-1.6-6.8-4.6-6.8-9V5.8L12 3.2z"/><path d="M9.2 11.9l2 2 3.8-4"/>',
}
</script>

<template>
  <svg
    :width="props.size ?? 20"
    :height="props.size ?? 20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    v-html="icons[props.name] ?? ''"
  />
</template>
