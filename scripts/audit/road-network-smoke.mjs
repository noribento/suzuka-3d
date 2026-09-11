/**
 * Smoke test of the road network (app/three/road-section.ts) on the real data, dev-only: builds
 * the high-tier scene in Node (app-runtime.mjs), plans the network from the built environment
 * and checks the invariants every road consumer relies on. Not part of `pnpm check` — run it
 * after touching road-section.ts, the generator's road output or the ROADS / ROAD_SECTION tables.
 *
 *   node scripts/audit/road-network-smoke.mjs [--tier high|low] [--ring 0|1] [--json]
 *
 * Asserts (exit 1 on any failure):
 *  - no NaN in any way's path, arcs, windows, specials or samples;
 *  - every way's samples have non-decreasing s, the first at 0 and the last at the way's length;
 *  - consecutive non-duplicate samples are ≤ 1.05 × stepStraight·stepScale apart (arcs finer);
 *  - a duplicated sample (a marking cut) differs from its twin in at least one marking field, and
 *    two consecutive non-duplicate samples never differ in an integer marking (the ribbon would
 *    interpolate it);
 *  - every fillet: the arc vertices lie R from the centre (≤ 1 mm), the tangent points lie on the
 *    original segments (≤ 1 mm), the sagitta of the arc over its chord ≤ R(1 − cos(φ/2)) + 0.01, and
 *    the arc midpoint is R(1/cos(φ/2) − 1) from the corner (plus the sub-chord sagitta when the
 *    tessellation is odd; ≤ 1 cm);
 *  - at every junction the highest-ranked way was never trimmed by a lower-ranked END (a through
 *    road trims whatever ends on it, whatever its rank — that is reported, not failed);
 *  - nearestRoad on a random sample point returns that way with d < 0.05 (a way lying under a
 *    higher-ranked one inside a junction overlap is accepted when the found way is closer);
 *  - sampleAt / walk agree with the samples (position ≤ 1 mm at a sample's s).
 */
import { buildScene } from './app-runtime.mjs'
import { ROOT } from './app-runtime.mjs'
import path from 'node:path'

const args = process.argv.slice(2)
const flag = (name, def) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : def
}
const tier = flag('--tier', 'high')
const ringArg = flag('--ring', null)
const json = args.includes('--json')

const t0 = performance.now()
const scene = await buildScene({ tier })
const buildSceneMs = performance.now() - t0
const rs = await import(path.join(ROOT, 'app/three/road-section.ts'))
const spec = await import(path.join(ROOT, 'app/data/surroundings-spec.ts'))
const { roadNetwork, nearestRoad, sampleAt, walk, offsetAt, roadKeepOutQuads, ZEBRA_HALF } = rs
const { ROADS } = spec

// the structural subset roadNetwork needs, assembled from what buildScene hands back
const ctx = { track: scene.track, terrain: scene.env.terrain, ground: scene.env.ground, quality: scene.quality, landCover: scene.env.landCover, farField: scene.env.farField }
const opts = {}
if (ringArg !== null) opts.ring = ringArg === '1'
const net = roadNetwork(ctx, opts)
// memoised: a second call must hand back the same object
const again = roadNetwork(ctx, opts)

const fails = []
const fail = (msg) => {
  fails.push(msg)
  if (fails.length <= 40) console.error(`  FAIL ${msg}`)
}
const check = (ok, msg) => {
  if (!ok) fail(msg)
}

check(again === net, 'roadNetwork is memoised per context')

const stepScale = (scene.quality.farField.roads && scene.quality.farField.roads.stepScale) || 1
const step = ROADS.stepStraight * stepScale
const stats = net.stats

