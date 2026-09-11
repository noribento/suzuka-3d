import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { alongAt, COLOURS, SEAT_CAPACITY, SEAT_PITCH, STANDS, type AlongTrack, type SeatKind, type StandDef, type StandRoof, type StandTier } from '~/data/suzuka-facilities-spec'
import { OSM_STANDS, osmFeature, type OsmFeature } from '~/data/suzuka-facilities'
import { BASINS } from '~/data/suzuka-barriers-spec'
import { forwardDelta, signedDelta, type Track } from '~/sim/track'
import type { EnvBuildContext } from './environment'
import type { Ground } from './ground'
import { bucketedInstancedMeshes } from './instancing'
import { pbrFromAssets } from './materials'
import { demFieldFor } from './dem'
import { boardTexture, cached, canvas, concreteMaps, makeTexture, scaled as texSize } from './textures'
import { buildBanks, type BankStats } from './banks'

/**
 * Grandstands generated from the real footprints (OSM, ./suzuka-facilities.ts) and the
 * hand-authored section data (rows, tread, riser, structure, colours — ./suzuka-facilities-spec.ts).
 *
 * Every stand is swept along the track in (s, lateral) so it follows the road's curvature and
 * gradient like the real ones; only the three Q2 bars inside the chicane (where the nearest-
 * segment mapping folds) are built in a local frame from their EN polygons. Per tier the
 * stepped deck is one profile ribbon (tread, riser, duplicated crease edges for hard normals),
 * cut along s into seat blocks and stair aisles; vertex colours carry the tread / riser /
 * aisle tints and an analytic ambient occlusion under overhead slabs. The structure below the
 * deck depends on the stand type: `terrace` (RC on an embankment: solid skirts and end walls),
 * `frame` (columns, a deck soffit and an open undercroft), `scaffold` (tubular lattice, steel
 * deck, corrugated back wall). Chairs are instanced per 60 m bay (high tier only), benches are
 * long planks merged per stand. The generator returns every seat position so the crowd sits
 * where the seats are.
 *
 * Shadow policy: decks, skirts, roofs and building shells cast + receive; seats, benches, rails,
 * tubes and glass receive only.
 */

export interface SeatSlot {
  standId: string
  tierId: string
  /** 0-based row from the front */
  row: number
  /** track coordinates (for the Q2 bars in the fold these are approximate: bucketing only) */
  s: number
  lateral: number
  /** world position of the seat on the tread */
  x: number
  y: number
  z: number
  /** yaw (atan2(x, z) of the facing direction) — the figures look towards the track */
  yaw: number
  /** 'lawn' = a place on a spectator bank (banks.ts), not a seat */
  kind: SeatKind | 'lawn'
}

/** What the stand generator measured — `Environment.stats`, the e2e suite and the Node probes read it. */
export interface StandsStats {
  seats: {
    /** slots handed to the crowd (lawn places included) */
    total: number
    /** per stand: the generator's own count and what survived the capacity clamp */
    byStand: Record<string, { generated: number; kept: number }>
    /** the SEAT_CAPACITY rows with the count they clamped */
    capacity: { stands: string[]; seats: number; generated: number; kept: number }[]
  }
  /** stands that built a roof */
  roofs: string[]
  /** stands built along their OSM front edge (StandDef.path) */
  pathStands: string[]
  /** per stand: the first deck triangle faces up (a path frame on the wrong side folds the deck under) */
  deckUp: Record<string, boolean>
  banks: BankStats
}

export interface Stands {
  seats: SeatSlot[]
  stats: StandsStats
  /** per frame: instanced seats / scaffold tubes of bays beyond their LOD distance stop drawing */
  update: (cameraPos: THREE.Vector3) => void
}

type Fn = (u: number) => number
type RGB = [number, number, number]

/** A sweep frame: (u along, v across, y above the local surface) → world. */
interface Frame {
  u0: number
  len: number
  at: (u: number, v: number, y: number, out: THREE.Vector3) => THREE.Vector3
  /** rotation with local +X = across (+v), +Y up, +Z along (+u) */
  quat: (u: number, out: THREE.Quaternion) => THREE.Quaternion
  /** ground height at (u, v) relative to the frame surface there */
  ground: (u: number, v: number) => number
  /** yaw of "looking towards the track" for a stand on `side` */
  facingYaw: (u: number, side: 1 | -1) => number
  /** lap position for bay bucketing */
  sAt: (u: number) => number
}

interface Edge {
  v: Fn
  y: Fn
  /** across texture coordinate (metres) */
  tex: number
  rgb: RGB
}

const _p = new THREE.Vector3()
const _p2 = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _m = new THREE.Matrix4()
const _c = new THREE.Color()
const _one = new THREE.Vector3(1, 1, 1)
const Y_UP = new THREE.Vector3(0, 1, 0)

/** bay length for the instanced seats / tubes / crowd (metres along the stand) */
export const STAND_BAY = 60
const SEAT_LOD = 260
const TUBE_LOD = 420
/**
 * Bench planks read as pale sage green in every stand photo (off_c_08, off_b2_03, off_d_seat,
 * off_e_seat): the spec's tan / grey values are shaded-side measurements, so the lit albedo is
 * taken from the photos. A1 keeps its darker green and the scaffold stands their grey.
 */
const BENCH_GREEN = '#a8bfa4'

// ---------------------------------------------------------------------------------------------
// colours

function lin(hex: string | number): RGB {
  _c.set(hex)
  return [_c.r, _c.g, _c.b]
}

function scaled(rgb: RGB, k: number): RGB {
  return [rgb[0] * k, rgb[1] * k, rgb[2] * k]
}

/** Vertex tint that multiplies a texture of average albedo `avg` up to the wanted albedo. */
function tint(hex: string, avg: RGB): RGB {
  const c = lin(hex)
  return [c[0] / avg[0], c[1] / avg[1], c[2] / avg[2]]
}

// ---------------------------------------------------------------------------------------------
// geometry helpers (profileRibbonGeometry / wallGeometry generalised to a frame callback, with a
// colour attribute, so the Q2 bars in the fold share the code with the track-swept stands)

function withColor(g: THREE.BufferGeometry, rgb: RGB): THREE.BufferGeometry {
  const n = (g.attributes.position as THREE.BufferAttribute).count
  const col = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    col[i * 3] = rgb[0]
    col[i * 3 + 1] = rgb[1]
    col[i * 3 + 2] = rgb[2]
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3))
  return g
}

/**
 * Ribbon with an arbitrary cross-section swept along u. Edges must be ordered by increasing v
 * for the surface to face up (+lateral is left of the track, so right-side stands reverse their
 * edge lists). `ao(u, v, y)` darkens the vertex colour. Duplicated edges make creases: the
 * degenerate quad between them has no area, so computeVertexNormals keeps the face normals.
 */
function sweep(frame: Frame, u0: number, len: number, edges: Edge[], step: number, texScale: number, ao?: (u: number, v: number, y: number) => number): THREE.BufferGeometry {
  const segs = Math.max(1, Math.ceil(len / step))
  const E = edges.length
  const pos = new Float32Array((segs + 1) * E * 3)
  const uv = new Float32Array((segs + 1) * E * 2)
  const col = new Float32Array((segs + 1) * E * 3)
  const idx: number[] = []
  let k = 0
  for (let i = 0; i <= segs; i++) {
    const d = (i / segs) * len
    const u = u0 + d
    for (let e = 0; e < E; e++) {
      const ed = edges[e]!
      const v = ed.v(u), y = ed.y(u)
      frame.at(u, v, y, _p)
      pos[k * 3] = _p.x
      pos[k * 3 + 1] = _p.y
      pos[k * 3 + 2] = _p.z
      uv[k * 2] = ed.tex * texScale
      uv[k * 2 + 1] = d * texScale
      const a = ao ? ao(u, v, y) : 1
      col[k * 3] = ed.rgb[0] * a
      col[k * 3 + 1] = ed.rgb[1] * a
      col[k * 3 + 2] = ed.rgb[2] * a
      k++
    }
    if (i < segs) {
      for (let e = 0; e < E - 1; e++) {
        const a = i * E + e
        // (forward, then across towards +v) is counter-clockwise seen from above
        idx.push(a, a + E, a + 1, a + 1, a + E, a + E + 1)
      }
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  g.setAttribute('color', new THREE.BufferAttribute(col, 3))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

/**
 * Vertical strip along u at v(u) between two heights; `facing` +1 → normal towards +v.
 * uv: u = metres along × texScale; v = metres up × texScale, or 0..1 over `texV` metres when given
 * (a sponsor-board strip maps its whole height onto the texture).
 */
function wall(frame: Frame, u0: number, len: number, v: Fn, yBot: Fn, yTop: Fn, step: number, facing: 1 | -1, rgb: RGB, texScale: number, ao?: (u: number, v: number, y: number) => number, texV?: number): THREE.BufferGeometry {
  const segs = Math.max(1, Math.ceil(len / step))
  const pos = new Float32Array((segs + 1) * 6)
  const uv = new Float32Array((segs + 1) * 4)
  const col = new Float32Array((segs + 1) * 6)
  const idx: number[] = []
  for (let i = 0; i <= segs; i++) {
    const d = (i / segs) * len
    const u = u0 + d
    const vv = v(u)
    const yb = yBot(u), yt = yTop(u)
    for (const [j, y] of [[0, yb], [1, yt]] as const) {
      frame.at(u, vv, y, _p)
      const k = i * 2 + j
      pos[k * 3] = _p.x
      pos[k * 3 + 1] = _p.y
      pos[k * 3 + 2] = _p.z
      uv[k * 2] = d * texScale
      uv[k * 2 + 1] = texV ? (y - yb) / texV : (y - yb) * texScale
      const a = ao ? ao(u, vv, y) : 1
      col[k * 3] = rgb[0] * a
      col[k * 3 + 1] = rgb[1] * a
      col[k * 3 + 2] = rgb[2] * a
    }
    if (i < segs) {
      const a = i * 2
      if (facing > 0) idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
      else idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  g.setAttribute('color', new THREE.BufferAttribute(col, 3))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

/**
 * Filled cross-section at u: the polygon (v, y) → a flat wall facing +u (`facing` 1) or −u.
 * Vertices are placed through the frame so the wall meets the swept deck exactly, whatever the
 * camber; the normal is the constant along-direction.
 */
function endWall(frame: Frame, u: number, poly: [number, number][], facing: 1 | -1, rgb: RGB, texScale: number): THREE.BufferGeometry | null {
  if (poly.length < 3) return null
  const shape = new THREE.Shape()
  poly.forEach(([v, y], i) => (i ? shape.lineTo(facing * v, y) : shape.moveTo(facing * v, y)))
  const g = new THREE.ShapeGeometry(shape)
  const pos = g.attributes.position as THREE.BufferAttribute
  const nrm = g.attributes.normal as THREE.BufferAttribute
  const uv = g.attributes.uv as THREE.BufferAttribute
  frame.at(u, 0, 0, _p)
  frame.at(u + 1, 0, 0, _p2)
  _p2.sub(_p).setY(0).normalize().multiplyScalar(facing)
  for (let i = 0; i < pos.count; i++) {
    const v = pos.getX(i) * facing, y = pos.getY(i)
    frame.at(u, v, y, _p)
    pos.setXYZ(i, _p.x, _p.y, _p.z)
    nrm.setXYZ(i, _p2.x, _p2.y, _p2.z)
    uv.setXY(i, v * texScale, y * texScale)
  }
  return withColor(g, rgb)
}

/** Box of `sx` across × `sy` high × `sz` along, standing on y at (u, v), oriented by the frame. */
function box(frame: Frame, u: number, v: number, y: number, sx: number, sy: number, sz: number, rgb: RGB, texScale = 0.25): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(sx, sy, sz)
  const uv = g.attributes.uv as THREE.BufferAttribute
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * sx * texScale, uv.getY(i) * sy * texScale)
  frame.at(u, v, y + sy / 2, _p)
  frame.quat(u, _q)
  g.applyMatrix4(_m.compose(_p, _q, _one))
  return withColor(g, rgb)
}

/** Unit-cylinder instance matrix from world point a to b (the tube prototype is 1 m along +Y). */
function tubeMatrix(a: THREE.Vector3, b: THREE.Vector3): THREE.Matrix4 {
  _p2.copy(b).sub(a)
  const len = _p2.length()
  _p2.normalize()
  _q.setFromUnitVectors(Y_UP, _p2)
  _p.copy(a).add(b).multiplyScalar(0.5)
  return new THREE.Matrix4().compose(_p, _q, new THREE.Vector3(1, len, 1))
}

/**
 * A stand's `ground` is the analytic height field (ground.field), not the drawn faces: the
 * stands define the relief the field carries, their skirts and end walls are sized to reach below
 * it, and under a deck beyond the drawn extent the terrain mesh is not cut until every stand is
 * built (clampUnder), so the drawn ground is not yet what it will be.
 */
function trackFrame(track: Track, ground: Ground, s0: number, s1: number): Frame {
  const len = forwardDelta(s0, s1, track.length) || track.length
  return {
    u0: s0,
    len,
    at: (u, v, y, out) => track.pointAt(u, v, out, y),
    quat: (u, out) => {
      const h = track.headingAt(u)
      _m.makeBasis(new THREE.Vector3(h.tz, 0, -h.tx), Y_UP, new THREE.Vector3(h.tx, 0, h.tz))
      return out.setFromRotationMatrix(_m)
    },
    ground: (u, v) => ground.field.yAt(u, v) - track.pointAt(u, v, _p2, 0).y,
    facingYaw: (u, side) => {
      const h = track.headingAt(u)
      return Math.atan2(-side * h.tz, side * h.tx)
    },
    sAt: (u) => track.wrap(u),
  }
}

/**
 * Straight frame on an EN footprint: `origin` (world, y = the reference surface height) at the
 * start of the front edge, `along` the unit direction of the front edge, `back` the unit
 * direction towards the rear. Used for the Q2 bars in the figure-8 fold.
 */
function localFrame(ground: Ground, origin: THREE.Vector3, along: THREE.Vector3, back: THREE.Vector3, len: number, sApprox: number): Frame {
  const quat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(back, Y_UP, along))
  const yaw = Math.atan2(-back.x, -back.z)
  return {
    u0: 0,
    len,
    at: (u, v, y, out) => {
      out.copy(origin).addScaledVector(along, u).addScaledVector(back, v)
      out.y += y
      return out
    },
    quat: (_u, out) => out.copy(quat),
    ground: (u, v) => {
      _p2.copy(origin).addScaledVector(along, u).addScaledVector(back, v)
      return ground.field.y(_p2.x, _p2.z) - origin.y
    },
    facingYaw: () => yaw,
    sAt: (u) => sApprox + u - len / 2,
  }
}

// ---------------------------------------------------------------------------------------------
// path frames (StandDef.path): a stand built along the curve of its OSM front edge

/**
 * A stand whose rows follow its real front edge. `u` is arc length along that edge (in driving
 * order), `v` the distance behind it along the local inward normal, and heights ride on the road.
 *
 * A terrace on the INSIDE of a bend cannot be swept in (s, lateral): C's Esses end faces T3 (R
 * 44–68 m) and E-2 sits inside NIPPO (R 49–109 m), so rows beyond the bend's radius fold over
 * themselves. The first fix was a straight chord, but the real terraces are gentle fans — E's
 * front is an arc of R ≈ 100–320 m — and a straight slab crossed it, which is what left the E-1 /
 * E-2 wedge the 2026-09 audit reported. Rows concentric with the front edge hold as long as the
 * edge's radius stays well above the seating depth, which the audit measured for every path stand.
 */
interface PathSpec {
  /** resampled front edge (world, y = 0) and its inward unit normals */
  px: Float32Array
  pz: Float32Array
  nx: Float32Array
  nz: Float32Array
  /** arc length at each sample */
  us: Float32Array
  len: number
  /** front / back offsets from the path as (u, v) polylines */
  frontV: [number, number][]
  backV: [number, number][]
  sOf: (u: number) => number
  uOf: (s: number) => number
  yRef: (u: number) => number
  /** world → (u, v) on the path, with the nearest-segment distance */
  project: (x: number, z: number) => { u: number; v: number; d: number }
  at: (u: number, v: number, out: THREE.Vector3) => THREE.Vector3
  quatAt: (u: number, out: THREE.Quaternion) => THREE.Quaternion
  yaw: (u: number) => number
  box: [number, number, number, number]
  /** unit tangents (xz) at u = 0 and u = len, both pointing towards increasing u */
  tan0: [number, number]
  tan1: [number, number]
}

const _pp = new THREE.Vector3()
const pathCache = new WeakMap<Track, Map<string, PathSpec | null>>()

function pathSpec(track: Track, def: StandDef): PathSpec | null {
  if (!def.path) return null
  let cache = pathCache.get(track)
  if (!cache) pathCache.set(track, (cache = new Map()))
  const hit = cache.get(def.id)
  if (hit !== undefined) return hit
  const feat = OSM_STANDS.find((f) => f.id === def.osmWays[0])
  const spec = feat ? buildPathSpec(track, def, feat) : null
  cache.set(def.id, spec)
  return spec
}

function buildPathSpec(track: Track, def: StandDef, feat: OsmFeature): PathSpec {
  const pts = feat.en.map(([e, n]) => track.enToWorld(e, n, new THREE.Vector3()))
  const n = pts.length
  const ring = (i0: number, i1: number) => {
    const out: THREE.Vector3[] = []
    const end = ((i1 % n) + n) % n
    for (let i = ((i0 % n) + n) % n; ; i = (i + 1) % n) {
      out.push(pts[i]!)
      if (i === end) break
    }
    return out
  }
  const L = track.length
  const [s0, s1] = def.sRange
  const span = forwardDelta(s0, s1, L) || L
  /** s of a world point on this stand's own stretch of road */
  const sAtWorld = (p: THREE.Vector3) => track.nearestOnRange(p.x, p.z, s0, s1, 120).s
  let front = ring(def.path!.front[0], def.path!.front[1])
  // orient the chain with the lap: u must grow in driving order. Signed, not forward: a first
  // vertex a few centimetres before sRange[0] wraps to nearly a full lap and reverses the path.
  if (signedDelta(sAtWorld(front[0]!), sAtWorld(front[front.length - 1]!), L) < 0) front = front.reverse()
  // ...then AGAINST it on a right-side stand: `sweep` faces up only while +v lies to the left of
  // +u, and a right-side stand's rows lie to the right of the driving direction. u runs the
  // other way there (pathLocalDef sorts the mapped breakpoints), the deck comes out facing up
  if (def.side < 0) front = front.reverse()
  // resample the chain through a Catmull-Rom every 2 m
  const raw = front
  const sx: number[] = []
  const sz: number[] = []
  const cr = (a: number, b: number, c: number, d: number, t: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t)
  for (let i = 0; i < raw.length - 1; i++) {
    const p0 = raw[Math.max(0, i - 1)]!, p1 = raw[i]!, p2 = raw[i + 1]!, p3 = raw[Math.min(raw.length - 1, i + 2)]!
    const segs = Math.max(1, Math.round(p1.distanceTo(p2) / 2))
    for (let k = 0; k < segs; k++) {
      const t = k / segs
      sx.push(cr(p0.x, p1.x, p2.x, p3.x, t))
      sz.push(cr(p0.z, p1.z, p2.z, p3.z, t))
    }
  }
  sx.push(raw[raw.length - 1]!.x)
  sz.push(raw[raw.length - 1]!.z)
  const m = sx.length
  const px = Float32Array.from(sx), pz = Float32Array.from(sz)
  const us = new Float32Array(m)
  for (let i = 1; i < m; i++) us[i] = us[i - 1]! + Math.hypot(px[i]! - px[i - 1]!, pz[i]! - pz[i - 1]!)
  const len = us[m - 1]!
  // inward normal: perpendicular to the tangent, pointing at the BACK edge of the footprint
  const backChain = ring(def.path!.back[0], def.path!.back[1])
  const nx = new Float32Array(m), nz = new Float32Array(m)
  for (let i = 0; i < m; i++) {
    const a = Math.max(0, i - 1), b = Math.min(m - 1, i + 1)
    const tx = px[b]! - px[a]!, tz = pz[b]! - pz[a]!
    const inv = 1 / (Math.hypot(tx, tz) || 1)
    nx[i] = -tz * inv
    nz[i] = tx * inv
  }
  // Keep the normals on ONE side of the path first: deciding the side per sample flips the normal
  // wherever a long, thin footprint bends, which folds the rows back over the track.
  for (let i = 1; i < m; i++) {
    if (nx[i]! * nx[i - 1]! + nz[i]! * nz[i - 1]! < 0) { nx[i] = -nx[i]!; nz[i] = -nz[i]! }
  }
  const idxOf = (u: number) => {
    const t = Math.min(len, Math.max(0, u))
    let lo = 0, hi = m - 1
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1
      if (us[mid]! <= t) lo = mid
      else hi = mid
    }
    return { i: lo, f: (t - us[lo]!) / Math.max(1e-6, us[lo + 1]! - us[lo]!) }
  }
  const at = (u: number, v: number, out: THREE.Vector3) => {
    const { i, f } = idxOf(u)
    const j = Math.min(m - 1, i + 1)
    const x = px[i]! * (1 - f) + px[j]! * f
    const z = pz[i]! * (1 - f) + pz[j]! * f
    const ux = nx[i]! * (1 - f) + nx[j]! * f
    const uz = nz[i]! * (1 - f) + nz[j]! * f
    const inv = 1 / (Math.hypot(ux, uz) || 1)
    return out.set(x + ux * inv * v, 0, z + uz * inv * v)
  }
  const project = (x: number, z: number) => {
    let bu = 0, bv = 0, bd = Infinity
    for (let i = 0; i < m - 1; i++) {
      const ax = px[i]!, az = pz[i]!
      const dx = px[i + 1]! - ax, dz = pz[i + 1]! - az
      const l2 = dx * dx + dz * dz || 1
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2))
      const qx = ax + dx * t, qz = az + dz * t
      const d = Math.hypot(x - qx, z - qz)
      if (d < bd) {
        bd = d
        bu = us[i]! + t * (us[i + 1]! - us[i]!)
        const ux = nx[i]!, uz = nz[i]!
        bv = (x - qx) * ux + (z - qz) * uz
      }
    }
    return { u: bu, v: bv, d: bd }
  }
  // ...then point that side at the seating, by a VOTE of the declared back edge's own vertices.
  // A single test point does not do: a mean, whether of the footprint or of the back chain alone,
  // lands on the CONCAVE side of a curved terrace and so in front of its own front edge — I's
  // banana on the outside of the hairpin measured that way and came out with no back at all.
  {
    let vote = 0
    for (const q of backChain) vote += project(q.x, q.z).v
    if (vote < 0) for (let i = 0; i < m; i++) { nx[i] = -nx[i]!; nz[i] = -nz[i]! }
  }
  /** chain → (u, v) polyline, one value per u: the outermost for the back, the nearest for the front */
  const polyline = (chain: THREE.Vector3[], pick: 'min' | 'max'): [number, number][] => {
    const out: [number, number][] = []
    for (const p of chain.map((q) => project(q.x, q.z)).sort((a, b2) => a.u - b2.u)) {
      const last = out[out.length - 1]
      if (last && p.u - last[0] < 0.05) {
        if (pick === 'max' ? p.v > last[1] : p.v < last[1]) last[1] = p.v
        continue
      }
      out.push([p.u, p.v])
    }
    return out
  }
  const frontV = polyline(front, 'min')
  // the back chain includes the two end caps, whose vertices project in front of the path (v ≤ 0)
  // or onto its ends; only what is genuinely behind the front edge bounds the seating
  const backV = polyline(backChain, 'max').filter(([, v]) => v > 2)
  // s along the lap at u, from the road nearest the path (not a linear map: the front edge and the
  // road diverge through a bend)
  const sSamples = new Float32Array(m)
  for (let i = 0; i < m; i++) sSamples[i] = track.nearestOnRange(px[i]!, pz[i]!, s0, s1, 120).s
  const sOf = (u: number) => {
    const { i, f } = idxOf(u)
    const j = Math.min(m - 1, i + 1)
    const a = sSamples[i]!, b2 = sSamples[j]!
    return track.wrap(a + signedDelta(a, b2, L) * f)
  }
  const uOf = (s: number) => {
    let best = 0, bd = Infinity
    for (let i = 0; i < m; i++) {
      const d = Math.abs(signedDelta(sSamples[i]!, s, L))
      if (d < bd) { bd = d; best = i }
    }
    return us[best]!
  }
  const yRef = (u: number) => track.pointAt(sOf(u), 0, _pp).y
  const quatAt = (u: number, out: THREE.Quaternion) => {
    const { i } = idxOf(u)
    const j = Math.min(m - 1, i + 1)
    const back = new THREE.Vector3(nx[i]!, 0, nz[i]!).normalize()
    const along = new THREE.Vector3(px[j]! - px[i]!, 0, pz[j]! - pz[i]!).normalize()
    if (along.lengthSq() < 0.5) along.set(-back.z, 0, back.x)
    return out.setFromRotationMatrix(_m.makeBasis(back, Y_UP, along))
  }
  const yawAt = (u: number) => {
    const { i } = idxOf(u)
    return Math.atan2(-nx[i]!, -nz[i]!)
  }
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (const p of pts) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z)
  }
  // unit tangents at the two ends (u increasing), for the relief zones' end fades
  const tanOf = (i: number, j: number): [number, number] => {
    const tx = px[j]! - px[i]!, tz = pz[j]! - pz[i]!
    const inv = 1 / (Math.hypot(tx, tz) || 1)
    return [tx * inv, tz * inv]
  }
  const tan0 = tanOf(0, Math.min(m - 1, 1)), tan1 = tanOf(Math.max(0, m - 2), m - 1)
  return { px, pz, nx, nz, us, len, frontV, backV, sOf, uOf, yRef, project, at, quatAt, yaw: yawAt, box: [minX, maxX, minZ, maxZ], tan0, tan1 }
}

