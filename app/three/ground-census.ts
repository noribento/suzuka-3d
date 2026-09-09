/**
 * The runtime census: the face visible from above at a point vs the owner the plan declares
 * there — the browser's cut of surface-check's G1 (R1), for the e2e suite and the dev console.
 * Points within the seam band of an owner boundary are not judged (a boundary is drawn with the
 * plan's shared vertices, and the census asks about the areas, not the line).
 */
import * as THREE from 'three'
import type { Track } from '../sim/track'
import { inWorldRing, type GroundPlan } from './ground-plan'
import type { BuiltGround } from './ground-mesh'

export interface GroundCensus {
  samples: number
  seam: number
  match: number
  mismatch: number
  /** the first mismatches: expected > got at (x, z) */
  worst: { x: number; z: number; expected: string; got: string }[]
  ms: number
}

export function groundCensus(track: Track, plan: GroundPlan, built: BuiltGround, opts: { stepS?: number; stepAcross?: number; seam?: number } = {}): GroundCensus {
  const t0 = performance.now()
  const stepS = opts.stepS ?? 4
  const stepAcross = opts.stepAcross ?? 2
  const seam = opts.seam ?? 0.5
  const out: GroundCensus = { samples: 0, seam: 0, match: 0, mismatch: 0, worst: [], ms: 0 }
  const kindAt = (x: number, z: number) => plan.ownerAt(x, z).kind
  const judge = (x: number, z: number) => {
    out.samples++
    const exp = kindAt(x, z)
    // the seam band as a disc of eight probes
    for (const [dx, dz] of [[seam, 0], [-seam, 0], [0, seam], [0, -seam], [seam * Math.SQRT1_2, seam * Math.SQRT1_2], [-seam * Math.SQRT1_2, seam * Math.SQRT1_2], [seam * Math.SQRT1_2, -seam * Math.SQRT1_2], [-seam * Math.SQRT1_2, -seam * Math.SQRT1_2]]) {
      if (kindAt(x + dx!, z + dz!) !== exp) { out.seam++; return }
    }
    const got = built.yAt(x, z)?.kind ?? 'terrain'
    if (got === exp) out.match++
    else { out.mismatch++; if (out.worst.length < 20) out.worst.push({ x, z, expected: exp, got }) }
  }
  const p = new THREE.Vector3()
  const L = track.length
  // the double crossover window is the one place two roads own the same XZ: skipped, as in G1
  const { sOver, sUnder } = track.crossing
  const lapGap = (a: number, b: number) => { const d = Math.abs(a - b) % L; return Math.min(d, L - d) }
  const inCross = (s: number) => lapGap(s, sOver) < 115 || lapGap(s, sUnder) < 115
  // the verge lattice, both sides, out to the drawn extent
  for (let s = 0; s < L; s += stepS) {
    if (inCross(s)) continue
    const hw = track.halfWidthAt(s)
    for (const side of [1, -1] as const) {
      const W = plan.extentDrawn(s, side)
      for (let off = stepAcross / 2; off < W - seam; off += stepAcross) {
        track.pointAt(s, side * (hw + off), p, 0)
        judge(p.x, p.z)
      }
    }
  }
  // the rings' interiors beyond the lattice, on a grid
  for (const r of plan.rings) {
    const b = r.ring.box
    for (let x = Math.ceil(b[0]); x <= b[1]; x += stepAcross) for (let z = Math.ceil(b[2]); z <= b[3]; z += stepAcross) {
      const pr = plan.project(x, z)
      if (inCross(pr.s)) continue
      const off = Math.abs(pr.lateral) - track.halfWidthAt(pr.s)
      if (off <= plan.extentDrawn(pr.s, pr.lateral >= 0 ? 1 : -1) - seam) continue
      if (!inWorldRing(x, z, r.ring)) continue
      judge(x, z)
    }
  }
  out.ms = performance.now() - t0
  return out
}
