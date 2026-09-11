import * as THREE from 'three'
import type { Ground } from './ground'
import type { GroundPlan } from './ground-plan'

/**
 * Geometry helpers for the far field (plan §2): polygon tests and the terrain-conforming
 * overlays — `cellClippedPolygon` for a ring (the forest's canopy masses and floor, pools) and
 * `cellClippedStrip` for a rows × samples lattice with linear attributes (the public roads,
 * later the rail bed, the streams and the paddy bunds).
 *
 * Why an overlay is cut per TERRAIN TRIANGLE: an overlay a few centimetres over bare terrain
 * z-fights wherever its facets differ from the terrain's, and the terrain is a regular grid
 * whose every cell is split on the b–c diagonal (environment.ts, the chunk indexer and the
 * mesh interpolation agree on it). Cutting the polygon along exactly those triangles — and
 * subdividing INSIDE them, never across — keeps every overlay vertex on the terrain's own
 * planes, so `ground.standY` (which reads the settled mesh where no face is drawn) lifts the
 * overlay by a constant and nothing fights.
 *
 * Why the drop rule: the ground partition (README 地面の契約 R1, R11) is the one source of
 * opaque ground faces near the track, and its faces reach 95–440 m out at the south course,
 * the kart track and the final-corner loop. An overlay must never be drawn over one of those
 * faces, so every (sub)triangle whose corners, edge midpoints or centroid lie on a drawn face
 * (`ground.builtY !== null`) or inside `minD` of the centreline (`plan.project`) is dropped.
 *
 * None of this samples the terrain directly: heights come from `ground.standY` (R3).
 */

/** a world XZ point */
export type XZ = [number, number]

/** the terrain grid's shape (`Terrain.grid()`): origin, spacing, node counts, extent — no heights */
export interface GridShape {
  x0: number
  z0: number
  dx: number
  dz: number
  nx: number
  nz: number
  w: number
  d: number
}

/** [minX, minZ, maxX, maxZ] of a ring */
export function ringBBox(ring: readonly XZ[]): [number, number, number, number] {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity
  for (const [x, z] of ring) {
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (z < z0) z0 = z
    if (z > z1) z1 = z
  }
  return [x0, z0, x1, z1]
}

/** unsigned shoelace area of a ring (m²) */
export function ringArea(ring: readonly XZ[]): number {
  let a = 0
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i]!, q = ring[(i + 1) % n]!
    a += p[0] * q[1] - q[0] * p[1]
  }
  return Math.abs(a) / 2
}

/** even–odd point-in-polygon on a ring given as [x, z] pairs (no repeated closing vertex needed) */
export function pointInRing(x: number, z: number, ring: readonly XZ[]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i]!
    const [xj, zj] = ring[j]!
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside
  }
  return inside
}

/** true when the [x, z] point is inside the ring's bounding box (a cheap pre-test for `pointInRing`) */
export function inBBox(x: number, z: number, box: readonly [number, number, number, number]): boolean {
  return x >= box[0] && x <= box[2] && z >= box[1] && z <= box[3]
}

/** the interleaved [x, z, x, z, …] stream of en-codec's `worldRing` as [x, z] pairs */
export function ringFromFlat(flat: ArrayLike<number>): XZ[] {
  const out: XZ[] = new Array(flat.length / 2)
  for (let i = 0; i < flat.length; i += 2) out[i / 2] = [flat[i]!, flat[i + 1]!]
  return out
}

/**
 * The ring's principal axis (the covariance of its vertices, weighted by the length of the
 * edges around each so a densely traced side does not pull the axis): centre, unit axis, and
 * the extents of the ring along and across it. The car-park rows and the solar-farm rows lie
 * along this axis; the forest uses it to find a polygon's long edge.
 */
export function principalAxis(ring: readonly XZ[]): { cx: number; cz: number; ax: number; az: number; along: number; across: number } {
  const n = ring.length
  let wsum = 0, cx = 0, cz = 0
  const w = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const p = ring[i]!, q = ring[(i + 1) % n]!, o = ring[(i + n - 1) % n]!
    w[i] = (Math.hypot(q[0] - p[0], q[1] - p[1]) + Math.hypot(p[0] - o[0], p[1] - o[1])) / 2 + 1e-6
    wsum += w[i]!
    cx += p[0] * w[i]!
    cz += p[1] * w[i]!
  }
  cx /= wsum
  cz /= wsum
  let sxx = 0, sxz = 0, szz = 0
  for (let i = 0; i < n; i++) {
    const dx = ring[i]![0] - cx, dz = ring[i]![1] - cz
    sxx += w[i]! * dx * dx
    sxz += w[i]! * dx * dz
    szz += w[i]! * dz * dz
  }
  // the larger eigenvector of the 2×2 covariance
  const theta = 0.5 * Math.atan2(2 * sxz, sxx - szz)
  const ax = Math.cos(theta), az = Math.sin(theta)
  let a0 = Infinity, a1 = -Infinity, c0 = Infinity, c1 = -Infinity
  for (const [x, z] of ring) {
    const dx = x - cx, dz = z - cz
    const a = dx * ax + dz * az
    const c = -dx * az + dz * ax
    if (a < a0) a0 = a
    if (a > a1) a1 = a
    if (c < c0) c0 = c
    if (c > c1) c1 = c
  }
  return { cx, cz, ax, az, along: a1 - a0, across: c1 - c0 }
}

// ---------------------------------------------------------------------------------------------
// segment / polygon primitives

function orient(ax: number, az: number, bx: number, bz: number, cx: number, cz: number): number {
  return (bx - ax) * (cz - az) - (bz - az) * (cx - ax)
}

/** true when segments ab and cd intersect, touching and collinear overlap included (the safe answer for a clipper) */
export function segmentsCross(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): boolean {
  const eps = 1e-9
  const o1 = orient(ax, az, bx, bz, cx, cz)
  const o2 = orient(ax, az, bx, bz, dx, dz)
  const o3 = orient(cx, cz, dx, dz, ax, az)
  const o4 = orient(cx, cz, dx, dz, bx, bz)
  if (((o1 > eps && o2 < -eps) || (o1 < -eps && o2 > eps)) && ((o3 > eps && o4 < -eps) || (o3 < -eps && o4 > eps))) return true
  const on = (px: number, pz: number, qx: number, qz: number, rx: number, rz: number) =>
    Math.min(px, qx) - eps <= rx && rx <= Math.max(px, qx) + eps && Math.min(pz, qz) - eps <= rz && rz <= Math.max(pz, qz) + eps
  if (Math.abs(o1) <= eps && on(ax, az, bx, bz, cx, cz)) return true
  if (Math.abs(o2) <= eps && on(ax, az, bx, bz, dx, dz)) return true
  if (Math.abs(o3) <= eps && on(cx, cz, dx, dz, ax, az)) return true
  if (Math.abs(o4) <= eps && on(cx, cz, dx, dz, bx, bz)) return true
  return false
}

