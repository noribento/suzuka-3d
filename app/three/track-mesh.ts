import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { APEX_SPEED_TARGETS, CIRCUIT, SAUSAGE_KERB_CORNERS } from '~/data/suzuka'
import { garageS, PAINTED_APRONS, RUNOFF_ZONES, type Side } from '~/data/suzuka-facilities-spec'
import { forwardDelta, type Track } from '~/sim/track'
import { APRON_TILE_M, APRON_UV, ASPHALT_DETAIL_M, ASPHALT_LINE_FRAC, ASPHALT_TILE_M, ASPHALT_WIDTH_M, apronPaintTexture, asphaltDetailMaps, asphaltMaps, boardTexture, concreteMaps, gravelMaps, kerbMaps, macroMap, type MaterialMaps } from './textures'
import { FLAT_STRIP, RUNOFF_LIFT, RUNOFF_WIDTH, STRIP_DROP, type Ground } from './ground'
import { grassSurfaceMaterial, pbrFromAssets, repeatMetres, tileMetres } from './materials'
import type { Terrain } from './environment'

type Fn = (s: number) => number

const _p = new THREE.Vector3()

/**
 * Ribbon following the track between s0 and s1 (forward), with per-edge lateral
 * offsets and heights. UV: u across (0..1), v along (s / vScale).
 */
