#!/usr/bin/env node
/**
 * Roadside-furniture smoke (R フェーズ Phase 3, dev-only — not part of `pnpm check`): builds the
 * scene on both tiers through app-runtime.mjs (no asset pack → the procedural plates / heads),
 * drains the far field and checks what road-furniture.ts and the outskirts' utility poles built:
 *
 *  - every block entry `roadFurniture-b<n>` exists with at least one mesh, and the stats on
 *    `farField.group.userData.roadFurniture` show rails (> 5 km of beam on the high tier), posts,
 *    delineators, mirrors, 止まれ signs and transformer cans; signals only when the network has a
 *    signalled junction with tertiary+ approaches inside the terrain grid (none in the current
 *    extract — the settlements' lights are outside the grid, the gate junctions are service-road
 *    splits — so that assertion is conditional and the run says so);
 *  - a sample of 2,000 furniture vertices: finite, ≥ ROADS.minD − 1 from the GP centreline
 *    (`ground.plan.project`), never more than 1.2 m under `ground.standY` at their xz (things
 *    stand on the ground: a floating or buried element would be a frame / height bug);
 *  - the W-beam never sits inside a road's asphalt: every rail vertex is at least hw + offset −
 *    depth − 0.05 from the nearest non-bridge road's centreline (road-section.ts `nearestRoad`;
 *    a bridge on another layer passes over the rail);
 *  - the utility poles are still there (`utilityPoles-<cell>` InstancedMeshes) and no
 *    `guardrail-*` mesh comes from a `utility-*` group any more (the rails moved).
 *
 *   node scripts/audit/furniture-smoke.mjs [--tier high|low|both] [--sample 2000] [--glb] [--fake-signal]
 *
 * `--glb` builds the high tier once more with the imported GLBs of the manifest (jp_traffic_assets,
 * jp_denchu, utility_box_02) behind a stub asset registry (scripts/audit/stub-registry.mjs) — the geometry through GLTFLoader +
 * meshopt, every texture an empty stand-in — and checks the pack path: the plates / head / poles
 * come from the pack (`packUsed`), the `utilityHero-*` entries exist with the procedural poles'
 * instance counts, and the same vertex rules hold. `--fake-signal` builds the high tier once
 * more with a fake circuit gate pushed onto SUR_SITES next to an in-grid tertiary+ junction (the
 * network's gate rule then flags it `signal`), so the signal path — poles, arms, heads, lenses,
 * cabinets — runs and is measured: lit lenses 4.5–6 m over the ground, over a carriageway.
 *
 * Exit 1 on any failure.
 */
import path from 'node:path'
import { buildScene, ROOT, THREE } from './app-runtime.mjs'
import { buildSceneWith, stubRegistry } from './stub-registry.mjs'

const args = process.argv.slice(2)
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d }
const tierArg = flag('--tier', 'both')
const SAMPLE = Number(flag('--sample', '2000'))
const tiers = tierArg === 'both' ? ['high', 'low'] : [tierArg]
const withGlb = args.includes('--glb')
const withFakeSignal = args.includes('--fake-signal')

const spec = await import(path.join(ROOT, 'app/data/surroundings-spec.ts'))
const rs = await import(path.join(ROOT, 'app/three/road-section.ts'))
const { ROADS, ROAD_FURNITURE } = spec

let failures = 0
const check = (ok, msg) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failures++ }
const fmt = (n) => n.toLocaleString('en-US')

/** the smoke's own deterministic sampler (mulberry32) */
const rng = (seed) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }

/** the manifest's road / props GLBs behind the stub registry (scripts/audit/stub-registry.mjs) */
const FURNITURE_KEYS = ['model/road/jp_traffic_assets', 'model/road/jp_denchu', 'model/props/utility_box_02']

const runs = tiers.map((tier) => ({ label: `tier ${tier}`, tier, reg: null, fake: false }))
if (withGlb) runs.push({ label: 'tier high + GLB pack (stub registry)', tier: 'high', reg: await stubRegistry(FURNITURE_KEYS), fake: false })
if (withFakeSignal) runs.push({ label: 'tier high + fake gate signal', tier: 'high', reg: null, fake: true })
/** the junction the fake gate is put on: the first run's network decides, the fake run's network flags it */
let fakeJunction = null

