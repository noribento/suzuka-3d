/**
 * How the shadow cascades are fitted, in one place.
 *
 * Pure numbers, no three.js import — the same functions drive the runtime (scene.ts
 * `updateShadows`) and `scripts/shadow-fit-check.mjs`, which asserts from Node that the subject's
 * cascade actually resolves a car's shadow at every camera mode and distance.
 *
 * The thing worth knowing before changing any of this: `CSM._updateShadowBounds` sizes every
 * cascade as a rotation-invariant SQUARE whose side is the frustum's longest diagonal. For a
 * narrow lens the frustum is a pencil, so that diagonal is the cascade's *depth*. A cascade is
 * therefore only as sharp as it is thin, and where the subject sits in the split matters far more
 * than the shadow map's resolution: a 2° tv shot at 400 m sized its box to 425 m and rendered the
 * car at ~21 cm per texel, which no amount of 4096² would have fixed.
 */

/** Cascade split fractions of the main frustum, plus the half-depth of the subject slice. */
export interface Splits {
  s0: number
  s1: number
  /** half-depth of the slice the subject is bracketed by, metres (0 = not bracketed) */
  bracketW: number
}

/** Half-depth of the subject slice: 9 % of the subject distance, never below 10 m. */
export function bracketWidth(d: number): number {
  return Math.max(10, 0.09 * d)
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

/**
 * Split fractions for a follow camera.
 *
 * With three or more cascades the subject is BRACKETED by cascade 1 — a thin slice around it —
 * so cascade 0 keeps the near field and cascade 2 the background. With only two, a bracket would
 * leave everything past the subject to one `maxFar`-deep box, so the old wide split is kept and
 * the low tier takes its win from the per-cascade penumbra instead.
 */
export function followSplits(d: number, maxFar: number, cascades: number): Splits {
  if (cascades >= 3) {
    const bracketW = bracketWidth(d)
    const s0 = clamp((d - bracketW) / maxFar, 0.004, 0.88)
    const s1 = clamp((d + bracketW) / maxFar, s0 + 0.01, 0.9)
    return { s0, s1, bracketW }
  }
  return { s0: Math.min(0.5, (d + 25) / maxFar), s1: Math.min(0.85, (d + 150) / maxFar), bracketW: 0 }
}

/** Split fractions for the overview: a wide band around the orbit target. */
export function overviewSplits(d: number, maxFar: number): Splits {
  return { s0: Math.max(0.05, (d - 500) / maxFar), s1: Math.min(0.95, (d + 400) / maxFar), bracketW: 0 }
}

/** `maxFar` for the overview: the orbit distance plus enough to hold the far side of the circuit. */
export function overviewMaxFar(d: number): number {
  return Math.min(12000, d + 1800)
}

/**
 * ⅛-octave steps, rounded UP so a cascade never under-covers the live frustum.
 *
 * The tv rig's FOV is an exponential approach and so never settles, which made an exact
 * `camera.fov !== lastFov` test fire on essentially every frame and re-run `updateFrustums`. CSM
 * snaps the light centre to the shadow texel grid, but the texel size comes from the cascade
 * extents — so re-deriving the extents every frame gives a grid whose spacing changes every
 * frame, which is not a grid at all, and the shadow edges swim. Quantising costs at most 9 % of
 * a cascade's resolution and turns a 2°→40° zoom from ~600 refits into ~37.
 */
export function quantFov(fov: number): number {
  return 2 ** (Math.ceil(Math.log2(Math.max(fov, 1e-3)) * 8) / 8)
}

/**
 * Should the cascades be re-fitted for a subject now at `d`, given the slice they were last
 * fitted to (metres, from `s0 * maxFar` … `s1 * maxFar`)?
 *
 * Deriving the threshold from the fitted slice rather than from `bracketWidth(d)` is what keeps
 * it correct at the ends of the range: `followSplits` clamps `s1` at 0.9 so the background
 * cascade never degenerates, and near `maxFar` that leaves less room behind the subject than a
 * fixed fraction of the bracket would assume — the subject could then drift out of its own slice
 * before a refit fired. A margin inside the slice also gives the next fit somewhere to land.
 *
 * `NaN` bounds (nothing fitted yet) always refit.
 */
export function needsRefit(d: number, fitLo: number, fitHi: number): boolean {
  if (!(fitHi > fitLo)) return true
  const margin = (fitHi - fitLo) * 0.15
  return d < fitLo + margin || d > fitHi - margin
}

/**
 * World-space penumbra target for cascade `i`, metres.
 *
 * The sun subtends 0.533°, so a penumbra is 0.93 cm wide per metre of caster-to-receiver gap
 * measured ALONG the light — and that gap is `height / sin(elevation)`, which is why every edge
 * has to soften as the sun drops. `sunY` is the sun direction's y (already floored at 0.03 by
 * sunDirectionAt), and the 6× cap keeps a sunset from asking for a metre of blur.
 */
export function penumbraTarget(penumbraM: readonly number[], i: number, sunY: number): number {
  const base = penumbraM[i] ?? penumbraM[penumbraM.length - 1] ?? 0.02
  return base * clamp(1 / Math.max(sunY, 0.03), 1, 6)
}
