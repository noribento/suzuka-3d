/**
 * Suzuka Circuit — trackside data authored from the 2026-09-06 aerial audit: every barrier run of
 * the lap, the real kerbs, the painted lines, the two-wheel / slip lanes, the marshal posts and
 * the basins. Positions are (s, lateral) in the app's track frame (s along the lap in driving
 * order, lateral +left, metres from the centreline).
 *
 * Sources, in order of trust: OpenStreetMap ways referenced by id (`app/data/suzuka-facilities.ts`,
 * ODbL — resolved at runtime by `app/three/trackside.ts` to the road-facing edge of each way, so no
 * OSM geometry is copied here), then (s, lateral) samples read off the 国土地理院 seamless aerial
 * (2017–2020, ±2–5 m) by the audit (`misc/audit/measurements.txt`), then the 2026 Google Earth
 * captures in `misc/ref/user/` for what changed after 2020. Rows marked `unverified` are estimates.
 *
 * A run belongs to ONE stretch of road (`sRange`): its vertices are mapped inside that window only,
 * which is what keeps the chicane's barriers off the Dunlop stretch and the Degner-side wall off
 * the 130R bridge in the figure-8 fold.
 */
import type { AlongTrack, Side } from './suzuka-facilities-spec'

// ---------------------------------------------------------------- barriers

/**
 * armco — grey W-beam guard rail on posts (0.78 m); guardrail — the white steel rail Suzuka uses
 * at the verges (0.75 m); concrete — white concrete wall (1.05 m); tyre — belt-covered tyre wall
 * (1.95 m); fence — chain-link only (no wall), e.g. the car-park fence behind the pit entry lane.
 */
export type BarrierKind = 'armco' | 'guardrail' | 'concrete' | 'tyre' | 'fence'

export interface BarrierRun {
  id: string
  kind: BarrierKind
  side: Side
  /** the stretch of road the run belongs to, in driving order (end < start across the start line) */
  sRange: [number, number]
  /** OSM way ids (road-facing edge) and / or hand samples [s, lateral]; hand samples win within 4 m */
  source: { osm?: number[]; samples?: [number, number][]; reach?: number; project?: 'nearest' | 'ray' }
  /** never closer to the road than the half-width + this (m); OSM registration guard */
  minGap?: number
  /** debris fence above the top of the barrier (m); 0 / undefined = none */
  fence?: number
  /** tint of that fence's mesh (sRGB hex); the bridge parapets carry a dark-green mesh, the rest is bare galvanised wire */
  fenceColour?: string
  /** advertising boards on the track face (concrete runs only, A11): the grandstand front wall */
  boards?: boolean
  unverified?: string[]
  note?: string
}

const P = (pts: [number, number][]) => pts

