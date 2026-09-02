#!/usr/bin/env node
/**
 * Headless race-simulation harness.
 *
 *   pnpm sim                      # 3 laps, one seed, human-readable report
 *   pnpm sim -- --laps 53 --seeds 5
 *   pnpm sim -- --laps 53 --seeds 20 --json > out.json
 *
 * Runs the same RaceSim the browser uses (at thousands of × realtime) and reports the
 * numbers that matter for realism: track geometry, corner apex speeds vs targets, lap
 * time distribution, overtakes, physical overlaps, pit loss and pit windows.
 */
import './ts-hooks.mjs'

const { Track, forwardDelta, signedDelta } = await import('../app/sim/track.ts')
const { RaceSim, formatLapTime } = await import('../app/sim/race.ts')
const suzuka = await import('../app/data/suzuka.ts')

const args = process.argv.slice(2)
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : def
}
const LAPS = Number(opt('laps', 3))
const SEEDS = Number(opt('seeds', 1))
const SEED0 = Number(opt('seed', 12345))
const JSON_OUT = args.includes('--json')
const VERBOSE = args.includes('--verbose')

const log = (...a) => { if (!JSON_OUT) console.log(...a) }
const kmh = (v) => v * 3.6

// ---------------------------------------------------------------- track report
const t0 = performance.now()
const track = new Track()
const buildMs = performance.now() - t0
const report = { track: {}, seeds: [] }

report.track = {
  buildMs: Math.round(buildMs),
  length: track.length,
  n: track.n,
  ds: track.ds,
  corners: track.corners.length,
  crossing: track.crossing,
  elevation: (() => {
    let lo = Infinity, hi = -Infinity
    for (let i = 0; i < track.n; i++) { lo = Math.min(lo, track.py[i]); hi = Math.max(hi, track.py[i]) }
    return { min: lo, max: hi }
  })(),
  maxLineOffset: (() => {
    let m = 0
    for (let i = 0; i < track.n; i++) m = Math.max(m, Math.abs(track.line[i]))
    return m
  })(),
}
log(`track: length ${track.length.toFixed(2)} m (official ${suzuka.CIRCUIT.officialLength}), n=${track.n}, ds=${track.ds.toFixed(3)}, built in ${buildMs.toFixed(0)} ms`)
log(`  corners ${track.corners.length}, elevation ${report.track.elevation.min.toFixed(1)}..${report.track.elevation.max.toFixed(1)} m, max line offset ${report.track.maxLineOffset.toFixed(2)} m`)
log(`  crossing over s=${track.crossing.sOver.toFixed(0)} under s=${track.crossing.sUnder.toFixed(0)} (Δy ${(track.crossing.yOver - track.crossing.yUnder).toFixed(1)} m)`)

// ---------------------------------------------------------------- reference profile
const ref = new RaceSim(track, SEED0, 53)
const best = ref.cars.reduce((a, b) => (a.gripBase > b.gripBase ? a : b))
const ideal = ref.idealLap(best.profile)
let vmax = 0
for (let i = 0; i < best.profile.length; i++) vmax = Math.max(vmax, best.profile[i])
report.track.idealLap = ideal
report.track.vmaxKmh = kmh(vmax)
log(`ideal lap (best car) ${formatLapTime(ideal)}, top speed ${kmh(vmax).toFixed(0)} km/h`)

