/**
 * The static operations layer inside the fences (I phase §I3): transporters, hospitality, pit
 * equipment, marshals / crews / officials / photographers, the safety / medical / course cars,
 * cranes and TV cranes — pure data and pure functions, no three.js, so the same rows feed the
 * builders (app/three/ops.ts and its three files ops-vehicles / ops-pit / ops-people), the
 * guard (scripts/facilities-check.mjs §16 ops-check) and the smoke scripts.
 *
 * Every placement is a footprint in the track frame: `(s, lateral)` of its centre, `yawDeg` about
 * the up axis (0 = the long side along +s), `size` [long, across, height] in metres, `y` metres
 * above the ground it stands on (omitted = 0) and a `mount` that says which envelope rule applies
 * (§16 O1: apron / lane rows must be inside `PIT_ENVELOPE.workArea` and outside every stopped
 * car's rectangle; wall rows in the walkway band; interior rows inside the building; barrierTop /
 * pitWallTop / fencePost rows hang on structures the barrier checks already cover).
 *
 * Every coordinate near the pit lane derives from `PIT_ENVELOPE` (the stop lateral, the lanes,
 * the working area, the chase lens), `GARAGE_CENTRES` and the paddock tables — no literal stop
 * lateral anywhere, so the fallback stop (§横断 2) moves the whole layer by changing one number.
 *
 * The file has FOUR sections, each owned by one I3 step, kept apart by wide comment bands so
 * the steps merge cleanly:
 *   A. types + layout + the shared pure helpers            (I3-a)
 *   B. vehicles / hospitality / tents / compound            (I3-b) `vehiclePlacements()`
 *   C. pit-lane equipment / pit-wall perches                (I3-c) `pitEquipmentPlacements()`
 *   D. figures / flags                                      (I3-d) `figuresAt()`, `flagPlacements()`
 * `opsPlacements()` (end of A) is the concatenation the builders and the guard read.
 */

// ===== A. types + layout (I3-a) ==================================================================

import type { TeamId } from './drivers'
import { CIRCUIT } from './suzuka'
import {
  GARAGE_ORDER, PIT_GARAGE_COUNT, PIT_CORES, PIT_BOX_STRIP, PIT_ENVELOPE, PIT_BUILDING, PIT_WALL,
  PADDOCK_OFFICE, PADDOCK_PARKING, garageS,
} from './suzuka-facilities-spec'

export type OpsMount = 'apron' | 'lane' | 'wall' | 'paddock' | 'yard' | 'interior' | 'roof' | 'fencePost' | 'barrierTop' | 'pitWallTop'

export type OpsKind =
  | 'vehicle' | 'truck' | 'tent' | 'container' | 'cabin' | 'crane' | 'generator'
  | 'equipment' | 'trolley' | 'tyres' | 'board' | 'light' | 'camera' | 'barrier' | 'cone' | 'figure' | 'flag'

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

/**
 * A standing (or seated) person: the (s, lateral) the guard checks against the envelopes
 * (§16 O9) plus what the builder needs to pose it. `yawDeg` is the facing, 0 = looking along
 * +s, +90 = looking to the driver's left (+lateral), −90 = to the right (the garage side);
 * `y` metres above the ground (perch seats, the fixed platform, the podium); `mount` names the
 * envelope rule like a placement's (a 'wall' figure sits over the walkway band, a 'roof' one on
 * the building — both skip the ground rules).
 */
export interface OpsFigure {
  s: number
  lateral: number
  role: FigureRole
  team?: TeamId
  /** figures.ts `FigurePose` (stand / standF / hips / hipsF / lookUp / lookUpF / walk / crouch / sit / sitF) */
  pose?: string
  yawDeg?: number
  y?: number
  mount?: OpsMount
}

/**
 * The words the ops layer paints (vehicle liveries, boards, vests, the compound's signage):
 * scripts/textures-lint.mjs reads this array — descriptive words only (plan §横断 8), never a
 * real sponsor, supplier or team name. `TEAM 01` … `TEAM 11` stand in for the team names on
 * the hospitality units and the transporters (block order = GARAGE_ORDER).
 */
