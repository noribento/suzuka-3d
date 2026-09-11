import * as THREE from 'three'
import { SUR_BUILDINGS, SUR_SITES } from '~/data/suzuka-surroundings'
import { worldRing, type SurBuilding, type SurBuildingKind } from '~/data/en-codec'
import { BUILDING, BUILDING_KIND_OVERRIDES, CAMPSITE, HOUSE_DRESS, MOTOPIA, ROOF_WEIGHTS } from '~/data/surroundings-spec'
import { OSM_PIT_BUILDING, OSM_STAND_WAYS } from '~/data/suzuka-facilities'
import { BUILDINGS } from '~/data/suzuka-facilities-spec'
import type { AssetRegistry } from './assets'
import type { EnvBuildContext } from './environment'
import { cellClippedPolygon, inBBox, pointInRing, ringBBox, ringFromFlat, type GridShape, type XZ } from './far-geometry'
import { buildHeroes, footprintObb, pickHeroes, type HeroPick, type Obb } from './hero-buildings'
import { nearestRoad, roadNetwork, type RoadNet } from './road-section'
import { cached, canvas, makeTexture, mulberry, paint, scaled } from './textures'

/**
 * The buildings of the surroundings (plan §2c): every OSM footprint of
 * app/data/suzuka-surroundings.ts SUR_BUILDINGS that no circuit builder owns, massed by its
 * generator kind, plus the Motopia extras (the family coaster, the drained pools) and the
 * campsite. Everything is built as deferred 'buildings' jobs of `ctx.farField` — one per 250 m
 * cell — and stands on `ground.standY` (README 地面の契約 R3).
 *
 * Massing per kind:
 *  - house — walls to the eaves and a hipped roof over the footprint's oriented bounding box
 *    (`principalAxis`), 0.5 m overhang, pitch 4/10, a pyramid when the box is nearly square;
 *    kawara tints dark grey 70 / brown 20 / blue-grey 10 %; two window bands from 5 m eaves.
 *  - industrial / warehouse / retail / commercial — a 0.8 m parapet with an inset roof slab
 *    (white metal 45 / blue metal 25 / grey membrane 30 %), ribbed panel walls with a dark base
 *    band; rooftop units on roofs over 800 m² in the detail level.
 *  - hotel — a window band every 3.2 m and a plant room on the roof.
 *  - canopy (building=roof, the main gate 466005760 included) — columns every ≤ 6 m and a
 *    0.3 m slab, no walls; the main gate carries a plain-type fascia board on its road-facing
 *    edge (the edge farthest from the circuit).
 *  - ride — pastel walls by id hash, flat roof.  school / temple / generic — plaster, flat
 *    (temple hipped). Only the dwellings and the hotel wings take the window-band layer.
 * Heights come from the tags (`height`, or `building:levels` × 3.2 + 0.6) else from the
 * heuristic that used to live in props.ts (use, name, footprint area). NO bottom cap; the base
 * is `gMin − 0.4` where gMin is the lowest `ground.standY` over the footprint, and the eaves
 * rise with the ground across the footprint (capped at 6 m) — the rule G8 checks the massing by.
 *
 * Phase 4 (R フェーズ) added to the massing, all data-driven from the same rows:
 *  - greenhouse (building=greenhouse) — a film tunnel: a 9-point half-ellipse 3.2 m high over the
 *    OBB's short side swept along its long side, two end fans, no walls, no bottom (`sheet`).
 *  - sheds (a dwelling tagged hut / garage / shed, or under HOUSE_DRESS.shedMaxArea) — walls and
 *    hipped roof in galvanised corrugated sheet; half of the works / warehouses get painted
 *    corrugated walls; house roofs are 70 % kawara / 30 % glazed kawara under the same tints;
 *    12 % of the houses carry a PV array on the south-facing long roof face.
 *  - the detail level (inside the grid): a ブロック塀 around every house with a gate gap on the
 *    road-facing edge, the aircon / LPG cylinder / water heater at the foot of the longest wall,
 *    roller shutters on the road-facing edge of the works (HOUSE_DRESS; road-section.ts
 *    `nearestRoad` decides the road side). Every dressing element keeps DRESS_MIN_D from the
 *    centreline and off the drawn ground faces (the far-field overlay rule).
 *  - hero houses (hero-buildings.ts): footprints a pack model fits are built from the model on a
 *    plinth; the cell job lays only the plinth for them.
 *
 * One material for all of it: a facade ATLAS — a `DataArrayTexture` of fourteen layers (plaster,
 * window band, ribbed metal, kawara tile, membrane + gravel, white metal roof, blue metal roof,
 * two corrugated sheets, glazed kawara, roller shutter, CMU block, PV module, greenhouse film)
 * chosen per vertex by the `aLayer` attribute through an onBeforeCompile patch that replaces
 * `<map_fragment>` with a `sampler2DArray` fetch, tinted by vertex colours, plus a second array
 * of tangent-space normals through three's own normal-map path. With the asset pack the two
 * kawara and the two corrugated layers are the pack's 512² scans drawn into the array at load
 * (`facadeAtlas`); without it (Node, the low tier) every layer is painted. Per cell the masses
 * merge into `buildings-<cell>` (the far level, range ∞) and the ornaments (rooftop units, sill
 * bars, walls, props, shutters) into `buildingsDetail-<cell>` at
 * `Quality.farField.buildingsDetailM`. Set `FACADE_ARRAY_TEXTURE` to false to fall back to four
 * plain materials (see there).
 *
 * Keep-outs: every massed footprint pushes a disc (rMax + 6 m) and its ring, the coaster its
 * deck samples, the campsite its outline — into `ctx.keepOut` / `ctx.keepOutPolys` INSIDE the
 * 'buildings' jobs, which the registry runs before any 'forest' job.
 */

// ---------------------------------------------------------------------------------------------
// the facade atlas

/**
 * Layer index in the facade atlas (the `aLayer` attribute). The first seven are the original
 * painted layers; Phase 4 added the corrugated sheets, the glazed kawara, the roller shutter,
 * the CMU block wall, the PV panel and the greenhouse film. Four of them (kawara, kawaraGlazed,
 * corrugatedDark, corrugatedBlue — `PHOTO_LAYER`) are photo scans when the asset pack is on.
 */
export const FACADE_LAYER = { plaster: 0, window: 1, ribbed: 2, kawara: 3, membrane: 4, whiteMetal: 5, blueMetal: 6, corrugatedDark: 7, corrugatedBlue: 8, kawaraGlazed: 9, shutter: 10, block: 11, pv: 12, sheet: 13 } as const
type FacadeLayer = (typeof FACADE_LAYER)[keyof typeof FACADE_LAYER]
const FACADE_LAYERS = 14

/**
 * The array texture is the design (one material, one draw per cell). Should a GPU misbehave on
 * `sampler2DArray` (a driver that ignores the sRGB internal format, a mip chain that does not
 * generate for TEXTURE_2D_ARRAY), flip this to false: the same geometry is split per cell into
 * four plain MeshStandardMaterials (plaster, window band, ribbed metal, kawara) — every other
 * layer folds into the nearest of those four with its colour applied as a vertex tint
 * (`FALLBACK_SLOT` / `FALLBACK_TINT`), costing up to four draws per cell instead of one and no
 * normal map. Not a tier switch: it is a workaround knob, listed in README「GPU で確認すること」.
 */
export const FACADE_ARRAY_TEXTURE = true
const FALLBACK_SLOT: Record<FacadeLayer, number> = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 0, 5: 0, 6: 0, 7: 2, 8: 2, 9: 3, 10: 2, 11: 0, 12: 0, 13: 0 }
const FALLBACK_TINT: Partial<Record<FacadeLayer, string>> = { 4: '#8a8a88', 5: '#f0f0ee', 6: '#3c5f96', 7: '#6d7073', 8: '#8fb6c8', 9: '#8a8088', 10: '#cdd0d3', 11: '#bdbbb6', 12: '#243a66', 13: '#eef0ec' }

/**
 * Tile size (m) each layer repeats over: [u, v]; v of the window band is one storey, of the
 * ribbed layer the whole wall. The photo layers repeat at their scans' physical tile
 * (`sources.mjs` tile: 3.0 / 2.9 / 1.5 m) and their painted stand-ins draw the same period.
 * The block wall is two courses of two 390 × 190 mm blocks (a running bond needs two courses),
 * the PV layer one 1.65 × 1.0 m module, the shutter one 3.2 × 2.6 m door.
 */
const TILE: Record<FacadeLayer, [number, number]> = { 0: [4, 4], 1: [4, 1], 2: [2, 1], 3: [3, 3], 4: [6, 6], 5: [4, 4], 6: [4, 4], 7: [1.5, 1.5], 8: [1.5, 1.5], 9: [2.9, 2.9], 10: [3.2, 2.6], 11: [0.8, 0.4], 12: [1.65, 1.0], 13: [2, 2] }

/**
 * The layers that come from the pack's 512² WebP scans (`pixels: true` sources, drawable in a
 * 2D canvas): `key` is the manifest id without the map suffix (`/diff` for the colour, `/nor_gl`
 * for the normal). `ribs: 'v'` asks for the corrugations' ridge lines to run along v (vertical
 * on a wall, down the slope on a roof): the scan is turned a quarter turn when its own normal
 * map says they run along u (`ridgesAlongV` false — CorrugatedSteel009 is scanned that way,
 * 007A is not), so the decision follows the file, not a guess.
 */
const PHOTO_LAYER: Partial<Record<FacadeLayer, { key: string; ribs?: 'v' }>> = {
  [FACADE_LAYER.kawara]: { key: 'tex/grey_roof_tiles' },
  [FACADE_LAYER.kawaraGlazed]: { key: 'tex/roofingtiles015a' },
  [FACADE_LAYER.corrugatedDark]: { key: 'tex/corrugatedsteel009', ribs: 'v' },
  [FACADE_LAYER.corrugatedBlue]: { key: 'tex/corrugatedsteel007a', ribs: 'v' },
}

