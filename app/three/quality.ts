/**
 * Quality tiers and the GPU capability probe.
 *
 * Everything the renderer scales with the machine lives in one table, so a tier is a set of
 * numbers rather than `tier === 'high'` checks scattered over the scene builders. The probe
 * runs on a throwaway WebGL2 context BEFORE the real renderer exists, because a few of the
 * choices (antialiasing, reversed depth) are context-creation flags that cannot be changed
 * afterwards.
 */

export type QualityTier = 'low' | 'high'

export interface Capabilities {
  /** UNMASKED_RENDERER_WEBGL, '' when the debug extension is unavailable */
  renderer: string
  /** software rasteriser (SwiftShader, llvmpipe, …) */
  software: boolean
  /** EXT_clip_control present — required for a reversed-Z depth buffer */
  clipControl: boolean
  maxAnisotropy: number
  webgl2: boolean
}

export interface Quality {
  tier: QualityTier
  /** device-pixel-ratio cap */
  dpr: number
  /** default-framebuffer MSAA (context creation flag) */
  antialias: boolean
  /** samples of the off-screen scene target on the post chain (0 = none) */
  msaa: number
  /** reversed-Z float depth (falls back to log depth without EXT_clip_control) */
  reversedDepth: boolean
  shadowMapSize: number
  cascades: number
  /** in the overview the shadow maps are re-rendered only every Nth frame */
  overviewShadowEveryNth: number
  /**
   * World-space penumbra target per cascade (metres, PCF only; BasicShadowMap ignores it).
   * The index clamps to the last entry.
   *
   * The sun subtends 0.533°, so a penumbra is 0.93 cm wide per metre of caster-to-receiver gap
   * measured ALONG the light. A car floor 0.3 m over the tarmac is therefore a ~3 mm edge, not a
   * soft one — which is why a single 12 cm value made every car look like it was hovering. With
   * updateShadows bracketing the subject, cascades 0 and 1 both hold cars and want a car-scale
   * value; only the background cascade wants a grandstand-scale one (and there the texel is far
   * larger than any of these anyway, so the radius clamps to 1 regardless).
   */
  penumbraM: readonly number[]
  /** cascade range in follow modes (metres) */
  followMaxFar: number
  /** cars within this distance cast with their LOD-0 meshes (metres) */
  casterGateLod0: number
  /** cars within this distance cast with their LOD-1 meshes (metres, 0 = never) */
  casterGateLod1: number
  treeShadows: boolean
  crowd: number
  sparks: number
  smoke: number
  skidQuads: number
  trees: number
  /** height-grid cells of the terrain rectangle (3400 × 2600 m); both counts must be multiples of 4 (the ring's K) */
  terrain: [number, number]
  /**
   * cells of the coarse terrain ring beyond the rectangle on every side, at 4 × the grid spacing
   * (terrain-far.ts): 25 × 53 m ≈ 1.3 km on the high tier, 19 × 71 m ≈ 1.35 km on the low
   */
  terrainRingCells: number
  textureScale: number
  /** anisotropy budget for everything except the ground surfaces */
  anisotropy: number
  /**
   * anisotropy budget for the road / verge / gravel / kerb / terrain maps. The road's screen
   * footprint is `distance / eye height` times longer than it is wide — 97:1 looking 100 m down
   * the road from the 1.34 m T-cam — so these are the only textures a higher budget can help.
   */
  anisotropyGround: number
  fence: boolean
  clouds: boolean
  /** lens flare (horizontal streak + ghosts) drawn by the grade pass around a visible sun — needs `post`; the veil is always on there */
  flare: boolean
  /** the DEM_FAR skyline mesh (`terrainFar`, ±35 km) behind the ring */
  ridge: boolean
  /** @deprecated the tree-line cylinder of sky-extras.ts, replaced by `ridge`; goes with the cylinder */
  ring: boolean
  /** HDR post chain (bloom, grade) */
  post: boolean
  gtao: boolean
  dof: boolean
  motionBlur: boolean
  smaa: boolean
  /**
   * Load the external asset pack (`/assets-manifest.json`: photo PBR tiles, tree / seat / crowd
   * models). Off on the low tier so the software-rasteriser (e2e) path stays at zero downloads
   * and zero external dependencies; `?assets=0|1` overrides (see `assetsOverride`).
   */
  assets: boolean
  /**
   * near-field 3D spectators: a stand bay inside 55 m draws up to a third of this many of its
   * front-row people as instanced figures, the rest of the bay stays impostors. 0 = impostors only
   */
  crowdNear: number
  /** near-field grass blade instances (0 = the tiled ground texture alone) */
  grass: number
  /** individual seat instances on the stands (false = the flat seat ribbon texture) */
  seatInstances: boolean
  /** resolution class of the external textures picked from the manifest */
  textureRes: '2k' | '1k'
  /**
   * Land-cover mask resolution (landcover.ts), texels per side of the two square RGBA8 pairs:
   * [0] the inner terrain rectangle (3400 × 2600 m → 3.3 m texels at 1024), [1] the outer ring
   * rectangle. VRAM ≈ 4 × res² × 1.33 bytes per pair; the masks are built on the CPU at start-up.
   */
  coverRes: [number, number]
  /**
   * Sample the land-cover detail tile (forest litter / paddy stubble / asphalt grain / solar rows)
   * in the grass shader: four extra texture fetches per fragment, which a fill-bound software
   * rasteriser cannot afford — off there, the classes are flat colours under the macro variation.
   */
  coverDetail: boolean
  /** the far field (farfield.ts): everything outside the fences that only stands on the ground */
  farField: FarFieldQuality
}

