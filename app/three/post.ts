import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js'
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js'
import { CopyShader } from 'three/addons/shaders/CopyShader.js'
import { BLOOM_THRESHOLD } from './emissive'
import type { Quality } from './quality'
import type { DepthMode } from './scene'
import type { CameraMode } from '~/composables/useRaceStore'

/**
 * Post-processing chain used on the "high" quality tier:
 *
 *   ScenePass (one MSAA half-float target with a float depth texture, resolved and copied into
 *   the composer's single-sampled ping-pong) → GTAO (half-res, from the depth texture, follow
 *   modes) → UnrealBloomPass → long-lens DoF (tv camera under 8°) → grade (camera-motion blur,
 *   vignette, grain, corner chromatic aberration) → OutputPass (tone mapping + sRGB) → SMAA
 *
 * Everything runs in linear HDR until the OutputPass, so emissive surfaces above 1.0
 * (brake discs, start lights, sparks) bloom naturally. The scene target owns the only MSAA
 * storage (the ping-pong buffers have neither samples nor depth), and its resolved
 * DEPTH_COMPONENT32F texture is what the depth-reading passes consume on the reversed-Z path.
 */

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    time: { value: 0 },
    resolution: { value: new THREE.Vector2(1, 1) },
    vignette: { value: 0.55 },
    grain: { value: 0.035 },
    aberration: { value: 0.9 },
    // camera-motion blur: reproject each pixel through last frame's view-projection
    uInvViewProj: { value: new THREE.Matrix4() },
    uPrevViewProj: { value: new THREE.Matrix4() },
    uBlur: { value: 0 },
    /** velocity cap as a fraction of the frame width */
    uMaxVel: { value: 0.015 },
    // broadcast look: ASC-CDL slope / offset / power, a touch of saturation, and a warm tint on
    // the highlights when the sun is low (uWarm = 1 at midday, 0 at sunset)
    uSlope: { value: new THREE.Vector3(1.03, 1.0, 0.97) },
    uOffset: { value: new THREE.Vector3(-0.004, 0.0, 0.006) },
    uPower: { value: 1.02 },
    uSaturation: { value: 1.08 },
    uWarm: { value: 1 },
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
    uniform sampler2D tDepth;
    uniform float time;
    uniform vec2 resolution;
    uniform float vignette;
    uniform float grain;
    uniform float aberration;
    uniform mat4 uInvViewProj;
    uniform mat4 uPrevViewProj;
    uniform float uBlur;
    uniform float uMaxVel;
    uniform vec3 uSlope;
    uniform vec3 uOffset;
    uniform float uPower;
    uniform float uSaturation;
    uniform float uWarm;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
    }

    // lateral chromatic aberration grows towards the corners (offset in texels)
    vec3 sampleScene(vec2 uv, vec2 off) {
      return vec3(texture2D(tDiffuse, uv + off).r, texture2D(tDiffuse, uv).g, texture2D(tDiffuse, uv - off).b);
    }

    void main() {
      vec2 d = vUv - 0.5;
      float r2 = dot(d, d);
      vec2 off = d * r2 * aberration * 4.0 / resolution;
      // natural lens vignette
      float v = 1.0 - smoothstep(0.18, 0.78, r2 * 2.2);
      vec3 c = sampleScene(vUv, off);
      if (uBlur > 0.0) {
        // world position from the (reversed, 0..1) depth, reprojected with the previous frame's
        // matrices: the screen-space displacement is the camera-motion velocity of that pixel
        float depth = texture2D(tDepth, vUv).x;
        vec4 clip = vec4(vUv * 2.0 - 1.0, depth, 1.0);
        vec4 w = uInvViewProj * clip;
        w /= w.w;
        vec4 pc = uPrevViewProj * w;
        vec2 pUv = pc.xy / pc.w * 0.5 + 0.5;
        vec2 vel = (vUv - pUv) * uBlur;
        vel *= min(1.0, uMaxVel / max(length(vel), 1e-5));
        // the centre of the picture stays sharp (weighted by the vignette falloff)
        vel *= (1.0 - v);
        if (length(vel) * resolution.x > 0.5) {
          for (int i = 0; i < 6; i++) {
            c += sampleScene(vUv + vel * (float(i) / 5.0 - 0.5), off);
          }
          c /= 7.0;
        }
      }
      // colour grade (still linear, before tone mapping)
      c = pow(max(c * uSlope + uOffset, 0.0), vec3(uPower));
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uSaturation);
      c *= mix(vec3(1.0), vec3(1.05, 0.98, 0.90), (1.0 - uWarm) * smoothstep(0.5, 2.0, l));
      c *= mix(1.0, v, vignette);
      // fine film grain (luminance-relative so shadows do not turn grey)
      float n = hash(vUv * resolution + fract(time * 7.31) * 100.0) - 0.5;
      c += n * grain * (0.15 + c);
      gl_FragColor = vec4(c, 1.0);
    }
  `,
}

/**
 * Long-lens depth of field for the tv camera: circle of confusion from the resolved float
 * depth (perspectiveDepthToViewZ is reversed-Z aware through the renderer's define), a 12-tap
 * Vogel disc where each tap is weighted by its own CoC so sharp pixels do not bleed into the
 * blur. Not BokehPass: that one re-renders the whole scene with a depth material.
 */
const DofShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    cameraNear: { value: 0.5 },
    cameraFar: { value: 20000 },
    uFocus: { value: 100 },
    uStrength: { value: 18 },
    uMaxCoc: { value: 6 },
    resolution: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    #include <packing>
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform float cameraNear;
    uniform float cameraFar;
    uniform float uFocus;
    uniform float uStrength;
    uniform float uMaxCoc;
    uniform vec2 resolution;
    varying vec2 vUv;

    float cocAt(vec2 uv) {
      float viewZ = -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, cameraNear, cameraFar);
      return clamp(uStrength * abs(viewZ - uFocus) / uFocus, 0.0, uMaxCoc);
    }

    void main() {
      float coc = cocAt(vUv);
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float wsum = 1.0;
      if (coc > 0.5) {
        const float GA = 2.39996323;
        for (int i = 0; i < 12; i++) {
          float r = sqrt((float(i) + 0.5) / 12.0);
          float a = float(i) * GA;
          vec2 uv = vUv + vec2(cos(a), sin(a)) * r * coc / resolution;
          float w = clamp(cocAt(uv) / coc, 0.0, 1.0);
          c += texture2D(tDiffuse, uv).rgb * w;
          wsum += w;
        }
      }
      gl_FragColor = vec4(c / wsum, 1.0);
    }
  `,
}

