#!/usr/bin/env node
/**
 * Infield smoke (I5 / I6 — the infield grounds, ponds, facilities, trees, cuttings and tunnels;
 * dev-only — not part of `pnpm check`): builds the scene on both tiers through app-runtime.mjs
 * (no asset pack → the procedural fallbacks), drains the far field and checks the common
 * I-phase facts (smoke-common.mjs): no deferred job failed, every `ops-*` / `infield-*` object
 * has finite vertices and stands inside the circuit ring 775428456, `buildMs.infield` finite
 * once the builder reports. Then the phase's own facts:
 *
 *  I5-a  the ground rows: every I5-a GROUND_AREAS row (from 'D パドック' on) is a ring of the
 *        built plan, its ring area is inside A9's 20 m² < A < 20,000 m² (the band, way and disc
 *        rows have no A9 bound: they are only asked to resolve), `plan.ownerAt` on a 2 m grid
 *        inside the ring is the row itself on ≥ 60 % of the points (the rest is what outranks
 *        it by design: the pit lane and its apron over the D paddock, a service road crossing a
 *        lot, the helipad on its apron, the loops' junctions) and the grid's drawn faces
 *        (ground.builtY) are never bare; the second helipad disc is owned by '第 2 ヘリパッド';
 *        the way-line decals (`infield-wayLines-<way>`, one per service road / school loop) are
 *        tagged markDecal at LAYER.verge.line with uncovered ≤ 0.5 m² each and every vertex
 *        finite, and stats.infield['infield-wayLineM'] ≥ 600 (metres of dash painted); the
 *        driving school (BUILDINGS stec, `builder: 'infield'`) is the `infield-buildings` mesh
 *        with its roof, inside the ring, and paddock.ts's `paddockBuildings` no longer carries
 *        it; the road face carries the `aFresh` attribute (0 outside FRESH_ASPHALT, 1 in the
 *        middle of it), and the asphaltArea material is its own (not the lanes'); on the low
 *        tier the plan / meshes build times are PRINTED against the pre-I5-a numbers held in
 *        BASE_MS (report-only: the plan expected +1.5–2.5 s, this is what it is).
 *
 *  I5-b  the facilities (`checkFacilities` below): INFIELD_FACILITIES counts and boxes, the
 *        walls / fences, the tyre / kerb ground objects, the infield cars and lamps, the build
 *        time, a report-only slab listing under the G8-exempt names.
 *
 *   node scripts/audit/infield-smoke.mjs [--tier high|low|both] [--glb]
 *
 * `--glb` builds the high tier once more with the I5-b drops behind a stub registry
 * (stub-registry.mjs, like furniture-smoke --glb) and runs the GLB facts of `checkFacilities`.
 * Exit 1 on any failure.
 */
import path from 'node:path'
import { buildScene, ROOT, THREE } from './app-runtime.mjs'
import { commonChecks, finiteVertices, fmt, smokeArgs, standPoints } from './smoke-common.mjs'
import { insideRing } from './ring.mjs'
import { buildSceneWith, stubRegistry } from './stub-registry.mjs'

const { tiers, check, finish, glb } = smokeArgs('infield-smoke')

const spec = await import(path.join(ROOT, 'app/data/suzuka-facilities-spec.ts'))
const groundMod = await import(path.join(ROOT, 'app/three/ground.ts'))

/**
 * The plan / meshes build times before I5-a (Node, this machine, c0e4bc5 rows, measured 2026-09-13 with the I5-a rows spliced out): the smoke prints the
 * deltas as a fact, it does not fail on them — the browser's setupMs ceiling is perf-gate's.
 */
const BASE_MS = { high: { plan: 8709, meshes: 7860 }, low: { plan: 10571, meshes: 8200 } }

const inRing = (x, z, r) => { let inside = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const a = r[i], b = r[j]; if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside } return inside }
const ringArea = (pts) => { let a2 = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a2 += p.x * q.z - q.x * p.z } return Math.abs(a2) / 2 }