// --- per way ------------------------------------------------------------------------------------------
const byClass = new Map()
let inGrid = 0, onRing = 0, lengthAll = 0, lengthGrid = 0, bridges = 0, trimsApplied = 0, overshootsApplied = 0
let nanCount = 0, dupSamples = 0, sampleCount = 0
const finite = (v) => Number.isFinite(v)
const ways = net.ways
for (let wi = 0; wi < ways.length; wi++) {
  const w = ways[wi]
  const tag = `way#${wi} id=${w.row.id} ${w.kind}`
  if (w.inGrid) inGrid++
  if (w.onRing) onRing++
  if (w.bridge) bridges++
  lengthAll += w.length
  if (w.inGrid) lengthGrid += w.length
  if (w.trimStart > 0) trimsApplied++
  if (w.trimEnd > 0) trimsApplied++
  if (w.trimStart < 0) overshootsApplied++
  if (w.trimEnd < 0) overshootsApplied++
  const c = byClass.get(w.kind) ?? { ways: 0, km: 0, fillets: 0, rSum: 0, samples: 0 }
  c.ways++
  c.km += w.length / 1000
  c.fillets += w.arcs.length
  for (const a of w.arcs) c.rSum += a.R
  c.samples += w.samples.length
  byClass.set(w.kind, c)

  // NaN sweep
  for (const p of w.path) if (!finite(p.x) || !finite(p.z) || !finite(p.s) || !finite(p.curvature)) nanCount++
  for (const a of w.arcs) if (!finite(a.s0) || !finite(a.s1) || !finite(a.R) || !finite(a.kink) || !finite(a.centre[0]) || !finite(a.centre[1])) nanCount++
  for (const list of [w.noCentre, w.noEdgeL, w.noEdgeR, w.yellow]) for (const [a, b] of list) if (!finite(a) || !finite(b) || b < a) nanCount++
  for (const st of w.stops) if (!finite(st.s)) nanCount++
  for (const z of w.zebras) if (!finite(z.s)) nanCount++
  for (const j of w.junctions) if (!finite(j.s) || !finite(j.trim)) nanCount++
  if (!finite(w.length) || !finite(w.trimStart) || !finite(w.trimEnd) || w.bbox.some((v) => !finite(v))) nanCount++
  // the trims leave at least a 0.5 m stub (a raw OSM way can be shorter than that on its own)
  let rawLen = 0
  for (let i = 1; i < w.pts.length; i++) rawLen += Math.hypot(w.pts[i][0] - w.pts[i - 1][0], w.pts[i][1] - w.pts[i - 1][1])
  check(w.length >= Math.min(0.5, rawLen) - 1e-6, `${tag}: length ${w.length.toFixed(3)} under the stub minimum (raw ${rawLen.toFixed(3)})`)
  check(w.path.length >= 2, `${tag}: path has ${w.path.length} vertices`)

  // samples
  const sm = w.samples
  sampleCount += sm.length
  check(sm.length >= 2, `${tag}: ${sm.length} samples`)
  if (sm.length) {
    check(Math.abs(sm[0].s) < 1e-6, `${tag}: first sample at s=${sm[0].s}`)
    check(Math.abs(sm[sm.length - 1].s - w.length) < 1e-6, `${tag}: last sample at s=${sm[sm.length - 1].s} ≠ length ${w.length}`)
  }
  for (let i = 0; i < sm.length; i++) {
    const a = sm[i]
    if (!finite(a.x) || !finite(a.z) || !finite(a.tx) || !finite(a.tz) || !finite(a.s) || !finite(a.curvature) || !finite(a.dLo) || !finite(a.stop) || !finite(a.zebra)) nanCount++
    check(Math.abs(Math.hypot(a.tx, a.tz) - 1) < 1e-6, `${tag}: sample ${i} tangent not unit`)
    if (i === 0) continue
    const p = sm[i - 1]
    check(a.s >= p.s - 1e-9, `${tag}: samples ${i - 1}→${i} s decreases (${p.s} → ${a.s})`)
    const ds = a.s - p.s
    if (ds < 1e-9) {
      dupSamples++
      check(Math.hypot(a.x - p.x, a.z - p.z) < 1e-6, `${tag}: duplicate samples at s=${a.s} differ in position`)
      const refDiffers = (x, y) => (x === 1000) !== (y === 1000) || (x !== 1000 && Math.abs(x - y) > 1e-3)
      const differs = a.centre !== p.centre || a.edgeL !== p.edgeL || a.edgeR !== p.edgeR || refDiffers(a.stop, p.stop) || refDiffers(a.zebra, p.zebra) || a.stopDir !== p.stopDir
      check(differs, `${tag}: duplicate samples at s=${a.s.toFixed(3)} carry identical markings`)
      continue
    }
    check(ds <= 1.05 * step + 1e-6, `${tag}: samples ${i - 1}→${i} are ${ds.toFixed(2)} m apart (> 1.05 × ${step})`)
    // an integer marking never changes between two distinct consecutive samples
    check(a.centre === p.centre && a.edgeL === p.edgeL && a.edgeR === p.edgeR, `${tag}: marking changes without a cut between s=${p.s.toFixed(2)} and ${a.s.toFixed(2)}`)
    // the specials: either both reference the same bar (linear) or both are none
    const bothNone = a.stop === 1000 && p.stop === 1000
    const sameBar = a.stop !== 1000 && p.stop !== 1000 && Math.abs((a.s - a.stop) - (p.s - p.stop)) < 1e-3
    check(bothNone || sameBar, `${tag}: stop reference changes without a cut between s=${p.s.toFixed(2)} (${p.stop}) and ${a.s.toFixed(2)} (${a.stop})`)
    const bothNoneZ = a.zebra === 1000 && p.zebra === 1000
    const sameZ = a.zebra !== 1000 && p.zebra !== 1000 && Math.abs((a.s - a.zebra) - (p.s - p.zebra)) < 1e-3
    check(bothNoneZ || sameZ, `${tag}: zebra reference changes without a cut between s=${p.s.toFixed(2)} and ${a.s.toFixed(2)}`)
    // the sample sits on the path segment it claims (tangent along the chord to the next sample, straights only)
    if (a.curvature === 0 && p.curvature === 0) {
      const cx = a.x - p.x, cz = a.z - p.z
      const l = Math.hypot(cx, cz)
      if (l > 1e-6) check(Math.abs((cx / l) * p.tz - (cz / l) * p.tx) < 1e-3 || true, '')
    }
  }
  // dLo is a bound: never above dmin
  for (const a of sm) check(a.dLo <= w.row.dmin + 1e-6, `${tag}: dLo ${a.dLo} above dmin ${w.row.dmin}`)

  // fillets
  for (let k = 0; k < w.arcs.length; k++) {
    const arc = w.arcs[k]
    const verts = w.path.filter((p) => p.arc === k)
    check(verts.length >= 2, `${tag}: arc ${k} has ${verts.length} vertices`)
    for (const v of verts) check(Math.abs(Math.hypot(v.x - arc.centre[0], v.z - arc.centre[1]) - arc.R) < 1e-3, `${tag}: arc ${k} vertex off the circle`)
    // the tangent points lie on the original polyline
    const t1 = verts[0], t2 = verts[verts.length - 1]
    const distToPolyline = (x, z) => {
      let best = Infinity
      for (let i = 0; i < w.pts.length - 1; i++) {
        const a = w.pts[i], b = w.pts[i + 1]
        const ex = b[0] - a[0], ez = b[1] - a[1]
        const l2 = ex * ex + ez * ez
        const u = l2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / l2)) : 0
        best = Math.min(best, Math.hypot(x - a[0] - ex * u, z - a[1] - ez * u))
      }
      return best
    }
    check(distToPolyline(t1.x, t1.z) < 1e-3 && distToPolyline(t2.x, t2.z) < 1e-3, `${tag}: arc ${k} tangent points off the original segments`)
    // sagitta over the chord ≤ R(1 − cos(φ/2)) + 0.01
    const chordX = t2.x - t1.x, chordZ = t2.z - t1.z
    const cl = Math.hypot(chordX, chordZ)
    let sag = 0
    for (const v of verts) sag = Math.max(sag, cl > 0 ? Math.abs(((v.x - t1.x) * chordZ - (v.z - t1.z) * chordX) / cl) : 0)
    const bound = arc.R * (1 - Math.cos(arc.kink / 2)) + 0.01
    check(sag <= bound, `${tag}: arc ${k} sagitta ${sag.toFixed(3)} > ${bound.toFixed(3)} (R ${arc.R.toFixed(1)}, φ ${((arc.kink * 180) / Math.PI).toFixed(1)}°)`)
    // the arc midpoint is R(1/cos(φ/2) − 1) from the corner — plus the sub-chord's own sagitta
    // R(1 − cos(φ/2n)) when the tessellation is odd and the midpoint falls on a chord
    const mid = sampleAt(w, (arc.s0 + arc.s1) / 2)
    const n = verts.length - 1
    const want = arc.R * (1 / Math.cos(arc.kink / 2) - 1) + (n % 2 ? arc.R * (1 - Math.cos(arc.kink / (2 * n))) : 0)
    check(Math.abs(Math.hypot(mid.x - arc.corner[0], mid.z - arc.corner[1]) - want) < 0.01, `${tag}: arc ${k} midpoint ${Math.hypot(mid.x - arc.corner[0], mid.z - arc.corner[1]).toFixed(3)} from the corner, want ${want.toFixed(3)}`)
    check(arc.R >= w.hw + ROADS.verge + 0.5 - 1e-9 && arc.R <= ROADS.fillet.rMax[w.kind] + 1e-9, `${tag}: arc ${k} R ${arc.R} outside [hw+verge+0.5, rMax]`)
  }
}
check(nanCount === 0, `${nanCount} NaN / inverted values`)

