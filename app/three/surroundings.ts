/**
 * Everything else that stands on the far terrain, in far-field stage order: buildings and
 * car parks first (they push keep-outs the woods respect), then the outskirts furniture
 * (solar, fences, poles). Each builder defers its own jobs through `ctx.farField`.
 */
import type { EnvBuildContext } from './environment'
import { buildBuildings } from './buildings'
import { buildParkedCars } from './vehicles'
import { buildOutskirts } from './outskirts'

export function buildSurroundings(ctx: EnvBuildContext): void {
  buildBuildings(ctx)
  buildParkedCars(ctx)
  buildOutskirts(ctx)
}
