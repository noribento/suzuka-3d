<script setup lang="ts">
import { computed } from 'vue'
import type { CameraMode } from '~/composables/useRaceStore'
const { store, setCamera, restart } = useRaceStore()

const cams: { id: CameraMode; label: string; key: string }[] = [
  { id: 'overview', label: 'OVERVIEW', key: '1' },
  { id: 'heli', label: 'HELI', key: '2' },
  { id: 'chase', label: 'CHASE', key: '3' },
  { id: 'onboard', label: 'ONBOARD', key: '4' },
  { id: 'tv', label: 'TV', key: '5' },
  { id: 'director', label: 'AUTO', key: '6' },
]
const speeds = [1, 2, 4, 8]
const clock = computed(() => {
  const h = Math.floor(store.timeOfDay)
  const m = Math.round((store.timeOfDay - h) * 60)
  return `${h}:${String(m).padStart(2, '0')}`
})
</script>

<template>
  <div class="controls">
    <div class="group">
      <button v-for="c in cams" :key="c.id" :class="{ on: store.cameraMode === c.id }" :title="`Key ${c.key}`" @click="setCamera(c.id)">{{ c.label }}</button>
    </div>
    <div class="group">
      <button :class="{ on: store.paused }" :aria-label="store.paused ? 'Resume' : 'Pause'" title="Space" @click="store.paused = !store.paused">{{ store.paused ? '▶' : '❚❚' }}</button>
      <button v-for="s in speeds" :key="s" :class="{ on: store.simSpeed === s }" @click="store.simSpeed = s">{{ s }}×</button>
      <button :class="{ on: store.labels }" title="L — driver tags" @click="store.labels = !store.labels">TAGS</button>
      <button :class="{ on: store.showMap }" title="M — track map" @click="store.showMap = !store.showMap">MAP</button>
      <button :class="{ on: store.audio }" :aria-label="store.audio ? 'Mute audio' : 'Unmute audio'" title="Engine audio" @click="store.audio = !store.audio">{{ store.audio ? '♪' : '♪̸' }}</button>
      <button class="danger" aria-label="Restart the race" title="Restart the race" @click="restart()">↺</button>
    </div>
    <label class="group time" :title="`Time of day ${clock}`">
      <span class="sun">☀</span>
      <input v-model.number="store.timeOfDay" type="range" min="10" max="17.5" step="0.25" aria-label="Time of day">
      <span class="clock">{{ clock }}</span>
    </label>
  </div>
</template>

<style scoped>
.controls {
  position: absolute;
  right: 18px;
  bottom: 18px;
  width: 300px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  pointer-events: auto;
  font-family: var(--font);
}
.group {
  display: flex;
  background: var(--panel-strong);
  border-radius: 3px;
  overflow: hidden;
}
button {
  appearance: none;
  border: 0;
  flex: 1;
  background: transparent;
  color: var(--muted);
  font: 700 10px/1 var(--font);
  letter-spacing: 0.08em;
  padding: 0 4px;
  height: 30px;
  cursor: pointer;
  border-right: 1px solid rgba(255, 255, 255, 0.07);
  transition: background 0.15s, color 0.15s;
  white-space: nowrap;
}
button:last-child { border-right: 0; }
button:hover { color: #fff; background: rgba(255, 255, 255, 0.08); }
button.on { color: #fff; background: var(--f1-red); }
button.danger:hover { background: #7a0f0f; color: #fff; }
.time {
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  height: 26px;
  color: var(--muted);
  font: 700 10px/1 var(--font);
  letter-spacing: 0.08em;
}
.time input { flex: 1; accent-color: var(--f1-red); height: 4px; cursor: pointer; }
.time .sun { color: #ffcc55; font-size: 12px; }
.time .clock { min-width: 34px; text-align: right; color: #fff; }
@media (max-width: 900px) {
  .controls { left: 18px; right: 18px; width: auto; }
}
</style>
