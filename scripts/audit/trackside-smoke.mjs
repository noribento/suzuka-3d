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
 * Exit 1 on any failure.
 */
import { buildScene, THREE } from './app-runtime.mjs'
import { commonChecks, fmt, infieldRoots, smokeArgs } from './smoke-common.mjs'
import { buildSceneWith, stubRegistry } from './stub-registry.mjs'

const { tiers, check, finish, glb } = smokeArgs('trackside-smoke')

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
}

if (glb) {
  console.log('\ntrackside-smoke: tier high with the trackside drops (stub registry)')
  const reg = await stubRegistry(/^model\/(trackside\/guard_booth|props\/(korean_fire_extinguisher_01|security_camera_02))$/)
  console.log(`  loaded: ${reg.loaded.join(', ') || 'nothing (no drops in the manifest)'}`)
  const scene = await buildSceneWith('high', reg)
  checkPosts(scene, check, { glb: true, reg })
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
