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

// TODO(plan §2a/§2c/§2d): LOD ranges per family (forest canopy mass / trunks / GLB heroes, buildings detail,
// cars 3D / impostor / stipple).
export const SUR_LOD: Record<string, { near?: number; far?: number }> = {}

// TODO(plan §1e): land-cover mask colours and the class priority order.
export const COVER_COLOURS: Record<string, string> = {}