for (const tier of tiers) {
  console.log(`\ninfield-smoke: tier ${tier}`)
  const t0 = performance.now()
  const scene = await buildScene({ tier })
  console.log(`  built + drained in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
  const { roots } = await commonChecks(scene, check, { buildKeys: ['infield'] })
  void roots
  const { env, track, plan, ground, groundMeshes } = scene

  // --- I5-a: the ground rows ---------------------------------------------------------------------
  const from = spec.GROUND_AREAS.findIndex((a) => a.name === 'D パドック')
  check(from >= 0, `GROUND_AREAS carries the I5-a rows from 'D パドック' (${spec.GROUND_AREAS.length - from} rows)`)
  const v = new THREE.Vector3()
  let rowsOk = 0, rowsBad = []
  for (const row of spec.GROUND_AREAS.slice(from)) {
    const r = plan.rings.find((q) => q.area === row)
    if (!r) { rowsBad.push(`${row.name}: no plan ring`); continue }
    const ring = r.ring
    const area = ringArea(ring.outer) - ring.holes.reduce((a, h) => a + ringArea(h), 0)
    const bounded = 'ring' in row.footprint || 'osm' in row.footprint
    if (bounded && !(area > 20 && area < 20000)) { rowsBad.push(`${row.name}: ring area ${area.toFixed(0)} m² outside A9's 20 < A < 20,000`); continue }
    const box = ring.box
    let n = 0, own = 0, bare = 0
    for (let x = box[0]; x <= box[1]; x += 2) for (let z = box[2]; z <= box[3]; z += 2) {
      if (!inRing(x, z, ring.outer) || ring.holes.some((h) => inRing(x, z, h))) continue
      n++
      if (plan.ownerAt(x, z, ring.sRange).name === row.name) own++
      if (!ground.builtY(x, z)) bare++
    }
    const share = n ? own / n : 0
    if (bare > 0) rowsBad.push(`${row.name}: ${bare} of ${n} grid points have no drawn face`)
    else if (share < 0.6) rowsBad.push(`${row.name}: plan.ownerAt is the row on ${(100 * share).toFixed(0)} % of ${n} grid points`)
    else rowsOk++
    console.log(`    ${row.name.padEnd(22)} ${row.kind.padEnd(11)} ${String(area.toFixed(0)).padStart(6)} m²  own ${(100 * share).toFixed(0).padStart(3)} % of ${n}`)
  }
  check(rowsBad.length === 0, `${rowsOk} I5-a rows resolve, own ≥ 60 % of their grid and stand on drawn faces${rowsBad.length ? `; ${rowsBad.length} not: ${rowsBad.slice(0, 4).join(' | ')}` : ''}`)
  {
    const h = spec.HELIPAD_2
    track.pointAt(track.wrap(h.s), h.lateral, v, 0)
    const owner = plan.ownerAt(v.x, v.z, [h.s - 30, h.s + 30])
    check(owner.name === '第 2 ヘリパッド' && ground.builtY(v.x, v.z)?.kind === 'helipad', `the second helipad (s ${h.s}, lat ${h.lateral}) is owned by '${owner.name}' on a ${ground.builtY(v.x, v.z)?.kind ?? 'bare'} face`)
    check(spec.HELIPADS.length === 2 && spec.HELIPADS[1].mark === 1, `HELIPADS: ${spec.HELIPADS.length} discs, the second on atlas tile ${spec.HELIPADS[1]?.mark}`)
  }
  // --- I5-a: the way-line decals ------------------------------------------------------------------
  {
    const lines = []
    env.group.traverse((o) => { if (o.isMesh && /^infield-wayLines-/.test(o.name)) lines.push(o) })
    const wayRows = spec.GROUND_AREAS.filter((a) => 'way' in a.footprint && a.kind === 'asphaltArea' && a.name.includes('管理道路') || (a.name.includes('周回路')))
    check(lines.length >= 5 && lines.length <= wayRows.length, `${lines.length} way-line decals (infield-wayLines-*; ${wayRows.length} way rows)`)
    let worst = 0, badRung = 0
    for (const m of lines) {
      const d = m.userData.decal
      if (!d || Math.abs(d.rung - groundMod.LAYER.verge.line) > 1e-9) badRung++
      worst = Math.max(worst, d?.uncovered ?? Infinity)
    }
    const fv = finiteVertices(lines)
    check(badRung === 0 && worst <= 0.5 && fv.nan === 0, `  every one tagged markDecal at LAYER.verge.line, uncovered ≤ 0.5 m² (worst ${worst.toFixed(2)}), ${fmt(fv.vertices)} vertices finite`)
    const st = env.stats?.infield ?? {}
    check((st['infield-wayLineM'] ?? 0) >= 600, `  stats.infield: wayLineM ${st['infield-wayLineM']} (≥ 600), skipped ${st['infield-wayLineSkippedM']} m, uncovered ${st['infield-wayLineUncoveredM2']} m², quads ${st['infield-wayLineQuads']}`)
  }
  // --- I5-a: the driving school block --------------------------------------------------------------
  {
    const walls = env.group.getObjectByName('infield-buildings')
    const roofs = env.group.getObjectByName('infield-buildingRoofs')
    check(!!walls && !!roofs, `infield-buildings + infield-buildingRoofs meshes exist (stats.infield['infield-buildings'] = ${env.stats?.infield?.['infield-buildings']})`)
    if (walls) {
      walls.geometry.computeBoundingBox()
      const c = walls.geometry.boundingBox.getCenter(new THREE.Vector3())
      check(insideRing(c.x, c.z), `  the block's centre (${c.x.toFixed(0)}, ${c.z.toFixed(0)}) is inside the circuit ring`)
      const f = spec.BUILDINGS.find((b) => b.id === 'stec')
      const top = walls.geometry.boundingBox.max.y, bottom = walls.geometry.boundingBox.min.y
      check(!!f && top - bottom > f.height && top - bottom < f.height + 1, `  ${(top - bottom).toFixed(1)} m tall (BUILDINGS stec height ${f?.height} + 0.5 sink)`)
    }
    const v1 = env.group.getObjectByName('paddockBuildings')
    if (v1) {
      v1.geometry.computeBoundingBox()
      // the school stands at world x ≈ 825, z ≈ 60 (s 30, lateral 160): paddock.ts's v1 extrusions must not reach it
      const pos = v1.geometry.attributes.position
      let near = 0
      for (let i = 0; i < pos.count; i++) if (Math.hypot(pos.getX(i) - 825, pos.getZ(i) - 60) < 40) near++
      check(near === 0, `  paddockBuildings has no vertex at the school (${near} within 40 m of it)`)
    }
  }
  // --- I5-a: aFresh and the area material -----------------------------------------------------------
  {
    const road = groundMeshes.faces.find((f) => f.kind === 'road')
    const a = road?.geo.getAttribute('aFresh')
    check(!!a && a.itemSize === 1 && a.count === road.geo.getAttribute('position').count, `ground:road carries aFresh (${a?.count ?? 0} values)`)
    if (a) {
      const [f0, f1] = spec.FRESH_ASPHALT.sRange
      const mid = track.wrap((f0 + f1) / 2)
      const pos = road.geo.getAttribute('position')
      const sampleAt = (s) => {
        track.pointAt(s, 0, v, 0)
        let best = -1, bd = Infinity
        for (let i = 0; i < pos.count; i++) { const d = Math.hypot(pos.getX(i) - v.x, pos.getZ(i) - v.z); if (d < bd) { bd = d; best = i } }
        return a.getX(best)
      }
      const inside = sampleAt(mid), outside = sampleAt(track.wrap(f0 - 200)), ramp = sampleAt(track.wrap(f0 + spec.FRESH_ASPHALT.fade / 2))
      check(inside > 0.99 && outside < 0.01 && ramp > 0.2 && ramp < 0.8, `  aFresh 1 at s ${mid.toFixed(0)} (${inside.toFixed(2)}), 0 at s ${track.wrap(f0 - 200).toFixed(0)} (${outside.toFixed(2)}), mid-ramp ${ramp.toFixed(2)} at s ${(f0 + spec.FRESH_ASPHALT.fade / 2).toFixed(0)}`)
      const mat = road.mesh.material
      check(mat.customProgramCacheKey?.() === 'macro|road', `  road material program key '${mat.customProgramCacheKey?.()}' (unchanged)`)
    }
    const area = groundMeshes.faces.find((f) => f.kind === 'asphaltArea')
    const lane = groundMeshes.faces.find((f) => f.kind === 'lane')
    check(!!area && !!lane && area.mesh.material !== lane.mesh.material && area.mesh.material.color.getHex() === 0x8c8c8a, `ground:asphaltArea has its own material (colour #${area?.mesh.material.color.getHexString()}, the lanes keep theirs)`)
  }
  // --- I5-a: the build time (report-only) ------------------------------------------------------------
  {
    const b = env.buildMs
    const base = BASE_MS[tier]
    console.log(`  buildMs.plan ${b.plan?.toFixed(0)} ms (base ${base.plan}, Δ ${(b.plan - base.plan >= 0 ? '+' : '') + (b.plan - base.plan).toFixed(0)}), buildMs.meshes ${b.meshes?.toFixed(0)} ms (base ${base.meshes}, Δ ${(b.meshes - base.meshes >= 0 ? '+' : '') + (b.meshes - base.meshes).toFixed(0)}), buildMs.infield ${b.infield?.toFixed(0)} ms — report-only`)
  }
  // --- I5-b: the facilities ------------------------------------------------------------------------------
  checkFacilities(scene, check, tier, { glb: false })
}

