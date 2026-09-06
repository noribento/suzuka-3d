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
  source: { osm?: number[]; samples?: [number, number][]; reach?: number }
  /** never closer to the road than the half-width + this (m); OSM registration guard */
  minGap?: number
  /** debris fence above the top of the barrier (m); 0 / undefined = none */
  fence?: number
  unverified?: string[]
  note?: string
}

const P = (pts: [number, number][]) => pts

export const BARRIERS: BarrierRun[] = [
  // ---- left of the lap, driving order from the start line ---------------------------------
  { id: 'gs-front', kind: 'concrete', side: 1, sRange: [5546, 362], fence: 2.6, source: { osm: [471430732, 471430724, 471430725, 471430720, 471430723, 471430721, 469591632] }, note: 'grandstand / VIP / A1 front wall, boards on the track face, debris fence on top' },
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
  { id: 'bridge-parapet-left', kind: 'concrete', side: 1, sRange: [4585, 4740], source: { samples: P([[4585, 8.0], [4665, 8.0], [4740, 8.0]]) }, note: 'parapet of the crossover deck and its approaches' },
  { id: '130r-inside-verge', kind: 'guardrail', side: 1, sRange: [4740, 4830], source: { osm: [471532691] } },
  { id: '130r-inside-wall', kind: 'concrete', side: 1, sRange: [4830, 4905], fence: 2.6, source: { osm: [468377693] } },
  { id: 'p-front-tyres', kind: 'tyre', side: 1, sRange: [4905, 5160], fence: 2.6, source: { osm: [467219902] } },
  { id: 'chicane-left-wall', kind: 'concrete', side: 1, sRange: [5160, 5335], fence: 2.6, source: { osm: [470173101], reach: 110 }, note: 'round the escape road, the painted apron and the Q2 blocks', unverified: ['5174–5261 (the far side of the escape apron) is interpolated between the two OSM edges'] },
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
  { id: 'bridge-parapet-right', kind: 'concrete', side: -1, sRange: [4585, 4740], source: { samples: P([[4585, -7.5], [4665, -7.5], [4740, -7.5]]) } },
  { id: '130r-outside-verge', kind: 'guardrail', side: -1, sRange: [4740, 4772], source: { samples: P([[4740, -8.0], [4772, -29.0]]) }, unverified: ['transition from the deck parapet to the 130R tyre walls'] },
  { id: '130r-outside-tyres', kind: 'tyre', side: -1, sRange: [4772, 4990], source: { osm: [467386927, 467386917] } },
  { id: '130r-exit-pocket-tyres', kind: 'tyre', side: -1, sRange: [4990, 5124], source: { osm: [467219910] }, note: 'the tyre wall behind the exit gravel pocket' },
  { id: '130r-exit-wall', kind: 'concrete', side: -1, sRange: [4997, 5085], source: { osm: [184102364] }, unverified: ['starts 10 m outside the end of the 130R tyre wall — check the joint on the overlay'] },
  { id: 'chicane-approach-right-a', kind: 'guardrail', side: -1, sRange: [5085, 5134], minGap: 2.0, source: { osm: [467219908] } },
  { id: 'chicane-approach-right-b', kind: 'guardrail', side: -1, sRange: [5150, 5203], minGap: 2.0, source: { samples: P([[5150, -8.0], [5175, -8.5], [5203, -9.0]]) }, note: 'gap at 5134–5150 for the two-wheel pit-in slip road (OSM 467219908 stops at the slip)', unverified: ['aerial only'] },
  { id: 'chicane-exit-tyres', kind: 'tyre', side: -1, sRange: [5203, 5252], source: { osm: [467219893, 467219895, 467219896, 467219894] } },
  { id: 'pit-entry-outer-fence', kind: 'fence', side: -1, sRange: [5250, 5450], source: { samples: P([[5250, -21.0], [5300, -21.5], [5350, -21.6], [5400, -22.0], [5450, -24.0]]) }, note: 'car-park fence behind the pit-entry lane' },
  { id: 't18-pit-entry-separator', kind: 'concrete', side: -1, sRange: [5389, 5538], fence: 2.2, source: { osm: [471532694], samples: P([[5520, -10.5], [5538, -9.7]]) }, note: 'between the track and the pit-entry lane; the pit wall (pit-complex) continues from 5538' },
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
  { name: '130R outside green', sRange: [4705, 4800], side: -1, kind: 'green', width: 4.0 },
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
  { name: 'pit lane divider', sRange: [5560, 180], lateral: -14.2, dash: [3, 3] },
  { name: 'pit lane left edge', sRange: [5470, 125], lateral: -9.9 },
  { name: 'pit lane right edge', sRange: [5470, 100], lateral: -19.3 },
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
  lines?: boolean
  unverified?: string[]
}