/**
 * Sutherland–Hodgman: the part of `subject` (any simple ring, concave allowed) inside the
 * convex triangle `tri`. A concave subject can come back as one weakly simple polygon whose
 * pieces are joined by zero-width bridges along the triangle's edges; `cleanRing` removes the
 * spikes and earcut copes with the rest.
 */
export function clipToTriangle(subject: readonly XZ[], tri: readonly [XZ, XZ, XZ]): XZ[] {
  const flip = orient(tri[0][0], tri[0][1], tri[1][0], tri[1][1], tri[2][0], tri[2][1]) < 0 ? -1 : 1
  let input: XZ[] = subject as XZ[]
  for (let e = 0; e < 3 && input.length; e++) {
    const [ex, ez] = tri[e]!
    const [fx, fz] = tri[(e + 1) % 3]!
    const out: XZ[] = []
    const side = (p: XZ) => orient(ex, ez, fx, fz, p[0], p[1]) * flip
    let prev = input[input.length - 1]!
    let sPrev = side(prev)
    for (const cur of input) {
      const sCur = side(cur)
      if (sCur >= 0) {
        if (sPrev < 0) out.push(intersect(prev, cur, sPrev, sCur))
        out.push(cur)
      } else if (sPrev >= 0) out.push(intersect(prev, cur, sPrev, sCur))
      prev = cur
      sPrev = sCur
    }
    input = out
  }
  return input
}

function intersect(p: XZ, q: XZ, sp: number, sq: number): XZ {
  const t = sp / (sp - sq)
  return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]
}

/** drop repeated points, straight-through vertices and spikes (a vertex whose two edges are antiparallel) */
export function cleanRing(poly: XZ[]): XZ[] {
  let pts = poly.slice()
  let changed = true
  while (changed && pts.length >= 3) {
    changed = false
    const n = pts.length
    for (let i = 0; i < n; i++) {
      const o = pts[(i + n - 1) % n]!, p = pts[i]!, q = pts[(i + 1) % n]!
      const ux = p[0] - o[0], uz = p[1] - o[1], vx = q[0] - p[0], vz = q[1] - p[1]
      const lu = Math.hypot(ux, uz), lv = Math.hypot(vx, vz)
      if (lv < 1e-6 || lu < 1e-6 || Math.abs(ux * vz - uz * vx) <= 1e-6 * lu * lv) {
        pts.splice(i, 1)
        changed = true
        break
      }
    }
  }
  if (pts.length < 3) pts = []
  return pts
}

// ---------------------------------------------------------------------------------------------
// the terrain-conforming overlay

/**
 * Per-node cache of the drop rule's inputs, shared by every `cellClippedPolygon` of one builder
 * (the forest's jobs all read the same nodes): a LOWER BOUND of the centreline distance at each
 * grid node (`plan.project` is expensive far from the track, and distance to a set is
 * 1-Lipschitz, so a neighbour's value minus the spacing is a valid bound that only has to be
 * refined near `minD`) and the exact distance where it was computed.
 */
export interface NodeCache {
  grid: GridShape
  dLo: Float32Array
  dExact: Float32Array
}

export function makeNodeCache(grid: GridShape): NodeCache {
  const n = (grid.nx + 1) * (grid.nz + 1)
  return { grid, dLo: new Float32Array(n).fill(NaN), dExact: new Float32Array(n).fill(NaN) }
}

/**
 * The per-node reader of a `NodeCache` (shared by `cellClippedPolygon` and `cellClippedStrip`):
 * centreline distance at grid node (i, j). A lower bound is enough when it clears `accept`
 * (minD plus whatever the caller derives from the node — a cell for the polygon's midpoints and
 * centroids, half a diagonal for the strip's corners), so the bound chain from the neighbours
 * already visited (left and above — any order of visiting is valid, a missing neighbour just
 * gives no bound) is refined with an exact projection only where the derived points would
 * otherwise need one each.
 */
function nodeDistance(g: GridShape, cache: NodeCache, plan: GroundPlan, accept: number): (i: number, j: number) => number {
  const NXN = g.nx + 1
  return (i, j) => {
    const idx = j * NXN + i
    const ex = cache.dExact[idx]!
    if (!Number.isNaN(ex)) return ex
    let lo = cache.dLo[idx]!
    if (Number.isNaN(lo)) {
      lo = -Infinity
      if (i > 0) { const v = cache.dLo[idx - 1]!; if (!Number.isNaN(v)) lo = Math.max(lo, v - g.dx) }
      if (j > 0) { const v = cache.dLo[idx - NXN]!; if (!Number.isNaN(v)) lo = Math.max(lo, v - g.dz) }
    }
    if (lo >= accept) {
      cache.dLo[idx] = lo
      return lo
    }
    const d = plan.project(g.x0 + i * g.dx, g.z0 + j * g.dz).d
    cache.dExact[idx] = d
    cache.dLo[idx] = d
    return d
  }
}

/** exact centreline distance at an arbitrary point, memoised at 1/8 m for one call (the points near minD) */
function exactPointMemo(g: GridShape, plan: GroundPlan): (x: number, z: number) => number {
  const exactAt = new Map<number, number>()
  return (x, z) => {
    const k = Math.round((x - g.x0) * 8) * 131072 + Math.round((z - g.z0) * 8)
    let d = exactAt.get(k)
    if (d === undefined) {
      d = plan.project(x, z).d
      exactAt.set(k, d)
    }
    return d
  }
}

export interface CellClipOpts {
  grid: GridShape
  ground: Ground
  plan: GroundPlan
  /** (sub)triangles with any sample closer than this to the centreline are dropped (m) */
  minD: number
  /** 1 = the terrain triangles as they are; 2 = each split into four (midpoints stay on the terrain plane) */
  subdiv: 1 | 2
  /** height of the top over `ground.standY` at (x, z) */
  yOf: (x: number, z: number) => number
  /** a skirt hangs from every boundary edge of the top down to `bottom(x, z)` (world y) */
  skirt?: { bottom: (x: number, z: number) => number }
  /** only terrain cells whose CENTRE lies inside [minX, minZ, maxX, maxZ) are used — the 250 m cell of one far-field job */
  window?: [number, number, number, number]
  /** shared node cache (`makeNodeCache(grid)`); one is made per call when omitted */
  cache?: NodeCache
}

export interface CellClipped {
  /** position / normal / uv (uv = world x, z in metres); null when nothing survived */
  top: THREE.BufferGeometry | null
  /** the skirt quads (position / normal / uv = along, y), null without `opts.skirt` or boundary edges */
  skirt: THREE.BufferGeometry | null
  /** terrain cells that contributed at least one triangle */
  cellsUsed: number
  /** triangles in `top` */
  triangles: number
  /** XZ area of `top` (m²) */
  area: number
  /** (sub)triangles dropped by the minD / builtY rule */
  dropped: number
  /** boundary edges of `top` (the skirt's quads) */
  boundaryEdges: number
}

