import * as THREE from 'three'
import { CIRCUIT } from '~/data/suzuka'
import { GROUND_AREAS, PIT_PLANNED, RUNOFF_ZONES, type GroundArea, type GroundFootprint, type Side } from '~/data/suzuka-facilities-spec'
import { KERBS, OFFSET_LANES, type OffsetLaneDef } from '~/data/suzuka-barriers-spec'
import { forwardDelta, ROLL_CAP, signedDelta, type Track } from '~/sim/track'
import { laneWorldPath, osmWay, patchOutline, simplifyRing, wayChainPath } from './trackside'
import type { CutField } from './ground-field'

/**
 * The GROUND PLAN: a partition of the ground beside the road into exactly one opaque owner per
 * point, derived from the data tables alone (RUNOFF_ZONES, KERBS, OFFSET_LANES, GROUND_AREAS,
 * CIRCUIT.pit, the crossover) by the one precedence list below. No three.js geometry lives here;
 * `ground-mesh.ts` turns the plan into faces and `scripts/audit/surface-check.mjs` compares the
 * built scene against `ownerAt`.
 *
 * Why a partition and not a stack: the ground used to be overlapping opaque sheets 1-10 cm apart,
 * and which one was visible was decided by the depth buffer. Two sheets that approximate the same
 * terrain on different triangulations disagree by up to 63 mm over 4 m, so no ladder of lifts can
 * keep the intended one on top; the swept (s, lateral) frame is also 2-to-1 in XZ over ~5 % of
 * the verge (hairpin, 200R ↔ west straight, Dunlop, 130R), so a sheet was drawing the same ground
 * twice. Here every owner boundary is a COLUMN of the raster (see ground-mesh.ts), every point of
 * the verge has one owner, and the verge stops at the bisector between two facing stretches.
 *
 * Frames: `s` along the lap, `off` metres beyond the local road edge (≥ 0), `side` +1 left.
 */

// ---------------------------------------------------------------- owners

export type OwnerKind =
  | 'road' | 'kerb' | 'deckShoulder' | 'pitLane' | 'pitApron' | 'lane'
  | 'asphaltArea' | 'turf' | 'gravelArea' | 'grassArea' | 'paddock' | 'helipad' | 'water'
  | 'gravelBand' | 'asphaltBand' | 'grass' | 'terrain'

/**
 * The one ordered list. Lower rank wins a point; the area kinds share a rank and are ordered by
 * their row's `layer` (higher wins), then by row order. Nothing else decides visibility.
 */
export const PRECEDENCE: readonly OwnerKind[] = [
  'road', 'kerb', 'deckShoulder', 'pitLane', 'pitApron', 'lane',
  'asphaltArea', 'turf', 'gravelArea', 'grassArea', 'paddock', 'helipad', 'water',
  'gravelBand', 'asphaltBand', 'grass', 'terrain',
]
const AREA_KINDS = new Set<OwnerKind>(['asphaltArea', 'turf', 'gravelArea', 'grassArea', 'paddock', 'helipad', 'water'])
const RANK: Record<OwnerKind, number> = Object.fromEntries(PRECEDENCE.map((k) => [k, AREA_KINDS.has(k) ? PRECEDENCE.indexOf('asphaltArea') : PRECEDENCE.indexOf(k)])) as Record<OwnerKind, number>

/**
 * How an owner's vertices get their height. Fixed here, never in a data row (plan rule R14):
 * road-frame owners ride the road plane of their own s window (exact by construction), field
 * owners ride the one continuous ground field. The kerb is a road-frame profile by column.
 */
export type HeightRule = { frame: 'road'; dy: number } | { frame: 'road'; profile: true } | { frame: 'field' }
export const RULE_OF: Record<OwnerKind, HeightRule> = {
  road: { frame: 'road', dy: 0 },
  kerb: { frame: 'road', profile: true },
  deckShoulder: { frame: 'road', dy: 0 },
  pitLane: { frame: 'road', dy: 0 },
  pitApron: { frame: 'road', dy: 0 },
  lane: { frame: 'field' },
  asphaltArea: { frame: 'field' },
  turf: { frame: 'field' },
  gravelArea: { frame: 'field' },
  grassArea: { frame: 'field' },
  paddock: { frame: 'field' },
  helipad: { frame: 'field' },
  water: { frame: 'field' },
  gravelBand: { frame: 'field' },
  asphaltBand: { frame: 'field' },
  grass: { frame: 'field' },
  terrain: { frame: 'field' },
}

export interface Owner {
  kind: OwnerKind
  /** the row / lane / band it comes from; 'grass', 'road', ... for the implicit ones */
  name: string
  rank: number
  layer: number
  /** row order among equals (later wins) */
  index: number
}

const owner = (kind: OwnerKind, name: string = kind, layer = 0, index = 0): Owner => ({ kind, name, rank: RANK[kind], layer, index })
const ROAD = owner('road'), KERB = owner('kerb'), DECK = owner('deckShoulder'), PIT_LANE = owner('pitLane'), PIT_APRON = owner('pitApron')
const GRAVEL_BAND = owner('gravelBand'), ASPHALT_BAND = owner('asphaltBand'), GRASS = owner('grass'), TERRAIN = owner('terrain')

/** true when `a` owns a point both claim */
export function ownerBeats(a: Owner, b: Owner): boolean {
  if (a.rank !== b.rank) return a.rank < b.rank
  if (a.layer !== b.layer) return a.layer > b.layer
  return a.index > b.index
}

// ---------------------------------------------------------------- constants

/** minimum mown-verge width beside the road (m beyond the edge); a zone's band may declare more */
export const VERGE_MIN = 34
/** furthest a RUNOFF_ZONES band reaches from the centreline */
export const RUNOFF_MAX_LAT = 55
/**
 * The raster's ceiling (m beyond the road edge). Larger than any band because the paddock rows
 * are bands too: the ground between the pit straight and NIPPO is one apron 125 m deep, and it is
 * rastered from both roads up to their bisector rather than triangulated as a world polygon.
 */
export const EXTENT_MAX = 130
/** How far the analytic terrain sits below the road plane next to the track (Terrain.heightAt). */
export const ROAD_CUT = 0.12
/** the flat strip on the road plane beside the asphalt (kerbs live here); the field blends beyond it */
export const FLAT_STRIP = 2
/** height of the field above the analytic terrain, and of the strip below the road plane */
export const RUNOFF_LIFT = 0.05
export const STRIP_DROP = -0.03
/**
 * A ribbon swept `lat` metres to the INSIDE of a corner of curvature k is compressed by
 * (1 - k*lat); at lat = 1/k it collapses and past it the surface is inside out. Keep the measured
 * Jacobian of the swept frame at or above 1 - FOLD_SAFE.
 */
export const FOLD_SAFE = 0.7
/** gravel starts behind the kerb line, never in the flat strip's first metre */
const GRAVEL_INNER = 1.0
/** zone boundaries are blended over this many metres so adjacent tables never step */
const BAND_SMOOTH_M = 16
/** the crossover deck's shoulder beyond the asphalt, and the s reach of the elevated section */
export const DECK_SHOULDER = 1.2
export const DECK_REACH = 160
/** the s window either side of the crossover's two ends that every XZ rule treats as 3D */
export const CROSS_WINDOW = 115
/** facing stretches stop this far short of their bisector; the stitch strip covers the gap */
export const BISECTOR_MARGIN = 0.5
/**
 * Metres from the crossover along the upper road within which its raster is the deck shoulder
 * alone (the bridge and its embankment walls); the lower road's verge passes under it freely.
 * Beyond, the upper road's verge ramps out (crossoverCap) and the lower road's raster is capped
 * at the upper's actual edge, so the two meet at a stitch strip instead of leaving a wedge of
 * bare terrain (s 4741–4750 right, found in P4) or overlapping (Degner 2, s 2180–2200).
 */
export const DECK_ZONE = 50
/** the longest outer chord a raster row may have between two stations (a 5 m fill spacing then keeps every diagonal under the high tier's 6.77 m half-grid) */
export const MAX_ROW_CHORD = 4
/**
 * Metres of extent per metre of s the raster's edge may gain or lose (the extent table): steeper
 * than the ring reach's REACH_SLOPE, so the verge out of a tight spot — the upper road beside the
 * lower road's raster at the crossover — is back at its full width within a few rows instead of
 * leaving a wedge of bare terrain; a 2 m row still keeps its edge segment under 4.5 m.
 */
export const EXTENT_SLOPE = 2
/**
 * In the crossover windows a road's verge reaches the facing road's raster edge when that edge
 * lies within this many metres beyond its declared minimum: the ground under the upper road's
 * embankment approach is the lower road's, and the upper road's verge ramping out of its deck
 * zone recedes faster than the slope limit lets the lower road's follow unless it is declared.
 */
export const CROSS_BRIDGE = 25
/**
 * A terrain gap narrower than this between the verge and an area row is rastered as grass, so
 * the area is one mesh with the verge. 40 m reaches the retention basins from the Esses and the
 * T1 exit; the kart tracks and the South Course, 100 m out, stay world polygons.
 */
const RING_BRIDGE = 40
/** the most the raster extent may change per metre of s where a ring extends it */
const REACH_SLOPE = 1.0
/**
 * Two samples closer than this along the lap are the same stretch, never a facing pair. 40 m:
 * the Casio Triangle's two legs face each other 60 m apart along the lap (80 m let their rasters
 * overlap across the turf island); on a bend of radius R two samples of the same curve 40 m apart
 * cap the inside at ≈ R − hw, always beyond the fold cap's 0.7 R − hw, so nothing else changes.
 */
const BISECTOR_MIN_LAP = 40
/** kerb ends ramp their width from 0 to full over this length */
export const KERB_TAPER = 0.5
/** rows across the height ramp of a kerb's end (stations at KERB_TAPER / KERB_TAPER_STEPS) */
export const KERB_TAPER_STEPS = 8
/**
 * Fill columns (metres beyond the road edge): every raster cell stays under 4 m across in the
 * verge and under 5 m beyond 12 m — on the outside of a bend a 2 m row is stretched to 3-4 m by
 * the frame's Jacobian, and a 5 m × 4 m cell's diagonal (6.4 m) still fits the high tier's 6.8 m
 * half-grid rule where 6 m did not; a quarter fewer field evaluations than 4 m everywhere.
 */
export const FILL_OFFS: readonly number[] = [2, 3.5, 5.5, 8, 12, 17, 22, 27, 32, 37, 42, 47, 52, 57, 62, 67, 72, 77, 82, 87, 92, 97, 102, 107, 112, 117, 122, 127]
/** road fill columns across the racing surface, as fractions of the width */
export const ROAD_FRACTIONS: readonly number[] = [0, 0.25, 0.5, 0.75, 1]
/** the ring interval count a ring may have on one station ray (a loop crossed twice) */
const MAX_RING_INTERVALS = 3

/** 0 → 1 over the first `len` metres of [from, to] and 1 → 0 over the last, 0 outside (forward, wrapped) */
function windowRamp(track: Track, s: number, from: number, to: number, len: number): number {
  const L = track.length
  const d = forwardDelta(from, track.wrap(s), L)
  const span = forwardDelta(from, to, L)
  if (d > span) return 0
  return Math.max(0, Math.min(1, d / len, (span - d) / len))
}
/** the crossover deck's shoulder width at s (a 0.1 m ramp at both ends of the elevated section) */
export function deckShoulderAt(track: Track, s: number): number {
  return DECK_SHOULDER * windowRamp(track, s, track.crossing.sOver - DECK_REACH, track.crossing.sOver + DECK_REACH, 0.1)
}
/**
 * Ramp length at the pit lane / apron ends: their ends are real steps, drawn as a short taper.
 * 2 m, not 0.5: the apron's outer edge moves 50 m across the taper, and a station is inserted
 * wherever it crosses a fill column (below), so the taper needs room for those stations to stay
 * apart (dedup 5 cm) — cells of 15 cm × 4 m instead of a fan of 50 m triangles.
 */
const PIT_TAPER = 2

function smoothstep(t: number): number {
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return t * t * (3 - 2 * t)
}

/**
 * `x.toFixed(d)` as an integer (x × 10^d rounded the way toFixed rounds), for the memo keys
 * below: the keys used to be strings built with toFixed, which cost more than the lookups they
 * saved (≈ 0.7 µs a key, 2 M keys per evaluation of the columns). The fast path rounds the
 * product; toFixed rounds the EXACT value, and the two can only differ when x × 10^d is within
 * the product's rounding error (≤ 1e-9 here) of a half — that case, and the negatives toFixed
 * rounds away from zero, go through toFixed itself, so the key is identical either way.
 */
function fixedKey(x: number, digits: 2 | 3): number {
  const scale = digits === 3 ? 1000 : 100
  const y = x * scale
  const r = Math.round(y)
  if (y >= 0 && Math.abs(y - r) < 0.4999999) return r
  return Math.round(Number(x.toFixed(digits)) * scale)
}

// ---------------------------------------------------------------- run-off bands (RUNOFF_ZONES)

export interface RunoffLayout {
  /** outer edge (m from the centreline, ≥ the local half-width) of the asphalt run-off on `side` */
  asphaltOuter: (s: number, side: Side) => number
  /** gravel band [inner, outer] (m from the centreline) on `side`, or null where there is none */
  gravel: (s: number, side: Side) => [number, number] | null
  /** the widest declared band edge on `side` (m from the centreline) */
  declaredOuter: (s: number, side: Side) => number
  /** where the gravel band's inner edge is or would be (m from the centreline): continuous in s */
  gravelInner: (s: number, side: Side) => number
}

export interface GravelRun {
  from: number
  to: number
  side: Side
  /** widest outer edge of the trap, metres beyond the road edge (for the barrier line) */
  outer: number
}

/** Circular linear interpolation across the NaN gaps of a per-metre table. */
function fillGaps(arr: Float32Array, fallback: number) {
  const N = arr.length
  let first = -1
  for (let i = 0; i < N; i++) if (!Number.isNaN(arr[i]!)) { first = i; break }
  if (first < 0) {
    arr.fill(fallback)
    return
  }
  let i = first
  let guard = 0
  while (guard++ < N + 1) {
    let j = (i + 1) % N
    while (j !== first && !Number.isNaN(arr[j]!)) j = (j + 1) % N
    if (j === first) break
    const a = arr[(j - 1 + N) % N]!
    let k = j
    let n = 0
    while (Number.isNaN(arr[k]!)) { k = (k + 1) % N; n++ }
    const b = arr[k]!
    for (let m = 0; m < n; m++) arr[(j + m) % N] = a + ((b - a) * (m + 1)) / (n + 1)
    i = k
    if (i === first) break
  }
}

/** Circular box filter of half-width `r` metres. */
function smoothCircular(arr: Float32Array, r: number): Float32Array {
  const N = arr.length
  const out = new Float32Array(N)
  const w = 2 * r + 1
  let sum = 0
  for (let k = -r; k <= r; k++) sum += arr[(k + N) % N]!
  for (let i = 0; i < N; i++) {
    out[i] = sum / w
    sum += arr[(i + r + 1) % N]! - arr[(i - r + N) % N]!
  }
  return out
}

