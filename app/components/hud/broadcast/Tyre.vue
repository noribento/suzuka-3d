<script setup lang="ts">
import type { Compound } from '~/data/drivers'
/** Broadcast tyre glyph: the compound letter inside a ring in the compound colour, optional age. */
const props = withDefaults(defineProps<{ compound: Compound; size?: number; age?: number }>(), { size: 22 })
const style = computed(() => ({ width: props.size + 'px', height: props.size + 'px', fontSize: Math.round(props.size * 0.5) + 'px', borderWidth: Math.max(2, Math.round(props.size * 0.11)) + 'px' }))
</script>

<template>
  <span class="tyre" :class="'c-' + compound">
    <i :style="style">{{ compound }}</i>
    <b v-if="age !== undefined">{{ age }}</b>
  </span>
</template>

<style scoped>
.tyre { display: inline-flex; align-items: center; gap: 6px; }
.tyre i {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  border-style: solid;
  box-sizing: border-box;
  font-style: normal;
  font-weight: 800;
  line-height: 1;
}
.c-S i { border-color: var(--bc-tyre-S); color: var(--bc-tyre-S); }
.c-M i { border-color: var(--bc-tyre-M); color: var(--bc-tyre-M); }
.c-H i { border-color: var(--bc-tyre-H); color: var(--bc-tyre-H); }
.tyre b { font-weight: 600; font-variant-numeric: tabular-nums; color: var(--bc-ink); }
</style>
