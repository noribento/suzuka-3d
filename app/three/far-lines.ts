import * as THREE from 'three'
import type { Ground } from './ground'
import { inBBox, pointInRing, type GridShape, type XZ } from './far-geometry'

/**
 * The polyline and site helpers the far-field builders share — the outskirts (fence, poles,
 * wires, guardrails, solar rows), the roads and their furniture, the forest's rows of trees and
 * the terrain-side ribbons (rail, streams, paddy bunds) all walk an OSM way or ring at a fixed
 * arc-length pitch, ask whether a thing may stand at the sample, and pour flat-shaded quads into
 * one mesh per cell. Pure XZ arithmetic plus the two ground reads the contract allows outside
 * the ground modules (`ground.plan.project`, `ground.builtY` — README 地面の契約 R3); nothing
 * here samples the terrain or adds a ground face.
 *
 *  - `resample` / `nearestArc` / `pathLength` walk a polyline (open or closed) by arc length.
 *  - `inGrid` / `outsideGrid` are the cheap rectangle tests against the terrain grid.
 *  - `siteOk` is the site rule every far-field builder obeys (grid, minD, no drawn face), with
 *    the 1-Lipschitz lower bound that keeps the exact centreline projection rare.
 *  - `KeepOutGrid` hashes `ctx.keepOut` / `ctx.keepOutPolys` into tiles so a placement job can
 *    test thousands of sites against thousands of footprints without a linear scan.
 *  - `TriSink` is the non-indexed quad sink the builders' world-space meshes are poured into.
 */

/** one sample of `resample`: a point on the polyline with its tangent and arc length */
export interface Sample {
  x: number
  z: number
  /** unit tangent */
  tx: number
  tz: number
  /** arc length from the start (m) */
  t: number
  /** distance to the nearer of the two OSM vertices of the edge the sample lies on (the 1-Lipschitz bound's radius) */
  dv: number
}

/** a world XZ rectangle (the terrain grid, the coarse ring — `GridShape` and `CoverRect` both fit) */
export interface Rect {
  x0: number
  z0: number
  w: number
  d: number
}

/**
 * Resample a polyline at `step` metres of arc length (closed: the last edge back to the first
 * vertex is walked too), each sample with its tangent and its distance to the nearer edge vertex.
 */
export function resample(pts: readonly XZ[], step: number, closed: boolean, phase = 0): Sample[] {
  const out: Sample[] = []
  const n = pts.length
  if (n < 2) return out
  const edges = closed ? n : n - 1
  let total = 0
  for (let i = 0; i < edges; i++) {
    const a = pts[i]!, b = pts[(i + 1) % n]!
    total += Math.hypot(b[0] - a[0], b[1] - a[1])
  }
  if (total < step) return out
  // a closed ring is resampled at an integer count so the last post meets the first
  const actual = closed ? total / Math.max(1, Math.round(total / step)) : step
  let next = phase, walked = 0
  for (let i = 0; i < edges; i++) {
    const a = pts[i]!, b = pts[(i + 1) % n]!
    const ex = b[0] - a[0], ez = b[1] - a[1]
    const len = Math.hypot(ex, ez)
    if (len < 1e-6) continue
    const tx = ex / len, tz = ez / len
    while (next <= walked + len + (closed ? -1e-6 : 1e-6) && (!closed || next < total - 1e-6)) {
      const u = (next - walked) / len
      out.push({ x: a[0] + ex * u, z: a[1] + ez * u, tx, tz, t: next, dv: Math.min(u, 1 - u) * len })
      next += actual
    }
    walked += len
  }
  return out
}

/** arc-length position on a polyline nearest to (x, z), and the distance to it */
export function nearestArc(pts: readonly XZ[], closed: boolean, x: number, z: number): { t: number; d: number } {
  const n = pts.length
  const edges = closed ? n : n - 1
  let best = Infinity, bestT = 0, walked = 0
  for (let i = 0; i < edges; i++) {
    const a = pts[i]!, b = pts[(i + 1) % n]!
    const ex = b[0] - a[0], ez = b[1] - a[1]
    const l2 = ex * ex + ez * ez
    const u = l2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / l2)) : 0
    const dx = x - (a[0] + ex * u), dz = z - (a[1] + ez * u)
    const d2 = dx * dx + dz * dz
    if (d2 < best) {
      best = d2
      bestT = walked + Math.sqrt(l2) * u
    }
    walked += Math.sqrt(l2)
  }
  return { t: bestT, d: Math.sqrt(best) }
}

