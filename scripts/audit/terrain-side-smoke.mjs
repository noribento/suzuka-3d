#!/usr/bin/env node
/**
 * Smoke test of the terrain-side relief (app/three/terrain-side.ts — paddy levees, the railway,
 * the streams) on the real scene, in plain Node through app-runtime.mjs — dev-only, NOT part of
 * `pnpm check` (it builds the whole scene per tier, ≈ 20 s each). Run it after touching
 * terrain-side.ts, the strip clipper or the PADDY / RAIL / STREAM tables:
 *
 *   node scripts/audit/terrain-side-smoke.mjs [--tier high|low|both] [--samples N] [--verbose]
 *
 * Per tier it builds the scene (the far field drained and consolidated, as the app ends up), then
 *  (1) re-runs `buildTerrainSide` on a private far field stepped WITHOUT the static merge, so the
 *      per-job meshes keep their `userData.terrainSide` tags (family / part), and checks the
 *      keep-outs grew by what the stats claim;
 *  (2) asserts the entries: 'rail' entries with a bed and two rails, 'stream' entries, 'paddy'
 *      entries on the high tier only (`Quality.farField.paddyRelief`), no failed job;
 *  (3) asserts over the vertices of the private run's meshes:
 *      - every position is finite;
 *      - on a random sample inside the terrain grid, none closer than minD − 1 m to the centreline
 *        (`plan.project`; the ring's vertices lie outside the grid and are skipped);
 *      - the height over the ground by part: the water strips STREAM.waterLift ± 0.01, the levees
 *        [foot, h], the ditches at their lift, the banks and rims within their heights, the rail
 *        bed rows in the grid between the ground and embankH + bedH (no floating bed, no buried
 *        bed), the rails on top of it, the embankment flanks under embankH + the approach ramp;
 *        the ground is `standY` in the grid and the ring mesh's own plane outside (standY is
 *        bilinear there, the ring draws the b–c diagonal);
 *      - no bank / rim / levee / ditch / bed vertex inside a road ribbon's asphalt
 *        (`nearestRoad` d ≥ way.hw − 0.1), except under a road BRIDGE (a deck in the air), on a
 *        rail viaduct deck (the road passes under it) and where a road CROSSES the railway at
 *        grade (a level crossing: the bed is cut there and the kept quads' outer corners may
 *        reach into an oblique crossing).
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

const { PADDY, RAIL, STREAM } = await import(path.join(ROOT, 'app/data/surroundings-spec.ts'))
const { SUR_RAIL } = await import(path.join(ROOT, 'app/data/suzuka-surroundings.ts'))
const { worldRing } = await import(path.join(ROOT, 'app/data/en-codec.ts'))
const { buildTerrainSide } = await import(path.join(ROOT, 'app/three/terrain-side.ts'))
const { FarField } = await import(path.join(ROOT, 'app/three/farfield.ts'))
const { roadNetwork, nearestRoad } = await import(path.join(ROOT, 'app/three/road-section.ts'))

let failures = 0
const check = (tier, name, ok, detail) => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} [${tier}] ${name}${detail ? ` — ${detail}` : ''}`)
}
const fmt = (n) => n.toLocaleString('en-US')
const triCount = (geo) => Math.floor((geo.index ? geo.index.count : geo.attributes.position.count) / 3)
/** a small deterministic generator so a failure reproduces */
const lcg = (seed) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296

/** the ring mesh's height (terrain-far.ts draws the b–c diagonal; standY is bilinear there) */
const ringPlaneY = (r, x, z) => {
  const cx = r.nx - 1, cz = r.nz - 1
  const fu = Math.min(cx, Math.max(0, (x - r.x0) / r.dx)), fv = Math.min(cz, Math.max(0, (z - r.z0) / r.dz))
  const i = Math.min(cx - 1, Math.floor(fu)), j = Math.min(cz - 1, Math.floor(fv))
  const u = fu - i, v = fv - j
  const k = j * r.nx + i, H = r.heights
  const a = H[k], b = H[k + 1], c = H[k + r.nx], e = H[k + r.nx + 1]
  return u + v <= 1 ? a + u * (b - a) + v * (c - a) : e + (1 - u) * (c - e) + (1 - v) * (b - e)
}

