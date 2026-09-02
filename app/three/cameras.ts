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

interface TvCamera {
  s: number
  position: THREE.Vector3
  name: string
}

const _v = new THREE.Vector3()
const _look = new THREE.Vector3()

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
  private lookVel = new THREE.Vector3()
  private smoothFov = 40
  private justSwitched = true
  private time = 0
  private tvHold = 0
  tvCamName = ''

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
    this.controls.update()
  }

  setMode(mode: CameraMode) {
    if (mode === this.mode) return
    this.mode = mode
    this.justSwitched = true
    this.controls.enabled = mode === 'overview'
    if (mode === 'overview') this.resetOverview()
    if (mode === 'onboard') this.camera.fov = 75
    else if (mode === 'chase') this.camera.fov = 55
    else if (mode === 'heli') this.camera.fov = 38
    this.camera.updateProjectionMatrix()
  }

  /**
   * @param dt real-time delta (seconds)
   * @param simScale simulation speed multiplier — smoothing is sped up so the camera never lags the car
   */
  update(dt: number, target: CameraTarget | null, simScale = 1) {
    if (this.mode === 'overview' || !target) {
      this.controls.update()
      return
    }
    const realDt = dt
    dt *= Math.max(1, simScale)
    this.time += realDt
    const p = target.position
    const t = target.tangent
    const n = target.normal
    const up = new THREE.Vector3(0, 1, 0)
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
        if (this.justSwitched) {
          this.smoothLook.copy(_look)
          this.lookVel.set(0, 0, 0)
        } else {
          // a camera operator: a damped spring on the framing that lags a car passing close by
          // and overshoots slightly as it recovers, with a cap on how fast the head can pan
          const stiffness = 40, damping = 12
          const step = Math.min(dt, 0.05)
          _v.copy(_look).sub(this.smoothLook).multiplyScalar(stiffness).addScaledVector(this.lookVel, -damping)
          this.lookVel.addScaledVector(_v, step)
          const dist0 = this.smoothLook.distanceTo(cam.position)
          const maxPan = ((120 * Math.PI) / 180) * dist0 // m/s of look-point travel at 120°/s
          if (this.lookVel.length() > maxPan) this.lookVel.setLength(maxPan)
          this.smoothLook.addScaledVector(this.lookVel, step)
        }
        this.camera.lookAt(this.smoothLook)
        const dist = cam.position.distanceTo(p)
        // frame the car at ~1/6 of the picture height; long lenses go down to a 2° field of view
        const fov = THREE.MathUtils.clamp((2 * Math.atan(11 / dist) * 180) / Math.PI, 2, 40)
        this.smoothFov += (fov - this.smoothFov) * (this.justSwitched ? 1 : 1 - Math.exp(-dt * 4))
        this.camera.fov = this.smoothFov
        this.camera.updateProjectionMatrix()
        // long-lens tremble: a fixed angular wobble looks bigger the tighter the shot
        const tremble = ((0.012 * Math.PI) / 180) * (35 / this.smoothFov)
        this.camera.rotateX(tremble * noise1(this.time * 5.1))
        this.camera.rotateY(tremble * noise1(this.time * 4.3 + 7.0))
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