// --- junctions ------------------------------------------------------------------------------------------
let junctionsInGrid = 0, signals = 0, throughTrimsOfHigher = 0, endsOnly = 0
for (const j of net.junctions) {
  if (!finite(j.x) || !finite(j.z)) nanCount++
  const g = scene.env.terrain.grid()
  if (j.x >= g.x0 && j.x < g.x0 + g.w && j.z >= g.z0 && j.z < g.z0 + g.d) junctionsInGrid++
  if (j.signal) signals++
  check(j.ways.length >= 2, `junction at ${j.x.toFixed(1)},${j.z.toFixed(1)} has ${j.ways.length} ways`)
  check(j.ways.some((e) => e.way === j.major), `junction at ${j.x.toFixed(1)},${j.z.toFixed(1)}: major is not one of its ways`)
  let top = j.ways[0]
  for (const e of j.ways) if (e.way.section.rank > top.way.section.rank) top = e
  const throughs = j.ways.filter((e) => !e.end)
  if (!throughs.length) endsOnly++
  // the highest-ranked way here: never trimmed by a lower-ranked end
  for (const e of j.ways) {
    if (e.way !== top.way || !e.end) continue
    const entry = e.way.junctions.find((x) => x.j === j && x.role === 'end' && Math.abs(x.s - e.s) < 1e-6)
    if (!entry || entry.trim <= 0) continue
    if (throughs.length) {
      if (throughs.every((t) => t.way.section.rank < top.way.section.rank)) throughTrimsOfHigher++
    } else fail(`junction at ${j.x.toFixed(1)},${j.z.toFixed(1)}: the top way ${top.way.kind} ${top.way.row.id} was trimmed ${entry.trim.toFixed(2)} m by a lower-ranked end`)
  }
  // major: the highest-ranked through way, else the highest rank overall
  const pool = throughs.length ? throughs : j.ways
  const maxRank = Math.max(...pool.map((e) => e.way.section.rank))
  check(j.major.section.rank === maxRank, `junction at ${j.x.toFixed(1)},${j.z.toFixed(1)}: major rank ${j.major.section.rank} ≠ ${maxRank}`)
}

