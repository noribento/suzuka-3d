#!/usr/bin/env node
/**
 * Headless race-simulation harness.
 *
 *   pnpm sim                      # 3 laps, one seed, human-readable report
 *   pnpm sim -- --laps 53 --seeds 5
 *   pnpm sim -- --laps 53 --seeds 20 --json > out.json
 *   pnpm sim -- --laps 8 --seeds 3 --pit-trace [--envelope out.json]
 *
 * Runs the same RaceSim the browser uses (at thousands of × realtime) and reports the
 * numbers that matter for realism: track geometry, corner apex speeds vs targets, lap
 * time distribution, overtakes, physical overlaps, pit loss and pit windows.
 *
 * --pit-trace records every car with pitState ≠ 'none' in 5 m bins of s (min / max lateral)
 * and reports the measured pit envelope against PIT_ENVELOPE (app/data/suzuka-facilities-spec):
 * the entry lag (how far toward the track an entering car sits from `Track.pitLateralAt` on the
 * entry ramp), the exit lag (the same on the exit ramp, once the car has rejoined the lane after
 * its box), the lateral of every stopped car vs PIT_ENVELOPE.stop, the distance after the box at
 * which an exiting car is back within c(s) + 2 m (median = the unobstructed car; the max is
 * traffic — a car yielding to one passing in the lane), the distance before the box at which an
 * entering car reaches stop + 0.5, and overlap samples between two pit-lane cars. Exit code 1
 * when a lag exceeds the envelope, a stop misses PIT_ENVELOPE.stop by more than 0.5 m or the
 * median rejoin takes more than 40 m. --envelope <json> writes the bins (the ops-check can verify
 * against a measured envelope instead of the analytic one).
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
const PIT_TRACE = args.includes('--pit-trace')
const ENVELOPE_OUT = opt('envelope', null)
const spec = PIT_TRACE || ENVELOPE_OUT ? await import('../app/data/suzuka-facilities-spec.ts') : null

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
  const trace = PIT_TRACE || ENVELOPE_OUT ? pitTracer(track, race) : null
  const wall0 = performance.now()
  const lapTimes = []
  let evCursor = 0
  while (race.status !== 'finished' || race.order.some((c) => !c.finished && c.v > 0)) {
    race.step(h)
    simSeconds += h
    if (simSeconds > 3 * 3600) break
    if (race.status !== 'racing' && race.status !== 'finished') continue
    trace?.sample()
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
  if (trace) {
    res.pitTrace = trace.report()
    const p = res.pitTrace
    log(`  pit trace: entry lag ${p.entryLag.toFixed(2)} m @s ${p.entryLagS.toFixed(0)} (envelope ${p.envelope.entryLag}), exit lag ${p.exitLag.toFixed(2)} m @s ${p.exitLagS.toFixed(0)} (envelope ${p.envelope.exitLag}), pit-car overlaps ${p.pitOverlaps}`)
    log(`  pit trace: stopped lateral ${p.stop.min.toFixed(2)}…${p.stop.max.toFixed(2)} (${p.stop.n} stops, target ${p.envelope.stop}); back within c + 2 m after the box: median ${p.exitRecovery.median.toFixed(1)} m, max ${p.exitRecovery.max.toFixed(1)} m, ${p.exitRecovery.over} of ${p.exitRecovery.n} over 40 m; at stop + 0.5 before the box: median ${p.entryRecovery.median.toFixed(1)} m, max ${p.entryRecovery.max.toFixed(1)} m, ${p.entryRecovery.over} never`)
    if (p.failures.length) for (const f of p.failures) log(`  pit trace FAIL: ${f}`)
  }
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

if (ENVELOPE_OUT) {
  const fs = await import('node:fs')
  const bins = new Map()
  for (const r of report.seeds) for (const b of r.pitTrace?.bins ?? []) {
    const cur = bins.get(b.s)
    if (!cur) bins.set(b.s, { ...b })
    else { cur.min = Math.min(cur.min, b.min); cur.max = Math.max(cur.max, b.max); cur.n += b.n }
  }
  const out = {
    generated: new Date().toISOString(),
    seeds: report.seeds.map((r) => r.seed),
    laps: LAPS,
    envelope: spec.PIT_ENVELOPE,
    stop: spec.PIT_ENVELOPE.stop,
    summary: report.seeds.map((r) => ({ seed: r.seed, ...r.pitTrace, bins: undefined })),
    bins: [...bins.values()].sort((a, b) => forwardDelta(suzuka.CIRCUIT.pit.entryS, a.s, track.length) - forwardDelta(suzuka.CIRCUIT.pit.entryS, b.s, track.length)),
  }
  fs.writeFileSync(ENVELOPE_OUT, JSON.stringify(out, null, 1))
  log(`\nenvelope written to ${ENVELOPE_OUT} (${out.bins.length} bins)`)
}
if (PIT_TRACE && report.seeds.some((r) => r.pitTrace?.failures.length)) {
  console.error('pit trace: the measured envelope exceeds PIT_ENVELOPE / the stop target')
  process.exitCode = 1
}

// ---------------------------------------------------------------- pit trace (--pit-trace)
/**
 * Samples every car in the pit lane each step: 5 m bins of (min, max) lateral, the lag from
 * `Track.pitLateralAt` on the entry / exit ramps, the lateral of every stopped car, and the
 * distance after the box at which an exiting car is back within c(s) + 2 m.
 */
