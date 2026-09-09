import * as THREE from 'three'
import type { Side } from '~/data/suzuka-facilities-spec'
import type { GroundField } from './ground-field'
import type { BuiltGround, DecalStats } from './ground-mesh'
import type { GroundPlan, OwnerKind } from './ground-plan'

export { FLAT_STRIP, FOLD_SAFE, RUNOFF_LIFT, STRIP_DROP } from './ground-plan'

/**
 * The ground beside the road, as every trackside builder sees it.
 *
 * The ground is a PARTITION (ground-plan.ts: one opaque owner per XZ point, decided by PRECEDENCE
 * from the data tables; ground-mesh.ts: one mesh per owner kind on shared vertices, one height per
 * vertex), so there is no stack of ground sheets to order by height. What exists above the ground
 * is of two kinds only, and both read the DRAWN faces rather than the field the faces approximate:
 *
 *  - DECALS (paint, rubber, white lines): the drawn faces' own triangles under the decal's outline,
 *    clipped to it and lifted a rung of `LAYER` (`Ground.decal`), so they are coplanar with the
 *    face whatever its facets; never registered, never deciding what the ground is. `markDecal`
 *    tags them for the audit (surface-check G3-decal: no sample under its face, nothing on bare
 *    terrain).
 *  - OBJECTS standing on the ground (the offset-lane kerbs, the sausages): a typed row of
 *    `GROUND_OBJECTS` bounds their footprint width, their edges sink below the face and their
 *    crown stands proud of it (`Ground.standY`). `markObject` tags them (G2 measures the width,
 *    G3-object the sink and the crown).
 *
 * Everything else that stands on the ground (huts, posts, walls, buildings, trees) is placed at
 * `Ground.standY` / `Ground.standAt` too. Nothing outside the ground modules samples the terrain.
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

/**
 * The rungs of the decals, per face they lie on: `road` on the racing surface, `pit` on the pit
 * lane and the garage apron, `verge` on every field-frame face (grass, bands, areas, lanes — the
 * flat strip included). Each stack is a ladder (surface-check G0): ascending, and ≥ LAYER_MIN_STEP
 * apart unless one of the pair is soft (LAYER_SOFT).
 */
export const LAYER = {
  road: {
    /** props.ts rubbered-in braking zones (soft) */
    rubber: 0.006,
    /** car-model.ts contact shadow — under the car floor (~30 mm), so it stays low (soft) */
    contact: 0.008,
    /** lines.ts: the edge lines, grid slots, start line */
    line: 0.012,
    /** particles.ts skid marks — above the paint, so a tyre mark darkens it (soft) */
    skid: 0.016,
    /** track-mesh.ts DRS detection / activation markings */
    drs: 0.03,
  },
  pit: {
    /** lines.ts: the limit / divider / box lines; pit-complex.ts: the car-park bay lines */
    line: 0.022,
  },
  verge: {
    /** track-mesh.ts: the painted aprons and the green strips */
    paint: 0.008,
    /** lines.ts: white lines beyond the road edge (the offset lanes' edge lines included) */
    line: 0.016,
  },
} as const

/**
 * Rungs drawn with `transparent: true, depthWrite: false`. They never write depth, so nothing can
 * z-fight them — their height only decides whether they are drawn over the paint or under it,
 * and LAYER_MIN_STEP does not apply to them.
 */
export const LAYER_SOFT = new Set(['road.rubber', 'road.contact', 'road.skid'])

/** An object standing on the ground: the typed exception to "one opaque face per point" (rule R8). */
export interface GroundObjectRule {
  /** the widest its footprint may be, metres across (surface-check G2: top-view area / length) */
  maxWidth: number
  /** how far its edges sink below the face it stands on (m) — no edge ever lies ON the face */
  sink: number
  /** how far its crown stands above that face (m) */
  crown: number
  why: string
}
export const GROUND_OBJECTS = {
  /** lanes.ts: the kerbs of the two-wheel chicanes and slip roads, a 1 m ribbon over the lane edge */
  laneKerb: { maxWidth: 1.0, sink: 0.02, crown: 0.05, why: 'a kerb has a profile the flat lane face cannot carry; its edges are sunk so no seam shows' },
  /** track-mesh.ts: the yellow anti-cut sausages behind an exit kerb */
  sausage: { maxWidth: 0.4, sink: 0.02, crown: 0.10, why: 'a bump on the kerb; its base is sunk into the kerb face' },
} as const satisfies Record<string, GroundObjectRule>
export type GroundObjectKind = keyof typeof GROUND_OBJECTS

/**
 * Tag `mesh` as an object standing on the ground. `length` is the metres of its run (the audit
 * divides the drawn footprint area by it to measure the width against the rule).
 */
