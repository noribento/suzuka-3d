/**
 * The fixed viewpoints scripts/shots.mjs shoots and scripts/perf-probe.mjs `--views` samples:
 * `[name, camera (s, lateral, h), look-at (s, lateral, h), fov]` in track coordinates (s along
 * the lap, lateral + = the driver's left, h above the road plane); the page converts them with
 * `window.__suzuka.track.pointAt`, so they follow the road wherever the profile moves. A null
 * camera means the overview rig's reset framing.
 *
 * Shared module (shots.mjs runs at top level, so its presets could not be imported from there).
 * The chase-in-box framing is generated from PIT_ENVELOPE.stop — the director's pit-follow lens
 * (boxS − 11, stop, +3.4) — so a fallback stop (−17.1) moves the preset with it.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import './ts-hooks.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { PIT_ENVELOPE, garageS } = await import(path.join(ROOT, 'app/data/suzuka-facilities-spec.ts'))
const stop = PIT_ENVELOPE.stop
const box1 = garageS(0)

/** [name, camera (s, lateral, h), look-at (s, lateral, h), fov] */
export const PRESETS = [
  ['main-grandstand', [5700, -14, 5], [5720, 40, 14], 45],
  ['main-grandstand-far', [5560, -60, 22], [5760, 40, 12], 40],
  ['pit-building', [5760, 30, 9], [5700, -45, 8], 45],
  ['pit-straight-onboard', [5880, -14, 1.4], [40, -12, 1], 65],
  ['leader-tower-t1', [5900, 12, 6], [130, -10, 12], 35],
  ['t1-b-c', [520, -25, 10], [640, 70, 12], 50],
  ['c-stand', [720, -18, 8], [820, 60, 14], 45],
  ['esses-d', [1150, -14, 8], [1280, 40, 12], 45],
  ['nippo-e', [1480, -18, 8], [1560, 45, 18], 45],
  ['degner', [2050, 30, 12], [2150, -20, 4], 45],
  ['hairpin', [2600, 20, 12], [2690, -25, 6], 45],
  ['spoon', [3620, 25, 14], [3740, -45, 8], 45],
  ['130r', [4700, -30, 10], [4830, 40, 8], 45],
  ['chicane', [5120, -18, 10], [5210, 40, 10], 45],
  ['final-corner', [5330, -20, 10], [5430, 45, 16], 45],
  // the surroundings (plan §0f): Motopia and the hotel from the straight, the forests behind
  // Degner and Spoon, the west car parks and the crossover bridge, the hotel from the air
  ['motopia-from-straight', [5600, -16, 6], [5470, 300, 25], 38],
  ['forest-degner', [2050, 30, 12], [2200, 140, 35], 45],
  ['forest-spoon', [3600, -20, 10], [3720, -220, 40], 45],
  ['carparks-heli', [5250, -200, 110], [5450, -380, 0], 45],
  ['west-bridge', [4470, -16, 5], [4570, 0, 9], 40],
  ['hotel-heli', [5500, 200, 120], [5480, 520, 10], 45],
  // inside the fences (I phase): the pit building and lane, the paddock, the ops layer, the
  // marshal posts and TV towers, the infield grounds, the cuttings and tunnels
  ['garage-front', [5700, -8, 2], [5720, -30, 4], 55],
  ['pitlane-onboard', [5620, -16, 1.6], [5760, -16, 1.4], 60],
  ['pit-wall-sf', [5790, 14, 3], [30, -12, 3], 50],
  ['chase-in-box', [box1 - PIT_ENVELOPE.chaseLens.back, stop, PIT_ENVELOPE.chaseLens.up], [box1 + 9, stop, 0.9], 55],
  ['paddock-heli', [5800, -140, 90], [5720, -60, 4], 45],
  ['paddock-rear', [5620, -150, 6], [5700, -70, 8], 45],
  ['paddock-walk', [5700, -76.5, 1.7], [5760, -73, 2], 60], // on the 5 m walkway between the hospitality units (−71) and the office porches (−79.5)
  ['centre-house', [5730, -110, 4], [5775, -95, 8], 50],
  ['medical-helipad', [5540, -110, 6], [5570, -70, 3], 50],
  ['pit-exit-yard', [110, -22, 3], [165, -40, 3], 50],
  ['e-paddock', [5470, -20, 6], [5420, -70, 3], 50],
  ['sc-pocket', [138, -22, 2.5], [157, -30, 1.5], 50], // the FIA safety / medical cars wait in the pit-exit yard strip (I3-b: (154 / 160, −30)), not beside the T1 cap
  // the I4 review: 'marshal-post-t1' never framed post 1 (390, −31.4) and 'tv-b-tower' looked at
  // the plan's (520, +70) while the row stands at (602, +88) — both now aim at the rows
  ['marshal-post-t1', [360, -16, 2], [392, -31, 3], 40],
  ['post26', [4930, -14, 2], [4965, -26, 3], 40],
  ['post26-eye', [4945, -8, 1.4], [4961, -24, 3], 45], // post 26 from the verge: the number board, the EM panel and the cabin at eye level
  ['tv-b-tower', [540, 30, 4], [602, 88, 14], 45],
  // I4-c details no preset framed (the I4 review): the Spoon inside wall from the track, the chicane
  // sponges at eye level, the bridge fascia / deck rail, the T2 tricolour wall, the pit-entry
  // sign, a gs-front photo window
  ['spoon-inside-edge', [3560, 12, 3], [3640, 24, 2], 45], // the hard-standing's edge (the I4-c wall there is gone since the I5 review, F5)
  ['chicane-sponges', [5215, -10, 1.6], [5235, -18, 1.2], 45],
  ['bridge-fascia', [2250, -2, 2], [2321, 0, 6], 45],
  ['bridge-rail', [4600, -4, 2], [4700, -7.5, 1.5], 45],
  ['t2-tricolour', [560, -10, 2], [640, -17, 1.5], 45],
  ['pit-entry-sign', [5370, -6, 1.6], [5400, -9.9, 1.5], 45],
  ['gs-window', [5680, 8, 1.6], [5700, 14, 2], 45],
  ['hairpin-inside', [2640, -70, 10], [2700, -20, 4], 45],
  ['spoon-yard', [3500, 60, 10], [3650, 40, 3], 45],
  ['esses-inside', [1010, -70, 12], [1150, -30, 4], 45],
  ['west-pits', [4140, -50, 8], [4225, -20, 8], 45],
  ['south-course-heli', [4450, -180, 140], [4520, -260, 0], 45],
  ['infield-loop', [1850, 20, 60], [1980, 70, 4], 45],
  ['t1-infield', [230, -90, 8], [170, -40, 5], 45],
  ['hairpin-pond', [2350, 40, 30], [2400, 80, 2], 45],
  // the I6 review (V9): the four I6 rows framed the pit building's T1 nose ('works-tunnel', its
  // camera 2 m inside the nose since pit v2), the cut rims from outside the near wall
  // ('cut-chicane', 'cut-county-road': cut643 a far wall behind the Dunlop tyres) and the Q2
  // fronts ('footbridge-q2': the decks sit in the gaps behind the fence) — these were checked by
  // raycast on the built scene (the review's sight.mjs: the first hit and whether the look-at
  // is visible). 'works-portal-ne' (the NE portal from the A1 side) is still to be derived once
  // the A1_TEMP stand's new end is shot on a GPU; the maintainer's yard camera
  // [150, −48, 7] → [117, −30, −1] is blocked by the ops crane at 22 m
  ['cut-chicane', [5080, -20, 8], [5105, -30, -3], 45], // the county-road cut's walls from the chicane approach
  ['works-portal-sw', [117, -108, 6.9], [117, -30.3, -5.4], 45], // down the worksSW ramp from the fuel-station side: the ramp, the headwall, the paddock road crossing
  ['cut643-heli', [5117, 4.5, 9], [5096, -42.8, -7.1], 45], // over the chicane-side tunnel roof onto the 39 m cut's floor and its far portal
  ['cut643-from-dunlop-side', [5140, -40, 12], [5110, -70, -2], 45],
  ['loopSouth-portal', [1744, 72.3, 5.4], [1779, 17.8, -5], 45], // the county road's south approach down to the Dunlop tunnel's portal
  ['r200-portal', [3190, 39, 2.3], [3190, 16.3, -4.6], 45], // the 200R service tunnel's short ramp and headwall
  ['gyaku-ramp-paddock', [5500, -70, 8], [5522, -34, -1], 45], // the 逆バンクトンネル's paddock-side ramp and its black interior
  ['gyaku-ramp-square', [5540, 40, 5], [5513, 28, -3], 45], // the GP-Square-side ramp across the S-beyond lawn (the crowd now keeps 1 m off the walls)
  ['stair-pit-nippo', [1460, 32.3, 5.3], [1483, 30, -2.7], 45], // the pedNippo_L stair pit: headwall, flights, handrails
  ['q2-gap', [5286, 75, 6], [5286, 52, 1], 45], // down the gap between the Q2 bars onto the middle footbridge's deck
  ['chicane-bridge', [5160, 45, 4], [5139, 30, 2], 45], // the chicane service bridge over the county road cut: parapets, deck, the cut below
  // the I5 review (V7): the three I5 wide views above frame none of the I5-b yards' objects —
  // these do, checked by projection (45°, 16:9): the Spoon sheds / tyres / forklift / blocks at
  // 60–170 m, the west paddock's toilets / garage / fence / both lots at 30–125 m, the south
  // course's garage / hut / toilets / walls / fences / flagpoles / north lot
  ['spoon-yard-sheds', [3820, 70, 10], [3930, 38, 3], 45],
  ['west-pits-yard', [4300, -45, 10], [4330, -100, 3], 45],
  ['south-course-pits', [4620, -80, 120], [4510, -135, 0], 45],
  ['south-course-control', [4640, -30, 60], [4570, -60, 0], 45],
  // the I5 review (V12): GPU-only facts to shoot on a real card for I7 — the aFresh joints at
  // s 3540 / 4760, the west pond's shore from the straight, the C lot from above (V1), the
  // Spoon entry's verge (V3), the 130R pond with its island and deck, the Dunlop loop road,
  // the west garage on its slope (V6)
  ['afresh-in', [3480, -2, 1.4], [3600, 0, 1], 45],
  ['afresh-out', [4700, -2, 1.4], [4820, 0, 1], 45],
  ['west-pond-shore', [3990, -10, 3], [4060, -40, -1], 45],
  ['c-lot-heli', [420, -130, 60], [380, -60, 0], 45],
  ['spoon-entry-verge', [3400, -2, 1.4], [3480, 14, 1], 45],
  ['130r-pond', [4540, 20, 10], [4597, 78, -4], 45],
  ['dunlop-road', [1860, 10, 12], [1940, 20, 0], 45],
  ['west-garage', [4300, -70, 4], [4335, -105, 3], 45],
  ['overview', null, null, 45],
]

/** the presets by name */
export const PRESET_OF = new Map(PRESETS.map((p) => [p[0], p]))
