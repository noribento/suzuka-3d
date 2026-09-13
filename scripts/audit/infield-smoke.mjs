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
 *        tier the plan / meshes build times are PRINTED against the numbers held in BASE_MS
 *        (report-only; the I5-a rows had doubled them, the partition speed-up took them back).
 *        The I5 review (F5 / V3): the Spoon entry's hard-standing edge is the aerial's line —
 *        grass 1.5 m inside it, paddock 1.5 m outside it over s 3430–3530 (the I4-c wall stood
 *        5–7 m inside the sheet; trackside-smoke asserts the run is gone).
 *  I5-c  the ponds and trees (`checkPondsTrees` below): the water planes of the `surface`
 *        BASINS rows, the dry basins' shore rings, reeds and puddles, the material
 *        combinations (the reed cards are the one new program), INFIELD_TREES planted by the
 *        'trees' and 'infield-south-trees' jobs, and the scatter's absence inside the ring.
 *
 *  I5-b  the facilities (`checkFacilities` below): INFIELD_FACILITIES counts and boxes, the
 *        walls / fences, the tyre / kerb ground objects, the infield cars and lamps, the build
 *        time, a report-only slab listing under the G8-exempt names.
 *
 *  I6-a  `--cuts` (`checkCuts` below): the cut corridors of the field (CUTS, ground-field.ts,
 *        README R6): every CUT has a corridor; a road cut daylights 30–120 m from its portal
 *        (SHORT_CUTS names the ones the ground ends sooner, with why) and a stair pit runs its
 *        STAIR_PIT.length; the floor at the corridor's start is the portal's field − depth; the
 *        cut is null at every road-frame point (the lap every 2 m, both sides, off < CUT_KEEP_OFF)
 *        and inside every corridor's polygon ≤ the no-cut field; no corridor polygon crosses a
 *        BARRIERS resolved line or a STANDS OSM footprint; the `{ cut }` rows are rings of the
 *        plan and the built face over each corridor's centreline is the row's kind (the
 *        stair-pit floors owned by asphaltArea) and follows the field within 1.5 m (the wall
 *        foot chorded over a raster row); buildMs.cuts / plan / meshes printed against BASE_MS.
 *
 *   node scripts/audit/infield-smoke.mjs [--tier high|low|both] [--glb] [--cuts]
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

const { tiers, check, finish, glb, args } = smokeArgs('infield-smoke')
const CUTS_CHECK = args.includes('--cuts')

const spec = await import(path.join(ROOT, 'app/data/suzuka-facilities-spec.ts'))
const groundMod = await import(path.join(ROOT, 'app/three/ground.ts'))

/**
 * The plan / meshes build times after the partition speed-up (Node, this machine, medians of 3 on an idle box,
 * measured 2026-09-13 on c8bd7e7 + the speed-up; before it the I5-a rows had taken them to 19.8 / 15.9 s (high)
 * and 18.9 / 16.1 s (low), and before I5-a they were 8.7 / 7.9 s and 10.6 / 8.2 s): the smoke prints the deltas as
 * a fact, it does not fail on them — the browser's setupMs ceiling is perf-gate's.
 */