const layoutCache = new WeakMap<Track, { layout: RunoffLayout; runs: GravelRun[] }>()

/** Per-side, per-s run-off bands interpolated from RUNOFF_ZONES (cached per track). */
export function runoffLayout(track: Track): RunoffLayout {
  return layoutFor(track).layout
}

/** Contiguous gravel traps (driving order) — the barriers follow their far edge. */
export function gravelRuns(track: Track): GravelRun[] {
  return layoutFor(track).runs
}

function layoutFor(track: Track) {
  let hit = layoutCache.get(track)
  if (!hit) {
    hit = buildLayout(track)
    layoutCache.set(track, hit)
  }
  return hit
}

function buildLayout(track: Track): { layout: RunoffLayout; runs: GravelRun[] } {
  const L = track.length
  const N = Math.ceil(L)
  const table = () => ({ a: new Float32Array(N).fill(NaN), gi: new Float32Array(N).fill(NaN), gw: new Float32Array(N).fill(NaN), d: new Float32Array(N).fill(NaN) })
  const tabs = { left: table(), right: table() }
  const tab = (side: Side) => (side > 0 ? tabs.left : tabs.right)
  for (const z of RUNOFF_ZONES) {
    const len = forwardDelta(z.sRange[0], z.sRange[1], L)
    for (let d = 0; d <= len; d++) {
      const i = Math.round(track.wrap(z.sRange[0] + d)) % N
      for (const side of [1, -1] as const) {
        const band = side > 0 ? z.left : z.right
        const t = tab(side)
        t.a[i] = band.asphalt ? band.asphalt[1] : 0
        if (band.gravel) {
          t.gi[i] = band.gravel[0]
          t.gw[i] = band.gravel[1] - band.gravel[0]
        } else t.gw[i] = 0
        t.d[i] = Math.max(band.asphalt?.[1] ?? 0, band.grass?.[1] ?? 0, band.gravel?.[1] ?? 0)
      }
    }
  }
  const smoothed = (side: Side) => {
    const t = tab(side)
    fillGaps(t.a, 0)
    fillGaps(t.gi, 12)
    fillGaps(t.gw, 0)
    fillGaps(t.d, 0)
    const r = Math.round(BAND_SMOOTH_M / 2)
    return { a: smoothCircular(t.a, r), gi: smoothCircular(t.gi, r), gw: smoothCircular(t.gw, r), d: smoothCircular(t.d, r) }
  }
  const S = { left: smoothed(1), right: smoothed(-1) }
  const at = (arr: Float32Array, s: number): number => {
    const x = track.wrap(s)
    const i = Math.floor(x) % N
    const f = x - Math.floor(x)
    return arr[i]! * (1 - f) + arr[(i + 1) % N]! * f
  }
  // no minimum width: the band's outer edge must be CONTINUOUS in s for a raster column to follow
  // it (a 0.5 m threshold made it jump from 0.5 to 0, and the cells there had no single owner);
  // the half-metre "registration noise" bands are simply drawn half a metre wide
  const asphaltOuter = (s: number, side: Side): number => {
    const hw = track.halfWidthAt(s)
    const a = at((side > 0 ? S.left : S.right).a, s)
    return Math.min(Math.max(a, hw), hw + RUNOFF_MAX_LAT)
  }
  const gravelInner = (s: number, side: Side): number => {
    const hw = track.halfWidthAt(s)
    const t = side > 0 ? S.left : S.right
    return Math.max(at(t.gi, s), hw + GRAVEL_INNER, asphaltOuter(s, side))
  }
  // any positive width counts: the band's edges must be CONTINUOUS in s so a raster column can
  // follow them — a width threshold made the band pop into existence 0.3 m wide, and the owner of
  // the cells around that station disagreed with its corners
  const gravel = (s: number, side: Side): [number, number] | null => {
    const t = side > 0 ? S.left : S.right
    const outer = Math.min(at(t.gi, s) + at(t.gw, s), RUNOFF_MAX_LAT)
    const inner = gravelInner(s, side)
    return outer - inner > 0 ? [inner, outer] : null
  }
  const declaredOuter = (s: number, side: Side): number => Math.min(RUNOFF_MAX_LAT, at((side > 0 ? S.left : S.right).d, s))
  const runs: GravelRun[] = []
  for (const side of [1, -1] as const) {
    const present = new Uint8Array(N)
    const outerAt = new Float32Array(N)
    for (let i = 0; i < N; i++) {
      const g = gravel(i, side)
      if (g && g[1] - g[0] > 0.3) {
        present[i] = 1
        outerAt[i] = g[1] - track.halfWidthAt(i)
      }
    }
    for (let i = 0; i < N; i++) {
      if (present[i] && !present[(i - 1 + N) % N]) {
        let j = i
        let gap = 0
        let outer = 0
        let len = 0
        while (len < N) {
          const k = (i + len) % N
          if (present[k]) {
            gap = 0
            outer = Math.max(outer, outerAt[k]!)
            j = k
          } else if (++gap > 8) break
          len++
        }
        const runLen = forwardDelta(i, j, L)
        if (runLen >= 12) runs.push({ from: i, to: j, side, outer })
      }
    }
  }
  return { layout: { asphaltOuter, gravel, declaredOuter, gravelInner }, runs }
}

// ---------------------------------------------------------------- kerbs

/** Flat-kerb spans with the pit join removed on the right (track-mesh.ts kerbSpans idiom). */
export interface KerbSpan { from: number; to: number; side: Side; width: number; name: string }

export function kerbSpans(track: Track): KerbSpan[] {
  const L = track.length
  const pit = CIRCUIT.pit
  const out: KerbSpan[] = []
  for (const k of KERBS) {
    if (k.kind !== 'flat') continue
    const w = k.width ?? 1.3
    if (k.side > 0) { out.push({ from: k.sRange[0], to: k.sRange[1], side: k.side, width: w, name: k.name }); continue }
    for (const [a, b] of subtractInterval(k.sRange[0], k.sRange[1], pit.entryS - 4, pit.exitS + 4, L)) out.push({ from: a, to: b, side: k.side, width: w, name: k.name })
  }
  return out
}

/** Forward intervals of [from, to] that remain after removing [cutFrom, cutTo] (closed lap). */
export function subtractInterval(from: number, to: number, cutFrom: number, cutTo: number, L: number): [number, number][] {
  const len = forwardDelta(from, to, L)
  const cutLen = forwardDelta(cutFrom, cutTo, L)
  let c0 = forwardDelta(from, cutFrom, L)
  if (c0 > L / 2) c0 -= L
  const c1 = c0 + cutLen
  if (c1 <= 0 || c0 >= len) return [[from, to]]
  const out: [number, number][] = []
  if (c0 > 0) out.push([from, from + c0])
  if (c1 < len) out.push([from + c1, to])
  return out
}

/**
 * The flat kerb at s on `side`: its full width and the taper factor (0 → 1 over KERB_TAPER at
 * both ends). The profile columns and heights are the FULL profile scaled by the taper, so the
 * columns stay in order while the kerb grows out of the road edge.
 */
/**
 * The kerb at s on `side`: its full `width`; `taper`, the HEIGHT factor, rising from 0 at the
 * span's ends to 1 over KERB_TAPER inside it; and `spread`, the COLUMN factor, 1 inside the span
 * and falling to 0 over KERB_TAPER outside it — so the kerb's columns converge on the road edge
 * over half a metre beyond its end instead of collapsing within one row, where they crossed every
 * column between (a ring's edge 0.2 m out) and no station could resolve the crossings.
 */
export function kerbAt(spans: readonly KerbSpan[], track: Track, s: number, side: Side): { width: number; taper: number; spread: number } {
  const L = track.length
  let best = { width: 0, taper: 0, spread: 0 }
  for (const k of spans) {
    if (k.side !== side) continue
    const len = forwardDelta(k.from, k.to, L)
    const d = signedDelta(k.from, track.wrap(s), L)
    // distance outside the span (0 inside), measured the short way round
    const outside = d < 0 ? -d : d > len ? d - len : 0
    if (outside >= KERB_TAPER) continue
    const taper = outside > 0 ? 0 : Math.min(1, d / KERB_TAPER, (len - d) / KERB_TAPER)
    const spread = 1 - outside / KERB_TAPER
    const score = k.width * (taper + spread * 0.01)
    if (score > best.width * (best.taper + best.spread * 0.01)) best = { width: k.width, taper, spread }
  }
  return best
}

/**
 * Width of the kerb's ground at s on `side` (0 = none): its full width over its whole span (the
 * ends fade in HEIGHT, kerbHeights), and beyond the span the converging wedge of its columns —
 * flat, at the road plane, but the kerb's own: when the wedge belonged to whatever lay outside,
 * a ring's edge 0.2 m out (the chicane apron) was a real boundary crossing four real kerb columns
 * within 25 cm, and the crossings 1 cm apart were tied to one station and left inverted.
 */
export function kerbWidthTapered(spans: readonly KerbSpan[], track: Track, s: number, side: Side): number {
  const k = kerbAt(spans, track, s, side)
  return k.width * k.spread
}

/**
 * The kerb's cross-section, metres beyond the road edge, for a full width `w0` and the column
 * factor `spread` (kerbAt). Inside the span the columns do not move: a kerb's end is a HEIGHT
 * ramp over KERB_TAPER (kerbHeights scales by the taper), so the surface between two stations is
 * linear in s at every offset and a cell chords it exactly — columns that narrowed with the
 * height made the profile's breakpoints move between stations, and a cell across a tapering end
 * chorded it by up to 50 mm (the chicane's exit kerb). Beyond the span the columns converge on
 * the road edge at height 0.
 */
export function kerbColumns(w0: number, spread: number): [number, number, number, number] {
  if (w0 <= 0 || spread <= 0) return [0, 0, 0, 0]
  return [0.3 * spread, 0.55 * w0 * spread, (w0 - 0.15) * spread, w0 * spread]
}
/** heights of the kerb columns [ramp, crown, back, out] above the road plane, scaled by the taper */
export function kerbHeights(t: number): [number, number, number, number] {
  return [0.05 * t, 0.065 * t, 0.05 * t, STRIP_DROP * t]
}
/**
 * The kerb's height above the road plane at `off` metres beyond the road edge: the profile is
 * piecewise linear between its columns, so any vertex a kerb cell touches — a fill or a ring
 * column that happens to fall inside the kerb — gets the same surface the kerb's own columns do.
 */
export function kerbProfileHeight(w0: number, t: number, spread: number, off: number): number {
  const cols = kerbColumns(w0, spread)
  const hs = kerbHeights(t)
  if (off <= 0) return 0
  let o0 = 0, h0 = 0
  for (let k = 0; k < 4; k++) {
    const o1 = cols[k]!, h1 = hs[k]!
    if (off <= o1) return o1 - o0 > 1e-9 ? h0 + ((h1 - h0) * (off - o0)) / (o1 - o0) : h1
    o0 = o1
    h0 = h1
  }
  return hs[3]!
}

// ---------------------------------------------------------------- world rings (GROUND_AREAS, lanes)

export interface Pt { x: number; z: number }

/** A resolved world-space footprint: an outer ring and its holes (a swept closed way is an annulus). */
export interface WorldRing {
  outer: Pt[]
  holes: Pt[][]
  box: [number, number, number, number]
  /** the s window every point is measured against; undefined = far from the lap, global nearest */
  sRange?: [number, number]
}

export interface RingOwner {
  owner: Owner
  ring: WorldRing
  /** the source row / lane */
  area?: GroundArea
  lane?: OffsetLaneDef
}

function ringBox(pts: Pt[]): [number, number, number, number] {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity
  for (const p of pts) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.z < z0) z0 = p.z; if (p.z > z1) z1 = p.z }
  return [x0, x1, z0, z1]
}

export function inRing(x: number, z: number, ring: readonly Pt[]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside
  }
  return inside
}

/**
 * A ring's edges bucketed by z band, so a point test walks the few edges whose z range holds the
 * point's z instead of the whole loop (the infield's service-road ring has 1,534 vertices and a
 * 700 × 520 m box: every point inside the fences walked it). Built lazily, once per loop, and
 * held off the ring object so the same loop gets the same index however it is reached. The test
 * itself is `inRing`'s: the same edges (those straddling z — every other edge fails the parity
 * test whatever the band says), the same `a = ring[i], b = ring[i − 1]` operands and the same
 * expression, so the parity is identical bit for bit; only the edges that could never toggle it
 * are not visited.
 */
interface RingIndex {
  z0: number
  z1: number
  /** band height (m) */
  h: number
  /** per band: the edge indices i (edge ring[i − 1] → ring[i]) whose z range meets the band */
  bands: Int32Array[]
  /** XZ boxes of RING_CHUNK consecutive edges (edges i in [c·RING_CHUNK, (c + 1)·RING_CHUNK)), for the line tests */
  chunks: Float64Array
}
/** edges per chunk box of a ring index */
const RING_CHUNK = 16
/**
 * Margin (m) on a chunk's side-of-line test: a chunk is skipped only when its whole box lies
 * further than this from the line, so an edge whose per-vertex test could round the other way
 * (|f| ~ 1e-12 at these magnitudes) is always visited.
 */
const RING_CHUNK_EPS = 1e-6
const ringIndexes = new WeakMap<readonly Pt[], RingIndex | null>()
function ringIndexOf(ring: readonly Pt[]): RingIndex | null {
  let idx = ringIndexes.get(ring)
  if (idx !== undefined) return idx
  const n = ring.length
  if (n < 64) { ringIndexes.set(ring, null); return null }
  let z0 = Infinity, z1 = -Infinity
  for (const p of ring) { if (p.z < z0) z0 = p.z; if (p.z > z1) z1 = p.z }
  const nb = Math.max(1, Math.min(4096, Math.ceil(n / 8)))
  const h = Math.max((z1 - z0) / nb, 1e-6)
  const lists: number[][] = Array.from({ length: nb }, () => [])
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = ring[i]!, b = ring[j]!
    const lo = Math.min(a.z, b.z), hi = Math.max(a.z, b.z)
    const k0 = Math.max(0, Math.min(nb - 1, Math.floor((lo - z0) / h))), k1 = Math.max(0, Math.min(nb - 1, Math.floor((hi - z0) / h)))
    for (let k = k0; k <= k1; k++) lists[k]!.push(i)
  }
  const nc = Math.ceil(n / RING_CHUNK)
  const chunks = new Float64Array(nc * 4)
  for (let c = 0; c < nc; c++) {
    let x0 = Infinity, x1 = -Infinity, cz0 = Infinity, cz1 = -Infinity
    // edge i spans ring[i − 1] and ring[i]: the box holds both ends of every edge of the chunk
    for (let i = c * RING_CHUNK; i < Math.min(n, (c + 1) * RING_CHUNK); i++) {
      for (const p of [ring[i]!, ring[(i - 1 + n) % n]!]) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.z < cz0) cz0 = p.z; if (p.z > cz1) cz1 = p.z }
    }
    chunks[c * 4] = x0; chunks[c * 4 + 1] = x1; chunks[c * 4 + 2] = cz0; chunks[c * 4 + 3] = cz1
  }
  idx = { z0, z1, h, bands: lists.map((l) => Int32Array.from(l)), chunks }
  ringIndexes.set(ring, idx)
  return idx
}
function inRingIndexed(x: number, z: number, ring: readonly Pt[]): boolean {
  const idx = ringIndexOf(ring)
  if (!idx) return inRing(x, z, ring)
  // outside the loop's z range no edge straddles z (the parity test fails on every edge); at
  // the range's ends the band index is clamped, so an edge reaching the extreme z is still seen
  if (z < idx.z0 || z > idx.z1) return false
  const nb = idx.bands.length
  const k = Math.max(0, Math.min(nb - 1, Math.floor((z - idx.z0) / idx.h)))
  const band = idx.bands[k]!
  const n = ring.length
  let inside = false
  for (let e = 0; e < band.length; e++) {
    const i = band[e]!
    const a = ring[i]!, b = ring[(i - 1 + n) % n]!
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside
  }
  return inside
}

