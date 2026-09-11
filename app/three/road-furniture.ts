import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { ROAD_FURNITURE, ROAD_SECTION, ROADS } from '~/data/surroundings-spec'
import type { AssetRegistry } from './assets'
import type { EnvBuildContext } from './environment'
import type { GridShape } from './far-geometry'
import { siteOk, type SiteRule } from './far-lines'
import { FAR_CELL_M, MERGE_CELLS } from './farfield'
import { pbr, repeatMetres } from './materials'
import { modelPrototype } from './model-proto'
import { utilityPoles } from './outskirts'
import { offsetAt, roadNetwork, sampleAt, walk, type Junction, type RoadSample, type RoadWay } from './road-section'
import { armcoMaps, concreteMaps, mulberry } from './textures'

/**
 * The roadside furniture of the public roads outside the fences (plan R フェーズ Phase 3): the
 * Gr-C guardrails, the 視線誘導標 delineators, the カーブミラー curve mirrors, the 止まれ / speed /
 * warning signs, the 横型 signals with their controller cabinets, and the transformer cans on
 * every fourth utility pole. Everything is placed along the road NETWORK (road-section.ts —
 * `walk` / `sampleAt` / `offsetAt`, +lateral = the driver's left, Japan keeps left) so a rail
 * follows the same filleted, trimmed path the ribbon is cut from, a sign stands where the ribbon
 * paints its stop bar, and a signal head hangs over the lane it controls.
 *
 * Built as one deferred 'dressing' job per 1 km block of far-field cells (the blocks the roads
 * are merged by), each pouring its elements into ONE mesh per material — galvanised steel,
 * the armco W-beam, a vertex-coloured `painted` Standard (discs, plates, housings, lenses,
 * cans: no map, so it shares a program with the car bodies and the buildings), concrete, and
 * the pack's own materials for the erikkinc sign faces / signal head / utility box when the
 * GLB is in the registry — under a Group `roadFurniture-b<n>` registered at ROAD_FURNITURE.range.
 * Merged, not instanced: the InstancedMesh budget is the tight one, and a block's furniture is
 * a few thousand triangles that the frustum culls as one. Node, the low tier and a missing pack
 * build the procedural stand-ins (a red inverted triangle for 止まれ, a box with three lenses for
 * the signal) so the geometry the guards measure is the same shape at the same sites.
 *
 * Placement rules every element obeys: inside the terrain grid, ≥ ROADS.minD (76 m) from the
 * GP centreline (`siteOk` with the sample's `dLo` bound, so the exact projection is rare), on
 * no drawn ground face, and — for the things that run along the road — outside the junction
 * mouths (`mouthWindows`: both sides for the way's own end, the mouth's side of a through way
 * for each road that ends on it). The signs and signals that BELONG to a junction ignore the
 * mouth rule. Heights are `ground.standY` at the element's own foot; nothing samples the
 * terrain (R3), nothing adds a ground face (R1, R11).
 *
 * The density knob `Quality.farField.roads.furniture` (1 high, 0.5 low) divides every pitch and
 * thins the per-site elements (signs, mirrors) by a deterministic hash; guardrails stay
 * continuous at any density.
 */

export interface RoadFurnitureStats {
  blocks: number
  /** metres of W-beam poured (both sides counted) and posts set */
  guardrailM: number
  posts: number
  delineators: number
  mirrors: number
  signs: { stop: number; speed: number; warn: number }
  signals: number
  transformers: number
  /** triangles over every block, and whether the erikkinc pack furnished the plates / heads */
  triangles: number
  packUsed: boolean
  /** planned counts (before the site rule), for the dev log */
  planned: { rails: number; delineators: number; mirrors: number; signs: number; signals: number; transformers: number }
  /** the synchronous part (materials, prototypes, the network walk), ms */
  planMs: number
}

// ---------------------------------------------------------------------------------------------
// tuning that is not a road-design number (those live in surroundings-spec ROAD_FURNITURE)

/** a rail / delineator / pole stays out of a junction mouth: the mouth road's half-width plus this (m) */
const MOUTH_PAD = 3
/** the lowest class that gets a 止まれ sign at its mouth (residential; a driveway ending on a street gets none) */
const STOP_SIGN_MIN_RANK = ROAD_SECTION.rank.residential!
/** the mouth mirror wants a minor of this rank meeting a major of at least `MIRROR_MAJOR_MIN_RANK` */
const MIRROR_MINOR_MIN_RANK = ROAD_SECTION.rank.residential!
const MIRROR_MAJOR_MIN_RANK = ROAD_SECTION.rank.unclassified!
/** a stop bar within this reach of a signalled junction is the signal's, not a 止まれ (m) */
const SIGNAL_STOP_REACH = 25
/** a filleted corner of at most this radius (m, the residential rMax) is still a blind bend that gets a mirror */
const MIRROR_MAX_R = ROADS.fillet.rMax.residential!
/** the mirror disc tilts down this much (rad) and its centre sits at this height (m) */
const MIRROR_TILT = (12 * Math.PI) / 180
const MIRROR_CENTRE_Y = 3.0
/** the signal arm's height and radius (m), the lens pitch on the head (m) */
const SIGNAL_ARM_Y = 5.5
const SIGNAL_ARM_R = 0.06
const SIGNAL_LENS_PITCH = 0.4
/** an unlit lens keeps this share of its colour */
const UNLIT = 0.25
/** the transformer can's centre height (m) and its offset from the pole axis towards the road (m) */
const CAN_Y = 8.8
const CAN_OFF = 0.385
/** a signalled junction's approach: the pole stands this far back from the crossing road's edge (m) and this far left of the paved edge (m) */
const SIGNAL_BACK = 1.5
const SIGNAL_LEFT = 1.0
/** nothing stands closer than this to another road's paved edge (m): the ribbons' overlap plus a little */
const ASPHALT_PAD = ROADS.trim + 0.2
/** the concrete tile (textures.ts concreteMaps) is 4 m; the footings' uv is in metres */
const CONCRETE_TILE_M = 4
/** painted colours (sRGB hex) */
const COLOUR = {
  white: 0xf2f2ee,
  orange: 0xf08a1e,
  glass: 0x9fb3c8,
  mirrorBack: 0x4a4d50,
  stopRed: 0xc8102e,
  signBlue: 0x1f4fa3,
  warnYellow: 0xf2c118,
  black: 0x1a1a1a,
  plateBack: 0x8f9296,
  housing: 0x2a2c30,
  cabinet: 0x9a9b96,
  can: 0x6f7276,
  green: 0x2ecc71,
  yellow: 0xf1c40f,
  red: 0xe74c3c,
} as const

type RGB = readonly [number, number, number]

// ---------------------------------------------------------------------------------------------
// the sink: flat quads and transformed prototypes into one non-indexed geometry per material

