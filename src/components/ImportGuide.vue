<script setup lang="ts">
/**
 * 导入到「照片」四步示意图指南：解压 → 点进照片 → 点名称旁箭头 → 保存到“照片”。
 * 下载按钮下方与下载后弹框共用同一组件，保证文案与图示完全一致。
 * 插图为手绘卡通风格（不使用用户素材），颜色全部取自设计令牌，随主题切换；
 * 图内文字（文件夹名 / 菜单项）走 i18n。
 */
import { onBeforeUnmount, onMounted, ref, useId } from 'vue'
import { useI18n } from '../i18n'
import Icon from './Icon.vue'

// Boolean prop 缺省会被 Vue 转成 false，必须显式默认 true。
const props = withDefaults(defineProps<{ heading?: boolean }>(), { heading: true })
const { t } = useI18n()
const uid = useId()
const showHeading = props.heading

/* 横向滚动浏览：scroll-snap 卡片 + 圆点/箭头导航 + 两侧渐隐提示 */
const stepNums = [1, 2, 3, 4] as const
const track = ref<HTMLOListElement>()
const active = ref(0)
const canLeft = ref(false)
const canRight = ref(false)
let raf = 0
let resizeObserver: ResizeObserver | undefined

function update(): void {
  const el = track.value
  if (!el) return
  const left = el.scrollLeft
  canLeft.value = left > 4
  canRight.value = left < el.scrollWidth - el.clientWidth - 4
  const trackCenter = el.getBoundingClientRect().left + el.clientWidth / 2
  let best = 0
  let bestDist = Infinity
  Array.from(el.children).forEach((child, i) => {
    const bounds = child.getBoundingClientRect()
    const dist = Math.abs(bounds.left + bounds.width / 2 - trackCenter)
    if (dist < bestDist) {
      bestDist = dist
      best = i
    }
  })
  active.value = best
}

function onScroll(): void {
  cancelAnimationFrame(raf)
  raf = requestAnimationFrame(update)
}

function goTo(index: number): void {
  const el = track.value
  if (!el) return
  const target = Math.max(0, Math.min(el.children.length - 1, index))
  const child = el.children[target] as HTMLElement
  const bounds = child.getBoundingClientRect()
  const left = el.scrollLeft + bounds.left - el.getBoundingClientRect().left + (bounds.width - el.clientWidth) / 2
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  el.scrollTo({ left, behavior: reduce ? 'auto' : 'smooth' })
}

onMounted(() => {
  update()
  if (track.value) {
    resizeObserver = new ResizeObserver(update)
    resizeObserver.observe(track.value)
  }
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  resizeObserver?.disconnect()
})

/** 解析 i18n 文案中的 **加粗** 标记为分段（避免 v-html）。 */
function segments(text: string): { t: string; b: boolean }[] {
  const out: { t: string; b: boolean }[] = []
  let bold = false
  let buf = ''
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '*' && text[i + 1] === '*') {
      if (buf) out.push({ t: buf, b: bold })
      buf = ''
      bold = !bold
      i++
      continue
    }
    buf += text[i]
  }
  if (buf) out.push({ t: buf, b: bold })
  return out
}
</script>