const EMPTY: CellClipped = { top: null, skirt: null, cellsUsed: 0, triangles: 0, area: 0, dropped: 0, boundaryEdges: 0 }

/**
 * `ring` (world XZ) cut along the terrain's triangles (the b–c diagonal of every grid cell),
 * optionally subdivided inside each, with every (sub)triangle that touches a drawn ground face
 * or comes within `minD` of the centreline dropped, draped at `ground.standY + yOf`, with a
 * skirt from the boundary edges. Triangles are wound to face +Y.
 */
export function cellClippedPolygon(ring: readonly XZ[], opts: CellClipOpts): CellClipped {
  const g = opts.grid
  const { ground, plan, minD, subdiv, yOf } = opts
  if (ring.length < 3) return { ...EMPTY }
  const cache = opts.cache ?? makeNodeCache(g)
  const [bx0, bz0, bx1, bz1] = ringBBox(ring)
  let ci0 = Math.max(0, Math.floor((bx0 - g.x0) / g.dx)), ci1 = Math.min(g.nx - 1, Math.floor((bx1 - g.x0) / g.dx))
  let cj0 = Math.max(0, Math.floor((bz0 - g.z0) / g.dz)), cj1 = Math.min(g.nz - 1, Math.floor((bz1 - g.z0) / g.dz))
  const win = opts.window
  if (win) {
    ci0 = Math.max(ci0, Math.floor((win[0] - g.x0) / g.dx - 0.5))
    ci1 = Math.min(ci1, Math.floor((win[2] - g.x0) / g.dx - 0.5))
    cj0 = Math.max(cj0, Math.floor((win[1] - g.z0) / g.dz - 0.5))
    cj1 = Math.min(cj1, Math.floor((win[3] - g.z0) / g.dz - 0.5))
  }
  if (ci1 < ci0 || cj1 < cj0) return { ...EMPTY }

  // --- ring edges per terrain cell (for the crossing test of a triangle) -----------------------
  const edgeCells = new Map<number, number[]>()
  const nR = ring.length
  for (let k = 0; k < nR; k++) {
    const p = ring[k]!, q = ring[(k + 1) % nR]!
    const ex0 = Math.max(ci0, Math.floor((Math.min(p[0], q[0]) - g.x0) / g.dx)), ex1 = Math.min(ci1, Math.floor((Math.max(p[0], q[0]) - g.x0) / g.dx))
    const ez0 = Math.max(cj0, Math.floor((Math.min(p[1], q[1]) - g.z0) / g.dz)), ez1 = Math.min(cj1, Math.floor((Math.max(p[1], q[1]) - g.z0) / g.dz))
    for (let cj = ez0; cj <= ez1; cj++) for (let ci = ex0; ci <= ex1; ci++) {
      const key = ci + cj * g.nx
      let list = edgeCells.get(key)
      if (!list) edgeCells.set(key, (list = []))
      list.push(k)
    }
  }

  // --- the drop rule's samples --------------------------------------------------------------
  /**
   * Centreline distance at a grid node (cached). A lower bound is enough when it clears minD by
   * a full cell (the midpoints and centroids derived from it subtract up to that much), so the
   * bound chain is refined with an exact call before the derived points would need one each.
   */
  const nodeD = nodeDistance(g, cache, plan, minD + g.dx + g.dz)
  /** exact distance at an arbitrary point, memoised per call (the subdivision midpoints near minD) */
  const pointD = exactPointMemo(g, plan)
  const qkey = (x: number, z: number) => Math.round((x - g.x0) * 8) * 131072 + Math.round((z - g.z0) * 8)
  const insideAt = new Map<number, boolean>()
  const inside = (x: number, z: number): boolean => {
    const k = qkey(x, z)
    let v = insideAt.get(k)
    if (v === undefined) {
      v = pointInRing(x, z, ring)
      insideAt.set(k, v)
    }
    return v
  }

  // --- output pools -------------------------------------------------------------------------
  const pool = new Map<number, number>()
  const px: number[] = [], py: number[] = [], pz: number[] = []
  const vkey = (x: number, z: number) => Math.round((x - g.x0) * 1000) * 4194304 + Math.round((z - g.z0) * 1000)
  const vertex = (x: number, z: number): number => {
    const k = vkey(x, z)
    let i = pool.get(k)
    if (i === undefined) {
      i = px.length
      pool.set(k, i)
      px.push(x)
      pz.push(z)
      py.push(ground.standY(x, z) + yOf(x, z))
    }
    return i
  }
  const index: number[] = []
  /** edge key → { count, a, b, c }: boundary edges are used once; c is the third vertex (for the skirt's outward side) */
  const edges = new Map<number, { count: number; a: number; b: number; c: number }>()
  let area = 0, dropped = 0
  const usedCells = new Set<number>()

  const emit = (x0: number, z0: number, x1: number, z1: number, x2: number, z2: number, cell: number) => {
    let cross = (x1 - x0) * (z2 - z0) - (z1 - z0) * (x2 - x0)
    if (Math.abs(cross) < 1e-4) return
    if (cross > 0) {
      // wind to face +Y
      const tx = x1, tz = z1
      x1 = x2; z1 = z2; x2 = tx; z2 = tz
      cross = -cross
    }
    const a = vertex(x0, z0), b = vertex(x1, z1), c = vertex(x2, z2)
    if (a === b || b === c || a === c) return
    index.push(a, b, c)
    area += -cross / 2
    usedCells.add(cell)
    for (const [u, v, w] of [[a, b, c], [b, c, a], [c, a, b]] as const) {
      const k = Math.min(u, v) * 67108864 + Math.max(u, v)
      const e = edges.get(k)
      if (e) e.count++
      else edges.set(k, { count: 1, a: u, b: v, c: w })
    }
  }

  /** the drop rule at one sample */
  const okAt = (x: number, z: number, dLo: number): boolean => {
    if (dLo < minD && pointD(x, z) < minD) return false
    return !ground.builtY(x, z)
  }

  /** one (sub)triangle: classify against the ring, clip when it straddles the boundary */
  const handle = (t: [XZ, XZ, XZ], dCorner: [number, number, number], cell: number) => {
    // the drop rule: corners, edge midpoints and the centroid
    for (let k = 0; k < 3; k++) if (dCorner[k]! < minD || ground.builtY(t[k]![0], t[k]![1])) { dropped++; return }
    for (let k = 0; k < 3; k++) {
      const p = t[k]!, q = t[(k + 1) % 3]!
      const mx = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2
      const lo = Math.min(dCorner[k]!, dCorner[(k + 1) % 3]!) - Math.hypot(q[0] - p[0], q[1] - p[1]) / 2
      if (!okAt(mx, mz, lo)) { dropped++; return }
    }
    const cx = (t[0][0] + t[1][0] + t[2][0]) / 3, cz = (t[0][1] + t[1][1] + t[2][1]) / 3
    if (!okAt(cx, cz, Math.min(dCorner[0], dCorner[1], dCorner[2]) - g.dx)) { dropped++; return }
    // classify
    const list = edgeCells.get(cell)
    let crossing = false
    if (list) {
      outer: for (const k of list) {
        const p = ring[k]!, q = ring[(k + 1) % nR]!
        for (let e = 0; e < 3; e++) {
          const u = t[e]!, v = t[(e + 1) % 3]!
          if (segmentsCross(u[0], u[1], v[0], v[1], p[0], p[1], q[0], q[1])) { crossing = true; break outer }
        }
      }
    }
    if (!crossing) {
      const n = (inside(t[0][0], t[0][1]) ? 1 : 0) + (inside(t[1][0], t[1][1]) ? 1 : 0) + (inside(t[2][0], t[2][1]) ? 1 : 0)
      if (n === 3) emit(t[0][0], t[0][1], t[1][0], t[1][1], t[2][0], t[2][1], cell)
      // n === 0: outside (a ring smaller than a triangle and wholly inside one cannot happen at SUR_MIN_AREA)
      return
    }
    const poly = cleanRing(clipToTriangle(ring, t))
    if (poly.length < 3) return
    let faces: number[][]
    try {
      faces = THREE.ShapeUtils.triangulateShape(poly.map(([x, z]) => new THREE.Vector2(x, z)), [])
    } catch {
      faces = []
    }
    for (const f of faces) {
      const a = poly[f[0]!]!, b = poly[f[1]!]!, c = poly[f[2]!]!
      emit(a[0], a[1], b[0], b[1], c[0], c[1], cell)
    }
  }

  // --- sweep the terrain cells --------------------------------------------------------------
  const tri: [XZ, XZ, XZ] = [[0, 0], [0, 0], [0, 0]]
  const sub: [XZ, XZ, XZ] = [[0, 0], [0, 0], [0, 0]]
  const dC: [number, number, number] = [0, 0, 0]
  for (let cj = cj0; cj <= cj1; cj++) {
    for (let ci = ci0; ci <= ci1; ci++) {
      const cell = ci + cj * g.nx
      const x0 = g.x0 + ci * g.dx, z0 = g.z0 + cj * g.dz, x1 = x0 + g.dx, z1 = z0 + g.dz
      // the cell must overlap the ring's bbox
      if (x1 < bx0 || x0 > bx1 || z1 < bz0 || z0 > bz1) continue
      // nodes a (i, j), b (i+1, j), c (i, j+1), e (i+1, j+1) — the b–c diagonal
      const dA = nodeD(ci, cj), dB = nodeD(ci + 1, cj), dCn = nodeD(ci, cj + 1), dE = nodeD(ci + 1, cj + 1)
      for (let half = 0; half < 2; half++) {
        if (half === 0) {
          tri[0][0] = x0; tri[0][1] = z0; tri[1][0] = x1; tri[1][1] = z0; tri[2][0] = x0; tri[2][1] = z1
          dC[0] = dA; dC[1] = dB; dC[2] = dCn
        } else {
          tri[0][0] = x1; tri[0][1] = z0; tri[1][0] = x0; tri[1][1] = z1; tri[2][0] = x1; tri[2][1] = z1
          dC[0] = dB; dC[1] = dCn; dC[2] = dE
        }
        // a whole triangle on a drawn face is dropped before any subdivision
        if (subdiv === 1) {
          handle([[tri[0][0], tri[0][1]], [tri[1][0], tri[1][1]], [tri[2][0], tri[2][1]]], [dC[0], dC[1], dC[2]], cell)
          continue
        }
        // four sub-triangles on the same plane; midpoint distances are exact only near minD
        const m01: XZ = [(tri[0][0] + tri[1][0]) / 2, (tri[0][1] + tri[1][1]) / 2]
        const m12: XZ = [(tri[1][0] + tri[2][0]) / 2, (tri[1][1] + tri[2][1]) / 2]
        const m20: XZ = [(tri[2][0] + tri[0][0]) / 2, (tri[2][1] + tri[0][1]) / 2]
        const midD = (m: XZ, u: number, v: number, a: XZ, b: XZ): number => {
          const lo = Math.min(u, v) - Math.hypot(b[0] - a[0], b[1] - a[1]) / 2
          return lo >= minD ? lo : pointD(m[0], m[1])
        }
        const d01 = midD(m01, dC[0], dC[1], tri[0], tri[1])
        const d12 = midD(m12, dC[1], dC[2], tri[1], tri[2])
        const d20 = midD(m20, dC[2], dC[0], tri[2], tri[0])
        const quads: [XZ, XZ, XZ, number, number, number][] = [
          [tri[0], m01, m20, dC[0], d01, d20],
          [m01, tri[1], m12, d01, dC[1], d12],
          [m20, m12, tri[2], d20, d12, dC[2]],
          [m01, m12, m20, d01, d12, d20],
        ]
        for (const [p, q, r, dp, dq, dr] of quads) {
          sub[0] = [p[0], p[1]]; sub[1] = [q[0], q[1]]; sub[2] = [r[0], r[1]]
          handle([sub[0], sub[1], sub[2]], [dp, dq, dr], cell)
        }
      }
    }
  }
  if (!index.length) return { ...EMPTY, dropped }

  // --- geometries ---------------------------------------------------------------------------
  const n = px.length
  const pos = new Float32Array(n * 3)
  const uv = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    pos[i * 3] = px[i]!
    pos[i * 3 + 1] = py[i]!
    pos[i * 3 + 2] = pz[i]!
    uv[i * 2] = px[i]!
    uv[i * 2 + 1] = pz[i]!
  }
  const top = new THREE.BufferGeometry()
  top.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  top.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  top.setIndex(index)
  top.computeVertexNormals()
  top.computeBoundingSphere()

  let skirt: THREE.BufferGeometry | null = null
  let boundaryEdges = 0
  for (const e of edges.values()) if (e.count === 1) boundaryEdges++
  if (opts.skirt && boundaryEdges) {
    const sp = new Float32Array(boundaryEdges * 4 * 3)
    const suv = new Float32Array(boundaryEdges * 4 * 2)
    const sidx: number[] = []
    // the bottom once per pooled vertex (a boundary vertex is shared by two skirt quads)
    const bottomOf = new Map<number, number>()
    const bottom = (i: number): number => {
      let y = bottomOf.get(i)
      if (y === undefined) {
        y = Math.min(py[i]! - 0.05, opts.skirt!.bottom(px[i]!, pz[i]!))
        bottomOf.set(i, y)
      }
      return y
    }
    let k = 0
    for (const e of edges.values()) {
      if (e.count !== 1) continue
      const ax = px[e.a]!, az = pz[e.a]!, bx = px[e.b]!, bz = pz[e.b]!, cx = px[e.c]!, cz = pz[e.c]!
      const ayT = py[e.a]!, byT = py[e.b]!
      const ayB = bottom(e.a), byB = bottom(e.b)
      // outward = the side of edge ab away from c
      const ex = bx - ax, ez = bz - az
      let ox = ez, oz = -ex
      if (ox * (cx - ax) + oz * (cz - az) > 0) { ox = -ox; oz = -oz }
      const len = Math.hypot(ex, ez) || 1
      const ux = ex / len, uz = ez / len
      const ua = ax * ux + az * uz, ub = bx * ux + bz * uz
      const base = k * 4
      const put = (i: number, x: number, y: number, z: number, u: number) => {
        sp[(base + i) * 3] = x; sp[(base + i) * 3 + 1] = y; sp[(base + i) * 3 + 2] = z
        suv[(base + i) * 2] = u; suv[(base + i) * 2 + 1] = y
      }
      put(0, ax, ayT, az, ua)
      put(1, bx, byT, bz, ub)
      put(2, bx, byB, bz, ub)
      put(3, ax, ayB, az, ua)
      // normal of (aT → aB → bB): v1 = (0, dy, 0), v2 = (ex, byB−ayT, ez); v1 × v2 = (dy·ez, 0, −dy·ex) — flip when it points inward
      const dy = ayB - ayT
      const nx = dy * ez, nz = -dy * ex
      const outwardFirst = nx * ox + nz * oz > 0
      if (outwardFirst) sidx.push(base, base + 3, base + 2, base, base + 2, base + 1)
      else sidx.push(base, base + 2, base + 3, base, base + 1, base + 2)
      k++
    }
    skirt = new THREE.BufferGeometry()
    skirt.setAttribute('position', new THREE.BufferAttribute(sp, 3))
    skirt.setAttribute('uv', new THREE.BufferAttribute(suv, 2))
    skirt.setIndex(sidx)
    skirt.computeVertexNormals()
    skirt.computeBoundingSphere()
  }
  return { top, skirt, cellsUsed: usedCells.size, triangles: index.length / 3, area, dropped, boundaryEdges }
}

