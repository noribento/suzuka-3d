import { APEX_SPEED_TARGETS, CIRCUIT, SECTIONS } from '~/data/suzuka'
import { DRIVERS, TEAMS, TEAM_ORDER, type Compound, type Driver } from '~/data/drivers'
import { GARAGE_ORDER, garageIndexOf, garageS } from '~/data/suzuka-facilities-spec'
import { Rng } from './random'
import { forwardDelta, signedDelta, type Track } from './track'

// The garage allocation must name every team exactly once, or a car would stop in another
// team's box (or fall back to its team index). A warning, not an error: the e2e suite fails on
// console.error and the fallback keeps the race running.
if (GARAGE_ORDER.length !== TEAM_ORDER.length || TEAM_ORDER.some((t) => garageIndexOf(t) < 0)) {
  console.warn('[race] GARAGE_ORDER does not match TEAM_ORDER — pit boxes fall back to the team index')
}

export type RaceStatus = 'grid' | 'lights' | 'racing' | 'finished'
export type PitState = 'none' | 'entering' | 'lane' | 'box' | 'exiting'

export interface CarSim {
  idx: number
  driver: Driver
  teamIndex: number
  s: number
  totalDist: number
  v: number
  lateral: number
  lateralTarget: number
  passSide: 0 | 1 | -1
  passTarget: number
  gripBase: number
  powerBase: number
  profile: Float32Array
  lapNoise: number
  compound: Compound
  tyreAge: number
  nextCompound: Compound
  pitLap: number
  pitState: PitState
  pitTimer: number
  pitStops: number
  lapsCompleted: number
  crossings: number
  lapStartTime: number
  lastLap: number
  bestLap: number
  sectorStart: number
  sector: number
  sectors: (number | null)[]
  lastSectors: (number | null)[]
  bestSectors: number[]
  cpTimes: Float64Array
  position: number
  finished: boolean
  finishTime: number
  drsOpen: boolean
  drsEligible: boolean
  launchDelay: number
  launchFactor: number
  throttle: number
  brake: number
  inDirtyAir: boolean
  gapAheadSec: number
  /** race time and position when the car turned into the pit entry (broadcast pit graphics) */
  pitEntryTime: number
  pitEntryPos: number
  /** stationary time drawn for the current / last stop (s) */
  pitStationary: number
}

export type RaceEvent =
  | { type: 'fastestLap'; car: number; time: number; t: number }
  | { type: 'overtake'; car: number; passed: number; position: number; t: number }
  /** turned into the pit entry */
  | { type: 'pitIn'; car: number; position: number; t: number }
  /** left the box: new compound fitted, `from` was the old one, `stationary` the box time */
  | { type: 'pit'; car: number; compound: Compound; from: Compound; stationary: number; entryPosition: number; t: number }
  /** rejoined the track at the end of the pit lane; `total` = pit entry to exit (s) */
  | { type: 'pitOut'; car: number; position: number; entryPosition: number; total: number; t: number }
  /** the car in P1 changed (after the launch settles; pit-cycle leader changes included) */
  | { type: 'newLeader'; car: number; previous: number; t: number }
  | { type: 'drsEnabled'; t: number }
  | { type: 'lightsOut'; t: number }
  | { type: 'chequered'; car: number; t: number }

// --- vehicle model -----------------------------------------------------------
const VMAX = 92 // m/s (≈ 331 km/h)
const A0 = 18 // mechanical lateral grip (m/s²)
const K_AERO = 0.0063 // aero grip gain per (m/s)²
const A_TRACTION = 13
const P_MASS = 950 // W/kg
const C_DRAG = 0.00118
const CP_LEN = 20
const CAR_HALF_WIDTH = 1.0
const LANE_STEP = 3.4
/** Minimum nose-to-nose spacing (m) for cars in the same lateral band. */
const MIN_GAP = 5.2
/** Fuel load at the start (kg) and its cornering-speed cost per kg. */
const FUEL_START = 100
const FUEL_SENSITIVITY = 0.00042
/** Engine / tyre management in the race relative to the qualifying profile. */
const RACE_MODE = 0.925

const G = 9.81

function accelLimit(v: number): number {
  return Math.min(A_TRACTION, Math.max(0.4, P_MASS / Math.max(v, 8) - C_DRAG * v * v))
}

/** Braking deceleration on a straight (m/s²): ~2.4 g mechanical rising to ~5.6 g at 300 km/h with the aero load. */
function brakeLimit(v: number): number {
  return 24 + 0.0045 * v * v
}

/** Lateral acceleration available at speed v for a car of the given grip factor. */
function lateralLimit(v: number, grip: number): number {
  return (A0 + K_AERO * v * v) * grip
}

/** Fraction of the grip circle still available for braking/traction while cornering at v with curvature k. */
function longitudinalShare(v: number, k: number, grip: number): number {
  const u = (v * v * Math.abs(k)) / lateralLimit(v, grip)
  return Math.sqrt(Math.max(0.02, 1 - u * u))
}

const calibrated = new WeakMap<Track, Float32Array>()

