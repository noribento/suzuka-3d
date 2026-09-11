import type { SurWay } from '~/data/en-codec'
import { enBBox, worldRing } from '~/data/en-codec'
import { SUR_ROADS, SUR_SITES } from '~/data/suzuka-surroundings'
import { ROAD_SECTION, ROADS, roadSectionOf, type RoadSection } from '~/data/surroundings-spec'
import type { EnvBuildContext } from './environment'
import { ringBBox, ringFromFlat, type XZ } from './far-geometry'
import { pathLength, type Rect } from './far-lines'
import { FAR_CELL_M, MERGE_CELLS } from './farfield'
import type { LandCover } from './landcover'

/**
 * The public road NETWORK outside the fences (plan R フェーズ Phase 1) — one shared reading of
 * `SUR_ROADS` that every road consumer walks: the ribbons (roads.ts), the furniture, the utility
 * poles, the cherry rows, the building fronts and the terrain-side crossings. Pure XZ geometry:
 * nothing here reads a height, the only ground-side inputs are the land-cover masks (settlement
 * weight for the signals, the parking class for the keep-outs) and the far field's cell index.
 *
 * What the network adds to the shipped polylines (DP 1.0 m chords with the junction nodes kept):
 *  - junctions by vertex coincidence (a 0.05 m hash over the vertices of different OSM ways —
 *    the generator protects shared nodes through the simplification, so no node table is shipped);
 *  - precedence at every junction (`ROAD_SECTION.rank`): a way ENDING on a road that passes
 *    through, or on a higher-ranked road, is trimmed back to that road's paved edge + `ROADS.trim`
 *    so the ribbons overlap by a fixed 0.3 m; at a corner where every way ends, each way overshoots
 *    by the mitre of the outer edges (`hw` of the other at 90°, nothing on a straight continuation)
 *    so the outer wedge is paved — the ribbons share world-space asphalt texels, so the overlap is
 *    invisible and the class rung (`ROAD_SECTION.lift`) decides who is on top;
 *  - fillets at every interior kink of at least `ROADS.fillet.minKinkDeg` (except at junction
 *    vertices, which must stay where the other road meets them): `R = min(rMax[kind],
 *    0.45·min(L1, L2) / tan(φ/2))`, skipped under `hw + verge + 0.5` (an inner-bend row would
 *    fold), tessellated at ≤ `ROADS.arcDeg` and ≤ one straight step per chord;
 *  - the markings in force along the way as windows in s (junction mouths, stop bars, zebras,
 *    the yellow no-overtaking line on tight tertiary+ bends) reduced to per-sample integers, with
 *    every marking change carried by a DUPLICATED sample (same position, new attributes) so an
 *    integer attribute never interpolates across a ribbon triangle;
 *  - `dLo`, the 1-Lipschitz lower bound of the centreline distance every far-field rule uses to
 *    avoid the exact projection (`ground.plan.project`) where the answer is settled anyway.
 *
 * Sides: `offsetAt(sample, +lateral)` is the `(tz, −tx)` side of the tangent — the driver's LEFT
 * (world x = east, z = south: heading east, +lateral points north), the same sense as the track
 * frame's positive lateral — and `edgeL` / `curvature > 0` / "left" in this module all mean that
 * side. Japan drives on the left, so the near-side furniture (stop signs, poles, gutters) takes
 * +lateral. (The outskirts' pole / guardrail code uses the mirrored `(−tz, tx)` formula with its
 * own `side` sign; it is being moved onto this module in Phase 3.)
 */

// ---------------------------------------------------------------------------------------------
// public types

export interface RoadSample {
  x: number
  z: number
  /** unit tangent (direction of increasing s) */
  tx: number
  tz: number
  /** arc length along the smoothed path (m) */
  s: number
  /** signed curvature (1/R, + = turning towards +lateral) on fillet arcs, 0 on straights */
  curvature: number
  /** lower bound of the centreline distance: the row's dmin minus the sample's distance to the nearest ORIGINAL vertex */
  dLo: number
  /** centre line in force here: 0 none, 1 dashed white, 2 solid white, 3 solid yellow */
  centre: 0 | 1 | 2 | 3
  /** edge lines in force on the +lateral / −lateral side */
  edgeL: boolean
  edgeR: boolean
  /** signed along-distance (m, in the way's s direction) to the nearest stop bar within ±30 m, else 1000 — the bar is at 0, positive = past it */
  stop: number
  /** +1 when that bar serves traffic travelling +s (towards the way's end), −1 for −s, 0 when there is none */
  stopDir: 1 | -1 | 0
  /** signed along-distance to the nearest zebra centre within ±30 m (the crossing spans ± ZEBRA_HALF), else 1000 */
  zebra: number
}

export interface Junction {
  x: number
  z: number
  /** every way meeting here (a way that passes through appears once); `end`: it starts or ends here; `s`: where on its path */
  ways: { way: RoadWay; end: boolean; s: number }[]
  /** the through way with the highest rank, else the highest rank overall (ties: the longer way) */
  major: RoadWay
  /** traffic lights: tertiary+ meets tertiary+ inside a settlement, or the junction nearest a circuit gate */
  signal: boolean
}

/** one vertex of the smoothed path; `arc` indexes `RoadWay.arcs` for the vertices of a fillet (its two tangent points included), −1 on straights */
export interface PathVertex {
  x: number
  z: number
  s: number
  curvature: number
  arc: number
}

/** one fillet: the arc between s0 and s1, its radius, the kink it replaced (rad), the original corner and the arc centre */
export interface FilletArc {
  s0: number
  s1: number
  R: number
  kink: number
  corner: XZ
  centre: XZ
}

export interface RoadWay {
  row: SurWay
  kind: string
  section: RoadSection
  /** paved half-width (m) */
  hw: number
  /** the original (DP'd) polyline in world XZ */
  pts: XZ[]
  /** trims and fillets applied: the smoothed path as a dense polyline; a segment lies on an arc iff both its vertices carry the same `arc` */
  path: PathVertex[]
  arcs: FilletArc[]
  /** length of `path` (m) */
  length: number
  bridge: boolean
  layer: number
  /** every junction on the way with its s on the path (an end's junction point lies beyond a trimmed end: s < 0 or s > length) and the trim applied there */
  junctions: { s: number; j: Junction; role: 'end' | 'through'; trim: number }[]
  /** how much the ends were trimmed (+) or overshot (−), metres */
  trimStart: number
  trimEnd: number
  /** marking windows in s ([s0, s1]) where the centre line / +lateral edge / −lateral edge are suppressed */
  noCentre: [number, number][]
  noEdgeL: [number, number][]
  noEdgeR: [number, number][]
  /** solid yellow centre line windows (tight fillets on tertiary+) */
  yellow: [number, number][]
  /** stop bars (`dir` as `RoadSample.stopDir`) and zebra centres, in s */
  stops: { s: number; dir: 1 | -1 }[]
  zebras: { s: number }[]
  /**
   * the ribbon's samples: straights every `ROADS.stepStraight · stepScale`, arcs at ≤ `ROADS.arcDeg
   * · stepScale` (and ≤ one straight step per chord), plus a sample at every marking-window
   * boundary, every special's ±30 m reach and the ends; where a marking changes the sample is
   * DUPLICATED (same position, new markings)
   */
  samples: RoadSample[]
  /** the bbox overlaps the terrain grid / reaches beyond it onto the coarse ring */
  inGrid: boolean
  onRing: boolean
  /** [minX, minZ, maxX, maxZ] of the path */
  bbox: [number, number, number, number]
}

