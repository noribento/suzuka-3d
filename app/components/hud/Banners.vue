<script setup lang="ts">
const { store } = useRaceStore()
const now = ref(performance.now())
let timer = 0
onMounted(() => {
  timer = window.setInterval(() => {
    now.value = performance.now()
    const keep = store.events.filter((e) => now.value - e.t < e.ttl)
    if (keep.length !== store.events.length) store.events = keep
  }, 250)
})
onBeforeUnmount(() => clearInterval(timer))
</script>

<template>
  <div class="banners">
    <transition-group name="banner">
      <div v-for="e in store.events" :key="e.id" class="banner" :class="e.kind" :style="{ '--accent': e.color }">
        <span class="icon">
          <template v-if="e.kind === 'fastest'">◆</template>
          <template v-else-if="e.kind === 'overtake'">⇧</template>
          <template v-else-if="e.kind === 'pit'">▣</template>
          <template v-else-if="e.kind === 'flag'">🏁</template>
          <template v-else>●</template>
        </span>
        <span class="title">{{ e.title }}</span>
        <span class="text">{{ e.text }}</span>
      </div>
    </transition-group>
  </div>
</template>

<style scoped>
.banners {
  position: absolute;
  left: 50%;
  top: 72px;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  pointer-events: none;
  font-family: var(--font);
  width: min(640px, 90vw);
}
.banner {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 34px;
  padding: 0 16px 0 0;
  background: var(--panel-strong);
  color: #fff;
  border-radius: 3px;
  overflow: hidden;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
  white-space: nowrap;
}
.icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 100%;
  background: var(--accent);
  color: #fff;
  font-size: 14px;
}
.title {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.18em;
}
.text {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.04em;
}
.banner.fastest { background: var(--purple); }
.banner.fastest .icon { background: rgba(0, 0, 0, 0.35); }
.banner.drs { background: #0a5f2c; }
.banner.drs .icon { background: #00c853; color: #041; }
.banner.flag .text { font-weight: 700; }
.banner-enter-active, .banner-leave-active { transition: all 0.4s cubic-bezier(0.22, 1, 0.36, 1); }
.banner-enter-from { opacity: 0; transform: translateY(-14px) scale(0.96); }
.banner-leave-to { opacity: 0; transform: translateY(-8px); }
</style>
