<script setup lang="ts">
import { formatLapTime } from '~/sim/race'
const { store, broadcast, restart } = useRaceStore()
const top = computed(() => store.order.slice(0, 3).map((i) => store.drivers[i]!))
// in broadcast mode the world feed's chequered sequence (header, RACE WINNER strap, winner lower third) plays first
const visible = computed(() => store.status === 'finished' && store.winner !== null && !dismissed.value && (!broadcast.value || (store.bc.classificationAt !== null && store.nowMs >= store.bc.classificationAt)))
const dismissed = ref(false)
watch(() => store.restartToken, () => (dismissed.value = false))
</script>

<template>
  <transition name="fade">
    <div v-if="visible" class="result">
      <div class="head"><span class="flag">🏁</span> RACE CLASSIFICATION · JAPANESE GRAND PRIX</div>
      <div v-for="(d, i) in top" :key="d.idx" class="row" :style="{ '--team': d.color }">
        <span class="pos">{{ i + 1 }}</span>
        <span class="bar" />
        <span class="name">{{ d.firstName }} <b>{{ d.lastName.toUpperCase() }}</b></span>
        <span class="team">{{ d.teamName }}</span>
        <span class="gap">{{ i === 0 ? 'WINNER' : d.gapText }}</span>
      </div>
      <div class="foot">
        <span v-if="store.fastestLap">FASTEST LAP · {{ store.drivers[store.fastestLap.driver]?.code }} {{ formatLapTime(store.fastestLap.time) }}</span>
        <span class="actions">
          <button @click="dismissed = true">CLOSE</button>
          <button class="primary" @click="restart()">NEW RACE</button>
        </span>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.result {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: min(560px, 92vw);
  background: var(--panel-strong);
  border-radius: 6px;
  overflow: hidden;
  color: #fff;
  font-family: var(--font);
  pointer-events: auto;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
}
.head {
  padding: 12px 16px;
  font-size: 12px;
  letter-spacing: 0.2em;
  font-weight: 700;
  background: var(--f1-red);
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.pos { font-size: 22px; font-weight: 900; width: 28px; }
.bar { width: 5px; height: 26px; background: var(--team); }
.name { font-size: 18px; }
.team { color: var(--muted); font-size: 12px; letter-spacing: 0.1em; margin-left: 6px; }
.gap { margin-left: auto; font-weight: 700; font-variant-numeric: tabular-nums; }
.foot {
  display: flex;
  align-items: center;
  padding: 10px 16px;
  font-size: 12px;
  letter-spacing: 0.1em;
  color: var(--purple-text);
  font-weight: 700;
}
.actions { margin-left: auto; display: flex; gap: 8px; }
button {
  border: 1px solid rgba(255, 255, 255, 0.25);
  background: transparent;
  color: #fff;
  font: 700 11px var(--font);
  letter-spacing: 0.12em;
  padding: 8px 14px;
  border-radius: 3px;
  cursor: pointer;
}
button.primary { background: var(--f1-red); border-color: var(--f1-red); }
.fade-enter-active, .fade-leave-active { transition: opacity 0.4s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
