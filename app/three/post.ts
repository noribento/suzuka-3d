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
import {
  CUT_JUMP_M,
  FLARE_GAIN,
  HDR_MAX,
  SUN_DISC_RADIUS,
  SUN_GLSL_FLARE,
  SUN_GLSL_FLARE_PARS,
  SUN_PROBE_BACKOFF_FRAMES,
  SUN_PROBE_DISC_FRACTION,
  SUN_PROBE_EDGE,
  SUN_PROBE_FAR_DEPTH,
  SUN_PROBE_HALF_ANGLE_DEG,
  SUN_PROBE_MIN,
  flareScale,
  glslFloat,
  smoothVis,
  sunFade,
  sunNear,
} from './sun-model'
import type { Quality } from './quality'
import type { DepthMode } from './scene'
import type { CameraMode } from '~/composables/useRaceStore'

/**
 * Post-processing chain used on the "high" quality tier:
 *
 *   ScenePass (one MSAA half-float target with a float depth texture, resolved and copied into
 *   the composer's single-sampled ping-pong through a sanitizing copy: NaN → 0, ≤ HDR_MAX)
 *   → SunProbe (1×1: is the sun actually visible?) → GTAO (half-res, from the depth texture,
 *   follow modes) → UnrealBloomPass → long-lens DoF (tv camera under 8°) → grade (camera-motion
 *   blur, colour, lens veil / streak / ghosts around the sun, vignette, grain, corner chromatic
 *   aberration) → OutputPass (tone mapping + sRGB) → SMAA
 *
 * Everything runs in linear HDR until the OutputPass, so emissive surfaces above 1.0
 * (brake discs, start lights, sparks) bloom naturally. The scene target owns the only MSAA
 * storage (the ping-pong buffers have neither samples nor depth), and its resolved
 * DEPTH_COMPONENT32F texture is what the depth-reading passes consume on the reversed-Z path.
 * The sun's energy is bounded at the source (the Sky patch, see ./sun-model.ts); this chain
 * only measures it (probe) and adds what a lens would (grade).
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
    // sun / lens block (declared in SUN_GLSL_FLARE_PARS, fed by setSun / setMode / render)
    uSunWeight: { value: 0 },
    uSunFade: { value: 0 },
    uSunVis: { value: 1 },
    uSunNdc: { value: new THREE.Vector2() },
    uSunDir: { value: new THREE.Vector3(0, 0, -1) },
    uSunColor: { value: new THREE.Color(1, 1, 1) },
    uTanHalfFov: { value: 1 },
    uAspect: { value: 1 },
    uFlareScale: { value: 1 },
    uStreakGain: { value: 0 },
    uGhostGain: { value: 0 },
    uVeilGain: { value: 0 },
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
    ${SUN_GLSL_FLARE_PARS}

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
      // what the lens adds with the sun in (or just outside) the picture: veil, streak, ghosts
      ${SUN_GLSL_FLARE}
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
 * The resolve copy, sanitized: a NaN texel would spread through every bloom mip and a
 * 1e4-linear specular glint would feed the 704 px bloom veil, so this copy — the only thing
 * the later passes ever read — selects NaN → 0 (by bvec mix, not arithmetic: NaN × 0 is NaN)
 * and clamps to [0, HDR_MAX]. isnan() is fine here: the chain only runs on GLSL ES 3.00 GPUs.
 */
