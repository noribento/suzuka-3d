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
  /** lateral band covered by the slab */
  lateral: [number, number]
  /** s range when shorter than the stand */
  sRange?: [number, number]
  /** soffit / top heights above the local track surface (m) */
  soffit: number
  top: number
  /** forward cantilever beyond the supporting frame line (m) */
  overhang: number
  /** primary truss / fin pitch along s (m) */
  finPitch: number
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
   * Build the stand straight along its OSM front edge instead of sweeping it in track
   * coordinates: vertex ranges [start, end] of the footprint ring (walking it forward) that form
   * the front and the back edge. A stand on the inside of a bend whose rows lie beyond the
   * bend's radius (C's Esses end against T3, E-2 inside NIPPO) folds over itself when swept in
   * (s, lateral); the chord frame keeps the rows parallel to the real, straight front. Heights
   * still ride on the road (the road height at the lap position mapped linearly from sRange
   * onto the chord), and the s-keyed fields stay in track coordinates for the fences, the tree
   * exclusion and the checks.
   */
  chord?: { front: [number, number]; back: [number, number] }
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
  apronTurquoise: { lit: '#3fb3b0', mid: '#2f9a98', shade: '#237574' },
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
    roof: { lateral: [36, 59.3], sRange: [5574, 5760], soffit: 30, top: 32, overhang: 7.5, finPitch: 12 }, // 18 × 186 m (mejibo/Takenaka); heights UNVERIFIED
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
    sRange: [65, 130],
    side: 1,
    lateralFront: 22,
    lateralBack: 40,
    structure: 'scaffold',
    tiers: [{ id: 'A1-temp', rows: 20, ...SCAFFOLD_BENCH, colour: '#9a9a96' }],
    aisles: { pitch: 4.3, width: 1.0 }, // 15 blocks A–O, 12 seats wide
    frontHeight: 2.5,
    platform: 'Elevated scaffold stand behind/above the permanent A1 toward the last corner',
    permanent: false,
    fence: 'single',
    unverified: ['position (not in OSM; from map.png)', 'lateral band', 'front height'],
  },
  {
    id: 'A2',
    name: 'A2 メインストレートエンド（仮設）',
    osmWays: [],
    sRange: [255, 390],
    side: 1,
    lateralFront: 21,
    lateralBack: 36,
    structure: 'scaffold',
    tiers: [{ id: 'A2', rows: 15, ...SCAFFOLD_BENCH, colour: '#9a9a96' }],
    aisles: { pitch: 9, width: 1.0 },
    frontHeight: 2.0,
    platform: 'Scaffold behind the wall at +14..+19; taller toward Turn 1 (≤10 m); ends before the T1 gravel starts at s 434',
    permanent: false,
    fence: 'single',
    unverified: ['position (not in OSM; from map.png)', 'rows', 'height'],
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
    chord: { front: [0, 11], back: [12, 27] },
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
    lateralFront: [[1038, 37], [1101, 40], [1103, 46.5], [1113, 47]],
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
    sRange: [1414, 1562],
    side: 1,
    // E-1 / E-2 sit side by side ALONG the track on one hillside terrace (Car Watch 2010, seat_e.html):
    // E-2 at the 逆バンク end where the hill is 12 m above the track, E-1 at the NIPPO end near
    // track level. E-2 lies on the inside of the NIPPO bend (R 49–109 m) with its rows 40–75 m
    // from the centreline — beyond the bend's radius, where an (s, lateral) sweep folds over
    // itself — so it is built straight along its OSM front (`chord`); the (s, lateral) figures
    // below serve the fences, the tree exclusion and the checks
    lateralFront: [[1414, 62.5], [1515, 53.5], [1556, 40], [1562, 36]],
    lateralBack: [[1414, 64], [1433, 80], [1515, 75.5], [1562, 60]],
    chord: { front: [11, 15], back: [16, 21] },
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
    sRange: [1568, 1668],
    side: 1,
    // OSM outline smoothed: the notches at s ≈ 1583–1589 are stairs, not seating
    lateralFront: [[1568, 35], [1600, 24], [1633, 18], [1668, 19]],
    lateralBack: [[1568, 55.5], [1600, 44.5], [1633, 38.5], [1668, 39.5]],
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
    sRange: [2500, 2617],
    side: -1,
    lateralFront: [[2500, -13], [2533, -13], [2573, -16.5], [2617, -18.5]],
    lateralBack: [[2500, -14], [2521, -38], [2533, -46], [2605, -41], [2617, -33.5]],
    structure: 'scaffold',
    tiers: [{ id: 'H', rows: 12, ...SCAFFOLD_BENCH }],
    aisles: { pitch: 10, width: 1.0 },
    frontHeight: 2.0,
    platform: 'Temporary stand on the outside of 110R directly behind wall 184004014 (−10.3..−13.5)',
    permanent: false,
    fence: 'single',
    unverified: ['identification (unnamed in OSM; H per the ticket map)', 'front clearance (OSM face 6.5 m from the track edge)', 'rows', 'height'],
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
    frontHeight: 1.5,
    platform: 'Two parallel bars on the inside (left) of 130R — the old code had this stand on the wrong side',
    permanent: true,
    fence: 'single',
    unverified: ['rows', 'heights', 'which bar is temporary'],
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
    sRange: [5350, 5430],
    side: 1,
    lateralFront: 60,
    lateralBack: 72,
    structure: 'frame',
    tiers: [],
    aisles: null,
    frontHeight: 6,
    platform: '2019 roofed box terrace (Course View Terrace) behind R — separate footprint, not in OSM',
    enclosure: { floors: [6], glass: COLOURS.glassVip.mid, framePitch: 4, roofTop: 11 },
    permanent: true,
    fence: 'none',
    unverified: ['position (confirm on map.png / GSI)', 'size', 'height'],
  },
]