// ---------------------------------------------------------------------------------------------
// the terrain-conforming strip

/**
 * One extra vertex attribute of a `StripSink` (`{ name: 'aRoad', size: 4 }`); the strip
 * interpolates it bilinearly inside every quad, so an integer-valued channel is kept from
 * interpolating by `StripInput.poolKey`, not by the layout.
 */
export interface StripAttr {
  name: string
  size: number
}

/**
 * Output sink of `cellClippedStrip`: position + uv (= world x, z) + the extra attributes,
 * indexed, with vertices pooled at 1 mm per (piece, pool key) so the clipped pieces of
 * neighbouring quads and cells share their boundary vertices — the mesh is watertight and
 * `computeVertexNormals` gives one normal per vertex. `begin` opens a new pool: vertices of
 * different pieces / ways never merge, so two ribbons that cross at a junction keep their own
 * attributes instead of borrowing the first one's `across`. A rigid vertex (a bridge deck)
 * never pools with a draped one at the same XZ either — the deck's end is its own boundary,
 * and the caller makes the two heights meet at the transition sample.
 */
export class StripSink {
  readonly attrs: readonly StripAttr[]
  /** floats per vertex across the extra attributes */
  readonly stride: number
  private readonly pos: number[] = []
  private readonly extra: number[] = []
  private readonly index: number[] = []
  private pool = new Map<number, Map<number, number>>()
  private piece = 0

