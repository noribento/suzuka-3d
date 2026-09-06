import * as THREE from 'three'
import type { Side } from '~/data/suzuka-facilities-spec'
import { signedDelta, type Track } from '~/sim/track'

/**
 * The ground beside the road, shared by the run-off ribbons, the trackside objects and the
 * barriers so that everything stands on the same surface.
 *
 * Cross-section on either side of the road (offsets from the asphalt edge):
 *  - a flat 2 m strip on the road plane (the kerbs and their drop-off live here),
 *  - the run-off proper, draped 5 cm above the terrain, so it follows embankments where the
 *    terrain falls away (the crossover, the back straight above 200R) instead of floating,
 *  - beyond RUNOFF_WIDTH the bare terrain.
 * On the elevated crossover the run-off narrows to the width of the deck, and in a tight corner
 * it narrows to whatever the swept frame can carry without turning inside out (FOLD_SAFE).
 */
export const RUNOFF_WIDTH = 34
export const FLAT_STRIP = 2
/**
 * A ribbon swept `lat` metres to the INSIDE of a corner of curvature k is compressed by
 * (1 - k*lat); at lat = 1/k it collapses to a point and past it the surface is inside out.
 * Measured on the built track (the Jacobian of `pointAt`), the 34 m verge folded in six places:
 * T3 left, Degner 1 and 2 right, the hairpin left and both chicane elements — the chicane's
 * radius is only 20-23 m, so the verge there was self-intersecting from ~10 m out. Keep the
 * Jacobian at or above 1 - FOLD_SAFE.
 */
export const FOLD_SAFE = 0.7
/** Height of the run-off ribbon above the terrain (and of the flat strip below the asphalt). */
export const RUNOFF_LIFT = 0.05
export const STRIP_DROP = -0.03

export interface Ground {
  /** Width of the run-off ribbon (m beyond the asphalt edge) at s on `side` (default left). */
  runoffWidth: (s: number, side?: Side) => number
  /** Ground height at (s, lateral), relative to the road plane at that point. */
  yAt: (s: number, lateral: number) => number
  /** World-space ground height at (s, lateral). */
  worldY: (s: number, lateral: number) => number
}

const _p = new THREE.Vector3()

function smoothstep(t: number): number {
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return t * t * (3 - 2 * t)
}

/**
 * @param terrainHeightAt analytic terrain height (the run-off ribbons drape over this)
 * @param meshHeightAt height of the rendered terrain mesh, used beyond the ribbons so that
 *   objects stand on the triangles that are actually drawn
 */
