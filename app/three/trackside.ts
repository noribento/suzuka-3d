/**
 * Trackside line resolution shared by the barrier / kerb / line builders and the audit overlay
 * (scripts/audit/overlay.mjs): turns a data-table source — OpenStreetMap ways or hand-read
 * (s, lateral) samples — into a lateral-offset function along one stretch of the lap.
 *
 * Everything is expressed as `lateral(s)` on the road the feature belongs to. That is the
 * representation the real barriers have (they run along the road, a few metres off its edge) and
 * it is what keeps a wall on ITS road: the figure-8 fold and the crossover bring two stretches
 * within metres of each other, so every source vertex is mapped with `Track.nearestOnRange`,
 * restricted to the run's own s window, never with the globally nearest sample.
 */
import * as THREE from 'three'
import { OSM_FEATURES, type OsmFeature } from '~/data/suzuka-facilities'
import type { PatchNode, Side } from '~/data/suzuka-facilities-spec'
import { BARRIERS, KERBS } from '~/data/suzuka-barriers-spec'
import { forwardDelta, type Track } from '~/sim/track'

/** [s, lateral] sample, s in driving order inside the owning window */
export type LatSample = [number, number]

export interface ResolvedLine {
  s0: number
  s1: number
  /** samples sorted by forward distance from s0, s wrapped */
  samples: LatSample[]
  /** piecewise-linear lateral at s (clamped to the end samples outside them) */
  lat: (s: number) => number
}

const _v = new THREE.Vector3()
const byId = new Map<number, OsmFeature>(OSM_FEATURES.map((f) => [f.id, f]))

export function osmWay(id: number): OsmFeature | undefined {
  return byId.get(id)
}

/**
 * Several OSM ways chained into one world polyline (GROUND_AREAS `ways` footprints, the way-line
 * decals): each way's vertex range is taken in the direction that meets the chain's current end
 * (or `reverse`), and a vertex within 1 mm of the previous one is dropped. `closed` says the
 * chain's last vertex came back to its first (which is then not repeated).
 */
export function wayChainPath(track: Track, ways: { id: number; verts?: [number, number]; reverse?: boolean }[]): { pts: { x: number; z: number }[]; closed: boolean } {
  const pts: { x: number; z: number }[] = []
  const push = (p: { x: number; z: number }) => { const prev = pts[pts.length - 1]; if (!prev || Math.hypot(p.x - prev.x, p.z - prev.z) > 1e-3) pts.push(p) }
  for (const w of ways) {
    const f = byId.get(w.id)
    if (!f) continue
    const [v0, v1] = w.verts ?? [0, f.en.length - 1]
    let seg = f.en.slice(Math.max(0, v0), Math.min(f.en.length - 1, v1) + 1).map(([e, n]) => ({ x: e * track.enScale, z: -n * track.enScale }))
    if (w.reverse) seg = seg.reverse()
    else if (pts.length && seg.length > 1) {
      // orient the way to meet the chain's end
      const end = pts[pts.length - 1]!
      const dFirst = Math.hypot(seg[0]!.x - end.x, seg[0]!.z - end.z), dLast = Math.hypot(seg[seg.length - 1]!.x - end.x, seg[seg.length - 1]!.z - end.z)
      if (dLast < dFirst) seg = seg.reverse()
    }
    for (const p of seg) push(p)
  }
  let closed = false
  if (pts.length > 3 && Math.hypot(pts[0]!.x - pts[pts.length - 1]!.x, pts[0]!.z - pts[pts.length - 1]!.z) <= 1e-3) { pts.pop(); closed = true }
  return { pts, closed }
}

/** Piecewise-linear interpolation over forward distance from s0 (samples must be sorted by it). */
export function lateralFn(samples: LatSample[], s0: number, L: number): (s: number) => number {
  if (!samples.length) return () => 0
  const d = samples.map((p) => forwardDelta(s0, p[0], L))
  return (s: number) => {
    const t = forwardDelta(s0, s, L)
    if (t <= d[0]!) return samples[0]![1]
    for (let i = 1; i < samples.length; i++) {
      if (t <= d[i]!) {
        const f = (t - d[i - 1]!) / Math.max(1e-6, d[i]! - d[i - 1]!)
        return samples[i - 1]![1] + (samples[i]![1] - samples[i - 1]![1]) * f
      }
    }
    return samples[samples.length - 1]![1]
  }
}

