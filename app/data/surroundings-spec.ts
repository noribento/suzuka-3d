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
/**
 * The road cross-section per highway class — ONE table shared by the generator (`width` of a
 * SUR_ROADS row is `roadSectionOf(kind, tags).paved`), the land-cover mask (it paints that
 * width) and the ribbon builder (it draws the markings from the rest of the section), so the
 * data, the mask and the paint can never disagree about how wide a road is. The numbers follow
 * the Japanese rural standards (道路構造令 第 3 種): lane widths by class, 路肩 shoulders, and
 * fixed widths for the classes OSM maps without a lane count. The 中勢バイパス is mapped as two
 * one-way `trunk` carriageways with `lanes=1`, so its 20 m dual-carriageway width never applies;
 * each carriageway is one 3.5 m lane between a 1.75 m stopping lane and a 0.75 m median shoulder.
 */
export const ROAD_SECTION = {
  /** lane width (m) of the lane-based classes; the `lanes` tag sets the count (default 2, 1 when one-way) */
  lane: { trunk: 3.5, primary: 3.25, secondary: 3.0, tertiary: 3.0, unclassified: 2.75 } as Record<string, number>,
  /** shoulder (m) on each side of the lane-based classes (also the inset of the edge line); unclassified = 2 × 2.75 = 5.5 m, no marked shoulder */
  shoulder: { trunk: 0.75, primary: 0.75, secondary: 0.75, tertiary: 0.5, unclassified: 0 } as Record<string, number>,
  /** paved width (m) of the classes whose lane count is not meaningful; a parseable `width` tag overrides it */
  fixed: { trunk_link: 6.0, residential: 5.0, service: 4.0, track: 3.0, raceway: 10 } as Record<string, number>,
  /** a one-way trunk carriageway's shoulders (m): [outer stopping lane, median side] — the sum replaces 2 × shoulder */
  onewayTrunkShoulders: [1.75, 0.75] as readonly [number, number],
  /** painted median (m) added to a two-way trunk with `lanes` ≥ 4 */
  median: 1.5,
  /** a two-way road at least this wide (m) gets a dashed centre line; at `solidMin` it is solid */
  centreMin: 5.5,
  solidMin: 12,
  /** classes with white edge lines (車道外側線), `shoulder` inside the paved edge */
  edgeKinds: ['trunk', 'trunk_link', 'primary', 'secondary', 'tertiary'] as readonly string[],
  /** classes that may carry an L-gutter band — the runtime turns it on inside the settle mask only */
  gutterKinds: ['residential', 'unclassified'] as readonly string[],
  /** `surface` values that make any class unsealed (gravel / dirt), and the ones that seal a `track` */
  unsealed: ['unpaved', 'gravel', 'dirt', 'ground', 'grass', 'compacted', 'fine_gravel', 'sand', 'earth'] as readonly string[],
  sealed: ['asphalt', 'paved', 'concrete', 'paving_stones'] as readonly string[],
  /** classes that never get a centre line (a race course paints its own) */
  unmarked: ['raceway'] as readonly string[],
  /** junction precedence: the higher rank keeps its paved edge, the lower one is trimmed to it (also the drawn class list) */
  rank: { trunk: 8, trunk_link: 7, primary: 6, secondary: 5, tertiary: 4, unclassified: 3, residential: 2, raceway: 2, service: 1, track: 0 } as Record<string, number>,
  /** class rung over the base lift (m): 0 / 8 / 16 / 24 mm — every step ≥ LAYER_MIN_STEP so the class order holds under log depth too */
  lift: { trunk: 0.024, trunk_link: 0.024, primary: 0.024, secondary: 0.016, tertiary: 0.016, raceway: 0.016, unclassified: 0.008, residential: 0.008, service: 0, track: 0 } as Record<string, number>,
} as const

