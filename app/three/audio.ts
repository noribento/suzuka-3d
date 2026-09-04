import * as THREE from 'three'
import type { QualityTier } from './scene'
import { REV_LIMIT, type RaceStatus } from '~/sim/race'
import { Rng } from '~/sim/random'

/**
 * Procedural race audio — no samples. Each car is a small synth modelled on a 2026 V6 turbo
 * hybrid: an order stack on the crank frequency (½, 1, 1½ and the 3rd = firing order), driven
 * into an asymmetric soft clip that opens with the load, then two low formants (150–480 Hz)
 * plus a dry path, band-limited by a highpass/lowpass pair whose cutoff also models the air
 * absorption with distance. Turbo hiss rides on top. Voices are positional (three.js
 * PositionalAudio) and Doppler-shifted by hand, since Web Audio dropped its own Doppler. Only
 * the nearest cars have live voices. An onboard wind layer and a crowd bed complete the mix,
 * summed through one bus compressor on the listener.
 *
 * The per-voice engine graph is built on a BaseAudioContext and driven by a pure function so
 * the same code renders into an OfflineAudioContext for the spectral probe.
 *
 * Node budget (checked in dev through `stats.nodes`, warned above NODE_BUDGET):
 *   per voice  low: 4 osc + 4 gains + mix + shaper + 2 formants + formantGain + dry + hiss
 *              src/filter/gain + master + lp + panner + PositionalAudio gain = 21
 *              high: + hp + MGU-K osc/gain + pop src/filter/gain = 27
 *   shared     listener gain + compressor + sfx + wind (4) + 2 crowd beds (5 each) = 17 [+ LFO 2]
 *   total      low 6 voices = 143, high 10 voices = 289 (budgets 150 / 300)
 */

const SPEED_OF_SOUND = 343
const TAU = Math.PI * 2
const NODE_BUDGET = { low: 150, high: 300 } as const
/** Own-car test for the onboard timbre: the T-cam sits 1.36 m from the car root (cameras.ts), refDistance is 9 m. */
const OWN_CAR_DIST = 4
/**
 * Start-light cue in the F1-game convention: one identical, short electronic "bip" as each red
 * lamp comes on — a 1.5 kHz fundamental with weak 2nd/3rd partials (−14 / −24 dB), a click-like
 * 1.5 ms onset, ~100 ms long, dry, no pitch motion. Lights out itself is silent (the real gantry
 * makes no sound at all; only the crowd reacts, see cue('lightsOut')). Times are seconds after
 * the scheduled onset; `peak` is the amplitude on the sfx bus (×0.8 to the listener), chosen to
 * sit ~6–10 dB above the idling grid drone and only ~1.6 dB into the bus compressor's knee.
 */
export const LAMP_BEEP = {
  f0: 1500,
  /** relative amplitudes of the 1st/2nd/3rd partials (PeriodicWave, normalised to a peak of 1) */
  partials: [1, 0.2, 0.06],
  peak: 0.3,
  /** scheduled one render quantum ahead so the attack is rendered from 0, never as a jump */
  lookahead: 0.004,
  attack: 0.0015,
  hold: 0.035,
  /** −60 dB point of the exponential decay */
  decayTo: 0.105,
  /** linear ramp to exactly 0 (an exponential ramp cannot reach it) */
  end: 0.115,
  stop: 0.13,
} as const

export interface RaceAudioOptions {
  /** high: 10 HRTF voices with every optional layer; low (SwiftShader / e2e): 6 equalpower voices */
  tier: QualityTier
  seed?: number
}

/** Nodes of one engine voice (everything optional is high-tier only and null on low). */
interface EngineNodes {
  osc: OscillatorNode[]
  oscGain: GainNode[]
  mix: GainNode
  shaper: WaveShaperNode
  formant: BiquadFilterNode[]
  formantGain: GainNode
  dry: GainNode
  hissSrc: AudioBufferSourceNode
  hissFilter: BiquadFilterNode
  hiss: GainNode
  master: GainNode
  /** band limit + air absorption (inserted via Audio.setFilters on the positional voice) */
  lp: BiquadFilterNode
  /** DC block, high tier only (the low tier uses the symmetric clip curve instead) */
  hp: BiquadFilterNode | null
  /** MGU-K whine (sine), high tier only */
  whine: OscillatorNode | null
  whineGain: GainNode | null
  /** exhaust pops (low-passed noise bursts), high tier only */
  popSrc: AudioBufferSourceNode | null
  pop: GainNode | null
}

/** Race-level values the engines and the crowd react to (store values are passed in: audio stays store-free). */
export interface AudioRaceState {
  status: RaceStatus
  lights: number
  /** seconds since the light sequence started (0 outside 'lights') */
  lightsElapsed: number
  /** race clock (0 through grid / lights) */
  time: number
  simSpeed: number
}

/** Smoothed per-voice state (real-time seconds). */
interface EngineState {
  gear: number
  /** grid idle blips: envelope time (-1 = none), peak rpm, next blip at voice time */
  blipT: number
  blipPeak: number
  nextBlip: number
  /** idle lope phase offset so the grid does not throb in unison */
  phase: number
  /** smoothed throttle: 0.25 s rise (progressive squeeze on exit), 0.06 s fall (a lift is fast) */
  thr: number
  /** turbo boost 0..1 — 2026 rules have no MGU-H, so the spool lags the throttle (0.35 s up / 0.12 s down) */
  boost: number
  /** MGU-K electrical load (harvest under braking, deploy on exit) */
  elec: number
  /** 0..1 "this is the onboard car" — smoothed (0.2 s) so director cuts do not click */
  onb: number
  /** downshift pitch flare / level lift end times (context clock) */
  flareUntil: number
  liftUntil: number
  /** upshift cut: the master envelope is scheduled explicitly until this time */
  cutUntil: number
  /** voice-local seconds at which the throttle was last above 0.5 (overrun trigger window) */
  lastHighThr: number
  /** context time of the last overrun burst (rate limit 0.6 s) */
  lastBurst: number
  /** limiter gate: next scheduled cut (context clock); -1 when inactive */
  limNext: number
  /** voice-local time (real seconds) */
  t: number
}

