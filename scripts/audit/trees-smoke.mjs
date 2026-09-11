#!/usr/bin/env node
/**
 * Smoke test of the tree placement (app/three/vegetation.ts buildTrees, app/three/forest.ts
 * jobs B / C, app/three/trees.ts emitTrees) on the real scene, in plain Node through
 * app-runtime.mjs — dev-only, NOT part of `pnpm check` (it builds the whole scene, ≈ 20 s per
 * tier). Node has no asset pack, so the library is in 'cone' mode: what is checked here is the
 * placement — where the trees stand — not the prototypes. Run it after touching the placers,
 * the species table, FOREST or the keep-out producers:
 *
 *   node scripts/audit/trees-smoke.mjs [--tier high|low|both] [--samples N] [--verbose]
 *
 * Per tier it builds and drains the scene, then asserts:
 *  (1) the far field holds the trackside scatter's buckets (`trees-…`), the forest stems'
 *      (`forest-…`, InstancedMeshes next to the lids' `forest-<cell>` meshes) and the cherry
 *      rows' (`forestRows-…`); no deferred job failed; the placement counts (the jobs' userData)
 *      are reported against the previous cone build (trees 1,600 / 500, stems ≈ 5,600 / 1,650);
 *  (2) every instance matrix of those meshes is finite;
 *  (3) on a random sample of instance positions: none inside a keep-out disc / footprint of the
 *      context (`env.keepOuts` through far-lines KeepOutGrid — the road ribbons, buildings, car
 *      parks, solar farms) and none on a paved / parking / water texel of the land-cover mask;
 *  (4) the cherry rows, the hedges and the bamboo clumps were placed (count > 0 each on the
 *      tier that budgets them).
 * Exit 1 on any failure.
 */
import path from 'node:path'
import { buildScene, ROOT } from './app-runtime.mjs'

const args = process.argv.slice(2)
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d }
const tierArg = flag('--tier', 'both')
const SAMPLES = Number(flag('--samples', '3000'))
const verbose = args.includes('--verbose')
const tiers = tierArg === 'both' ? ['high', 'low'] : [tierArg]
if (tiers.some((t) => t !== 'high' && t !== 'low')) { console.error('--tier high|low|both'); process.exit(2) }

const { KeepOutGrid } = await import(path.join(ROOT, 'app/three/far-lines.ts'))

/** the cone build before the species library (scene-cost 2026-09-11, Node): instances of the scatter and the forest stems */
const BEFORE = { high: { trees: 1600, stems: 5639 }, low: { trees: 500, stems: 1657 } }
const TREELESS = new Set(['paved', 'parking', 'water'])

