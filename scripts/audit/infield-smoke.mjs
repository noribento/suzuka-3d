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
 *   node scripts/audit/infield-smoke.mjs [--tier high|low|both] [--glb]
 *
 * `--glb` is reserved for the phase's GLB path (stub-registry.mjs, like furniture-smoke --glb);
 * I5-a has none (the ground carries no GLB).
 * Exit 1 on any failure.
 */
import path from 'node:path'
import { buildScene, ROOT, THREE } from './app-runtime.mjs'
import { commonChecks, finiteVertices, fmt, smokeArgs } from './smoke-common.mjs'
import { insideRing } from './ring.mjs'

const { tiers, check, finish, glb } = smokeArgs('infield-smoke')
if (glb) console.log('--glb: no GLB path in this smoke yet (I5-a is ground rows and decals; I5-b adds the facilities)')

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
}

finish()
