<script setup lang="ts">
import type { HudDriver, TowerMode } from '~/composables/useRaceStore'
/**
 * One tower row. Position travel is the CSS `translate` property (750 ms), the mount cascade
 * animates `transform` on the inner wrapper, so the two never fight. Chip flash: on a committed
 * position change the chip turns green / red with a black numeral for 3.5 s and the white chip
 * is revealed by a 45° wipe from the bottom-right corner over 400 ms — one 3900 ms keyframe on
 * an overlay that is re-keyed per change. The purple fastest-lap gem slides in over 500 ms and
 * stays on the holder; the right column wipes out-in (120 / 300 ms, 8 ms ripple per row) on a
 * mode change; gap values snap per mini-sector with a 150 ms tick, never tween.
 */
const props = defineProps<{ d: HudDriver; i: number; mode: TowerMode; selected: boolean; smart: boolean }>()
const { store, select } = useRaceStore()
const out = computed(() => props.d.pitOutUntil > store.nowMs)
const p1 = computed(() => props.d.position === 1)
const gapText = computed(() => {
  if (props.d.inPit) return 'PIT'
  if (out.value) return 'OUT'
  if (p1.value) return props.mode === 'leader' ? 'LEADER' : 'INTERVAL'
  return props.mode === 'leader' ? props.d.tvGap : props.d.tvInterval
})
const gained = computed(() => {
  const n = props.d.positionDelta
  return n > 0 ? `+${n}` : n < 0 ? String(n) : '—'
})
const pulseKey = computed(() => store.fastestLap?.time ?? 0)
</script>

<template>
  <div
    class="row"
    :class="{ p1, selected, smart, pit: d.inPit, done: d.finished, fastest: d.hasFastestLap }"
    :style="{ translate: `0 ${(d.position - 1) * 33}px`, '--i': i, '--team': d.color }"
    @click="select(d.idx)"
  >
    <div class="in">
      <span v-if="d.hasFastestLap" :key="'p' + pulseKey" class="pulse" />
      <span v-if="d.posFlash" :key="'o' + d.posFlash.key" class="outline" :class="d.posFlash.dir > 0 ? 'gain' : 'loss'" />
      <span class="pos">
        <span class="num">{{ d.position }}</span>
        <span v-if="d.posFlash" :key="'f' + d.posFlash.key" class="flash" :class="d.posFlash.dir > 0 ? 'gain' : 'loss'">{{ d.position }}</span>
      </span>
      <span class="bar" />
      <span class="code">{{ d.code }}</span>
      <transition name="gem" :duration="{ enter: 500, leave: 200 }">
        <span v-if="d.hasFastestLap" class="gem" title="Fastest lap">
          <svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="9" r="5.5" fill="none" stroke="#fff" stroke-width="1.6" /><path d="M8 6v3.2l2 1.2M6 2h4M8 2v1.6" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" /></svg>
        </span>
      </transition>
      <transition name="col" mode="out-in" :duration="{ enter: 300 + i * 8, leave: 120 }">
        <span :key="mode" class="col" :class="mode">
          <template v-if="mode === 'tyre'">
            <HudBroadcastTyre :compound="d.compound" :size="22" :age="d.tyreAge" />
          </template>
          <template v-else-if="mode === 'gained'">
            <span class="gain-val" :class="{ up: d.positionDelta > 0, down: d.positionDelta < 0 }">{{ gained }}</span>
          </template>
          <template v-else-if="mode === 'stops'">
            <span class="picon" /><span class="stops">{{ d.pitStops }}</span>
          </template>
          <template v-else>
            <transition name="drs" :duration="{ enter: 150, leave: 120 }">
              <span v-if="d.drs && !d.inPit" class="drs">DRS</span>
            </transition>
            <span v-if="d.inPit" class="picon" />
            <transition name="tick" mode="out-in" :duration="{ enter: 150, leave: 0 }">
              <span :key="gapText" class="gap" :class="{ label: p1 && !d.inPit && !out, state: d.inPit || out }">{{ gapText }}</span>
            </transition>
          </template>
        </span>
      </transition>
    </div>
  </div>
</template>