export function inWorldRing(x: number, z: number, r: WorldRing): boolean {
  const b = r.box
  if (x < b[0] || x > b[1] || z < b[2] || z > b[3]) return false
  if (!inRingIndexed(x, z, r.outer)) return false
  for (const h of r.holes) if (inRingIndexed(x, z, h)) return false
  return true
}

/** Resample a closed world polyline so no segment exceeds `step` (keeps every input vertex). */
function resampleClosed(pts: Pt[], step: number): Pt[] {
  const out: Pt[] = []
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!, b = pts[(i + 1) % pts.length]!
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / step))
    for (let k = 0; k < n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n })
  }
  return out
}

/** Offset a world polyline both ways by `half` with averaged normals; a closed way yields an annulus. */
function sweptWay(pts: Pt[], closed: boolean, half: number): { outer: Pt[]; holes: Pt[][] } {
  const n = pts.length
  const left: Pt[] = [], right: Pt[] = []
  for (let i = 0; i < n; i++) {
    const p = pts[i]!
    const a = pts[closed ? (i - 1 + n) % n : Math.max(0, i - 1)]!, b = pts[closed ? (i + 1) % n : Math.min(n - 1, i + 1)]!
    let dx = b.x - a.x, dz = b.z - a.z
    const l = Math.hypot(dx, dz) || 1
    dx /= l; dz /= l
    // left of the direction of travel: (dz, -dx), the track's own convention
    left.push({ x: p.x + dz * half, z: p.z - dx * half })
    right.push({ x: p.x - dz * half, z: p.z + dx * half })
  }
  if (!closed) return { outer: [...left, ...right.reverse()], holes: [] }
  // an annulus: the larger loop is the outer ring, the smaller the hole (signed areas decide)
  const area = (r: Pt[]) => { let a = 0; for (let i = 0; i < r.length; i++) { const p = r[i]!, q = r[(i + 1) % r.length]!; a += p.x * q.z - q.x * p.z } return Math.abs(a) / 2 }
  return area(left) > area(right) ? { outer: left, holes: [right] } : { outer: right, holes: [left] }
}

function windPositive(ring: Pt[]): Pt[] {
  let area = 0
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!
    area += a.x * -b.z - b.x * -a.z
  }
  return area < 0 ? ring.slice().reverse() : ring
}

const _v = new THREE.Vector3()

/**
 * Resolve a GROUND_AREAS footprint to world XZ (every ring resampled at ≤ 2 m). A `{ cut }`
 * footprint is the cut field's own corridor polygon (`cuts` is the CutField the plan was built
 * with; without one — a lint that only reads the tables — it resolves to nothing).
 */
export function resolveFootprint(track: Track, fp: GroundFootprint, cuts?: CutField | null): WorldRing | null {
  if ('cut' in fp) {
    const corridor = cuts?.corridors.find((c) => c.id === fp.cut)
    const pts = cuts?.corridor(fp.cut, fp.part) ?? []
    if (!corridor || pts.length < 3) return null
    const outer = windPositive(resampleClosed(simplifyRing(pts), 2))
    return { outer, holes: [], box: ringBox(outer), sRange: corridor.def.window }
  }
  if ('ring' in fp || 'osm' in fp) {
    // an area may reach the road edge: the kerb and the road win by precedence, and the strip is a
    // height rule of the field, not a separate owner (patchOutline's 2 m clearance was for the
    // sheet stack)
    const outer = simplifyRing(patchOutline(track, { ...fp, minGap: fp.minGap ?? 0 }, 2))
    if (outer.length < 3) return null
    return { outer, holes: [], box: ringBox(outer), sRange: fp.sRange }
  }
  if ('way' in fp || 'ways' in fp) {
    let en: Pt[]
    let closed: boolean
    if ('ways' in fp) {
      const chain = wayChainPath(track, fp.ways)
      en = chain.pts
      closed = chain.closed
    } else {
      const f = osmWay(fp.way)
      if (!f) return null
      // consecutive duplicate vertices (OSM ways carry them where two ways meet) would give the
      // sweep a zero-length segment and a garbage normal — a crack between the two sides (G9)
      en = f.en.map(([e, n]) => ({ x: e * track.enScale, z: -n * track.enScale })).filter((p, i, a) => i === 0 || Math.hypot(p.x - a[i - 1]!.x, p.z - a[i - 1]!.z) > 1e-3)
      closed = f.closed
    }
    if (en.length < 2) return null
    const sw = sweptWay(closed ? resampleClosed(en, 2) : resampleOpen(en, 2), closed, fp.width / 2)
    const outer = windPositive(sw.outer)
    return { outer, holes: sw.holes.map((h) => windPositive(h)), box: ringBox(outer), sRange: fp.sRange }
  }
  if ('band' in fp) {
    const [s0, s1] = fp.sRange
    const len = forwardDelta(s0, s1, track.length)
    const [l0, l1] = fp.lat
    const outer: Pt[] = []
    for (let d = 0; d <= len; d += 2) { track.pointAt(track.wrap(s0 + d), l0, _v, 0); outer.push({ x: _v.x, z: _v.z }) }
    for (let d = len; d >= 0; d -= 2) { track.pointAt(track.wrap(s0 + d), l1, _v, 0); outer.push({ x: _v.x, z: _v.z }) }
    // the two side edges are single segments across the band: resampled so a raster boundary
    // crossing one of them is seen by the mesh's vertex tests
    const ring = windPositive(resampleClosed(outer, 2))
    return { outer: ring, holes: [], box: ringBox(ring), sRange: fp.sRange }
  }
  // disc
  const { s, lateral, r } = fp.disc
  const outer: Pt[] = []
  const segs = Math.max(24, Math.ceil((2 * Math.PI * r) / 1.5))
  for (let a = 0; a < segs; a++) {
    const t = (a / segs) * Math.PI * 2
    track.pointAt(track.wrap(s + r * Math.cos(t)), lateral + r * Math.sin(t), _v, 0)
    outer.push({ x: _v.x, z: _v.z })
  }
  const ring = windPositive(outer)
  return { outer: ring, holes: [], box: ringBox(ring), sRange: [track.wrap(s - r - 20), track.wrap(s + r + 20)] }
}

function resampleOpen(pts: Pt[], step: number): Pt[] {
  const out: Pt[] = []
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!, b = pts[i + 1]!
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / step))
    for (let k = 0; k < n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n })
  }
  out.push(pts[pts.length - 1]!)
  return out
}

/** The footprint of an offset lane (its world path swept `width` wide); `paved` lanes have none. */
export function laneFootprint(track: Track, def: OffsetLaneDef): WorldRing | null {
  if (def.paved) return null
  const pts = laneWorldPath(track, def, 2)
  if (pts.length < 3) return null
  const sw = sweptWay(pts.map((p) => ({ x: p.x, z: p.z })), false, def.width / 2)
  const outer = windPositive(sw.outer)
  return { outer, holes: [], box: ringBox(outer), sRange: def.sRange }
}

// ---------------------------------------------------------------- the plan

/** One column of the raster on one side: a boundary curve that exists at every station. */
export interface Column {
  id: string
  /** what the column is the boundary of, for the builder's diagnostics */
  role: 'edge' | 'kerb' | 'deck' | 'pit' | 'band' | 'ring' | 'fill' | 'extent' | 'kink'
  /** off (m beyond the road edge) per station; NaN never — absent columns are collapsed */
  off: Float64Array
  /** first / last station index where the column is genuinely present (inclusive); fills and bands always */
  active: [number, number] | null
  /**
   * per station: 1 when the owner differs on the two sides of the column, i.e. it is an actual
   * owner boundary there. A column hidden under a higher-precedence owner (the gravel band's
   * inner edge under a kerb, the asphalt band's edge inside an apron) is a free vertex.
   */
  real: Uint8Array
}

/** whether station i lies in the column's active range (every station for a column without one) */
export function columnActive(c: Column, i: number): boolean {
  if (!c.active) return true
  const [a, b] = c.active
  return a <= b ? i >= a && i <= b : i >= a || i <= b
}
/** a fill, or a column that is not an owner boundary at station i: a free vertex the snap may move */
function isFree(c: Column, i: number): boolean {
  if (c.role === 'fill') return true
  // outside its track a ring column is a parked point, whatever owner boundary it happens to sit on
  if (c.role === 'ring' && !columnActive(c, i)) return true
  return c.real[i] === 0
}
/** the column is an owner boundary somewhere in the row (i, j): crossings with it need a station */
function rowReal(c: Column, i: number, j: number): boolean {
  return !isFree(c, i) || !isFree(c, j)
}

/** two column positions closer than this are the same boundary (a crossing station's root noise) */
export const COLUMN_TIE = 0.002

/**
 * The column order for the row that starts at station i: by position at i, ties (within
 * COLUMN_TIE) by position at the next station, then by column index. Every consumer of the plan
 * (the mesh builder, the guards) must use this order so cells are formed identically.
 *
 * A column that is no owner boundary at either station is left out: it has no cell of its own,
 * and kept in the order it dragged the fills it crossed aside (a ring column parked halfway round
 * the lap from its track, a gravel band's edge hidden under a lane) — 7–8 m edges in the cells.
 * The edge, the fills and the extent are always in.
 */
export function columnOrder(cols: readonly Column[], i: number, j: number): Int32Array {
  const idx = cols.map((_c, k) => k).filter((k) => { const c = cols[k]!; return c.role === 'fill' || c.role === 'extent' || c.role === 'edge' || rowReal(c, i, j) })
  idx.sort((a, b) => {
    const da = cols[a]!.off[i]! - cols[b]!.off[i]!
    if (Math.abs(da) > COLUMN_TIE) return da
    const db = cols[a]!.off[j]! - cols[b]!.off[j]!
    if (Math.abs(db) > COLUMN_TIE) return db
    return a - b
  })
  return Int32Array.from(idx)
}

export interface PlanSide {
  side: Side
  columns: Column[]
  /** per station: the column order of the row starting there (see columnOrder) */
  order: Int32Array[]
  /** raster extent per station (m beyond the road edge) */
  W: Float64Array
  /** which cap bound the extent per station: 0 none, 1 fold, 2 bisector, 3 crossover, 4 declared */
  cap: Uint8Array
}

export interface ResidueEntry {
  zone: string
  side: Side
  cap: 'FOLD' | 'BISECTOR' | 'BRIDGE' | 'WIDTH'
  m2: number
  from: number
  to: number
}

export interface GroundPlan {
  track: Track
  /** station positions along the lap, ascending in [0, L) */
  stations: Float64Array
  /** local half-width per station */
  hw: Float64Array
  sides: { 1: PlanSide; '-1': PlanSide }
  layout: RunoffLayout
  gravelRuns: GravelRun[]
  kerbs: KerbSpan[]
  /** world rings by precedence (areas and lanes), with the owner each carries */
  rings: RingOwner[]
  /** the fold-safe verge width per side (continuous in s) */
  foldSafe: (s: number, side: Side) => number
  /** the raster extent as the plan declares it, continuous in s (the extent VERTICES sit on it) */
  extent: (s: number, side: Side) => number
  /**
   * The raster extent as it is DRAWN: between two stations the raster's outer edge is the XZ chord
   * between their extent vertices, and on a curved road that chord crosses the ray at s at a
   * different offset than the ray-linear `extent` (the outer ray is stretched by the frame's
   * Jacobian). Every owner decision — the mesh's world parts, the census — reads this one, so what
   * the plan calls the raster is exactly what the raster draws.
   */
  extentDrawn: (s: number, side: Side) => number
  /** which cap bound the extent at s */
  extentCap: (s: number, side: Side) => ResidueEntry['cap'] | null
  /** the facing centreline sample index across the bisector at s on `side` (−1 = none) */
  bisectorPartner: (s: number, side: Side) => number
  /**
   * The owner of (s, side, off) with off ≥ 0 metres beyond the road edge; 'road' for off < 0.
   * `inRaster` says the point is inside a raster cell (the mesh builder asking for a cell whose
   * centre falls a hair beyond the extent between two stations): the world/terrain branch is skipped.
   * `at` = the world point itself when the caller has it: the ring test is then on the point,
   * inside the raster and beyond it alike — rebuilding it from (s, off) is not pointAt's inverse
   * (0.3 m out at 40–70 m lateral on a bend, centimetres 180 m out), and the mesh draws every
   * ring in XZ.
   */
  ownerAtSL: (s: number, side: Side, off: number, inRaster?: boolean, at?: { x: number; z: number }) => Owner
  /** the owner at world (x, z); `window` restricts the projection to one stretch of road */
  ownerAt: (x: number, z: number, window?: [number, number]) => Owner
  /** continuous projection onto the road (crossover-aware unless a window is given) */
  project: (x: number, z: number, window?: [number, number]) => { s: number; lateral: number; d: number }
  /** the declared band area the caps remove, per zone and side */
  residue: ResidueEntry[]
  /** station index of the first station at or after s */
  stationIndexAt: (s: number) => number
  /**
   * The plan's stations from s0 forward to s1 with both ends, as unwrapped s values
   * (s0 ≤ … ≤ s0 + length; s0 === s1 is the whole lap); a gap longer than `maxStep` is subdivided
   * evenly. A decal ribbon built on these rows shares the drawn faces' rows, so it lies on the face
   * at every row and only the fold inside one cell remains between them.
   */
  lattice: (s0: number, s1: number, maxStep: number) => number[]
  /** how many stations were inserted for each reason (diagnostics) */
  stats: { base: number; endpoints: number; kinks: number; rows: number; tips: number; crossings: number; snapped: number; chord: number; chordBy: Record<string, number>; rings: number; worldOnly: number; residual: number; residualMax: number; buildMs: number; timing: Record<string, number>; passes: number[]; /** stations added as rows across the cut corridors */ cutRows: number }
}

export interface PlanOptions {
  /** extra stations (s) a builder wants, e.g. decal ends */
  extraStations?: number[]
  /** the cut field (ground-field.ts): the `{ cut }` footprints are its corridors */
  cuts?: CutField | null
}

