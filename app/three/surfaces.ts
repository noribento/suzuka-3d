import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { SURFACE_PATCHES, type Side, type SurfaceKind, type SurfacePatch } from '~/data/suzuka-facilities-spec'
import type { Track } from '~/sim/track'
import { FLAT_STRIP, type Ground } from './ground'
import { patchOutline } from './trackside'

/**
 * Paved / unpaved AREAS beside the road, from the SURFACE_PATCHES table.
 *
 * The run-off in track-mesh.ts is a set of lateral bands swept along s, and that cannot describe
 * the Casio Triangle: its apron reaches 45 m to the left of the lap, while a ribbon swept past
 * ~16 m to the INSIDE of the chicane's 20-23 m corner turns inside out (ground.ts FOLD_SAFE).
 * So these are polygons: resolved to a world-space outline by `patchOutline`, triangulated in XZ,
 * refined until no edge is longer than PATCH_STEP, and draped on the same surface the run-off
 * ribbons use. A higher-`layer` patch that lies inside a lower one is CUT OUT of it (a
 * triangulateShape hole), so overlapping patches never contest the depth buffer at all.
 */

/** longest edge of a patch triangle (m): fine enough to drape, coarse enough for clampUnder */
const PATCH_STEP = 4
/** the patch ducks below the racing surface where the two overlap, as lanes.ts does */
const PATCH_UNDER = -0.06
/**
 * Height above the surface the patch is painted on, by `layer`.
 *
 * It used to be keyed on `kind`, which meant the documented paint order (`SurfacePatch.layer`)
 * was never read and two patches of the same kind shared a height exactly. It is keyed on
 * `layer` now, so the table's contract is what the renderer does.
 *
 * The steps are small on purpose — patches that overlap are CUT OUT of each other
 * (`triangulateShape` holes below), so the height only has to break ties at the seam, not
 * out-argue the terrain sampling error. Measured, that error reaches 63 mm over a 4 m triangle,
 * which no plausible ladder could have covered.
 */
const PATCH_BASE = 0.03
const PATCH_STEP_Y = 0.015
/** the patch drape crosses from the road-plane frame to the terrain frame over this band (m) */
const BLEND_FROM = 2
const BLEND_TO = 8
const patchLift = (layer: number) => PATCH_BASE + Math.max(0, layer) * PATCH_STEP_Y

function smoothstep(t: number): number {
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return t * t * (3 - 2 * t)
}

export interface SurfaceMaterials {
  asphalt: THREE.Material
  turf: THREE.Material
  gravel: THREE.Material
  grass: THREE.Material
}

export interface SurfacePatchesResult {
  meshes: THREE.Mesh[]
  /** every patch geometry, for Terrain.clampUnder */
  geometries: THREE.BufferGeometry[]
  /** metres the patch layer raises the surface at (s, lateral); 0 where there is no patch */
  liftAt: (s: number, lateral: number) => number
  /**
   * Metres beyond the road edge that a `replacesVerge` patch covers contiguously at (s, side);
   * 0 where none does. The run-off ribbons cut back to this instead of being drawn underneath.
   *
   * `raw` skips the slope limit. The limit exists so a ribbon that OWNS the ground cannot chord
   * across the patch boundary and leave bare terrain; a band that merely sits on top of another
   * ribbon — the gravel on the grass — has nothing to expose and should retract by the measured
   * amount.
   */
  vergeCut: (s: number, side: Side, raw?: boolean) => number
}

/** how far out the cut is measured, and how fast it may move (m per metre of s) */
const CUT_STEP = 0.25
const CUT_MAX_SLOPE = 0.5

const _p = new THREE.Vector3()