/**
 * Track-side edge of one or more OSM ways along the window [s0, s1] on `side`: every way is
 * densified at 1 m, every point mapped onto the window's stretch of road, and per 4 m of s the
 * point nearest the road is kept — for a wall mapped as a closed area that is its road-facing
 * face, for a polyline it is the line itself. Points further than `reach` metres from the
 * centreline, on the other side, or outside the window (± `pad`) are ignored.
 */
export function osmEdgeSamples(track: Track, ids: number[], sRange: [number, number], side: Side, opts: { reach?: number; pad?: number; bin?: number } = {}): LatSample[] {
  const L = track.length
  const [s0, s1] = sRange
  const len = forwardDelta(s0, s1, L) || L
  const reach = opts.reach ?? 70
  const pad = opts.pad ?? 12
  const bin = opts.bin ?? 4
  const best = new Map<number, LatSample>()
  const world = { x: 0, z: 0 }
  for (const id of ids) {
    const f = byId.get(id)
    if (!f) continue
    const n = f.en.length
    const segs = f.closed ? n : n - 1
    for (let i = 0; i < segs; i++) {
      const a = f.en[i]!, b = f.en[(i + 1) % n]!
      const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])))
      for (let k = 0; k <= steps; k++) {
        const t = k / steps
        world.x = (a[0] + (b[0] - a[0]) * t) * track.enScale
        world.z = -(a[1] + (b[1] - a[1]) * t) * track.enScale
        const m = track.nearestOnRange(world.x, world.z, s0, s1, pad + 40)
        if (m.d > reach || Math.sign(m.lateral) !== side) continue
        let fwd = forwardDelta(s0, m.s, L)
        if (fwd > len + pad) {
          if (L - fwd > pad) continue
          fwd -= L
        }
        const key = Math.round(fwd / bin)
        const cur = best.get(key)
        if (!cur || Math.abs(m.lateral) < Math.abs(cur[1])) best.set(key, [m.s, m.lateral])
      }
    }
  }
  return [...best.entries()].sort((p, q) => p[0] - q[0]).map(([, v]) => v)
}

/**
 * Ordered centreline of an OSM way (a lane, a slip road) as (s, lateral) on the window's road —
 * vertex order is kept (no binning), so the result can leave the road and come back.
 */
export function osmPathSamples(track: Track, id: number, sRange: [number, number], opts: { reach?: number } = {}): LatSample[] {
  const f = byId.get(id)
  if (!f) return []
  const reach = opts.reach ?? 120
  const out: LatSample[] = []
  for (const [e, n] of f.en) {
    const m = track.nearestOnRange(e * track.enScale, -n * track.enScale, sRange[0], sRange[1], 60)
    if (m.d > reach) continue
    out.push([m.s, m.lateral])
  }
  return out
}

/** A point of an offset lane: world position plus where it falls on the lap it belongs to. */
export interface LanePoint {
  x: number
  z: number
  /** lap position and signed offset of this point on the lane's own stretch of road */
  s: number
  lat: number
  /** distance along the lane from its first point */
  d: number
}

/**
 * Centreline of an offset lane (a two-wheel chicane, a slip road, the West Course pit lane) in
 * WORLD space, resampled every `step` metres.
 *
 * World space, not (s, lateral): the two-wheel chicanes loop far enough from the lap that their
 * far side maps back onto a different part of it, and a lane swept in track coordinates tears into
 * spikes there. Each resampled point still carries the (s, lateral) of the lap stretch it belongs
 * to — restricted to the lane's own window — so the sweep can take its height from the road and
 * dip under the racing surface where the two overlap.
 */
