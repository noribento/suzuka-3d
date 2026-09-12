import type { OpsPlacement } from '~/data/ops-spec'
import type { EnvBuildContext } from './environment'
import type { OpsStats } from './infield'
import { buildOpsPeople } from './ops-people'
import { buildOpsPit } from './ops-pit'
import { buildOpsVehicles } from './ops-vehicles'

/**
 * The operations layer (plan I3) — the umbrella over three builders that each read one section
 * of `~/data/ops-spec` (pure data; every coordinate derives from PIT_ENVELOPE / GARAGE_CENTRES /
 * the paddock tables):
 *
 *  - ops-vehicles.ts `buildOpsVehicles` (I3-b): the transporters, air-freight containers,
 *    hospitality units, gazebos and marquees, the broadcast compound, the safety / medical /
 *    course vehicles and the cranes — `vehiclePlacements()`;
 *  - ops-pit.ts `buildOpsPit` (I3-c): the pit gantries, tyre stacks, jacks, fuel trolleys,
 *    monitors, cones, cable ramps, extinguishers, pit boards and the pit-wall perches v2 —
 *    `pitEquipmentPlacements()`;
 *  - ops-people.ts `buildOpsPeople` (I3-d): the crews, officials, marshals, photographers and
 *    staff (figures.ts `buildOpsFigures`) and the flags — `figuresAt()` / `flagPlacements()`.
 *
 * Each returns the placements it drew and its share of the counts; this file merges them into
 * one `OpsStats` (figures / byRole / impostors / near3d / mode from the people, vehicles from
 * the vehicles, equipment from the pit and the vehicles) and pushes every placement into
 * `ctx.ops` (= `env.group.userData.ops`), which facilities-check §16, ops-smoke and the e2e
 * suite compare with `opsPlacements()`. Everything is synchronous (plan §横断 3: `ctx.boxes`,
 * `ground.standY / standAt` and decals are still available); LOD goes through
 * `registerPropSet` / `buildOpsFigures` on the far-field registry (entry names `ops-*`).
 */

/** what one of the three builders reports back to the umbrella */
export interface OpsPartial {
  /** the rows it drew (the umbrella pushes them into `ctx.ops`) */
  placements: OpsPlacement[]
  /** its share of the counts (missing keys count as zero / 'none') */
  stats: Partial<OpsStats>
}

export function buildOps(ctx: EnvBuildContext): OpsStats {
  const vehicles = buildOpsVehicles(ctx)
  const pit = buildOpsPit(ctx)
  const people = buildOpsPeople(ctx)
  for (const part of [vehicles, pit, people]) for (const p of part.placements) ctx.ops.push(p)
  return {
    figures: people.stats.figures ?? 0,
    byRole: people.stats.byRole ?? {},
    impostors: people.stats.impostors ?? 0,
    near3d: people.stats.near3d ?? 0,
    mode: people.stats.mode ?? 'none',
    vehicles: vehicles.stats.vehicles ?? 0,
    equipment: (pit.stats.equipment ?? 0) + (vehicles.stats.equipment ?? 0),
  }
}
