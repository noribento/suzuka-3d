#!/usr/bin/env node
/**
 * Pit smoke (I1 — the pit building v2 and the pit lane; dev-only — not part of `pnpm check`):
 * builds the scene on both tiers through app-runtime.mjs (no asset pack → the procedural
 * fallbacks), drains the far field and checks the common I-phase facts (smoke-common.mjs): no
 * deferred job failed, every `ops-*` / `infield-*` / `pit-*` object has finite vertices and
 * stands inside the circuit ring 775428456, `buildMs.pit / pitLane / paddock` finite. Then the
 * phase's own facts:
 *
 *  I1-a  the three builders exist and lap (pit-building via buildPitComplex, pit-lane and
 *        paddock via the umbrella); the v1 meshes are all there under their names, every
 *        `pit*` / `controlPod` / `leaderTower*` / `paddock*` vertex finite and ≥ 0.5 m under
 *        the road plane at worst; the shared materials are one object per name (pitMaterials);
 *        the SIGNS rows 'pit-entry-60' / 'fire-station' hang on the pit wall (mount pitWallTop,
 *        the wall's lateral, inside its concrete stretch) and structures.ts leaves them alone;
 *        the SCREENS rows: three roof screens on the canopy line, the paddock screen facing the
 *        paddock, `pitScreens` draws exactly the faces of the rows the v1 builder can mount;
 *        PIT_BUILDING.v2 / PIT_WALL v2 carry the dossier numbers; EMISSIVE garageWash /
 *        opsMonitor exist and stay under the bloom threshold.
 *  I1-b  (`checkBuilding`, the building block below) the v2 meshes exist under their names
 *        (pitShell / pitCanopy / pitGlass / pitInterior / pitRails / pitFascia / pitShutters /
 *        pitPlates / pitStairTowers / controlPod / controlPodGlass / t1Nose and the pitColumns /
 *        pitDoorLeaves bays); pitPlates = PIT_GARAGE_COUNT × 2 + caps from the table,
 *        pitDoorLeaves = team blocks × 8, pitColumns = the row's pier count; every pit* vertex
 *        finite and ≥ 0.5 m under the road plane at worst; the stair towers' tops at 17.0 ± 0.1
 *        above the road plane; the CHASE-LENS column (PIT_ENVELOPE.chaseLens): in front of every
 *        block nothing of the building — vertices of the pit* meshes, the props merges and the
 *        instanced bays (prototype bounds through every instance matrix) — lies inside
 *        s ∈ [boxS − 13, boxS − 3] × lateral stop ± 1.5 below the 2F soffit (4.6); all eight
 *        SCREENS rows are drawn (their pylons stand on the canopy).
 *  I1-b 3/4 (in `checkBuilding` too): the commit-3 meshes (pitRearLower / pitRearUpper /
 *        pitRearWindows / pitInteriorRoom / pitInteriorMesh / pitPodium / pitScreenPylons, the
 *        pitRearColumns bays, the pitInteriorBands instances = team blocks); the interior
 *        equipment (`ops-garage-*` InstancedMeshes, the near level): every instance's bbox
 *        inside lateral [garageBack, equipmentFront] and under the ceiling, the instance total
 *        = stats.infield['ops-garage']; the terrace guests: stats.infield['ops-terrace'] =
 *        terraceSlots(track).length on both tiers, every guest over a terrace tread; the
 *        pit-room wash luminance under the bloom threshold on the built materials.
 *  --glb  (stub-registry.mjs, high tier): the pack prototypes of the equipment
 *        (metal_tool_chest / steel_frame_shelves_01 / plastic_crate_02 / pc_monitors) are the
 *        near level and every equipment prototype is ≤ 2.9 m tall.
 *  I1-c  `checkLane` (its own block at the end): the lane's v2 meshes, the hoop count from the
 *        table, the blue-band decal on LAYER.pit.band, every lane vertex finite and above the
 *        road plane − 0.5, the sim envelope (nothing inside lateral (−19.1, −11.5) along the box
 *        strip, nothing in the chase-lens columns), the wall-top signs, the W-beam sections, the
 *        start gantry's 5 × 4 lamps.
 *
 *   node scripts/audit/pit-smoke.mjs [--tier high|low|both] [--glb]
 *
 * Exit 1 on any failure.
 */
import path from 'node:path'
import { buildScene, ROOT, THREE } from './app-runtime.mjs'
import { commonChecks, finiteVertices, fmt, smokeArgs, trisOf } from './smoke-common.mjs'

const { tiers, check, finish, glb } = smokeArgs('pit-smoke')

const spec = await import(path.join(ROOT, 'app/data/suzuka-facilities-spec.ts'))
const bar = await import(path.join(ROOT, 'app/data/suzuka-barriers-spec.ts'))
const em = await import(path.join(ROOT, 'app/three/emissive.ts'))
const figures = await import(path.join(ROOT, 'app/three/figures.ts'))