  constructor(attrs: readonly StripAttr[]) {
    this.attrs = attrs
    this.stride = attrs.reduce((s, a) => s + a.size, 0)
  }

  /** start a new vertex pool (vertices of different pieces / ways never merge) */
  begin(pieceKey: number) {
    this.piece = pieceKey
    this.pool = new Map()
  }

  /** the key of the piece pouring now (`begin`) */
  get pieceKey(): number {
    return this.piece
  }

  get triangles(): number {
    return this.index.length / 3
  }

  get vertices(): number {
    return this.pos.length / 3
  }

  /** the pooled index of (x, y, z) under `key`; `a` (length ≥ stride) is read only for a new vertex */
  vertex(key: number, x: number, y: number, z: number, a: ArrayLike<number>): number {
    let sub = this.pool.get(key)
    if (!sub) this.pool.set(key, (sub = new Map()))
    // 1 mm cells; the offset keeps the key positive and unique for any world coordinate under ±33 km
    const k = (Math.round(x * 1000) + 33554432) * 67108864 + (Math.round(z * 1000) + 33554432)
    let i = sub.get(k)
    if (i === undefined) {
      i = this.pos.length / 3
      sub.set(k, i)
      this.pos.push(x, y, z)
      for (let m = 0; m < this.stride; m++) this.extra.push(a[m]!)
    }
    return i
  }

  /** one triangle by pooled indices; a degenerate one (two indices equal) is dropped — true when kept */
  triangle(a: number, b: number, c: number): boolean {
    if (a === b || b === c || a === c) return false
    this.index.push(a, b, c)
    return true
  }

  /** Float32 position / uv / attrs, Uint32 index, vertex normals and bounding sphere; null when nothing was poured */
  build(): THREE.BufferGeometry | null {
    if (!this.index.length) return null
    const n = this.pos.length / 3
    const pos = new Float32Array(this.pos)
    const uv = new Float32Array(n * 2)
    for (let i = 0; i < n; i++) {
      uv[i * 2] = pos[i * 3]!
      uv[i * 2 + 1] = pos[i * 3 + 2]!
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    let off = 0
    for (const a of this.attrs) {
      const arr = new Float32Array(n * a.size)
      for (let i = 0; i < n; i++) for (let m = 0; m < a.size; m++) arr[i * a.size + m] = this.extra[i * this.stride + off + m]!
      geo.setAttribute(a.name, new THREE.BufferAttribute(arr, a.size))
      off += a.size
    }
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(this.index), 1))
    geo.computeVertexNormals()
    geo.computeBoundingSphere()
    return geo
  }
}

export interface StripInput {
  /** rows[r][i] = world XZ of row r at sample i; all rows the same length n ≥ 2 (r increases from right to left of travel, or any consistent order) */
  rows: readonly (readonly XZ[])[]
  /** lift over the drape height at (row, i), interpolated bilinearly inside a quad (m) */
  lift: (row: number, i: number) => number
  /** absolute y at (row, i) for rigid pieces (bridges); return NaN to drape */
  rigidY?: (row: number, i: number) => number
  /** write the corner's attribute values into out (length = Σ sizes) — interpolated bilinearly inside the quad */
  attr: (row: number, i: number, out: Float32Array) => void
  /** false skips the quads between samples i and i + 1 */
  okAt?: (i: number) => boolean
  /**
   * integer key of sample i; the vertices of quad i are pooled under key(i), so a change of key
   * between i and i + 1 duplicates the shared boundary vertices (integer attributes never
   * interpolate across it)
   */
  poolKey?: (i: number) => number
  /**
   * lower bound of the centreline distance at sample i (Infinity = far away) — at the strip's
   * reference point there, which has to lie between the outer rows (the road's centreline
   * sample); the strip subtracts the cross-section's diameter at the sample, so the drop rule
   * projects exactly only when this bound is below minD + the row offsets
   */
  dLo?: (i: number) => number
}

