import * as THREE from 'three'
import { worldRing } from '~/data/en-codec'
import type { SurFeatureBase, SurPolygon } from '~/data/en-codec'
import { SUR_BARE, SUR_BUILDINGS, SUR_FARMLAND, SUR_FOREST, SUR_GRASS, SUR_PARKING, SUR_RAIL, SUR_ROADS, SUR_SCRUB, SUR_SITES, SUR_SOLAR, SUR_STREAMS, SUR_WATER } from '~/data/suzuka-surroundings'
import type { Track } from '~/sim/track'
import type { AssetRegistry } from './assets'
import type { Quality } from './quality'
import { cached, groundAniso, mulberry, scaled } from './textures'

/**
 * The land-cover mask (plan §1e): what the ground OUTSIDE the fences is — forest, paddies,
 * roads, car parks, water, solar farms, settlements — drawn as a splat over the grass shader
 * instead of as geometry, so the ground partition (README R1–R14) and the census never change.
 *
 * Two RGBA8 pairs are rasterised on the CPU at start-up from the OSM layers of
 * suzuka-surroundings.ts, one pair for the inner terrain rectangle (3.3 m texels on the high
 * tier) and one for the outer ring (coarser, it also covers the inner area so the shader only
 * has to pick):
 *
 *   a = (forest, farmland, paved, parking)      b = (water, solar, settle, edge)
 *
 * Polygon classes are filled by an even-odd scanline in precedence order (a later class
 * overwrites: forest < farmland < grass (clears) < scrub (forest ½) < bare (settle ½) < settle <
 * solar < parking < water), then box-blurred by 5 taps so a class edge is a two-texel ramp
 * rather than a stair. `settle` has no polygon of its own: it is the 60 m box-blurred density of
 * the residential / service roads plus a disc per building (r = 1.7·√area, 10–40 m), which is
 * what reads as a village from above (grey roofs and yards between the paddies). Roads, streams
 * and the railway are capsule-distance strips in the SUR widths, drawn with COVERAGE instead of
 * the blur: a texel's value is the fraction of it the strip covers (its signed depth over the
 * texel size), max-blended so a road over a road keeps the max — a 3 m track on 3.3 m texels is
 * a soft two-texel band, not a dotted row. Inside the inner rectangle the roads are narrowed by
 * RIBBON_INSET: roads.ts draws every road there as a ribbon mesh with its own markings, and the
 * mask only has to hide the grass under the ribbon's anti-aliased edge (on the outer ring it
 * stays the whole road; under the ribbons it is the far LOD). The paddies carry their bunds in
 * the `edge` channel at half value — 30 × 90 m cells rotated to each polygon's principal axis
 * (the 圃場整備 grid of the Suzuka plain) plus the field boundary — so the shader needs no
 * per-polygon data and no third mask. Last, a disc of hw + 30 m around every centreline sample
 * is cleared so no class ever reaches the verge: the partition's faces own everything inside
 * G5's reach.
 *
 * No canvas: the masks are DataTextures, so the Node harness (scripts/audit/app-runtime.mjs)
 * and the low tier build exactly the same bytes; `classAt` / `weightAt` read those bytes back for
 * the far-field builders (forest placement, car parks). Mipmaps + the ground anisotropy budget:
 * from the overview a texel is sub-pixel and the mask would shimmer without them.
 *
 * Contract (README R3): this module reads the Track and the OSM tables only — it never samples
 * the terrain.
 */

export type CoverClass = 'none' | 'forest' | 'farmland' | 'paved' | 'parking' | 'water' | 'solar' | 'settle' | 'edge'

/** The eight channels in texture order: a.rgba then b.rgba. */
const CHANNELS: readonly Exclude<CoverClass, 'none'>[] = ['forest', 'farmland', 'paved', 'parking', 'water', 'solar', 'settle', 'edge']
const CH = { forest: 0, farmland: 1, paved: 2, parking: 3, water: 4, solar: 5, settle: 6, edge: 7 } as const

/** `classAt` precedence, highest first: a road texel is a road whatever polygon lies under it. */
const PRECEDENCE: readonly Exclude<CoverClass, 'none' | 'edge'>[] = ['paved', 'water', 'parking', 'solar', 'settle', 'farmland', 'forest']

export interface CoverRect {
  x0: number
  z0: number
  w: number
  d: number
}

export interface CoverTextures {
  /** forest, farmland, paved, parking */
  a: THREE.DataTexture
  /** water, solar, settle, edge */
  b: THREE.DataTexture
  /** world xz of texel (0, 0)'s corner */
  origin: THREE.Vector2
  /** 1 / (w, d): uv = (xz − origin) · invSize */
  invSize: THREE.Vector2
  /** texels per side */
  res: number
}

/**
 * What one grass material binds (materials.ts addGrassSurface `cover`): ONE mask pair — the
 * inner rectangle's for the terrain chunks and the partition's grass faces, the outer ring's for
 * the ring meshes — so a program carries 2 mask samplers, not 4, and the high tier stays at 14
 * of 16 units. The two materials share the program (same key); only the uniforms differ.
 */
export interface CoverLayer {
  masks: CoverTextures
  /** sample the detail tile (Quality.coverDetail); false = flat class colours under the macro variation */
  detail: boolean
  /** the detail tile the material binds (`coverDetailTile`, built once per land cover with the asset pack it was given); null when `detail` is off */
  detailTile: THREE.DataTexture | null
}

