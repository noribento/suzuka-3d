import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { BUILDING, HERO_BUILDINGS } from '~/data/surroundings-spec'
import type { AssetRegistry } from './assets'
import type { Planned } from './buildings'
import type { EnvBuildContext } from './environment'
import { principalAxis, ringArea, type XZ } from './far-geometry'
import { modelPrototype, type ModelProto } from './model-proto'
import { nearestRoad, roadNetwork, type RoadNet } from './road-section'
import { mulberry } from './textures'

/**
 * Hero houses (R フェーズ Phase 4): the OSM house footprints that a pack model's footprint fits
 * are built from the model instead of the massing. `pickHeroes` decides the fits synchronously
 * while buildings.ts plans its cells (so a cell job knows to lay only a plinth); `buildHeroes`
 * is the last 'buildings' job and draws every fit of one model as ONE InstancedMesh over the
 * whole map (range ∞, registered in the far field's outside bucket so no cell test ever skips
 * it, never merged) — 25–48 instances of ~2 k triangles are cheaper than any LOD machinery.
 *
 * The fit (`HERO_BUILDINGS`): the footprint's oriented bounding box (`footprintObb`) against the
 * model's bbox footprint from `modelPrototype` (its native units — the packs are metric), the
 * walls' box widened by the roof overhang the model bbox includes; accepted when the long ÷
 * short ratio is within `fit` (±20 %) of the model's, the ring fills ≥ `fill` of the box and the
 * uniform scale that makes the model's long side the box's is within `scale`. Only footprints
 * inside the terrain grid; nearest the circuit first (`SurBuilding.dmin`) up to
 * `Quality.farField.heroBuildings`. Several models fitting one footprint: one is drawn by the
 * footprint's seed. `tag` entries (apartments) take their footprints first; the untagged house
 * models never take a tagged footprint or a shed (hut / garage / shed).
 *
 * Yaw: the model's long side (`forward: 'x'`, local +x) lies along the box's long axis. Which
 * way it faces is a heuristic — nothing in a glTF says where the door is — documented here:
 * the model's FRONT is taken as the long face (local ±z) whose triangles are more numerous
 * (the entrance, windows, balconies and a carport are modelled; the back of these packs is a
 * plain wall), and it is turned toward the long side of the box nearer a road (road-section.ts
 * `nearestRoad` on both face midpoints), else toward the side farther from the circuit (the
 * canopies' fascia rule). The assumption is listed under README「GPU で確認すること」.
 *
 * Height: the model's base (y = 0 after `modelPrototype`) sits `HERO_BUILDINGS.plinth` over the
 * HIGHEST ground under the box's corners — a model is never dug into a slope the way the
 * massing's walls are (they rise with the ground) — and the cell job's plinth box (from the
 * massing's base, gMin − baseDrop, up to that y) fills the rest as a foundation wall; a site
 * steeper than MAX_SLOPE_M keeps the massing. Node / the low tier have no registry, so
 * `pickHeroes` is empty there and the massing is exactly what it was.
 */

/** the oriented bounding box of a ring: centre, unit axis (the principal one), half extents along / across */
export interface Obb {
  cx: number
  cz: number
  ax: number
  az: number
  ha: number
  hc: number
}

export function footprintObb(ring: readonly XZ[]): Obb {
  const p = principalAxis(ring)
  let a0 = Infinity, a1 = -Infinity, c0 = Infinity, c1 = -Infinity
  for (const [x, z] of ring) {
    const dx = x - p.cx, dz = z - p.cz
    const a = dx * p.ax + dz * p.az, c = -dx * p.az + dz * p.ax
    if (a < a0) a0 = a
    if (a > a1) a1 = a
    if (c < c0) c0 = c
    if (c > c1) c1 = c
  }
  const ma = (a0 + a1) / 2, mc = (c0 + c1) / 2
  return { cx: p.cx + p.ax * ma - p.az * mc, cz: p.cz + p.az * ma + p.ax * mc, ax: p.ax, az: p.az, ha: (a1 - a0) / 2, hc: (c1 - c0) / 2 }
}