function hash2(a: number, b: number, seed: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** tileable value noise 0..1 on a `p` × `p` lattice of the unit square */
function noiseP(u: number, v: number, p: number, seed: number): number {
  const x = u * p, z = v * p
  const xi = Math.floor(x), zi = Math.floor(z)
  let fx = x - xi, fz = z - zi
  fx = fx * fx * (3 - 2 * fx)
  fz = fz * fz * (3 - 2 * fz)
  const x0 = ((xi % p) + p) % p, z0 = ((zi % p) + p) % p, x1 = (x0 + 1) % p, z1 = (z0 + 1) % p
  const a = hash2(x0, z0, seed), b = hash2(x1, z0, seed), c = hash2(x0, z1, seed), d = hash2(x1, z1, seed)
  const ab = a + (b - a) * fx, cd = c + (d - c) * fx
  return ab + (cd - ab) * fz
}

/** the layer painters: (u, v) → rgb 0..255, v = 0 at the bottom of the tile */
const LAYER_PAINT: Record<FacadeLayer, (u: number, v: number, out: Float32Array) => void> = {
  // plaster: near white with a soft mottle and a faint grime toward the bottom
  0: (u, v, out) => {
    const n = noiseP(u, v, 6, 11) * 0.6 + noiseP(u, v, 24, 12) * 0.4
    const g = 226 + (n - 0.5) * 26 - (1 - v) * 0 - Math.max(0, 0.18 - v) * 60
    out[0] = g + 3; out[1] = g + 1; out[2] = g - 4
  },
  // one storey of a rendered wall with two windows: glass, a light frame, a sill line
  1: (u, v, out) => {
    const n = noiseP(u, v, 6, 21) * 0.6 + noiseP(u, v, 24, 22) * 0.4
    let r = 222 + (n - 0.5) * 22, g = r - 2, b = r - 7
    const uu = (u * 2) % 1
    const inWin = uu > 0.2 && uu < 0.8 && v > 0.36 && v < 0.78
    if (inWin) {
      const frame = uu < 0.24 || uu > 0.76 || v < 0.4 || v > 0.74 || Math.abs(uu - 0.5) < 0.015
      if (frame) { r = 205; g = 205; b = 200 }
      else {
        // glass: a dark blue-grey with a diagonal sky reflection gradient
        const k = 0.5 + 0.5 * Math.sin((uu + v) * 5.5)
        r = 48 + k * 30; g = 58 + k * 34; b = 76 + k * 42
      }
    } else if (uu > 0.18 && uu < 0.82 && v > 0.33 && v <= 0.36) {
      r = 200; g = 198; b = 192 // the sill
    } else if (v < 0.03) {
      r *= 0.9; g *= 0.9; b *= 0.9 // the floor line
    }
    out[0] = r; out[1] = g; out[2] = b
  },
  // ribbed metal panels: vertical ribs (8 per tile), panel seams every 2 ribs, a dark base band
  2: (u, v, out) => {
    const rib = 0.86 + 0.14 * Math.cos(u * Math.PI * 2 * 8)
    const seam = (u * 4) % 1 < 0.02 ? 0.82 : 1
    let g = 214 * rib * seam + (noiseP(u, v, 5, 31) - 0.5) * 10
    if (v < BUILDING.industrial.baseBand) g = 74 + (noiseP(u, v, 9, 32) - 0.5) * 14
    else if (v < BUILDING.industrial.baseBand + 0.01) g *= 0.6
    out[0] = g; out[1] = g; out[2] = g + 2
  },
  // kawara: ten 0.3 m courses of clay tiles over the 3 m tile, each with a rolled lip (a shadow line under the course above) and a wave across
  3: (u, v, out) => {
    const course = (v * 10) % 1
    const tile = (u * 10) % 1
    const wave = 0.86 + 0.14 * Math.cos(tile * Math.PI * 2)
    const lip = course > 0.86 ? 0.55 + (course - 0.86) / 0.14 * 0.35 : 1
    const grime = (noiseP(u, v, 7, 41) - 0.5) * 0.16
    const g = 200 * wave * lip * (1 + grime)
    out[0] = g; out[1] = g; out[2] = g
  },
  // membrane + gravel: mid grey with a fine speckle
  4: (u, v, out) => {
    const s = (noiseP(u, v, 48, 51) - 0.5) * 48 + (noiseP(u, v, 6, 52) - 0.5) * 20
    const g = 150 + s
    out[0] = g; out[1] = g; out[2] = g - 3
  },
  // white folded-metal roof: standing seams every quarter tile, faint weathering streaks along them
  5: (u, v, out) => {
    const seam = (u * 4) % 1 < 0.035 ? 0.72 : 1
    const streak = 1 - Math.max(0, noiseP(u, v, 3, 61) - 0.6) * 0.5
    const g = 236 * seam * streak + (noiseP(u, v, 20, 62) - 0.5) * 8
    out[0] = g; out[1] = g; out[2] = g - 4
  },
  // blue folded-metal roof: the same seams in the aerials' cobalt
  6: (u, v, out) => {
    const seam = (u * 4) % 1 < 0.035 ? 0.7 : 1
    const streak = 1 - Math.max(0, noiseP(u, v, 3, 71) - 0.6) * 0.4
    const k = seam * streak * (1 + (noiseP(u, v, 20, 72) - 0.5) * 0.08)
    out[0] = 58 * k; out[1] = 96 * k; out[2] = 156 * k
  },
  // dark galvanised corrugated sheet: 20 ribs (76 mm pitch) along u over the 1.5 m tile, rust streaks down the ribs
  7: (u, v, out) => {
    const rib = 0.8 + 0.2 * Math.cos(u * Math.PI * 2 * 20)
    const rust = Math.max(0, noiseP(u, v, 5, 81) - 0.62) * 1.6
    const g = 118 * rib * (1 + (noiseP(u, v, 16, 82) - 0.5) * 0.12)
    out[0] = g + rust * 60; out[1] = g + rust * 22; out[2] = g - 2 - rust * 10
  },
  // painted light-blue corrugated sheet (the works' walls): the same ribs, a faint chalking toward the bottom
  8: (u, v, out) => {
    const rib = 0.9 + 0.1 * Math.cos(u * Math.PI * 2 * 20)
    const chalk = 1 + Math.max(0, 0.25 - v) * 0.3 + (noiseP(u, v, 6, 91) - 0.5) * 0.08
    out[0] = 150 * rib * chalk; out[1] = 186 * rib * chalk; out[2] = 200 * rib * chalk
  },
  // glazed kawara: the same courses (ten per 2.9 m) darker and glossier — a specular band on each tile's crown
  9: (u, v, out) => {
    const course = (v * 10) % 1
    const tile = (u * 10) % 1
    const crown = Math.max(0, Math.cos(tile * Math.PI * 2))
    const lip = course > 0.88 ? 0.5 + (course - 0.88) / 0.12 * 0.4 : 1
    const g = (128 + 46 * crown * crown) * lip * (1 + (noiseP(u, v, 7, 101) - 0.5) * 0.1)
    out[0] = g - 4; out[1] = g - 6; out[2] = g + 4
  },
  // roller shutter door: 26 horizontal slats over the 2.6 m height, guide rails at both sides, a lock plate near the bottom
  10: (u, v, out) => {
    const slat = 0.78 + 0.22 * Math.cos(v * Math.PI * 2 * 26)
    const rail = u < 0.035 || u > 0.965
    let g = rail ? 128 : 196 * slat * (1 + (noiseP(u, v, 6, 111) - 0.5) * 0.08)
    if (!rail && Math.abs(u - 0.5) < 0.03 && v > 0.32 && v < 0.36) g = 90
    out[0] = g; out[1] = g + 1; out[2] = g + 3
  },
  // CMU block wall: two courses of two blocks per tile in a running bond, 10 mm mortar joints, a pitted face
  11: (u, v, out) => {
    const course = v < 0.5 ? 0 : 1
    const uu = (u + course * 0.25) % 0.5 / 0.5
    const vv = (v * 2) % 1
    const joint = uu < 0.03 || vv < 0.055
    const pit = noiseP(u, v, 40, 121)
    const g = joint ? 150 + (noiseP(u, v, 8, 122) - 0.5) * 12 : 176 + (pit - 0.5) * 34 + (noiseP(u, v, 5, 123) - 0.5) * 16
    out[0] = g; out[1] = g - 1; out[2] = g - 4
  },
  // PV module: a 6 × 10 grid of dark-blue cells under a thin light frame, a white busbar between the cells
  12: (u, v, out) => {
    const frame = u < 0.02 || u > 0.98 || v < 0.03 || v > 0.97
    if (frame) { out[0] = 192; out[1] = 194; out[2] = 196; return }
    const cu = (u * 6) % 1, cv = (v * 10) % 1
    const bus = cu < 0.04 || cv < 0.05
    const k = 1 + (noiseP(u, v, 3, 131) - 0.5) * 0.2
    if (bus) { out[0] = 120 * k; out[1] = 128 * k; out[2] = 140 * k; return }
    out[0] = 24 * k; out[1] = 36 * k; out[2] = 78 * k
  },
  // greenhouse film: near-white, a hoop's shadow every 0.5 m along u, a soft sag between the hoops
  13: (u, v, out) => {
    const hoop = (u * 4) % 1 < 0.025 ? 0.78 : 1
    const sag = 0.96 + 0.04 * Math.cos(((u * 4) % 1) * Math.PI * 2)
    const g = 232 * hoop * sag * (1 + (noiseP(u, v, 6, 141) - 0.5) * 0.05)
    out[0] = g - 2; out[1] = g + 2; out[2] = g
  },
}

/** what the 14-layer material binds; `normal` is null under the fallback (no `sampler2DArray` there at all) */
interface FacadeAtlas {
  /** the colour array (null under the fallback) */
  array: THREE.DataArrayTexture | null
  /** the tangent-space normal array, 256² per layer (photo `nor_gl` scans, luminance-derived for the painted layers) */
  normal: THREE.DataArrayTexture | null
  /** the four plain textures of the fallback (empty when the array is in use) */
  plain: THREE.Texture[]
  /** layers that came from the pack's scans */
  photo: number
}

/** the image behind a pack texture when a 2D canvas can draw it (the WebP of a `pixels: true` source loads as an HTMLImageElement), else null (KTX2, Node, a failed load) */
function drawable(assets: AssetRegistry | null, key: string): CanvasImageSource | null {
  const img = assets?.texture(key)?.image as (CanvasImageSource & { width?: unknown; height?: unknown; data?: unknown }) | undefined
  if (!img || typeof img.width !== 'number' || typeof img.height !== 'number' || !(img.width > 0 && img.height > 0) || img.data) return null
  return img
}

/**
 * `img` drawn into `w` × `h` bytes in the array texture's row order: row 0 is v = 0, so the image
 * is drawn upside down to put its top at v = 1 — the orientation an ordinary (flipY) texture would
 * have, which keeps a roof scan's courses running down the slope and a GL normal map's green
 * pointing along +v. `rotate` turns it a quarter turn counter-clockwise (in the u-right / v-up
 * frame) so a variation along v becomes one along u; the caller fixes a normal map's components
 * to match (`rotateNormals`). null when the canvas cannot draw it (a tainted image, no 2D context).
 */
function photoBytes(img: CanvasImageSource, w: number, h: number, rotate: boolean): Uint8ClampedArray | null {
  let bytes: Uint8ClampedArray
  try {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true })
    if (!ctx) return null
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.translate(0, h)
    ctx.scale(1, -1)
    ctx.drawImage(img, 0, 0, w, h)
    bytes = ctx.getImageData(0, 0, w, h).data
  } catch {
    return null
  }
  if (!rotate || w !== h) return bytes
  // dest (u, v) ← source (v, 1 − u): a quarter turn counter-clockwise about the tile centre
  const out = new Uint8ClampedArray(bytes.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = ((w - 1 - x) * w + y) * 4, dst = (y * w + x) * 4
      out[dst] = bytes[src]!; out[dst + 1] = bytes[src + 1]!; out[dst + 2] = bytes[src + 2]!; out[dst + 3] = 255
    }
  }
  return out
}

/** the tangent-space components after `photoBytes`'s quarter turn: (nx, ny) → (−ny, nx) */
function rotateNormals(bytes: Uint8ClampedArray) {
  for (let i = 0; i < bytes.length; i += 4) {
    const r = bytes[i]!, g = bytes[i + 1]!
    bytes[i] = 255 - g
    bytes[i + 1] = r
  }
}

/**
 * A scan's ridge lines run along v (vertical on a wall): its height varies along u, so the
 * normal map tilts in x (the R channel) more than in y; without a normal map, the colour's
 * gradient energy along u exceeds the one along v.
 */
function ridgesAlongV(colour: Uint8ClampedArray, normal: Uint8ClampedArray | null): boolean {
  if (normal) {
    let r = 0, g = 0
    for (let i = 0; i < normal.length; i += 4) { r += Math.abs(normal[i]! - 128); g += Math.abs(normal[i + 1]! - 128) }
    return r > g
  }
  const n = Math.round(Math.sqrt(colour.length / 4))
  let gu = 0, gv = 0
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 4, ru = (y * n + ((x + 1) % n)) * 4, rv = (((y + 1) % n) * n + x) * 4
      gu += Math.abs(colour[ru]! - colour[i]!)
      gv += Math.abs(colour[rv]! - colour[i]!)
    }
  }
  return gu > gv
}

/** mean luminance 0..255 of RGBA bytes */
function meanLuma(bytes: Uint8ClampedArray): number {
  let sum = 0
  for (let i = 0; i < bytes.length; i += 4) sum += 0.2126 * bytes[i]! + 0.7152 * bytes[i + 1]! + 0.0722 * bytes[i + 2]!
  return sum / (bytes.length / 4)
}

/**
 * A tangent-space normal tile from the luminance of painted bytes (`w` × `h`, tileable), at a
 * low strength: the painted layers only carry seams, courses and ribs, and their luminance is a
 * fair height proxy (a lip shadow is a step down). The array texture is not flipped, so +v is
 * +row and no sign flip is needed (unlike textures.ts normalMapFrom, which paints for flipY).
 */
function normalFromLuma(bytes: Uint8ClampedArray, w: number, h: number, strength: number): Uint8ClampedArray {
  const height = new Float32Array(w * h)
  for (let i = 0; i < height.length; i++) height[i] = (0.2126 * bytes[i * 4]! + 0.7152 * bytes[i * 4 + 1]! + 0.0722 * bytes[i * 4 + 2]!) / 255
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = height[y * w + ((x - 1 + w) % w)]!, r = height[y * w + ((x + 1) % w)]!
      const d = height[((y - 1 + h) % h) * w + x]!, u = height[((y + 1) % h) * w + x]!
      const nx = -(r - l) * strength, ny = -(u - d) * strength, nz = 1
      const inv = 1 / Math.hypot(nx, ny, nz)
      const i = (y * w + x) * 4
      out[i] = (nx * inv * 0.5 + 0.5) * 255
      out[i + 1] = (ny * inv * 0.5 + 0.5) * 255
      out[i + 2] = (nz * inv * 0.5 + 0.5) * 255
      out[i + 3] = 255
    }
  }
  return out
}

/** `src` (sw × sh) resampled to w × h through a canvas (bilinear), for the painted layers when the array is at the scans' size */
function resampleBytes(src: Uint8ClampedArray, sw: number, sh: number, w: number, h: number): Uint8ClampedArray {
  if (sw === w && sh === h) return src
  const { c, ctx } = canvas(sw, sh)
  const img = ctx.createImageData(sw, sh)
  img.data.set(src)
  ctx.putImageData(img, 0, 0)
  const { ctx: dst } = canvas(w, h)
  dst.imageSmoothingEnabled = true
  dst.imageSmoothingQuality = 'high'
  dst.drawImage(c, 0, 0, w, h)
  return dst.getImageData(0, 0, w, h).data
}

function arrayTexture(data: Uint8Array, w: number, h: number, srgb: boolean): THREE.DataArrayTexture {
  const tex = new THREE.DataArrayTexture(data, w, h, FACADE_LAYERS)
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.anisotropy = 4
  tex.needsUpdate = true
  return tex
}

/**
 * The facade atlas, once per texture scale and pack (cached under textures.ts's registry, so it
 * is disposed with the rest). Every layer is painted at 256² (tier-scaled) as before; with the
 * pack, the four `PHOTO_LAYER` scans are drawn from their WebP images instead and the colour
 * array is built at the scans' 512² (the painted layers resampled up), each scan's brightness
 * normalised to its painted stand-in's mean luminance so the vertex tints (the kawara colours,
 * the shed grey) keep the look they were tuned for. The normal array is 256² per layer: the
 * scans' `nor_gl` where present (turned with the colour when the ribs had to be), a low-strength
 * luminance normal for the painted layers. Without the pack (Node, the low tier) the colour
 * array is byte-for-byte what the painters make — the photo path is an addition, not a branch
 * in the massing.
 */