/** the SUR_RAIL segments in world XZ, for the crossing exemption */
const railSegs = (enScale) => {
  const out = []
  for (const row of SUR_RAIL) {
    const v = worldRing(row, enScale)
    for (let i = 2; i < v.length; i += 2) out.push([v[i - 2], v[i - 1], v[i], v[i + 1]])
  }
  return out
}
const railDirAt = (segs, x, z) => {
  let best = Infinity, dir = [1, 0]
  for (const [ax, az, bx, bz] of segs) {
    const ex = bx - ax, ez = bz - az, l2 = ex * ex + ez * ez
    const u = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2)) : 0
    const dx = x - (ax + ex * u), dz = z - (az + ez * u)
    const d2 = dx * dx + dz * dz
    if (d2 < best) { best = d2; const l = Math.sqrt(l2) || 1; dir = [ex / l, ez / l] }
  }
  return dir
}

/** the deepest valley a ring viaduct may span under its deck (m over the lowest ground of the run) */
const VALLEY_M = 6
/** height-over-ground windows per part [min, max] inside the grid, and on the ring */
const WINDOWS = {
  water: { grid: [STREAM.waterLift - 0.01, STREAM.waterLift + 0.01], ring: [STREAM.waterLift - 0.01, STREAM.waterLift + 0.01] },
  bank: { grid: [STREAM.waterLift - 0.01, STREAM.berm.h + 0.01], ring: [STREAM.waterLift - 0.01, STREAM.levee.h + 0.01] },
  rim: { grid: [STREAM.waterLift - 0.01, STREAM.rim.h + 0.01], ring: [STREAM.waterLift - 0.01, STREAM.rim.h + 0.01] },
  levee: { grid: [PADDY.levee.foot - 0.01, PADDY.levee.h + 0.01], ring: null },
  ditch: { grid: [PADDY.ditch.lift - 0.005, PADDY.ditch.lift + 0.005], ring: null },
  // no bridges inside the grid: the bed is between the ground and the embankment's crest. On the
  // ring a deck stands `rise` over the HIGHEST ground within 60 m of its run, so over a river
  // valley it is rise + the valley's depth (the 鈴鹿川 bridge: ≈ 10 m); its approaches ramp to it
  bed: { grid: [0.0, RAIL.embankH + RAIL.bedH + 0.1], ring: [-0.05, RAIL.viaduct.rise + VALLEY_M + RAIL.bedH] },
  rails: { grid: [0.04, RAIL.embankH + RAIL.bedH + RAIL.rail.h + 0.1], ring: [0.0, RAIL.viaduct.rise + VALLEY_M + RAIL.bedH + RAIL.rail.h] },
  embank: { grid: [0.0, RAIL.embankH + 0.1], ring: [0.0, RAIL.viaduct.rise + VALLEY_M] },
  viaduct: null,
}
/** parts whose vertices must stay off the asphalt */
const ROAD_FREE = new Set(['bank', 'rim', 'levee', 'ditch', 'bed'])