// corner apex speeds
const apexRows = []
const targets = suzuka.APEX_SPEED_TARGETS ?? []
for (const c of track.corners) {
  // minimum profile speed around the apex (±30 m) — the corner's own limit, not the
  // acceleration-limited entry after a slower corner
  let vmin = Infinity, sMin = c.apex
  for (let d = -30; d <= 30; d += track.ds) {
    const ss = track.wrap(c.apex + d)
    const v = ref.profileAt(best, ss)
    if (v < vmin) { vmin = v; sMin = ss }
  }
  // line radius and the calibrated physics radius at the apex
  let kLine = 0, kPhys = 0
  const len = forwardDelta(c.from, c.to, track.length)
  for (let d = 0; d <= len; d += track.ds) {
    const i = Math.round(track.wrap(c.from + d) / track.ds) % track.n
    kLine = Math.max(kLine, Math.abs(track.kappaLine[i]))
    kPhys = Math.max(kPhys, Math.abs(ref.kappaPhys[i]))
  }
  const tgt = targets.find((t) => Math.abs(signedDelta(t.s, c.apex, track.length)) < 60)
  apexRows.push({ from: c.from, to: c.to, apex: c.apex, sign: c.sign, radius: 1 / c.maxKappa, lineRadius: 1 / Math.max(kLine, 1e-6), physRadius: 1 / Math.max(kPhys, 1e-6), vApexKmh: kmh(vmin), sMin, target: tgt?.kmh ?? null, name: tgt?.name ?? '' })
}
report.track.apex = apexRows
log('corner apex speeds (km/h):')
for (const r of apexRows) {
  const dev = r.target ? ` target ${String(r.target).padStart(3)} (${((r.vApexKmh / r.target - 1) * 100).toFixed(0).padStart(4)}%)` : ''
  log(`  ${r.sign > 0 ? 'L' : 'R'} ${r.from.toFixed(0).padStart(5)}-${r.to.toFixed(0).padStart(5)} apex ${r.apex.toFixed(0).padStart(5)} R=${r.radius.toFixed(0).padStart(4)} line ${r.lineRadius.toFixed(0).padStart(4)} phys ${r.physRadius.toFixed(0).padStart(4)} m  v=${r.vApexKmh.toFixed(0).padStart(3)}${dev} ${r.name}`)
}

// ---------------------------------------------------------------- race runs
const overtakeZone = (s) => {
  const zones = suzuka.OVERTAKE_ZONES ?? []
  for (const z of zones) if (Math.abs(signedDelta(z.s, s, track.length)) < 150) return z.name
  return 'other'
}

