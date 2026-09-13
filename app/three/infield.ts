import type * as THREE from 'three'
import { buildCuttings } from './cuttings'
import type { EnvBuildContext } from './environment'
import type { FigureRole } from './figures'
import { buildInfieldGround } from './infield-ground'
import { buildInfieldWater } from './infield-water'
import { buildMarshalPosts } from './marshal-posts'
import { buildOps } from './ops'
import { buildPaddock } from './paddock'
import { buildPitLane } from './pit-lane'
import { buildTvTowers } from './tv-towers'

/**
 * The infield umbrella (plan I0-a): everything inside the perimeter fence that is not the pit
 * building itself — the pit lane, the paddock, the operations layer, the marshal posts and TV
 * towers, the infield ground's facilities, the ponds and the cuttings — built synchronously in this order
 * between `buildPitComplex` and `buildLanes`, so every sub-builder still has `ctx.boxes` (flushed
 * later), the settled ground (`ground.standY / standAt`, decals) and the pit complex's shared
 * roof material. The far-field registry is borrowed for LOD only (`registerPropSet`,
 * `buildOpsFigures`); the one deferred job of the infield (the south course's trees, I5-c) is
 * queued by vegetation.ts (`infield-south-trees`).
 *
 * Every sub-builder reports through the same shapes: `ctx.infieldStats` (instances per prop
 * set), `OpsStats`, `TracksideStats` — `Environment.stats.ops / .trackside / .infield`, which
 * the e2e suite, the smokes and the ops-check read — and laps its wall-clock into `buildMs`
 * as 'pitLane' / 'paddock' / 'ops' / 'trackside' / 'infield'.
 */

/** the operations layer's counts (figures.ts `buildOpsFigures` + the vehicles and equipment of ops.ts) */
export interface OpsStats {
  figures: number
  byRole: Partial<Record<FigureRole, number>>
  /** impostor instances (every figure has one) */
  impostors: number
  /** 3D figure instances (the near level; high tier with the pack) */
  near3d: number
  mode: 'baked' | 'procedural' | 'none'
  vehicles: number
  equipment: number
}

/** the trackside's counts (marshal-posts.ts, tv-towers.ts) */
export interface TracksideStats {
  /** MARSHAL_POSTS rows built */
  posts: number
  /** of those, cabins on a stand / low posts */
  cabins: number
  lows: number
  /** light panels */
  panels: number
  /** TV towers */
  towers: number
  /** marshal slots (figures) the posts offered */
  slots: number
}

export interface InfieldStats {
  ops: OpsStats
  trackside: TracksideStats
  /** instances per prop set (`registerPropSet` / `buildOpsFigures` name → count) */
  infield: Record<string, number>
}

export interface InfieldOptions {
  /** the pit complex's roof material, shared by the paddock's buildings */
  buildingRoofMat: THREE.Material
  /** the flag-wave clock the marshal posts share with the trackside props */
  flagTime: { value: number }
  /** buildEnvironment's wall-clock lap (`buildMs[name]`) */
  lap: (name: string) => void
}

export function buildInfield(ctx: EnvBuildContext, opts: InfieldOptions): InfieldStats {
  const { lap } = opts
  buildPitLane(ctx)
  lap('pitLane')
  buildPaddock(ctx, { buildingRoofMat: opts.buildingRoofMat })
  lap('paddock')
  const ops = buildOps(ctx)
  lap('ops')
  const posts = buildMarshalPosts(ctx, { flagTime: opts.flagTime })
  const towers = buildTvTowers(ctx)
  lap('trackside')
  buildInfieldGround(ctx)
  buildInfieldWater(ctx)
  buildCuttings(ctx)
  lap('infield')
  return { ops, trackside: { ...posts, ...towers }, infield: ctx.infieldStats }
}
