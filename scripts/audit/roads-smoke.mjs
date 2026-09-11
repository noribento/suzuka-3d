#!/usr/bin/env node
/**
 * Smoke test of the road ribbons (app/three/roads.ts) on the real scene, in plain Node through
 * app-runtime.mjs — dev-only, NOT part of `pnpm check` (it builds the whole scene per tier,
 * ≈ 20 s each). Run it after touching roads.ts, road-section.ts, the strip clipper or the
 * ROADS / ROAD_SECTION tables:
 *
 *   node scripts/audit/roads-smoke.mjs [--tier high|low|both] [--samples N] [--verbose]
 *
 * Per tier it builds the scene (the far field drained and consolidated, as the app ends up), then
 *  (1) re-runs `buildRoads` on a private far field that is stepped WITHOUT the static merge, so
 *      the per-job meshes (`roads-b<n>`, `bridgeWalls-b<n>`, `roads-ring-<k>`) can be listed as
 *      the jobs made them, and checks the keep-out count grew by what the stats claim;
 *  (2) lists the drained scene's road meshes (`roads-b*` / `bridgeWalls-b*` / the merged
 *      `roads-m<n>`), the triangles per block, the road / bridge-wall totals, the dropped and
 *      folded quad counts, the entries by kind and the 'paving' jobs' wall-clock (buildMs);
 *  (3) asserts, over the asphalt meshes of the drained scene:
 *      - every vertex position is finite; aRoad.w (the style) is integer-valued at every vertex,
 *        aVerge ∈ [0, 1] (exactly 0 / 1 at the lattice corners, the bilinear fade in between —
 *        it is the verge's alpha), no NaN in aMark;
 *      - on a random sample of draped vertices inside the inner grid (bridge vertices skipped by
 *        the bridge bit of aRoad.w; ring vertices are draped on the ring's own triangles, not on
 *        `standY`, so they are skipped by position), |y − standY| ≤ 0.10 + crown
 *        (crown = ROADS.crown · hwPaved from aRoad.z);
 *      - on a random sample of vertices, none closer than ROADS.minD − 1e-3 to the centreline
 *        (`plan.project`), and the nearest vertex is reported;
 *      - the far field reports no failed job.
 * Exit 1 on any failure.
 */
import path from 'node:path'
import { buildScene, ROOT } from './app-runtime.mjs'

const args = process.argv.slice(2)
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d }
const tierArg = flag('--tier', 'both')
const SAMPLES = Number(flag('--samples', '2000'))
const verbose = args.includes('--verbose')
const tiers = tierArg === 'both' ? ['high', 'low'] : [tierArg]
if (tiers.some((t) => t !== 'high' && t !== 'low')) { console.error('--tier high|low|both'); process.exit(2) }

const { ROADS } = await import(path.join(ROOT, 'app/data/surroundings-spec.ts'))
const { buildRoads } = await import(path.join(ROOT, 'app/three/roads.ts'))
const { FarField } = await import(path.join(ROOT, 'app/three/farfield.ts'))
const { ROAD_STYLE } = await import(path.join(ROOT, 'app/three/materials.ts'))

