import * as THREE from 'three'
import { SUR_BUILDINGS, SUR_SITES } from '~/data/suzuka-surroundings'
import { worldRing, type SurBuilding, type SurBuildingKind } from '~/data/en-codec'
import { BUILDING, BUILDING_KIND_OVERRIDES, CAMPSITE, MOTOPIA, ROOF_WEIGHTS } from '~/data/surroundings-spec'
import { OSM_PIT_BUILDING, OSM_STAND_WAYS } from '~/data/suzuka-facilities'
import { BUILDINGS } from '~/data/suzuka-facilities-spec'
import type { EnvBuildContext } from './environment'
import { cellClippedPolygon, inBBox, pointInRing, principalAxis, ringBBox, ringFromFlat, type GridShape, type XZ } from './far-geometry'
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
 * One material for all of it: a facade ATLAS — a `DataArrayTexture` of seven layers (plaster,
 * window band, ribbed metal, kawara tile, membrane + gravel, white metal roof, blue metal roof)
 * chosen per vertex by the `aLayer` attribute through an onBeforeCompile patch that replaces
 * `<map_fragment>` with a `sampler2DArray` fetch, tinted by vertex colours. Per cell the masses
 * merge into `buildings-<cell>` (the far level, range ∞) and the ornaments (rooftop units, sill
 * bars) into `buildingsDetail-<cell>` at `Quality.farField.buildingsDetailM`. Set
 * `FACADE_ARRAY_TEXTURE` to false to fall back to four plain materials (see there).
 *
 * Keep-outs: every massed footprint pushes a disc (rMax + 6 m) and its ring, the coaster its
 * deck samples, the campsite its outline — into `ctx.keepOut` / `ctx.keepOutPolys` INSIDE the
 * 'buildings' jobs, which the registry runs before any 'forest' job.
 */

// ---------------------------------------------------------------------------------------------
// the facade atlas

/** layer index in the facade atlas (the `aLayer` attribute) */
export const FACADE_LAYER = { plaster: 0, window: 1, ribbed: 2, kawara: 3, membrane: 4, whiteMetal: 5, blueMetal: 6 } as const
type FacadeLayer = (typeof FACADE_LAYER)[keyof typeof FACADE_LAYER]
const FACADE_LAYERS = 7

/**
 * The array texture is the design (one material, one draw per cell). Should a GPU misbehave on
 * `sampler2DArray` (a driver that ignores the sRGB internal format, a mip chain that does not
 * generate for TEXTURE_2D_ARRAY), flip this to false: the same geometry is split per cell into
 * four plain MeshStandardMaterials (plaster, window band, ribbed metal, kawara) — the roof layers
 * fold into plaster with their colour applied as a vertex tint (`FALLBACK_SLOT` / `FALLBACK_TINT`),
 * costing up to four draws per cell instead of one. Not a tier switch: it is a workaround knob,
 * listed in README「GPU で確認すること」.
 */
export const FACADE_ARRAY_TEXTURE = true
const FALLBACK_SLOT: Record<FacadeLayer, number> = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 0, 5: 0, 6: 0 }
const FALLBACK_TINT: Partial<Record<FacadeLayer, string>> = { 4: '#8a8a88', 5: '#f0f0ee', 6: '#3c5f96' }

/** tile size (m) each layer repeats over: [u, v]; v of the window band is one storey, of the ribbed layer the whole wall */
const TILE: Record<FacadeLayer, [number, number]> = { 0: [4, 4], 1: [4, 1], 2: [2, 1], 3: [1.2, 1.2], 4: [6, 6], 5: [4, 4], 6: [4, 4] }

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

/** the seven layer painters: (u, v) → rgb 0..255, v = 0 at the bottom of the tile */
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
  // kawara: four courses of clay tiles, each with a rolled lip (a shadow line under the course above) and a wave across
  3: (u, v, out) => {
    const course = (v * 4) % 1
    const tile = (u * 6) % 1
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
}

interface FacadeAtlas {
  /** the array texture (null under the fallback) */
  array: THREE.DataArrayTexture | null
  /** the four plain textures of the fallback (empty when the array is in use) */
  plain: THREE.Texture[]
}

