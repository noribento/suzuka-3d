/**
 * The emissive budget of the scene, in one place.
 *
 * The bloom pass thresholds on REC709 *luminance* (UnrealBloomPass: `smoothstep(threshold,
 * threshold + 0.01, luminance)`), not on emissive intensity. Every emitter in the scene is a
 * saturated red or warm white, whose luminance is only 0.23–0.9 per unit of intensity, so the
 * values below are sized so that the things documented as glowing (start lights, hot brake
 * discs, sparks, the pit-garage strips) actually clear the threshold, and the things that
 * should merely be bright (a steady rain light, a warm disc) do not.
 *
 * Pure numbers, no three.js import: the table can be checked from Node
 * (`node --import ./scripts/ts-hooks.mjs -e "import('./app/three/emissive.ts')…"`).
 */

export type EmissiveTier = 'high' | 'low'

/**
 * UnrealBloomPass luminance threshold (post.ts).
 *
 * Ordering contract with the sun (app/three/sun-model.ts, asserted by scripts/sun-model-check.mjs):
 *
 *   kneed sky ≤ SKY_MAX 3.0 < BLOOM_THRESHOLD 4.5 < emitters ≤ ~17 < SUN_PROBE_MIN 30 < sun disc 41–58
 *
 * The sky never blooms, every emitter sized below still does, and only the disc trips the
 * sun-visibility probe — so nothing here may reach 30, and the disc may not drop below it.
 */
export const BLOOM_THRESHOLD = 4.5

/**
 * Width of the bloom high pass's smoothstep, in luminance.
 *
 * UnrealBloomPass's high pass GATES rather than subtracts —
 * `mix(black, texel, smoothstep(threshold, threshold + smoothWidth, luminance))` — and three
 * hard-codes `smoothWidth = 0.01`, which is a step function: a pixel at 4.51 contributes its
 * whole value and one at 4.49 contributes nothing. Every emitter below sits in a narrow band
 * just above the threshold, so a brake disc sweeping 400→1100 °C every braking zone popped its
 * entire halo into existence in one frame, and half a spark shower bloomed while the other half
 * did not. Widening the knee turns that into a ramp.
 *
 * Nothing below BLOOM_THRESHOLD blooms either way, so the `kneed sky ≤ SKY_MAX 3.0 < 4.5`
 * half of the contract is untouched. What the knee does add is a floor on the emitters:
 * scripts/sun-model-check.mjs asserts every intended emitter still clears half weight.
 */
export const BLOOM_KNEE = 2.5

/**
 * The low tier renders without bloom, so its emissives are scaled down: NeutralToneMapping
 * would otherwise clip the cores to white with no halo to carry the colour.
 */
export const EMISSIVE_SCALE: Record<EmissiveTier, number> = { high: 1, low: 0.4 }

let currentScale = 1
/** Select the tier once, before any emissive material is created. */
export function setEmissiveTier(tier: EmissiveTier) {
  currentScale = EMISSIVE_SCALE[tier]
}
/** Multiplier for every emissive intensity on the current tier. */
export function emissiveScale(): number {
  return currentScale
}

/** Draper blackbody ramp for a carbon-carbon brake disc: [°C, r, g, b] in linear RGB. */
export type BlackbodyStop = readonly [number, number, number, number]

export const EMISSIVE = {
  /** the five start-light pairs on the gantry */
  startLamp: { color: 0xff3a20, on: 26, bodyOn: 0xff2020, bodyOff: 0x3a0000 },
  /** rear rain light: steady when running in the wet, flashing under ERS harvesting / in the pit lane */
  rainLight: { color: 0xff2a1a, on: 8, flashHi: 30, flashLo: 0.3 },
  /** ceiling strips in the pit garages */
  garageStrip: { color: 0xfff2dd, intensity: 8 },
  /**
   * LED digital-flag panels at the marshal posts (EM Motorsport, 2018): green = track clear.
   * Luminance ≈ 0.8 — a visible glow that stays well below the bloom threshold on purpose.
   */
  digitalFlag: { color: 0x27d17a, intensity: 1.6 },
  /** titanium sparks off the plank: linear rgb per unit of "heat", heat drawn in [heatMin, heatMax] */
  spark: { rgb: [10, 3.8, 0.8] as const, heatMin: 0.75, heatMax: 1.4 },
  /**
   * Brake discs: colour from the blackbody ramp, intensity rising steeply with temperature.
   * Only discs above ~950 °C cross the bloom threshold (luminance 3.5 at 900 °C, 4.9 at 950,
   * 6.9 at 1000); cooler discs glow without a halo.
   */
  brakeDisc: {
    ramp: [
      [480, 1.0, 0.02, 0.0],
      [650, 1.0, 0.05, 0.0],
      [800, 1.0, 0.15, 0.01],
      [950, 1.0, 0.35, 0.04],
      [1100, 1.0, 0.62, 0.18],
      [1250, 1.0, 0.85, 0.45],
    ] as readonly BlackbodyStop[],
    glowStart: 480,
    peak: 20,
    intensity: (tempC: number): number => (tempC <= 480 ? 0 : Math.min(20, 12 * ((tempC - 480) / 500) ** 2)),
  },
} as const

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** REC709 luminance of a linear-RGB emissive at the given intensity. */
export function luminanceLinear(r: number, g: number, b: number, intensity = 1): number {
  return intensity * (0.2126 * r + 0.7152 * g + 0.0722 * b)
}

/** REC709 luminance of an sRGB hex colour (as three decodes it) at the given intensity. */
export function luminance(hex: number, intensity = 1): number {
  const r = srgbToLinear(((hex >> 16) & 255) / 255)
  const g = srgbToLinear(((hex >> 8) & 255) / 255)
  const b = srgbToLinear((hex & 255) / 255)
  return luminanceLinear(r, g, b, intensity)
}

/**
 * Linear-RGB colour of a brake disc at `tempC` (interpolated along the Draper ramp, clamped at
 * both ends), written into `out` as [r, g, b]. Returns the emissive intensity.
 */
export function brakeDiscEmissive(tempC: number, out: number[]): number {
  const ramp = EMISSIVE.brakeDisc.ramp
  const first = ramp[0]!
  const last = ramp[ramp.length - 1]!
  if (tempC <= first[0]) {
    out[0] = first[1]
    out[1] = first[2]
    out[2] = first[3]
  } else if (tempC >= last[0]) {
    out[0] = last[1]
    out[1] = last[2]
    out[2] = last[3]
  } else {
    let k = 1
    while (k < ramp.length - 1 && ramp[k]![0] < tempC) k++
    const a = ramp[k - 1]!
    const b = ramp[k]!
    const f = (tempC - a[0]) / (b[0] - a[0])
    out[0] = a[1] + (b[1] - a[1]) * f
    out[1] = a[2] + (b[2] - a[2]) * f
    out[2] = a[3] + (b[3] - a[3]) * f
  }
  return EMISSIVE.brakeDisc.intensity(tempC)
}