export const BARRIERS: BarrierRun[] = [
  // ---- left of the lap, driving order from the start line ---------------------------------
  { id: 'gs-front', kind: 'concrete', side: 1, sRange: [5546, 362], fence: 2.6, boards: true, source: { osm: [471430732, 471430724, 471430725, 471430720, 471430723, 471430721, 469591632] }, note: 'grandstand / VIP / A1 front wall, boards on the track face, debris fence on top' },
  { id: 'a-stand-front', kind: 'concrete', side: 1, sRange: [362, 446], fence: 2.6, source: { osm: [470125557], samples: P([[380, 15.5], [420, 17.0], [440, 17.5]]) } },
  { id: 't1-outside', kind: 'concrete', side: 1, sRange: [446, 470], fence: 2.6, source: { osm: [469261663] } },
  { id: 't1-t2-outside-tyres', kind: 'tyre', side: 1, sRange: [470, 640], fence: 2.6, source: { osm: [469261663, 469261665, 469591634] }, note: 'white belt-faced tyre wall behind the T1/T2 asphalt run-off, B stands behind' },
  { id: 't2-exit-outside', kind: 'concrete', side: 1, sRange: [640, 684], fence: 2.6, source: { osm: [469591634] } },
  { id: 'c-foot', kind: 'guardrail', side: 1, sRange: [684, 960], fence: 2.6, source: { samples: P([[684, 25.0], [700, 17.0], [730, 15.0], [760, 14.0], [790, 14.0], [820, 14.0], [850, 14.0], [880, 14.0], [910, 14.0], [940, 15.0], [960, 15.5]]) }, unverified: ['aerial only (no OSM way at the foot of the C terrace); ±4 m'] },
  { id: 'esses-outside', kind: 'concrete', side: 1, sRange: [960, 1240], fence: 2.6, source: { samples: P([[960, 15.5], [980, 18.0], [1010, 22.0], [1040, 26.0], [1070, 28.0], [1100, 29.0], [1130, 29.0], [1160, 27.0], [1190, 24.0], [1220, 22.0], [1240, 17.5]]) }, unverified: ['aerial only; gravel outer edge in front of D5 / D1–4, ±5 m'] },
  { id: 'gyaku-outside', kind: 'concrete', side: 1, sRange: [1240, 1377], fence: 2.6, source: { samples: P([[1240, 17.0], [1250, 17.0], [1260, 17.5], [1270, 19.5], [1285, 22.5], [1292, 25.0], [1312, 25.5], [1322, 26.0], [1330, 30.0], [1340, 29.5], [1360, 27.5], [1370, 26.5], [1377, 30.0]]) }, unverified: ['aerial + OSM sand outer edge; ±2 m'] },
  { id: 'gyaku-exit-outside', kind: 'concrete', side: 1, sRange: [1377, 1424], fence: 2.6, source: { osm: [468009620] } },
  { id: 'e2-toe', kind: 'concrete', side: 1, sRange: [1424, 1526], fence: 2.6, source: { osm: [467879578] } },
  { id: 'nippo-exit-inside', kind: 'guardrail', side: 1, sRange: [1526, 1682], fence: 2.6, source: { samples: P([[1526, 18.6], [1530, 19.2], [1540, 18.2], [1550, 15.7], [1560, 13.7], [1570, 9.7], [1580, 8.1], [1600, 8.1], [1620, 7.6], [1640, 8.0], [1660, 10.0], [1682, 12.0]]) }, unverified: ['aerial only; ±2 m'] },
  { id: 'dunlop-inside', kind: 'concrete', side: 1, sRange: [1682, 1824], source: { osm: [467887334] }, note: '1775–1800 is the tunnel parapet' },
  { id: 'dunlop-exit-inside', kind: 'concrete', side: 1, sRange: [1824, 1922], minGap: 1.2, source: { osm: [467879577] }, note: 'the app centreline is 2–4 m left of the real road here, hence the gap clamp' },
  { id: 'degner1-inside', kind: 'concrete', side: 1, sRange: [1922, 2075], minGap: 1.2, source: { osm: [467591742] } },
  { id: 'degner1-exit-outside', kind: 'guardrail', side: 1, sRange: [2075, 2100], source: { samples: P([[2075, 9.0], [2100, 10.5]]) }, unverified: ['between the Degner 1 wall end and the Degner 2 trap'] },
  { id: 'degner2-trap-back', kind: 'tyre', side: 1, sRange: [2100, 2203], source: { osm: [467454306, 689143101] } },
  { id: 'degner2-exit-outside', kind: 'concrete', side: 1, sRange: [2203, 2228], source: { osm: [467454307] } },
  { id: 'crossover-under-outside', kind: 'tyre', side: 1, sRange: [2228, 2296], source: { osm: [467454308] }, note: 'wraps the west abutment of the 130R bridge' },
  { id: 'crossover-abutment-left', kind: 'concrete', side: 1, sRange: [2296, 2346], source: { samples: P([[2296, 8.5], [2321, 8.5], [2346, 8.5]]) }, note: 'abutment wall under the bridge deck' },
  { id: 'crossover-exit-110r', kind: 'concrete', side: 1, sRange: [2346, 2528], source: { osm: [184102015], samples: P([[2346, 8.5], [2360, 12.5]]) } },
  { id: 'hairpin-approach-infield', kind: 'concrete', side: 1, sRange: [2528, 2645], source: { osm: [183999771] } },
  { id: 'hairpin-inside', kind: 'concrete', side: 1, sRange: [2645, 2960], source: { osm: [183999769], samples: P([[2645, 21.5], [2650, 13.0], [2656, 12.0], [2662, 11.0], [2700, 11.0], [2734, 13.5], [2760, 11.5], [2770, 10.8]]) }, note: 'the ( wall round the marshal post at the tip, then the infield wall along the exit leg' },
  { id: '200r-outside', kind: 'concrete', side: 1, sRange: [2960, 3400], source: { osm: [183999767, 183999785] } },
  { id: 'spoon-exit-inside', kind: 'concrete', side: 1, sRange: [3797, 3911], source: { osm: [183953793] }, note: 'between the track and the West Course pit-exit road' },
  { id: 'west-straight-left', kind: 'guardrail', side: 1, sRange: [3911, 4270], source: { osm: [184419761] } },
  { id: 'bridge-approach-left', kind: 'guardrail', side: 1, sRange: [4270, 4585], source: { samples: P([[4270, 9.0], [4290, 9.5], [4350, 9.5], [4420, 9.5], [4500, 9.0], [4560, 8.5], [4585, 8.0]]) }, unverified: ['aerial only'] },
  { id: 'bridge-parapet-left', kind: 'concrete', side: 1, sRange: [4585, 4740], fence: 2.6, fenceColour: '#2d5a3c', source: { samples: P([[4585, 8.0], [4665, 8.0], [4740, 8.0]]) }, note: 'parapet of the crossover deck and its approaches; the multi-level-crossing photo shows a dark-green mesh on it' },
  // the G stand's debris fence continues along the inside of 130R on the verge rail: without it
  // the stand's front is screened for only 43 % of its length (facilities-check A10)
  { id: '130r-inside-verge', kind: 'guardrail', side: 1, sRange: [4740, 4830], fence: 2.6, source: { osm: [471532691] }, unverified: ['debris fence on the verge rail in front of G: the 2026 photos show the mesh continuing along the inside of 130R; height and extent estimated'] },
  { id: '130r-inside-wall', kind: 'concrete', side: 1, sRange: [4830, 4905], fence: 2.6, source: { osm: [468377693] } },
  { id: 'p-front-tyres', kind: 'tyre', side: 1, sRange: [4905, 5160], fence: 2.6, source: { osm: [467219902] } },
  // OSM 470173101 is ONE 160 m wall along the foot of the Q2 / Q1 bank, world (183,-164) to
  // (341,-184). The lap loops north between its ends, so no vertex of it has a nearest centreline
  // point with s in (5178, 5261): the nearest projection left an 87 m straight chord standing in
  // the run-off and crossing the two-wheel loop. `project: 'ray'` casts the perpendicular at each
  // s instead. That parameterisation is not monotone — it walks the wall out to s5198, back to
  // s5235 and out again — so the run is cut at the turn (outbound reaches along-way 3.15 at s5172,
  // the return branch is at 3.11 at s5235) and the wall is swept exactly once, end to end.
  { id: 'chicane-escape-wall', kind: 'concrete', side: 1, sRange: [5160, 5172], fence: 2.6, source: { osm: [470173101], project: 'ray', reach: 60 }, note: 'west leg of the Q2 bank wall, from the end of the P tyre wall to the mouth of the escape road; 12 m of s sweep 32 m of wall' },
  { id: 'chicane-q2-front-wall', kind: 'concrete', side: 1, sRange: [5235, 5335], fence: 2.6, source: { osm: [470173101], project: 'ray', reach: 85 }, note: 'the rest of the same wall, round the back of the chicane triangle and in front of the Q2 bars and Q1; +62 m at the T17 apex, closing to +17 at the T18 entry' },
  { id: 't18-outside-tyres', kind: 'tyre', side: 1, sRange: [5335, 5452], fence: 2.6, source: { osm: [468778567] } },
  { id: 's-front', kind: 'tyre', side: 1, sRange: [5452, 5546], fence: 2.6, source: { osm: [471430726, 469931177] } },

  // ---- right of the lap ---------------------------------------------------------------
  { id: 'pit-exit-outer', kind: 'concrete', side: -1, sRange: [104, 230], source: { osm: [469451649, 469451645] }, note: 'outer side of the pit-exit lane (tunnel-road apron, then the lane verge)' },
  { id: 'pit-exit-separator', kind: 'concrete', side: -1, sRange: [125, 205], source: { samples: P([[125, -9.5], [205, -9.5]]) }, unverified: ['low wall between the exit lane and the track after the pit wall end — read from the aerial shadow, confirm on the 2026 photo'] },
  { id: 't1-inside-island', kind: 'concrete', side: -1, sRange: [330, 400], source: { osm: [469065003], samples: P([[400, -28.0]]) } },
  { id: 't1-t2-inside', kind: 'concrete', side: -1, sRange: [400, 870], source: { osm: [469048580, 469064999], samples: P([[400, -28.0], [410, -22.0], [430, -17.0], [450, -14.5], [600, -17.5], [640, -17.0], [680, -15.0]]) }, unverified: ['584–706 interpolated: the two OSM ways leave a gap at the T2 exit'] },
  { id: 't3-outside', kind: 'concrete', side: -1, sRange: [870, 1040], source: { samples: P([[870, -13.0], [890, -18.0], [920, -22.0], [950, -22.0], [980, -19.0], [1000, -15.0], [1020, -14.0], [1040, -15.5]]) }, unverified: ['aerial only (OSM 469065004 diverges into the basin); ±4 m'] },
  { id: 't4-t5-inside', kind: 'concrete', side: -1, sRange: [1040, 1172], source: { osm: [468336109] } },
  { id: 'gyaku-entry-inside', kind: 'concrete', side: -1, sRange: [1172, 1240], source: { osm: [468313205] } },
  { id: 'gyaku-inside', kind: 'concrete', side: -1, sRange: [1240, 1313], source: { osm: [468313203] } },
  { id: 'gyaku-exit-inside', kind: 'concrete', side: -1, sRange: [1313, 1412], source: { samples: P([[1313, -24.0], [1320, -23.0], [1330, -21.5], [1340, -19.5], [1360, -19.0], [1380, -19.0], [1400, -19.5], [1412, -22.3]]) }, unverified: ['aerial only (OSM gap); ±1.5 m'] },
  { id: 'nippo-outside', kind: 'concrete', side: -1, sRange: [1412, 1652], source: { osm: [468313201, 468313199, 468313197] }, note: 'paddock / helipad wall; the East Course link road leaves through the gap after 1652' },
  { id: 'dunlop-outside-tyres', kind: 'tyre', side: -1, sRange: [1774, 1884], source: { osm: [467219910] } },
  { id: 'dunlop-exit-tyres', kind: 'tyre', side: -1, sRange: [1884, 1994], source: { osm: [467386928] } },
  { id: 'crossover-abutment-right', kind: 'concrete', side: -1, sRange: [2296, 2346], source: { samples: P([[2296, -8.5], [2321, -8.5], [2346, -8.5]]) } },
  { id: 'g-cross-front', kind: 'guardrail', side: -1, sRange: [2346, 2480], fence: 2.6, source: { samples: P([[2346, -8.5], [2370, -9.0], [2400, -9.0], [2430, -9.0], [2460, -9.0], [2480, -10.0]]) }, unverified: ['aerial only'] },
  { id: 'hairpin-approach-right', kind: 'concrete', side: -1, sRange: [2495, 2628], fence: 2.6, source: { osm: [184004014], samples: P([[2495, -10.3]]) }, note: 'H stand behind' },
  { id: 'hairpin-outside-tyres', kind: 'tyre', side: -1, sRange: [2628, 2750], fence: 2.6, source: { osm: [183999765], samples: P([[2705, -31.0], [2715, -26.0], [2725, -21.0], [2735, -17.0], [2745, -14.5], [2750, -13.6]]) }, note: 'I stand behind; 2700–2750 read off the aerial (the OSM way stops at the apex)' },
  { id: 'hairpin-exit-right', kind: 'concrete', side: -1, sRange: [2750, 2925], fence: 2.6, source: { osm: [183999770, 183999781] } },
  { id: '200r-bike-chicane-wall', kind: 'concrete', side: -1, sRange: [2940, 3065], source: { osm: [183969207, 183969204] }, note: 'round the outside of the two-wheel chicane loop' },
  { id: '200r-right-guardrail', kind: 'guardrail', side: -1, sRange: [3065, 3265], source: { osm: [183953774] } },
  { id: 'l-yard-edge', kind: 'guardrail', side: -1, sRange: [3265, 3509], fence: 2.6, source: { samples: P([[3265, -11.0], [3280, -11.5], [3290, -12.0], [3300, -15.0], [3310, -16.5], [3320, -18.6], [3330, -20.8], [3340, -21.8], [3350, -24.5], [3360, -26.0], [3370, -26.9], [3380, -31.4], [3390, -32.4], [3400, -33.2], [3410, -33.7], [3420, -33.7], [3440, -31.8], [3460, -31.7], [3480, -30.7], [3500, -33.0], [3509, -31.1]]) }, unverified: ['aerial only (yard-edge wall or rail); ±3 m'] },
  { id: 'l-front', kind: 'concrete', side: -1, sRange: [3509, 3597], fence: 2.6, source: { osm: [184104882] } },
  { id: 'spoon1-outside-tyres', kind: 'tyre', side: -1, sRange: [3597, 3677], fence: 2.6, source: { osm: [184104883] } },
  { id: 'spoon2-outside', kind: 'concrete', side: -1, sRange: [3677, 3794], fence: 2.6, source: { osm: [184104881], samples: P([[3730, -46.5], [3740, -46.2], [3750, -43.4], [3760, -40.5], [3770, -37.2], [3780, -30.5], [3790, -29.5]]) }, unverified: ['3721–3794 aerial only'] },
  { id: 'spoon-exit-outside', kind: 'concrete', side: -1, sRange: [3794, 3891], fence: 2.6, source: { osm: [183953795] }, note: 'N stand behind' },
  { id: 'west-straight-right', kind: 'guardrail', side: -1, sRange: [3891, 4203], minGap: 1.0, source: { osm: [184419759] } },
  { id: 'west-pit-wall', kind: 'concrete', side: -1, sRange: [4203, 4315], source: { samples: P([[4203, -15.0], [4210, -9.5], [4245, -11.5], [4285, -13.4], [4300, -12.0], [4315, -9.0]]) }, unverified: ['pit wall between the track and the West Course pit lane, aerial only'] },
  { id: 'west-straight-trap-wall', kind: 'concrete', side: -1, sRange: [4324, 4521], fence: 2.6, source: { samples: P([[4324, -9.0], [4335, -14.6], [4353, -22.4], [4387, -19.4], [4440, -20.5], [4503, -22.5], [4515, -16.3], [4521, -9.2]]) }, note: 'O stand (2026) behind', unverified: ['aerial gravel outer edge'] },
  { id: 'bridge-approach-right', kind: 'guardrail', side: -1, sRange: [4521, 4585], source: { samples: P([[4521, -9.2], [4530, -8.0], [4560, -7.5], [4585, -7.5]]) }, unverified: ['aerial only'] },
  { id: 'bridge-parapet-right', kind: 'concrete', side: -1, sRange: [4585, 4740], fence: 2.6, fenceColour: '#2d5a3c', source: { samples: P([[4585, -7.5], [4665, -7.5], [4740, -7.5]]) }, note: 'dark-green mesh like the left parapet (photo)' },
  { id: '130r-outside-verge', kind: 'guardrail', side: -1, sRange: [4740, 4772], source: { samples: P([[4740, -8.0], [4772, -29.0]]) }, unverified: ['transition from the deck parapet to the 130R tyre walls'] },
  { id: '130r-outside-tyres', kind: 'tyre', side: -1, sRange: [4772, 4990], source: { osm: [467386927, 467386917] } },
  { id: '130r-exit-pocket-tyres', kind: 'tyre', side: -1, sRange: [4990, 5124], source: { osm: [467219910] }, note: 'the tyre wall behind the exit gravel pocket' },
  { id: '130r-exit-wall', kind: 'concrete', side: -1, sRange: [4997, 5085], source: { osm: [184102364] }, unverified: ['starts 10 m outside the end of the 130R tyre wall — check the joint on the overlay'] },
  { id: 'chicane-approach-right-a', kind: 'guardrail', side: -1, sRange: [5085, 5134], minGap: 2.0, source: { osm: [467219908] } },
  // Moved out from the -8…-9 the 2026-09 audit guessed: walking outward from the road edge in the
  // aerial, the run-off there is paved to 7–11 m past it (GROUND_AREAS 'シケイン舗装エプロン（右）'),
  // so a rail at -9 stood in the middle of the tarmac. It now follows the outer edge of that apron.
  { id: 'chicane-approach-right-b', kind: 'guardrail', side: -1, sRange: [5150, 5203], minGap: 2.0, source: { samples: P([[5150, -16.0], [5160, -17.5], [5175, -17.5], [5185, -15.0], [5195, -14.0], [5203, -13.5]]) }, note: 'gap at 5134–5150 for the two-wheel pit-in slip road (OSM 467219908 stops at the slip)', unverified: ['no OSM way and not resolvable at 0.49 m/px — read from the edge of the paved run-off, ±3 m'] },
  { id: 'chicane-exit-tyres', kind: 'tyre', side: -1, sRange: [5203, 5252], source: { osm: [467219893, 467219895, 467219896, 467219894] } },
  { id: 'pit-entry-outer-fence', kind: 'fence', side: -1, sRange: [5250, 5450], source: { samples: P([[5250, -21.0], [5300, -21.5], [5350, -21.6], [5400, -22.0], [5450, -24.8]]) }, note: 'car-park fence behind the pit-entry lane; the 5450 sample sits 1.2 m behind the marshal cabin at (5450, −22.3)' },
  { id: 't18-pit-entry-separator', kind: 'concrete', side: -1, sRange: [5389, 5538], fence: 2.2, source: { osm: [471532694], samples: P([[5520, -10.5], [5538, -9.7]]) }, note: 'between the track and the pit-entry lane; the pit wall (pit-lane.ts) continues from 5538' },
]

