import * as THREE from 'three'
import { APEX_OVERRIDES, CAMBER_KEYFRAMES, CENTERLINE_EN, CIRCUIT, ELEVATION_KEYFRAMES, WIDTH_KEYFRAMES } from '~/data/suzuka'

/**
 * World frame: x = east, y = up, z = south (i.e. z = -north). Right-handed, y-up,
 * so it maps directly onto three.js.
 */
export interface Pose {
  x: number
  y: number
  z: number
  /** unit tangent (3D) */
  tx: number
  ty: number
  tz: number
  /** unit left normal (horizontal) */
  nx: number
  nz: number
  /** signed curvature of the centreline, positive = turning left */
  kappa: number
  /** road cross-slope (radians) about the tangent; positive raises the left edge */
  roll: number
}

/** Linear interpolation of [s, value] keyframes around a closed loop of length L. */
function interpKeyframes(k: [number, number][], s: number, L: number): number {
  s = wrapS(s, L)
  const m = k.length
  let i = 0
  while (i < m - 1 && k[i + 1]![0] <= s) i++
  const a = k[i]!
  const b = k[(i + 1) % m]!
  const s0 = a[0]
  const s1 = i + 1 < m ? b[0] : b[0] + L
  if (s < s0) {
    // before the first keyframe: interpolate from the last one across the line
    const last = k[m - 1]!
    const t = (s + L - last[0]) / (a[0] + L - last[0])
    return last[1] + (a[1] - last[1]) * t
  }
  const t = s1 === s0 ? 0 : (s - s0) / (s1 - s0)
  return a[1] + (b[1] - a[1]) * t
}

export interface Crossing {
  sUnder: number
  sOver: number
  x: number
  z: number
  yUnder: number
  yOver: number
}

export interface CornerRun {
  from: number
  to: number
  apex: number
  sign: 1 | -1
  maxKappa: number
}

/** Lateral extent (m) over which the full road camber applies — the road plus its kerbs. */
const ROLL_CAP = 9.5

function wrapS(s: number, length: number): number {
  s %= length
  return s < 0 ? s + length : s
}

/**
 * The source polyline has vertices every ~35 m, so a spline through it has lumpy
 * curvature. Densify linearly, Gaussian-smooth (sigma metres), then decimate so
 * the spline control points are evenly spaced.
 */
function smoothCentreline(raw: [number, number][], spacing: number, sigma: number, outSpacing: number): [number, number][] {
  const dense: [number, number][] = []
  const m = raw.length
  for (let i = 0; i < m; i++) {
    const a = raw[i]!
    const b = raw[(i + 1) % m]!
    if (i === m - 1 && Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6) break
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    const n = Math.max(1, Math.ceil(len / spacing))
    for (let k = 0; k < n; k++) {
      const t = k / n
      dense.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
    }
  }
  const n = dense.length
  const half = Math.ceil((3 * sigma) / spacing)
  const weights: number[] = []
  for (let k = -half; k <= half; k++) weights.push(Math.exp(-0.5 * ((k * spacing) / sigma) ** 2))
  const wsum = weights.reduce((a, b) => a + b, 0)
  const smooth: [number, number][] = []
  for (let i = 0; i < n; i++) {
    let x = 0, y = 0
    for (let k = -half; k <= half; k++) {
      const p = dense[(i + k + n) % n]!
      const w = weights[k + half]!
      x += p[0] * w
      y += p[1] * w
    }
    smooth.push([x / wsum, y / wsum])
  }
  const stride = Math.max(1, Math.round(outSpacing / spacing))
  const out: [number, number][] = []
  for (let i = 0; i < n; i += stride) out.push(smooth[i]!)
  return out
}

/** Signed along-track distance from a to b in [-L/2, L/2). */
export function signedDelta(a: number, b: number, length: number): number {
  let d = wrapS(b - a, length)
  if (d >= length / 2) d -= length
  return d
}

/** Forward distance from a to b in [0, L). */
export function forwardDelta(a: number, b: number, length: number): number {
  return wrapS(b - a, length)
}