export interface RoadNet {
  ways: RoadWay[]
  junctions: Junction[]
  /** `farField.cellOf` → indices into `ways` (the far field's 'outside' cell included) */
  byCell: Map<number, number[]>
  /** 1 km block → way indices; block = floor(cx / 4) + floor(cz / 4) · ceil(ncx / 4) over the far-field cells, −1 for the outside cell */
  byBlock: Map<number, number[]>
  stats: RoadNetStats
}

export interface RoadNetStats {
  rows: number
  ways: number
  junctions: number
  /** ends trimmed back / overshot at a corner */
  trims: number
  overshoots: number
  /** fillets applied / kinks left as corners because R would be too small (or the vertex is a junction) */
  fillets: number
  filletsSkipped: number
  signals: number
  stops: number
  zebras: number
  samples: number
  buildMs: number
}

/** what the network needs of the build context — a structural subset so the Node smoke can assemble it from `buildScene()` */
export type RoadNetContext = Pick<EnvBuildContext, 'track' | 'terrain' | 'ground' | 'quality' | 'landCover' | 'farField'>

/** the zebra spans ± this along the road (m) — `RoadSample.zebra` is the signed distance to its centre */
export const ZEBRA_HALF = 2.0

// ---------------------------------------------------------------------------------------------
// tuning that is not a road-design number (those live in surroundings-spec ROADS)

/** the reach beyond the terrain grid within which rows are decoded — OUTSKIRTS.gridMargin, the same reach the poles use */
const GRID_MARGIN = 1200
/** vertex coincidence hash cell (m) */
const HASH_M = 0.05
/** `stop` / `zebra` carry a signed distance inside this reach (m), 1000 outside it */
const SPECIAL_REACH = 30
const SPECIAL_NONE = 1000
/** the zebra starts this far outside the crossing road's paved edge, the stop bar this far before the zebra (m) */
const ZEBRA_GAP = 1.0
const ZEBRA_STOP_GAP = 1.0
/** a mouth's marking cut reaches this far beyond the minor's half-width along the major (m) */
const MOUTH_PAD = 1.5
/** `ROAD_SECTION.rank` of tertiary: signals need two roads at least this rank, the yellow line is drawn from it up */
const TERTIARY_RANK = ROAD_SECTION.rank.tertiary!
/** the junction nearest a circuit gate within this reach (m) gets lights */
const GATE_SIGNAL_M = 60
/** nothing shorter than this survives the trims (m) */
const MIN_LENGTH = 0.5
/** an end meeting a higher-ranked END at more than this angle between the into-junction directions is a continuation, not a T (mitre, no trim) */
const CONTINUATION_COS = -0.5

// ---------------------------------------------------------------------------------------------
// small geometry

/** unit direction a → b and the distance */
function dirOf(a: XZ, b: XZ): [number, number, number] {
  const dx = b[0] - a[0], dz = b[1] - a[1]
  const l = Math.hypot(dx, dz)
  return l > 0 ? [dx / l, dz / l, l] : [1, 0, 0]
}

/** 2D cross product in (x, z): positive when `b` is on the +lateral (left) side of `a` — see the module header */
function cross(ax: number, az: number, bx: number, bz: number): number {
  return az * bx - ax * bz
}

/** drop consecutive duplicates (the decoder never ships them, the cuts can make one) */
function dedupe(pts: XZ[], orig: number[]): { pts: XZ[]; orig: number[] } {
  const p: XZ[] = [], o: number[] = []
  for (let i = 0; i < pts.length; i++) {
    const q = pts[i]!
    const last = p[p.length - 1]
    if (last && Math.hypot(q[0] - last[0], q[1] - last[1]) < 1e-6) {
      // keep the original index if either copy had one
      if (o[o.length - 1]! < 0) o[o.length - 1] = orig[i]!
      continue
    }
    p.push(q)
    o.push(orig[i]!)
  }
  return { pts: p, orig: o }
}

/**
 * The sub-polyline between arc lengths `a` and `b` (`a` < 0 / `b` > length extend the end
 * segments along their tangents), with each kept vertex's original index (−1 for a synthetic end).
 */
function cutPolyline(pts: readonly XZ[], a: number, b: number): { pts: XZ[]; orig: number[] } {
  const n = pts.length
  const cum = new Float64Array(n)
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1]! + Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1])
  const len = cum[n - 1]!
  const out: XZ[] = [], orig: number[] = []
  let i0: number
  if (a <= 1e-9) {
    if (a < -1e-9) {
      const [ux, uz] = dirOf(pts[0]!, pts[1]!)
      out.push([pts[0]![0] + ux * a, pts[0]![1] + uz * a])
      orig.push(-1)
    }
    i0 = 0
  } else {
    let i = 0
    while (i < n - 2 && cum[i + 1]! <= a) i++
    const t = (a - cum[i]!) / Math.max(1e-9, cum[i + 1]! - cum[i]!)
    out.push([pts[i]![0] + (pts[i + 1]![0] - pts[i]![0]) * t, pts[i]![1] + (pts[i + 1]![1] - pts[i]![1]) * t])
    orig.push(-1)
    i0 = i + 1
  }
  let i1: number
  let endPt: XZ | null = null
  if (b >= len - 1e-9) {
    i1 = n - 1
    if (b > len + 1e-9) {
      const [ux, uz] = dirOf(pts[n - 2]!, pts[n - 1]!)
      endPt = [pts[n - 1]![0] + ux * (b - len), pts[n - 1]![1] + uz * (b - len)]
    }
  } else {
    let i = n - 2
    while (i > 0 && cum[i]! >= b) i--
    const t = (b - cum[i]!) / Math.max(1e-9, cum[i + 1]! - cum[i]!)
    endPt = [pts[i]![0] + (pts[i + 1]![0] - pts[i]![0]) * t, pts[i]![1] + (pts[i + 1]![1] - pts[i]![1]) * t]
    i1 = i
  }
  for (let i = i0; i <= i1; i++) {
    out.push([pts[i]![0], pts[i]![1]])
    orig.push(i)
  }
  if (endPt) {
    out.push(endPt)
    orig.push(-1)
  }
  return dedupe(out, orig)
}

/** distance from (x, z) to the nearest vertex of `pts` */
function nearestVertex(pts: readonly XZ[], x: number, z: number): number {
  let best = Infinity
  for (const p of pts) {
    const d = (p[0] - x) * (p[0] - x) + (p[1] - z) * (p[1] - z)
    if (d < best) best = d
  }
  return Math.sqrt(best)
}

function rectsOverlap(b: readonly [number, number, number, number], r: Rect): boolean {
  return b[2] >= r.x0 && b[0] <= r.x0 + r.w && b[3] >= r.z0 && b[1] <= r.z0 + r.d
}

