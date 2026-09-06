import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { SURFACE_PATCHES, type SurfaceKind, type SurfacePatch } from '~/data/suzuka-facilities-spec'
import type { Track } from '~/sim/track'
import { FLAT_STRIP, RUNOFF_LIFT, STRIP_DROP, type Ground } from './ground'
import { patchOutline } from './trackside'

/**
 * Paved / unpaved AREAS beside the road, from the SURFACE_PATCHES table.
 *
 * The run-off in track-mesh.ts is a set of lateral bands swept along s, and that cannot describe
 * the Casio Triangle: its apron reaches 45 m to the left of the lap, while a ribbon swept past
 * ~16 m to the INSIDE of the chicane's 20-23 m corner turns inside out (ground.ts FOLD_SAFE).
 * So these are polygons: resolved to a world-space outline by `patchOutline`, triangulated in XZ,
 * refined until no edge is longer than PATCH_STEP, and draped on the same surface the run-off
 * ribbons use. They are painted in `layer` order — no holes, an island simply paints back over
 * the apron underneath it.
 */

/** longest edge of a patch triangle (m): fine enough to drape, coarse enough for clampUnder */
const PATCH_STEP = 4
/** the patch ducks below the racing surface where the two overlap, as lanes.ts does */
const PATCH_UNDER = -0.06
/**
 * Height above the surface the patch is painted on, per kind. It has to be centimetres, not an
 * epsilon: the patch samples the terrain at its own vertices and the grass ribbon at its own, and
 * the interpolation difference between two 2-4 m meshes over the terrain's noise is millimetres.
 * Stays below the kerb top (+0.065) and above the asphalt run-off band (+0.010).
 */
const PATCH_LIFT: Record<SurfaceKind, number> = { asphalt: 0.03, grass: 0.038, gravel: 0.042, turf: 0.045 }

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
}

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

  for (const patch of SURFACE_PATCHES) {
    const ring = patchOutline(track, patch, 2)
    if (ring.length < 3) continue
    const geo = patchGeometry(track, ground, terrainHeightAt, patch, ring)
    if (!geo) continue
    ;(perKind[patch.kind] ??= []).push(geo)
    zones.push({ ring, lift: PATCH_LIFT[patch.kind], sRange: patch.sRange })
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
  return { meshes, geometries, liftAt }
}

function inRing(x: number, z: number, ring: { x: number; z: number }[]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside
  }
  return inside
}

function patchGeometry(
  track: Track,
  ground: Ground,
  terrainHeightAt: (x: number, z: number) => number,
  patch: SurfacePatch,
  ring: { x: number; z: number }[],
): THREE.BufferGeometry | null {
  // triangulate the outline flat, in world XZ (never in (s, lateral) — that frame folds here)
  const contour = ring.map((p) => new THREE.Vector2(p.x, -p.z))
  const faces = THREE.ShapeUtils.triangulateShape(contour, [])
  if (!faces.length) return null

  const pts = ring.map((p) => ({ x: p.x, z: p.z }))
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

  const lift = PATCH_LIFT[patch.kind]
  const [s0, s1] = patch.sRange
  const pos = new Float32Array(pts.length * 3)
  const uv = new Float32Array(pts.length * 2)
  const uvM = patch.kind === 'asphalt' ? [13, 20] : patch.kind === 'gravel' ? [3, 3] : patch.kind === 'turf' ? [2, 2] : [9, 9]
  for (let i = 0; i < pts.length; i++) {
    const { x, z } = pts[i]!
    const m = track.nearestOnRange(x, z, s0, s1, 120)
    const off = Math.abs(m.lateral) - track.halfWidthAt(m.s)
    track.pointAt(m.s, m.lateral, _p, 0)
    // Deliberately NOT ground.yAt: it switches to the terrain MESH height past runoffWidth(s),
    // which would put a step across the middle of a patch at the fold-capped verge edge.
    const y =
      off < 1.5 ? _p.y + PATCH_UNDER
      : off <= FLAT_STRIP ? _p.y + STRIP_DROP + 0.012
      : terrainHeightAt(x, z) + RUNOFF_LIFT + lift
    pos.set([x, y, z], i * 3)
    // metric, world-planar uv — (s, lateral) uv folds for exactly the same reason the geometry does
    uv.set([x / uvM[0]!, -z / uvM[1]!], i * 2)
  }
  const idx: number[] = []
  // ShapeUtils works in (x, y) = (x, -z); a CCW triangle there is CCW seen from +Y in world
  for (const [a, b, c] of tris) idx.push(a, b, c)
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}
