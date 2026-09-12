#!/usr/bin/env node
/**
 * Pit smoke (I1 — the pit building v2 and the pit lane; dev-only — not part of `pnpm check`):
 * builds the scene on both tiers through app-runtime.mjs (no asset pack → the procedural
 * fallbacks), drains the far field and checks the common I-phase facts (smoke-common.mjs): no
 * deferred job failed, every `ops-*` / `infield-*` / `pit-*` object has finite vertices and
 * stands inside the circuit ring 775428456, `buildMs.pit / pitLane` finite once the builder
 * reports. The phase's own facts are added below as it lands.
 *
 *   node scripts/audit/pit-smoke.mjs [--tier high|low|both] [--glb]
 *
 * `--glb` is reserved for the phase's GLB path (stub-registry.mjs, like furniture-smoke --glb).
 * Exit 1 on any failure.
 */
import { buildScene } from './app-runtime.mjs'
import { commonChecks, smokeArgs } from './smoke-common.mjs'

const { tiers, check, finish, glb } = smokeArgs('pit-smoke')
if (glb) console.log('--glb: no GLB path in this smoke yet (the phase adds it)')

for (const tier of tiers) {
  console.log(`\npit-smoke: tier ${tier}`)
  const t0 = performance.now()
  const scene = await buildScene({ tier })
  console.log(`  built + drained in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
  const { roots } = await commonChecks(scene, check, { buildKeys: ['pit', 'pitLane'], rootPrefix: /^(ops|infield|pit)-/ })
  void roots
  // --- I1 facts (pit-building.ts / pit-lane.ts publish them on their roots' userData) ---------------
  // TODO(I1): the garage blocks (12, GARAGE_CENTRES), the 2F / 3F decks and the canopy, the lane
  // cross-section bands (LAYER.pit.band decals), the box lines from PIT_ENVELOPE.stop, the
  // shutter leaves; every decal markDecal-tagged, every sponge a GROUND_OBJECTS 'sponge'.
}

finish()
