import * as THREE from 'three'
import { type Side } from '~/data/suzuka-facilities-spec'
import { HELIPAD } from '~/data/suzuka-facilities-spec'
import { CIRCUIT } from '~/data/suzuka'
import type { Track } from '~/sim/track'
import { ASPHALT_TILE_M, ASPHALT_WIDTH_M } from './textures'
import {
  DECK_SHOULDER, PRECEDENCE, ROAD_FRACTIONS, RULE_OF, STRIP_DROP, inRing, inWorldRing, kerbAt, kerbProfileHeight, ownerBeats,
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

export interface BuiltGround {
  group: THREE.Group
  faces: GroundFace[]
  /** the top drawn face at world (x, z), its kind and its source (0 raster, 1 world part, 2 stitch); null where no face is drawn */
  yAt: (x: number, z: number) => { y: number; kind: OwnerKind; src: number } | null
  stats: {
    vertices: number; triangles: number; cells: number; dropped: number; byKind: Record<string, number>; worldTris: number; stitchTris: number; buildMs: number
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

/** vertex pool: one entry per (station, lateral), written once by the first (highest) owner */
class Pool {
  x: number[] = []
  y: number[] = []
  z: number[] = []
  s: number[] = []
  lat: number[] = []
  private keys = new Map<string, number>()
  /** every vertex by its world XZ (1 mm): a world vertex landing on a station vertex reuses it */
  private xz = new Map<string, number>()
  key(i: number, lateral: number): string {
    return `${i}|${Math.round(lateral * 1e4)}`
  }
  private xzKey(x: number, z: number): string {
    return `${Math.round(x * 1e3)}|${Math.round(z * 1e3)}`
  }
  /** a vertex that is not on a station: keyed on its world position */
  addWorld(x: number, y: number, z: number, s: number, lateral: number): number {
    const k = this.xzKey(x, z)
    let idx = this.xz.get(k)
    if (idx !== undefined) return idx
    idx = this.x.length
    this.xz.set(k, idx)
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
    const kx = this.xzKey(x, z)
    idx = this.xz.get(kx)
    if (idx !== undefined) { this.keys.set(k, idx); return idx }
    idx = this.x.length
    this.keys.set(k, idx)
    this.xz.set(kx, idx)
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
      const p = facing(side, k)
      if (!p) return null
      const run = runAt(p.side, p.station)
      return run ? { run, station: p.station } : null
    }
    const paired = new Set<string>()
    const d = (p: number, q: number) => Math.hypot(pool.x[p]! - pool.x[q]!, pool.z[p]! - pool.z[q]!)
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
      const extend = (run: Run, lo: number, hi: number, other: Run, oLo: number, oHi: number): [number, number] => {
        while (lo > 0 && free(run.side, lo - 1) && facesRange(run.side, lo - 1, other.side, oLo, oHi)) lo--
        while (hi < m - 1 && free(run.side, hi + 1) && facesRange(run.side, hi + 1, other.side, oLo, oHi)) hi++
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
      const outerA = (k: number) => plan.ownerAtSL(plan.stations[k]!, A.side, plan.sides[A.side].W[k]! - 0.01, true)
      const outerB = (k: number) => plan.ownerAtSL(plan.stations[k]!, B.side, plan.sides[B.side].W[k]! - 0.01, true)
      let area = 0
      /** the strip's triangles before refinement: [p, q, r, ownerKind] */
      const zipTris: { p: number; q: number; r: number; kind: OwnerKind }[] = []
      /** an edge along one of the two extent polylines is a raster edge and is never split */
      const railEdge = new Set<string>()
      const edgeKey = (u: number, v: number) => (u < v ? `${u},${v}` : `${v},${u}`)
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
      // midpoints on the field until none is longer than WORLD_STEP, per edge so neighbours agree
      const mid = new Map<string, number>()
      const midpoint = (u: number, v: number): number => {
        const key = u < v ? `${u},${v}` : `${v},${u}`
        let k = mid.get(key)
        if (k === undefined) {
          const x = (pool.x[u]! + pool.x[v]!) / 2, z = (pool.z[u]! + pool.z[v]!) / 2
          const pr = plan.project(x, z)
          k = pool.addWorld(x, field.y(x, z), z, pr.s, pr.lateral)
          mid.set(key, k)
          for (const set of endSets) if (set.has(u) && set.has(v)) set.add(k)
        }
        return k
      }
      const splittable = (u: number, v: number) => !railEdge.has(edgeKey(u, v)) && Math.hypot(pool.x[u]! - pool.x[v]!, pool.z[u]! - pool.z[v]!) > WORLD_STEP
      let work = zipTris
      for (let pass = 0; pass < 6; pass++) {
        const next: typeof zipTris = []
        let split = false
        for (const z of work) {
          const { p: a0, q: b0, r: c0, kind } = z
          const ab = splittable(a0, b0), bc = splittable(b0, c0), ca = splittable(c0, a0)
          if (!ab && !bc && !ca) { next.push(z); continue }
          split = true
          const T = (p: number, q: number, r: number) => next.push({ p, q, r, kind })
          if (ab && bc && ca) { const p = midpoint(a0, b0), q = midpoint(b0, c0), r = midpoint(c0, a0); T(a0, p, r); T(p, b0, q); T(r, q, c0); T(p, q, r) }
          else if (ab && bc) { const p = midpoint(a0, b0), q = midpoint(b0, c0); T(a0, p, q); T(p, b0, q); T(a0, q, c0) }
          else if (bc && ca) { const q = midpoint(b0, c0), r = midpoint(c0, a0); T(b0, q, r); T(q, c0, r); T(a0, b0, r) }
          else if (ca && ab) { const r = midpoint(c0, a0), p = midpoint(a0, b0); T(a0, p, r); T(p, b0, r); T(b0, c0, r) }
          else if (ab) { const p = midpoint(a0, b0); T(a0, p, c0); T(p, b0, c0) }
          else if (bc) { const q = midpoint(b0, c0); T(a0, b0, q); T(a0, q, c0) }
          else { const r = midpoint(c0, a0); T(a0, b0, r); T(b0, c0, r) }
        }
        work = next
        if (!split) break
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
  const stitchCells = new Map<number, number[]>()
  for (let t = 0; t < stitchTriList.length; t += 3) {
    const a = stitchTriList[t]!, b = stitchTriList[t + 1]!, c = stitchTriList[t + 2]!
    const i0 = Math.floor(Math.min(pool.x[a]!, pool.x[b]!, pool.x[c]!) / CELL), i1 = Math.floor(Math.max(pool.x[a]!, pool.x[b]!, pool.x[c]!) / CELL)
    const j0 = Math.floor(Math.min(pool.z[a]!, pool.z[b]!, pool.z[c]!) / CELL), j1 = Math.floor(Math.max(pool.z[a]!, pool.z[b]!, pool.z[c]!) / CELL)
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const k = cellKey(i, j); let arr = stitchCells.get(k); if (!arr) { arr = []; stitchCells.set(k, arr) } arr.push(t) }
  }
  const inStitch = (x: number, z: number): boolean => {
    const arr = stitchCells.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL)))
    if (!arr) return false
    for (const t of arr) {
      const a = stitchTriList[t]!, b = stitchTriList[t + 1]!, c = stitchTriList[t + 2]!
      const ax = pool.x[a]!, az = pool.z[a]!, bx = pool.x[b]!, bz = pool.z[b]!, cx = pool.x[c]!, cz = pool.z[c]!
      const dd = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz)
      if (Math.abs(dd) < 1e-12) continue
      const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / dd
      const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / dd
      if (u >= -1e-6 && v >= -1e-6 && 1 - u - v >= -1e-6) return true
    }
    return false
  }
  const covered = (x: number, z: number): boolean => inRaster(x, z).inside || inStitch(x, z)

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
  /** for every directed U edge p→q of a loop: which loop and the edge's position in it */
  const uEdge = new Map<string, { loop: number; k: number }>()
  let uBad = 0
  {
    const seen = new Set<number>()
    for (const [v0, nb] of uAdj) {
      if (seen.has(v0) || nb.length !== 2) { if (nb.length !== 2) uBad++; continue }
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
      const id = uLoops.length
      uLoops.push(loop)
      for (let k = 0; k < loop.length; k++) uEdge.set(`${loop[k]}|${loop[(k + 1) % loop.length]}`, { loop: id, k })
    }
    if (uBad) console.warn(`[ground-mesh] union boundary: ${uBad} vertex(es) or loop(s) with a degree other than 2 were skipped`)
  }
  /** U edges by cell, for locating a crossing point on the boundary */
  const uCells = new Map<number, [number, number][]>()
  for (let li = 0; li < uLoops.length; li++) {
    const loop = uLoops[li]!
    for (let k = 0; k < loop.length; k++) {
      const p = loop[k]!, q = loop[(k + 1) % loop.length]!
      const i0 = Math.floor(Math.min(pool.x[p]!, pool.x[q]!) / CELL), i1 = Math.floor(Math.max(pool.x[p]!, pool.x[q]!) / CELL)
      const j0 = Math.floor(Math.min(pool.z[p]!, pool.z[q]!) / CELL), j1 = Math.floor(Math.max(pool.z[p]!, pool.z[q]!) / CELL)
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const kk = cellKey(i, j); let arr = uCells.get(kk); if (!arr) { arr = []; uCells.set(kk, arr) } arr.push([li, k]) }
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

  // --- world parts: what the rings cover beyond the covered ground ----------------------------------
  let worldTris = 0
  let droppedWorldArea = 0
  const emitPolygon = (owner: Owner, contour: { x: number; z: number; v?: number }[], holes: Pt[][], window?: [number, number], verify?: (x: number, z: number) => boolean) => {
      const shape = contour.map((p) => new THREE.Vector2(p.x, -p.z))
      const holeShapes = holes.map((h) => h.map((p) => new THREE.Vector2(p.x, -p.z)).reverse())
      let faces: number[][]
      try { faces = THREE.ShapeUtils.triangulateShape(shape, holeShapes) } catch { faces = [] }
      if (!faces.length) {
        // a contour of a few points at a crossing is a sliver the raster already covers to within
        // its width; a real part failing is a build error
        let a2 = 0
        for (let i = 0; i < contour.length; i++) { const p = contour[i]!, q = contour[(i + 1) % contour.length]!; a2 += p.x * q.z - q.x * p.z }
        if (Math.abs(a2) / 2 < 2) return
        fail(`"${owner.name}": its world part (${(Math.abs(a2) / 2).toFixed(0)} m²) could not be triangulated`)
        return
      }
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
      let emitted = 0, area = 0, rejected = 0, rejectedArea = 0
      for (const [a, b, c] of tris) {
        const ia = idx[a]!, ib = idx[b]!, ic = idx[c]!
        // drop slivers: a hair-thin ear spans metres of terrain and takes a sideways normal
        const cross = (pool.x[ib]! - pool.x[ia]!) * (pool.z[ic]! - pool.z[ia]!) - (pool.z[ib]! - pool.z[ia]!) * (pool.x[ic]! - pool.x[ia]!)
        const longest = Math.max(Math.hypot(pool.x[ib]! - pool.x[ia]!, pool.z[ib]! - pool.z[ia]!), Math.hypot(pool.x[ic]! - pool.x[ib]!, pool.z[ic]! - pool.z[ib]!), Math.hypot(pool.x[ia]! - pool.x[ic]!, pool.z[ia]! - pool.z[ic]!))
        if (longest <= 1e-9 || Math.abs(cross) / longest <= MIN_WIDTH) { dropped++; continue }
        // a triangle the plan says is not this owner's (covered ground, a nested higher ring) is
        // dropped; a traced part that loses many of them was traced wrong and is reported
        if (verify && !verify((pool.x[ia]! + pool.x[ib]! + pool.x[ic]!) / 3, (pool.z[ia]! + pool.z[ib]! + pool.z[ic]!) / 3)) {
          rejected++
          rejectedArea += Math.abs(cross) / 2
          droppedWorldArea += Math.abs(cross) / 2
          if ((globalThis as unknown as { GM_DEBUG?: string }).GM_DEBUG === owner.name && rejected <= 12) {
            const cx = (pool.x[ia]! + pool.x[ib]! + pool.x[ic]!) / 3, cz = (pool.z[ia]! + pool.z[ib]! + pool.z[ic]!) / 3
            const pr = plan.project(cx, cz)
            console.info(`[gm-debug] rejected triangle at (${cx.toFixed(1)}, ${cz.toFixed(1)}) s ${pr.s.toFixed(1)} lat ${pr.lateral.toFixed(1)} area ${(Math.abs(cross) / 2).toFixed(2)} covered ${covered(cx, cz)} inRaster ${inRaster(cx, cz).inside} extentDrawn ${plan.extentDrawn(pr.s, pr.lateral > 0 ? 1 : -1).toFixed(2)} owner ${plan.ownerAt(cx, cz).name}`)
          }
          continue
        }
        tri(owner.kind, ia, ib, ic, 1)
        worldTris++
        emitted++
        area += Math.abs(cross) / 2
      }
      console.info(`[ground-mesh] world part "${owner.name}": ${contour.length} contour vertices, ${holes.length} holes, ${emitted} triangles, ${area.toFixed(0)} m²${rejected ? ` (${rejected} rejected, ${rejectedArea.toFixed(1)} m²)` : ''}`)
      // slivers along the contour's raster edges are expected to fall either way; a real share of
      // the area on covered ground means the contour was traced wrong
      if (rejectedArea > 2 && rejectedArea > area * 0.05) console.warn(`[ground-mesh] "${owner.name}": ${rejectedArea.toFixed(0)} m² of ${(area + rejectedArea).toFixed(0)} m² of a world part lie on covered ground or inside a higher ring — the traced contour is doubtful`)
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
        tri(r.owner.kind, p00, p10, p01, 1)
        tri(r.owner.kind, p01, p10, p11, 1)
        worldTris += 2
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
    /** rings processed so far (higher precedence first): a nested one is a hole in this one's part */
    const done: RingOwner[] = []
    /** boundary loops that enclose an uncovered pocket entirely inside a ring, claimed by the first (highest) ring that contains them */
    const claimedLoops = new Set<number>()
    for (const r of plan.rings) {
      // a higher ring is nested when every vertex is inside this ring or within 0.15 m of its
      // boundary (the turf island and the apron share their road-side edge to the millimetre)
      const nearEdge = (p: Pt, ring: readonly Pt[], tol: number): boolean => {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const a = ring[j]!, b = ring[i]!
          const dx = b.x - a.x, dz = b.z - a.z
          const l2 = dx * dx + dz * dz || 1
          const tt = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2))
          if (Math.hypot(p.x - a.x - dx * tt, p.z - a.z - dz * tt) < tol) return true
        }
        return false
      }
      const higherNested = done.filter((o) => ownerBeats(o.owner, r.owner) && o.ring.outer.every((p) => inWorldRing(p.x, p.z, r.ring) || nearEdge(p, r.ring.outer, 0.15)))
      /** every higher-precedence ring that overlaps this one at all: its ground is never this owner's */
      const higherAny = done.filter((o) => ownerBeats(o.owner, r.owner) && !(o.ring.box[1] < r.ring.box[0] || o.ring.box[0] > r.ring.box[1] || o.ring.box[3] < r.ring.box[2] || o.ring.box[2] > r.ring.box[3]))
      done.push(r)
      /*
       * The ring's boundary as loops: its outer ring (interior on the left), then its holes and
       * the higher-precedence rings nested in it, REVERSED so that this owner's ground is on their
       * left too. Every loop is resampled to ≤ 2 m so a raster edge crossing a long segment (the
       * side of a paddock band) is seen by the vertex tests.
       */
      const loops: Pt[][] = [dense(r.ring.outer, 0.1), ...r.ring.holes.map((h) => dense(h, 0.1).reverse()), ...higherNested.map((o) => dense(o.ring.outer, 0.1).reverse())]
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
        emitPolygon(r.owner, loops[0]!.map((p) => ({ x: p.x, z: p.z })), loops.slice(1).map((h) => [...h].reverse()), r.ring.sRange)
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
      const insideRing = (x: number, z: number) => inWorldRing(x, z, r.ring) && !higherAny.some((o) => inWorldRing(x, z, o.ring))
      const polygons: { x: number; z: number; v?: number }[][] = []
      for (const first of arcs) {
        if (visited.has(first.id)) continue
        const contour: { x: number; z: number; v?: number }[] = []
        let cur: Arc = first
        let ok = true
        for (let guard = 0; guard <= arcs.length; guard++) {
          visited.add(cur.id)
          const lp = loops[cur.loop]!, n = lp.length
          contour.push(onU(cur.A))
          for (let i = cur.i0; ; i = (i + 1) % n) { contour.push({ x: lp[i]!.x, z: lp[i]!.z }); if (i === cur.i1) break }
          contour.push(onU(cur.B))
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
          for (let step = 1; step <= len; step++) {
            const kk = (cur.B.k + step) % len
            if ((kk - pB + len) % len >= best) break
            const v = uloop[kk]!
            contour.push({ x: pool.x[v]!, z: pool.z[v]!, v })
          }
          if (debug) console.info(`[gm-debug] from arc ${cur.id} B → next arc ${next.id} (${nextIsA ? 'A' : 'B'}) ${best.toFixed(2)} edges ahead on loop ${cur.B.loop} (len ${len})`)
          if (next === first) break
          cur = next
        }
        if (debug) console.info(`[gm-debug] polygon from arc ${first.id}: ok ${ok}, contour ${contour.length}`)
        if (!ok || contour.length < 3) continue
        polygons.push(contour)
      }
      // hole loops the covered ground never touches: earcut holes of the polygon that contains them
      for (const contour of polygons) {
        const holes: Pt[][] = []
        for (const li of untouched) { const h = loops[li]!; if (inRing(h[0]!.x, h[0]!.z, contour)) holes.push([...h].reverse()) }
        emitPolygon(r.owner, contour, holes, r.ring.sRange, (x, z) => !covered(x, z) && insideRing(x, z))
      }
      // an uncovered pocket bounded by the covered ground alone — a loop of U that none of this
      // ring's loops crosses — that lies inside the ring is the ring's ground too (the Casio
      // triangle's middle, beyond both legs' rasters, inside the turf island)
      for (let li = 0; li < uLoops.length; li++) {
        if (claimedLoops.has(li)) continue
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
        claimedLoops.add(li)
        const holes: Pt[][] = []
        for (const li2 of untouched) { const h = loops[li2]!; if (inRing(h[0]!.x, h[0]!.z, loop.map((v) => ({ x: pool.x[v]!, z: pool.z[v]! })))) holes.push([...h].reverse()) }
        emitPolygon(r.owner, loop.map((v) => ({ x: pool.x[v]!, z: pool.z[v]!, v })), holes, r.ring.sRange, (x, z) => !covered(x, z) && insideRing(x, z))
      }
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
  return { group, faces, yAt: makeBuiltY(faces), stats: { vertices: N, triangles, cells: cells.length, dropped, byKind, worldTris, stitchTris, buildMs: performance.now() - t0, errors, uncoveredArcs, strips: stripStats, boundary: { loops: uLoops.map((l) => l.length), skipped: uBad } } }
}

/**
 * The drawn ground at (x, z): every face's triangles in an 8 m XZ hash, built on first use (the
 * decals and the objects standing on the ground ask; a scene that never asks pays nothing).
 * Returns the TOPMOST face containing the point — after the plan, no two faces should, but the
 * lookup does not assume it.
 */
function makeBuiltY(faces: GroundFace[]): BuiltGround['yAt'] {
  const CELL = 8
  let cells: Map<number, number[]> | null = null
  const key = (ix: number, iz: number) => (ix + 32768) * 65536 + (iz + 32768)
  const build = () => {
    cells = new Map()
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
          const k = key(i, j)
          let arr = cells.get(k)
          if (!arr) { arr = []; cells.set(k, arr) }
          arr.push(id)
        }
      }
    }
  }
  return (x, z) => {
    if (!cells) build()
    const arr = cells!.get(key(Math.floor(x / CELL), Math.floor(z / CELL)))
    if (!arr) return null
    let best: { y: number; kind: OwnerKind; src: number } | null = null
    for (const id of arr) {
      const f = Math.floor(id / 4194304), t = id - f * 4194304
      const face = faces[f]!
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
}