export interface HeroPick {
  /** the manifest key of the model */
  model: string
  /** rotation about Y (rad): the model's local +x along the box's long axis, its front toward the road */
  yaw: number
  /** uniform scale over the model's native size */
  scale: number
  /** the model's base: the footprint's lowest ground + the plinth */
  y: number
  /** the box the model stands in (the plinth's outline) */
  obb: Obb
  /** the model's height at this scale (m) */
  height: number
}

/** the roof overhang the model bboxes include beyond the wall line the OSM footprint traces (m each side) */
const OVERHANG = 0.5
/**
 * Sketchfab's auto-converted glTF keeps the author's unit: the reckzilla homes are modelled in
 * centimetres (an 815 "metre" tall house), the apartment in metres. Nothing taller than this (m)
 * is a house, so such a model is taken as centimetres and scaled by 1/100 once, here.
 */
const CM_ABOVE_M = 60
/** a footprint whose corner grounds differ by more than this (m) keeps the massing (its walls rise with the ground; a model would be dug in or float) */
const MAX_SLOPE_M = 1.2

/** prototypes per registry and key (the pick and the job both need them; a null is cached too) */
const PROTOS = new WeakMap<AssetRegistry, Map<string, ModelProto | null>>()

function protoOf(reg: AssetRegistry, key: string): ModelProto | null {
  let per = PROTOS.get(reg)
  if (!per) PROTOS.set(reg, (per = new Map()))
  if (!per.has(key)) {
    let proto: ModelProto | null = null
    try {
      // parts per material so a multi-material pack (the apartment's 10 materials) keeps its maps
      proto = modelPrototype(reg, key, { forward: 'x', partOf: (mat) => mat.uuid })
      if (proto && proto.footprint.height > CM_ABOVE_M) {
        for (const part of Object.values(proto.parts)) {
          part.geometry.scale(0.01, 0.01, 0.01)
          part.geometry.computeBoundingSphere()
        }
        const f = proto.footprint
        proto = { ...proto, footprint: { long: f.long * 0.01, short: f.short * 0.01, height: f.height * 0.01 } }
      }
    } catch (err) {
      console.warn(`[heroBuildings] ${key}: ${err instanceof Error ? err.message : String(err)}`)
    }
    per.set(key, proto)
  }
  return per.get(key) ?? null
}

/** +1 when the model's local +z long face carries more triangles than the −z one (the front heuristic of the module comment), else −1 */
function frontSign(proto: ModelProto): 1 | -1 {
  let plus = 0, minus = 0
  for (const part of Object.values(proto.parts)) {
    const nrm = part.geometry.getAttribute('normal')
    if (!nrm) continue
    for (let t = 0; t + 2 < nrm.count; t += 3) {
      const nz = (nrm.getZ(t) + nrm.getZ(t + 1) + nrm.getZ(t + 2)) / 3
      if (nz > 0.5) plus++
      else if (nz < -0.5) minus++
    }
  }
  return plus >= minus ? 1 : -1
}

/**
 * The hero fits for the planned footprints (see the module comment), keyed by the footprint's
 * OSM id. Empty without a registry, without the models, or when the tier's `heroBuildings` is 0.
 */