// ---------------------------------------------------------------- kerbs

export type KerbKind = 'flat' | 'sausage' | 'green'

export interface KerbDef {
  name: string
  sRange: [number, number]
  side: Side
  kind: KerbKind
  /** width of a flat kerb (m); a green strip's width; ignored for sausages */
  width?: number
  unverified?: string[]
}

/** The real kerbs (2017–2020 aerial + 2026 photos); nothing is generated from corner runs any more. */
export const KERBS: KerbDef[] = [
  { name: 'T1–T2 inside', sRange: [440, 695], side: -1, kind: 'flat', width: 1.3 },
  { name: 'T2 exit', sRange: [610, 690], side: 1, kind: 'flat', width: 1.0, unverified: ['exit kerb not resolvable in the 2017–20 aerial'] },
  { name: 'T3 inside', sRange: [860, 930], side: 1, kind: 'flat', width: 1.3 },
  { name: 'T3 exit / T4 inside', sRange: [935, 1030], side: -1, kind: 'flat', width: 1.3 },
  { name: 'T4 exit', sRange: [1020, 1090], side: 1, kind: 'flat', width: 1.0 },
  { name: 'T5 inside', sRange: [1110, 1200], side: 1, kind: 'flat', width: 1.3 },
  { name: 'T5 exit', sRange: [1170, 1235], side: -1, kind: 'flat', width: 1.0 },
  { name: '逆バンク inside', sRange: [1265, 1340], side: -1, kind: 'flat', width: 1.3 },
  { name: '逆バンク exit', sRange: [1310, 1395], side: 1, kind: 'flat', width: 1.0 },
  { name: 'NIPPO inside', sRange: [1480, 1580], side: 1, kind: 'flat', width: 1.3 },
  { name: 'Dunlop inside', sRange: [1830, 1905], side: 1, kind: 'flat', width: 1.3, unverified: ['ends not resolvable'] },
  { name: 'Degner 1 inside', sRange: [2035, 2085], side: -1, kind: 'flat', width: 1.3 },
  { name: 'Degner 1 exit', sRange: [2070, 2105], side: 1, kind: 'flat', width: 1.0 },
  { name: 'Degner 2 inside', sRange: [2195, 2245], side: -1, kind: 'flat', width: 1.3 },
  { name: 'Degner 2 exit', sRange: [2235, 2285], side: 1, kind: 'flat', width: 1.0 },
  { name: '110R inside', sRange: [2510, 2590], side: 1, kind: 'flat', width: 1.3 },
  { name: 'Hairpin inside', sRange: [2655, 2740], side: 1, kind: 'flat', width: 1.3 },
  { name: 'Hairpin exit', sRange: [2695, 2765], side: -1, kind: 'flat', width: 1.0 },
  { name: '200R exit inside', sRange: [3295, 3400], side: -1, kind: 'flat', width: 1.0 },
  { name: 'Spoon 1 inside', sRange: [3548, 3610], side: 1, kind: 'flat', width: 1.3 },
  { name: 'Spoon 2 inside', sRange: [3710, 3790], side: 1, kind: 'flat', width: 1.3 },
  { name: 'Spoon exit', sRange: [3800, 3935], side: -1, kind: 'flat', width: 1.0 },
  { name: '130R inside', sRange: [4700, 4790], side: 1, kind: 'flat', width: 1.3 },
  { name: 'Chicane 1 inside', sRange: [5140, 5185], side: -1, kind: 'flat', width: 1.3 },
  { name: 'Chicane apron side', sRange: [5165, 5245], side: 1, kind: 'flat', width: 1.3 },
  { name: 'Chicane 2 exit', sRange: [5205, 5255], side: -1, kind: 'flat', width: 1.0 },
  { name: 'Chicane sausages', sRange: [5200, 5240], side: 1, kind: 'sausage', unverified: ['anti-cut bumps on the apron side (0.4 confidence)'] },
  { name: 'T18 inside', sRange: [5258, 5330], side: -1, kind: 'flat', width: 1.3 },
  { name: 'T18 outside', sRange: [5250, 5370], side: 1, kind: 'flat', width: 1.0, unverified: ['may continue to ≈5480'] },
  // painted / astroturf green strips just outside the edge line or the kerb
  { name: 'main straight left green', sRange: [190, 375], side: 1, kind: 'green', width: 1.2, unverified: ['2026 photo (2.png); absent in the 2017–20 aerial'] },
  { name: 'T1 exit → T2 outside green', sRange: [460, 735], side: 1, kind: 'green', width: 1.5 },
  { name: 'T2 inside green', sRange: [560, 690], side: -1, kind: 'green', width: 1.2 },
  { name: 'Degner straight green', sRange: [2100, 2290], side: 1, kind: 'green', width: 1.5, unverified: ['paint vs grass'] },
  { name: 'Spoon outside turf', sRange: [3555, 3920], side: -1, kind: 'green', width: 2.2 },
  { name: 'Spoon exit inside green', sRange: [3860, 3935], side: 1, kind: 'green', width: 1.2 },
  // from the end of the deck zone: on the bridge and its embankment (s 4663–4763) the only ground
  // face is the 1.2 m deck shoulder, and a strip beyond it had nothing to lie on
  { name: '130R outside green', sRange: [4765, 4800], side: -1, kind: 'green', width: 4.0, unverified: ['whether the strip runs onto the bridge'] },
  { name: 'T18 exit green', sRange: [5370, 5420], side: 1, kind: 'green', width: 1.2, unverified: ['absent in the 2017–20 aerial'] },
]