export interface CoverStats {
  buildMs: number
  /** per class, % of the inner texture's texels with weight ≥ ½ */
  innerPct: Record<Exclude<CoverClass, 'none'>, number>
  /** per class, % of the outer texture's texels with weight ≥ ½ */
  outerPct: Record<Exclude<CoverClass, 'none'>, number>
}

export interface LandCover {
  inner: CoverTextures
  outer: CoverTextures
  /** Quality.coverDetail */
  detail: boolean
  /** the layer a material binds: `'inner'` for the terrain chunks and the ground faces, `'outer'` for the ring */
  layer(which: 'inner' | 'outer'): CoverLayer
  /** the highest-precedence class whose weight is ≥ ½ at world (x, z); 'none' beyond both rectangles or where nothing is drawn */
  classAt(x: number, z: number): CoverClass
  /** weight 0–1 of one class at world (x, z) (nearest texel; the inner texture where it applies) */
  weightAt(x: number, z: number, cls: Exclude<CoverClass, 'none'>): number
  stats: CoverStats
  /** free the GPU copies (the bytes stay in the texture cache so a context restore re-uploads them) */
  dispose(): void
}

// ---------------------------------------------------------------- colours (sRGB, late March)
/**
 * Class colours the shader mixes with (sRGB hex, converted to linear on the uniform). Late
 * March: the paddies are dry stubble before flooding, the forest floor is last autumn's litter
 * under evergreen shade, the solar panels are near-black glass in aluminium frames.
 */
export const COVER_COLOURS = {
  forest: '#3d3a2c',
  farmland: '#9a8a66',
  bund: '#7a7359',
  paved: '#5d626c',
  parking: '#55585e',
  solar: '#1e2a4a',
  water: '#33443f',
  settle: '#8e8a80',
} as const

/**
 * World period (m) of each detail-tile channel: R forest litter, G paddy mud / stubble, B asphalt
 * grain, A solar rows. Farmland is 3 m — the physical tile of the dry-mud scan the G channel
 * carries with the pack (the painted furrows repeat at the same period without it).
 */
export const COVER_DETAIL_M = { forest: 4, farmland: 3, paved: 1.5, solar: 5.5 } as const

// ---------------------------------------------------------------- tunables
/** clearance around every centreline sample beyond the local half-width (m): G5's reach is 34 m */
const CLEAR_MARGIN = 30
/** box-blur radius of the residential / service road raster that becomes `settle` (m) */
const SETTLE_BLUR_M = 60
/** the road density (fraction of the 120 m box that is road) at which settle reaches 0 / 1 */
const SETTLE_DENSITY = [0.05, 0.22] as const
/** building disc radius = clamp(1.7·√area, min, max) */
const DISC_K = 1.7, DISC_MIN = 10, DISC_MAX = 40
/** paddy cell (m) along the polygon's principal axis × across it */
const PADDY_CELL = [90, 30] as const
/** the bunds are one texel wide: only worth drawing where a texel is at most this (m) */
const LINE_MAX_TEXEL = 5
/**
 * How far (m) the mask's roads stop short of the paved edge under the ribbons roads.ts draws over
 * the inner rectangle: `max(min, perTexel · texel)`. The ribbon is the road; the mask beneath only
 * hides the grass under the ribbon's anti-aliased edge, so it must never show a stair-step or a
 * coverage ramp beyond that edge (the road would look wider than its markings). The outer ring
 * stays mask-only (inset 0) until the ring ribbons exist (`q.farField.roads.ring`, high tier).
 */
const RIBBON_INSET = { min: 0.8, perTexel: 0.35 } as const
/** a road narrowed by the inset is never thinner than this half-width (m): the far LOD keeps a trace of every lane */
const RIBBON_MIN_HW = 0.3
/** the railway is a dark strip: ballast, not asphalt */
const RAIL_PAVED = 0.7
/** weight of scrub as forest / bare land as settle */
const HALF = 0.5

// ---------------------------------------------------------------- raster

/** One square raster of the eight channels plus the scratch the fill needs. */
class CoverRaster {
  readonly res: number
  readonly sx: number
  readonly sz: number
  /** eight planes, res² each, 0–255 */
  readonly ch: Uint8Array[]
  /** residential / service road raster for the settle density */
  private readonly resRoads: Uint8Array
  /** bunds (paddy cell edges and field boundaries), composed into `edge` last */
  private readonly bund: Uint8Array
  /** class id per texel during the polygon pass (index into POLY_CLASSES + 1) and its weight */
  private readonly cls: Uint8Array
  private readonly wt: Uint8Array
  readonly lines: boolean

  constructor(readonly rect: CoverRect, res: number) {
    this.res = res
    this.sx = rect.w / res
    this.sz = rect.d / res
    const n = res * res
    this.ch = CHANNELS.map(() => new Uint8Array(n))
    this.resRoads = new Uint8Array(n)
    this.bund = new Uint8Array(n)
    this.cls = new Uint8Array(n)
    this.wt = new Uint8Array(n)
    this.lines = Math.max(this.sx, this.sz) <= LINE_MAX_TEXEL
  }

  /** texel column / row of a world coordinate (unclamped, fractional) */
  colOf(x: number): number {
    return (x - this.rect.x0) / this.sx - 0.5
  }

  rowOf(z: number): number {
    return (z - this.rect.z0) / this.sz - 0.5
  }