<template>
  <section class="files-guide" :aria-labelledby="showHeading ? `guide-title-${uid}` : undefined">
    <h3 v-if="showHeading" :id="`guide-title-${uid}`">{{ t('result.importTitle') }}</h3>
    <div class="carousel" :class="{ 'can-left': canLeft, 'can-right': canRight }">
    <ol ref="track" tabindex="0" :aria-label="t('result.importTitle')" @scroll="onScroll">
      <!-- 1–2 文件列表：轻点 ZIP 解压，再打开 PVT -->
      <li v-for="step in [1, 2]" :key="step" class="step">
        <div class="art" aria-hidden="true">
          <svg viewBox="0 0 320 180">
            <rect x="3" y="3" width="314" height="174" rx="16" class="screen" />
            <text x="26" y="24" class="t-status">9:41</text>
            <circle cx="282" cy="20" r="2.5" class="status-dot" />
            <circle cx="292" cy="20" r="2.5" class="status-dot" />
            <circle cx="302" cy="20" r="2.5" class="status-dot" />
            <text x="26" y="48" class="t-head">{{ t('result.guideFolder') }}</text>
            <rect :y="step === 1 ? 56 : 118" x="14" width="292" height="46" rx="10" class="hl" />
            <g :class="{ faded: step === 2 }">
              <rect x="26" y="62" width="34" height="34" rx="7" class="doc" />
              <path d="M43 67v18" class="zip-line" />
              <circle cx="43" cy="89" r="3" class="zip-pull" />
              <text x="76" y="79" class="t-file" dominant-baseline="central">Live.pvt.zip</text>
            </g>
            <g v-if="step === 2">
              <rect x="20" y="124" width="46" height="34" rx="7" class="thumb-frame" />
              <rect x="22" y="126" width="42" height="17" rx="5" class="thumb-sky" />
              <circle cx="52" cy="134" r="5" class="thumb-sun" />
              <path d="M22 146q11-8 22-1t20-2v13h-42z" class="thumb-hill" />
              <rect x="22" y="147" width="42" height="9" rx="4" class="thumb-water" />
              <text x="76" y="141" class="t-file" dominant-baseline="central">Live.pvt</text>
            </g>
            <g class="tap">
              <circle cx="280" :cy="step === 1 ? 79 : 141" r="12" class="tap-ring outer" />
              <circle cx="280" :cy="step === 1 ? 79 : 141" r="8" class="tap-ring" />
              <circle cx="280" :cy="step === 1 ? 79 : 141" r="3" class="tap-dot" />
            </g>
          </svg>
        </div>
        <div class="step-head"><span class="num">{{ step }}</span><h4>{{ t(step === 1 ? 'result.importStep1Title' : 'result.importStep2Title') }}</h4></div>
        <p><template v-for="(seg, i) in segments(t(step === 1 ? 'result.importStep1Desc' : 'result.importStep2Desc'))" :key="i"><b v-if="seg.b">{{ seg.t }}</b><span v-else>{{ seg.t }}</span></template></p>
      </li>

      <!-- 3 点名称旁的箭头 -->
      <li class="step">
        <div class="art" aria-hidden="true">
          <svg viewBox="0 0 320 180">
            <defs>
              <clipPath :id="`${uid}-photo`"><rect x="16" y="52" width="288" height="112" rx="12" /></clipPath>
            </defs>
            <rect x="3" y="3" width="314" height="174" rx="16" class="screen" />
            <rect x="3" y="3" width="314" height="40" rx="16" class="bar" />
            <path d="M3 43h314" class="hairline" />
            <text x="20" y="28" class="t-name">Live_202611112231834</text>
            <circle cx="204" cy="23" r="10" class="chev-btn" />
            <path d="M199 21l5 5 5-5" class="chev" />
            <path d="M278 18h16m-16 6h16m-16 6h16" class="menu-lines" />
            <circle cx="204" cy="23" r="13" class="chev-highlight" />
            <rect x="16" y="52" width="288" height="112" rx="12" class="photo-frame" />
            <g :clip-path="`url(#${uid}-photo)`">
              <rect x="16" y="52" width="288" height="80" class="sky" />
              <ellipse cx="92" cy="76" rx="26" ry="8" class="cloud" />
              <ellipse cx="152" cy="66" rx="18" ry="6" class="cloud dim" />
              <circle cx="252" cy="84" r="14" class="sun" />
              <path d="M16 126q54-30 114-4t82-4t92-8v54h-288z" class="hill" />
              <rect x="16" y="132" width="288" height="32" class="water" />
              <path d="M32 144q10 4 20 0t20 0t20 0" class="wave" />
              <path d="M196 152q10 4 20 0t20 0" class="wave" />
              <path d="M138 128h28l-6 8h-16z" class="boat-hull" />
              <path d="M152 128v-28" class="boat-mast" />
              <path d="M152 100l16 24h-16z" class="boat-sail" />
            </g>
            <rect x="28" y="64" width="54" height="20" rx="10" class="live-pill" />
            <circle cx="40" cy="74" r="3" class="live-dot" />
            <text x="48" y="78" class="t-live">LIVE</text>
          </svg>
        </div>
        <div class="step-head"><span class="num">3</span><h4>{{ t('result.importStep3Title') }}</h4></div>
        <p><template v-for="(seg, i) in segments(t('result.importStep3Desc'))" :key="i"><b v-if="seg.b">{{ seg.t }}</b><span v-else>{{ seg.t }}</span></template></p>
      </li>

      <!-- 4 保存到“照片” -->
      <li class="step">
        <div class="art" aria-hidden="true">
          <svg viewBox="0 0 320 180">
            <defs>
              <clipPath :id="`${uid}-menu-bg`"><rect x="16" y="52" width="288" height="112" rx="12" /></clipPath>
            </defs>
            <rect x="3" y="3" width="314" height="174" rx="16" class="screen" />
            <g class="faded" :clip-path="`url(#${uid}-menu-bg)`">
              <rect x="16" y="52" width="288" height="80" class="sky" />
              <circle cx="252" cy="84" r="14" class="sun" />
              <path d="M16 126q54-30 114-4t82-4t92-8v54h-288z" class="hill" />
              <rect x="16" y="132" width="288" height="32" class="water" />
            </g>
            <rect x="24" y="18" width="272" height="126" rx="14" class="menu" />
            <rect x="32" y="28" width="256" height="38" rx="10" class="hl-accent" />
            <rect x="40" y="35" width="24" height="24" rx="6" class="photos-icon" />
            <circle cx="58" cy="47" r="4" class="petal p1" />
            <circle cx="55" cy="52.2" r="4" class="petal p2" />
            <circle cx="49" cy="52.2" r="4" class="petal p3" />
            <circle cx="46" cy="47" r="4" class="petal p4" />
            <circle cx="49" cy="41.8" r="4" class="petal p5" />
            <circle cx="55" cy="41.8" r="4" class="petal p6" />
            <circle cx="52" cy="47" r="2.5" class="petal-core" />
            <text x="72" y="52" class="t-save">{{ t('result.guideSave') }}</text>
            <g class="tap">
              <circle cx="268" cy="47" r="16" class="tap-ring outer" />
              <circle cx="268" cy="47" r="11" class="tap-ring" />
              <circle cx="268" cy="47" r="4" class="tap-dot" />
            </g>
            <rect x="32" y="74" width="256" height="14" rx="7" class="skel" />
            <rect x="32" y="96" width="192" height="14" rx="7" class="skel dim" />
            <rect x="32" y="118" width="224" height="14" rx="7" class="skel dimmer" />
            <circle cx="288" cy="152" r="12" class="done" />
            <path d="M282 152l4 4 8-8" class="done-mark" />
          </svg>
        </div>
        <div class="step-head"><span class="num">4</span><h4>{{ t('result.importStep4Title') }}</h4></div>
        <p><template v-for="(seg, i) in segments(t('result.importStep4Desc'))" :key="i"><b v-if="seg.b">{{ seg.t }}</b><span v-else>{{ seg.t }}</span></template></p>
      </li>
    </ol>
    </div>
    <div class="guide-nav">
      <button class="nav-btn guide-prev" type="button" :disabled="!canLeft" :aria-label="t('result.guidePrev')" @click="goTo(active - 1)">
        <Icon name="chevron" :size="14" class="flip" />
      </button>
      <div class="dots">
        <button
          v-for="n in stepNums"
          :key="n"
          class="dot"
          :class="{ on: active === n - 1 }"
          type="button"
          :aria-label="t(`result.importStep${n}Title`)"
          :aria-current="active === n - 1 ? 'true' : undefined"
          @click="goTo(n - 1)"
        />
      </div>
      <button class="nav-btn guide-next" type="button" :disabled="!canRight" :aria-label="t('result.guideNext')" @click="goTo(active + 1)">
        <Icon name="chevron" :size="14" />
      </button>
    </div>
  </section>
