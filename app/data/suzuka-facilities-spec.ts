/**
 * Suzuka Circuit — hand-authored facility specification (dimensions, structure, colours).
 *
 * This file is NOT derived from OpenStreetMap: row pitches, risers, heights, colours and the
 * garage order come from the official seating plans (grandstand_f1.pdf / f1_v1 / f1_v2 /
 * f1_a1, decrypted, to scale at 0.380 m/pt), the GSI DEM5A terrain study, Takenaka / Honda
 * Mobilityland press material, the 2010 Car Watch east-course guide, min-f1 seat guides and
 * measured colours from Commons / official photos. The OSM footprints these numbers sit on
 * live in ./suzuka-facilities.ts (ODbL) — each stand references its OSM way ids and the
 * per-s lateral breakpoints below were read off those footprints by ray-marching them from
 * the app's centreline (scripts/facilities, `march.mjs`), so they are already in track
 * coordinates (s along the lap, lateral +left, metres from the centreline).
 *
 * Conventions
 * - `sRange` is [start, end] in driving direction; end < start when a stand spans the
 *   start line (V1: 5572 → 61).
 * - `lateralFront` is the ROW-1 SEAT CENTRE, not the structure face (V1: face +21.3, row 1
 *   +23.6). Right-side stands carry negative laterals. A per-s list is linearly interpolated
 *   and clamped at its ends; consumers must call `alongAt(value, s, sRange)`.
 * - `frontHeight` is the row-1 platform height above the local track surface (`track.py`),
 *   because every stand follows the road longitudinally but the main grandstand bank is a
 *   level platform (DEM: back edge flat at 39.5–40.7 m ASL while the track drops 7.7 m).
 * - Items marked UNVERIFIED were not confirmed by a primary source; the `unverified` list on
 *   each record names what is still an estimate so the check script can soften its verdicts.
 */
import { CIRCUIT } from '~/data/suzuka'
import type { TeamId } from '~/data/drivers'
// a value import of the basins only (suzuka-barriers-spec imports types from here, so no cycle at runtime)
import { BASINS } from '~/data/suzuka-barriers-spec'
import type { TreeRole } from '~/data/tree-species'

// ---------------------------------------------------------------- shared types

export type Side = 1 | -1
export type StandStructure = 'terrace' | 'frame' | 'scaffold'
export type SeatKind = 'chair' | 'bench'
/** A constant, or [s, value] breakpoints (driving order, may wrap the start line). */
export type AlongTrack = number | [number, number][]

export interface StandTier {
  /** ticket-map name of the tier (V1, V2, B2-3, E-1 …) */
  id: string
  rows: number
  /** row pitch along the rake (m) */
  tread: number
  /** height step per row (m) */
  riser: number
  seat: SeatKind
  /** seat / plank colour (sRGB hex) */
  colour: string
  /** row-1 seat centre; defaults to the stand's lateralFront */
  lateralFront?: AlongTrack
  /** row-1 platform height above the local track surface (m); defaults to the stand's */
  frontHeight?: AlongTrack
  /** s sub-range when the tier does not span the whole stand */
  sRange?: [number, number]
  /** transverse walkway (m) behind this tier, before the next one */
  aisleAfter?: number
}

export interface StandRoof {
  /**
   * lateral band covered by the slab. A canopy that follows the rows it covers names the tier
   * instead (`tier`): the band is then [row-1 front − overhang, structure back + 0.5] at every s,
   * which is what a straight bar on a curving stretch of track needs (G's back bar drifts 8 m in
   * lateral over its length)
   */
  lateral?: [number, number]
  tier?: string
  /** s range when shorter than the stand */
  sRange?: [number, number]
  /** several separate blocks along s (G: two canopies with a gap); each inside `sRange` */
  blocks?: [number, number][]
  /** soffit / top heights above the local track surface (m); a canopy's soffit is its front edge */
  soffit: number
  top: number
  /** forward cantilever beyond the supporting frame line (m) */
  overhang: number
  /** primary truss / fin pitch along s (m) */
  finPitch: number
  /** 'slab' = the RC slab with white trusses (V2); 'canopy' = a thin steel deck on posts (default 'slab') */
  style?: 'slab' | 'canopy'
  /** what carries the roof: 'none' (a building band beneath: V2), 'deck' (posts on the rows), 'ground' (posts to the ground behind and in front) */
  columns?: 'none' | 'deck' | 'ground'
  columnPitch?: number
  /** a canopy's rise from its front edge to its back (m) */
  rise?: number
  /** deck colour (sRGB hex); the V2 slab uses the measured COLOURS.roof* */
  colour?: string
}

export interface StandDef {
  id: string
  name: string
  /** OSM way ids of the footprint (see OSM_STAND_WAYS); [] when the stand is not mapped */
  osmWays: number[]
  sRange: [number, number]
  side: Side
  lateralFront: AlongTrack
  /** rear edge of the structure (concourse included) */
  lateralBack: AlongTrack
  structure: StandStructure
  tiers: StandTier[]
  /** stair-aisle pitch along s and clear width (m); null when unknown */
  aisles: { pitch: number; width: number } | null
  roof?: StandRoof
  /** row-1 platform height above the local track surface (m) */
  frontHeight: AlongTrack
  /** free-text platform / earthworks note for the terrain relief */
  platform: string
  permanent: boolean
  /** debris fence in front of the stand */
  fence: 'single' | 'double' | 'low-centre' | 'none'
  /** stands allowed to share this footprint (stacked decks) */
  stackedWith?: string[]
  /** enclosed glazed building instead of open rows (VIP) */
  enclosure?: { floors: number[]; glass: string; framePitch: number; roofTop: number }
  /**
   * Build the stand along the CURVE of its OSM front edge instead of sweeping it in track
   * coordinates: vertex ranges [start, end] of the footprint ring (walked forward) that form the
   * front and the back edge. A stand on the inside of a bend whose rows lie beyond the bend's
   * radius (C's Esses end against T3, E inside NIPPO) folds over itself when swept in
   * (s, lateral); the path frame lays the rows concentric with the real front edge instead, which
   * is what the terraces are. Heights still ride on the road (the road nearest each point of the
   * path), and the s-keyed fields stay in track coordinates for the fences, the tree exclusion
   * and the checks.
   */
  path?: { front: [number, number]; back: [number, number] }
  /** what is still an estimate — see the header */
  unverified?: string[]
  notes?: string
}

/** Linear interpolation of an AlongTrack value at s (clamped outside the breakpoints). */
export function alongAt(v: AlongTrack, s: number, sRange: [number, number]): number {
  if (typeof v === 'number') return v
  const L = CIRCUIT.officialLength
  const rel = (x: number) => (((x - sRange[0]) % L) + L) % L
  const t = rel(s)
  let prev = v[0]!
  if (t <= rel(prev[0])) return prev[1]
  for (let i = 1; i < v.length; i++) {
    const cur = v[i]!
    const a = rel(prev[0])
    const b = rel(cur[0])
    if (t <= b) return prev[1] + ((cur[1] - prev[1]) * (t - a)) / (b - a || 1)
    prev = cur
  }
  return prev[1]
}

/** Seating depth of a stand: Σ rows × tread (+ aisles) over the tiers in the same lateral run. */
export function seatingDepth(def: StandDef): number {
  return def.tiers.reduce((d, t) => d + t.rows * t.tread + (t.aisleAfter ?? 0), 0)
}

// ---------------------------------------------------------------- colours (measured)

/**
 * Measured palette (sRGB hex). "lit / mid / shade" were sampled from several photos each;
 * see the 2026-09 reference-photo report. Use `mid` for albedo, the others as bounds when
 * tuning under the scene's lighting.
 */
export const COLOURS = {
  /** perimeter fence + handrails — one system-wide "Suzuka turquoise" (6 photos) */
  railTurquoise: { lit: '#5FBDBB', mid: '#5EA0A2', shade: '#44747C' },
  /** B1 front railing is blue, not turquoise (min-f1 2026 B1). Hex UNVERIFIED (panoramio silhouette). */
  railBlueB1: { lit: '#4B6F9A', mid: '#354850', shade: '#313A45' },
  /** V1 lower tier seats. Plan §3b: light grey (#b9bab8 / #d5d7d6 by photo); ten view-from-seat photos measure #656462. */
  seatV1: { lit: '#d5d7d6', mid: '#b9bab8', shade: '#928E8C' },
  /** V2 upper tier seats — dark charcoal */
  seatV2: { lit: '#4a4d52', mid: '#3b3f44', shade: '#2e3237' },
  /** Q2 individual seats — colour UNVERIFIED, assumed like V1 */
  seatQ2: { lit: '#d5d7d6', mid: '#b9bab8', shade: '#928E8C' },
  /** bench planks / terrace decking, B1 B2 D E (6 photos); material UNVERIFIED (timber or aluminium) */
  benchTan: { lit: '#DACBAD', mid: '#BFAE94', shade: '#A08E6F' },
  /** A1 permanent benches — green (img_main_a1) */
  benchGreenA1: { lit: '#5b9464', mid: '#4d8057', shade: '#3e6b4a' },
  /** C benches / concrete — neutral grey, no coloured seats (img_c_04 / c_08) */
  benchGreyC: { lit: '#CACCCF', mid: '#A8A29E', shade: '#6C6663' },
  /** weathered concrete treads / risers */
  concrete: { lit: '#c3c1bc', mid: '#b0aeaa', shade: '#9a9894' },
  /** painted front parapet of V1 */
  parapetWhite: { lit: '#f2f2ee', mid: '#e6e6e2', shade: '#cfcfca' },
  /** main grandstand roof: ribbed soffit / top / fascia */
  roofSoffit: { lit: '#D1D5D8', mid: '#b9bcbe', shade: '#98999E' },
  roofTop: { lit: '#9a9ea2', mid: '#8e9296', shade: '#7b7f83' },
  roofFascia: { lit: '#dcd6c8', mid: '#cfc9bb', shade: '#b5afa1' },
  /** VIP / hospitality glazing and white mullions */
  glassVip: { lit: '#c4d8d5', mid: '#a9c3c0', shade: '#7f9a97' },
  mullionWhite: { lit: '#f4f4f2', mid: '#e8e8e4', shade: '#cfcfcb' },
  /** green signage strip between the columns under the VIP box */
  signageGreen: { lit: '#2a7f5c', mid: '#1f6b4a', shade: '#175238' },
  /** warm concrete piers under the VIP box */
  pierConcrete: { lit: '#dad6cc', mid: '#cdc8bc', shade: '#b0aa9d' },
  /** pit building facade (white panels, reads blue-grey in overcast photos) */
  pitFacade: { lit: '#E5EBED', mid: '#BEC1CF', shade: '#979CB0' },
  /** garage interior (CC0 photo) */
  garageInterior: { lit: '#DAD9DD', mid: '#BEC0BB', shade: '#AEAEAB' },
  /** podium backdrop / circuit red */
  circuitRed: { lit: '#BC2834', mid: '#A7444F', shade: '#731E33' },
  /** track asphalt is blue-grey, not neutral (lum sd 5.5 over 900×150 px) */
  asphalt: { lit: '#7984A1', mid: '#5D626C', shade: '#4A4E57' },
  /** gravel — UNVERIFIED, indistinguishable from dormant grass in every sample */
  gravel: { lit: '#CFC29E', mid: '#BFB08C', shade: '#9E9070' },
  /** painted aprons: hairpin inside blue + white chevrons, chicane inside turquoise (2026 photos, hex UNVERIFIED) */
  apronBlue: { lit: '#2457a8', mid: '#1c4690', shade: '#143468' },
  /** the app painted the chicane's inside turquoise from the 2017-20 aerial, which has a teal
   *  cast (its asphalt samples #a5a099); the 2026 capture shows plain green turf. No row uses
   *  apronTurquoise or APRON_UV.turquoise any more — see COLOURS.turfGreen. */
  apronTurquoise: { lit: '#3fb3b0', mid: '#2f9a98', shade: '#237574' },
  /** artificial turf (人工芝): the chicane's inside run-off and the KERBS kind:'green' strips */
  turfGreen: { lit: '#4CB85E', mid: '#36A848', shade: '#24713A' },
  chevronWhite: { lit: '#f6f6f2', mid: '#e9e9e4', shade: '#cfcfca' },
} as const

// ---------------------------------------------------------------- seasons

export type Season = 'spring' | 'autumn'
/** Reproduced date: 2026 Japanese GP race day, 29 March 14:00 JST → dormant zoysia. */
export const SEASON: Season = 'spring'

export interface GrassPalette {
  /** sunlit / mid / shaded grass albedo */
  sun: string
  mid: string
  shade: string
  /** patches of early green-up (30–60 m period), blended in partially */
  patch: string
  /** worn / bare soil */
  dirt: string
  /** true when mown stripes should be drawn (measured: none on the trackside grass) */
  stripes: boolean
}

export const SEASON_GRASS: Record<Season, GrassPalette> = {
  // late-March dormant 高麗芝, measured on the 2025-04-05 and 2026-03-27 photos
  spring: { sun: '#C6B189', mid: '#B5A47E', shade: '#8C7F63', patch: '#8f9a55', dirt: '#9c8a68', stripes: false },
  // the October palette of textures.ts grassMaps(): lerp(58,122)/(96,150)/(34,52) + dirt (128,108,70)
  autumn: { sun: '#7A9634', mid: '#5B7B2B', shade: '#3A6022', patch: '#65612D', dirt: '#806C46', stripes: false },
}

export interface SeasonDef {
  /** solar declination (deg) and solar-noon hour (JST) used by scene.ts sunDirectionAt */
  declinationDeg: number
  solarNoonH: number
  /** tree mix by fraction */
  trees: { evergreen: number; bare: number; blossom: number }
  blossom: string
  weather: { airC: number; trackC: number; humidity: number }
}

export const SEASONS: Record<Season, SeasonDef> = {
  // 29 March: δ ≈ +3.2°, equation of time ≈ −5 min, longitude 136.53° E vs 135° meridian → noon ≈ 11:59
  spring: { declinationDeg: 3.2, solarNoonH: 11.98, trees: { evergreen: 0.6, bare: 0.3, blossom: 0.1 }, blossom: '#f4c6d4', weather: { airC: 15, trackC: 26, humidity: 45 } },
  // early October (previous default): δ ≈ −4.6°, noon 11:45
  autumn: { declinationDeg: -4.6, solarNoonH: 11.75, trees: { evergreen: 0.7, bare: 0, blossom: 0 }, blossom: '#f4c6d4', weather: { airC: 24, trackC: 34, humidity: 60 } },
}

// ---------------------------------------------------------------- stands

/** Bench / chair prototypes shared by many stands. */
const OLD_BENCH = { tread: 0.75, riser: 0.35, seat: 'bench' as const, colour: COLOURS.benchTan.mid }
const RC2009_BENCH = { tread: 0.95, riser: 0.32, seat: 'bench' as const, colour: COLOURS.benchTan.mid }
const TERRACE_BENCH = { tread: 0.8, riser: 0.3, seat: 'bench' as const, colour: COLOURS.benchTan.mid }
const SCAFFOLD_BENCH = { tread: 0.8, riser: 0.4, seat: 'bench' as const, colour: COLOURS.benchTan.mid }

