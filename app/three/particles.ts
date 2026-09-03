import * as THREE from 'three'
import { skidTexture, spriteTexture } from './textures'

/**
 * Pooled point-sprite particle system (sparks, tyre smoke, dust). Particles are integrated
 * on the CPU — a few thousand at most — and drawn in a single call. Colours are HDR so
 * sparks bloom on the high tier; on the low tier they simply clamp to yellow-white.
 * Sparks are stretched along their screen-space velocity; smoke picks one of three puff
 * sprites at a random rotation.
 */

// The logdepthbuf chunks are what let a hand-written ShaderMaterial depth-test correctly when
// the renderer uses a logarithmic depth buffer (every built-in material then writes a
// log-encoded gl_FragDepth); without them the sprites were compared with linear NDC depth and
// only survived against the sky. On a conventional / reversed depth buffer they expand to nothing.
const vertexShader = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  attribute vec3 aVel;
  attribute float aSeed;
  varying float vAlpha;
  varying vec3 vColor;
  varying vec2 vDir;
  varying float vStretch;
  varying float vSeed;
  uniform float uScale;
  uniform vec2 uViewport;
  void main() {
    vAlpha = aAlpha;
    vColor = aColor;
    vSeed = aSeed;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float size = aSize * uScale / max(1.0, -mv.z);
    gl_Position = projectionMatrix * mv;
    vDir = vec2(1.0, 0.0);
    vStretch = 0.0;
    #ifdef STRETCH
      // screen-space displacement over ~20 ms, in pixels: the sprite is stretched along it
      vec4 c2 = projectionMatrix * (modelViewMatrix * vec4(position + aVel * 0.02, 1.0));
      vec2 d = (c2.xy / max(c2.w, 1e-4) - gl_Position.xy / max(gl_Position.w, 1e-4)) * uViewport * 0.5;
      float len = length(d);
      if (len > 1e-3) vDir = d / len;
      vStretch = clamp(len / max(size, 1.0) * 0.5, 0.0, 3.0);
      size *= 1.0 + vStretch * 0.5;
    #endif
    gl_PointSize = size;
    #include <logdepthbuf_vertex>
  }
`

const fragmentShader = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D uMap;
  varying float vAlpha;
  varying vec3 vColor;
  varying vec2 vDir;
  varying float vStretch;
  varying float vSeed;
  void main() {
    #include <logdepthbuf_fragment>
    vec2 pc = gl_PointCoord - 0.5;
    vec2 uv;
    #ifdef STRETCH
      // gl_PointCoord's y runs down the sprite, screen y runs up
      vec2 dir = vec2(vDir.x, -vDir.y);
      vec2 r = vec2(pc.x * dir.x + pc.y * dir.y, -pc.x * dir.y + pc.y * dir.x);
      r.x /= (1.0 + vStretch);
      uv = r + 0.5;
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
    #else
      // one of three puffs from the strip, at a random rotation
      float a = vSeed * 6.2831853;
      float cs = cos(a), sn = sin(a);
      uv = clamp(vec2(pc.x * cs - pc.y * sn, pc.x * sn + pc.y * cs) + 0.5, 0.0, 1.0);
      uv.x = (uv.x + floor(fract(vSeed * 7.31) * 3.0)) / 3.0;
    #endif
    vec4 t = texture2D(uMap, uv);
    float a2 = t.a * vAlpha;
    if (a2 < 0.003) discard;
    gl_FragColor = vec4(vColor * a2, a2);
  }
`

export interface ParticleConfig {
  capacity: number
  kind: 'spark' | 'smoke'
  additive: boolean
  gravity: number
  drag: number
}

export class ParticleSystem {
  readonly points: THREE.Points
  private readonly pos: Float32Array
  private readonly vel: Float32Array
  private readonly size: Float32Array
  private readonly alpha: Float32Array
  private readonly color: Float32Array
  private readonly seed: Float32Array
  private readonly age: Float32Array
  private readonly life: Float32Array
  private readonly ground: Float32Array
  private readonly grow: Float32Array
  private head = 0
  private readonly material: THREE.ShaderMaterial
  alive = 0
  private prevAlive = 0
  /** index range touched since the last upload (emit + update), -1 when clean */
  private dirtyMin = -1
  private dirtyMax = -1
  private seedRng = 7

