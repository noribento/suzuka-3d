#!/usr/bin/env node
/**
 * Smoke test of `cellClippedStrip` / `StripSink` (app/three/far-geometry.ts) on the real terrain,
 * in plain Node through app-runtime.mjs — dev-only, NOT part of `pnpm check` (it builds the whole
 * scene, ≈ 20 s). Run it after touching the strip, the clipper or the drape:
 *
 *   node scripts/audit/strip-smoke.mjs [--tier high|low] [--verbose]
 *
 *  (1) a 3-row strip (lateral −3.5 / 0 / +3.5) along a 400 m arc of R 150 m inside the inner
 *      grid, ≥ 200 m from the track: no quad dropped or folded; every vertex at
 *      `ground.standY + lift` (< 1e-4 m); boundary edges only along the two outer rows and the
 *      two ends (their length ≈ the outline, no stray edge inside); every triangle facing +Y;
 *      `across` within ±0.02 m of the chord-frame lateral at ≥ 95 % of the vertices and `along`
 *      within 0.05 m of R·θ (monotone along the arc); two block windows partition the cells
 *      exactly (Σ triangles = the unwindowed run); a `poolKey` change duplicates the boundary.
 *  (2) the same strip rigid (`rigidY`): two triangles per quad, corners at the given heights.
 *  (3) a straight strip across the circuit: quads inside ROADS.minD (76 m) or on drawn ground
 *      faces are dropped, and no surviving vertex is closer than minD to the centreline.
 *  (4) a strip on the coarse ring with `drape: 'nodes'` crossing the inner rectangle: every
 *      vertex lies on the ring's own b–c-diagonal triangle (recomputed here from
 *      `terrain.ring.heights`), none inside the hole, and the default `nodeY` (standY at the
 *      nodes) gives the same heights as the ring's node table.
 *
 * Exit 1 on any failure.
 */
import path from 'node:path'
import { buildScene, ROOT } from './app-runtime.mjs'

const args = process.argv.slice(2)
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d }
const tier = flag('--tier', 'high')
const verbose = args.includes('--verbose')
if (tier !== 'high' && tier !== 'low') { console.error('--tier high|low'); process.exit(2) }

const t0 = performance.now()
const scene = await buildScene({ tier })
const { terrain, ground, plan } = scene
const fg = await import(path.join(ROOT, 'app/three/far-geometry.ts'))
const { ROADS } = await import(path.join(ROOT, 'app/data/surroundings-spec.ts'))
console.log(`strip-smoke: ${tier} — scene built in ${((performance.now() - t0) / 1000).toFixed(1)} s`)

