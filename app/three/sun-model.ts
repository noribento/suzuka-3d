import type { CameraMode } from '~/composables/useRaceStore'

/**
 * The sun as a *bounded* light source, in one place.
 *
 * three r185's Sky writes its solar disc at ≈3×10⁵ linear — past the half-float ceiling of
 * 65504, so the HDR scene target carries Inf — inside a Mie halo that stays above the bloom
 * threshold out to 11–15° from the sun. Pointed at it, UnrealBloomPass smears that into a
 * veil over half the frame and NeutralToneMapping clips the rest to white. The cure is to
 * bound the energy where it is produced and to let the camera react the way a camera does
 * (stop down, veil, streak) instead of adding energy on top. The ordering
 *
 *   kneed sky ≤ SKY_MAX 3.0 < BLOOM_THRESHOLD 4.5 < emitters ≤ ~17
 *                                                 < SUN_PROBE_MIN 30 < disc 41 (sunset) … 58 (midday)
 *
 * is the contract: the sky itself never blooms, every emitter sized in emissive.ts still does,
 * and nothing but the disc trips the sun-visibility probe. scripts/sun-model-check.mjs asserts
 * it from Node, which is why this module has no three.js import: the same numbers generate
 * the GLSL for the Sky patch (scene.ts) and the lens block of the grade pass (post.ts), and
 * drive the exposure adaptation.
 *
 * Units: radiance in linear scene units (≈1.0 for a sunlit white surface), angles in radians
 * unless the name says Deg, times in seconds, EV in stops (log2 of the exposure multiplier),
 * NDC in the −1…1 frame of the camera.
 */

// --- sky knee ---------------------------------------------------------------------------------
/** luminance up to which the sky is left untouched */
export const SKY_KNEE = 1.5
/** asymptote of the knee: the brightest the kneed sky (aureole included) can get */
export const SKY_MAX = 3.0

// --- disc and aureole -------------------------------------------------------------------------
/**
 * Disc radiance, linear. Added AFTER the knee and deliberately NOT extinguished by the
 * atmosphere: the low-sun disc must stay above SUN_PROBE_MIN and above every emitter, and the
 * warm colour already carries the sunset.
 */
export const SUN_DISC_RADIANCE = 60
/** angular radius of the sun, 0.2665° (r185 uses the full 0.533° diameter as a radius) */
export const SUN_DISC_RADIUS = 4.651e-3
/**
 * Half-width of the disc's soft rim per tier: ≈0.6 px on the 75° lens on the high tier (MSAA
 * and SMAA smooth it), ≈2 px on the low tier, which has neither and would shimmer with the
 * T-cam shake otherwise.
 */
export const SUN_DISC_SOFT = { high: 5e-4, low: 1.5e-3 } as const
/** peak of the circumsolar aureole at midday, before the knee (linear) */
export const AUREOLE_PEAK = 12
/** angular core of the aureole, 0.4°: L(θ) = peak · (1 + (θ/θ0)²)^-AUREOLE_EXP, a Buie-like θ⁻²·² tail */
export const AUREOLE_THETA0 = 6.98e-3
export const AUREOLE_EXP = 1.1
/** disc/aureole colour, linear RGB: white-warm at midday, orange at the horizon (lerped by `warm`) */
export const DISC_COLOR_HIGH = [1, 0.96, 0.88] as const
export const DISC_COLOR_LOW = [1, 0.62, 0.3] as const