interface Voice {
  car: number
  audio: THREE.PositionalAudio
  n: EngineNodes
  s: EngineState
  /** context time at which the voice was released (no re-use for 0.12 s so the fade-out finishes) */
  releaseAt: number
}

export interface CarAudioState {
  position: THREE.Vector3
  velocity: THREE.Vector3
  rpm: number
  throttle: number
  brake: number
  drsOpen: boolean
  gear: number
  v: number
  /** sim advancing (false only while paused): the voice fades to silence otherwise */
  running: boolean
}

/** Car values the engine model reads (no vectors: usable offline). */
interface EngineInput {
  rpm: number
  throttle: number
  brake: number
  drsOpen: boolean
  gear: number
  v: number
  running: boolean
}

/** Listener-relative values computed by update() (or fixed by the probe). */
interface DriveEnv {
  now: number
  dt: number
  doppler: number
  dist: number
  /** this voice is the car the onboard camera rides */
  onboard: boolean
  /** snap every AudioParam with setValueAtTime instead of gliding (voice re-assignment, unmute) */
  snap: boolean
  /** also jump the smoothed state (thr/boost/elec) to its target: used when a voice is re-assigned */
  settle: boolean
  /** jitter source for pops and idle blips (the audio's own stream, never the sim's) */
  rng: Rng
}

/** First-order lag toward `target` with time constant `tau` over `dt` (frame-rate independent). */
function lag(value: number, target: number, tau: number, dt: number): number {
  return value + (target - value) * (1 - Math.exp(-dt / tau))
}

/** Order stack relative to the crank frequency: type, gain, order (½ = sub, 3 = V6 firing). */
const ORDERS = [['triangle', 0.3, 0.5], ['sawtooth', 0.34, 1.0], ['sawtooth', 0.28, 1.5], ['sawtooth', 0.44, 3.0]] as const

/** Seeded pink-ish noise (deterministic: the probe and A/B listening render the same buffer). */
function makeNoise(ctx: BaseAudioContext, seconds: number, rng: Rng): AudioBuffer {
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate)
  const d = buf.getChannelData(0)
  let b0 = 0, b1 = 0, b2 = 0
  for (let i = 0; i < d.length; i++) {
    // Paul Kellet's economy pink filter
    const w = rng.next() * 2 - 1
    b0 = 0.99765 * b0 + w * 0.099046
    b1 = 0.963 * b1 + w * 0.2965164
    b2 = 0.57 * b2 + w * 1.0526913
    d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2
  }
  return buf
}

/**
 * tanh soft clip; a positive `bias` makes the transfer asymmetric, which adds even orders
 * (the "heavy" half-order content of a V6) at the cost of a DC offset that the highpass removes.
 */
function softClipCurve(k = 3, bias = 0): Float32Array<ArrayBuffer> {
  const n = 1024
  const c = new Float32Array(new ArrayBuffer(n * 4))
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1
    c[i] = Math.tanh(k * (x + bias)) / Math.tanh(k)
  }
  return c
}

/** The lamp beep's waveform: sine plus weak 2nd/3rd partials (default normalisation → summed peak = 1). */
function makeBeepWave(ctx: BaseAudioContext): PeriodicWave {
  const p = LAMP_BEEP.partials
  return ctx.createPeriodicWave(new Float32Array([0, 0, 0, 0]), new Float32Array([0, p[0], p[1], p[2]]))
}

/**
 * Schedule one lamp beep at `t0` on the audio clock: click-like attack, short plateau, exponential
 * tail to −60 dB, then a linear ramp to exactly 0 so stop() never leaves a step. Shared by the live
 * sfx bus and the offline probe (renderBeep) so the two cannot drift apart.
 */
function scheduleBeep(ctx: BaseAudioContext, wave: PeriodicWave, out: AudioNode, t0: number): { osc: OscillatorNode; gain: GainNode } {
  const b = LAMP_BEEP
  const osc = ctx.createOscillator()
  osc.setPeriodicWave(wave)
  osc.frequency.value = b.f0
  const gain = ctx.createGain()
  const g = gain.gain
  g.setValueAtTime(0, t0)
  g.linearRampToValueAtTime(b.peak, t0 + b.attack)
  g.setValueAtTime(b.peak, t0 + b.hold)
  g.exponentialRampToValueAtTime(b.peak * 1e-3, t0 + b.decayTo)
  g.linearRampToValueAtTime(0, t0 + b.end)
  osc.connect(gain).connect(out)
  osc.start(t0)
  osc.stop(t0 + b.stop)
  return { osc, gain }
}

interface EngineShared {
  noise: AudioBuffer
  clipHigh: Float32Array<ArrayBuffer>
  clipLow: Float32Array<ArrayBuffer>
  tier: QualityTier
  /** bank-beat LFO output (cents), high tier only */
  lfo: AudioNode | null
}

const clamp = THREE.MathUtils.clamp

