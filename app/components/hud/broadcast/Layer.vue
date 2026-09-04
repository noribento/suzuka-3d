<script setup lang="ts">
/**
 * Root of the world-feed package (tv / director camera modes): the 1920×1080 design canvas
 * scaled to the window, every broadcast graphic, the right-hand pane slot (one pane at a time)
 * and the lifecycle of the graphics director that decides what is on air.
 */
import { useBroadcastGraphics } from '~/composables/useBroadcastGraphics'
import { useHudScale } from '~/composables/useHudScale'

const { store } = useRaceStore()
const scale = useHudScale()
const gfx = useBroadcastGraphics()
onMounted(() => gfx.start())
onBeforeUnmount(() => gfx.stop())
const pane = computed(() => store.bc.pane?.kind ?? null)
const style = computed(() => ({ transform: `translate(${scale.x}px, ${scale.y}px) scale(${scale.k})`, '--hud-scale': String(scale.k) }))
</script>

<template>
  <div class="bc" :data-shot="store.shot" :class="{ paused: store.paused }" :style="style">
    <HudBroadcastTower />
    <HudBroadcastStrap />
    <HudBroadcastNameStrap />
    <HudBroadcastBattle />
    <HudBroadcastOnboard />
    <transition name="pane" mode="out-in" :duration="{ enter: 900, leave: 300 }">
      <HudBroadcastTracker v-if="pane === 'tracker'" key="tracker" />
      <HudBroadcastWeather v-else-if="pane === 'weather'" key="weather" />
      <HudBroadcastStrategy v-else-if="pane === 'strategy'" key="strategy" />
    </transition>
  </div>
</template>

<style scoped>
.bc {
  position: absolute;
  left: 0;
  top: 0;
  width: 1920px;
  height: 1080px;
  transform-origin: 0 0;
  pointer-events: none;
  font-family: var(--font);
  color: var(--bc-ink);
  font-variant-ligatures: none;
}
/* right-hand pane slot: a new pane unfolds from its top edge, the old one fades (out-in) */
.pane-enter-active { animation: paneIn 0.4s var(--ease-out) both; }
.pane-leave-active { transition: opacity 0.3s ease-in; }
.pane-leave-to { opacity: 0; }
@keyframes paneIn {
  from { clip-path: inset(0 0 100% 0); }
  to { clip-path: inset(0 0 0 0); }
}
</style>
