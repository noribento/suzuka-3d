#!/usr/bin/env node
/**
 * Trackside smoke (I4 — the marshal posts v2, the TV towers, the fences and signs; dev-only —
 * not part of `pnpm check`): builds the scene on both tiers through app-runtime.mjs (no asset
 * pack → the procedural fallbacks), drains the far field and checks the common I-phase facts
 * (smoke-common.mjs): no deferred job failed, every `ops-*` / `infield-*` / `trackside-*` object
 * has finite vertices and stands inside the circuit ring 775428456, `buildMs.trackside` finite
 * once the builder reports. The phase's own facts are added below as it lands.
 *
 *   node scripts/audit/trackside-smoke.mjs [--tier high|low|both] [--glb]
 *
 * `--glb` is reserved for the phase's GLB path (stub-registry.mjs, like furniture-smoke --glb).
 * Exit 1 on any failure.
 */
import { buildScene } from './app-runtime.mjs'
import { commonChecks, smokeArgs } from './smoke-common.mjs'

const { tiers, check, finish, glb } = smokeArgs('trackside-smoke')
if (glb) console.log('--glb: no GLB path in this smoke yet (the phase adds it)')

for (const tier of tiers) {
  console.log(`\ntrackside-smoke: tier ${tier}`)
  const t0 = performance.now()
  const scene = await buildScene({ tier })
  console.log(`  built + drained in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
  const { roots } = await commonChecks(scene, check, { buildKeys: ['trackside'], rootPrefix: /^(ops|infield|trackside)-/ })
  void roots
  // --- I4 facts (marshal-posts.ts / tv-towers.ts publish env.stats.trackside) ---------------------------
  // TODO(I4): env.stats.trackside = { posts, cabins, lows, panels, towers, slots }; one tower per
  // TV_CAMERAS lens row, the lens point clear of the platform; every post number drawn once.
}

finish()