const SanitizeCopyShader = {
  uniforms: { tDiffuse: { value: null as THREE.Texture | null } },
  vertexShader: CopyShader.vertexShader,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() {
      vec4 texel = texture2D(tDiffuse, vUv);
      vec3 c = mix(texel.rgb, vec3(0.0), isnan(texel.rgb));
      gl_FragColor = vec4(clamp(c, 0.0, ${glslFloat(HDR_MAX)}), texel.a);
    }
  `,
}

/**
 * Is the sun actually visible, or behind the pit building / a grandstand roof / the tree
 * ring? A 1×1 RGBA8 target (the one format every WebGL2 implementation can read back) holding
 * the fraction of taps around the sun's NDC that see sky:
 *   - reversed-Z path: 5×5 taps of the resolved depth within ±SUN_PROBE_HALF_ANGLE_DEG, a tap
 *     counts when the depth is still the clear value (far = 0);
 *   - log depth (no readable depth): 3×3 luminance taps on the sanitized scene copy within
 *     SUN_PROBE_DISC_FRACTION of the disc radius, counted above SUN_PROBE_MIN — only the disc
 *     gets there (emissive.ts ordering contract).
 * One async readback in flight at a time; a failed read backs off for SUN_PROBE_BACKOFF_FRAMES
 * and the last value stands. Nothing is rendered while the sun is out of frame (the value
 * stands then too). The result gates BOTH the exposure adaptation (scene.ts) and the lens
 * block of the grade, so an occluded sun neither stops the camera down nor draws ghosts.
 */
class SunProbe {
  readonly target: THREE.WebGLRenderTarget
  private readonly mat: THREE.ShaderMaterial
  private readonly quad: FullScreenQuad
  private readonly pixel = new Uint8Array(4)
  private inFlight = false
  private backoff = 0
  private wanted = false
  private visRaw = 1
  private visSmooth = 1

  constructor(private readonly depthTexture: THREE.DepthTexture | null) {
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      depthBuffer: false,
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
    })
    this.target.texture.name = 'sunProbe'
    const defines: Record<string, string> = { FAR_DEPTH: glslFloat(SUN_PROBE_FAR_DEPTH), PROBE_MIN: glslFloat(SUN_PROBE_MIN) }
    if (depthTexture) defines.SUN_PROBE_DEPTH = ''
    this.mat = new THREE.ShaderMaterial({
      defines,
      uniforms: {
        tSrc: { value: null as THREE.Texture | null },
        uSunUv: { value: new THREE.Vector2(0.5, 0.5) },
        uStep: { value: new THREE.Vector2(0, 0) },
      },
      vertexShader: CopyShader.vertexShader,
      fragmentShader: /* glsl */ `
        uniform sampler2D tSrc;
        uniform vec2 uSunUv;
        uniform vec2 uStep;
        void main() {
          float n = 0.0;
          float hit = 0.0;
          #ifdef SUN_PROBE_DEPTH
            // 5×5 taps over ±2 steps: the sun shows wherever the resolved reversed-Z depth is still
            // at its clear value (0 = far), i.e. nothing was drawn over the sky there
            for (int i = -2; i <= 2; i++) {
              for (int j = -2; j <= 2; j++) {
                vec2 uv = uSunUv + uStep * vec2(float(i), float(j));
                if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) continue;
                n += 1.0;
                hit += texture2D(tSrc, uv).x <= FAR_DEPTH ? 1.0 : 0.0;
              }
            }
          #else
            // 3×3 luminance taps inside the disc on the sanitized copy: only the disc clears PROBE_MIN
            for (int i = -1; i <= 1; i++) {
              for (int j = -1; j <= 1; j++) {
                vec2 uv = uSunUv + uStep * vec2(float(i), float(j));
                if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) continue;
                n += 1.0;
                vec3 c = texture2D(tSrc, uv).rgb;
                hit += dot(c, vec3(0.2126, 0.7152, 0.0722)) > PROBE_MIN ? 1.0 : 0.0;
              }
            }
          #endif
          // with no tap inside the frame nothing can be said: report visible
          gl_FragColor = vec4(n > 0.0 ? hit / n : 1.0, 0.0, 0.0, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    })
    this.quad = new FullScreenQuad(this.mat)
  }

  /** the smoothed visibility as of the last `visibility()` call */
  get current(): number {
    return this.visSmooth
  }

  /** Where to look (NDC) and whether to look at all this frame. */
  setSun(ndcX: number, ndcY: number, wanted: boolean) {
    this.wanted = wanted
    if (wanted) this.mat.uniforms.uSunUv!.value.set(ndcX * 0.5 + 0.5, ndcY * 0.5 + 0.5)
  }

  /** Tap spacing in uv for the current lens (tan of half the vertical FOV, aspect). */
  setLens(tanHalfFov: number, aspect: number) {
    // depth: 2 steps span the half angle; luminance: 1 step spans the disc fraction. NDC → uv halves both.
    const step = this.depthTexture
      ? (0.25 * Math.tan((SUN_PROBE_HALF_ANGLE_DEG * Math.PI) / 180)) / tanHalfFov
      : (0.5 * SUN_PROBE_DISC_FRACTION * SUN_DISC_RADIUS) / tanHalfFov
    this.mat.uniforms.uStep!.value.set(step / Math.max(aspect, 1e-3), step)
  }

  /** Render the probe (right after the ScenePass copy; `sceneCopy` is the sanitized read buffer) and start a readback. */
  render(renderer: THREE.WebGLRenderer, sceneCopy: THREE.Texture) {
    if (this.backoff > 0) this.backoff--
    if (!this.wanted) return
    this.mat.uniforms.tSrc!.value = this.depthTexture ?? sceneCopy
    renderer.setRenderTarget(this.target)
    this.quad.render(renderer)
    if (this.inFlight || this.backoff > 0) return
    this.inFlight = true
    renderer.readRenderTargetPixelsAsync(this.target, 0, 0, 1, 1, this.pixel).then(
      () => {
        this.visRaw = (this.pixel[0] ?? 255) / 255
        this.inFlight = false
      },
      () => {
        // context lost, or a read the driver refused: keep the last value and try again later
        this.inFlight = false
        this.backoff = SUN_PROBE_BACKOFF_FRAMES
      },
    )
  }

  /** Smoothed visibility (TAU_VIS); call once per frame. */
  visibility(dt: number): number {
    this.visSmooth = smoothVis(this.visSmooth, this.visRaw, dt)
    return this.visSmooth
  }

  dispose() {
    this.target.dispose()
    this.mat.dispose()
    this.quad.dispose()
  }
}