function rectContains(b: readonly [number, number, number, number], r: Rect): boolean {
  return b[0] >= r.x0 && b[2] <= r.x0 + r.w && b[1] >= r.z0 && b[3] <= r.z0 + r.d
}

function inWindows(w: readonly [number, number][], s: number): boolean {
  for (const [a, b] of w) if (s >= a && s <= b) return true
  return false
}

// ---------------------------------------------------------------------------------------------
// fillets

/**
 * Replace the interior kinks of `sub` by tangent arcs (plan A2): at vertex k with kink φ,
 * `R = min(rMax, 0.45·min(L1, L2)/tan(φ/2))` — two fillets on one segment use at most 0.9 of it —
 * unless R < rMin (the inner ribbon row would fold) or the vertex is a junction (`keep`). The
 * tessellation step is the smaller of `stepRad` and `maxChord / R` so an arc never makes a longer
 * chord than a straight. Returns the dense path with s, the arcs, and where every vertex of `sub`
 * landed on the path (a filleted vertex → its arc's midpoint).
 */
function filletPath(sub: readonly XZ[], keep: (k: number) => boolean, rMax: number, rMin: number, minKink: number, stepRad: number, maxChord: number): { path: PathVertex[]; arcs: FilletArc[]; vertexS: Float64Array; skipped: number } {
  const n = sub.length
  const path: PathVertex[] = [{ x: sub[0]![0], z: sub[0]![1], s: 0, curvature: 0, arc: -1 }]
  const arcs: FilletArc[] = []
  const vertexS = new Float64Array(n)
  let skipped = 0
  const push = (x: number, z: number, curvature: number, arc: number): number => {
    const last = path[path.length - 1]!
    const s = last.s + Math.hypot(x - last.x, z - last.z)
    path.push({ x, z, s, curvature, arc })
    return s
  }
  for (let k = 1; k < n - 1; k++) {
    const p = sub[k]!
    const [u1x, u1z, L1] = dirOf(sub[k - 1]!, p)
    const [u2x, u2z, L2] = dirOf(p, sub[k + 1]!)
    const cr = cross(u1x, u1z, u2x, u2z)
    const phi = Math.atan2(Math.abs(cr), u1x * u2x + u1z * u2z)
    if (phi < minKink || phi > Math.PI - 0.01 || keep(k)) {
      vertexS[k] = push(p[0], p[1], 0, -1)
      continue
    }
    const tanHalf = Math.tan(phi / 2)
    const R = Math.min(rMax, (0.45 * Math.min(L1, L2)) / tanHalf)
    if (R < rMin) {
      skipped++
      vertexS[k] = push(p[0], p[1], 0, -1)
      continue
    }
    const d = R * tanHalf
    const t1x = p[0] - u1x * d, t1z = p[1] - u1z * d
    const t2x = p[0] + u2x * d, t2z = p[1] + u2z * d
    // the centre sits R off the first tangent point on the turn side; the +lateral normal of u1 is (u1z, −u1x)
    const sgn = cr > 0 ? 1 : -1
    const cx = t1x + u1z * R * sgn, cz = t1z - u1x * R * sgn
    const curvature = sgn / R
    const arc = arcs.length
    const steps = Math.max(1, Math.ceil(phi / Math.min(stepRad, maxChord / R)))
    const s0 = push(t1x, t1z, curvature, arc)
    // the radius vector turns with the tangent: a left turn (sgn > 0) sweeps −φ in the atan2(z, x) sense
    const a0 = Math.atan2(t1z - cz, t1x - cx)
    for (let i = 1; i < steps; i++) {
      const a = a0 - (sgn * phi * i) / steps
      push(cx + R * Math.cos(a), cz + R * Math.sin(a), curvature, arc)
    }
    const s1 = push(t2x, t2z, curvature, arc)
    arcs.push({ s0, s1, R, kink: phi, corner: [p[0], p[1]], centre: [cx, cz] })
    vertexS[k] = (s0 + s1) / 2
  }
  vertexS[n - 1] = push(sub[n - 1]![0], sub[n - 1]![1], 0, -1)
  return { path, arcs, vertexS, skipped }
}

// ---------------------------------------------------------------------------------------------
// the path

/** the path segment index holding arc length s (the last segment for s ≥ length) */
function segmentAt(path: readonly PathVertex[], s: number): number {
  let lo = 0, hi = path.length - 2
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (path[mid]!.s <= s) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * The tangent at path vertex i: the mean of the two chords meeting there (the mitre direction at a
 * kept kink, the exact tangent of an arc at its vertices), the one chord at the ends.
 */
function vertexTangent(path: readonly PathVertex[], i: number): [number, number] {
  const n = path.length
  const p = path[i]!
  if (i === 0 || i === n - 1) {
    const [tx, tz] = i === 0 ? dirOf([p.x, p.z], [path[1]!.x, path[1]!.z]) : dirOf([path[n - 2]!.x, path[n - 2]!.z], [p.x, p.z])
    return [tx, tz]
  }
  const [ax, az] = dirOf([path[i - 1]!.x, path[i - 1]!.z], [p.x, p.z]), [bx, bz] = dirOf([p.x, p.z], [path[i + 1]!.x, path[i + 1]!.z])
  const sx = ax + bx, sz = az + bz
  const l = Math.hypot(sx, sz)
  return l > 1e-6 ? [sx / l, sz / l] : [ax, az]
}

/**
 * Position, tangent and curvature at arc length s on the smoothed path (clamped to the ends).
 * The tangent is the chord's along a straight, the vertex tangent at a vertex (so a kept kink
 * gets a mitred cross-section instead of a folded one) and, along an arc chord, the vertex
 * tangents blended — the arc's own tangent to within the tessellation.
 */
function pathAt(way: RoadWay, s: number): { x: number; z: number; tx: number; tz: number; curvature: number } {
  const path = way.path
  const i = segmentAt(path, s)
  const a = path[i]!, b = path[i + 1]!
  let [tx, tz, l] = dirOf([a.x, a.z], [b.x, b.z])
  const u = l > 0 ? Math.max(0, Math.min(1, (s - a.s) / l)) : 0
  const onArc = a.arc >= 0 && a.arc === b.arc
  if (u < 1e-9 || u > 1 - 1e-9) [tx, tz] = vertexTangent(path, u < 1e-9 ? i : i + 1)
  else if (onArc) {
    const [ax, az] = vertexTangent(path, i), [bx, bz] = vertexTangent(path, i + 1)
    const mx = ax + (bx - ax) * u, mz = az + (bz - az) * u
    const ml = Math.hypot(mx, mz)
    if (ml > 1e-6) [tx, tz] = [mx / ml, mz / ml]
  }
  return { x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u, tx, tz, curvature: onArc ? a.curvature : 0 }
}

/** the sample whose s is nearest (ties: the later copy, i.e. the markings AFTER a boundary) */
function nearestSample(samples: readonly RoadSample[], s: number): RoadSample {
  let lo = 0, hi = samples.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (samples[mid]!.s <= s) lo = mid
    else hi = mid - 1
  }
  const a = samples[lo]!, b = samples[lo + 1]
  return b && b.s - s < s - a.s ? b : a
}