export function pickHeroes(planned: readonly Planned[], ctx: EnvBuildContext): Map<number, HeroPick> {
  const out = new Map<number, HeroPick>()
  const reg = ctx.assets
  const budget = ctx.quality.farField.heroBuildings
  if (!reg || budget <= 0) return out
  const H = HERO_BUILDINGS
  const models = H.models.map((m) => ({ ...m, proto: protoOf(reg, m.key) })).filter((m) => m.proto !== null)
  if (!models.length) return out
  if (import.meta.dev) console.info(`[heroBuildings] ${models.map((m) => `${m.key.split('/').pop()} ${m.proto!.footprint.long.toFixed(1)} × ${m.proto!.footprint.short.toFixed(1)} × ${m.proto!.footprint.height.toFixed(1)} m, ${m.proto!.triangles} tris`).join('; ')}`)
  const taggedValues = new Set(H.models.map((m) => m.tag).filter((t): t is string => t !== undefined))
  const outside = ctx.farField.outsideCell
  let net: RoadNet | null = null
  try {
    net = roadNetwork(ctx, { stepScale: ctx.quality.farField.roads.stepScale, ring: ctx.quality.farField.roads.ring })
  } catch {
    net = null
  }

  interface Fit { p: Planned; pick: HeroPick }
  const fits: Fit[] = []
  // why the in-grid candidates were not fitted (the dev log): the fill, the aspect, the size, the slope
  const rejected = { fill: 0, aspect: 0, size: 0, slope: 0 }
  for (const p of planned) {
    if (p.cell === outside) continue
    const building = p.b.tags.building ?? ''
    if (building === 'hut' || building === 'garage' || building === 'shed') continue
    const candidates = models.filter((m) => m.kinds.includes(p.kind) && (m.tag !== undefined ? building === m.tag : !taggedValues.has(building)))
    if (!candidates.length) continue
    const box = footprintObb(p.ring)
    const long = Math.max(box.ha, box.hc) * 2 + 2 * OVERHANG, short = Math.min(box.ha, box.hc) * 2 + 2 * OVERHANG
    if (short < 1) continue
    const fill = ringArea(p.ring) / (Math.max(box.ha, box.hc) * 2 * Math.min(box.ha, box.hc) * 2)
    if (fill < H.fill) { rejected.fill++; continue }
    const ratio = long / short
    let aspectOk = 0
    const ok = candidates.filter((m) => {
      if (m.minLong !== undefined && long < m.minLong) return false
      const f = m.proto!.footprint
      const mr = f.long / f.short
      if (Math.abs(ratio - mr) / mr > H.fit) return false
      aspectOk++
      const k = long / f.long
      return k >= H.scale[0] && k <= H.scale[1]
    })
    if (!ok.length) { if (aspectOk) rejected.size++; else rejected.aspect++; continue }
    // the ground under the box corners: a model is never dug into a slope like the massing's
    // walls are, so it stands on the highest corner's ground (the plinth fills the rest — a
    // foundation wall downhill) and a site steeper than MAX_SLOPE_M keeps the massing
    let gMin = Infinity, gMax = -Infinity
    for (const [sa, sc] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      const x = box.cx + box.ax * box.ha * sa - box.az * box.hc * sc, z = box.cz + box.az * box.ha * sa + box.ax * box.hc * sc
      const g = ctx.ground.standY(x, z)
      gMin = Math.min(gMin, g)
      gMax = Math.max(gMax, g)
    }
    if (gMax - gMin > MAX_SLOPE_M) { rejected.slope++; continue }
    const m = ok[Math.min(ok.length - 1, Math.floor(mulberry(p.seed)() * ok.length))]!
    const proto = m.proto!
    const k = long / proto.footprint.long
    // the long axis of the box: the OBB's principal axis, or across it when the ring is wider than long
    const alongAxis = box.ha >= box.hc
    const ax = alongAxis ? box.ax : -box.az, az = alongAxis ? box.az : box.ax
    const hc = alongAxis ? box.hc : box.ha
    // local +x → (ax, az); local +z → the across unit vector (−az, ax)
    let yaw = Math.atan2(-az, ax)
    // the front: the long face nearer a road; without one, the one farther from the circuit
    const kx = -az, kz = ax
    const side = (sgn: number): number => {
      const mx = box.cx + kx * hc * sgn, mz = box.cz + kz * hc * sgn
      const nr = net ? nearestRoad(net, mx, mz, 60) : null
      // nearer a road is better; without one, farther from the circuit is better (a lower score band)
      return nr ? 1000 - nr.d : ctx.ground.plan.project(mx, mz).d
    }
    const roadSide = side(1) >= side(-1) ? 1 : -1
    if (frontSign(proto) !== roadSide) yaw += Math.PI
    fits.push({ p, pick: { model: m.key, yaw, scale: k, y: gMax + H.plinth, obb: box, height: proto.footprint.height * k } })
  }
  fits.sort((a, b) => a.p.b.dmin - b.p.b.dmin)
  for (const f of fits.slice(0, budget)) out.set(f.p.b.id, f.pick)
  if (import.meta.dev) console.info(`[heroBuildings] ${out.size} of ${fits.length} fits taken (budget ${budget}); rejected ${JSON.stringify(rejected)}`)
  return out
}

