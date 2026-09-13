#!/usr/bin/env node
/**
 * Consistency checks for the facility data (app/data/suzuka-facilities*.ts).
 *
 *   node scripts/facilities-check.mjs            # warnings for the not-yet-updated pit constants
 *   node scripts/facilities-check.mjs --strict   # pit constants must already match the plan
 *
 * Checks
 *   1. STANDS: s ranges valid; no two stands on one side overlap in both s and lateral unless
 *      they declare `stackedWith`; row-1 lateral clears the local half-width + fence set-back;
 *      the seating (Σ rows × tread) fits inside the footprint.
 *   2. STANDS vs RUNOFF_ZONES: no stand front lies inside an asphalt or gravel band.
 *   3. CIRCUIT.pit: laneOffset + laneWidth/2 < wallOffset − 0.5 and laneOffset − laneWidth/2 >
 *      garageFront + 1, with the current values and with the planned ones (PIT_PLANNED);
 *      every garage block (c ± PIT_BLOCK / 2) sits inside the pit building.
 *   3b. The 2009-dossier garage row: GARAGE_CENTRES monotonic toward the final corner with
 *      steps of 19 (same 8-pit group) or 26 (across a 7 m core); PIT_BOX_STRIP = 12 × 19 + 6 × 7
 *      = 270 m; PIT_CORES are exactly the 7 m gaps between blocks; the podium sits over garage
 *      12 (±9.5 m) and the control pod ends before the strip; PIT_ENVELOPE.stop ± carHalf lies
 *      inside the work area (or, on the fallback, inside the auxiliary lane); the shutter line
 *      is ≥ 2.8 m behind the OSM front (the terrace overhang).
 *   4. GARAGE_ORDER ⊂ TEAM_ORDER and the same size.
 *   5. Track.enScale equals an independent re-computation of the centreline pipeline, and the
 *      OSM raceway loop maps onto the app centreline within the registration tolerance.
 *   6. Every OSM stand id referenced by the spec / mapping exists in the extract; every id a
 *      BUILDINGS / GROUND_AREAS / UNDERPASSES (and later infield table) row points at exists too
 *      (an error under --strict).
 *   A10. Every stand's front is screened by a fence-carrying BARRIERS run (world space, ≥ 95 %).
 *   A11. SCREENS / SIGNS / LEADER_TOWER clear the road, the stand footprints and the pit lane;
 *        boards only on concrete runs; UNDERPASSES reference 'road' ways.
 *   16. ops-check O1–O12 (I phase): the static ops layer (app/data/ops-spec.ts), the marshal
 *       posts, TV cameras, infield tables against PIT_ENVELOPE, the chase lens, the grid, the
 *       barrier lines, the building footprints and the circuit ring (see the section header).
 *       `--envelope <json>` (written by `pnpm sim -- --envelope out.json`) replaces the analytic
 *       pit keep-out with the measured 5 m bins outside the box strip.
 */
import './ts-hooks.mjs'

const { Track, signedDelta } = await import('../app/sim/track.ts')
const { CIRCUIT, CENTERLINE_EN } = await import('../app/data/suzuka.ts')
const { TEAM_ORDER } = await import('../app/data/drivers.ts')
const spec = await import('../app/data/suzuka-facilities-spec.ts')
const osm = await import('../app/data/suzuka-facilities.ts')

const STRICT = process.argv.includes('--strict')
const ENVELOPE_ARG = (() => { const i = process.argv.indexOf('--envelope'); return i >= 0 ? process.argv[i + 1] ?? null : null })()
const FENCE_SETBACK = 12 // m between the asphalt edge and the first seat row (fence + walkway)
const RACEWAY_TOL = 5 // m — OSM raceway ways sit within ±4 m of the app centreline

const track = new Track()
const L = track.length
const wrap = (s) => ((s % L) + L) % L
const arcLen = (a, b) => wrap(b - a)
const inArc = (s, [a, b]) => arcLen(a, s) <= arcLen(a, b)
const arcsOverlap = (r1, r2) => inArc(r1[0], r2) || inArc(r1[1], r2) || inArc(r2[0], r1) || inArc(r2[1], r1)
const at = (v, s, range) => spec.alongAt(v, s, range)

const errors = []
const warnings = []
const fail = (msg, soft = false) => (soft ? warnings : errors).push(msg)
const fmt = (n, d = 1) => Number(n).toFixed(d)

// ---------------------------------------------------------------- 1. stands
const rows = []
for (const st of spec.STANDS) {
  const [s0, s1] = st.sRange
  const len = arcLen(s0, s1)
  const soft = (st.unverified ?? []).some((u) => /front clearance|footprint|position/.test(u))
  if (s0 < 0 || s0 >= L || s1 < 0 || s1 >= L || len <= 0 || len > L / 2) fail(`${st.id}: invalid sRange ${s0}→${s1}`)
  let minClear = Infinity
  let minFront = Infinity
  let maxFront = -Infinity
  let backMin = Infinity
  for (let d = 0; d <= len; d += 2) {
    const s = wrap(s0 + d)
    const front = Math.abs(at(st.lateralFront, s, st.sRange))
    const back = Math.abs(at(st.lateralBack, s, st.sRange))
    const clear = front - (track.halfWidthAt(s) + FENCE_SETBACK)
    if (clear < minClear) minClear = clear
    if (front < minFront) minFront = front
    if (front > maxFront) maxFront = front
    if (back - front < backMin) backMin = back - front
    if (back < front) fail(`${st.id}: back (${fmt(back)}) inside front (${fmt(front)}) at s ${fmt(s, 0)}`)
  }
  if (minClear < 0) fail(`${st.id}: row 1 is ${fmt(-minClear)} m inside the fence line (hw + ${FENCE_SETBACK})`, soft)
  const depth = spec.seatingDepth(st)
  // seating must fit the footprint: at each s, the tiers stacked behind the stand front (no own
  // lateralFront, active at this s) need (rows − 1)·tread each plus the aisles between them; the
  // tapered polygon ends are ignored by requiring the shortfall on more than a quarter of the samples
  let short = 0
  let samples = 0
  const shortfalls = []
  for (let d = 0; d <= len; d += 2) {
    const s = wrap(s0 + d)
    const active = st.tiers.filter((t) => t.lateralFront === undefined && (!t.sRange || inArc(s, t.sRange)))
    if (!active.length) continue
    const need = active.reduce((a, t, i) => a + (t.rows - 1) * t.tread + (i < active.length - 1 ? (t.aisleAfter ?? t.tread) : 0), 0)
    const have = Math.abs(at(st.lateralBack, s, st.sRange)) - Math.abs(at(st.lateralFront, s, st.sRange))
    samples++
    if (need > have + 0.5) {
      short++
      shortfalls.push(need - have)
    }
  }
  if (samples && short / samples > 0.25) {
    const median = shortfalls.sort((a, b) => a - b)[Math.floor(shortfalls.length / 2)]
    fail(`${st.id}: seating is typically ${fmt(median)} m deeper than the OSM footprint on ${Math.round((100 * short) / samples)} % of its length`, true)
  }
  for (const t of st.tiers) {
    if (t.sRange && !(inArc(t.sRange[0], st.sRange) && inArc(t.sRange[1], st.sRange))) fail(`${st.id}/${t.id}: tier sRange outside the stand`)
  }
  rows.push({ id: st.id, side: st.side, s: `${s0}→${s1}`, front: `${fmt(minFront)}..${fmt(maxFront)}`, clear: fmt(minClear), depth: fmt(depth), rows: st.tiers.reduce((a, t) => a + t.rows, 0), struct: st.structure, osm: st.osmWays.length })
}

// overlaps: same side, s overlap and lateral overlap, not declared stacked
for (let i = 0; i < spec.STANDS.length; i++) {
  for (let j = i + 1; j < spec.STANDS.length; j++) {
    const a = spec.STANDS[i]
    const b = spec.STANDS[j]
    if (a.side !== b.side || !arcsOverlap(a.sRange, b.sRange)) continue
    if (a.stackedWith?.includes(b.id) || b.stackedWith?.includes(a.id)) continue
    // sample the common s and compare lateral bands
    const [s0, s1] = a.sRange
    let hit = null
    for (let d = 0; d <= arcLen(s0, s1); d += 2) {
      const s = wrap(s0 + d)
      if (!inArc(s, b.sRange)) continue
      const af = Math.abs(at(a.lateralFront, s, a.sRange)), ab = Math.abs(at(a.lateralBack, s, a.sRange))
      const bf = Math.abs(at(b.lateralFront, s, b.sRange)), bb = Math.abs(at(b.lateralBack, s, b.sRange))
      if (af < bb && bf < ab) {
        hit = { s, a: [af, ab], b: [bf, bb] }
        break
      }
    }
    if (hit) fail(`${a.id} and ${b.id} overlap at s ${fmt(hit.s, 0)} (${fmt(hit.a[0])}..${fmt(hit.a[1])} vs ${fmt(hit.b[0])}..${fmt(hit.b[1])})`)
  }
}

// ---------------------------------------------------------------- 2. stands vs run-off
for (const st of spec.STANDS) {
  for (const z of spec.RUNOFF_ZONES) {
    if (!arcsOverlap(st.sRange, z.sRange)) continue
    const band = st.side === 1 ? z.left : z.right
    const outer = Math.max(band.asphalt?.[1] ?? 0, band.gravel?.[1] ?? 0)
    if (outer === 0) continue
    const [s0, s1] = st.sRange
    for (let d = 0; d <= arcLen(s0, s1); d += 2) {
      const s = wrap(s0 + d)
      if (!inArc(s, z.sRange)) continue
      const front = Math.abs(at(st.lateralFront, s, st.sRange))
      if (front < outer) {
        const which = band.gravel && front < band.gravel[1] && front >= band.gravel[0] ? 'gravel' : 'asphalt'
        fail(`${st.id}: row 1 at ${fmt(front)} m is inside the ${which} band of "${z.name}" (to ${outer} m) at s ${fmt(s, 0)}`, z.source === 'photo')
        break
      }
    }
  }
}
// zones must not overlap each other
for (let i = 0; i < spec.RUNOFF_ZONES.length; i++) {
  for (let j = i + 1; j < spec.RUNOFF_ZONES.length; j++) {
    const a = spec.RUNOFF_ZONES[i].sRange, b = spec.RUNOFF_ZONES[j].sRange
    const overlap = Math.min(arcLen(a[0], b[1]), arcLen(b[0], a[1]))
    if (inArc(a[0], b) && inArc(b[0], a) && overlap > 0 && a[0] !== b[1] && b[0] !== a[1]) fail(`run-off zones "${spec.RUNOFF_ZONES[i].name}" and "${spec.RUNOFF_ZONES[j].name}" overlap`)
  }
}

// ---------------------------------------------------------------- 3. pit constants
const pit = CIRCUIT.pit
const planned = spec.PIT_PLANNED
const pitRule = (p) => ({
  fastLaneClear: p.laneOffset + p.laneWidth / 2 < p.wallOffset - 0.5,
  workingLaneClear: p.laneOffset - p.laneWidth / 2 > p.garageFront + 1,
})
const cur = pitRule(pit)
const pln = pitRule({ ...pit, ...planned })
const pitMatches = pit.garageFront === planned.garageFront && pit.boxSpacing === planned.boxSpacing && pit.laneOffset === planned.laneOffset
console.log('pit constants            current   planned')
for (const k of ['garageFront', 'boxSpacing', 'laneOffset', 'laneWidth', 'wallOffset']) console.log(`  ${k.padEnd(22)} ${String(pit[k]).padStart(8)}  ${String(planned[k]).padStart(8)}${pit[k] !== planned[k] ? '  ≠' : ''}`)
console.log(`  laneOffset + w/2 < wall − 0.5   ${cur.fastLaneClear ? 'ok ' : 'NG '}       ${pln.fastLaneClear ? 'ok' : 'NG'}`)
console.log(`  laneOffset − w/2 > garage + 1   ${cur.workingLaneClear ? 'ok ' : 'NG '}       ${pln.workingLaneClear ? 'ok' : 'NG'}`)
if (!pln.fastLaneClear || !pln.workingLaneClear) fail('planned pit constants violate the lane rules')
if (!pitMatches) fail('CIRCUIT.pit does not match PIT_PLANNED yet (phase 4 updates suzuka.ts)', !STRICT)
else if (!cur.fastLaneClear || !cur.workingLaneClear) fail('CIRCUIT.pit violates the lane rules')
if (!('boxStartS' in pit) || Math.abs(wrap(pit.boxStartS - spec.garageS(0))) > 0.1 && Math.abs(wrap(spec.garageS(0) - pit.boxStartS)) > 0.1) {
  fail(`CIRCUIT.pit.boxStartS (${pit.boxStartS}) ≠ garageS(0) = ${fmt(spec.garageS(0))} (garage 1 is at the T1 end)`, !STRICT)
}
// garages inside the building
const bld = spec.PIT_BUILDING.sRange
for (let g = 0; g < spec.PIT_GARAGE_COUNT; g++) {
  const c = spec.garageS(g)
  if (!inArc(wrap(c - spec.PIT_BLOCK / 2), bld) || !inArc(wrap(c + spec.PIT_BLOCK / 2), bld)) fail(`garage ${g + 1} (s ${fmt(c)}) is outside the pit building ${bld[0]}→${bld[1]}`)
}
if (osm.OSM_PIT_BUILDING) {
  const f = osm.OSM_PIT_BUILDING
  if (Math.abs(f.lateral[1] - spec.PIT_GARAGE_FRONT) > 1.5) fail(`PIT_GARAGE_FRONT ${spec.PIT_GARAGE_FRONT} vs OSM pit-lane face ${f.lateral[1]}`)
}

// ---------------------------------------------------------------- 3b. the 2009 garage row
{
  const G = spec.GARAGE_CENTRES
  const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol
  if (G.length !== spec.PIT_GARAGE_COUNT) fail(`GARAGE_CENTRES has ${G.length} blocks, PIT_GARAGE_COUNT ${spec.PIT_GARAGE_COUNT}`)
  for (let i = 0; i < G.length; i++) if (!near(spec.garageS(i), G[i])) fail(`garageS(${i}) ${spec.garageS(i)} ≠ GARAGE_CENTRES[${i}] ${G[i]}`)
  // monotonic toward the final corner (wrapping through s = 0), steps of one block or one block + core
  const steps = []
  for (let i = 1; i < G.length; i++) {
    const d = arcLen(G[i], G[i - 1])
    steps.push(d)
    if (d <= 0 || d > L / 2) fail(`GARAGE_CENTRES[${i}] ${G[i]} is not toward the final corner from [${i - 1}] ${G[i - 1]}`)
    else if (!near(d, spec.PIT_BLOCK) && !near(d, spec.PIT_BLOCK + spec.PIT_CORE)) fail(`GARAGE_CENTRES step ${i - 1}→${i} is ${fmt(d, 2)} m, not ${spec.PIT_BLOCK} or ${spec.PIT_BLOCK + spec.PIT_CORE}`)
  }
  const strip = arcLen(spec.PIT_BOX_STRIP[0], spec.PIT_BOX_STRIP[1])
  const expected = spec.PIT_GARAGE_COUNT * spec.PIT_BLOCK + spec.PIT_CORES.length * spec.PIT_CORE
  if (!near(strip, expected, 0.5)) fail(`PIT_BOX_STRIP is ${fmt(strip, 2)} m, expected ${expected} (${spec.PIT_GARAGE_COUNT} × ${spec.PIT_BLOCK} + ${spec.PIT_CORES.length} × ${spec.PIT_CORE})`)
  if (!near(spec.PIT_BOX * 4, spec.PIT_BLOCK)) fail(`PIT_BLOCK ${spec.PIT_BLOCK} ≠ 4 × PIT_BOX ${spec.PIT_BOX}`)
  // the cores are exactly the 7 m gaps between adjacent blocks
  const gaps = []
  for (let i = 1; i < G.length; i++) if (near(steps[i - 1], spec.PIT_BLOCK + spec.PIT_CORE)) gaps.push([wrap(G[i] + spec.PIT_BLOCK / 2), wrap(G[i - 1] - spec.PIT_BLOCK / 2)])
  if (gaps.length !== spec.PIT_CORES.length) fail(`PIT_CORES has ${spec.PIT_CORES.length} cores, the garage row has ${gaps.length} gaps`)
  for (const core of spec.PIT_CORES) {
    if (!near(arcLen(core[0], core[1]), spec.PIT_CORE)) fail(`PIT_CORE ${core[0]}→${core[1]} is ${fmt(arcLen(core[0], core[1]))} m, not ${spec.PIT_CORE}`)
    if (!gaps.some(([a, b]) => near(a, core[0]) && near(b, core[1]))) fail(`PIT_CORE ${core[0]}→${core[1]} is not a gap between two garage blocks`)
  }
  // podium over the final-corner block, the control pod before the strip (the v2 rows of the
  // 2009 dossier; the v1 keys the v1 builder still reads are deleted in I1-b)
  const pod = spec.PIT_BUILDING.v2 ?? spec.PIT_BUILDING
  const podiumOff = signedDelta(spec.garageS(spec.PIT_GARAGE_COUNT - 1), pod.podium.s, L)
  if (Math.abs(podiumOff) > 9.5) fail(`PIT_BUILDING podium.s ${pod.podium.s} is ${fmt(podiumOff)} m from garage 12 (${spec.garageS(spec.PIT_GARAGE_COUNT - 1)}); the dossier podium is over pits 45–47`)
  if (arcLen(pod.controlPod.sRange[1], spec.PIT_BOX_STRIP[0]) > L / 2) fail(`PIT_BUILDING controlPod ends at ${pod.controlPod.sRange[1]}, past the start of the garage row ${spec.PIT_BOX_STRIP[0]}`)
  // the v2 section: shutter / garage back / floors / canopy consistent with PIT_PLANNED and each other
  if (spec.PIT_BUILDING.v2) {
    const v = spec.PIT_BUILDING.v2
    if (v.shutter !== planned.shutter) fail(`PIT_BUILDING.v2.shutter ${v.shutter} ≠ PIT_PLANNED.shutter ${planned.shutter}`)
    if (Math.abs(v.garageBack - (v.shutter - v.garage.depth)) > 1e-6) fail(`PIT_BUILDING.v2.garageBack ${v.garageBack} ≠ shutter − garage.depth ${v.shutter - v.garage.depth}`)
    if (v.rearCanopy.from !== v.garageBack || v.rearCanopy.to < spec.PIT_BUILDING.back) fail(`PIT_BUILDING.v2.rearCanopy ${v.rearCanopy.from}→${v.rearCanopy.to} must run from the garage back to inside the paddock face ${spec.PIT_BUILDING.back}`)
    if (!(v.floors[0] < v.floors[1] && v.floors[1] < v.floors[2])) fail(`PIT_BUILDING.v2.floors ${v.floors.join(', ')} are not ascending`)
    if (v.garage.boxPitch !== spec.PIT_BOX) fail(`PIT_BUILDING.v2.garage.boxPitch ${v.garage.boxPitch} ≠ PIT_BOX ${spec.PIT_BOX}`)
    if (v.garage.door.w + v.garage.pier > spec.PIT_BOX) fail(`PIT_BUILDING.v2.garage door ${v.garage.door.w} + pier ${v.garage.pier} exceed the pit pitch ${spec.PIT_BOX}`)
    // the fascia band hangs on the drip line, 3.2 m in front of the shutters: it may start below the door head, it ends at the 2F slab
    if (v.garage.fascia[0] >= v.garage.fascia[1] || v.garage.fascia[1] !== v.floors[1]) fail(`PIT_BUILDING.v2.garage.fascia [${v.garage.fascia.join(', ')}] must end at the 2F floor (${v.floors[1]})`)
    for (let i = 1; i < v.canopy.profile.length; i++) if (v.canopy.profile[i][0] <= v.canopy.profile[i - 1][0]) fail(`PIT_BUILDING.v2.canopy.profile is not ordered back → front at ${i}`)
    const nStairs = v.stairTowers.s.length
    if (nStairs !== spec.PIT_CORES.length + 1) fail(`PIT_BUILDING.v2.stairTowers has ${nStairs} towers, expected ${spec.PIT_CORES.length} cores + the control-tower core`)
    for (const core of spec.PIT_CORES) if (!v.stairTowers.s.some((sc) => Math.abs(signedDelta(sc, (core[0] + core[1]) / 2, L)) < 0.6)) fail(`PIT_BUILDING.v2.stairTowers: no tower at core ${core[0]}→${core[1]}`)
    if (arcLen(v.controlPod.sRange[1], v.mediaSection.sRange[0]) !== 0 || arcLen(v.mediaSection.sRange[1], spec.PIT_BOX_STRIP[0]) !== 0) fail(`PIT_BUILDING.v2 controlPod ${v.controlPod.sRange.join('→')} / mediaSection ${v.mediaSection.sRange.join('→')} must abut and end at the garage row ${spec.PIT_BOX_STRIP[0]}`)
    if (arcLen(spec.PIT_BOX_STRIP[1], v.t1Nose.info.sRange[0]) !== 0 || arcLen(v.t1Nose.info.sRange[1], v.t1Nose.sRange[0]) !== 0) fail(`PIT_BUILDING.v2 t1Nose ${v.t1Nose.info.sRange.join('→')} / ${v.t1Nose.sRange.join('→')} must follow the garage row ${spec.PIT_BOX_STRIP[1]}`)
  }
  // the stop line: the car (stop ± carHalf) inside the work area, or on the fallback inside the auxiliary lane
  const E = spec.PIT_ENVELOPE
  const carL = [E.stop - E.carHalf, E.stop + E.carHalf]
  const inWork = carL[0] >= planned.shutter + 0.6 && carL[1] <= E.workArea[1]
  const auxLane = [E.lanes[0], -16.05]
  const inAux = carL[0] >= auxLane[0] && carL[1] <= auxLane[1]
  if (!inWork && !inAux) fail(`PIT_ENVELOPE.stop ${E.stop} ± ${E.carHalf} is neither inside the work area [${planned.shutter + 0.6}, ${E.workArea[1]}] nor the auxiliary lane [${auxLane.join(', ')}]`)
  if (!near(E.workArea[0], planned.shutter)) fail(`PIT_ENVELOPE.workArea starts at ${E.workArea[0]}, the shutter line is ${planned.shutter}`)
  if (planned.shutter > planned.garageFront - 2.8) fail(`PIT_PLANNED.shutter ${planned.shutter} is less than 2.8 m behind the front ${planned.garageFront} (the 2F terrace overhang)`)
  console.log(`garage row: ${G.length} blocks of ${spec.PIT_BLOCK} m, ${spec.PIT_CORES.length} cores of ${spec.PIT_CORE} m, strip ${fmt(strip)} m ${spec.PIT_BOX_STRIP[0]}→${spec.PIT_BOX_STRIP[1]}; stop ${E.stop} ${inWork ? 'in the work area' : 'in the auxiliary lane (fallback)'}; podium ${fmt(podiumOff)} m from garage 12`)
}