/** Build one engine voice; the caller wires `master` (through `hp`/`lp`) to its output. */
function buildEngineGraph(ctx: BaseAudioContext, shared: EngineShared, mk: <T extends AudioNode>(n: T) => T): EngineNodes {
  const high = shared.tier === 'high'
  const master = mk(ctx.createGain())
  master.gain.value = 0
  const shaper = mk(ctx.createWaveShaper())
  shaper.curve = high ? shared.clipHigh : shared.clipLow
  shaper.oversample = high ? '2x' : 'none'
  const mix = mk(ctx.createGain())
  mix.gain.value = 0.5
  const osc: OscillatorNode[] = []
  const oscGain: GainNode[] = []
  for (const [type, gain] of ORDERS) {
    const o = mk(ctx.createOscillator())
    o.type = type
    const g = mk(ctx.createGain())
    g.gain.value = gain
    o.connect(g).connect(mix)
    o.start()
    osc.push(o)
    oscGain.push(g)
  }
  // the two banks never run perfectly in phase: a slow beat on the 1½ order
  if (shared.lfo) shared.lfo.connect(osc[2]!.detune)
  // turbo: the compressor whistle is a high-Q band on the shared noise that sweeps up with boost
  const hissSrc = mk(ctx.createBufferSource())
  hissSrc.buffer = shared.noise
  hissSrc.loop = true
  hissSrc.playbackRate.value = 1.2
  const hissFilter = mk(ctx.createBiquadFilter())
  hissFilter.type = 'bandpass'
  hissFilter.frequency.value = 4000
  hissFilter.Q.value = 3
  const hiss = mk(ctx.createGain())
  hiss.gain.value = 0
  hissSrc.connect(hissFilter).connect(hiss).connect(master)
  hissSrc.start()
  // MGU-K: one sine per voice (350 kW of electric machine is the dominant electric sound in 2026)
  let whine: OscillatorNode | null = null
  let whineGain: GainNode | null = null
  if (high) {
    whine = mk(ctx.createOscillator())
    whine.type = 'sine'
    whine.frequency.value = 1500
    whineGain = mk(ctx.createGain())
    whineGain.gain.value = 0
    whine.connect(whineGain).connect(master)
    whine.start()
  }
  // body: soft clip → two low formant peaks in parallel + dry path
  mix.connect(shaper)
  const formant: BiquadFilterNode[] = []
  const formantGain = mk(ctx.createGain())
  formantGain.gain.value = 0.4
  for (const [f, q] of [[250, 1.3], [480, 1.7]] as const) {
    const bp = mk(ctx.createBiquadFilter())
    bp.type = 'bandpass'
    bp.frequency.value = f
    bp.Q.value = q
    shaper.connect(bp).connect(formantGain)
    formant.push(bp)
  }
  formantGain.connect(master)
  const dry = mk(ctx.createGain())
  dry.gain.value = 0.3
  shaper.connect(dry).connect(master)
  // band limit: the highpass blocks the DC of the asymmetric clip, the lowpass is set per frame
  // (load + air absorption with distance)
  const lp = mk(ctx.createBiquadFilter())
  lp.type = 'lowpass'
  lp.frequency.value = 4000
  lp.Q.value = 0.7
  let hp: BiquadFilterNode | null = null
  if (high) {
    hp = mk(ctx.createBiquadFilter())
    hp.type = 'highpass'
    hp.frequency.value = 40
    hp.Q.value = 0.7
  }
  // exhaust pops: looping noise through a 260 Hz lowpass, gated by a scheduled envelope
  let popSrc: AudioBufferSourceNode | null = null
  let pop: GainNode | null = null
  if (high) {
    popSrc = mk(ctx.createBufferSource())
    popSrc.buffer = shared.noise
    popSrc.loop = true
    const popFilter = mk(ctx.createBiquadFilter())
    popFilter.type = 'lowpass'
    popFilter.frequency.value = 260
    popFilter.Q.value = 1.4
    pop = mk(ctx.createGain())
    pop.gain.value = 0
    popSrc.connect(popFilter).connect(pop).connect(master)
    popSrc.start()
  }
  return { osc, oscGain, mix, shaper, formant, formantGain, dry, hissSrc, hissFilter, hiss, master, lp, hp, whine, whineGain, popSrc, pop }
}

/** One exhaust pop at absolute time `t` (exponential ramps cannot reach 0, hence 0.001). */
function schedulePop(n: EngineNodes, t: number, amp: number) {
  if (!n.pop) return
  n.pop.gain.setValueAtTime(amp, t)
  n.pop.gain.exponentialRampToValueAtTime(0.001, t + 0.045)
}

function setParam(p: AudioParam, value: number, now: number, tau: number, snap: boolean) {
  if (snap) {
    p.cancelScheduledValues(now)
    p.setValueAtTime(value, now)
  } else p.setTargetAtTime(value, now, tau)
}

const smoothstep = THREE.MathUtils.smoothstep

/**
 * Drive one voice for a frame. Pure (no THREE objects, no DOM): the same function schedules
 * the offline probe. All automation is on the absolute context clock.
 */