// ---------------------------------------------------------------- painted lines

export interface LineDef {
  name: string
  sRange: [number, number]
  /** signed lateral of the line centre; 'left-edge' / 'right-edge' follow the road edge */
  lateral: AlongTrack | 'left-edge' | 'right-edge'
  /** default 0.15 m */
  width?: number
  /** [painted, gap] metres for a dashed line */
  dash?: [number, number]
  /** a transverse line across [lateral, lateralTo] at s = sRange[0] (stop / exit lines) */
  lateralTo?: number
}

/** Where the continuous edge lines are interrupted (lanes leaving / joining the lap). */
export const EDGE_LINE_GAPS: { side: Side; sRange: [number, number]; why: string }[] = [
  { side: -1, sRange: [5300, 5389], why: 'pit entry: the lane peels off inside the paved width (island + separator line)' },
  { side: -1, sRange: [125, 384], why: 'pit exit lane (separator line instead)' },
  { side: -1, sRange: [2931, 2947], why: '200R two-wheel chicane split' },
  { side: -1, sRange: [3033, 3049], why: '200R two-wheel chicane rejoin' },
  { side: 1, sRange: [5150, 5165], why: 'Astemo two-wheel chicane split' },
  { side: 1, sRange: [5250, 5262], why: 'Astemo two-wheel chicane rejoin' },
  { side: -1, sRange: [5136, 5150], why: 'two-wheel pit-in slip road' },
  { side: -1, sRange: [4153, 4168], why: 'West Course pit lane entry' },
  { side: -1, sRange: [4355, 4372], why: 'West Course pit lane exit' },
  { side: -1, sRange: [1636, 1652], why: 'East Course link road' },
  { side: 1, sRange: [3945, 3975], why: 'West Course pit-exit road merging' },
]

