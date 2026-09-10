import * as THREE from 'three'
import type { Ground } from './ground'
import type { GroundPlan } from './ground-plan'

/**
 * Geometry helpers for the far field (plan §2): polygon tests and the terrain-conforming
 * overlay `cellClippedPolygon`, shared by the forest (canopy masses, forest floor) and the later
 * surroundings builders (car-park slabs, solar-farm bases, water).
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
  const NXN = g.nx + 1

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
  const accept = minD + g.dx + g.dz
  const nodeD = (i: number, j: number): number => {
    const idx = j * NXN + i
    const ex = cache.dExact[idx]!
    if (!Number.isNaN(ex)) return ex
    let lo = cache.dLo[idx]!
    if (Number.isNaN(lo)) {
      // bounds from the neighbours already visited (row-major sweep: left and above)
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
  /** exact distance at an arbitrary point, memoised per call (the subdivision midpoints near minD) */
  const exactAt = new Map<number, number>()
  const qkey = (x: number, z: number) => Math.round((x - g.x0) * 8) * 131072 + Math.round((z - g.z0) * 8)
  const pointD = (x: number, z: number): number => {
    const k = qkey(x, z)
    let d = exactAt.get(k)
    if (d === undefined) {
      d = plan.project(x, z).d
      exactAt.set(k, d)
    }
    return d
  }
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