export const OPS_TEXTS: readonly string[] = [
  'MEDICAL', 'MEDICAL CAR', 'SAFETY CAR', 'FIRE', 'RESCUE', 'RECOVERY', 'OFFICIAL', 'MARSHAL', 'RACE CONTROL', 'HOSPITALITY',
  ...Array.from({ length: GARAGE_ORDER.length }, (_, i) => `TEAM ${String(i + 1).padStart(2, '0')}`),
]

const LAP = CIRCUIT.officialLength
const E = PIT_ENVELOPE
const V2 = PIT_BUILDING.v2
/** wrap a lap position into [0, LAP) */
export function wrapS(s: number): number {
  return ((s % LAP) + LAP) % LAP
}
/** metres forward from `a` to `b` around the lap, in [0, LAP) */
export function forwardS(a: number, b: number): number {
  return wrapS(b - a)
}
/** is `s` inside the forward arc [a, b] (wrapping)? */
export function inArcS(s: number, [a, b]: readonly [number, number]): boolean {
  return forwardS(a, s) <= forwardS(a, b)
}

/** the pit-lane walkway's centre (the pit-wall perches and the platform figures stand there) */
const WALKWAY_CENTRE = (PIT_WALL.walkway.from + PIT_WALL.walkway.to) / 2
/** the team offices' pit-side porch line (PADDOCK_OFFICE: lateral[1] + porch.pit) */
const OFFICE_PORCH_PIT = PADDOCK_OFFICE.lateral[1] + PADDOCK_OFFICE.porch.pit
const E_PADDOCK = PADDOCK_PARKING.find((r) => r.id === 'E')!
/** the pit-exit yard (GROUND_AREAS 'ピット出口ヤード'): s 103 → 205, lateral −52 … −24.9 */
const YARD = { s: [103, 205] as [number, number], lat: [-52, -24.9] as [number, number] }
/**
 * The course-vehicle base (PADDOCK_BUILDINGS course_vehicle_base, OSM 184429429) read through
 * `track.nearestOnRange` at I3-a: s 149 → 182, lateral −45.7 … −35.2, three roll doors on its
 * −s face. Vehicles stand on the yard's paving OUTSIDE this ring (§16 O6 checks the real ring).
 */
const VEHICLE_BASE = { s: [149, 182] as [number, number], lat: [-45.7, -35.2] as [number, number] }

/**
 * The layout every I3 step reads (plan §I3-b/c/d). Laterals are metres from the centreline
 * (negative = right = the pit side); `dS` / `dLat` are offsets from a block's centre `boxS` and
 * from `PIT_ENVELOPE.stop`. Nothing here is a world coordinate or a height above sea level.
 */