export const OFFSET_LANES: OffsetLaneDef[] = [
  // the OSM way only maps the first spur (out to ≈ −25); the loop's centreline is read off the
  // aerial (measured outer edge minus half the 10 m width)
  { name: '200R 二輪シケイン', osmWay: 183309794, samples: P([[2931, -6], [2939, -22], [2952, -33], [2975, -45], [3003, -51], [3016, -46], [3024, -36], [3040, -21], [3050, -8]]), sRange: [2925, 3055], side: -1, width: 10, lines: true, kerbs: [{ from: 0.12, to: 0.3, side: 1 }, { from: 0.42, to: 0.6, side: -1 }, { from: 0.72, to: 0.9, side: 1 }] },
  { name: 'Astemo 二輪ダブルシケイン', osmWay: 183391653, sRange: [5145, 5265], side: 1, width: 8, lines: true },
  { name: '西コースピットレーン', osmWay: 411295350, sRange: [4150, 4375], side: -1, width: 8, lines: true },
  { name: '二輪ピット入口スリップ', osmWay: 411296898, sRange: [5125, 5215], side: -1, width: 6, latMax: 48, lines: true },
  { name: 'ピット入口への接続路', osmWay: 411291883, sRange: [5270, 5395], side: -1, width: 7, lines: false },
  { name: 'イーストコース連絡路', osmWay: 411295346, sRange: [1636, 1680], side: -1, width: 7, latMax: 55, lines: true },
]

// ---------------------------------------------------------------- marshal posts, cameras

export interface MarshalPostDef {
  s: number
  lateral: number
  unverified?: boolean
  note?: string
}

/** Marshal post huts read off the aerial (small white structures at the barrier line). */
export const MARSHAL_POSTS: MarshalPostDef[] = [
  { s: 390, lateral: -31, unverified: true, note: 'grass island tip, T1 inside' },
  { s: 420, lateral: 19.5, note: 'T1 outside wall' },
  { s: 500, lateral: 39, unverified: true, note: 'behind the T1 outside wall' },
  { s: 650, lateral: -16.5, note: 'T2 exit inside wall' },
  { s: 1010, lateral: 24, unverified: true, note: 'T4 outside gravel edge' },
  { s: 1316, lateral: 32, note: 'OSM building 184146166, 逆バンク outside' },
  { s: 1524, lateral: -18, note: 'OSM building 184432634, NIPPO outside' },
  { s: 1640, lateral: -39.5, note: 'OSM building 184252581, link-road gap' },
  { s: 2075, lateral: 12.5, unverified: true },
  { s: 2295, lateral: 30, unverified: true },
  { s: 2507, lateral: 16, unverified: true, note: '110R left' },
  { s: 2515, lateral: -15, unverified: true, note: 'H stand end' },
  { s: 2650, lateral: 14.5, note: 'hairpin infield tip' },
  { s: 3040, lateral: -43, unverified: true, note: 'two-wheel chicane' },
  { s: 3245, lateral: -19, note: '200R right officials building (20 × 5 m)' },
  { s: 3288, lateral: 13.5, note: 'OSM building 184419748' },
  { s: 3604, lateral: -45, unverified: true },
  { s: 3671, lateral: -38.5, note: 'gap in the Spoon outside wall' },
  { s: 3990, lateral: -11, note: 'OSM building 184419749' },
  { s: 4110, lateral: 11, unverified: true },
  { s: 4526, lateral: -11.5, note: 'OSM building 184419751' },
  { s: 4536, lateral: 9, note: 'OSM building 184419746' },
  { s: 4750, lateral: 30, unverified: true },
  { s: 4840, lateral: 10.5, unverified: true, note: '130R inside' },
  { s: 5140, lateral: 27, unverified: true, note: 'chicane escape road' },
  { s: 5235, lateral: -19.5, unverified: true, note: 'beside the chicane exit tyres' },
  { s: 5395, lateral: -11.5, unverified: true, note: 'pit-entry island end' },
]

/** TV camera masts whose default (outside of the nearest corner, hw + 9) lands in a run-off. */
export const TV_MAST_OVERRIDES: Record<number, number> = { 1960: 12, 3650: -40, 4350: -24 }

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
