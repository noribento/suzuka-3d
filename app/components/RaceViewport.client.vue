<script setup lang="ts">
import * as THREE from 'three'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { getTrack, type Pose } from '~/sim/track'
import { RaceSim, formatGapTv, formatLapTime, gearFor, type RaceStatus } from '~/sim/race'
import { DRIVERS, TEAMS } from '~/data/drivers'
import { CIRCUIT } from '~/data/suzuka'
import { toMap } from '~/sim/projection'
import { createScene, type SceneContext } from '~/three/scene'
import { probeCapabilities } from '~/three/quality'
import { freezeStatic } from '~/three/instancing'
import { markAllDirty, textureBytes } from '~/three/textures'
import { buildTrackMeshes, type TrackMeshes } from '~/three/track-mesh'
import { buildEnvironment, type Environment } from '~/three/environment'
import { buildCarModel, CAR_DIMENSIONS, type CarModel } from '~/three/car-model'
import { buildBarriers } from '~/three/barriers'
import { ParticleSystem, SkidMarks } from '~/three/particles'
import { RaceAudio, type CarAudioState } from '~/three/audio'
import { CameraRig, type CameraTarget } from '~/three/cameras'
import { EMISSIVE, emissiveScale, setEmissiveTier } from '~/three/emissive'
import { DISC_FRONT, DISC_REAR, GRID_DISC_C, LOCK_SPIKE_C, stepDiscTemp } from '~/sim/brake-thermal'
import { useRaceStore, type CameraMode, type HudDriver } from '~/composables/useRaceStore'

const { store, broadcast, pushEvent, pushFeed, wake, select, setCamera, selectByPosition, resetBroadcast } = useRaceStore()
const container = ref<HTMLDivElement>()
const canvas = ref<HTMLCanvasElement>()
const labelLayer = ref<HTMLDivElement>()

let ctx: SceneContext | null = null
let rig: CameraRig | null = null
let env: Environment | null = null
let trackMeshes: TrackMeshes | null = null
let race: RaceSim | null = null
let models: CarModel[] = []
let labelEls: HTMLDivElement[] = []
/** per-car label visibility decided in the loop (before projection) */
const labelVisible = new Uint8Array(22)
const _lv = new THREE.Vector3()
let compoundCache: string[] = []
let raf = 0
let resizeObserver: ResizeObserver | null = null
let gridTimer = 0
let lastHud = 0
let lastNowMs = 0
let lastGapToggle = 0
let fpsAcc = 0
let fpsCount = 0
/** fps-driven render-resolution scale (high tier): 1 → 0.85 → 0.7 with hysteresis; `?res=0` pins it */
const resCtl = { k: 1, low: 0, high: 0, enabled: typeof location === 'undefined' || new URLSearchParams(location.search).get('res') !== '0' }
let pointerDown: { x: number; y: number } | null = null
let framesRendered = 0
/** real-time clock for effects (rain-light flash, …): advances while not paused, reset on restart */
let fxClock = 0
/** last start-lamp state written to the gantry materials; the same transition fires the start-light beeps */
let prevLights = 0
let prevStatus: RaceStatus | '' = ''
let audioFailed = false
let setupMs = 0
// dev-only per-section frame timings (ms, exponential average and running max), read by scripts/perf-probe.mjs
const PERF = import.meta.dev
const perf = { sim: 0, place: 0, fx: 0, cam: 0, audio: 0, render: 0, labels: 0, hud: 0 }
const perfMax = { sim: 0, place: 0, fx: 0, cam: 0, audio: 0, render: 0, labels: 0, hud: 0 }
function mark(section: keyof typeof perf, t0: number) {
  const ms = performance.now() - t0
  perf[section] += (ms - perf[section]) * 0.05
  if (ms > perfMax[section]) perfMax[section] = ms
}
const timer = new THREE.Timer()
let lastOvertakeBanner = 0
let sparks: ParticleSystem | null = null
let smoke: ParticleSystem | null = null
let marks: SkidMarks | null = null
let audio: RaceAudio | null = null
let audioStates: CarAudioState[] = []
const trapArmed = new Uint8Array(22).fill(1)
const _tmp = new THREE.Vector3()
const _side = new THREE.Vector3()
const _vel = new THREE.Vector3()
const pose: Pose = { x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: 1, nx: 1, nz: 0, kappa: 0, roll: 0 }
const _m = new THREE.Matrix4()
const _target = new THREE.Vector3()
const _fwd = new THREE.Vector3()
const _carUp = new THREE.Vector3(0, 1, 0)
const _sunLocal = new THREE.Vector3()
const _qInv = new THREE.Quaternion()
const _camFwd = new THREE.Vector3()
const camTarget: CameraTarget = { position: new THREE.Vector3(), tangent: new THREE.Vector3(), normal: new THREE.Vector3(), speed: 0, s: 0, aLon: 0, aLat: 0, rpm: 0 }
const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()
const track = getTrack()

function makeHudDrivers(): HudDriver[] {
  return DRIVERS.map((d, idx) => ({
    idx,
    code: d.code,
    firstName: d.firstName,
    lastName: d.lastName,
    number: d.number,
    team: d.team,
    teamName: TEAMS[d.team].name,
    color: TEAMS[d.team].tv,
    position: idx + 1,
    lapsCompleted: 0,
    gapText: '',
    intervalText: '',
    gapSec: 0,
    intervalSec: 0,
    lastLap: 0,
    bestLap: 0,
    currentLap: 0,
    speedKmh: 0,
    gear: 0,
    rpm: 0,
    throttle: 0,
    brake: 0,
    drs: false,
    drsEligible: false,
    compound: 'M',
    tyreAge: 0,
    pitState: 'none',
    pitStops: 0,
    sectors: [null, null, null],
    sectorFlags: [0, 0, 0],
    location: '',
    finished: false,
    inPit: false,
    mapX: 0,
    mapY: 0,
    hasFastestLap: false,
    positionDelta: 0,
    gridPosition: idx + 1,
    stints: [],
    trapKmh: 0,
    steer: 0,
    brakeTempF: 0,
    brakeTempR: 0,
    tvGap: '',
    tvInterval: '',
    miniSector: -1,
    aheadIdx: -1,
    posFlash: null,
    pitOutUntil: 0,
  }))
}

/**
 * Position changes for the broadcast tower are committed only once the new position has held
 * for POS_SETTLE_MS: the 30 Hz sort flips cars running side by side several times a second,
 * while the real tower reorders at timing loops.
 */
const POS_SETTLE_MS = 400
const posPending: { committed: number; pos: number; since: number }[] = []
let flashKey = 0