export const OPS_LAYOUT = {
  /** the strip in front of the shutters where the garage crew stand (1.3 m in front of the shutter line) */
  garageFront: { lat: V2.shutter + 1.3 },
  /**
   * The transporters (white Japanese box trucks, `CarBody 'truck'` 12 × 2.5 × 3.9): two per
   * block at boxS ± dS, tail to the garages 2.9 m behind the rear canopy's drip line (a tail
   * lift's length), nose 45° toward the paddock walk (a 12 m body at 45° covers 8.5 m of
   * lateral: −59.3 … −67.7, centre −63.5).
   */
  truckStrip: { lat: V2.rearCanopy.to - 7.1, yawDeg: 45, dS: 6.2, size: [12.0, 2.5, 3.9] as [number, number, number] },
  /** 20 ft air-freight containers (6.06 × 2.44 × 2.59) stacked two high behind the cores, inside the −59 … −68 strip */
  containers: { lat: V2.rearCanopy.to - 9.6, size: [6.06, 2.44, 2.59] as [number, number, number], stack: 2 },
  /** 3 × 3 gazebos behind the cores: two per core at core.mid ± dS */
  gazebos: { lat: V2.rearCanopy.to - 1.6, dS: 2.5, size: [3, 3, 2.8] as [number, number, number] },
  /**
   * The hospitality units (one per team, procedural, 10 × 7 × 6.6, two 3.3 m levels) at
   * (boxS, lat): 5 m of walkway stays between their paddock face and the offices' pit-side
   * porch line (−79.5), so lat = porch + walk + across / 2 = −71.
   */
  hospitality: { lat: OFFICE_PORCH_PIT + 5 + 3.5, walk: 5, size: [10, 7, 6.6] as [number, number, number] },
  /** the marquees (35 × 15 × 4.5 gable PVC): three in the B paddock, one media marquee at the E paddock's edge */
  marquees: {
    b: { s: [5, 22, 39], lat: -126, size: [35, 15, 4.5] as [number, number, number] },
    e: { s: 5480, lat: -92, size: [20, 10, 4.5] as [number, number, number] },
  },
  /** the broadcast compound in the E paddock (OSM 474537492): s 5440 → 5510 stays free of parked cars for it (PADDOCK_PARKING E) */
  compound: { s: [E_PADDOCK.s[1], E_PADDOCK.s[1] + 70] as [number, number], lat: [E_PADDOCK.lat[0], -92] as [number, number] },
  /**
   * The FIA safety car and the medical car wait nose to +s in the working area at the T1 end
   * of the garage row (between block 1's T1 edge and the T1 nose), 0.8 m closer to the shutters
   * than a stopped car — 4.2 m from the working lane, and outside every lens column.
   */
  scPocket: { s: [PIT_BOX_STRIP[1] + 3, PIT_BOX_STRIP[1] + 9] as [number, number], lat: E.stop - 0.8 },
  /**
   * The course vehicles at the vehicle base (plan I3-b): the yellow course SC, the black SUVs,
   * the crane truck, the recovery truck and the tractor on the apron in front of the base's
   * roll doors (its −s face); the ambulances and fire tenders along the yard's lane-side strip
   * (the yard's keep-out edge is −20.5 at s 160). The plan's literal slots (152 / 158 / 163,
   * −36 and 172 / 178 / 184, −44) fall INSIDE the base's footprint and moved here.
   */
  vehicleBase: {
    footprint: VEHICLE_BASE,
    apron: { s: [VEHICLE_BASE.s[0] - 21, VEHICLE_BASE.s[0] - 3] as [number, number], lat: [VEHICLE_BASE.lat[0] - 0.3, VEHICLE_BASE.lat[1] - 0.8] as [number, number] },
    strip: { s: [VEHICLE_BASE.s[0] + 1, YARD.s[1] - 15] as [number, number], lat: [-33, -27] as [number, number] },
    yard: YARD,
  },
  /**
   * The pit-wall perches v2 (mount 'wall'): aluminium frames 5.5 × 1.3 × 2.6 centred on the
   * walkway (−10.4), floor +1.0 over the walkway (+0.5), seats at +1.4, one per team block at
   * boxS. The v1 perches of pit-lane.ts go with I3-c.
   */
  pitWallPerch: { lat: WALKWAY_CENTRE, size: [5.5, 1.3, 2.6] as [number, number, number], floor: 1.0, seat: 1.4, seatsDS: [-1.5, 0, 1.5] },
  /** the fixed platform 31 → 69 (+1.3): officials and photographers stand along its lane edge */
  platform: { s: PIT_WALL.platform.sRange, lat: WALKWAY_CENTRE + 0.2, y: PIT_WALL.platform.y },
  /**
   * The pit gantry per block (I3-c): two 0.25² posts on the garage side of the stopped car at
   * (boxS ± dS, stop + dLat), a beam over the car only (stop − 2.4 → stop + 2.4 at 4.2 m —
   * nothing over the working lane), the wheel guns hung from it. dS 2.9 (the plan's 3.6 put
   * the beam's end 0.6 m into the chase-lens path, which ends at boxS − 3): the posts stand
   * beside the car's nose and tail, outside the car rectangle's lateral band.
   */
  gantry: { dS: 2.9, dLat: -2.4, h: 4.2, post: 0.25, beamHalf: 2.4 },
  /** three tyre stacks (4 tyres, team-colour blankets) on the garage side, at boxS + dS */
  tyreStacks: { dS: [-6, -7.5, -9], dLat: -3.2, size: [0.7, 0.7, 1.4] as [number, number, number] },
  /**
   * The front / rear jacks just outside the car rectangle (halfS + margin = 3.5): the front one
   * on the stop line, the rear one beside its jack man on the garage side (rearDLat) — on the
   * stop line at boxS − 4.6 it would sit in the chase-lens path.
   */
  jacks: { dS: 4.6, rearDLat: -1.8, size: [1.3, 0.4, 0.3] as [number, number, number] },
  /** the monitor stand on the garage side */
  monitor: { dS: -7, dLat: -3.5, h: 1.9 },
  /** the fuel drum + hose trolley inside the garage (mount 'interior') */
  fuel: { dS: 7, lat: V2.interior.equipmentFront - 4 },
  /** green cones along the working lane's outer edge at the block boundaries */
  cones: { lat: E.lanes[0] - 0.4 },
  /** cable ramps across the apron at the core boundaries, from the lane edge to the shutter */
  cableRamps: { lat: [E.lanes[0] - 0.2, V2.shutter + 0.1] as [number, number] },
  /**
   * The pit crew per block (plan I3-d, 12 = the real 3 per wheel + 2 jacks condensed): four
   * gunners at the wheels (both sides of the car), two tyre men beside the stacks, the front
   * and rear jack men (the rear one stands beside his jack on the garage side, out of the
   * chase-lens path s ∈ [boxS − 11, boxS − 3] × stop ± 1.5), the lollipop / release man at the
   * front on the lane side, three at the shutter. Offsets (dS from boxS, dLat from the stop).
   */
  crew: [
    { dS: 1.7, dLat: 1.9, pose: 'crouch', yawDeg: -90 }, { dS: -1.7, dLat: 1.9, pose: 'crouch', yawDeg: -90 },
    { dS: 1.7, dLat: -1.9, pose: 'crouch', yawDeg: 90 }, { dS: -1.7, dLat: -1.9, pose: 'crouch', yawDeg: 90 },
    { dS: -6, dLat: -3.2, pose: 'stand', yawDeg: 90 }, { dS: -7.5, dLat: -3.2, pose: 'hips', yawDeg: 0 },
    { dS: 4.2, dLat: 0, pose: 'crouch', yawDeg: 180 }, { dS: -4.4, dLat: -2.7, pose: 'crouch', yawDeg: 45 },
    { dS: 5.5, dLat: 1.5, pose: 'hips', yawDeg: 180 },
    { dS: -3, dLat: -3.5, pose: 'stand', yawDeg: 90 }, { dS: 0, dLat: -3.5, pose: 'hips', yawDeg: 90 }, { dS: 3, dLat: -3.5, pose: 'stand', yawDeg: 90 },
  ] as readonly { dS: number; dLat: number; pose: string; yawDeg: number }[],
  /** the officials (white): two at every core door, on the fixed platform, at the podium (2F), at the pit-exit light, at the pit entry (apron, outside the keep-out) */
  officials: {
    coreDoors: { dS: [-1.2, 1.2], lat: V2.shutter + 1.3 },
    platform: { n: 6, lat: WALKWAY_CENTRE + 0.2, y: PIT_WALL.platform.y },
    podium: { s: V2.podium.s, dS: [-3, -1, 1, 3], lat: -27.5, y: V2.floors[1] },
    exitLight: { s: 127, lat: -22.5, n: 2 },
    entry: { s: 5540, lat: E.lanes[0] - 2.2, n: 3 },
  },
  /** the orange marshals: at the block boundaries on the apron, in the pit-exit yard, behind the entry W-beam */
  marshals: { boundaries: { lat: V2.shutter + 0.8 }, exitYard: { s: [140, 180] as [number, number], lat: -26 }, entry: { s: [5548, 5552] as [number, number], lat: -21.5 } },
  /** the photographers (black): the fixed platform's lane edge, the pit-exit yard fence, the E paddock */
  photographers: { platform: { n: 5, lat: WALKWAY_CENTRE + 0.2, y: PIT_WALL.platform.y }, exitYard: { s: [140, 180] as [number, number], lat: -24 } },
  /** the flags (I3-e): T1 cap roof, the paddock gates (paddock.ts), the E paddock edge — 9 m poles, fictional colours */
  flags: { ePaddock: { s: [5350, 5520] as [number, number], lat: -34, n: 8, h: 9 } },
} as const

