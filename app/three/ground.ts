import * as THREE from 'three'
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
 * On the elevated crossover the run-off narrows to the width of the deck.
 */
export const RUNOFF_WIDTH = 34
export const FLAT_STRIP = 2
/** Height of the run-off ribbon above the terrain (and of the flat strip below the asphalt). */
export const RUNOFF_LIFT = 0.05
export const STRIP_DROP = -0.03

export interface Ground {
  /** Width of the run-off ribbon (m beyond the asphalt edge) at s. */
  runoffWidth: (s: number) => number
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
  const runoffWidth = (s: number): number => {
    // the bridge deck is hw + 1.2 wide; the verge is back to full width 110 m from the crossing
    const d = Math.abs(signedDelta(sOver, s, L))
    return 1.2 + (RUNOFF_WIDTH - 1.2) * smoothstep((d - 50) / 60)
  }
  const yAt = (s: number, lateral: number): number => {
    const off = Math.abs(lateral) - track.halfWidthAt(s)
    if (off <= 0) return 0
    const w = runoffWidth(s)
    if (off <= Math.min(FLAT_STRIP, w)) return STRIP_DROP
    track.pointAt(s, lateral, _p)
    return (off <= w ? terrainHeightAt(_p.x, _p.z) + RUNOFF_LIFT : meshHeightAt(_p.x, _p.z)) - _p.y
  }
  const worldY = (s: number, lateral: number): number => {
    const y = yAt(s, lateral)
    track.pointAt(s, lateral, _p)
    return _p.y + y
  }
  return { runoffWidth, yAt, worldY }
}