/** total length of a polyline (`closed`: the edge back to the first vertex counts) */
export function pathLength(pts: readonly XZ[], closed: boolean): number {
  let total = 0
  const edges = closed ? pts.length : pts.length - 1
  for (let i = 0; i < edges; i++) {
    const a = pts[i]!, b = pts[(i + 1) % pts.length]!
    total += Math.hypot(b[0] - a[0], b[1] - a[1])
  }
  return total
}

/** inside the rectangle (half-open on the far sides, like the terrain grid's cells) */
export function inGrid(g: Rect, x: number, z: number): boolean {
  return x >= g.x0 && z >= g.z0 && x < g.x0 + g.w && z < g.z0 + g.d
}

/** further than `margin` outside the grid rectangle — the cheap pre-reject, before any decoding */
export function outsideGrid(g: Rect, x: number, z: number, margin: number): boolean {
  return x < g.x0 - margin || z < g.z0 - margin || x > g.x0 + g.w + margin || z > g.z0 + g.d + margin
}

// ---------------------------------------------------------------------------------------------
// the site rule

export interface SiteRule {
  ground: Ground
  grid: GridShape
  /** exact centreline distances taken (for the stats) */
  projections: number
}

/**
 * Whether something may stand at (x, z): inside the terrain grid, ≥ `minD` from the centreline
 * (`lo` is a lower bound of that distance — the feature's `dmin` minus the sample's distance to
 * the feature's nearest vertex, valid because distance to the centreline is 1-Lipschitz — so
 * the projection is only taken when the bound does not settle it) and on no drawn ground face.
 *
 * `ring`, when given, is the coarse ring's rectangle (`ringRect` of environment.ts): a site
 * inside it but outside the grid is accepted too, so a ribbon that leaves the grid — the
 * railway, a stream — continues onto the ring instead of stopping at the grid's edge. Nothing
 * that stands there needs the grid: `standY` reads the ring's own mesh.
 */
export function siteOk(rule: SiteRule, x: number, z: number, lo: number, minD: number, ring?: Rect): boolean {
  if (!inGrid(rule.grid, x, z) && !(ring && inGrid(ring, x, z))) return false
  if (lo < minD) {
    rule.projections++
    if (rule.ground.plan.project(x, z).d < minD) return false
  }
  return !rule.ground.builtY(x, z)
}

// ---------------------------------------------------------------------------------------------
// keep-outs

export interface KeepOutDisc {
  x: number
  z: number
  r: number
}

export interface KeepOutPoly {
  ring: XZ[]
  box: [number, number, number, number]
}

/**
 * `ctx.keepOut` (discs) and `ctx.keepOutPolys` (footprints) hashed into square tiles, so a
 * placement job asks "is this site inside any keep-out?" with one tile lookup instead of a
 * scan over every disc and polygon (≈ 1,500 building footprints + the car parks + the solar
 * farms, against thousands of candidate sites per job). A disc is filed under every tile
 * within its reach, a polygon under every tile its bounding box touches; `hit` then does the
 * exact tests (disc distance, then `inBBox` + `pointInRing`) on that tile's few entries.
 *
 * The builders push into the context's arrays between the deferred jobs (buildings and paving
 * before the forest, README 地面の契約 far field), so a consumer calls `sync` at the top of every
 * job: the grid is rebuilt only when either array has grown, i.e. once per stage boundary
 * rather than once per job. Rows are never removed, so a length change is the whole story.
 */
export class KeepOutGrid {
  private readonly cellM: number
  private readonly tiles = new Map<number, { discs: KeepOutDisc[]; polys: KeepOutPoly[] }>()
  private nDiscs = -1
  private nPolys = -1

  constructor(cellM = 100) {
    this.cellM = cellM
  }

  private key(i: number, j: number): number {
    // tile indices are a few dozen either side of the origin; the offset keeps the key positive and unique
    return (i + 0x8000) * 0x10000 + (j + 0x8000)
  }