/** the marking integers in force at s (windows evaluated exactly at s) */
function marksAt(way: RoadWay, s: number): Pick<RoadSample, 'centre' | 'edgeL' | 'edgeR' | 'stop' | 'stopDir' | 'zebra'> {
  const sec = way.section
  let centre: 0 | 1 | 2 | 3 = 0
  if (sec.centre !== 'none' && !inWindows(way.noCentre, s)) centre = inWindows(way.yellow, s) ? 3 : sec.centre === 'dashed' ? 1 : 2
  const edgeL = sec.edgeLines && !inWindows(way.noEdgeL, s)
  const edgeR = sec.edgeLines && !inWindows(way.noEdgeR, s)
  let stop = SPECIAL_NONE, stopDir: 1 | -1 | 0 = 0, bestStop = SPECIAL_REACH
  for (const b of way.stops) {
    const d = Math.abs(s - b.s)
    if (d <= bestStop) {
      bestStop = d
      stop = s - b.s
      stopDir = b.dir
    }
  }
  let zebra = SPECIAL_NONE, bestZebra = SPECIAL_REACH
  for (const z of way.zebras) {
    const d = Math.abs(s - z.s)
    if (d <= bestZebra) {
      bestZebra = d
      zebra = s - z.s
    }
  }
  return { centre, edgeL, edgeR, stop, stopDir, zebra }
}

/** the s values at which a marking integer or a special's reference can change: every cut the ribbon needs */
function markingEvents(way: RoadWay): number[] {
  const ev: number[] = []
  for (const w of [way.noCentre, way.noEdgeL, way.noEdgeR, way.yellow]) for (const [a, b] of w) ev.push(a, b)
  for (const list of [way.stops, way.zebras]) {
    const ss = list.map((e) => e.s).sort((a, b) => a - b)
    for (let i = 0; i < ss.length; i++) {
      ev.push(ss[i]! - SPECIAL_REACH, ss[i]! + SPECIAL_REACH)
      // two specials inside each other's reach: the nearer one takes over at the midpoint
      if (i + 1 < ss.length && ss[i + 1]! - ss[i]! < 2 * SPECIAL_REACH) ev.push((ss[i]! + ss[i + 1]!) / 2)
    }
  }
  return ev.filter((s) => s > 1e-6 && s < way.length - 1e-6)
}

function buildSamples(way: RoadWay, step: number): RoadSample[] {
  const path = way.path
  // the base s list: every path vertex, straights subdivided evenly under `step`
  const base: number[] = []
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i]!, b = path[i + 1]!
    base.push(a.s)
    if (a.arc >= 0 && a.arc === b.arc) continue
    const L = b.s - a.s
    const n = Math.ceil(L / step - 1e-9)
    for (let k = 1; k < n; k++) base.push(a.s + (L * k) / n)
  }
  base.push(way.length)
  // the cuts: marking events merged within 0.1 mm into [first, last] groups, each emitted as one
  // sample pair — the markings before the first event and after the last
  const groups: [number, number][] = []
  for (const s of markingEvents(way).sort((a, b) => a - b)) {
    const g = groups[groups.length - 1]
    if (g && s - g[1] <= 1e-4) g[1] = s
    else groups.push([s, s])
  }
  const out: RoadSample[] = []
  const emit = (s: number, sMark: number) => {
    const p = pathAt(way, s)
    const m = marksAt(way, sMark)
    out.push({ x: p.x, z: p.z, tx: p.tx, tz: p.tz, s, curvature: p.curvature, dLo: way.row.dmin - nearestVertex(way.pts, p.x, p.z), ...m })
  }
  // a cut: the sample before the group and, only when a marking actually changes across it
  // (overlapping windows share boundaries), the twin after it
  const cut = ([lo, hi]: [number, number]) => {
    emit(lo, lo - 1e-5)
    const before = out[out.length - 1]!
    const after = marksAt(way, hi + 1e-5)
    // the specials are continuous: what matters is whether they reference the same bar / crossing
    const sameRef = (a: number, b: number) => (a === SPECIAL_NONE) === (b === SPECIAL_NONE) && (a === SPECIAL_NONE || Math.abs(lo - 1e-5 - a - (hi + 1e-5 - b)) < 1e-3)
    if (before.centre === after.centre && before.edgeL === after.edgeL && before.edgeR === after.edgeR && before.stopDir === after.stopDir && sameRef(before.stop, after.stop) && sameRef(before.zebra, after.zebra)) return
    emit(lo, hi + 1e-5)
  }
  let gi = 0
  for (const s of base) {
    // every cut group before this base sample, then the sample itself unless a group swallows it
    while (gi < groups.length && groups[gi]![0] < s - 1e-4) cut(groups[gi++]!)
    const prev = groups[gi - 1], cur = groups[gi]
    if ((prev && prev[1] >= s - 1e-4) || (cur && cur[0] <= s + 1e-4)) continue
    emit(s, s)
  }
  while (gi < groups.length) cut(groups[gi++]!)
  return out
}

// ---------------------------------------------------------------------------------------------
// the network

/** one way's presence at a junction (build-time) */
interface JEntry {
  way: RoadWay
  end: boolean
  /** the end is the way's first vertex (its path leaves the junction) */
  atStart: boolean
  /** the way's tangent at the junction in its own s direction */
  tx: number
  tz: number
  /** unit direction from the junction into the way's body (ends only) */
  ax: number
  az: number
  /** the original vertex index */
  vertex: number
  /** s of the junction on the way's final path */
  s: number
  /** + trimmed back, − overshot (ends only) */
  trim: number
}

/** the half-width of `o` measured along `e` where the two cross at angle θ: hw / sin θ, capped at 2 hw */
function mouthHalf(e: JEntry, o: JEntry): number {
  return o.way.hw / Math.max(0.5, Math.abs(cross(e.tx, e.tz, o.tx, o.tz)))
}

/** the better of two entries for the "major" choice: rank, then length */
function better(a: JEntry, b: JEntry): boolean {
  return a.way.section.rank > b.way.section.rank || (a.way.section.rank === b.way.section.rank && a.way.length > b.way.length)
}

function best(list: JEntry[]): JEntry {
  let b = list[0]!
  for (const e of list) if (better(e, b)) b = e
  return b
}

/** the into-junction direction of an end entry */
function into(e: JEntry): [number, number] {
  return e.atStart ? [-e.tx, -e.tz] : [e.tx, e.tz]
}

/**
 * How far an end must overshoot the junction so its outer edge meets the other end's outer edge
 * (the mitre of the corner's outer edges): `hw_other` at 90°, nothing on a straight continuation,
 * capped at the wider half-width for the sharp corners the formula blows up on.
 */
function mitre(e: JEntry, o: JEntry): number {
  const [ix, iz] = into(e), [ox, oz] = into(o)
  // θ = the turn from e's into-direction onto o's away-direction (−o.into)
  const cosT = -(ix * ox + iz * oz), sinT = Math.abs(cross(ix, iz, ox, oz))
  if (sinT < 0.05) return 0
  const hwW = e.way.hw, hwO = o.way.hw
  const xM = hwO * sinT + (cosT * (hwO * cosT - hwW)) / sinT
  return Math.max(0, Math.min(Math.max(hwW, hwO), xM))
}