function initRace() {
  race = new RaceSim(track, (Date.now() % 100000) + 17, CIRCUIT.laps)
  store.drivers = makeHudDrivers()
  store.order = race.order.map((c) => c.idx)
  store.totalLaps = race.totalLaps
  store.status = 'grid'
  store.lap = 1
  store.elapsed = 0
  store.events = []
  store.fastestLap = null
  store.winner = null
  store.lights = 0
  store.battle = null
  store.lowerThird = null
  store.speedTrap = null
  gridTimer = 0
  fxClock = 0
  prevLights = 0
  prevStatus = ''
  motion.length = 0
  trapArmed.fill(1)
  posPending.length = 0
  resetBroadcast()
  director.hint = null
  director.follow = -1
  race.cars.forEach((car, i) => {
    const m = models[i]
    if (m) {
      m.setCompound(car.compound)
      compoundCache[i] = car.compound
    }
    const d = store.drivers[i]!
    d.gridPosition = car.position
    d.stints = [{ compound: car.compound, laps: 0 }]
    d.trapKmh = 0
  })
  syncHud(true)
}

/** A car label: an absolutely positioned element in the label layer, placed by placeLabels(). */
function buildLabel(idx: number) {
  const d = DRIVERS[idx]!
  const el = document.createElement('div')
  el.className = 'car-label'
  el.style.setProperty('--team', TEAMS[d.team].tv)
  el.style.position = 'absolute'
  el.style.left = '0'
  el.style.top = '0'
  el.style.display = 'none'
  el.innerHTML = `<span class="pos"></span><span class="code">${d.code}</span>`
  el.addEventListener('pointerdown', (e) => {
    e.stopPropagation()
    select(idx)
  })
  labelEls[idx] = el
  labelLayer.value?.appendChild(el)
}

/**
 * Project the 22 car labels straight through the camera (replaces CSS2DRenderer, which walked
 * the whole scene twice per frame and sorted it for 22 elements). display:none keeps the
 * hidden state CSS2D used, so `.car-label:visible` means the same thing.
 */
function placeLabels() {
  if (!rig || !container.value) return
  const w = container.value.clientWidth
  const h = container.value.clientHeight
  for (let i = 0; i < models.length; i++) {
    const el = labelEls[i]
    if (!el) continue
    let show = labelVisible[i] === 1
    if (show) {
      _lv.copy(models[i]!.root.position)
      _lv.y += 2.0
      // stacking by view distance (NDC z is not comparable across the reversed / log depth paths)
      const dist = _lv.distanceTo(rig.camera.position)
      _lv.project(rig.camera)
      show = Math.abs(_lv.x) <= 1.1 && Math.abs(_lv.y) <= 1.1
      if (show) {
        const x = Math.round((_lv.x + 1) * 0.5 * w * 2) / 2
        const y = Math.round((1 - _lv.y) * 0.5 * h * 2) / 2
        el.style.transform = `translate(-50%, -110%) translate(${x}px, ${y}px)`
        el.style.zIndex = String(Math.max(0, 20000 - Math.round(dist)))
      }
    }
    const display = show ? '' : 'none'
    if (el.style.display !== display) el.style.display = display
  }
}

function setup() {
  if (!canvas.value || !container.value || !labelLayer.value) return
  const t0 = performance.now()
  rig = new CameraRig(track, container.value)
  // the GPU is probed on a throwaway context first: the tier decides context-creation flags
  ctx = createScene(canvas.value, rig.camera, track.center, probeCapabilities())
  const q = ctx.quality
  // the emissive budget depends on whether bloom exists — decide before any lit material is built
  setEmissiveTier(ctx.tier)

  env = buildEnvironment(track, q)
  ctx.scene.add(env.group)
  trackMeshes = buildTrackMeshes(track, env.terrain, env.ground)
  // the track meshes pushed the terrain under the road: upload the grid once, now
  env.terrain.commit()
  ctx.scene.add(trackMeshes.group)
  const barriers = buildBarriers(track, q, env.ground)
  ctx.scene.add(barriers)
  // nothing in these trees moves except the Ferris wheel: compute their matrices once
  freezeStatic(env.group, env.ferrisWheel ? [env.ferrisWheel] : [])
  freezeStatic(trackMeshes.group)
  freezeStatic(barriers)
  // effects: sparks off the plank, tyre smoke, skid marks
  sparks = new ParticleSystem({ capacity: q.sparks, kind: 'spark', additive: true, gravity: 9.81, drag: 2.4 })
  smoke = new ParticleSystem({ capacity: q.smoke, kind: 'smoke', additive: false, gravity: -0.5, drag: 1.6 })
  marks = new SkidMarks(q.skidQuads)
  ctx.scene.add(sparks.points, smoke.points, marks.mesh)
  ctx.setTimeOfDay(store.timeOfDay)

  models = DRIVERS.map((d, idx) => {
    const m = buildCarModel(d, 'M', ctx!.tier === 'high')
    m.root.userData.carIndex = idx
    buildLabel(idx)
    ctx!.scene.add(m.root)
    return m
  })
  ctx.setupMaterials(ctx.scene)

  initRace()
  onResize()
  resizeObserver = new ResizeObserver(onResize)
  resizeObserver.observe(container.value)
  store.ready = true
  setupMs = performance.now() - t0
  if (import.meta.dev) {
    // debug hook for the e2e suite and the probe scripts (getters keep restart / audio creation live)
    ;(window as unknown as { __suzuka: unknown }).__suzuka = {
      THREE, ctx, rig, track, env, trackMeshes, models, motion, store, perf, perfMax,
      get race() { return race },
      get audio() { return audio },
      RaceAudio,
      get setupMs() { return setupMs },
      steerTune: STEER,
      resCtl,
      textureBytes,
    }
  }
  // GPU reset: keep the context restorable, stop the loop, and re-upload everything on return
  canvas.value.addEventListener('webglcontextlost', onContextLost)
  canvas.value.addEventListener('webglcontextrestored', onContextRestored)
  raf = requestAnimationFrame(loop)
}

let contextLost = false
function onContextLost(e: Event) {
  e.preventDefault()
  contextLost = true
  cancelAnimationFrame(raf)
}
function onContextRestored() {
  if (!contextLost || !ctx) return
  contextLost = false
  // canvases are still there: flag every cached texture, rebuild the CSM programs, redo the maps
  markAllDirty()
  ctx.refreshMaterials(ctx.scene)
  ctx.forceShadowUpdate()
  framesRendered = 0
  timer.update()
  timer.update()
  cancelAnimationFrame(raf)
  raf = requestAnimationFrame(loop)
}

function onResize() {
  if (!container.value || !ctx || !rig) return
  const w = container.value.clientWidth
  const h = container.value.clientHeight
  ctx.setSize(w, h)
  if (labelLayer.value) {
    labelLayer.value.style.width = `${w}px`
    labelLayer.value.style.height = `${h}px`
  }
  const px = h * ctx.renderer.getPixelRatio()
  sparks?.setViewport(px, w * ctx.renderer.getPixelRatio())
  smoke?.setViewport(px, w * ctx.renderer.getPixelRatio())
  rig.camera.aspect = w / h
  rig.camera.updateProjectionMatrix()
}

