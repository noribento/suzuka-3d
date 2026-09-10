/**
 * Everything else that stands on the far terrain: buildings with roofs and facades, car parks
 * with parked cars, solar farms, utility poles and wires, the perimeter fence, light poles and
 * the Motopia / campsite extras — deferred through `ctx.farField` (stages 'paving' → 'buildings'
 * → 'dressing') and standing on `ground.standY`. Stub in C0: filled in by phase C2b.
 */
import type { EnvBuildContext } from './environment'

export function buildSurroundings(_ctx: EnvBuildContext): void {}
