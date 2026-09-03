import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { COMPOUND_COLORS, DRIVERS, TEAMS, type Compound, type Driver } from '~/data/drivers'
import { brakeDiscMaps, carbonMaps, contactShadowTexture, flakeNormalMap, liveryTexture, numberTexture, podLiveryTexture, rimMaps, tyreMaps } from './textures'
import { driverFigure } from './driver-figure'
import { EMISSIVE, brakeDiscEmissive, emissiveScale } from './emissive'

/**
 * 2026-regulation Formula 1 car.
 *
 * Dimensions follow the 2026 technical regulations: 3.40 m wheelbase, 1.90 m overall
 * width, narrower tyres (270 / 375 mm on 18" rims), a shorter/narrower front wing and
 * active aerodynamics — both the front-wing flaps and the rear-wing flap rotate to a
 * low-drag "X-mode" on the straights (the animation hook is still called `setDrs`).
 *
 * Local frame: +Z forward (nose), +X left, +Y up. Origin at ground level, mid-wheelbase.
 */

const WHEELBASE = 3.4
const FRONT_TRACK_HALF = 0.815 // tyre centre → outer face at ±0.95
const REAR_TRACK_HALF = 0.7625
const WHEEL_R = 0.355
const RIM_R = 0.2286 // 18"
const FRONT_TYRE_W = 0.27
const REAR_TYRE_W = 0.375
const RIDE = 0.05
/** hand wheel : road wheel ratio (real F1 ≈ 8–10:1) and the binding limit of the hand wheel (±120°) */
const HAND_RATIO = 9
const HAND_LIMIT = 2.094
/** fraction of full Ackermann geometry applied to the front wheels */
const ACKERMANN = 0.6
/** kingpin caster (12°) and static negative camber, front 3.4° / rear 1.5° (rad) */
const CASTER = 0.209
const CAMBER_F = 0.059
const CAMBER_R = 0.026

// ---------------------------------------------------------------------------------------------
// geometry helpers

interface Section {
  z: number
  yBot: number
  yTop: number
  hw: number
  /** superellipse exponent: 2 = ellipse, 4+ = rounded box */
  n: number
  xc?: number
}

/**
 * Smooth loft through superellipse cross-sections. uv: x along (0 tail → 1 nose),
 * y around (0 bottom → 0.25 left → 0.5 top → 0.75 right → 1 bottom).
 */
function loft(sections: Section[], around = 32, capStart = true, capEnd = true): THREE.BufferGeometry {
  const pos: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  const N = sections.length
  const ring = around + 1
  const z0 = sections[0]!.z
  const zSpan = sections[N - 1]!.z - z0 || 1
  const along = (i: number) => (sections[i]!.z - z0) / zSpan
  for (let i = 0; i < N; i++) {
    const s = sections[i]!
    const yMid = (s.yTop + s.yBot) / 2
    const e = 2 / s.n
    for (let k = 0; k <= around; k++) {
      const th = -Math.PI / 2 + (k / around) * Math.PI * 2
      const cs = Math.cos(th), sn = Math.sin(th)
      const x = (s.xc ?? 0) + s.hw * Math.sign(cs) * Math.pow(Math.abs(cs), e)
      const y = sn >= 0 ? yMid + (s.yTop - yMid) * Math.pow(sn, e) : yMid - (yMid - s.yBot) * Math.pow(-sn, e)
      pos.push(x, y, s.z)
      uv.push(along(i), k / around)
    }
  }
  for (let i = 0; i < N - 1; i++) {
    for (let k = 0; k < around; k++) {
      const a = i * ring + k
      const b = a + 1
      const c = a + ring
      const d = c + 1
      idx.push(a, b, c, b, d, c)
    }
  }
  const capAt = (i: number, forward: boolean) => {
    const s = sections[i]!
    const centre = pos.length / 3
    pos.push(s.xc ?? 0, (s.yTop + s.yBot) / 2, s.z)
    uv.push(along(i), 0.5)
    for (let k = 0; k < around; k++) {
      const a = i * ring + k
      const b = a + 1
      if (forward) idx.push(centre, a, b)
      else idx.push(centre, b, a)
    }
  }
  if (capEnd) capAt(N - 1, true)
  if (capStart) capAt(0, false)
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.setIndex(idx)
  g.computeVertexNormals()
  // stitch the seam normals so the uv seam at the bottom is invisible
  const nrm = g.attributes.normal as THREE.BufferAttribute
  for (let i = 0; i < N; i++) {
    const a = i * ring, b = i * ring + around
    const nx = nrm.getX(a) + nrm.getX(b), ny = nrm.getY(a) + nrm.getY(b), nz = nrm.getZ(a) + nrm.getZ(b)
    const l = Math.hypot(nx, ny, nz) || 1
    nrm.setXYZ(a, nx / l, ny / l, nz / l)
    nrm.setXYZ(b, nx / l, ny / l, nz / l)
  }
  return g
}

/** Mirror a geometry across the YZ plane, keeping faces outward. */
function mirrorX(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = src.clone()
  const p = g.attributes.position as THREE.BufferAttribute
  for (let i = 0; i < p.count; i++) p.setX(i, -p.getX(i))
  const n = g.attributes.normal as THREE.BufferAttribute | undefined
  if (n) for (let i = 0; i < n.count; i++) n.setX(i, -n.getX(i))
  const index = g.index
  if (index) {
    const arr = index.array
    for (let i = 0; i < arr.length; i += 3) {
      const t = arr[i + 1]!
      arr[i + 1] = arr[i + 2]!
      arr[i + 2] = t
    }
    index.needsUpdate = true
  } else {
    for (let i = 0; i < p.count; i += 3) {
      const x1 = p.getX(i + 1), y1 = p.getY(i + 1), z1 = p.getZ(i + 1)
      p.setXYZ(i + 1, p.getX(i + 2), p.getY(i + 2), p.getZ(i + 2))
      p.setXYZ(i + 2, x1, y1, z1)
      if (n) {
        const nx1 = n.getX(i + 1), ny1 = n.getY(i + 1), nz1 = n.getZ(i + 1)
        n.setXYZ(i + 1, n.getX(i + 2), n.getY(i + 2), n.getZ(i + 2))
        n.setXYZ(i + 2, nx1, ny1, nz1)
      }
    }
  }
  return g
}

function box(w: number, h: number, d: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d)
  // world-scale uv (metres) so the carbon weave has the same size as on the extruded parts
  // (BoxGeometry emits 0..1 per face; faces in the order +x, -x, +y, -y, +z, -z, 4 vertices each)
  const uv = g.attributes.uv as THREE.BufferAttribute
  const faces = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]] as const
  for (let i = 0; i < uv.count; i++) {
    const f = faces[Math.floor(i / 4)]!
    uv.setXY(i, uv.getX(i) * f[0], uv.getY(i) * f[1])
  }
  g.rotateX(rx)
  g.rotateY(ry)
  g.rotateZ(rz)
  g.translate(x, y, z)
  return g
}

