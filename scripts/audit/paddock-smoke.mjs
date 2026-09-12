#!/usr/bin/env node
/**
 * Paddock smoke (I2 — the paddock behind the pit building; dev-only — not part of `pnpm check`):
 * builds the scene on both tiers through app-runtime.mjs (no asset pack → the procedural
 * fallbacks), drains the far field and checks the common I-phase facts (smoke-common.mjs): no
 * deferred job failed, every `ops-*` / `infield-*` / `paddock-*` object has finite vertices and
 * stands inside the circuit ring 775428456, `buildMs.paddock` finite once the builder reports.
 * The phase's own facts are added below as it lands.
 *
 *   node scripts/audit/paddock-smoke.mjs [--tier high|low|both] [--glb]
 *
 * `--glb` is reserved for the phase's GLB path (stub-registry.mjs, like furniture-smoke --glb).
 * Exit 1 on any failure.
 */
import { buildScene } from './app-runtime.mjs'
import { commonChecks, smokeArgs } from './smoke-common.mjs'

const { tiers, check, finish, glb } = smokeArgs('paddock-smoke')
if (glb) console.log('--glb: no GLB path in this smoke yet (the phase adds it)')

for (const tier of tiers) {
  console.log(`\npaddock-smoke: tier ${tier}`)
  const t0 = performance.now()
  const scene = await buildScene({ tier })
  console.log(`  built + drained in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
  const { roots } = await commonChecks(scene, check, { buildKeys: ['paddock'], rootPrefix: /^(ops|infield|paddock)-/ })
  void roots
  // --- I2 facts (paddock.ts publishes them on env.group.userData.paddock) ----------------------------
  // TODO(I2): the team-office row (PADDOCK_BUILDINGS), the centre house 184430907, the paddock
  // plane rows (GROUND_AREAS 'paddock'), the bay lines (LAYER.paddock.line decals), the parked
  // vehicles count vs Quality.infield.paddockCars, the chain-link fence runs.
}

finish()
