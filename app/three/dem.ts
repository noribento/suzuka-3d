/**
 * The real height field around the circuit (plan §1b): the committed DEM grids of
 * app/data/suzuka-dem.ts read as one continuous function of world (x, z), in PROJECT metres
 * (ASL − DEM_DATUM_ASL, the datum the ELEVATION_KEYFRAMES were derived with).
 *
 *  - `inner(x, z)`: Catmull-Rom bicubic on DEM_INNER (30 m, σ 20 m smoothed DEM5A). Bicubic and
 *    not bilinear on purpose: the 30 m cells' creases would otherwise be chorded by the 6–10 m
 *    fill columns of the ground raster and G3 would blow up.
 *  - `far(x, z)`: bilinear on DEM_FAR (500 m DEM10B, ±35 km; sea cells are 0 m ASL).
 *  - `height(x, z)`: `inner` inside the inner grid, cross-faded into `far` over the outer
 *    300 m of the inner extent, `far` beyond it — then the water beds: the OSM water polygons
 *    well away from the track are sunk 1.5 m under their own shoreline with a 12 m bank, so the
 *    water planes of the far field (terrain-far.ts) have a bed to lie in.
 *
 * Terrain.heightAt (environment.ts) uses `height` as its far term; the relief zones of
 * stands.ts land their outer fades on it; the ring and skyline meshes sample it directly.
 * One field per Track (`demFieldFor`) so all of them see the same numbers.
 */
import type { Track } from '~/sim/track'
import { DEM_DATUM_ASL, DEM_FAR, DEM_INNER } from '~/data/suzuka-dem'
import { decodeDem, decodeI16Delta, type DemGrid } from '~/data/dem-codec'
import { SUR_WATER } from '~/data/suzuka-surroundings'
import { worldRing } from '~/data/en-codec'

/** A sunken water polygon: its ring in world xz and the water level (project metres). */
export interface WaterBed {
  /** OSM way id */
  id: number
  /** closed ring, world xz pairs (no repeated closing vertex) */
  ring: [number, number][]
  /** world XZ bounding box [minX, minZ, maxX, maxZ] */
  box: [number, number, number, number]
  /** the shoreline: the 5th percentile of the DEM at the ring's vertices */
  level: number
  /** m² (shoelace in EN) */
  area: number
}

export interface DemField {
  /** bicubic DEM_INNER, clamped to the grid's edge nodes outside it (project metres) */
  inner(x: number, z: number): number
  /** bilinear DEM_FAR, sea = 0 m ASL (project metres) */
  far(x: number, z: number): number
  /** the field the terrain uses: inner → far cross-fade, water beds included (project metres) */
  height(x: number, z: number): number
  /** world rect of DEM_INNER's nodes */
  extent: { x0: number; z0: number; x1: number; z1: number }
  /** lowest land node of DEM_FAR (sea excluded), project metres — the skirt sits 1 m under it */
  farLandMin: number
  /** the water polygons `height` sinks, for the water-plane builder */
  waterBeds: WaterBed[]
}

/** width of the inner → far cross-fade, measured inward from the inner grid's edge (m) */
export const DEM_FADE_M = 300
/** how far under the shoreline a water bed sits (m) */
export const WATER_BED_DEPTH = 1.5
/** width of the bank from the shoreline down to the bed (m) */
export const WATER_BANK_M = 12
/** the water polygons that qualify: area and distance of every vertex from the centreline */
export const WATER_MIN_AREA = 400
export const WATER_MIN_TRACK_DIST = 150

function smoothstep(t: number): number {
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return t * t * (3 - 2 * t)
}

/** Catmull-Rom weights for the four nodes around fractional position t ∈ [0, 1). */
function crWeights(t: number, w: Float64Array) {
  const t2 = t * t, t3 = t2 * t
  w[0] = -0.5 * t3 + t2 - 0.5 * t
  w[1] = 1.5 * t3 - 2.5 * t2 + 1
  w[2] = -1.5 * t3 + 2 * t2 + 0.5 * t
  w[3] = 0.5 * t3 - 0.5 * t2
}