  /**
   * Even-odd scanline fill of a world-space ring ([x, z, x, z, …]) into the class map. `edgeMark`
   * marks the first and last texel of every span (the field boundary) in the bund plane, and
   * `cell`, when given, marks the texels on the rotated cell grid too.
   */
  fillPolygon(ring: Float64Array, id: number, weight: number, paddy: { cx: number; cz: number; cos: number; sin: number } | null) {
    const res = this.res
    const nv = ring.length / 2
    let zMin = Infinity, zMax = -Infinity
    for (let i = 0; i < nv; i++) {
      const z = ring[i * 2 + 1]!
      if (z < zMin) zMin = z
      if (z > zMax) zMax = z
    }
    const j0 = Math.max(0, Math.ceil(this.rowOf(zMin)))
    const j1 = Math.min(res - 1, Math.floor(this.rowOf(zMax)))
    if (j1 < j0) return
    const xs: number[] = []
    const w8 = Math.round(weight * 255)
    const halfTexel = Math.max(this.sx, this.sz) * 0.5
    for (let j = j0; j <= j1; j++) {
      const z = this.rect.z0 + (j + 0.5) * this.sz
      xs.length = 0
      for (let i = 0; i < nv; i++) {
        const k = (i + 1) % nv
        const az = ring[i * 2 + 1]!, bz = ring[k * 2 + 1]!
        // half-open rule so a vertex exactly on the scanline counts once
        if ((az <= z) === (bz <= z)) continue
        const ax = ring[i * 2]!, bx = ring[k * 2]!
        xs.push(ax + ((z - az) / (bz - az)) * (bx - ax))
      }
      if (xs.length < 2) continue
      xs.sort((p, q) => p - q)
      for (let p = 0; p + 1 < xs.length; p += 2) {
        const i0 = Math.max(0, Math.ceil(this.colOf(xs[p]!)))
        const i1 = Math.min(res - 1, Math.floor(this.colOf(xs[p + 1]!)))
        if (i1 < i0) continue
        const row = j * res
        for (let i = i0; i <= i1; i++) {
          this.cls[row + i] = id
          this.wt[row + i] = w8
        }
        if (paddy && this.lines) {
          // the field boundary is a bund, and so is every line of the 30 × 90 m cell grid
          this.bund[row + i0] = 128
          this.bund[row + i1] = 128
          for (let i = i0; i <= i1; i++) {
            const x = this.rect.x0 + (i + 0.5) * this.sx
            const dx = x - paddy.cx, dz = z - paddy.cz
            const u = paddy.cos * dx + paddy.sin * dz
            const v = -paddy.sin * dx + paddy.cos * dz
            const fu = Math.abs(u - Math.round(u / PADDY_CELL[0]) * PADDY_CELL[0])
            const fv = Math.abs(v - Math.round(v / PADDY_CELL[1]) * PADDY_CELL[1])
            if (fu <= halfTexel || fv <= halfTexel) this.bund[row + i] = 128
          }
        }
      }
    }
  }

  /** Expand the class map into the polygon channels (forest, farmland, parking, water, solar; settle from `bare`). */
  expandClasses(classChannel: readonly number[]) {
    const n = this.res * this.res
    for (let t = 0; t < n; t++) {
      const id = this.cls[t]!
      if (id === 0) continue
      const c = classChannel[id]!
      if (c >= 0) this.ch[c]![t] = this.wt[t]!
    }
  }

  /**
   * Capsule-distance strip of a polyline (world xz interleaved) into the paved / water channel or
   * the settle density raster. A texel's value is `value` × its COVERAGE, ½ + depth / texel with
   * depth the capsule's signed inset at the texel centre (0 at the edge), clamped to 0–1: the
   * edge becomes a one-texel ramp centred on the true edge instead of a stair, and a road much
   * narrower than a texel is a faint band rather than a dotted row. Max-blended, so a road over a
   * road keeps the deeper one. The density raster stays binary: it is box-blurred over 60 m
   * anyway, and a change there would move the settle threshold under every builder reading it.
   */
  strip(pts: Float64Array, halfWidth: number, target: 'road' | 'resRoads' | 'water', value = 255) {
    const res = this.res
    const texel = Math.max(this.sx, this.sz)
    const reach = halfWidth + texel
    // a stream narrower than a texel would fade to nothing on the ring: draw at least one texel's width
    const hw = target === 'water' ? Math.max(halfWidth, texel * 0.5) : halfWidth
    for (let s = 0; s + 3 < pts.length; s += 2) {
      const ax = pts[s]!, az = pts[s + 1]!, bx = pts[s + 2]!, bz = pts[s + 3]!
      const i0 = Math.max(0, Math.ceil(this.colOf(Math.min(ax, bx) - reach)))
      const i1 = Math.min(res - 1, Math.floor(this.colOf(Math.max(ax, bx) + reach)))
      const j0 = Math.max(0, Math.ceil(this.rowOf(Math.min(az, bz) - reach)))
      const j1 = Math.min(res - 1, Math.floor(this.rowOf(Math.max(az, bz) + reach)))
      if (i1 < i0 || j1 < j0) continue
      const vx = bx - ax, vz = bz - az
      const len2 = vx * vx + vz * vz
      for (let j = j0; j <= j1; j++) {
        const z = this.rect.z0 + (j + 0.5) * this.sz
        for (let i = i0; i <= i1; i++) {
          const x = this.rect.x0 + (i + 0.5) * this.sx
          let t = len2 > 0 ? ((x - ax) * vx + (z - az) * vz) / len2 : 0
          t = t < 0 ? 0 : t > 1 ? 1 : t
          const dx = x - (ax + vx * t), dz = z - (az + vz * t)
          const depth = hw - Math.sqrt(dx * dx + dz * dz)
          const k = j * res + i
          if (target === 'resRoads') {
            if (depth >= 0) this.resRoads[k] = 255
            continue
          }
          const cov = 0.5 + depth / texel
          if (cov <= 0) continue
          const v = cov >= 1 ? value : Math.round(value * cov)
          const plane = this.ch[target === 'water' ? CH.water : CH.paved]!
          if (plane[k]! < v) plane[k] = v
        }
      }
    }
  }

