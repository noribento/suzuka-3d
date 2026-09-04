<script setup lang="ts">
import { CIRCUIT } from '~/data/suzuka'
/** Broadcast driver tracker: circuit outline, DRS zone, start line and 22 team-coloured dots. */
import { useTrackGeometry } from '~/composables/useTrackGeometry'

const { store, select } = useRaceStore()
const geometry = useTrackGeometry()
</script>

<template>
  <div class="bc-tracker">
    <div class="caption"><span>DRIVER TRACKER</span><span class="sub">{{ CIRCUIT.shortName }} · {{ (CIRCUIT.officialLength / 1000).toFixed(3) }} KM</span></div>
    <svg :viewBox="geometry.viewBox" preserveAspectRatio="xMidYMid meet">
      <path :d="geometry.full" class="halo" />
      <path :d="geometry.full" class="outline" pathLength="1" />
      <path :d="geometry.drs" class="drs" />
      <line class="start" :x1="geometry.startLine.x1" :y1="geometry.startLine.y1" :x2="geometry.startLine.x2" :y2="geometry.startLine.y2" />
      <g v-for="d in store.drivers" :key="d.idx" class="car" :class="{ selected: d.idx === store.selected, pit: d.inPit }" :style="{ '--i': d.position - 1 }" @click="select(d.idx)">
        <circle :cx="d.mapX" :cy="d.mapY" :r="d.idx === store.selected ? 22 : 15" :fill="d.color" />
        <text v-if="d.idx === store.selected || d.position <= 3" :x="d.mapX" :y="d.mapY - 26" text-anchor="middle">{{ d.code }}</text>
      </g>
    </svg>
  </div>
</template>

<style scoped>
.bc-tracker {
  position: absolute;
  left: 1440px;
  top: 56px;
  width: 420px;
  height: 300px;
  background: var(--bc-panel);
  pointer-events: auto;
}
.caption { display: flex; align-items: center; justify-content: space-between; height: 30px; padding: 0 12px; font-size: 12px; font-weight: 800; letter-spacing: 0.2em; background: var(--bc-panel-2); }
.caption .sub { font-size: 10px; font-weight: 700; letter-spacing: 0.14em; color: var(--bc-mute); }
svg { display: block; width: 420px; height: 270px; }
.halo { fill: none; stroke: #000; stroke-width: 40; stroke-linejoin: round; }
.outline { fill: none; stroke: rgba(255, 255, 255, 0.8); stroke-width: 22; stroke-linejoin: round; }
.drs { fill: none; stroke: var(--bc-drs); stroke-width: 22; stroke-linecap: butt; }
.start { stroke: #fff; stroke-width: 10; }
.car { cursor: pointer; }
.car circle { stroke: #000; stroke-width: 4; }
.car.pit { opacity: 0.45; }
.car.selected circle { stroke: #fff; stroke-width: 8; }
.car text { font-size: 40px; font-weight: 700; fill: #fff; paint-order: stroke; stroke: rgba(0, 0, 0, 0.8); stroke-width: 10; pointer-events: none; }
/* under the pane's enter class: the outline draws itself, the dots pop in by position */
.pane-enter-active .outline { animation: draw 0.6s ease-out 0.1s both; }
.pane-enter-active .car { animation: dotIn 0.25s ease-out both; animation-delay: calc(300ms + var(--i) * 15ms); }
@keyframes draw { from { stroke-dasharray: 1; stroke-dashoffset: 1; } to { stroke-dasharray: 1; stroke-dashoffset: 0; } }
@keyframes dotIn { from { opacity: 0; } to { opacity: 1; } }
</style>