function driveEngine(n: EngineNodes, s: EngineState, c: EngineInput, race: AudioRaceState, env: DriveEnv) {
  const { now, dt, doppler, snap, settle, rng } = env
  s.t += dt
  // --- effective revs and throttle target: the sim only knows speed, so the stationary car's
  // engine (idle lope, launch revs rising with the lamps, clutch slip off the line) is modelled here
  let rpmEff: number
  let thrTarget: number
  if (c.v < 1) {
    const base = 4300 + 220 * Math.sin(TAU * 0.8 * s.t + s.phase)
    let launch = 0
    if (race.status === 'lights') launch = 4300 + 6200 * smoothstep(race.lightsElapsed, 0, 5.5)
    else if (race.status === 'racing' && race.time < 0.6) launch = 10500 // clutch bite, covers the launch delay
    let blip = 0
    if (race.status === 'grid' || (race.status === 'lights' && race.lightsElapsed < 1)) {
      if (s.t > s.nextBlip) {
        s.blipPeak = rng.range(2500, 5000)
        s.blipT = 0
        s.nextBlip = s.t + rng.range(1.5, 5.0)
      }
    }
    if (s.blipT >= 0) {
      blip = s.blipPeak * (s.blipT < 0.15 ? s.blipT / 0.15 : Math.exp(-(s.blipT - 0.15) / 0.5))
      s.blipT += dt
      if (s.blipT > 3) s.blipT = -1
    }
    rpmEff = Math.max(base, launch) + blip
    thrTarget = race.status === 'lights' ? 0.35 + 0.65 * smoothstep(race.lightsElapsed, 0, 5.5) : 0.15 + blip / 5000
  } else {
    // off the line the revs blend from clutch-slip 10 500 down to the geared value over 25 m/s
    rpmEff = Math.max(c.rpm, 10500 * (1 - clamp(c.v / 25, 0, 1)), 3800)
    thrTarget = c.throttle
  }
  const rpm = rpmEff
  // downshift: a short pitch flare (the blip) while the clutch re-engages
  const flare = now < s.flareUntil ? 1.09 : 1
  const f1 = (rpm / 60) * doppler * flare
  for (let k = 0; k < n.osc.length; k++) setParam(n.osc[k]!.frequency, ORDERS[k]![2] * f1, now, flare > 1 ? 0.02 : 0.03, snap)
  // continuous load from the sim's 3-valued throttle (1 / 0.35 / 0)
  const prevThr = s.thr
  s.thr = settle ? thrTarget : lag(s.thr, thrTarget, thrTarget > s.thr ? 0.25 : 0.06, dt)
  if (s.thr > 0.5) s.lastHighThr = s.t
  const load = 0.3 + 0.7 * s.thr
  // onboard: the cockpit hears the intake and the body more than the exhaust rasp
  const onbTarget = env.onboard ? 1 : 0
  s.onb = settle ? onbTarget : lag(s.onb, onbTarget, 0.2, dt)
  const onb = s.onb
  const rpmNorm = clamp((rpm - 4000) / 8000, 0, 1)
  // turbo boost follows exhaust energy (throttle × revs) with the spool lag
  const boostTarget = s.thr * (0.35 + 0.65 * rpmNorm)
  s.boost = settle ? boostTarget : lag(s.boost, boostTarget, boostTarget > s.boost ? 0.35 : 0.12, dt)
  // the drive, formants and the lowpass open with the load
  setParam(n.mix.gain, 0.35 + 0.45 * load, now, 0.05, snap)
  setParam(n.formant[0]!.frequency, (165 - 55 * onb + 85 * load) * doppler, now, 0.05, snap)
  setParam(n.formant[1]!.frequency, (330 + 150 * load) * doppler, now, 0.05, snap)
  setParam(n.formantGain.gain, (0.4 + 0.5 * load) * (1 + 0.3 * onb), now, 0.05, snap)
  setParam(n.dry.gain, 0.3 * (1 + 0.2 * onb), now, 0.05, snap)
  // trackside hears more of the 1½-order rasp than the cockpit
  setParam(n.oscGain[2]!.gain, 0.28 * (1 + 0.25 * (1 - onb)), now, 0.05, snap)
  // air absorption: 17 kHz at 10 m, 9.5 kHz at 60 m, 4.2 kHz at 200 m
  const airCut = 20000 / (1 + env.dist / 55)
  const bodyCut = (1500 - 500 * onb + (2800 - 1500 * onb) * load) * doppler // 4.3 kHz trackside, 2.3 kHz in the cockpit at full load
  setParam(n.lp.frequency, clamp(Math.min(bodyCut, airCut), 700, 16000), now, 0.08, snap)
  // compressor whistle: centre and pitch climb with boost, the band narrows as it spools
  setParam(n.hissFilter.frequency, (4000 + 8000 * s.boost * rpmNorm) * doppler, now, 0.05, snap)
  setParam(n.hissFilter.Q, 3 + 5 * s.boost, now, 0.05, snap)
  setParam(n.hissSrc.playbackRate, (1.2 + 0.9 * s.boost) * doppler, now, 0.05, snap)
  setParam(n.hiss.gain, 0.012 + 0.06 * s.boost * (0.4 + 0.6 * rpmNorm), now, 0.05, snap)
  // MGU-K: harvest whine under braking (pitch follows road speed), a fainter deploy whine on exit
  if (n.whine && n.whineGain) {
    const harvest = 0.035 * c.brake * clamp(c.v / 60, 0, 1)
    const deploy = 0.016 * s.thr * clamp((c.v - 15) / 40, 0, 1) * (c.drsOpen ? 1.15 : 1)
    const elecTarget = Math.max(harvest, deploy)
    s.elec = settle ? elecTarget : lag(s.elec, elecTarget, 0.05, dt)
    setParam(n.whine.frequency, (1500 + 5500 * clamp(c.v / 95, 0, 1)) * doppler, now, 0.05, snap)
    setParam(n.whineGain.gain, s.elec * (1 - 0.5 * onb), now, 0.03, snap)
  }
  const idle = c.v < 0.5 ? 0.45 : 1
  // paused: fade to silence (0.15 s) instead of droning on
  const level = (0.45 + 0.55 * load) * idle * (now < s.liftUntil ? 1.15 : 1) * (c.running ? 1 : 0) * 0.9
  const moving = c.v >= 1
  // --- transients (only while the sim advances; never during the offline settle) ---
  if (c.gear !== s.gear) {
    const up = c.gear > s.gear && s.gear > 0 && moving
    const down = c.gear < s.gear && c.gear > 0 && moving
    s.gear = c.gear
    if (up && c.running && !settle) {
      // upshift: 35 ms ignition cut, then the exhaust bang as the torque comes back
      n.master.gain.cancelScheduledValues(now)
      n.master.gain.setValueAtTime(level * 0.25, now)
      n.master.gain.setTargetAtTime(level, now + 0.035, 0.012)
      s.cutUntil = now + 0.035
      schedulePop(n, now + 0.035, 0.16 * (1 - 0.5 * onb))
    } else if (down && c.running && !settle) {
      // downshift: throttle blip (pitch +9 % for 60 ms, level +15 % for 80 ms) plus a small pop
      s.flareUntil = now + 0.06
      s.liftUntil = now + 0.08
      schedulePop(n, now, 0.08 * (1 - 0.5 * onb))
    }
  }
  // overrun crackle: a lift from >0.5 to <0.15 within 0.3 s at high revs fires 3-7 pops
  if (n.pop && c.running && !settle && moving && s.thr < 0.15 && prevThr >= 0.15 && s.t - s.lastHighThr < 0.3 && rpm > 7500 && now - s.lastBurst > 0.6) {
    s.lastBurst = now
    const count = rng.int(3, 7)
    const far = clamp(1 - env.dist / 600, 0.2, 1) * (1 - 0.5 * onb)
    let t = now
    for (let i = 0; i < count; i++) {
      schedulePop(n, t, rng.range(0.08, 0.2) * far)
      t += rng.range(0.035, 0.09)
    }
  }
  // limiter: a 25 Hz gate on the master while bouncing off the rev limit at full throttle
  const onLimiter = moving && c.running && !settle && rpm >= REV_LIMIT - 100 && s.thr > 0.8
  if (onLimiter) {
    if (s.limNext < 0) {
      n.master.gain.cancelScheduledValues(now)
      s.limNext = now
    }
    while (s.limNext < now + dt) {
      n.master.gain.setValueAtTime(level * 0.4, s.limNext)
      n.master.gain.setValueAtTime(level, s.limNext + 0.016)
      s.limNext += 0.04
    }
  } else {
    if (s.limNext >= 0) {
      s.limNext = -1
      n.master.gain.cancelScheduledValues(now)
    }
    if (now >= s.cutUntil) setParam(n.master.gain, level, now, c.running ? 0.02 : 0.15, snap)
  }
}