/** The facade atlas, once per texture scale (cached under textures.ts's registry, so it is disposed with the rest). */
function facadeAtlas(): FacadeAtlas {
  const [w, h] = scaled(256, 256)
  return cached(`buildings/facade@${w}${FACADE_ARRAY_TEXTURE ? 'a' : 'p'}`, (): FacadeAtlas => {
    const canvases: HTMLCanvasElement[] = []
    for (let l = 0; l < FACADE_LAYERS; l++) {
      const fn = LAYER_PAINT[l as FacadeLayer]
      canvases.push(paint(w, h, (x, y, out) => fn((x + 0.5) / w, (y + 0.5) / h, out)))
    }
    if (FACADE_ARRAY_TEXTURE) {
      const data = new Uint8Array(w * h * 4 * FACADE_LAYERS)
      canvases.forEach((c, l) => {
        const img = c.getContext('2d')!.getImageData(0, 0, w, h).data
        data.set(img, l * w * h * 4)
      })
      const tex = new THREE.DataArrayTexture(data, w, h, FACADE_LAYERS)
      tex.colorSpace = THREE.SRGBColorSpace
      tex.wrapS = THREE.RepeatWrapping
      tex.wrapT = THREE.RepeatWrapping
      tex.magFilter = THREE.LinearFilter
      tex.minFilter = THREE.LinearMipmapLinearFilter
      tex.generateMipmaps = true
      tex.anisotropy = 4
      tex.needsUpdate = true
      return { array: tex, plain: [] }
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
    return { array: null, plain }
  })
}

/** The one facade material (array path): vertex colours × the layer picked per vertex. */
function facadeMaterial(atlas: THREE.DataArrayTexture): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.86, metalness: 0.03 })
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.facadeAtlas = { value: atlas }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aLayer;\nvarying float vLayer;\nvarying vec2 vFacadeUv;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvLayer = aLayer;\nvFacadeUv = uv;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform highp sampler2DArray facadeAtlas;\nvarying float vLayer;\nvarying vec2 vFacadeUv;')
      .replace('#include <map_fragment>', 'diffuseColor *= texture( facadeAtlas, vec3( vFacadeUv, vLayer ) );')
  }
  mat.customProgramCacheKey = () => 'facade'
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

interface Planned {
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

/** the oriented bounding box of a ring: centre, unit axis, half extents along / across */
function obb(ring: readonly XZ[]): { cx: number; cz: number; ax: number; az: number; ha: number; hc: number } {
  const p = principalAxis(ring)
  let a0 = Infinity, a1 = -Infinity, c0 = Infinity, c1 = -Infinity
  for (const [x, z] of ring) {
    const dx = x - p.cx, dz = z - p.cz
    const a = dx * p.ax + dz * p.az, c = -dx * p.az + dz * p.ax
    if (a < a0) a0 = a
    if (a > a1) a1 = a
    if (c < c0) c0 = c
    if (c > c1) c1 = c
  }
  const ma = (a0 + a1) / 2, mc = (c0 + c1) / 2
  return { cx: p.cx + p.ax * ma - p.az * mc, cz: p.cz + p.az * ma + p.ax * mc, ax: p.ax, az: p.az, ha: (a1 - a0) / 2, hc: (c1 - c0) / 2 }
}

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
}

/**
 * One building into `mass` (and its ornaments into `detail`). Returns the numbers the offline
 * check reads (base, ground range) — the base is gMin − baseDrop by construction.
 */