/**
 * Renders the scene into the dedicated (multisampled, depth-textured) scene target and copies
 * the resolved colour into the composer's read buffer: one cheap full-screen draw, and the
 * later passes never touch MSAA storage. The sun probe reads right after the copy so it sees
 * this frame's depth and the sanitized colour.
 */
class ScenePass extends Pass {
  private readonly copy: FullScreenQuad
  private readonly copyMat: THREE.ShaderMaterial

  constructor(private readonly scene: THREE.Scene, private readonly camera: THREE.Camera, readonly target: THREE.WebGLRenderTarget, private readonly probe: SunProbe) {
    super()
    this.needsSwap = false
    this.copyMat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(SanitizeCopyShader.uniforms),
      vertexShader: SanitizeCopyShader.vertexShader,
      fragmentShader: SanitizeCopyShader.fragmentShader,
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
    // the next pass binds its own target; the probe may leave the 1×1 target bound
    this.probe.render(renderer, readBuffer.texture)
  }

  override setSize(width: number, height: number) {
    // WebGLRenderTarget.setSize also resizes the attached depth texture
    this.target.setSize(width, height)
  }

  override dispose() {
    this.target.dispose()
    this.copyMat.dispose()
    this.copy.dispose()
    this.probe.dispose()
  }
}

/** Per-frame sun state handed to the chain by scene.render (one instance, reused). */
export interface SunFrame {
  /** sun in NDC (the projection of a point 5 km along the sun direction) */
  ndcX: number
  ndcY: number
  /** cosine of the angle between the sun and the view axis (≤ 0: behind the camera) */
  cosFwd: number
  /** horizon fade 0..1 (sun-model elevationWeight) */
  elevation: number
  /** sun direction in view space (unit, −z forward) */
  viewDir: THREE.Vector3
  /** disc colour, linear */
  colour: THREE.Color
  /** adapted exposure offset in stops */
  ev: number
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
  /** camera mode last passed to setMode: the exposure model in scene.ts snaps on a change and slows down for tv */
  readonly mode: CameraMode
  setSize: (w: number, h: number, pixelRatio: number) => void
  /** camera mode: gates AO (follow modes only), picks the lens flare gains and resets the motion-blur history on a switch */
  setMode: (mode: CameraMode) => void
  /** subject distance and lens for the tv depth of field (enabled only under 8°) */
  setFocus: (distance: number, fov: number) => void
  /** camera-motion blur amount 0..1 (0 disables the reprojection entirely) */
  setBlur: (k: number) => void
  /** forget the previous frame's camera (call on a cut so nothing smears for a frame) */
  resetMotion: () => void
  /** where the sun is this frame, for the lens block and the visibility probe; call before render() */
  setSun: (sun: SunFrame) => void
  /** smoothed sun visibility 0..1 from the probe (1 until something has been measured); call once per frame */
  sunVisibility: (dt: number) => number
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
  const probe = new SunProbe(depthTexture)
  composer.addPass(new ScenePass(scene, camera, sceneTarget, probe))
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
  // The sky never reaches it: the Sky patch knees it to SKY_MAX 3.0 (sun-model.ts), so the
  // radius stays what the emitters were tuned for.
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