const BASE_MS = { high: { plan: 4350, meshes: 10700 }, low: { plan: 4390, meshes: 10800 } }

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
    // the `{ cut }` rows are the corridors' (checkCuts, --cuts): a road ring owns the inside of
    // its corridor ring, so the 60 % rule below does not describe them
    if ('cut' in row.footprint) continue
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
  // --- the Spoon infield's edge (the I5 review, F5 / V3) ---------------------------------------------
  // The hard-standing's inner edge over the Spoon entry is the aerial's line (hand vertices of
  // the 'スプーン インフィールド硬地' ring, s 3405–3530): grass 1.5 m inside it (the verge between
  // the kerb and the sheet), the sheet 1.5 m outside it (the I4-c wall stood 5–7 m inside the
  // sheet with paving on both sides).
  {
    const edge = [[3405, 13], [3430, 15], [3455, 16.8], [3480, 18.6], [3500, 20], [3530, 22.5]]
    const latAt = (s) => { for (let i = 1; i < edge.length; i++) { const [s0, l0] = edge[i - 1], [s1, l1] = edge[i]; if (s >= s0 && s <= s1) return l0 + ((l1 - l0) * (s - s0)) / (s1 - s0) } return NaN }
    const bad = []
    for (let s = 3430; s <= 3530; s += 10) {
      const l = latAt(s)
      track.pointAt(s, l - 1.5, v, 0)
      const inner = plan.ownerAt(v.x, v.z, [3380, 3820]).kind
      track.pointAt(s, l + 1.5, v, 0)
      const outer = plan.ownerAt(v.x, v.z, [3380, 3820]).kind
      if (inner !== 'grass' || outer !== 'paddock') bad.push(`s ${s} lat ${l.toFixed(1)}: ${inner} / ${outer}`)
    }
    check(bad.length === 0, `Spoon entry s 3430–3530: grass 1.5 m inside the hard-standing's edge and paddock 1.5 m outside it${bad.length ? ` (${bad.join('; ')})` : ''}`)
    // no BARRIERS run inside Spoon at all (truth-aerial 11): trackside-smoke asserts it on the
    // table. A general "no wall with paving on both sides" rule is NOT a fact of this circuit:
    // the pit wall, the T1 island wall and the paddock road's walls all stand between two
    // paved sheets by design (tried in the I5 review: 8 legitimate runs hit it).
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
  // --- I5-c: the ponds, the dry basins' dressing and the infield trees --------------------------------
  await checkPondsTrees(scene, tier, check)
  // --- I5-a: the build time (report-only) ------------------------------------------------------------
  {
    const b = env.buildMs
    const base = BASE_MS[tier]
    console.log(`  buildMs.plan ${b.plan?.toFixed(0)} ms (base ${base.plan}, Δ ${(b.plan - base.plan >= 0 ? '+' : '') + (b.plan - base.plan).toFixed(0)}), buildMs.meshes ${b.meshes?.toFixed(0)} ms (base ${base.meshes}, Δ ${(b.meshes - base.meshes >= 0 ? '+' : '') + (b.meshes - base.meshes).toFixed(0)}), buildMs.infield ${b.infield?.toFixed(0)} ms — report-only`)
  }
  // --- I5-b: the facilities ------------------------------------------------------------------------------
  checkFacilities(scene, check, tier, { glb: false })
  // --- I6-a: the cut corridors ----------------------------------------------------------------------------
  if (CUTS_CHECK) await checkCuts(scene, check, tier)
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

// ===== I6-a: checkCuts (ground-field.ts buildCutField, the `{ cut }` GROUND_AREAS rows) =============
async function checkCuts(scene, check, tier) {
  /** road cuts whose corridor daylights sooner than 30 m, and why (the plan's 30–120 m is the norm) */
  const SHORT_CUTS = {
    r200service: { min: 8, why: 'the ground south of the 200R portal falls 3.5 m within 15 m toward the west straight (the two roads are 4 m apart in height there), so a 4.5 m / 8 % approach meets it after ≈ 10 m' },
  }
  const { env, track, plan, ground } = scene
  const cuts = env.cuts
  const osm = await import(path.join(ROOT, 'app/data/suzuka-facilities.ts'))
  const bar = await import(path.join(ROOT, 'app/data/suzuka-barriers-spec.ts'))
  const trackside = await import(path.join(ROOT, 'app/three/trackside.ts'))
  const v = new THREE.Vector3()
  console.log(`  --- cuts (${cuts.corridors.length} corridors of ${spec.CUTS.length} CUTS)`)
  const missing = spec.CUTS.filter((c) => !cuts.corridors.some((q) => q.id === c.id)).map((c) => c.id)
  check(missing.length === 0, `every CUT has a corridor${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`)
  // the barrier lines and the stand footprints in world XZ
  const lines = bar.BARRIERS.map((run) => ({ run, line: trackside.resolveLineCached(track, run.source, run.sRange, run.side, run.minGap ?? 0.6) })).filter((r) => r.line.samples.length >= 2)
    .map(({ run, line }) => ({ id: run.id, pts: line.samples.map(([s, lat]) => { track.pointAt(s, lat, v, 0); return { x: v.x, z: v.z } }) }))
  const stands = []
  for (const st of spec.STANDS) for (const id of st.osmWays ?? []) { const f = osm.osmFeature(id); if (f?.closed) stands.push({ id: st.id, ring: f.en.map(([e, n]) => ({ x: e * track.enScale, z: -n * track.enScale })) }) }
  const cross = (a, b, c, d) => { const o = (p, q, r) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x); return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0 }
  const polyCrosses = (poly, pts, closed) => { for (let i = 0; i + 1 < pts.length + (closed ? 1 : 0); i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; for (let j = 0; j < poly.length; j++) if (cross(a, b, poly[j], poly[(j + 1) % poly.length])) return true } return false }
  const endBad = [], floorBad = [], barrierHits = [], standHits = [], ringBad = [], faceBad = []
  let higher = 0, insideN = 0
  for (const c of cuts.corridors) {
    const len = c.endD - c.startD
    const isPit = c.def.kind === 'stairPit'
    const min = isPit ? spec.STAIR_PIT.length - 0.01 : (SHORT_CUTS[c.id]?.min ?? 30)
    const max = isPit ? spec.STAIR_PIT.length + 0.01 : 120
    if (!(len >= min && len <= max)) endBad.push(`${c.id} ${len.toFixed(1)} m (${c.end})`)
    if (Math.abs(c.floorStart - (c.fieldAtPortal - c.def.depth + c.def.grade * c.startD)) > 1e-6) floorBad.push(c.id)
    const poly = cuts.corridor(c.id)
    for (const l of lines) if (polyCrosses(poly, l.pts, false)) barrierHits.push(`${c.id} × ${l.id}`)
    for (const st of stands) if (polyCrosses(poly, st.ring, true) || inRing(poly[0].x, poly[0].z, st.ring)) standHits.push(`${c.id} × ${st.id}`)
    // the rows: rings of the plan, the built face over the centreline
    for (const part of ['corridor', 'road']) {
      const r = plan.rings.find((q) => q.area && 'cut' in q.area.footprint && q.area.footprint.cut === c.id && q.area.footprint.part === part)
      if (!r) ringBad.push(`${c.id}/${part}: no plan ring`)
    }
    // the centreline inside the wall feet (the first metre past the portal's cap and, for a
    // level cut, the last metre before the end wall): the road ring's asphalt, on the field
    // within 1.5 m — the feet themselves are chorded over a raster row and are the gravel /
    // pit ring's
    let worst = 0, wrongKind = 0
    for (const q of c.samples) {
      if (q.d < c.startD + 1.01 || q.d > c.endD - (c.def.level ? 1.01 : 0.01)) continue
      const b = ground.builtY(q.x, q.z)
      const f = ground.field.y(q.x, q.z)
      if (!b) { wrongKind++; continue }
      if (b.kind !== 'asphaltArea') wrongKind++
      worst = Math.max(worst, Math.abs(b.y - f))
    }
    if (wrongKind || worst > 1.5) faceBad.push(`${c.id}: ${wrongKind} centreline samples not on the road face, built vs field max ${worst.toFixed(2)} m`)
    // inside the polygon the field never rises above the no-cut field
    c.samples.forEach((q, i) => {
      const n = c.samples[Math.min(c.samples.length - 1, i + 1)], pv = c.samples[Math.max(0, i - 1)]
      let dx = n.x - pv.x, dz = n.z - pv.z
      const l = Math.hypot(dx, dz) || 1
      dx /= l; dz /= l
      for (const w of [-q.wr + 0.1, 0, q.wl - 0.1]) {
        const x = q.x - dz * w, z = q.z + dx * w
        insideN++
        if (ground.field.y(x, z) > ground.field.yNoCut(x, z) + 1e-9) higher++
      }
    })
    console.log(`    ${c.id.padEnd(14)} portal (${c.portal.s.toFixed(0)}, ${c.portal.lateral.toFixed(1)}) hdg ${c.portal.heading.toFixed(0).padStart(3)}°${(c.portal.pushed ? ` pushed ${c.portal.pushed.toFixed(2)}` : '').padEnd(13)}  d ${String(c.startD).padStart(4)} → ${String(c.endD).padStart(5)} (${c.end.padEnd(8)})  floor ${c.floorStart.toFixed(2)} → ${c.floorEnd.toFixed(2)}  built−field max ${worst.toFixed(2)} m`)
  }
  check(endBad.length === 0, `every road cut daylights within 30–120 m of its portal (SHORT_CUTS: ${Object.keys(SHORT_CUTS).join(', ')}) and every stair pit runs ${spec.STAIR_PIT.length} m${endBad.length ? ` — not: ${endBad.join('; ')}` : ''}`)
  check(floorBad.length === 0, `the floor at every corridor's start is the portal's field − depth (+ grade · start)${floorBad.length ? ` — not: ${floorBad.join(', ')}` : ''}`)
  check(barrierHits.length === 0, `no corridor polygon crosses a BARRIERS resolved line (${lines.length} lines)${barrierHits.length ? ` — ${barrierHits.join('; ')}` : ''}`)
  check(standHits.length === 0, `no corridor polygon crosses or starts inside a STANDS footprint (${stands.length} footprints)${standHits.length ? ` — ${standHits.join('; ')}` : ''}`)
  check(ringBad.length === 0, `every corridor's road and corridor rows are rings of the plan${ringBad.length ? ` — ${ringBad.join('; ')}` : ''}`)
  check(faceBad.length === 0, `the built face over every corridor centreline (inside the wall feet) is the road ring's asphaltArea (the stair-pit floors included) and follows the field within 1.5 m${faceBad.length ? ` — ${faceBad.join('; ')}` : ''}`)
  check(higher === 0, `inside the corridors the field never rises above the no-cut field (${insideN} points, ${higher} higher)`)
  // the road frame: cutAt null at every point of the lap off < CUT_KEEP_OFF, both sides
  let n = 0, bad = 0
  for (let s = 0; s < track.length; s += 2) {
    const hw = track.halfWidthAt(s)
    for (const lat of [-(hw + spec.CUT_KEEP_OFF - 0.05), -(hw + 1), -hw * 0.5, 0, hw * 0.5, hw + 1, hw + spec.CUT_KEEP_OFF - 0.05]) {
      track.pointAt(s, lat, v, 0)
      n++
      if (ground.field.cutAt(v.x, v.z) !== null) bad++
    }
  }
  check(bad === 0, `field.cutAt is null at every road-frame point of the lap (${n} points every 2 m, both sides to off ${spec.CUT_KEEP_OFF}; ${bad} inside a cut)`)
  const b = env.buildMs
  const base = BASE_MS[tier]
  console.log(`  buildMs.cuts ${b.cuts?.toFixed(0)} ms; plan ${b.plan?.toFixed(0)} ms (base ${base.plan}, Δ ${(b.plan - base.plan >= 0 ? '+' : '') + (b.plan - base.plan).toFixed(0)}), meshes ${b.meshes?.toFixed(0)} ms (base ${base.meshes}, Δ ${(b.meshes - base.meshes >= 0 ? '+' : '') + (b.meshes - base.meshes).toFixed(0)}) — report-only`)
}

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
 *    reports and their sum is ≤ Quality.infield.infieldCars; no two cars are closer than 2.3 m
 *    (the C lot's folded legs, the I5 review V1; `rejects.overlap` printed per lot);
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
    // no two cars on one spot: the C lot's s range folds round T1–T2 and laid every bay twice
    // until the I5 review (V1) — pairs closer than a bay's width − 0.2 m are a fold come back
    let close = 0, closest = Infinity
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      const d = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1])
      if (d < closest) closest = d
      if (d < 2.3) close++
    }
    const overlaps = lots.reduce((a, l) => a + (l.rejects.overlap ?? 0), 0)
    check(close === 0, `  no two cars closer than 2.3 m (${close} pairs; closest ${closest.toFixed(2)} m; ${overlaps} bays rejected as overlaps by the fold test — report-only)`)
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