export class Track {
  readonly length: number
  readonly n: number
  readonly ds: number
  /** widest half-width on the lap (use halfWidthAt(s) for the local value) */
  readonly halfWidth = CIRCUIT.width / 2
  readonly px: Float32Array
  readonly py: Float32Array
  readonly pz: Float32Array
  readonly tx: Float32Array
  readonly tz: Float32Array
  readonly nx: Float32Array
  readonly nz: Float32Array
  /** raw signed curvature */
  readonly kappa: Float32Array
  /** curvature smoothed over ±10 m (used for corner detection / kerbs) */
  readonly kappaS: Float32Array
  /** signed curvature of the racing line itself (what the speed model uses) */
  readonly kappaLine: Float32Array
  /** racing line lateral offset (m, positive = left) */
  readonly line: Float32Array
  /** local half-width (m) */
  readonly hw: Float32Array
  /** road cross-slope (radians, positive = left edge up) */
  readonly roll: Float32Array
  /** longitudinal gradient (dy/ds) */
  readonly slope: Float32Array
  readonly corners: CornerRun[]
  readonly crossing: Crossing
  readonly center: THREE.Vector3
  readonly bounds: { minX: number; maxX: number; minZ: number; maxZ: number }
  readonly curve: THREE.CatmullRomCurve3

  private readonly cellSize = 40
  private readonly cells = new Map<number, number[]>()