// ---------------------------------------------------------------- 4. garage order
if (spec.GARAGE_ORDER.length !== TEAM_ORDER.length) fail(`GARAGE_ORDER has ${spec.GARAGE_ORDER.length} teams, TEAM_ORDER ${TEAM_ORDER.length}`)
for (const t of spec.GARAGE_ORDER) if (!TEAM_ORDER.includes(t)) fail(`GARAGE_ORDER team "${t}" is not in TEAM_ORDER`)
if (new Set(spec.GARAGE_ORDER).size !== spec.GARAGE_ORDER.length) fail('GARAGE_ORDER has duplicates')

// ---------------------------------------------------------------- 5. enScale
// independent re-computation of track.ts:164-167 (densify → Gaussian smooth → decimate →
// centripetal Catmull-Rom → official length / curve length)
const THREE = await import('three')
function smooth(raw, spacing, sigma, outSpacing) {
  const dense = []
  const m = raw.length
  for (let i = 0; i < m; i++) {
    const a = raw[i], b = raw[(i + 1) % m]
    if (i === m - 1 && Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6) break
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    const n = Math.max(1, Math.ceil(len / spacing))
    for (let k = 0; k < n; k++) dense.push([a[0] + (b[0] - a[0]) * (k / n), a[1] + (b[1] - a[1]) * (k / n)])
  }
  const n = dense.length
  const half = Math.ceil((3 * sigma) / spacing)
  const w = []
  for (let k = -half; k <= half; k++) w.push(Math.exp(-0.5 * ((k * spacing) / sigma) ** 2))
  const ws = w.reduce((a, b) => a + b, 0)
  const out = []
  const stride = Math.max(1, Math.round(outSpacing / spacing))
  for (let i = 0; i < n; i += stride) {
    let x = 0, y = 0
    for (let k = -half; k <= half; k++) {
      const p = dense[(i + k + n) % n]
      x += p[0] * w[k + half]
      y += p[1] * w[k + half]
    }
    out.push([x / ws, y / ws])
  }
  return out
}
const pts = smooth(CENTERLINE_EN, 4, 8, 8).map(([e, n]) => new THREE.Vector3(e, 0, -n))
const c0 = new THREE.CatmullRomCurve3(pts, true, 'centripetal', 0.5)
c0.arcLengthDivisions = 6000
const enScale = CIRCUIT.officialLength / c0.getLength()
console.log(`\nenScale  track ${track.enScale.toFixed(9)}  recomputed ${enScale.toFixed(9)}  Δ ${Math.abs(enScale - track.enScale).toExponential(2)}`)
if (Math.abs(enScale - track.enScale) > 1e-6) fail(`enScale mismatch: ${track.enScale} vs ${enScale}`)
const v = new THREE.Vector3()
track.enToWorld(100, 50, v)
if (Math.abs(v.x - 100 * track.enScale) > 1e-9 || Math.abs(v.z + 50 * track.enScale) > 1e-9 || v.y !== 0) fail('enToWorld does not return (e·enScale, 0, −n·enScale)')

// OSM raceway loop vs app centreline: re-project every raceway vertex through enToWorld and
// measure its distance to the nearest centreline sample (≤ 1 m sampling error at ds = 2). A way
// belongs to the GP loop when ≥ 90 % of its vertices are within tolerance (the West/South course
// links share a few nodes with it); the loop must then be covered end to end.
const nearestD = (x, z) => {
  let best = Infinity
  track.forEachSampleNear(x, z, 60, (i, d2) => {
    if (d2 < best) best = d2
  })
  return Math.sqrt(best)
}
let raceMax = 0
let raceCount = 0
const segments = [] // [ax, az, bx, bz] of the GP-loop ways, for the reverse (coverage) test
for (const f of osm.OSM_RACEWAY) {
  const ds = f.en.map(([e, n]) => nearestD(e * track.enScale, -n * track.enScale))
  const inside = ds.filter((d) => d <= RACEWAY_TOL + 1).length / ds.length
  if (inside < 0.9) continue
  raceCount++
  raceMax = Math.max(raceMax, ...ds)
  const pts = f.en.map(([e, n]) => [e * track.enScale, -n * track.enScale])
  for (let i = 0; i + 1 < pts.length; i++) segments.push([...pts[i], ...pts[i + 1]])
}
// every centreline sample must have a GP-loop raceway segment within tolerance (OSM nodes on the
// straights are 100 m apart, so test against segments, not vertices)
let coveredN = 0
for (let i = 0; i < track.n; i++) {
  const x = track.px[i], z = track.pz[i]
  let best = Infinity
  for (const [ax, az, bx, bz] of segments) {
    const ux = bx - ax, uz = bz - az
    const l2 = ux * ux + uz * uz || 1
    const t = Math.max(0, Math.min(1, ((x - ax) * ux + (z - az) * uz) / l2))
    const dx = x - (ax + ux * t), dz = z - (az + uz * t)
    const d2 = dx * dx + dz * dz
    if (d2 < best) best = d2
  }
  if (Math.sqrt(best) <= RACEWAY_TOL + 1) coveredN++
}
const coverage = coveredN / track.n
console.log(`raceway  ${raceCount} OSM ways on the GP loop, max distance ${fmt(raceMax)} m (tolerance ${RACEWAY_TOL} + 1 sampling), lap coverage ${(100 * coverage).toFixed(1)} %`)
if (raceCount < 10) fail(`only ${raceCount} OSM raceway ways map onto the centreline`)
if (raceMax > RACEWAY_TOL + 1) fail(`OSM raceway drifts ${fmt(raceMax)} m from the app centreline — projection or enScale is off`)
if (coverage < 0.95) fail(`OSM raceway covers only ${(100 * coverage).toFixed(1)} % of the lap`)

// ---------------------------------------------------------------- 6. OSM ids
for (const [stand, ways] of Object.entries(osm.OSM_STAND_WAYS)) {
  for (const id of ways) if (!osm.osmFeature(id)) fail(`OSM_STAND_WAYS ${stand}: way ${id} missing from OSM_FEATURES`)
  if (!spec.standById(stand)) fail(`OSM_STAND_WAYS ${stand} has no StandDef`, true)
}
for (const st of spec.STANDS) {
  for (const id of st.osmWays) {
    const f = osm.osmFeature(id)
    if (!f) {
      fail(`${st.id}: OSM way ${id} missing from OSM_FEATURES`)
      continue
    }
    if (f.role !== 'stand') fail(`${st.id}: OSM way ${id} has role "${f.role}"`, true)
    if (!f.fold && f.side !== 0 && f.side !== st.side) fail(`${st.id}: side ${st.side} but OSM way ${id} lies on side ${f.side}`)
  }
}
for (const [name, id] of [['pit building', spec.PIT_BUILDING.osmWay], ['Ferris wheel', 184107083], ['leader tower', 469636517], ...spec.WATER.map((w) => [w.name, w.osmWay])]) {
  if (!osm.osmFeature(id)) fail(`${name}: OSM way ${id} missing from OSM_FEATURES`, true)
}
/**
 * Every OSM id a spec row points at must be in the extract — an error under --strict, so a row
 * written against a way the generator never fetched fails `pnpm check` instead of silently
 * building nothing (`build-facilities.mjs --add-ways-from … --role …` splices it in offline).
 * Tables: BUILDINGS (osmWay), GROUND_AREAS (`osm` rings, `way` ribbons, ring nodes with `way`),
 * UNDERPASSES (osmWay), and — when the infield tables land — PADDOCK_BUILDINGS,
 * INFIELD_FACILITIES, CUTS and FOOTBRIDGES, read through `osmRefs`: any `osmWay` / `osm` / `way`
 * field, a number or a list of numbers.
 */
const osmRefs = (row) => {
  const ids = []
  const take = (v) => (Array.isArray(v) ? ids.push(...v.filter((n) => typeof n === 'number')) : typeof v === 'number' && ids.push(v))
  for (const k of ['osmWay', 'osm', 'way']) take(row?.[k])
  if (row?.footprint) for (const k of ['osm', 'way']) take(row.footprint[k])
  for (const w of row?.footprint?.ways ?? []) take(w?.id)
  for (const node of row?.footprint?.ring ?? []) take(node?.way)
  return ids
}
const ID_TABLES = [
  ['BUILDINGS', (b) => b.id],
  ['GROUND_AREAS', (a) => a.name],
  ['UNDERPASSES', (u) => u.name],
  ['PADDOCK_BUILDINGS', (b) => b.id ?? b.name],
  ['INFIELD_FACILITIES', (f) => f.id ?? f.name],
  ['CUTS', (c) => c.id ?? c.name],
  ['FOOTBRIDGES', (f) => f.id ?? f.name],
]
for (const [table, label] of ID_TABLES) {
  for (const row of spec[table] ?? []) {
    for (const id of osmRefs(row)) if (!osm.osmFeature(id)) fail(`${table} "${label(row)}": OSM way ${id} missing from OSM_FEATURES (build-facilities.mjs --add-ways-from <cache> --role <role>:${id})`, !STRICT)
  }
}
const fw = osm.OSM_FERRIS_WHEEL
if (fw && (Math.abs(fw.centroid[0] - spec.FERRIS_WHEEL.s) > 3 || Math.abs(fw.centroid[1] - spec.FERRIS_WHEEL.lateral) > 1)) fail(`FERRIS_WHEEL (${spec.FERRIS_WHEEL.s}, ${spec.FERRIS_WHEEL.lateral}) vs OSM centroid ${fw.centroid}`)
const lt = osm.OSM_LEADER_TOWER
if (lt && (Math.abs(lt.centroid[0] - spec.LEADER_TOWER.s) > 2 || Math.abs(lt.centroid[1] - spec.LEADER_TOWER.lateral) > 1)) fail(`LEADER_TOWER vs OSM centroid ${lt.centroid}`)

// ---------------------------------------------------------------- 7. barrier runs
const bar = await import('../app/data/suzuka-barriers-spec.ts')
const trackside = await import('../app/three/trackside.ts')
const v3 = new THREE.Vector3()
const RUN_CLEAR = 0.4 // m beyond the half-width a barrier vertex must stay
/** stretches of road other than the run's own that come within `r` of (x, z) */
function otherRoad(x, z, sRange, ownY, r = 45) {
  const own = (s) => {
    const d = wrap(s - sRange[0])
    return d <= arcLen(sRange[0], sRange[1]) + 60 || d >= L - 60
  }
  let hit = null
  track.forEachSampleNear(x, z, r, (i, d2) => {
    const s = i * track.ds
    if (own(s)) return
    // the crossover puts two roads on top of each other: 3 m of separation is not a crossing
    if (Math.abs(track.py[i] - ownY) > 3) return
    const lat = Math.abs((x - track.px[i]) * track.nx[i] + (z - track.pz[i]) * track.nz[i])
    const clear = track.halfWidthAt(s) + 1.5
    if (lat < clear && (!hit || d2 < hit.d2)) hit = { s, lat, d2 }
  })
  return hit
}
/**
 * The OSM footprint of every grandstand, in world XZ. Used for the projection-free
 * barrier-inside-a-stand test: a stand in the figure-8 fold (Q2) has no single lateral(s), so the
 * (s, lateral) test below is blind exactly where it is needed most.
 */
const standFootprints = []
for (const st of spec.STANDS) {
  for (const id of st.osmWays ?? []) {
    const f = osm.OSM_FEATURES.find((o) => o.id === id)
    if (!f?.closed) continue
    standFootprints.push({ id: st.id, ring: f.en.map(([e, n]) => ({ x: e * track.enScale, z: -n * track.enScale })) })
  }
}
/**
 * The GROUND_AREAS rows that are outlines (ring / osm footprints), in the shape patchOutline
 * takes — the band, way and disc footprints are resolved by ground-plan.ts and have no ring to lint.
 */