/**
 * The s windows every ops row must fall in (§16 O12): the lap is a figure-8 with a crossover,
 * so a row's world position is only projected back to s inside a window — a row outside every
 * window would land on the other loop. Apron / lane rows must be in `pitStrip` or `yard`.
 */
export const OPS_WINDOWS = {
  /** the garage row ± 20 m */
  pitStrip: [wrapS(PIT_BOX_STRIP[0] - 20), wrapS(PIT_BOX_STRIP[1] + 20)] as [number, number],
  /** the pit-exit yard (GROUND_AREAS 'ピット出口ヤード') */
  yard: YARD.s,
  /** the paddock behind the pit building (GROUND_AREAS 'パドック（ピットビル裏）'), the B paddock and the SMSC included */
  paddock: [5536, 100] as [number, number],
  /** the E paddock and the broadcast compound (PADDOCK_PARKING E → compound) */
  ePaddock: [E_PADDOCK.s[0], E_PADDOCK.s[1] + 70] as [number, number],
} as const

/** the stopped car of `block` (0 = the T1 end) grown by the working margin: s boxS ± (halfS + margin), lateral stop ± (carHalf + margin) */
export function stoppedCarRect(block: number): { block: number; s: [number, number]; lat: [number, number] } {
  const c = garageS(block)
  const dS = E.carBox.halfS + E.carBox.margin, dL = E.carHalf + E.carBox.margin
  return { block, s: [wrapS(c - dS), wrapS(c + dS)], lat: [E.stop - dL, E.stop + dL] }
}