  const gu = grade.uniforms
  let mode: CameraMode = 'overview'
  let motionValid = false
  const resetMotion = () => {
    motionValid = false
  }
  // lens flare per rig; `quality.flare` gates the streak and the ghosts (the veil is physics, not dirt)
  const applyFlareGains = (m: CameraMode) => {
    const g = FLARE_GAIN[m]
    gu.uStreakGain!.value = q.flare ? g.streak : 0
    gu.uGhostGain!.value = q.flare ? g.ghost : 0
    gu.uVeilGain!.value = g.veil
  }
  applyFlareGains(mode)
  const setMode = (m: CameraMode) => {
    if (m === mode) return
    mode = m
    resetMotion()
    applyFlareGains(m)
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

  const setSun = (s: SunFrame) => {
    const edge = Math.max(Math.abs(s.ndcX), Math.abs(s.ndcY))
    // the lens only sees a sun in front of it, above the horizon, with a real projection
    const facing = s.cosFwd > 0 && Number.isFinite(edge) ? s.elevation : 0
    gu.uSunWeight!.value = facing * sunNear(edge)
    gu.uSunFade!.value = facing * sunFade(edge)
    gu.uSunVis!.value = probe.current
    gu.uSunNdc!.value.set(s.ndcX, s.ndcY)
    gu.uSunDir!.value.copy(s.viewDir)
    gu.uSunColor!.value.copy(s.colour)
    gu.uFlareScale!.value = flareScale(s.ev)
    probe.setSun(s.ndcX, s.ndcY, facing > 0 && edge < SUN_PROBE_EDGE)
  }

  let time = 0
  const render = (dt: number) => {
    time += dt
    grade.uniforms.time!.value = time
    // the camera was moved this frame but not yet re-derived by the renderer: do it here so the
    // reprojection matrices describe THIS frame (scene.render did the same for the sun projection)
    camera.updateMatrixWorld()
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert()
    _viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    // a cut (tv camera change, director) jumps the camera: no history for that frame
    if (camera.position.distanceToSquared(_lastCamPos) > CUT_JUMP_M * CUT_JUMP_M) motionValid = false
    _lastCamPos.copy(camera.position)
    if (!motionValid) {
      gu.uPrevViewProj!.value.copy(_viewProj)
      motionValid = true
    }
    gu.uInvViewProj!.value.copy(_viewProj).invert()
    // the lens geometry for the sun block and the probe taps
    const cam = camera as THREE.PerspectiveCamera
    const tanHalfFov = Math.tan((cam.fov * Math.PI) / 360)
    gu.uTanHalfFov!.value = tanHalfFov
    gu.uAspect!.value = cam.aspect
    probe.setLens(tanHalfFov, cam.aspect)
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
    get mode() {
      return mode
    },
    setSize,
    setMode,
    setFocus,
    setBlur,
    resetMotion,
    setSun,
    sunVisibility: (dt: number) => probe.visibility(dt),
    render,
    dispose: () => {
      // every pass owns render targets / textures of its own (GTAO, bloom mips, SMAA, DoF, copy quad, probe)
      for (const p of composer.passes) p.dispose()
      composer.dispose()
      sceneTarget.dispose()
    },
  }
}