export function buildGroundPlan(track: Track, opts: PlanOptions = {}): GroundPlan {
  const t0 = performance.now()
  const timing: Record<string, number> = {}
  let tLast = t0
  const lap = (name: string) => { const now = performance.now(); timing[name] = Math.round((timing[name] ?? 0) + now - tLast); tLast = now }
  const L = track.length
  const n = track.n
  const ds = track.ds
  const layout = runoffLayout(track)
  const runs = gravelRuns(track)
  const kerbs = kerbSpans(track)
  const pit = CIRCUIT.pit
  const sOver = track.crossing.sOver, sUnder = track.crossing.sUnder

  // --- fold table (measured Jacobian of the swept frame), per side ----------------------------
  const foldTable = { 1: new Float32Array(n), '-1': new Float32Array(n) }
  {
    const a = new THREE.Vector3(), b = new THREE.Vector3()
    const jac = (s: number, lat: number): number => {
      track.pointAt(s, lat, a)
      track.pointAt(s + 0.5, lat, b)
      return a.distanceTo(b) * 2
    }
    const PROBE = 10
    const R = Math.round(10 / ds)
    const B = Math.round(10 / ds)
    for (const side of [1, -1] as const) {
      const k = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        const s = i * ds
        const j0 = jac(s, 0) || 1
        k[i] = (j0 - jac(s, PROBE * side)) / (PROBE * j0)
      }
      const raw = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        let m = 0
        for (let d = -R; d <= R; d++) m = Math.max(m, k[(i + d + n * 2) % n]!)
        raw[i] = m > 1e-4 ? Math.max(FLAT_STRIP + 1, FOLD_SAFE / m - track.halfWidthAt(i * ds)) : EXTENT_MAX
        if (raw[i]! > EXTENT_MAX) raw[i] = EXTENT_MAX
      }
      const t = foldTable[side]
      for (let i = 0; i < n; i++) {
        let sum = 0
        for (let d = -B; d <= B; d++) sum += raw[(i + d + n * 2) % n]!
        t[i] = Math.min(sum / (2 * B + 1), raw[i]!)
      }
    }
  }
  const sampleAt = (t: Float32Array, s: number): number => {
    const u = track.wrap(s) / ds
    const i = Math.floor(u) % n
    const f = u - Math.floor(u)
    return t[i]! * (1 - f) + t[(i + 1) % n]! * f
  }
  const foldSafe = (s: number, side: Side) => sampleAt(foldTable[side], s)

  // area rows that are lateral bands declare ground too (the paddock aprons)
  const areaBands = GROUND_AREAS.flatMap((a) => ('band' in a.footprint ? [a.footprint] : []))
  const areaOuter = (s: number, side: Side): number => {
    let out = 0
    for (const b of areaBands) {
      if (b.band !== side) continue
      if (forwardDelta(b.sRange[0], track.wrap(s), L) > forwardDelta(b.sRange[0], b.sRange[1], L)) continue
      out = Math.max(out, Math.abs(b.lat[0]), Math.abs(b.lat[1]))
    }
    return out
  }
  /**
   * The upper road's raster within DECK_ZONE of the crossover is its deck shoulder alone (the
   * bridge and its embankment walls). Beyond, the upper road's verge is the ground up to the
   * lower road's raster edge (the meet-at-the-edge cap below), ramped out by the extent's slope
   * limit — so no wedge of bare terrain is left between the two rasters and none overlaps.
   */
  const crossoverCap = (s: number): number => (Math.abs(signedDelta(sOver, s, L)) < DECK_ZONE ? DECK_SHOULDER : EXTENT_MAX)

  // --- bisector cap: half the distance to any facing sample of another stretch ------------------
  // Two facing stretches stop BISECTOR_MARGIN short of their bisector each; the stitch strip zips
  // the two edges. The crossover is the one asymmetric case: the lower road passes under the upper
  // road's deck zone freely, and beyond it — where the upper road's verge ramps out of its deck cap
  // at EXTENT_SLOPE and is short of the bisector — the lower road's cap is where its ray meets the
  // upper road's raster EDGE (its extent as it will be drawn, slope-limited, read in a second
  // round), so the ground under the embankment approach is the lower road's and no wedge of bare
  // terrain is left between the two.
  const bisector = { 1: new Float32Array(n).fill(EXTENT_MAX), '-1': new Float32Array(n).fill(EXTENT_MAX) }
  /** the facing sample that set the raw bisector cap per station and side (−1 = none) */
  const partner = { 1: new Int32Array(n).fill(-1), '-1': new Int32Array(n).fill(-1) }
  {
    const minLap = Math.round(BISECTOR_MIN_LAP / ds)
    const reach = 2 * EXTENT_MAX + 30
    const reach2 = reach ** 2
    const raw = { 1: new Float32Array(n).fill(EXTENT_MAX), '-1': new Float32Array(n).fill(EXTENT_MAX) }
    /** the corner run (index into track.corners) a sample lies in, −1 on a straight */
    const cornerOf = new Int16Array(n).fill(-1)
    track.corners.forEach((c, ci) => { const len = forwardDelta(c.from, c.to, L); for (let d = 0; d <= len; d += ds) cornerOf[Math.round(track.wrap(c.from + d) / ds) % n] = ci })
    const sameCorner = (i: number, j: number) => cornerOf[i]! >= 0 && cornerOf[i] === cornerOf[j]
    /** GP_DEBUG_CAP=<s>: print the winning meeting cap of the samples within 3 m of s */
    const DEBUG_CAP = (globalThis as unknown as { GP_DEBUG_CAP?: number }).GP_DEBUG_CAP ?? null
    const dOver = (s: number) => Math.abs(signedDelta(sOver, s, L))
    const dUnder = (s: number) => Math.abs(signedDelta(sUnder, s, L))
    const onUpper = (s: number) => dOver(s) < CROSS_WINDOW
    const onLower = (s: number) => dUnder(s) < CROSS_WINDOW
    /** a sample's own extent on `side` without a bisector: its declared verge, the fold and the deck cap */
    const ownCap = (j: number, sideJ: Side): number => {
      const sj = j * ds, hwJ = track.hw[j]!
      const declared = Math.min(EXTENT_MAX, Math.max(VERGE_MIN, layout.declaredOuter(sj, sideJ) - hwJ, areaOuter(sj, sideJ) - hwJ))
      return Math.max(0, Math.min(declared, foldSafe(sj, sideJ), crossoverCap(sj)))
    }
    /** the partner's extent the caps read: round 1 its own cap and half the distance, round 2 the slope-limited result */
    let limited: { 1: Float32Array; '-1': Float32Array } | null = null
    /** the drawn extent of sample k on the side facing (px, pz): the side, the extent and the edge vertex */
    const edgeOf = (k: number, px: number, pz: number, d2: number): { side: Side; W: number; x: number; z: number } => {
      const dotK = (px - track.px[k]!) * track.nx[k]! + (pz - track.pz[k]!) * track.nz[k]!
      const sideK: Side = dotK > 0 ? 1 : -1
      const hwK = track.hw[k]!
      let W: number
      if (limited) W = limited[sideK][k]!
      else {
        const half = Math.abs(dotK) > 0.5 ? d2 / (2 * Math.abs(dotK)) - hwK : EXTENT_MAX
        W = Math.min(ownCap(k, sideK), half - BISECTOR_MARGIN)
      }
      W = Math.max(0, W)
      return { side: sideK, W, x: track.px[k]! + track.nx[k]! * sideK * (hwK + W), z: track.pz[k]! + track.nz[k]! * sideK * (hwK + W) }
    }
    const round = () => {
      for (const side of [1, -1] as const) { raw[side].fill(EXTENT_MAX); partner[side].fill(-1) }
      for (let i = 0; i < n; i++) {
        const si = i * ds
        const px = track.px[i]!, pz = track.pz[i]!, nx = track.nx[i]!, nz = track.nz[i]!
        const hwI = track.hw[i]!
        const iLower = onLower(si)
        track.forEachSampleNear(px, pz, reach, (j, d2) => {
          if (d2 > reach2) return
          const lap = Math.abs(i - j)
          if (Math.min(lap, n - lap) < minLap) return
          // the two legs of one corner do not face each other across its inside: the fold cap
          // bounds the inside verge, and a bisector between the legs (Degner 2, 47 m of lap) made
          // a strip across the corner that the crossover's strip then overlapped
          if (sameCorner(i, j)) return
          const j2 = (j + 1) % n
          const sj = j * ds
          // the lower road passes under the deck zone of the upper road freely
          if (iLower && onUpper(sj) && (dOver(sj) < DECK_ZONE || dOver(j2 * ds) < DECK_ZONE)) return
          const dx = track.px[j]! - px, dz = track.pz[j]! - pz
          const meetsUpper = iLower && onUpper(sj)
          if (!meetsUpper && onUpper(si) && onLower(sj) && dOver(si) < DECK_ZONE) return
          for (const side of [1, -1] as const) {
            const dot = (dx * nx + dz * nz) * side
            if (dot <= 0.5) continue
            let cap: number
            if (meetsUpper) {
              // the upper road's edge segment between samples j and j+1, and where i's ray meets it
              const a = edgeOf(j, px, pz, d2)
              const b = edgeOf(j2, px, pz, (track.px[j2]! - px) ** 2 + (track.pz[j2]! - pz) ** 2)
              if (a.side !== b.side) continue
              const ox = px + nx * side * hwI, oz = pz + nz * side * hwI
              const ux = nx * side, uz = nz * side
              const ex = b.x - a.x, ez = b.z - a.z
              const den = ux * ez - uz * ex
              if (Math.abs(den) < 1e-9) continue
              const rx = a.x - ox, rz = a.z - oz
              const tt = (rx * ez - rz * ex) / den
              const lam = (rx * uz - rz * ux) / den
              if (lam < -0.02 || lam > 1.02 || tt <= 0) continue
              cap = tt
              if (DEBUG_CAP !== null && Math.abs(si - DEBUG_CAP) < 3) console.info(`[gp-debug] cap s ${si.toFixed(1)} side ${side}: ${tt.toFixed(2)} from segment j ${sj.toFixed(0)}–${(j2 * ds).toFixed(0)} side ${a.side} W ${a.W.toFixed(1)}/${b.W.toFixed(1)} lam ${lam.toFixed(2)}${limited ? ' [limited]' : ''}`)
            } else cap = d2 / (2 * dot) - hwI
            const arr = raw[side]
            if (cap < arr[i]!) { arr[i] = Math.max(FLAT_STRIP + 1, cap); partner[side][i] = j }
          }
        })
      }
    }
    round()
    // then rounds against the partner's extent AS IT WILL BE DRAWN (its own cap ∧ the last round's
    // cap, slope-limited along s), until the caps settle: each side moves to the other's edge,
    // and where both were short of their bisector the two would otherwise overshoot each other
    const prevRaw = { 1: new Float32Array(n), '-1': new Float32Array(n) }
    for (let it = 0; it < 6; it++) {
      const lim = { 1: new Float32Array(n), '-1': new Float32Array(n) }
      const step = EXTENT_SLOPE * ds
      for (const side of [1, -1] as const) {
        const w = lim[side]
        for (let i = 0; i < n; i++) w[i] = Math.min(ownCap(i, side), raw[side][i]! - BISECTOR_MARGIN)
        for (let pass = 0; pass < 2; pass++) {
          for (let k = 1; k <= n; k++) {
            const i = pass === 0 ? k % n : (n - k) % n
            const j = pass === 0 ? (i - 1 + n) % n : (i + 1) % n
            if (w[i]! > w[j]! + step) w[i] = w[j]! + step
          }
        }
        prevRaw[side].set(raw[side])
      }
      limited = lim
      round()
      let moved = 0
      for (const side of [1, -1] as const) for (let i = 0; i < n; i++) moved = Math.max(moved, Math.abs(Math.min(raw[side][i]!, EXTENT_MAX) - Math.min(prevRaw[side][i]!, EXTENT_MAX)))
      if (DEBUG_CAP !== null) console.info(`[gp-debug] bisector round ${it + 2}: caps moved by ${moved.toFixed(2)} m at most`)
      if (moved < 0.05) break
    }
    // running min over ±10 m then a box smooth, clamped back to the bound (the fold-table idiom)
    const R = Math.round(10 / ds)
    for (const side of [1, -1] as const) {
      const src = raw[side], out = bisector[side]
      const mins = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        let m = Infinity
        for (let d = -R; d <= R; d++) m = Math.min(m, src[(i + d + n * 2) % n]!)
        mins[i] = m
      }
      for (let i = 0; i < n; i++) {
        let sum = 0
        for (let d = -R; d <= R; d++) sum += mins[(i + d + n * 2) % n]!
        out[i] = Math.min(sum / (2 * R + 1), mins[i]!)
      }
    }
  }
  lap('fold+bisector')
  const bisectorCap = (s: number, side: Side) => sampleAt(bisector[side], s)
  /** the facing centreline sample of station s on `side`, or −1 */
  const bisectorPartner = (s: number, side: Side): number => partner[side][Math.round(track.wrap(s) / ds) % n]!

  // --- the extent: declared ∧ fold ∧ bisector ∧ crossover ------------------------------------------
  /**
   * How far the world rings reach along the station ray at s (m beyond the road edge), per metre
   * of the lap: an area that lies beside the road is rastered out to its far edge, not only to
   * the verge width, so the ground is one mesh there (the paddock, a sand bed beyond 34 m).
   */
  const ringReach = { 1: new Float32Array(Math.ceil(L)), '-1': new Float32Array(Math.ceil(L)) }
  const ringReachAt = (s: number, side: Side): number => {
    const t = ringReach[side]
    const u = track.wrap(s)
    const i = Math.floor(u) % t.length
    const f = u - Math.floor(u)
    return t[i]! * (1 - f) + t[(i + 1) % t.length]! * f
  }
  const nearCrossing = (s: number) => Math.abs(signedDelta(sOver, s, L)) < CROSS_WINDOW || Math.abs(signedDelta(sUnder, s, L)) < CROSS_WINDOW
  const extentParts = (s: number, side: Side) => {
    const hw = track.halfWidthAt(s)
    let declared = Math.min(EXTENT_MAX, Math.max(VERGE_MIN, layout.declaredOuter(s, side) - hw, areaOuter(s, side) - hw, ringReachAt(s, side)))
    const meet = bisectorCap(s, side)
    // the crossover: the verge reaches the facing road's edge when it is within CROSS_BRIDGE beyond the declared width
    if (meet < declared + CROSS_BRIDGE && nearCrossing(s)) declared = Math.max(declared, Math.min(EXTENT_MAX, meet))
    const fold = foldSafe(s, side)
    const bis = meet - BISECTOR_MARGIN
    const bridge = crossoverCap(s)
    return { declared, fold, bis, bridge }
  }
  const extentRaw = (s: number, side: Side): number => {
    const p = extentParts(s, side)
    return Math.max(0, Math.min(p.declared, p.fold, p.bis, p.bridge))
  }
  const capRaw = (s: number, side: Side): ResidueEntry['cap'] | null => {
    const p = extentParts(s, side)
    const w = Math.min(p.declared, p.fold, p.bis, p.bridge)
    if (p.declared <= w + 1e-6) return null
    if (w === p.bridge) return 'BRIDGE'
    if (w === p.fold) return 'FOLD'
    if (w === p.bis) return 'BISECTOR'
    return 'WIDTH'
  }
  /*
   * The extent per metre of the lap, SLOPE-LIMITED: it may grow or shrink by at most EXTENT_SLOPE
   * metres per metre of s. Every cap used to step — a band's square end, the fold cap releasing
   * within a row, the bridge ramp at 2.75 m/m — and the raster's extent edge across such a step was
   * one triangle edge tens of metres long (33.7 m at the paddock's end). A ramp inherits the cap it
   * ramps down to, so the stitch runs and the residue accounting still see it as that cap.
   */
  const extentTable = { 1: new Float32Array(Math.ceil(L)), '-1': new Float32Array(Math.ceil(L)) }
  const capTable = { 1: new Int8Array(Math.ceil(L)), '-1': new Int8Array(Math.ceil(L)) }
  const CAP_CODE: Record<string, number> = { BRIDGE: 3, FOLD: 1, BISECTOR: 2, WIDTH: 4 }
  const CAP_NAME: (ResidueEntry['cap'] | null)[] = [null, 'FOLD', 'BISECTOR', 'BRIDGE', 'WIDTH']
  const buildExtentTable = () => {
    const N = extentTable[1].length
    for (const side of [1, -1] as const) {
      const w = extentTable[side], c = capTable[side]
      for (let i = 0; i < N; i++) { w[i] = extentRaw(i, side); c[i] = CAP_CODE[capRaw(i, side) ?? ''] ?? 0 }
      for (let pass = 0; pass < 2; pass++) {
        for (let k = 1; k <= N; k++) {
          const i = pass === 0 ? k % N : (N - k) % N
          const j = pass === 0 ? (i - 1 + N) % N : (i + 1) % N
          if (w[i]! > w[j]! + EXTENT_SLOPE) { w[i] = w[j]! + EXTENT_SLOPE; c[i] = c[j]! }
        }
      }
    }
  }
  const tableAt = (tbl: Float32Array, s: number): number => {
    const u = track.wrap(s)
    const i = Math.floor(u) % tbl.length
    const f = u - Math.floor(u)
    return tbl[i]! * (1 - f) + tbl[(i + 1) % tbl.length]! * f
  }
  const extent = (s: number, side: Side): number => tableAt(extentTable[side], s)
  /** the station table the drawn extent reads; set once the stations are final */
  let drawnStations: Float64Array | null = null
  let drawnW: { 1: Float64Array; '-1': Float64Array } | null = null
  const _e0 = new THREE.Vector3(), _e1 = new THREE.Vector3(), _o = new THREE.Vector3()
  /** the drawn extent per exact (s, side) once the stations are final — the mesh asks once per cell, ~50 cells a row */
  const drawnMemo = { 1: new Map<number, number>(), '-1': new Map<number, number>() }
  const extentDrawn = (s: number, side: Side): number => {
    if (!drawnStations || !drawnW) return extent(s, side)
    const memo = drawnMemo[side]
    const hit = memo.get(s)
    if (hit !== undefined) return hit
    const v = extentDrawnAt(s, side)
    memo.set(s, v)
    return v
  }
  const extentDrawnAt = (s: number, side: Side): number => {
    const st = drawnStations!, dW = drawnW!
    const m = st.length
    const sw = track.wrap(s)
    const j = indexAtOrAfter(st, sw)
    const i = (j - 1 + m) % m
    const si = st[i]!, sj = st[j]!
    const Wi = dW[side][i]!, Wj = dW[side][j]!
    if (Math.abs(Wi - Wj) < 0.02) return Wi + (Wj - Wi) * 0.5
    track.pointAt(si, side * (track.halfWidthAt(si) + Wi), _e0, 0)
    track.pointAt(sj, side * (track.halfWidthAt(sj) + Wj), _e1, 0)
    const hw = track.halfWidthAt(sw)
    track.pointAt(sw, side * hw, _o, 0)
    track.pointAt(sw, side * (hw + 1), _v, 0)
    const nx = _v.x - _o.x, nz = _v.z - _o.z
    const ex = _e1.x - _e0.x, ez = _e1.z - _e0.z
    const den = nx * ez - nz * ex
    if (Math.abs(den) < 1e-9) return extent(s, side)
    const rx = _e0.x - _o.x, rz = _e0.z - _o.z
    const tt = (rx * ez - rz * ex) / den
    const lam = (rx * nz - rz * nx) / den
    if (lam < -0.05 || lam > 1.05 || tt < 0) return extent(s, side)
    return tt
  }
  const extentCap = (s: number, side: Side): ResidueEntry['cap'] | null => CAP_NAME[capTable[side][Math.round(track.wrap(s)) % capTable[side].length]!] ?? null

  // --- world rings: areas by precedence, then the lanes ---------------------------------------------
  const rings: RingOwner[] = []
  GROUND_AREAS.forEach((area, index) => {
    const ring = resolveFootprint(track, area.footprint, opts.cuts)
    if (!ring) {
      console.error(`[ground-plan] "${area.name}": footprint resolves to nothing`)
      return
    }
    rings.push({ owner: owner(area.kind, area.name, area.layer ?? 0, index), ring, area })
  })
  OFFSET_LANES.forEach((def, index) => {
    const ring = laneFootprint(track, def)
    if (ring) rings.push({ owner: owner('lane', def.name, 0, index), ring, lane: def })
  })
  rings.sort((a, b) => (ownerBeats(a.owner, b.owner) ? -1 : 1))
  {
    // the reach is measured against the caps alone (fold / bisector / bridge), never the verge
    // width, and only for rings that actually touch the ray inside the caps
    const N = ringReach[1].length
    for (let i = 0; i < N; i++) {
      for (const side of [1, -1] as const) {
        const p = extentParts(i, side)
        const limit = Math.min(p.fold, p.bis, p.bridge)
        // only ground CONTIGUOUS with the verge extends the raster: intervals are chained outward
        // from the declared extent, and a ring that starts beyond it (the South Course, a kart
        // track 100 m out) stays a world polygon
        const hw = track.halfWidthAt(i)
        const base = Math.min(limit, Math.max(VERGE_MIN, layout.declaredOuter(i, side) - hw, areaOuter(i, side) - hw))
        const ivs: [number, number][] = []
        // a cut corridor never extends the raster: it is a trench across the verge, not verge —
        // rastered where the declared extent covers it, a world part beyond (the works road's
        // ramps run 66 / 107 m out; rastering out to them bulged the pit straight's raster into
        // the bisector with the S-curve leg and re-paired the stitch strips at the wrap, which
        // left a hairline crack 100 m away in the paddock band)
        for (const r of rings) { if (r.area && 'cut' in r.area.footprint) continue; for (const h of rayHitRing(track, i, side, r.ring, limit)) ivs.push(h) }
        ivs.sort((a, b) => a[0] - b[0])
        // a terrain gap of up to RING_BRIDGE metres between the verge and an area is bridged by
        // raster grass, so the area beyond it is one mesh with the verge
        let reach = base
        let grew = true
        while (grew) {
          grew = false
          for (const [a, b] of ivs) if (a <= reach + RING_BRIDGE && b > reach) { reach = b; grew = true }
        }
        ringReach[side][i] = reach
      }
    }
    // smooth the reach a little so the extent does not step from station to station
    const smoothReach = () => {
      for (const side of [1, -1] as const) {
        const src = ringReach[side]
        const out = new Float32Array(N)
        for (let i = 0; i < N; i++) {
          let m = 0
          for (let d = -2; d <= 2; d++) m = Math.max(m, src[(i + d + N) % N]!)
          out[i] = m
        }
        ringReach[side] = out
      }
    }
    smoothReach()
    // SYMMETRY: where one stretch's ground reaches its bisector, the facing stretch's raster is
    // brought to the same bisector, so the only gap between the two is the stitch strip
    for (let pass = 0; pass < 2; pass++) {
      const force: { 1: Float32Array; '-1': Float32Array } = { 1: new Float32Array(N), '-1': new Float32Array(N) }
      for (let i = 0; i < N; i++) {
        for (const side of [1, -1] as const) {
          const p = extentParts(i, side)
          if (p.declared < p.bis) continue
          const j = bisectorPartner(i, side)
          if (j < 0) continue
          const sj = j * ds
          const dx = track.px[Math.round(i / ds) % n]! - track.px[j]!, dz = track.pz[Math.round(i / ds) % n]! - track.pz[j]!
          const pSide: Side = dx * track.nx[j]! + dz * track.nz[j]! > 0 ? 1 : -1
          const k = Math.round(sj) % N
          const want = bisectorCap(sj, pSide)
          for (let d = -2; d <= 2; d++) { const kk = (k + d + N) % N; if (want > force[pSide][kk]!) force[pSide][kk] = want }
        }
      }
      for (const side of [1, -1] as const) for (let i = 0; i < N; i++) if (force[side][i]! > ringReach[side][i]!) ringReach[side][i] = force[side][i]!
    }
    // SLOPE LIMIT: the extent may grow or shrink by at most REACH_SLOPE metres per metre of s. A
    // ring's reach used to step from the verge width to the ring's far edge within one metre, and
    // the raster's extent chord between two stations there — 30 m of lateral over 0.85 m of s —
    // does not follow the ray-linear extent on a curved road (the outer ray is stretched by the
    // frame's Jacobian), leaving a sliver of bare ground between the chord and the plan. A gentle
    // ramp keeps the two within centimetres; the extra raster is grass over grass.
    for (const side of [1, -1] as const) {
      const r = ringReach[side]
      for (let pass = 0; pass < 2; pass++) {
        for (let k = 1; k <= N; k++) {
          const i = pass === 0 ? k % N : (N - k) % N
          const j = pass === 0 ? (i - 1 + N) % N : (i + 1) % N
          if (r[i]! > r[j]! + REACH_SLOPE) r[i] = r[j]! + REACH_SLOPE
        }
      }
    }
  }

  buildExtentTable()

  // --- stations ---------------------------------------------------------------------------------
  const wanted: number[] = []
  const stats = { base: n, endpoints: 0, kinks: 0, rows: 0, tips: 0, crossings: 0, snapped: 0, chord: 0, chordBy: {} as Record<string, number>, rings: rings.length, worldOnly: 0, residual: 0, residualMax: 0, buildMs: 0, timing, passes: [] as number[], cutRows: 0 }
  lap('rings')
  for (let i = 0; i < n; i++) wanted.push(i * ds)
  const endpoint = (s: number) => { wanted.push(track.wrap(s)); stats.endpoints++ }
  // a kerb's end: the column-convergence zone outside the span, then the height ramp inside it in
  // KERB_TAPER_STEPS rows — the ramp is (height profile) × (taper), bilinear across a cell, and a
  // triangle chords a bilinear cell by ΔhΔt/9: the back cell's 85 mm × a whole 0.5 m ramp is 9 mm,
  // eight rows (6.25 cm, above the 5 cm station thinning) bring it to 1.2 mm under the road frame's 2 mm
  for (const k of kerbs) {
    for (const s of [k.from - KERB_TAPER, k.from, k.to, k.to + KERB_TAPER]) endpoint(s)
    for (let j = 1; j <= KERB_TAPER_STEPS; j++) { endpoint(k.from + (KERB_TAPER * j) / KERB_TAPER_STEPS); endpoint(k.to - (KERB_TAPER * j) / KERB_TAPER_STEPS) }
  }
  for (const s of [pit.entryS, pit.entryS + PIT_TAPER, pit.exitS - PIT_TAPER, pit.exitS, pit.limitStartS - 40, pit.limitStartS - 40 + PIT_TAPER, pit.limitEndS - PIT_TAPER, pit.limitEndS, pit.entryS + pit.entryRamp, pit.exitS - pit.exitRamp]) endpoint(s)
  for (const r of runs) { endpoint(r.from); endpoint(r.to) }
  for (const s of [sOver - DECK_REACH, sOver - DECK_REACH + 0.1, sOver + DECK_REACH - 0.1, sOver + DECK_REACH, sOver - 19, sOver + 19]) endpoint(s)
  for (const s of opts.extraStations ?? []) endpoint(s)
  // the cut corridors (R6): a row every metre across each corridor's s extent (in its window),
  // so a wall along the rays is chorded over a metre and a 3.5 m stair pit has rows inside it —
  // the ring's tips alone gave a pit no interior row, and its floor was drawn 2.4 m too high
  for (const c of opts.cuts?.corridors ?? []) {
    const [w0, w1] = c.def.window
    let d0 = Infinity, d1 = -Infinity
    for (const q of c.samples) {
      const w = Math.max(q.wl, q.wr)
      for (const [x, z] of [[q.x, q.z], [q.x + w, q.z], [q.x - w, q.z], [q.x, q.z + w], [q.x, q.z - w]] as const) {
        const d = forwardDelta(w0, track.nearestOnRange(x, z, w0, w1, 60).s, L)
        if (d < d0) d0 = d
        if (d > d1) d1 = d
      }
    }
    // on the half metre: a row on a whole metre coincides with the census lattice (surface-check
    // G1 samples every metre of s), and a lattice point exactly on a sliver's edge at a ring
    // corner fell through a microscopic gap between two float32 triangles
    for (let d = Math.ceil(d0) + 0.5; d <= d1; d += 1) endpoint(w0 + d)
    stats.cutRows += Math.max(0, Math.floor(d1 - 0.5) - Math.ceil(d0) + 1)
  }
  // kinks of the extent table: the extent is linear between integer metres, so a station at
  // every metre where its slope changes makes the raster's extent chord follow it exactly (without
  // them the chord across a rise cut a corner off the raster, which no face covered)
  for (const side of [1, -1] as const) {
    const r = extentTable[side]
    const N = r.length
    for (let i = 0; i < N; i++) {
      const bend = r[(i + 1) % N]! - 2 * r[i]! + r[(i - 1 + N) % N]!
      if (Math.abs(bend) > 0.1) { endpoint(i); stats.kinks++ }
    }
  }
  // rows by their outer chord: on the outside of a bend the frame's Jacobian stretches a 2 m row
  // to 6–8 m at the extent, and with 5 m fills the cell diagonal outgrows the terrain grid's half
  // (the hairpin's outside, the chicane); such a row is halved until its chord is ≤ MAX_ROW_CHORD
  {
    const chord = (s0: number, s1: number, side: Side): number => {
      track.pointAt(s0, side * (track.halfWidthAt(s0) + extent(s0, side)), _v, 0)
      const x = _v.x, z = _v.z
      track.pointAt(s1, side * (track.halfWidthAt(s1) + extent(s1, side)), _v, 0)
      return Math.hypot(_v.x - x, _v.z - z)
    }
    const split = (s0: number, s1: number, depth: number) => {
      if (depth > 4 || s1 - s0 < 0.5) return
      if (chord(s0, s1, 1) <= MAX_ROW_CHORD && chord(s0, s1, -1) <= MAX_ROW_CHORD) return
      const sm = (s0 + s1) / 2
      endpoint(sm)
      stats.rows++
      split(s0, sm, depth + 1)
      split(sm, s1, depth + 1)
    }
    for (let i = 0; i < n; i++) split(i * ds, (i + 1) * ds, 0)
  }
  // ring tips per side: the s extremes of the ring's vertices on that side of the road
  const ringSpan = new Map<RingOwner, { 1: [number, number] | null; '-1': [number, number] | null }>()
  for (const r of rings) {
    const span: { 1: [number, number] | null; '-1': [number, number] | null } = { 1: null, '-1': null }
    const pts = [r.ring.outer, ...r.ring.holes].flat()
    let near = false
    for (const side of [1, -1] as const) {
      let s0 = Infinity, s1 = -Infinity, any = false
      // extremes measured as forward distance from the window start, so a wrapped window is monotone
      const w0 = r.ring.sRange ? r.ring.sRange[0] : 0
      for (const p of pts) {
        const m = r.ring.sRange ? track.nearestOnRange(p.x, p.z, r.ring.sRange[0], r.ring.sRange[1], 60) : projectGlobal(track, p.x, p.z)
        if (Math.sign(m.lateral) !== side) continue
        if (Math.abs(m.lateral) - track.halfWidthAt(m.s) > EXTENT_MAX + 5) continue
        near = true
        any = true
        const d = forwardDelta(w0, m.s, L)
        if (d < s0) s0 = d
        if (d > s1) s1 = d
      }
      if (any) {
        span[side] = [track.wrap(w0 + s0), track.wrap(w0 + s1)]
        wanted.push(track.wrap(w0 + s0), track.wrap(w0 + s1))
        stats.tips += 2
      }
    }
    if (!near) stats.worldOnly++
    ringSpan.set(r, span)
  }

  let stations = dedupStations(wanted, L, 0.05, ds)
  lap('stations')

  // --- owners (used by the columns to decide which of them are real boundaries) -------------------
  const hwOf = (s: number) => track.halfWidthAt(s)
  const pitSpanOf = pitLaneSpan(track, pit)
  /** the kerb at the exact (s, side) — pure in both, asked ~200 times per station by the columns and ~50 times per row by the mesh */
  const kerbExact = { 1: new Map<number, { width: number; taper: number; spread: number }>(), '-1': new Map<number, { width: number; taper: number; spread: number }>() }
  const kerbAtExact = (s: number, side: Side) => {
    const memo = kerbExact[side]
    let k = memo.get(s)
    if (!k) { k = kerbAt(kerbs, track, s, side); memo.set(s, k) }
    return k
  }
  const ownerAtSL = (s: number, side: Side, off: number, inRaster = false, at?: { x: number; z: number }): Owner => {
    if (off < 0) return ROAD
    const hw = hwOf(s)
    const W = extentDrawn(s, side)
    if (off > W + 1e-6 && !inRaster) {
      if (at) _v.set(at.x, 0, at.z)
      else track.pointAt(s, side * (hw + off), _v, 0)
      let best: Owner | null = null
      // the rings are in precedence order: once one holds the point, none below it can win, and
      // the (cheap) precedence test goes first so their point tests are not run at all
      for (const r of rings) if ((!best || ownerBeats(r.owner, best)) && inWorldRing(_v.x, _v.z, r.ring)) best = r.owner
      return best ?? TERRAIN
    }
    const kb = kerbAtExact(s, side)
    if (off < kb.width * kb.spread) return KERB
    if (off < deckShoulderAt(track, s)) return DECK
    if (side < 0) {
      const [pin, pout, aout] = pitSpanOf(s, hw)
      if (off >= pin && off < pout) return PIT_LANE
      if (off >= pout && off < aout) return PIT_APRON
    }
    // the rings are drawn in XZ (a column is where the station's ray crosses the ring, so the
    // cell edge between two stations lies ON the ring's edge), and a caller that holds the world
    // point is answered on it: rebuilding the point from (s, off) is `nearestOnRange`'s round
    // trip, which is not pointAt's inverse — 0.3 m out at 40–70 m lateral on a bend (the
    // per-sample normals are C0), enough to put a point of the T3 lot's tip or the T1 pond's
    // shore on the other side of the ring (the census read grass over drawn paddock / water)
    if (at) _v.set(at.x, 0, at.z)
    else track.pointAt(s, side * (hw + off), _v, 0)
    let best: Owner | null = null
    for (const r of rings) if ((!best || ownerBeats(r.owner, best)) && inWorldRing(_v.x, _v.z, r.ring)) best = r.owner
    if (best) return best
    const g = layout.gravel(s, side)
    if (g && hw + off >= g[0] && hw + off < g[1]) return GRAVEL_BAND
    if (hw + off < Math.min(layout.asphaltOuter(s, side), hw + W)) return ASPHALT_BAND
    return GRASS
  }

  // --- columns per side ---------------------------------------------------------------------------
  // The station set grows pass by pass, but every primitive below is a function of (side, s)
  // alone, so it is cached across passes: a re-evaluation only pays for the stations it gained.
  // The memo keys are integers: s at 1 mm and a side bit (s < 5,808 m → under 2^24), the offset
  // at 1 mm (under 2^18), the extent at 1 cm (under 2^14), the ring's index (under 2^8) — the
  // same quantisation the string keys had (fixedKey), packed so every key stays a safe integer.
  const stationKey = (s: number, side: Side): number => fixedKey(s, 3) * 2 + (side > 0 ? 1 : 0)
  const hitCache = new Map<number, [number, number][]>()
  const ringIndex = new Map<WorldRing, number>(rings.map((r, i) => [r.ring, i]))
  const rayHit = (s: number, side: Side, r: WorldRing, W: number): [number, number][] => {
    const key = ((ringIndex.get(r) ?? 255) * 16777216 + stationKey(s, side)) * 16384 + fixedKey(W, 2)
    let h = hitCache.get(key)
    if (!h) { h = rayHitRing(track, s, side, r, W); hitCache.set(key, h) }
    return h
  }
  /** per station key: the real verdict per offset key (mm) */
  const realCache = new Map<number, Map<number, number>>()
  const kerbCache = new Map<number, { width: number; taper: number; spread: number }>()
  const kerbAtCached = (s: number, side: Side) => {
    const key = stationKey(s, side)
    let k = kerbCache.get(key)
    if (!k) { k = kerbAt(kerbs, track, s, side); kerbCache.set(key, k) }
    return k
  }

  const evalSide = (side: Side, st: Float64Array): PlanSide => {
    const m = st.length
    const W = new Float64Array(m)
    const cap = new Uint8Array(m)
    const hwA = new Float64Array(m)
    for (let i = 0; i < m; i++) {
      const s = st[i]!
      hwA[i] = track.halfWidthAt(s)
      W[i] = extent(s, side)
      const c = extentCap(s, side)
      cap[i] = c === 'FOLD' ? 1 : c === 'BISECTOR' ? 2 : c === 'BRIDGE' ? 3 : c === 'WIDTH' ? 4 : 0
    }
    const columns: Column[] = []
    const col = (id: string, role: Column['role'], active: Column['active'], f: (i: number, s: number) => number): Column => {
      const off = new Float64Array(m)
      for (let i = 0; i < m; i++) off[i] = Math.min(W[i]!, Math.max(0, f(i, st[i]!)))
      const c: Column = { id, role, off, active, real: new Uint8Array(m) }
      columns.push(c)
      return c
    }
    col('edge', 'edge', null, () => 0)
    // kerb profile columns (collapsed at 0 where there is no kerb): the profile once per station
    const kcs: [number, number, number, number][] = []
    for (let i = 0; i < m; i++) { const k = kerbAtCached(st[i]!, side); kcs.push(kerbColumns(k.width, k.spread)) }
    col('kerb.ramp', 'kerb', null, (i) => kcs[i]![0])
    col('kerb.crown', 'kerb', null, (i) => kcs[i]![1])
    col('kerb.back', 'kerb', null, (i) => kcs[i]![2])
    col('kerb.out', 'kerb', null, (i) => kcs[i]![3])
    // the crossover deck shoulder
    col('deck.out', 'deck', null, (_i, s) => deckShoulderAt(track, s))
    // the road plane's crossfall breaks at |lateral| = ROLL_CAP (track.ts rollLift: the full
    // camber inside it, a fifth beyond): a road-frame cell straddling it — the pit lane at its
    // entry — chorded the kink by 8 mm, so the kink is a column of its own
    col('roll.cap', 'kink', null, (i, _s) => ROLL_CAP - hwA[i]!)
    // the pit lane and the garage apron (right side, over their windows; collapsed at 0 elsewhere)
    if (side < 0) {
      const pl = pitLaneSpan(track, pit)
      col('pit.in', 'pit', null, (i, s) => pl(s, hwA[i]!)[0])
      col('pit.out', 'pit', null, (i, s) => pl(s, hwA[i]!)[1])
      col('apron.out', 'pit', null, (i, s) => pl(s, hwA[i]!)[2])
    }
    // the run-off bands
    col('band.asphalt', 'band', null, (i, s) => layout.asphaltOuter(s, side) - hwA[i]!)
    col('band.gravel.in', 'band', null, (i, s) => layout.gravelInner(s, side) - hwA[i]!)
    col('band.gravel.out', 'band', null, (i, s) => { const g = layout.gravel(s, side); return (g ? g[1] : layout.gravelInner(s, side)) - hwA[i]! })
    // rings: every station whose ray can reach the ring's box is a candidate — a ring lives on
    // its own stretch of road, but the figure-8 puts other stretches within its reach (the paddock
    // behind the pit building is 125 m from the straight and beside NIPPO's outside). The ray's
    // box (its road-edge and extent points) is the station's, computed once for all the rings.
    const rayX0 = new Float64Array(m), rayX1 = new Float64Array(m), rayZ0 = new Float64Array(m), rayZ1 = new Float64Array(m)
    for (let i = 0; i < m; i++) {
      const s = st[i]!
      const hw = hwA[i]!
      track.pointAt(s, side * hw, _v, 0)
      const x0 = _v.x, z0 = _v.z
      track.pointAt(s, side * (hw + W[i]!), _v, 0)
      const x1 = _v.x, z1 = _v.z
      rayX0[i] = Math.min(x0, x1); rayX1[i] = Math.max(x0, x1); rayZ0[i] = Math.min(z0, z1); rayZ1[i] = Math.max(z0, z1)
    }
    for (const r of rings) {
      const b = r.ring.box
      const order: number[] = []
      for (let i = 0; i < m; i++) {
        if (rayX1[i]! < b[0] || rayX0[i]! > b[1] || rayZ1[i]! < b[2] || rayZ0[i]! > b[3]) continue
        order.push(i)
      }
      if (!order.length) continue
      /*
       * Intervals are TRACKED across stations so a column keeps following the same piece of ring
       * boundary: matching by overlap (a new interval starts a new track, a track that finds no
       * match ends). Each track is one column pair, active over its own station range and
       * collapsed at its first / last position outside it, where it is a free vertex.
       */
      interface Tr { start: number; end: number; iv: ([number, number] | null)[] }
      const tracks: Tr[] = []
      let open: Tr[] = []
      // candidates may be several separate runs of stations (two stretches): a gap in the
      // candidate list ends every open track
      let prevI = -2
      for (const i of order) {
        if (i !== prevI + 1) open = []
        prevI = i
        const h = rayHit(st[i]!, side, r.ring, W[i]!)
        if (h.length > MAX_RING_INTERVALS) throw new Error(`[ground-plan] "${r.owner.name}" crosses one station ray ${h.length} times on side ${side} — split the row`)
        const next: Tr[] = []
        const used = new Set<number>()
        // a track continues into the one interval it overlaps, when that interval overlaps no
        // other track. Two tracks meeting one interval (a notch closing: the pit-in slip lane at
        // s 5141.6) or one track meeting two (a notch opening) END here and the intervals start
        // fresh tracks: continued, the survivor's in column jumped 4 m within a 2 cm row and no
        // station could resolve the crossings it made (a 3.7 m residual, snapped)
        const overlapOf = (iv: [number, number], last: [number, number]) => Math.min(iv[1], last[1]) - Math.max(iv[0], last[0])
        const meets = (t: Tr): number[] => { const last = t.iv[t.iv.length - 1]!; const out: number[] = []; h.forEach((iv, k) => { if (overlapOf(iv, last) > 0.05) out.push(k) }); return out }
        const hits = open.map(meets)
        const tracksOn = h.map((_iv, k) => hits.filter((ks) => ks.includes(k)).length)
        open.forEach((t, ti) => {
          const ks = hits[ti]!
          let best = -1
          if (ks.length === 1 && tracksOn[ks[0]!] === 1) best = ks[0]!
          else if (ks.length === 0) {
            // no overlap: the interval that slid just past it, if that one is otherwise free
            const last = t.iv[t.iv.length - 1]!
            let bo = -0.5
            h.forEach((iv, k) => { if (used.has(k) || tracksOn[k]! > 0) return; const o = overlapOf(iv, last); if (o > bo) { best = k; bo = o } })
          }
          if (best >= 0 && !used.has(best)) { used.add(best); t.iv.push(h[best]!); t.end = i; next.push(t) }
        })
        h.forEach((iv, k) => { if (!used.has(k)) { const t: Tr = { start: i, end: i, iv: [iv] }; tracks.push(t); next.push(t) } })
        open = next
      }
      if (!tracks.length) continue
      tracks.forEach((t, k) => {
        const key = `${r.owner.kind}:${r.owner.name}#${k}`
        const rel = (a: number, b: number) => (b >= a ? b - a : b + m - a)
        const len = rel(t.start, t.end)
        // the parked positions outside the track (below): the nearer end's interval edge snapped
        // onto the fill column just INSIDE the interval (the in edge up, the out edge down), so it
        // coincides with a vertex the row has anyway and costs no cell of its own, and the parked
        // pair never reaches past the ring: parked outward, the pair at the station before a tip
        // spanned [fill below in, fill above out], and the row to the tip was a sliver of the
        // ring's kind 2.5 m beyond it (the pit exit yard at s 103). Four constants per track.
        const parkIn = (edge: number): number => { for (const fo of FILL_OFFS) if (fo >= edge - 1e-6) return fo; return edge }
        const parkOut = (edge: number): number => { let best = 0; for (const fo of FILL_OFFS) if (fo <= edge + 1e-6) best = fo; return best }
        const first = t.iv[0]!, last = t.iv[t.iv.length - 1]!
        const parkedFirst: [number, number] = [parkIn(first[0]), parkOut(first[1])]
        const parkedLast: [number, number] = [parkIn(last[0]), parkOut(last[1])]
        const pos = (i: number, which: 0 | 1): number => {
          // stations inside the track's range index its interval list; outside, each column keeps
          // ITS OWN edge of the nearer end's interval (it is a free vertex there anyway). Collapsing
          // both onto the interval's start made the row before a wide tip — a paddock band's
          // square end, 68 m across — a fan of triangles with 68 m edges.
          const dIn = rel(t.start, i)
          if (dIn <= len) return t.iv[dIn]![which]
          const dAfter = rel(t.end, i), dBefore = rel(i, t.start)
          return (dAfter < dBefore ? parkedLast : parkedFirst)[which]
        }
        // one station of margin either side so the tip vertex belongs to both adjacent rows
        const active: [number, number] = [(t.start - 1 + m) % m, (t.end + 1) % m]
        col(`${key}.in`, 'ring', active, (i) => pos(i, 0))
        col(`${key}.out`, 'ring', active, (i) => pos(i, 1))
      })
    }
    for (const f of FILL_OFFS) col(`fill@${f}`, 'fill', null, () => f)
    col('extent', 'extent', null, (i) => W[i]!)
    // the verdicts are memoised per (station, offset) at 1 mm across the passes (a re-evaluation
    // pays only for the stations it gained); the station's map is looked up once per station
    const realAt: Map<number, number>[] = []
    for (let i = 0; i < m; i++) {
      const key = stationKey(st[i]!, side)
      let mm = realCache.get(key)
      if (!mm) { mm = new Map(); realCache.set(key, mm) }
      realAt.push(mm)
    }
    for (const c of columns) {
      if (c.role === 'fill') continue
      for (let i = 0; i < m; i++) {
        const o = c.off[i]!
        if (c.role === 'extent') { c.real[i] = 1; continue }
        if (o <= 0.005 || o >= W[i]! - 0.005) { c.real[i] = 0; continue }
        // the kerb's profile columns are height breakpoints, not owner boundaries: a free one is
        // dragged by whatever real column passes through the kerb (the asphalt band's edge at
        // T1's exit, the chicane apron's edge) and the cell then chords the profile by 26–76 mm
        if (c.role === 'kerb' || c.role === 'kink') { c.real[i] = 1; continue }
        const mm = realAt[i]!
        const key = fixedKey(o, 3)
        let r = mm.get(key)
        if (r === undefined) {
          r = ownerAtSL(st[i]!, side, o - 0.01).name !== ownerAtSL(st[i]!, side, o + 0.01).name ? 1 : 0
          mm.set(key, r)
        }
        c.real[i] = r
      }
    }
    return { side, columns, W, cap, order: [] }
  }

  /*
   * Station passes: (1) a real boundary whose curve deviates from the chord between two stations by
   * more than CHORD_TOL gets a station at the midpoint (the mesh boundary IS the chord, so this is
   * how far the drawn boundary may stray from the plan's); (2) two real boundaries that cross
   * between stations get a station at the crossing, so the column order is invariant within a
   * row; (3) a real boundary that crosses a FILL column between stations gets a station there
   * too — the fill is free and would simply be clamped aside, but a boundary sweeping across
   * many fills in one row (the pit apron's end moving 50 m over its taper) would turn the row
   * into a fan of 50 m triangles; with a station per fill crossed the cells stay ≤ 4 m across.
   * Collapsed ring columns are free vertices and never cause a station.
   */
  /** how far the drawn boundary (the chord between stations) may stray from the plan's curve */
  const chordDebug = new Map<string, { n: number; max: number; at: number }>()
  const CHORD_TOL = 0.1
  /** a crossing this close to a station (m along s) ties the two columns at the station instead of getting one of its own */
  const SNAP_NEAR = 0.02
  /** ring outlines are polylines with a vertex every ~2 m: a looser bound keeps the station count sane */
  const CHORD_TOL_RING = 0.25
  /** rows shorter than this are slivers: no station is inserted inside them and their bow-ties are ignored */
  const MICRO_ROW = 0.01
  const tipRing = (colId: string): WorldRing | null => {
    const key = colId.replace(/#\d+\.(in|out)$/, '')
    const r = rings.find((q) => `${q.owner.kind}:${q.owner.name}` === key)
    return r ? r.ring : null
  }
  let sides = { 1: evalSide(1, stations), '-1': evalSide(-1, stations) }
  lap('eval0')
  for (let pass = 0; pass < 8; pass++) {
    const extra: number[] = []
    for (const side of [1, -1] as const) {
      const cols = sides[side].columns
      const m = stations.length
      const midSide = pass < 2 ? evalSide(side, Float64Array.from(stations, (v, i) => track.wrap((v + (stations[(i + 1) % m]! + ((i + 1) % m === 0 ? L : 0))) / 2))) : null
      // the midpoint evaluation may carry a different ring column set: match by id
      const mid = midSide ? new Map(midSide.columns.map((c) => [c.id, c])) : null
      // the fill columns (never real) and, per row, the columns that are real boundaries in it:
      // `rowReal` reads roles, ranges and the real flags, none of which a row's snaps change, so
      // it is evaluated once per column and row instead of once per pair
      const fillIdx: number[] = []
      for (let k = 0; k < cols.length; k++) if (cols[k]!.role === 'fill') fillIdx.push(k)
      const rowReals: number[] = []
      for (let i = 0; i < m; i++) {
        const j = (i + 1) % m
        const s0 = stations[i]!, s1 = stations[j]! + (j === 0 ? L : 0)
        if (s1 - s0 < MICRO_ROW) continue
        rowReals.length = 0
        for (let a = 0; a < cols.length; a++) if (rowReal(cols[a]!, i, j)) rowReals.push(a)
        if (mid && s1 - s0 > 0.2) {
          for (const a of rowReals) {
            const c = cols[a]!
            const chord = (c.off[i]! + c.off[j]!) / 2
            // a ring column is checked against the ring itself at the row's midpoint — the nearest
            // edge of its intervals there — not against the midpoint evaluation's column of the
            // same id: track ids are re-assigned per evaluation, and a merge or a tip renumbers
            // them (the T1 pond's edge then kept a 1.7 m chord at s 150)
            let dev = 0
            if (c.role === 'ring') {
              const ring = tipRing(c.id)
              if (!ring) continue
              const sm = track.wrap((s0 + s1) / 2)
              const which = c.id.endsWith('.in') ? 0 : 1
              dev = Infinity
              for (const iv of rayHit(sm, side, ring, extent(sm, side))) dev = Math.min(dev, Math.abs(iv[which]! - chord))
              if (dev === Infinity) continue
            } else {
              const mc = mid.get(c.id)
              if (!mc) continue
              dev = Math.abs(mc.off[i]! - chord)
            }
            if (dev > (c.role === 'ring' ? CHORD_TOL_RING : CHORD_TOL)) {
              extra.push(track.wrap((s0 + s1) / 2))
              stats.chord++
              stats.chordBy[c.role] = (stats.chordBy[c.role] ?? 0) + 1
              if (c.role === 'ring' && pass === 0) { const k = c.id; const e = chordDebug.get(k) ?? { n: 0, max: 0, at: 0 }; e.n++; const dv = dev; if (dv > e.max) { e.max = dv; e.at = s0 }; chordDebug.set(k, e) }
              break
            }
          }
        }
        // a ring track whose first or last station already has a wide interval has its true tip
        // between stations: bisect the ray hits to the tip and station it (the tip vertex then
        // exists, instead of the ring starting as a chord one station late)
        if (pass < 2 && i === 0) {
          for (const c of cols) {
            if (c.role !== 'ring' || !c.active || !c.id.endsWith('.in')) continue
            const out = cols.find((d) => d.id === c.id.slice(0, -3) + '.out')
            if (!out) continue
            const first = (c.active[0] + 1) % m, last = (c.active[1] - 1 + m) % m
            for (const [k, dir] of [[first, -1], [last, 1]] as const) {
              if (out.off[k]! - c.off[k]! < 0.15) continue
              const ring = tipRing(c.id)
              if (!ring) continue
              const kn = (k + dir + m) % m
              let sIn = stations[k]!
              let sOut = stations[kn]!
              if (dir > 0 && kn === 0) sOut += L
              if (dir < 0 && k === 0) sIn += L
              for (let it = 0; it < 10; it++) {
                const sm = (sIn + sOut) / 2
                const h = rayHit(track.wrap(sm), side, ring, extent(track.wrap(sm), side))
                if (h.length) sIn = sm
                else sOut = sm
              }
              extra.push(track.wrap((sIn + sOut) / 2))
              stats.tips++
            }
          }
        }
        for (let ra = 0; ra < rowReals.length; ra++) {
          const a = rowReals[ra]!
          // real × real once per pair; real × fill from the real side — the partners b of a are
          // the fills and the real columns after a, visited in ascending column index (the snaps
          // inside write `off`, so the order of the pairs is part of the result)
          let fi = 0, ri = ra + 1
          while (fi < fillIdx.length || ri < rowReals.length) {
            const b = ri >= rowReals.length || (fi < fillIdx.length && fillIdx[fi]! < rowReals[ri]!) ? fillIdx[fi++]! : rowReals[ri++]!
            const cb = cols[b]!
            const da = cols[a]!.off[i]! - cb.off[i]!
            const db = cols[a]!.off[j]! - cb.off[j]!
            if ((da > COLUMN_TIE && db < -COLUMN_TIE) || (da < -COLUMN_TIE && db > COLUMN_TIE)) {
              const t = da / (da - db)
              // a crossing within SNAP_NEAR of a station is at that station: the two columns are
              // tied there (a station a centimetre away would be thinned, and the crossing would
              // then drag a fill or snap a real column metres aside — 8 m edges at the T1 pond)
              const dI = t * (s1 - s0), dJ = (1 - t) * (s1 - s0)
              const near = Math.min(dI, dJ) >= SNAP_NEAR ? -1 : dI <= dJ ? i : j
              if (near >= 0) {
                // the column that gives way: a fill, else the one that is not a kerb breakpoint, else
                // the one whose move does not cross its own partner (a ring's .out tied onto a band
                // edge below the ring's .in inverted the pair — a bow-tie the snap then counted),
                // else the later one
                const ca = cols[a]!
                const partnerOf = (c: Column): Column | undefined => (c.role === 'ring' ? cols.find((d) => d.id === (c.id.endsWith('.in') ? c.id.slice(0, -3) + '.out' : c.id.slice(0, -4) + '.in')) : undefined)
                const inverts = (c: Column, v: number): boolean => { const p = partnerOf(c); if (!p) return false; return c.id.endsWith('.in') ? v > p.off[near]! + COLUMN_TIE : v < p.off[near]! - COLUMN_TIE }
                let mover = cb.role === 'fill' ? cb : ca.role === 'kerb' || ca.role === 'kink' ? cb : cb.role === 'kerb' || cb.role === 'kink' ? ca : cb
                if (mover.role !== 'fill' && inverts(mover, (mover === ca ? cb : ca).off[near]!)) {
                  const alt = mover === ca ? cb : ca
                  if (alt.role !== 'kerb' && alt.role !== 'kink' && !inverts(alt, mover.off[near]!)) mover = alt
                  else { extra.push(track.wrap(s0 + (s1 - s0) * t)); stats.crossings++; continue }
                }
                const other = mover === ca ? cb : ca
                if ((globalThis as { GP_DEBUG_TIE?: boolean }).GP_DEBUG_TIE && Math.abs(mover.off[near]! - other.off[near]!) > 0.5) console.log(`[ground-plan] tie at s ${stations[near]!.toFixed(3)} side ${side}: ${mover.id} ${mover.off[near]!.toFixed(2)} → ${other.id} ${other.off[near]!.toFixed(2)} (row ${s0.toFixed(3)}→${s1.toFixed(3)}, t ${t.toFixed(3)})`)
                mover.off[near] = other.off[near]!
                stats.snapped++
                continue
              }
              extra.push(track.wrap(s0 + (s1 - s0) * t))
              stats.crossings++
            }
          }
        }
      }
    }
    lap('pass-detect')
    stats.passes.push(extra.length)
    // leftover crossings are not worth a full re-evaluation (≈ 0.5 s each) once there are few or
    // once a pass stops removing them (the same sub-5 cm crossings are found again and deduplicated
    // away): the snap below turns them into zero-width cells
    // crossings within the dedup distance of a station cannot add one: they are what the snap
    // below turns into zero-width cells; the passes continue while the others still add stations
    // (a crossing left over is a fill clamped 8 m aside — a long edge in the drawn cell)
    const fresh = dedupStations([...stations, ...extra], L, 0.01, ds).length - stations.length
    if (fresh === 0 || pass === 7) break
    stations = dedupStations([...stations, ...extra], L, 0.01, ds)
    sides = { 1: evalSide(1, stations), '-1': evalSide(-1, stations) }
    lap('pass-eval')
  }
  /*
   * Fills are free vertices: a fill column that a real boundary passes between two stations is
   * clamped onto that boundary at the second station (the cell between them becomes a triangle,
   * the fill is released at the next station by the tie-break below). Real boundaries got a
   * station at every crossing above; the few that still invert (a ring track whose interval
   * splits, jumping metres within a 0.2 m row) are snapped the same way and counted as residual:
   * a zero-width cell there is a sliver with a plausible owner, an inverted one is a bow-tie that
   * folds over its neighbours.
   */
  drawnStations = stations
  drawnW = { 1: sides[1].W, '-1': sides[-1].W }
  let residual = 0
  let residualMax = 0
  const residualLog: string[] = []
  // two sweeps: row i writes station i+1's columns, which row i+1 then orders — except at the
  // wrap, where the last row writes station 0 after row 0 has already ordered it (a bow-tie cell
  // at s 0 on the right, found in P5); the second sweep re-orders every row on the final values
  for (const side of [1, -1] as const) for (let sweep = 0; sweep < 2; sweep++) {
    const cols = sides[side].columns
    const m = stations.length
    // the second sweep re-orders on snapped values: what it snaps again is the same inversion
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m
      const rowLen = stations[j]! + (j === 0 ? L : 0) - stations[i]!
      // ties at station i (a crossing station, a clamped fill) are ordered by where the columns
      // go next, so a fill that has just been passed is released instead of dragged along
      const order = columnOrder(cols, i, j)
      sides[side].order[i] = order
      // (1) free columns below a preceding real one are raised; a real one below a preceding real
      // one is a residual (a crossing the passes above did not resolve)
      let maxReal = -Infinity
      let maxRealId = ''
      let maxRealCol: Column | null = null
      for (let k = 0; k < order.length; k++) {
        const c = cols[order[k]!]!
        if (isFree(c, j)) { if (c.off[j]! < maxReal) c.off[j] = maxReal }
        else {
          if (c.off[j]! < maxReal - COLUMN_TIE) {
            if (rowLen > MICRO_ROW && !sweep) {
              residual++
              residualMax = Math.max(residualMax, maxReal - c.off[j]!)
              if ((maxReal - c.off[j]! > 0.05 || (globalThis as { GP_DEBUG_RESIDUAL?: boolean }).GP_DEBUG_RESIDUAL) && residualLog.length < 12) residualLog.push(`side ${side} s ${stations[i]!.toFixed(1)}→${stations[j]!.toFixed(1)}: ${c.id} ${c.off[i]!.toFixed(2)}→${c.off[j]!.toFixed(2)} under ${maxRealId} (${maxReal.toFixed(2)}) — snapped`)
            }
            // a kerb breakpoint keeps its place (moved, the kerb's profile is chorded by 50 mm);
            // the real column above it comes down to it instead
            if ((c.role === 'kerb' || c.role === 'kink') && maxRealCol && maxRealCol.role !== 'kerb' && maxRealCol.role !== 'kink') { maxRealCol.off[j] = c.off[j]!; maxReal = c.off[j]! }
            else c.off[j] = maxReal
          }
          if (c.off[j]! > maxReal) { maxReal = c.off[j]!; maxRealId = c.id; maxRealCol = c }
        }
      }
      // (2) free columns above a following real one are lowered
      let minReal = Infinity
      for (let k = order.length - 1; k >= 0; k--) {
        const c = cols[order[k]!]!
        if (isFree(c, j)) { if (c.off[j]! > minReal) c.off[j] = minReal }
        else if (c.off[j]! < minReal) minReal = c.off[j]!
      }
      // (3) free columns are also kept in order among themselves
      let maxAll = -Infinity
      for (let k = 0; k < order.length; k++) {
        const c = cols[order[k]!]!
        if (c.off[j]! < maxAll) { if (isFree(c, j)) c.off[j] = maxAll }
        else maxAll = c.off[j]!
      }
    }
  }
  if (residual) console.warn(`[ground-plan] ${residual} real column inversions left after the crossing passes (snapped, worst ${(residualMax * 1000).toFixed(0)} mm)`)
  for (const line of residualLog) console.warn('[ground-plan]   ' + line)
  if (import.meta.dev) for (const [k, e] of [...chordDebug.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 5)) console.info(`[ground-plan] chord ${k}: ${e.n} rows, max ${e.max.toFixed(2)} m at s ${e.at.toFixed(1)}`)
  stats.residual = residual
  stats.residualMax = residualMax
  stats.base = n

  // --- owners in world space --------------------------------------------------------------------------
  const project = (x: number, z: number, window?: [number, number]) => (window ? track.nearestOnRange(x, z, window[0], window[1], 60) : projectGlobal(track, x, z))
  const ownerAt = (x: number, z: number, window?: [number, number]): Owner => {
    const p = project(x, z, window)
    const hw = hwOf(p.s)
    if (Math.abs(p.lateral) <= hw) return ROAD
    const side: Side = p.lateral > 0 ? 1 : -1
    return ownerAtSL(p.s, side, Math.abs(p.lateral) - hw, false, { x, z })
  }

  // --- residue: declared band beyond the extent that no ring covers ----------------------------
  lap('snap')
  const residue: ResidueEntry[] = []
  {
    const zoneAt = (s: number) => RUNOFF_ZONES.find((z) => forwardDelta(z.sRange[0], s, L) <= forwardDelta(z.sRange[0], z.sRange[1], L))
    const acc = new Map<string, ResidueEntry>()
    for (let s = 0; s < L; s += 1) {
      const z = zoneAt(s)
      if (!z) continue
      for (const side of [1, -1] as const) {
        const cap = extentCap(s, side)
        if (!cap) continue
        const hw = hwOf(s)
        const W = extent(s, side)
        const want = layout.declaredOuter(s, side) - hw
        let m2 = 0
        for (let off = W + 0.25; off < want; off += 0.5) {
          track.pointAt(s, side * (hw + off), _v, 0)
          if (!rings.some((r) => inWorldRing(_v.x, _v.z, r.ring))) m2 += 0.5
        }
        if (m2 <= 0) continue
        const key = `${z.name}|${side}|${cap}`
        let e = acc.get(key)
        if (!e) { e = { zone: z.name, side, cap, m2: 0, from: s, to: s }; acc.set(key, e) }
        e.m2 += m2
        e.to = s
      }
    }
    for (const e of acc.values()) residue.push({ ...e, m2: Math.round(e.m2) })
    residue.sort((a, b) => b.m2 - a.m2)
  }

  const hw = new Float64Array(stations.length)
  for (let i = 0; i < stations.length; i++) hw[i] = hwOf(stations[i]!)
  const lattice = (s0: number, s1: number, maxStep: number): number[] => {
    const len = forwardDelta(s0, s1, L) || L
    const a = track.wrap(s0)
    const rows: number[] = [s0]
    // the stations strictly inside (s0, s0 + len), walking forward and wrapping past L
    const i0 = indexAtOrAfter(stations, a)
    for (let n = 0; n < stations.length; n++) {
      let v = stations[(i0 + n) % stations.length]! - a
      if (v < 0) v += L
      if (v >= len - 1e-6) break
      if (v > 1e-6) rows.push(s0 + v)
    }
    rows.push(s0 + len)
    const out: number[] = [rows[0]!]
    for (let k = 1; k < rows.length; k++) {
      const p = out[out.length - 1]!, q = rows[k]!
      const parts = Math.max(1, Math.ceil((q - p) / maxStep - 1e-9))
      for (let j = 1; j <= parts; j++) out.push(p + ((q - p) * j) / parts)
    }
    return out
  }
  lap('residue')
  stats.buildMs = performance.now() - t0
  return {
    track, stations, hw, sides, layout, gravelRuns: runs, kerbs, rings, foldSafe, extent, extentDrawn, extentCap, bisectorPartner,
    ownerAtSL, ownerAt, project, residue,
    stationIndexAt: (s: number) => indexAtOrAfter(stations, track.wrap(s)),
    lattice,
    stats,
  }
}