const areaPatches = spec.GROUND_AREAS.flatMap((a) => ('ring' in a.footprint || 'osm' in a.footprint ? [{ name: a.name, kind: a.kind, layer: a.layer ?? 0, ...a.footprint }] : []))
/** the paved aprons, so a barrier cannot be planted in the middle of one */
const apronRings = areaPatches.filter((p) => p.kind === 'asphaltArea').map((p) => ({ name: p.name, ring: trackside.patchOutline(track, p, 2) }))
function pavedApronAt(x, z) {
  for (const { name, ring } of apronRings) {
    let inside = false
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j]
      if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside
    }
    if (inside) return name
  }
  return null
}
function standFootprintAt(x, z) {
  for (const { id, ring } of standFootprints) {
    let inside = false
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j]
      if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside
    }
    if (inside) return id
  }
  return null
}
const seenRunIds = new Set()
const runRows = []
for (const run of bar.BARRIERS) {
  if (seenRunIds.has(run.id)) fail(`BARRIERS: duplicate id "${run.id}"`)
  seenRunIds.add(run.id)
  const [s0, s1] = run.sRange
  if (s0 < 0 || s0 >= L || s1 < 0 || s1 >= L || arcLen(s0, s1) <= 0 || arcLen(s0, s1) > L / 2) fail(`${run.id}: invalid sRange ${s0}→${s1}`)
  for (const id of run.source.osm ?? []) if (!osm.osmFeature(id)) fail(`${run.id}: OSM way ${id} missing from OSM_FEATURES`)
  const soft = !!run.unverified?.length
  const r = trackside.resolveLine(track, run.source, run.sRange, run.side, run.minGap ?? 0.6)
  if (r.samples.length < 2) {
    fail(`${run.id}: resolved to ${r.samples.length} sample(s) — the source produced no line`)
    continue
  }
  // coverage: the samples must span the run (no 30 m holes, ends within 25 m)
  let prev = null
  let maxGap = 0
  let gapAt = 0
  for (const [s, lat] of r.samples) {
    // a long straight run needs no samples in between: only a gap the shape changes across is a hole
    if (prev !== null && wrap(s - prev[0]) > maxGap && Math.abs(lat - prev[1]) > 3) {
      maxGap = wrap(s - prev[0])
      gapAt = prev[0]
    }
    prev = [s, lat]
  }
  const startGap = wrap(r.samples[0][0] - s0)
  const endGap = wrap(s1 - r.samples[r.samples.length - 1][0])
  // a hole matters only where an OSM way was supposed to supply the shape; hand samples are sparse by design
  if (maxGap > 30) fail(`${run.id}: ${fmt(maxGap, 0)} m unsampled at s ${fmt(gapAt, 0)} where the line bends (the source does not cover it)`, soft)
  if (startGap > 25 && startGap < L / 2) fail(`${run.id}: starts ${fmt(startGap, 0)} m after sRange[0]`, soft)
  if (endGap > 25 && endGap < L / 2) fail(`${run.id}: ends ${fmt(endGap, 0)} m before sRange[1]`, soft)
  // geometry checks along the resolved line
  let minClear = Infinity, worstOther = null, standHit = null, maxStep = 0
  const len = arcLen(s0, s1)
  let prevLat = null
  let standWorldHit = null
  let apronHit = null
  const v = new THREE.Vector3()
  for (let d = 0; d <= len; d += 2) {
    const s = wrap(s0 + d)
    const lat = r.lat(s)
    if (Math.sign(lat) !== run.side) fail(`${run.id}: lateral ${fmt(lat)} is on the wrong side at s ${fmt(s, 0)}`)
    const clear = Math.abs(lat) - track.halfWidthAt(s)
    if (clear < minClear) minClear = clear
    if (prevLat !== null) maxStep = Math.max(maxStep, Math.abs(lat - prevLat))
    prevLat = lat
    track.pointAt(s, lat, v, 0)
    const o = otherRoad(v.x, v.z, run.sRange, v.y)
    if (o && (!worstOther || o.lat < worstOther.lat)) worstOther = { ...o, s }
    // WORLD-space stand test: the (s, lateral) one below cannot see Q2, whose bars sit where the
    // perpendicular sweeps back and forth, so its footprint has no single lateral(s). This one is
    // projection-free — it just asks whether the barrier is standing inside a mapped grandstand.
    const inside = standFootprintAt(v.x, v.z)
    if (inside && !standWorldHit) standWorldHit = { id: inside, s, x: v.x, z: v.z }
    const paved = pavedApronAt(v.x, v.z)
    if (paved) apronHit = (apronHit ?? 0) + 2
    for (const st of spec.STANDS) {
      // Q2's (s, lateral) is nominal (its bars sit in the figure-8 fold and are placed from EN)
      if (st.side !== run.side || !inArc(s, st.sRange) || st.unverified?.some((u) => /fold/.test(u))) continue
      const front = Math.abs(at(st.lateralFront, s, st.sRange))
      const back = Math.abs(at(st.lateralBack, s, st.sRange))
      if (Math.abs(lat) > front + 0.5 && Math.abs(lat) < back + 1) standHit = { id: st.id, s, lat, front, back }
    }
  }
  if (minClear < RUN_CLEAR) fail(`${run.id}: comes ${fmt(RUN_CLEAR - minClear)} m inside the road edge`)
  if (worstOther) fail(`${run.id}: crosses another stretch of road at s ${fmt(worstOther.s, 0)} (that road's s ${fmt(worstOther.s2 ?? worstOther.s, 0)}, lateral ${fmt(worstOther.lat)})`)
  if (standHit) fail(`${run.id}: runs inside stand ${standHit.id} at s ${fmt(standHit.s, 0)} (lateral ${fmt(standHit.lat)} vs front ${fmt(standHit.front)})`, soft)
  if (standWorldHit) fail(`${run.id}: stands inside the OSM footprint of ${standWorldHit.id} at s ${fmt(standWorldHit.s, 0)} (world ${fmt(standWorldHit.x, 0)},${fmt(standWorldHit.z, 0)})`)
  if (apronHit > 8) fail(`${run.id}: ${apronHit} m of it stands on a paved GROUND_AREAS apron (a barrier belongs at the edge of the tarmac, not in it)`)
  if (maxStep > 6) fail(`${run.id}: ${fmt(maxStep)} m lateral step over 2 m of s (a right-angle jog)`, soft)
  runRows.push({ id: run.id, kind: run.kind, side: run.side, s: `${s0}→${s1}`, samples: r.samples.length, clear: fmt(minClear), src: run.source.osm ? `osm ${run.source.osm.length}` : `hand ${run.source.samples.length}`, unv: run.unverified ? 'U' : '' })
}
// the lap must be walled on both sides except at the pit lane / bridge / open infield
{
  const covered = { 1: new Uint8Array(Math.ceil(L)), '-1': new Uint8Array(Math.ceil(L)) }
  for (const run of bar.BARRIERS) {
    const len = arcLen(run.sRange[0], run.sRange[1])
    for (let d = 0; d <= len; d++) covered[run.side][Math.round(wrap(run.sRange[0] + d)) % Math.ceil(L)] = 1
  }
  for (const side of [1, -1]) {
    const arr = covered[side]
    const holes = []
    let start = -1
    for (let i = 0; i < arr.length; i++) {
      if (!arr[i] && start < 0) start = i
      if (arr[i] && start >= 0) {
        if (i - start >= 40) holes.push([start, i])
        start = -1
      }
    }
    if (start >= 0 && arr.length - start >= 40) holes.push([start, arr.length])
    for (const [a, b] of holes) console.log(`  note: no barrier on side ${side} for s ${a}–${b} (${b - a} m)`)
  }
}

// ---------------------------------------------------------------- 8. kerbs / lines / lanes
for (const k of bar.KERBS) {
  const [s0, s1] = k.sRange
  if (arcLen(s0, s1) <= 0 || arcLen(s0, s1) > 600) fail(`kerb "${k.name}": invalid sRange ${s0}→${s1}`)
  if (k.kind !== 'green' && inArc(s0, [pit.entryS, pit.exitS]) && k.side === -1) fail(`kerb "${k.name}": on the right inside the pit lane span`, true)
}
for (let i = 0; i < bar.KERBS.length; i++) {
  for (let j = i + 1; j < bar.KERBS.length; j++) {
    const a = bar.KERBS[i], b = bar.KERBS[j]
    if (a.side !== b.side || a.kind !== b.kind || !arcsOverlap(a.sRange, b.sRange)) continue
    fail(`kerbs "${a.name}" and "${b.name}" overlap on the same side`, true)
  }
}
for (const ln of bar.LINES) {
  if (typeof ln.lateral === 'string') continue
  const [s0, s1] = ln.sRange
  if (ln.lateralTo === undefined && arcLen(s0, s1) <= 0) fail(`line "${ln.name}": invalid sRange`)
  const len = arcLen(s0, s1)
  for (let d = 0; d <= len; d += 5) {
    const s = wrap(s0 + d)
    const lat = at(ln.lateral, s, ln.sRange)
    if (Math.abs(lat) > 40) fail(`line "${ln.name}": lateral ${fmt(lat)} at s ${fmt(s, 0)} is off the paved width`)
  }
}
for (const lane of bar.OFFSET_LANES) {
  const f = osm.osmFeature(lane.osmWay)
  if (!f) {
    fail(`lane "${lane.name}": OSM way ${lane.osmWay} missing`)
    continue
  }
  const pts = trackside.osmPathSamples(track, lane.osmWay, lane.sRange).filter(([, l]) => !lane.latMax || Math.abs(l) <= lane.latMax)
  if (pts.length < 3) fail(`lane "${lane.name}": ${pts.length} vertices mapped in its window`)
  const far = Math.max(...pts.map(([, l]) => Math.abs(l)))
  if (far < 8) fail(`lane "${lane.name}": never leaves the road (max |lateral| ${fmt(far)})`, true)
}
for (const m of bar.MARSHAL_POSTS) {
  if (Math.abs(m.lateral) < track.halfWidthAt(m.s) + 2) fail(`marshal post at s ${m.s}: lateral ${fmt(m.lateral)} is on the road`)
}
for (const b of bar.BASINS) {
  if (b.osmWay !== undefined && !osm.osmFeature(b.osmWay)) fail(`basin "${b.name}": OSM way ${b.osmWay} missing`)
  if (b.osmWay === undefined && !(b.ring && b.sRange)) fail(`basin "${b.name}": neither an OSM way nor a ring + sRange`)
  if (b.surface && b.dry) fail(`basin "${b.name}": dry and with a water surface`)
}

console.log('\nbarrier runs')
console.log('id                          kind        side s-range        samples src       clear')
for (const r of runRows) console.log(`${r.id.padEnd(27)} ${r.kind.padEnd(11)} ${String(r.side).padStart(2)}   ${r.s.padEnd(13)} ${String(r.samples).padStart(7)} ${r.src.padEnd(9)} ${r.clear.padStart(6)} ${r.unv}`)
console.log(`${bar.BARRIERS.length} runs, ${bar.KERBS.length} kerbs, ${bar.LINES.length} line groups, ${bar.OFFSET_LANES.length} lanes, ${bar.MARSHAL_POSTS.length} marshal posts`)

// ---------------------------------------------------------------- 9. surface patches
/**
 * A9. GROUND_AREAS outline validity (the ring / osm footprints).
 *
 * `trackside.patchOutline` can emit a ring that is not a simple polygon — the `minGap` clamp
 * projects vertices onto `halfWidth + minGap`, the Catmull-Rom resample overshoots at a sharp
 * corner, and the `osm` branch mixes clamped and unclamped points. `ground-mesh.ts` hands the
 * part of the ring outside the raster to `THREE.ShapeUtils.triangulateShape`, so a
 * self-intersecting outline turns into overlapping and inverted triangles instead of an error.
 */
{
  const seg = (p1, q1, p2, q2) => {
    const d = (q1.x - p1.x) * (q2.z - p2.z) - (q1.z - p1.z) * (q2.x - p2.x)
    if (Math.abs(d) < 1e-12) return false
    const t = ((p2.x - p1.x) * (q2.z - p2.z) - (p2.z - p1.z) * (q2.x - p2.x)) / d
    const u = ((p2.x - p1.x) * (q1.z - p1.z) - (p2.z - p1.z) * (q1.x - p1.x)) / d
    return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9
  }
  const patchRings = []
  console.log('\nsurface patches')
  console.log('name                       kind     layer  verts  faces  area m2   tri/ring')
  // the ring as ground-plan.ts resolves it: the exactly-collinear filler the resampler adds is
  // dropped there, and checking the raw outline would report a defect that never reaches a mesh
  for (const patch of areaPatches) {
    const ring = trackside.simplifyRing(trackside.patchOutline(track, patch, 2))
    const n = ring.length
    if (n < 3) {
      fail(`patch "${patch.name}": outline resolved to ${n} vertices`)
      continue
    }
    let crossings = 0
    for (let i = 0; i < n; i++) {
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue
        if (seg(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n])) crossings++
      }
    }
    // shoelace in (x, −z): patchOutline reverses to make this positive, so assert the postcondition
    let area = 0
    for (let i = 0; i < n; i++) {
      const a = ring[i], b = ring[(i + 1) % n]
      area += a.x * -b.z - b.x * -a.z
    }
    area /= 2
    const contour = ring.map((q) => new THREE.Vector2(q.x, -q.z))
    const faces = THREE.ShapeUtils.triangulateShape(contour, [])
    let triArea = 0
    let degenerate = 0
    for (const f of faces) {
      const a = contour[f[0]], b = contour[f[1]], c = contour[f[2]]
      const s2 = ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2
      triArea += Math.abs(s2)
      // zero-area faces: duplicate or collinear ring vertices, which the minGap clamp produces
      // when several nodes project onto the same halfWidth + minGap point
      if (Math.abs(s2) < 0.01) degenerate++
    }
    console.log(`${patch.name.padEnd(26)} ${patch.kind.padEnd(8)} ${String(patch.layer).padStart(5)} ${String(n).padStart(6)} ${String(faces.length).padStart(6)} ${fmt(Math.abs(area)).padStart(8)}   ${(triArea / Math.abs(area)).toFixed(4)}  ${degenerate} degenerate`)
    /**
     * Known, bounded ring defects. `シケイン舗装エプロン` is built from a road-edge run PLUS the
     * two-wheel loop offset outwards, and the loop dips back across that run at s ≈ 5161. Since
     * the ring's inner boundary moved out to clear the flat strip (trackside.ts STRIP_CLEAR) the
     * two cross there, costing 27 of 202 ears and 0.4 % of overlapping area. Fixing it properly
     * needs the loop clipped against the road-edge boundary rather than trimmed point-wise.
     * Recorded so a NEW crossing, or this one growing, still fails.
     */
    const KNOWN_RING = { 'シケイン舗装エプロン': { crossings: 1, faces: 175 } }
    const known = KNOWN_RING[patch.name]
    if (crossings > (known?.crossings ?? 0)) fail(`patch "${patch.name}": outline self-intersects at ${crossings} edge pair(s) — triangulateShape will produce overlapping faces`)
    else if (crossings) fail(`patch "${patch.name}": ${crossings} known self-crossing(s), ${faces.length} of ${n - 2} ears — the loop node crosses the road-edge run at s≈5161`, true)
    if (area <= 0) fail(`patch "${patch.name}": ring winds clockwise in (x, −z) — patchOutline should have reversed it`)
    if (Math.abs(area) < 20) fail(`patch "${patch.name}": ${fmt(Math.abs(area))} m2 is too small to be a real surface`)
    if (Math.abs(area) > 20000) fail(`patch "${patch.name}": ${fmt(Math.abs(area))} m2 — a runaway ring (check latMax / the OSM way)`)
    if (faces.length !== n - 2 && faces.length < (known?.faces ?? Infinity)) fail(`patch "${patch.name}": triangulateShape returned ${faces.length} faces, a simple polygon must give exactly ${n - 2}`)
    if (Math.abs(triArea - Math.abs(area)) > Math.abs(area) * (known ? 0.01 : 0.005)) fail(`patch "${patch.name}": triangles cover ${fmt(triArea)} m2 of a ${fmt(Math.abs(area))} m2 ring`)
    if (degenerate > faces.length * 0.6) fail(`patch "${patch.name}": ${degenerate} of ${faces.length} triangles have no area — the outline has duplicate or collinear vertices`, true)

    /**
     * B3. Two properties of the ring that decided how the chicane looked.
     *
     * `straight` resampling splits a segment into EQUAL linear steps, so every interpolated point
     * is exactly on the chord; ear clipping turns each into a zero-area triangle whose vertices end
     * up with a (0,0,0) normal and shade black. `ground-plan.ts` drops them (simplifyRing) before
     * the mesh triangulates, so a ring arriving here with a long collinear run means that pass has
     * stopped working.
     *
     * And a ring vertex must clear the KERB, not just the old flat 0.8 m: the turf island's whole
     * road-side boundary used to sit at off 0.80 inside a 1.3 m kerb, which drew over it.
     */
    let collinear = 0
    for (let i = 0; i < n; i++) {
      const a = ring[(i - 1 + n) % n], b = ring[i], c = ring[(i + 1) % n]
      if (Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)) <= 2e-4) collinear++
    }
    if (collinear > n * 0.25) fail(`patch "${patch.name}": ${collinear} of ${n} ring vertices are collinear with their neighbours — ear clipping will make them zero-area triangles`)
    let minOff = Infinity, minKerb = 0, minS = 0
    for (const q of ring) {
      const m = track.nearestOnRange(q.x, q.z, patch.sRange[0], patch.sRange[1], 60)
      // a ring that passes under the crossover crosses the upper road's footprint in XZ (the
      // Degner-side grass runs under the bridge): the deck zone is not a road edge it can respect
      if (Math.min(arcLen(track.crossing.sOver, m.s), arcLen(m.s, track.crossing.sOver)) < 50) continue
      const off = Math.abs(m.lateral) - track.halfWidthAt(m.s)
      if (off < minOff) { minOff = off; minKerb = trackside.kerbWidthAt(track, m.s, m.lateral >= 0 ? 1 : -1); minS = m.s }
    }
    if (minOff < minKerb) fail(`patch "${patch.name}": its ring comes to ${fmt(minOff, 2)} m off the road edge at s ${fmt(minS, 0)}, inside the ${fmt(minKerb, 2)} m kerb there`)
    patchRings.push({ patch, ring, area: Math.abs(area) })
  }

  /**
   * A3. Two area rows that overlap must be nested with distinct `layer`s: the ground plan cuts the
   * higher one out of the lower (a hole), and with equal layers the row order alone decides —
   * which is not something a reader of the table can see. A partial overlap is a plan-time
   * build error (ground-plan.ts, rule R7), so it is not judged here.
   */
  const inRing = (x, z, r) => {
    let inside = false
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const a = r[i], b = r[j]
      if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside
    }
    return inside
  }
  for (let i = 0; i < patchRings.length; i++) {
    for (let j = i + 1; j < patchRings.length; j++) {
      const A = patchRings[i], B = patchRings[j]
      const bb = (r) => r.reduce((o, p) => ({ x0: Math.min(o.x0, p.x), x1: Math.max(o.x1, p.x), z0: Math.min(o.z0, p.z), z1: Math.max(o.z1, p.z) }), { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity })
      const a = bb(A.ring), b = bb(B.ring)
      if (a.x1 < b.x0 || b.x1 < a.x0 || a.z1 < b.z0 || b.z1 < a.z0) continue
      let overlap = 0
      for (let x = Math.max(a.x0, b.x0); x <= Math.min(a.x1, b.x1); x += 1) {
        for (let z = Math.max(a.z0, b.z0); z <= Math.min(a.z1, b.z1); z += 1) {
          if (inRing(x, z, A.ring) && inRing(x, z, B.ring)) overlap++
        }
      }
      if (overlap < 1) continue
      const pair = `"${A.patch.name}" × "${B.patch.name}" (${overlap} m2)`
      if (A.patch.layer === B.patch.layer) fail(`areas ${pair} overlap and share layer ${A.patch.layer} — no defined winner`)
      const [under, over] = A.patch.layer < B.patch.layer ? [A, B] : [B, A]
      console.log(`  overlap ${pair}: layer ${under.patch.layer} "${under.patch.kind}" under layer ${over.patch.layer} "${over.patch.kind}"`)
      // only the LOWER patch can be buried — the higher one covering it is the whole point
      if (overlap > under.area * 0.98) fail(`patch "${under.patch.name}" is completely covered by "${over.patch.name}" and draws nothing`, true)
    }
  }
}