let failures = 0
const check = (tier, name, ok, detail) => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} [${tier}] ${name}${detail ? ` — ${detail}` : ''}`)
}
const fmt = (n) => n.toLocaleString('en-US')
const triCount = (geo) => Math.floor((geo.index ? geo.index.count : geo.attributes.position.count) / 3)
const isRoad = (name) => /^(roads-b\d+|roads-ring-\w+|roads-m\d+)$/.test(name)
const isWall = (name) => /^bridgeWalls-b\d+$/.test(name)

/** a small deterministic generator so a failure reproduces */
const lcg = (seed) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296

for (const tier of tiers) {
  console.log(`\nroads-smoke: tier ${tier}`)
  const t0 = performance.now()
  const scene = await buildScene({ tier })
  const { env, ground, plan, terrain, quality: q } = scene
  console.log(`  scene built and drained in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
  const grid = terrain.grid()
  const inGrid = (x, z) => x >= grid.x0 && x < grid.x0 + grid.w && z >= grid.z0 && z < grid.z0 + grid.d

  // --- (1) the jobs as they were made: a private far field, stepped without the static merge ---
  const ff2 = new FarField(grid, q)
  const ctx2 = {
    track: scene.track, terrain, ground, group: ff2.group, quality: q, assets: null, boxes: null, rng: null,
    standZones: [], keepOut: [], keepOutPolys: [], farField: ff2, landCover: env.landCover,
  }
  const before = ctx2.keepOutPolys.length
  const st2 = buildRoads(ctx2)
  const grew = ctx2.keepOutPolys.length - before
  check(tier, 'keep-outs pushed synchronously', grew > 0 && grew === st2.keepOuts, `${fmt(grew)} quads (stats ${fmt(st2.keepOuts)}), ${st2.inGrid} of ${st2.ways} ways in the grid, ${st2.onRing} on the ring`)
  check(tier, 'every keep-out is a convex ring with a box', ctx2.keepOutPolys.every((k) => k.ring.length >= 3 && k.box.length === 4 && k.box[0] <= k.box[2] && k.box[1] <= k.box[3]))
  const pendingBefore = ff2.pending
  while (ff2.pending) ff2.step(Infinity)
  check(tier, "'paving' jobs queued and run", pendingBefore === st2.blocks + st2.ringJobs && ff2.stats().failed === 0, `${st2.blocks} block jobs + ${st2.ringJobs} ring jobs, ${ff2.stats().failed} failed`)
  const perJob = []
  ff2.group.traverse((o) => { if (o.isMesh && (isRoad(o.name) || isWall(o.name))) perJob.push(o) })
  console.log('  per job (before the static merge):')
  console.log('    mesh              tris    quads  dropped  folded  ways  bridges  walls')
  const byName = new Map()
  for (const m of perJob) byName.set(m.name, m)
  for (const name of Object.keys(st2.jobs)) {
    const j = st2.jobs[name]
    const m = byName.get(name)
    console.log(`    ${name.padEnd(16)} ${String(m ? fmt(triCount(m.geometry)) : '-').padStart(8)} ${String(fmt(j.quads)).padStart(8)} ${String(fmt(j.dropped)).padStart(8)} ${String(j.folded).padStart(7)} ${String(j.ways).padStart(5)} ${String(j.bridges).padStart(8)} ${String(fmt(j.wallTriangles)).padStart(6)}`)
  }
  const jobTris = perJob.filter((m) => isRoad(m.name)).reduce((s, m) => s + triCount(m.geometry), 0)
  check(tier, 'job stats agree with the meshes', jobTris === st2.triangles && perJob.filter((m) => isWall(m.name)).reduce((s, m) => s + triCount(m.geometry), 0) === st2.wallTriangles, `${fmt(jobTris)} road triangles, ${fmt(st2.wallTriangles)} wall triangles`)

  // --- (2) the drained scene: what the app draws ---------------------------------------------
  const ff = env.farField
  const stats = ff.stats()
  const roads = ff.group.userData.roads
  const meshes = []
  ff.group.traverse((o) => { if (o.isMesh && (isRoad(o.name) || isWall(o.name))) meshes.push(o) })
  const roadMeshes = meshes.filter((m) => isRoad(m.name))
  const wallMeshes = meshes.filter((m) => isWall(m.name))
  const roadTris = roadMeshes.reduce((s, m) => s + triCount(m.geometry), 0)
  const wallTris = wallMeshes.reduce((s, m) => s + triCount(m.geometry), 0)
  console.log(`  drained scene: ${roadMeshes.length} road meshes [${roadMeshes.map((m) => m.name).join(' ')}], ${wallMeshes.length} bridge-wall meshes`)
  console.log(`    road triangles ${fmt(roadTris)} (stats ${fmt(roads.triangles)}), bridge walls ${fmt(wallTris)} (${roads.bridges} bridge ways), quads ${fmt(roads.quads)}, dropped ${fmt(roads.dropped)}, folded ${roads.folded}`)
  console.log(`    far-field entries by kind: ${JSON.stringify(stats.byKind)}; merged ${stats.merged}; failed ${stats.failed}`)
  const paving = Object.entries(stats.buildMs).filter(([k]) => k.startsWith('roads-'))
  const pavingMs = paving.reduce((s, [, v]) => s + v, 0)
  console.log(`    'paving' buildMs: ${paving.map(([k, v]) => `${k} ${v.toFixed(0)}`).join(', ')}`)
  console.log(`    'paving' total ${pavingMs.toFixed(0)} ms over ${paving.length} jobs (network ${roads.netMs.toFixed(0)} ms, synchronous)`)
  check(tier, 'no failed far-field job', stats.failed === 0)
  check(tier, 'drained road triangles equal the job totals', roadTris === roads.triangles && wallTris === roads.wallTriangles, `${fmt(roadTris)} / ${fmt(wallTris)}`)
  check(tier, 'ring jobs follow the tier', (q.farField.roads.ring ? roads.ringJobs > 0 : roads.ringJobs === 0), `${roads.ringJobs} ring jobs, roads.ring = ${q.farField.roads.ring}`)

  // --- (3) the vertices ----------------------------------------------------------------------
  let nVerts = 0, nonFinite = 0, styleFrac = 0, vergeBad = 0, vergeExact = 0, markNaN = 0, styleMax = 0
  const all = []   // [mesh, vertex index] pairs to sample from
  for (const m of roadMeshes) {
    const g = m.geometry
    const pos = g.attributes.position, road = g.attributes.aRoad, mark = g.attributes.aMark, verge = g.attributes.aVerge
    if (!road || !mark || !verge) { check(tier, `${m.name} carries aRoad / aMark / aVerge`, false); continue }
    const n = pos.count
    nVerts += n
    for (let i = 0; i < n; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i)
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) nonFinite++
      const style = road.getW(i)
      if (style !== Math.round(style)) styleFrac++
      if (style > styleMax) styleMax = style
      const v = verge.getX(i)
      if (!(v >= 0 && v <= 1)) vergeBad++
      if (v === 0 || v === 1) vergeExact++
      if (Number.isNaN(mark.getX(i)) || Number.isNaN(mark.getY(i)) || Number.isNaN(mark.getZ(i)) || Number.isNaN(mark.getW(i))) markNaN++
      all.push(m, i)
    }
  }
  check(tier, 'every asphalt vertex is finite', nonFinite === 0, `${fmt(nVerts)} vertices, ${nonFinite} non-finite`)
  check(tier, 'aRoad.w (style) is integer-valued everywhere', styleFrac === 0, `${styleFrac} fractional, max style ${styleMax}`)
  check(tier, 'aVerge ∈ [0, 1] everywhere', vergeBad === 0, `${vergeBad} outside, ${fmt(vergeExact)} exactly 0 / 1, ${fmt(nVerts - vergeExact)} on the fade`)
  check(tier, 'no NaN in aMark', markNaN === 0, `${markNaN} NaN`)

  const rnd = lcg(0x5EED + (tier === 'high' ? 1 : 2))
  const pairs = all.length / 2
  // drape: |y − standY| ≤ 0.10 + crown on draped vertices inside the grid
  let tested = 0, worst = 0, worstAt = null, bad = 0, skipped = 0
  const hwMax = { v: 0 }
  for (let k = 0; k < SAMPLES && pairs; k++) {
    const j = Math.floor(rnd() * pairs)
    const m = all[j * 2], i = all[j * 2 + 1]
    const g = m.geometry
    const x = g.attributes.position.getX(i), y = g.attributes.position.getY(i), z = g.attributes.position.getZ(i)
    const style = g.attributes.aRoad.getW(i), hw = g.attributes.aRoad.getZ(i)
    if (!inGrid(x, z) || (Math.floor(style / ROAD_STYLE.bridge) % 2) === 1) { skipped++; continue }
    tested++
    const d = Math.abs(y - ground.standY(x, z))
    const tol = 0.10 + ROADS.crown * hw
    if (hw > hwMax.v) hwMax.v = hw
    if (d > tol) bad++
    if (d > worst) { worst = d; worstAt = [x.toFixed(1), z.toFixed(1), m.name] }
  }
  check(tier, 'draped vertices sit on standY (|y − standY| ≤ 0.10 + crown)', bad === 0, `${tested} tested (${skipped} bridge / ring skipped), worst ${(worst * 1000).toFixed(1)} mm at ${worstAt ? worstAt.join(', ') : '-'}`)
  // minD: no sampled vertex inside ROADS.minD of the centreline
  let nearest = Infinity, nearestAt = null, inside = 0, testedD = 0
  for (let k = 0; k < SAMPLES && pairs; k++) {
    const j = Math.floor(rnd() * pairs)
    const m = all[j * 2], i = all[j * 2 + 1]
    const g = m.geometry
    const x = g.attributes.position.getX(i), z = g.attributes.position.getZ(i)
    const d = plan.project(x, z).d
    testedD++
    if (d < ROADS.minD - 1e-3) inside++
    if (d < nearest) { nearest = d; nearestAt = [x.toFixed(1), z.toFixed(1), m.name] }
  }
  check(tier, `no vertex inside ROADS.minD (${ROADS.minD} m) of the centreline`, inside === 0, `${testedD} tested, ${inside} inside, nearest ${nearest.toFixed(2)} m at ${nearestAt ? nearestAt.join(', ') : '-'}`)
  if (verbose) {
    const byStyle = new Map()
    for (const m of roadMeshes) {
      const road = m.geometry.attributes.aRoad
      for (let i = 0; i < road.count; i++) { const s = road.getW(i); byStyle.set(s, (byStyle.get(s) ?? 0) + 1) }
    }
    console.log(`    style histogram: ${[...byStyle.entries()].sort((a, b) => a[0] - b[0]).map(([s, n]) => `${s}:${n}`).join(' ')}`)
  }
}

console.log(`\nroads-smoke: ${failures} failure(s)`)
process.exit(failures ? 1 : 0)