export interface ProbeParams {
  rpm: number
  throttle: number
  brake?: number
  v?: number
  onboard?: boolean
  dist?: number
  status?: 'grid' | 'racing'
  tier?: QualityTier
  seconds?: number
}

function newState(phase = 0): EngineState {
  return { gear: 0, blipT: -1, blipPeak: 0, nextBlip: 1, phase, thr: 0, boost: 0, elec: 0, onb: 0, flareUntil: -1, liftUntil: -1, cutUntil: -1, lastHighThr: -10, lastBurst: -10, limNext: -1, t: 0 }
}

/** Reset the transient clocks (voice re-assignment, context resume). */
function resetClocks(s: EngineState) {
  s.flareUntil = -1
  s.liftUntil = -1
  s.cutUntil = -1
  s.lastHighThr = -10
  s.lastBurst = -10
  s.limNext = -1
}

export class RaceAudio {
  /**
   * Render one voice offline (no panner, no listener, no gesture) for the spectral probe and
   * the audio e2e spec: returns channel 0 at 48 kHz. Steady inputs; the drive function is
   * stepped at 50 Hz so time-based behaviour (idle lope, blips) is rendered too.
   */
  static async renderProbe(p: ProbeParams): Promise<Float32Array> {
    const seconds = p.seconds ?? 3
    const tier = p.tier ?? 'high'
    const sr = 48000
    const ctx = new OfflineAudioContext(1, Math.floor(sr * seconds), sr)
    const mk = <T extends AudioNode>(n: T) => n
    let lfo: AudioNode | null = null
    if (tier === 'high') {
      const lfoOsc = ctx.createOscillator()
      lfoOsc.frequency.value = 1.7
      const lfoGain = ctx.createGain()
      lfoGain.gain.value = 9
      lfoOsc.connect(lfoGain)
      lfoOsc.start()
      lfo = lfoGain
    }
    const shared: EngineShared = { noise: makeNoise(ctx, 2, new Rng(0x5eed)), clipHigh: softClipCurve(3.2, 0.12), clipLow: softClipCurve(3.2, 0), tier, lfo }
    const n = buildEngineGraph(ctx, shared, mk)
    let tail: AudioNode = n.master
    if (n.hp) tail = tail.connect(n.hp)
    tail.connect(n.lp).connect(ctx.destination)
    const s = newState()
    const grid = p.status === 'grid'
    const c: EngineInput = { rpm: p.rpm, throttle: p.throttle, brake: p.brake ?? 0, drsOpen: false, gear: grid ? 0 : 6, v: p.v ?? (grid ? 0 : 60), running: true }
    const race: AudioRaceState = { status: grid ? 'grid' : 'racing', lights: 0, lightsElapsed: 0, time: grid ? 0 : 60, simSpeed: 1 }
    const env: DriveEnv = { now: 0, dt: 0.02, doppler: 1, dist: p.dist ?? 10, onboard: !!p.onboard, snap: true, settle: true, rng: new Rng(0x5eed) }
    const steps = Math.ceil(seconds / env.dt)
    for (let k = 0; k < steps; k++) {
      env.now = k * env.dt
      driveEngine(n, s, c, race, env)
      env.snap = false
      env.settle = false
    }
    const buf = await ctx.startRendering()
    return buf.getChannelData(0)
  }

