<script setup lang="ts">
import { CIRCUIT } from '~/data/suzuka'
import { useTrackGeometry } from '~/composables/useTrackGeometry'

const { store, select } = useRaceStore()
// the circuit paths are shared with the broadcast driver tracker
const geometry = useTrackGeometry()
</script>

<template>
  <div v-if="store.showMap" class="map">
    <svg :viewBox="geometry.viewBox" preserveAspectRatio="xMidYMid meet">
      <path :d="geometry.full" class="outline" />
      <path :d="geometry.s1" class="sector s1" />
      <path :d="geometry.s2" class="sector s2" />
      <path :d="geometry.s3" class="sector s3" />
      <line class="start" :x1="geometry.startLine.x1" :y1="geometry.startLine.y1" :x2="geometry.startLine.x2" :y2="geometry.startLine.y2" />
      <g v-for="d in store.drivers" :key="d.idx" class="car" :class="{ selected: d.idx === store.selected, pit: d.inPit }" @click="select(d.idx)">
        <circle :cx="d.mapX" :cy="d.mapY" :r="d.idx === store.selected ? 24 : 15" :fill="d.color" />
        <text v-if="d.idx === store.selected || d.position <= 3" :x="d.mapX" :y="d.mapY - 26" text-anchor="middle">{{ d.code }}</text>
      </g>
    </svg>
    <div class="caption"><span>SUZUKA</span><span class="len">{{ (CIRCUIT.officialLength / 1000).toFixed(3) }} KM</span></div>
  </div>
</template>

<style scoped>
.map {
  position: absolute;
  right: 18px;
  top: 54px;
  width: 300px;
  height: 190px;
  background: var(--panel);
  border-radius: 4px;
  pointer-events: auto;
  font-family: var(--font);
}
svg {
  width: 100%;
  height: 100%;
  display: block;
}
.outline {
  fill: none;
  stroke: rgba(0, 0, 0, 0.7);
  stroke-width: 44;
  stroke-linejoin: round;
}
.sector {
  fill: none;
  stroke-width: 24;
  stroke-linecap: round;
}
.s1 { stroke: #e8002d; }
.s2 { stroke: #2f7cf6; }
.s3 { stroke: #ffd400; }
.start { stroke: #fff; stroke-width: 10; }
.car { cursor: pointer; }
.car circle { stroke: #fff; stroke-width: 4; }
.car.pit circle { opacity: 0.45; }
.car.selected circle { stroke-width: 8; }
.car text {
  font-size: 44px;
  font-weight: 700;
  fill: #fff;
  paint-order: stroke;
  stroke: rgba(0, 0, 0, 0.8);
  stroke-width: 10;
  pointer-events: none;
}
.caption {
  position: absolute;
  left: 10px;
  top: 6px;
  display: flex;
  gap: 8px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.14em;
  color: #fff;
}
.len { color: var(--muted); }
@media (max-width: 900px) {
  .map { display: none; }
}
</style>