function facadeAtlas(assets: AssetRegistry | null): FacadeAtlas {
  const [pw, ph] = scaled(256, 256)
  // which scans this registry can draw decides the size and the cache key
  const photos: Partial<Record<FacadeLayer, { diff: CanvasImageSource; nor: CanvasImageSource | null; rotateAsk: boolean }>> = {}
  if (FACADE_ARRAY_TEXTURE && assets) {
    for (const [l, pl] of Object.entries(PHOTO_LAYER) as [string, { key: string; ribs?: 'v' }][]) {
      const diff = drawable(assets, `${pl.key}/diff`)
      if (diff) photos[Number(l) as FacadeLayer] = { diff, nor: drawable(assets, `${pl.key}/nor_gl`), rotateAsk: pl.ribs === 'v' }
    }
  }
  const photoCount = Object.keys(photos).length
  const [w, h] = photoCount ? scaled(512, 512) : [pw, ph]
  return cached(`buildings/facade@${w}${FACADE_ARRAY_TEXTURE ? 'a' : 'p'}${photoCount ? `+photo${photoCount}` : ''}`, (): FacadeAtlas => {
    const canvases: HTMLCanvasElement[] = []
    const painted: Uint8ClampedArray[] = []
    for (let l = 0; l < FACADE_LAYERS; l++) {
      const fn = LAYER_PAINT[l as FacadeLayer]
      const c = paint(pw, ph, (x, y, out) => fn((x + 0.5) / pw, (y + 0.5) / ph, out))
      canvases.push(c)
      painted.push(c.getContext('2d')!.getImageData(0, 0, pw, ph).data)
    }
    if (FACADE_ARRAY_TEXTURE) {
      const colour = new Uint8Array(w * h * 4 * FACADE_LAYERS)
      const normal = new Uint8Array(pw * ph * 4 * FACADE_LAYERS)
      let photoLayers = 0
      for (let l = 0; l < FACADE_LAYERS; l++) {
        const photo = photos[l as FacadeLayer]
        let col: Uint8ClampedArray | null = null
        let nor: Uint8ClampedArray | null = null
        if (photo) {
          // draw unrotated first, decide the turn from the scan itself, then draw again turned
          let pc = photoBytes(photo.diff, w, h, false)
          let pn = photo.nor ? photoBytes(photo.nor, pw, ph, false) : null
          if (pc && photo.rotateAsk && !ridgesAlongV(pc, pn)) {
            pc = photoBytes(photo.diff, w, h, true)
            pn = photo.nor ? photoBytes(photo.nor, pw, ph, true) : null
            if (pn) rotateNormals(pn)
          }
          if (pc) {
            // the scan at the painted layer's brightness, so the tints keep their look
            const gain = Math.min(1.8, Math.max(0.6, meanLuma(painted[l]!) / Math.max(1, meanLuma(pc))))
            for (let i = 0; i < pc.length; i += 4) { pc[i] = pc[i]! * gain; pc[i + 1] = pc[i + 1]! * gain; pc[i + 2] = pc[i + 2]! * gain }
            col = pc
            nor = pn
            photoLayers++
          }
        }
        colour.set(col ?? resampleBytes(painted[l]!, pw, ph, w, h), l * w * h * 4)
        normal.set(nor ?? normalFromLuma(painted[l]!, pw, ph, 3), l * pw * ph * 4)
      }
      return { array: arrayTexture(colour, w, h, true), normal: arrayTexture(normal, pw, ph, false), plain: [], photo: photoLayers }
    }
    // the fallback: the painters' canvases as ordinary textures, rows bottom-up like the array
    // (flipY off). Each is cached under its own key so textures.ts's registry finds it for
    // `markAllDirty` / `disposeAll` (that walk is one level deep and would miss an array).
    const plain = [0, 1, 2, 3].map((l) => cached(`buildings/facadePlain${l}@${w}`, () => {
      const t = makeTexture(canvases[l]!, { srgb: true })
      t.flipY = false
      t.needsUpdate = true
      return t
    }))
    return { array: null, normal: null, plain, photo: 0 }
  })
}

/** a 1 × 1 flat normal: bound as `normalMap` only so three defines USE_NORMALMAP_TANGENTSPACE and builds the TBN; the fetch itself is replaced */
function dummyNormal(): THREE.DataTexture {
  return cached('buildings/facadeNormalDummy', () => {
    const t = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1)
    t.needsUpdate = true
    return t
  })
}

/**
 * The one facade material (array path): vertex colours × the layer picked per vertex, and the
 * layer's tangent-space normal through three's own normal-map path — a dummy `normalMap` turns
 * the path on (USE_NORMALMAP_TANGENTSPACE, the derivative TBN), and the `texture2D( normalMap,
 * vNormalMapUv )` fetch of <normal_fragment_maps> is swapped for the array fetch. Program key
 * 'facade|n' (one program for every cell, as before).
 */
function facadeMaterial(atlas: FacadeAtlas): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.86, metalness: 0.03 })
  const normal = atlas.normal
  if (normal) {
    mat.normalMap = dummyNormal()
    mat.normalScale.set(0.6, 0.6)
  }
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.facadeAtlas = { value: atlas.array }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aLayer;\nvarying float vLayer;\nvarying vec2 vFacadeUv;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvLayer = aLayer;\nvFacadeUv = uv;')
    let frag = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform highp sampler2DArray facadeAtlas;\n${normal ? 'uniform highp sampler2DArray facadeNormal;\n' : ''}varying float vLayer;\nvarying vec2 vFacadeUv;`)
      .replace('#include <map_fragment>', 'diffuseColor *= texture( facadeAtlas, vec3( vFacadeUv, vLayer ) );')
    if (normal) {
      shader.uniforms.facadeNormal = { value: normal }
      frag = frag.replace('#include <normal_fragment_maps>', THREE.ShaderChunk.normal_fragment_maps!.replaceAll('texture2D( normalMap, vNormalMapUv )', 'texture( facadeNormal, vec3( vFacadeUv, vLayer ) )'))
    }
    shader.fragmentShader = frag
  }
  mat.customProgramCacheKey = () => (normal ? 'facade|n' : 'facade')
  return mat
}

/** the fascia board of the main gate: plain type on a white board (no logo, no wordmark — a place name in a generic sans-serif) */
function fasciaTexture(): THREE.Texture {
  const [w, h] = scaled(1024, 128)
  return cached(`buildings/fascia@${w}`, () => {
    const { c, ctx } = canvas(w, h)
    ctx.fillStyle = '#f4f3ef'
    ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = '#22262c'
    ctx.font = `600 ${Math.round(h * 0.52)}px 'Segoe UI', Arial, Helvetica, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(BUILDING.canopy.fascia.text.split('').join(' '), w / 2, h / 2 + h * 0.03)
    ctx.fillStyle = '#9aa0a6'
    ctx.fillRect(0, h - Math.max(2, h * 0.04), w, Math.max(2, h * 0.04))
    return makeTexture(c, { wrap: THREE.ClampToEdgeWrapping })
  })
}

// ---------------------------------------------------------------------------------------------
// geometry accumulator: position / normal / uv / color / aLayer, indexed

class Acc {
  pos: number[] = []
  nrm: number[] = []
  uv: number[] = []
  col: number[] = []
  lay: number[] = []
  idx: number[] = []
  get vertices(): number { return this.pos.length / 3 }
  get triangles(): number { return this.idx.length / 3 }

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, c: THREE.Color, layer: number): number {
    const i = this.pos.length / 3
    this.pos.push(x, y, z)
    this.nrm.push(nx, ny, nz)
    this.uv.push(u, v)
    this.col.push(c.r, c.g, c.b)
    this.lay.push(layer)
    return i
  }

  /**
   * A planar convex polygon (3 or 4 corners) with the given uvs, wound to face `out` (the
   * polygon's own normal when omitted — then the corner order decides the side).
   */
  face(pts: number[][], uvs: number[][], c: THREE.Color, layer: number, out?: [number, number, number]) {
    const a = pts[0]!, b = pts[1]!, d = pts[2]!
    let nx = (b[1]! - a[1]!) * (d[2]! - a[2]!) - (b[2]! - a[2]!) * (d[1]! - a[1]!)
    let ny = (b[2]! - a[2]!) * (d[0]! - a[0]!) - (b[0]! - a[0]!) * (d[2]! - a[2]!)
    let nz = (b[0]! - a[0]!) * (d[1]! - a[1]!) - (b[1]! - a[1]!) * (d[0]! - a[0]!)
    const len = Math.hypot(nx, ny, nz)
    if (len < 1e-9) return
    nx /= len; ny /= len; nz /= len
    let order = pts.map((_, i) => i)
    if (out && nx * out[0] + ny * out[1] + nz * out[2] < 0) {
      order = order.reverse()
      nx = -nx; ny = -ny; nz = -nz
    }
    const ids = order.map((i) => { const p = pts[i]!, t = uvs[i]!; return this.vertex(p[0]!, p[1]!, p[2]!, nx, ny, nz, t[0]!, t[1]!, c, layer) })
    for (let k = 1; k + 1 < ids.length; k++) this.idx.push(ids[0]!, ids[k]!, ids[k + 1]!)
  }

  /** a horizontal polygon (any simple ring) at height y facing up (`up`) or down; uv from `uvOf` */
  cap(ring: readonly XZ[], y: number, up: boolean, c: THREE.Color, layer: number, uvOf: (x: number, z: number) => [number, number]) {
    let faces: number[][]
    try {
      faces = THREE.ShapeUtils.triangulateShape(ring.map(([x, z]) => new THREE.Vector2(x, z)), [])
    } catch {
      return
    }
    const ny = up ? 1 : -1
    const ids = ring.map(([x, z]) => { const t = uvOf(x, z); return this.vertex(x, y, z, 0, ny, 0, t[0], t[1], c, layer) })
    for (const f of faces) {
      const a = ring[f[0]!]!, b = ring[f[1]!]!, d = ring[f[2]!]!
      // cross of (b − a) × (d − a) in xz: positive → the triangle winds to face −Y in three's frame
      const cross = (b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0])
      const flip = cross > 0 === up
      if (flip) this.idx.push(ids[f[0]!]!, ids[f[2]!]!, ids[f[1]!]!)
      else this.idx.push(ids[f[0]!]!, ids[f[1]!]!, ids[f[2]!]!)
    }
  }

  /** an axis-aligned box in a local (a, c) frame at (cx, cz), yaw by the unit axis (ax, az): five faces (no bottom), the top optional */
  box(cx: number, cz: number, ax: number, az: number, la: number, lc: number, y0: number, y1: number, c: THREE.Color, layer: number, wallLayer = layer, withTop = true) {
    const P = (a: number, k: number, y: number): number[] => [cx + ax * a - az * k, y, cz + az * a + ax * k]
    const ha = la / 2, hc = lc / 2
    const corners = [[-ha, -hc], [ha, -hc], [ha, hc], [-ha, hc]] as const
    for (let i = 0; i < 4; i++) {
      const [a0, k0] = corners[i]!, [a1, k1] = corners[(i + 1) % 4]!
      const len = Math.hypot(a1 - a0, k1 - k0)
      const ma = (a0 + a1) / 2, mk = (k0 + k1) / 2
      const out: [number, number, number] = [ax * ma - az * mk, 0, az * ma + ax * mk]
      this.face([P(a0, k0, y0), P(a1, k1, y0), P(a1, k1, y1), P(a0, k0, y1)], [[0, 0], [len / TILE[wallLayer as FacadeLayer][0], 0], [len / TILE[wallLayer as FacadeLayer][0], (y1 - y0) / TILE[wallLayer as FacadeLayer][1]], [0, (y1 - y0) / TILE[wallLayer as FacadeLayer][1]]], c, wallLayer, out)
    }
    if (!withTop) return
    const t = TILE[layer as FacadeLayer]
    this.face([P(-ha, -hc, y1), P(ha, -hc, y1), P(ha, hc, y1), P(-ha, hc, y1)], [[0, 0], [la / t[0], 0], [la / t[0], lc / t[1]], [0, lc / t[1]]], c, layer, [0, 1, 0])
  }

  /** an upright regular prism (a cylinder stand-in: `sides` faces + a top cap, no bottom) of radius r at (cx, cz) */
  prism(cx: number, cz: number, r: number, sides: number, y0: number, y1: number, c: THREE.Color, layer: number) {
    const t = TILE[layer as FacadeLayer]
    const top: number[][] = []
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2, a1 = ((i + 1) / sides) * Math.PI * 2
      const x0 = cx + Math.cos(a0) * r, z0 = cz + Math.sin(a0) * r, x1 = cx + Math.cos(a1) * r, z1 = cz + Math.sin(a1) * r
      const am = (a0 + a1) / 2
      const u0 = (i / sides) * Math.PI * 2 * r / t[0], u1 = ((i + 1) / sides) * Math.PI * 2 * r / t[0]
      this.face([[x0, y0, z0], [x1, y0, z1], [x1, y1, z1], [x0, y1, z0]], [[u0, 0], [u1, 0], [u1, (y1 - y0) / t[1]], [u0, (y1 - y0) / t[1]]], c, layer, [Math.cos(am), 0, Math.sin(am)])
      top.push([x0, y1, z0])
    }
    this.face(top, top.map((q) => [(q[0]! - cx) / t[0], (q[2]! - cz) / t[1]]), c, layer, [0, 1, 0])
  }

  merge(o: Acc) {
    const base = this.vertices
    for (const v of o.pos) this.pos.push(v)
    for (const v of o.nrm) this.nrm.push(v)
    for (const v of o.uv) this.uv.push(v)
    for (const v of o.col) this.col.push(v)
    for (const v of o.lay) this.lay.push(v)
    for (const i of o.idx) this.idx.push(i + base)
  }

  geometry(): THREE.BufferGeometry | null {
    if (!this.idx.length) return null
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2))
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3))
    g.setAttribute('aLayer', new THREE.Float32BufferAttribute(this.lay, 1))
    g.setIndex(this.idx)
    g.computeBoundingSphere()
    return g
  }

  /** the fallback's split: one geometry per plain-material slot, the roof layers tinted */
  splitBySlot(): (THREE.BufferGeometry | null)[] {
    const out: (THREE.BufferGeometry | null)[] = []
    const tint = new THREE.Color()
    for (let slot = 0; slot < 4; slot++) {
      const a = new Acc()
      const map = new Map<number, number>()
      const take = (i: number): number => {
        let j = map.get(i)
        if (j === undefined) {
          const layer = this.lay[i] as FacadeLayer
          const t = FALLBACK_TINT[layer]
          const r = this.col[i * 3]!, g = this.col[i * 3 + 1]!, b = this.col[i * 3 + 2]!
          if (t) tint.set(t).multiply(new THREE.Color(r, g, b))
          else tint.setRGB(r, g, b)
          j = a.vertex(this.pos[i * 3]!, this.pos[i * 3 + 1]!, this.pos[i * 3 + 2]!, this.nrm[i * 3]!, this.nrm[i * 3 + 1]!, this.nrm[i * 3 + 2]!, this.uv[i * 2]!, this.uv[i * 2 + 1]!, tint, slot)
          map.set(i, j)
        }
        return j
      }
      for (let k = 0; k < this.idx.length; k += 3) {
        const i0 = this.idx[k]!
        if (FALLBACK_SLOT[this.lay[i0] as FacadeLayer] !== slot) continue
        a.idx.push(take(i0), take(this.idx[k + 1]!), take(this.idx[k + 2]!))
      }
      out.push(a.geometry())
    }
    return out
  }
}

// ---------------------------------------------------------------------------------------------
// the planned buildings