/**
 * The pit lane [in, out] and the garage apron's outer edge (metres beyond the right road edge) at
 * s, all continuous in s: the lane centreline ramps in and out with `pitLateralAt`, and the ends
 * of the lane window and of the apron window taper over PIT_TAPER instead of stepping. The apron
 * runs to 0.4 m past the shutter line (PIT_PLANNED.shutter, 3.2 m behind the OSM outline = the
 * 2F terrace drip line), so the working area in front of the garages is one road-frame face.
 */
function pitLaneSpan(track: Track, pit: typeof CIRCUIT.pit): (s: number, hw: number) => [number, number, number] {
  return (s, hw) => {
    const wLane = windowRamp(track, s, pit.entryS, pit.exitS, PIT_TAPER)
    const c = track.pitLateralAt(s) ?? -(hw - 2.9)
    const half = (pit.laneWidth / 2) * wLane
    const pin = Math.max(0, -c - half - hw)
    const pout = Math.max(pin, -c + half - hw)
    const wApron = windowRamp(track, s, pit.limitStartS - 40, pit.limitEndS, PIT_TAPER)
    const aout = Math.max(pout, pout + (-PIT_PLANNED.shutter + 0.4 - hw - pout) * wApron)
    return [pin, pout, aout]
  }
}

/**
 * How far beyond the road edge the ground at (s, side) rides the ROAD PLANE: the kerb, the
 * crossover deck's shoulder, the pit lane and the garage apron — the same numbers `ownerAtSL`
 * decides KERB / DECK / PIT_LANE / PIT_APRON by (R6). The cut field (ground-field.ts) reads it
 * before the plan exists: a CUT corridor never enters a road frame, and the plan's own `{ cut }`
 * rows need the corridors, so the corridors are computed from this rule rather than from
 * `plan.ownerAt`.
 */