// --- the tables (tier-independent) -------------------------------------------------------------------
console.log('\npit-smoke: tables')
{
  const v2 = spec.PIT_BUILDING.v2
  check(!!v2 && v2.floors[1] === 5.05 && v2.floors[2] === 9.85, `PIT_BUILDING.v2.floors = [${v2?.floors.join(', ')}] (2009 section 5.05 / 9.85)`)
  check(v2.shutter === spec.PIT_PLANNED.shutter && v2.garageBack === v2.shutter - v2.garage.depth, `v2 shutter ${v2.shutter}, garage depth ${v2.garage.depth} → garageBack ${v2.garageBack}`)
  check(v2.garage.door.w === 4.2 && v2.garage.door.h === 3.0 && v2.garage.boxPitch === spec.PIT_BOX, `v2 door ${v2.garage.door.w} × ${v2.garage.door.h} in the ${v2.garage.boxPitch} m pit`)
  check(v2.podium.s === 5632 && Math.abs(v2.podium.s - spec.garageS(spec.PIT_GARAGE_COUNT - 1)) < spec.PIT_BLOCK / 2, `v2 podium s ${v2.podium.s} over block 12 (${spec.garageS(spec.PIT_GARAGE_COUNT - 1)})`)
  check(v2.stairTowers.s.length === spec.PIT_CORES.length + 1 && v2.stairTowers.top === 17, `v2 stair towers ${v2.stairTowers.s.length}, top ${v2.stairTowers.top}`)
  check(v2.controlPod.sRange[1] === v2.mediaSection.sRange[0] && v2.mediaSection.sRange[1] === spec.PIT_BOX_STRIP[0], `v2 control pod ${v2.controlPod.sRange.join('→')} + media section ${v2.mediaSection.sRange.join('→')} reach the garage row`)
  check(v2.unverified.length >= 5, `v2 unverified list (${v2.unverified.length})`)
  const w = spec.PIT_WALL
  check(w.wallWidth === 0.7 && w.wallTop === 1.8 && w.divider === -16.05 && w.blueBand.lat[0] === -19.1, `PIT_WALL v2: ${w.wallWidth} m wall to ${w.wallTop}, divider ${w.divider}, blue band ${w.blueBand.lat.join('…')}`)
  check(w.height === undefined && w.fenceHeight === undefined && w.topWidth === undefined, 'PIT_WALL v1 keys (height / fenceHeight / topWidth) deleted with the v1 builder (I1-c)')
  // signs on the wall
  const sixty = bar.SIGNS.find((s) => s.id === 'pit-entry-60')
  const fire = bar.SIGNS.find((s) => s.id === 'fire-station')
  check(sixty?.kind === 'speed60' && sixty.mount === 'pitWallTop' && sixty.lateral === w.lateral && sixty.s === 5556, `SIGNS pit-entry-60: speed60 on the wall top at s ${sixty?.s}, lateral ${sixty?.lateral}`)
  check(fire?.mount === 'pitWallTop' && fire.lateral === w.lateral && fire.s === 5562 && fire.facing === '-s', `SIGNS fire-station moved to the wall top at s ${fire?.s}`)
  const inArc = (s, [a, b], L = 5807) => ((s - a + L) % L) <= ((b - a + L) % L)
  check([sixty, fire].every((s) => inArc(s.s, w.concrete)), `both hang inside the concrete wall ${w.concrete.join('→')}`)
  // screens
  const roof = spec.SCREENS.filter((s) => s.mount === 'roof' && s.facing !== 'paddock')
  const pad = spec.SCREENS.find((s) => s.id === 'pit_paddock')
  check(roof.length === 3 && roof.every((s) => s.lateral === -33) && roof.map((s) => s.s).join() === '23,5742,5652', `three roof screens at s ${roof.map((s) => s.s).join(' / ')}, lateral −33`)
  check(pad?.facing === 'paddock' && pad.s === 5748 && pad.lateral === -50 && pad.base === 15 && pad.width === 9 && pad.height === 4 && pad.faces === 1, `pit_paddock: 9 × 4 at (5748, −50), base 15, facing the paddock, east of the centre core's stair tower`)
  // the medical centre row became the course-vehicle base
  const cvb = spec.BUILDINGS.find((b) => b.id === 'course_vehicle_base')
  check(!!cvb && cvb.osmWay === 184429429 && cvb.height === 5 && cvb.builder === 'paddock' && !spec.BUILDINGS.some((b) => b.id === 'medical_centre'), `BUILDINGS course_vehicle_base (way ${cvb?.osmWay}, h ${cvb?.height}) replaces medical_centre`)
  // emissive rows
  const E = em.EMISSIVE
  const lum = (row) => em.luminance(row.color, row.intensity)
  check(!!E.garageWash && lum(E.garageWash) > 0.05 && lum(E.garageWash) < 0.3, `EMISSIVE.garageWash: a lift over the shaded albedo, luminance ${lum(E.garageWash).toFixed(2)} in (0.05, 0.3) — not a cream plateau (I1 review V3)`)
  check(!!E.soffitBounce && lum(E.soffitBounce) > 0.05 && lum(E.soffitBounce) < 1.0, `EMISSIVE.soffitBounce: the soffits' bounce stand-in, luminance ${lum(E.soffitBounce).toFixed(2)} in (0.05, 1.0)`)
  check(E.opsMonitor?.color === 0x9fc4ff && Math.abs(E.opsMonitor.intensity - 0.9) < 1e-9, `EMISSIVE.opsMonitor 0x9fc4ff × 0.9 (luminance ${lum(E.opsMonitor).toFixed(2)})`)
  check(lum(E.garageWash) < em.BLOOM_THRESHOLD && lum(E.opsMonitor) < em.BLOOM_THRESHOLD, `both under the bloom threshold ${em.BLOOM_THRESHOLD} (lit, no halo)`)
}

// ======================================================================== pit-building.ts (I1-b)
/**
 * The building's own facts (I1-b): counts from the tables, the stair towers' tops, every pit*
 * vertex on the road plane's side of the ground, the chase-lens column and the screens. `byName`
 * maps mesh name → meshes directly under env.group.
 */
