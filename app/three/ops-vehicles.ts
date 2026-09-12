import type { EnvBuildContext } from './environment'
import type { OpsPartial } from './ops'

/**
 * The ops layer's vehicles and paddock structures (plan I3-b): the white Japanese box-truck
 * transporters (`car-bodies.ts` 'truck', two per block on OPS_LAYOUT.truckStrip), the 20 ft
 * air-freight containers behind the cores, the hospitality units (procedural, one per team at
 * OPS_LAYOUT.hospitality), the gazebos and marquees, the broadcast compound in the E paddock,
 * the FIA safety car and medical car in OPS_LAYOUT.scPocket and the course vehicles at the
 * vehicle base — all from `vehiclePlacements()` (ops-spec section B). GLB prototypes
 * (`packProp`, `carGlbGeometry` + `carGlbMaterial(map, 'tint')` — the tint map is mandatory, a
 * null map is another program) with procedural fallbacks (`carBodyGeometry` /
 * `carBodyMaterial`), instanced per 250 m cell through `registerPropSet(ctx, 'ops',
 * 'ops-vehicles' | 'ops-hospitality' | 'ops-compound', …)` with the tier's
 * `Quality.infield.vehiclesNearM`. Static vehicles never enter the race `models`.
 *
 * I3-a lands the entry point only; I3-b fills it. Reports `vehicles` (every vehicle / truck /
 * crane row) and `equipment` (containers, tents, generators, dishes).
 */
export function buildOpsVehicles(_ctx: EnvBuildContext): OpsPartial {
  return { placements: [], stats: { vehicles: 0, equipment: 0 } }
}
