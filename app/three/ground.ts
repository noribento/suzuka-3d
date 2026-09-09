import * as THREE from 'three'
import type { Side } from '~/data/suzuka-facilities-spec'
import { signedDelta, type Track } from '~/sim/track'
import type { GroundField } from './ground-field'

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

/**
 * The smallest vertical gap two overlapping opaque ground sheets may be given.
 *
 * The low tier and every SwiftShader run use `logarithmicDepthBuffer` (scene.ts), which writes
 * gl_FragDepth in the fragment shader — and a shader-written depth IGNORES the rasteriser's
 * polygonOffset. So `polygonOffset` is a no-op on exactly the tier the audit shots are taken on,
 * and the geometric separation has to stand on its own. 8 mm is the floor this project uses.
 */
export const LAYER_MIN_STEP = 0.008

/**
 * The ground layer ladder: the one place the vertical order of the overlapping ground sheets is
 * written down, so `scripts/audit/surface-check.mjs` can check it (guard A6) instead of the order
 * living implicitly in eight files.
 *
 * Sheets only compete where they can cover the same (x, z), so the ladder is split into stacks.
 * `road`, `strip` and `pit` are metres from the local road plane; `verge` is metres above the
 * ANALYTIC terrain height, and `mesh` metres above the DRAWN terrain mesh — those two are separate
 * frames today and merging them is Phase 2 (see the plan: `Ground.yAt` switches source mid-verge).
 *
 * Each stack must be strictly ascending. Pairs closer than LAYER_MIN_STEP are listed in
 * LAYER_KNOWN_TIGHT; that list may shrink but never grow.
 */
export const LAYER = {
  /** on the racing surface, |lateral| ≤ half-width */
  road: {
    /** a patch or a lane ducking below the racing surface (surfaces.ts PATCH_UNDER, lanes.ts UNDER) */
    under: -0.06,
    asphalt: 0,
    /** car-model.ts contact shadow — under the car floor (~30 mm), so it stays low */
    contact: 0.008,
    /** lines.ts LIFT */
    line: 0.012,
    /** particles.ts skid marks — above the paint, so a tyre mark darkens it */
    skid: 0.016,
    /** track-mesh.ts DRS detection / activation markings */
    drs: 0.03,
  },
  /** the flat 2 m strip beside the asphalt, under and behind the kerbs */
  strip: {
    /** track-mesh.ts kerbProfile's trailing edge — below the grass so the two are not coplanar */
    kerbOuter: -0.038,
    /** STRIP_DROP: the grass run-off ribbon */
    grass: -0.03,
    /** the asphalt run-off band */
    asphalt: -0.02,
    /** a SURFACE_PATCHES sheet crossing the strip (surfaces.ts) */
    patch: -0.012,
    /** white lines and painted aprons (lines.ts, track-mesh.ts) */
    line: -0.004,
  },
  /** the pit lane and the concrete apron behind it, on the extrapolated road plane */
  pit: {
    /** the garage apron; below the lane so their 0.2 m overlap has a defined winner */
    concrete: 0.002,
    lane: 0.01,
    /** the limit lines, the lane edges and the 11 garage box outlines */
    line: 0.022,
  },
  /** beyond the strip, above the ANALYTIC terrain height */
  verge: {
    /** RUNOFF_LIFT: the grass verge */
    grass: 0.05,
    /** the asphalt run-off band, 1 cm proud of the grass so its outer seam reads as a lip */
    asphalt: 0.06,
    /** white lines on the verge (lines.ts) */
    line: 0.062,
    /** offset-lane paving (lanes.ts ON_GROUND) */
    lane: 0.07,
    /** offset-lane edge lines — above the lane they mark (lanes.ts + 0.028) */
    laneLine: 0.078,
    patchAsphalt: 0.08,
    patchGrass: 0.088,
    gravel: 0.09,
    patchGravel: 0.092,
    patchTurf: 0.095,
    /** offset-lane kerbs (lanes.ts) */
    laneKerb: 0.1,
  },
  /** sheets still draped on the DRAWN terrain mesh (Phase 2 moves these into `verge`) */
  mesh: {
    /** paddock apron and the pit-exit yard (pit-complex.ts) */
    paddock: 0.03,
    /** secondary paving: service roads, kart tracks, the South Course (props.ts) */
    paving: 0.06,
    /** the helipad disc — flat over 16 m, so it needs room over the paddock it sits on */
    helipad: 0.09,
  },
} as const

