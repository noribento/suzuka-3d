import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

/**
 * Square-plan steel lattice (a pylon body, the Leader Tower's columns, the start gantry's
 * legs): four corner legs following the taper, a ring at the top of every panel and an X brace
 * on each of the four faces. Extracted from the pylon prototype in props.ts (buildPowerLines);
 * the pylon keeps its cross-arms and insulators as its own bars around this body.
 *
 * Local frame: the base is centred on the origin, +Y up, the faces at ±X / ±Z. Every member is
 * a box, so the whole thing merges into one geometry (≈ 24 triangles per bar).
 */
export interface LatticeSpec {
  /** total height (m) */
  height: number
  /** half-width of the square plan at the base and at the top (m) */
  baseHalf: number
  topHalf: number
  /** panel height (m): rings and braces every `panel`, the last panel taking the remainder */
  panel: number
  /** member sizes (m): the corner legs, the horizontal rings, the diagonal braces */
  leg: number
  ring: number
  brace: number
  /** draw the X braces (the low tier leaves them out: 8 bars per panel) */
  braces: boolean
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const UP = V(0, 1, 0)

/** One square-section bar from `a` to `b`, `w` across (a box, its Y axis along the bar). */
export function barGeometry(a: THREE.Vector3, b: THREE.Vector3, w: number): THREE.BufferGeometry {
  const d = b.clone().sub(a)
  const len = d.length()
  const g = new THREE.BoxGeometry(w, len, w)
  g.translate(0, len / 2, 0)
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, d.normalize()))
  g.translate(a.x, a.y, a.z)
  return g
}

/** The lattice body as one merged geometry (see LatticeSpec). */
export function latticeGeometry(spec: LatticeSpec): THREE.BufferGeometry {
  const parts = latticeParts(spec)
  const merged = mergeGeometries(parts, false)!
  for (const g of parts) g.dispose()
  return merged
}

/** The lattice body's bars, unmerged — for callers that add members of their own before merging. */
export function latticeParts(spec: LatticeSpec): THREE.BufferGeometry[] {
  const { height: H, baseHalf, topHalf, panel } = spec
  const parts: THREE.BufferGeometry[] = []
  const bar = (a: THREE.Vector3, b: THREE.Vector3, w: number) => parts.push(barGeometry(a, b, w))
  const halfAt = (y: number) => baseHalf + (topHalf - baseHalf) * (y / H)
  const rings: number[] = [0]
  for (let y = panel; y < H - 1e-6; y += panel) rings.push(y)
  rings.push(H)
  for (let i = 0; i < rings.length - 1; i++) {
    const y0 = rings[i]!, y1 = rings[i + 1]!
    const h0 = halfAt(y0), h1 = halfAt(y1)
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) bar(V(sx * h0, y0, sz * h0), V(sx * h1, y1, sz * h1), spec.leg)
    // ring at the top of the panel and an X brace on each of the four faces
    bar(V(-h1, y1, -h1), V(h1, y1, -h1), spec.ring)
    bar(V(h1, y1, -h1), V(h1, y1, h1), spec.ring)
    bar(V(h1, y1, h1), V(-h1, y1, h1), spec.ring)
    bar(V(-h1, y1, h1), V(-h1, y1, -h1), spec.ring)
    if (!spec.braces) continue
    for (const f of [-1, 1]) {
      bar(V(-h0, y0, f * h0), V(h1, y1, f * h1), spec.brace)
      bar(V(h0, y0, f * h0), V(-h1, y1, f * h1), spec.brace)
      bar(V(f * h0, y0, -h0), V(f * h1, y1, h1), spec.brace)
      bar(V(f * h0, y0, h0), V(f * h1, y1, -h1), spec.brace)
    }
  }
  return parts
}