/**
 * I5-c — the ponds, the dry basins' dressing and the infield trees:
 *   - every `surface` BASINS row is ONE `furniture-infield-pond-<i>` plane (transparent, no
 *     depth write — the far water's own parameter set, so one program for all water), flat
 *     at its shoreline − WATER_PLANE_DROP, its vertices finite, a 'water' face drawn under its
 *     centre (or the island's grass) below the plane; stats.infield['infield-ponds'] agrees;
 *     the ground at every rim vertex and 0.5 / 3 m outside it (the ring's outward normal) is
 *     above the plane (the relief only lowers the ground: a rim under the plane is water
 *     hanging out of the ground) — asserted on the high tier, report-only on low, whose 17.7 m
 *     terrain grid is pushed under the bed by whole triangles and dips outside the far shore
 *     where no face covers it; report-only: the share of water-face vertices above the plane;
 *   - the dry basins' gravel shore rings (GROUND_AREAS gravelArea rows, the OSM ring grown 3 m)
 *     own the ground 0.75 m outside the OSM shoreline on ≥ 80 % of the ring's vertices;
 *   - the reeds: `infield-reeds-L0-*` InstancedMeshes, every instance inside a dry basin's
 *     outline, ≥ 150 of them, the material { map, alphaMap, alphaTest, DoubleSide } — and that
 *     combination is on NO other material of the scene (the one budgeted program of I5-c);
 *     the water planes share the far water's combination and the puddles the braking rubber's;
 *   - the puddles: one `infield-puddles` decal tagged soft at LAYER.verge.paint, ≤ 0.5 m² bare;
 *   - INFIELD_TREES: every placement of the pure helper (the guard's own expansion) inside the
 *     ring and ≥ hw + 6 off the road, every non-deferred one planted by the 'trees' job and the
 *     south rows by 'infield-south-trees' (both drained, none skipped for a paved face);
 *   - the scatter: no `trees-*` instance stands inside the ring outside a SUR_FOREST polygon.
 */