export function buildSurfacePatches(
  track: Track,
  ground: Ground,
  terrainHeightAt: (x: number, z: number) => number,
  mats: SurfaceMaterials,
): SurfacePatchesResult {
  const perKind: Record<string, THREE.BufferGeometry[]> = {}
  const geometries: THREE.BufferGeometry[] = []
  /** resolved rings, for liftAt */
  const zones: { ring: { x: number; z: number }[]; lift: number; sRange: [number, number] }[] = []

  // resolve every ring first: a patch has to know which higher-layer rings to cut out of itself
  const resolved = SURFACE_PATCHES.map((patch) => ({ patch, ring: simplifyRing(patchOutline(track, patch, 2)) }))
    .filter((r) => r.ring.length >= 3)
    .sort((a, b) => a.patch.layer - b.patch.layer)

  for (let i = 0; i < resolved.length; i++) {
    const { patch, ring } = resolved[i]!
    // Holes, not overpainting. The turf island lies inside the chicane's asphalt apron, and the
    // two used to be stacked 15 mm apart on independent triangulations — against a measured 63 mm
    // terrain-sampling error, so the apron came through the island over 2.4 % of its area, up to
    // 9 m inside it. Cutting the island out of the apron removes the contest instead of tuning it.
    const holes: { x: number; z: number }[][] = []
    for (const h of resolved.slice(i + 1)) {
      if (h.patch.layer <= patch.layer) continue
      // only a ring that is (nearly) enclosed can be a hole; a partial overlap needs a real
      // clipper and is loud rather than silently wrong
      const insideCount = h.ring.filter((q) => inRing(q.x, q.z, ring)).length
      if (insideCount === 0) continue
      const snapped = insideCount === h.ring.length ? h.ring : snapHole(h.ring, ring)
      if (!snapped) {
        console.error(`[surfaces] "${h.patch.name}" only partly overlaps "${patch.name}" — it cannot be cut out, so the two will contest the depth buffer`)
        continue
      }
      holes.push(snapped)
    }
    const geo = patchGeometry(track, ground, terrainHeightAt, patch, ring, holes)
    if (!geo) continue
    ;(perKind[patch.kind] ??= []).push(geo)
    zones.push({ ring, lift: patchLift(patch.layer), sRange: patch.sRange })
  }

  const meshes: THREE.Mesh[] = []
  for (const [kind, geos] of Object.entries(perKind)) {
    const merged = mergeGeometries(geos, false)
    for (const g of geos) g.dispose()
    if (!merged) continue
    const mat = mats[kind as SurfaceKind]
    const mesh = new THREE.Mesh(merged, mat)
    mesh.name = `surface-${kind}`
    mesh.receiveShadow = true
    mesh.renderOrder = 1
    meshes.push(mesh)
    geometries.push(merged)
  }

  // liftAt: the highest patch covering (s, lateral). Rings are small and few, so a point-in-
  // polygon walk is cheaper than any index here.
  const liftAt = (s: number, lateral: number): number => {
    if (!zones.length) return 0
    track.pointAt(s, lateral, _p, 0)
    let lift = 0
    for (const z of zones) if (z.lift > lift && inRing(_p.x, _p.z, z.ring)) lift = z.lift
    return lift
  }
  return { meshes, geometries, liftAt, vergeCut: buildVergeCut(track, ground, resolved) }
}

/**
 * How far out from the road edge the `replacesVerge` patches cover, per metre of s and per side.
 *
 * Measured off the resolved rings, never typed in the table, so it cannot drift from the polygon.
 * Three properties matter:
 *  - CONTIGUOUS from the flat strip outward. A radial gap is a real hole in the patch and the
 *    ribbon must still cover it, so the march stops at the first uncovered sample rather than
 *    taking the furthest covered one.
 *  - SLOPE-LIMITED. At the ends of a patch's s-range the coverage falls from tens of metres to
 *    nothing within one ribbon step; without a limit the ribbon's inner edge would chord straight
 *    across the patch boundary and leave bare terrain. Limiting a bound may only lower it, the
 *    same idiom as ground.ts's fold table.
 *  - CLAMPED to `runoffWidth`. The left apron reaches 45 m where the fold cap holds the verge to
 *    7.6 m, and a ribbon edge pushed to 45 m on the inside of a 20 m corner is inside out.
 */
