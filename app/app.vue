<script setup lang="ts">
const { store } = useRaceStore()
</script>

<template>
  <div class="app">
    <RaceViewport />
    <div class="hud">
      <HudRaceHeader />
      <HudTimingTower />
      <HudTelemetry />
      <HudTrackMap />
      <HudControls />
      <HudStartLights />
      <HudBanners />
      <HudBattle />
      <HudLowerThird />
      <HudResultPanel />
      <div class="hint">DRAG · ROTATE &nbsp;|&nbsp; WHEEL · ZOOM &nbsp;|&nbsp; CLICK CAR / ROW · SELECT &nbsp;|&nbsp; 1-5 CAMERAS &nbsp;|&nbsp; ↑↓ DRIVER &nbsp;|&nbsp; SPACE PAUSE &nbsp;|&nbsp; ESC OVERVIEW</div>
    </div>
    <div v-if="!store.ready" class="loading">
      <div class="brand">F1</div>
      <div class="sub">SUZUKA INTERNATIONAL RACING COURSE</div>
      <div class="bar" />
    </div>
  </div>
</template>
