import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { CIRCUIT, GRANDSTANDS } from '~/data/suzuka'
import { forwardDelta, signedDelta, type Track } from '~/sim/track'
import { gravelRuns, ribbonGeometry, wallGeometry } from './track-mesh'
import type { Ground } from './ground'
import { armcoMaps, chainLinkTexture, tecproTexture, tyreWallTexture } from './textures'
import type { Quality } from './quality'
import { bucketedInstancedMeshes } from './instancing'

type Fn = (s: number) => number

const _p = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _m = new THREE.Matrix4()
const _one = new THREE.Vector3(1, 1, 1)

interface Zone {
  from: number
  to: number
  side: 1 | -1
  /** fixed lateral position instead of the run-off distance (fence on top of the pit wall) */
  lat?: Fn
  /** height of the base the zone stands on, relative to the road plane (default: the ground) */
  base?: Fn
}

function inZone(track: Track, s: number, z: Zone): boolean {
  const len = forwardDelta(z.from, z.to, track.length)
  return forwardDelta(z.from, s, track.length) <= len
}

/**
 * Barriers around the whole lap:
 *  - Armco guard rail at the edge of the run-off on both sides (with posts),
 *  - tyre walls (conveyor-belt covered) behind the gravel traps of the fast corners,
 *  - TecPro blocks at 130R and the chicane,
 *  - debris fencing in front of every grandstand and on top of the pit wall.
 * Everything stands on the ground surface (verge / embankment), not on the road plane.
 * The elevated bridge section already has its own rails and is skipped; the pit building
 * side of the main straight is closed by the pit wall instead of Armco.
 */