// --- exposure -----------------------------------------------------------------------------------
export const EV_MIN = -1.2
export const EV_MAX = 0.2
/** stops the camera closes with the midday sun centred in the frame */
export const GLARE_EV = 0.5
/** extra stops at the horizon: the low sun sits in the picture, not above it */
export const GLARE_EV_LOW_SUN = 0.6
/** adaptation time constants: the iris closes fast and opens slowly, like an auto-exposure */
export const TAU_DARKEN = 0.25
export const TAU_BRIGHTEN = 0.8
/** the tv camera's operator-driven iris is slower both ways */
export const TAU_TV = 1.5
/** smoothing of the sun-visibility probe (it lags the picture by a frame or two anyway) */
export const TAU_VIS = 0.12
/** a camera displacement above this between two frames is a cut: the adaptation snaps */
export const CUT_JUMP_M = 40
/** sun-in-frame weight: full inside |ndc| SUN_FRAME_FADE, gone from SUN_FRAME_EDGE */
export const SUN_FRAME_FADE = 0.9
export const SUN_FRAME_EDGE = 1.3
/** the centre weighting eases in over cos(angle to the view axis) from 0 to this */
export const SUN_CENTRE_COS = 0.7
/** the glare (and the flare) fade out as the sun reaches the horizon (sunDirection.y is clamped at 0.03 there) */
export const ELEVATION_LO = 0.02
export const ELEVATION_HI = 0.08

// --- post chain ---------------------------------------------------------------------------------
/** ceiling of the sanitized scene copy that feeds bloom (linear) */
export const HDR_MAX = 1024
/** luminance a probe tap must exceed to count as the sun on the log-depth path: above every emitter, below the disc */
export const SUN_PROBE_MIN = 30
/** the depth probe looks ± this many degrees around the sun (5×5 taps) */
export const SUN_PROBE_HALF_ANGLE_DEG = 0.6
/** the luminance probe's 3×3 taps sit within this fraction of the disc radius */
export const SUN_PROBE_DISC_FRACTION = 0.6
/** reversed-Z depth at or below this is the clear value — nothing was drawn over the sky (the 1.9 km tree ring already reads 2.6e-4) */
export const SUN_PROBE_FAR_DEPTH = 1e-6
/** the probe measures only with its whole tap window inside the frame */
export const SUN_PROBE_EDGE = 0.95
/** frames to wait after a failed readback before trying again */
export const SUN_PROBE_BACKOFF_FRAMES = 30
/** the streak and the ghosts live inside this NDC box (fading from SUN_FRAME_FADE); the veil persists to VEIL_FAR */
export const FLARE_BOX = 1.35
export const VEIL_FAR = 3.0
/** Stiles–Holladay veiling glare A/(1 + θ²/θ0²): peak (linear) and angular half-width (degrees) */
export const VEIL_PEAK = 0.22
export const VEIL_THETA0_DEG = 6
/** horizontal streak: Gaussian σ in frame heights, cosine falloff to ± this fraction of the frame width, gain */
export const STREAK_SIGMA = 0.0025
export const STREAK_HALF_WIDTH = 0.6
export const STREAK_GAIN = 0.3
/** the iris shrinks the ghosts as the camera stops down: size × (0.75 + 0.25 · 2^ev) */
export const FLARE_SCALE_MIN = 0.75

export interface Ghost {
  /** position on the sun → frame-centre axis: 0 at the sun, 1 at the centre, > 1 beyond */
  t: number
  /** radius as a fraction of the frame height */
  size: number
  /** peak added radiance, linear */
  gain: number
  /** thin ring instead of a soft disc */
  ring: boolean
  /** linear RGB tint */
  tint: readonly [number, number, number]
}

/** internal reflections of the lens elements, laid out along the sun → centre line */
export const GHOSTS: readonly Ghost[] = [
  { t: 0.35, size: 0.03, gain: 0.05, ring: false, tint: [1, 0.75, 0.5] },
  { t: 0.6, size: 0.07, gain: 0.08, ring: true, tint: [0.5, 0.85, 1] },
  { t: 0.95, size: 0.12, gain: 0.06, ring: true, tint: [0.9, 0.6, 0.9] },
  { t: 1.4, size: 0.05, gain: 0.04, ring: false, tint: [1, 0.85, 0.6] },
]

export interface FlareGain {
  streak: number
  ghost: number
  veil: number
}

/**
 * How much each rig flares: a T-cam behind a scuffed cover streaks and ghosts, a hooded box
 * lens hardly does, a gyro-stabilised heli ball less, and the map-like overview not at all.
 * Indexed by CameraMode so the type carries 'director' even though the rig resolves it to a
 * concrete shot before it reaches the post chain.
 */