export interface LensColumn {
  block: number
  boxS: number
  /** the chase lens itself (boxS − back, stop, +up) */
  lens: { s: number; lateral: number; y: number }
  /** nothing taller than `maxH` here: s ∈ [boxS − columnS[0], boxS − columnS[1]] × stop ± halfLat */
  column: { s: [number, number]; lat: [number, number]; maxH: number }
  /** nothing at all here (figures included): between the lens and the car, s ∈ [boxS − back, boxS − 3] × stop ± halfLat */
  path: { s: [number, number]; lat: [number, number] }
}

/** the director's pit-follow chase lens of every block (PIT_ENVELOPE.chaseLens), the column and the lens → car path to keep clear */
export function lensColumns(): LensColumn[] {
  const out: LensColumn[] = []
  const { back, up, halfLat, columnS, maxH } = E.chaseLens
  for (let g = 0; g < PIT_GARAGE_COUNT; g++) {
    const c = garageS(g)
    out.push({
      block: g,
      boxS: c,
      lens: { s: wrapS(c - back), lateral: E.stop, y: up },
      column: { s: [wrapS(c - columnS[0]), wrapS(c - columnS[1])], lat: [E.stop - halfLat, E.stop + halfLat], maxH },
      path: { s: [wrapS(c - back), wrapS(c - 3)], lat: [E.stop - halfLat, E.stop + halfLat] },
    })
  }
  return out
}

/**
 * Does a footprint centred at `lateral` stay inside the working area (PIT_ENVELOPE.workArea)?
 * `size` is the row's [long, across, height] (its across extent counts; a plain number is the
 * across extent itself) — for a yawed row pass its lateral bounding extent.
 */
export function inWorkArea(lateral: number, size: number | readonly number[] = 0): boolean {
  const half = (typeof size === 'number' ? size : size[1] ?? 0) / 2
  const [a, b] = E.workArea
  return lateral - half >= Math.min(a, b) && lateral + half <= Math.max(a, b)
}

/** the pit-side face's s of every core (the block boundaries that carry a marshal / a cable ramp / cones) */
export function coreEdges(): { core: number; s: [number, number]; mid: number }[] {
  return PIT_CORES.map(([a, b], i) => ({ core: i, s: [a, b], mid: wrapS(a + forwardS(a, b) / 2) }))
}

/**
 * The crew of `block` (0 = the T1 end; blocks without a team — the empty bay — get none): the
 * OPS_LAYOUT.crew offsets from (boxS, PIT_ENVELOPE.stop), every one outside the stopped-car
 * rectangle, inside the working area and out of the chase-lens path — facilities-check §16
 * verifies all 12 blocks through this function, so I3-d's `figuresAt()` reads it as is.
 */
