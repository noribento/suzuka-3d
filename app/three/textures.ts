import * as THREE from 'three'
import type { Compound } from '~/data/drivers'
import { TEAMS, type Team, type TeamId } from '~/data/drivers'

/**
 * Procedural PBR textures (no external assets). Everything is generated once from
 * seeded, tileable noise and cached. Surfaces that matter (asphalt, grass, gravel,
 * kerbs, carbon fibre) come with a normal map derived from a height field and,
 * where useful, a roughness map.
 */

export interface MaterialMaps {
  map: THREE.Texture
  normalMap?: THREE.Texture
  roughnessMap?: THREE.Texture
}

let maxAnisotropy = 8
/** Called once by the scene after the renderer exists so textures get full anisotropic filtering. */
export function setMaxAnisotropy(v: number) {
  maxAnisotropy = Math.max(1, v)
}

let textureScale = 1
/** Resolution multiplier of the large generated textures (1 on the high tier, 0.5 on low). Set before any texture is built. */
export function setTextureScale(k: number) {
  textureScale = k
}

// ---------------------------------------------------------------------------------------------
// noise

function mulberry(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    let t = (s += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Tileable value noise. Periods must be powers of two (≤ 256 · 2^k) for the hash to wrap cleanly. */
class Noise2 {
  private perm = new Uint8Array(512)
  constructor(seed: number) {
    const rng = mulberry(seed)
    const p = Array.from({ length: 256 }, (_, i) => i)
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1))
      ;[p[i], p[j]] = [p[j]!, p[i]!]
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255]!
  }

  private lattice(x: number, y: number): number {
    return this.perm[(this.perm[x & 255]! + y) & 255]! / 255
  }

  /** 0..1 */
  value(x: number, y: number, px: number, py: number): number {
    const xi = Math.floor(x), yi = Math.floor(y)
    let fx = x - xi, fy = y - yi
    fx = fx * fx * fx * (fx * (fx * 6 - 15) + 10)
    fy = fy * fy * fy * (fy * (fy * 6 - 15) + 10)
    const x0 = ((xi % px) + px) % px, y0 = ((yi % py) + py) % py
    const x1 = (x0 + 1) % px, y1 = (y0 + 1) % py
    const a = this.lattice(x0, y0), b = this.lattice(x1, y0)
    const c = this.lattice(x0, y1), d = this.lattice(x1, y1)
    const ab = a + (b - a) * fx
    const cd = c + (d - c) * fx
    return ab + (cd - ab) * fy
  }

  /** Fractal sum, 0..1, tileable over `px` × `py` lattice cells at the base octave. */
  fbm(x: number, y: number, px: number, py: number, octaves: number, gain = 0.5): number {
    let sum = 0, amp = 1, norm = 0, f = 1
    for (let o = 0; o < octaves; o++) {
      sum += this.value(x * f, y * f, px * f, py * f) * amp
      norm += amp
      amp *= gain
      f *= 2
    }
    return sum / norm
  }
}

// ---------------------------------------------------------------------------------------------
// canvas helpers

function canvas(w: number, h: number): { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  return { c, ctx }
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0
}

function makeTexture(c: HTMLCanvasElement, opts: { srgb?: boolean; repeat?: [number, number]; wrap?: THREE.Wrapping; nearest?: boolean } = {}): THREE.Texture {
  const tex = new THREE.CanvasTexture(c)
  const wrap = opts.wrap ?? THREE.RepeatWrapping
  tex.wrapS = wrap
  tex.wrapT = wrap
  if (opts.repeat) tex.repeat.set(opts.repeat[0], opts.repeat[1])
  tex.anisotropy = maxAnisotropy
  tex.colorSpace = opts.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace
  if (opts.nearest) tex.magFilter = THREE.NearestFilter
  tex.needsUpdate = true
  return tex
}

/** Fill a canvas from a per-pixel colour callback. */
function paint(w: number, h: number, fn: (x: number, y: number, out: Float32Array) => void): HTMLCanvasElement {
  const { c, ctx } = canvas(w, h)
  const img = ctx.createImageData(w, h)
  const d = img.data
  const out = new Float32Array(3)
  let i = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      fn(x, y, out)
      d[i] = clamp255(out[0]!)
      d[i + 1] = clamp255(out[1]!)
      d[i + 2] = clamp255(out[2]!)
      d[i + 3] = 255
      i += 4
    }
  }
  ctx.putImageData(img, 0, 0)
  return c
}

/** Tangent-space normal map from a tileable height field (canvas rows top→bottom). */
function normalMapFrom(height: Float32Array, w: number, h: number, strength: number): THREE.Texture {
  const c = paint(w, h, (x, y, out) => {
    const l = height[y * w + ((x - 1 + w) % w)]!
    const r = height[y * w + ((x + 1) % w)]!
    const u = height[((y - 1 + h) % h) * w + x]!
    const dn = height[((y + 1) % h) * w + x]!
    const dx = (r - l) * strength
    const dy = (dn - u) * strength
    // canvas y runs opposite to uv v (the texture is flipped on upload) → +dy maps to +v
    const nx = -dx, ny = dy, nz = 1
    const inv = 1 / Math.hypot(nx, ny, nz)
    out[0] = (nx * inv * 0.5 + 0.5) * 255
    out[1] = (ny * inv * 0.5 + 0.5) * 255
    out[2] = (nz * inv * 0.5 + 0.5) * 255
  })
  return makeTexture(c, { srgb: false })
}

function grayMap(values: Float32Array, w: number, h: number): THREE.Texture {
  const c = paint(w, h, (x, y, out) => {
    const v = values[y * w + x]! * 255
    out[0] = v
    out[1] = v
    out[2] = v
  })
  return makeTexture(c, { srgb: false })
}

const cache = new Map<string, unknown>()

function cached<T>(key: string, make: () => T): T {
  let t = cache.get(key) as T | undefined
  if (t === undefined) {
    t = make()
    cache.set(key, t)
  }
  return t
}

function cachedTextures(): THREE.Texture[] {
  const out: THREE.Texture[] = []
  for (const v of cache.values()) {
    if ((v as THREE.Texture).isTexture) out.push(v as THREE.Texture)
    else if (v && typeof v === 'object') for (const t of Object.values(v as Record<string, unknown>)) if ((t as THREE.Texture)?.isTexture) out.push(t as THREE.Texture)
  }
  return out
}

/** Approximate GPU footprint of every generated texture (RGBA8 + mips), for the dev hook. */
export function textureBytes(): number {
  let bytes = 0
  for (const t of cachedTextures()) {
    const img = t.image as { width?: number; height?: number } | undefined
    if (img?.width && img?.height) bytes += img.width * img.height * 4 * 1.33
  }
  return Math.round(bytes)
}

/** After a WebGL context restore: every cached canvas must be uploaded again. */
export function markAllDirty() {
  for (const t of cachedTextures()) t.needsUpdate = true
}

/** Free every generated texture (the canvases go with them) and empty the cache. */
export function disposeAll() {
  for (const t of cachedTextures()) t.dispose()
  cache.clear()
}

