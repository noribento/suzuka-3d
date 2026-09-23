<script setup lang="ts">
import { computed, ref, watch } from 'vue'

// the start-up as the viewport reports it (three/loading.ts): the stage that runs, what it does,
// the bar and the stages (or, while the asset pack downloads, the files) that finished last
const { store } = useRaceStore()
const load = computed(() => store.load)
const started = computed(() => load.value.stage !== '')

// The bar glides from the stage's start to its expected end as a transform animation, which the
// compositor keeps running while the stage blocks the main thread (when nothing else on the page
// can move). An explicit `from` rather than a CSS transition: a transition retargeted right after
// a blocked stretch starts from the main thread's stale idea of where the bar was and can run
// backwards; the stage's start is never behind where the last glide got to.
const fillEl = ref<HTMLDivElement>()
let glide: Animation | null = null
watch(
  () => [started.value, load.value.progress, load.value.target, load.value.glideMs] as const,
  ([on, from, to, ms]) => {
    const el = fillEl.value
    if (!el || !on || typeof el.animate !== 'function') return
    glide?.cancel()
    glide = el.animate([{ transform: `scaleX(${from})` }, { transform: `scaleX(${Math.max(from, to)})` }], {
      duration: Math.max(1, ms),
      easing: 'linear',
      fill: 'forwards',
    })
  },
  { flush: 'post', immediate: true },
)
</script>

<template>
  <div class="loading">
    <div class="brand">F1</div>
    <div class="sub">SUZUKA INTERNATIONAL RACING COURSE</div>
    <div class="progress">
      <!-- an indeterminate sweep until the first stage is announced -->
      <div class="bar" :class="{ indeterminate: !started }">
        <div ref="fillEl" class="fill" />
      </div>
      <div class="status">
        <span class="stage">{{ load.stage }}</span>
        <span v-if="started" class="pct">{{ Math.floor(load.progress * 100) }}%</span>
      </div>
      <div class="detail">{{ load.detail }}</div>
      <ol class="log">
        <li v-for="(line, i) in load.log" :key="i" :style="{ opacity: 1 - i * 0.17 }">
          <span class="label">{{ line.label }}</span>
          <span class="value">{{ line.value }}</span>
        </li>
      </ol>
    </div>
  </div>
</template>

<style scoped>
.loading {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 0 16px;
  background: radial-gradient(ellipse at center, #15161f 0%, #05060a 70%);
  z-index: 20;
  letter-spacing: 0.3em;
  font-weight: 700;
}

.brand {
  font-size: 44px;
  font-style: italic;
  font-weight: 900;
  color: var(--f1-red);
  letter-spacing: -0.04em;
}

.sub {
  font-size: 13px;
  color: var(--muted);
  text-align: center;
}

.progress {
  width: min(400px, 100%);
  margin-top: 10px;
  letter-spacing: normal;
}

.bar {
  height: 3px;
  background: rgba(255, 255, 255, 0.1);
  overflow: hidden;
  border-radius: 2px;
}

.fill {
  height: 100%;
  background: var(--f1-red);
  transform-origin: left center;
  transform: scaleX(0);
  /* its own compositor layer, so the glide runs while a builder blocks the main thread */
  will-change: transform;
}

/* nothing announced yet: the classic sweep */
.bar.indeterminate .fill {
  width: 40%;
  transform: none;
  animation: sweep 1.1s infinite ease-in-out;
}

@keyframes sweep {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(260%); }
}

.status {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  margin-top: 12px;
  min-height: 16px;
}

.stage {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: #fff;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pct {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: #fff;
  font-variant-numeric: tabular-nums;
}

.detail {
  margin-top: 4px;
  min-height: 15px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.log {
  list-style: none;
  margin: 14px 0 0;
  padding: 10px 0 0;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  /* five lines, reserved so the block does not jump as they arrive */
  min-height: calc(5 * 16px + 10px);
  font-size: 10px;
  font-weight: 600;
  line-height: 16px;
  letter-spacing: 0.06em;
  color: var(--muted);
}

.log li {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}

.label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.value {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
</style>
