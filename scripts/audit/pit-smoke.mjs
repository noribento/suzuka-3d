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
 *  TODO(I1-b / I1-c): the garage blocks (12, GARAGE_CENTRES), the 2F / 3F decks and the canopy,
 *        pitPlates / pitDoorLeaves / pitHoops counts from the tables, the LAYER.pit.band decals,
 *        the chase-lens column, the stair towers' top 17.0, the interior props' bbox.
 *
 *   node scripts/audit/pit-smoke.mjs [--tier high|low|both] [--glb]
 *
 * `--glb` is reserved for the phase's GLB path (stub-registry.mjs, like furniture-smoke --glb).
 * Exit 1 on any failure.
 */
import path from 'node:path'
import { buildScene, ROOT, THREE } from './app-runtime.mjs'
import { commonChecks, finiteVertices, fmt, smokeArgs, trisOf } from './smoke-common.mjs'

const { tiers, check, finish, glb } = smokeArgs('pit-smoke')
if (glb) console.log('--glb: no GLB path in this smoke yet (the phase adds it)')

const spec = await import(path.join(ROOT, 'app/data/suzuka-facilities-spec.ts'))
const bar = await import(path.join(ROOT, 'app/data/suzuka-barriers-spec.ts'))
const em = await import(path.join(ROOT, 'app/three/emissive.ts'))

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
  check(w.height === 1.05 && w.fenceHeight === 2.2, `PIT_WALL v1 keys kept for the v1 builder (height ${w.height}, fence ${w.fenceHeight})`)
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
  check(pad?.facing === 'paddock' && pad.s === 5738 && pad.lateral === -50 && pad.base === 15 && pad.width === 9 && pad.height === 4 && pad.faces === 1, `pit_paddock: 9 × 4 at (5738, −50), base 15, facing the paddock`)
  // the medical centre row became the course-vehicle base
  const cvb = spec.BUILDINGS.find((b) => b.id === 'course_vehicle_base')
  check(!!cvb && cvb.osmWay === 184429429 && cvb.height === 5 && cvb.builder === 'paddock' && !spec.BUILDINGS.some((b) => b.id === 'medical_centre'), `BUILDINGS course_vehicle_base (way ${cvb?.osmWay}, h ${cvb?.height}) replaces medical_centre`)
  // emissive rows
  const E = em.EMISSIVE
  const lum = (row) => em.luminance(row.color, row.intensity)
  check(E.garageWash?.color === 0xfff2dd && Math.abs(E.garageWash.intensity - 0.8) < 1e-9, `EMISSIVE.garageWash 0xfff2dd × 0.8 (luminance ${lum(E.garageWash).toFixed(2)})`)
  check(E.opsMonitor?.color === 0x9fc4ff && Math.abs(E.opsMonitor.intensity - 0.9) < 1e-9, `EMISSIVE.opsMonitor 0x9fc4ff × 0.9 (luminance ${lum(E.opsMonitor).toFixed(2)})`)
  check(lum(E.garageWash) < em.BLOOM_THRESHOLD && lum(E.opsMonitor) < em.BLOOM_THRESHOLD, `both under the bloom threshold ${em.BLOOM_THRESHOLD} (lit, no halo)`)
}

// --- the built scene ------------------------------------------------------------------------------------
/** the v1 meshes the three builders leave under env.group, by name → expected count */
const V1_NAMES = {
  // pit-building.ts
  pitShell: 1, pitRoof: 1, pitGlass: 1, pitInterior: 1, pitFascia: 1, pitRear: 1, controlPod: 1, garageDoors: 1, podiumBackdrop: 1, pitScreens: 1,
  // pit-lane.ts
  pitWall: 1, pitWallBoards: 1, pitWallBoardsLane: 1, pitDebrisFence: 1, leaderTowerLattice: 1, leaderTowerName: 1, leaderTowerBoard: 1,
  // both: the building's railings and the wall's top ribbon / fence rail (same name, same material)
  pitRails: 2,
  // paddock.ts
  paddockBuildings: 1, paddockRoofs: 1, tents: 1, tentsRed: 1, flagPoles: 1,
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
  const instanced = ['pitSeats', 'pitRailPosts', 'garageWalls', 'pitBoards', 'perchCanopies', 'perchBacks', 'transporters', 'parkingLines', 'parkedCars']
  // the bucketed sets carry a '-<bay>' suffix per 60 m bay
  const noInst = instanced.filter((n) => ![...byName.entries()].some(([k, ms]) => (k === n || k.startsWith(`${n}-`)) && ms.some((o) => o.isInstancedMesh)))
  check(noInst.length === 0, `instanced sets: ${instanced.length}${noInst.length ? ` — missing: ${noInst.join(', ')}` : ''}`)
  // vertices: finite, and never more than 0.5 m under the road plane at their (s, lateral)
  const pitMeshes = [...byName.entries()].filter(([n]) => /^(pit|controlPod|garage|podium|leaderTower|paddock|tents|flag|perch|transporters|parking|parkedCars)/.test(n)).flatMap(([, ms]) => ms)
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
  const roofs = byName.get('paddockRoofs')[0], pitRoof = byName.get('pitRoof')[0]
  check(roofs.material === pitRoof.material, 'paddockRoofs and pitRoof share buildingRoofMat')
  // screens: the faces of the rows the v1 builder mounts (roof rows above the v1 roof, all ground rows)
  const ROOF = spec.PIT_BUILDING.roofTop
  const drawn = spec.SCREENS.filter((s) => s.mount === 'ground' || s.base >= ROOF + 0.3)
  const faces = drawn.reduce((a, s) => a + s.faces, 0)
  const screens = byName.get('pitScreens')[0]
  check(trisOf(screens) === faces * 2, `pitScreens: ${trisOf(screens)} tris = ${faces} faces × 2 (${drawn.length} of ${spec.SCREENS.length} rows; pit_paddock waits for the v2 canopy)`)
  // the wall-top signs are not free-standing boxes: nothing of the props buckets stands at (5556…5562, −9.4) above the wall top
  const wallTop = spec.PIT_WALL.height + 0.5
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
}

finish()
