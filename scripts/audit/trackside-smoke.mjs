#!/usr/bin/env node
/**
 * Trackside smoke (I4 — the marshal posts v2, the TV towers, the fences and signs; dev-only —
 * not part of `pnpm check`): builds the scene on both tiers through app-runtime.mjs (no asset
 * pack → the procedural fallbacks), drains the far field and checks the common I-phase facts
 * (smoke-common.mjs): no deferred job failed, every `ops-*` / `infield-*` / `trackside-*` object
 * has finite vertices and stands inside the circuit ring 775428456 (every marshal post lies
 * inside it — the ring is the sports_centre boundary, the posts are at the barrier lines),
 * `buildMs.trackside` finite once the builder reports. Then the phase's own facts:
 *
 *  I4-a `checkPosts` (marshal-posts.ts ← MARSHAL_POSTS v2): `env.stats.trackside` has the six
 *  keys { posts, cabins, lows, panels, towers, slots } with posts = MARSHAL_POSTS.length,
 *  cabins / lows / panels / slots equal to the table's (`marshalSlots` per row); the
 *  `infield-marshal-cabins` set draws one stand and one body per cabin, one box per low post
 *  and three extinguishers per cabin; every stand's floor and stair (MARSHAL_STAND's boxes
 *  through the instance matrix — the guard's rectangles, in the world) project to the
 *  spectator side of the nearest non-'fence' barrier run of its side, ≥ 0.6 m off the resolved
 *  line, and reach along s towards the row's `stair` side; the `marshalNumbers` mesh exists and `userData.trackside
 *  .numbers` lists every numbered post once, ascending with s (one wrap), 2.4 m ± 0.15 over
 *  the barrier's base; `emPanels` draws `panels` instances, none of its materials emissive
 *  (the green-flag state is DARK), every panel within one fence-post pitch of its row's
 *  `panel.s ?? s − 3.2` and its housing 0.35 … 0.75 m on the track side of the line;
 *  `cctvPoles` / `cctvHeads` draw one camera per numbered or building post plus every
 *  TRACKSIDE_CCTV row, each behind its fence line; every trackside / platform figure of
 *  `figuresAt()` stands outside the track envelope (|lateral| ≥ hw + 1.5) and the platform
 *  ones at platform + floor over the ground. `--glb` builds the high tier once more with the
 *  guard booth, the extinguisher and the camera drops behind the stub registry: the booth's
 *  near level draws (a `-glb` mesh) with a procedural far level in every cell, its prototype
 *  ≤ 3.0 m tall and ≤ 1.5 k triangles.
 *
 *   node scripts/audit/trackside-smoke.mjs [--tier high|low|both] [--glb]
 *
 *  I4-b `checkTowers` (tv-towers.ts / tv-lens.ts ← TV_CAMERAS): see its header. `--glb` builds
 *  the high tier once more with the pack's `props_security_camera_01` (the tower cameras' near
 *  level, the procedural head its far level) behind the same stub registry (stub-registry.mjs,
 *  like furniture-smoke --glb).
 *
 *  I4-c `checkBarriers` (barriers.ts ← BARRIERS v2, built here like the viewport builds it —
 *  `buildBarriers(track, quality, ground, reg)` is not part of app-runtime's scene): see its
 *  header. `--glb` adds the pack's `trackside_tire_stack` (the tyre stacks' near level).
 * Exit 1 on any failure.
 */
import { buildScene, THREE } from './app-runtime.mjs'
import { commonChecks, fmt, infieldRoots, smokeArgs, trisOf } from './smoke-common.mjs'
import { buildSceneWith, stubRegistry } from './stub-registry.mjs'

const { tiers, check, finish, glb } = smokeArgs('trackside-smoke')
const _tmp = new THREE.Vector3()

const bar = await import('../../app/data/suzuka-barriers-spec.ts')
const ops = await import('../../app/data/ops-spec.ts')
const trackside = await import('../../app/three/trackside.ts')

