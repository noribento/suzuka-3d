import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { BARRIERS, type BarrierKind, type BarrierRun } from '~/data/suzuka-barriers-spec'
import { forwardDelta, type Track } from '~/sim/track'
import { ribbonGeometry, wallGeometry } from './track-mesh'
import type { Ground } from './ground'
import { armcoMaps, chainLinkTexture, concreteMaps, tyreWallTexture } from './textures'
import type { Quality } from './quality'
import { bucketedInstancedMeshes } from './instancing'
import { resolveLineCached } from './trackside'

type Fn = (s: number) => number

const _p = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _m = new THREE.Matrix4()

/**
 * Dimensions of each barrier kind: `bottom`/`top` above the ground it stands on, the depth of the
 * top cap, and how many metres of the texture one tile spans along the run.
 */
const KIND = {
  armco: { bottom: 0.32, top: 0.78, cap: 0, tile: 4, posts: true },
  guardrail: { bottom: 0.34, top: 0.8, cap: 0, tile: 4, posts: true },
  concrete: { bottom: 0, top: 1.05, cap: 0.35, tile: 4, posts: false },
  tyre: { bottom: 0, top: 1.95, cap: 0.7, tile: 0.66, posts: false },
  fence: { bottom: 0, top: 0, cap: 0, tile: 4, posts: false },
} as const satisfies Record<BarrierKind, { bottom: number; top: number; cap: number; tile: number; posts: boolean }>

/**
 * A barrier vertex takes the height of the ground beside ITS road. Where the crossover puts one
 * road on the embankment of the other, `ground.yAt` returns that embankment and the wall would
 * climb onto the deck above (the pre-2026-09 audit's "Degner wall on the 130R bridge"), so the
 * rise over the road plane is capped.
 */
const MAX_RISE = 3

/**
 * Barriers around the whole lap, from the hand-authored table in `app/data/suzuka-barriers-spec.ts`
 * (BARRIERS): concrete walls, tyre walls, Armco / white guard rails and the chain-link debris
 * fences above them, each run resolved to a lateral offset along its OWN stretch of road from the
 * OpenStreetMap ways it is mapped from (road-facing edge) and from the samples read off the aerial.
 *
 * Nothing here is derived from the run-off table any more: the old code placed the rail at the far
 * edge of whatever gravel trap was nearby, which put it through the C, D, O and S grandstands, over
 * the 130R bridge and onto the Dunlop road at the chicane. Geometry is merged per material, and the
 * rail posts are instanced in 500 m buckets so a follow camera only draws the ones around it.
 */