let failures = 0
const check = (tier, name, ok, detail) => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} [${tier}] ${name}${detail ? ` — ${detail}` : ''}`)
}
const fmt = (n) => n.toLocaleString('en-US')
/** a small deterministic generator so a failure reproduces */
const lcg = (seed) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296

for (const tier of tiers) {
  console.log(`\ntrees-smoke: tier ${tier}`)
  const t0 = performance.now()
  const scene = await buildScene({ tier })
  const { env, quality: q } = scene
  console.log(`  scene built and drained in ${((performance.now() - t0) / 1000).toFixed(1)} s; library mode '${env.trees.mode}'`)
  const stats = env.farField.stats()
  check(tier, 'no failed far-field job', stats.failed === 0, `${stats.failed} failed`)

  // --- (1) the buckets and the jobs' counts --------------------------------------------------------
  const group = env.farField.group
  const inst = { trees: [], forest: [], forestRows: [] }
  const jobs = { stems: [], rows: [], trees: null }
  for (const o of group.children) {
    const name = o.name ?? ''
    if (o.isInstancedMesh) {
      if (/^trees(-|$)/.test(name)) inst.trees.push(o)
      else if (/^forestRows(-|$)/.test(name)) inst.forestRows.push(o)
      else if (/^forest(-|$)/.test(name)) inst.forest.push(o)
    } else if (o.isGroup || o.isObject3D) {
      if (/^forestStems-/.test(name) && o.userData.stems) jobs.stems.push(o.userData.stems)
      else if (/^forestRows-/.test(name) && o.userData.rows) jobs.rows.push(o.userData.rows)
      else if (name === 'trees' && o.userData.trees) jobs.trees = o.userData.trees
    }
  }
  const instances = (list) => list.reduce((s, m) => s + m.count, 0)
  const sum = (list, k) => list.reduce((s, j) => s + (j[k] ?? 0), 0)
  check(tier, "trackside scatter buckets 'trees-*' exist", inst.trees.length > 0, `${inst.trees.length} InstancedMeshes, ${fmt(instances(inst.trees))} instances`)
  check(tier, "forest stem buckets 'forest-*' exist", inst.forest.length > 0, `${inst.forest.length} InstancedMeshes, ${fmt(instances(inst.forest))} instances`)
  check(tier, "the scatter job reported its counts", !!jobs.trees, jobs.trees ? `placed ${fmt(jobs.trees.placed)} in ${jobs.trees.tries} tries, ${jobs.trees.cells} cells, entries ${jobs.trees.entries}, cones ${jobs.trees.cones}, cards ${jobs.trees.cards}` : 'no userData.trees')
  const stemCount = sum(jobs.stems, 'count'), hedges = sum(jobs.stems, 'hedges'), bamboo = sum(jobs.stems, 'bamboo'), heroes = sum(jobs.stems, 'heroes')
  const rowsPlaced = sum(jobs.rows, 'count'), rowsCand = sum(jobs.rows, 'candidates')
  const before = BEFORE[tier]
  console.log(`    placements: scatter ${fmt(jobs.trees?.placed ?? 0)} (before ${fmt(before.trees)}), forest stems ${fmt(stemCount)} (before ${fmt(before.stems)}; heroes ${heroes}, bamboo clumps ${bamboo}), hedges ${fmt(hedges)}, cherry rows ${fmt(rowsPlaced)} of ${fmt(rowsCand)} candidates in ${jobs.rows.length} cells`)
  console.log(`    far-field entries by kind: ${JSON.stringify(stats.byKind)}; entries ${stats.entries}; merged ${stats.merged}`)
  const forestMs = Object.entries(stats.buildMs).filter(([k]) => /^(forest|trees)/.test(k))
  const jobMs = (re) => forestMs.filter(([k]) => re.test(k)).reduce((s, [, v]) => s + v, 0)
  console.log(`    'forest' buildMs: lids ${jobMs(/^forest-/).toFixed(0)} ms, stems ${jobMs(/^forestStems-/).toFixed(0)} ms, rows ${jobMs(/^forestRows-/).toFixed(0)} ms, scatter ${jobMs(/^trees$/).toFixed(0)} ms`)
  check(tier, 'the scatter placed about as many trees as before (± 5 %)', jobs.trees && Math.abs(jobs.trees.placed - before.trees) <= before.trees * 0.05, `${jobs.trees?.placed} vs ${before.trees}`)
  check(tier, 'the forest stems are within ± 25 % of before (scrub shrubs and bamboo included)', Math.abs(stemCount - before.stems) <= before.stems * 0.25, `${stemCount} vs ${before.stems}`)

  // --- (2) finite matrices ------------------------------------------------------------------------
  const all = [...inst.trees, ...inst.forest, ...inst.forestRows]
  let nInst = 0, nonFinite = 0
  const positions = []
  for (const m of all) {
    const a = m.instanceMatrix.array
    for (let i = 0; i < m.count; i++) {
      nInst++
      let ok = true
      for (let k = 0; k < 16; k++) if (!Number.isFinite(a[i * 16 + k])) ok = false
      if (!ok) nonFinite++
      else positions.push(a[i * 16 + 12], a[i * 16 + 14])
    }
  }
  check(tier, 'every instance matrix is finite', nonFinite === 0, `${fmt(nInst)} instances over ${all.length} meshes, ${nonFinite} non-finite`)

  // --- (3) keep-outs and land cover ----------------------------------------------------------------
  const keep = new KeepOutGrid()
  keep.rebuild(env.keepOuts.discs, env.keepOuts.polys)
  const rnd = lcg(0x7EE5 + (tier === 'high' ? 1 : 2))
  const n = positions.length / 2
  let inKeep = 0, onCover = 0, tested = 0
  const badKeep = [], badCover = []
  for (let k = 0; k < SAMPLES && n; k++) {
    const j = Math.floor(rnd() * n)
    const x = positions[j * 2], z = positions[j * 2 + 1]
    tested++
    if (keep.hit(x, z)) { inKeep++; if (badKeep.length < 5) badKeep.push(`${x.toFixed(1)}, ${z.toFixed(1)}`) }
    const cls = env.landCover.classAt(x, z)
    if (TREELESS.has(cls)) { onCover++; if (badCover.length < 5) badCover.push(`${x.toFixed(1)}, ${z.toFixed(1)} (${cls})`) }
  }
  check(tier, `no sampled tree inside a keep-out (${fmt(env.keepOuts.discs.length)} discs, ${fmt(env.keepOuts.polys.length)} footprints)`, inKeep === 0, `${tested} tested, ${inKeep} inside${badKeep.length ? `: ${badKeep.join('; ')}` : ''}`)
  check(tier, 'no sampled tree on a paved / parking / water texel', onCover === 0, `${tested} tested, ${onCover} on${badCover.length ? `: ${badCover.join('; ')}` : ''}`)

  // --- (4) the rows, hedges and bamboo -----------------------------------------------------------------
  check(tier, "cherry rows placed ('forestRows-*')", rowsPlaced > 0 && inst.forestRows.length > 0, `${fmt(rowsPlaced)} trees, ${inst.forestRows.length} InstancedMeshes`)
  check(tier, 'hedge shrubs placed', q.farField.trees.shrubs === 0 || hedges > 0, `${fmt(hedges)} of the tier's ${q.farField.trees.shrubs}`)
  check(tier, 'bamboo clumps placed', bamboo > 0, `${fmt(bamboo)} clumps`)
  if (verbose) {
    const byName = new Map()
    for (const m of all) { const key = m.name.replace(/-\d+$/, ''); byName.set(key, (byName.get(key) ?? 0) + m.count) }
    console.log(`    instances by bucket: ${[...byName.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`)
  }
}

console.log(`\ntrees-smoke: ${failures} failure(s)`)
process.exit(failures ? 1 : 0)