export const STANDS: StandDef[] = [
  // ---- main grandstand ------------------------------------------------------------------
  {
    id: 'V1',
    name: 'グランドスタンド下段 V1',
    osmWays: [184107052],
    sRange: [5572, 61],
    side: 1,
    lateralFront: 23.6, // [PDF] row-1 seat centre; OSM structure face +21.3 (parapet + front walkway)
    lateralBack: 38.0, // rear wall of the general 17 rows; V2 starts at +40.5 behind a 1.7 m cross-aisle
    structure: 'terrace',
    tiers: [
      { id: 'V1', rows: 17, tread: 0.894, riser: 0.35, seat: 'chair', colour: COLOURS.seatV1.mid, aisleAfter: 1.7 },
      // rows 18–22 exist only in the Turn-1-end blocks B/C/D, alongside V2 rows 1–5 (174 seats)
      { id: 'V1-18-22', rows: 5, tread: 0.894, riser: 0.45, seat: 'chair', colour: COLOURS.seatV1.mid, lateralFront: 40.53, frontHeight: 8.2, sRange: [25, 61] },
    ],
    aisles: { pitch: 11.0, width: 1.2 }, // 22 lettered blocks A–V [PDF]
    frontHeight: 1.5,
    platform: 'RC terrace on a level fill platform (DEM: back edge 39.5–40.7 m ASL over 267 m while the track drops 38.3→30.6); 1.4 m painted parapet at +21.3',
    permanent: true,
    fence: 'single',
    unverified: ['riser heights (0.29→0.38, C-value reconstruction)', 'OSM front face is stepped +28.5→+21.5 along s; the PDF plan is taken as authoritative'],
    notes: 'Not under the roof (leading edge at +36 over rows 14–15, 30 m up). Roofless per min-f1.',
  },
  {
    id: 'V2',
    name: 'グランドスタンド上段 V2',
    osmWays: [183394522],
    sRange: [5574, 5762],
    side: 1,
    lateralFront: 40.53, // [PDF]
    lateralBack: 59.3, // OSM rear; row 20 at +59.0 [PDF]
    structure: 'terrace',
    tiers: [
      { id: 'V2-1-4', rows: 4, tread: 0.894, riser: 0.45, seat: 'chair', colour: COLOURS.seatV2.mid, aisleAfter: 1.26 },
      { id: 'V2-5-20', rows: 16, tread: 0.894, riser: 0.45, seat: 'chair', colour: COLOURS.seatV2.mid, lateralFront: 45.36, frontHeight: 9.5 },
    ],
    aisles: { pitch: 11.8, width: 1.2 }, // 21 lettered blocks A–U [PDF]; vomitories in rows 10–13
    // 18 × 186 m (mejibo/Takenaka); heights UNVERIFIED. The RC slab is carried by the hospitality
    // band behind the rows (`columns: 'none'`), not by posts — nothing stands on the V2 deck.
    roof: { lateral: [36, 59.3], sRange: [5574, 5760], soffit: 30, top: 32, overhang: 7.5, finPitch: 12, style: 'slab', columns: 'none' },
    frontHeight: 8.2,
    platform: 'Same fill platform as V1; a two-storey glazed hospitality band (35 panorama rooms, lateral ≈+45..+59, columns top +18..+20, glass +20..+28, 3 m mullions) sits on the top row and carries the roof',
    permanent: true,
    fence: 'none',
    unverified: ['roof soffit/top heights', 'column pitch 3–4 m', 'white triangular roof trusses every ≈12 m'],
  },
  {
    id: 'VIP',
    name: 'VIPスイート Dynamic Eye',
    osmWays: [183394524],
    sRange: [5774, 25],
    side: 1,
    lateralFront: 39.5,
    lateralBack: 63.8,
    structure: 'frame',
    tiers: [],
    aisles: null,
    frontHeight: 18,
    platform: '3-storey glazed suite block (S + SRC, 3 m frame pitch, suspended glass screen); 2F lounge ≈+20..+25, 3F floor "over 25 m above ground"; curved roof kicks up at the Turn-1 end',
    enclosure: { floors: [18, 22.5, 27], glass: COLOURS.glassVip.mid, framePitch: 3, roofTop: 32 },
    permanent: true,
    fence: 'none',
    unverified: ['floor-to-floor heights', 'roof profile'],
  },
  {
    id: 'A1',
    name: 'A1 メインストレート（常設）',
    osmWays: [184120096],
    sRange: [133, 250],
    side: 1,
    lateralFront: 20.5,
    lateralBack: [[133, 35.5], [188, 35], [238, 26], [250, 24]], // tapers toward Turn 1 (OSM / f1_a1.pdf)
    structure: 'terrace',
    tiers: [{ id: 'A1', rows: 12, tread: 0.85, riser: 0.33, seat: 'bench', colour: COLOURS.benchGreenA1.mid }],
    aisles: { pitch: 19, width: 1.2 }, // 6 blocks
    frontHeight: 1.5,
    platform: 'RC terrace at run-off level behind the double mesh (blocks A–C at the T1 end see through two fences)',
    permanent: true,
    fence: 'double',
    unverified: ['row pitch / riser', 'front height'],
  },
  {
    id: 'A1_TEMP',
    name: 'A1 メインストレート（仮設）',
    osmWays: [],
    // ends at s 110: the works-road tunnel's north-east approach (CUTS worksNE, portal (119, +28.5))
    // occupies s 114.5–123.5 across this band, and the stand's tubes stood on its floor (the
    // I6 review, R3 / V2); 110 keeps 4.5 m from its wall foot (O5 0.6). V1 ends at s 61.
    sRange: [65, 110],
    side: 1,
    lateralFront: 22,
    lateralBack: 40,
    structure: 'scaffold',
    tiers: [{ id: 'A1-temp', rows: 20, ...SCAFFOLD_BENCH, colour: '#9a9a96' }],
    aisles: { pitch: 4.3, width: 1.0 }, // ≈ 10 blocks, 12 seats wide
    frontHeight: 2.5,
    platform: 'Elevated scaffold stand behind/above the permanent A1 toward the last corner',
    permanent: false,
    fence: 'single',
    unverified: ['position (not in OSM; from map.png)', 'lateral band', 'front height', 'shortened at the T1 end to clear the works-tunnel NE portal (119, +28.5): the map shows it reaching s ≈ 130'],
  },
  // A2 is TWO scaffold blocks, not one (GSI z18, .cache/audit/sections/02-t1-pit-exit-aerial.png):
  // the pit-end one carries a blue steel canopy over its rows (a solid panelled deck, 4 m panel
  // grid, no bench pitch through it), the Turn-1 one is open (its green benches read row by row
  // at 0.8 m). Both were measured by sampling the mosaic in track coordinates: the blue runs
  // s 260–306 at lateral 29.5–39, the green s 339–435 at lateral 28–41 (its front swings out
  // with the road into Turn 1). The old single block (s 255–390, lateral 21–36) sat on neither.
  {
    id: 'A2R',
    name: 'A2 メインストレートエンド（仮設・屋根付き）',
    osmWays: [],
    sRange: [260, 306],
    side: 1,
    lateralFront: 29.5,
    lateralBack: 39.5,
    structure: 'scaffold',
    tiers: [{ id: 'A2R', rows: 12, ...SCAFFOLD_BENCH, colour: '#9a9a96' }],
    aisles: { pitch: 9, width: 1.0 },
    roof: { tier: 'A2R', soffit: 9.0, top: 9.2, overhang: 1.0, finPitch: 4.5, style: 'canopy', columns: 'ground', columnPitch: 4.5, rise: 1.4, colour: '#4f6a8a' },
    frontHeight: 2.0,
    platform: 'Scaffold behind the wall with a walkway in front; this pit-end block carries a blue steel canopy over every row',
    permanent: false,
    fence: 'single',
    unverified: ['roof extent read off GSI z18 (section 02, ±3 m): the blue deck runs s 260–306 at lateral 29.5–39', 'rows', 'height', 'canopy soffit height'],
  },
  {
    id: 'A2',
    name: 'A2 メインストレートエンド（仮設）',
    osmWays: [],
    sRange: [339, 434],
    side: 1,
    // a straight-built block on the road curving into T1: its lateral grows towards the corner,
    // and the T1 gravel band (RUNOFF_ZONES, to lateral 33 from s 400) sets how far out row 1 sits
    lateralFront: [[339, 30], [400, 33.5], [434, 35]],
    lateralBack: [[339, 43], [400, 46.5], [434, 48]],
    structure: 'scaffold',
    tiers: [{ id: 'A2', rows: 15, ...SCAFFOLD_BENCH, colour: '#9a9a96' }],
    aisles: { pitch: 9, width: 1.0 },
    frontHeight: 2.0,
    platform: 'Open scaffold block behind the wall; taller toward Turn 1 (≤10 m); ends where the T1 gravel starts at s 434',
    permanent: false,
    fence: 'single',
    unverified: [
      'block extent read off GSI z18 (section 02, ±3 m): the green benches read row by row from s 337 to s 430; row 1 is held out to 30 → 35 by the Turn-1 gravel band (RUNOFF_ZONES, to lateral 33 from s 400) rather than by the photo, which puts the seating at 28.8–39.5 and the structure with its front walkway at 26.5–40',
      'rows',
      'height',
    ],
  },
  // ---- Turn 2 ---------------------------------------------------------------------------
  {
    id: 'B1',
    name: 'B1 2コーナー（1階）',
    osmWays: [184143131],
    sRange: [574, 627],
    side: 1,
    lateralFront: [[574, 53.5], [597, 54.5], [609, 59], [627, 59]],
    lateralBack: [[574, 63], [611, 67.5], [627, 66]],
    structure: 'frame',
    tiers: [{ id: 'B1', rows: 9, ...OLD_BENCH }],
    aisles: { pitch: 12, width: 1.2 },
    frontHeight: 3.5, // DEM: front ≈ +0.8 over the apron, ≈ +3.5 over the track
    platform: 'Ground floor of the two-storey B building; the perimeter road, kiosks and toilets run under the B2 deck behind',
    permanent: true,
    fence: 'single',
    stackedWith: ['B2'],
    unverified: ['row pitch 0.75 / riser 0.35', 'blue front railing hex'],
    notes: 'Front railing is blue up to the C boundary; the B2 deck acts as its roof.',
  },
  {
    id: 'B2',
    name: 'B2 2コーナー（2階デッキ＋中2階）',
    osmWays: [184143132],
    sRange: [542, 624],
    side: 1,
    lateralFront: [[542, 52], [569, 56.5], [573, 64.5], [609, 69.5], [624, 69]], // L-shape: B2-3 mezzanine (s 542–572) sits 6 m lower toward T1
    lateralBack: [[542, 62.5], [571, 70], [573, 76], [595, 76.5], [611, 81.5], [624, 78]],
    structure: 'frame',
    tiers: [
      { id: 'B2-3', rows: 16, ...OLD_BENCH, sRange: [542, 572], frontHeight: 3.7 }, // 中2階 "離れ小島" on ~6 m lower ground
      { id: 'B2-1/2', rows: 20, ...OLD_BENCH, sRange: [572, 624], frontHeight: 9.7 }, // deck row 1 ≈ B1 row 1 + 6.2 m
    ],
    aisles: { pitch: 12, width: 1.2 }, // blocks A–O + S, T
    frontHeight: 9.7,
    platform: 'Upper deck of the B building over B1; two rows of billboards on the back; ground behind falls 10 m over 40 m into the retention basin',
    permanent: true,
    fence: 'single',
    stackedWith: ['B1'],
    unverified: ['row pitch / riser', 'deck heights (derived from sight lines)'],
  },
  {
    id: 'C',
    name: 'C 2コーナー〜S字',
    osmWays: [184143133],
    sRange: [628, 958],
    side: 1,
    // the terrace front is straight in plan while the track bows away between T2 and the Esses
    // and swings back at T3 (R 44–68 m): past s ≈ 840 the figures below are the nearest-sample
    // projection through T3's fold and only serve the fences / checks — the stand itself is
    // built straight along its OSM front (`chord`)
    lateralFront: [[628, 57.5], [653, 41], [669, 38.5], [805, 71.5], [837, 77], [869, 78], [889, 82], [917, 73], [941, 52], [953, 39], [958, 47.5]],
    lateralBack: [[628, 70.5], [643, 68.5], [651, 62], [667, 60.5], [739, 81], [791, 92.5], [841, 98.5], [867, 98.5], [891, 106], [917, 101], [941, 79], [951, 64], [958, 51.5]],
    path: { front: [0, 11], back: [12, 27] },
    structure: 'terrace',
    tiers: [
      { id: 'C-lower', rows: 10, ...TERRACE_BENCH, colour: COLOURS.benchGreyC.mid, aisleAfter: 0.8 },
      { id: 'C-middle', rows: 10, ...TERRACE_BENCH, colour: COLOURS.benchGreyC.mid, aisleAfter: 0.8 },
      { id: 'C-upper', rows: 10, ...TERRACE_BENCH, colour: COLOURS.benchGreyC.mid },
    ],
    aisles: { pitch: 18.6, width: 5.5 }, // 17 blocks A (Esses end) – Q (T2 end), 5–6 m stairways between
    frontHeight: [[628, 1.6], [958, 2.6]], // DEM: front +0.7 (T2 end) → +1.7 (Esses end) over the run-off, ≈ +1 m more over the track
    platform: 'Old RC terrace on an earth embankment cut into the hill: retaining wall + 2009 service road at the toe, uniform 20.6° rake (8.9 m over 24 m), back concourse +12.4 with kiosks/toilets, earth bank at the Esses end, utility poles in front of O/P/Q. Suzuka’s largest stand (13,698 seats). The top-row temporary block was abolished in 2025.',
    permanent: true,
    fence: 'low-centre',
    unverified: ['tier boundaries 10/11 and 20/21', 'bench colour (neutral grey measured; pale green claim refuted)'],
  },
  // ---- Esses / 逆バンク -------------------------------------------------------------------
  {
    id: 'D5',
    name: 'D-5 S字',
    osmWays: [469395390],
    sRange: [1038, 1113],
    side: 1,
    lateralFront: [[1038, 36.8], [1068, 38.2], [1098, 39.7], [1113, 40.2]], // OSM cuts (scripts/audit/stand-edges.mjs)
    lateralBack: [[1038, 54.5], [1079, 56.5], [1081, 63], [1113, 62.5]],
    structure: 'terrace',
    tiers: [{ id: 'D-5', rows: 16, ...RC2009_BENCH }],
    aisles: { pitch: 15, width: 1.2 },
    frontHeight: 7.6, // DEM: row 1 on top of a ~7 m grass bank (20°) rising from lateral +22 to +34
    platform: '2009 RC terrace on a 7 m grass bank; back terrace +12 m',
    permanent: true,
    fence: 'single',
    unverified: ['rows (11–16 cited)'],
  },
  {
    id: 'D1_4',
    name: 'D-1〜D-4 S字〜逆バンク',
    osmWays: [469368057],
    sRange: [1141, 1391],
    side: 1,
    lateralFront: [[1141, 45.5], [1154, 43.5], [1216, 24], [1242, 22], [1264, 23.5], [1278, 27], [1290, 32], [1310, 36], [1344, 37], [1376, 35], [1391, 38.5]],
    lateralBack: [[1141, 46], [1176, 60.5], [1198, 63.5], [1220, 47], [1242, 43], [1260, 42.5], [1282, 47.5], [1316, 47], [1350, 51.5], [1372, 50], [1391, 55]],
    structure: 'terrace',
    // the OSM footprint is 21–30 m deep at the Esses end but only ~15 m toward 逆バンク: 22 rows are
    // cited for the deepest blocks, D-3 is explicitly narrow and short (17–19 rows) — split UNVERIFIED
    tiers: [
      { id: 'D-3/4', rows: 22, ...RC2009_BENCH, sRange: [1141, 1285] },
      { id: 'D-1/2', rows: 16, ...RC2009_BENCH, sRange: [1285, 1391] },
    ],
    aisles: { pitch: 14, width: 1.2 },
    frontHeight: 1.8, // DEM: row 1 +1.8, row 22 +8.5, walkway +9.2, 逆バンクオアシス plateau +10.6..+14
    platform: '2009 RC terrace cut into the rising hill; walkway + toilets behind (+45..+52), temporary D stand (scaffold, ≤10 m, ≤18 rows) on the plateau +52..+64',
    permanent: true,
    fence: 'double', // D-1 / D-2 facing 逆バンク have a double fence
    unverified: ['rows per block and the 22 → 16 row split at s ≈ 1285', 'temporary D block size (changes yearly)'],
  },
  {
    id: 'E2',
    name: 'E-2 NIPPOコーナー（逆バンク側）',
    osmWays: [467982372],
    sRange: [1414, 1572],
    side: 1,
    // E-1 / E-2 sit side by side ALONG the track on one hillside terrace (Car Watch 2010,
    // seat_e.html), separated by the stair at the ring's notch (vertex 9, s ≈ 1583): E-2 at the
    // 逆バンク end where the hill is 12 m above the track, E-1 at the NIPPO end near track level.
    // Both lie on the INSIDE of the NIPPO bend (R 49–109 m) with their rows 18–75 m from the
    // centreline, so an (s, lateral) sweep folds; both are built along the curve of their own OSM
    // front edge (`path`, front ring 15→10 and 8→1). The (s, lateral) figures below serve the
    // fences, the tree exclusion and the checks.
    lateralFront: [[1414, 62.5], [1515, 53.5], [1556, 40], [1572, 27]],
    lateralBack: [[1414, 64], [1433, 80], [1515, 75.5], [1572, 62]],
    path: { front: [10, 15], back: [16, 19] },
    structure: 'terrace',
    tiers: [{ id: 'E-2', rows: 22, ...RC2009_BENCH }], // 1.5× seat width in 2010
    aisles: { pitch: 14, width: 1.2 },
    frontHeight: [[1414, 12], [1515, 9.5], [1562, 8]], // DEM: hill +12 over the track at the 逆バンク end
    platform: '2009 RC terrace on a genuine 20 m hillside (steepest bank on the lap); hilltop plateau +15.2 (58 m ASL) with the 18-row E temporary stand; underground passage to GP Square and long stairs behind',
    permanent: true,
    fence: 'single',
    stackedWith: ['E1'],
    unverified: ['E-2 row count (not published; ≈20 m OSM depth ÷ 0.95)', 'E-1 / E-2 boundary s ≈ 1562', 'temporary E block footprint'],
  },
  {
    id: 'E1',
    name: 'E-1 NIPPOコーナー',
    osmWays: [467982372],
    sRange: [1587, 1665],
    side: 1,
    // same hillside terrace as E-2, past the stair notch; built along the curve of its own front
    // edge (front ring 8→1, back 25→0)
    lateralFront: [[1587, 29.5], [1602, 24.5], [1632, 18], [1665, 18]],
    lateralBack: [[1587, 46], [1609, 42.7], [1637, 37], [1665, 36]],
    path: { front: [1, 8], back: [25, 0] },
    structure: 'terrace',
    tiers: [{ id: 'E-1', rows: 20, ...RC2009_BENCH }],
    aisles: { pitch: 14, width: 1.2 },
    frontHeight: [[1568, 5.2], [1600, 2.5], [1633, 1.0], [1668, 0.7]], // DEM: +0.7 at the NIPPO end
    platform: 'NIPPO-end block of the E hillside terrace; the hilltop plateau (+15.2) continues behind it',
    permanent: true,
    fence: 'single',
    stackedWith: ['E2'],
    unverified: ['E-1 row count (not published)', 'E-1 / E-2 boundary'],
  },
  // temporary scaffold blocks on the plateaux behind D and E (change yearly; sizes from the
  // 2024–2026 aerials: ≤ 10 m tall, 14–18 rows). Not in OSM.
  {
    id: 'D_temp',
    name: 'D 仮設（逆バンクオアシス台地）',
    osmWays: [],
    sRange: [1250, 1385],
    side: 1,
    lateralFront: 53.5,
    lateralBack: 65,
    structure: 'scaffold',
    tiers: [{ id: 'D-temp', rows: 14, ...SCAFFOLD_BENCH, colour: '#9a9a96' }],
    aisles: { pitch: 12, width: 1.0 },
    frontHeight: 12.5, // the plateau behind D-1/D-2 (+10.6..+14); the scaffold reaches down to it
    platform: 'Scaffold on the 逆バンクオアシス plateau behind D-1 / D-2',
    permanent: false,
    fence: 'none',
    stackedWith: ['D1_4'],
    unverified: ['position and size (changes yearly; not in OSM)'],
  },
  {
    id: 'E_temp',
    name: 'E 仮設（丘上台地）',
    osmWays: [],
    sRange: [1575, 1660],
    side: 1,
    // on the hilltop plateau the E-1 relief cuts 16–40 m behind the E-1 rows
    lateralFront: [[1575, 72], [1600, 61], [1633, 55], [1660, 56]],
    lateralBack: [[1575, 87], [1600, 76], [1633, 70], [1660, 71]],
    structure: 'scaffold',
    tiers: [{ id: 'E-temp', rows: 18, ...SCAFFOLD_BENCH, colour: '#9a9a96' }],
    aisles: { pitch: 12, width: 1.0 },
    frontHeight: [[1575, 12.3], [1600, 9.5], [1633, 7.6], [1660, 7.3]], // plateau (E-1 top + 1) + 0.4
    platform: 'Scaffold on the hilltop plateau behind E-1 (58 m ASL)',
    permanent: false,
    fence: 'none',
    stackedWith: ['E1'],
    unverified: ['position and size (changes yearly; not in OSM)'],
  },
  // ---- Degner → crossover (right side) --------------------------------------------------
  {
    id: 'G_cross',
    name: 'G 立体交差（デグナー〜110R）',
    osmWays: [184102012, 184102013],
    sRange: [2353, 2464],
    side: -1,
    lateralFront: [[2353, -29], [2464, -20.5]],
    lateralBack: [[2353, -39.5], [2364, -49], [2446, -41], [2464, -31]],
    structure: 'terrace',
    tiers: [
      { id: 'G-1', rows: 12, ...TERRACE_BENCH },
      { id: 'G-2', rows: 12, ...TERRACE_BENCH, lateralFront: [[2364, -37.5], [2448, -32]], frontHeight: 4.5, sRange: [2364, 2448] },
    ],
    aisles: { pitch: 14, width: 1.2 },
    frontHeight: 1.5,
    platform: 'Two parallel bars above the underpass; permanent G-1/G-2 plus temporary rows',
    permanent: true,
    fence: 'single',
    unverified: ['rows (10–14)', 'heights', 'which bar is temporary'],
  },
  {
    id: 'H',
    name: 'H 110R',
    osmWays: [184004012],
    // the OSM polygon is the whole terrace (117 m long, up to 32 m deep); the seating is the deep
    // part of it, set back behind wall 184004014 (−10.3..−13.5) with a walkway in front — the old
    // front at −13 put row 1 on the wall itself (2026-09 audit 08-S1 / 09-09)
    sRange: [2515, 2605],
    side: -1,
    lateralFront: [[2515, -20], [2545, -21], [2575, -22], [2605, -22]],
    lateralBack: [[2515, -29.8], [2545, -45.5], [2575, -43.2], [2605, -41]],
    structure: 'scaffold',
    tiers: [{ id: 'H', rows: 12, ...SCAFFOLD_BENCH }],
    aisles: { pitch: 10, width: 1.0 },
    frontHeight: 2.0,
    platform: 'Temporary stand on the outside of 110R, behind wall 184004014 (−10.3..−13.5) and a walkway',
    permanent: false,
    fence: 'single',
    unverified: ['identification (unnamed in OSM; H per the ticket map)', 'rows', 'height', 'seating block within the terrace footprint'],
  },
  // ---- hairpin / 200R (right side) ------------------------------------------------------
  {
    id: 'I',
    name: 'I ヘアピン',
    osmWays: [184105033],
    sRange: [2692, 2738],
    side: -1,
    lateralFront: [[2692, -38.5], [2703, -35.5], [2711, -30.5], [2723, -27], [2733, -26], [2738, -31.5]],
    lateralBack: [[2692, -48], [2713, -36], [2723, -33.5], [2738, -32.5]],
    // the curved bench stand follows its OSM front edge (ring 14→26); rows concentric with it
    path: { front: [14, 26], back: [0, 12] },
    structure: 'terrace',
    tiers: [{ id: 'I', rows: 8, ...TERRACE_BENCH }], // the curved OSM footprint is only 6–9 m deep → ≤ 8 rows at 0.8 m (plan said ≈14, UNVERIFIED)
    aisles: { pitch: 12, width: 1.2 },
    frontHeight: 1.5,
    platform: 'Old permanent bench stand curving round the outside of the hairpin, no roof (japan.gp); I-1..5 temporary blocks alongside',
    permanent: true,
    fence: 'single',
    unverified: ['rows', 'height'],
  },
  {
    id: 'IJ',
    name: 'I/J ヘアピン出口（無名）',
    osmWays: [183999779],
    sRange: [2748, 2803],
    side: -1,
    lateralFront: [[2748, -28.5], [2803, -26.5]],
    lateralBack: [[2748, -39], [2803, -37]],
    path: { front: [0, 1], back: [2, 3] },
    structure: 'scaffold',
    tiers: [{ id: 'IJ', rows: 10, ...SCAFFOLD_BENCH }],
    aisles: { pitch: 10, width: 1.0 },
    frontHeight: 1.5,
    platform: 'Unnamed 11 m deep bar between I and J — probably the I temporary blocks',
    permanent: false,
    fence: 'single',
    unverified: ['identification', 'rows', 'height'],
  },
  {
    id: 'J',
    name: 'J 200R',
    osmWays: [183999763],
    sRange: [2817, 2899],
    side: -1,
    lateralFront: [[2817, -29.5], [2832, -19], [2868, -18], [2899, -35.5]],
    lateralBack: [[2817, -29.5], [2830, -28.5], [2856, -31.5], [2880, -39.5], [2899, -37]],
    path: { front: [7, 12], back: [0, 6] },
    structure: 'terrace',
    tiers: [{ id: 'J', rows: 10, ...TERRACE_BENCH }],
    aisles: { pitch: 12, width: 1.2 },
    frontHeight: 1.5,
    platform: 'Grass area with a small stand on the outside of 200R',
    permanent: true,
    fence: 'single',
    unverified: ['rows', 'height'],
  },
  // ---- Spoon (right side) ---------------------------------------------------------------
  {
    id: 'L',
    name: 'L スプーン入口',
    osmWays: [184104828],
    sRange: [3464, 3590],
    side: -1,
    lateralFront: [[3464, -44], [3491, -38], [3537, -37], [3573, -41.5], [3590, -49]],
    lateralBack: [[3464, -44.5], [3517, -46.5], [3553, -52], [3569, -55.5], [3590, -53]],
    structure: 'terrace',
    tiers: [{ id: 'L', rows: 10, ...TERRACE_BENCH }],
    aisles: { pitch: 14, width: 1.2 },
    frontHeight: 1.5,
    platform: 'Grass bank with a small stand on the outside of the Spoon entry',
    permanent: true,
    fence: 'single',
    unverified: ['rows', 'height'],
  },
  {
    id: 'M',
    name: 'M スプーン',
    osmWays: [183953761],
    sRange: [3719, 3771],
    side: -1,
    lateralFront: [[3719, -59.5], [3749, -59], [3771, -53.5]],
    lateralBack: [[3719, -65], [3741, -67], [3755, -67], [3771, -59]],
    structure: 'scaffold',
    tiers: [{ id: 'M', rows: 8, ...SCAFFOLD_BENCH }],
    aisles: { pitch: 10, width: 1.0 },
    frontHeight: 2.0,
    platform: 'Temporary stand only, on the outside of Spoon 2',
    permanent: false,
    fence: 'single',
    unverified: ['rows', 'height'],
  },
  {
    id: 'N',
    name: 'N スプーン出口',
    osmWays: [183953758],
    sRange: [3788, 3849],
    side: -1,
    lateralFront: [[3788, -49], [3796, -40], [3806, -35], [3849, -36]],
    lateralBack: [[3788, -49], [3802, -53.5], [3820, -42.5], [3849, -37.5]],
    structure: 'terrace',
    tiers: [{ id: 'N', rows: 8, ...TERRACE_BENCH }], // triangular footprint, 7–15 m deep
    aisles: { pitch: 12, width: 1.2 },
    frontHeight: 1.5,
    platform: 'Small stand at the Spoon exit',
    permanent: true,
    fence: 'single',
    unverified: ['rows', 'height'],
  },
  // ---- west straight / 130R / chicane ---------------------------------------------------
  {
    id: 'O',
    name: 'O 西ストレート（仮設・2026）',
    osmWays: [184415310],
    sRange: [4337, 4506],
    side: -1,
    lateralFront: [[4337, -30], [4374, -25], [4458, -25.5], [4506, -27.5]],
    lateralBack: [[4337, -31.5], [4344, -40.5], [4356, -50], [4358, -52.5], [4496, -48.5], [4498, -37], [4506, -37.5]],
    structure: 'scaffold',
    tiers: [{ id: 'O', rows: 12, ...SCAFFOLD_BENCH }],
    aisles: { pitch: 10, width: 1.0 },
    frontHeight: 2.0,
    platform: 'Temporary stand in two halves along the west straight, outside the s 4329–4521 gravel trap',
    permanent: false,
    fence: 'single',
    unverified: ['rows', 'height', 'split position'],
  },
  {
    id: 'G_130R',
    name: 'G 130R',
    osmWays: [184102361, 184102368],
    sRange: [4737, 4900],
    side: 1,
    lateralFront: [[4737, 46], [4755, 46], [4761, 34.5], [4789, 38], [4827, 38.5], [4861, 36], [4900, 30]],
    lateralBack: [[4737, 55.5], [4785, 60.5], [4819, 60.5], [4857, 57.5], [4900, 51]],
    structure: 'terrace',
    tiers: [
      { id: 'G-130R-1', rows: 10, ...TERRACE_BENCH },
      { id: 'G-130R-2', rows: 10, ...TERRACE_BENCH, lateralFront: [[4747, 46], [4771, 48.5], [4811, 50], [4861, 47.5], [4896, 43]], frontHeight: 4.0 },
    ],
    aisles: { pitch: 14, width: 1.2 },
    // Two blue steel canopies over the BACK bar (OSM 184102368, tier G-130R-2), with a 8 m stair
    // gap between them. The bar is straight while 130R curves, so the band follows the tier's own
    // rows rather than a fixed lateral pair (the tier's front drifts 46 → 50 → 43 over its length).
    roof: { tier: 'G-130R-2', sRange: [4763, 4894], blocks: [[4763, 4817], [4825, 4894]], soffit: 9.6, top: 9.8, overhang: 1.2, finPitch: 4.5, style: 'canopy', columns: 'deck', columnPitch: 4.5, rise: 1.0, colour: '#4f6a8a' },
    frontHeight: 1.5,
    platform: 'Two parallel bars on the inside (left) of 130R — the old code had this stand on the wrong side; the back bar carries two blue canopies',
    permanent: true,
    fence: 'single',
    unverified: ['rows', 'heights', 'which bar is temporary', 'roof extent read off GSI z18 (section 15, ±3 m): the two blue panelled decks lie over the BACK bar at s 4763–4817 and 4825–4894 (lateral 48–64 then 42–52 as the bar drifts), not over the front bar — the front bar\'s benches read white/silver row by row in the same crop, and the 2 × 22 m blocks at its 130R-entry end that the design review expected are not there'],
  },
  {
    id: 'P',
    name: 'P シケイン入口（仮設・2026）',
    osmWays: [184419745],
    sRange: [4901, 5062],
    side: 1,
    lateralFront: [[4901, 29.5], [4963, 23.5], [5062, 23]],
    lateralBack: [[4901, 48.5], [4939, 42], [4959, 42.5], [4995, 35.5], [5062, 33]],
    structure: 'scaffold',
    tiers: [{ id: 'P', rows: 12, ...SCAFFOLD_BENCH }],
    aisles: { pitch: 10, width: 1.0 },
    frontHeight: 2.0,
    platform: 'Temporary stand on the left between 130R and the chicane, behind tyre barrier 467219902 (+14.5..+21.8)',
    permanent: false,
    fence: 'single',
    unverified: ['rows', 'height'],
  },
  {
    id: 'Q2',
    name: 'Q2 シケイン',
    osmWays: [183393102, 183393101, 183393103],
    sRange: [5164, 5311],
    side: 1,
    lateralFront: 43, // nominal — the three 39 × 13 m bars sit in the figure-8 fold (EN 186–310 / 173–218); place them from the OSM polygons
    lateralBack: 64,
    structure: 'terrace',
    tiers: [{ id: 'Q2', rows: 12, tread: 0.8, riser: 0.35, seat: 'chair', colour: COLOURS.seatQ2.mid }],
    aisles: { pitch: 13, width: 1.2 },
    frontHeight: 1.5,
    platform: 'Three permanent bars with individual seats inside the chicane; the nearest-segment s mapping flips here, so use the EN footprints',
    permanent: true,
    fence: 'single',
    unverified: ['rows', 'height', 's/lateral (fold) — EN polygons are authoritative', 'seat colour'],
  },
  {
    id: 'Q1',
    name: 'Q1 シケイン',
    osmWays: [183393132],
    sRange: [5288, 5342],
    side: 1,
    lateralFront: [[5288, 36.5], [5302, 30.5], [5342, 26.5]],
    lateralBack: [[5288, 42], [5304, 39.5], [5342, 37.5]],
    path: { front: [4, 8], back: [0, 3] },
    structure: 'terrace',
    tiers: [{ id: 'Q1', rows: 11, ...TERRACE_BENCH }], // wedge-shaped footprint 5.5–11 m deep
    aisles: { pitch: 12, width: 1.2 },
    frontHeight: 1.5,
    platform: 'Permanent bench stand at the chicane exit',
    permanent: true,
    fence: 'single',
    unverified: ['rows', 'height'],
  },
  {
    id: 'R',
    name: 'R 最終コーナー',
    osmWays: [183393129],
    sRange: [5346, 5432],
    side: 1,
    lateralFront: [[5346, 29.5], [5354, 27.5], [5378, 31.5], [5410, 42], [5432, 41]],
    lateralBack: [[5346, 40], [5352, 51.5], [5374, 52.5], [5400, 59.5], [5432, 59]],
    // the 65 m front edge bends 11° at its middle: R ≈ 50 m ≫ the 12.8 m seating depth
    path: { front: [14, 20], back: [2, 11] },
    structure: 'terrace',
    tiers: [{ id: 'R', rows: 16, ...TERRACE_BENCH }],
    aisles: { pitch: 13, width: 1.2 },
    frontHeight: 1.5,
    platform: 'Permanent bench stand on the outside of Turn 18; GRAN VIEW / R-BOX terrace behind it',
    permanent: true,
    fence: 'single',
    unverified: ['rows', 'height'],
  },
  {
    id: 'S',
    name: 'S 最終コーナー',
    osmWays: [183394069],
    sRange: [5443, 5502],
    side: 1,
    lateralFront: [[5443, 37], [5469, 31], [5502, 29]],
    lateralBack: [[5443, 43], [5445, 54], [5467, 48.5], [5502, 45.5]],
    structure: 'terrace',
    tiers: [{ id: 'S', rows: 12, ...TERRACE_BENCH }],
    aisles: { pitch: 12, width: 1.2 },
    frontHeight: 1.5,
    platform: 'Open bench / family stand at the Turn 18 exit; the Ferris wheel stands behind it at +88.5',
    permanent: true,
    fence: 'single',
    unverified: ['rows', 'height'],
  },
  {
    id: 'GRAN_VIEW',
    name: 'GRAN VIEW / R-BOX',
    osmWays: [],
    sRange: [5424, 5442],
    side: 1,
    lateralFront: 60.5,
    lateralBack: 72,
    structure: 'frame',
    tiers: [],
    aisles: null,
    // the floor sits over R's back walkway (+6.3 at its S end)
    frontHeight: 8,
    platform: '2019 roofed box terrace (Course View Terrace) behind R\'s S end — separate footprint, not in OSM',
    enclosure: { floors: [8], glass: COLOURS.glassVip.mid, framePitch: 4, roofTop: 13 },
    permanent: true,
    fence: 'none',
    unverified: ['position read off GSI z18 (section 17, ±3 m): the white-roofed box with the blue front strip behind R\'s S end, corners at s 5425 / 5441 and lateral 60.4 / 71.5', 'size', 'height'],
  },
]

export function standById(id: string): StandDef | undefined {
  return STANDS.find((s) => s.id === id)
}

// ---------------------------------------------------------------- seat counts

/** seat pitch along a row (m): stadium chairs (V1/V2/Q2 plan) and bench places */
export const SEAT_PITCH: Record<SeatKind, number> = { chair: 0.507, bench: 0.55 }

/**
 * Published capacities with a source. Only sourced figures belong here: the generator's own
 * count (rows × length ÷ pitch) is clamped to them by thinning the seat SLOTS the crowd sits on
 * (per-row error diffusion; the chair furniture stays whole), and facilities-check warns when
 * the table estimate falls under 0.9 × the figure. G_130R / D1_4 have estimates only
 * (unverified) and stay unclamped.
 */
export interface SeatCapacity {
  /** the stands the figure covers together (V1 + V2 are published as one grandstand) */
  stands: string[]
  seats: number
  source: string
}

export const SEAT_CAPACITY: SeatCapacity[] = [
  { stands: ['C'], seats: 13698, source: '2026 seat map PDF (grandstand_f1.pdf) measured 2026-09-05: 17 blocks × 30 rows, 13,698 seats' },
  { stands: ['V1', 'V2'], seats: 12588, source: '2026 seat map PDF (f1_v1 / f1_v2) measured 2026-09-05: V1 22 blocks, V2 21 blocks, 12,588 seats' },
]

/**
 * Table estimate of a stand's seats (rows × usable length ÷ pitch per tier, aisles removed) —
 * what the generator produces before any clamp, within ≈ 3 % (the tapering ends).
 */
export function estimateSeats(def: StandDef): number {
  const L = CIRCUIT.officialLength
  const len = (r: [number, number]) => (((r[1] - r[0]) % L) + L) % L || L
  let n = 0
  for (const t of def.tiers) {
    const span = len(t.sRange ?? def.sRange)
    const aisles = def.aisles && span >= def.aisles.pitch * 1.5 ? (Math.max(1, Math.round(span / def.aisles.pitch)) - 1) * def.aisles.width : 0
    n += t.rows * Math.floor((span - aisles) / SEAT_PITCH[t.seat])
  }
  return n
}

// ---------------------------------------------------------------- spectator banks (lawns)

/**
 * The grass banks people sit on with leisure sheets: the 逆バンクオアシス plateau behind D,
 * the E hill past E-1, the lawns beside I / J and the West Area lawns at L / M / N (green on the
 * 2026 seat map), the slope beyond S. Measured in (s, lateral) like the stands; `lateral` is the
 * [near, far] band from the centreline on `side` (AlongTrack each, so a band can widen along s).
 * `density` is people per m² before `occupancy`; `seated` the share sitting (the rest stand).
 * Everything here is an estimate from the aerials and the seat map — see `unverified`.
 */
export interface BankDef {
  id: string
  name: string
  side: Side
  sRange: [number, number]
  lateral: [AlongTrack, AlongTrack]
  density: number
  occupancy: number
  seated: number
  /** West Area lawns get pop-up tents (one per 40 people) */
  west?: boolean
  unverified: string[]
}

export const SPECTATOR_BANKS: BankDef[] = [
  // I5-a: shortened to s 1360 — the D rear apron (GROUND_AREAS 'D 裏エプロン', OSM 184253118) is paved from s 1362 on
  { id: 'BANK_OASIS', name: '逆バンクオアシスの芝', side: 1, sRange: [1255, 1360], lateral: [66, 96], density: 0.22, occupancy: 0.85, seated: 0.7, unverified: ['extent: the plateau behind the D temporary block (aerial, ±5 m)', 'density'] },
  // I5-a: lateral from 28 — the Dunlop inner service road (GROUND_AREAS, OSM 467913438) is tarmac out to lateral 16–21 here, and its spur to the compound leaves at s 1683
  { id: 'BANK_E_HILL', name: 'E の丘（NIPPO 出口側）', side: 1, sRange: [1666, 1682], lateral: [28, 60], density: 0.2, occupancy: 0.8, seated: 0.65, unverified: ['extent: the hillside past E-1 (aerial, ±5 m). Trimmed to s 1682 because that is where the fence-carrying run behind E-1 ends: dunlop-inside (s 1682–1824) is a bare concrete wall in BARRIERS, so people past it would sit unscreened. If a photo shows a debris fence on that wall, put fence on the run and give this row its full extent back (…1725).', 'density'] },
  { id: 'BANK_I', name: 'ヘアピン外側の芝（I 席手前）', side: -1, sRange: [2630, 2691], lateral: [32, 46], density: 0.25, occupancy: 0.85, seated: 0.6, unverified: ['extent (aerial, ±5 m)', 'density'] },
  { id: 'BANK_J', name: 'J 200R の芝（西エリア）', side: -1, sRange: [2810, 2900], lateral: [41, 58], density: 0.18, occupancy: 0.6, seated: 0.7, west: true, unverified: ['extent: the lawn behind the J stand (aerial, ±5 m)', 'density'] },
  { id: 'BANK_L', name: 'L スプーン入口の芝（西エリア）', side: -1, sRange: [3460, 3595], lateral: [57, 74], density: 0.18, occupancy: 0.55, seated: 0.7, west: true, unverified: ['extent: the bank behind the L stand (aerial, ±5 m)', 'density'] },
  { id: 'BANK_M', name: 'M スプーンの芝（西エリア）', side: -1, sRange: [3700, 3790], lateral: [69, 86], density: 0.16, occupancy: 0.6, seated: 0.7, west: true, unverified: ['extent: the slope behind the M scaffold (aerial, ±5 m)', 'density'] },
  { id: 'BANK_N', name: 'N スプーン出口の芝（西エリア）', side: -1, sRange: [3796, 3860], lateral: [56, 72], density: 0.16, occupancy: 0.55, seated: 0.7, west: true, unverified: ['extent: the lawn behind the N stand (aerial, ±5 m)', 'density'] },
  { id: 'BANK_S_BEYOND', name: 'S 席の先の芝（観覧車手前）', side: 1, sRange: [5503, 5560], lateral: [28, 56], density: 0.22, occupancy: 0.8, seated: 0.6, unverified: ['extent: the slope between the S stand and the Ferris wheel (aerial, ±5 m)', 'density'] },
]

