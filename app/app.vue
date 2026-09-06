<script setup lang="ts">
const { store, broadcast } = useRaceStore()
</script>

<template>
  <div class="app">
    <RaceViewport />
    <div class="hud" :class="{ broadcast }">
      <!-- classic HUD for the overview / heli / chase / onboard cameras -->
      <template v-if="!broadcast">
        <HudRaceHeader />
        <HudTimingTower />
        <HudTelemetry />
        <HudTrackMap />
        <HudBattle />
        <HudLowerThird />
        <div class="hint">DRAG · ROTATE &nbsp;|&nbsp; WHEEL · ZOOM &nbsp;|&nbsp; WASD · MOVE &nbsp;|&nbsp; CLICK CAR / ROW · SELECT &nbsp;|&nbsp; 1-6 CAMERAS &nbsp;|&nbsp; ↑↓ DRIVER &nbsp;|&nbsp; SPACE PAUSE &nbsp;|&nbsp; ESC OVERVIEW</div>
      </template>
      <!-- stays mounted: its clock watcher is what expires store.events while the classic banners are hidden -->
      <HudBanners v-show="!broadcast" />
      <!-- world-feed package for the tv camera and the automatic director -->
      <transition name="bc-layer" :duration="{ enter: 1100, leave: 300 }">
        <HudBroadcastLayer v-if="broadcast" />
      </transition>
      <HudControls />
      <HudStartLights />
      <HudResultPanel />
    </div>
    <div v-if="!store.ready" class="loading">
      <div class="brand">F1</div>
      <div class="sub">SUZUKA INTERNATIONAL RACING COURSE</div>
      <!-- real progress once the asset downloads report; an indeterminate sweep before that (and on the asset-less tier) -->
      <div class="bar" :class="{ indeterminate: store.loadProgress === 0 }" :style="{ '--p': store.loadProgress }" />
    </div>
  </div>
</template>
