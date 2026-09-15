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
 *        STAIR_PIT.length; the floor at the corridor's start is the FIELD's own yNoCut at the
 *        portal − depth and its end that + grade · length; the cut is null at every road-frame
 *        point (the lap every 2 m, both sides, off < CUT_KEEP_OFF) and inside every corridor's
 *        polygon ≤ the no-cut field; no corridor polygon crosses a BARRIERS resolved line or a
 *        STANDS footprint (the OSM rings AND the chord bands of the hand-placed scaffolds); the
 *        `{ cut }` rows (corridor / foot / road) are rings of the plan; over the WHOLE floor
 *        inside the wall feet (every 0.25 m across × 0.5 m along) the field is the floor and the
 *        built face is the corridor's asphalt / gravel within 0.5 m; no dent just beyond the
 *        caps; no MARSHAL_POSTS row, ops placement or facility footprint inside a corridor and
 *        no placed instance / merged vertex standing on or hanging in one; the wall MESH read
 *        back over every run (≥ 0.5 m over the floor, sunk below it, no unwalled side) and the
 *        drawn ground at its foot; the portals counted from CUTS. I7: every opening shows the
 *        dark bore (3 rays per portal from inside the corridor at eye height meet
 *        `furniture-cut-tunnelInterior` first), with the low rays' collar hits reported. The I6 review (R1 / R2 / R9)
 *        replaced the three assertions that could not fail and the centreline-only sampling.
 *        buildMs.cuts / plan / meshes printed against BASE_MS, and the settle bleed outside the
 *        corridors reported (V8, P7).
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
    worksSW: { min: 20, why: 'the south-west works ramp daylights at the paddock road junction (116, −53), 24 m from the portal: 4.0 m at 16 % (the I6 review, R4 / V3 — 5.5 m / 8 % ran 66 m through that road and the fuel station)' },
  }
  const { env, track, plan, ground } = scene
  const cuts = env.cuts
  const osm = await import(path.join(ROOT, 'app/data/suzuka-facilities.ts'))
  const bar = await import(path.join(ROOT, 'app/data/suzuka-barriers-spec.ts'))
  const ops = await import(path.join(ROOT, 'app/data/ops-spec.ts'))
  const trackside = await import(path.join(ROOT, 'app/three/trackside.ts'))
  const v = new THREE.Vector3()
  const FOOT = spec.CUT_WALL_FOOT
  console.log(`  --- cuts (${cuts.corridors.length} corridors of ${spec.CUTS.length} CUTS)`)
  const missing = spec.CUTS.filter((c) => !cuts.corridors.some((q) => q.id === c.id)).map((c) => c.id)
  check(missing.length === 0, `every CUT has a corridor${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`)
  // the barrier lines and the stand footprints in world XZ: the OSM rings, and for a STANDS
  // row without one (the hand-placed scaffolds A1_TEMP / D_temp / the temporary O) its chord
  // band sRange × [lateralFront, lateralBack] sampled every ≈ 5 m of s — the works-road NE
  // corridor started inside A1_TEMP unseen while only the OSM rings were tested (the I6 review, R3 / V2)
  const lines = bar.BARRIERS.map((run) => ({ run, line: trackside.resolveLineCached(track, run.source, run.sRange, run.side, run.minGap ?? 0.6) })).filter((r) => r.line.samples.length >= 2)
    .map(({ run, line }) => ({ id: run.id, pts: line.samples.map(([s, lat]) => { track.pointAt(s, lat, v, 0); return { x: v.x, z: v.z } }) }))
  const stands = []
  let boxStands = 0
  for (const st of spec.STANDS) {
    let rings = 0
    for (const id of st.osmWays ?? []) { const f = osm.osmFeature(id); if (f?.closed) { stands.push({ id: st.id, ring: f.en.map(([e, n]) => ({ x: e * track.enScale, z: -n * track.enScale })) }); rings++ } }
    if (rings) continue
    const [s0, s1] = st.sRange
    const len = ((s1 - s0) % track.length + track.length) % track.length || track.length
    const n = Math.max(2, Math.ceil(len / 5) + 1)
    const front = [], back = []
    for (let i = 0; i < n; i++) {
      const s = track.wrap(s0 + (len * i) / (n - 1))
      track.pointAt(s, st.side * spec.alongAt(st.lateralFront, s, st.sRange), v, 0); front.push({ x: v.x, z: v.z })
      track.pointAt(s, st.side * spec.alongAt(st.lateralBack, s, st.sRange), v, 0); back.push({ x: v.x, z: v.z })
    }
    stands.push({ id: `${st.id} (box)`, ring: [...front, ...back.reverse()] })
    boxStands++
  }
  const cross = (a, b, c, d) => { const o = (p, q, r) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x); return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0 }
  const polyCrosses = (poly, pts, closed) => { for (let i = 0; i + 1 < pts.length + (closed ? 1 : 0); i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; for (let j = 0; j < poly.length; j++) if (cross(a, b, poly[j], poly[(j + 1) % poly.length])) return true } return false }
  /** the local forward direction at sample i of a corridor (its neighbours) */
  const dirAt = (c, i) => { const n = c.samples[Math.min(c.samples.length - 1, i + 1)], pv = c.samples[Math.max(0, i - 1)]; const l = Math.hypot(n.x - pv.x, n.z - pv.z) || 1; return { x: (n.x - pv.x) / l, z: (n.z - pv.z) / l } }
  /** the corridor polygon split back into its two edges, one point per sample (cuttings.ts corridorEdges) */
  const edgesOf = new Map()
  for (const c of cuts.corridors) { const poly = cuts.corridor(c.id), n = c.samples.length; edgesOf.set(c.id, poly.length === 2 * n ? { left: poly.slice(0, n), right: poly.slice(n).reverse() } : null) }
  /**
   * the point `w` metres toward the polygon's left edge (+) or right edge (−) from sample i,
   * `along` metres further along the centreline — on the line from the sample to the edge point,
   * so it follows the corridor's own frame (a track-frame corridor's walls lie on station rays,
   * not square to its centreline)
   */
  const at = (c, i, w, along = 0) => {
    const q = c.samples[i], u = dirAt(c, i), e = edgesOf.get(c.id)
    const edge = e ? (w >= 0 ? e.left[i] : e.right[i]) : null
    const W = w >= 0 ? q.wl : q.wr
    let x, z
    if (edge && W > 1e-6) { const f = Math.abs(w) / W; x = q.x + (edge.x - q.x) * f; z = q.z + (edge.z - q.z) * f }
    else { x = q.x - u.z * w; z = q.z + u.x * w }
    return { x: x + u.x * along, z: z + u.z * along }
  }
  const endBad = [], floorBad = [], barrierHits = [], standHits = [], ringBad = [], faceBad = [], capBad = []
  let higher = 0, insideN = 0, floorN = 0, floorMiss = 0, floorWorstF = 0, floorWorstB = 0, floorWorstAt = '', capN = 0
  const floorMissAt = []
  let bleed = 0, bleedAt = '', bleedN = 0
  /** the built floor may chord the field by this much inside the wall feet (an oblique ring corner: the foot chorded a little wider there) */
  const FLOOR_TOL = 0.5
  /** the built ground 0.3–1.0 m beyond a cap may not sit deeper than this under the field (a dent) where the field is flatter than CAP_SLOPE */
  const CAP_DENT = 0.15
  const CAP_SLOPE = 0.3
  for (const c of cuts.corridors) {
    const len = c.endD - c.startD
    const isPit = c.def.kind === 'stairPit'
    const min = isPit ? (c.def.length ?? spec.STAIR_PIT.length) - 0.01 : (SHORT_CUTS[c.id]?.min ?? 30)
    const max = isPit ? (c.def.length ?? spec.STAIR_PIT.length) + 0.01 : 120
    if (!(len >= min && len <= max)) endBad.push(`${c.id} ${len.toFixed(1)} m (${c.end})`)
    // the floor: the no-cut field at the portal (the field's own yNoCut, not the builder's copy) − depth, rising at the grade
    const expect0 = ground.field.yNoCut(c.portal.x, c.portal.z) - c.def.depth + c.def.grade * c.startD
    if (Math.abs(c.floorStart - expect0) > 1e-6 || Math.abs(c.floorEnd - c.floorStart - c.def.grade * (c.endD - c.startD)) > 1e-6) floorBad.push(`${c.id}: start ${c.floorStart.toFixed(3)} vs ${expect0.toFixed(3)}, end ${c.floorEnd.toFixed(3)} vs ${(c.floorStart + c.def.grade * (c.endD - c.startD)).toFixed(3)}`)
    const poly = cuts.corridor(c.id)
    for (const l of lines) if (polyCrosses(poly, l.pts, false)) barrierHits.push(`${c.id} × ${l.id}`)
    for (const st of stands) if (polyCrosses(poly, st.ring, true) || inRing(poly[0].x, poly[0].z, st.ring)) standHits.push(`${c.id} × ${st.id}`)
    // the rows: rings of the plan (corridor / foot where the shoulder fits / road)
    const parts = isPit ? ['corridor', 'road'] : spec.cutHasFootRing(c.def) ? ['corridor', 'foot', 'road'] : ['corridor', 'road']
    for (const part of parts) {
      const r = plan.rings.find((q) => q.area && 'cut' in q.area.footprint && q.area.footprint.cut === c.id && q.area.footprint.part === part)
      if (!r) ringBad.push(`${c.id}/${part}: no plan ring`)
    }
    // the whole floor inside the wall feet, every sample × every 0.25 m across (the first metre
    // past the portal's cap and the last one before an end wall left out: the caps' feet): the
    // field IS the floor there (cutAt set, |field − floor| within the grade over the sample
    // pitch — a point across from a kink of the way is up to a step from its sample), and the
    // built face is the corridor's own kind on the field within FLOOR_TOL — the I6 review
    // found the field null (R1) and the mesh 3–6 m high (R2 / V1) inside the feet while the
    // centreline alone read within 0.4 m
    let worstB = 0, worstBAt = '', wrongKind = 0
    for (let i = 0; i < c.samples.length; i++) {
      const q = c.samples[i]
      if (q.d < c.startD + FOOT + 0.1 || q.d > c.endD - (c.end !== 'daylight' ? FOOT + 0.1 : 0.01)) continue
      const n = c.samples[Math.min(c.samples.length - 1, i + 1)], pv = c.samples[Math.max(0, i - 1)]
      const wl = Math.min(q.wl, n.wl, pv.wl), wr = Math.min(q.wr, n.wr, pv.wr)
      // FOOT + 0.3 in from the wall tops: the rings are resampled at 2 m, and on a way's kink
      // their chords cut the corner by a few centimetres — a probe 5 cm inside the foot ring's
      // line landed in the drawn foot strip, which chords the wall foot by design
      for (let w = -wr + FOOT + 0.3; w <= wl - FOOT - 0.3 + 1e-9; w += 0.25) {
        const { x, z } = at(c, i, w)
        floorN++
        const f = ground.field.y(x, z)
        const ef = Math.abs(f - q.floor)
        if (ef > floorWorstF) floorWorstF = ef
        if (ground.field.cutAt(x, z) === null || ef > 0.05 + c.def.grade * 0.55) { floorMiss++; if (floorMissAt.length < 4) floorMissAt.push(`${c.id} d ${q.d} w ${w.toFixed(2)} (${ground.field.cutAt(x, z) === null ? 'null' : `field ${f.toFixed(2)} floor ${q.floor.toFixed(2)}`})`) }
        const b = ground.builtY(x, z)
        if (!b || !['asphaltArea', 'gravelArea'].includes(b.kind)) { wrongKind++; continue }
        const eb = Math.abs(b.y - f)
        if (eb > worstB) { worstB = eb; worstBAt = `d ${q.d} w ${w.toFixed(2)} (${b.kind} ${b.y.toFixed(2)} vs field ${f.toFixed(2)})` }
      }
    }
    if (worstB > floorWorstB) { floorWorstB = worstB; floorWorstAt = `${c.id} ${worstBAt}` }
    if (wrongKind || worstB > FLOOR_TOL) faceBad.push(`${c.id}: ${wrongKind} floor points not on the corridor's asphalt / gravel, built vs field max ${worstB.toFixed(2)} m at ${worstBAt}`)
    // inside the polygon the field never rises above the no-cut field
    for (let i = 0; i < c.samples.length; i++) {
      const q = c.samples[i]
      for (const w of [-q.wr + 0.1, 0, q.wl - 0.1]) {
        const { x, z } = at(c, i, w)
        insideN++
        if (ground.field.y(x, z) > ground.field.yNoCut(x, z) + 1e-9) higher++
      }
    }
    // beyond both caps (0.3 / 0.6 / 1.0 m out, across the width): no dent — the built ground
    // within CAP_DENT of the field wherever the field is flatter than CAP_SLOPE (a ring's tip
    // parked on the fill columns tied the enclosing ring's column to the inner ring's tip and
    // dug a wedge 1.1–1.7 m deep just outside the stair heads: the I6 review, R7)
    for (const [i, dir] of [[0, -1], [c.samples.length - 1, 1]]) {
      const q = c.samples[i]
      for (const beyond of [0.3, 0.6, 1.0]) for (let w = -q.wr + 0.3; w <= q.wl - 0.3 + 1e-9; w += 0.5) {
        const { x, z } = at(c, i, w, dir * beyond)
        const b = ground.builtY(x, z)
        if (!b) continue
        const f = ground.field.y(x, z)
        const slope = Math.max(Math.abs(ground.field.y(x + 1, z) - ground.field.y(x - 1, z)), Math.abs(ground.field.y(x, z + 1) - ground.field.y(x, z - 1))) / 2
        if (slope > CAP_SLOPE) continue
        capN++
        if (b.y < f - CAP_DENT) capBad.push(`${c.id} ${dir < 0 ? 'start' : 'end'} +${beyond} w ${w.toFixed(1)}: ${b.kind} ${(b.y - f).toFixed(2)} m under the field`)
      }
    }
    // report-only (the I6 review, V8): the BARE terrain beside a corridor. Terrain.settle's
    // clampUnderSheets lowers all three nodes of every height-grid triangle a ground face dips
    // into, so a corridor's own faces pull the grid down up to a cell outside the polygon, and
    // where nothing is drawn there (no GroundFace: the county roads' verges, the T1 infield
    // beside the works ramp) the drawn terrain sits in a trough under the field. Covering it
    // needs a collar face around every corridor — 2 grid cells is 27 m high / 36 m low, which
    // at loopSouth's and chicaneLeft's daylight ends (lateral +56…+60) would reach past the
    // 75 m band into the far field's ground: P7, with the raster refinement. Measured here so
    // it cannot grow unseen
    for (let i = 0; i < c.samples.length; i += 4) {
      const q = c.samples[i]
      for (const side of [1, -1]) for (let r = 2; r <= 30; r += 4) {
        const { x, z } = at(c, i, side > 0 ? q.wl + r : -(q.wr + r))
        if (ground.builtY(x, z)) continue
        bleedN++
        const d = ground.field.y(x, z) - ground.standY(x, z)
        if (d > bleed) { bleed = d; bleedAt = `${c.id} ${r} m ${side > 0 ? 'left' : 'right'} of d ${q.d}` }
      }
    }
    console.log(`    ${c.id.padEnd(14)} portal (${c.portal.s.toFixed(0)}, ${c.portal.lateral.toFixed(1)}) hdg ${c.portal.heading.toFixed(0).padStart(3)}°${(c.portal.pushed ? ` pushed ${c.portal.pushed.toFixed(2)}` : '').padEnd(13)}  d ${String(c.startD).padStart(4)} → ${String(c.endD).padStart(5)} (${c.end.padEnd(8)})  floor ${c.floorStart.toFixed(2)} → ${c.floorEnd.toFixed(2)}  built−field max ${worstB.toFixed(2)} m over the floor`)
  }
  check(endBad.length === 0, `every road cut daylights within 30–120 m of its portal (SHORT_CUTS: ${Object.keys(SHORT_CUTS).join(', ')}) and every stair pit runs its length (${spec.STAIR_PIT.length} m, pedNippo_L 10)${endBad.length ? ` — not: ${endBad.join('; ')}` : ''}`)
  check(floorBad.length === 0, `the floor at every corridor's start is the field's own yNoCut at the portal − depth (+ grade · start) and its end floorStart + grade · length${floorBad.length ? ` — not: ${floorBad.join('; ')}` : ''}`)
  check(barrierHits.length === 0, `no corridor polygon crosses a BARRIERS resolved line (${lines.length} lines)${barrierHits.length ? ` — ${barrierHits.join('; ')}` : ''}`)
  check(standHits.length === 0, `no corridor polygon crosses or starts inside a STANDS footprint (${stands.length} footprints, ${boxStands} of them chord bands of hand-placed stands)${standHits.length ? ` — ${standHits.join('; ')}` : ''}`)
  check(ringBad.length === 0, `every corridor's rows (corridor / foot where the shoulder fits / road) are rings of the plan${ringBad.length ? ` — ${ringBad.join('; ')}` : ''}`)
  check(floorMiss === 0, `the field is the floor on every point of every corridor inside the wall feet (${floorN} points every 0.25 m across × 0.5 m along; ${floorMiss} read null or off the floor, |field − floor| max ${floorWorstF.toFixed(3)} m)${floorMissAt.length ? ` — ${floorMissAt.join('; ')}` : ''}`)
  check(faceBad.length === 0, `the built face over every corridor floor (inside the wall feet) is the corridor's asphalt / gravel and follows the field within ${FLOOR_TOL} m (worst ${floorWorstB.toFixed(2)} m at ${floorWorstAt})${faceBad.length ? ` — ${faceBad.join('; ')}` : ''}`)
  check(capBad.length === 0, `no dent beyond a corridor's caps: the built ground 0.3–1.0 m outside both caps is within ${CAP_DENT} m of the field where the field is flatter than ${CAP_SLOPE} (${capN} points)${capBad.length ? ` — ${capBad.slice(0, 6).join('; ')}` : ''}`)
  check(higher === 0, `inside the corridors the field never rises above the no-cut field (${insideN} points, ${higher} higher)`)
  console.log(`  the bare terrain 2–30 m outside the corridors (${bleedN} points with no ground face) sits up to ${bleed.toFixed(2)} m under the field${bleedAt ? ` (${bleedAt})` : ''} — the settle bleed of clampUnderSheets, report-only until P7 covers it`)
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
  // --- the tables and the placed objects against the corridors (the I6 review, V7) ------------------
  // MARSHAL_POSTS, the ops placements, the INFIELD_FACILITIES / PADDOCK_BUILDINGS footprints: not
  // inside any corridor (the chicane escape-road post stood on the county road's floor, the works
  // road's south-west ramp ran through the fuel station)
  {
    const inCut = []
    for (const m of bar.MARSHAL_POSTS) { track.pointAt(track.wrap(m.s), m.lateral, v, 0); if (cuts.at(v.x, v.z) !== null) inCut.push(`MARSHAL_POSTS (${m.s}, ${m.lateral})`) }
    for (const o of ops.opsPlacements()) { track.pointAt(track.wrap(o.s), o.lateral, v, 0); if (cuts.at(v.x, v.z) !== null) inCut.push(`ops ${o.id ?? o.kind} (${o.s}, ${o.lateral})`) }
    const polys = cuts.corridors.map((c) => ({ id: c.id, ring: cuts.corridor(c.id) }))
    const footHit = (id, pts) => { for (const p of polys) if (pts.some((q) => inRing(q.x, q.z, p.ring)) || polyCrosses(p.ring, pts, true)) inCut.push(`${id} × ${p.id}`) }
    for (const [table, rows] of [['INFIELD_FACILITIES', spec.INFIELD_FACILITIES], ['PADDOCK_BUILDINGS', spec.PADDOCK_BUILDINGS]]) {
      for (const f of rows ?? []) {
        const pts = []
        for (const id of [f.osmWay, ...(f.axisWays ?? [])].filter((w) => w !== undefined)) { const w = osm.osmFeature(id); if (w) for (const [e, nn] of w.en) pts.push({ x: e * track.enScale, z: -nn * track.enScale }) }
        if (pts.length) { footHit(`${table} ${f.id} (way)`, pts); continue }
        if (f.sRange && Array.isArray(f.lateral)) {
          const box = []
          for (const [s, lat] of [[f.sRange[0], f.lateral[0]], [f.sRange[1], f.lateral[0]], [f.sRange[1], f.lateral[1]], [f.sRange[0], f.lateral[1]]]) { track.pointAt(track.wrap(s), lat, v, 0); box.push({ x: v.x, z: v.z }) }
          footHit(`${table} ${f.id} (band)`, box)
        } else if (f.s !== undefined && f.lateral !== undefined) { track.pointAt(track.wrap(f.s), f.lateral, v, 0); if (cuts.at(v.x, v.z) !== null) inCut.push(`${table} ${f.id} (${f.s}, ${f.lateral})`) }
      }
    }
    check(inCut.length === 0, `no MARSHAL_POSTS row, ops placement, INFIELD_FACILITIES or PADDOCK_BUILDINGS footprint lies inside a CUT corridor${inCut.length ? ` — ${inCut.slice(0, 6).join('; ')}` : ''}`)
  }
  // every placed instance (InstancedMesh matrices) and every merged mesh's vertices outside the
  // ground / terrain / the cuttings' own meshes: nothing inside a corridor polygon below the
  // old ground — standing on the floor or hanging in the trench (167 instances did before the
  // review: A1_TEMP's tubes, the fuel station, the marshal post, the S-beyond crowd, a lamp)
  {
    const SKIP = /^ground:|terrain|^furniture-cut-|^props-cut-|^structures-footbridge-|^props-footbridge|^structures-underpass-|lines?$|road|kerb|Skirt/i
    const m = new THREE.Matrix4(), p = new THREE.Vector3()
    const hits = new Map()
    const note = (name, x, y, z, what) => { const c = cuts.at(x, z); if (c === null) return; const nc = ground.field.yNoCut(x, z); if (y > nc - 0.3) return; const k = `${name} (${what})`; const e = hits.get(k) ?? { n: 0, ex: `(${x.toFixed(1)}, ${y.toFixed(2)}, ${z.toFixed(1)}) floor ${c.toFixed(2)} old ground ${nc.toFixed(2)}` }; e.n++; hits.set(k, e) }
    scene.root.updateMatrixWorld(true)
    scene.root.traverse((o) => {
      if (!o.isMesh || SKIP.test(o.name)) return
      if (o.isInstancedMesh) { for (let i = 0; i < o.count; i++) { o.getMatrixAt(i, m); p.setFromMatrixPosition(m).applyMatrix4(o.matrixWorld); note(o.name || '(inst)', p.x, p.y, p.z, 'instance') } return }
      const pos = o.geometry?.attributes?.position
      if (!pos) return
      const step = Math.max(1, Math.floor(pos.count / 20000))
      for (let i = 0; i < pos.count; i += step) { p.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld); const c = cuts.at(p.x, p.z); if (c !== null && p.y > c + 0.5) note(o.name || '(mesh)', p.x, p.y, p.z, 'vertices') }
    })
    check(hits.size === 0, `no placed instance and no merged mesh vertex stands on or hangs in a corridor below the old ground (${cuts.corridors.length} corridors traversed)${hits.size ? ` — ${[...hits].slice(0, 8).map(([k, e]) => `${k} ${e.n} at ${e.ex}`).join('; ')}` : ''}`)
    const bs = env.stats?.banks
    if (bs) console.log(`  banks: ${bs.inCut} lawn places / sheets / tents left out beside the corridors (CUT_MARGIN)`)
  }
  const b = env.buildMs
  const base = BASE_MS[tier]
  console.log(`  buildMs.cuts ${b.cuts?.toFixed(0)} ms; plan ${b.plan?.toFixed(0)} ms (base ${base.plan}, Δ ${(b.plan - base.plan >= 0 ? '+' : '') + (b.plan - base.plan).toFixed(0)}), meshes ${b.meshes?.toFixed(0)} ms (base ${base.meshes}, Δ ${(b.meshes - base.meshes >= 0 ? '+' : '') + (b.meshes - base.meshes).toFixed(0)}) — report-only`)

  // ===== I6-b: the walls, portals, stairs and footbridges (cuttings.ts, group.userData.cuttings) =====
  const facts = env.group.userData.cuttings
  check(!!facts, 'group.userData.cuttings carries the cuttings facts (walls / portals / stairs / footbridges)')
  if (!facts) return
  const O5 = 0.6
  const segDist = (p, a, b) => { const dx = b.x - a.x, dz = b.z - a.z; const l2 = dx * dx + dz * dz || 1; const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2)); return Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t)) }
  /** the least distance between a polyline / ring and every BARRIERS line, and whether any segment crosses one */
  const barrierClear = (pts, closed) => {
    let min = Infinity, crossed = null
    for (const l of lines) {
      for (let i = 0; i + 1 < l.pts.length; i++) {
        const a = l.pts[i], bb = l.pts[i + 1]
        for (let j = 0; j + 1 < pts.length + (closed ? 1 : 0); j++) {
          const p = pts[j], q = pts[(j + 1) % pts.length]
          if (cross(a, bb, p, q)) crossed = l.id
          min = Math.min(min, segDist(p, a, bb), segDist(q, a, bb), segDist(a, p, q), segDist(bb, p, q))
        }
      }
    }
    return { min, crossed }
  }
  const standClear = (pts, closed) => {
    let min = Infinity, hit = null
    for (const st of stands) {
      if (polyCrosses(pts, st.ring, true) || inRing(pts[0].x, pts[0].z, st.ring)) hit = st.id
      for (let i = 0; i < st.ring.length; i++) { const a = st.ring[i], bb = st.ring[(i + 1) % st.ring.length]; for (const p of pts) min = Math.min(min, segDist(p, a, bb)) }
    }
    void closed
    return { min, hit }
  }
  // the walls: two per corridor, every run's inner face ≥ O5 from every BARRIERS line and STANDS footprint
  const wallsPer = new Map()
  for (const w of facts.walls) wallsPer.set(w.cut, (wallsPer.get(w.cut) ?? 0) + 1)
  const wallMissing = cuts.corridors.filter((c) => (wallsPer.get(c.id) ?? 0) < 2).map((c) => `${c.id} (${wallsPer.get(c.id) ?? 0})`)
  check(wallMissing.length === 0, `every corridor has a retaining wall on both sides (${facts.walls.length} runs over ${cuts.corridors.length} corridors)${wallMissing.length ? ` — fewer: ${wallMissing.join(', ')}` : ''}`)
  const wallBad = []
  for (const w of facts.walls) {
    const bc = barrierClear(w.inner, false), sc = standClear(w.inner, false)
    if (bc.crossed || bc.min < O5) wallBad.push(`${w.cut}/${w.side}: ${bc.crossed ? `crosses ${bc.crossed}` : `${bc.min.toFixed(2)} m from a BARRIERS line`}`)
    if (sc.hit || sc.min < O5) wallBad.push(`${w.cut}/${w.side}: ${sc.hit ? `inside / across stand ${sc.hit}` : `${sc.min.toFixed(2)} m from a STANDS footprint`}`)
  }
  check(wallBad.length === 0, `every wall run stays ≥ ${O5} m from the BARRIERS lines and the STANDS footprints (O5)${wallBad.length ? ` — ${wallBad.slice(0, 5).join('; ')}` : ''}`)
  // the wall MESH (furniture-cut-walls) read back: over every run's inner polyline its vertices
  // reach ≥ 0.5 m over the floor and below it (the sink); every corridor side that wants a wall
  // (its foot ≥ CUT_WALL_FOOT + 0.2 in and the ground outside ≥ 0.5 m over the floor) has a run
  // within a wall step of every sample; and the built ground at the inner polyline and a metre
  // further in is the field (the wall stands on the drawn floor — the bank in front of it is
  // gone: the I6 review, V1). The facts' own hMin ≥ 0.5 was cuttings.ts's WALL_MIN restated
  {
    const mesh = env.group.getObjectByName('furniture-cut-walls')
    const pos = mesh?.geometry?.attributes?.position
    const cells = new Map()
    const keyOf = (x, z) => `${Math.floor(x / 2)},${Math.floor(z / 2)}`
    if (pos) for (let i = 0; i < pos.count; i++) { const k = keyOf(pos.getX(i), pos.getZ(i)); let cell = cells.get(k); if (!cell) { cell = []; cells.set(k, cell) } cell.push([pos.getX(i), pos.getY(i), pos.getZ(i)]) }
    const near = (x, z, r) => { const out = []; for (let jx = -1; jx <= 1; jx++) for (let jz = -1; jz <= 1; jz++) for (const q of cells.get(`${Math.floor(x / 2) + jx},${Math.floor(z / 2) + jz}`) ?? []) if (Math.hypot(q[0] - x, q[2] - z) <= r) out.push(q); return out }
    const meshBad = [], groundBad = [], lowAt = []
    let worstG = 0, runPts = 0
    for (const w of facts.walls) {
      let low = 0, short = 0
      const c = cuts.corridors.find((cc) => cc.id === w.cut)
      for (const q of w.inner) {
        runPts++
        // the wall's station: the nearest corridor sample (its floor is what the wall was built to)
        let k = 0, kd = Infinity
        for (let i = 0; i < c.samples.length; i++) { const d = Math.hypot(c.samples[i].x - q.x, c.samples[i].z - q.z); if (d < kd) { kd = d; k = i } }
        const floor = c.samples[k].floor
        const vs = near(q.x, q.z, 0.12)
        if (!vs.length) { low++; continue }
        let top = -Infinity, bottom = Infinity
        for (const [, y] of vs) { top = Math.max(top, y); bottom = Math.min(bottom, y) }
        if (top - floor < 0.5 - 1e-6) short++
        if (bottom > floor + 1e-6) { low++; if (lowAt.length < 3) lowAt.push(`${w.cut}/${w.side} (${q.x.toFixed(1)}, ${q.z.toFixed(1)}) bottom ${bottom.toFixed(2)} floor ${floor.toFixed(2)} of ${vs.length} verts`) }
        // the drawn floor 0.3 m and 1 m in from the wall's foot — away from the caps' own feet
        // (the first / last metre of a walled end is the cap's foot, chorded) and from the last
        // 1.5 m of a daylighting end (the floor meets the ground there, past the wall's end);
        // 5 cm along the wall as well: a track-frame corridor's wall lies ON a station ray, and
        // a probe exactly on a ray can land on a micro row's needle triangle
        const d = c.samples[k].d
        if (d < c.startD + FOOT + 0.6 || d > c.endD - (c.end !== 'daylight' ? FOOT + 0.6 : 1.5)) continue
        const u = dirAt(c, k)
        const wv = w.side === 'left' ? c.samples[k].wl : c.samples[k].wr
        for (const r of [0.3, 1.0]) {
          const p0 = at(c, k, w.side === 'left' ? wv - FOOT - r : -(wv - FOOT - r), 0.05)
          const x = p0.x, z = p0.z
          const b = ground.builtY(x, z)
          if (!b) continue
          const e = Math.abs(b.y - ground.field.y(x, z))
          worstG = Math.max(worstG, e)
          if (e > 0.3) groundBad.push(`${w.cut}/${w.side} ${r.toFixed(1)} m in from the foot (${x.toFixed(1)}, ${z.toFixed(1)}): ${b.kind} ${e.toFixed(2)} m off the field`)
        }
      }
      if (low || short) meshBad.push(`${w.cut}/${w.side}: ${short} stations under 0.5 m over the floor, ${low} with no sunk vertex`)
    }
    check(!!pos && meshBad.length === 0, `furniture-cut-walls read back over every run's inner polyline (${runPts} stations): vertices ≥ 0.5 m over the floor and sunk below it${meshBad.length ? ` — ${meshBad.slice(0, 5).join('; ')}; ${lowAt.join('; ')}` : ''}`)
    check(groundBad.length === 0, `the built ground 0.3 m and 1 m in from every wall's inner foot is the field within 0.3 m (worst ${worstG.toFixed(2)})${groundBad.length ? ` — ${groundBad.slice(0, 5).join('; ')}` : ''}`)
    // every corridor side that wants a wall has a run within a wall step + the foot
    const gaps = []
    for (const c of cuts.corridors) for (const side of ['left', 'right']) {
      const runs = facts.walls.filter((w) => w.cut === c.id && w.side === side)
      let want = 0, unwalled = 0
      for (let i = 0; i < c.samples.length; i++) {
        const q = c.samples[i]
        const wv = side === 'left' ? q.wl : q.wr
        if (wv < FOOT + 0.2) continue
        // the builder's own rule (cuttings.ts: the drawn ground OUTSIDE 0.5 m beyond the edge + the parapet ≥ WALL_MIN over the floor)
        const outer = at(c, i, side === 'left' ? wv + 0.5 : -(wv + 0.5))
        if (ground.standY(outer.x, outer.z) + 0.3 - q.floor < 0.5) continue
        want++
        const foot = at(c, i, side === 'left' ? wv - FOOT : -(wv - FOOT))
        let d = Infinity
        for (const w of runs) for (const p of w.inner) d = Math.min(d, Math.hypot(p.x - foot.x, p.z - foot.z))
        if (d > 1.6) unwalled++
      }
      if (unwalled) gaps.push(`${c.id}/${side}: ${unwalled} of ${want} samples with no wall run within 1.6 m`)
    }
    check(gaps.length === 0, `every corridor side whose ground stands ≥ 0.5 m over the floor is walled (no sample further than a wall step + the foot from a run)${gaps.length ? ` — ${gaps.slice(0, 5).join('; ')}` : ''}`)
  }
  // the portals: one at every corridor's start, a second at the end of a cut that ends at the next tunnel (its way's end); every
  // row names a CUTS id, a stair pit's is its start; the opening's sill never crosses a BARRIERS line, the headwall's back (on
  // the cap) ≥ O5 from it
  const roadCuts = cuts.corridors.filter((c) => c.def.kind !== 'stairPit')
  const expectedPortals = spec.CUTS.length + roadCuts.filter((c) => c.end === 'wayEnd').length
  const portalMissing = cuts.corridors.filter((c) => !facts.portals.some((p) => p.cut === c.id && p.at === 'start')).map((c) => c.id)
  const portalRows = facts.portals.filter((p) => { const c = spec.CUTS.find((q) => q.id === p.cut); const cc = cuts.corridors.find((q) => q.id === p.cut); return !c || !cc || !['start', 'end'].includes(p.at) || (p.at === 'end' && (c.kind === 'stairPit' || cc.end !== 'wayEnd')) }).map((p) => `${p.cut}/${p.at}`)
  check(facts.portals.length === expectedPortals && portalMissing.length === 0 && portalRows.length === 0, `${facts.portals.length} portals = ${spec.CUTS.length} CUTS starts + ${expectedPortals - spec.CUTS.length} tunnel-end, every row a CUTS id with its kind's ends${portalMissing.length ? ` — no start portal: ${portalMissing.join(', ')}` : ''}${portalRows.length ? ` — odd rows: ${portalRows.join(', ')}` : ''}`)
  const portalBad = []
  for (const p of facts.portals) {
    const s = barrierClear(p.sill, false), bk = barrierClear(p.back, false)
    if (s.crossed) portalBad.push(`${p.cut}/${p.at}: the opening's sill crosses ${s.crossed}`)
    if (bk.crossed || bk.min < O5 - 0.01) portalBad.push(`${p.cut}/${p.at}: the headwall's back ${bk.crossed ? `crosses ${bk.crossed}` : `${bk.min.toFixed(2)} m from a BARRIERS line`}`)
    const minH = p.cut.startsWith('ped') ? 2.4 : 1.8
    if (p.openH < minH) portalBad.push(`${p.cut}/${p.at}: opening ${p.openH.toFixed(2)} m high`)
  }
  check(portalBad.length === 0, `no portal opening crosses a BARRIERS line, every headwall's back is ≥ ${O5} m from them, openings ≥ 2.4 m (pedestrian) / 1.8 m${portalBad.length ? ` — ${portalBad.join('; ')}` : ''}`)
  // I7: every opening SHOWS the dark bore. A ray fired from 6 m inside the corridor at eye height
  // (floor + 2 m, kept 0.4 m under the soffit) through three positions across the opening must
  // meet `furniture-cut-tunnelInterior` before anything else — before the I7 fix 20 of the 21
  // openings met the lit ground ramp instead (the cut's own fade climbs from the floor to the cap
  // inside the headwall's thickness, and the flat box was hung under it). The same rays are fired
  // at a third of the opening's height as a REPORT: there they still meet the drawn floor's rim
  // 2–10 cm IN FRONT of the sill — the corridor's end collar, which the P7 settle-bleed collar owns.
  const boreBad = [], collarHits = []
  const rc = new THREE.Raycaster()
  rc.far = 60
  env.group.updateMatrixWorld(true)
  for (const p of facts.portals) {
    const c = cuts.corridors.find((q) => q.id === p.cut)
    const k = p.at === 'start' ? 0 : c.samples.length - 1
    const q = c.samples[k], d = dirAt(c, k)
    const ux = p.at === 'start' ? d.x : -d.x, uz = p.at === 'start' ? d.z : -d.z
    const [A, B] = p.sill
    const shoot = (f, y) => {
      const tx = A.x + (B.x - A.x) * f, tz = A.z + (B.z - A.z) * f
      rc.set(new THREE.Vector3(tx + ux * 6, y, tz + uz * 6), new THREE.Vector3(-ux, 0, -uz))
      const hit = rc.intersectObject(env.group, true)[0]
      return { name: hit ? hit.object.name || hit.object.type : 'nothing', d: hit ? hit.distance - 6 : Infinity }
    }
    for (const f of [0.2, 0.5, 0.8]) {
      const eye = shoot(f, q.floor + Math.min(2, p.openH - 0.4))
      if (!eye.name.startsWith('furniture-cut-tunnelInterior')) boreBad.push(`${p.cut}/${p.at} at ${(100 * f).toFixed(0)} % across: ${eye.name} ${eye.d.toFixed(2)} m past the sill`)
      const low = shoot(f, q.floor + p.openH / 3)
      if (!low.name.startsWith('furniture-cut-tunnelInterior')) collarHits.push(`${p.cut}/${p.at}@${(100 * f).toFixed(0)}% ${low.name} ${low.d >= 0 ? '+' : ''}${low.d.toFixed(2)}`)
    }
  }
  check(boreBad.length === 0, `every opening shows the dark bore at eye height: ${facts.portals.length} portals × 3 rays meet furniture-cut-tunnelInterior first (bore ${Math.min(...facts.portals.map((p) => p.boreD)).toFixed(2)}–${Math.max(...facts.portals.map((p) => p.boreD)).toFixed(2)} m deep)${boreBad.length ? ` — not: ${boreBad.slice(0, 6).join('; ')}` : ''}`)
  console.log(`    note: ${collarHits.length} of ${3 * facts.portals.length} low rays (a third of the opening) meet the corridor's end collar first, all within 0.15 m of the sill (P7): ${collarHits.slice(0, 3).join(', ')}${collarHits.length > 3 ? ' …' : ''}`)
  const pits = cuts.corridors.filter((c) => c.def.kind === 'stairPit')
  check(facts.stairs.length === pits.length && pits.every((c) => facts.stairs.includes(c.id)), `stairs in every stair pit (${facts.stairs.length} of ${pits.length})`)
  // the footbridges: every FOOTBRIDGES row is a `structures-footbridge-<id>` mesh, its soffit ≥ clearance over a cut floor / road face
  // under it (≥ minGap over the ground), its abutments and steps ≥ O5 from the BARRIERS lines and the STANDS footprints
  const fbBad = []
  for (const def of spec.FOOTBRIDGES) {
    const mesh = env.group.getObjectByName(`structures-footbridge-${def.osmWay}`)
    if (!mesh || !mesh.geometry?.attributes?.position?.count) { fbBad.push(`${def.osmWay}: no mesh`); continue }
    const f = facts.footbridges.find((q) => q.osmWay === def.osmWay)
    if (!f) { fbBad.push(`${def.osmWay}: no facts`); continue }
    const need = f.under === 'ground' ? spec.FOOTBRIDGE.minGap : def.clearance
    if (f.headroom < need - 1e-6) fbBad.push(`${def.osmWay}: headroom ${f.headroom.toFixed(2)} over ${f.under} (needs ${need})`)
    // the corridor under the chicane service bridge: the soffit over every corridor sample within the deck's width of its line
    if (f.under === 'cut') {
      let worst = Infinity
      for (const c of cuts.corridors) for (const q of c.samples) if (segDist(q, f.ends[0], f.ends[1]) <= def.deckW / 2) worst = Math.min(worst, f.soffit - q.floor)
      if (worst < def.clearance - 1e-6) fbBad.push(`${def.osmWay}: soffit ${worst.toFixed(2)} m over a corridor sample (needs ${def.clearance})`)
    }
    for (const fp of f.footprints) {
      const bc = barrierClear(fp, true), sc = standClear(fp, true)
      if (bc.crossed || bc.min < O5) fbBad.push(`${def.osmWay}: a footprint ${bc.crossed ? `crosses ${bc.crossed}` : `${bc.min.toFixed(2)} m from a BARRIERS line`}`)
      if (sc.hit || sc.min < O5) fbBad.push(`${def.osmWay}: footprint #${f.footprints.indexOf(fp)} ${sc.hit ? `inside / across stand ${sc.hit}` : `${sc.min.toFixed(2)} m from a STANDS footprint`}`)
    }
    console.log(`    footbridge ${def.osmWay} ${def.name.padEnd(10)} top ${f.top.toFixed(2)} soffit ${f.soffit.toFixed(2)} headroom ${f.headroom.toFixed(2)} over ${f.under}, ${f.footprints.length} footprints`)
  }
  check(fbBad.length === 0, `every FOOTBRIDGES row is a structures-footbridge-<id> mesh with its soffit ≥ clearance over what passes under it and its abutments / steps ≥ ${O5} m from the BARRIERS lines and stands${fbBad.length ? ` — ${fbBad.join('; ')}` : ''}`)
  check(!env.group.getObjectByName('structures-underpass-bridge') && !!env.group.getObjectByName('structures-underpass-rails'), 'the v1 6 m slab (structures-underpass-bridge) is gone and structures-underpass-rails stays')
  for (const name of ['furniture-cut-walls', 'furniture-cut-portals', 'furniture-cut-copings', 'furniture-cut-tunnelInterior', 'props-cut-stairs']) {
    const o = env.group.getObjectByName(name)
    check(!!o && o.geometry.attributes.position.count > 0, `  mesh '${name}' exists (${o ? o.geometry.attributes.position.count / 3 : 0} tris)`)
  }
  const st = env.stats?.infield ?? {}
  console.log(`  stats.infield cuttings-walls ${st['cuttings-walls']} / -portals ${st['cuttings-portals']} / -stairs ${st['cuttings-stairs']} / -footbridges ${st['cuttings-footbridges']}`)
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