</template>

<style scoped>
.files-guide {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: 15px;
  background: var(--surface);
}

.files-guide h3 {
  color: var(--ink);
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 700;
  letter-spacing: -0.01em;
}

/* 横向滚动浏览：snap 卡片 + 主题化滚动条 + 两侧渐隐 */
.carousel {
  position: relative;
}

.carousel::before,
.carousel::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 8px;
  width: 28px;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.2s;
  z-index: 1;
}

.carousel::before {
  left: 0;
  background: linear-gradient(90deg, var(--surface), transparent);
}

.carousel::after {
  right: 0;
  background: linear-gradient(270deg, var(--surface), transparent);
}

.carousel.can-left::before,
.carousel.can-right::after {
  opacity: 1;
}

.files-guide ol {
  --card-width: min(260px, 84%);
  list-style: none;
  margin: 0;
  padding: 0 0 8px;
  display: flex;
  gap: 10px;
  overflow-x: auto;
  scroll-snap-type: x mandatory;
  scrollbar-width: thin;
  scrollbar-color: var(--line-strong) transparent;
}

.step:first-child {
  margin-inline-start: calc((100% - var(--card-width)) / 2);
}

.step:last-child {
  margin-inline-end: calc((100% - var(--card-width)) / 2);
}

.files-guide ol::-webkit-scrollbar {
  height: 6px;
}