/** which of the way's edges faces `o` at the junction: +1 = the +lateral side (edgeL) */
function sideOf(e: JEntry, o: JEntry): 1 | -1 {
  return cross(e.tx, e.tz, o.ax, o.az) > 0 ? 1 : -1
}

const NETS = new WeakMap<object, Map<string, RoadNet>>()

/**
 * The road network for a build context (memoised per context and options). `stepScale` defaults
 * to `quality.farField.roads.stepScale` when the tier declares it (1 otherwise); `ring` extends
 * the decoded extent from the terrain grid to the coarse ring (`quality.farField.roads.ring`).
 */
export function roadNetwork(ctx: RoadNetContext, opts: { stepScale?: number; ring?: boolean } = {}): RoadNet {
  const fq = ctx.quality.farField as typeof ctx.quality.farField & { roads?: { stepScale?: number; ring?: boolean } }
  const stepScale = opts.stepScale ?? fq.roads?.stepScale ?? 1
  const ring = opts.ring ?? fq.roads?.ring ?? false
  const key = `${stepScale}|${ring ? 1 : 0}`
  let per = NETS.get(ctx)
  if (!per) NETS.set(ctx, (per = new Map()))
  let net = per.get(key)
  if (!net) per.set(key, (net = buildNetwork(ctx, stepScale, ring)))
  return net
}