export function ribbonGeometry(
  track: Track,
  s0: number,
  s1: number,
  leftLat: Fn,
  rightLat: Fn,
  leftY: Fn,
  rightY: Fn,
  step = 2,
  vScale = 10,
  uAcross = 1,
): THREE.BufferGeometry {
  const len = s0 === s1 ? track.length : forwardDelta(s0, s1, track.length) || track.length
  const segs = Math.max(1, Math.ceil(len / step))
  const pos: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  for (let i = 0; i <= segs; i++) {
    const d = (i / segs) * len
    const s = s0 + d
    track.pointAt(s, leftLat(s), _p, leftY(s))
    pos.push(_p.x, _p.y, _p.z)
    track.pointAt(s, rightLat(s), _p, rightY(s))
    pos.push(_p.x, _p.y, _p.z)
    const v = d / vScale
    uv.push(0, v, uAcross, v)
    if (i < segs) {
      const a = i * 2
      // counter-clockwise seen from above (+Y) so the surface is front-facing
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

/**
 * Ribbon with an arbitrary cross-section: `edges` lists (lateral, height) functions from
 * one side to the other; u runs 0..1 across the edges (or `uAt[e]` when given — a constant per
 * edge, or a function of the edge index and s for cross-sections whose edges move with s),
 * v = s / vScale. Edges must be ordered right-to-left (increasing lateral) for the surface to
 * face up. Edges may coincide (zero-width quads): the degenerate triangles cost nothing and
 * contribute no normal.
 */
export function profileRibbonGeometry(track: Track, s0: number, s1: number, edges: [Fn, Fn][], step = 1, vScale = 2, uAt?: number[] | ((e: number, s: number) => number)): THREE.BufferGeometry {
  const len = forwardDelta(s0, s1, track.length) || track.length
  const segs = Math.max(1, Math.ceil(len / step))
  const E = edges.length
  const pos: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  for (let i = 0; i <= segs; i++) {
    const d = (i / segs) * len
    const s = s0 + d
    for (let e = 0; e < E; e++) {
      const [lat, y] = edges[e]!
      track.pointAt(s, lat(s), _p, y(s))
      pos.push(_p.x, _p.y, _p.z)
      uv.push(uAt ? (typeof uAt === 'function' ? uAt(e, s) : uAt[e]!) : e / (E - 1), d / vScale)
    }
    if (i < segs) {
      for (let e = 0; e < E - 1; e++) {
        const a = i * E + e
        // (forward, then across towards +lateral) is counter-clockwise seen from above
        idx.push(a, a + E, a + 1, a + 1, a + E, a + E + 1)
      }
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

/** Vertical wall along a lateral offset, from yBottom(s) to yTop(s) (both relative to track height). */
/**
 * Vertical strip along the track between two height functions. `vScale` is metres per texture
 * tile along the wall; `uScale` (optional) is metres per tile up the wall — without it one tile
 * spans the whole height.
 */
export function wallGeometry(track: Track, s0: number, s1: number, lat: Fn, yBottom: Fn, yTop: Fn, step = 4, vScale = 8, uScale?: number): THREE.BufferGeometry {
  const len = forwardDelta(s0, s1, track.length) || track.length
  const segs = Math.max(1, Math.ceil(len / step))
  const pos: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  for (let i = 0; i <= segs; i++) {
    const d = (i / segs) * len
    const s = s0 + d
    track.pointAt(s, lat(s), _p, yBottom(s))
    pos.push(_p.x, _p.y, _p.z)
    track.pointAt(s, lat(s), _p, yTop(s))
    pos.push(_p.x, _p.y, _p.z)
    const vTop = uScale ? (yTop(s) - yBottom(s)) / uScale : 1
    uv.push(d / vScale, 0, d / vScale, vTop)
    if (i < segs) {
      const a = i * 2
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

/**
 * Macro variation: a second, very low-frequency texture modulates albedo (×0.85–1.15 → the
 * map stores 0.68–0.92, rescaled here) and roughness so a tiling surface stops repeating.
 * `scale` maps the material's uv into the macro texture (one macro period per 1/scale uv
 * units). Installed as an onBeforeCompile patch; setupMaterials chains it under CSM.
 */
export function addMacro(mat: THREE.MeshStandardMaterial, scale: THREE.Vector2, stripes = 0) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uMacro = { value: macroMap() }
    shader.uniforms.uMacroScale = { value: scale }
    shader.uniforms.uStripes = { value: stripes }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uMacro;
        uniform vec2 uMacroScale;
        uniform float uStripes;`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        float macro = texture2D(uMacro, vMapUv * uMacroScale).r * 1.25;
        diffuseColor.rgb *= macro;
        // mown bands: four per texture tile along v, alternately darker / lighter
        diffuseColor.rgb *= mix(1.0, mod(floor(vMapUv.y * 4.0), 2.0) < 0.5 ? 0.86 : 1.06, uStripes);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor *= mix(0.92, 1.08, clamp((macro - 0.85) / 0.3, 0.0, 1.0));`)
  }
  mat.customProgramCacheKey = () => 'macro'
}

/**
 * The asphalt surface: macro variation (as addMacro) plus the isotropic detail tile that carries
 * the aggregate the base map no longer can (see asphaltDetailMaps).
 *
 * The detail layer is sampled in METRIC uv — `vMapUv` scaled by the road's real size over the
 * detail tile's — so the grain keeps its physical size regardless of the base tile's anisotropic
 * texel budget. Its albedo term has mean 1.0 and its normal mean flat, so both simply cease to
 * exist under minification; there is deliberately no distance fade to maintain.
 *
 * This needs its OWN program cache key: addMacro hands out 'macro' to the road, the pit lane, the
 * verge grass and the terrain, and a shared key would let the grass be handed the road's program.
 */
export function addRoadSurface(mat: THREE.MeshStandardMaterial, macroScale: THREE.Vector2, uWidthM = ASPHALT_WIDTH_M) {
  const detail = asphaltDetailMaps()
  const detailScale = new THREE.Vector2(uWidthM / ASPHALT_DETAIL_M, ASPHALT_TILE_M / ASPHALT_DETAIL_M)
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uMacro = { value: macroMap() }
    shader.uniforms.uMacroScale = { value: macroScale }
    shader.uniforms.uDetail = { value: detail.map }
    shader.uniforms.uDetailNormal = { value: detail.normalMap! }
    shader.uniforms.uDetailScale = { value: detailScale }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uMacro;
        uniform vec2 uMacroScale;
        uniform sampler2D uDetail;
        uniform sampler2D uDetailNormal;
        uniform vec2 uDetailScale;`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        float macro = texture2D(uMacro, vMapUv * uMacroScale).r * 1.25;
        // mean-1.0 multiplier: its mips converge to 1.0, so the grain fades out on its own
        diffuseColor.rgb *= macro * (texture2D(uDetail, vMapUv * uDetailScale).r * 2.0);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor *= mix(0.92, 1.08, clamp((macro - 0.85) / 0.3, 0.0, 1.0));`)
      // Perturb AFTER the chunk rather than inside it: onBeforeCompile sees `#include` directives
      // (resolveIncludes runs later), and appending keeps this independent of the chunk's internals.
      // `mapN` and `tbn` are both declared in main()'s scope by normal_fragment_begin /
      // normal_fragment_maps, under exactly this define.
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        #ifdef USE_NORMALMAP_TANGENTSPACE
          mapN.xy += texture2D(uDetailNormal, vMapUv * uDetailScale).xy * 2.0 - 1.0;
          normal = normalize(tbn * mapN);
        #endif`)
    if (!shader.fragmentShader.includes('uDetailNormal, vMapUv')) {
      // a three upgrade that renamed the chunk would silently drop the aggregate; the e2e suite
      // fails on console.error, so this cannot ship unnoticed
      console.error('normal_fragment_maps not found: the asphalt detail normal was not applied')
    }
  }
  mat.customProgramCacheKey = () => 'macro|road'
}

function pbr(maps: MaterialMaps, extra: THREE.MeshStandardMaterialParameters = {}, normalScale = 1): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ map: maps.map, roughness: 1, metalness: 0, ...extra })
  if (maps.normalMap) {
    m.normalMap = maps.normalMap
    m.normalScale.set(normalScale, normalScale)
  }
  if (maps.roughnessMap) m.roughnessMap = maps.roughnessMap
  return m
}

// ---------------------------------------------------------------------------------------------
// run-off layout from RUNOFF_ZONES

/** Furthest the OSM bands reach from the centreline; the gravel geometry stops here. */
const RUNOFF_MAX_LAT = 55
/** An asphalt band narrower than this beyond the road edge is registration noise, not a surface. */
const ASPHALT_MIN_W = 0.5
/** Gravel starts behind the kerb line (as it always did), never in the flat strip's first metre. */
const GRAVEL_INNER = 1.4
/** Zone boundaries are blended over this many metres so adjacent tables never step. */
const BAND_SMOOTH_M = 16

export interface RunoffLayout {
  /** outer edge (m from the centreline, ≥ the local half-width) of the asphalt run-off on `side` */
  asphaltOuter: (s: number, side: Side) => number
  /** gravel band [inner, outer] (m from the centreline) on `side`, or null where there is none */
  gravel: (s: number, side: Side) => [number, number] | null
}

export interface GravelRun {
  from: number
  to: number
  side: Side
  /** widest outer edge of the trap, metres beyond the road edge (for the barrier line) */
  outer: number
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
    // advance to the next NaN run starting after i
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

function buildLayout(track: Track): { layout: RunoffLayout; runs: GravelRun[] } {
  const L = track.length
  const N = Math.ceil(L)
  // per side, per metre of s: asphalt outer edge, gravel inner edge, gravel width; NaN = not
  // covered by any zone (the gaps between corners), interpolated afterwards
  const table = () => ({ a: new Float32Array(N).fill(NaN), gi: new Float32Array(N).fill(NaN), gw: new Float32Array(N).fill(NaN) })
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
        } else t.gw[i] = 0 // the inner edge stays NaN → borrowed from the neighbours (width 0 anyway)
      }
    }
  }
  const smoothed = (side: Side) => {
    const t = tab(side)
    fillGaps(t.a, 0)
    fillGaps(t.gi, 12)
    fillGaps(t.gw, 0)
    const r = Math.round(BAND_SMOOTH_M / 2)
    return { a: smoothCircular(t.a, r), gi: smoothCircular(t.gi, r), gw: smoothCircular(t.gw, r) }
  }
  const S = { left: smoothed(1), right: smoothed(-1) }
  const at = (arr: Float32Array, s: number): number => {
    const x = track.wrap(s)
    const i = Math.floor(x) % N
    const f = x - Math.floor(x)
    return arr[i]! * (1 - f) + arr[(i + 1) % N]! * f
  }
  const asphaltOuter = (s: number, side: Side): number => {
    const hw = track.halfWidthAt(s)
    const a = at((side > 0 ? S.left : S.right).a, s)
    return a >= hw + ASPHALT_MIN_W ? Math.min(a, hw + RUNOFF_MAX_LAT) : hw
  }
  const gravel = (s: number, side: Side): [number, number] | null => {
    const hw = track.halfWidthAt(s)
    const t = side > 0 ? S.left : S.right
    const giRaw = at(t.gi, s)
    const outer = Math.min(giRaw + at(t.gw, s), RUNOFF_MAX_LAT)
    const inner = Math.max(giRaw, hw + GRAVEL_INNER, asphaltOuter(s, side))
    return outer - inner > 0.3 ? [inner, outer] : null
  }
  // contiguous traps per side (1 m scan, circular), gaps under 8 m bridged, stubs dropped
  const runs: GravelRun[] = []
  for (const side of [1, -1] as const) {
    const present = new Uint8Array(N)
    const outerAt = new Float32Array(N)
    for (let i = 0; i < N; i++) {
      const g = gravel(i, side)
      if (g) {
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
  return { layout: { asphaltOuter, gravel }, runs }
}

// ---------------------------------------------------------------------------------------------

export interface TrackMeshes {
  group: THREE.Group
  surface: THREE.Mesh
  startLampMaterials: THREE.MeshStandardMaterial[]
}

/** Cross-section sample offsets (m beyond the asphalt edge) of the draped run-off ribbons. */
const RUNOFF_OFFSETS = [0, FLAT_STRIP, 3.5, 5.5, 8, 11, 14.5, 18.5, 23, 28, RUNOFF_WIDTH]
/** Metres one uv unit of the grass run-off spans (the terrain uses 9 too, so both share the tile scale). */
const GRASS_UV_M = 9
/** Decals sit this far above the surface they are painted on (plus polygon offset). */
const DECAL_LIFT = 0.006
/**
 * Bright green painted strips just outside the kerb line where the photos show them (§2b:
 * off_b2_main — both sides of T1–T2; the pit exit; T18). Extents UNVERIFIED, read off the photos.
 */
const GREEN_STRIPS: { from: number; to: number; side: Side }[] = [
  { from: 440, to: 700, side: 1 },
  { from: 470, to: 640, side: -1 },
  { from: 190, to: 375, side: -1 },
  { from: 5290, to: 5420, side: 1 },
]
const GREEN_STRIP_W = 1.2

export function buildTrackMeshes(track: Track, terrain: Terrain, ground: Ground): TrackMeshes {
  const group = new THREE.Group()
  const assets = terrain.assets
  /** local half-width — the road narrows to ~10.5 m at the Degners and widens to 15 m on the pit straight */
  const hwAt: Fn = (s) => track.halfWidthAt(s)
  const hw = track.halfWidth
  const L = track.length
  const zero: Fn = () => 0
  const cross = track.crossing
  const groundHeightAt = (x: number, z: number) => terrain.heightAt(x, z)
  /** surfaces the terrain mesh must stay underneath */
  const groundGeos: THREE.BufferGeometry[] = []
  const layout = runoffLayout(track)
  /** outer edge of the asphalt run-off, never beyond the draped verge (the bridge deck narrows it) */
  const aOut = (s: number, side: Side) => Math.min(layout.asphaltOuter(s, side), hwAt(s) + ground.runoffWidth(s))
  /** gravel band on `side`, narrowed with the verge near the bridge */
  const gravelAt = (s: number, side: Side): [number, number] | null => {
    const g = layout.gravel(s, side)
    if (!g) return null
    const outer = Math.min(g[1], hwAt(s) + (ground.runoffWidth(s) * RUNOFF_MAX_LAT) / RUNOFF_WIDTH)
    return outer - g[0] > 0.3 ? [g[0], outer] : null
  }
  /** height of the ground surface at (s, lat) relative to the road plane: the asphalt run-off where there is one, the grass otherwise */
  const surfaceY = (s: number, lat: number, side: Side): number => {
    const off = Math.abs(lat) - hwAt(s)
    const onAsphalt = Math.abs(lat) < aOut(s, side) - 1e-3
    if (off <= FLAT_STRIP + 1e-3) return STRIP_DROP + (onAsphalt ? 0.01 : 0)
    return ground.yAt(s, lat) + (onAsphalt ? 0.01 : 0)
  }

  // --- asphalt (the cross-slope is applied inside track.pointAt) -----------------------
  // normalScale 1: the old 0.7 is folded into the generated normals (see asphaltMaps)
  const asphaltMat = pbr(asphaltMaps(true), {}, 1)
  // one macro period across the road and every 300 m along it (the base tile is 20 m)
  addRoadSurface(asphaltMat, new THREE.Vector2(1, ASPHALT_TILE_M / 300))
  const surface = new THREE.Mesh(ribbonGeometry(track, 0, 0, hwAt, (s) => -hwAt(s), zero, zero, 2, 20), asphaltMat)
  surface.name = 'asphalt'
  surface.receiveShadow = true
  group.add(surface)
  groundGeos.push(surface.geometry)

  // --- run-off, per RUNOFF_ZONES: asphalt band → gravel → grass ("half and half") ------------
  // The grass ribbon covers the whole verge (a flat strip under the kerbs, then draped over the
  // terrain — see ground.ts) except where the asphalt band is: its inner edges collapse onto the
  // asphalt's outer edge, so the two never overlap. Macro / green-up periods as before (34 m
  // across, 120 m along); u is metres from the road edge so the tile stays registered to it.
  const grassMat = grassSurfaceMaterial(assets, [GRASS_UV_M, GRASS_UV_M], [RUNOFF_WIDTH, 120], 0.8)
  const runoffGeo = (side: Side) => {
    const lats = RUNOFF_OFFSETS.map((off): Fn => (s) => side * Math.max(aOut(s, side), hwAt(s) + (off * ground.runoffWidth(s)) / RUNOFF_WIDTH))
    const edges: [Fn, Fn][] = lats.map((lat) => [lat, (s) => ground.yAt(s, lat(s))])
    const u = (e: number, s: number) => (Math.abs(lats[e]!(s)) - hwAt(s)) / GRASS_UV_M
    // edges must run right-to-left (increasing lateral)
    if (side < 0) {
      edges.reverse()
      return profileRibbonGeometry(track, 0, 0, edges, 4, GRASS_UV_M, (e, s) => u(edges.length - 1 - e, s))
    }
    return profileRibbonGeometry(track, 0, 0, edges, 4, GRASS_UV_M, u)
  }
  const runoffL = new THREE.Mesh(runoffGeo(1), grassMat)
  const runoffR = new THREE.Mesh(runoffGeo(-1), grassMat)
  runoffL.receiveShadow = runoffR.receiveShadow = true
  runoffL.name = 'runoffL'
  runoffR.name = 'runoffR'
  group.add(runoffL, runoffR)
  groundGeos.push(runoffL.geometry, runoffR.geometry)

  // asphalt run-off: the unlined tile (repeating across), 1 cm proud of the grass plane so the
  // seam at its outer edge reads as a kerb-less lip; edges collapse onto the band's outer edge
  const runoffAsphaltMat = pbr(asphaltMaps(false), {}, 1)
  addRoadSurface(runoffAsphaltMat, new THREE.Vector2(1, ASPHALT_TILE_M / 300))
  const runoffAsphaltGeo = (side: Side) => {
    const lats = RUNOFF_OFFSETS.map((off): Fn => (s) => side * Math.min(aOut(s, side), hwAt(s) + (off * ground.runoffWidth(s)) / RUNOFF_WIDTH))
    const edges: [Fn, Fn][] = lats.map((lat) => [lat, (s) => surfaceY(s, lat(s), side)])
    const u = (e: number, s: number) => (Math.abs(lats[e]!(s)) - hwAt(s)) / ASPHALT_WIDTH_M
    if (side < 0) {
      edges.reverse()
      return profileRibbonGeometry(track, 0, 0, edges, 4, ASPHALT_TILE_M, (e, s) => u(edges.length - 1 - e, s))
    }
    return profileRibbonGeometry(track, 0, 0, edges, 4, ASPHALT_TILE_M, u)
  }
  const runoffAsphaltL = new THREE.Mesh(runoffAsphaltGeo(1), runoffAsphaltMat)
  const runoffAsphaltR = new THREE.Mesh(runoffAsphaltGeo(-1), runoffAsphaltMat)
  runoffAsphaltL.receiveShadow = runoffAsphaltR.receiveShadow = true
  runoffAsphaltL.name = 'runoffAsphaltL'
  runoffAsphaltR.name = 'runoffAsphaltR'
  group.add(runoffAsphaltL, runoffAsphaltR)
  groundGeos.push(runoffAsphaltL.geometry, runoffAsphaltR.geometry)

  // --- kerbs per corner ---------------------------------------------------------------------
  const kerbMat = pbr(kerbMaps(), { roughness: 0.75 }, 0.9)
  const kerbGeos: THREE.BufferGeometry[] = []
  const kerbSpansBuilt: { from: number; to: number; side: Side; width: number }[] = []
  const sausageSpots: { s: number; side: 1 | -1 }[] = []
  const pit = CIRCUIT.pit
  // no kerbs on the right where the pit lane joins and leaves the track
  const kerbSpans = (from: number, to: number, side: 1 | -1): [number, number][] =>
    side < 0 ? subtractInterval(from, to, pit.entryS - 4, pit.exitS + 4, L) : [[from, to]]
  const addKerb = (a: number, b: number, side: Side, width: number) => {
    kerbGeos.push(kerbProfile(track, a, b, side, width, hwAt))
    kerbSpansBuilt.push({ from: a, to: b, side, width })
  }
  for (const c of track.corners) {
    const from = c.from - 12
    const to = c.to + 12
    const inside = c.sign
    const outside: 1 | -1 = inside > 0 ? -1 : 1
    // inside kerb (1.3 m) and exit kerb (1.0 m) with a real cross-section: a ramp up from the
    // asphalt, a crowned top and a drop into the grass behind
    for (const [a, b] of kerbSpans(from, to, inside)) addKerb(a, b, inside, 1.3)
    const exitFrom = c.apex - 5
    for (const [a, b] of kerbSpans(exitFrom, to + 10, outside)) addKerb(a, b, outside, 1.0)
    const tgt = APEX_SPEED_TARGETS.find((t) => Math.abs(forwardDeltaSigned(t.s, c.apex, L)) < 60)
    if (tgt && SAUSAGE_KERB_CORNERS.includes(tgt.name)) {
      for (let k = 0; k < 6; k++) sausageSpots.push({ s: c.apex + 12 + k * 1.7, side: outside })
    }
  }
  /** width of the kerb on `side` at s (0 where there is none) — the painted strips start behind it */
  const kerbOuterAt = (s: number, side: Side): number => {
    let w = 0
    for (const k of kerbSpansBuilt) if (k.side === side && forwardDelta(k.from, s, L) <= forwardDelta(k.from, k.to, L)) w = Math.max(w, k.width)
    return w
  }
  // one draw call per material for all kerbs
  const kerbs = new THREE.Mesh(mergeGeometries(kerbGeos, false)!, kerbMat)
  kerbs.name = 'kerbs'
  kerbs.receiveShadow = true
  group.add(kerbs)
  // sausage kerbs: yellow blocks behind the exit kerbs of the corners where they are used
  if (sausageSpots.length) {
    const sausageGeo = new RoundedBoxGeometry(0.4, 0.12, 1.3, 2, 0.05)
    const sausageMat = new THREE.MeshStandardMaterial({ color: 0xf2c400, roughness: 0.6 })
    const sausages = new THREE.InstancedMesh(sausageGeo, sausageMat, sausageSpots.length)
    sausages.castShadow = true
    const q = new THREE.Quaternion()
    const mat4 = new THREE.Matrix4()
    sausageSpots.forEach((sp, i) => {
      const h = track.headingAt(sp.s)
      track.pointAt(sp.s, sp.side * (hwAt(sp.s) + 1.25), _p, 0.06)
      q.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(h.tz, 0, -h.tx), new THREE.Vector3(0, 1, 0), new THREE.Vector3(h.tx, 0, h.tz)))
      mat4.compose(_p, q, new THREE.Vector3(1, 1, 1))
      sausages.setMatrixAt(i, mat4)
    })
    sausages.instanceMatrix.needsUpdate = true
    group.add(sausages)
  }

  // --- gravel traps: one ribbon per contiguous run of the table --------------------------------
  // The band [inner, outer] moves with s (the zones taper over BAND_SMOOTH_M), so the cross-
  // section is sampled at fixed fractions of the local width, fine enough (≤ 4 m at the widest
  // trap) to follow the terrain out to 55 m. The trap sits 2 cm proud of the flat strip / the
  // asphalt band and 4 cm above the draped grass further out.
  const gravelMat = pbr(gravelMaps(), {}, 1.0)
  const gravelGeos: THREE.BufferGeometry[] = []
  const GRAVEL_EDGES = 11
  for (const run of gravelRuns(track)) {
    const band = (s: number): [number, number] => gravelAt(s, run.side) ?? [hwAt(s) + GRAVEL_INNER, hwAt(s) + GRAVEL_INNER]
    const lats: Fn[] = []
    for (let k = 0; k < GRAVEL_EDGES; k++) {
      const f = k / (GRAVEL_EDGES - 1)
      lats.push((s) => {
        const [i, o] = band(s)
        return run.side * (i + f * (o - i))
      })
    }
    const edges: [Fn, Fn][] = lats.map((lat) => [
      lat,
      (s) => {
        const l = lat(s)
        const off = Math.abs(l) - hwAt(s)
        return off <= FLAT_STRIP ? 0.02 : ground.yAt(s, l) + 0.04
      },
    ])
    const u = (e: number, s: number) => (Math.abs(lats[e]!(s)) - band(s)[0]) / 3
    if (run.side < 0) {
      edges.reverse()
      gravelGeos.push(profileRibbonGeometry(track, run.from, run.to, edges, 3, 3, (e, s) => u(edges.length - 1 - e, s)))
    } else gravelGeos.push(profileRibbonGeometry(track, run.from, run.to, edges, 3, 3, u))
  }
  if (gravelGeos.length) {
    const gravel = new THREE.Mesh(mergeGeometries(gravelGeos, false)!, gravelMat)
    gravel.name = 'gravel'
    gravel.receiveShadow = true
    group.add(gravel)
    groundGeos.push(gravel.geometry)
  }

  // --- painted aprons and edge strips (PAINTED_APRONS + GREEN_STRIPS) --------------------------
  // Thin decals a few mm above whichever surface they lie on, with the brakingRubber polygon-
  // offset technique (props.ts) against z-fighting; one atlas → one material → one draw call.
  {
    const paintMat = new THREE.MeshStandardMaterial({ map: apronPaintTexture(), roughness: 0.65, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })
    const paintGeos: THREE.BufferGeometry[] = []
    const decal = (from: number, to: number, side: Side, inner: Fn, width: Fn, uRange: readonly [number, number], across: number) => {
      const lats: Fn[] = []
      for (let k = 0; k < across; k++) {
        const f = k / (across - 1)
        lats.push((s) => side * (hwAt(s) + inner(s) + f * width(s)))
      }
      const edges: [Fn, Fn][] = lats.map((lat) => [lat, (s) => surfaceY(s, lat(s), side) + DECAL_LIFT])
      const uAt = lats.map((_l, k) => uRange[0] + (k / (across - 1)) * (uRange[1] - uRange[0]))
      if (side < 0) {
        edges.reverse()
        uAt.reverse()
      }
      paintGeos.push(profileRibbonGeometry(track, from, to, edges, 2, APRON_TILE_M, uAt))
    }
    for (const a of PAINTED_APRONS) {
      const len = forwardDelta(a.sRange[0], a.sRange[1], L)
      // the aprons are polygons, not bands: taper both ends over 8 m
      const width: Fn = (s) => {
        const d = forwardDelta(a.sRange[0], s, L)
        return a.width * Math.min(1, d / 8, (len - d) / 8)
      }
      const uv = a.pattern === 'chevrons' ? APRON_UV.chevrons : APRON_UV.turquoise
      // solid paint: a constant u well inside its region (the taps never reach a neighbour)
      const uRange: readonly [number, number] = a.pattern === 'chevrons' ? uv : [(uv[0] + uv[1]) / 2, (uv[0] + uv[1]) / 2]
      decal(a.sRange[0], a.sRange[1], a.side, (s) => kerbOuterAt(s, a.side) + 0.05, width, uRange, 5)
    }
    for (const g of GREEN_STRIPS) {
      const mid = (APRON_UV.green[0] + APRON_UV.green[1]) / 2
      // behind the kerb where there is one, hard against the edge line otherwise
      decal(g.from, g.to, g.side, (s) => (kerbOuterAt(s, g.side) > 0 ? kerbOuterAt(s, g.side) + 0.05 : 0.1), () => GREEN_STRIP_W, [mid, mid], 2)
    }
    const paint = new THREE.Mesh(mergeGeometries(paintGeos, false)!, paintMat)
    paint.name = 'paintedAprons'
    paint.receiveShadow = true
    paint.renderOrder = 1
    group.add(paint)
  }

  // --- crossover bridge -------------------------------------------------------
  const concrete = pbr(concreteMaps(), { roughness: 0.95, side: THREE.DoubleSide }, 0.6)
  const rail = new THREE.MeshStandardMaterial({ color: 0xd8d8d8, roughness: 0.6, metalness: 0.3, side: THREE.DoubleSide })
  const span = 19
  const approach = 160
  const concreteGeos: THREE.BufferGeometry[] = []
  // deck slab
  concreteGeos.push(ribbonGeometry(track, cross.sOver - span, cross.sOver + span, (s) => hwAt(s) + 1.2, (s) => -hwAt(s) - 1.2, () => -1.3, () => -1.3, 3, 10))
  concreteGeos.push(wallGeometry(track, cross.sOver - span, cross.sOver + span, (s) => hwAt(s) + 1.2, () => -1.3, () => 0.0, 3))
  concreteGeos.push(wallGeometry(track, cross.sOver - span, cross.sOver + span, (s) => -hwAt(s) - 1.2, () => -1.3, () => 0.0, 3))
  // embankments (walls down to the terrain) either side of the span
  for (const [a, b] of [[cross.sOver - approach, cross.sOver - span], [cross.sOver + span, cross.sOver + approach]] as const) {
    for (const side of [1, -1] as const) {
      const lat: Fn = (s) => side * (hwAt(s) + 1.2)
      const bottom: Fn = (s) => {
        track.pointAt(s, lat(s), _p)
        return Math.min(-0.05, groundHeightAt(_p.x, _p.z) - _p.y - 0.4)
      }
      concreteGeos.push(wallGeometry(track, a, b, lat, bottom, () => 0, 4))
    }
    // shoulder strip covering the top edge between asphalt and wall
    concreteGeos.push(ribbonGeometry(track, a, b, (s) => hwAt(s) + 1.2, (s) => -hwAt(s) - 1.2, () => -0.01, () => -0.01, 4, 10))
  }
  // guard rails along the whole elevated section
  const railGeos: THREE.BufferGeometry[] = []
  for (const side of [1, -1] as const) {
    railGeos.push(wallGeometry(track, cross.sOver - approach, cross.sOver + approach, (s) => side * (hwAt(s) + 1.1), () => 0, () => 1.0, 4))
  }
  group.add(new THREE.Mesh(mergeGeometries(railGeos, false)!, rail))
  // piers beside the lower track
  const pierGeo = new THREE.CylinderGeometry(1.4, 1.6, 1, 12)
  const hwUnder = hwAt(cross.sUnder)
  for (const lat of [hwUnder + 5, -hwUnder - 5]) {
    track.pointAt(cross.sUnder, lat, _p)
    const top = cross.yOver - 1.3
    const bottom = groundHeightAt(_p.x, _p.z) - 1
    const g = pierGeo.clone()
    g.scale(1, top - bottom, 1)
    g.translate(_p.x, (top + bottom) / 2, _p.z)
    concreteGeos.push(g)
  }

  // --- pit lane: between the pit wall and the garages, plus the entry / exit roads ----------
  const pitLat = (s: number) => track.pitLateralAt(s) ?? pit.laneOffset
  const halfLane = pit.laneWidth / 2
  // Procedural fallback: the lined asphalt with its u range inset past the painted edge lines
  // (cloned textures share the upload; only the transform differs) — no second asphalt set.
  const proceduralPit = () => {
    const lined = asphaltMaps(true)
    const inset = (t: THREE.Texture) => {
      const c = t.clone()
      c.repeat.set(1 - 2 * ASPHALT_LINE_FRAC, 1)
      c.offset.set(ASPHALT_LINE_FRAC, 0)
      return c
    }
    const m = pbr({ map: inset(lined.map), normalMap: lined.normalMap && inset(lined.normalMap), roughnessMap: lined.roughnessMap && inset(lined.roughnessMap) }, {}, 1)
    addRoadSurface(m, new THREE.Vector2(1, ASPHALT_TILE_M / 300), pit.laneWidth)
    return m
  }
  // The ribbon's uv is the road convention (u unit = ASPHALT_WIDTH_M across, v unit = ASPHALT_TILE_M
  // along). High tier: the asphalt_pit_lane photo tile (2 m) on clones with the repeat that puts
  // it at physical scale, plus the macro variation at the same periods as the track's (one across
  // the lane, 300 m along) — the photo already carries the aggregate the detail layer adds.
  let pitMat: THREE.MeshStandardMaterial
  if (assets && (['diff', 'nor_gl', 'arm'] as const).every((r) => assets.has(`tex/asphalt_pit_lane/${r}`))) {
    pitMat = pbrFromAssets(assets, 'asphalt_pit_lane', { fallback: proceduralPit, ground: true, handBuiltUv: true })
    const tile = tileMetres(assets, 'tex/asphalt_pit_lane/diff', 2)
    const uvM: [number, number] = [ASPHALT_WIDTH_M, ASPHALT_TILE_M]
    pitMat.map = repeatMetres(pitMat.map!.clone(), tile, uvM)
    pitMat.normalMap = repeatMetres(pitMat.normalMap!.clone(), tile, uvM)
    const arm = repeatMetres(pitMat.aoMap!.clone(), tile, uvM)
    pitMat.aoMap = pitMat.roughnessMap = pitMat.metalnessMap = arm
    const rep = pitMat.map.repeat
    addMacro(pitMat, new THREE.Vector2(1 / rep.x, ASPHALT_TILE_M / 300 / rep.y))
  } else pitMat = proceduralPit()
  const pitLane = new THREE.Mesh(ribbonGeometry(track, pit.entryS, pit.exitS, (s) => pitLat(s) + halfLane, (s) => pitLat(s) - halfLane, () => 0.01, () => 0.01, 3, ASPHALT_TILE_M, pit.laneWidth / ASPHALT_WIDTH_M), pitMat)
  pitLane.name = 'pitLane'
  pitLane.receiveShadow = true
  group.add(pitLane)
  groundGeos.push(pitLane.geometry)
  // concrete apron between the pit lane and the garages
  concreteGeos.push(ribbonGeometry(track, pit.limitStartS - 40, pit.limitEndS, () => pit.laneOffset - halfLane + 0.2, () => pit.garageFront + 0.4, () => 0.01, () => 0.01, 4, 4))
  // all painted white lines (pit limits, pit boxes, grid slots, start line) share one mesh
  const whiteGeos: THREE.BufferGeometry[] = []
  for (const s of [pit.limitStartS, pit.limitEndS]) {
    whiteGeos.push(ribbonGeometry(track, s, s + 0.6, (ss) => pitLat(ss) + halfLane, (ss) => pitLat(ss) - halfLane, () => 0.03, () => 0.03, 1, 1))
  }
  // fast lane / working lane divider
  whiteGeos.push(ribbonGeometry(track, pit.limitStartS, pit.limitEndS, () => pit.laneOffset + 1.1, () => pit.laneOffset + 0.9, () => 0.03, () => 0.03, 4, 1))
  // pit boxes (white outlines) — one per team garage, in the working lane in front of the
  // garages; garage 1 is at the T1 (pit-exit) end, 28.33 m pitch (garageS)
  for (let t = 0; t < 11; t++) {
    const s = garageS(t)
    const lat = pit.laneOffset - 2.5
    whiteGeos.push(ribbonGeometry(track, s - 3.5, s + 3.5, () => lat + 2.2, () => lat + 1.9, () => 0.03, () => 0.03, 1, 1))
    whiteGeos.push(ribbonGeometry(track, s - 3.5, s + 3.5, () => lat - 1.9, () => lat - 2.2, () => 0.03, () => 0.03, 1, 1))
    whiteGeos.push(ribbonGeometry(track, s - 3.5, s - 3.2, () => lat + 2.2, () => lat - 2.2, () => 0.03, () => 0.03, 1, 1))
  }
  // pit wall between track and pit lane, with advertising boards facing the track
  const boardMat = new THREE.MeshStandardMaterial({ map: boardTexture(), roughness: 0.45, metalness: 0.1, side: THREE.DoubleSide })
  const boardGeos: THREE.BufferGeometry[] = []
  boardGeos.push(wallGeometry(track, pit.limitStartS - 40, pit.limitEndS, () => pit.wallOffset, () => STRIP_DROP, () => 1.2, 4, 64))
  concreteGeos.push(ribbonGeometry(track, pit.limitStartS - 40, pit.limitEndS, () => pit.wallOffset + 0.3, () => pit.wallOffset - 0.3, () => 1.2, () => 1.2, 4, 10))
  concreteGeos.push(wallGeometry(track, pit.limitStartS - 40, pit.limitEndS, () => pit.wallOffset - 0.3, () => STRIP_DROP, () => 1.2, 4, 4))
  // outside barrier along the main straight and into T1 (stands on the verge)
  boardGeos.push(wallGeometry(track, 5480, 470, () => hw + 8, (s) => ground.yAt(s, hw + 8), (s) => ground.yAt(s, hw + 8) + 1.1, 4, 64))
  group.add(new THREE.Mesh(mergeGeometries(boardGeos, false)!, boardMat))
  const concreteMesh = new THREE.Mesh(mergeGeometries(concreteGeos, false)!, concrete)
  concreteMesh.name = 'concrete'
  concreteMesh.castShadow = true
  group.add(concreteMesh)

  // --- grid slots + start line ----------------------------------------------------
  // lit (not Basic) so the paint darkens under the gantry / pit-building shadow and at low sun
  const gridMat = new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.55, metalness: 0 })
  for (let k = 0; k < 22; k++) {
    const behind = 14 + 8 * k
    const s = track.wrap(-behind)
    const lat = k % 2 === 0 ? 2.6 : -2.6
    whiteGeos.push(ribbonGeometry(track, s - 2.6, s + 2.6, () => lat + 1.6, () => lat + 1.35, () => 0.03, () => 0.03, 1, 1))
    whiteGeos.push(ribbonGeometry(track, s - 2.6, s + 2.6, () => lat - 1.35, () => lat - 1.6, () => 0.03, () => 0.03, 1, 1))
    whiteGeos.push(ribbonGeometry(track, s + 2.4, s + 2.6, () => lat + 1.6, () => lat - 1.6, () => 0.03, () => 0.03, 1, 1))
  }
  whiteGeos.push(ribbonGeometry(track, L - 0.5, 0.5, hwAt, (s) => -hwAt(s), () => 0.03, () => 0.03, 1, 1))
  const whiteLines = new THREE.Mesh(mergeGeometries(whiteGeos, false)!, gridMat)
  whiteLines.name = 'whiteLines'
  whiteLines.receiveShadow = true
  group.add(whiteLines)
  // DRS detection / activation markings
  const drsMat = new THREE.MeshStandardMaterial({ color: 0xffd400, roughness: 0.55, metalness: 0 })
  const drsLines = new THREE.Mesh(mergeGeometries([
    ribbonGeometry(track, CIRCUIT.drs.detection, CIRCUIT.drs.detection + 0.4, hwAt, (s) => -hwAt(s), () => 0.03, () => 0.03, 1, 1),
    ribbonGeometry(track, CIRCUIT.drs.start, CIRCUIT.drs.start + 0.4, hwAt, (s) => -hwAt(s), () => 0.03, () => 0.03, 1, 1),
  ], false)!, drsMat)
  drsLines.name = 'drsLines'
  drsLines.receiveShadow = true
  group.add(drsLines)

  // --- start gantry with the five light clusters ------------------------------------
  const steel = new THREE.MeshStandardMaterial({ color: 0x3c3f46, roughness: 0.45, metalness: 0.8 })
  const gantry = new THREE.Group()
  const postGeo = new THREE.BoxGeometry(0.5, 9, 0.5)
  const beamGeo = new THREE.BoxGeometry(2 * hw + 6, 0.6, 0.6)
  const gs = 3
  const pose = track.headingAt(gs)
  track.pointAt(gs, 0, _p)
  gantry.position.copy(_p)
  gantry.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(pose.tz, 0, -pose.tx), new THREE.Vector3(0, 1, 0), new THREE.Vector3(pose.tx, 0, pose.tz)))
  for (const x of [hw + 2.5, -hw - 2.5]) {
    const post = new THREE.Mesh(postGeo, steel)
    post.position.set(x, 4.5, 0)
    post.castShadow = true
    gantry.add(post)
  }
  const beam = new THREE.Mesh(beamGeo, steel)
  beam.position.set(0, 8.7, 0)
  gantry.add(beam)
  const startLampMaterials: THREE.MeshStandardMaterial[] = []
  const lampGeo = new THREE.SphereGeometry(0.28, 10, 8)
  const housingGeo = new THREE.BoxGeometry(0.9, 1.7, 0.5)
  for (let i = 0; i < 5; i++) {
    const x = (i - 2) * 1.6
    const housing = new THREE.Mesh(housingGeo, new THREE.MeshStandardMaterial({ color: 0x111111 }))
    housing.position.set(x, 7.5, 0)
    gantry.add(housing)
    const mat = new THREE.MeshStandardMaterial({ color: 0x3a0000, emissive: 0x000000, roughness: 0.3 })
    startLampMaterials.push(mat)
    for (const y of [7.9, 7.1]) {
      const lamp = new THREE.Mesh(lampGeo, mat)
      lamp.position.set(x, y, -0.3)
      gantry.add(lamp)
    }
  }
  group.add(gantry)

  // the terrain grid is coarse: sink it wherever it would rise through any of the surfaces
  let total = 0
  for (const g of groundGeos) total += (g.attributes.position as THREE.BufferAttribute).count * 3
  const pts = new Float32Array(total)
  let at = 0
  for (const g of groundGeos) {
    const arr = (g.attributes.position as THREE.BufferAttribute).array as Float32Array
    pts.set(arr, at)
    at += arr.length
  }
  terrain.clampUnder(pts, RUNOFF_LIFT + 0.05)

  return { group, surface, startLampMaterials }
}

