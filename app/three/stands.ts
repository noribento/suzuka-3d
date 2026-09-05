import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { alongAt, COLOURS, STANDS, type AlongTrack, type SeatKind, type StandDef, type StandTier } from '~/data/suzuka-facilities-spec'
import { OSM_STANDS, type OsmFeature } from '~/data/suzuka-facilities'
import { forwardDelta, type Track } from '~/sim/track'
import type { EnvBuildContext, Terrain } from './environment'
import type { Ground } from './ground'
import { bucketedInstancedMeshes } from './instancing'
import { pbrFromAssets } from './materials'
import { boardTexture, concreteMaps } from './textures'

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
  kind: SeatKind
}

export interface Stands {
  seats: SeatSlot[]
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
const CHAIR_PITCH = 0.507
const BENCH_PITCH = 0.55
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
    ground: (u, v) => ground.yAt(u, v),
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
function localFrame(terrain: Terrain, origin: THREE.Vector3, along: THREE.Vector3, back: THREE.Vector3, len: number, sApprox: number): Frame {
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
      return terrain.meshHeightAt(_p2.x, _p2.z) - origin.y
    },
    facingYaw: () => yaw,
    sAt: (u) => sApprox + u - len / 2,
  }
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
  const glassPhoto = photo('facade001')
  const glass = reg && glassPhoto
    ? pbrFromAssets(reg, 'facade001', { fallback: () => new THREE.MeshStandardMaterial(), handBuiltUv: true, extra: { side: THREE.DoubleSide } })
    : new THREE.MeshStandardMaterial({ color: COLOURS.glassVip.mid, roughness: 0.18, metalness: 0.65, side: THREE.DoubleSide })
  const seat = reg && photo('plastic013a')
    ? pbrFromAssets(reg, 'plastic013a', { fallback: () => new THREE.MeshStandardMaterial(), handBuiltUv: true, normalScale: 0.5 })
    : new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55 })
  return {
    terrace,
    // the procedural tile averages ≈ #969696, the photo tile is a lighter, warmer concrete
    concreteAvg: lin(concretePhoto ? '#b5b2ac' : '#969696'),
    concreteTex: 1 / (concretePhoto ? tileOf('concrete046', 2.4) : 4),
    furniture: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.25 }),
    seat,
    tube: new THREE.MeshStandardMaterial({ color: 0x9da3a8, roughness: 0.45, metalness: 0.8 }),
    corrugated,
    corrugatedTex: 1 / (corrugatedPhoto ? tileOf('corrugatedsteel003', 2) : 2),
    glass,
    glassTex: 1 / (glassPhoto ? tileOf('facade001', 3) : 3),
    board: new THREE.MeshStandardMaterial({ map: boardTexture(), roughness: 0.5 }),
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
  corrugated: THREE.BufferGeometry[]
  seats: SeatSlot[]
  seatMatrices: THREE.Matrix4[]
  seatColors: THREE.Color[]
  seatS: number[]
  tubeMatrices: THREE.Matrix4[]
  tubeS: number[]
  /** deck vertices (world xyz) the terrain grid is sunk under */
  deckPts: number[]
  /** overhead slabs for the vertex AO: lateral band and the slab's underside height at (u, v) */
  overhead: { v0: number; v1: number; y: (u: number, v: number) => number }[]
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
      const lo = Math.min(o.v0, o.v1), hi = Math.max(o.v0, o.v1)
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
  const pitch = run.tier.seat === 'chair' ? CHAIR_PITCH : BENCH_PITCH
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
  const groundBelow = (u: number, v: number) => frame.ground(u, v) - 2
  if (!opts.noSkirt) b.terrace.push(wall(frame, run.u0, run.len, vFront, (u) => groundBelow(u, vFront(u)), run.h0, 3, side < 0 ? 1 : -1, skirtRgb, mats.concreteTex))
  b.terrace.push(wall(frame, run.u0, run.len, run.vBack, (u) => groundBelow(u, run.vBack(u)), run.yTop, 3, side, wallRgb, mats.concreteTex))
  for (const [u, facing] of [[run.u0, -1], [run.u0 + run.len, 1]] as const) {
    const poly = sectionPoly(b, run, u, groundMin(b, run, u) - 2)
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
 * Main grandstand upper works over V2: the two-storey glazed hospitality band on piers behind
 * the V2 rows, and the 18 × 186 m roof slab (ribbed soffit, fascia, white triangular trusses on
 * top). Everything is swept along the track, so it tilts with the 2.8 % gradient like the real one.
 */
function addMainRoofAndBand(b: Build, runs: TierRun[]) {
  const { frame, side, mats, def } = b
  const roof = def.roof!
  const avg = mats.concreteAvg
  const white = tint(COLOURS.mullionWhite.mid, avg)
  const [rs0, rs1] = roof.sRange ?? def.sRange
  const u0 = rs0
  const len = forwardDelta(rs0, rs1, b.ctx.track.length)
  const [vA, vB] = roof.lateral
  const bandFront = 47, bandBack = vB
  const bandFloor = 19.5, bandTop = roof.soffit - 0.1
  const upper = runs[runs.length - 1]!
  // --- glazed band --------------------------------------------------------------------------
  b.overhead.push({ v0: bandFront - 0.6, v1: bandBack, y: () => bandFloor - 0.5 })
  const pier = tint(COLOURS.pierConcrete.mid, avg)
  const deckY = (u: number, v: number) => {
    const d = (v - upper.lf(u)) * side + 0.5 * upper.tier.tread
    return upper.h0(u) + Math.min(upper.rowsAt(u), Math.max(0, Math.floor(d / upper.tier.tread))) * upper.tier.riser
  }
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
  // --- roof slab -----------------------------------------------------------------------------
  b.overhead.push({ v0: vA, v1: vB, y: () => roof.soffit })
  const topRgb = tint(COLOURS.roofTop.mid, avg)
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
  // --- rear façade towards GP Square: white RC wall with stair openings ------------------------
  const facade = tint('#e2e1dc', avg)
  const dark = tint('#2a2c30', avg)
  const vRear = bandBack + 0.3
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
  const { frame, side, mats, ctx } = b
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
  // kiosks / toilets along the back of the concourse (merged with the other props)
  for (let d = 9; d < run.len - 9; d += 37) {
    const u = run.u0 + d
    ctx.boxes.place(frame.sAt(u), vOut(u) - side * 2.2, 8, 3.2, 2.7, mats.kiosk, run.yTop(u) - frame.ground(u, vOut(u) - side * 2.2), false, true)
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
// stand assembly

function newBuild(ctx: EnvBuildContext, def: StandDef, frame: Frame, mats: Mats): Build {
  const group = new THREE.Group()
  group.name = `stand-${def.id}`
  return { def, frame, side: def.side, mats, ctx, group, terrace: [], furniture: [], glass: [], board: [], corrugated: [], seats: [], seatMatrices: [], seatColors: [], seatS: [], tubeMatrices: [], tubeS: [], deckPts: [], overhead: [] }
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
      b.overhead.push({ v0: 60, v1: 82, y: (u, v) => h0(u) - 0.55 + Math.max(0, v - lf(u)) * (deck.riser / deck.tread) })
    }
  }
  if (def.roof && def.id !== 'V2') b.overhead.push({ v0: def.roof.lateral[0], v1: def.roof.lateral[1], y: () => def.roof!.soffit })
  if (def.id === 'V2') {
    const roof = def.roof!
    b.overhead.push({ v0: roof.lateral[0], v1: roof.lateral[1], y: () => roof.soffit })
    b.overhead.push({ v0: 46.5, v1: roof.lateral[1], y: () => 19.0 })
  }
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
  if (def.id === 'V2') addMainRoofAndBand(b, runs)
  if (def.enclosure) {
    const e = def.enclosure
    const [s0, s1] = def.sRange
    addEnclosure(b, s0, forwardDelta(s0, s1, b.ctx.track.length), (u) => alongAt(def.lateralFront, u, def.sRange), (u) => alongAt(def.lateralBack, u, def.sRange), e.floors, e.roofTop, e.framePitch, def.id === 'VIP')
  }
  return runs
}

interface Lodded {
  inst: THREE.InstancedMesh
  full: number
  centre: THREE.Vector3
  range: number
}

function finishStand(b: Build, lod: Lodded[], seatGeo: THREE.BufferGeometry, tubeGeo: THREE.BufferGeometry): { tris: number; instances: number } {
  const { mats, group, def, ctx } = b
  let tris = 0
  const merge = (geos: THREE.BufferGeometry[], mat: THREE.Material, name: string, cast: boolean) => {
    if (!geos.length) return
    const merged = mergeGeometries(geos, false)
    for (const g of geos) g.dispose()
    if (!merged) return
    const mesh = new THREE.Mesh(merged, mat)
    mesh.name = name
    mesh.castShadow = cast
    mesh.receiveShadow = true
    group.add(mesh)
    tris += (merged.index ? merged.index.count : (merged.attributes.position as THREE.BufferAttribute).count) / 3
  }
  merge(b.terrace, mats.terrace, 'terrace', true)
  merge(b.furniture, mats.furniture, 'furniture', false)
  merge(b.glass, mats.glass, 'glass', true)
  merge(b.board, mats.board, 'boards', false)
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
  const { track, terrain } = ctx
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
    const dA = terrain.distanceToTrack(sideA.x, sideA.z, 200), dB = terrain.distanceToTrack(sideB.x, sideB.z, 200)
    const frontIsA = dA.d < dB.d
    const back = frontIsA ? across.clone() : across.clone().negate()
    const near = frontIsA ? dA : dB
    // the frame's along-direction keeps (along × up) pointing to the back so the deck faces up
    const dir = back.clone().cross(Y_UP).normalize()
    const origin = new THREE.Vector3().addScaledVector(along, dir.dot(along) > 0 ? minA : maxA).addScaledVector(across, frontIsA ? minB : maxB)
    origin.y = near.i >= 0 ? track.py[near.i]! : terrain.meshHeightAt(origin.x, origin.z)
    out.push({ frame: localFrame(terrain, origin, dir, back, len, near.s), len, width })
  }
  return out
}