export const FLARE_GAIN: Record<CameraMode, FlareGain> = {
  onboard: { streak: 1, ghost: 1, veil: 1 },
  chase: { streak: 0.5, ghost: 0.6, veil: 0.8 },
  tv: { streak: 0.3, ghost: 0.8, veil: 0.6 },
  heli: { streak: 0, ghost: 0.3, veil: 0.4 },
  overview: { streak: 0, ghost: 0, veil: 0 },
  director: { streak: 0.5, ghost: 0.6, veil: 0.8 },
}

// --- pure functions -------------------------------------------------------------------------------

/** GLSL's smoothstep (edge0, edge1, x); NaN maps to 0. */
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = (x - e0) / (e1 - e0)
  if (!(t > 0)) return 0
  if (t >= 1) return 1
  return t * t * (3 - 2 * t)
}

/** REC709 luminance of a linear RGB triple. */
export function luminance709(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * Soft knee on luminance: identity up to SKY_KNEE, then SKY_MAX − d²/(e + d) with
 * e = L − SKY_KNEE and d = SKY_MAX − SKY_KNEE (continuous with unit slope at the knee,
 * asymptote SKY_MAX). Written so that Inf and NaN land on the asymptote instead of propagating —
 * `!(L < 1e30)` rather than isnan, because the low tier compiles the GLSL twin on SwiftShader.
 */
export function kneeLuminance(L: number): number {
  if (!(L < 1e30)) return SKY_MAX
  // negatives (the GLSL twin clamps the colour at 0 first) pass through as 0
  if (L <= SKY_KNEE) return L > 0 ? L : 0
  const e = L - SKY_KNEE
  const d = SKY_MAX - SKY_KNEE
  return SKY_MAX - (d * d) / (e + d)
}

/** The knee applied to a colour, hue-preserving (every channel scaled by L'/L). */
export function skyKnee(c: readonly [number, number, number]): [number, number, number] {
  const r = Math.max(c[0], 0), g = Math.max(c[1], 0), b = Math.max(c[2], 0)
  const L = luminance709(r, g, b)
  if (!(L < 1e30)) return [SKY_MAX, SKY_MAX, SKY_MAX]
  if (L <= SKY_KNEE) return [r, g, b]
  const k = kneeLuminance(L) / L
  return [r * k, g * k, b * k]
}

function warmth01(warm: number): number {
  return Number.isFinite(warm) ? Math.min(1, Math.max(0, warm)) : 1
}

/** Exposure for the time of day (`warm` 1 = midday, 0 = sunset), before the sun-facing adaptation. */
export function baseExposure(warm: number): number {
  return 0.92 * (0.82 + 0.18 * warmth01(warm))
}

/** Disc/aureole colour for the time of day, linear RGB. */
export function discColour(warm: number): [number, number, number] {
  const w = warmth01(warm)
  return [
    DISC_COLOR_LOW[0] + (DISC_COLOR_HIGH[0] - DISC_COLOR_LOW[0]) * w,
    DISC_COLOR_LOW[1] + (DISC_COLOR_HIGH[1] - DISC_COLOR_LOW[1]) * w,
    DISC_COLOR_LOW[2] + (DISC_COLOR_HIGH[2] - DISC_COLOR_LOW[2]) * w,
  ]
}

/** Aureole peak for the time of day: the low sun's halo is brighter relative to the sky. */
export function aureolePeak(warm: number): number {
  return AUREOLE_PEAK * (1 + 0.3 * (1 - warmth01(warm)))
}

/** 0 with the sun on the horizon, 1 above ELEVATION_HI (sunDirection.y is the sine of the elevation). */
export function elevationWeight(sunY: number): number {
  return smoothstep(ELEVATION_LO, ELEVATION_HI, sunY)
}

/**
 * How much the sun is "in the shot" for the exposure: 0 behind the camera, 0 outside the
 * SUN_FRAME_EDGE box, fading in from SUN_FRAME_FADE, weighted towards the centre of the frame.
 * NaN NDC (a degenerate projection) counts as out of frame.
 */
export function sunFrameWeight(ndcX: number, ndcY: number, cosFwd: number): number {
  if (!(cosFwd > 0)) return 0
  const edge = Math.max(Math.abs(ndcX), Math.abs(ndcY))
  if (!(edge < SUN_FRAME_EDGE)) return 0
  return (1 - smoothstep(SUN_FRAME_FADE, SUN_FRAME_EDGE, edge)) * smoothstep(0, SUN_CENTRE_COS, cosFwd)
}

/** Streak/ghost weight from the sun's NDC edge distance: 1 in frame, 0 from FLARE_BOX. */
export function sunFade(edge: number): number {
  return Number.isFinite(edge) ? 1 - smoothstep(SUN_FRAME_FADE, FLARE_BOX, edge) : 0
}

/** Veil weight: still 1 at the FLARE_BOX, gone by VEIL_FAR — a lens keeps veiling with the sun just outside the picture. */
export function sunNear(edge: number): number {
  return Number.isFinite(edge) ? 1 - smoothstep(FLARE_BOX, VEIL_FAR, edge) : 0
}

export function clampEv(ev: number): number {
  if (!Number.isFinite(ev)) return 0
  return Math.min(EV_MAX, Math.max(EV_MIN, ev))
}

/** Target exposure offset in stops for the current sun weight, probe visibility and time of day. */
export function glareTargetEv(weight: number, vis: number, warm: number): number {
  const w = (Number.isFinite(weight) ? Math.min(1, Math.max(0, weight)) : 0) * (Number.isFinite(vis) ? Math.min(1, Math.max(0, vis)) : 1)
  return clampEv(-(GLARE_EV + GLARE_EV_LOW_SUN * (1 - warmth01(warm))) * w)
}

const TAU_PAIR = Object.freeze({ darken: TAU_DARKEN, brighten: TAU_BRIGHTEN })
const TAU_PAIR_TV = Object.freeze({ darken: TAU_TV, brighten: TAU_TV })

/** Adaptation time constants for a camera mode (null = unknown, e.g. the low tier without a post chain). */
export function adaptTau(mode: CameraMode | null): { readonly darken: number; readonly brighten: number } {
  return mode === 'tv' ? TAU_PAIR_TV : TAU_PAIR
}

/**
 * One frame of exposure adaptation: an exponential approach with the darkening or the
 * brightening time constant. Always returns a finite value inside [EV_MIN, EV_MAX], whatever
 * comes in (a NaN state re-seeds from the target, a huge or negative dt is clamped to 0..1 s).
 */
export function adaptEv(ev: number, target: number, dt: number, tauDarken = TAU_DARKEN, tauBrighten = TAU_BRIGHTEN): number {
  const t = clampEv(target)
  if (!Number.isFinite(ev)) return t
  const step = Number.isFinite(dt) ? Math.min(1, Math.max(0, dt)) : 0
  const tau = t < ev ? tauDarken : tauBrighten
  const k = 1 - Math.exp(-step / Math.max(tau, 1e-3))
  return clampEv(ev + (t - ev) * k)
}

/** Probe visibility smoothing (TAU_VIS), clamped to 0..1 and NaN-safe like adaptEv. */
export function smoothVis(vis: number, raw: number, dt: number): number {
  const r = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 1
  if (!Number.isFinite(vis)) return r
  const step = Number.isFinite(dt) ? Math.min(1, Math.max(0, dt)) : 0
  const k = 1 - Math.exp(-step / TAU_VIS)
  return Math.min(1, Math.max(0, vis + (r - vis) * k))
}

/** Ghost size multiplier for the adapted exposure: the iris closes, the reflections shrink. */
export function flareScale(ev: number): number {
  return FLARE_SCALE_MIN + (1 - FLARE_SCALE_MIN) * 2 ** clampEv(ev)
}

// --- GLSL -----------------------------------------------------------------------------------------

/** A number as a GLSL float literal (`3` would be an int and fail to compile). */
export function glslFloat(v: number): string {
  const s = String(v)
  return /[.e]/.test(s) ? s : `${s}.0`
}

const glslConst = (name: string, v: number) => `const float ${name} = ${glslFloat(v)};`

/** first line of the Sky fragment shader's main(): the declarations go in front of it */
export const SKY_MAIN_ANCHOR = 'void main() {'
/** the line of Sky.js that writes the sky: replaced by SUN_GLSL_SUN */
export const SKY_FRAG_ANCHOR = 'gl_FragColor = vec4( texColor, 1.0 );'

/** Uniforms, constants and the knee, prepended to the Sky fragment shader. */
export const SUN_GLSL_PARS = /* glsl */ `
	// --- bounded sun (app/three/sun-model.ts; the constants are generated from the TS exports) ---
	uniform float uDiscRadiance;
	uniform vec3 uDiscColor;
	uniform float uAureolePeak;
	uniform float uDiscSoft;
	${glslConst('SUN_DISC_RADIUS', SUN_DISC_RADIUS)}
	${glslConst('AUREOLE_THETA0', AUREOLE_THETA0)}
	${glslConst('AUREOLE_EXP', AUREOLE_EXP)}
	${glslConst('SKY_KNEE', SKY_KNEE)}
	${glslConst('SKY_MAX', SKY_MAX)}
	// Hue-preserving soft knee on luminance: identity below SKY_KNEE, then SKY_MAX - d*d/(e + d)
	// (e = L - SKY_KNEE, d = SKY_MAX - SKY_KNEE: unit slope at the knee, asymptote SKY_MAX).
	// Inf/NaN land on the asymptote; no isnan() because the low tier compiles this on SwiftShader.
	vec3 skyKnee( vec3 c ) {
		c = max( c, vec3( 0.0 ) );
		float L = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
		if ( !( L < 1e30 ) ) return vec3( SKY_MAX );
		if ( L <= SKY_KNEE ) return c;
		float e = L - SKY_KNEE;
		float d = SKY_MAX - SKY_KNEE;
		return c * ( ( SKY_MAX - d * d / ( e + d ) ) / L );
	}
`

/**
 * Replacement for SKY_FRAG_ANCHOR. `texColor` is the sky in post-×0.04 units, `direction` the
 * view ray and `vSunDirection` the sun (both unit): aureole → knee → disc, then the write.
 */
export const SUN_GLSL_SUN = /* glsl */ `// --- bounded sun (app/three/sun-model.ts) ---
			// chord |direction - sun|: the angle to the sun at these sizes, with ~1e-7 relative precision
			// where cosTheta near 1.0 has only a handful of float32 ulps to describe the disc
			float sunChord = length( direction - vSunDirection );
			// warm circumsolar aureole (Buie-like power-law tail) BEFORE the knee: bounded together with the sky
			float aureole = uAureolePeak * pow( 1.0 + sunChord * sunChord / ( AUREOLE_THETA0 * AUREOLE_THETA0 ), -AUREOLE_EXP );
			texColor += aureole * uDiscColor;
			texColor = skyKnee( texColor );
			// the disc AFTER the knee, in the same units as texColor (after the * 0.04 above): SUN_DISC_RADIANCE
			// linear, not extinguished by Fex, so it stays above every emitter and the visibility probe
			float sunDisc = 1.0 - smoothstep( SUN_DISC_RADIUS - uDiscSoft, SUN_DISC_RADIUS + uDiscSoft, sunChord );
			texColor += uDiscRadiance * sunDisc * uDiscColor;
			gl_FragColor = vec4( texColor, 1.0 );`

/** Uniforms, constants and the ghost shape for the grade pass. */
export const SUN_GLSL_FLARE_PARS = /* glsl */ `
    // --- sun flare (app/three/sun-model.ts) ---
    uniform float uSunWeight;   // lens gate: > 0 with the sun in front, above the horizon and inside |ndc| VEIL_FAR
    uniform float uSunFade;     // 1 in frame, 0 from |ndc| FLARE_BOX (streak + ghosts)
    uniform float uSunVis;      // probe visibility 0..1
    uniform vec2 uSunNdc;
    uniform vec3 uSunDir;       // view space, unit
    uniform vec3 uSunColor;     // disc colour, linear
    uniform float uTanHalfFov;
    uniform float uAspect;
    uniform float uFlareScale;  // ghost size multiplier (iris)
    uniform float uStreakGain;  // per-mode gains (FLARE_GAIN)
    uniform float uGhostGain;
    uniform float uVeilGain;
    ${glslConst('VEIL_PEAK', VEIL_PEAK)}
    ${glslConst('VEIL_THETA0_DEG', VEIL_THETA0_DEG)}
    ${glslConst('STREAK_SIGMA', STREAK_SIGMA)}
    ${glslConst('STREAK_HALF_WIDTH', STREAK_HALF_WIDTH)}
    ${glslConst('STREAK_GAIN', STREAK_GAIN)}

    // soft disc (ring = 0) or thin ring (ring = 1) of unit radius; q = distance / radius
    float ghostShape(float q, float ring) {
      float disc = 1.0 - smoothstep(0.6, 1.0, q);
      float rim = smoothstep(0.55, 0.8, q) * (1.0 - smoothstep(0.9, 1.0, q));
      return mix(disc, rim, ring);
    }
`

const ghostLines = GHOSTS.map(
  (g) =>
    `        { vec2 g = suv + toCentre * ${glslFloat(g.t)}; float q = length((vUv - g) * vec2(uAspect, 1.0)) / (${glslFloat(g.size)} * uFlareScale); ` +
    `c += vec3(${g.tint.map(glslFloat).join(', ')}) * (${glslFloat(g.gain)} * ghostShape(q, ${g.ring ? '1.0' : '0.0'})) * kg; }`,
).join('\n')

/**
 * The lens block of the grade pass, on `c` (linear, before the vignette). Everything sits
 * behind a uniform branch so a frame without the sun pays nothing.
 */
export const SUN_GLSL_FLARE = /* glsl */ `
      if (uSunWeight > 0.0) {
        // view-space ray of this pixel (pinhole: x = ndc.x * tan(hfov/2), y = ndc.y * tan(vfov/2), z = -1)
        vec2 ndc = vUv * 2.0 - 1.0;
        vec3 ray = normalize(vec3(ndc * vec2(uTanHalfFov * uAspect, uTanHalfFov), -1.0));
        // angle to the sun squared, in deg²: 2(1 - cos θ) = θ² to 1 % out to 40°; (180/π)² = 3282.8
        float th2 = 2.0 * max(0.0, 1.0 - dot(ray, uSunDir)) * 3282.806;
        // Stiles-Holladay veiling glare A / (1 + θ²/θ0²): light scattered inside the lens over the whole
        // frame, still there with the sun just outside the picture (uSunWeight fades over |ndc| 1.35 → 3)
        float lens = uSunVis * uSunWeight;
        c += uSunColor * (VEIL_PEAK / (1.0 + th2 / (VEIL_THETA0_DEG * VEIL_THETA0_DEG))) * uVeilGain * lens;
        if (uSunFade > 0.0) {
          float k = uSunVis * uSunFade;
          vec2 suv = uSunNdc * 0.5 + 0.5;
          // horizontal streak: a thin Gaussian through the sun (σ in frame heights) with a cosine falloff
          // to ± STREAK_HALF_WIDTH of the frame width — the anamorphic line of a scuffed T-cam cover
          float dy = (vUv.y - suv.y) / STREAK_SIGMA;
          float dx = min(abs(vUv.x - suv.x) / STREAK_HALF_WIDTH, 1.0);
          float streak = exp(-0.5 * dy * dy) * cos(dx * 1.5707963);
          c += uSunColor * (STREAK_GAIN * streak) * uStreakGain * k;
          // ghosts on the sun → frame-centre axis (t = 0 at the sun, 1 at the centre); sizes are fractions
          // of the frame height, shrunk with the iris as the camera stops down (uFlareScale)
          vec2 toCentre = vec2(0.5) - suv;
          float kg = uGhostGain * k;
${ghostLines}
        }
      }
`
