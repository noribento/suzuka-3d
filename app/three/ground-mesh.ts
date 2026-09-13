import * as THREE from 'three'
import { type Side } from '~/data/suzuka-facilities-spec'
import { FRESH_ASPHALT, HELIPADS } from '~/data/suzuka-facilities-spec'
import { CIRCUIT } from '~/data/suzuka'
import { forwardDelta, signedDelta, type Track } from '~/sim/track'
import { ASPHALT_TILE_M, ASPHALT_WIDTH_M } from './textures'
import {
  DECK_SHOULDER, PRECEDENCE, ROAD_FRACTIONS, RULE_OF, STRIP_DROP, inRing, inWorldRing, kerbAt, kerbProfileHeight, ownerBeats,
  type Column, type GroundPlan, type Owner, type OwnerKind, type Pt, type RingOwner,
} from './ground-plan'
import { osmWay } from './trackside'

/** longest edge of a world-polygon triangle (m): fine enough to drape, coarse enough for the clamp */
const WORLD_STEP = 4
/**
 * a triangle thinner than this (below the pool's 1 mm quantisation) draws nothing. Wider slivers
 * are kept: earcut fans a straight, densely sampled contour (a 0.1 m arc along a straight OSM
 * edge) into ladders of 2 m × 4 mm ears, and dropping them left 7 cm bands of bare ground inside
 * the T1 pond. Vertex normals are area-weighted over every face, so a sliver's own tilt is nothing.
 */
const MIN_WIDTH = 0.0001

/**
 * The ground MESH: the plan's partition turned into faces.
 *
 * Every raster cell (a trapezoid between two consecutive columns of a row) gets exactly one owner,
 * its four corners are pool vertices shared with every neighbouring cell of every kind, and each
 * vertex has exactly one height — the rule of the highest-precedence owner that touches it, which
 * is why cells are emitted in PRECEDENCE order. Nothing here decides what is visible by height;
 * the plan decided who owns the point, and a shared vertex cannot z-fight or crack.
 *
 * Frames (plan rule R6): road-frame owners ride `track.pointAt(s, lateral).y` (+ dy or the kerb
 * profile); field owners ride `field.yAt(s, lateral)`. The two meet only at shared vertices, where
 * the road frame wins by precedence and the field's first cell ramps to it.
 */

/** the one continuous height source for field-frame owners (ground-field.ts) */
export interface HeightField {
  /** height at (s, lateral) on that stretch of road */
  yAt(s: number, lateral: number): number
  /** height at world (x, z), projected onto the road within `window` when given */
  y(x: number, z: number, window?: [number, number]): number
  /** `y(x, z)` for a caller that already holds the point's crossover-aware projection (`plan.project(x, z)`): the same number, one projection fewer */
  yProjected?(x: number, z: number, p: { s: number; lateral: number }): number
}

export type GroundMaterials = Partial<Record<OwnerKind, THREE.Material>>

declare const FACE_BRAND: unique symbol

/**
 * One drawn ground face: the mesh of one owner kind. Only `buildGroundMeshes` can mint one (the
 * brand is a module-private WeakSet, checked by `isGroundFace`), and `Terrain.addGroundFace`
 * accepts nothing else — so the only way to put an opaque surface on the ground is through the
 * plan (rule R1). Decals and objects are not faces and are never registered.
 */
export interface GroundFace {
  readonly [FACE_BRAND]: true
  kind: OwnerKind
  frame: 'road' | 'field'
  geo: THREE.BufferGeometry
  mesh: THREE.Mesh
  tris: number
}
const minted = new WeakSet<object>()
export function isGroundFace(o: unknown): o is GroundFace {
  return typeof o === 'object' && o !== null && minted.has(o)
}

/**
 * One cell of a decal's outline: a convex quad in XZ. The decal is the drawn ground's own triangles
 * under it, clipped to it and lifted (`BuiltGround.decal`), so it is coplanar with whatever facets
 * the ground has there and can never chord under them (plan rule R9).
 */
export interface DecalQuad {
  /** the four corners (x0, z0, …, x3, z3), either winding, convex */
  xz: number[]
  /** the height the decal expects here: the face within DECAL_LAYER of it is the one it lies on (the crossover stacks two roads) */
  yHint: number
  /** the caller's per-vertex attributes at world (x, z), laid out as the `layout` given to `decal` */
  attrs: (x: number, z: number) => number[]
}
export interface DecalStats {
  quads: number
  triangles: number
  /** m² of the outline */
  area: number
  /** m² of the outline with no drawn face under it — a decal on bare terrain has nothing to lie on */
  uncovered: number
  /** where the bare outline is: the centres (x, z) and m² of the worst quads (up to 60) */
  bareAt: [number, number, number][]
}
/** metres a face may be from a quad's yHint and still be the one the decal lies on (the deck is 6 m over the lower road) */
export const DECAL_LAYER = 2.5

export interface BuiltGround {
  group: THREE.Group
  faces: GroundFace[]
  /** the top drawn face at world (x, z), its kind and its source (0 raster, 1 world part, 2 stitch); null where no face is drawn */
  yAt: (x: number, z: number) => { y: number; kind: OwnerKind; src: number } | null
  /**
   * A decal on the drawn ground: the faces' triangles under each quad, clipped to it and lifted
   * `rung` (a number, or by the face's kind), with the faces' own normals, as one non-indexed
   * geometry carrying `position`, `normal` and the caller's `layout` attributes; null when no
   * face lies under any quad.
   */
  decal: (quads: readonly DecalQuad[], rung: number | ((kind: OwnerKind) => number), layout: readonly { name: string; size: number }[]) => { geo: THREE.BufferGeometry | null; stats: DecalStats }
  stats: {
    vertices: number; triangles: number; cells: number; dropped: number; byKind: Record<string, number>; worldTris: number; stitchTris: number; buildMs: number
    /** wall-clock ms per stage: cells, raster, stitch, boundary, world, normals, geometry */
    timing: Record<string, number>
    /** build-time failures (an untriangulable world part): each is also a console.error */
    errors: string[]
    /** ring arcs the tracing could not close (a console.warn each; the census measures what stays bare) */
    uncoveredArcs: number
    /** the stitch strips: station ranges of the two runs each one zips */
    strips: { sideA: Side; aFrom: number; aTo: number; sideB: Side; bFrom: number; bTo: number }[]
    /** loops of the covered-ground boundary (vertex counts) and the vertices skipped for an odd degree */
    boundary: { loops: number[]; skipped: number }
  }
}

/** metres one uv unit spans, per world-planar kind (ground-materials.ts states its periods in these units) */
export const PLANAR_UV: Partial<Record<OwnerKind, [number, number]>> = {
  grass: [9, 9],
  gravelBand: [3, 3],
  gravelArea: [3, 3],
  grassArea: [9, 9],
  turf: [2, 2],
  asphaltArea: [13, 20],
  lane: [13, 20],
  paddock: [40, 40],
  water: [20, 20],
}

const _p = new THREE.Vector3()
/** a stitch strip is extended over declared-capped stations only while its rails stay this close (m) */
const MAX_STRIP_WIDTH = 15

/**
 * The pool's map keys are integers (a string key cost more than the lookup it served, and the
 * 1 mm search below makes nine of them per vertex): the station key packs the station index and
 * the lateral at 5 mm (|lateral| < 2,621 m), the XZ key the millimetre cell (|x|, |z| < 8,388 m —
 * the far field's DEM extent is ±3.3 km); both stay under 2^53.
 */
const POOL_LAT_SPAN = 1048576
const POOL_XZ_SPAN = 16777216
/** an undirected edge of pool vertices as one integer key (pool indices stay under 2^26) */
const EDGE_SPAN = 67108864
const edgeKey = (u: number, v: number): number => (u < v ? u * EDGE_SPAN + v : v * EDGE_SPAN + u)

/** vertex pool: one entry per (station, lateral), written once by the first (highest) owner */
class Pool {
  x: number[] = []
  y: number[] = []
  z: number[] = []
  s: number[] = []
  lat: number[] = []
  private keys = new Map<number, number>()
  /** every vertex by its world XZ (1 mm): a world vertex landing on a station vertex reuses it */
  private xz = new Map<number, number>()
  /** 5 mm: two columns within COLUMN_TIE of each other are one vertex, not a sliver cell */
  key(i: number, lateral: number): number {
    return i * POOL_LAT_SPAN + (Math.round(lateral * 200) + POOL_LAT_SPAN / 2)
  }
  /** 1 mm: a refinement midpoint 4 mm from a 0.1 m contour vertex must NOT be folded onto it */
  private xzKey(x: number, z: number): number {
    return (Math.round(x * 1e3) + POOL_XZ_SPAN / 2) * POOL_XZ_SPAN + (Math.round(z * 1e3) + POOL_XZ_SPAN / 2)
  }
  /**
   * The vertex within 1 mm of world (x, z), if any: the exact key first, then the eight cells
   * around it — a world-part vertex and the station vertex it lands on can straddle a rounding
   * boundary of the 1 mm grid (0.04 mm apart, keys one cell apart), and two vertices there
   * are a crack the seam guard (G9) sees at 0.1 mm (I5-a, the service road behind the C stand).
   * The cells are visited in one fixed order (dx, then dz) and the first vertex within 1 mm wins.
   */
  private nearXZ(x: number, z: number): number | undefined {
    const kx = Math.round(x * 1e3) + POOL_XZ_SPAN / 2, kz = Math.round(z * 1e3) + POOL_XZ_SPAN / 2
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const idx = this.xz.get((kx + dx) * POOL_XZ_SPAN + (kz + dz))
      if (idx !== undefined && Math.hypot(this.x[idx]! - x, this.z[idx]! - z) <= 1e-3) return idx
    }
    return undefined
  }
  /** a vertex that is not on a station: keyed on its world position */
  addWorld(x: number, y: number, z: number, s: number, lateral: number): number {
    let idx = this.nearXZ(x, z)
    if (idx !== undefined) return idx
    idx = this.x.length
    this.xz.set(this.xzKey(x, z), idx)
    this.x.push(x); this.y.push(y); this.z.push(z); this.s.push(s); this.lat.push(lateral)
    return idx
  }
  get(i: number, lateral: number): number | undefined {
    return this.keys.get(this.key(i, lateral))
  }
  add(i: number, lateral: number, x: number, y: number, z: number, s: number): number {
    const k = this.key(i, lateral)
    let idx = this.keys.get(k)
    if (idx !== undefined) return idx
    idx = this.nearXZ(x, z)
    if (idx !== undefined) { this.keys.set(k, idx); return idx }
    idx = this.x.length
    this.keys.set(k, idx)
    this.xz.set(this.xzKey(x, z), idx)
    this.x.push(x); this.y.push(y); this.z.push(z); this.s.push(s); this.lat.push(lateral)
    return idx
  }
}

interface Cell {
  owner: Owner
  side: Side
  /** station indices */
  i: number
  j: number
  /** laterals of the four corners: (i, lo), (i, hi), (j, lo), (j, hi) — lo < hi */
  lat: [number, number, number, number]
  /** the plan columns the cell's inner / outer edges lie on (for the kerb profile), null for the road */
  cols: [Column, Column] | null
}

