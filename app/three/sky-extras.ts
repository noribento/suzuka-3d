import * as THREE from 'three'
import { cloudTexture, flareTexture, treeLineTexture } from './textures'
import type { Quality } from './quality'

/**
 * Backdrop extras: a slowly drifting, sun-lit cloud layer, a sun flare drawn in screen space,
 * and a distant tree-line ring that hides the edge of the terrain.
 */

export interface SkyExtras {
  group: THREE.Group
  /** call every frame with the current sun direction (unit), camera and wind speed (m/s) */
  update: (dt: number, sun: THREE.Vector3, camera: THREE.PerspectiveCamera, wind?: number) => void
  /** sun colour and warmth (1 = midday, 0 = sunset) for the cloud shading; from setTimeOfDay */
  setSun: (color: THREE.Color, warm: number) => void
}

const _ndc = new THREE.Vector3()
const _dir = new THREE.Vector3()

// The cloud dome is a hand-written material so it can be lit: bases darken away from the sun,
// the sun side warms up at low sun, and the layer drifts with the wind. The logdepthbuf chunks
// keep it depth-correct on the logarithmic (low / fallback) path; they expand to nothing otherwise.
const CloudShader = {
  vertexShader: /* glsl */ `
    #include <common>
    #include <logdepthbuf_pars_vertex>
    varying vec2 vUv;
    varying vec3 vDir;
    void main() {
      vUv = uv;
      vDir = normalize(position);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      #include <logdepthbuf_vertex>
    }
  `,
  fragmentShader: /* glsl */ `
    #include <common>
    #include <logdepthbuf_pars_fragment>
    uniform sampler2D uMap;
    uniform vec3 uSun;
    uniform vec3 uSunColor;
    uniform float uWarm;
    uniform float uTime;
    uniform vec2 uWind;
    uniform float uOpacity;
    varying vec2 vUv;
    varying vec3 vDir;
    void main() {
      #include <logdepthbuf_fragment>
      vec4 t = texture2D(uMap, vUv + uWind * uTime * 2e-5);
      // lit side faces the sun; the bases opposite it sit in their own shadow
      float lit = smoothstep(-0.2, 0.6, dot(vDir, uSun));
      vec3 c = mix(t.rgb * 0.72, t.rgb, lit) * mix(vec3(1.0), uSunColor, (1.0 - uWarm) * 0.6);
      gl_FragColor = vec4(c, t.a * uOpacity);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }
  `,
}

export function buildSkyExtras(centre: THREE.Vector3, quality?: Quality): SkyExtras {
  // alpha-to-coverage softens the cut-out edges, but only makes sense on a multisampled scene target
  const a2c = !!quality && quality.msaa > 0
  const group = new THREE.Group()
  group.name = 'skyExtras'

  // --- clouds: an inverted sphere with an alpha cloud map, only above the horizon -------------
  const cloudUniforms = {
    uMap: { value: null as THREE.Texture | null },
    uSun: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color(0xffedd4) },
    uWarm: { value: 1 },
    uTime: { value: 0 },
    uWind: { value: new THREE.Vector2(1, 0.2) },
    uOpacity: { value: 0.85 },
  }
  let clouds: THREE.Mesh | null = null
  if (!quality || quality.clouds) {
    cloudUniforms.uMap.value = cloudTexture()
    const cloudGeo = new THREE.SphereGeometry(9000, 48, 24, 0, Math.PI * 2, 0, Math.PI * 0.5)
    const cloudMat = new THREE.ShaderMaterial({
      uniforms: cloudUniforms,
      vertexShader: CloudShader.vertexShader,
      fragmentShader: CloudShader.fragmentShader,
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide,
      fog: false,
    })
    clouds = new THREE.Mesh(cloudGeo, cloudMat)
    clouds.position.copy(centre)
    clouds.renderOrder = -1
    group.add(clouds)
  }

  // --- distant tree line hiding the terrain edge ----------------------------------------------
  if (!quality || quality.ring) {
    // outside the 3400 × 2600 m terrain rectangle's short sides, tall enough to close the horizon
    const ringGeo = new THREE.CylinderGeometry(1900, 1900, 70, 96, 1, true)
    const ringMat = new THREE.MeshBasicMaterial({ map: treeLineTexture(), transparent: true, alphaTest: a2c ? 0.3 : 0.5, alphaToCoverage: a2c, side: THREE.DoubleSide, color: 0x2e4a2a })
    const ring = new THREE.Mesh(ringGeo, ringMat)
    ring.position.set(centre.x, centre.y + 40, centre.z)
    group.add(ring)
  }

  // --- sun flare: a bright core sprite at the sun plus two ghosts along the line to the centre
  const flares: THREE.Sprite[] = []
  let core: THREE.Sprite | null = null, ghost1: THREE.Sprite | null = null, ghost2: THREE.Sprite | null = null
  if (!quality || quality.flare) {
    const flareTex = flareTexture()
    const mk = (size: number, color: number, opacity: number) => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: flareTex, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, fog: false, toneMapped: false }))
      s.scale.setScalar(size)
      s.renderOrder = 100
      return s
    }
    core = mk(0.9, 0xfff2d0, 0.75)
    ghost1 = mk(0.35, 0xffc890, 0.22)
    ghost2 = mk(0.6, 0x90c8ff, 0.12)
    flares.push(core, ghost1, ghost2)
    for (const f of flares) group.add(f)
  }

  const setSun = (color: THREE.Color, warm: number) => {
    cloudUniforms.uSunColor.value.copy(color)
    cloudUniforms.uWarm.value = warm
  }

  const update = (dt: number, sun: THREE.Vector3, camera: THREE.PerspectiveCamera, wind = 2) => {
    if (clouds) {
      cloudUniforms.uTime.value += dt * Math.max(0.2, wind)
      cloudUniforms.uSun.value.copy(sun)
    }
    if (!core || !ghost1 || !ghost2) return
    // sun in normalised device coordinates
    _ndc.copy(sun).multiplyScalar(5000).add(camera.position).project(camera)
    const behind = _ndc.z > 1 || sun.dot(_dir.set(0, 0, -1).applyQuaternion(camera.quaternion)) < 0
    const inFrame = !behind && Math.abs(_ndc.x) < 1.35 && Math.abs(_ndc.y) < 1.35
    if (!inFrame) {
      for (const f of flares) f.visible = false
      return
    }
    // fade as the sun leaves the frame
    const edge = Math.max(Math.abs(_ndc.x), Math.abs(_ndc.y))
    const fade = 1 - THREE.MathUtils.smoothstep(edge, 0.9, 1.35)
    // the sprites sit just beyond the near plane (the overview uses an 8 m near plane)
    const dist = Math.max(2, camera.near * 2.5)
    const place = (s: THREE.Sprite, t: number, base: number, size: number) => {
      // t = 0 at the sun, 1 at the screen centre, >1 beyond
      const nx = _ndc.x * (1 - t)
      const ny = _ndc.y * (1 - t)
      _dir.set(nx, ny, 0.5).unproject(camera).sub(camera.position).normalize()
      s.position.copy(camera.position).addScaledVector(_dir, dist)
      ;(s.material as THREE.SpriteMaterial).opacity = base * fade
      s.scale.setScalar(size)
      s.visible = true
    }
    // scale the sprites to a fraction of the view height at that distance
    const k = dist * Math.tan((camera.fov * Math.PI) / 360)
    place(core, 0, 0.75, 0.55 * k)
    place(ghost1, 0.45, 0.22, 0.18 * k)
    place(ghost2, 1.25, 0.12, 0.32 * k)
  }

  return { group, update, setSun }
}