/**
 * Budgets of the far field. Every number a far-field builder scales with the tier lives here;
 * the builders never test the tier themselves.
 */
export interface FarFieldQuality {
  /** multiplies every level range (and the per-cell skip): 1 = the ranges as registered */
  lodScale: number
  /** near-field 3D trees (GLB / detailed geometry) drawn around the camera, 0 = none */
  nearTrees: number
  /** hero trees (individually placed, full geometry) per 250 m cell, 0 = none */
  heroPerCell: number
  /** mid-range instanced trees (cards / low-poly) over the whole forest */
  midTrees: number
  /** the merged canopy mass behind the mid-range trees */
  canopy: boolean
  /** buildings inside this distance get their detail level (facades, roofs); 0 = mass only */
  buildingsDetailM: number
  /** parked cars across the car parks */
  parkedCars: number
  /** baked car impostors between the 3D body range and `rangeFar` (procedural cards otherwise) */
  carImpostors: boolean
  /** light poles along the roads and car parks */
  lightPoles: number
  /** far-field meshes cast shadows */
  shadows: boolean
  /** wall-clock budget of one deferred-build tick (ms), a `setTimeout(0)` loop after loading */
  tickMs: number
  /** the far field's outer range: beyond this nothing but the mass levels is drawn (metres) */
  rangeFar: number
}