export function laneWorldPath(track: Track, def: { osmWay?: number; samples?: LatSample[]; sRange: [number, number]; latMax?: number }, step = 2): LanePoint[] {
  const raw: { x: number; z: number }[] = []
  if (def.samples?.length) {
    for (const [s, lat] of def.samples) {
      track.pointAt(s, lat, _v, 0)
      raw.push({ x: _v.x, z: _v.z })
    }
  } else if (def.osmWay !== undefined) {
    const f = byId.get(def.osmWay)
    if (!f) return []
    for (const [e, n] of f.en) {
      const x = e * track.enScale, z = -n * track.enScale
      const m = track.nearestOnRange(x, z, def.sRange[0], def.sRange[1], 60)
      if (def.latMax && Math.abs(m.lateral) > def.latMax) continue
      raw.push({ x, z })
    }
  }
  if (raw.length < 2) return []
  // Catmull-Rom through the vertices, resampled by arc length
  const out: LanePoint[] = []
  let d = 0
  const push = (x: number, z: number) => {
    const prev = out[out.length - 1]
    if (prev) {
      const step2 = Math.hypot(x - prev.x, z - prev.z)
      if (step2 < 1e-4) return
      d += step2
    }
    const m = track.nearestOnRange(x, z, def.sRange[0], def.sRange[1], 60)
    out.push({ x, z, s: m.s, lat: m.lateral, d })
  }
  /*
   * CENTRIPETAL Catmull-Rom (Barry-Goldman), not the uniform one: OSM vertices are unevenly spaced
   * (the West Course pit lane has a 4 m segment next to a 40 m one) and a uniform spline overshoots
   * there into a loop — the lane's swept footprint crossed itself 12 times and its ribbon carried a
   * bow-tie. The centripetal parametrisation cannot form loops or cusps.
   */
  for (let i = 0; i < raw.length - 1; i++) {
    const p0 = raw[Math.max(0, i - 1)]!, p1 = raw[i]!, p2 = raw[i + 1]!, p3 = raw[Math.min(raw.length - 1, i + 2)]!
    const n = Math.max(1, Math.round(Math.hypot(p2.x - p1.x, p2.z - p1.z) / step))
    const knot = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.max(1e-3, Math.sqrt(Math.hypot(b.x - a.x, b.z - a.z)))
    const t0 = 0, t1 = t0 + knot(p0, p1), t2 = t1 + knot(p1, p2), t3 = t2 + knot(p2, p3)
    for (let k = 0; k < n; k++) {
      const t = t1 + ((t2 - t1) * k) / n
      const a1x = ((t1 - t) / (t1 - t0)) * p0.x + ((t - t0) / (t1 - t0)) * p1.x, a1z = ((t1 - t) / (t1 - t0)) * p0.z + ((t - t0) / (t1 - t0)) * p1.z
      const a2x = ((t2 - t) / (t2 - t1)) * p1.x + ((t - t1) / (t2 - t1)) * p2.x, a2z = ((t2 - t) / (t2 - t1)) * p1.z + ((t - t1) / (t2 - t1)) * p2.z
      const a3x = ((t3 - t) / (t3 - t2)) * p2.x + ((t - t2) / (t3 - t2)) * p3.x, a3z = ((t3 - t) / (t3 - t2)) * p2.z + ((t - t2) / (t3 - t2)) * p3.z
      const b1x = ((t2 - t) / (t2 - t0)) * a1x + ((t - t0) / (t2 - t0)) * a2x, b1z = ((t2 - t) / (t2 - t0)) * a1z + ((t - t0) / (t2 - t0)) * a2z
      const b2x = ((t3 - t) / (t3 - t1)) * a2x + ((t - t1) / (t3 - t1)) * a3x, b2z = ((t3 - t) / (t3 - t1)) * a2z + ((t - t1) / (t3 - t1)) * a3z
      push(((t2 - t) / (t2 - t1)) * b1x + ((t - t1) / (t2 - t1)) * b2x, ((t2 - t) / (t2 - t1)) * b1z + ((t - t1) / (t2 - t1)) * b2z)
    }
  }
  push(raw[raw.length - 1]!.x, raw[raw.length - 1]!.z)
  return out
}