function hexToRgb(hex: string): [number, number, number] {
  const c = new THREE.Color(hex)
  return [c.r * 255, c.g * 255, c.b * 255]
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function smooth(t: number): number {
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return t * t * (3 - 2 * t)
}

// ---------------------------------------------------------------------------------------------
// track surfaces

/**
 * Asphalt. u spans the full track width (edge lines baked in), v tiles every 20 m.
 * 1024 × 2048 → ≈1.3 cm/texel across, 1 cm/texel along.
 */
export function asphaltMaps(withLines = true): MaterialMaps {
  return cached(`asphalt-${withLines}`, () => {
    const w = 1024, h = 2048
    const n = new Noise2(7)
    const n2 = new Noise2(19)
    const height = new Float32Array(w * h)
    const rough = new Float32Array(w * h)
    const lineW = withLines ? Math.round((0.15 / 13) * w) : 0 // 15 cm lines
    const c = paint(w, h, (x, y, out) => {
      const u = x / w, v = y / h
      // aggregate: fine, high-contrast grain + medium mottling + broad tonal patches
      const grain = n.fbm(u * 256, v * 512, 256, 512, 3, 0.55) // ~5 mm aggregate
      const mottle = n.fbm(u * 64, v * 128, 64, 128, 4, 0.5)
      const patch = n2.fbm(u * 8, v * 16, 8, 16, 3, 0.6)
      const speck = n2.value(x * 0.9, y * 0.9, 1024, 2048)
      let hgt = grain * 0.7 + mottle * 0.25 + patch * 0.05
      // rubbered-in lanes: two darker bands where the cars run, with ragged edges
      const laneEdge = (n.fbm(u * 4, v * 32, 4, 32, 2) - 0.5) * 0.08
      const lane = Math.max(
        smooth(1 - Math.abs(u - 0.31 + laneEdge) / 0.16),
        smooth(1 - Math.abs(u - 0.69 - laneEdge) / 0.16),
      )
      const rubber = lane * (0.55 + 0.45 * n2.fbm(u * 16, v * 64, 16, 64, 3))
      // tyre marbles / pick-up towards the edges
      const marbles = smooth((Math.abs(u - 0.5) - 0.38) / 0.1) * n2.fbm(u * 128, v * 256, 128, 256, 2) * 0.35
      let base = 58 + (hgt - 0.5) * 80 + (speck - 0.5) * 40 + (patch - 0.5) * 20
      base -= rubber * 26
      base += marbles * 10
      let r = base + 5, g = base + 3, b = base - 1
      // slightly warm where the surface is old and worn, cooler on fresh patches
      r += (patch - 0.5) * 8
      g += (patch - 0.5) * 4
      b += (0.5 - patch) * 4
      let roughness = 0.9 - rubber * 0.22 + (hgt - 0.5) * 0.08
      if (lineW > 0 && (x < lineW || x >= w - lineW)) {
        // painted line with wear
        const wear = n2.fbm(u * 256, v * 128, 256, 128, 3)
        const k = smooth((wear - 0.28) / 0.25)
        r = lerp(r, 232, k)
        g = lerp(g, 232, k)
        b = lerp(b, 228, k)
        roughness = lerp(roughness, 0.55, k)
        hgt -= 0.15 * k
      }
      out[0] = r
      out[1] = g
      out[2] = b
      height[y * w + x] = hgt
      rough[y * w + x] = roughness
    })
    const map = makeTexture(c, { wrap: THREE.RepeatWrapping })
    map.wrapS = THREE.ClampToEdgeWrapping
    const normalMap = normalMapFrom(height, w, h, 3.2)
    normalMap.wrapS = THREE.ClampToEdgeWrapping
    const roughnessMap = grayMap(rough, w, h)
    roughnessMap.wrapS = THREE.ClampToEdgeWrapping
    return { map, normalMap, roughnessMap }
  })
}

/**
 * Grass, tile ≈ 8 m. The mown bands of the run-off (two per tile) are added by the macro patch
 * (track-mesh.ts addMacro, `stripes`) so the terrain and the run-off share one texture.
 */
export function grassMaps(striped = false): MaterialMaps {
  return cached(`grass-${striped}`, () => {
    const w = 1024, h = 1024
    const n = new Noise2(3)
    const n2 = new Noise2(31)
    const height = new Float32Array(w * h)
    const c = paint(w, h, (x, y, out) => {
      const u = x / w, v = y / h
      // blades: anisotropic high-frequency noise (stretched along v)
      const blades = n.fbm(u * 256, v * 96, 256, 96, 3, 0.55)
      const clumps = n.fbm(u * 16, v * 16, 16, 16, 4, 0.5)
      const broad = n2.fbm(u * 4, v * 4, 4, 4, 3, 0.6)
      const dirt = smooth((n2.fbm(u * 6, v * 6, 6, 6, 3, 0.5) - 0.66) / 0.12) * 0.5
      const hgt = blades * 0.6 + clumps * 0.4
      // colour: yellow-green in the light clumps, blue-green in the shade, brown where worn
      const t = clumps * 0.6 + blades * 0.4
      let r = lerp(58, 122, t) + (broad - 0.5) * 30
      let g = lerp(96, 150, t) + (broad - 0.5) * 24
      let b = lerp(34, 52, t) + (broad - 0.5) * 10
      r = lerp(r, 128, dirt * 0.7)
      g = lerp(g, 108, dirt * 0.7)
      b = lerp(b, 70, dirt * 0.7)
      if (striped) {
        const band = Math.floor(v * 4) % 2 === 0 ? 1 : 0
        const k = band ? 0.86 : 1.06
        r *= k
        g *= k
        b *= k
      }
      out[0] = r
      out[1] = g
      out[2] = b
      height[y * w + x] = hgt
    })
    return { map: makeTexture(c), normalMap: normalMapFrom(height, w, h, 2.2) }
  })
}

/** Gravel trap: individually shaded pebbles on a sand bed, tile ≈ 3 m. */
/** Fraction of the asphalt texture's width taken by one painted edge line (asphaltMaps(true)). */
export const ASPHALT_LINE_FRAC = Math.round((0.15 / 13) * 1024) / 1024

export function gravelMaps(): MaterialMaps {
  return cached('gravel', () => {
    const w = 1024, h = 1024
    const rng = mulberry(11)
    const n = new Noise2(11)
    const height = new Float32Array(w * h)
    const tint = new Float32Array(w * h) // per-pixel pebble tint (0 = sand)
    const kind = new Uint8Array(w * h)
    for (let i = 0; i < w * h; i++) height[i] = n.fbm((i % w) / 32, Math.floor(i / w) / 32, 32, 32, 3) * 0.25
    const pebbles = 14000
    for (let k = 0; k < pebbles; k++) {
      const cx = rng() * w, cy = rng() * h
      const rad = 2.5 + rng() * rng() * 9
      const ax = 0.75 + rng() * 0.5
      const t = rng()
      const kd = rng() < 0.15 ? 2 : rng() < 0.4 ? 1 : 0
      const r0 = Math.ceil(rad * 1.4)
      for (let dy = -r0; dy <= r0; dy++) {
        for (let dx = -r0; dx <= r0; dx++) {
          const d = Math.hypot(dx / ax, dy * ax) / rad
          if (d >= 1) continue
          const px = ((Math.round(cx) + dx) % w + w) % w
          const py = ((Math.round(cy) + dy) % h + h) % h
          const i = py * w + px
          const dome = Math.sqrt(1 - d * d) * rad * 0.12 + 0.3
          if (dome > height[i]!) {
            height[i] = dome
            tint[i] = 0.3 + t * 0.7
            kind[i] = kd
          }
        }
      }
    }
    const c = paint(w, h, (x, y, out) => {
      const i = y * w + x
      const tn = tint[i]!
      const hg = height[i]!
      const speck = (n.value(x * 1.3, y * 1.3, 1024, 1024) - 0.5) * 26
      let r: number, g: number, b: number
      if (tn === 0) {
        // sand bed
        r = 176 + (hg - 0.12) * 120 + speck
        g = 163 + (hg - 0.12) * 110 + speck
        b = 134 + (hg - 0.12) * 90 + speck
      } else {
        const shade = 0.55 + hg * 1.1
        if (kind[i] === 2) {
          r = 118 * shade + speck
          g = 116 * shade + speck
          b = 112 * shade + speck // grey stone
        } else if (kind[i] === 1) {
          r = (205 + tn * 30) * shade + speck
          g = (190 + tn * 26) * shade + speck
          b = (160 + tn * 22) * shade + speck // pale limestone
        } else {
          r = (188 + tn * 40) * shade + speck
          g = (168 + tn * 34) * shade + speck
          b = (132 + tn * 26) * shade + speck // sandstone
        }
      }
      out[0] = r
      out[1] = g
      out[2] = b
    })
    return { map: makeTexture(c), normalMap: normalMapFrom(height, w, h, 2.6) }
  })
}

/** Kerb: one red + one white block per tile (2 m), worn paint, ribbed profile in the normal map. */
export function kerbMaps(): MaterialMaps {
  return cached('kerb', () => {
    const w = 256, h = 1024
    const n = new Noise2(5)
    const height = new Float32Array(w * h)
    const c = paint(w, h, (x, y, out) => {
      const u = x / w, v = y / h
      const red = v < 0.5
      const wear = n.fbm(u * 8, v * 32, 8, 32, 4, 0.55)
      const scuff = smooth((wear - 0.56) / 0.16) // paint rubbed off → concrete
      const edge = smooth((Math.abs(u - 0.5) - 0.42) / 0.06) // dirt at the outer edges
      const rib = 0.5 + 0.5 * Math.cos(v * Math.PI * 2 * 16) // 16 ribs per tile
      let r = red ? 196 : 226, g = red ? 28 : 224, b = red ? 34 : 218
      r = lerp(r, 150, scuff)
      g = lerp(g, 146, scuff)
      b = lerp(b, 140, scuff)
      r = lerp(r, 110, edge * 0.5)
      g = lerp(g, 106, edge * 0.5)
      b = lerp(b, 100, edge * 0.5)
      const shade = 0.9 + rib * 0.12 + (wear - 0.5) * 0.14
      out[0] = r * shade
      out[1] = g * shade
      out[2] = b * shade
      height[y * w + x] = rib * 0.7 + wear * 0.3 - scuff * 0.2
    })
    return { map: makeTexture(c), normalMap: normalMapFrom(height, w, h, 1.6) }
  })
}

/** Concrete (pit wall, bridge), tile 4 m. */
export function concreteMaps(): MaterialMaps {
  return cached('concrete', () => {
    const w = 512, h = 512
    const n = new Noise2(23)
    const height = new Float32Array(w * h)
    const c = paint(w, h, (x, y, out) => {
      const u = x / w, v = y / h
      const f = n.fbm(u * 32, v * 32, 32, 32, 4, 0.5)
      const stain = n.fbm(u * 3, v * 3, 3, 3, 3, 0.6)
      const base = 150 + (f - 0.5) * 40 + (stain - 0.5) * 30
      out[0] = base + 2
      out[1] = base
      out[2] = base - 6
      height[y * w + x] = f
    })
    return { map: makeTexture(c), normalMap: normalMapFrom(height, w, h, 0.8) }
  })
}

// ---------------------------------------------------------------------------------------------
// car materials

/** 2×2 twill carbon-fibre weave, tile ≈ 2.5 cm. */
export function carbonMaps(): MaterialMaps {
  return cached('carbon', () => {
    const w = 256, h = 256
    const n = new Noise2(41)
    const height = new Float32Array(w * h)
    const tow = 16 // pixels per tow
    const c = paint(w, h, (x, y, out) => {
      const tx = Math.floor(x / tow), ty = Math.floor(y / tow)
      // twill: tows alternate direction on a diagonal
      const horizontal = ((tx + ty) >> 1) % 2 === 0
      const fx = (x % tow) / tow, fy = (y % tow) / tow
      const across = horizontal ? fy : fx // position across the tow (0..1)
      const along = horizontal ? fx : fy
      const strand = 0.5 + 0.5 * Math.sin(across * Math.PI) // rounded tow
      const fibre = 0.85 + 0.15 * Math.sin(across * Math.PI * 6 + along * 2)
      const sheen = horizontal ? 1.0 : 0.72
      const noise = (n.value(x * 0.7, y * 0.7, 256, 256) - 0.5) * 10
      const v = 26 + strand * 34 * sheen * fibre + noise
      out[0] = v
      out[1] = v + 1
      out[2] = v + 3
      height[y * w + x] = strand * 0.8 + (horizontal ? 0.1 : 0)
    })
    return { map: makeTexture(c), normalMap: normalMapFrom(height, w, h, 0.6) }
  })
}

/**
 * Tyre (LatheGeometry with 6 profile points): v 0–0.2 inner sidewall, 0.2–0.4 shoulder,
 * 0.4–0.6 tread, 0.6–0.8 shoulder, 0.8–1 outer sidewall. u runs around the tyre.
 */
export function tyreMaps(compound: Compound, color: string): MaterialMaps {
  return cached(`tyre-${compound}`, () => {
    const w = 1024, h = 512
    const n = new Noise2(53)
    const [cr, cg, cb] = hexToRgb(color)
    const height = new Float32Array(w * h)
    const rough = new Float32Array(w * h)
    const c = paint(w, h, (x, y, out) => {
      const u = x / w, v = 1 - y / h // v as in uv space (0 = inner rim)
      const band = v < 0.2 ? 0 : v < 0.4 ? 1 : v < 0.6 ? 2 : v < 0.8 ? 3 : 4
      const grain = n.fbm(u * 128, v * 64, 128, 64, 3, 0.5)
      let r = 22, g = 22, b = 24
      let hg = grain * 0.4
      let ro = 0.92
      if (band === 2) {
        // tread: graining and heat marks along the rolling direction
        const wear = n.fbm(u * 64, v * 8, 64, 8, 3, 0.55)
        const shine = smooth((wear - 0.45) / 0.3)
        r = 26 + shine * 10
        g = 26 + shine * 10
        b = 27 + shine * 10
        hg = wear * 0.5
        ro = 0.85 - shine * 0.25
      } else if (band === 0 || band === 4) {
        // sidewall: radial position 0 at the rim → 1 at the shoulder
        const rad = band === 0 ? v / 0.2 : (1 - v) / 0.2
        // compound colour ring next to the rim (2025-style sidewall band)
        const ring = smooth((rad - 0.12) / 0.03) * (1 - smooth((rad - 0.3) / 0.03))
        r = lerp(r, cr, ring)
        g = lerp(g, cg, ring)
        b = lerp(b, cb, ring)
        // moulded lettering band (two blocks of raised text-like marks)
        const angle = u * Math.PI * 2
        const letters = Math.abs(Math.sin(angle * 2)) > 0.72 && rad > 0.46 && rad < 0.72
        if (letters) {
          const cell = Math.floor(u * 160) % 5
          const glyph = cell < 3 && Math.abs(Math.sin(rad * 60)) > 0.2
          if (glyph) {
            r = lerp(r, cr, 0.9)
            g = lerp(g, cg, 0.9)
            b = lerp(b, cb, 0.9)
            hg += 0.2
          }
        }
        ro = 0.88 - ring * 0.2
      }
      out[0] = r
      out[1] = g
      out[2] = b
      height[y * w + x] = hg
      rough[y * w + x] = ro
    })
    return { map: makeTexture(c), normalMap: normalMapFrom(height, w, h, 1.2), roughnessMap: grayMap(rough, w, h) }
  })
}

/** Wheel rim face (polar strip: u around, v radial 0 = hub → 1 = rim edge). */
export function rimMaps(): MaterialMaps {
  return cached('rim', () => {
    const w = 512, h = 128
    const n = new Noise2(61)
    const height = new Float32Array(w * h)
    const rough = new Float32Array(w * h)
    const c = paint(w, h, (x, y, out) => {
      const u = x / w, v = 1 - y / h
      const spokes = 10
      const sp = 0.5 + 0.5 * Math.cos(u * Math.PI * 2 * spokes)
      const spoke = smooth((sp - 0.35 - v * 0.25) / 0.08)
      const hub = 1 - smooth((v - 0.14) / 0.04)
      const brushed = (n.value(x * 0.4, y * 2.5, 512, 128) - 0.5) * 30
      let r = 120 + brushed, g = 122 + brushed, b = 128 + brushed // machined alloy
      const dark = (1 - spoke) * (1 - hub)
      r = lerp(r, 22, dark)
      g = lerp(g, 22, dark)
      b = lerp(b, 26, dark)
      // gold-anodised centre nut
      r = lerp(r, 205, hub)
      g = lerp(g, 160, hub)
      b = lerp(b, 60, hub)
      out[0] = r
      out[1] = g
      out[2] = b
      height[y * w + x] = spoke * 0.6 + hub * 0.4
      rough[y * w + x] = 0.35 + dark * 0.4
    })
    return { map: makeTexture(c), normalMap: normalMapFrom(height, w, h, 1.4), roughnessMap: grayMap(rough, w, h) }
  })
}

/**
 * Body livery for the lofted monocoque. Canvas x = along the car (0 tail → 1 nose),
 * canvas y = 1 − around (around: 0 bottom → 0.25 left flank → 0.5 top → 0.75 right flank → 1 bottom).
 */
export function liveryTexture(teamId: TeamId, number: number): THREE.Texture {
  return cached(`livery-${teamId}-${number}-${textureScale}`, () => {
    const team = TEAMS[teamId]
    // 2048×1024 on the high tier (the number decals are read in close-ups), half on low
    const w = Math.round(2048 * textureScale), h = Math.round(1024 * textureScale)
    const { c, ctx } = canvas(w, h)
    const yOf = (around: number) => (1 - around) * h
    paintLiveryBase(ctx, w, h, team)
    // flank stripe (accent) tapering towards the nose
    ctx.fillStyle = team.accent
    for (const around of [0.22, 0.78]) {
      const yc = yOf(around)
      const half = around < 0.5 ? 1 : -1
      ctx.beginPath()
      ctx.moveTo(w * 0.06, yc - 0.035 * h * half)
      ctx.lineTo(w * 0.62, yc - 0.055 * h * half)
      ctx.lineTo(w * 0.92, yc - 0.012 * h * half)
      ctx.lineTo(w * 0.92, yc + 0.012 * h * half)
      ctx.lineTo(w * 0.62, yc + 0.02 * h * half)
      ctx.lineTo(w * 0.06, yc + 0.02 * h * half)
      ctx.closePath()
      ctx.fill()
    }
    // engine-cover spine + nose chevron (accent)
    ctx.beginPath()
    ctx.moveTo(0, yOf(0.44))
    ctx.lineTo(w * 0.46, yOf(0.47))
    ctx.lineTo(w * 0.46, yOf(0.53))
    ctx.lineTo(0, yOf(0.56))
    ctx.closePath()
    ctx.fill()
    ctx.beginPath()
    ctx.moveTo(w * 0.86, yOf(0.62))
    ctx.lineTo(w * 0.905, yOf(0.5))
    ctx.lineTo(w * 0.86, yOf(0.38))
    ctx.lineTo(w * 0.885, yOf(0.38))
    ctx.lineTo(w * 0.93, yOf(0.5))
    ctx.lineTo(w * 0.885, yOf(0.62))
    ctx.closePath()
    ctx.fill()
    // sponsor-like blocks on the flanks (neutral geometric decals, no real brands)
    ctx.fillStyle = 'rgba(255,255,255,0.92)'
    for (const around of [0.2, 0.8]) {
      const yc = yOf(around)
      ctx.fillRect(w * 0.5, yc - 12, w * 0.1, 24)
      ctx.fillRect(w * 0.64, yc - 9, w * 0.06, 18)
    }
    // race numbers: engine cover flanks (readable from each side) and nose top (readable from the front)
    const numText = String(number)
    const contrast = numberContrast(team)
    ctx.fillStyle = contrast
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    // engine cover flanks: z ≈ −0.85 (uv.x 0.27), 45° up from the side so the sidepod does not hide it
    ctx.font = `italic 900 ${Math.round(h * 0.12)}px 'Titillium Web', 'Segoe UI', Arial, sans-serif`
    ctx.save()
    ctx.translate(w * 0.27, yOf(0.37))
    ctx.scale(-1, 1)
    ctx.fillText(numText, 0, 0)
    ctx.restore()
    ctx.save()
    ctx.translate(w * 0.27, yOf(0.63))
    ctx.scale(1, -1)
    ctx.fillText(numText, 0, 0)
    ctx.restore()
    ctx.save()
    ctx.translate(w * 0.79, yOf(0.5))
    ctx.transform(0, 1, 1, 0, 0, 0)
    ctx.font = `900 ${Math.round(h * 0.075)}px 'Titillium Web', 'Segoe UI', Arial, sans-serif`
    ctx.fillText(numText, 0, 0)
    ctx.restore()
    return makeTexture(c, { wrap: THREE.ClampToEdgeWrapping })
  })
}

/** Sidepod livery (same uv convention as the body, no numbers). */
export function podLiveryTexture(teamId: TeamId): THREE.Texture {
  return cached(`pods-${teamId}-${textureScale}`, () => {
    const team = TEAMS[teamId]
    const w = Math.round(1024 * textureScale), h = Math.round(512 * textureScale)
    const { c, ctx } = canvas(w, h)
    paintLiveryBase(ctx, w, h, team)
    // accent on the sidepod top surface, fading into the coke-bottle
    const g = ctx.createLinearGradient(0, 0, w, 0)
    g.addColorStop(0, 'rgba(0,0,0,0)')
    g.addColorStop(0.35, team.accent)
    g.addColorStop(1, team.accent)
    ctx.fillStyle = g
    ctx.fillRect(0, (1 - 0.62) * h, w, 0.24 * h)
    // white pill decal on the flank
    ctx.fillStyle = 'rgba(255,255,255,0.9)'
    ctx.beginPath()
    ctx.ellipse(w * 0.62, (1 - 0.25) * h, w * 0.07, h * 0.03, 0, 0, Math.PI * 2)
    ctx.ellipse(w * 0.62, (1 - 0.75) * h, w * 0.07, h * 0.03, 0, 0, Math.PI * 2)
    ctx.fill()
    return makeTexture(c, { wrap: THREE.ClampToEdgeWrapping })
  })
}

function paintLiveryBase(ctx: CanvasRenderingContext2D, w: number, h: number, team: Team) {
  ctx.fillStyle = team.body
  ctx.fillRect(0, 0, w, h)
  // subtle metallic-flake grain so flat colour doesn't band under the clearcoat
  const n = new Noise2(77)
  const img = ctx.getImageData(0, 0, w, h)
  const d = img.data
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4
      const k = 1 + (n.value(x * 0.8, y * 0.8, 2048, 1024) - 0.5) * 0.07
      d[i] = clamp255(d[i]! * k)
      d[i + 1] = clamp255(d[i + 1]! * k)
      d[i + 2] = clamp255(d[i + 2]! * k)
    }
  }
  ctx.putImageData(img, 0, 0)
  // exposed carbon on the underside
  ctx.fillStyle = '#1b1c1f'
  ctx.fillRect(0, 0, w, 0.1 * h)
  ctx.fillRect(0, 0.9 * h, w, 0.1 * h)
}