export function bankById(id: string): BankDef | undefined {
  return SPECTATOR_BANKS.find((b) => b.id === id)
}

// ---------------------------------------------------------------- buildings

export interface BuildingDef {
  id: string
  name: string
  /** OSM way id whose EN polygon is extruded; null when the block is hand-placed */
  osmWay: number | null
  /** eaves height (m) above local ground */
  height: number
  levels: number
  /** where to read the ground: track surface at [s, lateral] or the terrain */
  anchor: { s: number; lateral: number } | 'terrain'
  colour: string
  roof: 'flat' | 'gable' | 'curved'
  /**
   * Which builder extrudes the block: every row is paddock.ts today (the v1 footprint
   * extrusion moved there in I1-a); 'paddock' marks the rows I2 rebuilds from the drawings,
   * 'infield' the rows infield-ground.ts extrudes (I5-a: the driving school).
   */
  builder?: 'paddock' | 'infield'
  unverified?: string[]
}

export const BUILDINGS: BuildingDef[] = [
  // The three OSM team-office polygons (E/D/C+WC, B, A) and the centre house stay here so the
  // surroundings generator's OWNED set never re-ships them; paddock.ts builds them from the
  // 2009 dossier (PADDOCK_BUILDINGS, `builder: 'paddock'`) instead of extruding these rings —
  // the OSM outlines trace the porches / canopies (17 m deep vs the 10.5 m building)
  { id: 'team_offices', name: 'チームオフィス E・D・C・WC', osmWay: 184423963, height: 3.2, levels: 1, anchor: { s: 5670, lateral: -88 }, colour: COLOURS.pitFacade.mid, roof: 'flat', builder: 'paddock', unverified: ['the OSM outline is the porch / canopy line (paddock.ts builds PADDOCK_BUILDINGS instead)'] },
  { id: 'team_offices_b', name: 'チームオフィス B', osmWay: 184430911, height: 3.2, levels: 1, anchor: { s: 22, lateral: -86 }, colour: COLOURS.pitFacade.mid, roof: 'flat', builder: 'paddock', unverified: ['as team_offices'] },
  { id: 'team_offices_a', name: 'チームオフィス A（既設 2 階）', osmWay: 184430909, height: 6.5, levels: 2, anchor: { s: 73, lateral: -86 }, colour: COLOURS.pitFacade.mid, roof: 'flat', builder: 'paddock', unverified: ['storeys', 'as team_offices'] },
  // the centre house (D-shaped, flat side to the pits): 2 levels under the elliptical canopy;
  // the eaves take the I1 spur bridge's top (PIT_BUILDING.v2.spur.bridge y 8.55) under them
  { id: 'centre_house', name: 'センターハウス', osmWay: 184430907, height: 8.7, levels: 2, anchor: { s: 5774, lateral: -84 }, colour: COLOURS.pitFacade.mid, roof: 'flat', builder: 'paddock', unverified: ['height (the dossier gives 2 levels and no elevation; 8.7 = the spur bridge\'s top + 0.15)', 'storey heights'] },
  // 2026: the medical centre is the ground floor of the control pod (pit building, final-corner
  // end); way 184429429 beside the helipad is the former medical room, now the course-vehicle base
  { id: 'course_vehicle_base', name: '旧医務室（コース車両基地）', osmWay: 184429429, height: 5.0, levels: 1, anchor: { s: 165, lateral: -40 }, colour: COLOURS.pitFacade.mid, roof: 'flat', builder: 'paddock', unverified: ['height', 'use (the 2009 dossier calls it 医務室; the 2026 medical centre is in the pod)'] },
  { id: 'dunlop_office', name: '日本ダンロップ鈴鹿事務所', osmWay: 184423961, height: 7, levels: 2, anchor: { s: 5690, lateral: -182 }, colour: '#d9d6cf', roof: 'flat', unverified: ['height'] },
  // the west control tower (184415318) moved to INFIELD_FACILITIES at I5-b (9 m / 2 levels with its glass band, balcony and antenna)
  { id: 'circuit_plaza', name: 'CIRCUIT PLAZA', osmWay: 308666565, height: 9, levels: 2, anchor: 'terrain', colour: '#e4e0d6', roof: 'flat', unverified: ['height'] },
  // the driving school (I5-a): a 2-storey block behind the A1 stand (OSM 466925741, 52 × 49 m,
  // 1,545 m²) on its own practice loops (GROUND_AREAS 交通教育センター); infield-ground.ts extrudes
  // it, the surroundings generator's OWNED set drops it from SUR_BUILDINGS
  { id: 'stec', name: '鈴鹿サーキット交通教育センター', osmWay: 466925741, height: 8, levels: 2, anchor: 'terrain', colour: '#e4e0d6', roof: 'flat', builder: 'infield', unverified: ['height / storeys (shadow length in the aerial)'] },
]

/**
 * Helipad (H mark circle) beside the former medical room (BUILDINGS course_vehicle_base, way
 * 184429429) at the final-corner end of the pit building — GSI z18 aerial. The 2009 dossier says
 * "医務室横"; the 2026 medical centre itself is the control pod's ground floor (PIT_BUILDING.v2).
 */
export const HELIPAD = { s: 5566, lateral: -78, radius: 8 }
/**
 * The west loop's fresh asphalt (I5-a): the stretch resurfaced before the 2026 race reads darker
 * and smoother than the rest of the lap — ground-mesh.ts writes a per-vertex `aFresh` on the
 * road face (0 → 1 over `fade` metres at both ends, inside the range) and materials.ts
 * `addRoadSurface` darkens the diffuse (× 0.72) and lowers the roughness (− 0.1) by it.
 */
export const FRESH_ASPHALT = { sRange: [3540, 4760] as [number, number], fade: 40, unverified: ['extent: the west loop (200R exit → Spoon → west straight → 130R entry) per the user\'s brief; the joints ±20 m'] }

/**
 * The second helipad (I5-a): on the Dunlop-loop paddock apron, an H inside an orange / yellow
 * square border ≈ 20 m across in the GSI z18 aerial (misc/audit/sections/06-nippo-e1-dunlop and
 * 15-130r-g-p, bottom right). No OSM way (aeroway is not queried); position ±5 m (unverified).
 * `mark` picks the tile of the helipad atlas (textures.ts helipadTexture): 0 = the white circle
 * of the pit-complex pad, 1 = the orange square of this one.
 */
export const HELIPAD_2 = { s: 2050, lateral: 70, radius: 10 }
/** every helipad disc with its atlas tile — ground-mesh.ts `uvOf` maps a `helipad` face onto the nearest one */
export const HELIPADS: { s: number; lateral: number; radius: number; mark: 0 | 1 }[] = [{ ...HELIPAD, mark: 0 }, { ...HELIPAD_2, mark: 1 }]

/**
 * The grass island in the centre house's round drive (I2-a): OSM landuse=grass 469896637, a
 * 4.2 m circle 10 m off the round facade of 184430907 (its SW end is at lateral −124), which is
 * where pad-14.png shows the lawn and the kerbed drive. The GROUND_AREAS disc and the concrete
 * kerb ring (paddock.ts, GROUND_OBJECTS.islandKerb) read the same numbers.
 */
export const PADDOCK_ISLAND = { s: 5774, lateral: -134, radius: 4.2 }

// ---------------------------------------------------------------- paddock (I2-b)

/**
 * The paddock plane: the drawn ground behind the pit building is one plane at the road plane
 * − `drop` (the I0-c relief core; the 1,480 mm of the dossier's section is the foundation
 * depth, not a step). Every building on it stands on a flat slab `floor` above that plane —
 * one slab per module, NOT following the 2.8 % fall inside a module — on a plinth reaching
 * `plinth` below the plane (p6_sec: floor → eave 3,200 with the ground lines at floor level,
 * the paddock side 0.15–0.2 lower with a small step). The buildings past the plane (the S lot,
 * the tyre garage) stand on the natural ground instead (`floor: 'ground'`).
 */
export const PADDOCK_PLANE = { drop: 0.12, floor: 0.15, plinth: 0.3 } as const

/**
 * The team-office module (pitpad-6 / p6_sec): 3 rooms of 3.8 × 10.5 m in an 11,400 × 10,500
 * block (250 + 4 × 2,500 + 250), a 1.0 m porch strip on the pit side and 1.5 m on the paddock
 * side, floor → eave 3,200, roof fascia 330 (top 3.53), vertical corrugated siding, a light
 * blue-grey shallow metal roof (pad-14 ③), one wide light-grey roller door + one window per room
 * on the pit face, one door + one window per room on the paddock face, a 2 m ramp at every
 * paddock door, one condenser unit per room. The row stands at lateral −80.5 … −91.0 (the
 * OSM outline 184423963's pit-side edge −80.4 = the porch line; the dossier's "30 m from the
 * pits" would put the face at −86.7 — 6 m apart, the OSM edge is taken).
 */
export const PADDOCK_OFFICE = {
  /** module length along s and its room count */
  module: 11.4,
  rooms: 3,
  /** the building's lateral extent (right side, negative) and the porch strips beyond it */
  lateral: [-91.0, -80.5] as [number, number],
  porch: { pit: 1.0, paddock: 1.5 },
  eaves: 3.2,
  roofTop: 3.53,
  roofColour: 0x8fa4b4,
  /** the pit-face roller door (w × h) and the openings' sizes */
  rollDoor: [2.5, 2.6] as [number, number],
  window: [1.2, 1.0] as [number, number],
  door: [0.9, 2.1] as [number, number],
  ramp: 2.0,
  /** the corrugated siding's photo tile (m per repeat) */
  sidingTile: 1.0,
} as const

export type PaddockBuildingKind = 'teamOffices' | 'officeBlock' | 'centreHouse' | 'smsc' | 'fuel' | 'serviceHouse' | 'tyreGarage' | 'vehicleBase'

export interface PaddockBuildingDef {
  id: string
  name: string
  kind: PaddockBuildingKind
  /** OSM way the footprint is extruded from (facilities-check §6 / O6 / O11); absent = the track-frame box below */
  osmWay?: number
  /** the stretch of lap the row belongs to (the window of every world → s mapping, R14); for a track-frame box also its s extent */
  sRange: [number, number]
  /** lateral extent of a track-frame footprint (right side negative) */
  lateral?: [number, number]
  /** team offices: how many PADDOCK_OFFICE modules from sRange[0] (0 = one plain block of the row's length) */
  modules?: number
  /** the floor: a flat slab over the paddock plane (PADDOCK_PLANE) or the natural ground (ground.standY) */
  floor: 'plane' | 'ground'
  /** eaves height above the floor (m) */
  eaves: number
  levels: number
  /** the walls' material key (the pack texture, with a procedural fallback) and tint */
  wall: 'corrugated007a' | 'corrugated009' | 'plaster' | 'concrete'
  /** roll doors on one face: which face (track frame), how many, their size */
  doors?: { face: '+lateral' | '-lateral' | '-s' | '+s'; n: number; w: number; h: number }
  /** the orientation of a rotated footprint: the two OSM ways whose centroids give the long axis */
  axisWays?: [number, number]
  unverified: string[]
}

/**
 * The paddock's buildings (plan I2-b), from the 2009 dossier layout (pphi-3, read off at
 * 2.22 px/m, ±5 m) and the OSM outlines where one exists. Heights are the dossier's where it
 * gives one (team offices), estimates elsewhere (`unverified`). Rows carry no world height:
 * paddock.ts places every one on the paddock plane or the drawn ground.
 */
export const PADDOCK_BUILDINGS: PaddockBuildingDef[] = [
  // --- the team-office row behind the pits (pphi-3: E 5605→5641, D 5646→5691, C 5694→5730, WC 5731→5744, B 0→49, A 56→88)
  { id: 'offices_e', name: 'チームオフィス E', kind: 'teamOffices', sRange: [5605, 5639.2], lateral: PADDOCK_OFFICE.lateral, modules: 3, floor: 'plane', eaves: PADDOCK_OFFICE.eaves, levels: 1, wall: 'corrugated007a', unverified: ['s (pphi-3 ±5 m)'] },
  { id: 'offices_d', name: 'チームオフィス D', kind: 'teamOffices', sRange: [5646, 5691.6], lateral: PADDOCK_OFFICE.lateral, modules: 4, floor: 'plane', eaves: PADDOCK_OFFICE.eaves, levels: 1, wall: 'corrugated007a', unverified: ['s (pphi-3 ±5 m)'] },
  { id: 'offices_c', name: 'チームオフィス C', kind: 'teamOffices', sRange: [5694, 5728.2], lateral: PADDOCK_OFFICE.lateral, modules: 3, floor: 'plane', eaves: PADDOCK_OFFICE.eaves, levels: 1, wall: 'corrugated007a', unverified: ['s (pphi-3 ±5 m)'] },
  { id: 'offices_wc', name: 'WC 棟', kind: 'teamOffices', sRange: [5731, 5744], lateral: PADDOCK_OFFICE.lateral, modules: 0, floor: 'plane', eaves: PADDOCK_OFFICE.eaves, levels: 1, wall: 'corrugated007a', unverified: ['s (pphi-3 ±5 m)', 'size'] },
  { id: 'offices_b', name: 'チームオフィス B', kind: 'teamOffices', osmWay: 184430911, sRange: [5, 39.2], lateral: PADDOCK_OFFICE.lateral, modules: 3, floor: 'plane', eaves: PADDOCK_OFFICE.eaves, levels: 1, wall: 'corrugated007a', unverified: ['s (pphi-3 ±5 m; OSM 184430911 spans 5801.8→43.7 with its porches)'] },
  // A (既設, 12 rooms): the two-storey white block of pad-14 ①, 32 × 10 m, an external corridor / balcony on the paddock face
  { id: 'offices_a', name: 'チームオフィス A（既設）', kind: 'officeBlock', osmWay: 184430909, sRange: [57, 89], lateral: PADDOCK_OFFICE.lateral, floor: 'plane', eaves: 6.5, levels: 2, wall: 'plaster', unverified: ['storeys', 'eaves', 's (pphi-3 ±5 m; OSM 184430909 spans 48.2→86.7 with its porches)'] },
  // --- the centre house (BUILDINGS centre_house carries the height; this row is its footprint for O6 / O11)
  { id: 'centre_house', name: 'センターハウス', kind: 'centreHouse', osmWay: 184430907, sRange: [5755, 5795], floor: 'plane', eaves: 8.7, levels: 2, wall: 'plaster', unverified: ['eaves (see BUILDINGS centre_house)', 'canopy 52 × 44 at 9.6, the 16 columns ≥ 2.4 m outside the walls under its rim (pad-14 ②: the roof overhangs the building by ≈ 3 m on slender columns outside the balcony; an ellipse over the D-shaped ring overhangs 4.5–6 m)', 'stair and balcony positions'] },
  // --- SMSC office (pad-14 ④): single storey, fully glazed front under a deep flat slab on round columns
  { id: 'smsc', name: 'SMSC 事務所', kind: 'smsc', sRange: [63, 88], lateral: [-124, -102], floor: 'plane', eaves: 4.0, levels: 1, wall: 'concrete', unverified: ['s / lateral (pphi-3 ±5 m)', 'eaves 4.0', 'canopy 3 m on φ0.3 columns @ 5 m'] },
  // --- the fuel station at the T1 end of the paddock road: the two amenity=fuel ways are the pump islands (their centroids give the axis)
  { id: 'fuel', name: '施設内給油所', kind: 'fuel', sRange: [98, 122], lateral: [-96, -60], axisWays: [469451640, 469451655], floor: 'ground', eaves: 5.0, levels: 1, wall: 'plaster', unverified: ['canopy 24 × 9 × 0.6 at 5.0 on φ0.4 × 4', 'dispensers 4 on 2 islands', 'kiosk 6 × 4 × 3.2 at the −s end of the apron (pphi-3 draws the box to s 128, but the pond 184005565 begins at s 124)'] },
  // --- beyond the paddock road: the service house (2 levels) and the tyre service garage, on the natural ground
  { id: 'service_house', name: 'サービスハウス', kind: 'serviceHouse', sRange: [5694, 5738], lateral: [-183, -153], floor: 'ground', eaves: 7.5, levels: 2, wall: 'corrugated009', unverified: ['height', 'footprint (pphi-3 ±5 m)'] },
  { id: 'tyre_garage', name: 'タイヤサービスガレージ', kind: 'tyreGarage', sRange: [5685, 5757], lateral: [-219, -187], floor: 'ground', eaves: 6.0, levels: 1, wall: 'corrugated009', doors: { face: '+lateral', n: 6, w: 3.5, h: 4.0 }, unverified: ['height', 'footprint (pphi-3 ±5 m)', '6 roll doors on the service-house face'] },
  // --- the former medical room (BUILDINGS course_vehicle_base carries the height): 3 roll doors on the −s face, a window band
  { id: 'course_vehicle_base', name: '旧医務室（コース車両基地）', kind: 'vehicleBase', osmWay: 184429429, sRange: [140, 190], floor: 'plane', eaves: 5.0, levels: 1, wall: 'plaster', doors: { face: '-s', n: 3, w: 2.2, h: 3.2 }, unverified: ['use', 'doors (lights.jpg shows the vehicles parked beside it)'] },
  // (the I2-b tunnel heads — the 逆バンクトンネル ramp head box and the works-road head frame — are gone: since I6 the
  //  ramps are CUTS corridors (gyakuTunnelR / worksSW) and their portals are cuttings.ts headwalls)
]

/**
 * The paddock's chain-link enclosure (green mesh, pad-14 ① / padoc.jpg): the OSM fence ways
 * around the E paddock and the helipad compound and along the pit entry — fold rows placed
 * from EN only (their s ranges are unreliable) — plus the pit-exit yard's edge and the hand
 * fence that closes that yard at its T1 end. `gates` are 8 m openings cut where a road crosses:
 * the helipad compound's gate, the yard gate, and the pit-entry outer fence where OFFSET_LANES
 * 411291883 crosses it (s 5325–5337). `clip` drops the yard fence's last vertex, which OSM
 * draws into the pit-exit lane's keep-out (PIT_ENVELOPE).
 */
export const PADDOCK_FENCE = {
  height: 3.0,
  colour: 0x2f6a3a,
  postPitch: 3.0,
  ways: [474537488, 474537494, 474099241, 469636518],
  /** vertices to drop: [way, index] */
  clip: [[469636518, 7]] as [number, number][],
  /** hand polylines in (s, lateral) */
  hand: [
    { name: 'ピット出口ヤード T1 端', pts: [[191.2, -27.0], [200, -40], [200, -52]] as [number, number][], window: [150, 250] as [number, number] },
  ],
  gates: [
    { s: 5548, lateral: -60, w: 8, window: [5500, 5600] as [number, number], note: 'helipad compound (474537494)' },
    { s: 200, lateral: -46, w: 8, window: [150, 250] as [number, number], note: 'pit-exit yard' },
    { s: 5331, lateral: -27.5, w: 8, window: [5280, 5380] as [number, number], note: 'OFFSET_LANES 411291883 crosses the pit-entry outer fence 474099241' },
  ],
  unverified: ['heights', 'the yard fence and its gate (no OSM way; the yard is closed at its T1 end so the vehicles have a gate onto the pit-exit road)', 'gate widths'],
} as const

/**
 * Street lamps (a procedural 8 m pole with a cobra head, both LOD levels — the pack's
 * street_lamp_02 is a 1.7 m wall lantern, not a pole, and is not used): along the paddock's service roads
 * (SUR_ROADS ids — the paddock road 184429431 from the fuel station round the S lot to the
 * A car park, its spur 184429432 to the pit building, the centre house's round drive
 * 184429434 / 469650860) every `pitch` metres, plus the rows the aerials show along the
 * office fronts, the vehicle base and the fuel station (`extra`, track frame).
 */
export const PADDOCK_LAMPS = {
  roads: [184429431, 184429432, 184429434, 469650860],
  pitch: 40,
  height: 8.0,
  /** the lamp's offset from the road's centreline (m, to its right in walking order) */
  offset: 3.5,
  extra: [
    // the office fronts: between the truck strip and the pit-side porches, 0.9 m off the roller
    // doors' no-parking hatches (PADDOCK_BAY.hatch −79.4…−76.4; paddock.ts drops an extra inside one)
    [5612, -75.5], [5652, -75.5], [5692, -75.5], [5732, -75.5], [12, -75.5], [52, -75.5], [86, -75.5],
    // the E paddock's edge, the vehicle base and the fuel station (its −s end: (130, −64) is the
    // grass 4 m outside the pond 184005565's rim; paddock.ts drops a lamp that lands on a water
    // face). (5545, −44), not (5520, −44): the 逆バンクトンネル's paddock-side ramp (CUTS
    // gyakuTunnelR, (5522, −32) → (5524, −64)) runs through the latter, and the pole stood on
    // the ramp floor (the I6 review, V6); paddock.ts also drops a lamp inside any corridor
    [5430, -40], [5545, -44], [150, -48], [185, -48], [100, -66], [130, -64],
  ] as [number, number][],
  unverified: ['positions (aerials, ±10 m)', 'height 8 m'],
} as const

/**
 * The 22 m floodlight masts (3 heads) at the E paddock's edge and inside the final corner; the
 * hairpin one is I4. The first one stands on the grass 2 m outside the E lot, inside the strip
 * s 5440–5510 that PADDOCK_PARKING keeps empty for the I3 broadcast compound: I3 reads these
 * rows (paddock.ts also pushes each mast's disc r 2.2 into ctx.keepOut) and keeps clear of them.
 */
export const PADDOCK_MASTS = {
  height: 22,
  heads: 3,
  at: [{ s: 5480, lateral: -38 }, { s: 5330, lateral: -34 }],
  unverified: ['positions (final.jpg shows light masts around the E paddock; ±15 m)', 'height'],
} as const

/**
 * One car-park block of the paddock (plan I2-c): `rows` bay rows along the lap between
 * `s[0]` and `s[1]`, laid out from `lat[0]` (the edge nearer the track) towards `lat[1]` as
 * back-to-back PAIRS — two rows of `PADDOCK_BAY.bayD` deep bays sharing an axis, then a
 * `PADDOCK_BAY.aisle` wide aisle before the next pair (vehicles.ts CAR_PARK's double-loaded
 * pitch 16 m). Bays repeat every `pitch` metres along the row (`angle` 45: the bay leans 45° to
 * +s, so the pitch along s is `pitch / sin 45°` and the row is `bayD cos 45° + bayW sin 45°`
 * deep). `occupancy` is the share of bays that get a car before the tier budget
 * (`Quality.infield.paddockCars`) scales every block down alike. Rows carry no height and no
 * world coordinates: paddock.ts `paddockBays` walks the bays in the track frame, keeps the ones
 * whose four corners stand on a drawn `paddock` face (ground.plan.ownerAtSL / ground.builtY),
 * outside the sim's pit envelope (PIT_ENVELOPE.keepOut), off every building footprint, fence
 * run and lamp, and level enough for a rigid body (CAR_PARK.slopeGrade), and drops the rest —
 * so a block may reach past the paving it stands on (E's outer pairs climb the DEM fade, the
 * S lot's polygon is a wedge) and the paving decides the bays.
 */
export interface PaddockParkingRow {
  /** ASCII id: the bay-line decal is `paddockBayLines-<id>` */
  id: string
  name: string
  /** the block's stretch along the lap (a forward range; also the window of every world → s mapping, R14) */
  s: [number, number]
  /** from the first row's near edge to the last row's far edge (right side, negative) */
  lat: [number, number]
  /** bay rows (each pair of rows shares an axis; an odd count ends with a single row) */
  rows: number
  angle: 0 | 45
  /** bay pitch along the row (m) = CAR_PARK.bayW */
  pitch: number
  occupancy: number
  note?: string
}

/**
 * The paddock's car parks: A behind the team offices (pad-14 ①: three double rows from the
 * office road to the paddock road), B by the SMSC with its 45° block south-east of it, E inside
 * the pit entry (OSM amenity=parking 474537492; s 5440–5510 stays EMPTY for the I3 broadcast
 * compound), the strip beside the course-vehicle base in the pit-exit yard, and the S lot in
 * front of the service house (OSM 469896634, natural ground). Every extent is read off the
 * aerials at ±3 m (`unverified` in PADDOCK_BAY).
 */
export const PADDOCK_PARKING: PaddockParkingRow[] = [
  { id: 'A', name: 'A パドック', s: [5604, 5739], lat: [-101, -143], rows: 6, angle: 0, pitch: 2.5, occupancy: 0.85, note: 'axes −106 / −122 / −138 (pad-14 ①); the office road −92.5…−101 and the paddock road beyond −144 stay clear' },
  { id: 'B', name: 'B パドック', s: [2, 45], lat: [-107, -133], rows: 4, angle: 0, pitch: 2.5, occupancy: 0.7, note: 'axes −112 / −128 (OSM 469650858 spans −97…−133)' },
  { id: 'B45', name: 'B パドック斜め区画', s: [68, 96], lat: [-130, -158], rows: 4, angle: 45, pitch: 2.5, occupancy: 0.6, note: 'the 45° bays of OSM 469896636 carried on to the wall 468336109' },
  { id: 'E', name: 'E パドック', s: [5350, 5440], lat: [-40, -95], rows: 8, angle: 0, pitch: 2.5, occupancy: 0.9, note: 'inside OSM 474537492; the outer pairs climb the relief fade and the slope rule thins them; s 5440–5510 is the I3 broadcast compound' },
  { id: 'yard', name: 'ピット出口ヤード（車両基地脇）', s: [150, 197], lat: [-46.5, -51.5], rows: 1, angle: 0, pitch: 2.5, occupancy: 0.7, note: 'one row along the yard fence (band edge −52), noses to the vehicle base (184429429 reaches −45.7)' },
  { id: 'S', name: 'S パドック（サービスハウス前）', s: [5624, 5667], lat: [-150, -225], rows: 6, angle: 0, pitch: 2.5, occupancy: 0.6, note: 'three double rows across the OSM wedge 469896634; the bays past its west edge are dropped' },
]

/**
 * The bay geometry (vehicles.ts CAR_PARK's bay 2.5 × 5 and 6 m aisle are the same numbers: the
 * far-field lots and the paddock read one convention), the paint, the no-parking hatch in
 * front of every team-office roller door (pad-14 ③: a 3 m yellow-bordered square with 45°
 * stripes on the truck strip, centred so its track-side edge stays 0.1 m off the pit-side porch
 * line PADDOCK_OFFICE.lateral[1] + porch.pit = −79.5), and how many of the A lot's cars are
 * under a cover (`covered_car`).
 */