/**
 * Curvature used by the speed model: the racing-line curvature, scaled inside each corner
 * so that the reference car's cornering limit matches the measured race-condition apex
 * speeds (APEX_SPEED_TARGETS). The GeoJSON centreline is ~35 m-vertex data, so its local
 * radii in fast, flowing corners (the Esses, 130R) come out far tighter than the radius
 * the cars actually describe.
 */
function calibratedCurvature(track: Track): Float32Array {
  const cached = calibrated.get(track)
  if (cached) return cached
  const n = track.n
  const L = track.length
  const out = Float32Array.from(track.kappaLine)
  const scale = new Float32Array(n).fill(1)
  for (const c of track.corners) {
    const tgt = APEX_SPEED_TARGETS.find((t) => Math.abs(signedDelta(t.s, c.apex, L)) < 60)
    if (!tgt) continue
    const len = forwardDelta(c.from, c.to, L)
    let kmax = 0
    for (let d = 0; d <= len; d += track.ds) kmax = Math.max(kmax, Math.abs(track.kappaLineAt(c.from + d)))
    if (kmax < 1e-5) continue
    const v = tgt.kmh / 3.6
    const kNeed = lateralLimit(v, 1) / (v * v)
    const sc = kNeed / kmax
    const fade = 25
    for (let d = -fade; d <= len + fade; d += track.ds) {
      const w = d < 0 ? 1 + d / fade : d > len ? 1 - (d - len) / fade : 1
      const i = Math.round(track.wrap(c.from + d) / track.ds) % n
      scale[i] = scale[i]! * (1 + (sc - 1) * Math.max(0, w))
    }
  }
  for (let i = 0; i < n; i++) out[i] = out[i]! * scale[i]!
  calibrated.set(track, out)
  return out
}

export class RaceSim {
  readonly track: Track
  readonly cars: CarSim[] = []
  order: CarSim[] = []
  status: RaceStatus = 'grid'
  time = 0
  lights = 0
  private lightsTimer = 0
  private lightsHold = 1.5
  totalLaps: number
  leaderLapsCompleted = 0
  fastestLap: { car: number; time: number } | null = null
  bestSectors: number[] = [Infinity, Infinity, Infinity]
  events: RaceEvent[] = []
  drsEnabled = false
  readonly nCp: number
  /** widest usable lateral offset on the lap; use maxLatAt(s) for the local value */
  readonly maxLateral: number
  /** curvature per track sample used by the speed model (see calibratedCurvature) */
  readonly kappaPhys: Float32Array
  private rng: Rng
  private lastOrderIdx: number[] = []
  private finishedCount = 0
  readonly pitTotal: number

  constructor(track: Track, seed = Date.now() % 1_000_000, totalLaps = CIRCUIT.laps) {
    this.track = track
    this.totalLaps = totalLaps
    this.rng = new Rng(seed)
    this.nCp = Math.ceil(track.length / CP_LEN)
    this.maxLateral = track.halfWidth - CAR_HALF_WIDTH - 0.3
    this.kappaPhys = calibratedCurvature(track)
    this.pitTotal = track.pitTotal
    this.buildCars()
    this.placeOnGrid()
  }

  /** Widest lateral offset a car may use at s (road edge minus half a car and a margin). */
  maxLatAt(s: number): number {
    return this.track.halfWidthAt(s) - CAR_HALF_WIDTH - 0.3
  }

  /** Calibrated (speed-model) curvature at s, linearly interpolated like Track.kappaLineAt. Pure accessor. */
  kappaPhysAt(s: number): number {
    const t = this.track
    const u = t.wrap(s) / t.ds
    const i0 = Math.floor(u)
    const i = i0 % t.n
    const j = (i + 1) % t.n
    const f = u - i0
    return this.kappaPhys[i]! * (1 - f) + this.kappaPhys[j]! * f
  }

  // ---------------------------------------------------------------- setup

  /**
   * Quasi-steady-state speed profile: the cornering limit per sample (grip circle radius
   * plus the banking term), then backward braking and forward traction passes in which the
   * longitudinal capacity shrinks with the lateral load in use (friction circle) and the
   * gradient adds or removes g·slope.
   */
  private buildProfile(grip: number, power: number): Float32Array {
    const { n, ds, roll, slope } = this.track
    const k = this.kappaPhys
    const v = new Float32Array(n)
    const vmax = VMAX * power
    const a0 = A0 * grip
    const ka = K_AERO * grip
    for (let i = 0; i < n; i++) {
      const kk = Math.abs(k[i]!)
      // banking into the corner adds g·tan(φ) of lateral capacity (roll is signed away from the corner)
      const bank = -Math.sign(k[i]!) * Math.tan(roll[i]!) * G
      let vc = vmax
      if (kk > ka + 1e-6) vc = Math.min(vmax, Math.sqrt(Math.max(1, a0 + bank) / (kk - ka)))
      v[i] = vc
    }
    for (let pass = 0; pass < 2; pass++) {
      for (let m = 2 * n - 1; m >= 0; m--) {
        const i = m % n
        const j = (i + 1) % n
        const vj = v[j]!
        const b = Math.max(1, brakeLimit(vj) * longitudinalShare(vj, k[j]!, grip) + G * slope[j]!)
        const lim = Math.sqrt(vj * vj + 2 * b * ds)
        if (v[i]! > lim) v[i] = lim
      }
      for (let m = 0; m < 2 * n; m++) {
        const i = m % n
        const j = (i + 1) % n
        const vi = v[i]!
        const share = longitudinalShare(vi, k[i]!, grip)
        const a = Math.max(0.05, Math.min(accelLimit(vi), A_TRACTION * share) - G * slope[i]!)
        const lim = Math.sqrt(vi * vi + 2 * a * ds)
        if (v[j]! > lim) v[j] = lim
      }
    }
    return v
  }

