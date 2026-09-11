#!/usr/bin/env node
/**
 * Buildings smoke (R フェーズ Phase 4, dev-only — not part of `pnpm check`): builds the scene on
 * both tiers through app-runtime.mjs (no asset pack → the painted facade layers, no hero
 * houses), drains the far field and checks what buildings.ts massed and dressed:
 *
 *  - the `farField/buildings` rows exist: every `buildings-<key>` cell root holds a mass mesh,
 *    the per-cell `userData.buildings` counts add up, no vertex is NaN / infinite;
 *  - the five `building=greenhouse` footprints are massed as film arches (`arches` = 5 on both
 *    tiers — the arch is part of the mass level);
 *  - block walls stay out of the roads: every vertex of every `block`-layer face in the detail
 *    level is at least `hw + 1.0` from the nearest road's centreline (road-section.ts
 *    `nearestRoad`), and every dressing vertex keeps 80 m from the GP centreline;
 *  - PV quads (`pv` layer) only occur on house footprints (their vertices lie within a house's
 *    roof box), never on works or sheds;
 *  - hero counts: 0 in Node (no registry) — printed, not asserted, so a `--glb` run can show them.
 *
 *   node scripts/audit/buildings-smoke.mjs [--tier high|low|both]
 *
 * Exit 1 on any failure.
 */
import path from 'node:path'
import { buildScene, ROOT } from './app-runtime.mjs'

const args = process.argv.slice(2)
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d }
const tierArg = flag('--tier', 'both')
const tiers = tierArg === 'both' ? ['high', 'low'] : [tierArg]

const rs = await import(path.join(ROOT, 'app/three/road-section.ts'))
const bl = await import(path.join(ROOT, 'app/three/buildings.ts'))
const { FACADE_LAYER } = bl

let failures = 0
const check = (ok, msg) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failures++ }
const fmt = (n) => n.toLocaleString('en-US')