/** The drawn cross-section of one road way (see `roadSectionOf`). */
export interface RoadSection {
  /** paved width incl. shoulders (m) */
  paved: number
  lanes: number
  /** shoulder (m) each side — the regular one; a one-way trunk's outer stopping lane is `ROAD_SECTION.onewayTrunkShoulders[0]` */
  shoulder: number
  oneway: boolean
  /** gravel / dirt (highway=track unless `surface` says paved, or any class with an unpaved `surface`) */
  unsealed: boolean
  centre: 'none' | 'dashed' | 'solid'
  /** white edge lines (車道外側線) */
  edgeLines: boolean
  /** L-gutter band on residential roads in settlements (decided at runtime with the settle mask; this is the class permission) */
  gutter: boolean
  /** junction precedence: trunk 8 … track 0 */
  rank: number
  /** class rung over the base lift (m): 0 / 0.008 / 0.016 / 0.024 */
  lift: number
}

/** truthy `oneway` values (`-1` is one-way against the way's direction; `reversible` / `alternating` are two-way here) */
const ONEWAY = new Set(['yes', 'true', '1', '-1'])
/** the leading number of a tag value (`6`, `6.5`, `6 m`), NaN otherwise */
const num = (v: string | undefined): number => (v === undefined ? NaN : parseFloat(v))

/**
 * The cross-section of a highway way from its class and OSM tags, or null when the class is not
 * drawn at all (motorway, living_street, footways …). Pure and deterministic: the generator calls
 * it with the raw tags and ships `paved` as the row's `width`, the runtime calls it again with
 * the shipped tag subset (`oneway`, `lanes`, `surface`, `width`) and gets the same section.
 */
export function roadSectionOf(kind: string, tags: Record<string, string>): RoadSection | null {
  const R = ROAD_SECTION
  const rank = R.rank[kind]
  if (rank === undefined) return null
  const oneway = ONEWAY.has(tags.oneway ?? '')
  const surface = tags.surface
  const unsealed = kind === 'track'
    ? !(surface !== undefined && R.sealed.includes(surface))
    : surface !== undefined && R.unsealed.includes(surface)
  const lanesTag = parseInt(tags.lanes ?? '', 10)
  const lanesGiven = Number.isFinite(lanesTag) && lanesTag > 0
  let paved: number
  let lanes: number
  let shoulder: number
  const laneW = R.lane[kind]
  if (laneW !== undefined) {
    lanes = lanesGiven ? lanesTag : oneway ? 1 : 2
    shoulder = R.shoulder[kind]!
    const shoulders = kind === 'trunk' && oneway ? R.onewayTrunkShoulders[0] + R.onewayTrunkShoulders[1] : 2 * shoulder
    const median = kind === 'trunk' && !oneway && lanes >= 4 ? R.median : 0
    paved = lanes * laneW + shoulders + median
  } else {
    // fixed classes: the width tag (when it parses to something plausible) wins over the class width
    const w = num(tags.width)
    paved = w >= 1.5 && w <= 40 ? w : R.fixed[kind]!
    lanes = lanesGiven ? lanesTag : oneway || kind === 'service' || kind === 'track' ? 1 : 2
    shoulder = kind === 'trunk_link' ? R.shoulder.trunk! : 0
  }
  paved = Math.round(paved * 10) / 10
  const centre = unsealed || oneway || R.unmarked.includes(kind) || paved < R.centreMin ? 'none' : paved >= R.solidMin ? 'solid' : 'dashed'
  return {
    paved,
    lanes,
    shoulder,
    oneway,
    unsealed,
    centre,
    edgeLines: !unsealed && R.edgeKinds.includes(kind),
    gutter: R.gutterKinds.includes(kind),
    rank,
    lift: R.lift[kind]!,
  }
}

/**
 * The ribbon builder's numbers (app/three/roads.ts, plan R フェーズ Phase 1) — here so the road
 * network, the furniture, the tree rows and the buildings' road-facing rules read one table.
 */
