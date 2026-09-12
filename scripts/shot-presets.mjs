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
  ['marshal-post-t1', [390, -24, 2], [420, -16, 2], 40],
  ['post26', [4930, -14, 2], [4965, -26, 3], 40],
  ['tv-b-tower', [480, 30, 4], [520, 70, 12], 45],
  ['hairpin-inside', [2640, -70, 10], [2700, -20, 4], 45],
  ['spoon-yard', [3500, 60, 10], [3650, 40, 3], 45],
  ['esses-inside', [1010, -70, 12], [1150, -30, 4], 45],
  ['west-pits', [4140, -50, 8], [4225, -20, 8], 45],
  ['south-course-heli', [4450, -180, 140], [4520, -260, 0], 45],
  ['infield-loop', [1850, 20, 60], [1980, 70, 4], 45],
  ['t1-infield', [230, -90, 8], [170, -40, 5], 45],
  ['hairpin-pond', [2350, 40, 30], [2400, 80, 2], 45],
  ['cut-county-road', [1740, -20, 8], [1790, -45, -2], 45],
  ['cut-chicane', [5080, -20, 8], [5105, -30, -3], 45],
  ['works-tunnel', [90, -40, 6], [119, -26, -3], 45],
  ['footbridge-q2', [5250, 20, 4], [5286, 55, 6], 40],
  ['overview', null, null, 45],
]

/** the presets by name */
export const PRESET_OF = new Map(PRESETS.map((p) => [p[0], p]))