const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _m = new THREE.Matrix4()
const _Y = new THREE.Vector3(0, 1, 0)
const _hand = new THREE.Vector3()
const _dir = new THREE.Vector3()

/** Slim rod between two points (suspension arms, pylons). */
function rod(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, flat = 1): THREE.BufferGeometry {
  _a.set(ax, ay, az)
  _b.set(bx, by, bz)
  const len = _a.distanceTo(_b)
  const g = new THREE.CylinderGeometry(r, r, len, 8, 1)
  // world-scale uv (metres): u around the circumference, v along the rod
  const uv = g.attributes.uv as THREE.BufferAttribute
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2 * Math.PI * r, uv.getY(i) * len)
  g.scale(flat, 1, 1)
  _q.setFromUnitVectors(_Y, _b.clone().sub(_a).normalize())
  _m.compose(_a.clone().add(_b).multiplyScalar(0.5), _q, new THREE.Vector3(1, 1, 1))
  g.applyMatrix4(_m)
  return g
}

/** Inverted (downforce) aerofoil, leading edge at local z = 0, trailing edge at z = -chord, span centred on x = 0. */
function wingElement(chord: number, span: number, thickness: number, camber: number, dihedral = 0, taper = 1): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = []
  const steps = 18
  const th = (t: number) => thickness * 5 * (0.2969 * Math.sqrt(t) - 0.126 * t - 0.3516 * t * t + 0.2843 * t ** 3 - 0.1036 * t ** 4)
  const yc = (t: number) => -camber * 4 * t * (1 - t)
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    pts.push(new THREE.Vector2(t * chord, yc(t) + th(t)))
  }
  for (let i = steps - 1; i > 0; i--) {
    const t = i / steps
    pts.push(new THREE.Vector2(t * chord, yc(t) - th(t)))
  }
  const shape = new THREE.Shape(pts)
  const g = new THREE.ExtrudeGeometry(shape, { depth: span, bevelEnabled: false, steps: 12, curveSegments: 4 })
  // shape (x_s: chord, y_s: up, z_s: span) → car (z_s − span/2, y_s, −x_s), a proper rotation
  const m = new THREE.Matrix4().set(
    0, 0, 1, -span / 2,
    0, 1, 0, 0,
    -1, 0, 0, 0,
    0, 0, 0, 1,
  )
  g.applyMatrix4(m)
  if (dihedral !== 0 || taper !== 1) {
    const p = g.attributes.position as THREE.BufferAttribute
    const half = span / 2
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i)
      const t = Math.abs(x) / half
      p.setY(i, p.getY(i) + dihedral * t * t)
      p.setZ(i, p.getZ(i) * (1 - (1 - taper) * t))
    }
    g.computeVertexNormals()
  }
  return g
}

/** Thin vertical plate from a polygon in the (z, y) plane, extruded along x. */
function plate(zy: [number, number][], thickness: number, x: number): THREE.BufferGeometry {
  const shape = new THREE.Shape(zy.map(([z, y]) => new THREE.Vector2(-z, y)))
  const g = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 6 })
  const m = new THREE.Matrix4().set(
    0, 0, 1, x - thickness / 2,
    0, 1, 0, 0,
    -1, 0, 0, 0,
    0, 0, 0, 1,
  )
  g.applyMatrix4(m)
  return g
}

/** Flat horizontal plate from a polygon in the (x, z) plane, extruded down by `thickness` from y. */
function slab(xz: [number, number][], thickness: number, y: number): THREE.BufferGeometry {
  const shape = new THREE.Shape(xz.map(([x, z]) => new THREE.Vector2(x, z)))
  const g = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false })
  // shape (x_s, y_s = z, z_s = extrude) → car (x_s, y − z_s, y_s): a proper rotation
  const m = new THREE.Matrix4().set(
    1, 0, 0, 0,
    0, 0, -1, y,
    0, 1, 0, 0,
    0, 0, 0, 1,
  )
  g.applyMatrix4(m)
  return g
}

// ---------------------------------------------------------------------------------------------
// shared geometry

interface SharedGeometry {
  body: THREE.BufferGeometry
  podL: THREE.BufferGeometry
  podR: THREE.BufferGeometry
  paint: THREE.BufferGeometry
  carbon: THREE.BufferGeometry
  dark: THREE.BufferGeometry
  rearFlap: THREE.BufferGeometry
  frontFlaps: THREE.BufferGeometry
  helmet: THREE.BufferGeometry
  visor: THREE.BufferGeometry
  tyreFront: THREE.BufferGeometry
  tyreRear: THREE.BufferGeometry
  rimFront: THREE.BufferGeometry
  rimRear: THREE.BufferGeometry
  drumFront: THREE.BufferGeometry
  drumRear: THREE.BufferGeometry
  discFront: THREE.BufferGeometry
  discRear: THREE.BufferGeometry
  discStubFront: THREE.BufferGeometry
  discStubRear: THREE.BufferGeometry
  /** LOD 1 (animated wheels): the dark parts without the tyres */
  darkLowBody: THREE.BufferGeometry
  /** LOD 1 wheel bodies: tyre + closed drum */
  wheelLowFront: THREE.BufferGeometry
  wheelLowRear: THREE.BufferGeometry
  tcam: THREE.BufferGeometry
  rearLight: THREE.BufferGeometry
  numberPlate: THREE.BufferGeometry
  shadow: THREE.BufferGeometry
  /** LOD 1: carbon, dark parts, flaps and all four wheels baked into one dark mesh */
  darkLow: THREE.BufferGeometry
  /** LOD 2: the whole car as one hull */
  hull: THREE.BufferGeometry
}

let shared: SharedGeometry | null = null

const REAR_FLAP_PIVOT = new THREE.Vector3(0, 0.87, -2.6)
const FRONT_FLAP_PIVOT = new THREE.Vector3(0, 0.15, 2.6)