function pitTracer(track, race) {
  const E = spec.PIT_ENVELOPE
  const pit = suzuka.CIRCUIT.pit
  const L = track.length
  const BIN = 5
  const bins = new Map()
  const entryEnd = pit.entryS + pit.entryRamp + 40 // the lag has decayed by here; the box switch starts later
  const exitStart = pit.exitS - pit.exitRamp
  let entryLag = 0, entryLagS = 0, exitLag = 0, exitLagS = 0
  const stops = [] // lateral of every car while pitState === 'box'
  const stopped = new Set()
  const exiting = new Map() // idx -> recovered distance (m after the box) or null while not yet within c + 2
  const rejoined = new Set() // cars whose exit lag counts (back within c + 2 after the box)
  const entryRec = new Map() // idx -> distance before the box at which lateral first reached stop − 0.5
  const recoveries = []
  const entryRecoveries = []
  let pitOverlaps = 0
  let tick = 0
  const sample = () => {
    tick++
    for (const c of race.cars) {
      if (c.pitState === 'none') {
        if (exiting.has(c.idx)) { recoveries.push(exiting.get(c.idx) ?? Infinity); exiting.delete(c.idx); rejoined.delete(c.idx) }
        if (entryRec.has(c.idx)) { entryRecoveries.push(entryRec.get(c.idx) ?? Infinity); entryRec.delete(c.idx) }
        stopped.delete(c.idx)
        continue
      }
      const s = track.wrap(c.s)
      const k = Math.floor(s / BIN) * BIN
      const b = bins.get(k)
      if (!b) bins.set(k, { s: k, min: c.lateral, max: c.lateral, n: 1 })
      else { b.min = Math.min(b.min, c.lateral); b.max = Math.max(b.max, c.lateral); b.n++ }
      const pl = track.pitLateralAt(s)
      const box = race.boxS(c)
      if (pl !== null) {
        const dEntry = forwardDelta(pit.entryS, s, L)
        if ((c.pitState === 'entering' || c.pitState === 'lane') && dEntry <= entryEnd - pit.entryS) {
          const lag = c.lateral - pl
          if (lag > entryLag) { entryLag = lag; entryLagS = s }
        }
        if (c.pitState === 'exiting') {
          const d = forwardDelta(box, s, L) < L / 2 ? forwardDelta(box, s, L) : 0 // still short of the box line: 0
          if (!exiting.has(c.idx)) exiting.set(c.idx, null)
          if (exiting.get(c.idx) === null && c.lateral >= pl - 2) { exiting.set(c.idx, d); rejoined.add(c.idx) }
          if (rejoined.has(c.idx) && forwardDelta(exitStart, s, L) <= pit.exitRamp) {
            const lag = Math.abs(c.lateral - pl)
            if (lag > exitLag) { exitLag = lag; exitLagS = s }
          }
        }
        if (c.pitState === 'entering' || c.pitState === 'lane') {
          const toBox = forwardDelta(s, box, L)
          if (!entryRec.has(c.idx)) entryRec.set(c.idx, null)
          if (entryRec.get(c.idx) === null && toBox < L / 2 && c.lateral <= E.stop + 0.5) entryRec.set(c.idx, toBox)
        }
      }
      if (c.pitState === 'box' && c.v === 0 && !stopped.has(c.idx)) { stopped.add(c.idx); stops.push(c.lateral) }
    }
    if (tick % 10 === 0) {
      const inPit = race.cars.filter((c) => c.pitState !== 'none' && c.pitState !== 'box')
      for (let i = 0; i < inPit.length; i++) for (let j = i + 1; j < inPit.length; j++) {
        const a = inPit[i], b = inPit[j]
        let d = Math.abs(a.s - b.s); d = Math.min(d, L - d)
        if (d < 4.6 && Math.abs(a.lateral - b.lateral) < 1.9) pitOverlaps++
      }
    }
  }
  const report = () => {
    const stat = (xs, over = Infinity) => {
      const sorted = [...xs].sort((a, b) => a - b)
      const finite = sorted.filter((x) => Number.isFinite(x))
      return {
        n: xs.length,
        min: sorted[0] ?? NaN,
        max: sorted[sorted.length - 1] ?? NaN,
        mean: finite.length ? finite.reduce((a, b) => a + b, 0) / finite.length : NaN,
        median: sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : NaN,
        over: sorted.filter((x) => x > over).length,
      }
    }
    const stop = stat(stops)
    const exitRecovery = stat(recoveries, 40)
    const entryRecovery = stat(entryRecoveries, Infinity)
    entryRecovery.over = entryRecoveries.filter((x) => !Number.isFinite(x)).length
    const failures = []
    if (entryLag > E.entryLag) failures.push(`entry lag ${entryLag.toFixed(2)} m > PIT_ENVELOPE.entryLag ${E.entryLag}`)
    if (exitLag > E.exitLag) failures.push(`exit lag ${exitLag.toFixed(2)} m > PIT_ENVELOPE.exitLag ${E.exitLag}`)
    if (stops.length && (Math.abs(stop.min - E.stop) > 0.5 || Math.abs(stop.max - E.stop) > 0.5)) failures.push(`stopped lateral ${stop.min.toFixed(2)}…${stop.max.toFixed(2)} outside PIT_ENVELOPE.stop ${E.stop} ± 0.5`)
    if (recoveries.length && exitRecovery.median > 40) failures.push(`median rejoin ${exitRecovery.median.toFixed(1)} m after the box > 40 m`)
    return {
      envelope: { entryLag: E.entryLag, exitLag: E.exitLag, stop: E.stop },
      entryLag, entryLagS, exitLag, exitLagS, pitOverlaps,
      stop,
      exitRecovery,
      entryRecovery,
      failures,
      bins: [...bins.values()].sort((a, b) => a.s - b.s),
    }
  }
  return { sample, report }
}

