import * as THREE from 'three'
import { type Side } from '~/data/suzuka-facilities-spec'
import { HELIPAD } from '~/data/suzuka-facilities-spec'
import { CIRCUIT } from '~/data/suzuka'
import type { Track } from '~/sim/track'
import { ASPHALT_TILE_M, ASPHALT_WIDTH_M } from './textures'
import {
  DECK_SHOULDER, PRECEDENCE, ROAD_FRACTIONS, RULE_OF, STRIP_DROP, inWorldRing, kerbAt, kerbProfileHeight, ownerBeats,
  type Column, type GroundPlan, type Owner, type OwnerKind, type Pt, type RingOwner,
} from './ground-plan'
import { osmWay } from './trackside'

/** longest edge of a world-polygon triangle (m): fine enough to drape, coarse enough for the clamp */
const WORLD_STEP = 4
/** a triangle thinner than this draws nothing; its vertices would still take a sideways normal */
const MIN_WIDTH = 0.002

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
}

export type GroundMaterials = Partial<Record<OwnerKind, THREE.Material>>

export interface GroundFace {
  kind: OwnerKind
  frame: 'road' | 'field'
  geo: THREE.BufferGeometry
  mesh: THREE.Mesh
  tris: number
}

export interface BuiltGround {
  group: THREE.Group
  faces: GroundFace[]
  stats: { vertices: number; triangles: number; cells: number; dropped: number; byKind: Record<string, number>; worldTris: number; stitchTris: number; buildMs: number }
}

