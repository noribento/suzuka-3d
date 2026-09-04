<script setup lang="ts">
/**
 * Bottom-centre head-to-head for the closest fight (hysteresis-filtered by the graphics
 * director): car ahead | stepped 1-decimal gap with DRS tag | car behind. Opens from the centre
 * over 400 ms (header strip 250 ms from 150 ms, cars 300 ms from 200 ms), closes in 300 ms.
 */
const { store } = useRaceStore()
const b = computed(() => store.bc.battle)
const ahead = computed(() => (b.value ? store.drivers[b.value.ahead] : undefined))
const behind = computed(() => (b.value ? store.drivers[b.value.behind] : undefined))
const visible = computed(() => !!b.value && !!ahead.value && !!behind.value && store.shot !== 'onboard')
const drs = computed(() => !!behind.value && (behind.value.drs || behind.value.drsEligible))
</script>

<template>
  <transition name="bt" :duration="{ enter: 500, leave: 300 }">
    <div v-if="visible && b && ahead && behind" class="bc-battle">
      <div class="strip">BATTLE FOR P{{ b.position }}</div>
      <div class="cars">
        <div class="car" :style="{ '--team': ahead.color }">
          <span class="chip">{{ ahead.position }}</span><span class="bar" /><span class="code">{{ ahead.code }}</span>
        </div>
        <div class="gap">
          <transition name="tick" mode="out-in" :duration="{ enter: 150, leave: 0 }">
            <span :key="behind.tvInterval" class="val">{{ behind.tvInterval || '+0.0' }}</span>
          </transition>
          <transition name="drs" :duration="{ enter: 150, leave: 120 }">
            <span v-if="drs" class="drs" :class="{ open: behind.drs }">DRS</span>
          </transition>
        </div>
        <div class="car right" :style="{ '--team': behind.color }">
          <span class="code">{{ behind.code }}</span><span class="bar" /><span class="chip">{{ behind.position }}</span>
        </div>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.bc-battle {
  position: absolute;
  left: 700px;
  top: 908px;
  width: 520px;
  height: 76px;
  background: var(--bc-panel);
  overflow: hidden;
}
.strip {
  height: 18px;
  line-height: 18px;
  padding: 0 12px;
  background: var(--bc-red);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.2em;
  color: #fff;
}
.cars { display: flex; align-items: center; height: 58px; padding: 0 14px; }
.car { display: flex; align-items: center; gap: 8px; flex: 1; }
.car.right { justify-content: flex-end; }
.chip {
  width: 30px;
  height: 30px;
  line-height: 30px;
  text-align: center;
  background: var(--bc-chip);
  color: #111;
  font-family: var(--bc-font-varsity);
  font-size: 17px;
}
.bar { width: 4px; height: 26px; background: var(--team); }
.code { font-size: 22px; font-weight: 800; letter-spacing: 0.04em; }
.gap { display: flex; flex-direction: column; align-items: center; min-width: 110px; }
.val { font-size: 28px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1; }
.drs {
  margin-top: 3px;
  height: 16px;
  line-height: 16px;
  padding: 0 6px;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.1em;
  border: 1px solid var(--bc-drs);
  color: var(--bc-ink);
}
.drs.open { background: var(--bc-drs); color: var(--bc-drs-ink); }
.bt-enter-active { animation: btIn 0.4s var(--ease-out) both; }
.bt-enter-active .strip { animation: btStrip 0.25s ease-out 0.15s both; }
.bt-enter-active .car { animation: btCar 0.3s ease-out 0.2s both; }
.bt-leave-active { transition: opacity 0.3s var(--ease-in), transform 0.3s var(--ease-in); }
.bt-leave-to { opacity: 0; transform: scaleY(0.6); }
.tick-enter-active { transition: opacity 0.15s linear; }
.tick-enter-from { opacity: 0.35; }
.drs-enter-active { transition: transform 0.15s var(--ease-out), opacity 0.15s; }
.drs-leave-active { transition: opacity 0.12s; }
.drs-enter-from { transform: scale(0.6); opacity: 0; }
.drs-leave-to { opacity: 0; }
@keyframes btIn { from { transform: scaleX(0); } to { transform: scaleX(1); } }
@keyframes btStrip { from { transform: translateY(-100%); } to { transform: none; } }
@keyframes btCar { from { opacity: 0; } to { opacity: 1; } }
</style>