/** Per-car motion state derived from the simulation (the sim itself is a point on the road). */
interface CarMotion {
  prevV: number
  prevLat: number
  aLon: number
  aLat: number
  slip: number
  /** spark emission accumulator */
  sparkAcc: number
  smokeAcc: number
  /** locked front wheel (index into model.wheels) and remaining time, -1 when none */
  lockWheel: number
  lockTimer: number
  wasBraking: boolean
  bumpPhase: number
  /** previous frame's heading (rad, track convention), NaN before the first frame */
  prevPsi: number
  /** curvature of the path the body actually sweeps (1/m, + = left), low-passed */
  kPath: number
  /** bicycle-model road-wheel steer angle (rad, + = left) */
  steer: number
  /** per-wheel spin multiplier [FL, RL, FR, RR]: 0 for a locked wheel, >1 under wheelspin */
  spinFactor: Float32Array
  /** brake disc temperatures (°C) [FL, RL, FR, RR] */
  brakeT: Float32Array
  /** braking energy per unit mass this frame (m²/s²) */
  brakeE: number
  /** last frame's pedal, so a braking zone that ends inside a long frame still counts */
  prevBrake: number
  /** locked wheel whose lock-onset spike has been applied (-1 = none) */
  lockShown: number
  /** drum / upright warm-through temperature (°C): lags the hottest disc with τ ≈ 5 s */
  drumT: number
}
const motion: CarMotion[] = []
/**
 * Steering tunables: driver preview of the racing line (s), understeer gradient (rad per g of
 * lateral acceleration), road-wheel lock (rad, 20°) and the κ_path low-pass rate (1/s, τ≈0.083 s).
 */
const STEER = { lead: 0.2, usGrad: 0.012, lock: 0.35, kRate: 12 }
let fxRng = 1

function rnd(): number {
  // small LCG: effects only, never touches the race's seeded RNG
  fxRng = (fxRng * 1664525 + 1013904223) >>> 0
  return fxRng / 4294967296
}

/** Wheel contact-patch position in car-local space. */
function wheelLocal(w: number, out: THREE.Vector3): THREE.Vector3 {
  const front = w === 0 || w === 2
  const sgn = w < 2 ? 1 : -1
  return out.set(sgn * (front ? CAR_DIMENSIONS.frontTrackHalf : CAR_DIMENSIONS.rearTrackHalf), 0.02, front ? CAR_DIMENSIONS.wheelbase / 2 : -CAR_DIMENSIONS.wheelbase / 2)
}

/**
 * Sparks, tyre smoke and rubber for one car. Sparks fly when the plank bottoms out at speed
 * (heavy braking from top speed, bumps on the straights); smoke and a black stripe come from
 * the occasional front lock-up into a slow corner and from wheelspin off the line.
 */
function updateEffects(i: number, mo: CarMotion, simDt: number) {
  mo.spinFactor.fill(1)
  if (!sparks || !smoke || !marks || simDt <= 0) return
  const car = race!.cars[i]!
  const m = models[i]!
  const q = m.root.quaternion
  const p = m.root.position
  const v = car.v
  _vel.set(0, 0, v).applyQuaternion(q)
  _side.set(1, 0, 0).applyQuaternion(q)
  const groundY = p.y

  // --- sparks ---------------------------------------------------------------------------
  mo.bumpPhase = car.s
  const bumpy = Math.sin(car.s * 0.19) * Math.sin(car.s * 0.031 + 1.7) > 0.62
  const straight = Math.abs(track.kappaLineAt(car.s)) < 1 / 260
  let rate = 0
  if (v > 60 && mo.aLon < -16) rate = 140
  else if (v > 72 && straight && bumpy) rate = 55
  if (rate > 0) {
    mo.sparkAcc += rate * simDt
    while (mo.sparkAcc >= 1) {
      mo.sparkAcc -= 1
      _tmp.set((rnd() - 0.5) * 0.8, 0.03, -0.6 + rnd() * 1.4).applyQuaternion(q).add(p)
      const k = 0.82 + rnd() * 0.12
      const sp = EMISSIVE.spark
      const heat = (sp.heatMin + rnd() * (sp.heatMax - sp.heatMin)) * emissiveScale()
      sparks.emit(
        _tmp.x, _tmp.y, _tmp.z,
        _vel.x * k + (rnd() - 0.5) * 5, 0.4 + rnd() * 2.2, _vel.z * k + (rnd() - 0.5) * 5,
        0.09 + rnd() * 0.07, 0.3 + rnd() * 0.45,
        sp.rgb[0] * heat, sp.rgb[1] * heat, sp.rgb[2] * heat, groundY + 0.01,
      )
    }
  } else {
    mo.sparkAcc = 0
  }

  // --- lock-ups -------------------------------------------------------------------------
  const braking = car.brake > 0.85 && mo.aLon < -32
  if (braking && !mo.wasBraking && mo.lockWheel < 0 && rnd() < 0.07) {
    mo.lockWheel = rnd() < 0.5 ? 0 : 2
    mo.lockTimer = 0.3 + rnd() * 0.35
  }
  mo.wasBraking = braking
  const wheelspin = race!.status === 'racing' && race!.time < 2.4 && v > 0.5 && v < 26 && car.launchFactor < 0.87
  if (mo.lockTimer > 0 || wheelspin) {
    // a locked wheel stops turning; spinning rears turn faster than the road speed
    if (wheelspin) mo.spinFactor[1] = mo.spinFactor[3] = 1.6
    if (mo.lockTimer > 0) mo.spinFactor[mo.lockWheel] = 0
    const wheelsOn = wheelspin ? [1, 3] : [mo.lockWheel]
    for (const w of wheelsOn) {
      wheelLocal(w, _tmp).applyQuaternion(q).add(p)
      const key = i * 4 + w
      marks.lay(key, _tmp, _side, w === 0 || w === 2 ? CAR_DIMENSIONS.frontTyreWidth : CAR_DIMENSIONS.rearTyreWidth, wheelspin ? 0.5 : 0.85)
      mo.smokeAcc += (wheelspin ? 40 : 70) * simDt
      while (mo.smokeAcc >= 1) {
        mo.smokeAcc -= 1
        smoke.emit(
          _tmp.x + (rnd() - 0.5) * 0.2, _tmp.y + 0.15, _tmp.z + (rnd() - 0.5) * 0.2,
          _vel.x * 0.25 + (rnd() - 0.5) * 1.5, 0.6 + rnd() * 1.2, _vel.z * 0.25 + (rnd() - 0.5) * 1.5,
          0.45 + rnd() * 0.3, 1.1 + rnd() * 0.9,
          0.82, 0.82, 0.84, -1e4, 2.2,
        )
      }
    }
    if (mo.lockTimer > 0) {
      mo.lockTimer -= simDt
      if (mo.lockTimer <= 0) {
        marks.end(i * 4 + mo.lockWheel)
        mo.lockWheel = -1
      }
    }
  } else if (mo.smokeAcc > 0) {
    mo.smokeAcc = 0
    marks.end(i * 4 + 1)
    marks.end(i * 4 + 3)
  }
}