function buildVergeCut(
  track: Track,
  ground: Ground,
  resolved: { patch: SurfacePatch; ring: { x: number; z: number }[] }[],
): (s: number, side: Side) => number {
  const flagged = resolved.filter((r) => r.patch.replacesVerge?.length)
  if (!flagged.length) return () => 0
  const L = Math.round(track.length)
  const table: Record<number, Float32Array> = { 1: new Float32Array(L), '-1': new Float32Array(L) }
  const raw: Record<number, Float32Array> = { 1: new Float32Array(L), '-1': new Float32Array(L) }
  const q = new THREE.Vector3()
  for (const side of [1, -1] as Side[]) {
    const t = table[side]!
    const spans = flagged.flatMap((r) => (r.patch.replacesVerge ?? []).filter((v) => v.side === side).map((v) => ({ v, ring: r.ring })))
    if (!spans.length) continue
    const rings = [...new Set(spans.map((x) => x.ring))]
    for (const { v } of spans) {
      const len = Math.round(((v.to - v.from) % track.length + track.length) % track.length)
      for (let d = 0; d <= len; d++) {
        const s = track.wrap(v.from + d)
        const hw = track.halfWidthAt(s)
        const limit = ground.runoffWidth(s, side)
        // start just OUTSIDE the strip: the ring's inner boundary sits on FLAT_STRIP itself
        // (patchOutline's STRIP_CLEAR), so a probe exactly on it lands on the edge and reads out
        let cut = 0
        for (let off = FLAT_STRIP + CUT_STEP; off <= limit; off += CUT_STEP) {
          track.pointAt(s, side * (hw + off), q, 0)
          if (!rings.some((r) => inRing(q.x, q.z, r))) break
          cut = off
        }
        const i = Math.round(s) % L
        if (cut > t[i]!) t[i] = cut
      }
    }
    raw[side]!.set(t)
    // slope-limit both ways, then clamp back to the verge width
    for (let pass = 0; pass < 2; pass++) {
      for (let k = 0; k < L; k++) {
        const i = pass === 0 ? k : L - 1 - k
        const j = pass === 0 ? (i - 1 + L) % L : (i + 1) % L
        const cap = t[j]! + CUT_MAX_SLOPE
        if (t[i]! > cap) t[i] = cap
      }
    }
    for (let i = 0; i < L; i++) {
      const w = ground.runoffWidth(i, side)
      if (t[i]! > w) t[i] = w
      if (raw[side]![i]! > w) raw[side]![i] = w
    }
  }
  return (s: number, side: Side, useRaw = false) => {
    const u = track.wrap(s)
    const i = Math.floor(u) % L
    const f = u - Math.floor(u)
    const t = (useRaw ? raw : table)[side]!
    return t[i]! * (1 - f) + t[(i + 1) % L]! * f
  }
}

function inRing(x: number, z: number, ring: { x: number; z: number }[]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside
  }
  return inside
}

/**
 * Drop vertices that are exactly collinear with their neighbours.
 *
 * `patchOutline`'s `straight` resampling splits each raw segment into EQUAL linear steps, so
 * every interpolated point lies exactly on the chord: 55 of the chicane turf ring's 72 vertices
 * were collinear. Ear clipping turns each of them into a zero-area ear — 27 of 70 triangles, and
 * after refinement 45 of 1164, of which 34 are fully degenerate. `computeVertexNormals` then
 * leaves 14 vertices with a ZERO normal and 47 tilted 90°, and those shade black: the dark blobs
 * inside the green island and the dark fringe along its road-side edge were this, not a depth
 * fight. The refinement below puts the density back, without the degeneracy.
 */
export function simplifyRing(ring: { x: number; z: number }[]): { x: number; z: number }[] {
  const n = ring.length
  if (n < 4) return ring
  const out: { x: number; z: number }[] = []
  /*
   * Only EXACT collinearity is removed. A looser tolerance was tried (drop anything within 10 mm
   * of its neighbours' chord) and it made things worse, not better: the apron and the island share
   * their road-side boundary, and simplifying them independently moves the two apart, so the
   * island stops being a clean hole in the apron and the pair starts overlapping again.
   * Whatever is dropped here must be dropped identically from both rings, and only the resampler's
   * exactly-collinear filler qualifies.
   */
  for (let i = 0; i < n; i++) {
    const a = ring[(i - 1 + n) % n]!, b = ring[i]!, c = ring[(i + 1) % n]!
    // twice the triangle area; 1e-4 m² keeps anything that is a real corner
    const cross = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)
    if (Math.abs(cross) > 2e-4) out.push(b)
  }
  return out.length >= 3 ? out : ring
}

/**
 * Move any vertex of `inner` that is not strictly inside `outer` onto `outer`, nudged 1 mm in.
 *
 * Earcut needs a hole to be strictly interior, and these two rings SHARE their road-side
 * boundary: both are clamped to the same offset from the road edge, but one arrives as an arc of
 * 1 m road-edge samples and the other as the straight chords of an OSM way, so the chords cut the
 * corner by a couple of centimetres. Snapping is the geometrically correct answer there, not an
 * approximation — it puts the island's edge back on the apron's edge.
 *
 * Returns null when the rings are not in a containment relation at all, which is the signal to
 * skip the hole rather than hand Earcut a self-crossing contour.
 */
