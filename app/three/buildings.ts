/**
 * Buildings of the surroundings (app/data/suzuka-surroundings.ts SUR_BUILDINGS): massing with
 * roofs and a facade atlas, merged per 250 m cell, plus the Motopia extras (coaster, pools) and
 * the campsite. Registered with `ctx.farField` in the 'buildings' stage; every footprint pushes
 * its keep-out so the later 'forest' jobs stay clear. Stub: filled in by phase C2b.
 */
import type { EnvBuildContext } from './environment'

export function buildBuildings(_ctx: EnvBuildContext): void {}
