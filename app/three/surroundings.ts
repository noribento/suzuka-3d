/**
 * Everything else that stands on the far terrain, in far-field stage order: the public roads
 * first (the 'paving' stage; their keep-outs must exist before the car parks plan their bays),
 * then buildings and car parks (they push keep-outs the woods respect), then the outskirts
 * furniture (solar, fences, poles) and, last, the roadside furniture (it hangs its transformer
 * cans on the outskirts' utility-pole plan). Each builder defers its own jobs through
 * `ctx.farField`.
 */
import type { EnvBuildContext } from './environment'
import { buildBuildings } from './buildings'
import { buildParkedCars } from './vehicles'
import { buildOutskirts } from './outskirts'
import { buildRoadFurniture } from './road-furniture'
import { buildRoads } from './roads'

export function buildSurroundings(ctx: EnvBuildContext): void {
  buildRoads(ctx)
  buildBuildings(ctx)
  buildParkedCars(ctx)
  buildOutskirts(ctx)
  buildRoadFurniture(ctx)
}