for (const tier of tiers) {
  console.log(`\ntrackside-smoke: tier ${tier}`)
  const t0 = performance.now()
  const scene = await buildScene({ tier })
  console.log(`  built + drained in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
  await commonChecks(scene, check, { buildKeys: ['trackside'], rootPrefix: /^(ops|infield|trackside)-/ })
  checkPosts(scene, check, { glb: false })
  await checkTowers(scene, check, { tier, glb: false })
  await checkBarriers(scene, check, { tier, glb: false, reg: null })
}

if (glb) {
  console.log('\ntrackside-smoke: tier high with the trackside drops (stub registry)')
  const reg = await stubRegistry(/^model\/(trackside\/(guard_booth|tire_stack)|props\/(korean_fire_extinguisher_01|security_camera_0[12]))$/)
  console.log(`  loaded: ${reg.loaded.join(', ') || 'nothing (no drops in the manifest)'}`)
  const scene = await buildSceneWith('high', reg)
  await commonChecks(scene, check, { buildKeys: ['trackside'], rootPrefix: /^(ops|infield|trackside)-/ })
  checkPosts(scene, check, { glb: true, reg })
  await checkTowers(scene, check, { tier: 'high', glb: true })
  await checkBarriers(scene, check, { tier: 'high', glb: true, reg })
}

// ===== I4-a: checkPosts (marshal-posts.ts) ==========================================================

/**
 * The marshal posts' facts (see the header). Every world point is projected back to the track
 * frame inside its own row's window (the lap is a figure-8), the barrier lines come from
 * trackside.ts like the builder's.
 */
function checkPosts(scene, check, { glb: withGlb, reg }) {
  const { env, track, ground } = scene
  const L = track.length
  const fwd = (a, b) => (((b - a) % L) + L) % L
  const inArc = (s, [a, b]) => fwd(a, s) <= fwd(a, b)
  console.log(`  marshal posts${withGlb ? ' (GLB prototypes)' : ''}`)
  const rows = bar.MARSHAL_POSTS
  const S = ops.MARSHAL_STAND
  const numbers = bar.marshalNumbers()
  // --- the stats ---------------------------------------------------------------------------------------
  const st = env.stats?.trackside
  const KEYS = ['posts', 'cabins', 'lows', 'panels', 'towers', 'slots']
  check(st && KEYS.every((k) => k in st) && Object.keys(st).length === KEYS.length, `env.stats.trackside has exactly { ${KEYS.join(', ')} } (${st ? Object.keys(st).join(', ') : 'absent'})`)
  if (!st) return
  const expected = {
    posts: rows.length,
    cabins: rows.filter((m) => (m.type ?? 'cabin') === 'cabin').length,
    lows: rows.filter((m) => m.type === 'low').length,
    panels: rows.filter((m) => !m.secondary).length,
    slots: rows.reduce((a, m) => a + ops.marshalSlots(m).length, 0),
  }
  for (const k of Object.keys(expected)) check(st[k] === expected[k], `stats.trackside.${k} ${st[k]} = table ${expected[k]}`)
  check(Number.isFinite(st.towers) && st.towers >= 0, `stats.trackside.towers ${st.towers} (I4-b's)`)
  // --- the barrier lines -----------------------------------------------------------------------------------
  const lines = bar.BARRIERS.map((run) => ({ run, line: trackside.resolveLineCached(track, run.source, run.sRange, run.side, run.minGap ?? 0.6) })).filter((r) => r.line.samples.length >= 2)
  const clampS = (run, s) => (inArc(s, run.sRange) ? s : fwd(s, run.sRange[0]) < fwd(run.sRange[1], s) ? run.sRange[0] : run.sRange[1])
  /** the nearest non-fence run of `side` whose window overlaps [sa, sb] (by the centre's distance), or null */
  const nearestRun = (side, sa, sb, sc, lat) => {
    let best = null, bd = Infinity
    for (const r of lines) {
      if (r.run.side !== side || r.run.kind === 'fence') continue
      if (!(inArc(r.run.sRange[0], [sa, sb]) || inArc(sa, r.run.sRange))) continue
      const d = Math.abs(lat - r.line.lat(clampS(r.run, sc)))
      if (d < bd) { bd = d; best = r }
    }
    return best
  }
  /** the run of `side` covering s whose line is nearest `lat` (fence runs included: what the builder hangs on) */
  const runAt = (s, side, lat) => {
    let best = null, bd = Infinity
    for (const r of lines) {
      if (r.run.side !== side || !inArc(s, r.run.sRange)) continue
      const d = Math.abs(lat - r.line.lat(s))
      if (d < bd) { bd = d; best = r }
    }
    return best
  }
  const v = new THREE.Vector3()
  const m4 = new THREE.Matrix4()
  const project = (x, z, s0) => track.nearestOnRange(x, z, s0 - 40, s0 + 40)
  const rowNear = (x, z) => {
    let best = null, bd = Infinity
    for (const m of rows) {
      track.pointAt(m.s, m.lateral, v, 0)
      const d = Math.hypot(v.x - x, v.z - z)
      if (d < bd) { bd = d; best = m }
    }
    return { row: best, d: bd }
  }
  // --- the cabin set: stands, bodies, lows, extinguishers --------------------------------------------------
  const setMeshes = []
  for (const o of infieldRoots(env, /^infield-marshal-cabins-/)) o.traverse((mm) => { if (mm.isInstancedMesh) setMeshes.push(mm) })
  const l0 = setMeshes.filter((mm) => /-L0-/.test(mm.name))
  const countOf = (re) => l0.filter((mm) => re.test(mm.name)).reduce((a, mm) => a + mm.count, 0)
  const nStands = countOf(/-marshal-stand-(plus|minus)-L0-/), nBodies = countOf(/-marshal-(body-(plus|minus)|booth-(plus|minus))-L0-/), nLows = countOf(/-marshal-low-L0-/), nExt = countOf(/-marshal-extinguisher(-glb)?-L0-/)
  check(nStands === expected.cabins && nBodies === expected.cabins && nLows === expected.lows && nExt === 3 * expected.cabins, `infield-marshal-cabins: ${nStands} stands + ${nBodies} bodies (${expected.cabins} cabins), ${nLows} low posts, ${nExt} extinguishers (3 per cabin) in ${setMeshes.length} InstancedMeshes`)
  // every stand's bbox: spectator side of the nearest run, ≥ 0.6 m off, reaching towards the stair side
  let standsOff = 0, stairWrong = 0, standsChecked = 0
  const worst = []
  const corner = new THREE.Vector3()
  for (const mm of l0.filter((x) => /-marshal-stand-(plus|minus)-L0-/.test(x.name))) {
    mm.updateWorldMatrix(true, false)
    const Lp = /-plus-/.test(mm.name) ? 1 : -1
    // the floor (body + deck, 0.1 m overhangs) and the stair, in the prototype's frame (MARSHAL_STAND — what the guard's rectangles are)
    const half = S.body / 2, aHalf = S.across / 2
    const boxes = [
      { x: [-aHalf, aHalf], z: [-Lp * (half + 0.1), Lp * (half + S.deckS + 0.1)] },
      { x: [-S.stairW / 2, S.stairW / 2], z: [Lp * (half + S.deckS + 0.1), Lp * (half + S.deckS + 0.1 + S.stairLen)] },
    ]
    for (let i = 0; i < mm.count; i++) {
      mm.getMatrixAt(i, m4)
      m4.premultiply(mm.matrixWorld)
      v.setFromMatrixPosition(m4)
      const { row } = rowNear(v.x, v.z)
      const side = row.lateral >= 0 ? 1 : -1
      let minSpec = Infinity, sMin = Infinity, sMax = -Infinity, sSum = 0, n = 0
      const pts = []
      for (const b of boxes) for (const x of b.x) for (const z of b.z) {
        corner.set(x, 0, z).applyMatrix4(m4)
        const p = project(corner.x, corner.z, row.s)
        const ds = fwd(row.s, p.s)
        const rel = ds > L / 2 ? ds - L : ds
        pts.push([p.s, p.lateral])
        sMin = Math.min(sMin, rel)
        sMax = Math.max(sMax, rel)
        sSum += rel
        n++
      }
      const near = nearestRun(side, track.wrap(row.s + sMin), track.wrap(row.s + sMax), row.s, row.lateral)
      if (near) for (const [ps, pl] of pts) minSpec = Math.min(minSpec, side * (pl - near.line.lat(clampS(near.run, ps))))
      standsChecked++
      if (near && minSpec < 0.6) { standsOff++; if (worst.length < 4) worst.push(`stand at s ${row.s}: ${minSpec.toFixed(2)} m off ${near.run.id}`) }
      if (Math.sign(sSum / n) !== ops.marshalStairSign(row)) { stairWrong++; if (worst.length < 4) worst.push(`stand at s ${row.s}: reaches ${(sSum / n).toFixed(2)} m along s, stair '${row.stair ?? 'aft'}'`) }
    }
  }
  check(standsChecked === expected.cabins && standsOff === 0, `every stand's floor and stair (world corners) on the spectator side of its nearest barrier run, ≥ 0.6 m off the line (${standsChecked} stands, ${standsOff} off)`)
  check(stairWrong === 0, `every stand reaches along s towards its row's stair side (${stairWrong} wrong)`)
  // --- the number boards ----------------------------------------------------------------------------------
  const td = env.group.userData.trackside ?? {}
  const boards = env.group.getObjectByName('marshalNumbers')
  const nums = td.numbers ?? []
  const uniq = new Set(nums.map((b) => b.number))
  const bySorted = [...nums].sort((a, b) => a.s - b.s)
  let descents = 0
  for (let i = 1; i < bySorted.length; i++) if (bySorted[i].number < bySorted[i - 1].number) descents++
  check(!!boards && nums.length === numbers.size && uniq.size === nums.length && descents <= 1, `marshalNumbers: ${nums.length} boards for ${numbers.size} numbered posts, numbers unique (${uniq.size}) and ascending with s (${descents} descent${descents === 1 ? ' = the wrap' : 's'})`)
  let boardOff = 0
  for (const b of nums) {
    const side = b.lateral >= 0 ? 1 : -1
    const r = runAt(b.s, side, b.lateral)
    const base = r ? Math.min(ground.standAt(b.s, r.line.lat(b.s)), 3) : ground.standAt(b.s, b.lateral)
    track.pointAt(b.s, b.lateral, v, base)
    if (Math.abs(b.y - v.y - 2.4) > 0.15) boardOff++
  }
  check(boardOff === 0, `every number board's centre 2.4 m ± 0.15 over its barrier's base (${boardOff} off)`)
  // --- the light panels: dark ------------------------------------------------------------------------------
  const panels = env.group.getObjectByName('emPanels')
  const mats = panels ? (Array.isArray(panels.material) ? panels.material : [panels.material]) : []
  const lit = mats.filter((m) => m.emissive && (m.emissiveIntensity > 0 && (m.emissive.r > 0 || m.emissive.g > 0 || m.emissive.b > 0) || m.emissiveMap))
  check(!!panels && panels.count === expected.panels && (td.panels ?? []).length === expected.panels, `emPanels: ${panels?.count ?? 0} instances = ${expected.panels} panels, userData.trackside.panels ${(td.panels ?? []).length}`)
  check(mats.length > 0 && lit.length === 0, `the light panels are DARK: ${mats.length} materials, ${lit.length} emissive (green flag — no EMISSIVE row)`)
  let panelFar = 0, panelSide = 0
  for (const p of td.panels ?? []) {
    const { row, d } = rowNear(...(() => { track.pointAt(p.s, p.lateral, v, 0); return [v.x, v.z] })())
    void d
    const want = track.wrap(row.panel?.s ?? row.s - 3.2)
    const ds = fwd(want, p.s)
    if (Math.min(ds, L - ds) > 4.01) panelFar++
    const side = row.lateral >= 0 ? 1 : -1
    const r = runAt(p.s, side, row.lateral)
    if (r) {
      const off = side * (r.line.lat(p.s) - p.lateral)
      if (off < 0.34 || off > 0.76) panelSide++
    }
  }
  check(panelFar === 0, `every panel within one fence-post pitch of its row's panel s (${panelFar} further)`)
  check(panelSide === 0, `every panel's housing 0.35 … 0.75 m on the track side of its barrier line (${panelSide} off)`)
  // --- the cameras ---------------------------------------------------------------------------------------------
  const poles = env.group.getObjectByName('cctvPoles'), heads = env.group.getObjectByName('cctvHeads')
  const wantCctv = rows.filter((m) => !m.secondary).length + bar.TRACKSIDE_CCTV.length
  check(!!poles && !!heads && poles.count === wantCctv && heads.count === wantCctv, `cctvPoles / cctvHeads: ${poles?.count ?? 0} / ${heads?.count ?? 0} = ${rows.filter((m) => !m.secondary).length} posts + ${bar.TRACKSIDE_CCTV.length} straight rows`)
  let camFront = 0
  for (const c of td.cctv ?? []) {
    const side = c.lateral >= 0 ? 1 : -1
    const r = runAt(c.s, side, c.lateral)
    if (r && side * (c.lateral - r.line.lat(c.s)) < 0.2) camFront++
  }
  check(camFront === 0, `every camera pole behind its fence line (${camFront} in front)`)
  // --- the marshals' slots ----------------------------------------------------------------------------------------
  const slots = ops.figuresAt().filter((f) => f.mount === 'trackside' || f.mount === 'platform')
  let inRoad = 0, offDeck = 0
  for (const f of slots) {
    if (Math.abs(f.lateral) < track.halfWidthAt(f.s) + 1.5) inRoad++
    if (f.mount === 'platform' && Math.abs((f.y ?? 0) - (S.platform + S.floor)) > 1e-6) offDeck++
  }
  check(slots.length === expected.slots && inRoad === 0 && offDeck === 0, `${slots.length} marshal slots in figuresAt() (= stats ${st.slots}), none inside hw + 1.5 (${inRoad}), every platform one at ${S.platform + S.floor} m (${offDeck} off)`)
  for (const w of worst) console.log(`    ${w}`)
  // --- the GLB path --------------------------------------------------------------------------------------------
  if (withGlb && reg) {
    const glbMeshes = setMeshes.filter((mm) => /-marshal-booth-(plus|minus)-L0-/.test(mm.name))
    const cells = new Set(glbMeshes.map((mm) => mm.name.replace(/.*-L0-/, '')))
    const farOk = [...cells].every((cell) => setMeshes.some((mm) => new RegExp(`-marshal-body-(plus|minus)-L1-${cell}$`).test(mm.name)))
    const booth = glbMeshes[0]
    let tris = 0, height = 0
    if (booth) {
      const g = booth.geometry
      tris = Math.floor((g.index ? g.index.count : g.attributes.position.count) / 3)
      if (!g.boundingBox) g.computeBoundingBox()
      height = g.boundingBox.max.y - g.boundingBox.min.y
    }
    const has = reg.has('model/trackside/guard_booth')
    check(!has || (glbMeshes.length > 0 && farOk && height <= 3.0 && tris <= 1500), `guard booth GLB: ${glbMeshes.length} near meshes in ${cells.size} cells${has ? '' : ' (drop absent: procedural)'}, far level in every cell (${farOk}), prototype ${height.toFixed(2)} m / ${fmt(tris)} tris`)
    const ext = setMeshes.filter((mm) => /-marshal-extinguisher-glb-L0-/.test(mm.name)).reduce((a, mm) => a + mm.count, 0)
    console.log(`    note: ${ext} GLB extinguishers, camera heads ${heads?.material ? (Array.isArray(heads.material) ? heads.material.length : 1) : 0} material(s)`)
  }
}

finish()

// ===== I4-b: checkTowers (tv-towers.ts / tv-lens.ts / cameras.ts) =================================
/**
 * The TV towers and lenses (plan §I4-b):
 *  - `stats.trackside.towers` = TV_CAMERAS.length (16), `group.userData.tvLenses` = the 13 lens
 *    rows in table order (the rig's CAM order), each equal to `tvLensAt(track, row,
 *    ground.standAt)` (the rig and the builder read one function);
 *  - each lens against the v1 formula (`cameraSide · (hw + 9)`, road plane + 7.9): a table of
 *    the lateral moves with their reason (the 'auto' rule puts the tower 2.5 m behind the
 *    barrier line; the v1 spot stood in the run-off or further back) — a note, not a check —
 *    and the height differs by the tower's ground only (checked);
 *  - every tower instance (`infield-towers-*`) stands where its row resolves (± 5 cm), its
 *    footprint edge ≥ 0.6 m behind the resolved BARRIERS line on the spectator side and
 *    ≥ hw + 1.5 from the centreline; the lens is `TV_LENS.forward` towards the track from the
 *    tower and `TV_LENS.deckDrop` above the deck (`towers[].deckY`), i.e. the deck is
 *    ≤ y_lens − 0.5 and the rails ≥ 0.5 m from the lens (the rig's NEAR);
 *  - the lens height clears the fence: ≥ BARRIER_KIND[kind].top + fence + 1.5 over the run's base;
 *  - one camera operator per platform / crane (`infield-towers-crew` = 16 − poles), each on
 *    its tower's deck (y = deckY ± 5 cm in the road frame) — `figuresAt({ towers })` lists the
 *    same rows;
 *  - the towers cast only with the tier's far-field shadows; `--glb`: the tower cameras' near
 *    level is `tv-camera-glb`, the procedural head behind it.
 */
async function checkTowers(scene, check, { tier, glb: withGlb }) {
  const { env, track } = scene
  const { TV_CAMERAS } = await import('../../app/data/suzuka-barriers-spec.ts')
  const ops = await import('../../app/data/ops-spec.ts')
  const tvLens = await import('../../app/three/tv-lens.ts')
  const { BARRIER_KIND, BARE_FENCE_HEIGHT } = await import('../../app/three/barriers.ts')
  const trackside = await import('../../app/three/trackside.ts')
  const { BARRIERS } = await import('../../app/data/suzuka-barriers-spec.ts')
  const { TV_LENS, TV_TOWER_FOOTPRINT } = tvLens
  const L = track.length
  const arcLen = (a, b) => (((b - a) % L) + L) % L
  const lensRows = TV_CAMERAS.filter((c) => c.lens !== false)
  const st = env.stats.trackside
  check(st && st.towers === TV_CAMERAS.length, `stats.trackside.towers ${st?.towers} = TV_CAMERAS.length ${TV_CAMERAS.length}`)
  const lenses = env.group.userData.tvLenses
  const towers = env.group.userData.trackside?.towers
  check(Array.isArray(lenses) && lenses.length === lensRows.length && lenses.every((l, i) => l.id === lensRows[i].id), `group.userData.tvLenses: ${lenses?.length} lenses in TV_CAMERAS order (${lensRows.length} lens rows)`)
  check(Array.isArray(towers) && towers.length === TV_CAMERAS.length, `group.userData.trackside.towers: ${towers?.length} of ${TV_CAMERAS.length}`)
  if (!Array.isArray(lenses) || !Array.isArray(towers)) return
  // --- the lenses: one function, the v1 formula only where the barrier line forced the move -------------
  let sameAsFn = 0, moved = [], heightOff = 0
  const v = new THREE.Vector3()
  console.log('  lens          s   v1 lateral → now   Δlat  reason                 Δy (ground)')
  lensRows.forEach((row, i) => {
    const lens = lenses[i]
    const ref = tvLens.tvLensAt(track, row, env.ground.standAt)
    if (Math.hypot(lens.x - ref.x, lens.y - ref.y, lens.z - ref.z) < 1e-6 && lens.lateral === ref.lateral) sameAsFn++
    const side = tvLens.cameraSide(track, row.s)
    const old = side * (track.halfWidth + 9)
    track.pointAt(row.s, old, v, 7.9)
    const dLat = Math.abs(lens.lateral - old)
    const line = trackside.barrierLateralAt(track, row.s, side)
    const oldInFront = line !== null && Math.abs(old) < Math.abs(line) + TV_LENS.autoSetback
    const explicit = row.lateral !== 'auto'
    const reason = dLat <= 1 ? 'kept' : explicit ? 'explicit lateral (v1 override)' : oldInFront ? `v1 spot in front of the line (${line.toFixed(1)})` : `'auto': 2.5 m behind the line (${line.toFixed(1)})`
    if (dLat > 1) moved.push(`${row.id} ${dLat.toFixed(1)}`)
    const dY = lens.y - v.y
    if (Math.abs(dY - lens.base) > 0.3) heightOff++
    console.log(`  ${row.id.padEnd(12)} ${String(row.s).padStart(4)}   ${old.toFixed(1).padStart(6)} → ${lens.lateral.toFixed(1).padStart(6)}  ${dLat.toFixed(1).padStart(4)}  ${reason.padEnd(38)} ${dY >= 0 ? '+' : ''}${dY.toFixed(2)} (${lens.base >= 0 ? '+' : ''}${lens.base.toFixed(2)})`)
  })
  check(sameAsFn === lensRows.length, `every published lens equals tvLensAt(track, row, ground.standAt) (${sameAsFn} of ${lensRows.length})`)
  // the plan expected ≤ 1 m except the three v1 overrides; the 'auto' rule (2.5 m behind the barrier
  // line, never in the run-off) moves most lenses — the v1 spots at hw + 9 stood in the gravel or
  // further back than the towers stand now. Reported, not failed: the rule is the data's.
  console.log(`  note ${moved.length} of ${lensRows.length} lenses > 1 m from the v1 formula (${moved.join(', ')} m)`)
  check(heightOff === 0, `every lens height = v1 height + the tower's ground (${heightOff} off by > 0.3 m)`)
  // --- the tower instances -----------------------------------------------------------------------------
  // the far-field group hangs under env.group: one traversal, every L0 InstancedMesh of the tower sets once
  const seen = new Set()
  const meshes = []
  env.group.traverse((o) => { if (o.isInstancedMesh && /^infield-towers?-/.test(o.name) && /-L0-/.test(o.name) && !seen.has(o)) { seen.add(o); meshes.push(o) } })
  const towerMeshes = meshes.filter((m) => m.name.startsWith('infield-towers-tower-'))
  const camMeshes = meshes.filter((m) => m.name.startsWith('infield-tower-cams-'))
  const m4 = new THREE.Matrix4(), p = new THREE.Vector3()
  const instances = []
  for (const m of towerMeshes) {
    m.updateWorldMatrix(true, false)
    for (let i = 0; i < m.count; i++) { m.getMatrixAt(i, m4); m4.premultiply(m.matrixWorld); p.setFromMatrixPosition(m4); instances.push({ x: p.x, y: p.y, z: p.z, name: m.name }) }
  }
  check(instances.length === TV_CAMERAS.length, `infield-towers L0 instances: ${instances.length} (${towerMeshes.length} InstancedMeshes: ${[...new Set(towerMeshes.map((m) => m.name.replace(/^infield-towers-/, '').replace(/-L0-\d+$/, '')))].join(', ')})`)
  let placed = 0, offLine = [], onRoad = [], deckBad = [], fenceLow = [], kinds = { scaffold: 0, lattice: 0, crane: 0, pole: 0 }
  for (const row of TV_CAMERAS) {
    const t = towers.find((x) => x.id === row.id)
    kinds[row.tower]++
    const lateral = tvLens.towerLateralAt(track, row)
    track.pointAt(row.s, lateral, v, env.ground.standAt(row.s, lateral))
    const inst = instances.find((q) => Math.hypot(q.x - v.x, q.y - v.y, q.z - v.z) < 0.05)
    if (inst && t && Math.abs(t.lateral - lateral) < 1e-9) placed++
    const half = TV_TOWER_FOOTPRINT[row.tower] / 2
    const side = Math.sign(lateral)
    const hw = track.halfWidthAt(row.s)
    if (Math.abs(lateral) - half < hw + 1.5) onRoad.push(row.id)
    const line = trackside.barrierLateralAt(track, row.s, side)
    if (line !== null && (Math.sign(lateral - line) !== side || Math.abs(lateral - line) - half < 0.6)) offLine.push(`${row.id} (${(Math.abs(lateral - line) - half).toFixed(2)} m)`)
    if (row.lens !== false) {
      const lens = lenses.find((l) => l.id === row.id)
      // the deck ≤ y_lens − 0.5 and the front rail ≥ 0.5 m ahead of the lens
      if (!(lens.y - (v.y - env.ground.standAt(row.s, lateral) + t.deckY) >= 0.5)) deckBad.push(`${row.id} deck`)
      if (!(half - TV_LENS.forward >= 0.5)) deckBad.push(`${row.id} rail`)
      if (Math.abs(Math.abs(lens.lateral - lateral) - TV_LENS.forward) > 1e-9 || Math.sign(lateral - lens.lateral) !== side) deckBad.push(`${row.id} lens offset`)
      // the fence under the lens: the run's kind top + its fence, over the run's base (the barrier's own MAX_RISE cap is ≤ the tower ground)
      const run = BARRIERS.find((r) => r.side === side && arcLen(r.sRange[0], row.s) <= arcLen(r.sRange[0], r.sRange[1]))
      if (run) {
        const top = (run.kind === 'fence' ? BARE_FENCE_HEIGHT : BARRIER_KIND[run.kind].top + (run.fence ?? 0))
        const fenceBase = env.ground.standAt(row.s, line)
        if (lens.base + row.height < fenceBase + top + 1.5) fenceLow.push(`${row.id} (${run.id}: lens ${(lens.base + row.height).toFixed(1)} vs fence top ${(fenceBase + top).toFixed(1)} + 1.5)`)
      }
    }
  }
  check(placed === TV_CAMERAS.length, `every tower stands where its row resolves (± 5 cm), towers[].lateral agrees (${placed} of ${TV_CAMERAS.length}: ${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', ')})`)
  check(onRoad.length === 0, `every footprint edge ≥ hw + 1.5 (${onRoad.length}${onRoad.length ? `: ${onRoad.join(', ')}` : ''})`)
  check(offLine.length === 0, `every footprint ≥ 0.6 m behind its barrier line on the spectator side (${offLine.length}${offLine.length ? `: ${offLine.join(', ')}` : ''})`)
  check(deckBad.length === 0, `deck ≤ y_lens − 0.5, front rail ≥ 0.5 m ahead, lens ${TV_LENS.forward} m towards the track (${deckBad.length}${deckBad.length ? `: ${deckBad.join(', ')}` : ''})`)
  check(fenceLow.length === 0, `every lens ≥ 1.5 m over the fence top in front of it (${fenceLow.length}${fenceLow.length ? `: ${fenceLow.join('; ')}` : ''})`)
  const shadows = env.farField ? scene.quality?.farField?.shadows : undefined
  const casting = towerMeshes.filter((m) => m.castShadow).length
  check(shadows === undefined || (shadows ? casting === towerMeshes.length : casting === 0), `tower L0 casts only with farField.shadows (${casting} of ${towerMeshes.length} cast, shadows ${shadows})`)
  // --- the cameras and the operators ---------------------------------------------------------------------
  const camCount = camMeshes.reduce((a, m) => a + m.count, 0)
  const platforms = TV_CAMERAS.filter((c) => c.tower === 'scaffold' || c.tower === 'lattice').length
  check(camCount === platforms, `infield-tower-cams L0: ${camCount} camera heads = ${platforms} platforms`)
  const glbCams = camMeshes.filter((m) => /-glb-/.test(m.name))
  if (withGlb) check(glbCams.length > 0 && camMeshes.every((m) => /-glb-/.test(m.name)), `--glb: the camera heads' near level is tv-camera-glb (${glbCams.length} of ${camMeshes.length} meshes)`)
  else check(glbCams.length === 0, `no -glb- camera mesh without the pack (${glbCams.length})`)
  const crewN = env.stats.infield['infield-towers-crew'] ?? 0
  const slotInputs = towers.map((t) => ({ id: t.id, s: t.s, lateral: t.lateral, tower: t.tower, floorY: t.deckY }))
  const slots = slotInputs.flatMap(ops.cameraSlots)
  check(crewN === slots.length && slots.length === TV_CAMERAS.length - kinds.pole, `infield-towers-crew: ${crewN} operators = cameraSlots ${slots.length} = ${TV_CAMERAS.length} towers − ${kinds.pole} poles`)
  const all = ops.figuresAt({ towers: slotInputs })
  check(all.length === ops.figuresAt().length + slots.length, `figuresAt({ towers }) appends the operators (${all.length} = ${ops.figuresAt().length} + ${slots.length})`)
  const crewMeshes = []
  env.farField.group.traverse((o) => { if (o.isInstancedMesh && o.name.startsWith('infield-towers-crew-') && o.count > 0) crewMeshes.push(o) })
  let onDeck = 0
  for (const s of slots) {
    track.pointAt(s.s, s.lateral, v, s.y)
    let hit = false
    for (const m of crewMeshes) {
      m.updateWorldMatrix(true, false)
      for (let i = 0; i < m.count && !hit; i++) { m.getMatrixAt(i, m4); m4.premultiply(m.matrixWorld); p.setFromMatrixPosition(m4); if (Math.hypot(p.x - v.x, p.z - v.z) < 0.05 && Math.abs(p.y - v.y) < 0.06) hit = true }
    }
    if (hit) onDeck++
  }
  check(onDeck === slots.length, `every operator drawn on its deck / base plate (± 5 cm of the slot, y = floor: ${onDeck} of ${slots.length})`)
  const tris = towerMeshes.reduce((a, m) => a + trisOf(m), 0) + camMeshes.reduce((a, m) => a + trisOf(m), 0)
  console.log(`  note ${tier}: towers + cameras ${fmt(tris)} triangles in ${towerMeshes.length + camMeshes.length} L0 InstancedMeshes; lattice braces ${scene.quality?.fence ?? '?'}`)
}

// ===== I4-c: checkBarriers (barriers.ts / structures.ts / textures.ts) ==============================
/**
 * The barriers v2 (plan §I4-c), built here with `buildBarriers(track, quality, ground, reg)`:
 *  - BARRIERS has 73 runs (the 72 of I4-b + spoon-inside-wall; README said 71) and `spoon-inside-wall` is drawn: wall
 *    vertices stand on its resolved line at s 3600 (± 0.3 m);
 *  - `group.userData.barriers` (BarrierStats) is published and its `runs` = the table;
 *  - the fence colour buckets: the black runs' posts are `fencePostsDark-*`, the rest
 *    `fencePosts-*` (counts = the stats; both present on a tier with fences, none on the other);
 *    the two mesh sheets `debrisFence` / `debrisFenceDark`, the rails `fenceRails` / `fenceRailsDark`;
 *  - every window of the table is cut: no fence vertex inside the opening (the 1.2 × 0.8 m
 *    rectangle over the sill, 5 cm in) at each listed s — 7 windows on 5 runs;
 *  - the tyre stacks: 2 per fence-post position of every tyre run when `quality.infield.detail`
 *    (0 otherwise), a prop set on the far-field registry (`infield-tyreStacks`, L0 per cell,
 *    markObject tyreStack), every one standing on the spectator side of its wall's back and ≥ hw + 1.5;
 *  - the sponge blocks: two rows in front of chicane-exit-tyres (SPONGE), the ground row tagged
 *    `sponge`, every block ≥ 0.7 m from the line on the track side and ≥ hw + 1.5;
 *  - the triple beam (`guardrails3`) on the two 130R verge runs only;
 *  - boards: `barrierBoards` (the face boards + 8 ad bands), `adPanels` = AD_PANELS.length;
 *  - the bridge fascia's top is FASCIA_TOP over the road plane and the girder constants are
 *    unchanged (the source still says SOFFIT −1.3, FASCIA_BOTTOM −1.05, GIRDER_Y = SOFFIT − GIRDER_H);
 *  - no TecPro texture is left (textures.ts) and no mesh / material is named after it;
 *  - the fence-window photographers: `figuresAt({ lineAt })` adds one 'trackside' photographer
 *    per window, behind the line, and the ops set draws that many more photographers.
 *  `--glb`: the tyre stacks' near level is the pack's tire_stack (a `tyre-stack-glb` prototype).
 */
async function checkBarriers(scene, check, { tier, glb: withGlb, reg }) {
  const { env, track, ground, quality } = scene
  const fs = await import('node:fs')
  const path = await import('node:path')
  const barMod = await import('../../app/three/barriers.ts')
  const L = track.length
  const fwd = (a, b) => (((b - a) % L) + L) % L
  console.log(`  barriers${withGlb ? ' (GLB prototypes)' : ''}`)
  const t0 = performance.now()
  const group = barMod.buildBarriers(track, quality, ground, reg ?? null, env.farField)
  group.updateMatrixWorld(true)
  env.farField.group.updateMatrixWorld(true)
  console.log(`    built in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
  const st = group.userData.barriers
  check(bar.BARRIERS.length === 73 && st?.runs === 73, `BARRIERS: ${bar.BARRIERS.length} runs = 72 + spoon-inside-wall (stats ${st?.runs})`)
  const spoon = bar.BARRIERS.find((r) => r.id === 'spoon-inside-wall')
  check(!!spoon && spoon.kind === 'concrete' && spoon.side === 1, `spoon-inside-wall in the table (concrete, left, ${spoon?.sRange.join('→')})`)
  const byName = new Map()
  group.traverse((o) => { if (o.name) byName.set(o.name, o) })
  const meshes = []
  group.traverse((o) => { if (o.isMesh || o.isInstancedMesh) meshes.push(o) })
  const named = (re) => meshes.filter((m) => re.test(m.name))
  // --- the Spoon wall is drawn: vertices on its line at 3600 ---------------------------------------------
  {
    const line = trackside.resolveLineCached(track, spoon.source, spoon.sRange, spoon.side, spoon.minGap ?? 0.6)
    const walls = byName.get('barrierWalls')
    let near = 0
    if (walls) {
      const pos = walls.geometry.attributes.position
      const v = new THREE.Vector3()
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(walls.matrixWorld)
        const q = track.nearestOnRange(v.x, v.z, 3560, 3640, 5)
        if (Math.abs(q.s - 3600) < 3 && Math.abs(q.lateral - line.lat(q.s)) < 0.3) near++
      }
    }
    check(near > 0, `spoon-inside-wall drawn: ${near} barrierWalls vertices on its line (${line.lat(3600).toFixed(1)}) at s 3600 ± 3`)
  }
  // --- fence buckets --------------------------------------------------------------------------------------
  const fenceOn = quality.fence
  const green = named(/^fencePosts-/), dark = named(/^fencePostsDark-/)
  const nGreen = green.reduce((a, m) => a + m.count, 0), nDark = dark.reduce((a, m) => a + m.count, 0)
  if (fenceOn) {
    const darkRuns = bar.BARRIERS.filter((r) => r.fenceColour === bar.FENCE_BLACK && (r.fence || r.kind === 'fence')).length
    check(nGreen > 0 && nDark > 0 && nGreen === st.fencePosts && nDark === st.fencePostsDark, `fence posts: ${nGreen} green + ${nDark} dark instances (= stats ${st.fencePosts} / ${st.fencePostsDark}; ${darkRuns} black runs)`)
    check(byName.has('debrisFence') && byName.has('debrisFenceDark') && byName.has('fenceRails') && byName.has('fenceRailsDark'), `fence sheets and rails in both colours (${['debrisFence', 'debrisFenceDark', 'fenceRails', 'fenceRailsDark'].filter((n) => byName.has(n)).join(', ')})`)
    // the second fences: posts behind gyaku-outside's back
    const gy = bar.BARRIERS.find((r) => r.id === 'gyaku-outside')
    const line = trackside.resolveLineCached(track, gy.source, gy.sRange, gy.side, gy.minGap ?? 0.6)
    let behind = 0
    const m4 = new THREE.Matrix4(), v = new THREE.Vector3()
    for (const inst of green) for (let i = 0; i < inst.count; i++) {
      inst.getMatrixAt(i, m4)
      v.setFromMatrixPosition(m4.premultiply(inst.matrixWorld))
      const q = track.nearestOnRange(v.x, v.z, gy.sRange[0], gy.sRange[1], 5)
      if (fwd(gy.sRange[0], q.s) <= fwd(gy.sRange[0], gy.sRange[1]) && Math.abs(q.lateral - (line.lat(q.s) + 0.35 + bar.FENCE_BACK_SETBACK)) < 0.3) behind++
    }
    check(behind >= 30, `fenceSide 'both': ${behind} posts on gyaku-outside's spectator-side fence (line + 0.35 + ${bar.FENCE_BACK_SETBACK})`)
  } else {
    check(nGreen === 0 && nDark === 0 && !byName.has('debrisFence'), `no fence on the ${tier} tier (posts ${nGreen + nDark})`)
  }
  // --- the windows -----------------------------------------------------------------------------------------
  const windowRuns = bar.BARRIERS.filter((r) => r.windows?.length)
  const nWindows = windowRuns.reduce((a, r) => a + r.windows.length, 0)
  check(nWindows === 7 && windowRuns.length === 5, `windows: ${nWindows} on ${windowRuns.length} runs (${windowRuns.map((r) => `${r.id} [${r.windows.join(', ')}]`).join('; ')})`)
  if (fenceOn) {
    check(st.windows === nWindows, `stats.windows ${st.windows} = ${nWindows}`)
    const W = barMod.FENCE_WINDOW
    let inside = 0, checked = 0
    const sheets = named(/^debrisFence(Dark)?$/)
    const v = new THREE.Vector3()
    for (const run of windowRuns) {
      const prof = barMod.barrierProfile(track, ground, run)
      const k = barMod.BARRIER_KIND[run.kind]
      for (const w of run.windows) {
        const foot = prof.base(w) + (run.kind === 'fence' ? 0.8 : k.top)
        const y0 = foot + W.sill + 0.05, y1 = foot + W.sill + W.h - 0.05
        track.pointAt(w, prof.lat(w), v, 0)
        const cx = v.x, cz = v.z
        for (const sheet of sheets) {
          const pos = sheet.geometry.attributes.position
          for (let i = 0; i < pos.count; i++) {
            v.fromBufferAttribute(pos, i).applyMatrix4(sheet.matrixWorld)
            if (Math.hypot(v.x - cx, v.z - cz) > 3) continue
            const q = track.nearestOnRange(v.x, v.z, w - 6, w + 6, 2)
            const ds = Math.abs(q.s - w)
            checked++
            // the road-frame height of the vertex: pointAt(q.s, lat, 0) gives the plane; the fence's foot is in that frame too
            track.pointAt(q.s, q.lateral, _tmp, 0)
            const yr = v.y - _tmp.y
            if (ds < W.w / 2 - 0.05 && yr > y0 && yr < y1) inside++
          }
        }
      }
    }
    check(inside === 0 && checked > 0, `no fence vertex inside any window opening (${inside} of ${checked} vertices near the windows)`)
    check(Object.keys(st.windowCuts).length === windowRuns.length, `stats.windowCuts covers ${Object.keys(st.windowCuts).length} runs`)
  }
  // --- tyre stacks ---------------------------------------------------------------------------------------
  {
    const tyreRuns = bar.BARRIERS.filter((r) => r.kind === 'tyre')
    let expected = 0
    for (const r of tyreRuns) {
      const len = fwd(r.sRange[0], r.sRange[1])
      for (let d = 0; d <= len; d += barMod.FENCE_POST_PITCH) for (const dS of [-barMod.TYRE_STACK.dS, barMod.TYRE_STACK.dS]) if (d + dS >= 0 && d + dS <= len) expected++
    }
    // the stacks are a prop set on the far-field registry (the viewport passes env.farField): near level L0 per cell
    const stacks = []
    env.farField.group.traverse((o) => { if (o.isInstancedMesh && /^infield-tyreStacks-.*-L0-/.test(o.name)) stacks.push(o) })
    const n = stacks.reduce((a, m) => a + m.count, 0)
    if (quality.infield.detail) {
      check(n === expected && st.tyreStacks === n, `tyre stacks: ${n} instances = 2 per post position of ${tyreRuns.length} tyre runs (${expected}; stats ${st.tyreStacks})`)
      check(stacks.every((m) => m.userData.groundObject?.kind === 'tyreStack'), `every infield-tyreStacks L0 mesh tagged markObject tyreStack (${stacks.length} cells)`)
      const far = []
      env.farField.group.traverse((o) => { if (o.isInstancedMesh && /^infield-tyreStacks-.*-L1-/.test(o.name)) far.push(o) })
      check(withGlb && reg?.has('model/trackside/tire_stack') ? far.length === stacks.length && stacks.every((m) => /tyre-stack-glb/.test(m.name)) : far.length === 0 && stacks.every((m) => /-tyre-stack-L0-/.test(m.name)), `tyre stack levels: ${stacks.length} near (${stacks[0]?.name.replace(/-\d+$/, '')}), ${far.length} far`)
      // every stack on the spectator side of its wall's back, off the road
      let bad = 0, inRoad = 0
      const m4 = new THREE.Matrix4(), v = new THREE.Vector3()
      for (const inst of stacks) for (let i = 0; i < inst.count; i++) {
        inst.getMatrixAt(i, m4)
        v.setFromMatrixPosition(m4.premultiply(inst.matrixWorld))
        let ok = false
        for (const r of tyreRuns) {
          const q = track.nearestOnRange(v.x, v.z, r.sRange[0], r.sRange[1], 5)
          if (fwd(r.sRange[0], q.s) > fwd(r.sRange[0], r.sRange[1])) continue
          const line = trackside.resolveLineCached(track, r.source, r.sRange, r.side, r.minGap ?? 0.6).lat(q.s)
          // ≥ the wall's depth behind the line (the projection back to s slides along a sloping line, so not the full 1.72 m the builder used)
          if (r.side * (q.lateral - line) >= 1.3) { ok = true; if (Math.abs(q.lateral) < track.halfWidthAt(q.s) + 1.5) inRoad++; break }
        }
        if (!ok) bad++
      }
      check(bad === 0 && inRoad === 0, `every tyre stack behind its run's back (≥ 1.3 m off the line, spectator side: ${bad} off) and ≥ hw + 1.5 (${inRoad} in)`)
      const tris = stacks.reduce((a, m) => a + trisOf(m), 0)
      console.log(`    note: tyre stacks ${fmt(tris)} triangles in ${stacks.length} cells (near level, drawn inside ${quality.infield.propsNearM} m with the pack, the far tori to ${quality.infield.propsFarM} m)`)
      if (withGlb && reg?.has('model/trackside/tire_stack')) {
        const perStack = stacks.length ? Math.floor((stacks[0].geometry.index ? stacks[0].geometry.index.count : stacks[0].geometry.attributes.position.count) / 3) : 0
        check(perStack === 960, `--glb: the tyre stack prototype is the pack's tire_stack (${perStack} tris per stack)`)
      }
    } else {
      check(n === 0 && st.tyreStacks === 0, `no tyre stacks without infield.detail (${n})`)
    }
  }
  // --- sponge blocks ---------------------------------------------------------------------------------------
  {
    const run = bar.BARRIERS.find((r) => r.id === barMod.SPONGE.run)
    const len = fwd(run.sRange[0], run.sRange[1])
    const [sl] = barMod.SPONGE.size
    let low = 0, high = 0
    for (let d = sl / 2; d + sl / 2 <= len; d += barMod.SPONGE.pitch) { low++; if (d + barMod.SPONGE.shift + sl / 2 <= len) high++ }
    const lo = byName.get('spongeBlocks'), hi = byName.get('spongeBlocksTop')
    check(lo?.count === low && hi?.count === high && st.sponges === low + high, `sponge blocks: ${lo?.count} + ${hi?.count} (expected ${low} + ${high}; stats ${st.sponges})`)
    check(lo?.userData.groundObject?.kind === 'sponge' && !hi?.userData.groundObject, `the ground row tagged markObject sponge, the top row not`)
    if (lo) {
      // the wall is diagonal to the road: the clearance is the XZ distance to the line's polyline (0.5 m samples), O5's w / 2 + 0.2 = 0.7
      const line = trackside.resolveLineCached(track, run.source, run.sRange, run.side, run.minGap ?? 0.6)
      const pts = []
      const v = new THREE.Vector3()
      for (let d = 0; d <= len; d += 0.5) { track.pointAt(run.sRange[0] + d, line.lat(run.sRange[0] + d), v, 0); pts.push([v.x, v.z]) }
      let bad = 0, worst = Infinity
      const m4 = new THREE.Matrix4()
      for (let i = 0; i < lo.count; i++) {
        lo.getMatrixAt(i, m4)
        v.setFromMatrixPosition(m4.premultiply(lo.matrixWorld))
        let dist = Infinity
        for (let k = 0; k < pts.length - 1; k++) {
          const [ax, az] = pts[k], [bx, bz] = pts[k + 1]
          const dx = bx - ax, dz = bz - az
          const t = Math.max(0, Math.min(1, ((v.x - ax) * dx + (v.z - az) * dz) / (dx * dx + dz * dz || 1)))
          dist = Math.min(dist, Math.hypot(v.x - (ax + dx * t), v.z - (az + dz * t)))
        }
        const q = track.nearestOnRange(v.x, v.z, run.sRange[0], run.sRange[1], 5)
        worst = Math.min(worst, dist)
        if (dist < 0.7 - 0.02 || -run.side * (q.lateral - line.lat(q.s)) < 0 || Math.abs(q.lateral) < track.halfWidthAt(q.s) + 1.5) bad++
      }
      check(bad === 0, `every sponge block ≥ 0.7 m in front of the line (nearest ${worst.toFixed(2)} m) and ≥ hw + 1.5 (${bad} off)`)
    }
  }
  // --- the triple beam ------------------------------------------------------------------------------------
  {
    const g3 = bar.BARRIERS.filter((r) => r.kind === 'guardrail3').map((r) => r.id).sort()
    check(g3.join(',') === '130r-inside-verge,130r-outside-verge' && st.guardrail3.length === 2 && !!byName.get('guardrails3'), `guardrail3 on the two 130R verge runs only (${g3.join(', ')}), mesh guardrails3 ${byName.has('guardrails3')}`)
    check(!!byName.get('guardrails'), `the plain guardrails mesh stays (the table has no armco run)`)
  }
  // --- boards and panels -------------------------------------------------------------------------------------
  {
    const bands = bar.BARRIERS.filter((r) => r.adBand).length
    check(bands === 8 && byName.has('barrierBoards'), `wall-top ad bands on ${bands} runs, mesh barrierBoards ${byName.has('barrierBoards')}`)
    check(st.panels === bar.AD_PANELS.length && byName.has('adPanels') && byName.has('adPanelPosts'), `free-standing panels: ${st.panels} = AD_PANELS ${bar.AD_PANELS.length} (meshes ${['adPanels', 'adPanelPosts'].filter((n) => byName.has(n)).join(', ')})`)
    check(bar.BARRIERS.filter((r) => r.face === 'painted-rwg').length === 3 && byName.has('tyreWallsPainted') && byName.has('barrierWallsPainted'), `painted faces: ${bar.BARRIERS.filter((r) => r.face === 'painted-rwg').map((r) => r.id).join(', ')} → tyreWallsPainted + barrierWallsPainted`)
    const horns = named(/^pitHorns-/).reduce((a, m) => a + m.count, 0)
    check(quality.infield.detail && fenceOn ? horns > 50 && horns === st.horns : horns === 0, `loudspeaker horns: ${horns} (stats ${st.horns})`)
    check(st.gates === bar.BARRIERS.reduce((a, r) => a + (r.gates?.length ?? 0), 0) * (fenceOn ? 1 : 0), `gates: ${st.gates} (table ${bar.BARRIERS.reduce((a, r) => a + (r.gates?.length ?? 0), 0)})`)
  }
  // --- the bridge fascia -------------------------------------------------------------------------------------
  {
    const structures = await import('../../app/three/structures.ts')
    const fascia = env.group.getObjectByName('structures-bridge-fascia')
    let top = -Infinity
    if (fascia) {
      const pos = fascia.geometry.attributes.position
      const v = new THREE.Vector3()
      const sOver = track.crossing.sOver
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(fascia.matrixWorld)
        const q = track.nearestOnRange(v.x, v.z, sOver - 25, sOver + 25, 5)
        track.pointAt(q.s, q.lateral, _tmp, 0)
        top = Math.max(top, v.y - _tmp.y)
      }
    }
    check(!!fascia && Math.abs(top - structures.FASCIA_TOP) < 0.05 && structures.FASCIA_TOP === 0.95, `bridge fascia top ${top.toFixed(2)} m over the road plane = FASCIA_TOP ${structures.FASCIA_TOP}`)
    const src = fs.readFileSync(path.join(process.cwd(), 'app/three/structures.ts'), 'utf8')
    check(/const SOFFIT = -1\.3\b/.test(src) && /const FASCIA_BOTTOM = -1\.05\b/.test(src) && /const GIRDER_Y = SOFFIT - GIRDER_H\b/.test(src), `SOFFIT −1.3 / FASCIA_BOTTOM −1.05 / GIRDER_Y = SOFFIT − GIRDER_H unchanged in structures.ts`)
  }
  // --- no TecPro left ------------------------------------------------------------------------------------------
  {
    const src = fs.readFileSync(path.join(process.cwd(), 'app/three/textures.ts'), 'utf8')
    const namedTec = meshes.filter((m) => /tecpro/i.test(m.name) || [m.material].flat().some((mm) => /tecpro/i.test(mm?.name ?? ''))).length
    check(!/tecpro/i.test(src) && namedTec === 0, `no TecPro texture in textures.ts and no TecPro mesh / material (${namedTec})`)
  }
  // --- the photographers at the windows ----------------------------------------------------------------------
  {
    const lineAt = (s, side) => trackside.barrierLateralAt(track, s, side)
    const withWin = ops.figuresAt({ lineAt })
    const plain = ops.figuresAt()
    const extra = withWin.length - plain.length
    const slots = ops.windowSlots(lineAt)
    let behind = 0
    for (const f of slots) {
      const run = windowRuns.find((r) => r.windows.some((w) => Math.abs(((w - f.s) % L + L) % L) < 1e-6 || Math.abs(w - f.s) < 1e-6))
      if (!run) continue
      const line = lineAt(f.s, run.side)
      if (run.side * (f.lateral - line) > 0.5 && Math.abs(f.lateral) >= track.halfWidthAt(f.s) + 1.5 && f.mount === 'trackside' && f.role === 'photographer') behind++
    }
    check(extra === nWindows && slots.length === nWindows && behind === nWindows, `figuresAt({ lineAt }) adds ${extra} window photographers (${nWindows} windows), every one behind its line, off the road, mount 'trackside'`)
    const drawn = env.stats.ops?.byRole?.photographer
    const expectedPh = withWin.filter((f) => f.role === 'photographer').length
    check(drawn === expectedPh, `stats.ops.byRole.photographer ${drawn} = ${expectedPh} (the pit / paddock ones + ${nWindows} at the windows)`)
  }
  // --- the sign on the separator wall -------------------------------------------------------------------------
  {
    const sign = bar.SIGNS.find((sg) => sg.id === 'pit-entry')
    const structures = await import('../../app/three/structures.ts')
    check(!!sign && sign.mount === 'barrierTop' && sign.run === 't18-pit-entry-separator' && structures.SIGN_CELL.pitEntry === 6 && structures.SIGN_TEXTS.pitEntry === 'PIT ENTRY', `SIGNS pit-entry: mount barrierTop on t18-pit-entry-separator, atlas cell 6 'PIT ENTRY'`)
  }
  const tris = meshes.reduce((a, m) => a + trisOf(m), 0)
  console.log(`    note: ${tier}: barriers group ${meshes.length} meshes, ${fmt(tris)} triangles`)
}
