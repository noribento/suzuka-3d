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
 *      garageS(0) sits inside the pit building.
 *   4. GARAGE_ORDER ⊂ TEAM_ORDER and the same size.
 *   5. Track.enScale equals an independent re-computation of the centreline pipeline, and the
 *      OSM raceway loop maps onto the app centreline within the registration tolerance.
 *   6. Every OSM stand id referenced by the spec / mapping exists in the extract.
 *   A10. Every stand's front is screened by a fence-carrying BARRIERS run (world space, ≥ 95 %).
 *   A11. SCREENS / SIGNS / LEADER_TOWER clear the road, the stand footprints and the pit lane;
 *        boards only on concrete runs; UNDERPASSES reference 'road' ways.
 */
import './ts-hooks.mjs'

const { Track } = await import('../app/sim/track.ts')
const { CIRCUIT, CENTERLINE_EN } = await import('../app/data/suzuka.ts')
const { TEAM_ORDER } = await import('../app/data/drivers.ts')
const spec = await import('../app/data/suzuka-facilities-spec.ts')
const osm = await import('../app/data/suzuka-facilities.ts')

const STRICT = process.argv.includes('--strict')
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
  if (!inArc(wrap(c - spec.PIT_GARAGE_PITCH / 2), bld) || !inArc(wrap(c + spec.PIT_GARAGE_PITCH / 2), bld)) fail(`garage ${g + 1} (s ${fmt(c)}) is outside the pit building ${bld[0]}→${bld[1]}`)
}
if (osm.OSM_PIT_BUILDING) {
  const f = osm.OSM_PIT_BUILDING
  if (Math.abs(f.lateral[1] - spec.PIT_GARAGE_FRONT) > 1.5) fail(`PIT_GARAGE_FRONT ${spec.PIT_GARAGE_FRONT} vs OSM pit-lane face ${f.lateral[1]}`)
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
for (const [name, id] of [['pit building', spec.PIT_BUILDING.osmWay], ['Ferris wheel', 184107083], ['leader tower', 469636517], ...spec.WATER.map((w) => [w.name, w.osmWay]), ...spec.BUILDINGS.filter((b) => b.osmWay).map((b) => [b.id, b.osmWay])]) {
  if (!osm.osmFeature(id)) fail(`${name}: OSM way ${id} missing from OSM_FEATURES`, true)
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
for (const b of bar.BASINS) if (!osm.osmFeature(b.osmWay)) fail(`basin "${b.name}": OSM way ${b.osmWay} missing`)

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
 * lane runs; `boards` only on concrete runs (the boards hang on a wall face).
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
    ...bar.SIGNS.map((sg) => {
      let k = 0
      for (let d = -40; d <= 40; d += 10) k += track.kappaAt(sg.s + d)
      const side = Math.abs(k) < 1e-4 ? 1 : k > 0 ? -1 : 1
      return { id: `sign ${sg.id}`, s: sg.s, lateral: sg.lateral === 'cameraSide' ? side * (track.halfWidthAt(sg.s) + 3.2) : sg.lateral }
    }),
    { id: 'LEADER_TOWER', s: spec.LEADER_TOWER.s, lateral: spec.LEADER_TOWER.lateral },
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
  const CAP = 1024 * 1024
  if (surBytes + demBytes > CAP) fail(`suzuka-surroundings.ts (${surBytes}) + suzuka-dem.ts (${demBytes}) = ${surBytes + demBytes} bytes, over the ${CAP} byte cap`)

  console.log('\nsurroundings')
  console.log('layer          count  vertices')
  for (const r of layerRows) console.log(`${r.layer.padEnd(14)} ${String(r.count).padStart(5)}  ${String(r.verts).padStart(8)}`)
  console.log(`extract ${sur.SUR_EXTRACT_DATE}, SUR_RECT [${sur.SUR_RECT.join(', ')}]`)
  console.log(`bytes: surroundings ${surBytes} + dem ${demBytes} = ${surBytes + demBytes} of ${CAP} (${((100 * (surBytes + demBytes)) / CAP).toFixed(1)} %)`)
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
