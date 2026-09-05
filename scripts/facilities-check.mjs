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