class Sink {
  private readonly pos: number[] = []
  private readonly nrm: number[] = []
  private readonly uv: number[] = []
  private readonly col: number[] | null
  constructor(readonly material: THREE.Material, coloured: boolean) {
    this.col = coloured ? [] : null
  }
  get triangles(): number {
    return this.pos.length / 9
  }
  private vertex(p: readonly number[], n: readonly number[], u: readonly number[], c: RGB | undefined) {
    this.pos.push(p[0]!, p[1]!, p[2]!)
    this.nrm.push(n[0]!, n[1]!, n[2]!)
    this.uv.push(u[0]!, u[1]!)
    if (this.col) {
      const k = c ?? WHITE
      this.col.push(k[0], k[1], k[2])
    }
  }
  /** one flat triangle; `out` picks the winding */
  tri(a: readonly number[], b: readonly number[], c: readonly number[], out: readonly number[], uvs: readonly (readonly number[])[], colour?: RGB) {
    const ux = b[0]! - a[0]!, uy = b[1]! - a[1]!, uz = b[2]! - a[2]!
    const vx = c[0]! - a[0]!, vy = c[1]! - a[1]!, vz = c[2]! - a[2]!
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const l = Math.hypot(nx, ny, nz)
    if (l < 1e-12) return
    nx /= l; ny /= l; nz /= l
    const flip = nx * out[0]! + ny * out[1]! + nz * out[2]! < 0
    const n = flip ? [-nx, -ny, -nz] : [nx, ny, nz]
    if (flip) {
      this.vertex(a, n, uvs[0]!, colour)
      this.vertex(c, n, uvs[2]!, colour)
      this.vertex(b, n, uvs[1]!, colour)
    } else {
      this.vertex(a, n, uvs[0]!, colour)
      this.vertex(b, n, uvs[1]!, colour)
      this.vertex(c, n, uvs[2]!, colour)
    }
  }
  /** corners p0 → p1 → p2 → p3 around the quad, `out` the side the face shows; uvs per corner */
  quad(p0: readonly number[], p1: readonly number[], p2: readonly number[], p3: readonly number[], out: readonly number[], uvs: readonly (readonly number[])[], colour?: RGB) {
    this.tri(p0, p1, p2, out, [uvs[0]!, uvs[1]!, uvs[2]!], colour)
    this.tri(p0, p2, p3, out, [uvs[0]!, uvs[2]!, uvs[3]!], colour)
  }
  /**
   * Append a prototype (non-indexed position / normal / uv, optionally its own `color`) placed by
   * `m` (a rigid transform: the normals are rotated by its 3 × 3). A prototype without a colour
   * attribute takes `colour` (white by default) into a coloured sink.
   */
  add(geo: THREE.BufferGeometry, m: THREE.Matrix4, colour?: RGB) {
    const p = geo.getAttribute('position'), n = geo.getAttribute('normal'), u = geo.getAttribute('uv'), c = geo.getAttribute('color')
    const e = m.elements
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i)
      this.pos.push(e[0]! * x + e[4]! * y + e[8]! * z + e[12]!, e[1]! * x + e[5]! * y + e[9]! * z + e[13]!, e[2]! * x + e[6]! * y + e[10]! * z + e[14]!)
      const nx = n.getX(i), ny = n.getY(i), nz = n.getZ(i)
      this.nrm.push(e[0]! * nx + e[4]! * ny + e[8]! * nz, e[1]! * nx + e[5]! * ny + e[9]! * nz, e[2]! * nx + e[6]! * ny + e[10]! * nz)
      this.uv.push(u ? u.getX(i) : 0, u ? u.getY(i) : 0)
      if (this.col) {
        if (c) this.col.push(c.getX(i), c.getY(i), c.getZ(i))
        else {
          const k = colour ?? WHITE
          this.col.push(k[0], k[1], k[2])
        }
      }
    }
  }
  build(): THREE.BufferGeometry | null {
    if (!this.pos.length) return null
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2))
    if (this.col) g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3))
    g.computeBoundingSphere()
    return g
  }
}

const WHITE: RGB = [1, 1, 1]

/** linear RGB of an sRGB hex (the vertex colours are linear; `Color.setHex` converts) */
function rgb(hex: number): RGB {
  const c = new THREE.Color(hex)
  return [c.r, c.g, c.b]
}

/** non-indexed copy of a three primitive with a `color` attribute (and no index, so it merges with the rest) */
function tinted(geo: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo
  if (g !== geo) geo.dispose()
  const n = g.getAttribute('position').count
  const [r, gg, b] = rgb(hex)
  const col = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    col[i * 3] = r
    col[i * 3 + 1] = gg
    col[i * 3 + 2] = b
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  return g
}

/** non-indexed copy of a three primitive (position / normal / uv only) */
function plain(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo
  if (g !== geo) geo.dispose()
  for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name)
  return g
}

function merged(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts, false)
  if (!g) throw new Error('[road-furniture] prototype parts differ in attributes')
  for (const p of parts) p.dispose()
  return g
}

const _m = new THREE.Matrix4()
const _r = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _p = new THREE.Vector3()
const _s = new THREE.Vector3(1, 1, 1)
const Y_UP = new THREE.Vector3(0, 1, 0)
const X_AXIS = new THREE.Vector3(1, 0, 0)

/**
 * The placement matrix of a prototype whose local +z is its FRONT: at (x, y, z), facing the
 * unit direction (fx, fz), pitched `tilt` rad about local x (positive tilts the front down).
 */
function frame(x: number, y: number, z: number, fx: number, fz: number, tilt = 0): THREE.Matrix4 {
  _q.setFromAxisAngle(Y_UP, Math.atan2(fx, fz))
  _m.compose(_p.set(x, y, z), _q, _s)
  if (tilt) {
    _r.makeRotationAxis(X_AXIS, tilt)
    _m.multiply(_r)
  }
  return _m
}

/** a deterministic 0–1 from a way id and a position along it (thins signs / mirrors by density) */
function hash01(id: number, s: number): number {
  return mulberry((id * 131 + Math.round(s * 10)) | 0)()
}

// ---------------------------------------------------------------------------------------------
// materials and prototypes

interface PackMaterial {
  material: THREE.MeshStandardMaterial
  /** identity of the pack's texture set — one material (one mesh per block) per set */
  key: string
}

interface Protos {
  /** galvanised: the delineator post (φ34 × 1.2, 4-sided), the guardrail post, the sign pole, the mirror pole, the signal pole + arm */
  delinPost: THREE.BufferGeometry
  railPost: THREE.BufferGeometry
  signPole: THREE.BufferGeometry
  mirrorPole: THREE.BufferGeometry
  signalPole: THREE.BufferGeometry
  /** painted: the delineator discs (white / orange, double-faced at 1.2 m), the mirror disc (glass, rim, back; tilted, at 3.0 m), the fallback plates (centre at the origin, front +z), the signal head + cabinet + can */
  delinWhite: THREE.BufferGeometry
  delinOrange: THREE.BufferGeometry
  mirrorDisc: THREE.BufferGeometry
  plateStop: THREE.BufferGeometry
  plateSpeed: THREE.BufferGeometry
  plateWarn: THREE.BufferGeometry
  signalHead: THREE.BufferGeometry
  lens: THREE.BufferGeometry
  cabinet: THREE.BufferGeometry
  can: THREE.BufferGeometry
  /** concrete: the footing of a mirror / signal pole (φ0.5 × 0.4, centred on the ground: 0.2 m proud of it) */
  footing: THREE.BufferGeometry
  /** the pack's pieces (null without the pack): oriented front +z, plates centred, the head hanging from its top centre, the pole / cabinet on their base */
  pack: {
    stop: { geometry: THREE.BufferGeometry; mat: PackMaterial } | null
    warn: { geometry: THREE.BufferGeometry; mat: PackMaterial } | null
    speed: { geometry: THREE.BufferGeometry; mat: PackMaterial } | null
    pole: { geometry: THREE.BufferGeometry; mat: PackMaterial } | null
    head: { geometry: THREE.BufferGeometry; mat: PackMaterial } | null
    pedestrian: { geometry: THREE.BufferGeometry; mat: PackMaterial } | null
    cabinet: { geometry: THREE.BufferGeometry; mat: PackMaterial } | null
  }
}

interface Materials {
  galvanised: THREE.MeshStandardMaterial
  guardrail: THREE.MeshStandardMaterial
  painted: THREE.MeshStandardMaterial
  concrete: THREE.MeshStandardMaterial
  packMats: Map<string, PackMaterial>
}