function placeCar(i: number, simDt: number) {
  const car = race!.cars[i]!
  const m = models[i]!
  const mo = (motion[i] ??= { prevV: car.v, prevLat: car.lateral, aLon: 0, aLat: 0, slip: 0, sparkAcc: 0, smokeAcc: 0, lockWheel: -1, lockTimer: 0, wasBraking: false, bumpPhase: 0, prevPsi: NaN, kPath: 0, steer: 0, spinFactor: new Float32Array([1, 1, 1, 1]), brakeT: new Float32Array(4).fill(GRID_DISC_C), brakeE: 0, prevBrake: 0, lockShown: -1, drumT: GRID_DISC_C })
  track.poseAt(car.s, car.lateral, pose)
  if (simDt > 0) {
    // accelerations and the yaw the lateral motion implies (a lane change is a real
    // steering input, not a sideways slide)
    const k = Math.min(1, simDt * 10)
    mo.aLon += ((car.v - mo.prevV) / simDt - mo.aLon) * k
    const vLat = (car.lateral - mo.prevLat) / simDt
    mo.slip += (Math.atan2(vLat, Math.max(car.v, 6)) - mo.slip) * Math.min(1, simDt * 14)
    // lateral g from the curvature the speed model actually believes (calibrated to the apex
    // targets) — the raw centreline curvature reads up to 3× too high in the fast corners
    mo.aLat = car.v * car.v * race!.kappaPhysAt(car.s) + vLat * 0.5
    // braking energy per unit mass, ½Δv² integrates a·v exactly over any frame length; the pedal
    // is sampled at the end of the frame, so also count a frame in which braking just ended
    mo.brakeE = car.brake > 0 || mo.prevBrake > 0 ? Math.max(0, (mo.prevV * mo.prevV - car.v * car.v) * 0.5) : 0
    mo.prevBrake = car.brake
    mo.prevV = car.v
    mo.prevLat = car.lateral
  }
  m.root.position.set(pose.x, pose.y, pose.z)
  const cs = Math.cos(mo.slip), sn = Math.sin(mo.slip)
  _fwd.set(pose.tx * cs + pose.nx * sn, pose.ty * cs, pose.tz * cs + pose.nz * sn)
  _target.copy(m.root.position).add(_fwd)
  // the car sits on the cambered road: tilt "up" about the tangent by the road roll
  const cr = Math.cos(pose.roll), sr = Math.sin(pose.roll)
  _carUp.set(-pose.nx * sr, cr, -pose.nz * sr)
  _m.lookAt(_target, m.root.position, _carUp)
  m.root.quaternion.setFromRotationMatrix(_m)
  if (simDt > 0) {
    // steering follows the arc the body actually sweeps (κ_path = Δψ/Δs from the forward vector,
    // low-passed to kill the 2 m tangent-interpolation noise) plus the driver's ~0.2 s preview
    // of the racing line, which leads the wheels into the corner and unwinds them past the apex;
    // a small understeer gradient adds lock with lateral g, as on a real car
    const psi = Math.atan2(-_fwd.z, _fwd.x)
    const ds = car.v * simDt
    if (ds > 0.05 && Number.isFinite(mo.prevPsi)) {
      let dpsi = psi - mo.prevPsi
      if (dpsi > Math.PI) dpsi -= 2 * Math.PI
      else if (dpsi < -Math.PI) dpsi += 2 * Math.PI
      mo.kPath += (dpsi / ds - mo.kPath) * Math.min(1, simDt * STEER.kRate)
    }
    mo.prevPsi = psi
    const kCmd = mo.kPath + track.kappaLineAt(car.s + car.v * STEER.lead) - track.kappaLineAt(car.s)
    const target = Math.atan(CAR_DIMENSIONS.wheelbase * kCmd) + STEER.usGrad * THREE.MathUtils.clamp(mo.aLat / 9.81, -5, 5)
    mo.steer += (THREE.MathUtils.clamp(target, -STEER.lock, STEER.lock) - mo.steer) * Math.min(1, simDt * 10)
  }
  // effects first: they decide this frame's lock-up / wheelspin state for the spin loop
  updateEffects(i, mo, simDt)
  const spin = (car.v * simDt) / CAR_DIMENSIONS.wheelRadius
  for (let w = 0; w < 4; w++) m.wheels[w]!.rotation.x += spin * mo.spinFactor[w]!
  for (let w = 0; w < m.midWheels.length; w++) m.midWheels[w]!.rotation.x += spin * mo.spinFactor[w]!
  m.setSteer(mo.steer)
  m.setDrs(car.drsOpen, simDt)
  // shadow casting by distance (every caster is re-rendered per cascade): the detailed car
  // within casterGateLod0, the cheap LOD-1/2 meshes out to casterGateLod1, the contact blob beyond
  const d2 = rig!.camera.position.distanceToSquared(m.root.position)
  const g0 = ctx!.quality.casterGateLod0, g1 = ctx!.quality.casterGateLod1
  const level: 0 | 1 | 3 = d2 < g0 * g0 ? 0 : d2 < g1 * g1 ? 1 : 3
  m.setShadows(level)
  _sunLocal.copy(ctx!.sunDirection).applyQuaternion(_qInv.copy(m.root.quaternion).invert())
  m.setContactShadow(_sunLocal, level < 3, simDt)
  m.setDynamics({ aLon: mo.aLon, aLat: mo.aLat, v: car.v, dt: simDt })
  // brake discs: a locked wheel gets a one-off spike at lock onset and no braking heat while it
  // slides (the rubber takes the energy); the others heat with the frame's braking energy
  if (simDt > 0) {
    if (mo.lockWheel >= 0 && mo.lockWheel !== mo.lockShown) mo.brakeT[mo.lockWheel] = mo.brakeT[mo.lockWheel]! + LOCK_SPIKE_C
    mo.lockShown = mo.lockWheel
    for (let w = 0; w < 4; w++) {
      const front = w === 0 || w === 2
      mo.brakeT[w] = stepDiscTemp(mo.brakeT[w]!, w === mo.lockWheel ? 0 : mo.brakeE, car.v, simDt, front ? DISC_FRONT : DISC_REAR)
    }
  }
  if (simDt > 0) mo.drumT += (Math.max(mo.brakeT[0]!, mo.brakeT[1]!, mo.brakeT[2]!, mo.brakeT[3]!) - mo.drumT) * Math.min(1, simDt / 5)
  m.setBrakeTemps(mo.brakeT, mo.drumT)
  m.setWear(car.tyreAge)
  const st = race!.status
  // dry-weather rear light: pit-limiter / grid flash, and the MGU-K harvest flash under braking or
  // a lift (throttle is 0.35 when coasting, 1 when driving — race.ts), otherwise off
  const inPit = car.pitState !== 'none'
  const harvesting = st === 'racing' && !inPit && car.v > 15 && (car.brake > 0 || car.throttle < 0.5)
  m.setRainLight(inPit || st === 'grid' || st === 'lights' || harvesting ? 'flash' : 'off', fxClock + i * 0.13)
  if (compoundCache[i] !== car.compound) {
    compoundCache[i] = car.compound
    m.setCompound(car.compound)
  }
}

