import * as THREE from 'three'
import type { Track } from '~/sim/track'
import type { Terrain } from './environment'
import { FLAT_STRIP, RUNOFF_LIFT, STRIP_DROP, projectGlobal } from './ground-plan'

/**
 * The ground FIELD: the one continuous height every field-frame ground face rides on, and the
 * only place the analytic terrain is sampled for the ground (plan rule R3).
 *
 *   off ≤ 2 m            the flat strip on the road plane, STRIP_DROP below the asphalt
 *   2 m < off < 8 m      a smoothstep from the strip to the terrain
 *   off ≥ 8 m            the analytic terrain + RUNOFF_LIFT
 *
 * It used to be three functions in three files (ground.yAt with a 0.25 m memo and a switch to
 * the DRAWN terrain mesh past the verge width, surfaces.ts with its own blend, the mesh-frame
 * sheets on the drawn grid) that disagreed by up to 165 mm at the same point. One function on
 * shared vertices cannot disagree with itself.
 */
export interface GroundField {
  /** height at (s, lateral) on that stretch of road, world y */
  yAt(s: number, lateral: number): number
  /** height at world (x, z), projected onto the road within `window` when given, else crossover-aware nearest */
  y(x: number, z: number, window?: [number, number]): number
  /**
   * `y(x, z)` for a caller that already holds the point's crossover-aware projection
   * (`projectGlobal` / `plan.project(x, z)` without a window): the same arithmetic on the same
   * projection, so the same number — the mesh builder's refinement projects every midpoint for
   * its (s, lateral) anyway and reads the field on that instead of projecting twice.
   */
  yProjected(x: number, z: number, p: { s: number; lateral: number }): number
  /** the field's terrain term alone (no strip rule), for faces far from any road */
  terrainAt(x: number, z: number): number
}

const BLEND_TO = 8

function smoothstep(t: number): number {
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return t * t * (3 - 2 * t)
}

export function makeField(track: Track, terrain: Terrain): GroundField {
  const _p = new THREE.Vector3()
  const yAt = (s: number, lateral: number): number => {
    const hw = track.halfWidthAt(s)
    const off = Math.abs(lateral) - hw
    track.pointAt(s, lateral, _p, 0)
    if (off <= 0) return _p.y
    const strip = _p.y + STRIP_DROP
    if (off <= FLAT_STRIP) return strip
    const t = terrain.heightAt(_p.x, _p.z) + RUNOFF_LIFT
    if (off >= BLEND_TO) return t
    return strip + (t - strip) * smoothstep((off - FLAT_STRIP) / (BLEND_TO - FLAT_STRIP))
  }
  const yProjected = (x: number, z: number, p: { s: number; lateral: number }): number => {
    const hw = track.halfWidthAt(p.s)
    const off = Math.abs(p.lateral) - hw
    if (off >= BLEND_TO) return terrain.heightAt(x, z) + RUNOFF_LIFT
    // inside the blend the strip term comes from the projection; the terrain term from the point
    track.pointAt(p.s, p.lateral, _p, 0)
    if (off <= 0) return _p.y
    const strip = _p.y + STRIP_DROP
    if (off <= FLAT_STRIP) return strip
    const t = terrain.heightAt(x, z) + RUNOFF_LIFT
    return strip + (t - strip) * smoothstep((off - FLAT_STRIP) / (BLEND_TO - FLAT_STRIP))
  }
  const y = (x: number, z: number, window?: [number, number]): number => yProjected(x, z, window ? track.nearestOnRange(x, z, window[0], window[1], 60) : projectGlobal(track, x, z))
  return { yAt, y, yProjected, terrainAt: (x, z) => terrain.heightAt(x, z) + RUNOFF_LIFT }
}