  constructor() {
    const pts = smoothCentreline(CENTERLINE_EN, 4, 8, 8).map(([e, n]) => new THREE.Vector3(e, 0, -n))
    // The smoothed GeoJSON loop measures ~5800 m; scale it (about the origin, which is the
    // circuit centroid) so one lap is exactly the official length and every s-based constant
    // (sectors, DRS, pit lane, sections) refers to real metres.
    const rawCurve = new THREE.CatmullRomCurve3(pts, true, 'centripetal', 0.5)
    rawCurve.arcLengthDivisions = 6000
    const scale = CIRCUIT.officialLength / rawCurve.getLength()
    for (const p of pts) p.multiplyScalar(scale)
    const curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal', 0.5)
    curve.arcLengthDivisions = 6000
    this.curve = curve
    const length = CIRCUIT.officialLength
    const ds = 2
    const n = Math.round(length / ds)
    this.length = length
    this.n = n
    this.ds = length / n

    this.px = new Float32Array(n)
    this.py = new Float32Array(n)
    this.pz = new Float32Array(n)
    this.tx = new Float32Array(n)
    this.tz = new Float32Array(n)
    this.nx = new Float32Array(n)
    this.nz = new Float32Array(n)
    this.kappa = new Float32Array(n)
    this.kappaS = new Float32Array(n)
    this.kappaLine = new Float32Array(n)
    this.line = new Float32Array(n)
    this.hw = new Float32Array(n)
    this.roll = new Float32Array(n)
    this.slope = new Float32Array(n)

    const tmp = new THREE.Vector3()
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
    for (let i = 0; i < n; i++) {
      curve.getPointAt(i / n, tmp)
      this.px[i] = tmp.x
      this.pz[i] = tmp.z
      this.py[i] = this.elevationAt(i * this.ds)
      if (tmp.x < minX) minX = tmp.x
      if (tmp.x > maxX) maxX = tmp.x
      if (tmp.z < minZ) minZ = tmp.z
      if (tmp.z > maxZ) maxZ = tmp.z
    }
    this.bounds = { minX, maxX, minZ, maxZ }
    this.center = new THREE.Vector3((minX + maxX) / 2, 0, (minZ + maxZ) / 2)

    // tangents (central differences on the closed loop) + left normals
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n
      const b = (i + 1) % n
      let dx = this.px[b]! - this.px[a]!
      let dz = this.pz[b]! - this.pz[a]!
      const l = Math.hypot(dx, dz) || 1
      dx /= l
      dz /= l
      this.tx[i] = dx
      this.tz[i] = dz
      // left of heading (E,N) is (-N,E); with z = -N that is (tz, -tx)
      this.nx[i] = dz
      this.nz[i] = -dx
    }
    // signed curvature = d(heading)/ds, heading = atan2(N, E) = atan2(-tz, tx)
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n
      const b = (i + 1) % n
      const ha = Math.atan2(-this.tz[a]!, this.tx[a]!)
      const hb = Math.atan2(-this.tz[b]!, this.tx[b]!)
      let d = hb - ha
      while (d > Math.PI) d -= 2 * Math.PI
      while (d < -Math.PI) d += 2 * Math.PI
      this.kappa[i] = d / (2 * this.ds)
    }
    this.boxSmooth(this.kappa, this.kappaS, Math.round(10 / this.ds))

    // width, camber (banked into the local corner direction) and gradient per sample
    for (let i = 0; i < n; i++) {
      const s = i * this.ds
      this.hw[i] = interpKeyframes(WIDTH_KEYFRAMES, s, length) / 2
      const camber = (interpKeyframes(CAMBER_KEYFRAMES, s, length) * Math.PI) / 180
      const k = this.kappaS[i]!
      const dir = Math.abs(k) < 1 / 800 ? 0 : k > 0 ? 1 : -1
      // banking into a left-hander raises the right (outside) edge → negative roll
      this.roll[i] = -dir * camber
      const a = (i - 1 + n) % n
      const b = (i + 1) % n
      this.slope[i] = (this.py[b]! - this.py[a]!) / (2 * this.ds)
    }

    this.corners = this.findCorners()
    this.buildRacingLine()
    this.computeLineCurvature()
    this.buildSpatialHash()
    this.crossing = this.findCrossing()
  }

  // ---------------------------------------------------------------- elevation

  elevationAt(s: number): number {
    const k = ELEVATION_KEYFRAMES
    const L = this.length
    s = wrapS(s, L)
    const m = k.length
    let i = 0
    while (i < m - 1 && k[i + 1]![0] <= s) i++
    const p0 = k[(i - 1 + m) % m]!, p1 = k[i]!, p2 = k[(i + 1) % m]!, p3 = k[(i + 2) % m]!
    const s1 = p1[0]
    const s2 = i + 1 < m ? p2[0] : p2[0] + L
    const s0 = i - 1 >= 0 ? p0[0] : p0[0] - L
    const s3 = i + 2 < m ? p3[0] : p3[0] + L
    const t = (s - s1) / (s2 - s1)
    const m1 = (p2[1] - p0[1]) / (s2 - s0) * (s2 - s1)
    const m2 = (p3[1] - p1[1]) / (s3 - s1) * (s2 - s1)
    const t2 = t * t, t3 = t2 * t
    return (2 * t3 - 3 * t2 + 1) * p1[1] + (t3 - 2 * t2 + t) * m1 + (-2 * t3 + 3 * t2) * p2[1] + (t3 - t2) * m2
  }

  // ---------------------------------------------------------------- helpers

  private boxSmooth(src: Float32Array, dst: Float32Array, halfWin: number) {
    const n = this.n
    const w = 2 * halfWin + 1
    let acc = 0
    for (let j = -halfWin; j <= halfWin; j++) acc += src[(j + n) % n]!
    for (let i = 0; i < n; i++) {
      dst[i] = acc / w
      acc -= src[(i - halfWin + n) % n]!
      acc += src[(i + halfWin + 1) % n]!
    }
  }

  private findCorners(): CornerRun[] {
    const n = this.n
    const thr = 1 / 320
    const runs: CornerRun[] = []
    // find a starting index that is on a straight to avoid splitting a run at 0
    let start = 0
    while (start < n && Math.abs(this.kappaS[start]!) > thr) start++
    let i = start
    let visited = 0
    while (visited < n) {
      const k = this.kappaS[i % n]!
      if (Math.abs(k) > thr) {
        const sign: 1 | -1 = k > 0 ? 1 : -1
        const from = i
        let apex = i
        let maxK = Math.abs(k)
        while (visited < n) {
          const kk = this.kappaS[i % n]!
          if (Math.abs(kk) <= thr || (kk > 0 ? 1 : -1) !== sign) break
          if (Math.abs(kk) > maxK) {
            maxK = Math.abs(kk)
            apex = i
          }
          i++
          visited++
        }
        const to = i
        if ((to - from) * this.ds >= 14) {
          runs.push({ from: wrapS(from * this.ds, this.length), to: wrapS(to * this.ds, this.length), apex: wrapS(apex * this.ds, this.length), sign, maxKappa: maxK })
        }
      } else {
        i++
        visited++
      }
    }
    return runs
  }

  /** Outside-inside-outside seed line built from Gaussian bumps around each apex. */
  private seedRacingLine(): Float32Array {
    const n = this.n
    const tmp = new Float32Array(n)
    for (const c of this.corners) {
      const len = forwardDelta(c.from, c.to, this.length)
      const sIn = Math.min(120, Math.max(18, len * 0.42))
      const sOut = Math.min(230, sIn * 2.3)
      const reach = sOut * 2.5
      const i0 = Math.floor((c.apex - reach) / this.ds)
      const i1 = Math.ceil((c.apex + reach) / this.ds)
      for (let i = i0; i <= i1; i++) {
        const idx = ((i % n) + n) % n
        const d = signedDelta(c.apex, idx * this.ds, this.length)
        const gIn = Math.exp(-0.5 * (d / sIn) * (d / sIn))
        const gOut = Math.exp(-0.5 * (d / sOut) * (d / sOut))
        tmp[idx] = tmp[idx]! + c.sign * (2 * gIn - gOut) * Math.min(1, c.maxKappa * 260)
      }
    }
    for (let i = 0; i < n; i++) tmp[i] = THREE.MathUtils.clamp(tmp[i]!, -1, 1) * (this.hw[i]! - 2.6)
    return tmp
  }

  /** Largest lateral offset the racing line may use at sample i (car half-width + margin). */
  private maxLineOffset(i: number): number {
    return Math.max(0.5, this.hw[i]! - 2.6)
  }

  /**
   * Minimum-curvature racing line: projected gradient descent on the discrete bending
   * energy Σ|Q(i-1) − 2Q(i) + Q(i+1)|² of the offset path Q = C + l·N, with |l| bounded by
   * the road width, on an 8 m grid seeded with the classic outside-inside-outside line.
   * APEX_OVERRIDES pin the offset where the real F1 line departs from the geometric optimum.
   */
  private buildRacingLine() {
    const n = this.n
    const L = this.length
    const seed = this.seedRacingLine()
    const step = Math.max(1, Math.round(8 / this.ds))
    const m = Math.floor(n / step)
    const cx = new Float64Array(m), cz = new Float64Array(m)
    const nx = new Float64Array(m), nz = new Float64Array(m)
    const lim = new Float64Array(m)
    const l = new Float64Array(m)
    for (let j = 0; j < m; j++) {
      const i = j * step
      cx[j] = this.px[i]!
      cz[j] = this.pz[i]!
      nx[j] = this.nx[i]!
      nz[j] = this.nz[i]!
      lim[j] = this.maxLineOffset(i)
      l[j] = seed[i]!
    }
    // pins: [index, target offset, weight]
    const pins: [number, number, number][] = []
    for (const [s, lat, half] of APEX_OVERRIDES) {
      for (let j = 0; j < m; j++) {
        const d = signedDelta(s, ((j * step) % n) * this.ds, L)
        if (Math.abs(d) < half * 2) {
          const w = Math.exp(-0.5 * (d / (half * 0.6)) ** 2)
          if (w > 0.02) pins.push([j, THREE.MathUtils.clamp(lat, -lim[j]!, lim[j]!), w * 0.5])
        }
      }
    }
    const qx = new Float64Array(m), qz = new Float64Array(m)
    const rx = new Float64Array(m), rz = new Float64Array(m)
    const eta = 0.09
    for (let iter = 0; iter < 6000; iter++) {
      for (let j = 0; j < m; j++) {
        qx[j] = cx[j]! + l[j]! * nx[j]!
        qz[j] = cz[j]! + l[j]! * nz[j]!
      }
      for (let j = 0; j < m; j++) {
        const a = (j - 1 + m) % m, b = (j + 1) % m
        rx[j] = qx[a]! - 2 * qx[j]! + qx[b]!
        rz[j] = qz[a]! - 2 * qz[j]! + qz[b]!
      }
      for (let j = 0; j < m; j++) {
        const a = (j - 1 + m) % m, b = (j + 1) % m
        const g = nx[j]! * (rx[a]! - 2 * rx[j]! + rx[b]!) + nz[j]! * (rz[a]! - 2 * rz[j]! + rz[b]!)
        let v = l[j]! - eta * g
        if (v > lim[j]!) v = lim[j]!
        else if (v < -lim[j]!) v = -lim[j]!
        l[j] = v
      }
      for (const [j, target, w] of pins) l[j] = l[j]! + (target - l[j]!) * w
    }
    // upsample back to the 2 m grid and smooth lightly
    const tmp = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const u = i / step
      const j = Math.floor(u) % m
      const k = (j + 1) % m
      const f = u - Math.floor(u)
      tmp[i] = l[j]! * (1 - f) + l[k]! * f
    }
    this.boxSmooth(tmp, this.line, Math.round(4 / this.ds))
    for (let i = 0; i < n; i++) this.line[i] = THREE.MathUtils.clamp(this.line[i]!, -this.maxLineOffset(i), this.maxLineOffset(i))
  }

  /** Signed curvature of the racing line (heading change per metre travelled along it). */
  private computeLineCurvature() {
    const n = this.n
    const qx = new Float64Array(n), qz = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      qx[i] = this.px[i]! + this.line[i]! * this.nx[i]!
      qz[i] = this.pz[i]! + this.line[i]! * this.nz[i]!
    }
    const heading = new Float64Array(n)
    const seg = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      const b = (i + 1) % n
      const dx = qx[b]! - qx[i]!, dz = qz[b]! - qz[i]!
      heading[i] = Math.atan2(-dz, dx)
      seg[i] = Math.hypot(dx, dz) || 1e-6
    }
    const raw = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n
      let d = heading[i]! - heading[a]!
      while (d > Math.PI) d -= 2 * Math.PI
      while (d < -Math.PI) d += 2 * Math.PI
      raw[i] = d / (0.5 * (seg[a]! + seg[i]!))
    }
    this.boxSmooth(raw, this.kappaLine, Math.round(6 / this.ds))
  }

  private cellKey(cx: number, cz: number) {
    return (cx + 2048) * 4096 + (cz + 2048)
  }

  private buildSpatialHash() {
    for (let i = 0; i < this.n; i++) {
      const cx = Math.floor(this.px[i]! / this.cellSize)
      const cz = Math.floor(this.pz[i]! / this.cellSize)
      const key = this.cellKey(cx, cz)
      let arr = this.cells.get(key)
      if (!arr) {
        arr = []
        this.cells.set(key, arr)
      }
      arr.push(i)
    }
  }

  /** Visit sample indices within `radius` metres of (x, z). */
  forEachSampleNear(x: number, z: number, radius: number, fn: (i: number, d2: number) => void) {
    const r = Math.ceil(radius / this.cellSize)
    const cx = Math.floor(x / this.cellSize)
    const cz = Math.floor(z / this.cellSize)
    const r2 = radius * radius
    for (let ix = cx - r; ix <= cx + r; ix++) {
      for (let iz = cz - r; iz <= cz + r; iz++) {
        const arr = this.cells.get(this.cellKey(ix, iz))
        if (!arr) continue
        for (const i of arr) {
          const dx = this.px[i]! - x
          const dz = this.pz[i]! - z
          const d2 = dx * dx + dz * dz
          if (d2 <= r2) fn(i, d2)
        }
      }
    }
  }

  /** Nearest sample index and squared distance, searching outward. */
  nearestSample(x: number, z: number): { i: number; d2: number } {
    let best = -1
    let bestD2 = Infinity
    let radius = 60
    while (best < 0 && radius < 4000) {
      this.forEachSampleNear(x, z, radius, (i, d2) => {
        if (d2 < bestD2) {
          bestD2 = d2
          best = i
        }
      })
      radius *= 2
    }
    if (best < 0) {
      for (let i = 0; i < this.n; i++) {
        const dx = this.px[i]! - x, dz = this.pz[i]! - z
        const d2 = dx * dx + dz * dz
        if (d2 < bestD2) {
          bestD2 = d2
          best = i
        }
      }
    }
    return { i: best, d2: bestD2 }
  }

  private findCrossing(): Crossing {
    const n = this.n
    const hits: Crossing[] = []
    for (let i = 0; i < n; i++) {
      const ax = this.px[i]!, az = this.pz[i]!
      const bx = this.px[(i + 1) % n]!, bz = this.pz[(i + 1) % n]!
      this.forEachSampleNear(ax, az, 12, (j) => {
        if (j <= i + 2 || (i === 0 && j >= n - 2)) return
        const cx = this.px[j]!, cz = this.pz[j]!
        const dx = this.px[(j + 1) % n]!, dz = this.pz[(j + 1) % n]!
        const den = (bx - ax) * (dz - cz) - (bz - az) * (dx - cx)
        if (Math.abs(den) < 1e-9) return
        const t = ((cx - ax) * (dz - cz) - (cz - az) * (dx - cx)) / den
        const u = ((cx - ax) * (bz - az) - (cz - az) * (bx - ax)) / den
        if (t < 0 || t > 1 || u < 0 || u > 1) return
        const sA = (i + t) * this.ds
        const sB = (j + u) * this.ds
        const yA = this.elevationAt(sA), yB = this.elevationAt(sB)
        const under = yA < yB
        hits.push({
          sUnder: under ? sA : sB,
          sOver: under ? sB : sA,
          x: ax + t * (bx - ax),
          z: az + t * (bz - az),
          yUnder: Math.min(yA, yB),
          yOver: Math.max(yA, yB),
        })
      })
    }
    if (hits.length === 0) {
      return { sUnder: 0, sOver: 0, x: 0, z: 0, yUnder: 0, yOver: 0 }
    }
    return hits[0]!
  }

  // ---------------------------------------------------------------- queries

  wrap(s: number): number {
    return wrapS(s, this.length)
  }

  /** Length of the pit lane path measured along the main centreline. */
  get pitTotal(): number {
    return forwardDelta(CIRCUIT.pit.entryS, CIRCUIT.pit.exitS, this.length)
  }

  /** Lateral offset of the pit lane centreline at s, or null when s is outside the pit lane. */
  pitLateralAt(s: number): number | null {
    const d = forwardDelta(CIRCUIT.pit.entryS, s, this.length)
    const total = this.pitTotal
    if (d > total) return null
    const lane = CIRCUIT.pit.laneOffset
    const edge = -(this.halfWidthAt(s) - 2.9)
    const ease = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t * t * (3 - 2 * t))
    if (d < CIRCUIT.pit.entryRamp) return edge + (lane - edge) * ease(d / CIRCUIT.pit.entryRamp)
    if (d > total - CIRCUIT.pit.exitRamp) return edge + (lane - edge) * ease((total - d) / CIRCUIT.pit.exitRamp)
    return lane
  }

  halfWidthAt(s: number): number {
    const { i, j, f } = this.idx(s)
    return this.hw[i]! * (1 - f) + this.hw[j]! * f
  }

  rollAt(s: number): number {
    const { i, j, f } = this.idx(s)
    return this.roll[i]! * (1 - f) + this.roll[j]! * f
  }

  slopeAt(s: number): number {
    const { i, j, f } = this.idx(s)
    return this.slope[i]! * (1 - f) + this.slope[j]! * f
  }

  kappaLineAt(s: number): number {
    const { i, j, f } = this.idx(s)
    return this.kappaLine[i]! * (1 - f) + this.kappaLine[j]! * f
  }

  private idx(s: number): { i: number; j: number; f: number } {
    const u = wrapS(s, this.length) / this.ds
    const i = Math.floor(u) % this.n
    return { i, j: (i + 1) % this.n, f: u - Math.floor(u) }
  }

  kappaAt(s: number): number {
    const { i, j, f } = this.idx(s)
    return this.kappaS[i]! * (1 - f) + this.kappaS[j]! * f
  }

  lineAt(s: number): number {
    const { i, j, f } = this.idx(s)
    return this.line[i]! * (1 - f) + this.line[j]! * f
  }

  /**
   * Height change from the road cross-slope at a lateral offset: the full camber across the
   * road and its kerbs (|lateral| ≤ ROLL_CAP), then only 20 % of it across the run-off, so a
   * banked corner does not tilt the whole verge, the grandstands and the terrain with it.
   */
  rollLift(roll: number, lateral: number): number {
    const a = lateral > ROLL_CAP ? ROLL_CAP : lateral < -ROLL_CAP ? -ROLL_CAP : lateral
    return Math.tan(roll) * (a + 0.2 * (lateral - a))
  }

  /** Full pose at distance s with a lateral offset (metres, positive = left). */
  poseAt(s: number, lateral: number, out: Pose): Pose {
    const { i, j, f } = this.idx(s)
    const g = 1 - f
    const nx = this.nx[i]! * g + this.nx[j]! * f
    const nz = this.nz[i]! * g + this.nz[j]! * f
    const nl = Math.hypot(nx, nz) || 1
    out.nx = nx / nl
    out.nz = nz / nl
    const roll = this.roll[i]! * g + this.roll[j]! * f
    out.roll = roll
    out.x = this.px[i]! * g + this.px[j]! * f + out.nx * lateral
    out.z = this.pz[i]! * g + this.pz[j]! * f + out.nz * lateral
    out.y = this.py[i]! * g + this.py[j]! * f + this.rollLift(roll, lateral)
    const tx = this.tx[i]! * g + this.tx[j]! * f
    const tz = this.tz[i]! * g + this.tz[j]! * f
    const slope = (this.py[j]! - this.py[i]!) / this.ds
    const tl = Math.hypot(tx, tz) || 1
    const hx = tx / tl, hz = tz / tl
    const l3 = Math.hypot(1, slope)
    out.tx = hx / l3
    out.tz = hz / l3
    out.ty = slope / l3
    out.kappa = this.kappaS[i]! * g + this.kappaS[j]! * f
    return out
  }

  /** Cheap position-only query used by geometry builders (includes the road cross-slope). */
  pointAt(s: number, lateral: number, target: THREE.Vector3, yOffset = 0): THREE.Vector3 {
    const { i, j, f } = this.idx(s)
    const g = 1 - f
    const nx = this.nx[i]! * g + this.nx[j]! * f
    const nz = this.nz[i]! * g + this.nz[j]! * f
    const nl = Math.hypot(nx, nz) || 1
    const roll = this.roll[i]! * g + this.roll[j]! * f
    return target.set(
      this.px[i]! * g + this.px[j]! * f + (nx / nl) * lateral,
      this.py[i]! * g + this.py[j]! * f + this.rollLift(roll, lateral) + yOffset,
      this.pz[i]! * g + this.pz[j]! * f + (nz / nl) * lateral,
    )
  }

  headingAt(s: number): { tx: number; tz: number } {
    const { i, j, f } = this.idx(s)
    const tx = this.tx[i]! * (1 - f) + this.tx[j]! * f
    const tz = this.tz[i]! * (1 - f) + this.tz[j]! * f
    const l = Math.hypot(tx, tz) || 1
    return { tx: tx / l, tz: tz / l }
  }
}

let shared: Track | null = null
export function getTrack(): Track {
  if (!shared) shared = new Track()
  return shared
}