function loop() {
  raf = requestAnimationFrame(loop)
  if (!ctx || !rig || !race || !env || !trackMeshes) return
  timer.update()
  const rawDt = timer.getDelta()
  // real-time delta: drives the camera, the audio, the effect clocks and the start sequence
  const dt = Math.min(rawDt, 0.1)
  let simDt = 0
  let t0 = PERF ? performance.now() : 0
  if (!store.paused) {
    // the simulated slice is capped (20 substeps) so a stalled frame never snowballs into a
    // longer stall; at 60 fps even 8× stays far below the cap
    simDt = Math.min(dt * store.simSpeed, 0.4)
    fxClock += dt
    if (race.status === 'grid') {
      // hold the grid until the first click/key so an AudioContext exists for the countdown,
      // but never for more than a few seconds
      gridTimer += dt
      if (gridTimer > 2.2 && (store.interacted || gridTimer > 8)) race.startLights()
    }
    // the light sequence runs in real time at 1× (so the countdown can be heard) and is only
    // compressed up to 4× when the race is fast-forwarded
    race.step(race.status === 'lights' ? dt * Math.min(store.simSpeed, 4) : simDt)
  }
  if (PERF) { mark('sim', t0); t0 = performance.now() }
  for (let i = 0; i < models.length; i++) placeCar(i, simDt)
  if (PERF) { mark('place', t0); t0 = performance.now() }
  // a light westerly drifts the smoke across the track
  const wind = store.weather.wind
  sparks?.update(simDt, wind * 0.3, -wind * 0.2)
  smoke?.update(simDt, wind * 0.9, -wind * 0.5)

  // start lights on the gantry (HDR emissive so they bloom on the high tier): the materials are
  // rewritten only when a lamp changes, and the same transition fires the start-light beep
  const lights = race.status === 'lights' ? race.lights : 0
  if (lights !== prevLights || race.status !== prevStatus) {
    trackMeshes.startLampMaterials.forEach((mat, i) => {
      const on = i < lights
      mat.emissive.setHex(on ? EMISSIVE.startLamp.color : 0x000000)
      mat.emissiveIntensity = on ? EMISSIVE.startLamp.on * emissiveScale() : 0
      mat.color.setHex(on ? EMISSIVE.startLamp.bodyOn : EMISSIVE.startLamp.bodyOff)
    })
    // one identical beep per lamp (the F1-game cue); lights out itself is silent — only the crowd reacts
    if (lights > prevLights) audio?.lampBeep()
    if (prevStatus === 'lights' && race.status === 'racing') audio?.cue('lightsOut')
    prevLights = lights
    prevStatus = race.status
  }
  if (PERF) { mark('fx', t0); t0 = performance.now() }

  // camera
  if (store.cameraMode === 'director' && race.status === 'racing') runDirector(performance.now())
  let target: CameraTarget | null = null
  const sel = store.selected
  if (sel >= 0 && rig.mode !== 'overview') {
    const car = race.cars[sel]!
    const m = models[sel]!
    track.poseAt(car.s, car.lateral, pose)
    const mo = motion[sel]
    camTarget.position.copy(m.root.position)
    camTarget.tangent.set(pose.tx, pose.ty, pose.tz)
    camTarget.normal.set(pose.nx, 0, pose.nz)
    camTarget.speed = car.v
    camTarget.s = car.s
    camTarget.aLon = mo?.aLon ?? 0
    camTarget.aLat = mo?.aLat ?? 0
    camTarget.rpm = store.drivers[sel]?.rpm ?? 0
    target = camTarget
  }
  rig.update(dt, target, store.paused ? 1 : store.simSpeed)
  store.tvCamName = rig.mode === 'tv' ? rig.tvCamName : ''
  if (store.shot !== rig.mode) store.shot = rig.mode
  const dOverview = rig.mode === 'overview' || !target ? rig.camera.position.distanceTo(rig.controls.target) : 0
  if (rig.mode === 'overview' || !target) ctx.updateShadows('overview', dOverview)
  else ctx.updateShadows('follow', rig.camera.position.distanceTo(target.position))
  if (ctx.post) {
    // depth-reading passes follow the shot: AO in follow modes, DoF on the tv long lens,
    // camera-motion blur scaled by the subject's speed (none while paused: the camera is static)
    ctx.post.setMode(rig.mode)
    if (target) ctx.post.setFocus(rig.camera.position.distanceTo(target.position), rig.camera.fov)
    const blurGain = rig.mode === 'onboard' ? 1 : rig.mode === 'chase' ? 0.6 : rig.mode === 'tv' ? 0.4 : 0
    ctx.post.setBlur(target && !store.paused && ctx.quality.motionBlur ? THREE.MathUtils.clamp(target.speed / 90, 0, 1) * blurGain : 0)
  }

  // labels: when zoomed far out in the overview only tag the leaders + the selected car;
  // the world feed only tags cars on helicopter shots (its AR tags)
  const showLabels = store.labels && (broadcast.value ? rig.mode === 'heli' : rig.mode !== 'onboard')
  const farOut = rig.mode === 'overview' && dOverview > 1000
  // CSS2D's own behind-the-camera test reads NDC z, which a reversed-Z projection folds back
  // into range for points behind the lens — cull those here with the view direction instead
  _camFwd.set(0, 0, -1).applyQuaternion(rig.camera.quaternion)
  const camPos = rig.camera.position
  for (let i = 0; i < models.length; i++) {
    const car = race.cars[i]!
    const m = models[i]!
    const inFront = (m.root.position.x - camPos.x) * _camFwd.x + (m.root.position.y - camPos.y) * _camFwd.y + (m.root.position.z - camPos.z) * _camFwd.z > 0
    labelVisible[i] = showLabels && inFront && (!farOut || car.position <= 3 || i === sel) ? 1 : 0
  }
  env.update(simDt, rig.camera.position)
  if (PERF) { mark('cam', t0); t0 = performance.now() }

  // audio: created on the first user gesture (a click that landed before setup() still counts —
  // the browser's user activation is sticky); voices follow the nearest cars
  if (!audio && store.interacted && !audioFailed) startAudio()
  if (audio) {
    for (let i = 0; i < models.length; i++) {
      const st = (audioStates[i] ??= { position: new THREE.Vector3(), velocity: new THREE.Vector3(), rpm: 0, throttle: 0, brake: 0, drsOpen: false, gear: 0, v: 0, running: false })
      const car = race.cars[i]!
      const d = store.drivers[i]!
      st.position.copy(models[i]!.root.position)
      st.velocity.set(0, 0, car.v).applyQuaternion(models[i]!.root.quaternion)
      // gear and rpm from the same gearFor() call (the HUD's d.gear lags by up to 33 ms)
      const g = gearFor(car.v, d.gear, car.throttle)
      st.rpm = g.rpm
      st.gear = g.gear
      st.throttle = car.throttle
      st.brake = car.brake
      st.drsOpen = car.drsOpen
      st.v = car.v
      st.running = !store.paused
    }
    audio.update(dt, audioStates, rig.camera, rig.mode, ctx.scene, { status: race.status, lights: race.lights, lightsElapsed: race.lightsElapsed, time: race.time, simSpeed: store.simSpeed })
  }
  if (PERF) { mark('audio', t0); t0 = performance.now() }

  marks?.update(simDt)
  ctx.render(dt, store.weather.wind)
  if (PERF) { mark('render', t0); t0 = performance.now() }
  placeLabels()
  if (PERF) { mark('labels', t0); t0 = performance.now() }
  if (++framesRendered === 1) ctx.refreshMaterials(ctx.scene)

  const now = performance.now()
  fpsAcc += rawDt
  fpsCount++
  if (fpsAcc > 1) {
    store.fps = Math.round(fpsCount / fpsAcc)
    fpsAcc = 0
    fpsCount = 0
    if (ctx.tier === 'high' && resCtl.enabled) {
      // drop after 2 consecutive slow seconds, raise only after 4 fast ones (no oscillation)
      if (store.fps < 48) { resCtl.low++; resCtl.high = 0 }
      else if (store.fps > 58) { resCtl.high++; resCtl.low = 0 }
      else { resCtl.low = 0; resCtl.high = 0 }
      let k = resCtl.k
      if (resCtl.low >= 2 && k > 0.71) { k -= 0.15; resCtl.low = 0 }
      else if (resCtl.high >= 4 && k < 0.99) { k += 0.15; resCtl.high = 0 }
      k = Math.min(1, Math.max(0.7, Math.round(k * 100) / 100))
      if (k !== resCtl.k) {
        resCtl.k = k
        ctx.setResolutionScale(k)
        onResize() // targets + particle point sizes follow the new pixel ratio
      }
    }
  }
  if (now - lastHud > 33) {
    lastHud = now
    syncHud(false)
    if (PERF) mark('hud', t0)
  }
  // coarse wall clock for the HUD's timed elements (banner expiry, lower third), 4 Hz
  if (now - lastNowMs > 250) {
    lastNowMs = now
    store.nowMs = now
  }
  if (now - lastGapToggle > 12000) {
    lastGapToggle = now
    store.gapMode = store.gapMode === 'gap' ? 'interval' : 'gap'
  }
}

