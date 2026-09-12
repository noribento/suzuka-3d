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
 * `--glb` is reserved for the phase's GLB path (stub-registry.mjs, like furniture-smoke --glb).
 * Exit 1 on any failure.
 */
import { buildScene } from './app-runtime.mjs'
import { commonChecks, smokeArgs } from './smoke-common.mjs'

const { tiers, check, finish, glb } = smokeArgs('ops-smoke')
if (glb) console.log('--glb: no GLB path in this smoke yet (I3-b adds it)')

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
  console.log(`  note far-field entries of kind 'ops': ${ff.byKind?.ops ?? 0} (the pit building's ops-garage / ops-terrace until I3-b/c/d register theirs)`)
}

finish()
