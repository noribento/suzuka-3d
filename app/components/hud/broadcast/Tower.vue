<script setup lang="ts">
import type { TowerMode } from '~/composables/useRaceStore'
/**
 * The permanent timing tower of the 2025-26 package: red F1 block beside the LAP block (which
 * recolours for race-control states), 22 rows of 33 px, and a right column the graphics
 * director cycles through INTERVAL / LEADER / TYRE / POSITIONS GAINED / PIT STOPS.
 *
 * Timeline (mount): header wipes in over 400 ms, the body unfolds over 600 ms from 60 ms, rows
 * slide in top-down 350 ms each with a 30 ms stagger from 80 ms (row 22 settles at 1060 ms).
 */
const { store } = useRaceStore()
const mode = computed(() => store.bc.towerMode)
const header = computed(() => store.bc.header)
const smart = computed(() => {
  const b = store.bc.battle
  return b ? [b.ahead, b.behind] : []
})
const LABEL: Record<TowerMode, string> = { interval: 'INTERVAL', leader: 'GAP TO LEADER', tyre: 'TYRES', gained: 'POSITIONS GAINED', stops: 'PIT STOPS' }
</script>

<template>
  <div class="bc-tower" :data-mode="mode" :data-header="header">
    <div class="head">
      <div class="f1"><span>F1</span></div>
      <transition name="hs" mode="out-in" :duration="{ enter: 350, leave: 120 }">
        <div :key="header" class="lap-block" :class="header">
          <template v-if="header === 'lap'">
            <span class="lap-label">LAP</span>
            <span class="lap-value">{{ store.lap }}<span class="lap-total">/{{ store.totalLaps }}</span></span>
          </template>
          <span v-else-if="header === 'drs'" class="rc">DRS ENABLED</span>
          <span v-else class="rc flag"><i /><em>CHEQUERED FLAG</em></span>
        </div>
      </transition>
      <transition name="cap" mode="out-in" :duration="{ enter: 200, leave: 120 }">
        <span :key="mode" class="cap">{{ LABEL[mode] }}</span>
      </transition>
    </div>
    <div class="body">
      <HudBroadcastTowerRow
        v-for="d in store.drivers"
        :key="d.idx"
        :d="d"
        :i="d.position - 1"
        :mode="mode"
        :selected="d.idx === store.selected"
        :smart="smart.includes(d.idx)"
      />
    </div>
  </div>
</template>

<style scoped>
.bc-tower {
  position: absolute;
  left: 60px;
  top: 56px;
  width: 270px;
}
.head {
  position: relative;
  display: flex;
  height: 92px;
  animation: headIn 0.4s var(--ease-out) both;
}
.f1 {
  width: 74px;
  background: var(--bc-red);
  display: flex;
  align-items: center;
  justify-content: center;
  animation: f1Flash 0.3s linear 0.1s both;
}
.f1 span {
  font-size: 34px;
  font-weight: 900;
  font-style: italic;
  letter-spacing: -0.04em;
  color: #fff;
}
.lap-block {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 14px;
  background: var(--bc-panel);
}
.lap-label { font-size: 15px; font-weight: 700; letter-spacing: 0.16em; color: var(--bc-mute); padding-top: 4px; }
.lap-value { font-size: 38px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1; }
.lap-total { font-size: 20px; font-weight: 600; color: var(--bc-mute); margin-left: 3px; }
.lap-block.drs { background: var(--bc-drs); color: var(--bc-drs-ink); }
.rc { font-size: 20px; font-weight: 800; letter-spacing: 0.1em; }
.lap-block.chequered { background: #111; }
.rc.flag { display: flex; align-items: center; gap: 10px; }
.rc.flag i {
  width: 36px;
  height: 36px;
  background: repeating-conic-gradient(#fff 0 25%, #111 0 50%) 0 0 / 12px 12px;
  border: 1px solid #444;
}
.rc.flag em { font-style: normal; font-size: 16px; }
.cap {
  position: absolute;
  right: 8px;
  bottom: 4px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.18em;
  color: var(--bc-mute);
}
.body {
  position: relative;
  height: 726px;
  background: var(--bc-panel);
  overflow: hidden;
  animation: bodyIn 0.6s var(--ease-out) 0.06s both;
}
/* the 2025 'darker animated motion background': speed lines drifting on a composited layer */
.body::before {
  content: '';
  position: absolute;
  left: -160px;
  top: -160px;
  width: calc(100% + 320px);
  height: calc(100% + 320px);
  background: repeating-linear-gradient(115deg, rgba(255, 255, 255, 0.035) 0 2px, transparent 2px 26px);
  animation: drift 24s linear infinite;
  pointer-events: none;
}
.bc.paused .body::before { animation-play-state: paused; }
.hs-enter-active { animation: lapIn 0.35s var(--ease-out) both; }
.hs-leave-active { transition: opacity 0.12s ease-in; }
.hs-leave-to { opacity: 0; }
.cap-enter-active { transition: opacity 0.2s ease-out; }
.cap-leave-active { transition: opacity 0.12s ease-in; }
.cap-enter-from, .cap-leave-to { opacity: 0; }
@keyframes headIn { from { clip-path: inset(0 100% 0 0); } to { clip-path: inset(0 0 0 0); } }
@keyframes bodyIn { from { clip-path: inset(0 0 100% 0); } to { clip-path: inset(0 0 0 0); } }
@keyframes f1Flash { from { background: #fff; } to { background: var(--bc-red); } }
@keyframes lapIn { from { clip-path: inset(0 0 0 100%); } to { clip-path: inset(0 0 0 0); } }
@keyframes drift { from { transform: translate3d(-160px, -160px, 0); } to { transform: translate3d(0, 0, 0); } }
@media (prefers-reduced-motion: reduce) { .body::before { animation: none; } }
</style>
