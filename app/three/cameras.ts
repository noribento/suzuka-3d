import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { CIRCUIT, SECTIONS, TV_CAMERA_SPOTS } from '~/data/suzuka'
import { forwardDelta, type Track } from '~/sim/track'
import { overviewDirection } from '~/sim/projection'
import type { CameraMode } from '~/composables/useRaceStore'
import { cameraSide } from './environment'

export interface CameraTarget {
  position: THREE.Vector3
  tangent: THREE.Vector3
  normal: THREE.Vector3
  speed: number
  s: number
  /** longitudinal / lateral acceleration of the subject (m/s²) */
  aLon: number
  aLat: number
  rpm: number
}

/** Cheap deterministic noise in [-1, 1] for camera tremble. */
function noise1(t: number): number {
  return Math.sin(t * 12.9898) * 0.5 + Math.sin(t * 78.233 + 1.3) * 0.3 + Math.sin(t * 37.719 + 2.1) * 0.2
}

/** Slow hand-on-the-tripod wobble in [-1, 1] (0.7–3 Hz). */
function wobble(t: number): number {
  return Math.sin(t * 4.4) * 0.5 + Math.sin(t * 11.3 + 1.3) * 0.3 + Math.sin(t * 18.8 + 2.1) * 0.2
}

interface TvCamera {
  s: number
  position: THREE.Vector3
  name: string
}

const _v = new THREE.Vector3()
const _look = new THREE.Vector3()
const _dir = new THREE.Vector3()
const _right = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0)

/**
 * Overview WASD: ground speed as a fraction of the orbit distance per second (half a screen
 * height per second at the 45° lens, the same scaling OrbitControls uses for a mouse pan), and
 * how far past the circuit's bounding box the pivot may be flown (in track spans).
 */
const MOVE_RATE = 0.5
const MOVE_MARGIN = 1.5

/** Per-mode near plane (metres); far stays at 20 km (the sky and the cloud dome are inside). */
const NEAR: Record<CameraMode, number> = { overview: 8, heli: 2, chase: 0.5, onboard: 0.2, tv: 0.5, director: 0.5 }