/** The cached path frame of a stand (null when it has none) — for the relief probes. */
export function standPathSpec(track: Track, id: string): PathSpec | null {
  const def = STANDS.find((s) => s.id === id)
  return def ? pathSpec(track, def) : null
}

function pathFrame(ground: Ground, spec: PathSpec): Frame {
  return {
    u0: 0,
    len: spec.len,
    at: (u, v, y, out) => {
      spec.at(u, v, out)
      out.y = spec.yRef(u) + y
      return out
    },
    quat: (u, out) => spec.quatAt(u, out),
    // the analytic field: under the deck it is the relief (deck plane − 0.6), which is what
    // the skirts and end walls must reach below
    ground: (u, v) => {
      spec.at(u, v, _p2)
      return ground.field.y(_p2.x, _p2.z) - spec.yRef(u)
    },
    facingYaw: (u) => spec.yaw(u),
    sAt: (u) => spec.sOf(u),
  }
}

/**
 * The stand's definition re-expressed in its path frame: u for s, v for lateral (row-1 centre
 * 0.5 tread + 0.3 behind the OSM face, structure back 0.3 inside the OSM back). Tier-level
 * lateral overrides are track figures and are dropped; the s-keyed heights are mapped through uOf.
 */
function pathLocalDef(def: StandDef, spec: PathSpec): StandDef {
  const t = def.tiers[0]!.tread
  // the mapped breakpoints must rise with u: on a right-side stand u runs against the lap
  const conv = (v: AlongTrack | undefined): AlongTrack | undefined =>
    typeof v === 'number' || v === undefined ? v : v.map(([s, h]) => [spec.uOf(s), h] as [number, number]).sort((a, b) => a[0] - b[0])
  const range = (r: [number, number] | undefined): [number, number] | undefined => {
    if (!r) return undefined
    const a = spec.uOf(r[0]), b = spec.uOf(r[1])
    return [Math.min(a, b), Math.max(a, b)]
  }
  return {
    ...def,
    sRange: [0, spec.len],
    side: 1,
    lateralFront: spec.frontV.map(([u, v]) => [u, v + 0.5 * t + 0.3] as [number, number]),
    lateralBack: spec.backV.map(([u, v]) => [u, v - 0.3] as [number, number]),
    frontHeight: conv(def.frontHeight)!,
    tiers: def.tiers.map((tier) => ({
      ...tier,
      sRange: range(tier.sRange),
      lateralFront: undefined,
      frontHeight: conv(tier.frontHeight),
    })),
    roof: def.roof ? { ...def.roof, sRange: range(def.roof.sRange), blocks: def.roof.blocks?.map((r) => range(r)!) } : undefined,
  }
}

/**
 * Structure depth (row-1 centre → back of the last walkway) and rise of a stand's stacked tiers
 * at one place, clipping the rows against the footprint back `lb` the way resolveTiers does.
 */
function stackAt(def: StandDef, lfRow1: number, lb: number): { depth: number; rise: number } {
  let lf = lfRow1, rise = 0, back = lfRow1
  for (const tier of def.tiers) {
    const t = tier.tread, walk = tier.aisleAfter ?? 0.6
    const avail = lb - lf + 0.5 * t
    const rows = avail <= 0.5 * t ? 1 : Math.max(1, Math.min(tier.rows, Math.round(avail / t)))
    back = lf + rows * t - 0.5 * t + walk
    rise += rows * tier.riser
    lf = back + 0.5 * t
  }
  return { depth: back - lfRow1, rise }
}

// ---------------------------------------------------------------------------------------------
// materials

interface Mats {
  /** concrete (photo PBR or procedural) × vertex colour: decks, skirts, walls, roofs */
  terrace: THREE.MeshStandardMaterial
  /** vertex tint that brings the concrete texture to the wanted albedo */
  concreteAvg: RGB
  /** metres per concrete tile → uv scale */
  concreteTex: number
  /** untextured vertex-coloured parts: planks, rails, tubes' cousins, trusses, mullions */
  furniture: THREE.MeshStandardMaterial
  seat: THREE.MeshStandardMaterial
  tube: THREE.MeshStandardMaterial
  corrugated: THREE.MeshStandardMaterial
  corrugatedTex: number
  glass: THREE.MeshStandardMaterial
  glassTex: number
  board: THREE.MeshStandardMaterial
  /** the bilingual wayfinding atlas (one material for every board of every stand) */
  wayfinding: THREE.MeshStandardMaterial
  kiosk: THREE.MeshStandardMaterial
}

function makeMaterials(ctx: EnvBuildContext): Mats {
  const reg = ctx.assets
  const photo = (asset: string) => !!reg && reg.has(`tex/${asset}/diff`) && reg.has(`tex/${asset}/nor_gl`) && reg.has(`tex/${asset}/arm`)
  // metres per tile of a photo texture (the manifest carries it for the tiles that were measured)
  const tileOf = (asset: string, fallback: number) => (reg?.entry(`tex/${asset}/diff`) as { tile?: number } | null)?.tile ?? fallback
  const concretePhoto = photo('concrete046')
  const terrace = reg && concretePhoto
    ? pbrFromAssets(reg, 'concrete046', { fallback: () => new THREE.MeshStandardMaterial(), handBuiltUv: true, normalScale: 0.6, extra: { vertexColors: true } })
    : (() => {
        const maps = concreteMaps()
        return new THREE.MeshStandardMaterial({ map: maps.map, normalMap: maps.normalMap, normalScale: new THREE.Vector2(0.5, 0.5), roughness: 0.92, vertexColors: true })
      })()
  terrace.name = 'standConcrete'
  const corrugatedPhoto = photo('corrugatedsteel003')
  const corrugated = reg && corrugatedPhoto
    ? pbrFromAssets(reg, 'corrugatedsteel003', { fallback: () => new THREE.MeshStandardMaterial(), handBuiltUv: true })
    : new THREE.MeshStandardMaterial({ color: 0x9a9da0, roughness: 0.5, metalness: 0.6 })
  // pale green-blue glazing (panoramio 2013, img_main_v2) that reflects the sky dome. The
  // Facade001 photo (dark blue-grey panes, mean #464d53) read as a black wall on the hospitality
  // band, so it is not used here — the mullions are geometry anyway.
  const glass = new THREE.MeshStandardMaterial({ color: COLOURS.glassVip.mid, roughness: 0.15, metalness: 0.5, envMapIntensity: 1.4, side: THREE.DoubleSide })
  const seat = reg && photo('plastic013a')
    ? pbrFromAssets(reg, 'plastic013a', { fallback: () => new THREE.MeshStandardMaterial(), handBuiltUv: true, normalScale: 0.5 })
    : new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55 })
  return {
    terrace,
    // the procedural tile averages ≈ #969696; the photo tile's linear-space mean is #ceceba
    // (measured on the shipped KTX2) — the tint divides by this, so a wrong average shifts every
    // concrete surface (the old #b5b2ac guess made the piers and treads read tan)
    concreteAvg: lin(concretePhoto ? '#ceceba' : '#969696'),
    concreteTex: 1 / (concretePhoto ? tileOf('concrete046', 2.4) : 4),
    furniture: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.25 }),
    seat,
    tube: new THREE.MeshStandardMaterial({ color: 0x9da3a8, roughness: 0.45, metalness: 0.8 }),
    corrugated,
    corrugatedTex: 1 / (corrugatedPhoto ? tileOf('corrugatedsteel003', 2) : 2),
    glass,
    glassTex: 1 / 3,
    board: new THREE.MeshStandardMaterial({ map: boardTexture(), roughness: 0.5 }),
    wayfinding: new THREE.MeshStandardMaterial({ map: wayfindingTexture(), roughness: 0.6, side: THREE.DoubleSide }),
    kiosk: new THREE.MeshStandardMaterial({ color: 0xd8d6d0, roughness: 0.7 }),
  }
}

// ---------------------------------------------------------------------------------------------
// one stand

/** Everything a stand accumulates before its geometry is merged into a handful of meshes. */
interface Build {
  def: StandDef
  frame: Frame
  side: 1 | -1
  mats: Mats
  ctx: EnvBuildContext
  group: THREE.Group
  /** merged into the concrete mesh (casts) */
  terrace: THREE.BufferGeometry[]
  /** merged into the vertex-coloured furniture mesh (receives only) */
  furniture: THREE.BufferGeometry[]
  glass: THREE.BufferGeometry[]
  board: THREE.BufferGeometry[]
  /** wayfinding boards (their own atlas material) */
  signs: THREE.BufferGeometry[]
  corrugated: THREE.BufferGeometry[]
  seats: SeatSlot[]
  seatMatrices: THREE.Matrix4[]
  seatColors: THREE.Color[]
  seatS: number[]
  tubeMatrices: THREE.Matrix4[]
  tubeS: number[]
  /** canopy posts: their own LOD entry, with no distance cut (a roof must not float) */
  postMatrices: THREE.Matrix4[]
  postS: number[]
  /** deck vertices (world xyz) the terrain grid is sunk under */
  deckPts: number[]
  /**
   * Overhead slabs for the vertex AO: the lateral band at u (a canopy that follows a tier's rows
   * drifts across a curving stand) and the slab's underside height at (u, v).
   */
  overhead: { v0: Fn; v1: Fn; y: (u: number, v: number) => number }[]
  /** the first deck triangle faces up (see `firstDeckFacesUp`) */
  deckUp: boolean
}

