import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { TEAMS } from '~/data/drivers'
import { OPS_VEHICLE_MODELS, placementCorners, vehicleModelOf, vehiclePlacements, type OpsPlacement, type OpsVehicleModel } from '~/data/ops-spec'
import { carBodyGeometry, carBodyMaterial, type CarBody } from './car-bodies'
import { CAR_GLB, carGlbGeometry, carGlbMaterial } from './car-glb'
import type { EnvBuildContext } from './environment'
import { registerPropSet, type PropSet } from './infield-lod'
import { pbrFromAssets, tileMetres } from './materials'
import { modelPrototype } from './model-proto'
import type { OpsPartial } from './ops'
import { frameAt, pitMaterials } from './pit-geometry'
import { glbOr, packProp, procProp, propMaterial, type PropProto } from './props-pack'
import { CAR_PARK } from './vehicles'

/**
 * The ops layer's vehicles and paddock structures (plan I3-b) — everything `vehiclePlacements()`
 * (ops-spec section B) lists, drawn as prop sets on the far-field registry (`registerPropSet`,
 * kind 'ops'):
 *
 *  - `ops-vehicles`: the transporters (white Japanese box trucks — car-bodies.ts 'truck' with a
 *    team-colour band as a second InstancedMesh, `instanceColor`), the 2 t trucks and the vans,
 *    the FIA safety car / medical car / course safety car / SUVs / ambulances / fire tenders /
 *    crane truck / tow truck / tractor. A pack vehicle (the Zhabotinsky drops of misc/ops,
 *    `model/ops/*`; the van is car-glb.ts's `van_h100`) is the near level inside
 *    `Quality.infield.vehiclesNearM`, the procedural car body (`carBodyGeometry` +
 *    `carBodyMaterial`, program `carBody|tint`) the far level to `farField.rangeFar`; the
 *    accents (light bars, the medical car's red band, the course car's black roof, the crane's
 *    boom) are procedural parts drawn on both levels;
 *  - `ops-hospitality`: the eleven two-storey units (procedural: slab, glazed 1F, white 2F
 *    panels with a 1.5 m balcony, external stair — `modular_fire_escape` when the pack has it
 *    and it fits — roof rail) with the team-colour vinyl band and roof logo frame as a coloured
 *    InstancedMesh;
 *  - `ops-tents`: the 3 × 3 gazebos behind the cores and the marquees (walls + a gable roof;
 *    the `tent_canopy` drop, fitted to the marquee's box, as the near roof). Rigid boxes stand
 *    at the lowest of their four ground corners (`placeAt(p, true, 0)`), so the rows keep them
 *    on the lots' flat bands — the I2 relief ring climbs 3.9 m across the B lot's outer ring and
 *    3.2 m across the E lot's, and ops-smoke fails a box whose corners spread more than 0.3 m;
 *  - `ops-containers`: the 20 ft air-freight containers behind the cores (two-high);
 *  - `ops-compound`: the broadcast compound in the E paddock — 40 ft containers (three rows
 *    along s in the paving's flat band), satellite dishes on tripods, generators
 *    (`diesel_generator` / a box), a cable-ramp run, the white pipe fence and its gate.
 *
 * Paint on the GLB vehicles: every part gets car-glb.ts's `carGlbMaterial(map, 'tint')` — the
 * body materials of the drops carry no colour map, so they take a shared 1 × 1 white map (a
 * null map would be another program) and read as pure paint (luma 1 → the instance colour);
 * the photographed parts (tyres, glass, lamps, interiors) are dark and keep their photo. One
 * program, `carGlb|tint`, which the parked cars already compile. Everything else is a plain
 * Standard (colour, or the pbrFromAssets sets paintedmetal010 / facade001 / container_side /
 * plastic013a, procedural colours without the pack) — no new `customProgramCacheKey`.
 *
 * Every placement stands on `ground.standAt` (the paddock plane / the yard; a long box on a
 * slope takes the lowest of its corners so no corner floats); nothing here reads the terrain.
 * Static vehicles never enter the race `models`. Reports `vehicles` (every vehicle / truck /
 * crane row) and `equipment` (the rest).
 */

const _m = new THREE.Matrix4()
const m4 = () => new THREE.Matrix4()
const Q = Math.PI / 2

type Part = { geometry: THREE.BufferGeometry; material: THREE.MeshStandardMaterial }

/** the shared 1 × 1 white map the untextured GLB body materials take (see the module comment) */
let whiteMap: THREE.DataTexture | null = null
function whiteTexture(): THREE.DataTexture {
  if (!whiteMap) {
    whiteMap = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType)
    whiteMap.colorSpace = THREE.SRGBColorSpace
    whiteMap.needsUpdate = true
  }
  return whiteMap
}

/** metre UVs from the positions, per face axis (u, v = the two in-plane axes / tile) — for the pbrFromAssets sets on hand-built boxes */
function metricUv(g: THREE.BufferGeometry, tile: number): THREE.BufferGeometry {
  const pos = g.getAttribute('position'), nrm = g.getAttribute('normal')
  const uv = new Float32Array(pos.count * 2)
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nrm.getX(i)), ny = Math.abs(nrm.getY(i)), nz = Math.abs(nrm.getZ(i))
    let u: number, v: number
    if (nx >= ny && nx >= nz) { u = pos.getZ(i); v = pos.getY(i) } else if (ny >= nz) { u = pos.getX(i); v = pos.getZ(i) } else { u = pos.getX(i); v = pos.getY(i) }
    uv[i * 2] = u / tile
    uv[i * 2 + 1] = v / tile
  }
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  return g
}