export function buildGroundMeshes(plan: GroundPlan, field: HeightField, materials: GroundMaterials): BuiltGround {
  const t0 = performance.now()
  /** wall-clock per stage (diagnostics: `stats.timing`) */
  const timing: Record<string, number> = {}
  let tLast = t0
  const lap = (name: string) => { const now = performance.now(); timing[name] = Math.round((timing[name] ?? 0) + now - tLast); tLast = now }
  const track = plan.track
  const L = track.length
  const m = plan.stations.length
  const pool = new Pool()
  const cells: Cell[] = []
  const errors: string[] = []
  const fail = (msg: string) => { errors.push(msg); console.error(`[ground-mesh] ${msg}`) }
  /** arcs of a ring the mesh could not close (they span two stretches of road): the census measures what they leave bare */
  let uncoveredArcs = 0
  const uncovered = (msg: string) => { uncoveredArcs++; console.warn(`[ground-mesh] ${msg}`) }

  // --- collect the cells --------------------------------------------------------------------------
  // the racing surface: ROAD_FRACTIONS columns across, one owner
  const road = plan.ownerAtSL(0, 1, -1)
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m
    const hi = plan.hw[i]!, hj = plan.hw[j]!
    for (let k = 1; k < ROAD_FRACTIONS.length; k++) {
      const fa = ROAD_FRACTIONS[k - 1]!, fb = ROAD_FRACTIONS[k]!
      // lateral runs +hw (left) → −hw (right) as the fraction runs 0 → 1
      const lo0 = hi * (1 - 2 * fb), hi0 = hi * (1 - 2 * fa)
      const lo1 = hj * (1 - 2 * fb), hi1 = hj * (1 - 2 * fa)
      cells.push({ owner: road, side: 1, i, j, lat: [lo0, hi0, lo1, hi1], cols: null })
    }
  }
  // the two side rasters
  for (const side of [1, -1] as const) {
    const ps = plan.sides[side]
    const cols = ps.columns
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m
      const order = ps.order[i]!
      const si = plan.stations[i]!, sj = plan.stations[j]! + (j === 0 ? L : 0)
      const hi = plan.hw[i]!, hj = plan.hw[j]!
      for (let k = 1; k < order.length; k++) {
        const a = cols[order[k - 1]!]!, b = cols[order[k]!]!
        const w0 = b.off[i]! - a.off[i]!, w1 = b.off[j]! - a.off[j]!
        if (w0 <= 1e-4 && w1 <= 1e-4) continue
        const sm = (si + sj) / 2
        const om = (a.off[i]! + a.off[j]! + b.off[i]! + b.off[j]!) / 4
        const owner = plan.ownerAtSL(track.wrap(sm), side, om, true)
        // laterals: side +1 → lateral grows with off; side −1 → shrinks
        const la0 = side * (hi + a.off[i]!), lb0 = side * (hi + b.off[i]!)
        const la1 = side * (hj + a.off[j]!), lb1 = side * (hj + b.off[j]!)
        const lat: [number, number, number, number] = side > 0 ? [la0, lb0, la1, lb1] : [lb0, la0, lb1, la1]
        cells.push({ owner, side, i, j, lat, cols: [a, b] })
      }
    }
  }

  lap('cells')
  // --- vertices, highest owner first ---------------------------------------------------------------
  cells.sort((c, d) => (ownerBeats(c.owner, d.owner) ? -1 : ownerBeats(d.owner, c.owner) ? 1 : 0))
  const heightOf = (cell: Cell, stationIdx: number, lateral: number, col: Column | null): number => {
    const s = plan.stations[stationIdx]!
    const rule = RULE_OF[cell.owner.kind]
    if (rule.frame === 'field') return field.yAt(s, lateral)
    track.pointAt(s, lateral, _p, 0)
    if ('profile' in rule) {
      // the kerb: the profile at this vertex's own offset (its columns are the breakpoints)
      const kb = kerbAt(plan.kerbs, track, s, cell.side)
      return _p.y + kerbProfileHeight(kb.width, kb.taper, kb.spread, Math.abs(lateral) - track.halfWidthAt(s))
    }
    return _p.y + rule.dy
  }
  const vertexOf = (cell: Cell, stationIdx: number, lateral: number, col: Column | null): number => {
    const have = pool.get(stationIdx, lateral)
    if (have !== undefined) return have
    const s = plan.stations[stationIdx]!
    const y = heightOf(cell, stationIdx, lateral, col)
    track.pointAt(s, lateral, _p, 0)
    return pool.add(stationIdx, lateral, _p.x, y, _p.z, s)
  }
  const triByKind = new Map<OwnerKind, number[]>()
  /** per kind, per triangle: 0 raster cell, 1 world part, 2 stitch strip (diagnostics) */
  const srcByKind = new Map<OwnerKind, number[]>()
  let dropped = 0
  const area2 = (a: number, b: number, c: number): number => (pool.x[b]! - pool.x[a]!) * (pool.z[c]! - pool.z[a]!) - (pool.z[b]! - pool.z[a]!) * (pool.x[c]! - pool.x[a]!)
  const tri = (kind: OwnerKind, a: number, b: number, c: number, src = 0) => {
    if (a === b || b === c || a === c) return
    // counter-clockwise seen from +Y: in (x, z) that is a NEGATIVE signed area
    const ar = area2(a, b, c)
    if (Math.abs(ar) < 2e-5) { dropped++; return }
    let arr = triByKind.get(kind)
    if (!arr) { arr = []; triByKind.set(kind, arr); srcByKind.set(kind, []) }
    if (ar < 0) arr.push(a, b, c)
    else arr.push(a, c, b)
    srcByKind.get(kind)!.push(src)
  }
  for (const cell of cells) {
    const [lo0, hi0, lo1, hi1] = cell.lat
    // which plan column each corner lies on (inner = smaller off): only the kerb cares
    const inner = cell.cols ? cell.cols[0] : null, outer = cell.cols ? cell.cols[1] : null
    const colLo = cell.side > 0 ? inner : outer, colHi = cell.side > 0 ? outer : inner
    const p00 = vertexOf(cell, cell.i, lo0, colLo), p01 = vertexOf(cell, cell.i, hi0, colHi)
    const p10 = vertexOf(cell, cell.j, lo1, colLo), p11 = vertexOf(cell, cell.j, hi1, colHi)
    tri(cell.owner.kind, p00, p10, p01)
    tri(cell.owner.kind, p01, p10, p11)
  }

  /**
   * Refine a set of pool triangles in place: split every edge longer than `maxEdge` (never a
   * `fixed` edge — one shared with a raster cell), then, while a triangle's centroid sits more
   * than DEVIATION off the field (a basin bank, a platform ramp) or its owner is not the same at
   * its three corners (a lane edge crossing a strip), split it again down to MIN_EDGE. Midpoints
   * are pool vertices on the field, one per edge, so neighbours agree. Returns the triangles with
   * their owner re-read at the centroid.
   */
  const DEVIATION = 0.04
  const MIN_EDGE = 1
  const OWNER_EDGE = 0.5
  /** the field at a world point: on the projection the caller holds when the field offers it (the same number, one projection fewer) */
  const fieldY = (x: number, z: number, pr: { s: number; lateral: number }): number => (field.yProjected ? field.yProjected(x, z, pr) : field.y(x, z))
  const refine = <T extends { p: number; q: number; r: number; kind: OwnerKind }>(tris: T[], maxEdge: number, fixed: Set<number>, yOf: (x: number, z: number) => number, ownerAt: ((x: number, z: number) => Owner) | null, make: (p: number, q: number, r: number, kind: OwnerKind) => T): T[] => {
    const mid = new Map<number, number>()
    const midpoint = (u: number, v: number): number => {
      const key = edgeKey(u, v)
      let k = mid.get(key)
      if (k === undefined) {
        const x = (pool.x[u]! + pool.x[v]!) / 2, z = (pool.z[u]! + pool.z[v]!) / 2
        const pr = plan.project(x, z)
        // `yOf` is the field at (x, z) — the same projection again; read it on the one we have
        k = pool.addWorld(x, fieldY(x, z, pr), z, pr.s, pr.lateral)
        mid.set(key, k)
      }
      return k
    }
    const len = (u: number, v: number) => Math.hypot(pool.x[u]! - pool.x[v]!, pool.z[u]! - pool.z[v]!)
    const splitAll = (work: T[], want: (tr: T) => number): { out: T[]; split: boolean } => {
      const out: T[] = []
      let split = false
      for (const z of work) {
        const { p: a0, q: b0, r: c0, kind } = z
        const limit = want(z)
        const can = (u: number, v: number) => !fixed.has(edgeKey(u, v)) && len(u, v) > limit
        const ab = can(a0, b0), bc = can(b0, c0), ca = can(c0, a0)
        if (!ab && !bc && !ca) { out.push(z); continue }
        split = true
        const T = (p: number, q: number, r: number) => out.push(make(p, q, r, kind))
        if (ab && bc && ca) { const p = midpoint(a0, b0), q = midpoint(b0, c0), r = midpoint(c0, a0); T(a0, p, r); T(p, b0, q); T(r, q, c0); T(p, q, r) }
        else if (ab && bc) { const p = midpoint(a0, b0), q = midpoint(b0, c0); T(a0, p, q); T(p, b0, q); T(a0, q, c0) }
        else if (bc && ca) { const q = midpoint(b0, c0), r = midpoint(c0, a0); T(b0, q, r); T(q, c0, r); T(a0, b0, r) }
        else if (ca && ab) { const r = midpoint(c0, a0), p = midpoint(a0, b0); T(a0, p, r); T(p, b0, r); T(b0, c0, r) }
        else if (ab) { const p = midpoint(a0, b0); T(a0, p, c0); T(p, b0, c0) }
        else if (bc) { const q = midpoint(b0, c0); T(a0, b0, q); T(a0, q, c0) }
        else { const r = midpoint(c0, a0); T(a0, b0, r); T(b0, c0, r) }
      }
      return { out, split }
    }
    let work = tris
    for (let pass = 0; pass < 6; pass++) { const r = splitAll(work, () => maxEdge); work = r.out; if (!r.split) break }
    // the centroid's deviation from the field, and the owners at the corners vs the centroid.
    // Memoised per triangle: a triangle the last pass left alone keeps its verdict (the field
    // read costs 35 µs, the owner read 10 µs, and a strip has 30k triangles). The owner test only
    // runs for triangles a ring's box touches; beyond every ring the owner cannot change.
    const verdict = new WeakMap<object, number>()
    const nearRing = (x0: number, x1: number, z0: number, z1: number) => plan.rings.some((r) => { const b = r.ring.box; return !(x1 < b[0] || x0 > b[1] || z1 < b[2] || z0 > b[3]) })
    const needs = (z: T): number => {
      const have = verdict.get(z)
      if (have !== undefined) return have
      let v = Infinity
      const cx = (pool.x[z.p]! + pool.x[z.q]! + pool.x[z.r]!) / 3, cz = (pool.z[z.p]! + pool.z[z.q]! + pool.z[z.r]!) / 3
      const cy = (pool.y[z.p]! + pool.y[z.q]! + pool.y[z.r]!) / 3
      if (Math.abs(cy - yOf(cx, cz)) > DEVIATION) v = MIN_EDGE
      else if (ownerAt) {
        const xs = [pool.x[z.p]!, pool.x[z.q]!, pool.x[z.r]!], zs = [pool.z[z.p]!, pool.z[z.q]!, pool.z[z.r]!]
        if (nearRing(Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs))) {
          const o = ownerAt(cx, cz).name
          // a triangle across a ring's edge is split to OWNER_EDGE, half the field's MIN_EDGE:
          // its owner is read at the centroid, and the census (0.5 m) must not see the other side
          if (ownerAt(xs[0]!, zs[0]!).name !== o || ownerAt(xs[1]!, zs[1]!).name !== o || ownerAt(xs[2]!, zs[2]!).name !== o) v = OWNER_EDGE
        }
      }
      verdict.set(z, v)
      return v
    }
    for (let pass = 0; pass < 3; pass++) { const r = splitAll(work, needs); work = r.out; if (!r.split) break }
    /*
     * CONFORM: the per-triangle passes split an edge on one side only, and a midpoint vertex
     * hanging on a neighbour's unsplit edge is a T-junction — the vertex sits on the field, the
     * neighbour's edge chords it, and the two differ by the very deviation the split was for
     * (19-37 mm cracks on a basin bank). Every triangle with a midpoint on one of its edges is
     * bisected at it, until no edge carries an unused midpoint. Fixed edges never have one.
     */
    for (let pass = 0; pass < 12; pass++) {
      const out: T[] = []
      let split = false
      for (const z of work) {
        const { p: a0, q: b0, r: c0, kind } = z
        const mab = mid.get(edgeKey(a0, b0)), mbc = mid.get(edgeKey(b0, c0)), mca = mid.get(edgeKey(c0, a0))
        if (mab === undefined && mbc === undefined && mca === undefined) { out.push(z); continue }
        split = true
        if (mab !== undefined) { out.push(make(a0, mab, c0, kind)); out.push(make(mab, b0, c0, kind)) }
        else if (mbc !== undefined) { out.push(make(a0, b0, mbc, kind)); out.push(make(a0, mbc, c0, kind)) }
        else { out.push(make(a0, b0, mca!, kind)); out.push(make(mca!, b0, c0, kind)) }
      }
      work = out
      if (!split) break
    }
    if (ownerAt) for (const z of work) { const cx = (pool.x[z.p]! + pool.x[z.q]! + pool.x[z.r]!) / 3, cz = (pool.z[z.p]! + pool.z[z.q]! + pool.z[z.r]!) / 3; z.kind = ownerAt(cx, cz).kind }
    return work
  }

  lap('raster')
  // --- stitch strips across the bisectors ----------------------------------------------------------
  // Two facing stretches both stop BISECTOR_MARGIN short of their bisector; the strip between
  // their extent polylines is zipped (a two-polyline triangulation, no earcut, no refinement) so
  // every strip vertex is a pool vertex of one raster or the other. Where one of the two is
  // capped short of the mutual bisector by a third road, the zip spans the pocket as well. Runs
  // are paired once: each bisector-capped run finds the run on the facing side that its partner
  // samples fall in, and the mutual stretch of the two — a contiguous station range on each — is
  // zipped. The strips are built BEFORE the world parts: together with the rasters they are the
  // covered ground, and a ring's world part is what the ring covers beyond both.
  let stitchTris = 0
  /** every stitch triangle (pool indices), for the covered-ground test */
  const stitchTriList: number[] = []
  /**
   * The index into `list` (pool vertices) of the vertex nearest to (x, z) — the lowest index at
   * the minimum distance, as a linear scan with a strict `<` finds it. A grid of RAIL_CELL m
   * cells is walked in rings around the point's cell; a vertex in ring R lies at least
   * (R − 1) × RAIL_CELL away, so once the best distance is under that bound no further ring can
   * hold a vertex at the minimum, and among the visited ones the (distance, index) order picks
   * the same vertex whatever the visiting order.
   */
  const RAIL_CELL = 16
  const railNearest = (list: number[]): ((x: number, z: number) => number) => {
    if (!list.length) return () => 0
    let x0 = Infinity, z0 = Infinity
    for (const v of list) { if (pool.x[v]! < x0) x0 = pool.x[v]!; if (pool.z[v]! < z0) z0 = pool.z[v]! }
    const cells = new Map<number, number[]>()
    const keyOf = (ix: number, iz: number) => (ix + 32768) * 65536 + (iz + 32768)
    let ix1 = 0, iz1 = 0
    for (let k = 0; k < list.length; k++) {
      const v = list[k]!
      const ix = Math.floor((pool.x[v]! - x0) / RAIL_CELL), iz = Math.floor((pool.z[v]! - z0) / RAIL_CELL)
      if (ix > ix1) ix1 = ix
      if (iz > iz1) iz1 = iz
      const key = keyOf(ix, iz)
      let arr = cells.get(key)
      if (!arr) { arr = []; cells.set(key, arr) }
      arr.push(k)
    }
    return (x: number, z: number): number => {
      const cx = Math.floor((x - x0) / RAIL_CELL), cz = Math.floor((z - z0) / RAIL_CELL)
      let best = -1, bd = Infinity
      const visitCell = (ix: number, iz: number) => {
        if (ix < 0 || iz < 0 || ix > ix1 || iz > iz1) return
        const arr = cells.get(keyOf(ix, iz))
        if (!arr) return
        for (const k of arr) {
          const v = list[k]!
          const dd = Math.hypot(pool.x[v]! - x, pool.z[v]! - z)
          if (dd < bd || (dd === bd && k < best)) { bd = dd; best = k }
        }
      }
      const maxR = Math.max(cx, ix1 - cx, cz, iz1 - cz) + 1
      for (let R = 0; R <= maxR; R++) {
        // every vertex not yet visited is at least (R − 1) cells away: nothing left can tie
        if (best >= 0 && (R - 1) * RAIL_CELL > bd * (1 + 1e-9) + 1e-9) break
        if (R === 0) { visitCell(cx, cz); continue }
        for (let ix = cx - R; ix <= cx + R; ix++) { visitCell(ix, cz - R); visitCell(ix, cz + R) }
        for (let iz = cz - R + 1; iz <= cz + R - 1; iz++) { visitCell(cx - R, iz); visitCell(cx + R, iz) }
      }
      return best < 0 ? 0 : best
    }
  }
  interface Strip { sideA: Side; a: number[]; aSt: number[]; sideB: Side; b: number[]; bSt: number[]; ends: [number[], number[]] }
  const strips: Strip[] = []
  const extentVertex = (i: number, side: Side): number | undefined => pool.get(i, side * (plan.hw[i]! + plan.sides[side].W[i]!))
  {
    interface Run { side: Side; start: number; end: number; id: number }
    /** the facing station of station k on `side` (its bisector partner), or null */
    const facing = (side: Side, k: number): { side: Side; station: number } | null => {
      const j = plan.bisectorPartner(plan.stations[k]!, side)
      if (j < 0) return null
      const ki = Math.round(plan.stations[k]! / track.ds) % track.n
      const pSide: Side = (track.px[ki]! - track.px[j]!) * track.nx[j]! + (track.pz[ki]! - track.pz[j]!) * track.nz[j]! > 0 ? 1 : -1
      return { side: pSide, station: plan.stationIndexAt(j * track.ds) }
    }
    const runs: Run[] = []
    /**
     * A run: stations whose raster is capped by a facing stretch, and stations at their declared
     * verge whose edge still lies within a strip's width of the facing stretch's edge (the other
     * side was capped at THIS edge — the meet-at-the-edge cap of ground-plan — and the strip
     * between the two is needed all the same).
     */
    const d = (p: number, q: number) => Math.hypot(pool.x[p]! - pool.x[q]!, pool.z[p]! - pool.z[q]!)
    const zippable = (side: Side, k: number): boolean => {
      const c = plan.sides[side].cap[k]
      const p = facing(side, k)
      if (!p) return false
      if (c === 2 || c === 3) return true
      const v = extentVertex(k, side), w = extentVertex(p.station, p.side)
      return v !== undefined && w !== undefined && d(v, w) <= MAX_STRIP_WIDTH
    }
    for (const side of [1, -1] as const) {
      let i = 0
      while (i < m) {
        if (!zippable(side, i)) { i++; continue }
        let e = i
        while (e + 1 < m && zippable(side, e + 1)) e++
        if (e - i >= 2) runs.push({ side, start: i, end: e, id: runs.length })
        i = e + 1
      }
    }
    const runAt = (side: Side, k: number) => runs.find((r) => r.side === side && k >= r.start && k <= r.end)
    /** the run a station's partner sample falls in, and the partner's own station */
    const partnerOf = (side: Side, k: number): { run: Run; station: number } | null => {
      const p = facing(side, k)
      if (!p) return null
      const run = runAt(p.side, p.station)
      return run ? { run, station: p.station } : null
    }
    const paired = new Set<string>()
    /**
     * The contiguous station ranges of two facing runs that zip to each other, as extent
     * vertices. Each starts as the stations of one run whose bisector partner lies in the other,
     * then both are extended, alternately, over the declared-capped stations beyond the run that
     * face the other's range: where a ring's reach ramps a raster down short of its bisector (the
     * paddock's end beside NIPPO) the facing raster still stops at the bisector, and the strip
     * must span the pocket between the two — on both sides of it, or the zip fans everything to
     * one end vertex and leaves the pocket open. Fold- and bridge-capped stations are never
     * extended over.
     */
    /** stations a strip already zips, per side: an extension never covers one twice */
    const zipped = { 1: new Uint8Array(m), '-1': new Uint8Array(m) }
    const mutualPair = (A: Run, B: Run): { a: number[]; aSt: number[]; b: number[]; bSt: number[] } | null => {
      const basic = (run: Run, other: Run): [number, number] => {
        let lo = Infinity, hi = -Infinity
        for (let k = run.start; k <= run.end; k++) { const p = partnerOf(run.side, k); if (p && p.run.id === other.id) { if (k < lo) lo = k; if (k > hi) hi = k } }
        return [lo, hi]
      }
      let [aLo, aHi] = basic(A, B)
      let [bLo, bHi] = basic(B, A)
      if (aLo > aHi || bLo > bHi) return null
      const soft = (side: Side, k: number) => { const c = plan.sides[side].cap[k]; return c === 0 || c === 4 }
      const facesRange = (side: Side, k: number, oSide: Side, lo: number, hi: number) => { const p = facing(side, k); return !!p && p.side === oSide && p.station >= lo - 5 && p.station <= hi + 5 }
      const free = (side: Side, k: number) => soft(side, k) && !runAt(side, k) && !zipped[side][k]
      /** the station's extent vertex lies within MAX_STRIP_WIDTH of the other range's rail (a pocket is narrow; the crossover's rails are not) */
      const near = (side: Side, k: number, oSide: Side, lo: number, hi: number): boolean => {
        const v = extentVertex(k, side)
        if (v === undefined) return false
        for (let q = lo; q <= hi; q++) { const w = extentVertex(q, oSide); if (w !== undefined && d(v, w) <= MAX_STRIP_WIDTH) return true }
        return false
      }
      const extend = (run: Run, lo: number, hi: number, other: Run, oLo: number, oHi: number): [number, number] => {
        while (lo > 0 && free(run.side, lo - 1) && facesRange(run.side, lo - 1, other.side, oLo, oHi) && near(run.side, lo - 1, other.side, oLo, oHi)) lo--
        while (hi < m - 1 && free(run.side, hi + 1) && facesRange(run.side, hi + 1, other.side, oLo, oHi) && near(run.side, hi + 1, other.side, oLo, oHi)) hi++
        return [lo, hi]
      }
      for (let it = 0; it < 3; it++) {
        ;[aLo, aHi] = extend(A, aLo, aHi, B, bLo, bHi)
        ;[bLo, bHi] = extend(B, bLo, bHi, A, aLo, aHi)
      }
      const collect = (side: Side, lo: number, hi: number) => { const v: number[] = [], st: number[] = []; for (let k = lo; k <= hi; k++) { zipped[side][k] = 1; const x = extentVertex(k, side); if (x !== undefined) { v.push(x); st.push(k) } } return { v, st } }
      const ma = collect(A.side, aLo, aHi), mb = collect(B.side, bLo, bHi)
      return { a: ma.v, aSt: ma.st, b: mb.v, bSt: mb.st }
    }
    for (const A of runs) {
      const votes = new Map<number, number>()
      for (let k = A.start; k <= A.end; k++) { const p = partnerOf(A.side, k); if (p && p.run.id !== A.id) votes.set(p.run.id, (votes.get(p.run.id) ?? 0) + 1) }
      let bestId = -1, bestN = 0
      for (const [id, n] of votes) if (n > bestN) { bestN = n; bestId = id }
      if (bestId < 0) continue
      const B = runs[bestId]!
      const key = A.id < B.id ? `${A.id}|${B.id}` : `${B.id}|${A.id}`
      if (paired.has(key)) continue
      paired.add(key)
      const mp = mutualPair(A, B)
      if (!mp) continue
      const { a, aSt, b, bSt } = mp
      if (a.length < 2 || b.length < 2) continue
      // align the two polylines end to end: the pairing with the smaller total end distance (a
      // wedge-shaped strip has its mouth ends far apart, so "the end nearest a[0]" picked the apex)
      if (d(a[0]!, b[0]!) + d(a[a.length - 1]!, b[b.length - 1]!) > d(a[0]!, b[b.length - 1]!) + d(a[a.length - 1]!, b[0]!)) { b.reverse(); bSt.reverse() }

      // the outer owners at a run's stations, once per station (pure in k)
      const outerMemoA = new Map<number, Owner>(), outerMemoB = new Map<number, Owner>()
      const outerA = (k: number): Owner => { let o = outerMemoA.get(k); if (!o) { o = plan.ownerAtSL(plan.stations[k]!, A.side, plan.sides[A.side].W[k]! - 0.01, true); outerMemoA.set(k, o) } return o }
      const outerB = (k: number): Owner => { let o = outerMemoB.get(k); if (!o) { o = plan.ownerAtSL(plan.stations[k]!, B.side, plan.sides[B.side].W[k]! - 0.01, true); outerMemoB.set(k, o) } return o }
      let area = 0
      /** the strip's triangles before refinement: [p, q, r, ownerKind] */
      const zipTris: { p: number; q: number; r: number; kind: OwnerKind }[] = []
      /** an edge along one of the two extent polylines is a raster edge and is never split */
      const railEdge = new Set<number>()
      for (let k = 0; k + 1 < a.length; k++) railEdge.add(edgeKey(a[k]!, a[k + 1]!))
      for (let k = 0; k + 1 < b.length; k++) railEdge.add(edgeKey(b[k]!, b[k + 1]!))
      /**
       * The two END edges (a[0]–b[0], a[last]–b[last]) are boundary edges of the covered ground
       * and may span a bank between two rasters; they are split like the cross edges, and the
       * vertices that land on them form the chains the union boundary carries instead of the
       * single edge, so a world part traced along them meets the strip vertex for vertex.
       */
      const endSets: [Set<number>, Set<number>] = [new Set([a[0]!, b[0]!]), new Set([a[a.length - 1]!, b[b.length - 1]!])]
      /** the owner of a strip triangle: the plan's answer at its centroid (a ring the strip runs through), else the higher of the two outer owners the strip joins */
      const ownerOf = (p: number, q: number, r: number, ia: number, ib: number): Owner => {
        const cx = (pool.x[p]! + pool.x[q]! + pool.x[r]!) / 3, cz = (pool.z[p]! + pool.z[q]! + pool.z[r]!) / 3
        const o = plan.ownerAt(cx, cz)
        if (o.kind !== 'terrain') return o
        const oa = outerA(aSt[Math.min(ia, aSt.length - 1)]!), ob = outerB(bSt[Math.min(ib, bSt.length - 1)]!)
        return ownerBeats(oa, ob) ? oa : ob
      }
      /*
       * The strip is zipped greedily (the next triangle takes whichever polyline's next vertex
       * is nearer): between two roughly parallel extents that gives well-shaped triangles and
       * few of them. Where the two polylines bend towards each other (the Casio Triangle's legs
       * converge on its apex) the zip folds — a triangle winds the other way — and the strip
       * polygon a[0..n] + b[m..0] is ear-clipped instead, which cannot overlap but makes slivers.
       */
      const nearest = (v: number, list: number[]) => { let best = 0, bd = Infinity; for (let k = 0; k < list.length; k++) { const dd = d(v, list[k]!); if (dd < bd) { bd = dd; best = k } } return best }
      const signedArea = (p: number, q: number, r: number) => (pool.x[q]! - pool.x[p]!) * (pool.z[r]! - pool.z[p]!) - (pool.z[q]! - pool.z[p]!) * (pool.x[r]! - pool.x[p]!)
      {
        let ia = 0, ib = 0, pos = 0, neg = 0
        while (ia < a.length - 1 || ib < b.length - 1) {
          const advanceA = ib >= b.length - 1 || (ia < a.length - 1 && d(a[ia + 1]!, b[ib]!) < d(a[ia]!, b[ib + 1]!))
          const p = a[ia]!, q = advanceA ? a[ia + 1]! : b[ib + 1]!, r = b[ib]!
          const cross = signedArea(p, q, r)
          if (cross > 1e-6) pos++
          else if (cross < -1e-6) neg++
          area += Math.abs(cross) / 2
          zipTris.push({ p, q, r, kind: ownerOf(p, q, r, ia, ib).kind })
          if (advanceA) ia++
          else ib++
        }
        if (pos && neg) {
          const contour = [...a, ...[...b].reverse()]
          const shape = contour.map((v) => new THREE.Vector2(pool.x[v]!, -pool.z[v]!))
          let ears: number[][] = []
          try { ears = THREE.ShapeUtils.triangulateShape(shape, []) } catch { ears = [] }
          if (ears.length >= contour.length - 2) {
            zipTris.length = 0
            area = 0
            for (const e of ears) {
              const p = contour[e[0]!]!, q = contour[e[1]!]!, r = contour[e[2]!]!
              area += Math.abs(signedArea(p, q, r)) / 2
              zipTris.push({ p, q, r, kind: ownerOf(p, q, r, nearest(p, a), nearest(p, b)).kind })
            }
            console.info(`[ground-mesh] stitch side ${A.side} s ${plan.stations[aSt[0]!]!.toFixed(0)}-${plan.stations[aSt[aSt.length - 1]!]!.toFixed(0)}: the zip folded (${neg} of ${pos + neg} triangles), ear-clipped instead`)
          } else console.warn(`[ground-mesh] stitch side ${A.side} s ${plan.stations[aSt[0]!]!.toFixed(0)}-${plan.stations[aSt[aSt.length - 1]!]!.toFixed(0)}: the zip folded and the strip polygon does not triangulate (${ears.length} ears for ${contour.length} vertices; the two extents cross?)`)
        }
      }
      // refine: a zip triangle that fans across a pocket has cross edges tens of metres long and
      // chords the field; split those (never the rail edges, which the raster cells share) with
      // midpoints on the field, then again where the field or the owner demands it. The owner of
      // a strip triangle beyond every ring is the higher of the two outer owners it joins.
      // the nearest rail vertex of each run: the first index at the minimum distance, found
      // through a grid over the run's vertices (exact: every vertex that could be at the minimum
      // is visited, and ties fall to the lower index as the linear scan's strict `<` did)
      const nearestA = railNearest(a), nearestB = railNearest(b)
      const fallback = (x: number, z: number): Owner => {
        const o = plan.ownerAt(x, z)
        if (o.kind !== 'terrain') return o
        const oa = outerA(aSt[nearestA(x, z)]!), ob = outerB(bSt[nearestB(x, z)]!)
        return ownerBeats(oa, ob) ? oa : ob
      }
      const work = refine(zipTris, WORLD_STEP, railEdge, (x, z) => field.y(x, z), fallback, (p, q, r, kind) => ({ p, q, r, kind }))
      // the end chains: every vertex the refinement put on an end edge (collinear with its ends)
      for (const z of work) for (const v of [z.p, z.q, z.r]) {
        for (const set of endSets) {
          if (set.has(v)) continue
          const [e0, e1] = [...set].slice(0, 2) as [number, number]
          const ex = pool.x[e1]! - pool.x[e0]!, ez = pool.z[e1]! - pool.z[e0]!
          const l2 = ex * ex + ez * ez || 1
          const tt = ((pool.x[v]! - pool.x[e0]!) * ex + (pool.z[v]! - pool.z[e0]!) * ez) / l2
          if (tt <= 0 || tt >= 1) continue
          if (Math.hypot(pool.x[v]! - pool.x[e0]! - ex * tt, pool.z[v]! - pool.z[e0]! - ez * tt) < 0.005) set.add(v)
        }
      }
      for (const z of work) {
        tri(z.kind, z.p, z.q, z.r, 2)
        stitchTriList.push(z.p, z.q, z.r)
        stitchTris++
      }
      // the end chains, ordered from the a-side vertex to the b-side vertex
      const chainOf = (set: Set<number>, from: number) => [...set].sort((u, v) => d(from, u) - d(from, v))
      strips.push({ sideA: A.side, a, aSt, sideB: B.side, b, bSt, ends: [chainOf(endSets[0], a[0]!), chainOf(endSets[1], a[a.length - 1]!)] })
      const len = d(a[0]!, a[a.length - 1]!)
      console.info(`[ground-mesh] stitch side ${A.side} s ${plan.stations[aSt[0]!]!.toFixed(0)}-${plan.stations[aSt[aSt.length - 1]!]!.toFixed(0)} ↔ side ${B.side} s ${plan.stations[Math.min(bSt[0]!, bSt[bSt.length - 1]!)]!.toFixed(0)}-${plan.stations[Math.max(bSt[0]!, bSt[bSt.length - 1]!)]!.toFixed(0)}: ${area.toFixed(0)} m² over ${len.toFixed(0)} m`)
    }
  }

  lap('stitch')
  // --- the covered ground: the rasters and the stitch strips ----------------------------------------
  const inRaster = (x: number, z: number): { inside: boolean; s: number; side: Side; off: number; W: number } => {
    const p = plan.project(x, z)
    const hw = track.halfWidthAt(p.s)
    const side: Side = p.lateral >= 0 ? 1 : -1
    const off = Math.abs(p.lateral) - hw
    // the raster's edge as drawn (the chord between extent vertices), not the ray-linear extent
    const W = plan.extentDrawn(p.s, side)
    // a ring edge that runs ALONG the extent (a paddock band ending exactly at the raster's
    // declared edge) is inside: a hair outside would make the whole edge an "outside arc"
    return { inside: off <= W + 0.05, s: p.s, side, off, W }
  }
  const CELL = 8
  const cellKey = (ix: number, iz: number) => (ix + 32768) * 65536 + (iz + 32768)
  /**
   * Triangles that cover ground besides the raster: the stitch strips, then every world part as
   * it is drawn (higher precedence first), so a ring traces its part around the parts of the
   * rings above it exactly as it does around the raster — the shared boundary is one set of
   * vertices, and no verify-by-centroid sliver is left to overlap (the helipad in the paddock,
   * the slip lane in the chicane apron, the turf island).
   */
  const coverList: number[] = []
  const coverCells = new Map<number, number[]>()
  const addCover = (t: number) => {
    const a = coverList[t]!, b = coverList[t + 1]!, c = coverList[t + 2]!
    const i0 = Math.floor(Math.min(pool.x[a]!, pool.x[b]!, pool.x[c]!) / CELL), i1 = Math.floor(Math.max(pool.x[a]!, pool.x[b]!, pool.x[c]!) / CELL)
    const j0 = Math.floor(Math.min(pool.z[a]!, pool.z[b]!, pool.z[c]!) / CELL), j1 = Math.floor(Math.max(pool.z[a]!, pool.z[b]!, pool.z[c]!) / CELL)
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const k = cellKey(i, j); let arr = coverCells.get(k); if (!arr) { arr = []; coverCells.set(k, arr) } arr.push(t) }
  }
  const coverTriangle = (a: number, b: number, c: number) => { const t = coverList.length; coverList.push(a, b, c); addCover(t) }
  // the raster cells first (their own triangles, so a point is tested against every stretch's
  // raster and not the one it projects onto — the paddock band and the T1–T2 basin lie between
  // two stretches, and a projection onto the wrong one called covered ground bare), then the strips
  for (const arr of triByKind.values()) for (let k = 0; k < arr.length; k += 3) coverTriangle(arr[k]!, arr[k + 1]!, arr[k + 2]!)
  for (let k = 0; k < stitchTriList.length; k += 3) coverTriangle(stitchTriList[k]!, stitchTriList[k + 1]!, stitchTriList[k + 2]!)
  const inStitch = (x: number, z: number): boolean => {
    const arr = coverCells.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL)))
    if (!arr) return false
    for (const t of arr) {
      const a = coverList[t]!, b = coverList[t + 1]!, c = coverList[t + 2]!
      const ax = pool.x[a]!, az = pool.z[a]!, bx = pool.x[b]!, bz = pool.z[b]!, cx = pool.x[c]!, cz = pool.z[c]!
      const dd = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz)
      if (Math.abs(dd) < 1e-12) continue
      const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / dd
      const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / dd
      if (u >= -1e-6 && v >= -1e-6 && 1 - u - v >= -1e-6) return true
    }
    return false
  }
  const covered = (x: number, z: number): boolean => inStitch(x, z)

  // --- the union boundary U: the extent polylines, the stitched parts replaced by the strips' end edges
  // A ring's part beyond the covered ground is bounded by pieces of the ring and pieces of U, so
  // the world parts are traced along U: an oriented graph on the pool's extent vertices, each
  // loop wound with the uncovered ground on its LEFT (the side a probe just left of an edge
  // finds uncovered).
  const uAdj = new Map<number, number[]>()
  const uLink = (p: number, q: number) => {
    if (p === q) return
    let a = uAdj.get(p); if (!a) { a = []; uAdj.set(p, a) } if (!a.includes(q)) a.push(q)
    let b = uAdj.get(q); if (!b) { b = []; uAdj.set(q, b) } if (!b.includes(p)) b.push(p)
  }
  {
    const interior = new Set<string>()
    for (const st of strips) {
      for (let k = 0; k + 1 < st.aSt.length; k++) if (st.aSt[k + 1] === (st.aSt[k]! + 1) % m) interior.add(`${st.sideA}|${st.aSt[k]}`)
      for (let k = 0; k + 1 < st.bSt.length; k++) { const lo = Math.min(st.bSt[k]!, st.bSt[k + 1]!), hi = Math.max(st.bSt[k]!, st.bSt[k + 1]!); if (hi === (lo + 1) % m || (lo === 0 && hi === m - 1)) interior.add(`${st.sideB}|${hi === (lo + 1) % m ? lo : hi}`) }
    }
    for (const side of [1, -1] as const) {
      for (let i = 0; i < m; i++) {
        if (interior.has(`${side}|${i}`)) continue
        const va = extentVertex(i, side), vb = extentVertex((i + 1) % m, side)
        if (va !== undefined && vb !== undefined) uLink(va, vb)
      }
    }
    for (const st of strips) for (const chain of st.ends) for (let k = 0; k + 1 < chain.length; k++) uLink(chain[k]!, chain[k + 1]!)
  }
  /** loops of U as pool indices, oriented with the uncovered ground on the left */
  const uLoops: number[][] = []
  let uBad = 0
  {
    const seen = new Set<number>()
    for (const [v0, nb] of uAdj) {
      if (seen.has(v0) || nb.length !== 2) {
        if (nb.length !== 2) {
          uBad++
          const pr = plan.project(pool.x[v0]!, pool.z[v0]!)
          console.warn(`[ground-mesh] union boundary: vertex at (${pool.x[v0]!.toFixed(1)}, ${pool.z[v0]!.toFixed(1)}) s ${pr.s.toFixed(1)} lat ${pr.lateral.toFixed(1)} has ${nb.length} boundary edges — ${nb.map((q) => { const p = plan.project(pool.x[q]!, pool.z[q]!); return `(${p.s.toFixed(1)}/${p.lateral.toFixed(1)})` }).join(' ')}`)
        }
        continue
      }
      const loop: number[] = [v0]
      seen.add(v0)
      let prev = v0, cur = nb[0]!
      let ok = true
      while (cur !== v0) {
        const nn = uAdj.get(cur)!
        if (nn.length !== 2 || seen.has(cur)) { ok = false; break }
        loop.push(cur)
        seen.add(cur)
        const next = nn[0] === prev ? nn[1]! : nn[0]!
        prev = cur
        cur = next
        if (loop.length > uAdj.size) { ok = false; break }
      }
      if (!ok || loop.length < 3) { uBad++; continue }
      // orientation: every edge longer than 0.5 m votes with a probe 0.2 m to its left and one to
      // its right (an edge whose left is covered and right is not says "reverse"); one probe on
      // one edge could land in a sliver of a zip triangle and flip a whole loop
      let keep = 0, reverse = 0
      const stride = Math.max(1, Math.floor(loop.length / 200))
      for (let k = 0; k < loop.length; k += stride) {
        const p = loop[k]!, q = loop[(k + 1) % loop.length]!
        const l = Math.hypot(pool.x[q]! - pool.x[p]!, pool.z[q]! - pool.z[p]!)
        if (l < 0.5) continue
        const dx = (pool.x[q]! - pool.x[p]!) / l, dz = (pool.z[q]! - pool.z[p]!) / l
        const mx = (pool.x[p]! + pool.x[q]!) / 2, mz = (pool.z[p]! + pool.z[q]!) / 2
        const left = covered(mx + dz * 0.2, mz - dx * 0.2), right = covered(mx - dz * 0.2, mz + dx * 0.2)
        if (left && !right) reverse++
        else if (!left && right) keep++
      }
      if (reverse > keep) loop.reverse()
      else if (reverse === keep) uBad++
      uLoops.push(loop)
    }
    if (uBad) console.warn(`[ground-mesh] union boundary: ${uBad} vertex(es) or loop(s) with a degree other than 2 were skipped`)
  }
  /** U edges by cell, for locating a crossing point on the boundary */
  const uCells = new Map<number, [number, number][]>()
  const indexLoop = (li: number) => {
    const loop = uLoops[li]!
    for (let k = 0; k < loop.length; k++) {
      const p = loop[k]!, q = loop[(k + 1) % loop.length]!
      const i0 = Math.floor(Math.min(pool.x[p]!, pool.x[q]!) / CELL), i1 = Math.floor(Math.max(pool.x[p]!, pool.x[q]!) / CELL)
      const j0 = Math.floor(Math.min(pool.z[p]!, pool.z[q]!) / CELL), j1 = Math.floor(Math.max(pool.z[p]!, pool.z[q]!) / CELL)
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const kk = cellKey(i, j); let arr = uCells.get(kk); if (!arr) { arr = []; uCells.set(kk, arr) } arr.push([li, k]) }
    }
  }
  for (let li = 0; li < uLoops.length; li++) indexLoop(li)
  /**
   * U as a DIRECTED boundary: the successor of every vertex, the uncovered ground on the left.
   * A drawn world part joins the covered ground and its outline is spliced in: the pieces of U it
   * walked are interior now and go, the arcs of the ring it followed become boundary (reversed,
   * covered on their right), and a hole it kept becomes a loop of its own. The loops are re-read
   * from the successors afterwards — no probe vote is needed, the directions are inherited.
   */
  const uNext = new Map<number, number>()
  for (const loop of uLoops) for (let k = 0; k < loop.length; k++) uNext.set(loop[k]!, loop[(k + 1) % loop.length]!)
  const rebuildLoops = () => {
    uLoops.length = 0
    uCells.clear()
    const seen = new Set<number>()
    for (const v0 of uNext.keys()) {
      if (seen.has(v0)) continue
      const loop = [v0]
      seen.add(v0)
      let cur = uNext.get(v0)!
      let ok = true
      while (cur !== v0) {
        if (seen.has(cur) || !uNext.has(cur) || loop.length > uNext.size) { ok = false; break }
        loop.push(cur)
        seen.add(cur)
        cur = uNext.get(cur)!
      }
      if (!ok || loop.length < 3) {
        uBad++
        const pr = plan.project(pool.x[v0]!, pool.z[v0]!)
        console.warn(`[ground-mesh] union boundary: a chain of ${loop.length} vertices from (${pool.x[v0]!.toFixed(0)}, ${pool.z[v0]!.toFixed(0)}) s ${pr.s.toFixed(0)} lat ${pr.lateral.toFixed(0)} does not close after a world part was spliced in — dropped`)
        continue
      }
      uLoops.push(loop)
      indexLoop(uLoops.length - 1)
    }
  }
  /** the U edge nearest to (x, z) and the point's parameter on it; null when none is within 1 m */
  const locateOnU = (x: number, z: number): { loop: number; k: number; t: number; x: number; z: number; y: number } | null => {
    let best: { loop: number; k: number; t: number; x: number; z: number; y: number } | null = null
    let bd = 1
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL)
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const arr = uCells.get(cellKey(cx + di, cz + dj))
      if (!arr) continue
      for (const [li, k] of arr) {
        const loop = uLoops[li]!
        const p = loop[k]!, q = loop[(k + 1) % loop.length]!
        const dx = pool.x[q]! - pool.x[p]!, dz = pool.z[q]! - pool.z[p]!
        const l2 = dx * dx + dz * dz || 1
        const t = Math.max(0, Math.min(1, ((x - pool.x[p]!) * dx + (z - pool.z[p]!) * dz) / l2))
        const px = pool.x[p]! + dx * t, pz = pool.z[p]! + dz * t
        const dd = Math.hypot(x - px, z - pz)
        if (dd < bd) { bd = dd; best = { loop: li, k, t, x: px, z: pz, y: pool.y[p]! + (pool.y[q]! - pool.y[p]!) * t } }
      }
    }
    return best
  }

  lap('boundary')
  // --- world parts: what the rings cover beyond the covered ground ----------------------------------
  let worldTris = 0
  let droppedWorldArea = 0
  /** world parts are tagged 16 + part index in the triangle source (diagnostics) */
  let partId = 0
  const emitPolygon = (owner: Owner, contour: { x: number; z: number; v?: number }[], holes: Pt[][], window?: [number, number], verify?: (x: number, z: number) => boolean): { emitted: number; idx: number[]; holeIdx: number[][] } => {
      const shape = contour.map((p) => new THREE.Vector2(p.x, -p.z))
      const holeShapes = holes.map((h) => h.map((p) => new THREE.Vector2(p.x, -p.z)).reverse())
      let faces: number[][]
      try { faces = THREE.ShapeUtils.triangulateShape(shape, holeShapes) } catch { faces = [] }
      const nothing = { emitted: 0, idx: [], holeIdx: [] }
      if (!faces.length) {
        // a contour of a few points at a crossing is a sliver the raster already covers to within
        // its width; a real part failing is a build error
        let a2 = 0
        for (let i = 0; i < contour.length; i++) { const p = contour[i]!, q = contour[(i + 1) % contour.length]!; a2 += p.x * q.z - q.x * p.z }
        if (Math.abs(a2) / 2 < 2) return nothing
        fail(`"${owner.name}": its world part (${(Math.abs(a2) / 2).toFixed(0)} m²) could not be triangulated`)
        return nothing
      }
      // vertex table: contour first, then the holes (the order triangulateShape indexes them)
      const pts: { x: number; z: number; v?: number }[] = [...contour, ...holes.flatMap((h) => [...h].reverse().map((p) => ({ x: p.x, z: p.z })))]
      let tris = faces.map((f) => [f[0]!, f[1]!, f[2]!] as [number, number, number])
      /*
       * earcut drops a vertex it finds exactly collinear with its neighbours (the pool's 1 mm
       * quantisation makes a straight extent chain exactly collinear) and its triangles then run
       * past it: a vertex the raster shares with the contour hangs on an edge of the part, and
       * the crack is a sub-millimetre slit the census found at the paddock's edge (s 92). Every
       * boundary vertex lying on a triangle's edge splits that triangle there.
       */
      {
        const nb = pts.length
        const CELL = 1
        const key = (cx: number, cz: number) => (cx + 32768) * 65536 + (cz + 32768)
        const cells = new Map<number, number[]>()
        for (let i = 0; i < nb; i++) { const k = key(Math.floor(pts[i]!.x / CELL), Math.floor(pts[i]!.z / CELL)); let a = cells.get(k); if (!a) { a = []; cells.set(k, a) } a.push(i) }
        const onEdge = (a: number, b: number, c: number): number | null => {
          const ax = pts[a]!.x, az = pts[a]!.z, dx = pts[b]!.x - ax, dz = pts[b]!.z - az
          const l2 = dx * dx + dz * dz
          if (l2 < 1e-12) return null
          const len = Math.sqrt(l2)
          const steps = Math.ceil(len / (CELL / 2))
          let best: number | null = null, bt = Infinity
          const seen = new Set<number>()
          for (let s = 0; s <= steps; s++) {
            const tt = s / steps
            const cx = Math.floor((ax + dx * tt) / CELL), cz = Math.floor((az + dz * tt) / CELL)
            for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
              const k = key(cx + i, cz + j)
              if (seen.has(k)) continue
              seen.add(k)
              const arr = cells.get(k)
              if (!arr) continue
              for (const p of arr) {
                if (p === a || p === b || p === c) continue
                const px = pts[p]!.x - ax, pz = pts[p]!.z - az
                // a vertex at an end of the edge (a near-duplicate of it, within the pool's 1 mm)
                // is not on it: two such vertices split each other's edges forever
                if (px * px + pz * pz < 4e-6 || (px - dx) * (px - dx) + (pz - dz) * (pz - dz) < 4e-6) continue
                const u = (px * dx + pz * dz) / l2
                if (u <= 0 || u >= 1 || u >= bt) continue
                if (Math.abs(px * dz - pz * dx) / len > 0.001) continue
                bt = u; best = p
              }
            }
          }
          return best
        }
        const work = tris
        const out: [number, number, number][] = []
        // a triangle seen before is drawn as it is: four vertices within a millimetre of one line,
        // in the wrong order, split each other's edges in a cycle (a 5 mm sliver of the T1–T2
        // basin's edge); the cycle's leftover is a sub-millimetre double coat the coverage test drops
        const seen = new Set<string>()
        while (work.length) {
          const [a, b, c] = work.pop()!
          const tk = [a, b, c].sort((u, v) => u - v).join(',')
          if (seen.has(tk)) { out.push([a, b, c]); continue }
          seen.add(tk)
          // a collinear ear (earcut leaves a few: three contour vertices within a millimetre of one
          // line) has its third vertex on its long edge — split there it makes itself again, forever;
          // thinner than the pool's quantisation, it is dropped
          const ar = (pts[b]!.x - pts[a]!.x) * (pts[c]!.z - pts[a]!.z) - (pts[b]!.z - pts[a]!.z) * (pts[c]!.x - pts[a]!.x)
          const longest = Math.max(Math.hypot(pts[b]!.x - pts[a]!.x, pts[b]!.z - pts[a]!.z), Math.hypot(pts[c]!.x - pts[b]!.x, pts[c]!.z - pts[b]!.z), Math.hypot(pts[a]!.x - pts[c]!.x, pts[a]!.z - pts[c]!.z))
          if (longest < 1e-9 || Math.abs(ar) / longest < 0.001) continue
          let p = onEdge(a, b, c)
          if (p !== null) { work.push([a, p, c], [p, b, c]); continue }
          p = onEdge(b, c, a)
          if (p !== null) { work.push([a, b, p], [a, p, c]); continue }
          p = onEdge(c, a, b)
          if (p !== null) { work.push([a, b, p], [p, b, c]); continue }
          out.push([a, b, c])
        }
        tris = out
      }
      // refine until no edge is longer than WORLD_STEP; split per EDGE so neighbours agree
      const mid = new Map<string, number>()
      const midpoint = (a: number, b: number): number => {
        const key = a < b ? `${a},${b}` : `${b},${a}`
        let k = mid.get(key)
        if (k === undefined) { k = pts.length; pts.push({ x: (pts[a]!.x + pts[b]!.x) / 2, z: (pts[a]!.z + pts[b]!.z) / 2 }); mid.set(key, k) }
        return k
      }
      const long = (a: number, b: number) => Math.hypot(pts[a]!.x - pts[b]!.x, pts[a]!.z - pts[b]!.z) > WORLD_STEP
      for (let pass = 0; pass < 8; pass++) {
        const next: [number, number, number][] = []
        let split = false
        for (const [a, b, c] of tris) {
          const ab = long(a, b), bc = long(b, c), ca = long(c, a)
          if (!ab && !bc && !ca) { next.push([a, b, c]); continue }
          split = true
          if (ab && bc && ca) { const p = midpoint(a, b), q = midpoint(b, c), r = midpoint(c, a); next.push([a, p, r], [p, b, q], [r, q, c], [p, q, r]) }
          else if (ab && bc) { const p = midpoint(a, b), q = midpoint(b, c); next.push([a, p, q], [p, b, q], [a, q, c]) }
          else if (bc && ca) { const q = midpoint(b, c), r = midpoint(c, a); next.push([b, q, r], [q, c, r], [a, b, r]) }
          else if (ca && ab) { const r = midpoint(c, a), p = midpoint(a, b); next.push([a, p, r], [p, b, r], [b, c, r]) }
          else if (ab) { const p = midpoint(a, b); next.push([a, p, c], [p, b, c]) }
          else if (bc) { const q = midpoint(b, c); next.push([a, b, q], [a, q, c]) }
          else { const r = midpoint(c, a); next.push([a, b, r], [b, c, r]) }
        }
        tris = next
        if (!split) break
      }
      // pool vertices: contour points that already are pool vertices keep their index (an exact
      // seam with the raster); everything else is a world vertex on the field — the field at the
      // point's own nearest road (one height per XZ, rule R3), never through the ring's s window:
      // the paddock band is measured from the straight but its far edge lies on NIPPO's verge,
      // and the window put those vertices on the straight's frame, 30 cm off the field there
      const idx = pts.map((p) => {
        if (p.v !== undefined) return p.v
        const pr = window ? track.nearestOnRange(p.x, p.z, window[0], window[1], 60) : plan.project(p.x, p.z)
        return pool.addWorld(p.x, field.y(p.x, p.z), p.z, pr.s, pr.lateral)
      })
      // the contour's own edges are shared with the raster (extent edges) or are the ring's outline:
      // never split; the interior is refined further where the field demands it (a basin bank)
      const fixedEdges = new Set<number>()
      for (let i = 0; i < contour.length; i++) fixedEdges.add(edgeKey(idx[i]!, idx[(i + 1) % contour.length]!))
      const before = tris.map(([a, b, c]) => ({ p: idx[a]!, q: idx[b]!, r: idx[c]!, kind: owner.kind }))
      const poolTris = refine(before, Infinity, fixedEdges, (x, z) => field.y(x, z), null, (p, q, r, kind) => ({ p, q, r, kind }))
      if ((globalThis as unknown as { GM_DEBUG?: string }).GM_DEBUG === owner.name) {
        const ins = (T: { p: number; q: number; r: number }, x: number, z: number) => { const A = T.p, B = T.q, C = T.r; const d = (pool.z[B]! - pool.z[C]!) * (pool.x[A]! - pool.x[C]!) + (pool.x[C]! - pool.x[B]!) * (pool.z[A]! - pool.z[C]!); if (Math.abs(d) < 1e-12) return false; const u = ((pool.z[B]! - pool.z[C]!) * (x - pool.x[C]!) + (pool.x[C]! - pool.x[B]!) * (z - pool.z[C]!)) / d; const v = ((pool.z[C]! - pool.z[A]!) * (x - pool.x[C]!) + (pool.x[A]! - pool.x[C]!) * (z - pool.z[C]!)) / d; return u > 1e-6 && v > 1e-6 && 1 - u - v > 1e-6 }
        const check = (list: { p: number; q: number; r: number }[], label: string) => {
          let n = 0
          for (let i = 0; i < list.length && n < 3; i++) { const T = list[i]!; const cx = (pool.x[T.p]! + pool.x[T.q]! + pool.x[T.r]!) / 3, cz = (pool.z[T.p]! + pool.z[T.q]! + pool.z[T.r]!) / 3; for (let j = 0; j < list.length; j++) { if (i === j) continue; if (ins(list[j]!, cx, cz)) { n++; const U = list[j]!; console.info(`[gm-debug] ${label}: tri ${i} (${[T.p, T.q, T.r].join(',')}) centroid inside tri ${j} (${[U.p, U.q, U.r].join(',')}); coords ${[T.p, T.q, T.r, U.p, U.q, U.r].map((v) => `${v}:(${pool.x[v]!.toFixed(2)},${pool.z[v]!.toFixed(2)})`).join(' ')}`); break } } }
          console.info(`[gm-debug] ${label}: ${list.length} triangles, ${n ? 'FOLDS' : 'no folds'}`)
        }
        check(before, 'before refine')
        check(poolTris, 'after refine')
      }
      let emitted = 0, area = 0, rejected = 0, rejectedArea = 0
      const srcTag = 16 + (partId++ % 200)
      const trisDump = (globalThis as unknown as { GM_DEBUG?: string; GM_DEBUG_TRIS?: unknown }).GM_DEBUG === owner.name ? { before: before.map((z) => [z.p, z.q, z.r].map((v) => [pool.x[v]!, pool.z[v]!])), after: [] as unknown[] } : null
      if (trisDump) (globalThis as unknown as { GM_DEBUG_TRIS?: unknown }).GM_DEBUG_TRIS = trisDump
      const debugRejected: { area: number; x: number; z: number }[] = []
      const drawn: number[] = []
      for (const { p: ia, q: ib, r: ic } of poolTris) {
        // drop slivers: a hair-thin ear spans metres of terrain and takes a sideways normal
        const cross = (pool.x[ib]! - pool.x[ia]!) * (pool.z[ic]! - pool.z[ia]!) - (pool.z[ib]! - pool.z[ia]!) * (pool.x[ic]! - pool.x[ia]!)
        const longest = Math.max(Math.hypot(pool.x[ib]! - pool.x[ia]!, pool.z[ib]! - pool.z[ia]!), Math.hypot(pool.x[ic]! - pool.x[ib]!, pool.z[ic]! - pool.z[ib]!), Math.hypot(pool.x[ia]! - pool.x[ic]!, pool.z[ia]! - pool.z[ic]!))
        if (longest <= 1e-9 || Math.abs(cross) / longest <= MIN_WIDTH) { dropped++; if (trisDump) trisDump.after.push({ v: [ia, ib, ic].map((v) => [pool.x[v]!, pool.z[v]!]), verdict: 'sliver' }); continue }
        // a triangle the plan says is not this owner's (covered ground — the part's own triangles
        // drawn so far included, so earcut's duplicate ears on collinear points draw once — or a
        // nested higher ring) is dropped; a traced part that loses many was traced wrong and is reported
        const cxT = (pool.x[ia]! + pool.x[ib]! + pool.x[ic]!) / 3, czT = (pool.z[ia]! + pool.z[ib]! + pool.z[ic]!) / 3
        if (covered(cxT, czT) || (verify && !verify(cxT, czT))) {
          rejected++
          rejectedArea += Math.abs(cross) / 2
          droppedWorldArea += Math.abs(cross) / 2
          if ((globalThis as unknown as { GM_DEBUG?: string }).GM_DEBUG === owner.name) debugRejected.push({ area: Math.abs(cross) / 2, x: (pool.x[ia]! + pool.x[ib]! + pool.x[ic]!) / 3, z: (pool.z[ia]! + pool.z[ib]! + pool.z[ic]!) / 3 })
          if (trisDump) trisDump.after.push({ v: [ia, ib, ic].map((v) => [pool.x[v]!, pool.z[v]!]), verdict: `rejected covered=${covered((pool.x[ia]! + pool.x[ib]! + pool.x[ic]!) / 3, (pool.z[ia]! + pool.z[ib]! + pool.z[ic]!) / 3)}` })
          continue
        }
        if (trisDump) trisDump.after.push({ v: [ia, ib, ic].map((v) => [pool.x[v]!, pool.z[v]!]), verdict: 'emitted' })
        tri(owner.kind, ia, ib, ic, srcTag)
        coverTriangle(ia, ib, ic)
        drawn.push(ia, ib, ic)
        worldTris++
        emitted++
        area += Math.abs(cross) / 2
      }
      // the part is covered ground from now on; the caller splices its outline into the boundary
      const holeIdx: number[][] = []
      let at = contour.length
      for (const h of holes) { holeIdx.push(idx.slice(at, at + h.length)); at += h.length }
      console.info(`[ground-mesh] world part "${owner.name}": ${contour.length} contour vertices, ${holes.length} holes, ${emitted} triangles, ${area.toFixed(0)} m²${rejected ? ` (${rejected} rejected, ${rejectedArea.toFixed(1)} m²)` : ''}`)
      if (debugRejected.length) {
        debugRejected.sort((p, q) => q.area - p.area)
        for (const d of debugRejected.slice(0, 10)) {
          const pr = plan.project(d.x, d.z)
          console.info(`[gm-debug] rejected ${d.area.toFixed(1)} m² at (${d.x.toFixed(1)}, ${d.z.toFixed(1)}) s ${pr.s.toFixed(1)} lat ${pr.lateral.toFixed(1)} inRaster ${inRaster(d.x, d.z).inside} inStitch ${inStitch(d.x, d.z)} extentDrawn ${plan.extentDrawn(pr.s, pr.lateral > 0 ? 1 : -1).toFixed(2)} owner ${plan.ownerAt(d.x, d.z).name}`)
        }
        const sample = contour.filter((_p, k) => k % Math.max(1, Math.floor(contour.length / 24)) === 0).map((p) => { const pr = plan.project(p.x, p.z); return `s${pr.s.toFixed(0)}/${pr.lateral.toFixed(0)}${covered(p.x, p.z) ? 'c' : ''}` })
        console.info(`[gm-debug] contour (every ${Math.max(1, Math.floor(contour.length / 24))}th, c = covered): ${sample.join(' ')}`)
      }
      // slivers along the contour's raster edges are expected to fall either way; a real share of
      // the area on covered ground means the contour was traced wrong
      if (rejectedArea > 2 && rejectedArea > area * 0.05) console.warn(`[ground-mesh] "${owner.name}": ${rejectedArea.toFixed(0)} m² of ${(area + rejectedArea).toFixed(0)} m² of a world part lie on covered ground — the traced contour is doubtful`)
      return { emitted, idx: idx.slice(0, contour.length), holeIdx }
  }
  /** a 'way' footprint far from every raster: the OSM polyline swept as a quad grid on the field */
  const emitSweep = (r: RingOwner, width: number) => {
    const fp = r.area!.footprint as { way: number; width: number }
    const f = osmWay(fp.way)
    if (!f) return
    const raw = f.en.map(([e, n]) => ({ x: e * track.enScale, z: -n * track.enScale }))
    const closed = f.closed
    const pts: Pt[] = []
    const last = closed ? raw.length : raw.length - 1
    for (let i = 0; i < last; i++) {
      const a = raw[i]!, b = raw[(i + 1) % raw.length]!
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / WORLD_STEP))
      for (let k = 0; k < n; k++) pts.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n })
    }
    if (!closed) pts.push(raw[raw.length - 1]!)
    const rails = Math.max(2, Math.round(width / WORLD_STEP) + 1)
    const n = pts.length
    const count = closed ? n + 1 : n
    const grid: number[][] = []
    for (let i = 0; i < count; i++) {
      const p = pts[i % n]!
      const a = pts[closed ? (i - 1 + n) % n : Math.max(0, i - 1)]!, b = pts[closed ? (i + 1) % n : Math.min(n - 1, i + 1)]!
      let dx = b.x - a.x, dz = b.z - a.z
      const l = Math.hypot(dx, dz) || 1
      dx /= l; dz /= l
      const row: number[] = []
      const prev = grid[grid.length - 1]
      for (let k = 0; k < rails; k++) {
        const t = (0.5 - k / (rails - 1)) * width
        const x = p.x + dz * t, z = p.z - dx * t
        // on the inside of a bend tighter than the offset the rail turns back on itself and the
        // quads fold over one another (the secondary paving at T18); such a rail stalls at its
        // previous vertex instead
        if (prev && (x - pool.x[prev[k]!]!) * dx + (z - pool.z[prev[k]!]!) * dz < 0) { row.push(prev[k]!); continue }
        const pr = plan.project(x, z)
        row.push(pool.addWorld(x, field.y(x, z), z, pr.s, pr.lateral))
      }
      grid.push(row)
    }
    // the winding of the first quad: every quad must wind the same way, or it has folded over its
    // neighbour on the inside of a bend (the secondary paving at T18) and is left out — a small
    // notch on the inside instead of two coats of asphalt
    const triArea = (a: number, b: number, c: number) => (pool.x[b]! - pool.x[a]!) * (pool.z[c]! - pool.z[a]!) - (pool.z[b]! - pool.z[a]!) * (pool.x[c]! - pool.x[a]!)
    let sign = 0
    for (let i = 0; i < count - 1; i++) {
      for (let k = 0; k < rails - 1; k++) {
        const p00 = grid[i]![k]!, p01 = grid[i]![k + 1]!, p10 = grid[i + 1]![k]!, p11 = grid[i + 1]![k + 1]!
        const a1 = triArea(p00, p10, p01), a2 = triArea(p01, p10, p11)
        if (Math.abs(a1) < 1e-6 && Math.abs(a2) < 1e-6) continue
        if (sign === 0) sign = Math.sign(Math.abs(a1) > Math.abs(a2) ? a1 : a2)
        // either triangle winding the other way: the quad has folded over its neighbour
        if ((Math.abs(a1) > 1e-6 && Math.sign(a1) !== sign) || (Math.abs(a2) > 1e-6 && Math.sign(a2) !== sign)) continue
        // ...and a quad over ground already covered — the sweep's own earlier quads where the way
        // knots (OSM 183393709 doubles back on itself for 2 m) — is left out too: a notch, not two coats
        for (const [a, b, c] of [[p00, p10, p01], [p01, p10, p11]] as const) {
          const xs = [pool.x[a]!, pool.x[b]!, pool.x[c]!], zs = [pool.z[a]!, pool.z[b]!, pool.z[c]!]
          if (covered((xs[0]! + xs[1]! + xs[2]!) / 3, (zs[0]! + zs[1]! + zs[2]!) / 3)) continue
          tri(r.owner.kind, a, b, c, 1)
          coverTriangle(a, b, c)
          worldTris++
        }
      }
    }
  }
  {
    // the crossing of a ring edge (covered → uncovered) with the covered ground, by bisection
    const crossing = (pIn: Pt, pOut: Pt): Pt => {
      let a = pIn, b = pOut
      for (let it = 0; it < 24; it++) {
        const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2
        if (covered(mx, mz)) a = { x: mx, z: mz }
        else b = { x: mx, z: mz }
      }
      return { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 }
    }
    /** a closed polyline with no edge longer than `step` (every input vertex kept) */
    const dense = (pts: readonly Pt[], step: number): Pt[] => {
      const out: Pt[] = []
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i]!, b = pts[(i + 1) % pts.length]!
        const k = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / step))
        for (let q = 0; q < k; q++) out.push({ x: a.x + ((b.x - a.x) * q) / k, z: a.z + ((b.z - a.z) * q) / k })
      }
      return out
    }
    /**
     * The dense resampling undone for the polygon: a ring's OWN outline (an arc between two
     * crossings, a hole loop touching nothing) is shared with no other face, so its 0.1 m points
     * along a straight OSM edge only feed earcut ladders of 2 m × 4 mm ears, which the
     * refinement then multiplies (240k world triangles for 37k). Douglas–Peucker at 2 mm keeps
     * every real vertex; the crossings at the ends stay where they are.
     */
    const thin = <P extends { x: number; z: number }>(pts: readonly P[], tol: number): P[] => {
      if (pts.length < 3) return [...pts]
      const keep = new Uint8Array(pts.length)
      keep[0] = 1; keep[pts.length - 1] = 1
      const stack: [number, number][] = [[0, pts.length - 1]]
      while (stack.length) {
        const [i0, i1] = stack.pop()!
        if (i1 - i0 < 2) continue
        const a = pts[i0]!, b = pts[i1]!
        const dx = b.x - a.x, dz = b.z - a.z
        const len = Math.hypot(dx, dz) || 1
        let worst = -1, wd = tol
        for (let i = i0 + 1; i < i1; i++) {
          const p = pts[i]!
          const d = len > 1e-9 ? Math.abs((p.x - a.x) * dz - (p.z - a.z) * dx) / len : Math.hypot(p.x - a.x, p.z - a.z)
          if (d > wd) { wd = d; worst = i }
        }
        if (worst < 0) continue
        keep[worst] = 1
        stack.push([i0, worst], [worst, i1])
      }
      return pts.filter((_p, i) => keep[i])
    }
    for (const r of plan.rings) {
      /*
       * The ring's boundary as loops: its outer ring (interior on the left), then its holes,
       * REVERSED so that this owner's ground is on their left too. The rings above it in
       * precedence need no loops of their own here: their parts are covered ground with their
       * outlines in U, and their raster cells are the raster. Every loop is resampled to 0.1 m
       * so a raster edge crossing a long segment is seen by the vertex tests.
       */
      const loops: Pt[][] = [dense(r.ring.outer, 0.1), ...r.ring.holes.map((h) => dense(h, 0.1).reverse())]
      const flags = loops.map((lp) => lp.map((p) => covered(p.x, p.z)))
      const nInside = flags[0]!.filter((f) => f).length
      // a ring whose boundary is covered everywhere can still enclose an uncovered pocket (the
      // Casio triangle's middle): it skips the tracing but not the pocket claim below
      const boundaryCovered = nInside === loops[0]!.length
      if (nInside === 0) {
        // a swept way that never touches a raster is built as the swept quad grid it is (rails
        // every ≤ WORLD_STEP): earcut on a 10 m wide, kilometre-long annulus makes long slivers
        // that the refinement then multiplies tenfold
        if (r.area && 'way' in r.area.footprint) { emitSweep(r, r.area.footprint.width); continue }
        emitPolygon(r.owner, thin(loops[0]!, 0.002).map((p) => ({ x: p.x, z: p.z })), loops.slice(1).map((h) => thin([...h].reverse(), 0.002)), r.ring.sRange)
        continue
      }
      /*
       * The ring's part beyond the covered ground, traced as a boolean of its loops against the
       * union boundary U: the region's boundary alternates between ARCS of the loops (a loop
       * outside the covered ground, from an exit crossing A to an entry crossing B) and pieces of
       * U (walked in U's orientation, the uncovered ground on the left) to the next crossing of
       * any of this ring's loops; an exit there continues along its arc, and the polygon closes
       * back at the first A. A basin inside the T2 → Esses loop has two arcs and closes as one
       * polygon; a bump has one; the turf island inside the chicane apron is a hole loop whose
       * arcs bound the apron's part from the inside. Every loop is resampled to 0.1 m so a loop
       * crossing a narrow gap in the covered ground (the mouth of a pocket) is seen to cross it. A
       * hole loop that never touches the covered
       * ground is an earcut hole of the polygon that contains it. A crossing the bisection cannot
       * place on U (none within 1 m), or a walk that meets an entry instead of an exit, is not a
       * region this boundary bounds; it is reported and the census measures it.
       */
      interface Arc { id: number; loop: number; i0: number; i1: number; A: NonNullable<ReturnType<typeof locateOnU>>; B: NonNullable<ReturnType<typeof locateOnU>> }
      const arcs: Arc[] = []
      let unplaced = 0
      const untouched: number[] = []
      for (let li = 0; li < loops.length && !boundaryCovered; li++) {
        const lp = loops[li]!, fl = flags[li]!
        const n = lp.length
        const start = fl.findIndex((f) => f)
        if (start < 0) { if (li > 0) untouched.push(li); continue }
        for (let k = 0; k < n; k++) {
          const i0 = (start + k) % n
          if (fl[i0]! || !fl[(i0 - 1 + n) % n]!) continue
          let i1 = i0
          while (!fl[(i1 + 1) % n]!) i1 = (i1 + 1) % n
          const cA = crossing(lp[(i0 - 1 + n) % n]!, lp[i0]!), cB = crossing(lp[(i1 + 1) % n]!, lp[i1]!)
          const A = locateOnU(cA.x, cA.z), B = locateOnU(cB.x, cB.z)
          if (!A || !B) {
            unplaced++
            if ((globalThis as unknown as { GM_DEBUG?: string }).GM_DEBUG === r.owner.name) {
              const c = A ? cB : cA
              const pr = plan.project(c.x, c.z)
              const sd: Side = pr.lateral > 0 ? 1 : -1
              console.info(`[gm-debug] unplaced crossing at (${c.x.toFixed(1)}, ${c.z.toFixed(1)}) s ${pr.s.toFixed(1)} lat ${pr.lateral.toFixed(1)} extentDrawn ${plan.extentDrawn(pr.s, sd).toFixed(2)} inRaster ${inRaster(c.x, c.z).inside} inStitch ${inStitch(c.x, c.z)} covered ${covered(c.x, c.z)}`)
            }
            continue
          }
          arcs.push({ id: arcs.length, loop: li, i0, i1, A, B })
        }
      }
      if (unplaced) uncovered(`"${r.owner.name}": ${unplaced} outside arc(s) leave the covered ground where no boundary edge is within 1 m — not traced`)
      const debug = (globalThis as unknown as { GM_DEBUG?: string }).GM_DEBUG === r.owner.name
      if (debug) for (const a of arcs) console.info(`[gm-debug] arc ${a.id}: loop ${a.loop} ${a.i0}-${a.i1}, A loop ${a.A.loop} pos ${(a.A.k + a.A.t).toFixed(2)} (${a.A.x.toFixed(0)},${a.A.z.toFixed(0)}), B loop ${a.B.loop} pos ${(a.B.k + a.B.t).toFixed(2)} (${a.B.x.toFixed(0)},${a.B.z.toFixed(0)})`)
      const posOf = (c: { loop: number; k: number; t: number }) => c.k + c.t
      const onU = (c: { x: number; z: number; y: number }): { x: number; z: number; v: number } => ({ x: c.x, z: c.z, v: pool.addWorld(c.x, c.y, c.z, plan.project(c.x, c.z).s, 0) })
      const visited = new Set<number>()
      const nearRingEdge = (x: number, z: number, tol: number): boolean => {
        const ring = r.ring.outer
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const a = ring[j]!, b = ring[i]!
          const dx = b.x - a.x, dz = b.z - a.z
          const l2 = dx * dx + dz * dz || 1
          const tt = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / l2))
          if (Math.hypot(x - a.x - dx * tt, z - a.z - dz * tt) < tol) return true
        }
        return false
      }
      // a triangle along the ring's edge whose centroid lands a hair outside it (a conform split
      // of an edge triangle) is the ring's: 5 cm of tolerance, or the edge is left as bare slivers
      const insideRing = (x: number, z: number) => inWorldRing(x, z, r.ring) || nearRingEdge(x, z, 0.05)
      /** a polygon's boundary pieces: the arcs of this ring and the pieces of U between them, as contour index ranges */
      type Piece = { kind: 'arc'; from: number; to: number } | { kind: 'U'; loop: number; kB: number; kA: number; from: number; to: number; walked: number[] }
      const polygons: { contour: { x: number; z: number; v?: number }[]; pieces: Piece[] }[] = []
      for (const first of arcs) {
        if (visited.has(first.id)) continue
        const contour: { x: number; z: number; v?: number }[] = []
        const pieces: Piece[] = []
        let cur: Arc = first
        let ok = true
        for (let guard = 0; guard <= arcs.length; guard++) {
          visited.add(cur.id)
          const lp = loops[cur.loop]!, n = lp.length
          const a0 = contour.length
          contour.push(onU(cur.A))
          const arcPts: Pt[] = []
          for (let i = cur.i0; ; i = (i + 1) % n) { arcPts.push({ x: lp[i]!.x, z: lp[i]!.z }); if (i === cur.i1) break }
          for (const p of thin(arcPts, 0.002)) contour.push(p)
          contour.push(onU(cur.B))
          const b0 = contour.length - 1
          pieces.push({ kind: 'arc', from: a0, to: b0 })
          // the next crossing of this ring along B's loop of U, ahead of B in the loop's orientation
          const uloop = uLoops[cur.B.loop]!
          const len = uloop.length
          const pB = posOf(cur.B)
          let next: Arc | null = null, nextIsA = true, best = Infinity
          for (const a of arcs) {
            if (a.A.loop === cur.B.loop) { const dd = (posOf(a.A) - pB + len) % len; if (dd > 1e-9 && dd < best) { best = dd; next = a; nextIsA = true } }
            if (a.B.loop === cur.B.loop && a !== cur) { const dd = (posOf(a.B) - pB + len) % len; if (dd > 1e-9 && dd < best) { best = dd; next = a; nextIsA = false } }
          }
          if (!next || !nextIsA) {
            uncovered(`"${r.owner.name}": the region beyond the covered ground from the arc at (${first.A.x.toFixed(0)}, ${first.A.z.toFixed(0)}) does not close along the boundary (${next ? 'the next crossing is an entry' : 'no next crossing on its loop'}) — not traced`)
            ok = false
            break
          }
          // the boundary vertices strictly between B and the next crossing, in loop order
          const walked: number[] = []
          for (let step = 1; step <= len; step++) {
            const kk = (cur.B.k + step) % len
            if ((kk - pB + len) % len >= best) break
            const v = uloop[kk]!
            contour.push({ x: pool.x[v]!, z: pool.z[v]!, v })
            walked.push(v)
          }
          pieces.push({ kind: 'U', loop: cur.B.loop, kB: cur.B.k, kA: next.A.k, from: b0, to: next === first ? 0 : contour.length, walked })
          if (debug) console.info(`[gm-debug] from arc ${cur.id} B → next arc ${next.id} (${nextIsA ? 'A' : 'B'}) ${best.toFixed(2)} edges ahead on loop ${cur.B.loop} (len ${len})`)
          if (next === first) break
          cur = next
        }
        if (debug) console.info(`[gm-debug] polygon from arc ${first.id}: ok ${ok}, contour ${contour.length}`)
        const dumpTo = (globalThis as unknown as { GM_DEBUG_CONTOURS?: unknown[] }).GM_DEBUG_CONTOURS
        if (Array.isArray(dumpTo)) dumpTo.push({ name: r.owner.name, ok, contour: contour.map((p) => [p.x, p.z]), pieces: pieces.map((p) => ({ ...p, walked: undefined })) })
        if (!ok || contour.length < 3) continue
        polygons.push({ contour, pieces })
      }
      // --- the splice of U for this ring's parts, applied together once they are drawn
      /** split points on U edges: key loop|k, the parameter along the edge, the vertex, entry (B) or exit (A) */
      const splits = new Map<string, { t: number; v: number; role: 'B' | 'A' }[]>()
      const consumed = new Set<number>()
      const chains: number[][] = []
      const newLoops: number[][] = []
      const tOf = (li: number, k: number, v: number): number => {
        const loop = uLoops[li]!, p = loop[k]!, q = loop[(k + 1) % loop.length]!
        const dx = pool.x[q]! - pool.x[p]!, dz = pool.z[q]! - pool.z[p]!
        const l2 = dx * dx + dz * dz || 1
        return Math.max(0, Math.min(1, ((pool.x[v]! - pool.x[p]!) * dx + (pool.z[v]! - pool.z[p]!) * dz) / l2))
      }
      const split = (li: number, k: number, v: number, role: 'B' | 'A') => {
        const key = `${li}|${k}`
        let list = splits.get(key)
        if (!list) { list = []; splits.set(key, list) }
        list.push({ t: tOf(li, k, v), v, role })
      }
      const crossedLoops = new Set(arcs.flatMap((a) => [a.A.loop, a.B.loop]))
      const loopArea2 = (loop: number[]): number => { let a2 = 0; for (let k = 0; k < loop.length; k++) { const p = loop[k]!, q = loop[(k + 1) % loop.length]!; a2 += pool.x[p]! * -pool.z[q]! - pool.x[q]! * -pool.z[p]! } return a2 }
      /**
       * The holes of a polygon: the ring's own hole loops the covered ground never touches, and
       * every covered ISLAND inside it — a loop of U with the covered ground inside (a part of a
       * higher ring, the pond in the paddock) that none of this ring's arcs crosses. An island's
       * loop is consumed once the part is drawn around it: covered on both sides, it is no boundary.
       */
      const islands: number[] = []
      const holesOf = (contour: { x: number; z: number }[]): Pt[][] => {
        const holes: Pt[][] = []
        for (const li of untouched) { const h = loops[li]!; if (inRing(h[0]!.x, h[0]!.z, contour)) holes.push(thin([...h].reverse(), 0.002)) }
        for (let li = 0; li < uLoops.length; li++) {
          if (crossedLoops.has(li)) continue
          const loop = uLoops[li]!
          if (loop.length > 2000 || loopArea2(loop) >= 0) continue
          const v0 = loop[0]!
          if (!inRing(pool.x[v0]!, pool.z[v0]!, contour)) continue
          islands.push(li)
          holes.push(loop.map((v) => ({ x: pool.x[v]!, z: pool.z[v]! })))
        }
        return holes
      }
      for (const poly of polygons) {
        islands.length = 0
        const res = emitPolygon(r.owner, poly.contour, holesOf(poly.contour), r.ring.sRange, (x, z) => !covered(x, z) && insideRing(x, z))
        if (!res.emitted) continue
        for (const li of islands) for (const v of uLoops[li]!) consumed.add(v)
        for (const pc of poly.pieces) {
          if (pc.kind === 'arc') {
            // the arc reversed: from its entry B back to its exit A, the part on its right
            const chain: number[] = []
            for (let k = pc.to; k >= pc.from; k--) chain.push(res.idx[k]!)
            chains.push(chain)
          } else {
            split(pc.loop, pc.kB, res.idx[pc.from]!, 'B')
            split(pc.loop, pc.kA, res.idx[pc.to]!, 'A')
            for (const v of pc.walked) consumed.add(v)
          }
        }
        for (const h of res.holeIdx) newLoops.push(h)
      }
      // an uncovered pocket bounded by the covered ground alone — a loop of U that none of this
      // ring's loops crosses — that lies inside the ring is the ring's ground too (the Casio
      // triangle's middle, beyond both legs' rasters, inside the turf island)
      for (let li = 0; li < uLoops.length; li++) {
        const loop = uLoops[li]!
        if (debug) {
          let a2d = 0
          for (let k = 0; k < loop.length; k++) { const p = loop[k]!, q = loop[(k + 1) % loop.length]!; a2d += pool.x[p]! * -pool.z[q]! - pool.x[q]! * -pool.z[p]! }
          const inside = loop.filter((v) => insideRing(pool.x[v]!, pool.z[v]!)).length
          console.info(`[gm-debug] U loop ${li}: ${loop.length} vertices, area ${(a2d / 2).toFixed(0)} m², ${inside} vertices inside this ring, crossed by ${arcs.filter((a) => a.A.loop === li || a.B.loop === li).length} arcs`)
        }
        if (arcs.some((a) => a.A.loop === li || a.B.loop === li)) continue
        if (loop.length > 2000) continue // the exterior boundary of a whole side of the lap
        const v0 = loop[0]!
        if (!insideRing(pool.x[v0]!, pool.z[v0]!)) continue
        // the loop must be wound with the pocket on its left (the uncovered side): a probe left
        // of a long edge is uncovered by construction, so the loop's interior is the pocket
        // only if its signed area says the left side is the inside (counter-clockwise from above)
        let a2 = 0
        for (let k = 0; k < loop.length; k++) { const p = loop[k]!, q = loop[(k + 1) % loop.length]!; a2 += pool.x[p]! * -pool.z[q]! - pool.x[q]! * -pool.z[p]! }
        if (a2 <= 0) continue // uncovered on the OUTSIDE of this loop: it encloses covered ground, not a pocket
        const contour = loop.map((v) => ({ x: pool.x[v]!, z: pool.z[v]!, v }))
        islands.length = 0
        const res = emitPolygon(r.owner, contour, holesOf(contour), r.ring.sRange, (x, z) => !covered(x, z) && insideRing(x, z))
        if (!res.emitted) continue
        for (const v of loop) consumed.add(v)
        for (const li of islands) for (const v of uLoops[li]!) consumed.add(v)
        for (const h of res.holeIdx) newLoops.push(h)
      }
      // apply: the consumed pieces go, the split edges keep their outer parts, the arcs link them
      if (consumed.size || splits.size || chains.length || newLoops.length) {
        for (const v of consumed) uNext.delete(v)
        for (const [key, list] of splits) {
          const [li, k] = key.split('|').map(Number) as [number, number]
          const loop = uLoops[li]!, p = loop[k]!, q = loop[(k + 1) % loop.length]!
          list.sort((a, b) => a.t - b.t)
          let cursor: number | null = consumed.has(p) || list[0]!.role === 'A' ? null : p
          for (const sp of list) {
            if (sp.role === 'B') { if (cursor !== null && cursor !== sp.v) uNext.set(cursor, sp.v); cursor = null }
            else cursor = sp.v
          }
          if (cursor !== null && cursor !== q && !consumed.has(q)) uNext.set(cursor, q)
        }
        for (const chain of chains) for (let k = 0; k + 1 < chain.length; k++) if (chain[k] !== chain[k + 1]) uNext.set(chain[k]!, chain[k + 1]!)
        for (const h of newLoops) {
          const loop: number[] = []
          for (const v of h) if (loop.length === 0 || loop[loop.length - 1] !== v) loop.push(v)
          while (loop.length > 1 && loop[0] === loop[loop.length - 1]) loop.pop()
          if (loop.length < 3) continue
          let a2 = 0
          for (let k = 0; k < loop.length; k++) { const p = loop[k]!, q = loop[(k + 1) % loop.length]!; a2 += pool.x[p]! * -pool.z[q]! - pool.x[q]! * -pool.z[p]! }
          if (a2 < 0) loop.reverse() // the hole's inside is uncovered: on the left
          for (let k = 0; k < loop.length; k++) uNext.set(loop[k]!, loop[(k + 1) % loop.length]!)
        }
        rebuildLoops()
      }
    }
  }

  lap('world')
  // --- normals once over the union of all faces ----------------------------------------------------
  const N = pool.x.length
  const nx = new Float64Array(N), ny = new Float64Array(N), nz = new Float64Array(N)
  for (const arr of triByKind.values()) {
    for (let t = 0; t < arr.length; t += 3) {
      const a = arr[t]!, b = arr[t + 1]!, c = arr[t + 2]!
      const ux = pool.x[b]! - pool.x[a]!, uy = pool.y[b]! - pool.y[a]!, uz = pool.z[b]! - pool.z[a]!
      const vx = pool.x[c]! - pool.x[a]!, vy = pool.y[c]! - pool.y[a]!, vz = pool.z[c]! - pool.z[a]!
      const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx
      nx[a] = nx[a]! + fx; ny[a] = ny[a]! + fy; nz[a] = nz[a]! + fz
      nx[b] = nx[b]! + fx; ny[b] = ny[b]! + fy; nz[b] = nz[b]! + fz
      nx[c] = nx[c]! + fx; ny[c] = ny[c]! + fy; nz[c] = nz[c]! + fz
    }
  }
  const normal = new Float32Array(N * 3)
  for (let i = 0; i < N; i++) {
    const l = Math.hypot(nx[i]!, ny[i]!, nz[i]!)
    if (l < 1e-9) { normal[i * 3 + 1] = 1; continue }
    normal[i * 3] = nx[i]! / l
    normal[i * 3 + 1] = ny[i]! / l
    normal[i * 3 + 2] = nz[i]! / l
  }

  lap('normals')
  // --- one mesh per kind: bit-identical copies of the shared vertices, its own uv ------------------
  const group = new THREE.Group()
  group.name = 'ground'
  const faces: GroundFace[] = []
  const byKind: Record<string, number> = {}
  let triangles = 0
  const pit = CIRCUIT.pit
  const uvOf = (kind: OwnerKind, v: number, out: [number, number]) => {
    const s = pool.s[v]!, lat = pool.lat[v]!
    const hw = track.halfWidthAt(s)
    const off = Math.abs(lat) - hw
    const planar = PLANAR_UV[kind]
    if (planar) { out[0] = pool.x[v]! / planar[0]; out[1] = -pool.z[v]! / planar[1]; return }
    switch (kind) {
      case 'road': out[0] = (hw - lat) / (2 * hw); out[1] = s / ASPHALT_TILE_M; return
      case 'asphaltBand': out[0] = off / ASPHALT_WIDTH_M; out[1] = s / ASPHALT_TILE_M; return
      case 'kerb': {
        const kb = kerbAt(plan.kerbs, track, s, lat >= 0 ? 1 : -1)
        const w = kb.width * kb.taper || 1
        out[0] = Math.max(0, Math.min(1, off / w)); out[1] = s / 2; return
      }
      case 'pitLane': {
        const c = track.pitLateralAt(s) ?? pit.laneOffset
        out[0] = (c + pit.laneWidth / 2 - lat) / ASPHALT_WIDTH_M; out[1] = s / ASPHALT_TILE_M; return
      }
      case 'pitApron': out[0] = (-lat + pit.laneOffset - pit.laneWidth / 2) / 6; out[1] = s / 4; return
      case 'deckShoulder': out[0] = off / DECK_SHOULDER; out[1] = s / 10; return
      case 'helipad': {
        // the nearest pad's tile of the helipad atlas (textures.ts helipadTexture: two tiles along u)
        let pad = HELIPADS[0]!
        let best = Infinity
        for (const h of HELIPADS) { const d = Math.abs(signedDelta(h.s, s, track.length)); if (d < best) { best = d; pad = h } }
        out[0] = (pad.mark + 0.5 + (s - pad.s) / (2 * pad.radius)) / HELIPADS.length; out[1] = 0.5 + (lat - pad.lateral) / (2 * pad.radius); return
      }
      default: out[0] = pool.x[v]! / 10; out[1] = -pool.z[v]! / 10
    }
  }
  const uvTmp: [number, number] = [0, 0]
  for (const kind of PRECEDENCE) {
    const arr = triByKind.get(kind)
    if (!arr || !arr.length) continue
    const local = new Map<number, number>()
    const index: number[] = []
    for (const v of arr) {
      let li = local.get(v)
      if (li === undefined) { li = local.size; local.set(v, li) }
      index.push(li)
    }
    const n = local.size
    const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), uv = new Float32Array(n * 2)
    for (const [v, li] of local) {
      pos[li * 3] = pool.x[v]!; pos[li * 3 + 1] = pool.y[v]!; pos[li * 3 + 2] = pool.z[v]!
      nrm[li * 3] = normal[v * 3]!; nrm[li * 3 + 1] = normal[v * 3 + 1]!; nrm[li * 3 + 2] = normal[v * 3 + 2]!
      uvOf(kind, v, uvTmp)
      uv[li * 2] = uvTmp[0]; uv[li * 2 + 1] = uvTmp[1]
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    if (kind === 'road') {
      // the west loop's fresh asphalt (FRESH_ASPHALT): 0 → 1 over `fade` m inside both ends; the
      // road material reads it as `aFresh` (materials.ts addRoadSurface), every other face that
      // shares the program has no such attribute and reads 0
      const fresh = new Float32Array(n)
      const [f0, f1] = FRESH_ASPHALT.sRange
      const len = forwardDelta(f0, f1, track.length)
      const smooth = (t: number) => { const x = Math.max(0, Math.min(1, t)); return x * x * (3 - 2 * x) }
      for (const [v, li] of local) {
        const d = forwardDelta(f0, pool.s[v]!, track.length)
        fresh[li] = d <= len ? smooth(d / FRESH_ASPHALT.fade) * smooth((len - d) / FRESH_ASPHALT.fade) : 0
      }
      geo.setAttribute('aFresh', new THREE.BufferAttribute(fresh, 1))
    }
    geo.setIndex(index)
    geo.computeBoundingSphere()
    const mat = materials[kind]
    if (!mat) fail(`no material for ground kind "${kind}"`)
    const mesh = new THREE.Mesh(geo, mat ?? new THREE.MeshStandardMaterial({ color: 0xff00ff }))
    mesh.name = `ground:${kind}`
    mesh.userData.triSource = Uint8Array.from(srcByKind.get(kind)!)
    mesh.receiveShadow = true
    group.add(mesh)
    const tris = index.length / 3
    const face = { kind, frame: RULE_OF[kind].frame, geo, mesh, tris } as GroundFace
    minted.add(face)
    faces.push(face)
    byKind[kind] = tris
    triangles += tris
  }
  if (droppedWorldArea > 0) console.info(`[ground-mesh] ${droppedWorldArea.toFixed(0)} m² of world-part triangles dropped as covered ground or nested rings`)
  const stripStats = strips.map((st) => ({ sideA: st.sideA, aFrom: plan.stations[st.aSt[0]!]!, aTo: plan.stations[st.aSt[st.aSt.length - 1]!]!, sideB: st.sideB, bFrom: plan.stations[Math.min(st.bSt[0]!, st.bSt[st.bSt.length - 1]!)]!, bTo: plan.stations[Math.max(st.bSt[0]!, st.bSt[st.bSt.length - 1]!)]! }))
  const index = new FaceIndex(faces)
  lap('geometry')
  return { group, faces, yAt: (x, z) => index.yAt(x, z), decal: (quads, rung, layout) => index.decal(quads, rung, layout), stats: { vertices: N, triangles, cells: cells.length, dropped, byKind, worldTris, stitchTris, buildMs: performance.now() - t0, timing, errors, uncoveredArcs, strips: stripStats, boundary: { loops: uLoops.map((l) => l.length), skipped: uBad } } }
}

