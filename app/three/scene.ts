import * as THREE from 'three'
import { Sky } from 'three/addons/objects/Sky.js'
import { CSM } from 'three/addons/csm/CSM.js'
import { disposeAll, setMaxAnisotropy, setTextureScale } from './textures'
import { createPostChain, type PostChain, type SunFrame } from './post'
import { buildSkyExtras } from './sky-extras'
import { QUALITY, pickTier, probeCapabilities, type Capabilities, type Quality, type QualityTier } from './quality'
import { followSplits, needsRefit, overviewMaxFar, overviewSplits, penumbraTarget, quantFov } from './shadow-fit'
import {
  CUT_JUMP_M,
  SKY_FRAG_ANCHOR,
  SKY_MAIN_ANCHOR,
  SUN_DISC_RADIANCE,
  SUN_DISC_SOFT,
  SUN_GLSL_PARS,
  SUN_GLSL_SUN,
  adaptEv,
  adaptTau,
  aureolePeak,
  baseExposure,
  discColour,
  elevationWeight,
  glareTargetEv,
  sunFrameWeight,
} from './sun-model'
import type { CameraMode } from '~/composables/useRaceStore'

export type ShadowMode = 'overview' | 'follow'
/**
 * Quality tier. `high` runs the HDR post-processing chain (bloom, grade) and the full
 * effects set; `low` renders straight to the canvas — used on software rasterisers such
 * as SwiftShader (headless tests) or when the page is opened with `?fx=0`.
 * The numeric knobs of each tier live in ./quality (QUALITY); `tier` stays the coarse switch.
 */
export type { QualityTier }
/** How the depth buffer is encoded: 'reversed' (float reversed-Z, depth-reading passes possible) or 'log'. */
export type DepthMode = 'reversed' | 'log'

export interface SceneContext {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  csm: CSM
  sunDirection: THREE.Vector3
  tier: QualityTier
  quality: Quality
  caps: Capabilities
  depthMode: DepthMode
  post: PostChain | null
  /**
   * Render one frame (through the post chain on the high tier) after adapting the exposure to
   * where the sun sits in the frame; `wind` (m/s) drifts the clouds.
   */
  render: (dt: number, wind?: number) => void
  /** Resize the renderer and the post-processing targets (CSS pixels). */
  setSize: (w: number, h: number) => void
  /**
   * Render-resolution scale (0.7–1) on top of the tier's device-pixel-ratio cap. Only sets the
   * pixel ratio: the caller re-runs its resize path afterwards (targets, particle point sizes).
   * Returns the resulting pixel ratio.
   */
  setResolutionScale: (k: number) => number
  /** Move the sun (local hour, 10–17.5) and re-light the scene accordingly. */
  setTimeOfDay: (hour: number) => void
  /** Patch every lit material under `root` so it samples the cascaded shadow maps. */
  setupMaterials: (root: THREE.Object3D) => void
  /**
   * Re-fit the shadow cascades for this frame. `focusDistance` is how far the subject
   * (selected car, or the orbit target) is from the camera; the first cascade is sized
   * so that region gets the sharpest shadows.
   */
  updateShadows: (mode: ShadowMode, focusDistance: number) => void
  /**
   * Re-upload the light/shadow uniform block of every CSM material. Call once after the
   * first rendered frame: the block is uploaded when a program is first bound and is not
   * refreshed afterwards, so materials compiled on frame one keep stale shadow bindings.
   */
  refreshMaterials: (root: THREE.Object3D) => void
  /** Re-render every shadow cascade on the next frames (after a WebGL context restore). */
  forceShadowUpdate: () => void
  dispose: () => void
}

/**
 * Sun direction (world: x = east, y = up, z = south) for a local-time hour at Suzuka on the
 * Japanese GP weekend (early October: declination ≈ -4.6°, solar noon ≈ 11:45 JST).
 */
