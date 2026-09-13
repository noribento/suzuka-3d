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
import { BARRIERS, MARSHAL_POSTS, type BarrierRun, type MarshalPostDef } from './suzuka-barriers-spec'
import {
  GARAGE_ORDER, PIT_GARAGE_COUNT, PIT_CORES, PIT_BOX_STRIP, PIT_ENVELOPE, PIT_BUILDING, PIT_WALL,
  PADDOCK_BUILDINGS, PADDOCK_LAMPS, PADDOCK_OFFICE, PADDOCK_PARKING, garageS,
} from './suzuka-facilities-spec'

/**
 * 'trackside' / 'platform' (I4-a): the marshals of a trackside post — on the ground beside its
 * stand and on the stand's deck (`y` = the platform's floor over the ground). Both stand on the
 * drawn ground (like apron / yard rows) and are keyed by MARSHAL_POSTS, so §16 O12's s windows
 * do not apply to them; O1 / O2 do.
 */
export type OpsMount = 'apron' | 'lane' | 'wall' | 'paddock' | 'yard' | 'interior' | 'roof' | 'fencePost' | 'barrierTop' | 'pitWallTop' | 'trackside' | 'platform'

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
  /**
   * The marquees (gable PVC): three 15 × 15 in the B paddock's flat band (the lot is flat only
   * to −122 and climbs 3.9 m over −124 … −143 — the I2 relief ring; the plan's 35 × 15 units
   * across the lot buried their high side), one 20 × 10 media marquee at the E paddock's edge.
   */
  marquees: {
    b: { s: [5, 22, 39], lat: -116, size: [15, 15, 4.5] as [number, number, number] },
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
   * The front / rear jacks just outside the car rectangle (halfS + margin = 3.5), BOTH on the
   * garage side of the stop line (dLat) beside their jack men: on the stop line the rear one
   * would sit in the chase-lens path, and the front one (I3-c put it there) lay on the arrival
   * path of the block behind — a car arriving at block g drives the last 25 m at the stop
   * lateral (its body stop ± 0.95), so every stop at block g drove over block g + 1's jack.
   * At stop − 1.8 the jack spans stop − 2.0 … − 1.6: 0.65 m clear of an arriving body.
   */
  jacks: { dS: 4.6, dLat: -1.8, size: [1.3, 0.4, 0.3] as [number, number, number] },
  /** the monitor stand on the garage side */
  monitor: { dS: -7, dLat: -3.5, h: 1.9 },
  /** the fuel drum + hose trolley inside the garage (mount 'interior') */
  fuel: { dS: 7, lat: V2.interior.equipmentFront - 4 },
  /** green cones at the block boundaries (the plan's lane-edge line; section C puts them on the garage side of the core fronts) */
  cones: { lat: E.lanes[0] - 0.4 },
  /** cable ramps across the apron at the core boundaries, from the lane edge to the shutter */
  cableRamps: { lat: [E.lanes[0] - 0.2, V2.shutter + 0.1] as [number, number] },
  /**
   * The pit crew per block (plan I3-d, 12 = the real 3 per wheel + 2 jacks condensed): four
   * gunners at the wheels (both sides of the car), two tyre men beside the stacks, the front
   * and rear jack men (each crouching beside his jack on the garage side — the front jack
   * PIT_EQUIPMENT.jacks at (boxS + 4.6, stop − 1.8) spans s 3.95 … 5.25 × stop − 2.0 … − 1.6,
   * the man at (4.6, −2.6); the rear one at (−4.4, −2.7), out of the chase-lens path
   * s ∈ [boxS − 11, boxS − 3] × stop ± 1.5), the lollipop / release man at the nose on the
   * GARAGE side (5.8, −1.6; past the jack's +s end 5.25, before the monitor stand at 5.4 … 6.6
   * × −4.15 … −3.65), three at the shutter. Offsets (dS from boxS, dLat from the stop).
   * The moving cars (race.ts; measured over the 53-lap race × 3 seeds = 66 stops with the box
   * trace, car body s ± 2.9 × stop ± 0.95, r 0.3 about every figure — `pnpm sim -- --pit-trace`
   * repeats the contact test): a released car holds the stop lateral for PIT_EXIT_HOLD_M =
   * 3.5 m and then steers for the lane at PIT_STEER_EXIT_BOOST, so its centre is still
   * ≤ stop + 0.49 when its tail passes the front lane-side gunner (d 4.6 … 5.0; body ≤ + 1.44
   * against the gunner's − 0.3 edge at + 1.6) and already ≥ stop + 3.56 when its nose reaches
   * the NEXT block's rear lane-side gunner (boxS + 17.3 on the 19 m pitch; d 14.4; body
   * ≥ + 2.61 against + 2.2) — no exiting car touches a figure, jack or cone (66 of 66 stops).
   * What the static layer does NOT model: a car arriving at the NEXT block drives the last
   * 25 m at the stop lateral itself (centre ≤ stop + 0.11 from 14 m out), so it passes 0.65 m
   * from this block's lane-side gunners (its body edge stop + 0.95 … their r 0.3 at + 1.9) on
   * EVERY stop; where a core separates the two blocks (26 m pitch: blocks 0 / 2 / 4 / 6 / 8) it
   * is still converging over them (stop + 0.4 … + 1.2 at 24 … 30 m out) and crosses both
   * (29 of 66 stops), 43 m out (centre + 3.0 … + 3.5, body edge −21.45) it grazes the front
   * lane-side gunner of the block before that (−21.6, 38 of 66), and in the crowded harness
   * case (all 22 cars pitting on one lap, a queued car stopped beside its team-mate at
   * stop + 2.0) it drives through them; a real crew steps back. Accepted: they are what the
   * chase-in-box shot is about, and O1 (the stopped car's rectangle) holds.
   */
  crew: [
    { dS: 1.7, dLat: 1.9, pose: 'crouch', yawDeg: -90 }, { dS: -1.7, dLat: 1.9, pose: 'crouch', yawDeg: -90 },
    { dS: 1.7, dLat: -1.9, pose: 'crouch', yawDeg: 90 }, { dS: -1.7, dLat: -1.9, pose: 'crouch', yawDeg: 90 },
    { dS: -6, dLat: -3.2, pose: 'stand', yawDeg: 90 }, { dS: -7.5, dLat: -3.2, pose: 'hips', yawDeg: 0 },
    { dS: 4.6, dLat: -2.6, pose: 'crouch', yawDeg: 90 }, { dS: -4.4, dLat: -2.7, pose: 'crouch', yawDeg: 45 },
    { dS: 5.8, dLat: -1.6, pose: 'hips', yawDeg: 180 },
    { dS: -3, dLat: -3.5, pose: 'stand', yawDeg: 90 }, { dS: 0, dLat: -3.5, pose: 'hips', yawDeg: 90 }, { dS: 3, dLat: -3.5, pose: 'stand', yawDeg: 90 },
  ] as readonly { dS: number; dLat: number; pose: string; yawDeg: number }[],
  /** the officials (white): two at every core door, on the fixed platform, at the podium (2F), at the pit-exit light, at the pit entry (apron, outside the keep-out) */
  officials: {
    coreDoors: { dS: [-1.2, 1.2], lat: V2.shutter + 1.3 },
    /** the fixed platform 31 → 69: the deck's free slots between the perches, boards, cabinets and TV cameras of pit-lane.ts / ops-pit.ts */
    platform: { s: [41.5, 47.0, 48.0, 57.5, 64.0, 66.0], lat: WALKWAY_CENTRE + 0.2, y: PIT_WALL.platform.y },
    /** the podium's flat 2F terrace: between the rostrum's black steps (PIT_BUILDING.v2.rostrum, to −27.2) and the backdrop wall (−28.3) */
    podium: { s: V2.podium.s, dS: [-3.2, -1.6, 1.6, 3.2], lat: V2.rostrum.lateral - V2.rostrum.size / 2 - 0.6, y: V2.floors[1] },
    /**
     * At the pit-exit light (SIGNS pit-exit-light, s 128 at −21.5): on the apron between the
     * light's post and the pit-exit-outer wall (its face −22.3 at s 129), 0.6 m outside the
     * analytic keep-out's edge (c − keepOut.back = −21.0 at s 129, the exit ramp)
     */
    exitLight: { s: [129, 130.3], lat: E.lanes[0] - 2.6 },
    /** the pit entry: on the apron (it begins at 5520) 0.6 m outside the keep-out edge (−21.1) */
    entry: { s: [5539, 5540.5, 5542], lat: E.lanes[0] - 2.6 },
  },
  /**
   * The orange marshals: at the twelve core faces on the apron (0.5 m past each face, 1.7 m in
   * front of the shutter line — the pit-3 extinguisher of the block beside a core stands at the
   * face − 0.2 at −27.85), four in the pit-exit yard along the lane-side vehicles, two on the
   * entry apron behind the W-beam section (its start at 5538, on the apron the guard allows)
   */
  marshals: { boundaries: { lat: V2.shutter + 1.7, dS: 0.5 }, exitYard: { s: [145, 157, 169, 181], lat: -26 }, entry: { s: [5548, 5552], lat: E.lanes[0] - 2.6 } },
  /**
   * The photographers (black): the fixed platform's lane edge, the pit-exit yard behind the
   * pit-exit-outer wall (−22.0 … −20.4 over s 140 → 180; the apron reaches s 180), two by the
   * E paddock's media marquee (LAYOUT_B.marqueeE at 5491 → 5501 × −78 … −98)
   */
  photographers: { platform: { s: [39.0, 44.3, 58.5, 65.0, 67.5], lat: WALKWAY_CENTRE + 0.2, y: PIT_WALL.platform.y }, exitYard: { s: [145, 155, 165, 175], lat: -24.4 }, ePaddock: [[5489, -85], [5490, -88.5]] as readonly [number, number][] },
  /**
   * The flags (I3-e): T1 cap roof and the paddock gates stay in paddock.ts; eight 9 m poles
   * along the E paddock's track-side edge, inside its enclosure — the fence 474537488 crosses
   * −34 between s 5360 and 5395 on its way from (5401, −29.5) to the car park's west end, so the
   * row runs from 5410 to 5500 (the mast at (5480, −38) is 4 m off the line)
   */
  flags: { ePaddock: { s: [5410, 5500] as [number, number], lat: -34, n: 8, h: 9, size: [0.12, 0.12, 9] as [number, number, number] } },
} as const

