<script setup lang="ts">
import { CIRCUIT } from '~/data/suzuka'
const { store } = useRaceStore()

const clock = computed(() => {
  const t = Math.max(0, store.elapsed)
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = Math.floor(t % 60)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
})

const sessionLabel = computed(() => {
  switch (store.status) {
    case 'grid': return 'FORMATION'
    case 'lights': return 'START'
    case 'finished': return 'FINISHED'
    default: return 'RACE'
  }
})
</script>

<template>
  <div class="header">
    <div class="brand">
      <span class="f1">F1</span>
      <span class="live"><i />LIVE</span>
    </div>
    <div class="title">
      <div class="gp">{{ CIRCUIT.gpName }}</div>
      <div class="circuit">{{ CIRCUIT.name.toUpperCase() }} · {{ sessionLabel }}</div>
    </div>
    <div class="clock">{{ clock }}</div>
  </div>
  <div class="weather">
    <span><b>TRACK</b> {{ store.weather.track }}°C</span>
    <span><b>AIR</b> {{ store.weather.air }}°C</span>
    <span><b>WIND</b> {{ store.weather.wind.toFixed(1) }} m/s</span>
    <span><b>HUM</b> {{ store.weather.humidity }}%</span>
    <span class="fps"><b>FPS</b> {{ store.fps }}</span>
  </div>
</template>

<style scoped>
.header {
  position: absolute;
  left: 18px;
  top: 16px;
  display: flex;
  align-items: stretch;
  height: 46px;
  background: var(--panel-strong);
  border-radius: 3px;
  overflow: hidden;
  color: #fff;
  font-family: var(--font);
  pointer-events: none;
}
.brand {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 0 12px;
  background: var(--f1-red);
  gap: 1px;
}
.f1 {
  font-size: 20px;
  font-weight: 900;
  font-style: italic;
  letter-spacing: -0.04em;
  line-height: 1;
}
.live {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.15em;
}
.live i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #fff;
  animation: blink 1.4s infinite;
}
@keyframes blink { 50% { opacity: 0.25; } }
.title {
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 0 16px;
  border-right: 1px solid rgba(255, 255, 255, 0.1);
}
.gp {
  font-size: 17px;
  font-weight: 700;
  letter-spacing: 0.06em;
  line-height: 1.1;
}
.circuit {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.12em;
  color: var(--muted);
}
.clock {
  display: flex;
  align-items: center;
  padding: 0 14px;
  font-size: 18px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.weather {
  position: absolute;
  right: 18px;
  top: 16px;
  display: flex;
  gap: 14px;
  height: 30px;
  align-items: center;
  padding: 0 14px;
  background: var(--panel);
  border-radius: 3px;
  color: #fff;
  font-family: var(--font);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  pointer-events: none;
}
.weather b {
  color: var(--muted);
  font-weight: 700;
  font-size: 10px;
  letter-spacing: 0.12em;
  margin-right: 4px;
}
.fps { opacity: 0.7; }
@media (max-width: 900px) {
  .weather { display: none; }
  .title .circuit { display: none; }
}
</style>