export const LINES: LineDef[] = [
  { name: 'edge left', sRange: [0, 0], lateral: 'left-edge' },
  { name: 'edge right', sRange: [0, 0], lateral: 'right-edge' },
  // pit entry: island edge then the separator wall line
  { name: 'pit entry separator', sRange: [5300, 5538], lateral: [[5300, -2.5], [5315, -4.0], [5335, -6.0], [5350, -6.6], [5389, -6.9], [5430, -8.3], [5470, -8.6], [5500, -9.0], [5538, -9.0]] },
  { name: 'pit entry lane outer edge', sRange: [5350, 5470], lateral: [[5350, -12.0], [5389, -13.0], [5429, -16.5], [5470, -18.0]] },
  // pit exit: separator line converging into the right edge, the lane's outer edge, the exit line
  { name: 'pit exit separator', sRange: [125, 384], lateral: [[125, -9.5], [200, -9.5], [264, -8.6], [324, -7.9], [384, -7.4]] },
  { name: 'pit exit lane outer edge', sRange: [100, 340], lateral: [[100, -19.0], [200, -19.0], [240, -15.0], [280, -11.0], [340, -7.6]] },
  { name: 'pit exit line', sRange: [128, 128.6], lateral: -9.6, lateralTo: -18.8, width: 0.4 },
  // pit lane: fast / working lane divider (dashed) and the lane edges
  // (the divider sits 5 m from the pit-wall platform kerb — the dossier's 5 m fast lane; I1 draws the lanes)
  { name: 'pit lane divider', sRange: [5560, 180], lateral: -16.05, dash: [3, 3] },
  { name: 'pit lane left edge', sRange: [5470, 125], lateral: -10.1 },
  { name: 'pit lane right edge', sRange: [5470, 100], lateral: -19.1 },
]

// ---------------------------------------------------------------- two-wheel / slip lanes

export interface OffsetLaneDef {
  name: string
  /** OSM way to take the shape from; `samples` overrides it where the way is incomplete */
  osmWay?: number
  /** hand-read centreline as [s, lateral] on the lap (used when the OSM way is partial) */
  samples?: [number, number][]
  /** window on the lap the lane is measured against */
  sRange: [number, number]
  side: Side
  width: number
  /** drop vertices further out than this (the rest of the way belongs to another frame) */
  latMax?: number
  /** kerbs on the lane, as fractions of its length [from, to] and the lane side (+1 = left of the lane's direction) */
  kerbs?: { from: number; to: number; side: Side }[]
  /** the lane already runs on a GROUND_AREAS apron: it gets no footprint of its own, only its lines and kerbs */
  paved?: boolean
  lines?: boolean
  unverified?: string[]
}

export const OFFSET_LANES: OffsetLaneDef[] = [
  // the OSM way only maps the first spur (out to ≈ −25); the loop's centreline is read off the
  // aerial (measured outer edge minus half the 10 m width)
  { name: '200R 二輪シケイン', osmWay: 183309794, samples: P([[2931, -6], [2939, -22], [2952, -33], [2975, -45], [3003, -51], [3016, -46], [3024, -36], [3040, -21], [3050, -8]]), sRange: [2925, 3055], side: -1, width: 10, lines: true, kerbs: [{ from: 0.12, to: 0.3, side: 1 }, { from: 0.42, to: 0.6, side: -1 }, { from: 0.72, to: 0.9, side: 1 }] },
  // `paved`: the Casio Triangle is one asphalt sheet (GROUND_AREAS 'シケイン舗装エプロン'), so the
  // lane claims no ground of its own (ground-plan.ts laneFootprint returns null); the row stays
  // for its edge lines (lines.ts) and kerbs (lanes.ts).
  { name: 'Astemo 二輪ダブルシケイン', osmWay: 183391653, sRange: [5145, 5265], side: 1, width: 8, paved: true, lines: true, kerbs: [{ from: 0.16, to: 0.40, side: 1 }, { from: 0.56, to: 0.84, side: -1 }], unverified: ['kerb extents read off the aerial'] },
  { name: '西コースピットレーン', osmWay: 411295350, sRange: [4150, 4375], side: -1, width: 8, lines: true },
  { name: '二輪ピット入口スリップ', osmWay: 411296898, sRange: [5125, 5215], side: -1, width: 6, latMax: 48, lines: true },
  { name: 'ピット入口への接続路', osmWay: 411291883, sRange: [5270, 5395], side: -1, width: 7, lines: false },
  { name: 'イーストコース連絡路', osmWay: 411295346, sRange: [1636, 1680], side: -1, width: 7, latMax: 55, lines: true },
]