export interface LineSource {
  osm?: number[]
  samples?: LatSample[]
  /** how far from the centreline OSM vertices are still considered part of this line (default 70 m) */
  reach?: number
  /**
   * How an OSM way becomes lateral(s). `'nearest'` (the default) maps every vertex with
   * `nearestOnRange` — right for a wall that runs alongside its road. `'ray'` intersects the
   * perpendicular at s with the way instead, which is the only thing that works where the road
   * curves tighter than the wall is far: the chicane's Q2 bank wall is 60-78 m out on the inside
   * of an R21 corner, and every one of its vertices maps to the two ends of the corner, so the
   * nearest projection leaves an 87 m hole and draws a chord through the run-off.
   */
  project?: 'nearest' | 'ray'
}

/**
 * lateral(s) by intersecting the perpendicular at s with the way, keeping the nearest hit beyond
 * the road edge (the track-facing face of a ribbon polygon, the same intent as `osmEdgeSamples`'
 * per-bin minimum).
 */
export function osmRaySamples(track: Track, ids: number[], sRange: [number, number], side: Side, opts: { reach?: number; step?: number } = {}): LatSample[] {
  const reach = opts.reach ?? 70
  const step = opts.step ?? 2
  const L = track.length
  const [s0, s1] = sRange
  const len = forwardDelta(s0, s1, L) || L
  const ways: { x: number; z: number }[][] = []
  for (const id of ids) {
    const f = byId.get(id)
    if (!f) continue
    const pts = f.en.map(([e, n]) => ({ x: e * track.enScale, z: -n * track.enScale }))
    if (f.closed && pts.length > 2) pts.push(pts[0]!)
    ways.push(pts)
  }
  const out: LatSample[] = []
  const c = new THREE.Vector3(), o = new THREE.Vector3()
  for (let d = 0; d <= len; d += step) {
    const s = track.wrap(s0 + Math.min(d, len))
    track.pointAt(s, 0, c, 0)
    track.pointAt(s, side, o, 0)
    const nx = o.x - c.x, nz = o.z - c.z
    let best = Infinity
    const min = track.halfWidthAt(s)
    for (const w of ways) {
      for (let i = 0; i < w.length - 1; i++) {
        const a = w[i]!, b = w[i + 1]!
        const ex = b.x - a.x, ez = b.z - a.z
        const den = nx * -ez - nz * -ex
        if (Math.abs(den) < 1e-9) continue
        const rx = a.x - c.x, rz = a.z - c.z
        const t = (rx * -ez - rz * -ex) / den
        const u = (nx * rz - nz * rx) / den
        if (u >= 0 && u <= 1 && t > min && t < reach && t < best) best = t
      }
    }
    if (best < Infinity) out.push([s, side * best])
  }
  return out
}

/**
 * Resolve a source to lateral(s) over [s0, s1]: OSM edge samples and / or hand samples merged
 * (hand samples win where both exist within 4 m), sorted, clipped to the window, and kept at
 * least `minGap` beyond the local road edge (OSM registration puts a few walls inside the road).
 */
const resolveCache = new WeakMap<Track, Map<string, ResolvedLine>>()

/** Cached `resolveLine` — the OSM edge search walks every way vertex against the window's samples. */
export function resolveLineCached(track: Track, source: LineSource, sRange: [number, number], side: Side, minGap = 0.6): ResolvedLine {
  let cache = resolveCache.get(track)
  if (!cache) resolveCache.set(track, (cache = new Map()))
  const key = `${sRange[0]}|${sRange[1]}|${side}|${minGap}|${source.reach ?? ''}|${source.project ?? ''}|${(source.osm ?? []).join(',')}|${source.samples?.length ?? 0}`
  let hit = cache.get(key)
  if (!hit) cache.set(key, (hit = resolveLine(track, source, sRange, side, minGap)))
  return hit
}