export function standById(id: string): StandDef | undefined {
  return STANDS.find((s) => s.id === id)
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
  unverified?: string[]
}

export const BUILDINGS: BuildingDef[] = [
  { id: 'team_offices', name: 'チームオフィス', osmWay: 184423963, height: 8, levels: 2, anchor: { s: 5670, lateral: -88 }, colour: COLOURS.pitFacade.mid, roof: 'flat', unverified: ['height'] },
  { id: 'medical_centre', name: '医務室（ヘリポート隣接）', osmWay: 184429429, height: 4.5, levels: 1, anchor: { s: 165, lateral: -40 }, colour: COLOURS.pitFacade.mid, roof: 'flat', unverified: ['height'] },
  { id: 'dunlop_office', name: '日本ダンロップ鈴鹿事務所', osmWay: 184423961, height: 7, levels: 2, anchor: { s: 5690, lateral: -182 }, colour: '#d9d6cf', roof: 'flat', unverified: ['height'] },
  { id: 'west_tower', name: '西コントロールタワー', osmWay: 184415318, height: 12, levels: 3, anchor: { s: 4225, lateral: -20.4 }, colour: COLOURS.pitFacade.mid, roof: 'flat', unverified: ['height'] },
  { id: 'circuit_plaza', name: 'CIRCUIT PLAZA', osmWay: 308666565, height: 9, levels: 2, anchor: 'terrain', colour: '#e4e0d6', roof: 'flat', unverified: ['height'] },
]

/** Helipad next to the medical centre (H mark circle). Position UNVERIFIED (from the 2009 dossier: "医務室横"). */
/** GSI z18 aerial: the H sits beside the medical centre at the final-corner end of the pit building. */
export const HELIPAD = { s: 5566, lateral: -78, radius: 8 }

// ---------------------------------------------------------------- pit complex