// ---------------------------------------------------------------- marshal posts, cameras

/**
 * A marshal post (plan I4-a, v2). `(s, lateral)` is the centre of the CABIN BODY (the hut the
 * aerial shows); the stand, the stair, the number board, the light panel and the marshals'
 * slots derive from it (app/three/marshal-posts.ts, ops-spec `marshalSlots`, facilities-check O8):
 *
 *  - type 'cabin' (default): the 2.5 m cube on a `platform` (2.0 m) steel stand, a 2.4 m stair
 *    along s on the `stair` side ('aft' = towards −s, default) — r130_post.jpg / mlc_post.jpg;
 *    'low': the 2.0 × 1.6 × 2.0 grey box of the 110R type, no stand; 'building': an officials'
 *    building INFIELD_FACILITIES draws (I5) — only its light panel and camera are placed here;
 *  - `number`: an anchor of the post numbering (26 at the 130R exit and 28 at the chicane are
 *    read off photos; 1 at T1 is the convention); every other post gets `marshalNumbers()`'s
 *    ascending count, which must land exactly on each anchor (O8);
 *  - `secondary`: a second hut of the same post (the pairs across the 110R and the bridge
 *    approach) — a cabin with its marshals but no number board, light panel or camera;
 *  - `facing`: which way the number board reads ('-s' = towards the approaching cars, default);
 *  - `osmWay` / `size`: the hut's OSM footprint or a hand size [along s, across] (a 'building'
 *    row needs one of them);
 *  - `panel`: the light panel's s (default s − 3.2, snapped to the run's 4 m fence-post pitch)
 *    and lateral (default the barrier line, 0.35 m arm on the track side);
 *  - `figures`: marshals at the post (1 on the platform + the rest on the ground between the
 *    fence and the stand; default 3; 1 where the ground in front is a pit keep-out).
 *
 * Every number is unverified; `unverified` rows are aerial-read positions (±3 m).
 */
export interface MarshalPostDef {
  s: number
  lateral: number
  type?: 'cabin' | 'low' | 'building'
  /** stand height (m); cabin default 2.0, low 0 */
  platform?: number
  /** the stair's side along s (default 'aft' = towards −s) */
  stair?: 'fore' | 'aft'
  /** post-number anchor (see above) */
  number?: number
  /** a second hut of the same post: no number board / light panel / camera */
  secondary?: true
  /** the number board's reading direction (default '-s') */
  facing?: '-s' | '+s'
  osmWay?: number
  /** hand size [along s, across] (m) — 'building' rows without an osmWay */
  size?: [number, number]
  /** the light panel's position override */
  panel?: { s: number; lateral?: number }
  /** marshals at the post (default 3) */
  figures?: 1 | 2 | 3 | 4
  unverified?: boolean
  note?: string
}

/**
 * Marshal posts: the huts read off the aerial and the OSM `building` footprints at the barrier
 * lines (32 rows, 29 numbered). Every cabin sits on the spectator side of its barrier run with
 * its stand ≥ 0.6 m off the resolved line (O8 / trackside-smoke); rows moved for that at I4-a
 * say so in their note.
 */
export const MARSHAL_POSTS: MarshalPostDef[] = [
  { s: 390, lateral: -31.3, number: 1, unverified: true, note: 'grass island tip, T1 inside (moved 0.3 m off the t1-inside-island line at I4-a)' },
  { s: 420, lateral: 19.5, note: 'T1 outside wall' },
  { s: 500, lateral: 39, unverified: true, note: 'behind the T1 outside wall' },
  { s: 577, lateral: 43, type: 'low', osmWay: 469261666, unverified: true, note: 'OSM hut behind the T1–T2 outside tyre wall (I4-a)' },
  { s: 650, lateral: -18.8, unverified: true, note: 'T2 exit inside wall (the v1 hut straddled the t1-t2-inside line at −16.5; moved 2.3 m behind it at I4-a — the wall bends there, the stair corner is what needs the room)' },
  { s: 666, lateral: 31, type: 'low', osmWay: 184143137, unverified: true, note: 'OSM hut behind the T2 exit outside wall (I4-a)' },
  { s: 865, lateral: -15, osmWay: 184430908, unverified: true, note: 'OSM hut behind the T3 exit inside wall (I4-a)' },
  { s: 1010, lateral: 24.3, unverified: true, note: 'T4 outside gravel edge (0.3 m further off the esses-outside line at I4-a)' },
  { s: 1316, lateral: 32, note: 'OSM building 184146166, 逆バンク outside' },
  { s: 1524, lateral: -18, note: 'OSM building 184432634, NIPPO outside' },
  { s: 1640, lateral: -39.5, note: 'OSM building 184252581, link-road gap' },
  { s: 2075, lateral: 12.5, unverified: true },
  { s: 2204, lateral: 42, type: 'low', osmWay: 468750071, unverified: true, note: 'OSM hut between the Degner 2 trap back and the exit wall (I4-a)' },
  { s: 2295, lateral: 30, unverified: true },
  { s: 2507, lateral: 16, unverified: true, note: '110R left' },
  { s: 2515, lateral: -15, secondary: true, unverified: true, note: 'H stand end: the second hut of the 110R post (no number)' },
  { s: 2652, lateral: 15.0, stair: 'fore', note: 'hairpin infield tip, inside the ( wall (the v1 hut at (2650, 14.5) sat 1.5 m from the hairpin-inside line and its aft stair crossed the diagonal: moved 2 m along and 0.5 m out at I4-a, stair towards +s)' },
  { s: 3040, lateral: -43, unverified: true, note: 'two-wheel chicane' },
  { s: 3245, lateral: -19, type: 'building', size: [20, 5], note: '200R right officials building (20 × 5 m; INFIELD_FACILITIES officials200r draws it, I5)' },
  { s: 3292, lateral: 24.7, osmWay: 184419748, note: 'OSM building 184419748: its footprint projects to (3290–3294, 22.8–26.7), 1.1 m behind the 200r-outside wall — the v1 row (3288, 13.5) had it in the run-off, on the track side of that wall (re-keyed at I4-a)' },
  { s: 3604, lateral: -45, unverified: true },
  { s: 3671, lateral: -38.5, note: 'gap in the Spoon outside wall' },
  { s: 3990, lateral: -11, note: 'OSM building 184419749' },
  { s: 4110, lateral: 12.0, unverified: true, note: '1 m further off the west-straight-left rail at I4-a (the v1 hut at 11 was 1.2 m from the line)' },
  { s: 4526, lateral: -11.5, note: 'OSM building 184419751' },
  { s: 4536, lateral: 10.7, secondary: true, note: 'OSM building 184419746 across the bridge approach: the second hut of the post at 4526 (no number); 1.7 m further off the bridge-approach-left rail at I4-a (the v1 hut at 9 stood on the line)' },
  { s: 4750, lateral: 30, unverified: true },
  { s: 4840, lateral: 25.7, unverified: true, note: '130R inside, behind the 130r-inside-wall (the v1 hut at 10.5 stood in the grass 13 m on the track side of that fenced wall; moved behind it at I4-a)' },
  { s: 4961, lateral: -26, number: 26, osmWay: 467386925, note: '130R exit outside: post 26 (r130_post.jpg — the cabin on its stand behind the tyre wall, the 26 board on the fence)' },
  { s: 5140, lateral: 27, unverified: true, note: 'chicane escape road' },
  { s: 5240, lateral: -28.1, number: 28, figures: 2, unverified: true, note: 'chicane exit: post 28, behind the diagonal chicane-exit-tyres (the v1 row (5235, −19.5) lay on the track side of that wall; the aerial\'s other candidate on the mound at (5255, −22) straddles the car-park fence 474537488, which runs at −21 there)' },
  // moved from {5395, −11.5} (I3-a): that spot is inside the sim's pit-entry path (entering cars
  // lag Track.pitLateralAt toward the track and drive through it; gap_Sim §2). Now on the apron
  // between the lane's keep-out and the car-park fence (its 5450 sample is 1.2 m behind the cabin;
  // −22.3 → −22.6 at I4-a: the v2 stand is 2.7 m across). Only the platform marshal: the ground
  // in front of the stand is the lane's keep-out (O1).
  { s: 5450, lateral: -22.6, type: 'cabin', figures: 1, unverified: true, note: 'pit entry: the stand\'s near edge (−21.25) outside the analytic keep-out (−21.1) and its far edge 0.85 m inside the car-park fence (−24.8)' },
]

