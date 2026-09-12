import type { EnvBuildContext } from './environment'
import type { OpsStats } from './infield'

/**
 * The operations layer (plan I3): transporters, hospitality, pit equipment, the marshals /
 * crews / officials / photographers (figures.ts `buildOpsFigures`), the safety / medical /
 * course vehicles, the cranes, all placed from `~/data/ops-spec` and pushed into `ctx.ops`.
 * Phase I0 lands the entry point only — the umbrella (infield.ts) calls it in order and laps
 * its wall-clock as 'ops'; the content arrives with I3.
 */
export function buildOps(_ctx: EnvBuildContext): OpsStats {
  return { figures: 0, byRole: {}, impostors: 0, near3d: 0, mode: 'none', vehicles: 0, equipment: 0 }
}