export const ROADS = {
  /** ribbons stop this close to the GP centreline (m) — outside surface-check's 75 m band; the mask still paints 45–76 m */
  minD: 76,
  /** the soil shoulder row beyond the paved edge (m) */
  verge: 0.6,
  /** crown of the paved rows (m per m of half-width) */
  crown: 0.015,
  /** the base lift of the paved rows over standY (m), plus the class rung (ROAD_SECTION.lift) */
  lift: 0.05,
  /** the verge rows' lift (m): 3 cm under the paved rows reads as a kerb */
  vergeLift: 0.02,
  /** sample pitch on straights (m) and the angular step on fillet arcs (°) */
  stepStraight: 10,
  arcDeg: 6,
  /** fillets at interior kinks: the largest radius per class (m) and the smallest kink that gets one (°) */
  fillet: {
    rMax: { trunk: 200, trunk_link: 150, primary: 150, secondary: 120, tertiary: 90, unclassified: 60, residential: 30, service: 15, track: 15, raceway: 60 } as Record<string, number>,
    minKinkDeg: 2,
  },
  /** tertiary+ fillets under this radius (m) get a solid yellow centre line (± 30 m) */
  yellowR: 150,
  /** a way ending on a higher-ranked road is trimmed to that road's paved edge + this (m) */
  trim: 0.3,
  /** the minor road's stop line sits this far before the major's paved edge (m) */
  stopLine: 2.0,
  /** dashed centre line: [dash, gap] (m) */
  dash: [5, 5] as readonly [number, number],
  /** line widths (m): dashed / edge lines, the solid centre line */
  lineW: 0.15,
  solidW: 0.2,
  /** the L-gutter band along residential roads in settlements (m) */
  gutter: 0.45,
  /** bridge pieces (`bridge` tag): deck over the abutments' standY lerp (m), the parapet height and thickness (m) */
  bridge: { deck: 0.3, parapetH: 0.9, parapetT: 0.25 },
  /** the ring (beyond the inner grid, high tier): rows, sample pitch (m) and the classes drawn there */
  ring: { rows: 2, step: 15, kinds: ['trunk', 'trunk_link', 'primary', 'secondary', 'tertiary'] as readonly string[] },
  /** classes the generator does not ship beyond this distance from the centreline (m) — 3–4 m roads on 12 m outer texels */
  farDrop: { kinds: ['service', 'track'] as readonly string[], dmin: 2500 },
} as const

/**
 * The roadside furniture (app/three/road-furniture.ts, plan R フェーズ Phase 3) and the utility
 * poles (app/three/outskirts.ts) — Japanese road facts, so a guardrail or a sign reads at the
 * right size next to a 7 m 県道. Every length in metres.
 */
export const ROAD_FURNITURE = {
  /**
   * Gr-C W-beam guardrail: the beam spans 0.30–0.65 m over the ground (a 350 mm beam whose top
   * is at 0.60–0.65 m), two corrugations `depth` deep, φ114 posts every 4 m, the beam face
   * `offset` outside the paved edge. Continuous on both sides of the `continuous` classes; on
   * tertiary roads only on the outside of fillets under `curveR` (± `curvePad` around the arc)
   * and along embankments where the ground drops more than `dropM` between hw + 1 and hw + 5.
   */
  guardrail: { beam: [0.30, 0.65] as readonly [number, number], depth: 0.05, postD: 0.114, postH: 0.70, pitch: 4, offset: 0.25, continuous: ['trunk', 'trunk_link', 'primary', 'secondary'] as readonly string[], curveR: 150, curvePad: 15, dropM: 0.8 },
  /** 視線誘導標: φ80 white discs at 1.2 m every 40 m on straights, `clamp(R / 6, 12, 40)` on arcs under `curveR`; orange only on the median side of the one-way trunk carriageways */
  delineator: { h: 1.2, d: 0.08, pitchStraight: 40, curveR: 300, kinds: ['trunk', 'trunk_link', 'primary', 'secondary'] as readonly string[] },
  /** カーブミラー: φ800 convex mirror with an orange rim on a φ76 × 3.6 m pole, at kept corners of at least `kinkDeg` and opposite every minor road's mouth on a major */
  mirror: { d: 0.8, poleH: 3.6, poleD: 0.076, kinkDeg: 40 },
  /** signs: plate centre at `plateH`, φ60 pole; 止まれ `stopBack` m before the stop bar; a speed-limit sign every `speedPitch` on tertiary+; a warning sign `warnBefore` m before fillets under `warnR` */
  sign: { plateH: 2.0, poleD: 0.06, stopBack: 1.0, speedPitch: 500, warnBefore: 50, warnR: 60 },
  /** 横型 signal: a φ200 × 6 m pole at the approach's left corner, an `arm` m arm over the carriageway, a 1.25 × 0.4 × 0.35 head with φ300 lenses hung under its end */
  signal: { poleD: 0.2, poleH: 6, arm: 4.5, head: [1.25, 0.4, 0.35] as readonly [number, number, number], lens: 0.3 },
  /**
   * JIS 12 m concrete pole: 10.5 m exposed, tapered φ320 → φ190, HV crossarm at 9.6 m (three
   * pin insulators), LV arm at 8.2 m, a transformer can on every `transformerEvery`-th pole;
   * `offset` m outside the paved edge every `pitch` m. The hero GLB (jp_denchu) shows inside
   * `heroRange` with a `heroRamp` m hand-off to the procedural prototype.
   */
  pole: { exposed: 10.5, dTop: 0.19, dBase: 0.32, hvArmY: 9.6, hvArm: 1.8, lvArmY: 8.2, lvArm: 1.2, transformerEvery: 4, transformer: { d: 0.45, h: 0.8 }, offset: 0.8, pitch: 35, heroRange: 200, heroRamp: 60,
    /**
     * draw the jp_denchu scan over the procedural pole inside heroRange: off — the decimated
     * 512 px drop read as a brown blotchy column next to the clean JIS prototype on the
     * SwiftShader check; flip it on a GPU to judge (README「GPU で確認すること」)
     */
    hero: false },
  /** the furniture blocks draw within this distance (m, × lodScale) */
  range: 700,
} as const