/** Pit-lane face of the pit building (m from the centreline, right side). OSM way 184422099. */
export const PIT_GARAGE_FRONT = -25.1
/** One F1 garage = 4 boxes × 7.083 m. */
export const PIT_GARAGE_PITCH = 28.33
/** Centre of garage 1 (the Turn-1 / pit-exit end); garage G centre = PIT_GARAGE1_S − (G−1)·pitch. */
export const PIT_GARAGE1_S = 5887.6
/** 11 team garages + 1 empty bay under the podium (FIA / Pirelli). */
export const PIT_GARAGE_COUNT = 12
/** Planned CIRCUIT.pit values (phase 4 updates suzuka.ts; facilities-check compares them). */
export const PIT_PLANNED = { garageFront: PIT_GARAGE_FRONT, boxSpacing: PIT_GARAGE_PITCH, laneOffset: -15.0, laneWidth: 10, wallOffset: -9.4 } as const

/** Centre s of the garage at `index` (0 = McLaren at the T1 end), wrapped to [0, L). */
export function garageS(index: number): number {
  const L = CIRCUIT.officialLength
  return (((PIT_GARAGE1_S - index * PIT_GARAGE_PITCH) % L) + L) % L
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

export const PIT_BUILDING = {
  osmWay: 184422099,
  /** straight front face; the rounded end caps extend to 5554.5 / 103.3 */
  sRange: [5557, 99] as [number, number],
  front: PIT_GARAGE_FRONT,
  back: -56.7,
  /** rear stair/service spur */
  spur: { sRange: [5771.5, 5778.9] as [number, number], lateral: [-56.7, -80.7] as [number, number] },
  /** floor levels above the local pit-lane apron (follows the 2.8 % gradient) — UNVERIFIED (photogrammetry) */
  floors: [0, 7.8, 12.3],
  roofTop: 15.5,
  garage: { doorWidth: 6.1, doorHeight: 4.1, pier: 0.95, boxPitch: 7.083, depth: 15.4, fasciaHeight: 3.5 },
  /** 2F terrace: 100 black seats × 11 rooms cantilevered over the pit lane */
  terrace2F: { rows: 4, seatColour: '#2b2b2b' },
  podium: { s: 5579, width: 9.5, backdropHeight: 4.5, level: 1 },
  // the podium recess (garage 12, s≈5574–5579) sits right beside the glazed core in the podium
  // photo, so the pod ends at the recess rather than at the earlier 5605 estimate
  controlPod: { sRange: [5554, 5574] as [number, number], top: 19 },
  colour: COLOURS.pitFacade.mid,
  /** 2F lounge glazing: mid blue-grey (dark tinted glass reflecting the sky; a darker base with high metalness rendered black) */
  glass: '#7f8c98',
  unverified: ['all heights (±3 m)', 'podium s (±8 m)', 'control pod length'],
} as const

/** Pit wall between the track and the pit lane. */
export const PIT_WALL = { lateral: -9.4, height: 1.05, topWidth: 0.4, fenceHeight: 2.2, sRange: [5538, 125] as [number, number], unverified: ['height', 'fence extent'] }
/** Team pit-wall stands, one per garage, centred on garageS(i). */
export const PRAT_PERCH = { length: 5.5, width: 1.8, height: 2.6, unverified: ['all dimensions'] }

// ---------------------------------------------------------------- screens, towers, wheel

export interface ScreenDef {
  id: string
  s: number
  lateral: number
  /** bottom of the panel above the local track surface (m) */
  base: number
  width: number
  height: number
  /** faces the track (default) or both ways */
  doubleSided?: boolean
  unverified?: string[]
}

export const SCREENS: ScreenDef[] = [
  // three permanent big screens on the pit building roof at ≈ ¼ / ½ / ¾ of the 340 m strip
  { id: 'pit_t1', s: 10, lateral: -30, base: 17.5, width: 9, height: 5, unverified: ['s', 'size'] },
  { id: 'pit_centre', s: 5722, lateral: -30, base: 17.5, width: 9, height: 5, doubleSided: true, unverified: ['s', 'size'] },
  { id: 'pit_final', s: 5637, lateral: -30, base: 17.5, width: 9, height: 5, unverified: ['s', 'size'] },
  { id: 'H', s: 2560, lateral: -50, base: 4, width: 8, height: 4.5, unverified: ['position'] },
  { id: 'P', s: 4980, lateral: 52, base: 4, width: 8, height: 4.5, unverified: ['position'] },
  { id: 'esses', s: 1230, lateral: -30, base: 4, width: 8, height: 4.5, unverified: ['position'] },
  { id: 'T1_inside', s: 470, lateral: -22, base: 4, width: 8, height: 4.5, unverified: ['position'] },
]

/** DENSO Leader Tower (2009): 27.5 m, black slender column with the LED timing board. OSM way 469636517. */
export const LEADER_TOWER = { s: 130, lateral: -10.1, height: 27.5, footprint: [3.6, 1.9] as [number, number], boardHeight: 12, boardWidth: 3.2, colour: '#1c1e22' }

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
  unverified: ['height / diameter (official brochure figures)'],
}