// ---------------------------------------------------------------- 10. run-off zone hygiene
/**
 * A5. RUNOFF_ZONES feeds `runoffLayout`, which takes the last writer when bands interleave and
 * invents a band through `fillGaps` where no row covers the lap at all. Both are silent.
 */
{
  const RUNOFF_MAX_LAT = 55
  for (const z of spec.RUNOFF_ZONES) {
    for (const [side, band] of [['left', z.left], ['right', z.right]]) {
      for (const kind of ['asphalt', 'grass', 'gravel']) {
        const b = band[kind]
        if (!b) continue
        if (b[0] >= b[1]) fail(`zone "${z.name}" ${side}.${kind}: [${b[0]}, ${b[1]}] is empty or inverted`)
        if (b[1] > RUNOFF_MAX_LAT) fail(`zone "${z.name}" ${side}.${kind}: outer edge ${fmt(b[1])} exceeds RUNOFF_MAX_LAT ${RUNOFF_MAX_LAT}`, true)
      }
      if (band.asphalt && band.gravel && band.gravel[0] < band.asphalt[1] - 0.5) {
        fail(`zone "${z.name}" ${side}: gravel starts at ${fmt(band.gravel[0])} inside asphalt ending at ${fmt(band.asphalt[1])} — buildLayout takes the last writer`, true)
      }
    }
  }
  // stretches of lap with no row at all: fillGaps invents a band there
  const covered = new Uint8Array(Math.ceil(L))
  for (const z of spec.RUNOFF_ZONES) {
    const len = arcLen(z.sRange[0], z.sRange[1])
    for (let d = 0; d <= len; d++) covered[Math.floor(wrap(z.sRange[0] + d)) % covered.length] = 1
  }
  const gaps = []
  let from = null
  for (let i = 0; i <= covered.length; i++) {
    const c = i < covered.length && covered[i]
    if (!c && from === null) from = i
    if (c && from !== null) {
      if (i - from > 2) gaps.push([from, i])
      from = null
    }
  }
  if (from !== null && covered.length - from > 2) gaps.push([from, covered.length])
  const gapM = gaps.reduce((a, [x, y]) => a + (y - x), 0)
  if (gapM) fail(`RUNOFF_ZONES leaves ${gapM} m of lap with no row (${gaps.map(([x, y]) => `${x}-${y}`).join(', ')}) — fillGaps invents a band there`, true)
}

// ---------------------------------------------------------------- 12. A10 — every stand is screened by a debris fence (world space)
/**
 * A10. Sample each stand's front edge every 2 m; from the road edge at that s to the front seat
 * draw the line a debris would fly along, and require a FENCE-CARRYING BARRIERS run's resolved
 * line (fence > 0 or kind 'fence'; ray projection included, so the Q2 bank wall counts) to pass
 * within FENCE_NEAR of that line for ≥ FENCE_COVER of the samples. World space, so a stand in
 * the figure-8 fold (Q2) is tested against the wall's real polyline, not its nominal lateral.
 * Soft when the stand's unverified names its position / footprint. This is the check that
 * found the G stand at 130R 48 % unscreened (the verge rail carried no fence).
 */
{
  const FENCE_NEAR = 6
  const FENCE_COVER = 0.95
  const fences = []
  for (const run of bar.BARRIERS) {
    const h = run.kind === 'fence' ? 3 : run.fence ?? 0
    if (!h) continue
    const r = trackside.resolveLineCached(track, run.source, run.sRange, run.side, run.minGap ?? 0.6)
    const pts = []
    const len = arcLen(run.sRange[0], run.sRange[1])
    for (let d = 0; d <= len; d += 2) {
      const s = wrap(run.sRange[0] + d)
      track.pointAt(s, r.lat(s), v3, 0)
      pts.push({ x: v3.x, z: v3.z })
    }
    fences.push({ id: run.id, side: run.side, pts })
  }
  /** distance between two XZ segments (0 when they cross) */
  const segSeg = (a, b, c, d) => {
    const cross = (p, q, r) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x)
    const s1 = cross(a, b, c), s2 = cross(a, b, d), s3 = cross(c, d, a), s4 = cross(c, d, b)
    if (((s1 > 0) !== (s2 > 0)) && ((s3 > 0) !== (s4 > 0))) return 0
    const pd = (p, u, w) => {
      const dx = w.x - u.x, dz = w.z - u.z
      const t = Math.max(0, Math.min(1, ((p.x - u.x) * dx + (p.z - u.z) * dz) / (dx * dx + dz * dz || 1)))
      return Math.hypot(p.x - (u.x + dx * t), p.z - (u.z + dz * t))
    }
    return Math.min(pd(a, c, d), pd(b, c, d), pd(c, a, b), pd(d, a, b))
  }
  console.log('\nA10 stand screening (fence-carrying line within 6 m of road-edge → front, % of 2 m samples)')
  for (const st of spec.STANDS) {
    const [s0, s1] = st.sRange
    const len = arcLen(s0, s1)
    const soft = (st.unverified ?? []).some((u) => /footprint|position/.test(u))
    /** (road-edge point, stand point) pairs to screen */
    const pairs = []
    if ((st.unverified ?? []).some((u) => /fold/.test(u))) {
      // a stand in the figure-8 fold (Q2): its (s, lateral) front is nominal, so walk its OSM
      // footprint rings every 2 m and take each point's nearest road inside the stand's window
      for (const ring of standFootprints.filter((f) => f.id === st.id).map((f) => f.ring)) {
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i], b = ring[(i + 1) % ring.length]
          const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 2))
          for (let k = 0; k < n; k++) {
            const p = { x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n }
            const near = track.nearestOnRange(p.x, p.z, s0, s1, 20)
            track.pointAt(near.s, st.side * track.halfWidthAt(near.s), v3, 0)
            pairs.push({ s: near.s, q: { x: v3.x, z: v3.z }, p })
          }
        }
      }
    } else {
      for (let d = 0; d <= len; d += 2) {
        const s = wrap(s0 + d)
        const front = spec.alongAt(st.lateralFront, s, st.sRange)
        track.pointAt(s, st.side * track.halfWidthAt(s), v3, 0)
        const q = { x: v3.x, z: v3.z }
        track.pointAt(s, front, v3, 0)
        pairs.push({ s, q, p: { x: v3.x, z: v3.z } })
      }
    }
    let n = 0, ok = 0
    const holes = []
    for (const { s, q, p } of pairs) {
      let best = Infinity
      for (const f of fences) {
        if (f.side !== st.side) continue
        for (let i = 0; i < f.pts.length - 1 && best > 0; i++) best = Math.min(best, segSeg(q, p, f.pts[i], f.pts[i + 1]))
      }
      n++
      if (best <= FENCE_NEAR) ok++
      else holes.push(Math.round(s))
    }
    holes.sort((a, b) => a - b)
    const cover = n ? ok / n : 1
    const holeTxt = holes.length ? ` (unscreened at s ${holes[0]}…${holes[holes.length - 1]})` : ''
    console.log(`  ${st.id.padEnd(10)} ${(100 * cover).toFixed(0).padStart(3)} %${holeTxt}`)
    if (cover < FENCE_COVER) fail(`${st.id}: only ${(100 * cover).toFixed(0)} % of its front is screened by a fence-carrying BARRIERS run${holeTxt}`, soft)
  }
  // A10b. A spectator bank is a stand without a structure: people sit on the grass at the bank's
  // near edge, so that edge needs the same debris fence in front of it. A bank whose `unverified`
  // already names the missing fence is a documented gap (warning); one that does not is an error —
  // the fix is a BARRIERS run, never a quiet move of the bank.
  console.log('\nA10b bank screening (same rule, near edge of each SPECTATOR_BANKS row)')
  for (const bk of spec.SPECTATOR_BANKS ?? []) {
    const [s0, s1] = bk.sRange
    const len = arcLen(s0, s1)
    let n = 0, ok = 0
    const holes = []
    for (let d = 0; d <= len; d += 2) {
      const s = wrap(s0 + d)
      const near = at(bk.lateral[0], s, bk.sRange)
      track.pointAt(s, bk.side * track.halfWidthAt(s), v3, 0)
      const q = { x: v3.x, z: v3.z }
      track.pointAt(s, bk.side * near, v3, 0)
      const p = { x: v3.x, z: v3.z }
      let best = Infinity
      for (const f of fences) {
        if (f.side !== bk.side) continue
        for (let i = 0; i < f.pts.length - 1 && best > 0; i++) best = Math.min(best, segSeg(q, p, f.pts[i], f.pts[i + 1]))
      }
      n++
      if (best <= FENCE_NEAR) ok++
      else holes.push(Math.round(s))
    }
    const cover = n ? ok / n : 1
    const holeTxt = holes.length ? ` (unscreened at s ${holes[0]}…${holes[holes.length - 1]})` : ''
    console.log(`  ${bk.id.padEnd(14)} ${(100 * cover).toFixed(0).padStart(3)} %${holeTxt}`)
    if (cover < FENCE_COVER) {
      const known = (bk.unverified ?? []).some((u) => /fence/.test(u))
      fail(`${bk.id}: only ${(100 * cover).toFixed(0)} % of its near edge is behind a fence-carrying BARRIERS run${holeTxt}`, known)
    }
  }
}

// ---------------------------------------------------------------- 14. roofs and published seat counts
/**
 * (b) Every `StandDef.roof`: its s range and its blocks lie inside the stand, the blocks do not
 * overlap, a canopy that follows a tier names a tier that exists, and the soffit clears the top
 * row it covers by 2.2 m (front height + Σ rows × riser + headroom). A roof that a spectator can
 * stand up into is the one modelling error a screenshot never shows.
 *
 * (a) `SEAT_CAPACITY`: only sourced figures, every stand it names exists, and the table estimate
 * (`estimateSeats`, rows × usable length ÷ pitch) is within 10 % under the published count —
 * further under means the footprint or the row count is wrong, not the clamp. Soft: the estimate
 * ignores the tapering ends. There is deliberately NO Σ gate over all the stands: the total seat
 * count is a GPU budget (quality.crowd), not a fact about the circuit.
 */
{
  console.log('\nroofs')
  for (const st of spec.STANDS) {
    const roof = st.roof
    if (!roof) continue
    const [rs0, rs1] = roof.sRange ?? st.sRange
    if (!inArc(rs0, st.sRange) || !inArc(rs1, st.sRange)) fail(`${st.id}: roof sRange ${rs0}→${rs1} is outside the stand ${st.sRange[0]}→${st.sRange[1]}`)
    const blocks = roof.blocks ?? [[rs0, rs1]]
    for (const [b0, b1] of blocks) {
      if (!inArc(b0, [rs0, rs1]) || !inArc(b1, [rs0, rs1])) fail(`${st.id}: roof block ${b0}→${b1} is outside the roof range ${rs0}→${rs1}`)
      if (arcLen(b0, b1) < 1) fail(`${st.id}: roof block ${b0}→${b1} is shorter than a metre`)
    }
    for (let i = 0; i < blocks.length; i++) {
      for (let j = i + 1; j < blocks.length; j++) if (arcsOverlap(blocks[i], blocks[j])) fail(`${st.id}: roof blocks ${blocks[i].join('→')} and ${blocks[j].join('→')} overlap`)
    }
    if (!roof.lateral && !roof.tier) fail(`${st.id}: roof names neither a lateral band nor a tier`)
    const tier = roof.tier ? st.tiers.find((t) => t.id === roof.tier) : st.tiers[st.tiers.length - 1]
    if (roof.tier && !tier) fail(`${st.id}: roof covers tier "${roof.tier}", which the stand does not have`)
    if (!tier) continue
    /**
     * Headroom under the roof at every 2 m of its own range, over the row-1 tread AND over the
     * top row. A canopy `rise`s from its front edge to its back while the deck climbs at its own
     * rake, so which end is tight depends on the two slopes — check both. The tier's platform
     * height follows `resolveTiers`: its own `frontHeight` when it has one (G's two bars are
     * parallel, not stacked), otherwise the tiers before it stack.
     */
    const platform = (t, s) => {
      if (t.frontHeight !== undefined) return at(t.frontHeight, s, st.sRange)
      let y = at(st.frontHeight, s, st.sRange)
      for (const p of st.tiers) {
        if (p.id === t.id) break
        if (p.lateralFront === undefined && p.frontHeight === undefined) y += p.rows * p.riser
      }
      return y
    }
    let worst = Infinity, worstS = rs0, worstAt = 'row 1'
    for (let d = 0; d <= arcLen(rs0, rs1); d += 2) {
      const s = wrap(rs0 + d)
      if (!blocks.some((b) => inArc(s, b))) continue
      const y0 = platform(tier, s)
      const yTop = y0 + tier.rows * tier.riser
      for (const [clear, where] of [[roof.soffit - y0, 'row 1'], [roof.soffit + (roof.rise ?? 0) - yTop, 'the top row']]) {
        if (clear < worst) { worst = clear; worstS = s; worstAt = where }
      }
    }
    console.log(`  ${st.id.padEnd(10)} ${(roof.style ?? 'slab').padEnd(6)} ${(roof.columns ?? 'ground').padEnd(7)} soffit ${fmt(roof.soffit)} rise ${fmt(roof.rise ?? 0)}  least headroom ${fmt(worst)} m over ${worstAt} at s ${fmt(worstS, 0)}  ${blocks.length} block(s)`)
    if (Number.isFinite(worst) && worst < 2.2 - 1e-9) fail(`${st.id}: the roof leaves only ${fmt(worst)} m over ${worstAt} at s ${fmt(worstS, 0)} (2.2 m needed)`)
    if (roof.top <= roof.soffit) fail(`${st.id}: roof top ${roof.top} is not above its soffit ${roof.soffit}`)
  }

  console.log('\npublished seat counts (SEAT_CAPACITY)')
  const seen = new Set()
  for (const cap of spec.SEAT_CAPACITY ?? []) {
    if (!cap.source || cap.source.length < 20) fail(`SEAT_CAPACITY ${cap.stands.join('+')}: no source — only sourced figures belong in this table`)
    let est = 0
    for (const id of cap.stands) {
      const st = spec.standById(id)
      if (!st) { fail(`SEAT_CAPACITY names stand "${id}", which does not exist`); continue }
      if (seen.has(id)) fail(`SEAT_CAPACITY names stand "${id}" twice`)
      seen.add(id)
      est += spec.estimateSeats(st)
    }
    console.log(`  ${cap.stands.join('+').padEnd(10)} published ${String(cap.seats).padStart(6)}  table estimate ${String(est).padStart(6)}  (${(100 * est / cap.seats).toFixed(0)} %)`)
    if (est < 0.9 * cap.seats) fail(`${cap.stands.join('+')}: the table estimate ${est} is under 0.9 × the published ${cap.seats} — the rows or the footprint are short, and the clamp cannot add seats`, true)
  }
  const estRows = spec.STANDS.map((st) => [st.id, spec.estimateSeats(st)]).filter(([, n]) => n > 0)
  console.log(`  table estimate over all ${estRows.length} stands with rows: ${estRows.reduce((a, [, n]) => a + n, 0)} places (no Σ gate: the drawn figure count is quality.crowd's budget)`)
}

// ---------------------------------------------------------------- 15. spectator banks
/**
 * (d) `SPECTATOR_BANKS`: valid s range, a band that widens outwards, a near edge outside the
 * run-off (hw + the widest asphalt / gravel of any RUNOFF_ZONES row that covers it), no s overlap
 * with a stand on the same side (open intervals: a bank may start where a stand ends), a density
 * a lawn can actually hold, and an `unverified` note — every one of these figures is read off an
 * aerial.
 */
{
  console.log('\nspectator banks')
  const ids = new Set()
  for (const bk of spec.SPECTATOR_BANKS ?? []) {
    const [s0, s1] = bk.sRange
    const len = arcLen(s0, s1)
    if (ids.has(bk.id)) fail(`SPECTATOR_BANKS: duplicate id ${bk.id}`)
    ids.add(bk.id)
    if (s0 < 0 || s0 >= L || s1 < 0 || s1 >= L || len <= 0 || len > L / 4) fail(`${bk.id}: invalid sRange ${s0}→${s1}`)
    if (!(bk.density > 0) || bk.density > 0.5) fail(`${bk.id}: density ${bk.density} is outside (0, 0.5] people/m²`)
    if (!(bk.occupancy > 0) || bk.occupancy > 1) fail(`${bk.id}: occupancy ${bk.occupancy} is outside (0, 1]`)
    if (bk.seated < 0 || bk.seated > 1) fail(`${bk.id}: seated ${bk.seated} is outside [0, 1]`)
    if (!(bk.unverified ?? []).length) fail(`${bk.id}: no unverified note (every bank figure is read off an aerial)`)
    let minNear = Infinity, minMargin = Infinity, marginS = s0, width = Infinity
    for (let d = 0; d <= len; d += 2) {
      const s = wrap(s0 + d)
      const near = at(bk.lateral[0], s, bk.sRange)
      const far = at(bk.lateral[1], s, bk.sRange)
      if (far <= near) { fail(`${bk.id}: far edge ${fmt(far)} is not outside the near edge ${fmt(near)} at s ${fmt(s, 0)}`); break }
      width = Math.min(width, far - near)
      minNear = Math.min(minNear, near)
      let outer = track.halfWidthAt(s)
      for (const z of spec.RUNOFF_ZONES) {
        if (!inArc(s, z.sRange)) continue
        const band = bk.side === 1 ? z.left : z.right
        outer = Math.max(outer, band.asphalt?.[1] ?? 0, band.gravel?.[1] ?? 0)
      }
      if (near - outer < minMargin) { minMargin = near - outer; marginS = s }
    }
    console.log(`  ${bk.id.padEnd(14)} side ${String(bk.side).padStart(2)}  s ${String(s0).padStart(4)}→${String(s1).padStart(4)} (${fmt(len, 0)} m)  near ${fmt(minNear)}  narrowest ${fmt(width)} m  run-off margin ${fmt(minMargin)} m  density ${bk.density}`)
    if (minMargin < 0) fail(`${bk.id}: its near edge is ${fmt(-minMargin)} m inside the run-off / road at s ${fmt(marginS, 0)}`)
    for (const st of spec.STANDS) {
      if (st.side !== bk.side) continue
      // open intervals: a bank that starts exactly where a stand ends does not overlap it
      const [a0, a1] = st.sRange
      if (arcLen(a0, s1) < arcLen(a0, a1) + len && arcLen(s0, a1) < arcLen(a0, a1) + len && s1 !== a0 && a1 !== s0 && arcsOverlap(st.sRange, bk.sRange)) {
        // ...and only when the lateral bands meet as well
        let hit = null
        for (let d = 0; d <= len; d += 2) {
          const s = wrap(s0 + d)
          if (!inArc(s, st.sRange)) continue
          const sf = Math.abs(at(st.lateralFront, s, st.sRange)), sb = Math.abs(at(st.lateralBack, s, st.sRange))
          const bn = at(bk.lateral[0], s, bk.sRange), bf = at(bk.lateral[1], s, bk.sRange)
          if (bn < sb && sf < bf) { hit = { s, st: [sf, sb], bk: [bn, bf] }; break }
        }
        if (hit) fail(`${bk.id} overlaps stand ${st.id} at s ${fmt(hit.s, 0)} (${fmt(hit.bk[0])}..${fmt(hit.bk[1])} vs ${fmt(hit.st[0])}..${fmt(hit.st[1])})`)
      }
    }
  }
}