function syncHud(full: boolean) {
  if (!race) return
  store.status = race.status
  store.lights = race.lights
  store.lap = Math.min(race.totalLaps, Math.max(1, race.leaderLapsCompleted + 1))
  store.elapsed = race.time
  const order = race.order
  const orderChanged = order.some((c, i) => store.order[i] !== c.idx)
  if (orderChanged || full) store.order = order.map((c) => c.idx)
  const leader = order[0]!
  const nowMs = performance.now()
  for (const car of race.cars) {
    const d = store.drivers[car.idx]!
    const m = models[car.idx]!
    d.position = car.position
    d.positionDelta = d.gridPosition - car.position
    // broadcast chip flash: commit a position change once it has settled (see POS_SETTLE_MS)
    const pp = (posPending[car.idx] ??= { committed: car.position, pos: car.position, since: nowMs })
    if (full || race.status !== 'racing' || race.time <= 12) {
      pp.committed = pp.pos = car.position
    } else if (car.position !== pp.committed) {
      if (pp.pos !== car.position) {
        pp.pos = car.position
        pp.since = nowMs
      } else if (nowMs - pp.since >= POS_SETTLE_MS) {
        d.posFlash = { dir: car.position < pp.committed ? 1 : -1, key: ++flashKey }
        pp.committed = car.position
      }
    } else {
      pp.pos = car.position
    }
    d.lapsCompleted = Math.max(0, car.lapsCompleted)
    const inPit = car.pitState !== 'none'
    d.inPit = inPit
    d.pitState = car.pitState
    d.pitStops = car.pitStops
    // broadcast gaps step per 200 m mini-sector (and whenever the pit / lapped / car-ahead state changes)
    const mini = inPit ? -2 : car.finished ? -3 : Math.floor(car.s / 200)
    const aheadIdx = car.position > 1 ? order[car.position - 2]!.idx : -1
    const stepTv = full || mini !== d.miniSector || aheadIdx !== d.aheadIdx
    if (car.position === 1) {
      d.gapText = ''
      d.intervalText = ''
      d.gapSec = 0
      d.intervalSec = 0
      if (stepTv) {
        d.tvGap = inPit ? 'PIT' : ''
        d.tvInterval = d.tvGap
      }
    } else {
      const down = race.lapsDown(car)
      const g = race.gap(car, leader)
      d.gapSec = g
      d.gapText = inPit ? 'IN PIT' : down > 0 ? `+${down} LAP${down > 1 ? 'S' : ''}` : `+${g.toFixed(3)}`
      const ahead = order[car.position - 2]!
      const iv = race.gap(car, ahead)
      d.intervalSec = iv
      const downAhead = Math.floor((ahead.totalDist - car.totalDist) / track.length)
      d.intervalText = inPit ? 'IN PIT' : downAhead > 0 ? `+${downAhead} LAP${downAhead > 1 ? 'S' : ''}` : `+${iv.toFixed(3)}`
      if (stepTv) {
        d.tvGap = inPit ? 'PIT' : down > 0 ? `+${down} LAP${down > 1 ? 'S' : ''}` : formatGapTv(g)
        d.tvInterval = inPit ? 'PIT' : downAhead > 0 ? `+${downAhead} LAP${downAhead > 1 ? 'S' : ''}` : formatGapTv(iv)
      }
    }
    if (stepTv) {
      d.miniSector = mini
      d.aheadIdx = aheadIdx
    }
    d.lastLap = car.lastLap
    d.bestLap = car.bestLap
    d.currentLap = race.status === 'racing' || race.status === 'finished' ? race.time - car.lapStartTime : 0
    d.speedKmh = Math.round(car.v * 3.6)
    const gr = gearFor(car.v, d.gear, car.throttle)
    d.gear = gr.gear
    d.rpm = Math.round(gr.rpm)
    // tyre stint history (a new entry whenever the set changes)
    const st = d.stints[d.stints.length - 1]
    if (!st || st.compound !== car.compound || car.tyreAge < st.laps) d.stints.push({ compound: car.compound, laps: car.tyreAge })
    else st.laps = car.tyreAge
    // speed trap on the back straight (s ≈ 4700, just before the bridge)
    const trapS = 4700
    if (car.s > trapS && car.s < trapS + 60 && trapArmed[car.idx] && !inPit) {
      trapArmed[car.idx] = 0
      const kmh = Math.round(car.v * 3.6)
      if (kmh > d.trapKmh) d.trapKmh = kmh
      if (!store.speedTrap || kmh > store.speedTrap.kmh) {
        store.speedTrap = { driver: car.idx, kmh }
        if (race.leaderLapsCompleted >= 1) {
          pushEvent({ kind: 'info', title: 'SPEED TRAP', text: `${DRIVERS[car.idx]!.code}  ${kmh} KM/H`, color: TEAMS[DRIVERS[car.idx]!.team].tv, ttl: 4000 })
          pushFeed({ type: 'speedTrap', car: car.idx, kmh, t: race.time })
        }
      }
    } else if (car.s < 1000) {
      trapArmed[car.idx] = 1
    }
    d.throttle = car.throttle
    d.brake = car.brake
    // steering and disc temperatures only for the car the telemetry panel shows (3 writes/sync)
    if (car.idx === store.selected) {
      const mo = motion[car.idx]
      d.steer = mo?.steer ?? 0
      d.brakeTempF = mo ? Math.round(Math.max(mo.brakeT[0]!, mo.brakeT[2]!)) : 0
      d.brakeTempR = mo ? Math.round(Math.max(mo.brakeT[1]!, mo.brakeT[3]!)) : 0
    }
    d.drs = car.drsOpen
    d.drsEligible = car.drsEligible
    d.compound = car.compound
    d.tyreAge = car.tyreAge
    for (let i = 0; i < 3; i++) {
      const v = car.sectors[i] ?? car.lastSectors[i] ?? null
      d.sectors[i] = v
      d.sectorFlags[i] = v == null ? 0 : Math.abs(v - race.bestSectors[i]!) < 1e-6 ? 2 : Math.abs(v - car.bestSectors[i]!) < 1e-6 ? 1 : 0
    }
    d.location = race.sectionName(car.s)
    d.finished = car.finished
    const mp = toMap(m.root.position.x, m.root.position.z)
    d.mapX = mp.mx
    d.mapY = mp.my
    d.hasFastestLap = race.fastestLap?.car === car.idx
    const el = labelEls[car.idx]
    if (el) {
      const posEl = el.firstElementChild as HTMLElement | null
      if (posEl && posEl.textContent !== String(car.position)) posEl.textContent = String(car.position)
      el.classList.toggle('selected', car.idx === store.selected)
      el.classList.toggle('pit', inPit)
    }
  }
  store.fastestLap = race.fastestLap ? { driver: race.fastestLap.car, time: race.fastestLap.time } : null
  if (race.status === 'finished' && leader.finished) store.winner = leader.idx
  // the closest fight in the top ten (within a second, both cars on track)
  let battle: typeof store.battle = null
  if (race.status === 'racing' && race.leaderLapsCompleted >= 1) {
    for (let p = 1; p < Math.min(10, order.length); p++) {
      const a = order[p - 1]!, b = order[p]!
      if (a.pitState !== 'none' || b.pitState !== 'none' || a.finished) continue
      const gap = store.drivers[b.idx]!.intervalSec
      if (gap < 1.0 && (!battle || gap < battle.gapSec)) battle = { position: p + 1, ahead: a.idx, behind: b.idx, gapSec: gap, drs: b.drsOpen || b.drsEligible }
    }
  }
  if (!!battle !== !!store.battle || (battle && store.battle && (battle.behind !== store.battle.behind || Math.abs(battle.gapSec - store.battle.gapSec) > 0.004))) store.battle = battle

  for (const e of race.events) {
    const code = (i: number) => DRIVERS[i]?.code ?? ''
    const full = (i: number) => `${DRIVERS[i]?.firstName ?? ''} ${DRIVERS[i]?.lastName ?? ''}`.toUpperCase()
    const color = (i: number) => TEAMS[DRIVERS[i]!.team].tv
    // every race event also reaches the broadcast graphics director (it decides what goes on air)
    pushFeed(e)
    switch (e.type) {
      case 'lightsOut':
        pushEvent({ kind: 'info', title: 'LIGHTS OUT', text: "AND AWAY WE GO — JAPANESE GRAND PRIX", color: '#e10600', ttl: 5000 })
        break
      case 'fastestLap':
        pushEvent({ kind: 'fastest', title: 'FASTEST LAP', text: `${full(e.car)}  ${formatLapTime(e.time)}`, color: color(e.car), ttl: 6000 })
        director.lastEventCar = e.car
        break
      case 'overtake': {
        // broadcast-style: only headline moves in the top 10, and no more than one every few seconds
        const nowMs = performance.now()
        if (e.position <= 10 && race.leaderLapsCompleted >= 1 && nowMs - lastOvertakeBanner > 4000) {
          lastOvertakeBanner = nowMs
          pushEvent({ kind: 'overtake', title: 'OVERTAKE', text: `${code(e.car)} passes ${code(e.passed)} for P${e.position}`, color: color(e.car), ttl: 4500 })
          audio?.cue('overtake', e.position <= 3 ? 1 : 0.6)
          director.lastEventCar = e.car
        }
        break
      }
      case 'pit':
        pushEvent({ kind: 'pit', title: 'PIT STOP', text: `${full(e.car)} → ${e.compound === 'S' ? 'SOFT' : e.compound === 'M' ? 'MEDIUM' : 'HARD'}`, color: color(e.car), ttl: 4500 })
        director.lastEventCar = e.car
        break
      case 'drsEnabled':
        pushEvent({ kind: 'drs', title: 'DRS ENABLED', text: 'Overtaking aid available on the main straight', color: '#00c853', ttl: 5000 })
        break
      case 'pitIn':
        // the world feed follows a front-runner into the pits when nothing else is happening
        if (e.position <= 12 && !store.battle && director.follow < 0 && !director.hint) director.hint = { car: e.car, shot: 'tv', hold: 25000, follow: true }
        break
      case 'pitOut':
        store.drivers[e.car]!.pitOutUntil = performance.now() + 3000
        break
      case 'newLeader':
        director.lastEventCar = e.car
        if (director.follow < 0) director.hint = { car: e.car, shot: 'tv', hold: 8000, follow: false }
        break
      case 'chequered':
        if (race.cars[e.car]!.position === 1) {
          pushEvent({ kind: 'flag', title: 'CHEQUERED FLAG', text: `${full(e.car)} WINS THE JAPANESE GRAND PRIX`, color: color(e.car), ttl: 12000 })
          audio?.cue('chequered')
        }
        break
    }
  }
  race.events.length = 0
}