export const PADDOCK_BAY = {
  bayW: 2.5,
  bayD: 5.0,
  aisle: 6.0,
  /** the painted line's width (m) */
  line: 0.1,
  hatch: { size: 3.0, lateral: -77.9 },
  coveredCars: 3,
  unverified: ['every block extent (aerials, ±3 m)', 'occupancies (a race-weekend paddock; the tier budget scales them anyway)', 'hatch size / position (pad-14 ③, ±0.5 m)'],
} as const

// ---------------------------------------------------------------- pit complex

/** Pit-lane face of the pit building (m from the centreline, right side). OSM way 184422099. */
export const PIT_GARAGE_FRONT = -25.1
/**
 * Garage row from the Mobilityland 2009 pit / paddock dossier (pitpad-5: pit 4.75 × 23.3 m, plan
 * widths 7,000 | 19,000 | 19,000 | 7,000): 48 pits in 12 blocks of 4 (19 m) with a 7 m pit-room /
 * stair core between every two blocks — [4][core][8][core][8][core][8][core][8][core][8][core][4]
 * = 12 × 19 + 6 × 7 = 270 m. One F1 team takes one block.
 */
export const PIT_BOX = 4.75
export const PIT_BLOCK = 19
export const PIT_CORE = 7
/** 11 team garages + 1 empty bay under the podium (FIA / Pirelli). */
export const PIT_GARAGE_COUNT = 12
/**
 * Block centres from the T1 end (garage 1 = pits 1–4) to the final-corner end (garage 12 = pits
 * 45–48), wrapped through s = 0. Derived from the dossier: the row starts 11 m from the T1 nose
 * (s ≈ 88) and runs 270 m toward the final corner; the absolute s is UNVERIFIED (±10 m).
 * Adjacent differences are 19 (two blocks of one 8-pit group) or 26 (across a 7 m core).
 */
export const GARAGE_CENTRES = [78.5, 52.5, 33.5, 7.5, 5795.5, 5769.5, 5750.5, 5724.5, 5705.5, 5679.5, 5660.5, 5634.5] as const
/** The six 7 m cores (pit rooms + stair towers) between the 8-pit groups, [from, to] in s. */
export const PIT_CORES: [number, number][] = [[62, 69], [17, 24], [5779, 5786], [5734, 5741], [5689, 5696], [5644, 5651]]
/**
 * Planned CIRCUIT.pit values (facilities-check compares them). `garageFront` is the OSM building
 * outline = the 2F terrace drip line; the shutters stand 2.8 m + 0.35 m behind it (dossier
 * section, 2,800 overhang + 350 wall). `stopLateral` / `stopSwitchM` (I phase, §横断 2): the
 * pit-stop position keyed to the working area in front of the shutter (−28.3 + 4.8, unverified
 * ±1.0) and the distance before boxS at which the sim starts steering to it. Everything static
 * (ops-check, crew tables, box paint) derives from `PIT_ENVELOPE.stop`, so the fallback
 * (stopLateral −17.1) changes numbers only.
 */
export const PIT_PLANNED = { garageFront: PIT_GARAGE_FRONT, shutter: -28.3, boxSpacing: PIT_BLOCK, laneOffset: -14.6, laneWidth: 9, wallOffset: -9.4, stopLateral: -23.5, stopSwitchM: 100 } as const

/** Centre s of the garage at `index` (0 = McLaren at the T1 end), wrapped to [0, L). */
export function garageS(index: number): number {
  return GARAGE_CENTRES[index]!
}

/**
 * 2026 garage order from the pit-road exit (T1 end): 2025 constructors' order, new entrant
 * last. Suzuka assigns garages from the pit exit (2016 official post). UNVERIFIED for 2026 —
 * derived, no photo of the actual 2026 pit lane was found.
 */
export const GARAGE_ORDER: TeamId[] = [
  'mclaren', 'mercedes', 'redbull', 'ferrari', 'williams', 'racingbulls', 'astonmartin', 'haas', 'audi', 'alpine', 'cadillac',
]

export function garageIndexOf(team: TeamId): number {
  return GARAGE_ORDER.indexOf(team)
}

/** The garage row: from the final-corner edge of the last block to the T1 edge of block 1 (wraps through s = 0) = [5625, 88], 270 m. */
export const PIT_BOX_STRIP: [number, number] = [garageS(PIT_GARAGE_COUNT - 1) - PIT_BLOCK / 2, garageS(0) + PIT_BLOCK / 2]

/**
 * The envelope the moving cars need in the pit lane, for the static ops layer (facilities-check
 * §16 O1 / O3 / O9) — measured with `pnpm sim -- --laps 8 --seeds 3 --pit-trace` (I0-b; all 22
 * cars pit on one lap, the crowded case): an entering car sits up to 4.3 m left of
 * `Track.pitLateralAt` at the entry point (still on its racing line) and within 1.7 m of it from
 * s 5300 on; on the exit ramp a car that had to yield to lane traffic after its box can still be
 * 2 m right of the centreline (an unobstructed car is back within 1 m 30 m after the box, then
 * lags the inward ramp by ≤ 1 m). `entryLag` / `exitLag` are those maxima + 0.5 and gate the
 * harness; `keepOut` covers them with the half-width and a margin.
 *  - keepOut: nothing static inside [c − back, max(c + front, −hw)] over the whole entry → exit span;
 *  - lanes: the fast + working lane band, used along the whole box strip;
 *  - workArea: the concrete apron between the working lane and the shutter line, where crew and
 *    equipment stand — outside the stopped car's rectangle (carBox, per block);
 *  - chaseLens: the director's pit-follow chase lens at (boxS − back, stop, +up); nothing taller
 *    than maxH in the lens column s ∈ [boxS − columnS[0], boxS − columnS[1]] × stop ± halfLat.
 * Every ops coordinate is computed from `stop`; no literal stop lateral anywhere else.
 */
export const PIT_ENVELOPE = {
  entryLag: 4.8,
  exitLag: 2.5,
  carHalf: 0.95,
  stop: PIT_PLANNED.stopLateral,
  keepOut: { back: 6.5, front: 5.5 },
  boxStrip: PIT_BOX_STRIP,
  lanes: [-19.1, -9.1],
  workArea: [-28.3, -19.1],
  carBox: { halfS: 2.9, margin: 0.6 },
  chaseLens: { back: 11, up: 3.4, halfLat: 1.5, columnS: [13, 9], maxH: 2.9 },
} as const

/**
 * The pit building. `v2` = the Mobilityland 2009 pit / paddock dossier (pp4s2-4 section,
 * pphi-3 / pphi-4 elevations, pp4t-4 plan, p5spec pit spec, pitph-12 terraces, ct-13 control
 * tower) that pit-building.ts builds from (I1-b). Lateral values are metres from the
 * centreline (negative = right = pit side), heights are above the local pit-lane apron (the
 * building follows the 2.8 % gradient).
 *
 * The remaining v1 keys (`floors`, `garage`, `podium`, `controlPod`, `spur` — the
 * photogrammetry estimate) are read by nothing since I1-b commit 2 and go, with `v2` promoted
 * to the top level, in the commit that finishes the building (I1-b commit 3); `roofTop`,
 * `garage.doorWidth / fasciaHeight` and `terrace2F.rows` were deleted with their consumers.
 */
export const PIT_BUILDING = {
  osmWay: 184422099,
  /** straight front face (pphi-3): the final-corner nose 5554.5, the T1 nose 92 → 103.3 (v2) */
  sRange: [5554.5, 92] as [number, number],
  /** the 2F terrace drip line = OSM way 184422099 = the pit-lane face facilities-check §3 holds to ±1.5 */
  front: PIT_GARAGE_FRONT,
  back: -56.7,
  /** 2F terrace: the black seats of the hospitality rooms (pitph-12) */
  terrace2F: { seatColour: '#2b2b2b' },
  /** 2F lounge glazing: mid blue-grey (dark tinted glass reflecting the sky; a darker base with high metalness rendered black) */
  glass: '#7f8c98',
  // ---------------------------------------------------------------- v2 (2009 dossier; I1-b)
  v2: {
    /** the shutter line: 2.8 m overhang + 0.35 m wall behind the drip line (pp4s2-4); the garage floor runs to garageBack */
    shutter: PIT_PLANNED.shutter,
    /** the garage back wall = shutter − garage.depth (−28.3 − 23.3) */
    garageBack: PIT_PLANNED.shutter - 23.3,
    /** the 1F canopy over the rear shutters: soffit 4.35 → 3.81 m from the garage back to the paddock face, φ0.30 columns every 9.5 m */
    rearCanopy: { from: -51.6, to: -56.4, soffit: [4.35, 3.81] as [number, number], columns: { d: 0.3, pitch: 9.5, lateral: -55.6 } },
    /** 1F / 2F / 3F (pp4s2-4: 2F +5.05, 3F deck +9.85) */
    floors: [0, 5.05, 9.85] as [number, number, number],
    /** the curved roof canopy, (lateral, height) from the back to the front lip (pphi-4); 0.4 m slab, 0.3 m upstand at the front edge */
    canopy: { profile: [[-52, 13.4], [-40, 13.9], [-28, 14.8], [-22.0, 15.3]] as [number, number][], thickness: 0.4, lip: 0.3 },
    /**
     * The garage row (p5spec, pitbox.jpg): 4.75 m pits 23.3 m deep, 4.2 × 3.0 m openings between
     * 0.55 m piers (1.0 m at the block ends), the fascia band y 2.85 → 5.05 on the drip line
     * (2.0 m band + the 2F slab), the ceiling deck at 4.6.
     */
    garage: { depth: 23.3, door: { w: 4.2, h: 3.0 }, pier: 0.55, blockPier: 1.0, boxPitch: PIT_BOX, fascia: [2.85, 5.05] as [number, number], ceiling: 4.6 },
    /** 2F terrace (pitph-12, podium.jpg): 3 stepped rows behind the drip-line glass rail, the lounge glass line behind the steps */
    terrace2F: { rows: 3, tread: 0.85, riser: 0.3, steps: [-25.4, -27.95] as [number, number], rail: { lateral: PIT_GARAGE_FRONT, h: 1.2 }, lounge: -28.6 },
    /** 3F terrace (pp4s2-4: the seats end at the outer wall line): 5 rows from 8.15 at −28.3 up to the 9.85 deck at −32.55, parapet and round columns on −28.0 */
    terrace3F: { rows: 5, frontRow: { y: 8.15, lateral: -28.3 }, deck: { y: 9.85, lateral: -32.55 }, parapet: { lateral: -28.0, h: 1.1 }, columns: { d: 0.35, lateral: -28.0, pitch: PIT_BOX } },
    /** the podium over pits 45–47 (block 12's 2F, podium.jpg): backdrop 7 × 4 m */
    podium: { s: 5632, width: 9.5, backdrop: [7, 4] as [number, number], level: 1 },
    /**
     * The control-tower pod (ct-13, pp4t-4, pphi-4): the final-corner end up to the media
     * section, the glass band 9.6 → 11.4 (its mid line is the nose tip). Top 12.5: pphi-4 (both
     * elevations) and the ct-13 / padoc.jpg photos show the pod's rounded top UNDER the canopy
     * line, level with the 3F — the canopy runs over the pod's shoulder and the nose protrudes.
     */
    controlPod: { sRange: [5554.5, 5590] as [number, number], top: 12.5, band: [9.6, 11.4] as [number, number] },
    /** 2F / 3F straight glass body between the pod and the garage row, no terraces */
    mediaSection: { sRange: [5590, 5625] as [number, number] },
    /** the T1 nose: a 1F + 2F bullet pod (top 11, the 2F glass band 5.2 → 7.4, 8 portholes) past the paddock-information box 88 → 92 (pitbld.jpg) */
    t1Nose: { sRange: [92, 103.3] as [number, number], top: 11, band: [5.2, 7.4] as [number, number], portholes: 8, info: { sRange: [88, 92] as [number, number] } },
    /** seven stair towers (pp4t-4): the six core centres and the control-tower core, 5 (s) × 6.3 (lateral) at −46 … −52.3 — 0.3 m proud of the tiled paddock wall at −52 (no coplanar faces), top 17.0 */
    stairTowers: { s: [5587, 5647.5, 5692.5, 5737.5, 5782.5, 20.5, 65.5], size: [5, 6.3] as [number, number], lateral: [-46, -52.3] as [number, number], top: 17.0 },
    /** the rear spur (pphi-3): the tunnel hall on the paddock face and the 2F bridge over the paddock road */
    spur: { hall: { sRange: [5771.5, 5778.9] as [number, number], lateral: [-56.7, -66] as [number, number], h: 5.0 }, bridge: { sRange: [5773, 5777] as [number, number], lateral: [-52, -84] as [number, number], y: [5.05, 8.55] as [number, number] } },
    /**
     * Pit number plates (paddockrow.jpg, podium.jpg): odd numbering — block b (0 = the T1 end)
     * carries 4b+1 on its first pier and 4b+3 on its third → 1, 3 … 45, 47; the caps carry
     * 49, 51, 53, 55 and the scrutineering band (PIT_TEXTS).
     */
    plates: { perBlock: [1, 3] as [number, number], stride: 4, caps: [49, 51, 53, 55], capText: 'SCRUTINEERING' },
    /** the pods' silver-grey aluminium panels (pitbld.jpg, not white) and the control pod's dark-blue sign band */
    podMat: { color: 0xb9bcc0, metalness: 0.35, roughness: 0.45, signBand: { color: 0x1c2a4a, h: 0.8 } },
    /**
     * The garage interiors (pitbox.jpg, I1-b 3/4): white expanded-metal side walls on the
     * block boundaries, the 1 m team-colour band along the floor's front edge, the white
     * pit-room wall at the back with a rear door per pit (open on the team blocks, a closed
     * shutter on block 12 and the caps), three ceiling strips, and the equipment rows — every
     * piece at lateral ≤ `equipmentFront` so the chase-lens column and the car box stay clear.
     */
    interior: { sideMesh: 2.0, teamBand: 1.0, rearDoor: { w: 3.6, h: 3.0 }, wallT: 0.3, strips: [-31, -38, -45], equipmentFront: -29 },
    /** the roof plant: HVAC boxes on the canopy, the three antennas over the media section, the black lattice pylons of the screens */
    roof: { hvac: { n: 10, size: [2, 1.5, 1.2] as [number, number, number], lateral: -45 }, antennas: { s: 5595, lateral: -40, h: 6, n: 3, pitch: 2 }, pylon: { half: 0.25, panel: 1.0 } },
    /** the podium's chequered backdrop (podium.jpg): three black steps in front of it, the banner on the fascia over the bay */
    rostrum: { steps: [[0, 0.9], [1.3, 0.6], [-1.3, 0.45]] as [number, number][], size: 1.2, lateral: -26.6 },
    /**
     * Terrace seats and guests (I1-b 3/4): seats every `seatPitch` along a row (≈ 32 per 19 m
     * bay); guests take `seats2F` / `seats3F` of them per row at `occupancy` (an expected
     * 22 / 17 seated figures per row), sitting `inset` behind the row's front edge; the podium
     * bay and the media section stay empty.
     */
    guests: { seatPitch: 0.55, seats2F: 26, seats3F: 20, occupancy: 0.85, inset: 0.42 },
    unverified: ['shutter line (OSM = drip line, ±0.8)', 'plate numbering', '3F row geometry', 'stair tower size', 'pod colour 2026', 'pod height 12.5 (pphi-4 read)', 'rear door width', 'rear window bands', 'roof plant layout', 'equipment layout'],
  },
} as const

/**
 * Pit wall between the track and the pit lane — the v2 section pit-lane.ts builds (plan §横断 2,
 * pp4s2-4 / padroad.jpg / west.jpg), laterals from the centreline (negative = pit side), heights
 * above the road plane:
 *
 *   wall −9.05…−9.75 (0.7 m concrete to 1.8; the first 10 m from `concrete[0]` painted white —
 *   the block the 60 / FIRE STATION signs stand on) | walkway −9.75…−11.05 top +0.5 | kerb
 *   −11.05…−11.5 top +0.45 (white, the hoops stand on it) | fast lane −11.5…−16.05 | dashed divider
 *   −16.05 (LINES) | auxiliary lane −16.05…−19.1 with the blue band −19.1…−18.1 and the white edge
 *   line −18.1…−18.0 | concrete work area −19.1…−28.3 (pitApron, road frame).
 *
 * The track face carries the advertising band (`adPanel`) and, above the wall top, the debris
 * mesh (`mesh`: 1.0 m along the box strip, 1.8 m at the entry / exit sections, posts every 4 m).
 * The wall proper is `concrete`; the W-beam guardrail with round posts and a white pipe rail
 * (`wBeam`) continues it to `sRange`. The fixed platform (officials / photographers) and the
 * starter's rostrum (a dark steel cabin on four legs over the walkway, floor +3.0, the stair down
 * to the walkway) sit on the lane side of the wall.
 */
export const PIT_WALL = {
  lateral: -9.4,
  sRange: [5538, 125] as [number, number],
  wallWidth: 0.7,
  wallTop: 1.8,
  /** the concrete wall proper; W-beam guardrail either side (`wBeam`) */
  concrete: [5556, 95] as [number, number],
  /** the white-painted block at the entry end of the concrete wall, metres from `concrete[0]` (padroad.jpg) */
  whiteBlock: 10,
  walkway: { from: -9.75, to: -11.05, y: 0.5 },
  kerb: { from: -11.05, to: -11.5, h: 0.45 },
  /** inverted-U pipe hoops along the kerb: pitch along s, height above the kerb, width along s, tube radius */
  hoops: { pitch: 1.3, h: 1.0, w: 1.2, r: 0.025 },
  /** debris mesh over the track face: height along the box strip, at the entry / exit sections, post pitch, post diameter */
  mesh: { hBox: 1.0, hEnds: 1.8, postPitch: 4, postD: 0.09 },
  /** the track-face advertising band y 0.9 → 1.8 */
  adPanel: [0.9, 1.8] as [number, number],
  /** grey equipment cabinets on the walkway at the block boundaries (one per block + the final-corner end) */
  cabinet: { size: [0.6, 0.9, 1.2] as [number, number, number] },
  /** the fixed platform: deck height, its front parapet above the deck, the pipe rail above the deck */
  platform: { sRange: [31, 69] as [number, number], y: 1.3, parapet: 0.35, rail: 1.1 },
  /**
   * the starter's rostrum: cabin [along s, across, height] over the walkway (centre `lateral`),
   * floor height, leg diameter, stair steps down to the walkway (west.jpg: the cabin stands
   * beside the start gantry's leg on the T1 side)
   */
  rostrum: { s: 5.5, lateral: -10.3, size: [3, 2.4, 2.6] as [number, number, number], floor: 3.0, legD: 0.1, steps: 8 },
  divider: -16.05,
  blueBand: { lat: [-19.1, -18.1] as [number, number], edgeLine: [-18.1, -18.0] as [number, number] },
  /** W-beam guardrail sections (Gr-C profile 0.34 → 0.8, round posts every 2 m, a white pipe rail at 1.1) */
  wBeam: [[5538, 5556], [95, 125]] as [number, number][],
  wBeamRail: { bottom: 0.34, top: 0.8, pipe: 1.1, postPitch: 2, postD: 0.114 },
  /** the wall-top signs (SIGNS mount 'pitWallTop') stand this far above the wall on two posts */
  signPost: 0.4,
  unverified: ['walkway/kerb laterals (±0.5)', 'mesh heights', 'W-beam extent', 'white block length', 'platform parapet / rail', 'rostrum size and s (the cabin is read off west.jpg beside the gantry leg)'],
} as const
/** Team pit-wall stands, one per garage, centred on garageS(i). */
export const PRAT_PERCH = { length: 5.5, width: 1.8, height: 2.6, unverified: ['all dimensions'] }

// ---------------------------------------------------------------- screens, towers, wheel

export interface ScreenDef {
  id: string
  s: number
  lateral: number
  /**
   * Bottom of the panel: above the local track surface for a `roof` screen (the pit building is
   * swept on the road plane), above the DRAWN GROUND (`ground.standAt`) for a `ground` one — the
   * H and P screens stand on relief hills, not on the road plane.
   */
  base: number
  width: number
  height: number
  /** on the pit-building roof (two lattice pylons, I1-b), or on two posts standing on the ground */
  mount: 'roof' | 'ground'
  /** 1 = the `facing` face only, 2 = both ways */
  faces: 1 | 2
  /** which way a single face looks: the track (default) or the paddock behind the pit building */
  facing?: 'track' | 'paddock'
  unverified?: string[]
}

export const SCREENS: ScreenDef[] = [
  // three permanent big screens on the pit building roof (pphi-3: over the T1 group, the
  // centre core and the final-corner group), 8 m behind the drip line on the canopy
  { id: 'pit_t1', s: 23, lateral: -33, base: 17.5, width: 9, height: 5, mount: 'roof', faces: 1, unverified: ['s (±5)', 'size'] },
  { id: 'pit_centre', s: 5742, lateral: -33, base: 17.5, width: 9, height: 5, mount: 'roof', faces: 2, unverified: ['s (±5)', 'size'] },
  { id: 'pit_final', s: 5652, lateral: -33, base: 17.5, width: 9, height: 5, mount: 'roof', faces: 1, unverified: ['s (±5)', 'size'] },
  // the paddock screen on the rear edge of the canopy, facing the team offices (paddockrow.jpg),
  // east of the centre core so its panel and pylons clear the stair tower at 5737.5 (s 5735–5740,
  // up to 17.0); its base sits on the v2 canopy (13.4 at −52)
  { id: 'pit_paddock', s: 5748, lateral: -50, base: 15.0, width: 9, height: 4, mount: 'roof', faces: 1, facing: 'paddock', unverified: ['s (±10)', 'size'] },
  // the four trackside visions on two posts (the West-straight photo shows the type: a dark box
  // on two square legs); H / P stand on the relief hills behind the tyre walls
  { id: 'H', s: 2560, lateral: -50, base: 4, width: 8, height: 4.5, mount: 'ground', faces: 1, unverified: ['position'] },
  { id: 'P', s: 4980, lateral: 52, base: 4, width: 8, height: 4.5, mount: 'ground', faces: 1, unverified: ['position'] },
  { id: 'esses', s: 1230, lateral: -30, base: 4, width: 8, height: 4.5, mount: 'ground', faces: 1, unverified: ['position'] },
  { id: 'T1_inside', s: 470, lateral: -22, base: 4, width: 8, height: 4.5, mount: 'ground', faces: 1, unverified: ['position'] },
]

/**
 * DENSO Leader Tower (2009): 27.5 m black lattice column with the LED timing board on top and a
 * vertical 'SUZUKA CIRCUIT' board on the track face (the Frontstretch-lights photo: the black
 * lattice tower behind the start gantry IS this tower — there is no second S/F tower).
 * OSM way 469636517; facilities-check §6 holds `s`/`lateral` to its centroid within 2 / 1 m.
 */
export const LEADER_TOWER = {
  s: 130, lateral: -10.1, height: 27.5, footprint: [3.6, 1.9] as [number, number], boardHeight: 12, boardWidth: 3.2, colour: '#1c1e22',
  unverified: ['s 130 is the OSM centroid; the tower\'s shadow in .cache/audit/sections/02-t1-pit-exit-aerial.png falls across the pit-exit lane at s ≈ 125–135 and does not resolve it better than ±5 m'],
}

/** サーキットホイール (OSM way 184107083): behind stand S at the Turn-18 exit. */
export const FERRIS_WHEEL = {
  en: [552.4, 157.0] as [number, number],
  s: 5504,
  lateral: 88.5,
  /** ground at the wheel is 7.6 m above the nearest track point (DEM 48.02 m ASL) */
  groundAboveTrack: 7.6,
  height: 50.4,
  diameter: 48,
  gondolas: 36,
  /** compass bearing of the wheel's plane (deg, 0 = north): NW–SE in the aerial, not track-aligned */
  bearingDeg: 135,
  unverified: ['height / diameter (official brochure figures)'],
}

export interface UnderpassDef {
  name: string
  /** what passes under / over the lap: a road (the county road, the service roads); no pedestrian tunnels are mapped */
  kind: 'road'
  /** the OSM way (role 'road' in suzuka-facilities.ts, added with build-facilities.mjs --add-ways); its geometry is never copied here */
  osmWay: number
  /** the stretch of lap it belongs to (the window every world → s mapping uses, R14) */
  sRange: [number, number]
  /** the BARRIERS run whose top carries the 1.1 m parapet railing over the tunnel, and where along it */
  parapet?: { run: string; sRange: [number, number] }
  /**
   * Where the road came out, as I2-b's paddock head frame read it (track frame; the opening
   * looked `facing`). Kept as a record only: since I6 the portals are the CUTS corridors' start
   * caps (cuttings.ts headwalls) and nothing reads this field.
   */
  portal?: { s: number; lateral: number; facing: '+s' | '-s' | '+lateral' | '-lateral' }
  unverified: string[]
  note?: string
}

/**
 * Roads that pass UNDER the lap (OSM tunnel=yes, layer −1) and the one service bridge that passes
 * over the county road's cutting at the chicane. The DEM notches at s ≈ 110–120, 1770–1795 and
 * 5110–5125 are these roads (dem-profile.mjs repaired them on the centreline). The crossover
 * bridge (4676–4713) is not one — it is the lap crossing itself (structures.ts).
 *
 * What is built: structures.ts draws the 1.1 m tube railing on the parapets the roads pass under
 * (the 'dunlop-inside' wall over 1775–1800, the chicane-approach rail over 5110–5125); the cuts
 * themselves are CUTS (I6-a, the field's R6 corridors), their walls and portals cuttings.ts
 * (I6-b), and the chicane service bridge is FOOTBRIDGES 467219905 (a rigid deck over the
 * chicaneLeft corridor — v1's 6 m slab on the grass is gone).
 */
export const UNDERPASSES: UnderpassDef[] = [
  { name: '構内道路トンネル（メインストレート）', kind: 'road', osmWay: 175231859, sRange: [100, 140], portal: { s: 117, lateral: -38, facing: '-lateral' }, unverified: ['a works road, not a spectator tunnel (OSM yh:TYPE 構内道路, 3.0–5.5 m wide); crosses the lap at s 119', 'the south-west portal (117, −38): the way ends at lateral −25.8 under the pit apron and the road runs across the lap (constant s), so the head looks −lateral toward the paddock road it joins at (116, −53); the plan wrote facing −s (I6: CUTS worksSW starts at −28 heading 231, the way\'s own bearing)'] },
  { name: '県道三行庄野線 トンネル（ダンロップ側）', kind: 'road', osmWay: 34096664, sRange: [1760, 1810], parapet: { run: 'dunlop-inside', sRange: [1775, 1800] }, unverified: ['the tunnel way is 2 nodes (s 1779–1790, lateral −37.8 → +17); portal positions from the DEM notch ±5 m', 'the parapet stretch is the run\'s own note (1775–1800)'] },
  { name: '県道三行庄野線 トンネル（シケイン側）', kind: 'road', osmWay: 411291884, sRange: [5095, 5145], parapet: { run: 'chicane-approach-right-a', sRange: [5110, 5125] }, unverified: ['the tunnel way is 3 nodes (s 5112–5129, lateral −8.3 → +15.1); portal positions from the DEM notch ±5 m', 'the railing stands on the guardrail\'s top (the wall the road passes under is not tabled)'] },
  { name: '県道三行庄野線 切通し（シケイン右 ↔ ダンロップ北）', kind: 'road', osmWay: 183309812, sRange: [5080, 5120], unverified: ['the 39 m open cut between the two tunnels, from (5112, −8.3) to (1790, −37.8): depth 5.0 at the Dunlop end, 7 % up (CUTS cut643)'], note: 'the cut is CUTS cut643 (I6); the way spans both legs of the figure-8, so its window is the chicane end only' },
  { name: '県道三行庄野線 進入路（シケイン左）', kind: 'road', osmWay: 34096665, sRange: [5125, 5400], unverified: ['the surface road from the chicane tunnel\'s left portal out past Q1 / R (lateral +15 → +248); its first 60 m are CUTS chicaneLeft, the rest a far-field road (plan §2b)'] },
  { name: 'シケイン側道橋', kind: 'road', osmWay: 467219905, sRange: [5120, 5160], unverified: ['a service bridge over the cutting (OSM bridge=yes, layer 1, s 5131–5147 at lateral +27…+34); width 4 m assumed'], note: 'built as FOOTBRIDGES 467219905 (I6-b)' },
]