export interface Planned {
  b: SurBuilding
  kind: SurBuildingKind
  ring: XZ[]
  box: [number, number, number, number]
  cx: number
  cz: number
  rMax: number
  /** eaves height over the ground (m) */
  eaves: number
  /** the far-field cell (the 'outside' bucket beyond the grid) */
  cell: number
  /** merge key: the cell index, or `o<i>x<j>` 500 m pseudo-cells outside the grid */
  key: string
  seed: number
  /** built from a pack model instead of the massing (hero-buildings.ts pickHeroes); the cell job then only lays its plinth */
  hero?: HeroPick
}

export interface BuildingsStats {
  /** footprints massed (planned; the jobs build exactly these) */
  planned: number
  byKind: Partial<Record<SurBuildingKind, number>>
  skipped: { owned: number; paddock: number; verge: number; small: number; degenerate: number }
  cells: number
  jobs: number
  /** coaster ways chained, pools, campsite pitches planned */
  motopia: { coasterWays: number; pools: number; tents: number; vans: number }
  /** footprints handed to the pack models (hero-buildings.ts), per model key */
  heroes: { picked: number; byModel: Record<string, number> }
}

/** eaves height (m) from the tags, else from the kind, the name and the footprint area (the props.ts heuristic, moved here) */
function eavesHeight(b: SurBuilding, kind: SurBuildingKind): number {
  const t = b.tags
  const explicit = Number(t.height)
  if (explicit > 0) return explicit
  const levels = Number(t['building:levels'])
  if (levels > 0) return levels * BUILDING.storey + BUILDING.storeyExtra
  const name = t.name ?? ''
  if (kind === 'canopy') return BUILDING.canopy.eaves
  if (kind === 'industrial' || kind === 'warehouse') return b.area > 3000 ? 12 : 9
  // the hotel wings (ノース館 / ウエスト館 / イースト館 / サウス館) are 4–5 storeys, the main building more
  if (name.includes('ホテル')) return 19
  if (name.endsWith('館')) return 14.5
  // the coaster station is a low shed now that the coaster itself is built (props.ts used to
  // stand a 16 m box there for the ride)
  if (kind === 'ride') return BUILDING.rideEaves
  for (const [maxArea, eaves] of BUILDING.eavesByArea) if (b.area < maxArea) return eaves
  return 12
}

const PARAPET_KINDS = new Set<SurBuildingKind>(['industrial', 'warehouse', 'retail', 'commercial'])
const HIP_KINDS = new Set<SurBuildingKind>(['house', 'temple'])
/** OSM way of メインゲート — the one canopy that carries a fascia board (plan §2c) */
const MAIN_GATE_WAY = 466005760

/**
 * Every SUR_BUILDINGS footprint that no circuit builder owns: the pit building, the stands'
 * ways and the spec'd BUILDINGS are skipped by id, the paddock band by projected position
 * (the props.ts ownership filter), the verge rule and the minimum area as before.
 */
function planBuildings(ctx: EnvBuildContext, stats: BuildingsStats): Planned[] {
  const { track, ground, farField } = ctx
  const grid = ctx.terrain.grid()
  const owned = new Set<number>([OSM_PIT_BUILDING.id, ...BUILDINGS.map((b) => b.osmWay).filter((id): id is number => id !== null), ...Object.values(OSM_STAND_WAYS).flat()])
  const out: Planned[] = []
  const k = track.enScale
  for (const b of SUR_BUILDINGS) {
    if (owned.has(b.id)) { stats.skipped.owned++; continue }
    if (b.area < BUILDING.minArea) { stats.skipped.small++; continue }
    const ring = ringFromFlat(worldRing(b, k))
    if (ring.length < 3) { stats.skipped.degenerate++; continue }
    const cx = b.centroid[0] * k, cz = -b.centroid[1] * k
    const near = ground.plan.project(cx, cz)
    // the paddock band behind the pit building belongs to the pit complex
    if (near.lateral < -57 && near.lateral > -135 && (near.s > 5530 || near.s < 260)) { stats.skipped.paddock++; continue }
    // buildings right beside the road were never modelled as boxes here: 6 m clearance of the verge
    if (near.d < track.halfWidthAt(near.s) + BUILDING.vergeClearance) { stats.skipped.verge++; continue }
    let rMax = 0
    for (const [x, z] of ring) rMax = Math.max(rMax, Math.hypot(x - cx, z - cz))
    const kind = BUILDING_KIND_OVERRIDES[b.id] ?? b.kind
    const cell = farField.cellOf(cx, cz)
    const key = cell === farField.outsideCell ? `o${Math.floor((cx - grid.x0) / 500)}x${Math.floor((cz - grid.z0) / 500)}` : String(cell)
    out.push({ b, kind, ring, box: ringBBox(ring), cx, cz, rMax, eaves: eavesHeight(b, kind), cell, key, seed: b.id | 0 })
    stats.byKind[kind] = (stats.byKind[kind] ?? 0) + 1
  }
  stats.planned = out.length
  return out
}

// ---------------------------------------------------------------------------------------------
// massing helpers

/** outward unit normals of every edge (edge i runs ring[i] → ring[i+1]) */
function edgeNormals(ring: readonly XZ[]): [number, number][] {
  let area = 0
  const n = ring.length
  for (let i = 0; i < n; i++) {
    const p = ring[i]!, q = ring[(i + 1) % n]!
    area += p[0] * q[1] - q[0] * p[1]
  }
  const sgn = area > 0 ? 1 : -1
  const out: [number, number][] = []
  for (let i = 0; i < n; i++) {
    const p = ring[i]!, q = ring[(i + 1) % n]!
    const ex = q[0] - p[0], ez = q[1] - p[1]
    const len = Math.hypot(ex, ez) || 1
    out.push([(sgn * ez) / len, (-sgn * ex) / len])
  }
  return out
}

/** the ring moved `d` inward (mitred corners, mitre length capped); the ring itself when it would collapse */
function insetRing(ring: readonly XZ[], normals: readonly [number, number][], d: number): XZ[] {
  const n = ring.length
  const out: XZ[] = []
  for (let i = 0; i < n; i++) {
    const n0 = normals[(i + n - 1) % n]!, n1 = normals[i]!
    let mx = n0[0] + n1[0], mz = n0[1] + n1[1]
    const ml = Math.hypot(mx, mz)
    if (ml < 1e-6) { mx = n1[0]; mz = n1[1] }
    else { mx /= ml; mz /= ml }
    const cosHalf = Math.max(0.34, Math.sqrt(Math.max(0, (1 + (n0[0] * n1[0] + n0[1] * n1[1])) / 2)))
    const len = d / cosHalf
    out.push([ring[i]![0] - mx * len, ring[i]![1] - mz * len])
  }
  // a footprint narrower than twice the inset would fold over: keep the outer ring then
  const [x0, z0, x1, z1] = ringBBox(ring)
  if (Math.min(x1 - x0, z1 - z0) < d * 3) return ring.slice()
  return out
}

/** the oriented bounding box of a ring (hero-buildings.ts footprintObb — the roofs and the hero fits share it) */
const obb = footprintObb

function pick<T>(list: readonly T[], r: number): T {
  return list[Math.min(list.length - 1, Math.floor(r * list.length))]!
}

function weighted<T extends string>(weights: Record<T, number>, r: number): T {
  const keys = Object.keys(weights) as T[]
  let sum = 0
  for (const k of keys) sum += weights[k]
  let acc = 0
  for (const k of keys) {
    acc += weights[k] / sum
    if (r < acc) return k
  }
  return keys[keys.length - 1]!
}

const _c = new THREE.Color()
const _c2 = new THREE.Color()

interface Massed {
  id: number
  kind: SurBuildingKind
  base: number
  gMin: number
  gMax: number
  top: number
  cx: number
  cz: number
  rMax: number
  /** what the footprint got beyond its massing: a pack model on a plinth, an arch, a shed, PV, a block wall (segments), a gate, props, shutters */
  hero?: string
  arch?: true
  shed?: true
  pv?: true
  wall?: number
  gate?: true
  props?: true
  shutters?: number
}

/** `building=*` values that make a dwelling a corrugated shed regardless of its area */
const SHED_TAGS = new Set(['hut', 'garage', 'shed'])
/** the greenhouse arch: half-ellipse height (m) and the profile's point count (9 → 8 quads across) */
const GREENHOUSE = { h: 3.2, points: 9, colour: '#e8ece9' }
/** the dressing stays this far from the GP centreline (m) and off every drawn ground face — the far-field overlay rule */
const DRESS_MIN_D = 80
/** block-wall segment length (m): the wall follows the ground in steps of this */
const WALL_SEG_M = 6

/**
 * What the cell job hands `massBuilding` for the dressing of the detail level: the road network
 * (the road-facing rules — a house's gate, the works' shutters — and the walls' road clearance)
 * and the cell's other footprints (a block wall never crosses the neighbour's outline). null on
 * the mass-only tiers.
 */
interface Dress {
  net: RoadNet | null
  cell: readonly Planned[]
}

/**
 * One building into `mass` (and its ornaments into `detail`). Returns the numbers the offline
 * check reads (base, ground range) — the base is gMin − baseDrop by construction. `dress` is the
 * detail level's context (null = mass only).
 */