/** Resolved geometry of one tier along its own u range. */
interface TierRun {
  tier: StandTier
  u0: number
  len: number
  /** row-1 seat centre lateral and platform height */
  lf: Fn
  h0: Fn
  /** rows actually fitting between lf and the footprint back at u (tapering stands) */
  rowsAt: Fn
  /** structure back (after the walkway) */
  vBack: Fn
  /** top level (the walkway behind the last row) */
  yTop: Fn
  walk: number
}

function aoOf(b: Build): (u: number, v: number, y: number) => number {
  if (!b.overhead.length) return () => 1
  return (u, v, y) => {
    let f = 1
    for (const o of b.overhead) {
      const a = o.v0(u), c = o.v1(u)
      const lo = Math.min(a, c), hi = Math.max(a, c)
      if (v < lo || v > hi) continue
      const gap = o.y(u, v) - y
      if (gap <= 0) continue
      // darkest right under a slab, gone 9 m below it; softer within 3 m of the slab's edges
      const edge = Math.min(1, Math.min(v - lo, hi - v) / 3)
      const k = 0.45 * Math.max(0, 1 - gap / 9) * (0.4 + 0.6 * edge)
      f = Math.min(f, 1 - k)
    }
    return f
  }
}

/**
 * Resolve the tiers of a stand into runs: explicit `lateralFront` / `frontHeight` win, a tier
 * without them that overlaps the previous one in s continues behind it (C's three tiers), and
 * one with its own s sub-range starts at the stand's own front (B2-3 / B2-1/2, D, E).
 */
function resolveTiers(b: Build): TierRun[] {
  const { def, side } = b
  const L = b.ctx.track.length
  const runs: TierRun[] = []
  const inRange = (tier: StandTier): [number, number] => tier.sRange ?? def.sRange
  let prev: TierRun | null = null
  for (const tier of def.tiers) {
    const [s0, s1] = inRange(tier)
    const u0 = s0
    const len = forwardDelta(s0, s1, L) || L
    const t = tier.tread, r = tier.riser
    let lf: Fn, h0: Fn
    const overlapsPrev = prev && tier.lateralFront === undefined && (tier.sRange === undefined || prev.tier.sRange === undefined || forwardDelta(prev.u0, s0, L) < prev.len)
    if (tier.lateralFront !== undefined) {
      const v = tier.lateralFront
      lf = (u) => alongAt(v, u, def.sRange)
    } else if (overlapsPrev && prev) {
      const p = prev
      lf = (u) => p.vBack(u) + side * (0.5 * t)
    } else {
      lf = (u) => alongAt(def.lateralFront, u, def.sRange)
    }
    if (tier.frontHeight !== undefined) {
      const v = tier.frontHeight
      h0 = (u) => alongAt(v, u, def.sRange)
    } else if (overlapsPrev && prev) {
      const p = prev
      h0 = (u) => p.yTop(u)
    } else {
      h0 = (u) => alongAt(def.frontHeight, u, def.sRange)
    }
    const walk = tier.aisleAfter ?? 0.6
    const lb: Fn = (u) => alongAt(def.lateralBack, u, def.sRange)
    const rowsAt: Fn = (u) => {
      const depth = (lb(u) - lf(u)) * side + 0.5 * t
      // a tier behind the footprint back (V1 rows 18–22 sit at the V2 front) keeps its rows
      if (depth <= 0.5 * t) return tier.lateralFront !== undefined ? tier.rows : 1
      return Math.max(1, Math.min(tier.rows, Math.round(depth / t)))
    }
    const run: TierRun = {
      tier, u0, len, lf, h0, rowsAt, walk,
      vBack: (u) => lf(u) + side * (rowsAt(u) * t - 0.5 * t + walk),
      yTop: (u) => h0(u) + rowsAt(u) * r,
    }
    runs.push(run)
    prev = run
  }
  return runs
}

/** Block or stair-aisle profile of a tier in v/y space (already ordered for the stand's side). */
function tierEdges(b: Build, run: TierRun, kind: 'block' | 'aisle'): Edge[] {
  const { side, mats } = b
  const t = run.tier.tread, r = run.tier.riser
  const rows = run.tier.rows
  const steel = b.def.structure === 'scaffold'
  const avg = mats.concreteAvg
  const seatBand = run.tier.seat === 'chair' && !b.ctx.quality.seatInstances
  const tread = steel ? tint('#6e7174', avg) : seatBand ? tint(run.tier.colour, avg) : tint(COLOURS.concrete.mid, avg)
  const treadBack = scaled(tread, 0.8)
  const riserTop = steel ? tint('#5a5d60', avg) : tint('#a5a39f', avg)
  const riserFoot = scaled(riserTop, 0.7)
  const aisle = steel ? tint('#7a7d80', avg) : tint('#c9c7c2', avg)
  const edges: { d: number; k: number; rgb: RGB; tex: number }[] = []
  const push = (d: number, k: number, rgb: RGB) => edges.push({ d, k, rgb, tex: d })
  for (let k = 0; k < rows; k++) {
    const d0 = k * t, d1 = (k + 1) * t
    if (kind === 'block') {
      push(d0, k, tread)
      push(d1, k, treadBack)
      push(d1, k, riserFoot)
      push(d1, k + 1, riserTop)
    } else {
      // two half steps per row: lighter ribbed treads
      const dm = d0 + t / 2
      push(d0, k, aisle)
      push(dm, k, aisle)
      push(dm, k, riserFoot)
      push(dm, k + 0.5, riserTop)
      push(dm, k + 0.5, aisle)
      push(d1, k + 0.5, aisle)
      push(d1, k + 0.5, riserFoot)
      push(d1, k + 1, riserTop)
    }
  }
  // the walkway behind the last row, then the back edge
  push(rows * t, rows, tread)
  push(rows * t + run.walk, rows, treadBack)
  const lf = run.lf, h0 = run.h0, rowsAt = run.rowsAt
  const out: Edge[] = edges.map((e) => ({
    // rows beyond the local footprint depth collapse onto the walkway (tapering stands)
    v: (u) => {
      const n = rowsAt(u)
      const d = e.d > n * t ? n * t + Math.max(0, e.d - rows * t) : e.d
      return lf(u) + side * (d - 0.5 * t)
    },
    y: (u) => h0(u) + Math.min(e.k, rowsAt(u)) * r,
    tex: e.tex,
    rgb: e.rgb,
  }))
  if (side < 0) out.reverse()
  return out
}

/** Along-u segments of a tier: seat blocks separated by stair aisles every `pitch`. */
function segments(run: TierRun, aisles: { pitch: number; width: number } | null): { d0: number; d1: number; kind: 'block' | 'aisle' }[] {
  const segs: { d0: number; d1: number; kind: 'block' | 'aisle' }[] = []
  if (!aisles || run.len < aisles.pitch * 1.5) return [{ d0: 0, d1: run.len, kind: 'block' }]
  const n = Math.max(1, Math.round(run.len / aisles.pitch))
  const pitch = run.len / n
  let d = 0
  for (let i = 1; i < n; i++) {
    const c = i * pitch
    segs.push({ d0: d, d1: c - aisles.width / 2, kind: 'block' })
    segs.push({ d0: c - aisles.width / 2, d1: c + aisles.width / 2, kind: 'aisle' })
    d = c + aisles.width / 2
  }
  segs.push({ d0: d, d1: run.len, kind: 'block' })
  return segs
}

function addDeck(b: Build, run: TierRun) {
  const { frame, side, mats, def } = b
  const t = run.tier.tread, r = run.tier.riser
  const ao = aoOf(b)
  const blockEdges = tierEdges(b, run, 'block')
  const aisleEdges = tierEdges(b, run, 'aisle')
  const planks = run.tier.seat === 'bench'
  const chairs = run.tier.seat === 'chair' && b.ctx.quality.seatInstances
  const plankColour = run.tier.colour === COLOURS.benchGreenA1.mid || run.tier.colour === '#9a9a96' ? run.tier.colour : BENCH_GREEN
  const plankTop = lin(plankColour)
  const plankEdge = scaled(plankTop, 0.72)
  const seatColour = new THREE.Color(run.tier.colour)
  const pitch = SEAT_PITCH[run.tier.seat]
  const facingFlip = side < 0 ? new THREE.Quaternion().setFromAxisAngle(Y_UP, Math.PI) : null
  // along-track step: the treads are flat, so only the curvature matters — every stand sits on
  // the outside of its corner (radius ≥ 60 m), where a 4 m chord is out by 3 cm. The tier that
  // instances chairs is the one with a GPU: it keeps 2 m so the vertex AO and the tapering rows
  // resolve finely; the software-rasteriser tier takes the coarser steps (half the deck triangles)
  const fine = b.ctx.quality.seatInstances
  const deckStep = fine ? 2 : 4
  const plankStep = fine ? 4 : 8
  for (const seg of segments(run, def.aisles)) {
    const u0 = run.u0 + seg.d0
    const len = seg.d1 - seg.d0
    if (len < 0.3) continue
    const g = sweep(frame, u0, len, seg.kind === 'block' ? blockEdges : aisleEdges, deckStep, mats.concreteTex, ao)
    b.terrace.push(g)
    const arr = (g.attributes.position as THREE.BufferAttribute).array as Float32Array
    for (let i = 0; i < arr.length; i++) b.deckPts.push(arr[i]!)
    if (seg.kind !== 'block') continue
    // seats: one slot per chair / bench place, rows front to back
    for (let k = 0; k < run.tier.rows; k++) {
      const yTread = (u: number) => run.h0(u) + k * r
      const vSeat = (u: number) => run.lf(u) + side * k * t
      // planks sit at the back of the tread; one per row and block, merged into the furniture
      if (planks) {
        const dA = (k + 1) * t - 0.42, dB = (k + 1) * t - 0.1
        const pe: { d: number; dy: number; rgb: RGB }[] = [
          { d: dA, dy: 0.36, rgb: plankEdge }, { d: dA, dy: 0.42, rgb: plankEdge },
          { d: dA, dy: 0.42, rgb: plankTop }, { d: dB, dy: 0.42, rgb: plankTop },
          { d: dB, dy: 0.42, rgb: plankEdge }, { d: dB, dy: 0.36, rgb: plankEdge },
        ]
        const edges: Edge[] = pe.map((e) => ({ v: (u) => run.lf(u) + side * (e.d - 0.5 * t), y: (u) => yTread(u) + e.dy, tex: e.d, rgb: e.rgb }))
        if (side < 0) edges.reverse()
        // skip planks on rows that are collapsed at both ends of this block
        if (run.rowsAt(u0) > k || run.rowsAt(u0 + len) > k) b.furniture.push(sweep(frame, u0 + 0.15, Math.max(0.3, len - 0.3), edges, plankStep, 1, ao))
      }
      const n = Math.floor((len - 0.4) / pitch)
      if (n < 1) continue
      const pad = (len - n * pitch) / 2
      for (let i = 0; i < n; i++) {
        const u = u0 + pad + (i + 0.5) * pitch
        if (run.rowsAt(u) <= k) continue
        const v = vSeat(u)
        const y = yTread(u)
        frame.at(u, v, y, _p)
        b.seats.push({ standId: def.id, tierId: run.tier.id, row: k, s: frame.sAt(u), lateral: v, x: _p.x, y: _p.y, z: _p.z, yaw: frame.facingYaw(u, side), kind: run.tier.seat })
        if (chairs) {
          frame.quat(u, _q)
          if (facingFlip) _q.multiply(facingFlip)
          b.seatMatrices.push(new THREE.Matrix4().compose(_p, _q, _one))
          b.seatColors.push(seatColour)
          b.seatS.push(frame.sAt(u))
        }
      }
    }
  }
}

/** Front handrail of a tier (turquoise, B1 blue): a square tube along the front edge with posts. */
function addFrontRail(b: Build, run: TierRun, colour: string) {
  const { frame, side } = b
  const t = run.tier.tread
  const rgb = lin(colour)
  const v: Fn = (u) => run.lf(u) + side * (0.05 - 0.5 * t)
  const y: Fn = (u) => run.h0(u) + 1.0
  const edges: Edge[] = [
    { v: (u) => v(u) - 0.03, y: (u) => y(u) - 0.03, tex: 0, rgb },
    { v: (u) => v(u) - 0.03, y: (u) => y(u) + 0.03, tex: 0.06, rgb },
    { v: (u) => v(u) + 0.03, y: (u) => y(u) + 0.03, tex: 0.12, rgb },
    { v: (u) => v(u) + 0.03, y: (u) => y(u) - 0.03, tex: 0.18, rgb },
  ]
  b.furniture.push(sweep(frame, run.u0, run.len, edges, 4, 1))
  for (let d = 0.6; d < run.len; d += 2.4) b.furniture.push(box(frame, run.u0 + d, v(run.u0 + d), run.h0(run.u0 + d), 0.05, 1.0, 0.05, rgb))
}

/** Polygon (v, y) of a tier's cross-section at u, front to back, down to `yBottom` at both ends. */
function sectionPoly(b: Build, run: TierRun, u: number, yBottom: number): [number, number][] {
  const t = run.tier.tread, r = run.tier.riser
  const n = run.rowsAt(u)
  const pts: [number, number][] = []
  const v = (d: number) => run.lf(u) + b.side * (d - 0.5 * t)
  pts.push([v(0), yBottom], [v(0), run.h0(u)])
  for (let k = 0; k < n; k++) {
    pts.push([v((k + 1) * t), run.h0(u) + k * r], [v((k + 1) * t), run.h0(u) + (k + 1) * r])
  }
  pts.push([v(n * t + run.walk), run.h0(u) + n * r], [v(n * t + run.walk), yBottom])
  return pts
}

function groundMin(b: Build, run: TierRun, u: number): number {
  let g = Infinity
  for (let d = -1; d <= run.tier.rows * run.tier.tread + run.walk + 1; d += 2) {
    const gg = b.frame.ground(u, run.lf(u) + b.side * (d - 0.5 * run.tier.tread))
    if (gg < g) g = gg
  }
  return g
}

/** RC terrace: front skirt (retaining wall), back wall and end walls down into the ground. */
function addTerraceStructure(b: Build, run: TierRun, opts: { skirtColour?: string; noSkirt?: boolean } = {}) {
  const { frame, side, mats } = b
  const t = run.tier.tread
  const avg = mats.concreteAvg
  const wallRgb = tint('#9c9a95', avg)
  const skirtRgb = tint(opts.skirtColour ?? '#8f8d88', avg)
  const vFront: Fn = (u) => run.lf(u) - side * 0.5 * t
  // the terrain grid is sunk under the decks once every stand is built (clampUnder), by up to
  // the grid's own error — metres where a hill meets a deck's end — so the skirts and end walls
  // reach well below the pre-clamp ground (and its neighbours across) to keep daylight out
  const groundBelow = (u: number, v: number) => Math.min(frame.ground(u, v), frame.ground(u, v - side * 7), frame.ground(u, v + side * 7)) - 5
  if (!opts.noSkirt) b.terrace.push(wall(frame, run.u0, run.len, vFront, (u) => groundBelow(u, vFront(u)), run.h0, 3, side < 0 ? 1 : -1, skirtRgb, mats.concreteTex))
  b.terrace.push(wall(frame, run.u0, run.len, run.vBack, (u) => groundBelow(u, run.vBack(u)), run.yTop, 3, side, wallRgb, mats.concreteTex))
  for (const [u, facing] of [[run.u0, -1], [run.u0 + run.len, 1]] as const) {
    const poly = sectionPoly(b, run, u, groundMin(b, run, u) - 5)
    const g = endWall(frame, u, poly, facing, wallRgb, mats.concreteTex)
    if (g) b.terrace.push(g)
  }
}

/** Frame building (B): deck soffit facing down, columns to the ground, end walls. */
function addFrameStructure(b: Build, run: TierRun) {
  const { frame, side, mats } = b
  const t = run.tier.tread
  const avg = mats.concreteAvg
  const rgb = tint('#a4a29d', avg)
  const soffitRgb = scaled(tint('#8e8c88', avg), 0.85)
  const vFront: Fn = (u) => run.lf(u) - side * 0.5 * t
  const yFront: Fn = (u) => run.h0(u) - 0.55
  const yBack: Fn = (u) => run.yTop(u) - 0.55
  const edges: Edge[] = [
    { v: vFront, y: yFront, tex: 0, rgb: soffitRgb },
    { v: run.vBack, y: yBack, tex: 10, rgb: soffitRgb },
  ]
  // reversed so the soffit faces down
  if (side > 0) edges.reverse()
  b.terrace.push(sweep(frame, run.u0, run.len, edges, 4, mats.concreteTex))
  // deck edge fascia in front, back wall, end walls to the ground
  b.terrace.push(wall(frame, run.u0, run.len, vFront, yFront, run.h0, 4, side < 0 ? 1 : -1, rgb, mats.concreteTex))
  for (const [u, facing] of [[run.u0, -1], [run.u0 + run.len, 1]] as const) {
    const g = endWall(frame, u, sectionPoly(b, run, u, groundMin(b, run, u) - 1), facing, rgb, mats.concreteTex)
    if (g) b.terrace.push(g)
  }
  for (let d = 3; d < run.len; d += 6) {
    const u = run.u0 + d
    for (const [v, yTop] of [[vFront(u) + side * 0.6, yFront(u)], [run.vBack(u) - side * 0.6, yBack(u)]] as const) {
      const g = frame.ground(u, v) - 0.5
      b.terrace.push(box(frame, u, v, g, 0.6, yTop - g, 0.6, rgb))
    }
  }
}