/** raceway ways closer than this to the GP centreline are the circuit itself — not shipped */
export const RACEWAY_KEEP_OUT = 150

export const STREAM_WIDTH: Record<string, number> = { river: 10, stream: 3 }
/** 伊勢鉄道 single track incl. ballast shoulder */
export const RAIL_WIDTH = 4

// ---------------------------------------------------------------- terrain-side relief (R フェーズ Phase 6)
/**
 * The paddies' relief (app/three/terrain-side.ts, `Quality.farField.paddyRelief`): the 圃場整備
 * field standard of the Suzuka plain is a 30 × 90 m cell (`cell`, m along the field's principal
 * axis × across it — the SAME lattice the land-cover mask draws its bund texels on, so the levee
 * geometry lies on the mask's lines), separated by earth bunds (畦) 0.3–0.5 m high; the ridge
 * built here is `levee` (crest width, crest height and the feet's lift over the ground, m, all
 * sampled every `step` m of line) and the boundary ditch (用水路 / 排水路) inside every field edge
 * is `ditch` (width and lift, m — a dark band, the channel itself is below the mask's texel).
 * Nothing stands closer than `minD` to the GP centreline (the outskirts' rule).
 */
export const PADDY = {
  cell: [90, 30] as readonly [number, number],
  levee: { w: 0.7, h: 0.28, foot: 0.03, step: 4 },
  ditch: { w: 0.5, lift: 0.02 },
  minD: 140,
} as const

/**
 * 伊勢鉄道伊勢線 (app/three/terrain-side.ts): a single-track, non-electrified (diesel — no
 * catenary masts) 1,067 mm gauge line on a ballast bed. `step` / `ringStep` are the sample
 * pitches along the way inside the terrain grid / on the coarse ring (m); `crest` is the ballast
 * crest width (≈ 3.4 m for a JR-gauge single track), `bed` the width at the ground with the 0.6 m
 * shoulders, `bedH` the ballast height over the formation (m); `layer=1` rows stand on an earth
 * embankment `embankH` high with `slope` (1:1.5) flanks; `bridge=yes` rows are a concrete viaduct
 * (`viaduct`: deck width × depth, the deck's clearance `rise` over the highest ground it crosses
 * where a road passes under it, box piers every `pierPitch` of `pier` [along, across] section,
 * `parapet` high side walls). `rail` is one rail's head width × height, `tile` the ballast
 * texture's period along the bed (m). `minD` as PADDY.
 */
