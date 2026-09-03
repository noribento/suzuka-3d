<script setup lang="ts">
const { store } = useRaceStore()
const visible = computed(() => store.status === 'grid' || store.status === 'lights')
</script>

<template>
  <transition name="fade">
    <div v-if="visible" class="lights">
      <div class="panel">
        <div v-for="i in 5" :key="i" class="column">
          <span class="lamp" :class="{ on: store.status === 'lights' && i <= store.lights }" />
          <span class="lamp" :class="{ on: store.status === 'lights' && i <= store.lights }" />
        </div>
      </div>
      <div class="caption">{{ store.status === 'grid' ? (store.interacted ? 'CARS ON THE GRID' : 'TAP / CLICK TO START') : 'START SEQUENCE' }}</div>
      <div class="count" role="status" aria-live="polite" aria-atomic="true">{{ store.status === 'lights' && store.lights > 0 ? 6 - store.lights : '' }}</div>
    </div>
  </transition>
</template>

<style scoped>
.lights {
  position: absolute;
  left: 50%;
  top: 16px;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  pointer-events: none;
  font-family: var(--font);
}
.panel {
  display: flex;
  gap: 10px;
  padding: 10px 14px;
  background: #101014;
  border-radius: 6px;
  box-shadow: 0 6px 22px rgba(0, 0, 0, 0.6);
}
.column {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.lamp {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: #2a0606;
  box-shadow: inset 0 0 6px rgba(0, 0, 0, 0.8);
  transition: background 0.05s;
}
.lamp.on {
  background: #ff1f1f;
  box-shadow: 0 0 14px #ff1f1f, 0 0 30px rgba(255, 31, 31, 0.6);
}
.caption {
  font-size: 11px;
  letter-spacing: 0.2em;
  font-weight: 700;
  color: #fff;
  background: var(--panel);
  padding: 4px 12px;
  border-radius: 2px;
}
.count {
  min-height: 22px;
  font-size: 18px;
  font-weight: 900;
  font-variant-numeric: tabular-nums;
  color: #fff;
  text-shadow: 0 0 10px rgba(255, 31, 31, 0.8);
}
.fade-enter-active, .fade-leave-active { transition: opacity 0.4s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