function numberContrast(team: Team): string {
  const c = new THREE.Color(team.body)
  const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
  return lum > 0.35 ? '#111111' : '#ffffff'
}

/** Small numbered plate (used for the T-cam / nose plate). */
export function numberTexture(num: number, fg: string, bg: string): THREE.Texture {
  return cached(`num-${num}-${fg}-${bg}`, () => {
    const w = 256, h = 128
    const { c, ctx } = canvas(w, h)
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = fg
    ctx.font = "italic 900 96px 'Titillium Web', 'Segoe UI', Arial, sans-serif"
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(num), w / 2, h / 2 + 4)
    return makeTexture(c, { wrap: THREE.ClampToEdgeWrapping })
  })
}

/** Soft elliptical blob used as a contact shadow under each car. */
/** Very fine, high-frequency normal map used as the clearcoat normal of metallic-flake paint. */
export function flakeNormalMap(): THREE.Texture {
  return cached('flake', () => {
    const w = 256, h = 256
    const n = new Noise2(4242)
    const height = new Float32Array(w * h)
    const rng = mulberry(99)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        height[y * w + x] = n.fbm(x / 2, y / 2, 128, 128, 2, 0.5) * 0.6 + rng() * 0.4
      }
    }
    const tex = normalMapFrom(height, w, h, 1.2)
    tex.repeat.set(60, 60)
    return tex
  })
}