// ---------------------------------------------------------------- harness
let failures = 0
const check = (test, name, ok, detail) => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${test} ${name}${detail ? ` — ${detail}` : ''}`)
}
const info = (msg) => { if (verbose) console.log(`       ${msg}`) }

/** geometry → plain arrays + per-triangle helpers */
const unpack = (geo) => {
  const pos = geo.getAttribute('position').array
  const idx = geo.getIndex().array
  const n = pos.length / 3
  const attrs = {}
  for (const name of Object.keys(geo.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') attrs[name] = geo.getAttribute(name)
  return { pos, idx, n, tris: idx.length / 3, attrs }
}

/** boundary edges (used once) of an indexed mesh: [a, b] index pairs */
const boundaryEdges = ({ idx }) => {
  const count = new Map()
  for (let t = 0; t < idx.length; t += 3) {
    for (const [u, v] of [[idx[t], idx[t + 1]], [idx[t + 1], idx[t + 2]], [idx[t + 2], idx[t]]]) {
      const k = Math.min(u, v) * 16777216 + Math.max(u, v)
      count.set(k, (count.get(k) ?? 0) + 1)
    }
  }
  const out = []
  for (const [k, c] of count) if (c === 1) out.push([Math.floor(k / 16777216), k % 16777216])
  return out
}

/** triangles whose geometric normal points down (or is flat) */
const downFacing = ({ pos, idx }) => {
  let bad = 0
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2]
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2]
    const ny = uz * vx - ux * vz
    if (!(ny > 0)) bad++
  }
  return bad
}

/** nearest point on an open polyline: chord-length parameter t, distance d, side (+1 = left of travel, the `offsetAt` convention) */
const polyProject = (pts, x, z) => {
  let best = Infinity, bestT = 0, side = 0, walked = 0
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1]
    const ex = b[0] - a[0], ez = b[1] - a[1]
    const l2 = ex * ex + ez * ez
    const u = Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / l2))
    const fx = a[0] + ex * u, fz = a[1] + ez * u
    const d2 = (x - fx) ** 2 + (z - fz) ** 2
    if (d2 < best) {
      best = d2
      bestT = walked + Math.sqrt(l2) * u
      // left of travel: x − tz·lat, z + tx·lat → lat = ((z − fz)·tx − (x − fx)·tz) / |t|
      side = Math.sign((z - fz) * ex - (x - fx) * ez)
    }
    walked += Math.sqrt(l2)
  }
  return { t: bestT, d: Math.sqrt(best), side }
}

const grid = terrain.grid()
const gcx = grid.x0 + grid.w / 2, gcz = grid.z0 + grid.d / 2
const inGrid = (x, z, m = 0) => x >= grid.x0 + m && z >= grid.z0 + m && x < grid.x0 + grid.w - m && z < grid.z0 + grid.d - m
const LIFT = ROADS.lift

// ---------------------------------------------------------------- (1) the arc strip
console.log('(1) arc strip, drape mesh')
const R = 150, ARC = 400, STEP = 10
const OFF = [-3.5, 0, 3.5]
const nS = Math.round(ARC / STEP) + 1
let arc = null
for (const [ox, oz] of [[1000, 0], [-1000, 0], [0, 900], [0, -900], [900, 700], [-900, -700], [900, -700], [-900, 700]]) {
  const cx = gcx + ox, cz = gcz + oz
  const rows = OFF.map((off) => Array.from({ length: nS }, (_, i) => {
    const th = (i * STEP) / R
    return [cx + (R + off) * Math.cos(th), cz + (R + off) * Math.sin(th)]
  }))
  let ok = true, dMin = Infinity
  for (const row of rows) for (const [x, z] of row) {
    if (!inGrid(x, z, 30) || ground.builtY(x, z)) { ok = false; break }
    dMin = Math.min(dMin, plan.project(x, z).d)
  }
  if (ok && dMin >= 200) { arc = { cx, cz, rows, dMin }; break }
}
if (!arc) { console.error('no arc site found ≥ 200 m from the track inside the grid'); process.exit(1) }
info(`arc centre (${arc.cx.toFixed(0)}, ${arc.cz.toFixed(0)}), nearest centreline ${arc.dMin.toFixed(0)} m`)

// `across` is the lateral in the codebase's convention (+ = left of travel): on a CCW arc the outward radial offset is to the right
const LAT = OFF.map((off) => -off)
const arcInput = (extra = {}) => ({
  rows: arc.rows,
  lift: () => LIFT,
  attr: (r, i, out) => { out[0] = i * STEP; out[1] = LAT[r] },
  ...extra,
})
const arcOpts = (extra = {}) => ({ grid, drape: 'mesh', ground, plan, minD: ROADS.minD, cache: fg.makeNodeCache(grid), ...extra })
const LAYOUT = [{ name: 'aTest', size: 2 }]

const sink1 = new fg.StripSink(LAYOUT)
sink1.begin(1)
const tA = performance.now()
const st1 = fg.cellClippedStrip(sink1, arcInput(), arcOpts())
const geo1 = sink1.build()
info(`stats ${JSON.stringify(st1)} in ${(performance.now() - tA).toFixed(0)} ms, ${sink1.vertices} vertices`)
check('(1)', 'geometry built', !!geo1)
check('(1)', 'no drop / fold', st1.dropped === 0 && st1.folded === 0, `dropped ${st1.dropped}, folded ${st1.folded}`)
check('(1)', 'every quad produced geometry', st1.quads === (OFF.length - 1) * (nS - 1), `${st1.quads} of ${(OFF.length - 1) * (nS - 1)}`)
check('(1)', 'stats.triangles = sink.triangles', st1.triangles === sink1.triangles, `${st1.triangles} vs ${sink1.triangles}`)
if (geo1) {
  const m = unpack(geo1)
  check('(1)', 'attribute present', m.attrs.aTest && m.attrs.aTest.itemSize === 2 && m.attrs.aTest.count === m.n)
  check('(1)', 'uv = world (x, z)', (() => { const uv = geo1.getAttribute('uv').array; for (let i = 0; i < m.n; i++) if (uv[i * 2] !== m.pos[i * 3] || uv[i * 2 + 1] !== m.pos[i * 3 + 2]) return false; return true })())
  // (a) drape
  let yBad = 0, yMax = 0
  for (let i = 0; i < m.n; i++) {
    const x = m.pos[i * 3], y = m.pos[i * 3 + 1], z = m.pos[i * 3 + 2]
    const e = Math.abs(y - (ground.standY(x, z) + LIFT))
    yMax = Math.max(yMax, e)
    if (e >= 1e-4) yBad++
  }
  check('(1)', 'every vertex at standY + lift (< 1e-4)', yBad === 0, `${yBad} off, max |Δy| ${yMax.toExponential(2)} m`)
  // (b) facing
  const down = downFacing(m)
  check('(1)', 'every triangle faces +Y', down === 0, `${down} of ${m.tris} down / flat`)
  // (c) boundary
  const be = boundaryEdges(m)
  let beLen = 0, stray = 0
  const endA = [arc.rows[0][0], arc.rows[2][0]], endB = [arc.rows[0][nS - 1], arc.rows[2][nS - 1]]
  for (const [a, b] of be) {
    const ax = m.pos[a * 3], az = m.pos[a * 3 + 2], bx = m.pos[b * 3], bz = m.pos[b * 3 + 2]
    beLen += Math.hypot(bx - ax, bz - az)
    const mx = (ax + bx) / 2, mz = (az + bz) / 2
    const onOutline = polyProject(arc.rows[0], mx, mz).d < 0.01 || polyProject(arc.rows[2], mx, mz).d < 0.01 || polyProject(endA, mx, mz).d < 0.01 || polyProject(endB, mx, mz).d < 0.01
    if (!onOutline) stray++
  }
  let outline = 14
  for (const r of [0, 2]) for (let i = 0; i + 1 < nS; i++) outline += Math.hypot(arc.rows[r][i + 1][0] - arc.rows[r][i][0], arc.rows[r][i + 1][1] - arc.rows[r][i][1])
  check('(1)', 'boundary length ≈ outline (± 10 %)', Math.abs(beLen - outline) <= 0.1 * outline, `${beLen.toFixed(1)} m vs ${outline.toFixed(1)} m, ${be.length} edges`)
  check('(1)', 'no boundary edge inside the strip', stray === 0, `${stray} stray`)
  // (d) attributes
  const at = m.attrs.aTest.array
  let acrossOk = 0, acrossCircleOk = 0, alongBad = 0, alongMax = 0, acrossMax = 0
  for (let i = 0; i < m.n; i++) {
    const x = m.pos[i * 3], z = m.pos[i * 3 + 2]
    const along = at[i * 2], across = at[i * 2 + 1]
    const p = polyProject(arc.rows[1], x, z)
    const lat = p.side * p.d
    const eA = Math.abs(across - lat)
    acrossMax = Math.max(acrossMax, eA)
    if (eA <= 0.02) acrossOk++
    if (Math.abs(across + (Math.hypot(x - arc.cx, z - arc.cz) - R)) <= 0.02) acrossCircleOk++
    const th = Math.atan2(z - arc.cz, x - arc.cx)
    const eS = Math.abs(along - R * (th < -1e-9 ? th + 2 * Math.PI : th))
    alongMax = Math.max(alongMax, eS)
    if (eS > 0.05) alongBad++
  }
  check('(1)', 'across within ±0.02 m of the chord-frame lateral (≥ 95 %)', acrossOk >= 0.95 * m.n, `${((100 * acrossOk) / m.n).toFixed(1)} %, max ${acrossMax.toFixed(4)} m (vs the circle: ${((100 * acrossCircleOk) / m.n).toFixed(1)} %)`)
  check('(1)', 'along = R·θ within 0.05 m (monotone)', alongBad === 0, `${alongBad} off, max ${alongMax.toFixed(4)} m`)
  // (e) two windows partition the cells
  const midX = arc.cx
  const sA = new fg.StripSink(LAYOUT), sB = new fg.StripSink(LAYOUT)
  const stA = fg.cellClippedStrip(sA, arcInput(), arcOpts({ window: [-1e9, -1e9, midX, 1e9] }))
  const stB = fg.cellClippedStrip(sB, arcInput(), arcOpts({ window: [midX, -1e9, 1e9, 1e9] }))
  check('(1)', 'two windows partition the cells exactly', stA.triangles + stB.triangles === st1.triangles && stA.triangles > 0 && stB.triangles > 0, `${stA.triangles} + ${stB.triangles} = ${stA.triangles + stB.triangles} vs ${st1.triangles}`)
  // (f) a pool-key change duplicates the boundary vertices, never the triangles
  const sK = new fg.StripSink(LAYOUT)
  const stK = fg.cellClippedStrip(sK, arcInput({ poolKey: (i) => (i < 20 ? 0 : 1) }), arcOpts())
  check('(1)', 'poolKey change duplicates the boundary vertices only', stK.triangles === st1.triangles && sK.vertices > sink1.vertices && sK.vertices - sink1.vertices < 20, `+${sK.vertices - sink1.vertices} vertices, ${stK.triangles} triangles`)
  // (g) okAt skips
  const sO = new fg.StripSink(LAYOUT)
  const stO = fg.cellClippedStrip(sO, arcInput({ okAt: (i) => i !== 10 }), arcOpts())
  check('(1)', 'okAt(i) = false skips that column', stO.quads === st1.quads - (OFF.length - 1), `${stO.quads} quads`)
}

// ---------------------------------------------------------------- (2) rigid
console.log('(2) arc strip, rigid')
const sink2 = new fg.StripSink(LAYOUT)
const st2 = fg.cellClippedStrip(sink2, arcInput({ rigidY: (r, i) => ground.standY(arc.rows[r][i][0], arc.rows[r][i][1]) + 0.3 }), arcOpts())
const geo2 = sink2.build()
check('(2)', 'two triangles per quad', st2.triangles === 2 * (OFF.length - 1) * (nS - 1) && st2.quads === (OFF.length - 1) * (nS - 1), `${st2.triangles} triangles, ${st2.quads} quads`)
if (geo2) {
  const m = unpack(geo2)
  check('(2)', 'vertices = the lattice corners', m.n === OFF.length * nS, `${m.n}`)
  let yBad = 0
  for (let i = 0; i < m.n; i++) {
    const x = m.pos[i * 3], y = m.pos[i * 3 + 1], z = m.pos[i * 3 + 2]
    if (Math.abs(y - (ground.standY(x, z) + 0.3)) >= 1e-4) yBad++
  }
  check('(2)', 'corners at rigidY', yBad === 0, `${yBad} off`)
  check('(2)', 'every triangle faces +Y', downFacing(m) === 0)
}

// ---------------------------------------------------------------- (3) across the circuit
console.log('(3) straight strip across the circuit, minD')
{
  // perpendicular to the track at the start line, ± 700 m
  const i1 = 5
  const px = scene.track.px, pz = scene.track.pz
  const tx0 = px[i1 + 1] - px[i1 - 1], tz0 = pz[i1 + 1] - pz[i1 - 1]
  const tl = Math.hypot(tx0, tz0)
  const tx = tx0 / tl, tz = tz0 / tl
  const nx = -tz, nz = tx
  const HALF = 700, step = 10
  const nC = Math.round((2 * HALF) / step) + 1
  const rows = OFF.map((off) => Array.from({ length: nC }, (_, i) => {
    const L = -HALF + i * step
    return [px[i1] + nx * L + tx * off, pz[i1] + nz * L + tz * off]
  }))
  const centre = rows[1]
  let projections = 0
  const countingPlan = { project: (x, z, w) => { projections++; return plan.project(x, z, w) } }
  const sink3 = new fg.StripSink(LAYOUT)
  const st3 = fg.cellClippedStrip(sink3, {
    rows,
    lift: () => LIFT,
    attr: (r, i, out) => { out[0] = i * step; out[1] = OFF[r] },
    // the exact distance is a valid lower bound; roads.ts hands in dmin − dv
    dLo: (i) => plan.project(centre[i][0], centre[i][1]).d,
  }, { grid, drape: 'mesh', ground, plan: countingPlan, minD: ROADS.minD, cache: fg.makeNodeCache(grid) })
  const geo3 = sink3.build()
  info(`stats ${JSON.stringify(st3)}, ${projections} exact projections inside the strip`)
  check('(3)', 'quads dropped near the track', st3.dropped > 0, `${st3.dropped} dropped, ${st3.quads} kept, ${st3.folded} folded`)
  check('(3)', 'quads survive far from it', st3.quads > 0 && !!geo3)
  if (geo3) {
    const m = unpack(geo3)
    let near = 0, onFace = 0, dMin = Infinity
    for (let i = 0; i < m.n; i++) {
      const x = m.pos[i * 3], z = m.pos[i * 3 + 2]
      const d = plan.project(x, z).d
      dMin = Math.min(dMin, d)
      if (d < ROADS.minD - 1e-6) near++
      if (ground.builtY(x, z)) onFace++
    }
    check('(3)', `no surviving vertex closer than minD ${ROADS.minD} m`, near === 0, `${near} inside, nearest ${dMin.toFixed(2)} m`)
    info(`${onFace} surviving vertices on a drawn face (the rule samples corners + centroid only)`)
    check('(3)', 'every vertex at standY + lift', (() => { for (let i = 0; i < m.n; i++) if (Math.abs(m.pos[i * 3 + 1] - (ground.standY(m.pos[i * 3], m.pos[i * 3 + 2]) + LIFT)) >= 1e-4) return false; return true })())
  }
  // the sample bound keeps the exact projections rare far from the track
  let far = 0
  const farPlan = { project: (x, z, w) => { far++; return plan.project(x, z, w) } }
  const sinkF = new fg.StripSink(LAYOUT)
  fg.cellClippedStrip(sinkF, arcInput({ dLo: () => Infinity }), arcOpts({ plan: farPlan }))
  check('(3)', 'dLo = Infinity → no exact projection', far === 0, `${far} projections`)
}

// ---------------------------------------------------------------- (4) the ring, drape nodes
console.log('(4) ring strip, drape nodes, hole = inner rectangle')
{
  const r = terrain.ring
  const ringGrid = { x0: r.x0, z0: r.z0, dx: r.dx, dz: r.dz, nx: r.nx - 1, nz: r.nz - 1, w: r.dx * (r.nx - 1), d: r.dz * (r.nz - 1) }
  const hole = [grid.x0, grid.z0, grid.x0 + grid.w, grid.z0 + grid.d]
  /** the ring mesh's height (terrain-far.ts: a, c, b / b, c, e — the b–c diagonal), independent of the strip */
  const ringMeshY = (x, z) => {
    const fu = (x - r.x0) / r.dx, fv = (z - r.z0) / r.dz
    const i = Math.min(r.nx - 2, Math.max(0, Math.floor(fu))), j = Math.min(r.nz - 2, Math.max(0, Math.floor(fv)))
    const u = fu - i, v = fv - j
    const k = j * r.nx + i
    const H = r.heights
    if (u + v <= 1) return H[k] + u * (H[k + 1] - H[k]) + v * (H[k + r.nx] - H[k])
    return H[k + r.nx + 1] + (1 - u) * (H[k + r.nx] - H[k + r.nx + 1]) + (1 - v) * (H[k + 1] - H[k + r.nx + 1])
  }
  // a diagonal strip from the ring's north-west into the inner rectangle and out again to the north-east
  const step = 15
  const pts = [[gcx - 900, grid.z0 - 500], [gcx - 200, grid.z0 + 300], [gcx + 200, grid.z0 + 300], [gcx + 900, grid.z0 - 500]]
  const centre = []
  for (let e = 0; e + 1 < pts.length; e++) {
    const a = pts[e], b = pts[e + 1]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    const nn = Math.ceil(len / step)
    for (let k = e === 0 ? 0 : 1; k <= nn; k++) centre.push([a[0] + ((b[0] - a[0]) * k) / nn, a[1] + ((b[1] - a[1]) * k) / nn])
  }
  const HW = 3.5
  const rows = [[], [], []]
  for (let i = 0; i < centre.length; i++) {
    const p = centre[i], q = centre[Math.min(i + 1, centre.length - 1)], o = centre[Math.max(i - 1, 0)]
    let tx = q[0] - o[0], tz = q[1] - o[1]
    const l = Math.hypot(tx, tz)
    tx /= l; tz /= l
    for (let rr = 0; rr < 3; rr++) {
      const lat = (rr - 1) * HW
      rows[rr].push([p[0] - tz * lat, p[1] + tx * lat])
    }
  }
  const input = (extra = {}) => ({ rows, lift: () => LIFT, attr: (rr, i, out) => { out[0] = i * step; out[1] = (rr - 1) * HW }, ...extra })
  const sink4 = new fg.StripSink(LAYOUT)
  const st4 = fg.cellClippedStrip(sink4, input(), { grid: ringGrid, drape: 'nodes', nodeY: (i, j) => r.heights[j * r.nx + i], ground, plan, minD: 0, hole })
  const geo4 = sink4.build()
  info(`stats ${JSON.stringify(st4)}, ${sink4.vertices} vertices`)
  check('(4)', 'geometry built', !!geo4 && st4.quads > 0)
  if (geo4) {
    const m = unpack(geo4)
    let yBad = 0, yMax = 0, inHole = 0, offBilinear = 0
    for (let i = 0; i < m.n; i++) {
      const x = m.pos[i * 3], y = m.pos[i * 3 + 1], z = m.pos[i * 3 + 2]
      const e = Math.abs(y - (ringMeshY(x, z) + LIFT))
      yMax = Math.max(yMax, e)
      if (e >= 1e-3) yBad++
      if (x > hole[0] + 1e-3 && x < hole[2] - 1e-3 && z > hole[1] + 1e-3 && z < hole[3] - 1e-3) inHole++
      if (Math.abs(y - (ground.standY(x, z) + LIFT)) > 1e-3) offBilinear++
    }
    check('(4)', 'every vertex on the ring mesh triangle + lift (< 1e-3)', yBad === 0, `${yBad} off, max |Δy| ${yMax.toExponential(2)} m`)
    check('(4)', 'no vertex inside the hole', inHole === 0, `${inHole} inside`)
    check('(4)', 'every triangle faces +Y', downFacing(m) === 0)
    info(`${offBilinear} of ${m.n} vertices differ from the bilinear standY by > 1 mm (why the ring drapes on nodes)`)
    // the default nodeY (standY at the nodes) is the same table
    const sinkD = new fg.StripSink(LAYOUT)
    fg.cellClippedStrip(sinkD, input(), { grid: ringGrid, drape: 'nodes', ground, plan, minD: 0, hole })
    const gD = sinkD.build()
    const mD = gD ? unpack(gD) : null
    let same = !!mD && mD.n === m.n
    if (same) for (let i = 0; i < m.n; i++) if (Math.abs(mD.pos[i * 3 + 1] - m.pos[i * 3 + 1]) > 1e-5) { same = false; break }
    check('(4)', 'default nodeY = the ring node heights', same)
    // the same strip with drape 'mesh' on the ring is the bilinear surface — a different mesh (the reason for 'nodes')
    const sinkM = new fg.StripSink(LAYOUT)
    fg.cellClippedStrip(sinkM, input(), { grid: ringGrid, drape: 'mesh', ground, plan, minD: 0, hole })
    const gM = sinkM.build()
    const mM = gM ? unpack(gM) : null
    let maxDiff = 0
    if (mM && mM.n === m.n) for (let i = 0; i < m.n; i++) maxDiff = Math.max(maxDiff, Math.abs(mM.pos[i * 3 + 1] - m.pos[i * 3 + 1]))
    info(`drape 'mesh' on the ring would differ by up to ${maxDiff.toFixed(3)} m from the ring's triangles`)
  }
}

console.log(`strip-smoke: ${failures} failure(s), ${((performance.now() - t0) / 1000).toFixed(1)} s`)
process.exit(failures ? 1 : 0)