  /** The edge channel: the paddy bunds (nothing else draws into it). */
  composeEdges() {
    const n = this.res * this.res
    const edge = this.ch[CH.edge]!
    for (let t = 0; t < n; t++) if (this.bund[t]! > edge[t]!) edge[t] = this.bund[t]!
  }

  /** Building discs (soft-edged, r = 1.7·√area clamped) into the settle plane. */
  disc(x: number, z: number, r: number, plane: Uint8Array, value = 255) {
    const res = this.res
    const i0 = Math.max(0, Math.ceil(this.colOf(x - r)))
    const i1 = Math.min(res - 1, Math.floor(this.colOf(x + r)))
    const j0 = Math.max(0, Math.ceil(this.rowOf(z - r)))
    const j1 = Math.min(res - 1, Math.floor(this.rowOf(z + r)))
    const r2 = r * r
    const inner = 0.7 * r
    for (let j = j0; j <= j1; j++) {
      const dz = this.rect.z0 + (j + 0.5) * this.sz - z
      for (let i = i0; i <= i1; i++) {
        const dx = this.rect.x0 + (i + 0.5) * this.sx - x
        const d2 = dx * dx + dz * dz
        if (d2 > r2) continue
        const d = Math.sqrt(d2)
        const w = d <= inner ? 1 : (r - d) / (r - inner)
        const v = Math.round(value * w)
        const k = j * res + i
        if (plane[k]! < v) plane[k] = v
      }
    }
  }

  /** Zero every channel inside a disc (the centreline clearance). */
  clearDisc(x: number, z: number, r: number) {
    const res = this.res
    const i0 = Math.max(0, Math.ceil(this.colOf(x - r)))
    const i1 = Math.min(res - 1, Math.floor(this.colOf(x + r)))
    const j0 = Math.max(0, Math.ceil(this.rowOf(z - r)))
    const j1 = Math.min(res - 1, Math.floor(this.rowOf(z + r)))
    const r2 = r * r
    for (let j = j0; j <= j1; j++) {
      const dz = this.rect.z0 + (j + 0.5) * this.sz - z
      for (let i = i0; i <= i1; i++) {
        const dx = this.rect.x0 + (i + 0.5) * this.sx - x
        if (dx * dx + dz * dz > r2) continue
        const k = j * res + i
        for (const p of this.ch) p[k] = 0
      }
    }
  }

  /** Separable box blur of one plane, radius `r` texels (running sums, O(n)). */
  static boxBlur(src: Uint8Array, res: number, r: number, out: Uint8Array, tmp: Float32Array) {
    const win = 2 * r + 1
    // rows
    for (let j = 0; j < res; j++) {
      const row = j * res
      let sum = 0
      for (let i = -r; i <= r; i++) sum += src[row + Math.min(res - 1, Math.max(0, i))]!
      for (let i = 0; i < res; i++) {
        tmp[row + i] = sum / win
        const add = Math.min(res - 1, i + r + 1), sub = Math.max(0, i - r)
        sum += src[row + add]! - src[row + sub]!
      }
    }
    // columns
    for (let i = 0; i < res; i++) {
      let sum = 0
      for (let j = -r; j <= r; j++) sum += tmp[Math.min(res - 1, Math.max(0, j)) * res + i]!
      for (let j = 0; j < res; j++) {
        out[j * res + i] = Math.round(sum / win)
        const add = Math.min(res - 1, j + r + 1), sub = Math.max(0, j - r)
        sum += tmp[add * res + i]! - tmp[sub * res + i]!
      }
    }
  }

  /** The settle plane: smoothstep of the 60 m road density, unioned with the building discs already in it. */
  composeSettle(tmp: Float32Array, scratch: Uint8Array) {
    const r = Math.max(1, Math.round(SETTLE_BLUR_M / Math.max(this.sx, this.sz)))
    CoverRaster.boxBlur(this.resRoads, this.res, r, scratch, tmp)
    const settle = this.ch[CH.settle]!
    const [lo, hi] = SETTLE_DENSITY
    const n = this.res * this.res
    for (let t = 0; t < n; t++) {
      let d = (scratch[t]! / 255 - lo) / (hi - lo)
      d = d < 0 ? 0 : d > 1 ? 1 : d
      d = d * d * (3 - 2 * d)
      // union with the discs: 1 − (1 − a)(1 − b)
      const a = settle[t]! / 255
      settle[t] = Math.round(255 * (1 - (1 - a) * (1 - d)))
    }
  }