function onPointerDown(e: PointerEvent) {
  pointerDown = { x: e.clientX, y: e.clientY }
}

function onPointerUp(e: PointerEvent) {
  if (!pointerDown || !rig || !container.value) return
  const moved = Math.hypot(e.clientX - pointerDown.x, e.clientY - pointerDown.y)
  pointerDown = null
  if (moved > 6) return
  const rect = container.value.getBoundingClientRect()
  pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
  raycaster.setFromCamera(pointer, rig.camera)
  raycaster.params.Line = { threshold: 1 }
  const hits = raycaster.intersectObjects(models.map((m) => m.root), true)
  for (const h of hits) {
    let o: THREE.Object3D | null = h.object
    while (o && o.userData.carIndex === undefined) o = o.parent
    if (o && o.userData.carIndex >= 0) {
      select(o.userData.carIndex)
      return
    }
  }
}

function onKey(e: KeyboardEvent) {
  wake()
  if ((e.target as HTMLElement)?.tagName === 'INPUT') return
  switch (e.key) {
    case '1': setCamera('overview'); break
    case '2': setCamera('heli'); break
    case '3': setCamera('chase'); break
    case '4': setCamera('onboard'); break
    case '5': setCamera('tv'); break
    case '6': setCamera('director'); break
    case 'ArrowUp': selectByPosition(-1); e.preventDefault(); break
    case 'ArrowDown': selectByPosition(1); e.preventDefault(); break
    case ' ': store.paused = !store.paused; e.preventDefault(); break
    case 'l': case 'L': store.labels = !store.labels; break
    case 'm': case 'M': store.showMap = !store.showMap; break
    case 'Escape': store.selected = -1; setCamera('overview'); break
  }
}

watch(() => store.cameraMode, (mode) => {
  if (mode === 'director') director.until = 0
  else rig?.setMode(mode)
})
watch(() => store.timeOfDay, (h) => ctx?.setTimeOfDay(h))