/**
 * Lateral offset of the BARRIERS line on `side` at s (metres from the centreline), or null where
 * the lap has no run there. The first run whose window holds s answers (the table has one run
 * per side and stretch). Read by the barrier builder, the marshal posts and the TV lenses.
 */
export function barrierLateralAt(track: Track, s: number, side: Side): number | null {
  const L = track.length
  for (const run of BARRIERS) {
    if (run.side !== side) continue
    if (forwardDelta(run.sRange[0], s, L) > forwardDelta(run.sRange[0], run.sRange[1], L)) continue
    return resolveLineCached(track, run.source, run.sRange, run.side, run.minGap ?? 0.6).lat(s)
  }
  return null
}

export function resolveLine(track: Track, source: LineSource, sRange: [number, number], side: Side, minGap = 0.6): ResolvedLine {
  const L = track.length
  const [s0, s1] = sRange
  const len = forwardDelta(s0, s1, L) || L
  let samples: LatSample[] = []
  if (source.osm?.length) samples = source.project === 'ray'
    ? osmRaySamples(track, source.osm, sRange, side, { reach: source.reach })
    : osmEdgeSamples(track, source.osm, sRange, side, { reach: source.reach })
  if (source.samples?.length) {
    const hand = source.samples.map((p): LatSample => [track.wrap(p[0]), p[1]])
    // hand samples override OSM ones within 4 m of s
    samples = samples.filter((o) => !hand.some((h) => Math.abs(forwardDelta(s0, o[0], L) - forwardDelta(s0, h[0], L)) < 4))
    samples.push(...hand)
  }
  samples = samples
    .filter((p) => Math.sign(p[1]) === side || p[1] === 0)
    .map((p): [number, number, number] => [p[0], p[1], forwardDelta(s0, p[0], L)])
    .filter((p) => p[2] <= len + 12)
    .sort((p, q) => p[2] - q[2])
    .map((p): LatSample => [p[0], p[1]])
  // A closed way mapped as an area has a far edge too: where the near edge has no vertex in a bin
  // the far one wins and the line jumps outward for a few metres. Drop a sample that jumps more
  // than 10 m within 8 m of s and comes straight back — a real wall never does that.
  samples = samples.filter((p, i) => {
    const prev = samples[i - 1]
    const next = samples[i + 1]
    if (!prev || !next) return true
    const ds = forwardDelta(prev[0], next[0], L)
    return !(ds < 8 && Math.abs(p[1]) - Math.max(Math.abs(prev[1]), Math.abs(next[1])) > 10)
  })
  // ends are unguarded by the filter above: drop a first / last sample that sits 10 m beyond its neighbour
  while (samples.length > 2 && Math.abs(samples[0]![1]) - Math.abs(samples[1]![1]) > 10 && forwardDelta(samples[0]![0], samples[1]![0], L) < 8) samples.shift()
  while (samples.length > 2 && Math.abs(samples[samples.length - 1]![1]) - Math.abs(samples[samples.length - 2]![1]) > 10 && forwardDelta(samples[samples.length - 2]![0], samples[samples.length - 1]![0], L) < 8) samples.pop()
  // registration guard: never inside the road
  samples = samples.map(([s, lat]): LatSample => {
    const min = track.halfWidthAt(s) + minGap
    return [s, Math.abs(lat) < min ? side * min : lat]
  })
  const lat = lateralFn(samples, s0, L)
  return { s0, s1, samples, lat }
}

/**
 * World-space closed outline of a GROUND_AREAS ring / osm footprint, resampled every `step` metres.
 *
 * World space, not (s, lateral) — for the same reason `laneWorldPath` is: through the chicane the
 * swept frame folds past ~16 m on the inside (see ground.ts FOLD_SAFE), so a lateral read off a
 * map does not land where it reads, and a polygon interpolated in track coordinates tears. Each
 * node is turned into world points independently; only then is the ring resampled.
 */