/**
 * Bicubic Catmull-Rom sampler over a decoded grid, in grid coordinates (u = column, v = row),
 * clamped to the grid: outside it the edge node's value continues flat.
 */
function makeBicubic(g: DemGrid, values: Float32Array) {
  const cols = g.cols, rows = g.rows
  const wu = new Float64Array(4), wv = new Float64Array(4)
  return (u: number, v: number): number => {
    if (u < 0) u = 0
    else if (u > cols - 1) u = cols - 1
    if (v < 0) v = 0
    else if (v > rows - 1) v = rows - 1
    let i = Math.floor(u), j = Math.floor(v)
    if (i > cols - 2) i = cols - 2
    if (j > rows - 2) j = rows - 2
    crWeights(u - i, wu)
    crWeights(v - j, wv)
    let sum = 0
    for (let dj = -1; dj <= 2; dj++) {
      let jj = j + dj
      if (jj < 0) jj = 0
      else if (jj > rows - 1) jj = rows - 1
      const row = jj * cols
      let line = 0
      for (let di = -1; di <= 2; di++) {
        let ii = i + di
        if (ii < 0) ii = 0
        else if (ii > cols - 1) ii = cols - 1
        line += values[row + ii]! * wu[di + 1]!
      }
      sum += line * wv[dj + 1]!
    }
    return sum
  }
}

/** Bilinear sampler in grid coordinates, clamped to the grid. */
function makeBilinear(g: DemGrid, values: Float32Array) {
  const cols = g.cols, rows = g.rows
  return (u: number, v: number): number => {
    if (u < 0) u = 0
    else if (u > cols - 1) u = cols - 1
    if (v < 0) v = 0
    else if (v > rows - 1) v = rows - 1
    let i = Math.floor(u), j = Math.floor(v)
    if (i > cols - 2) i = cols - 2
    if (j > rows - 2) j = rows - 2
    const fu = u - i, fv = v - j
    const k = j * cols + i
    const a = values[k]! * (1 - fu) + values[k + 1]! * fu
    const b = values[k + cols]! * (1 - fu) + values[k + cols + 1]! * fu
    return a * (1 - fv) + b * fv
  }
}

/** the 5th percentile of a list (nearest-rank on the sorted values) */
function percentile05(vals: number[]): number {
  const s = [...vals].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(0.05 * (s.length - 1)))]!
}

/**
 * The water polygons that get a bed: ≥ WATER_MIN_AREA m² with every vertex at least
 * WATER_MIN_TRACK_DIST from the centreline (the ground partition owns everything nearer).
 */
function collectWaterBeds(track: Track, inner: (x: number, z: number) => number): WaterBed[] {
  const out: WaterBed[] = []
  const r2 = WATER_MIN_TRACK_DIST * WATER_MIN_TRACK_DIST
  for (const f of SUR_WATER) {
    if (f.area < WATER_MIN_AREA) continue
    const v = worldRing(f, track.enScale)
    const n = v.length / 2
    if (n < 3) continue
    let nearTrack = false
    const ring: [number, number][] = new Array(n)
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity
    const hs: number[] = new Array(n)
    for (let k = 0; k < n && !nearTrack; k++) {
      const x = v[2 * k]!, z = v[2 * k + 1]!
      track.forEachSampleNear(x, z, WATER_MIN_TRACK_DIST, (_i, d2) => {
        if (d2 < r2) nearTrack = true
      })
      ring[k] = [x, z]
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (z < minZ) minZ = z
      if (z > maxZ) maxZ = z
      hs[k] = inner(x, z)
    }
    if (nearTrack) continue
    out.push({ id: f.id, ring, box: [minX, minZ, maxX, maxZ], level: percentile05(hs), area: f.area })
  }
  return out
}

