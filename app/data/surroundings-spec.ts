/**
 * Hand-authored constants for the surroundings (plan "柵の外" §1d–§2e) — kept OUT of the
 * ODbL-licensed generated file (suzuka-surroundings.ts). The generator reads the widths, the
 * simplification tolerances and the building-kind thresholds from here so that the data and
 * the rules that shaped it cannot drift apart; the builders read the rest.
 *
 * Not a generated file.
 */
import type { SurBuildingKind } from './en-codec'

// ---------------------------------------------------------------- roads / streams / rail
/** Drawn width (m) per highway class; ways with `lanes` use LANE_WIDTH × lanes + LANE_EXTRA instead. */
export const ROAD_WIDTH: Record<string, number> = {
  trunk: 20, // 中勢バイパス, dual carriageway incl. the median
  trunk_link: 20,
  primary: 9,
  secondary: 8,
  tertiary: 7,
  unclassified: 5.5,
  residential: 5,
  service: 4,
  track: 3,
  /** the south course / kart track / traffic-education loops outside the 150 m keep-out (hand-chosen) */
  raceway: 10,
}
export const LANE_WIDTH = 3.25
export const LANE_EXTRA = 1.5
/** raceway ways closer than this to the GP centreline are the circuit itself — not shipped */
export const RACEWAY_KEEP_OUT = 150

export const STREAM_WIDTH: Record<string, number> = { river: 10, stream: 3 }
/** 伊勢鉄道 single track incl. ballast shoulder */
export const RAIL_WIDTH = 4

// ---------------------------------------------------------------- generator tolerances
/** Douglas–Peucker tolerance (m) per layer */
export const SUR_DP = {
  forest: 1.5,
  farmland: 3,
  grass: 2,
  scrub: 2,
  bare: 2,
  water: 2,
  streams: 2,
  parking: 0.8,
  solar: 1.0,
  buildings: 0.4,
  roads: 1.5,
  rail: 2,
  sites: 2,
} as const

/** polygons below this (m²) are dropped */
export const SUR_MIN_AREA = { default: 60, forest: 300 } as const

// ---------------------------------------------------------------- building kinds (plan §2c)
/** thresholds for `building=yes` with no more specific tag */
export const BUILDING_KIND_RULES = {
  /** unnamed building=yes at or below this footprint (m²) is a dwelling */
  houseMaxArea: 220,
  /** unnamed building=yes at or above this (m²) is a warehouse — the white / blue big boxes of the aerials */
  warehouseMinArea: 800,
} as const

/** OSM way id → kind, when the tags misclassify a building (empty until a builder needs one). */
export const BUILDING_KIND_OVERRIDES: Record<number, SurBuildingKind> = {}

// ---------------------------------------------------------------- placeholders for the builders
// TODO(plan §2c): roof material weights per kind (house tile dark-grey 70 / brown 20 / blue-grey 10 %,
// industrial white 45 / blue 25 / grey membrane 30 %).
export const ROOF_WEIGHTS: Partial<Record<SurBuildingKind, Record<string, number>>> = {}

// TODO(plan §2d): car-body colour mix from the 2026 car-park photo (white pearl 38 / black 24 /
// silver 20 / dark red 6 / blue 5 / other 7 %) and the body-type mix.
export const CAR_COLOURS: { hex: string; weight: number }[] = []

// ---------------------------------------------------------------- forest (plan §2a)
/**
 * The woods: canopy masses per 250 m cell (far), procedural stems (middle), GLB stems (near, high
 * tier). Every number the forest builder (app/three/forest.ts) tunes lives here; the tier budgets
 * (`midTrees`, `heroPerCell`, `nearTrees`, `canopy`, `shadows`, `lodScale`) are in quality.ts.
 */
export const FOREST = {
  /**
   * canopy top over the ground (m) by polygon kind: natural=wood (mixed, ≈ 10 m), landuse=forest
   * (evergreen plantation, ≈ 11 m), the garden woods inside Motopia (pruned, ≈ 7 m), natural=scrub.
   * About 2 m under the stems' crown median so the switch at the stem range is soft.
   */
  canopyH0: { wood: 10, plantation: 11, garden: 7, scrub: 3.5 },
  /** value-noise undulation of the canopy top: ± amplitude (m) at the period (m) */
  canopyNoise: { amp: 1.4, period: 21 },
  /** patch period (m) of the bare / evergreen crown mosaic on the lid */
  patchPeriod: 13,
  /** share of bare (leafless, warm grey-brown) crowns by kind in late March — ≈ 25 % overall in the aerial */
  bareShare: { wood: 0.28, plantation: 0.12, garden: 0.4, scrub: 0.15 },
  /** canopy lids and skirts stop this close to the centreline (m); the forest-floor overlay further out (it lies at ground level, G8's 75 m band) */
  lidMinD: 60,
  floorMinD: 140,
  /** the skirt hangs to standY − drop; inside clampD of the centreline it stops at standY + clamp (the camera band) */
  skirt: { drop: 1, clampD: 80, clamp: 0.5 },
  /** the forest-floor overlay: lift over the ground (m) and its litter colour */
  floorLift: 0.06,
  floorColour: '#3d3a2c',
  /** texture tiles (m): the crown mosaic on the lid, the litter on the floor */
  canopyTileM: 26,
  floorTileM: 7,
  /**
   * procedural stems (vegetation.ts treePrototype): level range (m, × lodScale), the count ramp
   * before it (m), the closest a stem stands to the centreline (the trackside scatter's rule),
   * the late-March species mix, how far in from the polygon edge a cherry may stand, and the
   * minimum stratified spacing (m)
   */
  stems: { range: 900, ramp: 220, minD: 44, mix: { evergreen: 0.72, bare: 0.25, blossom: 0.03 }, edgeM: 14, minSpacing: 4 },
  /**
   * GLB stems (high tier with the asset pack): level range (m), the models by species and the
   * height (m) each is scaled to (the packs ship in assorted units), the hero yaw / scale jitter
   */
  hero: {
    range: 260,
    evergreen: ['model/trees/pine_a', 'model/trees/pine_b'],
    blossom: 'model/trees/autumn_tree',
    heights: { 'model/trees/pine_a': 9.5, 'model/trees/pine_b': 10.5, 'model/trees/autumn_tree': 7.5, 'model/trees/bush': 1.4 } as Record<string, number>,
    scale: [0.85, 1.2] as const,
  },
  /** visibility weight of a polygon for the stem allotment: 1 at the track, falling to `floor` at `far` metres */
  visibility: { far: 1500, floor: 0.35 },
} as const

// LOD ranges per family (forest done; buildings detail and cars 3D / impostor / stipple are filled by plan §2c / §2d).
export const SUR_LOD: Record<string, { near?: number; far?: number }> = {
  forest: { near: FOREST.hero.range, far: FOREST.stems.range },
}

/** Land-cover colours live in app/three/landcover.ts (COVER_COLOURS); nothing to hand-tune here. */
