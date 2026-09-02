import * as THREE from 'three'

/**
 * Procedural race audio — no samples. Each car is a small synth: three oscillators at the
 * V6 firing frequency (3 pulses per rev) and its harmonics, soft-clipped, shaped by two
 * resonant band-passes that open with the throttle, plus turbo hiss. Voices are positional
 * (three.js PositionalAudio) and Doppler-shifted by hand, since Web Audio dropped its own
 * Doppler. Only the nearest cars have live voices. An onboard wind layer and a crowd bed
 * complete the mix.
 */

const SPEED_OF_SOUND = 343
const MAX_VOICES = 10

interface Voice {
  car: number
  audio: THREE.PositionalAudio
  osc: OscillatorNode[]
  oscGain: GainNode[]
  formant: BiquadFilterNode[]
  formantGain: GainNode
  hiss: GainNode
  master: GainNode
  gear: number
  blip: number
}

export interface CarAudioState {
  position: THREE.Vector3
  velocity: THREE.Vector3
  rpm: number
  throttle: number
  gear: number
  v: number
  running: boolean
}

function makeNoise(ctx: AudioContext, seconds = 2): AudioBuffer {
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate)
  const d = buf.getChannelData(0)
  let b0 = 0, b1 = 0, b2 = 0
  for (let i = 0; i < d.length; i++) {
    // pink-ish noise (Paul Kellet's economy filter)
    const w = Math.random() * 2 - 1
    b0 = 0.99765 * b0 + w * 0.099046
    b1 = 0.963 * b1 + w * 0.2965164
    b2 = 0.57 * b2 + w * 1.0526913
    d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2
  }
  return buf
}

function softClipCurve(k = 3): Float32Array<ArrayBuffer> {
  const n = 1024
  const c = new Float32Array(new ArrayBuffer(n * 4))
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1
    c[i] = Math.tanh(k * x) / Math.tanh(k)
  }
  return c
}

export class RaceAudio {
  readonly listener: THREE.AudioListener
  private readonly ctx: AudioContext
  private readonly voices: Voice[] = []
  private readonly noise: AudioBuffer
  private readonly clip: Float32Array<ArrayBuffer>
  private wind: { gain: GainNode; filter: BiquadFilterNode } | null = null
  private crowd: THREE.PositionalAudio | null = null
  private readonly masterGain: GainNode
  private muted = false
  private readonly listenerPrev = new THREE.Vector3()
  private readonly listenerVel = new THREE.Vector3()
  private readonly _d = new THREE.Vector3()

  constructor(camera: THREE.Camera, crowdAt: THREE.Vector3, parent: THREE.Object3D) {
    this.listener = new THREE.AudioListener()
    camera.add(this.listener)
    this.ctx = this.listener.context
    this.noise = makeNoise(this.ctx)
    this.clip = softClipCurve(2.6)
    this.masterGain = this.listener.getInput() as unknown as GainNode
    // wind: non-positional, only audible onboard
    const windSrc = this.ctx.createBufferSource()
    windSrc.buffer = this.noise
    windSrc.loop = true
    const windFilter = this.ctx.createBiquadFilter()
    windFilter.type = 'lowpass'
    windFilter.frequency.value = 600
    const windGain = this.ctx.createGain()
    windGain.gain.value = 0
    windSrc.connect(windFilter).connect(windGain).connect(this.listener.getInput())
    windSrc.start()
    this.wind = { gain: windGain, filter: windFilter }
    // crowd bed at the main grandstand
    const crowd = new THREE.PositionalAudio(this.listener)
    const crowdSrc = this.ctx.createBufferSource()
    crowdSrc.buffer = this.noise
    crowdSrc.loop = true
    crowdSrc.playbackRate.value = 0.55
    const crowdFilter = this.ctx.createBiquadFilter()
    crowdFilter.type = 'bandpass'
    crowdFilter.frequency.value = 500
    crowdFilter.Q.value = 0.5
    const crowdGain = this.ctx.createGain()
    crowdGain.gain.value = 0.35
    crowdSrc.connect(crowdFilter).connect(crowdGain)
    crowd.setNodeSource(crowdGain as unknown as AudioBufferSourceNode)
    crowd.setRefDistance(60)
    crowd.setRolloffFactor(1.2)
    crowd.setDistanceModel('inverse')
    crowd.position.copy(crowdAt)
    parent.add(crowd)
    crowdSrc.start()
    this.crowd = crowd
    this.listenerPrev.copy(camera.getWorldPosition(new THREE.Vector3()))
  }

  /** Resume the context after a user gesture (autoplay policy). */
  resume() {
    if (this.ctx.state !== 'running') void this.ctx.resume()
  }

  setMuted(m: boolean) {
    this.muted = m
    this.listener.setMasterVolume(m ? 0 : 1)
  }