/** a non-indexed box w × h × d with its base centre at (x, y, z); `tile` > 0 gives it metre UVs */
function box(w: number, h: number, d: number, x = 0, y = 0, z = 0, tile = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d).toNonIndexed()
  g.translate(x, y + h / 2, z)
  return tile > 0 ? metricUv(g, tile) : g
}

/** a vertical cylinder (pipe / post) of radius r, height h, base at (x, y, z) */
function post(r: number, h: number, x = 0, y = 0, z = 0, segments = 6): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, h, segments).toNonIndexed()
  g.translate(x, y + h / 2, z)
  return g
}

/** a horizontal pipe along local Z from z0 to z1 at (x, y) */
function railZ(r: number, x: number, y: number, z0: number, z1: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, Math.abs(z1 - z0), 6).toNonIndexed()
  g.rotateX(Q)
  g.translate(x, y, (z0 + z1) / 2)
  return g
}

/** a horizontal pipe along local X from x0 to x1 at (y, z) */
function railX(r: number, y: number, z: number, x0: number, x1: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, Math.abs(x1 - x0), 6).toNonIndexed()
  g.rotateZ(Q)
  g.translate((x0 + x1) / 2, y, z)
  return g
}

/** turn a prototype so its longer horizontal side lies along local z (the placement's long side) */
function alongZ(proto: PropProto): PropProto {
  const g = proto.geometry
  if (!g.boundingBox) g.computeBoundingBox()
  const b = g.boundingBox!
  if (b.max.x - b.min.x > b.max.z - b.min.z) {
    g.rotateY(Q)
    g.computeBoundingBox()
    g.computeBoundingSphere()
  }
  return proto
}

/** a procedural prototype from parts, the parts of one material merged first (one group = one draw per material) */
function proc(id: string, parts: Part[], footprint?: PropProto['footprint']): PropProto {
  const byMat = new Map<THREE.MeshStandardMaterial, THREE.BufferGeometry[]>()
  for (const p of parts) byMat.set(p.material, [...(byMat.get(p.material) ?? []), p.geometry.index ? p.geometry.toNonIndexed() : p.geometry])
  return procProp(id, [...byMat].map(([material, geos]) => ({ material, geometry: geos.length === 1 ? geos[0]! : mergeGeometries(geos, false)! })), footprint)
}

/** a vehicle model's prototypes: the pack body (null without the pack), the procedural body, the accents drawn on both levels, the paint */
interface VehicleProto {
  glb: PropProto | null
  body: PropProto
  accents: PropProto[]
  colour: THREE.Color
}