/** Temporary scaffold: tubular lattice under the steel deck and a corrugated back wall. */
function addScaffoldStructure(b: Build, run: TierRun) {
  const { frame, side, mats } = b
  const t = run.tier.tread, r = run.tier.riser
  const rows = run.tier.rows
  const depth = rows * t + run.walk
  const lines = [-0.5 * t + 0.15, depth * 0.5, depth - 0.15]
  const a = new THREE.Vector3(), c = new THREE.Vector3()
  const push = (m: THREE.Matrix4, u: number) => {
    b.tubeMatrices.push(m)
    b.tubeS.push(frame.sAt(u))
  }
  // d is measured from the row-0 tread start (the seat centre sits 0.5 t behind it)
  const deckY = (u: number, d: number) => run.h0(u) + Math.min(rows, Math.max(0, Math.floor(d / t))) * r - 0.1
  const bay = 2.5
  const n = Math.max(1, Math.round(run.len / bay))
  const pitch = run.len / n
  for (let i = 0; i <= n; i++) {
    const u = run.u0 + i * pitch
    for (const d of lines) {
      const v = run.lf(u) + side * (d - 0.5 * t)
      const g = frame.ground(u, v) - 0.3
      const top = deckY(u, d)
      if (top <= g) continue
      push(tubeMatrix(frame.at(u, v, g, a), frame.at(u, v, top, c)), u)
      // ledgers along the stand every 2 m of height, plus a transom across at the deck level
      if (i < n) {
        const u1 = u + pitch
        for (let h = g + 1.5; h < top; h += 2) push(tubeMatrix(frame.at(u, v, h, a), frame.at(u1, run.lf(u1) + side * (d - 0.5 * t), h, c)), u)
        // diagonal brace in every third bay on the front line
        if (d === lines[0] && i % 3 === 0) push(tubeMatrix(frame.at(u, v, g + 0.3, a), frame.at(u1, run.lf(u1) + side * (d - 0.5 * t), Math.min(top, g + 3.5), c)), u)
      }
    }
    // transoms across the depth under the deck
    const v0 = run.lf(u) + side * (lines[0]! - 0.5 * t), v2 = run.lf(u) + side * (lines[2]! - 0.5 * t)
    push(tubeMatrix(frame.at(u, v0, deckY(u, lines[0]!) - 0.15, a), frame.at(u, v2, deckY(u, lines[2]!) - 0.15, c)), u)
  }
  // corrugated back wall from the ground to a metre above the top row
  const vBack: Fn = (u) => run.vBack(u) + side * 0.1
  b.corrugated.push(wall(frame, run.u0, run.len, vBack, (u) => frame.ground(u, vBack(u)) - 0.5, (u) => run.yTop(u) + 1.2, 3, side, [1, 1, 1], mats.corrugatedTex))
}

// ---------------------------------------------------------------------------------------------
// enclosures and the main-grandstand extras

/** Glazed suite block (VIP "Dynamic Eye", GRAN VIEW): piers, floor slabs, glass, mullions, roof. */
function addEnclosure(b: Build, u0: number, len: number, vFront: Fn, vBack: Fn, floors: number[], roofTop: number, framePitch: number, kickUp: boolean) {
  const { frame, side, mats } = b
  const avg = mats.concreteAvg
  const white = tint(COLOURS.mullionWhite.mid, avg)
  const pier = tint(COLOURS.pierConcrete.mid, avg)
  const green = lin(COLOURS.signageGreen.mid)
  const y0 = floors[0]!
  const uEnd = u0 + len
  // roof: flat, with the VIP kick-up over the last 30 m towards Turn 1
  const roofY: Fn = (u) => roofTop + (kickUp ? 2.5 * Math.max(0, 1 - (uEnd - u) / 30) ** 2 : 0)
  const top: Edge[] = [{ v: vFront, y: (u) => roofY(u) + 0.5, tex: 0, rgb: tint(COLOURS.roofTop.mid, avg) }, { v: vBack, y: (u) => roofY(u) + 0.5, tex: 24, rgb: tint(COLOURS.roofTop.mid, avg) }]
  const soffit: Edge[] = [{ v: vFront, y: roofY, tex: 0, rgb: white }, { v: vBack, y: roofY, tex: 24, rgb: white }]
  if (side < 0) top.reverse()
  else soffit.reverse()
  b.terrace.push(sweep(frame, u0, len, top, 2, mats.concreteTex), sweep(frame, u0, len, soffit, 2, mats.concreteTex))
  b.terrace.push(wall(frame, u0, len, vFront, roofY, (u) => roofY(u) + 0.5, 2, side < 0 ? 1 : -1, white, mats.concreteTex))
  b.terrace.push(wall(frame, u0, len, vBack, roofY, (u) => roofY(u) + 0.5, 2, side, white, mats.concreteTex))
  // floor slabs (fascia strips) and the glass between them
  for (const f of floors) {
    b.terrace.push(wall(frame, u0, len, vFront, () => f - 0.6, () => f, 4, side < 0 ? 1 : -1, white, mats.concreteTex))
    b.terrace.push(wall(frame, u0, len, vBack, () => f - 0.6, () => f, 4, side, white, mats.concreteTex))
  }
  const glassBottom = (f: number) => f
  const glassTopOf = (i: number) => (i + 1 < floors.length ? floors[i + 1]! - 0.6 : (u: number) => roofY(u) - 0.1)
  floors.forEach((f, i) => {
    const gt = glassTopOf(i)
    const yt: Fn = typeof gt === 'number' ? () => gt : gt
    b.glass.push(wall(frame, u0, len, (u) => vFront(u) + side * 0.05, () => glassBottom(f), yt, 3, side < 0 ? 1 : -1, [1, 1, 1], mats.glassTex))
    b.glass.push(wall(frame, u0, len, (u) => vBack(u) - side * 0.05, () => glassBottom(f), yt, 3, side, [1, 1, 1], mats.glassTex))
  })
  // end walls (glass) and the soffit under the lowest floor
  for (const [u, facing] of [[u0, -1], [uEnd, 1]] as const) {
    const g = endWall(frame, u, [[vFront(u), y0 - 0.6], [vBack(u), y0 - 0.6], [vBack(u), roofY(u)], [vFront(u), roofY(u)]], facing, [1, 1, 1], mats.glassTex)
    if (g) b.glass.push(g)
  }
  const under: Edge[] = [{ v: vFront, y: () => y0 - 0.6, tex: 0, rgb: scaled(white, 0.8) }, { v: vBack, y: () => y0 - 0.6, tex: 24, rgb: scaled(white, 0.8) }]
  if (side > 0) under.reverse()
  b.terrace.push(sweep(frame, u0, len, under, 4, mats.concreteTex))
  // piers to the ground, mullions on the glass, green signage strip between the front piers
  for (let d = framePitch / 2; d < len; d += framePitch) {
    const u = u0 + d
    for (const v of [vFront(u) + side * 0.5, vBack(u) - side * 0.5]) {
      const g = frame.ground(u, v) - 0.5
      if (y0 - 0.6 > g) b.terrace.push(box(frame, u, v, g, 0.8, y0 - 0.6 - g, 0.8, pier))
    }
    b.furniture.push(box(frame, u, vFront(u) + side * 0.02, y0, 0.14, roofY(u) - y0, 0.14, white))
  }
  b.furniture.push(wall(frame, u0, len, (u) => vFront(u) + side * 0.15, () => y0 - 1.8, () => y0 - 0.7, 4, side < 0 ? 1 : -1, green, 1))
}

/**
 * The lateral band a roof covers at u. A slab names the band outright (`lateral`); a canopy that
 * follows the rows it shelters names the TIER instead, and the band is then the tier's own
 * row-1 front (less the overhang) to just behind its structure — which is what a straight bar on
 * a curving stretch needs (G's back bar drifts 46 → 50 → 43 m in lateral over its 160 m).
 */
function roofBand(b: Build, roof: StandRoof, runs: TierRun[]): { v0: Fn; v1: Fn } {
  if (roof.lateral) {
    const [a, c] = roof.lateral
    return { v0: () => a, v1: () => c }
  }
  const run = runs.find((r) => r.tier.id === roof.tier) ?? runs[runs.length - 1]!
  const t = run.tier.tread
  return {
    v0: (u) => run.lf(u) - b.side * (0.5 * t + roof.overhang),
    v1: (u) => run.vBack(u) + b.side * 0.5,
  }
}

/**
 * The AO band of a roof — one place, so what `addRoof` draws and what the decks under it are
 * shaded by can never disagree (they were two hand-kept copies before).
 */
function roofOverhead(b: Build, roof: StandRoof, runs: TierRun[]) {
  const band = roofBand(b, roof, runs)
  const rise = roof.rise ?? 0
  b.overhead.push({
    v0: band.v0,
    v1: band.v1,
    y: (u, v) => {
      if (!rise) return roof.soffit
      const a = band.v0(u), c = band.v1(u)
      const t = Math.min(1, Math.max(0, (v - a) / (c - a || 1)))
      return roof.soffit + rise * t
    },
  })
}

/** The tread height of a tier's deck at (u, v) — what a column standing on the rows lands on. */
function deckHeightOf(b: Build, run: TierRun): (u: number, v: number) => number {
  const t = run.tier.tread
  return (u, v) => {
    const d = (v - run.lf(u)) * b.side + 0.5 * t
    return run.h0(u) + Math.min(run.rowsAt(u), Math.max(0, Math.floor(d / t))) * run.tier.riser
  }
}

/**
 * A stand's roof, in whichever of the two forms the data asks for.
 *
 * `style 'slab'` is the main grandstand's 18 × 186 m RC slab: ribbed soffit, fascia and the white
 * triangular trusses on top, carried by the hospitality band beneath (`columns 'none'`).
 * `style 'canopy'` is the thin steel deck of the temporary stands and of G's back bar: a plate
 * that rises from its front edge to its back on posts, either to the ground (`'ground'`, the
 * scaffold stands) or standing on the rows (`'deck'`). The posts are their own LOD entry with no
 * distance cut — the scaffold tubes stop at 420 m, and a roof left floating over nothing is worse
 * than the tubes it saves. `blocks` cuts the roof into separate lengths (G: two canopies with a
 * stair gap between them).
 */
function addRoof(b: Build, roof: StandRoof, runs: TierRun[]) {
  const L = b.ctx.track.length
  const [rs0, rs1] = roof.sRange ?? b.def.sRange
  const spans = (roof.blocks ?? [[rs0, rs1]]).map(([a, c]) => ({ u0: a, len: forwardDelta(a, c, L) || L }))
  const band = roofBand(b, roof, runs)
  for (const { u0, len } of spans) {
    if (len < 1) continue
    if ((roof.style ?? 'slab') === 'slab') addSlabRoof(b, roof, u0, len, band)
    else addCanopyRoof(b, roof, runs, u0, len, band)
  }
}

/** The V2 slab: flat top, ribbed soffit, fascias, end walls, white trusses and a ridge purlin. */
function addSlabRoof(b: Build, roof: StandRoof, u0: number, len: number, band: { v0: Fn; v1: Fn }) {
  const { frame, side, mats } = b
  const avg = mats.concreteAvg
  const vA = band.v0(u0), vB = band.v1(u0)
  const topRgb = tint(roof.colour ?? COLOURS.roofTop.mid, avg)
  const fascia = tint(COLOURS.roofFascia.mid, avg)
  const slabTop = roof.soffit + 1.5
  const top: Edge[] = [{ v: () => vA, y: () => slabTop, tex: 0, rgb: topRgb }, { v: () => vB, y: () => slabTop, tex: 24, rgb: topRgb }]
  b.terrace.push(sweep(frame, u0, len, top, 4, mats.concreteTex))
  // ribbed soffit: alternate light / dark vertex rows every 0.6 m along s read as ribs from below
  const soffitBase = tint(COLOURS.roofSoffit.mid, avg)
  const soffitGeo = sweep(frame, u0, len, [{ v: () => vB, y: () => roof.soffit, tex: 24, rgb: soffitBase }, { v: () => vA, y: () => roof.soffit, tex: 0, rgb: soffitBase }], 0.6, mats.concreteTex)
  {
    const col = soffitGeo.attributes.color as THREE.BufferAttribute
    for (let i = 0; i < col.count; i++) {
      const k = (Math.floor(i / 2) % 2) ? 0.78 : 1.0
      col.setXYZ(i, col.getX(i) * k, col.getY(i) * k, col.getZ(i) * k)
    }
  }
  b.terrace.push(soffitGeo)
  b.terrace.push(wall(frame, u0, len, () => vA, () => roof.soffit, () => slabTop, 4, -1, fascia, mats.concreteTex))
  b.terrace.push(wall(frame, u0, len, () => vB, () => roof.soffit, () => slabTop, 4, 1, fascia, mats.concreteTex))
  for (const [u, facing] of [[u0, -1], [u0 + len, 1]] as const) {
    const g = endWall(frame, u, [[vA, roof.soffit], [vB, roof.soffit], [vB, slabTop], [vA, slabTop]], facing, fascia, mats.concreteTex)
    if (g) b.terrace.push(g)
  }
  // white triangular trusses on top, a ridge purlin along the apex line
  const truss = lin('#f2f2ef')
  const vMid = (vA + vB) / 2, apex = slabTop + 3.2
  const a = new THREE.Vector3(), c = new THREE.Vector3()
  const member = (u: number, v0: number, y0: number, v1: number, y1: number) => {
    frame.at(u, v0, y0, a)
    frame.at(u, v1, y1, c)
    // unit-length box: tubeMatrix scales it to the member length
    const g = new THREE.BoxGeometry(0.22, 1, 0.22)
    g.applyMatrix4(tubeMatrix(a, c))
    b.furniture.push(withColor(g, truss))
  }
  for (let d = roof.finPitch / 2; d < len; d += roof.finPitch) {
    const u = u0 + d
    member(u, vA + 0.3, slabTop, vMid, apex)
    member(u, vB - 0.3, slabTop, vMid, apex)
    member(u, vMid, slabTop, vMid, apex)
    member(u, (vA + vMid) / 2, slabTop, (vA + vMid) / 2, slabTop + 1.6)
    member(u, (vB + vMid) / 2, slabTop, (vB + vMid) / 2, slabTop + 1.6)
  }
  b.furniture.push(sweep(frame, u0, len, [
    { v: () => vMid - 0.12, y: () => apex - 0.1, tex: 0, rgb: truss },
    { v: () => vMid - 0.12, y: () => apex + 0.15, tex: 0.25, rgb: truss },
    { v: () => vMid + 0.12, y: () => apex + 0.15, tex: 0.5, rgb: truss },
    { v: () => vMid + 0.12, y: () => apex - 0.1, tex: 0.75, rgb: truss },
  ], 6, 1))
  void side
}

/**
 * A steel canopy: a plate `top − soffit` thick that rises `rise` metres from its front edge to
 * its back, on posts every `columnPitch`. Purlin fins under the plate every `finPitch` read as
 * the ribbed underside every photo of a temporary roof shows.
 */
function addCanopyRoof(b: Build, roof: StandRoof, runs: TierRun[], u0: number, len: number, band: { v0: Fn; v1: Fn }) {
  const { frame, side, mats } = b
  const avg = mats.concreteAvg
  const rise = roof.rise ?? 0
  const thick = Math.max(0.12, roof.top - roof.soffit)
  const deck = tint(roof.colour ?? '#4f6a8a', avg)
  const under = scaled(deck, 0.62)
  const edgeRgb = scaled(deck, 0.82)
  const yUnder = (u: number, v: number) => {
    const a = band.v0(u), c = band.v1(u)
    const t = Math.min(1, Math.max(0, (v - a) / (c - a || 1)))
    return roof.soffit + rise * t
  }
  const vF: Fn = (u) => band.v0(u)
  const vB: Fn = (u) => band.v1(u)
  const yF: Fn = (u) => yUnder(u, vF(u))
  const yBk: Fn = (u) => yUnder(u, vB(u))
  const top: Edge[] = [
    { v: vF, y: (u) => yF(u) + thick, tex: 0, rgb: deck },
    { v: vB, y: (u) => yBk(u) + thick, tex: 12, rgb: deck },
  ]
  const soffit: Edge[] = [{ v: vF, y: yF, tex: 0, rgb: under }, { v: vB, y: yBk, tex: 12, rgb: under }]
  if (side < 0) top.reverse()
  else soffit.reverse()
  b.terrace.push(sweep(frame, u0, len, top, 4, mats.concreteTex))
  b.terrace.push(sweep(frame, u0, len, soffit, 4, mats.concreteTex))
  b.terrace.push(wall(frame, u0, len, vF, yF, (u) => yF(u) + thick, 4, side < 0 ? 1 : -1, edgeRgb, mats.concreteTex))
  b.terrace.push(wall(frame, u0, len, vB, yBk, (u) => yBk(u) + thick, 4, side, edgeRgb, mats.concreteTex))
  for (const [u, facing] of [[u0, -1], [u0 + len, 1]] as const) {
    const g = endWall(frame, u, [[vF(u), yF(u)], [vB(u), yBk(u)], [vB(u), yBk(u) + thick], [vF(u), yF(u) + thick]], facing, edgeRgb, mats.concreteTex)
    if (g) b.terrace.push(g)
  }
  // purlin fins under the plate
  const fin = scaled(deck, 0.5)
  for (let d = roof.finPitch / 2; d < len; d += roof.finPitch) {
    const u = u0 + d
    const a = new THREE.Vector3(), c = new THREE.Vector3()
    const g = new THREE.BoxGeometry(0.16, 1, 0.16)
    g.applyMatrix4(tubeMatrix(frame.at(u, vF(u), yF(u) - 0.1, a), frame.at(u, vB(u), yBk(u) - 0.1, c)))
    b.furniture.push(withColor(g, fin))
  }
  // --- posts ------------------------------------------------------------------------------
  const mode = roof.columns ?? 'ground'
  if (mode === 'none') return
  const run = runs.find((r) => r.tier.id === roof.tier) ?? runs[runs.length - 1]!
  const deckY = deckHeightOf(b, run)
  const pitch = roof.columnPitch ?? roof.finPitch
  const a = new THREE.Vector3(), c = new THREE.Vector3()
  for (let d = pitch / 2; d < len; d += pitch) {
    const u = u0 + d
    for (const v of [vF(u) + side * 0.35, vB(u) - side * 0.35]) {
      const foot = mode === 'ground' ? frame.ground(u, v) - 0.3 : deckY(u, v)
      const head = yUnder(u, v)
      if (head - foot < 0.5) continue
      b.postMatrices.push(tubeMatrix(frame.at(u, v, foot, a), frame.at(u, v, head, c)))
      b.postS.push(frame.sAt(u))
    }
  }
}