  private tile(i: number, j: number): { discs: KeepOutDisc[]; polys: KeepOutPoly[] } {
    const key = this.key(i, j)
    let t = this.tiles.get(key)
    if (!t) this.tiles.set(key, (t = { discs: [], polys: [] }))
    return t
  }

  /** hash the current arrays (replacing whatever was hashed before) */
  rebuild(discs: readonly KeepOutDisc[], polys: readonly KeepOutPoly[]) {
    this.tiles.clear()
    const c = this.cellM
    for (const d of discs) {
      const reach = Math.ceil(d.r / c)
      const i0 = Math.floor(d.x / c), j0 = Math.floor(d.z / c)
      for (let i = i0 - reach; i <= i0 + reach; i++) for (let j = j0 - reach; j <= j0 + reach; j++) this.tile(i, j).discs.push(d)
    }
    for (const p of polys) {
      const i0 = Math.floor(p.box[0] / c), i1 = Math.floor(p.box[2] / c)
      const j0 = Math.floor(p.box[1] / c), j1 = Math.floor(p.box[3] / c)
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) this.tile(i, j).polys.push(p)
    }
    this.nDiscs = discs.length
    this.nPolys = polys.length
  }

  /** `rebuild` only when either array's length changed since the last build */
  sync(discs: readonly KeepOutDisc[], polys: readonly KeepOutPoly[]) {
    if (discs.length !== this.nDiscs || polys.length !== this.nPolys) this.rebuild(discs, polys)
  }

  /** inside a keep-out disc or footprint */
  hit(x: number, z: number): boolean {
    const t = this.tiles.get(this.key(Math.floor(x / this.cellM), Math.floor(z / this.cellM)))
    if (!t) return false
    for (const d of t.discs) if ((x - d.x) * (x - d.x) + (z - d.z) * (z - d.z) < d.r * d.r) return true
    for (const p of t.polys) if (inBBox(x, z, p.box) && pointInRing(x, z, p.ring)) return true
    return false
  }
}

// ---------------------------------------------------------------------------------------------
// geometry sink

/**
 * A non-indexed triangle sink with flat normals: quads given as four corners (any order) and an
 * outward direction, so the winding never has to be worked out by hand.
 */
export class TriSink {
  private readonly pos: number[] = []
  private readonly uv: number[] = []
  get triangles(): number {
    return this.pos.length / 9
  }
  private tri(a: readonly number[], b: readonly number[], c: readonly number[], ua: readonly number[], ub: readonly number[], uc: readonly number[]) {
    this.pos.push(a[0]!, a[1]!, a[2]!, b[0]!, b[1]!, b[2]!, c[0]!, c[1]!, c[2]!)
    this.uv.push(ua[0]!, ua[1]!, ub[0]!, ub[1]!, uc[0]!, uc[1]!)
  }
  /** corners p0 → p1 → p2 → p3 around the quad, `out` the side the face shows; uvs per corner */
  quad(p0: readonly number[], p1: readonly number[], p2: readonly number[], p3: readonly number[], out: readonly number[], uvs: readonly (readonly number[])[]) {
    const ux = p1[0]! - p0[0]!, uy = p1[1]! - p0[1]!, uz = p1[2]! - p0[2]!
    const vx = p2[0]! - p0[0]!, vy = p2[1]! - p0[1]!, vz = p2[2]! - p0[2]!
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const flip = nx * out[0]! + ny * out[1]! + nz * out[2]! < 0
    if (flip) {
      this.tri(p0, p2, p1, uvs[0]!, uvs[2]!, uvs[1]!)
      this.tri(p0, p3, p2, uvs[0]!, uvs[3]!, uvs[2]!)
    } else {
      this.tri(p0, p1, p2, uvs[0]!, uvs[1]!, uvs[2]!)
      this.tri(p0, p2, p3, uvs[0]!, uvs[2]!, uvs[3]!)
    }
  }
  build(): THREE.BufferGeometry | null {
    if (!this.pos.length) return null
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2))
    g.computeVertexNormals()
    g.computeBoundingSphere()
    return g
  }
}