/** Spectator tunnels under the track (DEM notches). The crossover bridge (4676–4713) is not one. */
export const UNDERPASSES: { name: string; sRange: [number, number] }[] = [
  { name: '観客トンネル（メインストレート）', sRange: [110, 120] },
  { name: 'S字／NIPPO 地下道', sRange: [1770, 1795] },
  { name: 'シケイン地下道', sRange: [5110, 5120] },
]

/** Water bodies drawn as flat planes from their OSM polygons. */
export const WATER = [
  { name: 'T1 インフィールドの池', osmWay: 184005565 },
  { name: 'T1–T2 調整池', osmWay: 132793884 },
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
  // the T1 gravel trap (sand 468750062) only starts at s 434; the braking zone before it is grass behind the wall
  { name: 'T1 entry', sRange: [383, 434], left: { asphalt: [0, 5.5], grass: [5, 26.5], gravel: null }, right: { asphalt: [0, 5], grass: [5, 14.5], gravel: null }, source: 'osm' },
  { name: 'T1', sRange: [434, 528], left: { asphalt: [0, 5.5], grass: [5, 26.5], gravel: [5.5, 30] }, right: { asphalt: [0, 5], grass: [5, 14.5], gravel: null }, source: 'osm' },
  { name: 'T2', sRange: [558, 680], left: { asphalt: [0, 24], grass: [6, 9], gravel: [24, 38.5] }, right: { asphalt: [0, 33.5], grass: [5.5, 23.5], gravel: [33.5, 55] }, source: 'osm' },
  { name: 'T2 exit → Esses', sRange: [680, 827], left: { asphalt: [0, 8], grass: [8, 48.5], gravel: [15.5, 26.5] }, right: { asphalt: [0, 3], grass: [3, 11.5], gravel: [23.5, 50.5] }, source: 'osm' },
  { name: 'Esses T3–T5', sRange: [827, 1209], left: { asphalt: [0, 6], grass: [6, 39.5], gravel: [9.5, 19] }, right: { asphalt: [0, 4.5], grass: [4.5, 11.5], gravel: [10.5, 27] }, source: 'osm' },
  // 逆バンク: the outside gravel starts only at s ≈ 1270 and widens toward the exit (D-1..4 sits right behind it)
  { name: '逆バンク entry', sRange: [1247, 1285], left: { asphalt: [0, 4], grass: [4, 15.5], gravel: [6, 21] }, right: { asphalt: [0, 7], grass: [7, 30.5], gravel: [11, 28] }, source: 'osm' },
  { name: '逆バンク apex', sRange: [1285, 1330], left: { asphalt: [0, 2.5], grass: null, gravel: [2.5, 25.5] }, right: { asphalt: [0, 8.5], grass: [8.5, 26.5], gravel: [12, 23] }, source: 'osm' },
  { name: '逆バンク exit', sRange: [1330, 1406], left: { asphalt: [0, 5], grass: [36, 48.5], gravel: [5, 31] }, right: { asphalt: [0, 7], grass: [7, 23.5], gravel: null }, source: 'osm' },
  { name: 'NIPPO T7', sRange: [1468, 1596], left: { asphalt: [0, 7.5], grass: [7.5, 20.5], gravel: null }, right: { asphalt: [0, 3], grass: [6, 38], gravel: [4.5, 15.5] }, source: 'osm' },
  { name: 'NIPPO exit → Degner', sRange: [1596, 2054], left: { asphalt: [0, 2.5], grass: [2.5, 7], gravel: null }, right: { asphalt: [0, 5.5], grass: [5, 25.5], gravel: [12.5, 38] }, source: 'osm' },
  { name: 'Degner 1', sRange: [2054, 2076], left: { asphalt: [0, 2.5], grass: [1.5, 2.5], gravel: [4.5, 9] }, right: { asphalt: [0, 7.5], grass: [7.5, 25], gravel: [27, 42.5] }, source: 'osm' },
  { name: 'Degner 1 → 2', sRange: [2076, 2207], left: { asphalt: [0, 4], grass: [38, 53.5], gravel: [4, 37] }, right: { asphalt: [0, 6.5], grass: [6.5, 21.5], gravel: [23.5, 55] }, source: 'osm' },
  { name: 'Degner 2', sRange: [2207, 2247], left: { asphalt: [0, 9], grass: [26.5, 37.5], gravel: [9, 26] }, right: { asphalt: [0, 5], grass: [5, 29], gravel: [29.5, 55] }, source: 'osm' },
  { name: 'crossover (under)', sRange: [2247, 2290], left: { asphalt: [0, 9], grass: [22, 29], gravel: [7.5, 34] }, right: { asphalt: [0, 5], grass: [5, 16], gravel: [12.5, 57] }, source: 'osm' },
  { name: 'crossover → 110R', sRange: [2290, 2492], left: { asphalt: [0, 6.5], grass: [0, 6.5], gravel: [6.5, 14.5] }, right: { asphalt: [0, 5], grass: [5, 16.5], gravel: null }, source: 'osm' },
  // no OSM surface polygons from here to the Spoon exit — photo-derived, UNVERIFIED
  { name: '110R', sRange: [2492, 2604], left: { asphalt: [0, 14], grass: [14, 24], gravel: [24, 40] }, right: { asphalt: [0, 10], grass: [10, 16], gravel: null }, source: 'photo', unverified: ['all bands (May-2021 gravel enlargement on the left)'] },
  { name: '110R → hairpin', sRange: [2604, 2661], left: { asphalt: [0, 12], grass: [12, 30], gravel: null }, right: { asphalt: [0, 8], grass: [8, 16], gravel: null }, source: 'photo', unverified: ['all bands'] },
  { name: 'hairpin', sRange: [2661, 2728], left: { asphalt: [0, 9], grass: [9, 16], gravel: null }, right: { asphalt: [0, 12], grass: [26, 40], gravel: [12, 26] }, source: 'photo', unverified: ['all bands'] },
  { name: 'hairpin exit → 200R', sRange: [2728, 3064], left: { asphalt: [0, 6], grass: [6, 14], gravel: null }, right: { asphalt: [0, 10], grass: [16, 30], gravel: [10, 16] }, source: 'photo', unverified: ['all bands'] },
  { name: '200R → Spoon', sRange: [3064, 3552], left: { asphalt: [0, 8], grass: [8, 40], gravel: null }, right: { asphalt: [0, 6], grass: [6, 16.5], gravel: null }, source: 'osm', unverified: ['left grass polygon only beyond 40 m'] },
  { name: 'Spoon 1–2', sRange: [3552, 3825], left: { asphalt: [0, 22], grass: [40, 50], gravel: [22, 40] }, right: { asphalt: [0, 9], grass: [9, 20], gravel: null }, source: 'photo', unverified: ['all bands (outside fully asphalt since 2005, gravel restored at T14 later)'] },
  { name: 'west straight', sRange: [3825, 4329], left: { asphalt: [0, 10.5], grass: [3.5, 6], gravel: null }, right: { asphalt: [0, 7], grass: [3.5, 10], gravel: null }, source: 'osm' },
  { name: 'west straight (gravel)', sRange: [4329, 4521], left: { asphalt: [0, 10.5], grass: [3.5, 6], gravel: null }, right: { asphalt: [0, 4.5], grass: [3.5, 10], gravel: [4.5, 20.5] }, source: 'osm' },
  { name: 'west straight end → bridge', sRange: [4521, 4713], left: { asphalt: [0, 4.5], grass: [4.5, 21], gravel: null }, right: { asphalt: [0, 8], grass: [0, 17], gravel: null }, source: 'osm' },
  { name: '130R', sRange: [4713, 4935], left: { asphalt: [0, 7.5], grass: [7.5, 21], gravel: [12, 19.5] }, right: { asphalt: [0, 14.5], grass: [46.5, 55], gravel: [16, 55] }, source: 'osm' },
  { name: '130R → chicane', sRange: [4935, 5148], left: { asphalt: [0, 9], grass: [9, 13.5], gravel: [9, 16] }, right: { asphalt: [0, 1.5], grass: [1.5, 42.5], gravel: [33, 55] }, source: 'osm' },
  { name: 'chicane T16–T17', sRange: [5148, 5234], left: { asphalt: [0, 6], grass: [6, 46], gravel: null }, right: { asphalt: [0, 6], grass: [6, 47.5], gravel: [24.5, 55] }, source: 'osm' },
  { name: 'T18 exit', sRange: [5262, 5408], left: { asphalt: [0, 7.5], grass: [7.5, 12.5], gravel: [11.5, 22] }, right: { asphalt: [0, 3.5], grass: [3.5, 41.5], gravel: [6.5, 25.5] }, source: 'osm' },
  { name: 'main straight (final corner end)', sRange: [5408, 5500], left: { asphalt: [0, 8], grass: [8, 13.5], gravel: [11, 23] }, right: { asphalt: [0, 11.5], grass: [8.5, 24], gravel: null }, source: 'osm' },
  { name: 'main straight', sRange: [5500, 383], left: { asphalt: [0, 8], grass: [8, 13.5], gravel: null }, right: { asphalt: [0, 11.5], grass: [8.5, 24], gravel: null }, source: 'osm' },
]

/** Painted run-off aprons on the inside of the slow corners (2026 photos; extents UNVERIFIED). */
export const PAINTED_APRONS: { name: string; sRange: [number, number]; side: Side; width: number; colour: string; pattern: 'chevrons' | 'solid'; unverified: string[] }[] = [
  { name: 'ヘアピン内側', sRange: [2661, 2728], side: -1, width: 8, colour: COLOURS.apronBlue.mid, pattern: 'chevrons', unverified: ['s extent', 'width', 'hex'] },
  { name: 'シケイン内側 T16', sRange: [5148, 5175], side: 1, width: 6, colour: COLOURS.apronTurquoise.mid, pattern: 'solid', unverified: ['s extent', 'width', 'hex'] },
  { name: 'シケイン内側 T17', sRange: [5200, 5234], side: -1, width: 6, colour: COLOURS.apronTurquoise.mid, pattern: 'solid', unverified: ['s extent', 'width', 'hex'] },
]

/** Debris-fence height in front of the stands: FIA-standard 3.5 m; Suzuka-specific heights UNVERIFIED. */
export const DEBRIS_FENCE_HEIGHT = 3.5