.files-guide ol::-webkit-scrollbar-track {
  background: transparent;
}

.files-guide ol::-webkit-scrollbar-thumb {
  background: var(--line-strong);
  border-radius: 999px;
}

.files-guide ol::-webkit-scrollbar-thumb:hover {
  background: var(--ink-3);
}

.step {
  flex: 0 0 var(--card-width);
  scroll-snap-align: center;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--surface-2);
}

.guide-nav {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
}

.nav-btn {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  border: 1px solid var(--line-strong);
  background: var(--surface);
  color: var(--ink-2);
  display: grid;
  place-items: center;
  transition: color 0.2s, border-color 0.2s, transform 0.15s var(--ease-out), opacity 0.2s;
}

.nav-btn:hover:not(:disabled) {
  color: var(--ink);
  border-color: var(--ink-3);
}

.nav-btn:active:not(:disabled) {
  transform: scale(0.92);
}

.nav-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.nav-btn .flip {
  transform: rotate(180deg);
}

.dots {
  display: flex;
  align-items: center;
  gap: 2px;
}

.dot {
  width: 22px;
  height: 18px;
  display: grid;
  place-items: center;
  background: none;
  padding: 0;
}

.dot::after {
  content: '';
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--line-strong);
  transition: width 0.25s var(--ease-out), background 0.2s;
}

.dot:hover::after {
  background: var(--ink-3);
}

.dot.on::after {
  width: 20px;
  background: var(--accent);
}

.art {
  border-radius: 10px;
  overflow: hidden;
}

.art svg {
  display: block;
  width: 100%;
  height: auto;
}

.step-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.num {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent);
  font-family: var(--font-display);
  font-size: 12px;
  font-weight: 700;
  display: grid;
  place-items: center;
}

.step-head h4 {
  font-size: 13px;
  font-weight: 700;
  color: var(--ink);
}

.step p {
  font-size: 12px;
  line-height: 1.55;
  color: var(--ink-2);
}

.step p b {
  color: var(--ink);
  font-weight: 700;
}