function checkBuilding(scene, check, byName) {
  const { env, track } = scene
  const L = track.length
  const v2 = spec.PIT_BUILDING.v2
  const E = spec.PIT_ENVELOPE
  const road = new THREE.Vector3()
  const meshesNamed = (re) => [...byName.entries()].filter(([n]) => re.test(n)).flatMap(([, ms]) => ms)
  const instancesOf = (prefix) => meshesNamed(new RegExp(`^${prefix}-\\d+$`)).reduce((a, m) => a + (m.isInstancedMesh ? m.count : 0), 0)
  // the pods' bands come from the table
  check(v2.controlPod.band[0] === 9.6 && v2.controlPod.band[1] === 11.4 && v2.t1Nose.band[0] === 5.2 && v2.t1Nose.band[1] === 7.4, `v2 pod bands: control ${v2.controlPod.band.join('–')}, T1 nose ${v2.t1Nose.band.join('–')}`)
  // counts from the tables
  const nPlates = spec.PIT_GARAGE_COUNT * v2.plates.perBlock.length + v2.plates.caps.length
  const plates = byName.get('pitPlates')?.[0]
  check(!!plates && trisOf(plates) === nPlates * 2, `pitPlates: ${plates ? trisOf(plates) / 2 : 0} plates = PIT_GARAGE_COUNT ${spec.PIT_GARAGE_COUNT} × ${v2.plates.perBlock.length} + ${v2.plates.caps.length} caps = ${nPlates}`)
  const nLeaves = spec.GARAGE_ORDER.length * 8
  check(instancesOf('pitDoorLeaves') === nLeaves, `pitDoorLeaves: ${instancesOf('pitDoorLeaves')} folded leaves = ${spec.GARAGE_ORDER.length} team blocks × 8`)
  // the row's piers: five per block, shared where two blocks abut without a core
  const pierS = new Set()
  for (let g = 0; g < spec.PIT_GARAGE_COUNT; g++) for (let j = 0; j <= 4; j++) pierS.add(Math.round(track.wrap(spec.garageS(g) - spec.PIT_BLOCK / 2 + j * spec.PIT_BOX) * 10))
  check(instancesOf('pitColumns') === pierS.size, `pitColumns: ${instancesOf('pitColumns')} round columns = the row's ${pierS.size} pier positions`)
  const shutters = byName.get('pitShutters')?.[0]
  const nCaps = Math.floor(((spec.PIT_BOX_STRIP[0] - v2.mediaSection.sRange[0] + L) % L) / spec.PIT_BOX)
  check(!!shutters && trisOf(shutters) === (4 + nCaps) * 2 * 3, `pitShutters: ${shutters ? trisOf(shutters) / 2 : 0} shutter faces = (block 12's 4 + the ${nCaps} cap pits) × (front + both faces of the closed rear door)`)
  // every pit* vertex finite and never more than 0.5 m under the road plane at its (s, lateral)
  const pitMeshes = meshesNamed(/^(pit|controlPod|t1Nose)/).filter((m) => !m.isInstancedMesh)
  const fv = finiteVertices(pitMeshes)
  let below = 0, sampled = 0
  for (const m of pitMeshes) {
    const p = m.geometry.attributes.position
    for (let i = 0; i < p.count; i += 5) {
      const hit = track.nearestOnRange(p.getX(i), p.getZ(i), 5540, 110)
      if (!hit || hit.d > 80) continue
      sampled++
      track.pointAt(hit.s, hit.lateral, road, 0)
      if (p.getY(i) < road.y - 0.5) below++
    }
  }
  check(fv.nan === 0 && below === 0, `${pitMeshes.length} pit* meshes: ${fmt(fv.vertices)} vertices finite (${fv.nan} NaN), ${fmt(sampled)} sampled, ${below} more than 0.5 m under the road plane`)
  // the stair towers' tops
  const towers = byName.get('pitStairTowers')?.[0]
  let towerOk = 0
  if (towers) {
    const p = towers.geometry.attributes.position
    const latC = (v2.stairTowers.lateral[0] + v2.stairTowers.lateral[1]) / 2
    for (const ts of v2.stairTowers.s) {
      track.pointAt(ts, latC, road, 0)
      let top = -Infinity
      for (let i = 0; i < p.count; i++) if (Math.hypot(p.getX(i) - road.x, p.getZ(i) - road.z) < 8) top = Math.max(top, p.getY(i) - road.y)
      if (Math.abs(top - v2.stairTowers.top) <= 0.1) towerOk++
    }
  }
  check(towerOk === v2.stairTowers.s.length, `pitStairTowers: ${towerOk} of ${v2.stairTowers.s.length} towers top out at ${v2.stairTowers.top} ± 0.1 above the road plane`)
  // ... and no tower face is coplanar with the tiled 2F / 3F paddock wall (REAR_WALL = the canopy profile's back, I1 review F3)
  {
    const REAR_WALL = v2.canopy.profile[0][0]
    let coplanar = 0, n = 0
    if (towers) {
      const p = towers.geometry.attributes.position
      for (let i = 0; i < p.count; i++) {
        const hit = track.nearestOnRange(p.getX(i), p.getZ(i), 5540, 110)
        if (!hit) continue
        n++
        if (Math.abs(hit.lateral - REAR_WALL) <= 0.008) coplanar++
      }
    }
    check(n > 0 && coplanar === 0, `pitStairTowers: ${n} vertices, none within 8 mm (LAYER_MIN_STEP) of the paddock wall at ${REAR_WALL} (${coplanar})`)
  }
  // the chase-lens column: nothing of the building below the 2F soffit inside
  // s ∈ [boxS − columnS[0], boxS − 3] × lateral stop ± halfLat (PIT_ENVELOPE.chaseLens)
  const SOFFIT = v2.garage.ceiling
  const half = E.chaseLens.halfLat
  const columns = []
  for (let g = 0; g < spec.PIT_GARAGE_COUNT; g++) {
    const boxS = spec.garageS(g)
    const s0 = track.wrap(boxS - E.chaseLens.columnS[0]), s1 = track.wrap(boxS - 3)
    // a world XZ box around the column for the cheap first pass
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
    for (const [ss, ll] of [[s0, E.stop - half], [s0, E.stop + half], [s1, E.stop - half], [s1, E.stop + half]]) {
      track.pointAt(ss, ll, road, 0)
      minX = Math.min(minX, road.x - 1); maxX = Math.max(maxX, road.x + 1); minZ = Math.min(minZ, road.z - 1); maxZ = Math.max(maxZ, road.z + 1)
    }
    columns.push({ g, boxS, s0, s1, minX, maxX, minZ, maxZ })
  }
  const inColumn = (x, y, z) => {
    for (const c of columns) {
      if (x < c.minX || x > c.maxX || z < c.minZ || z > c.maxZ) continue
      const hit = track.nearestOnRange(x, z, c.s0, c.s1, 20)
      if (!hit) continue
      const ds = ((hit.s - c.s0 + L) % L)
      if (ds > E.chaseLens.columnS[0] - 3 + 1e-6) continue
      if (Math.abs(hit.lateral - E.stop) > half) continue
      track.pointAt(hit.s, hit.lateral, road, 0)
      if (y - road.y < SOFFIT) return { c, y: y - road.y, ds: E.chaseLens.columnS[0] - ds, lateral: hit.lateral }
    }
    return null
  }
  const offenders = []
  const buildingMeshes = meshesNamed(/^(pit|controlPod|t1Nose|garage|props$)/)
  const v = new THREE.Vector3(), m4 = new THREE.Matrix4()
  for (const m of buildingMeshes) {
    m.updateWorldMatrix(true, false)
    const p = m.geometry.attributes.position
    if (m.isInstancedMesh) {
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox()
      const bb = m.geometry.boundingBox
      const corners = [[bb.min.x, bb.min.y, bb.min.z], [bb.max.x, bb.min.y, bb.min.z], [bb.min.x, bb.max.y, bb.min.z], [bb.max.x, bb.max.y, bb.min.z], [bb.min.x, bb.min.y, bb.max.z], [bb.max.x, bb.min.y, bb.max.z], [bb.min.x, bb.max.y, bb.max.z], [bb.max.x, bb.max.y, bb.max.z]]
      for (let i = 0; i < m.count; i++) {
        m.getMatrixAt(i, m4)
        m4.premultiply(m.matrixWorld)
        for (const [x, y, z] of corners) {
          v.set(x, y, z).applyMatrix4(m4)
          const hit = inColumn(v.x, v.y, v.z)
          if (hit) { offenders.push(`${m.name}[${i}] block ${hit.c.g + 1} (boxS − ${hit.ds.toFixed(1)}, lateral ${hit.lateral.toFixed(2)}, +${hit.y.toFixed(2)})`); break }
        }
      }
    } else {
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld)
        const hit = inColumn(v.x, v.y, v.z)
        if (hit) { offenders.push(`${m.name} block ${hit.c.g + 1} (boxS − ${hit.ds.toFixed(1)}, lateral ${hit.lateral.toFixed(2)}, +${hit.y.toFixed(2)})`); break }
      }
    }
  }
  check(offenders.length === 0, `chase-lens column: nothing of the building below ${SOFFIT} m inside s ∈ [boxS − ${E.chaseLens.columnS[0]}, boxS − 3] × lateral ${E.stop} ± ${half} for the ${spec.PIT_GARAGE_COUNT} blocks (${buildingMeshes.length} meshes${offenders.length ? `; ${offenders.slice(0, 4).join('; ')}` : ''})`)
  // every SCREENS row is drawn (the roof rows' frames stand on the canopy)
  const faces = spec.SCREENS.reduce((a, s) => a + s.faces, 0)
  const screens = byName.get('pitScreens')?.[0]
  check(!!screens && trisOf(screens) === faces * 2, `pitScreens: ${screens ? trisOf(screens) : 0} tris = ${faces} faces × 2 (all ${spec.SCREENS.length} rows)`)
  // the roof screens' faces clear the stair towers (the paddock screen sat inside the centre core's tower, I1 review F4)
  {
    let inTower = 0
    if (screens) {
      const p = screens.geometry.attributes.position
      const [tLo, tHi] = [Math.min(...v2.stairTowers.lateral), Math.max(...v2.stairTowers.lateral)]
      for (let i = 0; i < p.count; i++) {
        const hit = track.nearestOnRange(p.getX(i), p.getZ(i), 5540, 110)
        if (!hit || hit.d > 60) continue
        track.pointAt(hit.s, hit.lateral, road, 0)
        const y = p.getY(i) - road.y
        for (const ts of v2.stairTowers.s) {
          const ds = ((hit.s - ts) % L + L) % L
          if (Math.min(ds, L - ds) <= v2.stairTowers.size[0] / 2 && hit.lateral >= tLo && hit.lateral <= tHi && y <= v2.stairTowers.top) inTower++
        }
      }
    }
    check(inTower === 0, `pit_paddock: the screen faces clear the stair towers (${inTower} vertices inside a tower box)`)
  }
  // --- I1-b 3/4: interiors, rear, roof plant, podium, terrace guests ------------------------------
  const C3_NAMES = ['pitRearLower', 'pitRearUpper', 'pitRearWindows', 'pitInteriorRoom', 'pitInteriorMesh', 'pitPodium', 'pitScreenPylons']
  const c3Missing = C3_NAMES.filter((n) => (byName.get(n)?.length ?? 0) !== 1)
  check(c3Missing.length === 0, `commit-3 meshes: ${C3_NAMES.length} names${c3Missing.length ? ` — missing: ${c3Missing.join(', ')}` : ''}`)
  check(instancesOf('pitRearColumns') === Math.ceil(((spec.PIT_BOX_STRIP[1] - v2.mediaSection.sRange[0] + L) % L) / v2.rearCanopy.columns.pitch - 0.5), `pitRearColumns: ${instancesOf('pitRearColumns')} round columns every ${v2.rearCanopy.columns.pitch} m under the rear canopy`)
  const bands = byName.get('pitInteriorBands')?.[0]
  check(!!bands?.isInstancedMesh && bands.count === spec.GARAGE_ORDER.length, `pitInteriorBands: ${bands?.count ?? 0} team-colour floor bands = ${spec.GARAGE_ORDER.length} team blocks`)
  // the pit-room / floor / mesh wash: on the built materials, under the bloom threshold
  const room = byName.get('pitInteriorRoom')?.[0], floor = byName.get('pitInterior')?.[0], mesh = byName.get('pitInteriorMesh')?.[0]
  const washOk = [room, mesh].every((m) => m && m.material.emissive && m.material.emissiveIntensity > 0 && em.luminanceLinear(m.material.emissive.r, m.material.emissive.g, m.material.emissive.b, m.material.emissiveIntensity) < em.BLOOM_THRESHOLD)
  const floorUnlit = !!floor && (!floor.material.emissive || floor.material.emissiveIntensity === 0 || floor.material.emissive.getHex() === 0)
  check(washOk && floorUnlit, `garage wash on pitInteriorRoom / pitInteriorMesh: emissive set, luminance under ${em.BLOOM_THRESHOLD}; pitInterior (the floor) unwashed, lit by the sky alone`)
  // the soffits: the down-facing white surfaces are their own merge on the bounce stand-in, the rail plates transparent
  const soffitShell = byName.get('pitShellSoffit')?.[0], railGlass = byName.get('pitRailGlass')?.[0]
  check(!!soffitShell && soffitShell.material.emissiveIntensity > 0 && soffitShell.material !== byName.get('pitShell')?.[0]?.material, `pitShellSoffit: ${soffitShell ? trisOf(soffitShell) : 0} tris on soffitShellMat (emissive ${soffitShell?.material.emissive?.getHexString()} × ${soffitShell?.material.emissiveIntensity})`)
  check(!!railGlass && railGlass.material.transparent === true && railGlass.material.depthWrite === false && railGlass.material.opacity < 0.5, `pitRailGlass: ${railGlass ? trisOf(railGlass) : 0} tris, transparent (opacity ${railGlass?.material.opacity}), no depth write`)
  // the equipment: every near-level instance inside the garages' equipment zone
  const stats = env.stats?.infield ?? {}
  const garageMeshes = []
  env.group.traverse((o) => { if (o.isInstancedMesh && /^ops-garage-.*-L0-\d+$/.test(o.name)) garageMeshes.push(o) })
  let gInstances = 0, gOut = 0, gTall = 0
  const gOffenders = []
  for (const m of garageMeshes) {
    m.updateWorldMatrix(true, false)
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox()
    const bb = m.geometry.boundingBox
    const corners = [[bb.min.x, bb.min.y, bb.min.z], [bb.max.x, bb.min.y, bb.min.z], [bb.min.x, bb.max.y, bb.min.z], [bb.max.x, bb.max.y, bb.min.z], [bb.min.x, bb.min.y, bb.max.z], [bb.max.x, bb.min.y, bb.max.z], [bb.min.x, bb.max.y, bb.max.z], [bb.max.x, bb.max.y, bb.max.z]]
    for (let i = 0; i < m.count; i++) {
      gInstances++
      m.getMatrixAt(i, m4)
      m4.premultiply(m.matrixWorld)
      let bad = false, tall = false
      for (const [x, y, z] of corners) {
        v.set(x, y, z).applyMatrix4(m4)
        const hit = track.nearestOnRange(v.x, v.z, 5580, 100)
        if (!hit) { bad = true; continue }
        if (hit.lateral < v2.garageBack - 0.05 || hit.lateral > v2.interior.equipmentFront) bad = true
        track.pointAt(hit.s, hit.lateral, road, 0)
        if (v.y - road.y > v2.garage.ceiling + 0.01) tall = true
      }
      if (bad) { gOut++; if (gOffenders.length < 4) gOffenders.push(`${m.name}[${i}]`) }
      if (tall) gTall++
    }
  }
  check(garageMeshes.length > 0 && gOut === 0 && gTall === 0, `ops-garage: ${garageMeshes.length} near-level InstancedMeshes, ${gInstances} instances, all inside lateral [${v2.garageBack}, ${v2.interior.equipmentFront}] and under the ceiling (${gOut} outside${gOffenders.length ? `: ${gOffenders.join(', ')}` : ''}, ${gTall} too tall)`)
  check(stats['ops-garage'] === gInstances, `stats.infield['ops-garage'] = ${stats['ops-garage']} = the instance total ${gInstances}`)
  // the terrace guests: the count restated from figures.terraceSlots, every guest over a terrace tread
  const slots = figures.terraceSlots(track)
  check(stats['ops-terrace'] === slots.length && slots.length > 0, `stats.infield['ops-terrace'] = ${stats['ops-terrace']} = terraceSlots(track).length ${slots.length} (≈ ${spec.GARAGE_ORDER.length} team blocks × (${v2.terrace2F.rows} × ${v2.guests.seats2F} + ${v2.terrace3F.rows} × ${v2.guests.seats3F}) × ${v2.guests.occupancy} = ${Math.round(spec.GARAGE_ORDER.length * (v2.terrace2F.rows * v2.guests.seats2F + v2.terrace3F.rows * v2.guests.seats3F) * v2.guests.occupancy)})`)
  let guestsOff = 0
  for (const g of slots) {
    const hit = track.nearestOnRange(g.x, g.z, 5620, 95)
    if (!hit) { guestsOff++; continue }
    track.pointAt(hit.s, hit.lateral, road, 0)
    const y = g.y - road.y
    const on2F = hit.lateral < v2.terrace2F.steps[0] && hit.lateral > v2.terrace2F.steps[1] - 0.5 && y > v2.floors[1] && y < v2.floors[1] + 1.2
    const on3F = hit.lateral < v2.terrace3F.frontRow.lateral && hit.lateral > v2.terrace3F.deck.lateral - 0.5 && y > v2.terrace3F.frontRow.y - 0.05 && y < v2.terrace3F.deck.y + 0.05
    if (!(on2F || on3F)) guestsOff++
  }
  check(guestsOff === 0, `every terrace guest sits over a 2F / 3F tread (${guestsOff} off)`)
  // ... and ON a seat: every guest coincides with a pitSeats instance (same s, lateral − inset)
  const seatKeys = new Set()
  for (const m of meshesNamed(/^pitSeats-\d+$/)) {
    m.updateWorldMatrix(true, false)
    for (let i = 0; i < m.count; i++) {
      m.getMatrixAt(i, m4)
      m4.premultiply(m.matrixWorld)
      v.setFromMatrixPosition(m4)
      seatKeys.add(`${Math.round(v.x * 20)}|${Math.round(v.z * 20)}`)
    }
  }
  const nearSeat = (g) => {
    const kx = Math.round(g.x * 20), kz = Math.round(g.z * 20)
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if (seatKeys.has(`${kx + dx}|${kz + dz}`)) return true
    return false
  }
  const unseated = slots.filter((g) => !nearSeat(g)).length
  check(unseated === 0, `every terrace guest sits on a pitSeats instance (${seatKeys.size} seats, ${unseated} unseated)`)
  const terraceMeshes = []
  env.farField.group.traverse((o) => { if (o.isInstancedMesh && /^ops-terrace-/.test(o.name)) terraceMeshes.push(o) })
  const terraceInst = terraceMeshes.filter((m) => /-L\d+-\d+$/.test(m.name) && !/-3d-/.test(m.name)).reduce((a, m) => a + m.count, 0)
  check(terraceInst === slots.length, `ops-terrace impostor instances ${terraceInst} = ${slots.length}`)
  // buildMs.pit finite
  check(Number.isFinite(env.buildMs?.pit), `buildMs.pit = ${Number(env.buildMs?.pit).toFixed(0)} ms`)
}