/** Margin an area ring keeps beyond the kerb it must not sit under (m). */
const KERB_CLEAR = 0.15
/**
 * The flat 2 m strip beside the asphalt already has an owner — the run-off ribbons and the kerbs,
 * all swept on track stations in the ROAD-PLANE frame. A patch arrives on arbitrary world-XZ
 * triangles in the TERRAIN frame, so inside the strip the two frames fight over an 8-26 mm ladder
 * with a 43 mm chord error. Keeping patches out of the strip removes the contest instead of
 * tuning it (see FLAT_STRIP in ground.ts).
 */
const STRIP_CLEAR = 2
/**
 * Extra margin when a `way` node's outline is trimmed against the gap. Zero today: a margin makes
 * the surviving points further apart, and the chords the resampler then draws between them cut
 * across more, not less. Kept as a named knob because it is the obvious thing to reach for.
 */
const WAY_TRIM = 0

/**
 * Width of the widest flat kerb drawn at `s` on `side`, from the KERBS table (0 where there is
 * none). Sausage rows carry no width and are separate objects, so they are skipped.
 */
export function kerbWidthAt(track: Track, s: number, side: Side): number {
  const L = track.length
  let w = 0
  for (const k of KERBS) {
    if (k.side !== side || k.kind === 'sausage') continue
    if (forwardDelta(k.sRange[0], track.wrap(s), L) <= forwardDelta(k.sRange[0], k.sRange[1], L)) w = Math.max(w, k.width ?? 1.3)
  }
  return w
}

