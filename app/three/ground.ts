import * as THREE from 'three'
import type { Side } from '~/data/suzuka-facilities-spec'
import type { Track } from '~/sim/track'
import type { GroundField } from './ground-field'
import type { GroundPlan, OwnerKind } from './ground-plan'

export { FLAT_STRIP, FOLD_SAFE, RUNOFF_LIFT, STRIP_DROP } from './ground-plan'

/**
 * The ground beside the road, as every trackside builder sees it.
 *
 * Since the ground became a PARTITION (ground-plan.ts: one opaque owner per XZ point, decided by
 * PRECEDENCE from the data tables; ground-mesh.ts: one mesh per owner kind on shared vertices, one
 * height per vertex) there is no stack of ground sheets left to order by height. What remains
 * above the ground is of two kinds only:
 *
 *  - DECALS (paint, rubber, white lines): drawn a few millimetres above the face they lie on,
 *    never registered, never deciding what the ground is;
 *  - OBJECTS standing on the ground (the offset-lane kerbs, the sausages): their footprint is
 *    bounded and their edges sink below the face.
 *
 * `LAYER` is the ladder of those heights, per frame the decal is measured from. `road` / `pit`
 * are metres from the local ROAD PLANE (the racing surface, the pit lane and apron are road-frame
 * owners); `verge` is metres above the DRAWN face beside the road — the flat strip included,
 * whose first cell ramps from the road edge to STRIP_DROP because it shares the road's vertices.
 */

/**
 * The smallest vertical gap two opaque surfaces may be given.
 *
 * The low tier and every SwiftShader run use `logarithmicDepthBuffer` (scene.ts), which writes
 * gl_FragDepth in the fragment shader — and a shader-written depth IGNORES the rasteriser's
 * polygonOffset. So `polygonOffset` is a no-op on exactly the tier the audit shots are taken on,
 * and the geometric separation has to stand on its own. 8 mm is the floor this project uses.
 */
export const LAYER_MIN_STEP = 0.008

export const LAYER = {
  /** on the racing surface, |lateral| ≤ half-width (metres above the road plane) */
  road: {
    /** car-model.ts contact shadow — under the car floor (~30 mm), so it stays low */
    contact: 0.008,
    /** lines.ts LIFT */
    line: 0.012,
    /** particles.ts skid marks — above the paint, so a tyre mark darkens it */
    skid: 0.016,
    /** track-mesh.ts DRS detection / activation markings */
    drs: 0.03,
  },
  /** the pit lane and the garage apron are on the road plane; their limit / box lines */
  pit: {
    line: 0.022,
  },
  /** metres above the drawn field-frame face (grass, bands, areas, lanes) */
  verge: {
    /** white lines on the verge (lines.ts) */
    line: 0.012,
    /** offset-lane edge lines (lines.ts) */
    laneLine: 0.028,
    /** offset-lane kerbs (lanes.ts): objects, their crown */
    laneKerb: 0.05,
  },
} as const

/**
 * Entries drawn with `transparent: true, depthWrite: false`. They never write depth, so nothing
 * can z-fight them — their height only decides whether they are drawn over the paint or under it,
 * and LAYER_MIN_STEP does not apply to them.
 */
export const LAYER_SOFT = new Set(['road.contact', 'road.skid'])

export interface Ground {
  /** the partition: owners, stations, extents (ground-plan.ts) */
  plan: GroundPlan
  /** the one continuous ground field every field-frame face rides on (ground-field.ts) */
  field: GroundField
  /** Ground height at (s, lateral), relative to the road plane at that point. */
  yAt: (s: number, lateral: number) => number
  /** World-space ground height at (s, lateral). */
  worldY: (s: number, lateral: number) => number
  /** How far the ground raster reaches beyond the road edge at s on `side` (the plan's extent). */
  extent: (s: number, side: Side) => number
  /**
   * The DRAWN ground at world (x, z): the top face of the built ground meshes and its kind, null
   * where no face is drawn (bare terrain). Decals and objects stand on this, so they are coplanar
   * with what is rendered rather than with the field the faces approximate. Wired by
   * buildEnvironment once the meshes exist; a call before that is a build-order bug.
   */
  builtY: (x: number, z: number) => { y: number; kind: OwnerKind; src: number } | null
}

const _p = new THREE.Vector3()

/**
 * @param field the one continuous ground field (ground-field.ts). `yAt` / `worldY` are thin
 *   views of it: the old 0.25 m memo (12-18 mm of noise on a 0.1 m/m slope) and the switch to the
 *   DRAWN terrain mesh past the verge width (a 165 mm step across the chicane's turf) are gone.
 * @param plan the ground plan; its extent replaces the old fold-capped `runoffWidth`
 */
export function makeGround(track: Track, field: GroundField, plan: GroundPlan): Ground {
  const yAt = (s: number, lateral: number): number => {
    track.pointAt(s, lateral, _p)
    return field.yAt(s, lateral) - _p.y
  }
  const worldY = (s: number, lateral: number): number => field.yAt(s, lateral)
  return {
    plan,
    field,
    yAt,
    worldY,
    extent: plan.extent,
    builtY: () => { throw new Error('[ground] builtY read before the ground meshes were built') },
  }
}
