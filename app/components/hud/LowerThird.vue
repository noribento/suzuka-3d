<script setup lang="ts">
import { formatLapTime } from '~/sim/race'
const { store } = useRaceStore()
const now = ref(performance.now())
let timer = 0
onMounted(() => {
  timer = window.setInterval(() => (now.value = performance.now()), 250)
})
onBeforeUnmount(() => clearInterval(timer))
const d = computed(() => {
  const lt = store.lowerThird
  if (!lt || now.value > lt.until) return undefined
  return store.drivers[lt.driver]
})
const compoundName = (c: string) => (c === 'S' ? 'SOFT' : c === 'M' ? 'MEDIUM' : 'HARD')
</script>

<template>
  <transition name="lt">
    <div v-if="d" class="lower-third" :style="{ '--team': d.color }">
      <div class="num">{{ d.number }}</div>
      <div class="name">
        <span class="first">{{ d.firstName.toUpperCase() }}</span>
        <span class="last">{{ d.lastName.toUpperCase() }}</span>
      </div>
      <div class="team">{{ d.teamName.toUpperCase() }}</div>
      <div class="facts">
        <span><label>GRID</label>P{{ d.gridPosition }}</span>
        <span><label>NOW</label>P{{ d.position }}</span>
        <span><label>BEST</label>{{ formatLapTime(d.bestLap) }}</span>
        <span><label>TYRES</label>{{ compoundName(d.compound) }} · {{ d.tyreAge }}L</span>
        <span v-if="d.trapKmh"><label>TRAP</label>{{ d.trapKmh }} KM/H</span>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.lower-third {
  position: absolute;
  left: 50%;
  bottom: 120px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 18px 0 0;
  height: 54px;
  background: var(--panel-strong);
  border-left: 6px solid var(--team);
  border-radius: 3px;
  color: #fff;
  font-family: var(--font);
  pointer-events: none;
  white-space: nowrap;
}
.num {
  font-size: 34px;
  font-weight: 900;
  font-style: italic;
  color: var(--team);
  padding: 0 4px 0 14px;
  line-height: 1;
}
.name { display: flex; flex-direction: column; line-height: 1.05; }
.first { font-size: 11px; font-weight: 600; letter-spacing: 0.12em; color: var(--muted); }
.last { font-size: 22px; font-weight: 700; letter-spacing: 0.05em; }
.team { font-size: 11px; font-weight: 700; letter-spacing: 0.16em; color: var(--muted); padding-left: 10px; border-left: 1px solid rgba(255, 255, 255, 0.15); }
.facts { display: flex; gap: 14px; font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums; padding-left: 10px; border-left: 1px solid rgba(255, 255, 255, 0.15); }
.facts label { display: block; font-size: 8px; letter-spacing: 0.16em; color: var(--muted); }
.lt-enter-active, .lt-leave-active { transition: all 0.4s cubic-bezier(0.22, 1, 0.36, 1); }
.lt-enter-from { opacity: 0; transform: translateX(-50%) translateY(16px); }
.lt-leave-to { opacity: 0; transform: translateX(-50%) translateY(8px); }
@media (max-width: 900px) { .lower-third { display: none; } }
</style>