function makeMaterials(): Materials {
  const galvanised = new THREE.MeshStandardMaterial({ color: 0x9a9ea2, roughness: 0.55, metalness: 0.6 })
  const armco = armcoMaps()
  const guardrail = new THREE.MeshStandardMaterial({ map: armco.map, normalMap: armco.normalMap, normalScale: new THREE.Vector2(0.8, 0.8), color: 0xdfe2e4, roughness: 0.5, metalness: 0.6, side: THREE.DoubleSide })
  // no map: the discs, plates, housings and lenses share one program with the other vertex-coloured Standards
  const painted = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.1 })
  // the bridge walls' concrete (roads.ts): the shared procedural tile on its own clones, 4 m per tile
  const maps = concreteMaps()
  const world: readonly [number, number] = [1, 1]
  const concrete = pbr({
    map: repeatMetres(maps.map.clone(), CONCRETE_TILE_M, world),
    normalMap: maps.normalMap && repeatMetres(maps.normalMap.clone(), CONCRETE_TILE_M, world),
    roughnessMap: maps.roughnessMap && repeatMetres(maps.roughnessMap.clone(), CONCRETE_TILE_M, world),
  }, { roughness: 0.9, color: 0xcfcdc6 }, 0.6)
  return { galvanised, guardrail, painted, concrete, packMats: new Map() }
}

/** the pack's material for a prototype part: its base colour + normal maps on a fresh Standard (one per texture set, so a block draws each set once) */
function packMaterial(mats: Materials, src: THREE.MeshStandardMaterial | null, sided: THREE.Side): PackMaterial {
  const key = `${src?.map?.uuid ?? '-'}|${src?.normalMap?.uuid ?? '-'}|${sided}`
  let pm = mats.packMats.get(key)
  if (!pm) {
    const material = new THREE.MeshStandardMaterial({ map: src?.map ?? null, normalMap: src?.normalMap ?? null, color: src?.map ? 0xffffff : (src?.color ?? new THREE.Color(0x9a9ea2)), roughness: 0.6, metalness: 0.2, side: sided })
    if (src?.normalMap) material.normalScale.copy(src.normalScale)
    mats.packMats.set(key, (pm = { material, key }))
  }
  return pm
}

/**
 * Turn a pack piece so its plane / long side lies along local x and its FRONT faces +z. The
 * yaw comes from the piece's own vertices (the major axis of the xz covariance — the pack's
 * display layout leans some plates by 25°, and a bbox cannot tell), the front from a rule
 * measured on the drop: a sign plate prints its face on the side whose uv rows are nearer the
 * top of the texture (`uvTop` — the pack's speed / stop / slow textures put the print above the
 * grey back), a signal head has its lens dishes on the side with the larger face area
 * (`moreArea`); `none` keeps the PCA sign (a tube, a box). Works on the widened, world-baked
 * geometry, so the import's node transforms and quantisation do not matter.
 */
function orientPack(geo: THREE.BufferGeometry, front: 'uvTop' | 'moreArea' | 'none') {
  const pos = geo.getAttribute('position'), nrm = geo.getAttribute('normal'), uv = geo.getAttribute('uv')
  let mx = 0, mz = 0
  for (let i = 0; i < pos.count; i++) {
    mx += pos.getX(i)
    mz += pos.getZ(i)
  }
  mx /= pos.count
  mz /= pos.count
  let sxx = 0, sxz = 0, szz = 0
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) - mx, z = pos.getZ(i) - mz
    sxx += x * x
    sxz += x * z
    szz += z * z
  }
  // the major axis of the 2 × 2 covariance is at ½·atan2(2 sxz, sxx − szz); rotating by that puts it on +x
  geo.rotateY(0.5 * Math.atan2(2 * sxz, sxx - szz))
  if (front === 'none') return
  let plusV = 0, plusW = 0, minusV = 0, minusW = 0
  for (let t = 0; t + 2 < pos.count; t += 3) {
    const nz = (nrm.getZ(t) + nrm.getZ(t + 1) + nrm.getZ(t + 2)) / 3
    if (Math.abs(nz) < 0.5) continue
    const ax = pos.getX(t + 1) - pos.getX(t), ay = pos.getY(t + 1) - pos.getY(t), az = pos.getZ(t + 1) - pos.getZ(t)
    const bx = pos.getX(t + 2) - pos.getX(t), by = pos.getY(t + 2) - pos.getY(t), bz = pos.getZ(t + 2) - pos.getZ(t)
    const area = 0.5 * Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx)
    const v = uv ? (uv.getY(t) + uv.getY(t + 1) + uv.getY(t + 2)) / 3 : 0
    if (nz > 0) {
      plusV += v * area
      plusW += area
    } else {
      minusV += v * area
      minusW += area
    }
  }
  if (!plusW || !minusW) return
  const flip = front === 'uvTop' ? plusV / plusW > minusV / minusW : plusW < minusW
  if (flip) geo.rotateY(Math.PI)
}

/**
 * One node of the pack as a prototype: its meshes merged, scaled, oriented (`orientPack`), the
 * origin at the plate's centre / the head's top centre / the pole's base. null without the pack
 * or when the regex matches nothing (the caller keeps its procedural stand-in).
 */
function packPiece(reg: AssetRegistry | null, mats: Materials, key: string, nodes: RegExp, scaleTo: { height?: number; long?: number }, front: 'uvTop' | 'moreArea' | 'none', origin: 'centre' | 'top' | 'base', sided: THREE.Side): { geometry: THREE.BufferGeometry; mat: PackMaterial } | null {
  if (!reg) return null
  const proto = modelPrototype(reg, key, { nodes, scaleTo })
  if (!proto) return null
  const part = proto.parts.main!
  const geo = part.geometry
  orientPack(geo, front)
  geo.computeBoundingBox()
  const b = geo.boundingBox!
  // recentre in xz after the yaw (the bbox centre was taken before it) and put the origin where the caller hangs it
  const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2
  geo.translate(-cx, origin === 'centre' ? -(b.min.y + b.max.y) / 2 : origin === 'top' ? -b.max.y : -b.min.y, -cz)
  geo.computeBoundingSphere()
  return { geometry: geo, mat: packMaterial(mats, part.source, sided) }
}