async function checkPondsTrees(scene, tier, check) {
  const { env, track, ground, plan } = scene
  const bar = await import(path.join(ROOT, 'app/data/suzuka-barriers-spec.ts'))
  const standsMod = await import(path.join(ROOT, 'app/three/stands.ts'))
  const waterMod = await import(path.join(ROOT, 'app/three/infield-water.ts'))
  const vegMod = await import(path.join(ROOT, 'app/three/vegetation.ts'))
  const treesData = await import(path.join(ROOT, 'app/data/infield-trees.ts'))
  const osm = await import(path.join(ROOT, 'app/data/suzuka-facilities.ts'))
  const st = env.stats?.infield ?? {}
  const v = new THREE.Vector3()
  const inPts = (x, z, pts) => { let inside = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const a = pts[i], b = pts[j]; if (a[1] > z !== b[1] > z && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside } return inside }
  /** a material's program-deciding parameter set (what three keys its programs by, minus the tier-wide ones) */
  const combo = (m) => `${m.type}|map${m.map ? 1 : 0}|alpha${m.alphaMap ? 1 : 0}|nor${m.normalMap ? 1 : 0}|emis${m.emissiveMap ? 1 : 0}|test${m.alphaTest > 0 ? 1 : 0}|a2c${m.alphaToCoverage ? 1 : 0}|side${m.side}|tr${m.transparent ? 1 : 0}|vc${m.vertexColors ? 1 : 0}|key${m.customProgramCacheKey !== THREE.Material.prototype.customProgramCacheKey ? m.customProgramCacheKey() : ''}`

  // --- the ponds ---------------------------------------------------------------------------------
  const basins = bar.BASINS.map((b) => ({ def: b, r: standsMod.resolveBasin(track, b) }))
  check(basins.every((b) => b.r), `every BASINS row resolves to an outline (${basins.map((b) => `${b.def.name}: ${b.r ? b.r.pts.length : 'none'}`).join(', ')})`)
  const surface = basins.filter((b) => b.def.surface && b.r)
  const ponds = []
  env.group.traverse((o) => { if (o.isMesh && /^furniture-infield-pond-/.test(o.name)) ponds.push(o) })
  check(ponds.length === surface.length && st['infield-ponds'] === surface.length, `${ponds.length} water planes for ${surface.length} surface basins (stats.infield['infield-ponds'] = ${st['infield-ponds']})`)
  const waterFar = env.terrain.group.getObjectByName('water-far')
  for (const p of ponds) {
    const m = p.material
    const b = surface.find((s) => s.def.name === p.userData.basin)
    const pos = p.geometry.attributes.position
    let yMin = Infinity, yMax = -Infinity
    for (let i = 0; i < pos.count; i++) { yMin = Math.min(yMin, pos.getY(i)); yMax = Math.max(yMax, pos.getY(i)) }
    const want = b ? b.r.shoreY - waterMod.WATER_PLANE_DROP : NaN
    p.geometry.computeBoundingBox()
    const c = p.geometry.boundingBox.getCenter(new THREE.Vector3())
    const face = ground.builtY(c.x, c.z)
    const fv = finiteVertices([p])
    check(m.transparent && !m.depthWrite && fv.nan === 0 && Math.abs(yMin - want) < 1e-3 && Math.abs(yMax - want) < 1e-3, `  ${p.name} (${p.userData.basin}): transparent, depthWrite false, ${pos.count} vertices finite, flat at shore − ${waterMod.WATER_PLANE_DROP} (y ${yMin.toFixed(2)}…${yMax.toFixed(2)}, want ${want.toFixed(2)})`)
    // under the centre: the water bed below the plane, or the island's grass above it
    const island = face?.kind === 'grassArea'
    check(!!face && (face.kind === 'water' ? face.y < want : island && face.y > want), `    a ${face?.kind ?? 'bare'} face under its centre, ${face ? Math.abs(want - face.y).toFixed(2) : '?'} m ${island ? 'above (the island)' : 'below'} the plane`)
    check(!!waterFar && combo(waterFar.material) === combo(m), `    the same material combination as water-far (${combo(m)})`)
    // the rim: the relief only ever lowers the ground, so the plane has to fit UNDER the ground
    // at every rim vertex and just outside it (0.5 m and 3 m along the ring's outward normal) —
    // at 9a81a6b the west pond's plane stood 0.75 m over its near shore along 338 m of the
    // shoreline (the I5 review, F1 / V2); worst vertex reported in the basin's own window
    if (b) {
      const r = b.r, pts = r.pts, n = pts.length
      let bad = 0, badM = 0, worst = null
      for (let i = 0; i < n; i++) {
        const [x0, z0] = pts[i], [x1, z1] = pts[(i + 1) % n], [xp, zp] = pts[(i - 1 + n) % n]
        let nx = z1 - zp, nz = -(x1 - xp)
        const l = Math.hypot(nx, nz) || 1
        nx /= l; nz /= l
        if (inPts(x0 + nx * 0.5, z0 + nz * 0.5, pts)) { nx = -nx; nz = -nz }
        const dy = Math.min(ground.standY(x0, z0), ground.standY(x0 + nx * 0.5, z0 + nz * 0.5), ground.standY(x0 + nx * 3, z0 + nz * 3)) - want
        if (dy < -0.02) {
          bad++
          badM += Math.hypot(x1 - x0, z1 - z0)
          if (!worst || dy < worst.dy) { const q = b.def.sRange ? track.nearestOnRange(x0, z0, b.def.sRange[0], b.def.sRange[1], 0) : track.nearestOnRange(x0, z0, 0, track.length, 0); worst = { dy, s: q.s, lateral: q.lateral } }
        }
      }
      const rimMsg = `the ground at / 0.5 m / 3 m outside every rim vertex is above the plane (${bad} of ${n} below, ${badM.toFixed(0)} m of shoreline${worst ? `; worst s ${worst.s.toFixed(0)} lat ${worst.lateral.toFixed(0)}: ${worst.dy.toFixed(2)} m` : ''})`
      // the low tier's 17.7 m terrain grid (high 13.3 m) is pushed under the sunken bed by whole
      // triangles (environment.ts clampUnderSheets), so where no drawn face covers the terrain
      // (the west pond's far shore) its mesh dips a cell or two out: reported there, asserted on high
      if (tier === 'high') check(bad === 0, `    ${rimMsg}`)
      else console.log(`    report-only (low: the terrain grid's moat under the bed): ${rimMsg}`)
      // report-only: the water face's vertices above the plane inside the ring — the banks
      // (> 0) but not the bulk of the bed (< 50 %; 28 % at the wrong level of 9a81a6b)
      const waterFace = scene.groundMeshes.faces.find((f) => f.kind === 'water')
      if (waterFace) {
        const wp = waterFace.geo.attributes.position
        let above = 0, tot = 0
        for (let i = 0; i < wp.count; i++) {
          const x = wp.getX(i), z = wp.getZ(i)
          if (x < r.box[0] || x > r.box[1] || z < r.box[2] || z > r.box[3] || !inPts(x, z, pts)) continue
          tot++
          if (wp.getY(i) > want) above++
        }
        console.log(`    report-only: ${above} of ${tot} water-face vertices inside the ring stand above the plane (the banks; ${tot ? (100 * above / tot).toFixed(0) : 0} %)`)
      }
    }
  }
  {
    const isl = bar.BASINS.find((b) => b.island)
    if (isl) {
      track.pointAt(track.wrap(isl.island.s), isl.island.lateral, v, 0)
      const owner = plan.ownerAt(v.x, v.z, isl.sRange)
      check(owner.kind === 'grassArea', `  the ${isl.name} island is owned by '${owner.name}' (${owner.kind})`)
    }
    check((st['infield-pondDecks'] ?? 0) === bar.BASINS.filter((b) => b.platform).length, `  ${st['infield-pondDecks']} pond deck(s) for ${bar.BASINS.filter((b) => b.platform).length} platform rows`)
  }
  // --- the dry basins' shore rings ---------------------------------------------------------------
  for (const b of basins.filter((q) => q.def.dry && q.def.osmWay)) {
    const f = osm.osmFeature(b.def.osmWay)
    const row = spec.GROUND_AREAS.find((a) => a.kind === 'gravelArea' && 'osm' in a.footprint && a.footprint.osm[0] === b.def.osmWay)
    if (!row) { console.log(`  note ${b.def.name}: no shore-ring row (the T1–T2 basin's rim is the T1 service road)`); continue }
    if (!f) { check(false, `  ${b.def.name}: OSM way missing`); continue }
    const pts = b.r.pts
    let own = 0
    for (let i = 0; i < pts.length; i++) {
      const [x0, z0] = pts[i], [x1, z1] = pts[(i + 1) % pts.length], [xp, zp] = pts[(i - 1 + pts.length) % pts.length]
      // outward: the normal that leaves the polygon
      const nx = (z1 - zp), nz = -(x1 - xp)
      const nl = Math.hypot(nx, nz) || 1
      let x = x0 + (nx / nl) * 0.75, z = z0 + (nz / nl) * 0.75
      if (inPts(x, z, pts)) { x = x0 - (nx / nl) * 0.75; z = z0 - (nz / nl) * 0.75 }
      if (plan.ownerAt(x, z, row.footprint.sRange).name === row.name) own++
    }
    check(own >= pts.length * 0.8, `  ${row.name}: owns ${own} of ${pts.length} points 0.75 m outside the shoreline`)
  }
  // --- the reeds and the puddles -------------------------------------------------------------------
  {
    const reeds = []
    env.farField.group.traverse((o) => { if (o.isInstancedMesh && /^infield-reeds-L0-/.test(o.name)) reeds.push(o) })
    const pts = standPoints(reeds)
    const dry = basins.filter((q) => q.def.dry && q.r).map((q) => q.r.pts)
    const outside = pts.filter(([x, z]) => !dry.some((ring) => inPts(x, z, ring)))
    check(reeds.length >= 1 && pts.length >= 150 && outside.length === 0 && st['infield-reeds'] === pts.length, `${pts.length} reed clusters in ${reeds.length} InstancedMesh(es), ${outside.length} outside the dry basins (stats ${st['infield-reeds']})`)
    const mats = new Set(reeds.map((r) => r.material))
    const rc = reeds.length ? combo(reeds[0].material) : ''
    const reedOk = [...mats].every((m) => m.map && m.alphaMap && !m.normalMap && m.alphaTest > 0 && m.side === THREE.DoubleSide && !m.transparent)
    check(mats.size === 1 && reedOk, `  one reed material { map, alphaMap, alphaTest, DoubleSide } (${rc})`)
    // the one budgeted program: no other material in the built scene has the reeds' combination
    const others = new Map()
    scene.root.traverse((o) => {
      if (!(o.isMesh || o.isInstancedMesh) || reeds.includes(o)) return
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) { const k = combo(m); if (!others.has(k)) others.set(k, o.name) }
    })
    check(!others.has(rc), `  the reed combination is on no other mesh (${others.size} other combinations in the scene${others.has(rc) ? `; also on ${others.get(rc)}` : ''})`)
    const puddles = env.group.getObjectByName('infield-puddles')
    const d = puddles?.userData.decal
    const rubber = scene.root.getObjectByName('brakingRubber')
    check(!!puddles && d?.soft === true && Math.abs(d.rung - groundMod.LAYER.verge.paint) < 1e-9 && d.uncovered <= 0.5, `${st['infield-puddles']} puddles as one soft decal at LAYER.verge.paint (uncovered ${d?.uncovered?.toFixed(2) ?? '?'} m², ${d?.area?.toFixed(0) ?? '?'} m²)`)
    check(!!puddles && !!rubber && combo(puddles.material) === combo(rubber.material), `  the puddles share the braking rubber's material combination`)
  }
  // --- INFIELD_TREES ---------------------------------------------------------------------------------
  {
    const placements = treesData.infieldTreePlacements(track)
    const bad = placements.filter((p) => !insideRing(p.x, p.z) || Math.abs(p.lateral) < track.halfWidthAt(p.s) + 6)
    check(placements.length > 0 && bad.length === 0, `${placements.length} INFIELD_TREES placements in ${spec.INFIELD_TREES.length} rows, ${bad.length} outside the ring / inside hw + 6${bad.length ? ` (${bad.slice(0, 3).map((p) => p.id).join(', ')})` : ''}`)
    const main = placements.filter((p) => !p.row.deferred).length, south = placements.length - main
    check(st['infield-trees'] === main && (st['infield-treesSkipped'] ?? 0) === 0, `  'trees' job planted ${st['infield-trees']} of ${main} (skipped ${st['infield-treesSkipped'] ?? 0} on paved / water faces)`)
    const ff = env.farField.stats()
    check(st['infield-south-trees'] === south && (st['infield-south-treesSkipped'] ?? 0) === 0 && Number.isFinite(ff.buildMs['infield-south-trees']) && ff.failed === 0, `  'infield-south-trees' job planted ${st['infield-south-trees']} of ${south} (skipped ${st['infield-south-treesSkipped'] ?? 0}), ran in ${ff.buildMs['infield-south-trees']?.toFixed(0)} ms, failed ${ff.failed}`)
    const entries = []
    env.farField.group.traverse((o) => { if ((o.isMesh || o.isInstancedMesh) && /^infield-(south-)?trees/.test(o.name)) entries.push(o) })
    const tp = standPoints(entries)
    check(entries.length > 0 && tp.length >= placements.length, `  ${entries.length} tree meshes under the far field carry ${tp.length} instances (≥ ${placements.length}: the mesh level and its cards / cones)`)
    // the scatter stays out of the ring except inside the woods
    const scatter = []
    env.farField.group.traverse((o) => { if ((o.isMesh || o.isInstancedMesh) && /^trees(q\d)?-/.test(o.name)) scatter.push(o) })
    const forests = vegMod.forestRings(track.enScale)
    const inForest = (x, z) => forests.some((f) => x >= f.box[0] && x <= f.box[2] && z >= f.box[1] && z <= f.box[3] && inPts(x, z, f.ring))
    const sp = standPoints(scatter)
    const inside = sp.filter(([x, z]) => insideRing(x, z) && !inForest(x, z))
    check(sp.length > 0 && inside.length === 0, `  the scatter (${sp.length} instances in ${scatter.length} meshes): ${inside.length} inside the ring outside SUR_FOREST${inside.length ? ` (${inside.slice(0, 3).map((p) => `${p[2]} at ${p[0].toFixed(0)}, ${p[1].toFixed(0)}`).join('; ')})` : ''}`)
    const kus = (await import(path.join(ROOT, 'app/data/tree-species.ts'))).TREE_SPECIES.kusunoki
    check(kus.tint[0][1] <= 0.75 && kus.tint[2][1] <= 0.65, `  kusunoki tint darkened (${JSON.stringify(kus.tint)})`)
  }
}
