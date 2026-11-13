import type { Directive } from 'vue'

/** 滚动进场：进入视口后添加 .revealed（尊重 reduced-motion）。 */
export const reveal: Directive<HTMLElement> = {
  mounted(el) {
    el.classList.add('reveal')
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.classList.add('revealed')
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            el.classList.add('revealed')
            observer.disconnect()
          }
        }
      },
      { threshold: 0.08 },
    )
    observer.observe(el)
    ;(el as HTMLElement & { __revealObserver?: IntersectionObserver }).__revealObserver = observer
  },
  unmounted(el) {
    ;(el as HTMLElement & { __revealObserver?: IntersectionObserver }).__revealObserver?.disconnect()
  },
}