function makeProtos(reg: AssetRegistry | null, mats: Materials): Protos {
  const F = ROAD_FURNITURE
  const D = F.delineator, G = F.guardrail, S = F.sign, M = F.mirror, L = F.signal, T = F.pole.transformer
  // --- galvanised -------------------------------------------------------------------------------
  const delinPost = plain(new THREE.CylinderGeometry(0.017, 0.017, D.h, 4, 1, true).translate(0, D.h / 2, 0))
  const railPost = plain(new THREE.CylinderGeometry(G.postD / 2, G.postD / 2, G.postH, 4, 1, true).rotateY(Math.PI / 4).translate(0, G.postH / 2, 0))
  const signPole = plain(new THREE.CylinderGeometry(S.poleD / 2, S.poleD / 2, S.plateH + 0.5, 6, 1, true).translate(0, (S.plateH + 0.5) / 2, 0))
  const mirrorPole = plain(new THREE.CylinderGeometry(M.poleD / 2, M.poleD / 2, M.poleH, 6, 1, true).translate(0, M.poleH / 2, 0))
  // the signal pole with its arm: local +x is the driver's right (over the carriageway), the arm ends at x = L.arm
  const signalPole = merged([
    plain(new THREE.CylinderGeometry(L.poleD / 2, L.poleD / 2, L.poleH, 8, 1, true).translate(0, L.poleH / 2, 0)),
    plain(new THREE.CylinderGeometry(SIGNAL_ARM_R, SIGNAL_ARM_R, L.arm, 6, 1, true).rotateZ(-Math.PI / 2).translate(L.arm / 2, SIGNAL_ARM_Y, 0)),
  ])
  // --- painted ------------------------------------------------------------------------------------
  const disc = (hex: number) => merged([
    tinted(new THREE.CircleGeometry(D.d / 2, 8).translate(0, D.h, 0.005), hex),
    tinted(new THREE.CircleGeometry(D.d / 2, 8).rotateY(Math.PI).translate(0, D.h, -0.005), hex),
  ])
  const delinWhite = disc(COLOUR.white), delinOrange = disc(COLOUR.orange)
  // the mirror: glass on +z, the orange rim a centimetre proud of it, a dark back; the whole disc pitched down
  const mirrorDisc = merged([
    tinted(new THREE.CircleGeometry(M.d / 2 - 0.03, 16), COLOUR.glass),
    tinted(new THREE.RingGeometry(M.d / 2 - 0.06, M.d / 2, 16).translate(0, 0, 0.01), COLOUR.orange),
    tinted(new THREE.CircleGeometry(M.d / 2, 16).rotateY(Math.PI).translate(0, 0, -0.02), COLOUR.mirrorBack),
  ])
  mirrorDisc.rotateX(MIRROR_TILT)
  mirrorDisc.translate(0, MIRROR_CENTRE_Y, 0)
  // 止まれ: an inverted triangle 0.8 m a side — white border, red face, a white inset for the characters; a grey back
  const tri = (side: number, z: number, hex: number, back = false) => {
    const h = (side * Math.sqrt(3)) / 2
    const g = new THREE.BufferGeometry()
    const y0 = h / 3, y1 = -(2 * h) / 3
    // counter-clockwise seen from the face's side: the front from +z, the back from −z
    g.setAttribute('position', new THREE.Float32BufferAttribute(back ? [-side / 2, y0, z, side / 2, y0, z, 0, y1, z] : [-side / 2, y0, z, 0, y1, z, side / 2, y0, z], 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(back ? [0, 0, -1, 0, 0, -1, 0, 0, -1] : [0, 0, 1, 0, 0, 1, 0, 0, 1], 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute(back ? [0, 1, 1, 1, 0.5, 0] : [0, 1, 0.5, 0, 1, 1], 2))
    return tinted(g, hex)
  }
  const plateStop = merged([tri(0.8, 0, COLOUR.white), tri(0.7, 0.004, COLOUR.stopRed), tri(0.3, 0.008, COLOUR.white), tri(0.8, -0.004, COLOUR.plateBack, true)])
  // speed: a white disc with a red ring and a blue bar where the digits go
  const plateSpeed = merged([
    tinted(new THREE.CircleGeometry(0.3, 12), COLOUR.white),
    tinted(new THREE.RingGeometry(0.22, 0.3, 12).translate(0, 0, 0.004), COLOUR.stopRed),
    tinted(new THREE.PlaneGeometry(0.26, 0.12).translate(0, 0, 0.008), COLOUR.signBlue),
    tinted(new THREE.CircleGeometry(0.3, 12).rotateY(Math.PI).translate(0, 0, -0.004), COLOUR.plateBack),
  ])
  // warning: a yellow diamond with a black mark
  const plateWarn = merged([
    tinted(new THREE.PlaneGeometry(0.45, 0.45).rotateZ(Math.PI / 4), COLOUR.warnYellow),
    tinted(new THREE.PlaneGeometry(0.2, 0.06).rotateZ(Math.PI / 5).translate(0, 0, 0.004), COLOUR.black),
    tinted(new THREE.PlaneGeometry(0.45, 0.45).rotateZ(Math.PI / 4).rotateY(Math.PI).translate(0, 0, -0.004), COLOUR.plateBack),
  ])
  // the 横型 head: hangs from its top centre, faces +z; the lenses sit on the front face
  const [hw, hh, hd] = L.head
  const signalHead = tinted(new THREE.BoxGeometry(hw, hh, hd).translate(0, -hh / 2, 0), COLOUR.housing)
  const lens = plain(new THREE.CircleGeometry(L.lens / 2, 8))
  const cabinet = tinted(new THREE.BoxGeometry(0.6, 1.2, 0.4).translate(0, 0.6, 0), COLOUR.cabinet)
  // the transformer can with its bracket: the can's axis vertical, the bracket back to the pole (local −z)
  const can = merged([
    tinted(new THREE.CylinderGeometry(T.d / 2, T.d / 2, T.h, 8), COLOUR.can),
    tinted(new THREE.BoxGeometry(0.12, 0.12, CAN_OFF).translate(0, T.h / 2 - 0.1, -CAN_OFF / 2), COLOUR.can),
  ])
  // --- concrete --------------------------------------------------------------------------------------
  const footing = plain(new THREE.CylinderGeometry(0.25, 0.25, 0.4, 8, 1, false).translate(0, 0, 0))
  // --- the pack ---------------------------------------------------------------------------------------
  const key = 'model/road/jp_traffic_assets'
  const pack: Protos['pack'] = {
    stop: packPiece(reg, mats, key, /(^|\/)triangle(\/|$)/, { height: 0.8 }, 'uvTop', 'centre', THREE.DoubleSide),
    warn: packPiece(reg, mats, key, /(^|\/)triangle1(\/|$)/, { height: 0.8 }, 'uvTop', 'centre', THREE.DoubleSide),
    speed: packPiece(reg, mats, key, /(^|\/)circle_new2(\/|$)/, { height: 0.6 }, 'uvTop', 'centre', THREE.DoubleSide),
    pole: packPiece(reg, mats, key, /(^|\/)main_tube(\/|$)/, { height: S.plateH + 0.5 }, 'none', 'base', THREE.FrontSide),
    head: packPiece(reg, mats, key, /(^|\/)traffic_lights1(\/|$)/, { long: hw }, 'moreArea', 'top', THREE.FrontSide),
    pedestrian: packPiece(reg, mats, key, /(^|\/)pedestrianlightmesh(\/|$)/, { height: 0.45 }, 'moreArea', 'top', THREE.FrontSide),
    cabinet: packPiece(reg, mats, 'model/props/utility_box_02', /./, { height: 1.2 }, 'none', 'base', THREE.FrontSide),
  }
  return { delinPost, railPost, signPole, mirrorPole, signalPole, delinWhite, delinOrange, mirrorDisc, plateStop, plateSpeed, plateWarn, signalHead, lens, cabinet, can, footing, pack }
}

// ---------------------------------------------------------------------------------------------
// the plan (synchronous, XZ only)

/** an element with its foot, its front, the centreline-distance bound at the foot, the way it belongs to (the asphalt test skips that one) and the road sample it stands beside */
interface Site {
  x: number
  z: number
  fx: number
  fz: number
  lo: number
  way: RoadWay
  at: RoadSample
}

interface Delineator extends Site {
  orange: boolean
}

interface Sign extends Site {
  kind: 'stop' | 'speed' | 'warn'
}

interface Signal extends Site {
  /** the approach belongs to the junction's major road: green lit (the minors show red) */
  major: boolean
}

/** a way's guardrail: the walked samples and, per side, what each sample wants (0 none, 1 rail, 2 rail where the embankment test passes) */
interface RailWay {
  way: RoadWay
  samples: RoadSample[]
  want: [Uint8Array, Uint8Array]
}

interface BlockPlan {
  /** packed (rail way index, sample index): the quad from sample i to i + 1 and the post at i */
  rails: number[]
  delineators: Delineator[]
  mirrors: Site[]
  signs: Sign[]
  signals: Signal[]
  /** utility-pole indices (outskirts.ts utilityPoles) that carry a can */
  cans: number[]
}

/** the mouth windows of a way: [s0, s1] and the side kept clear (0 both, ±1 that side) */
interface Mouth {
  s0: number
  s1: number
  side: 0 | 1 | -1
}

function emptyBlock(): BlockPlan {
  return { rails: [], delineators: [], mirrors: [], signs: [], signals: [], cans: [] }
}

/** 2D cross in (x, z): positive when b is on the +lateral (left) side of a (road-section.ts) */
function cross(ax: number, az: number, bx: number, bz: number): number {
  return az * bx - ax * bz
}

/** the unit direction a way's body leaves a junction in, at the end whose junction s is `sJ` (≤ 0: the start, else the end) */
function bodyDir(way: RoadWay, sJ: number): [number, number] {
  const p = way.path
  const n = p.length
  const a = sJ <= 0 ? p[0]! : p[n - 1]!, b = sJ <= 0 ? p[1]! : p[n - 2]!
  const dx = b.x - a.x, dz = b.z - a.z
  const l = Math.hypot(dx, dz) || 1
  return [dx / l, dz / l]
}

/**
 * Where the roadside runs must stay clear of the junctions on `way`: at the way's own ends
 * (both sides, the major's half-width + MOUTH_PAD from the junction point) and, where another
 * road ENDS on this way, that road's half-width + MOUTH_PAD on its side; a road crossing through
 * clears both sides.
 */
function mouthWindows(way: RoadWay): Mouth[] {
  const out: Mouth[] = []
  for (const jn of way.junctions) {
    if (jn.role === 'end') {
      const r = jn.j.major.hw + MOUTH_PAD
      out.push({ s0: jn.s - r, s1: jn.s + r, side: 0 })
      continue
    }
    const here = sampleAt(way, jn.s)
    for (const o of jn.j.ways) {
      if (o.way === way) continue
      const r = o.way.hw + MOUTH_PAD
      if (!o.end) {
        out.push({ s0: jn.s - r, s1: jn.s + r, side: 0 })
        continue
      }
      const [dx, dz] = bodyDir(o.way, o.s)
      out.push({ s0: jn.s - r, s1: jn.s + r, side: cross(here.tx, here.tz, dx, dz) > 0 ? 1 : -1 })
    }
  }
  return out
}

function inMouth(m: readonly Mouth[], s: number, side: 1 | -1): boolean {
  for (const w of m) if (s >= w.s0 && s <= w.s1 && (w.side === 0 || w.side === side)) return true
  return false
}

/** the other roads' widest half-width at a junction (the road an approach crosses) */
function crossingHalf(j: Junction, way: RoadWay): number {
  let hw = 0
  for (const o of j.ways) if (o.way !== way && o.way.hw > hw) hw = o.way.hw
  return hw
}

// ---------------------------------------------------------------------------------------------

/**
 * Plan the roadside furniture (the network walk, synchronous, XZ only), make the materials and
 * prototypes, and queue one deferred 'dressing' job per 1 km block. Returns the statistics the
 * jobs fill in; they are also on `ctx.farField.group.userData.roadFurniture` for the offline
 * harness. Call it LAST in `buildSurroundings`: the transformer cans read the utility-pole plan.
 */
export function buildRoadFurniture(ctx: EnvBuildContext): RoadFurnitureStats {
  const t0 = performance.now()
  const { terrain, ground, quality: q, farField, assets } = ctx
  const F = ROAD_FURNITURE
  const G = F.guardrail, D = F.delineator, M = F.mirror, S = F.sign, L = F.signal
  const dens = Math.max(0.05, q.farField.roads.furniture)
  const grid: GridShape = terrain.grid()
  const rule: SiteRule = { ground, grid, projections: 0 }
  const net = roadNetwork(ctx, { stepScale: q.farField.roads.stepScale, ring: q.farField.roads.ring })
  const stats: RoadFurnitureStats = {
    blocks: 0, guardrailM: 0, posts: 0, delineators: 0, mirrors: 0, signs: { stop: 0, speed: 0, warn: 0 }, signals: 0, transformers: 0, triangles: 0, packUsed: false,
    planned: { rails: 0, delineators: 0, mirrors: 0, signs: 0, signals: 0, transformers: 0 },
    planMs: 0,
  }
  farField.group.userData.roadFurniture = stats

  // --- materials and prototypes, now: the viewport's material setup and the attach hook both cover them
  const mats = makeMaterials()
  const protos = makeProtos(assets, mats)
  stats.packUsed = protos.pack.stop !== null || protos.pack.head !== null

  // --- blocks: the far field's merge blocks (farfield.ts consolidate / road-section.ts blockOf)
  const ncx = Math.max(1, Math.ceil(grid.w / FAR_CELL_M))
  const blockCols = Math.ceil(ncx / MERGE_CELLS)
  const outside = farField.outsideCell
  const blockAt = (x: number, z: number): number => {
    const cell = farField.cellOf(x, z)
    return cell === outside ? -1 : Math.floor((cell % ncx) / MERGE_CELLS) + Math.floor(cell / ncx / MERGE_CELLS) * blockCols
  }
  const blocks = new Map<number, BlockPlan>()
  const blockOf = (x: number, z: number): BlockPlan | null => {
    const b = blockAt(x, z)
    if (b < 0) return null
    let p = blocks.get(b)
    if (!p) blocks.set(b, (p = emptyBlock()))
    return p
  }

  const railWays: RailWay[] = []
  const tertiaryRank = ROAD_SECTION.rank.tertiary!
  const site = (way: RoadWay, s: RoadSample, lateral: number, fx: number, fz: number): Site => {
    const [x, z] = offsetAt(s, lateral)
    return { x, z, fx, fz, lo: s.dLo - Math.abs(lateral), way, at: s }
  }
  /** the front of an element facing traffic that travels in direction d along the way */
  const facing = (s: RoadSample, d: 1 | -1): [number, number] => [-d * s.tx, -d * s.tz]

  for (const way of net.ways) {
    if (!way.inGrid || way.samples.length < 2 || way.length < 1) continue
    const mouths = mouthWindows(way)
    const hw = way.hw
    const rank = way.section.rank
    const id = way.row.id

    // --- a. guardrail --------------------------------------------------------------------------
    const continuous = G.continuous.includes(way.kind)
    const tertiary = way.kind === 'tertiary'
    if ((continuous || tertiary) && !way.bridge) {
      const samples = walk(way, G.pitch, 0)
      const last = samples[samples.length - 1]
      if (last && way.length - last.s > 1) samples.push(sampleAt(way, way.length))
      const want: [Uint8Array, Uint8Array] = [new Uint8Array(samples.length), new Uint8Array(samples.length)]
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i]!
        for (const side of [1, -1] as const) {
          const k = side > 0 ? 0 : 1
          if (inMouth(mouths, s.s, side)) continue
          if (continuous) want[k][i] = 1
          else {
            // tertiary: the outside of a tight fillet (the side away from the arc's centre), else the embankment test
            let inCurve = false
            for (const a of way.arcs) {
              if (a.R >= G.curveR || s.s < a.s0 - G.curvePad || s.s > a.s1 + G.curvePad) continue
              // the outside of the bend is the side away from the arc's centre
              const outer: 1 | -1 = cross(s.tx, s.tz, a.centre[0] - s.x, a.centre[1] - s.z) > 0 ? -1 : 1
              if (outer === side) inCurve = true
            }
            want[k][i] = inCurve ? 1 : 2
          }
        }
      }
      const wi = railWays.length
      railWays.push({ way, samples, want })
      for (let i = 0; i + 1 < samples.length; i++) {
        const s = samples[i]!
        if (!want[0][i] && !want[1][i]) continue
        const b = blockOf(s.x, s.z)
        if (!b) continue
        b.rails.push(wi * 65536 + i)
        stats.planned.rails++
      }
    }

    // --- b. delineators -------------------------------------------------------------------------
    if (D.kinds.includes(way.kind) && !way.bridge) {
      const orangeRight = way.section.oneway && way.kind === 'trunk'
      let s = (D.pitchStraight / dens) / 2
      while (s <= way.length) {
        const sm = sampleAt(way, s)
        const R = sm.curvature !== 0 ? 1 / Math.abs(sm.curvature) : Infinity
        const pitch = (R < D.curveR ? Math.max(12, Math.min(D.pitchStraight, R / 6)) : D.pitchStraight) / dens
        for (const side of [1, -1] as const) {
          if (inMouth(mouths, s, side)) continue
          const [x, z] = offsetAt(sm, side * (hw + 0.5))
          const b = blockOf(x, z)
          if (!b) continue
          // the disc faces along the road (the traffic sees its face); orange on the median side of a one-way trunk
          b.delineators.push({ x, z, fx: sm.tx, fz: sm.tz, lo: sm.dLo - hw - 0.5, way, at: sm, orange: orangeRight && side < 0 })
          stats.planned.delineators++
        }
        s += pitch
      }
    }

    // --- c. curve mirrors: kept corners of the minor classes ---------------------------------------
    if (way.kind === 'tertiary' || way.kind === 'unclassified' || way.kind === 'residential') {
      const pts = way.pts
      const minKink = (M.kinkDeg * Math.PI) / 180
      for (let k = 1; k < pts.length - 1; k++) {
        const a = pts[k - 1]!, p = pts[k]!, c = pts[k + 1]!
        const u1x = p[0] - a[0], u1z = p[1] - a[1], u2x = c[0] - p[0], u2z = c[1] - p[1]
        const l1 = Math.hypot(u1x, u1z), l2 = Math.hypot(u2x, u2z)
        if (l1 < 1e-6 || l2 < 1e-6) continue
        const cr = cross(u1x / l1, u1z / l1, u2x / l2, u2z / l2)
        const phi = Math.atan2(Math.abs(cr), (u1x * u2x + u1z * u2z) / (l1 * l2))
        if (phi < minKink) continue
        // a junction vertex is the mouth rule's; otherwise the corner is either KEPT (a path vertex
        // sits on it — the network only fillets when R ≥ hw + verge + 0.5, so a corner with short
        // legs stays sharp) or a tight fillet (R ≤ the residential rMax: still a blind bend); a
        // wide fillet is a sweep no one puts a mirror on
        if (way.junctions.some((jn) => Math.hypot(jn.j.x - p[0], jn.j.z - p[1]) < 0.5)) continue
        const kept = way.path.find((pv) => pv.arc < 0 && Math.hypot(pv.x - p[0], pv.z - p[1]) < 0.05)
        const arc = kept ? null : way.arcs.find((f) => f.R <= MIRROR_MAX_R && Math.hypot(f.corner[0] - p[0], f.corner[1] - p[1]) < 0.05)
        if (!kept && !arc) continue
        const sC = kept ? kept.s : (arc!.s0 + arc!.s1) / 2
        if (hash01(id, sC) >= dens) continue
        const sm = sampleAt(way, sC)
        // the outside of the corner: a left turn (cr > 0) has its outside on the right
        const outer: 1 | -1 = cr > 0 ? -1 : 1
        const [x, z] = offsetAt(sm, outer * (hw + 1.0))
        const b = blockOf(x, z)
        if (!b) continue
        // facing the corner: back towards the road
        b.mirrors.push({ x, z, fx: -outer * sm.tz, fz: outer * sm.tx, lo: sm.dLo - hw - 1.0, way, at: sm })
        stats.planned.mirrors++
      }
    }

    // --- c'. mirrors opposite the minor mouths; d. 止まれ ---------------------------------------------
    for (const jn of way.junctions) {
      if (jn.role !== 'end' || rank < MIRROR_MINOR_MIN_RANK) continue
      const major = jn.j.major
      if (major === way || major.section.rank < MIRROR_MAJOR_MIN_RANK) continue
      const mj = jn.j.ways.find((o) => o.way === major)
      if (!mj || mj.end) continue
      if (hash01(id * 3, jn.s) >= dens) continue
      const ms = sampleAt(major, mj.s)
      const [dx, dz] = bodyDir(way, jn.s)
      const minorSide: 1 | -1 = cross(ms.tx, ms.tz, dx, dz) > 0 ? 1 : -1
      // the far verge of the major, a metre along it from the mouth's axis
      const [px, pz] = offsetAt(ms, -minorSide * (major.hw + 1.0))
      const x = px + ms.tx, z = pz + ms.tz
      const b = blockOf(x, z)
      if (!b) continue
      const tx = jn.j.x - x, tz = jn.j.z - z
      const tl = Math.hypot(tx, tz) || 1
      b.mirrors.push({ x, z, fx: tx / tl, fz: tz / tl, lo: ms.dLo - major.hw - 2.0, way: major, at: ms })
      stats.planned.mirrors++
    }
    if (rank >= STOP_SIGN_MIN_RANK && !way.bridge) {
      for (const st of way.stops) {
        if (way.junctions.some((jn) => jn.j.signal && Math.abs(jn.s - st.s) < SIGNAL_STOP_REACH)) continue
        if (hash01(id * 5, st.s) >= dens) continue
        const sPlate = st.s - st.dir * S.stopBack
        if (sPlate < 0.5 || sPlate > way.length - 0.5) continue
        const sm = sampleAt(way, sPlate)
        const [fx, fz] = facing(sm, st.dir)
        const b = blockOf(...offsetAt(sm, st.dir * (hw + 0.8)))
        if (!b) continue
        b.signs.push({ ...site(way, sm, st.dir * (hw + 0.8), fx, fz), kind: 'stop' })
        stats.planned.signs++
      }
    }

    // --- d'. speed-limit and warning signs on tertiary+ ---------------------------------------------
    if (rank >= tertiaryRank && !way.bridge) {
      const pitch = S.speedPitch / dens
      let k = 0
      for (let s = pitch / 2; s <= way.length; s += pitch, k++) {
        const sm = sampleAt(way, s)
        // facing alternates per sign on a two-way road; a one-way road's traffic travels +s
        const d: 1 | -1 = way.section.oneway || k % 2 === 0 ? 1 : -1
        const [fx, fz] = facing(sm, d)
        const b = blockOf(...offsetAt(sm, d * (hw + 0.8)))
        if (!b) continue
        b.signs.push({ ...site(way, sm, d * (hw + 0.8), fx, fz), kind: 'speed' })
        stats.planned.signs++
      }
      for (const a of way.arcs) {
        if (a.R >= S.warnR) continue
        for (const d of [1, -1] as const) {
          if (d < 0 && way.section.oneway) continue
          const s = d > 0 ? a.s0 - S.warnBefore : a.s1 + S.warnBefore
          if (s < 2 || s > way.length - 2) continue
          if (hash01(id * 7, s) >= dens) continue
          const sm = sampleAt(way, s)
          const [fx, fz] = facing(sm, d)
          const b = blockOf(...offsetAt(sm, d * (hw + 0.8)))
          if (!b) continue
          b.signs.push({ ...site(way, sm, d * (hw + 0.8), fx, fz), kind: 'warn' })
          stats.planned.signs++
        }
      }
    }
  }

  // --- e. signals: one pole + head per approach of every signalled junction ------------------------
  const unclassifiedRank = ROAD_SECTION.rank.unclassified!
  for (const j of net.junctions) {
    if (!j.signal) continue
    const hwCross = (way: RoadWay) => crossingHalf(j, way)
    for (const e of j.ways) {
      const way = e.way
      if (!way.inGrid || way.section.rank < unclassifiedRank || way.length < 3) continue
      // the approach arms: traffic on the arm before the junction travels +s (d = +1), on the arm after it −s
      const arms: (1 | -1)[] = !e.end ? [1, -1] : e.s <= 0 ? [-1] : [1]
      for (const d of arms) {
        if (d < 0 && way.section.oneway) continue
        const sPole = e.s - d * (hwCross(way) + SIGNAL_BACK)
        if (sPole < 0.5 || sPole > way.length - 0.5) continue
        const sm = sampleAt(way, sPole)
        const [fx, fz] = facing(sm, d)
        const lat = d * (way.hw + SIGNAL_LEFT)
        const b = blockOf(...offsetAt(sm, lat))
        if (!b) continue
        b.signals.push({ ...site(way, sm, lat, fx, fz), major: way === j.major })
        stats.planned.signals++
      }
    }
  }

  // --- f. transformer cans on every fourth utility pole ---------------------------------------------
  const poles = utilityPoles(ctx)
  const every = F.pole.transformerEvery
  for (let i = 0; i < poles.poles.length; i++) {
    const p = poles.poles[i]!
    if (p.idx % every !== Math.abs(p.way) % every) continue
    const b = blockOf(p.x, p.z)
    if (!b) continue
    b.cans.push(i)
    stats.planned.transformers++
  }

  // --- the jobs ------------------------------------------------------------------------------------
  const castShadow = q.farField.shadows
  const minD = ROADS.minD
  const ncz = Math.max(1, Math.ceil(grid.d / FAR_CELL_M))
  /**
   * Whether (x, z) lies on ANOTHER road's asphalt (+ ROADS.trim and a little): where a ramp
   * merges into the 中勢バイパス or two carriageways run side by side, one road's verge is the
   * other's lane, and a rail or a sign there would stand in the traffic. The candidates are the
   * ways of the 3 × 3 far-field cells around the point (a way is filed under every cell its
   * samples touch), pre-rejected by bbox; a bridge on another layer passes over or under.
   */
  const onOtherRoad = (x: number, z: number, own: RoadWay): boolean => {
    const ci = Math.floor((x - grid.x0) / FAR_CELL_M), cj = Math.floor((z - grid.z0) / FAR_CELL_M)
    for (let j = cj - 1; j <= cj + 1; j++) {
      if (j < 0 || j >= ncz) continue
      for (let i = ci - 1; i <= ci + 1; i++) {
        if (i < 0 || i >= ncx) continue
        const list = net.byCell.get(i + j * ncx)
        if (!list) continue
        for (const wi of list) {
          const w = net.ways[wi]!
          if (w === own || w.bridge !== own.bridge || w.layer !== own.layer) continue
          const r = w.hw + ASPHALT_PAD
          const bb = w.bbox
          if (x < bb[0] - r || x > bb[2] + r || z < bb[1] - r || z > bb[3] + r) continue
          const sm = w.samples
          for (let k = 0; k + 1 < sm.length; k++) {
            const a = sm[k]!, b = sm[k + 1]!
            const ex = b.x - a.x, ez = b.z - a.z
            const l2 = ex * ex + ez * ez
            if (l2 < 1e-9) continue
            const u = Math.max(0, Math.min(1, ((x - a.x) * ex + (z - a.z) * ez) / l2))
            const dx = x - (a.x + ex * u), dz = z - (a.z + ez * u)
            if (dx * dx + dz * dz < r * r) return true
          }
        }
      }
    }
    return false
  }
  /**
   * Whether the road itself is drawn beside sample `s`: the ribbon drops a whole quad (a step
   * long, the verge rows included) when any corner enters the 76 m band, so a rail that only
   * tested its own foot would run on past the asphalt's end. Both verge edges at the sample must
   * clear the band by half a ribbon step.
   */
  const stepPad = (ROADS.stepStraight * q.farField.roads.stepScale) / 2
  const roadDrawn = (s: RoadSample, way: RoadWay): boolean => {
    const reach = way.hw + ROADS.verge
    for (const lat of [reach, -reach]) {
      const [x, z] = offsetAt(s, lat)
      if (!siteOk(rule, x, z, s.dLo - reach, minD + stepPad)) return false
    }
    return true
  }
  /** the site rule for a furniture foot: the far field's (grid, minD, no drawn face), the road drawn beside it, and off every other road's asphalt */
  const siteFree = (st: Site): boolean => siteOk(rule, st.x, st.z, st.lo, minD) && roadDrawn(st.at, st.way) && !onOtherRoad(st.x, st.z, st.way)
  /** guardrail sample (rail way, i, side): the beam's base height, null where it may not stand — memoised across the blocks' jobs (a quad spans a boundary) */
  const railSite = new Map<number, number | null>()
  const railY = (wi: number, i: number, side: 1 | -1): number | null => {
    const key = (wi * 65536 + i) * 2 + (side > 0 ? 1 : 0)
    let y = railSite.get(key)
    if (y !== undefined) return y
    const rw = railWays[wi]!, s = rw.samples[i]!
    const k = side > 0 ? 0 : 1
    const w = rw.want[k][i]!
    y = null
    if (w) {
      const lat = side * (rw.way.hw + G.offset)
      const [x, z] = offsetAt(s, lat)
      if (siteOk(rule, x, z, s.dLo - Math.abs(lat), minD) && roadDrawn(s, rw.way) && !onOtherRoad(x, z, rw.way)) {
        let ok = true
        if (w === 2) {
          // the embankment rule: the ground falls more than dropM between hw + 1 and hw + 5 on this side
          const [nx, nz] = offsetAt(s, side * (rw.way.hw + 1)), [fx, fz] = offsetAt(s, side * (rw.way.hw + 5))
          ok = ground.standY(nx, nz) - ground.standY(fx, fz) > G.dropM
        }
        if (ok) y = ground.standY(x, z)
      }
    }
    railSite.set(key, y)
    return y
  }
  const stations: readonly (readonly [number, number])[] = [[0, G.beam[0]], [-G.depth, G.beam[0] + (G.beam[1] - G.beam[0]) * 0.25], [0, (G.beam[0] + G.beam[1]) / 2], [-G.depth, G.beam[0] + (G.beam[1] - G.beam[0]) * 0.75], [0, G.beam[1]]]
  const lensColours: RGB[] = [rgb(COLOUR.green), rgb(COLOUR.yellow), rgb(COLOUR.red)]
  const dim = (c: RGB): RGB => [c[0] * UNLIT, c[1] * UNLIT, c[2] * UNLIT]

  for (const [b, plan] of blocks) {
    stats.blocks++
    const name = `roadFurniture-b${b}`
    farField.defer('dressing', name, 25, () => {
      const galv = new Sink(mats.galvanised, false)
      const rail = new Sink(mats.guardrail, false)
      const paint = new Sink(mats.painted, true)
      const conc = new Sink(mats.concrete, false)
      const packSinks = new Map<string, Sink>()
      const packSink = (pm: PackMaterial): Sink => {
        let s = packSinks.get(pm.key)
        if (!s) packSinks.set(pm.key, (s = new Sink(pm.material, false)))
        return s
      }
      const js = { guardrailM: 0, posts: 0, delineators: 0, mirrors: 0, signs: { stop: 0, speed: 0, warn: 0 }, signals: 0, transformers: 0 }

      // --- guardrail: W-beam quads between consecutive samples, a post at every sample that carries a rail
      for (const packed of plan.rails) {
        const wi = Math.floor(packed / 65536), i = packed % 65536
        const rw = railWays[wi]!
        const s = rw.samples[i]!, n = rw.samples[i + 1]!
        for (const side of [1, -1] as const) {
          const ya = railY(wi, i, side), yb = railY(wi, i + 1, side)
          const postHere = ya !== null && (yb !== null || (i > 0 && railY(wi, i - 1, side) !== null))
          if (postHere) {
            const [px, pz] = offsetAt(s, side * (rw.way.hw + G.offset + 0.06))
            galv.add(protos.railPost, frame(px, ya!, pz, s.tx, s.tz))
            js.posts++
          }
          if (ya === null || yb === null) continue
          // the face looks at the road: +lateral is (tz, −tx), the road is on −side of the rail
          const out = [-side * s.tz, 0, side * s.tx]
          for (let k = 0; k + 1 < stations.length; k++) {
            const [ca, ha] = stations[k]!, [cb, hb] = stations[k + 1]!
            const a0 = offsetAt(s, side * (rw.way.hw + G.offset + ca)), a1 = offsetAt(s, side * (rw.way.hw + G.offset + cb))
            const b0 = offsetAt(n, side * (rw.way.hw + G.offset + ca)), b1 = offsetAt(n, side * (rw.way.hw + G.offset + cb))
            rail.quad([a0[0], ya + ha, a0[1]], [b0[0], yb + ha, b0[1]], [b1[0], yb + hb, b1[1]], [a1[0], ya + hb, a1[1]], out, [[s.s / G.pitch, k / 4], [n.s / G.pitch, k / 4], [n.s / G.pitch, (k + 1) / 4], [s.s / G.pitch, (k + 1) / 4]])
          }
          js.guardrailM += n.s - s.s
          // the run's last sample never comes up as `i`: its post is set from the quad that ends on it
          if (i + 2 === rw.samples.length) {
            const [px, pz] = offsetAt(n, side * (rw.way.hw + G.offset + 0.06))
            galv.add(protos.railPost, frame(px, yb, pz, n.tx, n.tz))
            js.posts++
          }
        }
      }

      // --- delineators
      for (const d of plan.delineators) {
        if (!siteFree(d)) continue
        const y = ground.standY(d.x, d.z)
        const m = frame(d.x, y, d.z, d.fx, d.fz)
        galv.add(protos.delinPost, m)
        paint.add(d.orange ? protos.delinOrange : protos.delinWhite, m)
        js.delineators++
      }

      // --- mirrors
      for (const mr of plan.mirrors) {
        if (!siteFree(mr)) continue
        const y = ground.standY(mr.x, mr.z)
        const m = frame(mr.x, y, mr.z, mr.fx, mr.fz)
        galv.add(protos.mirrorPole, m)
        paint.add(protos.mirrorDisc, m)
        conc.add(protos.footing, frame(mr.x, y, mr.z, mr.fx, mr.fz))
        js.mirrors++
      }

      // --- signs: a pole and a plate at plateH, facing the approaching driver
      for (const sg of plan.signs) {
        if (!siteFree(sg)) continue
        const y = ground.standY(sg.x, sg.z)
        const m = frame(sg.x, y, sg.z, sg.fx, sg.fz)
        if (protos.pack.pole) packSink(protos.pack.pole.mat).add(protos.pack.pole.geometry, m)
        else galv.add(protos.signPole, m)
        const packPlate = sg.kind === 'stop' ? protos.pack.stop : sg.kind === 'speed' ? protos.pack.speed : protos.pack.warn
        const mp = frame(sg.x, y + S.plateH, sg.z, sg.fx, sg.fz)
        // the plate hangs just in front of the pole (local +z is the front, the pole is at the origin)
        mp.multiply(_r.makeTranslation(0, 0, S.poleD / 2 + 0.01))
        if (packPlate) packSink(packPlate.mat).add(packPlate.geometry, mp)
        else paint.add(sg.kind === 'stop' ? protos.plateStop : sg.kind === 'speed' ? protos.plateSpeed : protos.plateWarn, mp)
        js.signs[sg.kind]++
      }

      // --- signals: the pole at the driver's left corner, the arm over the carriageway (local +x), the head under its end
      for (const sig of plan.signals) {
        if (!siteFree(sig)) continue
        const y = ground.standY(sig.x, sig.z)
        const m = frame(sig.x, y, sig.z, sig.fx, sig.fz)
        galv.add(protos.signalPole, m)
        conc.add(protos.footing, frame(sig.x, y, sig.z, sig.fx, sig.fz))
        const [hw, , hd] = L.head
        const headM = frame(sig.x, y, sig.z, sig.fx, sig.fz).multiply(_r.makeTranslation(L.arm - hw / 2, SIGNAL_ARM_Y - SIGNAL_ARM_R, 0))
        if (protos.pack.head) packSink(protos.pack.head.mat).add(protos.pack.head.geometry, headM)
        else {
          paint.add(protos.signalHead, headM)
          // lenses on the front face, from the driver's view left to right: green, yellow, red
          for (let k = 0; k < 3; k++) {
            const lit = sig.major ? k === 0 : k === 2
            const colour = lit ? lensColours[k]! : dim(lensColours[k]!)
            const lm = frame(sig.x, y, sig.z, sig.fx, sig.fz).multiply(_r.makeTranslation(L.arm - hw / 2 + (k - 1) * SIGNAL_LENS_PITCH, SIGNAL_ARM_Y - SIGNAL_ARM_R - L.head[1] / 2, hd / 2 + 0.005))
            paint.add(protos.lens, lm, colour)
          }
        }
        if (protos.pack.pedestrian) {
          // on the pole at 2.5 m, facing across the road (the pedestrians on the far corner)
          const pm = frame(sig.x, y, sig.z, sig.fx, sig.fz).multiply(_r.makeTranslation(L.poleD / 2 + 0.05, 2.5, 0)).multiply(_r.makeRotationY(-Math.PI / 2))
          packSink(protos.pack.pedestrian.mat).add(protos.pack.pedestrian.geometry, pm)
        }
        // the controller cabinet beside the pole, away from the road
        const cm = frame(sig.x, y, sig.z, sig.fx, sig.fz).multiply(_r.makeTranslation(-0.7, 0, 0))
        if (protos.pack.cabinet) packSink(protos.pack.cabinet.mat).add(protos.pack.cabinet.geometry, cm)
        else paint.add(protos.cabinet, cm)
        js.signals++
      }

      // --- transformer cans on the road side of the pole (the plan's normal points away from the road)
      for (const i of plan.cans) {
        const y = poles.y(i)
        if (y === null) continue
        const p = poles.poles[i]!
        const cx = p.x - p.nx * CAN_OFF, cz = p.z - p.nz * CAN_OFF
        // the bracket runs back to the pole: local −z towards the pole means the front (+z) faces away from it
        paint.add(protos.can, frame(cx, y + CAN_Y, cz, -p.nx, -p.nz))
        js.transformers++
      }

      stats.guardrailM += js.guardrailM
      stats.posts += js.posts
      stats.delineators += js.delineators
      stats.mirrors += js.mirrors
      stats.signs.stop += js.signs.stop
      stats.signs.speed += js.signs.speed
      stats.signs.warn += js.signs.warn
      stats.signals += js.signals
      stats.transformers += js.transformers

      const root = new THREE.Group()
      root.name = name
      let tris = 0
      const emit = (sink: Sink, suffix: string, cast: boolean) => {
        const geo = sink.build()
        if (!geo) return
        const mesh = new THREE.Mesh(geo, sink.material)
        mesh.name = `${name}-${suffix}`
        mesh.castShadow = cast
        mesh.receiveShadow = true
        root.add(mesh)
        tris += sink.triangles
      }
      // only the beam casts: posts, discs and plates are under a texel of the 900 m cascade and would flicker
      emit(rail, 'rail', castShadow)
      emit(galv, 'steel', false)
      emit(paint, 'painted', false)
      emit(conc, 'concrete', false)
      let k = 0
      for (const s of packSinks.values()) emit(s, `pack${k++}`, false)
      if (!root.children.length) return null
      stats.triangles += tris
      root.userData.furniture = { ...js, block: b, triangles: tris, guardrailM: Math.round(js.guardrailM) }
      farField.register({ kind: 'furniture', name, levels: [{ object: root, range: F.range }] })
      return root
    })
  }

  stats.planMs = performance.now() - t0
  if (import.meta.dev) console.info(`[road-furniture] ${stats.blocks} blocks: ${stats.planned.rails} rail samples, ${stats.planned.delineators} delineators, ${stats.planned.mirrors} mirrors, ${stats.planned.signs} signs, ${stats.planned.signals} signal approaches, ${stats.planned.transformers} transformer cans planned in ${stats.planMs.toFixed(0)} ms (density ${dens}${stats.packUsed ? ', erikkinc pack' : ', procedural plates'})`)
  return stats
}
