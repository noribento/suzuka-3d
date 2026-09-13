import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { cameraSlots, type TvTowerSlotInput } from '~/data/ops-spec'
import { TV_CAMERAS, type TvTowerKind } from '~/data/suzuka-barriers-spec'
import type { EnvBuildContext } from './environment'
import { buildOpsFigures } from './figures'
import type { TracksideStats } from './infield'
import { registerPropSet, type PropSet } from './infield-lod'
import { latticeParts } from './lattice'
import { pbrFromAssets } from './materials'
import { figureToWorld } from './ops-people'
import { frameAt } from './pit-geometry'
import { glbOr, procProp, propMaterial, type PropProto } from './props-pack'
import { CRANE_JIB, TV_DECK_HALF, TV_LENS, TV_TOWER_FOOTPRINT, towerBaseAt, towerLateralAt, tvForwardOf, tvLensAt, type TvLens } from './tv-lens'

/**
 * The TV camera towers (plan I4-b): one tower per TV_CAMERAS row, drawn where tv-lens.ts puts
 * the lens — the rig (`cameras.ts setTvCameras`) looks from `group.userData.tvLenses`, so the
 * platform, its rails and its camera are what the other cameras see at the lens point, and the
 * lens itself overhangs the deck's front edge by `TV_LENS.overhang` (`tvForwardOf`: the camera
 * head sits on the front rail, its rear over the deck edge), `TV_LENS.deckDrop` above the deck —
 * so the deck edge, the rail posts and the kick plate are all behind the rig's NEAR 0.5 whatever
 * the pitch. Kinds:
 *  - scaffold — the tubular tower behind the fence: a square lattice (lattice.ts, braces on
 *    `quality.fence`) to the deck's underside, a 2.4 × 2.4 grating deck (MetalWalkway012 PBR,
 *    steel without the pack), 1.1 m rails with a kick plate (the front face's mid post split
 *    into two either side of the camera bay), a ladder on the back face, a camera on a tripod
 *    inside the front rail with its head over it;
 *  - lattice — the tall steel tower (b-tower, 22 m): a heavier lattice, a 3 × 3 deck and rails;
 *  - crane — the yellow camera column (hairpin.jpg): a 1.5 m base plate, a φ0.5 column, a 4 m jib
 *    at 25° towards the track with the camera head under its tip and a counterweight behind;
 *  - pole — the v1 mast (a tapered cylinder with a camera box; no row uses it today).
 * The camera head is its own prop set (`props_security_camera_01` behind `glbOr`, the box +
 * hood procedural) so the pack's model is the near level; the towers are procedural (the
 * scaffold drop of the plan was never made). Every tower is a building-class object: one
 * InstancedMesh per prototype and 250 m cell through `registerPropSet(ctx, 'infield',
 * 'infield-towers', …)`, casting on the near level with `quality.farField.shadows`, cut at
 * `TOWER_LOD_M`. One camera operator per platform / crane (ops-spec `cameraSlots`, role
 * photographer, `infield-towers-crew`). A keep-out disc under each tower keeps the trackside
 * scatter off it. A platform on a sloped site (the 200R bank) stands on its HIGHEST corner
 * (`towerBaseAt`: the max of `ground.standAt` under the four legs — the lens reads the same
 * base) and every lower leg gets a footing box down to its own ground (`towerFootings`), so
 * no leg floats. Publishes `group.userData.tvLenses` (the lens rows, `TvLens`) and
 * `group.userData.trackside.towers`; `stats.trackside.towers` = TV_CAMERAS.length.
 */

/** the towers stop drawing beyond this (m, before `farField.lodScale`): a 22 m lattice reads to ≈ 700 m */
const TOWER_LOD_M = 700
/** the base plate of a crane (m): the operator stands on it */
const CRANE_BASE_H = 0.3
/** the camera head: body (w × h × d) and the lens hood */
const CAMERA = { w: 0.5, h: 0.35, d: 0.6, hood: 0.1, hoodR: 0.08 }
/** the front rail's mid posts stand this far either side of the camera head (m) */
const CAMERA_BAY = 0.5
/** a leg's footing on a sloped site: the box side per platform kind (m) and the ground drop that earns one */
const FOOTING = { side: { scaffold: 0.06, lattice: 0.12 } as const, minDrop: 0.03 }