for (const tier of tiers) {
  console.log(`\nbuildings-smoke: tier ${tier}`)
  const t0 = performance.now()
  const scene = await buildScene({ tier })
  const { env, ground, terrain, quality, track } = scene
  const ff = env.farField
  console.log(`  built + drained in ${((performance.now() - t0) / 1000).toFixed(1)} s; farField failed jobs: ${ff.stats().failed}`)
  check(ff.stats().failed === 0, 'no deferred job failed')

  // --- the cells and their counts ------------------------------------------------------------------
  const roots = ff.group.children.filter((o) => /^buildings-/.test(o.name) && o.userData.buildings)
  const sum = {}
  let massMeshes = 0, detailMeshes = 0
  for (const r of roots) {
    for (const [k, v] of Object.entries(r.userData.buildings)) if (typeof v === 'number') sum[k] = (sum[k] ?? 0) + v
    for (const g of r.children) {
      if (/^buildingsMass-/.test(g.name)) massMeshes += g.children.filter((m) => m.isMesh).length
      if (/^buildingsDetail-/.test(g.name)) detailMeshes += g.children.filter((m) => m.isMesh).length
    }
  }
  console.log(`  ${roots.length} cell roots, ${massMeshes} mass meshes, ${detailMeshes} detail meshes; counts ${JSON.stringify(sum)}`)
  check(roots.length > 0 && massMeshes > 0, `buildings-<key> roots with mass meshes exist (${roots.length} / ${massMeshes})`)
  check(sum.triangles > 0, `mass triangles ${fmt(sum.triangles ?? 0)} > 0`)
  check((ff.stats().byKind.buildings ?? 0) >= roots.length, `every cell is registered as kind 'buildings' (${ff.stats().byKind.buildings ?? 0} entries for ${roots.length} roots)`)
  check(sum.arches === 5, `greenhouses massed as arches: ${sum.arches} (5 building=greenhouse rows)`)
  if (quality.farField.buildingsDetailM > 0) {
    check(detailMeshes > 0 && sum.detailTriangles > 0, `detail level built (${detailMeshes} meshes, ${fmt(sum.detailTriangles ?? 0)} triangles)`)
    check(sum.walls > 0 && sum.wallSegments > 0, `block walls: ${sum.walls} houses, ${sum.wallSegments} segments, ${sum.gates} gates`)
    check(sum.props > 0, `house props on ${sum.props} houses`)
    check(sum.shutters > 0, `${sum.shutters} shutters on the works`)
  } else {
    check(detailMeshes === 0 && !sum.wallSegments, `no detail level on this tier (${detailMeshes} meshes, ${sum.wallSegments ?? 0} wall segments)`)
  }
  check(sum.pv > 0, `PV arrays on ${sum.pv} houses`)
  console.log(`  hero fits: ${sum.heroes ?? 0} (Node has no registry: 0 expected); heroBuildings job: ${ff.group.children.some((o) => o.name === 'heroBuildings') ? 'present' : 'absent'}`)

  // --- every vertex finite -------------------------------------------------------------------------
  // the mass levels are static: after the drain they live in the registry's per-block merges
  // (`buildings-m<n>` directly under the far-field group), the detail levels stay in the cell roots
  let nan = 0, vertices = 0
  const meshes = ff.group.children.filter((o) => o.isMesh && /^buildings-m\d+$/.test(o.name))
  const mergedN = meshes.length
  for (const r of roots) r.traverse((o) => { if (o.isMesh) meshes.push(o) })
  console.log(`  ${mergedN} merged mass meshes + ${meshes.length - mergedN} cell meshes`)
  check(mergedN > 0, `the mass levels were merged per block (${mergedN} buildings-m* meshes)`)
  for (const m of meshes) {
    const p = m.geometry.attributes.position
    vertices += p.count
    for (let i = 0; i < p.count; i++) if (!Number.isFinite(p.getX(i)) || !Number.isFinite(p.getY(i)) || !Number.isFinite(p.getZ(i))) nan++
  }
  check(nan === 0, `no NaN / infinite vertex (${fmt(vertices)} vertices)`)

  // --- the massing per footprint: base = gMin − baseDrop, hero / arch flags ---------------------------
  const spec = await import(path.join(ROOT, 'app/data/surroundings-spec.ts'))
  let baseBad = 0, massedN = 0
  for (const r of roots) for (const m of r.userData.buildings.massed) {
    massedN++
    if (Math.abs(m.base - (m.gMin - spec.BUILDING.baseDrop)) > 1e-6) baseBad++
  }
  check(baseBad === 0, `every mass base is gMin − baseDrop (${fmt(massedN)} footprints)`)

  // --- the block walls vs the roads, the dressing vs the centreline ------------------------------------
  const netCtx = { track, terrain, ground, quality, landCover: env.landCover, farField: ff }
  const net = rs.roadNetwork(netCtx, { stepScale: quality.farField.roads.stepScale, ring: quality.farField.roads.ring })
  let wallV = 0, wallBad = 0, worst = Infinity, dressV = 0, dressNear = 0, pvV = 0, pvOut = 0
  const houseBoxes = []
  for (const r of roots) for (const m of r.userData.buildings.massed) if (m.kind === 'house') houseBoxes.push(m)
  for (const m of meshes) {
    const lay = m.geometry.attributes.aLayer
    const pos = m.geometry.attributes.position
    if (!lay) continue
    const detail = /^buildingsDetail-/.test(m.name)
    for (let i = 0; i < pos.count; i++) {
      const l = lay.getX(i)
      const x = pos.getX(i), z = pos.getZ(i)
      // the Phase 4 dressing (walls, shutters) obeys the overlay rule; the older sills / rooftop units never did
      if (detail && (l === FACADE_LAYER.block || l === FACADE_LAYER.shutter)) {
        dressV++
        if (ground.plan.project(x, z).d < 80 - 1e-6) dressNear++
      }
      if (l === FACADE_LAYER.block) {
        wallV++
        const nr = rs.nearestRoad(net, x, z, 40)
        if (nr) {
          const margin = nr.d - nr.way.hw
          if (margin < worst) worst = margin
          if (margin < 1.0 - 1e-6) wallBad++
        }
      } else if (l === FACADE_LAYER.pv) {
        pvV++
        // inside some house's footprint disc (rMax + the eaves overhang + the inset slack)
        if (!houseBoxes.some((h) => Math.hypot(x - h.cx, z - h.cz) <= h.rMax + 1.5)) pvOut++
      }
    }
  }
  if (quality.farField.buildingsDetailM > 0) {
    check(wallV > 0 && wallBad === 0, `block-wall vertices stay ≥ hw + 1.0 m from every road (${fmt(wallV)} vertices, worst margin ${Number.isFinite(worst) ? worst.toFixed(2) : '-'} m)`)
    check(dressV > 0 && dressNear === 0, `wall / shutter vertices keep 80 m from the GP centreline (${fmt(dressV)} vertices, ${dressNear} inside)`)
  }
  check(pvV > 0 && pvOut === 0, `PV quads lie on house roofs only (${fmt(pvV)} vertices, ${pvOut} outside every house)`)
}

console.log(failures ? `\nbuildings-smoke: ${failures} failure(s)` : '\nbuildings-smoke: ok')
process.exit(failures ? 1 : 0)