function buildNetwork(ctx: RoadNetContext, stepScale: number, ring: boolean): RoadNet {
  const t0 = performance.now()
  const enScale = ctx.track.enScale
  const grid = ctx.terrain.grid()
  const gridRect: Rect = { x0: grid.x0, z0: grid.z0, w: grid.w, d: grid.d }
  const r = ctx.terrain.ring
  const ringRect: Rect = { x0: r.x0, z0: r.z0, w: (r.nx - 1) * r.dx, d: (r.nz - 1) * r.dz }
  const reach: Rect = ring ? ringRect : gridRect
  const extent: Rect = { x0: reach.x0 - GRID_MARGIN, z0: reach.z0 - GRID_MARGIN, w: reach.w + 2 * GRID_MARGIN, d: reach.d + 2 * GRID_MARGIN }
  const step = ROADS.stepStraight * stepScale
  const stepRad = (ROADS.arcDeg * stepScale * Math.PI) / 180
  const minKink = (ROADS.fillet.minKinkDeg * Math.PI) / 180

  // --- 1. decode the rows inside the extent ------------------------------------------------------
  const ways: RoadWay[] = []
  for (const row of SUR_ROADS) {
    const [e0, n0, e1, n1] = enBBox(row)
    // EN → world flips north: the world z range is [−n1, −n0]
    const box: [number, number, number, number] = [e0 * enScale, -n1 * enScale, e1 * enScale, -n0 * enScale]
    if (!rectsOverlap(box, extent)) continue
    const section = roadSectionOf(row.kind, row.tags)
    if (!section) continue
    const raw = ringFromFlat(worldRing(row, enScale))
    const { pts } = dedupe(raw, raw.map((_, i) => i))
    if (pts.length < 2) continue
    const bridgeTag = row.tags.bridge
    ways.push({
      row, kind: row.kind, section, hw: section.paved / 2, pts, path: [], arcs: [], length: 0,
      bridge: bridgeTag !== undefined && bridgeTag !== 'no', layer: parseInt(row.tags.layer ?? '', 10) || 0,
      junctions: [], trimStart: 0, trimEnd: 0, noCentre: [], noEdgeL: [], noEdgeR: [], yellow: [], stops: [], zebras: [],
      samples: [], inGrid: false, onRing: false, bbox: [0, 0, 0, 0],
    })
  }

  // --- 2. junctions: vertices of different OSM ways in the same 5 cm hash cell ----------------------
  const hash = new Map<string, { wi: number; k: number }[]>()
  for (let wi = 0; wi < ways.length; wi++) {
    const w = ways[wi]!
    for (let k = 0; k < w.pts.length; k++) {
      const p = w.pts[k]!
      const key = `${Math.round(p[0] / HASH_M)},${Math.round(p[1] / HASH_M)}`
      let cell = hash.get(key)
      if (!cell) hash.set(key, (cell = []))
      cell.push({ wi, k })
    }
  }
  const junctions: Junction[] = []
  const entriesOf = new Map<Junction, JEntry[]>()
  // the way's tangent at a vertex in its s direction: the mean of the adjacent segment directions
  const tangentAt = (w: RoadWay, k: number): [number, number] => {
    const n = w.pts.length
    if (k === 0 || k === n - 1) {
      const [ux, uz] = k === 0 ? dirOf(w.pts[0]!, w.pts[1]!) : dirOf(w.pts[n - 2]!, w.pts[n - 1]!)
      return [ux, uz]
    }
    const [ax, az] = dirOf(w.pts[k - 1]!, w.pts[k]!), [bx, bz] = dirOf(w.pts[k]!, w.pts[k + 1]!)
    const sx = ax + bx, sz = az + bz
    const l = Math.hypot(sx, sz)
    return l > 1e-6 ? [sx / l, sz / l] : [ax, az]
  }
  for (const cell of hash.values()) {
    if (cell.length < 2) continue
    const ids = new Set(cell.map((c) => ways[c.wi]!.row.id))
    if (ids.size < 2) continue
    let x = 0, z = 0
    for (const c of cell) {
      x += ways[c.wi]!.pts[c.k]![0]
      z += ways[c.wi]!.pts[c.k]![1]
    }
    const j: Junction = { x: x / cell.length, z: z / cell.length, ways: [], major: ways[cell[0]!.wi]!, signal: false }
    const entries: JEntry[] = []
    const seenLoop = new Set<number>()
    for (const c of cell) {
      const w = ways[c.wi]!
      const n = w.pts.length
      const closed = n > 2 && Math.hypot(w.pts[0]![0] - w.pts[n - 1]![0], w.pts[0]![1] - w.pts[n - 1]![1]) < 1e-6
      const isEnd = c.k === 0 || c.k === n - 1
      if (closed && isEnd) {
        // a loop's closing vertex is a through vertex, listed once
        if (seenLoop.has(c.wi)) continue
        seenLoop.add(c.wi)
        const [tx, tz] = tangentAt(w, 0)
        entries.push({ way: w, end: false, atStart: false, tx, tz, ax: NaN, az: NaN, vertex: 0, s: 0, trim: 0 })
        continue
      }
      const [tx, tz] = tangentAt(w, c.k)
      let ax = NaN, az = NaN
      if (isEnd) {
        const [dx, dz] = c.k === 0 ? dirOf(w.pts[0]!, w.pts[1]!) : dirOf(w.pts[n - 1]!, w.pts[n - 2]!)
        ax = dx
        az = dz
      }
      entries.push({ way: w, end: isEnd, atStart: isEnd && c.k === 0, tx, tz, ax, az, vertex: c.k, s: 0, trim: 0 })
    }
    junctions.push(j)
    entriesOf.set(j, entries)
  }

  // --- 3. trims and overshoots at every end ----------------------------------------------------------
  let trims = 0, overshoots = 0
  for (const j of junctions) {
    const entries = entriesOf.get(j)!
    for (const e of entries) {
      if (!e.end) continue
      const others = entries.filter((o) => o.way !== e.way)
      if (!others.length) continue
      const throughs = others.filter((o) => !o.end)
      let opp: JEntry | null = null
      let corner = false
      if (throughs.length) opp = best(throughs)
      else {
        const higher = others.filter((o) => o.way.section.rank > e.way.section.rank)
        if (higher.length) {
          opp = best(higher)
          // the higher road ENDS here too: a continuation (the class changes at the node) is a corner, not a T
          const [ix, iz] = into(e), [ox, oz] = into(opp)
          if (ix * ox + iz * oz < CONTINUATION_COS) corner = true
        } else corner = true
      }
      if (opp && !corner) {
        // back to the opponent's paved edge + the overlap, along this way's direction into the junction
        e.trim = (opp.way.hw + ROADS.trim) / Math.max(0.5, Math.abs(cross(e.tx, e.tz, opp.tx, opp.tz)))
        trims++
      } else {
        // a corner: overshoot to the mitre of the outer edges. When another end continues this
        // road (the OSM way changes at the node) its ribbon already covers the wedge on the other
        // sides, so only the mitre against the continuation (≈ 0) applies
        const [ix, iz] = into(e)
        const ends = others.filter((o) => o.end)
        const cont = ends.filter((o) => {
          const [ox, oz] = into(o)
          return ix * ox + iz * oz < CONTINUATION_COS
        })
        let ov = 0
        for (const o of cont.length ? cont : ends) ov = Math.max(ov, mitre(e, o))
        e.trim = -ov
        if (ov > 0) overshoots++
      }
      if (e.atStart) e.way.trimStart = e.trim
      else e.way.trimEnd = e.trim
    }
  }

  // --- 4. the smoothed path: cut the ends, fillet the interior ---------------------------------------
  const junctionVertices = new Map<RoadWay, Set<number>>()
  for (const entries of entriesOf.values()) for (const e of entries) {
    if (e.end) continue
    let set = junctionVertices.get(e.way)
    if (!set) junctionVertices.set(e.way, (set = new Set()))
    set.add(e.vertex)
  }
  let fillets = 0, filletsSkipped = 0
  const vertexSOf = new Map<RoadWay, { vertexS: Float64Array; orig: number[]; firstKept: number; lastKept: number }>()
  for (const w of ways) {
    const len = pathLength(w.pts, false)
    // both ends trimmed further than the way is long: a connector inside the junction — keep a stub
    const cutS = Math.max(0, w.trimStart), cutE = Math.max(0, w.trimEnd)
    if (cutS + cutE > len - MIN_LENGTH) {
      const f = Math.max(0, len - MIN_LENGTH) / (cutS + cutE)
      if (w.trimStart > 0) w.trimStart *= f
      if (w.trimEnd > 0) w.trimEnd *= f
    }
    const sub = cutPolyline(w.pts, w.trimStart, len - w.trimEnd)
    const keepSet = junctionVertices.get(w)
    const keep = (k: number) => {
      const o = sub.orig[k]!
      return o >= 0 && keepSet !== undefined && keepSet.has(o)
    }
    const rMax = ROADS.fillet.rMax[w.kind] ?? 30
    const rMin = w.hw + ROADS.verge + 0.5
    const built = filletPath(sub.pts, keep, rMax, rMin, minKink, stepRad, step)
    w.path = built.path
    w.arcs = built.arcs
    w.length = built.path[built.path.length - 1]!.s
    fillets += built.arcs.length
    filletsSkipped += built.skipped
    let firstKept = Infinity, lastKept = -Infinity
    for (const o of sub.orig) if (o >= 0) {
      if (o < firstKept) firstKept = o
      if (o > lastKept) lastKept = o
    }
    vertexSOf.set(w, { vertexS: built.vertexS, orig: sub.orig, firstKept, lastKept })
  }

  // --- 5. where each junction sits on each way's path -------------------------------------------------
  for (const j of junctions) {
    const entries = entriesOf.get(j)!
    for (const e of entries) {
      const w = e.way
      if (e.end) e.s = e.atStart ? -w.trimStart : w.length + w.trimEnd
      else {
        const m = vertexSOf.get(w)!
        const k = m.orig.indexOf(e.vertex)
        e.s = k >= 0 ? m.vertexS[k]! : e.vertex < m.firstKept ? 0 : w.length
      }
      j.ways.push({ way: w, end: e.end, s: e.s })
      w.junctions.push({ s: e.s, j, role: e.end ? 'end' : 'through', trim: e.trim })
    }
    const throughs = entries.filter((e) => !e.end)
    j.major = best(throughs.length ? throughs : entries).way
  }

  // --- 6. signals: tertiary+ × tertiary+ in a settlement, and the junction nearest each gate ----------
  let signals = 0
  for (const j of junctions) {
    const ranked = new Set<RoadWay>()
    for (const e of entriesOf.get(j)!) if (e.way.section.rank >= TERTIARY_RANK) ranked.add(e.way)
    if (ranked.size >= 2 && ctx.landCover.weightAt(j.x, j.z, 'settle') >= 0.5) j.signal = true
  }
  for (const g of SUR_SITES) {
    if (g.role !== 'gate') continue
    const gx = g.centroid[0] * enScale, gz = -g.centroid[1] * enScale
    let bestJ: Junction | null = null, bestD = GATE_SIGNAL_M
    for (const j of junctions) {
      const d = Math.hypot(j.x - gx, j.z - gz)
      if (d < bestD) {
        bestD = d
        bestJ = j
      }
    }
    if (bestJ) bestJ.signal = true
  }
  for (const j of junctions) if (j.signal) signals++

  // --- 7. marking windows, stop bars and zebras ------------------------------------------------------
  const unmarked = ROAD_SECTION.unmarked
  const stopsAllowed = (w: RoadWay) => !w.section.unsealed && w.kind !== 'track' && !unmarked.includes(w.kind)
  const inside = (w: RoadWay, s: number) => s > MIN_LENGTH / 2 && s < w.length - MIN_LENGTH / 2
  const addWindow = (list: [number, number][], w: RoadWay, a: number, b: number) => {
    const lo = Math.max(0, Math.min(a, b)), hi = Math.min(w.length, Math.max(a, b))
    if (hi > lo) list.push([lo, hi])
  }
  const blank = (w: RoadWay, a: number, b: number) => {
    addWindow(w.noCentre, w, a, b)
    addWindow(w.noEdgeL, w, a, b)
    addWindow(w.noEdgeR, w, a, b)
  }
  const addStop = (w: RoadWay, s: number, dir: 1 | -1) => {
    if (!stopsAllowed(w) || !inside(w, s)) return
    for (const b of w.stops) if (Math.abs(b.s - s) < 0.5) return
    w.stops.push({ s, dir })
  }
  const addZebra = (w: RoadWay, s: number) => {
    if (!inside(w, s)) return
    for (const z of w.zebras) if (Math.abs(z.s - s) < 0.5) return
    w.zebras.push({ s })
  }
  for (const j of junctions) {
    const entries = entriesOf.get(j)!
    for (const e of entries) {
      const w = e.way
      const others = entries.filter((o) => o.way !== w)
      if (!others.length) continue
      if (e.end && e.trim > 0) {
        // the mouth of a minor: nothing painted between the stop bar and the end; at a signal the
        // zebra sits ZEBRA_GAP outside the major's edge (which is `ROADS.trim` past the end by
        // construction) and the bar ZEBRA_STOP_GAP before the zebra
        const sEnd = e.atStart ? 0 : w.length, dir: 1 | -1 = e.atStart ? -1 : 1
        let sBar = sEnd - dir * ROADS.stopLine
        if (j.signal && w.length >= 2 * (ROADS.trim + ZEBRA_GAP + 2 * ZEBRA_HALF + ZEBRA_STOP_GAP)) {
          const sZ = sEnd + dir * ROADS.trim - dir * (ZEBRA_GAP + ZEBRA_HALF)
          addZebra(w, sZ)
          sBar = sZ - dir * (ZEBRA_HALF + ZEBRA_STOP_GAP)
        }
        addStop(w, sBar, dir)
        blank(w, sBar, sEnd)
        continue
      }
      // a through way, or an end nothing trimmed (the major at a corner, or a road whose OSM way
      // changes at the node): every other road here is a mouth (a trimmed end), a corner partner
      // (an untrimmed end) or a crossing (a through way). The arms that exist on this way: both
      // for a through way, the one before / after the junction for an end
      const arms: (1 | -1)[] = !e.end ? [-1, 1] : e.atStart ? [1] : [-1]
      let zebraHalf = 0
      for (const o of others) {
        const half = mouthHalf(e, o) + MOUTH_PAD
        zebraHalf = Math.max(zebraHalf, mouthHalf(e, o) + ZEBRA_GAP + ZEBRA_HALF)
        if (o.end) {
          if (o.trim > 0 || !e.end) {
            // a mouth: this road's edge line on that side is cut across it
            addWindow(sideOf(e, o) > 0 ? w.noEdgeL : w.noEdgeR, w, e.s - half, e.s + half)
          } else if (e.trim < 0) {
            // a corner partner: the centre line and the inner edge stop where its ribbon begins
            const [ix, iz] = into(e), [ox, oz] = into(o)
            const back = o.way.hw * Math.abs(cross(ix, iz, ox, oz))
            const a = e.atStart ? 0 : w.length, b = e.atStart ? e.s + back : e.s - back
            addWindow(w.noCentre, w, a, b)
            addWindow(sideOf(e, o) > 0 ? w.noEdgeL : w.noEdgeR, w, a, b)
          }
          continue
        }
        // a crossing: the edge lines break on both sides; the centre line too unless this road outranks the other
        const rankW = w.section.rank, rankO = o.way.section.rank
        addWindow(w.noEdgeL, w, e.s - half, e.s + half)
        addWindow(w.noEdgeR, w, e.s - half, e.s + half)
        if (rankW <= rankO) addWindow(w.noCentre, w, e.s - half, e.s + half)
        if (rankW < rankO && !j.signal) {
          // crossing a higher road without lights: a stop bar on each approach, unpainted up to the crossing
          const off = mouthHalf(e, o) + ROADS.trim + ROADS.stopLine
          for (const d of arms) {
            if (d > 0 && w.section.oneway) continue
            addStop(w, e.s + d * off, d < 0 ? 1 : -1)
            blank(w, e.s + d * off, e.s)
          }
        }
      }
      if (j.signal) {
        // lights: a zebra on every arm outside the widest mouth, a stop bar before each zebra on
        // the approach arm(s) — a one-way road only approaches on the arm before the junction —
        // and nothing painted between the bars
        const barOff = zebraHalf + ZEBRA_HALF + ZEBRA_STOP_GAP
        for (const d of arms) {
          addZebra(w, e.s + d * zebraHalf)
          if (d > 0 && w.section.oneway) continue
          addStop(w, e.s + d * barOff, d < 0 ? 1 : -1)
          blank(w, e.s + d * barOff, e.s)
        }
      }
    }
  }
  // the yellow no-overtaking line over tight bends of the tertiary+ roads that carry a centre line
  for (const w of ways) {
    if (w.section.rank < TERTIARY_RANK || w.section.centre === 'none') continue
    for (const a of w.arcs) if (a.R < ROADS.yellowR) addWindow(w.yellow, w, a.s0 - 30, a.s1 + 30)
  }

  // --- 8. samples, extents, cells -------------------------------------------------------------------
  const ncx = Math.max(1, Math.ceil(grid.w / FAR_CELL_M))
  const blockCols = Math.ceil(ncx / MERGE_CELLS)
  const outside = ctx.farField.outsideCell
  const blockOf = (cell: number): number => (cell === outside ? -1 : Math.floor((cell % ncx) / MERGE_CELLS) + Math.floor(cell / ncx / MERGE_CELLS) * blockCols)
  const byCell = new Map<number, number[]>()
  const byBlock = new Map<number, number[]>()
  let samples = 0, stops = 0, zebras = 0
  for (let wi = 0; wi < ways.length; wi++) {
    const w = ways[wi]!
    w.stops.sort((a, b) => a.s - b.s)
    w.zebras.sort((a, b) => a.s - b.s)
    w.samples = buildSamples(w, step)
    samples += w.samples.length
    stops += w.stops.length
    zebras += w.zebras.length
    w.bbox = ringBBox(w.path.map((p) => [p.x, p.z] as XZ))
    w.inGrid = rectsOverlap(w.bbox, gridRect)
    w.onRing = rectsOverlap(w.bbox, ringRect) && !rectContains(w.bbox, gridRect)
    const cells = new Set<number>()
    const sm = w.samples
    for (let i = 0; i < sm.length; i++) {
      const a = sm[i]!
      cells.add(ctx.farField.cellOf(a.x, a.z))
      // a corner clipped between two samples: the midpoint catches most of them
      const b = sm[i + 1]
      if (b) cells.add(ctx.farField.cellOf((a.x + b.x) / 2, (a.z + b.z) / 2))
    }
    const blocks = new Set<number>()
    for (const c of cells) {
      let list = byCell.get(c)
      if (!list) byCell.set(c, (list = []))
      list.push(wi)
      blocks.add(blockOf(c))
    }
    for (const b of blocks) {
      let list = byBlock.get(b)
      if (!list) byBlock.set(b, (list = []))
      list.push(wi)
    }
  }
  const stats: RoadNetStats = {
    rows: SUR_ROADS.length, ways: ways.length, junctions: junctions.length, trims, overshoots, fillets, filletsSkipped, signals, stops, zebras, samples,
    buildMs: performance.now() - t0,
  }
  if (import.meta.dev) console.info(`[roadNetwork] ${ways.length} ways of ${SUR_ROADS.length} rows, ${junctions.length} junctions (${signals} signalled), ${trims} trims / ${overshoots} overshoots, ${fillets} fillets (${filletsSkipped} kinks kept), ${stops} stop bars, ${zebras} zebras, ${samples} samples in ${stats.buildMs.toFixed(0)} ms`)
  return { ways, junctions, byCell, byBlock, stats }
}