/** Water bodies drawn as flat planes from their OSM polygons. */
export const WATER = [
  { name: 'T1 インフィールドの池', osmWay: 184005565 },
  { name: 'T1–T2 調整池', osmWay: 132793884 },
]

// ---------------------------------------------------------------- the cuttings and tunnels (I6, P8)

/**
 * Where a cut daylights: a hand-placed portal in the track frame with the compass bearing (deg,
 * 0 = north, 90 = east) the corridor LEAVES it by, or a node of `osmWay` — the corridor then
 * leaves a `tunnel=yes` way (the county road's and the works road's tunnel ways end at their
 * portals) or follows an open way from that node (the 39 m cut is its own way, the surface road
 * out of the chicane tunnel runs on past Q1).
 */
export type CutPortal = { s: number; lateral: number; heading: number } | { from: 'first' | 'last' }

/**
 * One CUT of the ground field (README 地面の契約 R6, revised at I6): the open approach of a road
 * or footway tunnel under the lap, or the stair pit of a pedestrian tunnel. The field follows the
 * cut inside its CORRIDOR — the strip `halfWidth` either side of a centreline that runs from the
 * portal along the heading with the floor `field(portal) − depth + grade · d`, until the floor
 * meets the ground again (`floor ≥ terrain + RUNOFF_LIFT − 0.2`), the next road frame stops it, or
 * a `level` cut runs `length` metres — the polygon is COMPUTED by ground-field.ts `buildCutField`,
 * never authored. A cut never changes the road-frame planes (road / kerb / deckShoulder /
 * pitLane / pitApron), never the flat strip `CUT_KEEP_OFF` beyond the road edge (a portal
 * closer than `hw + CUT_KEEP_OFF + halfWidth` to the centreline is pushed out to that distance,
 * a corridor point inside a road frame's reach is left out), never the tunnel roof between two
 * portals. `Terrain.heightAt` is untouched (G5 is not concerned). The corridor is always covered
 * by ground rows (GROUND_AREAS `{ cut }` footprints: the road ± `CUT_ROAD_HALF` as asphalt, the
 * whole width as gravel); the retaining walls, headwalls and stairs (cuttings.ts, I6-b) stand
 * on `ground.standY`. Depths and grades are the plan's estimates (the DEM notches dem-profile
 * repaired at s 110–120 / 1770–1795 / 5110–5125 are σ 20 m bare-earth means in the committed
 * grid, too smooth to read a floor from) — every row is unverified.
 */
export interface CutDef {
  /** ASCII id: the `{ cut }` footprints, the corridor names in the smokes and dem-profile --cuts */
  id: string
  name: string
  /** the OSM way (in OSM_FEATURES; §6): the road or footway the cut carries */
  osmWay?: number
  portal: CutPortal
  /** the stretch of lap the cut belongs to: the `{ cut }` rows' window (R14) */
  window: [number, number]
  /** floor depth below the field at the portal (m) */
  depth: number
  /** the floor's rise per metre away from the portal */
  grade: number
  /** half the corridor's width (m); the walls are `wall` */
  halfWidth: number
  wall: 'concrete' | 'slope'
  /** a cut that never daylights: it runs `length` metres (a stair pit) or to the next road frame */
  level?: boolean
  length?: number
  kind?: 'road' | 'stairPit'
  unverified: string[]
  note?: string
}

/** the flat strip beyond the road edge a cut never enters (m) — wider than FLAT_STRIP's 2 m so the strip's own blend keeps a metre */
export const CUT_KEEP_OFF = 2.5
/** the asphalt road inside a corridor: ± this about the centreline where a gravel foot ring fits between it and the wall foot (`cutHasFootRing`), else the foot itself */
export const CUT_ROAD_HALF = 3.5
/** the foot of a cut's wall: the field rises from the floor to the outside over this much of the corridor's edge (smoothstep) */
export const CUT_WALL_FOOT = 0.6
/** the narrowest gravel shoulder (m) between the road ring and the wall foot that gets its own `foot` ring; narrower, the road reaches the foot */
export const CUT_FOOT_RING_MIN = 0.3
/**
 * Whether a cut's corridor carries three ground rings (corridor / foot / road) or two: the
 * county-road cuts (halfWidth 5–5.5) have a 0.9–1.4 m gravel shoulder between the ± 3.5 m road
 * and the 0.6 m wall foot; the 4.0 / 3.5 m ramps and the 3.5 m stair pits have none, so their
 * road / floor ring lands on the foot itself. The foot ring is what gives the raster a column
 * AT the foot: without one the mesh chorded the 0.6 m foot over the whole shoulder and drew a
 * 3–4 m earth bank in front of the retaining wall's face (the I6 review, R2 / V1).
 */
export const cutHasFootRing = (c: Pick<CutDef, 'halfWidth' | 'kind'>): boolean => c.kind !== 'stairPit' && c.halfWidth - CUT_WALL_FOOT - CUT_ROAD_HALF >= CUT_FOOT_RING_MIN
/** a pedestrian tunnel's stair pit (both ends): width across, length along the tunnel, depth */
export const STAIR_PIT = { width: 3.5, length: 7, depth: 3.0 }

const stairPit = (id: string, name: string, osmWay: number, s: number, lateral: number, heading: number, window: [number, number], unverified: string[] = [], depth = STAIR_PIT.depth, length = STAIR_PIT.length): CutDef => ({
  id, name, osmWay, kind: 'stairPit', portal: { s, lateral, heading }, window, depth, grade: 0, halfWidth: STAIR_PIT.width / 2, wall: 'concrete', level: true, length,
  unverified: [`a stair pit at the tunnel way's node (aerial: the portals are not resolved), ${STAIR_PIT.width} × ${length} m, ${depth} m deep`, ...unverified],
})

/**
 * The cuts. Road tunnels first (the county road 三行庄野線 under Dunlop and the chicane approach,
 * the works road under the pit straight, the 200R service tunnel, the 逆バンクトンネル of
 * reno2009-09 under the main straight at the final-corner end), then the six pedestrian
 * tunnels' stair pits. Headings of the hand portals are the tunnel ways' own bearings.
 */
export const CUTS: CutDef[] = [
  // --- 県道三行庄野線: south approach → tunnel under Dunlop → 39 m cut → tunnel under the chicane approach → surface road left of the chicane
  { id: 'loopSouth', name: '県道 ダンロップ南 進入路', osmWay: 34096664, portal: { from: 'first' }, window: [1700, 1860], depth: 5.0, grade: 0.10, halfWidth: 5.0, wall: 'concrete', unverified: ['depth 5.0 / grade 10 % (the tunnel way\'s south node (1779, +17), the ramp descends south of it: aerial 06 "queue of white vans on the south approach")'] },
  // the 39 m open cut between the two tunnels IS way 183309812 (its first node is the Dunlop tunnel's north portal (1790, −37.8),
  // its last the chicane tunnel's south mouth (5112, −8.2)). Not level (the plan wrote grade 0): a level floor 5 m under the
  // Dunlop-side field leaves 7.1 m under the chicane approach and a 2.7 m step inside the 20 m chicane tunnel to chicaneLeft's
  // floor; at 7 % (the plan's loopNorth grade) the two tunnel mouths meet within 0.25 m. The plan's separate 'loopNorth' row
  // (34096664 'last' = the same node, the same heading) would have been this corridor twice, so it is this one row.
  { id: 'cut643', name: '県道 切通し（ダンロップ北 ↔ シケイン右）', osmWay: 183309812, portal: { from: 'first' }, window: [5050, 5180], depth: 5.0, grade: 0.07, halfWidth: 5.5, wall: 'concrete', unverified: ['depth 5.0 at the Dunlop north portal, grade 7 % up to the chicane tunnel (4.5 m under the approach road there)', 'the plan\'s loopNorth (34096664 last node) is this corridor'] },
  { id: 'chicaneLeft', name: '県道 シケイン左 出口路', osmWay: 34096665, portal: { from: 'first' }, window: [5100, 5200], depth: 4.8, grade: 0.08, halfWidth: 5.0, wall: 'concrete', unverified: ['depth 4.8 / grade 8 % north of the chicane tunnel\'s left portal (5129, +15)'] },
  // --- the works road under the pit straight (UNDERPASSES 175231859): the north-east portal is the way's first node, the
  //     south-west one is hand-placed outside the garage apron (−28.7) and the pit-exit-outer wall
  { id: 'worksNE', name: '構内道路トンネル 北東進入路', osmWay: 175231859, portal: { from: 'first' }, window: [60, 180], depth: 5.5, grade: 0.08, halfWidth: 4.0, wall: 'concrete', unverified: ['depth 5.5 / grade 8 % (aerial 01: the NE portal ≈ (118, +25) with its paved approach 469657637)'] },
  //     The south-west ramp meets the paddock road at (116, −53) (UNDERPASSES; aerial 02: the queued approach ends at a T
  //     junction ≈ 25 m from the portal): 4.0 m at 16 % daylights at d ≈ 24 (lateral ≈ −52). The plan's 5.5 m / 8 % ran
  //     66 m through the pit-exit yard, across that road and through the fuel station's forecourt to the T1 pond rim (the
  //     I6 review, R4 / V3); the tunnel floor falls 1.5 m from this portal to the north-east one (57 m at ≈ 2.6 %)
  { id: 'worksSW', name: '構内道路トンネル 南西進入路', osmWay: 175231859, portal: { s: 117, lateral: -28, heading: 231 }, window: [60, 180], depth: 4.0, grade: 0.16, halfWidth: 4.0, wall: 'concrete', unverified: ['the way ends at lateral −25.8 under the garage apron; the portal is set at −28 (the apron reaches −28.7, so the corridor starts where the apron ends) heading 231 = the way\'s own bearing', 'depth 4.0 / grade 16 % (1:6, a works-van ramp) chosen so the ramp meets the paddock road at (116, −53) after ≈ 24 m; 5.5 / 8 % ran 66 m through the paddock road and the fuel station'] },
  // --- the 200R service tunnel: the way is not in the raw cache; the white portal box on the south verge (+13) at s ≈ 3190
  //     (aerial 10-08). The corridor leaves it SOUTH (heading 200, away from the 200R): the road "continues north" INTO the
  //     tunnel, and the ground south of the portal falls 3.5 m within 15 m toward the west straight, so the approach is short
  { id: 'r200service', name: '200R 管理トンネル 南進入路', portal: { s: 3190, lateral: 13, heading: 200 }, window: [3150, 3250], depth: 4.5, grade: 0.08, halfWidth: 3.5, wall: 'concrete', unverified: ['position (aerial 10-08, ±5 m); no OSM way', 'heading 200 (the plan wrote 20, the tunnel\'s own direction under the road)', 'the corridor daylights after ≈ 14 m: the ground drops toward the west straight'] },
  // --- the 逆バンクトンネル (reno2009-09 ⑥: GP Square → under the main straight → the paddock, gentle ramps at both ends).
  //     469010265 is an area=yes polygon, so both portals are hand-placed on the polygon's ends: pedestrian-scale ramps, 3.5 m
  //     deep at 10 % — a 5 m / 8 % ramp on the paddock side could not daylight before the paddock platform's edge on the NIPPO
  //     bisector 38 m out (WHY.reliefJoin's 1.6 m step) and would have run 95 m on into the NIPPO verge
  { id: 'gyakuTunnelR', name: '逆バンクトンネル パドック側ランプ', osmWay: 469010265, portal: { s: 5522, lateral: -32, heading: 225 }, window: [5480, 5560], depth: 3.5, grade: 0.10, halfWidth: 4.0, wall: 'concrete', unverified: ['position (the polygon\'s south-west end, ±3 m)', 'depth 3.5 / grade 10 % (the plan wrote 5.0 / 8 %: see the note)'] },
  { id: 'gyakuTunnelL', name: '逆バンクトンネル GP スクエア側ランプ', osmWay: 469010265, portal: { s: 5513, lateral: 25, heading: 45 }, window: [5480, 5560], depth: 3.5, grade: 0.10, halfWidth: 4.0, wall: 'concrete', unverified: ['position (the polygon\'s north-east end, ±3 m)', 'depth 3.5 / grade 10 % (as the paddock side)'] },
  // --- the pedestrian tunnels: a stair pit at both ends (3.5 × 7 m, 3.0 m deep), headings = the tunnel ways' bearings away from the lap
  stairPit('ped110R_R', '歩行者トンネル 110R 右', 184101996, 2488, -8, 69, [2440, 2540]),
  stairPit('ped110R_L', '歩行者トンネル 110R 左', 184101996, 2484, 10, 249, [2440, 2540]),
  stairPit('ped200R_R', '歩行者トンネル 200R 右', 184105032, 2922, -9, 302, [2870, 2970]),
  stairPit('ped200R_L', '歩行者トンネル 200R 左', 184105032, 2911, 22, 122, [2870, 2970]),
  // 183969196 is ONE tunnel (every node tunnel=yes, layer −1): under the 200R from (3058, −24), west along the fold between
  // the 200R and the west straight, and under the west straight to (4332, −8) — two portals, not four (the plan read its
  // middle nodes (3060, +22) / (4339, +16) as a second tunnel's ends)
  stairPit('ped200Rb_R', '歩行者トンネル 200R〜西ストレート 200R 側', 183969196, 3058, -24, 2, [3010, 3110]),
  stairPit('pedWest_R', '歩行者トンネル 200R〜西ストレート 西ストレート側', 183969196, 4332, -8, 220, [4290, 4390], ['the node at −8.2 is pushed out to hw + 2.5 + 1.75 and beyond the trap wall (BARRIERS west-straight-trap-wall)']),
  stairPit('pedWest2_L', '歩行者トンネル 西ストレート 第 2 左', 184417647, 4548, 9, 29, [4500, 4600]),
  stairPit('pedWest2_R', '歩行者トンネル 西ストレート 第 2 右', 184417647, 4544, -11, 209, [4500, 4600]),
  stairPit('pedNippo_R', '歩行者トンネル NIPPO 右', 467945734, 1547, -30, 55, [1440, 1600]),
  // the ground beside this pit falls 30 % across (the NIPPO corner's outer bank): at 3.0 m its low side stood 1.7 m over the
  // floor, under a 2.5 m opening whose tunnel box would have broken the surface — 4.5 m deep, a 10 m pit for the longer flight
  stairPit('pedNippo_L', '歩行者トンネル NIPPO 左', 467945734, 1483, 30, 205, [1440, 1600], ['depth 4.5 / length 10 (I6-b: the cross-slope beside the portal)'], 4.5, 10),
  stairPit('pedPaddock_R', '歩行者トンネル 最終コーナー パドック側', 469010267, 5529, -32, 220, [5480, 5560]),
  stairPit('pedPaddock_L', '歩行者トンネル 最終コーナー GP スクエア側', 469010267, 5520, 26, 40, [5480, 5560]),
]

// ---------------------------------------------------------------- the footbridges (I6-b)

/**
 * A rigid deck on abutments (cuttings.ts `buildFootbridges`): a footway bridge of the OSM
 * extract (`bridge=yes`, `layer=1`) or the chicane service bridge. The deck is one straight slab
 * between the way's first and last node at ONE height — the greater of the ground under the span
 * + `FOOTBRIDGE.minGap` and, over a cut floor or a road face under the span, that surface +
 * `clearance` — never a ground face (R11); its abutments and the stairs / ramps at its ends stand
 * on `ground.standY`. `ramp` gives that end a 1 : 8 slab instead of stairs ('north' = the end with
 * the smaller world z). Every row is unverified: the aerials resolve a deck line, not a height.
 */
export interface FootbridgeDef {
  osmWay: number
  name: string
  /** the stretch of lap the way's nodes project into (R14) */
  window: [number, number]
  /** deck width across (m) */
  deckW: number
  /** rail (footway) or parapet (road) height over the deck (m) */
  railH: number
  ramp?: 'north' | 'south' | 'both'
  /** the deck line moved across from the OSM way (m, + = the left of the way's first → last direction): the Q2 gaps are 3.1–3.5 m and the ways are digitised off their centres */
  shift?: number
  /** the soffit's headroom over a cut floor or a road face under the span (m) */
  clearance: number
  /** a footway (steel rails, stairs) or a service road (concrete parapets, ramps, a thicker slab) */
  kind: 'foot' | 'road'
  unverified: string[]
}

/** the decks' constants (m): slab thickness by kind, the soffit's minimum gap over the ground under the span, the stairs' riser / tread, the ramps' slope, the rail post pitch */
export const FOOTBRIDGE = { slab: { foot: 0.35, road: 0.6 }, minGap: 0.6, riser: 0.17, tread: 0.3, rampSlope: 1 / 8, railPitch: 2 } as const

export const FOOTBRIDGES: FootbridgeDef[] = [
  // the three footway bridges in the gaps between the Q2 bars (each ≈ 11 m, front to back); nothing but
  // the terrace's ground passes under them, so they ride FOOTBRIDGE.minGap over it with stairs
  { osmWay: 184103165, name: 'Q2 歩道橋 北', window: [5150, 5200], deckW: 2.0, railH: 1.1, ramp: 'north', shift: 0.3, clearance: 4.5, kind: 'foot', unverified: ['height (a deck minGap over the ground under it)', 'the north ramp (aerial 16-13 "footbridge with north ramp", ±)', 'shifted 0.3 m to the centre of the 3.5 m gap between bars 183393102 / 183393101 (O5: the abutments ≥ 0.6 m from both)'] },
  { osmWay: 184103564, name: 'Q2 歩道橋 中', window: [5260, 5310], deckW: 2.0, railH: 1.1, shift: -0.44, clearance: 4.5, kind: 'foot', unverified: ['height', 'stairs at both ends', 'shifted 0.44 m to the centre of the 3.1 m gap between bars 183393101 / 183393103 (the way runs 1.1 m from 183393103)'] },
  { osmWay: 184103565, name: 'Q2 歩道橋 南', window: [5290, 5340], deckW: 2.0, railH: 1.1, clearance: 4.5, kind: 'foot', unverified: ['height', 'stairs at both ends'] },
  // the chicane service bridge over the county road's left exit cut (CUTS chicaneLeft): a 4 m vehicle deck whose
  // soffit keeps `clearance` over the cut floor, ramped at both ends (v2 — v1 was a 6 m slab lying on the grass)
  { osmWay: 467219905, name: 'シケイン側道橋', window: [5110, 5170], deckW: 4.0, railH: 0.9, ramp: 'both', clearance: 4.5, kind: 'road', unverified: ['width 4 m (OSM has none)', 'headroom 4.5 over the cut floor', 'the 1 : 8 ramps at both ends (the aerial shows the deck line only)'] },
]

// ---------------------------------------------------------------- run-off surfaces

/**
 * Lateral bands measured FROM THE CENTRELINE (m); `null` = that surface is absent on that
 * side. Bands come from the OSM `natural=sand` / `landuse=grass` polygons ray-marched along
 * the app centreline (2017 imagery, ±4 m registration — several grass/sand inner edges land
 * inside the nominal asphalt edge, so consumers clamp the start of every band to the local
 * half-width). An unmapped gap between the asphalt edge and the first polygon is asphalt
 * run-off (Suzuka's half-and-half policy). 110R → Spoon has no OSM surface data at all;
 * those rows are photo-derived and UNVERIFIED.
 */
export interface RunoffBand {
  asphalt: [number, number] | null
  grass: [number, number] | null
  gravel: [number, number] | null
}

export interface RunoffZone {
  name: string
  sRange: [number, number]
  left: RunoffBand
  right: RunoffBand
  source: 'osm' | 'photo'
  unverified?: string[]
}

export const RUNOFF_ZONES: RunoffZone[] = [
  // Corrected against the 国土地理院 aerial by the 2026-09 audit: the T1–T2 outside is asphalt to
  // the wall (not gravel), the inside of T1/T2 and the run to the Esses are grass, the Esses and
  // Dunlop traps are separate beds rather than one continuous band, the Spoon bands were on the
  // wrong side, and the lower road's run-off stops before the crossover instead of climbing it.
  { name: 'main straight → T1', sRange: [383, 400], left: { asphalt: [0, 8], grass: [8, 18], gravel: null }, right: { asphalt: [0, 5], grass: [5, 14.5], gravel: null }, source: 'osm' },
  { name: 'T1 entry', sRange: [400, 434], left: { asphalt: [0, 15], grass: [33, 40], gravel: [15, 33] }, right: { asphalt: [0, 5], grass: [5, 14.5], gravel: null }, source: 'osm' },
  { name: 'T1', sRange: [434, 528], left: { asphalt: [0, 33], grass: [33, 40], gravel: null }, right: { asphalt: [0, 5], grass: [5, 14.5], gravel: null }, source: 'osm', unverified: ['the outside is asphalt right up to the wall (aerial); the OSM sand polygon here is the T1-entry bed only'] },
  { name: 'T2', sRange: [558, 680], left: { asphalt: [0, 38], grass: [38, 46], gravel: null }, right: { asphalt: [0, 16], grass: [16, 23.5], gravel: null }, source: 'osm', unverified: ['no gravel on either side of T2 in the aerial'] },
  { name: 'T2 exit → Esses', sRange: [680, 870], left: { asphalt: [0, 8], grass: [8, 30], gravel: null }, right: { asphalt: [0, 3], grass: [3, 20], gravel: null }, source: 'osm' },
  { name: 'T3', sRange: [870, 1000], left: { asphalt: [0, 6], grass: [6, 20], gravel: null }, right: { asphalt: [0, 11], grass: [22, 30], gravel: [11, 22] }, source: 'osm' },
  { name: 'T4–T5', sRange: [1000, 1209], left: { asphalt: [0, 10], grass: [24, 32], gravel: [10, 24] }, right: { asphalt: [0, 4.5], grass: [4.5, 11.5], gravel: null }, source: 'osm' },
  // 逆バンク: the outside bed starts at the trap tip (s ≈ 1266) and ends at ≈ 1450
  { name: '逆バンク entry', sRange: [1209, 1266], left: { asphalt: [0, 4], grass: [4, 18], gravel: null }, right: { asphalt: [0, 7], grass: [27, 32], gravel: [10.5, 27] }, source: 'osm' },
  { name: '逆バンク apex', sRange: [1266, 1330], left: { asphalt: [0, 3], grass: [23, 30], gravel: [3, 23] }, right: { asphalt: [0, 8.5], grass: [27, 32], gravel: [11, 27] }, source: 'osm' },
  { name: '逆バンク exit', sRange: [1330, 1406], left: { asphalt: [0, 5], grass: [30, 40], gravel: [5, 30] }, right: { asphalt: [0, 7], grass: [7, 23.5], gravel: null }, source: 'osm' },
  { name: 'NIPPO T7', sRange: [1468, 1596], left: { asphalt: [0, 7.5], grass: [7.5, 20.5], gravel: null }, right: { asphalt: [0, 5], grass: [16, 30], gravel: [5, 16] }, source: 'osm' },
  { name: 'NIPPO exit', sRange: [1596, 1660], left: { asphalt: [0, 2.5], grass: [2.5, 7], gravel: null }, right: { asphalt: [0, 5.5], grass: [5.5, 25], gravel: null }, source: 'osm' },
  // three separate beds down the Dunlop stretch, with grass between them and the link-road wedge
  { name: 'Dunlop entry trap', sRange: [1660, 1760], left: { asphalt: [0, 2.5], grass: [2.5, 7], gravel: null }, right: { asphalt: [0, 5.5], grass: [44, 50], gravel: [5.5, 44] }, source: 'osm' },
  { name: 'Dunlop trap', sRange: [1760, 1880], left: { asphalt: [0, 2.5], grass: [2.5, 7], gravel: null }, right: { asphalt: [0, 9], grass: [33, 40], gravel: [9, 33] }, source: 'osm' },
  // the gravel is declared 2 m PAST its OSM edge (26): from s 1893 OSM grass 467386918 (a
  // GROUND_AREAS ring, which outranks the band) cuts it on that edge exactly, and a band edge
  // declared on the same line crossed the ring's every few centimetres (column ties, bow-ties)
  { name: 'Dunlop exit trap', sRange: [1880, 1945], left: { asphalt: [0, 2.5], grass: [2.5, 7], gravel: null }, right: { asphalt: [0, 14], grass: [28, 34], gravel: [14, 28] }, source: 'osm' },
  // right grass to 24, the outer edge of OSM grass 467386918 at s 2041–2053 (25.5 left a 1 m strip beyond the ring)
  { name: 'Dunlop exit → Degner', sRange: [1945, 2054], left: { asphalt: [0, 2.5], grass: [2.5, 7], gravel: null }, right: { asphalt: [0, 5.5], grass: [5.5, 24], gravel: null }, source: 'osm' },
  { name: 'Degner 1', sRange: [2054, 2076], left: { asphalt: [0, 4], grass: [9, 14], gravel: [4, 9] }, right: { asphalt: [0, 7.5], grass: [7.5, 25], gravel: null }, source: 'osm' },
  // the inside of Degner 1–2 is grass to the wall: the old 25–40 m band was drawn across the
  // wedge between the two roads and up the crossover embankment
  { name: 'Degner 1 → 2', sRange: [2076, 2207], left: { asphalt: [0, 4], grass: [37, 48], gravel: [4, 37] }, right: { asphalt: [0, 6.5], grass: [6.5, 21.5], gravel: null }, source: 'osm' },
  { name: 'Degner 2', sRange: [2207, 2247], left: { asphalt: [0, 9], grass: [26.5, 37.5], gravel: [9, 26] }, right: { asphalt: [0, 5], grass: [5, 20], gravel: null }, source: 'osm' },
  { name: 'crossover (under)', sRange: [2247, 2290], left: { asphalt: [0, 9], grass: [22, 29], gravel: [7.5, 22] }, right: { asphalt: [0, 5], grass: [5, 16], gravel: null }, source: 'osm' },
  { name: 'crossover → 110R', sRange: [2290, 2492], left: { asphalt: [0, 6.5], grass: [6.5, 14.5], gravel: null }, right: { asphalt: [0, 5], grass: [5, 16.5], gravel: null }, source: 'osm' },
  { name: '110R', sRange: [2492, 2604], left: { asphalt: [0, 12], grass: [12, 24], gravel: null }, right: { asphalt: [0, 8], grass: [8, 16], gravel: null }, source: 'photo', unverified: ['all bands'] },
  { name: '110R → hairpin', sRange: [2604, 2640], left: { asphalt: [0, 10], grass: [10, 24], gravel: null }, right: { asphalt: [0, 8], grass: [8, 16], gravel: null }, source: 'photo', unverified: ['all bands'] },
  { name: 'hairpin', sRange: [2640, 2760], left: { asphalt: [0, 9], grass: [9, 16], gravel: null }, right: { asphalt: [0, 7], grass: [22, 30], gravel: [7, 22] }, source: 'photo', unverified: ['gravel between the road edge and wall 183999765'] },
  { name: 'hairpin exit → 200R', sRange: [2760, 3064], left: { asphalt: [0, 6], grass: [6, 14], gravel: null }, right: { asphalt: [0, 6], grass: [6, 16], gravel: null }, source: 'photo', unverified: ['no gravel on the inside of the 200R (aerial)'] },
  { name: '200R → Spoon', sRange: [3064, 3552], left: { asphalt: [0, 6], grass: [6, 40], gravel: null }, right: { asphalt: [0, 6], grass: [6, 16.5], gravel: null }, source: 'osm' },
  // outside (right) = asphalt then a gravel band at its far edge; inside (left) = grass to the
  // infield hard-standing. The two were the wrong way round.
  { name: 'Spoon 1–2', sRange: [3552, 3830], left: { asphalt: [0, 5], grass: [5, 20], gravel: null }, right: { asphalt: [0, 22], grass: [35, 44], gravel: [22, 35] }, source: 'photo', unverified: ['band widths ±4 m (aerial)'] },
  // I5-a: the left asphalt band to 7.5 — the west-course pit-exit road ring (GROUND_AREAS) starts 1.4 m off the edge, past the green strip, and the band joins the two
  { name: 'west straight', sRange: [3830, 4329], left: { asphalt: [0, 7.5], grass: [7.5, 12], gravel: null }, right: { asphalt: [0, 7], grass: [7, 12], gravel: null }, source: 'osm' },
  { name: 'west straight (gravel)', sRange: [4329, 4521], left: { asphalt: [0, 7], grass: [7, 12], gravel: null }, right: { asphalt: [0, 4], grass: [22, 28], gravel: [4, 22] }, source: 'osm' },
  { name: 'west straight end → bridge', sRange: [4521, 4713], left: { asphalt: [0, 4.5], grass: [4.5, 12], gravel: null }, right: { asphalt: [0, 8], grass: [8, 17], gravel: null }, source: 'osm' },
  { name: '130R', sRange: [4713, 4900], left: { asphalt: [0, 7.5], grass: [7.5, 21], gravel: null }, right: { asphalt: [0, 11], grass: [29, 36], gravel: [11, 29] }, source: 'osm' },
  // the left bed is OSM natural=sand 471430731 (s 4902–5081, inner +8.4…+9.1, outer +16.3…+20.7),
  // with tyre wall 467219902 standing on its outer edge — the app had it as grass
  { name: '130R exit', sRange: [4900, 4990], left: { asphalt: [0, 8.5], grass: [16.5, 24], gravel: [8.5, 16.5] }, right: { asphalt: [0, 10], grass: [20, 30], gravel: [10, 20] }, source: 'osm', unverified: ['the bed tapers out by s ≈ 4960'] },
  { name: '130R → chicane', sRange: [4990, 5081], left: { asphalt: [0, 8.5], grass: [16.5, 24], gravel: [8.5, 16.5] }, right: { asphalt: [0, 4], grass: [4, 26], gravel: null }, source: 'osm' },
  // The three chicane rows' asphalt bands were 0.5-2.5 m past the road edge while the
  // GROUND_AREAS aprons show the tarmac reaching 16-45 m. The band carries the flat strip itself
  // (8 m is hw + 2.5, the strip plus a margin) so no ribbon of dormant grass can show between the
  // kerb and the apron where an apron ring keeps clear of the road edge.
  { name: 'chicane approach', sRange: [5081, 5148], left: { asphalt: [0, 9], grass: [9, 15], gravel: null }, right: { asphalt: [0, 8], grass: [8, 26], gravel: null }, source: 'osm' },
  { name: 'chicane T16–T17', sRange: [5148, 5190], left: { asphalt: [0, 8], grass: [8, 30], gravel: null }, right: { asphalt: [0, 8], grass: [8, 24], gravel: null }, source: 'osm' },
  { name: 'chicane exit', sRange: [5190, 5270], left: { asphalt: [0, 8], grass: [8, 30], gravel: null }, right: { asphalt: [0, 9], grass: [24, 32], gravel: [9, 24] }, source: 'osm' },
  { name: 'T18 exit', sRange: [5270, 5450], left: { asphalt: [0, 17], grass: [25, 32], gravel: [17, 25] }, right: { asphalt: [0, 24], grass: [24, 34], gravel: null }, source: 'osm', unverified: ['the inside is a paved apron out to ≈ 28 m for s 5250–5340'] },
  { name: 'main straight (final corner end)', sRange: [5450, 5500], left: { asphalt: [0, 8], grass: [8, 13.5], gravel: null }, right: { asphalt: [0, 11.5], grass: [11.5, 24], gravel: null }, source: 'osm' },
  { name: 'main straight', sRange: [5500, 383], left: { asphalt: [0, 8], grass: [8, 13.5], gravel: null }, right: { asphalt: [0, 11.5], grass: [11.5, 24], gravel: null }, source: 'osm' },
]

