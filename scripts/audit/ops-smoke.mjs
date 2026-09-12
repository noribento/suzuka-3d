#!/usr/bin/env node
/**
 * Ops smoke (I3 — the static operations layer; dev-only — not part of `pnpm check`): builds the
 * scene on both tiers through app-runtime.mjs (no asset pack → the procedural fallbacks), drains
 * the far field and checks the common I-phase facts (smoke-common.mjs): no deferred job failed,
 * every `ops-*` / `infield-*` object has finite vertices and stands inside the circuit ring
 * 775428456, `buildMs.ops` finite once the builder reports. The phase's own facts are added
 * below as it lands.
 *
 *   node scripts/audit/ops-smoke.mjs [--tier high|low|both] [--glb]
 *
 * `--glb` is reserved for the phase's GLB path (stub-registry.mjs, like furniture-smoke --glb).
 * Exit 1 on any failure.
 */
import { buildScene } from './app-runtime.mjs'
import { commonChecks, smokeArgs } from './smoke-common.mjs'

const { tiers, check, finish, glb } = smokeArgs('ops-smoke')
if (glb) console.log('--glb: no GLB path in this smoke yet (the phase adds it)')

for (const tier of tiers) {
  console.log(`\nops-smoke: tier ${tier}`)
  const t0 = performance.now()
  const scene = await buildScene({ tier })
  console.log(`  built + drained in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
  const { roots } = await commonChecks(scene, check, { buildKeys: ['ops'] })
  void roots
  // --- I3 facts (ops.ts publishes env.stats.ops and env.group.userData.ops) ----------------------------
  // TODO(I3): env.stats.ops = { figures, byRole, impostors, near3d, mode, vehicles, equipment };
  // every placement of opsPlacements() has a drawn instance; the crew of every block stands in
  // PIT_ENVELOPE.workArea outside the car rectangle; no hero GLB in Node (assets null).
}

finish()
