import { expect, test } from '@playwright/test'
import { openRace } from './helpers'

/**
 * Spectral regression test for the procedural engine: one voice is rendered offline through
 * RaceAudio.renderProbe (OfflineAudioContext — no gesture, no GPU, so it runs under the same
 * SwiftShader config as the rest of the suite) and analysed in the page with a radix-2 FFT.
 * The numbers printed serve as the listening-independent baseline for "lower and heavier".
 */

interface Bands {
  tier: 'low' | 'high'
  low: number
  mid: number
  high: number
  peakHz: number
  rmsDb: number
  /** strongest bin in 5–7 kHz and its level above the median of that range (MGU-K line) */
  mguk: { hz: number; aboveMedianDb: number }
}

interface ProbeParams {
  rpm: number
  throttle: number
  brake?: number
  v?: number
  onboard?: boolean
  dist?: number
  status?: 'grid' | 'racing'
  seconds?: number
}

async function probe(page: Parameters<typeof openRace>[0], p: ProbeParams): Promise<Bands> {
  return page.evaluate(async (p) => {
    const dbg = (window as unknown as { __suzuka: { ctx: { tier: 'low' | 'high' }; RaceAudio: { renderProbe(p: object): Promise<Float32Array> } } }).__suzuka
    const tier = dbg.ctx.tier
    const samples = await dbg.RaceAudio.renderProbe({ tier, ...p })
    const sr = 48000
    // N = 8192 Hann frames, hop N/2, averaged over the last 1.5 s
    const N = 8192
    const hann = new Float32Array(N)
    for (let i = 0; i < N; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1))
    const re = new Float32Array(N)
    const im = new Float32Array(N)
    const power = new Float64Array(N / 2)
    const start = Math.max(0, samples.length - Math.floor(sr * 1.5))
    let frames = 0
    for (let off = start; off + N <= samples.length; off += N / 2) {
      for (let i = 0; i < N; i++) {
        re[i] = samples[off + i]! * hann[i]!
        im[i] = 0
      }
      for (let i = 1, j = 0; i < N; i++) {
        let bit = N >> 1
        for (; j & bit; bit >>= 1) j ^= bit
        j ^= bit
        if (i < j) {
          let t = re[i]!
          re[i] = re[j]!
          re[j] = t
          t = im[i]!
          im[i] = im[j]!
          im[j] = t
        }
      }
      for (let len = 2; len <= N; len <<= 1) {
        const ang = (-2 * Math.PI) / len
        const wr = Math.cos(ang)
        const wi = Math.sin(ang)
        for (let i = 0; i < N; i += len) {
          let cr = 1
          let ci = 0
          for (let k = 0; k < len / 2; k++) {
            const a = i + k
            const b = i + k + len / 2
            const tr = re[b]! * cr - im[b]! * ci
            const ti = re[b]! * ci + im[b]! * cr
            re[b] = re[a]! - tr
            im[b] = im[a]! - ti
            re[a] = re[a]! + tr
            im[a] = im[a]! + ti
            const ncr = cr * wr - ci * wi
            ci = cr * wi + ci * wr
            cr = ncr
          }
        }
      }
      for (let k = 0; k < N / 2; k++) power[k] = power[k]! + re[k]! * re[k]! + im[k]! * im[k]!
      frames++
    }
    const hz = (k: number) => (k * sr) / N
    let low = 0
    let mid = 0
    let high = 0
    let peakK = 1
    const range: number[] = []
    let lineK = 0
    for (let k = 1; k < N / 2; k++) {
      const f = hz(k)
      const pk = power[k]!
      if (f < 500) low += pk
      else if (f < 2000) mid += pk
      else high += pk
      if (pk > power[peakK]!) peakK = k
      if (f >= 5000 && f <= 7000) {
        range.push(pk)
        if (!lineK || pk > power[lineK]!) lineK = k
      }
    }
    const dB = (x: number) => 10 * Math.log10(x / Math.max(1, frames) + 1e-20)
    let rms = 0
    for (let i = start; i < samples.length; i++) rms += samples[i]! * samples[i]!
    rms = Math.sqrt(rms / Math.max(1, samples.length - start))
    range.sort((a, b) => a - b)
    const median = range[Math.floor(range.length / 2)] ?? 1e-20
    return {
      tier,
      low: dB(low),
      mid: dB(mid),
      high: dB(high),
      peakHz: hz(peakK),
      rmsDb: 20 * Math.log10(rms + 1e-12),
      mguk: { hz: hz(lineK), aboveMedianDb: 10 * Math.log10((power[lineK]! + 1e-20) / (median + 1e-20)) },
    }
  }, p)
}

