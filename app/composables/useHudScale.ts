import { onBeforeUnmount, onMounted, reactive } from 'vue'

export const CANVAS_W = 1920
export const CANVAS_H = 1080

/**
 * The broadcast package is authored on a fixed 1920×1080 canvas (every measurement is a real
 * 1080p broadcast pixel) and the whole canvas is scaled to the window as one unit, centred
 * with letterboxing on non-16:9 windows so the graphics stay inside the 16:9 title-safe frame.
 * CSS cannot divide two lengths into a unitless scale() factor portably, hence a few lines of JS.
 */
export function useHudScale() {
  const scale = reactive({ k: 1, x: 0, y: 0 })
  const update = () => {
    const w = window.innerWidth
    const h = window.innerHeight
    const k = Math.min(w / CANVAS_W, h / CANVAS_H)
    scale.k = k
    scale.x = Math.round((w - CANVAS_W * k) / 2)
    scale.y = Math.round((h - CANVAS_H * k) / 2)
  }
  onMounted(() => {
    update()
    window.addEventListener('resize', update)
  })
  onBeforeUnmount(() => window.removeEventListener('resize', update))
  return scale
}
