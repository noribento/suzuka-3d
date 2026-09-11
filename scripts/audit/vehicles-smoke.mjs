#!/usr/bin/env node
/**
 * Vehicles / solar / pylons smoke (R フェーズ Phase 5, dev-only — not part of `pnpm check`):
 * builds the scene on both tiers through app-runtime.mjs (no asset pack → no GLB heroes, the
 * painted panel face), drains the far field and checks what vehicles.ts, outskirts.ts (solar)
 * and props.ts (pylons) built:
 *
 *  - the `carPark-<cell>` entries exist and their per-cell `userData.cars` counts add up;
 *  - the kei truck is in the mix: `byBody.keitruck` > 0 over the drawn cars, and the
 *    `carParkBodies-<cell>-keitruck` InstancedMeshes exist;
 *  - no `carParkHero-*` entry in Node (assets === null → `stats.heroKinds` empty, 0 hero bodies);
 *  - `solarDetail-<cell>` entries exist on the high tier only (`Quality.farField.solarDetail`),
 *    with racks, at least one hut and fence posts; the panel meshes on both tiers;
 *  - the pylons InstancedMesh: instances, triangles per tower (≈ 2.7 k) and in total (reported);
 *    the power cables hold 7 runs per span (6 conductors + the ground wire);
 *  - no NaN / infinite vertex in any of the above.
 *
 *   node scripts/audit/vehicles-smoke.mjs [--tier high|low|both]
 *
 * Exit 1 on any failure.
 */
import path from 'node:path'
import { buildScene, ROOT } from './app-runtime.mjs'

const args = process.argv.slice(2)
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d }
const tierArg = flag('--tier', 'both')
const tiers = tierArg === 'both' ? ['high', 'low'] : [tierArg]

const cb = await import(path.join(ROOT, 'app/three/car-bodies.ts'))
const { CAR_BODIES } = cb

let failures = 0
const check = (ok, msg) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failures++ }
const fmt = (n) => n.toLocaleString('en-US')
const trisOf = (mesh) => {
  const g = mesh.geometry
  const n = g.index ? g.index.count : (g.attributes.position?.count ?? 0)
  return Math.floor(n / 3) * (mesh.isInstancedMesh ? mesh.count : 1)
}
const finiteVertices = (meshes) => {
  let nan = 0, vertices = 0
  for (const m of meshes) {
    const p = m.geometry.attributes.position
    if (!p) continue
    vertices += p.count
    for (let i = 0; i < p.count; i++) if (!Number.isFinite(p.getX(i)) || !Number.isFinite(p.getY(i)) || !Number.isFinite(p.getZ(i))) nan++
  }
  return { nan, vertices }
}