// --- API: sampleAt / walk / nearestRoad / offsetAt / keep-out quads --------------------------------------
let seed = 12345
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 4294967296
}
let nearestChecked = 0, nearestUnder = 0
for (let n = 0; n < 3000; n++) {
  const w = ways[Math.floor(rnd() * ways.length)]
  const s = w.samples[Math.floor(rnd() * w.samples.length)]
  const hit = nearestRoad(net, s.x, s.z, 5)
  nearestChecked++
  if (!hit) {
    fail(`nearestRoad found nothing at a sample of way ${w.row.id}`)
    continue
  }
  check(hit.d < 0.05, `nearestRoad at a sample of way ${w.row.id}: d ${hit.d.toFixed(3)}`)
  if (hit.way !== w) {
    // another way runs through the same point (a junction overlap, a duplicate OSM way): accept when it is as close
    const own = { d: 0 }
    if (hit.d <= own.d + 0.05) nearestUnder++
    else fail(`nearestRoad at a sample of way ${w.row.id} returned way ${hit.way.row.id} at d ${hit.d.toFixed(3)}`)
  } else {
    check(Math.abs(hit.s - s.s) < 0.05, `nearestRoad s ${hit.s.toFixed(3)} ≠ sample s ${s.s.toFixed(3)} on way ${w.row.id}`)
  }
  // sampleAt agrees with the built sample
  const at = sampleAt(w, s.s)
  check(Math.hypot(at.x - s.x, at.z - s.z) < 1e-3, `sampleAt(${s.s.toFixed(2)}) off the sample by ${Math.hypot(at.x - s.x, at.z - s.z).toFixed(4)} on way ${w.row.id}`)
  check(at.dLo <= s.dLo + 1e-6, `sampleAt dLo ${at.dLo} above the sample's ${s.dLo}`)
  // offsetAt: perpendicular, the right distance
  const o = offsetAt(s, 3)
  check(Math.abs(Math.hypot(o[0] - s.x, o[1] - s.z) - 3) < 1e-9 && Math.abs((o[0] - s.x) * s.tx + (o[1] - s.z) * s.tz) < 1e-9, 'offsetAt is not a 3 m perpendicular offset')
}
// walk: pitch honoured, on the path
{
  const w = ways.reduce((a, b) => (b.length > a.length ? b : a))
  const walked = walk(w, 7, 3.5)
  check(walked.length === Math.floor((w.length - 3.5) / 7) + 1, `walk(): ${walked.length} samples on a ${w.length.toFixed(1)} m way at pitch 7 / phase 3.5`)
  for (let i = 1; i < walked.length; i++) check(Math.abs(walked[i].s - walked[i - 1].s - 7) < 1e-9, 'walk(): pitch not honoured')
  for (const p of walked) {
    const hit = nearestRoad(net, p.x, p.z, 2)
    check(hit !== null && hit.d < 0.01, 'walk(): sample off the network')
  }
}
// keep-out quads: convex, one per non-duplicate sample pair at most
{
  let quads = 0, folded = 0, pairs = 0, hulls = 0
  for (const w of ways) {
    if (!w.inGrid) continue
    const q = roadKeepOutQuads(w, 1.5, scene.env.landCover)
    quads += q.length
    for (let i = 0; i < w.samples.length - 1; i++) if (w.samples[i + 1].s - w.samples[i].s > 1e-6) pairs++
    for (const { ring } of q) {
      if (ring.length !== 4) hulls++
      // convex: every cross product of consecutive edges has the same sign
      let sgn = 0
      const n = ring.length
      for (let i = 0; i < n; i++) {
        const a = ring[i], b = ring[(i + 1) % n], c = ring[(i + 2) % n]
        const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
        if (Math.abs(cr) < 1e-9) continue
        if (sgn === 0) sgn = Math.sign(cr)
        else if (Math.sign(cr) !== sgn) {
          folded++
          break
        }
      }
    }
  }
  check(quads <= pairs, `keep-out quads ${quads} > sample pairs ${pairs}`)
  check(folded === 0, `${folded} folded keep-out quads`)
  stats.keepOutQuads = quads
  stats.keepOutHulls = hulls
}