  /**
   * Render one lamp beep offline (no sfx gain, no compressor) for the audio e2e spec: onset at
   * 20 ms, 48 kHz mono, 250 ms long so the silence after the tail can be checked too.
   */
  static async renderBeep(): Promise<Float32Array> {
    const sr = 48000
    const ctx = new OfflineAudioContext(1, Math.floor(sr * 0.25), sr)
    scheduleBeep(ctx, makeBeepWave(ctx), ctx.destination, 0.02)
    const buf = await ctx.startRendering()
    return buf.getChannelData(0)
  }

  readonly listener: THREE.AudioListener
  private readonly ctx: AudioContext
  private readonly voices: Voice[] = []
  private readonly shared: EngineShared
  private wind: { gain: GainNode; filter: BiquadFilterNode } | null = null
  /** crowd beds (main grandstand and Spoon side); the gain is the bed level before the panner */
  readonly crowds: { audio: THREE.PositionalAudio; gain: GainNode }[] = []
  private crowdSwell = 0
  private swellTarget = 0
  /** seconds (frame dt) the swell target is held before it decays */
  private swellHold = 0
  /** one-shot cues still sounding (start-light beeps), stopped by cancelCues() */
  private live: { osc: OscillatorNode; gain: GainNode }[] = []
  /** the lamp beep's waveform, built once per context */
  private readonly beepWave: PeriodicWave
  private readonly tier: QualityTier
  private readonly maxVoices: number
  /** bus compressor on the listener output (three's mute gain sits upstream of it) */
  readonly comp: DynamicsCompressorNode
  /** non-positional one-shot bus (start-light beeps), through the listener gain so ♪ mutes it */
  private readonly sfx: GainNode
  private nodeCount = 0
  private muted = false
  /** set on unmute: the next update() snaps the automation instead of gliding from stale values */
  private resync = false
  private readonly listenerPrev = new THREE.Vector3()
  private readonly listenerVel = new THREE.Vector3()
  /** scratch: listener position and a separate line-of-sight vector (never alias the two) */
  private readonly _cam = new THREE.Vector3()
  private readonly _d = new THREE.Vector3()
  /** the audio's own jitter stream (pops, idle blips): separate from the sim's Rng */
  private readonly rng: Rng
  /** counts every node we create so the per-tier budget can be checked (see `stats`) */
  private readonly mk = <T extends AudioNode>(n: T): T => {
    this.nodeCount++
    return n
  }

  /**
   * @param crowdAt grandstand positions for the crowd beds (main straight, Spoon side)
   */
  constructor(camera: THREE.Camera, crowdAt: THREE.Vector3[], parent: THREE.Object3D, opts: RaceAudioOptions) {
    this.tier = opts.tier
    this.maxVoices = opts.tier === 'high' ? 10 : 6
    this.rng = new Rng(opts.seed ?? 0x5eed)
    this.listener = new THREE.AudioListener()
    camera.add(this.listener)
    this.ctx = this.listener.context
    this.nodeCount = 1 // the listener's own gain
    const ctx = this.ctx
    // bus compressor: glues the summed pack; DynamicsCompressorNode applies make-up gain per
    // spec, so a single node inserted with setFilter() is the whole bus
    const comp = this.mk(ctx.createDynamicsCompressor())
    comp.threshold.value = -14
    comp.knee.value = 8
    comp.ratio.value = 4
    comp.attack.value = 0.004
    comp.release.value = 0.22
    this.listener.setFilter(comp)
    this.comp = comp
    this.sfx = this.mk(ctx.createGain())
    this.sfx.gain.value = 0.8
    this.sfx.connect(this.listener.getInput())
    this.beepWave = makeBeepWave(ctx)
    // shared engine resources; the bank-beat LFO (1.7 Hz, ±9 cents) is one pair of nodes for all voices
    let lfo: AudioNode | null = null
    if (this.tier === 'high') {
      const lfoOsc = this.mk(ctx.createOscillator())
      lfoOsc.frequency.value = 1.7
      const lfoGain = this.mk(ctx.createGain())
      lfoGain.gain.value = 9
      lfoOsc.connect(lfoGain)
      lfoOsc.start()
      lfo = lfoGain
    }
    this.shared = { noise: makeNoise(ctx, 2, new Rng(0x5eed)), clipHigh: softClipCurve(3.2, 0.12), clipLow: softClipCurve(3.2, 0), tier: this.tier, lfo }
    // wind: non-positional, only audible onboard (highpass keeps the rumble out of the engine's band)
    const windSrc = this.mk(ctx.createBufferSource())
    windSrc.buffer = this.shared.noise
    windSrc.loop = true
    const windHp = this.mk(ctx.createBiquadFilter())
    windHp.type = 'highpass'
    windHp.frequency.value = 120
    windHp.Q.value = 0.7
    const windFilter = this.mk(ctx.createBiquadFilter())
    windFilter.type = 'lowpass'
    windFilter.frequency.value = 600
    const windGain = this.mk(ctx.createGain())
    windGain.gain.value = 0
    windSrc.connect(windHp).connect(windFilter).connect(windGain).connect(this.listener.getInput())
    windSrc.start()
    this.wind = { gain: windGain, filter: windFilter }
    // crowd beds: main grandstand and the Spoon side, slightly different pitch so they do not phase
    crowdAt.forEach((at, i) => this.crowds.push(this.makeCrowdBed(at, i === 0 ? 0.55 : 0.48, parent)))
    this.listenerPrev.copy(camera.getWorldPosition(new THREE.Vector3()))
    if (import.meta.dev) this.checkBudget()
  }