  /** Ideal lap time for a profile (seconds). */
  idealLap(profile: Float32Array): number {
    let t = 0
    for (let i = 0; i < profile.length; i++) t += this.track.ds / Math.max(profile[i]!, 1)
    return t
  }

  private buildCars() {
    const rng = this.rng
    DRIVERS.forEach((driver, idx) => {
      const team = TEAMS[driver.team]
      const pace = team.pace * driver.skill
      const grip = pace
      const power = 0.5 + 0.5 * pace
      const compound: Compound = rng.next() < 0.55 ? 'M' : rng.next() < 0.7 ? 'S' : 'H'
      const pitLap = compound === 'S' ? rng.int(11, 19) : compound === 'M' ? rng.int(17, 30) : rng.int(24, 36)
      const nextCompound: Compound = compound === 'H' ? 'M' : compound === 'S' ? (rng.next() < 0.7 ? 'H' : 'M') : 'H'
      this.cars.push({
        idx,
        driver,
        teamIndex: TEAM_ORDER.indexOf(driver.team),
        s: 0,
        totalDist: 0,
        v: 0,
        lateral: 0,
        lateralTarget: 0,
        passSide: 0,
        passTarget: -1,
        gripBase: grip,
        powerBase: power,
        profile: this.buildProfile(grip, power),
        lapNoise: 1,
        compound,
        tyreAge: 0,
        nextCompound,
        pitLap: Math.min(pitLap, this.totalLaps - 3),
        pitState: 'none',
        pitTimer: 0,
        pitStops: 0,
        lapsCompleted: -1,
        crossings: 0,
        lapStartTime: 0,
        lastLap: 0,
        bestLap: 0,
        sectorStart: 0,
        sector: 0,
        sectors: [null, null, null],
        lastSectors: [null, null, null],
        bestSectors: [Infinity, Infinity, Infinity],
        cpTimes: new Float64Array(this.nCp).fill(NaN),
        position: idx + 1,
        finished: false,
        finishTime: 0,
        drsOpen: false,
        drsEligible: false,
        launchDelay: 0,
        launchFactor: 1,
        throttle: 0,
        brake: 0,
        inDirtyAir: false,
        gapAheadSec: Infinity,
        pitEntryTime: 0,
        pitEntryPos: 0,
        pitStationary: 0,
      })
    })
  }

  private placeOnGrid() {
    const rng = this.rng
    const quali = this.cars
      .map((c) => ({ c, q: c.gripBase + rng.gauss() * 0.004 }))
      .sort((a, b) => b.q - a.q)
    quali.forEach(({ c }, k) => {
      const behind = 14 + 8 * k
      c.totalDist = -behind
      c.s = this.track.wrap(-behind)
      c.lateral = k % 2 === 0 ? 2.6 : -2.6
      c.lateralTarget = c.lateral
      c.position = k + 1
      c.launchDelay = 0.18 + rng.next() * 0.35
      c.launchFactor = 0.78 + rng.next() * 0.22
      c.v = 0
    })
    this.order = quali.map((q) => q.c)
    this.lastOrderIdx = this.order.map((c) => c.idx)
  }

  startLights() {
    if (this.status !== 'grid') return
    this.status = 'lights'
    this.lights = 0
    this.lightsTimer = 0
    // FIA procedure: five lamps a second apart, then a random 0.2–3 s hold before they go out
    // (one rng draw, like the expression it replaced, so the seeded stream position is unchanged)
    this.lightsHold = this.rng.range(0.2, 3.0)
  }

  /** Seconds since the start sequence began (0 while on the grid). */
  get lightsElapsed(): number {
    return this.status === 'lights' ? this.lightsTimer : 0
  }

  // ---------------------------------------------------------------- queries

  profileAt(car: CarSim, s: number): number {
    const u = this.track.wrap(s) / this.track.ds
    const i = Math.floor(u) % this.track.n
    const j = (i + 1) % this.track.n
    const f = u - Math.floor(u)
    return car.profile[i]! * (1 - f) + car.profile[j]! * f
  }

