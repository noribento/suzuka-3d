/**
 * Woods from the OSM forest polygons (app/data/suzuka-surroundings.ts): canopy masses per
 * 250 m cell for the far field, procedural stems in the middle range and the shipped GLB trees
 * near the camera, all registered with `ctx.farField` as deferred 'forest' jobs and standing on
 * `ground.standY`. Stub in C0: filled in by phase C2a of the S-phase plan.
 */
import type { EnvBuildContext } from './environment'

export function buildForest(_ctx: EnvBuildContext): void {}