  /** Interleave the planes into the two RGBA byte arrays. */
  pack(): { a: Uint8Array; b: Uint8Array } {
    const n = this.res * this.res
    const a = new Uint8Array(n * 4), b = new Uint8Array(n * 4)
    const [f, fa, pv, pk, wa, so, se, ed] = this.ch as [Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array]
    for (let t = 0, q = 0; t < n; t++, q += 4) {
      a[q] = f[t]!
      a[q + 1] = fa[t]!
      a[q + 2] = pv[t]!
      a[q + 3] = pk[t]!
      b[q] = wa[t]!
      b[q + 1] = so[t]!
      b[q + 2] = se[t]!
      b[q + 3] = ed[t]!
    }
    return { a, b }
  }
}

// ---------------------------------------------------------------- geometry helpers

/** Principal axis of a polygon from its second moments of area (shoelace), for the paddy cell grid. */
function principalAxis(ring: Float64Array): { cx: number; cz: number; cos: number; sin: number } {
  const n = ring.length / 2
  let a2 = 0, cx = 0, cz = 0
  for (let i = 0; i < n; i++) {
    const k = (i + 1) % n
    const x0 = ring[i * 2]!, z0 = ring[i * 2 + 1]!, x1 = ring[k * 2]!, z1 = ring[k * 2 + 1]!
    const c = x0 * z1 - x1 * z0
    a2 += c
    cx += (x0 + x1) * c
    cz += (z0 + z1) * c
  }
  if (Math.abs(a2) < 1e-6) {
    // degenerate: fall back to the vertex mean, axis east–west
    let mx = 0, mz = 0
    for (let i = 0; i < n; i++) {
      mx += ring[i * 2]!
      mz += ring[i * 2 + 1]!
    }
    return { cx: mx / n, cz: mz / n, cos: 1, sin: 0 }
  }
  cx /= 3 * a2
  cz /= 3 * a2
  let ixx = 0, izz = 0, ixz = 0
  for (let i = 0; i < n; i++) {
    const k = (i + 1) % n
    const x0 = ring[i * 2]! - cx, z0 = ring[i * 2 + 1]! - cz, x1 = ring[k * 2]! - cx, z1 = ring[k * 2 + 1]! - cz
    const c = x0 * z1 - x1 * z0
    ixx += (x0 * x0 + x0 * x1 + x1 * x1) * c
    izz += (z0 * z0 + z0 * z1 + z1 * z1) * c
    ixz += (x0 * z1 + 2 * x0 * z0 + 2 * x1 * z1 + x1 * z0) * c
  }
  // the axis of greatest extent (the long side of the fields)
  const theta = 0.5 * Math.atan2(2 * ixz, ixx - izz)
  return { cx, cz, cos: Math.cos(theta), sin: Math.sin(theta) }
}

/** bbox test of a world ring against a raster's rectangle (with `pad` metres) */
function touches(ring: Float64Array, r: CoverRect, pad: number): boolean {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity
  for (let i = 0; i < ring.length; i += 2) {
    const x = ring[i]!, z = ring[i + 1]!
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (z < z0) z0 = z
    if (z > z1) z1 = z
  }
  return x1 >= r.x0 - pad && x0 <= r.x0 + r.w + pad && z1 >= r.z0 - pad && z0 <= r.z0 + r.d + pad
}

/** point-in-polygon (even-odd) on a world ring */
function inside(ring: Float64Array, x: number, z: number): boolean {
  let hit = false
  const n = ring.length / 2
  for (let i = 0, k = n - 1; i < n; k = i++) {
    const xi = ring[i * 2]!, zi = ring[i * 2 + 1]!, xk = ring[k * 2]!, zk = ring[k * 2 + 1]!
    if (zi > z !== zk > z && x < ((xk - xi) * (z - zi)) / (zk - zi) + xi) hit = !hit
  }
  return hit
}

// ---------------------------------------------------------------- the build

/** the polygon layers in precedence order (later overwrites); channel −1 = clears */
interface PolyLayer {
  polys: SurPolygon[]
  channel: number
  weight: number
  paddy?: boolean
}