/**
 * Main grandstand upper works over V2: the two-storey glazed hospitality band on piers behind
 * the V2 rows, and the white RC rear façade towards GP Square. The roof slab above it is
 * `addRoof`'s (`style 'slab'`, `columns 'none'` — the band carries it).
 * Everything is swept along the track, so it tilts with the 2.8 % gradient like the real one.
 */
function addV2Band(b: Build, runs: TierRun[]) {
  const { frame, mats, def } = b
  const roof = def.roof!
  const avg = mats.concreteAvg
  const white = tint(COLOURS.mullionWhite.mid, avg)
  const [rs0, rs1] = roof.sRange ?? def.sRange
  const u0 = rs0
  const len = forwardDelta(rs0, rs1, b.ctx.track.length)
  const vB = roof.lateral![1]
  const bandFront = 47, bandBack = vB
  const bandFloor = 19.5, bandTop = roof.soffit - 0.1
  const upper = runs[runs.length - 1]!
  // (the band's own AO band is pushed in `buildStand`, before the decks are swept: an overhead
  // added here would shade nothing, because the decks under it are already built)
  const pier = tint(COLOURS.pierConcrete.mid, avg)
  const deckY = deckHeightOf(b, upper)
  for (let d = 1.75; d < len; d += 3.5) {
    const u = u0 + d
    const yF = deckY(u, bandFront + 0.4)
    b.terrace.push(box(frame, u, bandFront + 0.4, yF, 0.7, bandFloor - 0.5 - yF, 0.7, pier))
    const g = frame.ground(u, bandBack - 0.5) - 0.5
    b.terrace.push(box(frame, u, bandBack - 0.5, g, 0.7, bandFloor - 0.5 - g, 0.7, pier))
    b.furniture.push(box(frame, u, bandFront + 0.02, bandFloor + 0.1, 0.14, bandTop - bandFloor - 0.1, 0.14, white))
  }
  // green signage strip between the front piers, floor soffit + fascia, glass front/back/ends
  b.furniture.push(wall(frame, u0, len, () => bandFront + 0.1, () => bandFloor - 1.7, () => bandFloor - 0.6, 4, -1, lin(COLOURS.signageGreen.mid), 1))
  const soffit: Edge[] = [{ v: () => bandBack, y: () => bandFloor - 0.5, tex: 12, rgb: scaled(white, 0.85) }, { v: () => bandFront - 0.6, y: () => bandFloor - 0.5, tex: 0, rgb: scaled(white, 0.85) }]
  b.terrace.push(sweep(frame, u0, len, soffit, 4, mats.concreteTex))
  b.terrace.push(wall(frame, u0, len, () => bandFront - 0.6, () => bandFloor - 0.5, () => bandFloor + 0.1, 4, -1, white, mats.concreteTex))
  b.glass.push(wall(frame, u0, len, () => bandFront - 0.5, () => bandFloor + 0.1, () => bandTop, 3, -1, [1, 1, 1], mats.glassTex))
  b.glass.push(wall(frame, u0, len, () => bandBack, () => bandFloor + 0.1, () => bandTop, 3, 1, [1, 1, 1], mats.glassTex))
  for (const [u, facing] of [[u0, -1], [u0 + len, 1]] as const) {
    const g = endWall(frame, u, [[bandFront - 0.6, bandFloor - 0.5], [bandBack, bandFloor - 0.5], [bandBack, bandTop], [bandFront - 0.6, bandTop]], facing, [1, 1, 1], mats.glassTex)
    if (g) b.glass.push(g)
  }
  // horizontal mullions: sill, the pale blue band across the middle, head
  const blue = lin('#9fd3e8')
  for (const [y, h, rgb] of [[bandFloor + 0.1, 0.25, white], [bandFloor + 4.0, 0.7, blue], [bandTop - 0.25, 0.25, white]] as const) {
    b.furniture.push(wall(frame, u0, len, () => bandFront - 0.62, () => y, () => y + h, 4, -1, rgb, 1))
  }
}

/**
 * V2's rear façade towards GP Square: the white RC wall with its stair openings. Drawn AFTER the
 * roof slab, which is where `addMainRoofAndBand` drew it before the split — the merged `terrace`
 * buffer then comes out vertex for vertex the same as it did (verified by diffing V2's meshes,
 * their counts, boxes and attribute hashes, against the pre-split build).
 */
function addV2Rear(b: Build, runs: TierRun[]) {
  const { frame, mats, def } = b
  const roof = def.roof!
  const avg = mats.concreteAvg
  const [rs0, rs1] = roof.sRange ?? def.sRange
  const u0 = rs0
  const len = forwardDelta(rs0, rs1, b.ctx.track.length)
  const upper = runs[runs.length - 1]!
  const facade = tint('#e2e1dc', avg)
  const dark = tint('#2a2c30', avg)
  const vRear = roof.lateral![1] + 0.3
  b.terrace.push(wall(frame, u0, len, () => vRear, (u) => frame.ground(u, vRear) - 1, () => upper.yTop(u0) + 0.4, 4, 1, facade, mats.concreteTex))
  for (let d = 12; d < len; d += 24) {
    const u = u0 + d
    const g = frame.ground(u, vRear)
    b.terrace.push(box(frame, u, vRear + 0.2, g, 0.4, 2.6, 3.2, dark))
  }
}

/** V1 front: the painted white parapet on the pit-straight wall line with the front walkway. */
function addV1Parapet(b: Build, run: TierRun) {
  const { frame, side, mats } = b
  const t = run.tier.tread
  const avg = mats.concreteAvg
  const white = tint(COLOURS.parapetWhite.mid, avg)
  const walk = tint('#b3b1ac', avg)
  const face = 21.3
  const vRow: Fn = (u) => run.lf(u) - side * 0.5 * t
  const edges: Edge[] = [
    { v: () => face, y: (u) => frame.ground(u, face) - 1.5, tex: 0, rgb: white },
    { v: () => face, y: () => 1.4, tex: 2, rgb: white },
    { v: () => face, y: () => 1.4, tex: 2, rgb: white },
    { v: () => face + 0.3, y: () => 1.4, tex: 2.3, rgb: white },
    { v: () => face + 0.3, y: () => 1.4, tex: 2.3, rgb: white },
    { v: () => face + 0.3, y: () => 0.5, tex: 3.2, rgb: white },
    { v: () => face + 0.3, y: () => 0.5, tex: 3.2, rgb: walk },
    { v: vRow, y: () => 0.5, tex: 5, rgb: walk },
    { v: vRow, y: () => 0.5, tex: 5, rgb: scaled(walk, 0.75) },
    { v: vRow, y: run.h0, tex: 6, rgb: walk },
  ]
  b.terrace.push(sweep(frame, run.u0, run.len, edges, 2, mats.concreteTex))
}

/** C: rear concourse canopy on green steel columns, kiosks on the concourse. */
function addConcourseCanopy(b: Build, run: TierRun) {
  const { frame, side, mats } = b
  const avg = mats.concreteAvg
  const green = lin('#2f6b52')
  const roofRgb = tint('#c9c8c4', avg)
  const vIn: Fn = (u) => run.vBack(u) + side * 1.0
  const vOut: Fn = (u) => run.vBack(u) + side * 7.0
  const yRoof: Fn = (u) => run.yTop(u) + 4.2
  const top: Edge[] = [{ v: vIn, y: (u) => yRoof(u) + 0.3, tex: 0, rgb: roofRgb }, { v: vOut, y: (u) => yRoof(u) + 0.3, tex: 6, rgb: roofRgb }]
  const under: Edge[] = [{ v: vIn, y: yRoof, tex: 0, rgb: scaled(roofRgb, 0.8) }, { v: vOut, y: yRoof, tex: 6, rgb: scaled(roofRgb, 0.8) }]
  if (side < 0) top.reverse()
  else under.reverse()
  b.terrace.push(sweep(frame, run.u0, run.len, top, 4, mats.concreteTex), sweep(frame, run.u0, run.len, under, 4, mats.concreteTex))
  b.furniture.push(wall(frame, run.u0, run.len, vIn, yRoof, (u) => yRoof(u) + 0.3, 4, side < 0 ? 1 : -1, green, 1))
  for (let d = 3; d < run.len; d += 6) {
    const u = run.u0 + d
    for (const v of [vIn(u) + side * 0.4, vOut(u) - side * 0.4]) b.furniture.push(box(frame, u, v, run.yTop(u), 0.35, yRoof(u) - run.yTop(u), 0.35, green))
  }
  // kiosks / toilets along the back of the concourse, in the stand's own frame (C is built on
  // a chord: a track-coordinate placement would land them in T3's fold)
  const kioskRgb = tint('#d8d6d0', avg)
  for (let d = 9; d < run.len - 9; d += 37) {
    const u = run.u0 + d
    b.terrace.push(box(frame, u, vOut(u) - side * 2.2, run.yTop(u), 3.2, 2.7, 8, kioskRgb))
  }
}

/** B2 deck: two rows of generic sponsor panels — above the top row and on the deck edge over B1. */
function addBBoards(b: Build, run: TierRun) {
  const { frame, side } = b
  const t = run.tier.tread
  const vTop: Fn = (u) => run.vBack(u) - side * 0.2
  b.board.push(wall(frame, run.u0, run.len, vTop, (u) => run.yTop(u) + 0.4, (u) => run.yTop(u) + 2.4, 4, side < 0 ? 1 : -1, [1, 1, 1], 1 / 48, undefined, 2.0))
  // green steel back frame carrying the top row
  b.furniture.push(wall(frame, run.u0, run.len, (u) => vTop(u) + side * 0.1, (u) => run.yTop(u) + 0.3, (u) => run.yTop(u) + 2.5, 4, side, lin('#2f6b52'), 1))
  const vFront: Fn = (u) => run.lf(u) - side * (0.5 * t + 0.35)
  b.board.push(wall(frame, run.u0, run.len, vFront, (u) => run.h0(u) - 2.3, (u) => run.h0(u) - 0.55, 4, side < 0 ? 1 : -1, [1, 1, 1], 1 / 48, undefined, 1.75))
}

/** B1: kiosks / vending huts in the undercroft behind the seats (merged with the other props). */
function addBKiosks(b: Build, run: TierRun) {
  const { frame, side, mats, ctx } = b
  for (let d = 6; d < run.len - 4; d += 14) {
    const u = run.u0 + d
    ctx.boxes.place(frame.sAt(u), run.vBack(u) + side * 6, 5, 3, 2.6, mats.kiosk, 0, false, false)
  }
}

// ---------------------------------------------------------------------------------------------
// back of house: stair towers, gates, kiosks, vomitories and the wayfinding boards

/**
 * The generic bilingual wayfinding boards every Japanese circuit hangs on its concourses: white
 * type on the signage green, Japanese over English. One atlas of `WAYFINDING.length` rows so the
 * boards of every stand share one material.
 *
 * No logo, no wordmark, no sponsor: these are descriptive words only (scripts/textures-lint.mjs).
 * The Japanese line is drawn only when the canvas can measure it — the Node probes run on a stub
 * canvas and a browser without a CJK face would draw tofu, and either way the English line alone
 * is a correct sign.
 */
const WAYFINDING: [string, string][] = [
  ['総合案内', 'INFORMATION'],
  ['トイレ', 'TOILET'],
  ['出口', 'EXIT'],
  ['入口', 'ENTRANCE'],
  ['救護所', 'FIRST AID'],
  ['売店', 'FOOD'],
  ['西エリア', 'WEST AREA'],
]

function wayfindingTexture(): THREE.Texture {
  const [w, rowH] = texSize(512, 128)
  return cached(`wayfinding-${WAYFINDING.length}-${w}x${rowH}`, () => {
    const { c, ctx } = canvas(w, rowH * WAYFINDING.length)
    let cjk = false
    try {
      ctx.font = `${Math.round(rowH * 0.36)}px 'Noto Sans JP', 'Hiragino Sans', 'Yu Gothic', sans-serif`
      const m = ctx.measureText(WAYFINDING[0]![0])
      cjk = Number.isFinite(m.width) && m.width > 0
    } catch {
      cjk = false
    }
    WAYFINDING.forEach(([ja, en], i) => {
      const y0 = i * rowH
      ctx.fillStyle = '#12613f'
      ctx.fillRect(0, y0, w, rowH)
      ctx.fillStyle = '#f2f5f2'
      ctx.fillRect(w * 0.02, y0 + rowH * 0.06, w * 0.96, rowH * 0.02)
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = '#ffffff'
      if (cjk) {
        try {
          ctx.font = `${Math.round(rowH * 0.38)}px 'Noto Sans JP', 'Hiragino Sans', 'Yu Gothic', sans-serif`
          ctx.fillText(ja, w / 2, y0 + rowH * 0.36)
        } catch {
          // a canvas without a CJK face: the English line below carries the sign on its own
        }
      }
      ctx.font = `600 ${Math.round(rowH * (cjk ? 0.26 : 0.4))}px 'Titillium Web', 'Segoe UI', Arial, sans-serif`
      ctx.fillText(en, w / 2, y0 + rowH * (cjk ? 0.74 : 0.52))
    })
    return makeTexture(c, { wrap: THREE.ClampToEdgeWrapping })
  })
}

/** One 2.4 × 0.6 m board on two posts at (u, v), facing across the stand, showing WAYFINDING[row]. */
function addSignBoard(b: Build, u: number, v: number, yFoot: number, row: number, facing: 1 | -1) {
  const { frame } = b
  const w = 2.4, h = 0.6, top = 2.9
  const g = new THREE.PlaneGeometry(w, h)
  g.rotateY(facing > 0 ? Math.PI / 2 : -Math.PI / 2)
  const uv = g.attributes.uv as THREE.BufferAttribute
  const n = WAYFINDING.length
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i), (n - 1 - row + uv.getY(i)) / n)
  frame.at(u, v, yFoot + top - h / 2, _p)
  frame.quat(u, _q)
  g.applyMatrix4(_m.compose(_p, _q, _one))
  b.signs.push(g)
  const post = tint('#6f7276', b.mats.concreteAvg)
  for (const dz of [-w / 2 + 0.15, w / 2 - 0.15]) {
    b.furniture.push(box(frame, u + dz, v, yFoot, 0.09, top - h, 0.09, post))
  }
}

/**
 * What is behind a stand: the stair towers that reach its top walkway, an entrance gate, kiosks
 * on the concourse, V2's vomitories and the bilingual wayfinding boards.
 *
 * The towers' tops are ABSOLUTE — the top walkway plus a 1.1 m parapet — and their feet are on
 * `Ground.standY`, so a tower on the fill platform behind V2 is short and one at the foot of the
 * C embankment is tall. A tower that would be half a metre or less is not drawn at all: the
 * stand's own back wall already reaches the walkway there.
 */
function addBackOfHouse(b: Build, runs: TierRun[]) {
  const { def, side, mats, frame } = b
  if (!runs.length || def.enclosure) return
  const avg = mats.concreteAvg
  const wallRgb = tint('#9c9a95', avg)
  const gateRgb = tint('#4d5257', avg)
  const kioskRgb = tint('#d8d6d0', avg)
  const back = runs[runs.length - 1]!
  const len = back.len
  const u0 = back.u0
  // --- stair towers: both ends and every ≈ 90 m between them -------------------------------
  const nT = Math.max(2, Math.round(len / 90) + 1)
  for (let i = 0; i < nT; i++) {
    const u = u0 + (len * i) / (nT - 1) + (i === 0 ? 2.5 : i === nT - 1 ? -2.5 : 0)
    const v = back.vBack(u) + side * 2.6
    const foot = standRel(b, u, v)
    const height = back.yTop(u) + 1.1 - foot
    if (height <= 0.5) continue
    b.terrace.push(box(frame, u, v, foot, 4.4, height, 4.0, wallRgb, mats.concreteTex))
    // the flight itself reads as a dark slot in the tower's outer face
    b.terrace.push(box(frame, u, v + side * 2.15, foot, 0.35, Math.min(height, 2.4), 2.2, gateRgb, mats.concreteTex))
  }
  // --- entrance gate at the middle of the back, and the kiosks along the concourse ----------
  const uMid = u0 + len / 2
  {
    const v = back.vBack(uMid) + side * 6.0
    const foot = standRel(b, uMid, v)
    b.terrace.push(box(frame, uMid, v, foot, 0.5, 3.2, 6.0, wallRgb, mats.concreteTex))
    b.terrace.push(box(frame, uMid, v, foot + 3.2, 0.7, 0.5, 7.0, gateRgb, mats.concreteTex))
    addSignBoard(b, uMid + 4.6, v, foot, 3, side > 0 ? -1 : 1)
  }
  if (def.id !== 'C' && def.id !== 'B1') {
    let k = 0
    for (let d = 18; d < len - 12; d += 46) {
      const u = u0 + d
      const v = back.vBack(u) + side * 7.5
      const foot = standRel(b, u, v)
      b.terrace.push(box(frame, u, v, foot, 3.0, 2.7, 6.0, kioskRgb, mats.concreteTex))
      addSignBoard(b, u, back.vBack(u) + side * 3.6, standRel(b, u, back.vBack(u) + side * 3.6), (k % 2 === 0 ? 5 : 1), side > 0 ? -1 : 1)
      k++
    }
  }
  // --- wayfinding at the ends: the exits, and the West Area pointer on the west stands -------
  const west = new Set(['J', 'L', 'M', 'N', 'O'])
  for (const [i, u] of [[0, u0 + 6], [1, u0 + len - 6]] as const) {
    const v = back.vBack(u) + side * 4.4
    addSignBoard(b, u, v, standRel(b, u, v), i === 0 ? 2 : west.has(def.id) ? 6 : 0, side > 0 ? -1 : 1)
  }
  // --- V2's vomitories: the tunnels that bring the concourse out into rows 10–13 -------------
  if (def.id === 'V2') {
    const vom = runs.find((r) => r.tier.id === 'V2-5-20') ?? back
    const t = vom.tier.tread
    for (let d = 11.8 / 2; d < vom.len; d += 11.8 * 2) {
      const u = vom.u0 + d
      const v = vom.lf(u) + side * (6 * t)
      b.terrace.push(box(frame, u, v, vom.h0(u) + 6 * vom.tier.riser, 4.4, 2.3, 2.4, gateRgb, mats.concreteTex))
    }
  }
}