  private tyreFactor(car: CarSim): number {
    const fresh = car.compound === 'S' ? 0.007 : car.compound === 'M' ? 0.0035 : 0
    const wearRate = car.compound === 'S' ? 0.0017 : car.compound === 'M' ? 0.0011 : 0.0007
    return 1 + fresh - wearRate * Math.max(0, car.tyreAge - 1) - 0.004 * (car.pitStops === 0 && car.tyreAge > 30 ? (car.tyreAge - 30) * 0.5 : 0)
  }

  pitLateralAt(s: number): number | null {
    return this.track.pitLateralAt(s)
  }

  /**
   * Pit-stop position: the centre of the team's garage. Garages are allocated from the pit exit
   * (garage 1 = T1 end) in GARAGE_ORDER, which is not TEAM_ORDER, so the car's team index maps
   * through its TeamId; a team missing from GARAGE_ORDER (should not happen — see the module
   * check below) falls back to its team index.
   */
  boxS(car: CarSim): number {
    const team = TEAM_ORDER[car.teamIndex]
    const g = team ? garageIndexOf(team) : -1
    return this.track.wrap(garageS(g >= 0 ? g : car.teamIndex))
  }

  /** Time gap in seconds from `behind` to `ahead`, using checkpoint timestamps. */
  gap(behind: CarSim, ahead: CarSim): number {
    const L = this.track.length
    const s = behind.s
    const k = Math.floor(s / CP_LEN) % this.nCp
    const k1 = (k + 1) % this.nCp
    const t0 = ahead.cpTimes[k]!
    const t1 = ahead.cpTimes[k1]!
    if (!Number.isFinite(t0)) return forwardDelta(s, ahead.s, L) / Math.max(behind.v, 5)
    if (!Number.isFinite(t1) || t1 < t0) {
      const dt = this.time - t0
      const frac = (s - k * CP_LEN) / CP_LEN
      return Math.max(0, dt - frac * (CP_LEN / Math.max(ahead.v, 5)))
    }
    const frac = (s - k * CP_LEN) / CP_LEN
    return Math.max(0, this.time - (t0 + (t1 - t0) * frac))
  }

  lapsDown(car: CarSim): number {
    const leader = this.order[0]
    if (!leader || leader === car) return 0
    return Math.max(0, Math.floor((leader.totalDist - car.totalDist) / this.track.length))
  }

  sectionName(s: number): string {
    for (const sec of SECTIONS) {
      if (sec.from < sec.to ? s >= sec.from && s < sec.to : s >= sec.from || s < sec.to) return sec.name
    }
    return ''
  }

  // ---------------------------------------------------------------- stepping

  step(dt: number) {
    if (this.status === 'grid') return
    if (this.status === 'lights') {
      this.lightsTimer += dt
      // lamp n lights at t = n s: a full beat before the first one
      this.lights = Math.min(5, Math.floor(this.lightsTimer))
      if (this.lightsTimer > 5 + this.lightsHold) {
        this.lights = 0
        this.status = 'racing'
        this.time = 0
        this.events.push({ type: 'lightsOut', t: 0 })
        for (const c of this.cars) {
          c.lapStartTime = 0
          c.sectorStart = 0
        }
      }
      return
    }
    let remaining = dt
    while (remaining > 1e-6) {
      const h = Math.min(remaining, 1 / 50)
      remaining -= h
      this.substep(h)
    }
    this.updateOrder(true)
  }

  private substep(h: number) {
    this.time += h
    for (const car of this.cars) this.updateCar(car, h)
    this.resolveOverlaps()
    // lap / checkpoint bookkeeping happens in updateCar; sort for neighbour logic
    this.updateOrder(false)
    if (this.status === 'racing') {
      const leader = this.order[0]!
      this.leaderLapsCompleted = Math.max(0, leader.lapsCompleted)
      if (!this.drsEnabled && this.leaderLapsCompleted + 1 >= CIRCUIT.drs.enabledFromLap) {
        this.drsEnabled = true
        this.events.push({ type: 'drsEnabled', t: this.time })
      }
      if (this.leaderLapsCompleted >= this.totalLaps) {
        this.status = 'finished'
      }
    }
  }

  /**
   * Two cars can never occupy the same patch of road. After every car has moved, any pair
   * closer than a car length (same lateral band) is separated: the car behind is held back
   * and slowed, and cars that are almost exactly side by side are nudged apart.
   */
  private resolveOverlaps() {
    const L = this.track.length
    const cars = this.cars
    const n = cars.length
    for (let i = 0; i < n; i++) {
      const a = cars[i]!
      if (a.pitState === 'box') continue
      const aPit = a.pitState !== 'none'
      for (let j = i + 1; j < n; j++) {
        const b = cars[j]!
        if (b.pitState === 'box' || (b.pitState !== 'none') !== aPit) continue
        const d = signedDelta(a.s, b.s, L) // > 0: b is ahead of a
        if (Math.abs(d) >= MIN_GAP) continue
        const dl = b.lateral - a.lateral
        if (Math.abs(dl) >= 2 * CAR_HALF_WIDTH) continue
        const front = d > 0 ? b : a
        const rear = d > 0 ? a : b
        const overlap = MIN_GAP - Math.abs(d)
        if (rear.v > 0.5 && rear.s >= overlap + 1) {
          rear.s -= overlap
          rear.totalDist -= overlap
        }
        rear.v = Math.min(rear.v, Math.max(0, front.v - 0.5))
        if (Math.abs(dl) < 1.6 && Math.abs(d) > 1 && !aPit) {
          const push = (2 * CAR_HALF_WIDTH - Math.abs(dl)) / 2
          const dir = dl >= 0 ? 1 : -1
          b.lateral = clampLat(b.lateral + dir * push, this.maxLatAt(b.s))
          a.lateral = clampLat(a.lateral - dir * push, this.maxLatAt(a.s))
        }
      }
    }
  }