// ---------------------------------------------------------------- 13. A11 — screens, signs and the tower stand where they can
/**
 * A11. SCREENS / SIGNS / LEADER_TOWER: |lateral| ≥ hw + 1.5 (never in the road or its kerb),
 * outside every stand's OSM footprint (world space), not inside the pit lane's band where the
 * lane runs; `boards` only on concrete runs (the boards hang on a wall face); AD_PANELS (I4-c)
 * under the same rules, on the spectator side of and ≥ 0.28 m off every BARRIERS line of their
 * side — and, since the I4 review, every corner of the 12 m board outside the stand footprints,
 * the board ≥ TYRE_STACK.radius + 0.3 from a tyre run's spare stack row (its centre line: the
 * wall's 1.3 m depth + the radius behind the line, at the panel's centre and both ends) and
 * outside every scaffold / lattice TV tower's footprint + 1 m (tv-lens.ts resolves the tower).
 * SIGNS rows with a `mount` (pitWallBoard / pitWallTop / barrierTop) hang on a wall and are
 * exempt; they must name a wall that exists at their s (the pit wall's sRange, or a BARRIERS run
 * — a barrierTop row names it in `run`).
 */
{
  const laneHalf = pit.laneWidth / 2
  const inPitLane = (s, lateral) => {
    const c = track.pitLateralAt(s)
    return c !== null && Math.abs(lateral - c) < laneHalf - 0.05
  }
  const items = [
    ...spec.SCREENS.map((sc) => ({ id: `screen ${sc.id}`, s: sc.s, lateral: sc.lateral })),
    // cameraSide: the outside of the nearest corner at hw + 3.2 (props.ts cameraSide, re-stated)
    // rows that hang on a wall (mount) are the wall's business: the wall itself passes the
    // barrier checks, and the sign sits on its top or its boards, inside the wall's own band
    ...bar.SIGNS.filter((sg) => !sg.mount).map((sg) => {
      let k = 0
      for (let d = -40; d <= 40; d += 10) k += track.kappaAt(sg.s + d)
      const side = Math.abs(k) < 1e-4 ? 1 : k > 0 ? -1 : 1
      return { id: `sign ${sg.id}`, s: sg.s, lateral: sg.lateral === 'cameraSide' ? side * (track.halfWidthAt(sg.s) + 3.2) : sg.lateral }
    }),
    { id: 'LEADER_TOWER', s: spec.LEADER_TOWER.s, lateral: spec.LEADER_TOWER.lateral },
    // the free-standing hoarding panels (I4-c): the same standing-room rules as a sign, plus O5 below
    ...(bar.AD_PANELS ?? []).map((p) => ({ id: `ad panel ${p.id}`, s: p.s, lateral: p.lateral })),
  ]
  for (const it of items) {
    const hw = track.halfWidthAt(it.s)
    if (Math.abs(it.lateral) < hw + 1.5) fail(`${it.id}: lateral ${fmt(it.lateral)} is inside hw + 1.5 (${fmt(hw + 1.5)}) at s ${it.s}`)
    track.pointAt(it.s, it.lateral, v3, 0)
    const inside = standFootprintAt(v3.x, v3.z)
    if (inside) fail(`${it.id}: stands inside the OSM footprint of ${inside}`)
    if (inPitLane(it.s, it.lateral)) fail(`${it.id}: stands in the pit lane band at s ${it.s} (lateral ${fmt(it.lateral)})`)
    const paved = pavedApronAt(v3.x, v3.z)
    if (paved) fail(`${it.id}: stands on the paved GROUND_AREAS apron "${paved}" (a sign belongs beside the tarmac, not on it)`)
  }
  for (const run of bar.BARRIERS) if (run.boards && run.kind !== 'concrete') fail(`${run.id}: boards on a ${run.kind} run — boards hang on concrete walls only`)
  // the panels stand off every BARRIERS line of their side (O5's rule: ≥ half their depth + 0.2), inside the circuit ring
  {
    const tvLens = await import('../app/three/tv-lens.ts')
    // the stack row from the data (bar.TYRE_STACK) and ops-spec's restated wall depth: no scene module here (R13)
    const { TYRE_STACK } = bar
    const { barrierDepthOf: barrierDepth } = await import('../app/data/ops-spec.ts')
    const stackClear = TYRE_STACK.radius + 0.3
    for (const p of bar.AD_PANELS ?? []) {
      const side = p.lateral >= 0 ? 1 : -1
      const alongS = p.facing === '+lat' || p.facing === '-lat'
      /** the board's half-extents along s and across (a thin sheet across its facing) */
      const halfS = alongS ? p.width / 2 : 0.1, halfL = alongS ? 0.1 : p.width / 2
      const ends = alongS ? [p.s - p.width / 2, p.s, p.s + p.width / 2] : [p.s]
      for (const run of bar.BARRIERS) {
        if (run.side !== side || !inArc(p.s, run.sRange)) continue
        const lineAt = trackside.resolveLineCached(track, run.source, run.sRange, run.side, run.minGap ?? 0.6)
        const line = lineAt.lat(p.s)
        if (Math.abs(p.lateral - line) < 0.15 / 2 + 0.2) fail(`ad panel ${p.id}: ${fmt(Math.abs(p.lateral - line), 2)} m from the line of ${run.id} — O5`)
        if (side * (p.lateral - line) < 0) fail(`ad panel ${p.id}: on the track side of ${run.id} (line ${fmt(line)})`)
        // a tyre run's spare stack row stands behind the wall's back: the board keeps off it along its whole length
        if (run.kind === 'tyre') {
          for (const s of ends) {
            if (!inArc(s, run.sRange)) continue
            const row = lineAt.lat(s) + side * (barrierDepth(run) + TYRE_STACK.radius)
            if (Math.abs(p.lateral - row) < stackClear) fail(`ad panel ${p.id}: ${fmt(Math.abs(p.lateral - row), 2)} m from ${run.id}'s spare tyre row at s ${fmt(s, 0)} (row centre ${fmt(row)}, needs ${stackClear}) — A11`)
          }
        }
      }
      // every corner of the board outside the stand footprints (the centre alone let a 12 m board end inside I)
      for (const cs of alongS ? [p.s - p.width / 2, p.s + p.width / 2] : [p.s]) for (const cl of alongS ? [p.lateral] : [p.lateral - p.width / 2, p.lateral + p.width / 2]) {
        track.pointAt(cs, cl, v3, 0)
        const inside = standFootprintAt(v3.x, v3.z)
        if (inside) fail(`ad panel ${p.id}: its end at (${fmt(cs, 0)}, ${fmt(cl)}) is inside the footprint of stand ${inside} — A11`)
      }
      // off every scaffold / lattice TV tower's footprint (+ 1 m): the tower stands behind the same wall
      for (const c of bar.TV_CAMERAS ?? []) {
        if (c.tower !== 'scaffold' && c.tower !== 'lattice') continue
        let lat
        try { lat = tvLens.towerLateralAt(track, c) } catch { continue }
        const half = tvLens.TV_TOWER_FOOTPRINT[c.tower] / 2
        const ds = Math.min(arcLen(c.s, p.s), arcLen(p.s, c.s))
        if (ds < halfS + half + 1 && Math.abs(p.lateral - lat) < halfL + half + 1) fail(`ad panel ${p.id}: inside TV tower ${c.id}'s footprint + 1 m (tower (${c.s}, ${fmt(lat)}), Δs ${fmt(ds)}, Δlateral ${fmt(Math.abs(p.lateral - lat))}) — A11`)
      }
    }
  }
  // mounted signs: the wall they hang on exists at their s
  for (const sg of bar.SIGNS) {
    if (!sg.mount) continue
    if (sg.mount === 'pitWallBoard' || sg.mount === 'pitWallTop') {
      const w = spec.PIT_WALL
      if (!inArc(sg.s, w.sRange)) fail(`sign ${sg.id}: mount ${sg.mount} at s ${sg.s} is outside the pit wall ${w.sRange[0]}→${w.sRange[1]}`)
      if (sg.lateral !== w.lateral) fail(`sign ${sg.id}: mount ${sg.mount} at lateral ${sg.lateral}, the pit wall is at ${w.lateral}`)
      if (sg.mount === 'pitWallTop' && w.concrete && !inArc(sg.s, w.concrete)) fail(`sign ${sg.id}: mount pitWallTop at s ${sg.s} is off the concrete wall ${w.concrete[0]}→${w.concrete[1]} (the W-beam ends carry no block)`)
    } else if (sg.mount === 'barrierTop') {
      const s0 = sg.s
      const run = sg.run ? bar.BARRIERS.find((r) => r.id === sg.run) : bar.BARRIERS.find((r) => inArc(s0, r.sRange) && Math.sign(r.side) === Math.sign(sg.lateral))
      if (!run) fail(`sign ${sg.id}: mount barrierTop at s ${sg.s} finds no BARRIERS run ${sg.run ? `'${sg.run}'` : 'on that side'}`)
      else if (!inArc(s0, run.sRange)) fail(`sign ${sg.id}: mount barrierTop at s ${sg.s} is outside its run ${run.id} ${run.sRange[0]}→${run.sRange[1]}`)
      else if (Math.sign(run.side) !== Math.sign(sg.lateral)) fail(`sign ${sg.id}: mount barrierTop on ${run.id} (side ${run.side}) with lateral ${sg.lateral}`)
    }
  }
  for (const u of spec.UNDERPASSES) {
    const f = osm.osmFeature(u.osmWay)
    if (!f) fail(`underpass "${u.name}": OSM way ${u.osmWay} missing from OSM_FEATURES (build-facilities.mjs --add-ways)`)
    else if (f.role !== 'road') fail(`underpass "${u.name}": OSM way ${u.osmWay} has role "${f.role}", expected 'road'`)
  }
}

// ---------------------------------------------------------------- 11. 周辺データ (surroundings + DEM)
/**
 * §11. The generated files outside the fence: app/data/suzuka-surroundings.ts (OSM, ODbL) and
 * app/data/suzuka-dem.ts (国土地理院). Their headers must carry the attribution, every packed
 * ring must decode to a simple polygon of sensible area inside SUR_RECT, buildings must not
 * re-ship an id the facilities data already owns, polylines need ≥ 2 vertices and a width,
 * and the two files together stay under 1 MB (plan §1d / §2f).
 */
{
  const fs = await import('node:fs')
  const surPath = new URL('../app/data/suzuka-surroundings.ts', import.meta.url)
  const demPath = new URL('../app/data/suzuka-dem.ts', import.meta.url)
  const headOf = (url) => fs.readFileSync(url, 'utf8').split('\n').slice(0, 20).join('\n')
  const seg = (p1, q1, p2, q2) => {
    const d = (q1.x - p1.x) * (q2.z - p2.z) - (q1.z - p1.z) * (q2.x - p2.x)
    if (Math.abs(d) < 1e-12) return false
    const t = ((p2.x - p1.x) * (q2.z - p2.z) - (p2.z - p1.z) * (q2.x - p2.x)) / d
    const u = ((p2.x - p1.x) * (q1.z - p1.z) - (p2.z - p1.z) * (q1.x - p1.x)) / d
    return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9
  }
  const RECT_TOL = 1 // m outside SUR_RECT a vertex may sit (0.1 m grid rounding)
  const AREA_RANGE = [20, 600000] // m² for land use / buildings
  const SITE_AREA_RANGE = [20, 4e6] // the circuit boundary itself is ≈ 1 km²

  const surHead = headOf(surPath)
  if (!surHead.includes('OpenStreetMap contributors') || !surHead.includes('ODbL')) fail('suzuka-surroundings.ts: header lacks the OpenStreetMap contributors / ODbL attribution in its first 20 lines')
  const sur = await import('../app/data/suzuka-surroundings.ts')
  const codec = await import('../app/data/en-codec.ts')
  const surSpec = await import('../app/data/surroundings-spec.ts')
  const [re0, rn0, re1, rn1] = sur.SUR_RECT
  if (!(re1 - re0 > 6000 && rn1 - rn0 > 5000)) fail(`SUR_RECT ${sur.SUR_RECT.join(', ')} is not the DEM terrain rectangle (expected ≈ 6.6 × 5.8 km)`)

  const polygonLayers = ['SUR_FOREST', 'SUR_FARMLAND', 'SUR_GRASS', 'SUR_SCRUB', 'SUR_BARE', 'SUR_WATER', 'SUR_PARKING', 'SUR_SOLAR', 'SUR_BUILDINGS']
  const lineLayers = ['SUR_STREAMS', 'SUR_ROADS', 'SUR_RAIL']
  const layerRows = []
  let ringErrors = 0
  const ringFail = (msg) => {
    // the first few are reported verbatim, the rest counted — a broken file would otherwise print thousands of lines
    if (ringErrors++ < 8) fail(msg)
  }
  const decode = (layer, f) => {
    let pts
    try {
      pts = codec.enPairs(f)
    } catch (e) {
      ringFail(`${layer} ${f.id}: en does not decode (${e.message})`)
      return null
    }
    if (pts.length !== f.n) ringFail(`${layer} ${f.id}: n ${f.n} but the stream decodes to ${pts.length} vertices`)
    for (const [e, n] of pts) {
      if (e < re0 - RECT_TOL || e > re1 + RECT_TOL || n < rn0 - RECT_TOL || n > rn1 + RECT_TOL) {
        ringFail(`${layer} ${f.id}: vertex (${fmt(e)}, ${fmt(n)}) lies outside SUR_RECT`)
        break
      }
    }
    return pts
  }
  const checkRing = (layer, f, pts, range) => {
    const n = pts.length
    if (n < 3) {
      ringFail(`${layer} ${f.id}: ${n} vertices is not a polygon`)
      return
    }
    const ring = pts.map(([e, nn]) => ({ x: e, z: -nn }))
    let crossings = 0
    for (let i = 0; i < n && crossings === 0; i++) {
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue
        if (seg(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n])) {
          crossings++
          break
        }
      }
    }
    if (crossings) ringFail(`${layer} ${f.id}: ring self-intersects`)
    let area = 0
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n]
      area += a[0] * b[1] - b[0] * a[1]
    }
    area /= 2
    if (area <= 0) ringFail(`${layer} ${f.id}: ring winds clockwise in EN — the generator should have reversed it`)
    const abs = Math.abs(area)
    if (abs < range[0] || abs > range[1]) ringFail(`${layer} ${f.id}: ${fmt(abs, 0)} m² is outside [${range[0]}, ${range[1]}]`)
    if (f.area !== undefined && Math.abs(abs - f.area) > Math.max(2, abs * 0.01)) ringFail(`${layer} ${f.id}: stored area ${f.area} vs decoded ${fmt(abs, 0)} m²`)
  }
  for (const layer of polygonLayers) {
    const list = sur[layer]
    let verts = 0
    for (const f of list) {
      const pts = decode(layer, f)
      if (!pts) continue
      verts += pts.length
      checkRing(layer, f, pts, AREA_RANGE)
    }
    layerRows.push({ layer, count: list.length, verts })
  }
  for (const layer of lineLayers) {
    const list = sur[layer]
    let verts = 0
    for (const f of list) {
      const pts = decode(layer, f)
      if (!pts) continue
      verts += pts.length
      if (pts.length < 2) ringFail(`${layer} ${f.id}: ${pts.length} vertex polyline`)
      if (!(f.width > 0)) ringFail(`${layer} ${f.id}: width ${f.width}`)
    }
    layerRows.push({ layer, count: list.length, verts })
  }
  {
    let verts = 0
    const roles = {}
    for (const f of sur.SUR_SITES) {
      roles[f.role] = (roles[f.role] ?? 0) + 1
      const pts = decode('SUR_SITES', f)
      if (!pts) continue
      verts += pts.length
      if (f.closed) checkRing('SUR_SITES', f, pts, SITE_AREA_RANGE)
      else if (pts.length < 2) ringFail(`SUR_SITES ${f.id}: ${pts.length} vertex polyline`)
    }
    for (const [role, want] of [['circuit', 1], ['theme_park', 1], ['camp_site', 1], ['gate', 4], ['pool', 2], ['coaster_station', 1], ['coaster', 4]]) {
      if ((roles[role] ?? 0) !== want) fail(`SUR_SITES: ${roles[role] ?? 0} × ${role}, expected ${want}`)
    }
    layerRows.push({ layer: 'SUR_SITES', count: sur.SUR_SITES.length, verts })
  }
  if (ringErrors > 8) fail(`suzuka-surroundings.ts: ${ringErrors - 8} further ring error(s) not listed`)

  // ids the facilities data already owns must not come back as generic buildings
  const owned = new Map()
  owned.set(osm.OSM_PIT_BUILDING.id, 'OSM_PIT_BUILDING')
  for (const [stand, ways] of Object.entries(osm.OSM_STAND_WAYS)) for (const w of ways) owned.set(w, `OSM_STAND_WAYS.${stand}`)
  for (const b of spec.BUILDINGS) if (b.osmWay !== null) owned.set(b.osmWay, `BUILDINGS.${b.id}`)
  // I5-b: the infield facilities' footprints and the ways tagged building=* that are not buildings
  for (const f of spec.INFIELD_FACILITIES ?? []) if (typeof f.osmWay === 'number') owned.set(f.osmWay, `INFIELD_FACILITIES.${f.id}`)
  for (const id of surSpec.SUR_SKIP_IDS ?? []) owned.set(id, 'SUR_SKIP_IDS')
  const seenB = new Set()
  for (const b of sur.SUR_BUILDINGS) {
    if (owned.has(b.id)) fail(`SUR_BUILDINGS ${b.id} collides with ${owned.get(b.id)}`)
    if (seenB.has(b.id)) fail(`SUR_BUILDINGS ${b.id} appears twice`)
    seenB.add(b.id)
  }

  // the DEM file lands with the terrain work; until then only note its absence
  let demBytes = 0
  if (fs.existsSync(demPath)) {
    if (!headOf(demPath).includes('国土地理院')) fail('suzuka-dem.ts: header lacks the 国土地理院 attribution in its first 20 lines')
    demBytes = fs.statSync(demPath).size
  } else console.log('\nsuzuka-dem.ts not present yet — DEM header / size not checked')
  const surBytes = fs.statSync(surPath).size
  // I5-a: 1,150,000 (was 1 MiB) — the same ceiling as perf-budgets.json data.generatedBytes, raised when the three generated files reached 1,023,525 B together
  const CAP = 1150000
  if (surBytes + demBytes > CAP) fail(`suzuka-surroundings.ts (${surBytes}) + suzuka-dem.ts (${demBytes}) = ${surBytes + demBytes} bytes, over the ${CAP} byte cap`)

  console.log('\nsurroundings')
  console.log('layer          count  vertices')
  for (const r of layerRows) console.log(`${r.layer.padEnd(14)} ${String(r.count).padStart(5)}  ${String(r.verts).padStart(8)}`)
  console.log(`extract ${sur.SUR_EXTRACT_DATE}, SUR_RECT [${sur.SUR_RECT.join(', ')}]`)
  console.log(`bytes: surroundings ${surBytes} + dem ${demBytes} = ${surBytes + demBytes} of ${CAP} (${((100 * (surBytes + demBytes)) / CAP).toFixed(1)} %)`)
}