function rasterise(track: Track, rect: CoverRect, res: number, decoded: DecodedData, ribbons: boolean): CoverRaster {
  const r = new CoverRaster(rect, res)
  const layers: PolyLayer[] = [
    { polys: SUR_FOREST, channel: CH.forest, weight: 1 },
    { polys: SUR_FARMLAND, channel: CH.farmland, weight: 1, paddy: true },
    { polys: SUR_GRASS, channel: -1, weight: 0 },
    { polys: SUR_SCRUB, channel: CH.forest, weight: HALF },
    { polys: SUR_BARE, channel: CH.settle, weight: HALF },
    { polys: SUR_SOLAR, channel: CH.solar, weight: 1 },
    { polys: SUR_PARKING, channel: CH.parking, weight: 1 },
    { polys: SUR_WATER, channel: CH.water, weight: 1 },
  ]
  // class id 0 = nothing; ids 1.. index the layers
  const classChannel = [-1, ...layers.map((l) => l.channel)]
  layers.forEach((layer, li) => {
    for (const p of layer.polys) {
      const ring = decoded.ring(p)
      if (!touches(ring, rect, 0)) continue
      const paddy = layer.paddy ? decoded.axis(p) : null
      r.fillPolygon(ring, li + 1, layer.weight, paddy)
    }
  })
  r.expandClasses(classChannel)

  // the settlements: residential / service road density (outside the circuit's own site: the
  // paddock roads are not a village) and the building discs
  for (const w of SUR_ROADS) {
    if (w.kind !== 'residential' && w.kind !== 'service') continue
    if (decoded.inCircuit(w)) continue
    const pts = decoded.ring(w)
    if (!touches(pts, rect, w.width)) continue
    r.strip(pts, w.width / 2 + 2, 'resRoads')
  }
  for (const b of SUR_BUILDINGS) {
    if (decoded.inCircuit(b)) continue
    const [x, z] = decoded.centre(b)
    const rad = Math.min(DISC_MAX, Math.max(DISC_MIN, DISC_K * Math.sqrt(b.area)))
    if (x + rad < rect.x0 || x - rad > rect.x0 + rect.w || z + rad < rect.z0 || z - rad > rect.z0 + rect.d) continue
    r.disc(x, z, rad, r.ch[CH.settle]!)
  }
  const n = res * res
  const tmp = new Float32Array(n)
  const scratch = new Uint8Array(n)
  r.composeSettle(tmp, scratch)

  // 5-tap box blur on the polygon channels only (the strips stay crisp)
  for (const c of [CH.forest, CH.farmland, CH.parking, CH.water, CH.solar, CH.settle]) {
    CoverRaster.boxBlur(r.ch[c]!, res, 2, scratch, tmp)
    r.ch[c]!.set(scratch)
  }

  // strips: streams into water, roads / rail into paved — the roads narrowed where ribbons cover them
  for (const w of SUR_STREAMS) {
    const pts = decoded.ring(w)
    if (!touches(pts, rect, w.width)) continue
    r.strip(pts, w.width / 2, 'water')
  }
  const inset = ribbons ? Math.max(RIBBON_INSET.min, RIBBON_INSET.perTexel * Math.max(r.sx, r.sz)) : 0
  for (const w of SUR_ROADS) {
    const pts = decoded.ring(w)
    if (!touches(pts, rect, w.width)) continue
    r.strip(pts, Math.max(w.width / 2 - inset, RIBBON_MIN_HW), 'road')
  }
  for (const w of SUR_RAIL) {
    const pts = decoded.ring(w)
    if (!touches(pts, rect, w.width)) continue
    r.strip(pts, w.width / 2, 'road', Math.round(RAIL_PAVED * 255))
  }
  r.composeEdges()

  // the clearance: nothing reaches the verge (after the blur, so no ramp leaks back in)
  for (let i = 0; i < track.n; i++) r.clearDisc(track.px[i]!, track.pz[i]!, track.hw[i]! + CLEAR_MARGIN)
  return r
}

/** The decoded rings, shared by the two rasters (decoding is the slow part of the data). */
interface DecodedData {
  ring(f: SurFeatureBase): Float64Array
  centre(f: SurFeatureBase): [number, number]
  axis(p: SurPolygon): { cx: number; cz: number; cos: number; sin: number }
  inCircuit(f: SurFeatureBase): boolean
}

function decodeAll(track: Track): DecodedData {
  const rings = new Map<SurFeatureBase, Float64Array>()
  const axes = new Map<SurPolygon, { cx: number; cz: number; cos: number; sin: number }>()
  const s = track.enScale
  const ring = (f: SurFeatureBase) => {
    let v = rings.get(f)
    if (!v) {
      v = worldRing(f, s)
      rings.set(f, v)
    }
    return v
  }
  const circuit = SUR_SITES.filter((site) => site.role === 'circuit' && site.closed).map((site) => ring(site))
  return {
    ring,
    centre: (f) => [f.centroid[0] * s, -f.centroid[1] * s],
    axis: (p) => {
      let a = axes.get(p)
      if (!a) {
        a = principalAxis(ring(p))
        axes.set(p, a)
      }
      return a
    },
    inCircuit: (f) => {
      const x = f.centroid[0] * s, z = -f.centroid[1] * s
      return circuit.some((c) => inside(c, x, z))
    },
  }
}

function makeTexture(data: Uint8Array, res: number, name: string): THREE.DataTexture {
  const t = new THREE.DataTexture(data, res, res, THREE.RGBAFormat, THREE.UnsignedByteType)
  t.name = name
  t.generateMipmaps = true
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.magFilter = THREE.LinearFilter
  t.wrapS = THREE.ClampToEdgeWrapping
  t.wrapT = THREE.ClampToEdgeWrapping
  t.anisotropy = groundAniso()
  t.colorSpace = THREE.NoColorSpace
  t.needsUpdate = true
  return t
}

function coverTextures(track: Track, rect: CoverRect, res: number, decoded: DecodedData, tag: string, pct: Record<string, number>): CoverTextures {
  const key = `cover-${tag}-${res}-${rect.x0.toFixed(1)},${rect.z0.toFixed(1)},${rect.w.toFixed(1)},${rect.d.toFixed(1)}`
  return cached(key, () => {
    // the ribbons (roads.ts) cover the inner rectangle only: its roads are narrowed under them
    const r = rasterise(track, rect, res, decoded, tag === 'inner')
    const n = res * res
    for (const c of CHANNELS) {
      let k = 0
      const plane = r.ch[CH[c]]!
      for (let t = 0; t < n; t++) if (plane[t]! >= 128) k++
      pct[c] = (100 * k) / n
    }
    const { a, b } = r.pack()
    return {
      a: makeTexture(a, res, `cover-${tag}-a`),
      b: makeTexture(b, res, `cover-${tag}-b`),
      origin: new THREE.Vector2(rect.x0, rect.z0),
      invSize: new THREE.Vector2(1 / rect.w, 1 / rect.d),
      res,
    }
  })
}