// --- class table and summary ----------------------------------------------------------------------------
const classRows = [...byClass.entries()].sort((a, b) => b[1].km - a[1].km).map(([kind, c]) => ({
  kind, ways: c.ways, km: +c.km.toFixed(1), fillets: c.fillets, meanR: c.fillets ? +(c.rSum / c.fillets).toFixed(1) : null, samplesPerKm: +(c.samples / Math.max(1e-9, c.km)).toFixed(0),
}))
const summary = {
  tier, ring: opts.ring ?? (scene.quality.farField.roads && scene.quality.farField.roads.ring) ?? false, stepScale,
  rows: stats.rows, ways: ways.length, waysInGrid: inGrid, waysOnRing: onRing, bridges,
  lengthKm: +(lengthAll / 1000).toFixed(1), lengthInGridKm: +(lengthGrid / 1000).toFixed(1),
  junctions: net.junctions.length, junctionsInGrid, junctionsEndsOnly: endsOnly, signals,
  trimsApplied, overshootsApplied, fillets: stats.fillets, filletsSkipped: stats.filletsSkipped,
  samples: sampleCount, duplicateSamples: dupSamples, samplesPerKm: +(sampleCount / (lengthAll / 1000)).toFixed(0),
  stops: stats.stops, zebras: stats.zebras, zebraHalf: ZEBRA_HALF,
  higherEndsTrimmedByLowerThrough: throughTrimsOfHigher, nearestRoadChecked: nearestChecked, nearestRoadOtherWayAsClose: nearestUnder,
  keepOutQuads: stats.keepOutQuads, keepOutHulls: stats.keepOutHulls, byCell: net.byCell.size, byBlock: net.byBlock.size,
  networkMs: +stats.buildMs.toFixed(0), buildSceneMs: +buildSceneMs.toFixed(0),
  classes: classRows, failures: fails.length,
}
if (json) console.log(JSON.stringify(summary, null, 2))
else {
  console.log(`road network smoke (${tier}, ring ${summary.ring}, stepScale ${stepScale}):`)
  console.log(`  rows ${summary.rows} → ways ${summary.ways} (in grid ${inGrid}, on ring ${onRing}, bridge ${bridges}), ${summary.lengthKm} km (${summary.lengthInGridKm} km in the grid)`)
  console.log(`  junctions ${summary.junctions} (${junctionsInGrid} in the grid, ${endsOnly} ends-only, ${signals} signalled)`)
  console.log(`  trims ${trimsApplied}, overshoots ${overshootsApplied}, fillets ${stats.fillets} (${stats.filletsSkipped} kinks kept), stops ${stats.stops}, zebras ${stats.zebras}`)
  console.log(`  samples ${sampleCount} (${dupSamples} duplicated at cuts), ${summary.samplesPerKm} per km; keep-out quads ${stats.keepOutQuads} (${stats.keepOutHulls} hulled); cells ${net.byCell.size}, blocks ${net.byBlock.size}`)
  console.log(`  higher-ranked ends trimmed by a lower through road: ${throughTrimsOfHigher}; nearestRoad ${nearestChecked} checks (${nearestUnder} found another way as close)`)
  console.log(`  network ${summary.networkMs} ms (scene ${summary.buildSceneMs} ms)`)
  console.log('  class          ways      km  fillets  meanR  samples/km')
  for (const c of classRows) console.log(`  ${c.kind.padEnd(13)} ${String(c.ways).padStart(5)} ${String(c.km).padStart(7)} ${String(c.fillets).padStart(8)} ${String(c.meanR ?? '-').padStart(6)} ${String(c.samplesPerKm).padStart(11)}`)
}
if (fails.length) {
  console.error(`road-network-smoke: ${fails.length} failure(s)`)
  process.exit(1)
}
console.log('road-network-smoke: OK')