export interface CellClipStripOpts {
  grid: GridShape
  /**
   * 'mesh': y = ground.standY(x, z) — the inner grid (settled mesh); 'nodes': y from the terrain
   * triangle's three node heights (`nodeY`) — the coarse ring, whose standY is bilinear while
   * its mesh draws the b–c diagonal
   */
  drape: 'mesh' | 'nodes'
  /** node heights for `drape: 'nodes'` (default: `ground.standY` at the node, which is exact on both grids) */
  nodeY?: (i: number, j: number) => number
  ground: Ground
  plan: GroundPlan
  /** quads with any corner or the centroid closer than this to the centreline, or on a drawn face (ground.builtY), are dropped */
  minD: number
  /** only terrain cells whose centre lies inside this [minX, minZ, maxX, maxZ) rectangle are used (one block's job); a rigid quad goes by its centroid */
  window?: [number, number, number, number]
  /** cells whose centre lies inside this rectangle are skipped (the ring jobs exclude the inner rectangle); a rigid quad goes by its centroid */
  hole?: [number, number, number, number]
  /** shared node cache (`makeNodeCache(grid)`); one is made per call when omitted */
  cache?: NodeCache
}

export interface CellClipStripStats {
  /** quads that produced geometry (rigid or draped) */
  quads: number
  /** triangles poured into the sink by this call */
  triangles: number
  /** quads dropped by the minD / builtY rule */
  dropped: number
  /** quads skipped as folded (an inner-bend crossover) or degenerate */
  folded: number
}

/**
 * Inverse bilinear map of (px, pz) in the quad a (u 0, v 0) → b (1, 0) → c (1, 1) → d (0, 1)
 * (Inigo Quilez's `invBilinear`): the quadratic in v solved in the cancellation-free form (every
 * road quad is nearly a parallelogram, where the textbook form loses digits), the root with
 * (u, v) inside the quad kept, u recovered by least squares from both components (a quad
 * aligned with either axis has one zero component). Corners come back as exactly 0 / 1; the
 * result is clamped to [0, 1] (a clipped vertex lies on or inside its quad up to rounding).
 */
function invBilinear(px: number, pz: number, a: XZ, b: XZ, c: XZ, d: XZ, out: [number, number]): void {
  if (px === a[0] && pz === a[1]) { out[0] = 0; out[1] = 0; return }
  if (px === b[0] && pz === b[1]) { out[0] = 1; out[1] = 0; return }
  if (px === c[0] && pz === c[1]) { out[0] = 1; out[1] = 1; return }
  if (px === d[0] && pz === d[1]) { out[0] = 0; out[1] = 1; return }
  const ex = b[0] - a[0], ez = b[1] - a[1]
  const fx = d[0] - a[0], fz = d[1] - a[1]
  const gx = a[0] - b[0] + c[0] - d[0], gz = a[1] - b[1] + c[1] - d[1]
  const hx = px - a[0], hz = pz - a[1]
  const k2 = gx * fz - gz * fx
  const k1 = ex * fz - ez * fx + (hx * gz - hz * gx)
  const k0 = hx * ez - hz * ex
  // p − a − f v = u (e + g v)
  const uOf = (v: number): number => {
    const rx = hx - fx * v, rz = hz - fz * v
    const sx = ex + gx * v, sz = ez + gz * v
    const l2 = sx * sx + sz * sz
    return l2 > 0 ? (rx * sx + rz * sz) / l2 : 0
  }
  let u: number, v: number
  if (Math.abs(k2) <= 1e-12 * (Math.abs(k1) + Math.abs(k0))) {
    // a parallelogram: linear in v
    v = k1 !== 0 ? -k0 / k1 : 0
    u = uOf(v)
  } else {
    const w = Math.sqrt(Math.max(0, k1 * k1 - 4 * k0 * k2))
    const q = -0.5 * (k1 + (k1 >= 0 ? w : -w))
    v = q / k2
    u = uOf(v)
    if (u < -1e-6 || u > 1 + 1e-6 || v < -1e-6 || v > 1 + 1e-6) {
      // the other root, kept when it is the one (closer to) inside
      const v2 = q !== 0 ? k0 / q : 0
      const u2 = uOf(v2)
      const miss = (x: number, y: number) => Math.max(0, -x, x - 1) + Math.max(0, -y, y - 1)
      if (miss(u2, v2) < miss(u, v)) { u = u2; v = v2 }
    }
  }
  out[0] = u < 0 ? 0 : u > 1 ? 1 : u
  out[1] = v < 0 ? 0 : v > 1 ? 1 : v
}

/**
 * A rows × samples lattice of quads cut along the terrain's triangles and draped on them, with
 * attributes that stay linear along and across the strip — the public roads, and later the
 * rail bed, the streams and the paddy bunds.
 *
 * Why per QUAD and not one ring through `cellClippedPolygon`: that overlay earcuts the clipped
 * piece of the whole ribbon inside each terrain triangle, and a 7 m ribbon crossing a 13 m cell
 * on a bend comes out as long skewed triangles joining a left-edge vertex at s₁ to a right-edge
 * vertex at s₂; a per-vertex `across` interpolated over those wanders by ≈ Rθ²/8 (0.2–0.4 m on
 * R 50–100 m) and the painted centre line wobbles. A plain quad strip on `standY` has the
 * opposite flaw: its straight edges chord across the terrain's creases (13 m cells; the sag
 * reaches 5 cm on the hills, the size of the lift) and the ground pokes through. So every quad
 * (convex, ≤ 12 × 3.5 m) is clipped against each terrain triangle it overlaps, the convex
 * pieces are fanned, and every cut vertex takes the INVERSE BILINEAR (u, v) of its quad —
 * attributes and lift are exact at the corners and linear inside a quad, and every vertex lies
 * on its terrain triangle, so the constant lift never z-fights (the forest floor's argument).
 *
 * Why `drape: 'nodes'` on the ring: `ground.standY` outside the inner grid reads the ring's
 * height BILINEARLY (environment.ts `ringHeightAt`) while terrain-far.ts meshes the ring on the
 * b–c diagonal like the inner grid; the twist term of a 53–71 m cell floats or sinks a
 * `standY`-draped vertex by decimetres in the hills. The ring jobs therefore hand in the node
 * heights and the strip interpolates barycentrically on the triangle it just clipped to.
 *
 * The drop rule (corners and centroid: inside `minD` of the centreline, or on a drawn ground
 * face) keeps the strip off the partition's faces and out of surface-check's 75 m band; its
 * exact projections are rare thanks to `StripInput.dLo` and the shared `NodeCache`. Rigid
 * quads (`rigidY` finite at all four corners — a bridge deck) are emitted as two triangles at
 * those heights without clipping. Triangles face +Y; uv = world (x, z); vertices pool in `sink`
 * under (`poolKey(i)`, rigid, 1 mm XZ).
 */