// ---------------------------------------------------------------- brake disc temperatures (--brakes)
// Print-only tuning table for app/sim/brake-thermal.ts: runs its own race (same seed, separate
// RaceSim, so nothing above changes) with the renderer's per-wheel disc model and reports, for the
// best car on laps ≥ 2, the peak front/rear temperature within ±60 m of each apex target and the
// minimum front temperature on the back straight (s 3900-4700).
if (args.includes('--brakes')) {
  const { stepDiscTemp, DISC_FRONT, DISC_REAR, GRID_DISC_C } = await import('../app/sim/brake-thermal.ts')
  const race = new RaceSim(track, SEED0, 53)
  race.totalLaps = Math.min(race.totalLaps, Math.max(LAPS, 3))
  for (const c of race.cars) c.pitLap = race.totalLaps + 5 // no stops: a clean flying-lap profile
  race.startLights()
  const car = race.cars.reduce((a, b) => (a.gripBase > b.gripBase ? a : b))
  const h = 1 / 50
  let prevV = car.v, prevBrake = 0
  const T = new Float32Array(4).fill(GRID_DISC_C)
  const peaks = targets.map((t) => ({ name: t.name, s: t.s, F: 0, R: 0 }))
  let minStraight = Infinity, minEsses = Infinity, tMax = 0
  let guard = 0
  while (race.status !== 'finished' && guard++ < 50 * 3600) {
    race.step(h)
    if (race.status !== 'racing') continue
    const dE = car.brake > 0 || prevBrake > 0 ? Math.max(0, (prevV * prevV - car.v * car.v) / 2) : 0
    prevBrake = car.brake
    prevV = car.v
    for (let w = 0; w < 4; w++) T[w] = stepDiscTemp(T[w], dE, car.v, h, w % 2 === 0 ? DISC_FRONT : DISC_REAR)
    if (car.lapsCompleted < 1) continue
    const f = Math.max(T[0], T[2]), r = Math.max(T[1], T[3])
    tMax = Math.max(tMax, f, r)
    for (const p of peaks) {
      if (Math.abs(signedDelta(p.s, car.s, track.length)) < 60) { p.F = Math.max(p.F, f); p.R = Math.max(p.R, r) }
    }
    if (car.s >= 3900 && car.s <= 4700) minStraight = Math.min(minStraight, Math.min(T[0], T[2]))
    if (car.s >= 876 && car.s <= 1314) minEsses = Math.min(minEsses, f)
  }
  log(`\nbrake disc temperatures (°C, ${car.driver.code}, laps ≥ 2; heat F ${DISC_FRONT.heat} R ${DISC_REAR.heat}, conv F ${DISC_FRONT.conv} R ${DISC_REAR.conv}):`)
  log('  name         s   peakF  peakR')
  for (const p of peaks) log(`  ${p.name.padEnd(10)} ${String(Math.round(p.s)).padStart(5)}   ${String(Math.round(p.F)).padStart(4)}   ${String(Math.round(p.R)).padStart(4)}`)
  log(`  back straight min F ${Math.round(minStraight)}, Esses min F ${Math.round(minEsses)}, overall max ${Math.round(tMax)}`)
}