// ---------------------------------------------------------------------------------------------
// the consumers' API

/** the point `lateral` metres to the +lateral (left-of-travel) side of a sample: [x + tz·lat, z − tx·lat] */
export function offsetAt(s: RoadSample, lateral: number): XZ {
  return [s.x + s.tz * lateral, s.z - s.tx * lateral]
}

/**
 * The sample at arc length s (clamped to the way): position, tangent and curvature interpolated on
 * the smoothed path, the markings from the nearest built sample, `dLo` from the neighbouring
 * samples' bounds (1-Lipschitz: a bound `dLo₁` at s₁ is `dLo₁ − |s − s₁|` at s).
 */
export function sampleAt(way: RoadWay, s: number): RoadSample {
  s = Math.max(0, Math.min(way.length, s))
  const p = pathAt(way, s)
  const near = nearestSample(way.samples, s)
  const m = marksAt(way, s)
  return { x: p.x, z: p.z, tx: p.tx, tz: p.tz, s, curvature: p.curvature, dLo: near.dLo - Math.abs(s - near.s), ...m }
}

/** samples every `pitch` metres of arc length from `phase` (the furniture's resampler) */
export function walk(way: RoadWay, pitch: number, phase = 0): RoadSample[] {
  const out: RoadSample[] = []
  if (!(pitch > 0)) return out
  for (let s = phase; s <= way.length + 1e-9; s += pitch) out.push(sampleAt(way, s))
  return out
}