/**
 * The drawn ground by XZ: every face's triangles in an 8 m hash, built on first use (the decals
 * and the objects standing on the ground ask; a scene that never asks pays nothing).
 */
class FaceIndex {
  private static readonly CELL = 8
  private cells: Map<number, number[]> | null = null
  constructor(private readonly faces: GroundFace[]) {}

  private key(ix: number, iz: number): number {
    return (ix + 32768) * 65536 + (iz + 32768)
  }

  private build(): Map<number, number[]> {
    const CELL = FaceIndex.CELL
    const cells = new Map<number, number[]>()
    const faces = this.faces
    for (let f = 0; f < faces.length; f++) {
      const geo = faces[f]!.geo
      const pos = geo.attributes.position!
      const idx = geo.getIndex()!
      const n = idx.count / 3
      for (let t = 0; t < n; t++) {
        const a = idx.getX(t * 3), b = idx.getX(t * 3 + 1), c = idx.getX(t * 3 + 2)
        const ax = pos.getX(a), az = pos.getZ(a), bx = pos.getX(b), bz = pos.getZ(b), cx = pos.getX(c), cz = pos.getZ(c)
        const i0 = Math.floor(Math.min(ax, bx, cx) / CELL), i1 = Math.floor(Math.max(ax, bx, cx) / CELL)
        const j0 = Math.floor(Math.min(az, bz, cz) / CELL), j1 = Math.floor(Math.max(az, bz, cz) / CELL)
        const id = f * 4194304 + t
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
          const k = this.key(i, j)
          let arr = cells.get(k)
          if (!arr) { arr = []; cells.set(k, arr) }
          arr.push(id)
        }
      }
    }
    this.cells = cells
    return cells
  }

  /**
   * The TOPMOST face containing (x, z) — after the plan, no two faces should, but the lookup does
   * not assume it.
   */
  yAt(x: number, z: number): { y: number; kind: OwnerKind; src: number } | null {
    const CELL = FaceIndex.CELL
    const cells = this.cells ?? this.build()
    const arr = cells.get(this.key(Math.floor(x / CELL), Math.floor(z / CELL)))
    if (!arr) return null
    let best: { y: number; kind: OwnerKind; src: number } | null = null
    for (const id of arr) {
      const f = Math.floor(id / 4194304), t = id - f * 4194304
      const face = this.faces[f]!
      const pos = face.geo.attributes.position!, idx = face.geo.getIndex()!
      const a = idx.getX(t * 3), b = idx.getX(t * 3 + 1), c = idx.getX(t * 3 + 2)
      const ax = pos.getX(a), az = pos.getZ(a), bx = pos.getX(b), bz = pos.getZ(b), cx = pos.getX(c), cz = pos.getZ(c)
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz)
      if (Math.abs(d) < 1e-12) continue
      const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d
      const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d
      const w = 1 - u - v
      if (u < -1e-6 || v < -1e-6 || w < -1e-6) continue
      const y = pos.getY(a) * u + pos.getY(b) * v + pos.getY(c) * w
      if (!best || y > best.y) best = { y, kind: face.kind, src: (face.mesh.userData.triSource as Uint8Array | undefined)?.[t] ?? 0 }
    }
    return best
  }

  /** every triangle whose hash cells meet the box, once each */
  private each(x0: number, z0: number, x1: number, z1: number, fn: (face: GroundFace, t: number) => void): void {
    const CELL = FaceIndex.CELL
    const cells = this.cells ?? this.build()
    const i0 = Math.floor(x0 / CELL), i1 = Math.floor(x1 / CELL), j0 = Math.floor(z0 / CELL), j1 = Math.floor(z1 / CELL)
    const seen = i1 > i0 || j1 > j0 ? new Set<number>() : null
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const arr = cells.get(this.key(i, j))
      if (!arr) continue
      for (const id of arr) {
        if (seen) { if (seen.has(id)) continue; seen.add(id) }
        const f = Math.floor(id / 4194304)
        fn(this.faces[f]!, id - f * 4194304)
      }
    }
  }

  /** see BuiltGround.decal */
  decal(quads: readonly DecalQuad[], rung: number | ((kind: OwnerKind) => number), layout: readonly { name: string; size: number }[]): { geo: THREE.BufferGeometry | null; stats: DecalStats } {
    const stats: DecalStats = { quads: quads.length, triangles: 0, area: 0, uncovered: 0, bareAt: [] }
    const pos: number[] = [], nrm: number[] = []
    const extra: number[][] = layout.map(() => [])
    const rungOf = typeof rung === 'number' ? () => rung : rung
    // Sutherland–Hodgman scratch: a triangle clipped by four half-planes has at most 7 vertices
    const inX = new Float64Array(8), inZ = new Float64Array(8), outX = new Float64Array(8), outZ = new Float64Array(8)
    const qx = new Float64Array(4), qz = new Float64Array(4)
    for (const q of quads) {
      // wind the quad so that "inside" is cross(edge, corner − edge start) ≥ 0
      let a2 = 0
      for (let k = 0; k < 4; k++) {
        const m = (k + 1) % 4
        a2 += q.xz[2 * k]! * q.xz[2 * m + 1]! - q.xz[2 * m]! * q.xz[2 * k + 1]!
      }
      if (Math.abs(a2) < 1e-9) continue
      for (let k = 0; k < 4; k++) {
        const src = a2 < 0 ? 3 - k : k
        qx[k] = q.xz[2 * src]!
        qz[k] = q.xz[2 * src + 1]!
      }
      const qArea = Math.abs(a2) / 2
      stats.area += qArea
      const bx0 = Math.min(qx[0]!, qx[1]!, qx[2]!, qx[3]!), bx1 = Math.max(qx[0]!, qx[1]!, qx[2]!, qx[3]!)
      const bz0 = Math.min(qz[0]!, qz[1]!, qz[2]!, qz[3]!), bz1 = Math.max(qz[0]!, qz[1]!, qz[2]!, qz[3]!)
      let covered = 0
      this.each(bx0, bz0, bx1, bz1, (face, t) => {
        const P = face.geo.attributes.position!, N = face.geo.attributes.normal!, idx = face.geo.getIndex()!
        const a = idx.getX(t * 3), b = idx.getX(t * 3 + 1), c = idx.getX(t * 3 + 2)
        const ax = P.getX(a), ay = P.getY(a), az = P.getZ(a)
        const bx = P.getX(b), by = P.getY(b), bz = P.getZ(b)
        const cx = P.getX(c), cy = P.getY(c), cz = P.getZ(c)
        if (Math.abs((ay + by + cy) / 3 - q.yHint) > DECAL_LAYER) return
        if (Math.max(ax, bx, cx) < bx0 || Math.min(ax, bx, cx) > bx1 || Math.max(az, bz, cz) < bz0 || Math.min(az, bz, cz) > bz1) return
        const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz)
        // a sliver face triangle (under 1e-6 m²) is not drawn to any purpose and the audit does not count it: no decal from it
        if (Math.abs(d) < 2e-6) return
        // clip the triangle against the quad's four edges
        let n = 3
        inX[0] = ax; inZ[0] = az; inX[1] = bx; inZ[1] = bz; inX[2] = cx; inZ[2] = cz
        for (let e = 0; e < 4 && n >= 3; e++) {
          const px = qx[e]!, pz = qz[e]!, ex = qx[(e + 1) % 4]! - px, ez = qz[(e + 1) % 4]! - pz
          let m = 0
          for (let i = 0; i < n; i++) {
            const j = (i + 1) % n
            const si = ex * (inZ[i]! - pz) - ez * (inX[i]! - px)
            const sj = ex * (inZ[j]! - pz) - ez * (inX[j]! - px)
            if (si >= 0) { outX[m] = inX[i]!; outZ[m] = inZ[i]!; m++ }
            if ((si >= 0) !== (sj >= 0)) {
              const f = si / (si - sj)
              outX[m] = inX[i]! + (inX[j]! - inX[i]!) * f
              outZ[m] = inZ[i]! + (inZ[j]! - inZ[i]!) * f
              m++
            }
          }
          n = m
          for (let i = 0; i < n; i++) { inX[i] = outX[i]!; inZ[i] = outZ[i]! }
        }
        if (n < 3) return
        const lift = rungOf(face.kind)
        // the polygon keeps the triangle's winding (faces up); fan it and place every vertex on the
        // triangle's own plane with its interpolated normal
        const vert = (x: number, z: number) => {
          let u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d
          let v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d
          u = Math.min(1, Math.max(0, u)); v = Math.min(1 - u, Math.max(0, v))
          const w = 1 - u - v
          pos.push(x, ay * u + by * v + cy * w + lift, z)
          const nx = N.getX(a) * u + N.getX(b) * v + N.getX(c) * w
          const ny = N.getY(a) * u + N.getY(b) * v + N.getY(c) * w
          const nz = N.getZ(a) * u + N.getZ(b) * v + N.getZ(c) * w
          const nl = Math.hypot(nx, ny, nz) || 1
          nrm.push(nx / nl, ny / nl, nz / nl)
          const at = q.attrs(x, z)
          let o = 0
          for (let k = 0; k < layout.length; k++) { for (let s = 0; s < layout[k]!.size; s++) extra[k]!.push(at[o++]!) }
        }
        for (let k = 1; k < n - 1; k++) {
          const area2 = Math.abs((inX[k]! - inX[0]!) * (inZ[k + 1]! - inZ[0]!) - (inZ[k]! - inZ[0]!) * (inX[k + 1]! - inX[0]!))
          if (area2 < 2e-7) continue
          vert(inX[0]!, inZ[0]!); vert(inX[k]!, inZ[k]!); vert(inX[k + 1]!, inZ[k + 1]!)
          covered += area2 / 2
          stats.triangles++
        }
      })
      const bare = Math.max(0, qArea - covered)
      stats.uncovered += bare
      if (bare > 0.01) {
        stats.bareAt.push([(qx[0]! + qx[1]! + qx[2]! + qx[3]!) / 4, (qz[0]! + qz[1]! + qz[2]! + qz[3]!) / 4, bare])
        if (stats.bareAt.length > 60) { stats.bareAt.sort((p, r) => r[2] - p[2]); stats.bareAt.length = 40 }
      }
    }
    if (!stats.triangles) return { geo: null, stats }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3))
    for (let k = 0; k < layout.length; k++) geo.setAttribute(layout[k]!.name, new THREE.Float32BufferAttribute(extra[k]!, layout[k]!.size))
    return { geo, stats }
  }
}