function massBuilding(ctx: EnvBuildContext, p: Planned, mass: Acc, detail: Acc | null, fascia: ((p: Planned, slabTop: number) => void) | null, dress: Dress | null): Massed {
  const { ground } = ctx
  const rng = mulberry(p.seed)
  // the Phase 4 choices draw from a second stream so every pick the massing made before (wall
  // tint, roof colour, rooftop units) is unchanged by the additions
  const rng2 = mulberry((p.seed ^ 0x5bd1e995) | 0)
  const ring = p.ring
  const n = ring.length
  let gMin = Infinity, gMax = -Infinity
  for (const [x, z] of ring) {
    const g = ground.standY(x, z)
    if (g < gMin) gMin = g
    if (g > gMax) gMax = g
  }
  const base = gMin - BUILDING.baseDrop
  const eavesY = gMin + p.eaves + Math.min(BUILDING.maxGroundRise, gMax - gMin)
  const normals = edgeNormals(ring)
  const kind = p.kind
  const inGrid = p.cell !== ctx.farField.outsideCell
  const massed: Massed = { id: p.b.id, kind, base, gMin, gMax, top: eavesY, cx: p.cx, cz: p.cz, rMax: p.rMax }

  // --- a hero footprint: the model stands on a plinth over the slope, the massing is skipped ----
  if (p.hero) {
    const o = p.hero.obb
    const plinth = _c.set(BUILDING.walls.house[0]!).clone()
    mass.box(o.cx, o.cz, o.ax, o.az, o.ha * 2, o.hc * 2, base, p.hero.y, plinth, FACADE_LAYER.plaster)
    massed.hero = p.hero.model
    massed.top = p.hero.y + p.hero.height
    if (detail && dress && inGrid) blockWall(ctx, p, detail, dress, massed)
    return massed
  }

  // --- a greenhouse: a film tunnel over the OBB (half-ellipse across the short side, swept along the long one), no walls, no bottom
  if (kind === 'greenhouse') {
    const box = obb(ring)
    const along = box.ha >= box.hc
    const ha = along ? box.ha : box.hc, hc = along ? box.hc : box.ha
    // the local frame: `a` along the long side, `k` across; the OBB axis is the long one unless the ring is wider than long
    const ax = along ? box.ax : -box.az, az = along ? box.az : box.ax
    const P = (a: number, k: number, y: number): number[] => [box.cx + ax * a - az * k, y, box.cz + az * a + ax * k]
    const T = TILE[FACADE_LAYER.sheet]
    const c = _c.set(GREENHOUSE.colour).clone()
    const N = GREENHOUSE.points
    const prof: { k: number; y: number; nk: number; ny: number }[] = []
    for (let i = 0; i < N; i++) {
      const t = (i / (N - 1)) * Math.PI
      const k = -hc * Math.cos(t), y = i === 0 || i === N - 1 ? base : gMin + GREENHOUSE.h * Math.sin(t)
      // the outward direction of an ellipse at parameter t: (cos t / hc, sin t / h) normalised
      const nk = -Math.cos(t) / hc, ny = Math.sin(t) / GREENHOUSE.h
      const l = Math.hypot(nk, ny) || 1
      prof.push({ k, y, nk: nk / l, ny: ny / l })
    }
    let arc = 0
    for (let i = 0; i + 1 < N; i++) {
      const q0 = prof[i]!, q1 = prof[i + 1]!
      const seg = Math.hypot(q1.k - q0.k, q1.y - q0.y)
      const nk = (q0.nk + q1.nk) / 2, ny = (q0.ny + q1.ny) / 2
      mass.face([P(-ha, q0.k, q0.y), P(ha, q0.k, q0.y), P(ha, q1.k, q1.y), P(-ha, q1.k, q1.y)],
        [[-ha / T[0], arc / T[1]], [ha / T[0], arc / T[1]], [ha / T[0], (arc + seg) / T[1]], [-ha / T[0], (arc + seg) / T[1]]], c, FACADE_LAYER.sheet, [-az * nk, ny, ax * nk])
      arc += seg
    }
    // the two end fans (the profile polygon is convex, closed by its base edge)
    for (const sgn of [-1, 1]) {
      const pts = prof.map((q) => P(sgn * ha, q.k, q.y))
      const uvs = prof.map((q) => [q.k / T[0], (q.y - base) / T[1]])
      mass.face(pts, uvs, c, FACADE_LAYER.sheet, [sgn * ax, 0, sgn * az])
    }
    massed.arch = true
    massed.top = gMin + GREENHOUSE.h
    return massed
  }

  // --- walls (a vertical quad per edge) ----------------------------------------------------
  const shed = kind === 'house' && (SHED_TAGS.has(p.b.tags.building ?? '') || p.b.area < HOUSE_DRESS.shedMaxArea)
  const wallColour = (): THREE.Color => {
    if (kind === 'ride') return _c.setHSL(hash2(p.seed, 1, 7), BUILDING.ride.s, BUILDING.ride.l).clone()
    const list = kind === 'house' ? BUILDING.walls.house
      : PARAPET_KINDS.has(kind) ? BUILDING.walls.industrial
      : kind === 'hotel' ? BUILDING.walls.hotel
      : kind === 'school' ? BUILDING.walls.school
      : kind === 'temple' ? BUILDING.walls.temple
      : BUILDING.walls.generic
    return _c.set(pick(list, rng())).clone()
  }
  // the corrugated sheets carry their colour in the layer: a near-white tint only (the sheds' galvanised grey, the works' painted blue)
  const blueWalls = (kind === 'industrial' || kind === 'warehouse') && rng2() < 0.5
  const wc = shed ? _c.set('#e6e6e4').clone() : blueWalls ? _c.set('#f4f4f2').clone() : wallColour()
  const storeys = Math.max(1, Math.round((eavesY - gMin) / BUILDING.storey))
  // only the dwellings and the hotel wings get the window-band layer; school / temple / generic
  // are plaster, the works ribbed metal (plan §2c) — half of the works and warehouses painted
  // corrugated sheet, the sheds galvanised sheet (Phase 4)
  const wallLayer: FacadeLayer = shed ? FACADE_LAYER.corrugatedDark
    : blueWalls ? FACADE_LAYER.corrugatedBlue
    : PARAPET_KINDS.has(kind) ? FACADE_LAYER.ribbed
    : kind === 'house' || kind === 'hotel' ? FACADE_LAYER.window
    : FACADE_LAYER.plaster
  const bandH = kind === 'house' ? (eavesY - gMin) / BUILDING.house.bands
    : kind === 'hotel' ? BUILDING.hotel.band
    : (eavesY - gMin) / storeys
  const wallTop = PARAPET_KINDS.has(kind) ? eavesY + BUILDING.industrial.parapet : eavesY
  const walls = (y0: number, y1: number, r: readonly XZ[], nm: readonly [number, number][], c: THREE.Color, layer: FacadeLayer, inward: boolean) => {
    let u = 0
    const tile = TILE[layer]
    const vOf = layer === FACADE_LAYER.ribbed ? (y: number) => (y - y0) / (y1 - y0) : layer === FACADE_LAYER.window ? (y: number) => (y - gMin) / bandH : (y: number) => (y - y0) / tile[1]
    for (let i = 0; i < r.length; i++) {
      const a = r[i]!, b = r[(i + 1) % r.length]!
      const len = Math.hypot(b[0] - a[0], b[1] - a[1])
      if (len < 0.05) continue
      const nn = nm[i]!
      const out: [number, number, number] = inward ? [-nn[0], 0, -nn[1]] : [nn[0], 0, nn[1]]
      const u0 = u / tile[0], u1 = (u + len) / tile[0]
      mass.face([[a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]]], [[u0, vOf(y0)], [u1, vOf(y0)], [u1, vOf(y1)], [u0, vOf(y1)]], c, layer, out)
      u += len
    }
  }

  if (kind === 'canopy') {
    // columns every ≤ pitch along the edges, inset so they stand under the slab, then the slab
    const col = _c.set(BUILDING.walls.column).clone()
    const side = BUILDING.canopy.column
    const slabTop = eavesY
    const slabBot = eavesY - BUILDING.canopy.slab
    const inner = insetRing(ring, normals, side)
    for (let i = 0; i < n; i++) {
      const a = inner[i]!, b = inner[(i + 1) % n]!
      const len = Math.hypot(b[0] - a[0], b[1] - a[1])
      const k = Math.max(1, Math.ceil(len / BUILDING.canopy.columnPitch))
      for (let j = 0; j < k; j++) {
        const t = j / k
        const x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t
        const y0 = ground.standY(x, z) - BUILDING.baseDrop
        mass.box(x, z, 1, 0, side, side, y0, slabBot, col, FACADE_LAYER.plaster)
      }
    }
    const slab = _c.set(BUILDING.walls.canopy[0]).clone()
    const uvW = (x: number, z: number): [number, number] => [x / 4, z / 4]
    mass.cap(ring, slabTop, true, slab, FACADE_LAYER.whiteMetal, uvW)
    mass.cap(ring, slabBot, false, slab, FACADE_LAYER.plaster, uvW)
    walls(slabBot, slabTop, ring, normals, slab, FACADE_LAYER.plaster, false)
    fascia?.(p, slabTop)
    massed.top = slabTop
    return massed
  }

  walls(base, wallTop, ring, normals, wc, wallLayer, false)

  // --- roofs -----------------------------------------------------------------------------------
  const box = obb(ring)
  const uvObb = (x: number, z: number, tile: number): [number, number] => {
    const dx = x - box.cx, dz = z - box.cz
    return [(dx * box.ax + dz * box.az) / tile, (-dx * box.az + dz * box.ax) / tile]
  }
  let top = wallTop
  if (HIP_KINDS.has(kind)) {
    // a hipped roof over the OBB: eaves overhang, pitch 4/10, a pyramid when the box is nearly square
    const e = BUILDING.house.eaves
    const ha = box.ha + e, hc = box.hc + e
    const rise = hc * BUILDING.house.pitch
    const ridgeHalf = box.ha + e > (box.hc + e) * BUILDING.house.pyramidRatio ? Math.max(0, ha - hc) : 0
    const pyramid = ridgeHalf < BUILDING.house.minRidge / 2
    const rh = pyramid ? 0 : ridgeHalf
    const tint = kind === 'temple' ? BUILDING.kawara.darkGrey : BUILDING.kawara[weighted(ROOF_WEIGHTS.house!, rng()) as keyof typeof BUILDING.kawara]
    // sheds: the same galvanised sheet as their walls; houses: 70 % plain kawara, 30 % the glazed scan (the kawara tints stay)
    const roofLayer: FacadeLayer = shed ? FACADE_LAYER.corrugatedDark : kind === 'house' && rng2() < 0.3 ? FACADE_LAYER.kawaraGlazed : FACADE_LAYER.kawara
    const rc = shed ? _c.set('#d8d8d6').clone() : _c.set(tint).clone()
    const P = (a: number, k: number, y: number): number[] => [box.cx + box.ax * a - box.az * k, y, box.cz + box.az * a + box.ax * k]
    const slope = Math.hypot(hc, rise)
    const T = TILE[roofLayer]
    const y0 = eavesY, y1 = eavesY + rise
    // the two long faces (trapezoids, triangles of a pyramid) and the two hip ends
    for (const s of [-1, 1]) {
      const pts = [P(-ha, s * hc, y0), P(ha, s * hc, y0), P(rh, 0, y1), P(-rh, 0, y1)]
      const uvs = [[-ha / T[0], 0], [ha / T[0], 0], [rh / T[0], slope / T[1]], [-rh / T[0], slope / T[1]]]
      if (pyramid) mass.face(pts.slice(0, 3), uvs.slice(0, 3), rc, roofLayer, [0, 1, 0])
      else mass.face(pts, uvs, rc, roofLayer, [0, 1, 0])
    }
    for (const s of [-1, 1]) {
      const pts = [P(s * ha, -hc, y0), P(s * ha, hc, y0), P(s * rh, 0, y1)]
      const uvs = [[-hc / T[0], 0], [hc / T[0], 0], [0, Math.hypot(ha - rh, rise) / T[1]]]
      mass.face(pts, uvs, rc, roofLayer, [0, 1, 0])
    }
    // the soffit: the overhang has no walls under it, and the mass has no bottom cap, so without
    // this the roof reads as a hole from below (2 triangles per house)
    mass.face([P(-ha, -hc, y0), P(ha, -hc, y0), P(ha, hc, y0), P(-ha, hc, y0)],
      [[0, 0], [(2 * ha) / T[0], 0], [(2 * ha) / T[0], (2 * hc) / T[1]], [0, (2 * hc) / T[1]]], _c2.set('#cfc9bd'), FACADE_LAYER.plaster, [0, -1, 0])
    top = y1
    if (shed) massed.shed = true
    // the PV array on the south-facing long face (a share of the houses; world +z is south)
    if (kind === 'house' && !shed && !pyramid && rng2() < HOUSE_DRESS.pv.share) {
      const sSouth = box.ax >= 0 ? 1 : -1
      if (Math.abs(box.ax) > 0.3 && pvPanel(mass, P, sSouth, ha, hc, rh, rise, slope, y0)) massed.pv = true
    }
    // sill bars under the window bands (detail level)
    if (detail && wallLayer === FACADE_LAYER.window) sills(detail, ring, normals, gMin, eavesY, bandH)
  } else if (PARAPET_KINDS.has(kind)) {
    const inner = insetRing(ring, normals, BUILDING.industrial.inset)
    const innerN = edgeNormals(inner)
    const roofKey = weighted(ROOF_WEIGHTS.industrial!, rng()) as 'whiteMetal' | 'blueMetal' | 'membrane'
    const roofLayer = FACADE_LAYER[roofKey]
    const roofC = _c.set('#ffffff').clone()
    mass.cap(inner, eavesY, true, roofC, roofLayer, (x, z) => uvObb(x, z, TILE[roofLayer][0]))
    // the parapet's inner face: from the slab up to the wall top, facing in
    walls(eavesY, wallTop, inner, innerN, wc, FACADE_LAYER.plaster, true)
    if (detail && p.b.area >= BUILDING.industrial.unitsFromArea) rooftopUnits(detail, p, box, eavesY, rng)
    if (detail && dress) shutters(ctx, p, detail, dress, normals, massed)
  } else {
    const roofC = _c.set('#ffffff').clone()
    mass.cap(ring, eavesY, true, roofC, FACADE_LAYER.membrane, (x, z) => uvObb(x, z, TILE[FACADE_LAYER.membrane][0]))
    if (kind === 'hotel') {
      // the plant room: a box on the roof at the OBB centre
      const la = box.ha * 2 * BUILDING.hotel.plantShare, lc = box.hc * 2 * BUILDING.hotel.plantShare
      if (la > 2 && lc > 2 && pointInRing(box.cx, box.cz, ring)) {
        mass.box(box.cx, box.cz, box.ax, box.az, la, lc, eavesY, eavesY + BUILDING.hotel.plantH, _c.set(BUILDING.walls.plant).clone(), FACADE_LAYER.membrane, FACADE_LAYER.plaster)
        top = eavesY + BUILDING.hotel.plantH
      }
    }
    if (detail && wallLayer === FACADE_LAYER.window) sills(detail, ring, normals, gMin, eavesY, bandH)
  }
  // the house dressing (detail level, inside the grid): the block wall with its gate, the props on the longest wall
  if (detail && dress && inGrid && kind === 'house' && !shed) {
    blockWall(ctx, p, detail, dress, massed)
    if (houseProps(ctx, p, detail, normals, rng2)) massed.props = true
  }
  massed.top = top
  return massed
}

/**
 * The PV array on one long face of a hipped roof: a trapezoid inset `pv.inset` from the eaves,
 * the ridge and (along the hips' diagonal) the two hip lines, `pv.proud` off the tiles along the
 * face normal, one 1.65 × 1 m module per texture tile. The face frame is the roof's: `a` along
 * the ridge, `k = s · hc · (1 − f)` and `y = y0 + f · rise` at slope fraction f. false when the
 * face is too small for a module.
 */
function pvPanel(mass: Acc, P: (a: number, k: number, y: number) => number[], s: number, ha: number, hc: number, rh: number, rise: number, slope: number, y0: number): boolean {
  const { inset, proud } = HOUSE_DRESS.pv
  const f0 = inset / slope, f1 = 1 - inset / slope
  if (f1 - f0 < 0.2) return false
  const aMax = (f: number) => ha - (ha - rh) * f - inset * 1.2
  if (aMax(f1) < 0.9) return false
  // the face normal in the (k, y) plane: perpendicular to the slope (−s·hc, rise), pointing out and up
  const nl = Math.hypot(rise, hc)
  const nk = (s * rise) / nl, ny = hc / nl
  const T = TILE[FACADE_LAYER.pv]
  const corner = (a: number, f: number): number[] => {
    const q = P(a, s * hc * (1 - f) + nk * proud, y0 + f * rise + ny * proud)
    return q
  }
  const pts = [corner(-aMax(f0), f0), corner(aMax(f0), f0), corner(aMax(f1), f1), corner(-aMax(f1), f1)]
  const uvs = [[0, 0], [(2 * aMax(f0)) / T[0], 0], [(aMax(f0) + aMax(f1)) / T[0], ((f1 - f0) * slope) / T[1]], [(aMax(f0) - aMax(f1)) / T[0], ((f1 - f0) * slope) / T[1]]]
  const a = pts[0]!, b = pts[1]!, d = pts[3]!
  // the outward normal from the corners themselves (the frame's k axis is the caller's)
  const nx = (b[1]! - a[1]!) * (d[2]! - a[2]!) - (b[2]! - a[2]!) * (d[1]! - a[1]!)
  const nyy = (b[2]! - a[2]!) * (d[0]! - a[0]!) - (b[0]! - a[0]!) * (d[2]! - a[2]!)
  const nz = (b[0]! - a[0]!) * (d[1]! - a[1]!) - (b[1]! - a[1]!) * (d[0]! - a[0]!)
  const up: [number, number, number] = nyy >= 0 ? [nx, nyy, nz] : [-nx, -nyy, -nz]
  mass.face(pts, uvs, _c2.set('#ffffff'), FACADE_LAYER.pv, up)
  return true
}

/** the point of the far-field overlay rule for the dressing: outside DRESS_MIN_D of the centreline and on no drawn face */
function dressSiteOk(ctx: EnvBuildContext, x: number, z: number): boolean {
  return ctx.ground.plan.project(x, z).d >= DRESS_MIN_D && !ctx.ground.builtY(x, z)
}

/**
 * The ブロック塀 around a house (detail level): the footprint ring pushed `wall.offset` out,
 * each edge walked in ≤ WALL_SEG_M steps as a `wall.t` thick box from `wall.h` over the higher
 * end's ground to 0.3 m under the lower end's. A `wall.gate` gap opens in the middle of the edge
 * whose midpoint is nearest a road (the front); segments are dropped where they would stand in a
 * road's paved width + 1.2 m, inside another footprint of the cell, on a drawn ground face or
 * inside DRESS_MIN_D of the centreline.
 */
