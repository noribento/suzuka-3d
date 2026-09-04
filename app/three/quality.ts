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
  /** world-space penumbra radius of the cascades (metres, PCF only) */
  penumbraM: number
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
  anisotropy: number
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
    penumbraM: 0.12,
    followMaxFar: 900,
    casterGateLod0: 250,
    casterGateLod1: 400,
    treeShadows: true,
    crowd: 30000,
    sparks: 2048,
    smoke: 768,
    skidQuads: 4000,
    trees: 3000,
    terrain: [256, 192],
    textureScale: 1,
    anisotropy: 16,
    fence: true,
    clouds: true,
    flare: true,
    ring: true,
    post: true,
    gtao: true,
    dof: true,
    motionBlur: true,
    smaa: true,
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
    penumbraM: 0.12,
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
    fence: false,
    clouds: false,
    flare: false,
    ring: true,
    post: false,
    gtao: false,
    dof: false,
    motionBlur: false,
    smaa: false,
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