test.describe('procedural engine audio', () => {
  test('is lower and heavier, audible on the grid and deterministic', async ({ page }) => {
    test.setTimeout(240_000)
    const issues = await openRace(page)

    // 10 000 rpm, full load, trackside at 10 m: the firing order (500 Hz) leads and the weight is below it
    const full = await probe(page, { rpm: 10000, throttle: 1, dist: 10 })
    console.log(`[audio] tier ${full.tier} full load: low ${full.low.toFixed(1)} mid ${full.mid.toFixed(1)} high ${full.high.toFixed(1)} dB, peak ${full.peakHz.toFixed(0)} Hz, rms ${full.rmsDb.toFixed(1)} dBFS`)
    expect(full.low - full.high).toBeGreaterThanOrEqual(8)
    expect(full.low - full.mid).toBeGreaterThanOrEqual(-3)
    expect(full.peakHz).toBeGreaterThanOrEqual(485)
    expect(full.peakHz).toBeLessThanOrEqual(515)

    // the grid idles audibly (lope around 4300 rpm → peak near 215 Hz)
    const grid = await probe(page, { rpm: 0, throttle: 0, status: 'grid', v: 0, dist: 10, seconds: 4 })
    console.log(`[audio] grid idle: rms ${grid.rmsDb.toFixed(1)} dBFS, peak ${grid.peakHz.toFixed(0)} Hz`)
    expect(grid.rmsDb).toBeGreaterThan(-40)

    // MGU-K harvest whine under braking at 80 m/s: a line near 1500 + 5500 * 80/95 ≈ 6.1 kHz,
    // measured against the same engine state without braking (high tier only: the low tier has no whine)
    if (full.tier === 'high') {
      const braking = await probe(page, { rpm: 9000, throttle: 0, brake: 1, v: 80, dist: 10 })
      const coasting = await probe(page, { rpm: 9000, throttle: 0, brake: 0, v: 80, dist: 10 })
      console.log(`[audio] MGU-K: line ${braking.mguk.hz.toFixed(0)} Hz, +${braking.mguk.aboveMedianDb.toFixed(1)} dB (no brake +${coasting.mguk.aboveMedianDb.toFixed(1)} dB)`)
      expect(Math.abs(braking.mguk.hz - 6130)).toBeLessThan(150)
      expect(braking.mguk.aboveMedianDb - coasting.mguk.aboveMedianDb).toBeGreaterThanOrEqual(10)
    }

    // seeded noise and jitter: two renders are identical
    const again = await probe(page, { rpm: 10000, throttle: 1, dist: 10 })
    expect(Math.abs(again.low - full.low)).toBeLessThan(0.01)
    expect(Math.abs(again.mid - full.mid)).toBeLessThan(0.01)
    expect(Math.abs(again.high - full.high)).toBeLessThan(0.01)

    // start-light beep (F1-game convention): 1.5 kHz, ~100 ms, dry, identical every time.
    // Goertzel on the 30 ms plateau resolves ~33 Hz, hence the ±40 Hz tolerance.
    const beep = await page.evaluate(async () => {
      const dbg = (window as unknown as { __suzuka: { RaceAudio: { renderBeep(): Promise<Float32Array> } } }).__suzuka
      const sr = 48000
      const a = await dbg.RaceAudio.renderBeep()
      const b = await dbg.RaceAudio.renderBeep()
      const goertzel = (x: Float32Array, from: number, to: number, hz: number) => {
        const k = (2 * Math.PI * hz) / sr
        const c = 2 * Math.cos(k)
        let s0 = 0, s1 = 0, s2 = 0
        for (let i = from; i < to; i++) {
          s0 = x[i]! + c * s1 - s2
          s2 = s1
          s1 = s0
        }
        return s1 * s1 + s2 * s2 - c * s1 * s2
      }
      let peak = 0
      for (let i = 0; i < a.length; i++) peak = Math.max(peak, Math.abs(a[i]!))
      const from = Math.floor(0.025 * sr), to = Math.floor(0.055 * sr)
      let peakHz = 0, best = -1
      for (let hz = 1000; hz <= 2200; hz += 10) {
        const p = goertzel(a, from, to, hz)
        if (p > best) { best = p; peakHz = hz }
      }
      const h2Db = 10 * Math.log10(goertzel(a, from, to, 2 * peakHz) / best)
      const span = (frac: number) => {
        let first = -1, last = -1
        for (let i = 0; i < a.length; i++) if (Math.abs(a[i]!) > peak * frac) { if (first < 0) first = i; last = i }
        return ((last - first) / sr) * 1000
      }
      let tailMax = 0
      for (let i = Math.floor(0.16 * sr); i < a.length; i++) tailMax = Math.max(tailMax, Math.abs(a[i]!))
      let diff = 0
      for (let i = 0; i < a.length; i++) diff = Math.max(diff, Math.abs(a[i]! - b[i]!))
      return { peak, peakHz, h2Db, span40Ms: span(0.01), span60Ms: span(0.001), tailMax, diff }
    })
    console.log(`[audio] lamp beep: ${beep.peakHz} Hz, peak ${beep.peak.toFixed(3)}, H2 ${beep.h2Db.toFixed(1)} dB, -40 dB span ${beep.span40Ms.toFixed(0)} ms, -60 dB span ${beep.span60Ms.toFixed(0)} ms, tail ${beep.tailMax.toExponential(1)}`)
    expect(Math.abs(beep.peakHz - 1500)).toBeLessThan(40)
    expect(beep.peak).toBeGreaterThanOrEqual(0.27)
    expect(beep.peak).toBeLessThanOrEqual(0.33)
    expect(beep.h2Db).toBeGreaterThanOrEqual(-18)
    expect(beep.h2Db).toBeLessThanOrEqual(-10)
    expect(beep.span40Ms).toBeGreaterThanOrEqual(70)
    expect(beep.span40Ms).toBeLessThanOrEqual(100)
    expect(beep.span60Ms).toBeGreaterThanOrEqual(90)
    expect(beep.span60Ms).toBeLessThanOrEqual(125)
    expect(beep.tailMax).toBeLessThan(1e-4)
    expect(beep.diff).toBe(0)

    expect(issues.errors, issues.errors.join('\n')).toEqual([])
  })
})
