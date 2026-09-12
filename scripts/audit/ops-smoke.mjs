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
 *
 *   node scripts/audit/ops-smoke.mjs [--tier high|low|both] [--glb]
 *
 * `--glb` builds the high tier once more with the pack's ops / vehicle GLBs behind a stub
 * registry (stub-registry.mjs, like furniture-smoke --glb) and runs the I3-b GLB facts
 * (`checkVehicles`: the 3D prototypes' triangles, the pit cell's visible Σtris).
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
    check(s.impostors + s.near3d === s.figures, `stats.ops: impostors ${s.impostors} + near3d ${s.near3d} === figures ${s.figures}`)
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
 *  - every vehicle instance's y ≥ ground.standY − 0.05 (nothing sunk);
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
  let instances = 0, unmatched = 0, outside = 0, sunk = 0, inColumn = 0, inPath = 0
  const worst = []
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
  const reg = await stubRegistry(/^model\/(ops\/|vehicles\/van_h100|props\/modular_fire_escape)/)
  console.log(`  loaded ${reg.loaded.length} models`)
  const scene = await buildSceneWith('high', reg)
  const ff = scene.env.farField.stats()
  check(ff.failed === 0, `farField.stats().failed === 0 (${ff.failed})`)
  checkVehicles(scene, 'high', { glb: true })
}

finish()
