/**
 * The static operations layer inside the fences (I phase §I3): transporters, hospitality, pit
 * equipment, marshals / crews / officials / photographers, the safety / medical / course cars,
 * cranes and TV cranes — pure data and pure functions, no three.js, so the same rows feed the
 * builders (app/three/ops.ts), the guard (scripts/facilities-check.mjs §16 ops-check) and the
 * smoke scripts.
 *
 * Every placement is a footprint in the track frame: `(s, lateral)` of its centre, `yawDeg` about
 * the up axis (0 = the long side along +s), `size` [long, across, height] in metres, `y` metres
 * above the ground it stands on (omitted = 0) and a `mount` that says which envelope rule applies
 * (§16 O1: apron / lane rows must be inside `PIT_ENVELOPE.workArea` and outside every stopped
 * car's rectangle; wall rows in the walkway band; interior rows inside the building; barrierTop /
 * pitWallTop / fencePost rows hang on structures the barrier checks already cover).
 *
 * The tables are EMPTY until I3 fills them; the guard and the smokes already read them.
 */

import type { TeamId } from './drivers'

export type OpsMount = 'apron' | 'lane' | 'wall' | 'paddock' | 'yard' | 'interior' | 'roof' | 'fencePost' | 'barrierTop' | 'pitWallTop'

export type OpsKind =
  | 'vehicle' | 'truck' | 'tent' | 'container' | 'cabin' | 'crane' | 'generator'
  | 'equipment' | 'trolley' | 'tyres' | 'board' | 'light' | 'camera' | 'barrier' | 'cone' | 'figure'

export type FigureRole = 'marshal' | 'official' | 'crew' | 'photographer' | 'staff' | 'guest'

export interface OpsPlacement {
  id: string
  kind: OpsKind
  /** centre, metres along the lap (wrapped) */
  s: number
  /** centre, metres from the centreline, + = the driver's left */
  lateral: number
  /** rotation about the up axis, degrees; 0 = the long side along +s */
  yawDeg: number
  /** metres above the ground the footprint stands on (0 when omitted) */
  y?: number
  /** [long, across, height] metres */
  size: [number, number, number]
  mount: OpsMount
  /** the team whose block the row belongs to (crew, garage equipment) */
  team?: TeamId
  /** figures: the pose (figures.ts `FigurePose`) */
  pose?: string
  /** vehicles / equipment: body and accent colours (sRGB hex) */
  tint?: [string, string]
  /** the figure's role when `kind === 'figure'` */
  role?: FigureRole
}

/** A standing person: the (s, lateral) the guard checks against the envelopes (§16 O9). */
export interface OpsFigure {
  s: number
  lateral: number
  role: FigureRole
  team?: TeamId
}

/**
 * The words the ops layer paints (team trucks, boards, vests): scripts/textures-lint.mjs reads
 * this array — descriptive words only, never a real sponsor or team name.
 */
export const OPS_TEXTS: readonly string[] = []

/** Every static object the ops layer places (I3 fills this from PIT_ENVELOPE / the paddock tables). */
export function opsPlacements(): OpsPlacement[] {
  return []
}

/** Every standing figure the ops layer places (I3-d). */
export function figuresAt(): OpsFigure[] {
  return []
}