  private updateOrder(emitEvents: boolean) {
    this.order.sort((a, b) => {
      if (a.finished && b.finished) return a.finishTime - b.finishTime
      if (a.finished !== b.finished) return a.finished ? -1 : 1
      return b.totalDist - a.totalDist
    })
    this.order.forEach((c, i) => (c.position = i + 1))
    if (!emitEvents) return
    if (this.status === 'racing' && this.time > 12) {
      // a new race leader (the launch shuffle before 12 s is not announced, like the overtakes)
      const lead = this.order[0]!
      const prevLead = this.lastOrderIdx[0]
      if (prevLead !== undefined && prevLead !== lead.idx) this.events.push({ type: 'newLeader', car: lead.idx, previous: prevLead, t: this.time })
      const prevPos = new Map<number, number>()
      this.lastOrderIdx.forEach((idx, i) => prevPos.set(idx, i + 1))
      for (const c of this.order) {
        const prev = prevPos.get(c.idx) ?? c.position
        if (c.position < prev && c.pitState === 'none') {
          const passed = this.order[c.position]
          if (passed && passed.pitState === 'none' && (prevPos.get(passed.idx) ?? 99) < prev + 1 && !c.finished) {
            this.events.push({ type: 'overtake', car: c.idx, passed: passed.idx, position: c.position, t: this.time })
          }
        }
      }
    }
    this.lastOrderIdx = this.order.map((c) => c.idx)
  }