/* ---------- 插图（颜色取自令牌，随主题切换） ---------- */
.screen { fill: var(--surface-2); stroke: var(--line-strong); stroke-width: 1.5; }
.bar { fill: var(--surface); }
.hairline { stroke: var(--line); stroke-width: 1; }
.status-dot { fill: var(--ink-3); }
.t-status { font: 600 10px var(--font-display); fill: var(--ink-3); }
.t-head { font: 700 14px var(--font-body); fill: var(--ink); }
.t-file { font: 700 15px var(--font-mono); fill: var(--ink); }
.t-name { font: 700 12px var(--font-display); fill: var(--ink); }
.t-save { font: 700 12px var(--font-body); fill: var(--ink); }
.t-live { font: 700 10px var(--font-display); letter-spacing: 0.12em; fill: var(--live-ink); }

.doc { fill: var(--surface); stroke: var(--ink-3); stroke-width: 1.5; }
.zip-line { stroke: var(--ink-3); stroke-width: 2; stroke-dasharray: 3 3; }
.zip-pull { fill: none; stroke: var(--ink-3); stroke-width: 1.5; }
.faded { opacity: 0.45; }

.tap-dot { fill: var(--accent); }
.tap-ring { fill: none; stroke: var(--accent); stroke-width: 1.5; stroke-dasharray: 4 4; }
.tap-ring.outer { opacity: 0.4; animation: tap-pulse 1.8s ease-in-out infinite; }

@keyframes tap-pulse {
  0%, 100% { opacity: 0.45; }
  50% { opacity: 0.12; }
}


.thumb-frame { fill: var(--surface); stroke: var(--ink-3); stroke-width: 1.5; }
.thumb-sky { fill: var(--info); opacity: 0.3; }
.thumb-sun { fill: var(--live-bg); }
.thumb-hill { fill: var(--ink); opacity: 0.7; }
.thumb-water { fill: var(--info); opacity: 0.5; }

.hl { fill: color-mix(in srgb, var(--live-bg) 14%, transparent); stroke: var(--live-bg); stroke-width: 2; }

.chev-btn { fill: var(--surface-3); }
.chev { fill: none; stroke: var(--ink); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.chev-highlight { fill: none; stroke: var(--accent); stroke-width: 2; }
.menu-lines { stroke: var(--ink-3); stroke-width: 2; stroke-linecap: round; }

.photo-frame { fill: var(--surface); stroke: var(--line-strong); stroke-width: 1.5; }
.sky { fill: var(--info); opacity: 0.28; }
.cloud { fill: var(--surface); opacity: 0.9; }
.cloud.dim { opacity: 0.65; }
.sun { fill: var(--live-bg); }
.hill { fill: var(--ink); opacity: 0.72; }
.water { fill: var(--info); opacity: 0.5; }
.wave { fill: none; stroke: var(--surface); stroke-width: 2; stroke-linecap: round; opacity: 0.7; }
.boat-hull { fill: var(--ink); }
.boat-mast { stroke: var(--ink); stroke-width: 2; stroke-linecap: round; }
.boat-sail { fill: var(--surface); stroke: var(--ink-3); stroke-width: 1; }

.live-pill { fill: var(--live-bg); }
.live-dot { fill: var(--live-ink); }

.menu { fill: var(--surface); stroke: var(--line-strong); stroke-width: 1.5; }
.hl-accent { fill: var(--accent-soft); stroke: var(--accent); stroke-width: 1.5; }
.photos-icon { fill: var(--surface); stroke: var(--line); stroke-width: 1; }
.petal { opacity: 0.85; }
.p1 { fill: var(--accent); }
.p2 { fill: var(--live-bg); }
.p3 { fill: var(--info); }
.p4 { fill: var(--success); }
.p5 { fill: var(--live-bg); }
.p6 { fill: var(--accent); }
.petal-core { fill: var(--surface); }
.skel { fill: var(--surface-3); }
.skel.dim { opacity: 0.7; }
.skel.dimmer { opacity: 0.5; }
.done { fill: var(--success); }
.done-mark { fill: none; stroke: var(--surface); stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
</style>