// ---------------------------------------------------------------------------------------------
// stand assembly

function newBuild(ctx: EnvBuildContext, def: StandDef, frame: Frame, mats: Mats): Build {
  const group = new THREE.Group()
  group.name = `stand-${def.id}`
  return { def, frame, side: def.side, mats, ctx, group, terrace: [], furniture: [], glass: [], board: [], signs: [], corrugated: [], seats: [], seatMatrices: [], seatColors: [], seatS: [], tubeMatrices: [], tubeS: [], postMatrices: [], postS: [], deckPts: [], overhead: [], deckUp: true }
}

/**
 * Does the first deck triangle face up?
 *
 * `sweep` only orders its faces counter-clockwise while +v lies to the LEFT of +u, so a frame
 * built the wrong way round (a path stand whose front edge runs against its rows) turns every
 * deck inside out — the treads become a ceiling, lit from underneath, and the seats float over
 * nothing. It is silent on a screenshot of a stand seen from the front, so it is checked here,
 * on the geometry, for every stand; the dev build reports it (the e2e suite fails on a console
 * error) and the Node probes read `Stands.stats.deckUp`.
 */
function firstDeckFacesUp(b: Build): boolean {
  const g = b.terrace[0]
  if (!g) return true
  const pos = g.attributes.position as THREE.BufferAttribute
  const idx = g.index
  if (!idx || idx.count < 3 || pos.count < 3) return true
  const a = new THREE.Vector3().fromBufferAttribute(pos, idx.getX(0))
  const c = new THREE.Vector3().fromBufferAttribute(pos, idx.getX(1))
  const d = new THREE.Vector3().fromBufferAttribute(pos, idx.getX(2))
  c.sub(a)
  d.sub(a)
  return c.cross(d).y > 0
}

/** What an object standing at (u, v) rests on, in the frame's own heights (`Ground.standY`). */
function standRel(b: Build, u: number, v: number): number {
  b.frame.at(u, v, 0, _p)
  return b.ctx.ground.standY(_p.x, _p.z) - _p.y
}

function buildStand(b: Build): TierRun[] {
  const { def } = b
  const runs = resolveTiers(b)
  // overhead slabs first, so the vertex AO of the decks below knows about them
  if (def.id === 'B1') {
    // the B2 deck (row 1 at +9.7, raked 0.35 / 0.75) is B1's roof
    const b2 = STANDS.find((s) => s.id === 'B2')
    const deck = b2?.tiers.find((t) => t.id === 'B2-1/2')
    if (b2 && deck) {
      const lf = (u: number) => alongAt(b2.lateralFront, u, b2.sRange)
      const h0 = (u: number) => (deck.frontHeight !== undefined ? alongAt(deck.frontHeight, u, b2.sRange) : b2.frontHeight as number)
      b.overhead.push({ v0: () => 60, v1: () => 82, y: (u, v) => h0(u) - 0.55 + Math.max(0, v - lf(u)) * (deck.riser / deck.tread) })
    }
  }
  if (def.roof) roofOverhead(b, def.roof, runs)
  // V2's other overhead: the glazed hospitality band behind the rows (addV2Band draws it, but the
  // AO band has to be in place before the decks below are swept)
  if (def.id === 'V2') b.overhead.push({ v0: () => 46.5, v1: () => def.roof!.lateral![1], y: () => 19.0 })
  for (const run of runs) {
    addDeck(b, run)
    const railColour = def.id === 'B1' ? COLOURS.railBlueB1.lit : COLOURS.railTurquoise.mid
    if (def.id !== 'V1' || run.tier.id !== 'V1') addFrontRail(b, run, railColour)
    switch (def.structure) {
      case 'terrace':
        addTerraceStructure(b, run, { noSkirt: def.id === 'V1' && run.tier.id === 'V1' })
        break
      case 'frame':
        addFrameStructure(b, run)
        break
      case 'scaffold':
        addScaffoldStructure(b, run)
        break
    }
    if (def.id === 'V1' && run.tier.id === 'V1') addV1Parapet(b, run)
    if (def.id === 'C' && run.tier.id === 'C-upper') addConcourseCanopy(b, run)
    if (def.id === 'B2' && run.tier.id === 'B2-1/2') addBBoards(b, run)
    if (def.id === 'B1') addBKiosks(b, run)
  }
  // the deck of the first tier decides whether this stand's frame is the right way round
  b.deckUp = firstDeckFacesUp(b)
  if (def.id === 'V2') addV2Band(b, runs)
  if (def.roof) addRoof(b, def.roof, runs)
  if (def.id === 'V2') addV2Rear(b, runs)
  addBackOfHouse(b, runs)
  if (def.enclosure) {
    const e = def.enclosure
    const [s0, s1] = def.sRange
    addEnclosure(b, s0, forwardDelta(s0, s1, b.ctx.track.length), (u) => alongAt(def.lateralFront, u, def.sRange), (u) => alongAt(def.lateralBack, u, def.sRange), e.floors, e.roofTop, e.framePitch, def.id === 'VIP')
  }
  return runs
}

interface Lodded {
  /** an InstancedMesh has its count ramped to 0; a plain Mesh is hidden */
  inst: THREE.InstancedMesh | THREE.Mesh
  full: number
  centre: THREE.Vector3
  range: number
}

function finishStand(b: Build, lod: Lodded[], seatGeo: THREE.BufferGeometry, tubeGeo: THREE.BufferGeometry, postGeo: THREE.BufferGeometry): { tris: number; instances: number } {
  const { mats, group, def, ctx } = b
  let tris = 0
  const merge = (geos: THREE.BufferGeometry[], mat: THREE.Material, name: string, cast: boolean, range = Infinity) => {
    if (!geos.length) return
    const merged = mergeGeometries(geos, false)
    for (const g of geos) g.dispose()
    if (!merged) return
    const mesh = new THREE.Mesh(merged, mat)
    mesh.name = name
    mesh.castShadow = cast
    mesh.receiveShadow = true
    group.add(mesh)
    if (range < Infinity) {
      merged.computeBoundingSphere()
      lod.push({ inst: mesh, full: 1, centre: merged.boundingSphere!.center.clone(), range })
    }
    tris += (merged.index ? merged.index.count : (merged.attributes.position as THREE.BufferAttribute).count) / 3
  }
  merge(b.terrace, mats.terrace, 'terrace', true)
  merge(b.furniture, mats.furniture, 'furniture', false)
  merge(b.glass, mats.glass, 'glass', true)
  merge(b.board, mats.board, 'boards', false)
  // the wayfinding boards are a metre wide: one draw per stand that is sub-pixel from the tubes' cut
  merge(b.signs, mats.wayfinding, 'signs', false, TUBE_LOD)
  merge(b.corrugated, mats.corrugated, 'backWall', true)
  let instances = 0
  const s0 = def.sRange[0]
  const L = ctx.track.length
  const bayOf = (s: number) => Math.floor(forwardDelta(s0, s, L) / STAND_BAY)
  if (b.seatMatrices.length) {
    for (const inst of bucketedInstancedMeshes(seatGeo, mats.seat, b.seatMatrices, b.seatColors, (i) => bayOf(b.seatS[i]!), { name: `seats-${def.id}`, castShadow: false, receiveShadow: true })) {
      group.add(inst)
      lod.push({ inst, full: inst.count, centre: inst.boundingSphere!.center.clone(), range: SEAT_LOD })
      instances += inst.count
      tris += (inst.count * (seatGeo.index ? seatGeo.index.count : (seatGeo.attributes.position as THREE.BufferAttribute).count)) / 3
    }
  }
  if (b.tubeMatrices.length) {
    for (const inst of bucketedInstancedMeshes(tubeGeo, mats.tube, b.tubeMatrices, null, (i) => bayOf(b.tubeS[i]!), { name: `tubes-${def.id}`, castShadow: false, receiveShadow: true })) {
      group.add(inst)
      lod.push({ inst, full: inst.count, centre: inst.boundingSphere!.center.clone(), range: TUBE_LOD })
      instances += inst.count
      tris += (inst.count * (tubeGeo.index ? tubeGeo.index.count : (tubeGeo.attributes.position as THREE.BufferAttribute).count)) / 3
    }
  }
  if (b.postMatrices.length) {
    // NO distance cut: the scaffold tubes may thin out at 420 m, but the canopy they carry is
    // merged geometry that never does, and a roof standing on nothing is worse than the posts
    for (const inst of bucketedInstancedMeshes(postGeo, mats.tube, b.postMatrices, null, (i) => bayOf(b.postS[i]!), { name: `roofPosts-${def.id}`, castShadow: true, receiveShadow: true })) {
      group.add(inst)
      lod.push({ inst, full: inst.count, centre: inst.boundingSphere!.center.clone(), range: Infinity })
      instances += inst.count
      tris += (inst.count * (postGeo.index ? postGeo.index.count : (postGeo.attributes.position as THREE.BufferAttribute).count)) / 3
    }
  }
  ctx.group.add(group)
  return { tris, instances }
}

/** ≈36-triangle stadium chair facing −X (towards the track on a left-side stand): pan, backrest, pedestal. */
function seatPrototype(): THREE.BufferGeometry {
  const pan = new THREE.BoxGeometry(0.42, 0.05, 0.44)
  pan.translate(0.02, 0.42, 0)
  const back = new THREE.BoxGeometry(0.06, 0.4, 0.44)
  back.translate(0.21, 0.63, 0)
  const leg = new THREE.BoxGeometry(0.05, 0.4, 0.06)
  leg.translate(0.1, 0.2, 0)
  const g = mergeGeometries([pan, back, leg], false)!
  return g
}

/**
 * Q2: three permanent bars inside the chicane, in the figure-8 fold where the nearest-segment s
 * mapping is unreliable — built straight from their OSM rectangles in a local frame. The front
 * is the long side nearest the track.
 */
function q2Frames(ctx: EnvBuildContext, feats: OsmFeature[]): { frame: Frame; len: number; width: number }[] {
  const { track, terrain, ground } = ctx
  const out: { frame: Frame; len: number; width: number }[] = []
  for (const f of feats) {
    const pts = f.en.map(([e, n]) => track.enToWorld(e, n, new THREE.Vector3()))
    // longest edge = the bar's axis
    let best = 0, bi = 0
    for (let i = 0; i < pts.length; i++) {
      const d = pts[i]!.distanceTo(pts[(i + 1) % pts.length]!)
      if (d > best) {
        best = d
        bi = i
      }
    }
    const along = pts[(bi + 1) % pts.length]!.clone().sub(pts[bi]!).setY(0).normalize()
    const across = new THREE.Vector3(along.z, 0, -along.x) // perpendicular in the ground plane
    let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity
    for (const p of pts) {
      const a = p.dot(along), c = p.dot(across)
      minA = Math.min(minA, a); maxA = Math.max(maxA, a)
      minB = Math.min(minB, c); maxB = Math.max(maxB, c)
    }
    const len = maxA - minA, width = maxB - minB
    const mid = (minA + maxA) / 2
    // which long side faces the track: the nearer midpoint
    const sideA = new THREE.Vector3().addScaledVector(along, mid).addScaledVector(across, minB)
    const sideB = new THREE.Vector3().addScaledVector(along, mid).addScaledVector(across, maxB)
    const dA = ground.plan.project(sideA.x, sideA.z), dB = ground.plan.project(sideB.x, sideB.z)
    const frontIsA = dA.d < dB.d
    const back = frontIsA ? across.clone() : across.clone().negate()
    const near = frontIsA ? dA : dB
    // the frame's along-direction keeps (along × up) pointing to the back so the deck faces up
    const dir = back.clone().cross(Y_UP).normalize()
    const origin = new THREE.Vector3().addScaledVector(along, dir.dot(along) > 0 ? minA : maxA).addScaledVector(across, frontIsA ? minB : maxB)
    origin.y = near.d < 200 ? track.pointAt(near.s, 0, _p, 0).y : ground.field.y(origin.x, origin.z)
    out.push({ frame: localFrame(ground, origin, dir, back, len, near.s), len, width })
  }
  return out
}

/** Build every stand; returns the seat positions for the crowd and the per-frame LOD update. */
export function buildStands(ctx: EnvBuildContext): Stands {
  const { track, ground, terrain } = ctx
  const mats = makeMaterials(ctx)
  const seatGeo = seatPrototype()
  const tubeGeo = new THREE.CylinderGeometry(0.03, 0.03, 1, 5, 1, true)
  const postGeo = new THREE.CylinderGeometry(0.075, 0.075, 1, 6, 1, false)
  const lod: Lodded[] = []
  const seats: SeatSlot[] = []
  const deckPts: number[] = []
  /** [stand id, from, to) into deckPts — for the dev probes */
  const deckRanges: [string, number, number][] = []
  const stats: string[] = []
  const roofs: string[] = []
  const pathStands: string[] = []
  const deckUp: Record<string, boolean> = {}
  const generated: Record<string, number> = {}
  let totalTris = 0, totalInst = 0
  for (const def of STANDS) {
    if (def.id === 'Q2') {
      const feats = def.osmWays.map((id) => OSM_STANDS.find((f) => f.id === id)).filter((f): f is OsmFeature => !!f)
      let k = 0
      for (const { frame, width } of q2Frames(ctx, feats)) {
        const tier = def.tiers[0]!
        // a bar's own footprint decides its depth: clip the rows to the rectangle
        const local: StandDef = { ...def, sRange: [0, frame.len], lateralFront: 0.5 * tier.tread + 0.3, lateralBack: width - 0.3, side: 1, tiers: [{ ...tier, id: `${tier.id}-${++k}` }] }
        const b = newBuild(ctx, local, frame, mats)
        b.group.name = k === 1 ? `stand-${def.id}` : `stand-${def.id}-${k}`
        buildStand(b)
        const r = finishStand(b, lod, seatGeo, tubeGeo, postGeo)
        for (const s of b.seats) seats.push(s)
        for (const p of b.deckPts) deckPts.push(p)
        deckUp[`${def.id}-${k}`] = b.deckUp
        generated[def.id] = (generated[def.id] ?? 0) + b.seats.length
        stats.push(`${local.tiers[0]!.id}: ${Math.round(r.tris)} tris, ${r.instances} inst, ${b.seats.length} seats`)
        totalTris += r.tris
        totalInst += r.instances
      }
      continue
    }
    const spec = pathSpec(track, def)
    const frame = spec ? pathFrame(ground, spec) : trackFrame(track, ground, def.sRange[0], def.sRange[1])
    const b = newBuild(ctx, spec ? pathLocalDef(def, spec) : def, frame, mats)
    buildStand(b)
    const r = finishStand(b, lod, seatGeo, tubeGeo, postGeo)
    for (const s of b.seats) seats.push(s)
    deckRanges.push([def.id, deckPts.length, deckPts.length + b.deckPts.length])
    for (const p of b.deckPts) deckPts.push(p)
    if (spec) pathStands.push(def.id)
    if (def.roof) roofs.push(def.id)
    deckUp[def.id] = b.deckUp
    generated[def.id] = b.seats.length
    stats.push(`${def.id}: ${Math.round(r.tris)} tris, ${r.instances} inst, ${b.seats.length} seats`)
    totalTris += r.tris
    totalInst += r.instances
  }
  // --- the seat slots are clamped to the published capacities ------------------------------
  const capacity = clampSeats(seats, generated)
  // --- the grass banks: lawn places on the settled ground, plus their sheets and tents -------
  const banks = buildBanks(ctx)
  ctx.group.add(banks.group)
  for (const s of banks.seats) seats.push(s)
  // --- the stair in the notch between E-2 and E-1 -------------------------------------------
  addNotchStair(ctx, mats)
  // the 13 m terrain grid is far coarser than the decks: sink it wherever it would show through
  const deckArr = Float32Array.from(deckPts)
  terrain.clampUnder(deckArr, 0.3, 4)
  if (import.meta.dev) {
    ctx.group.userData.standStats = stats
    // the probe scripts check which deck vertices sink the terrain grid
    ctx.group.userData.deckPts = deckArr
    ctx.group.userData.deckRanges = deckRanges
    console.info(`[stands] ${STANDS.length} stands, ${Math.round(totalTris)} tris, ${totalInst} instances, ${seats.length} seats`)
  }
  const upside = Object.entries(deckUp).filter(([, up]) => !up).map(([id]) => id)
  if (import.meta.dev && upside.length) console.error(`[stands] the deck of ${upside.join(', ')} faces DOWN — the stand's frame runs the wrong way round (StandDef.path / buildPathSpec)`)
  const kept: Record<string, number> = {}
  for (const s of seats) kept[s.standId] = (kept[s.standId] ?? 0) + 1
  const byStand: StandsStats['seats']['byStand'] = {}
  for (const [id, n] of Object.entries(generated)) byStand[id] = { generated: n, kept: kept[id] ?? 0 }
  const stats2: StandsStats = {
    seats: { total: seats.length, byStand, capacity },
    roofs,
    pathStands,
    deckUp,
    banks: banks.stats,
  }
  const update = (cameraPos: THREE.Vector3) => {
    for (const l of lod) {
      const near = cameraPos.distanceTo(l.centre) < l.range
      if ((l.inst as THREE.InstancedMesh).isInstancedMesh) {
        const inst = l.inst as THREE.InstancedMesh
        const n = near ? l.full : 0
        if (n !== inst.count) inst.count = n
      } else if (l.inst.visible !== near) {
        l.inst.visible = near
      }
    }
  }
  return { seats, stats: stats2, update }
}

