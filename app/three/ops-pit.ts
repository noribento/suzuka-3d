import type { EnvBuildContext } from './environment'
import type { OpsPartial } from './ops'

/**
 * The ops layer's pit-lane equipment (plan I3-c): per team block the gantry (posts, beam over
 * the stopped car only, signal box, LED lamps, wheel guns on their hoses), three tyre stacks in
 * team-colour blankets, the front / rear jacks, the fuel drum and hose trolley inside the
 * garage, the monitor stand, the cones along the working lane's edge, the cable ramps across
 * the apron at the core boundaries, the fire extinguishers at the piers and the pit boards;
 * plus the pit-wall perches v2 on the walkway (aluminium frames, monitors, team-colour canopies,
 * umbrellas — the v1 perches of pit-lane.ts go with this step) and the fixed platform's TV
 * cameras — all from `pitEquipmentPlacements()` (ops-spec section C), every apron row inside
 * PIT_ENVELOPE.workArea, outside `stoppedCarRect(block)` and out of `lensColumns()`. GLB
 * prototypes (`packProp`: impact wrench, trolley jack, pc monitors, pit board, extinguisher,
 * cone pack) with procedural fallbacks, instanced through `registerPropSet(ctx, 'ops',
 * 'ops-pit-*', …)` with `Quality.infield.propsNearM`; monitors use EMISSIVE.opsMonitor.
 *
 * I3-a lands the entry point only; I3-c fills it. Reports `equipment` (every row it drew).
 */
export function buildOpsPit(_ctx: EnvBuildContext): OpsPartial {
  return { placements: [], stats: { equipment: 0 } }
}