function massBuilding(ctx: EnvBuildContext, p: Planned, mass: Acc, detail: Acc | null, fascia: ((p: Planned, slabTop: number) => void) | null): Massed {
  const { ground } = ctx
  const rng = mulberry(p.seed)
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

  // --- walls (a vertical quad per edge) ----------------------------------------------------
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
  const wc = wallColour()
  const storeys = Math.max(1, Math.round((eavesY - gMin) / BUILDING.storey))
  // only the dwellings and the hotel wings get the window-band layer; school / temple / generic
  // are plaster, the works ribbed metal (plan §2c)
  const wallLayer: FacadeLayer = PARAPET_KINDS.has(kind) ? FACADE_LAYER.ribbed
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
    return { id: p.b.id, kind, base, gMin, gMax, top: slabTop, cx: p.cx, cz: p.cz, rMax: p.rMax }
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
    const rc = _c.set(tint).clone()
    const P = (a: number, k: number, y: number): number[] => [box.cx + box.ax * a - box.az * k, y, box.cz + box.az * a + box.ax * k]
    const slope = Math.hypot(hc, rise)
    const T = TILE[FACADE_LAYER.kawara]
    const y0 = eavesY, y1 = eavesY + rise
    // the two long faces (trapezoids, triangles of a pyramid) and the two hip ends
    for (const s of [-1, 1]) {
      const pts = [P(-ha, s * hc, y0), P(ha, s * hc, y0), P(rh, 0, y1), P(-rh, 0, y1)]
      const uvs = [[-ha / T[0], 0], [ha / T[0], 0], [rh / T[0], slope / T[1]], [-rh / T[0], slope / T[1]]]
      if (pyramid) mass.face(pts.slice(0, 3), uvs.slice(0, 3), rc, FACADE_LAYER.kawara, [0, 1, 0])
      else mass.face(pts, uvs, rc, FACADE_LAYER.kawara, [0, 1, 0])
    }
    for (const s of [-1, 1]) {
      const pts = [P(s * ha, -hc, y0), P(s * ha, hc, y0), P(s * rh, 0, y1)]
      const uvs = [[-hc / T[0], 0], [hc / T[0], 0], [0, Math.hypot(ha - rh, rise) / T[1]]]
      mass.face(pts, uvs, rc, FACADE_LAYER.kawara, [0, 1, 0])
    }
    // the soffit: the overhang has no walls under it, and the mass has no bottom cap, so without
    // this the roof reads as a hole from below (2 triangles per house)
    mass.face([P(-ha, -hc, y0), P(ha, -hc, y0), P(ha, hc, y0), P(-ha, hc, y0)],
      [[0, 0], [(2 * ha) / T[0], 0], [(2 * ha) / T[0], (2 * hc) / T[1]], [0, (2 * hc) / T[1]]], _c2.set('#cfc9bd'), FACADE_LAYER.plaster, [0, -1, 0])
    top = y1
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
  return { id: p.b.id, kind, base, gMin, gMax, top, cx: p.cx, cz: p.cz, rMax: p.rMax }
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
function rooftopUnits(acc: Acc, p: Planned, box: ReturnType<typeof obb>, roofY: number, rng: () => number) {
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
  const stats: BuildingsStats = { planned: 0, byKind: {}, skipped: { owned: 0, paddock: 0, verge: 0, small: 0, degenerate: 0 }, cells: 0, jobs: 0, motopia: { coasterWays: 0, pools: 0, tents: 0, vans: 0 } }
  const planned = planBuildings(ctx, stats)
  const castShadow = q.farField.shadows
  const detailM = q.farField.buildingsDetailM

  // --- the materials, once, inside the first job -----------------------------------------------
  let facadeMats: THREE.Material[] | null = null
  const materials = (): THREE.Material[] => {
    if (facadeMats) return facadeMats
    const atlas = facadeAtlas()
    if (atlas.array) facadeMats = [facadeMaterial(atlas.array)]
    else facadeMats = atlas.plain.map((map) => new THREE.MeshStandardMaterial({ color: 0xffffff, map, vertexColors: true, roughness: 0.86, metalness: 0.03 }))
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
      for (const p of here) {
        const m = massBuilding(ctx, p, mass, detail, fascia)
        massed.push(m)
        keepOut.push({ x: p.cx, z: p.cz, r: p.rMax + BUILDING.keepOutMargin })
        keepOutPolys.push({ ring: p.ring, box: p.box })
      }
      const massMeshes = meshesOf(mass, `buildings-${key}`, true)
      if (!massMeshes.length) return null
      const massGroup = new THREE.Group()
      massGroup.name = `buildingsMass-${key}`
      massGroup.add(...massMeshes, ...extra)
      root.add(massGroup)
      farField.register({ kind: 'buildings', name: `buildings-${key}`, cell, levels: [{ object: massGroup, range: Infinity }] })
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
      root.userData.buildings = { massed, triangles: mass.triangles, detailTriangles: detail ? detail.triangles : 0 }
      return root
    })
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
  if (import.meta.dev) console.info(`[buildings] ${stats.planned} footprints planned in ${stats.cells} cells (skipped: ${JSON.stringify(stats.skipped)})`)
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
