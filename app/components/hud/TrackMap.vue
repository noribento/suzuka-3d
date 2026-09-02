<script setup lang="ts">
import { getTrack } from '~/sim/track'
import { toMap } from '~/sim/projection'
import { CIRCUIT } from '~/data/suzuka'

const { store, select } = useRaceStore()

const geometry = computed(() => {
  const track = getTrack()
  const pts: { x: number; y: number; s: number }[] = []
  for (let i = 0; i < track.n; i += 2) {
    const m = toMap(track.px[i]!, track.pz[i]!)
    pts.push({ x: m.mx, y: m.my, s: i * track.ds })
  }
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y)
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
  const pad = 60
  const sectorPath = (from: number, to: number) => {
    const seg = pts.filter((p) => (from < to ? p.s >= from && p.s <= to : p.s >= from || p.s <= to))
    if (from > to) {
      // keep order continuous across the line
      const a = seg.filter((p) => p.s >= from), b = seg.filter((p) => p.s <= to)
      return [...a, ...b].map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
    }
    return seg.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
  }
  const full = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ') + ' Z'
  const s1 = sectorPath(0, CIRCUIT.sectors[0])
  const s2 = sectorPath(CIRCUIT.sectors[0], CIRCUIT.sectors[1])
  const s3 = sectorPath(CIRCUIT.sectors[1], track.length - 1)
  const start = toMap(track.px[0]!, track.pz[0]!)
  const sn = { x: track.nx[0]!, z: track.nz[0]! }
  const l = toMap(track.px[0]! + sn.x * 40, track.pz[0]! + sn.z * 40)
  const r = toMap(track.px[0]! - sn.x * 40, track.pz[0]! - sn.z * 40)
  return { viewBox: `${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`, full, s1, s2, s3, start, startLine: { x1: l.mx, y1: l.my, x2: r.mx, y2: r.my } }
})
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