for (const { label, tier, reg, fake } of runs) {
  console.log(`\nfurniture-smoke: ${label}`)
  if (fake) {
    if (!fakeJunction) { console.log('  FAIL no in-grid tertiary+ junction found by an earlier run'); failures++; continue }
    const sur = await import(path.join(ROOT, 'app/data/suzuka-surroundings.ts'))
    const gate = sur.SUR_SITES.find((g) => g.role === 'gate')
    sur.SUR_SITES.push({ ...gate, id: 999999999, centroid: fakeJunction.en, name: 'smoke: fake gate' })
    console.log(`  fake gate at world (${fakeJunction.x.toFixed(0)}, ${fakeJunction.z.toFixed(0)}): ${fakeJunction.ways}`)
  }
  const t0 = performance.now()
  const scene = reg ? await buildSceneWith(tier, reg) : await buildScene({ tier })
  const { env, ground, terrain, quality } = scene
  const ff = env.farField
  console.log(`  built + drained in ${((performance.now() - t0) / 1000).toFixed(1)} s; farField failed jobs: ${ff.stats().failed}`)
  check(ff.stats().failed === 0, 'no deferred job failed')

  // --- entries and stats --------------------------------------------------------------------------
  const stats = ff.group.userData.roadFurniture
  check(!!stats, 'farField.group.userData.roadFurniture is set')
  if (!stats) continue
  const groups = ff.group.children.filter((o) => /^roadFurniture-b\d+$/.test(o.name))
  const meshes = []
  for (const g of groups) g.traverse((o) => { if (o.isMesh) meshes.push(o) })
  console.log(`  ${groups.length} block groups, ${meshes.length} meshes; stats ${JSON.stringify({ ...stats, guardrailM: Math.round(stats.guardrailM) })}`)
  check(groups.length > 0 && groups.every((g) => g.children.some((c) => c.isMesh)), `roadFurniture-b* groups exist and each holds a mesh (${groups.length})`)
  check(groups.length === stats.blocks || groups.length <= stats.blocks, `block count ${groups.length} ≤ planned ${stats.blocks}`)
  check(ff.stats().byKind.furniture === groups.length, `every block group is registered as kind 'furniture' (${ff.stats().byKind.furniture ?? 0})`)
  if (reg) {
    check(stats.packUsed, `the pack furnished the plates / heads (loaded: ${reg.loaded.join(', ')})`)
    const packMeshes = meshes.filter((m) => /-pack\d+$/.test(m.name))
    check(packMeshes.length > 0, `pack-material meshes exist (${packMeshes.length}; materials with a map: ${packMeshes.filter((m) => !!m.material.map).length})`)
    let hero = 0, heroInst = 0, proc = 0, procInst = 0
    ff.group.traverse((o) => {
      if (o.isInstancedMesh && /^utilityHero-\d+$/.test(o.name)) { hero++; heroInst += o.count }
      if (o.isInstancedMesh && /^utilityPoles-\d+$/.test(o.name)) { proc++; procInst += o.count }
    })
    if (reg.has('model/road/jp_denchu')) check(hero === proc && heroInst === procInst && hero > 0, `utilityHero-* entries mirror the procedural poles (${hero} / ${proc} cells, ${heroInst} / ${procInst} instances)`)
  } else check(!stats.packUsed, 'no pack in Node: procedural plates and heads')
  if (tier === 'high') check(stats.guardrailM > 5000, `guardrail ${fmt(Math.round(stats.guardrailM))} m > 5 km`)
  else check(stats.guardrailM > 0, `guardrail ${fmt(Math.round(stats.guardrailM))} m > 0`)
  check(stats.posts > 0, `posts ${fmt(stats.posts)} > 0`)
  check(stats.delineators > 0, `delineators ${fmt(stats.delineators)} > 0`)
  check(stats.mirrors > 0, `mirrors ${fmt(stats.mirrors)} > 0`)
  check(stats.signs.stop > 0, `止まれ signs ${fmt(stats.signs.stop)} > 0`)
  check(stats.transformers > 0, `transformer cans ${fmt(stats.transformers)} > 0`)
  check(stats.triangles > 0 && meshes.reduce((s, m) => s + m.geometry.attributes.position.count / 3, 0) === stats.triangles, `triangles ${fmt(stats.triangles)} match the meshes`)

  // --- the network, for the signal expectation and the rail / asphalt test ------------------------
  const grid = terrain.grid()
  const inGrid = (x, z) => x >= grid.x0 && z >= grid.z0 && x < grid.x0 + grid.w && z < grid.z0 + grid.d
  const netCtx = { track: scene.track, terrain, ground, quality, landCover: env.landCover, farField: ff }
  const net = rs.roadNetwork(netCtx, { stepScale: quality.farField.roads.stepScale, ring: quality.farField.roads.ring })
  const minRank = spec.ROAD_SECTION.rank.unclassified
  const signalled = net.junctions.filter((j) => j.signal && inGrid(j.x, j.z) && j.ways.some((e) => e.way.inGrid && e.way.section.rank >= minRank))
  if (signalled.length) check(stats.signals > 0, `signals ${stats.signals} > 0 (${signalled.length} signalled junctions with unclassified+ approaches in the grid)`)
  else console.log(`  note: no signalled junction with an unclassified+ approach inside the terrain grid (${net.junctions.filter((j) => j.signal).length} signalled in the network, all outside or service-road splits) — the signal path is not exercised here; stats.signals = ${stats.signals}${withFakeSignal ? '' : ' (--fake-signal exercises it)'}`)
  if (!fakeJunction && tier === 'high') {
    // a junction well inside the grid with at least two tertiary+ ways, the most arms first
    const pad = 100
    const cands = net.junctions.filter((j) => j.x >= grid.x0 + pad && j.z >= grid.z0 + pad && j.x < grid.x0 + grid.w - pad && j.z < grid.z0 + grid.d - pad && ground.plan.project(j.x, j.z).d > 200 && j.ways.filter((e) => e.way.inGrid && e.way.section.rank >= spec.ROAD_SECTION.rank.tertiary).length >= 2)
    const j = cands.sort((a, b) => b.ways.length - a.ways.length)[0]
    if (j) fakeJunction = { x: j.x, z: j.z, en: [j.x / scene.track.enScale, -j.z / scene.track.enScale], ways: j.ways.map((e) => `${e.way.kind} ${e.end ? 'end' : 'thru'}`).join(' | ') }
  }
  if (fake) {
    check(stats.signals > 0, `signals ${stats.signals} built (${stats.planned.signals} approaches planned)`)
    // the lit lenses (green on the major's approaches, red on the minors') hang over a carriageway 4.5–6 m up
    const lit = []
    const gC = new THREE.Color(0x2ecc71), rC = new THREE.Color(0xe74c3c)
    const isCol = (c, i, ref) => Math.abs(c.getX(i) - ref.r) < 0.01 && Math.abs(c.getY(i) - ref.g) < 0.01 && Math.abs(c.getZ(i) - ref.b) < 0.01
    ff.group.traverse((o) => {
      if (!o.isMesh || !o.name.endsWith('-painted')) return
      const p = o.geometry.attributes.position, c = o.geometry.attributes.color
      for (let i = 0; i < p.count; i++) {
        if (Math.hypot(p.getX(i) - fakeJunction.x, p.getZ(i) - fakeJunction.z) > 40) continue
        if (isCol(c, i, gC) || isCol(c, i, rC)) lit.push({ x: p.getX(i), h: p.getY(i) - ground.standY(p.getX(i), p.getZ(i)), z: p.getZ(i) })
      }
    })
    const hs = lit.map((v) => v.h)
    check(lit.length > 0 && Math.min(...hs) > 4.5 && Math.max(...hs) < 6, `lit lenses hang 4.5–6 m over the ground (${lit.length} vertices, ${lit.length ? `${Math.min(...hs).toFixed(2)}–${Math.max(...hs).toFixed(2)} m` : '-'})`)
    let over = 0
    for (const v of lit) { const nr = rs.nearestRoad(net, v.x, v.z, 20); if (nr && nr.d < nr.way.hw) over++ }
    check(lit.length > 0 && over / lit.length > 0.8, `lit lenses hang over a carriageway (${over} of ${lit.length} vertices inside a paved width)`)
  }

  // --- vertex sample: finite, outside minD − 1, on the ground ---------------------------------------
  const rand = rng(1234)
  const perMesh = meshes.map((m) => ({ m, n: m.geometry.attributes.position.count }))
  const totalV = perMesh.reduce((s, e) => s + e.n, 0)
  let bad = { finite: 0, minD: 0, buried: 0 }, worstBelow = 0, worstD = Infinity, sampled = 0
  const v = { x: 0, y: 0, z: 0 }
  for (let k = 0; k < SAMPLE && totalV > 0; k++) {
    let pick = Math.floor(rand() * totalV)
    let e = perMesh[0]
    for (const c of perMesh) { if (pick < c.n) { e = c; break } pick -= c.n }
    const p = e.m.geometry.attributes.position
    v.x = p.getX(pick); v.y = p.getY(pick); v.z = p.getZ(pick)
    sampled++
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) { bad.finite++; continue }
    const d = ground.plan.project(v.x, v.z).d
    if (d < worstD) worstD = d
    if (d < ROADS.minD - 1) bad.minD++
    const below = ground.standY(v.x, v.z) - v.y
    if (below > worstBelow) worstBelow = below
    if (below > 1.2) bad.buried++
  }
  check(bad.finite === 0, `${sampled} sampled vertices finite (${bad.finite} not)`)
  check(bad.minD === 0, `sampled vertices ≥ ${ROADS.minD - 1} m from the centreline (${bad.minD} inside; nearest ${worstD.toFixed(1)} m)`)
  check(bad.buried === 0, `no sampled vertex more than 1.2 m under standY (${bad.buried} buried; deepest ${worstBelow.toFixed(2)} m)`)

  // --- the W-beam stays out of the asphalt --------------------------------------------------------
  const G = ROAD_FURNITURE.guardrail
  const railMeshes = meshes.filter((m) => m.name.endsWith('-rail'))
  let railV = 0, railInside = 0, worstIn = Infinity
  for (const m of railMeshes) {
    const p = m.geometry.attributes.position
    const step = Math.max(1, Math.floor(p.count / (SAMPLE / Math.max(1, railMeshes.length))))
    for (let i = 0; i < p.count; i += step) {
      railV++
      const near = rs.nearestRoad(net, p.getX(i), p.getZ(i), 12)
      // a bridge on another layer passes over the rail (the 中勢バイパス overpasses); the test is planar
      if (!near || near.way.bridge) continue
      const limit = near.way.hw + G.offset - G.depth - 0.05
      if (near.d < limit) { railInside++; if (near.d - near.way.hw < worstIn) worstIn = near.d - near.way.hw }
    }
  }
  check(railInside === 0, `${railV} rail vertices outside the paved edge + ${(G.offset - G.depth - 0.05).toFixed(2)} m (${railInside} inside${railInside ? `, worst ${worstIn.toFixed(2)} m from the edge` : ''})`)

  // --- the outskirts side: poles stay, rails gone --------------------------------------------------
  let poleInst = 0, oldRails = 0, wires = 0
  ff.group.traverse((o) => {
    if (o.isInstancedMesh && /^utilityPoles-\d+$/.test(o.name)) poleInst++
    if (o.isMesh && /^guardrail-/.test(o.name)) { for (let p = o.parent; p; p = p.parent) if (/^utility-/.test(p.name)) oldRails++ }
    if (o.isMesh && /^wires-\d+$/.test(o.name)) wires++
  })
  check(poleInst > 0, `utilityPoles-* InstancedMeshes still exist (${poleInst})`)
  check(oldRails === 0, `no guardrail-* mesh under a utility-* group (${oldRails})`)
  check(wires > 0, `wires-* meshes exist (${wires})`)
  const anyWire = ff.group.children.find((o) => /^wires-\d+$/.test(o.name))
  if (anyWire) check(anyWire.userData.outskirts.strips === anyWire.userData.outskirts.spans * 6, `six wires per span (${anyWire.name}: ${anyWire.userData.outskirts.strips} strips / ${anyWire.userData.outskirts.spans} spans)`)
}

console.log(`\nfurniture-smoke: ${failures} failure(s)`)
if (failures) process.exit(1)
