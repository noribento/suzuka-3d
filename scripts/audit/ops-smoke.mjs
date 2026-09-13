#!/usr/bin/env node
/**
 * Ops smoke (I3 — the static operations layer; dev-only — not part of `pnpm check`): builds the
 * scene on both tiers through app-runtime.mjs (no asset pack → the procedural fallbacks), drains
 * the far field and checks the common I-phase facts (smoke-common.mjs): no deferred job failed,
 * every `ops-*` / `infield-*` object has finite vertices and stands inside the circuit ring
 * 775428456, `buildMs.ops` finite once the builder reports. Then the phase's own facts:
 *
 *  I3-a (the umbrella and the data): `buildMs.ops` is lapped; `env.stats.ops` has the seven
 *  keys { figures, byRole, impostors, near3d, mode, vehicles, equipment } with consistent
 *  counts (impostors + near3d === figures, mode ∈ baked / procedural / none — Node never
 *  'baked'); `env.group.userData.ops` is `ctx.ops` and its kind tally equals `opsPlacements()`'s
 *  (empty until I3-b/c/d fill the sections); every ops placement id is unique; the ops-spec
 *  helpers agree with PIT_ENVELOPE (12 stopped-car rectangles inside the working area, 12 lens
 *  columns, 11 crews of 12 + 3 seats); `farField.stats().failed === 0`.
 *  I3-b/c/d add: every placement has a drawn instance (bbox within its footprint ± 0.3 m), no
 *  `ops-*-glb` entry in Node, vehicles y ≥ standY − 0.05, figures = figuresAt().length, the
 *  pit cell's visible Σtris ≤ 1.2 M (high), `--glb` prototype tris ≤ 1.4 k.
 *  I3-c `checkPitEquipment` (its own block at the end): the four `ops-pitEquipment /
 *  ops-perches / ops-cones / ops-cables` sets exist, `userData.ops` holds every
 *  `pitEquipmentPlacements()` row by id and kind, every near-level instance's world bbox (IM
 *  instances included) lies in the working area, the walkway band or the garage interior,
 *  nothing lower than 1.0 m is inside any of the 12 stopped-car rectangles (the wheel guns
 *  hang over the car), nothing taller than chaseLens.maxH stands in a lens column and nothing
 *  at all in a lens → car path, the gantry tops never reach left of the lane band's edge, the
 *  cable ramps sit ≥ 8 mm over the apron; `--glb` (the stub registry with the pit / props /
 *  trackside drops) builds the high tier once more: every `*-glb` near level has a procedural
 *  far level in its cell, its prototype ≤ 2.9 m tall and ≤ 6 k triangles.
 *  I3-d `checkPeople` (ops-people.ts ← ops-spec section D): the five `ops-figures-<role>` sets
 *  exist and draw exactly `figuresAt().length` impostor instances (= stats.ops.figures, by
 *  role), every figure's drawn origin is `figureToWorld`'s point (matched within 5 cm) and its
 *  height over `ground.standY` sits in its mount's band (ground mounts −0.05 … 0.3 m, the
 *  perch / platform 'wall' rows 0.4 … 2.6 m, the podium 'roof' rows 4.5 … 5.5 m, the marshal
 *  posts' 'platform' rows 1.9 … 2.4 m — I4-a),
 *  `stats.ops.mode` is 'procedural' in Node, no figure stands in a stopped-car rectangle, a
 *  lens → car path, an ops footprint, a paddock building or beside a parked paddock car, the
 *  eight `ops-flags` poles stand on the ground; `--glb` loads the crowd's posed GLBs too and
 *  checks every 3D figure prototype (bare and helmeted) ≤ 1.4 k triangles.
 *
 *   node scripts/audit/ops-smoke.mjs [--tier high|low|both] [--glb]
 *
 * `--glb` builds the high tier once more with the pack's ops / vehicle GLBs behind a stub
 * registry (stub-registry.mjs, like furniture-smoke --glb) and runs the I3-b GLB facts
 * (`checkVehicles`: the 3D prototypes' triangles, the pit cell's visible Σtris) and the I3-c GLB
 * facts (`checkPitEquipment`: prototype heights / triangles).
 * Exit 1 on any failure.
 */
import { buildScene, THREE } from './app-runtime.mjs'
import { commonChecks, fmt, infieldRoots, smokeArgs, trisOf } from './smoke-common.mjs'
import { buildSceneWith, stubRegistry } from './stub-registry.mjs'

const { tiers, check, finish, glb } = smokeArgs('ops-smoke')

const ops = await import('../../app/data/ops-spec.ts')
const spec = await import('../../app/data/suzuka-facilities-spec.ts')

const tally = (rows) => {
  const out = {}
  for (const r of rows) out[r.kind] = (out[r.kind] ?? 0) + 1
  return out
}
const sameTally = (a, b) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) if ((a[k] ?? 0) !== (b[k] ?? 0)) return false
  return true
}
const fmtTally = (t) => Object.entries(t).map(([k, v]) => `${k} ${v}`).join(', ') || 'empty'