export function sunDirectionAt(hour: number): THREE.Vector3 {
  const lat = (34.84 * Math.PI) / 180
  const dec = (-4.6 * Math.PI) / 180
  const H = ((hour - 11.75) * 15 * Math.PI) / 180
  const sinEl = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H)
  const el = Math.asin(THREE.MathUtils.clamp(sinEl, -1, 1))
  // azimuth from north, clockwise
  const cosAz = (Math.sin(dec) - Math.sin(el) * Math.sin(lat)) / (Math.cos(el) * Math.cos(lat))
  let az = Math.acos(THREE.MathUtils.clamp(cosAz, -1, 1))
  if (H > 0) az = 2 * Math.PI - az
  const east = Math.cos(el) * Math.sin(az)
  const north = Math.cos(el) * Math.cos(az)
  return new THREE.Vector3(east, Math.max(0.03, Math.sin(el)), -north).normalize()
}

/** 1 at midday, 0 near the horizon: drives the light colour, the disc colour and the glare strength. */
function warmthOf(sun: THREE.Vector3): number {
  return THREE.MathUtils.smoothstep(Math.asin(sun.y), 0.05, 0.5)
}

/**
 * Vertex-coloured sphere approximating the sky radiance (linear): blue zenith, hazy
 * horizon, a warm glow around the sun and green-brown ground bounce below the horizon.
 * The geometry is kept and recoloured in place on every sun move.
 */
function buildLightingDome(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(40, 64, 40)
  const pos = geo.attributes.position as THREE.BufferAttribute
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3))
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false }))
}

function colourLightingDome(dome: THREE.Mesh, sun: THREE.Vector3) {
  const geo = dome.geometry
  const pos = geo.attributes.position as THREE.BufferAttribute
  const colAttr = geo.attributes.color as THREE.BufferAttribute
  const colors = colAttr.array as Float32Array
  const dir = new THREE.Vector3()
  const zenith = new THREE.Color(0.55, 0.68, 1.0)
  const horizon = new THREE.Color(0.9, 0.93, 1.0)
  const ground = new THREE.Color(0.32, 0.36, 0.22)
  const deep = new THREE.Color(0.16, 0.18, 0.11)
  const warm = new THREE.Color(1.0, 0.86, 0.66)
  const c = new THREE.Color()
  for (let i = 0; i < pos.count; i++) {
    dir.set(pos.getX(i), pos.getY(i), pos.getZ(i)).normalize()
    const y = dir.y
    if (y >= 0) {
      const t = Math.pow(y, 0.55)
      c.copy(horizon).lerp(zenith, t)
      c.multiplyScalar(0.7)
    } else {
      const t = Math.min(1, -y * 2.5)
      c.copy(horizon).multiplyScalar(0.5).lerp(ground, Math.min(1, -y * 12)).lerp(deep, t * 0.6)
    }
    const cosSun = Math.max(0, dir.dot(sun))
    const glow = Math.pow(cosSun, 12) * 0.5 + Math.pow(cosSun, 160) * 10
    c.r += warm.r * glow
    c.g += warm.g * glow
    c.b += warm.b * glow
    colors[i * 3] = c.r
    colors[i * 3 + 1] = c.g
    colors[i * 3 + 2] = c.b
  }
  colAttr.needsUpdate = true
}

