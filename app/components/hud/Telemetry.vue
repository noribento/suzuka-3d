<script setup lang="ts">
import { formatLapTime, formatSector } from '~/sim/race'
const { store } = useRaceStore()

const d = computed(() => (store.selected >= 0 ? store.drivers[store.selected] : undefined))
const rpmSegs = computed(() => (d.value ? Math.round(((d.value.rpm - 5000) / 7500) * 14) : 0))
const compoundName = (c: string) => (c === 'S' ? 'SOFT' : c === 'M' ? 'MEDIUM' : 'HARD')
</script>

<template>
  <transition name="slide-up">
    <div v-if="d" class="telemetry" :style="{ '--team': d.color }">
      <div class="driver">
        <span class="num">{{ d.number }}</span>
        <div class="names">
          <span class="first">{{ d.firstName }}</span>
          <span class="last">{{ d.lastName.toUpperCase() }}</span>
        </div>
        <div class="teampos">
          <span class="team">{{ d.teamName.toUpperCase() }}</span>
          <span class="posbadge">P{{ d.position }}</span>
        </div>
      </div>
      <div class="gauges">
        <div class="speed">
          <span class="value">{{ d.speedKmh }}</span>
          <span class="unit">KM/H</span>
        </div>
        <div class="gear">
          <span class="value">{{ d.gear || 'N' }}</span>
          <span class="unit">GEAR</span>
        </div>
        <div class="rpm">
          <div class="segments">
            <span v-for="i in 14" :key="i" :class="{ on: i <= rpmSegs, red: i > 11 }" />
          </div>
          <span class="unit">{{ d.rpm }} RPM</span>
        </div>
        <div class="pedals">
          <div class="pedal thr"><div class="fill" :style="{ height: d.throttle * 100 + '%' }" /></div>
          <div class="pedal brk"><div class="fill" :style="{ height: d.brake * 100 + '%' }" /></div>
        </div>
        <div class="drs" :class="{ open: d.drs, eligible: d.drsEligible && !d.drs }">DRS</div>
      </div>
      <div class="times">
        <div class="time"><label>LAP</label><span>{{ formatLapTime(d.currentLap) }}</span></div>
        <div class="time"><label>LAST</label><span>{{ formatLapTime(d.lastLap) }}</span></div>
        <div class="time"><label>BEST</label><span :class="{ purple: d.hasFastestLap }">{{ formatLapTime(d.bestLap) }}</span></div>
        <div class="sectors">
          <span v-for="i in 3" :key="i" class="sector" :class="['flag-' + d.sectorFlags[i - 1]]">
            <label>S{{ i }}</label>{{ formatSector(d.sectors[i - 1]) }}
          </span>
        </div>
      </div>
      <div class="status">
        <span class="loc">{{ d.location }}</span>
        <span class="tyre" :class="'tyre-' + d.compound">{{ compoundName(d.compound) }} · {{ d.tyreAge }} LAPS</span>
        <span v-if="d.inPit" class="pitflag">IN PIT LANE</span>
        <span v-else-if="d.finished" class="pitflag">FINISHED</span>
        <span v-else-if="store.tvCamName" class="cam">{{ store.tvCamName }}</span>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.telemetry {
  position: absolute;
  left: 248px;
  bottom: 18px;
  width: 470px;
  background: var(--panel-strong);
  border-radius: 4px;
  overflow: hidden;
  color: #fff;
  font-family: var(--font);
  pointer-events: none;
  border-left: 5px solid var(--team);
}
.driver {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 14px 6px;
  background: linear-gradient(90deg, rgba(255, 255, 255, 0.08), transparent);
}
.num {
  font-size: 30px;
  font-weight: 900;
  font-style: italic;
  color: var(--team);
  min-width: 46px;
  line-height: 1;
}
.names {
  display: flex;
  flex-direction: column;
  line-height: 1.05;
}
.first { font-size: 12px; font-weight: 600; color: var(--muted); }
.last { font-size: 20px; font-weight: 700; letter-spacing: 0.04em; }
.teampos {
  margin-left: auto;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 3px;
}
.team { font-size: 10px; letter-spacing: 0.14em; font-weight: 700; color: var(--muted); }
.posbadge {
  font-size: 13px;
  font-weight: 700;
  background: #fff;
  color: #111;
  padding: 0 8px;
  border-radius: 2px;
}
.gauges {
  display: flex;
  align-items: flex-end;
  gap: 16px;
  padding: 8px 14px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}
.speed .value {
  font-size: 44px;
  font-weight: 700;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  min-width: 82px;
  display: inline-block;
}
.gear .value {
  font-size: 44px;
  font-weight: 700;
  line-height: 1;
  color: #ffd400;
  min-width: 30px;
  display: inline-block;
  text-align: center;
}
.unit {
  display: block;
  font-size: 9px;
  letter-spacing: 0.16em;
  font-weight: 700;
  color: var(--muted);
  margin-top: 2px;
}
.rpm {
  flex: 1;
  min-width: 120px;
}
.segments {
  display: flex;
  gap: 3px;
  height: 14px;
  align-items: flex-end;
}
.segments span {
  flex: 1;
  height: 100%;
  background: rgba(255, 255, 255, 0.12);
  border-radius: 1px;
}
.segments span.on { background: #35d07f; }
.segments span.on.red { background: #ff3b3b; }
.pedals {
  display: flex;
  gap: 4px;
  height: 44px;
}
.pedal {
  width: 10px;
  height: 100%;
  background: rgba(255, 255, 255, 0.12);
  border-radius: 2px;
  display: flex;
  align-items: flex-end;
  overflow: hidden;
}
.pedal .fill { width: 100%; transition: height 0.08s linear; }
.thr .fill { background: #35d07f; }
.brk .fill { background: #ff3b3b; }
.drs {
  height: 22px;
  line-height: 22px;
  padding: 0 10px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.12em;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.1);
  color: var(--muted);
  margin-bottom: 10px;
}
.drs.eligible { color: #fff; border: 1px solid #00c853; }
.drs.open { background: #00c853; color: #041; }
.times {
  display: flex;
  gap: 14px;
  padding: 6px 14px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  font-variant-numeric: tabular-nums;
  align-items: center;
}
.time { display: flex; flex-direction: column; }
.time label, .sector label { font-size: 9px; letter-spacing: 0.16em; color: var(--muted); font-weight: 700; margin-right: 4px; }
.time span { font-size: 15px; font-weight: 700; }
.time span.purple { color: var(--purple-text); }
.sectors { margin-left: auto; display: flex; gap: 6px; }
.sector {
  font-size: 11px;
  font-weight: 700;
  padding: 2px 6px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.08);
  color: #eee;
}
.sector.flag-1 { background: #1f9d55; color: #fff; }
.sector.flag-2 { background: var(--purple); color: #fff; }
.status {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 5px 14px 7px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--muted);
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}
.loc { color: #fff; }
.tyre-S { color: #ff4d6d; }
.tyre-M { color: #ffd400; }
.tyre-H { color: #f0f0f0; }
.pitflag { margin-left: auto; color: #ffd400; }
.cam { margin-left: auto; color: #fff; opacity: 0.8; }
.slide-up-enter-active, .slide-up-leave-active { transition: transform 0.35s ease, opacity 0.35s ease; }
.slide-up-enter-from, .slide-up-leave-to { transform: translateY(20px); opacity: 0; }
@media (max-width: 900px) {
  .telemetry { left: 18px; width: calc(100vw - 36px); bottom: 90px; }
  .rpm { display: none; }
}
</style>
