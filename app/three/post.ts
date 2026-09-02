import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'

/**
 * Post-processing chain used on the "high" quality tier:
 *
 *   RenderPass (MSAA, half-float, linear) → UnrealBloomPass → grade (vignette, grain,
 *   corner chromatic aberration) → OutputPass (tone mapping + sRGB)
 *
 * Everything runs in linear HDR until the OutputPass, so emissive surfaces above 1.0
 * (brake discs, start lights, sparks) bloom naturally. Depth-reading passes (GTAO, DOF)
 * are deliberately absent: the scene renders with a logarithmic depth buffer, which those
 * passes cannot decode.
 */

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    time: { value: 0 },
    resolution: { value: new THREE.Vector2(1, 1) },
    vignette: { value: 0.55 },
    grain: { value: 0.035 },
    aberration: { value: 0.9 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float time;
    uniform vec2 resolution;
    uniform float vignette;
    uniform float grain;
    uniform float aberration;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
      vec2 d = vUv - 0.5;
      float r2 = dot(d, d);
      // lateral chromatic aberration grows towards the corners (in texels)
      vec2 off = d * r2 * aberration * 4.0 / resolution;
      vec3 c;
      c.r = texture2D(tDiffuse, vUv + off).r;
      c.g = texture2D(tDiffuse, vUv).g;
      c.b = texture2D(tDiffuse, vUv - off).b;
      // natural lens vignette
      float v = 1.0 - smoothstep(0.18, 0.78, r2 * 2.2);
      c *= mix(1.0, v, vignette);
      // fine film grain (luminance-relative so shadows do not turn grey)
      float n = hash(vUv * resolution + fract(time * 7.31) * 100.0) - 0.5;
      c += n * grain * (0.15 + c);
      gl_FragColor = vec4(c, 1.0);
    }
  `,
}

export interface PostChain {
  composer: EffectComposer
  bloom: UnrealBloomPass
  grade: ShaderPass
  setSize: (w: number, h: number, pixelRatio: number) => void
  render: (dt: number) => void
  dispose: () => void
}

export function createPostChain(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): PostChain {
  const size = renderer.getSize(new THREE.Vector2())
  const pr = renderer.getPixelRatio()
  const target = new THREE.WebGLRenderTarget(Math.max(1, size.x * pr), Math.max(1, size.y * pr), {
    type: THREE.HalfFloatType,
    samples: 4,
  })
  const composer = new EffectComposer(renderer, target)
  composer.setPixelRatio(pr)
  composer.addPass(new RenderPass(scene, camera))
  // The scene is lit at ~1.0 linear for sunlit surfaces, so the threshold sits well above that:
  // only genuinely emissive things (start lights, brake discs, sparks, the sun disc) bloom.
  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.22, 0.3, 4.5)
  composer.addPass(bloom)
  const grade = new ShaderPass(GradeShader)
  composer.addPass(grade)
  composer.addPass(new OutputPass())

  const setSize = (w: number, h: number, pixelRatio: number) => {
    composer.setPixelRatio(pixelRatio)
    composer.setSize(w, h)
    grade.uniforms.resolution!.value.set(w * pixelRatio, h * pixelRatio)
  }
  setSize(size.x, size.y, pr)

  let time = 0
  const render = (dt: number) => {
    time += dt
    grade.uniforms.time!.value = time
    composer.render(dt)
  }

  return {
    composer,
    bloom,
    grade,
    setSize,
    render,
    dispose: () => {
      composer.dispose()
      target.dispose()
    },
  }
}