  private makeCrowdBed(at: THREE.Vector3, rate: number, parent: THREE.Object3D) {
    const ctx = this.ctx
    const audio = new THREE.PositionalAudio(this.listener)
    this.nodeCount += 2 // panner + gain inside PositionalAudio
    const src = this.mk(ctx.createBufferSource())
    src.buffer = this.shared.noise
    src.loop = true
    src.playbackRate.value = rate
    const filter = this.mk(ctx.createBiquadFilter())
    filter.type = 'bandpass'
    filter.frequency.value = 500
    filter.Q.value = 0.5
    const gain = this.mk(ctx.createGain())
    gain.gain.value = 0.3
    src.connect(filter).connect(gain)
    audio.setNodeSource(gain as unknown as AudioBufferSourceNode)
    audio.setRefDistance(60)
    audio.setRolloffFactor(1.2)
    audio.setDistanceModel('inverse')
    audio.position.copy(at)
    parent.add(audio)
    src.start()
    return { audio, gain }
  }

  /** Dev-only: warn (never error — the e2e collector fails on console errors) when over budget. */
  private checkBudget() {
    const budget = NODE_BUDGET[this.tier]
    if (this.nodeCount > budget) console.warn(`[audio] ${this.nodeCount} nodes on the ${this.tier} tier (budget ${budget})`)
  }

  /**
   * Crowd reaction: lights out, an overtake (strength scales with how high up the order) or the
   * chequered flag swell the beds (0.6 s attack, ~4 s release).
   */
  cue(kind: 'lightsOut' | 'overtake' | 'chequered', strength = 1) {
    // a cue that arrives while muted / before the gesture must not fire on unmute
    if (this.muted || this.ctx.state !== 'running') return
    const target = kind === 'lightsOut' ? 1 : kind === 'chequered' ? 0.9 : 0.55 * strength
    this.swellTarget = Math.max(this.swellTarget, target)
    this.swellHold = 1
  }

  get stats() {
    return { nodes: this.nodeCount, voices: this.voices.length, tier: this.tier }
  }

  /** Resume the context after a user gesture (autoplay policy) or a tab-hidden suspend. */
  resume() {
    if (this.ctx.state !== 'running') {
      // ctx.currentTime did not advance while suspended: drop the pending transient clocks
      for (const v of this.voices) resetClocks(v.s)
      void this.ctx.resume()
    }
  }

  setMuted(m: boolean) {
    this.muted = m
    this.listener.setMasterVolume(m ? 0 : 1)
    if (!m) this.resync = true
  }

  /** Suspend the context (tab hidden). `resume()` undoes it. */
  suspend() {
    if (this.ctx.state === 'running') void this.ctx.suspend()
  }

  /** Snap a re-assigned voice to its car: no glide from the previous car's revs. */
  private resetVoice(v: Voice, car: number, c: CarAudioState, now: number) {
    v.car = car
    v.s.gear = c.gear
    v.s.blipT = -1
    v.s.nextBlip = v.s.t + this.rng.range(0.5, 3)
    v.s.thr = c.throttle
    v.s.boost = 0
    v.s.elec = 0
    resetClocks(v.s)
    v.n.master.gain.cancelScheduledValues(now)
    v.n.master.gain.setValueAtTime(0, now)
    if (v.n.pop) {
      v.n.pop.gain.cancelScheduledValues(now)
      v.n.pop.gain.setValueAtTime(0, now)
    }
    const f1 = Math.max(3800, c.rpm) / 60
    v.n.osc.forEach((o, k) => {
      o.frequency.cancelScheduledValues(now)
      o.frequency.setValueAtTime(ORDERS[k]![2] * f1, now)
    })
  }

  /**
   * Start-light beep on the SFX bus — the F1-game convention: one short, clean 1.5 kHz bip as each
   * red lamp comes on, all five identical, nothing at lights out (the crowd swell is cued separately
   * by the viewport). Rides the listener gain, so ♪ mutes it; registered in `live` so cancelCues()
   * (mute, pause, restart, unmount) can stop it mid-beep.
   */
  lampBeep() {
    // a beep for a lamp lit while muted / before the gesture must not fire on unmute
    if (this.muted || this.ctx.state !== 'running') return
    const entry = scheduleBeep(this.ctx, this.beepWave, this.sfx, this.ctx.currentTime + LAMP_BEEP.lookahead)
    this.live.push(entry)
    entry.osc.onended = () => {
      const i = this.live.indexOf(entry)
      if (i >= 0) this.live.splice(i, 1)
      entry.osc.disconnect()
      entry.gain.disconnect()
    }
  }

  /** Stop any one-shot cue that is still sounding (restart, pause, mute, unmount). */
  cancelCues() {
    const now = this.ctx.currentTime
    for (const { osc, gain } of this.live) {
      // hold the current level before cancelling the envelope, or a decaying tone jumps back up
      const level = gain.gain.value
      gain.gain.cancelScheduledValues(now)
      gain.gain.setValueAtTime(level, now)
      gain.gain.setTargetAtTime(0, now, 0.01)
      try { osc.stop(now + 0.05) } catch { /* already stopped */ }
    }
    this.live = []
    this.swellTarget = 0
  }

  private createVoice(car: number, parent: THREE.Object3D): Voice {
    const audio = new THREE.PositionalAudio(this.listener)
    this.nodeCount += 2 // panner + gain inside PositionalAudio
    // three hardcodes HRTF; the low tier (software rendering) gets the cheap panner, set at
    // creation so there is no runtime model switch (which clicks)
    if (this.tier !== 'high') audio.panner.panningModel = 'equalpower'
    const n = buildEngineGraph(this.ctx, this.shared, this.mk)
    if (import.meta.dev) this.checkBudget()
    audio.setNodeSource(n.master as unknown as AudioBufferSourceNode)
    // master → [hp] → lp → panner: three wires the filter chain once (never per frame)
    audio.setFilters(n.hp ? [n.hp, n.lp] : [n.lp])
    audio.setRefDistance(9)
    audio.setRolloffFactor(1.5)
    audio.setDistanceModel('inverse')
    parent.add(audio)
    return { car, audio, n, s: newState(this.rng.range(0, TAU)), releaseAt: -1 }
  }