export function roadFrameReach(track: Track): (s: number, side: Side) => number {
  const kerbs = kerbSpans(track)
  const pitSpan = pitLaneSpan(track, CIRCUIT.pit)
  return (s, side) => {
    const kb = kerbAt(kerbs, track, s, side)
    let reach = Math.max(kb.width * kb.spread, deckShoulderAt(track, s))
    if (side < 0) reach = Math.max(reach, pitSpan(s, track.halfWidthAt(s))[2])
    return reach
  }
}

/**
 * The intervals (m beyond the road edge, within [0, W]) where the station line at s on `side`
 * runs inside ring `r`: the line E + t·n from the road edge, crossed with every ring edge.
 */
export function rayHitRing(track: Track, s: number, side: Side, r: WorldRing, W: number): [number, number][] {
  const b = r.box
  const hw = track.halfWidthAt(s)
  track.pointAt(s, side * hw, _v, 0)
  const ex = _v.x, ez = _v.z
  track.pointAt(s, side * (hw + 1), _v, 0)
  const nx = _v.x - ex, nz = _v.z - ez
  // quick reject: the line's bounding box vs the ring's
  const fx = ex + nx * W, fz = ez + nz * W
  if (Math.max(ex, fx) < b[0] || Math.min(ex, fx) > b[1] || Math.max(ez, fz) < b[2] || Math.min(ez, fz) > b[3]) return []
  const ts: number[] = []
  // crossing-number rule: an edge crosses the line when its ends lie on different sides of it,
  // a vertex ON the line counting as the negative side — so a vertex the line passes through is
  // counted for exactly one of its two edges. Testing the edge parameter 0 ≤ u < 1 instead
  // counted such a vertex twice or not at all (float noise), which flipped the parity of every
  // crossing beyond it: the chicane apron's edge 0.2 m out, sampled 1 cm from one of its 1 m
  // vertices, came back as [9.86, W] instead of [0.2, 9.86] at one station and the ring's columns
  // jumped 6 m within a 2 cm row
  const edge = (ring: readonly Pt[], i: number) => {
    const a = ring[(i - 1 + ring.length) % ring.length]!, c = ring[i]!
    const fa = (a.x - ex) * nz - (a.z - ez) * nx
    const fc = (c.x - ex) * nz - (c.z - ez) * nx
    if (fa > 0 === fc > 0) return
    const u = fa / (fa - fc)
    ts.push((a.x - ex + (c.x - a.x) * u) * nx + (a.z - ez + (c.z - a.z) * u) * nz)
  }
  // every edge against the INFINITE line (the crossings behind the road edge decide whether the
  // edge point itself is inside), in index order; a long ring is walked by chunks of RING_CHUNK
  // edges, and a chunk whose box lies wholly on one side of the line (f is affine, so its range
  // over a box is spanned by the corners) holds no crossing edge and is skipped
  const cross = (ring: readonly Pt[]) => {
    const n = ring.length
    const idx = ringIndexOf(ring)
    if (!idx) { for (let i = 0; i < n; i++) edge(ring, i); return }
    const ch = idx.chunks
    const nc = ch.length / 4
    for (let c = 0; c < nc; c++) {
      const x0 = ch[c * 4]! - ex, x1 = ch[c * 4 + 1]! - ex, z0 = ch[c * 4 + 2]! - ez, z1 = ch[c * 4 + 3]! - ez
      const f00 = x0 * nz - z0 * nx, f01 = x0 * nz - z1 * nx, f10 = x1 * nz - z0 * nx, f11 = x1 * nz - z1 * nx
      if ((f00 > RING_CHUNK_EPS && f01 > RING_CHUNK_EPS && f10 > RING_CHUNK_EPS && f11 > RING_CHUNK_EPS) || (f00 < -RING_CHUNK_EPS && f01 < -RING_CHUNK_EPS && f10 < -RING_CHUNK_EPS && f11 < -RING_CHUNK_EPS)) continue
      for (let i = c * RING_CHUNK, end = Math.min(n, (c + 1) * RING_CHUNK); i < end; i++) edge(ring, i)
    }
  }
  cross(r.outer)
  for (const h of r.holes) cross(h)
  if (!ts.length) return []
  ts.sort((p, q) => p - q)
  // pair up the crossings, then clip to [0, W]; the start point itself is inside when the count
  // of crossings behind it is odd
  const out: [number, number][] = []
  let insideAtZero = 0
  for (const t of ts) if (t < 0) insideAtZero++
  const pos = ts.filter((t) => t >= 0)
  let k = 0
  if (insideAtZero % 2 === 1) { out.push([0, pos.length ? pos[0]! : W]); k = 1 }
  for (; k < pos.length; k += 2) {
    const a = pos[k]!
    const c = pos[k + 1] ?? W
    out.push([a, c])
  }
  return out.map(([a, c]): [number, number] => [Math.min(W, Math.max(0, a)), Math.min(W, Math.max(0, c))]).filter(([a, c]) => c - a > 1e-6)
}