export const RAIL = {
  step: 5,
  ringStep: 12,
  gauge: 1.067,
  crest: 3.4,
  bed: 4.6,
  bedH: 0.35,
  embankH: 1.6,
  slope: 1.5,
  viaduct: { deckW: 4.8, deckH: 1.6, rise: 6, pierPitch: 25, pier: [1.4, 2.6] as readonly [number, number], parapet: 0.8 },
  rail: { w: 0.07, h: 0.14 },
  tile: 4,
  minD: 140,
} as const

/**
 * The streams and rivers (app/three/terrain-side.ts): sampled every `step` m (in the grid;
 * `ringStep` on the coarse ring, water only there except the rivers' levees). The banks follow
 * the land: inside a settlement (the mask's settle weight ≥ `settleMin`) a rural stream is a
 * concrete U-channel whose `rim` (width × height, m) shows above the ground; in the fields it
 * runs between earth `berm`s (width × height); a `river` (SUR width 10) between `levee`s. The
 * water is a strip `waterLift` m over the ground (the DEM carries no channel; a sunk bed would
 * need the grid — R11). Where a road crosses, the banks and the water stop `crossingGap` m
 * outside the paved edge (a culvert under the ribbon). `minD` as PADDY.
 */
export const STREAM = {
  step: 5,
  ringStep: 12,
  berm: { w: 0.6, h: 0.3 },
  rim: { w: 0.25, h: 0.15 },
  levee: { w: 2.5, h: 1.2 },
  waterLift: 0.03,
  crossingGap: 3,
  settleMin: 0.5,
  minD: 140,
} as const

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
  roads: 1.0,
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

/**
 * OSM ways tagged building=* that are not buildings (I5-b): the generator never ships them as
 * SUR_BUILDINGS (build-surroundings.mjs OWNED) and facilities-check §11 fails if one comes back.
 *  - 183953732: the paved L yard behind the 200R-exit guardrail (GROUND_AREAS 'L ヤード'), which
 *    the massing extruded as a 58 × 87 m box (audit G11-09)
 */
export const SUR_SKIP_IDS: readonly number[] = [183953732]

// ---------------------------------------------------------------- buildings (plan §2c)
/**
 * Roof material weights (%) per massing family, from the aerials: the houses' kawara tiles are
 * mostly dark grey with brown and blue-grey glazes; the works and warehouses are white or blue
 * folded-metal sheets with a share of grey membrane roofs. Keys are `FACADE_LAYER` names for the
 * industrial family and `BUILDING.kawara` tints for the houses (app/three/buildings.ts).
 */
export const ROOF_WEIGHTS: Partial<Record<SurBuildingKind, Record<string, number>>> = {
  house: { darkGrey: 70, brown: 20, blueGrey: 10 },
  industrial: { whiteMetal: 45, blueMetal: 25, membrane: 30 },
}

/**
 * The building massing (app/three/buildings.ts): what every family is built from. Heights come
 * from the tags (`height`, `building:levels` × storey + storeyExtra) else from `eavesByArea` and
 * the name / kind rules in the builder. Every mass stands with its base `baseDrop` under the
 * lowest ground of its footprint and has no bottom cap (the G8 rule the massing relies on).
 */