export function buildBarriers(track: Track, quality: Quality, ground: Ground): THREE.Group {
  const group = new THREE.Group()
  group.name = 'barriers'
  const L = track.length

  const armco = armcoMaps()
  const railMat = new THREE.MeshStandardMaterial({ map: armco.map, normalMap: armco.normalMap, normalScale: new THREE.Vector2(0.8, 0.8), roughness: 0.55, metalness: 0.7, side: THREE.DoubleSide })
  const guardMat = new THREE.MeshStandardMaterial({ map: armco.map, normalMap: armco.normalMap, normalScale: new THREE.Vector2(0.8, 0.8), color: 0xdfe2e4, roughness: 0.5, metalness: 0.6, side: THREE.DoubleSide })
  const concreteTex = concreteMaps()
  const concreteMat = new THREE.MeshStandardMaterial({ map: concreteTex.map, normalMap: concreteTex.normalMap, roughnessMap: concreteTex.roughnessMap, color: 0xd8d8d4, roughness: 0.95, side: THREE.DoubleSide })
  const capMat = new THREE.MeshStandardMaterial({ map: concreteTex.map, color: 0xcfcfca, roughness: 0.95 })
  const tyreMat = new THREE.MeshStandardMaterial({ map: tyreWallTexture(), roughness: 0.9, side: THREE.DoubleSide })
  const tyreTopMat = new THREE.MeshStandardMaterial({ color: 0x151517, roughness: 0.95 })
  const postMat = new THREE.MeshStandardMaterial({ color: 0x8a8d92, roughness: 0.6, metalness: 0.7 })
  const a2c = quality.msaa > 0
  const fenceMat = new THREE.MeshStandardMaterial({ map: chainLinkTexture(), alphaTest: a2c ? 0.3 : 0.45, alphaToCoverage: a2c, side: THREE.DoubleSide, roughness: 0.6, metalness: 0.5 })

  const geos: Record<string, THREE.BufferGeometry[]> = { rail: [], guard: [], concrete: [], cap: [], tyre: [], tyreTop: [], fence: [] }
  const postMatrices: THREE.Matrix4[] = []
  const postS: number[] = []
  const fencePostMatrices: THREE.Matrix4[] = []
  const fencePostS: number[] = []

  const addPost = (s: number, lat: number, y: number, height: number, scale: number, into: { m: THREE.Matrix4[]; s: number[] }) => {
    const h = track.headingAt(s)
    track.pointAt(s, lat, _p, y + height / 2)
    _q.setFromRotationMatrix(_m.makeBasis(new THREE.Vector3(h.tz, 0, -h.tx), new THREE.Vector3(0, 1, 0), new THREE.Vector3(h.tx, 0, h.tz)))
    into.m.push(new THREE.Matrix4().compose(_p, _q, new THREE.Vector3(scale, height, scale)))
    into.s.push(track.wrap(s))
  }

  for (const run of BARRIERS) {
    const k = KIND[run.kind]
    const [s0, s1] = run.sRange
    const len = forwardDelta(s0, s1, L)
    if (len < 2) continue
    const line = resolveLineCached(track, run.source, run.sRange, run.side, run.minGap ?? 0.6)
    const lat: Fn = (s) => line.lat(s)
    /** ground under the run, never more than MAX_RISE above the road plane (see MAX_RISE) */
    const base: Fn = (s) => Math.min(ground.yAt(s, lat(s)), MAX_RISE)
    const bottom: Fn = (s) => base(s) + k.bottom
    const top: Fn = (s) => base(s) + k.top
    const back: Fn = (s) => lat(s) + run.side * (run.kind === 'tyre' ? 1.3 : 0.35)

    if (run.kind !== 'fence') {
      // the face towards the track, then a cap over the top for the solid kinds
      const face = wallGeometry(track, s0, s1, lat, bottom, top, 2, k.tile, run.kind === 'tyre' ? 0.66 : undefined)
      geos[run.kind === 'armco' ? 'rail' : run.kind === 'guardrail' ? 'guard' : run.kind === 'tyre' ? 'tyre' : 'concrete']!.push(face)
      if (k.cap > 0) {
        const inner = run.side > 0 ? back : lat
        const outer = run.side > 0 ? lat : back
        geos[run.kind === 'tyre' ? 'tyreTop' : 'cap']!.push(ribbonGeometry(track, s0, s1, inner, outer, top, top, 2, 2))
        // the back face, so a wall seen from the paddock is not a one-sided sheet
        geos[run.kind === 'tyre' ? 'tyre' : 'concrete']!.push(wallGeometry(track, s0, s1, back, bottom, top, 4, k.tile, run.kind === 'tyre' ? 0.66 : undefined))
      }
      if (k.posts) for (let d = 0; d <= len; d += 4) addPost(s0 + d, lat(s0 + d), base(s0 + d) + 0.1, 0.85, 0.14, { m: postMatrices, s: postS })
    }

    // chain-link above the barrier (or standing on the ground for a bare fence run)
    const fenceTop = run.kind === 'fence' ? 3.0 : run.fence ?? 0
    if (fenceTop > 0 && quality.fence) {
      const from: Fn = (s) => base(s) + (run.kind === 'fence' ? 0.8 : k.top)
      const to: Fn = (s) => from(s) + fenceTop
      // 20 cm diamonds both ways
      geos.fence!.push(wallGeometry(track, s0, s1, lat, from, to, 4, 0.2, 0.2))
      for (let d = 0; d <= len; d += 4) {
        const s = s0 + d
        addPost(s, lat(s), from(s) - 0.15, fenceTop + 0.15, 0.09, { m: fencePostMatrices, s: fencePostS })
      }
    }
  }

  const add = (key: string, mat: THREE.Material, name: string, cast: boolean) => {
    const list = geos[key]!
    if (!list.length) return
    const merged = mergeGeometries(list, false)
    for (const g of list) g.dispose()
    if (!merged) return
    const mesh = new THREE.Mesh(merged, mat)
    mesh.name = name
    mesh.castShadow = cast
    mesh.receiveShadow = true
    group.add(mesh)
  }
  add('rail', railMat, 'armco', true)
  add('guard', guardMat, 'guardrails', true)
  add('concrete', concreteMat, 'barrierWalls', true)
  add('cap', capMat, 'barrierWallTops', false)
  add('tyre', tyreMat, 'tyreWalls', true)
  add('tyreTop', tyreTopMat, 'tyreWallTops', false)
  add('fence', fenceMat, 'debrisFence', false)

  const postGeo = new THREE.BoxGeometry(1, 1, 1.15)
  for (const inst of bucketedInstancedMeshes(postGeo, postMat, postMatrices, null, (i) => Math.floor(postS[i]! / 500), { name: 'railPosts' })) group.add(inst)
  if (fencePostMatrices.length) {
    const fencePostGeo = new THREE.BoxGeometry(1, 1, 1)
    for (const inst of bucketedInstancedMeshes(fencePostGeo, postMat, fencePostMatrices, null, (i) => Math.floor(fencePostS[i]! / 500), { name: 'fencePosts' })) group.add(inst)
  }

  if (import.meta.dev) {
    const runs = BARRIERS.length
    console.info(`[barriers] ${runs} runs, ${postMatrices.length} rail posts, ${fencePostMatrices.length} fence posts`)
  }
  return group
}

/** Lateral offset of the barrier line on `side` at s, or null where the lap has none there. */
export function barrierLateralAt(track: Track, s: number, side: 1 | -1): number | null {
  const L = track.length
  for (const run of BARRIERS) {
    if (run.side !== side) continue
    if (forwardDelta(run.sRange[0], s, L) > forwardDelta(run.sRange[0], run.sRange[1], L)) continue
    return resolveLineCached(track, run.source, run.sRange, run.side, run.minGap ?? 0.6).lat(s)
  }
  return null
}

export type { BarrierRun }
