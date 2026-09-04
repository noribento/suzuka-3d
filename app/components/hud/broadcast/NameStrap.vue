<script setup lang="ts">
import { TEAMS, type TeamId } from '~/data/drivers'
/**
 * Lower third for the isolated driver, with the measured world-feed choreography (ms from launch):
 *   0     base grows 0→100 % over 667 ms, painted in the team colour, opacity 0.1→1 over 800 ms
 *   333   content revealed by a slanted clip-path wipe over 400 ms
 *   500   position chip step-blinks (233 ms) then a 40° wipe (333 ms from 600); team name step-blinks
 *   600   base settles from the team colour to black over 566 ms
 *   733   team bar unclips vertically over 667 ms
 *   1000  team gem slides in from the right over 2000 ms (opacity 1200 ms); driver number fades 600 ms
 * Exit: opacity 300 ms while the base collapses back toward the tower edge over 400 ms.
 */
const { store } = useRaceStore()
const ns = computed(() => store.bc.nameStrap)
const d = computed(() => (ns.value ? store.drivers[ns.value.driver] : undefined))
const short = computed(() => (d.value ? TEAMS[d.value.team as TeamId].short : ''))
</script>

<template>
  <transition name="ns" mode="out-in" :duration="{ enter: 3000, leave: 400 }">
    <div v-if="ns && d" :key="ns.key" class="bc-name" :style="{ '--team': d.color }">
      <div class="base" />
      <div class="inner">
        <span class="pos" :class="{ p1: d.position === 1 }"><i>{{ d.position }}</i></span>
        <span class="bar" />
        <span class="names">
          <span class="first">{{ d.firstName }}</span>
          <span class="last">{{ d.lastName.toUpperCase() }}</span>
        </span>
        <span class="team">{{ d.teamName.toUpperCase() }}</span>
        <span class="num">{{ d.number }}</span>
        <span class="gem"><b>{{ short }}</b></span>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.bc-name {
  position: absolute;
  left: 60px;
  top: 900px;
  width: 620px;
  height: 84px;
}
.base {
  position: absolute;
  left: 0;
  top: 0;
  height: 100%;
  width: 100%;
  background: #0b0b10;
}
.inner {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 18px 0 10px;
}
.pos {
  flex: 0 0 56px;
  width: 56px;
  height: 56px;
  background: var(--bc-chip);
  color: #111;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--bc-font-varsity);
  font-size: 30px;
}
.pos.p1 { background: var(--bc-red); color: #fff; }
.bar { flex: 0 0 6px; width: 6px; height: 54px; background: var(--team); }
.names { display: flex; flex-direction: column; line-height: 1.05; }
.first { font-size: 20px; font-weight: 400; color: var(--bc-mute-2); letter-spacing: 0.04em; }
.last { font-size: 30px; font-weight: 800; letter-spacing: 0.02em; }
.team {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.1em;
  color: var(--bc-mute-2);
  padding-left: 14px;
  border-left: 1px solid rgba(255, 255, 255, 0.15);
  white-space: nowrap;
}
.num {
  margin-left: auto;
  font-family: var(--bc-font-varsity);
  font-size: 46px;
  color: var(--team);
  line-height: 1;
}
.gem {
  flex: 0 0 62px;
  width: 62px;
  height: 40px;
  background: var(--team);
  clip-path: polygon(22% 0, 100% 0, 78% 100%, 0 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  color: #111;
  font-size: 13px;
  font-weight: 800;
  background-image: linear-gradient(130deg, rgba(255, 255, 255, 0.35), rgba(255, 255, 255, 0) 55%);
}
/* entrance timeline (all children animate under the enter class; fill-mode both holds the pre-delay state) */
.ns-enter-active .base { animation: nsBase 0.667s var(--ease-out) both, nsBaseOpacity 0.8s ease-in both, nsSettle 0.566s linear 0.6s both; }
.ns-enter-active .inner { animation: nsWipe 0.4s var(--ease-in) 0.333s both; }
.ns-enter-active .pos { animation: nsBlink 0.233s steps(1, end) 0.5s both, nsChipWipe 0.333s var(--ease-out) 0.6s both; }
.ns-enter-active .team { animation: nsBlink 0.233s steps(1, end) 0.5s both; }
.ns-enter-active .bar { animation: nsBar 0.667s cubic-bezier(0.42, 0, 0.58, 1) 0.733s both; }
.ns-enter-active .gem { animation: nsGem 2s var(--ease-out) 1s both, nsGemFade 1.2s ease-out 1s both; }
.ns-enter-active .num { animation: nsFade 0.6s ease-out 1s both; }
.ns-leave-active { transition: opacity 0.3s ease-in; }
.ns-leave-active .base { transition: width 0.4s var(--ease-in); }
.ns-leave-active .inner { transition: opacity 0.15s; }
.ns-leave-to { opacity: 0; }
.ns-leave-to .base { width: 0; }
.ns-leave-to .inner { opacity: 0; }
@keyframes nsBase { from { width: 0; } to { width: 100%; } }
@keyframes nsBaseOpacity { from { opacity: 0.1; } to { opacity: 1; } }
@keyframes nsSettle { from { background: var(--team); } to { background: #0b0b10; } }
@keyframes nsWipe { from { clip-path: polygon(0 0, 0 0, -40% 100%, -40% 100%); } to { clip-path: polygon(0 0, 140% 0, 100% 100%, -40% 100%); } }
@keyframes nsBlink { 0% { opacity: 0; } 25% { opacity: 0.4; } 50% { opacity: 0; } 75% { opacity: 0.4; } 100% { opacity: 1; } }
@keyframes nsChipWipe { from { clip-path: polygon(0 0, 0 0, -84% 100%, -84% 100%); } to { clip-path: polygon(0 0, 184% 0, 100% 100%, -84% 100%); } }
@keyframes nsBar { from { clip-path: inset(50% 0 50% 0); } to { clip-path: inset(0 0 0 0); } }
@keyframes nsGem { from { transform: translateX(300%); } to { transform: translateX(0); } }
@keyframes nsGemFade { from { opacity: 0; } to { opacity: 1; } }
@keyframes nsFade { from { opacity: 0; } to { opacity: 1; } }
</style>