/**
 * Broadcast director: cuts between trackside, onboard and chase shots every few seconds,
 * following whatever is happening — the closest battle, the car that just set a fastest
 * lap, pitted or overtook — and otherwise the leaders.
 */
const director: {
  until: number
  lastCut: number
  lastEventCar: number
  /** a story the feed should cut to next (pit entry of a front-runner, a new leader) */
  hint: { car: number; shot: CameraMode; hold: number; follow: boolean } | null
  /** car being followed through its pit stop (-1 = none) and the follow's deadline */
  follow: number
  followUntil: number
} = { until: 0, lastCut: 0, lastEventCar: -1, hint: null, follow: -1, followUntil: 0 }
function directorCut(nowMs: number, driver: number, sub: CameraMode, hold: number) {
  director.until = nowMs + hold
  director.lastCut = nowMs
  select(driver, 'director')
  rig?.setMode(sub)
}
function runDirector(nowMs: number) {
  if (!rig || !race) return
  // a hinted story wins as soon as the current shot has had a moment on air
  if (director.hint && nowMs - director.lastCut >= 2500) {
    const h = director.hint
    director.hint = null
    if (h.follow) {
      director.follow = h.car
      director.followUntil = nowMs + h.hold
    }
    directorCut(nowMs, h.car, h.shot, h.hold)
    return
  }
  // following a pit stop: trackside on the way in, a static close-up while stationary, trackside out
  if (director.follow >= 0) {
    const car = race.cars[director.follow]!
    if (car.pitState === 'none' || nowMs > director.followUntil) {
      director.follow = -1
      director.until = Math.min(director.until, nowMs + 2500)
    } else {
      const want: CameraMode = car.pitState === 'box' ? 'chase' : 'tv'
      if (rig.mode !== want) rig.setMode(want)
      return
    }
  }
  if (nowMs < director.until) return
  const hold = 6000 + Math.random() * 6000
  let driver = -1
  const r = Math.random()
  if (store.battle && r < 0.6) driver = store.battle.behind
  else if (director.lastEventCar >= 0 && r < 0.8) driver = director.lastEventCar
  else driver = store.order[Math.floor(Math.random() * Math.min(8, store.order.length))] ?? 0
  director.lastEventCar = -1
  const pick = Math.random()
  const sub: CameraMode = pick < 0.5 ? 'tv' : pick < 0.75 ? 'onboard' : pick < 0.9 ? 'chase' : 'heli'
  directorCut(nowMs, driver, sub, hold)
}
watch(() => store.audio, (on) => {
  audio?.setMuted(!on)
  if (!on) audio?.cancelCues()
  if (on) startAudio()
})
watch(() => store.paused, (p) => {
  if (p) audio?.cancelCues()
})

/** Browsers only allow audio after a user gesture — create the context on the first click/key. */
function startAudio() {
  if (audio || !store.audio || !rig || !ctx || typeof AudioContext === 'undefined') return
  try {
    // crowd beds at the main grandstand and the Spoon-side stand
    const crowdAt = [200, 3400].map((s) => track.pointAt(s, track.halfWidth + 30, _tmp, 8).clone())
    audio = new RaceAudio(rig.camera, crowdAt, ctx.scene, { tier: ctx.tier })
    audio.resume()
  } catch {
    audio = null
    audioFailed = true
  }
}
function onFirstGesture() {
  wake()
  store.interacted = true
  startAudio()
  audio?.resume()
}
/** Broadcast mode hides the control bar; a moving pointer brings it back (at most 2 writes/s). */
function onPointerMove() {
  if (performance.now() > store.uiUntil - 2500) wake()
}
watch(() => store.restartToken, () => {
  if (!race) return
  audio?.cancelCues()
  store.selected = -1
  store.cameraMode = 'overview'
  rig?.setMode('overview')
  rig?.resetOverview()
  marks?.clear()
  initRace()
})

/** Hidden tab: stop the frame loop (and the engine audio); on return the first delta is ~0. */
let hidden = false
function onVisibility() {
  if (document.hidden) {
    if (hidden) return
    hidden = true
    cancelAnimationFrame(raf)
    // a beep in flight would freeze with the clock and finish on resume: drop it first
    audio?.cancelCues()
    audio?.suspend()
  } else if (hidden) {
    hidden = false
    // a lost context restarts the loop itself when it comes back
    if (!ctx || contextLost) return
    // two updates so getDelta() on the next frame does not report the whole hidden period
    timer.update()
    timer.update()
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(loop)
    if (store.audio) audio?.resume()
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKey)
  window.addEventListener('pointerdown', onFirstGesture)
  window.addEventListener('keydown', onFirstGesture)
  window.addEventListener('pointermove', onPointerMove, { passive: true })
  document.addEventListener('visibilitychange', onVisibility)
  // let the loading screen paint before the (synchronous) scene build
  setTimeout(setup, 30)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  canvas.value?.removeEventListener('webglcontextlost', onContextLost)
  canvas.value?.removeEventListener('webglcontextrestored', onContextRestored)
  document.removeEventListener('visibilitychange', onVisibility)
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('pointerdown', onFirstGesture)
  window.removeEventListener('keydown', onFirstGesture)
  window.removeEventListener('pointermove', onPointerMove)
  resizeObserver?.disconnect()
  rig?.dispose()
  sparks?.dispose()
  smoke?.dispose()
  marks?.dispose()
  for (const el of labelEls) el.remove()
  audio?.cancelCues()
  audio?.dispose()
  ctx?.dispose()
})
</script>

<template>
  <div ref="container" class="viewport" @pointerdown="onPointerDown" @pointerup="onPointerUp">
    <canvas ref="canvas" class="viewport-canvas" />
    <div ref="labelLayer" class="label-layer" />
  </div>
</template>

<style>
.viewport {
  position: absolute;
  inset: 0;
  overflow: hidden;
  background: #0a0c10;
  touch-action: none;
}
.viewport-canvas {
  display: block;
  width: 100%;
  height: 100%;
}
.label-layer {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
  overflow: hidden;
}
.car-label {
  pointer-events: auto;
  cursor: pointer;
  display: inline-flex;
  align-items: stretch;
  height: 16px;
  font: 700 10px/16px 'Titillium Web', 'Segoe UI', sans-serif;
  letter-spacing: 0.04em;
  color: #fff;
  background: rgba(8, 8, 12, 0.82);
  border-left: 3px solid var(--team, #fff);
  border-radius: 2px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
  transform: translateY(-4px);
  user-select: none;
  white-space: nowrap;
}
.car-label .pos {
  min-width: 14px;
  padding: 0 3px;
  text-align: center;
  background: rgba(255, 255, 255, 0.14);
}
.car-label .code {
  padding: 0 5px 0 4px;
}
.car-label.selected {
  background: var(--team, #fff);
  color: #0b0b0f;
  border-left-color: #fff;
  box-shadow: 0 0 0 1.5px #fff, 0 2px 8px rgba(0, 0, 0, 0.6);
}
.car-label.pit {
  opacity: 0.6;
}
</style>
