import type { EnvBuildContext } from './environment'

/**
 * The infield ground and what stands on it (plan I5): the facilities, walls and fences, the
 * ponds' banks, the west and south course pits, the parked cars and the lamps, the infield
 * trees' keep-outs. The ground itself is never built here (GROUND_AREAS rows draw it, README
 * 地面の契約). Phase I0 lands the entry point only — the umbrella (infield.ts) calls it in
 * order and laps its wall-clock into 'infield' together with the cuttings; the content arrives
 * with I5.
 */
export function buildInfieldGround(_ctx: EnvBuildContext): void {}
