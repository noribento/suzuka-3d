#!/usr/bin/env node
/**
 * Infield smoke (I5 / I6 — the infield grounds, ponds, facilities, trees, cuttings and tunnels;
 * dev-only — not part of `pnpm check`): builds the scene on both tiers through app-runtime.mjs
 * (no asset pack → the procedural fallbacks), drains the far field and checks the common
 * I-phase facts (smoke-common.mjs): no deferred job failed, every `ops-*` / `infield-*` object
 * has finite vertices and stands inside the circuit ring 775428456, `buildMs.infield` finite
 * once the builder reports. The phase's own facts are added below as it lands.
 *
 *   node scripts/audit/infield-smoke.mjs [--tier high|low|both] [--glb]
 *
 * `--glb` is reserved for the phase's GLB path (stub-registry.mjs, like furniture-smoke --glb).
 * Exit 1 on any failure.
 */
import { buildScene } from './app-runtime.mjs'
import { commonChecks, smokeArgs } from './smoke-common.mjs'

const { tiers, check, finish, glb } = smokeArgs('infield-smoke')
if (glb) console.log('--glb: no GLB path in this smoke yet (the phase adds it)')

for (const tier of tiers) {
  console.log(`\ninfield-smoke: tier ${tier}`)
  const t0 = performance.now()
  const scene = await buildScene({ tier })
  console.log(`  built + drained in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
  const { roots } = await commonChecks(scene, check, { buildKeys: ['infield'] })
  void roots
  // --- I5 / I6 facts (infield-ground.ts / cuttings.ts publish env.stats.infield) -----------------------
  // TODO(I5): env.stats.infield counts per facility kind; the pond rows are GROUND_AREAS 'water';
  // the island kerbs are GROUND_OBJECTS 'islandKerb'; INFIELD_TREES stand ≥ hw + 6 from the road.
  // TODO(I6): the CUT corridors lower the field between their walls; FOOTBRIDGES span the road.
}

finish()
