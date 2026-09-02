import * as THREE from 'three'
import { spriteTexture } from './textures'

/**
 * Pooled point-sprite particle system (sparks, tyre smoke, dust). Particles are integrated
 * on the CPU — a few thousand at most — and drawn in a single call. Colours are HDR so
 * sparks bloom on the high tier; on the low tier they simply clamp to yellow-white.
 */

const vertexShader = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  varying float vAlpha;
  varying vec3 vColor;
  uniform float uScale;
  void main() {
    vAlpha = aAlpha;
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uScale / max(1.0, -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`

const fragmentShader = /* glsl */ `
  uniform sampler2D uMap;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec4 t = texture2D(uMap, gl_PointCoord);
    float a = t.a * vAlpha;
    if (a < 0.003) discard;
    gl_FragColor = vec4(vColor * a, a);
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
  private readonly age: Float32Array
  private readonly life: Float32Array
  private readonly ground: Float32Array
  private readonly grow: Float32Array
  private head = 0
  private readonly material: THREE.ShaderMaterial
  alive = 0

  constructor(private readonly cfg: ParticleConfig) {
    const n = cfg.capacity
    this.pos = new Float32Array(n * 3).fill(-1e4)
    this.vel = new Float32Array(n * 3)
    this.size = new Float32Array(n)
    this.alpha = new Float32Array(n)
    this.color = new Float32Array(n * 3)
    this.age = new Float32Array(n).fill(1e9)
    this.life = new Float32Array(n).fill(1)
    this.ground = new Float32Array(n)
    this.grow = new Float32Array(n)
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage))
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage))
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage))
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.color, 3).setUsage(THREE.DynamicDrawUsage))
    // never culled: particles are all over the circuit
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6)
    this.material = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: spriteTexture(cfg.kind) }, uScale: { value: 400 } },
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

  /** Point-size scale: half the viewport height in pixels (perspective attenuation). */
  setViewport(heightPx: number) {
    this.material.uniforms.uScale!.value = heightPx * 0.5
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
    this.age[i] = 0
    this.life[i] = life
    this.ground[i] = ground
    this.grow[i] = grow
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
          pos[i * 3 + 1] = -1e4
          alpha[i] = 0
        }
        continue
      }
      alive++
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
    const geo = this.points.geometry
    ;(geo.attributes.position as THREE.BufferAttribute).needsUpdate = true
    ;(geo.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true
    ;(geo.attributes.aSize as THREE.BufferAttribute).needsUpdate = true
    ;(geo.attributes.aColor as THREE.BufferAttribute).needsUpdate = true
  }

  dispose() {
    this.points.geometry.dispose()
    this.material.dispose()
  }
}

const _wx = new THREE.Vector3()

/**
 * Skid marks: a ring buffer of road-hugging quads laid under a locked or spinning wheel.
 */
export class SkidMarks {
  readonly mesh: THREE.Mesh
  private readonly pos: Float32Array
  private readonly alpha: Float32Array
  private head = 0
  private readonly last = new Map<number, THREE.Vector3>()

  constructor(private readonly capacity = 4000) {
    this.pos = new Float32Array(capacity * 4 * 3)
    this.alpha = new Float32Array(capacity * 4)
    const idx = new Uint32Array(capacity * 6)
    for (let i = 0; i < capacity; i++) {
      const a = i * 4
      idx.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], i * 6)
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage))
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage))
    geo.setIndex(new THREE.BufferAttribute(idx, 1))
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6)
    const mat = new THREE.ShaderMaterial({
      uniforms: {},
      vertexShader: /* glsl */ `
        attribute float aAlpha;
        varying float vA;
        void main() { vA = aAlpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        varying float vA;
        void main() { gl_FragColor = vec4(0.02, 0.02, 0.022, vA * 0.55); }
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

  /** Extend the mark for wheel `key` (unique per car+wheel) to the wheel's current world position. */
  lay(key: number, wheelWorld: THREE.Vector3, sideDir: THREE.Vector3, width: number, strength: number) {
    const prev = this.last.get(key)
    if (!prev) {
      this.last.set(key, wheelWorld.clone())
      return
    }
    if (prev.distanceToSquared(wheelWorld) < 0.04) return
    const i = this.head
    this.head = (this.head + 1) % this.capacity
    const hw = width / 2
    const set = (k: number, p: THREE.Vector3, sgn: number) => {
      _wx.copy(p).addScaledVector(sideDir, sgn * hw)
      this.pos[(i * 4 + k) * 3] = _wx.x
      this.pos[(i * 4 + k) * 3 + 1] = _wx.y + 0.012
      this.pos[(i * 4 + k) * 3 + 2] = _wx.z
      this.alpha[i * 4 + k] = strength
    }
    set(0, prev, 1)
    set(1, prev, -1)
    set(2, wheelWorld, 1)
    set(3, wheelWorld, -1)
    prev.copy(wheelWorld)
    ;(this.mesh.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true
    ;(this.mesh.geometry.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true
  }

  end(key: number) {
    this.last.delete(key)
  }

  clear() {
    this.pos.fill(0)
    this.alpha.fill(0)
    this.last.clear()
    ;(this.mesh.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true
    ;(this.mesh.geometry.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true
  }
}