/**
 * Renders the scene into the dedicated (multisampled, depth-textured) scene target and copies
 * the resolved colour into the composer's read buffer: one cheap full-screen draw, and the
 * later passes never touch MSAA storage.
 */
class ScenePass extends Pass {
  private readonly copy: FullScreenQuad
  private readonly copyMat: THREE.ShaderMaterial

  constructor(private readonly scene: THREE.Scene, private readonly camera: THREE.Camera, readonly target: THREE.WebGLRenderTarget) {
    super()
    this.needsSwap = false
    this.copyMat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(CopyShader.uniforms),
      vertexShader: CopyShader.vertexShader,
      fragmentShader: CopyShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    })
    this.copyMat.uniforms.tDiffuse!.value = target.texture
    this.copy = new FullScreenQuad(this.copyMat)
  }

  override render(renderer: THREE.WebGLRenderer, _writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    renderer.setRenderTarget(this.target)
    renderer.clear()
    renderer.render(this.scene, this.camera)
    // leaving the target resolves the MSAA colour (and blits the depth into the depth texture)
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer)
    this.copy.render(renderer)
  }

  override setSize(width: number, height: number) {
    // WebGLRenderTarget.setSize also resizes the attached depth texture
    this.target.setSize(width, height)
  }

  override dispose() {
    this.target.dispose()
    this.copyMat.dispose()
    this.copy.dispose()
  }
}