function sectionShort(s: number): string {
  for (const sec of SECTIONS) {
    if (sec.from < sec.to ? s >= sec.from && s < sec.to : s >= sec.from || s < sec.to) return sec.short
  }
  return ''
}

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera
  readonly controls: OrbitControls
  mode: CameraMode = 'overview'
  private readonly tvCams: TvCamera[] = []
  private tvIndex = -1
  private heliAngle = 0
  private smoothPos = new THREE.Vector3()
  private smoothLook = new THREE.Vector3()
  /** TV mode: unit viewing direction and its angular velocity (rad/s) */
  private lookDir = new THREE.Vector3()
  private lookVel = new THREE.Vector3()
  private smoothFov = 40
  private justSwitched = true
  private time = 0
  private tvHold = 0
  tvCamName = ''
  /** overview WASD input (x = right, y = forward, unit disc) and the smoothed ground velocity (m/s) */
  private readonly moveIn = new THREE.Vector2()
  private readonly moveVel = new THREE.Vector3()

  constructor(private track: Track, domElement: HTMLElement) {
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.5, 20000)
    this.controls = new OrbitControls(this.camera, domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.maxPolarAngle = Math.PI * 0.47
    this.controls.minDistance = 20
    this.controls.maxDistance = 5000
    this.controls.screenSpacePanning = false
    for (const s of TV_CAMERA_SPOTS) {
      const side = cameraSide(track, s)
      const p = track.pointAt(s, side * (track.halfWidth + 9), new THREE.Vector3(), 7.9)
      this.tvCams.push({ s, position: p, name: sectionShort(s) })
    }
    this.resetOverview()
  }

  resetOverview() {
    const c = this.track.center
    const dir = overviewDirection()
    const b = this.track.bounds
    const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ)
    // screen-right direction on the ground for a camera placed along `dir`
    const right = { x: dir.z, z: -dir.x }
    // nudge the framing right/down so the circuit clears the timing tower and the bottom panels
    const tx = c.x - right.x * span * 0.04 + dir.x * span * 0.02
    const tz = c.z - right.z * span * 0.04 + dir.z * span * 0.02
    this.camera.fov = 45
    this.camera.position.set(tx + dir.x * span * 0.55, 26 + span * 0.9, tz + dir.z * span * 0.55)
    this.controls.target.set(tx, 24, tz)
    this.camera.lookAt(this.controls.target)
    this.moveVel.set(0, 0, 0)
    this.controls.update()
  }

  /**
   * Overview keyboard move: `forward` / `right` in [-1, 1] relative to the view (W/S and D/A held).
   * Ignored outside the overview camera; the input is held until the next call.
   */
  setMoveInput(forward: number, right: number) {
    this.moveIn.set(THREE.MathUtils.clamp(right, -1, 1), THREE.MathUtils.clamp(forward, -1, 1))
    // a diagonal is no faster than a straight
    if (this.moveIn.lengthSq() > 1) this.moveIn.normalize()
  }

  /**
   * Fly the overview camera and its orbit pivot together over the ground plane. The speed scales
   * with the orbit distance so a zoomed-out view crosses the circuit in a couple of seconds while
   * a close-up creeps; the velocity is smoothed so taps and releases do not jolt.
   */
  private moveOverview(dt: number) {
    const cam = this.camera
    const target = this.controls.target
    if (this.moveIn.lengthSq() > 0) {
      // screen-right is always horizontal (OrbitControls keeps the camera un-rolled); forward is
      // its ground-plane perpendicular, so this works looking straight down as well as level
      _right.set(1, 0, 0).applyQuaternion(cam.quaternion)
      _right.y = 0
      if (_right.lengthSq() < 1e-8) _right.set(1, 0, 0)
      _right.normalize()
      _dir.crossVectors(_up, _right)
      const speed = Math.max(cam.position.distanceTo(target), this.controls.minDistance) * MOVE_RATE
      _v.set(0, 0, 0).addScaledVector(_dir, this.moveIn.y * speed).addScaledVector(_right, this.moveIn.x * speed)
    } else {
      _v.set(0, 0, 0)
    }
    this.moveVel.lerp(_v, 1 - Math.exp(-dt * 12))
    if (this.moveVel.lengthSq() < 1e-4) {
      this.moveVel.set(0, 0, 0)
      return
    }
    _v.copy(this.moveVel).multiplyScalar(dt)
    // keep the pivot within reach of the circuit: clamp it and carry the camera by the same correction
    const b = this.track.bounds
    const margin = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) * MOVE_MARGIN
    const nx = THREE.MathUtils.clamp(target.x + _v.x, b.minX - margin, b.maxX + margin)
    const nz = THREE.MathUtils.clamp(target.z + _v.z, b.minZ - margin, b.maxZ + margin)
    _v.set(nx - target.x, 0, nz - target.z)
    target.add(_v)
    cam.position.add(_v)
  }

  setMode(mode: CameraMode) {
    if (mode === this.mode) return
    this.mode = mode
    this.justSwitched = true
    this.moveVel.set(0, 0, 0)
    this.controls.enabled = mode === 'overview'
    if (mode === 'overview') this.resetOverview()
    if (mode === 'onboard') this.camera.fov = 75
    else if (mode === 'chase') this.camera.fov = 55
    else if (mode === 'heli') this.camera.fov = 38
    // the near plane follows the shot: nothing sits closer than this to the lens in each mode
    this.camera.near = NEAR[mode]
    this.camera.updateProjectionMatrix()
  }

  /**
   * @param dt real-time delta (seconds)
   * @param simScale simulation speed multiplier — smoothing is sped up so the camera never lags the car
   */
  update(dt: number, target: CameraTarget | null, simScale = 1) {
    if (this.mode === 'overview' || !target) {
      if (this.mode === 'overview') this.moveOverview(dt)
      this.controls.update()
      return
    }
    const realDt = dt
    dt *= Math.max(1, simScale)
    this.time += realDt
    const p = target.position
    const t = target.tangent
    const n = target.normal
    const up = _up
    const k = this.justSwitched ? 1 : 1 - Math.exp(-dt * 5)
    const v = target.speed
    switch (this.mode) {
      case 'chase': {
        _v.copy(p).addScaledVector(t, -11).addScaledVector(up, 3.4)
        _look.copy(p).addScaledVector(t, 9).addScaledVector(up, 0.9)
        this.smoothPos.lerp(_v, this.justSwitched ? 1 : 1 - Math.exp(-dt * 7))
        this.smoothLook.lerp(_look, k)
        this.camera.position.copy(this.smoothPos)
        this.camera.lookAt(this.smoothLook)
        // the chase camera leans into the corner with the car
        this.camera.rotateZ(-target.aLat * 0.0004)
        break
      }
      case 'onboard': {
        // T-cam: rigidly mounted on the roll hoop, so it shakes with the car
        _v.copy(p).addScaledVector(t, -0.2).addScaledVector(up, 1.34)
        _look.copy(p).addScaledVector(t, 40).addScaledVector(up, 0.4)
        this.camera.position.copy(_v)
        this.camera.lookAt(_look)
        // the horizon tilts against lateral g and dips under braking
        this.camera.rotateZ(-target.aLat * 0.0008)
        this.camera.rotateX(target.aLon * 0.0006)
        // engine / road vibration, growing with speed; combustion-order buzz plus road noise
        const amp = 0.0016 * (v / 90) ** 2 + (v > 2 ? 0.0002 : 0)
        const buzz = Math.sin(this.time * (target.rpm / 60) * 2 * Math.PI * 0.5)
        this.camera.rotateX(amp * (buzz * 0.5 + noise1(this.time * 17.0) * 0.8))
        this.camera.rotateY(amp * (noise1(this.time * 13.0 + 5.0) * 0.6))
        this.camera.rotateZ(amp * 0.5 * noise1(this.time * 9.0 + 11.0))
        this.smoothPos.copy(_v)
        this.smoothLook.copy(_look)
        break
      }
      case 'heli': {
        this.heliAngle += dt * 0.12
        const side = Math.sin(this.heliAngle) * 50
        const alt = 52 + Math.sin(this.time * 0.21) * 6
        _v.copy(p).addScaledVector(t, -78).addScaledVector(n, side).addScaledVector(up, alt)
        _look.copy(p).addScaledVector(t, 18 + Math.sin(this.time * 0.3) * 6).addScaledVector(n, Math.cos(this.time * 0.23) * 4)
        this.smoothPos.lerp(_v, this.justSwitched ? 1 : 1 - Math.exp(-dt * 1.6))
        this.smoothLook.lerp(_look, this.justSwitched ? 1 : 1 - Math.exp(-dt * 4))
        this.camera.position.copy(this.smoothPos)
        this.camera.lookAt(this.smoothLook)
        // the helicopter banks as it follows the car through a corner
        this.camera.rotateZ(-target.aLat * 0.0012 + noise1(this.time * 0.7) * 0.004)
        break
      }
      case 'tv': {
        const L = this.track.length
        this.tvHold += realDt
        let keep = false
        if (this.tvIndex >= 0) {
          const cam = this.tvCams[this.tvIndex]!
          const d = forwardDelta(target.s, cam.s, L)
          keep = d < 280 || d > L - 70 || this.tvHold < 1.5
        }
        if (!keep) {
          let best = -1
          let bestD = Infinity
          this.tvCams.forEach((cam, i) => {
            let d = forwardDelta(target.s, cam.s, L)
            if (d > L - 60) d = 0
            if (d < bestD) {
              bestD = d
              best = i
            }
          })
          if (best !== this.tvIndex) {
            this.justSwitched = true
            this.tvHold = 0
          }
          this.tvIndex = best
        }
        const cam = this.tvCams[this.tvIndex]!
        this.tvCamName = `CAM ${this.tvIndex + 1} · ${cam.name}`
        this.camera.position.copy(cam.position)
        _look.copy(p).addScaledVector(up, 0.6)
        _dir.copy(_look).sub(cam.position).normalize()
        if (this.justSwitched) {
          this.lookDir.copy(_dir)
          this.lookVel.set(0, 0, 0)
        } else {
          // a camera operator: a damped spring on the viewing *direction* (not on a point in
          // the world), so the lag behind a car sweeping past is the same small fraction of
          // the picture whatever the lens and distance, with a cap on how fast the head pans.
          // Lag = angular rate × damping / stiffness (0.04 s), slightly under-damped.
          const stiffness = 2000, damping = 80
          const maxPan = (180 * Math.PI) / 180
          let remaining = Math.min(dt, 0.25)
          while (remaining > 0) {
            const step = Math.min(remaining, 0.005)
            remaining -= step
            _v.copy(_dir).sub(this.lookDir).multiplyScalar(stiffness).addScaledVector(this.lookVel, -damping)
            this.lookVel.addScaledVector(_v, step)
            if (this.lookVel.lengthSq() > maxPan * maxPan) this.lookVel.setLength(maxPan)
            this.lookDir.addScaledVector(this.lookVel, step).normalize()
            // keep the angular velocity tangent to the unit sphere
            this.lookVel.addScaledVector(this.lookDir, -this.lookVel.dot(this.lookDir))
          }
        }
        this.smoothLook.copy(cam.position).addScaledVector(this.lookDir, 100)
        this.camera.lookAt(this.smoothLook)
        const dist = cam.position.distanceTo(p)
        // frame the car at ~1/6 of the picture height; long lenses go down to a 2° field of view
        const fov = THREE.MathUtils.clamp((2 * Math.atan(11 / dist) * 180) / Math.PI, 2, 40)
        this.smoothFov += (fov - this.smoothFov) * (this.justSwitched ? 1 : 1 - Math.exp(-dt * 4))
        this.camera.fov = this.smoothFov
        this.camera.updateProjectionMatrix()
        // long-lens tremble: a slow wobble of 0.2 % of the picture height, whatever the lens
        // (a fixed angle would grow to a tenth of the frame on the 2° lenses)
        const tremble = ((this.smoothFov * Math.PI) / 180) * 0.002
        this.camera.rotateX(tremble * wobble(this.time))
        this.camera.rotateY(tremble * wobble(this.time + 7.0))
        break
      }
    }
    this.justSwitched = false
  }

  dispose() {
    this.controls.dispose()
  }
}

export const OVERVIEW_TARGET_HEIGHT = 24
export { CIRCUIT }