/** Painted run-off aprons on the inside of the slow corners (2026 photos; extents UNVERIFIED). */
export const PAINTED_APRONS: { name: string; sRange: [number, number]; side: Side; width: number; colour: string; pattern: 'chevrons' | 'solid'; unverified: string[] }[] = [
  // Sides corrected by the 2026-09 aerial audit: both aprons are painted on the INSIDE of their
  // corner (the app had the hairpin's on the outside and one patch outside each chicane element).
  { name: 'ヘアピン内側', sRange: [2655, 2740], side: 1, width: 7, colour: COLOURS.apronBlue.mid, pattern: 'chevrons', unverified: ['width', 'hex'] },
  // The chicane's inside is NOT paint: it is artificial turf, and a 15 m lateral band there
  // collapses to a cusp (the chicane's radius is 20-23 m). It is the 'turf' row of GROUND_AREAS.
]

/**
 * One node of a patch outline: an explicit `[s, lateral]` vertex, or a stretch of the road edge
 * on `side`, `off` metres beyond it — the boundary a patch shares with the racing surface, where
 * the (s, lateral) frame is exact.
 */
export type PatchNode =
  | [number, number]
  | { edge: Side; from: number; to: number; off?: number }
  /** an OSM way's world polyline, `offset` metres to the LEFT of its own direction of travel; `verts` = the vertex index range [first, last] to use (an open wall that runs on past the area) */
  | { way: number; offset?: number; reverse?: boolean; verts?: [number, number] }
  /**
   * a vertex digitised in EN metres (the OSM / DEM frame, `Track.enToWorld`): the far side of an
   * area the swept frame cannot describe — beyond a bend's radius (the Spoon infield) or across
   * the figure-8 fold — where `[s, lateral]` would land on the wrong road or fold back on itself
   */
  | { en: [number, number] }


/**
 * ---------------------------------------------------------------- the ground plan's area rows
 *
 * Every paved / unpaved AREA that is not a lateral band of RUNOFF_ZONES is one row here: the
 * chicane aprons and turf island, the paddock aprons, the helipad, the secondary paving, and the
 * gravel beds where the swept frame folds (OSM sand polygons). The ground beside the road is a
 * PARTITION in XZ — one opaque owner per point, decided by `ground-plan.ts` from these footprints
 * and the fixed `PRECEDENCE` list — so a row can only say WHAT is there and WHERE. It cannot say
 * how high it is drawn, in which order, what mesh it becomes or whether it is registered: those
 * words do not exist in this type on purpose (plan rule R14). Two area rows overlap only as a
 * hole (nested) or by `layer` inside the swept verge; a partial overlap outside it is a build
 * error, fixed by splitting the row.
 */
export type GroundAreaKind = 'asphaltArea' | 'turf' | 'gravelArea' | 'grassArea' | 'paddock' | 'helipad' | 'water'

export type GroundFootprint =
  /** a hand / edge / way-node ring (PatchNode, resolved by trackside.ts patchOutline), measured in the row's s window */
  | { ring: PatchNode[]; sRange: [number, number]; straight?: boolean; minGap?: number }
  /** closed OSM way(s) */
  | { osm: number[]; sRange: [number, number]; straight?: boolean; latMax?: number; minGap?: number; /** metres the polygon is grown outward (closes the slivers between OSM polygons that share an edge; pair with a lower `layer`) */ grow?: number }
  /** an OSM polyline swept `width` metres wide (the secondary paving) */
  | { way: number; width: number; sRange?: [number, number] }
  /**
   * several OSM polylines chained end to end (each next way is oriented to meet the chain's
   * end; `verts` = the vertex range of a way to use, `reverse` forces its direction) and swept
   * `width` wide as ONE polygon — a loop road mapped as two or more ways (the driving school's
   * practice loop): a closed chain becomes an annulus. Two sweeps that met at a junction beyond
   * the raster were two world polygons overlapping at one layer, which the mesh cannot trace
   */
  | { ways: { id: number; verts?: [number, number]; reverse?: boolean }[]; width: number; sRange?: [number, number] }
  /** a lateral band on `side` from the centreline (the paddock aprons) */
  | { band: Side; sRange: [number, number]; lat: [number, number] }
  /** a disc in the lap frame (the helipad) */
  | { disc: { s: number; lateral: number; r: number } }
  /**
   * a CUT's corridor (CUTS, ground-field.ts `CutField.corridor`): `road` = the asphalt road
   * inside it (± CUT_ROAD_HALF about the centreline, or out to the wall foot where no gravel
   * shoulder fits — `cutHasFootRing`; a stair pit's floor), `foot` = the floor out to the wall
   * foot (halfWidth − CUT_WALL_FOOT; only where `cutHasFootRing`), `corridor` = the whole width
   * between the walls. The polygon is the cut field's own — computed from the portal, the
   * grade and the ground, never an unclipped `{ way, width }` sweep (that would paint the
   * tunnel roof and the far DEM, and double roads.ts's ribbons)
   */
  | { cut: string; part: 'road' | 'foot' | 'corridor' }

export interface GroundArea {
  name: string
  kind: GroundAreaKind
  footprint: GroundFootprint
  /** paint order among area rows: higher is cut out of lower; default 0 */
  layer?: number
  source: 'osm' | 'photo'
  unverified?: string[]
  note?: string
}