function buildShared(): SharedGeometry {
  // --- monocoque, nose, engine cover (one smooth loft, livery-mapped)
  const body = loft([
    { z: -2.2, yBot: 0.28, yTop: 0.4, hw: 0.05, n: 2 },
    { z: -1.85, yBot: 0.22, yTop: 0.56, hw: 0.11, n: 2.4 },
    { z: -1.4, yBot: 0.15, yTop: 0.7, hw: 0.19, n: 2.6 },
    { z: -0.95, yBot: 0.1, yTop: 0.82, hw: 0.25, n: 2.8 },
    { z: -0.5, yBot: RIDE + 0.03, yTop: 0.9, hw: 0.28, n: 3 },
    { z: -0.15, yBot: RIDE + 0.03, yTop: 0.96, hw: 0.29, n: 3.2 },
    { z: 0.12, yBot: RIDE + 0.03, yTop: 0.92, hw: 0.32, n: 3.4 },
    { z: 0.38, yBot: RIDE + 0.03, yTop: 0.7, hw: 0.35, n: 3.6 },
    { z: 0.7, yBot: RIDE + 0.03, yTop: 0.66, hw: 0.36, n: 3.8 },
    { z: 1.05, yBot: RIDE + 0.03, yTop: 0.64, hw: 0.35, n: 3.8 },
    { z: 1.45, yBot: RIDE + 0.06, yTop: 0.58, hw: 0.29, n: 3.2 },
    { z: 1.85, yBot: 0.13, yTop: 0.5, hw: 0.21, n: 2.6 },
    { z: 2.25, yBot: 0.17, yTop: 0.4, hw: 0.14, n: 2.2 },
    { z: 2.55, yBot: 0.2, yTop: 0.31, hw: 0.08, n: 2 },
    { z: 2.78, yBot: 0.225, yTop: 0.265, hw: 0.035, n: 2 },
  ], 36)

  // --- sidepods: high undercut inlet, downwash ramp into the coke-bottle
  const podL = loft([
    { z: 0.62, yBot: 0.3, yTop: 0.62, hw: 0.22, n: 3.4, xc: 0.6 },
    { z: 0.35, yBot: 0.25, yTop: 0.63, hw: 0.25, n: 3.4, xc: 0.62 },
    { z: -0.1, yBot: 0.16, yTop: 0.6, hw: 0.26, n: 3.2, xc: 0.6 },
    { z: -0.55, yBot: 0.1, yTop: 0.52, hw: 0.24, n: 3 },
    { z: -1.0, yBot: RIDE + 0.04, yTop: 0.42, hw: 0.19, n: 2.8, xc: 0.45 },
    { z: -1.45, yBot: RIDE + 0.05, yTop: 0.3, hw: 0.11, n: 2.6, xc: 0.31 },
    { z: -1.8, yBot: 0.1, yTop: 0.22, hw: 0.05, n: 2.4, xc: 0.2 },
  ].map((s) => ({ ...s, xc: s.xc ?? 0.53 })), 24)
  const podR = mirrorX(podL)

  const paint: THREE.BufferGeometry[] = []
  const carbon: THREE.BufferGeometry[] = []
  const dark: THREE.BufferGeometry[] = []

  // sidepod inlet mouths (dark, slightly inset)
  for (const sgn of [1, -1]) dark.push(box(0.4, 0.28, 0.06, sgn * 0.6, 0.46, 0.6))

  // --- floor + edge wings + diffuser (carbon)
  const floorOutline: [number, number][] = [
    [0.36, 1.5], [0.6, 1.3], [0.78, 0.95], [0.8, -1.55], [0.72, -2.35], [0.42, -2.5],
    [-0.42, -2.5], [-0.72, -2.35], [-0.8, -1.55], [-0.78, 0.95], [-0.6, 1.3], [-0.36, 1.5],
  ]
  carbon.push(slab(floorOutline, 0.03, RIDE + 0.03))
  for (const sgn of [1, -1]) {
    carbon.push(plate([[0.9, 0], [-1.3, 0], [-1.3, 0.07], [0.9, 0.05]], 0.012, sgn * 0.8).translate(0, RIDE + 0.03, 0))
    carbon.push(plate([[-1.35, 0], [-2.45, 0], [-2.45, 0.34], [-1.55, 0.08]], 0.012, sgn * 0.5).translate(0, RIDE + 0.05, 0))
    carbon.push(plate([[-1.6, 0], [-2.45, 0], [-2.45, 0.3], [-1.7, 0.06]], 0.01, sgn * 0.25).translate(0, RIDE + 0.05, 0))
  }
  // diffuser ramp
  carbon.push(plate([[-1.5, RIDE + 0.05], [-2.45, RIDE + 0.05], [-2.45, 0.36], [-1.6, 0.09]], 1.0, 0))
  // rear crash structure with the rain light
  carbon.push(box(0.16, 0.16, 0.5, 0, 0.36, -2.4))

  // --- front wing: main plane (paint), endplates, nose pylons
  paint.push(wingElement(0.32, 1.8, 0.05, 0.03, 0.05, 0.9).rotateX(0.08).translate(0, 0.1, 2.88))
  for (const sgn of [1, -1]) {
    paint.push(plate([[2.92, 0.06], [2.35, 0.06], [2.32, 0.2], [2.5, 0.34], [2.86, 0.3]], 0.012, sgn * 0.905))
    carbon.push(plate([[2.92, 0.02], [2.4, 0.02], [2.4, 0.06], [2.92, 0.06]], 0.06, sgn * 0.88)) // footplate
    carbon.push(rod(sgn * 0.09, 0.12, 2.75, sgn * 0.07, 0.24, 2.58, 0.02, 2.4))
  }

  // --- rear wing: main plane (paint), swan-neck mounts, endplates, beam wing (carbon)
  paint.push(wingElement(0.36, 0.96, 0.06, 0.05).rotateX(0.12).translate(0, 0.79, -2.3))
  for (const sgn of [1, -1]) {
    paint.push(plate([[-2.02, 0.5], [-2.82, 0.5], [-2.83, 0.98], [-2.05, 0.98], [-2.05, 0.8], [-2.12, 0.72], [-2.05, 0.62]], 0.012, sgn * 0.49))
    carbon.push(rod(sgn * 0.14, 0.62, -1.95, sgn * 0.12, 0.84, -2.38, 0.018, 3.2)) // swan-neck
  }
  carbon.push(wingElement(0.18, 0.8, 0.07, 0.03).rotateX(0.2).translate(0, 0.52, -2.45))
  carbon.push(wingElement(0.14, 0.8, 0.06, 0.03).rotateX(0.5).translate(0, 0.6, -2.6))

  // --- halo (paint) + centre pillar, cockpit surround (dark)
  const haloCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.42, 0.86, -0.05),
    new THREE.Vector3(0.5, 0.93, 0.35),
    new THREE.Vector3(0.4, 0.96, 0.78),
    new THREE.Vector3(0, 0.97, 1.02),
    new THREE.Vector3(-0.4, 0.96, 0.78),
    new THREE.Vector3(-0.5, 0.93, 0.35),
    new THREE.Vector3(-0.42, 0.86, -0.05),
  ], false, 'catmullrom', 0.5)
  paint.push(new THREE.TubeGeometry(haloCurve, 48, 0.036, 10, false))
  paint.push(rod(0, 0.97, 1.02, 0, 0.6, 1.28, 0.03, 1.8))
  for (const sgn of [1, -1]) paint.push(rod(sgn * 0.42, 0.86, -0.05, sgn * 0.36, 0.7, -0.02, 0.035))
  dark.push(box(0.44, 0.02, 0.6, 0, 0.69, 0.55)) // cockpit opening
  dark.push(box(0.08, 0.1, 0.5, 0.27, 0.72, 0.42)) // headrest pads
  dark.push(box(0.08, 0.1, 0.5, -0.27, 0.72, 0.42))

  // --- mirrors, airbox inlet, camera pods
  for (const sgn of [1, -1]) {
    carbon.push(box(0.15, 0.07, 0.05, sgn * 0.62, 0.74, 0.86))
    carbon.push(rod(sgn * 0.36, 0.66, 0.84, sgn * 0.6, 0.72, 0.86, 0.01))
  }
  dark.push(box(0.26, 0.14, 0.05, 0, 0.84, 0.18)) // airbox mouth
  // shark fin
  paint.push(plate([[-0.55, 0.8], [-2.05, 0.4], [-2.05, 0.5], [-1.1, 0.9], [-0.6, 0.93]], 0.02, 0))

  // --- suspension (carbon): upper/lower wishbones, pushrod, track rod, uprights
  for (const sgn of [1, -1]) {
    for (const [zc, trackHalf, tw] of [[WHEELBASE / 2, FRONT_TRACK_HALF, FRONT_TYRE_W], [-WHEELBASE / 2, REAR_TRACK_HALF, REAR_TYRE_W]] as const) {
      const front = zc > 0
      const xi = front ? 0.18 : 0.1
      const yu = front ? 0.44 : 0.5
      const yl = front ? 0.16 : 0.2
      const xo = trackHalf - tw / 2 - 0.03
      carbon.push(rod(sgn * xi, yu, zc + 0.2, sgn * xo, 0.5, zc + 0.02, 0.016, 2.6))
      carbon.push(rod(sgn * xi, yu, zc - 0.2, sgn * xo, 0.5, zc - 0.02, 0.016, 2.6))
      carbon.push(rod(sgn * xi, yl, zc + 0.2, sgn * xo, 0.2, zc + 0.02, 0.016, 2.6))
      carbon.push(rod(sgn * xi, yl, zc - 0.2, sgn * xo, 0.2, zc - 0.02, 0.016, 2.6))
      carbon.push(rod(sgn * (xi + 0.02), front ? 0.5 : 0.24, zc + (front ? 0.06 : -0.06), sgn * xo, front ? 0.22 : 0.5, zc + (front ? 0.08 : -0.1), 0.014, 2.2))
      carbon.push(rod(sgn * xi, 0.34, zc + (front ? 0.3 : -0.28), sgn * xo, 0.36, zc + (front ? 0.14 : -0.12), 0.012, 2))
      carbon.push(box(0.1, 0.3, 0.14, sgn * xo, 0.36, zc))
      if (!front) carbon.push(rod(sgn * 0.14, 0.36, zc, sgn * xo, 0.36, zc, 0.03))
      // brake duct inlet inboard of the wheel
      dark.push(box(0.06, 0.24, 0.16, sgn * (trackHalf - 0.24), 0.36, zc + 0.04))
    }
  }

  // --- moving flaps (leading edge at the pivot)
  const rearFlap = wingElement(0.22, 0.94, 0.05, 0.03)
  const frontFlaps = mergeGeometries([
    wingElement(0.24, 1.66, 0.045, 0.035, 0.05, 0.85).rotateX(0.1),
    wingElement(0.17, 1.5, 0.04, 0.03, 0.05, 0.8).rotateX(0.25).translate(0, 0.075, -0.19),
  ], false)!

  // --- driver
  const helmet = new THREE.SphereGeometry(0.135, 20, 14)
  helmet.scale(1, 1.06, 1.1)
  helmet.translate(0, 0.79, 0.4)
  const visor = new THREE.SphereGeometry(0.138, 20, 8, Math.PI * 0.12, Math.PI * 0.76, Math.PI * 0.36, Math.PI * 0.22)
  visor.scale(1, 1.06, 1.1)
  visor.translate(0, 0.79, 0.4)

  // --- wheels: tyre (lathe, 6 profile points → texture bands), rim dish, brake drum
  const tyre = (w: number) => {
    const hw = w / 2
    const g = new THREE.LatheGeometry([
      new THREE.Vector2(RIM_R, -hw + 0.02),
      new THREE.Vector2(WHEEL_R - 0.014, -hw + 0.02),
      new THREE.Vector2(WHEEL_R, -hw + 0.05),
      new THREE.Vector2(WHEEL_R, hw - 0.05),
      new THREE.Vector2(WHEEL_R - 0.014, hw - 0.02),
      new THREE.Vector2(RIM_R, hw - 0.02),
    ], 40)
    g.rotateZ(Math.PI / 2)
    return g
  }
  const rim = (w: number) => {
    const hw = w / 2
    const g = new THREE.LatheGeometry([
      new THREE.Vector2(0.045, -hw + 0.11),
      new THREE.Vector2(0.105, -hw + 0.085),
      new THREE.Vector2(0.165, -hw + 0.06),
      new THREE.Vector2(RIM_R - 0.002, -hw + 0.03),
    ], 40)
    g.rotateZ(Math.PI / 2)
    return g
  }
  // brake drum: closed outboard cap, open inboard end (the disc is seen through it). Lathe y maps
  // to −X after the rotation, so the cap at −(hw−0.04) lands at +X = outboard in wheel space.
  const drum = (w: number) => {
    const hw = w / 2
    const g = new THREE.LatheGeometry([
      new THREE.Vector2(0, -(hw - 0.04)),
      new THREE.Vector2(RIM_R - 0.01, -(hw - 0.04)),
      new THREE.Vector2(RIM_R - 0.01, hw - 0.04),
    ], 24)
    g.rotateZ(Math.PI / 2)
    return g
  }
  // closed cylinder for the LOD1 wheels
  const drumLow = (w: number) => {
    const g = new THREE.CylinderGeometry(RIM_R - 0.01, RIM_R - 0.01, w - 0.08, 24, 1, false)
    g.rotateZ(Math.PI / 2)
    return g
  }
  // disc annulus (rIn 0.085, 32 mm thick), profile order = texture v bands: face, barrel, face, bore;
  // centred at xc (negative = inboard)
  const disc = (rOut: number, xc: number) => {
    const g = new THREE.LatheGeometry([
      new THREE.Vector2(0.085, -0.016),
      new THREE.Vector2(rOut, -0.016),
      new THREE.Vector2(rOut, 0.016),
      new THREE.Vector2(0.085, 0.016),
      new THREE.Vector2(0.085, -0.016),
    ], 32)
    g.rotateZ(Math.PI / 2)
    g.translate(xc, 0, 0)
    return g
  }

  const tcam = box(0.09, 0.07, 0.24, 0, 1.0, -0.02)
  const rearLight = box(0.06, 0.14, 0.03, 0, 0.36, -2.66)
  const numberPlate = new THREE.PlaneGeometry(0.3, 0.15)
  numberPlate.rotateX(-Math.PI / 2 + 0.45)
  numberPlate.translate(0, 0.945, 0.05)
  const shadow = new THREE.PlaneGeometry(4.8, 2.1)
  shadow.rotateX(-Math.PI / 2)
  shadow.translate(0, 0.012, -0.05)

  const paintMerged = mergeGeometries(paint.map(strip), false)!
  const carbonMerged = mergeGeometries(carbon.map(strip), false)!
  const darkMerged = mergeGeometries(dark.map(strip), false)!
  // distant LODs: wheels in their resting positions, flaps closed
  const tyreF = tyre(FRONT_TYRE_W), tyreR = tyre(REAR_TYRE_W)
  const lowParts: THREE.BufferGeometry[] = [carbonMerged, darkMerged]
  lowParts.push(rearFlap.clone().rotateX(0.5).translate(REAR_FLAP_PIVOT.x, REAR_FLAP_PIVOT.y, REAR_FLAP_PIVOT.z))
  lowParts.push(frontFlaps.clone().rotateX(0.2).translate(FRONT_FLAP_PIVOT.x, FRONT_FLAP_PIVOT.y, FRONT_FLAP_PIVOT.z))
  // LOD1 on the high tier animates its wheels, so the body is also baked without them
  const darkLowBody = mergeGeometries(lowParts.map(strip), false)!
  for (const sgn of [1, -1]) {
    lowParts.push(tyreF.clone().translate(sgn * FRONT_TRACK_HALF, WHEEL_R, WHEELBASE / 2))
    lowParts.push(tyreR.clone().translate(sgn * REAR_TRACK_HALF, WHEEL_R, -WHEELBASE / 2))
  }
  const darkLow = mergeGeometries(lowParts.map(strip), false)!
  const hull = mergeGeometries([body, podL, podR, paintMerged, darkLow].map(strip), false)!
  const drumLowF = drumLow(FRONT_TYRE_W), drumLowR = drumLow(REAR_TYRE_W)
  // LOD1 wheel: tyre + closed drum in one mesh (a tyre alone shows a hole where the rim is)
  const wheelLowFront = mergeGeometries([tyreF, drumLowF].map(strip), false)!
  const wheelLowRear = mergeGeometries([tyreR, drumLowR].map(strip), false)!

  return {
    body,
    podL,
    podR,
    paint: paintMerged,
    carbon: carbonMerged,
    dark: darkMerged,
    rearFlap,
    frontFlaps,
    helmet,
    visor,
    tyreFront: tyreF,
    tyreRear: tyreR,
    rimFront: rim(FRONT_TYRE_W),
    rimRear: rim(REAR_TYRE_W),
    drumFront: drum(FRONT_TYRE_W),
    drumRear: drum(REAR_TYRE_W),
    // the disc sits 3 cm inside the drum's open inboard end
    discFront: disc(0.16, -(FRONT_TYRE_W / 2 - 0.07)),
    discRear: disc(0.14, -(REAR_TYRE_W / 2 - 0.07)),
    // LOD1 glow stubs: the same annulus just outside the closed low drum's inboard face
    discStubFront: disc(0.16, -(FRONT_TYRE_W / 2 - 0.02)),
    discStubRear: disc(0.14, -(REAR_TYRE_W / 2 - 0.02)),
    darkLowBody,
    wheelLowFront,
    wheelLowRear,
    tcam,
    rearLight,
    numberPlate,
    shadow,
    darkLow,
    hull,
  }
}

