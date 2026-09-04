<script setup lang="ts">
/** Track conditions panel: TRACK / AIR / WIND / HUMIDITY, shown at the start and at set laps. */
const { store } = useRaceStore()
const tiles = computed(() => [
  { label: 'TRACK', value: `${store.weather.track}°`, glyph: 'track' },
  { label: 'AIR', value: `${store.weather.air}°`, glyph: 'air' },
  { label: 'WIND', value: `${store.weather.wind.toFixed(1)}`, unit: 'm/s', glyph: 'wind' },
  { label: 'HUMIDITY', value: `${store.weather.humidity}%`, glyph: 'hum' },
])
</script>

<template>
  <div class="bc-weather">
    <div class="caption"><span>TRACK CONDITIONS</span><span class="sub">SUZUKA</span></div>
    <div class="tiles">
      <div v-for="(t, i) in tiles" :key="t.label" class="tile" :style="{ '--i': i }">
        <label>{{ t.label }}</label>
        <span class="value">{{ t.value }}<small v-if="t.unit">{{ t.unit }}</small></span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bc-weather {
  position: absolute;
  left: 1440px;
  top: 56px;
  width: 420px;
  height: 140px;
  background: var(--bc-panel);
}
.caption { display: flex; align-items: center; justify-content: space-between; height: 30px; padding: 0 12px; font-size: 12px; font-weight: 800; letter-spacing: 0.2em; background: var(--bc-panel-2); }
.caption .sub { font-size: 10px; font-weight: 700; letter-spacing: 0.14em; color: var(--bc-mute); }
.tiles { display: flex; padding: 12px 8px 0; gap: 4px; }
.tile { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 8px; }
.tile label { font-size: 10px; font-weight: 700; letter-spacing: 0.16em; color: var(--bc-mute); }
.tile .value { font-size: 30px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1; }
.tile .value small { font-size: 12px; font-weight: 700; color: var(--bc-mute); margin-left: 3px; }
.pane-enter-active .tile { animation: tileIn 0.25s var(--ease-out) both; animation-delay: calc(150ms + var(--i) * 60ms); }
@keyframes tileIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
</style>