for (const tier of tiers) {
  console.log(`\nterrain-side-smoke: tier ${tier}`)
  const t0 = performance.now()
  const scene = await buildScene({ tier })
  const { env, ground, plan, terrain, quality: q, track } = scene
  console.log(`  scene built and drained in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
  const grid = terrain.grid()
  const inGrid = (x, z) => x >= grid.x0 && x < grid.x0 + grid.w && z >= grid.z0 && z < grid.z0 + grid.d
  const groundY = (x, z) => (inGrid(x, z) ? ground.standY(x, z) : ringPlaneY(terrain.ring, x, z))

  // --- (1) the jobs as they were made: a private far field, stepped without the static merge ---
  const ff2 = new FarField(grid, q)
  const ctx2 = {
    track, terrain, ground, group: ff2.group, quality: q, assets: null, boxes: null, rng: null,
    standZones: [], keepOut: [], keepOutPolys: [], farField: ff2, landCover: env.landCover,
  }
  const before = ctx2.keepOutPolys.length
  const st2 = buildTerrainSide(ctx2)
  const grew = ctx2.keepOutPolys.length - before
  check(tier, 'keep-outs pushed synchronously (rail + streams)', grew > 0 && grew === st2.keepOuts, `${fmt(grew)} quads (stats ${fmt(st2.keepOuts)})`)
  const pendingBefore = ff2.pending
  while (ff2.pending) ff2.step(Infinity)
  check(tier, "'dressing' jobs queued and run", pendingBefore === st2.blocks && ff2.stats().failed === 0, `${st2.blocks} jobs, ${ff2.stats().failed} failed`)
  const meshes = []
  ff2.group.traverse((o) => { if (o.isMesh && o.userData.terrainSide?.part) meshes.push(o) })
  const byPart = new Map()
  for (const m of meshes) {
    const p = m.userData.terrainSide.part
    byPart.set(p, (byPart.get(p) ?? 0) + triCount(m.geometry))
  }
  console.log('  per job (before the static merge):')
  console.log('    mesh                       tris')
  for (const m of meshes) if (verbose || meshes.length <= 60) console.log(`    ${m.name.padEnd(24)} ${String(fmt(triCount(m.geometry))).padStart(8)}`)
  console.log(`    by part: ${[...byPart].map(([k, v]) => `${k} ${fmt(v)}`).join(', ')}`)
  console.log(`    stats: rail ${st2.rail.ways} chains / ${st2.rail.m.toFixed(0)} m / ${st2.rail.viaducts} viaduct runs / ${st2.rail.crossings} level crossings / ${fmt(st2.rail.triangles)} tris; streams ${st2.stream.ways} ways / ${st2.stream.m.toFixed(0)} m (rims ${st2.stream.rimM.toFixed(0)}, berms ${st2.stream.bermM.toFixed(0)}) / ${st2.stream.crossings} culverts / ${fmt(st2.stream.triangles)} tris; paddy ${st2.paddy.fields} fields / levees ${st2.paddy.leveeM.toFixed(0)} m / ditches ${st2.paddy.ditchM.toFixed(0)} m / ${fmt(st2.paddy.triangles)} tris`)
  const jobTris = meshes.reduce((s, m) => s + triCount(m.geometry), 0)
  check(tier, 'job stats agree with the meshes', jobTris === st2.rail.triangles + st2.stream.triangles + st2.paddy.triangles, `${fmt(jobTris)} triangles`)

  // --- (2) the drained scene: the entries ------------------------------------------------------
  const stats = env.farField.stats()
  const ts = env.farField.group.userData.terrainSide
  console.log(`  drained scene: entries by kind ${JSON.stringify(stats.byKind)}; failed ${stats.failed}`)
  const jobsMs = Object.entries(stats.buildMs).filter(([k]) => /^(rail|stream|paddy)-/.test(k))
  console.log(`    'dressing' buildMs: ${jobsMs.reduce((s, [, v]) => s + v, 0).toFixed(0)} ms over ${jobsMs.length} terrain-side jobs`)
  check(tier, 'no failed far-field job', stats.failed === 0)
  check(tier, "'rail' entries exist with a bed and rails", (stats.byKind.rail ?? 0) > 0 && (byPart.get('bed') ?? 0) > 0 && (byPart.get('rails') ?? 0) > 0, `${stats.byKind.rail ?? 0} entries, bed ${fmt(byPart.get('bed') ?? 0)} tris, rails ${fmt(byPart.get('rails') ?? 0)} tris`)
  check(tier, "'stream' entries exist with water", (stats.byKind.stream ?? 0) > 0 && (byPart.get('water') ?? 0) > 0, `${stats.byKind.stream ?? 0} entries, water ${fmt(byPart.get('water') ?? 0)} tris`)
  check(tier, "'paddy' entries follow paddyRelief", q.farField.paddyRelief ? (stats.byKind.paddy ?? 0) > 0 && (byPart.get('levee') ?? 0) > 0 : !(stats.byKind.paddy ?? 0), `${stats.byKind.paddy ?? 0} entries, paddyRelief = ${q.farField.paddyRelief}`)
  check(tier, 'drained stats equal the private run', ts && ts.rail.triangles === st2.rail.triangles && ts.stream.triangles === st2.stream.triangles && ts.paddy.triangles === st2.paddy.triangles)

  // --- (3) the vertices ----------------------------------------------------------------------
  const net = roadNetwork(ctx2)
  const segs = railSegs(track.enScale)
  let nVerts = 0, nonFinite = 0
  const heightBad = new Map(), heightBadRing = new Map(), heightN = new Map(), worst = new Map()
  let roadBad = 0, roadChecked = 0, roadWorst = null, crossingsExempt = 0, bridgesExempt = 0, decksExempt = 0
  const deckH = RAIL.embankH + RAIL.bedH + 0.2
  const all = []
  for (const m of meshes) {
    const part = m.userData.terrainSide.part
    const pos = m.geometry.attributes.position
    const n = pos.count
    nVerts += n
    const win = WINDOWS[part]
    for (let i = 0; i < n; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i)
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) { nonFinite++; continue }
      all.push(m, i)
      if (win) {
        const w = inGrid(x, z) ? win.grid : win.ring
        if (w) {
          const h = y - groundY(x, z)
          heightN.set(part, (heightN.get(part) ?? 0) + 1)
          if (h < w[0] || h > w[1]) {
            const map = inGrid(x, z) ? heightBad : heightBadRing
            map.set(part, (map.get(part) ?? 0) + 1)
            const cur = worst.get(part)
            const miss = h < w[0] ? w[0] - h : h - w[1]
            if (!cur || miss > cur.miss) worst.set(part, { miss, h, x, z, ring: !inGrid(x, z) })
          }
        }
      }
      if (ROAD_FREE.has(part)) {
        const r = nearestRoad(net, x, z, 12)
        roadChecked++
        if (r && r.d < r.way.hw - 0.1) {
          // a road bridge is a deck in the air: the water and the banks run under it
          if (r.way.bridge) { bridgesExempt++; continue }
          if (part === 'bed') {
            // a bed higher than any embankment is a viaduct deck: the road passes under it
            if (y - groundY(x, z) > deckH) { decksExempt++; continue }
            const [tx, tz] = railDirAt(segs, x, z)
            if (Math.abs(tx * r.tz - tz * r.tx) > 0.35) { crossingsExempt++; continue }
          }
          roadBad++
          if (!roadWorst || r.way.hw - r.d > roadWorst.depth) roadWorst = { depth: r.way.hw - r.d, part, x, z, kind: r.way.kind }
        }
      }
    }
  }
  check(tier, 'every vertex is finite', nonFinite === 0, `${fmt(nVerts)} vertices, ${nonFinite} non-finite`)
  for (const [part, win] of Object.entries(WINDOWS)) {
    if (!win || !heightN.has(part)) continue
    const bad = heightBad.get(part) ?? 0, badRing = heightBadRing.get(part) ?? 0
    const w = worst.get(part)
    const rng = (r) => `[${r[0].toFixed(3)}, ${r[1].toFixed(3)}]`
    check(tier, `${part}: height over the ground within ${rng(win.grid)} in the grid${win.ring ? ` / ${rng(win.ring)} on the ring` : ''}`, bad + badRing === 0, `${fmt(heightN.get(part))} vertices, ${bad} outside in the grid, ${badRing} on the ring${w ? `; worst ${w.h.toFixed(3)} m at (${w.x.toFixed(0)}, ${w.z.toFixed(0)})${w.ring ? ' ring' : ''}` : ''}`)
  }
  check(tier, 'no bank / rim / levee / ditch / bed vertex on a road ribbon (d ≥ hw − 0.1; level crossings and road bridges exempt)', roadBad === 0, `${fmt(roadChecked)} checked, ${roadBad} inside, ${crossingsExempt} exempt at crossings, ${bridgesExempt} under road bridges, ${decksExempt} on viaduct decks${roadWorst ? `; worst ${roadWorst.part} ${roadWorst.depth.toFixed(2)} m into a ${roadWorst.kind} at (${roadWorst.x.toFixed(0)}, ${roadWorst.z.toFixed(0)})` : ''}`)

  // the centreline distance on a random sample of in-grid vertices
  const rnd = lcg(0x51DE + (tier === 'high' ? 1 : 2))
  const pairs = all.length / 2
  let tested = 0, near = 0, nearest = Infinity, nearestAt = null
  const minD = Math.min(PADDY.minD, RAIL.minD, STREAM.minD)
  for (let k = 0; k < SAMPLES * 3 && pairs && tested < SAMPLES; k++) {
    const j = Math.floor(rnd() * pairs)
    const m = all[j * 2], i = all[j * 2 + 1]
    const pos = m.geometry.attributes.position
    const x = pos.getX(i), z = pos.getZ(i)
    if (!inGrid(x, z)) continue
    tested++
    const d = plan.project(x, z).d
    if (d < nearest) { nearest = d; nearestAt = { x, z, part: m.userData.terrainSide.part } }
    if (d < minD - 1) near++
  }
  check(tier, `no sampled in-grid vertex closer than ${minD} − 1 m to the centreline`, near === 0, `${fmt(tested)} sampled, ${near} inside; nearest ${nearest.toFixed(1)} m${nearestAt ? ` (${nearestAt.part} at ${nearestAt.x.toFixed(0)}, ${nearestAt.z.toFixed(0)})` : ''}`)
}

console.log(failures ? `\nterrain-side-smoke: ${failures} failure(s)` : '\nterrain-side-smoke: all checks passed')
process.exit(failures ? 1 : 0)