/**
 * Thin the seat SLOTS of the stands whose capacity is published (SEAT_CAPACITY) down to that
 * figure. The generator lays a place every `SEAT_PITCH` along every row of the real footprint,
 * which overshoots the ticketed count by the aisles, the wheelchair bays and the blocks that are
 * shorter than their row: C comes out ≈ 15 % over its 13,698. Thinning is per ROW by error
 * diffusion, so what is dropped is spread evenly instead of emptying the back of the stand, and
 * only the crowd's slots go — the chair furniture on the deck stays whole.
 */
function clampSeats(seats: SeatSlot[], generated: Record<string, number>): StandsStats['seats']['capacity'] {
  const out: StandsStats['seats']['capacity'] = []
  for (const cap of SEAT_CAPACITY) {
    const ids = new Set(cap.stands)
    const gen = cap.stands.reduce((n, id) => n + (generated[id] ?? 0), 0)
    if (!gen) continue
    if (gen <= cap.seats) {
      out.push({ stands: cap.stands, seats: cap.seats, generated: gen, kept: gen })
      continue
    }
    const rate = cap.seats / gen
    /** error accumulator per row, so every row keeps the same share of its own places */
    const acc = new Map<string, number>()
    let kept = 0
    for (let i = 0; i < seats.length; i++) {
      const s = seats[i]!
      if (!ids.has(s.standId)) continue
      const key = `${s.standId}|${s.tierId}|${s.row}`
      const a = (acc.get(key) ?? 0) + rate
      if (a >= 1) {
        acc.set(key, a - 1)
        kept++
      } else {
        acc.set(key, a)
        // marked for removal; the compaction below is one pass over the array
        seats[i] = null as unknown as SeatSlot
      }
    }
    let w = 0
    for (let i = 0; i < seats.length; i++) if (seats[i]) seats[w++] = seats[i]!
    seats.length = w
    out.push({ stands: cap.stands, seats: cap.seats, generated: gen, kept })
  }
  return out
}

/**
 * The stair in the 13 m notch between E-2 and E-1, which the relief now claims as one ramp
 * (facilityRelief, E2's `extend`). Ten treads climbing the bank, each one standing on the ground
 * it is actually over: the tread height comes from `Ground.standY` at that tread's own lateral,
 * so the flight follows the relief instead of cutting through it.
 */
function addNotchStair(ctx: EnvBuildContext, mats: Mats) {
  const { track, ground } = ctx
  const spec = standPathSpec(track, 'E2')
  const def = STANDS.find((d) => d.id === 'E2')
  if (!spec || !def) return
  const local = pathLocalDef(def, spec)
  const frame = pathFrame(ground, spec)
  const t = def.tiers[0]!.tread
  const lf = alongAt(local.lateralFront, spec.len, local.sRange)
  const { depth } = stackAt(local, lf, alongAt(local.lateralBack, spec.len, local.sRange))
  const v0 = lf - 0.5 * t
  const treads = 10
  const step = (depth + 1.0) / treads
  const rgb = tint('#a5a39f', mats.concreteAvg)
  const geos: THREE.BufferGeometry[] = []
  // the flight sits in the gap, 2 m past E-2's last section, 4 m wide across the notch
  const u = spec.len + 2.0
  /** the drawn ground under this tread, in the chord frame's own heights */
  const treadY = (v: number) => {
    frame.at(u, v, 0, _p)
    return ground.standY(_p.x, _p.z) - _p.y
  }
  let prev = treadY(v0)
  for (let k = 0; k < treads; k++) {
    const y = treadY(v0 + (k + 0.5) * step)
    const rise = Math.max(0.12, y - prev)
    geos.push(box(frame, u, v0 + (k + 0.5) * step, y - rise, 4.0, rise + 0.12, step, rgb, mats.concreteTex))
    prev = y
  }
  const merged = mergeGeometries(geos, false)
  for (const g of geos) g.dispose()
  if (!merged) return
  const mesh = new THREE.Mesh(merged, mats.terrace)
  mesh.name = 'stand-E-notch-stair'
  mesh.castShadow = true
  mesh.receiveShadow = true
  ctx.group.add(mesh)
}

// ---------------------------------------------------------------------------------------------
// terrain relief

/**
 * [height above the local track surface, blend weight, mode?, rank?]. Mode `true` (cut) replaces
 * the natural ground either way (the deck band of a stand cut into a hill — without it the real
 * hillside behind E / D rises through the upper rows); `'cap'` only ever lowers it (the levelled
 * service road in front of C's toe); a fill sample (undefined) only ever raises it. Rank 0
 * marks the ground under a stand (front bank, deck band, walkway), rank 1 (default) the ground
 * behind it: where two zones' frames both claim a point, the one that has a deck there wins.
 */
export type Relief = [number, number, (boolean | 'cap')?, number?]

/** A zone measured in (s, lateral) against its own stretch of centreline. */
interface TrackZone {
  kind: 'track'
  /** s range the zone claims, fades included */
  from: number
  to: number
  /** the stand's own s range: outside it the claim fades out over `fade` metres (before, after) */
  core: [number, number]
  fade: [number, number]
  /**
   * relief at |lateral| a; null = no effect. `g` is the real ground (dem.ts) at the point,
   * relative to the same reference the returned height is (the road at sample s): the outer
   * fades ramp onto it so the claim ends ON the DEM (plan §1a, |relief − DEM| ≤ 1.5 m at every
   * zero-weight edge)
   */
  profile: (s: number, a: number, g: number) => Relief | null
  /** centreline samples of [from, to] and their bounding box padded by the zone's reach (lazy) */
  samples?: Int32Array
  box?: [number, number, number, number]
}

/** A zone measured in the (u, v) frame of a path-built stand (StandDef.path). */
interface ChordZone {
  kind: 'chord'
  chord: PathSpec
  /** the claim fades out over these metres before u = 0 and after u = len */
  fade: [number, number]
  /** v band the profile can claim */
  vRange: [number, number]
  /**
   * As TrackZone.profile; `g` is the DEM relative to the chord's own reference height at u.
   * `past` is how far beyond the near end of the chord the point lies, measured ALONG that end's
   * tangent and SIGNED by the end: 0 inside the chord, negative before u = 0, positive past
   * u = len. A profile that is extended past its end (`extend`) uses it to ramp its section onto
   * whatever is on the other side of the gap — and the sign is what keeps it from doing that in
   * front of its first section as well.
   */
  profile: (u: number, v: number, g: number, past: number) => Relief | null
  box: [number, number, number, number]
  /** the end fades (before u = 0, after u = len) that also take the claim's height onto the DEM: a zone's outer ends, not the ones that face another block */
  land?: [boolean, boolean]
  /**
   * How far past each end the profile still claims at FULL weight before its fade starts (m).
   * This is how the gap between two neighbouring blocks becomes ONE claim: E-2's profile runs
   * on across the 13.2 m stair notch and lands exactly on E-1's first section, and E-1's own
   * before-fade is 0, so nothing else claims in there. Two zones each claiming the notch at
   * nearly full weight is what put the 5.6 m step in it (G5, 2026-09 audit).
   */
  extend?: [number, number]
}

/** A zone bounded by a world polygon (the retention basins): the ground inside is a sunken floor. */
interface PolyZone {
  kind: 'poly'
  /** closed ring in world xz */
  pts: [number, number][]
  box: [number, number, number, number]
  /** absolute heights: the shoreline and the floor */
  shoreY: number
  floorY: number
  /** metres over which the bank falls from the shore to the floor */
  bank: number
}

type ReliefZone = TrackZone | ChordZone | PolyZone

/** a chord zone's claim fades to nothing over this many metres inside each edge of its v band */
const V_FADE = 8
function chordZone(chord: PathSpec, fade: [number, number], vRange: [number, number], profile: ChordZone['profile'], land?: [boolean, boolean], extend?: [number, number]): ChordZone {
  // the path's own bounding box, grown by the fades, the extensions and the v band it claims
  const pad = Math.max(fade[0] + (extend?.[0] ?? 0), fade[1] + (extend?.[1] ?? 0)) + Math.max(Math.abs(vRange[0]), Math.abs(vRange[1]))
  const b = chord.box
  return { kind: 'chord', chord, fade, vRange, profile, box: [b[0] - pad, b[1] + pad, b[2] - pad, b[3] + pad], land, extend }
}

/** how far to the left of the centreline a track zone can reach (the widest fade: E, lb + 70) */
const RELIEF_REACH = 170
/**
 * v band of the E hill's chord zones: the plateau's back slope (lb + 40 … lb + 70, lb up to 77 m
 * in E2's chord frame) has to land on the DEM INSIDE the band — a 120 m band cut it off at
 * full height and V_FADE turned that into a 10–16 m step
 */
const E_V_MAX = 160

function reliefZones(track: Track): ReliefZone[] {
  const L = track.length
  const zones: ReliefZone[] = []
  const by = (id: string) => STANDS.find((s) => s.id === id)
  /** piecewise-linear ramp between (a0, h0) and (a1, h1) */
  const ramp = (a: number, a0: number, h0: number, a1: number, h1: number) => h0 + ((h1 - h0) * (a - a0)) / (a1 - a0)
  const under = (h: number): Relief => [h, 1, true, 0]
  const cut = (h: number): Relief => [h, 1, true]
  const cap = (h: number): Relief => [h, 1, 'cap']
  const fill = (h: number, w = 1): Relief => [h, w]
  /**
   * A hill does not stop at the last row: the relief runs on past the stand ends and fades
   * over `fade` metres (the coarse terrain grid would otherwise smear a 10 m cliff at the
   * stand's end back under its first rows). No fade between the tiers of one stand, and
   * only a token one where another building stands right next door (B beside C's T2 end).
   */
  const zone = (core: [number, number], fade: [number, number], profile: TrackZone['profile']): TrackZone =>
    ({ kind: 'track', from: core[0] - fade[0], to: core[1] + fade[1], core, fade, profile })
  /** row-1 centre, front edge, platform height and structure back / top of a path stand at u */
  const chordSection = (local: StandDef, u: number) => {
    const t = local.tiers[0]!.tread
    const lf = alongAt(local.lateralFront, u, local.sRange)
    const fh = alongAt(local.frontHeight, u, local.sRange) - 0.6
    const { depth, rise } = stackAt(local, lf, alongAt(local.lateralBack, u, local.sRange))
    return { front: lf - 0.5 * t, fh, lb: lf + depth, top: fh + rise }
  }
  const C = by('C')
  const cSpec = C ? pathSpec(track, C) : null
  if (C && cSpec) {
    const local = pathLocalDef(C, cSpec)
    zones.push(chordZone(cSpec, [4, 40], [-30, 120], (u, v, g) => {
        const { front, fh, lb, top } = chordSection(local, u)
        // the 2009 service road at the toe, ≈ 1 m under row 1: the natural hill in front of the
        // Esses end stood above the toe and the 18 m terrain grid drew that mismatch as a
        // sawtooth, so the ground between the run-off and the wall is capped to the road level
        const toe = fh - 1.0
        if (v < front - 25) return null
        if (v < front - 6) return cap(Math.min(toe, ramp(v, front - 25, 0.3, front - 6, toe)))
        // retaining wall: a 6 m ramp is the narrowest the grid resolves without aliasing
        if (v < front) return under(ramp(v, front - 6, toe, front, fh))
        if (v < lb) return under(ramp(v, front, fh, lb, top))
        if (v < lb + 12) return cut(top)
        // the hill behind the concourse is capped to a 40 % bank the grid can resolve (a fill
        // only raised lower ground, so at the Esses end the hill met the concourse as a cliff)
        // ...and lands on (or above) the real ground, so the cap's own edge is never a step
        if (v < lb + 42) return cap(ramp(v, lb + 12, top, lb + 42, Math.max(top + 12, g)))
        return null
    }))
  }
  const D5 = by('D5')
  if (D5) {
    zones.push(zone(D5.sRange, [20, 12], (s, a, g) => {
        const lf = alongAt(D5.lateralFront, s, D5.sRange) - 0.5
        const fh = alongAt(D5.frontHeight, s, D5.sRange) - 0.6
        const lb = lf + 16 * 0.95
        const top = fh + 15 * 0.32
        // the 7 m grass bank (≈ 20°) rises from inside the run-off
        if (a < 22) return null
        if (a < lf) return under(ramp(a, 22, 0, lf, fh))
        if (a < lb) return under(ramp(a, lf, fh, lb, top))
        if (a < lb + 8) return cut(top)
        // the bank behind the crest runs down onto the real ground (7.2 m above it before)
        if (a < lb + 30) return fill(ramp(a, lb + 8, top, lb + 30, g), 1 - (a - lb - 8) / 22)
        return null
    }))
  }
  // D and E are split per tier: their footprints wrap round a bend (逆バンク → Dunlop), so one
  // zone's nearest centreline sample behind the first tier can belong to the second tier's
  // stretch, which sits on very different ground
  const D = by('D1_4')
  if (D) {
    D.tiers.forEach((tier, k) => {
      const rows = tier.rows
      zones.push(zone(tier.sRange ?? D.sRange, [k === 0 ? 12 : 0, k === D.tiers.length - 1 ? 15 : 0], (s, a, g) => {
          const lf = alongAt(D.lateralFront, s, D.sRange) - 0.5
          const fh = alongAt(D.frontHeight, s, D.sRange) - 0.6
          const lb = lf + rows * 0.95
          const top = fh + rows * 0.32
          if (a < lf - 1) return null
          if (a < lf) return under(ramp(a, lf - 1, 0, lf, fh))
          if (a < lb) return under(ramp(a, lf, fh, lb, top))
          if (a < lb + 7) return cut(top + 0.5)
          if (a < lb + 12) return fill(ramp(a, lb + 7, top + 0.5, lb + 12, 10.0))
          if (a < lb + 24) return fill(ramp(a, lb + 12, 10.0, lb + 24, 13.4))
          // the plateau's outer slope lands on the real ground: the DEM behind D falls from
          // ≈ +5 to −6 m relative to the track along the stand, a constant fill left up to 19 m
          if (a < lb + 54) return fill(ramp(a, lb + 24, 13.4, lb + 54, g), 1 - (a - lb - 24) / 30)
          return null
      }))
    })
  }
  // E: two blocks on one hillside. The hilltop plateau (E temporary stand) sits just above the
  // last row all along: the 58 m ASL figure is +15 over the track at the 逆バンク end but only
  // ≈ +8 at the NIPPO end. The bank in front rises at the deck's own rake, so bank and rows are
  // one plane with no bend at row 1 (a bend there makes the coarse terrain grid overshoot the
  // deck and leaves a metres-tall retaining wall once the grid is clamped back under it). The
  // plateau is cut as well: the real hill behind E (the DEM) stands above it in places.
  //
  // The 13.2 m stair notch between the two blocks is ONE claim, E-2's: its profile runs on past
  // its own last section (`extend`) and ramps linearly onto E-1's first section — E-1's front,
  // platform, back and top, brought into E-2's frame — while E-1's before-fade is 0 so it claims
  // nothing in there. Two zones bridging the notch with their fades is what the audit measured
  // as a 5.6 m step: both were at nearly full weight and the best-of rule switched hard between
  // them. (Section values are in each chord's OWN v and its own reference height, so the ramp
  // carries both offsets: E-1's start projects at v +11.8 in E-2's frame and its road is 1.07 m
  // higher there.)
  const E2 = by('E2')
  const E1 = by('E1')
  const e2Spec = E2 ? pathSpec(track, E2) : null
  const e1Spec = E1 ? pathSpec(track, E1) : null
  const eProfile = (local: StandDef, rake: number) => (u: number, v: number, g: number, sec?: { front: number; fh: number; lb: number; top: number }) => {
    const { front, fh, lb, top } = sec ?? chordSection(local, u)
    const plateau = top + 1.0
    const a0 = front - fh / rake
    if (v < a0) return null
    if (v < front) return under(ramp(v, a0, 0, front, fh))
    if (v < lb) return under(ramp(v, front, fh, lb, top))
    if (v < lb + 10) return under(top)
    if (v < lb + 16) return cut(ramp(v, lb + 10, top, lb + 16, plateau))
    if (v < lb + 40) return cut(plateau)
    // the plateau's back slope lands on the real hillside (the DEM, 10–16 m under it before),
    // inside the band's own fade
    const vEnd = Math.min(lb + 70, E_V_MAX - V_FADE)
    if (v < vEnd) return [ramp(v, lb + 40, plateau, vEnd, g), 1 - (v - lb - 40) / (vEnd - lb - 40), true] as Relief
    return null
  }
  if (E2 && e2Spec && E1 && e1Spec) {
    const l2 = pathLocalDef(E2, e2Spec)
    const l1 = pathLocalDef(E1, e1Spec)
    const rake2 = E2.tiers[0]!.riser / E2.tiers[0]!.tread
    const rake1 = E1.tiers[0]!.riser / E1.tiers[0]!.tread
    const prof2 = eProfile(l2, rake2)
    const prof1 = eProfile(l1, rake1)
    // E-1's first section, expressed in E-2's frame: its v origin sits `dv` behind E-2's, and its
    // road is `dy` above E-2's at the notch
    const start1 = e2Spec.project(e1Spec.px[0]!, e1Spec.pz[0]!)
    const dv = start1.v
    const dy = e1Spec.yRef(0) - e2Spec.yRef(e2Spec.len)
    /**
     * How far past E-2's last section E-1's first one lies, in the ONE measure `facilityRelief`
     * uses past a chord's end: the signed distance along that end's tangent. The two blocks are
     * 13.2 m apart end to end, but 11.8 m of that is ACROSS the chord (E-1 starts further from
     * the road — that is `dv`) and only 5.9 m along it.
     *
     * It is not one number, though. E-1's front edge leaves E-2's end tangent at an angle, so the
     * distance at which E-1 takes over shrinks as one walks back from the road: 5.9 m at E-2's
     * own front line, 2.9 m at 10 m behind E-1's. `notchAt(v)` is that line — the ramp has to
     * finish exactly where E-1's zone starts at THAT v, or the two claims meet at different
     * heights and their blend is a step (1.34 m measured with a constant 5.9 m ramp).
     */
    const eEnd = e2Spec.px.length - 1
    const gapAlong = (e1Spec.px[0]! - e2Spec.px[eEnd]!) * e2Spec.tan1[0] + (e1Spec.pz[0]! - e2Spec.pz[eEnd]!) * e2Spec.tan1[1]
    /** how much of E-1's own normal lies along E-2's end tangent (0 if the two chords are parallel) */
    const skew = e1Spec.nx[0]! * e2Spec.tan1[0] + e1Spec.nz[0]! * e2Spec.tan1[1]
    const notchAt = (v: number) => Math.max(0.5, gapAlong + (v - dv) * skew)
    /**
     * The widest the notch ever gets over the claimed v band (28 m out at the road end, half a
     * metre 160 m behind it). `extend` is one number for the whole zone, so it has to be the
     * widest — otherwise E-2's weight would start fading before E-1 takes over somewhere. What
     * stops E-2 from then claiming 28 m into E-1 everywhere is the profile itself: past the
     * handover at THIS v it returns null and E-1 has the ground alone. (Letting both claim to the
     * widest distance and blending was measured: three ≈ 3 m jumps at s 1604–1612 in G5, because
     * E-2's frozen section and E-1's own drift apart along E-1.)
     */
    const E_NOTCH = Math.max(notchAt(-60), notchAt(E_V_MAX), 0.5)
    const endSec = chordSection(l2, e2Spec.len)
    const nextSec = (() => {
      const s1 = chordSection(l1, 0)
      return { front: s1.front + dv, fh: s1.fh + dy, lb: s1.lb + dv, top: s1.top + dy }
    })()
    zones.push(chordZone(e2Spec, [20, 6], [-60, E_V_MAX], (u, v, g, past) => {
        if (past <= 0) return prof2(u, v, g)
        // across the notch: E-2's own last section ramps onto E-1's first one and reaches it
        // exactly where E-1's zone starts at this v — where the two claims are equal, so the
        // handover is continuous. Past that line E-2 has nothing more to say: E-1's own zone
        // starts there at full weight.
        const hand = notchAt(v)
        if (past > hand) return null
        const t = past / hand
        const sec = {
          front: endSec.front + (nextSec.front - endSec.front) * t,
          fh: endSec.fh + (nextSec.fh - endSec.fh) * t,
          lb: endSec.lb + (nextSec.lb - endSec.lb) * t,
          top: endSec.top + (nextSec.top - endSec.top) * t,
        }
        return prof2(u, v, g, sec)
    }, [true, false], [0, E_NOTCH]))
    // E-1 claims nothing before its own first section: the notch is E-2's
    zones.push(chordZone(e1Spec, [0, 30], [-40, E_V_MAX], (u, v, g) => prof1(u, v, g), [false, true]))
  }
  // retention basins: a sunken floor with a bank, so the dry-basin meshes in pit-complex.ts have
  // ground to sit in (a flat sheet at grade read as a lake — 2026-09 audit S01-04 / S02-05)
  for (const b of BASINS) {
    const f = osmFeature(b.osmWay)
    if (!f || !f.closed || f.en.length < 3) continue
    const pts: [number, number][] = f.en.map(([e, n]) => {
      track.enToWorld(e, n, _p)
      return [_p.x, _p.z]
    })
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
    for (const [x, z] of pts) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x)
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z)
    }
    // the shoreline sits on the natural ground: take the road plane at the basin's own s
    const shoreY = track.pointAt(f.centroid[0], 0, _p).y + 0.2
    zones.push({ kind: 'poly', pts, box: [minX, maxX, minZ, maxZ], shoreY, floorY: shoreY - b.depth - 0.15, bank: 9 })
  }

  // main grandstand: the level fill platform behind V1 (GP Square) is ≈ 7.3 m above the track
  // (5 m fades along s: the A1 temporary stand starts 5 m past its end at track level, and cut
  // dead the platform's ends were 7 m walls in the height field)
  zones.push(zone([5560, 70], [5, 5], (_s, a, g) => {
      if (a < 30) return null
      if (a < 38) return fill(ramp(a, 30, 0, 38, 7.3))
      if (a < 110) return fill(7.3)
      // the platform's back slope lands on the real ground (the car parks behind, 3–7 m lower)
      if (a < 140) return fill(ramp(a, 110, 7.3, 140, g), 1 - (a - 110) / 30)
      return null
  }))
  return zones
}