  /**
   * @param dt real-time seconds (automation runs on the wall clock whatever the sim speed)
   * @param cars per-car state (world position, velocity, rpm, throttle)
   * @param mode camera mode ('onboard' enables the wind layer)
   * @param race race status / start-sequence progress for the grid atmosphere
   */
  update(dt: number, cars: CarAudioState[], camera: THREE.Camera, mode: string, parent: THREE.Object3D, race: AudioRaceState) {
    if (this.muted || dt <= 0) return
    const ctx = this.ctx
    if (ctx.state !== 'running') return
    const camPos = camera.getWorldPosition(this._cam)
    this.listenerVel.copy(camPos).sub(this.listenerPrev).divideScalar(Math.max(dt, 1e-3))
    this.listenerPrev.copy(camPos)
    // camera cut guard scales with the sim speed (the camera rig moves faster when fast-forwarding)
    if (this.listenerVel.length() > 400 * Math.max(1, race.simSpeed)) this.listenerVel.set(0, 0, 0)
    const now = ctx.currentTime
    // nearest cars get voices (finite keys only: an Infinity/NaN sort key made the comparator unstable)
    const order = cars
      .map((c, i) => ({ i, d2: c.position.distanceToSquared(camPos) }))
      .sort((a, b) => a.d2 - b.d2)
      .slice(0, this.maxVoices)
      .map((o) => o.i)
    // release voices no longer needed, allocate for new cars; a released voice is not stolen in
    // the same frame so its fade-out (below) can finish before it snaps to the new car
    for (const v of this.voices) if (v.car >= 0 && !order.includes(v.car)) { v.car = -1; v.releaseAt = now }
    const snapped = new Set<Voice>()
    for (const i of order) {
      if (this.voices.some((v) => v.car === i)) continue
      const free = this.voices.find((v) => v.car === -1 && now - v.releaseAt > 0.12)
      if (free) {
        this.resetVoice(free, i, cars[i]!, now)
        snapped.add(free)
      } else if (this.voices.length < this.maxVoices) {
        const v = this.createVoice(i, parent)
        this.resetVoice(v, i, cars[i]!, now)
        this.voices.push(v)
        snapped.add(v)
      }
    }
    const resync = this.resync
    this.resync = false
    const env: DriveEnv = { now, dt, doppler: 1, dist: 1, onboard: false, snap: false, settle: false, rng: this.rng }
    for (const v of this.voices) {
      if (v.car < 0) {
        v.n.master.gain.setTargetAtTime(0, now, 0.05)
        continue
      }
      const c = cars[v.car]!
      v.audio.position.copy(c.position)
      // Doppler: component of the relative velocity along the line of sight
      const toListener = this._d.copy(camPos).sub(c.position)
      const dist = toListener.length() || 1
      toListener.divideScalar(dist)
      const vs = c.velocity.dot(toListener)
      const vl = this.listenerVel.dot(toListener)
      env.doppler = clamp((SPEED_OF_SOUND - vl) / Math.max(20, SPEED_OF_SOUND - vs), 0.72, 1.45)
      env.dist = dist
      env.onboard = mode === 'onboard' && dist < OWN_CAR_DIST
      env.snap = resync || snapped.has(v)
      // a voice that just changed car also jumps its smoothed state (throttle, boost, onboard timbre)
      env.settle = snapped.has(v)
      driveEngine(v.n, v.s, c, race, env)
    }
    // wind (onboard only), rising with the square of the speed
    if (this.wind) {
      const sel = cars.find((c) => c.running && c.position.distanceToSquared(camPos) < 9)
      const v = mode === 'onboard' && sel ? sel.v : 0
      this.wind.gain.gain.setTargetAtTime(Math.min(0.55, (v / 92) ** 2 * 0.5), now, 0.1)
      this.wind.filter.frequency.setTargetAtTime(300 + v * 12, now, 0.1)
    }
    // crowd: tension builds through the lamps, swells on cues, then relaxes over ~4 s
    this.swellHold -= dt
    if (this.swellHold <= 0) this.swellTarget = 0
    this.crowdSwell = lag(this.crowdSwell, this.swellTarget, this.swellTarget > this.crowdSwell ? 0.6 : 4.0, dt)
    const crowdBase = race.status === 'lights' ? 0.3 + 0.15 * clamp(race.lightsElapsed / 5, 0, 1) : 0.3
    const crowdGain = Math.min(0.85, crowdBase + 0.55 * this.crowdSwell)
    for (const bed of this.crowds) bed.gain.gain.setTargetAtTime(crowdGain, now, 0.1)
  }

  dispose() {
    for (const v of this.voices) {
      for (const o of v.n.osc) o.stop()
      v.n.hissSrc.stop()
      v.n.whine?.stop()
      v.n.popSrc?.stop()
      v.audio.removeFromParent()
    }
    for (const bed of this.crowds) bed.audio.removeFromParent()
    this.listener.removeFilter()
    this.listener.removeFromParent()
    void this.ctx.close()
    // three caches the native context in a module singleton: drop it so a remount / HMR gets a
    // fresh context instead of the closed one
    THREE.AudioContext.setContext(undefined as unknown as AudioContext)
  }
}