// ---------------------------------------------------------------- 16. ops-check (O1–O11)
/**
 * §16 ops-check — the static operations layer (app/data/ops-spec.ts `opsPlacements()` /
 * `figuresAt()`) and the trackside / infield tables against what the moving cars, the cameras
 * and the ground already claim. Every rule is an error whether or not `--strict` is given; the
 * one exception is noted at O8. Tables a later phase adds (TV_CAMERAS, the MARSHAL_POSTS v2
 * fields, PADDOCK_BUILDINGS, INFIELD_FACILITIES, INFIELD_TREES, CUTS, FOOTBRIDGES) are skipped
 * with a "(table absent, skipped)" line until they exist, so the checker runs today on empty
 * inputs and grows with the phases.
 *
 *   O1  pit envelope: over the entry → exit span no footprint corner inside
 *       [c − keepOut.back, max(c + keepOut.front, −hw)] (c = Track.pitLateralAt — entering cars
 *       lag it toward the track by up to 5 m); with `--envelope <json>` (the 5 m bins of
 *       `pnpm sim -- --envelope`) the measured [min − carHalf − 1, max + carHalf + 1] replaces
 *       that outside the box strip (inside it the bins cover the working area — the cars cross
 *       it to their boxes — so the strip keeps the explicit rules below). Along the box strip
 *       nothing in the lane band PIT_ENVELOPE.lanes; apron / lane rows inside
 *       PIT_ENVELOPE.workArea and outside every block's stopped-car rectangle (ops-spec
 *       `stoppedCarRect`: stop ± (carHalf + margin) × boxS ± (halfS + margin)) and outside the
 *       arrival strip stop ± carHalf along the whole box strip (a car reaches its box along
 *       the stop lateral — race.ts PIT_PLANNED.stopSwitchM — and leaves it along the stop
 *       lateral for PIT_EXIT_HOLD_M, so that strip is car space in front of every block; rows
 *       that are driven over, ≤ 0.1 m tall — the cable ramps — are exempt; figures are tested
 *       as points against the same strip);
 *       wall rows in the walkway band; interior rows inside the building. Rows that hang on a structure
 *       the barrier checks cover (wall, pitWallTop, barrierTop, fencePost) skip the band
 *       rules. All 12 rectangles are checked to lie inside the working area and outside the
 *       lane band, and `crewSlots` / `perchSeats` of every block (the rows I3-d's figuresAt()
 *       reads) pass O1 / O3 / O4 / O12 today. Free-standing SIGNS (numeric lateral, no mount)
 *       go through O2 / O3 / O4 / O6 / O12 and the box-strip lane band here; their pit
 *       keep-out is A11's inPitLane (a board stands at the lane's edge by design).
 *   O2  everywhere else: |lateral| ≥ hw + 1.5 for every corner (the road is car space).
 *   O3  chase lens (ops-spec `lensColumns`, 12): per block, nothing taller than chaseLens.maxH
 *       in the lens column s ∈ [boxS − columnS[0], boxS − columnS[1]] × stop ± halfLat, and
 *       nothing at all (figures included) between the lens and the car, s ∈ [boxS − back,
 *       boxS − 3] × stop ± halfLat.
 *   O4  the grid s ∈ [5620, 5798] × |lateral| ≤ 4.2 (race.ts placeOnGrid: 14 + 8k, ± 2.6) is empty.
 *   O5  every BARRIERS run's resolved line stays ≥ w/2 + 0.2 from the footprint (mounted rows and
 *       boards / lights / cameras exempt).
 *   O6  no row that is not interior / roof inside PIT_BUILDING (shutter line → back), the centre
 *       house 184430907, the former medical room 184429429 (course_vehicle_base), PADDOCK_BUILDINGS,
 *       INFIELD_FACILITIES.
 *   O7  TV_CAMERAS (tv-lens.ts resolves every row): the 13 lens rows at the rig's CAM positions
 *       in order, unique ids; the tower footprint (TV_TOWER_FOOTPRINT) on the spectator side of
 *       the barrier line and 0.6 m outside it, its edge ≥ hw + 1.5, outside stands, paved aprons
 *       and inside the circuit ring; 'auto' = the line + TV_LENS.autoSetback; the lens
 *       tvForwardOf(tower) towards the track — the deck's front edge and its rail ≥ 0.5 m
 *       BEHIND the lens and the deck ≤ y_lens − 0.5 (the rig's NEAR); the operator
 *       (cameraSlots) on the footprint, off the road.
 *   O8  MARSHAL_POSTS v2 (I4-a): |lateral| ≥ hw + 2; `marshalNumbers()` unique, monotonic in
 *       s, without gaps, and the ascending count reaching every `number` anchor
 *       (`marshalNumberFaults`); `type 'building'` carries osmWay or size; the
 *       cabin's stand + stair / the low box / a sized building under O1 / O2 / O4, ≥ 0.6 m on
 *       the spectator side of the nearest barrier run's line (bare 'fence' runs excepted) and
 *       ≥ 0.2 m off every other overlapping run's line; the marshal slots under O1 / O2.
 *   O9  every figure of figuresAt({ lineAt }) (the fence-window photographers included, I4-c) passes O1–O4 (a 'wall' figure the walkway band instead, a
 *       'roof' one — the podium terrace — only O3 / O4) and stands inside the circuit ring,
 *       outside every ops footprint (a seated crew inside its own perch frame excepted, and
 *       nothing under a 'roof' row is a fault) and outside every building footprint (O6).
 *   O10 INFIELD_TREES (every placement of app/data/infield-trees.ts, the runtime's own expansion):
 *       |lateral| ≥ hw + 6, outside the paved aprons (rings AND the swept service roads), the
 *       car parks and gravel pads (GROUND_AREAS 'paddock' / 'gravelArea'), the INFIELD_FACILITIES
 *       footprints (OSM rings and sized boxes) and the stand footprints, inside the ring, ≥ 0.6 m
 *       off every barrier line on its side.
 *   O11 PADDOCK_BUILDINGS / INFIELD_FACILITIES: osmWay in OSM_FEATURES, outlines pairwise
 *       disjoint, the anchor projects inside its s window (fold rows placed from EN are exempt).
 *   O12 windows: the lap is a figure-8, so a row is only projected back to s inside a window
 *       (ops-spec OPS_WINDOWS) — every apron / lane row's centre lies in PIT_BOX_STRIP ± 20 m or
 *       the pit-exit yard; every other row and every figure in some window (the paddock, the
 *       E paddock / compound, the yard, the strip) — except the trackside posts' marshals
 *       (mount 'trackside' / 'platform'), keyed by their MARSHAL_POSTS row.
 */
{
  const ops = await import('../app/data/ops-spec.ts')
  const ring = await import('./audit/ring.mjs')
  await ring.circuitRing()
  const E = spec.PIT_ENVELOPE
  const notes = []
  const skip = (what) => notes.push(`${what} (table absent, skipped)`)
  const placements = ops.opsPlacements()
  // the fence-window photographers (I4-c) join the list when the barrier lines can be resolved
  const figures = ops.figuresAt({ lineAt: (s, side) => trackside.barrierLateralAt(track, s, side) })
  /** the footprint's four corners in (s, lateral): size [long, across], yaw about up (0 = long side along +s) */
  const cornersOf = (p) => {
    const a = (p.size?.[0] ?? 0) / 2, b = (p.size?.[1] ?? 0) / 2
    const yaw = ((p.yawDeg ?? 0) * Math.PI) / 180
    const c = Math.cos(yaw), sn = Math.sin(yaw)
    return [[a, b], [a, -b], [-a, -b], [-a, b]].map(([u, v]) => [wrap(p.s + u * c - v * sn), p.lateral + u * sn + v * c])
  }
  /** the footprint's bounding box as forward distances from `s0` (so a wrapping zone compares in one frame) */
  const bboxFrom = (corners, s0) => {
    let d0 = Infinity, d1 = -Infinity, l0 = Infinity, l1 = -Infinity
    for (const [s, l] of corners) {
      const d = signedDelta(s0, s, L)
      if (d < d0) d0 = d
      if (d > d1) d1 = d
      if (l < l0) l0 = l
      if (l > l1) l1 = l
    }
    return { d0, d1, l0, l1 }
  }
  /** does the footprint overlap the zone s ∈ [zs0, zs1] (forward), lateral ∈ [zl0, zl1]? */
  const overlapsZone = (corners, zs0, zs1, zl0, zl1) => {
    const b = bboxFrom(corners, zs0)
    const len = arcLen(zs0, zs1)
    return b.d1 >= 0 && b.d0 <= len && b.l1 >= zl0 && b.l0 <= zl1
  }
  const pointInZone = (s, lat, zs0, zs1, zl0, zl1) => inArc(s, [zs0, zs1]) && lat >= zl0 && lat <= zl1
  const within = (v, [a, b]) => v >= Math.min(a, b) && v <= Math.max(a, b)
  const analyticKeepOut = (s) => {
    const c = track.pitLateralAt(s)
    if (c === null) return null
    return [c - E.keepOut.back, Math.max(c + E.keepOut.front, -track.halfWidthAt(s))]
  }
  // --envelope <json>: the measured 5 m bins (car-centre lateral min / max while pitState ≠ 'none')
  // replace the analytic keep-out outside the box strip; a bin with no sample keeps the analytic one
  let measured = null
  if (ENVELOPE_ARG) {
    const fs = await import('node:fs')
    const env = JSON.parse(fs.readFileSync(ENVELOPE_ARG, 'utf8'))
    if (env.stop !== E.stop) fail(`--envelope ${ENVELOPE_ARG}: measured with stop ${env.stop}, PIT_ENVELOPE.stop is ${E.stop} — re-run pnpm sim -- --envelope`)
    measured = new Map(env.bins.map((b) => [b.s, b]))
    notes.push(`O1: measured envelope ${ENVELOPE_ARG} (${env.bins.length} bins, seeds ${env.seeds?.join(', ')}, ${env.laps} laps) replaces the analytic keep-out outside the box strip`)
  }
  const keepOutAt = (s) => {
    const a = analyticKeepOut(s)
    if (!a || !measured || inArc(s, E.boxStrip)) return a
    const b = measured.get(Math.floor(wrap(s) / 5) * 5)
    if (!b) return a
    return [b.min - E.carHalf - 1.0, Math.max(b.max + E.carHalf + 1.0, -track.halfWidthAt(s))]
  }
  // the stopped car and the chase lens of every block come from the ops-spec helpers (from
  // PIT_ENVELOPE.stop — no literal stop lateral anywhere); the helpers themselves are checked first
  const stop = E.stop
  const carRects = []
  for (let g = 0; g < spec.PIT_GARAGE_COUNT; g++) {
    const r = ops.stoppedCarRect(g)
    carRects.push({ g: g + 1, s0: r.s[0], s1: r.s[1], l0: r.lat[0], l1: r.lat[1] })
    if (!(within(r.lat[0], E.workArea) && within(r.lat[1], E.workArea))) fail(`stoppedCarRect(${g}): lateral ${fmt(r.lat[0])}…${fmt(r.lat[1])} leaves the working area [${E.workArea.join(', ')}] — O1`)
    if (within(r.lat[0], E.lanes) || within(r.lat[1], E.lanes)) fail(`stoppedCarRect(${g}): lateral ${fmt(r.lat[0])}…${fmt(r.lat[1])} reaches into the lane band [${E.lanes.join(', ')}] — O1`)
    if (Math.abs(arcLen(r.s[0], r.s[1]) - 2 * (E.carBox.halfS + E.carBox.margin)) > 1e-6 || !inArc(spec.garageS(g), r.s)) fail(`stoppedCarRect(${g}): s ${fmt(r.s[0])}→${fmt(r.s[1])} is not boxS ± (halfS + margin) — O1`)
  }
  const lensColumns = []
  for (const c of ops.lensColumns()) {
    lensColumns.push({
      g: c.block + 1,
      column: { s0: c.column.s[0], s1: c.column.s[1], l0: c.column.lat[0], l1: c.column.lat[1] },
      path: { s0: c.path.s[0], s1: c.path.s[1], l0: c.path.lat[0], l1: c.path.lat[1] },
    })
    if (Math.abs(arcLen(c.column.s[0], c.column.s[1]) - (E.chaseLens.columnS[0] - E.chaseLens.columnS[1])) > 1e-6 || Math.abs(arcLen(c.column.s[1], c.boxS) - E.chaseLens.columnS[1]) > 1e-6) fail(`lensColumns()[${c.block}]: column s ${fmt(c.column.s[0])}→${fmt(c.column.s[1])} is not boxS − columnS — O3`)
    if (Math.abs(arcLen(c.path.s[0], c.boxS) - E.chaseLens.back) > 1e-6 || Math.abs(arcLen(c.path.s[1], c.boxS) - 3) > 1e-6) fail(`lensColumns()[${c.block}]: path s ${fmt(c.path.s[0])}→${fmt(c.path.s[1])} is not boxS − back → boxS − 3 — O3`)
    if (c.lens.lateral !== stop || c.column.maxH !== E.chaseLens.maxH) fail(`lensColumns()[${c.block}]: lens lateral / maxH differ from PIT_ENVELOPE — O3`)
  }
  if (lensColumns.length !== spec.PIT_GARAGE_COUNT) fail(`lensColumns(): ${lensColumns.length} columns for ${spec.PIT_GARAGE_COUNT} blocks — O3`)
  // O12: the s windows (ops-spec OPS_WINDOWS)
  const WINDOWS = Object.entries(ops.OPS_WINDOWS)
  const APRON_WINDOWS = ['pitStrip', 'entryApron', 'yard']
  const windowFaults = (id, s, mount) => {
    // the trackside posts' marshals (I4-a) are keyed by MARSHAL_POSTS, not by a pit-side window
    if (mount === 'trackside' || mount === 'platform') return []
    const names = WINDOWS.filter(([, r]) => inArc(s, r)).map(([n]) => n)
    if (!names.length) return [`${id}: s ${fmt(s, 0)} is in no OPS_WINDOWS window (${WINDOWS.map(([n, r]) => `${n} ${r.join('→')}`).join(', ')}) — O12`]
    if ((mount === 'apron' || mount === 'lane') && !names.some((n) => APRON_WINDOWS.includes(n))) return [`${id}: ${mount} row at s ${fmt(s, 0)} is outside the box strip ± 20 m / the yard (${names.join(', ')}) — O12`]
    return []
  }
  /** the grid: race.ts placeOnGrid slots at s = −(14 + 8k), lateral ± 2.6, a 2.9 m half-length car */
  const GRID = { s0: 5620, s1: 5798, halfLat: 4.2 }
  /** the pit wall's pit-side walkway: wall face −9.05 to the kerb at the fast lane, over the wall's run */
  const WALL_BAND = { lat: [-12.0, -9.05], s: [5556, 95] }
  /** inside the building: 0.7 m behind the shutter line to 5.1 m short of the paddock face (the rear corridor) */
  const INTERIOR = [spec.PIT_BUILDING.back + 5.1, E.workArea[0] - 0.7]
  const STRUCT_MOUNTS = new Set(['wall', 'pitWallTop', 'barrierTop', 'fencePost'])
  const O5_EXEMPT_MOUNTS = new Set(['barrierTop', 'pitWallTop', 'pitWallBoard', 'wall', 'fencePost'])
  const O5_EXEMPT_KINDS = new Set(['board', 'light', 'camera'])

  const worldOf = (s, lat) => { track.pointAt(s, lat, v3, 0); return [v3.x, v3.z] }
  const worldRingOf = (id) => {
    const f = osm.osmFeature(id)
    return f?.closed ? f.en.map(([e, n]) => ({ x: e * track.enScale, z: -n * track.enScale })) : null
  }
  const inWorldRing = (x, z, r) => {
    let inside = false
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const a = r[i], b = r[j]
      if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside
    }
    return inside
  }

  // --- O1 / O2 on a footprint ------------------------------------------------------------------
  /** O1 + O2 for one footprint; returns the messages (empty = ok) */
  const envelopeFaults = (id, p, corners) => {
    const out = []
    const mount = p.mount ?? 'free'
    if (STRUCT_MOUNTS.has(mount)) {
      if (mount === 'wall') {
        for (const [s, l] of corners) if (!within(l, WALL_BAND.lat) || !inArc(s, WALL_BAND.s)) { out.push(`${id}: wall-mounted row leaves the walkway band lateral ${WALL_BAND.lat.join('…')} / s ${WALL_BAND.s.join('→')} (corner s ${fmt(s, 0)}, lateral ${fmt(l)})`); break }
      }
      return out
    }
    for (const [s, l] of corners) {
      const hw = track.halfWidthAt(s)
      // O2: the road and its 1.5 m margin are car space everywhere
      if (Math.abs(l) < hw + 1.5) { out.push(`${id}: corner at s ${fmt(s, 0)} lateral ${fmt(l)} is inside hw + 1.5 (${fmt(hw + 1.5)}) — O2`); break }
      // O1: the pit path incl. the entry lag
      const ko = keepOutAt(s)
      if (ko && l >= ko[0] && l <= ko[1]) { out.push(`${id}: corner at s ${fmt(s, 0)} lateral ${fmt(l)} is inside the pit keep-out [${fmt(ko[0])}, ${fmt(ko[1])}] — O1`); break }
      if (inArc(s, E.boxStrip) && within(l, E.lanes)) { out.push(`${id}: corner at s ${fmt(s, 0)} lateral ${fmt(l)} is in the pit lane band [${E.lanes.join(', ')}] along the box strip — O1`); break }
    }
    if (mount === 'apron' || mount === 'lane') {
      for (const [s, l] of corners) if (!within(l, E.workArea)) { out.push(`${id}: ${mount} row leaves the working area [${E.workArea.join(', ')}] (corner s ${fmt(s, 0)}, lateral ${fmt(l)}) — O1`); break }
      for (const r of carRects) if (overlapsZone(corners, r.s0, r.s1, r.l0, r.l1)) { out.push(`${id}: ${mount} row overlaps the stopped car of block ${r.g} (s ${fmt(r.s0, 0)}→${fmt(r.s1, 0)}, lateral ${fmt(r.l0)}…${fmt(r.l1)}) — O1`); break }
      // the arrival strip along the whole box strip (rows driven over — the cable ramps, ≤ 0.1 m — excepted)
      if ((p.size?.[2] ?? 0) > 0.1 && overlapsZone(corners, E.boxStrip[0], E.boxStrip[1], stop - E.carHalf, stop + E.carHalf)) out.push(`${id}: ${mount} row lies in the arrival strip (stop ${fmt(stop)} ± ${E.carHalf} along the box strip s ${fmt(E.boxStrip[0], 0)}→${fmt(E.boxStrip[1], 0)}) — O1`)
    }
    if (mount === 'interior') {
      for (const [s, l] of corners) if (!within(l, INTERIOR)) { out.push(`${id}: interior row leaves the building interior lateral [${fmt(INTERIOR[0])}, ${fmt(INTERIOR[1])}] (corner s ${fmt(s, 0)}, lateral ${fmt(l)}) — O1`); break }
    }
    return out
  }
  /** O1 + O2 for a standing point */
  const pointFaults = (id, s, l) => {
    const out = []
    const hw = track.halfWidthAt(s)
    if (Math.abs(l) < hw + 1.5) out.push(`${id}: at s ${fmt(s, 0)} lateral ${fmt(l)} is inside hw + 1.5 (${fmt(hw + 1.5)}) — O2`)
    const ko = keepOutAt(s)
    if (ko && l >= ko[0] && l <= ko[1]) out.push(`${id}: at s ${fmt(s, 0)} lateral ${fmt(l)} is inside the pit keep-out [${fmt(ko[0])}, ${fmt(ko[1])}] — O1`)
    if (inArc(s, E.boxStrip) && within(l, E.lanes)) out.push(`${id}: at s ${fmt(s, 0)} lateral ${fmt(l)} is in the pit lane band along the box strip — O1`)
    for (const r of carRects) if (pointInZone(s, l, r.s0, r.s1, r.l0, r.l1)) out.push(`${id}: stands in the stopped car of block ${r.g} — O1`)
    if (pointInZone(s, l, E.boxStrip[0], E.boxStrip[1], stop - E.carHalf, stop + E.carHalf)) out.push(`${id}: stands in the arrival strip (stop ${fmt(stop)} ± ${E.carHalf} along the box strip) — O1`)
    return out
  }
  // --- O3 / O4 -------------------------------------------------------------------------------------
  const lensFaults = (id, p, corners) => {
    const out = []
    const top = (p.y ?? 0) + (p.size?.[2] ?? 0)
    for (const { g, column, path } of lensColumns) {
      if (top > E.chaseLens.maxH && overlapsZone(corners, column.s0, column.s1, column.l0, column.l1)) out.push(`${id}: ${fmt(top)} m tall in the chase-lens column of block ${g} (s ${fmt(column.s0, 0)}→${fmt(column.s1, 0)}, lateral ${fmt(column.l0)}…${fmt(column.l1)}, max ${E.chaseLens.maxH} m) — O3`)
      if (overlapsZone(corners, path.s0, path.s1, path.l0, path.l1)) out.push(`${id}: between the chase lens and the car of block ${g} (s ${fmt(path.s0, 0)}→${fmt(path.s1, 0)}, lateral ${fmt(path.l0)}…${fmt(path.l1)}) — O3`)
    }
    return out
  }
  const gridFaults = (id, corners) => (overlapsZone(corners, GRID.s0, GRID.s1, -GRID.halfLat, GRID.halfLat) ? [`${id}: on the grid (s ${GRID.s0}→${GRID.s1}, |lateral| ≤ ${GRID.halfLat}) — O4`] : [])
  // --- O5 ------------------------------------------------------------------------------------------
  const barrierLines = bar.BARRIERS.map((run) => ({ run, line: trackside.resolveLineCached(track, run.source, run.sRange, run.side, run.minGap ?? 0.6) })).filter((r) => r.line.samples.length >= 2)
  const barrierFaults = (id, p, corners) => {
    const out = []
    if (O5_EXEMPT_MOUNTS.has(p.mount) || O5_EXEMPT_KINDS.has(p.kind)) return out
    const half = (p.size?.[1] ?? 0) / 2
    for (const { run, line } of barrierLines) {
      const len = arcLen(run.sRange[0], run.sRange[1])
      const d = arcLen(run.sRange[0], p.s)
      if (d > len + 5 && d < L - 5) continue
      const centre = Math.abs(p.lateral - line.lat(p.s))
      let corner = Infinity
      for (const [s, l] of corners) corner = Math.min(corner, Math.abs(l - line.lat(s)))
      if (centre < half + 0.2 || corner < 0.2) { out.push(`${id}: ${fmt(Math.min(centre - half, corner), 2)} m from the resolved line of barrier run ${run.id} at s ${fmt(p.s, 0)} (needs w/2 + 0.2) — O5`); break }
    }
    return out
  }
  // --- O6 ------------------------------------------------------------------------------------------
  const buildingRings = []
  for (const id of [184430907, 184429429]) {
    const r = worldRingOf(id)
    if (r) buildingRings.push({ name: `OSM ${id}`, ring: r })
    else notes.push(`O6: OSM building ${id} not in OSM_FEATURES — its footprint is not checked`)
  }
  for (const [table, rows] of [['PADDOCK_BUILDINGS', spec.PADDOCK_BUILDINGS], ['INFIELD_FACILITIES', spec.INFIELD_FACILITIES]]) {
    if (!rows) continue
    for (const b of rows) {
      const r = b.osmWay ? worldRingOf(b.osmWay) : null
      if (r) buildingRings.push({ name: `${table} ${b.id ?? b.osmWay}`, ring: r })
    }
  }
  const buildingFaults = (id, p) => {
    if (p.mount === 'interior' || p.mount === 'roof') return []
    const out = []
    if (inArc(p.s, spec.PIT_BUILDING.sRange) && p.lateral >= spec.PIT_BUILDING.back && p.lateral <= E.workArea[0]) out.push(`${id}: centre (s ${fmt(p.s, 0)}, lateral ${fmt(p.lateral)}) is inside the pit building — O6`)
    const [x, z] = worldOf(p.s, p.lateral)
    for (const b of buildingRings) if (inWorldRing(x, z, b.ring)) out.push(`${id}: centre is inside the footprint of ${b.name} — O6`)
    return out
  }

  // --- the placements --------------------------------------------------------------------------------
  const seenIds = new Set()
  let placementFaults = 0
  for (const p of placements) {
    const id = `ops ${p.id}`
    if (seenIds.has(p.id)) fail(`${id}: duplicate id`)
    seenIds.add(p.id)
    if (!(p.size?.length === 3 && p.size.every((v) => Number.isFinite(v) && v > 0))) { fail(`${id}: size must be [long, across, height] > 0`); continue }
    const corners = cornersOf(p)
    const faults = [...envelopeFaults(id, p, corners), ...lensFaults(id, p, corners), ...gridFaults(id, corners), ...barrierFaults(id, p, corners), ...buildingFaults(id, p), ...windowFaults(id, p.s, p.mount)]
    for (const f of faults) fail(f)
    if (faults.length) placementFaults++
    const [x, z] = worldOf(p.s, p.lateral)
    if (!ring.insideRing(x, z)) fail(`${id}: stands outside the circuit ring 775428456`)
  }
  // the crew rows I3-d reads (ops-spec crewSlots / perchSeats) for every block: O1 / O3 / O4 / O12 today
  let crewChecked = 0
  for (let g = 0; g < spec.PIT_GARAGE_COUNT; g++) {
    for (const f of [...ops.crewSlots(g), ...ops.perchSeats(g)]) {
      const id = `crewSlots(${g}) ${f.pose} (${fmt(f.s, 1)}, ${fmt(f.lateral)})`
      crewChecked++
      const faults = f.mount === 'wall'
        ? (within(f.lateral, WALL_BAND.lat) && inArc(f.s, WALL_BAND.s) ? [] : [`${id}: wall seat outside the walkway band — O1`])
        : [...pointFaults(id, f.s, f.lateral), ...(ops.inWorkArea(f.lateral, 0) ? [] : [`${id}: outside the working area [${E.workArea.join(', ')}] — O1`])]
      for (const { g: b, path } of lensColumns) if (pointInZone(f.s, f.lateral, path.s0, path.s1, path.l0, path.l1)) faults.push(`${id}: between the chase lens and the car of block ${b} — O3`)
      if (pointInZone(f.s, f.lateral, GRID.s0, GRID.s1, -GRID.halfLat, GRID.halfLat)) faults.push(`${id}: on the grid — O4`)
      faults.push(...windowFaults(id, f.s, f.mount))
      for (const m of faults) fail(m)
    }
  }
  // free-standing SIGNS (a numeric lateral, no mount): the board's width runs across the facing
  // direction (facing ±s → across lateral); the pit keep-out itself is A11's inPitLane
  let signsChecked = 0
  for (const sg of bar.SIGNS) {
    if (sg.mount || typeof sg.lateral !== 'number') continue
    signsChecked++
    const alongS = sg.facing === '-lat' || sg.facing === '+lat'
    const p = { s: sg.s, lateral: sg.lateral, yawDeg: alongS ? 0 : 90, size: [sg.width ?? 1, 0.1, sg.height ?? 1], mount: 'free', kind: 'board' }
    const id = `SIGNS ${sg.id}`
    const corners = cornersOf(p)
    const faults = [...lensFaults(id, p, corners), ...gridFaults(id, corners), ...buildingFaults(id, p)]
    for (const [cs, cl] of corners) {
      if (Math.abs(cl) < track.halfWidthAt(cs) + 1.5) { faults.push(`${id}: corner at s ${fmt(cs, 0)} lateral ${fmt(cl)} is inside hw + 1.5 — O2`); break }
      if (inArc(cs, E.boxStrip) && within(cl, E.lanes)) { faults.push(`${id}: corner at s ${fmt(cs, 0)} lateral ${fmt(cl)} is in the pit lane band along the box strip — O1`); break }
    }
    for (const f of faults) fail(f)
  }

  // --- O7 TV_CAMERAS ---------------------------------------------------------------------------------
  // tv-lens.ts is the one resolver of a row (the 'auto' lateral behind the barrier line, the lens
  // tvForwardOf(tower) towards the track — the deck's half-width + TV_LENS.overhang — and the
  // deck TV_LENS.deckDrop under it): the guard reads the same numbers the builder and the rig
  // read, at the road plane (no ground here).
  {
    const tvLens = await import('../app/three/tv-lens.ts')
    /** the broadcast director's 13 lens positions (the former TV_CAMERA_SPOTS): the rig's CAM order — a change here is a deliberate one */
    const LENS_S = [250, 640, 1180, 1500, 1960, 2230, 2640, 3100, 3650, 4350, 4900, 5250, 5560]
    const lensRows = bar.TV_CAMERAS.filter((c) => c.lens !== false)
    if (lensRows.length !== LENS_S.length) fail(`TV_CAMERAS: ${lensRows.length} lens rows for the ${LENS_S.length} broadcast positions — O7`)
    lensRows.forEach((c, i) => { if (c.s !== LENS_S[i]) fail(`TV_CAMERAS ${c.id}: lens row ${i} is at s ${c.s}, the rig's CAM ${i + 1} is ${LENS_S[i]} — O7`) })
    const ids = new Set()
    const { deckDrop, autoSetback } = tvLens.TV_LENS
    // the platform vs the lens: the deck top ≤ y_lens − 0.5, and the deck's front edge and its
    // rail (tv-towers.ts: the rail bar 0.05 inside the edge, 0.04 wide) BEHIND the lens by
    // ≥ 0.5 — the rig's NEAR — so no post crosses the frame when the camera pans down at a car
    if (deckDrop < 0.5) fail(`TV_LENS.deckDrop ${deckDrop} puts the deck inside 0.5 m of the lens — O7`)
    for (const kind of ['scaffold', 'lattice']) {
      const deckHalf = tvLens.TV_DECK_HALF[kind]
      const forward = tvLens.tvForwardOf(kind)
      if (forward - deckHalf < 0.5) fail(`${kind}: the deck edge is ${fmt(forward - deckHalf, 2)} m behind the lens (needs ≥ 0.5) — O7`)
      const railBack = forward - (deckHalf - 0.05) - 0.02
      if (railBack < 0.5) fail(`${kind}: the front rail's near face is ${fmt(railBack, 2)} m behind the lens (needs ≥ 0.5, the rig's NEAR) — O7`)
    }
    for (const c of bar.TV_CAMERAS) {
      const id = `TV_CAMERAS ${c.id}`
      if (ids.has(c.id)) fail(`${id}: duplicate id — O7`)
      ids.add(c.id)
      let lateral
      try { lateral = tvLens.towerLateralAt(track, c) } catch (e) { fail(`${id}: ${e.message} — O7`); continue }
      const half = tvLens.TV_TOWER_FOOTPRINT[c.tower] / 2
      const hw = track.halfWidthAt(c.s)
      if (Math.abs(lateral) - half < hw + 1.5) fail(`${id}: footprint edge at lateral ${fmt(Math.abs(lateral) - half)} is inside hw + 1.5 (${fmt(hw + 1.5)}) — O7 / O2`)
      const [x, z] = worldOf(c.s, lateral)
      const inStand = standFootprintAt(x, z)
      if (inStand) fail(`${id}: tower inside the footprint of stand ${inStand} — O7`)
      const paved = pavedApronAt(x, z)
      if (paved) fail(`${id}: tower on the paved apron "${paved}" — O7`)
      if (!ring.insideRing(x, z)) fail(`${id}: tower outside the circuit ring — O7`)
      const side = Math.sign(lateral)
      let covered = false
      for (const { run, line } of barrierLines) {
        if (run.side !== side) continue
        const len = arcLen(run.sRange[0], run.sRange[1])
        const d = arcLen(run.sRange[0], c.s)
        if (d > len) continue
        covered = true
        const lineLat = line.lat(c.s)
        if (Math.sign(lateral - lineLat) !== side) fail(`${id}: tower on the track side of barrier run ${run.id} (line ${fmt(lineLat)}, tower ${fmt(lateral)}) — O7`)
        else if (Math.abs(lateral - lineLat) - half < 0.6) fail(`${id}: tower ${fmt(Math.abs(lateral - lineLat) - half, 2)} m from barrier run ${run.id} (needs 0.6) — O7`)
      }
      if (c.lateral === 'auto' && !covered) fail(`${id}: lateral 'auto' with no BARRIERS run on side ${side} at s ${c.s} — O7`)
      if (c.lateral === 'auto' && Math.abs(Math.abs(lateral) - Math.abs(trackside.barrierLateralAt(track, c.s, side)) - autoSetback) > 1e-9) fail(`${id}: 'auto' lateral ${fmt(lateral)} is not the line + ${autoSetback} — O7`)
      if (c.lens !== false) {
        const lens = tvLens.tvLensAt(track, c)
        const forward = tvLens.tvForwardOf(c.tower)
        if (Math.abs(lens.lateral - (lateral - side * forward)) > 1e-9) fail(`${id}: lens lateral ${fmt(lens.lateral)} is not the tower's ${fmt(lateral)} − ${forward} towards the track — O7`)
        if (c.height < deckDrop + tvLens.TV_LENS.rail + 1.0) fail(`${id}: height ${c.height} leaves no platform under the lens (needs ≥ ${deckDrop + tvLens.TV_LENS.rail + 1.0}) — O7`)
      }
      // the camera operator (ops-spec cameraSlots): on the tower's footprint, off the road
      for (const f of ops.cameraSlots({ id: c.id, s: c.s, lateral, tower: c.tower, floorY: 0 })) {
        if (Math.abs(f.lateral - lateral) > half) fail(`${id}: operator at lateral ${fmt(f.lateral)} is off the tower's footprint — O7`)
        if (Math.abs(f.lateral) < hw + 1.5) fail(`${id}: operator at lateral ${fmt(f.lateral)} is inside hw + 1.5 — O7 / O2`)
      }
    }
  }

  // --- O8 MARSHAL_POSTS -------------------------------------------------------------------------------
  /**
   * MARSHAL_POSTS v2 (I4-a): every row's centre ≥ hw + 2 off the road; `marshalNumbers()` is
   * unique, without gaps, ascends with s (one wrap) and its ascending count reaches every
   * `number` anchor (`marshalNumberFaults` — the anchor itself resets the count, so the
   * function that numbers the boards cannot report it); a 'building'
   * row carries osmWay or size; the drawn rectangles — the cabin's floor with its deck and the
   * stair on the `stair` side (ops-spec MARSHAL_STAND, what marshal-posts.ts builds), the low
   * box, a hand-sized building — pass O1 / O2 / O4, and against the barrier lines of their own
   * side: the NEAREST run's line (a bare 'fence' run — the car-park perimeter — excepted) has
   * every corner ≥ 0.6 m on its spectator side, every other run that overlaps the rectangle's
   * s span has every corner ≥ 0.2 m off its line (O5's rule, evaluated inside the run's own
   * window — a run's clamped end value must not judge a hut standing before its start). The
   * marshal slots (`marshalSlots`) pass O1 / O2 here and O9 below.
   */
  {
    const S = ops.MARSHAL_STAND
    const numbers = bar.marshalNumbers()
    const byNumber = new Map()
    // the anchors: marshalNumbers() resets the count AT an anchor (so the boards show the intended
    // numbers), which is why the fault is reported by `marshalNumberFaults` — the count the rows
    // before the anchor reach vs the anchor itself — and a gap is caught on its own
    for (const f of bar.marshalNumberFaults()) fail(`marshal post s ${f.s}: the ascending count reaches ${f.expected}, its anchor says ${f.anchor} (a row added or removed before it) — O8`)
    for (const [m, n] of numbers) {
      if (byNumber.has(n)) fail(`marshal post s ${m.s}: duplicate post number ${n} (also s ${byNumber.get(n)}) — O8`)
      byNumber.set(n, m.s)
    }
    for (let k = 1; k <= Math.max(0, ...byNumber.keys()); k++) if (!byNumber.has(k)) fail(`marshal post numbers skip ${k} — O8`)
    const byS = [...numbers.entries()].sort((a, b) => a[0].s - b[0].s)
    let descents = 0
    for (let i = 1; i < byS.length; i++) if (byS[i][1] < byS[i - 1][1]) descents++
    if (descents > 1) fail(`MARSHAL_POSTS: post numbers are not monotonic in s (${descents} descents) — O8`)
    /** the barrier lines of one side that overlap the s span [sa, sb] (forward arc), with their line evaluated inside the run's window */
    const linesOver = (side, sa, sb) => barrierLines.filter(({ run }) => run.side === side && (inArc(run.sRange[0], [sa, sb]) || inArc(sa, run.sRange)))
    const clampS = (run, s) => {
      const len = arcLen(run.sRange[0], run.sRange[1])
      const d = arcLen(run.sRange[0], s)
      return d <= len ? s : arcLen(s, run.sRange[0]) < arcLen(run.sRange[1], s) ? run.sRange[0] : run.sRange[1]
    }
    const postBarrierFaults = (id, side, centre, corners) => {
      const out = []
      let s0 = Infinity, s1 = -Infinity
      const ds = corners.map(([cs]) => signedDelta(centre.s, cs, L))
      for (const d of ds) { if (d < s0) s0 = d; if (d > s1) s1 = d }
      const over = linesOver(side, wrap(centre.s + s0), wrap(centre.s + s1)).filter(({ run }) => run.kind !== 'fence')
      if (!over.length) return out
      let nearest = null, nd = Infinity
      for (const r of over) {
        const d = Math.abs(centre.lateral - r.line.lat(clampS(r.run, centre.s)))
        if (d < nd) { nd = d; nearest = r }
      }
      for (const { run, line } of over) {
        let minSpec = Infinity, minAbs = Infinity
        for (const [cs, cl] of corners) {
          const l = line.lat(clampS(run, cs))
          minSpec = Math.min(minSpec, side * (cl - l))
          minAbs = Math.min(minAbs, Math.abs(cl - l))
        }
        if (run === nearest.run) {
          if (minSpec < 0.6) out.push(`${id}: ${fmt(minSpec, 2)} m ${minSpec < 0 ? 'on the track side of' : 'off'} the resolved line of its barrier run ${run.id} (needs ≥ 0.6 m on the spectator side) — O8`)
        } else if (minAbs < 0.2) out.push(`${id}: ${fmt(minAbs, 2)} m from the resolved line of barrier run ${run.id} (needs 0.2) — O5`)
      }
      return out
    }
    let slotsChecked = 0
    for (const m of bar.MARSHAL_POSTS) {
      const n = numbers.get(m)
      const type = m.type ?? 'cabin'
      const id = `marshal post ${n !== undefined ? n : m.secondary ? '(secondary)' : `(${type})`} s ${m.s}`
      const side = m.lateral >= 0 ? 1 : -1
      if (Math.abs(m.lateral) < track.halfWidthAt(m.s) + 2) fail(`${id}: lateral ${fmt(m.lateral)} is inside hw + 2 — O8`)
      if (type === 'building' && !m.osmWay && !m.size) fail(`${id}: type 'building' needs osmWay or size — O8`)
      if (m.secondary && (m.number !== undefined || type === 'building')) fail(`${id}: a secondary hut carries no number and is not a building — O8`)
      const rects = []
      if (type === 'cabin') {
        const Ls = ops.marshalStairSign(m)
        rects.push({ name: 'stand', s: wrap(m.s + (Ls * S.deckS) / 2), lateral: m.lateral, size: [S.body + S.deckS + 0.2, S.across] })
        rects.push({ name: 'stair', s: wrap(m.s + Ls * (S.body / 2 + S.deckS + 0.1 + S.stairLen / 2)), lateral: m.lateral, size: [S.stairLen, S.stairW] })
      } else if (type === 'low') rects.push({ name: 'low', s: m.s, lateral: m.lateral, size: [S.low[0], S.low[1]] })
      else if (m.size) rects.push({ name: 'building', s: m.s, lateral: m.lateral, size: m.size })
      for (const r of rects) {
        const p = { s: r.s, lateral: r.lateral, yawDeg: 0, size: r.size, mount: 'free', kind: 'cabin' }
        const corners = cornersOf(p)
        for (const f of [...envelopeFaults(`${id} ${r.name}`, p, corners), ...gridFaults(`${id} ${r.name}`, corners), ...postBarrierFaults(`${id} ${r.name}`, side, p, corners)]) fail(f)
      }
      for (const f of ops.marshalSlots(m)) {
        slotsChecked++
        for (const msg of pointFaults(`${id} slot (${f.mount})`, f.s, f.lateral)) fail(msg)
      }
    }
    notes.push(`O8: ${bar.MARSHAL_POSTS.length} marshal posts, ${numbers.size} numbered (${[...numbers.values()].sort((a, b) => a - b).join(', ')}), ${slotsChecked} marshal slots`)
  }

  // --- O9 figures --------------------------------------------------------------------------------------
  /** point in the (s, lateral) quad of a footprint's corners (even–odd, in the frame of the first corner's s) */
  const pointInCorners = (s, l, corners) => {
    const s0 = corners[0][0]
    const pts = corners.map(([cs, cl]) => [signedDelta(s0, cs, L), cl])
    const ds = signedDelta(s0, s, L)
    let inside = false
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i], b = pts[j]
      if ((a[1] > l) !== (b[1] > l) && ds < ((b[0] - a[0]) * (l - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside
    }
    return inside
  }
  const footprints = placements.filter((p) => p.mount !== 'roof').map((p) => ({ p, corners: cornersOf(p) }))
  let figureFaults = 0
  figures.forEach((f, i) => {
    const id = `figure ${i} (${f.role ?? '?'}${f.team ? ' ' + f.team : ''})`
    const mount = f.mount ?? 'free'
    const faults = mount === 'wall'
      ? (within(f.lateral, WALL_BAND.lat) && inArc(f.s, WALL_BAND.s) ? [] : [`${id}: wall figure outside the walkway band lateral ${WALL_BAND.lat.join('…')} / s ${WALL_BAND.s.join('→')} — O1`])
      : mount === 'roof' ? [] : pointFaults(id, f.s, f.lateral)
    for (const { g, path } of lensColumns) if (pointInZone(f.s, f.lateral, path.s0, path.s1, path.l0, path.l1)) faults.push(`${id}: between the chase lens and the car of block ${g} — O3`)
    // O9: outside every ops footprint (the perch frame a seated crew sits in excepted), outside the buildings
    for (const { p, corners } of footprints) {
      if (mount === 'wall' && p.kind === 'cabin' && p.mount === 'wall') continue
      if (Math.abs(f.lateral - p.lateral) > 20) continue
      if (pointInCorners(f.s, f.lateral, corners)) faults.push(`${id}: at (s ${fmt(f.s, 1)}, lateral ${fmt(f.lateral)}) stands inside the footprint of ops ${p.id} — O9`)
    }
    if (mount !== 'wall') faults.push(...buildingFaults(id, { s: f.s, lateral: f.lateral, mount }))
    if (pointInZone(f.s, f.lateral, GRID.s0, GRID.s1, -GRID.halfLat, GRID.halfLat)) faults.push(`${id}: on the grid — O4`)
    const [x, z] = worldOf(f.s, f.lateral)
    if (!ring.insideRing(x, z)) faults.push(`${id}: stands outside the circuit ring — O9`)
    faults.push(...windowFaults(id, f.s, f.mount))
    for (const m of faults) fail(m)
    if (faults.length) figureFaults++
  })

  // --- O10 INFIELD_TREES --------------------------------------------------------------------------------
  // every placement of every row, expanded by the same pure helper the runtime plants from
  // (app/data/infield-trees.ts), so what is checked is what stands; a row that expands to
  // nothing (a missing OSM way) is a fault of its own. Faults are reported once per row with
  // the count and the first three placements.
  if (spec.INFIELD_TREES) {
    const { infieldTreePlacements } = await import('../app/data/infield-trees.ts')
    const placements = infieldTreePlacements(track)
    // the swept service roads (`{ way, width }` / `{ ways }` asphaltArea rows) are paving too —
    // resolved the way ground-plan.ts resolves them (an annulus for a closed way)
    const gp = await import('../app/three/ground-plan.ts')
    const sweeps = spec.GROUND_AREAS.filter((a) => a.kind === 'asphaltArea' && ('way' in a.footprint || 'ways' in a.footprint)).map((a) => ({ name: a.name, ring: gp.resolveFootprint(track, a.footprint) })).filter((r) => r.ring)
    const inPts = (x, z, r) => { let inside = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const a = r[i], b = r[j]; if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside } return inside }
    const sweptRoadAt = (x, z) => {
      for (const { name, ring } of sweeps) {
        const b = ring.box
        if (x < b[0] || x > b[1] || z < b[2] || z > b[3]) continue
        if (inPts(x, z, ring.outer) && !ring.holes.some((h) => inPts(x, z, h))) return name
      }
      return null
    }
    // the car parks and gravel pads / shore paths (GROUND_AREAS 'paddock' / 'gravelArea', every
    // footprint shape) are no tree's ground either (vegetation.ts TREELESS_FACES; the I5 review,
    // F3: five rows planted on them) — resolved the way ground-plan.ts resolves them
    const lots = spec.GROUND_AREAS.filter((a) => a.kind === 'paddock' || a.kind === 'gravelArea').map((a) => ({ name: a.name, kind: a.kind, ring: gp.resolveFootprint(track, a.footprint) })).filter((r) => r.ring)
    const lotAt = (x, z) => {
      for (const { name, kind, ring } of lots) {
        const b = ring.box
        if (x < b[0] || x > b[1] || z < b[2] || z > b[3]) continue
        if (inPts(x, z, ring.outer) && !ring.holes.some((h) => inPts(x, z, h))) return `${kind} "${name}"`
      }
      return null
    }
    // the INFIELD_FACILITIES footprints, exactly as infield-ground.ts ringOf builds them (the OSM
    // ring, or the sized box about (s, lateral) turned by yaw) — a tree inside one grows through
    // the building / tent / compound (the I5 review, F3: two camphors through the Degner marquee)
    const facilityRings = (spec.INFIELD_FACILITIES ?? []).flatMap((f) => {
      if (f.osmWay !== undefined) { const r = worldRingOf(f.osmWay); return r ? [{ id: f.id, ring: r }] : [] }
      if (f.s === undefined || f.lateral === undefined || !f.size) return []
      const [cx, cz] = worldOf(track.wrap(f.s), f.lateral)
      const h = track.headingAt(track.wrap(f.s))
      const yaw = ((f.yaw ?? 0) * Math.PI) / 180
      const ax = h.tx * Math.cos(yaw) + h.tz * Math.sin(yaw), az = h.tz * Math.cos(yaw) - h.tx * Math.sin(yaw)
      const lx = az, lz = -ax
      const [a, b] = f.size
      return [{ id: f.id, ring: [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, w]) => ({ x: cx + (ax * u * a) / 2 + (lx * w * b) / 2, z: cz + (az * u * a) / 2 + (lz * w * b) / 2 })) }]
    })
    const facilityAt = (x, z) => { for (const { id, ring } of facilityRings) if (inWorldRing(x, z, ring)) return id; return null }
    const byRow = new Map()
    for (const p of placements) { let l = byRow.get(p.row.id); if (!l) byRow.set(p.row.id, (l = [])); l.push(p) }
    const TREE_BARRIER_CLEAR = 0.6
    for (const row of spec.INFIELD_TREES) {
      const list = byRow.get(row.id) ?? []
      if (!list.length) { fail(`infield tree row ${row.id}: expands to no placement — O10`); continue }
      const faults = new Map()
      const note = (kind, p) => { let l = faults.get(kind); if (!l) faults.set(kind, (l = [])); l.push(p) }
      for (const p of list) {
        const hw = track.halfWidthAt(p.s)
        if (Math.abs(p.lateral) < hw + 6) note('inside hw + 6', p)
        const paved = pavedApronAt(p.x, p.z) ?? sweptRoadAt(p.x, p.z)
        if (paved) note(`on the paved apron "${paved}"`, p)
        const lot = lotAt(p.x, p.z)
        if (lot) note(`on the ${lot}`, p)
        const facility = facilityAt(p.x, p.z)
        if (facility) note(`inside the footprint of facility ${facility}`, p)
        const inStand = standFootprintAt(p.x, p.z)
        if (inStand) note(`inside the footprint of stand ${inStand}`, p)
        if (!ring.insideRing(p.x, p.z)) note('outside the circuit ring', p)
        // the barrier lines (resolved in the lap frame; a tree far from the road is out of their reach)
        if (Math.abs(p.lateral) < 60) {
          for (const { run, line } of barrierLines) {
            if (run.side !== Math.sign(p.lateral)) continue
            const len = arcLen(run.sRange[0], run.sRange[1])
            const d = arcLen(run.sRange[0], p.s)
            if (d > len + 2 && d < L - 2) continue
            if (Math.abs(p.lateral - line.lat(p.s)) < TREE_BARRIER_CLEAR) { note(`within ${TREE_BARRIER_CLEAR} m of barrier run ${run.id}`, p); break }
          }
        }
      }
      for (const [kind, ps] of faults) fail(`infield tree row ${row.id}: ${ps.length} of ${list.length} placements ${kind} (${ps.slice(0, 3).map((p) => `${p.id} at s ${fmt(p.s, 0)} lat ${fmt(p.lateral, 1)}`).join('; ')}) — O10`)
    }
    notes.push(`O10: ${placements.length} infield tree placements in ${byRow.size} rows (${placements.filter((p) => p.row.deferred).length} in the deferred south job)`)
  } else skip('O10 INFIELD_TREES')

  // --- O11 PADDOCK_BUILDINGS / INFIELD_FACILITIES ------------------------------------------------------
  {
    /** fold rows: fences placed from EN only, no windowed s test */
    const FOLD_WAYS = new Set([474537488, 474537494, 474099241])
    const segHit = (a, b, c, d) => {
      const o = (p, q, r) => Math.sign((q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x))
      return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b)
    }
    const ringsCross = (r1, r2) => {
      for (let i = 0; i < r1.length; i++) for (let j = 0; j < r2.length; j++) if (segHit(r1[i], r1[(i + 1) % r1.length], r2[j], r2[(j + 1) % r2.length])) return true
      return false
    }
    for (const [table, rows] of [['PADDOCK_BUILDINGS', spec.PADDOCK_BUILDINGS], ['INFIELD_FACILITIES', spec.INFIELD_FACILITIES]]) {
      if (!rows) { skip(`O11 ${table}`); continue }
      const outlines = []
      for (const b of rows) {
        const id = `${table} ${b.id ?? b.osmWay}`
        if (b.osmWay) {
          const f = osm.osmFeature(b.osmWay)
          if (!f) { fail(`${id}: OSM way ${b.osmWay} missing from OSM_FEATURES (build-facilities.mjs --add-ways-from) — O11`); continue }
          const r = worldRingOf(b.osmWay)
          if (r) outlines.push({ id, ring: r })
          if (b.sRange && !FOLD_WAYS.has(b.osmWay)) {
            // OsmFeature.centroid is [s, lateral] (the generator's unwindowed mapping): project the ring's EN centroid instead
            let ce = 0, cn = 0
            for (const [e, n] of f.en) { ce += e / f.en.length; cn += n / f.en.length }
            const near = track.nearestOnRange(ce * track.enScale, -cn * track.enScale, b.sRange[0], b.sRange[1])
            if (!inArc(near.s, b.sRange)) fail(`${id}: centroid projects to s ${fmt(near.s, 0)} outside its window ${b.sRange.join('→')} — O11`)
          }
        }
      }
      for (let i = 0; i < outlines.length; i++) for (let j = i + 1; j < outlines.length; j++) if (ringsCross(outlines[i].ring, outlines[j].ring)) fail(`${outlines[i].id} and ${outlines[j].id}: outlines cross — O11`)
    }
  }
  for (const table of ['CUTS', 'FOOTBRIDGES']) if (!spec[table]) skip(`O6 / O11 ${table}`)
  // --- O2 / O5 / the ring on the hand-placed INFIELD_FACILITIES rows (I5-b) ---------------------------
  // (an OSM-footprint row is O11 above and §6; a fence / wall / compound is a line, so only its
  // corners' 0.2 m rule applies — O5's w/2 + 0.2 is for a box with a size)
  if (spec.INFIELD_FACILITIES) {
    let sized = 0
    for (const f of spec.INFIELD_FACILITIES) {
      if (f.osmWay !== undefined || f.s === undefined || f.lateral === undefined) continue
      sized++
      const id = `INFIELD_FACILITIES ${f.id}`
      const size = f.size ?? [1, 1]
      const p = { id: f.id, s: wrap(f.s), lateral: f.lateral, size: [size[0], size[1], f.height], yawDeg: f.yaw ?? 0, kind: f.kind, mount: 'ground' }
      const corners = cornersOf(p)
      for (const [cs, cl] of corners) if (Math.abs(cl) < track.halfWidthAt(cs) + 1.5) { fail(`${id}: corner at s ${fmt(cs, 0)} lateral ${fmt(cl)} is inside hw + 1.5 — O2`); break }
      if (f.kind === 'fence' || f.kind === 'compound' || f.kind === 'wall') {
        for (const { run, line } of barrierLines) {
          const len = arcLen(run.sRange[0], run.sRange[1])
          const d = arcLen(run.sRange[0], p.s)
          if (d > len + 5 && d < L - 5) continue
          let corner = Infinity
          for (const [cs, cl] of corners) corner = Math.min(corner, Math.abs(cl - line.lat(cs)))
          if (corner < 0.2) { fail(`${id}: a corner ${fmt(corner, 2)} m from the resolved line of barrier run ${run.id} (needs 0.2) — O5`); break }
        }
      } else for (const m of barrierFaults(id, p, corners)) fail(m)
      const [x, z] = worldOf(p.s, p.lateral)
      if (!ring.insideRing(x, z)) fail(`${id}: stands outside the circuit ring 775428456`)
    }
    notes.push(`O2 / O5 / ring on ${sized} hand-placed INFIELD_FACILITIES rows (the ${spec.INFIELD_FACILITIES.length - sized} OSM rows are O11 / §6)`)
  }

  console.log('\nops-check (§16)')
  console.log(`  ${placements.length} placement(s) (${placementFaults} with faults), ${figures.length} figure(s) (${figureFaults} with faults), ${crewChecked} crew slots of ${spec.PIT_GARAGE_COUNT} blocks, ${signsChecked} free-standing signs, ${bar.MARSHAL_POSTS.length} marshal posts, ${barrierLines.length} barrier lines, ${buildingRings.length} building footprints, ${WINDOWS.length} windows`)
  console.log(`  PIT_ENVELOPE: stop ${stop}, box strip ${fmt(E.boxStrip[0], 1)}→${fmt(E.boxStrip[1], 1)}, lanes [${E.lanes.join(', ')}], work area [${E.workArea.join(', ')}], chase lens column ${E.chaseLens.columnS.join('/')} m back × ±${E.chaseLens.halfLat} m, max ${E.chaseLens.maxH} m`)
  for (const n of notes) console.log(`  - ${n}`)
}