export const GROUND_AREAS: GroundArea[] = [
  // --- the Casio Triangle ------------------------------------------------------------------------
  // The GP road, the escape road, the two-wheel double chicane and the run-off between them are
  // ONE continuous asphalt sheet in the 国土地理院 aerial (misc/audit/sections/16-chicane-q2-aerial.png)
  // and in the user's 2026 Google capture. The outer edge is taken from the two-wheel loop itself
  // rather than hand-read [s, lateral]: the chicane's frame folds past ~16 m on the inside, so a
  // lateral of +45 at s5205 does NOT land where it reads on a map (it is 10 m short of the loop).
  // Beyond the loop's kerb the aerial is warm-toned dirt, so the loop's outer kerb IS the edge.
  {
    name: 'シケイン舗装エプロン', kind: 'asphaltArea', layer: 0, source: 'photo',
    // off 0.25, not the default 0.2: the exit kerb's converging wedge crosses 0.20 exactly where
    // this edge sits, and two boundaries meeting on one value are a bow-tie the snap counts
    footprint: { sRange: [5100, 5300], ring: [{ edge: 1, from: 5126, to: 5262, off: 0.25 }, { way: 183391653, offset: 5.0, reverse: true }] },
    unverified: ['the 5.0 m offset is half the loop width + its kerb, read off the aerial (±1.5 m)'],
  },
  // the right side is paved out to the inner edge of OSM grass 467219900 (−9.9…−14.2). The outer
  // edge is the measured one: walking outward from the road edge in the aerial and taking the
  // first 4 m that stop reading as pavement (the first 1-2 m are the kerb, which reads warm).
  // From s5205 the `chicane T17 exit` run-off band already covers the width, so the row stops there.
  {
    name: 'シケイン舗装エプロン（右）', kind: 'asphaltArea', layer: 0, source: 'photo',
    footprint: {
      sRange: [5120, 5230],
      ring: [
        // the edge run ends 1.5 m past the last hand point: a closing segment along one station's
        // ray gave that ray a hair-thin interval and the ring's column a 1.5 m jump
        { edge: -1, from: 5128, to: 5206.5, off: 0.2 },
        [5205, -12.5], [5195, -13.0], [5185, -14.0], [5175, -16.5], [5165, -16.5], [5155, -15.0],
        [5148, -24.0], [5140, -25.0], [5133, -16.0], [5128, -9.0],
      ],
    },
    unverified: ['aerial at 0.49 m/px, ±2 m'],
  },
  // 人工芝 on the inside of T17 — a real green surface, NOT the turquoise paint the app had. OSM
  // maps it as landuse=grass, and sampling the aerial inside that ring is 99 % green, so the whole
  // polygon is the turf. A higher layer inside the apron: the plan cuts it out of the apron.
  { name: 'シケイン内側 人工芝', kind: 'turf', layer: 1, source: 'osm', footprint: { sRange: [5150, 5270], osm: [467152470], straight: true }, unverified: ['hex'] },
  // --- the pit complex ground (pit-complex.ts used to hard-code these) ---------------------------
  { name: 'パドック（ピットビル裏）', kind: 'paddock', source: 'photo', footprint: { band: -1, sRange: [5536, 100], lat: [-125, -57.3] }, note: 'the flat zone behind the pit building; the garage apron in front of it is a road-frame owner' },
  // the covered walkway behind the garages (pp4s2-4): the 1F rear is an open shutter row under
  // the 3.8 m canopy on its columns, paved at the paddock level up to the garage back wall
  // (PIT_BUILDING.v2.garageBack) — the same kind, so no PRECEDENCE change; kept to the garage
  // row 5590→88 so the T1 pond's rings (s ≥ 90) are not re-cut
  { name: 'ピットビル裏の歩廊', kind: 'paddock', source: 'photo', footprint: { band: -1, sRange: [5590, 88], lat: [-57.3, -51.6] }, note: 'the rear canopy row: open rear doors, φ0.30 columns at −55.6 and the stair towers stand on it' },
  { name: 'ピット出口ヤード', kind: 'paddock', source: 'photo', footprint: { band: -1, sRange: [103, 205], lat: [-52, -24.9] }, note: 'around the former medical room (course_vehicle_base, way 184429429)' },
  { name: 'ヘリパッド', kind: 'helipad', layer: 1, source: 'osm', footprint: { disc: { s: HELIPAD.s, lateral: HELIPAD.lateral, r: HELIPAD.radius } }, note: 'GSI z18 aerial: the H sits beside the former medical room (course_vehicle_base) at the final-corner end' },
  // --- the paddock car parks (I2-a) ---------------------------------------------------------------
  // The wedge between the pit straight and the S-curve / NIPPO leg is paved edge to edge in the
  // 国土地理院 aerial (misc/audit/sections/01-main-straight-pit): the A car park behind the team
  // offices (OSM 184423997, lateral −98…−141), the centre house's round drive, the B car park by
  // the SMSC (469650858 / 469896636) and the S car park with the marquee yard (469896634) beyond
  // the paddock road. The `パドック（ピットビル裏）` band reaches −125 (the relief core's full
  // width, stands.ts paddockZone); these rings carry the paving on from −124 (1 m inside the band,
  // layer 1 above it, so no thread of verge shows between the two) to the paddock road at −144.
  // Every hand ring is a rectangle in the pit straight's frame (the straight has no curvature to
  // fold it), nodes every 20 m so the resampled edges and the shared edges between neighbouring
  // rings coincide vertex for vertex. Beyond the relief core (A0(s) = min(125, D_nippo − 56)) the
  // rows ride the field's DEM fade like the pond banks do (surface-check WHY.infieldRings).
  {
    name: 'A パドック南列', kind: 'paddock', layer: 1, source: 'photo',
    footprint: { sRange: [5600, 5742], straight: true, ring: [[5600, -124], [5620, -124], [5640, -124], [5660, -124], [5680, -124], [5700, -124], [5720, -124], [5742, -124], [5742, -144], [5720, -144], [5700, -144], [5680, -144], [5660, -144], [5640, -144], [5620, -144], [5600, -144]] },
    note: 'the south row of the A car park: OSM 184423997 reaches −141, the bays run to the paddock road',
    unverified: ['outer edge −144 (aerial, ±2 m)'],
  },
  {
    name: 'センターハウス回廊', kind: 'paddock', layer: 1, source: 'photo',
    footprint: { sRange: [5742, 5806], straight: true, ring: [[5742, -124], [5762, -124], [5782, -124], [5806, -124], [5806, -144], [5782, -144], [5762, -144], [5742, -144]] },
    note: 'the round drive in front of the centre house (184430907, round end at −124) between the A and B car parks; the grass island (PADDOCK_ISLAND) sits in it',
  },
  {
    name: 'B パドック', kind: 'paddock', layer: 1, source: 'photo',
    // crosses s = 0: the window [5806, 48] is a forward range (forwardDelta), the nodes are lap-wrapped
    footprint: { sRange: [5806, 48], straight: true, ring: [[5806, -108], [10, -108], [30, -108], [48, -108], [48, -144], [30, -144], [10, -144], [5806, -144]] },
    note: 'OSM 469650858 (s 5802–45, lateral −97…−133) and the building 469650857 beside it; paved on to the paddock road',
    unverified: ['outer edge −144 (aerial, ±2 m)'],
  },
  {
    name: 'B パドック斜め区画', kind: 'paddock', layer: 1, source: 'photo',
    // stops at s 96, the end of the relief core: beyond it the ground fades to the DEM
    footprint: { sRange: [66, 96], straight: true, ring: [[66, -124], [80, -124], [96, -124], [96, -160], [80, -160], [66, -160]] },
    note: 'the 45° bays south-east of the B car park (OSM 469896636 ends at −132; the aerial reads paving to the wall 468336109 at −159)',
    unverified: ['extent (aerial, ±3 m)'],
  },
  // E paddock: the car park inside the pit entry (OSM amenity=parking 474537492, s 5338–5490,
  // lateral −29…−94) — one OSM row, windowed to the pit-entry straight (its far vertices project
  // onto the NIPPO leg in the global frame). OSM stops at s 5490; the paving runs on to the
  // paddock band at 5536 (the helipad compound's approach), so a second ring closes the gap on
  // the polygon's own end edge (vertices 31–32) — the two share that edge vertex for vertex.
  { name: 'E パドック（ピット入口駐車場）', kind: 'paddock', layer: 0, source: 'osm', footprint: { osm: [474537492], sRange: [5340, 5510], straight: true } },
  {
    name: 'E パドック接続', kind: 'paddock', layer: 0, source: 'photo',
    footprint: { sRange: [5480, 5536], straight: true, ring: [{ way: 474537492, verts: [31, 32] }, [5536, -57.3], [5536, -90]] },
    unverified: ['the join between the OSM lot and the band (aerial, ±3 m)'],
  },
  // the S car park (paddock S in the circuit map) with the marquee yard, beyond the paddock road
  // on the natural ground: the OSM polygon itself — a pit-frame rectangle (−146…−222) would cut
  // across the S-curve road at its west corner, the polygon keeps 34 m off that centreline
  { name: 'サービスハウス前庭', kind: 'paddock', layer: 1, source: 'osm', footprint: { osm: [469896634], sRange: [5600, 5770], straight: true }, note: 'OSM 469896634: the S car park in front of the service house (184423960 / 184423962) and the tyre garage' },
  // NOTE (I2-b): a fuel-station apron ring (s 98–122 × −60…−96, paddock, layer 1) was tried
  // here and reverted: it inserted stations on the S-curve leg it backs onto (WHY.infieldRings),
  // which re-rastered the T1 pond's bank (G3 water 8.8 → 10.6 %) and left one bare census
  // sample at the B paddock; the station stands on the relief plane's bare terrain until the
  // P7 raster refinement lets the ring in.
  // the centre house's grass island, a layer over the drive; its concrete kerb is an OBJECT
  // (paddock.ts, GROUND_OBJECTS.islandKerb), not a face
  { name: 'センターハウス芝島', kind: 'grassArea', layer: 2, source: 'osm', footprint: { disc: { s: PADDOCK_ISLAND.s, lateral: PADDOCK_ISLAND.lateral, r: PADDOCK_ISLAND.radius } }, note: 'OSM landuse=grass 469896637' },
  // --- secondary paving: OSM raceways that are not the lap (props.ts used to filter OSM_RACEWAY at runtime)
  // 8 m (was 10): the aerial (misc/audit/sections/07-degner-under) reads an 8 m loop, and the OSM
  // paddock aprons beside it are digitised 3.5–5.8 m from its centreline (I5-a)
  { name: '南コース', kind: 'asphaltArea', source: 'osm', footprint: { way: 153525062, width: 8 }, unverified: ['width (aerial 07 at 0.49 m/px, ±1 m)'] },
  { name: 'カートコース', kind: 'asphaltArea', source: 'osm', footprint: { way: 153525698, width: 7 } },
  // 8 m, not 9: the loop's two legs run 9.5 m apart at their closest and a 9 m sweep drew 4 m² twice
  { name: 'OSM raceway 183393709（最終コーナー外側のループ）', kind: 'asphaltArea', source: 'osm', footprint: { way: 183393709, width: 8 }, unverified: ['width', 'purpose'] },
  // --- the retention basins (BASINS in suzuka-barriers-spec.ts): dry mud in late March -------------
  // The ground inside is sunk by stands.ts facilityRelief (a floor `depth` below the shoreline
  // with a 9 m bank), so the face follows the basin's own shape; the season picks its material
  // (ground-materials.ts: mud, or water for the October palette). s windows measured from the
  // OSM rings: 184005565 spans s 108-233 at lateral −54…−156, 132793884 s 414-543 at −26…−94.
  { name: 'T1 インフィールドの池', kind: 'water', source: 'osm', footprint: { osm: [184005565], sRange: [90, 250], straight: true } },
  { name: 'T1–T2 調整池', kind: 'water', source: 'osm', footprint: { osm: [132793884], sRange: [400, 560], straight: true } },
  // the T1 pond's gravel shore path (I5-c): the OSM ring grown 3 m, half a layer UNDER the
  // water row (its outline stays the shoreline) and over the pit-exit yard that shares the
  // edge, so a 3 m rim track shows round the pond (the aerial reads one). Not a `{ way, width }`
  // annulus: its inner loop 1.5 m inside the shoreline and the shoreline itself were two
  // boundaries the station rays graze at the pond's NE tip (s 149), a column inversion the plan
  // could not resolve (G12 residual 2.15 m).
  // NOTE (I5-c): the same ring round the T1–T2 basin (132793884) is NOT a row: the T1 service
  // road (1420756725) runs along that basin's near edge at s 490–530, and a third boundary
  // within 3 m of the road's and the shoreline left the water face 35 duplicated samples there
  // (G2 water|water, gap 0) in every form tried (grown 2 / 3 m, a 3 m annulus). The road is the
  // rim track on that side; the far side stays the car park's edge.
  { name: 'T1 池の岸道', kind: 'gravelArea', layer: -0.5, source: 'photo', footprint: { osm: [184005565], sRange: [90, 250], straight: true, grow: 3 }, unverified: ['width (aerial 02: a rim service track, ±1 m)'] },
  // the three ponds of the aerial that OSM does not carry (I5-c): the water faces of the BASINS
  // hand rings (one authority — the relief's outline and the drawn face are the same nodes)
  ...BASINS.filter((b) => b.ring && b.sRange).map((b): GroundArea => ({ name: b.name, kind: 'water', source: 'photo', footprint: { ring: b.ring!, sRange: b.sRange!, straight: true }, unverified: b.unverified ?? [] })),
  // the 130R pond's island: a grass disc over the water row (the relief leaves a hole there)
  { name: '130R 池の島', kind: 'grassArea', layer: 1, source: 'photo', footprint: { disc: { s: 4597, lateral: 78, r: 2.5 } }, unverified: ['radius: the dark rectangle mid-pond in aerial 14, ±2 m'] },
  // --- the eyes of the tight bends: ground the swept frame cannot reach (the FOLD cap) ---------
  // The hairpin is a left-hander of 21–24 m radius: its inside frame folds ~7 m out, and the eye
  // beyond was 181 m² of declared band no raster could draw. In the 国土地理院 aerial the eye is:
  // the chevron apron from the road to the low inner wall round the marshal post (the
  // 'hairpin-inside' barrier run, +11…+13.5 m), then bare dirt with sparse grass out to the
  // U-shaped outer wall (OSM 183999771, +17…+22 m). (s, lateral) is exact inside the inner wall
  // (the inside edge's radius is 15–18 m); the outer wall bounds the eye in world XZ, vertices
  // 0–10 (11–16 run on down the approach). The eye is one grass ring from the road edge to the
  // outer wall; the apron is a higher layer cut out of it, stopping 0.3 m short of the wall line
  // so the barrier stands on the dirt, not in the tarmac.
  {
    name: 'ヘアピンの目', kind: 'grassArea', source: 'photo',
    footprint: { sRange: [2590, 2750], ring: [{ edge: 1, from: 2648, to: 2745, off: 0.2 }, { way: 183999771, offset: -0.5, verts: [0, 10] }] },
    unverified: ['dirt with sparse grass at 0.27 m/px; drawn as grass (the season\'s dry look), not as gravel'],
  },
  {
    name: 'ヘアピン内側エプロン', kind: 'asphaltArea', layer: 1, source: 'photo',
    // the inner line every 4 m round the apex: a chord across the 10 m-radius arc cut the corner
    // by 0.5 m and put the wall inside the apron
    footprint: {
      sRange: [2640, 2750],
      ring: [
        { edge: 1, from: 2648, to: 2745, off: 0.2 },
        [2745, 12.2], [2734, 13.2], [2726, 12.4], [2718, 11.6], [2710, 11], [2704, 10.6], [2700, 10.6], [2696, 10.6], [2692, 10.6], [2688, 10.6], [2684, 10.6], [2680, 10.6], [2676, 10.6], [2672, 10.6], [2668, 10.6], [2664, 10.6], [2662, 10.6], [2656, 11.6], [2650, 12.6], [2648, 13.4],
      ],
    },
    unverified: ['the inner wall line is the barrier run\'s samples less 0.4 m (aerial, ±1 m)'],
  },
  // The inside of Degner 1–2 (a right-hander pair) folds 8–9 m out; OSM landuse=grass 467386918
  // is the grass from the road edge to the inner wall (−21…−27 m) and on round the crossover to
  // the upper road (s 4800–4980): one polygon, so its window spans both stretches and the wedge
  // between the two roads beyond the deck zone is its world part.
  { name: 'デグナー内側〜立体交差の芝', kind: 'grassArea', source: 'osm', footprint: { osm: [467386918], sRange: [2035, 4980], straight: true } },
  // OSM natural=sand 467386919 is 130R's outside trap AND the gravel that fills the triangle
  // between the upper road (s 4620–4760), Degner 2's exit (s 2250–2290) and that grass: the
  // crossover wedge beyond both roads' extents (G1 crossoverBare) is its world part.
  // Grown 1 m and one layer under the grass: where OSM's sand and grass polygons share an edge
  // they are digitised with slivers of nobody's ground between them (2.5 m would close the strip
  // below as well, but folds the polygon at its concave corners).
  { name: '130R 外側〜立体交差のグラベル', kind: 'gravelArea', layer: -1, source: 'osm', footprint: { osm: [467386919], sRange: [4600, 4980], straight: true, grow: 1 } },
  // Inside Degner 2 the OSM sand stops 3.5 m short of the OSM grass (s 2197–2248): a strip of
  // nobody's ground the aerial does not resolve (a path?). Its two long sides are the two
  // polygons' own edges — vertices 52–53 of the grass, 37–38 of the sand — so it fits both
  // exactly; its narrow end (s 2188–2197, under a metre) is the grown gravel's. Taken to the
  // polygons' meeting point the strip ended in an acute tip that the station rays hit ambiguously
  // (a 0.7 m column jump, a residual).
  {
    name: 'デグナー2内側の帯（砂と芝の間）', kind: 'gravelArea', layer: -2, source: 'osm',
    footprint: { sRange: [2190, 2260], ring: [{ way: 467386918, verts: [52, 53] }, { way: 467386919, verts: [37, 38], reverse: true }] },
    unverified: ['drawn as gravel; may be a service path'],
  },
  // The inside of T16 (right, 21–23 m radius) folds 3 m out; beyond the paved apron OSM
  // landuse=grass 467219900 (−10…−40 m) is the grass to the tyre barriers. Layer −1: where the
  // OSM polygon and the aerial-read apron overlap (127 m²), the apron's measured edge wins.
  { name: 'シケイン右の芝', kind: 'grassArea', layer: -1, source: 'osm', footprint: { osm: [467219900], sRange: [5140, 5290], straight: true } },
  // --- the service road beside the lower road at the crossover -----------------------------------
  // The multi-level-crossing photo (Commons, from the left embankment): a one-lane asphalt service
  // road runs along the LEFT of the lower road under the bridge, between the road's verge and the
  // abutment / embankment, kerbed white on both edges, a curved-arm lamp and a low wire fence on
  // its outer side (structures.ts builds those). Inside the crossover window (±115 m of sUnder),
  // which every XZ guard excludes; the band ends inside the abutment's ±8.5 (hw 5.32 + 3.0 = 8.3).
  {
    name: '立体交差下の側道', kind: 'asphaltArea', source: 'photo',
    footprint: { band: 1, sRange: [2262, 2378], lat: [5.9, 8.3] },
    unverified: ['width and s extent read off the photo and the aerial (07-degner-under), ±3 m'],
  },

  // ================================================================ the infield ground (I5-a)
  // Everything paved inside the perimeter fence that the tables above did not carry: the OSM
  // highway=service area=yes hard-standings and amenity=parking lots (one OSM polygon per row —
  // `patchOutline` chains an `osm: [a, b]` pair into ONE ring, so only touching polygons may
  // share a row), the hand rings the aerial shows where OSM has nothing, and the service roads
  // (`{ way, width }` sweeps; infield-ground.ts paints their dashed centre lines). Kinds:
  // `paddock` = grey lot asphalt (car parks, aprons, hard-standings; not an A11 apron),
  // `asphaltArea` = the darker service-road tarmac (A11 keeps signs, boards and barriers off it).
  // Rows in the figure-8 fold are windowed (`sRange`) to the stretch they belong to; the far sides
  // of areas beyond a bend's radius are `{ way, verts }` / `{ en }` nodes, never `[s, lateral]`.
  // --- T1 infield and the pit-exit end ------------------------------------------------------------
  // the D paddock: the hard-standing between the pit-exit lane and the C car park (OSM 469065002,
  // 3,450 m²). Its vertices 0–3 lie in the road (the OSM registration is 3 m off there) and the
  // clamped chain zig-zags, so the ring starts at vertex 4 and closes across the pit-exit merge,
  // where the lane wins by precedence anyway
  { name: 'D パドック', kind: 'paddock', source: 'osm', footprint: { sRange: [215, 415], straight: true, ring: [{ way: 469065002, verts: [4, 35] }] } },
  // the two pit-exit aprons beside the course-vehicle base (OSM 469451642 / 469451657): one layer
  // over the ピット出口ヤード band so their OSM edges, not the band's, show
  { name: 'ピット出口エプロン 東', kind: 'paddock', layer: 1, source: 'osm', footprint: { osm: [469451642], sRange: [130, 230], straight: true } },
  // NOTE (I5-a): the west one (469451657, s 101–175, lateral −15…−23) lies wholly under the pit
  // lane and the garage apron (road-frame owners, higher precedence) — measured 0 % ownership in
  // the built plan — so it is not a row
  // the works tunnel's north portal apron on the grandstand side (OSM 469657637, s 71–133, lateral 8–25)
  { name: '構内トンネル北口エプロン', kind: 'paddock', source: 'osm', footprint: { osm: [469657637], sRange: [65, 140], straight: true, latMax: 30 }, unverified: ['use: the paved approach to the works tunnel\'s NE portal (aerial 01, ±3 m)'] },
  // the C paddock car park (OSM amenity=parking 469079400, 8,113 m²) around the T1–T2 retention
  // basin, and the T3 outer lot beside it (184429450): a layer under the basin's water row, whose
  // OSM edge they share
  { name: 'C パドック駐車場', kind: 'paddock', layer: -1, source: 'osm', footprint: { osm: [469079400], sRange: [300, 880], straight: true } },
  { name: 'T3 外側駐車場', kind: 'paddock', layer: -2, source: 'osm', footprint: { osm: [184429450], sRange: [850, 900], straight: true }, note: 'layer −2: shares its NE edge with the C paddock lot' },
  // --- the E hillside and the Dunlop loop -----------------------------------------------------------
  // the service road along the foot of the D / E terraces (OSM 467945733, s 1329–1722, lateral
  // 7–40). The polygon also carries the footway tunnel under NIPPO (vertices 45–49 cross the road
  // to lateral −62): the way nodes skip that spike, closing across its 4 m mouth. Along the NIPPO
  // exit (s 1580–1706) OSM's road-side edge (lateral 6.9–8.4) lies INSIDE the guardrail the app
  // carries there (BARRIERS nippo-exit-inside, 7.6–12): hand nodes 0.6 m behind the rail replace
  // vertices 29–38, so the rail stands at the tarmac's edge, not in it
  {
    name: 'E スタンド下 管理道路', kind: 'asphaltArea', source: 'osm',
    footprint: {
      sRange: [1320, 1730], straight: true,
      ring: [{ way: 467945733, verts: [50, 98] }, { way: 467945733, verts: [0, 28] }, [1706, 11], [1682, 12.6], [1660, 10.6], [1640, 8.6], [1620, 8.2], [1600, 8.7], [1580, 8.7], { way: 467945733, verts: [39, 44] }],
    },
    note: 'OSM highway=service area=yes + tunnel=yes: the tunnel part (vertices 45–49) is left out',
  },
  // the D rear apron on the plateau behind the D stands (OSM 184253118; BANK_OASIS ends at s 1360 for it)
  { name: 'D 裏エプロン', kind: 'paddock', source: 'osm', footprint: { osm: [184253118], sRange: [1355, 1430], straight: true } },
  // the Dunlop inner service road (OSM 467913438, s 1665–1968, lateral 8–27) with its spur to the
  // compound at s 1683–1696 (BANK_E_HILL starts at lateral 28 for it)
  { name: 'ダンロップ内側 管理道路', kind: 'asphaltArea', source: 'osm', footprint: { osm: [467913438], sRange: [1660, 1975], straight: true, latMax: 60 } },
  // the Dunlop-loop paddock apron: five white sheds (OSM 184103155/156/158/159/160), a marquee
  // and the second helipad stand on one asphalt sheet left of the Dunlop → Degner run (aerial 06)
  {
    name: 'ダンロップループ 舗装エプロン', kind: 'paddock', source: 'photo',
    // the end edges are slanted a metre: an edge along one station's ray left the census a
    // 3-sample sliver of the neighbouring grass drawn as paddock at its corner (G1)
    footprint: { sRange: [1840, 2075], straight: true, ring: [[1851, 34], [1849, 82], [2064, 82], [2066, 60], [2030, 45], [2010, 34]] },
    unverified: ['extent (aerial 06 / 15 at 0.49 m/px, ±5 m); extended to s 2065 so the second helipad sits on it'],
  },
  { name: '第 2 ヘリパッド', kind: 'helipad', layer: 1, source: 'photo', footprint: { disc: { s: HELIPAD_2.s, lateral: HELIPAD_2.lateral, r: HELIPAD_2.radius } }, unverified: ['position ±5 m (aerial 06 bottom right; no OSM way)'] },
  // the gravel parking pad beyond the apron's far edge (aerial 06: "light gravel parking pads
  // with cars" at s 1850–1900, lateral 85–100; the far shed 184103156 stands half on it), a
  // 3 m grass strip off the apron ring (I5-b)
  { name: 'ダンロップループ 砂利パッド', kind: 'gravelArea', source: 'photo', footprint: { sRange: [1840, 1910], straight: true, ring: [[1852, 85], [1852, 100], [1900, 100], [1900, 85]] }, unverified: ['extent (aerial 06 at 0.49 m/px, ±5 m)'] },
  // the Degner-east gravel pad under the marquee compound (aerial 07: "a bare light gravel pad
  // ~80×60 m" east of the Degner 2 trap): its inner edge 1.5–2 m behind the trap-back tyre
  // line (BARRIERS degner2-trap-back, +43.6 at s 2110 → +57 at 2150), its far edge at +80 —
  // the circuit ring 775428456 passes lateral 83 at s 2110 and 85 at s 2158 (I5-b)
  { name: 'デグナー東 砂利パッド', kind: 'gravelArea', source: 'photo', footprint: { sRange: [2100, 2170], straight: true, ring: [[2112, 47], [2112, 80], [2160, 80], [2160, 59], [2150, 59], [2140, 57.5], [2130, 55], [2120, 51]] }, unverified: ['extent (aerial 07, ±5 m); the aerial reads 80 × 60 m, the part inside the perimeter ring is 48 × 25–33 m'] },
  // --- the crossover wedge between 130R and the Dunlop → Degner run ---------------------------------
  // OSM maps the whole wedge as one highway=service area (467386920, 11,843 m², 122 vertices in
  // the fold) but the aerial reads dormant grass with gravel islands there; only the service
  // road along the area's Degner-side boundary (vertices 81–87, a 4 m strip offset into the
  // wedge) is paved, windowed to the lower road. A matching strip behind the 130R exit-pocket
  // tyre wall (467219910's back face, windowed to 130R) was tried and dropped: the strip lies
  // in the fold within reach of the Dunlop stretch's rays too, which graze its 4 m end edge
  // and leave a column inversion no station can resolve (G12 residual 46 mm)
  {
    name: 'デグナー側 くさびの管理道路', kind: 'asphaltArea', layer: -1, source: 'osm',
    footprint: { sRange: [1860, 2194], straight: true, ring: [{ way: 467386920, verts: [81, 87], offset: -1 }, { way: 467386920, verts: [81, 87], offset: -5, reverse: true }] },
    unverified: ['the OSM service-area boundary along the Degner side of the wedge; the aerial (07) reads grass beside it'],
  },
  // --- the Casio Triangle's right side --------------------------------------------------------------
  // the chicane right apron as OSM has it (467417584, s 5147–5292): the hand ring above and the
  // OSM grass 467219900 keep their measured edges (layers 0 / −1), this row carries the paving on
  // past s 5227 to the T17 exit where the run-off band used to stop it — only that part
  // (vertices 13–26): the OSM edges along the hand ring left a column inversion the plan could
  // not resolve (G12 residual 1.5 m) when the whole polygon was a layer under it
  { name: 'シケイン右 エプロン延長', kind: 'asphaltArea', layer: -2, source: 'osm', footprint: { sRange: [5140, 5300], straight: true, ring: [{ way: 467417584, verts: [14, 24] }] } },
  // the T17-exit service road behind that grass (OSM 467223464, s 5203–5274, lateral 15–49),
  // shrunk 0.5 m: its north edge is digitised on the grass polygon's edge vertex for vertex, and
  // two coincident boundaries left the plan a column inversion (G12 residual) it could not snap
  { name: 'T17 出口右 管理道路', kind: 'asphaltArea', source: 'osm', footprint: { sRange: [5195, 5285], straight: true, ring: [{ way: 467223464, verts: [7, 43] }] } },
  // --- Spoon and the west course --------------------------------------------------------------------
  // the Spoon infield hard-standing: the inside of the Spoon curve up to the perimeter service
  // road that rings it (OSM 184419756, closed) — the ring is the road's centreline offset 2 m
  // outward, so the road lies on the sheet and its dashed centre line (infield-ground.ts) 2 m in
  // from the edge — EXCEPT over the Spoon entry, s 3421–3555 (the loop's vertices 13–19, which
  // project to +23.8 … +11.1): there the aerial's edge (truth-aerial 11: +15 at 3430 → +25 at
  // 3560–3740 → +37.5 at 3780, "dormant-grass verge between kerb and hard-standing") is 2–7 m
  // further from the road than the loop's centreline, so the ring follows hand vertices on the
  // aerial's line (the I4-c 'spoon-inside-wall' samples: that wall was digitised on this edge,
  // and the aerial shows NO barrier inside Spoon — the row is gone since the I5 review, F5 / V3)
  // and rejoins the loop's vertex 20 across the eye as the loop itself does from vertex 19.
  // ≈ 18,100 m² in one ring (the eye is smaller than the aerial's 250 × 180 m box suggested —
  // the loop closes across it at s 3421 ↔ 4009). The verge between the kerb and the sheet is grass
  // again: infield-smoke samples the edge polyline and requires grass 1.5 m inside it, paving
  // 1.5 m outside it
  { name: 'スプーン インフィールド硬地', kind: 'paddock', source: 'osm', footprint: { sRange: [3400, 4020], straight: true, ring: [{ way: 184419756, verts: [0, 12], offset: 2 }, [3530, 22.5], [3500, 20], [3480, 18.6], [3455, 16.8], [3430, 15], [3405, 13], { way: 184419756, verts: [20, 30], offset: 2 }] } },
  // the west paddock apron NE of the Spoon exit, between the wall 183953793 and the hard-standing
  // (shares the loop road's vertices 21–25 with it, offset the same 2 m)
  {
    name: '西パドック エプロン', kind: 'paddock', layer: 1, source: 'photo',
    footprint: { sRange: [3890, 4110], straight: true, ring: [[3900, 15], { way: 184419756, verts: [21, 25], offset: 2, reverse: true }, [4060, 40], [4100, 15]] },
    unverified: ['extent (aerial 13, ±3 m); the two white sheds and the block stack stand on it (I5-b)'],
  },
  // the west-course pit-exit road merging from the left at s 3915–3970 (aerial 13; no OSM way):
  // the taper between the road edge and the fence 184419761, which converges from +13.6 at s 3916
  // to +8.8 at 3973 (BARRIERS west-straight-left runs on it; the ring stays 0.3 m inside its line)
  {
    name: '西コース ピット出口路', kind: 'asphaltArea', layer: 2, source: 'photo',
    // the edge run starts at s 3937, past the green strip (KERBS 'Spoon exit inside green' to
    // 3935, a decal on the run-off band: a decal across two faces' triangulations reads buried by
    // a few mm), and 1.4 m off the road edge so the band's own asphalt (RUNOFF 'west straight'
    // left [0, 7.5]) joins the two; fence vertices 11–13 (s 3973 → 3939) close it
    footprint: { sRange: [3930, 3980], straight: true, ring: [{ edge: 1, from: 3937, to: 3972, off: 1.4 }, { way: 184419761, verts: [11, 13], offset: 0.3 }] },
    unverified: ['aerial 13: "8 m road merging from the left between 3915–3970 with wall 183953793 on its track side" — read here as the wedge inside the OSM fence (±2 m)'],
  },
  // NOTE (I5-a): the west-course pit apron (OSM highway=service area=yes 468377672, s 4180–4207,
  // lateral −2.5…−9) lies inside the track's own width where OSM is registered 3 m off; after the
  // road's precedence 17 m² would remain (A9 minimum 20), so it is not a row
  // the west-course paddock car parks (OSM amenity=parking 184415332 / 184415335, s 4270–4355,
  // lateral −68…−161): the aerial's "South-course paddock car park" is these two lots
  { name: '西パドック駐車場 東', kind: 'paddock', source: 'osm', footprint: { osm: [184415332], sRange: [4260, 4360], straight: true } },
  { name: '西パドック駐車場 西', kind: 'paddock', layer: 1, source: 'osm', footprint: { osm: [184415335], sRange: [4260, 4360], straight: true }, note: 'layer 1: the two lots share their common edge' },
  // the south course's paddock aprons (OSM 467572919 / 467572920 / 468377676), 190–270 m out,
  // shrunk 1 m: OSM digitised their edges 3.5–5.8 m from the raceway's centreline (the loop is
  // 8 m wide in the aerial, so 南コース above sweeps 8), and a world polygon touching the ribbon
  // is drawn twice with it at one layer (G2) or leaves arcs the mesh cannot trace at another
  // (G12) — a strip of ground separates them from the ribbon instead
  { name: '南コース パドックエプロン 北', kind: 'paddock', source: 'osm', footprint: { osm: [467572919], sRange: [4440, 4580], straight: true, grow: -1 } },
  { name: '南コース パドックエプロン 南', kind: 'paddock', source: 'osm', footprint: { osm: [467572920], sRange: [4440, 4580], straight: true, grow: -1 } },
  { name: '南コース ガレージ前', kind: 'paddock', source: 'osm', footprint: { osm: [468377676], sRange: [4440, 4580], straight: true, grow: -1 } },
  // --- the 200R and the Spoon's outside -------------------------------------------------------------
  // the L yard: the paved lot behind the 200R-exit guardrail (BARRIERS l-yard-edge) where the
  // temporary L stand goes up; its inner edge 0.6 m behind the rail, its east end short of the L stand
  {
    name: 'L ヤード', kind: 'paddock', source: 'photo',
    footprint: { sRange: [3290, 3470], straight: true, ring: [[3300, -15.6], [3330, -21.4], [3400, -34], [3462, -31.5], [3462, -45], [3300, -45]] },
    unverified: ['extent (aerial 11: ~75 × 115 m at −12…−45 over 3300–3480, ±3 m)'],
  },
  // the 5 m service strip behind the 200R right guardrail (aerial 11), leading to the officials' building
  { name: '200R 管理帯', kind: 'asphaltArea', layer: -1, source: 'photo', footprint: { band: -1, sRange: [3200, 3260], lat: [-15, -10] }, unverified: ['aerial 11 (±2 m)'] },
  // the service road behind the Spoon outside walls (184104883 / 184104881: 2–4 m behind their
  // line) and the paved area at −52…−76 under the M stand site (aerial 12)
  {
    name: 'スプーン外側 管理道路', kind: 'asphaltArea', source: 'photo',
    footprint: {
      sRange: [3590, 3780], straight: true,
      ring: [[3600, -44.5], [3630, -44.5], [3660, -44.5], [3680, -45], [3700, -45.5], [3720, -49], [3740, -48.5], [3755, -45], [3770, -41], [3770, -76], [3745, -76], [3720, -76], [3700, -53], [3680, -52], [3660, -51.5], [3630, -51], [3600, -50.5]],
    },
    unverified: ['aerial 12 (±3 m): "a light 4–6 m service road behind the wall (−45…−52), a paved area −52…−76 (3720–3770)"'],
  },
  // the Degner-east car park on the approach to the crossover (OSM amenity=parking 184410563)
  { name: 'デグナー東 駐車場', kind: 'paddock', source: 'osm', footprint: { osm: [184410563], sRange: [2240, 2310], straight: true, latMax: 100 } },
  // the small lot behind the Spoon's outside (OSM amenity=parking 183953784, 269 m², 100 m out)
  { name: 'スプーン駐車場', kind: 'paddock', source: 'osm', footprint: { osm: [183953784], sRange: [3740, 3770], straight: true } },
  // --- the driving school (交通教育センター) behind the A1 stand --------------------------------------
  // its practice loop: the outer loop road is two OSM service ways (1461954354 from its vertex 4
  // — vertices 0–3 are a stub towards the road outside the ring — round to 1489655892, which
  // closes it on that vertex), chained into ONE 8 m annulus (the aerial reads a two-lane practice road); three 20 m
  // skid-pad discs inside it. The three cross roads inside the loop (1461954352 / 1461954353 /
  // 1461954355) are not rows: they meet the loop and each other at junctions, and two world
  // polygons overlapping at one layer leave arcs the mesh cannot trace (G12 untracedArcs)
  { name: '交通教育センター 周回路', kind: 'asphaltArea', source: 'osm', footprint: { ways: [{ id: 1461954354, verts: [4, 19] }, { id: 1489655892 }], width: 8, sRange: [0, 120] }, unverified: ['width'] },
  { name: '交通教育センター スキッドパッド 1', kind: 'paddock', source: 'photo', footprint: { disc: { s: 168, lateral: 88, r: 10 } }, unverified: ['position: the triangular pad NE of the pit exit (aerial 01 / 02), ±8 m'] },
  { name: '交通教育センター スキッドパッド 2', kind: 'paddock', source: 'photo', footprint: { disc: { s: 190, lateral: 80, r: 10 } }, unverified: ['as pad 1'] },
  { name: '交通教育センター スキッドパッド 3', kind: 'paddock', source: 'photo', footprint: { disc: { s: 188, lateral: 106, r: 10 } }, unverified: ['as pad 1'] },
  // --- the service roads (4 m, dashed centre line; SUR_ROADS drops ribbons within 76 m of the lap)
  // the T1-infield road along the inside wall from the pit exit to T3 (1420756725), the road
  // behind the A2 stands (470173099), the perimeter road behind A2 / B / C (184120107) and the
  // road behind the C terrace and D5 (468709099)
  // (layers: the T1 road runs across the D paddock — a later row at the same layer, it wins
  // there — and under the pit-exit apron's layer 1; the perimeter road meets the other two at
  // junctions, so they nest above it)
  { name: '管理道路 T1 インフィールド', kind: 'asphaltArea', source: 'osm', footprint: { way: 1420756725, width: 4, sRange: [140, 890] } },
  { name: '管理道路 A2 裏', kind: 'asphaltArea', layer: 1, source: 'osm', footprint: { way: 470173099, width: 4, sRange: [80, 550] } },
  { name: '管理道路 外周（A2・B・C 裏）', kind: 'asphaltArea', source: 'osm', footprint: { way: 184120107, width: 4 } },
  { name: '管理道路 C・D5 裏', kind: 'asphaltArea', layer: 2, source: 'osm', footprint: { way: 468709099, width: 4, sRange: [570, 1335] } },

  // ================================================================ the cut corridors (I6-a, R6)
  // Every CUT's corridor is ground: the road inside it as asphalt (layer 2) over the floor out
  // to the wall foot as gravel (layer 1, `foot` — only the county-road cuts have the shoulder
  // for it, `cutHasFootRing`) over the whole corridor as gravel (layer 0, the wall foot itself);
  // a stair pit is a pair in asphalt (the whole 3.5 × 7 m pit at layer 1, its floor inside the
  // wall foot at layer 2). The inner rings are what give the raster a column AT the foot of
  // the walls: without one the mesh chorded the 0.6 m foot over the whole shoulder and drew an
  // earth bank in front of the wall (the I6 review, R2 / V1). The polygons come from the cut
  // field (`{ cut }` footprints), so the rows cover exactly the ground the field lowers — a
  // paddock band or a lot the corridor crosses is cut through it: the same layer, these rows later.
  ...CUTS.flatMap((c): GroundArea[] => {
    if (c.kind === 'stairPit') return [
      { name: `${c.name} 階段ピット`, kind: 'asphaltArea', layer: 1, source: 'photo', footprint: { cut: c.id, part: 'corridor' }, unverified: c.unverified },
      { name: `${c.name} 階段ピット床`, kind: 'asphaltArea', layer: 2, source: 'photo', footprint: { cut: c.id, part: 'road' }, unverified: c.unverified },
    ]
    const rows: GroundArea[] = [{ name: `${c.name} 廊下`, kind: 'gravelArea', layer: 0, source: 'photo', footprint: { cut: c.id, part: 'corridor' }, unverified: c.unverified }]
    if (cutHasFootRing(c)) rows.push({ name: `${c.name} 廊下床`, kind: 'gravelArea', layer: 1, source: 'photo', footprint: { cut: c.id, part: 'foot' }, unverified: c.unverified })
    rows.push({ name: `${c.name} 路面`, kind: 'asphaltArea', layer: 2, source: 'photo', footprint: { cut: c.id, part: 'road' }, unverified: c.unverified })
    return rows
  }),
]

// ================================================================================================
// ---------------------------------------------------------------- the infield facilities (I5-b)
// Everything that STANDS inside the perimeter ring 775428456 and is neither the pit complex, the
// paddock, the ops layer, the trackside nor a ground row: the sheds and huts of the Spoon yard,
// the L yard, the west-course pits, the south course, the Dunlop loop, the hairpin, the Degner
// wedge and the T1 infield; the walls, fences and kerbs of the south course; the infield car
// parks; the street lamps of the service roads; the traffic islands' kerbs. Read by
// app/three/infield-ground.ts (`buildInfieldFacilities`), by facilities-check §6 (every osmWay
// in OSM_FEATURES) and §16 O11 (outlines never cross, windowed centroids) / O2 / O5 (the sized
// rows), by scripts/facilities/build-surroundings.mjs (OWNED: an osmWay here is never re-shipped
// as a SUR_BUILDINGS massing) and by scripts/audit/infield-smoke.mjs. Positions are the aerials
// (misc/audit/sections, 0.49 m/px) and the plan's I5 table — everything here is `unverified`.
// ================================================================================================

/**
 * What a facility is drawn as (infield-ground.ts):
 *  - shed / hut / office / garage / pumphouse: a footprint extrusion (the OSM ring, or `size`
 *    at (s, lateral) turned `yaw`° from the road's heading) with a flat cap in the roof colour
 *    (`roof` 'flat' = the pit complex's roof grey, 'blue' / 'brown' / 'red' = coloured, 'gable'
 *    = a pitched roof), the walls in `wall`; a garage carries `doors` roller shutters along its
 *    longest edge nearer the road;
 *  - tower: the west control tower — a 2-level shell with a full-perimeter glass band on the
 *    upper level, a 1.2 m balcony and a roof antenna;
 *  - marquee: a white PVC gable tent (the tent_canopy drop as the near roof);
 *  - tank: a round steel tank `size[0]` m across, `height` tall, with a conical top;
 *  - stack: `count` concrete blocks 1 × 1 × 0.5 in rows of `cols`; tyres: `count` loose tyre
 *    stacks (GROUND_OBJECTS.tyreStack) in rows of `cols`; forklift / toilet: the drop or a box;
 *  - flagpole: `count` 8 m poles along s (4 m pitch) with plain flags;
 *  - mast: a 22 m floodlight lattice mast with three heads (the paddock's masts);
 *  - wall: the OSM way (or a thin `area=yes` wall polygon, collapsed to its centreline) as a
 *    `height` m concrete wall; fence: the OSM polyline as a `height` m chain-link fence with
 *    posts every 3 m; compound: a chain-link enclosure `size` around (s, lateral).
 */
export type InfieldFacilityKind =
  | 'shed' | 'hut' | 'office' | 'marquee' | 'tank' | 'stack' | 'tyres' | 'garage' | 'tower' | 'pumphouse' | 'flagpole' | 'fence' | 'wall' | 'compound' | 'forklift' | 'toilet' | 'mast'

export interface InfieldFacility {
  /** ASCII id: mesh names and the smoke's messages */
  id: string
  name: string
  kind: InfieldFacilityKind
  /** the OSM footprint (buildings) / polyline (walls, fences); its s window for the O11 centroid test */
  osmWay?: number
  sRange?: [number, number]
  /** a hand-placed row: the centre in the track frame … */
  s?: number
  lateral?: number
  /** … its size [along s, across] (m) and the yaw (deg) off the road's heading */
  size?: [number, number]
  yaw?: number
  /** eaves / top height (m) above the local ground */
  height: number
  levels?: number
  /** the roof's shape / finish: 'flat' is the pit complex's grey membrane, 'white' a light plaster / membrane (the sheds the aerial reads as white-roofed; the I5 review, V9) */
  roof?: 'flat' | 'gable' | 'blue' | 'brown' | 'red' | 'white'
  wall?: 'white' | 'grey' | 'corrugated' | 'glass'
  /** stacks / tyres / flagpoles / toilets: how many, in rows of `cols` */
  count?: number
  cols?: number
  /** garages: roller shutters along the longest edge */
  doors?: number
  unverified?: string[]
  note?: string
}