export function crewSlots(block: number): OpsFigure[] {
  const team = GARAGE_ORDER[block]
  if (!team) return []
  const c = garageS(block)
  return OPS_LAYOUT.crew.map((o) => ({ s: wrapS(c + o.dS), lateral: E.stop + o.dLat, role: 'crew' as const, team, pose: o.pose, yawDeg: o.yawDeg, mount: 'apron' as const }))
}

/** the three seated crew of `block`'s pit-wall perch (mount 'wall', seat height over the walkway) */
export function perchSeats(block: number): OpsFigure[] {
  const team = GARAGE_ORDER[block]
  if (!team) return []
  const c = garageS(block)
  const P = OPS_LAYOUT.pitWallPerch
  return P.seatsDS.map((d) => ({ s: wrapS(c + d), lateral: P.lat, role: 'crew' as const, team, pose: 'sit', yawDeg: 90, y: P.seat, mount: 'wall' as const }))
}

/** Every static object the ops layer places: sections B + C (+ the non-figure rows of D). */
export function opsPlacements(): OpsPlacement[] {
  return [...vehiclePlacements(), ...pitEquipmentPlacements(), ...flagPlacements()]
}

//
//
//
//
//
//
//
// ===== B. vehicles / hospitality / tents / compound (I3-b): vehiclePlacements() =================
//
//
//
//
//
//
//

/**
 * I3-b — `vehiclePlacements()` must produce (plan §I3-b; every row a footprint with `mount`):
 *  - transporters: two `kind 'truck'` per team block at (boxS ± truckStrip.dS, truckStrip.lat),
 *    yawDeg 45, size truckStrip.size, mount 'paddock', `team` set (a team-colour band; the
 *    trucks stay white — OPS_TEXTS `TEAM nn` at most); four white 2 t trucks in the B paddock
 *    and six vans in front of the offices;
 *  - `kind 'container'` × 10 behind the cores (two stacks: a second row with `y` = size[2]),
 *    mount 'paddock';
 *  - `kind 'tent'`: two gazebos per core at (core.mid ± gazebos.dS, gazebos.lat), the marquees
 *    of OPS_LAYOUT.marquees (mount 'paddock');
 *  - hospitality units: one `kind 'cabin'` per team at (boxS, hospitality.lat), mount 'paddock';
 *  - the broadcast compound inside OPS_LAYOUT.compound: 8 containers, 3 dishes ('equipment'),
 *    2 generators ('generator'), the fence ('barrier'), mount 'paddock';
 *  - `kind 'vehicle'`: the FIA safety car and the medical car in OPS_LAYOUT.scPocket (mount
 *    'apron' — inside the working area, outside every stopped-car rectangle and lens column),
 *    the course vehicles in OPS_LAYOUT.vehicleBase.apron / .strip (mount 'yard'), the crane
 *    ('crane') and the recovery truck.
 * Rules: O1 (apron rows in the working area, outside the car rectangles), O2, O3 (nothing taller
 * than 2.9 m in a lens column, nothing in a lens → car path), O4, O5 (0.2 m off every barrier
 * line), O6 (outside every building footprint — the vehicle base's ring included), O12 (apron
 * / lane rows inside OPS_WINDOWS.pitStrip / .yard; the rest inside some window). Static
 * vehicles never enter the race `models` (e2e: models.length === 22).
 */
export function vehiclePlacements(): OpsPlacement[] {
  return []
}

//
//
//
//
//
//
//
// ===== C. pit-lane equipment / perches (I3-c): pitEquipmentPlacements() =========================
//
//
//
//
//
//
//