export function contactShadowTexture(): THREE.Texture {
  return cached('contact', () => {
    const w = 256, h = 256
    const { c, ctx } = canvas(w, h)
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2)
    g.addColorStop(0, 'rgba(0,0,0,0.9)')
    g.addColorStop(0.35, 'rgba(0,0,0,0.55)')
    g.addColorStop(0.7, 'rgba(0,0,0,0.1)')
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
    return makeTexture(c, { wrap: THREE.ClampToEdgeWrapping })
  })
}

// ---------------------------------------------------------------------------------------------
// trackside

/** Grandstand seating with individual spectators (tile = ~14 rows). */
export function crowdTexture(): THREE.Texture {
  return cached('crowd', () => {
    const w = 1024, h = 512
    const { c, ctx } = canvas(w, h)
    const rng = mulberry(21)
    ctx.fillStyle = '#4c5158'
    ctx.fillRect(0, 0, w, h)
    const shirts = ['#e63946', '#f1faee', '#a8dadc', '#457b9d', '#1d3557', '#ffb703', '#fb8500', '#2a9d8f', '#e9c46a', '#f4a261', '#222', '#ddd', '#ffffff', '#c0392b', '#3a86ff', '#ff006e', '#8338ec', '#06d6a0']
    const skins = ['#f1c9a5', '#e0ac7e', '#c68642', '#8d5524', '#ffdbac']
    const rowH = 36, seatW = 14
    for (let row = 0; row < h / rowH; row++) {
      const y0 = row * rowH
      // step riser + seat shelf
      ctx.fillStyle = '#3a3e44'
      ctx.fillRect(0, y0, w, 6)
      ctx.fillStyle = row % 2 ? '#5d626a' : '#565b63'
      ctx.fillRect(0, y0 + 6, w, rowH - 6)
      for (let sx = 0; sx < w; sx += seatW) {
        const x0 = sx + rng() * 3
        // empty seat (coloured plastic) or a spectator
        if (rng() < 0.12) {
          ctx.fillStyle = rng() < 0.5 ? '#c8102e' : '#1e3a8a'
          ctx.fillRect(x0 + 2, y0 + 16, seatW - 5, 12)
          continue
        }
        ctx.fillStyle = shirts[Math.floor(rng() * shirts.length)]!
        ctx.beginPath()
        ctx.roundRect(x0 + 1, y0 + 14, seatW - 3, 20, 4)
        ctx.fill()
        ctx.fillStyle = skins[Math.floor(rng() * skins.length)]!
        ctx.beginPath()
        ctx.arc(x0 + seatW / 2 - 0.5, y0 + 10, 4.2, 0, Math.PI * 2)
        ctx.fill()
        if (rng() < 0.25) {
          ctx.fillStyle = rng() < 0.5 ? '#222' : shirts[Math.floor(rng() * shirts.length)]!
          ctx.fillRect(x0 + seatW / 2 - 5, y0 + 5, 9, 4) // cap
        }
      }
      ctx.fillStyle = 'rgba(0,0,0,0.25)'
      ctx.fillRect(0, y0 + rowH - 4, w, 4)
    }
    return makeTexture(c)
  })
}