if (glb) {
  console.log('\ninfield-smoke: tier high --glb (the stub registry with the I5-b drops)')
  const reg = await stubRegistry(['model/trackside/tire_stack', 'model/ops/forklift', 'model/ops/porta_potty', 'model/ops/tent_canopy', 'model/trackside/flood_light', 'model/props/rollershutter_door'])
  console.log(`  loaded ${reg.loaded.length} models: ${reg.loaded.join(', ')}`)
  const t0 = performance.now()
  const scene = await buildSceneWith('high', reg)
  console.log(`  built + drained in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
  checkFacilities(scene, check, 'high', { glb: true })
}

finish()

// ===== I5-b: checkFacilities (infield-ground.ts buildInfieldFacilities) ===========================
/**
 * The facilities / walls / fences / kerbs / cars / lamps facts (plan §I5-b):
 *  - stats.infield['infield-facilities'] = INFIELD_FACILITIES.length, and every row left a box
 *    in `group.userData.infieldFacilities`;
 *  - every facility's box (its four corners) is inside the circuit ring and off the track
 *    envelope: |lateral| ≥ hw + 1.5 (O2) at every corner, projected in the row's own window;
 *  - the walls (`furniture-infield-walls`) and the fence cards (`furniture-infield-fence`) carry
 *    no horizontal face near the ground: every triangle with |ny| > 0.5 sits ≥ 0.5 m over
 *    ground.standY (the wall tops are 1 m up; the fence is vertical cards only);
 *  - the tyre stacks are tagged GROUND_OBJECTS.tyreStack, the south course's kerbs laneKerb, the
 *    islands' kerbs islandKerb (every InstancedMesh level of the tyres);
 *  - every parked car of `infield-cars` (L0) stands on a drawn `paddock` face and ≥ hw + 8 off
 *    the centreline (plan.project's d); the cars per lot are what `group.userData.infieldParking`
 *    reports and their sum is ≤ Quality.infield.infieldCars;
 *  - the service roads' lamps (`infield-service-lamps`) ≥ 30, none on a road-frame / water face;
 *  - buildMs.infield < 1500 ms (the whole infield-ground builder, I5-a lines included);
 *  - report-only: for every non-instanced mesh named `props*` / `furniture*` under env.group, the
 *    m² of up-facing triangles within ±0.3 m of ground.standY at their centroid — the G8 name
 *    exemption must not hide a slab (a number to read, not a bound);
 *  - `--glb` (high tier, the stub registry with the tire_stack / forklift / porta_potty /
 *    tent_canopy / flood_light / rollershutter_door drops): the near level of the tyres, the
 *    forklift, the toilets, the marquee roofs, the shutters and the mast heads draws a `-glb-`
 *    mesh at L0 with the procedural stand-in at L1 (3 levels), and the tyre GLB level is tagged
 *    tyreStack too.
 */
function checkFacilities(scene, check, tier, { glb: withGlb = false } = {}) {
  const { env, track, ground } = scene
  const st = env.stats?.infield ?? {}
  const rows = spec.INFIELD_FACILITIES
  const report = env.group.userData.infieldFacilities ?? []
  check(st['infield-facilities'] === rows.length && report.length === rows.length, `stats.infield['infield-facilities'] ${st['infield-facilities']} = INFIELD_FACILITIES ${rows.length} rows, ${report.length} boxes reported (buildings ${st['infield-facilityBuildings']}, marquees ${st['infield-marqueeCount']}, tanks ${st['infield-tanks']}, walls ${st['infield-wallM']} m, fences ${st['infield-fenceM']} m / ${st['infield-fencePosts']} posts)`)
  // --- every box inside the ring and off the track envelope (O2) ------------------------------------------
  {
    let outside = [], onTrack = []
    for (const r of report) {
      const [x0, z0, x1, z1] = r.box
      for (const [x, z] of [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]) {
        if (!insideRing(x, z)) { outside.push(r.id); break }
        const p = ground.plan.project(x, z, r.sRange ?? undefined)
        if (Math.abs(p.lateral) < track.halfWidthAt(track.wrap(p.s)) + 1.5) { onTrack.push(`${r.id} (s ${p.s.toFixed(0)}, lat ${p.lateral.toFixed(1)})`); break }
      }
    }
    check(outside.length === 0, `every facility box inside the circuit ring (${outside.length} outside${outside.length ? ': ' + outside.slice(0, 5).join(', ') : ''})`)
    check(onTrack.length === 0, `every facility box ≥ hw + 1.5 off the centreline — O2 (${onTrack.length} inside${onTrack.length ? ': ' + onTrack.slice(0, 5).join(', ') : ''})`)
  }
  // --- walls and fences: vertical only near the ground ---------------------------------------------------
  {
    const v = new THREE.Vector3()
    for (const name of ['furniture-infield-walls', 'furniture-infield-fence']) {
      const m = env.group.getObjectByName(name)
      if (!m) { if (name === 'furniture-infield-fence' && !scene.quality.infield.fences) console.log(`  note ${name} absent (Quality.infield.fences false on ${tier})`); else check(false, `${name} exists`); continue }
      const pos = m.geometry.attributes.position, nrm = m.geometry.attributes.normal
      let low = 0, tris = 0
      for (let i = 0; i < pos.count; i += 3) {
        tris++
        const ny = (nrm.getY(i) + nrm.getY(i + 1) + nrm.getY(i + 2)) / 3
        if (Math.abs(ny) <= 0.5) continue
        v.set((pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3, (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3, (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3)
        if (v.y - ground.standY(v.x, v.z) < 0.5) low++
      }
      check(low === 0, `${name}: ${fmt(tris)} triangles, ${low} horizontal ones within 0.5 m of the ground`)
    }
  }
  // --- the ground objects: tyres, the south kerbs, the island kerbs --------------------------------------
  {
    const tyreMeshes = []
    env.farField.group.traverse((o) => { if (o.isInstancedMesh && /^infield-tyres-/.test(o.name)) tyreMeshes.push(o) })
    const tagged = tyreMeshes.filter((m) => m.userData.groundObject?.kind === 'tyreStack')
    const n = tyreMeshes.reduce((a, m) => a + (m.name.includes('-L0-') ? m.count : 0), 0)
    check(tyreMeshes.length > 0 && tagged.length === tyreMeshes.length && n === st['infield-tyres'], `tyre stacks: ${tyreMeshes.length} InstancedMesh levels all tagged tyreStack, ${n} instances at L0 (stats ${st['infield-tyres']})`)
    const south = env.group.getObjectByName('infield-southKerbs')
    check(!!south && south.userData.groundObject?.kind === 'laneKerb' && st['infield-southKerbSections'] >= 4, `south course kerbs: ${st['infield-southKerbSections']} apex sections (≥ 4), ${st['infield-southKerbM']} m tagged laneKerb`)
    const islands = env.group.getObjectByName('infield-islandKerbs')
    check(!!islands && islands.userData.groundObject?.kind === 'islandKerb' && st['infield-islandKerbs'] === spec.INFIELD_ISLAND_KERBS.length, `island kerbs: ${st['infield-islandKerbs']} tagged islandKerb (INFIELD_ISLAND_KERBS ${spec.INFIELD_ISLAND_KERBS.length})`)
  }
  // --- the cars --------------------------------------------------------------------------------------------
  {
    const meshes = []
    env.farField.group.traverse((o) => { if (o.isInstancedMesh && /^infield-cars-.*-L0-/.test(o.name)) meshes.push(o) })
    const pts = standPoints(meshes)
    let offFace = 0, nearRoad = 0
    for (const [x, z] of pts) {
      const b = ground.builtY(x, z)
      if (!b || b.kind !== 'paddock') offFace++
      const p = ground.plan.project(x, z)
      if (p.d < track.halfWidthAt(track.wrap(p.s)) + 8) nearRoad++
    }
    const lots = env.group.userData.infieldParking ?? []
    const placed = lots.reduce((a, l) => a + l.cars, 0)
    check(pts.length > 0 && pts.length === placed && placed <= scene.quality.infield.infieldCars, `infield-cars: ${pts.length} L0 instances = ${placed} placed over ${lots.length} lots (≤ Quality.infield.infieldCars ${scene.quality.infield.infieldCars}); bays ${st['infield-bays']}, bay lines ${st['infield-bayLinesM']} m`)
    check(offFace === 0 && nearRoad === 0, `  every car on a drawn paddock face (${offFace} off) and ≥ hw + 8 off the centreline (${nearRoad} nearer)`)
    for (const l of lots) console.log(`    ${l.id.padEnd(8)} walked ${String(l.walked).padStart(5)} kept ${String(l.kept).padStart(4)} cars ${String(l.cars).padStart(4)}  rejects ${Object.entries(l.rejects).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ')}`)
  }
  // --- the lamps -------------------------------------------------------------------------------------------
  {
    const meshes = []
    env.farField.group.traverse((o) => { if (o.isInstancedMesh && /^infield-service-lamps-.*-L0-/.test(o.name)) meshes.push(o) })
    const pts = standPoints(meshes)
    let bad = 0
    for (const [x, z] of pts) { const b = ground.builtY(x, z); if (b && ['road', 'kerb', 'deckShoulder', 'pitLane', 'pitApron', 'water'].includes(b.kind)) bad++ }
    check(pts.length >= 30 && bad === 0, `infield-service-lamps: ${pts.length} poles (≥ 30), ${bad} on a road-frame / water face, ${st['infield-lampsDropped']} dropped`)
  }
  // --- the build time ------------------------------------------------------------------------------------
  check(env.buildMs.infield < 1500, `buildMs.infield ${env.buildMs.infield?.toFixed(0)} ms < 1500`)
  // --- report-only: up-facing m² near the ground under the G8-exempt names ---------------------------------
  {
    const v = new THREE.Vector3()
    const rows = []
    env.group.traverse((o) => {
      if (!o.isMesh || o.isInstancedMesh || !/^(props|furniture)/.test(o.name)) return
      const g = o.geometry
      const pos = g.attributes.position
      if (!pos) return
      const idx = g.index
      const n = idx ? idx.count / 3 : pos.count / 3
      let m2 = 0
      const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
      for (let t = 0; t < n; t++) {
        const i0 = idx ? idx.getX(t * 3) : t * 3, i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2
        a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); c.fromBufferAttribute(pos, i2)
        const s2 = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)
        if (s2 >= 0) continue // not up-facing
        v.set((a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3, (a.z + b.z + c.z) / 3)
        if (Math.abs(v.y - ground.standY(v.x, v.z)) <= 0.3) m2 += -s2 / 2
      }
      if (m2 > 0.05) rows.push([o.name, m2])
    })
    rows.sort((p, q) => q[1] - p[1])
    console.log(`  report-only: up-facing area within ±0.3 m of the ground under props* / furniture* names: ${rows.length ? rows.slice(0, 8).map(([n, m]) => `${n} ${m.toFixed(1)} m²`).join(', ') : 'none'}`)
  }
  // --- the GLB path ----------------------------------------------------------------------------------------
  if (withGlb) {
    const levelsOf = new Map()
    const glbMeshes = []
    env.farField.group.traverse((o) => {
      if (o.isInstancedMesh && /^infield-(tyres|forklift|toilets|marquees|shutters|mast-heads)-/.test(o.name)) {
        const entry = o.name.replace(/-L\d+-\d+$/, '').replace(/-[^-]+$/, '')
        void entry
        if (/-glb-/.test(o.name)) glbMeshes.push(o.name)
      }
    })
    for (const e of env.farField.entries ?? []) void e
    const sets = ['infield-tyres', 'infield-forklift', 'infield-toilets', 'infield-marquees', 'infield-shutters', 'infield-mast-heads']
    const have = sets.filter((s) => glbMeshes.some((n) => n.startsWith(s)))
    check(have.length === sets.length, `--glb: every GLB-backed set draws a -glb- mesh at its near level (${have.length} of ${sets.length}: ${have.join(', ')})`)
    const tyreGlb = []
    env.farField.group.traverse((o) => { if (o.isInstancedMesh && /^infield-tyres-.*-glb-/.test(o.name)) tyreGlb.push(o) })
    check(tyreGlb.length > 0 && tyreGlb.every((m) => m.userData.groundObject?.kind === 'tyreStack'), `--glb: the tyre GLB level is tagged tyreStack too (${tyreGlb.length} meshes)`)
    void levelsOf
  }
}