type Part = { geometry: THREE.BufferGeometry; material: THREE.MeshStandardMaterial }

const _t = new THREE.Matrix4()
const _p = new THREE.Vector3()
const _r = new THREE.Matrix4()

export function buildTvTowers(ctx: EnvBuildContext): Pick<TracksideStats, 'towers'> {
  const { track, ground, group, quality, assets } = ctx
  const plain = (color: number, roughness = 0.6, metalness = 0.2) => propMaterial(ctx.props, { color, roughness, metalness })
  const box = (w: number, h: number, d: number, material: THREE.MeshStandardMaterial, x = 0, y = 0, z = 0): Part => ({ geometry: new THREE.BoxGeometry(w, h, d).translate(x, y + h / 2, z), material })
  const bar = (a: THREE.Vector3, b: THREE.Vector3, w: number, material: THREE.MeshStandardMaterial): Part => {
    const d = b.clone().sub(a)
    const len = d.length()
    const g = new THREE.BoxGeometry(w, len, w).translate(0, len / 2, 0)
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()))
    g.translate(a.x, a.y, a.z)
    return { geometry: g, material }
  }
  /** a procedural prototype: the parts of one material merged first (one group = one draw per material) */
  const proc = (id: string, parts: Part[]): PropProto => {
    const byMat = new Map<THREE.MeshStandardMaterial, THREE.BufferGeometry[]>()
    for (const p of parts) byMat.set(p.material, [...(byMat.get(p.material) ?? []), p.geometry.index ? p.geometry.toNonIndexed() : p.geometry])
    return procProp(id, [...byMat].map(([material, geos]) => ({ material, geometry: geos.length === 1 ? geos[0]! : mergeGeometries(geos, false)! })))
  }

  // --- materials ---------------------------------------------------------------------------------
  /** galvanised scaffold tube / lattice steel */
  const steel = plain(0x9aa0a6, 0.45, 0.7)
  const dark = plain(0x24272b, 0.6, 0.3)
  const black = plain(0x0e0f11, 0.5, 0.2)
  const alu = plain(0xc9ccd0, 0.35, 0.7)
  const yellow = plain(0xf0b400, 0.6, 0.1)
  const plate = plain(0x4a4d52, 0.7, 0.4)
  // the grating deck: the expanded-mesh photo tile (1 m) over the box's metre UVs, plain steel without the pack
  const grating = assets ? pbrFromAssets(assets, 'metalwalkway012', { fallback: () => steel, handBuiltUv: true, normalScale: 0.6, extra: { color: 0xc8cacc } }) : steel
  const deckPart = (side: number, y: number): Part => {
    const g = new THREE.BoxGeometry(side, 0.05, side).translate(0, y - 0.025, 0)
    const uv = g.getAttribute('uv') as THREE.BufferAttribute
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * side, uv.getY(i) * side)
    return { geometry: g, material: grating }
  }

  // --- the platform's furniture, shared by the scaffold and the lattice --------------------------------
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
  /**
   * rails on the deck's edge: corner + mid posts, a top and a mid rail, a kick plate. The
   * front face (+z, towards the track) has two mid posts at ±CAMERA_BAY instead of one in the
   * middle: the camera head sits over that rail (`tvForwardOf`), its tripod just inside it.
   */
  const rails = (half: number, deckTop: number): Part[] => {
    const out: Part[] = []
    const e = half - 0.05
    const top = deckTop + TV_LENS.rail
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) out.push(bar(V(sx * e, deckTop, sz * e), V(sx * e, top, sz * e), 0.04, steel))
    for (const sx of [-1, 1]) out.push(bar(V(sx * e, deckTop, 0), V(sx * e, top, 0), 0.04, steel))
    out.push(bar(V(0, deckTop, -e), V(0, top, -e), 0.04, steel))
    for (const sx of [-1, 1]) out.push(bar(V(sx * CAMERA_BAY, deckTop, e), V(sx * CAMERA_BAY, top, e), 0.04, steel))
    for (const y of [top, deckTop + TV_LENS.rail / 2]) {
      out.push(bar(V(-e, y, -e), V(e, y, -e), 0.04, steel), bar(V(-e, y, e), V(e, y, e), 0.04, steel))
      out.push(bar(V(-e, y, -e), V(-e, y, e), 0.04, steel), bar(V(e, y, -e), V(e, y, e), 0.04, steel))
    }
    for (const sz of [-1, 1]) out.push(box(2 * e, 0.15, 0.02, steel, 0, deckTop, sz * e))
    for (const sx of [-1, 1]) out.push(box(0.02, 0.15, 2 * e, steel, sx * e, deckTop, 0))
    return out
  }
  /** a ladder up the back face (−z), 0.4 m wide, rungs every 0.3 m */
  const ladder = (half: number, deckTop: number): Part[] => {
    const out: Part[] = []
    const z = -half - 0.12
    for (const x of [-0.2, 0.2]) out.push(bar(V(x, 0, z), V(x, deckTop + 0.9, z), 0.04, alu))
    for (let y = 0.3; y < deckTop; y += 0.3) out.push(bar(V(-0.2, y, z), V(0.2, y, z), 0.025, alu))
    return out
  }
  /**
   * the tripod under the camera head: three legs from the deck (one back, two forward either
   * side — all inside the front rail) to a head plate 0.25 m under the lens height, just
   * inside the front rail at `z`; the head's box overhangs it onto the rail
   */
  const tripod = (deckTop: number, headY: number, z: number): Part[] => {
    const out: Part[] = []
    for (const [x, dz] of [[0, -0.6], [-0.45, -0.15], [0.45, -0.15]] as const) out.push(bar(V(x, deckTop, z + dz), V(0, headY, z), 0.02, alu))
    out.push(box(0.16, 0.04, 0.16, dark, 0, headY - 0.04, z))
    return out
  }
  /** the camera head's base centre along the local +z: its hood front at `tvForwardOf(kind)` */
  const headZ = (kind: TvTowerKind) => tvForwardOf(kind) - CAMERA.d / 2 - CAMERA.hood

  // --- the tower prototypes, one per kind and height ------------------------------------------------
  const protos = new Map<string, PropProto>()
  const towerProto = (kind: TvTowerKind, h: number): PropProto => {
    const key = `${kind}:${h}`
    let proto = protos.get(key)
    if (proto) return proto
    const parts: Part[] = []
    switch (kind) {
      case 'scaffold': {
        // the lattice up to the deck's underside; the deck top is deckDrop under the lens
        const deckTop = h - TV_LENS.deckDrop
        const half = TV_TOWER_FOOTPRINT.scaffold / 2
        for (const g of latticeParts({ height: deckTop - 0.05, baseHalf: half, topHalf: half, panel: 2.0, leg: 0.06, ring: 0.05, brace: 0.04, braces: quality.fence })) parts.push({ geometry: g, material: steel })
        parts.push(deckPart(TV_DECK_HALF.scaffold * 2, deckTop), ...rails(TV_DECK_HALF.scaffold, deckTop), ...ladder(half, deckTop), ...tripod(deckTop, h - CAMERA.h / 2 - 0.05, TV_DECK_HALF.scaffold - 0.1))
        break
      }
      case 'lattice': {
        const deckTop = h - TV_LENS.deckDrop
        const half = TV_TOWER_FOOTPRINT.lattice / 2
        for (const g of latticeParts({ height: deckTop - 0.05, baseHalf: half, topHalf: 1.0, panel: 3, leg: 0.12, ring: 0.08, brace: 0.06, braces: quality.fence })) parts.push({ geometry: g, material: steel })
        // the 3 × 3 deck overhangs the 2 m top: a ring of outriggers under its edge
        const dh = TV_DECK_HALF.lattice
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) parts.push(bar(V(sx * 1.0, deckTop - 0.05, sz * 1.0), V(sx * dh, deckTop - 0.05, sz * dh), 0.06, steel))
        parts.push(deckPart(dh * 2, deckTop), ...rails(dh, deckTop), ...ladder(half, deckTop), ...tripod(deckTop, h - CAMERA.h / 2 - 0.05, dh - 0.1))
        break
      }
      case 'crane': {
        const b = TV_TOWER_FOOTPRINT.crane
        parts.push(box(b, CRANE_BASE_H, b, plate))
        parts.push({ geometry: new THREE.CylinderGeometry(0.25, 0.25, h - CRANE_BASE_H, 12).translate(0, CRANE_BASE_H + (h - CRANE_BASE_H) / 2, 0), material: yellow })
        // the jib towards the track (+z) from the column's top, its tail and the counterweight behind
        const tip = V(0, h + Math.sin(CRANE_JIB.angle) * CRANE_JIB.length, Math.cos(CRANE_JIB.angle) * CRANE_JIB.length)
        parts.push(bar(V(0, h - 0.15, 0), tip, CRANE_JIB.section, yellow))
        parts.push(bar(V(0, h - 0.15, 0), V(0, h - 0.15, -1.2), CRANE_JIB.section, yellow))
        parts.push(box(0.6, 0.5, 0.8, plate, 0, h - 0.75, -0.9))
        parts.push({ geometry: new THREE.CylinderGeometry(0.06, 0.06, 0.5, 8).translate(0, h - 0.4, 0), material: plate })
        // the camera head hangs under the tip on a short yoke
        parts.push(bar(V(0, tip.y - 0.1, tip.z), V(0, tip.y - 0.55, tip.z), 0.05, dark))
        parts.push(box(CAMERA.w, CAMERA.h, CAMERA.d, dark, 0, tip.y - 0.55 - CAMERA.h, tip.z))
        parts.push({ geometry: new THREE.CylinderGeometry(CAMERA.hoodR, CAMERA.hoodR, CAMERA.hood, 10).rotateX(Math.PI / 2).translate(0, tip.y - 0.55 - CAMERA.h / 2, tip.z + CAMERA.d / 2 + CAMERA.hood / 2), material: black })
        break
      }
      case 'pole': {
        parts.push({ geometry: new THREE.CylinderGeometry(0.18, 0.25, h, 8).translate(0, h / 2, 0), material: dark })
        parts.push(box(0.7, 0.5, 1.1, dark, 0, h, 0))
        break
      }
    }
    proto = proc(`tower-${kind}-${h}`, parts)
    protos.set(key, proto)
    return proto
  }
  // the camera head of a platform: the pack's security camera as the near level, the box + hood behind it
  const camProc = proc('tv-camera', [box(CAMERA.w, CAMERA.h, CAMERA.d, dark), { geometry: new THREE.CylinderGeometry(CAMERA.hoodR, CAMERA.hoodR, CAMERA.hood, 10).rotateX(Math.PI / 2).translate(0, CAMERA.h / 2, CAMERA.d / 2 + CAMERA.hood / 2), material: black }])
  const cam = glbOr(ctx, 'model/props/security_camera_01', { id: 'tv-camera-glb', scaleTo: { long: CAMERA.d + CAMERA.hood }, front: 'none' }, camProc)

  // --- the placements ------------------------------------------------------------------------------
  const towerSets = new Map<PropProto, PropSet>()
  const setOf = (proto: PropProto): PropSet => {
    let ps = towerSets.get(proto)
    if (!ps) towerSets.set(proto, (ps = { proto, placements: [], casts: true }))
    return ps
  }
  const camSet: PropSet = { proto: cam, placements: [], ...(cam !== camProc ? { far: camProc } : {}) }
  const lenses: TvLens[] = []
  const towers: { id: string; s: number; lateral: number; tower: TvTowerKind; height: number; x: number; y: number; z: number; deckY: number }[] = []
  const slots: TvTowerSlotInput[] = []
  const footingGeos: THREE.BufferGeometry[] = []
  for (const row of TV_CAMERAS) {
    const lateral = towerLateralAt(track, row)
    const side = lateral < 0 ? -1 : 1
    // the highest corner's ground (tv-lens.ts towerBaseAt — the lens reads the same); the lower legs get footings
    const base = towerBaseAt(track, row, ground.standAt, lateral)
    // the tower's frame: +x = the driver's left, +z = +s; turned so the prototype's front (+z) faces the track
    const m = frameAt(track, row.s, lateral, base, new THREE.Matrix4()).multiply(_r.makeRotationY(-side * Math.PI / 2))
    setOf(towerProto(row.tower, row.height)).placements.push({ m })
    if (row.tower === 'scaffold' || row.tower === 'lattice') {
      // a footing under every leg whose ground (read in the world under the drawn leg) is below the base: from that ground up to the leg's foot
      const w = FOOTING.side[row.tower]
      const half = TV_TOWER_FOOTPRINT[row.tower] / 2
      const originY = new THREE.Vector3().setFromMatrixPosition(m).y
      for (const lx of [-half, half]) for (const lz of [-half, half]) {
        _p.set(lx, 0, lz).applyMatrix4(m)
        const drop = originY - ground.standY(_p.x, _p.z)
        if (drop < FOOTING.minDrop) continue
        footingGeos.push(new THREE.BoxGeometry(w, drop, w).translate(lx, -drop / 2, lz).applyMatrix4(m))
      }
    }
    if (row.tower === 'scaffold' || row.tower === 'lattice') {
      // the camera's lens front at (0, height, tvForwardOf): the head's origin is its base centre, the hood in front
      camSet.placements.push({ m: m.clone().multiply(_t.makeTranslation(0, row.height - CAMERA.h / 2, headZ(row.tower))) })
    }
    const deckY = base + (row.tower === 'crane' ? CRANE_BASE_H : row.height - TV_LENS.deckDrop)
    slots.push({ id: row.id, s: row.s, lateral, tower: row.tower, floorY: deckY })
    const p = new THREE.Vector3().setFromMatrixPosition(m)
    towers.push({ id: row.id, s: track.wrap(row.s), lateral, tower: row.tower, height: row.height, x: p.x, y: p.y, z: p.z, deckY })
    if (row.lens !== false) lenses.push(tvLensAt(track, row, ground.standAt))
    // the trackside scatter keeps off the tower
    ctx.keepOut.push({ x: p.x, z: p.z, r: TV_TOWER_FOOTPRINT[row.tower] / 2 + 3 })
  }
  const levels = { nearM: quality.infield.propsNearM, farM: TOWER_LOD_M }
  registerPropSet(ctx, 'infield', 'infield-towers', [...towerSets.values()], levels, { receiveShadow: true })
  registerPropSet(ctx, 'infield', 'infield-tower-cams', [camSet], levels, { receiveShadow: true })
  if (footingGeos.length) {
    const mesh = new THREE.Mesh(mergeGeometries(footingGeos, false)!, steel)
    for (const g of footingGeos) g.dispose()
    mesh.name = 'towerFootings'
    mesh.receiveShadow = true
    group.add(mesh)
  }
  // one operator per platform / crane, in the photographers' black
  buildOpsFigures(ctx, slots.flatMap(cameraSlots).map((f) => figureToWorld(ctx, f)), 'infield-towers-crew')

  group.userData.tvLenses = lenses
  group.userData.trackside = { ...(group.userData.trackside ?? {}), towers }
  return { towers: TV_CAMERAS.length }
}