export const BUILDING = {
  /** footprints whose centroid is closer than this to the road edge are not massed (m) */
  vergeClearance: 6,
  /** footprints under this are not massed (m²) */
  minArea: 12,
  /** the base of every mass below the footprint's lowest ground (m) */
  baseDrop: 0.4,
  /** the ground rise across a footprint that lifts the eaves is capped here (m) */
  maxGroundRise: 6,
  storey: 3.2,
  storeyExtra: 0.6,
  /** eaves height (m) by footprint area for the families without a rule of their own: [maxArea, eaves] */
  eavesByArea: [[60, 3.2], [300, 4.5], [1500, 7], [5000, 10], [Infinity, 12]] as [number, number][],
  /** the tree keep-out disc around a footprint: its radius plus this (m) */
  keepOutMargin: 6,
  /** houses: eaves overhang, roof pitch (rise / run), the along ÷ across ratio under which the hip becomes a pyramid, window bands over the wall, the shortest ridge that is not a pyramid */
  house: { eaves: 0.5, pitch: 0.4, pyramidRatio: 1.15, bands: 2, minRidge: 0.8 },
  /** kawara tints (multiplied over the tile layer) */
  kawara: { darkGrey: '#3f4246', brown: '#5a4030', blueGrey: '#4a5868' },
  /** the works / warehouses / shops: parapet height, its inset, the roof area from which rooftop units appear (detail level) and how many per m² */
  industrial: { parapet: 0.8, inset: 0.3, unitsFromArea: 800, unitPerArea: 1 / 700, unitsMax: 6, baseBand: 0.1 },
  /** hotel wings: window band pitch (m), the plant room's share of the OBB and its height (m) */
  hotel: { band: 3.2, plantShare: 0.28, plantH: 3 },
  /** building=roof: column pitch along the edge (m), column side (m), slab thickness (m), the fascia board (main gate only) */
  canopy: { columnPitch: 6, column: 0.3, slab: 0.3, eaves: 4, fascia: { h: 0.9, text: 'SUZUKA CIRCUIT' } },
  /** detail level (buildingsDetailM): sill bars under the window bands on walls at least this long (m), rooftop unit size (m) */
  detail: { sillMinEdge: 5, sill: { d: 0.16, h: 0.12 }, unit: [2.4, 1.4, 1.6] as [number, number, number] },
  /** wall tints by family (hex, picked by id hash) */
  walls: {
    house: ['#ece7dc', '#d9d3c6', '#cfcfcf', '#c2b8a6', '#e6e2d8'],
    industrial: ['#dcdedf', '#d8d2c2', '#b6c2cc', '#ebebeb', '#c9ccd0'],
    hotel: ['#ece8e0'],
    school: ['#e2e0da', '#d6d3cc'],
    temple: ['#c4b39d', '#b5a48d'],
    generic: ['#d9d7d2', '#cfcac0', '#e0dcd3'],
    canopy: ['#f2f0ea'],
    column: '#8d9094',
    base: '#4a4c50',
    plant: '#a9aaac',
    unit: '#b8bbbe',
  },
  /** ride buildings: pastel walls by id hash (HSL saturation / lightness); the coaster station's eaves (m) */
  ride: { s: 0.45, l: 0.74 },
  rideEaves: 5.5,
} as const

/**
 * Motopia extras (plan §2c): the family coaster from the four layer-tagged raceway ways and the
 * drained pools (late March). Deck height over the ground = `layerH` × the way's `layer` + `baseH`,
 * plus `hump` m humps every `humpPeriod` m, eased to `stationH` at the station.
 */
export const MOTOPIA = {
  coaster: {
    layerH: 4, baseH: 3, hump: 3, humpPeriod: 60, stationH: 2, stationEase: 30, sampleM: 3, smoothM: 15,
    deckW: 2.2, rail: 0.14, railGauge: 1.1, supportPitch: 8, supportBar: 0.22,
    cars: 4, carL: 2.6, carW: 1.5, carH: 1.1,
    colours: { deck: '#7d8084', rail: '#c0221a', support: '#d6d8da', car: ['#d8341f', '#e8b823', '#d8341f', '#2f6fbf'], seat: '#2a2c30' },
    /** the coaster's tree keep-out: disc radius around the deck samples (m) */
    keepOutR: 6,
  },
  pool: { lift: 0.05, coping: 0.4, copingW: 0.35, floor: '#b9c9cc', copingColour: '#d4d1c8' },
} as const

/** The family campsite (SUR_SITES camp_site): a 12 m pitch grid, 40 % occupied, tents in four colours and a few campervans. */
export const CAMPSITE = {
  grid: 12, fill: 0.4, jitter: 2.5,
  /** tent kind mix (dome / A-frame / tarp) */
  kinds: { dome: 0.45, aframe: 0.3, tarp: 0.25 },
  colours: ['#e0702a', '#3f7a3a', '#cdb98f', '#243a66'],
  dome: { r: 1.6, h: 1.5 }, aframe: { w: 2.4, l: 3.2, h: 1.7 }, tarp: { w: 3.6, l: 3.6, h: 2.3, pole: 0.05 },
  vans: 6, van: { l: 5.4, w: 2.2, h: 2.6 }, vanColours: ['#f2f2f0', '#e8e6e0', '#d9dcdf'],
} as const

