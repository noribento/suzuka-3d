<script setup lang="ts">
/** Tyre strategy pane: one row per driver in race order, stint bars coloured by compound with lap counts. */
const { store } = useRaceStore()
const rows = computed(() => store.order.map((i) => store.drivers[i]).filter((d): d is NonNullable<typeof d> => !!d))
const total = computed(() => Math.max(1, store.totalLaps))
</script>

<template>
  <div class="bc-strategy">
    <div class="caption"><span>TYRE STRATEGY</span><span class="sub">LAP {{ store.lap }} / {{ store.totalLaps }}</span></div>
    <div class="rows">
      <div v-for="(d, i) in rows" :key="d.idx" class="row" :style="{ '--i': i }">
        <span class="chip" :class="{ p1: d.position === 1 }">{{ d.position }}</span>
        <span class="code">{{ d.code }}</span>
        <span class="bars">
          <i v-for="(s, k) in d.stints" :key="k" :class="'c-' + s.compound" :style="{ width: (Math.max(0.5, s.laps) / total) * 100 + '%' }"><b v-if="s.laps >= 3">{{ s.laps }}</b></i>
        </span>
      </div>
      <span class="cursor" :style="{ left: `calc(84px + ${((store.lap - 1) / total) * 540}px)` }" />
    </div>
  </div>
</template>

<style scoped>
.bc-strategy {
  position: absolute;
  left: 1220px;
  top: 56px;
  width: 640px;
  height: 540px;
  background: var(--bc-panel);
}
.caption { display: flex; align-items: center; justify-content: space-between; height: 36px; padding: 0 14px; font-size: 13px; font-weight: 800; letter-spacing: 0.2em; background: var(--bc-panel-2); }
.caption .sub { font-size: 12px; font-weight: 700; letter-spacing: 0.12em; color: var(--bc-mute); font-variant-numeric: tabular-nums; }
.rows { position: relative; padding: 8px 8px 0; }
.row { display: flex; align-items: center; height: 22px; gap: 8px; }
.chip { width: 18px; height: 18px; line-height: 18px; text-align: center; background: var(--bc-chip); color: #111; font-family: var(--bc-font-varsity); font-size: 11px; flex: 0 0 18px; }
.chip.p1 { background: var(--bc-red); color: #fff; }
.code { width: 46px; font-size: 14px; font-weight: 800; letter-spacing: 0.04em; }
.bars { position: relative; display: flex; gap: 1px; width: 540px; height: 12px; background: rgba(255, 255, 255, 0.08); }
.bars i { display: flex; align-items: center; justify-content: flex-end; height: 100%; transform-origin: left center; }
.bars b { font-size: 10px; font-weight: 700; color: #111; padding-right: 4px; }
.c-S { background: var(--bc-tyre-S); }
.c-M { background: var(--bc-tyre-M); }
.c-H { background: var(--bc-tyre-H); }
.cursor { position: absolute; top: 8px; bottom: 0; width: 1px; background: rgba(255, 255, 255, 0.7); pointer-events: none; }
.pane-enter-active .row { animation: rowIn 0.25s var(--ease-out) both; animation-delay: calc(120ms + var(--i) * 20ms); }
.pane-enter-active .bars i { animation: barIn 0.5s var(--ease-out) both; animation-delay: calc(300ms + var(--i) * 20ms); }
.pane-enter-active .bars b { animation: fadeIn 0.15s linear both; animation-delay: calc(800ms + var(--i) * 20ms); }
@keyframes rowIn { from { opacity: 0; transform: translateX(-16px); } to { opacity: 1; transform: none; } }
@keyframes barIn { from { transform: scaleX(0); } to { transform: scaleX(1); } }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
</style>