/**
 * The 'heroBuildings' job: every pick of one model as one InstancedMesh (the prototype's parts
 * merged with geometry groups, one fresh MeshStandardMaterial per part carrying the pack's
 * colour + normal maps at roughness 0.8), cast shadows per the tier, registered in the outside
 * bucket at range ∞. null when nothing was picked or the models are gone.
 */
export function buildHeroes(ctx: EnvBuildContext, picks: Iterable<HeroPick>): THREE.Object3D | null {
  const reg = ctx.assets
  if (!reg) return null
  const byModel = new Map<string, HeroPick[]>()
  for (const pk of picks) {
    let list = byModel.get(pk.model)
    if (!list) byModel.set(pk.model, (list = []))
    list.push(pk)
  }
  if (!byModel.size) return null
  const root = new THREE.Group()
  root.name = 'heroBuildings'
  const castShadow = ctx.quality.farField.shadows
  const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _m = new THREE.Matrix4()
  const Y = new THREE.Vector3(0, 1, 0)
  const counts: Record<string, number> = {}
  let triangles = 0
  for (const [key, list] of byModel) {
    const proto = protoOf(reg, key)
    if (!proto) continue
    const geos: THREE.BufferGeometry[] = []
    const mats: THREE.MeshStandardMaterial[] = []
    for (const part of Object.values(proto.parts)) {
      geos.push(part.geometry)
      const src = part.source
      const mat = new THREE.MeshStandardMaterial({
        map: src?.map ?? null,
        normalMap: src?.normalMap ?? null,
        color: src?.map ? 0xffffff : (src?.color ?? new THREE.Color(0xd8d4cc)),
        roughness: 0.8,
        metalness: 0,
      })
      if (src?.normalMap) mat.normalScale.copy(src.normalScale)
      mats.push(mat)
    }
    const merged = geos.length === 1 ? geos[0]! : mergeGeometries(geos, true)
    if (!merged) continue
    const inst = new THREE.InstancedMesh(merged, geos.length === 1 ? mats[0]! : mats, list.length)
    const short = key.split('/').pop() ?? key
    inst.name = `heroHouses-${short}`
    list.forEach((pk, i) => {
      _q.setFromAxisAngle(Y, pk.yaw)
      _s.setScalar(pk.scale)
      inst.setMatrixAt(i, _m.compose(_p.set(pk.obb.cx, pk.y, pk.obb.cz), _q, _s))
    })
    inst.instanceMatrix.needsUpdate = true
    inst.computeBoundingSphere()
    inst.castShadow = castShadow
    inst.receiveShadow = true
    root.add(inst)
    ctx.farField.register({ kind: 'buildings', name: inst.name, cell: ctx.farField.outsideCell, levels: [{ object: inst, range: Infinity }] })
    counts[short] = list.length
    triangles += proto.triangles * list.length
  }
  if (!root.children.length) return null
  root.userData.heroBuildings = { heroes: Object.values(counts).reduce((a, b) => a + b, 0), byModel: counts, triangles, plinth: HERO_BUILDINGS.plinth, baseDrop: BUILDING.baseDrop }
  return root
}
