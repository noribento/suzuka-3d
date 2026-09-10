import * as THREE from 'three'
import { cloudTexture } from './textures'
import type { Quality } from './quality'

/**
 * Backdrop extras: a slowly drifting, sun-lit cloud layer. The horizon itself is the DEM_FAR
 * skyline (terrain-far.ts `terrainFar`, ±35 km) — the tree-line cylinder that used to hide the
 * terrain's edge is gone with the real ring and ridges. The sun itself (disc, aureole) is drawn
 * by the Sky shader patch and the lens flare by the grade pass — see ./sun-model.ts.
 */

/**
 * The cloud dome's radius. 38 km puts the layer behind the whole skyline (the far ridges are at
 * 35 km) instead of cutting the horizon clouds off at the old 9 km. A camera flown to the edge
 * of its range is up to ~8 km from the centre, so the far side of the dome can be 46 km away —
 * beyond the 40 km far plane; the vertex shader therefore pins the dome to the far plane like
 * r185's Sky does (z = w, or 0 under the reversed depth range), and the depth test against the
 * ridge still hides the clouds behind the hills. No shader cut at the horizon (plan §1c).
 */
export const CLOUD_DOME_RADIUS = 38000
/** the dome was tuned at 9 km: the uv and the wind are scaled so the clouds keep their apparent size and drift */
const CLOUD_UV_SCALE = CLOUD_DOME_RADIUS / 9000

export interface SkyExtras {
  group: THREE.Group
  /** call every frame with the current sun direction (unit) and wind speed (m/s) */
  update: (dt: number, sun: THREE.Vector3, wind?: number) => void
  /** sun colour and warmth (1 = midday, 0 = sunset) for the cloud shading; from setTimeOfDay */
  setSun: (color: THREE.Color, warm: number) => void
}

// The cloud dome is a hand-written material so it can be lit: bases darken away from the sun,
// the sun side warms up at low sun, and the layer drifts with the wind. The logdepthbuf chunks
// keep it depth-correct on the logarithmic (low / fallback) path; they expand to nothing otherwise
// (the log depth is written from w, so the far-plane pin below does not disturb it).
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
      // pinned to the far plane (see CLOUD_DOME_RADIUS): NDC z 1 is the far plane, or the near
      // plane once the depth range is reversed — then far is 0
      #ifdef USE_REVERSED_DEPTH_BUFFER
        gl_Position.z = 0.0;
      #else
        gl_Position.z = gl_Position.w;
      #endif
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
  const group = new THREE.Group()
  group.name = 'skyExtras'

  // --- clouds: an inverted sphere with an alpha cloud map, only above the horizon -------------
  const cloudUniforms = {
    uMap: { value: null as THREE.Texture | null },
    uSun: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color(0xffedd4) },
    uWarm: { value: 1 },
    uTime: { value: 0 },
    uWind: { value: new THREE.Vector2(1, 0.2).multiplyScalar(CLOUD_UV_SCALE) },
    uOpacity: { value: 0.85 },
  }
  let clouds: THREE.Mesh | null = null
  if (!quality || quality.clouds) {
    cloudUniforms.uMap.value = cloudTexture()
    const cloudGeo = new THREE.SphereGeometry(CLOUD_DOME_RADIUS, 48, 24, 0, Math.PI * 2, 0, Math.PI * 0.5)
    const cloudUv = cloudGeo.attributes.uv as THREE.BufferAttribute
    for (let i = 0; i < cloudUv.count; i++) cloudUv.setXY(i, cloudUv.getX(i) * CLOUD_UV_SCALE, cloudUv.getY(i) * CLOUD_UV_SCALE)
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

  const setSun = (color: THREE.Color, warm: number) => {
    cloudUniforms.uSunColor.value.copy(color)
    cloudUniforms.uWarm.value = warm
  }

  const update = (dt: number, sun: THREE.Vector3, wind = 2) => {
    if (!clouds) return
    cloudUniforms.uTime.value += dt * Math.max(0.2, wind)
    cloudUniforms.uSun.value.copy(sun)
  }

  return { group, update, setSun }
}
