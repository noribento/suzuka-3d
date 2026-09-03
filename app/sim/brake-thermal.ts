/**
 * Per-wheel brake-disc temperature model (°C). Pure and DOM-free so the Node harness
 * (`pnpm sim -- --brakes`) can run the same integrator as the renderer.
 *
 * Heat in: the braking energy per unit mass this step, dE = ½(v₀² − v₁²) (m²/s²), scaled by
 * `heat` (°C·s²/m²), which folds the front/rear brake bias (≈58 % front) and the disc's thermal
 * mass into one constant. Cooling: convection growing with airspeed, plus T⁴ radiation which is
 * what stops a 1000 °C disc running away. The step is a linearised exponential towards the
 * local equilibrium, unconditionally stable for the long frames a stalled tab produces.
 */

export const AMBIENT_C = 25
/** disc temperature on the grid after the formation lap */
export const GRID_DISC_C = 80
/** instant rise of a locked (sliding) wheel's disc at lock onset */
export const LOCK_SPIKE_C = 170
const MAX_C = 1400

export interface DiscThermal {
  /** °C per (m²/s²) of braking energy per unit mass */
  heat: number
  /** convective cooling rate at rest (1/s), scaled by (0.25 + v/90) */
  conv: number
  /** radiative constant (1/(s·K⁴)) — ≈15 °C/s of cooling at 1000 °C */
  rad: number
}

// tuned with `pnpm sim -- --brakes` (best car, flying laps): T1 ≈ 610, Hairpin ≈ 1030, Esses ≥ 620,
// back straight ≤ 280 °C; the rear carries ≈ 42 % of the braking energy
export const DISC_FRONT: DiscThermal = { heat: 0.18, conv: 0.08, rad: 5.7e-12 }
export const DISC_REAR: DiscThermal = { heat: 0.095, conv: 0.066, rad: 5.7e-12 }

/**
 * Advance one disc temperature by `dt` seconds.
 * @param T    current temperature (°C)
 * @param dE   braking energy per unit mass this step (m²/s², ≥ 0)
 * @param v    speed (m/s), for the convective term
 */
export function stepDiscTemp(T: number, dE: number, v: number, dt: number, k: DiscThermal): number {
  if (dt <= 0) return T
  const heat = (k.heat * dE) / dt
  const conv = k.conv * (0.25 + v / 90)
  const Tk = T + 273.15
  const Ta = AMBIENT_C + 273.15
  const rad = k.rad * (Tk ** 4 - Ta ** 4)
  // effective decay rate: convection plus the linearised radiation slope 4·k·T³
  const lam = conv + 4 * k.rad * Tk ** 3
  const teq = T + (heat - conv * (T - AMBIENT_C) - rad) / lam
  const n = T + (teq - T) * (1 - Math.exp(-lam * dt))
  return n < AMBIENT_C ? AMBIENT_C : n > MAX_C ? MAX_C : n
}