// ---------------------------------------------------------------- summary
console.log('\nstand      side s-range        row-1 lateral  clear   depth  rows struct    osm')
for (const r of rows) console.log(`${r.id.padEnd(10)} ${String(r.side).padStart(2)}   ${r.s.padEnd(13)} ${r.front.padEnd(14)} ${r.clear.padStart(6)} ${r.depth.padStart(7)}  ${String(r.rows).padStart(3)}  ${r.struct.padEnd(9)} ${r.osm}`)
console.log(`\n${spec.STANDS.length} stands, ${spec.RUNOFF_ZONES.length} run-off zones, ${osm.OSM_FEATURES.length} OSM features (extract ${osm.OSM_EXTRACT_DATE})`)
console.log(`garages: ${spec.GARAGE_ORDER.map((t, i) => `${i + 1} ${t} @${fmt(spec.garageS(i))}`).join(', ')}, 12 (empty) @${fmt(spec.garageS(11))}`)

if (warnings.length) console.log(`\n${warnings.length} warning(s):\n  - ${warnings.join('\n  - ')}`)
if (errors.length) {
  console.log(`\n${errors.length} error(s):\n  - ${errors.join('\n  - ')}`)
  process.exit(1)
}
console.log(`\nfacilities-check: OK${STRICT ? ' (strict)' : ''}`)
