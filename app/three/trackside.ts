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
import { OSM_FEATURES, type OsmFeature } from '~/data/suzuka-facilities'
import type { Side } from '~/data/suzuka-facilities-spec'
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

const byId = new Map<number, OsmFeature>(OSM_FEATURES.map((f) => [f.id, f]))

export function osmWay(id: number): OsmFeature | undefined {
  return byId.get(id)
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

export interface LineSource {
  osm?: number[]
  samples?: LatSample[]
  /** how far from the centreline OSM vertices are still considered part of this line (default 70 m) */
  reach?: number
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
  const key = `${sRange[0]}|${sRange[1]}|${side}|${minGap}|${source.reach ?? ''}|${(source.osm ?? []).join(',')}|${source.samples?.length ?? 0}`
  let hit = cache.get(key)
  if (!hit) cache.set(key, (hit = resolveLine(track, source, sRange, side, minGap)))
  return hit
}

export function resolveLine(track: Track, source: LineSource, sRange: [number, number], side: Side, minGap = 0.6): ResolvedLine {
  const L = track.length
  const [s0, s1] = sRange
  const len = forwardDelta(s0, s1, L) || L
  let samples: LatSample[] = []
  if (source.osm?.length) samples = osmEdgeSamples(track, source.osm, sRange, side, { reach: source.reach })
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
