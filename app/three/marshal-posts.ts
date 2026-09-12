import type { EnvBuildContext } from './environment'
import type { TracksideStats } from './infield'

/**
 * The marshal posts (plan I4-a): the cabins on their stands, the low posts, the number boards,
 * the light panels and the marshals' slots, from MARSHAL_POSTS v2. Phase I0 lands the entry
 * point only — the umbrella (infield.ts) calls it in order and laps its wall-clock into
 * 'trackside' together with the TV towers; the content arrives with I4. `flagTime` is the
 * flag-wave clock the trackside props share.
 */
export function buildMarshalPosts(_ctx: EnvBuildContext, _opts: { flagTime: { value: number } }): Omit<TracksideStats, 'towers'> {
  return { posts: 0, cabins: 0, lows: 0, panels: 0, slots: 0 }
}