/** Keep only position/normal/uv so geometries from different builders can be merged. */
function strip(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g
  for (const name of Object.keys(out.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') out.deleteAttribute(name)
  }
  if (!out.attributes.normal) out.computeVertexNormals()
  if (!out.attributes.uv) {
    out.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(out.attributes.position!.count * 2), 2))
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// materials

let carbonMat: THREE.MeshPhysicalMaterial | null = null
let darkMat: THREE.MeshStandardMaterial | null = null
let rimMat: THREE.MeshStandardMaterial | null = null
let drumMat: THREE.MeshStandardMaterial | null = null
let visorMat: THREE.MeshPhysicalMaterial | null = null
let shadowMat: THREE.MeshBasicMaterial | null = null
const tyreMats: Partial<Record<Compound, THREE.MeshPhysicalMaterial>> = {}
const tcamMats: Record<'black' | 'yellow', THREE.MeshStandardMaterial | null> = { black: null, yellow: null }

function sharedMaterials() {
  if (!carbonMat) {
    const carbon = carbonMaps()
    for (const t of [carbon.map, carbon.normalMap!]) t.repeat.set(40, 40)
    carbonMat = new THREE.MeshPhysicalMaterial({
      map: carbon.map,
      normalMap: carbon.normalMap,
      normalScale: new THREE.Vector2(0.35, 0.35),
      color: 0xd8d8dc,
      roughness: 0.42,
      metalness: 0.15,
      clearcoat: 0.7,
      clearcoatRoughness: 0.18,
      // the twill weave reflects along the fibre direction
      anisotropy: 0.6,
    })
    darkMat = new THREE.MeshStandardMaterial({ color: 0x0c0d10, roughness: 0.85, metalness: 0.05 })
    const rim = rimMaps()
    rimMat = new THREE.MeshStandardMaterial({ map: rim.map, normalMap: rim.normalMap, roughnessMap: rim.roughnessMap, roughness: 1, metalness: 0.85 })
    // the drum is open inboard: DoubleSide or its interior culls to the sky
    drumMat = new THREE.MeshStandardMaterial({ color: 0x0c0d10, roughness: 0.85, metalness: 0.05, side: THREE.DoubleSide })
    // dark tinted visor with the thin-film shimmer of a real iridium coating
    visorMat = new THREE.MeshPhysicalMaterial({ color: 0x0a0a12, roughness: 0.08, metalness: 0.6, clearcoat: 1, clearcoatRoughness: 0.03, iridescence: 0.6, iridescenceIOR: 1.6 })
    shadowMat = new THREE.MeshBasicMaterial({ map: contactShadowTexture(), transparent: true, opacity: 0.5, depthWrite: false, toneMapped: false })
    tcamMats.black = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.5 })
    tcamMats.yellow = new THREE.MeshStandardMaterial({ color: 0xf5ff00, roughness: 0.5 })
    for (const c of ['S', 'M', 'H'] as Compound[]) {
      const t = tyreMaps(c, COMPOUND_COLORS[c])
      // rubber has a soft sheen rather than a specular highlight
      tyreMats[c] = new THREE.MeshPhysicalMaterial({ map: t.map, normalMap: t.normalMap, normalScale: new THREE.Vector2(0.5, 0.5), roughnessMap: t.roughnessMap, roughness: 1, metalness: 0, sheen: 0.3, sheenRoughness: 0.8, sheenColor: new THREE.Color(0x333333) })
    }
  }
}

