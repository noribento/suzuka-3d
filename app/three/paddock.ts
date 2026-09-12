import type * as THREE from 'three'
import type { EnvBuildContext } from './environment'

/**
 * The paddock behind the pit building (plan I2): the team-office row, the centre house, the
 * fences and gates, the car parks. Phase I0 lands the entry point only — the umbrella
 * (infield.ts) calls it in order and laps its wall-clock as 'paddock'; the content arrives
 * with I2. `buildingRoofMat` is the pit complex's shared roof material.
 */
export function buildPaddock(_ctx: EnvBuildContext, _opts: { buildingRoofMat: THREE.Material }): void {}