/**
 * The GLB path of the building (--glb, high tier): the stub registry serves the equipment's
 * pack models, so `glbOr` makes them the near level of 'ops-garage'; every prototype (pack or
 * procedural) stays ≤ 2.9 m tall (nothing of the equipment reaches the ceiling strips or the
 * chase lens' height band) and the procedural far level is still there behind each pack one.
 */
async function checkBuildingGlb(check) {
  const { stubRegistry, buildSceneWith } = await import('./stub-registry.mjs')
  const keys = ['model/props/metal_tool_chest', 'model/props/steel_frame_shelves_01', 'model/props/plastic_crate_02', 'model/pit/pc_monitors']
  const reg = await stubRegistry(keys)
  check(reg.loaded.length === keys.length, `--glb: stub registry loaded ${reg.loaded.length} of ${keys.length} equipment models`)
  const scene = await buildSceneWith('high', reg)
  const near = new Map(), far = new Map()
  scene.env.farField.group.traverse((o) => {
    const m = o.name.match(/^ops-garage-(.+)-L(\d)-\d+$/)
    if (!o.isInstancedMesh || !m) return
    ;(m[2] === '0' ? near : far).set(m[1], o)
  })
  const ids = [...near.keys()]
  const glbIds = keys.map((k) => k.slice(k.lastIndexOf('/') + 1))
  const missing = glbIds.filter((id) => !near.has(id))
  check(missing.length === 0, `--glb: the pack prototypes are the near level: ${glbIds.join(', ')}${missing.length ? ` — missing: ${missing.join(', ')}` : ''}`)
  const tall = []
  for (const [id, m] of near) {
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox()
    const h = m.geometry.boundingBox.max.y - m.geometry.boundingBox.min.y
    if (h > 2.9) tall.push(`${id} ${h.toFixed(2)}`)
  }
  check(tall.length === 0, `--glb: every equipment prototype ≤ 2.9 m tall (${ids.length} prototypes${tall.length ? `; too tall: ${tall.join(', ')}` : ''})`)
  const procIds = ['roll-cabinet', 'shelves', 'crate', 'monitor-wall']
  const farMissing = procIds.filter((id) => !far.has(id))
  check(farMissing.length === 0, `--glb: the procedural stand-ins are the far level: ${procIds.join(', ')}${farMissing.length ? ` — missing: ${farMissing.join(', ')}` : ''}`)
}

