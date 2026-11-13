<script setup lang="ts">
/**
 * 全屏浏览器引导门禁（独立组件，统一承载所有全屏提示）：
 *  - Apple 设备但非 Safari → 展示 Safari 徽标，引导复制链接到 Safari 打开；
 *  - 非 Apple 设备 → 展示设备图标，提示不支持。
 * 居中构图 + 取景器光环 + 环境光斑，沿用「暗房 / 取景器」设计令牌，随主题切换。
 */
import { nextTick, onMounted, ref } from 'vue'
import { useI18n } from '../i18n'
import { useTheme } from '../composables/useTheme'
import Icon from './Icon.vue'
import safariLogo from '../assets/safari-logo.webp'

defineProps<{ unsupported: boolean }>()
const { t } = useI18n()
useTheme()

const pageUrl = window.location.href
// 版权年份随系统时间自动更新，与主界面页脚保持一致。
const copyrightYear = new Date().getFullYear()
const title = ref<HTMLElement>()
const address = ref<HTMLInputElement>()
const copied = ref(false)
const showAddress = ref(false)

onMounted(() => title.value?.focus({ preventScroll: true }))

async function copyLink(): Promise<void> {
  try {
    await navigator.clipboard.writeText(pageUrl)
    copied.value = true
  } catch {
    // 剪贴板不可用（部分 WebView / 非安全上下文）→ 展示可长按复制的地址。
    showAddress.value = true
    await nextTick()
    address.value?.focus()
    address.value?.select()
  }
}
</script>

<template>
  <section
    class="browser-gate"
    role="dialog"
    aria-modal="true"
    aria-labelledby="browser-gate-title"
    aria-describedby="browser-gate-guide"
  >
    <!-- 环境背景：光斑 + 颗粒 + 同心取景环 -->
    <div class="gate-bg" aria-hidden="true">
      <span class="gate-ring gate-ring-1"></span>
      <span class="gate-ring gate-ring-2"></span>
      <span class="gate-ring gate-ring-3"></span>
    </div>

    <div class="gate-card">
      <div class="gate-emblem" :class="{ 'is-unsupported': unsupported }">
        <span class="emblem-halo" aria-hidden="true"></span>
        <span class="emblem-orbit" aria-hidden="true"></span>
        <img
          v-if="!unsupported"
          class="emblem-logo"
          :src="safariLogo"
          alt="Safari"
          width="116"
          height="116"
          draggable="false"
        />
        <svg
          v-else
          class="emblem-apple"
          viewBox="0 12 14 16.6"
          width="74"
          height="88"
          role="img"
          aria-label="Apple"
          fill="currentColor"
        >
          <path d="m13.0729 17.6825a3.61 3.61 0 0 0 -1.7248 3.0365 3.5132 3.5132 0 0 0 2.1379 3.2223 8.394 8.394 0 0 1 -1.0948 2.2618c-.6816.9812-1.3943 1.9623-2.4787 1.9623s-1.3633-.63-2.613-.63c-1.2187 0-1.6525.6507-2.644.6507s-1.6834-.9089-2.4787-2.0243a9.7842 9.7842 0 0 1 -1.6628-5.2776c0-3.0984 2.014-4.7405 3.9969-4.7405 1.0535 0 1.9314.6919 2.5924.6919.63 0 1.6112-.7333 2.8092-.7333a3.7579 3.7579 0 0 1 3.1604 1.5802zm-3.7284-2.8918a3.5615 3.5615 0 0 0 .8469-2.22 1.5353 1.5353 0 0 0 -.031-.32 3.5686 3.5686 0 0 0 -2.3445 1.2084 3.4629 3.4629 0 0 0 -.8779 2.1585 1.419 1.419 0 0 0 .031.2892 1.19 1.19 0 0 0 .2169.0207 3.0935 3.0935 0 0 0 2.1586-1.1368z"/>
        </svg>
      </div>

      <p class="gate-eyebrow">{{ t('app.title') }}</p>
      <h1 id="browser-gate-title" ref="title" tabindex="-1" class="gate-title">
        {{ t(unsupported ? 'browserGate.unsupportedTitle' : 'browserGate.safariTitle') }}
      </h1>
      <p id="browser-gate-guide" class="gate-guide">
        {{ t(unsupported ? 'browserGate.unsupportedGuide' : 'browserGate.safariGuide') }}
      </p>

      <button
        v-if="!unsupported"
        class="copy-link"
        :class="{ 'is-copied': copied }"
        type="button"
        @click="copyLink"
      >
        <Icon :name="copied ? 'check' : 'copy'" :size="18" />
        <span>{{ copied ? t('browserGate.copied') : t('browserGate.copy') }}</span>
      </button>
      <p class="copy-status" role="status" aria-live="polite">{{ copied ? t('browserGate.copied') : '' }}</p>

      <label v-if="showAddress" class="manual-copy">
        <span class="manual-label">{{ t('browserGate.manual') }}</span>
        <input ref="address" type="text" readonly :value="pageUrl" />
      </label>

      <p class="gate-foot">{{ t('app.tagline') }}</p>
      <p class="gate-copyright">© {{ copyrightYear }} jerryt92</p>
    </div>
  </section>
</template>