  private updateCar(car: CarSim, h: number) {
    const track = this.track
    const L = track.length
    if (this.time < car.launchDelay) {
      car.v = 0
      car.throttle = 0
      car.brake = 1
      return
    }
    const s = car.s
    const kappa = track.kappaLineAt(s)
    const inCorner = Math.abs(kappa) > 1 / 220
    const tyre = this.tyreFactor(car)
    let target = this.profileAt(car, s) * car.lapNoise
    if (car.finished) target *= 0.6
    target *= inCorner ? 1 - 0.5 * (1 - tyre) : 1 - 0.1 * (1 - tyre)
    // race pace: the profile is a low-fuel qualifying lap; in the race the cars carry up to
    // ~100 kg of fuel (burning ~1.9 kg/lap) and run engine/tyre-management modes, which costs
    // far more in the corners than on the straights
    const fuelKg = FUEL_START * Math.max(0, 1 - Math.max(0, car.lapsCompleted) / this.totalLaps)
    const pace = RACE_MODE * (1 - FUEL_SENSITIVITY * fuelKg)
    target *= inCorner ? pace : 1 - 0.3 * (1 - pace)

    // --- neighbours -----------------------------------------------------
    let nearestAhead: CarSim | null = null
    let nearestAheadD = Infinity
    let blocker: CarSim | null = null
    let blockerD = Infinity
    const lookahead = 70
    const inPit = car.pitState !== 'none'
    const myLat = car.lateral
    for (const o of this.cars) {
      if (o === car) continue
      const oInPit = o.pitState !== 'none'
      if (oInPit !== inPit) continue
      const d = forwardDelta(s, o.s, L)
      if (d <= 0.01 || d > lookahead) continue
      if (d < nearestAheadD) {
        nearestAheadD = d
        nearestAhead = o
      }
      const latDiff = Math.abs(o.lateral - myLat)
      const latDiffT = Math.abs(o.lateral - car.lateralTarget)
      if (Math.min(latDiff, latDiffT) < 2 * CAR_HALF_WIDTH + 0.4 && d < blockerD) {
        blockerD = d
        blocker = o
      }
    }
    car.gapAheadSec = nearestAhead ? nearestAheadD / Math.max(car.v, 5) : Infinity
    car.inDirtyAir = nearestAhead !== null && car.gapAheadSec < 1.2 && !inPit
    if (car.inDirtyAir && inCorner) target *= 0.985
    if (nearestAhead && !inPit && !inCorner && car.v > 50 && car.gapAheadSec < 0.9) target *= 1.02

    // --- DRS ------------------------------------------------------------
    const drs = CIRCUIT.drs
    const inZone = s >= drs.start || s < drs.end
    if (!inPit && this.drsEnabled) {
      const distToDet = forwardDelta(s, drs.detection, L)
      if (distToDet < 4 || (distToDet > L - car.v * h - 4)) {
        car.drsEligible = nearestAhead !== null && car.gapAheadSec < 1.0
      }
      if (inZone && car.drsEligible && target >= car.v - 0.5) {
        car.drsOpen = true
        target *= 1.035
      } else {
        car.drsOpen = false
      }
      if (!inZone && s > drs.end && s < drs.detection) car.drsEligible = false
    } else {
      car.drsOpen = false
    }

    // --- pit lane ---------------------------------------------------------
    const pit = CIRCUIT.pit
    if (car.pitState === 'none' && !car.finished && car.pitLap > 0 && car.lapsCompleted + 1 === car.pitLap) {
      const sinceEntry = forwardDelta(pit.entryS, s, L)
      if (sinceEntry < 60) {
        car.pitState = 'entering'
        car.passTarget = -1
        car.passSide = 0
        car.pitEntryTime = this.time
        car.pitEntryPos = car.position
        this.events.push({ type: 'pitIn', car: car.idx, position: car.position, t: this.time })
      }
    }
    if (car.pitState !== 'none') {
      const limit = pit.speedLimit
      const toLimit = forwardDelta(s, pit.limitStartS, L)
      const box = this.boxS(car)
      if (car.pitState === 'entering') {
        if (toLimit < L / 2) {
          target = Math.min(target, Math.sqrt(limit * limit + 2 * brakeLimit(limit) * toLimit))
        } else {
          car.pitState = 'lane'
        }
      }
      if (car.pitState === 'lane') {
        target = Math.min(target, limit)
        const toBox = forwardDelta(s, box, L)
        if (toBox < L / 2) {
          target = Math.min(target, Math.sqrt(2 * 12 * Math.max(0, toBox - 0.4)))
          if (toBox < 0.6 && car.v < 0.8) {
            car.pitState = 'box'
            car.pitTimer = 2.1 + this.rng.next() * 1.2
            car.pitStationary = car.pitTimer
            car.v = 0
          }
        }
      }
      if (car.pitState === 'box') {
        car.pitTimer -= h
        car.v = 0
        car.throttle = 0
        car.brake = 1
        if (car.pitTimer <= 0) {
          car.pitState = 'exiting'
          const from = car.compound
          car.compound = car.nextCompound
          car.tyreAge = 0
          car.pitStops++
          car.pitLap = -1
          this.events.push({ type: 'pit', car: car.idx, compound: car.compound, from, stationary: car.pitStationary, entryPosition: car.pitEntryPos, t: this.time })
        }
        return
      }
      if (car.pitState === 'exiting') {
        const sinceEntry = forwardDelta(pit.entryS, s, L)
        const toLimitEnd = forwardDelta(s, pit.limitEndS, L)
        if (toLimitEnd < L / 2 && sinceEntry < this.pitTotal) target = Math.min(target, limit)
        if (sinceEntry >= this.pitTotal - 2) {
          car.pitState = 'none'
          this.events.push({ type: 'pitOut', car: car.idx, position: car.position, entryPosition: car.pitEntryPos, total: this.time - car.pitEntryTime, t: this.time })
        }
      }
      // simple following inside the pit lane
      if (blocker && blockerD < 9) target = Math.min(target, blocker.v * 0.9)
    }

    // --- following / passing --------------------------------------------
    if (!inPit) {
      const gapNeeded = (6 + 0.22 * car.v) * (inCorner ? 1.3 : 1)
      if (car.passTarget >= 0) {
        const t = this.cars[car.passTarget]!
        const d = signedDelta(t.s, car.s, L)
        if (d > 9 || d < -45 || t.pitState !== 'none' || car.pitState !== 'none') {
          car.passTarget = -1
          car.passSide = 0
        } else {
          car.lateralTarget = clampLat(t.lateral + car.passSide * LANE_STEP, this.maxLatAt(s))
        }
      }
      if (blocker && blockerD < gapNeeded * 1.6) {
        if (car.passTarget < 0 && !car.finished) {
          const myPace = this.profileAt(car, s + 25) * car.lapNoise
          const faster = myPace > blocker.v * 1.03 || (car.drsOpen && !blocker.drsOpen) || car.gripBase > blocker.gripBase + 0.004
          if (faster && blockerD < gapNeeded * 1.2 && this.straightAhead(s, 60)) {
            const side = this.chooseSide(car, blocker)
            if (side !== 0) {
              car.passTarget = blocker.idx
              car.passSide = side
              car.lateralTarget = clampLat(blocker.lateral + side * LANE_STEP, this.maxLatAt(s))
            }
          }
        }
        const following = car.passTarget !== blocker.idx || Math.abs(blocker.lateral - car.lateral) < 2 * CAR_HALF_WIDTH + 0.2
        if (following) {
          const ctrl = blocker.v + (blockerD - gapNeeded) * 0.6
          target = Math.min(target, Math.max(ctrl, blocker.v * 0.6))
        }
      }
      if (car.passTarget < 0) {
        // return to the racing line unless someone is alongside
        let alongside = false
        for (const o of this.cars) {
          if (o === car || o.pitState !== 'none') continue
          const d = signedDelta(car.s, o.s, L)
          if (d > -7 && d < 7 && Math.abs(o.lateral - car.lateral) < 3.2) {
            alongside = true
            break
          }
        }
        car.lateralTarget = alongside ? car.lateral : clampLat(track.lineAt(s), this.maxLatAt(s))
      }
    } else {
      const pl = this.pitLateralAt(s)
      car.lateralTarget = pl ?? car.lateralTarget
      if (car.pitState === 'lane') {
        const toBox = forwardDelta(s, this.boxS(car), L)
        if (toBox < 40) car.lateralTarget = CIRCUIT.pit.laneOffset - 2.5
      }
    }

    // --- integrate speed --------------------------------------------------
    const slope = track.slopeAt(s)
    if (target > car.v) {
      const a = Math.max(0.05, accelLimit(car.v) - G * slope) * (this.time < 3 ? car.launchFactor : 1)
      car.v = Math.min(target, car.v + a * h)
      car.throttle = 1
      car.brake = 0
    } else {
      const b = Math.max(1, brakeLimit(car.v) + G * slope)
      const nv = Math.max(target, car.v - b * h)
      const decel = (car.v - nv) / h
      car.v = nv
      car.throttle = decel < 2 ? 0.35 : 0
      car.brake = decel > 6 ? Math.min(1, decel / 35) : 0
    }

    // --- integrate lateral ------------------------------------------------
    const rate = Math.min(5, 0.6 + car.v * 0.07)
    const diff = car.lateralTarget - car.lateral
    let stepL = Math.sign(diff) * Math.min(Math.abs(diff) * Math.min(1, h * 3), rate * h)
    // never steer into a band that another car occupies right beside us
    if (stepL !== 0) {
      const next = car.lateral + stepL
      const lim = inPit ? Infinity : this.maxLatAt(s)
      if (Math.abs(next) > lim && Math.abs(next) > Math.abs(car.lateral)) stepL = 0
      for (const o of this.cars) {
        if (o === car || (o.pitState !== 'none') !== inPit) continue
        const d = signedDelta(s, o.s, L)
        if (d <= -6 || d >= 6) continue
        if (Math.abs(o.lateral - next) < 2 * CAR_HALF_WIDTH && Math.abs(o.lateral - car.lateral) >= 2 * CAR_HALF_WIDTH) {
          stepL = 0
          break
        }
      }
    }
    car.lateral += stepL

    // --- advance ----------------------------------------------------------
    const ds = car.v * h
    const d0 = car.totalDist
    const d1 = d0 + ds
    car.totalDist = d1
    const s0 = car.s
    let s1 = s0 + ds
    if (s1 >= L) s1 -= L
    car.s = s1

    // checkpoints (indexed by position within the lap)
    const k0 = Math.floor(s0 / CP_LEN)
    const k1 = Math.floor(s1 / CP_LEN)
    const tPrev = this.time - h
    if (s1 >= s0) {
      for (let k = k0 + 1; k <= k1; k++) {
        const f = (k * CP_LEN - s0) / Math.max(ds, 1e-9)
        car.cpTimes[k % this.nCp] = tPrev + f * h
      }
    } else {
      for (let k = k0 + 1; k < this.nCp; k++) {
        const f = (k * CP_LEN - s0) / Math.max(ds, 1e-9)
        car.cpTimes[k] = tPrev + Math.min(1, f) * h
      }
      for (let k = 0; k <= k1; k++) {
        const f = (L - s0 + k * CP_LEN) / Math.max(ds, 1e-9)
        car.cpTimes[k] = tPrev + Math.min(1, f) * h
      }
    }

    // sector boundaries
    const bounds = [CIRCUIT.sectors[0], CIRCUIT.sectors[1]]
    for (let b = 0; b < 2; b++) {
      const bs = bounds[b]!
      if (s0 < bs && s1 >= bs && s1 >= s0) {
        const f = (bs - s0) / Math.max(ds, 1e-9)
        const t = tPrev + f * h
        if (car.crossings > 0 || this.time > 0) {
          const st = t - car.sectorStart
          car.sectors[b] = st
          car.sectorStart = t
          car.sector = b + 1
          if (st < car.bestSectors[b]!) car.bestSectors[b] = st
          if (st < this.bestSectors[b]!) this.bestSectors[b] = st
        }
      }
    }

    // start/finish line crossing
    if (s1 < s0 && ds > 0) {
      const f = (L - s0) / Math.max(ds, 1e-9)
      const t = tPrev + f * h
      car.crossings++
      car.lapsCompleted = car.crossings - 1
      if (car.crossings >= 2) {
        const lapTime = t - car.lapStartTime
        car.lastLap = lapTime
        const st = t - car.sectorStart
        car.sectors[2] = st
        if (st < car.bestSectors[2]!) car.bestSectors[2] = st
        if (st < this.bestSectors[2]!) this.bestSectors[2] = st
        car.lastSectors = car.sectors.slice()
        if (car.bestLap === 0 || lapTime < car.bestLap) car.bestLap = lapTime
        if (!car.finished && (!this.fastestLap || lapTime < this.fastestLap.time)) {
          this.fastestLap = { car: car.idx, time: lapTime }
          this.events.push({ type: 'fastestLap', car: car.idx, time: lapTime, t: this.time })
        }
        car.tyreAge++
        car.lapNoise = 1 + this.rng.gauss() * 0.0035
      }
      car.lapStartTime = t
      car.sectorStart = t
      car.sector = 0
      car.sectors = [null, null, null]
      // the leader takes the flag on the crossing that completes the last lap (the race status
      // only flips afterwards), everyone else on their next crossing once the race is over
      if ((this.status === 'finished' || car.lapsCompleted >= this.totalLaps) && !car.finished) {
        car.finished = true
        car.finishTime = this.time
        this.finishedCount++
        this.events.push({ type: 'chequered', car: car.idx, t: this.time })
      }
    }
  }

