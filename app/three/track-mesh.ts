import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { APEX_SPEED_TARGETS, CIRCUIT, SAUSAGE_KERB_CORNERS } from '~/data/suzuka'
import { forwardDelta, type Track } from '~/sim/track'
import { asphaltMaps, boardTexture, concreteMaps, gravelMaps, grassMaps, kerbMaps, type MaterialMaps } from './textures'
import { FLAT_STRIP, RUNOFF_LIFT, RUNOFF_WIDTH, STRIP_DROP, type Ground } from './ground'
import type { Terrain } from './environment'

type Fn = (s: number) => number

const _p = new THREE.Vector3()

/**
 * Ribbon following the track between s0 and s1 (forward), with per-edge lateral
 * offsets and heights. UV: u across (0..1), v along (s / vScale).
 */
export function ribbonGeometry(
  track: Track,
  s0: number,
  s1: number,
  leftLat: Fn,
  rightLat: Fn,
  leftY: Fn,
  rightY: Fn,
  step = 2,
  vScale = 10,
  uAcross = 1,
): THREE.BufferGeometry {
  const len = s0 === s1 ? track.length : forwardDelta(s0, s1, track.length) || track.length
  const segs = Math.max(1, Math.ceil(len / step))
  const pos: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  for (let i = 0; i <= segs; i++) {
    const d = (i / segs) * len
    const s = s0 + d
    track.pointAt(s, leftLat(s), _p, leftY(s))
    pos.push(_p.x, _p.y, _p.z)
    track.pointAt(s, rightLat(s), _p, rightY(s))
    pos.push(_p.x, _p.y, _p.z)
    const v = d / vScale
    uv.push(0, v, uAcross, v)
    if (i < segs) {
      const a = i * 2
      // counter-clockwise seen from above (+Y) so the surface is front-facing
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

/**
 * Ribbon with an arbitrary cross-section: `edges` lists (lateral, height) functions from
 * one side to the other; u runs 0..1 across the edges (or `uAt[e]` when given), v = s / vScale.
 * Edges must be ordered right-to-left (increasing lateral) for the surface to face up.
 */
export function profileRibbonGeometry(track: Track, s0: number, s1: number, edges: [Fn, Fn][], step = 1, vScale = 2, uAt?: number[]): THREE.BufferGeometry {
  const len = forwardDelta(s0, s1, track.length) || track.length
  const segs = Math.max(1, Math.ceil(len / step))
  const E = edges.length
  const pos: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  for (let i = 0; i <= segs; i++) {
    const d = (i / segs) * len
    const s = s0 + d
    for (let e = 0; e < E; e++) {
      const [lat, y] = edges[e]!
      track.pointAt(s, lat(s), _p, y(s))
      pos.push(_p.x, _p.y, _p.z)
      uv.push(uAt ? uAt[e]! : e / (E - 1), d / vScale)
    }
    if (i < segs) {
      for (let e = 0; e < E - 1; e++) {
        const a = i * E + e
        // (forward, then across towards +lateral) is counter-clockwise seen from above
        idx.push(a, a + E, a + 1, a + 1, a + E, a + E + 1)
      }
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

/** Vertical wall along a lateral offset, from yBottom(s) to yTop(s) (both relative to track height). */
export function wallGeometry(track: Track, s0: number, s1: number, lat: Fn, yBottom: Fn, yTop: Fn, step = 4, vScale = 8): THREE.BufferGeometry {
  const len = forwardDelta(s0, s1, track.length) || track.length
  const segs = Math.max(1, Math.ceil(len / step))
  const pos: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  for (let i = 0; i <= segs; i++) {
    const d = (i / segs) * len
    const s = s0 + d
    track.pointAt(s, lat(s), _p, yBottom(s))
    pos.push(_p.x, _p.y, _p.z)
    track.pointAt(s, lat(s), _p, yTop(s))
    pos.push(_p.x, _p.y, _p.z)
    uv.push(d / vScale, 0, d / vScale, 1)
    if (i < segs) {
      const a = i * 2
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

function pbr(maps: MaterialMaps, extra: THREE.MeshStandardMaterialParameters = {}, normalScale = 1): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ map: maps.map, roughness: 1, metalness: 0, ...extra })
  if (maps.normalMap) {
    m.normalMap = maps.normalMap
    m.normalScale.set(normalScale, normalScale)
  }
  if (maps.roughnessMap) m.roughnessMap = maps.roughnessMap
  return m
}

export interface TrackMeshes {
  group: THREE.Group
  surface: THREE.Mesh
  startLampMaterials: THREE.MeshStandardMaterial[]
}

/** Cross-section sample offsets (m beyond the asphalt edge) of the draped run-off ribbon. */
const RUNOFF_OFFSETS = [0, FLAT_STRIP, 3.5, 5.5, 8, 11, 14.5, 18.5, 23, 28, RUNOFF_WIDTH]
/** Cross-section of the gravel traps as fractions of the local trap width. */
const GRAVEL_FRACTIONS = [0, 0.1, 0.25, 0.45, 0.7, 1]

export function buildTrackMeshes(track: Track, terrain: Terrain, ground: Ground): TrackMeshes {
  const group = new THREE.Group()
  /** local half-width — the road narrows to ~10.5 m at the Degners and widens to 15 m on the pit straight */
  const hwAt: Fn = (s) => track.halfWidthAt(s)
  const hw = track.halfWidth
  const L = track.length
  const zero: Fn = () => 0
  const cross = track.crossing
  const groundHeightAt = (x: number, z: number) => terrain.heightAt(x, z)
  /** surfaces the terrain mesh must stay underneath */
  const groundGeos: THREE.BufferGeometry[] = []

  // --- asphalt (the cross-slope is applied inside track.pointAt) -----------------------
  const asphaltMat = pbr(asphaltMaps(true), {}, 0.7)
  const surface = new THREE.Mesh(ribbonGeometry(track, 0, 0, hwAt, (s) => -hwAt(s), zero, zero, 2, 20), asphaltMat)
  surface.name = 'asphalt'
  surface.receiveShadow = true
  group.add(surface)
  groundGeos.push(surface.geometry)

  // --- run-off grass: a flat strip under the kerbs, then draped over the terrain (see ground.ts) ---
  const grassMat = pbr(grassMaps(true), {}, 0.8)
  const runoffGeo = (side: 1 | -1) => {
    const edges: [Fn, Fn][] = RUNOFF_OFFSETS.map((off) => {
      const lat: Fn = (s) => side * (hwAt(s) + (off * ground.runoffWidth(s)) / RUNOFF_WIDTH)
      return [lat, (s) => ground.yAt(s, lat(s))]
    })
    const u = RUNOFF_OFFSETS.map((off) => (off / RUNOFF_WIDTH) * 4)
    // edges must run right-to-left (increasing lateral)
    if (side < 0) {
      edges.reverse()
      u.reverse()
    }
    return profileRibbonGeometry(track, 0, 0, edges, 4, 8, u)
  }
  const runoffL = new THREE.Mesh(runoffGeo(1), grassMat)
  const runoffR = new THREE.Mesh(runoffGeo(-1), grassMat)
  runoffL.receiveShadow = runoffR.receiveShadow = true
  runoffL.name = 'runoffL'
  runoffR.name = 'runoffR'
  group.add(runoffL, runoffR)
  groundGeos.push(runoffL.geometry, runoffR.geometry)

  // --- kerbs + gravel per corner ---------------------------------------------
  const kerbMat = pbr(kerbMaps(), { roughness: 0.75 }, 0.9)
  const gravelMat = pbr(gravelMaps(), {}, 1.0)
  const kerbGeos: THREE.BufferGeometry[] = []
  const gravelGeos: THREE.BufferGeometry[] = []
  const sausageSpots: { s: number; side: 1 | -1 }[] = []
  const pit = CIRCUIT.pit
  // no kerbs on the right where the pit lane joins and leaves the track
  const kerbSpans = (from: number, to: number, side: 1 | -1): [number, number][] =>
    side < 0 ? subtractInterval(from, to, pit.entryS - 4, pit.exitS + 4, L) : [[from, to]]
  for (const c of track.corners) {
    const len = forwardDelta(c.from, c.to, L)
    const from = c.from - 12
    const to = c.to + 12
    const inside = c.sign
    const outside: 1 | -1 = inside > 0 ? -1 : 1
    // inside kerb (1.3 m) and exit kerb (1.0 m) with a real cross-section: a ramp up from the
    // asphalt, a crowned top and a drop into the grass behind
    for (const [a, b] of kerbSpans(from, to, inside)) kerbGeos.push(kerbProfile(track, a, b, inside, 1.3, hwAt))
    const exitFrom = c.apex - 5
    for (const [a, b] of kerbSpans(exitFrom, to + 10, outside)) kerbGeos.push(kerbProfile(track, a, b, outside, 1.0, hwAt))
    const tgt = APEX_SPEED_TARGETS.find((t) => Math.abs(forwardDeltaSigned(t.s, c.apex, L)) < 60)
    if (tgt && SAUSAGE_KERB_CORNERS.includes(tgt.name)) {
      for (let k = 0; k < 6; k++) sausageSpots.push({ s: c.apex + 12 + k * 1.7, side: outside })
    }
    if (c.maxKappa > 1 / 170 && len > 30) {
      const gFrom = c.from - 30
      const gTo = c.to + 40
      const gLen = forwardDelta(gFrom, gTo, L)
      // trap width beyond the asphalt edge: fades in/out over 30 m, never wider than the verge
      const width: Fn = (s) => {
        const d = forwardDelta(gFrom, s, L)
        const t = Math.min(d / 30, (gLen - d) / 30, 1)
        return Math.min(1.4 + 20 * Math.max(0, t), Math.max(1.4, ground.runoffWidth(s) - 0.3))
      }
      const out: 1 | -1 = inside > 0 ? -1 : 1
      // the trap sits 2 cm proud of the flat strip and follows the verge further out
      const edges: [Fn, Fn][] = GRAVEL_FRACTIONS.map((f) => {
        const lat: Fn = (s) => out * (hwAt(s) + 1.4 + f * (width(s) - 1.4))
        const y: Fn = (s) => {
          const l = lat(s)
          const off = Math.abs(l) - hwAt(s)
          return off <= FLAT_STRIP ? 0.02 : ground.yAt(s, l) + 0.04
        }
        return [lat, y]
      })
      const u = GRAVEL_FRACTIONS.map((f) => f * 6)
      if (out < 0) {
        edges.reverse()
        u.reverse()
      }
      gravelGeos.push(profileRibbonGeometry(track, gFrom, gTo, edges, 3, 3, u))
    }
  }
  // one draw call per material for all kerbs / gravel traps
  const kerbs = new THREE.Mesh(mergeGeometries(kerbGeos, false)!, kerbMat)
  kerbs.name = 'kerbs'
  kerbs.receiveShadow = true
  group.add(kerbs)
  // sausage kerbs: yellow blocks behind the exit kerbs of the corners where they are used
  if (sausageSpots.length) {
    const sausageGeo = new RoundedBoxGeometry(0.4, 0.12, 1.3, 2, 0.05)
    const sausageMat = new THREE.MeshStandardMaterial({ color: 0xf2c400, roughness: 0.6 })
    const sausages = new THREE.InstancedMesh(sausageGeo, sausageMat, sausageSpots.length)
    sausages.castShadow = true
    const q = new THREE.Quaternion()
    const mat4 = new THREE.Matrix4()
    sausageSpots.forEach((sp, i) => {
      const h = track.headingAt(sp.s)
      track.pointAt(sp.s, sp.side * (hwAt(sp.s) + 1.25), _p, 0.06)
      q.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(h.tz, 0, -h.tx), new THREE.Vector3(0, 1, 0), new THREE.Vector3(h.tx, 0, h.tz)))
      mat4.compose(_p, q, new THREE.Vector3(1, 1, 1))
      sausages.setMatrixAt(i, mat4)
    })
    sausages.instanceMatrix.needsUpdate = true
    group.add(sausages)
  }
  if (gravelGeos.length) {
    const gravel = new THREE.Mesh(mergeGeometries(gravelGeos, false)!, gravelMat)
    gravel.name = 'gravel'
    gravel.receiveShadow = true
    group.add(gravel)
    groundGeos.push(gravel.geometry)
  }

  // --- crossover bridge -------------------------------------------------------
  const concrete = pbr(concreteMaps(), { roughness: 0.95, side: THREE.DoubleSide }, 0.6)
  const rail = new THREE.MeshStandardMaterial({ color: 0xd8d8d8, roughness: 0.6, metalness: 0.3, side: THREE.DoubleSide })
  const span = 19
  const approach = 160
  const concreteGeos: THREE.BufferGeometry[] = []
  // deck slab
  concreteGeos.push(ribbonGeometry(track, cross.sOver - span, cross.sOver + span, (s) => hwAt(s) + 1.2, (s) => -hwAt(s) - 1.2, () => -1.3, () => -1.3, 3, 10))
  concreteGeos.push(wallGeometry(track, cross.sOver - span, cross.sOver + span, (s) => hwAt(s) + 1.2, () => -1.3, () => 0.0, 3))
  concreteGeos.push(wallGeometry(track, cross.sOver - span, cross.sOver + span, (s) => -hwAt(s) - 1.2, () => -1.3, () => 0.0, 3))
  // embankments (walls down to the terrain) either side of the span
  for (const [a, b] of [[cross.sOver - approach, cross.sOver - span], [cross.sOver + span, cross.sOver + approach]] as const) {
    for (const side of [1, -1] as const) {
      const lat: Fn = (s) => side * (hwAt(s) + 1.2)
      const bottom: Fn = (s) => {
        track.pointAt(s, lat(s), _p)
        return Math.min(-0.05, groundHeightAt(_p.x, _p.z) - _p.y - 0.4)
      }
      concreteGeos.push(wallGeometry(track, a, b, lat, bottom, () => 0, 4))
    }
    // shoulder strip covering the top edge between asphalt and wall
    concreteGeos.push(ribbonGeometry(track, a, b, (s) => hwAt(s) + 1.2, (s) => -hwAt(s) - 1.2, () => -0.01, () => -0.01, 4, 10))
  }
  // guard rails along the whole elevated section
  const railGeos: THREE.BufferGeometry[] = []
  for (const side of [1, -1] as const) {
    railGeos.push(wallGeometry(track, cross.sOver - approach, cross.sOver + approach, (s) => side * (hwAt(s) + 1.1), () => 0, () => 1.0, 4))
  }
  group.add(new THREE.Mesh(mergeGeometries(railGeos, false)!, rail))
  // piers beside the lower track
  const pierGeo = new THREE.CylinderGeometry(1.4, 1.6, 1, 12)
  const hwUnder = hwAt(cross.sUnder)
  for (const lat of [hwUnder + 5, -hwUnder - 5]) {
    track.pointAt(cross.sUnder, lat, _p)
    const top = cross.yOver - 1.3
    const bottom = groundHeightAt(_p.x, _p.z) - 1
    const g = pierGeo.clone()
    g.scale(1, top - bottom, 1)
    g.translate(_p.x, (top + bottom) / 2, _p.z)
    concreteGeos.push(g)
  }

  // --- pit lane: between the pit wall and the garages, plus the entry / exit roads ----------
  const pitLat = (s: number) => track.pitLateralAt(s) ?? pit.laneOffset
  const halfLane = pit.laneWidth / 2
  const pitMat = pbr(asphaltMaps(false), {}, 0.7)
  const pitLane = new THREE.Mesh(ribbonGeometry(track, pit.entryS, pit.exitS, (s) => pitLat(s) + halfLane, (s) => pitLat(s) - halfLane, () => 0.01, () => 0.01, 3, 20, pit.laneWidth / 13), pitMat)
  pitLane.name = 'pitLane'
  pitLane.receiveShadow = true
  group.add(pitLane)
  groundGeos.push(pitLane.geometry)
  // concrete apron between the pit lane and the garages
  concreteGeos.push(ribbonGeometry(track, pit.limitStartS - 40, pit.limitEndS, () => pit.laneOffset - halfLane + 0.2, () => pit.garageFront + 0.4, () => 0.01, () => 0.01, 4, 4))
  // all painted white lines (pit limits, pit boxes, grid slots, start line) share one mesh
  const whiteGeos: THREE.BufferGeometry[] = []
  for (const s of [pit.limitStartS, pit.limitEndS]) {
    whiteGeos.push(ribbonGeometry(track, s, s + 0.6, (ss) => pitLat(ss) + halfLane, (ss) => pitLat(ss) - halfLane, () => 0.03, () => 0.03, 1, 1))
  }
  // fast lane / working lane divider
  whiteGeos.push(ribbonGeometry(track, pit.limitStartS, pit.limitEndS, () => pit.laneOffset + 1.1, () => pit.laneOffset + 0.9, () => 0.03, () => 0.03, 4, 1))
  // pit boxes (white outlines) — one per team, in the working lane in front of the garages
  for (let t = 0; t < 11; t++) {
    const s = track.wrap(pit.boxStartS + t * pit.boxSpacing)
    const lat = pit.laneOffset - 2.5
    whiteGeos.push(ribbonGeometry(track, s - 3.5, s + 3.5, () => lat + 2.2, () => lat + 1.9, () => 0.03, () => 0.03, 1, 1))
    whiteGeos.push(ribbonGeometry(track, s - 3.5, s + 3.5, () => lat - 1.9, () => lat - 2.2, () => 0.03, () => 0.03, 1, 1))
    whiteGeos.push(ribbonGeometry(track, s - 3.5, s - 3.2, () => lat + 2.2, () => lat - 2.2, () => 0.03, () => 0.03, 1, 1))
  }
  // pit wall between track and pit lane, with advertising boards facing the track
  const boardMat = new THREE.MeshStandardMaterial({ map: boardTexture(), roughness: 0.45, metalness: 0.1, side: THREE.DoubleSide })
  const boardGeos: THREE.BufferGeometry[] = []
  boardGeos.push(wallGeometry(track, pit.limitStartS - 40, pit.limitEndS, () => pit.wallOffset, () => STRIP_DROP, () => 1.2, 4, 64))
  concreteGeos.push(ribbonGeometry(track, pit.limitStartS - 40, pit.limitEndS, () => pit.wallOffset + 0.3, () => pit.wallOffset - 0.3, () => 1.2, () => 1.2, 4, 10))
  concreteGeos.push(wallGeometry(track, pit.limitStartS - 40, pit.limitEndS, () => pit.wallOffset - 0.3, () => STRIP_DROP, () => 1.2, 4, 4))
  // outside barrier along the main straight and into T1 (stands on the verge)
  boardGeos.push(wallGeometry(track, 5480, 470, () => hw + 8, (s) => ground.yAt(s, hw + 8), (s) => ground.yAt(s, hw + 8) + 1.1, 4, 64))
  group.add(new THREE.Mesh(mergeGeometries(boardGeos, false)!, boardMat))
  const concreteMesh = new THREE.Mesh(mergeGeometries(concreteGeos, false)!, concrete)
  concreteMesh.name = 'concrete'
  concreteMesh.castShadow = true
  group.add(concreteMesh)

  // --- grid slots + start line ----------------------------------------------------
  const gridMat = new THREE.MeshBasicMaterial({ color: 0xf4f4f4 })
  for (let k = 0; k < 22; k++) {
    const behind = 14 + 8 * k
    const s = track.wrap(-behind)
    const lat = k % 2 === 0 ? 2.6 : -2.6
    whiteGeos.push(ribbonGeometry(track, s - 2.6, s + 2.6, () => lat + 1.6, () => lat + 1.35, () => 0.03, () => 0.03, 1, 1))
    whiteGeos.push(ribbonGeometry(track, s - 2.6, s + 2.6, () => lat - 1.35, () => lat - 1.6, () => 0.03, () => 0.03, 1, 1))
    whiteGeos.push(ribbonGeometry(track, s + 2.4, s + 2.6, () => lat + 1.6, () => lat - 1.6, () => 0.03, () => 0.03, 1, 1))
  }
  whiteGeos.push(ribbonGeometry(track, L - 0.5, 0.5, hwAt, (s) => -hwAt(s), () => 0.03, () => 0.03, 1, 1))
  const whiteLines = new THREE.Mesh(mergeGeometries(whiteGeos, false)!, gridMat)
  whiteLines.name = 'whiteLines'
  group.add(whiteLines)
  // DRS detection / activation markings
  const drsMat = new THREE.MeshBasicMaterial({ color: 0xffd400 })
  group.add(new THREE.Mesh(mergeGeometries([
    ribbonGeometry(track, CIRCUIT.drs.detection, CIRCUIT.drs.detection + 0.4, hwAt, (s) => -hwAt(s), () => 0.03, () => 0.03, 1, 1),
    ribbonGeometry(track, CIRCUIT.drs.start, CIRCUIT.drs.start + 0.4, hwAt, (s) => -hwAt(s), () => 0.03, () => 0.03, 1, 1),
  ], false)!, drsMat))

  // --- start gantry with the five light clusters ------------------------------------
  const steel = new THREE.MeshStandardMaterial({ color: 0x3c3f46, roughness: 0.45, metalness: 0.8 })
  const gantry = new THREE.Group()
  const postGeo = new THREE.BoxGeometry(0.5, 9, 0.5)
  const beamGeo = new THREE.BoxGeometry(2 * hw + 6, 0.6, 0.6)
  const gs = 3
  const pose = track.headingAt(gs)
  track.pointAt(gs, 0, _p)
  gantry.position.copy(_p)
  gantry.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(pose.tz, 0, -pose.tx), new THREE.Vector3(0, 1, 0), new THREE.Vector3(pose.tx, 0, pose.tz)))
  for (const x of [hw + 2.5, -hw - 2.5]) {
    const post = new THREE.Mesh(postGeo, steel)
    post.position.set(x, 4.5, 0)
    post.castShadow = true
    gantry.add(post)
  }
  const beam = new THREE.Mesh(beamGeo, steel)
  beam.position.set(0, 8.7, 0)
  gantry.add(beam)
  const startLampMaterials: THREE.MeshStandardMaterial[] = []
  const lampGeo = new THREE.SphereGeometry(0.28, 10, 8)
  const housingGeo = new THREE.BoxGeometry(0.9, 1.7, 0.5)
  for (let i = 0; i < 5; i++) {
    const x = (i - 2) * 1.6
    const housing = new THREE.Mesh(housingGeo, new THREE.MeshStandardMaterial({ color: 0x111111 }))
    housing.position.set(x, 7.5, 0)
    gantry.add(housing)
    const mat = new THREE.MeshStandardMaterial({ color: 0x3a0000, emissive: 0x000000, roughness: 0.3 })
    startLampMaterials.push(mat)
    for (const y of [7.9, 7.1]) {
      const lamp = new THREE.Mesh(lampGeo, mat)
      lamp.position.set(x, y, -0.3)
      gantry.add(lamp)
    }
  }
  group.add(gantry)

  // the terrain grid is coarse: sink it wherever it would rise through any of the surfaces
  let total = 0
  for (const g of groundGeos) total += (g.attributes.position as THREE.BufferAttribute).count * 3
  const pts = new Float32Array(total)
  let at = 0
  for (const g of groundGeos) {
    const arr = (g.attributes.position as THREE.BufferAttribute).array as Float32Array
    pts.set(arr, at)
    at += arr.length
  }
  terrain.clampUnder(pts, RUNOFF_LIFT + 0.05)

  return { group, surface, startLampMaterials }
}

/**
 * Kerb cross-section on `side` (+1 left / -1 right) of the road edge: 0.3 m ramp from the
 * asphalt up to 5 cm, a slightly crowned top, and a 3 cm drop into the grass behind.
 */
function kerbProfile(track: Track, s0: number, s1: number, side: 1 | -1, width: number, hwAt: Fn): THREE.BufferGeometry {
  const at = (off: number): Fn => (s) => side * (hwAt(s) + off)
  const edges: [Fn, Fn][] = [
    [at(0), () => 0.0],
    [at(0.3), () => 0.05],
    [at(width * 0.55), () => 0.065],
    [at(width - 0.15), () => 0.05],
    [at(width), () => STRIP_DROP],
  ]
  // edges run right-to-left (increasing lateral): the right kerb is listed outside-in
  if (side < 0) edges.reverse()
  return profileRibbonGeometry(track, s0, s1, edges, 1, 2)
}

/**
 * Forward intervals of [from, to] that remain after removing [cutFrom, cutTo] (all on the
 * closed lap of length L).
 */
function subtractInterval(from: number, to: number, cutFrom: number, cutTo: number, L: number): [number, number][] {
  const len = forwardDelta(from, to, L)
  const cutLen = forwardDelta(cutFrom, cutTo, L)
  let c0 = forwardDelta(from, cutFrom, L)
  if (c0 > L / 2) c0 -= L
  const c1 = c0 + cutLen
  if (c1 <= 0 || c0 >= len) return [[from, to]]
  const out: [number, number][] = []
  if (c0 > 0) out.push([from, from + c0])
  if (c1 < len) out.push([from + c1, to])
  return out
}

function forwardDeltaSigned(s: number, ref: number, L: number): number {
  let d = (s - ref) % L
  if (d < 0) d += L
  if (d > L / 2) d -= L
  return d
}