/**
 * Build the land-cover masks for the inner terrain rectangle and the outer ring rectangle (both
 * `{x0, z0, w, d}` in world metres, the ring rectangle containing the inner one). Resolution from
 * `q.coverRes`, the detail flag from `q.coverDetail`; `assets` (null on the low tier / in Node)
 * only feeds the detail tile's paddy channel. Cached per rectangle and resolution, so a second
 * build (HMR, a context restore) is free and the textures are covered by textures.ts's
 * markAllDirty / textureBytes.
 */
export function buildLandCover(track: Track, q: Quality, inner: CoverRect, outer: CoverRect, assets: AssetRegistry | null = null): LandCover {
  const t0 = performance.now()
  // the detail tile once per build: the pack's dry-mud scan goes into its G channel when the
  // registry has it (the materials bind the layer's tile rather than asking for one themselves)
  const detailTile = q.coverDetail ? coverDetailTile(assets) : null
  const decoded = decodeAll(track)
  const innerPct = {} as Record<Exclude<CoverClass, 'none'>, number>
  const outerPct = {} as Record<Exclude<CoverClass, 'none'>, number>
  const innerTex = coverTextures(track, inner, q.coverRes[0], decoded, 'inner', innerPct)
  const outerTex = coverTextures(track, outer, q.coverRes[1], decoded, 'outer', outerPct)
  // the cache may have served the textures without a fresh count: recount from the bytes
  for (const [tex, pct] of [[innerTex, innerPct], [outerTex, outerPct]] as const) {
    if (pct.forest !== undefined) continue
    const n = tex.res * tex.res
    const da = tex.a.image.data as Uint8Array, db = tex.b.image.data as Uint8Array
    CHANNELS.forEach((c, ci) => {
      const src = ci < 4 ? da : db
      const off = ci & 3
      let k = 0
      for (let t = 0; t < n; t++) if (src[t * 4 + off]! >= 128) k++
      pct[c] = (100 * k) / n
    })
  }

  const sample = (x: number, z: number, ci: number): number => {
    const pick = (tex: CoverTextures): number => {
      const u = (x - tex.origin.x) * tex.invSize.x, v = (z - tex.origin.y) * tex.invSize.y
      if (u < 0 || u >= 1 || v < 0 || v >= 1) return -1
      const i = Math.min(tex.res - 1, Math.floor(u * tex.res)), j = Math.min(tex.res - 1, Math.floor(v * tex.res))
      const src = (ci < 4 ? tex.a : tex.b).image.data as Uint8Array
      return src[(j * tex.res + i) * 4 + (ci & 3)]! / 255
    }
    const w = pick(innerTex)
    return w >= 0 ? w : Math.max(0, pick(outerTex))
  }

  const cover: LandCover = {
    inner: innerTex,
    outer: outerTex,
    detail: q.coverDetail,
    layer: (which) => ({ masks: which === 'inner' ? innerTex : outerTex, detail: q.coverDetail, detailTile }),
    classAt(x, z) {
      for (const c of PRECEDENCE) if (sample(x, z, CH[c]) >= 0.5) return c
      return 'none'
    },
    weightAt(x, z, cls) {
      return sample(x, z, CH[cls])
    },
    stats: { buildMs: performance.now() - t0, innerPct, outerPct },
    dispose() {
      innerTex.a.dispose()
      innerTex.b.dispose()
      outerTex.a.dispose()
      outerTex.b.dispose()
    },
  }
  return cover
}

// ---------------------------------------------------------------- the detail tile

/** Tileable value noise on a power-of-two lattice (the textures.ts Noise2 is private to it). */
function tileNoise(seed: number) {
  const rng = mulberry(seed)
  const lat = new Float32Array(256 * 256)
  for (let i = 0; i < lat.length; i++) lat[i] = rng()
  const value = (x: number, y: number, period: number): number => {
    const xi = Math.floor(x), yi = Math.floor(y)
    let fx = x - xi, fy = y - yi
    fx = fx * fx * (3 - 2 * fx)
    fy = fy * fy * (3 - 2 * fy)
    const x0 = ((xi % period) + period) % period, y0 = ((yi % period) + period) % period
    const x1 = (x0 + 1) % period, y1 = (y0 + 1) % period
    const l = (a: number, b: number) => lat[((b & 255) << 8) | (a & 255)]!
    const ab = l(x0, y0) + (l(x1, y0) - l(x0, y0)) * fx
    const cd = l(x0, y1) + (l(x1, y1) - l(x0, y1)) * fx
    return ab + (cd - ab) * fy
  }
  /** fractal sum, 0..1, tileable over `period` lattice cells at the base octave */
  return (u: number, v: number, period: number, octaves: number, gain = 0.5): number => {
    let sum = 0, amp = 1, norm = 0, f = 1
    for (let o = 0; o < octaves; o++) {
      sum += value(u * period * f, v * period * f, period * f) * amp
      norm += amp
      amp *= gain
      f *= 2
    }
    return sum / norm
  }
}

/**
 * The luminance of a pack texture as a `w` × `h` float tile (0..1), normalised to mean ½ with the
 * deviation scaled by `contrast`, or null when the registry lacks the key or its image is not
 * something a 2D canvas can draw (Node, KTX2, a texture that failed). The WebP the importer ships
 * for `pixels: true` sources loads as an HTMLImageElement, which `drawImage` resamples for free.
 */
