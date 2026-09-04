<script setup lang="ts">
/**
 * World-feed onboard telemetry cluster, bottom-left, only while the shot on air is an onboard:
 * driver tag, gear, speed, RPM arc, throttle / brake bars, DRS. Enters 350 ms after the cut
 * (translateY 24 px + fade), leaves in 250 ms; the arc and pedals follow the car at 80 ms.
 */
const { store } = useRaceStore()
const d = computed(() => (store.selected >= 0 ? store.drivers[store.selected] : undefined))
const visible = computed(() => !!d.value && (store.shot === 'onboard' || store.nowMs < store.bc.onboardUntil))
// 5 000 → 12 000 rpm over the 180° arc (pathLength 100)
const rpmPct = computed(() => (d.value ? Math.max(0, Math.min(100, ((d.value.rpm - 5000) / 7000) * 100)) : 0))
const redline = computed(() => !!d.value && d.value.rpm > 11500)
</script>

<template>
  <transition name="ob" :duration="{ enter: 650, leave: 250 }">
    <div v-if="visible && d" class="bc-onboard" :style="{ '--team': d.color }">
      <div class="tag">
        <span class="chip" :class="{ p1: d.position === 1 }">{{ d.position }}</span>
        <span class="bar" />
        <span class="code">{{ d.code }}</span>
        <span class="team">{{ d.teamName.toUpperCase() }}</span>
        <span class="lap">LAP {{ store.lap }}</span>
      </div>
      <div class="gauges">
        <div class="gear"><transition name="gear" mode="out-in" :duration="{ enter: 90, leave: 0 }"><span :key="d.gear">{{ d.gear || 'N' }}</span></transition><label>GEAR</label></div>
        <div class="speed"><span>{{ d.speedKmh }}</span><label>KM/H</label></div>
        <div class="rpm">
          <svg viewBox="0 0 120 64" width="150" height="80">
            <path class="track" d="M 10 58 A 50 50 0 0 1 110 58" pathLength="100" />
            <path class="fill" :class="{ red: redline }" d="M 10 58 A 50 50 0 0 1 110 58" pathLength="100" :style="{ strokeDasharray: `${rpmPct} 100` }" />
          </svg>
          <label>{{ d.rpm }} RPM</label>
        </div>
        <div class="pedals">
          <div class="pedal thr"><div class="fill" :style="{ height: d.throttle * 100 + '%' }" /></div>
          <div class="pedal brk"><div class="fill" :style="{ height: d.brake * 100 + '%' }" /></div>
        </div>
        <div class="drs" :class="{ open: d.drs, eligible: d.drsEligible && !d.drs }">DRS</div>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.bc-onboard {
  position: absolute;
  left: 60px;
  top: 876px;
  width: 560px;
  height: 108px;
  background: var(--bc-panel);
}
.tag { display: flex; align-items: center; gap: 10px; height: 30px; padding: 0 12px; background: rgba(255, 255, 255, 0.06); }
.chip { width: 22px; height: 22px; line-height: 22px; text-align: center; background: var(--bc-chip); color: #111; font-family: var(--bc-font-varsity); font-size: 13px; }
.chip.p1 { background: var(--bc-red); color: #fff; }
.bar { width: 4px; height: 18px; background: var(--team); }
.code { font-size: 17px; font-weight: 800; letter-spacing: 0.04em; }
.team { font-size: 11px; font-weight: 700; letter-spacing: 0.12em; color: var(--bc-mute); }
.lap { margin-left: auto; font-size: 12px; font-weight: 700; letter-spacing: 0.1em; color: var(--bc-mute); font-variant-numeric: tabular-nums; }
.gauges { display: flex; align-items: flex-end; gap: 18px; height: 78px; padding: 0 16px 8px; }
label { display: block; font-size: 9px; font-weight: 700; letter-spacing: 0.16em; color: var(--bc-mute); margin-top: 2px; }
.gear span { display: inline-block; font-family: var(--bc-font-varsity); font-size: 52px; line-height: 1; min-width: 44px; text-align: center; }
.gear-enter-active { transition: opacity 0.09s; }
.gear-enter-from { opacity: 0.2; }
.speed span { display: inline-block; font-size: 46px; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; min-width: 96px; }
.rpm { display: flex; flex-direction: column; align-items: center; }
.rpm svg { display: block; }
.rpm .track { fill: none; stroke: rgba(255, 255, 255, 0.12); stroke-width: 10; }
.rpm .fill { fill: none; stroke: var(--bc-gain); stroke-width: 10; transition: stroke-dasharray 0.08s linear, stroke 0.08s; }
.rpm .fill.red { stroke: var(--bc-loss); }
.pedals { display: flex; gap: 5px; height: 60px; margin-bottom: 4px; }
.pedal { width: 12px; height: 100%; background: rgba(255, 255, 255, 0.12); display: flex; align-items: flex-end; overflow: hidden; }
.pedal .fill { width: 100%; transition: height 0.08s linear; }
.thr .fill { background: var(--bc-gain); }
.brk .fill { background: var(--bc-loss); }
.drs { height: 22px; line-height: 22px; padding: 0 10px; margin-bottom: 8px; font-size: 12px; font-weight: 800; letter-spacing: 0.12em; background: rgba(255, 255, 255, 0.1); color: var(--bc-mute); }
.drs.eligible { color: var(--bc-ink); box-shadow: inset 0 0 0 1px var(--bc-drs); }
.drs.open { background: var(--bc-drs); color: var(--bc-drs-ink); }
.ob-enter-active { animation: obIn 0.35s var(--ease-out) 0.3s both; }
.ob-enter-active .tag { animation: obTag 0.3s var(--ease-out) 0.38s both; }
.ob-leave-active { transition: opacity 0.25s ease-in, transform 0.25s ease-in; }
.ob-leave-to { opacity: 0; transform: translateY(12px); }
@keyframes obIn { from { opacity: 0; transform: translateY(24px); } to { opacity: 1; transform: none; } }
@keyframes obTag { from { clip-path: inset(0 100% 0 0); } to { clip-path: inset(0 0 0 0); } }
</style>