/**
 * Sort and thin a station list: stations closer than `tol` are one. The base set thins at 5 cm;
 * crossing stations at 1 cm — a real boundary crossing a fill 2 cm past a station dragged the fill
 * 5 m aside when the crossing was thinned away (an 8 m edge at the T1 pond's edge), and a 1 cm
 * row is a sliver the snap ignores.
 */
function dedupStations(wanted: number[], L: number, tol: number, ds: number): Float64Array {
  const sorted = wanted.map((s) => ((s % L) + L) % L).sort((a, b) => a - b)
  // the base stations — the track's own samples, every ds — are never dropped: the road's profile
  // and roll are linear between samples, and a row that straddles one chords the kink there
  // (2 mm at a kerb's back where a kerb station 3.6 cm short of a sample had displaced it). An
  // inserted station stays beside a base one unless it is within a centimetre of it
  const isBase = (s: number) => Math.abs(s / ds - Math.round(s / ds)) < 1e-6
  const out: number[] = []
  for (const s of sorted) {
    if (!out.length) { out.push(s); continue }
    const last = out[out.length - 1]!
    const d = s - last
    if (d > tol) { out.push(s); continue }
    if (isBase(s)) { if (d > BASE_NEAR || isBase(last)) out.push(s); else out[out.length - 1] = s }
    else if (isBase(last) && d > BASE_NEAR) out.push(s)
  }
  // the lap is closed: a station within a centimetre of 0 duplicates the first one
  if (out.length > 1 && L - out[out.length - 1]! <= BASE_NEAR) out.pop()
  return Float64Array.from(out)
}
/** an inserted station closer than this to a base station is that station */
const BASE_NEAR = 0.01