export function markObject(mesh: THREE.Object3D, kind: GroundObjectKind, length: number): void {
  mesh.userData.groundObject = { kind, ...GROUND_OBJECTS[kind], length }
}

/**
 * Tag `mesh` as a decal drawn `rung` metres over the face it lies on. An opaque decal needs
 * LAYER_MIN_STEP at least; a soft one (transparent, no depth write) may sit anywhere above 0.
 * `stats` (from `Ground.decal`) records how much of its outline had no face under it.
 */
export function markDecal(mesh: THREE.Mesh, rung: number, stats?: DecalStats): void {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
  const soft = mats.every((m) => m.transparent && !m.depthWrite)
  if (import.meta.dev && !soft && rung < LAYER_MIN_STEP - 1e-9) console.error(`[ground] decal '${mesh.name}' at ${(rung * 1000).toFixed(0)} mm: an opaque decal needs LAYER_MIN_STEP (${LAYER_MIN_STEP * 1000} mm) over its face`)
  if (import.meta.dev && stats && stats.uncovered > 1) console.warn(`[ground] decal '${mesh.name}': ${stats.uncovered.toFixed(0)} m² of its ${stats.area.toFixed(0)} m² outline has no drawn face under it (bare terrain) — not drawn there; worst at ${stats.bareAt.slice(0, 5).map(([x, z, m2]) => `(${x.toFixed(0)}, ${z.toFixed(0)}) ${m2.toFixed(1)} m²`).join(', ')}`)
  mesh.userData.decal = { rung, soft, area: stats?.area ?? 0, uncovered: stats?.uncovered ?? 0, bareAt: stats?.bareAt ?? [] }
}

export interface Ground {
  /** the partition: owners, stations, extents, the decal lattice (ground-plan.ts) */
  plan: GroundPlan
  /** the one continuous ground field every field-frame face rides on (ground-field.ts) */
  field: GroundField
  /** How far the ground raster reaches beyond the road edge at s on `side` (the plan's extent). */
  extent: (s: number, side: Side) => number
  /**
   * The DRAWN ground at world (x, z): the top face of the built ground meshes and its kind, null
   * where no face is drawn (bare terrain).
   */
  builtY: (x: number, z: number) => { y: number; kind: OwnerKind; src: number } | null
  /**
   * What an OBJECT stands on at world (x, z): the drawn ground face, or the settled terrain mesh
   * where no face is drawn. World height.
   */
  standY: (x: number, z: number) => number
  /** `standY` at track (s, lateral), relative to the road plane there — the frame the trackside builders place in. */
  standAt: (s: number, lateral: number) => number
  /**
   * What a DECAL lies on at world (x, z): the drawn face's height. Where no face is drawn the decal
   * has nothing to lie on — a data or build-order bug: reported once, counted by surface-check
   * G3-decal, and the field is returned so the build completes.
   */
  decalY: (x: number, z: number) => number
  /**
   * A decal on the drawn ground: the faces' triangles under the outline quads, clipped and lifted
   * (ground-mesh.ts). The only way to draw paint that is coplanar with the ground's facets.
   */
  decal: BuiltGround['decal']
}

const _p = new THREE.Vector3()

/**
 * The ground before it is drawn: the plan and the field are usable, everything that reads the
 * DRAWN faces throws until `settleGround` (build order: plan → meshes → terrain.settle → settleGround
 * → everything that stands on the ground).
 */
export function makeGround(field: GroundField, plan: GroundPlan): Ground {
  const notYet = (what: string) => (): never => { throw new Error(`[ground] ${what} read before the ground was settled — build order: plan → meshes → settle → everything that stands on the ground`) }
  return { plan, field, extent: plan.extent, builtY: notYet('builtY'), standY: notYet('standY'), standAt: notYet('standAt'), decalY: notYet('decalY'), decal: notYet('decal') }
}

/**
 * Wire the drawn ground into `ground` once the faces exist and the terrain is settled under them:
 * from here on `standY` / `decalY` read what is rendered. `terrainY` is the settled terrain mesh.
 */
export function settleGround(ground: Ground, built: BuiltGround, terrainY: (x: number, z: number) => number): void {
  const track = ground.plan.track
  const builtY = built.yAt
  ground.builtY = builtY
  ground.decal = built.decal
  ground.standY = (x, z) => builtY(x, z)?.y ?? terrainY(x, z)
  ground.standAt = (s, lateral) => {
    track.pointAt(s, lateral, _p, 0)
    return ground.standY(_p.x, _p.z) - _p.y
  }
  let bare = 0
  ground.decalY = (x, z) => {
    const f = builtY(x, z)
    if (f) return f.y
    if (bare++ === 0) console.error(`[ground] a decal at (${x.toFixed(1)}, ${z.toFixed(1)}) has no drawn face under it — it lies on bare terrain (surface-check G3 counts these)`)
    return ground.field.y(x, z)
  }
}