// --- the data (tier-independent) ------------------------------------------------------------------
{
  console.log('\nops-smoke: ops-spec')
  const placements = ops.opsPlacements()
  const ids = new Set(placements.map((p) => p.id))
  check(ids.size === placements.length, `opsPlacements(): ${placements.length} rows, ids unique (${fmtTally(tally(placements))})`)
  const E = spec.PIT_ENVELOPE
  const rects = Array.from({ length: spec.PIT_GARAGE_COUNT }, (_, g) => ops.stoppedCarRect(g))
  const inWork = rects.every((r) => ops.inWorkArea((r.lat[0] + r.lat[1]) / 2, r.lat[1] - r.lat[0]))
  check(rects.length === spec.PIT_GARAGE_COUNT && inWork, `stoppedCarRect: ${rects.length} rectangles, lateral ${rects[0].lat.map((v) => v.toFixed(2)).join('…')} (stop ${E.stop} ± ${(E.carHalf + E.carBox.margin).toFixed(2)}) inside the working area [${E.workArea.join(', ')}]`)
  const cols = ops.lensColumns()
  check(cols.length === spec.PIT_GARAGE_COUNT && cols.every((c) => c.lens.lateral === E.stop && c.lens.y === E.chaseLens.up), `lensColumns: ${cols.length} columns at stop ${E.stop}, +${E.chaseLens.up} m`)
  let crews = 0, seats = 0
  for (let g = 0; g < spec.PIT_GARAGE_COUNT; g++) { crews += ops.crewSlots(g).length; seats += ops.perchSeats(g).length }
  check(crews === spec.GARAGE_ORDER.length * ops.OPS_LAYOUT.crew.length && seats === spec.GARAGE_ORDER.length * ops.OPS_LAYOUT.pitWallPerch.seatsDS.length, `crewSlots: ${crews} crew (${spec.GARAGE_ORDER.length} teams × ${ops.OPS_LAYOUT.crew.length}), perchSeats: ${seats}; the empty bay has none`)
  check(ops.OPS_TEXTS.length === 10 + spec.GARAGE_ORDER.length && ops.OPS_TEXTS.every((t) => /^[A-Z0-9 ]+$/.test(t)), `OPS_TEXTS: ${ops.OPS_TEXTS.length} words, upper-case descriptive only`)
  const crew0 = ops.crewSlots(0)
  check(ops.OPS_LAYOUT.scPocket.lat === E.stop - 0.8 && ops.OPS_LAYOUT.garageFront.lat === spec.PIT_PLANNED.shutter + 1.3 && crew0.every((f, i) => Math.abs(f.lateral - (E.stop + ops.OPS_LAYOUT.crew[i].dLat)) < 1e-9), `OPS_LAYOUT / crewSlots derive from PIT_ENVELOPE.stop ${E.stop} (scPocket ${ops.OPS_LAYOUT.scPocket.lat}) and the shutter ${spec.PIT_PLANNED.shutter} (garageFront ${ops.OPS_LAYOUT.garageFront.lat})`)
}

