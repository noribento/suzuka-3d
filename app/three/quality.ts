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
  terrain: [number, number]
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
  /** near-field 3D spectators (instanced meshes); the rest are impostors. 0 = impostors only */
  crowdNear: number
  /** near-field grass blade instances (0 = the tiled ground texture alone) */
  grass: number
  /** individual seat instances on the stands (false = the flat seat ribbon texture) */
  seatInstances: boolean
  /** resolution class of the external textures picked from the manifest */
  textureRes: '2k' | '1k'
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
    textureScale: 1,
    anisotropy: 16,
    anisotropyGround: 16,
    fence: true,
    clouds: true,
    flare: true,
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
    textureScale: 0.5,
    anisotropy: 2,
    // the software rasteriser loops per tap, but the road is a small fraction of its fill and it
    // is the one surface that is starved: give the ground the taps and take them from everything else
    anisotropyGround: 8,
    fence: false,
    clouds: false,
    flare: false,
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