export interface PostChain {
  composer: EffectComposer
  bloom: UnrealBloomPass
  grade: ShaderPass
  /** ambient occlusion from the depth texture (null without a readable depth or on tiers without it) */
  gtao: GTAOPass | null
  dof: ShaderPass | null
  /** the scene's own render target (MSAA on the high tier) */
  sceneTarget: THREE.WebGLRenderTarget
  /** resolved float depth of the scene (reversed-Z path only, null on log depth) */
  depthTexture: THREE.DepthTexture | null
  setSize: (w: number, h: number, pixelRatio: number) => void
  /** camera mode: gates AO (follow modes only) and resets the motion-blur history on a switch */
  setMode: (mode: CameraMode) => void
  /** subject distance and lens for the tv depth of field (enabled only under 8°) */
  setFocus: (distance: number, fov: number) => void
  /** camera-motion blur amount 0..1 (0 disables the reprojection entirely) */
  setBlur: (k: number) => void
  /** forget the previous frame's camera (call on a cut so nothing smears for a frame) */
  resetMotion: () => void
  render: (dt: number) => void
  dispose: () => void
}

const _viewProj = new THREE.Matrix4()
const _lastCamPos = new THREE.Vector3()

export function createPostChain(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, q: Quality, depthMode: DepthMode): PostChain {
  const size = renderer.getSize(new THREE.Vector2())
  const pr = renderer.getPixelRatio()
  const w = Math.max(1, Math.floor(size.x * pr))
  const h = Math.max(1, Math.floor(size.y * pr))
  // Only the reversed-Z path exposes a readable depth: a logarithmic depth buffer cannot be
  // decoded by the screen-space passes, so the fallback keeps a plain renderbuffer.
  const depthTexture = depthMode === 'reversed' ? new THREE.DepthTexture(w, h, THREE.FloatType) : null
  const sceneTarget = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    samples: q.msaa,
    depthTexture: depthTexture ?? undefined,
  })
  sceneTarget.texture.name = 'scene'
  const pingPong = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false })
  // the composer clones this target for its second buffer (EffectComposer.js:80)
  const composer = new EffectComposer(renderer, pingPong)
  composer.setPixelRatio(pr)
  composer.addPass(new ScenePass(scene, camera, sceneTarget))
  // Screen-space AO straight from the resolved depth: constructed WITHOUT parameters so its
  // internal normal target exists (setGBuffer dereferences it), then pointed at our depth so
  // normals come from depth and no G-buffer pass renders the scene a second time.
  let gtao: GTAOPass | null = null
  if (q.gtao && depthTexture) {
    gtao = new GTAOPass(scene, camera, w, h)
    gtao.setGBuffer(depthTexture, undefined)
    gtao.updateGtaoMaterial({ radius: 0.5, distanceExponent: 1, thickness: 0.5, distanceFallOff: 1, scale: 1.2, samples: 12, screenSpaceRadius: false })
    gtao.blendIntensity = 0.8
    // half resolution: the pass is upsampled by its own blend
    const baseSetSize = gtao.setSize.bind(gtao)
    gtao.setSize = (sw: number, sh: number) => baseSetSize(Math.ceil(sw / 2), Math.ceil(sh / 2))
    gtao.enabled = false
    composer.addPass(gtao)
  }
  // The scene is lit at ~1.0 linear for sunlit surfaces, so the threshold sits well above that.
  // Note the pass thresholds on REC709 *luminance*: the emitters that are meant to bloom (start
  // lights, hot brake discs, sparks, the garage strips) are sized in app/three/emissive.ts so
  // their luminance clears BLOOM_THRESHOLD; a saturated red needs ~21× intensity to do so.
  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.3, 0.45, BLOOM_THRESHOLD)
  composer.addPass(bloom)
  let dof: ShaderPass | null = null
  if (q.dof && depthTexture) {
    dof = new ShaderPass(DofShader)
    dof.uniforms.tDepth!.value = depthTexture
    dof.enabled = false
    composer.addPass(dof)
  }
  const grade = new ShaderPass(GradeShader)
  if (depthTexture) grade.uniforms.tDepth!.value = depthTexture
  composer.addPass(grade)
  composer.addPass(new OutputPass())
  // edge anti-aliasing on the tone-mapped image: catches the alpha-test / specular crawl that
  // the scene target's MSAA cannot (the composer moves renderToScreen to the last pass)
  if (q.smaa) composer.addPass(new SMAAPass())

  const setSize = (cssW: number, cssH: number, pixelRatio: number) => {
    composer.setPixelRatio(pixelRatio)
    // resizes the ping-pong buffers and every pass (ScenePass forwards to the scene target)
    composer.setSize(cssW, cssH)
    grade.uniforms.resolution!.value.set(cssW * pixelRatio, cssH * pixelRatio)
    if (dof) {
      dof.uniforms.resolution!.value.set(cssW * pixelRatio, cssH * pixelRatio)
      dof.uniforms.uMaxCoc!.value = 6 * pixelRatio
    }
  }
  setSize(size.x, size.y, pr)

  let mode: CameraMode = 'overview'
  let motionValid = false
  const resetMotion = () => {
    motionValid = false
  }
  const setMode = (m: CameraMode) => {
    if (m === mode) return
    mode = m
    resetMotion()
    if (gtao) gtao.enabled = m !== 'overview'
    if (dof && m !== 'tv') dof.enabled = false
  }
  const setFocus = (distance: number, fov: number) => {
    if (!dof) return
    dof.enabled = mode === 'tv' && fov < 8
    if (!dof.enabled) return
    dof.uniforms.uFocus!.value = Math.max(1, distance)
    // the 2° lens is the strongest; an 8° lens has no visible depth of field
    dof.uniforms.uStrength!.value = 18 * (8 / Math.max(fov, 2))
    const cam = camera as THREE.PerspectiveCamera
    dof.uniforms.cameraNear!.value = cam.near
    dof.uniforms.cameraFar!.value = cam.far
  }
  const setBlur = (k: number) => {
    grade.uniforms.uBlur!.value = depthTexture ? THREE.MathUtils.clamp(k, 0, 1) : 0
  }
  if (gtao) gtao.enabled = false

  let time = 0
  const render = (dt: number) => {
    time += dt
    grade.uniforms.time!.value = time
    // the camera was moved this frame but not yet re-derived by the renderer: do it here so the
    // reprojection matrices describe THIS frame
    camera.updateMatrixWorld()
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert()
    _viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    // a cut (tv camera change, director) jumps the camera: no history for that frame
    if (camera.position.distanceToSquared(_lastCamPos) > 40 * 40) motionValid = false
    _lastCamPos.copy(camera.position)
    const gu = grade.uniforms
    if (!motionValid) {
      gu.uPrevViewProj!.value.copy(_viewProj)
      motionValid = true
    }
    gu.uInvViewProj!.value.copy(_viewProj).invert()
    composer.render(dt)
    gu.uPrevViewProj!.value.copy(_viewProj)
  }

  return {
    composer,
    bloom,
    grade,
    gtao,
    dof,
    sceneTarget,
    depthTexture,
    setSize,
    setMode,
    setFocus,
    setBlur,
    resetMotion,
    render,
    dispose: () => {
      // every pass owns render targets / textures of its own (GTAO, bloom mips, SMAA, DoF, copy quad)
      for (const p of composer.passes) p.dispose()
      composer.dispose()
      sceneTarget.dispose()
    },
  }
}