  constructor(private readonly cfg: ParticleConfig) {
    const n = cfg.capacity
    this.pos = new Float32Array(n * 3).fill(-1e4)
    this.vel = new Float32Array(n * 3)
    this.size = new Float32Array(n)
    this.alpha = new Float32Array(n)
    this.color = new Float32Array(n * 3)
    this.seed = new Float32Array(n)
    this.age = new Float32Array(n).fill(1e9)
    this.life = new Float32Array(n).fill(1)
    this.ground = new Float32Array(n)
    this.grow = new Float32Array(n)
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage))
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage))
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage))
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.color, 3).setUsage(THREE.DynamicDrawUsage))
    geo.setAttribute('aVel', new THREE.BufferAttribute(this.vel, 3).setUsage(THREE.DynamicDrawUsage))
    geo.setAttribute('aSeed', new THREE.BufferAttribute(this.seed, 1).setUsage(THREE.DynamicDrawUsage))
    // never culled: particles are all over the circuit
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6)
    this.material = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: spriteTexture(cfg.kind) }, uScale: { value: 400 }, uViewport: { value: new THREE.Vector2(1280, 720) } },
      defines: cfg.kind === 'spark' ? { STRETCH: 1 } : {},
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      blending: cfg.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      toneMapped: true,
    })
    this.points = new THREE.Points(geo, this.material)
    this.points.frustumCulled = false
    this.points.renderOrder = 5
    this.points.name = `particles-${cfg.kind}`
  }

  /** Point-size scale: half the viewport height in pixels (perspective attenuation); width for the streak length. */
  setViewport(heightPx: number, widthPx = (heightPx * 16) / 9) {
    this.material.uniforms.uScale!.value = heightPx * 0.5
    this.material.uniforms.uViewport!.value.set(widthPx, heightPx)
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, life: number, r: number, g: number, b: number, ground = -1e4, grow = 0) {
    const i = this.head
    this.head = (this.head + 1) % this.cfg.capacity
    this.pos[i * 3] = x
    this.pos[i * 3 + 1] = y
    this.pos[i * 3 + 2] = z
    this.vel[i * 3] = vx
    this.vel[i * 3 + 1] = vy
    this.vel[i * 3 + 2] = vz
    this.size[i] = size
    this.alpha[i] = 1
    this.color[i * 3] = r
    this.color[i * 3 + 1] = g
    this.color[i * 3 + 2] = b
    // sprite variant / rotation (effects only, never the race RNG)
    this.seedRng = (this.seedRng * 1664525 + 1013904223) >>> 0
    this.seed[i] = this.seedRng / 4294967296
    this.age[i] = 0
    this.life[i] = life
    this.ground[i] = ground
    this.grow[i] = grow
    this.touch(i)
  }

  private touch(i: number) {
    if (this.dirtyMin < 0 || i < this.dirtyMin) this.dirtyMin = i
    if (i > this.dirtyMax) this.dirtyMax = i
  }

  update(dt: number, windX = 0, windZ = 0) {
    if (dt <= 0) return
    const n = this.cfg.capacity
    const { pos, vel, age, life, alpha, size, ground, grow } = this
    const g = this.cfg.gravity
    const dragK = Math.max(0, 1 - this.cfg.drag * dt)
    let alive = 0
    for (let i = 0; i < n; i++) {
      if (age[i]! >= life[i]!) {
        if (pos[i * 3 + 1]! > -9e3) {
          // just retired: park it out of sight (one last upload of this index)
          pos[i * 3 + 1] = -1e4
          alpha[i] = 0
          this.touch(i)
        }
        continue
      }
      alive++
      this.touch(i)
      const a = (age[i]! += dt)
      const t = a / life[i]!
      vel[i * 3 + 1]! -= g * dt
      vel[i * 3]! = vel[i * 3]! * dragK + windX * dt
      vel[i * 3 + 2]! = vel[i * 3 + 2]! * dragK + windZ * dt
      vel[i * 3 + 1]! *= dragK
      pos[i * 3]! += vel[i * 3]! * dt
      pos[i * 3 + 1]! += vel[i * 3 + 1]! * dt
      pos[i * 3 + 2]! += vel[i * 3 + 2]! * dt
      // one bounce on the road
      if (pos[i * 3 + 1]! < ground[i]!) {
        pos[i * 3 + 1] = ground[i]!
        vel[i * 3 + 1] = -vel[i * 3 + 1]! * 0.35
        vel[i * 3]! *= 0.7
        vel[i * 3 + 2]! *= 0.7
      }
      alpha[i] = this.cfg.kind === 'spark' ? (1 - t) * (1 - t) : Math.sin(t * Math.PI) * 0.9
      if (grow[i]! > 0) size[i]! += grow[i]! * dt
    }
    this.alive = alive
    const wasAlive = this.prevAlive
    this.prevAlive = alive
    // nothing changed on the GPU side: an idle system uploads nothing
    if (this.dirtyMin < 0 || (alive === 0 && wasAlive === 0)) {
      this.dirtyMin = this.dirtyMax = -1
      return
    }
    // upload only the touched index range instead of the whole pool
    const geo = this.points.geometry
    const lo = this.dirtyMin, count = this.dirtyMax - this.dirtyMin + 1
    for (const name of ['position', 'aAlpha', 'aSize', 'aColor', 'aVel', 'aSeed'] as const) {
      const attr = geo.attributes[name] as THREE.BufferAttribute
      attr.clearUpdateRanges()
      attr.addUpdateRange(lo * attr.itemSize, count * attr.itemSize)
      attr.needsUpdate = true
    }
    this.dirtyMin = this.dirtyMax = -1
  }

  dispose() {
    this.points.geometry.dispose()
    this.material.dispose()
  }
}