/**
 * Hero replacements of the OSM house footprints (app/three/hero-buildings.ts, R フェーズ Phase 4):
 * a footprint inside the terrain grid whose oriented bounding box matches a model's footprint
 * (long ÷ short within `fit` of the model's, the ring filling at least `fill` of the box) is
 * built from the pack model instead of the massing — scaled uniformly within `scale` so the
 * model's long side equals the box's long side, its front (see hero-buildings.ts) turned to the
 * nearest road, standing on a plaster plinth `plinth` m over the footprint's lowest ground. The
 * tier's `Quality.farField.heroBuildings` caps the count, nearest the circuit first. `kinds` is
 * the generator kind; `tag` restricts to one `building=*` value (apartments are `kind: 'house'`
 * in the extract), `minLong` to boxes at least that long (m).
 */
export const HERO_BUILDINGS = {
  models: [
    { key: 'model/buildings/jp_house_01', kinds: ['house'] },
    { key: 'model/buildings/jp_house_02', kinds: ['house'] },
    { key: 'model/buildings/jp_house_03', kinds: ['house'] },
    { key: 'model/buildings/jp_apartment_grey', kinds: ['house'], tag: 'apartments', minLong: 14 },
  ] as readonly { key: string; kinds: readonly SurBuildingKind[]; tag?: string; minLong?: number }[],
  /** aspect-ratio tolerance and the uniform scale range: the in-grid houses are elongated (1.5–3 : 1) while the models are compact, so 0.2 / ±15 % fitted only 5 sites — 0.35 / −20…+25 % fits about twelve without visible distortion */
  fit: 0.35,
  fill: 0.7,
  scale: [0.8, 1.25] as readonly [number, number],
  plinth: 0.05,
} as const

/**
 * What dresses a house beyond its massing (app/three/buildings.ts, Phase 4): the ブロック塀
 * around the footprint (`wall`: offset outside the footprint edges, height, thickness, the gate
 * gap on the road-facing edge — all m), the rooftop PV array on the south-facing hip face (`pv`:
 * share of the houses, inset from the face edges, how proud of the tiles), the props on the
 * longest wall (`props`: aircon box l × d × h, LPG cylinder radius / height, water-heater box),
 * the footprint area under which a dwelling is a corrugated shed (m²; the generator ships nothing
 * under SUR_MIN_AREA 60 m², so today only the tagged huts / garages qualify) and the roller
 * shutters on the road-facing side of the works / warehouses / shops (`shutter`: w × h, pitch
 * along the edge, at most `max` per building).
 */
export const HOUSE_DRESS = {
  wall: { offset: 1.8, h: 1.2, t: 0.12, gate: 3 },
  pv: { share: 0.12, inset: 0.75, proud: 0.06 },
  props: { aircon: [0.8, 0.3, 0.6] as readonly [number, number, number], lpg: { r: 0.18, h: 1.25 }, heater: [0.5, 0.3, 0.8] as readonly [number, number, number] },
  shedMaxArea: 45,
  shutter: { w: 3.2, h: 2.6, pitch: 8, max: 4 },
} as const

/**
 * The solar farms' detail level (app/three/outskirts.ts `solarDetail-<cell>`, R フェーズ Phase 5,
 * `Quality.farField.solarDetail`): what stands under and around the static panel rows inside
 * `range` (m, × lodScale). Racks: a front and a back post (square, `post` m) every `postPitch` m
 * along a row and two rails (`rail` m) under the panel's edges, galvanised. An inverter hut
 * (`hut` = w × d × h, m, concrete walls, a galvanised roof) on every farm polygon of at least
 * `hutMinArea` m², in the gap between two rows nearest the inset centroid. A chain-link fence
 * (`fence`: height, post pitch, inset from the OSM edge, m) around every farm, posts + top rail,
 * the mesh panel with `Quality.fence`.
 */
export const SOLAR_DETAIL = {
  range: 600,
  postPitch: 6,
  post: 0.1,
  rail: 0.06,
  hutMinArea: 2000,
  hut: [3, 2, 2.4] as readonly [number, number, number],
  fence: { h: 1.8, pitch: 4, inset: 0.8 },
} as const

