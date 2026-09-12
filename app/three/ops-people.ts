import type { EnvBuildContext } from './environment'
import type { OpsPartial } from './ops'

/**
 * The ops layer's people and flags (plan I3-d / I3-e): the pit crews (`crewSlots` /
 * `perchSeats` per team block), the officials, the orange marshals with white helmets, the
 * photographers and the paddock staff from `figuresAt()` (ops-spec section D), converted from
 * the track frame (`track.pointAt`, `ground.standY`, `yawDeg` → world yaw) into figures.ts
 * `FigurePlacement`s and placed through `buildOpsFigures(ctx, placements, 'ops-figures')`
 * (impostors everywhere, the 3D level within `Quality.infield.figures3dM`, the shared
 * 'crowd|baked' / 'crowd|figure' / 'crowd|procedural' programs; a separate budget from the
 * crowd, so the e2e crowd impostor window does not move); the flags of `flagPlacements()`
 * share the trackside flag-wave clock.
 *
 * I3-a lands the entry point only; I3-d fills it. Reports `figures`, `byRole`, `impostors`,
 * `near3d`, `mode` (Node = 'procedural' once figures are placed, 'none' while empty) and the
 * flag rows as `equipment`.
 */
export function buildOpsPeople(_ctx: EnvBuildContext): OpsPartial {
  return { placements: [], stats: { figures: 0, byRole: {}, impostors: 0, near3d: 0, mode: 'none' } }
}