/**
 * Point-in-polygon (even-odd) plus the distance to the nearest edge, for the bank. The caller
 * has already tested the bounding box.
 */
function insideAndEdge(ring: [number, number][], x: number, z: number): { inside: boolean; edge: number } {
  let inside = false
  let edge2 = Infinity
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0], zi = ring[i]![1], xj = ring[j]![0], zj = ring[j]![1]
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside
    const dx = xj - xi, dz = zj - zi
    let t = ((x - xi) * dx + (z - zi) * dz) / (dx * dx + dz * dz || 1)
    t = t < 0 ? 0 : t > 1 ? 1 : t
    const ex = x - (xi + dx * t), ez = z - (zi + dz * t)
    const d2 = ex * ex + ez * ez
    if (d2 < edge2) edge2 = d2
  }
  return { inside, edge: Math.sqrt(edge2) }
}

/** Build the field for a track (its EN scale maps world xz to the DEM frame). */
export function makeDemField(track: Track): DemField {
  const scale = track.enScale
  const innerVals = decodeDem(DEM_INNER)
  const farVals = decodeDem(DEM_FAR)
  const bicubic = makeBicubic(DEM_INNER, innerVals)
  const bilinear = makeBilinear(DEM_FAR, farVals)
  // grid coordinates of world xz: e = x / scale, n = −z / scale; column (e − e0) / step, row (n0 − n) / step
  const gi = DEM_INNER, gf = DEM_FAR
  const inner = (x: number, z: number): number => bicubic((x / scale - gi.e0) / gi.step, (gi.n0 + z / scale) / gi.step) - DEM_DATUM_ASL
  const far = (x: number, z: number): number => bilinear((x / scale - gf.e0) / gf.step, (gf.n0 + z / scale) / gf.step) - DEM_DATUM_ASL
  const x0 = gi.e0 * scale, x1 = (gi.e0 + (gi.cols - 1) * gi.step) * scale
  const z0 = -gi.n0 * scale, z1 = -(gi.n0 - (gi.rows - 1) * gi.step) * scale
  const extent = { x0, z0, x1, z1 }
  // lowest land node of the far grid: the raw integers, sea sentinel skipped
  let farLandMin = Infinity
  const raw = decodeI16Delta(gf.data)
  for (let k = 0; k < raw.length; k++) {
    const v = raw[k]!
    if (gf.sea !== undefined && v === gf.sea) continue
    if (v * gf.unit < farLandMin) farLandMin = v * gf.unit
  }
  farLandMin -= DEM_DATUM_ASL
  const waterBeds = collectWaterBeds(track, inner)
  const height = (x: number, z: number): number => {
    // distance to the inner extent's edge, negative outside
    const dEdge = Math.min(x - x0, x1 - x, z - z0, z1 - z)
    let h: number
    if (dEdge <= 0) h = far(x, z)
    else if (dEdge >= DEM_FADE_M) h = inner(x, z)
    else {
      const w = smoothstep(dEdge / DEM_FADE_M)
      h = inner(x, z) * w + far(x, z) * (1 - w)
    }
    for (const b of waterBeds) {
      const bb = b.box
      if (x < bb[0] || z < bb[1] || x > bb[2] || z > bb[3]) continue
      const { inside, edge } = insideAndEdge(b.ring, x, z)
      if (!inside) continue
      const bed = b.level - WATER_BED_DEPTH
      if (bed < h) h += (bed - h) * smoothstep(edge / WATER_BANK_M)
    }
    return h
  }
  return { inner, far, height, extent, farLandMin, waterBeds }
}

const fieldCache = new WeakMap<Track, DemField>()

/** The one DemField of a track (Terrain, the relief zones and the far-field meshes share it). */
export function demFieldFor(track: Track): DemField {
  let f = fieldCache.get(track)
  if (!f) fieldCache.set(track, (f = makeDemField(track)))
  return f
}