export interface CarDynamics {
  /** longitudinal acceleration (m/s², + = accelerating) */
  aLon: number
  /** lateral acceleration (m/s², + = turning left) */
  aLat: number
  /** speed (m/s) */
  v: number
  /** simulation time step (s), 0 when paused */
  dt: number
}

// ---------------------------------------------------------------------------------------------

export interface CarModel {
  root: THREE.Group
  /** everything but the wheels — pitches, rolls and heaves on the suspension */
  chassis: THREE.Group
  wheels: THREE.Object3D[]
  frontSteer: THREE.Group[]
  /** LOD1 spinning wheel bodies (same order as `wheels`), empty unless built with animatedMid */
  midWheels: THREE.Object3D[]
  midSteer: THREE.Group[]
  drsFlap: THREE.Mesh
  setCompound: (c: Compound) => void
  setDrs: (open: boolean, dt: number) => void
  /** per-frame body motion from the car's accelerations */
  setDynamics: (d: CarDynamics) => void
  /** brake disc temperatures (°C) in wheel order [FL, RL, FR, RR] → blackbody emissive per disc */
  setBrakeTemps: (t: ArrayLike<number>, drumT?: number) => void
  /** tyre wear (laps on the set) — worn rubber goes matte and grey */
  setWear: (laps: number) => void
  /** rain light: flash = pit limiter / grid / ERS harvesting; on = wet running (unused today); off = dry running */
  setRainLight: (mode: 'off' | 'on' | 'flash', time: number) => void
  /** bicycle-model road-wheel angle (rad, + = left); applies Ackermann to both fronts and turns the cockpit wheel (9×, ±120°) */
  setSteer: (angle: number) => void
  /** shadow casting by distance: 0 = detailed LOD casts, 1 = only the LOD-1/2 meshes, 3 = none (contact blob only) */
  setShadows: (level: 0 | 1 | 3) => void
  /** contact-shadow blob: `sunLocal` is the sun direction in car space; `casting` = a real cascaded shadow is being drawn */
  setContactShadow: (sunLocal: THREE.Vector3, casting: boolean, dt: number) => void
}