function blockWall(ctx: EnvBuildContext, p: Planned, acc: Acc, dress: Dress, massed: Massed) {
  const { ground } = ctx
  const W = HOUSE_DRESS.wall
  const ring = p.ring
  const n = ring.length
  const normals = edgeNormals(ring)
  const outer = insetRing(ring, normals, -W.offset)
  if (outer === ring) return
  const c = _c2.set('#e4e2dc')
  // the road-facing edge: the one whose midpoint is nearest a road (long enough for the gate)
  let gateEdge = -1, gateD = Infinity
  if (dress.net) {
    for (let i = 0; i < n; i++) {
      const a = outer[i]!, b = outer[(i + 1) % n]!
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < W.gate + 1) continue
      const nr = nearestRoad(dress.net, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 40)
      if (nr && nr.d < gateD) { gateD = nr.d; gateEdge = i }
    }
  }
  const others = dress.cell.filter((o) => o !== p && o.box[2] > p.box[0] - W.offset - 1 && o.box[0] < p.box[2] + W.offset + 1 && o.box[3] > p.box[1] - W.offset - 1 && o.box[1] < p.box[3] + W.offset + 1)
  const blocked = (x: number, z: number): boolean => {
    if (!dressSiteOk(ctx, x, z)) return true
    if (dress.net) {
      const nr = nearestRoad(dress.net, x, z, 40)
      if (nr && nr.d < nr.way.hw + 1.2) return true
    }
    for (const o of others) if (inBBox(x, z, o.box) && pointInRing(x, z, o.ring)) return true
    return false
  }
  let segments = 0
  for (let i = 0; i < n; i++) {
    const a = outer[i]!, b = outer[(i + 1) % n]!
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (len < 0.5) continue
    const ux = (b[0] - a[0]) / len, uz = (b[1] - a[1]) / len
    // the runs of this edge: the whole edge, or the two sides of the gate
    const runs: [number, number][] = i === gateEdge ? [[0, (len - W.gate) / 2], [(len + W.gate) / 2, len]] : [[0, len]]
    let built = 0
    for (const [r0, r1] of runs) {
      const k = Math.max(1, Math.ceil((r1 - r0) / WALL_SEG_M))
      for (let j = 0; j < k; j++) {
        const s0 = r0 + ((r1 - r0) * j) / k, s1 = r0 + ((r1 - r0) * (j + 1)) / k
        const x0 = a[0] + ux * s0, z0 = a[1] + uz * s0, x1 = a[0] + ux * s1, z1 = a[1] + uz * s1
        const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2
        if (blocked(x0, z0) || blocked(x1, z1) || blocked(mx, mz)) continue
        const g0 = ground.standY(x0, z0), g1 = ground.standY(x1, z1)
        acc.box(mx, mz, ux, uz, s1 - s0, W.t, Math.min(g0, g1) - 0.3, Math.max(g0, g1) + W.h, c, FACADE_LAYER.block)
        built++
      }
    }
    segments += built
    if (built && i === gateEdge) massed.gate = true
  }
  if (segments) massed.wall = segments
}

/**
 * The props at the foot of a house's longest wall (detail level): the aircon's outdoor unit on
 * a bracket 0.3 m up, an LPG cylinder (8-sided) and the water heater beside it, in the plaster
 * greys of the rooftop units and the plant rooms. Skipped when the wall is under 4 m or the spot
 * fails the overlay rule.
 */
function houseProps(ctx: EnvBuildContext, p: Planned, acc: Acc, normals: readonly [number, number][], rng: () => number): boolean {
  const { ground } = ctx
  const ring = p.ring
  const n = ring.length
  let best = -1, longest = 0
  for (let i = 0; i < n; i++) {
    const len = Math.hypot(ring[(i + 1) % n]![0] - ring[i]![0], ring[(i + 1) % n]![1] - ring[i]![1])
    if (len > longest) { longest = len; best = i }
  }
  if (best < 0 || longest < 4) return false
  const a = ring[best]!, b = ring[(best + 1) % n]!
  const ux = (b[0] - a[0]) / longest, uz = (b[1] - a[1]) / longest
  const nn = normals[best]!
  const t = 0.8 + rng() * Math.max(0, longest - 3.6)
  const at = (along: number, out: number): [number, number] => [a[0] + ux * along + nn[0] * out, a[1] + uz * along + nn[1] * out]
  const [qx, qz] = at(t, 0.3)
  if (!dressSiteOk(ctx, qx, qz)) return false
  const g = ground.standY(qx, qz)
  const A = HOUSE_DRESS.props.aircon, L = HOUSE_DRESS.props.lpg, H = HOUSE_DRESS.props.heater
  const [ax, az] = at(t, A[1] / 2 + 0.03)
  acc.box(ax, az, ux, uz, A[0], A[1], g + 0.3, g + 0.3 + A[2], _c2.set(BUILDING.walls.unit), FACADE_LAYER.plaster)
  const [lx, lz] = at(t + A[0] / 2 + 0.35, L.r + 0.05)
  acc.prism(lx, lz, L.r, 8, g, g + L.h, _c2.set(BUILDING.walls.canopy[0]), FACADE_LAYER.plaster)
  const [hx, hz] = at(t + A[0] / 2 + 0.35 + L.r + 0.15 + H[0] / 2, H[1] / 2 + 0.03)
  acc.box(hx, hz, ux, uz, H[0], H[1], g + 0.3, g + 0.3 + H[2], _c2.set(BUILDING.walls.plant), FACADE_LAYER.plaster)
  return true
}

/**
 * Roller shutters on the works / warehouses / shops (detail level): `shutter.w` × `shutter.h`
 * quads 3 cm proud of the road-facing long edge (an edge at least 60 % of the longest whose
 * midpoint is nearest a road within 60 m; without a road, the one farthest from the circuit —
 * the fascia rule), every `shutter.pitch` m from 4 m in, at most `shutter.max`.
 */
function shutters(ctx: EnvBuildContext, p: Planned, acc: Acc, dress: Dress, normals: readonly [number, number][], massed: Massed) {
  const { ground } = ctx
  const S = HOUSE_DRESS.shutter
  const ring = p.ring
  const n = ring.length
  let longest = 0
  for (let i = 0; i < n; i++) longest = Math.max(longest, Math.hypot(ring[(i + 1) % n]![0] - ring[i]![0], ring[(i + 1) % n]![1] - ring[i]![1]))
  if (longest < S.w + 2) return
  let best = -1, bestScore = -Infinity
  for (let i = 0; i < n; i++) {
    const a = ring[i]!, b = ring[(i + 1) % n]!
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (len < longest * 0.6) continue
    const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2
    const nr = dress.net ? nearestRoad(dress.net, mx, mz, 60) : null
    // nearer a road is better; without one, farther from the circuit is better (a lower score band so a road always wins)
    const score = nr ? 1000 - nr.d : ground.plan.project(mx, mz).d
    if (score > bestScore) { bestScore = score; best = i }
  }
  if (best < 0) return
  const a = ring[best]!, b = ring[(best + 1) % n]!
  const len = Math.hypot(b[0] - a[0], b[1] - a[1])
  const ux = (b[0] - a[0]) / len, uz = (b[1] - a[1]) / len
  const nn = normals[best]!
  const c = _c2.set('#d3d6d9')
  let count = 0
  for (let pos = 4 + S.w / 2; pos + S.w / 2 + 1 < len && count < S.max; pos += S.pitch) {
    const mx = a[0] + ux * pos, mz = a[1] + uz * pos
    if (!dressSiteOk(ctx, mx, mz)) continue
    const g = ground.standY(mx, mz)
    const ox = nn[0] * 0.03, oz = nn[1] * 0.03
    const x0 = mx - ux * (S.w / 2) + ox, z0 = mz - uz * (S.w / 2) + oz, x1 = mx + ux * (S.w / 2) + ox, z1 = mz + uz * (S.w / 2) + oz
    acc.face([[x0, g, z0], [x1, g, z1], [x1, g + S.h, z1], [x0, g + S.h, z0]], [[0, 0], [1, 0], [1, 1], [0, 1]], c, FACADE_LAYER.shutter, [nn[0], 0, nn[1]])
    count++
  }
  if (count) massed.shutters = count
}

/** detail level: a sill bar under every window band on walls at least `sillMinEdge` long */
function sills(acc: Acc, ring: readonly XZ[], normals: readonly [number, number][], gMin: number, eavesY: number, bandH: number) {
  const { d, h } = BUILDING.detail.sill
  const c = _c2.set('#d8d6d0')
  const n = ring.length
  for (let i = 0; i < n; i++) {
    const a = ring[i]!, b = ring[(i + 1) % n]!
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (len < BUILDING.detail.sillMinEdge) continue
    const nn = normals[i]!
    const ux = (b[0] - a[0]) / len, uz = (b[1] - a[1]) / len
    for (let band = 0; band < 6; band++) {
      const y = gMin + band * bandH + bandH * 0.33
      if (y + h > eavesY - 0.2) break
      const x0 = a[0] + ux * 0.3, z0 = a[1] + uz * 0.3, x1 = b[0] - ux * 0.3, z1 = b[1] - uz * 0.3
      const ox = nn[0] * d, oz = nn[1] * d
      // front, top, bottom
      acc.face([[x0 + ox, y, z0 + oz], [x1 + ox, y, z1 + oz], [x1 + ox, y + h, z1 + oz], [x0 + ox, y + h, z0 + oz]], [[0, 0], [1, 0], [1, 1], [0, 1]], c, FACADE_LAYER.plaster, [nn[0], 0, nn[1]])
      acc.face([[x0, y + h, z0], [x1, y + h, z1], [x1 + ox, y + h, z1 + oz], [x0 + ox, y + h, z0 + oz]], [[0, 0], [1, 0], [1, 1], [0, 1]], c, FACADE_LAYER.plaster, [0, 1, 0])
      acc.face([[x0, y, z0], [x1, y, z1], [x1 + ox, y, z1 + oz], [x0 + ox, y, z0 + oz]], [[0, 0], [1, 0], [1, 1], [0, 1]], c, FACADE_LAYER.plaster, [0, -1, 0])
    }
  }
}

/** detail level: HVAC boxes on a big flat roof, hashed positions inside the OBB core that fall inside the footprint */
function rooftopUnits(acc: Acc, p: Planned, box: Obb, roofY: number, rng: () => number) {
  const count = Math.min(BUILDING.industrial.unitsMax, Math.max(2, Math.round(p.b.area * BUILDING.industrial.unitPerArea)))
  const [ul, uw, uh] = BUILDING.detail.unit
  const c = _c2.set(BUILDING.walls.unit)
  for (let i = 0; i < count; i++) {
    const a = (rng() - 0.5) * 1.4 * (box.ha - 3), k = (rng() - 0.5) * 1.4 * (box.hc - 3)
    const x = box.cx + box.ax * a - box.az * k, z = box.cz + box.az * a + box.ax * k
    if (!pointInRing(x, z, p.ring)) continue
    acc.box(x, z, box.ax, box.az, ul, uw, roofY, roofY + uh, c, FACADE_LAYER.plaster)
  }
}

// ---------------------------------------------------------------------------------------------
// Motopia: the coaster and the pools

interface CoasterSample { x: number; z: number; y: number; ground: number; d: number }

/** chain the coaster ways end to end starting at the way that leaves the station, with the layer of each way carried per vertex */
function coasterChain(ctx: EnvBuildContext): { pts: XZ[]; layer: number[] } {
  const k = ctx.track.enScale
  const ways = SUR_SITES.filter((s) => s.role === 'coaster' && !s.closed).map((s) => ({ pts: ringFromFlat(worldRing(s, k)), layer: Number(s.tags.layer ?? 0) }))
  const station = SUR_SITES.find((s) => s.role === 'coaster_station')
  if (!ways.length) return { pts: [], layer: [] }
  const sx = station ? station.centroid[0] * k : ways[0]!.pts[0]![0], sz = station ? -station.centroid[1] * k : ways[0]!.pts[0]![1]
  const d2 = (a: XZ, b: XZ) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2
  // start with the way whose first vertex is nearest the station
  let cur = ways.reduce((best, w) => (d2(w.pts[0]!, [sx, sz]) < d2(best.pts[0]!, [sx, sz]) ? w : best), ways[0]!)
  const left = new Set(ways.filter((w) => w !== cur))
  const pts: XZ[] = [...cur.pts]
  const layer: number[] = cur.pts.map(() => cur.layer)
  while (left.size) {
    const end = pts[pts.length - 1]!
    let next: (typeof cur) | null = null, reversed = false, bd = Infinity
    for (const w of left) {
      const d0 = d2(w.pts[0]!, end), d1 = d2(w.pts[w.pts.length - 1]!, end)
      if (d0 < bd) { bd = d0; next = w; reversed = false }
      if (d1 < bd) { bd = d1; next = w; reversed = true }
    }
    if (!next || bd > 30 * 30) break
    left.delete(next)
    const seq = reversed ? [...next.pts].reverse() : next.pts
    for (let i = 0; i < seq.length; i++) {
      if (i === 0 && bd < 0.25) continue
      pts.push(seq[i]!)
      layer.push(next.layer)
    }
    cur = next
  }
  return { pts, layer }
}