export function patchOutline(track: Track, p: SurfacePatchLike, step = 2): { x: number; z: number }[] {
  const raw: { x: number; z: number }[] = []
  const push = (x: number, z: number) => {
    const prev = raw[raw.length - 1]
    if (!prev || Math.hypot(x - prev.x, z - prev.z) > 1e-3) raw.push({ x, z })
  }
  const [s0, s1] = p.sRange
  /**
   * How close to the road edge a ring vertex may come.
   *
   * The old flat 0.8 m was NARROWER THAN THE KERB: at the chicane `Chicane apron side` is 1.3 m,
   * so the turf island's whole road-side boundary was clamped to exactly off 0.80 — inside the
   * kerb, which then drew over it, and inside the flat strip, where the patch was coplanar with
   * the ribbons. Clear both.
   */
  const gapAt = (s: number, side: Side) => p.minGap ?? Math.max(STRIP_CLEAR, kerbWidthAt(track, s, side) + KERB_CLEAR)
  const atLat = (s: number, lat: number) => {
    const hw = track.halfWidthAt(s)
    const minGap = gapAt(s, lat >= 0 ? 1 : -1)
    const l = Math.abs(lat) < hw + minGap ? Math.sign(lat || 1) * (hw + minGap) : lat
    track.pointAt(s, l, _v, 0)
    push(_v.x, _v.z)
  }

  if (p.ring?.length) {
    for (const node of p.ring) {
      if (Array.isArray(node)) {
        atLat(node[0], node[1])
      } else if ('edge' in node) {
        // the boundary a patch shares with the racing surface: the frame is exact this close in
        const len = forwardDelta(node.from, node.to, track.length)
        const off = node.off ?? 0.2
        for (let d = 0; d <= len; d++) atLat(track.wrap(node.from + d), node.edge * (track.halfWidthAt(track.wrap(node.from + d)) + off))
      } else if ('en' in node) {
        // a vertex in the EN frame (the far side of an area beyond the bend's radius or across the
        // fold): world XZ directly, clamped out of the road like an OSM vertex would be
        track.enToWorld(node.en[0], node.en[1], _v)
        const m = track.nearestOnRange(_v.x, _v.z, s0, s1, 60)
        if (Math.abs(m.lateral) < track.halfWidthAt(m.s) + gapAt(m.s, m.lateral >= 0 ? 1 : -1)) atLat(m.s, m.lateral)
        else push(_v.x, _v.z)
      } else {
        const f = byId.get(node.way)
        if (!f) continue
        const pts = f.en.map(([e, n]) => ({ x: e * track.enScale, z: -n * track.enScale }))
        const off = node.offset ?? 0
        const out: { x: number; z: number }[] = []
        const [v0, v1] = node.verts ?? [0, pts.length - 1]
        for (let i = Math.max(0, v0); i <= Math.min(pts.length - 1, v1); i++) {
          const a = pts[Math.max(0, i - 1)]!, b = pts[Math.min(pts.length - 1, i + 1)]!
          const dx = b.x - a.x, dz = b.z - a.z
          const inv = 1 / (Math.hypot(dx, dz) || 1)
          // left of the way's direction, the same convention as the track's own left normal
          out.push({ x: pts[i]!.x + dz * inv * off, z: pts[i]!.z - dx * inv * off })
        }
        if (node.reverse) out.reverse()
        /*
         * Keep only the LONGEST contiguous stretch that clears the gap.
         *
         * A way like the two-wheel loop is closed and touches the GP road more than once, so
         * offsetting it leaves several arcs near the road that an `edge` node in the same ring
         * already draws. Clamping them out lands them on top of that boundary and folds the
         * outline; keeping them all makes the ring alternate between two arcs and cross itself.
         * One arc is what a ring needs, and the longest is the one the patch is actually bounded
         * by (measured on the chicane apron: 31 self-crossings and 30 lost triangles otherwise).
         */
        const runs: { x: number; z: number }[][] = []
        let run: { x: number; z: number }[] | null = null
        for (const q of out) {
          const m = track.nearestOnRange(q.x, q.z, s0, s1, 60)
          const clear = Math.abs(m.lateral) >= track.halfWidthAt(m.s) + gapAt(m.s, m.lateral >= 0 ? 1 : -1) + WAY_TRIM
          if (!clear) { run = null; continue }
          if (!run) { run = []; runs.push(run) }
          run.push(q)
        }
        let best: { x: number; z: number }[] = []
        let bestLen = 0
        for (const r of runs) {
          let len = 0
          for (let i = 1; i < r.length; i++) len += Math.hypot(r[i]!.x - r[i - 1]!.x, r[i]!.z - r[i - 1]!.z)
          if (len > bestLen) { bestLen = len; best = r }
        }
        for (const q of best) push(q.x, q.z)
      }
    }
  } else if (p.osm?.length) {
    for (const id of p.osm) {
      const f = byId.get(id)
      if (!f) continue
      let pts = f.en.map(([e, n]) => ({ x: e * track.enScale, z: -n * track.enScale }))
      /*
       * `grow`: the polygon offset outward by that many metres (each vertex along the mean of
       * its two edge normals, the miter capped at twice the offset). Two OSM polygons that share
       * an edge are digitised with slivers and notches between them (natural=sand 467386919 and
       * landuse=grass 467386918 inside Degner 2 leave a 1–2 m strip of nobody's ground): the
       * lower-layer one grown a metre closes it, and the higher layer keeps the visible edge.
       */
      if (p.grow && pts.length >= 3) {
        let area2 = 0
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) area2 += pts[j]!.x * pts[i]!.z - pts[i]!.x * pts[j]!.z
        const sign = area2 > 0 ? 1 : -1
        const grown: { x: number; z: number }[] = []
        for (let i = 0; i < pts.length; i++) {
          const a = pts[(i - 1 + pts.length) % pts.length]!, b = pts[i]!, c = pts[(i + 1) % pts.length]!
          const n1 = [b.z - a.z, -(b.x - a.x)], n2 = [c.z - b.z, -(c.x - b.x)]
          const l1 = Math.hypot(n1[0]!, n1[1]!) || 1, l2 = Math.hypot(n2[0]!, n2[1]!) || 1
          let nx = n1[0]! / l1 + n2[0]! / l2, nz = n1[1]! / l1 + n2[1]! / l2
          const ln = Math.hypot(nx, nz)
          if (ln < 1e-6) { grown.push(b); continue }
          // the miter: 1 / cos(half angle), capped
          const cosHalf = Math.max(0.5, ln / 2)
          nx /= ln; nz /= ln
          const d = (p.grow / cosHalf) * sign
          grown.push({ x: b.x + nx * d, z: b.z + nz * d })
        }
        pts = grown
      }
      for (const { x, z } of pts) {
        const m = track.nearestOnRange(x, z, s0, s1, 60)
        if (p.latMax && Math.abs(m.lateral) > p.latMax) continue
        if (Math.abs(m.lateral) < track.halfWidthAt(m.s) + gapAt(m.s, m.lateral >= 0 ? 1 : -1)) { atLat(m.s, m.lateral); continue }
        push(x, z)
      }
    }
  }
  if (raw.length < 3) return []

  // resample the closed ring: straight for dense OSM outlines, Catmull-Rom for hand rings
  const out: { x: number; z: number }[] = []
  const add = (x: number, z: number) => {
    const prev = out[out.length - 1]
    if (!prev || Math.hypot(x - prev.x, z - prev.z) > 1e-4) out.push({ x, z })
  }
  const at = (i: number) => raw[((i % raw.length) + raw.length) % raw.length]!
  const cr = (a: number, b: number, c: number, e: number, t: number) =>
    0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - e) * t * t + (-a + 3 * b - 3 * c + e) * t * t * t)
  for (let i = 0; i < raw.length; i++) {
    const p1 = at(i), p2 = at(i + 1)
    const n = Math.max(1, Math.round(Math.hypot(p2.x - p1.x, p2.z - p1.z) / step))
    for (let k = 0; k < n; k++) {
      const t = k / n
      if (p.straight) add(p1.x + (p2.x - p1.x) * t, p1.z + (p2.z - p1.z) * t)
      else {
        const p0 = at(i - 1), p3 = at(i + 2)
        add(cr(p0.x, p1.x, p2.x, p3.x, t), cr(p0.z, p1.z, p2.z, p3.z, t))
      }
    }
  }
  // NOTE: the clamp is deliberately NOT re-applied after resampling. It was, to stop `straight`
  // chords cutting back inside the gap, and it folded the ring: pushing a node that belongs to one
  // part of the outline onto the road edge lands it on top of another part, and the chicane apron
  // came out with 31 self-crossings and 30 fewer triangles. With the gap at STRIP_CLEAR the chord
  // sag is 0.22 m on the chicane's 20 m radius, so the ring still clears the 1.3 m kerb by 0.5 m.

  // wind positive in (x, -z) so the triangulation orientation is deterministic
  let area = 0
  for (let i = 0; i < out.length; i++) {
    const a = out[i]!, b = out[(i + 1) % out.length]!
    area += a.x * -b.z - b.x * -a.z
  }
  if (area < 0) out.reverse()
  return out
}