for (let k = 0; k < SEEDS; k++) {
  const seed = SEED0 + k * 7919
  const race = new RaceSim(track, seed, 53)
  race.totalLaps = Math.min(race.totalLaps, LAPS)
  for (const c of race.cars) c.pitLap = Math.min(c.pitLap, race.totalLaps - 3)
  if (LAPS < 8) race.cars[5].pitLap = 2 // exercise the pit code on short runs
  race.startLights()
  const h = 1 / 50
  let simSeconds = 0
  let overlaps = 0
  let maxLat = 0
  let nan = false
  const overtakes = []
  const pitLog = new Map() // idx -> { tIn, dIn }
  const pitLosses = []
  const pitLaps = []
  const wall0 = performance.now()
  const lapTimes = []
  let evCursor = 0
  while (race.status !== 'finished' || race.order.some((c) => !c.finished && c.v > 0)) {
    race.step(h)
    simSeconds += h
    if (simSeconds > 3 * 3600) break
    if (race.status !== 'racing' && race.status !== 'finished') continue
    for (const c of race.cars) {
      if (!Number.isFinite(c.s) || !Number.isFinite(c.v) || !Number.isFinite(c.lateral)) nan = true
      maxLat = Math.max(maxLat, Math.abs(c.lateral))
      const p = pitLog.get(c.idx)
      if (c.pitState !== 'none' && !p) pitLog.set(c.idx, { tIn: race.time, dIn: c.totalDist, sIn: c.s, lap: c.lapsCompleted + 1 })
      if (c.pitState === 'none' && p) {
        // expected time to cover the same distance on track at profile speed
        let exp = 0
        for (let s = p.sIn; forwardDelta(p.sIn, track.wrap(s), track.length) < c.totalDist - p.dIn - 1; s += track.ds) exp += track.ds / Math.max(race.profileAt(c, track.wrap(s)), 1)
        pitLosses.push(race.time - p.tIn - exp)
        pitLaps.push(p.lap)
        pitLog.delete(c.idx)
      }
    }
    for (; evCursor < race.events.length; evCursor++) {
      const e = race.events[evCursor]
      if (e.type === 'overtake') {
        const car = race.cars[e.car]
        overtakes.push({ t: e.t, lap: car.lapsCompleted + 1, s: car.s, zone: overtakeZone(car.s), pit: race.cars[e.passed].pitState !== 'none' })
      }
    }
    if (Math.round(simSeconds * 50) % 10 === 0) {
      for (let i = 0; i < race.cars.length; i++) for (let j = i + 1; j < race.cars.length; j++) {
        const a = race.cars[i], b = race.cars[j]
        if ((a.pitState !== 'none') !== (b.pitState !== 'none')) continue
        if (a.pitState === 'box' || b.pitState === 'box') continue
        let d = Math.abs(a.s - b.s); d = Math.min(d, track.length - d)
        if (d < 4.6 && Math.abs(a.lateral - b.lateral) < 1.9) overlaps++
      }
    }
  }
  const wallMs = performance.now() - wall0
  for (const c of race.cars) if (c.bestLap > 0) lapTimes.push(c.bestLap)
  const racing = overtakes.filter((o) => o.lap > 1 && !o.pit)
  const zones = {}
  for (const o of racing) zones[o.zone] = (zones[o.zone] || 0) + 1
  const evCounts = {}
  for (const e of race.events) evCounts[e.type] = (evCounts[e.type] || 0) + 1
  const winner = race.order[0]
  const res = {
    seed,
    laps: race.totalLaps,
    simSeconds,
    wallMs: Math.round(wallMs),
    speedup: Math.round((simSeconds * 1000) / wallMs),
    status: race.status,
    nan,
    overlaps,
    maxLat,
    overtakesTotal: overtakes.length,
    overtakesRacing: racing.length,
    overtakeZones: zones,
    pitLossMean: pitLosses.length ? pitLosses.reduce((a, b) => a + b, 0) / pitLosses.length : null,
    pitLaps,
    fastest: race.fastestLap ? { code: race.cars[race.fastestLap.car].driver.code, time: race.fastestLap.time } : null,
    winner: winner.driver.code,
    raceTime: winner.finishTime,
    events: evCounts,
    order: race.order.map((c) => ({ pos: c.position, code: c.driver.code, laps: c.lapsCompleted, best: c.bestLap, last: c.lastLap, gap: c.position === 1 ? 0 : race.gap(c, race.order[0]), compound: c.compound, age: c.tyreAge, stops: c.pitStops })),
  }
  report.seeds.push(res)
  log(`\nseed ${seed}: ${race.totalLaps} laps, status ${race.status}, race time ${formatLapTime(winner.finishTime)}, ${res.speedup}× realtime`)
  log(`  nan ${nan}, overlap samples ${overlaps}, max |lateral| ${maxLat.toFixed(2)} m`)
  log(`  overtakes total ${overtakes.length}, racing (lap>1, not pit) ${racing.length} ${JSON.stringify(zones)}`)
  log(`  pit loss mean ${res.pitLossMean == null ? 'n/a' : res.pitLossMean.toFixed(1) + ' s'} (${pitLosses.length} stops), pit laps ${pitLaps.sort((a, b) => a - b).join(' ')}`)
  log(`  fastest ${res.fastest ? `${res.fastest.code} ${formatLapTime(res.fastest.time)}` : '—'}, events ${JSON.stringify(evCounts)}`)
  if (VERBOSE || SEEDS === 1) {
    for (const o of res.order) {
      log(`  ${String(o.pos).padStart(2)} ${o.code} laps ${String(o.laps).padStart(2)} best ${formatLapTime(o.best)} last ${formatLapTime(o.last)} ${o.pos === 1 ? '    LEADER' : ('+' + o.gap.toFixed(3)).padStart(10)} ${o.compound} age ${String(o.age).padStart(2)} stops ${o.stops}`)
    }
  }
}

if (SEEDS > 1) {
  const s = report.seeds
  const mean = (f) => s.reduce((a, r) => a + f(r), 0) / s.length
  report.summary = {
    overtakesRacingMean: mean((r) => r.overtakesRacing),
    overlapsMean: mean((r) => r.overlaps),
    pitLossMean: mean((r) => r.pitLossMean ?? 0),
    fastestMean: mean((r) => r.fastest?.time ?? 0),
    raceTimeMean: mean((r) => r.raceTime),
  }
  log(`\nsummary over ${s.length} seeds: overtakes(racing) ${report.summary.overtakesRacingMean.toFixed(1)}, overlaps ${report.summary.overlapsMean.toFixed(1)}, pit loss ${report.summary.pitLossMean.toFixed(1)} s, fastest ${formatLapTime(report.summary.fastestMean)}, race time ${formatLapTime(report.summary.raceTimeMean)}`)
}

if (JSON_OUT) console.log(JSON.stringify(report, null, 2))