function buildCoaster(ctx: EnvBuildContext, acc: Acc, keep: { x: number; z: number; r: number }[]): { ways: number; samples: number; tooNear: number } {
  const { ground } = ctx
  const C = MOTOPIA.coaster
  const { pts, layer } = coasterChain(ctx)
  if (pts.length < 2) return { ways: 0, samples: 0, tooNear: 0 }
  // resample the chain at sampleM
  const raw: { x: number; z: number; layer: number; s: number }[] = []
  let s = 0
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!, b = pts[i + 1]!
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    const k = Math.max(1, Math.ceil(len / C.sampleM))
    for (let j = 0; j < k; j++) {
      const t = j / k
      raw.push({ x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, layer: layer[i]!, s: s + len * t })
    }
    s += len
  }
  const last = pts[pts.length - 1]!
  raw.push({ x: last[0], z: last[1], layer: layer[layer.length - 1]!, s })
  const total = s
  // the deck height over the ground: layer × layerH + baseH, smoothed across the way joints, plus
  // the humps, eased to the station height at both ends of the chain
  const target = raw.map((r) => r.layer * C.layerH + C.baseH)
  const half = Math.round(C.smoothM / C.sampleM)
  const smooth = target.map((_, i) => {
    let sum = 0, cnt = 0
    for (let j = Math.max(0, i - half); j <= Math.min(target.length - 1, i + half); j++) { sum += target[j]!; cnt++ }
    return sum / cnt
  })
  let tooNear = 0
  const samples: CoasterSample[] = raw.map((r, i) => {
    const hump = C.hump * 0.5 * (1 - Math.cos((r.s / C.humpPeriod) * Math.PI * 2))
    const endD = Math.min(r.s, total - r.s)
    const ease = Math.min(1, endD / C.stationEase)
    const eased = ease * ease * (3 - 2 * ease)
    const h = C.stationH + (smooth[i]! + hump - C.stationH) * eased
    const g = ground.standY(r.x, r.z)
    const d = ground.plan.project(r.x, r.z).d
    if (d < 140) tooNear++
    return { x: r.x, z: r.z, y: g + h, ground: g, d }
  })
  // --- the deck ribbon, the rails, the supports --------------------------------------------
  const deck = _c.set(C.colours.deck).clone(), rail = _c2.set(C.colours.rail).clone(), sup = new THREE.Color(C.colours.support)
  const L = FACADE_LAYER.plaster
  const dirAt = (i: number): [number, number] => {
    const a = samples[Math.max(0, i - 1)]!, b = samples[Math.min(samples.length - 1, i + 1)]!
    const dx = b.x - a.x, dz = b.z - a.z
    const l = Math.hypot(dx, dz) || 1
    return [dx / l, dz / l]
  }
  for (let i = 0; i + 1 < samples.length; i++) {
    const a = samples[i]!, b = samples[i + 1]!
    if (a.d < 140 || b.d < 140) continue
    const [ux, uz] = dirAt(i), [vx, vz] = dirAt(i + 1)
    const hw = C.deckW / 2
    const pa = (k: number, dy = 0): number[] => [a.x - uz * k, a.y + dy, a.z + ux * k]
    const pb = (k: number, dy = 0): number[] => [b.x - vz * k, b.y + dy, b.z + vx * k]
    // deck top and its two side skirts
    acc.face([pa(-hw), pb(-hw), pb(hw), pa(hw)], [[0, 0], [1, 0], [1, 1], [0, 1]], deck, L, [0, 1, 0])
    // lateral k runs along (−uz, ux): the +hw skirt faces that way, the −hw skirt the other
    acc.face([pa(hw, -0.35), pb(hw, -0.35), pb(hw), pa(hw)], [[0, 0], [1, 0], [1, 1], [0, 1]], deck, L, [-uz, 0, ux])
    acc.face([pa(-hw, -0.35), pb(-hw, -0.35), pb(-hw), pa(-hw)], [[0, 0], [1, 0], [1, 1], [0, 1]], deck, L, [uz, 0, -ux])
    // two rails: a bar of three faces (top and two sides) on each gauge line
    for (const g of [-C.railGauge / 2, C.railGauge / 2]) {
      const r = C.rail / 2
      acc.face([pa(g - r, C.rail), pb(g - r, C.rail), pb(g + r, C.rail), pa(g + r, C.rail)], [[0, 0], [1, 0], [1, 1], [0, 1]], rail, L, [0, 1, 0])
      acc.face([pa(g + r, 0), pb(g + r, 0), pb(g + r, C.rail), pa(g + r, C.rail)], [[0, 0], [1, 0], [1, 1], [0, 1]], rail, L, [-uz, 0, ux])
      acc.face([pa(g - r, 0), pb(g - r, 0), pb(g - r, C.rail), pa(g - r, C.rail)], [[0, 0], [1, 0], [1, 1], [0, 1]], rail, L, [uz, 0, -ux])
    }
  }
  // A-frame supports every supportPitch: two legs from the ground to the deck edges, a cross bar half way
  let nextS = 0
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i]!, sm = samples[i]!
    if (r.s < nextS) continue
    nextS = r.s + C.supportPitch
    if (sm.d < 140) continue
    const [ux, uz] = dirAt(i)
    const bar = C.supportBar
    const footK = C.deckW / 2 + 0.9
    const topK = C.deckW / 2 - 0.1
    const y0 = sm.ground - BUILDING.baseDrop, y1 = sm.y - 0.35
    const leg = (k0: number, k1: number) => {
      const a: number[] = [sm.x - uz * k0, y0, sm.z + ux * k0], b: number[] = [sm.x - uz * k1, y1, sm.z + ux * k1]
      const fx = ux * bar / 2, fz = uz * bar / 2
      // a bar with four faces along the leg's direction (front / back / outer / inner)
      const p = (q: number[], dx: number, dz: number, dy: number): number[] => [q[0]! + dx, q[1]! + dy, q[2]! + dz]
      acc.face([p(a, fx, fz, 0), p(b, fx, fz, 0), p(b, -fx, -fz, 0), p(a, -fx, -fz, 0)], [[0, 0], [1, 0], [1, 1], [0, 1]], sup, L, [0, -1, 0])
      acc.face([p(a, fx, fz, 0), p(a, fx, fz, bar), p(b, fx, fz, bar), p(b, fx, fz, 0)], [[0, 0], [1, 0], [1, 1], [0, 1]], sup, L, [ux, 0, uz])
      acc.face([p(a, -fx, -fz, 0), p(b, -fx, -fz, 0), p(b, -fx, -fz, bar), p(a, -fx, -fz, bar)], [[0, 0], [1, 0], [1, 1], [0, 1]], sup, L, [-ux, 0, -uz])
      acc.face([p(a, fx, fz, bar), p(a, -fx, -fz, bar), p(b, -fx, -fz, bar), p(b, fx, fz, bar)], [[0, 0], [1, 0], [1, 1], [0, 1]], sup, L, [0, 1, 0])
    }
    leg(-footK, -topK)
    leg(footK, topK)
    // the cross bar at mid height
    const ym = (y0 + y1) / 2
    const km = (footK + topK) / 2
    const px = -uz, pz = ux
    acc.face([[sm.x + px * -km, ym, sm.z + pz * -km], [sm.x + px * km, ym, sm.z + pz * km], [sm.x + px * km, ym + bar, sm.z + pz * km], [sm.x + px * -km, ym + bar, sm.z + pz * -km]], [[0, 0], [1, 0], [1, 1], [0, 1]], sup, L, [ux, 0, uz])
    acc.face([[sm.x + px * -km, ym, sm.z + pz * -km], [sm.x + px * km, ym, sm.z + pz * km], [sm.x + px * km, ym + bar, sm.z + pz * km], [sm.x + px * -km, ym + bar, sm.z + pz * -km]], [[0, 0], [1, 0], [1, 1], [0, 1]], sup, L, [-ux, 0, -uz])
    keep.push({ x: sm.x, z: sm.z, r: C.keepOutR })
  }
  // the parked train: four cars on the deck just out of the station (the first hump's foot)
  {
    const seat = new THREE.Color(C.colours.seat)
    let i = Math.min(samples.length - 2, Math.round((C.stationEase + 4) / C.sampleM))
    for (let car = 0; car < C.cars && i + 1 < samples.length; car++) {
      const sm = samples[i]!
      if (sm.d >= 140) {
        const [ux, uz] = dirAt(i)
        const cc = new THREE.Color(C.colours.car[car % C.colours.car.length]!)
        acc.box(sm.x, sm.z, ux, uz, C.carL, C.carW, sm.y + 0.05, sm.y + C.carH, cc, L)
        acc.box(sm.x, sm.z, ux, uz, C.carL * 0.7, C.carW * 0.6, sm.y + C.carH, sm.y + C.carH + 0.35, seat, L)
      }
      i += Math.ceil((C.carL + 0.4) / C.sampleM)
    }
  }
  return { ways: SUR_SITES.filter((s) => s.role === 'coaster').length, samples: samples.length, tooNear }
}

/** the drained pools: a pale floor overlay cut along the terrain (≥ 140 m, no drawn face) and a coping ring */
function buildPools(ctx: EnvBuildContext, grid: GridShape, acc: Acc): { pools: number; floorTris: number } {
  const { ground } = ctx
  const P = MOTOPIA.pool
  const k = ctx.track.enScale
  const floorC = new THREE.Color(P.floor), copingC = new THREE.Color(P.copingColour)
  let pools = 0, floorTris = 0
  for (const site of SUR_SITES) {
    if (site.role !== 'pool' || !site.closed) continue
    const ring = ringFromFlat(worldRing(site, k))
    if (ring.length < 3 || site.dmin < 140) continue
    const cut = cellClippedPolygon(ring, { grid, ground, plan: ground.plan, minD: 140, subdiv: 1, yOf: () => P.lift })
    if (cut.top) {
      const pos = cut.top.getAttribute('position') as THREE.BufferAttribute
      const nrm = cut.top.getAttribute('normal') as THREE.BufferAttribute
      const idx = cut.top.getIndex()!
      const base = acc.vertices
      for (let i = 0; i < pos.count; i++) acc.vertex(pos.getX(i), pos.getY(i), pos.getZ(i), nrm.getX(i), nrm.getY(i), nrm.getZ(i), pos.getX(i) / 6, pos.getZ(i) / 6, floorC, FACADE_LAYER.membrane)
      for (let i = 0; i < idx.count; i++) acc.idx.push(base + idx.getX(i))
      floorTris += cut.triangles
      cut.top.dispose()
    }
    // the coping: a ring `copingW` wide standing `coping` high on the pool's edge
    const normals = edgeNormals(ring)
    const outer = insetRing(ring, normals, -P.copingW)
    const n = ring.length
    for (let i = 0; i < n; i++) {
      const a = ring[i]!, b = ring[(i + 1) % n]!, oa = outer[i]!, ob = outer[(i + 1) % n]!
      const ya = ground.standY(a[0], a[1]), yb = ground.standY(b[0], b[1])
      const top = Math.max(ya, yb) + P.coping
      const nn = normals[i]!
      acc.face([[a[0], top, a[1]], [b[0], top, b[1]], [ob[0], top, ob[1]], [oa[0], top, oa[1]]], [[0, 0], [1, 0], [1, 0.1], [0, 0.1]], copingC, FACADE_LAYER.plaster, [0, 1, 0])
      acc.face([[oa[0], ya - 0.3, oa[1]], [ob[0], yb - 0.3, ob[1]], [ob[0], top, ob[1]], [oa[0], top, oa[1]]], [[0, 0], [1, 0], [1, 0.2], [0, 0.2]], copingC, FACADE_LAYER.plaster, [nn[0], 0, nn[1]])
      acc.face([[a[0], ya - 0.3, a[1]], [b[0], yb - 0.3, b[1]], [b[0], top, b[1]], [a[0], top, a[1]]], [[0, 0], [1, 0], [1, 0.2], [0, 0.2]], copingC, FACADE_LAYER.plaster, [-nn[0], 0, -nn[1]])
    }
    pools++
  }
  return { pools, floorTris }
}

// ---------------------------------------------------------------------------------------------
// the campsite

function tentGeometries(): { dome: THREE.BufferGeometry; aframe: THREE.BufferGeometry; tarp: THREE.BufferGeometry } {
  const D = CAMPSITE.dome, A = CAMPSITE.aframe, T = CAMPSITE.tarp
  const dome = new THREE.SphereGeometry(1, 7, 3, 0, Math.PI * 2, 0, Math.PI / 2)
  dome.scale(D.r, D.h, D.r)
  dome.computeBoundingSphere()
  // A-frame: two slopes and two gable ends
  const af = new Acc()
  const c = new THREE.Color(1, 1, 1)
  const hw = A.w / 2, hl = A.l / 2
  af.face([[-hw, 0, -hl], [-hw, 0, hl], [0, A.h, hl], [0, A.h, -hl]], [[0, 0], [1, 0], [1, 1], [0, 1]], c, 0, [-1, 0.6, 0])
  af.face([[hw, 0, -hl], [hw, 0, hl], [0, A.h, hl], [0, A.h, -hl]], [[0, 0], [1, 0], [1, 1], [0, 1]], c, 0, [1, 0.6, 0])
  af.face([[-hw, 0, -hl], [hw, 0, -hl], [0, A.h, -hl]], [[0, 0], [1, 0], [0.5, 1]], c, 0, [0, 0, -1])
  af.face([[-hw, 0, hl], [hw, 0, hl], [0, A.h, hl]], [[0, 0], [1, 0], [0.5, 1]], c, 0, [0, 0, 1])
  const aframe = af.geometry()!
  // tarp: a sheet on four poles (the sheet is double sided through the material side)
  const tp = new Acc()
  const tw = T.w / 2, tl = T.l / 2
  tp.face([[-tw, T.h, -tl], [-tw, T.h, tl], [tw, T.h, tl], [tw, T.h, -tl]], [[0, 0], [1, 0], [1, 1], [0, 1]], c, 0, [0, 1, 0])
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
    const x = sx * (tw - 0.1), z = sz * (tl - 0.1), r = T.pole
    tp.face([[x - r, 0, z - r], [x + r, 0, z - r], [x + r, T.h, z - r], [x - r, T.h, z - r]], [[0, 0], [1, 0], [1, 1], [0, 1]], c, 0, [0, 0, -1])
    tp.face([[x - r, 0, z + r], [x + r, 0, z + r], [x + r, T.h, z + r], [x - r, T.h, z + r]], [[0, 0], [1, 0], [1, 1], [0, 1]], c, 0, [0, 0, 1])
    tp.face([[x - r, 0, z - r], [x - r, 0, z + r], [x - r, T.h, z + r], [x - r, T.h, z - r]], [[0, 0], [1, 0], [1, 1], [0, 1]], c, 0, [-1, 0, 0])
  }
  const tarp = tp.geometry()!
  for (const g of [aframe, tarp]) {
    g.deleteAttribute('color')
    g.deleteAttribute('aLayer')
  }
  return { dome, aframe, tarp }
}