/** index of the first station ≥ s (wrapping to 0 past the last one) */
function indexAtOrAfter(stations: Float64Array, s: number): number {
  let lo = 0, hi = stations.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (stations[mid]! < s) lo = mid + 1
    else hi = mid
  }
  return lo % stations.length
}

/**
 * Continuous projection onto the nearest stretch of road, crossover-aware: inside the crossover
 * box the point belongs to the LOWER road (the deck's own verge is bridge-capped to its shoulder),
 * so the sOver stretch is skipped there.
 */
export function projectGlobal(track: Track, x: number, z: number): { s: number; lateral: number; d: number } {
  const L = track.length
  const near = track.nearestSample(x, z)
  if (near.i < 0) return { s: 0, lateral: 0, d: Infinity }
  const s0 = near.i * track.ds
  const { sOver, sUnder } = track.crossing
  if (Math.abs(signedDelta(sOver, s0, L)) < CROSS_WINDOW) {
    // both stretches are within reach: prefer the lower road unless the point is on the deck itself
    const under = track.nearestOnRange(x, z, sUnder - CROSS_WINDOW, sUnder + CROSS_WINDOW, 10)
    const over = track.nearestOnRange(x, z, sOver - CROSS_WINDOW, sOver + CROSS_WINDOW, 10)
    if (Math.abs(over.lateral) <= track.halfWidthAt(over.s) + DECK_SHOULDER + 0.01) return over
    return under
  }
  return track.nearestOnRange(x, z, s0 - 30, s0 + 30, 10)
}