export function buildBarriers(track: Track, quality: Quality, ground: Ground): THREE.Group {
  const group = new THREE.Group()
  group.name = 'barriers'
  const L = track.length
  const cross = track.crossing
  const pit = CIRCUIT.pit
  const hwAt: Fn = (s) => track.halfWidthAt(s)
  const groundAt = (s: number, lat: number) => ground.yAt(s, lat)

  // gravel traps come from the OSM-derived run-off table (RUNOFF_ZONES via track-mesh.ts
  // gravelRuns): the barrier line moves out to the trap's far edge (capped so it stays on the
  // draped verge) and a tyre wall stands behind it
  const gravel: (Zone & { outer: number })[] = []
  const tyreZones: Zone[] = []
  for (const run of gravelRuns(track)) {
    gravel.push({ from: run.from, to: run.to, side: run.side, outer: Math.min(40, Math.max(25, run.outer)) })
    tyreZones.push({ from: run.from + 8, to: run.to - 8, side: run.side })
  }
  const tecpro: Zone[] = [
    { from: cross.sOver + 100, to: 4900, side: -1 }, // 130R outside (after the crossover embankment)
    { from: 5100, to: 5260, side: 1 }, // chicane
    { from: 5190, to: 5300, side: -1 },
  ]
  const nearBridge = (s: number) => Math.abs(signedDelta(s, cross.sOver, L)) < 175
  /** the pit lane runs along the right of the track here (entry road → exit road) */
  const pitZone: Zone = { from: pit.entryS - 20, to: pit.exitS + 40, side: -1 }
  /** pit wall + garages: no Armco on the right */
  const wallZone: Zone = { from: pit.limitStartS - 40, to: pit.limitEndS, side: -1 }

  /** distance of the barrier line from the road edge on `side` */
  const dist = (s: number, side: 1 | -1): number => {
    let d = 11
    for (const z of gravel) if (z.side === side && inZone(track, s, z)) d = Math.max(d, z.outer)
    // close to the road along the pit straight on the grandstand side; behind the pit lane on the other
    if (side > 0 && (s > 5480 || s < 470)) d = 9
    if (side < 0 && inZone(track, s, pitZone)) d = pit.laneWidth + 6
    return d
  }

  // --- Armco (both sides, whole lap minus the bridge and the pit wall) --------------------
  const armco = armcoMaps()
  const armcoMat = new THREE.MeshStandardMaterial({ map: armco.map, normalMap: armco.normalMap, normalScale: new THREE.Vector2(0.8, 0.8), roughness: 0.55, metalness: 0.7, side: THREE.DoubleSide })
  const railGeos: THREE.BufferGeometry[] = []
  const postGeo = new THREE.BoxGeometry(0.12, 0.85, 0.16)
  const postMat = new THREE.MeshStandardMaterial({ color: 0x8a8d92, roughness: 0.6, metalness: 0.7 })
  const postMatrices: THREE.Matrix4[] = []
  const postS: number[] = []
  for (const side of [1, -1] as const) {
    // split into runs that avoid the bridge (and the pit wall on the right)
    const segments: [number, number][] = []
    let start: number | null = null
    for (let s = 0; s <= L; s += 4) {
      const skip = nearBridge(s) || s >= L || (side < 0 && inZone(track, s, wallZone))
      if (!skip && start === null) start = s
      if (skip && start !== null) {
        segments.push([start, s - 4])
        start = null
      }
    }
    for (const [a, b] of segments) {
      if (b - a < 8) continue
      const lat: Fn = (s) => side * (hwAt(s) + dist(s, side))
      railGeos.push(wallGeometry(track, a, b, lat, (s) => groundAt(s, lat(s)) + 0.32, (s) => groundAt(s, lat(s)) + 0.78, 4, 4))
      for (let s = a; s <= b; s += 4) {
        const h = track.headingAt(s)
        track.pointAt(s, lat(s), _p, groundAt(s, lat(s)) + 0.42)
        _q.setFromRotationMatrix(_m.makeBasis(new THREE.Vector3(h.tz, 0, -h.tx), new THREE.Vector3(0, 1, 0), new THREE.Vector3(h.tx, 0, h.tz)))
        postMatrices.push(new THREE.Matrix4().compose(_p, _q, _one))
        postS.push(s)
      }
    }
  }
  const rails = new THREE.Mesh(mergeGeometries(railGeos, false)!, armcoMat)
  rails.name = 'armco'
  rails.castShadow = true
  group.add(rails)
  // posts in 500 m runs so a follow camera only draws the ones around it
  for (const inst of bucketedInstancedMeshes(postGeo, postMat, postMatrices, null, (i) => Math.floor(postS[i]! / 500), { name: 'armcoPosts' })) group.add(inst)

  /** front face + top of a block wall standing on the ground between `lat` and `back` */
  const blockWall = (z: Zone, lat: Fn, back: Fn, height: number, faceStep: number, faceV: number, faceGeos: THREE.BufferGeometry[], topGeos: THREE.BufferGeometry[]) => {
    const base: Fn = (s) => groundAt(s, lat(s))
    faceGeos.push(wallGeometry(track, z.from, z.to, lat, base, (s) => base(s) + height, faceStep, faceV))
    const inner = z.side > 0 ? back : lat
    const outer = z.side > 0 ? lat : back
    topGeos.push(ribbonGeometry(track, z.from, z.to, inner, outer, (s) => base(s) + height, (s) => base(s) + height, 2, 2))
  }

  // --- tyre walls behind the gravel traps ------------------------------------------------------
  const tyreTex = tyreWallTexture()
  const tyreMat = new THREE.MeshStandardMaterial({ map: tyreTex, roughness: 0.9, side: THREE.DoubleSide })
  const tyreTop = new THREE.MeshStandardMaterial({ color: 0x151517, roughness: 0.95 })
  const tyreGeos: THREE.BufferGeometry[] = []
  const tyreTopGeos: THREE.BufferGeometry[] = []
  for (const z of tyreZones) {
    if (nearBridge(z.from) || nearBridge(z.to)) continue
    const lat: Fn = (s) => z.side * (hwAt(s) + dist(s, z.side) - 0.4)
    const back: Fn = (s) => z.side * (hwAt(s) + dist(s, z.side) + 0.9)
    // front face (belt + tyres), 1.95 m = three tyres
    blockWall(z, lat, back, 1.95, 2, 0.66, tyreGeos, tyreTopGeos)
  }
  if (tyreGeos.length) {
    const tw = new THREE.Mesh(mergeGeometries(tyreGeos, false)!, tyreMat)
    tw.castShadow = true
    tw.name = 'tyreWalls'
    group.add(tw, new THREE.Mesh(mergeGeometries(tyreTopGeos, false)!, tyreTop))
  }

  // --- TecPro ---------------------------------------------------------------------------------
  const tecMat = new THREE.MeshStandardMaterial({ map: tecproTexture(), roughness: 0.7, side: THREE.DoubleSide })
  const tecGeos: THREE.BufferGeometry[] = []
  for (const z of tecpro) {
    const lat: Fn = (s) => z.side * (hwAt(s) + dist(s, z.side) - 0.3)
    const back: Fn = (s) => z.side * (hwAt(s) + dist(s, z.side) + 0.8)
    blockWall(z, lat, back, 1.2, 2, 2, tecGeos, tecGeos)
  }
  const tec = new THREE.Mesh(mergeGeometries(tecGeos, false)!, tecMat)
  tec.castShadow = true
  group.add(tec)

  // --- debris fencing in front of the spectator areas (skipped on the software tier) ---------
  if (quality.fence) {
    const a2c = quality.msaa > 0
    const fenceMat = new THREE.MeshStandardMaterial({ map: chainLinkTexture(), alphaTest: a2c ? 0.3 : 0.45, alphaToCoverage: a2c, side: THREE.DoubleSide, roughness: 0.6, metalness: 0.5 })
    const fenceGeos: THREE.BufferGeometry[] = []
    const fencePostMatrices: THREE.Matrix4[] = []
    const fencePostS: number[] = []
    const zones: Zone[] = GRANDSTANDS.map(([from, to, side]) => ({ from: from - 20, to: to + 20, side }))
    // pit side of the main straight: on the verge along the entry road, on top of the pit wall, then along the exit road
    zones.push({ from: pit.entryS, to: wallZone.from, side: -1 })
    zones.push({ from: wallZone.from, to: wallZone.to, side: -1, lat: () => pit.wallOffset, base: () => 1.2 })
    zones.push({ from: wallZone.to, to: 470, side: -1 })
    for (const z of zones) {
      const lat: Fn = z.lat ?? ((s) => z.side * (hwAt(s) + dist(s, z.side) + 0.35))
      const base: Fn = z.base ?? ((s) => groundAt(s, lat(s)))
      // 20 cm diamonds both ways: 14 tiles up the 2.8 m of mesh
      fenceGeos.push(wallGeometry(track, z.from, z.to, lat, (s) => base(s) + 0.8, (s) => base(s) + 3.6, 4, 0.2, 0.2))
      const len = forwardDelta(z.from, z.to, L)
      for (let d = 0; d <= len; d += 4) {
        const s = z.from + d
        const h = track.headingAt(s)
        track.pointAt(s, lat(s), _p, base(s) + 2.2)
        _q.setFromRotationMatrix(_m.makeBasis(new THREE.Vector3(h.tz, 0, -h.tx), new THREE.Vector3(0, 1, 0), new THREE.Vector3(h.tx, 0, h.tz)))
        fencePostMatrices.push(new THREE.Matrix4().compose(_p, _q, new THREE.Vector3(0.8, 3.3, 0.8)))
        fencePostS.push(track.wrap(s))
      }
    }
    const fence = new THREE.Mesh(mergeGeometries(fenceGeos, false)!, fenceMat)
    fence.name = 'debrisFence'
    group.add(fence)
    const fencePostGeo = new THREE.BoxGeometry(0.1, 1, 0.1)
    for (const inst of bucketedInstancedMeshes(fencePostGeo, postMat, fencePostMatrices, null, (i) => Math.floor(fencePostS[i]! / 500), { name: 'fencePosts' })) group.add(inst)
  }

  return group
}
