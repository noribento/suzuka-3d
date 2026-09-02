<script setup lang="ts">
import * as THREE from 'three'
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { getTrack, type Pose } from '~/sim/track'
import { RaceSim, formatLapTime, gearFor } from '~/sim/race'
import { DRIVERS, TEAMS } from '~/data/drivers'
import { CIRCUIT } from '~/data/suzuka'
import { toMap } from '~/sim/projection'
import { createScene, type SceneContext } from '~/three/scene'
import { buildTrackMeshes, type TrackMeshes } from '~/three/track-mesh'
import { buildEnvironment, type Environment } from '~/three/environment'
import { buildCarModel, CAR_DIMENSIONS, type CarModel } from '~/three/car-model'
import { buildBarriers } from '~/three/barriers'
import { ParticleSystem, SkidMarks } from '~/three/particles'
import { RaceAudio, type CarAudioState } from '~/three/audio'
import { CameraRig, type CameraTarget } from '~/three/cameras'
import { useRaceStore, type CameraMode, type HudDriver } from '~/composables/useRaceStore'

const { store, pushEvent, select, setCamera, selectByPosition } = useRaceStore()
const container = ref<HTMLDivElement>()
const canvas = ref<HTMLCanvasElement>()
const labelLayer = ref<HTMLDivElement>()

let ctx: SceneContext | null = null
let rig: CameraRig | null = null
let labelRenderer: CSS2DRenderer | null = null
let env: Environment | null = null
let trackMeshes: TrackMeshes | null = null
let race: RaceSim | null = null
let models: CarModel[] = []
let labelObjects: CSS2DObject[] = []
let labelEls: HTMLDivElement[] = []
let compoundCache: string[] = []
let raf = 0
let resizeObserver: ResizeObserver | null = null
let gridTimer = 0
let lastHud = 0
let lastGapToggle = 0
let fpsAcc = 0
let fpsCount = 0
let pointerDown: { x: number; y: number } | null = null
let framesRendered = 0
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
  }))
}

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
  motion.length = 0
  trapArmed.fill(1)
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

function buildLabel(idx: number): CSS2DObject {
  const d = DRIVERS[idx]!
  const el = document.createElement('div')
  el.className = 'car-label'
  el.style.setProperty('--team', TEAMS[d.team].tv)
  el.innerHTML = `<span class="pos"></span><span class="code">${d.code}</span>`
  el.addEventListener('pointerdown', (e) => {
    e.stopPropagation()
    select(idx)
  })
  labelEls[idx] = el
  const obj = new CSS2DObject(el)
  obj.position.set(0, 2.0, 0)
  obj.center.set(0.5, 1.1)
  return obj
}

function setup() {
  if (!canvas.value || !container.value || !labelLayer.value) return
  rig = new CameraRig(track, container.value)
  ctx = createScene(canvas.value, rig.camera, track.center)
  labelRenderer = new CSS2DRenderer({ element: labelLayer.value })

  env = buildEnvironment(track, ctx.tier === 'high' ? 30000 : 6000)
  ctx.scene.add(env.group)
  trackMeshes = buildTrackMeshes(track, env.terrain, env.ground)
  ctx.scene.add(trackMeshes.group)
  ctx.scene.add(buildBarriers(track, ctx.tier, env.ground))
  // effects: sparks off the plank, tyre smoke, skid marks
  sparks = new ParticleSystem({ capacity: ctx.tier === 'high' ? 2048 : 512, kind: 'spark', additive: true, gravity: 9.81, drag: 2.4 })
  smoke = new ParticleSystem({ capacity: ctx.tier === 'high' ? 768 : 256, kind: 'smoke', additive: false, gravity: -0.5, drag: 1.6 })
  marks = new SkidMarks(4000)
  ctx.scene.add(sparks.points, smoke.points, marks.mesh)
  ctx.setTimeOfDay(store.timeOfDay)

  models = DRIVERS.map((d, idx) => {
    const m = buildCarModel(d, 'M')
    m.root.userData.carIndex = idx
    m.root.add(buildLabel(idx))
    ctx!.scene.add(m.root)
    return m
  })
  labelObjects = models.map((m) => m.root.children.find((c) => c instanceof CSS2DObject) as CSS2DObject)
  ctx.setupMaterials(ctx.scene)

  initRace()
  onResize()
  resizeObserver = new ResizeObserver(onResize)
  resizeObserver.observe(container.value)
  store.ready = true
  if (import.meta.dev) (window as unknown as { __suzuka: unknown }).__suzuka = { THREE, ctx, rig, track, env, trackMeshes, models, race }
  raf = requestAnimationFrame(loop)
}

