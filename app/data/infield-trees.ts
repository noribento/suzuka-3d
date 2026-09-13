import { Vector3 } from 'three'
import { osmFeature } from '~/data/suzuka-facilities'
import { INFIELD_TREES, type InfieldTreeRow } from '~/data/suzuka-facilities-spec'
import type { TreeRole } from '~/data/tree-species'
import { forwardDelta, type Track } from '~/sim/track'

/**
 * The placed trees of INFIELD_TREES (plan I5-c) — one pure expansion of the rows into world
 * points that the runtime (vegetation.ts, inside the 'trees' job) and the guard
 * (facilities-check §16 O10) both read, so what is checked is what is planted. No scene, no
 * ground: a row is a line (an OSM way offset to one side, or lap-frame vertices), a circle, a
 * regular grid or a random scatter in a lap-frame rectangle / disc; the jitter and the scatter
 * draw from a hash seeded by the row's id, so the placements are the same in every build.
 *
 * Each placement carries its lap projection (`s`, `lateral`, windowed to the row's `window`)
 * for the rules that are stated in the lap frame (O10: |lateral| ≥ hw + 6; the barrier lines)
 * and the world point for everything else (the ring, the paved aprons, the stand footprints,
 * `ground.standY`).
 */

export interface InfieldTreePlacement {
  row: InfieldTreeRow
  id: string
  role: TreeRole
  x: number
  z: number
  s: number
  lateral: number
  /** metres from the lap (the window projection) */
  d: number
  /** deterministic per-tree seed (variant, yaw, height, tint) */
  seed: number
}

/** a small integer hash → [0, 1) */
function unit(h: number): number {
  let t = (h + 0x6d2b79f5) | 0
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

function hashId(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619)
  return h >>> 0
}

/** even-odd point in polygon (world xz pairs) */
function inPoly(x: number, z: number, pts: { x: number; z: number }[]): boolean {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]!, b = pts[j]!
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside
  }
  return inside
}

/**
 * Resample a polyline every `pitch` metres (from half a pitch in), offset `offset` metres to the
 * LEFT of its direction of travel (the track's own convention; a closed ring is offset outward
 * whatever its winding), each point pushed `jitter` metres at random along and across.
 */
function alongLine(pts: { x: number; z: number }[], closed: boolean, pitch: number, offset: number, jitter: number, seed: number): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = []
  if (pts.length < 2) return out
  const path = closed ? [...pts, pts[0]!] : pts
  let sign = 1
  if (closed && offset !== 0) {
    // outward: the left-offset of the first edge's midpoint must fall outside the ring
    const a = path[0]!, b = path[1]!
    const dx = b.x - a.x, dz = b.z - a.z
    const l = Math.hypot(dx, dz) || 1
    const mx = (a.x + b.x) / 2 + (dz / l) * Math.abs(offset), mz = (a.z + b.z) / 2 - (dx / l) * Math.abs(offset)
    sign = inPoly(mx, mz, pts) ? -1 : 1
  }
  let total = 0
  for (let i = 0; i < path.length - 1; i++) total += Math.hypot(path[i + 1]!.x - path[i]!.x, path[i + 1]!.z - path[i]!.z)
  let k = 0
  for (let d = pitch / 2; d < total; d += pitch, k++) {
    let acc = 0
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i]!, b = path[i + 1]!
      const len = Math.hypot(b.x - a.x, b.z - a.z)
      if (d > acc + len && i < path.length - 2) { acc += len; continue }
      const t = len > 1e-6 ? Math.min(1, (d - acc) / len) : 0
      const ex = (b.x - a.x) / (len || 1), ez = (b.z - a.z) / (len || 1)
      const off = offset * sign + (unit(seed + k * 7 + 1) - 0.5) * 2 * jitter
      const shift = (unit(seed + k * 7 + 2) - 0.5) * 2 * jitter
      // left normal (dz, −dx)
      out.push({ x: a.x + ex * (len * t + shift) + ez * off, z: a.z + ez * (len * t + shift) - ex * off })
      break
    }
  }
  return out
}

/** Expand every INFIELD_TREES row into placements (a row whose OSM way is missing yields none). */
export function infieldTreePlacements(track: Track, rows: readonly InfieldTreeRow[] = INFIELD_TREES): InfieldTreePlacement[] {
  const out: InfieldTreePlacement[] = []
  const v = new Vector3()
  const at = (s: number, lateral: number) => {
    track.pointAt(track.wrap(s), lateral, v, 0)
    return { x: v.x, z: v.z }
  }
  for (const row of rows) {
    const seed = hashId(row.id)
    const pitch = row.pitch ?? 8
    const jitter = row.jitter ?? 0
    const pts: { x: number; z: number }[] = []
    if (row.along) {
      if ('way' in row.along) {
        const f = osmFeature(row.along.way)
        if (!f) continue
        const [v0, v1] = row.along.verts ?? [0, f.en.length - 1]
        const line = f.en.slice(Math.max(0, v0), Math.min(f.en.length - 1, v1) + 1).map(([e, n]) => ({ x: e * track.enScale, z: -n * track.enScale }))
        pts.push(...alongLine(line, f.closed && !row.along.verts, pitch, row.along.offset ?? 0, jitter, seed))
      } else {
        const line = row.along.line.map(([s, l]) => at(s, l))
        pts.push(...alongLine(line, false, pitch, row.along.offset ?? 0, jitter, seed))
      }
    }
    if (row.points) for (const [s, l] of row.points) pts.push(at(s, l))
    if (row.circle) {
      const { s, lateral, r } = row.circle
      const n = Math.max(3, Math.round((2 * Math.PI * r) / pitch))
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2 + unit(seed + k * 3) * 0.2
        const rr = r + (unit(seed + k * 3 + 1) - 0.5) * 2 * jitter
        pts.push(at(s + rr * Math.cos(a), lateral + rr * Math.sin(a)))
      }
    }
    if (row.rect) {
      const [s0, s1] = row.rect.s, [l0, l1] = row.rect.lateral
      if (row.count !== undefined) {
        for (let k = 0; k < row.count; k++) pts.push(at(s0 + unit(seed + k * 5) * (s1 - s0), l0 + unit(seed + k * 5 + 1) * (l1 - l0)))
      } else {
        let k = 0
        for (let s = s0 + pitch / 2; s <= s1; s += pitch) for (let l = l0 + pitch / 2; l <= l1; l += pitch, k++) {
          pts.push(at(s + (unit(seed + k * 5) - 0.5) * 2 * jitter, l + (unit(seed + k * 5 + 1) - 0.5) * 2 * jitter))
        }
      }
    }
    if (row.disc) {
      const { s, lateral, r } = row.disc
      const n = row.count ?? Math.max(1, Math.round((Math.PI * r * r) / (pitch * pitch)))
      for (let k = 0; k < n; k++) {
        const a = unit(seed + k * 5) * Math.PI * 2, rr = Math.sqrt(unit(seed + k * 5 + 1)) * r
        pts.push(at(s + rr * Math.cos(a), lateral + rr * Math.sin(a)))
      }
    }
    pts.forEach((p, k) => {
      const m = track.nearestOnRange(p.x, p.z, row.window[0], row.window[1], 0)
      if (row.skipS?.some(([a, b]) => forwardDelta(a, m.s, track.length) <= forwardDelta(a, b, track.length))) return
      out.push({ row, id: `${row.id}#${k}`, role: row.role, x: p.x, z: p.z, s: m.s, lateral: m.lateral, d: m.d, seed: (seed + k * 2654435761) >>> 0 })
    })
  }
  return out
}