  private straightAhead(s: number, dist: number): boolean {
    const n = Math.ceil(dist / 10)
    for (let i = 0; i <= n; i++) {
      if (Math.abs(this.track.kappaLineAt(s + i * 10)) > 1 / 190) return false
    }
    return true
  }

  private chooseSide(car: CarSim, target: CarSim): 0 | 1 | -1 {
    const L = this.track.length
    const prefer: (1 | -1)[] = target.lateral > 0.4 ? [-1, 1] : target.lateral < -0.4 ? [1, -1] : car.idx % 2 ? [1, -1] : [-1, 1]
    const maxLat = Math.min(this.maxLatAt(car.s), this.maxLatAt(car.s + 60))
    for (const side of prefer) {
      const lat = target.lateral + side * LANE_STEP
      if (Math.abs(lat) > maxLat + 0.01) continue
      let free = true
      for (const o of this.cars) {
        if (o === car || o === target || o.pitState !== 'none') continue
        const d = signedDelta(car.s, o.s, L)
        if (d > -14 && d < 34 && Math.abs(o.lateral - lat) < 2 * CAR_HALF_WIDTH + 0.5) {
          free = false
          break
        }
      }
      if (free) return side
    }
    return 0
  }
}

function clampLat(v: number, max: number): number {
  return v < -max ? -max : v > max ? max : v
}