for (const tier of tiers) {
  console.log(`\nvehicles-smoke: tier ${tier}`)
  const t0 = performance.now()
  const scene = await buildScene({ tier })
  const { env, quality } = scene
  const ff = env.farField
  const ffStats = ff.stats()
  console.log(`  built + drained in ${((performance.now() - t0) / 1000).toFixed(1)} s; farField failed jobs: ${ffStats.failed}`)
  check(ffStats.failed === 0, 'no deferred job failed')

  // --- parked cars ------------------------------------------------------------------------------------
  const cars = ff.group.userData.parkedCars
  const roots = ff.group.children.filter((o) => /^carPark-\d+$/.test(o.name) && o.userData.cars)
  const byBody = {}
  let drawn = 0, heroes = 0
  for (const r of roots) {
    drawn += r.userData.cars.drawn
    heroes += r.userData.cars.heroes ?? 0
    for (const [k, v] of Object.entries(r.userData.cars.byBody ?? {})) byBody[k] = (byBody[k] ?? 0) + v
  }
  console.log(`  ${roots.length} carPark cells, ${fmt(drawn)} bodies drawn of ${fmt(cars?.cars ?? 0)} planned (stride ${cars?.stride}); mix ${JSON.stringify(byBody)}`)
  check(roots.length > 0 && (ffStats.byKind.carPark ?? 0) >= roots.length, `carPark-<cell> entries exist (${roots.length} roots, ${ffStats.byKind.carPark ?? 0} entries of kind carPark)`)
  check(drawn === cars.bodies, `per-cell drawn counts add up to stats.bodies (${fmt(drawn)} = ${fmt(cars.bodies)})`)
  check((byBody.keitruck ?? 0) > 0, `kei trucks in the mix: ${byBody.keitruck ?? 0} of ${fmt(drawn)} drawn (${(((byBody.keitruck ?? 0) / Math.max(1, drawn)) * 100).toFixed(1)} %; CAR_MIX 6 / 100)`)
  const truckMeshes = []
  for (const r of roots) r.traverse((o) => { if (o.isInstancedMesh && /-keitruck$/.test(o.name)) truckMeshes.push(o) })
  check(truckMeshes.length > 0, `carParkBodies-<cell>-keitruck InstancedMeshes: ${truckMeshes.length}`)
  check(CAR_BODIES.length === 7 && CAR_BODIES[6] === 'keitruck', `CAR_BODIES has 7 bodies with keitruck at row 6 (${CAR_BODIES.join(', ')})`)
  const heroEntries = ff.group.children.filter((o) => /^carParkHero-/.test(o.name))
  let heroMeshes = 0
  for (const r of roots) r.traverse((o) => { if (/^carParkHero-\d+$/.test(o.name)) heroMeshes++ })
  check(heroEntries.length === 0 && heroMeshes === 0 && heroes === 0 && cars.heroBodies === 0, `no carParkHero-* in Node (assets null): ${heroMeshes} hero groups, ${heroes} hero cars, heroKinds [${cars.heroKinds.join(', ')}]`)
  const carMeshes = []
  for (const r of roots) r.traverse((o) => { if (o.isMesh || o.isInstancedMesh) carMeshes.push(o) })
  const cv = finiteVertices(carMeshes)
  check(cv.nan === 0, `car meshes: no NaN / infinite vertex (${fmt(cv.vertices)} vertices in ${carMeshes.length} meshes)`)

  // --- solar farms -------------------------------------------------------------------------------------
  const out = env.group.userData.outskirts ?? null
  const solarStatic = ff.group.children.filter((o) => o.isMesh && /^solar-m\d+$/.test(o.name))
  const detailRoots = ff.group.children.filter((o) => /^solarDetail-\d+$/.test(o.name))
  const sd = { racks: 0, huts: 0, posts: 0, panels: 0 }
  for (const r of detailRoots) for (const k of Object.keys(sd)) sd[k] += r.userData.outskirts?.[k] ?? 0
  const detailMeshes = []
  for (const r of detailRoots) r.traverse((o) => { if (o.isMesh || o.isInstancedMesh) detailMeshes.push(o) })
  const detailTris = detailMeshes.reduce((a, m) => a + trisOf(m), 0)
  console.log(`  solar: ${solarStatic.length} merged panel meshes; detail ${detailRoots.length} cells, ${sd.racks} racked segments, ${sd.huts} huts, ${sd.posts} fence posts, ${sd.panels} mesh panels, ${fmt(detailTris)} triangles`)
  check(solarStatic.length > 0, `static panel meshes merged per block (${solarStatic.length})`)
  if (quality.farField.solarDetail) {
    check(detailRoots.length > 0 && sd.racks > 0, `solarDetail-<cell> entries on the high tier (${detailRoots.length} cells, ${sd.racks} racked segments)`)
    check(sd.huts > 0, `inverter huts built: ${sd.huts} (farms ≥ ${2000} m²)`)
    check(sd.posts > 0, `solar fence posts: ${sd.posts}`)
    check(detailMeshes.every((m) => m.castShadow === false), 'solar detail meshes cast no shadow')
    const dv = finiteVertices(detailMeshes)
    check(dv.nan === 0, `solar detail: no NaN / infinite vertex (${fmt(dv.vertices)} vertices)`)
  } else {
    check(detailRoots.length === 0, `no solarDetail-* on this tier (${detailRoots.length})`)
  }
  if (out) console.log(`  outskirts stats: ${JSON.stringify(out.solar)}`)

  // --- pylons + cables ------------------------------------------------------------------------------------
  const pylons = env.group.getObjectByName('pylons')
  const cables = env.group.getObjectByName('powerCables')
  if (pylons) {
    const per = Math.floor((pylons.geometry.index ? pylons.geometry.index.count : pylons.geometry.attributes.position.count) / 3)
    console.log(`  pylons: ${pylons.count} towers × ${fmt(per)} triangles = ${fmt(per * pylons.count)} (≈ 60 k expected)`)
    check(pylons.isInstancedMesh && pylons.count > 0, `pylons is one InstancedMesh with ${pylons.count} towers`)
    check(per > 1800 && per < 3200, `triangles per tower ${fmt(per)} within 1.8–3.2 k (truss arms + insulator strings + peak)`)
    check(pylons.castShadow === quality.treeShadows, `pylons castShadow = quality.treeShadows (${pylons.castShadow})`)
    const pv = finiteVertices([pylons])
    check(pv.nan === 0, `pylon prototype: no NaN vertex (${fmt(pv.vertices)} vertices)`)
    // the peak: the prototype reaches H + 3 = 45 m
    pylons.geometry.computeBoundingBox()
    check(Math.abs(pylons.geometry.boundingBox.max.y - 45) < 0.2, `prototype top at ${pylons.geometry.boundingBox.max.y.toFixed(2)} m (42 m lattice + 3 m ground-wire mast)`)
  } else check(false, 'pylons InstancedMesh present')
  if (cables) {
    const n = cables.geometry.attributes.position.count
    // 7 runs × 10 segments × 2 vertices per span
    check(n % 140 === 0 && n > 0, `powerCables: ${fmt(n)} line vertices = ${n / 140} spans × 7 runs × 10 segments`)
    const cvv = finiteVertices([cables])
    check(cvv.nan === 0, 'powerCables: no NaN vertex')
  } else check(false, 'powerCables present')
}

console.log(failures ? `\nvehicles-smoke: ${failures} failure(s)` : '\nvehicles-smoke: ok')
process.exit(failures ? 1 : 0)