function onResize() {
  if (!container.value || !ctx || !rig || !labelRenderer) return
  const w = container.value.clientWidth
  const h = container.value.clientHeight
  ctx.setSize(w, h)
  labelRenderer.setSize(w, h)
  const px = h * ctx.renderer.getPixelRatio()
  sparks?.setViewport(px)
  smoke?.setViewport(px)
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
}
const motion: CarMotion[] = []
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
      const heat = 0.6 + rnd() * 0.7
      sparks.emit(
        _tmp.x, _tmp.y, _tmp.z,
        _vel.x * k + (rnd() - 0.5) * 5, 0.4 + rnd() * 2.2, _vel.z * k + (rnd() - 0.5) * 5,
        0.09 + rnd() * 0.07, 0.3 + rnd() * 0.45,
        9 * heat, 3.4 * heat, 0.7 * heat, groundY + 0.01,
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
  const mo = (motion[i] ??= { prevV: car.v, prevLat: car.lateral, aLon: 0, aLat: 0, slip: 0, sparkAcc: 0, smokeAcc: 0, lockWheel: -1, lockTimer: 0, wasBraking: false, bumpPhase: 0 })
  track.poseAt(car.s, car.lateral, pose)
  if (simDt > 0) {
    // accelerations and the yaw the lateral motion implies (a lane change is a real
    // steering input, not a sideways slide)
    const k = Math.min(1, simDt * 10)
    mo.aLon += ((car.v - mo.prevV) / simDt - mo.aLon) * k
    const vLat = (car.lateral - mo.prevLat) / simDt
    mo.slip += (Math.atan2(vLat, Math.max(car.v, 6)) - mo.slip) * Math.min(1, simDt * 14)
    mo.aLat = car.v * car.v * pose.kappa + vLat * 0.5
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
  const spin = (car.v * simDt) / CAR_DIMENSIONS.wheelRadius
  for (const w of m.wheels) w.rotation.x -= spin
  const steer = THREE.MathUtils.clamp(Math.atan(CAR_DIMENSIONS.wheelbase * pose.kappa) * 1.6 + mo.slip * 1.2, -0.45, 0.45)
  for (const g of m.frontSteer) g.rotation.y = steer
  m.setSteer(steer)
  m.setDrs(car.drsOpen)
  // only nearby cars cast shadows (three cascades re-render every caster)
  m.setShadows(rig!.camera.position.distanceToSquared(m.root.position) < 320 * 320)
  m.setDynamics({ aLon: mo.aLon, aLat: mo.aLat, v: car.v, brake: car.brake, dt: simDt })
  m.setWear(car.tyreAge)
  const st = race!.status
  m.setRainLight(car.pitState !== 'none' || st === 'grid' || st === 'lights' ? 'flash' : st === 'racing' ? 'on' : 'off', race!.time + i * 0.13)
  if (compoundCache[i] !== car.compound) {
    compoundCache[i] = car.compound
    m.setCompound(car.compound)
  }
  updateEffects(i, mo, simDt)
}

function loop() {
  raf = requestAnimationFrame(loop)
  if (!ctx || !rig || !race || !env || !trackMeshes || !labelRenderer) return
  timer.update()
  const rawDt = timer.getDelta()
  const dt = Math.min(rawDt, 0.1)
  let simDt = 0
  if (!store.paused) {
    simDt = dt * store.simSpeed
    if (race.status === 'grid') {
      gridTimer += dt
      if (gridTimer > 2.2) race.startLights()
    }
    race.step(simDt)
  }
  for (let i = 0; i < models.length; i++) placeCar(i, simDt)
  // a light westerly drifts the smoke across the track
  const wind = store.weather.wind
  sparks?.update(simDt, wind * 0.3, -wind * 0.2)
  smoke?.update(simDt, wind * 0.9, -wind * 0.5)

  // start lights on the gantry (HDR emissive so they bloom on the high tier)
  trackMeshes.startLampMaterials.forEach((mat, i) => {
    const on = race!.status === 'lights' && i < race!.lights
    mat.emissive.setHex(on ? 0xff1a1a : 0x000000)
    mat.emissiveIntensity = on ? 12 : 0
    mat.color.setHex(on ? 0xff2020 : 0x3a0000)
  })

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
  if (rig.mode === 'overview' || !target) ctx.updateShadows('overview', rig.camera.position.distanceTo(rig.controls.target))
  else ctx.updateShadows('follow', rig.camera.position.distanceTo(target.position))

  // labels: when zoomed far out in the overview only tag the leaders + the selected car
  const showLabels = store.labels && rig.mode !== 'onboard'
  const farOut = rig.mode === 'overview' && rig.camera.position.distanceTo(rig.controls.target) > 1000
  labelObjects.forEach((l, i) => {
    const car = race!.cars[i]!
    l.visible = showLabels && (!farOut || car.position <= 3 || i === sel)
  })
  env.update(simDt)

  // audio (created on the first user gesture; voices follow the nearest cars)
  if (audio) {
    for (let i = 0; i < models.length; i++) {
      const st = (audioStates[i] ??= { position: new THREE.Vector3(), velocity: new THREE.Vector3(), rpm: 0, throttle: 0, gear: 0, v: 0, running: false })
      const car = race.cars[i]!
      const d = store.drivers[i]!
      st.position.copy(models[i]!.root.position)
      st.velocity.set(0, 0, car.v).applyQuaternion(models[i]!.root.quaternion)
      st.rpm = gearFor(car.v, d.gear, car.throttle).rpm
      st.throttle = car.throttle
      st.gear = d.gear
      st.v = car.v
      st.running = race.status !== 'grid' && !store.paused
    }
    audio.update(dt, audioStates, rig.camera, rig.mode, ctx.scene)
  }

  ctx.render(dt)
  labelRenderer.render(ctx.scene, rig.camera)
  if (++framesRendered === 1) ctx.refreshMaterials(ctx.scene)

  const now = performance.now()
  fpsAcc += rawDt
  fpsCount++
  if (fpsAcc > 1) {
    store.fps = Math.round(fpsCount / fpsAcc)
    fpsAcc = 0
    fpsCount = 0
  }
  if (now - lastHud > 33) {
    lastHud = now
    syncHud(false)
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
  for (const car of race.cars) {
    const d = store.drivers[car.idx]!
    const m = models[car.idx]!
    d.position = car.position
    d.lapsCompleted = Math.max(0, car.lapsCompleted)
    const inPit = car.pitState !== 'none'
    d.inPit = inPit
    d.pitState = car.pitState
    d.pitStops = car.pitStops
    if (car.position === 1) {
      d.gapText = ''
      d.intervalText = ''
      d.gapSec = 0
      d.intervalSec = 0
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
        if (race.leaderLapsCompleted >= 1) pushEvent({ kind: 'info', title: 'SPEED TRAP', text: `${DRIVERS[car.idx]!.code}  ${kmh} KM/H`, color: TEAMS[DRIVERS[car.idx]!.team].tv, ttl: 4000 })
      }
    } else if (car.s < 1000) {
      trapArmed[car.idx] = 1
    }
    d.throttle = car.throttle
    d.brake = car.brake
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
      case 'chequered':
        if (race.cars[e.car]!.position === 1) {
          pushEvent({ kind: 'flag', title: 'CHEQUERED FLAG', text: `${full(e.car)} WINS THE JAPANESE GRAND PRIX`, color: color(e.car), ttl: 12000 })
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
const director = { until: 0, lastEventCar: -1 }
function runDirector(nowMs: number) {
  if (!rig || !race || nowMs < director.until) return
  const hold = 6000 + Math.random() * 6000
  director.until = nowMs + hold
  let driver = -1
  const r = Math.random()
  if (store.battle && r < 0.6) driver = store.battle.behind
  else if (director.lastEventCar >= 0 && r < 0.8) driver = director.lastEventCar
  else driver = store.order[Math.floor(Math.random() * Math.min(8, store.order.length))] ?? 0
  director.lastEventCar = -1
  const pick = Math.random()
  const sub: CameraMode = pick < 0.5 ? 'tv' : pick < 0.75 ? 'onboard' : pick < 0.9 ? 'chase' : 'heli'
  store.selected = driver
  rig.setMode(sub)
}
watch(() => store.audio, (on) => {
  audio?.setMuted(!on)
  if (on) startAudio()
})

/** Browsers only allow audio after a user gesture — create the context on the first click/key. */
function startAudio() {
  if (audio || !store.audio || !rig || !ctx || typeof AudioContext === 'undefined') return
  try {
    track.pointAt(200, track.halfWidth + 30, _tmp, 8)
    audio = new RaceAudio(rig.camera, _tmp.clone(), ctx.scene)
    audio.resume()
  } catch {
    audio = null
  }
}
function onFirstGesture() {
  startAudio()
  audio?.resume()
}
watch(() => store.restartToken, () => {
  if (!race) return
  store.selected = -1
  store.cameraMode = 'overview'
  rig?.setMode('overview')
  rig?.resetOverview()
  marks?.clear()
  initRace()
})

onMounted(() => {
  window.addEventListener('keydown', onKey)
  window.addEventListener('pointerdown', onFirstGesture)
  window.addEventListener('keydown', onFirstGesture)
  // let the loading screen paint before the (synchronous) scene build
  setTimeout(setup, 30)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('pointerdown', onFirstGesture)
  window.removeEventListener('keydown', onFirstGesture)
  resizeObserver?.disconnect()
  rig?.dispose()
  sparks?.dispose()
  smoke?.dispose()
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