function buildCampsite(ctx: EnvBuildContext, planned: Planned[], stats: BuildingsStats): THREE.Object3D | null {
  const { ground, farField, quality: q } = ctx
  const site = SUR_SITES.find((s) => s.role === 'camp_site' && s.closed)
  if (!site) return null
  const k = ctx.track.enScale
  const ring = ringFromFlat(worldRing(site, k))
  if (ring.length < 3) return null
  const box = ringBBox(ring)
  const blocked = planned.filter((p) => p.box[2] > box[0] && p.box[0] < box[2] && p.box[3] > box[1] && p.box[1] < box[3])
  const geos = tentGeometries()
  const tentMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0, side: THREE.DoubleSide })
  const kinds: (keyof typeof geos)[] = ['dome', 'aframe', 'tarp']
  const mats: Record<keyof typeof geos, THREE.Matrix4[]> = { dome: [], aframe: [], tarp: [] }
  const cols: Record<keyof typeof geos, THREE.Color[]> = { dome: [], aframe: [], tarp: [] }
  const pitches: { x: number; z: number; y: number }[] = []
  const G = CAMPSITE.grid
  const i0 = Math.floor(box[0] / G), i1 = Math.ceil(box[2] / G), j0 = Math.floor(box[1] / G), j1 = Math.ceil(box[3] / G)
  const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(1, 1, 1)
  const Y = new THREE.Vector3(0, 1, 0)
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const r0 = hash2(i, j, 501), r1 = hash2(i, j, 502), r2 = hash2(i, j, 503), r3 = hash2(i, j, 504), r4 = hash2(i, j, 505)
      const x = (i + 0.5) * G + (r0 - 0.5) * 2 * CAMPSITE.jitter, z = (j + 0.5) * G + (r1 - 0.5) * 2 * CAMPSITE.jitter
      if (!inBBox(x, z, box) || !pointInRing(x, z, ring)) continue
      if (ground.builtY(x, z) || ground.plan.project(x, z).d < 140) continue
      if (blocked.some((p) => Math.hypot(x - p.cx, z - p.cz) < p.rMax + 4)) continue
      const y = ground.standY(x, z)
      pitches.push({ x, z, y })
      if (r2 >= CAMPSITE.fill) continue
      const kind: keyof typeof geos = r3 < CAMPSITE.kinds.dome ? 'dome' : r3 < CAMPSITE.kinds.dome + CAMPSITE.kinds.aframe ? 'aframe' : 'tarp'
      _q.setFromAxisAngle(Y, r4 * Math.PI * 2)
      mats[kind].push(new THREE.Matrix4().compose(_p.set(x, y - 0.02, z), _q, _s))
      cols[kind].push(new THREE.Color(pick(CAMPSITE.colours, hash2(i, j, 506))))
    }
  }
  const root = new THREE.Group()
  root.name = 'campsite'
  const range = q.farField.rangeFar
  let tents = 0
  for (const kind of kinds) {
    if (!mats[kind].length) continue
    tents += mats[kind].length
    farField.registerBuckets('buildings', `campTents${kind[0]!.toUpperCase()}${kind.slice(1)}`, geos[kind], tentMat, mats[kind], cols[kind], [{ range }], { castShadow: q.farField.shadows })
  }
  // campervans: plain boxes on the pitches nearest the entrance side (the lowest hash), merged
  const vans = new Acc()
  const V = CAMPSITE.van
  const chosen = pitches.map((p, i) => ({ p, r: hash2(i, 7, 511) })).sort((a, b) => a.r - b.r).slice(0, CAMPSITE.vans)
  chosen.forEach(({ p }, i) => {
    const yaw = hash2(i, 9, 512) * Math.PI * 2
    const c = new THREE.Color(pick(CAMPSITE.vanColours, hash2(i, 11, 513)))
    vans.box(p.x, p.z, Math.cos(yaw), Math.sin(yaw), V.l, V.w, p.y + 0.3, p.y + V.h, c, 0)
    vans.box(p.x, p.z, Math.cos(yaw), Math.sin(yaw), V.l * 0.55, V.w * 0.8, p.y + V.h, p.y + V.h + 0.4, new THREE.Color('#c9ccd0'), 0)
  })
  const vanGeo = vans.geometry()
  if (vanGeo) {
    vanGeo.deleteAttribute('aLayer')
    const mesh = new THREE.Mesh(vanGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.6, metalness: 0.2 }))
    mesh.name = 'campVans'
    mesh.castShadow = q.farField.shadows
    root.add(mesh)
    farField.register({ kind: 'buildings', name: 'campVans', levels: [{ object: mesh, range }] })
  }
  ctx.keepOutPolys.push({ ring, box })
  stats.motopia.tents = tents
  stats.motopia.vans = chosen.length
  root.userData.campsite = { pitches: pitches.length, tents, vans: chosen.length }
  return root.children.length || tents ? root : null
}

// ---------------------------------------------------------------------------------------------

/**
 * Queue the buildings' deferred jobs (see the module comment): one 'buildings' job per 250 m
 * cell holding footprints (plus 500 m pseudo-cells beyond the grid), then Motopia and the
 * campsite. Materials are made lazily inside the first job that needs them (the registry's
 * attach runs `setupMaterials` on every job root). Returns the plan's counts for the offline
 * harness; each job root carries `userData.buildings` with what it massed.
 */
export function buildBuildings(ctx: EnvBuildContext): BuildingsStats {
  const { farField, quality: q, keepOut, keepOutPolys } = ctx
  const grid: GridShape = ctx.terrain.grid()
  const stats: BuildingsStats = { planned: 0, byKind: {}, skipped: { owned: 0, paddock: 0, verge: 0, small: 0, degenerate: 0 }, cells: 0, jobs: 0, motopia: { coasterWays: 0, pools: 0, tents: 0, vans: 0 }, heroes: { picked: 0, byModel: {} } }
  const planned = planBuildings(ctx, stats)
  const castShadow = q.farField.shadows
  const detailM = q.farField.buildingsDetailM
  // the hero fits are decided now (synchronously: the road network for the fronts is the one
  // roads.ts already built), so the cell jobs know which footprints only get a plinth
  const heroes = pickHeroes(planned, ctx)
  for (const p of planned) {
    const h = heroes.get(p.b.id)
    if (!h) continue
    p.hero = h
    stats.heroes.picked++
    stats.heroes.byModel[h.model] = (stats.heroes.byModel[h.model] ?? 0) + 1
  }
  // the detail level's dressing reads the road network for its road-facing rules; fetched lazily
  // inside the first job that needs it (memoised per context by road-section.ts)
  let net: RoadNet | null | undefined
  const roadNet = (): RoadNet | null => {
    if (net === undefined) {
      try {
        net = roadNetwork(ctx, { stepScale: q.farField.roads.stepScale, ring: q.farField.roads.ring })
      } catch (err) {
        console.warn(`[buildings] road network unavailable for the dressing: ${err instanceof Error ? err.message : String(err)}`)
        net = null
      }
    }
    return net
  }

  // --- the materials, once, inside the first job -----------------------------------------------
  let facadeMats: THREE.Material[] | null = null
  const materials = (): THREE.Material[] => {
    if (facadeMats) return facadeMats
    const atlas = facadeAtlas(ctx.assets)
    if (atlas.array) facadeMats = [facadeMaterial(atlas)]
    else facadeMats = atlas.plain.map((map) => new THREE.MeshStandardMaterial({ color: 0xffffff, map, vertexColors: true, roughness: 0.86, metalness: 0.03 }))
    if (import.meta.dev) console.info(`[buildings] facade atlas: ${FACADE_LAYERS} layers, ${atlas.photo} from the pack's scans${atlas.normal ? ', normal array' : ''}`)
    return facadeMats
  }
  /** an Acc as meshes: one (array texture) or up to four (fallback) */
  const meshesOf = (acc: Acc, name: string, receive: boolean): THREE.Mesh[] => {
    const mats = materials()
    const out: THREE.Mesh[] = []
    if (mats.length === 1) {
      const g = acc.geometry()
      if (!g) return out
      const m = new THREE.Mesh(g, mats[0]!)
      m.name = name
      out.push(m)
    } else {
      acc.splitBySlot().forEach((g, slot) => {
        if (!g) return
        const m = new THREE.Mesh(g, mats[slot]!)
        m.name = `${name}-m${slot}`
        out.push(m)
      })
    }
    for (const m of out) {
      m.castShadow = castShadow
      m.receiveShadow = receive && castShadow
    }
    return out
  }

  // --- the cells ---------------------------------------------------------------------------------
  const byKey = new Map<string, Planned[]>()
  for (const p of planned) {
    let list = byKey.get(p.key)
    if (!list) byKey.set(p.key, (list = []))
    list.push(p)
  }
  stats.cells = byKey.size
  for (const [key, here] of byKey) {
    const cell = here[0]!.cell
    stats.jobs++
    farField.defer('buildings', `buildings-${key}`, 4 + here.length * 0.3, () => {
      const mass = new Acc()
      const detail = detailM > 0 ? new Acc() : null
      const root = new THREE.Group()
      root.name = `buildings-${key}`
      const massed: Massed[] = []
      const extra: THREE.Mesh[] = []
      const fascia = (p: Planned, slabTop: number) => {
        if (p.b.id !== MAIN_GATE_WAY) return
        extra.push(fasciaBoard(ctx, p, slabTop))
      }
      const dress: Dress | null = detail ? { net: roadNet(), cell: here } : null
      const counts = { heroes: 0, arches: 0, sheds: 0, pv: 0, wallSegments: 0, walls: 0, gates: 0, props: 0, shutters: 0 }
      for (const p of here) {
        const m = massBuilding(ctx, p, mass, detail, fascia, dress)
        massed.push(m)
        if (m.hero) counts.heroes++
        if (m.arch) counts.arches++
        if (m.shed) counts.sheds++
        if (m.pv) counts.pv++
        if (m.wall) { counts.walls++; counts.wallSegments += m.wall }
        if (m.gate) counts.gates++
        if (m.props) counts.props++
        if (m.shutters) counts.shutters += m.shutters
        keepOut.push({ x: p.cx, z: p.cz, r: p.rMax + BUILDING.keepOutMargin })
        keepOutPolys.push({ ring: p.ring, box: p.box })
      }
      const massMeshes = meshesOf(mass, `buildings-${key}`, true)
      if (!massMeshes.length) return null
      const massGroup = new THREE.Group()
      massGroup.name = `buildingsMass-${key}`
      massGroup.add(...massMeshes, ...extra)
      root.add(massGroup)
      farField.register({ kind: 'buildings', name: `buildings-${key}`, cell, levels: [{ object: massGroup, range: Infinity, static: true }] })
      if (detail) {
        const detailMeshes = meshesOf(detail, `buildingsDetail-${key}`, false)
        if (detailMeshes.length) {
          const dg = new THREE.Group()
          dg.name = `buildingsDetail-${key}`
          dg.add(...detailMeshes)
          root.add(dg)
          farField.register({ kind: 'buildings', name: `buildingsDetail-${key}`, cell, levels: [{ object: dg, range: detailM }] })
        }
      }
      root.userData.buildings = { massed, triangles: mass.triangles, detailTriangles: detail ? detail.triangles : 0, ...counts }
      return root
    })
  }

  // --- the hero houses: one InstancedMesh per pack model over the whole map (after the cells: FIFO within the stage)
  if (stats.heroes.picked) {
    stats.jobs++
    farField.defer('buildings', 'heroBuildings', 8, () => buildHeroes(ctx, heroes.values()))
  }

  // --- Motopia: the coaster and the pools --------------------------------------------------------
  stats.jobs++
  farField.defer('buildings', 'motopia', 12, () => {
    const acc = new Acc()
    const keep: { x: number; z: number; r: number }[] = []
    const coaster = buildCoaster(ctx, acc, keep)
    const pools = buildPools(ctx, grid, acc)
    for (const k of keep) keepOut.push(k)
    const geo = acc.geometry()
    if (!geo) return null
    geo.deleteAttribute('aLayer')
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.6, metalness: 0.25 }))
    mesh.name = 'motopia'
    mesh.castShadow = castShadow
    mesh.receiveShadow = castShadow
    const root = new THREE.Group()
    root.name = 'motopia'
    root.add(mesh)
    farField.register({ kind: 'structure', name: 'motopia', levels: [{ object: mesh, range: Infinity }] })
    root.userData.motopia = { ...coaster, ...pools, triangles: acc.triangles }
    return root
  })

  // --- the campsite ------------------------------------------------------------------------------
  stats.jobs++
  farField.defer('buildings', 'campsite', 6, () => buildCampsite(ctx, planned, stats))

  stats.motopia.coasterWays = SUR_SITES.filter((s) => s.role === 'coaster').length
  stats.motopia.pools = SUR_SITES.filter((s) => s.role === 'pool').length
  if (import.meta.dev) console.info(`[buildings] ${stats.planned} footprints planned in ${stats.cells} cells (skipped: ${JSON.stringify(stats.skipped)}), ${stats.heroes.picked} hero fits ${JSON.stringify(stats.heroes.byModel)}`)
  return stats
}

/** the main gate's fascia board on its road-facing edge (the long edge farthest from the circuit), hung from the slab's front */
function fasciaBoard(ctx: EnvBuildContext, p: Planned, slabTop: number): THREE.Mesh {
  const { ground } = ctx
  const ring = p.ring
  const n = ring.length
  let longest = 0
  for (let i = 0; i < n; i++) longest = Math.max(longest, Math.hypot(ring[(i + 1) % n]![0] - ring[i]![0], ring[(i + 1) % n]![1] - ring[i]![1]))
  let best = 0, bestD = -Infinity
  for (let i = 0; i < n; i++) {
    const a = ring[i]!, b = ring[(i + 1) % n]!
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (len < longest * 0.6) continue
    const d = ground.plan.project((a[0] + b[0]) / 2, (a[1] + b[1]) / 2).d
    if (d > bestD) { bestD = d; best = i }
  }
  const a = ring[best]!, b = ring[(best + 1) % n]!
  const nn = edgeNormals(ring)[best]!
  const len = Math.hypot(b[0] - a[0], b[1] - a[1])
  const h = BUILDING.canopy.fascia.h
  const geo = new THREE.PlaneGeometry(len * 0.92, h)
  const mat = new THREE.MeshStandardMaterial({ map: fasciaTexture(), roughness: 0.55, metalness: 0.05 })
  const mesh = new THREE.Mesh(geo, mat)
  const mx = (a[0] + b[0]) / 2 + nn[0] * 0.12, mz = (a[1] + b[1]) / 2 + nn[1] * 0.12
  mesh.position.set(mx, slabTop - h / 2 + 0.02, mz)
  mesh.rotation.y = Math.atan2(nn[0], nn[1])
  mesh.name = 'buildingsFascia'
  mesh.castShadow = false
  return mesh
}