// --- the built scene ------------------------------------------------------------------------------------
/** the v1 meshes the three builders leave under env.group, by name → expected count */
const V1_NAMES = {
  // pit-building.ts (v2, I1-b): the names the plan lists, plus the 1F paddock face kept from v1 until commit 3
  pitShell: 1, pitShellSoffit: 1, pitCanopy: 1, pitGlass: 1, pitRailGlass: 1, pitInterior: 1, pitInteriorCeiling: 1, pitInteriorWalls: 1, pitFascia: 1, pitSoffit: 1, pitShutters: 1, pitPlates: 1, pitPodiumDoor: 1, pitStairTowers: 1,
  controlPod: 1, controlPodGlass: 1, controlPodSign: 1, pitDarkGlass: 1, t1Nose: 1, t1NoseGlass: 1, pitScreens: 1,
  // pit-lane.ts
  pitWall: 1, pitWallBoards: 1, pitWallBoardsLane: 1, pitDebrisFence: 1, leaderTowerLattice: 1, leaderTowerName: 1, leaderTowerBoard: 1,
  // both: the building's railings and the wall's top ribbon / fence rail (same name, same material)
  pitRails: 2,
  // paddock.ts (the v1 tents and transporters went with I3-b: ops-vehicles.ts)
  paddockBuildings: 1, paddockRoofs: 1, flagPoles: 1,
}
/** the I1-a facts of the scene: the v1 meshes are there, finite and on the road plane's side of the ground */
for (const tier of tiers) {
  console.log(`\npit-smoke: tier ${tier}`)
  const t0 = performance.now()
  const scene = await buildScene({ tier })
  console.log(`  built + drained in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
  const { env, track } = scene
  await commonChecks(scene, check, { buildKeys: ['pit', 'pitLane', 'paddock'], rootPrefix: /^(ops|infield|pit)-/ })
  const byName = new Map()
  for (const o of env.group.children) if (o.isMesh || o.isInstancedMesh) byName.set(o.name, [...(byName.get(o.name) ?? []), o])
  // names
  const missing = Object.entries(V1_NAMES).filter(([n, c]) => (byName.get(n)?.length ?? 0) !== c)
  check(missing.length === 0, `v1 meshes under env.group: ${Object.keys(V1_NAMES).length} names${missing.length ? ` — wrong: ${missing.map(([n, c]) => `${n} (${byName.get(n)?.length ?? 0} ≠ ${c})`).join(', ')}` : ''}`)
  const instanced = ['pitSeats', 'pitRailPosts', 'pitColumns', 'pitDoorLeaves', 'pitRearColumns', 'pitInteriorBands', 'teamOffices']
  // the bucketed sets carry a '-<bay>' suffix per 60 m bay
  const noInst = instanced.filter((n) => ![...byName.entries()].some(([k, ms]) => (k === n || k.startsWith(`${n}-`)) && ms.some((o) => o.isInstancedMesh)))
  check(noInst.length === 0, `instanced sets: ${instanced.length}${noInst.length ? ` — missing: ${noInst.join(', ')}` : ''}`)
  // vertices: finite, and never more than 0.5 m under the road plane at their (s, lateral)
  const pitMeshes = [...byName.entries()].filter(([n]) => /^(pit|controlPod|garage|podium|leaderTower|paddock|flag|perch|parking|parkedCars)/.test(n)).flatMap(([, ms]) => ms)
  const fv = finiteVertices(pitMeshes)
  check(fv.nan === 0, `${pitMeshes.length} pit / paddock meshes, ${fmt(fv.vertices)} vertices, no NaN / infinite (${fv.nan})`)
  const tris = pitMeshes.reduce((a, m) => a + trisOf(m), 0)
  console.log(`  note pit / paddock triangles ${fmt(tris)}`)
  {
    // the swept body: sample the shell's vertices against the road plane under them
    const shell = byName.get('pitShell')[0]
    const p = shell.geometry.attributes.position
    let below = 0, n = 0
    const road = new THREE.Vector3()
    for (let i = 0; i < p.count; i += 7) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i)
      const hit = track.nearestOnRange(x, z, 5540, 110)
      if (!hit) continue
      n++
      track.pointAt(hit.s, hit.lateral, road, 0)
      if (y < road.y - 0.5) below++
    }
    check(below === 0, `pitShell: ${n} sampled vertices, none more than 0.5 m under the road plane (${below})`)
  }
  // one shared material object per name (pitMaterials memo): the wall's rails and the building's rails share railMat
  const rails = byName.get('pitRails')
  check(rails.length === 2 && rails[0].material === rails[1].material, 'the two pitRails meshes share one material (pitMaterials(ctx) memo)')
  const roofs = byName.get('paddockRoofs')[0], pitCanopy = byName.get('pitCanopy')[0]
  check(roofs.material === pitCanopy.material, 'paddockRoofs and pitCanopy share buildingRoofMat')
  checkBuilding(scene, check, byName)
  // the wall-top signs are not free-standing boxes: nothing of the props buckets stands at (5556…5562, −9.4) above the wall top
  const wallTop = spec.PIT_WALL.wallTop
  const props = [...byName.entries()].filter(([n]) => n === 'props').flatMap(([, ms]) => ms)
  let boardsOnWall = 0
  const road = new THREE.Vector3()
  for (const m of props) {
    const p = m.geometry.attributes.position
    for (let i = 0; i < p.count; i += 3) {
      const hit = track.nearestOnRange(p.getX(i), p.getZ(i), 5550, 5570)
      if (!hit) continue
      if (Math.abs(hit.lateral - spec.PIT_WALL.lateral) < 0.5 && hit.s > 5554 && hit.s < 5565) {
        track.pointAt(hit.s, hit.lateral, road, 0)
        if (p.getY(i) > road.y + wallTop + 0.1) boardsOnWall++
      }
    }
  }
  check(boardsOnWall === 0, `no free-standing sign box above the wall top at s 5554–5565 (structures.ts skips mount pitWallTop; ${boardsOnWall} vertices)`)
  // the apron reaches 0.4 m past the shutter line: no grass between the blue band and the garage
  // floor at any pit station (the apron edge sat 0.4 m BEFORE the shutters, I1 review F1)
  {
    const { plan } = scene
    const shutter = spec.PIT_PLANNED.shutter
    const bad = []
    for (let s = 5590; s <= 5807 + 88; s += 7) {
      const ss = track.wrap(s)
      const hw = track.halfWidthAt(ss)
      for (const lat of [spec.PIT_WALL.blueBand.lat[0] - 0.1, shutter + 0.1, shutter - 0.1, shutter - 0.35]) {
        const o = plan.ownerAtSL(ss, -1, -lat - hw).name
        if (o !== 'pitApron') bad.push(`s ${ss.toFixed(0)} lat ${lat.toFixed(2)}: ${o}`)
      }
    }
    check(bad.length === 0, `pitApron owns lateral ${spec.PIT_WALL.blueBand.lat[0]} → ${shutter - 0.4} along the garage row 5590→88 (${bad.length} misses${bad.length ? `: ${bad.slice(0, 3).join('; ')}` : ''})`)
  }
  checkLane(scene, check, byName)
}

// ================================================================ I1-c — the pit lane (pit-lane.ts)
/**
 * The lane's own facts (plan I1-c): the v2 names exist; the hoop count follows the table
 * (⌊forwardDelta(concrete) / pitch⌋ ± 1); the blue band is a decal on LAYER.pit.band with no bare
 * ground under it; every pit* / concretePit* vertex is finite and ≥ 0.5 m under the road plane at
 * worst; the sim's envelope holds — nothing of the lane stands inside lateral (−19.1, −11.5)
 * along the box strip (the wall-side furniture stays at ≥ −11.5) and nothing at all inside the
 * chase-lens columns s [boxS − 13, boxS − 9] × lat [−25, −22] of every block — from the real
 * vertices / instance boxes; the wall-top signs stand over the white block; the W-beams stay in
 * their sections; the start gantry has its 5 × 4 lamps and the 5 column materials the race lights.
 */
function checkLane(scene, check, byName) {
  const { env, track, trackMeshes } = scene
  const L = track.length
  const W = spec.PIT_WALL
  const fwd = (a, b) => ((b - a) % L + L) % L
  const inArc = (s, [a, b]) => fwd(a, s) <= fwd(a, b)
  const names = ['pitWall', 'pitWallBlock', 'pitWallBoards', 'pitWallBoardsLane', 'pitWallSigns', 'pitDebrisFence', 'concretePitKerb', 'concretePitWalkway', 'concretePitPlatform', 'pitRostrum', 'pitRostrumWindow', 'pitRostrumPanel', 'pitWBeam', 'pitBlueBand', 'pitCabinets', 'pitSteel']
  const missing = names.filter((n) => (byName.get(n)?.length ?? 0) !== 1)
  check(missing.length === 0, `lane meshes: ${names.length} names${missing.length ? ` — missing / duplicated: ${missing.join(', ')}` : ''}`)
  const setsOf = (prefix) => [...byName.entries()].filter(([k, ms]) => k.startsWith(`${prefix}-`) && ms.some((o) => o.isInstancedMesh)).flatMap(([, ms]) => ms)
  const hoops = setsOf('pitHoops')
  const hoopCount = hoops.reduce((a, m) => a + m.count, 0)
  const expected = Math.floor(fwd(W.concrete[0], W.concrete[1]) / W.hoops.pitch)
  check(Math.abs(hoopCount - expected) <= 1 && hoops.length >= 2, `hoops: ${hoopCount} instances in ${hoops.length} bays = ⌊${fwd(W.concrete[0], W.concrete[1]).toFixed(0)} / ${W.hoops.pitch}⌋ ${expected} ± 1 (prototype ${trisOf({ geometry: hoops[0]?.geometry, isInstancedMesh: false })} tris)`)
  const fencePosts = [...setsOf('pitFencePosts'), ...setsOf('pitFencePostsTall')]
  const wPosts = setsOf('pitWBeamPosts')
  check(fencePosts.length >= 2 && wPosts.length >= 2, `instanced posts: fence ${fencePosts.reduce((a, m) => a + m.count, 0)} in ${fencePosts.length} bays, W-beam ${wPosts.reduce((a, m) => a + m.count, 0)} in ${wPosts.length} bays`)
  // the blue band
  const band = byName.get('pitBlueBand')?.[0]
  const decal = band?.userData.decal
  // uncovered is the clipper's float residue at the quads' corners on the lane / apron edge (µm²), not bare ground
  check(!!decal && decal.uncovered < 1e-3 && Math.abs(decal.rung - 0.012) < 1e-9 && Array.isArray(band.material) && band.material.length === 2, `pitBlueBand: decal on LAYER.pit.band (${decal?.rung} m), ${decal?.area.toFixed(0)} m², uncovered ${decal?.uncovered.toExponential(1)} m² (< 1e-3), ${Array.isArray(band?.material) ? band.material.length : 1} material groups`)
  // every lane vertex: finite, on the road plane's side of the ground, outside the envelope
  // the lane's own meshes (the building's are I1-b's smoke): the names above and the instanced sets
  const lanePrefix = /^(pitHoops-|pitFencePosts|pitWBeamPosts-)/
  const laneMeshes = [...byName.entries()].filter(([n]) => (names.includes(n) || lanePrefix.test(n)) && n !== 'pitBlueBand').flatMap(([, ms]) => ms)
  const road = new THREE.Vector3(), v = new THREE.Vector3(), m4 = new THREE.Matrix4()
  const [S0, S1] = spec.PIT_BOX_STRIP
  const lens = spec.PIT_ENVELOPE.chaseLens
  const stop = spec.PIT_ENVELOPE.stop
  let below = 0, inLane = 0, inLens = 0, n = 0, nan = 0
  const offenders = new Set()
  const test = (x, y, z, name) => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) { nan++; return }
    const hit = track.nearestOnRange(x, z, 5530, 135)
    if (!hit || hit.d > 40) return
    n++
    track.pointAt(hit.s, hit.lateral, road, 0)
    if (y < road.y - 0.5) { below++; offenders.add(`${name} (below)`) }
    const s = track.wrap(hit.s)
    if (inArc(s, [S0, S1]) && hit.lateral < -11.5 - 1e-3 && hit.lateral > -19.1) { inLane++; offenders.add(`${name} (lane ${hit.lateral.toFixed(2)} at s ${s.toFixed(1)})`) }
    for (const boxS of spec.GARAGE_CENTRES) {
      if (inArc(s, [boxS - lens.columnS[0], boxS - lens.columnS[1]]) && hit.lateral >= stop - lens.halfLat && hit.lateral <= stop + lens.halfLat) { inLens++; offenders.add(`${name} (lens column of ${boxS})`) }
    }
  }
  for (const m of laneMeshes) {
    m.updateWorldMatrix(true, false)
    const p = m.geometry.attributes.position
    if (!p) continue
    if (m.isInstancedMesh) {
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox()
      const bb = m.geometry.boundingBox
      for (let i = 0; i < m.count; i++) {
        m.getMatrixAt(i, m4)
        m4.premultiply(m.matrixWorld)
        for (const cx of [bb.min.x, bb.max.x]) for (const cy of [bb.min.y, bb.max.y]) for (const cz of [bb.min.z, bb.max.z]) {
          v.set(cx, cy, cz).applyMatrix4(m4)
          test(v.x, v.y, v.z, `${m.name}[${i}]`)
        }
      }
    } else {
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld)
        test(v.x, v.y, v.z, m.name)
      }
    }
  }
  check(nan === 0 && below === 0, `${laneMeshes.length} lane meshes, ${fmt(n)} vertices / instance corners near the straight: finite (${nan} NaN), none > 0.5 m under the road plane (${below})`)
  check(inLane === 0, `sim envelope: nothing inside lateral (−19.1, −11.5) along the box strip ${S0}→${S1} (${inLane} vertices${inLane ? `: ${[...offenders].filter((o) => o.includes('lane')).slice(0, 4).join(', ')}` : ''})`)
  check(inLens === 0, `chase-lens columns s [boxS − ${lens.columnS[0]}, boxS − ${lens.columnS[1]}] × lat ${stop} ± ${lens.halfLat} of ${spec.GARAGE_CENTRES.length} blocks: empty (${inLens} vertices${inLens ? `: ${[...offenders].filter((o) => o.includes('lens')).slice(0, 4).join(', ')}` : ''})`)
  // the wall-top signs stand over the white block, above the wall
  {
    const signs = byName.get('pitWallSigns')?.[0]
    let ok = !!signs, lo = Infinity, hi = -Infinity, sMin = Infinity, sMax = -Infinity
    if (signs) {
      const p = signs.geometry.attributes.position
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i).applyMatrix4(signs.matrixWorld)
        const hit = track.nearestOnRange(v.x, v.z, 5540, 5580)
        track.pointAt(hit.s, hit.lateral, road, 0)
        const dy = v.y - road.y
        lo = Math.min(lo, dy); hi = Math.max(hi, dy); sMin = Math.min(sMin, hit.s); sMax = Math.max(sMax, hit.s)
        if (Math.abs(hit.lateral - W.lateral) > 1.5) ok = false
      }
      ok = ok && lo >= W.wallTop + W.signPost - 1e-3 && sMin >= W.concrete[0] - 1 && sMax <= W.concrete[0] + W.whiteBlock + 1
    }
    check(ok, `pitWallSigns: over the white block s ${sMin.toFixed(1)}–${sMax.toFixed(1)} (${W.concrete[0]} + ${W.whiteBlock}), y ${lo.toFixed(2)}–${hi.toFixed(2)} above the road (wall top ${W.wallTop} + posts ${W.signPost})`)
    // ... and their posts stand ON the wall: every pitSteel vertex at the wall top's height in
    // s 5554–5566 lies inside the wall's footprint (the FIRE STATION posts hung 0.6 m outside it, I1 review F5)
    const steelM = byName.get('pitSteel')?.[0]
    let postN = 0, postOff = 0
    if (steelM) {
      const p = steelM.geometry.attributes.position
      const half = W.wallWidth / 2
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i).applyMatrix4(steelM.matrixWorld)
        const hit = track.nearestOnRange(v.x, v.z, 5540, 5580)
        if (!hit || hit.s < 5554 || hit.s > 5566 || Math.abs(hit.lateral - W.lateral) > 2) continue
        track.pointAt(hit.s, hit.lateral, road, 0)
        if (Math.abs(v.y - road.y - W.wallTop) > 0.02) continue
        postN++
        if (Math.abs(hit.lateral - W.lateral) > half) postOff++
      }
    }
    check(postN > 0 && postOff === 0, `pitWallSigns posts: ${postN} base vertices at the wall top in s 5554–5566, all inside lateral ${W.lateral} ± ${W.wallWidth / 2} (${postOff} outside)`)
  }
  // the W-beams stay in their sections
  {
    const wb = byName.get('pitWBeam')?.[0]
    let out = 0, cnt = 0
    if (wb) {
      const p = wb.geometry.attributes.position
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i).applyMatrix4(wb.matrixWorld)
        const hit = track.nearestOnRange(v.x, v.z, 5530, 135)
        cnt++
        if (!W.wBeam.some(([a, b]) => inArc(track.wrap(hit.s), [a - 0.5, b + 0.5]))) out++
      }
    }
    check(!!wb && out === 0, `pitWBeam: ${cnt} vertices inside ${W.wBeam.map(([a, b]) => `${a}→${b}`).join(' / ')} (${out} outside)`)
  }
  // the start gantry v2: 5 lamp columns × 4 rows, the top two rows on the race's materials
  {
    const g = trackMeshes.group.getObjectByName('startGantry')
    const lamps = g ? g.children.filter((o) => o.isMesh && o.geometry?.type === 'SphereGeometry') : []
    const mats = trackMeshes.startLampMaterials
    const onRace = lamps.filter((l) => mats.includes(l.material)).length
    check(!!g && lamps.length === 20 && mats.length === 5 && onRace === 10, `startGantry: ${lamps.length} lamps (5 × 4), ${mats.length} column materials, ${onRace} lamps on them (the top two rows)`)
    const boxes = g ? g.children.filter((o) => o.isMesh && o.geometry?.type === 'BoxGeometry') : []
    const banner = boxes.find((b) => Array.isArray(b.material))
    check(!!banner && Math.abs(banner.geometry.parameters.height - 2.0) < 1e-9 && Math.abs(banner.position.y - 8.85) < 1e-9, `startGantry banner: ${banner?.geometry.parameters.width.toFixed(1)} × ${banner?.geometry.parameters.height} at ${banner?.position.y}`)
  }
  check(Number.isFinite(env.buildMs?.pitLane), `buildMs.pitLane = ${Number(env.buildMs?.pitLane).toFixed(0)} ms`)
}
// ================================================================ end I1-c

// ======================================================================== the GLB path (I1-b)
if (glb) {
  console.log('\npit-smoke: --glb (high tier, stub registry)')
  await checkBuildingGlb(check)
}

finish()