  private createVoice(car: number, parent: THREE.Object3D): Voice {
    const ctx = this.ctx
    const audio = new THREE.PositionalAudio(this.listener)
    const master = ctx.createGain()
    master.gain.value = 0
    const shaper = ctx.createWaveShaper()
    shaper.curve = this.clip
    shaper.oversample = '2x'
    const mix = ctx.createGain()
    mix.gain.value = 0.6
    const osc: OscillatorNode[] = []
    const oscGain: GainNode[] = []
    // fundamental (firing), 2nd harmonic, sub (crank), rough 3rd
    for (const [type, gain] of [['sawtooth', 0.55], ['square', 0.22], ['sawtooth', 0.3], ['triangle', 0.18]] as const) {
      const o = ctx.createOscillator()
      o.type = type
      const g = ctx.createGain()
      g.gain.value = gain
      o.connect(g).connect(mix)
      o.start()
      osc.push(o)
      oscGain.push(g)
    }
    // turbo / intake hiss
    const hissSrc = ctx.createBufferSource()
    hissSrc.buffer = this.noise
    hissSrc.loop = true
    hissSrc.playbackRate.value = 1.6
    const hissFilter = ctx.createBiquadFilter()
    hissFilter.type = 'highpass'
    hissFilter.frequency.value = 3500
    const hiss = ctx.createGain()
    hiss.gain.value = 0
    hissSrc.connect(hissFilter).connect(hiss).connect(master)
    hissSrc.start()
    // body: soft clip → two formant peaks in parallel + dry path
    mix.connect(shaper)
    const formant: BiquadFilterNode[] = []
    const formantGain = ctx.createGain()
    formantGain.gain.value = 0.4
    for (const f of [900, 2400]) {
      const bp = ctx.createBiquadFilter()
      bp.type = 'bandpass'
      bp.frequency.value = f
      bp.Q.value = 2.2
      shaper.connect(bp).connect(formantGain)
      formant.push(bp)
    }
    formantGain.connect(master)
    const dry = ctx.createGain()
    dry.gain.value = 0.45
    shaper.connect(dry).connect(master)
    audio.setNodeSource(master as unknown as AudioBufferSourceNode)
    audio.setRefDistance(9)
    audio.setRolloffFactor(1.5)
    audio.setDistanceModel('inverse')
    audio.setMaxDistance(1200)
    parent.add(audio)
    return { car, audio, osc, oscGain, formant, formantGain, hiss, master, gear: 0, blip: 0 }
  }

  /**
   * @param cars per-car state (world position, velocity, rpm, throttle)
   * @param mode camera mode ('onboard' enables the wind layer)
   */
  update(dt: number, cars: CarAudioState[], camera: THREE.Camera, mode: string, parent: THREE.Object3D) {
    if (this.muted || dt <= 0) return
    const ctx = this.ctx
    if (ctx.state !== 'running') return
    const camPos = camera.getWorldPosition(this._d)
    this.listenerVel.copy(camPos).sub(this.listenerPrev).divideScalar(Math.max(dt, 1e-3))
    this.listenerPrev.copy(camPos)
    if (this.listenerVel.length() > 400) this.listenerVel.set(0, 0, 0) // camera cut
    // nearest cars get voices
    const order = cars
      .map((c, i) => ({ i, d2: c.running ? c.position.distanceToSquared(camPos) : Infinity }))
      .sort((a, b) => a.d2 - b.d2)
      .slice(0, MAX_VOICES)
      .map((o) => o.i)
    // release voices no longer needed, allocate for new cars
    for (const v of this.voices) if (!order.includes(v.car)) v.car = -1
    for (const i of order) {
      if (this.voices.some((v) => v.car === i)) continue
      const free = this.voices.find((v) => v.car === -1)
      if (free) free.car = i
      else if (this.voices.length < MAX_VOICES) this.voices.push(this.createVoice(i, parent))
    }
    const now = ctx.currentTime
    const ramp = 0.05
    for (const v of this.voices) {
      if (v.car < 0) {
        v.master.gain.setTargetAtTime(0, now, ramp)
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
      const doppler = THREE.MathUtils.clamp((SPEED_OF_SOUND - vl) / Math.max(20, SPEED_OF_SOUND - vs), 0.5, 1.8)
      const rpm = Math.max(3500, c.rpm)
      const f = (rpm / 60) * 3 * doppler
      const targets = [f, f * 2, f * 0.5, f * 3.02]
      v.osc.forEach((o, k) => o.frequency.setTargetAtTime(targets[k]!, now, 0.03))
      // load: the formants open and the tone gets harder with the throttle
      const load = 0.35 + 0.65 * c.throttle
      v.formantGain.gain.setTargetAtTime(0.25 + 0.45 * load, now, ramp)
      v.formant[0]!.frequency.setTargetAtTime(700 + 500 * load, now, ramp)
      v.hiss.gain.setTargetAtTime(0.02 + 0.09 * c.throttle * (rpm / 12000), now, ramp)
      // gear change: brief cut like the ignition retard on an upshift
      if (c.gear !== v.gear) {
        v.gear = c.gear
        v.blip = 0.07
      }
      v.blip = Math.max(0, v.blip - dt)
      const idle = c.v < 0.5 ? 0.35 : 1
      const level = (0.5 + 0.5 * load) * idle * (v.blip > 0 ? 0.3 : 1)
      v.master.gain.setTargetAtTime(level * 0.9, now, 0.02)
    }
    // wind (onboard only), rising with the square of the speed
    if (this.wind) {
      const sel = cars.find((c) => c.running && c.position.distanceToSquared(camPos) < 9)
      const v = mode === 'onboard' && sel ? sel.v : 0
      this.wind.gain.gain.setTargetAtTime(Math.min(0.5, (v / 90) ** 2 * 0.45), now, 0.1)
      this.wind.filter.frequency.setTargetAtTime(300 + v * 12, now, 0.1)
    }
  }

  dispose() {
    for (const v of this.voices) {
      for (const o of v.osc) o.stop()
      v.audio.removeFromParent()
    }
    this.crowd?.removeFromParent()
    void this.ctx.close()
  }
}