/**
 * Kerb cross-section on `side` (+1 left / -1 right) of the road edge: 0.3 m ramp from the
 * asphalt up to 5 cm, a slightly crowned top, and a 3 cm drop into the grass behind.
 */
function kerbProfile(track: Track, s0: number, s1: number, side: 1 | -1, width: number, hwAt: Fn): THREE.BufferGeometry {
  const at = (off: number): Fn => (s) => side * (hwAt(s) + off)
  const edges: [Fn, Fn][] = [
    [at(0), () => 0.0],
    [at(0.3), () => 0.05],
    [at(width * 0.55), () => 0.065],
    [at(width - 0.15), () => 0.05],
    [at(width), () => STRIP_DROP],
  ]
  // edges run right-to-left (increasing lateral): the right kerb is listed outside-in
  if (side < 0) edges.reverse()
  return profileRibbonGeometry(track, s0, s1, edges, 1, 2)
}

/**
 * Forward intervals of [from, to] that remain after removing [cutFrom, cutTo] (all on the
 * closed lap of length L).
 */
function subtractInterval(from: number, to: number, cutFrom: number, cutTo: number, L: number): [number, number][] {
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

function forwardDeltaSigned(s: number, ref: number, L: number): number {
  let d = (s - ref) % L
  if (d < 0) d += L
  if (d > L / 2) d -= L
  return d
}