export const QUALITY: Record<QualityTier, Quality> = {
  high: {
    tier: 'high',
    // DPR 2 → 1.5 is −44 % fragments across every full-screen pass; SMAA covers the rest
    dpr: 1.5,
    // nothing but the final full-screen quad touches the default framebuffer: MSAA lives on the scene target
    antialias: false,
    msaa: 4,
    reversedDepth: true,
    shadowMapSize: 2048,
    cascades: 3,
    overviewShadowEveryNth: 2,
    penumbraM: [0.012, 0.015, 0.30],
    followMaxFar: 900,
    casterGateLod0: 250,
    casterGateLod1: 400,
    treeShadows: true,
    crowd: 65000,
    sparks: 2048,
    smoke: 768,
    skidQuads: 4000,
    trees: 3000,
    terrain: [256, 192],
    terrainRingCells: 25,
    textureScale: 1,
    anisotropy: 16,
    anisotropyGround: 16,
    fence: true,
    clouds: true,
    flare: true,
    ridge: true,
    ring: true,
    post: true,
    gtao: true,
    dof: true,
    motionBlur: true,
    smaa: true,
    assets: true,
    crowdNear: 2000,
    grass: 60000,
    seatInstances: true,
    textureRes: '2k',
    coverRes: [1024, 512],
    coverDetail: true,
    farField: { lodScale: 1.0, nearTrees: 900, heroPerCell: 40, midTrees: 6000, canopy: true, buildingsDetailM: 700, parkedCars: 4000, carImpostors: true, lightPoles: 350, shadows: true, tickMs: 12, rangeFar: 2200 },
  },
  // The low tier is what SwiftShader (and the e2e suite) runs: log depth, no post chain, and
  // every budget halved or better. `?fx=0` forces it on a real GPU.
  low: {
    tier: 'low',
    dpr: 1,
    // software rasterisers are fill-bound: no default-framebuffer MSAA
    antialias: false,
    msaa: 0,
    reversedDepth: false,
    shadowMapSize: 1024,
    cascades: 2,
    overviewShadowEveryNth: 3,
    penumbraM: [0.02, 0.30],
    followMaxFar: 700,
    casterGateLod0: 120,
    casterGateLod1: 0,
    treeShadows: false,
    crowd: 6000,
    sparks: 512,
    smoke: 256,
    skidQuads: 1500,
    trees: 800,
    terrain: [192, 144],
    terrainRingCells: 19,
    textureScale: 0.5,
    anisotropy: 2,
    // the software rasteriser loops per tap, but the road is a small fraction of its fill and it
    // is the one surface that is starved: give the ground the taps and take them from everything else
    anisotropyGround: 8,
    fence: false,
    clouds: false,
    flare: false,
    ridge: true,
    ring: true,
    post: false,
    gtao: false,
    dof: false,
    motionBlur: false,
    smaa: false,
    assets: false,
    crowdNear: 0,
    grass: 0,
    seatInstances: false,
    textureRes: '1k',
    coverRes: [512, 256],
    coverDetail: false,
    // a 30 ms tick: SwiftShader's main thread is the renderer too, and the drain must finish in
    // tens of seconds, not minutes, for the e2e's pending === 0 wait
    farField: { lodScale: 0.55, nearTrees: 0, heroPerCell: 0, midTrees: 1800, canopy: true, buildingsDetailM: 0, parkedCars: 1000, carImpostors: false, lightPoles: 120, shadows: false, tickMs: 30, rangeFar: 1400 },
  },
}

const SOFTWARE_RE = /swiftshader|llvmpipe|softpipe|software/i

/**
 * Query the GPU on a detached canvas. The context is simply dropped afterwards (not
 * explicitly lost: Chrome reports a forced context loss on the console).
 */
export function probeCapabilities(): Capabilities {
  const caps: Capabilities = { renderer: '', software: false, clipControl: false, maxAnisotropy: 1, webgl2: false }
  if (typeof document === 'undefined') return caps
  try {
    const c = document.createElement('canvas')
    const gl = c.getContext('webgl2', { antialias: false, depth: false, powerPreference: 'high-performance' }) as WebGL2RenderingContext | null
    if (!gl) return caps
    caps.webgl2 = true
    const info = gl.getExtension('WEBGL_debug_renderer_info')
    caps.renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : ''
    caps.software = SOFTWARE_RE.test(caps.renderer)
    caps.clipControl = !!gl.getExtension('EXT_clip_control')
    const aniso = gl.getExtension('EXT_texture_filter_anisotropic') || gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic')
    caps.maxAnisotropy = aniso ? Number(gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)) || 1 : 1
  } catch {
    /* a failed probe means the defaults (no reversed depth, tier from the URL or 'high') */
  }
  return caps
}

/** `?fx=0` / `?fx=1` force a tier; otherwise software rasterisers get 'low'. */
export function pickTier(caps: Capabilities): QualityTier {
  const forced = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('fx') : null
  if (forced === '0') return 'low'
  if (forced === '1') return 'high'
  return caps.software ? 'low' : 'high'
}

/**
 * `?assets=0` / `?assets=1` force the external asset pack off / on regardless of the tier
 * (null = the tier decides). `assets=1` on the low tier is how the fallback path is exercised in
 * headless Chromium; `assets=0` on a GPU shows the procedural-only look for comparison.
 */
export function assetsOverride(): boolean | null {
  const v = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('assets') : null
  if (v === '0') return false
  if (v === '1') return true
  return null
}