/**
 * I3-c — `pitEquipmentPlacements()` must produce per team block (plan §I3-c; every apron row
 * inside PIT_ENVELOPE.workArea and outside `stoppedCarRect(block)`; coordinates from
 * PIT_ENVELOPE.stop through OPS_LAYOUT):
 *  - the gantry: two posts `kind 'equipment'` at (boxS ± gantry.dS, stop + gantry.dLat), h
 *    gantry.h (outside the lens column s ∈ [boxS − 13, boxS − 9] and the lens → car path
 *    s ∈ [boxS − 11, boxS − 3] — the posts and the beam end at ± 2.9); the beam / signal box
 *    / lamps / wheel guns are the builder's, hung from the posts (a beam row, if registered,
 *    spans boxS ± gantry.dS × stop ± beamHalf at y gantry.h);
 *  - `kind 'tyres'` × 3 at (boxS + tyreStacks.dS[i], stop + tyreStacks.dLat);
 *  - `kind 'trolley'` (the jacks) at (boxS + jacks.dS, stop) and (boxS − jacks.dS, stop +
 *    jacks.rearDLat);
 *  - the fuel drum + hose trolley at (boxS + fuel.dS, fuel.lat), mount 'interior';
 *  - the monitor stand 'equipment' at (boxS + monitor.dS, stop + monitor.dLat), h monitor.h;
 *  - `kind 'cone'` × 30 along OPS_LAYOUT.cones.lat at the block boundaries (mount 'apron');
 *  - cable ramps 'equipment' at every core boundary from cableRamps.lat[0] to [1] (long 0.3 m
 *    rows, or one row with yawDeg 90);
 *  - a fire extinguisher 'equipment' per pier pair (48), mount 'apron' at the shutter line;
 *  - the pit board 'board' beside every perch (mount 'wall');
 *  - the pit-wall perches v2: one `kind 'cabin'` per team at (boxS, pitWallPerch.lat), size
 *    pitWallPerch.size, mount 'wall' (the walkway band of §16), with monitors 'equipment' and
 *    umbrellas; pit-lane.ts's v1 perches (perchCanopies / perchBacks) are removed in the same
 *    commit;
 *  - the fixed platform's two TV cameras 'camera' (mount 'wall', y platform.y).
 * Rules: O1 (apron rows in the working area, outside the car rectangles; wall rows in the
 * walkway band), O3 (nothing taller than 2.9 m in a lens column; nothing at all in a lens →
 * car path s ∈ [boxS − 11, boxS − 3] × stop ± 1.5 — every row behind the car keeps
 * |dLat| > 1.5 or s > boxS − 3), O5, O12 (inside OPS_WINDOWS.pitStrip).
 */
export function pitEquipmentPlacements(): OpsPlacement[] {
  return []
}

//
//
//
//
//
//
//
// ===== D. figures / flags (I3-d): figuresAt(), flagPlacements() =================================
//
//
//
//
//
//
//

/**
 * I3-d — `figuresAt()` must produce (plan §I3-d, ≈ 310; the terrace guests are the pit
 * building's own `ops-terrace`):
 *  - the pit crew: `crewSlots(block)` for every team block (12 each) + `perchSeats(block)`
 *    (3 seated, mount 'wall');
 *  - officials (white): OPS_LAYOUT.officials — two at every core door (coreEdges()), six on the
 *    fixed platform (y platform.y), four on the podium (2F: y floors[1], mount 'roof'), two at
 *    the pit-exit light, three at the pit entry;
 *  - marshals (orange, white helmets): OPS_LAYOUT.marshals — one at every block boundary on
 *    the apron (12), four in the exit yard, two behind the entry W-beam; the MARSHAL_POSTS
 *    slots are I4's;
 *  - photographers (black): five on the platform's lane edge, four at the exit-yard fence, two
 *    in the E paddock;
 *  - staff (grey / black, walking / standing): ≈ 60 in the paddock (in front of the offices,
 *    between the hospitality units, in front of the centre house), 8 in the compound, 6 at
 *    the vehicle base.
 * Facing: `yawDeg` 0 = +s, +90 = +lateral; the crew face the car, the wall-top rows face the
 * track. Rules: O1–O4 and O9 for every figure (inside the circuit ring, outside the pit
 * keep-out, the lane band, every stopped-car rectangle, every lens → car path and the grid),
 * O12 (inside some OPS_WINDOWS window).
 * `flagPlacements()` (I3-e): `kind 'flag'` rows — five on the T1 cap's roof (mount 'roof'),
 * eight along the E paddock's edge (OPS_LAYOUT.flags.ePaddock, mount 'paddock'); the paddock
 * gates' flags stay in paddock.ts.
 */
export function figuresAt(): OpsFigure[] {
  return []
}

export function flagPlacements(): OpsPlacement[] {
  return []
}