/** 4×4 atlas of standing/seated spectators (transparent background) for the instanced crowd. */
export function spectatorAtlas(): THREE.Texture {
  return cached('spectators', () => {
    const w = 512, h = 512
    const cell = 128
    const { c, ctx } = canvas(w, h)
    ctx.clearRect(0, 0, w, h)
    const rng = mulberry(1234)
    const shirts = ['#e63946', '#f1faee', '#a8dadc', '#457b9d', '#1d3557', '#ffb703', '#fb8500', '#2a9d8f', '#e9c46a', '#f4a261', '#222', '#ddd', '#ffffff', '#c0392b', '#3a86ff', '#ff006e']
    const skins = ['#f1c9a5', '#e0ac7e', '#c68642', '#8d5524', '#ffdbac']
    const pants = ['#1b1f2a', '#3b4252', '#5c4b37', '#2f3e46', '#6d6875']
    for (let i = 0; i < 16; i++) {
      const x0 = (i % 4) * cell
      const y0 = Math.floor(i / 4) * cell
      const cx = x0 + cell / 2
      const seated = i % 3 !== 0
      // 8 px padding top and bottom of the cell (the billboard uv is inset the same amount) so
      // mip-mapped sampling never bleeds a neighbour's feet into a head
      ctx.save()
      ctx.translate(0, y0 + 8)
      ctx.scale(1, 112 / 128)
      ctx.translate(0, -y0)
      // legs / lower body
      ctx.fillStyle = pants[Math.floor(rng() * pants.length)]!
      if (seated) ctx.fillRect(cx - 22, y0 + 92, 44, 30)
      else {
        ctx.fillRect(cx - 18, y0 + 78, 15, 46)
        ctx.fillRect(cx + 3, y0 + 78, 15, 46)
      }
      // torso
      ctx.fillStyle = shirts[Math.floor(rng() * shirts.length)]!
      ctx.beginPath()
      ctx.roundRect(cx - 24, y0 + 40, 48, 50, 10)
      ctx.fill()
      // arms (one raised now and then)
      ctx.fillStyle = skins[Math.floor(rng() * skins.length)]!
      const raised = rng() < 0.2
      ctx.fillRect(cx - 34, raised ? y0 + 8 : y0 + 44, 10, raised ? 40 : 36)
      ctx.fillRect(cx + 24, y0 + 44, 10, 36)
      // head
      ctx.beginPath()
      ctx.arc(cx, y0 + 26, 14, 0, Math.PI * 2)
      ctx.fill()
      if (rng() < 0.35) {
        ctx.fillStyle = rng() < 0.5 ? '#222' : shirts[Math.floor(rng() * shirts.length)]!
        ctx.fillRect(cx - 16, y0 + 10, 32, 8)
      }
      // hair
      ctx.fillStyle = ['#2b1d12', '#0d0d0d', '#8a5a2b', '#d9c19a'][Math.floor(rng() * 4)]!
      ctx.beginPath()
      ctx.arc(cx, y0 + 20, 13, Math.PI, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }
    const tex = makeTexture(c, { wrap: THREE.ClampToEdgeWrapping })
    tex.flipY = true
    return tex
  })
}

/** Pit building façade: 11 garages with team-coloured fascias, one texture spans the whole building. */
export function garageTexture(): THREE.Texture {
  return cached('garage', () => {
    const w = 2048, h = 256
    const { c, ctx } = canvas(w, h)
    ctx.fillStyle = '#cfd3d6'
    ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = '#9ea3a8'
    ctx.fillRect(0, 0, w, 14)
    ctx.fillStyle = '#2b2f36'
    ctx.fillRect(0, 14, w, 26)
    const teams = Object.values(TEAMS)
    const slot = w / teams.length
    teams.forEach((team, i) => {
      const x = i * slot
      // fascia in team colours
      ctx.fillStyle = team.body
      ctx.fillRect(x + 6, 46, slot - 12, 34)
      ctx.fillStyle = team.accent
      ctx.fillRect(x + 6, 76, slot - 12, 6)
      ctx.fillStyle = '#ffffff'
      ctx.font = "700 22px 'Titillium Web', 'Segoe UI', Arial, sans-serif"
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = numberContrast(team)
      ctx.fillText(team.name.toUpperCase(), x + slot / 2, 63)
      // two garage bays, doors up: dark interior with a lit floor
      for (const bx of [x + 14, x + slot / 2 + 4]) {
        const bw = slot / 2 - 18
        const g = ctx.createLinearGradient(0, 90, 0, h)
        g.addColorStop(0, '#15171b')
        g.addColorStop(0.7, '#2a2d33')
        g.addColorStop(1, '#8b8f94')
        ctx.fillStyle = g
        ctx.fillRect(bx, 90, bw, h - 90)
        ctx.fillStyle = 'rgba(255,255,255,0.08)'
        for (let y = 96; y < h; y += 14) ctx.fillRect(bx, y, bw, 2)
        ctx.fillStyle = team.accent
        ctx.fillRect(bx + 4, 120, bw - 8, 3)
      }
      ctx.fillStyle = '#b6babe'
      ctx.fillRect(x + slot / 2 - 4, 90, 8, h - 90) // pillar
    })
    return makeTexture(c, { wrap: THREE.ClampToEdgeWrapping })
  })
}

/** Galvanised Armco: horizontal W-beam corrugation with bolt heads; tiles every 4 m along u. */
export function armcoMaps(): MaterialMaps {
  return cached('armco', () => {
    const w = 512, h = 128
    const n = new Noise2(77)
    const height = new Float32Array(w * h)
    const map = paint(w, h, (x, y, out) => {
      const v = y / h
      // two ridges (W profile) with flat bands between
      const ridge = Math.max(0, Math.cos((v - 0.3) * Math.PI * 2 * 1.6)) ** 1.5 * 0.7 + Math.max(0, Math.cos((v - 0.72) * Math.PI * 2 * 1.6)) ** 1.5 * 0.7
      const bolt = ((x % 128) - 64) ** 2 + (y - h * 0.5) ** 2 < 36 ? 1 : 0
      const seam = x % 128 < 3 ? -0.5 : 0
      const grain = n.fbm(x / 6, y / 6, 64, 16, 3) - 0.5
      height[y * w + x] = ridge * 0.6 + bolt * 0.5 + seam + grain * 0.1
      const shade = 150 + ridge * 30 + grain * 40 + bolt * 40 + seam * 60
      out[0] = shade
      out[1] = shade + 3
      out[2] = shade + 8
    })
    return { map: makeTexture(map), normalMap: normalMapFrom(height, w, h, 3.0) }
  })
}

/** Chain-link debris fence: transparent diamonds on a 64² tile (≈ 20 cm). */
export function chainLinkTexture(): THREE.Texture {
  return cached('chainlink', () => {
    const w = 64, h = 64
    const { c, ctx } = canvas(w, h)
    ctx.clearRect(0, 0, w, h)
    ctx.strokeStyle = '#b9bcc0'
    ctx.lineWidth = 3
    ctx.beginPath()
    for (let i = -1; i <= 1; i++) {
      ctx.moveTo(i * w, 0)
      ctx.lineTo(i * w + w, h)
      ctx.moveTo(i * w + w, 0)
      ctx.lineTo(i * w, h)
    }
    ctx.stroke()
    const tex = makeTexture(c)
    tex.minFilter = THREE.LinearMipmapLinearFilter
    return tex
  })
}

/** Tyre barrier front: three rows of stacked tyres behind a white conveyor-belt cover; tiles every 0.66 m along u. */
export function tyreWallTexture(): THREE.Texture {
  return cached('tyrewall', () => {
    const w = 128, h = 384
    const { c, ctx } = canvas(w, h)
    ctx.fillStyle = '#141416'
    ctx.fillRect(0, 0, w, h)
    for (let row = 0; row < 3; row++) {
      const cy = h - row * 128 - 64
      const cx = w / 2 + (row % 2 ? 0 : 0)
      const g = ctx.createRadialGradient(cx, cy, 20, cx, cy, 62)
      g.addColorStop(0, '#0a0a0b')
      g.addColorStop(0.55, '#2a2b2e')
      g.addColorStop(0.85, '#1c1d20')
      g.addColorStop(1, '#0e0e10')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(cx, cy, 62, 0, Math.PI * 2)
      ctx.fill()
    }
    // conveyor belt over the lower two rows
    ctx.fillStyle = '#e8e8e6'
    ctx.fillRect(0, 128, w, 256)
    ctx.fillStyle = '#c8c8c4'
    ctx.fillRect(0, 128, w, 6)
    ctx.fillRect(0, 250, w, 5)
    ctx.fillStyle = '#c8102e'
    ctx.fillRect(0, 300, w, 40)
    ctx.fillStyle = 'rgba(0,0,0,0.12)'
    ctx.fillRect(w - 3, 128, 3, 256)
    return makeTexture(c)
  })
}

/** TecPro barrier: red and white blocks with the moulded edge lines; one block per 2 m along u. */
export function tecproTexture(): THREE.Texture {
  return cached('tecpro', () => {
    const w = 256, h = 128
    const { c, ctx } = canvas(w, h)
    ctx.fillStyle = '#d61f26'
    ctx.fillRect(0, 0, w / 2, h)
    ctx.fillStyle = '#f3f3f1'
    ctx.fillRect(w / 2, 0, w / 2, h)
    ctx.fillStyle = 'rgba(0,0,0,0.25)'
    for (const x of [0, w / 2]) ctx.fillRect(x, 0, 4, h)
    ctx.fillRect(0, 0, w, 4)
    ctx.fillStyle = 'rgba(255,255,255,0.18)'
    ctx.fillRect(0, h * 0.35, w, 4)
    ctx.fillRect(0, h * 0.7, w, 4)
    return makeTexture(c)
  })
}

/** Text panel (distance boards, sector boards, marshal hut signs). */
export function labelTexture(text: string, bg: string, fg: string, w = 256, h = 256, font = 150): THREE.Texture {
  return cached(`label-${text}-${bg}-${fg}-${w}-${h}`, () => {
    const { c, ctx } = canvas(w, h)
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = fg
    ctx.font = `900 ${font}px 'Titillium Web', 'Segoe UI', Arial, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, w / 2, h / 2 + font * 0.05)
    ctx.strokeStyle = 'rgba(0,0,0,0.35)'
    ctx.lineWidth = 6
    ctx.strokeRect(3, 3, w - 6, h - 6)
    return makeTexture(c, { wrap: THREE.ClampToEdgeWrapping })
  })
}

/** Cumulus layer: tileable FBM coverage with soft edges, transparent elsewhere; fades out towards the horizon (v→0). */
export function cloudTexture(): THREE.Texture {
  return cached(`clouds-${textureScale}`, () => {
    // 2048×1024 with a seventh octave on the high tier, half of that on low
    const big = textureScale >= 1
    const w = big ? 2048 : 1024, h = big ? 1024 : 512
    const k = w / 1024
    const { c, ctx } = canvas(w, h)
    const img = ctx.createImageData(w, h)
    const d = img.data
    const n = new Noise2(2024)
    let i = 0
    for (let y = 0; y < h; y++) {
      // canvas rows run top→bottom; v = 1 at the top (zenith) after the flip on upload
      const v = 1 - y / h
      const horizon = smooth((v - 0.06) / 0.25)
      for (let x = 0; x < w; x++) {
        const f = n.fbm(x / (64 * k), y / (64 * k), 16, 8, big ? 7 : 6, 0.55)
        const cover = smooth((f - 0.52) / 0.16) * horizon
        const shade = 235 + (n.value(x / 30, y / 30, 34, 17) - 0.5) * 40
        d[i] = shade
        d[i + 1] = shade
        d[i + 2] = shade + 6
        d[i + 3] = cover * 255
        i += 4
      }
    }
    ctx.putImageData(img, 0, 0)
    return makeTexture(c)
  })
}

/** Radial flare sprite. */
export function flareTexture(): THREE.Texture {
  return cached('flare', () => {
    const w = 128, h = 128
    const { c, ctx } = canvas(w, h)
    ctx.clearRect(0, 0, w, h)
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2)
    g.addColorStop(0, 'rgba(255,255,255,1)')
    g.addColorStop(0.2, 'rgba(255,255,255,0.55)')
    g.addColorStop(0.5, 'rgba(255,255,255,0.12)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
    return makeTexture(c, { wrap: THREE.ClampToEdgeWrapping })
  })
}

/** Silhouette of a wooded ridge line (opaque below, ragged canopy on top), tiles along u. */
export function treeLineTexture(): THREE.Texture {
  return cached('treeline', () => {
    const w = 1024, h = 128
    const { c, ctx } = canvas(w, h)
    ctx.clearRect(0, 0, w, h)
    const rng = mulberry(55)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, h * 0.55, w, h * 0.45)
    for (let x = 0; x < w; x += 6) {
      const th = 20 + rng() * 45
      ctx.beginPath()
      ctx.arc(x, h * 0.56, th * 0.5, 0, Math.PI * 2)
      ctx.fill()
      ctx.beginPath()
      ctx.moveTo(x - 8, h * 0.6)
      ctx.lineTo(x, h * 0.56 - th)
      ctx.lineTo(x + 8, h * 0.6)
      ctx.fill()
    }
    const tex = makeTexture(c)
    tex.repeat.set(24, 1)
    return tex
  })
}

/** Soft round sprite (alpha in the RGB, additive) for sparks and smoke. */
/**
 * Low-frequency brightness/roughness variation (0.85–1.15 grey) tiled over hundreds of metres
 * by the macro patch in track-mesh.ts, so the 20 m asphalt/grass tiles stop reading as a repeat.
 */
export function macroMap(): THREE.Texture {
  return cached('macro', () => {
    const w = 512, h = 512
    const n = new Noise2(101)
    const c = paint(w, h, (x, y, out) => {
      const f = n.fbm(x / 64, y / 64, 8, 8, 4, 0.55)
      const v = (0.85 + 0.3 * f) * 255 * 0.8
      out[0] = v
      out[1] = v
      out[2] = v
    })
    return makeTexture(c, { srgb: false })
  })
}

/** Streak profile of a skid mark: u across the tyre (tread grooves), v along it (broken by noise). */
export function skidTexture(): THREE.Texture {
  return cached('skid', () => {
    const w = 128, h = 512
    const n = new Noise2(313)
    const c = paint(w, h, (x, y, out) => {
      const u = x / w
      const groove = 1 - 0.35 * Math.pow(Math.max(0, Math.cos(u * Math.PI * 2 * 5)), 8)
      const nse = n.fbm(x / 8, y / 32, 16, 16, 3, 0.55)
      const a = Math.min(1, groove * (0.45 + nse * 0.9)) * 255
      out[0] = a
      out[1] = a
      out[2] = a
    })
    return makeTexture(c, { srgb: false })
  })
}

/**
 * Particle sprites. Sparks: one radial core (64×64). Smoke: a 3×1 strip (192×64) of three
 * differently shaped puffs; the particle shader picks a cell per particle.
 */
export function spriteTexture(kind: 'spark' | 'smoke'): THREE.Texture {
  return cached(`sprite-${kind}`, () => {
    if (kind === 'spark') {
      const w = 64, h = 64
      const { c, ctx } = canvas(w, h)
      ctx.clearRect(0, 0, w, h)
      const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2)
      g.addColorStop(0, 'rgba(255,255,255,1)')
      g.addColorStop(0.25, 'rgba(255,255,255,0.8)')
      g.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, w, h)
      return makeTexture(c, { wrap: THREE.ClampToEdgeWrapping })
    }
    const cell = 64, w = cell * 3, h = cell
    const { c, ctx } = canvas(w, h)
    ctx.clearRect(0, 0, w, h)
    const rng = mulberry(77)
    for (let k = 0; k < 3; k++) {
      // a soft core plus a few offset lobes: three distinct puff silhouettes
      const cx = k * cell + cell / 2, cy = cell / 2
      const lobes = 3 + k
      for (let l = 0; l < lobes; l++) {
        const a = (l / lobes) * Math.PI * 2 + rng() * 0.8
        const r = cell * (0.12 + rng() * 0.1)
        const ox = Math.cos(a) * r, oy = Math.sin(a) * r
        const g = ctx.createRadialGradient(cx + ox, cy + oy, 0, cx + ox, cy + oy, cell * 0.3)
        g.addColorStop(0, 'rgba(255,255,255,0.32)')
        g.addColorStop(0.55, 'rgba(255,255,255,0.14)')
        g.addColorStop(1, 'rgba(255,255,255,0)')
        ctx.fillStyle = g
        ctx.fillRect(k * cell, 0, cell, cell)
      }
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, cell * 0.48)
      g.addColorStop(0, 'rgba(255,255,255,0.4)')
      g.addColorStop(0.5, 'rgba(255,255,255,0.18)')
      g.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = g
      ctx.fillRect(k * cell, 0, cell, cell)
    }
    return makeTexture(c, { wrap: THREE.ClampToEdgeWrapping })
  })
}

/** Dark rubber streaks laid down in a braking zone; u across the track, v along (tiles every 10 m). */
export function brakingRubberTexture(): THREE.Texture {
  return cached('brakingRubber', () => {
    const w = 256, h = 256
    const n = new Noise2(311)
    const c = paint(w, h, (x, y, out) => {
      const u = x / w
      // two streak bands where the tyres run, feathered edges, broken up by noise
      const band = (cu: number) => Math.exp(-0.5 * ((u - cu) / 0.045) ** 2)
      const streaks = band(0.34) + band(0.44) + band(0.56) + band(0.66)
      const nse = n.fbm(x / 10, y / 40, 25, 6, 3)
      const a = Math.min(1, streaks * (0.5 + nse * 0.8)) * 255
      out[0] = a
      out[1] = a
      out[2] = a
    })
    return makeTexture(c, { srgb: false })
  })
}

export function boardTexture(): THREE.Texture {
  return cached('board', () => {
    const w = 2048, h = 128
    const { c, ctx } = canvas(w, h)
    const colors = ['#0b2545', '#c8102e', '#ffffff', '#1f7a3f', '#111111', '#f2c300', '#003b95', '#e10600']
    const text = ['SUZUKA', 'JAPANESE GP', 'ROUND 17', 'SUZUKA CIRCUIT', 'F1 LIVE', 'PIT LANE', 'MOBILITY RESORT', '2026']
    for (let i = 0; i < 8; i++) {
      ctx.fillStyle = colors[i % colors.length]!
      ctx.fillRect(i * 256, 0, 256, h)
      ctx.fillStyle = i === 2 || i === 5 ? '#111' : '#fff'
      ctx.font = "900 44px 'Titillium Web', 'Segoe UI', Arial, sans-serif"
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(text[i]!, i * 256 + 128, h / 2)
      ctx.fillStyle = 'rgba(0,0,0,0.25)'
      ctx.fillRect(i * 256, 0, 3, h)
    }
    return makeTexture(c)
  })
}

// ---------------------------------------------------------------------------------------------
// brake disc (cluster A / A10)

/**
 * Carbon-carbon brake disc as a polar strip: u around the disc, v along the lathe profile —
 * [0, 0.25] inboard face (radial, bore → rim), [0.25, 0.5] outer barrel, [0.5, 0.75] outboard
 * face (rim → bore), [0.75, 1] bore. The emissive map carries the friction ring (the faces
 * glow, the bore does not) with vane and hot-spot modulation so a hot disc reads as a ring
 * of uneven heat rather than a flat orange puck.
 */
export function brakeDiscMaps(): MaterialMaps & { emissiveMap: THREE.Texture } {
  return cached('brake-disc', () => {
    const w = 256, h = 64
    const n = new Noise2(97)
    const rough = new Float32Array(w * h)
    const emis = new Float32Array(w * h)
    const c = paint(w, h, (x, y, out) => {
      const u = x / w, v = 1 - y / h
      const band = Math.floor(v * 4) // 0 inboard face, 1 barrel, 2 outboard face, 3 bore
      const t = v * 4 - band
      // radial coordinate on the faces (0 bore → 1 rim); the inboard face runs bore → rim, the outboard rim → bore
      const rad = band === 0 ? t : band === 2 ? 1 - t : band === 1 ? 1 : 0
      const vane = 0.5 + 0.5 * Math.cos(u * Math.PI * 2 * 48)
      // drill holes on the faces: 24 around, on a ring at ~65 % radius
      const hole = band === 0 || band === 2 ? (0.5 + 0.5 * Math.cos(u * Math.PI * 2 * 24)) > 0.985 && Math.abs(rad - 0.65) < 0.05 ? 1 : 0 : 0
      const grain = (n.fbm(x / 8, y / 4, 32, 16, 3) - 0.5) * 16
      let g = 40 + grain + (band === 1 ? -6 * (1 - vane) : 0) // dark carbon grey, vane shading on the barrel
      if (hole) g = 12
      out[0] = g
      out[1] = g + 1
      out[2] = g + 3
      const ring = band === 1 ? 0.8 : band === 3 ? 0 : smooth((rad - 0.3) / 0.05) * (1 - smooth((rad - 0.95) / 0.04))
      const spots = 0.75 + 0.25 * n.fbm(u * 8, v * 4, 8, 4, 3)
      emis[y * w + x] = Math.min(1, ring * (0.85 + 0.15 * vane) * spots) * (hole ? 0 : 1)
      rough[y * w + x] = 0.55 + 0.15 * n.value(x / 8, y / 4, 32, 16)
    })
    return { map: makeTexture(c), roughnessMap: grayMap(rough, w, h), emissiveMap: grayMap(emis, w, h) }
  })
}