export function cellClippedStrip(sink: StripSink, input: StripInput, opts: CellClipStripOpts): CellClipStripStats {
  const g = opts.grid
  const { ground, plan, minD } = opts
  const rows = input.rows
  const nRows = rows.length
  const n = nRows ? rows[0]!.length : 0
  const stats: CellClipStripStats = { quads: 0, triangles: 0, dropped: 0, folded: 0 }
  if (nRows < 2 || n < 2) return stats
  const stride = sink.stride
  const cache = opts.cache ?? makeNodeCache(g)
  const halfDiag = Math.hypot(g.dx, g.dz) / 2
  // a node bound is enough when it clears minD by half a diagonal (the farthest a point of the cell is from its nearest node)
  const nodeD = nodeDistance(g, cache, plan, minD + halfDiag)
  const pointD = exactPointMemo(g, plan)
  const win = opts.window, hole = opts.hole
  const centreIn = (rect: readonly [number, number, number, number], x: number, z: number) => x >= rect[0] && x < rect[2] && z >= rect[1] && z < rect[3]

  // --- per-corner inputs, evaluated once (a corner belongs to up to four quads) ---------------
  const A = new Float32Array(nRows * n * stride)
  const tmp = new Float32Array(stride)
  const L = new Float64Array(nRows * n)
  const RY = new Float64Array(nRows * n).fill(NaN)
  for (let r = 0; r < nRows; r++) {
    for (let i = 0; i < n; i++) {
      const k = r * n + i
      input.attr(r, i, tmp)
      A.set(tmp, k * stride)
      L[k] = input.lift(r, i)
      if (input.rigidY) RY[k] = input.rigidY(r, i)
    }
  }
  /** the cross-section's diameter per sample: the row offsets the sample bound gives up (distance to the centreline is 1-Lipschitz) */
  const diam = new Float64Array(n)
  if (input.dLo) {
    for (let i = 0; i < n; i++) {
      let dm = 0
      for (let r = 0; r < nRows; r++) {
        const p = rows[r]![i]!
        for (let s = r + 1; s < nRows; s++) {
          const o = rows[s]![i]!
          dm = Math.max(dm, Math.hypot(o[0] - p[0], o[1] - p[1]))
        }
      }
      diam[i] = dm
    }
  }
  const boundAt = (i: number): number => (input.dLo ? input.dLo(i) - diam[i]! : -Infinity)

  // --- the drop rule at one point --------------------------------------------------------------
  /** `lo` is a lower bound of the centreline distance; the node cache is the second level, the exact projection the last */
  const pointOk = (x: number, z: number, lo: number): boolean => {
    if (minD > 0 && lo < minD) {
      let nb = -Infinity
      const fi = (x - g.x0) / g.dx, fj = (z - g.z0) / g.dz
      if (fi >= 0 && fj >= 0 && fi <= g.nx && fj <= g.nz) {
        const ci = Math.min(g.nx - 1, Math.floor(fi)), cj = Math.min(g.nz - 1, Math.floor(fj))
        nb = Math.min(nodeD(ci, cj), nodeD(ci + 1, cj), nodeD(ci, cj + 1), nodeD(ci + 1, cj + 1)) - halfDiag
      }
      if (nb < minD && pointD(x, z) < minD) return false
    }
    return !ground.builtY(x, z)
  }

  // --- node heights for the 'nodes' drape, memoised per call -----------------------------------
  const nodeYs = new Map<number, number>()
  const nodeY = (i: number, j: number): number => {
    const k = j * (g.nx + 1) + i
    let y = nodeYs.get(k)
    if (y === undefined) {
      y = opts.nodeY ? opts.nodeY(i, j) : ground.standY(g.x0 + i * g.dx, g.z0 + j * g.dz)
      nodeYs.set(k, y)
    }
    return y
  }

  // --- the quad being poured (module-level closures, no allocation per quad) -------------------
  let qa: XZ = [0, 0], qb: XZ = qa, qc: XZ = qa, qd: XZ = qa
  let o00 = 0, o10 = 0, o11 = 0, o01 = 0, k00 = 0, k10 = 0, k11 = 0, k01 = 0
  let ry00 = NaN, ry10 = NaN, ry11 = NaN, ry01 = NaN
  let poolKey = 0, poured = 0
  const uvT: [number, number] = [0, 0]
  const attrOut = new Float32Array(stride)
  /** the terrain triangle's plane for the 'nodes' drape: y = tya + (x − tax) … via the inverse of its edge matrix */
  let tax = 0, taz = 0, tux = 0, tuz = 0, tvx = 0, tvz = 0, tdet = 1, tya = 0, tyb = 0, tyc = 0
  type Drape = 0 | 1 | 2
  /** 0 = rigid (bilinear deck height), 1 = mesh (standY + lift), 2 = nodes (the triangle's plane + lift) */
  let drape: Drape = 1
  /** attributes at (u, v) into attrOut; the lift there */
  const mixAt = (u: number, v: number): number => {
    const w00 = (1 - u) * (1 - v), w10 = u * (1 - v), w11 = u * v, w01 = (1 - u) * v
    for (let m = 0; m < stride; m++) attrOut[m] = w00 * A[o00 + m]! + w10 * A[o10 + m]! + w11 * A[o11 + m]! + w01 * A[o01 + m]!
    return w00 * L[k00]! + w10 * L[k10]! + w11 * L[k11]! + w01 * L[k01]!
  }
  const vtx = (x: number, z: number): number => {
    invBilinear(x, z, qa, qb, qc, qd, uvT)
    const u = uvT[0], v = uvT[1]
    const lift = mixAt(u, v)
    let y: number
    if (drape === 0) y = (1 - u) * (1 - v) * ry00 + u * (1 - v) * ry10 + u * v * ry11 + (1 - u) * v * ry01
    else if (drape === 1) y = ground.standY(x, z) + lift
    else {
      const px = x - tax, pz = z - taz
      const wb = (px * tvz - pz * tvx) / tdet, wc = (tux * pz - tuz * px) / tdet
      y = tya + wb * (tyb - tya) + wc * (tyc - tya) + lift
    }
    return sink.vertex(poolKey, x, y, z, attrOut)
  }
  /**
   * One triangle by XZ corners, wound to face +Y (the `emit` convention of cellClippedPolygon).
   * Only sub-millimetre slivers are dropped (the pool merges anything finer anyway): a quad
   * corner passing a centimetre from a grid node leaves a centimetre sliver in the node's
   * wedge, and dropping that — cellClippedPolygon's 1e-4 m² — would leave a pin-hole in a road.
   */
  const tri = (x0: number, z0: number, x1: number, z1: number, x2: number, z2: number) => {
    const cross = (x1 - x0) * (z2 - z0) - (z1 - z0) * (x2 - x0)
    if (Math.abs(cross) < 1e-6) return
    if (cross > 0) {
      const tx = x1, tz = z1
      x1 = x2; z1 = z2; x2 = tx; z2 = tz
    }
    if (sink.triangle(vtx(x0, z0), vtx(x1, z1), vtx(x2, z2))) poured++
  }

  const quad: XZ[] = [qa, qa, qa, qa]
  const triXZ: [XZ, XZ, XZ] = [[0, 0], [0, 0], [0, 0]]
  const eps = 1e-6
  for (let r = 0; r < nRows - 1; r++) {
    for (let i = 0; i < n - 1; i++) {
      if (input.okAt && input.okAt(i) === false) continue
      const a = rows[r]![i]!, b = rows[r]![i + 1]!, c = rows[r + 1]![i + 1]!, d = rows[r + 1]![i]!
      // convex and not folded: the four corner turns share a sign (a collinear corner is allowed), area ≥ 1e-4 m²
      const t0 = orient(a[0], a[1], b[0], b[1], c[0], c[1]), t1 = orient(b[0], b[1], c[0], c[1], d[0], d[1])
      const t2 = orient(c[0], c[1], d[0], d[1], a[0], a[1]), t3 = orient(d[0], d[1], a[0], a[1], b[0], b[1])
      const pos = t0 > eps || t1 > eps || t2 > eps || t3 > eps, neg = t0 < -eps || t1 < -eps || t2 < -eps || t3 < -eps
      if (Math.abs(t0 + t2) / 2 < 1e-4 || (pos && neg)) { stats.folded++; continue }

      // the drop rule: corners and the centroid, exact only where the sample bounds leave it open
      const cx = (a[0] + b[0] + c[0] + d[0]) / 4, cz = (a[1] + b[1] + c[1] + d[1]) / 4
      const bi = boundAt(i), bj = boundAt(i + 1)
      const bc = Math.max(bi - Math.hypot(cx - a[0], cz - a[1]), bj - Math.hypot(cx - b[0], cz - b[1]), bj - Math.hypot(cx - c[0], cz - c[1]), bi - Math.hypot(cx - d[0], cz - d[1]))
      if (!pointOk(a[0], a[1], bi) || !pointOk(b[0], b[1], bj) || !pointOk(c[0], c[1], bj) || !pointOk(d[0], d[1], bi) || !pointOk(cx, cz, bc)) {
        stats.dropped++
        continue
      }

      qa = a; qb = b; qc = c; qd = d
      quad[0] = a; quad[1] = b; quad[2] = c; quad[3] = d
      k00 = r * n + i; k10 = k00 + 1; k01 = k00 + n; k11 = k01 + 1
      o00 = k00 * stride; o10 = k10 * stride; o11 = k11 * stride; o01 = k01 * stride
      const key = (input.poolKey ? input.poolKey(i) : 0) * 2
      poured = 0

      // --- rigid: the two triangles at the given heights, no clipping ------------------------------
      ry00 = RY[k00]!; ry10 = RY[k10]!; ry11 = RY[k11]!; ry01 = RY[k01]!
      if (Number.isFinite(ry00) && Number.isFinite(ry10) && Number.isFinite(ry11) && Number.isFinite(ry01)) {
        if (win && !centreIn(win, cx, cz)) continue
        if (hole && centreIn(hole, cx, cz)) continue
        drape = 0
        poolKey = key + 1
        tri(a[0], a[1], b[0], b[1], c[0], c[1])
        tri(a[0], a[1], c[0], c[1], d[0], d[1])
        if (poured) { stats.quads++; stats.triangles += poured }
        continue
      }

      // --- draped: clip against every terrain triangle the quad's bbox overlaps ---------------------
      const bx0 = Math.min(a[0], b[0], c[0], d[0]), bx1 = Math.max(a[0], b[0], c[0], d[0])
      const bz0 = Math.min(a[1], b[1], c[1], d[1]), bz1 = Math.max(a[1], b[1], c[1], d[1])
      let ci0 = Math.max(0, Math.floor((bx0 - g.x0) / g.dx)), ci1 = Math.min(g.nx - 1, Math.floor((bx1 - g.x0) / g.dx))
      let cj0 = Math.max(0, Math.floor((bz0 - g.z0) / g.dz)), cj1 = Math.min(g.nz - 1, Math.floor((bz1 - g.z0) / g.dz))
      if (win) {
        // cells whose centre lies inside the window: x0 + (ci + ½) dx ∈ [minX, maxX)
        ci0 = Math.max(ci0, Math.ceil((win[0] - g.x0) / g.dx - 0.5))
        ci1 = Math.min(ci1, Math.ceil((win[2] - g.x0) / g.dx - 0.5) - 1)
        cj0 = Math.max(cj0, Math.ceil((win[1] - g.z0) / g.dz - 0.5))
        cj1 = Math.min(cj1, Math.ceil((win[3] - g.z0) / g.dz - 0.5) - 1)
      }
      if (ci1 < ci0 || cj1 < cj0) continue
      drape = opts.drape === 'mesh' ? 1 : 2
      poolKey = key
      for (let cj = cj0; cj <= cj1; cj++) {
        for (let ci = ci0; ci <= ci1; ci++) {
          const x0 = g.x0 + ci * g.dx, z0 = g.z0 + cj * g.dz, x1 = x0 + g.dx, z1 = z0 + g.dz
          if (hole && centreIn(hole, (x0 + x1) / 2, (z0 + z1) / 2)) continue
          // nodes a (i, j), b (i+1, j), c (i, j+1), e (i+1, j+1) — the b–c diagonal
          for (let half = 0; half < 2; half++) {
            if (half === 0) {
              triXZ[0][0] = x0; triXZ[0][1] = z0; triXZ[1][0] = x1; triXZ[1][1] = z0; triXZ[2][0] = x0; triXZ[2][1] = z1
            } else {
              triXZ[0][0] = x1; triXZ[0][1] = z0; triXZ[1][0] = x0; triXZ[1][1] = z1; triXZ[2][0] = x1; triXZ[2][1] = z1
            }
            const poly = cleanRing(clipToTriangle(quad, triXZ))
            if (poly.length < 3) continue
            if (drape === 2) {
              // barycentric on this terrain triangle from its node heights (exact on the ring's own planes)
              tax = triXZ[0][0]; taz = triXZ[0][1]
              tux = triXZ[1][0] - tax; tuz = triXZ[1][1] - taz; tvx = triXZ[2][0] - tax; tvz = triXZ[2][1] - taz
              tdet = tux * tvz - tuz * tvx
              if (half === 0) { tya = nodeY(ci, cj); tyb = nodeY(ci + 1, cj); tyc = nodeY(ci, cj + 1) }
              else { tya = nodeY(ci + 1, cj); tyb = nodeY(ci, cj + 1); tyc = nodeY(ci + 1, cj + 1) }
            }
            // a convex piece → fan from vertex 0
            const p0 = poly[0]!
            for (let k = 1; k + 1 < poly.length; k++) {
              const p1 = poly[k]!, p2 = poly[k + 1]!
              tri(p0[0], p0[1], p1[0], p1[1], p2[0], p2[1])
            }
          }
        }
      }
      if (poured) { stats.quads++; stats.triangles += poured }
    }
  }
  return stats
}
