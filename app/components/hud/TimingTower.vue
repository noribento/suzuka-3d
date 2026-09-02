<script setup lang="ts">
const { store, select } = useRaceStore()
const ROW = 23

function gapFor(d: (typeof store.drivers)[number]): string {
  if (d.position === 1) return store.gapMode === 'gap' ? 'LEADER' : 'INTERVAL'
  return store.gapMode === 'gap' ? d.gapText : d.intervalText
}
</script>

<template>
  <div class="tower">
    <div class="tower-head">
      <span class="lap-label">LAP</span>
      <span class="lap-value">{{ store.lap }}<span class="lap-total">/{{ store.totalLaps }}</span></span>
      <span class="flag" v-if="store.status === 'finished'">🏁</span>
    </div>
    <div class="tower-body" :style="{ height: store.drivers.length * ROW + 'px' }">
      <div
        v-for="d in store.drivers"
        :key="d.idx"
        class="row"
        :class="{ selected: d.idx === store.selected, pit: d.inPit, fastest: d.hasFastestLap, done: d.finished }"
        :style="{ transform: `translateY(${(d.position - 1) * ROW}px)`, '--team': d.color }"
        @click="select(d.idx)"
      >
        <span class="pos">{{ d.position }}</span>
        <span class="bar" />
        <span class="code">{{ d.code }}</span>
        <span class="delta" :class="{ up: d.gridPosition > d.position, down: d.gridPosition < d.position }">{{ d.gridPosition > d.position ? '▲' : d.gridPosition < d.position ? '▼' : '' }}</span>
        <span class="tyre" :class="'tyre-' + d.compound">{{ d.compound }}</span>
        <span class="drs" v-if="d.drs">DRS</span>
        <span class="minis"><i v-for="i in 3" :key="i" :class="'flag-' + d.sectorFlags[i - 1] + (d.sectors[i - 1] == null ? ' none' : '')" /></span>
        <span class="gap" :class="{ leader: d.position === 1 }">{{ gapFor(d) }}</span>
        <span class="stints"><i v-for="(s, k) in d.stints" :key="k" :class="'st-' + s.compound" :style="{ flex: Math.max(1, s.laps) }" /></span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tower {
  position: absolute;
  left: 18px;
  top: 74px;
  width: 214px;
  pointer-events: auto;
  font-family: var(--font);
  user-select: none;
}
.tower-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  height: 34px;
  padding: 0 10px;
  background: var(--panel-strong);
  border-left: 4px solid var(--f1-red);
  color: #fff;
  border-radius: 3px 3px 0 0;
}
.lap-label {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.12em;
  color: var(--muted);
  align-self: center;
}
.lap-value {
  font-size: 22px;
  font-weight: 700;
  line-height: 34px;
  letter-spacing: 0.02em;
}
.lap-total {
  font-size: 13px;
  font-weight: 600;
  color: var(--muted);
  margin-left: 2px;
}
.flag {
  margin-left: auto;
  align-self: center;
  font-size: 14px;
}
.tower-body {
  position: relative;
  background: var(--panel);
  border-radius: 0 0 3px 3px;
  overflow: hidden;
}
.row {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  height: 23px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px 0 0;
  color: #fff;
  cursor: pointer;
  transition: transform 0.7s cubic-bezier(0.22, 1, 0.36, 1), background 0.2s;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  box-sizing: border-box;
}
.row:hover {
  background: rgba(255, 255, 255, 0.08);
}
.row.selected {
  background: rgba(255, 255, 255, 0.17);
}
.row.pit {
  color: var(--muted);
}
.row.done .pos {
  color: #ffd400;
}
.pos {
  width: 26px;
  text-align: center;
  font-size: 12px;
  font-weight: 700;
  background: rgba(255, 255, 255, 0.09);
  height: 100%;
  line-height: 23px;
  flex: 0 0 auto;
}
.bar {
  width: 4px;
  height: 15px;
  background: var(--team);
  border-radius: 1px;
  flex: 0 0 auto;
}
.code {
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.05em;
  width: 38px;
  flex: 0 0 auto;
}
.tyre {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid #999;
  font-size: 8px;
  font-weight: 700;
  line-height: 14px;
  text-align: center;
  color: #fff;
  box-sizing: border-box;
  flex: 0 0 auto;
}
.tyre-S { border-color: #e8002d; color: #e8002d; }
.tyre-M { border-color: #ffd400; color: #ffd400; }
.tyre-H { border-color: #f0f0f0; color: #f0f0f0; }
.drs {
  font-size: 8px;
  font-weight: 700;
  letter-spacing: 0.08em;
  padding: 1px 3px;
  border-radius: 2px;
  background: #00c853;
  color: #041;
  flex: 0 0 auto;
}
.gap {
  margin-left: auto;
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: #dfe3ea;
  letter-spacing: 0.02em;
}
.gap.leader {
  font-size: 10px;
  letter-spacing: 0.1em;
  color: var(--muted);
}
.row.fastest .code {
  color: var(--purple-text);
}
.delta {
  width: 8px;
  font-size: 7px;
  flex: 0 0 auto;
  margin-left: -4px;
  color: transparent;
}
.delta.up { color: #35d07f; }
.delta.down { color: #ff3b3b; }
.minis {
  display: flex;
  gap: 2px;
  flex: 0 0 auto;
}
.minis i {
  display: block;
  width: 5px;
  height: 5px;
  border-radius: 1px;
  background: #ffd400;
}
.minis i.none { background: rgba(255, 255, 255, 0.12); }
.minis i.flag-1 { background: #1f9d55; }
.minis i.flag-2 { background: var(--purple-text); }
.stints {
  position: absolute;
  left: 26px;
  right: 8px;
  bottom: 0;
  height: 2px;
  display: flex;
  gap: 1px;
}
.stints i { display: block; height: 100%; opacity: 0.85; }
.st-S { background: #e8002d; }
.st-M { background: #ffd400; }
.st-H { background: #f0f0f0; }
@media (max-height: 700px) {
  .tower { transform: scale(0.85); transform-origin: top left; }
}
</style>