// TODO(plan §2d): car-body colour mix from the 2026 car-park photo (white pearl 38 / black 24 /
// silver 20 / dark red 6 / blue 5 / other 7 %) and the body-type mix.
export const CAR_COLOURS: { hex: string; weight: number }[] = []

// ---------------------------------------------------------------- forest (plan §2a)
/**
 * The woods: canopy masses per 250 m cell (far), the species prototypes of app/three/trees.ts
 * inside the stem range (LOD meshes, then impostor cards; cones where the library has no
 * pack), plantation rows, hedges, bamboo clumps and the cherry rows along the roads. Every number
 * the forest builder (app/three/forest.ts) tunes lives here; the species themselves (heights,
 * tints, crown colours, the mixes per polygon kind) are app/data/tree-species.ts and the tier
 * budgets (`midTrees`, `heroPerCell`, `nearTrees`, `canopy`, `shadows`, `lodScale`, `trees`)
 * are in quality.ts.
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
   * the stems inside the polygons: the outer range of the cards / cones (m, × lodScale — the
   * canopy mass takes over beyond it), the count ramp before it (m), the closest a stem stands
   * to the centreline (the trackside scatter's rule), how far in from the polygon edge a cherry
   * may stand (the aerial's pink fringes), and the minimum stratified spacing (m). The species
   * mix per polygon kind is TREE_MIX of tree-species.ts.
   */
  stems: { range: 900, ramp: 220, minD: 44, edgeM: 14, minSpacing: 4 },
  /**
   * landuse=forest plantations stand in rows: the row axis follows the contour (⊥ the ground
   * gradient at the polygon centroid; the polygon's principal axis on flat ground), `pitchAcross`
   * is the pitch between neighbouring rows and `pitchAlong` the pitch along a row, both × the
   * polygon's stem spacing (0.7 × 1.43 ≈ 1, so the allotment is unchanged), `jitter` the
   * per-stem offset (× spacing) that keeps the lattice from reading as a grid up close
   */
  rows: { pitchAcross: 0.7, pitchAlong: 1.43, jitter: 0.15 },
  /**
   * the cherry rows along the roads (job C of forest.ts): the ways named here and every PUBLIC
   * way (ROAD_SECTION.rank ≥ `minRank`, i.e. residential and up — not the service drives, car-park
   * aisles or the kart raceways, which are 15 km of the gate surroundings) whose centroid lies
   * within `gateR` m of a circuit gate (SUR_SITES role 'gate') get a tree every `pitch` m on both
   * sides, `offset` m outside the paved edge (just past the road's keep-out)
   */
  cherryRows: { names: ['サーキット道路'], gateR: 350, minRank: 2, pitch: 7, offset: 2.5 },
  /**
   * the shrubs along the forest edges: a site every `pitch` m of ring, from `offset` m outside
   * the edge out to `edgeBand` m (biased to the edge), `share` of the sites taken at most — the
   * tier's `Quality.farField.trees.shrubs` is allotted over the polygons by perimeter first
   */
  hedge: { pitch: 4, offset: 1.2, edgeBand: 6, share: 0.35 },
  /**
   * bamboo clumps on the wood / scrub lattice sites where the settlement weight of the land-cover
   * mask is at least `settleMin` (the village edges), or the polygon is tagged bamboo; a clump is
   * `perClump` culms within `clumpR` m (expanded by trees.ts emitTrees)
   */
  bamboo: { settleMin: 0.3, clumpR: 2.5, perClump: 3 },
  /** visibility weight of a polygon for the stem allotment: 1 at the track, falling to `floor` at `far` metres */
  visibility: { far: 1500, floor: 0.35 },
} as const

// LOD ranges per family (forest done; buildings detail and cars 3D / impostor / stipple are filled by plan §2c / §2d).
export const SUR_LOD: Record<string, { near?: number; far?: number }> = {
  forest: { far: FOREST.stems.range },
}

/** Land-cover colours live in app/three/landcover.ts (COVER_COLOURS); nothing to hand-tune here. */