/**
 * The post numbers: the rows that are neither 'building' nor `secondary`, ascending in s from
 * post 1 (T1 inside), the anchors (`number`) pinning the count — 1 @ 390, 26 @ 4961, 28 @ 5240.
 * Returns the number of every numbered row (by row object); a row whose count disagrees with
 * its own anchor is a data error facilities-check O8 reports. All numbers unverified.
 */
export function marshalNumbers(): Map<MarshalPostDef, number> {
  const rows = MARSHAL_POSTS.filter((m) => m.type !== 'building' && !m.secondary).sort((a, b) => a.s - b.s)
  const out = new Map<MarshalPostDef, number>()
  let n = 0
  for (const m of rows) {
    n = m.number ?? n + 1
    out.set(m, n)
  }
  return out
}

/**
 * The circuit's PTZ cameras along the straights (43–44 4K PTZ heads on course-side poles feed
 * race control; one more stands at every marshal post — marshal-posts.ts): 6 m poles behind
 * the debris fence at the fence-post pitch, mount 'fencePost' (O5 exempt). Positions unverified.
 */
export interface TracksideCctvDef {
  s: number
  side: Side
  note?: string
}

export const TRACKSIDE_CCTV: TracksideCctvDef[] = [
  { s: 5620, side: 1, note: 'main straight, grandstand fence' },
  { s: 5720, side: 1 },
  { s: 40, side: 1 },
  { s: 140, side: 1 },
  { s: 240, side: 1 },
  { s: 340, side: 1 },
  { s: 1100, side: 1, note: 'esses outside' },
  { s: 2560, side: -1, note: 'hairpin approach' },
  { s: 4400, side: -1, note: 'west straight trap wall' },
  { s: 4480, side: -1 },
  { s: 4780, side: 1, note: '130R inside verge' },
  { s: 5000, side: 1, note: 'chicane approach' },
]

// ---------------------------------------------------------------- TV cameras (I4-b)

export type TvTowerKind = 'scaffold' | 'lattice' | 'crane' | 'pole'

/**
 * One broadcast camera position = one tower (plan I4-b, `app/three/tv-towers.ts`) and, for the
 * `lens` rows, one camera of the rig (`app/three/cameras.ts` reads the lens points the towers
 * publish through `tvLensAt`, `app/three/tv-lens.ts`). The lens is `height` metres above the
 * ground the tower stands on (`ground.standAt`), `TV_LENS.forward` metres towards the track from
 * the tower's centre. `lateral: 'auto'` puts the tower `TV_LENS.autoSetback` (2.5 m) behind the
 * resolved BARRIERS line on the spectator side (`cameraSide`: the outside of the nearest corner)
 * — never in the run-off — so the towers move with the barrier table. The real FOM tower
 * positions are not surveyed: every row is an estimate (`unverified`).
 */
export interface TvCameraDef {
  id: string
  /** metres along the lap */
  s: number
  /** metres from the centreline (+ = the driver's left), or 'auto' (see above) */
  lateral: number | 'auto'
  /** the lens (or the crane's camera head) above the tower's ground (m) */
  height: number
  tower: TvTowerKind
  /** false = a tower with no camera of the rig behind it (the landmark towers, the cranes) */
  lens?: false
  unverified?: string[]
  note?: string
}

/**
 * The 13 lens rows keep the s values the broadcast director has cut between since the first
 * TV mode (the former TV_CAMERA_SPOTS), in s order — the rig's CAM numbers and section names
 * follow that order. `height` 7.9 = the former lens height above the road plane; the towers
 * stand behind the barrier line now, so the lens is where the tower is (inv-camera-coverage:
 * the v1 masts at TV_MAST_OVERRIDES did not stand where the rig looked from).
 */