export function buildOpsVehicles(ctx: EnvBuildContext): OpsPartial {
  const { track, ground, quality, assets } = ctx
  const reg = quality.infield.glb ? assets : null
  const pm = pitMaterials(ctx)
  const plain = (color: THREE.ColorRepresentation, roughness = 0.6, metalness = 0.2) => propMaterial(ctx.props, { color, roughness, metalness })
  const placements = vehiclePlacements()

  // --- materials ---------------------------------------------------------------------------------------
  const white = plain(0xf2f2ee, 0.55, 0.15)
  const dark = plain(0x2c2f33, 0.6, 0.3)
  const steel = plain(0x9aa0a6, 0.45, 0.6)
  const rail = pm.railMat
  const concrete = plain(0x9d9b96, 0.9, 0.05)
  const yellow = plain(0xf2c400, 0.5, 0.2)
  const amber = plain(0xff9a1a, 0.4, 0.1)
  const red = plain(0xc8101c, 0.45, 0.2)
  const black = plain(0x121214, 0.5, 0.2)
  const panelTile = tileMetres(reg, 'tex/paintedmetal010/diff', 2)
  const panel = reg ? pbrFromAssets(reg, 'paintedmetal010', { fallback: () => white, handBuiltUv: true, normalScale: 0.5, extra: { color: 0xf2f2ee } }) : white
  const glassTile = tileMetres(reg, 'tex/facade001/diff', 4)
  const glass = reg ? pbrFromAssets(reg, 'facade001', { fallback: () => pm.glassMat, handBuiltUv: true, normalScale: 0.5 }) : pm.glassMat
  const containerTile = tileMetres(reg, 'tex/container_side/diff', 1.94)
  const containerWhite = plain(0xe6e7e3, 0.6, 0.35)
  // the air-cargo / broadcast units are white-grey: container_side's albedo is a green shipping
  // container and a colour multiplier cannot whiten it, so only its corrugation normal + ARM
  // maps over the flat colour (noMap — the program the pit building's white_plaster_02 already compiles)
  const container = reg ? pbrFromAssets(reg, 'container_side', { fallback: () => containerWhite, handBuiltUv: true, normalScale: 0.6, noMap: true, extra: { color: 0xe6e7e3, roughness: 0.6, metalness: 0.35 } }) : containerWhite
  const pvcTile = tileMetres(reg, 'tex/plastic013a/diff', 1)
  const pvcWhite = plain(0xf6f6f2, 0.75, 0.05)
  const pvc = reg ? pbrFromAssets(reg, 'plastic013a', { fallback: () => pvcWhite, handBuiltUv: true, normalScale: 0.4, extra: { color: 0xf6f6f2 } }) : pvcWhite
  const bodyMat = carBodyMaterial()

  // --- placement: the track frame at (s, lateral) on the ground, yawed --------------------------------
  const standAt = (p: OpsPlacement, lowest: boolean): number => {
    let y = ground.standAt(p.s, p.lateral)
    if (lowest) for (const [s, l] of placementCorners(p)) y = Math.min(y, ground.standAt(s, l))
    return y
  }
  const placeAt = (p: OpsPlacement, lowest = false, lift = 0.02, dy = 0): THREE.Matrix4 => {
    const m = frameAt(track, p.s, p.lateral, standAt(p, lowest) + (p.y ?? 0) + lift + dy, m4())
    if (p.yawDeg) m.multiply(_m.makeRotationY((p.yawDeg * Math.PI) / 180))
    return m
  }
  /**
   * A thin row (fence, cable ramp) drawn from its world end to end: `n` pieces of `pitch` metres
   * along the row (the last one scaled to the remainder), each standing on the ground under
   * it. Inside a bend the (s, lateral) rectangle of a row along s is shorter in the world than
   * its `size` says, so the run follows the world chord between the row's two ends.
   */
  const alongRow = (p: OpsPlacement, pitch: number, put: (m: THREE.Matrix4) => void) => {
    const yaw = (p.yawDeg * Math.PI) / 180
    const half = p.size[0] / 2
    const a = track.pointAt(track.wrap(p.s - half * Math.cos(yaw)), p.lateral - half * Math.sin(yaw), new THREE.Vector3(), 0)
    const b = track.pointAt(track.wrap(p.s + half * Math.cos(yaw)), p.lateral + half * Math.sin(yaw), new THREE.Vector3(), 0)
    const len = Math.hypot(b.x - a.x, b.z - a.z)
    const dir = new THREE.Vector3(b.x - a.x, 0, b.z - a.z).divideScalar(len || 1)
    const rot = Math.atan2(dir.x, dir.z)
    let d = 0
    while (d < len - 1e-6) {
      const l = Math.min(pitch, len - d)
      const x = a.x + dir.x * (d + l / 2), z = a.z + dir.z * (d + l / 2)
      const m = m4().makeRotationY(rot)
      if (l < pitch - 1e-6) m.multiply(_m.makeScale(1, 1, l / pitch))
      m.setPosition(x, ground.standY(x, z) + (p.y ?? 0), z)
      put(m)
      d += l
    }
  }

  // ==================================================================== the vehicles
  /** a Zhabotinsky drop as one prototype: every part `carGlb|tint` (the shared white map where a body material has none), nose +X → +Z, `long` metres */
  const packVehicle = (key: string, id: string, long: number): PropProto | null => {
    if (!reg) return null
    const cacheKey = `${key}#${id}`
    const hit = ctx.props.protos.get(cacheKey)
    if (hit !== undefined) return hit
    let out: PropProto | null = null
    const model = modelPrototype(reg, key, { partOf: (mat) => `m:${mat.uuid}`, scaleTo: { long } })
    const glbId = `${id}-glb`
    if (model) {
      const geos: THREE.BufferGeometry[] = []
      const mats: THREE.MeshStandardMaterial[] = []
      for (const part of Object.values(model.parts)) {
        const g = part.geometry
        g.rotateY(-Q)
        const n = g.getAttribute('position').count
        g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(n * 4).fill(1), 4))
        geos.push(g)
        mats.push(carGlbMaterial(part.source?.map ?? whiteTexture(), 'tint') as THREE.MeshStandardMaterial)
      }
      const merged = geos.length === 1 ? geos[0]! : mergeGeometries(geos, true)
      if (merged) {
        if (geos.length > 1) for (const g of geos) g.dispose()
        merged.computeBoundingBox()
        const b = merged.boundingBox!
        merged.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2)
        merged.computeBoundingBox()
        merged.computeBoundingSphere()
        const bb = merged.boundingBox!
        out = { id: glbId, geometry: merged, materials: mats, footprint: { long: bb.max.z - bb.min.z, short: bb.max.x - bb.min.x, height: bb.max.y - bb.min.y }, triangles: model.triangles, source: 'glb' }
      }
    }
    ctx.props.protos.set(cacheKey, out)
    return out
  }
  /** car-glb.ts's van (the paddock's hero minivan): `carGlbGeometry` + `carGlbMaterial(map, 'tint')`, null without the pack or the map */
  const packVan = (): PropProto | null => {
    const spec = CAR_GLB.minivan
    if (!reg || !spec) return null
    const cacheKey = `${spec.key}#ops-van`
    const hit = ctx.props.protos.get(cacheKey)
    if (hit !== undefined) return hit
    let out: PropProto | null = null
    const model = reg.model(spec.key)
    const g = model ? carGlbGeometry(model.scene, 'minivan', spec) : null
    if (g?.map) {
      const bb = g.geometry.boundingBox!
      out = { id: 'van-glb', geometry: g.geometry, materials: [carGlbMaterial(g.map, 'tint', spec.luma, spec.gain) as THREE.MeshStandardMaterial], footprint: { long: bb.max.z - bb.min.z, short: bb.max.x - bb.min.x, height: bb.max.y - bb.min.y }, triangles: g.geometry.getAttribute('position').count / 3, source: 'glb' }
    }
    ctx.props.protos.set(cacheKey, out)
    return out
  }
  /** a procedural car body (car-bodies.ts, nose +Z), optionally scaled to [l, w, h] */
  const procBody = (id: string, kind: CarBody, scale?: [number, number, number]): PropProto => {
    let g = carBodyGeometry(kind)
    if (scale) {
      g = g.clone()
      g.scale(scale[0], scale[1], scale[2])
      g.computeBoundingBox()
      g.computeBoundingSphere()
    }
    return procProp(id, [{ geometry: g, material: bodyMat }])
  }
  /** a roof light bar (amber / red-blue) centred over the roof at height `h` */
  const lightBar = (id: string, h: number, w: number, mat: THREE.MeshStandardMaterial): PropProto =>
    proc(id, [{ geometry: box(w, 0.12, 0.3, 0, h + 0.03, 0.1), material: mat }, { geometry: box(w + 0.1, 0.03, 0.34, 0, h, 0.1), material: dark }])
  const T = { l: 12.0, w: 2.5, h: 3.9 }
  const scaledTruck = (id: string, l: number, w: number, h: number) => procBody(id, 'truck', [w / T.w, h / T.h, l / T.l])
  const S = OPS_VEHICLE_MODELS
  const protos: Record<OpsVehicleModel, VehicleProto> = {
    transporter: (() => {
      // the band: two side plates and the tail plate at door height (2.0 → 2.3), on the box body's skin
      const z0 = -T.l / 2 + 0.3, z1 = T.l / 2 - 2.45 - 0.05, hw = T.w / 2
      const band = proc('transporter-band', [
        { geometry: box(0.02, 0.3, z1 - z0, hw + 0.01, 2.0, (z0 + z1) / 2), material: white },
        { geometry: box(0.02, 0.3, z1 - z0, -hw - 0.01, 2.0, (z0 + z1) / 2), material: white },
        { geometry: box(T.w - 0.3, 0.3, 0.02, 0, 2.0, -T.l / 2 - 0.08), material: white },
      ])
      return { glb: null, body: procBody('transporter', 'truck'), accents: [band], colour: new THREE.Color(S.transporter.tint[0]) }
    })(),
    truck2t: { glb: null, body: scaledTruck('truck2t', 6.0, 2.0, 2.8), accents: [], colour: new THREE.Color(S.truck2t.tint[0]) },
    van: { glb: packVan(), body: procBody('van', 'minivan'), accents: [], colour: new THREE.Color(S.van.tint[0]) },
    fiaSafetyCar: { glb: packVehicle('model/ops/jdm_sport_99', 'fia-sc', 4.7), body: procBody('fia-sc', 'sedan'), accents: [lightBar('fia-sc-bar', 1.36, 1.2, amber)], colour: new THREE.Color(S.fiaSafetyCar.tint[0]) },
    medicalCar: (() => {
      const bandBox = proc('medical-band', [{ geometry: box(1.86, 0.22, 4.3, 0, 0.72, 0.05), material: red }])
      return { glb: packVehicle('model/ops/sigil_07', 'medical', 4.8), body: procBody('medical', 'sedan'), accents: [bandBox, lightBar('medical-bar', 1.42, 1.1, amber)], colour: new THREE.Color(S.medicalCar.tint[0]) }
    })(),
    courseSafetyCar: (() => {
      const glb = packVehicle('model/ops/ace_11', 'course-sc', 4.5)
      const roofY = (glb?.footprint.height ?? 1.5) - 0.05
      const roof = proc('course-sc-roof', [{ geometry: box(1.15, 0.05, 1.3, 0, roofY, -0.2), material: black }])
      return { glb, body: procBody('course-sc', 'hatch'), accents: [roof, lightBar('course-sc-bar', roofY + 0.05, 1.2, amber)], colour: new THREE.Color(S.courseSafetyCar.tint[0]) }
    })(),
    suv: { glb: packVehicle('model/ops/urban_10', 'suv', 4.7), body: procBody('suv', 'suv'), accents: [], colour: new THREE.Color(S.suv.tint[0]) },
    ambulance: { glb: packVehicle('model/ops/shvan_92_ambulance', 'ambulance', 5.3), body: procBody('ambulance', 'minivan', [2.3 / 1.7, 2.5 / 1.85, 5.2 / 4.7]), accents: [], colour: new THREE.Color(S.ambulance.tint[0]) },
    fireTender: { glb: packVan(), body: procBody('fire-tender', 'minivan'), accents: [lightBar('fire-bar', 1.86, 1.2, red)], colour: new THREE.Color(S.fireTender.tint[0]) },
    craneTruck: (() => {
      // the folded boom lies along the bed on a pedestal behind the cab, its head over the tail
      const boom = proc('crane-boom', [
        { geometry: box(0.7, 0.5, 0.7, 0, 1.15, 0.9), material: dark },
        { geometry: box(0.35, 0.35, 4.4, 0, 1.65, -0.9), material: yellow },
        { geometry: box(0.28, 0.28, 1.0, 0, 1.7, -2.6), material: yellow },
      ])
      return { glb: packVehicle('model/ops/lightbody_flatbed', 'crane', 5.5), body: scaledTruck('crane', 5.6, 2.1, 2.6), accents: [boom], colour: new THREE.Color(S.craneTruck.tint[0]) }
    })(),
    towTruck: { glb: packVehicle('model/ops/lightbody_tow', 'tow', 5.9), body: scaledTruck('tow', 6.0, 2.1, 2.7), accents: [lightBar('tow-bar', 2.72, 1.0, amber)], colour: new THREE.Color(S.towTruck.tint[0]) },
    tractor: (() => {
      const parts: Part[] = [
        { geometry: box(1.2, 0.9, 2.2, 0, 0.7, 0.3), material: plain(S.tractor.tint[0], 0.6, 0.3) },
        { geometry: box(1.3, 1.1, 1.3, 0, 1.6, -0.3), material: glass },
        { geometry: box(1.5, 0.08, 1.5, 0, 2.7, -0.3), material: white },
        { geometry: box(0.3, 0.3, 0.3, 0, 0.6, 1.45), material: dark },
      ]
      for (const [x, z, r, w] of [[-0.85, 1.1, 0.45, 0.3], [0.85, 1.1, 0.45, 0.3], [-0.85, -0.9, 0.85, 0.5], [0.85, -0.9, 0.85, 0.5]] as const) {
        const g = new THREE.CylinderGeometry(r, r, w, 12).toNonIndexed()
        g.rotateZ(Q)
        g.translate(x, r, z)
        parts.push({ geometry: g, material: black })
      }
      return { glb: null, body: proc('tractor', parts), accents: [], colour: new THREE.Color(S.tractor.tint[0]) }
    })(),
  }

  const vehicleSets = new Map<string, PropSet>()
  const setOf = (key: string, proto: PropProto, far?: PropProto): PropSet => {
    let s = vehicleSets.get(key)
    if (!s) vehicleSets.set(key, (s = { proto, placements: [], ...(far && far !== proto ? { far } : {}), casts: proto.footprint.height >= 2.5 }))
    return s
  }
  let vehicles = 0, equipment = 0
  for (const p of placements) {
    const model = vehicleModelOf(p.id)
    if (!model || !(p.kind === 'vehicle' || p.kind === 'truck' || p.kind === 'crane')) continue
    const v = protos[model]
    const m = placeAt(p, false, CAR_PARK.lift)
    // the body: the pack prototype as the near level (its far level the procedural body), the colour on both
    const near = v.glb ?? v.body
    setOf(`${model}:body`, near, v.body).placements.push({ m, color: v.colour })
    // the accents (no instance colour: plain materials)
    v.accents.forEach((a, i) => setOf(`${model}:accent${i}`, a).placements.push({ m }))
    // the transporters' band takes the team colour
    if (model === 'transporter' && p.team) {
      const band = vehicleSets.get(`${model}:accent0`)!
      band.placements[band.placements.length - 1]!.color = new THREE.Color(TEAMS[p.team].body)
    }
    vehicles++
  }
  // a band set colours every instance: the plain-white trucks' bands without a team stay white
  registerPropSet(ctx, 'ops', 'ops-vehicles', [...vehicleSets.values()], { nearM: quality.infield.vehiclesNearM, farM: quality.farField.rangeFar, ramp: CAR_PARK.lod.ramp }, { receiveShadow: true })

  // ==================================================================== the hospitality units
  {
    const H = placements.find((p) => p.kind === 'cabin')?.size ?? [10, 7, 6.6]
    const [long, across, height] = H
    const hx = across / 2
    const LV = height / 2 // 3.3: the 1F / 2F storey
    const z0 = -long / 2, z1 = long / 2 - 1.5 // the body; the stair takes the last 1.5 m at +z
    const parts: Part[] = []
    const slab = 0.15
    // the floor slab, the 1F glazing (all four faces), the 1F / 2F slabs
    parts.push({ geometry: box(across, slab, z1 - z0, 0, 0, (z0 + z1) / 2), material: concrete })
    for (const [x0, x1, zz0, zz1] of [[-hx, hx, z0, z0 + 0.02], [-hx, hx, z1 - 0.02, z1], [-hx, -hx + 0.02, z0, z1], [hx - 0.02, hx, z0, z1]] as const) {
      parts.push({ geometry: box(x1 - x0, LV - slab - 0.3, zz1 - zz0, (x0 + x1) / 2, slab, (zz0 + zz1) / 2, glassTile), material: glass })
    }
    parts.push({ geometry: box(across + 0.04, 0.3, z1 - z0 + 0.04, 0, LV - 0.3, (z0 + z1) / 2, panelTile), material: panel }) // the 1F head band
    parts.push({ geometry: box(across, slab, z1 - z0, 0, LV, (z0 + z1) / 2), material: concrete }) // the 2F slab (its front 1.5 m is the balcony deck)
    // the 2F body: white panels set back 1.5 m from the walk side, the roof slab, the roof rail
    parts.push({ geometry: box(across - 1.5, LV - slab, z1 - z0, 0.75, LV + slab, (z0 + z1) / 2, panelTile), material: panel })
    parts.push({ geometry: box(across, slab, z1 - z0, 0, height - slab, (z0 + z1) / 2), material: concrete })
    if (quality.infield.detail) {
      // the balcony rail (walk side + both ends of the balcony strip) and the roof rail
      const bRail: THREE.BufferGeometry[] = [railZ(0.02, -hx + 0.05, LV + slab + 1.05, z0, z1)]
      for (const z of [z0 + 0.05, z1 - 0.05]) bRail.push(railX(0.02, LV + slab + 1.05, z, -hx + 0.05, -hx + 1.5))
      for (let z = z0 + 0.05; z <= z1; z += 1.4) bRail.push(post(0.02, 1.05, -hx + 0.05, LV + slab, Math.min(z, z1 - 0.05)))
      const rRail: THREE.BufferGeometry[] = [railZ(0.02, -hx + 0.05, height + 0.95, z0, z1), railZ(0.02, hx - 0.05, height + 0.95, z0, z1), railX(0.02, height + 0.95, z0 + 0.05, -hx, hx), railX(0.02, height + 0.95, z1 - 0.05, -hx, hx)]
      for (let z = z0 + 0.05; z <= z1; z += 2.0) for (const x of [-hx + 0.05, hx - 0.05]) rRail.push(post(0.02, 0.95, x, height, Math.min(z, z1 - 0.05)))
      parts.push({ geometry: mergeGeometries([...bRail, ...rRail], false)!, material: rail })
    }
    const unitProc = proc('hospitality-unit', parts)
    // the stair: the fire-escape drop when it fits the 1.5 m end strip, else a sloped flight from the ground (+x) up to the balcony (−x)
    const stairProc = (() => {
      const run = across - 1.5, rise = LV + slab
      const len = Math.hypot(run, rise), angle = Math.atan2(rise, run)
      const flight = box(len, 0.25, 1.2, 0, 0, 0)
      flight.rotateZ(angle) // +x end rises… turned so the top is at −x
      flight.rotateY(Math.PI)
      flight.translate(hx - run / 2, rise / 2 - 0.05, z1 + 0.75)
      const landing = box(1.5, 0.12, 1.5, -hx + 0.75, LV + slab - 0.12, z1 + 0.75)
      const rails: THREE.BufferGeometry[] = []
      for (const z of [z1 + 0.15, z1 + 1.35]) for (let k = 0; k <= 4; k++) rails.push(post(0.02, 1.0, hx - (run * k) / 4, ((rise * k) / 4), z))
      return proc('hospitality-stair', [{ geometry: flight, material: steel }, { geometry: landing, material: steel }, { geometry: mergeGeometries(rails, false)!, material: rail }])
    })()
    let stair = glbOr(ctx, 'model/props/modular_fire_escape', { id: 'hospitality-stair-glb', front: 'none', scaleTo: { height: LV + slab } }, stairProc)
    if (stair !== stairProc && (stair.footprint.long > across - 0.2 || stair.footprint.short > 1.5)) stair = stairProc
    // the team-colour vinyl band round the 2F and the roof logo frame: one coloured InstancedMesh
    const bandY = LV + slab + 1.1, bandH = 1.2
    const bandParts: Part[] = [
      { geometry: box(0.03, bandH, z1 - z0 + 0.06, hx + 0.015, bandY, (z0 + z1) / 2), material: white },
      { geometry: box(0.03, bandH, z1 - z0 + 0.06, -hx + 1.5 - 0.015, bandY, (z0 + z1) / 2), material: white },
      { geometry: box(hx - (-hx + 1.5) + 0.06, bandH, 0.03, (hx + (-hx + 1.5)) / 2, bandY, z0 - 0.015), material: white },
      { geometry: box(hx - (-hx + 1.5) + 0.06, bandH, 0.03, (hx + (-hx + 1.5)) / 2, bandY, z1 + 0.015), material: white },
      // the roof frame: a 3 × 1.2 rectangle of 0.06 m bars (along the unit) on two posts at the walk-side roof edge
      { geometry: box(0.06, 0.06, 3.0, 0, height + 1.9, 0, 0), material: white },
      { geometry: box(0.06, 0.06, 3.0, 0, height + 0.7, 0, 0), material: white },
      { geometry: box(0.06, 1.26, 0.06, 0, height + 0.7, -1.5, 0), material: white },
      { geometry: box(0.06, 1.26, 0.06, 0, height + 0.7, 1.5, 0), material: white },
    ]
    for (const p of bandParts.slice(4)) p.geometry.translate(-hx + 0.6, 0, 0)
    const band = proc('hospitality-band', bandParts)
    const units: PropSet = { proto: unitProc, placements: [], casts: true }
    const stairs: PropSet = { proto: stair, far: stairProc, placements: [] }
    const bands: PropSet = { proto: band, placements: [] }
    for (const p of placements) {
      if (p.kind !== 'cabin') continue
      const m = placeAt(p, true, 0.0)
      units.placements.push({ m })
      // the pack stair stands in the +z end strip, its long side (local x after orientPack) across the unit
      const sm = m.clone()
      if (stair !== stairProc) sm.multiply(_m.makeTranslation(0, 0, z1 + 0.75))
      stairs.placements.push({ m: sm })
      bands.placements.push({ m, color: new THREE.Color(p.team ? TEAMS[p.team].body : 0xffffff) })
      equipment++
    }
    registerPropSet(ctx, 'ops', 'ops-hospitality', [units, stairs, bands], { nearM: quality.infield.propsNearM, farM: quality.farField.rangeFar }, { receiveShadow: true })
  }

  // ==================================================================== the tents: gazebos and marquees
  {
    const sets: PropSet[] = []
    // the gazebo: four legs, a pyramid roof (its square footprint = the row's size)
    const gazeboRow = placements.find((p) => p.id.startsWith('gazebo'))
    if (gazeboRow) {
      const [gl, ga, gh] = gazeboRow.size
      const legH = gh - 0.8
      const parts: Part[] = []
      for (const x of [-ga / 2 + 0.05, ga / 2 - 0.05]) for (const z of [-gl / 2 + 0.05, gl / 2 - 0.05]) parts.push({ geometry: post(0.025, legH, x, 0, z), material: rail })
      const roof = new THREE.ConeGeometry(Math.hypot(gl, ga) / 2, 0.8, 4, 1, true).toNonIndexed()
      roof.rotateY(Math.PI / 4)
      roof.translate(0, legH + 0.4, 0)
      parts.push({ geometry: metricUv(roof, pvcTile), material: pvc })
      const valance = new THREE.CylinderGeometry(Math.hypot(gl, ga) / 2, Math.hypot(gl, ga) / 2, 0.25, 4, 1, true).toNonIndexed()
      valance.rotateY(Math.PI / 4)
      valance.translate(0, legH - 0.125, 0)
      parts.push({ geometry: metricUv(valance, pvcTile), material: pvc })
      const gazebo = proc('gazebo', parts)
      const set: PropSet = { proto: gazebo, placements: [], casts: gh >= 2.5 }
      for (const p of placements) if (p.id.startsWith('gazebo')) { set.placements.push({ m: placeAt(p, false, 0.0) }); equipment++ }
      sets.push(set)
    }
    // the marquees: PVC walls + a gable roof (proc) with the tent-canopy drop fitted to the same box as the near roof
    const marqueeProtos = new Map<string, { walls: PropProto; roof: PropProto; roofFar: PropProto }>()
    const marqueeProto = (size: [number, number, number]) => {
      const key = size.join('x')
      let hit = marqueeProtos.get(key)
      if (hit) return hit
      const [ml, ma, mh] = size
      const wallH = mh - 1.5
      const wallParts: Part[] = []
      for (const [x0, x1, zz0, zz1] of [[-ma / 2, ma / 2, -ml / 2, -ml / 2 + 0.03], [-ma / 2, ma / 2, ml / 2 - 0.03, ml / 2], [-ma / 2, -ma / 2 + 0.03, -ml / 2, ml / 2], [ma / 2 - 0.03, ma / 2, -ml / 2, ml / 2]] as const) {
        wallParts.push({ geometry: box(x1 - x0, wallH, zz1 - zz0, (x0 + x1) / 2, 0, (zz0 + zz1) / 2, pvcTile), material: pvc })
      }
      // the gable ends: two triangles above the end walls
      const gable = new THREE.BufferGeometry()
      const tri: number[] = []
      for (const [z, sgn] of [[-ml / 2, -1], [ml / 2, 1]] as const) {
        const a = [-ma / 2, wallH, z], b = [ma / 2, wallH, z], c = [0, mh, z]
        const order = sgn < 0 ? [a, c, b] : [a, b, c]
        for (const v of order) tri.push(v[0]!, v[1]!, v[2]!)
      }
      gable.setAttribute('position', new THREE.Float32BufferAttribute(tri, 3))
      gable.computeVertexNormals()
      wallParts.push({ geometry: metricUv(gable, pvcTile), material: pvc })
      const walls = proc(`marquee-walls-${key}`, wallParts)
      // the roof: two sloped sheets from the eaves (0.25 m past the walls) to the ridge
      const roofGeo = new THREE.BufferGeometry()
      const rv: number[] = []
      // wound so the sheets face up and out
      const quad = (a: number[], b: number[], c: number[], d: number[]) => { for (const v of [a, c, b, a, d, c]) rv.push(v[0]!, v[1]!, v[2]!) }
      const e = ma / 2 + 0.25, ez = ml / 2 + 0.25
      quad([-e, wallH - 0.1, -ez], [0, mh, -ez], [0, mh, ez], [-e, wallH - 0.1, ez])
      quad([0, mh, -ez], [e, wallH - 0.1, -ez], [e, wallH - 0.1, ez], [0, mh, ez])
      roofGeo.setAttribute('position', new THREE.Float32BufferAttribute(rv, 3))
      roofGeo.computeVertexNormals()
      const roofFar = proc(`marquee-roof-${key}`, [{ geometry: metricUv(roofGeo, pvcTile), material: pvc }])
      let roof: PropProto = roofFar
      const canopy = packProp(reg, ctx.props, 'model/ops/tent_canopy', { id: `marquee-canopy-${key}-glb`, nodes: /TentCanopy_0/, front: 'none', origin: 'base' })
      if (canopy) {
        // the drop is a tall canopy (48 × 41 × 18 units): fitted to the marquee's box, long side along z
        const f = canopy.footprint
        const g = canopy.geometry
        const alongX = g.boundingBox!.max.x - g.boundingBox!.min.x >= g.boundingBox!.max.z - g.boundingBox!.min.z
        if (alongX) g.rotateY(Q)
        g.computeBoundingBox()
        const b = g.boundingBox!
        g.scale(ma / (b.max.x - b.min.x), mh / f.height, ml / (b.max.z - b.min.z))
        g.computeBoundingBox()
        g.computeBoundingSphere()
        canopy.footprint = { long: ml, short: ma, height: mh }
        roof = canopy
      }
      hit = { walls, roof, roofFar }
      marqueeProtos.set(key, hit)
      return hit
    }
    const marqueeSets = new Map<PropProto, PropSet>()
    for (const p of placements) {
      if (!p.id.startsWith('marquee')) continue
      const mp = marqueeProto(p.size)
      const m = placeAt(p, true, 0.0)
      let ws = marqueeSets.get(mp.walls)
      if (!ws) marqueeSets.set(mp.walls, (ws = { proto: mp.walls, placements: [], casts: true }))
      ws.placements.push({ m })
      let rs = marqueeSets.get(mp.roof)
      if (!rs) marqueeSets.set(mp.roof, (rs = { proto: mp.roof, far: mp.roofFar, placements: [], casts: true }))
      rs.placements.push({ m })
      equipment++
    }
    sets.push(...marqueeSets.values())
    registerPropSet(ctx, 'ops', 'ops-tents', sets, { nearM: quality.infield.propsNearM, farM: quality.farField.rangeFar }, { receiveShadow: true })
  }

  // ==================================================================== the air-freight containers
  const containerProto = (id: string, size: [number, number, number], tint: THREE.MeshStandardMaterial): PropProto => {
    const [l, w, h] = size
    const parts: Part[] = [{ geometry: box(w, h, l, 0, 0.0, 0, containerTile), material: tint }]
    // the corner posts and the door bars (dark), proud of the skin
    for (const x of [-w / 2, w / 2]) for (const z of [-l / 2, l / 2]) parts.push({ geometry: box(0.12, h + 0.02, 0.12, x, 0, z), material: dark })
    for (const x of [-w / 4, w / 4]) parts.push({ geometry: box(0.05, h - 0.3, 0.05, x, 0.15, -l / 2 - 0.03), material: dark })
    return proc(id, parts)
  }
  {
    const row = placements.find((p) => p.id.startsWith('aircargo'))
    if (row) {
      const set: PropSet = { proto: containerProto('aircargo-20ft', row.size, container), placements: [], casts: row.size[2] >= 2.5 }
      for (const p of placements) if (p.id.startsWith('aircargo')) { set.placements.push({ m: placeAt(p, false, 0.0) }); equipment++ }
      registerPropSet(ctx, 'ops', 'ops-containers', [set], { nearM: quality.infield.propsNearM, farM: quality.farField.rangeFar }, { receiveShadow: true })
    }
  }

  // ==================================================================== the broadcast compound
  {
    const sets: PropSet[] = []
    const bc = placements.filter((p) => p.id.startsWith('bc-'))
    const first = (prefix: string) => bc.find((p) => p.id.startsWith(prefix))
    const cRow = first('bc-container')
    if (cRow) {
      const [l, w, h] = cRow.size
      const unit = containerProto('bc-container', cRow.size, container)
      // an aircon unit and a door on the +z end of every broadcast container
      const fit = proc('bc-container-fit', [
        { geometry: box(0.6, 0.5, 0.35, w / 2 - 0.5, h - 0.7, 0.2), material: steel },
        { geometry: box(0.9, 2.0, 0.04, 0, 0.15, l / 2 + 0.03), material: dark },
      ])
      const set: PropSet = { proto: unit, placements: [], casts: h >= 2.5 }
      const fitSet: PropSet = { proto: fit, placements: [] }
      for (const p of bc) if (p.id.startsWith('bc-container')) { const m = placeAt(p, true, 0.0); set.placements.push({ m }); fitSet.placements.push({ m }); equipment++ }
      sets.push(set, fitSet)
    }
    const dRow = first('bc-dish')
    if (dRow) {
      // the dish: a shallow lathe bowl (φ = the row's long side) tilted 40° up on three legs, a feed arm
      const r = dRow.size[0] / 2
      const pts = [new THREE.Vector2(0.05, 0), new THREE.Vector2(r * 0.5, 0.06), new THREE.Vector2(r * 0.85, 0.2), new THREE.Vector2(r, 0.36)]
      const bowl = new THREE.LatheGeometry(pts, 20).toNonIndexed()
      bowl.rotateX(-Math.PI / 2 + THREE.MathUtils.degToRad(40))
      bowl.translate(0, 1.6, 0.1)
      const parts: Part[] = [{ geometry: bowl, material: propMaterial(ctx.props, { color: 0xf2f2ee, roughness: 0.5, metalness: 0.1, side: THREE.DoubleSide }) }]
      const feed = new THREE.CylinderGeometry(0.03, 0.03, 1.2, 5).toNonIndexed()
      feed.rotateX(-THREE.MathUtils.degToRad(50))
      feed.translate(0, 1.6 + 0.5, 0.1 + 0.4)
      parts.push({ geometry: feed, material: dark })
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * Math.PI * 2
        const leg = new THREE.CylinderGeometry(0.03, 0.03, 1.7, 5).toNonIndexed()
        leg.rotateX(0.35)
        leg.rotateY(a)
        leg.translate(Math.sin(a) * 0.3, 0.8, Math.cos(a) * 0.3)
        parts.push({ geometry: leg, material: dark })
      }
      parts.push({ geometry: box(0.3, 0.3, 0.3, 0, 1.25, 0), material: dark })
      const dish = proc('bc-dish', parts)
      const set: PropSet = { proto: dish, placements: [] }
      for (const p of bc) if (p.id.startsWith('bc-dish')) { set.placements.push({ m: placeAt(p, false, 0.0) }); equipment++ }
      sets.push(set)
    }
    const gRow = first('bc-generator')
    if (gRow) {
      const [l, w, h] = gRow.size
      const genProc = proc('bc-generator', [
        { geometry: box(w, h - 0.4, l, 0, 0.2, 0), material: plain(0x2e3a34, 0.6, 0.35) },
        { geometry: box(w - 0.1, 0.2, l - 0.1, 0, 0, 0), material: dark },
        { geometry: post(0.06, 0.7, w / 4, h - 0.2, -l / 3, 8), material: dark },
        { geometry: box(0.4, 0.3, 0.02, 0, h - 0.9, l / 2 + 0.01), material: steel },
      ])
      const gen = alongZ(glbOr(ctx, 'model/ops/diesel_generator', { id: 'bc-generator-glb', scaleTo: { long: l - 0.2 } }, genProc))
      const set: PropSet = { proto: gen, far: genProc, placements: [] }
      for (const p of bc) if (p.id.startsWith('bc-generator')) { set.placements.push({ m: placeAt(p, false, 0.0) }); equipment++ }
      sets.push(set)
    }
    const rRow = first('bc-cable-ramp')
    if (rRow) {
      // one yellow / black ramp segment per metre of the row, along its long side
      const [, w, h] = rRow.size
      const seg = proc('bc-cable-ramp', [{ geometry: box(w, h, 0.96, 0, 0, 0), material: yellow }, { geometry: box(0.08, h + 0.005, 0.96, 0, 0, 0), material: black }])
      const set: PropSet = { proto: seg, placements: [] }
      alongRow(rRow, 1.0, (m) => set.placements.push({ m }))
      equipment++
      sets.push(set)
    }
    const fRow = first('bc-fence')
    if (fRow) {
      // a 2.5 m pipe-fence panel (a post at −x, two rails to +x), instanced along every row; the last panel is scaled to the remainder
      const panelL = 2.5, fh = fRow.size[2]
      const panelProto = proc('bc-fence-panel', [
        { geometry: post(0.03, fh, 0, 0, -panelL / 2, 6), material: rail },
        { geometry: railZ(0.02, 0, fh - 0.03, -panelL / 2, panelL / 2), material: rail },
        { geometry: railZ(0.02, 0, fh * 0.5, -panelL / 2, panelL / 2), material: rail },
      ])
      const set: PropSet = { proto: panelProto, placements: [] }
      for (const p of bc) {
        if (!(p.id.startsWith('bc-fence') || p.id === 'bc-gate')) continue
        alongRow(p, panelL, (m) => set.placements.push({ m }))
        equipment++
      }
      sets.push(set)
    }
    registerPropSet(ctx, 'ops', 'ops-compound', sets, { nearM: quality.infield.propsNearM, farM: quality.farField.rangeFar }, { receiveShadow: true })
  }

  return { placements, stats: { vehicles, equipment } }
}
