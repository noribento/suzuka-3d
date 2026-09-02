import * as THREE from 'three'
import { Sky } from 'three/addons/objects/Sky.js'
import { CSM } from 'three/addons/csm/CSM.js'
import { setMaxAnisotropy } from './textures'
import { createPostChain, type PostChain } from './post'
import { buildSkyExtras } from './sky-extras'

export type ShadowMode = 'overview' | 'follow'
/**
 * Quality tier. `high` runs the HDR post-processing chain (bloom, grade) and the full
 * effects set; `low` renders straight to the canvas — used on software rasterisers such
 * as SwiftShader (headless tests) or when the page is opened with `?fx=0`.
 */
export type QualityTier = 'low' | 'high'

export interface SceneContext {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  csm: CSM
  sunDirection: THREE.Vector3
  tier: QualityTier
  post: PostChain | null
  /** Render one frame (through the post chain on the high tier). */
  render: (dt: number) => void
  /** Resize the renderer and the post-processing targets (CSS pixels). */
  setSize: (w: number, h: number) => void
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
  dispose: () => void
}

const CASCADES = 3
const SHADOW_MAP = 2048

function isSoftwareRenderer(renderer: THREE.WebGLRenderer): boolean {
  const gl = renderer.getContext()
  const info = gl.getExtension('WEBGL_debug_renderer_info')
  const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : ''
  return /swiftshader|llvmpipe|softpipe|software/i.test(name)
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

function pickTier(renderer: THREE.WebGLRenderer): QualityTier {
  const forced = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('fx') : null
  if (forced === '0') return 'low'
  if (forced === '1') return 'high'
  return isSoftwareRenderer(renderer) ? 'low' : 'high'
}

/**
 * Vertex-coloured sphere approximating the sky radiance (linear): blue zenith, hazy
 * horizon, a warm glow around the sun and green-brown ground bounce below the horizon.
 */
function buildLightingDome(sun: THREE.Vector3): THREE.Mesh {
  const geo = new THREE.SphereGeometry(40, 64, 40)
  const pos = geo.attributes.position as THREE.BufferAttribute
  const colors = new Float32Array(pos.count * 3)
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
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false }))
}