/** the segment hash behind `nearestRoad`: 100 m tiles of (way, sample pair) references, built once per network */
interface SegHash {
  tiles: Map<number, number[]>
}
const HASHES = new WeakMap<RoadNet, SegHash>()
const TILE_M = 100

function tileKey(i: number, j: number): number {
  return (i + 0x8000) * 0x10000 + (j + 0x8000)
}

function segHash(net: RoadNet): SegHash {
  let h = HASHES.get(net)
  if (h) return h
  const tiles = new Map<number, number[]>()
  const push = (i: number, j: number, wi: number, si: number) => {
    const key = tileKey(i, j)
    let t = tiles.get(key)
    if (!t) tiles.set(key, (t = []))
    t.push(wi, si)
  }
  for (let wi = 0; wi < net.ways.length; wi++) {
    const sm = net.ways[wi]!.samples
    for (let si = 0; si < sm.length - 1; si++) {
      const a = sm[si]!, b = sm[si + 1]!
      if (b.s - a.s < 1e-6) continue
      const i0 = Math.floor(Math.min(a.x, b.x) / TILE_M), i1 = Math.floor(Math.max(a.x, b.x) / TILE_M)
      const j0 = Math.floor(Math.min(a.z, b.z) / TILE_M), j1 = Math.floor(Math.max(a.z, b.z) / TILE_M)
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) push(i, j, wi, si)
    }
  }
  HASHES.set(net, (h = { tiles }))
  return h
}

/** the nearest road within `maxR` of (x, z): the way, the distance, the s of the foot and the tangent there */
export function nearestRoad(net: RoadNet, x: number, z: number, maxR: number): { way: RoadWay; d: number; s: number; tx: number; tz: number } | null {
  const h = segHash(net)
  const i0 = Math.floor((x - maxR) / TILE_M), i1 = Math.floor((x + maxR) / TILE_M)
  const j0 = Math.floor((z - maxR) / TILE_M), j1 = Math.floor((z + maxR) / TILE_M)
  let best: { way: RoadWay; d: number; s: number; tx: number; tz: number } | null = null
  let bestD2 = maxR * maxR
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
    const t = h.tiles.get(tileKey(i, j))
    if (!t) continue
    for (let k = 0; k < t.length; k += 2) {
      const way = net.ways[t[k]!]!
      const a = way.samples[t[k + 1]!]!, b = way.samples[t[k + 1]! + 1]!
      const ex = b.x - a.x, ez = b.z - a.z
      const l2 = ex * ex + ez * ez
      const u = l2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * ex + (z - a.z) * ez) / l2)) : 0
      const dx = x - (a.x + ex * u), dz = z - (a.z + ez * u)
      const d2 = dx * dx + dz * dz
      if (d2 < bestD2) {
        bestD2 = d2
        const l = Math.sqrt(l2)
        best = { way, d: Math.sqrt(d2), s: a.s + (b.s - a.s) * u, tx: l > 0 ? ex / l : a.tx, tz: l > 0 ? ez / l : a.tz }
      }
    }
  }
  return best
}

/**
 * One convex quad per consecutive sample pair at ±(hw + margin) — the keep-out polygons the
 * ribbons push into `ctx.keepOutPolys` so trees and car-park bays stay off the road. Pairs whose
 * midpoint is on a car park (`landCover.classAt === 'parking'`) are skipped: a car park's aisle
 * must not clear the bays around it. On an arc the inner offset is held inside the radius so the
 * quad cannot fold.
 */
export function roadKeepOutQuads(way: RoadWay, margin: number, landCover: LandCover): { ring: XZ[]; box: [number, number, number, number] }[] {
  const out: { ring: XZ[]; box: [number, number, number, number] }[] = []
  const w = way.hw + margin
  const sm = way.samples
  for (let i = 0; i < sm.length - 1; i++) {
    const a = sm[i]!, b = sm[i + 1]!
    if (b.s - a.s < 1e-6) continue
    if (landCover.classAt((a.x + b.x) / 2, (a.z + b.z) / 2) === 'parking') continue
    const c = a.curvature !== 0 ? a.curvature : b.curvature
    const innerMax = c !== 0 ? Math.max(0.1, 1 / Math.abs(c) - 0.05) : w
    const wl = c > 0 ? Math.min(w, innerMax) : w, wr = c < 0 ? Math.min(w, innerMax) : w
    let ring: XZ[] = [offsetAt(a, wl), offsetAt(b, wl), offsetAt(b, -wr), offsetAt(a, -wr)]
    // a kept kink sharper than the margin allows folds the inner edge: the hull still covers the road
    if (!isConvex(ring)) ring = convexHull(ring)
    if (ring.length >= 3) out.push({ ring, box: ringBBox(ring) })
  }
  return out
}

function isConvex(ring: readonly XZ[]): boolean {
  let sgn = 0
  const n = ring.length
  for (let i = 0; i < n; i++) {
    const a = ring[i]!, b = ring[(i + 1) % n]!, c = ring[(i + 2) % n]!
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
    if (Math.abs(cr) < 1e-9) continue
    if (sgn === 0) sgn = cr > 0 ? 1 : -1
    else if ((cr > 0 ? 1 : -1) !== sgn) return false
  }
  return true
}

/** the convex hull of a few points (monotone chain) */
function convexHull(pts: readonly XZ[]): XZ[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const half = (list: readonly XZ[]): XZ[] => {
    const h: XZ[] = []
    for (const q of list) {
      while (h.length >= 2) {
        const a = h[h.length - 2]!, b = h[h.length - 1]!
        if ((b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]) <= 0) h.pop()
        else break
      }
      h.push(q)
    }
    h.pop()
    return h
  }
  return half(p).concat(half(p.slice().reverse()))
}
