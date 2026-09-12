import * as THREE from 'three'
import { worldRing } from '~/data/en-codec'
import { SUR_SITES } from '~/data/suzuka-surroundings'
import type { Track } from '~/sim/track'
import type { EnvBuildContext } from './environment'
import type { FarEntry, FarKind, FarLevel } from './farfield'
import type { PropProto } from './props-pack'

/**
 * LOD and instancing of the infield's props (plan I0-a): one call turns a set of prototypes and
 * their placements into the far-field registry's entries — per 250 m cell (`FarField.cellOf`)
 * one entry with one InstancedMesh per prototype and level, so a cell the camera is far from
 * is skipped with one distance test and a set of 300 cones is a couple of draws, not 300.
 *
 * Levels (plan §横断 4 / 6): the near level draws each set's `proto` inside `levels.nearM`;
 * when at least one prototype is a pack model (`proto.source === 'glb'`) a far level follows
 * with that set's `far` (its procedural stand-in) — a procedural-only set is drawn straight to
 * `farM` — and the last level is an empty Object3D at range ∞ (the far field then hides the
 * entry beyond `farM`). The far level ramps its counts down over `levels.ramp` metres like the
 * crowd. Node and the low tier (no pack, `Quality.infield.glb` false) therefore build exactly
 * one InstancedMesh per prototype and cell: what scene-cost and surface-check measure.
 *
 * Shadows: only the near level casts, and only when the set says so (`casts`) and the tier's
 * far field casts at all — the building-class props (trucks, cabins, towers), never the
 * sub-metre ones (cones, tyres, cables, figures: their shadow is 1–2 texels, plan §横断 6).
 *
 * `Quality.infield.cells` false collapses every set into one bucket (the cell of the set's
 * centroid): the software rasteriser pays per draw, not per triangle, and the whole infield is
 * inside its 330 m reach anyway.
 */

export interface PropPlacement {
  /** world matrix of the instance (position, yaw, scale) */
  m: THREE.Matrix4
  /** per-instance tint (`instanceColor`); a set with any coloured placement colours every instance (white by default) */
  color?: THREE.Color
}

export interface PropSet {
  proto: PropProto
  /** the far level behind a pack prototype (its procedural stand-in); ignored for a procedural `proto` */
  far?: PropProto
  placements: PropPlacement[]
  /** the near level casts shadows (building-class props only) */
  casts?: boolean
}

export interface PropLevels {
  /** the near level's range (m, before lodScale); the pack prototypes are drawn inside this */
  nearM: number
  /** the far level's range: beyond it the entry is hidden */
  farM: number
  /** the far level's counts ramp to 0 over the last this many metres before `farM` */
  ramp?: number
}

export interface PropSetOptions {
  /** the InstancedMeshes receive shadows (default true) */
  receiveShadow?: boolean
}

const _v = new THREE.Vector3()
const WHITE = new THREE.Color(1, 1, 1)

/**
 * Register `sets` under `name` (unique per far-field kind: the entries are `<name>-<cell>`,
 * the meshes `<name>-<protoId>-L<k>-<cell>`) and count its instances into
 * `ctx.infieldStats[name]`. Returns the entries and the instance total (0 when every set is empty).
 */