/** Build every stand; returns the seat positions for the crowd and the per-frame LOD update. */
export function buildStands(ctx: EnvBuildContext): Stands {
  const { track, ground, terrain } = ctx
  const mats = makeMaterials(ctx)
  const seatGeo = seatPrototype()
  const tubeGeo = new THREE.CylinderGeometry(0.03, 0.03, 1, 5, 1, true)
  const lod: Lodded[] = []
  const seats: SeatSlot[] = []
  const deckPts: number[] = []
  const stats: string[] = []
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
        const r = finishStand(b, lod, seatGeo, tubeGeo)
        for (const s of b.seats) seats.push(s)
        for (const p of b.deckPts) deckPts.push(p)
        stats.push(`${local.tiers[0]!.id}: ${Math.round(r.tris)} tris, ${r.instances} inst, ${b.seats.length} seats`)
        totalTris += r.tris
        totalInst += r.instances
      }
      continue
    }
    const frame = trackFrame(track, ground, def.sRange[0], def.sRange[1])
    const b = newBuild(ctx, def, frame, mats)
    buildStand(b)
    const r = finishStand(b, lod, seatGeo, tubeGeo)
    for (const s of b.seats) seats.push(s)
    for (const p of b.deckPts) deckPts.push(p)
    stats.push(`${def.id}: ${Math.round(r.tris)} tris, ${r.instances} inst, ${b.seats.length} seats`)
    totalTris += r.tris
    totalInst += r.instances
  }
  // the 13 m terrain grid is far coarser than the decks: sink it wherever it would show through
  terrain.clampUnder(Float32Array.from(deckPts), 0.3)
  if (import.meta.dev) {
    ctx.group.userData.standStats = stats
    console.info(`[stands] ${STANDS.length} stands, ${Math.round(totalTris)} tris, ${totalInst} instances, ${seats.length} seats`)
  }
  const update = (cameraPos: THREE.Vector3) => {
    for (const l of lod) {
      const n = cameraPos.distanceTo(l.centre) < l.range ? l.full : 0
      if (n !== l.inst.count) l.inst.count = n
    }
  }
  return { seats, update }
}