export const INFIELD_FACILITIES: InfieldFacility[] = [
  // --- the Spoon yard and the west paddock (aerials 11 / 13: two white sheds, a block stack, a tyre store) ---
  { id: 'spoon-shed-a', name: 'スプーン ヤード シェッド A', kind: 'shed', s: 3882, lateral: 38, size: [15, 10], height: 4, roof: 'white', wall: 'white', unverified: ['aerial 11 / 13 (±3 m): "two white flat 15×10 m objects (sheds or stacked barrier packs)"'] },
  { id: 'spoon-shed-b', name: 'スプーン ヤード シェッド B', kind: 'shed', s: 3911, lateral: 44, size: [15, 10], height: 4, roof: 'white', wall: 'white', unverified: ['as shed A'] },
  { id: 'spoon-blocks', name: 'スプーン ヤード ブロック積み', kind: 'stack', s: 3993, lateral: 39, size: [4, 3], height: 0.5, count: 12, cols: 4, unverified: ['aerial 11: "a white block stack 3×4" (±2 m); 1 × 1 × 0.5 concrete blocks'] },
  { id: 'spoon-tyres', name: 'スプーン ヤード タイヤ保管', kind: 'tyres', s: 3960, lateral: 30, size: [4, 3.2], height: 0.93, count: 20, cols: 5, unverified: ['position (hairpin.jpg shows loose tyre stacks and a loader behind the fences; the yard is where the aerial has hard-standing)'] },
  { id: 'spoon-forklift', name: 'スプーン ヤード フォークリフト', kind: 'forklift', s: 3970, lateral: 36, size: [3.7, 1.2], yaw: 30, height: 2.1, unverified: ['position / yaw'] },
  // --- the 200R officials' building (aerial 11: a white flat-roofed 20 × 5 m building behind the guardrail's service strip) ---
  { id: 'officials200r', name: '200R 役員室', kind: 'office', s: 3245, lateral: -19, size: [20, 5], height: 3.2, roof: 'flat', wall: 'white', unverified: ['aerial 11 (±2 m); MARSHAL_POSTS 3245 hangs its light panel and camera on the guardrail in front'] },
  // --- the L yard's tank compound (aerial 11: a white round tank ~8 m Ø + two small buildings, OSM 183953734 / 736) ---
  { id: 'l-yard-tank', name: 'L ヤード 円形タンク', kind: 'tank', s: 3410, lateral: -95, size: [8, 8], height: 6, unverified: ['position (aerial 11: the compound at −87…−112 over s 3378–3494; ±10 m)', 'height'] },
  { id: 'l-yard-hut-a', name: 'L ヤード 小屋 A', kind: 'hut', osmWay: 183953734, sRange: [3400, 3600], height: 3, roof: 'flat', wall: 'white', unverified: ['height'] },
  { id: 'l-yard-hut-b', name: 'L ヤード 小屋 B', kind: 'hut', osmWay: 183953736, sRange: [3400, 3600], height: 3, roof: 'flat', wall: 'white', unverified: ['height'] },
  // --- the west-course pits (aerial 13: the control tower, its huts, the paddock garage and toilets) ---
  { id: 'west-garage', name: '西コース パドック ガレージ', kind: 'garage', osmWay: 184415314, sRange: [4250, 4400], height: 4, roof: 'flat', wall: 'white', doors: 6, unverified: ['height', 'the roller doors face the track side (aerial 13 cannot tell)'] },
  { id: 'west-toilets', name: '西コース パドック トイレ', kind: 'hut', osmWay: 184415315, sRange: [4250, 4400], height: 3, roof: 'white', wall: 'white', unverified: ['height'] },
  { id: 'west-hut-c', name: '西コース パドック 小屋', kind: 'hut', osmWay: 184415316, sRange: [4200, 4350], height: 3, roof: 'white', wall: 'white', unverified: ['height'] },
  {
    id: 'west-tower', name: '西コントロールタワー', kind: 'tower', osmWay: 184415318, sRange: [4150, 4300], height: 9, levels: 2, roof: 'flat', wall: 'white',
    unverified: ['9 m / 2 levels (was 12 m / 3 in BUILDINGS; the aerial\'s shadow reads two storeys)', 'the glass band, the 1.2 m balcony and the antenna are the type, not a photo'],
  },
  { id: 'west-hut-a', name: '西コントロールタワー脇 小屋 A', kind: 'hut', osmWay: 184419747, sRange: [4150, 4300], height: 2.8, roof: 'white', wall: 'white', unverified: ['height'] },
  { id: 'west-hut-b', name: '西コントロールタワー脇 小屋 B', kind: 'hut', osmWay: 184419750, sRange: [4150, 4300], height: 2.8, roof: 'white', wall: 'white', unverified: ['height'] },
  { id: 'west-hut-d', name: '西コース ピット出口 小屋', kind: 'hut', osmWay: 184415312, sRange: [4200, 4350], height: 2.8, roof: 'white', wall: 'white', unverified: ['height'] },
  // --- the south course (aerial 14: the 70 × 10 m pit garage, huts, the control hut, walls, chain-link fences) ---
  { id: 'south-garage', name: '国際南コース ピットガレージ', kind: 'garage', osmWay: 184415311, sRange: [4400, 4600], height: 4.5, roof: 'flat', wall: 'white', doors: 12, unverified: ['height', 'L-shaped OSM outline; the doors along its longest edge'] },
  { id: 'south-hut', name: '国際南コース 小屋', kind: 'hut', osmWay: 184415313, sRange: [4400, 4600], height: 3, roof: 'flat', wall: 'white', unverified: ['height'] },
  { id: 'south-control', name: '国際南コース コントロール小屋', kind: 'hut', osmWay: 184410555, sRange: [4450, 4650], height: 3.5, roof: 'flat', wall: 'white', unverified: ['height / use'] },
  { id: 'south-flagpoles', name: '国際南コース 旗竿', kind: 'flagpole', s: 4470, lateral: -200, size: [8, 0.2], height: 8, count: 3, unverified: ['position (the paddock apron\'s edge, aerial 14; ±5 m)'] },
  { id: 'south-wall-a', name: '国際南コース ピット壁', kind: 'wall', osmWay: 468377679, sRange: [4400, 4600], height: 1.0, unverified: ['height (OSM barrier=wall area=yes: a 1 m-wide strip, collapsed to its centreline)'] },
  { id: 'south-wall-b', name: '国際南コース 小屋脇の壁', kind: 'wall', osmWay: 468377683, sRange: [4450, 4600], height: 1.0, unverified: ['height'] },
  { id: 'south-fence-a', name: '国際南コース 柵 A', kind: 'fence', osmWay: 184417654, sRange: [4400, 4650], height: 2.4, unverified: ['height (OSM barrier=fence)'] },
  { id: 'south-fence-b', name: '国際南コース 柵 B', kind: 'fence', osmWay: 184417655, sRange: [4500, 4650], height: 2.4, unverified: ['height'] },
  { id: 'south-fence-c', name: '国際南コース 柵 C', kind: 'fence', osmWay: 468750064, sRange: [4500, 4650], height: 2.4, unverified: ['height'] },
  { id: 'south-fence-d', name: '国際南コース 柵 D', kind: 'fence', osmWay: 468750068, sRange: [4500, 4650], height: 2.4, unverified: ['height'] },
  { id: 'west-paddock-fence', name: '西パドック 柵', kind: 'fence', osmWay: 184415338, sRange: [4250, 4400], height: 2.4, unverified: ['height'] },
  { id: 'south-toilets', name: '国際南コース 仮設トイレ', kind: 'toilet', s: 4530, lateral: -100, size: [5.2, 1.1], height: 2.3, count: 4, cols: 4, unverified: ['position (beside the hut 184415313; the aerial shows "small white huts/tents" there)'] },
  // --- the Dunlop loop (aerial 06: five white flat-roofed sheds, a marquee, a fenced compound; roof 'white' since the I5 review, V9: the pit complex's grey read as plain grey blocks from the heli) ---
  { id: 'dunlop-shed-1', name: 'ダンロップループ シェッド 1', kind: 'office', osmWay: 184103155, sRange: [1840, 1980], height: 4, roof: 'white', wall: 'white', unverified: ['height'] },
  { id: 'dunlop-shed-2', name: 'ダンロップループ シェッド 2', kind: 'office', osmWay: 184103156, sRange: [1840, 1980], height: 4, roof: 'white', wall: 'white', unverified: ['height'] },
  { id: 'dunlop-shed-3', name: 'ダンロップループ シェッド 3', kind: 'office', osmWay: 184103158, sRange: [1840, 1980], height: 4, roof: 'white', wall: 'white', unverified: ['height'] },
  { id: 'dunlop-shed-4', name: 'ダンロップループ シェッド 4', kind: 'office', osmWay: 184103159, sRange: [1840, 1980], height: 4, roof: 'white', wall: 'white', unverified: ['height'] },
  { id: 'dunlop-shed-5', name: 'ダンロップループ シェッド 5', kind: 'office', osmWay: 184103160, sRange: [1840, 1980], height: 4, roof: 'white', wall: 'white', unverified: ['height'] },
  { id: 'dunlop-marquee', name: 'ダンロップループ マーキー', kind: 'marquee', s: 2000, lateral: 45, size: [25, 12], height: 4, unverified: ['aerial 06 (±3 m): a race-weekend temporary'] },
  { id: 'dunlop-compound', name: 'ダンロップループ コンパウンド柵', kind: 'compound', s: 1830, lateral: 40, size: [20, 20], height: 2.4, unverified: ['aerial 06: "a fenced compound with a small grey hut" (±5 m)'] },
  { id: 'dunlop-compound-hut', name: 'ダンロップループ コンパウンド小屋', kind: 'hut', s: 1834, lateral: 44, size: [5, 4], height: 2.8, roof: 'flat', wall: 'grey', unverified: ['the small grey hut inside the compound (aerial 06, ±5 m)'] },
  // --- the hairpin (hairpin.jpg: loose tyre stacks; the floodlight mast beyond the exit) ---
  { id: 'hairpin-tyres', name: 'ヘアピン タイヤ島', kind: 'tyres', s: 2700, lateral: 13.5, size: [3.2, 2.4], height: 0.93, count: 12, cols: 4, unverified: ['position: the plan\'s (2700, +18) lies past the hairpin\'s inside fold (the frame is exact only inside the inner wall\'s 15–18 m radius); moved to +13.5 on the eye\'s dirt 2.5 m behind the hairpin-inside wall'] },
  { id: 'hairpin-mast', name: 'ヘアピン 照明マスト', kind: 'mast', s: 2806, lateral: -44, size: [0.6, 0.6], height: 22, unverified: ['position: the plan\'s (2700, −38) is inside the I stand (s 2692–2738, −26…−48); hairpin.jpg shows the mast beyond the exit, so it stands in the IJ / J gap behind the hairpin-exit-right wall (±15 m)'] },
  // --- the Degner wedge's east side (aerial 07: a white marquee with a fenced compound on a gravel pad) ---
  { id: 'degner-marquee', name: 'デグナー東 マーキー', kind: 'marquee', s: 2146, lateral: 72, size: [20, 12], height: 4, unverified: ['aerial 07 reads 25 × 15 m at (2150, +70); 20 × 12 at +72 so the compound round it stays behind the degner2-trap-back tyres (+57) and inside the perimeter ring (lateral 83–85 there)'] },
  { id: 'degner-compound', name: 'デグナー東 コンパウンド柵', kind: 'compound', s: 2146, lateral: 72, size: [24, 22], height: 2.4, unverified: ['the plan\'s 30 × 30 does not fit between the tyre wall and the ring: 24 × 22'] },
  // --- the T1 infield (aerials 02 / 03: the brown-roofed 2-storey block, the pump house and its fenced pad with a small tank) ---
  { id: 't1-brown', name: 'T1 インフィールド 茶屋根の建物', kind: 'office', s: 275, lateral: -88, size: [30, 20], height: 6.5, levels: 2, roof: 'brown', wall: 'white', unverified: ['aerial 02 (±3 m): "a red/brown-roofed 2-storey building ~30×20 m"; use unknown'] },
  { id: 't1-pump', name: 'T1 池 ポンプ小屋', kind: 'pumphouse', s: 640, lateral: -45, size: [10, 6], height: 3.5, roof: 'flat', wall: 'grey', unverified: ['aerial 02 (±3 m): "a grey pump-house ~10×6 m + fenced gravel pad and a small tank at (s640, −45)"'] },
  { id: 't1-pump-fence', name: 'T1 池 ポンプ小屋の柵', kind: 'compound', s: 640, lateral: -54, size: [8, 8], height: 2.0, unverified: ['the fenced pad beside the pump house (±3 m)'] },
  { id: 't1-pump-tank', name: 'T1 池 小タンク', kind: 'tank', s: 640, lateral: -54, size: [2.4, 2.4], height: 2.5, unverified: ['the small tank inside the fenced pad'] },
  // --- the far OSM huts inside the ring no other table draws (facilities-check §6 / O11) ---
  { id: 'degner-hut', name: 'デグナー左 小屋', kind: 'hut', osmWay: 467591741, sRange: [2050, 2200], height: 3, roof: 'flat', wall: 'white', unverified: ['height'] },
  { id: 'crossover-hut', name: '立体交差手前 小屋', kind: 'hut', osmWay: 468750070, sRange: [2200, 2300], height: 2.8, roof: 'flat', wall: 'white', unverified: ['height'] },
  { id: 't4-hut', name: 'T4–T5 内側 小屋', kind: 'hut', osmWay: 184430910, sRange: [1100, 1250], height: 2.8, roof: 'flat', wall: 'white', unverified: ['height'] },
  { id: 'a1-hut-a', name: 'A1 裏 小屋 A', kind: 'hut', osmWay: 184120098, sRange: [80, 200], height: 3, roof: 'flat', wall: 'white', unverified: ['height'] },
  { id: 'a1-hut-b', name: 'A1 裏 小屋 B', kind: 'hut', osmWay: 184120102, sRange: [40, 160], height: 2.8, roof: 'flat', wall: 'white', unverified: ['height'] },
]

/**
 * The infield car parks (I5-b): PADDOCK_PARKING's convention (paddock.ts `layoutBays`, bays
 * 2.5 × 5, 6 m aisles, back-to-back pairs from lat[0]) over the lots the I5-a ground rows drew
 * (`lot` = the GROUND_AREAS row the block lies on — the bays' face test keeps only the ones on
 * a drawn `paddock` face, so a block may reach past its lot's polygon). A left-side lot is
 * written lat [near, far] with near > far. `occupancy` before the tier budget
 * (`Quality.infield.infieldCars`) scales every block alike. Bays also keep |lateral| ≥ hw + 8
 * (O2), inside the ring, off every INFIELD_FACILITIES footprint and lamp.
 */
export interface InfieldParkingRow extends PaddockParkingRow {
  /** the GROUND_AREAS row (by name) the block is laid out on */
  lot: string
}

export const INFIELD_PARKING: InfieldParkingRow[] = [
  { id: 'C', name: 'C パドック駐車場', lot: 'C パドック駐車場', s: [305, 875], lat: [-32, -112], rows: 10, angle: 0, pitch: 2.5, occupancy: 0.7, note: 'OSM 469079400 round the T1–T2 basin: the bays over the basin, the service road and the grass are dropped by the face test' },
  { id: 'T3', name: 'T3 外側駐車場', lot: 'T3 外側駐車場', s: [869, 883], lat: [-38, -94], rows: 6, angle: 0, pitch: 2.5, occupancy: 0.6 },
  { id: 'Drear', name: 'D 裏エプロン', lot: 'D 裏エプロン', s: [1364, 1420], lat: [112, 64], rows: 6, angle: 0, pitch: 2.5, occupancy: 0.5, note: 'left of the road (OSM 184253118 at lateral 62–114)' },
  { id: 'degnerE', name: 'デグナー東 駐車場', lot: 'デグナー東 駐車場', s: [2240, 2308], lat: [90, 51], rows: 4, angle: 0, pitch: 2.5, occupancy: 0.7, note: 'left of the lower road (OSM 184410563 at lateral 49–92); aerial 07: ~40 cars' },
  { id: 'west', name: '西パドック駐車場', lot: '西パドック駐車場 東', s: [4272, 4353], lat: [-70, -158], rows: 10, angle: 0, pitch: 2.5, occupancy: 0.5, note: 'both lots (184415332 / 184415335); the garage and the huts inside them veto their bays' },
  { id: 'southN', name: '南コース パドック 北', lot: '南コース パドックエプロン 北', s: [4455, 4498], lat: [-219, -266], rows: 6, angle: 0, pitch: 2.5, occupancy: 0.4 },
  { id: 'southS', name: '南コース パドック 南', lot: '南コース パドックエプロン 南', s: [4532, 4564], lat: [-204, -233], rows: 4, angle: 0, pitch: 2.5, occupancy: 0.4 },
  { id: 'spoon', name: 'スプーン駐車場', lot: 'スプーン駐車場', s: [3750, 3760], lat: [-102.5, -111.5], rows: 2, angle: 0, pitch: 2.5, occupancy: 0.3 },
]

/**
 * The street lamps of the infield service roads (I5-b): every `{ way, width }` asphaltArea row
 * of GROUND_AREAS whose way is a service road (role 'road' — not the south course, the kart
 * tracks or the driving school's chained loop) gets the paddock's pole (PADDOCK_LAMPS.height)
 * every `pitch` m, `offset` m off the way's centreline on the side nearer the lap (never on a
 * road-frame face, a water face or outside the ring).
 */
export const INFIELD_LAMPS = { pitch: 40, offset: 3.0, unverified: ['pitch / offset (aerials show cobra-head poles along the T1 infield road; ±10 m)'] } as const

/**
 * The traffic islands' kerbs (I5-b, GROUND_OBJECTS.islandKerb): a `radius` disc walked in the
 * frame's positive sense on a drawn paddock face — the T1 porte-cochère in front of the
 * brown-roofed block and the west paddock apron (the south-course apron's island of I5-b is
 * gone: the aerial shows none, and a kerb ring with plain asphalt inside read as a painted
 * circle from the heli — the I5 review, V10).
 */
export const INFIELD_ISLAND_KERBS: { id: string; name: string; s: number; lateral: number; radius: number; unverified: string[] }[] = [
  { id: 't1-porte', name: 'T1 車寄せの島', s: 305, lateral: -68, radius: 2.5, unverified: ['position: on the C / D paddock paving in front of the brown-roofed block (±5 m)'] },
  { id: 'west-paddock', name: '西パドックの島', s: 4000, lateral: 30, radius: 3, unverified: ['position (the apron between the sheds and the block stack, ±5 m)'] },
]

/**
 * The south course's kerbs (I5-b): red / white kerbs (GROUND_OBJECTS.laneKerb, lanes.ts
 * `sweepKerb`, `kerbMaps`) on both edges of the raceway 153525062 wherever its centreline
 * curves more than `minCurvature` (rad / m) for `minRun` m — the apex sections the aerial (14)
 * shows kerbed. The kerb is centred `inset` m inside the ribbon's edge (the 南コース row sweeps
 * `width`), so both kerbs stand wholly on the drawn face.
 */
export const SOUTH_COURSE_KERBS = { way: 153525062, width: 8, inset: 0.5, minCurvature: 0.015, minRun: 12, unverified: ['which sections carry kerbs (aerial 14 at 0.49 m/px: "red/white kerbs" at the bends)'] } as const

// ================================================================ I5-c: the infield trees
// (I5-b's INFIELD_FACILITIES section goes ABOVE this marker)

/**
 * A row of INFIELD_TREES — the trees inside the perimeter fence the aerial and the photos show
 * and the trackside scatter (vegetation.ts) is no longer allowed to plant there (it stays out
 * of the ring 775428456 except inside the SUR_FOREST woods). Expanded by
 * app/data/infield-trees.ts `infieldTreePlacements` — the runtime and facilities-check O10
 * read the same points. One shape per row: `along` (a line: an OSM way offset to its left, or
 * outward for a closed ring; or lap-frame vertices), `circle`, `rect` (a regular `pitch` grid,
 * or `count` at random) or `disc` (`count` at random). `window` is the s window every placement
 * projects in (the figure-8 fold). Rules the rows obey (O10): |lateral| ≥ hw + 6, off the
 * asphaltArea aprons, outside the stand footprints, inside the ring, ≥ 0.6 m off the barrier
 * lines. A placement that lands on a paved / water face at build time is skipped and counted
 * (`stats.infield['infield-treesSkipped']`); the rows are meant to need none of that.
 */
export interface InfieldTreeRow {
  id: string
  role: TreeRole
  along?:
    | { way: number; offset: number; verts?: [number, number] }
    | { line: [number, number][]; offset?: number }
  circle?: { s: number; lateral: number; r: number }
  /** explicit trees at lap-frame points */
  points?: [number, number][]
  rect?: { s: [number, number]; lateral: [number, number] }
  disc?: { s: number; lateral: number; r: number }
  /** metres between trees along a line / circle / grid (default 8) */
  pitch?: number
  /** ± metres of random offset per tree */
  jitter?: number
  /** trees of a random `rect` / `disc` scatter */
  count?: number
  /** the s window the placements project in (the lap is a figure-8) */
  window: [number, number]
  /** s ranges (in the window's frame) a line row leaves empty — where the way runs through a stand's footprint */
  skipS?: [number, number][]
  /** LOD0 in the camera band regardless of distance (default: heroes inside 120 m of the lap) */
  hero?: boolean
  /** built by the one deferred job of the infield ('infield-south-trees', the south course) instead of the 'trees' job */
  deferred?: 'south'
  note?: string
  unverified: string[]
}

export const INFIELD_TREES: InfieldTreeRow[] = [
  // --- T1 infield and the pit-exit end ---------------------------------------------------------
  // the row of round deciduous crowns along the perimeter service road behind A2 / B / C (aerial
  // 02 / 03: "a row of round deciduous crowns (~8 m) along the service road", "service road +
  // tree belt behind C"): bare keyaki 8 m apart on the outer edge of the 4 m road (+4 from its edge)
  { id: 'perimeter-road-keyaki', role: 'keyakiBare', along: { way: 184120107, offset: -6 }, pitch: 8, jitter: 1, window: [120, 1370], skipS: [[120, 126], [130, 142], [170, 260], [262, 335], [452, 505], [535, 630], [935, 965], [1295, 1350]], unverified: ['species (bare crowns in the autumn mosaic → keyaki in March)', 'side: the belt is read behind the road, away from the track', 'the gaps: the works-road NE cutting corridor (I6-a CUTS worksNE, gravelArea) at s 120–126, the A1 rear hut 184120098 at s 130–142, where the road runs through the A1 / B2 / C / D1–4 stand footprints (OSM), and where the A2 rear road (470173099) runs beside it at s 262–335 / 452–505'] },
  // the tree rings on the banks of the two retention basins (aerial 02 / 04: "earth banks with
  // a ring of trees (round crowns 8–12 m)"): 12 m apart, 6 m outside the shoreline
  // (the gaps: the pit-exit yard's paving at s 158–162 and the two concave corners of the OSM
  // shoreline at s 114–118 / 143–147, where the edge offset lands on the gravel shore path)
  { id: 't1-pond-ring', role: 'keyakiBare', along: { way: 184005565, offset: 6 }, pitch: 12, jitter: 1.5, window: [90, 250], skipS: [[114, 118], [143, 147], [158, 162]], unverified: ['spacing', 'species'] },
  { id: 't1-t2-basin-ring', role: 'budding', along: { way: 132793884, offset: 6 }, pitch: 12, jitter: 1.5, window: [400, 560], unverified: ['spacing', 'species (a budding broadleaf in late March)'] },
  // --- the pit entry and T18 (final.jpg: the trees behind the pit-entry lane and on the T18 mound) --
  // (four vertices: the track bends here, and the one chord 5340 → 5430 resampled in world drifted
  // to lateral −33, onto the E paddock's paving — the grass is −26…−30 at every s of the window)
  { id: 'pit-entry-keyaki', role: 'keyakiBare', along: { line: [[5340, -28], [5370, -28], [5400, -28], [5430, -28]] }, pitch: 8, jitter: 1, window: [5330, 5440], unverified: ['lateral: on the grass between the entry lane\'s run-off (asphaltBand to −24) and the E paddock (paddock from −32; final.jpg, ±3 m)'] },
  { id: 't18-mound-kusunoki', role: 'kusunoki', points: [[5300, -27], [5320, -36], [5330, -36], [5340, -30], [5350, -34], [5360, -30]], window: [5290, 5370], unverified: ['the "mound" of final.jpg: read here as the grass wedge between the two-wheel loop and the E paddock (±5 m); explicit points between the loop\'s lanes'] },
  // --- the hairpin / 130R infield -------------------------------------------------------------
  // the plateau between the lower road and the 130R / hairpin pond: aerial 08 reads it as brown
  // scrub with the pond's banks wooded by deciduous (bare in March) trees — the '130r-pond-keyaki'
  // ring below is the only tree row at the water. The "dense evergreen belt" of aerial 07 is the
  // Degner wedge ('degner-wedge-kusunoki'), not this plateau: the I5-c cedar grid here stood
  // between the hairpin-pond camera and the pond and hid it (the I5 review, V4), so it is gone
  { id: 'hairpin-plateau-scrub', role: 'bush', rect: { s: [2372, 2404], lateral: [36, 60] }, count: 20, window: [2360, 2470], unverified: ['density (aerial 08: "brown scrub")'] },
  // the cherries outside the hairpin (the hairpin cherry zone of TREE_MIX; the aerial reads a
  // clump of round crowns behind the outside wall)
  { id: 'hairpin-outside-sakura', role: 'sakura', disc: { s: 2693, lateral: -53, r: 8 }, count: 5, window: [2670, 2720], unverified: ['position (±5 m), count'] },
  // --- the Dunlop loop and the Degner wedge -----------------------------------------------------
  // bamboo thickets in the Dunlop loop (aerial 06: "bamboo / evergreen thickets"), two clumps
  // (40 / 25 stalks: at 9 / 5 the discs read as a few reeds from the heli, not thickets — the I5 review, V9)
  { id: 'dunlop-bamboo-a', role: 'bamboo', disc: { s: 1950, lateral: 98, r: 10 }, count: 40, window: [1920, 1990], unverified: ['position ±5 m', 'count'] },
  { id: 'dunlop-bamboo-b', role: 'bamboo', disc: { s: 2090, lateral: 47, r: 6 }, count: 25, window: [2060, 2120], unverified: ['position ±5 m (the plan\'s (2080, +40) r 10 reaches the gravel band and the fence; brought in)', 'count'] },
  // the camphor band on the Degner wedge (aerial 07: "dense evergreen belt" between Degner and
  // the hairpin approach), inside the fence: the plan's +85…+100 lies outside the ring there,
  // and the band's west half (s 2110–2160) is the marquee's gravel pad and its compound
  // (INFIELD_FACILITIES degner-marquee / degner-compound, the pad row 'デグナー東 砂利パッド' s
  // 2112–2160) — the trees stand east of them (the I5 review, F3: two camphors grew through the tent)
  { id: 'degner-wedge-kusunoki', role: 'kusunoki', rect: { s: [2158, 2182], lateral: [74, 82] }, pitch: 8, jitter: 1.5, window: [2090, 2190], unverified: ['extent (aerial 07, ±5 m): east of the compound; the plan\'s +85…+100 belt is outside the ring'] },
  // --- the gyaku-bank outside (the S-curve cherry zone of TREE_MIX) --------------------------------
  { id: 'gyaku-bank-sakura', role: 'sakura', disc: { s: 1127, lateral: 47, r: 5 }, count: 6, window: [1100, 1160], unverified: ['position (±5 m): in the gap between the D5 and D1–4 stands (the plan\'s (1300, +60) is inside the D1–4 footprint, which runs s 1141–1391)', 'count'] },
  // --- the west straight and 130R ponds -----------------------------------------------------------
  // the wooded bank between the west-course pit lane and the west-straight pond (aerial 13:
  // "wooded banks (mixed)"): pines and bare keyaki 10 m apart, 6 m inside the shore — the part of
  // the shore that lies inside the perimeter ring (the pond itself is outside it)
  { id: 'west-pond-shore-matsu', role: 'matsu', along: { line: [[4150, -39], [4180, -39], [4210, -39], [4235, -40]] }, pitch: 10, jitter: 1.5, window: [4140, 4250], unverified: ['species mix', 'spacing'] },
  { id: 'west-pond-shore-keyaki', role: 'keyakiBare', along: { line: [[4155, -34], [4185, -34], [4215, -34]] }, pitch: 20, jitter: 2, window: [4140, 4250], unverified: ['species mix', 'spacing'] },
  // the bare trees round the 130R pond, 6 m off its 12-gon shore (r 21 + 6)
  { id: '130r-pond-keyaki', role: 'keyakiBare', circle: { s: 4597, lateral: 78, r: 27 }, pitch: 12, jitter: 1.5, window: [4540, 4640], unverified: ['spacing (aerial 14: "trees" round the pond)'] },
  // --- the south course (the one deferred job of the infield: 'infield-south-trees') ------------
  // the plantation behind the south course's paddock and along its far side (aerial 14: "dense
  // mixed forest" south of the course inside the fence)
  { id: 'south-course-sugi', role: 'sugi', rect: { s: [4430, 4590], lateral: [-300, -286] }, pitch: 7, jitter: 1.5, window: [4400, 4620], skipS: [[4468, 4482], [4546, 4558]], deferred: 'south', unverified: ['extent (aerial 14, ±10 m); the gaps are where the loop road crosses the band'] },
  { id: 'south-course-hinoki', role: 'hinoki', rect: { s: [4430, 4458], lateral: [-260, -244] }, pitch: 8, jitter: 1.5, window: [4400, 4620], deferred: 'south', unverified: ['extent (aerial 14, ±10 m); ends before the north paddock apron 467572919 (paddock from s ≈ 4463)'] },
]