const zoneCache = new WeakMap<Track, ReliefZone[]>()

function zoneSamples(z: TrackZone, track: Track): Int32Array {
  if (z.samples) return z.samples
  const L = track.length
  const len = forwardDelta(z.from, z.to, L)
  const idx: number[] = []
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (let i = 0; i < track.n; i++) {
    if (forwardDelta(z.from, i * track.ds, L) > len) continue
    idx.push(i)
    const x = track.px[i]!, zz = track.pz[i]!
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (zz < minZ) minZ = zz
    if (zz > maxZ) maxZ = zz
  }
  z.samples = Int32Array.from(idx)
  z.box = [minX - RELIEF_REACH, maxX + RELIEF_REACH, minZ - RELIEF_REACH, maxZ + RELIEF_REACH]
  return z.samples
}

/**
 * Terrain relief under and behind the hillside stands (C's embankment, the D5 grass bank, the
 * D plateau, the E hill, the main-grandstand platform) at world (x, z). Returns [world height,
 * blend weight, cut?] or null — see `Relief`. Each zone measures (s, lateral) against ITS OWN
 * stretch of centreline, not the globally nearest sample: behind E the Dunlop stretch is the
 * nearer road, and a stand swept with track.pointAt(s, lateral) needs the ground under it
 * evaluated in the same frame. Where two zones claim a point, the one with a deck over it
 * (rank 0) wins, then the one whose centreline is nearer. Applied by Terrain.heightAt after
 * its embankment caps; the run-off ribbons sample the same function, so every ramp starts
 * under a stand's retaining wall or beyond the run-off (only the D5 grass bank and the E
 * hillside deliberately rise inside it).
 */
export function facilityRelief(x: number, z: number, track: Track): Relief | null {
  let zones = zoneCache.get(track)
  if (!zones) zoneCache.set(track, (zones = reliefZones(track)))
  let out: Relief | null = null
  let outRank = 2, outD2 = Infinity
  // the real ground at the point (dem.ts), read once and only when a zone's box admits the point
  let demH = NaN
  const demAt = () => (demH === demH ? demH : (demH = demFieldFor(track).height(x, z)))
  for (const zone of zones) {
    if (zone.kind === 'poly') {
      const box = zone.box
      if (x < box[0] || x > box[1] || z < box[2] || z > box[3]) continue
      const pts = zone.pts
      let inside = false
      let edge = Infinity
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, zi] = pts[i]!, [xj, zj] = pts[j]!
        if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside
        const dx = xj - xi, dz = zj - zi
        const t = Math.max(0, Math.min(1, ((x - xi) * dx + (z - zi) * dz) / (dx * dx + dz * dz || 1)))
        edge = Math.min(edge, Math.hypot(x - (xi + dx * t), z - (zi + dz * t)))
      }
      if (!inside) continue
      const k = Math.min(1, edge / zone.bank)
      // the bank is a WEIGHT over the floor, 0 at the shoreline: the ground descends from whatever
      // it is at the rim (a hillside 4 m above the road plane at the T1 pond's back) to the floor
      // over `bank` metres. A level shoreline at the road plane stepped 4 m down off that hill
      // (G11: 90 drops, G5: 0.5 m jumps along the rim)
      // 'cap' so the basin only ever lowers the ground, and rank 0 so it wins over a stand platform
      if (out && outRank < 1) continue
      out = [zone.floorY, k * k * (3 - 2 * k), 'cap']
      outRank = 1
      outD2 = edge * edge
      continue
    }
    if (zone.kind === 'chord') {
      const box = zone.box
      if (x < box[0] || x > box[1] || z < box[2] || z > box[3]) continue
      const c = zone.chord
      const pr = c.project(x, z)
      const u = pr.u, v = pr.v
      if (v < zone.vRange[0] || v > zone.vRange[1]) continue
      const uc = Math.min(c.len, Math.max(0, u))
      // project() clamps to the path's ends, so the end gap is measured from the projected point,
      // ALONG that end's tangent (signed): the radial measure this replaced counted the distance
      // BEHIND the chord as distance past its end, so a point 40 m behind E-2's last section was
      // 40 m into its fade while E-1 claimed the same point almost whole — the two nearly-whole
      // claims and the hard best-of switch between them are what left the 5.6 m step in the notch.
      // The along-tangent measure alone makes a notch of its own (nothing claims the gap), which
      // is why the gap is now ONE claim: `extend` carries E-2's profile across it (see ChordZone).
      const atStart = pr.u <= 0.01
      const endGap = atStart
        ? -((x - c.px[0]!) * c.tan0[0] + (z - c.pz[0]!) * c.tan0[1])
        : pr.u >= c.len - 0.01
          ? (x - c.px[c.px.length - 1]!) * c.tan1[0] + (z - c.pz[c.pz.length - 1]!) * c.tan1[1]
          : 0
      const ext = endGap <= 0 ? 0 : (atStart ? zone.extend?.[0] : zone.extend?.[1]) ?? 0
      const past = Math.max(0, endGap)
      const beyond = past - ext
      const t = beyond <= 0 ? 0 : beyond / Math.max(1e-6, atStart ? zone.fade[0] : zone.fade[1])
      if (t >= 1) continue
      const yRef = c.yRef(uc)
      // `past` reaches the profile SIGNED by which end it is off: negative before u = 0, positive
      // past u = len, 0 inside. A profile that is extended over a gap (E-2's, across the notch)
      // must not mistake the ground in front of its first section for the ground beyond its last.
      const r = zone.profile(uc, v, demAt() - yRef, atStart ? -past : past)
      if (!r) continue
      let w = t > 0 ? r[1] * (1 - t * t * (3 - 2 * t)) : r[1]
      // ...and across the v band's two edges, over V_FADE metres inside them: cut hard, the E hill's
      // plateau ended in an 11 m cliff at the band's edge (G5's worst jump)
      const vIn = Math.min(v - zone.vRange[0], zone.vRange[1] - v)
      if (vIn < V_FADE) { const q = vIn / V_FADE; w *= q * q * (3 - 2 * q) }
      const rank = r[3] ?? 1
      const d2 = v * v + past * past
      let h = yRef + r[0]
      // through an end fade the claim's HEIGHT goes to the real ground as well as its weight: a
      // cap (C's toe road) only ever rises onto it, so it ends on the hillside instead of cutting
      // a step; a zone's outer end (`land`) always does, so the E hill's plateau runs out onto
      // the DEM instead of standing 10–16 m over it where the weight reaches zero
      if (t > 0 && (r[2] === 'cap' ? demAt() > h : zone.land?.[atStart ? 0 : 1])) h += (demAt() - h) * t * t * (3 - 2 * t)
      if (out && rank === outRank && r[2] === out[2]) {
        // two claims of the same rank and the same mode: BLEND them by weight, always. Taking the
        // nearer one made the ground jump wherever which zone is nearer changes, and a
        // full-weight special case put the jump back at the edge of the special case
        const wSum: number = w + out[1]
        const hOut: number = out[0], wOut: number = out[1]
        out = [wSum > 1e-6 ? (h * w + hOut * wOut) / wSum : h, Math.max(w, wOut), r[2]]
        outD2 = Math.min(d2, outD2)
        continue
      }
      if (out && (rank > outRank || (rank === outRank && d2 >= outD2))) continue
      out = [h, w, r[2]]
      outRank = rank
      outD2 = d2
      continue
    }
    const samples = zoneSamples(zone, track)
    const box = zone.box!
    if (x < box[0] || x > box[1] || z < box[2] || z > box[3]) continue
    // the sample the point is abreast of (|along| ≤ one sample spacing), nearest first. Plain
    // nearest-sample fails here twice over: on the inside of the 逆バンク→Dunlop bend a point
    // behind E-2's rows is nearer to E-2's last samples than to its own, and a point beyond
    // either end of the stretch projects onto an end sample's normal with a meaningless lateral
    // (the run-off in front of E-2 read as "100 m behind E-1")
    // Core samples are preferred over fade samples: on the inside of a bend (C's Esses end
    // faces T3) a point beside the stand's tail is also abreast of samples past the stand,
    // through the fold of the converging normals, and the nearer of those would only hand
    // it a faded claim
    const L = track.length
    const coreLen = forwardDelta(zone.core[0], zone.core[1], L)
    let best = Infinity, bi = -1, bestCore = false
    for (let k = 0; k < samples.length; k++) {
      const i = samples[k]!
      const dx = x - track.px[i]!, dz = z - track.pz[i]!
      const d2 = dx * dx + dz * dz
      const core = forwardDelta(zone.core[0], i * track.ds, L) <= coreLen
      if (bestCore && !core) continue
      if (d2 >= best && core === bestCore) continue
      if (Math.abs(dx * track.tx[i]! + dz * track.tz[i]!) > track.ds) continue
      best = d2
      bi = i
      bestCore = core
    }
    if (bi < 0) continue
    const dx = x - track.px[bi]!, dz = z - track.pz[bi]!
    // all relief zones lie on the left of their road
    const lateral = dx * track.nx[bi]! + dz * track.nz[bi]!
    if (lateral <= 0) continue
    const sBi = bi * track.ds
    const r = zone.profile(sBi, lateral, demAt() - track.py[bi]!)
    if (!r) continue
    // the profile is read at a SAMPLE: between two samples the relief would step every 2 m (a
    // sawtooth the faces chord by 40 mm), so it is blended with the neighbouring sample the point
    // lies towards, by its distance along the tangent; a neighbour with no claim fades it out
    const along = dx * track.tx[bi]! + dz * track.tz[bi]!
    const bj = along >= 0 ? (bi + 1) % track.n : (bi - 1 + track.n) % track.n
    const tt = Math.min(1, Math.abs(along) / track.ds)
    let h = track.py[bi]! + r[0]
    let w = r[1]
    if (tt > 0 && forwardDelta(zone.from, bj * track.ds, L) <= forwardDelta(zone.from, zone.to, L)) {
      const dxj = x - track.px[bj]!, dzj = z - track.pz[bj]!
      const rj = zone.profile(bj * track.ds, dxj * track.nx[bj]! + dzj * track.nz[bj]!, demAt() - track.py[bj]!)
      if (rj && rj[2] === r[2]) { h += (track.py[bj]! + rj[0] - h) * tt; w += (rj[1] - w) * tt }
      else w *= 1 - tt
    }
    // fade the claim out past the stand's own ends
    const sAt = track.wrap(sBi + along)
    if (forwardDelta(zone.core[0], sAt, L) > coreLen) {
      const before = forwardDelta(sAt, zone.core[0], L), after = forwardDelta(zone.core[1], sAt, L)
      const t = before < after ? before / Math.max(1e-6, zone.fade[0]) : after / Math.max(1e-6, zone.fade[1])
      if (t >= 1) continue
      w *= 1 - t * t * (3 - 2 * t)
      // as for the chord zones: a cap's end fade rises onto the real ground
      if (r[2] === 'cap' && demAt() > h) h += (demAt() - h) * t * t * (3 - 2 * t)
    }
    const rank = r[3] ?? 1
    if (out && rank === outRank && r[2] === out[2]) {
      // same rank, same mode → blend (see the chord branch): the D tiers and the two E blocks
      // meet along a line, and picking the nearer of two live claims steps across it
      const wSum: number = w + out[1]
      const hOut: number = out[0], wOut: number = out[1]
      out = [wSum > 1e-6 ? (h * w + hOut * wOut) / wSum : h, Math.max(w, wOut), r[2]]
      outD2 = Math.min(best, outD2)
      continue
    }
    if (out && (rank > outRank || (rank === outRank && best >= outD2))) continue
    out = [h, w, r[2]]
    outRank = rank
    outD2 = best
  }
  return out
}

/** Outer edge of a stand's footprint (max over its breakpoints), for the tree exclusion zones. */
export function lateralBackMax(v: AlongTrack): number {
  if (typeof v === 'number') return Math.abs(v)
  let m = 0
  for (const [, x] of v) m = Math.max(m, Math.abs(x))
  return m
}