/** metres one uv unit spans, per world-planar kind */
const PLANAR_UV: Partial<Record<OwnerKind, [number, number]>> = {
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

/** vertex pool: one entry per (station, lateral), written once by the first (highest) owner */
class Pool {
  x: number[] = []
  y: number[] = []
  z: number[] = []
  s: number[] = []
  lat: number[] = []
  private keys = new Map<string, number>()
  key(i: number, lateral: number): string {
    return `${i}|${Math.round(lateral * 1e4)}`
  }
  /** a vertex that is not on a station: keyed on its world position */
  addWorld(x: number, y: number, z: number, s: number, lateral: number): number {
    const k = `w|${Math.round(x * 1e3)}|${Math.round(z * 1e3)}`
    let idx = this.keys.get(k)
    if (idx !== undefined) return idx
    idx = this.x.length
    this.keys.set(k, idx)
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
    idx = this.x.length
    this.keys.set(k, idx)
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
  const track = plan.track
  const L = track.length
  const m = plan.stations.length
  const pool = new Pool()
  const cells: Cell[] = []

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
      return _p.y + kerbProfileHeight(kb.width, kb.taper, Math.abs(lateral) - track.halfWidthAt(s))
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
  let dropped = 0
  const area2 = (a: number, b: number, c: number): number => (pool.x[b]! - pool.x[a]!) * (pool.z[c]! - pool.z[a]!) - (pool.z[b]! - pool.z[a]!) * (pool.x[c]! - pool.x[a]!)
  const tri = (kind: OwnerKind, a: number, b: number, c: number) => {
    if (a === b || b === c || a === c) return
    // counter-clockwise seen from +Y: in (x, z) that is a NEGATIVE signed area
    const ar = area2(a, b, c)
    if (Math.abs(ar) < 2e-6) { dropped++; return }
    let arr = triByKind.get(kind)
    if (!arr) { arr = []; triByKind.set(kind, arr) }
    if (ar < 0) arr.push(a, b, c)
    else arr.push(a, c, b)
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

  // --- world parts: what the rings cover beyond the raster ------------------------------------------
  let worldTris = 0
  const extentVertex = (i: number, side: Side): number | undefined => pool.get(i, side * (plan.hw[i]! + plan.sides[side].W[i]!))
  const inRaster = (x: number, z: number): { inside: boolean; s: number; side: Side; off: number; W: number } => {
      const p = plan.project(x, z)
      const hw = track.halfWidthAt(p.s)
      const side: Side = p.lateral >= 0 ? 1 : -1
      const off = Math.abs(p.lateral) - hw
      const W = plan.extent(p.s, side)
      // a ring edge that runs ALONG the extent (a paddock band ending exactly at the raster's
      // declared edge) is inside: a hair outside would make the whole edge an "outside arc"
      return { inside: off <= W + 0.05, s: p.s, side, off, W }
  }
  const emitPolygon = (owner: Owner, contour: { x: number; z: number; v?: number }[], holes: Pt[][], window?: [number, number]) => {
      const shape = contour.map((p) => new THREE.Vector2(p.x, -p.z))
      const holeShapes = holes.map((h) => h.map((p) => new THREE.Vector2(p.x, -p.z)).reverse())
      let faces: number[][]
      try { faces = THREE.ShapeUtils.triangulateShape(shape, holeShapes) } catch { faces = [] }
      if (!faces.length) { console.error(`[ground-mesh] "${owner.name}": its world part could not be triangulated`); return }
      // vertex table: contour first, then the holes (the order triangulateShape indexes them)
      const pts: { x: number; z: number; v?: number }[] = [...contour, ...holes.flatMap((h) => [...h].reverse().map((p) => ({ x: p.x, z: p.z })))]
      let tris = faces.map((f) => [f[0]!, f[1]!, f[2]!] as [number, number, number])
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
      // seam with the raster); everything else is a world vertex on the field
      const idx = pts.map((p) => {
        if (p.v !== undefined) return p.v
        const pr = window ? track.nearestOnRange(p.x, p.z, window[0], window[1], 60) : plan.project(p.x, p.z)
        return pool.addWorld(p.x, field.y(p.x, p.z, window), p.z, pr.s, pr.lateral)
      })
      let emitted = 0, area = 0
      for (const [a, b, c] of tris) {
        const ia = idx[a]!, ib = idx[b]!, ic = idx[c]!
        // drop slivers: a hair-thin ear spans metres of terrain and takes a sideways normal
        const cross = (pool.x[ib]! - pool.x[ia]!) * (pool.z[ic]! - pool.z[ia]!) - (pool.z[ib]! - pool.z[ia]!) * (pool.x[ic]! - pool.x[ia]!)
        const longest = Math.max(Math.hypot(pool.x[ib]! - pool.x[ia]!, pool.z[ib]! - pool.z[ia]!), Math.hypot(pool.x[ic]! - pool.x[ib]!, pool.z[ic]! - pool.z[ib]!), Math.hypot(pool.x[ia]! - pool.x[ic]!, pool.z[ia]! - pool.z[ic]!))
        if (longest <= 1e-9 || Math.abs(cross) / longest <= MIN_WIDTH) { dropped++; continue }
        tri(owner.kind, ia, ib, ic)
        worldTris++
        emitted++
        area += Math.abs(cross) / 2
      }
      console.info(`[ground-mesh] world part "${owner.name}": ${contour.length} contour vertices, ${holes.length} holes, ${emitted} triangles, ${area.toFixed(0)} m²`)
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
      for (let k = 0; k < rails; k++) {
        const t = (0.5 - k / (rails - 1)) * width
        const x = p.x + dz * t, z = p.z - dx * t
        const pr = plan.project(x, z)
        row.push(pool.addWorld(x, field.y(x, z), z, pr.s, pr.lateral))
      }
      grid.push(row)
    }
    for (let i = 0; i < count - 1; i++) {
      for (let k = 0; k < rails - 1; k++) {
        const p00 = grid[i]![k]!, p01 = grid[i]![k + 1]!, p10 = grid[i + 1]![k]!, p11 = grid[i + 1]![k + 1]!
        tri(r.owner.kind, p00, p10, p01)
        tri(r.owner.kind, p01, p10, p11)
        worldTris += 2
      }
    }
  }
  {
    // the crossing of a ring edge (inside → outside) with the extent, by bisection on the edge
    const crossing = (pIn: Pt, pOut: Pt): { x: number; z: number; s: number; side: Side } => {
      let a = pIn, b = pOut
      for (let it = 0; it < 24; it++) {
        const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2
        if (inRaster(mx, mz).inside) a = { x: mx, z: mz }
        else b = { x: mx, z: mz }
      }
      const q = inRaster((a.x + b.x) / 2, (a.z + b.z) / 2)
      return { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, s: q.s, side: q.side }
    }
    for (const r of plan.rings) {
      const ring = r.ring.outer
      const flags = ring.map((p) => inRaster(p.x, p.z))
      const nInside = flags.filter((f) => f.inside).length
      if (nInside === ring.length) continue
      // higher-precedence rings nested in this one are holes of its world part (the annulus of
      // a swept closed way carries its own)
      const holes: Pt[][] = [...r.ring.holes]
      for (const o of plan.rings) {
        if (o === r || !ownerBeats(o.owner, r.owner)) continue
        if (o.ring.outer.every((p) => inWorldRing(p.x, p.z, r.ring))) holes.push(o.ring.outer)
      }
      if (nInside === 0) {
        // a swept way that never touches a raster is built as the swept quad grid it is (rails
        // every ≤ WORLD_STEP): earcut on a 10 m wide, kilometre-long annulus makes long slivers
        // that the refinement then multiplies tenfold
        if (r.area && 'way' in r.area.footprint) { emitSweep(r, r.area.footprint.width); continue }
        emitPolygon(r.owner, ring.map((p) => ({ x: p.x, z: p.z })), holes, r.ring.sRange)
        continue
      }
      // arcs of outside vertices, each closed by the raster's extent between its two crossings
      const n = ring.length
      let start = flags.findIndex((f) => f.inside)
      for (let k = 0; k < n; k++) {
        const i0 = (start + k) % n
        if (flags[i0]!.inside || !flags[(i0 - 1 + n) % n]!.inside) continue
        // an outside arc starts at i0
        let i1 = i0
        while (!flags[(i1 + 1) % n]!.inside) i1 = (i1 + 1) % n
        const A = crossing(ring[(i0 - 1 + n) % n]!, ring[i0]!)
        const B = crossing(ring[(i1 + 1) % n]!, ring[i1]!)
        if (A.side !== B.side || Math.abs(((A.s - B.s + L * 1.5) % L) - L / 2) > 400) {
          console.error(`[ground-mesh] "${r.owner.name}": an outside arc leaves the verge at s ${A.s.toFixed(0)} side ${A.side} and returns at s ${B.s.toFixed(0)} side ${B.side} (${i1 - i0 + 1} vertices) — split the row`)
          continue
        }
        const side = A.side
        // the extent vertices from B back to A, in station order
        const iA = plan.stationIndexAt(A.s), iB = plan.stationIndexAt(B.s)
        const forward = ((B.s - A.s + L) % L) < L / 2 // B is ahead of A along s → walk back from B to A
        const seq: number[] = []
        if (forward) { for (let i = (iB - 1 + m) % m; ; i = (i - 1 + m) % m) { if (plan.stations[i]! < A.s && !(A.s > B.s)) break; seq.push(i); if (i === iA) break; if (seq.length > m) break } }
        else { for (let i = iB; ; i = (i + 1) % m) { seq.push(i); if (i === (iA - 1 + m) % m) break; if (seq.length > m) break } }
        // A/B sit on the extent segment of their row: their height is interpolated on it (no crack)
        const onExtent = (c: { x: number; z: number; s: number }): { x: number; z: number; v: number } => {
          const j1 = plan.stationIndexAt(c.s), j0 = (j1 - 1 + m) % m
          const va = extentVertex(j0, side), vb = extentVertex(j1, side)
          if (va === undefined || vb === undefined) return { x: c.x, z: c.z, v: pool.addWorld(c.x, field.y(c.x, c.z, r.ring.sRange), c.z, c.s, 0) }
          const dx = pool.x[vb]! - pool.x[va]!, dz = pool.z[vb]! - pool.z[va]!
          const l2 = dx * dx + dz * dz || 1
          const t = Math.max(0, Math.min(1, ((c.x - pool.x[va]!) * dx + (c.z - pool.z[va]!) * dz) / l2))
          const x = pool.x[va]! + dx * t, z = pool.z[va]! + dz * t, y = pool.y[va]! + (pool.y[vb]! - pool.y[va]!) * t
          return { x, z, v: pool.addWorld(x, y, z, c.s, 0) }
        }
        const contour: { x: number; z: number; v?: number }[] = []
        contour.push(onExtent(A))
        for (let i = i0; ; i = (i + 1) % n) { contour.push({ x: ring[i]!.x, z: ring[i]!.z }); if (i === i1) break }
        contour.push(onExtent(B))
        for (const i of seq) {
          const v = extentVertex(i, side)
          if (v === undefined) continue
          contour.push({ x: pool.x[v]!, z: pool.z[v]!, v })
        }
        // a contour of three points or fewer is a sliver at the crossing
        if (contour.length < 3) continue
        emitPolygon(r.owner, contour, [], r.ring.sRange)
      }
    }
  }

  // --- stitch strips across the bisectors ----------------------------------------------------------
  // Two facing stretches both stop BISECTOR_MARGIN short of their bisector; the strip between
  // their extent polylines is zipped (a two-polyline triangulation, no earcut, no refinement) so
  // every strip vertex is a pool vertex of one raster or the other. Runs are paired once: each
  // bisector-capped run finds the run on the facing side that its partner samples fall in.
  let stitchTris = 0
  {
    interface Run { side: Side; start: number; end: number; id: number }
    const runs: Run[] = []
    for (const side of [1, -1] as const) {
      const cap = plan.sides[side].cap
      let i = 0
      while (i < m) {
        if (cap[i] !== 2) { i++; continue }
        let e = i
        while (e + 1 < m && cap[e + 1] === 2) e++
        if (e - i >= 2) runs.push({ side, start: i, end: e, id: runs.length })
        i = e + 1
      }
    }
    const runAt = (side: Side, k: number) => runs.find((r) => r.side === side && k >= r.start && k <= r.end)
    /** the run a station's partner sample falls in, and the partner's own station */
    const partnerOf = (side: Side, k: number): { run: Run; station: number } | null => {
      const j = plan.bisectorPartner(plan.stations[k]!, side)
      if (j < 0) return null
      const ki = Math.round(plan.stations[k]! / track.ds) % track.n
      const pSide: Side = (track.px[ki]! - track.px[j]!) * track.nx[j]! + (track.pz[ki]! - track.pz[j]!) * track.nz[j]! > 0 ? 1 : -1
      const station = plan.stationIndexAt(j * track.ds)
      const run = runAt(pSide, station)
      return run ? { run, station } : null
    }
    const paired = new Set<string>()
    const d = (p: number, q: number) => Math.hypot(pool.x[p]! - pool.x[q]!, pool.z[p]! - pool.z[q]!)
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
      // only the MUTUAL stretch of the two runs is zipped: the stations of A whose partner lies
      // in B, and the stations of B whose partner lies in A (a long run faces several short ones)
      const a: number[] = [], aSt: number[] = []
      for (let k = A.start; k <= A.end; k++) { const p = partnerOf(A.side, k); if (!p || p.run.id !== B.id) continue; const v = extentVertex(k, A.side); if (v !== undefined) { a.push(v); aSt.push(k) } }
      const b: number[] = [], bSt: number[] = []
      for (let k = B.start; k <= B.end; k++) { const p = partnerOf(B.side, k); if (!p || p.run.id !== A.id) continue; const v = extentVertex(k, B.side); if (v !== undefined) { b.push(v); bSt.push(k) } }
      if (a.length < 2 || b.length < 2) continue
      if (d(a[0]!, b[0]!) > d(a[0]!, b[b.length - 1]!)) { b.reverse(); bSt.reverse() }
      const ownerA = (k: number) => plan.ownerAtSL(plan.stations[k]!, A.side, plan.sides[A.side].W[k]! - 0.01, true)
      const ownerB = (k: number) => plan.ownerAtSL(plan.stations[k]!, B.side, plan.sides[B.side].W[k]! - 0.01, true)
      let ia = 0, ib = 0, area = 0
      while (ia < a.length - 1 || ib < b.length - 1) {
        const advanceA = ib >= b.length - 1 || (ia < a.length - 1 && d(a[ia + 1]!, b[ib]!) < d(a[ia]!, b[ib + 1]!))
        const oa = ownerA(aSt[ia]!), ob = ownerB(bSt[ib]!)
        const owner = ownerBeats(oa, ob) ? oa : ob
        const p = a[ia]!, q = advanceA ? a[ia + 1]! : b[ib + 1]!, r = b[ib]!
        const cross = (pool.x[q]! - pool.x[p]!) * (pool.z[r]! - pool.z[p]!) - (pool.z[q]! - pool.z[p]!) * (pool.x[r]! - pool.x[p]!)
        area += Math.abs(cross) / 2
        tri(owner.kind, p, q, r)
        stitchTris++
        if (advanceA) ia++
        else ib++
      }
      const len = d(a[0]!, a[a.length - 1]!)
      console.info(`[ground-mesh] stitch side ${A.side} s ${plan.stations[A.start]!.toFixed(0)}-${plan.stations[A.end]!.toFixed(0)} ↔ side ${B.side} s ${plan.stations[B.start]!.toFixed(0)}-${plan.stations[B.end]!.toFixed(0)}: ${area.toFixed(0)} m² over ${len.toFixed(0)} m`)
    }
  }

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
      case 'helipad': out[0] = 0.5 + (s - HELIPAD.s) / (2 * HELIPAD.radius); out[1] = 0.5 + (lat - HELIPAD.lateral) / (2 * HELIPAD.radius); return
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
    geo.setIndex(index)
    geo.computeBoundingSphere()
    const mat = materials[kind]
    if (!mat) console.error(`[ground-mesh] no material for ground kind "${kind}"`)
    const mesh = new THREE.Mesh(geo, mat ?? new THREE.MeshStandardMaterial({ color: 0xff00ff }))
    mesh.name = `ground:${kind}`
    mesh.receiveShadow = true
    group.add(mesh)
    const tris = index.length / 3
    faces.push({ kind, frame: RULE_OF[kind].frame, geo, mesh, tris })
    byKind[kind] = tris
    triangles += tris
  }
  return { group, faces, stats: { vertices: N, triangles, cells: cells.length, dropped, byKind, worldTris, stitchTris, buildMs: performance.now() - t0 } }
}