function snapHole(inner: { x: number; z: number }[], outer: { x: number; z: number }[]): { x: number; z: number }[] | null {
  const out = inner.map((p) => ({ ...p }))
  let moved = 0
  for (const q of out) {
    if (inRing(q.x, q.z, outer)) continue
    moved++
    // nearest point on the outer ring
    let bd = Infinity, bx = q.x, bz = q.z
    for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
      const a = outer[j]!, b = outer[i]!
      const dx = b.x - a.x, dz = b.z - a.z
      const l2 = dx * dx + dz * dz
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.z - a.z) * dz) / l2)) : 0
      const px = a.x + dx * t, pz = a.z + dz * t
      const d = (q.x - px) ** 2 + (q.z - pz) ** 2
      if (d < bd) { bd = d; bx = px; bz = pz }
    }
    // 1 mm towards the ring's interior, taken as the direction back to the hole's centroid
    let cx = 0, cz = 0
    for (const r of inner) { cx += r.x / inner.length; cz += r.z / inner.length }
    const ux = cx - bx, uz = cz - bz
    const ul = Math.hypot(ux, uz) || 1
    q.x = bx + (ux / ul) * 0.001
    q.z = bz + (uz / ul) * 0.001
    if (!inRing(q.x, q.z, outer)) return null
  }
  if (import.meta.dev && moved) console.info(`[surfaces] snapped ${moved} hole vertices onto the enclosing ring`)
  return out
}