/**
 * The s windows every ops row must fall in (§16 O12): the lap is a figure-8 with a crossover,
 * so a row's world position is only projected back to s inside a window — a row outside every
 * window would land on the other loop. Apron / lane rows must be in `pitStrip` or `yard`.
 */
export const OPS_WINDOWS = {
  /** the garage row ± 20 m */
  pitStrip: [wrapS(PIT_BOX_STRIP[0] - 20), wrapS(PIT_BOX_STRIP[1] + 20)] as [number, number],
  /** the entry end of the garage apron (ground-plan: the apron begins 40 m before the limit line, 5520) up to the strip window */
  entryApron: [5520, wrapS(PIT_BOX_STRIP[0] - 20)] as [number, number],
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

/**
 * The three seated crew of `block`'s pit-wall perch (mount 'wall'): on the stools ops-pit.ts
 * draws — the perch of section C (`perchCentreS`, on the walkway or the fixed platform's deck,
 * `perchOnPlatform`), the stools on its kerb-side edge (frame width / 2 − 0.3 from its centre;
 * the desk and monitors are on the wall side) at `PIT_EQUIPMENT.perch.seatsDS`. `y` is the figure's origin in the road frame: the seated
 * impostor / prototype was baked on a seat with its hips 0.4 m up, so the origin is the perch
 * floor (base + floor) plus the stool's 0.05 m over that (0.45 seat). They face the track.
 */
export function perchSeats(block: number): OpsFigure[] {
  const team = GARAGE_ORDER[block]
  if (!team) return []
  const c = perchCentreS(block)
  const onDeck = perchOnPlatform(block)
  const P = PIT_EQUIPMENT.perch
  const lat = (onDeck ? P.onPlatform.lat : P.lat) - (onDeck ? P.onPlatform.width : P.size[1]) / 2 + 0.3
  const y = (onDeck ? PIT_WALL.platform.y : PIT_WALL.walkway.y) + P.floor + 0.05
  return P.seatsDS.map((d) => ({ s: wrapS(c + d), lateral: lat, role: 'crew' as const, team, pose: 'sit', yawDeg: 90, y, mount: 'wall' as const }))
}

/**
 * The stand of a marshal post (I4-a): what marshal-posts.ts draws and facilities-check O8 /
 * ops-spec `marshalSlots` read. The cabin body 2.5 m is centred on the row's (s, lateral); the
 * platform floor is `across` wide and reaches `deckS` past the body on the stair side (the deck
 * the platform marshal stands on), the stair (`stairLen` × `stairW`) runs on from the deck's
 * edge along s. Ground marshals stand `groundGap` in front of the floor's track-side edge,
 * `groundPitch` apart along s. Heights: `platform` default, `floor` thickness.
 */
export const MARSHAL_STAND = {
  body: 2.5,
  across: 2.7,
  /** the floor's extent past the body on the stair side (m) */
  deckS: 1.1,
  stairLen: 2.4,
  stairW: 0.8,
  platform: 2.0,
  floor: 0.12,
  /** the low post (type 'low'): [along s, across, height] */
  low: [2.0, 1.6, 2.0] as const,
  groundGap: 0.35,
  groundPitch: 1.5,
} as const

/** the stair's direction along s (+1 = towards +s) of a post row */
export function marshalStairSign(post: Pick<MarshalPostDef, 'stair'>): 1 | -1 {
  return post.stair === 'fore' ? 1 : -1
}

/**
 * The marshals of a trackside post (I4-a): one on the stand's deck in front of the body facing
 * the approaching cars (mount 'platform', `y` = platform + floor over the ground), the rest on
 * the ground between the fence and the stand — `groundGap` in front of the floor's track-side
 * edge, `groundPitch` apart along s, facing the track ± 20° (a deterministic hash) — mount
 * 'trackside'. `figures` per row (default 3; 1 = the platform only, where the ground in front
 * is a pit keep-out). A 'building' row offers none (I5 draws the building and its people);
 * a 'low' post has no stand, so all of its marshals stand on the ground. Every point passes
 * §16 O1 / O2 (facilities-check O8 / O9) and stands off the barrier line whenever the row
 * itself does (the cabin's stand is ≥ 0.6 m off it, the marshals 0.35 m inside that edge).
 */
export function marshalSlots(post: MarshalPostDef): OpsFigure[] {
  if (post.type === 'building') return []
  const S = MARSHAL_STAND
  const side = post.lateral >= 0 ? 1 : -1
  const n = post.figures ?? 3
  const low = post.type === 'low'
  const out: OpsFigure[] = []
  const k = Math.round(post.s)
  if (!low) {
    // the deck: in front of the body on the stair side, looking back along the track (−s)
    const y = (post.platform ?? S.platform) + S.floor
    out.push({ s: wrapS(post.s + marshalStairSign(post) * (S.body / 2 + S.deckS / 2)), lateral: post.lateral, role: 'marshal', pose: 'stand', yawDeg: 180, y, mount: 'platform' })
  }
  const groundN = low ? n : n - 1
  const across = low ? S.low[1] : S.across
  const lat = post.lateral - side * (across / 2 + S.groundGap)
  const offsets = groundN <= 0 ? [] : groundN === 1 ? [0] : groundN === 2 ? [-0.5, 0.5] : Array.from({ length: groundN }, (_, i) => i - (groundN - 1) / 2)
  offsets.forEach((o, i) => {
    const yaw = -side * 90 + (unit(k, i + 11) - 0.5) * 40
    const pose = (['stand', 'hips', 'standF', 'lookUp'] as const)[Math.floor(unit(k, i + 21) * 4)]!
    out.push({ s: wrapS(post.s + o * S.groundPitch), lateral: lat, role: 'marshal', pose, yawDeg: yaw, mount: 'trackside' })
  })
  return out
}

/** the marshals of every trackside post (`marshalSlots` over MARSHAL_POSTS) */
export function marshalPostFigures(): OpsFigure[] {
  return MARSHAL_POSTS.flatMap((m) => marshalSlots(m))
}

/** how far behind a BARRIERS run's line its back face is (m) — barriers.ts `barrierDepth`, restated here so the data stays three-free */
export function barrierDepthOf(run: Pick<BarrierRun, 'kind'>): number {
  return run.kind === 'tyre' ? 1.3 : run.kind === 'concrete' ? 0.35 : run.kind === 'fence' ? 0.05 : 0.14
}

/** a photographer at a fence window stands this far behind the wall's back face (m) */
export const WINDOW_PHOTOGRAPHER_BACK = 0.6

/**
 * The photographers at the fences' windows (I4-c): one per `windows` entry of every BARRIERS
 * run, behind the wall (the run's resolved line + its depth + WINDOW_PHOTOGRAPHER_BACK on the
 * spectator side), camera up, facing the track ± 15° (a deterministic hash) — mount
 * 'trackside' like the post marshals (O1 / O2 / ring / buildings apply, no pit window). Pure:
 * `lineAt(s, side)` resolves the run's line (trackside.ts `barrierLateralAt` in the app and the
 * guards); a window whose line cannot be resolved is skipped.
 */
export function windowSlots(lineAt: (s: number, side: 1 | -1) => number | null): OpsFigure[] {
  const out: OpsFigure[] = []
  for (const run of BARRIERS) {
    if (!run.windows?.length) continue
    const depth = barrierDepthOf(run)
    for (const w of run.windows) {
      const line = lineAt(w, run.side)
      if (line === null) continue
      const k = Math.round(w)
      const yaw = -run.side * 90 + (unit(k, 31) - 0.5) * 30
      out.push({ s: wrapS(w), lateral: line + run.side * (depth + WINDOW_PHOTOGRAPHER_BACK), role: 'photographer', pose: unit(k, 41) < 0.5 ? 'lookUp' : 'stand', yawDeg: yaw, mount: 'trackside' })
    }
  }
  return out
}

/** What `cameraSlots` needs of a TV tower: a TV_CAMERAS row resolved by tv-lens.ts (the centre lateral is a number here, never 'auto'). */
export interface TvTowerSlotInput {
  id: string
  s: number
  /** the tower's centre, metres from the centreline (+ = the driver's left) */
  lateral: number
  tower: 'scaffold' | 'lattice' | 'crane' | 'pole'
  /** the operator's floor above the road plane: the platform's deck top, the crane's base plate */
  floorY: number
}

/** where the camera operator stands on a tower, metres from its centre away from the track (the local −z of tv-towers.ts) */
export const CAMERA_OPERATOR = {
  /** on a platform: just behind the deck's centre, behind the tripod (its rear foot stands 0.5 m in front of the centre — tv-towers.ts) */
  deckBack: 0.05,
  /** at a crane: on the base plate behind the column (base 1.5, column r 0.25) */
  craneBack: 0.5,
} as const

/**
 * The camera operator of a TV tower (plan I4-b): one figure on a scaffold / lattice platform's
 * deck or on a crane's base plate — a 'roof' row (`y` = the floor in the road frame, like the
 * platform officials), facing the track; a bare pole offers none. tv-towers.ts feeds one
 * resolved row per tower and draws the result through `buildOpsFigures`; `figuresAt({ towers })`
 * appends the same rows for a reader that has the resolved towers (the smoke). Photographer
 * look (black): the broadcast crews dress dark.
 */
export function cameraSlots(t: TvTowerSlotInput): OpsFigure[] {
  if (t.tower === 'pole') return []
  const side = t.lateral < 0 ? -1 : 1
  const back = t.tower === 'crane' ? CAMERA_OPERATOR.craneBack : CAMERA_OPERATOR.deckBack
  // away from the track = further out on the tower's side; facing the track = looking to −side
  return [{ s: wrapS(t.s), lateral: t.lateral + side * back, role: 'photographer', pose: t.tower === 'crane' ? 'hips' : 'stand', yawDeg: -side * 90, y: t.floorY, mount: 'roof' }]
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
 * I3-b — the vehicles, hospitality units, tents, containers and the broadcast compound (plan
 * §I3-b). Every row below is a footprint with a `mount`; every coordinate derives from
 * OPS_LAYOUT (itself from PIT_BUILDING.v2 / PADDOCK_OFFICE / PADDOCK_PARKING / GARAGE_CENTRES)
 * — no literal stop lateral, no world coordinate. Rules: O1 (apron rows in the working area,
 * outside the car rectangles), O2, O3, O4, O5 (0.2 m off every barrier line), O6 (outside every
 * building footprint — the vehicle base's ring included), O12 (yard rows in the yard window, the
 * rest in the paddock / E paddock windows). Static vehicles never enter the race `models`
 * (e2e: models.length === 22).
 *
 * What the section decides beyond the layout table (the deviations, all recorded in the README):
 *  - the transporters park PARALLEL (`//`, nose to +s and to the paddock walk): two 45° trucks
 *    per 19 m block cannot form a V (the V's of neighbouring blocks cross), and a 12 × 2.5 body
 *    at 45° covers 10.25 m of lateral (the strip comment's 8.5 m ignores the width) — centred
 *    on truckStrip.lat its nose would enter the hospitality unit by 1.1 m, so the trucks stand
 *    `LAYOUT_B.truckLatShift` nearer the canopy (the tail lift 0.5 m off the drip line, the nose
 *    0.4 m off the unit);
 *  - block 5 (5769.5) keeps ONE truck: its +s slot is the rear spur's tunnel hall
 *    (PIT_BUILDING.v2.spur.hall 5771.5 → 5778.9 × −56.7 … −66); its hospitality unit slides
 *    `LAYOUT_B.spurUnitShift` to −s so its roof clears the 2F bridge (5773 → 5777, soffit 5.05 m);
 *  - the gazebos take the free pocket of each core gap (the +s truck's flank runs diagonally
 *    across the gap from its tail at boxS + 2 to its nose at boxS + 10.4): core.mid − 5.5 and
 *    core.mid − 2, not ± 2.5; the core beside the rear spur gets one at core.mid − 1;
 *  - the air-freight containers stand across the strip (yawDeg 90) at core.mid + 0.5 and 2.5 m
 *    nearer the canopy than containers.lat (at −66 their far end would meet the truck noses),
 *    six stacks (two-high at four cores, single at two) = 10 units;
 *  - the FIA safety car and the medical car wait in the pit-exit yard's lane-side strip
 *    (OPS_LAYOUT.vehicleBase.strip), not in OPS_LAYOUT.scPocket: the pocket's lateral (−24.3)
 *    is inside the T1 cap (the OSM outline 184422099 runs at −24.3 from s 92 to 103.3 and the
 *    paddock-information box fills 88 → 92 to the drip line) — there is no apron there;
 *  - the B-paddock marquees are three 15 × 15 units along s (yawDeg 0, 17 m pitch, 2 m aisles,
 *    −108.5 … −123.5 = the lot's flat band: the ground climbs 3.9 m across −124 … −143, so the
 *    plan's 35 × 15 units across the lot stood on one corner with the far wall 3.5 m under the
 *    slope): the B car park's bays are all under them or on the slope and paddock.ts drops them
 *    (its footprint rule reads `vehiclePlacements()`), the four 2 t trucks park on the band
 *    strip north of the marquees (−104.5, off the office road at −101, their bodies ending at
 *    −107.5);
 *  - the six vans stand in the gaps between the hospitality units (yawDeg 90 at −72, off the
 *    walkway −74.5 … −79.5 and 2.5 m off the truck noses), not in the walkway itself;
 *  - the E-paddock media marquee stands across the lot at (5496, −88), see `LAYOUT_B.marqueeE`;
 *    the compound's fence rows along s are 10 m rows, and ops-vehicles.ts draws every thin row
 *    (fence, cable ramp) from its world end to end — inside the pit-entry bend a row's (s, lat)
 *    rectangle is shorter in the world than its `size` says.
 */

/** the models the vehicle rows draw — ops-vehicles.ts pairs each with a pack GLB (or the car-glb van) and a procedural body */
export type OpsVehicleModel =
  | 'transporter' | 'truck2t' | 'van'
  | 'fiaSafetyCar' | 'medicalCar' | 'courseSafetyCar' | 'suv' | 'ambulance' | 'fireTender' | 'craneTruck' | 'towTruck' | 'tractor'

/**
 * Per model: the row kind, the nominal footprint [long, across, height] (the drawn GLB or
 * procedural body stays inside it ± 0.3 m — ops-smoke measures) and the paint [body, accent]
 * (sRGB hex; the accent is the band / light bar / roof).
 */
export const OPS_VEHICLE_MODELS: Record<OpsVehicleModel, { kind: OpsKind; size: [number, number, number]; tint: [string, string] }> = {
  transporter: { kind: 'truck', size: [12.0, 2.5, 3.9], tint: ['#f4f4f0', '#ffffff'] },
  truck2t: { kind: 'truck', size: [6.0, 2.0, 2.8], tint: ['#f4f4f0', '#f4f4f0'] },
  van: { kind: 'vehicle', size: [4.7, 1.8, 1.95], tint: ['#e9e9e4', '#e9e9e4'] },
  /** the FIA safety car: a red coupé with a light bar */
  fiaSafetyCar: { kind: 'vehicle', size: [4.8, 2.0, 1.55], tint: ['#c8101c', '#ff9a1a'] },
  /** the medical car: silver estate with a red band */
  medicalCar: { kind: 'vehicle', size: [4.9, 2.0, 1.6], tint: ['#c9cbcd', '#c8101c'] },
  /** the circuit's own safety car: a yellow hatch, black roof, LED bar */
  courseSafetyCar: { kind: 'vehicle', size: [4.6, 1.9, 1.8], tint: ['#f2c400', '#121214'] },
  suv: { kind: 'vehicle', size: [4.8, 2.0, 1.85], tint: ['#141416', '#141416'] },
  ambulance: { kind: 'vehicle', size: [5.4, 2.4, 2.6], tint: ['#f4f4f0', '#c8101c'] },
  fireTender: { kind: 'vehicle', size: [4.8, 1.9, 2.3], tint: ['#c8101c', '#c8101c'] },
  /** the cargo crane truck: a yellow flatbed with a folded boom */
  craneTruck: { kind: 'crane', size: [5.8, 2.2, 3.4], tint: ['#f2b400', '#f2b400'] },
  towTruck: { kind: 'vehicle', size: [6.2, 2.2, 2.8], tint: ['#f4f4f0', '#f2b400'] },
  /** the gravel tractor: a procedural box on four wheels */
  tractor: { kind: 'vehicle', size: [3.8, 2.0, 2.8], tint: ['#2f6a3a', '#121214'] },
}

/** the model a vehicle / truck / crane row draws: the id's first segment (`<model>-…`) */
export function vehicleModelOf(id: string): OpsVehicleModel | null {
  const head = id.slice(0, id.indexOf('-') < 0 ? id.length : id.indexOf('-'))
  return head in OPS_VEHICLE_MODELS ? (head as OpsVehicleModel) : null
}

/** the four corners of a placement's footprint in (s, lateral): size [long, across], yawDeg about up (0 = the long side along +s) — the guard's `cornersOf` */
export function placementCorners(p: Pick<OpsPlacement, 's' | 'lateral' | 'yawDeg' | 'size'>): [number, number][] {
  const a = p.size[0] / 2, b = p.size[1] / 2
  const yaw = (p.yawDeg * Math.PI) / 180
  const c = Math.cos(yaw), sn = Math.sin(yaw)
  return ([[a, b], [a, -b], [-a, -b], [-a, b]] as const).map(([u, v]) => [wrapS(p.s + u * c - v * sn), p.lateral + u * sn + v * c])
}

const LAYOUT_B = {
  /** the trucks stand this much nearer the canopy than truckStrip.lat (see the section comment) */
  truckLatShift: 1.5,
  /** the nose points to +s and to the walk (yawDeg −45: the layout's 45° lean, the sign is the frame's) */
  truckYawDeg: -OPS_LAYOUT.truckStrip.yawDeg,
  /** block 5's hospitality unit slides this much to −s (its +s end 1.5 m short of the 2F bridge) */
  spurUnitShift: 3.0,
  /** the gazebos' s offsets from core.mid; the core beside the rear spur (its −s pocket is the tunnel hall) gets one at gazeboDSHall */
  gazeboDS: [-5.5, -2] as readonly number[],
  gazeboDSHall: [-1] as readonly number[],
  /** the air-freight stacks: s offset from core.mid, how many units per core (the T1 end first) */
  aircargo: { dS: 0.5, units: [2, 2, 2, 2, 1, 1] as readonly number[] },
  /** the vans between the hospitality units: the gaps (mid s) they stand in, the lateral, across the strip */
  vans: { lat: OPS_LAYOUT.hospitality.lat - 1.0, yawDeg: 90 },
  /** the 2 t trucks on the band strip north of the B-paddock marquees, nose to the marquees */
  truck2t: { s: [8, 17, 26, 35] as readonly number[], lat: -104.5, yawDeg: -90 },
  /** the B-paddock marquees stand along s (15 × 15, the long side along the lot's flat band) */
  marqueeYawDeg: 0,
  /**
   * The E-paddock media marquee also stands across the lot (its 20 m along lateral: a radial
   * line, straight in the world), 16 m past the layout's s — the E paddock lies inside the
   * pit-entry bend, where 20 m of s at lateral −92 is a 15 m chord, and at the layout's s it
   * would sit on the compound's south fence.
   */
  marqueeE: { dS: 16, lat: -88, yawDeg: 90 },
  /**
   * The broadcast compound inside OPS_LAYOUT.compound, on the paved part of OSM 474537492
   * (its north edge runs −42.6 at s 5451 → −51.2 at 5490, its south edge −84.4 → −80.8). The
   * paving is flat only over −51 … −63.6 (the E lot's relief ring starts at −66 and climbs
   * 3.2 m by −80), so everything rigid stays in that band (ops-smoke fails a rigid instance
   * whose four ground corners spread more than 0.3 m): the white pipe fence 1.1 m (drawn per
   * panel on the ground, it may run down the slope), six 40 ft containers ALONG s in three
   * rows at 4 m pitch (two units end to end per row, 1.56 m aisles; every corner spread
   * ≤ 0.25 m — across the enclosure a 12.2 m unit reached the slope), the three dishes and the
   * two generators at the +s end, one cable-ramp run across the yard between the containers
   * and the dishes.
   */
  compound: {
    fence: { s: [5448, 5488] as [number, number], lat: [-51.5, -80] as [number, number], h: 1.1, gate: { lat: [-63, -69] as [number, number] } },
    containers: { s: [5454.2, 5466.6] as readonly number[], lat: [-53.5, -57.5, -61.5] as readonly number[], yawDeg: 0, size: [12.2, 2.44, 2.9] as [number, number, number] },
    dishes: { s: 5476, lat: [-54, -58, -62] as readonly number[], size: [3.0, 3.0, 3.4] as [number, number, number] },
    generators: { s: 5484, lat: [-57, -61] as readonly number[], size: [2.6, 1.3, 2.0] as [number, number, number] },
    cableRamp: { s: 5473.8, lat: [-54, -78] as [number, number], size: [0.9, 0.3, 0.06] as [number, number, number] },
  },
  /** the course vehicles on the base's apron (two rows nose to its roll doors) and the yard's lane-side strip */
  base: {
    doorRow: { s: OPS_LAYOUT.vehicleBase.apron.s[1] - 3.5, lat: [-37.5, -40.2, -42.9] as readonly number[] },
    backRow: { s: OPS_LAYOUT.vehicleBase.apron.s[0] + 6, lat: [-38.0, -41.5, -44.6] as readonly number[] },
    strip: { lat: -30, s: [154, 160, 168, 174, 180, 186] as readonly number[] },
  },
} as const

/** the vehicle rows: the transporters, the 2 t trucks, the vans, the safety / medical / course cars, the crane */
function vehicleRows(): OpsPlacement[] {
  const out: OpsPlacement[] = []
  const row = (id: string, model: OpsVehicleModel, s: number, lateral: number, yawDeg: number, mount: OpsMount, team?: TeamId): OpsPlacement => {
    const m = OPS_VEHICLE_MODELS[model]
    return { id, kind: m.kind, s: wrapS(s), lateral, yawDeg, size: m.size, mount, tint: m.tint, ...(team ? { team } : {}) }
  }
  const T = OPS_LAYOUT.truckStrip
  const hall = V2.spur.hall.sRange
  for (let g = 0; g < GARAGE_ORDER.length; g++) {
    const team = GARAGE_ORDER[g]!
    const c = garageS(g)
    for (const [k, sign] of [['a', -1], ['b', 1]] as const) {
      const s = wrapS(c + sign * T.dS)
      // the +s slot of block 5 is the rear spur's tunnel hall
      if (inArcS(s, hall)) continue
      out.push(row(`transporter-${g}${k}`, 'transporter', s, T.lat + LAYOUT_B.truckLatShift, LAYOUT_B.truckYawDeg, 'paddock', team))
    }
  }
  LAYOUT_B.truck2t.s.forEach((s, i) => out.push(row(`truck2t-${i}`, 'truck2t', s, LAYOUT_B.truck2t.lat, LAYOUT_B.truck2t.yawDeg, 'paddock')))
  vanSlots().forEach((s, i) => out.push(row(`van-${i}`, 'van', s, LAYOUT_B.vans.lat, LAYOUT_B.vans.yawDeg, 'paddock')))
  // the base's apron: the course SC and the two SUVs at the roll doors, the crane / tow truck / tractor behind them
  const B = LAYOUT_B.base
  out.push(row('courseSafetyCar', 'courseSafetyCar', B.doorRow.s, B.doorRow.lat[0]!, 0, 'yard'))
  out.push(row('suv-0', 'suv', B.doorRow.s, B.doorRow.lat[1]!, 0, 'yard'))
  out.push(row('suv-1', 'suv', B.doorRow.s, B.doorRow.lat[2]!, 0, 'yard'))
  out.push(row('craneTruck', 'craneTruck', B.backRow.s, B.backRow.lat[0]!, 0, 'yard'))
  out.push(row('towTruck', 'towTruck', B.backRow.s, B.backRow.lat[1]!, 0, 'yard'))
  out.push(row('tractor', 'tractor', B.backRow.s, B.backRow.lat[2]!, 0, 'yard'))
  // the lane-side strip: the FIA safety car and the medical car nearest the pit exit, the ambulances, the fire tenders
  const strip = B.strip.s
  out.push(row('fiaSafetyCar', 'fiaSafetyCar', strip[0]!, B.strip.lat, 0, 'yard'))
  out.push(row('medicalCar', 'medicalCar', strip[1]!, B.strip.lat, 0, 'yard'))
  out.push(row('ambulance-0', 'ambulance', strip[2]!, B.strip.lat, 0, 'yard'))
  out.push(row('ambulance-1', 'ambulance', strip[3]!, B.strip.lat, 0, 'yard'))
  out.push(row('fireTender-0', 'fireTender', strip[4]!, B.strip.lat, 0, 'yard'))
  out.push(row('fireTender-1', 'fireTender', strip[5]!, B.strip.lat, 0, 'yard'))
  return out
}

/** the hospitality unit's centre s of team block `g`: boxS, except block 5's slides off the spur bridge */
export function hospitalityS(g: number): number {
  const c = garageS(g)
  const br = V2.spur.bridge.sRange
  const reach = OPS_LAYOUT.hospitality.size[0] / 2 + 1.5
  // the unit (boxS ± half) would overlap the bridge's span ± 1.5 m
  const overlaps = forwardS(wrapS(br[0] - reach), c) <= forwardS(br[0], br[1]) + 2 * reach
  return overlaps ? wrapS(c - LAYOUT_B.spurUnitShift) : c
}

/** the s of the six van slots: the mid-gap between neighbouring hospitality units where the gap is ≥ 9 m, the four 19 m gaps and two core gaps */
function vanSlots(): number[] {
  const out: number[] = []
  const half = OPS_LAYOUT.hospitality.size[0] / 2
  const units = GARAGE_ORDER.map((_, g) => hospitalityS(g))
  // blocks run from the T1 end toward the final corner: the gap between unit g (higher s) and g + 1
  const picks = [[0, 1], [1, 2], [3, 4], [7, 8], [8, 9], [9, 10]] as const
  for (const [a, b] of picks) {
    const hi = units[a]!, lo = units[b]!
    const gap = forwardS(lo + half, hi - half)
    if (gap < 9) continue
    out.push(wrapS(lo + half + gap / 2))
  }
  return out
}

/** the hospitality units (`kind 'cabin'`, one per team), the gazebos, the air-freight containers behind the cores */
function paddockRows(): OpsPlacement[] {
  const out: OpsPlacement[] = []
  const H = OPS_LAYOUT.hospitality
  for (let g = 0; g < GARAGE_ORDER.length; g++) {
    out.push({ id: `hospitality-${g}`, kind: 'cabin', s: hospitalityS(g), lateral: H.lat, yawDeg: 0, size: H.size, mount: 'paddock', team: GARAGE_ORDER[g]! })
  }
  const G = OPS_LAYOUT.gazebos, C = OPS_LAYOUT.containers
  const hall = V2.spur.hall.sRange
  const half = G.size[0] / 2 + 1
  /** the gazebo at core.mid + d would overlap the rear spur's tunnel hall (± 1 m) */
  const onHall = (mid: number, d: number) => forwardS(wrapS(hall[0] - half), wrapS(mid + d)) <= forwardS(hall[0], hall[1]) + 2 * half
  coreEdges().forEach((core, i) => {
    // the core beside the spur keeps one gazebo in the pocket between the hall and the next truck
    const ds = LAYOUT_B.gazeboDS.filter((d) => !onHall(core.mid, d))
    ;(ds.length ? ds : LAYOUT_B.gazeboDSHall).forEach((d, k) => out.push({ id: `gazebo-${i}${k === 0 ? 'a' : 'b'}`, kind: 'tent', s: wrapS(core.mid + d), lateral: G.lat, yawDeg: 0, size: G.size, mount: 'paddock' }))
    const units = LAYOUT_B.aircargo.units[i] ?? 0
    for (let level = 0; level < units; level++) {
      out.push({ id: `aircargo-${i}-${level}`, kind: 'container', s: wrapS(core.mid + LAYOUT_B.aircargo.dS), lateral: C.lat + 2.5, yawDeg: 90, size: C.size, mount: 'paddock', ...(level ? { y: level * C.size[2] } : {}) })
    }
  })
  return out
}

/** the marquees: three across the B paddock, the media marquee at the E paddock's edge */
function marqueeRows(): OpsPlacement[] {
  const M = OPS_LAYOUT.marquees
  const out: OpsPlacement[] = M.b.s.map((s, i) => ({ id: `marquee-b${i}`, kind: 'tent' as const, s: wrapS(s), lateral: M.b.lat, yawDeg: LAYOUT_B.marqueeYawDeg, size: M.b.size, mount: 'paddock' as const }))
  const ME = LAYOUT_B.marqueeE
  out.push({ id: 'marquee-e', kind: 'tent', s: wrapS(M.e.s + ME.dS), lateral: ME.lat, yawDeg: ME.yawDeg, size: M.e.size, mount: 'paddock' })
  return out
}

/** the broadcast compound in the E paddock reserve: containers, dishes, generators, the cable ramp, the pipe fence and its gate */
function compoundRows(): OpsPlacement[] {
  const K = LAYOUT_B.compound
  const out: OpsPlacement[] = []
  K.containers.lat.forEach((lat, r) => K.containers.s.forEach((s, i) => out.push({ id: `bc-container-${r}${i}`, kind: 'container', s, lateral: lat, yawDeg: K.containers.yawDeg, size: K.containers.size, mount: 'paddock' })))
  K.dishes.lat.forEach((lat, i) => out.push({ id: `bc-dish-${i}`, kind: 'equipment', s: K.dishes.s, lateral: lat, yawDeg: 0, size: K.dishes.size, mount: 'paddock' }))
  K.generators.lat.forEach((lat, i) => out.push({ id: `bc-generator-${i}`, kind: 'generator', s: K.generators.s, lateral: lat, yawDeg: 90, size: K.generators.size, mount: 'paddock' }))
  const R = K.cableRamp
  out.push({ id: 'bc-cable-ramp', kind: 'equipment', s: R.s, lateral: (R.lat[0] + R.lat[1]) / 2, yawDeg: 90, size: [Math.abs(R.lat[1] - R.lat[0]), R.size[1], R.size[2]], mount: 'paddock' })
  // the fence: four sides as 'barrier' rows (0.05 m rails) — the two sides along s in 10 m rows, since a
  // row is a straight box in its centre's frame and the E paddock's straight bends (R ≈ 140 m) — the +s
  // side split around the gate, the gate leaf open at 60°
  const F = K.fence
  const latMid = (F.lat[0] + F.lat[1]) / 2, latLen = Math.abs(F.lat[1] - F.lat[0])
  const rowsAlongS = Math.ceil((F.s[1] - F.s[0]) / 10), rowLen = (F.s[1] - F.s[0]) / rowsAlongS
  for (let i = 0; i < rowsAlongS; i++) {
    const s = F.s[0] + rowLen * (i + 0.5)
    out.push({ id: `bc-fence-n${i}`, kind: 'barrier', s, lateral: F.lat[0], yawDeg: 0, size: [rowLen, 0.05, F.h], mount: 'paddock' })
    out.push({ id: `bc-fence-s${i}`, kind: 'barrier', s, lateral: F.lat[1], yawDeg: 0, size: [rowLen, 0.05, F.h], mount: 'paddock' })
  }
  out.push({ id: 'bc-fence-w', kind: 'barrier', s: F.s[0], lateral: latMid, yawDeg: 90, size: [latLen, 0.05, F.h], mount: 'paddock' })
  const [g0, g1] = F.gate.lat
  out.push({ id: 'bc-fence-e0', kind: 'barrier', s: F.s[1], lateral: (F.lat[0] + g0) / 2, yawDeg: 90, size: [Math.abs(g0 - F.lat[0]), 0.05, F.h], mount: 'paddock' })
  out.push({ id: 'bc-fence-e1', kind: 'barrier', s: F.s[1], lateral: (g1 + F.lat[1]) / 2, yawDeg: 90, size: [Math.abs(F.lat[1] - g1), 0.05, F.h], mount: 'paddock' })
  const gateW = Math.abs(g1 - g0)
  // the leaf hangs on the north post (F.s[1], g0) and stands open at 60° to +s / −lateral
  out.push({ id: 'bc-gate', kind: 'barrier', s: F.s[1] + (gateW / 2) * Math.cos(Math.PI / 3), lateral: g0 - (gateW / 2) * Math.sin(Math.PI / 3), yawDeg: -60, size: [gateW, 0.05, F.h], mount: 'paddock' })
  return out
}

export function vehiclePlacements(): OpsPlacement[] {
  return [...vehicleRows(), ...paddockRows(), ...marqueeRows(), ...compoundRows()]
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
 * I3-c — the pit-lane equipment and the pit-wall perches v2 (plan §I3-c). Every apron row
 * lies inside PIT_ENVELOPE.workArea, outside `stoppedCarRect(block)` of every block and out
 * of every `lensColumns()` path; every coordinate derives from PIT_ENVELOPE.stop (through
 * `fromStop`), the garage table and PIT_WALL — no literal stop lateral. The rows are what
 * ops-pit.ts draws and what facilities-check §16 / ops-smoke `checkPitEquipment` verify.
 *
 * Two envelope facts shape the layout beyond OPS_LAYOUT (section A):
 *  - §16 O1 keeps the analytic pit keep-out [c − keepOut.back, …] = [−21.1, −9.1] along the
 *    whole box strip, so nothing static may stand left of `KEEP_OUT_EDGE` (−21.1): the cones
 *    cannot line the working lane's edge (OPS_LAYOUT.cones.lat −19.5) and the cable ramps
 *    cannot start at −19.3 — both start at the keep-out edge instead;
 *  - a car arriving at the NEXT block drives the last 25 m AT the stop lateral (race.ts
 *    switches to PIT_PLANNED.stopLateral 100 m before the box; measured over the 53-lap race
 *    × 3 seeds: centre ≤ stop + 0.5 from 24 m out, ≤ + 0.11 from 14 m out, + 0.00 over the
 *    last 2 m; the crowded harness adds queued cars waiting at stop + 2.0), so the whole strip
 *    stop ± 0.95 (PIT_ENVELOPE.carHalf) outside a block's own car rectangle is car space —
 *    every equipment row therefore stands on the garage side of the stop line: both jacks at
 *    stop − 1.8, the cones at stop − 2.0 in front of the cores (I3-c had the front jack on the
 *    stop line and the cones at stop + 0.8: every car pitting at block g drove over block
 *    g + 1's jack and the cones before its box). A car leaving holds the stop lateral for
 *    PIT_EXIT_HOLD_M and then steers for the lane (the crew rows of section A say what that
 *    clears); the sim does not collide with the static layer.
 *
 * The fallback stop (§横断 2, stop inside the auxiliary lane): `fromStop` folds every offset
 * to the right of the lane's outer edge (FOLD_BASE), the lane-side reach of the gantry arms
 * goes to zero — the same function, numbers only (not exercised: PIT_PLANNED.stopLateral is
 * in the working area).
 *
 * Heights: apron / interior rows stand on the ground (`y` omitted); the gantry's beam row is
 * mount 'roof' with `y` = its underside over the apron (it hangs on the posts, which carry the
 * ground rules — O3 still sees it); wall rows carry in `y` the road-frame height of what they
 * stand on (the walkway +0.5 or the fixed platform's deck +1.3), the builder places them in
 * the road frame like pit-lane.ts.
 */

/** the lane-side limit of anything static along the box strip: the analytic keep-out's right edge (§16 O1) */
export const KEEP_OUT_EDGE = CIRCUIT.pit.laneOffset - E.keepOut.back
/** is the stop line inside the working area (the planned −23.5) or in the auxiliary lane (the fallback −17.1)? */
const FOLDED = !inWorkArea(E.stop, E.carHalf * 2)
/** the fallback's reference line: 0.4 m right of the working lane's outer edge, where the garage-side offsets hang from */
const FOLD_BASE = E.lanes[0] - 0.4
/** the lateral of a row placed `dLat` from the stop line (lane side positive); folded onto the lane edge in the fallback */
export function fromStop(dLat: number): number {
  return FOLDED ? FOLD_BASE + Math.min(dLat, 0) : E.stop + dLat
}

/**
 * The pit equipment's own numbers (plan §I3-c), read by `pitEquipmentPlacements()` and by
 * ops-pit.ts for the parts that hang on a row (the gantry's arms, lamps and guns; the perch's
 * monitors, stools, umbrellas). Offsets: `dS` from boxS, `dLat` from the stop line.
 */
export const PIT_EQUIPMENT = {
  /**
   * The gantry: OPS_LAYOUT.gantry's two posts on the garage side; a beam along s between the
   * post tops; two arms across the car at the wheel lines (dS ± 1.7) from the posts' line to
   * `laneReach` on the lane side — never past the keep-out edge (2.3 m at the planned stop,
   * 0 in the fallback); the signal box hangs under the front arm over the car's centre line,
   * the four wheel guns hang on hoses under the arms over the wheels (`gunLat` ± = the car's
   * track), their bottoms `gunBottom` above the apron (over the car — the one thing that is
   * allowed inside the stopped-car rectangle, 1.15 m up).
   */
  gantry: {
    ...OPS_LAYOUT.gantry,
    laneReach: Math.max(0, Math.min(OPS_LAYOUT.gantry.beamHalf, KEEP_OUT_EDGE - 0.1 - E.stop)),
    beam: 0.2,
    arm: { dS: [-1.7, 1.7] as readonly number[], section: 0.15 },
    guns: { dLat: [-0.85, 0.85] as readonly number[], size: [0.35, 0.12, 0.25] as [number, number, number], bottom: 1.15 },
    lights: { dS: 1.7, size: [0.5, 0.3, 0.4] as [number, number, number], top: 3.7, lamps: 4 },
  },
  /**
   * Three tyre stacks (4 tyres in a team-colour blanket, a bare tyre on top) on the garage side
   * at OPS_LAYOUT.tyreStacks.dS, 0.7 m further back than the layout's dLat (−3.9): the two
   * tyre men of the crew table stand at (−6 / −7.5, −3.2) — beside, not inside, the stacks.
   */
  tyreStacks: { dS: OPS_LAYOUT.tyreStacks.dS, dLat: OPS_LAYOUT.tyreStacks.dLat - 0.7, size: [0.7, 0.7, 1.3] as [number, number, number] },
  /** the front / rear jacks at boxS ± dS, both on the garage side at stop + dLat (OPS_LAYOUT.jacks; long side along s) */
  jacks: OPS_LAYOUT.jacks,
  /**
   * The fuel drum + hose trolley inside the garage, 1.5 m behind the equipment front (−30.5):
   * OPS_LAYOUT.fuel.lat (−33) is where pit-building.ts stacks the garage tyres, so the trolley
   * stands in front of them, behind the shutter line.
   */
  fuel: { dS: OPS_LAYOUT.fuel.dS, lat: V2.interior.equipmentFront - 1.5, size: [1.2, 0.8, 1.2] as [number, number, number] },
  /**
   * The monitor stand (1.9 m, two screens on a frame) on the garage side at +dS: the layout's
   * (−7, −3.5) sat on the second tyre stack, and the −s garage front is where the crew table
   * puts the rear-jack man; the +s side is free of everything but the front jack and the fuel.
   */
  monitor: { dS: 6, dLat: OPS_LAYOUT.monitor.dLat - 0.4, size: [1.2, 0.5, OPS_LAYOUT.monitor.h] as [number, number, number] },
  /**
   * Five green cones per core in front of the core's doors (no stopped car there): from the
   * core's −s face + 0.4 every 0.9 m (none on the centre line: the cable ramps run there),
   * stopping 3 m short of its +s face — the lens → car path of the block beyond the core
   * starts 1.5 m before that face. Garage side at stop − 2.0: the lane side stop + 0.8 lies
   * inside the arriving car's body band (PIT_ENVELOPE.carHalf 0.95 about the stop lateral),
   * 1.1 m off the core-face marshals at −26.6 and outside the next lens column's stop ± 1.5.
   */
  cones: { perCore: 5, fromFace: 0.4, pitch: 0.9, dLat: -2.0, size: [0.35, 0.35, 0.5] as [number, number, number] },
  /** the cable ramps (yellow / black, 1 m segments across the apron) at every core's centre line, from the keep-out edge to the shutter */
  cableRamps: { lat: [KEEP_OUT_EDGE - 0.1, V2.shutter + 0.1] as [number, number], segment: 1.0, size: [0.3, 1.0, 0.05] as [number, number, number] },
  /** one wheeled extinguisher (red) in front of every pit's +s pier, 0.45 m off the shutter line */
  extinguishers: { lat: V2.shutter + 0.45, dS: V2.garage.boxPitch / 2, blockPierInset: 0.2, size: [0.4, 0.4, 1.0] as [number, number, number] },
  /**
   * The pit-wall perches v2: OPS_LAYOUT.pitWallPerch's frame on the walkway (or on the fixed
   * platform's deck, 1.0 m wide between its parapet and the wall), the desk at `desk`, four
   * monitors on it facing the seated crew, three stools (seat +1.45 ≈ OPS_LAYOUT.pitWallPerch.seat),
   * the team-colour canopy on top, two umbrellas (3.2 m, over the canopy) standing on the walkway
   * `umbrella.dS` past the frame's ends — the pit board keeps `board.dS` clear of the +s one.
   */
  perch: { ...OPS_LAYOUT.pitWallPerch, onPlatform: { width: 1.0, lat: WALKWAY_CENTRE + 0.05 }, desk: 1.75, monitors: { n: 4, size: [0.55, 0.35] as [number, number] }, umbrella: { d: 1.4, top: 3.2, dS: 0.4 }, canopy: 0.06 },
  /** the pit board (a panel 0.8 × 0.5 propped upright, handle down, 1.2 m in all) leaning on the wall's lane face past every perch's +s umbrella (off the cabinets' lateral) */
  board: { dS: OPS_LAYOUT.pitWallPerch.size[0] / 2 + 1.0, lat: PIT_WALL.walkway.from - 0.1, size: [0.8, 0.1, 1.2] as [number, number, number] },
  /** the fixed platform: two TV cameras on tripods and a monitor stand on the deck, at s clear of the perches and the cabinets */
  platform: { cameras: [40, 60] as readonly number[], monitor: 45.5, lat: WALKWAY_CENTRE + 0.15, cameraSize: [0.5, 0.5, 1.7] as [number, number, number], monitorSize: [0.6, 0.5, 1.2] as [number, number, number], head: 1.4 },
} as const

/** the fixed platform's s range, the perches / boards on it stand on the deck (PIT_WALL.platform.y) */
const PLATFORM = PIT_WALL.platform.sRange
/** does the frame [s − half, s + half] lie entirely on the fixed platform / entirely off it? */
function platformSpan(s: number, half: number): 'on' | 'off' | 'straddles' {
  const on0 = inArcS(wrapS(s - half), PLATFORM), on1 = inArcS(wrapS(s + half), PLATFORM)
  return on0 && on1 ? 'on' : !on0 && !on1 ? 'off' : 'straddles'
}

/**
 * The centre s of `block`'s pit-wall perch: boxS, unless the frame would stand in the
 * starter's rostrum (PIT_WALL.rostrum + its stair, block 4 at s 7.5: the perch moves past the
 * +s end of the stair with its −s umbrella, s ≈ 10.1 → 15.6) or straddle the fixed platform's end (block 3 at
 * s 33.5, the platform starts at 31: the perch moves onto the deck, s ≈ 31.5 → 37.0).
 */
export function perchCentreS(block: number): number {
  const c = garageS(block)
  const half = OPS_LAYOUT.pitWallPerch.size[0] / 2
  const r = PIT_WALL.rostrum
  const rostrum: [number, number] = [wrapS(r.s - r.size[0] / 2 - 0.3), wrapS(r.s + r.size[0] / 2 + r.steps * 0.28 + 0.3)]
  if (inArcS(wrapS(c - half), rostrum) || inArcS(wrapS(c + half), rostrum) || inArcS(r.s, [wrapS(c - half), wrapS(c + half)])) return wrapS(rostrum[1] + PIT_EQUIPMENT.perch.umbrella.dS + 0.2 + half)
  const span = platformSpan(c, half)
  if (span === 'straddles') {
    const d0 = forwardS(PLATFORM[0], c), d1 = forwardS(c, PLATFORM[1])
    return d0 < d1 ? wrapS(PLATFORM[0] + 0.5 + half) : wrapS(PLATFORM[1] - 0.5 - half)
  }
  return c
}

/** whether `block`'s perch stands on the fixed platform's deck (a narrower frame, base PIT_WALL.platform.y) */
export function perchOnPlatform(block: number): boolean {
  return platformSpan(perchCentreS(block), OPS_LAYOUT.pitWallPerch.size[0] / 2) === 'on'
}

export function pitEquipmentPlacements(): OpsPlacement[] {
  const out: OpsPlacement[] = []
  const Q = PIT_EQUIPMENT
  const row = (p: OpsPlacement) => out.push({ ...p, s: wrapS(p.s) })
  for (let g = 0; g < PIT_GARAGE_COUNT; g++) {
    const c = garageS(g)
    const team = GARAGE_ORDER[g]
    // the extinguishers stand at every pit of the row, the empty bay included
    for (let pit = 0; pit < 4; pit++) {
      const pitCentre = c + (pit - 1.5) * V2.garage.boxPitch
      const pier = pit === 3 ? pitCentre + Q.extinguishers.dS - Q.extinguishers.blockPierInset : pitCentre + Q.extinguishers.dS
      row({ id: `extinguisher-${g}-${pit}`, kind: 'equipment', s: pier, lateral: Q.extinguishers.lat, yawDeg: 0, size: Q.extinguishers.size, mount: 'apron', tint: ['#c8201c', '#2a2a2c'] })
    }
    if (!team) continue
    // the gantry: two posts on the garage side, the beam / arms / lights / guns as one row with its underside 3.85 m up
    const G = Q.gantry
    for (const [i, sign] of [-1, 1].entries()) row({ id: `gantry-post-${g}-${i}`, kind: 'equipment', s: c + sign * G.dS, lateral: fromStop(G.dLat), yawDeg: 0, size: [G.post, G.post, G.h], mount: 'apron', team })
    const garageEdge = fromStop(G.dLat) - G.post / 2, laneEdge = fromStop(G.laneReach)
    row({ id: `gantry-beam-${g}`, kind: 'equipment', s: c, lateral: (garageEdge + laneEdge) / 2, yawDeg: 0, y: G.h - G.beam - G.arm.section, size: [2 * G.dS, Math.max(0.3, laneEdge - garageEdge), G.beam + G.arm.section], mount: 'roof', team })
    // the tyre stacks, the jacks, the fuel trolley, the monitor stand
    Q.tyreStacks.dS.forEach((dS, i) => row({ id: `tyres-${g}-${i}`, kind: 'tyres', s: c + dS, lateral: fromStop(Q.tyreStacks.dLat), yawDeg: 0, size: Q.tyreStacks.size, mount: 'apron', team }))
    row({ id: `jack-${g}-front`, kind: 'trolley', s: c + Q.jacks.dS, lateral: fromStop(Q.jacks.dLat), yawDeg: 0, size: Q.jacks.size, mount: 'apron', team })
    row({ id: `jack-${g}-rear`, kind: 'trolley', s: c - Q.jacks.dS, lateral: fromStop(Q.jacks.dLat), yawDeg: 0, size: Q.jacks.size, mount: 'apron', team })
    row({ id: `fuel-${g}`, kind: 'trolley', s: c + Q.fuel.dS, lateral: Q.fuel.lat, yawDeg: 0, size: Q.fuel.size, mount: 'interior', team })
    row({ id: `monitor-${g}`, kind: 'equipment', s: c + Q.monitor.dS, lateral: fromStop(Q.monitor.dLat), yawDeg: 0, size: Q.monitor.size, mount: 'apron', team })
    // the pit-wall perch v2 and its pit board
    const ps = perchCentreS(g)
    const onDeck = perchOnPlatform(g)
    const P = Q.perch
    row({ id: `perch-${g}`, kind: 'cabin', s: ps, lateral: onDeck ? P.onPlatform.lat : P.lat, yawDeg: 0, y: onDeck ? PIT_WALL.platform.y : PIT_WALL.walkway.y, size: [P.size[0], onDeck ? P.onPlatform.width : P.size[1], P.size[2]], mount: 'wall', team })
    row({ id: `board-${g}`, kind: 'board', s: ps + Q.board.dS, lateral: Q.board.lat, yawDeg: 0, y: onDeck ? PIT_WALL.platform.y : PIT_WALL.walkway.y, size: Q.board.size, mount: 'wall', team })
  }
  // the cores: five cones in front of the doors, the cable ramps across the apron on the centre line
  for (const core of coreEdges()) {
    for (let i = 0; i < Q.cones.perCore; i++) row({ id: `cone-${core.core}-${i}`, kind: 'cone', s: core.s[0] + Q.cones.fromFace + i * Q.cones.pitch, lateral: fromStop(Q.cones.dLat), yawDeg: 0, size: Q.cones.size, mount: 'apron', tint: ['#2f9e4a', '#111214'] })
    const [l0, l1] = Q.cableRamps.lat
    const n = Math.floor((l0 - l1) / Q.cableRamps.segment + 1e-6)
    for (let i = 0; i < n; i++) row({ id: `cable-${core.core}-${i}`, kind: 'equipment', s: core.mid, lateral: l0 - (i + 0.5) * Q.cableRamps.segment, yawDeg: 0, size: Q.cableRamps.size, mount: 'apron', tint: ['#e8b400', '#141414'] })
  }
  // the fixed platform: two TV cameras and a monitor stand on the deck
  const F = Q.platform
  F.cameras.forEach((s, i) => row({ id: `tvcam-${i}`, kind: 'camera', s, lateral: F.lat, yawDeg: 0, y: PIT_WALL.platform.y, size: F.cameraSize, mount: 'wall' }))
  row({ id: 'platform-monitor', kind: 'equipment', s: F.monitor, lateral: F.lat, yawDeg: 0, y: PIT_WALL.platform.y, size: F.monitorSize, mount: 'wall' })
  return out
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
 * I3-d — the people of the ops layer (plan §I3-d, `figuresAt()` ≈ 295: the terrace guests are
 * the pit building's own `ops-terrace`, the trackside posts' marshals are I4-a's `marshalSlots`):
 *  - the pit crew: `crewSlots(block)` for every team block (12 each, section A) and
 *    `perchSeats(block)` (3 seated on the perch's stools, mount 'wall');
 *  - officials (white over dark): OPS_LAYOUT.officials — two at every core's pit-side door,
 *    six on the fixed platform's deck (y platform.y, mount 'wall'), four on the podium's flat
 *    2F terrace (y floors[1], mount 'roof'), two at the pit-exit light, three at the pit entry;
 *  - marshals (orange, white helmets): OPS_LAYOUT.marshals — one at each of the twelve core
 *    faces on the apron, four in the pit-exit yard, two on the entry apron — and, since I4-a,
 *    the trackside posts' marshals (section A `marshalSlots` over MARSHAL_POSTS: one on every
 *    stand's deck, the rest on the ground between the fence and the stand);
 *  - photographers (black): five on the platform's lane edge, four behind the exit-yard wall,
 *    two by the E paddock's media marquee;
 *  - staff (grey over black, walking / standing): 60 in the paddock — the 5 m walkway between
 *    the hospitality units and the team offices' pit-side porch (walkers at `STAFF.walkLat`,
 *    standing pairs at `STAFF.standLat`, the office rows E / D / C / WC / B / A), the gaps
 *    between the hospitality units (beside the vans), the centre house's forecourt — 8 in the
 *    broadcast compound's free aisles, 6 at the vehicle base between its parked rows.
 * Facing: `yawDeg` 0 = +s, +90 = +lateral (the track side); the crew face the car, the
 * wall-top rows and the marshals face the track, walkers look along the walkway. Every point
 * passes §16 O1–O4 / O9 / O12 (the guard) and stands outside every ops footprint, building
 * ring and parked car (ops-smoke `checkPeople`). Heights: ground figures carry no `y` (the
 * builder reads `ground.standAt`); 'wall' / 'roof' figures carry the road-frame height of what
 * they stand on (the perch floor, the platform deck, the 2F floor).
 * `flagPlacements()` (I3-e): eight `kind 'flag'` rows along the E paddock's edge
 * (OPS_LAYOUT.flags.ePaddock, mount 'paddock'); the T1 cap's and the paddock gates' poles
 * stay in paddock.ts.
 */

/** the paddock staff's lines (track frame): where they walk and stand in the hospitality walkway */
export const STAFF = {
  /** the walkers' line: 0.7 m off the hospitality units' paddock face (OPS_LAYOUT.hospitality.lat − across / 2), ± 0.25 m */
  walkLat: OPS_LAYOUT.hospitality.lat - OPS_LAYOUT.hospitality.size[1] / 2 - 0.7,
  /**
   * The standing pairs' line, 2.9 m in front of the offices' pit-side porch line (PADDOCK_OFFICE):
   * the OSM outlines of rows B / A (184430911 / 184430909, what §16 O6 tests) carry their
   * porches out to −77.6 / −76.8, so the pairs keep off them
   */
  standLat: OFFICE_PORCH_PIT + 2.9,
  /** the lamps of PADDOCK_LAMPS.extra at −77 stand between the two lines: keep this much s clear of them */
  lampClearS: 1.5,
  /** the walkers' pitch along an office row (a seeded ± 1 m jitter on top) */
  pitch: 6.2,
  /** the centre house's forecourt: the strip between its north face (−82 at s 5759 → 5792) and the hospitality walkway */
  forecourt: { s: [5760, 5790] as [number, number], lat: [-77.5, -80.5] as [number, number], n: 8 },
  /** between the hospitality units: the free s on either side of a gap's van (or the gap's centre when it has none) */
  gapDS: 2.7,
  /** the broadcast compound's free aisles (LAYOUT_B.compound: the two 1.56 m aisles between the container rows, south of the rows, past the dishes) */
  compound: [[5456, -55.5], [5466, -55.5], [5458, -59.5], [5469, -59.5], [5455, -64.5], [5468.5, -64.5], [5480, -62], [5480.5, -66]] as readonly [number, number][],
  /** the vehicle base: between the door row and the back row, before the roll doors, between the strip's cars */
  base: [[138.6, -37.5], [138.6, -40.8], [139, -44.2], [147, -38.5], [148, -41.8], [164, -30]] as readonly [number, number][],
} as const

/** a tiny deterministic hash → [0, 1) for the staff's jitter and poses (no Rng in the data layer) */
function unit(i: number, k: number): number {
  const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453
  return x - Math.floor(x)
}

const STAND_POSES = ['stand', 'standF', 'hips', 'hipsF'] as const
const WALK_POSES = ['walk', 'walk', 'stand', 'standF'] as const

function crewFigures(): OpsFigure[] {
  const out: OpsFigure[] = []
  for (let g = 0; g < PIT_GARAGE_COUNT; g++) out.push(...crewSlots(g), ...perchSeats(g))
  return out
}

function officialFigures(): OpsFigure[] {
  const O = OPS_LAYOUT.officials
  const out: OpsFigure[] = []
  const fig = (s: number, lateral: number, pose: string, yawDeg: number, mount: OpsMount, y?: number): OpsFigure => ({ s: wrapS(s), lateral, role: 'official', pose, yawDeg, mount, ...(y !== undefined ? { y } : {}) })
  // two at every core's pit-side door, facing the lane
  coreEdges().forEach((core, i) => O.coreDoors.dS.forEach((d, k) => out.push(fig(core.mid + d, O.coreDoors.lat, k === 0 ? 'stand' : 'hips', 90 + (i % 2 ? -20 : 20), 'apron'))))
  // on the fixed platform's deck, facing the track
  O.platform.s.forEach((s, i) => out.push(fig(s, O.platform.lat, i % 3 === 1 ? 'standF' : 'stand', 90, 'wall', O.platform.y)))
  // on the podium terrace, facing the track (the fascia's banner behind them)
  O.podium.dS.forEach((d, i) => out.push(fig(O.podium.s + d, O.podium.lat, i % 2 ? 'hips' : 'stand', 90, 'roof', O.podium.y)))
  // at the pit-exit light, facing −s (the cars coming up the lane)
  O.exitLight.s.forEach((s, i) => out.push(fig(s, O.exitLight.lat, i ? 'hips' : 'stand', 180, 'yard')))
  // at the pit entry, facing +s (the cars arriving)
  O.entry.s.forEach((s, i) => out.push(fig(s, O.entry.lat, i === 1 ? 'standF' : 'stand', 0, 'apron')))
  return out
}

function marshalFigures(): OpsFigure[] {
  const M = OPS_LAYOUT.marshals
  const out: OpsFigure[] = []
  const fig = (s: number, lateral: number, pose: string, yawDeg: number, mount: OpsMount): OpsFigure => ({ s: wrapS(s), lateral, role: 'marshal', pose, yawDeg, mount })
  // the twelve core faces on the apron, 0.5 m past each face, facing the lane
  coreEdges().forEach((core, i) => {
    out.push(fig(core.s[0] - M.boundaries.dS, M.boundaries.lat, i % 2 ? 'hips' : 'stand', 90, 'apron'))
    out.push(fig(core.s[1] + M.boundaries.dS, M.boundaries.lat, i % 2 ? 'stand' : 'lookUp', 90, 'apron'))
  })
  M.exitYard.s.forEach((s, i) => out.push(fig(s, M.exitYard.lat, i % 2 ? 'hips' : 'stand', 90 + (i % 2 ? 30 : -30), 'yard')))
  M.entry.s.forEach((s, i) => out.push(fig(s, M.entry.lat, i ? 'stand' : 'hips', 90, 'apron')))
  return out
}

function photographerFigures(): OpsFigure[] {
  const P = OPS_LAYOUT.photographers
  const out: OpsFigure[] = []
  const fig = (s: number, lateral: number, pose: string, yawDeg: number, mount: OpsMount, y?: number): OpsFigure => ({ s: wrapS(s), lateral, role: 'photographer', pose, yawDeg, mount, ...(y !== undefined ? { y } : {}) })
  // the platform's lane edge, cameras up (the looking-up pose stands in for a raised camera), facing the pit lane's box side
  P.platform.s.forEach((s, i) => out.push(fig(s, P.platform.lat, i % 2 ? 'lookUp' : 'stand', -90 + (i % 2 ? 25 : -25), 'wall', P.platform.y)))
  // behind the exit-yard wall, facing the pit-exit lane
  P.exitYard.s.forEach((s, i) => out.push(fig(s, P.exitYard.lat, i % 2 ? 'stand' : 'lookUp', 90, 'yard')))
  // by the media marquee in the E paddock, facing each other
  P.ePaddock.forEach(([s, lateral], i) => out.push(fig(s, lateral, i ? 'hips' : 'stand', i ? 180 : 0, 'paddock')))
  return out
}

/** the team-office rows' s extents the staff walk along (1.5 m trimmed off each end; the OSM rows B / A carry their porches) */
function officeRowsS(): [number, number][] {
  return PADDOCK_BUILDINGS.filter((b) => b.kind === 'teamOffices' || b.kind === 'officeBlock').map((b) => [wrapS(b.sRange[0] + 1.5), wrapS(b.sRange[1] - 1.5)] as [number, number])
}

/** the signed s distance from `a` to `b`, in (−LAP / 2, LAP / 2] */
function deltaS(a: number, b: number): number {
  const d = forwardS(a, b)
  return d > LAP / 2 ? d - LAP : d
}

function staffFigures(): OpsFigure[] {
  const out: OpsFigure[] = []
  const fig = (s: number, lateral: number, pose: string, yawDeg: number, mount: OpsMount): OpsFigure => ({ s: wrapS(s), lateral, role: 'staff', pose, yawDeg, mount })
  const lamps = PADDOCK_LAMPS.extra.filter(([, l]) => l < -70 && l > -85).map(([s]) => wrapS(s))
  const nearLamp = (s: number) => lamps.some((ls) => Math.abs(deltaS(ls, s)) < STAFF.lampClearS)
  // --- the hospitality walkway along the office rows: walkers on the units' side, standing pairs at the porch line
  let i = 0
  for (const [a, b] of officeRowsS()) {
    const len = forwardS(a, b)
    const steps = Math.floor(len / STAFF.pitch)
    for (let k = 0; k <= steps; k++) {
      const s0 = wrapS(a + (len - steps * STAFF.pitch) / 2 + k * STAFF.pitch + (unit(i, 1) - 0.5) * 2.0)
      i++
      if (nearLamp(s0)) continue
      if (k % 3 === 2) {
        // a standing pair at the porch line, facing each other along s
        out.push(fig(s0 - 0.45, STAFF.standLat, STAND_POSES[Math.floor(unit(i, 2) * 4)]!, 0, 'paddock'))
        out.push(fig(s0 + 0.45, STAFF.standLat + 0.15, STAND_POSES[Math.floor(unit(i, 3) * 4)]!, 180, 'paddock'))
      } else {
        // a walker along the units' face, either way
        out.push(fig(s0, STAFF.walkLat + (unit(i, 4) - 0.5) * 0.5, WALK_POSES[Math.floor(unit(i, 5) * 4)]!, unit(i, 6) < 0.5 ? 0 : 180, 'paddock'))
      }
    }
  }
  // --- between the hospitality units (beside the gap's van where it has one)
  const H = OPS_LAYOUT.hospitality
  const units = GARAGE_ORDER.map((_, g) => hospitalityS(g))
  const vans = vanSlots()
  for (let g = 0; g + 1 < units.length; g++) {
    const hi = units[g]!, lo = units[g + 1]!
    const gap = forwardS(lo + H.size[0] / 2, hi - H.size[0] / 2)
    if (gap < 8) continue
    const mid = wrapS(lo + H.size[0] / 2 + gap / 2)
    const hasVan = vans.some((v) => Math.abs(deltaS(v, mid)) < 0.1)
    const at = hasVan ? [mid - STAFF.gapDS, mid + STAFF.gapDS] : [mid - 0.6, mid + 0.6]
    at.forEach((s, k) => out.push(fig(s, H.lat + (k ? 0.4 : -0.4), k ? 'stand' : 'standF', k ? 180 : 0, 'paddock')))
  }
  // --- the centre house's forecourt
  const F = STAFF.forecourt
  for (let k = 0; k < F.n; k++) {
    const s = F.s[0] + ((k + 0.5) / F.n) * (F.s[1] - F.s[0]) + (unit(k, 7) - 0.5) * 1.5
    if (nearLamp(s)) continue
    out.push(fig(s, F.lat[0] + unit(k, 8) * (F.lat[1] - F.lat[0]), k % 2 ? WALK_POSES[k % 4]! : STAND_POSES[k % 4]!, k % 2 ? (k % 4 === 1 ? 0 : 180) : -90, 'paddock'))
  }
  // --- the broadcast compound and the vehicle base
  STAFF.compound.forEach(([s, lateral], k) => out.push(fig(s, lateral, k % 2 ? 'stand' : 'walk', k % 3 === 0 ? 0 : k % 3 === 1 ? 180 : 90, 'paddock')))
  STAFF.base.forEach(([s, lateral], k) => out.push(fig(s, lateral, k % 2 ? 'hips' : 'stand', k < 3 ? 0 : 180, 'yard')))
  return out
}

/**
 * Every figure of the ops layer. `towers` (the TV_CAMERAS rows resolved by tv-lens.ts /
 * tv-towers.ts, section A `cameraSlots`) appends the camera operators for a reader that has
 * them; the builder (ops-people.ts) and the guard (§16 O9 — its OPS_WINDOWS are the pit and the
 * paddock, not the trackside) read the list without them, and tv-towers.ts draws the operators
 * itself. The post marshals (`marshalPostFigures`, I4-a) are always in the list; the fence-window
 * photographers (`windowSlots`, I4-c) join it when a `lineAt` resolver is given (ops-people.ts
 * and the guards pass trackside.ts `barrierLateralAt`).
 */
export function figuresAt(opts: { towers?: readonly TvTowerSlotInput[]; lineAt?: (s: number, side: 1 | -1) => number | null } = {}): OpsFigure[] {
  return [...crewFigures(), ...officialFigures(), ...marshalFigures(), ...marshalPostFigures(), ...photographerFigures(), ...staffFigures(), ...(opts.towers ?? []).flatMap(cameraSlots), ...(opts.lineAt ? windowSlots(opts.lineAt) : [])]
}

/**
 * The flags' [upper band, lower band] colours (fictional tricolours: the middle band is white).
 * No pair may be a national white-middle tricolour — red / blue is the Netherlands, blue / red
 * Russia, green / red Iran, red / green Hungary, black / red Upper Volta, blue / blue Argentina
 * and Honduras — so the palette stays off plain red, blue and green altogether: teal / teal,
 * orange / violet, violet / gold, charcoal / teal.
 */
export const FLAG_COLOURS: readonly [string, string][] = [['#0f8a8a', '#0f8a8a'], ['#f28a1f', '#5b2a86'], ['#5b2a86', '#e0b32d'], ['#2b2f33', '#0f8a8a']]

/** the eight flag poles along the E paddock's edge (kind 'flag', 9 m, three fictional colours in turn — ops-people.ts draws them) */
export function flagPlacements(): OpsPlacement[] {
  const F = OPS_LAYOUT.flags.ePaddock
  const out: OpsPlacement[] = []
  for (let i = 0; i < F.n; i++) {
    const s = F.s[0] + (i / (F.n - 1)) * (F.s[1] - F.s[0])
    out.push({ id: `flag-e-${i}`, kind: 'flag', s: wrapS(s), lateral: F.lat, yawDeg: 0, size: F.size, mount: 'paddock', tint: FLAG_COLOURS[i % FLAG_COLOURS.length]! })
  }
  return out
}