export function createScene(canvas: HTMLCanvasElement, camera: THREE.PerspectiveCamera, centre = new THREE.Vector3()): SceneContext {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', logarithmicDepthBuffer: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.NeutralToneMapping
  renderer.toneMappingExposure = 0.92
  renderer.shadowMap.enabled = true
  // Hardware depth-compare sampling (PCF) is not available on software rasterisers such as
  // SwiftShader (headless test runs); fall back to unfiltered maps there so shadows still render.
  const software = isSoftwareRenderer(renderer)
  renderer.shadowMap.type = software ? THREE.BasicShadowMap : THREE.PCFShadowMap
  const tier = pickTier(renderer)
  // draw-call statistics accumulate over the whole frame (post passes render several times)
  renderer.info.autoReset = false
  setMaxAnisotropy(renderer.capabilities.getMaxAnisotropy())

  const scene = new THREE.Scene()
  // aerial perspective: distant hills fade towards the horizon haze
  scene.fog = new THREE.FogExp2(0xc4d3e3, 0.00011)

  // --- sun: computed from the time of day at Suzuka (34.84° N) on race day (early October) ------
  const sunDirection = sunDirectionAt(14)
  const sunColor = new THREE.Color(0xffedd4)

  // --- sky + image-based lighting -----------------------------------------------------------
  const sky = new Sky()
  sky.scale.setScalar(15000)
  const u = sky.material.uniforms
  u.turbidity!.value = 3.2
  u.rayleigh!.value = 1.1
  u.mieCoefficient!.value = 0.0028
  u.mieDirectionalG!.value = 0.85
  u.sunPosition!.value.copy(sunDirection)
  scene.add(sky)
  // Image-based lighting comes from a bounded analytic dome (the Sky shader's sun disk overflows
  // the half-float PMREM target, and the blur then spreads NaN across the whole map).
  const pmrem = new THREE.PMREMGenerator(renderer)
  let envTarget: THREE.WebGLRenderTarget | null = null
  const buildEnvironment = () => {
    const envScene = new THREE.Scene()
    const dome = buildLightingDome(sunDirection)
    envScene.add(dome)
    const target = pmrem.fromScene(envScene, 0.04)
    dome.geometry.dispose()
    ;(dome.material as THREE.Material).dispose()
    envTarget?.dispose()
    envTarget = target
    scene.environment = target.texture
  }
  buildEnvironment()
  scene.environmentIntensity = 0.5

  // soft ground bounce (the sky dome already lights from above through the environment map)
  const hemi = new THREE.HemisphereLight(0xd6e4f5, 0x6f7f48, 0.28)
  scene.add(hemi)

  // --- cascaded shadow maps ---------------------------------------------------------------------
  const splits = [0.05, 0.3, 1]
  const csm = new CSM({
    camera,
    parent: scene,
    cascades: CASCADES,
    maxFar: 1500,
    mode: 'custom',
    customSplitsCallback: (_cascades: number, _near: number, _far: number, breaks: number[]) => {
      breaks.length = 0
      for (const b of splits.slice(splits.length - CASCADES)) breaks.push(b)
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
  for (const light of csm.lights) {
    light.color.copy(sunColor)
    light.shadow.normalBias = 0.2
    light.shadow.radius = 1.5
  }

  let currentMode: ShadowMode | null = null
  let lastFocus = -1
  let lastAspect = 0
  let lastFov = 0
  const updateShadows = (mode: ShadowMode, focusDistance: number) => {
    const d = Math.max(5, focusDistance)
    let maxFar: number
    let s0: number, s1: number
    if (mode === 'overview') {
      maxFar = Math.min(12000, d + 1800)
      s0 = Math.max(0.05, (d - 500) / maxFar)
      s1 = Math.min(0.95, (d + 400) / maxFar)
    } else {
      maxFar = 1500
      s0 = Math.min(0.5, (d + 25) / maxFar)
      s1 = Math.min(0.85, (d + 150) / maxFar)
    }
    if (s1 <= s0 + 0.02) s1 = s0 + 0.02
    const changed = mode !== currentMode || Math.abs(d - lastFocus) > d * 0.05 || camera.aspect !== lastAspect || camera.fov !== lastFov
    if (changed) {
      currentMode = mode
      lastFocus = d
      lastAspect = camera.aspect
      lastFov = camera.fov
      splits[0] = s0
      splits[1] = s1
      csm.maxFar = maxFar
      csm.updateFrustums()
      // bias scales with the texel footprint of each cascade
      for (const light of csm.lights) {
        const cam = light.shadow.camera
        const texel = (cam.right - cam.left) / SHADOW_MAP
        light.shadow.normalBias = Math.max(0.03, texel * 1.5)
        light.shadow.bias = -0.00005 - texel * 0.00004
      }
    }
    csm.update()
  }

  const setupMaterials = (root: THREE.Object3D) => {
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (!mesh.isMesh && !(obj as THREE.InstancedMesh).isInstancedMesh) return
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const m of mats) {
        if (!m || !(m as THREE.MeshStandardMaterial).isMeshStandardMaterial) continue
        if (m.userData.csm) continue
        csm.setupMaterial(m)
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

  const setTimeOfDay = (hour: number) => {
    sunDirection.copy(sunDirectionAt(hour))
    u.sunPosition!.value.copy(sunDirection)
    csm.lightDirection.copy(sunDirection).negate()
    buildEnvironment()
    // low sun: warmer, dimmer light, longer haze
    const elevation = Math.asin(sunDirection.y)
    const warm = THREE.MathUtils.smoothstep(elevation, 0.05, 0.5)
    sunColor.setHex(0xffa860).lerp(new THREE.Color(0xffedd4), warm)
    for (const light of csm.lights) {
      light.color.copy(sunColor)
      light.intensity = 2.9 * (0.5 + 0.5 * warm)
    }
    renderer.toneMappingExposure = 0.92 * (0.82 + 0.18 * warm)
    ;(scene.fog as THREE.FogExp2).color.setHex(0xe0c8a8).lerp(new THREE.Color(0xc4d3e3), warm)
    hemi.intensity = 0.28 * (0.6 + 0.4 * warm)
    scene.environmentIntensity = 0.5 * (0.6 + 0.4 * warm)
  }

  const extras = buildSkyExtras(centre)
  scene.add(extras.group)

  const post = tier === 'high' ? createPostChain(renderer, scene, camera) : null
  const render = (dt: number) => {
    renderer.info.reset()
    extras.update(dt, sunDirection, camera)
    if (post) post.render(dt)
    else renderer.render(scene, camera)
  }
  const setSize = (w: number, h: number) => {
    renderer.setSize(w, h, false)
    post?.setSize(w, h, renderer.getPixelRatio())
  }

  return {
    renderer,
    scene,
    csm,
    sunDirection,
    tier,
    post,
    render,
    setSize,
    setTimeOfDay,
    setupMaterials,
    updateShadows,
    refreshMaterials,
    dispose: () => {
      post?.dispose()
      csm.dispose()
      envTarget?.dispose()
      pmrem.dispose()
      sky.material.dispose()
      sky.geometry.dispose()
      renderer.dispose()
    },
  }
}
