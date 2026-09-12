import * as THREE from 'three'
import { TV_CAMERAS, type TvCameraDef, type TvTowerKind } from '~/data/suzuka-barriers-spec'
import type { Track } from '~/sim/track'
import { barrierLateralAt } from './trackside'

/**
 * Where the broadcast lenses are (plan I4-b): the ONE place that turns a TV_CAMERAS row into a
 * tower centre and a lens point, read by the tower builder (tv-towers.ts draws the platform
 * under the lens), the camera rig (cameras.ts `setTvCameras` looks from the lens) and the guard
 * (facilities-check §16 O7 / trackside-smoke check the same numbers). Pure: the track, the
 * barrier table and the resolved barrier lines (trackside.ts) — no scene, no ground; the
 * caller passes `standAt` (ground.standAt) to lift the lens onto the drawn ground, the guard
 * leaves it at the road plane.
 */

/** the tower ⇄ lens geometry every reader shares */
export const TV_LENS = {
  /** an 'auto' tower stands this far behind the resolved BARRIERS line, on the spectator side (m) */
  autoSetback: 2.5,
  /** the lens is this far towards the track from the tower's centre (m): the tripod stands inside the front rail */
  forward: 0.65,
  /** the platform's deck top is this far under the lens (m) — below y_lens − 0.5, the rig's NEAR */
  deckDrop: 0.6,
  /** the platform rail above the deck (m) */
  rail: 1.1,
} as const

/** the footprint (square side, m) of each tower kind — the guard's O5 / O7 distance to the barrier line */
export const TV_TOWER_FOOTPRINT: Record<TvTowerKind, number> = { scaffold: 2.4, lattice: 3.2, crane: 1.5, pole: 0.5 }

/** Which side of the track a trackside camera stands on: the outside of the nearest corner (+1 = the driver's left on a straight). */
export function cameraSide(track: Track, s: number): 1 | -1 {
  let k = 0
  for (let d = -40; d <= 40; d += 10) k += track.kappaAt(s + d)
  if (Math.abs(k) < 1e-4) return 1
  return k > 0 ? -1 : 1
}

/** The tower's centre lateral: the row's number, or 'auto' = the barrier line on the camera side + the set-back. */
export function towerLateralAt(track: Track, row: TvCameraDef): number {
  if (row.lateral !== 'auto') return row.lateral
  const side = cameraSide(track, row.s)
  const line = barrierLateralAt(track, row.s, side)
  if (line === null) throw new Error(`[tv-lens] TV_CAMERAS '${row.id}': lateral 'auto' but no BARRIERS run on side ${side} at s ${row.s}`)
  return line + side * TV_LENS.autoSetback
}

export interface TvLens {
  id: string
  s: number
  /** the lens, metres from the centreline */
  lateral: number
  /** the tower's centre */
  towerLateral: number
  /** the side of the track the tower stands on (the sign of towerLateral) */
  side: 1 | -1
  /** the lens in world space */
  x: number
  y: number
  z: number
  /** the tower's ground above the road plane (what `standAt` answered) and the lens above that ground */
  base: number
  height: number
}

const _p = new THREE.Vector3()

/**
 * The lens point of a TV_CAMERAS row: the tower stands at `towerLateralAt` on `standAt(s,
 * towerLateral)` (relative to the road plane; the road plane itself when omitted), the lens
 * `row.height` above that ground and `TV_LENS.forward` towards the track. World xyz through
 * `track.pointAt` at the LENS lateral (the roll between the two laterals is millimetres).
 */
export function tvLensAt(track: Track, row: TvCameraDef, standAt: (s: number, lateral: number) => number = () => 0): TvLens {
  const towerLateral = towerLateralAt(track, row)
  const side: 1 | -1 = towerLateral < 0 ? -1 : 1
  const lateral = towerLateral - side * TV_LENS.forward
  const base = standAt(row.s, towerLateral)
  track.pointAt(row.s, lateral, _p, base + row.height)
  return { id: row.id, s: track.wrap(row.s), lateral, towerLateral, side, x: _p.x, y: _p.y, z: _p.z, base, height: row.height }
}

/** the lens rows of TV_CAMERAS (in table order = the rig's CAM order) */
export function tvLensRows(): TvCameraDef[] {
  return TV_CAMERAS.filter((c) => c.lens !== false)
}

/** every lens of the rig, in table order */
export function tvLenses(track: Track, standAt?: (s: number, lateral: number) => number): TvLens[] {
  return tvLensRows().map((row) => tvLensAt(track, row, standAt))
}