const _wx = new THREE.Vector3()

interface SkidHead {
  pos: THREE.Vector3
  /** distance laid along this mark (metres) — the v coordinate of the streak texture */
  dist: number
}

/**
 * Skid marks: a ring buffer of road-hugging quads laid under a locked or spinning wheel.
 * Each quad carries a uv (u across the tyre, v along the mark in 0.5 m units) so the rubber
 * has streak texture and feathered edges, and a birth time so a mark fades over 90 s of race.
 */
export class SkidMarks {
  readonly mesh: THREE.Mesh
  private readonly pos: Float32Array
  private readonly alpha: Float32Array
  private readonly uv: Float32Array
  private readonly born: Float32Array
  private head = 0
  /** quads written so far (saturates at the capacity once the ring has wrapped) */
  private laid = 0
  private readonly last = new Map<number, SkidHead>()
  private readonly uTime = { value: 0 }

  constructor(private readonly capacity = 4000) {
    this.pos = new Float32Array(capacity * 4 * 3)
    this.alpha = new Float32Array(capacity * 4)
    this.uv = new Float32Array(capacity * 4 * 2)
    this.born = new Float32Array(capacity * 4)
    const idx = new Uint32Array(capacity * 6)
    for (let i = 0; i < capacity; i++) {
      const a = i * 4
      idx.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], i * 6)
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage))
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage))
    geo.setAttribute('aUv', new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage))
    geo.setAttribute('aBorn', new THREE.BufferAttribute(this.born, 1).setUsage(THREE.DynamicDrawUsage))
    geo.setIndex(new THREE.BufferAttribute(idx, 1))
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6)
    // only the quads laid so far are rasterised (the untouched part of the ring is never drawn)
    geo.setDrawRange(0, 0)
    const mat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: skidTexture() }, uTime: this.uTime },
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        attribute float aAlpha;
        attribute vec2 aUv;
        attribute float aBorn;
        varying float vA;
        varying vec2 vUv;
        varying float vBorn;
        void main() {
          vA = aAlpha;
          vUv = aUv;
          vBorn = aBorn;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          #include <logdepthbuf_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform sampler2D uMap;
        uniform float uTime;
        varying float vA;
        varying vec2 vUv;
        varying float vBorn;
        void main() {
          #include <logdepthbuf_fragment>
          // feathered edges across the tyre, streaks along it, 40 % lighter after 90 s
          float prof = smoothstep(0.0, 0.15, vUv.x) * smoothstep(1.0, 0.85, vUv.x);
          float tex = texture2D(uMap, vUv).r;
          float age = clamp((uTime - vBorn) / 90.0, 0.0, 1.0);
          gl_FragColor = vec4(0.02, 0.02, 0.022, vA * 0.6 * prof * (0.5 + 0.5 * tex) * (1.0 - 0.6 * age));
        }
      `,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    })
    this.mesh = new THREE.Mesh(geo, mat)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 2
    this.mesh.name = 'skidMarks'
  }

  /** Advance the fade clock (simulation seconds). */
  update(simDt: number) {
    if (simDt > 0) this.uTime.value += simDt
  }

  /** Extend the mark for wheel `key` (unique per car+wheel) to the wheel's current world position. */
  lay(key: number, wheelWorld: THREE.Vector3, sideDir: THREE.Vector3, width: number, strength: number) {
    const prev = this.last.get(key)
    if (!prev) {
      this.last.set(key, { pos: wheelWorld.clone(), dist: 0 })
      return
    }
    if (prev.pos.distanceToSquared(wheelWorld) < 0.04) return
    const i = this.head
    this.head = (this.head + 1) % this.capacity
    const hw = width / 2
    const v0 = prev.dist / 0.5
    const v1 = (prev.dist + prev.pos.distanceTo(wheelWorld)) / 0.5
    const now = this.uTime.value
    const set = (k: number, p: THREE.Vector3, sgn: number, v: number) => {
      _wx.copy(p).addScaledVector(sideDir, sgn * hw)
      const j = i * 4 + k
      this.pos[j * 3] = _wx.x
      this.pos[j * 3 + 1] = _wx.y + 0.012
      this.pos[j * 3 + 2] = _wx.z
      this.alpha[j] = strength
      this.uv[j * 2] = sgn > 0 ? 0 : 1
      this.uv[j * 2 + 1] = v
      this.born[j] = now
    }
    set(0, prev.pos, 1, v0)
    set(1, prev.pos, -1, v0)
    set(2, wheelWorld, 1, v1)
    set(3, wheelWorld, -1, v1)
    prev.dist += prev.pos.distanceTo(wheelWorld)
    prev.pos.copy(wheelWorld)
    // a quad never straddles the ring's wrap (the head is per quad), so one range per attribute
    // (three consumes and clears the ranges at upload, so several lays per frame just accumulate)
    const geo = this.mesh.geometry
    const posAttr = geo.attributes.position as THREE.BufferAttribute
    posAttr.addUpdateRange(i * 12, 12)
    posAttr.needsUpdate = true
    for (const name of ['aAlpha', 'aBorn'] as const) {
      const attr = geo.attributes[name] as THREE.BufferAttribute
      attr.addUpdateRange(i * 4, 4)
      attr.needsUpdate = true
    }
    const uvAttr = geo.attributes.aUv as THREE.BufferAttribute
    uvAttr.addUpdateRange(i * 8, 8)
    uvAttr.needsUpdate = true
    if (this.laid < this.capacity) {
      this.laid++
      geo.setDrawRange(0, this.laid * 6)
    }
  }

  end(key: number) {
    this.last.delete(key)
  }

  clear() {
    this.pos.fill(0)
    this.alpha.fill(0)
    this.uv.fill(0)
    this.born.fill(0)
    this.last.clear()
    this.laid = 0
    this.head = 0
    this.uTime.value = 0
    const geo = this.mesh.geometry
    geo.setDrawRange(0, 0)
    for (const name of ['position', 'aAlpha', 'aUv', 'aBorn'] as const) {
      const attr = geo.attributes[name] as THREE.BufferAttribute
      attr.clearUpdateRanges()
      attr.needsUpdate = true
    }
  }

  dispose() {
    this.mesh.geometry.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
  }
}