function patchGeometry(
  track: Track,
  ground: Ground,
  terrainHeightAt: (x: number, z: number) => number,
  patch: SurfacePatch,
  ring: { x: number; z: number }[],
  holeRings: { x: number; z: number }[][] = [],
): THREE.BufferGeometry | null {
  // triangulate the outline flat, in world XZ (never in (s, lateral) — that frame folds here)
  const contour = ring.map((p) => new THREE.Vector2(p.x, -p.z))
  // a hole must wind opposite to the contour; patchOutline winds every ring positive in (x, −z)
  const holes = holeRings.map((h) => h.map((p) => new THREE.Vector2(p.x, -p.z)).reverse())
  const faces = THREE.ShapeUtils.triangulateShape(contour, holes)
  if (!faces.length) return null

  // triangulateShape indexes contour vertices first, then each hole's, in order
  const pts = [...ring.map((p) => ({ x: p.x, z: p.z })), ...holeRings.flatMap((h) => [...h].reverse().map((p) => ({ x: p.x, z: p.z })))]
  let tris = faces.map((f) => [f[0]!, f[1]!, f[2]!] as [number, number, number])

  // Refine until no edge is longer than PATCH_STEP. Splitting is decided per EDGE, so the two
  // triangles sharing one always agree and no T-junction can appear.
  const mid = new Map<string, number>()
  const midpoint = (a: number, b: number): number => {
    const key = a < b ? `${a},${b}` : `${b},${a}`
    let m = mid.get(key)
    if (m === undefined) {
      m = pts.length
      pts.push({ x: (pts[a]!.x + pts[b]!.x) / 2, z: (pts[a]!.z + pts[b]!.z) / 2 })
      mid.set(key, m)
    }
    return m
  }
  const long = (a: number, b: number) => Math.hypot(pts[a]!.x - pts[b]!.x, pts[a]!.z - pts[b]!.z) > PATCH_STEP
  for (let pass = 0; pass < 8; pass++) {
    const next: [number, number, number][] = []
    let split = false
    for (const [a, b, c] of tris) {
      const ab = long(a, b), bc = long(b, c), ca = long(c, a)
      if (!ab && !bc && !ca) { next.push([a, b, c]); continue }
      split = true
      const m = (x: number, y: number) => midpoint(x, y)
      if (ab && bc && ca) {
        const p = m(a, b), q = m(b, c), r = m(c, a)
        next.push([a, p, r], [p, b, q], [r, q, c], [p, q, r])
      } else if (ab && bc) {
        const p = m(a, b), q = m(b, c)
        next.push([a, p, q], [p, b, q], [a, q, c])
      } else if (bc && ca) {
        const q = m(b, c), r = m(c, a)
        next.push([b, q, r], [q, c, r], [a, b, r])
      } else if (ca && ab) {
        const r = m(c, a), p = m(a, b)
        next.push([a, p, r], [p, b, r], [b, c, r])
      } else if (ab) {
        const p = m(a, b)
        next.push([a, p, c], [p, b, c])
      } else if (bc) {
        const q = m(b, c)
        next.push([a, b, q], [a, q, c])
      } else {
        const r = m(c, a)
        next.push([a, b, r], [b, c, r])
      }
    }
    tris = next
    if (!split) break
  }

  const lift = patchLift(patch.layer)
  const [s0, s1] = patch.sRange
  const pos = new Float32Array(pts.length * 3)
  const uv = new Float32Array(pts.length * 2)
  const uvM = patch.kind === 'asphalt' ? [13, 20] : patch.kind === 'gravel' ? [3, 3] : patch.kind === 'turf' ? [2, 2] : [9, 9]
  for (let i = 0; i < pts.length; i++) {
    const { x, z } = pts[i]!
    const m = track.nearestOnRange(x, z, s0, s1, 120)
    const off = Math.abs(m.lateral) - track.halfWidthAt(m.s)
    track.pointAt(m.s, m.lateral, _p, 0)
    /**
     * The drape, BLENDED rather than branched.
     *
     * It used to switch hard at off = 1.5 and off = 2.0 while the triangulation has no edge at
     * either, so triangles straddling a threshold became vertical walls — measured on the chicane
     * turf, 84 faces steeper than 15° and one 0.298 m tall, which is what put the dark fringe
     * along the island's road-side edge. The two frames are genuinely far apart here: the analytic
     * terrain runs 41–84 mm below the road plane through the chicane.
     *
     * `PATCH_UNDER` also used to apply out to off 1.5, but it exists to duck below the RACING
     * SURFACE, which only reaches off 0 — so between 0 and 1.5 the patch was sliding 30 mm under
     * the grass verge it is supposed to cover (measured: the verge won 4.09 % of the island).
     *
     * Deliberately NOT ground.yAt: it switches to the terrain MESH height past runoffWidth(s),
     * which would put a step across the middle of a patch at the fold-capped verge edge.
     */
    // the one continuous field (ground-field.ts) carries the strip rule and the 2-8 m blend;
    // a patch only ducks under the racing surface and adds its layer lift
    const underY = _p.y + PATCH_UNDER
    const wRoad = smoothstep((off + 0.2) / 0.7)
    const fieldY = ground.field.y(x, z, [s0, s1]) + lift
    const y = underY + (fieldY - underY) * wRoad
    pos.set([x, y, z], i * 3)
    // metric, world-planar uv — (s, lateral) uv folds for exactly the same reason the geometry does
    uv.set([x / uvM[0]!, -z / uvM[1]!], i * 2)
  }
  const idx: number[] = []
  /*
   * ShapeUtils works in (x, y) = (x, -z); a CCW triangle there is CCW seen from +Y in world.
   *
   * Drop SLIVERS, not just zero-area triangles. Ear clipping leaves ears a fraction of a
   * millimetre wide along a boundary run, and while they cover no pixels their vertices still
   * take a face normal — and because such an ear spans metres of s, the drape can differ by more
   * than 100 mm across it, so that normal points sideways and blackens everything it touches.
   * Measured on the chicane apron: 106 faces past 45°, the worst 89° with 168 mm of vertical
   * extent over 0.0002 m² of area. A triangle thinner than MIN_WIDTH draws nothing, so removing
   * it leaves a hole narrower than a tenth of a millimetre.
   */
  const MIN_WIDTH = 0.002
  for (const [a, b, c] of tris) {
    const cross = (pts[b]!.x - pts[a]!.x) * (pts[c]!.z - pts[a]!.z) - (pts[b]!.z - pts[a]!.z) * (pts[c]!.x - pts[a]!.x)
    const longest = Math.max(
      Math.hypot(pts[b]!.x - pts[a]!.x, pts[b]!.z - pts[a]!.z),
      Math.hypot(pts[c]!.x - pts[b]!.x, pts[c]!.z - pts[b]!.z),
      Math.hypot(pts[a]!.x - pts[c]!.x, pts[a]!.z - pts[c]!.z),
    )
    if (longest > 1e-9 && Math.abs(cross) / longest > MIN_WIDTH) idx.push(a, b, c)
  }
  if (!idx.length) return null
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  g.setIndex(idx)
  g.computeVertexNormals()
  // a vertex left over from a dropped triangle accumulates no face normal at all; (0,0,0)
  // interpolates to black across everything it touches
  const nrm = g.attributes.normal as THREE.BufferAttribute
  for (let i = 0; i < nrm.count; i++) {
    if (Math.hypot(nrm.getX(i), nrm.getY(i), nrm.getZ(i)) < 1e-6) nrm.setXYZ(i, 0, 1, 0)
  }
  return g
}