export const TV_CAMERAS: TvCameraDef[] = [
  { id: 'main-straight', s: 250, lateral: 'auto', height: 7.9, tower: 'scaffold', unverified: ['tower position: generated spot, not the FOM plan'] },
  { id: 't1-crane', s: 455, lateral: -24, height: 6, tower: 'crane', lens: false, unverified: ['a TV crane on the T1 infield is usual on race weekends; position ±10 m'] },
  // the aerial reads the lattice at ≈ (520, +70) / (575, +70) (truth-aerial 02 / 03); (520, +70) is outside the
  // sports_centre ring (which reaches +61 there) and (575, +70) is inside B2's footprint (back edge +76), so it
  // stands behind B2's back edge where the 03 mosaic shows it "east of B": inside the ring, off the stands
  { id: 'b-tower', s: 590, lateral: 82, height: 22, tower: 'lattice', lens: false, note: 'the lattice camera tower behind the B stands (aerial: the one tower certain from above)', unverified: ['position ±10 m', 'height (25–30 m by shadow)'] },
  { id: 't2-exit', s: 640, lateral: 'auto', height: 7.9, tower: 'scaffold', unverified: ['tower position: generated spot'] },
  { id: 'esses', s: 1180, lateral: 'auto', height: 7.9, tower: 'scaffold', unverified: ['tower position: generated spot'] },
  { id: 'esses-exit', s: 1500, lateral: 'auto', height: 7.9, tower: 'scaffold', unverified: ['tower position: generated spot'] },
  { id: 'dunlop', s: 1960, lateral: 'auto', height: 7.9, tower: 'scaffold', note: 'the v1 override (+12) stood on the inside, across the track from the lens; now behind the Dunlop exit tyres', unverified: ['tower position: generated spot'] },
  { id: 'degner2', s: 2230, lateral: 'auto', height: 7.9, tower: 'scaffold', unverified: ['tower position: generated spot'] },
  { id: 'hairpin', s: 2640, lateral: 'auto', height: 7.9, tower: 'scaffold', note: 'behind the hairpin outside tyres', unverified: ['tower position: generated spot'] },
  { id: 'hairpin-column', s: 2680, lateral: 14, height: 6, tower: 'crane', lens: false, note: 'the yellow camera column on the hairpin infield (hairpin.jpg)', unverified: ['position ±5 m'] },
  { id: '200r', s: 3100, lateral: 'auto', height: 7.9, tower: 'scaffold', unverified: ['tower position: generated spot'] },
  { id: 'spoon', s: 3650, lateral: -40, height: 7.9, tower: 'scaffold', note: 'behind the Spoon 1 outside tyres (the v1 override)', unverified: ['tower position'] },
  { id: 'back-straight', s: 4350, lateral: -24, height: 7.9, tower: 'scaffold', note: 'behind the west straight trap wall (the v1 override)', unverified: ['tower position'] },
  { id: '130r', s: 4900, lateral: 'auto', height: 7.9, tower: 'scaffold', unverified: ['tower position: generated spot'] },
  { id: 'chicane', s: 5250, lateral: 'auto', height: 7.9, tower: 'scaffold', unverified: ['tower position: generated spot'] },
  { id: 'start-line', s: 5560, lateral: 'auto', height: 7.9, tower: 'scaffold', unverified: ['tower position: generated spot'] },
]

// ---------------------------------------------------------------- signs

/**
 * drs — the DRS boards (detection line / activation zone); fireStation / pitExit — the white
 * boards at the pit wall's ends (west.jpg / padroad.jpg); pitExitLight — the signal head at the
 * pit-exit line (EMISSIVE.pitExitLight); speed80 — the pit-lane limit ring, painted as a cell of
 * the pit-wall boards by pit-lane.ts (not free-standing: the ring stands ON the wall); speed60 —
 * the round red-bordered 60 at the pit entry. There are no corner-number boards at Suzuka.
 */
export type SignKind = 'drs' | 'fireStation' | 'pitExit' | 'pitExitLight' | 'speed80' | 'speed60'

/**
 * Where a sign hangs instead of standing on posts: pitWallBoard — a cell of the pit wall's board
 * band; pitWallTop — on the white block at the top of the pit wall (pit-lane.ts, I1-c);
 * barrierTop — on a BARRIERS wall's top (I4). Mounted rows are drawn by the wall's builder
 * (structures.ts skips them) and exempt from A11's standing-room rules (facilities-check).
 */
export type SignMount = 'pitWallBoard' | 'pitWallTop' | 'barrierTop'

export interface SignDef {
  id: string
  kind: SignKind
  s: number
  /** signed lateral (m); 'cameraSide' = the outside of the nearest corner, hw + 3.2 (props.ts cameraSide) */
  lateral: number | 'cameraSide'
  /** which face carries the graphic: towards −s (the approaching cars), +s, or across the track (±lateral) */
  facing: '-s' | '+s' | '+lat' | '-lat'
  /** bottom of the board above the ground (m) */
  height: number
  /** board size (m); the DRS boards are square, the pit-exit boards landscape */
  width: number
  boardHeight: number
  /** hangs on a wall instead of standing free (see SignMount) */
  mount?: SignMount
  unverified?: string[]
  note?: string
}

export const SIGNS: SignDef[] = [
  // the detection line sits where both verges are paved (the chicane's two aprons), so the board
  // stands behind the right-hand guardrail on the grass, clear of the tarmac (A11)
  { id: 'drs-detection', kind: 'drs', s: 5150, lateral: -27, facing: '-s', height: 1.5, width: 1.2, boardHeight: 1.2, note: 'DRS detection line (CIRCUIT.drs.detection); behind chicane-approach-right-b, outside the right apron (its edge is −24 at s 5148)', unverified: ['lateral: the board is not resolvable in the aerial; placed on the first unpaved ground beside the line'] },
  { id: 'drs-zone', kind: 'drs', s: 5590, lateral: 'cameraSide', facing: '-s', height: 1.5, width: 1.2, boardHeight: 1.2, note: 'DRS activation (CIRCUIT.drs.start)' },
  // the pit-entry end of the wall (west.jpg / padroad.jpg): the 60 ring and the FIRE STATION board
  // stand side by side on the white block where the concrete wall starts (pit-lane.ts draws them on two posts over the wall top)
  { id: 'pit-entry-60', kind: 'speed60', s: 5556, lateral: -9.4, facing: '-s', mount: 'pitWallTop', height: 1.8, width: 0.6, boardHeight: 0.6, note: 'round red-bordered 60 on the white block where the concrete wall starts (padroad.jpg)', unverified: ['s ±10'] },
  { id: 'fire-station', kind: 'fireStation', s: 5562, lateral: -9.4, facing: '-s', mount: 'pitWallTop', height: 1.8, width: 2.4, boardHeight: 0.6, note: 'white board with red letters on the pit wall beside the 60 (west.jpg)', unverified: ['s ±10 (the photo is a long lens down the straight)'] },
  { id: 'pit-exit', kind: 'pitExit', s: 126, lateral: -20.6, facing: '-s', height: 2.0, width: 1.6, boardHeight: 0.5, unverified: ['position ±5'] },
  { id: 'pit-exit-light', kind: 'pitExitLight', s: 128, lateral: -21.5, facing: '-s', height: 3.0, width: 0.35, boardHeight: 0.9, note: 'at the pit-exit line (LINES pit exit line, s 128), outside the lane' },
  { id: 'pit-lane-80', kind: 'speed80', s: 5570, lateral: -9.4, facing: '-lat', height: 1.05, width: 0.5, boardHeight: 0.5, mount: 'pitWallBoard', note: 'the 80 km/h ring on the pit-lane face of the pit wall at the limit line (CIRCUIT.pit.limitStartS)' },
]

// ---------------------------------------------------------------- basins

export interface BasinDef {
  name: string
  osmWay: number
  /** dry (late-March 2026 photos): a sunken mud floor instead of a water plane */
  dry: boolean
  depth: number
}

export const BASINS: BasinDef[] = [
  { name: 'T1 インフィールドの池', osmWay: 184005565, dry: true, depth: 2.5 },
  { name: 'T1–T2 調整池', osmWay: 132793884, dry: true, depth: 3.0 },
]