export function createScene(canvas: HTMLCanvasElement, camera: THREE.PerspectiveCamera, centre = new THREE.Vector3(), caps: Capabilities = probeCapabilities()): SceneContext {
  const tier = pickTier(caps)
  const q = QUALITY[tier]
  const CASCADES = q.cascades
  const SHADOW_MAP = q.shadowMapSize
  // Depth strategy: a reversed-Z float depth buffer (EXT_clip_control) on the high tier gives
  // ~1e-7 relative precision at any distance without the per-fragment gl_FragDepth write of the
  // logarithmic buffer (which disables early-Z and blocks every depth-reading pass). Software
  // rasterisers and GPUs without the extension stay on log depth.
  const useReversed = q.reversedDepth && caps.clipControl
  let renderer = new THREE.WebGLRenderer({ canvas, antialias: q.antialias, powerPreference: 'high-performance', logarithmicDepthBuffer: !useReversed, reversedDepthBuffer: useReversed })
  let depthMode: DepthMode = 'log'
  if (useReversed) {
    if (renderer.capabilities.reversedDepthBuffer) {
      depthMode = 'reversed'
    } else {
      // refused after all (three then falls back to a plain 24-bit buffer, not log depth):
      // rebuild on the logarithmic path so nothing z-fights at 2 km
      renderer.dispose()
      renderer = new THREE.WebGLRenderer({ canvas, antialias: q.antialias, powerPreference: 'high-performance', logarithmicDepthBuffer: true })
    }
  }
  if (depthMode === 'reversed') {
    // the renderer flips the camera on its first draw; do it now so the CSM frustum fit below
    // (and anything projecting through the camera before frame 1) sees the reversed matrix
    ;(camera as unknown as { _reversedDepth: boolean })._reversedDepth = true
    camera.updateProjectionMatrix()
  }
  const basePixelRatio = Math.min(window.devicePixelRatio, q.dpr)
  renderer.setPixelRatio(basePixelRatio)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.NeutralToneMapping
  // re-derived every frame by render(): the time-of-day base level × the sun-facing adaptation
  renderer.toneMappingExposure = baseExposure(1)
  renderer.shadowMap.enabled = true
  // the cascades are re-rendered only when something that shadows can see has changed (see render())
  renderer.shadowMap.autoUpdate = false
  // Hardware depth-compare sampling (PCF) is not available on software rasterisers such as
  // SwiftShader (headless test runs); fall back to unfiltered maps there so shadows still render.
  renderer.shadowMap.type = caps.software ? THREE.BasicShadowMap : THREE.PCFShadowMap
  // draw-call statistics accumulate over the whole frame (post passes render several times)
  renderer.info.autoReset = false
  const hwAniso = renderer.capabilities.getMaxAnisotropy()
  setMaxAnisotropy(Math.min(hwAniso, q.anisotropy), Math.min(hwAniso, q.anisotropyGround))
  setTextureScale(q.textureScale)

  const scene = new THREE.Scene()
  // aerial perspective: distant hills fade towards the horizon haze (denser at low sun)
  const FOG_DENSITY = 0.00016
  scene.fog = new THREE.FogExp2(0xc4d3e3, FOG_DENSITY)

  // --- sun: computed from the time of day at Suzuka (34.84° N) on race day (early October) ------
  const sunDirection = sunDirectionAt(14)
  const sunColor = new THREE.Color(0xffedd4)
  let warm = warmthOf(sunDirection)

  // --- sky + image-based lighting -----------------------------------------------------------
  const sky = new Sky()
  sky.scale.setScalar(15000)
  const u = sky.material.uniforms
  // Preetham preset: clear early-autumn air (turbidity 2.5), a slightly deeper blue (rayleigh
  // 1.2) and a small, sharply forward-peaked Mie lobe (0.0007, g 0.955) so the circumsolar
  // brightening falls off like a Buie θ⁻² aureole instead of a 15° plateau over the bloom threshold
  u.turbidity!.value = 2.5
  u.rayleigh!.value = 1.2
  u.mieCoefficient!.value = 0.0007
  u.mieDirectionalG!.value = 0.955
  u.sunPosition!.value.copy(sunDirection)
  // r185's own disc (≈3×10⁵ linear, 0.53° across, past the half-float ceiling) and its
  // procedural cloud patches are off; the fragment patch below draws a bounded sun instead
  u.showSunDisc!.value = 0
  u.cloudCoverage!.value = 0
  u.cloudDensity!.value = 0
  u.uDiscRadiance = { value: SUN_DISC_RADIANCE }
  u.uDiscColor = { value: new THREE.Color(...discColour(warm)) }
  u.uAureolePeak = { value: aureolePeak(warm) }
  // the rim is wider on the low tier, which has neither MSAA nor SMAA to smooth a 0.6 px edge
  u.uDiscSoft = { value: SUN_DISC_SOFT[tier] }
  // Sky pins its depth to the far plane with z = w, which is the NEAR plane once the depth
  // range is reversed (NDC z 1 → nearest); far is 0 there.
  sky.material.vertexShader = sky.material.vertexShader.replace(
    'gl_Position.z = gl_Position.w;',
    '#ifdef USE_REVERSED_DEPTH_BUFFER\n gl_Position.z = 0.0;\n#else\n gl_Position.z = gl_Position.w;\n#endif',
  )
  // Bounded sun (see ./sun-model.ts): the declarations and the knee go in front of main(), and the
  // line that writes the sky becomes aureole → knee (≤ SKY_MAX 3.0 < bloom threshold) → disc.
  // Both replacements are exact strings of r185's Sky.js; a three upgrade that moves them would
  // silently bring the 3×10⁵ disc back, so a miss is an error (the e2e suite fails on console.error).
  const skyFrag = sky.material.fragmentShader
  const withPars = skyFrag.replace(SKY_MAIN_ANCHOR, () => `${SUN_GLSL_PARS}\n${SKY_MAIN_ANCHOR}`)
  const withSun = withPars.replace(SKY_FRAG_ANCHOR, () => SUN_GLSL_SUN)
  if (withPars === skyFrag || withSun === withPars) console.error('Sky.js shader changed: sun bound not applied')
  sky.material.fragmentShader = withSun
  scene.add(sky)
  // Image-based lighting comes from a bounded analytic dome (the Sky shader's sun disk overflows
  // the half-float PMREM target, and the blur then spreads NaN across the whole map).
  const pmrem = new THREE.PMREMGenerator(renderer)
  let envTarget: THREE.WebGLRenderTarget | null = null
  const envScene = new THREE.Scene()
  const dome = buildLightingDome()
  envScene.add(dome)
  const buildEnvironment = () => {
    colourLightingDome(dome, sunDirection)
    // No pre-blur. sigma 0.04 rad is 2.29 deg, ~6.5 texels of the 256 cube, but the mip a
    // `roughness 0.06` clearcoat samples is -2*log2(1.16*0.06) = 7.69 (between the 128 and 256 px
    // faces): the blur was destroying detail four to six times finer than the mip it lands on, so
    // every reflection below roughness ~0.25 read as a flat gradient. sigma only existed to hide
    // the faceting of the vertex-coloured dome; a per-fragment source has none. Also drops the
    // two _halfBlur passes.
    const target = pmrem.fromScene(envScene, 0)
    envTarget?.dispose()
    envTarget = target
    scene.environment = target.texture
  }
  buildEnvironment()
  // the time-of-day slider fires per step: the sun moves at once, the PMREM rebuild trails it
  let envTimer = 0
  const scheduleEnvironment = () => {
    if (envTimer) clearTimeout(envTimer)
    envTimer = window.setTimeout(() => {
      envTimer = 0
      buildEnvironment()
    }, 150)
  }
  scene.environmentIntensity = 0.5

  // soft ground bounce (the sky dome already lights from above through the environment map)
  const hemi = new THREE.HemisphereLight(0xd6e4f5, 0x6f7f48, 0.28)
  scene.add(hemi)

  // --- cascaded shadow maps ---------------------------------------------------------------------
  // current split fractions of the main frustum (rewritten by updateShadows)
  let s0Cur = 0.05
  let s1Cur = 0.3
  const csm = new CSM({
    camera,
    parent: scene,
    cascades: CASCADES,
    maxFar: q.followMaxFar,
    mode: 'custom',
    customSplitsCallback: (cascades: number, _near: number, _far: number, breaks: number[]) => {
      // the breaks are built from the two splits directly so 2 cascades (low tier) are legal
      breaks.length = 0
      if (cascades >= 3) breaks.push(s0Cur, s1Cur, 1)
      else if (cascades === 2) breaks.push(s1Cur, 1)
      else breaks.push(1)
      if (import.meta.dev && breaks.length !== cascades) console.warn('CSM: breaks/cascades mismatch', breaks, cascades)
    },
    shadowMapSize: SHADOW_MAP,
    shadowBias: -0.00015,
    lightDirection: sunDirection.clone().negate(),
    lightIntensity: 2.9,
    lightNear: 1,
    lightFar: 9000,
    lightMargin: 500,
  })
  csm.fade = true
  // CSM builds its main frustum from NDC z = ±1; under a reversed depth range near/far are 1/0
  if (depthMode === 'reversed') {
    csm.mainFrustum.zNear = 1
    csm.mainFrustum.zFar = 0
  }
  for (const light of csm.lights) {
    light.color.copy(sunColor)
    light.shadow.normalBias = 0.2
    light.shadow.radius = 1.5
  }

  let currentMode: ShadowMode | null = null
  let lastFocus = -1
  let lastAspect = 0
  let lastFitFov = 0
  /** metre bounds of the cascade slice the subject was last fitted into (NaN = never fitted) */
  let fitLo = NaN
  let fitHi = NaN
  /** the sun moved: the elevation-dependent penumbra has to be re-derived */
  let refitPending = false
  // shadow-map update policy: every frame in follow modes (cars move), otherwise only when the
  // camera, the sun or the cascade fit changed — the overview at 1.5 km has nothing moving that casts
  let shadowDirty = true
  let sunMoved = false
  let frameNo = 0
  const lastCamPos = new THREE.Vector3(NaN, NaN, NaN)
  const lastCamQuat = new THREE.Quaternion(NaN, NaN, NaN, NaN)
  const updateShadows = (mode: ShadowMode, focusDistance: number) => {
    const d = Math.max(5, focusDistance)
    // Where the subject sits in the split matters more than the shadow map's resolution: CSM
    // sizes a cascade by its longest diagonal, which for a long lens is its depth. See ./shadow-fit.
    const maxFar = mode === 'overview' ? overviewMaxFar(d) : q.followMaxFar
    const split = mode === 'overview' ? overviewSplits(d, maxFar) : followSplits(d, maxFar, CASCADES)
    let { s0, s1 } = split
    if (s1 <= s0 + 0.02) s1 = s0 + 0.02
    const fitFov = quantFov(camera.fov)
    // A bracketed subject must never leave its slice, so the threshold comes from the slice the
    // cascades were actually fitted to; the wide splits keep the old proportional rule.
    const focusMoved = split.bracketW > 0 ? needsRefit(d, fitLo, fitHi) : Math.abs(d - lastFocus) > d * 0.05
    const changed = mode !== currentMode || focusMoved || camera.aspect !== lastAspect || fitFov !== lastFitFov || refitPending
    if (changed) {
      currentMode = mode
      lastFocus = d
      lastAspect = camera.aspect
      lastFitFov = fitFov
      refitPending = false
      fitLo = split.bracketW > 0 ? s0 * maxFar : NaN
      fitHi = split.bracketW > 0 ? s1 * maxFar : NaN
      s0Cur = s0
      s1Cur = s1
      csm.maxFar = maxFar
      // fit with the quantised lens, then put the live one back: _initCascades reads (and
      // rebuilds) camera.projectionMatrix, and the frame still has to render at the real FOV
      const liveFov = camera.fov
      camera.fov = fitFov
      csm.updateFrustums()
      camera.fov = liveFov
      camera.updateProjectionMatrix()
      csm.lights.forEach((light, i) => {
        const cam = light.shadow.camera
        const texel = (cam.right - cam.left) / SHADOW_MAP
        // bias scales with the texel footprint of each cascade
        light.shadow.normalBias = Math.max(0.03, texel * 1.5)
        light.shadow.bias = -0.00005 - texel * 0.00004
        light.shadow.radius = THREE.MathUtils.clamp(penumbraTarget(q.penumbraM, i, sunDirection.y) / texel, 1, 6)
      })
    }
    csm.update()
    const camMoved = !camera.position.equals(lastCamPos) || !camera.quaternion.equals(lastCamQuat)
    if (camMoved) {
      lastCamPos.copy(camera.position)
      lastCamQuat.copy(camera.quaternion)
    }
    // frames 0-2 are forced so the material refresh after frame 1 sees valid maps
    shadowDirty = changed || sunMoved || camMoved || frameNo < 3 || mode !== 'overview' || frameNo % q.overviewShadowEveryNth === 0
  }

  const setupMaterials = (root: THREE.Object3D) => {
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (!mesh.isMesh && !(obj as THREE.InstancedMesh).isInstancedMesh) return
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const m of mats) {
        if (!m || !(m as THREE.MeshStandardMaterial).isMeshStandardMaterial) continue
        if (m.userData.csm) continue
        // CSM.setupMaterial assigns material.onBeforeCompile outright, which would silently
        // discard any shader patch the material already carries (the crowd atlas/sway, the
        // flag wave, macro variation). Chain the two hooks — CSM's first, so its shader
        // bookkeeping sees the object it expects — and give the combination its own program
        // cache key so a patched and an unpatched material never share a program.
        const prev = m.onBeforeCompile
        const prevKey = m.customProgramCacheKey()
        csm.setupMaterial(m)
        const csmHook = m.onBeforeCompile
        m.onBeforeCompile = (shader, renderer) => {
          csmHook.call(m, shader, renderer)
          prev.call(m, shader, renderer)
        }
        m.customProgramCacheKey = () => `csm|${prevKey}`
        m.userData.csm = true
      }
    })
  }

  const refreshMaterials = (root: THREE.Object3D) => {
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (!mesh.isMesh && !(obj as THREE.InstancedMesh).isInstancedMesh) return
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const m of mats) if (m && m.userData.csm) m.needsUpdate = true
    })
  }

  const extras = buildSkyExtras(centre, q)
  scene.add(extras.group)

  const setTimeOfDay = (hour: number) => {
    sunDirection.copy(sunDirectionAt(hour))
    u.sunPosition!.value.copy(sunDirection)
    csm.lightDirection.copy(sunDirection).negate()
    sunMoved = true
    // the penumbra scales with 1/sin(elevation): the cascades have to be re-derived, and only
    // the `changed` branch does that (sunMoved alone just re-renders the maps)
    refitPending = true
    scheduleEnvironment()
    // low sun: warmer, dimmer light, longer haze
    warm = warmthOf(sunDirection)
    sunColor.setHex(0xffa860).lerp(new THREE.Color(0xffedd4), warm)
    for (const light of csm.lights) {
      light.color.copy(sunColor)
      light.intensity = 2.9 * (0.5 + 0.5 * warm)
    }
    // the disc and its aureole warm up with the light (the disc is not extinguished: its colour is the sunset)
    const [dr, dg, db] = discColour(warm)
    ;(u.uDiscColor!.value as THREE.Color).setRGB(dr, dg, db)
    u.uAureolePeak!.value = aureolePeak(warm)
    // exposure: owned by render() (base level for `warm` × the sun-facing adaptation)
    if (post) post.grade.uniforms.uWarm!.value = warm
    ;(scene.fog as THREE.FogExp2).color.setHex(0xe0c8a8).lerp(new THREE.Color(0xc4d3e3), warm)
    ;(scene.fog as THREE.FogExp2).density = FOG_DENSITY * (1 + 0.5 * (1 - warm))
    extras.setSun(sunColor, warm)
    hemi.intensity = 0.28 * (0.6 + 0.4 * warm)
    scene.environmentIntensity = 0.5 * (0.6 + 0.4 * warm)
  }

  const post = q.post ? createPostChain(renderer, scene, camera, q, depthMode) : null

  // --- exposure: a camera pointed at the sun stops down ------------------------------------------
  // The adapted offset `ev` (stops) follows a target set by how much of the sun is in the frame
  // (sunFrameWeight × the horizon fade), gated by the probe's visibility on the high tier (an
  // occluded sun must not darken the picture); the low tier has no probe and assumes visible.
  // Closing is fast and opening slow like an auto-exposure, the tv rig's iris is slower both
  // ways, and a cut (camera jump over CUT_JUMP_M, or a mode change) arrives already exposed.
  let ev = 0
  let lastMode: CameraMode | null = null
  const lastExposureCam = new THREE.Vector3(NaN, NaN, NaN)
  const _sunNdc = new THREE.Vector3()
  const sunFrame: SunFrame = { ndcX: 0, ndcY: 0, cosFwd: 0, elevation: 0, viewDir: new THREE.Vector3(), colour: new THREE.Color(), ev: 0 }
  const adaptExposure = (dt: number) => {
    // the camera was moved this frame but not yet re-derived by the renderer: refresh so the
    // projection below describes THIS frame (post.render repeats the two lines for its reprojection)
    camera.updateMatrixWorld()
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert()
    _sunNdc.copy(sunDirection).multiplyScalar(5000).add(camera.position).project(camera)
    sunFrame.viewDir.copy(sunDirection).transformDirection(camera.matrixWorldInverse)
    const cosFwd = -sunFrame.viewDir.z
    const elevation = elevationWeight(sunDirection.y)
    const weight = sunFrameWeight(_sunNdc.x, _sunNdc.y, cosFwd) * elevation
    const vis = post ? post.sunVisibility(dt) : 1
    const target = glareTargetEv(weight, vis, warm)
    const mode = post ? post.mode : null
    // NaN on the first frame counts as a jump: no ramp from 0 on frame one either
    const jumped = !(camera.position.distanceToSquared(lastExposureCam) <= CUT_JUMP_M * CUT_JUMP_M)
    if (jumped || mode !== lastMode) {
      ev = target
    } else {
      const tau = adaptTau(mode)
      ev = adaptEv(ev, target, dt, tau.darken, tau.brighten)
    }
    lastExposureCam.copy(camera.position)
    lastMode = mode
    renderer.toneMappingExposure = baseExposure(warm) * 2 ** ev
    if (post) {
      sunFrame.ndcX = _sunNdc.x
      sunFrame.ndcY = _sunNdc.y
      sunFrame.cosFwd = cosFwd
      sunFrame.elevation = elevation
      sunFrame.colour.copy(u.uDiscColor!.value as THREE.Color)
      sunFrame.ev = ev
      post.setSun(sunFrame)
    }
  }

  const render = (dt: number, wind = 2) => {
    renderer.info.reset()
    extras.update(dt, sunDirection, wind)
    adaptExposure(dt)
    renderer.shadowMap.needsUpdate = shadowDirty
    shadowDirty = false
    sunMoved = false
    frameNo++
    if (post) post.render(dt)
    else renderer.render(scene, camera)
  }
  const setSize = (w: number, h: number) => {
    renderer.setSize(w, h, false)
    post?.setSize(w, h, renderer.getPixelRatio())
  }
  const setResolutionScale = (k: number) => {
    renderer.setPixelRatio(basePixelRatio * THREE.MathUtils.clamp(k, 0.5, 1))
    return renderer.getPixelRatio()
  }

  return {
    renderer,
    scene,
    csm,
    sunDirection,
    tier,
    quality: q,
    caps,
    depthMode,
    post,
    render,
    setSize,
    setResolutionScale,
    setTimeOfDay,
    setupMaterials,
    updateShadows,
    refreshMaterials,
    forceShadowUpdate: () => {
      shadowDirty = true
      frameNo = 0
    },
    dispose: () => {
      if (envTimer) clearTimeout(envTimer)
      post?.dispose()
      csm.dispose()
      envTarget?.dispose()
      dome.geometry.dispose()
      ;(dome.material as THREE.Material).dispose()
      pmrem.dispose()
      sky.material.dispose()
      sky.geometry.dispose()
      // every geometry / material still in the scene (deduplicated: many meshes share them)
      const geos = new Set<THREE.BufferGeometry>()
      const mats = new Set<THREE.Material>()
      scene.traverse((o) => {
        const m = o as THREE.Mesh
        if (m.geometry) geos.add(m.geometry)
        if (m.material) for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mats.add(mat)
      })
      for (const g of geos) g.dispose()
      for (const m of mats) m.dispose()
      disposeAll()
      renderer.dispose()
    },
  }
}
