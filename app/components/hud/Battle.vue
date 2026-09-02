<script setup lang="ts">
const { store } = useRaceStore()
const b = computed(() => store.battle)
const ahead = computed(() => (b.value ? store.drivers[b.value.ahead] : undefined))
const behind = computed(() => (b.value ? store.drivers[b.value.behind] : undefined))
</script>

<template>
  <transition name="battle">
    <div v-if="b && ahead && behind" class="battle">
      <div class="head">BATTLE FOR P{{ b.position }}</div>
      <div class="cars">
        <div class="car" :style="{ '--team': ahead.color }">
          <span class="bar" /><span class="code">{{ ahead.code }}</span>
        </div>
        <div class="gap">
          <span class="val">+{{ b.gapSec.toFixed(3) }}</span>
          <span v-if="b.drs" class="drs">DRS</span>
        </div>
        <div class="car" :style="{ '--team': behind.color }">
          <span class="bar" /><span class="code">{{ behind.code }}</span>
        </div>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.battle {
  position: absolute;
  right: 18px;
  top: 262px;
  width: 300px;
  background: var(--panel-strong);
  border-radius: 3px;
  overflow: hidden;
  font-family: var(--font);
  color: #fff;
  pointer-events: none;
}
.head {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.2em;
  padding: 5px 10px;
  background: var(--f1-red);
}
.cars {
  display: flex;
  align-items: center;
  padding: 6px 10px;
  gap: 10px;
}
.car {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
}
.car:last-child { justify-content: flex-end; }
.bar { width: 4px; height: 16px; background: var(--team); border-radius: 1px; }
.code { font-size: 15px; font-weight: 700; letter-spacing: 0.05em; }
.gap { display: flex; flex-direction: column; align-items: center; gap: 2px; }
.val { font-size: 15px; font-weight: 700; font-variant-numeric: tabular-nums; }
.drs { font-size: 8px; font-weight: 700; letter-spacing: 0.1em; background: #00c853; color: #041; padding: 1px 4px; border-radius: 2px; }
.battle-enter-active, .battle-leave-active { transition: all 0.35s ease; }
.battle-enter-from, .battle-leave-to { opacity: 0; transform: translateX(20px); }
@media (max-width: 900px) { .battle { display: none; } }
</style>