export function registerPropSet(ctx: EnvBuildContext, kind: FarKind, name: string, sets: PropSet[], levels: PropLevels, opts: PropSetOptions = {}): { entries: FarEntry[]; instances: number } {
  const { farField, quality } = ctx
  const receive = opts.receiveShadow ?? true
  const live = sets.filter((s) => s.placements.length > 0)
  if (!live.length) return { entries: [], instances: 0 }
  // --- buckets: cell of each placement, or one bucket at the centroid --------------------------
  const cellOfPlacement = (p: PropPlacement) => farField.cellOf(p.m.elements[12]!, p.m.elements[14]!)
  let single: number | null = null
  if (!quality.infield.cells) {
    let n = 0
    _v.set(0, 0, 0)
    for (const s of live) for (const p of s.placements) { _v.x += p.m.elements[12]!; _v.z += p.m.elements[14]!; n++ }
    single = farField.cellOf(_v.x / n, _v.z / n)
  }
  const cells = new Map<number, Map<number, number[]>>() // cell → set index → placement indices
  live.forEach((s, si) => {
    s.placements.forEach((p, pi) => {
      const cell = single ?? cellOfPlacement(p)
      let bySet = cells.get(cell)
      if (!bySet) cells.set(cell, (bySet = new Map()))
      let list = bySet.get(si)
      if (!list) bySet.set(si, (list = []))
      list.push(pi)
    })
  })
  // --- levels ---------------------------------------------------------------------------------
  const hasGlb = live.some((s) => s.proto.source === 'glb')
  const shadows = quality.farField.shadows
  const protoAt = (s: PropSet, k: number): PropProto => (k === 0 ? s.proto : s.proto.source === 'glb' ? s.far ?? s.proto : s.proto)
  const ranges: { range: number; ramp?: number }[] = hasGlb
    ? [{ range: levels.nearM }, { range: levels.farM, ramp: levels.ramp }]
    : [{ range: levels.farM, ramp: levels.ramp }]
  const instanced = (s: PropSet, proto: PropProto, list: number[], cast: boolean, meshName: string): THREE.InstancedMesh => {
    const inst = new THREE.InstancedMesh(proto.geometry, proto.materials.length === 1 ? proto.materials[0]! : proto.materials, list.length)
    const coloured = s.placements.some((p) => p.color !== undefined)
    list.forEach((pi, k) => {
      const p = s.placements[pi]!
      inst.setMatrixAt(k, p.m)
      if (coloured) inst.setColorAt(k, p.color ?? WHITE)
    })
    inst.instanceMatrix.needsUpdate = true
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true
    inst.castShadow = cast
    inst.receiveShadow = receive
    inst.frustumCulled = true
    inst.computeBoundingSphere()
    inst.name = meshName
    return inst
  }
  const entries: FarEntry[] = []
  let instances = 0
  for (const [cell, bySet] of cells) {
    const entryLevels: FarLevel[] = []
    ranges.forEach((r, k) => {
      const g = new THREE.Group()
      g.name = `${name}-L${k}-${cell}`
      for (const [si, list] of bySet) {
        const s = live[si]!
        const proto = protoAt(s, k)
        const cast = !!s.casts && k === 0 && shadows
        g.add(instanced(s, proto, list, cast, `${name}-${proto.id}-L${k}-${cell}`))
        if (k === 0) instances += list.length
      }
      const level: FarLevel = { object: g, range: r.range }
      if (r.ramp !== undefined) level.ramp = r.ramp
      entryLevels.push(level)
    })
    const empty = new THREE.Object3D()
    empty.name = `${name}-L${ranges.length}-${cell}`
    entryLevels.push({ object: empty, range: Infinity })
    entries.push(farField.register({ kind, name: `${name}-${cell}`, cell, levels: entryLevels }))
  }
  ctx.infieldStats[name] = (ctx.infieldStats[name] ?? 0) + instances
  return { entries, instances }
}

// ---------------------------------------------------------------------------------------------
// the perimeter: the OSM sports_centre ring of the circuit

/** OSM way of the circuit grounds (leisure=sports_centre, SUR_SITES role 'circuit') — the I-phase scope ring */
export const CIRCUIT_SITE_ID = 775428456

const rings = new WeakMap<Track, Float64Array>()

/** The perimeter ring in world xz (interleaved [x, z, …]), decoded once per Track. */
export function circuitRing(track: Track): Float64Array {
  let r = rings.get(track)
  if (!r) {
    const site = SUR_SITES.find((s) => s.id === CIRCUIT_SITE_ID && s.role === 'circuit')
    if (!site) throw new Error(`[infield-lod] SUR_SITES has no circuit ring ${CIRCUIT_SITE_ID}`)
    r = worldRing(site, track.enScale)
    rings.set(track, r)
  }
  return r
}

/**
 * Whether world (x, z) is inside the perimeter fence (the sports_centre ring 775428456), by the
 * even-odd rule. The ops-check and the smokes assert every ops / infield instance with it.
 */
export function insideRing(track: Track, x: number, z: number): boolean {
  const r = circuitRing(track)
  const n = r.length / 2
  let inside = false
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = r[i * 2]!, zi = r[i * 2 + 1]!, xj = r[j * 2]!, zj = r[j * 2 + 1]!
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside
  }
  return inside
}