function luminanceTile(assets: AssetRegistry | null, key: string, w: number, h: number, contrast: number): Float32Array | null {
  const img = assets?.texture(key)?.image as CanvasImageSource | undefined
  const iw = (img as { width?: number } | undefined)?.width, ih = (img as { height?: number } | undefined)?.height
  if (!img || typeof iw !== 'number' || typeof ih !== 'number' || !(iw > 0 && ih > 0) || (img as { data?: unknown }).data) return null
  let bytes: Uint8ClampedArray
  try {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true })
    if (!ctx) return null
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, 0, 0, w, h)
    bytes = ctx.getImageData(0, 0, w, h).data
  } catch {
    return null
  }
  const out = new Float32Array(w * h)
  let mean = 0
  for (let i = 0; i < out.length; i++) {
    const l = (0.2126 * bytes[i * 4]! + 0.7152 * bytes[i * 4 + 1]! + 0.0722 * bytes[i * 4 + 2]!) / 255
    out[i] = l
    mean += l
  }
  mean /= out.length
  if (!(mean > 0)) return null
  for (let i = 0; i < out.length; i++) out[i] = Math.min(1, Math.max(0, 0.5 + (out[i]! - mean) * contrast))
  return out
}

/**
 * The one detail tile of the cover shader, 512² RGBA (tier-scaled), each channel sampled at its
 * own world period (COVER_DETAIL_M), mean ≈ ½ so it converges to a flat multiplier under
 * minification:
 *   R  forest floor — leaf litter and root shadow, 4 m;
 *   G  paddy — the dry-mud scan's luminance (tex/dry_mud_field_001, 3 m, mean ½ at contrast 1.2)
 *      when the pack has it, else painted furrows along u with the cut straw's speckle (the
 *      30 × 90 m bunds are in the mask's edge channel, rotated per field — a tile cannot rotate);
 *   B  asphalt grain, 1.5 m (the same aggregate as the road's detail, coarser);
 *   A  solar rows — one 5.5 m pitch along v: 0 = the gravel gap, 160 = panel glass, 255 = the
 *      aluminium frame line (the shader turns the frame into a glint).
 * A DataTexture rather than a canvas: a canvas stores premultiplied alpha, which would quantise
 * the RGB of every texel whose A channel is low; the byte array keeps all four channels exact.
 * Cached per size and per source of the G channel (`|mud` with the scan), so a registry without
 * the scan (Node, the low tier) gets the painted tile as before.
 */
export function coverDetailTile(assets: AssetRegistry | null = null): THREE.DataTexture {
  const [w, h] = scaled(512, 512)
  const mud = luminanceTile(assets, 'tex/dry_mud_field_001/diff', w, h, 1.2)
  return cached(`cover-detail-${w}${mud ? '|mud' : ''}`, () => {
    const litter = tileNoise(313)
    const straw = tileNoise(331)
    const grain = tileNoise(347)
    const rng = mulberry(359)
    const data = new Uint8Array(w * h * 4)
    // leaf-litter speckle: a few hundred bright leaves per tile
    const leaves = new Float32Array(w * h)
    for (let k = 0; k < 900; k++) {
      const cx = Math.floor(rng() * w), cy = Math.floor(rng() * h), rad = 1 + rng() * 2.5, v = 0.5 + rng() * 0.5
      const ir = Math.ceil(rad)
      for (let dy = -ir; dy <= ir; dy++) {
        for (let dx = -ir; dx <= ir; dx++) {
          if (dx * dx + dy * dy > rad * rad) continue
          const i = (((cy + dy) % h + h) % h) * w + (((cx + dx) % w + w) % w)
          if (leaves[i]! < v) leaves[i] = v
        }
      }
    }
    for (let y = 0; y < h; y++) {
      const v = y / h
      for (let x = 0; x < w; x++) {
        const u = x / w
        const i = y * w + x
        // R: dark floor with root / litter modulation, lifted by the leaf speckle
        const floor = litter(u, v, 8, 4, 0.55)
        const r = 0.35 + 0.35 * floor + 0.35 * leaves[i]!
        // G: the mud scan, else furrows along u — 10 rows per 3 m tile (30 cm) — with the straw's noise on top
        const rows = 0.5 + 0.5 * Math.cos(v * Math.PI * 2 * 10)
        const g = mud ? mud[i]! : 0.32 + 0.28 * rows + 0.4 * straw(u, v, 32, 3, 0.5)
        // B: aggregate, mean ½
        const b = 0.25 + 0.5 * grain(u, v, 32, 3, 0.55)
        // A: one row pitch along v — panel band (55 %), a frame line at each band edge, gravel gap
        const pv = v % 1
        const panel = pv < 0.55
        const frame = panel && (pv < 0.02 || pv > 0.53 || Math.abs(pv - 0.275) < 0.008)
        const a = frame ? 1 : panel ? 0.63 : 0
        const q = i * 4
        data[q] = Math.min(255, Math.round(r * 255))
        data[q + 1] = Math.min(255, Math.round(g * 255))
        data[q + 2] = Math.min(255, Math.round(b * 255))
        data[q + 3] = Math.round(a * 255)
      }
    }
    const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType)
    t.name = 'cover-detail'
    t.generateMipmaps = true
    t.minFilter = THREE.LinearMipmapLinearFilter
    t.magFilter = THREE.LinearFilter
    t.wrapS = THREE.RepeatWrapping
    t.wrapT = THREE.RepeatWrapping
    t.anisotropy = groundAniso()
    t.colorSpace = THREE.NoColorSpace
    t.needsUpdate = true
    return t
  })
}