// ---------------------------------------------------------------------------------------------
// terrain relief

/**
 * [height above the local track surface, blend weight, cut?, rank?]. A `cut` sample replaces
 * the natural ground either way (the deck band of a stand cut into a hill — without it the real
 * hillside behind E / D rises through the upper rows); a fill sample only ever raises it. Rank 0
 * marks the ground under a stand (front bank, deck band, walkway), rank 1 (default) the ground
 * behind it: where two zones' frames both claim a point, the one that has a deck there wins.
 */
export type Relief = [number, number, boolean?, number?]

interface ReliefZone {
  /** s range the zone claims, fades included */
  from: number
  to: number
  /** the stand's own s range: outside it the claim fades out over `fade` metres (before, after) */
  core: [number, number]
  fade: [number, number]
  /** relief at |lateral| a; null = no effect */
  profile: (s: number, a: number) => Relief | null
  /** centreline samples of [from, to] and their bounding box padded by the zone's reach (lazy) */
  samples?: Int32Array
  box?: [number, number, number, number]
}

/** how far to the left of the centreline a zone can reach (the widest fade: E, lb + 70) */
const RELIEF_REACH = 170

function reliefZones(L: number): ReliefZone[] {
  const zones: ReliefZone[] = []
  const by = (id: string) => STANDS.find((s) => s.id === id)
  /** piecewise-linear ramp between (a0, h0) and (a1, h1) */
  const ramp = (a: number, a0: number, h0: number, a1: number, h1: number) => h0 + ((h1 - h0) * (a - a0)) / (a1 - a0)
  const under = (h: number): Relief => [h, 1, true, 0]
  const cut = (h: number): Relief => [h, 1, true]
  const fill = (h: number, w = 1): Relief => [h, w]
  /**
   * A hill does not stop at the last row: the relief runs on past the stand ends and fades
   * over `fade` metres (the coarse terrain grid would otherwise smear a 10 m cliff at the
   * stand's end back under its first rows). No fade between the tiers of one stand, and
   * only a token one where another building stands right next door (B beside C's T2 end).
   */
  const zone = (core: [number, number], fade: [number, number], profile: ReliefZone['profile']): ReliefZone =>
    ({ from: core[0] - fade[0], to: core[1] + fade[1], core, fade, profile })
  const C = by('C')
  if (C) {
    zones.push(zone(C.sRange, [4, 30], (s, a) => {
        const lf = alongAt(C.lateralFront, s, C.sRange) - 0.4
        const fh = alongAt(C.frontHeight, s, C.sRange) - 0.6
        const lb = lf + 25.6
        const top = fh + 30 * 0.3
        // retaining wall at the toe (the 2009 service road runs in front of it)
        if (a < lf - 1) return null
        if (a < lf) return under(ramp(a, lf - 1, 0, lf, fh))
        if (a < lb) return under(ramp(a, lf, fh, lb, top))
        if (a < lb + 12) return cut(top)
        if (a < lb + 42) return fill(top, 1 - (a - lb - 12) / 30)
        return null
    }))
  }
  const D5 = by('D5')
  if (D5) {
    zones.push(zone(D5.sRange, [20, 12], (s, a) => {
        const lf = alongAt(D5.lateralFront, s, D5.sRange) - 0.5
        const fh = alongAt(D5.frontHeight, s, D5.sRange) - 0.6
        const lb = lf + 16 * 0.95
        const top = fh + 15 * 0.32
        // the 7 m grass bank (≈ 20°) rises from inside the run-off
        if (a < 22) return null
        if (a < lf) return under(ramp(a, 22, 0, lf, fh))
        if (a < lb) return under(ramp(a, lf, fh, lb, top))
        if (a < lb + 8) return cut(top)
        if (a < lb + 30) return fill(top, 1 - (a - lb - 8) / 22)
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
      zones.push(zone(tier.sRange ?? D.sRange, [k === 0 ? 12 : 0, k === D.tiers.length - 1 ? 15 : 0], (s, a) => {
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
          if (a < lb + 54) return fill(13.4, 1 - (a - lb - 24) / 30)
          return null
      }))
    })
  }
  const E = by('E')
  if (E) {
    E.tiers.forEach((tier, k) => {
      const rows = tier.rows
      const rake = tier.riser / tier.tread
      zones.push(zone(tier.sRange ?? E.sRange, [k === 0 ? 20 : 0, k === E.tiers.length - 1 ? 30 : 0], (s, a) => {
          const lf = alongAt(E.lateralFront, s, E.sRange) - 0.5
          const fh = alongAt(E.frontHeight, s, E.sRange) - 0.6
          const lb = lf + rows * 0.95
          const top = fh + rows * 0.32
          // the hilltop plateau (E temporary stand) sits just above the last row all along: the
          // 58 m ASL figure is +15 over the track at the 逆バンク end but only ≈ +8 at the NIPPO end
          const plateau = top + 1.0
          // the bank in front rises at the deck's own rake, so bank and rows are one plane with no
          // bend at row 1 (a bend there makes the coarse terrain grid overshoot the deck and
          // leaves a metres-tall retaining wall once the grid is clamped back under it)
          const a0 = Math.max(14, lf - fh / rake)
          if (a < a0) return null
          if (a < lf) return under(ramp(a, a0, 0, lf, fh))
          if (a < lb) return under(ramp(a, lf, fh, lb, top))
          if (a < lb + 10) return under(top)
          // the plateau is cut as well: the procedural hills() behind E stands 2–3 m above it
          if (a < lb + 16) return cut(ramp(a, lb + 10, top, lb + 16, plateau))
          if (a < lb + 40) return cut(plateau)
          if (a < lb + 70) return [plateau, 1 - (a - lb - 40) / 30, true]
          return null
      }))
    })
  }
  // main grandstand: the level fill platform behind V1 (GP Square) is ≈ 7.3 m above the track
  // (no fade along s: the A1 temporary stand starts 5 m past its end at track level)
  zones.push(zone([5560, 70], [0, 0], (_s, a) => {
      if (a < 30) return null
      if (a < 38) return fill(ramp(a, 30, 0, 38, 7.3))
      if (a < 110) return fill(7.3)
      if (a < 140) return fill(7.3, 1 - (a - 110) / 30)
      return null
  }))
  return zones
}

const zoneCache = new WeakMap<Track, ReliefZone[]>()

function zoneSamples(z: ReliefZone, track: Track): Int32Array {
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
  if (!zones) zoneCache.set(track, (zones = reliefZones(track.length)))
  let out: Relief | null = null
  let outRank = 2, outD2 = Infinity
  for (const zone of zones) {
    const samples = zoneSamples(zone, track)
    const box = zone.box!
    if (x < box[0] || x > box[1] || z < box[2] || z > box[3]) continue
    // the sample the point is abreast of (|along| ≤ one sample spacing), nearest first. Plain
    // nearest-sample fails here twice over: on the inside of the 逆バンク→Dunlop bend a point
    // behind E-2's rows is nearer to E-2's last samples than to its own, and a point beyond
    // either end of the stretch projects onto an end sample's normal with a meaningless lateral
    // (the run-off in front of E-2 read as "100 m behind E-1")
    let best = Infinity, bi = -1
    for (let k = 0; k < samples.length; k++) {
      const i = samples[k]!
      const dx = x - track.px[i]!, dz = z - track.pz[i]!
      const d2 = dx * dx + dz * dz
      if (d2 >= best) continue
      if (Math.abs(dx * track.tx[i]! + dz * track.tz[i]!) > track.ds) continue
      best = d2
      bi = i
    }
    if (bi < 0) continue
    const dx = x - track.px[bi]!, dz = z - track.pz[bi]!
    // all relief zones lie on the left of their road
    const lateral = dx * track.nx[bi]! + dz * track.nz[bi]!
    if (lateral <= 0) continue
    const sBi = bi * track.ds
    const r = zone.profile(sBi, lateral)
    if (!r) continue
    // fade the claim out past the stand's own ends
    const L = track.length
    const coreLen = forwardDelta(zone.core[0], zone.core[1], L)
    let w = r[1]
    if (forwardDelta(zone.core[0], sBi, L) > coreLen) {
      const before = forwardDelta(sBi, zone.core[0], L), after = forwardDelta(zone.core[1], sBi, L)
      const t = before < after ? before / Math.max(1e-6, zone.fade[0]) : after / Math.max(1e-6, zone.fade[1])
      if (t >= 1) continue
      w *= 1 - t * t * (3 - 2 * t)
    }
    const rank = r[3] ?? 1
    if (out && (rank > outRank || (rank === outRank && best >= outD2))) continue
    out = [track.py[bi]! + r[0], w, r[2]]
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