export function formatLapTime(t: number | null | undefined): string {
  if (!t || !Number.isFinite(t) || t <= 0) return '--:--.---'
  const m = Math.floor(t / 60)
  const s = t - m * 60
  return `${m}:${s.toFixed(3).padStart(6, '0')}`
}

export function formatGap(t: number): string {
  if (!Number.isFinite(t)) return '—'
  return `+${t.toFixed(3)}`
}

/**
 * Broadcast (2026 world feed) gap: ONE decimal, TRUNCATED — 0.999 reads +0.9, never +1.0.
 * The 1e-6 nudge keeps binary artefacts (0.3 → 0.29999…) from truncating a step early.
 */
export function formatGapTv(t: number): string {
  if (!Number.isFinite(t)) return '—'
  return `+${(Math.floor(t * 10 + 1e-6) / 10).toFixed(1)}`
}

export function formatSector(t: number | null | undefined): string {
  if (!t || !Number.isFinite(t)) return '--.---'
  return t.toFixed(3)
}

/**
 * Eight-speed gearbox: overall ratios (rpm per m/s) with the progressive spread of a modern
 * F1 box (big steps low down, close at the top). 8th reaches the limiter right at VMAX
 * (92 m/s → 11 900 rpm, so the end of the main straight bounces off the 12 000 rpm limiter),
 * 7th tops out at 84 m/s (130R stays in 7th/8th), the hairpin (~70 km/h) sits in 2nd at
 * ~8 000 rpm and 1st is a launch gear (up to 85 km/h). Upshifts at 11 800 rpm; on the overrun
 * the box holds a gear until the revs fall below ~7 600. Only the HUD and the engine sound
 * read this table — the sim never feeds gearFor back into the car speed.
 */
const GEAR_RATIOS = [0, 500, 415, 305, 235, 190, 160, 140, 129.5] // rpm per m/s, index = gear
export const REV_LIMIT = 12000
export const UPSHIFT = 11800
const DOWNSHIFT = 7600

export function gearFor(v: number, prevGear = 0, throttle = 1): { gear: number; rpm: number } {
  if (v < 1) return { gear: 0, rpm: 5000 }
  let g = prevGear > 0 ? prevGear : 1
  // shift up while over the upshift point, down while the revs would drop too low
  while (g < 8 && v * GEAR_RATIOS[g]! > UPSHIFT) g++
  while (g > 1 && v * GEAR_RATIOS[g]! < DOWNSHIFT) g--
  // under braking the driver short-shifts down one gear early for engine braking (never into
  // 1st: that is the launch gear)
  if (throttle < 0.2 && g > 2 && v * GEAR_RATIOS[g - 1]! < UPSHIFT - 600) g--
  const rpm = Math.min(REV_LIMIT, v * GEAR_RATIOS[g]!)
  return { gear: g, rpm }
}
