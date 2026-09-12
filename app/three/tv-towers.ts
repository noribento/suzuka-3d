import type { EnvBuildContext } from './environment'
import type { TracksideStats } from './infield'

/**
 * The TV camera towers (plan I4-b): the scaffold towers, the lattice tower and the platforms
 * from TV_CAMERAS, whose lens points the camera rig reads. Phase I0 lands the entry point only
 * — the umbrella (infield.ts) calls it in order and laps its wall-clock into 'trackside'
 * together with the marshal posts; the content arrives with I4.
 */
export function buildTvTowers(_ctx: EnvBuildContext): Pick<TracksideStats, 'towers'> {
  return { towers: 0 }
}