<style scoped>
.browser-gate {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: grid;
  align-items: safe center;
  justify-items: center;
  overflow: auto;
  padding: max(24px, env(safe-area-inset-top)) max(24px, env(safe-area-inset-right))
    max(24px, env(safe-area-inset-bottom)) max(24px, env(safe-area-inset-left));
  background: var(--bg);
  scrollbar-width: thin;
  scrollbar-color: var(--line-strong) transparent;
}

/* ---------- 环境背景 ---------- */
.gate-bg {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  background:
    radial-gradient(52rem 34rem at 85% -8%, var(--glow-a), transparent 62%),
    radial-gradient(44rem 30rem at -12% 22%, var(--glow-b), transparent 60%),
    radial-gradient(40rem 30rem at 50% 118%, var(--glow-c), transparent 65%);
}
.gate-bg::after {
  content: '';
  position: absolute;
  inset: 0;
  opacity: var(--grain-opacity);
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)' opacity='0.6'/%3E%3C/svg%3E");
}
.gate-ring {
  position: absolute;
  top: 50%;
  left: 50%;
  translate: -50% -50%;
  border-radius: 50%;
  border: 1px solid var(--line);
}
.gate-ring-1 { width: 540px; height: 540px; }
.gate-ring-2 { width: 760px; height: 760px; border-style: dashed; opacity: 0.7; }
.gate-ring-3 { width: 980px; height: 980px; opacity: 0.45; }

/* ---------- 居中卡片 ---------- */
.gate-card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 14px;
  width: min(100%, 400px);
  animation: gate-in 0.7s var(--ease-out) both;
}

/* ---------- 徽标 ---------- */
.gate-emblem {
  position: relative;
  width: 158px;
  height: 158px;
  display: grid;
  place-items: center;
  margin-bottom: 4px;
}
.emblem-halo {
  position: absolute;
  inset: -14px;
  border-radius: 50%;
  background: radial-gradient(circle, var(--info-soft), transparent 70%);
  filter: blur(8px);
}
.gate-emblem.is-unsupported .emblem-halo {
  background: radial-gradient(circle, var(--accent-soft), transparent 70%);
}
.emblem-orbit {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 1.5px dashed var(--line-strong);
  animation: gate-spin 26s linear infinite;
}
.emblem-logo {
  position: relative;
  width: 116px;
  height: 116px;
  filter: drop-shadow(0 14px 30px rgba(10, 12, 16, 0.22));
  animation: gate-float 6s ease-in-out infinite;
  user-select: none;
  -webkit-user-drag: none;
}
.emblem-apple {
  position: relative;
  width: 74px;
  height: 88px;
  color: var(--ink);
  filter: drop-shadow(0 12px 26px rgba(10, 12, 16, 0.2));
  animation: gate-float 6s ease-in-out infinite;
  user-select: none;
}

/* ---------- 文案 ---------- */
.gate-eyebrow {
  font-family: var(--font-display);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--ink-3);
}
.gate-title {
  font-family: var(--font-display);
  font-size: clamp(26px, 6vw, 34px);
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: -0.015em;
  color: var(--ink);
}
.gate-title:focus { outline: none; }
.gate-guide {
  color: var(--ink-2);
  font-size: 15px;
  line-height: 1.6;
  max-width: 34ch;
}

/* ---------- 主操作 ---------- */
.copy-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  min-height: 52px;
  padding: 0 30px;
  margin-top: 6px;
  border-radius: 999px;
  background: var(--accent);
  color: var(--accent-ink);
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 16px;
  box-shadow: 0 8px 24px var(--accent-soft), var(--shadow-1);
  transition: transform 0.18s var(--ease-out), background 0.2s, box-shadow 0.2s;
}
.copy-link:hover {
  background: var(--accent-hover);
  transform: translateY(-2px);
  box-shadow: 0 12px 30px var(--accent-soft), var(--shadow-2);
}
.copy-link:active { transform: translateY(0) scale(0.97); }
.copy-link.is-copied {
  background: var(--success);
  box-shadow: 0 8px 24px var(--success-soft), var(--shadow-1);
}
.copy-status {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

/* ---------- 手动复制兜底 ---------- */
.manual-copy {
  display: grid;
  gap: 8px;
  width: 100%;
  margin-top: 4px;
}
.manual-label {
  color: var(--ink-2);
  font-size: 13px;
}
.manual-copy input {
  width: 100%;
  padding: 12px 14px;
  border: 1px solid var(--line-strong);
  border-radius: 12px;
  background: var(--surface);
  color: var(--ink);
  font-family: var(--font-mono);
  font-size: 14px;
  text-align: center;
}
.manual-copy input:focus {
  outline: 2px solid var(--info);
  outline-offset: 1px;
}

.gate-foot {
  margin-top: 10px;
  color: var(--ink-3);
  font-size: 12.5px;
}
.gate-copyright {
  color: var(--ink-3);
  font-family: var(--font-display);
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
}

/* ---------- 动效 ---------- */
@keyframes gate-in {
  from { opacity: 0; transform: translateY(18px) scale(0.97); }
  to { opacity: 1; transform: none; }
}
@keyframes gate-float {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-6px); }
}
@keyframes gate-spin {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .gate-card, .emblem-logo, .emblem-apple, .emblem-orbit { animation: none; }
}
</style>
