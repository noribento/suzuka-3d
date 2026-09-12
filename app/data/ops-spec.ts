import type { TeamId } from './drivers'
import type { FigureRole } from '~/three/figures'

/**
 * The operations layer's data (plan I3): what stands where on race weekend — transporters,
 * hospitality, pit equipment, the safety / medical / course vehicles, the cranes and the
 * figures — as pure data in the track frame, three-independent, so scripts/facilities-check.mjs
 * (§16 ops-check) verifies the same rows the builders (ops.ts) place. Phase I0 lands the row
 * shape only; the tables and the generators (`opsPlacements`, `figuresAt`) arrive with I3.
 */

/** What a row stands on — the ops-check picks its envelope rule from it (plan I0-f, O1–O6). */
export type OpsMount = 'apron' | 'lane' | 'wall' | 'paddock' | 'yard' | 'interior' | 'roof' | 'fencePost' | 'barrierTop' | 'pitWallTop'

/** The prop kind of a row (the prototype it instances); I3 narrows this to its union. */
export type OpsKind = string

/** One placed thing of the operations layer, in the track frame; the builders push what they placed into `ctx.ops`. */
export interface OpsPlacement {
  id: string
  kind: OpsKind
  s: number
  lateral: number
  /** heading relative to the track direction at `s` (deg, + = towards the driver's left) */
  yawDeg: number
  /** height over what it stands on (m); default: on the ground (`ground.standAt`) */
  y?: number
  /** footprint length (along the heading), width, height (m) */
  size: [number, number, number]
  mount: OpsMount
  team?: TeamId
  /** figures: the pose (figures.ts `FigurePose`) */
  pose?: string
  /** vehicles / equipment: body and accent colours (sRGB hex) */
  tint?: [string, string]
  role?: FigureRole
}

/** Every row of the operations layer (the fixed tables plus the per-garage generation); empty until I3. */
export function opsPlacements(): OpsPlacement[] {
  return []
}
