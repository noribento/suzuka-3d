<script setup lang="ts">
import { formatLapTime } from '~/sim/race'
import { CIRCUIT } from '~/data/suzuka'
/**
 * The single alert strap launched beside the tower header — FASTEST LAP, PIT STOP, TOP SPEED,
 * NEW RACE LEADER, RACE WINNER — one on air at a time, fed by the graphics director.
 * Timeline: the strap wipes out of the header over 400 ms (the title text 200 ms from 60 ms,
 * the body items 250 ms from 200 ms, the team bar 200 ms from 250 ms) and retracts into it over
 * 350 ms, the body fading in the first 150 ms.
 */
const { store } = useRaceStore()
const strap = computed(() => store.bc.strap)
const d = computed(() => (strap.value ? store.drivers[strap.value.driver] : undefined))
const TITLE = { fastest: 'FASTEST LAP', pit: 'PIT STOP', speed: 'TOP SPEED', leader: 'NEW RACE LEADER', flag: 'RACE WINNER' } as const
const rejoin = computed(() => strap.value?.rejoin ?? d.value?.position ?? 0)
</script>

<template>
  <transition name="strap" mode="out-in" :duration="{ enter: 450, leave: 350 }">
    <div v-if="strap && d" :key="strap.id" class="bc-strap" :data-kind="strap.kind" :style="{ '--team': d.color }">
      <div class="title"><span>{{ TITLE[strap.kind] }}</span></div>
      <div class="body">
        <span class="bar" />
        <span v-if="strap.kind === 'leader' || strap.kind === 'flag'" class="chip">1</span>
        <span class="code">{{ d.code }}</span>
        <span v-if="strap.kind === 'fastest'" class="value purple">{{ formatLapTime(strap.time) }}</span>
        <template v-else-if="strap.kind === 'pit'">
          <span class="value">{{ (strap.stationary ?? 0).toFixed(1) }}<small>s</small></span>
          <span class="tyres"><HudBroadcastTyre :compound="strap.from ?? 'M'" :size="20" /><i>→</i><HudBroadcastTyre :compound="strap.to ?? 'M'" :size="20" /></span>
          <span class="pos">P{{ strap.entryPosition }}<i>→</i>P{{ rejoin }}</span>
        </template>
        <span v-else-if="strap.kind === 'speed'" class="value">{{ strap.kmh }}<small>KM/H</small></span>
        <span v-else-if="strap.kind === 'leader'" class="name">{{ d.firstName }} <b>{{ d.lastName.toUpperCase() }}</b></span>
        <span v-else class="name"><b>{{ d.lastName.toUpperCase() }}</b> WINS THE {{ CIRCUIT.gpName }}</span>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.bc-strap {
  position: absolute;
  left: 338px;
  top: 56px;
  height: 46px;
  display: inline-flex;
  max-width: 760px;
  overflow: hidden;
}
.title {
  display: flex;
  align-items: center;
  padding: 0 16px;
  font-size: 15px;
  font-weight: 800;
  letter-spacing: 0.14em;
  background: var(--bc-panel-2);
  color: var(--bc-ink);
  white-space: nowrap;
}
[data-kind='fastest'] .title { background: var(--bc-purple-ink); }
[data-kind='pit'] .title { background: var(--bc-chip); color: #111; }
[data-kind='leader'] .title { background: var(--bc-red); }
[data-kind='flag'] .title {
  background: #111;
  border-left: 12px solid;
  border-image: repeating-conic-gradient(#fff 0 25%, #111 0 50%) 0 0 / 6px 6px;
  border-image-slice: 1;
}
.body {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 18px;
  background: var(--bc-panel);
  white-space: nowrap;
}
.body > * { animation: itemIn 0.25s var(--ease-out) both; animation-delay: 0.2s; }
.bar { width: 4px; height: 26px; background: var(--team); transform-origin: center; }
.chip {
  width: 26px;
  height: 26px;
  line-height: 26px;
  text-align: center;
  background: var(--bc-red);
  color: #fff;
  font-family: var(--bc-font-varsity);
  font-size: 15px;
}
.code { font-size: 20px; font-weight: 800; letter-spacing: 0.04em; }
.value { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; }
.value small { font-size: 12px; font-weight: 700; letter-spacing: 0.1em; color: var(--bc-mute); margin-left: 4px; }
.value.purple { color: var(--bc-purple); }
.tyres { display: inline-flex; align-items: center; gap: 6px; }
.tyres i, .pos i { font-style: normal; color: var(--bc-mute); margin: 0 4px; }
.pos { font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; }
.name { font-size: 20px; font-weight: 400; }
.name b { font-weight: 800; }
.strap-enter-active { animation: strapIn 0.4s var(--ease-out) both; }
.strap-enter-active .title span { animation: titleIn 0.2s ease-out 0.06s both; display: inline-block; }
.strap-leave-active { animation: strapOut 0.35s var(--ease-in) both; }
.strap-leave-active .body { transition: opacity 0.15s; opacity: 0; }
@keyframes strapIn { from { clip-path: inset(0 100% 0 0); } to { clip-path: inset(0 0 0 0); } }
@keyframes strapOut { from { clip-path: inset(0 0 0 0); } to { clip-path: inset(0 100% 0 0); } }
@keyframes titleIn { from { opacity: 0; transform: translateX(-10px); } to { opacity: 1; transform: none; } }
@keyframes itemIn { from { opacity: 0; transform: translateX(-12px); } to { opacity: 1; transform: none; } }
</style>