/** the shape `patchOutline` needs — kept structural so scripts can pass a plain object */
export interface SurfacePatchLike {
  sRange: [number, number]
  ring?: PatchNode[]
  osm?: number[]
  straight?: boolean
  latMax?: number
  minGap?: number
  grow?: number
}

/**
 * Drop ring vertices that are exactly collinear with their neighbours.
 *
 * `patchOutline`'s `straight` resampling splits each raw segment into EQUAL linear steps, so
 * every interpolated point lies exactly on the chord: 55 of the chicane turf ring's 72 vertices
 * were collinear. Ear clipping turns each of them into a zero-area ear whose vertices end up
 * with a (0,0,0) normal and shade black. Only EXACT collinearity is removed: a looser tolerance
 * moved two rings that share a boundary apart from each other.
 */
export function simplifyRing(ring: { x: number; z: number }[]): { x: number; z: number }[] {
  const n = ring.length
  if (n < 4) return ring
  const out: { x: number; z: number }[] = []
  for (let i = 0; i < n; i++) {
    const a = ring[(i - 1 + n) % n]!, b = ring[i]!, c = ring[(i + 1) % n]!
    // twice the triangle area; 1e-4 m² keeps anything that is a real corner
    const cross = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)
    if (Math.abs(cross) > 2e-4) out.push(b)
  }
  return out.length >= 3 ? out : ring
}