/**
 * Which rung of `LAYER` each ground MESH is drawn at.
 *
 * `LAYER` says how the rungs are ordered; this says which sheet sits on which — without it the
 * audit can check the ladder but not the geometry, which is exactly the gap that let the chicane
 * ship with the apron and the verge drawn through the turf island while the guard reported 0 %.
 *
 * A sheet that is absent here is exempt as an upper (the kerbs and the sausages belong on top of
 * everything they touch). Cross-frame pairs are not comparable and the audit skips them.
 */
export const SHEET_LAYER: Record<string, [stack: keyof typeof LAYER, rung: string]> = {
  asphalt: ['road', 'asphalt'],
  runoffL: ['verge', 'grass'],
  runoffR: ['verge', 'grass'],
  runoffAsphaltL: ['verge', 'asphalt'],
  runoffAsphaltR: ['verge', 'asphalt'],
  lanePaving: ['verge', 'lane'],
  'surface-asphalt': ['verge', 'patchAsphalt'],
  'surface-grass': ['verge', 'patchGrass'],
  gravel: ['verge', 'gravel'],
  'surface-gravel': ['verge', 'patchGravel'],
  'surface-turf': ['verge', 'patchTurf'],
  laneKerbs: ['verge', 'laneKerb'],
  pitLane: ['pit', 'lane'],
  paddockAsphalt: ['mesh', 'paddock'],
  secondaryPaving: ['mesh', 'paving'],
  helipad: ['mesh', 'helipad'],
}

/**
 * Entries drawn with `transparent: true, depthWrite: false`. They never write depth, so nothing
 * can z-fight them — their height only decides whether they are drawn over the paint or under it,
 * and LAYER_MIN_STEP does not apply to them.
 */
export const LAYER_SOFT = new Set(['road.contact', 'road.skid'])

/**
 * Pairs the ladder cannot yet separate by LAYER_MIN_STEP. Every one of them is a sheet whose base
 * is re-derived in Phase 2 (`Ground.sheetY`) or whose lift becomes `layer`-derived in Phase 4;
 * until then they are recorded so `surface-check` fails on a NEW one rather than on these.
 */
export const LAYER_KNOWN_TIGHT: [string, string][] = [
  ['verge.asphalt', 'verge.line'],
  ['verge.laneLine', 'verge.patchAsphalt'],
  ['verge.patchGrass', 'verge.gravel'],
  ['verge.gravel', 'verge.patchGravel'],
  ['verge.patchGravel', 'verge.patchTurf'],
  ['verge.patchTurf', 'verge.laneKerb'],
]

export interface Ground {
  /** Width of the run-off ribbon (m beyond the asphalt edge) at s on `side` (default left). */
  runoffWidth: (s: number, side?: Side) => number
  /** Ground height at (s, lateral), relative to the road plane at that point. */
  yAt: (s: number, lateral: number) => number
  /** World-space ground height at (s, lateral). */
  worldY: (s: number, lateral: number) => number
  /** the one continuous ground field every field-frame face rides on (ground-field.ts) */
  field: GroundField
}

const _p = new THREE.Vector3()

function smoothstep(t: number): number {
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return t * t * (3 - 2 * t)
}

/**
 * @param field the one continuous ground field (ground-field.ts). `yAt` / `worldY` are thin
 *   views of it: the old 0.25 m memo (12-18 mm of noise on a 0.1 m/m slope) and the switch to the
 *   DRAWN terrain mesh past the verge width (a 165 mm step across the chicane's turf) are gone.
 */
export function makeGround(track: Track, field: GroundField): Ground {
  const L = track.length
  const sOver = track.crossing.sOver
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
    track.pointAt(s, lateral, _p)
    return field.yAt(s, lateral) - _p.y
  }
  const worldY = (s: number, lateral: number): number => field.yAt(s, lateral)
  return { runoffWidth, yAt, worldY, field }
}