const _rgb = [0, 0, 0]
/**
 * Disc emissive from its temperature: the Draper blackbody ramp (linear RGB, so setRGB avoids
 * the sRGB decode of the hex path) and an intensity that crosses the bloom luminance threshold
 * only above ~950 °C (see emissive.ts). Returns the tier-scaled intensity.
 */
function discEmissive(tempC: number, out: THREE.Color): number {
  const i = brakeDiscEmissive(tempC, _rgb)
  out.setRGB(_rgb[0]!, _rgb[1]!, _rgb[2]!)
  return i * emissiveScale()
}

/**
 * Build one car. `animatedMid` (high tier) gives LOD1 steerable/spinning wheels with glow stubs;
 * on the low tier LOD1 keeps the baked wheels and `midWheels` is empty.
 */
export function buildCarModel(driver: Driver, compound: Compound, animatedMid = false): CarModel {
  if (!shared) shared = buildShared()
  sharedMaterials()
  const team = TEAMS[driver.team]
  const root = new THREE.Group()
  // three levels of detail: full car (< 140 m), five meshes (< 700 m), one hull beyond
  const lod = new THREE.LOD()
  const full = new THREE.Group()
  const chassis = new THREE.Group()
  full.add(chassis)
  lod.addLevel(full, 0)
  root.add(lod)

  const livery = liveryTexture(driver.team, driver.number)
  // metallic-flake paint under a hard clearcoat: the flake normal only perturbs the coat
  const flake = flakeNormalMap()
  const gloss = { roughness: 0.32, metalness: 0.08, clearcoat: 0.9, clearcoatRoughness: 0.06, clearcoatNormalMap: flake, clearcoatNormalScale: new THREE.Vector2(0.08, 0.08), envMapIntensity: 0.7 }
  const bodyMat = new THREE.MeshPhysicalMaterial({ map: livery, ...gloss })
  const podMat = new THREE.MeshPhysicalMaterial({ map: podLiveryTexture(driver.team), ...gloss })
  const paintMat = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(team.body), ...gloss })
  const flapMat = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(team.accent), ...gloss })
  const helmetMat = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(driver.helmet), roughness: 0.3, metalness: 0.05, clearcoat: 0.8, clearcoatRoughness: 0.08, envMapIntensity: 0.7 })
  const secondCar = DRIVERS.find((d) => d.team === driver.team) !== driver
  const rearLightMat = new THREE.MeshStandardMaterial({ color: 0x5a0000, emissive: EMISSIVE.rainLight.color, emissiveIntensity: EMISSIVE.rainLight.on * emissiveScale(), roughness: 0.3 })

  const body = new THREE.Mesh(shared.body, bodyMat)
  const podL = new THREE.Mesh(shared.podL, podMat)
  const podR = new THREE.Mesh(shared.podR, podMat)
  const paint = new THREE.Mesh(shared.paint, paintMat)
  const carbon = new THREE.Mesh(shared.carbon, carbonMat!)
  const dark = new THREE.Mesh(shared.dark, darkMat!)
  const helmet = new THREE.Mesh(shared.helmet, helmetMat)
  const visor = new THREE.Mesh(shared.visor, visorMat!)
  const tcam = new THREE.Mesh(shared.tcam, secondCar ? tcamMats.yellow! : tcamMats.black!)
  const rearLight = new THREE.Mesh(shared.rearLight, rearLightMat)
  const plate = new THREE.Mesh(shared.numberPlate, new THREE.MeshBasicMaterial({ map: numberTexture(driver.number, secondCar ? '#111' : '#f5ff00', secondCar ? '#f5ff00' : '#111') }))
  // per-car material: the blob fades while the car casts a real shadow (setContactShadow)
  const shadow = new THREE.Mesh(shared.shadow, shadowMat!.clone())
  shadow.renderOrder = 1

  const rearFlap = new THREE.Mesh(shared.rearFlap, flapMat)
  rearFlap.position.copy(REAR_FLAP_PIVOT)
  const frontFlaps = new THREE.Mesh(shared.frontFlaps, flapMat)
  frontFlaps.position.copy(FRONT_FLAP_PIVOT)

  const casters: THREE.Mesh[] = [body, podL, podR, paint, carbon, dark, helmet, rearFlap, frontFlaps]
  for (const m of casters) {
    m.castShadow = true
    m.receiveShadow = true
  }
  chassis.add(body, podL, podR, paint, carbon, dark, helmet, visor, tcam, rearLight, plate, rearFlap, frontFlaps)
  root.add(shadow)

  // LOD 1: livery body + pods + team-colour paint + one dark mesh with the wheels baked in
  // (low tier) or, on the high tier, the dark body plus four animated wheels so steer, spin and
  // disc glow survive the 140 m switch (TV lenses follow a car to ~280 m)
  const mid = new THREE.Group()
  mid.add(new THREE.Mesh(shared.body, bodyMat), new THREE.Mesh(shared.podL, podMat), new THREE.Mesh(shared.podR, podMat), new THREE.Mesh(shared.paint, paintMat))
  if (!animatedMid) mid.add(new THREE.Mesh(shared.darkLow, darkMat!))
  else mid.add(new THREE.Mesh(shared.darkLowBody, darkMat!))
  lod.addLevel(mid, 140)
  // LOD 2: a single hull in the team colour
  const hull = new THREE.Mesh(shared.hull, paintMat)
  lod.addLevel(hull, 700)

  // driver: suit in the team colour, black gloves, steering wheel on its own pivot
  const fig = driverFigure()
  const suitMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(team.accent), roughness: 0.85 })
  const driverBody = new THREE.Mesh(fig.body, suitMat)
  const driverArms = new THREE.Mesh(fig.upperArms, darkMat!)
  driverBody.castShadow = true
  casters.push(driverBody)
  const wheelGroup = new THREE.Group()
  wheelGroup.position.copy(fig.wheelPivot)
  const wheelRim = new THREE.Mesh(fig.wheel, carbonMat!)
  const wheelFace = new THREE.Mesh(fig.wheelFace, new THREE.MeshStandardMaterial({ color: 0x0a0c10, emissive: 0x2244ff, emissiveIntensity: 0.6, roughness: 0.3 }))
  wheelRim.position.copy(fig.wheelPivot).negate()
  wheelFace.position.copy(fig.wheelPivot).negate()
  // the gloves ride the rim (wheel-local); each forearm is a stretch bone from the fixed elbow
  // to the rotated hand so the elbows never swing through the cockpit sides at full lock
  // fig.gloves is already expressed relative to the wheel pivot, so it sits at the group origin
  const gloves = new THREE.Mesh(fig.gloves, darkMat!)
  wheelGroup.add(wheelRim, wheelFace, gloves)
  const forearms = [new THREE.Mesh(fig.forearm, darkMat!), new THREE.Mesh(fig.forearm, darkMat!)]
  chassis.add(driverBody, driverArms, wheelGroup, forearms[0]!, forearms[1]!)

  const wheels: THREE.Object3D[] = []
  const frontSteer: THREE.Group[] = []
  // one material per car, cloned here (before ctx.setupMaterials) so it gets the CSM patch
  const tyreMat: THREE.MeshPhysicalMaterial = tyreMats[compound]!.clone()
  // one brake material per wheel (order follows `wheels`: FL, RL, FR, RR) so each disc glows with
  // its own temperature; all 4 are created here, before ctx.setupMaterials, and share one program
  const brakeMats: THREE.MeshStandardMaterial[] = []
  const discMaps = brakeDiscMaps()
  // per-car drum material so the drum interior can warm through (faint, never blooms)
  const drumMatCar = drumMat!.clone()
  const makeWheel = (front: boolean, sgn: number) => {
    const g = new THREE.Group()
    const tyre = new THREE.Mesh(front ? shared!.tyreFront : shared!.tyreRear, tyreMat)
    const rim = new THREE.Mesh(front ? shared!.rimFront : shared!.rimRear, rimMat!)
    const brakeMat = new THREE.MeshStandardMaterial({ map: discMaps.map, emissiveMap: discMaps.emissiveMap, roughnessMap: discMaps.roughnessMap, emissive: 0x000000, emissiveIntensity: 0, roughness: 0.6, metalness: 0.1 })
    brakeMats.push(brakeMat)
    const drum = new THREE.Mesh(front ? shared!.drumFront : shared!.drumRear, drumMatCar)
    const disc = new THREE.Mesh(front ? shared!.discFront : shared!.discRear, brakeMat)
    tyre.castShadow = true
    tyre.receiveShadow = true
    casters.push(tyre)
    g.add(tyre, rim, drum, disc)
    if (sgn < 0) g.rotation.y = Math.PI // rim dish faces outwards on the right-hand side
    return g
  }
  for (const sgn of [1, -1]) {
    // steer carrier with 12° caster: Euler XYZ = Rx·Ry, so the steer Ry acts about the rearward-
    // leaning kingpin and the outer wheel gains negative camber with lock for free
    const steer = new THREE.Group()
    steer.position.set(sgn * FRONT_TRACK_HALF, WHEEL_R, WHEELBASE / 2)
    steer.rotation.x = -CASTER
    // static camber on its own pivot: Rz(+γ) leans the top toward −X, so sgn·γ is inward on both sides
    const camberF = new THREE.Group()
    camberF.rotation.z = sgn * CAMBER_F
    const wf = makeWheel(true, sgn)
    camberF.add(wf)
    steer.add(camberF)
    full.add(steer)
    wheels.push(wf)
    frontSteer.push(steer)
    const hubR = new THREE.Group()
    hubR.position.set(sgn * REAR_TRACK_HALF, WHEEL_R, -WHEELBASE / 2)
    hubR.rotation.z = sgn * CAMBER_R
    const wr = makeWheel(false, sgn)
    hubR.add(wr)
    full.add(hubR)
    wheels.push(wr)
  }
  // LOD1 animated wheels (high tier): same order as `wheels`; the glow stub shares the wheel's
  // brake material and is only visible while that disc emits
  const midWheels: THREE.Object3D[] = []
  const midSteer: THREE.Group[] = []
  const midStubs: THREE.Mesh[] = []
  if (animatedMid) {
    for (const sgn of [1, -1]) {
      for (const front of [true, false]) {
        const carrier = new THREE.Group()
        carrier.position.set(sgn * (front ? FRONT_TRACK_HALF : REAR_TRACK_HALF), WHEEL_R, front ? WHEELBASE / 2 : -WHEELBASE / 2)
        const body = new THREE.Mesh(front ? shared.wheelLowFront : shared.wheelLowRear, tyreMat)
        if (sgn < 0) body.rotation.y = Math.PI
        const stub = new THREE.Mesh(front ? shared.discStubFront : shared.discStubRear, brakeMats[midWheels.length]!)
        stub.visible = false
        body.add(stub)
        carrier.add(body)
        mid.add(carrier)
        midWheels.push(body)
        midStubs.push(stub)
        if (front) midSteer.push(carrier)
      }
    }
  }
  // the LOD-1/2 meshes cast too, gated by distance in setShadows (LOD.update hides the inactive
  // levels before the shadow pass, so only the visible level is ever rasterised)
  const lowCasters: THREE.Mesh[] = [hull]
  mid.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) lowCasters.push(o as THREE.Mesh)
  })
  for (const c of lowCasters) c.castShadow = true
  root.userData.carIndex = -1
  let lastLevel: 0 | 1 | 3 = 0
  const setShadows = (level: 0 | 1 | 3) => {
    if (level === lastLevel) return
    lastLevel = level
    for (const c of casters) c.castShadow = level === 0
    for (const c of lowCasters) c.castShadow = level <= 1
  }
  const setContactShadow = (sunLocal: THREE.Vector3, casting: boolean, dt: number) => {
    // the blob slides away from the sun and grows as the sun drops, and fades while the real
    // (cascaded) shadow is present so the ground is not darkened twice
    const offset = 0.35 / Math.max(0.25, sunLocal.y)
    shadow.position.set(-sunLocal.x * offset, 0, -sunLocal.z * offset)
    const grow = 1 + 0.3 * (1 - sunLocal.y)
    shadow.scale.set(grow, 1, grow)
    const mat = shadow.material as THREE.MeshBasicMaterial
    const target = casting ? 0.18 : 0.5
    if (dt > 0) mat.opacity += (target - mat.opacity) * (1 - Math.exp(-8 * dt))
  }

  let wearLaps = 0
  const applyWear = () => {
    // fresh rubber is dark and slightly glossy; a worn set goes lighter and matte
    const w = Math.min(1, wearLaps / 30)
    tyreMat.roughness = 0.75 + 0.25 * w
    tyreMat.color.setScalar(1 - 0.12 * w)
  }
  // swap the (cached, same-format) compound textures on the one per-car material: a clone would
  // lose the CSM onBeforeCompile patch (Material.copy does not carry it) and allocate mid-race
  const setCompound = (c: Compound) => {
    const t = tyreMaps(c, COMPOUND_COLORS[c])
    tyreMat.map = t.map
    tyreMat.normalMap = t.normalMap!
    tyreMat.roughnessMap = t.roughnessMap!
    wearLaps = 0
    applyWear()
  }
  const setWear = (laps: number) => {
    if (laps === wearLaps) return
    wearLaps = laps
    applyWear()
  }
  // active aero: closed = high-downforce Z-mode, open = low-drag X-mode. The flaps ease over
  // ~0.25 s to open and snap shut in ~0.08 s like real DRS; dt is the sim step so they hold when paused.
  let drsF = 0
  const setDrs = (open: boolean, dt: number) => {
    drsF += ((open ? 1 : 0) - drsF) * Math.min(1, dt * (open ? 10 : 35))
    rearFlap.rotation.x = 0.5 - 0.46 * drsF
    frontFlaps.rotation.x = 0.2 - 0.22 * drsF
  }
  setDrs(false, 1)

  let jitterT = 0
  let rollF = 0
  let pitchF = 0
  const setDynamics = ({ aLon, aLat, v, dt }: CarDynamics) => {
    if (dt <= 0) return
    const k = Math.min(1, dt * 12)
    // F1 cars barely move on their springs: a couple of degrees at most
    pitchF += (THREE.MathUtils.clamp(-aLon * 0.0009, -0.02, 0.03) - pitchF) * k
    rollF += (THREE.MathUtils.clamp(aLat * 0.0007, -0.025, 0.025) - rollF) * k
    chassis.rotation.x = pitchF
    chassis.rotation.z = rollF
    // aero load compresses the ride height at speed; add a few millimetres of high-speed jitter
    jitterT += dt
    const jitter = (Math.sin(jitterT * 47.0) * 0.6 + Math.sin(jitterT * 113.0) * 0.4) * 0.003 * (v / 90) ** 2
    chassis.position.y = -0.012 * (v / 90) ** 2 - Math.abs(Math.min(0, aLon)) * 0.0004 + jitter
  }
  const setBrakeTemps = (t: ArrayLike<number>, drumT = 0) => {
    // drum warm-through at 12 % of the disc ramp: luminance stays < 0.7, so it glows without a halo
    drumMatCar.emissiveIntensity = 0.12 * discEmissive(drumT, drumMatCar.emissive)
    for (let w = 0; w < 4; w++) {
      const mat = brakeMats[w]!
      mat.emissiveIntensity = discEmissive(t[w]!, mat.emissive)
      const stub = midStubs[w]
      if (stub) stub.visible = mat.emissiveIntensity > 0
    }
  }

  const setRainLight = (mode: 'off' | 'on' | 'flash', time: number) => {
    const rl = EMISSIVE.rainLight
    rearLightMat.emissiveIntensity = (mode === 'off' ? 0 : mode === 'on' ? rl.on : (time * 4) % 1 < 0.5 ? rl.flashHi : rl.flashLo) * emissiveScale()
  }
  const setSteer = (delta: number) => {
    // 60 % Ackermann: the inner wheel gets more lock (F1 runs partial/anti-Ackermann). R is signed,
    // so the same formulas hold for both directions; |R| ≥ 9.3 m at the 0.35 rad lock keeps R ± track > 0.
    const t = Math.tan(delta)
    let dl = delta, dr = delta
    if (Math.abs(t) > 1e-4) {
      const R = WHEELBASE / t
      dl = Math.atan(WHEELBASE / (R - FRONT_TRACK_HALF))
      dr = Math.atan(WHEELBASE / (R + FRONT_TRACK_HALF))
    }
    frontSteer[0]!.rotation.y = delta + (dl - delta) * ACKERMANN
    frontSteer[1]!.rotation.y = delta + (dr - delta) * ACKERMANN
    if (midSteer.length === 2) {
      midSteer[0]!.rotation.y = frontSteer[0]!.rotation.y
      midSteer[1]!.rotation.y = frontSteer[1]!.rotation.y
    }
    // wheelAxis points at the driver, so +rotation moves the rim top left = a left turn (+delta)
    wheelGroup.quaternion.setFromAxisAngle(fig.wheelAxis, THREE.MathUtils.clamp(delta * HAND_RATIO, -HAND_LIMIT, HAND_LIMIT))
    for (let k = 0; k < 2; k++) {
      _hand.copy(fig.hands[k]!).sub(fig.wheelPivot).applyQuaternion(wheelGroup.quaternion).add(fig.wheelPivot)
      _dir.subVectors(_hand, fig.elbows[k]!)
      const len = _dir.length()
      const fa = forearms[k]!
      fa.position.copy(fig.elbows[k]!).addScaledVector(_dir, 0.5)
      fa.quaternion.setFromUnitVectors(_Y, _dir.divideScalar(len))
      fa.scale.set(1, len / fig.forearmLen, 1)
    }
  }
  setSteer(0)

  return { root, chassis, wheels, frontSteer, midWheels, midSteer, drsFlap: rearFlap, setCompound, setDrs, setDynamics, setBrakeTemps, setWear, setRainLight, setSteer, setShadows, setContactShadow }
}

export const CAR_DIMENSIONS = { wheelbase: WHEELBASE, wheelRadius: WHEEL_R, frontTrackHalf: FRONT_TRACK_HALF, rearTrackHalf: REAR_TRACK_HALF, frontTyreWidth: FRONT_TYRE_W, rearTyreWidth: REAR_TYRE_W }