export function makeGround(track: Track, terrainHeightAt: (x: number, z: number) => number, meshHeightAt: (x: number, z: number) => number = terrainHeightAt): Ground {
  const L = track.length
  const sOver = track.crossing.sOver
  // The analytic terrain height is the expensive part of every drape sample (a spatial hash
  // plus dozens of noise evaluations) and the ribbons ask for it ~100k times at start-up.
  // Memoise it on a 0.25 m grid — far below the 2–4 m ribbon step, so the surface is the
  // same analytic one (the crossover tolerance above is untouched).
  const memo = new Map<number, number>()
  const heightMemo = (x: number, z: number): number => {
    const key = ((Math.round(x * 4) & 0xffff) << 16) ^ (Math.round(z * 4) & 0xffff)
    let h = memo.get(key)
    if (h === undefined) {
      h = terrainHeightAt(x, z)
      memo.set(key, h)
    }
    return h
  }
  // the bridge deck is hw + 1.2 wide; the verge is back to full width 110 m from the crossing
  const crossover = (s: number): number => {
    const d = Math.abs(signedDelta(sOver, s, L))
    return 1.2 + (RUNOFF_WIDTH - 1.2) * smoothstep((d - 50) / 60)
  }
  /**
   * How far the verge can reach on `side` before the swept frame inverts (see FOLD_SAFE), per
   * sample. Infinite on the outside of a corner, where the frame only stretches. This MUST stay
   * side-aware: a side-blind cap would shrink the Degner 1-2 gravel trap (left, 37 m), because
   * the fold there is on the right.
   *
   * The compression is MEASURED, not taken from `track.kappaAt`: `pointAt` interpolates the
   * sample normals and adds the camber, so the real curvature of the swept frame is up to 40 %
   * higher than the +/-10 m-smoothed `kappaS` (at the chicane, 0.075 vs 0.046 — using kappaS
   * left a Jacobian of 0.02 at the ribbon edge, i.e. still folded). |pointAt(s+ds, lat) -
   * pointAt(s, lat)| / ds is exactly |1 - lat * kEff|, affine in lat, so one probe pins it.
   */
  const foldTable = { 1: new Float32Array(track.n), '-1': new Float32Array(track.n) }
  {
    const a = new THREE.Vector3(), b = new THREE.Vector3()
    const jac = (s: number, lat: number): number => {
      track.pointAt(s, lat, a)
      track.pointAt(s + 0.5, lat, b)
      return a.distanceTo(b) * 2
    }
    const PROBE = 10 // metres out; inside rollLift's full-camber zone (+/-9.5) is close enough
    const R = Math.round(10 / track.ds) // running max of the curvature over +/-10 m, then a
    const B = Math.round(10 / track.ds) // box smooth of the width, so the verge funnels in
    for (const side of [1, -1] as const) {
      const k = new Float32Array(track.n)
      for (let i = 0; i < track.n; i++) {
        const s = i * track.ds
        const j0 = jac(s, 0) || 1
        k[i] = (j0 - jac(s, PROBE * side)) / (PROBE * j0)
      }
      const raw = new Float32Array(track.n)
      for (let i = 0; i < track.n; i++) {
        let m = 0
        for (let d = -R; d <= R; d++) m = Math.max(m, k[(i + d + track.n * 2) % track.n]!)
        raw[i] = m > 1e-4 ? Math.max(FLAT_STRIP + 1, FOLD_SAFE / m - track.halfWidthAt(i * track.ds)) : RUNOFF_WIDTH
        if (raw[i]! > RUNOFF_WIDTH) raw[i] = RUNOFF_WIDTH
      }
      const t = foldTable[side]
      for (let i = 0; i < track.n; i++) {
        let sum = 0
        for (let d = -B; d <= B; d++) sum += raw[(i + d + track.n * 2) % track.n]!
        // smoothing a lower bound can only raise it, so clamp back to the bound
        t[i] = Math.min(sum / (2 * B + 1), raw[i]!)
      }
    }
  }
  const foldSafe = (s: number, side: Side): number => {
    const t = foldTable[side]
    const u = track.wrap(s) / track.ds
    const i = Math.floor(u) % track.n
    const f = u - Math.floor(u)
    return t[i]! * (1 - f) + t[(i + 1) % track.n]! * f
  }
  const runoffWidth = (s: number, side: Side = 1): number => Math.min(crossover(s), foldSafe(s, side))
  const yAt = (s: number, lateral: number): number => {
    const off = Math.abs(lateral) - track.halfWidthAt(s)
    if (off <= 0) return 0
    const w = runoffWidth(s, lateral >= 0 ? 1 : -1)
    // the ribbon's outer edge is placed at exactly hw + w, and (hw + w) - hw lands a rounding
    // error beyond w: without the tolerance that edge drops to the terrain, which hangs a
    // curtain of grass from the crossover deck down to the road underneath
    if (off <= Math.min(FLAT_STRIP, w) + 1e-3) return STRIP_DROP
    track.pointAt(s, lateral, _p)
    return (off <= w ? heightMemo(_p.x, _p.z) + RUNOFF_LIFT : meshHeightAt(_p.x, _p.z)) - _p.y
  }
  const worldY = (s: number, lateral: number): number => {
    const y = yAt(s, lateral)
    track.pointAt(s, lateral, _p)
    return _p.y + y
  }
  return { runoffWidth, yAt, worldY }
}