for (const tier of tiers) {
  console.log(`\nops-smoke: tier ${tier}`)
  const t0 = performance.now()
  const scene = await buildScene({ tier })
  console.log(`  built + drained in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
  const { env } = scene
  const { stats: ff } = await commonChecks(scene, check, { buildKeys: ['ops'] })
  // --- I3-a facts: the umbrella lap, the stats shape, userData.ops = opsPlacements() -------------------
  check(ff.failed === 0, `farField.stats().failed === 0 (${ff.failed})`)
  check('ops' in (env.buildMs ?? {}) && Number.isFinite(env.buildMs.ops), `buildMs.ops lapped by the umbrella (${Number(env.buildMs?.ops).toFixed(1)} ms)`)
  const s = env.stats?.ops
  const KEYS = ['figures', 'byRole', 'impostors', 'near3d', 'mode', 'vehicles', 'equipment']
  check(s && KEYS.every((k) => k in s) && Object.keys(s).length === KEYS.length, `env.stats.ops has exactly { ${KEYS.join(', ')} } (${s ? Object.keys(s).join(', ') : 'absent'})`)
  if (s) {
    // every figure has an impostor level; the 3D near level (high tier + the pack's baked atlas) is added on top, so near3d is 0 or figures
    check(s.impostors === s.figures && s.near3d === 0, `stats.ops: impostors ${s.impostors} === figures ${s.figures}, near3d ${s.near3d} === 0 (Node has no baked atlas)`)
    check(['baked', 'procedural', 'none'].includes(s.mode) && s.mode !== 'baked', `stats.ops.mode '${s.mode}' (Node: procedural or none, never baked)`)
    const byRole = Object.values(s.byRole ?? {}).reduce((a, b) => a + b, 0)
    check(byRole === s.figures, `stats.ops.byRole sums to figures (${byRole} = ${s.figures})`)
    check(Number.isFinite(s.vehicles) && Number.isFinite(s.equipment) && s.vehicles >= 0 && s.equipment >= 0, `stats.ops.vehicles ${s.vehicles}, equipment ${s.equipment}`)
  }
  const placed = env.group.userData.ops
  const expected = tally(ops.opsPlacements())
  check(Array.isArray(placed) && sameTally(tally(placed), expected), `env.group.userData.ops kinds (${fmtTally(tally(placed ?? []))}) = opsPlacements() kinds (${fmtTally(expected)})`)
  check(Array.isArray(placed) && placed.length === ops.opsPlacements().length, `every placement pushed into ctx.ops (${placed?.length} of ${ops.opsPlacements().length})`)
  console.log(`  note far-field entries of kind 'ops': ${ff.byKind?.ops ?? 0}`)
  checkVehicles(scene, tier, { glb: false })
  checkPitEquipment(scene, check, { glb: false })
  await checkPeople(scene, check, { glb: false, reg: null })
}

// ===== I3-b: checkVehicles (ops-vehicles.ts) ======================================================
/**
 * The vehicles / hospitality / tents / containers / compound facts (plan §I3-b):
 *  - every row of `vehiclePlacements()` is in `ctx.ops` (counts per kind agree);
 *  - every L0 instance of the ops-vehicles / -hospitality / -tents / -containers / -compound sets
 *    stands inside exactly one placement's footprint (the (s, lateral) rectangle in the world,
 *    what the guard and paddock.ts read) and its geometry's world bbox (xz) stays inside the
 *    box the placement describes in its centre's frame, grown by 0.3 m — the sizes in ops-spec
 *    are what is drawn. A rigid box is straight; inside a bend the (s, lateral) rectangle is
 *    not (the E paddock lies inside the pit-entry bend: 10 m of s at lateral −88 is a 7.7 m
 *    chord), so the thin rows the builder draws from world end to end (the fence, the cable
 *    ramp) are held to the (s, lateral) quad and everything else to the frame box;
 *  - every vehicle instance's y ≥ ground.standY − 0.05 (nothing sunk); every rigid L0 instance
 *    standing on the ground (not a row drawn end to end, not a stacked / mounted row with `y`)
 *    has the ground the builder reads (`ground.standAt`, road-relative — the road's own grade
 *    along a long box is not a placement fault) under its four bbox corners within 0.3 m of
 *    its origin — a long box placed on the relief slope (the I2 ground climbs 3.9 m across the
 *    B lot's outer ring and 3.2 m across the E lot's) would bury its high side or float its
 *    low one (the I3-b marquees and the compound's second container row did, by 3.1–3.4 m);
 *  - no instance in a chase-lens column (top > maxH) or in a lens → car path (`lensColumns()`);
 *  - no paddock car (infield-paddock-cars L0) inside an ops footprint (paddock.ts drops those
 *    bays), no street lamp inside one (a note);
 *  - Node without the pack: every set has two levels (the procedural L0 + the empty one), no
 *    mesh named `-glb-`;
 *  - `--glb` (high tier, the stub registry): the GLB level draws the drops (mesh names `-glb-`),
 *    every 3D vehicle prototype ≤ 12 k triangles, the pit cells' visible ops Σtris ≤ 1.2 M.
 */
function checkVehicles(scene, tier, { glb: withGlb }) {
  const { env, track, ground } = scene
  console.log(`\nops-smoke: I3-b vehicles (tier ${tier}${withGlb ? ' + GLB' : ''})`)
  const rows = ops.vehiclePlacements()
  const placed = env.group.userData.ops ?? []
  const placedIds = new Set(placed.map((p) => p.id))
  check(rows.every((r) => placedIds.has(r.id)) && sameTally(tally(rows), tally(placed.filter((p) => rows.some((r) => r.id === p.id)))), `vehiclePlacements(): ${rows.length} rows all in ctx.ops (${fmtTally(tally(rows))})`)
  const vehicleKinds = new Set(['vehicle', 'truck', 'crane'])
  check(env.stats.ops.vehicles === rows.filter((r) => vehicleKinds.has(r.kind)).length && env.stats.ops.equipment >= rows.length - env.stats.ops.vehicles, `stats.ops.vehicles ${env.stats.ops.vehicles} = the vehicle / truck / crane rows, equipment ${env.stats.ops.equipment} ≥ the rest (${rows.length - env.stats.ops.vehicles})`)
  // --- the footprints in world xz, grown by 0.3 m ------------------------------------------------------
  const v3 = new THREE.Vector3()
  const world = (s, l) => { track.pointAt(track.wrap(s), l, v3, 0); return [v3.x, v3.z] }
  const GROW = 0.3
  const grownOf = (r) => ({ ...r, size: [r.size[0] + 2 * GROW, r.size[1] + 2 * GROW, r.size[2]] })
  /** the straight box of a placement in its centre's frame (what a rigid prototype is drawn in), grown */
  const frameBox = (r) => {
    const g = grownOf(r)
    const h = track.headingAt(track.wrap(r.s))
    const [cx, cz] = world(r.s, r.lateral)
    const yaw = (r.yawDeg * Math.PI) / 180
    // local: u along the long side, v across; the frame's +s = (h.tx, h.tz), +lateral = (h.tz, −h.tx)
    return [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([su, sv]) => {
      const u = (su * g.size[0]) / 2, v = (sv * g.size[1]) / 2
      const ds = u * Math.cos(yaw) - v * Math.sin(yaw), dl = u * Math.sin(yaw) + v * Math.cos(yaw)
      return [cx + ds * h.tx + dl * h.tz, cz + ds * h.tz - dl * h.tx]
    })
  }
  const drawnEndToEnd = (r) => r.kind === 'barrier' || r.id === 'bc-cable-ramp'
  const quads = rows.map((r) => ({ r, q: ops.placementCorners(grownOf(r)).map(([s, l]) => world(s, l)), box: drawnEndToEnd(r) ? null : frameBox(r) }))
  const inQuad = (x, z, q) => {
    let inside = false
    for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
      const a = q[i], b = q[j]
      if ((a[1] > z) !== (b[1] > z) && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside
    }
    return inside
  }
  const SETS = /^ops-(vehicles|hospitality|tents|containers|compound)-/
  const roots = infieldRoots(env, SETS)
  const l0 = []
  for (const o of roots) if (/-L0-\d+$/.test(o.name)) o.traverse((m) => { if (m.isInstancedMesh) l0.push(m) })
  const m4 = new THREE.Matrix4(), c = new THREE.Vector3()
  let instances = 0, unmatched = 0, outside = 0, sunk = 0, inColumn = 0, inPath = 0, buried = 0, floating = 0
  const worst = []
  const SPREAD = 0.3
  let maxSpread = 0, maxSpreadId = ''
  const columns = ops.lensColumns()
  const E = spec.PIT_ENVELOPE
  const inArc = (s, [a, b]) => ops.forwardS(a, s) <= ops.forwardS(a, b)
  const seen = new Set()
  for (const m of l0) {
    m.updateWorldMatrix(true, false)
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox()
    const bb = m.geometry.boundingBox
    for (let i = 0; i < m.count; i++) {
      instances++
      m.getMatrixAt(i, m4)
      m4.premultiply(m.matrixWorld)
      c.setFromMatrixPosition(m4)
      // the placement: the footprint the instance's origin stands in; where footprints meet (a fence
      // corner, a stack) the one that holds the most of the instance's bbox, then the nearest level
      const cands = quads.filter(({ q }) => inQuad(c.x, c.z, q))
      if (!cands.length) { unmatched++; if (worst.length < 4) worst.push(`${m.name}[${i}] at (${c.x.toFixed(1)}, ${c.z.toFixed(1)}) in no footprint`); continue }
      // the geometry's world bbox (8 corners) must stay inside the grown box (the frame box, or the (s, lateral) quad for a row drawn end to end)
      const corners = []
      for (const x of [bb.min.x, bb.max.x]) for (const y of [bb.min.y, bb.max.y]) for (const z of [bb.min.z, bb.max.z]) { v3.set(x, y, z).applyMatrix4(m4); corners.push([v3.x, v3.z]) }
      const gy = ground.standY(c.x, c.z)
      const scored = cands.map((k) => ({ k, out: corners.filter(([x, z]) => !inQuad(x, z, k.box ?? k.q)).length, dy: Math.abs((k.r.y ?? 0) - (c.y - gy)) }))
      scored.sort((a, b) => a.out - b.out || a.dy - b.dy)
      const { r } = scored[0].k
      const out = scored[0].out
      seen.add(r.id)
      if (out) { outside++; if (worst.length < 4) worst.push(`${m.name}[${i}] (${r.id}): ${out} of 8 bbox corners outside the footprint + ${GROW} m`) }
      if (vehicleKinds.has(r.kind) && c.y < ground.standY(c.x, c.z) - 0.05) { sunk++; if (worst.length < 4) worst.push(`${r.id}: y ${c.y.toFixed(2)} < standY ${ground.standY(c.x, c.z).toFixed(2)} − 0.05`) }
      // a rigid box on the ground: the ground the builder reads (ground.standAt, in the road frame — the road's
      // own grade along a long box is not a placement fault) under its four bbox corners against its origin
      if (scored[0].k.box && !(r.y > 0)) {
        const at = (x, z) => { const n = track.nearestOnRange(x, z, track.wrap(r.s - 30), track.wrap(r.s + 30)); return { n, y: track.pointAt(n.s, n.lateral, v3, 0).y } }
        const o = at(c.x, c.z)
        const yRel = c.y - o.y
        let lo = Infinity, hi = -Infinity
        for (const x of [bb.min.x, bb.max.x]) for (const z of [bb.min.z, bb.max.z]) { v3.set(x, bb.min.y, z).applyMatrix4(m4); const { n } = at(v3.x, v3.z); const g = ground.standAt(n.s, n.lateral); lo = Math.min(lo, g); hi = Math.max(hi, g) }
        if (hi - lo > maxSpread) { maxSpread = hi - lo; maxSpreadId = r.id }
        if (hi - yRel > SPREAD) { buried++; if (worst.length < 4) worst.push(`${r.id}: the ground under a corner is ${(hi - yRel).toFixed(2)} m above the origin (buried > ${SPREAD})`) }
        if (yRel - lo > SPREAD) { floating++; if (worst.length < 4) worst.push(`${r.id}: the ground under a corner is ${(yRel - lo).toFixed(2)} m below the origin (floating > ${SPREAD})`) }
      }
      // the chase-lens columns and paths (track frame, the pit strip window)
      const near = track.nearestOnRange(c.x, c.z, 5540, 130)
      if (near.d < 40) {
        const top = (r.y ?? 0) + r.size[2]
        for (const col of columns) {
          if (top > E.chaseLens.maxH && inArc(near.s, col.column.s) && near.lateral >= col.column.lat[0] && near.lateral <= col.column.lat[1]) inColumn++
          if (inArc(near.s, col.path.s) && near.lateral >= col.path.lat[0] && near.lateral <= col.path.lat[1]) inPath++
        }
      }
    }
  }
  check(instances > 0 && unmatched === 0, `${fmt(instances)} L0 instances in ${l0.length} InstancedMeshes, every one inside a placement footprint (${unmatched} unmatched)`)
  check(outside === 0, `every instance's geometry bbox inside its footprint ± ${GROW} m (${outside} outside)`)
  const missing = rows.filter((r) => !seen.has(r.id))
  check(missing.length === 0, `every placement has a drawn instance (${missing.length} without${missing.length ? `: ${missing.slice(0, 5).map((r) => r.id).join(', ')}` : ''})`)
  check(sunk === 0, `every vehicle y ≥ standY − 0.05 (${sunk} sunk)`)
  check(buried === 0 && floating === 0, `every rigid instance on the ground has the ground under its 4 corners within ${SPREAD} m of its origin (${buried} buried, ${floating} floating; max spread ${maxSpread.toFixed(2)} m at ${maxSpreadId})`)
  check(inColumn === 0 && inPath === 0, `nothing in the 12 chase-lens columns (${inColumn}) or lens → car paths (${inPath})`)
  for (const w of worst) console.log(`    ${w}`)
  // --- the paddock cars and lamps stay off the ops footprints ------------------------------------------
  const carPts = []
  for (const o of infieldRoots(env, /^infield-paddock-cars-/)) o.traverse((m) => { if (m.isInstancedMesh && /-L0-/.test(m.name)) { m.updateWorldMatrix(true, false); for (let i = 0; i < m.count; i++) { m.getMatrixAt(i, m4); m4.premultiply(m.matrixWorld); c.setFromMatrixPosition(m4); carPts.push([c.x, c.z]) } } })
  const carsIn = carPts.filter(([x, z]) => quads.some(({ q }) => inQuad(x, z, q))).length
  check(carPts.length > 0 && carsIn === 0, `no paddock car inside an ops footprint (${carsIn} of ${carPts.length})`)
  const lampPts = []
  for (const o of infieldRoots(env, /^infield-lamps-/)) o.traverse((m) => { if (m.isInstancedMesh && /-L0-/.test(m.name)) { m.updateWorldMatrix(true, false); for (let i = 0; i < m.count; i++) { m.getMatrixAt(i, m4); m4.premultiply(m.matrixWorld); c.setFromMatrixPosition(m4); lampPts.push([c.x, c.z]) } } })
  const lampsIn = lampPts.filter(([x, z]) => quads.some(({ q }) => inQuad(x, z, q))).length
  console.log(`  note street lamps inside an ops footprint: ${lampsIn} of ${lampPts.length}`)
  // --- the levels: procedural only without the pack, the drops at L0 with it ---------------------------
  const levelsOf = new Map()
  for (const o of roots) { const mm = o.name.match(/^(ops-[a-z]+)-L(\d)-(\d+)$/); if (mm) { const k = `${mm[1]}-${mm[3]}`; levelsOf.set(k, Math.max(levelsOf.get(k) ?? 0, Number(mm[2]) + 1)) } }
  const glbMeshes = l0.filter((m) => /-glb-/.test(m.name))
  if (!withGlb) {
    check(levelsOf.size > 0 && [...levelsOf.values()].every((n) => n === 2) && glbMeshes.length === 0, `Node without the pack: ${levelsOf.size} ops entries of 2 levels (procedural L0 + empty), no -glb- mesh (${glbMeshes.length})`)
  } else {
    const glbProtos = [...new Set(glbMeshes.map((m) => m.name.replace(/-L0-\d+$/, '').replace(/^ops-[a-z]+-/, '')))]
    check(glbMeshes.length > 0 && [...levelsOf.entries()].filter(([k]) => k.startsWith('ops-vehicles')).every(([, n]) => n === 3), `the GLB level draws the drops at L0 (${glbProtos.join(', ')}); ops-vehicles entries have 3 levels`)
    const vehicleGlb = glbMeshes.filter((m) => m.name.startsWith('ops-vehicles-'))
    const big = vehicleGlb.map((m) => [m.name.replace(/-L0-\d+$/, ''), trisOf(m) / m.count]).filter(([, t]) => t > 12000)
    check(vehicleGlb.length > 0 && big.length === 0, `every 3D vehicle prototype ≤ 12 k triangles (${big.map(([n, t]) => `${n} ${fmt(Math.round(t))}`).join(', ') || `max ${fmt(Math.round(Math.max(0, ...vehicleGlb.map((m) => trisOf(m) / m.count))))}`})`)
    // the pit cells: the cells of the garage row's two ends and the paddock behind it
    const cells = new Set()
    for (const [s, l] of [[5640, -40], [5700, -60], [5760, -60], [30, -60], [80, -40], [160, -35]]) { const [x, z] = world(s, l); cells.add(env.farField.cellOf(x, z)) }
    let pitTris = 0
    for (const o of infieldRoots(env, /^ops-/)) {
      const mm = o.name.match(/-L0-(\d+)$/)
      if (!mm || !cells.has(Number(mm[1]))) continue
      o.traverse((m) => { if (m.isMesh || m.isInstancedMesh) pitTris += trisOf(m) })
    }
    check(pitTris <= 1_200_000, `pit cells (${[...cells].join(', ')}) visible ops Σtris at L0 ${fmt(pitTris)} ≤ 1,200,000`)
  }
}

// --- --glb: the ops GLB path on the high tier behind the stub registry ------------------------------------
if (glb) {
  console.log('\nops-smoke: tier high + ops GLBs (stub registry)')
  const reg = await stubRegistry(/^model\/(ops\/|vehicles\/van_h100|props\/modular_fire_escape|pit\/(impact_wrench|trolley_jack|pc_monitors|pit_board)|props\/(korean_fire_extinguisher_01|security_camera_01)|trackside\/cone_pack|crowd\/eclair\/)/)
  console.log(`  loaded ${reg.loaded.length} models`)
  const t0 = performance.now()
  const scene = await buildSceneWith('high', reg)
  console.log(`  built + drained in ${((performance.now() - t0) / 1000).toFixed(1)} s (loaded: ${reg.loaded.join(', ')})`)
  const ff = scene.env.farField.stats()
  check(ff.failed === 0, `farField.stats().failed === 0 (${ff.failed})`)
  checkVehicles(scene, 'high', { glb: true })
  checkPitEquipment(scene, check, { glb: true })
  await checkPeople(scene, check, { glb: true, reg })
}

// ===== I3-d: checkPeople (ops-people.ts ← ops-spec section D) =========================================
/**
 * The people's facts: the sets, the instance count against `figuresAt()`, every drawn origin
 * against the row's world point and its mount's height band, the envelopes and footprints
 * (the guard's O1 / O3 / O9 restated on the DRAWN positions), the flags; `--glb` measures the
 * 3D prototypes the high tier would instance with the pack.
 */
async function checkPeople(scene, check, { glb, reg }) {
  const { env, track, ground } = scene
  const people = await import('../../app/three/ops-people.ts')
  console.log(`  people${glb ? ' (GLB prototypes)' : ''}`)
  const trackside = await import('../../app/three/trackside.ts')
  const rows = ops.figuresAt({ lineAt: (s, side) => trackside.barrierLateralAt(track, s, side) })
  const s = env.stats.ops
  const byRole = {}
  for (const r of rows) byRole[r.role] = (byRole[r.role] ?? 0) + 1
  check(s.figures === rows.length && Object.keys(byRole).every((k) => s.byRole[k] === byRole[k]), `stats.ops.figures ${s.figures} = figuresAt() ${rows.length} (${Object.entries(byRole).map(([k, v]) => `${k} ${v}`).join(', ')})`)
  check(s.mode === 'procedural', `stats.ops.mode 'procedural' in Node (${s.mode})`)
  // --- the sets and their impostor instances --------------------------------------------------------
  const SETS = ['ops-figures-crew', 'ops-figures-officials', 'ops-figures-marshals', 'ops-figures-photographers', 'ops-figures-staff']
  const meshesOf = (name) => {
    const out = []
    const re = new RegExp(`^${name}-L\\d+-\\d+$`)
    for (const o of env.farField.group.children) if (re.test(o.name ?? '')) { if (o.isInstancedMesh) out.push(o); o.traverse((m) => { if (m.isInstancedMesh && m !== o) out.push(m) }) }
    return out
  }
  const bySet = new Map(SETS.map((n) => [n, meshesOf(n)]))
  check(SETS.every((n) => bySet.get(n).length > 0), `sets registered: ${SETS.map((n) => `${n.replace('ops-figures-', '')} ${bySet.get(n).length} IM`).join(', ')}`)
  const imps = SETS.flatMap((n) => bySet.get(n)).filter((m) => !/-3d-/.test(m.name))
  const instances = imps.reduce((a, m) => a + m.count, 0)
  check(instances === rows.length, `${instances} impostor instances = ${rows.length} rows (no 3D level without the pack: ${SETS.flatMap((n) => bySet.get(n)).filter((m) => /-3d-/.test(m.name)).length} 3D meshes)`)
  // --- every row's drawn origin: the world point, the height band of its mount ------------------------
  const m4 = new THREE.Matrix4(), v = new THREE.Vector3()
  const drawn = []
  for (const m of imps) {
    m.updateWorldMatrix(true, false)
    const cellAttr = m.geometry.getAttribute('aCell')
    for (let i = 0; i < m.count; i++) { m.getMatrixAt(i, m4); m4.premultiply(m.matrixWorld); v.setFromMatrixPosition(m4); drawn.push([v.x, v.y, v.z, cellAttr ? cellAttr.getX(i) : null, cellAttr ? cellAttr.getY(i) : null]) }
  }
  // the procedural impostor's atlas cell (textures.ts marshalAtlas: 4 × 4, drawn top → bottom, flipY = true, so
  // canvas row r lives at v = (3 − r) / 4): marshals row 0, the official cell 4, the crews cells 5 + TEAMS order
  const { TEAMS } = await import('../../app/data/drivers.ts')
  const teamOrder = Object.keys(TEAMS)
  const expectedCell = (r) => (r.role === 'marshal' ? null : r.role === 'crew' && r.team ? 5 + teamOrder.indexOf(r.team) : 4)
  let wrongCell = 0, cellsChecked = 0
  // 'platform' (I4-a): the marshal on a post's stand deck, platform 2.0 + floor 0.12 over the ground
  const BANDS = { wall: [0.4, 2.6], roof: [4.5, 5.5], platform: [1.9, 2.4], ground: [-0.05, 0.3] }
  let unmatched = 0, offBand = 0
  const worst = []
  const E = spec.PIT_ENVELOPE
  const carRects = Array.from({ length: spec.PIT_GARAGE_COUNT }, (_, g) => ops.stoppedCarRect(g))
  const columns = ops.lensColumns()
  const inArc = (x, [a, b]) => ops.forwardS(a, x) <= ops.forwardS(a, b)
  const within = (x, [a, b]) => x >= Math.min(a, b) && x <= Math.max(a, b)
  let inCar = 0, inPath = 0
  const footprints = ops.opsPlacements().filter((p) => p.mount !== 'roof' && !(p.kind === 'cabin' && p.mount === 'wall')).map((p) => ({ p, q: ops.placementCorners(p) }))
  /** point in a footprint's (s, lateral) quad, in the frame of its first corner (signed s deltas, so a wrapping row compares in one frame) */
  const inQuad = (sx, l, q) => {
    const s0 = q[0][0]
    const signed = (a, b) => { const d = ops.forwardS(a, b); return d > track.length / 2 ? d - track.length : d }
    const pts = q.map(([cs, cl]) => [signed(s0, cs), cl])
    const d = signed(s0, sx)
    let inside = false
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i], b = pts[j]
      if ((a[1] > l) !== (b[1] > l) && d < ((b[0] - a[0]) * (l - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside
    }
    return inside
  }
  let inFootprint = 0
  for (const r of rows) {
    const w = people.figureToWorld({ track, ground }, r)
    let best = null, bd = Infinity
    for (const d of drawn) { const dd = Math.hypot(d[0] - w.x, d[2] - w.z); if (dd < bd) { bd = dd; best = d } }
    if (!best || bd > 0.05) { unmatched++; if (worst.length < 4) worst.push(`${r.role} at (s ${r.s.toFixed(1)}, ${r.lateral.toFixed(1)}): no drawn instance within 5 cm (nearest ${bd.toFixed(2)} m)`); continue }
    if (best[3] !== null) {
      cellsChecked++
      const cell = expectedCell(r)
      const ok = cell === null ? Math.abs(best[4] - 0.75) < 1e-6 : Math.abs(best[3] - (cell % 4) / 4) < 1e-6 && Math.abs(best[4] - (3 - Math.floor(cell / 4)) / 4) < 1e-6
      if (!ok) { wrongCell++; if (worst.length < 4) worst.push(`${r.role}${r.team ? ' ' + r.team : ''} at (s ${r.s.toFixed(1)}, ${r.lateral.toFixed(1)}): aCell (${best[3]}, ${best[4]}) is not atlas cell ${cell ?? '0…3'}`) }
    }
    const band = BANDS[r.mount === 'wall' ? 'wall' : r.mount === 'roof' ? 'roof' : r.mount === 'platform' ? 'platform' : 'ground']
    const dy = best[1] - 0.02 - ground.standY(w.x, w.z)
    if (dy < band[0] || dy > band[1]) { offBand++; if (worst.length < 4) worst.push(`${r.role} (${r.mount}) at (s ${r.s.toFixed(1)}, ${r.lateral.toFixed(1)}): ${dy.toFixed(2)} m over standY, band ${band.join('…')}`) }
    for (const c of carRects) if (inArc(r.s, c.s) && within(r.lateral, c.lat)) inCar++
    for (const c of columns) if (inArc(r.s, c.path.s) && within(r.lateral, c.path.lat)) inPath++
    for (const { p, q } of footprints) if (Math.abs(p.lateral - r.lateral) < 20 && inQuad(r.s, r.lateral, q)) { inFootprint++; if (worst.length < 4) worst.push(`${r.role} at (s ${r.s.toFixed(1)}, ${r.lateral.toFixed(1)}) inside ops ${p.id}`) }
  }
  check(unmatched === 0, `every figuresAt() row has a drawn instance at figureToWorld's point (${unmatched} unmatched)`)
  check(cellsChecked === rows.length && wrongCell === 0, `every procedural impostor samples its role's marshalAtlas cell — marshals row 0 (v 0.75), officials / staff / photographers cell 4, crews 5 + team (${wrongCell} wrong of ${cellsChecked})`)
  check(offBand === 0, `every figure's height over standY in its mount's band (ground ${BANDS.ground.join('…')}, wall ${BANDS.wall.join('…')}, roof ${BANDS.roof.join('…')}; ${offBand} off)`)
  check(inCar === 0 && inPath === 0, `no figure in a stopped-car rectangle (${inCar}) or a lens → car path (${inPath})`)
  check(inFootprint === 0, `no figure inside an ops footprint (${inFootprint})`)
  // --- the paddock cars: nobody stands in one (the car's local box ± 0.2 m) ------------------------------
  const cars = []
  for (const o of infieldRoots(env, /^infield-paddock-cars-/)) o.traverse((m) => { if (m.isInstancedMesh && /-L0-/.test(m.name)) { m.updateWorldMatrix(true, false); for (let i = 0; i < m.count; i++) { m.getMatrixAt(i, m4); m4.premultiply(m.matrixWorld); cars.push(m4.clone().invert()) } } })
  let inCars = 0
  const lp = new THREE.Vector3()
  for (const d of drawn) for (const inv of cars) { lp.set(d[0], d[1], d[2]).applyMatrix4(inv); if (Math.abs(lp.x) < 1.1 && Math.abs(lp.z) < 2.6 && Math.abs(lp.y) < 2.5 && (Math.abs(lp.x) < 1.1 && Math.abs(lp.z) < 1.1 || Math.max(Math.abs(lp.x), Math.abs(lp.z)) < 2.6 && Math.min(Math.abs(lp.x), Math.abs(lp.z)) < 1.1)) { inCars++; break } }
  check(cars.length > 0 && inCars === 0, `no figure inside a parked paddock car (${inCars} of ${drawn.length} vs ${cars.length} cars)`)
  for (const w of worst) console.log(`    ${w}`)
  // --- the flags ---------------------------------------------------------------------------------------------
  const flagMeshes = meshesOf('ops-flags')
  const flagInst = flagMeshes.filter((m) => /-L0-/.test(m.name)).reduce((a, m) => a + m.count, 0)
  const flagRows = ops.flagPlacements()
  let flagSunk = 0
  for (const m of flagMeshes.filter((m) => /-L0-/.test(m.name))) { m.updateWorldMatrix(true, false); for (let i = 0; i < m.count; i++) { m.getMatrixAt(i, m4); m4.premultiply(m.matrixWorld); v.setFromMatrixPosition(m4); if (Math.abs(v.y - ground.standY(v.x, v.z)) > 0.05) flagSunk++ } }
  check(flagInst === flagRows.length && flagRows.length === 8 && flagSunk === 0, `ops-flags: ${flagInst} poles drawn for ${flagRows.length} rows, all standing on the ground (${flagSunk} off)`)
  // --- the 3D prototypes the pack would instance ---------------------------------------------------------
  if (glb && reg) {
    const fig = await import('../../app/three/figures.ts')
    const ids = fig.FIGURE_POSES.map((p) => fig.OPS_FIGURES[p].id)
    const bare = fig.figurePrototypes(reg, ids, false), helmet = fig.figurePrototypes(reg, ids, true)
    const tris = (g) => Math.floor((g.index ? g.index.count : g.getAttribute('position').count) / 3)
    // the helmeted prototypes that get instanced: the poses the helmet roles (marshal / crew) use
    const helmetPoses = new Set(rows.filter((r) => r.role === 'marshal' || r.role === 'crew').map((r) => r.pose ?? 'stand'))
    const big = []
    let maxT = 0
    if (bare && helmet) fig.FIGURE_POSES.forEach((p, i) => {
      for (const [k, g] of [['bare', bare[i]], ['helmet', helmet[i]]]) {
        if (k === 'helmet' && !helmetPoses.has(p)) continue
        maxT = Math.max(maxT, tris(g))
        if (tris(g) > 1400) big.push(`${p} ${k} ${fmt(tris(g))}`)
      }
    })
    check(!!bare && !!helmet && big.length === 0, `3D figure prototypes: ${ids.length} bare + ${helmetPoses.size} helmeted (${[...helmetPoses].join(', ')}), every instanced one ≤ 1,400 triangles (max ${fmt(maxT)}${big.length ? `; over: ${big.join(', ')}` : ''})`)
  }
}

finish()

// ===== I3-c: checkPitEquipment ======================================================================

/**
 * The pit-lane equipment's facts (I3-c, ops-pit.ts ← ops-spec section C): the sets, the rows,
 * every drawn instance's world bbox against the envelopes the guard checks on paper, the
 * cable ramps' lift, and with `glb` the pack prototypes.
 */
function checkPitEquipment(scene, check, { glb }) {
  const { env, track, ground } = scene
  const E = spec.PIT_ENVELOPE
  const L = track.length
  const fwd = (a, b) => ((b - a) % L + L) % L
  const within = (v, [a, b]) => v >= Math.min(a, b) && v <= Math.max(a, b)
  const rows = ops.pitEquipmentPlacements()
  const ids = new Set(rows.map((r) => r.id))
  console.log(`  pit equipment${glb ? ' (GLB near levels)' : ''}`)
  // --- the rows in userData.ops -----------------------------------------------------------------
  const placed = (env.group.userData.ops ?? []).filter((p) => ids.has(p.id))
  check(placed.length === rows.length && sameTally(tally(placed), tally(rows)), `userData.ops holds every pitEquipmentPlacements() row (${placed.length} of ${rows.length}: ${fmtTally(tally(rows))})`)
  const perches = rows.filter((r) => r.kind === 'cabin')
  const onDeck = perches.filter((r) => Math.abs(r.y - spec.PIT_WALL.platform.y) < 1e-9)
  check(perches.length === spec.GARAGE_ORDER.length && rows.filter((r) => r.kind === 'board').length === perches.length, `${perches.length} perches (one per team) + ${rows.filter((r) => r.kind === 'board').length} pit boards; ${onDeck.length} on the fixed platform's deck (${onDeck.map((r) => `s ${r.s.toFixed(1)}`).join(', ')})`)
  // --- the sets -------------------------------------------------------------------------------------
  const SETS = ['ops-pitEquipment', 'ops-perches', 'ops-cones', 'ops-cables']
  const meshesOf = (name) => {
    const out = []
    const re = new RegExp(`^${name}-L\\d+-\\d+$`)
    for (const o of env.farField.group.children) if (re.test(o.name ?? '')) o.traverse((m) => { if (m.isInstancedMesh) out.push(m) })
    return out
  }
  const bySet = new Map(SETS.map((n) => [n, meshesOf(n)]))
  check(SETS.every((n) => bySet.get(n).length > 0), `sets registered: ${SETS.map((n) => `${n} ${bySet.get(n).length} IM`).join(', ')}`)
  const allMeshes = SETS.flatMap((n) => bySet.get(n))
  const L0 = allMeshes.filter((m) => /-L0-\d+$/.test(m.name))
  const glbMeshes = allMeshes.filter((m) => /-glb-L\d+-/.test(m.name))
  if (!glb) check(glbMeshes.length === 0, `no *-glb prototype without the pack (${glbMeshes.length})`)
  const instances = L0.reduce((a, m) => a + m.count, 0)
  const tris = L0.reduce((a, m) => a + trisOf(m), 0)
  check(instances >= rows.length, `near level: ${fmt(instances)} instances ≥ ${rows.length} rows, ${fmt(tris)} triangles`)
  // --- every instance's world bbox against the envelopes ---------------------------------------------
  const carRects = Array.from({ length: spec.PIT_GARAGE_COUNT }, (_, g) => ops.stoppedCarRect(g))
  const columns = ops.lensColumns()
  // the walkway band ends at the pit wall's walkway face (PIT_WALL.walkway.from −9.75, + 2 cm of world-bbox
  // rounding: the perch frames stand flush against it), not its lane face −9.05 — a board or monitor leaning
  // through the wall body would otherwise pass; only what rises over the wall top (the perch canopies and
  // umbrellas, top > PIT_WALL.wallTop) may overhang to the lane face
  const WALL_BAND = [-12.0, spec.PIT_WALL.walkway.from + 0.02]
  const WALL_TOP_BAND = [-12.0, spec.PIT_WALL.lateral + spec.PIT_WALL.wallWidth / 2]
  const INTERIOR = [spec.PIT_BUILDING.back + 5.1, E.workArea[0] - 0.7]
  const v = new THREE.Vector3(), road = new THREE.Vector3(), m4 = new THREE.Matrix4()
  let n = 0, outOfBand = 0, inCar = 0, inColumn = 0, inPath = 0, beamLeft = 0, rampLow = 0, ramps = 0
  const offenders = []
  const note = (what, name) => { if (offenders.length < 8) offenders.push(`${name} (${what})`) }
  for (const m of L0) {
    m.updateWorldMatrix(true, false)
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox()
    const bb = m.geometry.boundingBox
    const isRamp = /-cable-ramp-/.test(m.name), isGantryTop = /-gantry-top-/.test(m.name)
    for (let i = 0; i < m.count; i++) {
      m.getMatrixAt(i, m4)
      m4.premultiply(m.matrixWorld)
      let d0 = Infinity, d1 = -Infinity, l0 = Infinity, l1 = -Infinity, y0 = Infinity, y1 = -Infinity, ref = null
      for (const cx of [bb.min.x, bb.max.x]) for (const cy of [bb.min.y, bb.max.y]) for (const cz of [bb.min.z, bb.max.z]) {
        v.set(cx, cy, cz).applyMatrix4(m4)
        const hit = track.nearestOnRange(v.x, v.z, 5530, 135)
        if (ref === null) ref = track.wrap(hit.s)
        const d = fwd(ref, hit.s)
        const ds = d > L / 2 ? d - L : d
        d0 = Math.min(d0, ds); d1 = Math.max(d1, ds); l0 = Math.min(l0, hit.lateral); l1 = Math.max(l1, hit.lateral)
        track.pointAt(hit.s, hit.lateral, road, 0)
        y0 = Math.min(y0, v.y - road.y); y1 = Math.max(y1, v.y - road.y)
      }
      n++
      const sA = track.wrap(ref + d0), sB = track.wrap(ref + d1)
      const name = `${m.name}[${i}]`
      const wallBand = y1 > spec.PIT_WALL.wallTop ? WALL_TOP_BAND : WALL_BAND
      const band = within(l0, E.workArea) && within(l1, E.workArea) ? 'apron' : within(l0, wallBand) && within(l1, wallBand) ? 'wall' : within(l0, INTERIOR) && within(l1, INTERIOR) ? 'interior' : null
      if (!band) { outOfBand++; note(`lateral ${l0.toFixed(2)}…${l1.toFixed(2)} in no band`, name) }
      /** does the bbox (s sA→sB, lateral l0…l1) overlap the zone (forward arc zs, lateral zl)? */
      const overlaps = (zs, zl) => {
        const len = fwd(zs[0], zs[1])
        const a = fwd(zs[0], sA), b = fwd(zs[0], sB)
        const sOverlap = a <= len || b <= len || a > b
        return sOverlap && l1 >= Math.min(zl[0], zl[1]) && l0 <= Math.max(zl[0], zl[1])
      }
      if (band === 'apron' && y0 < 1.0) for (const r of carRects) if (overlaps(r.s, r.lat)) { inCar++; note(`in the stopped car of block ${r.block + 1}, bottom ${y0.toFixed(2)}`, name); break }
      for (const c of columns) {
        if (y1 > c.column.maxH && overlaps(c.column.s, c.column.lat)) { inColumn++; note(`${y1.toFixed(2)} m tall in the lens column of block ${c.block + 1}`, name); break }
        if (overlaps(c.path.s, c.path.lat)) { inPath++; note(`in the lens → car path of block ${c.block + 1} (lateral ${l0.toFixed(2)}…${l1.toFixed(2)}, s ${sA.toFixed(1)}→${sB.toFixed(1)})`, name); break }
      }
      // the spec's own limit is the analytic keep-out edge (KEEP_OUT_EDGE −21.1), 2 m short of the lane band's edge
      if (isGantryTop && l1 > ops.KEEP_OUT_EDGE) { beamLeft++; note(`gantry top reaches ${l1.toFixed(2)} (keep-out edge ${ops.KEEP_OUT_EDGE.toFixed(1)})`, name) }
      if (isRamp) {
        ramps++
        v.setFromMatrixPosition(m4)
        // the instance origin is the ramp's base: its lift over the drawn ground there
        const lift = v.y - ground.standY(v.x, v.z)
        if (lift < 0.008 - 1e-6) { rampLow++; note(`cable ramp ${(1000 * lift).toFixed(1)} mm over the apron`, name) }
      }
    }
  }
  check(outOfBand === 0, `${fmt(n)} instance bboxes: every one inside the working area [${E.workArea.join(', ')}], the walkway band [${WALL_BAND.map((x) => x.toFixed(2)).join(', ')}] (to the wall's lane face ${WALL_TOP_BAND[1].toFixed(2)} above the wall top ${spec.PIT_WALL.wallTop}) or the garage interior (${outOfBand} outside${outOfBand ? `: ${offenders.filter((o) => o.includes('band')).slice(0, 3).join('; ')}` : ''})`)
  check(inCar === 0, `nothing lower than 1.0 m inside any of the ${carRects.length} stopped-car rectangles (${inCar}${inCar ? `: ${offenders.filter((o) => o.includes('stopped car')).slice(0, 3).join('; ')}` : ''})`)
  check(inColumn === 0 && inPath === 0, `chase lens: nothing taller than ${E.chaseLens.maxH} m in a lens column (${inColumn}), nothing in a lens → car path (${inPath})${inColumn + inPath ? `: ${offenders.filter((o) => o.includes('lens')).slice(0, 3).join('; ')}` : ''}`)
  check(beamLeft === 0, `gantry tops never reach left of the pit keep-out edge ${ops.KEEP_OUT_EDGE.toFixed(1)} (${beamLeft})`)
  check(ramps > 0 && rampLow === 0, `${ramps} cable ramp segments ≥ 8 mm over the apron (${rampLow} low)`)
  // --- the pack prototypes ----------------------------------------------------------------------------
  if (glb) {
    const near = allMeshes.filter((m) => /-glb-L0-/.test(m.name))
    const protoOf = (m) => m.name.replace(/-L\d+-\d+$/, '')
    const protos = [...new Set(near.map(protoOf))]
    check(protos.length >= 5, `GLB near levels: ${protos.length} prototypes (${protos.map((p) => p.replace(/^ops-\w+-/, '')).join(', ')})`)
    let tall = 0, heavy = 0, noFar = 0
    const facts = []
    for (const m of near) {
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox()
      const h = m.geometry.boundingBox.max.y - m.geometry.boundingBox.min.y
      const t = trisOf({ geometry: m.geometry, isInstancedMesh: false })
      if (h > E.chaseLens.maxH) tall++
      if (t > 6000) heavy++
      const cell = m.name.match(/-(\d+)$/)[1]
      const setName = m.name.match(/^(ops-\w+)-/)[1]
      // the same set and cell must hold a procedural prototype at level 1 (the far level)
      const far = allMeshes.filter((o) => o.name.startsWith(`${setName}-`) && o.name.endsWith(`-L1-${cell}`) && !/-glb-/.test(o.name))
      if (!far.length) noFar++
      if (!facts.some((f) => f.startsWith(protoOf(m).replace(/^ops-\w+-/, '')))) facts.push(`${protoOf(m).replace(/^ops-\w+-/, '')} ${h.toFixed(2)} m / ${fmt(t)} tris`)
    }
    check(tall === 0 && heavy === 0, `every GLB prototype ≤ ${E.chaseLens.maxH} m tall (${tall} taller) and ≤ 6 k triangles (${heavy} heavier): ${facts.join(', ')}`)
    check(noFar === 0, `every GLB near level has a procedural far level in its cell (${noFar} without)`)
  }
}