<style scoped>
.row {
  position: absolute;
  left: 0;
  top: 0;
  width: 270px;
  height: 33px;
  transition: translate 0.75s var(--ease-std);
  pointer-events: auto;
  cursor: pointer;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  box-sizing: border-box;
}
.in {
  position: relative;
  display: flex;
  align-items: center;
  height: 32px;
  animation: rowIn 0.35s var(--ease-out) both;
  animation-delay: calc(80ms + var(--i) * 30ms);
}
.row.selected .in { background: rgba(255, 255, 255, 0.1); }
.row.smart .in { background: rgba(255, 255, 255, 0.07); }
.row.pit .code, .row.pit .bar { opacity: 0.6; }
.pulse {
  position: absolute;
  inset: 0;
  animation: rowPurple 1.2s ease-out both;
  pointer-events: none;
}
.outline {
  position: absolute;
  inset: 0;
  box-shadow: inset 0 0 0 1.5px currentColor;
  animation: rowOutline 0.666s linear both;
  pointer-events: none;
}
.outline.gain { color: var(--bc-gain); }
.outline.loss { color: var(--bc-loss); }
.pos {
  position: relative;
  flex: 0 0 30px;
  width: 30px;
  height: 30px;
  margin-left: 2px;
  background: var(--bc-chip);
  color: #111;
  font-family: var(--bc-font-varsity);
  font-size: 18px;
  line-height: 30px;
  text-align: center;
  overflow: hidden;
}
.row.p1 .pos { background: var(--bc-red); color: #fff; }
.pos .flash {
  position: absolute;
  inset: 0;
  color: #111;
  animation: chipFlash 3.9s linear both;
}
.pos .flash.gain { background: var(--bc-gain); }
.pos .flash.loss { background: var(--bc-loss); }
.bar { flex: 0 0 4px; width: 4px; height: 22px; margin-left: 6px; background: var(--team); }
.code { margin-left: 8px; font-size: 19px; font-weight: 700; letter-spacing: 0.04em; width: 52px; }
.row.fastest .code { color: var(--bc-purple); }
.gem {
  position: absolute;
  left: 104px;
  top: 5px;
  width: 22px;
  height: 22px;
  background: var(--bc-purple);
  display: flex;
  align-items: center;
  justify-content: center;
}
.gem-enter-active { transition: transform 0.5s var(--ease-out), opacity 0.5s var(--ease-out); }
.gem-leave-active { transition: transform 0.2s ease-in, opacity 0.2s ease-in; }
.gem-enter-from { transform: translateX(40px); opacity: 0; }
.gem-leave-to { transform: translateX(12px); opacity: 0; }
.col {
  position: absolute;
  right: 8px;
  top: 0;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  min-width: 100px;
}
.col-enter-active { animation: colIn 0.3s var(--ease-out) both; animation-delay: calc(var(--i) * 8ms); }
.col-leave-active { transition: opacity 0.12s ease-in; }
.col-leave-to { opacity: 0; }
.gap { font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; font-feature-settings: 'tnum' 1; }
.gap.label { font-size: 12px; font-weight: 700; letter-spacing: 0.12em; color: var(--bc-mute); }
.gap.state { font-size: 15px; font-weight: 800; letter-spacing: 0.06em; }
.tick-enter-active { transition: opacity 0.15s linear; }
.tick-enter-from { opacity: 0.35; }
.drs {
  height: 15px;
  padding: 0 5px;
  font-size: 10px;
  font-weight: 800;
  line-height: 15px;
  letter-spacing: 0.08em;
  background: var(--bc-drs);
  color: var(--bc-drs-ink);
  transform-origin: left center;
}
.drs-enter-active { transition: transform 0.15s var(--ease-out), opacity 0.15s; }
.drs-leave-active { transition: opacity 0.12s; }
.drs-enter-from { transform: scaleX(0.4); opacity: 0; }
.drs-leave-to { opacity: 0; }
.picon {
  width: 12px;
  height: 12px;
  background: #fff;
  clip-path: polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 40%, 35% 40%, 35% 60%, 0 60%);
  box-shadow: inset 0 0 0 2px #fff;
  opacity: 0.9;
}
.stops { font-size: 18px; font-weight: 700; font-variant-numeric: tabular-nums; }
.gain-val { font-size: 18px; font-weight: 700; color: var(--bc-mute); font-variant-numeric: tabular-nums; }
.gain-val.up { color: var(--bc-gain); }
.gain-val.down { color: var(--bc-loss); }
@keyframes rowIn { from { opacity: 0; transform: translateX(-20px); } to { opacity: 1; transform: translateX(0); } }
@keyframes rowOutline { 0% { opacity: 0; } 15% { opacity: 1; } 50% { opacity: 1; } 100% { opacity: 0; } }
@keyframes rowPurple { from { background: rgba(185, 107, 255, 0.7); } to { background: rgba(185, 107, 255, 0); } }
/* the coloured chip holds for 3500 ms, then the white chip is revealed by a 45° edge sweeping from the bottom-right corner (400 ms) */
@keyframes chipFlash {
  0%, 89.74% { clip-path: polygon(-100% -100%, 300% -100%, -100% 300%); animation-timing-function: cubic-bezier(0.4, 0, 1, 1); }
  100% { clip-path: polygon(0 0, 0 0, 0 0); }
}
@keyframes colIn { from { clip-path: inset(0 100% 0 0); } to { clip-path: inset(0 0 0 0); } }
</style>
